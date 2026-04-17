/**
 * Security snapshots store — persists daily security posture snapshots
 * and configurable thresholds for trend analysis and alerting.
 */

import path from 'node:path'

import { app } from 'electron'

import type {
  SecurityAlert,
  SecurityAlertKind,
  SecurityScoreDomain,
  SecuritySnapshot,
  SecuritySnapshotInput,
  SecurityThresholds,
  SecurityTrendRange,
  SecurityTrendReport
} from '@shared/types'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

const MAX_SNAPSHOTS_PER_SCOPE = 400  // ~1 year + buffer

const DEFAULT_THRESHOLDS: SecurityThresholds = {
  minOverallScore: 70,
  maxHighFindings: 5,
  maxTotalFindings: 50,
  scoreDropPct: 10
}

type SecuritySnapshotsState = {
  snapshots: SecuritySnapshot[]
  thresholds: SecurityThresholds
}

const DEFAULT_STATE: SecuritySnapshotsState = {
  snapshots: [],
  thresholds: DEFAULT_THRESHOLDS
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'security-snapshots.json')
}

/* ── Sanitization ─────────────────────────────────────────── */

function sanitizeDomainScores(raw: unknown): Record<SecurityScoreDomain, number> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const domains: SecurityScoreDomain[] = ['iam', 'network', 'encryption', 'logging', 'compliance']
  const result: Record<SecurityScoreDomain, number> = {
    iam: 0, network: 0, encryption: 0, logging: 0, compliance: 0
  }
  for (const d of domains) {
    const value = Number(input[d])
    result[d] = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0
  }
  return result
}

function sanitizeFindingCounts(raw: unknown): SecuritySnapshot['findingCounts'] {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const high = Math.max(0, Math.round(Number(input.high) || 0))
  const medium = Math.max(0, Math.round(Number(input.medium) || 0))
  const low = Math.max(0, Math.round(Number(input.low) || 0))
  const total = Math.max(0, Math.round(Number(input.total) || high + medium + low))
  return { high, medium, low, total }
}

function sanitizeSnapshot(raw: unknown): SecuritySnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>

  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const capturedAt = typeof input.capturedAt === 'string' ? input.capturedAt.trim() : ''
  const scope = typeof input.scope === 'string' ? input.scope.trim() : ''
  if (!id || !capturedAt || !scope) return null

  const overallScore = Number(input.overallScore)
  const passRate = Number(input.complianceBenchmarkPassRate)

  return {
    id,
    capturedAt,
    scope,
    scopeLabel: typeof input.scopeLabel === 'string' ? input.scopeLabel : scope,
    overallScore: Number.isFinite(overallScore) ? Math.max(0, Math.min(100, Math.round(overallScore))) : 0,
    domainScores: sanitizeDomainScores(input.domainScores),
    findingCounts: sanitizeFindingCounts(input.findingCounts),
    complianceBenchmarkPassRate: Number.isFinite(passRate) ? Math.max(0, Math.min(100, Math.round(passRate))) : 0,
    newFindings: Math.max(0, Math.round(Number(input.newFindings) || 0)),
    remediatedFindings: Math.max(0, Math.round(Number(input.remediatedFindings) || 0))
  }
}

function sanitizeThresholds(raw: unknown): SecurityThresholds {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, Math.round(n)))
  }
  return {
    minOverallScore: clamp(input.minOverallScore, 0, 100, DEFAULT_THRESHOLDS.minOverallScore),
    maxHighFindings: clamp(input.maxHighFindings, 0, 10000, DEFAULT_THRESHOLDS.maxHighFindings),
    maxTotalFindings: clamp(input.maxTotalFindings, 0, 100000, DEFAULT_THRESHOLDS.maxTotalFindings),
    scoreDropPct: clamp(input.scoreDropPct, 0, 100, DEFAULT_THRESHOLDS.scoreDropPct)
  }
}

