import { useEffect, useMemo, useRef, useState } from 'react'
import './eks.css'
import { SvcState } from './SvcState'
import type {
  AwsConnection,
  CloudTrailEventSummary,
  CorrelatedSignalReference,
  EksClusterDetail,
  EksClusterSummary,
  EksNodegroupSummary,
  ObservabilityPostureReport
} from '@shared/types'
import {
  addEksToKubeconfig,
  chooseEksKubeconfigPath,
  describeEksCluster,
  getEksObservabilityReport,
  listEksClusters,
  listEksNodegroups,
  lookupCloudTrailEventsByResource,
  prepareEksKubectlSession,
  runEksCommand,
  updateEksNodegroupScaling
} from './api'
import { ObservabilityResilienceLab } from './ObservabilityResilienceLab'

type ClusterCol = 'name' | 'status' | 'version'
type NgCol = 'name' | 'status' | 'min' | 'desired' | 'max' | 'cpu7d' | 'mem7d' | 'recommendation' | 'instanceTypes'

const CLUSTER_COLUMNS: { key: ClusterCol; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#4a8fe7' },
  { key: 'status', label: 'Status', color: '#59c58c' },
  { key: 'version', label: 'Version', color: '#f59a3d' }
]

const NG_COLUMNS: { key: NgCol; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#4a8fe7' },
  { key: 'status', label: 'Status', color: '#59c58c' },
  { key: 'min', label: 'Min', color: '#9ec7ff' },
  { key: 'desired', label: 'Desired', color: '#f59a3d' },
  { key: 'max', label: 'Max', color: '#ff8f7d' },
  { key: 'cpu7d', label: 'CPU7d', color: '#7adbd1' },
  { key: 'mem7d', label: 'Mem7d', color: '#b59cff' },
  { key: 'recommendation', label: 'Recommendation', color: '#d3b46f' },
  { key: 'instanceTypes', label: 'Instance types', color: '#f285b9' }
]

function getNgValue(ng: EksNodegroupSummary, key: NgCol): string {
  switch (key) {
    case 'name': return ng.name
    case 'status': return ng.status
    case 'min': return String(ng.min)
    case 'desired': return String(ng.desired)
    case 'max': return String(ng.max)
    case 'cpu7d': return '-'
    case 'mem7d': return '-'
    case 'recommendation': return '-'
    case 'instanceTypes': return ng.instanceTypes
  }
}

function formatDateTime(value: string): string {
  if (!value || value === '-') return '-'
  try { return new Date(value).toLocaleString() } catch { return value }
}

function truncate(value: string, max = 52): string {
  if (!value) return '-'
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  const s = status.toLowerCase()
  if (s === 'active' || s === 'running' || s === 'successful') return 'success'
  if (s === 'creating' || s === 'updating' || s === 'pending') return 'warning'
  if (s.includes('delet') || s.includes('fail') || s.includes('degrad')) return 'danger'
  return 'info'
}

function accessSummary(detail: EksClusterDetail | null): string {
  if (!detail) return '-'
  if (detail.endpointPublicAccess && detail.endpointPrivateAccess) return 'Public + private'
  if (detail.endpointPrivateAccess) return 'Private only'
  if (detail.endpointPublicAccess) return 'Public only'
  return 'Restricted'
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`eks-badge ${statusTone(status)}`}>{status}</span>
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

