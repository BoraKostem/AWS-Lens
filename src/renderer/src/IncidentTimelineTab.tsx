import { useEffect, useMemo, useRef, useState } from 'react'
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

import {
  listCloudWatchInvestigationHistory,
  listCloudWatchQueryHistory,
  listEnterpriseAuditEvents,
  lookupCloudTrailEvents
} from './api'
import './incident-workbench.css'
import { SvcState } from './SvcState'
import { getDrift, getProject, getSelectedProjectId, listRunHistory } from './terraformApi'

type TimelineWindowMode = '30m' | '1h' | 'custom'
type TimelineSource = 'terraform' | 'cloudtrail' | 'cloudwatch' | 'drift' | 'audit'
type TimelineTone = 'info' | 'success' | 'warning' | 'danger'
type IncidentTimelineScope = 'terraform' | 'overview'
type IncidentViewMode = 'grouped' | 'signals'
type TimelineSourceFilter = 'all' | TimelineSource
type TimelineToneFilter = 'all' | TimelineTone
type CorrelationConfidence = 'low' | 'medium' | 'high'

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
  serviceHint?: ServiceId | ''
  resourceName?: string
  logGroupNames?: string[]
  terminalCommand?: string
  terraformRunId?: string
  terraformDriftKey?: string
}

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

type AssumeRoleSummary = {
  total: number
  roles: AssumeRoleUsage[]
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
  terminalCommand?: string
}

