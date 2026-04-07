import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type {
  AwsConnection,
  CloudTrailEventSummary,
  CloudWatchInvestigationHistoryEntry,
  CloudWatchQueryHistoryEntry,
  EnterpriseAuditEvent,
  ServiceId,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformProject,
  TerraformRunRecord
} from '@shared/types'

import { listCloudWatchInvestigationHistory, listCloudWatchQueryHistory, listEnterpriseAuditEvents, lookupCloudTrailEvents } from './api'
import './incident-workbench.css'
import { SvcState } from './SvcState'
import { getDrift, getProject, getSelectedProjectId, listRunHistory } from './terraformApi'

type TimelineWindowMode = '30m' | '1h' | 'custom'
type TimelineSource = 'terraform' | 'cloudtrail' | 'cloudwatch' | 'drift'
type TimelineTone = 'info' | 'success' | 'warning' | 'danger'
type IncidentTimelineScope = 'terraform' | 'overview'
type IncidentViewMode = 'grouped' | 'signals'

type TimelineWindow = {
  startIso: string
  endIso: string
  label: string
}

type TimelineItem = {
  id: string
  source: TimelineSource
  tone: TimelineTone
  occurredAt: string
  title: string
  summary: string
  detail: string
  resourceName?: string
  logGroupNames?: string[]
  serviceHint?: ServiceId | ''
  terminalCommand?: string
  terraformRunId?: string
  terraformDriftKey?: string
}

type TimelineSourceFilter = 'all' | TimelineSource
type TimelineToneFilter = 'all' | TimelineTone
type CorrelationConfidence = 'low' | 'medium' | 'high'

type CorrelationCluster = {
  id: string
  title: string
  summary: string
  tone: TimelineTone
  confidence: CorrelationConfidence
  items: TimelineItem[]
  sources: TimelineSource[]
  timeRangeLabel: string
}

type AssumeRoleUsage = {
  roleLabel: string
  count: number
  lastSeen: string
  actorLabels: string[]
  concentration: 'normal' | 'elevated' | 'unexpected'
}

type RiskyActionEntry = {
  id: string
  title: string
  summary: string
  detail: string
  occurredAt: string
  tone: TimelineTone
  serviceId: ServiceId | ''
  resourceId: string
}

type AssumeRoleSummary = {
  total: number
  roles: AssumeRoleUsage[]
}

type TerraformGuardrailSummary = {
  actionableCount: number
  driftedCount: number
  missingCount: number
  unmanagedCount: number
  topTypes: Array<{ resourceType: string; count: number }>
  remediationItems: TerraformDriftItem[]
  latestScanLabel: string
}

function formatIsoDate(value: string): string {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

function toLocalInputValue(date: Date): string {
  const adjusted = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000))
  return adjusted.toISOString().slice(0, 16)
}

function parseLocalInputValue(value: string): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function resolveWindow(mode: TimelineWindowMode, customStart: string, customEnd: string): TimelineWindow {
  const now = new Date()
  if (mode === '30m') {
    const start = new Date(now.getTime() - (30 * 60_000))
    return {
      startIso: start.toISOString(),
      endIso: now.toISOString(),
      label: 'Last 30 minutes'
    }
  }

  if (mode === '1h') {
    const start = new Date(now.getTime() - (60 * 60_000))
    return {
      startIso: start.toISOString(),
      endIso: now.toISOString(),
      label: 'Last 1 hour'
    }
  }

  const parsedStart = parseLocalInputValue(customStart) ?? new Date(now.getTime() - (30 * 60_000))
  const parsedEnd = parseLocalInputValue(customEnd) ?? now
  const safeStart = parsedStart.getTime() <= parsedEnd.getTime() ? parsedStart : parsedEnd
  const safeEnd = parsedEnd.getTime() >= parsedStart.getTime() ? parsedEnd : parsedStart

  return {
    startIso: safeStart.toISOString(),
    endIso: safeEnd.toISOString(),
    label: `${formatIsoDate(safeStart.toISOString())} to ${formatIsoDate(safeEnd.toISOString())}`
  }
}

function isWithinWindow(value: string, window: TimelineWindow): boolean {
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return false
  return timestamp >= new Date(window.startIso).getTime() && timestamp <= new Date(window.endIso).getTime()
}

function classifyCloudTrailTone(event: CloudTrailEventSummary): TimelineTone {
  const normalized = `${event.eventSource}:${event.eventName}`.toLowerCase()
  if (/delete|detach|remove|destroy|terminate|revoke/.test(normalized)) return 'danger'
  if (/assumerole|attach|put|update|create|passrole|set/.test(normalized)) return 'warning'
  return 'info'
}

function summarizeTerraformRun(record: TerraformRunRecord): { tone: TimelineTone; summary: string } {
  if (record.success === null) {
    return {
      tone: 'info',
      summary: `${record.command} is still running in workspace ${record.workspace}.`
    }
  }

  if (!record.success) {
    return {
      tone: 'danger',
      summary: `${record.command} failed in workspace ${record.workspace}.`
    }
  }

  if (record.command === 'plan' && record.planSummary?.hasDestructiveChanges) {
    return {
      tone: 'warning',
      summary: `plan succeeded with destructive changes in workspace ${record.workspace}.`
    }
  }

  if (record.command === 'apply' || record.command === 'destroy' || record.command === 'import') {
    return {
      tone: 'warning',
      summary: `${record.command} completed successfully in workspace ${record.workspace}.`
    }
  }

  return {
    tone: 'success',
    summary: `${record.command} completed successfully in workspace ${record.workspace}.`
  }
}

function buildTerraformTerminalCommand(record: TerraformRunRecord, project: TerraformProject | null): string {
  const args = [record.command, ...record.args].join(' ').trim()
  if (!args) return ''
  if (!project?.rootPath) return `terraform ${args}`.trim()
  return `cd "${project.rootPath}" && terraform ${args}`.trim()
}

function driftItemKey(item: TerraformDriftItem): string {
  return `${item.terraformAddress}|${item.resourceType}|${item.cloudIdentifier}|${item.logicalName}|${item.status}`
}

function serviceIdFromCloudTrailEvent(event: CloudTrailEventSummary): ServiceId | '' {
  const source = event.eventSource.toLowerCase()
  if (source === 'iam.amazonaws.com') return 'iam'
  if (source === 'ec2.amazonaws.com') return 'ec2'
  if (source === 'lambda.amazonaws.com') return 'lambda'
  if (source === 'ecs.amazonaws.com') return 'ecs'
  if (source === 'eks.amazonaws.com') return 'eks'
  if (source === 'rds.amazonaws.com') return 'rds'
  if (source === 'elasticloadbalancing.amazonaws.com') return 'load-balancers'
  if (source === 'route53.amazonaws.com') return 'route53'
  if (source === 'cloudformation.amazonaws.com') return 'cloudformation'
  if (source === 's3.amazonaws.com') return 's3'
  if (source === 'sqs.amazonaws.com') return 'sqs'
  if (source === 'sns.amazonaws.com') return 'sns'
  if (source === 'kms.amazonaws.com') return 'kms'
  if (source === 'secretsmanager.amazonaws.com') return 'secrets-manager'
  if (source === 'wafv2.amazonaws.com' || source === 'waf.amazonaws.com') return 'waf'
  if (source === 'logs.amazonaws.com' || source === 'cloudwatch.amazonaws.com') return 'cloudwatch'
  if (source === 'sts.amazonaws.com') return 'session-hub'
  return ''
}

