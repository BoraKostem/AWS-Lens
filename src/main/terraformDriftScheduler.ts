import path from 'node:path'

import { app, BrowserWindow, Notification } from 'electron'

import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'
import { getDriftProvider, resolveDriftProviderId } from './terraformDriftProvider'
import { logInfo, logWarn } from './observability'

import type {
  CloudProviderId,
  TerraformDriftSchedule,
  TerraformDriftScheduleInterval,
  TerraformDriftReport,
  TerraformDriftSnapshot
} from '@shared/types'

/* ---------------------------------------------------------------------------
 * Config persistence
 * -------------------------------------------------------------------------*/

const CONFIG_FILE_LABEL = 'Drift schedule'

function configPath(): string {
  return path.join(app.getPath('userData'), 'drift-schedule.json')
}

const DEFAULT_SCHEDULE: TerraformDriftSchedule = {
  enabled: false,
  interval: 'daily',
  providers: [],
  projectIds: [],
  lastRunAt: '',
  nextRunAt: ''
}

let scheduleCache: TerraformDriftSchedule | null = null

export function getDriftSchedule(): TerraformDriftSchedule {
  if (scheduleCache) return scheduleCache
  const parsed = readSecureJsonFile<TerraformDriftSchedule>(configPath(), {
    fallback: DEFAULT_SCHEDULE,
    fileLabel: CONFIG_FILE_LABEL
  })
  scheduleCache = sanitizeSchedule(parsed)
  return scheduleCache
}

export function updateDriftSchedule(update: Partial<TerraformDriftSchedule>): TerraformDriftSchedule {
  const current = getDriftSchedule()
  const next = sanitizeSchedule({ ...current, ...update })
  scheduleCache = null
  writeSecureJsonFile(configPath(), next, CONFIG_FILE_LABEL)
  scheduleCache = next

  // Restart timer if the schedule was toggled or interval changed
  if (next.enabled) {
    startDriftScheduler(getWindow)
  } else {
    stopDriftScheduler()
  }

  return next
}

function sanitizeSchedule(raw: Partial<TerraformDriftSchedule>): TerraformDriftSchedule {
  const validIntervals: TerraformDriftScheduleInterval[] = ['hourly', 'daily', 'weekly']
  const validProviders: CloudProviderId[] = ['aws', 'gcp', 'azure']
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
    interval: validIntervals.includes(raw.interval as TerraformDriftScheduleInterval)
      ? (raw.interval as TerraformDriftScheduleInterval)
      : 'daily',
    providers: Array.isArray(raw.providers)
      ? raw.providers.filter((p): p is CloudProviderId => validProviders.includes(p as CloudProviderId))
      : [],
    projectIds: Array.isArray(raw.projectIds) ? raw.projectIds.filter((s) => typeof s === 'string') : [],
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : '',
    nextRunAt: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : ''
  }
}

/* ---------------------------------------------------------------------------
 * Interval helpers
 * -------------------------------------------------------------------------*/

const INTERVAL_MS: Record<TerraformDriftScheduleInterval, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
}

function computeNextRunAt(interval: TerraformDriftScheduleInterval): string {
  return new Date(Date.now() + INTERVAL_MS[interval]).toISOString()
}

/* ---------------------------------------------------------------------------
 * Scheduler state
 * -------------------------------------------------------------------------*/

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let getWindow: () => BrowserWindow | null = () => null

/**
 * Boot the drift scheduler.  Should be called once during app startup from
 * `registerTerraformIpcHandlers` (or equivalent) so the scheduler has access
 * to the main BrowserWindow for IPC events.
 */
export function initDriftScheduler(windowAccessor: () => BrowserWindow | null): void {
  getWindow = windowAccessor
  const schedule = getDriftSchedule()
  if (schedule.enabled) {
    startDriftScheduler(windowAccessor)
  }
}

export function startDriftScheduler(windowAccessor: () => BrowserWindow | null): void {
  stopDriftScheduler()
  getWindow = windowAccessor
  const schedule = getDriftSchedule()
  if (!schedule.enabled || schedule.providers.length === 0 || schedule.projectIds.length === 0) return

  const intervalMs = INTERVAL_MS[schedule.interval]

  // Compute initial delay: honour nextRunAt if it's in the future
  let delayMs = intervalMs
  if (schedule.nextRunAt) {
    const diff = new Date(schedule.nextRunAt).getTime() - Date.now()
    if (diff > 0) delayMs = diff
  }

  logInfo('drift-scheduler.start', `Drift scheduler started (interval=${schedule.interval}, firstRunIn=${Math.round(delayMs / 1000)}s)`)

  // First tick
  schedulerTimer = setTimeout(() => {
    void runScheduledDriftCheck()
    // Subsequent ticks
    schedulerTimer = setInterval(() => void runScheduledDriftCheck(), intervalMs)
  }, delayMs) as unknown as ReturnType<typeof setInterval>
}

