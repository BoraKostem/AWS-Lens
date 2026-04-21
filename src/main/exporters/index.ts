import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'
import type {
  EnterpriseAuditEvent,
  ExporterConfig,
  ExporterHealthSnapshot,
  TerraformDriftSnapshot,
  TerraformRunRecord
} from '@shared/types'

import { auditEventToDocument, driftSnapshotToDocument, runRecordToDocument } from './schema'
import {
  drainOldEntries,
  enqueue,
  getDroppedCount,
  markFailure,
  markSuccess,
  peekDue,
  purgeQueue,
  queueStats
} from './queue'
import {
  incAuditEvent,
  incDriftIssues,
  incQueueEnqueued,
  incTerraformRun,
  prometheusStatus,
  setEsSyncLatency,
  setLastRunDuration,
  setQueueGauges,
  startPrometheusServer,
  stopPrometheusServer
} from './prometheus'
import { bulkIndex, pingElasticsearch, queryTeamTimeline, type TeamTimelineFilter } from './elasticsearch'
import { randomUUID } from 'node:crypto'

// ─── Config persistence ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: ExporterConfig = {
  prometheus: {
    enabled: false,
    port: 9091,
    host: '127.0.0.1',
    metricsPath: '/metrics',
    teamLabel: '',
    projectLabel: ''
  },
  elasticsearch: {
    enabled: false,
    url: 'http://localhost:9200',
    indexPrefix: 'infralens',
    authKind: 'none',
    username: '',
    password: '',
    bearerToken: '',
    apiKey: '',
    tlsSkipVerify: false,
    teamLabel: '',
    projectLabel: ''
  },
  redactionMode: 'partial',
  retentionHours: 72,
  updatedAt: ''
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'exporter-config.json')
}