export function EksConsole({
  connection,
  focusClusterName,
  onRunTerminalCommand
}: {
  connection: AwsConnection
  focusClusterName?: { token: number; clusterName: string } | null
  onRunTerminalCommand?: (command: string) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [clusters, setClusters] = useState<EksClusterSummary[]>([])
  const [selectedCluster, setSelectedCluster] = useState('')
  const [detail, setDetail] = useState<EksClusterDetail | null>(null)
  const [clusterSearch, setClusterSearch] = useState('')
  const [visibleClusterCols, setVisibleClusterCols] = useState<Set<ClusterCol>>(new Set(['name', 'status', 'version']))
  const [nodegroups, setNodegroups] = useState<EksNodegroupSummary[]>([])
  const [ngSearch, setNgSearch] = useState('')
  const [visibleNgCols, setVisibleNgCols] = useState<Set<NgCol>>(new Set(['name', 'status', 'min', 'desired', 'max', 'cpu7d', 'mem7d', 'recommendation', 'instanceTypes']))
  const [selectedNg, setSelectedNg] = useState('')
  const [sideTab, setSideTab] = useState<'overview' | 'timeline' | 'lab'>('overview')
  const [showDescribe, setShowDescribe] = useState(false)
  const [showScale, setShowScale] = useState(false)
  const [scaleMin, setScaleMin] = useState('')
  const [scaleDesired, setScaleDesired] = useState('')
  const [scaleMax, setScaleMax] = useState('')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleErr, setScaleErr] = useState('')
  const [showKubeconfigForm, setShowKubeconfigForm] = useState(false)
  const [kubeconfigContextName, setKubeconfigContextName] = useState('')
  const [kubeconfigLocation, setKubeconfigLocation] = useState('.kube/config')
  const [kubeconfigBusy, setKubeconfigBusy] = useState(false)
  const [kubeconfigErr, setKubeconfigErr] = useState('')
  const [timelineEvents, setTimelineEvents] = useState<CloudTrailEventSummary[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [timelineStart, setTimelineStart] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => new Date().toISOString().slice(0, 10))
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalCmd, setTerminalCmd] = useState('')
  const [terminalBusy, setTerminalBusy] = useState(false)
  const [terminalKubeconfigPath, setTerminalKubeconfigPath] = useState('')
  const terminalOutputRef = useRef<HTMLDivElement>(null)
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  const [labReport, setLabReport] = useState<ObservabilityPostureReport | null>(null)
  const [labLoading, setLabLoading] = useState(false)
  const [labError, setLabError] = useState('')

  const activeClusterCols = CLUSTER_COLUMNS.filter((column) => visibleClusterCols.has(column.key))
  const activeNgCols = NG_COLUMNS.filter((column) => visibleNgCols.has(column.key))
  const showClusterName = visibleClusterCols.has('name')
  const showClusterStatus = visibleClusterCols.has('status')
  const showClusterVersion = visibleClusterCols.has('version')
  const filteredClusters = useMemo(() => {
    const q = clusterSearch.trim().toLowerCase()
    if (!q) return clusters
    return clusters.filter((cluster) => activeClusterCols.some((column) => {
      const value = column.key === 'name' ? cluster.name : column.key === 'status' ? cluster.status : cluster.version
      return value.toLowerCase().includes(q)
    }))
  }, [activeClusterCols, clusterSearch, clusters])
  const filteredNodegroups = useMemo(() => {
    const q = ngSearch.trim().toLowerCase()
    if (!q) return nodegroups
    return nodegroups.filter((nodegroup) => activeNgCols.some((column) => getNgValue(nodegroup, column.key).toLowerCase().includes(q)))
  }, [activeNgCols, ngSearch, nodegroups])
  const selectedNodegroup = useMemo(() => nodegroups.find((nodegroup) => nodegroup.name === selectedNg) ?? null, [nodegroups, selectedNg])
  const healthyClusters = useMemo(() => clusters.filter((cluster) => statusTone(cluster.status) === 'success').length, [clusters])
  const totalDesiredNodes = useMemo(() => nodegroups.reduce((sum, nodegroup) => sum + Number(nodegroup.desired || 0), 0), [nodegroups])

  async function reload() {
    setLoading(true)
    setError('')
    try {
      const list = await listEksClusters(connection)
      setClusters(list)
      if (list.length && !selectedCluster) await selectCluster(list[0].name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (!focusClusterName || focusClusterName.token === appliedFocusToken) return
    const match = clusters.find((cluster) => cluster.name === focusClusterName.clusterName)
    if (!match) return
    setAppliedFocusToken(focusClusterName.token)
    setSideTab('overview')
    void selectCluster(match.name)
  }, [appliedFocusToken, clusters, focusClusterName])

  async function selectCluster(name: string) {
    setSelectedCluster(name)
    setError('')
    setMsg('')
    setTerminalOpen(false)
    setTerminalKubeconfigPath('')
    setShowDescribe(false)
    setShowScale(false)
    setShowKubeconfigForm(false)
    setKubeconfigContextName(name)
    setKubeconfigLocation('.kube/config')
    setKubeconfigErr('')
    setLabReport(null)
    setLabError('')
    try {
      const [clusterDetail, clusterNodegroups] = await Promise.all([
        describeEksCluster(connection, name),
        listEksNodegroups(connection, name)
      ])
      setDetail(clusterDetail)
      setNodegroups(clusterNodegroups)
      setSelectedNg(clusterNodegroups[0]?.name ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function loadTimeline() {
    if (!selectedCluster) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const events = await lookupCloudTrailEventsByResource(
        connection,
        selectedCluster,
        new Date(timelineStart).toISOString(),
        new Date(`${timelineEnd}T23:59:59`).toISOString()
      )
      setTimelineEvents(events)
    } catch (e) {
      setTimelineEvents([])
      setTimelineError(e instanceof Error ? e.message : 'Failed to load events')
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (sideTab === 'timeline' && selectedCluster) void loadTimeline()
  }, [sideTab, selectedCluster, timelineStart, timelineEnd])

  async function loadLab() {
    if (!selectedCluster) return
    setLabLoading(true)
    setLabError('')
    try {
      const report = await getEksObservabilityReport(connection, selectedCluster)
      setLabReport(report)
    } catch (e) {
      setLabError(e instanceof Error ? e.message : 'Failed to load observability lab')
    } finally {
      setLabLoading(false)
    }
  }

  useEffect(() => {
    if (sideTab !== 'lab' || !selectedCluster) return
    if (labReport?.scope.kind === 'eks' && labReport.scope.clusterName === selectedCluster) return
    void loadLab()
  }, [connection, labReport, selectedCluster, sideTab])

  function handleLabSignalNavigate(signal: CorrelatedSignalReference) {
    if (signal.targetView === 'timeline') setSideTab('timeline')
  }

  function openKubeconfigForm() {
    if (!selectedCluster) return
    setShowKubeconfigForm(true)
    setKubeconfigContextName(selectedCluster)
    setKubeconfigLocation('.kube/config')
    setKubeconfigErr('')
  }

  async function browseKubeconfigLocation() {
    if (kubeconfigBusy) return
    setKubeconfigErr('')
    try {
      const selectedPath = await chooseEksKubeconfigPath(kubeconfigLocation)
      if (selectedPath) setKubeconfigLocation(selectedPath)
    } catch (e) {
      setKubeconfigErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleKubeconfig() {
    if (!selectedCluster) return
    const contextName = kubeconfigContextName.trim()
    const kubeconfigPath = kubeconfigLocation.trim()
    if (!contextName) return setKubeconfigErr('Context name is required')
    if (!kubeconfigPath) return setKubeconfigErr('Config location is required')
    setMsg('')
    setError('')
    setKubeconfigErr('')
    setKubeconfigBusy(true)
    try {
      const result = await addEksToKubeconfig(connection, selectedCluster, contextName, kubeconfigPath)
      setMsg(result)
      setShowKubeconfigForm(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setKubeconfigBusy(false)
    }
  }

  async function handleScale() {
    if (!selectedCluster || !selectedNg) return
    const minN = Number(scaleMin)
    const desiredN = Number(scaleDesired)
    const maxN = Number(scaleMax)
    if (Number.isNaN(minN) || Number.isNaN(desiredN) || Number.isNaN(maxN)) return setScaleErr('Values must be numbers')
    if (minN < 0 || desiredN < minN || desiredN > maxN) return setScaleErr('Must satisfy: 0 <= min <= desired <= max')
    setScaleErr('')
    setScaleBusy(true)
    try {
      await updateEksNodegroupScaling(connection, selectedCluster, selectedNg, minN, desiredN, maxN)
      setNodegroups(await listEksNodegroups(connection, selectedCluster))
      setShowScale(false)
      setMsg(`Scaled ${selectedNg} successfully`)
    } catch (e) {
      setScaleErr(e instanceof Error ? e.message : String(e))
    } finally {
      setScaleBusy(false)
    }
  }

  async function openTerminal() {
    if (!selectedCluster || terminalBusy) return
    setTerminalBusy(true)
    setError('')
    setMsg('')
    try {
      const result = await prepareEksKubectlSession(connection, selectedCluster)
      const command = `$env:KUBECONFIG = '${result.path.replace(/'/g, "''")}'; Write-Host 'kubectl context ready for cluster: ${selectedCluster.replace(/'/g, "''")}'; Write-Host ''; kubectl cluster-info`
      onRunTerminalCommand?.(command)
      setMsg(`Opened kubectl terminal for ${selectedCluster} in the app terminal`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTerminalBusy(false)
    }
  }

  async function runTerminalCommand() {
    if (!terminalCmd.trim() || terminalBusy) return
    const cmd = terminalCmd.trim()
    setTerminalCmd('')
    setTerminalBusy(true)
    setTerminalOutput((previous) => `${previous}$ ${cmd}\n`)
    try {
      const output = await runEksCommand(connection, selectedCluster, terminalKubeconfigPath, cmd)
      setTerminalOutput((previous) => `${previous}${output}\n`)
    } catch (e) {
      setTerminalOutput((previous) => `${previous}Error: ${e instanceof Error ? e.message : String(e)}\n`)
    } finally {
      setTerminalBusy(false)
      setTimeout(() => {
        if (terminalOutputRef.current) terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight
      }, 50)
    }
  }

  function openScaleForm() {
    const nodegroup = nodegroups.find((item) => item.name === selectedNg)
    if (nodegroup) {
      setScaleMin(String(nodegroup.min))
      setScaleDesired(String(nodegroup.desired))
      setScaleMax(String(nodegroup.max))
    }
    setScaleErr('')
    setShowScale(true)
  }

  function toggleClusterCol(key: ClusterCol) {
    setVisibleClusterCols((previous) => {
      const next = new Set(previous)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleNgCol(key: NgCol) {
    setVisibleNgCols((previous) => {
      const next = new Set(previous)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  if (loading && !clusters.length) return <SvcState variant="loading" resourceName="EKS clusters" />

  return (
    <div className="eks-console">
      <section className="eks-shell-hero">
        <div className="eks-shell-hero-copy">
          <div className="eyebrow">EKS service</div>
          <h2>{detail ? detail.name : 'Kubernetes operations center'}</h2>
          <p>
            {detail
              ? `Inspect control plane posture, nodegroup capacity, CloudTrail activity, and kubeconfig workflows for ${detail.name}.`
              : 'Review cluster health, drill into nodegroups, and move into kubectl workflows from one EKS workspace.'}
          </p>
          <div className="eks-shell-meta-strip">
            <div className="eks-shell-meta-pill"><span>Connection</span><strong>{connection.kind === 'profile' ? connection.profile : connection.sessionId}</strong></div>
            <div className="eks-shell-meta-pill"><span>Region</span><strong>{connection.region}</strong></div>
            <div className="eks-shell-meta-pill"><span>Selected cluster</span><strong>{selectedCluster || 'None selected'}</strong></div>
            <div className="eks-shell-meta-pill"><span>Access</span><strong>{accessSummary(detail)}</strong></div>
          </div>
        </div>
        <div className="eks-shell-hero-stats">
          <MetricCard label="Clusters" value={clusters.length} note={`${healthyClusters} healthy in this region`} tone="success" />
          <MetricCard label="Nodegroups" value={selectedCluster ? nodegroups.length : 0} note={selectedCluster ? 'Attached to the selected cluster' : 'Select a cluster to inspect capacity'} />
          <MetricCard label="Desired nodes" value={selectedCluster ? totalDesiredNodes : 0} note={selectedCluster ? 'Aggregated desired count across visible nodegroups' : 'No cluster selected yet'} tone="warning" />
          <MetricCard label="Timeline window" value={`${timelineStart.slice(5)} - ${timelineEnd.slice(5)}`} note={selectedCluster ? 'CloudTrail activity range for the selected cluster' : 'Ready when a cluster is selected'} />
        </div>
      </section>

      <div className="eks-shell-toolbar">
        <div className="eks-toolbar">
          <button className="eks-toolbar-btn accent" type="button" onClick={() => void reload()} disabled={loading}>Reload inventory</button>
          <button className="eks-toolbar-btn" type="button" onClick={() => setShowDescribe((current) => !current)} disabled={!selectedCluster}>{showDescribe ? 'Hide details' : 'Describe cluster'}</button>
          <button className="eks-toolbar-btn" type="button" onClick={openKubeconfigForm} disabled={!selectedCluster}>Add to kubeconfig</button>
          <button className="eks-toolbar-btn" type="button" onClick={openScaleForm} disabled={!selectedCluster || !nodegroups.length}>Scale nodegroup</button>
          <button className="eks-toolbar-btn" type="button" onClick={openTerminal} disabled={!selectedCluster || terminalBusy}>Open kubectl terminal</button>
        </div>
        <div className="eks-shell-status">
          <div className="eks-status-card"><span>Inventory</span><strong>{loading ? 'Refreshing' : `${clusters.length} clusters loaded`}</strong></div>
          <div className="eks-status-card"><span>Selection</span><strong>{selectedCluster ? truncate(selectedCluster, 28) : 'Waiting for selection'}</strong></div>
          <div className="eks-status-card"><span>Mode</span><strong>{sideTab === 'overview' ? 'Capacity review' : sideTab === 'timeline' ? 'Change timeline' : 'Resilience lab'}</strong></div>
        </div>
      </div>

      {error && <SvcState variant="error" error={error} />}
      {msg && <div className="eks-msg">{msg}</div>}

      <div className="eks-main-layout">
        <div className="eks-project-table-area">
          <div className="eks-pane-head">
            <div><span className="eks-pane-kicker">Cluster inventory</span><h3>Regional clusters</h3></div>
            <span className="eks-pane-summary">{filteredClusters.length} shown</span>
          </div>
          <input className="eks-search-input" placeholder="Filter clusters across selected columns..." value={clusterSearch} onChange={(event) => setClusterSearch(event.target.value)} />
          <div className="eks-column-chips">
            {CLUSTER_COLUMNS.map((column) => (
              <button
                key={column.key}
                className={`eks-chip ${visibleClusterCols.has(column.key) ? 'active' : ''}`}
                type="button"
                style={visibleClusterCols.has(column.key) ? { background: column.color, borderColor: column.color, color: '#08111b' } : undefined}
                onClick={() => toggleClusterCol(column.key)}
              >
                {column.label}
              </button>
            ))}
          </div>
          {filteredClusters.length === 0 ? (
            <SvcState variant="empty" message="No clusters found for the active filters." />
          ) : (
            <div className="eks-project-list">
              {filteredClusters.map((cluster) => (
                <button key={cluster.name} type="button" className={`eks-project-row ${cluster.name === selectedCluster ? 'active' : ''}`} onClick={() => void selectCluster(cluster.name)}>
                  <div className="eks-project-row-top">
                    <div className="eks-project-row-copy">
                      {showClusterName && <strong>{cluster.name}</strong>}
                      <span title={cluster.endpoint}>{truncate(cluster.endpoint, 46)}</span>
                    </div>
                    {showClusterStatus && <StatusBadge status={cluster.status} />}
                  </div>
                  <div className="eks-project-row-meta">
                    {showClusterVersion && <span>Kubernetes {cluster.version}</span>}
                    <span>{connection.region}</span>
                  </div>
                  <div className="eks-project-row-metrics">
                    <div><span>Role</span><strong>{truncate(cluster.roleArn, 32)}</strong></div>
                    <div><span>Endpoint</span><strong>{cluster.endpoint ? 'Configured' : 'Unavailable'}</strong></div>
                    {showClusterStatus && <div><span>Status</span><strong>{cluster.status}</strong></div>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="eks-detail-pane">
          {!detail ? (
            <SvcState variant="no-selection" resourceName="cluster" message="Select a cluster to view EKS details." />
          ) : (
            <>
              <section className="eks-detail-hero">
                <div className="eks-detail-hero-copy">
                  <div className="eyebrow">Cluster posture</div>
                  <h3>{detail.name}</h3>
                  <p>{truncate(detail.endpoint, 88)}</p>
                  <div className="eks-detail-meta-strip">
                    <div className="eks-detail-meta-pill"><span>Status</span><strong>{detail.status}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Version</span><strong>{detail.version}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Platform</span><strong>{detail.platformVersion}</strong></div>
                    <div className="eks-detail-meta-pill"><span>VPC</span><strong>{detail.vpcId}</strong></div>
                  </div>
                </div>
                <div className="eks-detail-hero-stats">
                  <MetricCard label="Endpoint access" value={accessSummary(detail)} note={`${detail.publicAccessCidrs.length || 0} public CIDR entries`} tone={detail.endpointPrivateAccess ? 'success' : 'warning'} />
                  <MetricCard label="Nodegroups" value={nodegroups.length} note={selectedNodegroup ? `${selectedNodegroup.name} selected` : 'No nodegroups found'} />
                  <MetricCard label="Logging" value={detail.loggingEnabled.length || 0} note={detail.loggingEnabled.length ? detail.loggingEnabled.join(', ') : 'No control plane logging enabled'} tone={detail.loggingEnabled.length ? 'info' : 'danger'} />
                  <MetricCard label="Created" value={formatDateTime(detail.createdAt)} note="Cluster creation time" />
                </div>
              </section>

              <div className="eks-detail-tabs">
                <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>Overview</button>
                <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>Change timeline</button>
                <button className={sideTab === 'lab' ? 'active' : ''} type="button" onClick={() => setSideTab('lab')}>Resilience lab</button>
              </div>

              {sideTab === 'overview' && (
                <section className="eks-section eks-nodegroups-section">
                  {showDescribe && (
                    <section className="eks-section eks-cluster-details-panel">
                      <div className="eks-section-head">
                        <div><span className="eks-section-kicker">Describe</span><h4>Cluster details</h4></div>
                        <span className="eks-section-hint">Detailed control plane and networking configuration for the selected cluster.</span>
                      </div>
                      <div className="eks-kv">
                        <InfoRow label="Cluster endpoint" value={detail.endpoint} />
                        <InfoRow label="Role ARN" value={detail.roleArn} />
                        <InfoRow label="OIDC issuer" value={detail.oidcIssuer} />
                        <InfoRow label="Cluster security group" value={detail.clusterSecurityGroupId} />
                        <InfoRow label="Security groups" value={detail.securityGroupIds.join(', ') || '-'} />
                        <InfoRow label="Subnets" value={detail.subnetIds.join(', ') || '-'} />
                        <InfoRow label="Service CIDR" value={detail.serviceIpv4Cidr} />
                        <InfoRow label="Public access CIDRs" value={detail.publicAccessCidrs.join(', ') || '-'} />
                        <InfoRow label="Tags" value={Object.entries(detail.tags).map(([key, value]) => `${key}=${value}`).join(', ') || '-'} />
                      </div>
                    </section>
                  )}
                  <section className="eks-section">
                    <div className="eks-section-head">
                      <div><span className="eks-section-kicker">Operations</span><h4>Cluster actions</h4></div>
                      <span className="eks-section-hint">Actions keep existing behavior and operate on the selected cluster.</span>
                    </div>
                    <div className="eks-action-grid">
                      <button type="button" className="eks-action-btn accent" onClick={openKubeconfigForm}>Add to kubeconfig</button>
                      <button type="button" className="eks-action-btn" onClick={openScaleForm} disabled={!nodegroups.length}>Scale nodegroup</button>
                      <button type="button" className="eks-action-btn" onClick={openTerminal}>Open kubectl terminal</button>
                      <button type="button" className="eks-action-btn" onClick={() => void loadTimeline()}>Refresh timeline</button>
                    </div>
                    {showScale && (
                      <section className="eks-inline-panel eks-scale-inline-panel">
                        <div className="eks-section-head">
                          <div><span className="eks-section-kicker">Scaling</span><h4>Scale nodegroup</h4></div>
                          <button type="button" className="eks-toolbar-btn" onClick={() => setShowScale(false)} disabled={scaleBusy}>Close</button>
                        </div>
                        <div className="eks-scale-form">
                          <label>
                            Nodegroup
                            <select value={selectedNg} onChange={(event) => {
                              setSelectedNg(event.target.value)
                              const nodegroup = nodegroups.find((item) => item.name === event.target.value)
                              if (nodegroup) {
                                setScaleMin(String(nodegroup.min))
                                setScaleDesired(String(nodegroup.desired))
                                setScaleMax(String(nodegroup.max))
                              }
                            }}>
                              {nodegroups.map((nodegroup) => <option key={nodegroup.name} value={nodegroup.name}>{nodegroup.name}</option>)}
                            </select>
                          </label>
                          <label>Min<input type="number" value={scaleMin} onChange={(event) => setScaleMin(event.target.value)} /></label>
                          <label>Desired<input type="number" value={scaleDesired} onChange={(event) => setScaleDesired(event.target.value)} /></label>
                          <label>Max<input type="number" value={scaleMax} onChange={(event) => setScaleMax(event.target.value)} /></label>
                          <button type="button" className="eks-toolbar-btn accent" disabled={scaleBusy} onClick={() => void handleScale()}>{scaleBusy ? 'Applying...' : 'Apply scale change'}</button>
                        </div>
                        {scaleErr && <div className="eks-inline-error">{scaleErr}</div>}
                      </section>
                    )}
                  </section>
                  <div className="eks-section-head">
                    <div><span className="eks-section-kicker">Capacity</span><h4>Nodegroup inventory</h4></div>
                    <span className="eks-section-hint">{filteredNodegroups.length} nodegroups match the active filters.</span>
                  </div>
                  <input className="eks-search-input" placeholder="Filter nodegroups across selected columns..." value={ngSearch} onChange={(event) => setNgSearch(event.target.value)} />
                  <div className="eks-column-chips">
                    {NG_COLUMNS.map((column) => (
                      <button
                        key={column.key}
                        className={`eks-chip ${visibleNgCols.has(column.key) ? 'active' : ''}`}
                        type="button"
                        style={visibleNgCols.has(column.key) ? { background: column.color, borderColor: column.color, color: '#08111b' } : undefined}
                        onClick={() => toggleNgCol(column.key)}
                      >
                        {column.label}
                      </button>
                    ))}
                  </div>
                  <div className="eks-nodegroup-layout">
                    <div className="eks-table-shell">
                      <div className="eks-ng-scroll">
                        <table className="eks-data-table">
                          <thead><tr>{activeNgCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
                          <tbody>
                            {!filteredNodegroups.length && <tr><td colSpan={activeNgCols.length} className="eks-table-empty">{selectedCluster ? 'No nodegroups found.' : 'Select a cluster.'}</td></tr>}
                            {filteredNodegroups.map((nodegroup) => (
                              <tr key={nodegroup.name} className={nodegroup.name === selectedNg ? 'active' : ''} onClick={() => setSelectedNg(nodegroup.name)}>
                                {activeNgCols.map((column) => <td key={column.key}>{column.key === 'status' ? <StatusBadge status={nodegroup.status} /> : getNgValue(nodegroup, column.key)}</td>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <aside className="eks-side-card">
                      <div className="eks-section-head">
                        <div><span className="eks-section-kicker">Selection</span><h4>{selectedNodegroup?.name || 'Nodegroup details'}</h4></div>
                      </div>
                      {selectedNodegroup ? (
                        <>
                          <div className="eks-side-card-grid">
                            <MetricCard label="Desired" value={selectedNodegroup.desired} note="Current desired capacity" tone="warning" />
                            <MetricCard label="Min" value={selectedNodegroup.min} note="Lower autoscaling bound" />
                            <MetricCard label="Max" value={selectedNodegroup.max} note="Upper autoscaling bound" />
                            <MetricCard label="Status" value={selectedNodegroup.status} note="Latest nodegroup lifecycle state" tone={statusTone(selectedNodegroup.status)} />
                          </div>
                          <div className="eks-mini-kv">
                            <InfoRow label="Instance types" value={selectedNodegroup.instanceTypes || '-'} />
                            <InfoRow label="Recommendation" value="No recommendation data surfaced in this view" />
                          </div>
                        </>
                      ) : <SvcState variant="empty" resourceName="nodegroup" compact />}
                    </aside>
                  </div>
                </section>
              )}
              {sideTab === 'timeline' && (
                <section className="eks-section">
                  <div className="eks-section-head">
                    <div><span className="eks-section-kicker">CloudTrail</span><h4>Change timeline</h4></div>
                  </div>
                  <div className="eks-timeline-controls">
                    <label>From<input type="date" value={timelineStart} onChange={(event) => setTimelineStart(event.target.value)} /></label>
                    <label>To<input type="date" value={timelineEnd} onChange={(event) => setTimelineEnd(event.target.value)} /></label>
                  </div>
                  {timelineLoading && <SvcState variant="loading" resourceName="events" compact />}
                  {!timelineLoading && timelineError && <SvcState variant="error" error={timelineError} compact />}
                  {!timelineLoading && !timelineError && timelineEvents.length === 0 && <SvcState variant="empty" resourceName="CloudTrail events" compact />}
                  {!timelineLoading && timelineEvents.length > 0 && (
                    <div className="eks-table-shell eks-timeline-table-wrap">
                      <table className="eks-timeline-table">
                        <thead><tr><th>Event</th><th>User</th><th>Source</th><th>Date</th></tr></thead>
                        <tbody>
                          {timelineEvents.map((event) => (
                            <tr key={event.eventId}>
                              <td title={event.eventSource}>{event.eventName}</td>
                              <td>{event.username}</td>
                              <td>{event.sourceIpAddress}</td>
                              <td>{formatDateTime(event.eventTime)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
              {sideTab === 'lab' && (
                <section className="eks-section eks-lab-shell">
                  <ObservabilityResilienceLab
                    report={labReport}
                    loading={labLoading}
                    error={labError}
                    onRefresh={() => void loadLab()}
                    onNavigateSignal={handleLabSignalNavigate}
                  />
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {showKubeconfigForm && (
        <div className="eks-modal-backdrop" onClick={() => { if (!kubeconfigBusy) setShowKubeconfigForm(false) }}>
          <section className="eks-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="eks-section-head">
              <div><span className="eks-section-kicker">Kubeconfig</span><h4>Add selected cluster</h4></div>
            </div>
            <div className="eks-form-grid">
              <label>Context name<input value={kubeconfigContextName} onChange={(event) => setKubeconfigContextName(event.target.value)} placeholder="my-eks-context" autoFocus /></label>
              <label>
                Config location
                <div className="eks-picker-field">
                  <input value={kubeconfigLocation} placeholder=".kube/config" readOnly />
                  <button type="button" className="eks-toolbar-btn" onClick={() => void browseKubeconfigLocation()} disabled={kubeconfigBusy}>Browse</button>
                </div>
              </label>
            </div>
            <div className="eks-inline-actions">
              <button type="button" className="eks-toolbar-btn" onClick={() => setShowKubeconfigForm(false)} disabled={kubeconfigBusy}>Cancel</button>
              <button type="button" className="eks-toolbar-btn accent" onClick={() => void handleKubeconfig()} disabled={kubeconfigBusy}>{kubeconfigBusy ? 'Adding...' : 'Add to kubeconfig'}</button>
            </div>
            {kubeconfigErr && <div className="eks-inline-error">{kubeconfigErr}</div>}
          </section>
        </div>
      )}
      {terminalOpen && (
        <div className="eks-terminal-panel">
          <div className="eks-terminal-header">
            <span>kubectl terminal - {selectedCluster}</span>
            <button type="button" onClick={() => { setTerminalOpen(false); setTerminalKubeconfigPath('') }}>Close</button>
          </div>
          <div className="eks-terminal-output" ref={terminalOutputRef}>{terminalOutput}</div>
          <div className="eks-terminal-input-row">
            <span className="eks-terminal-prompt">$</span>
            <input
              value={terminalCmd}
              onChange={(event) => setTerminalCmd(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void runTerminalCommand() }}
              placeholder={terminalBusy ? 'Running...' : 'Type a command (e.g. kubectl get nodes)'}
              disabled={terminalBusy}
              autoFocus
            />
          </div>
        </div>
      )}
    </div>
  )
}