export function stopDriftScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer as unknown as ReturnType<typeof setTimeout>)
    clearInterval(schedulerTimer)
    schedulerTimer = null
    logInfo('drift-scheduler.stop', 'Drift scheduler stopped')
  }
}

/* ---------------------------------------------------------------------------
 * Scheduled drift check
 * -------------------------------------------------------------------------*/

/** Last completed report per provider+project, used for change detection */
const previousSnapshots = new Map<string, TerraformDriftSnapshot>()

function snapshotKey(providerId: CloudProviderId, projectId: string): string {
  return `${providerId}:${projectId}`
}

export async function runScheduledDriftCheck(): Promise<void> {
  const schedule = getDriftSchedule()
  logInfo('drift-scheduler.run', `Running scheduled drift check for ${schedule.providers.length} providers × ${schedule.projectIds.length} projects`)

  const results: Array<{ providerId: CloudProviderId; projectId: string; report: TerraformDriftReport }> = []

  for (const providerId of schedule.providers) {
    const provider = getDriftProvider(providerId)
    for (const projectId of schedule.projectIds) {
      try {
        const profileName = `provider:${providerId}:terraform:${projectId}`
        const report = await provider.getDriftReport(profileName, projectId, undefined, { forceRefresh: true })
        results.push({ providerId, projectId, report })
      } catch (err) {
        logWarn('drift-scheduler.provider-error', `Drift check failed for ${providerId}/${projectId}`, { providerId, projectId }, err)
      }
    }
  }

  // Persist timestamps
  const now = new Date().toISOString()
  updateDriftScheduleTimestamps(now, computeNextRunAt(schedule.interval))

  // Detect changes and notify
  for (const { providerId, projectId, report } of results) {
    const key = snapshotKey(providerId, projectId)
    const latest = report.history.snapshots[0]
    if (!latest) continue

    const previous = previousSnapshots.get(key)
    previousSnapshots.set(key, latest)

    if (previous && hasDriftChanged(previous, latest)) {
      emitDriftNotification(providerId, projectId, latest)
    } else if (!previous && driftedCount(latest) > 0) {
      // First scheduled run with existing drift
      emitDriftNotification(providerId, projectId, latest)
    }
  }

  logInfo('drift-scheduler.complete', `Scheduled drift check finished. ${results.length} reports collected.`)
}

/** Update only timestamp fields without restarting the scheduler */
function updateDriftScheduleTimestamps(lastRunAt: string, nextRunAt: string): void {
  const current = getDriftSchedule()
  scheduleCache = { ...current, lastRunAt, nextRunAt }
  writeSecureJsonFile(configPath(), scheduleCache, CONFIG_FILE_LABEL)
}

/* ---------------------------------------------------------------------------
 * Change detection
 * -------------------------------------------------------------------------*/

function driftedCount(snapshot: TerraformDriftSnapshot): number {
  const sc = snapshot.summary.statusCounts
  return (sc.drifted || 0) + (sc.missing_in_aws || 0) + (sc.missing_in_cloud || 0)
}

function missingCount(snapshot: TerraformDriftSnapshot): number {
  const sc = snapshot.summary.statusCounts
  return (sc.missing_in_aws || 0) + (sc.missing_in_cloud || 0)
}

function hasDriftChanged(previous: TerraformDriftSnapshot, latest: TerraformDriftSnapshot): boolean {
  if (driftedCount(previous) !== driftedCount(latest)) return true
  if (missingCount(previous) !== missingCount(latest)) return true
  if (previous.items.length !== latest.items.length) return true

  const prevAddresses = new Set(previous.items.map((i) => i.terraformAddress))
  const latestAddresses = new Set(latest.items.map((i) => i.terraformAddress))
  for (const addr of latestAddresses) {
    if (!prevAddresses.has(addr)) return true
  }
  return false
}

/* ---------------------------------------------------------------------------
 * Notifications
 * -------------------------------------------------------------------------*/

function emitDriftNotification(providerId: CloudProviderId, projectId: string, snapshot: TerraformDriftSnapshot): void {
  const issues = driftedCount(snapshot)
  if (issues === 0) return

  const providerLabel = providerId.toUpperCase()
  const title = `Terraform Drift Detected — ${providerLabel}`
  const body = `${issues} resource${issues === 1 ? '' : 's'} drifted in project "${projectId}"`

  // OS-level notification
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }

  // In-app IPC event
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('terraform:drift:notification', {
      providerId,
      projectId,
      snapshotId: snapshot.id,
      drifted: driftedCount(snapshot),
      missing: missingCount(snapshot),
      scannedAt: snapshot.scannedAt
    })
  }
}