function buildTerraformTimelineItems(records: TerraformRunRecord[], window: TimelineWindow, project: TerraformProject | null): TimelineItem[] {
  return records
    .filter((record) => isWithinWindow(record.finishedAt || record.startedAt, window))
    .map((record) => {
      const outcome = summarizeTerraformRun(record)
      const planSummary = record.planSummary
        ? `${record.planSummary.create} create, ${record.planSummary.update} update, ${record.planSummary.delete} delete, ${record.planSummary.replace} replace`
        : record.stateOperationSummary || 'No structured plan summary captured.'

      return {
        id: `terraform:${record.id}`,
        source: 'terraform',
        tone: outcome.tone,
        occurredAt: record.finishedAt || record.startedAt,
        serviceHint: 'terraform',
        terminalCommand: buildTerraformTerminalCommand(record, project),
        terraformRunId: record.id,
        title: `${record.command.toUpperCase()} • ${record.projectName}`,
        summary: outcome.summary,
        detail: `${planSummary} Region: ${record.region || '-'} • Connection: ${record.connectionLabel || '-'}`
      }
    })
}

function buildCloudTrailTimelineItems(events: CloudTrailEventSummary[]): TimelineItem[] {
  return events
    .filter((event) => !event.readOnly)
    .map((event) => ({
      id: `cloudtrail:${event.eventId}`,
      source: 'cloudtrail',
      tone: classifyCloudTrailTone(event),
      occurredAt: event.eventTime,
      title: `${event.eventName} • ${event.eventSource}`,
      summary: `${event.username || 'Unknown actor'} from ${event.sourceIpAddress || 'unknown IP'} touched ${event.resourceName || event.resourceType || 'an AWS resource'}.`,
      detail: `Region: ${event.awsRegion || '-'} • Resource type: ${event.resourceType || '-'} • Read only: ${event.readOnly ? 'Yes' : 'No'}`,
      serviceHint: serviceIdFromCloudTrailEvent(event),
      resourceName: event.resourceName || undefined
    }))
}

function buildCloudTrailFocusFilter(item: TimelineItem): string {
  const candidates = [
    item.title.split(' • ')[0],
    item.resourceName,
    item.serviceHint
  ].filter(Boolean)
  return candidates.join(' ')
}

function buildCloudWatchTimelineItems(entries: CloudWatchInvestigationHistoryEntry[], window: TimelineWindow): TimelineItem[] {
  return entries
    .filter((entry) => isWithinWindow(entry.occurredAt, window))
    .map((entry) => ({
      id: `cloudwatch:${entry.id}`,
      source: 'cloudwatch',
      tone: entry.severity === 'error' ? 'danger' : entry.severity === 'warning' ? 'warning' : entry.severity === 'success' ? 'success' : 'info',
      occurredAt: entry.occurredAt,
      title: `${entry.kind.replace(/-/g, ' ')} • CloudWatch`,
      summary: entry.title,
      detail: `${entry.detail}${entry.logGroupNames.length > 0 ? ` • Log groups: ${entry.logGroupNames.join(', ')}` : ''}`,
      logGroupNames: entry.logGroupNames,
      serviceHint: entry.serviceHint
    }))
}

function buildCloudWatchQueryTimelineItems(entries: CloudWatchQueryHistoryEntry[], window: TimelineWindow): TimelineItem[] {
  return entries
    .filter((entry) => isWithinWindow(entry.executedAt, window))
    .map((entry) => ({
      id: `cloudwatch-query:${entry.id}`,
      source: 'cloudwatch',
      tone: entry.status === 'failed' ? 'danger' : 'info',
      occurredAt: entry.executedAt,
      title: `Query run • ${entry.serviceHint || 'cloudwatch'}`,
      summary: entry.resultSummary || (entry.status === 'failed' ? 'CloudWatch query failed.' : 'CloudWatch query completed.'),
      detail: `${entry.queryString.split('\n')[0] || 'Query'}${entry.logGroupNames.length > 0 ? ` • Log groups: ${entry.logGroupNames.join(', ')}` : ''}`,
      logGroupNames: entry.logGroupNames,
      serviceHint: entry.serviceHint
    }))
}

function buildDriftTimelineItems(report: TerraformDriftReport | null, window: TimelineWindow): TimelineItem[] {
  if (!report?.history.snapshots.length) return []
  const latest = report.history.snapshots[0]
  if (!isWithinWindow(latest.scannedAt, window)) return []
  const topActionableItem = report.items.find((item) => item.status !== 'in_sync' && item.status !== 'unsupported')

  const actionableCount = latest.summary.statusCounts.drifted
    + latest.summary.statusCounts.missing_in_aws
    + latest.summary.statusCounts.unmanaged_in_aws

  return [{
    id: `drift:${latest.id}`,
    source: 'drift',
    tone: actionableCount > 0 ? 'warning' : 'success',
    occurredAt: latest.scannedAt,
    serviceHint: 'terraform',
    terminalCommand: topActionableItem?.terminalCommand,
    terraformDriftKey: topActionableItem ? driftItemKey(topActionableItem) : undefined,
    title: 'Drift snapshot updated',
    summary: actionableCount > 0
      ? `${actionableCount} actionable drift signals are visible in the latest snapshot.`
      : 'Latest drift snapshot is currently clean.',
    detail: `${latest.summary.statusCounts.drifted} drifted • ${latest.summary.statusCounts.missing_in_aws} missing • ${latest.summary.statusCounts.unmanaged_in_aws} unmanaged • ${latest.summary.statusCounts.in_sync} in sync`
  }]
}

function sourceLabel(source: TimelineSource): string {
  if (source === 'cloudtrail') return 'CloudTrail'
  if (source === 'cloudwatch') return 'CloudWatch'
  if (source === 'drift') return 'Drift'
  return 'Terraform'
}

