import { useEffect, useMemo, useState } from 'react'

import type {
  GcpGkeClusterCredentials,
  GcpGkeClusterDetail,
  GcpGkeClusterSummary,
  GcpGkeNodePoolSummary,
  GcpGkeOperationSummary
} from '@shared/types'
import {
  chooseEksKubeconfigPath,
  getGcpGkeClusterCredentials,
  getGcpGkeClusterDetail,
  listGcpGkeClusters,
  listGcpGkeNodePools,
  listGcpGkeOperations,
  updateGcpGkeNodePoolScaling
} from './api'
import { SvcState } from './SvcState'
import './eks.css'
import './gcp-gke-console.css'

type ClusterCol = 'name' | 'status' | 'version' | 'location'
type NodePoolCol = 'name' | 'status' | 'min' | 'desired' | 'max' | 'machine' | 'version'
type SideTab = 'overview' | 'planner' | 'timeline'
type PlannerStatus = 'ready' | 'warning' | 'blocked' | 'unknown'

type PlannerCommand = {
  id: string
  label: string
  shell: 'gcloud' | 'kubectl'
  description: string
  command: string
}

type PlannerChecklistItem = {
  id: string
  title: string
  detail: string
  status: PlannerStatus
}

type PlannerNodePool = {
  nodePoolName: string
  currentVersion: string
  targetVersion: string
  status: PlannerStatus
  detail: string
  recommendedAction: string
}

const CLUSTER_COLUMNS: Array<{ key: ClusterCol; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'version', label: 'Version' },
  { key: 'location', label: 'Location' }
]

const NODEPOOL_COLUMNS: Array<{ key: NodePoolCol; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'min', label: 'Min' },
  { key: 'desired', label: 'Desired' },
  { key: 'max', label: 'Max' },
  { key: 'machine', label: 'Machine' },
  { key: 'version', label: 'Version' }
]

function formatDateTime(value: string): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function truncate(value: string, max = 52): string {
  if (!value) return '-'
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  const normalized = status.trim().toLowerCase()
  if (['running', 'done', 'successful', 'success', 'ready'].includes(normalized)) return 'success'
  if (['pending', 'creating', 'updating', 'reconciling', 'warning'].includes(normalized)) return 'warning'
  if (normalized.includes('error') || normalized.includes('fail') || normalized.includes('delet') || normalized.includes('degrad')) return 'danger'
  return 'info'
}

function plannerTone(status: PlannerStatus): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'ready') return 'success'
  if (status === 'warning') return 'warning'
  if (status === 'blocked') return 'danger'
  return 'info'
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`eks-badge ${statusTone(status)}`}>{status || 'UNKNOWN'}</span>
}

