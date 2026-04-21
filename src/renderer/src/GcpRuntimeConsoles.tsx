import { useEffect, useMemo, useState } from 'react'

import type {
  GcpComputeInstanceAction,
  GcpComputeInstanceDetail,
  GcpComputeMachineTypeOption,
  GcpComputeOperationResult,
  GcpComputeSerialOutput,
  GcpComputeInstanceSummary,
  GcpLabelEntry,
  GcpGkeClusterCredentials,
  GcpGkeClusterDetail,
  GcpGkeClusterSummary,
  GcpGkeNodePoolSummary,
  GcpSqlDatabaseSummary,
  GcpSqlInstanceDetail,
  GcpSqlOperationSummary,
  GcpSqlInstanceSummary
} from '@shared/types'
import {
  deleteGcpComputeInstance,
  getGcpComputeInstanceDetail,
  getGcpComputeSerialOutput,
  getGcpGkeClusterCredentials,
  getGcpGkeClusterDetail,
  getGcpSqlInstanceDetail,
  listGcpComputeInstances,
  listGcpComputeMachineTypes,
  listGcpGkeClusters,
  listGcpGkeNodePools,
  listGcpSqlDatabases,
  listGcpSqlInstances,
  listGcpSqlOperations,
  resizeGcpComputeInstance,
  runGcpComputeInstanceAction,
  updateGcpComputeInstanceLabels
} from './api'
import { ConfirmButton } from './ConfirmButton'
import './ec2.css'
import { FreshnessIndicator, useFreshnessState, type RefreshReason } from './freshness'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

type GcpEnableAction = {
  command: string
  summary: string
}

type GcpComputeSideTab = 'overview' | 'serial' | 'timeline'
type GcpComputeTimelineEntry = {
  id: string
  title: string
  detail: string
  at: string
  actor: string
}

type GcpCloudSqlActionKind = 'describe' | 'databases' | 'operations'
type GcpCloudSqlSideTab = 'overview' | 'databases' | 'operations'
type GcpCloudSqlColumnKey = 'instance' | 'engine' | 'region' | 'state' | 'endpoint' | 'storage'
type GcpCloudSqlTone = 'good' | 'warning' | 'risk' | 'info'

const GCP_CLOUD_SQL_COLUMNS: Array<{ key: GcpCloudSqlColumnKey; label: string; color: string }> = [
  { key: 'instance', label: 'Instance', color: '#50c878' },
  { key: 'engine', label: 'Engine', color: '#3fb1a3' },
  { key: 'region', label: 'Region', color: '#6ee7b7' },
  { key: 'state', label: 'State', color: '#f59e0b' },
  { key: 'endpoint', label: 'Endpoint', color: '#38bdf8' },
  { key: 'storage', label: 'Storage', color: '#94a3b8' }
]

function extractQuotedCommand(value: string): string | null {
  const straight = value.match(/"([^"]+)"/)
  if (straight?.[1]?.trim()) {
    return straight[1].trim()
  }

  const curly = value.match(/[“”]([^“”]+)[“”]/)
  return curly?.[1]?.trim() ?? null
}

function getGcpApiEnableAction(error: string, fallbackCommand: string, summary: string): GcpEnableAction | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) {
    return null
  }

  return {
    command: extractQuotedCommand(error) ?? fallbackCommand,
    summary
  }
}

function uniq(values: string[]): number {
  return new Set(values.filter(Boolean)).size
}

function countBy<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length
}

function riskTone(level: 'low' | 'medium' | 'high'): string {
  if (level === 'high') return 'severity-high'
  if (level === 'medium') return 'severity-medium'
  return 'severity-low'
}

function formatTime(value: string): string {
  return value ? new Date(value).toLocaleTimeString() : 'Pending'
}