export function readExporterConfig(): ExporterConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8')
    const stored = JSON.parse(raw) as Partial<ExporterConfig>
    return {
      prometheus: { ...DEFAULT_CONFIG.prometheus, ...stored.prometheus },
      elasticsearch: { ...DEFAULT_CONFIG.elasticsearch, ...stored.elasticsearch },
      redactionMode: stored.redactionMode ?? DEFAULT_CONFIG.redactionMode,
      retentionHours: typeof stored.retentionHours === 'number' ? stored.retentionHours : DEFAULT_CONFIG.retentionHours,
      updatedAt: stored.updatedAt ?? ''
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeExporterConfig(config: ExporterConfig): ExporterConfig {
  const next: ExporterConfig = { ...config, updatedAt: new Date().toISOString() }
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

// ─── ES health tracking ───────────────────────────────────────────────────────

let esLastSuccessAt = ''
let esLastFailureAt = ''
let esLastError = ''

// ─── Flush loop ───────────────────────────────────────────────────────────────

let flushTimer: ReturnType<typeof setInterval> | null = null

function isFatalAuthError(message: string): boolean {
  return /HTTP 40[1-4]/.test(message) || /HTTP 403/.test(message)
}

async function flushQueue(): Promise<void> {
  const config = readExporterConfig()
  if (!config.elasticsearch.enabled) return

  const due = peekDue(100)
  if (!due.length) return

  const docs = due.map((e) => e.payload as ReturnType<typeof auditEventToDocument>)

  const start = Date.now()
  try {
    const result = await bulkIndex(config.elasticsearch, docs)
    setEsSyncLatency(Date.now() - start)
    esLastSuccessAt = new Date().toISOString()
    esLastError = result.errors
      ? `${result.errorCount} document(s) had errors in last batch`
      : ''

    for (const entry of due) {
      if (result.ok || !result.errors) {
        markSuccess(entry.id)
      } else {
        // Per-document errors here are surfaced but not fatal; retry with backoff.
        markFailure(entry.id, esLastError)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    esLastFailureAt = new Date().toISOString()
    esLastError = msg
    const fatal = isFatalAuthError(msg)
    for (const entry of due) {
      markFailure(entry.id, msg, fatal)
    }
  }

  // Update gauge snapshot for Prometheus
  const stats = queueStats()
  setQueueGauges(stats.pending, stats.retrying, stats.dropped)
}

export function startExporterFlushLoop(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => {
    const config = readExporterConfig()
    // Drain retention regardless of ES being enabled so stale data from a
    // previously-enabled exporter does not accumulate forever.
    drainOldEntries(config.retentionHours)
    flushQueue().catch(() => { /* never propagate */ })
  }, 30_000)
}

export function stopExporterFlushLoop(): void {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function applyExporterConfig(config: ExporterConfig): Promise<void> {
  const saved = writeExporterConfig(config)

  if (saved.prometheus.enabled) {
    await startPrometheusServer(saved.prometheus)
  } else {
    await stopPrometheusServer()
  }

  if (!flushTimer) {
    startExporterFlushLoop()
  }
}

export async function initExporters(): Promise<void> {
  const config = readExporterConfig()

  if (config.prometheus.enabled) {
    await startPrometheusServer(config.prometheus).catch(() => { /* logged via prometheusStatus */ })
  }

  startExporterFlushLoop()
}

export function shutdownExporters(): Promise<void> {
  stopExporterFlushLoop()
  return stopPrometheusServer()
}

// ─── Public event hooks ───────────────────────────────────────────────────────

export function exportAuditEvent(event: EnterpriseAuditEvent): void {
  // Defer to the next tick so we never block the audit write chain or IPC handlers.
  setImmediate(() => {
    try {
      const config = readExporterConfig()
      if (!config.elasticsearch.enabled && !config.prometheus.enabled) return

      if (config.prometheus.enabled) {
        incAuditEvent(
          event.outcome,
          event.serviceId || 'unknown',
          config.elasticsearch.teamLabel || config.prometheus.teamLabel
        )
      }

      if (config.elasticsearch.enabled) {
        const doc = auditEventToDocument(
          event,
          config.redactionMode,
          config.elasticsearch.teamLabel,
          config.elasticsearch.projectLabel
        )
        enqueue('audit', doc)
        incQueueEnqueued()
      }
    } catch { /* exporter errors never affect the calling path */ }
  })
}

export function exportRunRecord(record: TerraformRunRecord): void {
  setImmediate(() => {
    try {
      const config = readExporterConfig()
      if (!config.elasticsearch.enabled && !config.prometheus.enabled) return

      if (config.prometheus.enabled && record.finishedAt) {
        // Only count finalized runs so a single run doesn't increment the counter twice.
        incTerraformRun(
          record.command,
          record.provider ?? 'local',
          record.success ?? false,
          config.prometheus.teamLabel
        )
        if (typeof record.durationMs === 'number') {
          setLastRunDuration(record.durationMs)
        }
      }

      if (config.elasticsearch.enabled) {
        const doc = runRecordToDocument(
          record,
          config.redactionMode,
          config.elasticsearch.teamLabel,
          config.elasticsearch.projectLabel
        )
        // Idempotent on run id — repeat exports (start + finish) update the same ES document.
        enqueue('terraform-run', doc)
        incQueueEnqueued()
      }
    } catch { /* exporter errors never affect the calling path */ }
  })
}

// ─── Health / status ──────────────────────────────────────────────────────────

export function getExporterHealth(): ExporterHealthSnapshot {
  const stats = queueStats()
  const prom = prometheusStatus()
  const config = readExporterConfig()

  return {
    prometheus: {
      running: prom.running,
      port: prom.port,
      lastError: prom.lastError
    },
    elasticsearch: {
      enabled: config.elasticsearch.enabled,
      lastSuccessAt: esLastSuccessAt,
      lastFailureAt: esLastFailureAt,
      lastError: esLastError,
      queuedItems: stats.pending + stats.retrying,
      droppedItems: getDroppedCount()
    },
    queue: {
      pending: stats.pending,
      retrying: stats.retrying,
      dropped: stats.dropped
    }
  }
}

export function exportDriftSnapshot(
  projectId: string,
  projectName: string,
  snapshot: TerraformDriftSnapshot
): void {
  setImmediate(() => {
    try {
      const config = readExporterConfig()
      if (!config.elasticsearch.enabled && !config.prometheus.enabled) return

      const driftedCount = snapshot.items.filter(
        (item) => (item as { status?: string }).status === 'drifted'
      ).length

      if (config.prometheus.enabled && driftedCount > 0) {
        incDriftIssues(projectId, driftedCount, config.prometheus.teamLabel)
      }

      if (config.elasticsearch.enabled) {
        const doc = driftSnapshotToDocument(
          projectId,
          projectName,
          snapshot,
          config.redactionMode,
          config.elasticsearch.teamLabel,
          config.elasticsearch.projectLabel
        )
        enqueue('drift-snapshot', doc)
        incQueueEnqueued()
      }
    } catch { /* exporter errors never affect the calling path */ }
  })
}

export function sendTestEvent(): void {
  const config = readExporterConfig()
  if (!config.elasticsearch.enabled) return

  const doc = {
    _id: `test-${randomUUID()}`,
    _kind: 'audit' as const,
    _schemaVersion: 1 as const,
    timestamp: new Date().toISOString(),
    kind: 'audit' as const,
    outcome: 'success' as const,
    accessMode: 'read-only' as const,
    action: 'Exporter test event',
    channel: 'exporters:test',
    summary: 'Synthetic event generated by the Exporters settings panel.',
    actorLabel: 'local-app',
    accountId: '',
    region: '',
    serviceId: '',
    resourceId: '',
    details: ['source:test'],
    teamLabel: config.elasticsearch.teamLabel,
    projectLabel: config.elasticsearch.projectLabel
  }
  enqueue('audit', doc)
  incQueueEnqueued()
}

export async function queryTeamTimelineWrapper(filter: TeamTimelineFilter): Promise<{ ok: boolean; hits: unknown[]; error: string }> {
  const config = readExporterConfig()
  if (!config.elasticsearch.enabled) {
    return { ok: false, hits: [], error: 'Elasticsearch exporter is disabled.' }
  }
  return queryTeamTimeline(config.elasticsearch, filter)
}

export { purgeQueue, pingElasticsearch, readExporterConfig as getExporterConfig }
