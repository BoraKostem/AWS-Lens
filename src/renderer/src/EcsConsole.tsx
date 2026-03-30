import { useEffect, useMemo, useState } from 'react'
import './ecs.css'
import { SvcState } from './SvcState'

import type {
  AwsConnection,
  CorrelatedSignalReference,
  EcsContainerSummary,
  EcsDiagnosticsIndicator,
  EcsDiagnosticsTaskRow,
  EcsServiceDiagnostics,
  EcsServiceSummary,
  GeneratedArtifact,
  ObservabilityPostureReport
} from '@shared/types'
import {
  forceEcsRedeploy,
  getEcsContainerLogs,
  getEcsDiagnostics,
  getEcsObservabilityReport,
  listEcsClusters,
  listEcsServices,
  stopEcsTask,
  updateEcsDesiredCount
} from './api'
import { ConfirmButton } from './ConfirmButton'
import { ObservabilityResilienceLab } from './ObservabilityResilienceLab'
import { FreshnessIndicator, useFreshnessState } from './freshness'

type MainTab = 'services' | 'tasks' | 'lab'
type ServiceColumnKey = 'serviceName' | 'status' | 'running' | 'launchType' | 'taskDefinition' | 'deploymentStatus'
type TaskColumnKey = 'taskId' | 'lastStatus' | 'health' | 'startedAt' | 'stoppedReason' | 'containers'
type SurfaceTone = 'success' | 'warning' | 'danger' | 'info'