type TerraformGuardrailSummary = {
  actionableCount: number
  driftedCount: number
  missingCount: number
  unmanagedCount: number
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
    return { startIso: start.toISOString(), endIso: now.toISOString(), label: 'Last 30 minutes' }
  }

  if (mode === '1h') {
    const start = new Date(now.getTime() - (60 * 60_000))
    return { startIso: start.toISOString(), endIso: now.toISOString(), label: 'Last 1 hour' }
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

function toneRank(tone: TimelineTone): number {
  switch (tone) {
    case 'danger':
      return 4
    case 'warning':
      return 3
    case 'success':
      return 2
    default:
      return 1
  }
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
  if (source === 'sts.amazonaws.com') return 'sts'
  return ''
}

function classifyCloudTrailTone(event: CloudTrailEventSummary): TimelineTone {
  const normalized = `${event.eventSource}:${event.eventName}`.toLowerCase()
  if (/delete|detach|remove|destroy|terminate|revoke/.test(normalized)) return 'danger'
  if (/assumerole|attach|put|update|create|passrole|set|modify/.test(normalized)) return 'warning'
  return 'info'
}

function driftItemKey(item: TerraformDriftItem): string {
  return `${item.terraformAddress}|${item.resourceType}|${item.cloudIdentifier}|${item.logicalName}|${item.status}`
}

function summarizeTerraformRun(record: TerraformRunRecord): { tone: TimelineTone; summary: string } {
  if (record.success === null) return { tone: 'info', summary: `${record.command} is still running in workspace ${record.workspace}.` }
  if (!record.success) return { tone: 'danger', summary: `${record.command} failed in workspace ${record.workspace}.` }
  if (record.command === 'plan' && record.planSummary?.hasDestructiveChanges) {
    return { tone: 'warning', summary: `plan succeeded with destructive changes in workspace ${record.workspace}.` }
  }
  if (record.command === 'apply' || record.command === 'destroy' || record.command === 'import') {
    return { tone: 'warning', summary: `${record.command} completed successfully in workspace ${record.workspace}.` }
  }
  return { tone: 'success', summary: `${record.command} completed successfully in workspace ${record.workspace}.` }
}

function buildTerraformTerminalCommand(record: TerraformRunRecord, project: TerraformProject | null): string {
  const args = [record.command, ...record.args].join(' ').trim()
  if (!args) return ''
  if (!project?.rootPath) return `terraform ${args}`.trim()
  return `cd "${project.rootPath}" && terraform ${args}`.trim()
}

function buildTimelineItems(
  window: TimelineWindow,
  project: TerraformProject | null,
  driftReport: TerraformDriftReport | null,
  terraformHistory: TerraformRunRecord[],
  cloudTrailEvents: CloudTrailEventSummary[],
  cloudWatchInvestigations: CloudWatchInvestigationHistoryEntry[],
  cloudWatchQueries: CloudWatchQueryHistoryEntry[],
  auditEvents: EnterpriseAuditEvent[]
): TimelineItem[] {
  const terraformItems = terraformHistory
    .filter((record) => isWithinWindow(record.finishedAt || record.startedAt, window))
    .map((record) => {
      const outcome = summarizeTerraformRun(record)
      const planSummary = record.planSummary
        ? `${record.planSummary.create} create, ${record.planSummary.update} update, ${record.planSummary.delete} delete, ${record.planSummary.replace} replace`
        : record.stateOperationSummary || 'No structured plan summary captured.'
      return {
        id: `terraform:${record.id}`,
        source: 'terraform' as const,
        tone: outcome.tone,
        occurredAt: record.finishedAt || record.startedAt,
        title: `${record.command.toUpperCase()} • ${record.projectName}`,
        summary: outcome.summary,
        detail: `${planSummary} Region: ${record.region || '-'} • Connection: ${record.connectionLabel || '-'}`,
        serviceHint: 'terraform' as ServiceId,
        terminalCommand: buildTerraformTerminalCommand(record, project),
        terraformRunId: record.id
      }
    })

  const cloudTrailItems = cloudTrailEvents
    .filter((event) => !event.readOnly)
    .map((event) => ({
      id: `cloudtrail:${event.eventId}`,
      source: 'cloudtrail' as const,
      tone: classifyCloudTrailTone(event),
      occurredAt: event.eventTime,
      title: `${event.eventName} • ${event.eventSource.replace('.amazonaws.com', '')}`,
      summary: event.resourceName ? `${event.username || 'Unknown actor'} changed ${event.resourceName}.` : `${event.username || 'Unknown actor'} invoked ${event.eventName}.`,
      detail: `Source IP: ${event.sourceIpAddress || '-'} • Region: ${event.awsRegion || '-'} • Resource type: ${event.resourceType || '-'}`,
      serviceHint: serviceIdFromCloudTrailEvent(event),
      resourceName: event.resourceName
    }))

  const cloudWatchInvestigationItems = cloudWatchInvestigations
    .filter((entry) => isWithinWindow(entry.occurredAt, window))
    .map((entry) => ({
      id: `cloudwatch:${entry.id}`,
      source: 'cloudwatch' as const,
      tone: (entry.severity === 'error' ? 'danger' : entry.severity === 'warning' ? 'warning' : entry.severity === 'success' ? 'success' : 'info') as TimelineTone,
      occurredAt: entry.occurredAt,
      title: `${entry.kind.replace(/-/g, ' ')} • CloudWatch`,
      summary: entry.title,
      detail: `${entry.detail}${entry.logGroupNames.length ? ` • Log groups: ${entry.logGroupNames.join(', ')}` : ''}`,
      serviceHint: entry.serviceHint,
      logGroupNames: entry.logGroupNames
    }))

  const cloudWatchQueryItems = cloudWatchQueries
    .filter((entry) => isWithinWindow(entry.executedAt, window))
    .map((entry) => ({
      id: `cloudwatch-query:${entry.id}`,
      source: 'cloudwatch' as const,
      tone: (entry.status === 'failed' ? 'danger' : 'info') as TimelineTone,
      occurredAt: entry.executedAt,
      title: `Query run • ${entry.serviceHint || 'cloudwatch'}`,
      summary: entry.resultSummary || (entry.status === 'failed' ? 'CloudWatch query failed.' : 'CloudWatch query completed.'),
      detail: `${entry.queryString.split('\n')[0] || 'Query'}${entry.logGroupNames.length ? ` • Log groups: ${entry.logGroupNames.join(', ')}` : ''}`,
      serviceHint: entry.serviceHint,
      logGroupNames: entry.logGroupNames
    }))

  const auditItems = auditEvents
    .filter((event) => isWithinWindow(event.happenedAt, window))
    .map((event) => ({
      id: `audit:${event.id}`,
      source: 'audit' as const,
      tone: (event.outcome === 'failed' || event.outcome === 'blocked' ? 'danger' : 'info') as TimelineTone,
      occurredAt: event.happenedAt,
      title: `${event.action} • ${event.channel}`,
      summary: event.summary,
      detail: `${event.actorLabel || 'Unknown actor'} • ${event.accountId || '-'} • ${event.region || '-'}`,
      serviceHint: event.serviceId,
      resourceName: event.resourceId
    }))

  const driftItems = (driftReport?.items ?? [])
    .filter((item) => item.status !== 'in_sync')
    .slice(0, 24)
    .map((item) => ({
      id: `drift:${driftItemKey(item)}`,
      source: 'drift' as const,
      tone: (item.status === 'missing_in_aws' || item.status === 'unmanaged_in_aws' ? 'danger' : 'warning') as TimelineTone,
      occurredAt: driftReport?.history.latestScanAt || new Date().toISOString(),
      title: `${item.status.replace(/_/g, ' ')} • ${item.logicalName}`,
      summary: item.explanation,
      detail: `${item.resourceType} • ${item.cloudIdentifier || 'No cloud identifier'}`,
      serviceHint: 'terraform' as ServiceId,
      resourceName: item.cloudIdentifier,
      terminalCommand: item.terminalCommand,
      terraformDriftKey: driftItemKey(item)
    }))

  return [...terraformItems, ...cloudTrailItems, ...cloudWatchInvestigationItems, ...cloudWatchQueryItems, ...auditItems, ...driftItems]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
}

function buildCorrelationClusters(items: TimelineItem[]): CorrelationCluster[] {
  if (!items.length) return []
  const sorted = [...items].sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
  const clusters: CorrelationCluster[] = []
  let current: TimelineItem[] = []

  const flush = () => {
    if (!current.length) return
    const first = current[0]
    const last = current[current.length - 1]
    const tone = current.reduce<TimelineTone>((best, item) => toneRank(item.tone) > toneRank(best) ? item.tone : best, 'info')
    const sources = [...new Set(current.map((item) => item.source))]
    const confidence: CorrelationConfidence = current.length >= 4 || sources.length >= 3 ? 'high' : current.length >= 2 ? 'medium' : 'low'
    clusters.push({
      id: current.map((item) => item.id).join('|'),
      title: first.resourceName || first.title,
      summary: `${current.length} related signals across ${sources.length} source${sources.length === 1 ? '' : 's'}.`,
      tone,
      confidence,
      items: current,
      sources,
      timeRangeLabel: `${formatIsoDate(last.occurredAt)} to ${formatIsoDate(first.occurredAt)}`
    })
    current = []
  }

  for (const item of sorted) {
    const previous = current[current.length - 1]
    if (!previous) {
      current.push(item)
      continue
    }
    const deltaMs = Math.abs(new Date(previous.occurredAt).getTime() - new Date(item.occurredAt).getTime())
    const sharesResource = Boolean(item.resourceName && previous.resourceName && item.resourceName === previous.resourceName)
    const sharesService = Boolean(item.serviceHint && previous.serviceHint && item.serviceHint === previous.serviceHint)
    if (deltaMs <= 10 * 60_000 && (sharesResource || sharesService || current.length < 2)) {
      current.push(item)
      continue
    }
    flush()
    current.push(item)
  }

  flush()
  return clusters.slice(0, 12)
}

function summarizeGuardrails(report: TerraformDriftReport | null): TerraformGuardrailSummary {
  if (!report) {
    return {
      actionableCount: 0,
      driftedCount: 0,
      missingCount: 0,
      unmanagedCount: 0,
      remediationItems: [],
      latestScanLabel: 'No drift snapshot loaded'
    }
  }

  return {
    actionableCount: report.items.filter((item) => item.status !== 'in_sync').length,
    driftedCount: report.summary.statusCounts.drifted,
    missingCount: report.summary.statusCounts.missing_in_aws,
    unmanagedCount: report.summary.statusCounts.unmanaged_in_aws,
    remediationItems: report.items.filter((item) => item.status !== 'in_sync').slice(0, 6),
    latestScanLabel: formatIsoDate(report.history.latestScanAt)
  }
}

function headlineForWindow(mode: TimelineWindowMode): string {
  if (mode === '30m') return 'Recent incident timeline'
  if (mode === '1h') return 'Last hour of changes'
  return 'Custom incident window'
}

function buildScopeHint(scope: IncidentTimelineScope, project: TerraformProject | null): string {
  if (scope === 'overview') {
    return project
      ? `AWS activity for ${project.name} is correlated with Terraform history when available.`
      : 'AWS activity is shown immediately; Terraform guardrails appear after a project is linked.'
  }
  return project ? `Timeline is scoped around ${project.name}.` : 'Terraform-only mode requires a linked project.'
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
  const [loading, setLoading] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [sourceFilter, setSourceFilter] = useState<TimelineSourceFilter>('all')
  const [toneFilter, setToneFilter] = useState<TimelineToneFilter>('all')
  const [query, setQuery] = useState('')
  const [linkedProject, setLinkedProject] = useState<TerraformProject | null>(project ?? null)
  const [linkedDriftReport, setLinkedDriftReport] = useState<TerraformDriftReport | null>(driftReport ?? null)
  const [terraformContextMessage, setTerraformContextMessage] = useState('')
  const loadTokenRef = useRef(0)

  useEffect(() => setLinkedProject(project ?? null), [project])
  useEffect(() => setLinkedDriftReport(driftReport ?? null), [driftReport])

  useEffect(() => {
    if (scope !== 'overview' || project) return
    let cancelled = false
    setTerraformContextMessage('')
    void (async () => {
      try {
        const selectedProjectId = await getSelectedProjectId(connection.profile)
        if (!selectedProjectId) {
          if (!cancelled) setTerraformContextMessage('No Terraform project is currently linked to this profile.')
          return
        }
        const nextProject = await getProject(connection.profile, selectedProjectId, connection)
        setLinkedProject(nextProject)
        try {
          const nextDrift = await getDrift(connection.profile, nextProject.id, connection, { forceRefresh: false })
          if (!cancelled) setLinkedDriftReport(nextDrift)
        } catch {}
      } catch (error) {
        if (!cancelled) setTerraformContextMessage(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connection, project, scope])

  const activeWindow = useMemo(() => resolveWindow(windowMode, customStart, customEnd), [customEnd, customStart, windowMode])

  useEffect(() => {
    const loadToken = loadTokenRef.current + 1
    loadTokenRef.current = loadToken
    setLoading(true)
    void (async () => {
      const cloudWatchPromise = Promise.all([
        listCloudWatchInvestigationHistory({ profile: connection.profile, region: connection.region, limit: 100 }),
        listCloudWatchQueryHistory({ profile: connection.profile, region: connection.region, limit: 100 })
      ])
      const cloudTrailPromise = lookupCloudTrailEvents(connection, activeWindow.startIso, activeWindow.endIso)
      const auditPromise = listEnterpriseAuditEvents()
      const terraformPromise = linkedProject ? listRunHistory({ projectId: linkedProject.id }) : Promise.resolve([] as TerraformRunRecord[])
      const [cloudWatchResult, cloudTrailResult, auditResult, terraformResult] = await Promise.allSettled([
        cloudWatchPromise,
        cloudTrailPromise,
        auditPromise,
        terraformPromise
      ])

      if (loadTokenRef.current !== loadToken) return

      const nextWarnings: string[] = []
      const cloudWatchInvestigations = cloudWatchResult.status === 'fulfilled' ? cloudWatchResult.value[0] : []
      const cloudWatchQueries = cloudWatchResult.status === 'fulfilled' ? cloudWatchResult.value[1] : []
      const nextCloudTrailEvents = cloudTrailResult.status === 'fulfilled' ? cloudTrailResult.value : []
      const auditEvents = auditResult.status === 'fulfilled' ? auditResult.value : []
      const terraformHistory = terraformResult.status === 'fulfilled' ? terraformResult.value : []

      if (cloudWatchResult.status === 'rejected') nextWarnings.push(`CloudWatch history: ${cloudWatchResult.reason instanceof Error ? cloudWatchResult.reason.message : String(cloudWatchResult.reason)}`)
      if (cloudTrailResult.status === 'rejected') nextWarnings.push(`CloudTrail: ${cloudTrailResult.reason instanceof Error ? cloudTrailResult.reason.message : String(cloudTrailResult.reason)}`)
      if (auditResult.status === 'rejected') nextWarnings.push(`Enterprise audit: ${auditResult.reason instanceof Error ? auditResult.reason.message : String(auditResult.reason)}`)
      if (terraformResult.status === 'rejected') nextWarnings.push(`Terraform history: ${terraformResult.reason instanceof Error ? terraformResult.reason.message : String(terraformResult.reason)}`)

      setCloudTrailEvents(nextCloudTrailEvents)
      setItems(buildTimelineItems(activeWindow, linkedProject, linkedDriftReport, terraformHistory, nextCloudTrailEvents, cloudWatchInvestigations, cloudWatchQueries, auditEvents))
      setWarnings(nextWarnings)
      setLoading(false)
    })()
  }, [activeWindow, connection, linkedDriftReport, linkedProject])

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => {
      if (sourceFilter !== 'all' && item.source !== sourceFilter) return false
      if (toneFilter !== 'all' && item.tone !== toneFilter) return false
      if (!needle) return true
      return [item.title, item.summary, item.detail, item.resourceName, item.serviceHint].some((value) =>
        String(value || '').toLowerCase().includes(needle)
      )
    })
  }, [items, query, sourceFilter, toneFilter])

  const groupedItems = useMemo(() => buildCorrelationClusters(filteredItems), [filteredItems])
  const guardrails = useMemo(() => summarizeGuardrails(linkedDriftReport), [linkedDriftReport])
  const assumeRoleSummary = useMemo(() => {
    const relevant = cloudTrailEvents.filter((event) => isWithinWindow(event.eventTime, activeWindow) && (event.eventName.toLowerCase() === 'assumerole' || event.eventSource.toLowerCase() === 'sts.amazonaws.com'))
    const byRole = new Map<string, { count: number; lastSeen: string; actors: Set<string> }>()
    for (const event of relevant) {
      const roleLabel = event.resourceName || event.resourceType || 'AssumeRole target'
      const bucket = byRole.get(roleLabel) ?? { count: 0, lastSeen: event.eventTime, actors: new Set<string>() }
      bucket.count += 1
      if (event.eventTime > bucket.lastSeen) bucket.lastSeen = event.eventTime
      if (event.username) bucket.actors.add(event.username)
      byRole.set(roleLabel, bucket)
    }
    return {
      total: relevant.length,
      roles: [...byRole.entries()].map(([roleLabel, bucket]) => ({
        roleLabel,
        count: bucket.count,
        lastSeen: bucket.lastSeen,
        actorLabels: [...bucket.actors].sort(),
        concentration: (bucket.count >= 6 ? 'unexpected' : bucket.count >= 3 ? 'elevated' : 'normal') as AssumeRoleUsage['concentration']
      })).sort((left, right) => right.count - left.count).slice(0, 6)
    } satisfies AssumeRoleSummary
  }, [activeWindow, cloudTrailEvents])
  const riskyActions = useMemo(() => filteredItems.filter((item) => item.tone !== 'info').slice(0, 10).map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    detail: item.detail,
    occurredAt: item.occurredAt,
    tone: item.tone,
    serviceId: item.serviceHint || '',
    resourceId: item.resourceName || '',
    terminalCommand: item.terminalCommand
  } satisfies RiskyActionEntry)), [filteredItems])

  function handleTerraformOpen(focus?: { detailTab?: 'operations' | 'actions' | 'state' | 'resources' | 'drift' | 'lab' | 'history'; runId?: string; driftItemKey?: string }): void {
    if (!focus?.detailTab && !focus?.runId && !focus?.driftItemKey && onOpenHistory) {
      onOpenHistory()
      return
    }
    onNavigateTerraform?.({ projectId: linkedProject?.id, ...focus })
  }

  function handleSignalActions(item: TimelineItem): ReactNode {
    return (
      <div className="tf-incident-actions">
        {item.source === 'terraform' && (onOpenHistory || onNavigateTerraform) && <button type="button" className="tf-toolbar-btn" onClick={() => handleTerraformOpen({ detailTab: 'history', runId: item.terraformRunId })}>Open Terraform</button>}
        {item.source === 'drift' && (onOpenDrift || onNavigateTerraform) && <button type="button" className="tf-toolbar-btn" onClick={() => item.terraformDriftKey && onNavigateTerraform ? handleTerraformOpen({ detailTab: 'drift', driftItemKey: item.terraformDriftKey }) : (onOpenDrift ?? onNavigateTerraform)?.()}>Open Drift</button>}
        {item.source === 'cloudtrail' && onNavigateCloudTrail && <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateCloudTrail({ resourceName: item.resourceName, startTime: activeWindow.startIso, endTime: activeWindow.endIso, filter: item.resourceName || item.title })}>Open CloudTrail</button>}
        {item.source === 'cloudwatch' && onNavigateCloudWatch && <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateCloudWatch({ logGroupNames: item.logGroupNames, sourceLabel: item.title, serviceHint: item.serviceHint })}>Open CloudWatch</button>}
        {item.serviceHint && item.serviceHint !== 'terraform' && item.serviceHint !== 'cloudtrail' && item.serviceHint !== 'cloudwatch' && onNavigateService && <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateService(item.serviceHint as ServiceId, item.resourceName)}>Open Service</button>}
        {item.terminalCommand && onRunTerminalCommand && <button type="button" className="tf-toolbar-btn" onClick={() => onRunTerminalCommand(item.terminalCommand!)}>Run in Terminal</button>}
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
            <div className="tf-section-hint">{buildScopeHint(scope, linkedProject)}</div>
          </div>
          <div className="tf-incident-toolbar">
            <div className="tf-incident-window-buttons">{(['30m', '1h', 'custom'] as TimelineWindowMode[]).map((mode) => <button key={mode} type="button" className={windowMode === mode ? 'active' : ''} onClick={() => setWindowMode(mode)}>{mode === 'custom' ? 'Custom' : mode}</button>)}</div>
            <div className="tf-incident-view-buttons">{(['grouped', 'signals'] as IncidentViewMode[]).map((mode) => <button key={mode} type="button" className={viewMode === mode ? 'active' : ''} onClick={() => setViewMode(mode)}>{mode === 'grouped' ? 'Correlations' : 'Signals'}</button>)}</div>
          </div>
        </div>
        {windowMode === 'custom' && <div className="tf-incident-custom-range"><label className="field"><span>Start</span><input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label className="field"><span>End</span><input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}
        <div className="tf-incident-filters">
          <label className="field"><span>Window</span><input value={activeWindow.label} readOnly /></label>
          <label className="field"><span>Source</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as TimelineSourceFilter)}><option value="all">All sources</option><option value="terraform">Terraform</option><option value="cloudtrail">CloudTrail</option><option value="cloudwatch">CloudWatch</option><option value="drift">Drift</option><option value="audit">Audit</option></select></label>
          <label className="field"><span>Tone</span><select value={toneFilter} onChange={(event) => setToneFilter(event.target.value as TimelineToneFilter)}><option value="all">All severities</option><option value="danger">Danger</option><option value="warning">Warning</option><option value="success">Success</option><option value="info">Info</option></select></label>
          <label className="field tf-incident-filter-span"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Resource, actor, service" /></label>
        </div>
        {terraformContextMessage && <div className="overview-note-item">{terraformContextMessage}</div>}
        {warnings.length > 0 && <div className="tf-incident-warning-list">{warnings.map((warning) => <div key={warning} className="overview-note-item">{warning}</div>)}</div>}
      </div>

      {loading && !items.length ? <SvcState variant="loading" resourceName="incident timeline" compact /> : (
        <>
          {showGroupedView && <section className="tf-section"><div className="tf-section-head"><div><h3>Correlation clusters</h3><div className="tf-section-hint">Grouped signals help isolate one storyline across CloudTrail, CloudWatch, and Terraform.</div></div></div>{groupedItems.length ? <div className="tf-correlation-grid">{groupedItems.map((cluster) => <article key={cluster.id} className={`tf-correlation-card ${cluster.tone}`}><div className="tf-correlation-card-head"><div><h4>{cluster.title}</h4><p>{cluster.summary}</p></div><span className={`tf-correlation-confidence ${cluster.confidence}`}>{cluster.confidence}</span></div><div className="tf-correlation-sources">{cluster.sources.map((source) => <span key={source} className={`tf-incident-source ${source}`}>{source}</span>)}</div><div className="tf-correlation-meta"><span>{cluster.timeRangeLabel}</span><span>{cluster.items.length} items</span></div><div className="tf-correlation-list">{cluster.items.slice(0, 4).map((item) => <div key={item.id} className="tf-correlation-item"><strong>{item.title}</strong><span>{item.summary}</span></div>)}</div></article>)}</div> : <SvcState variant="empty" message="No correlation clusters were formed for this window." compact />}</section>}
          {showSignalsView && <section className="tf-section"><div className="tf-section-head"><div><h3>Signals</h3><div className="tf-section-hint">Raw timeline entries remain available when you need exact event ordering.</div></div></div>{filteredItems.length ? <div className="tf-incident-list">{filteredItems.map((item) => <article key={item.id} className={`tf-incident-card ${item.tone}`}><div className="tf-incident-card-head"><div><div className="tf-incident-badges"><span className={`tf-incident-source ${item.source}`}>{item.source}</span><span className="tf-incident-time">{formatIsoDate(item.occurredAt)}</span></div><h4>{item.title}</h4></div></div><p>{item.summary}</p><div className="tf-incident-detail">{item.detail}</div>{handleSignalActions(item)}</article>)}</div> : <SvcState variant="empty" message="No timeline signals matched the current filters." compact />}</section>}

          <section className="tf-guardrail-grid">
            <section className={`tf-guardrail-card ${guardrails.actionableCount > 0 ? 'warning' : 'success'}`}><div className="tf-guardrail-head"><div><span className="tf-guardrail-kicker">Terraform guardrails</span><h4>Drift posture</h4></div><strong>{guardrails.actionableCount}</strong></div><p className="tf-guardrail-copy">Latest drift snapshot: {guardrails.latestScanLabel}.</p><div className="tf-guardrail-metrics"><div><span>Drifted</span><strong>{guardrails.driftedCount}</strong></div><div><span>Missing</span><strong>{guardrails.missingCount}</strong></div><div><span>Unmanaged</span><strong>{guardrails.unmanagedCount}</strong></div></div><div className="tf-guardrail-list">{guardrails.remediationItems.length ? guardrails.remediationItems.map((item) => <div key={driftItemKey(item)} className="tf-guardrail-row stacked"><div><strong>{item.logicalName}</strong><span>{item.explanation}</span></div><div className="tf-incident-actions">{(onOpenDrift || onNavigateTerraform) && <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateTerraform ? handleTerraformOpen({ detailTab: 'drift', driftItemKey: driftItemKey(item) }) : (onOpenDrift ?? onNavigateTerraform)?.()}>Open Drift</button>}{item.terminalCommand && onRunTerminalCommand && <button type="button" className="tf-toolbar-btn" onClick={() => onRunTerminalCommand(item.terminalCommand)}>Run in Terminal</button>}</div></div>) : <div className="tf-guardrail-empty">No remediation entry is currently needed.</div>}</div></section>
            <section className={`tf-guardrail-card ${assumeRoleSummary.roles[0]?.concentration === 'unexpected' ? 'danger' : assumeRoleSummary.total > 0 ? 'warning' : 'success'}`}><div className="tf-guardrail-head"><div><span className="tf-guardrail-kicker">Operator guardrails</span><h4>AssumeRole concentration</h4></div><strong>{assumeRoleSummary.total} events</strong></div><p className="tf-guardrail-copy">Most frequently assumed IAM roles in the active window.</p><div className="tf-guardrail-list">{assumeRoleSummary.roles.length ? assumeRoleSummary.roles.map((entry) => <div key={entry.roleLabel} className="tf-guardrail-row stacked"><div><strong>{entry.roleLabel}</strong><span>{entry.count} events • last seen {formatIsoDate(entry.lastSeen)}</span></div><div className="tf-correlation-meta"><span>{entry.actorLabels.join(', ') || 'Unknown actor'}</span><span>{entry.concentration}</span></div></div>) : <div className="tf-guardrail-empty">No AssumeRole concentration was detected in this window.</div>}</div>{onNavigateCloudTrail && <div className="tf-incident-actions"><button type="button" className="tf-toolbar-btn" onClick={() => onNavigateCloudTrail({ startTime: activeWindow.startIso, endTime: activeWindow.endIso, filter: 'AssumeRole' })}>Open CloudTrail</button></div>}</section>
          </section>

          <section className={`tf-guardrail-card ${riskyActions.some((entry) => entry.tone === 'danger') ? 'danger' : riskyActions.length > 0 ? 'warning' : 'success'}`}><div className="tf-guardrail-head"><div><span className="tf-guardrail-kicker">Risk log</span><h4>Recent risky actions</h4></div><strong>{riskyActions.length} entries</strong></div><p className="tf-guardrail-copy">Mutating actions and drift mismatches are promoted here for quick triage.</p><div className="tf-guardrail-list">{riskyActions.length ? riskyActions.map((entry) => <div key={entry.id} className="tf-guardrail-row stacked"><div><strong>{entry.title}</strong><span>{entry.summary}</span><div className="tf-incident-detail">{entry.detail}</div></div><div className="tf-incident-actions">{entry.serviceId === 'terraform' && (onOpenHistory || onNavigateTerraform) && <button type="button" className="tf-toolbar-btn" onClick={() => handleTerraformOpen({ detailTab: 'history' })}>Open Terraform</button>}{entry.serviceId && entry.serviceId !== 'terraform' && onNavigateService && <button type="button" className="tf-toolbar-btn" onClick={() => onNavigateService(entry.serviceId as ServiceId, entry.resourceId || undefined)}>Open Service</button>}{entry.terminalCommand && onRunTerminalCommand && <button type="button" className="tf-toolbar-btn" onClick={() => onRunTerminalCommand(entry.terminalCommand!)}>Run in Terminal</button>}</div></div>) : <div className="tf-guardrail-empty">No elevated-risk actions were detected in this window.</div>}</div></section>
        </>
      )}
    </>
  )
}