function headlineForWindow(mode: TimelineWindowMode): string {
  if (mode === '1h') return 'What changed in the last 1 hour?'
  if (mode === 'custom') return 'What changed in this time window?'
  return 'What changed in the last 30 minutes?'
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9:/._-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function clusterLabel(item: TimelineItem): string {
  if (item.resourceName && item.resourceName !== '-') return item.resourceName
  if (item.serviceHint) return item.serviceHint
  if (/assumerole/i.test(item.title)) return 'AssumeRole'
  if (/iam\.amazonaws\.com/i.test(item.title) || /\biam\b/i.test(item.detail)) return 'IAM'
  return item.title.split(' • ')[0]
}

function toneWeight(tone: TimelineTone): number {
  if (tone === 'danger') return 4
  if (tone === 'warning') return 3
  if (tone === 'success') return 2
  return 1
}

function deriveClusterTone(items: TimelineItem[]): TimelineTone {
  return [...items]
    .sort((left, right) => toneWeight(right.tone) - toneWeight(left.tone))[0]?.tone ?? 'info'
}

function deriveConfidence(items: TimelineItem[], sources: TimelineSource[]): CorrelationConfidence {
  const hasRuntime = items.some((item) => item.source === 'cloudwatch')
  const hasControlPlane = items.some((item) => item.source === 'cloudtrail' || item.source === 'terraform' || item.source === 'drift')
  if (sources.length >= 3 || (hasRuntime && hasControlPlane && items.length >= 3)) return 'high'
  if (sources.length >= 2 || items.length >= 4) return 'medium'
  return 'low'
}

function buildCorrelationTitle(items: TimelineItem[], label: string): string {
  const eventHeads = [...new Set(items.map((item) => item.title.split(' • ')[0]))]
  const hasAssumeRole = items.some((item) => /assumerole/i.test(item.title))
  if (hasAssumeRole) return 'AssumeRole activity'
  const hasIam = items.some((item) => /iam\.amazonaws\.com/i.test(item.title) || /\biam\b/i.test(item.detail))
  if (hasIam) return 'IAM change activity'
  if (eventHeads.length === 1) return `${eventHeads[0]} activity`
  if (label && label !== '-') return `${label} activity`
  return 'Recent grouped signals'
}

function buildCorrelationSummary(items: TimelineItem[], sources: TimelineSource[]): string {
  const sourceSummary = sources.map((source) => sourceLabel(source)).join(', ')
  const windowStart = formatIsoDate(items[items.length - 1]?.occurredAt || '')
  const windowEnd = formatIsoDate(items[0]?.occurredAt || '')
  const eventHeads = [...new Set(items.map((item) => item.title.split(' • ')[0]))]

  if (sources.length === 1 && eventHeads.length === 1) {
    return `${items.length} repeated ${sourceSummary} signals in the same window. ${windowStart} to ${windowEnd}.`
  }

  return `${items.length} signals across ${sourceSummary}. Window: ${windowStart} to ${windowEnd}.`
}

function buildCorrelationClusters(items: TimelineItem[]): CorrelationCluster[] {
  const grouped = new Map<string, TimelineItem[]>()

  for (const item of items) {
    const timestamp = new Date(item.occurredAt).getTime()
    if (Number.isNaN(timestamp)) continue
    const bucket = Math.floor(timestamp / (15 * 60_000))
    const label = clusterLabel(item)
    const key = `${bucket}:${normalizeLabel(label)}`
    const existing = grouped.get(key)
    if (existing) {
      existing.push(item)
    } else {
      grouped.set(key, [item])
    }
  }

  return [...grouped.entries()]
    .map(([key, groupedItems]) => {
      const sortedItems = [...groupedItems].sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
      const sources = [...new Set(sortedItems.map((item) => item.source))]
      const label = clusterLabel(sortedItems[0])
      const uniqueTitles = new Set(sortedItems.map((item) => item.title.split(' • ')[0].toLowerCase()))
      return {
        id: key,
        title: buildCorrelationTitle(sortedItems, label),
        summary: buildCorrelationSummary(sortedItems, sources),
        tone: deriveClusterTone(sortedItems),
        confidence: deriveConfidence(sortedItems, sources),
        items: sortedItems,
        sources,
        timeRangeLabel: `${formatIsoDate(sortedItems[sortedItems.length - 1]?.occurredAt || '')} to ${formatIsoDate(sortedItems[0]?.occurredAt || '')}`,
        uniqueTitles
      }
    })
    .filter((cluster) => cluster.sources.length >= 2 || cluster.items.length >= 3 || cluster.uniqueTitles.size === 1)
    .sort((left, right) => new Date(right.items[0]?.occurredAt || 0).getTime() - new Date(left.items[0]?.occurredAt || 0).getTime())
    .map(({ uniqueTitles: _uniqueTitles, ...cluster }) => cluster)
}

function summaryCardTone(count: number): TimelineTone {
  if (count >= 5) return 'warning'
  if (count > 0) return 'info'
  return 'success'
}

function buildScopeHint(scope: IncidentTimelineScope, linkedProject: TerraformProject | null): string {
  if (scope === 'overview') {
    return linkedProject
      ? 'Scoped to the active AWS account and region. CloudTrail and CloudWatch are connection-wide; Terraform is attached from the currently selected project.'
      : 'Scoped to the active AWS account and region. CloudTrail and CloudWatch are connection-wide; no Terraform project is currently attached.'
  }

  return 'Scoped to the active AWS account/region and the selected Terraform workspace. Terraform signals are workspace-specific; CloudTrail and CloudWatch signals are connection-wide within the same window.'
}

function terraformContextKey(connection: AwsConnection): string {
  return connection.kind === 'profile'
    ? `profile:${connection.profile}`
    : `assumed-role:${connection.sessionId}`
}

function normalizeRoleLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '-') return 'Unknown role'
  const arnSlice = trimmed.split('/').pop()?.trim()
  return arnSlice || trimmed
}

function humanizeAuditLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._/]+/g, ' ')
    .replace(/:/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchesAuditConnection(event: EnterpriseAuditEvent, connection: AwsConnection): boolean {
  if (event.region && event.region !== connection.region) return false
  if (connection.kind === 'assumed-role' && event.accountId && event.accountId !== connection.accountId) return false
  return true
}

function deriveAuditServiceId(event: EnterpriseAuditEvent): ServiceId | '' {
  if (event.serviceId) return event.serviceId
  if (event.channel.startsWith('terraform:')) return 'terraform'
  if (event.channel.startsWith('terminal:')) return 'session-hub'
  return ''
}

function classifyRiskyAuditTone(event: EnterpriseAuditEvent): TimelineTone {
  const haystack = `${event.action} ${event.channel} ${event.summary} ${event.details.join(' ')}`.toLowerCase()
  const destructive = /delete|destroy|terminate|detach|revoke|remove|force-unlock|state-rm|purge|drop/.test(haystack)
  const privileged = /assume-role|apply|import|attach|policy|trust|access-key|login-profile|run-command|open-aws|terminal|update/.test(haystack)

  if (destructive && event.outcome === 'success') return 'danger'
  if (destructive || privileged) return 'warning'
  if (event.outcome !== 'success') return 'info'
  return 'info'
}

function isRiskyAuditEvent(event: EnterpriseAuditEvent): boolean {
  const haystack = `${event.action} ${event.channel} ${event.summary} ${event.details.join(' ')}`.toLowerCase()
  if (event.channel.startsWith('terraform:') || event.channel.startsWith('terminal:')) return true
  return /assume-role|delete|destroy|terminate|detach|revoke|remove|force-unlock|state-rm|apply|import|attach|policy|trust|access-key|login-profile|run-command|console|purge|rotate/.test(haystack)
}

function buildAssumeRoleSummary(events: CloudTrailEventSummary[], connection: AwsConnection, window: TimelineWindow): AssumeRoleSummary {
  const grouped = new Map<string, { count: number; lastSeen: string; actorLabels: Set<string> }>()

  for (const event of events) {
    if (!isWithinWindow(event.eventTime, window)) continue
    if (event.awsRegion && event.awsRegion !== connection.region) continue
    if (event.eventName.toLowerCase() !== 'assumerole') continue

    const roleLabel = normalizeRoleLabel(event.resourceName || event.resourceType || 'Unknown role')
    const existing = grouped.get(roleLabel) ?? {
      count: 0,
      lastSeen: event.eventTime,
      actorLabels: new Set<string>()
    }

    existing.count += 1
    if (new Date(event.eventTime).getTime() > new Date(existing.lastSeen).getTime()) {
      existing.lastSeen = event.eventTime
    }
    if (event.username) {
      existing.actorLabels.add(event.username)
    }
    grouped.set(roleLabel, existing)
  }

  const total = [...grouped.values()].reduce((sum, entry) => sum + entry.count, 0)
  const roles = [...grouped.entries()]
    .map(([roleLabel, entry]) => {
      const share = total > 0 ? entry.count / total : 0
      return {
        roleLabel,
        count: entry.count,
        lastSeen: entry.lastSeen,
        actorLabels: [...entry.actorLabels].sort(),
        concentration: share >= 0.6 && entry.count >= 3 ? 'unexpected' : share >= 0.35 && entry.count >= 2 ? 'elevated' : 'normal'
      } satisfies AssumeRoleUsage
    })
    .sort((left, right) => right.count - left.count || new Date(right.lastSeen).getTime() - new Date(left.lastSeen).getTime())
    .slice(0, 4)

  return { total, roles }
}

function buildRiskyActions(events: EnterpriseAuditEvent[], connection: AwsConnection, window: TimelineWindow): RiskyActionEntry[] {
  return events
    .filter((event) => isWithinWindow(event.happenedAt, window))
    .filter((event) => matchesAuditConnection(event, connection))
    .filter(isRiskyAuditEvent)
    .sort((left, right) => new Date(right.happenedAt).getTime() - new Date(left.happenedAt).getTime())
    .slice(0, 6)
    .map((event) => ({
      id: event.id,
      title: humanizeAuditLabel(event.action || event.channel),
      summary: `${event.actorLabel || 'Unknown actor'} - ${event.summary}`,
      detail: `${humanizeAuditLabel(event.channel)} - ${event.outcome}${event.resourceId ? ` - ${event.resourceId}` : ''}`,
      occurredAt: event.happenedAt,
      tone: classifyRiskyAuditTone(event),
      serviceId: deriveAuditServiceId(event),
      resourceId: event.resourceId
    }))
}

function driftRiskWeight(item: TerraformDriftItem): number {
  if (item.status === 'missing_in_aws' || item.status === 'unmanaged_in_aws') return 3
  if (item.status === 'drifted') return 2
  if (item.status === 'unsupported') return 1
  return 0
}

export function IncidentTimelineTab({
  scope = 'terraform',
  project,
  connection,
  driftReport,
  onOpenHistory,
  onOpenDrift,
  onNavigateService,
  onNavigateCloudWatch,
  onNavigateCloudTrail,
  onNavigateTerraform,
  onRunTerminalCommand
}: {
  scope?: IncidentTimelineScope
  project?: TerraformProject | null
  connection: AwsConnection
  driftReport?: TerraformDriftReport | null
  onOpenHistory?: () => void
  onOpenDrift?: () => void
  onNavigateService?: (serviceId: ServiceId, resourceId?: string) => void
  onNavigateCloudWatch?: (focus: { logGroupNames?: string[]; queryString?: string; sourceLabel?: string; serviceHint?: ServiceId | '' }) => void
  onNavigateCloudTrail?: (focus: { resourceName?: string; startTime?: string; endTime?: string; filter?: string }) => void
  onNavigateTerraform?: (focus?: { projectId?: string; detailTab?: 'operations' | 'actions' | 'state' | 'resources' | 'drift' | 'lab' | 'history'; runId?: string; driftItemKey?: string }) => void
  onRunTerminalCommand?: (command: string) => void
}) {
  const [windowMode, setWindowMode] = useState<TimelineWindowMode>('30m')
  const [viewMode, setViewMode] = useState<IncidentViewMode>(scope === 'overview' ? 'grouped' : 'signals')
  const [customStart, setCustomStart] = useState(() => toLocalInputValue(new Date(Date.now() - (30 * 60_000))))
  const [customEnd, setCustomEnd] = useState(() => toLocalInputValue(new Date()))
  const [items, setItems] = useState<TimelineItem[]>([])
  const [cloudTrailEvents, setCloudTrailEvents] = useState<CloudTrailEventSummary[]>([])
  const [auditEvents, setAuditEvents] = useState<EnterpriseAuditEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([])
  const [sourceFilter, setSourceFilter] = useState<TimelineSourceFilter>('all')
  const [toneFilter, setToneFilter] = useState<TimelineToneFilter>('all')
  const [query, setQuery] = useState('')
  const [linkedProject, setLinkedProject] = useState<TerraformProject | null>(project ?? null)
  const [linkedDriftReport, setLinkedDriftReport] = useState<TerraformDriftReport | null>(driftReport ?? null)
  const [terraformContextStatus, setTerraformContextStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>(
    scope === 'overview' ? 'loading' : project ? 'ready' : 'idle'
  )
  const [terraformContextMessage, setTerraformContextMessage] = useState('')

  const activeWindow = useMemo(
    () => resolveWindow(windowMode, customStart, customEnd),
    [customEnd, customStart, windowMode]
  )

  useEffect(() => {
    setViewMode(scope === 'overview' ? 'grouped' : 'signals')
  }, [scope])

  useEffect(() => {
    if (scope !== 'overview') {
      setLinkedProject(project ?? null)
      setLinkedDriftReport(driftReport ?? null)
      setTerraformContextStatus(project ? 'ready' : 'idle')
      setTerraformContextMessage('')
      return
    }

    let cancelled = false

    async function loadSelectedTerraformContext() {
      setTerraformContextStatus('loading')
      setTerraformContextMessage('')

      try {
        const selectedProjectId = await getSelectedProjectId(terraformContextKey(connection)).catch(() => '')
        if (!selectedProjectId) {
          if (!cancelled) {
            setLinkedProject(null)
            setLinkedDriftReport(null)
            setTerraformContextStatus('empty')
            setTerraformContextMessage('No Terraform project is selected, so the incident feed is currently AWS-only.')
          }
          return
        }

        const nextProject = await getProject(terraformContextKey(connection), selectedProjectId, connection)
        let nextDriftReport: TerraformDriftReport | null = null
        try {
          nextDriftReport = await getDrift(terraformContextKey(connection), selectedProjectId, {
            profile: connection.profile,
            region: connection.region
          })
        } catch {
          nextDriftReport = null
        }

        if (!cancelled) {
          setLinkedProject(nextProject)
          setLinkedDriftReport(nextDriftReport)
          setTerraformContextStatus('ready')
        }
      } catch (error) {
        if (!cancelled) {
          setLinkedProject(null)
          setLinkedDriftReport(null)
          setTerraformContextStatus('error')
          setTerraformContextMessage(error instanceof Error ? error.message : String(error))
        }
      }
    }

    void loadSelectedTerraformContext()

    return () => {
      cancelled = true
    }
  }, [connection, driftReport, project, scope])

  const loadTimeline = useCallback(async () => {
    setLoading(true)
    const nextWarnings: string[] = []

    try {
      const [runHistoryResult, cloudWatchResult, cloudTrailResult, auditResult] = await Promise.allSettled([
        linkedProject ? listRunHistory({ projectId: linkedProject.id }) : Promise.resolve(null),
        Promise.all([
          listCloudWatchInvestigationHistory({
            profile: connection.profile,
            region: connection.region,
            limit: 100
          }),
          listCloudWatchQueryHistory({
            profile: connection.profile,
            region: connection.region,
            limit: 100
          })
        ]),
        lookupCloudTrailEvents(connection, activeWindow.startIso, activeWindow.endIso),
        listEnterpriseAuditEvents()
      ])

      const terraformHistory = linkedProject && runHistoryResult.status === 'fulfilled' && Array.isArray(runHistoryResult.value)
        ? buildTerraformTimelineItems(runHistoryResult.value as TerraformRunRecord[], activeWindow, linkedProject)
        : []
      if (linkedProject && runHistoryResult.status === 'rejected') {
        nextWarnings.push(`Terraform history: ${runHistoryResult.reason instanceof Error ? runHistoryResult.reason.message : String(runHistoryResult.reason)}`)
      }

      const cloudWatchHistory = cloudWatchResult?.status === 'fulfilled'
        ? [
            ...buildCloudWatchTimelineItems((cloudWatchResult.value as [CloudWatchInvestigationHistoryEntry[], CloudWatchQueryHistoryEntry[]])[0], activeWindow),
            ...buildCloudWatchQueryTimelineItems((cloudWatchResult.value as [CloudWatchInvestigationHistoryEntry[], CloudWatchQueryHistoryEntry[]])[1], activeWindow)
          ]
        : []
      if (cloudWatchResult?.status === 'rejected') {
        nextWarnings.push(`CloudWatch investigation history: ${cloudWatchResult.reason instanceof Error ? cloudWatchResult.reason.message : String(cloudWatchResult.reason)}`)
      }

      const nextCloudTrailEvents = cloudTrailResult?.status === 'fulfilled'
        ? (cloudTrailResult.value as CloudTrailEventSummary[])
        : []
      const cloudTrailHistory = cloudTrailResult?.status === 'fulfilled'
        ? buildCloudTrailTimelineItems(nextCloudTrailEvents)
        : []
      if (cloudTrailResult?.status === 'rejected') {
        nextWarnings.push(`CloudTrail lookup: ${cloudTrailResult.reason instanceof Error ? cloudTrailResult.reason.message : String(cloudTrailResult.reason)}`)
      }

      const nextAuditEvents = auditResult?.status === 'fulfilled'
        ? (auditResult.value as EnterpriseAuditEvent[])
        : []
      if (auditResult?.status === 'rejected') {
        nextWarnings.push(`Operator audit log: ${auditResult.reason instanceof Error ? auditResult.reason.message : String(auditResult.reason)}`)
      }

      if (terraformContextStatus === 'error' && terraformContextMessage) {
        nextWarnings.push(`Terraform context: ${terraformContextMessage}`)
      } else if (terraformContextStatus === 'empty' && terraformContextMessage) {
        nextWarnings.push(terraformContextMessage)
      }

      const nextItems = [
        ...buildDriftTimelineItems(linkedDriftReport, activeWindow),
        ...terraformHistory,
        ...cloudWatchHistory,
        ...cloudTrailHistory
      ].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())

      setCloudTrailEvents(nextCloudTrailEvents)
      setAuditEvents(nextAuditEvents)
      setItems(nextItems)
      setSourceWarnings(nextWarnings)
    } finally {
      setLoading(false)
    }
  }, [activeWindow, connection, linkedDriftReport, linkedProject, terraformContextMessage, terraformContextStatus])

  useEffect(() => {
    void loadTimeline()
  }, [loadTimeline])

  const summary = useMemo(() => ({
    total: items.length,
    terraform: items.filter((item) => item.source === 'terraform').length,
    cloudtrail: items.filter((item) => item.source === 'cloudtrail').length,
    cloudwatch: items.filter((item) => item.source === 'cloudwatch').length,
    drift: items.filter((item) => item.source === 'drift').length
  }), [items])

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return items.filter((item) => {
      if (sourceFilter !== 'all' && item.source !== sourceFilter) return false
      if (toneFilter !== 'all' && item.tone !== toneFilter) return false
      if (!normalizedQuery) return true

      return [
        item.title,
        item.summary,
        item.detail,
        item.resourceName,
        item.serviceHint
      ].join(' ').toLowerCase().includes(normalizedQuery)
    })
  }, [items, query, sourceFilter, toneFilter])

  const groupedItems = useMemo(
    () => buildCorrelationClusters(filteredItems).slice(0, 8),
    [filteredItems]
  )

  const assumeRoleSummary = useMemo(
    () => buildAssumeRoleSummary(cloudTrailEvents, connection, activeWindow),
    [activeWindow, cloudTrailEvents, connection]
  )

  const recentRiskyActions = useMemo(
    () => buildRiskyActions(auditEvents, connection, activeWindow),
    [activeWindow, auditEvents, connection]
  )

  const terraformGuardrail = useMemo<TerraformGuardrailSummary | null>(() => {
    if (!linkedProject || !linkedDriftReport) return null

    const actionableCount = linkedDriftReport.summary.statusCounts.drifted
      + linkedDriftReport.summary.statusCounts.missing_in_aws
      + linkedDriftReport.summary.statusCounts.unmanaged_in_aws

    return {
      actionableCount,
      driftedCount: linkedDriftReport.summary.statusCounts.drifted,
      missingCount: linkedDriftReport.summary.statusCounts.missing_in_aws,
      unmanagedCount: linkedDriftReport.summary.statusCounts.unmanaged_in_aws,
      topTypes: linkedDriftReport.summary.resourceTypeCounts
        .filter((entry) => entry.count > 0)
        .sort((left, right) => right.count - left.count)
        .slice(0, 3),
      remediationItems: [...linkedDriftReport.items]
        .filter((item) => item.status !== 'in_sync' && item.status !== 'unsupported')
        .sort((left, right) => driftRiskWeight(right) - driftRiskWeight(left) || right.differences.length - left.differences.length)
        .slice(0, 3),
      latestScanLabel: linkedDriftReport.history.latestScanAt || linkedDriftReport.summary.scannedAt
    }
  }, [linkedDriftReport, linkedProject])

  function handleOpenTerraformSignal(focus?: { detailTab?: 'operations' | 'actions' | 'state' | 'resources' | 'drift' | 'lab' | 'history'; runId?: string; driftItemKey?: string }): void {
    if (!focus?.detailTab && !focus?.runId && !focus?.driftItemKey && onOpenHistory) {
      onOpenHistory()
      return
    }

    if (onNavigateTerraform) {
      onNavigateTerraform({
        projectId: linkedProject?.id,
        ...focus
      })
    }
  }

  function handleRunTerminalCommand(command?: string): void {
    if (!command || !onRunTerminalCommand) return
    onRunTerminalCommand(command)
  }

  function relatedServiceForItems(clusterItems: TimelineItem[]): { serviceId: ServiceId; resourceId?: string } | null {
    const first = clusterItems.find((item) => item.serviceHint && item.serviceHint !== 'terraform' && item.serviceHint !== 'cloudwatch' && item.serviceHint !== 'cloudtrail')
    if (!first?.serviceHint) return null
    return {
      serviceId: first.serviceHint,
      resourceId: first.resourceName
    }
  }

  function handleOpenRiskyAction(entry: RiskyActionEntry): void {
    if (entry.serviceId === 'terraform') {
      onNavigateTerraform?.({
        projectId: linkedProject?.id,
        detailTab: 'history'
      })
      return
    }

    if (entry.serviceId && onNavigateService) {
      onNavigateService(entry.serviceId, entry.resourceId || undefined)
    }
  }

  function renderRiskyActionButton(entry: RiskyActionEntry): ReactNode {
    if (entry.serviceId === 'terraform' && onNavigateTerraform) {
      return (
        <button type="button" className="tf-toolbar-btn" onClick={() => handleOpenRiskyAction(entry)}>
          Open Terraform
        </button>
      )
    }

    if (entry.serviceId && onNavigateService) {
      return (
        <button type="button" className="tf-toolbar-btn" onClick={() => handleOpenRiskyAction(entry)}>
          Open Service
        </button>
      )
    }

    return null
  }

  function renderClusterActions(cluster: CorrelationCluster): ReactNode {
    const relatedService = relatedServiceForItems(cluster.items)
    const firstTerraform = cluster.items.find((item) => item.source === 'terraform')
    const firstDrift = cluster.items.find((item) => item.source === 'drift')
    const terminalCandidate = cluster.items.find((item) => item.terminalCommand)

    return (
      <div className="tf-incident-actions">
        {cluster.items.some((item) => item.source === 'terraform') && (
          <button type="button" className="tf-toolbar-btn" onClick={() => handleOpenTerraformSignal({
            detailTab: firstTerraform?.terraformRunId ? 'history' : 'operations',
            runId: firstTerraform?.terraformRunId
          })}>Open Terraform</button>
        )}
        {cluster.items.some((item) => item.source === 'drift') && (onOpenDrift || onNavigateTerraform) && (
          <button type="button" className="tf-toolbar-btn" onClick={() => {
            if (firstDrift?.terraformDriftKey && onNavigateTerraform) {
              handleOpenTerraformSignal({ detailTab: 'drift', driftItemKey: firstDrift.terraformDriftKey })
              return
            }
            ;(onOpenDrift ?? onNavigateTerraform)?.()
          }}>Open Drift</button>
        )}
        {cluster.items.some((item) => item.source === 'cloudwatch') && onNavigateCloudWatch && (
          <button
            type="button"
            className="tf-toolbar-btn"
            onClick={() => {
              const firstCloudWatch = cluster.items.find((item) => item.source === 'cloudwatch')
              if (!firstCloudWatch) return
              onNavigateCloudWatch({
                logGroupNames: firstCloudWatch.logGroupNames,
                sourceLabel: firstCloudWatch.title,
                serviceHint: firstCloudWatch.serviceHint
              })
            }}
          >
            Open CloudWatch
          </button>
        )}
        {cluster.items.some((item) => item.source === 'cloudtrail') && onNavigateCloudTrail && (
          <button
            type="button"
            className="tf-toolbar-btn"
            onClick={() => {
              const firstCloudTrail = cluster.items.find((item) => item.source === 'cloudtrail')
              if (!firstCloudTrail) return
              onNavigateCloudTrail({
                resourceName: firstCloudTrail.resourceName,
                startTime: activeWindow.startIso,
                endTime: activeWindow.endIso,
                filter: buildCloudTrailFocusFilter(firstCloudTrail)
              })
            }}
          >
            Open CloudTrail
          </button>
        )}
        {relatedService && onNavigateService && (
          <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateService(relatedService.serviceId, relatedService.resourceId)}>
            Open Service
          </button>
        )}
        {terminalCandidate?.terminalCommand && onRunTerminalCommand && (
          <button type="button" className="tf-toolbar-btn" onClick={() => handleRunTerminalCommand(terminalCandidate.terminalCommand)}>
            Run in Terminal
          </button>
        )}
      </div>
    )
  }

  function renderSignalActions(item: TimelineItem): ReactNode {
    return (
      <div className="tf-incident-actions">
        {item.source === 'terraform' && (onOpenHistory || onNavigateTerraform) && (
          <button type="button" className="tf-toolbar-btn" onClick={() => handleOpenTerraformSignal({
            detailTab: item.terraformRunId ? 'history' : 'operations',
            runId: item.terraformRunId
          })}>Open Terraform</button>
        )}
        {item.source === 'drift' && (onOpenDrift || onNavigateTerraform) && (
          <button type="button" className="tf-toolbar-btn" onClick={() => {
            if (item.terraformDriftKey && onNavigateTerraform) {
              handleOpenTerraformSignal({ detailTab: 'drift', driftItemKey: item.terraformDriftKey })
              return
            }
            ;(onOpenDrift ?? onNavigateTerraform)?.()
          }}>Open Drift</button>
        )}
        {item.source === 'cloudtrail' && onNavigateCloudTrail && (
          <button
            type="button"
            className="tf-toolbar-btn"
            onClick={() => onNavigateCloudTrail({
              resourceName: item.resourceName,
              startTime: activeWindow.startIso,
              endTime: activeWindow.endIso,
              filter: buildCloudTrailFocusFilter(item)
            })}
          >
            Open CloudTrail
          </button>
        )}
        {item.source === 'cloudtrail' && !onNavigateCloudTrail && onNavigateService && (
          <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateService('cloudtrail', item.resourceName)}>
            Open CloudTrail
          </button>
        )}
        {item.source === 'cloudwatch' && (
          <>
            {onNavigateCloudWatch ? (
              <button
                type="button"
                className="tf-toolbar-btn"
                onClick={() => onNavigateCloudWatch({
                  logGroupNames: item.logGroupNames,
                  sourceLabel: item.title,
                  serviceHint: item.serviceHint
                })}
              >
                Open CloudWatch
              </button>
            ) : onNavigateService && (
              <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateService('cloudwatch')}>
                Open CloudWatch
              </button>
            )}
          </>
        )}
        {item.serviceHint && item.serviceHint !== 'terraform' && item.serviceHint !== 'cloudtrail' && item.serviceHint !== 'cloudwatch' && onNavigateService && (
          <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateService(item.serviceHint as ServiceId, item.resourceName)}>
            Open Service
          </button>
        )}
        {item.terminalCommand && onRunTerminalCommand && (
          <button type="button" className="tf-toolbar-btn" onClick={() => handleRunTerminalCommand(item.terminalCommand)}>
            Run in Terminal
          </button>
        )}
      </div>
    )
  }

  const showGroupedView = viewMode === 'grouped' && groupedItems.length > 0
  const showSignalsView = viewMode === 'signals' || !showGroupedView

  return (
    <>
      <div className="tf-section">
        <div className="tf-section-head">
          <div>
            <h3>{headlineForWindow(windowMode)}</h3>
            <div className="tf-section-hint">
              {buildScopeHint(scope, linkedProject)}
            </div>
          </div>
          <button type="button" className="tf-toolbar-btn accent" onClick={() => void loadTimeline()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh Timeline'}
          </button>
        </div>

        <div className="tf-incident-toolbar">
          <div className="tf-incident-toolbar-group">
            <div className="tf-incident-window-buttons">
              <button type="button" className={windowMode === '30m' ? 'active' : ''} onClick={() => setWindowMode('30m')}>30m</button>
              <button type="button" className={windowMode === '1h' ? 'active' : ''} onClick={() => setWindowMode('1h')}>1h</button>
              <button type="button" className={windowMode === 'custom' ? 'active' : ''} onClick={() => setWindowMode('custom')}>Custom</button>
            </div>
            <div className="tf-incident-view-buttons">
              <button type="button" className={viewMode === 'grouped' ? 'active' : ''} onClick={() => setViewMode('grouped')}>Grouped</button>
              <button type="button" className={viewMode === 'signals' ? 'active' : ''} onClick={() => setViewMode('signals')}>Signals</button>
            </div>
          </div>
          {windowMode === 'custom' && (
            <div className="tf-incident-custom-range">
              <label className="tf-history-filter-group">
                <span>Start</span>
                <input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
              </label>
              <label className="tf-history-filter-group">
                <span>End</span>
                <input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
              </label>
            </div>
          )}
        </div>

        <div className="tf-incident-filters">
          <label className="tf-history-filter-group">
            <span>Source</span>
            <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as TimelineSourceFilter)}>
              <option value="all">All sources</option>
              <option value="terraform">Terraform</option>
              <option value="cloudtrail">CloudTrail</option>
              <option value="cloudwatch">CloudWatch</option>
              <option value="drift">Drift</option>
            </select>
          </label>
          <label className="tf-history-filter-group">
            <span>Tone</span>
            <select value={toneFilter} onChange={(event) => setToneFilter(event.target.value as TimelineToneFilter)}>
              <option value="all">All tones</option>
              <option value="danger">Danger</option>
              <option value="warning">Warning</option>
              <option value="success">Success</option>
              <option value="info">Info</option>
            </select>
          </label>
          <label className="tf-history-filter-group tf-resource-search">
            <span>Search</span>
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Event, actor, resource, detail"
            />
          </label>
        </div>

        <div className="tf-overview-card-grid">
          <div className="tf-overview-card info">
            <span>Window</span>
            <strong>{activeWindow.label}</strong>
            <span>{summary.total} recent signals</span>
          </div>
          <div className="tf-overview-card success">
            <span>AWS context</span>
            <strong>{connection.region}</strong>
            <span>{connection.label} • {connection.profile}</span>
          </div>
          <div className={`tf-overview-card ${summaryCardTone(summary.cloudtrail)}`}>
            <span>CloudTrail writes</span>
            <strong>{summary.cloudtrail}</strong>
            <span>Management-plane write activity in the same window</span>
          </div>
          <div className={`tf-overview-card ${summary.terraform + summary.drift > 0 ? 'warning' : 'info'}`}>
            <span>Terraform signals</span>
            <strong>{summary.terraform + summary.drift}</strong>
            <span>
              {linkedProject
                ? `${linkedProject.name} • ${linkedProject.currentWorkspace}`
                : 'No selected Terraform project attached'}
            </span>
          </div>
        </div>

        <div className="tf-guardrail-grid">
          <section className={`tf-guardrail-card ${terraformGuardrail?.actionableCount ? 'warning' : 'success'}`}>
            <div className="tf-guardrail-head">
              <div>
                <span className="tf-guardrail-kicker">Terraform guardrails</span>
                <h4>Current project posture</h4>
              </div>
              <strong>{terraformGuardrail ? `${terraformGuardrail.actionableCount} actionable` : linkedProject ? 'No drift snapshot' : 'No project linked'}</strong>
            </div>
            {terraformGuardrail ? (
              <>
                <p className="tf-guardrail-copy">
                  {linkedProject?.name} on {linkedProject?.currentWorkspace}. Latest scan {formatIsoDate(terraformGuardrail.latestScanLabel)}.
                </p>
                <div className="tf-guardrail-metrics">
                  <span>Drifted {terraformGuardrail.driftedCount}</span>
                  <span>Missing {terraformGuardrail.missingCount}</span>
                  <span>Unmanaged {terraformGuardrail.unmanagedCount}</span>
                </div>
                <div className="tf-guardrail-list">
                  {terraformGuardrail.topTypes.length > 0 ? terraformGuardrail.topTypes.map((entry) => (
                    <div key={entry.resourceType} className="tf-guardrail-row">
                      <div>
                        <strong>{entry.resourceType}</strong>
                        <span>High-volume drift type</span>
                      </div>
                      <span>{entry.count}</span>
                    </div>
                  )) : (
                    <div className="tf-guardrail-empty">No drift-heavy resource type is currently standing out.</div>
                  )}
                </div>
                <div className="tf-guardrail-subtitle">Direct remediation entries</div>
                <div className="tf-guardrail-list compact">
                  {terraformGuardrail.remediationItems.length > 0 ? terraformGuardrail.remediationItems.map((item) => (
                    <div key={item.terraformAddress} className="tf-guardrail-row stacked">
                      <div>
                        <strong>{item.terraformAddress}</strong>
                        <span>{item.suggestedNextStep}</span>
                      </div>
                      <div className="tf-guardrail-row-side">
                        <span>{item.status.replace(/_/g, ' ')}</span>
                        <div className="tf-incident-actions">
                          {onNavigateTerraform && (
                            <button type="button" className="tf-toolbar-btn" onClick={() => handleOpenTerraformSignal({ detailTab: 'drift', driftItemKey: driftItemKey(item) })}>
                              Open Drift
                            </button>
                          )}
                          {item.terminalCommand && onRunTerminalCommand && (
                            <button type="button" className="tf-toolbar-btn" onClick={() => handleRunTerminalCommand(item.terminalCommand)}>
                              Run in Terminal
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )) : (
                    <div className="tf-guardrail-empty">No remediation entry is currently needed.</div>
                  )}
                </div>
              </>
            ) : (
              <p className="tf-guardrail-copy">
                {linkedProject
                  ? 'A Terraform project is linked, but there is no cached drift snapshot yet.'
                  : 'Overview is currently AWS-only. Select a Terraform project to pull in drift guardrails.'}
              </p>
            )}
            <div className="tf-incident-actions">
              {(onOpenDrift || onNavigateTerraform) && (
                <button type="button" className="tf-toolbar-btn" onClick={() => {
                  if (onNavigateTerraform) {
                    handleOpenTerraformSignal({ detailTab: 'drift' })
                    return
                  }
                  onOpenDrift?.()
                }}>
                  Open Drift
                </button>
              )}
              {onNavigateTerraform && (
                <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateTerraform({ projectId: linkedProject?.id, detailTab: 'operations' })}>
                  Open Terraform
                </button>
              )}
            </div>
          </section>

          <section className={`tf-guardrail-card ${assumeRoleSummary.roles[0]?.concentration === 'unexpected' ? 'danger' : assumeRoleSummary.total > 0 ? 'warning' : 'success'}`}>
            <div className="tf-guardrail-head">
              <div>
                <span className="tf-guardrail-kicker">Operator guardrails</span>
                <h4>AssumeRole concentration</h4>
              </div>
              <strong>{assumeRoleSummary.total} events</strong>
            </div>
            <p className="tf-guardrail-copy">
              Most frequently assumed IAM roles in the active window. Elevated or unexpected concentration hints at operator focus narrowing onto one role.
            </p>
            <div className="tf-guardrail-list">
              {assumeRoleSummary.roles.length > 0 ? assumeRoleSummary.roles.map((entry) => (
                <div key={entry.roleLabel} className="tf-guardrail-row stacked">
                  <div>
                    <strong>{entry.roleLabel}</strong>
                    <span>
                      {entry.actorLabels.slice(0, 3).join(', ') || 'Unknown actor'} - last seen {formatIsoDate(entry.lastSeen)}
                    </span>
                  </div>
                  <span className={`tf-guardrail-pill ${entry.concentration}`}>{entry.count} - {entry.concentration}</span>
                </div>
              )) : (
                <div className="tf-guardrail-empty">No AssumeRole activity was captured in the selected time window.</div>
              )}
            </div>
            {onNavigateCloudTrail && (
              <div className="tf-incident-actions">
                <button
                  type="button"
                  className="tf-toolbar-btn"
                  onClick={() => onNavigateCloudTrail({
                    startTime: activeWindow.startIso,
                    endTime: activeWindow.endIso,
                    filter: 'AssumeRole'
                  })}
                >
                  Open CloudTrail
                </button>
              </div>
            )}
          </section>

          <section className={`tf-guardrail-card ${recentRiskyActions.some((entry) => entry.tone === 'danger') ? 'danger' : recentRiskyActions.length > 0 ? 'warning' : 'success'}`}>
            <div className="tf-guardrail-head">
              <div>
                <span className="tf-guardrail-kicker">Risk log</span>
                <h4>Recent risky actions</h4>
              </div>
              <strong>{recentRiskyActions.length} entries</strong>
            </div>
            <p className="tf-guardrail-copy">
              Blunt operator activity pulled from terminal, service-console, and Terraform audit flows for this account and region.
            </p>
            <div className="tf-guardrail-list compact">
              {recentRiskyActions.length > 0 ? recentRiskyActions.map((entry) => (
                <div key={entry.id} className="tf-guardrail-row stacked">
                  <div>
                    <strong>{entry.title}</strong>
                    <span>{entry.summary}</span>
                    <span>{entry.detail}</span>
                  </div>
                  <div className="tf-guardrail-row-side">
                    <span className={`tf-guardrail-pill ${entry.tone}`}>{formatIsoDate(entry.occurredAt)}</span>
                    {renderRiskyActionButton(entry)}
                  </div>
                </div>
              )) : (
                <div className="tf-guardrail-empty">No risky operator action was captured in the selected time window.</div>
              )}
            </div>
          </section>
        </div>

        {sourceWarnings.length > 0 && (
          <div className="tf-incident-warning-list">
            {sourceWarnings.map((warning) => (
              <div key={warning} className="tf-inline-warning">{warning}</div>
            ))}
          </div>
        )}
      </div>

      {loading && items.length === 0 && (
        <div className="tf-section">
          <SvcState variant="loading" resourceName="incident timeline" />
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="tf-section">
          <SvcState variant="empty" message="No recent change signals were found for the selected window." />
        </div>
      )}

      {items.length > 0 && filteredItems.length === 0 && (
        <div className="tf-section">
          <SvcState variant="no-filter-matches" resourceName="timeline signals" />
        </div>
      )}

      {filteredItems.length > 0 && (
        <div className="tf-section">
          <div className="tf-section-hint">
            Showing {filteredItems.length} of {items.length} signals for this window.
          </div>
          {showGroupedView && (
            <div className="tf-correlation-grid">
              {groupedItems.map((cluster) => (
                <article key={cluster.id} className={`tf-correlation-card ${cluster.tone}`}>
                  <div className="tf-correlation-card-head">
                    <div>
                      <h4>{cluster.title}</h4>
                      <div className="tf-correlation-meta">
                        <span>{cluster.timeRangeLabel}</span>
                        <span>{cluster.items.length} signals</span>
                      </div>
                    </div>
                    <span className={`tf-correlation-confidence ${cluster.confidence}`}>{cluster.confidence} confidence</span>
                  </div>
                  <p>{cluster.summary}</p>
                  <div className="tf-correlation-sources">
                    {cluster.sources.map((source) => (
                      <span key={`${cluster.id}:${source}`} className={`tf-incident-source ${source}`}>{sourceLabel(source)}</span>
                    ))}
                  </div>
                  <div className="tf-correlation-list">
                    {cluster.items.slice(0, 3).map((item) => (
                      <div key={item.id} className="tf-correlation-item">
                        <strong>{item.title}</strong>
                        <span>{item.summary}</span>
                      </div>
                    ))}
                  </div>
                  {renderClusterActions(cluster)}
                </article>
              ))}
            </div>
          )}

          {showSignalsView && (
            <div className="tf-incident-list">
              {filteredItems.map((item) => (
                <article key={item.id} className={`tf-incident-card ${item.tone}`}>
                  <div className="tf-incident-card-head">
                    <div>
                      <div className="tf-incident-badges">
                        <span className={`tf-incident-source ${item.source}`}>{sourceLabel(item.source)}</span>
                        <span className="tf-incident-time">{formatIsoDate(item.occurredAt)}</span>
                      </div>
                      <h4>{item.title}</h4>
                    </div>
                  </div>
                  <p>{item.summary}</p>
                  <div className="tf-incident-detail">{item.detail}</div>
                  {renderSignalActions(item)}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