function MetricCard({
  label,
  value,
  note,
  tone = 'info'
}: {
  label: string
  value: string | number
  note: string
  tone?: 'success' | 'warning' | 'danger' | 'info'
}) {
  return <div className={`eks-stat-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="eks-kv-row"><div className="eks-kv-label">{label}</div><div className="eks-kv-value">{value || '-'}</div></div>
}

function getClusterValue(cluster: GcpGkeClusterSummary, key: ClusterCol): string {
  switch (key) {
    case 'name': return cluster.name
    case 'status': return cluster.status
    case 'version': return cluster.masterVersion
    case 'location': return cluster.location
  }
}

function getNodePoolValue(pool: GcpGkeNodePoolSummary, key: NodePoolCol): string {
  switch (key) {
    case 'name': return pool.name
    case 'status': return pool.status
    case 'min': return String(pool.minNodeCount)
    case 'desired': return String(pool.nodeCount)
    case 'max': return String(pool.maxNodeCount)
    case 'machine': return pool.machineType
    case 'version': return pool.version
  }
}

function accessSummary(detail: GcpGkeClusterDetail | null): string {
  if (!detail) return '-'
  return detail.privateClusterEnabled ? 'Private control plane' : 'Public endpoint'
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
}

function derivePlanner(
  projectId: string,
  detail: GcpGkeClusterDetail | null,
  nodePools: GcpGkeNodePoolSummary[],
  operations: GcpGkeOperationSummary[],
  targetVersion: string
) {
  if (!detail) {
    return null
  }

  const normalizedTarget = targetVersion.trim() || detail.masterVersion || '-'
  const warnings: string[] = []

  if (!detail.releaseChannel) warnings.push('Release channel is unspecified, so cadence and patch expectations are operator-managed.')
  if (!detail.maintenanceWindow) warnings.push('No recurring maintenance window is surfaced on the cluster.')
  if (!detail.privateClusterEnabled) warnings.push('Control plane endpoint is publicly reachable.')
  if (!detail.workloadIdentityPool) warnings.push('Workload Identity pool is not surfaced, which may indicate legacy node credentials.')
  if (nodePools.some((pool) => pool.status.trim().toUpperCase() !== 'RUNNING')) warnings.push('At least one node pool is not in RUNNING state.')

  const readiness = nodePools.map((pool) => {
    const currentVersion = pool.version || '-'
    const versionAligned = currentVersion === normalizedTarget
    const running = pool.status.trim().toUpperCase() === 'RUNNING'
    const status: PlannerStatus = !running ? 'blocked' : versionAligned ? 'ready' : 'warning'

    return {
      nodePoolName: pool.name,
      currentVersion,
      targetVersion: normalizedTarget,
      status,
      detail: !running
        ? 'Resolve the node pool lifecycle issue before scheduling cluster upgrades.'
        : versionAligned
          ? 'Node pool version already aligns with the target control-plane version.'
          : 'Node pool should be reviewed for skew and upgraded after the control plane window.',
      recommendedAction: !running
        ? 'Stabilize the pool first.'
        : versionAligned
          ? 'No immediate rollout action required.'
          : pool.autoUpgradeEnabled
            ? 'Auto-upgrade is enabled; validate maintenance timing and surge posture.'
            : 'Plan a node pool version upgrade in the same change window.'
    } satisfies PlannerNodePool
  })

  const supportStatus: PlannerStatus = readiness.some((pool) => pool.status === 'blocked')
    ? 'blocked'
    : readiness.some((pool) => pool.status === 'warning') || warnings.length
      ? 'warning'
      : 'ready'

  const maintenanceChecklist: PlannerChecklistItem[] = [
    {
      id: 'window',
      title: 'Maintenance window',
      detail: detail.maintenanceWindow || 'No maintenance window is currently surfaced on the cluster.',
      status: detail.maintenanceWindow ? 'ready' : 'warning'
    },
    {
      id: 'operations',
      title: 'Recent operations reviewed',
      detail: operations.length ? `${operations.length} recent operations were loaded for this cluster.` : 'No recent operations were returned for this cluster.',
      status: operations.length ? 'ready' : 'warning'
    },
    {
      id: 'nodepool-skew',
      title: 'Node pool skew review',
      detail: readiness.some((pool) => pool.status !== 'ready')
        ? 'One or more node pools need operator review before a version change.'
        : 'Node pools appear aligned with the selected target version.',
      status: readiness.some((pool) => pool.status === 'blocked') ? 'blocked' : readiness.some((pool) => pool.status === 'warning') ? 'warning' : 'ready'
    }
  ]

  const rollbackNotes = [
    'Capture node pool min/desired/max values before applying scaling or upgrade changes.',
    'Keep a copy of the current kubeconfig and the active maintenance policy before executing rollout commands.',
    'If an operation stalls, inspect the latest GKE operations timeline before retrying.'
  ]

  const commandHandoffs: PlannerCommand[] = [
    {
      id: 'cluster-upgrade',
      label: 'Upgrade control plane',
      shell: 'gcloud',
      description: 'Operator handoff for a control-plane version change. Review maintenance timing and node pool readiness first.',
      command: `gcloud container clusters upgrade ${detail.name} --master --cluster-version ${normalizedTarget} --project ${projectId} --location ${detail.location}`
    },
    ...readiness.map((pool) => ({
      id: `nodepool-upgrade:${pool.nodePoolName}`,
      label: `Upgrade ${pool.nodePoolName}`,
      shell: 'gcloud' as const,
      description: 'Operator handoff for node pool version alignment after the control-plane window.',
      command: `gcloud container clusters upgrade ${detail.name} --node-pool ${pool.nodePoolName} --cluster-version ${normalizedTarget} --project ${projectId} --location ${detail.location}`
    })),
    {
      id: 'kubectl-health',
      label: 'Post-change health check',
      shell: 'kubectl',
      description: 'Basic cluster and node verification once credentials are loaded into your local kubeconfig.',
      command: 'kubectl get nodes -o wide && kubectl get pods -A'
    }
  ]

  return {
    supportStatus,
    summary: supportStatus === 'ready'
      ? `Cluster ${detail.name} appears ready for a bounded change window targeting ${normalizedTarget}.`
      : supportStatus === 'blocked'
        ? `Cluster ${detail.name} has blocking issues that should be resolved before targeting ${normalizedTarget}.`
        : `Cluster ${detail.name} needs preflight review before targeting ${normalizedTarget}.`,
    warnings,
    rollbackNotes,
    maintenanceChecklist,
    nodePools: readiness,
    commandHandoffs
  }
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [clusters, setClusters] = useState<GcpGkeClusterSummary[]>([])
  const [selectedCluster, setSelectedCluster] = useState('')
  const [detail, setDetail] = useState<GcpGkeClusterDetail | null>(null)
  const [clusterSearch, setClusterSearch] = useState('')
  const [visibleClusterCols] = useState<Set<ClusterCol>>(new Set(['name', 'status', 'version', 'location']))
  const [nodePools, setNodePools] = useState<GcpGkeNodePoolSummary[]>([])
  const [nodePoolSearch, setNodePoolSearch] = useState('')
  const [visibleNodePoolCols] = useState<Set<NodePoolCol>>(new Set(['name', 'status', 'min', 'desired', 'max', 'machine', 'version']))
  const [selectedNodePool, setSelectedNodePool] = useState('')
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [showDescribe, setShowDescribe] = useState(false)
  const [showScale, setShowScale] = useState(false)
  const [scaleMin, setScaleMin] = useState('0')
  const [scaleDesired, setScaleDesired] = useState('0')
  const [scaleMax, setScaleMax] = useState('0')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleErr, setScaleErr] = useState('')
  const [timelineEvents, setTimelineEvents] = useState<GcpGkeOperationSummary[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [timelineStart, setTimelineStart] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => new Date().toISOString().slice(0, 10))
  const [credentials, setCredentials] = useState<GcpGkeClusterCredentials | null>(null)
  const [credentialsBusy, setCredentialsBusy] = useState(false)
  const [credentialsErr, setCredentialsErr] = useState('')
  const [showKubeconfigForm, setShowKubeconfigForm] = useState(false)
  const [kubeconfigContextName, setKubeconfigContextName] = useState('')
  const [kubeconfigLocation, setKubeconfigLocation] = useState('~/.kube/config')
  const [plannerTargetVersion, setPlannerTargetVersion] = useState('')
  const [plannerCopiedCommandId, setPlannerCopiedCommandId] = useState('')

  const activeClusterCols = CLUSTER_COLUMNS.filter((column) => visibleClusterCols.has(column.key))
  const activeNodePoolCols = NODEPOOL_COLUMNS.filter((column) => visibleNodePoolCols.has(column.key))

  const filteredClusters = useMemo(() => {
    const query = clusterSearch.trim().toLowerCase()
    if (!query) return clusters
    return clusters.filter((cluster) => activeClusterCols.some((column) => getClusterValue(cluster, column.key).toLowerCase().includes(query)))
  }, [activeClusterCols, clusterSearch, clusters])

  const filteredNodePools = useMemo(() => {
    const query = nodePoolSearch.trim().toLowerCase()
    if (!query) return nodePools
    return nodePools.filter((pool) => activeNodePoolCols.some((column) => getNodePoolValue(pool, column.key).toLowerCase().includes(query)))
  }, [activeNodePoolCols, nodePoolSearch, nodePools])

  const selectedNodePoolDetail = useMemo(
    () => nodePools.find((pool) => pool.name === selectedNodePool) ?? null,
    [nodePools, selectedNodePool]
  )

  const healthyClusters = useMemo(() => clusters.filter((cluster) => statusTone(cluster.status) === 'success').length, [clusters])
  const totalMaxNodes = useMemo(() => nodePools.reduce((sum, pool) => sum + (Number.isFinite(pool.maxNodeCount) ? pool.maxNodeCount : 0), 0), [nodePools])
  const filteredTimelineEvents = useMemo(() => {
    const start = new Date(`${timelineStart}T00:00:00`).getTime()
    const end = new Date(`${timelineEnd}T23:59:59`).getTime()
    return timelineEvents.filter((event) => {
      const timestamp = new Date(event.startedAt || event.endedAt || '').getTime()
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end
    })
  }, [timelineEnd, timelineEvents, timelineStart])

  const planner = useMemo(
    () => derivePlanner(projectId, detail, nodePools, timelineEvents, plannerTargetVersion || detail?.masterVersion || ''),
    [detail, nodePools, plannerTargetVersion, projectId, timelineEvents]
  )

  async function reloadInventory(preserveSelection = true): Promise<void> {
    setLoading(true)
    setError('')

    try {
      const nextClusters = await listGcpGkeClusters(projectId, location)
      setClusters(nextClusters)
      const nextSelected = preserveSelection && selectedCluster && nextClusters.some((cluster) => cluster.name === selectedCluster)
        ? selectedCluster
        : nextClusters[0]?.name ?? ''

      if (nextSelected) {
        await selectCluster(nextSelected, nextClusters)
      } else {
        setSelectedCluster('')
        setDetail(null)
        setNodePools([])
        setSelectedNodePool('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reloadInventory(false)
  }, [location, projectId, refreshNonce])

  async function selectCluster(name: string, sourceClusters = clusters): Promise<void> {
    const summary = sourceClusters.find((cluster) => cluster.name === name) ?? null
    setSelectedCluster(name)
    setDetail(null)
    setNodePools([])
    setSelectedNodePool('')
    setCredentials(null)
    setCredentialsErr('')
    setShowKubeconfigForm(false)
    setKubeconfigContextName(name)
    setKubeconfigLocation('~/.kube/config')
    setShowScale(false)
    setScaleErr('')
    setMsg('')
    setError('')
    setTimelineEvents([])
    setTimelineError('')
    setPlannerCopiedCommandId('')
    setPlannerTargetVersion(summary?.masterVersion ?? '')

    try {
      const [nextDetail, nextNodePools] = await Promise.all([
        getGcpGkeClusterDetail(projectId, summary?.location || location, name),
        listGcpGkeNodePools(projectId, summary?.location || location, name)
      ])
      setDetail(nextDetail)
      setNodePools(nextNodePools)
      setSelectedNodePool(nextNodePools[0]?.name ?? '')
      setPlannerTargetVersion(nextDetail.masterVersion || summary?.masterVersion || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function loadTimeline(): Promise<void> {
    if (!detail) return
    setTimelineLoading(true)
    setTimelineError('')

    try {
      const events = await listGcpGkeOperations(projectId, detail.location, detail.name)
      setTimelineEvents(events)
    } catch (err) {
      setTimelineEvents([])
      setTimelineError(err instanceof Error ? err.message : String(err))
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (sideTab === 'timeline' && detail) {
      void loadTimeline()
    }
  }, [detail?.location, detail?.name, sideTab])

  function openScaleForm(): void {
    const pool = selectedNodePoolDetail ?? nodePools[0] ?? null
    if (!pool) return
    setSelectedNodePool(pool.name)
    setScaleMin(String(pool.minNodeCount || 0))
    setScaleDesired(String(pool.nodeCount || 0))
    setScaleMax(String(pool.maxNodeCount || 0))
    setScaleErr('')
    setShowScale(true)
  }

  function openKubeconfigForm(): void {
    if (!detail && !selectedCluster) return
    setKubeconfigContextName(detail?.name || selectedCluster)
    setKubeconfigLocation('~/.kube/config')
    setCredentialsErr('')
    setShowKubeconfigForm(true)
  }

  async function handleScale(): Promise<void> {
    if (!detail || !selectedNodePool) return
    const minimum = Number(scaleMin)
    const desired = Number(scaleDesired)
    const maximum = Number(scaleMax)

    if ([minimum, desired, maximum].some((value) => Number.isNaN(value))) {
      setScaleErr('Values must be numbers.')
      return
    }
    if (minimum < 0 || desired < minimum || desired > maximum) {
      setScaleErr('Must satisfy: 0 <= min <= desired <= max')
      return
    }

    setScaleBusy(true)
    setScaleErr('')
    setError('')
    try {
      const result = await updateGcpGkeNodePoolScaling(projectId, detail.location, detail.name, selectedNodePool, minimum, desired, maximum)
      setMsg(result.summary)
      const [nextDetail, nextNodePools] = await Promise.all([
        getGcpGkeClusterDetail(projectId, detail.location, detail.name),
        listGcpGkeNodePools(projectId, detail.location, detail.name)
      ])
      setDetail(nextDetail)
      setNodePools(nextNodePools)
      setSelectedNodePool((current) => nextNodePools.some((pool) => pool.name === current) ? current : (nextNodePools[0]?.name ?? ''))
      setShowScale(false)
    } catch (err) {
      setScaleErr(err instanceof Error ? err.message : String(err))
    } finally {
      setScaleBusy(false)
    }
  }

  async function handleLoadCredentials(): Promise<void> {
    if (!detail) return
    const contextName = kubeconfigContextName.trim()
    const kubeconfigPath = kubeconfigLocation.trim()
    if (!contextName) {
      setCredentialsErr('Context name is required.')
      return
    }
    if (!kubeconfigPath) {
      setCredentialsErr('Config location is required.')
      return
    }
    setCredentialsBusy(true)
    setCredentialsErr('')
    setError('')
    try {
      const nextCredentials = await getGcpGkeClusterCredentials(projectId, detail.location, detail.name, contextName, kubeconfigPath)
      setCredentials(nextCredentials)
      setMsg(`Prepared kubeconfig material for ${detail.name} at ${kubeconfigPath}.`)
      setShowKubeconfigForm(false)
    } catch (err) {
      setCredentialsErr(err instanceof Error ? err.message : String(err))
    } finally {
      setCredentialsBusy(false)
    }
  }

  async function browseKubeconfigLocation(): Promise<void> {
    if (credentialsBusy) return
    setCredentialsErr('')
    try {
      const selectedPath = await chooseEksKubeconfigPath(kubeconfigLocation)
      if (selectedPath) setKubeconfigLocation(selectedPath)
    } catch (err) {
      setCredentialsErr(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCopyCredentials(label: string, value: string): Promise<void> {
    try {
      await copyText(value)
      setMsg(`${label} copied.`)
    } catch (err) {
      setCredentialsErr(err instanceof Error ? err.message : `Unable to copy ${label.toLowerCase()}.`)
    }
  }

  async function handleCopyPlannerCommand(command: PlannerCommand): Promise<void> {
    try {
      await copyText(command.command)
      setPlannerCopiedCommandId(command.id)
      window.setTimeout(() => {
        setPlannerCopiedCommandId((current) => current === command.id ? '' : current)
      }, 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy command')
    }
  }

  function handleRunPlannerCommand(command: PlannerCommand): void {
    if (!canRunTerminalCommand) return
    onRunTerminalCommand(command.command)
    setMsg(`${command.label} command sent to the app terminal`)
  }

  if (loading && !clusters.length) {
    return <SvcState variant="loading" resourceName="GKE clusters" />
  }

  return (
    <div className="eks-console gcp-gke-console">
      <section className="eks-shell-hero gcp-gke-hero">
        <div className="eks-shell-hero-copy">
          <div className="eyebrow">GKE service</div>
          <h2>{detail ? detail.name : 'Kubernetes operations center'}</h2>
          <p>
            {detail
              ? `Inspect control plane posture, node pool capacity, GKE operations, and credential workflows for ${detail.name}.`
              : 'Review cluster health, drill into node pools, and move through change planning from one GKE workspace.'}
          </p>
          <div className="eks-shell-meta-strip">
            <div className="eks-shell-meta-pill"><span>Project</span><strong>{projectId}</strong></div>
            <div className="eks-shell-meta-pill"><span>Location</span><strong>{location || 'All locations'}</strong></div>
            <div className="eks-shell-meta-pill"><span>Selected cluster</span><strong>{selectedCluster || 'None selected'}</strong></div>
            <div className="eks-shell-meta-pill"><span>Access</span><strong>{accessSummary(detail)}</strong></div>
          </div>
        </div>
        <div className="eks-shell-hero-stats">
          <MetricCard label="Clusters" value={clusters.length} note="In the selected project/location slice" tone="info" />
          <MetricCard label="Healthy" value={healthyClusters} note="Clusters currently reporting RUNNING" tone="success" />
          <MetricCard label="Node pools" value={selectedCluster ? nodePools.length : 0} note={selectedCluster ? 'Attached to the selected cluster' : 'Select a cluster to inspect capacity'} />
          <MetricCard label="Max nodes" value={selectedCluster ? totalMaxNodes : 0} note={selectedCluster ? 'Aggregated autoscaling ceiling across visible pools' : 'No cluster selected yet'} tone="warning" />
        </div>
      </section>

      <div className="eks-shell-toolbar gcp-gke-toolbar">
        <div className="eks-toolbar-left">
          <button className="eks-toolbar-btn accent" type="button" onClick={() => void reloadInventory()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          <button className="eks-toolbar-btn" type="button" onClick={() => setShowDescribe((current) => !current)} disabled={!selectedCluster}>
            {showDescribe ? 'Hide details' : 'Describe cluster'}
          </button>
          <button className="eks-toolbar-btn" type="button" onClick={openScaleForm} disabled={!selectedCluster || !nodePools.length}>
            Scale node pool
          </button>
          <button className="eks-toolbar-btn" type="button" onClick={openKubeconfigForm} disabled={!selectedCluster || credentialsBusy}>
            Add To Kubeconfig
          </button>
        </div>
        <div className="eks-shell-status">
          <div className="eks-status-card"><span>Inventory</span><strong>{loading ? 'Refreshing' : `${clusters.length} clusters loaded`}</strong></div>
          <div className="eks-status-card"><span>Selection</span><strong>{selectedCluster ? truncate(selectedCluster, 28) : 'Waiting for selection'}</strong></div>
          <div className="eks-status-card"><span>Mode</span><strong>{sideTab === 'overview' ? 'Capacity review' : sideTab === 'planner' ? 'Upgrade planner' : 'Change timeline'}</strong></div>
        </div>
      </div>

      {error && <SvcState variant="error" error={error} />}
      {msg && <div className="eks-msg">{msg}</div>}

      <div className="eks-main-layout">
        <div className="eks-project-table-area">
          <section className="eks-projects-panel">
            <div className="eks-section-head">
              <div><span className="eks-section-kicker">Inventory</span><h3>Cluster fleet</h3></div>
              <span className="eks-section-hint">Search by cluster name, version, status, or location.</span>
            </div>
            <input className="eks-search-input" value={clusterSearch} onChange={(event) => setClusterSearch(event.target.value)} placeholder="Filter clusters..." />
            <div className="eks-table-shell gcp-gke-inventory-table-wrap">
              <div className="eks-ng-scroll">
                <table className="eks-data-table">
                  <thead>
                    <tr>{activeClusterCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {!filteredClusters.length && (
                      <tr><td colSpan={activeClusterCols.length} className="eks-table-empty">No clusters found.</td></tr>
                    )}
                    {filteredClusters.map((cluster) => (
                      <tr key={`${cluster.location}:${cluster.name}`} className={cluster.name === selectedCluster ? 'active' : ''} onClick={() => void selectCluster(cluster.name)}>
                        {activeClusterCols.map((column) => (
                          <td key={column.key}>
                            {column.key === 'status' ? <StatusBadge status={cluster.status} /> : getClusterValue(cluster, column.key)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        <div className="eks-detail-pane gcp-gke-detail-pane">
          {!detail ? (
            <SvcState variant="no-selection" message="Select a cluster to inspect detail, node pools, and change posture." />
          ) : (
            <>
              <section className="eks-detail-hero gcp-gke-selected-hero">
                <div className="eks-detail-hero-copy">
                  <div className="eyebrow">Cluster posture</div>
                  <h3>{detail.name}</h3>
                  <p>Control plane version {detail.masterVersion || '-'} in {detail.location || location}. Review node pool posture, credentials, and recent GKE operations from this workspace.</p>
                  <div className="eks-detail-meta-strip">
                    <div className="eks-detail-meta-pill"><span>Status</span><strong>{detail.status}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Location</span><strong>{detail.location || location}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Access</span><strong>{accessSummary(detail)}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Release channel</span><strong>{detail.releaseChannel || 'unspecified'}</strong></div>
                  </div>
                </div>
                <div className="eks-detail-hero-stats">
                  <MetricCard label="Node pools" value={nodePools.length} note={selectedNodePoolDetail ? `${selectedNodePoolDetail.name} selected` : 'No node pools found'} />
                  <MetricCard label="Maintenance" value={detail.maintenanceWindow || 'Missing'} note="Current recurring change window" tone={detail.maintenanceWindow ? 'info' : 'warning'} />
                  <MetricCard label="Workload Identity" value={detail.workloadIdentityPool ? 'Enabled' : 'Unknown'} note={detail.workloadIdentityPool || 'No workload identity pool surfaced'} tone={detail.workloadIdentityPool ? 'success' : 'warning'} />
                  <MetricCard label="Endpoint" value={detail.privateClusterEnabled ? 'Private' : 'Public'} note="Control plane accessibility" tone={detail.privateClusterEnabled ? 'success' : 'warning'} />
                </div>
              </section>

              <div className="eks-detail-tabs">
                <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>Overview</button>
                <button className={sideTab === 'planner' ? 'active' : ''} type="button" onClick={() => setSideTab('planner')}>Upgrade planner</button>
                <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>Change timeline</button>
              </div>

              {sideTab === 'overview' && (
                <section className="eks-section eks-nodegroups-section">
                  {showDescribe && (
                    <section className="eks-section eks-cluster-details-panel">
                      <div className="eks-section-head">
                        <div><span className="eks-section-kicker">Describe</span><h4>Cluster details</h4></div>
                        <span className="eks-section-hint">Detailed control plane, networking, and maintenance configuration from the Container API.</span>
                      </div>
                      <div className="eks-kv">
                        <InfoRow label="Endpoint" value={detail.endpoint} />
                        <InfoRow label="Master version" value={detail.masterVersion} />
                        <InfoRow label="Node version" value={detail.nodeVersion} />
                        <InfoRow label="Network / Subnetwork" value={[detail.network, detail.subnetwork].filter(Boolean).join(' / ')} />
                        <InfoRow label="Workload Identity" value={detail.workloadIdentityPool || '-'} />
                        <InfoRow label="Maintenance window" value={detail.maintenanceWindow || 'Not configured'} />
                        <InfoRow label="Maintenance exclusions" value={detail.maintenanceExclusions.join(' | ') || 'None surfaced'} />
                        <InfoRow label="Service CIDR" value={detail.servicesIpv4Cidr || '-'} />
                        <InfoRow label="Control plane CIDR" value={detail.controlPlaneIpv4Cidr || '-'} />
                        <InfoRow label="Logging / Monitoring" value={[detail.loggingService, detail.monitoringService].filter(Boolean).join(' / ') || '-'} />
                      </div>
                    </section>
                  )}

                  <section className="eks-section gcp-gke-operations-section">
                    <div className="eks-section-head">
                      <div><span className="eks-section-kicker">Operations</span><h4>Cluster actions</h4></div>
                      <span className="eks-section-hint">Run credential loading, capacity changes, and describe toggles without burying actions inside the table.</span>
                    </div>
                    <div className="eks-action-grid">
                      <button type="button" className="eks-action-btn" onClick={() => setShowDescribe((current) => !current)}>
                        {showDescribe ? 'Hide describe' : 'Describe cluster'}
                      </button>
                      <button type="button" className="eks-action-btn accent" onClick={openKubeconfigForm} disabled={credentialsBusy}>
                        Add To Kubeconfig
                      </button>
                      <button type="button" className="eks-action-btn" onClick={openScaleForm} disabled={!nodePools.length}>Scale node pool</button>
                      <button type="button" className="eks-action-btn" onClick={() => void loadTimeline()}>Refresh timeline</button>
                    </div>
                    {showScale && (
                      <section className="eks-inline-panel gcp-gke-scale-panel">
                        <div className="eks-section-head">
                          <div><span className="eks-section-kicker">Scale</span><h4>Update node pool bounds</h4></div>
                          <button type="button" className="eks-toolbar-btn" onClick={() => setShowScale(false)} disabled={scaleBusy}>Close</button>
                        </div>
                        <div className="eks-form-grid">
                          <label>
                            Node pool
                            <select value={selectedNodePool} onChange={(event) => setSelectedNodePool(event.target.value)}>
                              {nodePools.map((pool) => <option key={pool.name} value={pool.name}>{pool.name}</option>)}
                            </select>
                          </label>
                          <label>Min<input value={scaleMin} onChange={(event) => setScaleMin(event.target.value)} /></label>
                          <label>Desired<input value={scaleDesired} onChange={(event) => setScaleDesired(event.target.value)} /></label>
                          <label>Max<input value={scaleMax} onChange={(event) => setScaleMax(event.target.value)} /></label>
                        </div>
                        <div className="eks-inline-actions">
                          <button type="button" className="eks-toolbar-btn" onClick={() => setShowScale(false)} disabled={scaleBusy}>Cancel</button>
                          <button type="button" className="eks-toolbar-btn accent" onClick={() => void handleScale()} disabled={scaleBusy}>{scaleBusy ? 'Applying...' : 'Apply scaling'}</button>
                        </div>
                        {scaleErr && <div className="eks-inline-error">{scaleErr}</div>}
                      </section>
                    )}
                  </section>

                  <div className="eks-section-head">
                    <div><span className="eks-section-kicker">Capacity</span><h4>Node pool inventory</h4></div>
                    <span className="eks-section-hint">Review autoscaling bounds, machine types, and pool versions from the selected cluster.</span>
                  </div>
                  <input className="eks-search-input" value={nodePoolSearch} onChange={(event) => setNodePoolSearch(event.target.value)} placeholder="Filter node pools..." />

                  <div className="eks-nodegroup-layout">
                    <div className="eks-table-shell gcp-gke-nodepool-table-wrap">
                      <div className="eks-ng-scroll">
                        <table className="eks-data-table">
                          <thead>
                            <tr>{activeNodePoolCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
                          </thead>
                          <tbody>
                            {!filteredNodePools.length && <tr><td colSpan={activeNodePoolCols.length} className="eks-table-empty">{selectedCluster ? 'No node pools found.' : 'Select a cluster.'}</td></tr>}
                            {filteredNodePools.map((pool) => (
                              <tr key={pool.name} className={pool.name === selectedNodePool ? 'active' : ''} onClick={() => setSelectedNodePool(pool.name)}>
                                {activeNodePoolCols.map((column) => (
                                  <td key={column.key}>
                                    {column.key === 'status' ? <StatusBadge status={pool.status} /> : getNodePoolValue(pool, column.key)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <aside className="eks-side-card">
                      <div className="eks-section-head">
                        <div><span className="eks-section-kicker">Selection</span><h4>{selectedNodePoolDetail?.name || 'Node pool details'}</h4></div>
                      </div>
                      {selectedNodePoolDetail ? (
                        <>
                          <div className="eks-side-card-grid">
                            <MetricCard label="Desired" value={selectedNodePoolDetail.nodeCount} note="Requested or initial node count surfaced" tone="warning" />
                            <MetricCard label="Min" value={selectedNodePoolDetail.minNodeCount} note="Lower autoscaling bound" />
                            <MetricCard label="Max" value={selectedNodePoolDetail.maxNodeCount} note="Upper autoscaling bound" />
                            <MetricCard label="Status" value={selectedNodePoolDetail.status} note="Latest lifecycle state" tone={statusTone(selectedNodePoolDetail.status)} />
                          </div>
                          <div className="eks-mini-kv">
                            <InfoRow label="Machine type" value={selectedNodePoolDetail.machineType || '-'} />
                            <InfoRow label="Image type" value={selectedNodePoolDetail.imageType || '-'} />
                            <InfoRow label="Management" value={[
                              selectedNodePoolDetail.autoUpgradeEnabled ? 'Auto-upgrade' : '',
                              selectedNodePoolDetail.autoRepairEnabled ? 'Auto-repair' : ''
                            ].filter(Boolean).join(' / ') || 'Manual'} />
                            <InfoRow label="Locations" value={selectedNodePoolDetail.locations.join(', ') || '-'} />
                          </div>
                        </>
                      ) : <SvcState variant="empty" resourceName="node pool" compact />}
                    </aside>
                  </div>
                </section>
              )}

              {sideTab === 'overview' && credentials && (
                <section className="eks-section">
                  <div className="eks-section-head">
                    <div><span className="eks-section-kicker">Kubeconfig</span><h4>Short-lived kubeconfig material</h4></div>
                    <span className="eks-section-hint">Generated from the current Application Default Credentials context and prepared for the selected config path.</span>
                  </div>
                  <div className="eks-side-card-grid">
                    <MetricCard label="Context" value={truncate(credentials.contextName, 26)} note="Generated kubeconfig context name" />
                    <MetricCard label="Config path" value={truncate(credentials.kubeconfigPath, 26)} note="Target file selected before generating kubeconfig" />
                    <MetricCard label="Auth" value={credentials.authProvider} note={credentials.tokenExpiresAt ? `Expires ${formatDateTime(credentials.tokenExpiresAt)}` : 'Expiry was not returned by the auth client'} />
                    <MetricCard label="Token" value={credentials.tokenPreview || '-'} note="Short-lived bearer token preview" tone="warning" />
                  </div>
                  <div className="eks-inline-actions">
                    <button className="eks-toolbar-btn" type="button" onClick={() => void handleCopyCredentials('Token', credentials.bearerToken)}>Copy token</button>
                    <button className="eks-toolbar-btn" type="button" onClick={() => void handleCopyCredentials('Cluster CA', credentials.certificateAuthorityData)}>Copy cluster CA</button>
                    <button className="eks-toolbar-btn accent" type="button" onClick={() => void handleCopyCredentials('Kubeconfig', credentials.kubeconfigYaml)}>Copy kubeconfig</button>
                  </div>
                  {credentialsErr && <div className="eks-inline-error">{credentialsErr}</div>}
                  <pre className="eks-command-block"><code>{credentials.kubeconfigYaml}</code></pre>
                </section>
              )}

                {sideTab === 'planner' && (
                  <section className="eks-section eks-planner-shell">
                    <div className="eks-section-head">
                      <div><span className="eks-section-kicker">Upgrade planner</span><h4>Read-only GKE change review</h4></div>
                      <span className="eks-section-hint">Build a bounded version plan from cluster, node pool, and operations data. This planner does not execute upgrades in-app.</span>
                    </div>
                    <div className="eks-planner-toolbar">
                      <label>
                        Target Kubernetes version
                        <input
                          value={plannerTargetVersion}
                          onChange={(event) => setPlannerTargetVersion(event.target.value)}
                          placeholder={detail.masterVersion || '1.xx'}
                        />
                      </label>
                    </div>
                    {!planner ? (
                      <SvcState variant="empty" resourceName="upgrade plan" compact />
                    ) : (
                      <>
                        <section className="eks-planner-summary">
                          <div className="eks-side-card">
                            <div className="eks-section-head">
                              <div><span className="eks-section-kicker">Plan summary</span><h4>{detail.name}</h4></div>
                              <StatusBadge status={planner.supportStatus} />
                            </div>
                            <div className="eks-side-card-grid">
                              <MetricCard label="Current version" value={detail.masterVersion || '-'} note="Current control-plane Kubernetes version" />
                              <MetricCard label="Target version" value={plannerTargetVersion || detail.masterVersion || '-'} note="Editable target for the next change window" tone={plannerTone(planner.supportStatus)} />
                              <MetricCard label="Node pools" value={nodePools.length} note="Pools reviewed for version skew and status" tone={plannerTone(planner.supportStatus)} />
                              <MetricCard label="Maintenance" value={detail.maintenanceWindow || 'Missing'} note="Current recurring change window" tone={detail.maintenanceWindow ? 'info' : 'warning'} />
                            </div>
                            <p className="eks-planner-lead">{planner.summary}</p>
                            <div className="eks-mini-kv">
                              <InfoRow label="Release channel" value={detail.releaseChannel || 'unspecified'} />
                              <InfoRow label="Workload Identity" value={detail.workloadIdentityPool || '-'} />
                              <InfoRow label="Recent operations reviewed" value={String(timelineEvents.length)} />
                            </div>
                          </div>
                          <div className="eks-side-card">
                            <div className="eks-section-head">
                              <div><span className="eks-section-kicker">Warnings</span><h4>Preflight notes</h4></div>
                            </div>
                            {planner.warnings.length > 0 ? (
                              <div className="eks-planner-list">
                                {planner.warnings.map((warning) => (
                                  <div key={warning} className="eks-planner-list-item warning">
                                    <span className="eks-planner-list-dot" />
                                    <div>{warning}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <SvcState variant="empty" resourceName="planner warnings" compact />
                            )}
                          </div>
                        </section>

                        <section className="eks-section">
                          <div className="eks-section-head">
                            <div><span className="eks-section-kicker">Node pools</span><h4>Upgrade readiness</h4></div>
                            <span className="eks-section-hint">Review pool status, version skew, and management posture before changing the control plane.</span>
                          </div>
                          <div className="eks-planner-card-grid">
                            {planner.nodePools.map((pool) => (
                              <article key={pool.nodePoolName} className="eks-planner-card">
                                <div className="eks-project-row-top">
                                  <strong>{pool.nodePoolName}</strong>
                                  <StatusBadge status={pool.status} />
                                </div>
                                <div className="eks-planner-meta">
                                  <span>{`${pool.currentVersion} -> ${pool.targetVersion}`}</span>
                                </div>
                                <p>{pool.detail}</p>
                                <small>{pool.recommendedAction}</small>
                              </article>
                            ))}
                          </div>
                        </section>

                        <div className="eks-planner-summary">
                          <section className="eks-section">
                            <div className="eks-section-head">
                              <div><span className="eks-section-kicker">Checklist</span><h4>Maintenance window prep</h4></div>
                            </div>
                            <div className="eks-planner-list">
                              {planner.maintenanceChecklist.map((item) => (
                                <div key={item.id} className={`eks-planner-list-item ${item.status}`}>
                                  <span className="eks-planner-list-dot" />
                                  <div>
                                    <strong>{item.title}</strong>
                                    <p>{item.detail}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
                          <section className="eks-section">
                            <div className="eks-section-head">
                              <div><span className="eks-section-kicker">Rollback</span><h4>Operator notes</h4></div>
                            </div>
                            <div className="eks-planner-list">
                              {planner.rollbackNotes.map((note) => (
                                <div key={note} className="eks-planner-list-item">
                                  <span className="eks-planner-list-dot" />
                                  <div>{note}</div>
                                </div>
                              ))}
                            </div>
                          </section>
                        </div>

                        <section className="eks-section">
                          <div className="eks-section-head">
                            <div><span className="eks-section-kicker">Handoff commands</span><h4>CLI and kubectl snippets</h4></div>
                            <span className="eks-section-hint">Shown for operator handoff only. Core describe, credentials, and node pool inspection are available directly in the UI.</span>
                          </div>
                          <div className="eks-planner-card-grid">
                            {planner.commandHandoffs.map((command) => (
                              <article key={command.id} className="eks-planner-card">
                                <div className="eks-project-row-top">
                                  <strong>{command.label}</strong>
                                  <StatusBadge status={command.shell} />
                                </div>
                                <p>{command.description}</p>
                                <pre className="eks-command-block"><code>{command.command}</code></pre>
                                <div className="eks-inline-actions">
                                  <button className="eks-toolbar-btn" type="button" onClick={() => void handleCopyPlannerCommand(command)}>
                                    {plannerCopiedCommandId === command.id ? 'Copied' : 'Copy command'}
                                  </button>
                                  <button className="eks-toolbar-btn" type="button" onClick={() => handleRunPlannerCommand(command)} disabled={!canRunTerminalCommand}>
                                    Run in terminal
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                        </section>
                      </>
                    )}
                  </section>
                )}

                {sideTab === 'timeline' && (
                  <section className="eks-section">
                    <div className="eks-section-head">
                      <div><span className="eks-section-kicker">GKE operations</span><h4>Change timeline</h4></div>
                    </div>
                    <div className="eks-timeline-controls">
                      <label>From<input type="date" value={timelineStart} onChange={(event) => setTimelineStart(event.target.value)} /></label>
                      <label>To<input type="date" value={timelineEnd} onChange={(event) => setTimelineEnd(event.target.value)} /></label>
                      <button className="eks-toolbar-btn" type="button" onClick={() => void loadTimeline()} disabled={timelineLoading}>
                        {timelineLoading ? 'Refreshing...' : 'Refresh timeline'}
                      </button>
                    </div>
                    {timelineLoading && <SvcState variant="loading" resourceName="operations" compact />}
                    {!timelineLoading && timelineError && <SvcState variant="error" error={timelineError} compact />}
                    {!timelineLoading && !timelineError && filteredTimelineEvents.length === 0 && <SvcState variant="empty" resourceName="GKE operations" compact />}
                    {!timelineLoading && filteredTimelineEvents.length > 0 && (
                      <div className="eks-table-shell eks-timeline-table-wrap">
                        <table className="eks-timeline-table">
                          <thead><tr><th>Operation</th><th>Status</th><th>Target</th><th>Started</th><th>Ended</th></tr></thead>
                          <tbody>
                            {filteredTimelineEvents.map((event) => (
                              <tr key={event.id}>
                                <td title={event.detail || event.id}>{event.type || truncate(event.id, 32)}</td>
                                <td><StatusBadge status={event.status} /></td>
                                <td>{truncate(event.target || '-', 28)}</td>
                                <td>{formatDateTime(event.startedAt)}</td>
                                <td>{formatDateTime(event.endedAt)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      {showKubeconfigForm && (
        <div className="eks-modal-backdrop" onClick={() => { if (!credentialsBusy) setShowKubeconfigForm(false) }}>
          <section className="eks-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="eks-section-head">
              <div><span className="eks-section-kicker">Kubeconfig</span><h4>Add selected cluster</h4></div>
            </div>
            <div className="eks-form-grid">
              <label>
                Context name
                <input
                  value={kubeconfigContextName}
                  onChange={(event) => setKubeconfigContextName(event.target.value)}
                  placeholder="my-gke-context"
                  autoFocus
                />
              </label>
              <label>
                Config location
                <div className="eks-picker-field">
                  <input
                    value={kubeconfigLocation}
                    onChange={(event) => setKubeconfigLocation(event.target.value)}
                    placeholder="~/.kube/config"
                  />
                  <button type="button" className="eks-toolbar-btn" onClick={() => void browseKubeconfigLocation()} disabled={credentialsBusy}>
                    Browse
                  </button>
                </div>
              </label>
            </div>
            <div className="eks-inline-actions">
              <button type="button" className="eks-toolbar-btn" onClick={() => setShowKubeconfigForm(false)} disabled={credentialsBusy}>Cancel</button>
              <button type="button" className="eks-toolbar-btn accent" onClick={() => void handleLoadCredentials()} disabled={credentialsBusy}>
                {credentialsBusy ? 'Preparing...' : 'Add To Kubeconfig'}
              </button>
            </div>
            {credentialsErr && <div className="eks-inline-error">{credentialsErr}</div>}
          </section>
        </div>
      )}
      </div>
  )
}