const SERVICE_COLUMNS: { key: ServiceColumnKey; label: string; color: string }[] = [
  { key: 'serviceName', label: 'Service', color: '#3b82f6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'running', label: 'Running', color: '#14b8a6' },
  { key: 'launchType', label: 'Launch Type', color: '#8b5cf6' },
  { key: 'taskDefinition', label: 'Task Def', color: '#f59e0b' },
  { key: 'deploymentStatus', label: 'Deployment', color: '#06b6d4' }
]

const TASK_COLUMNS: { key: TaskColumnKey; label: string; color: string }[] = [
  { key: 'taskId', label: 'Task ID', color: '#3b82f6' },
  { key: 'lastStatus', label: 'Status', color: '#22c55e' },
  { key: 'health', label: 'Health', color: '#e11d48' },
  { key: 'startedAt', label: 'Started', color: '#14b8a6' },
  { key: 'stoppedReason', label: 'Stop Reason', color: '#f59e0b' },
  { key: 'containers', label: 'Containers', color: '#06b6d4' }
]

function fmtTs(v: string): string {
  return v && v !== '-' ? new Date(v).toLocaleString() : '-'
}

function taskStateTone(task: EcsDiagnosticsTaskRow): string {
  if (task.isFailed) return 'FAILED'
  if (task.isPending) return 'PENDING'
  return task.lastStatus
}

function diagnosticsCommand(clusterArn: string, serviceName: string): string {
  return `aws ecs describe-services --cluster "${clusterArn}" --services "${serviceName}" --include TAGS`
}

function buildDerivedLogTarget(
  diagnostics: EcsServiceDiagnostics,
  task: EcsDiagnosticsTaskRow,
  containerName: string
) {
  const definitionContainer = diagnostics.taskDefinition?.containerImages.find((container) => container.name === containerName)
  if (!definitionContainer || definitionContainer.logDriver !== 'awslogs' || !definitionContainer.logGroup) {
    return null
  }

  const logStream = definitionContainer.logStreamPrefix && task.taskId
    ? `${definitionContainer.logStreamPrefix}/${containerName}/${task.taskId}`
    : ''

  return {
    taskArn: task.taskArn,
    taskId: task.taskId,
    containerName,
    logGroup: definitionContainer.logGroup,
    logStream,
    available: Boolean(logStream),
    reason: logStream ? '' : 'No awslogs stream prefix detected'
  }
}

function getServiceCellValue(svc: EcsServiceSummary, key: ServiceColumnKey): string {
  switch (key) {
    case 'serviceName': return svc.serviceName
    case 'status': return svc.status
    case 'running': return `${svc.runningCount}/${svc.desiredCount}`
    case 'launchType': return svc.launchType
    case 'taskDefinition': return svc.taskDefinition.split('/').pop() ?? svc.taskDefinition
    case 'deploymentStatus': return svc.deploymentStatus
  }
}

function healthTone(severity: EcsDiagnosticsIndicator['severity']): string {
  if (severity === 'critical') return 'critical'
  if (severity === 'warning') return 'warning'
  return 'info'
}

function summarizeServiceState(service: EcsServiceSummary): { tone: SurfaceTone; label: string } {
  if (service.status !== 'ACTIVE') {
    return { tone: 'danger', label: service.status }
  }
  if (service.deploymentStatus === 'FAILED') {
    return { tone: 'danger', label: 'Failed rollout' }
  }
  if (service.runningCount < service.desiredCount || service.pendingCount > 0 || service.deploymentStatus === 'IN_PROGRESS') {
    return { tone: 'warning', label: 'Reconciling' }
  }
  if (service.deploymentStatus === 'COMPLETED') {
    return { tone: 'success', label: 'Healthy' }
  }
  return { tone: 'info', label: service.deploymentStatus || 'Observed' }
}

function summarizeIndicators(indicators: EcsDiagnosticsIndicator[]): { tone: SurfaceTone; label: string } {
  if (indicators.some((indicator) => indicator.severity === 'critical' && indicator.status !== 'clear')) {
    return { tone: 'danger', label: 'Critical findings' }
  }
  if (indicators.some((indicator) => indicator.severity === 'warning' && indicator.status !== 'clear')) {
    return { tone: 'warning', label: 'Needs review' }
  }
  if (indicators.length > 0) {
    return { tone: 'success', label: 'Stable signals' }
  }
  return { tone: 'info', label: 'Awaiting diagnostics' }
}

function KV({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="ecs-kv">
      {items.map(([label, value]) => (
        <div key={label} className="ecs-kv-row">
          <div className="ecs-kv-label">{label}</div>
          <div className="ecs-kv-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

export function EcsConsole({
  connection,
  refreshNonce = 0,
  focusService,
  onRunTerminalCommand
}: {
  connection: AwsConnection
  refreshNonce?: number
  focusService?: { token: number; clusterArn: string; serviceName: string } | null
  onRunTerminalCommand?: (command: string) => void
}) {
  const [mainTab, setMainTab] = useState<MainTab>('services')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [visibleServiceCols, setVisibleServiceCols] = useState<Set<ServiceColumnKey>>(
    new Set(SERVICE_COLUMNS.map((column) => column.key))
  )
  const [visibleTaskCols, setVisibleTaskCols] = useState<Set<TaskColumnKey>>(
    new Set(TASK_COLUMNS.map((column) => column.key))
  )
  const [clusters, setClusters] = useState<Array<{ clusterArn: string; clusterName: string; activeServicesCount: number; runningTasksCount: number }>>([])
  const [selectedClusterArn, setSelectedClusterArn] = useState('')
  const [services, setServices] = useState<EcsServiceSummary[]>([])
  const [selectedServiceName, setSelectedServiceName] = useState('')
  const [diagnostics, setDiagnostics] = useState<EcsServiceDiagnostics | null>(null)
  const [selectedTaskArn, setSelectedTaskArn] = useState('')
  const [selectedLogTargetKey, setSelectedLogTargetKey] = useState('')
  const [logs, setLogs] = useState<Array<{ timestamp: number; message: string }>>([])
  const [logStatus, setLogStatus] = useState('')
  const [desiredCount, setDesiredCount] = useState('1')
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  const [labReport, setLabReport] = useState<ObservabilityPostureReport | null>(null)
  const [labLoading, setLabLoading] = useState(false)
  const [labError, setLabError] = useState('')
  const {
    freshness: diagnosticsFreshness,
    beginRefresh: beginDiagnosticsRefresh,
    completeRefresh: completeDiagnosticsRefresh,
    failRefresh: failDiagnosticsRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })
  const {
    freshness: labFreshness,
    beginRefresh: beginLabRefresh,
    completeRefresh: completeLabRefresh,
    failRefresh: failLabRefresh
  } = useFreshnessState({ staleAfterMs: 5 * 60 * 1000 })

  const selectedCluster = useMemo(
    () => clusters.find((cluster) => cluster.clusterArn === selectedClusterArn) ?? null,
    [clusters, selectedClusterArn]
  )
  const selectedClusterTarget = selectedCluster?.clusterName || selectedClusterArn
  const selectedClusterApiTarget = selectedClusterArn || selectedCluster?.clusterArn || ''

  const activeServiceCols = SERVICE_COLUMNS.filter((column) => visibleServiceCols.has(column.key))
  const activeTaskCols = TASK_COLUMNS.filter((column) => visibleTaskCols.has(column.key))

  const filteredServices = useMemo(() => {
    if (!search) return services
    const query = search.toLowerCase()
    return services.filter((service) =>
      Array.from(visibleServiceCols).some((key) => getServiceCellValue(service, key).toLowerCase().includes(query))
    )
  }, [search, services, visibleServiceCols])

  const taskRows = diagnostics?.taskRows ?? []
  const filteredTasks = useMemo(() => {
    if (!search) return taskRows
    const query = search.toLowerCase()
    return taskRows.filter((task) =>
      task.taskId.toLowerCase().includes(query) ||
      task.lastStatus.toLowerCase().includes(query) ||
      task.stoppedReason.toLowerCase().includes(query) ||
      task.containers.some((container) => container.name.toLowerCase().includes(query) || container.image.toLowerCase().includes(query))
    )
  }, [search, taskRows])

  const selectedServiceSummary = useMemo(
    () => services.find((service) => service.serviceName === selectedServiceName) ?? null,
    [selectedServiceName, services]
  )

  const selectedTask = useMemo(() => {
    if (!diagnostics) return null
    return diagnostics.taskRows.find((task) => task.taskArn === selectedTaskArn) ?? diagnostics.taskRows[0] ?? diagnostics.selectedTask
  }, [diagnostics, selectedTaskArn])

  const selectedLogTarget = useMemo(() => {
    if (!diagnostics) return null
    const explicit = diagnostics.logTargets.find((target) => `${target.taskArn}:${target.containerName}` === selectedLogTargetKey)
    if (explicit?.available) {
      return explicit
    }

    if (selectedTask && selectedLogTargetKey) {
      const explicitContainer = selectedLogTargetKey.startsWith(`${selectedTask.taskArn}:`)
        ? selectedLogTargetKey.slice(selectedTask.taskArn.length + 1)
        : ''
      const derivedExplicit = buildDerivedLogTarget(diagnostics, selectedTask, explicitContainer)
      if (derivedExplicit?.available) {
        return derivedExplicit
      }
    }

    const fallback = selectedTask
      ? diagnostics.logTargets.find((target) => target.taskArn === selectedTask.taskArn && target.available) ??
        selectedTask.containers.map((container) => buildDerivedLogTarget(diagnostics, selectedTask, container.name)).find((target) => target?.available) ??
        null
      : diagnostics.logTargets.find((target) => target.available) ?? null

    return explicit ?? fallback
  }, [diagnostics, selectedLogTargetKey, selectedTask])

  const selectedServiceTone = selectedServiceSummary ? summarizeServiceState(selectedServiceSummary) : { tone: 'info' as const, label: 'Select a service' }
  const indicatorsTone = summarizeIndicators(diagnostics?.indicators ?? [])
  const availableServiceCount = services.filter((service) => service.status === 'ACTIVE').length
  const serviceSummaryTiles = diagnostics?.summaryTiles ?? []

  async function load(
    clusterArn?: string,
    serviceName?: string,
    reason: 'initial' | 'manual' | 'background' | 'selection' = 'manual'
  ) {
    beginDiagnosticsRefresh(reason)
    setLoading(true)
    setError('')
    try {
      const nextClusters = await listEcsClusters(connection)
      setClusters(nextClusters)
      const resolvedCluster = clusterArn || selectedClusterArn || nextClusters[0]?.clusterArn || ''
      setSelectedClusterArn(resolvedCluster)

      if (!resolvedCluster) {
        setServices([])
        setDiagnostics(null)
        return
      }

      const nextServices = await listEcsServices(connection, resolvedCluster)
      setServices(nextServices)
      const requestedService = serviceName || selectedServiceName
      const resolvedService = requestedService && nextServices.some((service) => service.serviceName === requestedService)
        ? requestedService
        : nextServices[0]?.serviceName ?? ''
      setSelectedServiceName(resolvedService)

      if (!resolvedService) {
        setDiagnostics(null)
        setLogs([])
        setLogStatus('')
        return
      }

      const nextDiagnostics = await getEcsDiagnostics(connection, resolvedCluster, resolvedService)
      setDiagnostics(nextDiagnostics)
      setLabReport(null)
      setLabError('')
      setDesiredCount(String(nextDiagnostics.service.desiredCount))
      const nextSelectedTaskArn = nextDiagnostics.taskRows.some((task) => task.taskArn === selectedTaskArn)
        ? selectedTaskArn
        : (nextDiagnostics.taskRows[0]?.taskArn ?? '')
      setSelectedTaskArn(nextSelectedTaskArn)
      const nextLogTarget = nextDiagnostics.logTargets.find((target) => `${target.taskArn}:${target.containerName}` === selectedLogTargetKey && target.available) ??
        nextDiagnostics.logTargets.find((target) => target.taskArn === nextSelectedTaskArn && target.available) ??
        nextDiagnostics.logTargets.find((target) => target.available)
      setSelectedLogTargetKey(nextLogTarget ? `${nextLogTarget.taskArn}:${nextLogTarget.containerName}` : '')
      setLogs([])
      setLogStatus('')
      completeDiagnosticsRefresh()
    } catch (e) {
      failDiagnosticsRefresh()
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(undefined, undefined, 'initial')
  }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (refreshNonce === 0) {
      return
    }

    void load(selectedClusterArn, selectedServiceName, 'manual')
  }, [refreshNonce, selectedClusterArn, selectedServiceName])

  useEffect(() => {
    if (!focusService || focusService.token === appliedFocusToken) return

    if (focusService.clusterArn && focusService.clusterArn !== selectedClusterArn) {
      setAppliedFocusToken(focusService.token)
      void load(focusService.clusterArn, focusService.serviceName)
      return
    }

    const match = services.find((service) => service.serviceName === focusService.serviceName)
    if (!match) return

    setAppliedFocusToken(focusService.token)
    setMainTab('services')
    void selectService(match.serviceName)
  }, [appliedFocusToken, focusService, selectedClusterArn, services])

  useEffect(() => {
    if (!selectedLogTarget || !selectedLogTarget.available) {
      setLogs([])
      setLogStatus(selectedLogTarget ? selectedLogTarget.reason : '')
      return
    }

    const logTarget = selectedLogTarget
    let cancelled = false

    async function run() {
      setLogStatus('Loading logs...')
      try {
        const nextLogs = await getEcsContainerLogs(connection, logTarget.logGroup, logTarget.logStream)
        if (cancelled) return
        setLogs(nextLogs)
        setLogStatus(nextLogs.length > 0 ? '' : 'No recent log lines were returned for this container.')
      } catch (e) {
        if (cancelled) return
        setLogs([])
        setLogStatus(e instanceof Error ? e.message : String(e))
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [connection, selectedLogTarget])

  async function loadLab() {
    if (!selectedClusterTarget || !selectedServiceName) return
    beginLabRefresh('background')
    setLabLoading(true)
    setLabError('')
    try {
      const report = await getEcsObservabilityReport(connection, selectedClusterApiTarget, selectedServiceName)
      setLabReport(report)
      completeLabRefresh()
    } catch (e) {
      failLabRefresh()
      setLabError(e instanceof Error ? e.message : 'Failed to load observability lab')
    } finally {
      setLabLoading(false)
    }
  }

  useEffect(() => {
    if (mainTab !== 'lab' || !selectedServiceName) return
    if (labReport?.scope.kind === 'ecs' && labReport.scope.serviceName === selectedServiceName) return
    void loadLab()
  }, [connection, labReport, mainTab, selectedClusterApiTarget, selectedServiceName])

  async function selectService(serviceName: string) {
    setSelectedServiceName(serviceName)
    beginDiagnosticsRefresh('selection')
    setMsg('')
    setError('')
    setLogs([])
    setLogStatus('')
    try {
      const nextDiagnostics = await getEcsDiagnostics(connection, selectedClusterApiTarget, serviceName)
      setDiagnostics(nextDiagnostics)
      setDesiredCount(String(nextDiagnostics.service.desiredCount))
      const nextSelectedTaskArn = nextDiagnostics.taskRows.some((task) => task.taskArn === selectedTaskArn)
        ? selectedTaskArn
        : (nextDiagnostics.taskRows[0]?.taskArn ?? '')
      setSelectedTaskArn(nextSelectedTaskArn)
      const nextLogTarget = nextDiagnostics.logTargets.find((target) => `${target.taskArn}:${target.containerName}` === selectedLogTargetKey && target.available) ??
        nextDiagnostics.logTargets.find((target) => target.taskArn === nextSelectedTaskArn && target.available) ??
        nextDiagnostics.logTargets.find((target) => target.available)
      setSelectedLogTargetKey(nextLogTarget ? `${nextLogTarget.taskArn}:${nextLogTarget.containerName}` : '')
      completeDiagnosticsRefresh()
    } catch (e) {
      failDiagnosticsRefresh()
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function doScale() {
    setBusy(true)
    setMsg('')
    try {
      await updateEcsDesiredCount(connection, selectedClusterApiTarget, selectedServiceName, Number(desiredCount) || 0)
      setMsg('Desired count updated')
      await load(selectedClusterArn, selectedServiceName)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doRedeploy() {
    setBusy(true)
    setMsg('')
    try {
      await forceEcsRedeploy(connection, selectedClusterApiTarget, selectedServiceName)
      setMsg('Force redeploy initiated')
      await load(selectedClusterArn, selectedServiceName)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doStopTask(taskArn: string) {
    setBusy(true)
    setMsg('')
    try {
      await stopEcsTask(connection, selectedClusterApiTarget, taskArn)
      setMsg('Task stopped')
      await load(selectedClusterArn, selectedServiceName)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function selectTask(taskArn: string) {
    setSelectedTaskArn(taskArn)
    const logTarget = diagnostics?.logTargets.find((target) => target.taskArn === taskArn && target.available) ?? null
    setSelectedLogTargetKey(logTarget ? `${logTarget.taskArn}:${logTarget.containerName}` : '')
  }

  function selectContainerLog(container: EcsContainerSummary) {
    if (!selectedTask) return
    setSelectedLogTargetKey(`${selectedTask.taskArn}:${container.name}`)
  }

  function toggleServiceCol(key: ServiceColumnKey) {
    setVisibleServiceCols((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleTaskCol(key: TaskColumnKey) {
    setVisibleTaskCols((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleLabArtifactRun(artifact: GeneratedArtifact) {
    onRunTerminalCommand?.(artifact.content)
    setMsg('Artifact command opened in terminal')
  }

  function handleLabSignalNavigate(signal: CorrelatedSignalReference) {
    if (signal.targetView === 'logs' || signal.targetView === 'services') {
      setMainTab(signal.targetView === 'logs' ? 'tasks' : 'services')
    }
  }

  if (loading && !diagnostics && services.length === 0) {
    return <SvcState variant="loading" resourceName="ECS deployment diagnostics" />
  }

  return (
    <div className="ecs-console">
      <section className="ecs-shell-hero">
        <div className="ecs-shell-hero-copy">
          <div className="eyebrow">ECS service operations</div>
          <h2>Deployment diagnostics workspace</h2>
          <p>Track rollout posture, scan unstable tasks, inspect focused logs, and open the same operator actions without changing how the service workflows behave.</p>
          <div className="ecs-shell-meta-strip">
            <div className="ecs-shell-meta-pill">
              <span>Cluster</span>
              <strong>{selectedCluster?.clusterName || 'No cluster selected'}</strong>
            </div>
            <div className="ecs-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region || '-'}</strong>
            </div>
            <div className="ecs-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.label}</strong>
            </div>
            <div className="ecs-shell-meta-pill">
              <span>Selection</span>
              <strong>{selectedServiceName || 'Awaiting service'}</strong>
            </div>
          </div>
        </div>

        <div className="ecs-shell-hero-stats">
          <div className={`ecs-shell-stat-card ${selectedServiceTone.tone}`}>
            <span>Selected service</span>
            <strong>{selectedServiceTone.label}</strong>
            <small>{selectedServiceSummary ? `${selectedServiceSummary.runningCount}/${selectedServiceSummary.desiredCount} tasks running` : 'Choose a service from the inventory list.'}</small>
          </div>
          <div className="ecs-shell-stat-card">
            <span>Tracked services</span>
            <strong>{services.length}</strong>
            <small>{availableServiceCount} active in the selected cluster</small>
          </div>
          <div className={`ecs-shell-stat-card ${indicatorsTone.tone}`}>
            <span>Diagnostics posture</span>
            <strong>{indicatorsTone.label}</strong>
            <small>{diagnostics ? `${diagnostics.indicators.length} indicators and ${diagnostics.timeline.length} recent signals` : 'Diagnostics will load after a service is selected.'}</small>
          </div>
          <div className="ecs-shell-stat-card">
            <span>Task pressure</span>
            <strong>{diagnostics ? diagnostics.unstableTasks.length : 0}</strong>
            <small>{selectedCluster ? `${selectedCluster.runningTasksCount} running tasks in cluster` : 'Cluster totals appear after inventory loads.'}</small>
          </div>
        </div>
      </section>

      <div className="ecs-shell-toolbar">
        <div className="ecs-toolbar">
          <div className="ecs-toolbar-field">
            <span>Cluster</span>
            <select className="ecs-select" value={selectedClusterArn} onChange={(event) => void load(event.target.value)}>
              {clusters.map((cluster) => (
                <option key={cluster.clusterArn} value={cluster.clusterArn}>
                  {cluster.clusterName} ({cluster.activeServicesCount} svc / {cluster.runningTasksCount} tasks)
                </option>
              ))}
              {!clusters.length && <option value="">No clusters</option>}
            </select>
          </div>
          {mainTab !== 'lab' && (
            <div className="ecs-toolbar-field ecs-toolbar-search">
              <span>Search</span>
              <input
                className="ecs-search-input"
                placeholder="Filter services, tasks, reasons, and images..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          )}
          <button className="ecs-toolbar-btn accent" type="button" onClick={() => void load(selectedClusterArn, selectedServiceName, 'manual')}>
            Refresh
          </button>
        </div>

        <div className="ecs-shell-status">
          <FreshnessIndicator
            freshness={mainTab === 'lab' ? labFreshness : diagnosticsFreshness}
            label={mainTab === 'lab' ? 'Lab last updated' : 'Diagnostics last updated'}
            staleLabel={mainTab === 'lab' ? 'Refresh lab' : 'Refresh diagnostics'}
          />
        </div>
      </div>

      {error && <SvcState variant="error" error={error} />}
      {msg && <div className="ecs-msg">{msg}</div>}

      {!diagnostics && !loading && services.length === 0 && (
        <SvcState variant="no-selection" message="Select a cluster and service to inspect deployment diagnostics." />
      )}

      <div className="ecs-main-layout">
        <div className="ecs-service-list-area">
          <div className="ecs-pane-head">
            <div>
              <span className="ecs-pane-kicker">Service inventory</span>
              <h3>Cluster services</h3>
            </div>
            <span className="ecs-pane-summary">{filteredServices.length}/{services.length}</span>
          </div>

          {filteredServices.length === 0 ? (
            <SvcState variant="no-filter-matches" resourceName="services" compact />
          ) : (
            <div className="ecs-service-list">
              {filteredServices.map((service) => {
                const state = summarizeServiceState(service)
                return (
                  <button
                    key={service.serviceName}
                    type="button"
                    className={`ecs-service-row ${service.serviceName === selectedServiceName ? 'active' : ''}`}
                    onClick={() => void selectService(service.serviceName)}
                  >
                    <div className="ecs-service-row-top">
                      <div className="ecs-service-row-copy">
                        <strong>{service.serviceName}</strong>
                        <span>{service.taskDefinition.split('/').pop() ?? service.taskDefinition}</span>
                      </div>
                      <span className={`ecs-status-badge ${state.tone}`}>{state.label}</span>
                    </div>
                    <div className="ecs-service-row-meta">
                      <span>{service.status}</span>
                      <span>{service.launchType}</span>
                      <span>{service.deploymentStatus}</span>
                    </div>
                    <div className="ecs-service-row-metrics">
                      <div>
                        <span>Running</span>
                        <strong>{service.runningCount}</strong>
                      </div>
                      <div>
                        <span>Desired</span>
                        <strong>{service.desiredCount}</strong>
                      </div>
                      <div>
                        <span>Pending</span>
                        <strong>{service.pendingCount}</strong>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className={`ecs-detail-pane ${mainTab === 'lab' ? 'ecs-detail-pane-lab' : ''}`}>
          {!selectedServiceSummary ? (
            <SvcState variant="no-selection" resourceName="service" message="Select a service from the inventory list to load diagnostics." />
          ) : (
            <>
              <section className="ecs-detail-hero">
                <div className="ecs-detail-hero-copy">
                  <div className="eyebrow">Service posture</div>
                  <h3>{selectedServiceSummary.serviceName}</h3>
                  <p>{selectedCluster?.clusterName || selectedClusterArn}</p>
                  <div className="ecs-detail-meta-strip">
                    <div className="ecs-detail-meta-pill">
                      <span>Status</span>
                      <strong>{selectedServiceSummary.status}</strong>
                    </div>
                    <div className="ecs-detail-meta-pill">
                      <span>Task Definition</span>
                      <strong>{selectedServiceSummary.taskDefinition.split('/').pop() ?? selectedServiceSummary.taskDefinition}</strong>
                    </div>
                    <div className="ecs-detail-meta-pill">
                      <span>Launch Type</span>
                      <strong>{selectedServiceSummary.launchType}</strong>
                    </div>
                    <div className="ecs-detail-meta-pill">
                      <span>Deployment</span>
                      <strong>{selectedServiceSummary.deploymentStatus}</strong>
                    </div>
                  </div>
                </div>

                <div className="ecs-detail-hero-stats">
                  <div className={`ecs-detail-stat-card ${selectedServiceTone.tone}`}>
                    <span>Service state</span>
                    <strong>{selectedServiceTone.label}</strong>
                    <small>{selectedServiceSummary.status} / {selectedServiceSummary.deploymentStatus}</small>
                  </div>
                  <div className="ecs-detail-stat-card">
                    <span>Running task ratio</span>
                    <strong>{selectedServiceSummary.runningCount}/{selectedServiceSummary.desiredCount}</strong>
                    <small>{selectedServiceSummary.pendingCount} tasks pending</small>
                  </div>
                  <div className={`ecs-detail-stat-card ${indicatorsTone.tone}`}>
                    <span>Signal posture</span>
                    <strong>{diagnostics?.indicators.length ?? 0}</strong>
                    <small>{indicatorsTone.label}</small>
                  </div>
                  <div className="ecs-detail-stat-card">
                    <span>Task focus</span>
                    <strong>{taskRows.length}</strong>
                    <small>{diagnostics?.failedTasks.length ?? 0} failed, {diagnostics?.unstableTasks.length ?? 0} unstable</small>
                  </div>
                </div>
              </section>

              <div className="ecs-detail-tabs">
                <button className={mainTab === 'services' ? 'active' : ''} type="button" onClick={() => setMainTab('services')}>
                  Services
                </button>
                <button className={mainTab === 'tasks' ? 'active' : ''} type="button" onClick={() => setMainTab('tasks')}>
                  Tasks ({taskRows.length})
                </button>
                <button className={mainTab === 'lab' ? 'active' : ''} type="button" onClick={() => setMainTab('lab')}>
                  Resilience Lab
                </button>
              </div>

              {mainTab !== 'lab' && (
                <div className="ecs-section ecs-operator-shell">
                  <div className="ecs-section-head">
                    <div>
                      <span className="ecs-section-kicker">Operator controls</span>
                      <h3>Run the next safe action</h3>
                    </div>
                    <span className="ecs-section-summary">{selectedCluster?.clusterName || 'Current cluster'}</span>
                  </div>

                  <div className="ecs-actions-bar">
                    <div className="ecs-actions-grid">
                      <ConfirmButton className="ecs-action-btn redeploy" type="button" disabled={busy} confirmLabel="Deploy now?" onConfirm={() => void doRedeploy()}>
                        Force Deployment
                      </ConfirmButton>
                      <button className="ecs-action-btn apply" type="button" disabled={!onRunTerminalCommand} onClick={() => onRunTerminalCommand?.(diagnosticsCommand(selectedClusterTarget, selectedServiceName))}>
                        Open Command
                      </button>
                    </div>

                    <div className="ecs-action-scale">
                      <div className="ecs-sidebar-hint">Update desired count explicitly</div>
                      <div className="ecs-inline-form">
                        <input value={desiredCount} onChange={(event) => setDesiredCount(event.target.value)} />
                        <button className="ecs-action-btn apply" type="button" disabled={busy} onClick={() => void doScale()}>
                          Apply
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {mainTab === 'lab' && (
                <div className="ecs-lab-panel">
                  <ObservabilityResilienceLab
                    report={labReport}
                    loading={labLoading}
                    error={labError}
                    onRefresh={() => void loadLab()}
                    onRunArtifact={handleLabArtifactRun}
                    onNavigateSignal={handleLabSignalNavigate}
                  />
                </div>
              )}

              {mainTab !== 'lab' && (
                <>
                  <div className="ecs-column-chips">
                    {(mainTab === 'services' ? SERVICE_COLUMNS : TASK_COLUMNS).map((column) => {
                      const active = mainTab === 'services'
                        ? visibleServiceCols.has(column.key as ServiceColumnKey)
                        : visibleTaskCols.has(column.key as TaskColumnKey)

                      return (
                        <button
                          key={column.key}
                          className={`ecs-chip ${active ? 'active' : ''}`}
                          type="button"
                          style={active ? { background: column.color, borderColor: column.color, color: '#fff' } : undefined}
                          onClick={() => mainTab === 'services'
                            ? toggleServiceCol(column.key as ServiceColumnKey)
                            : toggleTaskCol(column.key as TaskColumnKey)}
                        >
                          {column.label}
                        </button>
                      )
                    })}
                  </div>

                  {serviceSummaryTiles.length > 0 && (
                    <div className="ecs-summary-grid">
                      {serviceSummaryTiles.map((tile) => (
                        <div key={tile.key} className={`ecs-summary-tile tone-${tile.tone}`}>
                          <div className="ecs-summary-label">{tile.label}</div>
                          <div className="ecs-summary-value">{tile.value}</div>
                          <div className="ecs-summary-detail">{tile.detail}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {mainTab === 'services' ? (
                    <>
                      <section className="ecs-section">
                        <div className="ecs-section-head">
                          <div>
                            <span className="ecs-section-kicker">Filtered service table</span>
                            <h3>Compare service posture in cluster</h3>
                          </div>
                          <span className="ecs-section-summary">{filteredServices.length} services</span>
                        </div>
                        <div className="ecs-table-area">
                          <table className="ecs-data-table">
                            <thead>
                              <tr>
                                {activeServiceCols.map((column) => <th key={column.key}>{column.label}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {filteredServices.map((service) => (
                                <tr
                                  key={service.serviceName}
                                  className={service.serviceName === selectedServiceName ? 'active' : ''}
                                  onClick={() => void selectService(service.serviceName)}
                                >
                                  {activeServiceCols.map((column) => (
                                    <td key={column.key}>
                                      {column.key === 'status'
                                        ? <span className={`ecs-badge ${service.status}`}>{service.status}</span>
                                        : column.key === 'deploymentStatus'
                                        ? <span className={`ecs-badge ${service.deploymentStatus}`}>{service.deploymentStatus}</span>
                                        : getServiceCellValue(service, column.key)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>

                      {diagnostics && (
                        <div className="ecs-panel-grid">
                          <section className="ecs-section">
                            <div className="ecs-section-head">
                              <div>
                                <span className="ecs-section-kicker">Diagnostics summary</span>
                                <h3>Likely patterns and health indicators</h3>
                              </div>
                              <span className="ecs-section-summary">{diagnostics.indicators.length} indicators</span>
                            </div>
                            <div className="ecs-pattern-list">
                              {diagnostics.likelyPatterns.map((pattern, index) => (
                                <div key={`${index}-${pattern}`} className="ecs-pattern-item">{pattern}</div>
                              ))}
                            </div>
                            <div className="ecs-health-list">
                              {diagnostics.indicators.map((indicator) => (
                                <div key={indicator.id} className={`ecs-health-item ${healthTone(indicator.severity)} ${indicator.status}`}>
                                  <div className="ecs-health-title-row">
                                    <div className="ecs-health-title">{indicator.title}</div>
                                    <span className={`ecs-status-pill ${indicator.status}`}>{indicator.status}</span>
                                  </div>
                                  <div className="ecs-health-detail">{indicator.detail}</div>
                                </div>
                              ))}
                            </div>
                          </section>

                          <section className="ecs-section">
                            <div className="ecs-section-head">
                              <div>
                                <span className="ecs-section-kicker">Failure and event timeline</span>
                                <h3>Recent service signals</h3>
                              </div>
                              <span className="ecs-section-summary">{diagnostics.timeline.length} events</span>
                            </div>
                            <div className="ecs-timeline">
                              {diagnostics.timeline.map((item) => (
                                <div key={item.id} className={`ecs-timeline-item ${item.severity}`}>
                                  <div className="ecs-timeline-meta">
                                    <span className="ecs-timeline-time">{fmtTs(item.timestamp)}</span>
                                    <span className={`ecs-status-pill ${item.category}`}>{item.category}</span>
                                  </div>
                                  <div className="ecs-timeline-title">{item.title}</div>
                                  <div className="ecs-timeline-detail">{item.detail}</div>
                                </div>
                              ))}
                            </div>
                          </section>
                        </div>
                      )}
                    </>
                  ) : (
                    <section className="ecs-section">
                      <div className="ecs-section-head">
                        <div>
                          <span className="ecs-section-kicker">Task inventory</span>
                          <h3>Running and unstable tasks</h3>
                        </div>
                        <span className="ecs-section-summary">{filteredTasks.length} tasks</span>
                      </div>
                      <div className="ecs-table-area">
                        <table className="ecs-data-table">
                          <thead>
                            <tr>
                              {activeTaskCols.map((column) => <th key={column.key}>{column.label}</th>)}
                              <th>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredTasks.map((task) => (
                              <tr
                                key={task.taskArn}
                                className={task.taskArn === selectedTask?.taskArn ? 'active' : ''}
                                onClick={() => selectTask(task.taskArn)}
                              >
                                {activeTaskCols.map((column) => (
                                  <td key={column.key}>
                                    {column.key === 'taskId' ? task.taskId
                                      : column.key === 'lastStatus' ? <span className={`ecs-badge ${taskStateTone(task)}`}>{task.lastStatus}</span>
                                      : column.key === 'health' ? <span className={`ecs-badge ${task.healthStatus}`}>{task.healthStatus}</span>
                                      : column.key === 'startedAt' ? fmtTs(task.startedAt)
                                      : column.key === 'stoppedReason' ? (task.stoppedReason || '-')
                                      : (
                                        <div className="ecs-container-pill-list">
                                          {task.containers.map((container) => (
                                            <button
                                              key={`${task.taskArn}:${container.name}`}
                                              type="button"
                                              className={`ecs-container-pill ${selectedLogTargetKey === `${task.taskArn}:${container.name}` ? 'active' : ''}`}
                                              onClick={(event) => {
                                                event.stopPropagation()
                                                setSelectedTaskArn(task.taskArn)
                                                selectContainerLog(container)
                                              }}
                                            >
                                              {container.name}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                  </td>
                                ))}
                                <td>
                                  <ConfirmButton
                                    className="ecs-action-btn stop"
                                    type="button"
                                    disabled={busy || task.lastStatus === 'STOPPED'}
                                    confirmLabel="Stop task?"
                                    onConfirm={() => void doStopTask(task.taskArn)}
                                  >
                                    Stop
                                  </ConfirmButton>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}

                  {diagnostics && (
                    <div className="ecs-detail-grid">
                      <div className="ecs-detail-row">
                      <section className="ecs-section">
                        <div className="ecs-section-head">
                          <div>
                            <span className="ecs-section-kicker">Service detail</span>
                            <h3>Current service configuration</h3>
                          </div>
                          <span className="ecs-section-summary">{diagnostics.service.launchType}</span>
                        </div>
                        <KV items={[
                          ['Service', diagnostics.service.serviceName],
                          ['Status', diagnostics.service.status],
                          ['Task Def', diagnostics.service.taskDefinition.split('/').pop() ?? diagnostics.service.taskDefinition],
                          ['Rollout', diagnostics.service.deployments[0]?.rolloutState ?? '-'],
                          ['Running', `${diagnostics.service.runningCount}/${diagnostics.service.desiredCount}`],
                          ['Pending', String(diagnostics.service.pendingCount)],
                          ['Launch Type', diagnostics.service.launchType],
                          ['Created', fmtTs(diagnostics.service.createdAt)]
                        ]} />
                      </section>

                      <section className="ecs-section">
                        <div className="ecs-section-head">
                          <div>
                            <span className="ecs-section-kicker">Deployments</span>
                            <h3>Recent rollout history</h3>
                          </div>
                          <span className="ecs-section-summary">{diagnostics.recentDeployments.length} recent</span>
                        </div>
                        {diagnostics.recentDeployments.length > 0 ? (
                          <table className="ecs-deploy-table">
                            <thead>
                              <tr>
                                <th>ID</th>
                                <th>State</th>
                                <th>Counts</th>
                              </tr>
                            </thead>
                            <tbody>
                              {diagnostics.recentDeployments.map((deployment) => (
                                <tr key={deployment.id}>
                                  <td title={deployment.taskDefinition}>{deployment.id.slice(0, 8)}</td>
                                  <td><span className={`ecs-badge ${deployment.rolloutState}`}>{deployment.rolloutState}</span></td>
                                  <td>{deployment.runningCount}/{deployment.desiredCount}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <SvcState variant="empty" resourceName="deployment history" compact />
                        )}
                      </section>
                      </div>

                      <div className="ecs-detail-row">
                      <section className="ecs-section">
                        <div className="ecs-section-head">
                          <div>
                            <span className="ecs-section-kicker">Selected task</span>
                            <h3>Container and lifecycle detail</h3>
                          </div>
                          <span className="ecs-section-summary">{selectedTask?.taskId ?? 'No task selected'}</span>
                        </div>
                        {selectedTask ? (
                          <>
                            <KV items={[
                              ['Task ID', selectedTask.taskId],
                              ['Status', selectedTask.lastStatus],
                              ['Desired', selectedTask.desiredStatus],
                              ['Health', selectedTask.healthStatus],
                              ['Started', fmtTs(selectedTask.startedAt)],
                              ['Stopped', fmtTs(selectedTask.stoppedAt)],
                              ['Stop Reason', selectedTask.stoppedReason || '-']
                            ]} />
                            <div className="ecs-task-detail-list">
                              {selectedTask.containers.map((container) => (
                                <div key={`${selectedTask.taskArn}:${container.name}`} className="ecs-task-detail-card">
                                  {(() => {
                                    const diagnosticsLogTarget =
                                      diagnostics.logTargets.find((target) => target.taskArn === selectedTask.taskArn && target.containerName === container.name) ?? null
                                    const derivedLogTarget = buildDerivedLogTarget(diagnostics, selectedTask, container.name)
                                    const effectiveLogTarget =
                                      diagnosticsLogTarget?.available ? diagnosticsLogTarget : (derivedLogTarget ?? diagnosticsLogTarget)

                                    return (
                                      <>
                                        <div className="ecs-task-detail-header">
                                    <strong>{container.name}</strong>
                                    <button
                                      type="button"
                                      className={`ecs-container-pill ${selectedLogTargetKey === `${selectedTask.taskArn}:${container.name}` ? 'active' : ''}`}
                                      onClick={() => selectContainerLog(container)}
                                    >
                                      Logs
                                    </button>
                                        </div>
                                        <KV items={[
                                          ['Image', container.image],
                                          ['Exit Code', container.exitCode === null ? '-' : String(container.exitCode)],
                                          ['Reason', container.reason || '-'],
                                          ['Health', container.healthStatus],
                                          ['Log Group', effectiveLogTarget?.logGroup || container.logGroup || '-'],
                                          ['Log Stream', effectiveLogTarget?.logStream || container.logStream || '-']
                                        ]} />
                                      </>
                                    )
                                  })()}
                                </div>
                              ))}
                            </div>
                          </>
                        ) : (
                          <SvcState variant="no-selection" resourceName="task" compact />
                        )}
                      </section>

                      <section className="ecs-section">
                        <div className="ecs-section-head">
                          <div>
                            <span className="ecs-section-kicker">Task definition and images</span>
                            <h3>Runtime surface</h3>
                          </div>
                          <span className="ecs-section-summary">{diagnostics.taskDefinition?.family ?? 'Unavailable'}</span>
                        </div>
                        {diagnostics.taskDefinition ? (
                          <>
                            <KV items={[
                              ['Family', diagnostics.taskDefinition.family],
                              ['Revision', String(diagnostics.taskDefinition.revision)],
                              ['Network', diagnostics.taskDefinition.networkMode],
                              ['Execution Role', diagnostics.taskDefinition.executionRoleArn || '-'],
                              ['Task Role', diagnostics.taskDefinition.taskRoleArn || '-']
                            ]} />
                            <div className="ecs-image-list">
                              {diagnostics.taskDefinition.containerImages.map((container) => (
                                <div key={container.name} className="ecs-image-item">
                                  <div className="ecs-image-title">{container.name}</div>
                                  <div className="ecs-image-ref">{container.image}</div>
                                  <div className="ecs-image-meta">
                                    {container.logGroup ? `logs: ${container.logGroup}` : 'logs: not configured'}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : (
                          <SvcState variant="empty" message="Task definition details were not returned." compact />
                        )}
                      </section>
                      </div>

                      <section className={`ecs-section ${(logs.length > 0 || logStatus) ? 'span-full' : ''}`}>
                        <div className="ecs-section-head">
                          <div>
                            <span className="ecs-section-kicker">Focused logs</span>
                            <h3>Container output stream</h3>
                          </div>
                          <span className="ecs-section-summary">
                            {selectedLogTarget ? `${selectedLogTarget.taskId} / ${selectedLogTarget.containerName}` : 'No stream selected'}
                          </span>
                        </div>
                        {logs.length > 0 ? (
                          <div className="ecs-log-viewer">
                            {logs.map((item, index) => (
                              <div key={`${item.timestamp}-${index}`} className="ecs-log-line">
                                <span className="ecs-log-timestamp">{new Date(item.timestamp).toLocaleTimeString()}</span>
                                {item.message}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <SvcState variant={logStatus ? 'loading' : 'no-selection'} message={logStatus || 'Select a task or container with logs to inspect output.'} compact />
                        )}
                      </section>

                      <section className="ecs-section span-full">
                        <div className="ecs-section-head">
                          <div>
                            <span className="ecs-section-kicker">Service events</span>
                            <h3>Recent control plane messages</h3>
                          </div>
                          <span className="ecs-section-summary">{diagnostics.service.events.length} events</span>
                        </div>
                        {diagnostics.service.events.length > 0 ? (
                          <div className="ecs-event-list">
                            {diagnostics.service.events.map((event) => (
                              <div key={event.id} className="ecs-event-item">
                                <span className="ecs-event-time">{fmtTs(event.createdAt)}</span>
                                {event.message}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <SvcState variant="empty" resourceName="recent service events" compact />
                        )}
                      </section>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