function sanitizeState(raw: unknown): SecuritySnapshotsState {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawSnapshots = Array.isArray(input.snapshots) ? input.snapshots : []
  const snapshots = rawSnapshots
    .map(sanitizeSnapshot)
    .filter((s): s is SecuritySnapshot => s !== null)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  return {
    snapshots,
    thresholds: sanitizeThresholds(input.thresholds)
  }
}

/* ── Read / Write ─────────────────────────────────────────── */

function readState(): SecuritySnapshotsState {
  return sanitizeState(
    readSecureJsonFile<SecuritySnapshotsState>(storePath(), {
      fallback: DEFAULT_STATE,
      fileLabel: 'Security snapshots'
    })
  )
}

function writeState(state: SecuritySnapshotsState): SecuritySnapshotsState {
  const sanitized = sanitizeState(state)
  writeSecureJsonFile(storePath(), sanitized, 'Security snapshots')
  return sanitized
}

/* ── Range helpers ────────────────────────────────────────── */

function daysInRange(range: SecurityTrendRange): number {
  switch (range) {
    case '7d': return 7
    case '30d': return 30
    case '90d': return 90
    case '1y': return 365
    default: return 30
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

/* ── Public API ───────────────────────────────────────────── */

export function recordSecuritySnapshot(input: SecuritySnapshotInput): SecuritySnapshot {
  const state = readState()
  const today = todayIso()

  // If a snapshot for today + scope already exists, overwrite it
  const existingIndex = state.snapshots.findIndex(
    (s) => s.capturedAt === today && s.scope === input.scope
  )

  const snapshot: SecuritySnapshot = {
    id: existingIndex >= 0
      ? state.snapshots[existingIndex].id
      : `snap-${today}-${input.scope.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now().toString(36)}`,
    capturedAt: today,
    scope: input.scope,
    scopeLabel: input.scopeLabel,
    overallScore: input.overallScore,
    domainScores: input.domainScores,
    findingCounts: input.findingCounts,
    complianceBenchmarkPassRate: input.complianceBenchmarkPassRate,
    newFindings: input.newFindings,
    remediatedFindings: input.remediatedFindings
  }

  if (existingIndex >= 0) {
    state.snapshots[existingIndex] = snapshot
  } else {
    state.snapshots.push(snapshot)
  }

  // Trim per-scope to MAX_SNAPSHOTS_PER_SCOPE
  const byScope = new Map<string, SecuritySnapshot[]>()
  for (const s of state.snapshots) {
    const list = byScope.get(s.scope) ?? []
    list.push(s)
    byScope.set(s.scope, list)
  }
  const trimmed: SecuritySnapshot[] = []
  for (const list of byScope.values()) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    const kept = list.slice(-MAX_SNAPSHOTS_PER_SCOPE)
    trimmed.push(...kept)
  }
  state.snapshots = trimmed.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  const saved = writeState(state)
  return saved.snapshots.find((s) => s.id === snapshot.id) ?? snapshot
}

export function listSecuritySnapshots(scope: string, range: SecurityTrendRange): SecuritySnapshot[] {
  const state = readState()
  const cutoff = isoDaysAgo(daysInRange(range))
  return state.snapshots
    .filter((s) => s.scope === scope && s.capturedAt >= cutoff)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
}

export function getSecurityThresholds(): SecurityThresholds {
  return readState().thresholds
}

export function updateSecurityThresholds(update: Partial<SecurityThresholds>): SecurityThresholds {
  const state = readState()
  state.thresholds = sanitizeThresholds({ ...state.thresholds, ...update })
  const saved = writeState(state)
  return saved.thresholds
}

/* ── Trend report & alert evaluation ──────────────────────── */

function evaluateAlerts(
  snapshots: SecuritySnapshot[],
  thresholds: SecurityThresholds,
  scope: string,
  scopeLabel: string
): SecurityAlert[] {
  if (snapshots.length === 0) return []
  const latest = snapshots[snapshots.length - 1]
  const alerts: SecurityAlert[] = []
  const now = new Date().toISOString()

  const addAlert = (kind: SecurityAlertKind, severity: SecurityAlert['severity'], message: string, detail: string) => {
    alerts.push({
      id: `${scope}:${kind}:${latest.capturedAt}`,
      kind,
      severity,
      message,
      detail,
      triggeredAt: now,
      scope,
      scopeLabel
    })
  }

  // Below min score
  if (latest.overallScore < thresholds.minOverallScore) {
    addAlert(
      'threshold-breach',
      'high',
      `Security score below threshold`,
      `Current score ${latest.overallScore} is below the configured minimum of ${thresholds.minOverallScore}.`
    )
  }

  // High findings over threshold
  if (latest.findingCounts.high > thresholds.maxHighFindings) {
    addAlert(
      'high-findings',
      'high',
      `High-severity findings exceed threshold`,
      `${latest.findingCounts.high} high-severity findings; threshold is ${thresholds.maxHighFindings}.`
    )
  }

  // Total findings over threshold
  if (latest.findingCounts.total > thresholds.maxTotalFindings) {
    addAlert(
      'total-findings',
      'medium',
      `Total findings exceed threshold`,
      `${latest.findingCounts.total} total findings; threshold is ${thresholds.maxTotalFindings}.`
    )
  }

  // Score drop over 7 days
  if (snapshots.length >= 2) {
    const sevenDaysAgoCutoff = isoDaysAgo(7)
    const olderCandidates = snapshots.filter((s) => s.capturedAt <= sevenDaysAgoCutoff)
    const older = olderCandidates[olderCandidates.length - 1] ?? snapshots[0]
    if (older && older.overallScore > 0) {
      const dropPct = ((older.overallScore - latest.overallScore) / older.overallScore) * 100
      if (dropPct >= thresholds.scoreDropPct) {
        addAlert(
          'score-drop',
          dropPct >= 20 ? 'high' : 'medium',
          `Security score dropped ${dropPct.toFixed(1)}%`,
          `Score dropped from ${older.overallScore} on ${older.capturedAt} to ${latest.overallScore} today (threshold: ${thresholds.scoreDropPct}%).`
        )
      }
    }
  }

  return alerts
}

export function buildSecurityTrendReport(scope: string, range: SecurityTrendRange): SecurityTrendReport {
  const state = readState()
  const snapshots = listSecuritySnapshots(scope, range)
  const scopeLabel = snapshots[0]?.scopeLabel ?? scope

  const alerts = evaluateAlerts(snapshots, state.thresholds, scope, scopeLabel)

  const currentScore = snapshots[snapshots.length - 1]?.overallScore ?? 0
  const previousScore = snapshots.length >= 2 ? snapshots[snapshots.length - 2].overallScore : currentScore
  const scoreDelta = currentScore - previousScore
  const trendDirection: 'up' | 'down' | 'stable' =
    scoreDelta > 1 ? 'up' : scoreDelta < -1 ? 'down' : 'stable'

  return {
    range,
    scope,
    snapshots,
    alerts,
    thresholds: state.thresholds,
    summary: {
      currentScore,
      previousScore,
      scoreDelta,
      trendDirection,
      snapshotCount: snapshots.length
    }
  }
}

export function listAllSecurityScopes(): Array<{ scope: string; scopeLabel: string; snapshotCount: number }> {
  const state = readState()
  const map = new Map<string, { scope: string; scopeLabel: string; snapshotCount: number }>()
  for (const s of state.snapshots) {
    const existing = map.get(s.scope)
    if (existing) {
      existing.snapshotCount += 1
      existing.scopeLabel = s.scopeLabel || existing.scopeLabel
    } else {
      map.set(s.scope, { scope: s.scope, scopeLabel: s.scopeLabel, snapshotCount: 1 })
    }
  }
  return Array.from(map.values()).sort((a, b) => a.scopeLabel.localeCompare(b.scopeLabel))
}