function formatDateTime(value: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

function formatDateInput(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function mapCounts(values: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()

  for (const value of values) {
    const label = value.trim() || 'unspecified'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

function runTerminalAction(
  canRunTerminalCommand: boolean,
  command: string,
  summary: string,
  onRunTerminalCommand: (command: string) => void,
  setMessage: (message: string) => void
): void {
  if (!canRunTerminalCommand) {
    return
  }

  onRunTerminalCommand(command)
  setMessage(summary)
}

function instanceRiskNotes(instance: GcpComputeInstanceSummary): Array<{ label: string; tone: 'low' | 'medium' | 'high' }> {
  const notes: Array<{ label: string; tone: 'low' | 'medium' | 'high' }> = []
  const status = instance.status.trim().toUpperCase()

  if (instance.externalIp) {
    notes.push({ label: 'External IP exposed', tone: 'high' })
  }
  if (status !== 'RUNNING') {
    notes.push({ label: status ? `${status} lifecycle state` : 'Unknown lifecycle state', tone: 'medium' })
  }
  if (!instance.internalIp) {
    notes.push({ label: 'Missing internal IP', tone: 'medium' })
  }

  if (notes.length === 0) {
    notes.push({ label: 'No immediate exposure signal', tone: 'low' })
  }

  return notes
}

function clusterRiskNotes(cluster: GcpGkeClusterSummary): Array<{ label: string; tone: 'low' | 'medium' | 'high' }> {
  const notes: Array<{ label: string; tone: 'low' | 'medium' | 'high' }> = []
  const status = cluster.status.trim().toUpperCase()
  const releaseChannel = cluster.releaseChannel.trim().toLowerCase()
  const nodeCount = Number(cluster.nodeCount || '0')

  if (status !== 'RUNNING') {
    notes.push({ label: status ? `${status} control plane state` : 'Unknown control plane state', tone: 'high' })
  }
  if (!releaseChannel || releaseChannel === 'unspecified') {
    notes.push({ label: 'Release channel unspecified', tone: 'medium' })
  }
  if (Number.isFinite(nodeCount) && nodeCount === 0) {
    notes.push({ label: 'Node count is zero', tone: 'medium' })
  }
  if (!cluster.endpoint) {
    notes.push({ label: 'Endpoint missing from inventory', tone: 'medium' })
  }

  if (notes.length === 0) {
    notes.push({ label: 'Cluster posture looks stable', tone: 'low' })
  }

  return notes
}

function isCloudSqlRunnable(instance: GcpSqlInstanceSummary): boolean {
  return instance.state.trim().toUpperCase() === 'RUNNABLE'
}

function matchesLocationLens(instance: GcpSqlInstanceSummary, location: string): boolean {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return true
  }

  const region = instance.region.trim().toLowerCase()
  const zone = instance.zone.trim().toLowerCase()

  return region === normalizedLocation || zone === normalizedLocation || zone.startsWith(`${normalizedLocation}-`)
}

function sqlRiskNotes(instance: GcpSqlInstanceSummary): Array<{ label: string; tone: 'low' | 'medium' | 'high' }> {
  const notes: Array<{ label: string; tone: 'low' | 'medium' | 'high' }> = []

  if (!isCloudSqlRunnable(instance)) {
    notes.push({ label: instance.state ? `${instance.state} lifecycle state` : 'Unknown lifecycle state', tone: 'high' })
  }
  if (instance.primaryAddress) {
    notes.push({ label: 'Public IP exposed', tone: 'high' })
  }
  if (!instance.privateAddress) {
    notes.push({ label: 'Private IP unavailable', tone: 'medium' })
  }
  if (!instance.deletionProtectionEnabled) {
    notes.push({ label: 'Deletion protection disabled', tone: 'medium' })
  }
  if (!instance.storageAutoResizeEnabled) {
    notes.push({ label: 'Storage auto-resize disabled', tone: 'medium' })
  }
  if (!instance.maintenanceWindow) {
    notes.push({ label: 'Maintenance window not configured', tone: 'low' })
  }

  if (notes.length === 0) {
    notes.push({ label: 'Posture looks stable', tone: 'low' })
  }

  return notes
}

function prettifyCloudSqlLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function gcpCloudSqlToneClass(tone: GcpCloudSqlTone): string {
  return `gcp-sql-tone-${tone}`
}

function gcpCloudSqlStatusTone(status: string): GcpCloudSqlTone {
  const normalized = status.trim().toUpperCase()

  if (normalized === 'RUNNABLE' || normalized === 'DONE') return 'good'
  if (normalized === 'UNKNOWN' || !normalized) return 'info'
  if (normalized === 'PENDING_CREATE' || normalized === 'MAINTENANCE') return 'warning'
  return 'risk'
}

function getCloudSqlColumnValue(instance: GcpSqlInstanceSummary, key: GcpCloudSqlColumnKey): string {
  switch (key) {
    case 'instance':
      return instance.name
    case 'engine':
      return `${instance.databaseVersion || '-'}`
    case 'region':
      return instance.region || instance.zone || '-'
    case 'state':
      return instance.state || 'UNKNOWN'
    case 'endpoint':
      return instance.privateAddress || instance.primaryAddress || '-'
    case 'storage':
      return instance.diskSizeGb ? `${instance.diskSizeGb} GB` : '-'
  }
}

function SqlKv({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="gcp-sql-kv">
      {items.map(([label, value]) => (
        <div key={label} className="gcp-sql-kv-row">
          <div className="gcp-sql-kv-label">{label}</div>
          <div className="gcp-sql-kv-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

function SqlStatusBadge({ status }: { status: string }) {
  return (
    <span className={`gcp-sql-status-badge ${gcpCloudSqlToneClass(gcpCloudSqlStatusTone(status))}`}>
      {prettifyCloudSqlLabel(status || 'UNKNOWN')}
    </span>
  )
}

type GcpComputePanelTab = 'overview' | 'serial'
type GcpComputeMutationAction = GcpComputeInstanceAction | 'resize' | 'labels' | 'delete'

function formatLabelEditor(labels: GcpLabelEntry[]): string {
  return labels.map((entry) => `${entry.key}=${entry.value}`).join('\n')
}

function parseLabelEditor(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const delimiterIndex = line.includes('=') ? line.indexOf('=') : line.indexOf(':')
        if (delimiterIndex === -1) {
          return [line, ''] as const
        }

        return [line.slice(0, delimiterIndex).trim(), line.slice(delimiterIndex + 1).trim()] as const
      })
      .filter(([key]) => Boolean(key))
  )
}

function formatMemoryMb(memoryMb: number): string {
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) {
    return '-'
  }

  return `${(memoryMb / 1024).toFixed(memoryMb % 1024 === 0 ? 0 : 1)} GiB`
}

function computeActionAvailability(detail: GcpComputeInstanceDetail | null): {
  canStart: boolean
  canStop: boolean
  canReset: boolean
  canSuspend: boolean
  canResume: boolean
  canResize: boolean
} {
  const status = detail?.status.trim().toUpperCase() ?? ''
  const scheduling = detail?.scheduling.trim().toLowerCase() ?? ''
  const supportsSuspend = !scheduling.includes('preemptible')

  return {
    canStart: status === 'TERMINATED',
    canStop: status === 'RUNNING',
    canReset: status === 'RUNNING',
    canSuspend: status === 'RUNNING' && supportsSuspend,
    canResume: status === 'SUSPENDED',
    canResize: status === 'TERMINATED' || status === 'RUNNING'
  }
}

function buildComputeRecommendations(
  summary: GcpComputeInstanceSummary | null,
  detail: GcpComputeInstanceDetail | null
): Array<{ title: string; tone: 'low' | 'medium' | 'high' }> {
  if (!summary && !detail) {
    return []
  }

  const recommendations: Array<{ title: string; tone: 'low' | 'medium' | 'high' }> = []
  const status = (detail?.status || summary?.status || '').trim().toUpperCase()
  const externalIp = detail?.externalIp || summary?.externalIp || ''

  if (externalIp) {
    recommendations.push({ title: 'Review external IP exposure before using this instance as a shared operator target.', tone: 'high' })
  }
  if (status === 'RUNNING') {
    recommendations.push({ title: 'Use stop or suspend before resizing the machine type.', tone: 'medium' })
  }
  if (detail && detail.labels.length === 0) {
    recommendations.push({ title: 'Backfill labels for owner, environment, and cost-center to align with EC2 tag workflows.', tone: 'medium' })
  }
  if (detail && !detail.serviceAccounts.length) {
    recommendations.push({ title: 'No service account is attached; confirm this is intentional before troubleshooting identity-based failures.', tone: 'medium' })
  }
  if (detail && detail.metadata.length === 0) {
    recommendations.push({ title: 'Startup metadata is empty; verify this instance does not depend on missing bootstrap keys.', tone: 'low' })
  }
  if (recommendations.length === 0) {
    recommendations.push({ title: 'No immediate operator action is suggested from the current posture snapshot.', tone: 'low' })
  }

  return recommendations
}

function computeStatusBadgeClass(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'running') return 'running'
  if (normalized === 'terminated' || normalized === 'stopped' || normalized === 'terminated-by-user') return 'stopped'
  if (normalized === 'suspended' || normalized === 'stopping' || normalized === 'starting' || normalized === 'provisioning') return 'pending'
  return 'terminated'
}

export function GcpComputeEngineConsolePage({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand: _onRunTerminalCommand,
  canRunTerminalCommand: _canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const [instances, setInstances] = useState<GcpComputeInstanceSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped' | 'public' | 'private'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')
  const [message, setMessage] = useState('')
  const [detail, setDetail] = useState<GcpComputeInstanceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [machineTypes, setMachineTypes] = useState<GcpComputeMachineTypeOption[]>([])
  const [machineTypesLoading, setMachineTypesLoading] = useState(false)
  const [machineTypesError, setMachineTypesError] = useState('')
  const [resizeTarget, setResizeTarget] = useState('')
  const [labelEditor, setLabelEditor] = useState('')
  const [sideTab, setSideTab] = useState<GcpComputeSideTab>('overview')
  const [showDescribe, setShowDescribe] = useState(false)
  const [mutationLoading, setMutationLoading] = useState<GcpComputeMutationAction | null>(null)
  const [mutationError, setMutationError] = useState('')
  const [serialOutput, setSerialOutput] = useState<GcpComputeSerialOutput | null>(null)
  const [serialLoading, setSerialLoading] = useState(false)
  const [serialError, setSerialError] = useState('')
  const [runtimeTimeline, setRuntimeTimeline] = useState<GcpComputeTimelineEntry[]>([])
  const [timelineStart, setTimelineStart] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() - 30)
    return formatDateInput(date)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => formatDateInput(new Date()))
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  async function loadInventory(trigger: RefreshReason = 'initial'): Promise<void> {
    beginRefresh(trigger)
    setLoading(true)
    setError('')

    try {
      const nextInstances = await listGcpComputeInstances(projectId, location)
      setInstances(nextInstances)
      setSelectedName((current) => current && nextInstances.some((instance) => instance.name === current) ? current : (nextInstances[0]?.name ?? ''))
      setLastLoadedAt(new Date().toISOString())
      completeRefresh()
    } catch (err) {
      setInstances([])
      setSelectedName('')
      setError(err instanceof Error ? err.message : String(err))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadInventory()
  }, [location, projectId, refreshNonce])

  const filteredInstances = useMemo(() => {
    const query = search.trim().toLowerCase()

    return instances.filter((instance) => {
      if (statusFilter === 'running' && instance.status.trim().toUpperCase() !== 'RUNNING') return false
      if (statusFilter === 'stopped' && instance.status.trim().toUpperCase() === 'RUNNING') return false
      if (statusFilter === 'public' && !instance.externalIp) return false
      if (statusFilter === 'private' && Boolean(instance.externalIp)) return false
      if (!query) return true

      return [instance.name, instance.zone, instance.status, instance.machineType, instance.internalIp, instance.externalIp]
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
  }, [instances, search, statusFilter])

  const selectedInstance = useMemo(
    () => filteredInstances.find((instance) => instance.name === selectedName)
      ?? instances.find((instance) => instance.name === selectedName)
      ?? filteredInstances[0]
      ?? instances[0]
      ?? null,
    [filteredInstances, instances, selectedName]
  )

  useEffect(() => {
    if (selectedInstance && selectedInstance.name !== selectedName) {
      setSelectedName(selectedInstance.name)
    }
  }, [selectedInstance, selectedName])

  useEffect(() => {
    async function loadSelectedState(): Promise<void> {
      if (!selectedInstance) {
        setDetail(null)
        setMachineTypes([])
        setResizeTarget('')
        setLabelEditor('')
        setSerialOutput(null)
        return
      }

      setDetailLoading(true)
      setMachineTypesLoading(true)
      setDetailError('')
      setMachineTypesError('')
      setMutationError('')
      setSerialError('')
      setSerialOutput(null)
      setSideTab('overview')
      setShowDescribe(false)
      setRuntimeTimeline([])

      try {
        const [nextDetail, nextMachineTypes] = await Promise.all([
          getGcpComputeInstanceDetail(projectId, selectedInstance.zone, selectedInstance.name),
          listGcpComputeMachineTypes(projectId, selectedInstance.zone)
        ])
        setDetail(nextDetail)
        setMachineTypes(nextMachineTypes)
        setResizeTarget(nextDetail?.machineType || selectedInstance.machineType || '')
        setLabelEditor(nextDetail ? formatLabelEditor(nextDetail.labels) : '')
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err)
        setDetail(null)
        setMachineTypes([])
        setDetailError(messageText)
        setMachineTypesError(messageText)
      } finally {
        setDetailLoading(false)
        setMachineTypesLoading(false)
      }
    }

    void loadSelectedState()
  }, [projectId, selectedInstance?.name, selectedInstance?.zone])

  async function loadSerialOutputView(start = 0): Promise<void> {
    if (!selectedInstance) {
      return
    }

    setSideTab('serial')
    setSerialLoading(true)
    setSerialError('')

    try {
      const output = await getGcpComputeSerialOutput(projectId, selectedInstance.zone, selectedInstance.name, 1, start)
      setSerialOutput(output)
      setMessage(`Loaded serial output for ${selectedInstance.name}.`)
    } catch (err) {
      setSerialError(err instanceof Error ? err.message : String(err))
    } finally {
      setSerialLoading(false)
    }
  }

  async function runMutation(action: GcpComputeMutationAction): Promise<void> {
    if (!selectedInstance) {
      return
    }

    setMutationLoading(action)
    setMutationError('')

    try {
      let result: GcpComputeOperationResult

      if (action === 'resize') {
        const currentStatus = detail?.status.trim().toUpperCase() ?? ''
        const wasRunning = currentStatus === 'RUNNING'
        if (wasRunning) {
          await runGcpComputeInstanceAction(projectId, selectedInstance.zone, selectedInstance.name, 'stop')
        }
        try {
          result = await resizeGcpComputeInstance(projectId, selectedInstance.zone, selectedInstance.name, resizeTarget)
        } finally {
          if (wasRunning) {
            await runGcpComputeInstanceAction(projectId, selectedInstance.zone, selectedInstance.name, 'start').catch(() => undefined)
          }
        }
        if (wasRunning) {
          result = { ...result, summary: `${result.summary} Instance stopped and restarted to apply the change.` }
        }
      } else if (action === 'labels') {
        result = await updateGcpComputeInstanceLabels(projectId, selectedInstance.zone, selectedInstance.name, parseLabelEditor(labelEditor))
      } else if (action === 'delete') {
        result = await deleteGcpComputeInstance(projectId, selectedInstance.zone, selectedInstance.name)
      } else {
        result = await runGcpComputeInstanceAction(projectId, selectedInstance.zone, selectedInstance.name, action)
      }

      setMessage(result.summary)
      setRuntimeTimeline((current) => [
        {
          id: `${action}-${Date.now()}`,
          title: result.summary,
          detail: `Operation ${result.operationName} returned status ${result.status || 'UNKNOWN'}.`,
          at: new Date().toISOString(),
          actor: 'In-app action'
        },
        ...current
      ])

      await loadInventory('manual')
      if (action !== 'delete') {
        const nextDetail = await getGcpComputeInstanceDetail(projectId, selectedInstance.zone, selectedInstance.name).catch(() => null)
        setDetail(nextDetail)
        setLabelEditor(nextDetail ? formatLabelEditor(nextDetail.labels) : '')
        setResizeTarget(nextDetail?.machineType || resizeTarget)
      } else {
        setDetail(null)
        setLabelEditor('')
        setResizeTarget('')
        setSerialOutput(null)
      }
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err))
    } finally {
      setMutationLoading(null)
    }
  }

  const locationLabel = location.trim() || 'all locations'
  const runningCount = countBy(instances, (instance) => instance.status.trim().toUpperCase() === 'RUNNING')
  const publicCount = countBy(instances, (instance) => Boolean(instance.externalIp))
  const privateOnlyCount = countBy(instances, (instance) => !instance.externalIp)
  const zoneSpread = uniq(instances.map((instance) => instance.zone))
  const fleetHotspots = mapCounts(instances.map((instance) => instance.zone)).slice(0, 4)
  const actionAvailability = computeActionAvailability(detail)
  const recommendations = buildComputeRecommendations(selectedInstance, detail)
  const selectedMachineType = machineTypes.find((option) => option.name === (resizeTarget || detail?.machineType || '')) ?? null
  const enableAction = error ? getGcpApiEnableAction(
    error,
    `gcloud services enable compute.googleapis.com --project ${projectId}`,
    `Compute Engine API is disabled for project ${projectId}.`
  ) : null
  const selectedStatus = detail?.status || selectedInstance?.status || 'UNKNOWN'
  const selectedMachine = detail?.machineType || selectedInstance?.machineType || '-'
  const selectedZone = detail?.zone || selectedInstance?.zone || '-'
  const selectedInternalIp = detail?.internalIp || selectedInstance?.internalIp || '-'
  const selectedExternalIp = detail?.externalIp || selectedInstance?.externalIp || ''
  const timelineEntries = useMemo(() => {
    const entries: GcpComputeTimelineEntry[] = []

    if (detail?.creationTimestamp) {
      entries.push({
        id: `created-${detail.id || detail.name}`,
        title: 'Instance created',
        detail: `${detail.name} was provisioned in ${detail.zone || selectedZone}.`,
        at: detail.creationTimestamp,
        actor: 'Compute Engine'
      })
    }
    if (detail?.lastStartTimestamp) {
      entries.push({
        id: `started-${detail.id || detail.name}`,
        title: 'Last start',
        detail: `${detail.name} most recently entered a running state.`,
        at: detail.lastStartTimestamp,
        actor: 'Compute Engine'
      })
    }
    if (detail?.lastStopTimestamp) {
      entries.push({
        id: `stopped-${detail.id || detail.name}`,
        title: 'Last stop',
        detail: `${detail.name} most recently left the running state.`,
        at: detail.lastStopTimestamp,
        actor: 'Compute Engine'
      })
    }

    return [...runtimeTimeline, ...entries]
      .filter((entry) => entry.at)
      .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
  }, [detail, runtimeTimeline, selectedZone])
  const filteredTimelineEntries = useMemo(() => {
    const start = timelineStart ? new Date(`${timelineStart}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
    const end = timelineEnd ? new Date(`${timelineEnd}T23:59:59`).getTime() : Number.POSITIVE_INFINITY

    return timelineEntries.filter((entry) => {
      const at = new Date(entry.at).getTime()
      return Number.isFinite(at) && at >= start && at <= end
    })
  }, [timelineEnd, timelineEntries, timelineStart])

  return (
    <div className="ec2-console gcp-runtime-console gcp-runtime-console-compute gcp-ec2-shell">
      <section className="ec2-shell-hero gcp-ec2-hero">
        <div className="ec2-shell-hero-copy">
          <span className="ec2-shell-kicker gcp-ec2-kicker">Compute Operations</span>
          <h2>Compute Engine inventory and instance controls in the EC2 workspace layout.</h2>
          <p>
            Review fleet state, inspect one instance in depth, run lifecycle changes, resize machine types, edit labels,
            and pull serial output from the same operator surface.
          </p>
          <div className="ec2-shell-meta-strip">
            <div className="ec2-shell-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="ec2-shell-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="ec2-shell-meta-pill">
              <span>Selected</span>
              <strong>{selectedInstance?.name || 'No instance selected'}</strong>
            </div>
            <div className="ec2-shell-meta-pill">
              <span>Last Sync</span>
              <strong>{loading ? 'Syncing...' : formatTime(lastLoadedAt)}</strong>
            </div>
          </div>
        </div>
        <div className="ec2-shell-hero-stats">
          <div className="ec2-shell-stat-card accent">
            <span>Total instances</span>
            <strong>{instances.length}</strong>
            <small>Fleet items in the current project and location slice.</small>
          </div>
          <div className="ec2-shell-stat-card info">
            <span>Running</span>
            <strong>{runningCount}</strong>
            <small>Instances currently reporting `RUNNING`.</small>
          </div>
          <div className="ec2-shell-stat-card">
            <span>Public exposure</span>
            <strong>{publicCount}</strong>
            <small>Instances with an external IP attached.</small>
          </div>
          <div className="ec2-shell-stat-card">
            <span>Zone spread</span>
            <strong>{zoneSpread}</strong>
            <small>{fleetHotspots[0]?.label || 'No active hotspot yet'}</small>
          </div>
        </div>
      </section>

      <div className="ec2-shell-toolbar gcp-ec2-shell-toolbar">
        <div className="ec2-shell-status">
          <FreshnessIndicator freshness={freshness} label="Compute inventory" staleLabel="Refresh inventory" />
        </div>
        <div className="ec2-tab-bar gcp-ec2-tab-bar">
          <button className="ec2-tab active" type="button">Instances</button>
          <button className="ec2-toolbar-btn accent" type="button" disabled={loading} onClick={() => void loadInventory('manual')}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
        </div>
      </div>

      {message ? <div className="ec2-msg gcp-ec2-msg">{message}</div> : null}
      {error ? (
        <div className="ec2-msg gcp-ec2-msg error">
          {enableAction ? (
            <div className="gcp-enable-error-banner">
              <div className="gcp-enable-error-copy">
                <strong>{enableAction.summary}</strong>
                <p>Enable the API once, wait for propagation, then refresh the inventory.</p>
              </div>
              <pre className="gcp-runtime-code-block">{enableAction.command}</pre>
            </div>
          ) : (
            <SvcState variant="error" error={error} compact />
          )}
        </div>
      ) : null}

      <div className="ec2-filter-shell gcp-ec2-filter-shell">
        <div className="ec2-filter-grid">
          <label className="ec2-filter-field">
            <span className="ec2-filter-label">State</span>
            <select className="ec2-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">All instances</option>
              <option value="running">Running</option>
              <option value="stopped">Non-running</option>
              <option value="public">Public IP</option>
              <option value="private">Private only</option>
            </select>
          </label>
          <label className="ec2-filter-field ec2-filter-field-search">
            <span className="ec2-filter-label">Search</span>
            <input
              className="ec2-search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter rows by name, zone, IP, or machine type"
            />
          </label>
        </div>
        <div className="ec2-table-shell-meta gcp-ec2-summary-pills">
          <span className="ec2-workspace-badge">{privateOnlyCount} private-only</span>
          <span className="ec2-workspace-badge">{instances.length - runningCount} non-running</span>
          <span className="ec2-workspace-badge">{fleetHotspots[0]?.label || 'No hotspot'}</span>
          <span className="ec2-workspace-badge">{selectedMachine}</span>
        </div>
      </div>

      {!loading && !instances.length && !error ? (
        <div className="ec2-table-shell gcp-ec2-empty-state">
          <SvcState variant="empty" message={`No Compute Engine instances were found for ${projectId} in ${locationLabel}.`} compact />
        </div>
      ) : null}

      {instances.length > 0 ? (
        <div className="ec2-main-layout gcp-ec2-main-layout">
          <section className="ec2-table-shell gcp-ec2-table-shell">
            <div className="ec2-table-shell-header">
              <div>
                <h3>Instance Inventory</h3>
                <p>{filteredInstances.length} visible rows across the active Compute Engine fleet view.</p>
              </div>
              <div className="ec2-table-shell-meta">
                <span className="ec2-workspace-badge">{runningCount} running</span>
                <span className="ec2-workspace-badge">{publicCount} public IP</span>
              </div>
            </div>
            <div className="ec2-table-area">
              {loading ? (
                <div className="gcp-ec2-table-state">
                  <SvcState variant="loading" message="Loading Compute Engine inventory..." compact />
                </div>
              ) : !filteredInstances.length ? (
                <div className="gcp-ec2-table-state">
                  <SvcState variant="no-filter-matches" resourceName="instances" compact />
                </div>
              ) : (
                <table className="ec2-data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Zone</th>
                      <th>Machine Type</th>
                      <th>Internal IP</th>
                      <th>External IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInstances.map((instance) => (
                      <tr
                        key={`${instance.zone}:${instance.name}`}
                        className={selectedInstance?.name === instance.name ? 'active' : ''}
                        onClick={() => setSelectedName(instance.name)}
                      >
                        <td>
                          <div className="gcp-ec2-row-primary">
                            <strong>{instance.name}</strong>
                            <span>{instance.zone || 'Unknown zone'}</span>
                          </div>
                        </td>
                        <td>
                          <span className={`ec2-badge ${computeStatusBadgeClass(instance.status)}`}>{instance.status || 'UNKNOWN'}</span>
                        </td>
                        <td>{instance.zone || '-'}</td>
                        <td>{instance.machineType || '-'}</td>
                        <td>{instance.internalIp || '-'}</td>
                        <td>{instance.externalIp || 'Private only'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="ec2-sidebar gcp-ec2-sidebar">
            <div className="ec2-side-tabs">
              <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>Overview</button>
              <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>Change Timeline</button>
              <button className={sideTab === 'serial' ? 'active' : ''} type="button" onClick={() => {
                setSideTab('serial')
                if (!serialOutput && !serialLoading && selectedInstance) {
                  void loadSerialOutputView(0)
                }
              }}>Serial Output</button>
            </div>

            {selectedInstance ? (
              <>
                {sideTab === 'overview' ? (
                  <>
                    <div className="ec2-sidebar-section">
                      <h3>Actions</h3>
                      <div className="ec2-sidebar-hint">AWS inspector layout, adapted for Compute Engine. All actions stay inside the app.</div>
                      <div className="ec2-actions-grid">
                        <button className="ec2-action-btn" type="button" onClick={() => setShowDescribe((current) => !current)}>
                          {showDescribe ? 'Hide describe' : 'Describe instance'}
                        </button>
                        <button className="ec2-action-btn" type="button" onClick={() => void loadSerialOutputView(0)}>Serial output</button>
                        <button className="ec2-action-btn start" type="button" disabled={!actionAvailability.canStart || mutationLoading !== null} onClick={() => void runMutation('start')}>
                          {mutationLoading === 'start' ? 'Starting...' : 'Start'}
                        </button>
                        <ConfirmButton
                          className="ec2-action-btn stop"
                          disabled={!actionAvailability.canStop || mutationLoading !== null}
                          confirmLabel="Confirm stop"
                          confirmButtonLabel="Stop instance"
                          modalTitle="Stop Compute Engine instance"
                          modalBody={`Stop ${selectedInstance.name} in ${selectedInstance.zone}? This will halt workloads until the instance is started again.`}
                          summaryItems={[`Project: ${projectId}`, `Zone: ${selectedInstance.zone}`, `Lifecycle: ${selectedStatus}`]}
                          onConfirm={() => void runMutation('stop')}
                        >
                          {mutationLoading === 'stop' ? 'Stopping...' : 'Stop'}
                        </ConfirmButton>
                        <ConfirmButton
                          className="ec2-action-btn"
                          disabled={!actionAvailability.canReset || mutationLoading !== null}
                          confirmLabel="Confirm reset"
                          confirmButtonLabel="Reset instance"
                          modalTitle="Reset Compute Engine instance"
                          modalBody={`Reset ${selectedInstance.name} in ${selectedInstance.zone}? This is equivalent to a hard reboot and can interrupt in-flight work.`}
                          summaryItems={[`Project: ${projectId}`, `Zone: ${selectedInstance.zone}`, `Lifecycle: ${selectedStatus}`]}
                          onConfirm={() => void runMutation('reset')}
                        >
                          {mutationLoading === 'reset' ? 'Resetting...' : 'Reset'}
                        </ConfirmButton>
                        <ConfirmButton
                          className="ec2-action-btn"
                          disabled={!actionAvailability.canSuspend || mutationLoading !== null}
                          confirmLabel="Confirm suspend"
                          confirmButtonLabel="Suspend instance"
                          modalTitle="Suspend Compute Engine instance"
                          modalBody={`Suspend ${selectedInstance.name} in ${selectedInstance.zone}? Memory state will be preserved, but the instance will stop serving traffic until resumed.`}
                          summaryItems={[`Project: ${projectId}`, `Zone: ${selectedInstance.zone}`, `Lifecycle: ${selectedStatus}`]}
                          onConfirm={() => void runMutation('suspend')}
                        >
                          {mutationLoading === 'suspend' ? 'Suspending...' : 'Suspend'}
                        </ConfirmButton>
                        <button className="ec2-action-btn" type="button" disabled={!actionAvailability.canResume || mutationLoading !== null} onClick={() => void runMutation('resume')}>
                          {mutationLoading === 'resume' ? 'Resuming...' : 'Resume'}
                        </button>
                        <ConfirmButton
                          className="ec2-action-btn remove"
                          disabled={mutationLoading !== null}
                          confirmLabel="Delete?"
                          confirmPhrase={selectedInstance.name}
                          confirmButtonLabel="Delete instance"
                          modalTitle="Delete Compute Engine instance"
                          modalBody={`Delete ${selectedInstance.name} in ${selectedInstance.zone}. Attached resources configured for auto-delete will also be removed.`}
                          summaryItems={[`Project: ${projectId}`, `Zone: ${selectedInstance.zone}`, `Lifecycle: ${selectedStatus}`]}
                          onConfirm={() => void runMutation('delete')}
                        >
                          {mutationLoading === 'delete' ? 'Deleting...' : 'Delete'}
                        </ConfirmButton>
                      </div>
                    </div>

                    <div className="ec2-sidebar-section">
                      <h3>Overview</h3>
                      {detailLoading ? <SvcState variant="loading" message="Loading instance detail..." compact /> : null}
                      {detailError ? <SvcState variant="error" error={detailError} compact /> : null}
                      <div className="ec2-kv">
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Lifecycle</span><span className="ec2-kv-value"><span className={`ec2-badge ${computeStatusBadgeClass(selectedStatus)}`}>{selectedStatus}</span></span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Zone</span><span className="ec2-kv-value">{selectedZone}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Machine Type</span><span className="ec2-kv-value">{selectedMachine}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">CPU Platform</span><span className="ec2-kv-value">{detail?.cpuPlatform || '-'}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Internal IP</span><span className="ec2-kv-value">{selectedInternalIp}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">External IP</span><span className="ec2-kv-value">{selectedExternalIp || 'Private only'}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Service Account</span><span className="ec2-kv-value">{detail?.serviceAccounts[0]?.email || 'No service account'}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Scheduling</span><span className="ec2-kv-value">{detail?.scheduling || '-'}</span></div>
                      </div>
                    </div>

                    <div className="ec2-sidebar-section">
                      <h3>Risk Notes</h3>
                      <div className="gcp-runtime-chip-row">
                        {instanceRiskNotes(selectedInstance).map((note) => (
                          <span key={note.label} className={`signal-badge ${riskTone(note.tone)}`}>{note.label}</span>
                        ))}
                        {detail?.deletionProtection ? <span className="signal-badge severity-low">Deletion protection enabled</span> : null}
                        {detail?.shieldedSecureBoot ? <span className="signal-badge severity-low">Shielded secure boot</span> : null}
                        {detail?.shieldedIntegrityMonitoring ? <span className="signal-badge severity-low">Integrity monitoring</span> : null}
                      </div>
                    </div>

                    <div className="ec2-sidebar-section">
                      <h3>Resize Instance</h3>
                      <div className="ec2-sidebar-hint">{selectedStatus === 'RUNNING' ? 'Running instances will be stopped and restarted automatically to apply the new machine type.' : 'Machine type changes are applied while the instance is stopped.'}</div>
                      <div className="gcp-runtime-form-grid gcp-ec2-inline-form">
                        <label className="ec2-filter-field">
                          <span className="ec2-filter-label">Machine Type</span>
                          <select className="ec2-select" value={resizeTarget} onChange={(event) => setResizeTarget(event.target.value)} disabled={machineTypesLoading || mutationLoading !== null}>
                            {(machineTypes.length ? machineTypes : [{ name: selectedMachine, guestCpus: 0, memoryMb: 0, description: '', isSharedCpu: false }]).map((option) => (
                              <option key={option.name} value={option.name}>{option.name}</option>
                            ))}
                          </select>
                        </label>
                        {selectedStatus === 'RUNNING' ? (
                          <ConfirmButton
                            className="ec2-action-btn apply"
                            disabled={!actionAvailability.canResize || !resizeTarget || resizeTarget === selectedMachine || mutationLoading !== null}
                            confirmLabel="Confirm resize"
                            confirmButtonLabel="Stop, resize, restart"
                            modalTitle="Resize Compute Engine instance"
                            modalBody={`Resize ${selectedInstance.name} from ${selectedMachine} to ${resizeTarget}? The instance will be stopped, reconfigured, and restarted automatically. Workloads will be interrupted during the resize.`}
                            summaryItems={[`Project: ${projectId}`, `Zone: ${selectedInstance.zone}`, `Lifecycle: ${selectedStatus}`, `Target: ${resizeTarget}`]}
                            onConfirm={() => void runMutation('resize')}
                          >
                            {mutationLoading === 'resize' ? 'Applying...' : 'Apply resize'}
                          </ConfirmButton>
                        ) : (
                          <button type="button" className="ec2-action-btn apply" disabled={!actionAvailability.canResize || !resizeTarget || resizeTarget === selectedMachine || mutationLoading !== null} onClick={() => void runMutation('resize')}>
                            {mutationLoading === 'resize' ? 'Applying...' : 'Apply resize'}
                          </button>
                        )}
                      </div>
                      <div className="gcp-runtime-chip-row">
                        <span className="signal-badge severity-low">Current: {selectedMachine}</span>
                        {selectedMachineType ? <span className="signal-badge severity-low">{selectedMachineType.guestCpus} vCPU</span> : null}
                        {selectedMachineType ? <span className="signal-badge severity-low">{formatMemoryMb(selectedMachineType.memoryMb)}</span> : null}
                        {selectedMachineType?.isSharedCpu ? <span className="signal-badge severity-medium">Shared CPU</span> : null}
                      </div>
                      {machineTypesError ? <SvcState variant="error" error={machineTypesError} compact /> : null}
                    </div>

                    <div className="ec2-sidebar-section">
                      <h3>Edit Labels</h3>
                      <textarea className="gcp-runtime-textarea gcp-ec2-textarea" value={labelEditor} onChange={(event) => setLabelEditor(event.target.value)} placeholder={'owner=platform\nenvironment=prod'} />
                      <div className="ec2-actions-grid gcp-ec2-secondary-actions">
                        <button type="button" className="ec2-action-btn apply" disabled={mutationLoading !== null || labelEditor.trim() === formatLabelEditor(detail?.labels ?? [])} onClick={() => void runMutation('labels')}>
                          {mutationLoading === 'labels' ? 'Saving...' : 'Save labels'}
                        </button>
                        <button type="button" className="ec2-action-btn" disabled={mutationLoading !== null} onClick={() => setLabelEditor(formatLabelEditor(detail?.labels ?? []))}>
                          Reset editor
                        </button>
                      </div>
                    </div>

                    <div className="ec2-sidebar-section">
                      <h3>Recommendations</h3>
                      <div className="gcp-runtime-chip-row">
                        {recommendations.map((entry) => (
                          <span key={entry.title} className={`signal-badge ${riskTone(entry.tone)}`}>{entry.title}</span>
                        ))}
                      </div>
                    </div>

                    <div className="ec2-sidebar-section">
                      <h3>Fleet Hotspots</h3>
                      <div className="ec2-kv">
                        {fleetHotspots.map((zone) => (
                          <div key={zone.label} className="ec2-kv-row">
                            <span className="ec2-kv-label">{zone.label}</span>
                            <span className="ec2-kv-value">{zone.count}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {showDescribe ? (
                      <div className="ec2-sidebar-section">
                        <div className="gcp-ec2-section-head">
                          <h3>Describe Output</h3>
                          <button className="ec2-action-btn" type="button" onClick={() => setShowDescribe(false)}>Close</button>
                        </div>
                        <pre className="gcp-runtime-code-block gcp-runtime-serial-block">
                          {[
                            `Name: ${selectedInstance.name}`,
                            `Zone: ${selectedZone}`,
                            `Machine type: ${selectedMachine}`,
                            `CPU platform: ${detail?.cpuPlatform || '-'}`,
                            `Scheduling: ${detail?.scheduling || '-'}`,
                            `Service accounts: ${detail?.serviceAccounts.map((entry) => entry.email).join(', ') || '-'}`,
                            `Tags: ${detail?.tags.join(', ') || '-'}`,
                            `Metadata keys: ${detail?.metadata.map((entry) => entry.key).join(', ') || '-'}`
                          ].join('\n')}
                        </pre>
                      </div>
                    ) : null}

                    {mutationError ? (
                      <div className="ec2-sidebar-section">
                        <SvcState variant="error" error={mutationError} compact />
                      </div>
                    ) : null}
                  </>
                ) : sideTab === 'timeline' ? (
                  <>
                    <div className="ec2-sidebar-section">
                      <div className="ec2-timeline-controls">
                        <label>
                          From
                          <input type="date" value={timelineStart} onChange={(event) => setTimelineStart(event.target.value)} />
                        </label>
                        <label>
                          To
                          <input type="date" value={timelineEnd} onChange={(event) => setTimelineEnd(event.target.value)} />
                        </label>
                      </div>
                      {detailLoading ? <SvcState variant="loading" message="Loading timeline anchors..." compact /> : null}
                      {!detailLoading && !filteredTimelineEntries.length ? (
                        <SvcState variant="empty" message="No change events matched the selected timeline window." compact />
                      ) : null}
                      {!detailLoading && filteredTimelineEntries.length > 0 ? (
                        <div className="ec2-timeline-table-wrap">
                          <table className="ec2-timeline-table">
                            <thead>
                              <tr>
                                <th>Event</th>
                                <th>Actor</th>
                                <th>Date</th>
                              </tr>
                            </thead>
                            <tbody>
                              {filteredTimelineEntries.map((entry) => (
                                <tr key={entry.id}>
                                  <td title={entry.detail}>{entry.title}</td>
                                  <td>{entry.actor}</td>
                                  <td>{formatDateTime(entry.at)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                    </div>
                    <div className="ec2-sidebar-section">
                      <h3>Timeline Notes</h3>
                      <div className="ec2-sidebar-hint">This timeline is built from instance lifecycle timestamps and actions triggered from this app session.</div>
                      <div className="ec2-kv">
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Created</span><span className="ec2-kv-value">{detail?.creationTimestamp ? formatDateTime(detail.creationTimestamp) : '-'}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Last Start</span><span className="ec2-kv-value">{detail?.lastStartTimestamp ? formatDateTime(detail.lastStartTimestamp) : '-'}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Last Stop</span><span className="ec2-kv-value">{detail?.lastStopTimestamp ? formatDateTime(detail.lastStopTimestamp) : '-'}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Session Events</span><span className="ec2-kv-value">{runtimeTimeline.length}</span></div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ec2-sidebar-section">
                      <h3>Serial Output</h3>
                      <div className="ec2-sidebar-hint">Use serial logs for boot debugging, startup script inspection, and low-level console recovery.</div>
                      <div className="ec2-actions-grid gcp-ec2-secondary-actions">
                        <button type="button" className="ec2-action-btn apply" disabled={serialLoading} onClick={() => void loadSerialOutputView(0)}>
                          {serialLoading ? 'Loading...' : 'Reload from start'}
                        </button>
                        <button type="button" className="ec2-action-btn" disabled={serialLoading || !serialOutput?.nextStart} onClick={() => void loadSerialOutputView(serialOutput?.nextStart ?? 0)}>
                          Load more
                        </button>
                      </div>
                      {serialError ? <SvcState variant="error" error={serialError} compact /> : null}
                      <pre className="gcp-runtime-code-block gcp-runtime-serial-block">{serialOutput?.contents || 'Serial output has not been loaded yet.'}</pre>
                    </div>

                    <div className="ec2-sidebar-section">
                      <h3>Cursor</h3>
                      <div className="ec2-kv">
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Port</span><span className="ec2-kv-value">{serialOutput?.port ?? 1}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Next Start</span><span className="ec2-kv-value">{serialOutput?.nextStart ?? 'Unavailable'}</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Buffered Output</span><span className="ec2-kv-value">{serialOutput?.contents.length ?? 0} chars</span></div>
                        <div className="ec2-kv-row"><span className="ec2-kv-label">Instance</span><span className="ec2-kv-value">{selectedInstance.name}</span></div>
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="ec2-sidebar-section">
                <SvcState variant="no-selection" message="Select an instance to inspect posture and run in-app Compute Engine actions." compact />
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}

function GcpComputeEngineConsolePageLegacy({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const [instances, setInstances] = useState<GcpComputeInstanceSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped' | 'public' | 'private'>('all')
  const [sideTab, setSideTab] = useState<GcpCloudSqlSideTab>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')
  const [message, setMessage] = useState('')
  const [activeAction, setActiveAction] = useState<GcpCloudSqlActionKind | null>(null)
  const [actionLoading, setActionLoading] = useState<GcpCloudSqlActionKind | null>(null)
  const [actionError, setActionError] = useState('')
  const [instanceDetail, setInstanceDetail] = useState<GcpSqlInstanceDetail | null>(null)
  const [databases, setDatabases] = useState<GcpSqlDatabaseSummary[]>([])
  const [operations, setOperations] = useState<GcpSqlOperationSummary[]>([])
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  async function loadInventory(trigger: RefreshReason = 'initial'): Promise<void> {
    beginRefresh(trigger)
    setLoading(true)
    setError('')

    try {
      const nextInstances = await listGcpComputeInstances(projectId, location)
      setInstances(nextInstances)
      setSelectedName((current) => current && nextInstances.some((instance) => instance.name === current) ? current : (nextInstances[0]?.name ?? ''))
      setLastLoadedAt(new Date().toISOString())
      completeRefresh()
    } catch (err) {
      setInstances([])
      setSelectedName('')
      setError(err instanceof Error ? err.message : String(err))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadInventory()
  }, [location, projectId, refreshNonce])

  const filteredInstances = useMemo(() => {
    const query = search.trim().toLowerCase()

    return instances.filter((instance) => {
      if (statusFilter === 'running' && instance.status.trim().toUpperCase() !== 'RUNNING') return false
      if (statusFilter === 'stopped' && instance.status.trim().toUpperCase() === 'RUNNING') return false
      if (statusFilter === 'public' && !instance.externalIp) return false
      if (statusFilter === 'private' && Boolean(instance.externalIp)) return false
      if (!query) return true

      return [
        instance.name,
        instance.zone,
        instance.status,
        instance.machineType,
        instance.internalIp,
        instance.externalIp
      ].join(' ').toLowerCase().includes(query)
    })
  }, [instances, search, statusFilter])

  const selectedInstance = useMemo(
    () => filteredInstances.find((instance) => instance.name === selectedName)
      ?? instances.find((instance) => instance.name === selectedName)
      ?? filteredInstances[0]
      ?? instances[0]
      ?? null,
    [filteredInstances, instances, selectedName]
  )

  useEffect(() => {
    if (selectedInstance && selectedInstance.name !== selectedName) {
      setSelectedName(selectedInstance.name)
    }
  }, [selectedInstance, selectedName])

  useEffect(() => {
    setSideTab('overview')
    setActionError('')
    setInstanceDetail(null)
    setDatabases([])
    setOperations([])
  }, [selectedInstance?.name])

  async function loadInstanceAction(kind: GcpCloudSqlActionKind): Promise<void> {
    if (!selectedInstance) {
      return
    }

    const instanceName = selectedInstance.name
    setActionLoading(kind)
    setActionError('')
    setMessage('')

    try {
      if (kind === 'describe') {
        setInstanceDetail(await getGcpSqlInstanceDetail(projectId, instanceName))
        setMessage(`Loaded instance detail for ${instanceName}.`)
        return
      }

      if (kind === 'databases') {
        setDatabases(await listGcpSqlDatabases(projectId, instanceName))
        setMessage(`Loaded database inventory for ${instanceName}.`)
        return
      }

      setOperations(await listGcpSqlOperations(projectId, instanceName))
      setMessage(`Loaded recent operations for ${instanceName}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(null)
    }
  }

  useEffect(() => {
    if (selectedInstance && !instanceDetail && actionLoading !== 'describe') {
      void loadInstanceAction('describe')
    }
  }, [selectedInstance?.name, instanceDetail, actionLoading])

  useEffect(() => {
    if (!selectedInstance) {
      return
    }

    if (sideTab === 'databases' && !databases.length && actionLoading !== 'databases') {
      void loadInstanceAction('databases')
    }

    if (sideTab === 'operations' && !operations.length && actionLoading !== 'operations') {
      void loadInstanceAction('operations')
    }
  }, [sideTab, databases.length, operations.length, actionLoading, selectedInstance?.name])

  const locationLabel = location.trim() || 'all locations'
  const runningCount = countBy(instances, (instance) => instance.status.trim().toUpperCase() === 'RUNNING')
  const publicCount = countBy(instances, (instance) => Boolean(instance.externalIp))
  const privateOnlyCount = countBy(instances, (instance) => !instance.externalIp)
  const zoneSpread = uniq(instances.map((instance) => instance.zone))
  const fleetHotspots = mapCounts(instances.map((instance) => instance.zone)).slice(0, 4)
  const enableAction = error ? getGcpApiEnableAction(
    error,
    `gcloud services enable compute.googleapis.com --project ${projectId}`,
    `Compute Engine API is disabled for project ${projectId}.`
  ) : null

  return (
    <div className="overview-surface gcp-runtime-console gcp-runtime-console-compute">
      {message ? <div className="success-banner">{message}</div> : null}
      {error ? (
        <section className="panel stack">
          {enableAction ? (
            <div className="error-banner gcp-enable-error-banner">
              <div className="gcp-enable-error-copy">
                <strong>{enableAction.summary}</strong>
                <p>Enable the API once, wait for propagation, then refresh the inventory.</p>
              </div>
              <pre className="gcp-runtime-code-block">{enableAction.command}</pre>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      <section className="overview-hero-card gcp-runtime-hero-card">
        <div className="overview-hero-copy">
          <div className="eyebrow">Compute Engine</div>
          <h3>{projectId}</h3>
          <p>Operator view for fleet posture, public exposure, per-instance drill-in, and `gcloud` handoff from the shared Google Cloud context.</p>
          <div className="overview-meta-strip">
            <div className="overview-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Selected instance</span>
              <strong>{selectedInstance?.name || 'None selected'}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Last sync</span>
              <strong>{loading ? 'Syncing...' : formatTime(lastLoadedAt)}</strong>
            </div>
          </div>
        </div>
        <div className="overview-hero-stats">
          <div className="overview-glance-card overview-glance-card-accent">
            <span>Total instances</span>
            <strong>{instances.length}</strong>
            <small>Fleet items in the selected location slice</small>
          </div>
          <div className="overview-glance-card">
            <span>Running</span>
            <strong>{runningCount}</strong>
            <small>Instances currently in `RUNNING` state</small>
          </div>
          <div className="overview-glance-card">
            <span>Public exposure</span>
            <strong>{publicCount}</strong>
            <small>Instances with an external IP attached</small>
          </div>
          <div className="overview-glance-card">
            <span>Zone spread</span>
            <strong>{zoneSpread}</strong>
            <small>Unique zones represented in this slice</small>
          </div>
        </div>
      </section>

      <section className="gcp-runtime-toolbar">
        <div className="gcp-runtime-toolbar-main">
          <button type="button" className="accent" disabled={loading} onClick={() => void loadInventory('manual')}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          <button
            type="button"
            disabled={!canRunTerminalCommand}
            onClick={() => runTerminalAction(
              canRunTerminalCommand,
              `gcloud compute instances list --project ${projectId} --format=json`,
              'Compute inventory command sent to the app terminal.',
              onRunTerminalCommand,
              setMessage
            )}
            title={canRunTerminalCommand ? `gcloud compute instances list --project ${projectId} --format=json` : 'Switch to Operator mode to enable terminal actions'}
          >
            List in terminal
          </button>
          <label className="field gcp-runtime-field">
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">All</option>
              <option value="running">Running</option>
              <option value="stopped">Non-running</option>
              <option value="public">Public IP</option>
              <option value="private">Private only</option>
            </select>
          </label>
          <label className="field gcp-runtime-field gcp-runtime-search">
            <span>Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, zone, IP, type" />
          </label>
        </div>
        <div className="gcp-runtime-toolbar-status">
          <FreshnessIndicator freshness={freshness} label="Compute inventory" staleLabel="Refresh inventory" />
        </div>
      </section>

      <section className="overview-tiles gcp-runtime-summary-grid">
        <div className="overview-tile highlight">
          <strong>{privateOnlyCount}</strong>
          <span>Private-only instances</span>
        </div>
        <div className="overview-tile">
          <strong>{instances.length - runningCount}</strong>
          <span>Non-running instances</span>
        </div>
        <div className="overview-tile">
          <strong>{fleetHotspots[0]?.label || '-'}</strong>
          <span>Most populated zone</span>
        </div>
        <div className="overview-tile">
          <strong>{selectedInstance?.machineType || '-'}</strong>
          <span>Selected machine type</span>
        </div>
      </section>

      {!loading && !instances.length && !error ? (
        <section className="panel stack">
          <SvcState variant="empty" message={`No Compute Engine instances were found for ${projectId} in ${locationLabel}.`} />
        </section>
      ) : null}

      {instances.length > 0 ? (
        <div className="gcp-runtime-layout">
          <section className="panel stack gcp-runtime-list-panel">
            <div className="panel-header">
              <h3>Instance inventory</h3>
              <span className="signal-region">{filteredInstances.length} shown</span>
            </div>
            <div className="gcp-runtime-list">
              {filteredInstances.map((instance) => (
                <button
                  key={`${instance.zone}:${instance.name}`}
                  type="button"
                  className={`gcp-runtime-card ${selectedInstance?.name === instance.name ? 'active' : ''}`}
                  onClick={() => setSelectedName(instance.name)}
                >
                  <div className="gcp-runtime-card-top">
                    <div className="gcp-runtime-card-copy">
                      <strong>{instance.name}</strong>
                      <span>{instance.machineType || 'Machine type unavailable'}</span>
                    </div>
                    <span className={`signal-badge ${instance.status.trim().toUpperCase() === 'RUNNING' ? 'severity-low' : 'severity-medium'}`}>
                      {instance.status || 'UNKNOWN'}
                    </span>
                  </div>
                  <div className="gcp-runtime-card-meta">
                    <span>{instance.zone || 'Unknown zone'}</span>
                    <span>{instance.internalIp || 'No internal IP'}</span>
                    <span>{instance.externalIp || 'Private only'}</span>
                  </div>
                </button>
              ))}
              {!filteredInstances.length ? <SvcState variant="no-filter-matches" resourceName="instances" compact /> : null}
            </div>
          </section>

          <section className="panel stack gcp-runtime-detail-panel">
            <div className="panel-header">
              <h3>{selectedInstance?.name || 'Instance detail'}</h3>
              {selectedInstance ? <span className="signal-region">{selectedInstance.zone}</span> : null}
            </div>

            {selectedInstance ? (
              <>
                <div className="gcp-runtime-detail-grid">
                  <div className="gcp-runtime-detail-card">
                    <span>Lifecycle</span>
                    <strong>{selectedInstance.status || 'UNKNOWN'}</strong>
                    <small>{selectedInstance.machineType || 'Machine type unavailable'}</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Internal IP</span>
                    <strong>{selectedInstance.internalIp || '-'}</strong>
                    <small>Primary NIC inside the VPC slice</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>External IP</span>
                    <strong>{selectedInstance.externalIp || 'None'}</strong>
                    <small>{selectedInstance.externalIp ? 'Publicly reachable address attached' : 'No public address attached'}</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Zone</span>
                    <strong>{selectedInstance.zone || '-'}</strong>
                    <small>Placement scope from the current inventory slice</small>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Risk notes</h3>
                  </div>
                  <div className="gcp-runtime-chip-row">
                    {instanceRiskNotes(selectedInstance).map((note) => (
                      <span key={note.label} className={`signal-badge ${riskTone(note.tone)}`}>{note.label}</span>
                    ))}
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Terminal handoff</h3>
                  </div>
                  <div className="gcp-runtime-action-grid">
                    <button
                      type="button"
                      className="accent"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud compute instances describe ${selectedInstance.name} --project ${projectId} --zone ${selectedInstance.zone} --format=json`,
                        `Describe command sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Describe instance
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand || selectedInstance.status.trim().toUpperCase() !== 'RUNNING'}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud compute ssh ${selectedInstance.name} --project ${projectId} --zone ${selectedInstance.zone}`,
                        `SSH handoff sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      SSH handoff
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud compute instances get-serial-port-output ${selectedInstance.name} --project ${projectId} --zone ${selectedInstance.zone} --port=1`,
                        `Serial output command sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Serial output
                    </button>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Fleet hotspots</h3>
                  </div>
                  <div className="gcp-runtime-distribution-list">
                    {fleetHotspots.map((zone) => (
                      <div key={zone.label} className="gcp-runtime-distribution-item">
                        <span>{zone.label}</span>
                        <strong>{zone.count}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <SvcState variant="no-selection" message="Select an instance to inspect posture and operator handoff actions." />
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}

export function GcpGkeConsolePage({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const [clusters, setClusters] = useState<GcpGkeClusterSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'non-running' | 'rapid' | 'unspecified'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [clusterDetail, setClusterDetail] = useState<GcpGkeClusterDetail | null>(null)
  const [nodePools, setNodePools] = useState<GcpGkeNodePoolSummary[] | null>(null)
  const [credentials, setCredentials] = useState<GcpGkeClusterCredentials | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [nodePoolsLoading, setNodePoolsLoading] = useState(false)
  const [credentialsLoading, setCredentialsLoading] = useState(false)
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  async function loadInventory(trigger: RefreshReason = 'initial'): Promise<void> {
    beginRefresh(trigger)
    setLoading(true)
    setError('')

    try {
      const nextClusters = await listGcpGkeClusters(projectId, location)
      setClusters(nextClusters)
      setSelectedName((current) => current && nextClusters.some((cluster) => cluster.name === current) ? current : (nextClusters[0]?.name ?? ''))
      setLastLoadedAt(new Date().toISOString())
      completeRefresh()
    } catch (err) {
      setClusters([])
      setSelectedName('')
      setError(err instanceof Error ? err.message : String(err))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadInventory()
  }, [location, projectId, refreshNonce])

  const filteredClusters = useMemo(() => {
    const query = search.trim().toLowerCase()

    return clusters.filter((cluster) => {
      const channel = cluster.releaseChannel.trim().toLowerCase() || 'unspecified'
      const isRunning = cluster.status.trim().toUpperCase() === 'RUNNING'

      if (statusFilter === 'running' && !isRunning) return false
      if (statusFilter === 'non-running' && isRunning) return false
      if (statusFilter === 'rapid' && channel !== 'rapid') return false
      if (statusFilter === 'unspecified' && channel !== 'unspecified') return false
      if (!query) return true

      return [
        cluster.name,
        cluster.location,
        cluster.status,
        cluster.masterVersion,
        cluster.releaseChannel,
        cluster.endpoint
      ].join(' ').toLowerCase().includes(query)
    })
  }, [clusters, search, statusFilter])

  const selectedCluster = useMemo(
    () => filteredClusters.find((cluster) => cluster.name === selectedName)
      ?? clusters.find((cluster) => cluster.name === selectedName)
      ?? filteredClusters[0]
      ?? clusters[0]
      ?? null,
    [clusters, filteredClusters, selectedName]
  )

  useEffect(() => {
    if (selectedCluster && selectedCluster.name !== selectedName) {
      setSelectedName(selectedCluster.name)
    }
  }, [selectedCluster, selectedName])

  useEffect(() => {
    setActionError('')
    setClusterDetail(null)
    setNodePools(null)
    setCredentials(null)
    setDetailLoading(false)
    setNodePoolsLoading(false)
    setCredentialsLoading(false)
  }, [projectId, selectedCluster?.location, selectedCluster?.name])

  async function copyText(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setMessage(`${label} copied.`)
      setActionError('')
    } catch {
      setActionError(`Unable to copy ${label.toLowerCase()}.`)
    }
  }

  async function loadClusterDetailAction(): Promise<void> {
    if (!selectedCluster) return

    setDetailLoading(true)
    setActionError('')
    try {
      const detail = await getGcpGkeClusterDetail(projectId, selectedCluster.location, selectedCluster.name)
      setClusterDetail(detail)
      setMessage(`Loaded cluster detail for ${selectedCluster.name}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetailLoading(false)
    }
  }

  async function loadNodePoolsAction(): Promise<void> {
    if (!selectedCluster) return

    setNodePoolsLoading(true)
    setActionError('')
    try {
      const pools = await listGcpGkeNodePools(projectId, selectedCluster.location, selectedCluster.name)
      setNodePools(pools)
      setMessage(`Loaded node pools for ${selectedCluster.name}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setNodePoolsLoading(false)
    }
  }

  async function loadCredentialsAction(): Promise<void> {
    if (!selectedCluster) return

    setCredentialsLoading(true)
    setActionError('')
    try {
      const nextCredentials = await getGcpGkeClusterCredentials(projectId, selectedCluster.location, selectedCluster.name)
      setCredentials(nextCredentials)
      setMessage(`Loaded short-lived credentials for ${selectedCluster.name}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setCredentialsLoading(false)
    }
  }

  const locationLabel = location.trim() || 'all locations'
  const runningCount = countBy(clusters, (cluster) => cluster.status.trim().toUpperCase() === 'RUNNING')
  const nonRunningCount = clusters.length - runningCount
  const releaseChannelSpread = uniq(clusters.map((cluster) => cluster.releaseChannel || 'unspecified'))
  const locationSpread = uniq(clusters.map((cluster) => cluster.location))
  const versionSpread = uniq(clusters.map((cluster) => cluster.masterVersion))
  const locationHotspots = mapCounts(clusters.map((cluster) => cluster.location)).slice(0, 4)
  const enableAction = error ? getGcpApiEnableAction(
    error,
    `gcloud services enable container.googleapis.com --project ${projectId}`,
    `GKE API is disabled for project ${projectId}.`
  ) : null

  return (
    <div className="overview-surface gcp-runtime-console gcp-runtime-console-gke">
      {message ? <div className="success-banner">{message}</div> : null}
      {error ? (
        <section className="panel stack">
          {enableAction ? (
            <div className="error-banner gcp-enable-error-banner">
              <div className="gcp-enable-error-copy">
                <strong>{enableAction.summary}</strong>
                <p>
                  {canRunTerminalCommand
                    ? 'Run the enable command in the terminal, wait for propagation, then refresh the inventory.'
                    : 'Switch Settings > Access Mode to Operator to enable terminal actions for this command.'}
                </p>
              </div>
              <div className="gcp-enable-error-actions">
                <button
                  type="button"
                  className="accent"
                  disabled={!canRunTerminalCommand}
                  onClick={() => runTerminalAction(
                    canRunTerminalCommand,
                    enableAction.command,
                    'Enable command sent to the app terminal.',
                    onRunTerminalCommand,
                    setMessage
                  )}
                  title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode to enable terminal actions'}
                >
                  Run enable command
                </button>
              </div>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      <section className="overview-hero-card gcp-runtime-hero-card">
        <div className="overview-hero-copy">
          <div className="eyebrow">GKE</div>
          <h3>{projectId}</h3>
          <p>Cluster posture view for release channels, version spread, selected-cluster drill-in, and SDK-backed access details from the shared Google Cloud context.</p>
          <div className="overview-meta-strip">
            <div className="overview-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Selected cluster</span>
              <strong>{selectedCluster?.name || 'None selected'}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Last sync</span>
              <strong>{loading ? 'Syncing...' : formatTime(lastLoadedAt)}</strong>
            </div>
          </div>
        </div>
        <div className="overview-hero-stats">
          <div className="overview-glance-card overview-glance-card-accent">
            <span>Total clusters</span>
            <strong>{clusters.length}</strong>
            <small>Clusters in the selected location slice</small>
          </div>
          <div className="overview-glance-card">
            <span>Healthy</span>
            <strong>{runningCount}</strong>
            <small>Clusters currently in `RUNNING` state</small>
          </div>
          <div className="overview-glance-card">
            <span>Release channels</span>
            <strong>{releaseChannelSpread}</strong>
            <small>Unique channels represented in this slice</small>
          </div>
          <div className="overview-glance-card">
            <span>Version spread</span>
            <strong>{versionSpread}</strong>
            <small>Distinct control-plane versions surfaced</small>
          </div>
        </div>
      </section>

      <section className="gcp-runtime-toolbar">
        <div className="gcp-runtime-toolbar-main">
          <button type="button" className="accent" disabled={loading} onClick={() => void loadInventory('manual')}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          <button
            type="button"
            disabled={!canRunTerminalCommand}
            onClick={() => runTerminalAction(
              canRunTerminalCommand,
              `gcloud container clusters list --project ${projectId} --format=json`,
              'GKE inventory command sent to the app terminal.',
              onRunTerminalCommand,
              setMessage
            )}
            title={canRunTerminalCommand ? `gcloud container clusters list --project ${projectId} --format=json` : 'Switch to Operator mode to enable terminal actions'}
          >
            List in terminal
          </button>
          <label className="field gcp-runtime-field">
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">All</option>
              <option value="running">Running</option>
              <option value="non-running">Non-running</option>
              <option value="rapid">Rapid channel</option>
              <option value="unspecified">Unspecified channel</option>
            </select>
          </label>
          <label className="field gcp-runtime-field gcp-runtime-search">
            <span>Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, location, version, endpoint" />
          </label>
        </div>
        <div className="gcp-runtime-toolbar-status">
          <FreshnessIndicator freshness={freshness} label="GKE inventory" staleLabel="Refresh inventory" />
        </div>
      </section>

      <section className="overview-tiles gcp-runtime-summary-grid">
        <div className="overview-tile highlight">
          <strong>{nonRunningCount}</strong>
          <span>Non-running clusters</span>
        </div>
        <div className="overview-tile">
          <strong>{locationSpread}</strong>
          <span>Cluster locations</span>
        </div>
        <div className="overview-tile">
          <strong>{selectedCluster?.releaseChannel || 'unspecified'}</strong>
          <span>Selected release channel</span>
        </div>
        <div className="overview-tile">
          <strong>{selectedCluster?.masterVersion || '-'}</strong>
          <span>Selected control-plane version</span>
        </div>
      </section>

      {!loading && !clusters.length && !error ? (
        <section className="panel stack">
          <SvcState variant="empty" message={`No GKE clusters were found for ${projectId} in ${locationLabel}.`} />
        </section>
      ) : null}

      {clusters.length > 0 ? (
        <div className="gcp-runtime-layout">
          <section className="panel stack gcp-runtime-list-panel">
            <div className="panel-header">
              <h3>Cluster inventory</h3>
              <span className="signal-region">{filteredClusters.length} shown</span>
            </div>
            <div className="gcp-runtime-list">
              {filteredClusters.map((cluster) => (
                <button
                  key={`${cluster.location}:${cluster.name}`}
                  type="button"
                  className={`gcp-runtime-card ${selectedCluster?.name === cluster.name ? 'active' : ''}`}
                  onClick={() => setSelectedName(cluster.name)}
                >
                  <div className="gcp-runtime-card-top">
                    <div className="gcp-runtime-card-copy">
                      <strong>{cluster.name}</strong>
                      <span>{cluster.masterVersion ? `Master ${cluster.masterVersion}` : 'Master version unavailable'}</span>
                    </div>
                    <span className={`signal-badge ${cluster.status.trim().toUpperCase() === 'RUNNING' ? 'severity-low' : 'severity-high'}`}>
                      {cluster.status || 'UNKNOWN'}
                    </span>
                  </div>
                  <div className="gcp-runtime-card-meta">
                    <span>{cluster.location || 'Unknown location'}</span>
                    <span>{cluster.releaseChannel || 'unspecified'}</span>
                    <span>{cluster.nodeCount || '0'} nodes</span>
                  </div>
                </button>
              ))}
              {!filteredClusters.length ? <SvcState variant="no-filter-matches" resourceName="clusters" compact /> : null}
            </div>
          </section>

          <section className="panel stack gcp-runtime-detail-panel">
            <div className="panel-header">
              <h3>{selectedCluster?.name || 'Cluster detail'}</h3>
              {selectedCluster ? <span className="signal-region">{selectedCluster.location}</span> : null}
            </div>

            {selectedCluster ? (
              <>
                <div className="gcp-runtime-detail-grid">
                  <div className="gcp-runtime-detail-card">
                    <span>Lifecycle</span>
                    <strong>{selectedCluster.status || 'UNKNOWN'}</strong>
                    <small>{selectedCluster.nodeCount || '0'} node count reported by inventory</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Master version</span>
                    <strong>{selectedCluster.masterVersion || '-'}</strong>
                    <small>Control-plane version from current inventory</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Release channel</span>
                    <strong>{selectedCluster.releaseChannel || 'unspecified'}</strong>
                    <small>Upgrade track currently assigned to the cluster</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Endpoint</span>
                    <strong>{selectedCluster.endpoint || 'Unavailable'}</strong>
                    <small>Cluster API endpoint currently surfaced by inventory</small>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Risk notes</h3>
                  </div>
                  <div className="gcp-runtime-chip-row">
                    {clusterRiskNotes(selectedCluster).map((note) => (
                      <span key={note.label} className={`signal-badge ${riskTone(note.tone)}`}>{note.label}</span>
                    ))}
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Cluster actions</h3>
                  </div>
                  <div className="gcp-runtime-action-grid">
                    <button
                      type="button"
                      className="accent"
                      disabled={detailLoading}
                      onClick={() => void loadClusterDetailAction()}
                    >
                      {detailLoading ? 'Loading detail...' : 'Describe cluster'}
                    </button>
                    <button
                      type="button"
                      disabled={credentialsLoading}
                      onClick={() => void loadCredentialsAction()}
                    >
                      {credentialsLoading ? 'Loading credentials...' : 'Get credentials'}
                    </button>
                    <button
                      type="button"
                      disabled={nodePoolsLoading}
                      onClick={() => void loadNodePoolsAction()}
                    >
                      {nodePoolsLoading ? 'Loading node pools...' : 'List node pools'}
                    </button>
                  </div>
                </div>

                {actionError ? (
                  <div className="gcp-runtime-section">
                    <SvcState variant="error" error={actionError} />
                  </div>
                ) : null}

                {clusterDetail ? (
                  <div className="gcp-runtime-section">
                    <div className="panel-header minor">
                      <h3>Cluster detail</h3>
                    </div>
                    <div className="gcp-runtime-detail-grid">
                      <div className="gcp-runtime-detail-card">
                        <span>Node version</span>
                        <strong>{clusterDetail.nodeVersion || '-'}</strong>
                        <small>Latest node version surfaced by the Container API</small>
                      </div>
                      <div className="gcp-runtime-detail-card">
                        <span>Node pools</span>
                        <strong>{clusterDetail.nodePoolCount}</strong>
                        <small>{clusterDetail.currentNodeCount} current nodes reported across the cluster</small>
                      </div>
                      <div className="gcp-runtime-detail-card">
                        <span>Networking</span>
                        <strong>{clusterDetail.network || 'Default / unavailable'}</strong>
                        <small>{clusterDetail.subnetwork || 'Subnetwork unavailable'}</small>
                      </div>
                      <div className="gcp-runtime-detail-card">
                        <span>Workload identity</span>
                        <strong>{clusterDetail.workloadIdentityPool || 'Disabled / unavailable'}</strong>
                        <small>Workload pool currently configured for pods and nodes</small>
                      </div>
                    </div>
                    <div className="gcp-runtime-facts-grid">
                      <div className="gcp-runtime-fact"><span>Autopilot</span><strong>{clusterDetail.autopilotEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                      <div className="gcp-runtime-fact"><span>Private cluster</span><strong>{clusterDetail.privateClusterEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                      <div className="gcp-runtime-fact"><span>Shielded nodes</span><strong>{clusterDetail.shieldedNodesEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                      <div className="gcp-runtime-fact"><span>Vertical pod autoscaling</span><strong>{clusterDetail.verticalPodAutoscalingEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                      <div className="gcp-runtime-fact"><span>Cluster CIDR</span><strong>{clusterDetail.clusterIpv4Cidr || '-'}</strong></div>
                      <div className="gcp-runtime-fact"><span>Service CIDR</span><strong>{clusterDetail.servicesIpv4Cidr || '-'}</strong></div>
                      <div className="gcp-runtime-fact"><span>Control plane CIDR</span><strong>{clusterDetail.controlPlaneIpv4Cidr || '-'}</strong></div>
                      <div className="gcp-runtime-fact"><span>Logging / Monitoring</span><strong>{[clusterDetail.loggingService, clusterDetail.monitoringService].filter(Boolean).join(' / ') || '-'}</strong></div>
                    </div>
                    {Object.keys(clusterDetail.resourceLabels).length ? (
                      <div className="gcp-runtime-label-grid">
                        {Object.entries(clusterDetail.resourceLabels).map(([key, value]) => (
                          <span key={key} className="gcp-runtime-label-chip">{key}={value}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {nodePools ? (
                  <div className="gcp-runtime-section">
                    <div className="panel-header minor">
                      <h3>Node pools</h3>
                    </div>
                    {nodePools.length ? (
                      <div className="gcp-runtime-node-pool-list">
                        {nodePools.map((pool) => (
                          <div key={pool.name} className="gcp-runtime-node-pool-card">
                            <div className="gcp-runtime-node-pool-top">
                              <div>
                                <strong>{pool.name}</strong>
                                <span>{pool.machineType || 'Machine type unavailable'}</span>
                              </div>
                              <span className={`signal-badge ${pool.status.trim().toUpperCase() === 'RUNNING' ? 'severity-low' : 'severity-medium'}`}>
                                {pool.status || 'UNKNOWN'}
                              </span>
                            </div>
                            <div className="gcp-runtime-node-pool-meta">
                              <span>{pool.version || 'Version unavailable'}</span>
                              <span>{pool.nodeCount || 0} initial nodes</span>
                              <span>{pool.autoscaling === 'disabled' ? 'Autoscaling disabled' : `Autoscaling ${pool.autoscaling}`}</span>
                              <span>{pool.imageType || 'Image unavailable'}</span>
                              <span>{pool.diskSizeGb ? `${pool.diskSizeGb} GB disk` : 'Disk size unavailable'}</span>
                              <span>{pool.spotEnabled ? 'Spot' : pool.preemptible ? 'Preemptible' : 'Standard'}</span>
                              <span>{pool.locations.join(', ') || 'No explicit locations'}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <SvcState variant="empty" message="No node pools were returned for this cluster." />
                    )}
                  </div>
                ) : null}

                {credentials ? (
                  <div className="gcp-runtime-section">
                    <div className="panel-header minor">
                      <h3>Credentials</h3>
                    </div>
                    <div className="gcp-runtime-detail-grid">
                      <div className="gcp-runtime-detail-card">
                        <span>Context</span>
                        <strong>{credentials.contextName}</strong>
                        <small>Generated kubeconfig context name for this cluster</small>
                      </div>
                      <div className="gcp-runtime-detail-card">
                        <span>Auth provider</span>
                        <strong>{credentials.authProvider}</strong>
                        <small>{credentials.tokenExpiresAt ? `Token expires ${new Date(credentials.tokenExpiresAt).toLocaleString()}` : 'Token expiry was not returned by the auth client'}</small>
                      </div>
                      <div className="gcp-runtime-detail-card">
                        <span>Endpoint</span>
                        <strong>{credentials.endpoint}</strong>
                        <small>API server endpoint from the cluster control plane</small>
                      </div>
                      <div className="gcp-runtime-detail-card">
                        <span>Token preview</span>
                        <strong>{credentials.tokenPreview || '-'}</strong>
                        <small>Short-lived bearer token minted from the active ADC context</small>
                      </div>
                    </div>
                    <div className="gcp-runtime-inline-actions">
                      <button type="button" onClick={() => void copyText(credentials.bearerToken, 'Bearer token')}>Copy token</button>
                      <button type="button" onClick={() => void copyText(credentials.kubeconfigYaml, 'Kubeconfig')}>Copy kubeconfig</button>
                      <button type="button" onClick={() => void copyText(credentials.certificateAuthorityData, 'Cluster CA certificate')}>Copy cluster CA</button>
                    </div>
                    <p className="gcp-runtime-inline-note">
                      These credentials are generated from the current ADC session and are intended for short-lived operator access, not long-term kubeconfig persistence.
                    </p>
                    <pre className="gcp-runtime-code-block">{credentials.kubeconfigYaml}</pre>
                  </div>
                ) : null}

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Fleet hotspots</h3>
                  </div>
                  <div className="gcp-runtime-distribution-list">
                    {locationHotspots.map((item) => (
                      <div key={item.label} className="gcp-runtime-distribution-item">
                        <span>{item.label}</span>
                        <strong>{item.count}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <SvcState variant="no-selection" message="Select a cluster to inspect posture and load SDK-backed detail, credentials, and node pools." />
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}

export function GcpCloudSqlConsolePage({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand: _onRunTerminalCommand,
  canRunTerminalCommand: _canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const [instances, setInstances] = useState<GcpSqlInstanceSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'runnable' | 'non-runnable' | 'public' | 'ha'>('all')
  const [sideTab, setSideTab] = useState<GcpCloudSqlSideTab>('overview')
  const [visibleColumns, setVisibleColumns] = useState<Set<GcpCloudSqlColumnKey>>(
    () => new Set(GCP_CLOUD_SQL_COLUMNS.map((column) => column.key))
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')
  const [message, setMessage] = useState('')
  const [actionLoading, setActionLoading] = useState<GcpCloudSqlActionKind | null>(null)
  const [actionError, setActionError] = useState('')
  const [instanceDetail, setInstanceDetail] = useState<GcpSqlInstanceDetail | null>(null)
  const [databases, setDatabases] = useState<GcpSqlDatabaseSummary[]>([])
  const [operations, setOperations] = useState<GcpSqlOperationSummary[]>([])
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  async function loadInventory(trigger: RefreshReason = 'initial'): Promise<void> {
    beginRefresh(trigger)
    setLoading(true)
    setError('')

    try {
      const nextInstances = await listGcpSqlInstances(projectId, location)
      setInstances(nextInstances)
      setSelectedName((current) => current && nextInstances.some((instance) => instance.name === current) ? current : (nextInstances[0]?.name ?? ''))
      setLastLoadedAt(new Date().toISOString())
      completeRefresh()
    } catch (err) {
      setInstances([])
      setSelectedName('')
      setError(err instanceof Error ? err.message : String(err))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadInventory()
  }, [location, projectId, refreshNonce])

  const filteredInstances = useMemo(() => {
    const query = search.trim().toLowerCase()

    return instances.filter((instance) => {
      const isRunnable = isCloudSqlRunnable(instance)
      const isPublic = Boolean(instance.primaryAddress)
      const isHa = instance.availabilityType.trim().toUpperCase() === 'REGIONAL'

      if (statusFilter === 'runnable' && !isRunnable) return false
      if (statusFilter === 'non-runnable' && isRunnable) return false
      if (statusFilter === 'public' && !isPublic) return false
      if (statusFilter === 'ha' && !isHa) return false
      if (!query) return true

      return GCP_CLOUD_SQL_COLUMNS
        .filter((column) => visibleColumns.has(column.key))
        .some((column) => getCloudSqlColumnValue(instance, column.key).toLowerCase().includes(query))
    })
  }, [instances, search, statusFilter, visibleColumns])

  const selectedInstance = useMemo(
    () => filteredInstances.find((instance) => instance.name === selectedName)
      ?? instances.find((instance) => instance.name === selectedName)
      ?? filteredInstances[0]
      ?? instances[0]
      ?? null,
    [filteredInstances, instances, selectedName]
  )

  useEffect(() => {
    if (selectedInstance && selectedInstance.name !== selectedName) {
      setSelectedName(selectedInstance.name)
    }
  }, [selectedInstance, selectedName])

  useEffect(() => {
    setSideTab('overview')
    setActionError('')
    setInstanceDetail(null)
    setDatabases([])
    setOperations([])
  }, [selectedInstance?.name])

  async function loadInstanceAction(kind: GcpCloudSqlActionKind): Promise<void> {
    if (!selectedInstance) {
      return
    }

    const instanceName = selectedInstance.name
    setActionLoading(kind)
    setActionError('')
    setMessage('')

    try {
      if (kind === 'describe') {
        setInstanceDetail(await getGcpSqlInstanceDetail(projectId, instanceName))
        setMessage(`Loaded instance detail for ${instanceName}.`)
        return
      }

      if (kind === 'databases') {
        setDatabases(await listGcpSqlDatabases(projectId, instanceName))
        setMessage(`Loaded database inventory for ${instanceName}.`)
        return
      }

      setOperations(await listGcpSqlOperations(projectId, instanceName))
      setMessage(`Loaded recent operations for ${instanceName}.`)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionLoading(null)
    }
  }

  useEffect(() => {
    if (selectedInstance && !instanceDetail && actionLoading !== 'describe') {
      void loadInstanceAction('describe')
    }
  }, [selectedInstance?.name, instanceDetail, actionLoading])

  useEffect(() => {
    if (!selectedInstance) {
      return
    }

    if (sideTab === 'databases' && !databases.length && actionLoading !== 'databases') {
      void loadInstanceAction('databases')
    }

    if (sideTab === 'operations' && !operations.length && actionLoading !== 'operations') {
      void loadInstanceAction('operations')
    }
  }, [sideTab, databases.length, operations.length, actionLoading, selectedInstance?.name])

  const locationLabel = location.trim() || 'all locations'
  const runnableCount = countBy(instances, isCloudSqlRunnable)
  const publicCount = countBy(instances, (instance) => Boolean(instance.primaryAddress))
  const deletionProtectionCount = countBy(instances, (instance) => instance.deletionProtectionEnabled)
  const haCount = countBy(instances, (instance) => instance.availabilityType.trim().toUpperCase() === 'REGIONAL')
  const engineSpread = uniq(instances.map((instance) => instance.databaseVersion))
  const regionSpread = uniq(instances.map((instance) => instance.region))
  const inScopeCount = countBy(instances, (instance) => matchesLocationLens(instance, location))
  const regionHotspots = mapCounts(instances.map((instance) => instance.region)).slice(0, 4)
  const enableAction = error ? getGcpApiEnableAction(
    error,
    `gcloud services enable sqladmin.googleapis.com --project ${projectId}`,
    `Cloud SQL Admin API is disabled for project ${projectId}.`
  ) : null
  const activeColumns = GCP_CLOUD_SQL_COLUMNS.filter((column) => visibleColumns.has(column.key))
  const selectedRiskNotes = selectedInstance ? sqlRiskNotes(selectedInstance) : []
  const selectedFindings = selectedInstance ? [
    selectedInstance.primaryAddress
      ? {
          id: 'public-ip',
          title: 'Public endpoint is exposed',
          body: 'This instance advertises a public primary address. Review network path and client allowlists before using it as a shared operator target.',
          tone: 'risk' as GcpCloudSqlTone
        }
      : null,
    !selectedInstance.privateAddress
      ? {
          id: 'private-ip',
          title: 'Private connectivity is missing',
          body: 'The inventory did not return a private address. Internal-only workflows and VPC-routed access may be unavailable.',
          tone: 'warning' as GcpCloudSqlTone
        }
      : null,
    instanceDetail && !instanceDetail.backupEnabled
      ? {
          id: 'backup',
          title: 'Backups are disabled',
          body: 'Automated backups are currently turned off for this instance. Recovery posture is materially weaker until backups are re-enabled.',
          tone: 'risk' as GcpCloudSqlTone
        }
      : null,
    instanceDetail && !instanceDetail.pointInTimeRecoveryEnabled
      ? {
          id: 'pitr',
          title: 'Point-in-time recovery is unavailable',
          body: 'Recovery can only target backup boundaries. If workload sensitivity requires narrower recovery windows, enable PITR.',
          tone: 'warning' as GcpCloudSqlTone
        }
      : null,
    instanceDetail && instanceDetail.authorizedNetworks.length > 0
      ? {
          id: 'authorized-networks',
          title: 'Authorized networks are configured',
          body: 'Review the CIDR list for drift and confirm it still matches intended operator and application entry points.',
          tone: 'info' as GcpCloudSqlTone
        }
      : null
  ].filter(Boolean) as Array<{ id: string; title: string; body: string; tone: GcpCloudSqlTone }> : []
  const recommendations = selectedInstance ? [
    selectedInstance.deletionProtectionEnabled
      ? 'Deletion protection is enabled; keep this aligned with production retention policy.'
      : 'Enable deletion protection before using this instance as a high-value operator target.',
    selectedInstance.storageAutoResizeEnabled
      ? 'Storage auto-resize is on; confirm budget alerts cover silent capacity growth.'
      : 'Turn on storage auto-resize or add a stricter saturation alert path.',
    instanceDetail?.backupEnabled
      ? 'Backups are enabled; validate restore cadence and backup retention outside this panel.'
      : 'Backups are not enabled; recovery posture should be reviewed immediately.',
    instanceDetail?.connectorEnforcement
      ? `Connector enforcement is ${prettifyCloudSqlLabel(instanceDetail.connectorEnforcement)}; keep client connection paths consistent with that policy.`
      : 'No connector enforcement policy was returned; verify intended client entry path.',
    selectedInstance.maintenanceWindow
      ? `Maintenance is scheduled for ${selectedInstance.maintenanceWindow}.`
      : 'No maintenance window is configured; define one to reduce surprise restarts.'
  ] : []
  const messageTone = message.toLowerCase().includes('failed') || message.toLowerCase().includes('error') ? 'error' : 'success'

  return (
    <div className="overview-surface gcp-runtime-console gcp-runtime-console-sql gcp-sql-console">
      {message ? <div className={`gcp-sql-msg ${messageTone}`}>{message}</div> : null}
      {error ? (
        <section className="gcp-sql-msg error">
          {enableAction ? (
            <div className="gcp-sql-enable-state">
              <strong>{enableAction.summary}</strong>
              <p>Cloud SQL görünümü terminal açmadan çalışıyor. Servis kapalıysa komut burada gösterilir; etkinleştirme sonrasında inventory yenilenebilir.</p>
              <pre className="gcp-sql-code-block">{enableAction.command}</pre>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      <section className="gcp-sql-shell-hero">
        <div className="gcp-sql-shell-hero-copy">
          <div className="eyebrow">Cloud SQL service</div>
          <h2>{selectedInstance?.name || 'Cloud SQL command center'}</h2>
          <p>RDS düzenindeki envanter ve inspector akışını koruyan, mevcut GCP temasına uyan Cloud SQL çalışma yüzeyi.</p>
          <div className="gcp-sql-shell-meta-strip">
            <div className="gcp-sql-shell-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="gcp-sql-shell-meta-pill">
              <span>Location lens</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="gcp-sql-shell-meta-pill">
              <span>Selected instance</span>
              <strong>{selectedInstance?.name || 'None selected'}</strong>
            </div>
            <div className="gcp-sql-shell-meta-pill">
              <span>Last sync</span>
              <strong>{loading ? 'Syncing...' : formatTime(lastLoadedAt)}</strong>
            </div>
          </div>
        </div>
        <div className="gcp-sql-shell-hero-stats">
          <div className="gcp-sql-shell-stat-card accent">
            <span>Total instances</span>
            <strong>{instances.length}</strong>
            <small>Inventory returned by Cloud SQL Admin</small>
          </div>
          <div className="gcp-sql-shell-stat-card">
            <span>Runnable</span>
            <strong>{runnableCount}</strong>
            <small>Instances currently in `RUNNABLE`</small>
          </div>
          <div className="gcp-sql-shell-stat-card warning">
            <span>Public exposure</span>
            <strong>{publicCount}</strong>
            <small>Public primary addresses in fleet</small>
          </div>
          <div className="gcp-sql-shell-stat-card">
            <span>Regional HA</span>
            <strong>{haCount}</strong>
            <small>Instances using regional availability</small>
          </div>
        </div>
      </section>

      <section className="gcp-sql-shell-toolbar">
        <div className="gcp-sql-toolbar">
          <button type="button" className="gcp-sql-toolbar-btn accent" disabled={loading} onClick={() => void loadInventory('manual')}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          {[
            ['all', 'All'],
            ['runnable', 'Runnable'],
            ['non-runnable', 'Non-runnable'],
            ['public', 'Public IP'],
            ['ha', 'Regional HA']
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`gcp-sql-toolbar-btn ${statusFilter === value ? 'active' : ''}`}
              onClick={() => setStatusFilter(value as typeof statusFilter)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="gcp-sql-shell-status">
          <div className="gcp-sql-shell-status-card">
            <span>Visible inventory</span>
            <strong>{filteredInstances.length} / {instances.length}</strong>
          </div>
          <label className="gcp-sql-shell-status-card gcp-sql-shell-status-search">
            <span>Search</span>
            <input
              className="gcp-sql-search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, engine, region, endpoint"
            />
          </label>
          <FreshnessIndicator freshness={freshness} label="Cloud SQL inventory" staleLabel="Refresh inventory" />
        </div>
      </section>

      {!loading && !instances.length && !error ? (
        <section className="gcp-sql-empty">
          <SvcState variant="empty" message={`No Cloud SQL instances were found for ${projectId} in ${locationLabel}.`} />
        </section>
      ) : null}

      {instances.length > 0 ? (
        <div className="gcp-sql-main-layout">
          <section className="gcp-sql-table-panel">
            <div className="gcp-sql-pane-head">
              <div>
                <span className="gcp-sql-pane-kicker">Instance fleet</span>
                <h3>Cloud SQL inventory</h3>
              </div>
              <div className="gcp-sql-pane-summary">{filteredInstances.length} shown</div>
            </div>

            <div className="gcp-sql-column-chips">
              {GCP_CLOUD_SQL_COLUMNS.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  className={`gcp-sql-chip ${visibleColumns.has(column.key) ? 'active' : ''}`}
                  style={visibleColumns.has(column.key) ? { borderColor: column.color, color: column.color } : undefined}
                  onClick={() => setVisibleColumns((previous) => {
                    const next = new Set(previous)
                    if (next.has(column.key)) next.delete(column.key)
                    else next.add(column.key)
                    return next
                  })}
                >
                  {column.label}
                </button>
              ))}
            </div>

            <div className="gcp-sql-table-area">
              {filteredInstances.length ? (
                <table className="gcp-sql-data-table">
                  <thead>
                    <tr>
                      {activeColumns.map((column) => (
                        <th key={column.key}>{column.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInstances.map((instance) => (
                      <tr
                        key={instance.name}
                        className={selectedInstance?.name === instance.name ? 'active' : ''}
                        onClick={() => setSelectedName(instance.name)}
                      >
                        {activeColumns.map((column) => (
                          <td key={`${instance.name}:${column.key}`}>
                            {column.key === 'instance' ? (
                              <div className="gcp-sql-row-primary">
                                <strong>{instance.name}</strong>
                                <span>{instance.zone || instance.region || 'Location unavailable'}</span>
                              </div>
                            ) : column.key === 'state' ? (
                              <SqlStatusBadge status={getCloudSqlColumnValue(instance, column.key)} />
                            ) : (
                              getCloudSqlColumnValue(instance, column.key)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="gcp-sql-empty-state">
                  <SvcState variant="no-filter-matches" resourceName="instances" compact />
                </div>
              )}
            </div>
          </section>

          <div className="gcp-sql-sidebar">
            {selectedInstance ? (
              <>
                <section className="gcp-sql-detail-hero">
                  <div className="gcp-sql-detail-hero-copy">
                    <span className="gcp-sql-pane-kicker">Cloud SQL instance</span>
                    <h3>{selectedInstance.name}</h3>
                    <p>{selectedInstance.databaseVersion || 'Engine unavailable'} in {selectedInstance.region || 'unknown region'} with {selectedInstance.availabilityType || 'unspecified'} availability.</p>
                    <div className="gcp-sql-detail-meta-strip">
                      <div className="gcp-sql-detail-meta-pill">
                        <span>Status</span>
                        <strong>{prettifyCloudSqlLabel(selectedInstance.state || 'UNKNOWN')}</strong>
                      </div>
                      <div className="gcp-sql-detail-meta-pill">
                        <span>Primary endpoint</span>
                        <strong>{selectedInstance.privateAddress || selectedInstance.primaryAddress || '-'}</strong>
                      </div>
                      <div className="gcp-sql-detail-meta-pill">
                        <span>Maintenance</span>
                        <strong>{selectedInstance.maintenanceWindow || 'Not configured'}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="gcp-sql-detail-hero-stats">
                    <div className={`gcp-sql-detail-stat-card ${gcpCloudSqlToneClass(gcpCloudSqlStatusTone(selectedInstance.state))}`}>
                      <span>Lifecycle</span>
                      <strong>{prettifyCloudSqlLabel(selectedInstance.state || 'UNKNOWN')}</strong>
                      <small>{selectedInstance.databaseVersion || 'Engine unavailable'}</small>
                    </div>
                    <div className="gcp-sql-detail-stat-card">
                      <span>Availability</span>
                      <strong>{selectedInstance.availabilityType || 'Unspecified'}</strong>
                      <small>{selectedInstance.zone || selectedInstance.region || 'Location unavailable'}</small>
                    </div>
                    <div className={`gcp-sql-detail-stat-card ${selectedInstance.primaryAddress ? 'gcp-sql-tone-warning' : 'gcp-sql-tone-good'}`}>
                      <span>Public / private</span>
                      <strong>{selectedInstance.primaryAddress ? 'Public path present' : 'Private first'}</strong>
                      <small>{selectedInstance.privateAddress || selectedInstance.primaryAddress || 'No endpoint'}</small>
                    </div>
                    <div className="gcp-sql-detail-stat-card">
                      <span>Storage</span>
                      <strong>{selectedInstance.diskSizeGb ? `${selectedInstance.diskSizeGb} GB` : '-'}</strong>
                      <small>{selectedInstance.storageAutoResizeEnabled ? 'Auto-resize enabled' : 'Auto-resize disabled'}</small>
                    </div>
                  </div>
                </section>

                <div className="gcp-sql-side-tabs">
                  <button type="button" className={sideTab === 'overview' ? 'active' : ''} onClick={() => setSideTab('overview')}>Overview</button>
                  <button type="button" className={sideTab === 'databases' ? 'active' : ''} onClick={() => setSideTab('databases')}>Databases</button>
                  <button type="button" className={sideTab === 'operations' ? 'active' : ''} onClick={() => setSideTab('operations')}>Operations</button>
                </div>

                {actionError ? <div className="gcp-sql-msg error">{actionError}</div> : null}

                {sideTab === 'overview' ? (
                  <>
                    <section className="gcp-sql-sidebar-section">
                      <div className="gcp-sql-overview-head">
                        <div>
                          <span className="gcp-sql-overview-kicker">Selected instance</span>
                          <h3>Operational summary</h3>
                        </div>
                        <SqlStatusBadge status={selectedInstance.state || 'UNKNOWN'} />
                      </div>
                      <div className="gcp-sql-summary-tiles">
                        <div className="gcp-sql-summary-tile">
                          <div className="gcp-sql-summary-tile-label">Location lens match</div>
                          <div className="gcp-sql-summary-tile-value">{matchesLocationLens(selectedInstance, location) ? 'Aligned' : 'Out of scope'}</div>
                        </div>
                        <div className="gcp-sql-summary-tile">
                          <div className="gcp-sql-summary-tile-label">Deletion protection</div>
                          <div className="gcp-sql-summary-tile-value">{selectedInstance.deletionProtectionEnabled ? 'Enabled' : 'Disabled'}</div>
                        </div>
                        <div className="gcp-sql-summary-tile">
                          <div className="gcp-sql-summary-tile-label">Engine spread</div>
                          <div className="gcp-sql-summary-tile-value">{engineSpread} variants</div>
                        </div>
                        <div className="gcp-sql-summary-tile">
                          <div className="gcp-sql-summary-tile-label">Region spread</div>
                          <div className="gcp-sql-summary-tile-value">{regionSpread} regions</div>
                        </div>
                      </div>
                    </section>

                    <section className="gcp-sql-sidebar-section">
                      <h3>Posture badges</h3>
                      <div className="gcp-sql-posture-badges">
                        {selectedRiskNotes.map((note) => (
                          <div key={note.label} className={`gcp-sql-posture-badge ${gcpCloudSqlToneClass(note.tone === 'high' ? 'risk' : note.tone === 'medium' ? 'warning' : 'good')}`}>
                            <span>{note.label}</span>
                            <strong>{note.tone}</strong>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="gcp-sql-sidebar-section">
                      <h3>Operational findings</h3>
                      <div className="gcp-sql-stack-list">
                        {selectedFindings.length ? selectedFindings.map((finding) => (
                          <div key={finding.id} className={`gcp-sql-finding-card ${gcpCloudSqlToneClass(finding.tone)}`}>
                            <div className="gcp-sql-finding-title">{finding.title}</div>
                            <div className="gcp-sql-finding-text">{finding.body}</div>
                          </div>
                        )) : (
                          <div className="gcp-sql-state-card gcp-sql-tone-good">No immediate warnings were derived from the selected instance posture.</div>
                        )}
                      </div>
                    </section>

                    <section className="gcp-sql-sidebar-section">
                      <h3>Instance detail</h3>
                      {instanceDetail ? (
                        <>
                          <SqlKv items={[
                            ['Name', instanceDetail.name],
                            ['Engine', instanceDetail.databaseVersion || '-'],
                            ['Region', instanceDetail.region || '-'],
                            ['Zone', instanceDetail.zone || '-'],
                            ['Activation policy', instanceDetail.activationPolicy || '-'],
                            ['Pricing plan', instanceDetail.pricingPlan || '-'],
                            ['Disk type', instanceDetail.diskType || '-'],
                            ['Disk size', instanceDetail.diskSizeGb ? `${instanceDetail.diskSizeGb} GB` : '-'],
                            ['Backups', instanceDetail.backupEnabled ? 'Enabled' : 'Disabled'],
                            ['Point-in-time recovery', instanceDetail.pointInTimeRecoveryEnabled ? 'Enabled' : 'Disabled'],
                            ['Binary logging', instanceDetail.binaryLogEnabled ? 'Enabled' : 'Disabled'],
                            ['Connector enforcement', instanceDetail.connectorEnforcement || '-'],
                            ['SSL mode', instanceDetail.sslMode || '-'],
                            ['Maintenance window', instanceDetail.maintenanceWindow || '-']
                          ]} />
                          {instanceDetail.authorizedNetworks.length ? (
                            <div className="gcp-sql-chip-list">
                              {instanceDetail.authorizedNetworks.map((network) => (
                                <span key={network} className="gcp-sql-network-chip">{network}</span>
                              ))}
                            </div>
                          ) : (
                            <div className="gcp-sql-sidebar-hint">No authorized networks were returned for this instance.</div>
                          )}
                        </>
                      ) : (
                        <div className="gcp-sql-empty-state">Loading instance detail...</div>
                      )}
                    </section>

                    <section className="gcp-sql-sidebar-section">
                      <h3>Operator actions</h3>
                      <div className="gcp-sql-actions-grid">
                        <button className="gcp-sql-action-btn start" type="button" disabled={actionLoading !== null} onClick={() => void loadInstanceAction('describe')}>
                          {actionLoading === 'describe' ? 'Loading detail...' : 'Refresh detail'}
                        </button>
                        <button className="gcp-sql-action-btn" type="button" disabled={actionLoading !== null} onClick={() => void loadInstanceAction('databases')}>
                          {actionLoading === 'databases' ? 'Loading databases...' : 'Load databases'}
                        </button>
                        <button className="gcp-sql-action-btn" type="button" disabled={actionLoading !== null} onClick={() => void loadInstanceAction('operations')}>
                          {actionLoading === 'operations' ? 'Loading operations...' : 'Load operations'}
                        </button>
                      </div>
                      <div className="gcp-sql-sidebar-hint">Aksiyonlar terminal açmadan Cloud SQL Admin SDK üzerinden detail paneline veri getirir.</div>
                    </section>

                    <section className="gcp-sql-sidebar-section">
                      <h3>Recommended checks</h3>
                      <div className="gcp-sql-suggestions">
                        {recommendations.map((item) => (
                          <div key={item} className="gcp-sql-suggestion-item">{item}</div>
                        ))}
                      </div>
                    </section>

                    <section className="gcp-sql-sidebar-section">
                      <h3>Fleet distribution</h3>
                      <div className="gcp-sql-stack-list">
                        <div className="gcp-sql-state-card">
                          <strong>{inScopeCount}</strong>
                          <div className="gcp-sql-state-card-body">Instances currently aligned with the active location lens.</div>
                        </div>
                        <div className="gcp-sql-state-card">
                          <strong>{deletionProtectionCount}</strong>
                          <div className="gcp-sql-state-card-body">Instances with deletion protection enabled.</div>
                        </div>
                        {regionHotspots.map((item) => (
                          <div key={item.label} className="gcp-sql-state-card">
                            <strong>{item.label}</strong>
                            <div className="gcp-sql-state-card-body">{item.count} instances</div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </>
                ) : null}

                {sideTab === 'databases' ? (
                  <section className="gcp-sql-sidebar-section">
                    <div className="gcp-sql-overview-head">
                      <div>
                        <span className="gcp-sql-overview-kicker">Schema surface</span>
                        <h3>Databases</h3>
                      </div>
                      <div className="gcp-sql-pane-summary">{databases.length} items</div>
                    </div>
                    {actionLoading === 'databases' && !databases.length ? (
                      <div className="gcp-sql-empty-state">Loading databases...</div>
                    ) : databases.length ? (
                      <div className="gcp-sql-stack-list">
                        {databases.map((database) => (
                          <div key={database.name} className="gcp-sql-data-card">
                            <div className="gcp-sql-data-card-head">
                              <strong>{database.name}</strong>
                              <span>{database.charset || 'Charset unavailable'}</span>
                            </div>
                            <div className="gcp-sql-data-card-meta">{database.collation || 'Collation unavailable'}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="gcp-sql-empty-state">No databases were returned for this instance.</div>
                    )}
                  </section>
                ) : null}

                {sideTab === 'operations' ? (
                  <section className="gcp-sql-sidebar-section">
                    <div className="gcp-sql-overview-head">
                      <div>
                        <span className="gcp-sql-overview-kicker">Control plane activity</span>
                        <h3>Recent operations</h3>
                      </div>
                      <div className="gcp-sql-pane-summary">{operations.length} items</div>
                    </div>
                    {actionLoading === 'operations' && !operations.length ? (
                      <div className="gcp-sql-empty-state">Loading operations...</div>
                    ) : operations.length ? (
                      <div className="gcp-sql-stack-list">
                        {operations.map((operation) => (
                          <div key={operation.id} className="gcp-sql-data-card">
                            <div className="gcp-sql-data-card-head">
                              <strong>{operation.operationType || operation.id}</strong>
                              <SqlStatusBadge status={operation.status || 'UNKNOWN'} />
                            </div>
                            <div className="gcp-sql-data-card-meta">
                              <span>{operation.targetId || selectedInstance.name}</span>
                              <span>{operation.user || 'User unavailable'}</span>
                              <span>{formatDateTime(operation.insertTime)}</span>
                            </div>
                            <div className="gcp-sql-sidebar-hint">
                              {operation.endTime ? `Ended ${formatDateTime(operation.endTime)}` : 'Still running or pending completion'}
                            </div>
                            {operation.error ? <div className="gcp-sql-inline-error">{operation.error}</div> : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="gcp-sql-empty-state">No recent operations were returned for this instance.</div>
                    )}
                  </section>
                ) : null}
              </>
            ) : (
              <div className="gcp-sql-sidebar-section">
                <div className="gcp-sql-empty-state">
                  <span className="gcp-sql-pane-kicker">No instance selected</span>
                  <h3>Choose a Cloud SQL instance to inspect.</h3>
                  <p>The right pane will show the same operator rhythm as RDS: detail hero, posture summary, SDK-backed actions, databases, and recent operations.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
