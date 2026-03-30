import { useEffect, useMemo, useState } from 'react'
import './rds.css'

import type {
  AwsConnection,
  CloudTrailEventSummary,
  RdsClusterDetail,
  RdsClusterNodeSummary,
  RdsClusterSummary,
  RdsInstanceDetail,
  RdsInstanceSummary,
  RdsMaintenanceItem,
  RdsOperationalStatusTone,
  RdsPostureBadge,
  RdsRiskFinding,
  RdsSummaryTile
} from '@shared/types'
import {
  createRdsClusterSnapshot,
  createRdsSnapshot,
  describeRdsCluster,
  describeRdsInstance,
  failoverRdsCluster,
  listRdsClusters,
  listRdsInstances,
  lookupCloudTrailEventsByResource,
  rebootRdsInstance,
  resizeRdsInstance,
  startRdsCluster,
  startRdsInstance,
  stopRdsCluster,
  stopRdsInstance
} from './api'
import { ConfirmButton } from './ConfirmButton'

type MainTab = 'instances' | 'aurora'
type SideTab = 'overview' | 'timeline'
type InstanceColumnKey = 'identifier' | 'engine' | 'class' | 'status' | 'endpoint' | 'storage'
type AuroraColumnKey = 'cluster' | 'engine' | 'status' | 'writer' | 'reader' | 'endpoint'

const INSTANCE_COLUMNS: { key: InstanceColumnKey; label: string; color: string }[] = [
  { key: 'identifier', label: 'Identifier', color: '#3b82f6' },
  { key: 'engine', label: 'Engine', color: '#14b8a6' },
  { key: 'class', label: 'Class', color: '#8b5cf6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'endpoint', label: 'Endpoint', color: '#06b6d4' },
  { key: 'storage', label: 'Storage', color: '#f59e0b' }
]

const AURORA_COLUMNS: { key: AuroraColumnKey; label: string; color: string }[] = [
  { key: 'cluster', label: 'Cluster', color: '#3b82f6' },
  { key: 'engine', label: 'Engine', color: '#14b8a6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'writer', label: 'Writer Nodes', color: '#8b5cf6' },
  { key: 'reader', label: 'Reader Nodes', color: '#f59e0b' },
  { key: 'endpoint', label: 'Endpoint', color: '#06b6d4' }
]

function getInstanceColumnValue(inst: RdsInstanceSummary, key: InstanceColumnKey): string {
  switch (key) {
    case 'identifier': return inst.dbInstanceIdentifier
    case 'engine': return `${inst.engine} ${inst.engineVersion}`
    case 'class': return inst.dbInstanceClass
    case 'status': return inst.status
    case 'endpoint': return `${inst.endpoint}:${inst.port ?? '-'}`
    case 'storage': return `${inst.allocatedStorage} GiB`
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function buildSnapshotId(base: string): string {
  return `${slug(base)}-${new Date().toISOString().replace(/[:.]/g, '-').toLowerCase()}`
}

function toneClass(tone: RdsOperationalStatusTone): string {
  return `rds-tone-${tone}`
}

function severityClass(severity: RdsRiskFinding['severity']): string {
  return `rds-finding-${severity}`
}

function prettifyStatusLabel(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function tileToneSummary(tone: RdsOperationalStatusTone): string {
  switch (tone) {
    case 'good':
      return 'Healthy operating signal'
    case 'warning':
      return 'Needs operator review'
    case 'risk':
      return 'Elevated operational risk'
    default:
      return 'Current observed posture'
  }
}

function KV({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="rds-kv">
      {items.map(([label, value]) => (
        <div key={label} className="rds-kv-row">
          <div className="rds-kv-label">{label}</div>
          <div className="rds-kv-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`rds-badge ${status}`}>{status}</span>
}

function SummaryTiles({ items }: { items: RdsSummaryTile[] }) {
  return (
    <div className="rds-summary-tiles">
      {items.map((item) => (
        <div key={item.id} className={`rds-summary-tile ${toneClass(item.tone)}`}>
          <div className="rds-summary-tile-label">{item.label}</div>
          <div className="rds-summary-tile-value">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function PostureBadges({ items }: { items: RdsPostureBadge[] }) {
  return (
    <div className="rds-posture-badges">
      {items.map((item) => (
        <div key={item.id} className={`rds-posture-badge ${toneClass(item.tone)}`}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  )
}

function FindingsList({ items }: { items: RdsRiskFinding[] }) {
  if (!items.length) {
    return <div className="rds-state-card rds-tone-good">No operational warnings detected.</div>
  }

  return (
    <div className="rds-stack-list">
      {items.map((item) => (
        <div key={item.id} className={`rds-finding-card ${severityClass(item.severity)}`}>
          <div className="rds-finding-title">{item.title}</div>
          <div className="rds-finding-text">{item.message}</div>
          <div className="rds-finding-recommendation">{item.recommendation}</div>
        </div>
      ))}
    </div>
  )
}

function MaintenanceList({ items }: { items: RdsMaintenanceItem[] }) {
  if (!items.length) {
    return <div className="rds-state-card">No pending maintenance actions reported.</div>
  }

  return (
    <div className="rds-stack-list">
      {items.map((item, index) => (
        <div key={`${item.resourceIdentifier}:${item.action}:${index}`} className="rds-maintenance-card">
          <div className="rds-maintenance-head">
            <strong>{item.action}</strong>
            <span className="rds-muted">{item.sourceIdentifier}</span>
          </div>
          <div className="rds-maintenance-text">{item.description}</div>
          <KV items={[
            ['Resource', item.resourceType],
            ['Opt-in', item.optInStatus],
            ['Apply date', item.currentApplyDate],
            ['Auto apply after', item.autoAppliedAfter]
          ]} />
        </div>
      ))}
    </div>
  )
}

function ClusterNodeMatrix({
  writerNodes,
  readerNodes,
  selectedNodeId,
  onSelectNode
}: {
  writerNodes: RdsClusterNodeSummary[]
  readerNodes: RdsClusterNodeSummary[]
  selectedNodeId: string
  onSelectNode: (nodeId: string) => void
}) {
  const renderNode = (node: RdsClusterNodeSummary) => (
    <button
      key={node.dbInstanceIdentifier}
      type="button"
      className={`rds-topology-card ${node.dbInstanceIdentifier === selectedNodeId ? 'active' : ''}`}
      onClick={() => onSelectNode(node.dbInstanceIdentifier)}
    >
      <div className="rds-topology-head">
        <strong>{node.dbInstanceIdentifier}</strong>
        <StatusBadge status={node.status} />
      </div>
      <div className="rds-topology-meta">{node.dbInstanceClass}</div>
      <div className="rds-topology-meta">{node.availabilityZone}</div>
      <div className="rds-topology-meta">{node.endpoint}:{node.port ?? '-'}</div>
      {node.promotionTier != null && <div className="rds-topology-meta">Promotion tier {node.promotionTier}</div>}
    </button>
  )

  return (
    <div className="rds-topology-grid">
      <div>
        <div className="rds-section-subtitle">Writer</div>
        <div className="rds-stack-list">
          {writerNodes.length ? writerNodes.map(renderNode) : <div className="rds-state-card">No writer node reported.</div>}
        </div>
      </div>
      <div>
        <div className="rds-section-subtitle">Readers</div>
        <div className="rds-stack-list">
          {readerNodes.length ? readerNodes.map(renderNode) : <div className="rds-state-card">No reader nodes reported.</div>}
        </div>
      </div>
    </div>
  )
}

export function RdsConsole({ connection }: { connection: AwsConnection }) {
  const [mainTab, setMainTab] = useState<MainTab>('instances')
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [visibleInstanceCols, setVisibleInstanceCols] = useState<Set<InstanceColumnKey>>(new Set(INSTANCE_COLUMNS.map((column) => column.key)))
  const [visibleAuroraCols, setVisibleAuroraCols] = useState<Set<AuroraColumnKey>>(new Set(AURORA_COLUMNS.map((column) => column.key)))

  const [instances, setInstances] = useState<RdsInstanceSummary[]>([])
  const [clusters, setClusters] = useState<RdsClusterSummary[]>([])
  const [selectedInstanceId, setSelectedInstanceId] = useState('')
  const [selectedClusterId, setSelectedClusterId] = useState('')
  const [selectedAuroraNodeId, setSelectedAuroraNodeId] = useState('')
  const [instanceDetail, setInstanceDetail] = useState<RdsInstanceDetail | null>(null)
  const [clusterDetail, setClusterDetail] = useState<RdsClusterDetail | null>(null)

  const [resizeClass, setResizeClass] = useState('')
  const [showResize, setShowResize] = useState(false)
  const [snapshotId, setSnapshotId] = useState('')

  const [timelineEvents, setTimelineEvents] = useState<CloudTrailEventSummary[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [timelineStart, setTimelineStart] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() - 14)
    return date.toISOString().slice(0, 10)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => new Date().toISOString().slice(0, 10))

  const selectedInstance = useMemo(() => instances.find((item) => item.dbInstanceIdentifier === selectedInstanceId) ?? null, [instances, selectedInstanceId])
  const selectedCluster = useMemo(() => clusters.find((item) => item.dbClusterIdentifier === selectedClusterId) ?? null, [clusters, selectedClusterId])
  const selectedAuroraNode = useMemo(() => {
    if (!selectedCluster) return null
    return [...selectedCluster.writerNodes, ...selectedCluster.readerNodes].find((node) => node.dbInstanceIdentifier === selectedAuroraNodeId) ?? null
  }, [selectedCluster, selectedAuroraNodeId])

  const filteredInstances = useMemo(() => {
    return instances.filter((inst) => {
      if (statusFilter !== 'all' && inst.status !== statusFilter) return false
      if (!search) return true
      const needle = search.toLowerCase()
      return [...visibleInstanceCols].some((column) => getInstanceColumnValue(inst, column).toLowerCase().includes(needle))
    })
  }, [instances, search, statusFilter, visibleInstanceCols])

  const filteredClusters = useMemo(() => {
    return clusters.filter((cluster) => {
      if (statusFilter !== 'all' && cluster.status !== statusFilter) return false
      if (!search) return true
      const values: Record<AuroraColumnKey, string> = {
        cluster: cluster.dbClusterIdentifier,
        engine: `${cluster.engine} ${cluster.engineVersion}`,
        status: cluster.status,
        writer: cluster.writerNodes.map((node) => node.dbInstanceIdentifier).join(' '),
        reader: cluster.readerNodes.map((node) => node.dbInstanceIdentifier).join(' '),
        endpoint: `${cluster.endpoint} ${cluster.readerEndpoint}`
      }
      return [...visibleAuroraCols].some((column) => values[column].toLowerCase().includes(search.toLowerCase()))
    })
  }, [clusters, search, statusFilter, visibleAuroraCols])

  const activeInstanceCols = INSTANCE_COLUMNS.filter((column) => visibleInstanceCols.has(column.key))
  const activeAuroraCols = AURORA_COLUMNS.filter((column) => visibleAuroraCols.has(column.key))

  const overviewPosture = mainTab === 'instances' ? instanceDetail?.posture ?? null : clusterDetail?.posture ?? null
  const overviewConnectionDetails = mainTab === 'instances' ? instanceDetail?.connectionDetails ?? [] : clusterDetail?.connectionDetails ?? []
  const overviewTitle = mainTab === 'instances' ? instanceDetail?.summary.dbInstanceIdentifier ?? '' : clusterDetail?.summary.dbClusterIdentifier ?? ''
  const overviewStatus = mainTab === 'instances' ? instanceDetail?.summary.status ?? '' : clusterDetail?.summary.status ?? ''
  const totalInventory = mainTab === 'instances' ? instances.length : clusters.length
  const filteredInventory = mainTab === 'instances' ? filteredInstances.length : filteredClusters.length
  const availableInventory = mainTab === 'instances'
    ? instances.filter((item) => item.status === 'available').length
    : clusters.filter((item) => item.status === 'available').length
  const fleetLabel = mainTab === 'instances' ? 'Instance fleet' : 'Aurora fleet'
  const selectionLabel = mainTab === 'instances' ? 'Selected instance' : 'Selected cluster'
  const selectedFindingCount = mainTab === 'instances'
    ? instanceDetail?.posture.findings.length ?? 0
    : clusterDetail?.posture.findings.length ?? 0
  const selectedMaintenanceCount = mainTab === 'instances'
    ? instanceDetail?.posture.maintenanceItems.length ?? 0
    : clusterDetail?.posture.maintenanceItems.length ?? 0
  const selectedEngine = mainTab === 'instances'
    ? (instanceDetail ? `${instanceDetail.summary.engine} ${instanceDetail.summary.engineVersion}` : 'Select a resource')
    : (clusterDetail ? `${clusterDetail.summary.engine} ${clusterDetail.summary.engineVersion}` : 'Select a resource')
  const topologyCount = mainTab === 'instances'
    ? instances.filter((item) => item.multiAz || !!item.dbClusterIdentifier).length
    : clusters.reduce((count, cluster) => count + cluster.writerNodes.length + cluster.readerNodes.length, 0)
  const detailHeroStats = overviewPosture?.summaryTiles.slice(0, 4) ?? []
  const messageTone = msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('error') || msg.toLowerCase().includes('not found')
    ? 'error'
    : 'success'

  async function loadInstanceDetail(id: string) {
    try {
      const detail = await describeRdsInstance(connection, id)
      setInstanceDetail(detail)
      setResizeClass(detail.summary.dbInstanceClass)
      setSnapshotId(buildSnapshotId(detail.summary.dbInstanceIdentifier))
      setShowResize(false)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
      setInstanceDetail(null)
    }
  }

  async function loadClusterDetail(clusterId: string, preferredNodeId?: string) {
    try {
      const detail = await describeRdsCluster(connection, clusterId)
      setClusterDetail(detail)
      const targetNode = detail.summary.writerNodes.find((node) => node.dbInstanceIdentifier === preferredNodeId)
        ?? detail.summary.readerNodes.find((node) => node.dbInstanceIdentifier === preferredNodeId)
        ?? detail.summary.writerNodes[0]
        ?? detail.summary.readerNodes[0]
        ?? null
      setSelectedAuroraNodeId(targetNode?.dbInstanceIdentifier ?? '')
      setResizeClass(targetNode?.dbInstanceClass ?? '')
      setSnapshotId(buildSnapshotId(detail.summary.dbClusterIdentifier))
      setShowResize(false)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
      setClusterDetail(null)
    }
  }

  async function reload(preferredInstanceId?: string, preferredClusterId?: string, preferredNodeId?: string) {
    setLoading(true)
    setMsg('')
    try {
      const [nextInstances, nextClusters] = await Promise.all([listRdsInstances(connection), listRdsClusters(connection)])
      setInstances(nextInstances)
      setClusters(nextClusters)

      const resolvedInstanceId = preferredInstanceId && nextInstances.some((item) => item.dbInstanceIdentifier === preferredInstanceId)
        ? preferredInstanceId
        : nextInstances[0]?.dbInstanceIdentifier ?? ''
      const resolvedClusterId = preferredClusterId && nextClusters.some((item) => item.dbClusterIdentifier === preferredClusterId)
        ? preferredClusterId
        : nextClusters[0]?.dbClusterIdentifier ?? ''

      setSelectedInstanceId(resolvedInstanceId)
      setSelectedClusterId(resolvedClusterId)

      if (resolvedInstanceId) await loadInstanceDetail(resolvedInstanceId)
      else setInstanceDetail(null)

      if (resolvedClusterId) await loadClusterDetail(resolvedClusterId, preferredNodeId)
      else setClusterDetail(null)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [connection.region, connection.sessionId])

  async function selectInstance(id: string) {
    setSelectedInstanceId(id)
    setSideTab('overview')
    setMsg('')
    setTimelineEvents([])
    setTimelineError('')
    await loadInstanceDetail(id)
  }

  async function selectCluster(clusterId: string, nodeId?: string) {
    setSelectedClusterId(clusterId)
    setSideTab('overview')
    setMsg('')
    setTimelineEvents([])
    setTimelineError('')
    await loadClusterDetail(clusterId, nodeId)
  }

  async function runTask(task: () => Promise<void>, successMessage: string) {
    setBusy(true)
    setMsg('')
    try {
      await task()
      setMsg(successMessage)
      await reload(selectedInstanceId, selectedClusterId, selectedAuroraNodeId)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function loadTimeline() {
    const resourceName = mainTab === 'instances' ? selectedInstanceId : selectedAuroraNodeId || selectedClusterId
    if (!resourceName) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const events = await lookupCloudTrailEventsByResource(
        connection,
        resourceName,
        new Date(timelineStart).toISOString(),
        new Date(`${timelineEnd}T23:59:59`).toISOString()
      )
      setTimelineEvents(events)
    } catch (error) {
      setTimelineEvents([])
      setTimelineError(error instanceof Error ? error.message : 'Failed to load events')
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (sideTab === 'timeline') void loadTimeline()
  }, [sideTab, mainTab, selectedInstanceId, selectedClusterId, selectedAuroraNodeId, timelineStart, timelineEnd])

  function toggleInstanceCol(key: InstanceColumnKey) {
    setVisibleInstanceCols((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAuroraCol(key: AuroraColumnKey) {
    setVisibleAuroraCols((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (loading) return <div className="rds-empty">Loading RDS data...</div>

  const hasTimelineResource = mainTab === 'instances' ? !!selectedInstanceId : !!(selectedClusterId || selectedAuroraNodeId)

  return (
    <div className="rds-console">
      <section className="rds-shell-hero">
        <div className="rds-shell-hero-copy">
          <div className="eyebrow">RDS service</div>
          <h2>{overviewTitle || (mainTab === 'instances' ? 'Database instance command center' : 'Aurora cluster command center')}</h2>
          <p>
            {mainTab === 'instances'
              ? 'Monitor instance posture, review replica coverage, and run operational actions without leaving the console.'
              : 'Track Aurora topology, review failover readiness, and operate cluster nodes from the same surface.'}
          </p>
          <div className="rds-shell-meta-strip">
            <div className="rds-shell-meta-pill">
              <span>Scope</span>
              <strong>{mainTab === 'instances' ? 'RDS instances' : 'Aurora clusters'}</strong>
            </div>
            <div className="rds-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="rds-shell-meta-pill">
              <span>Selection</span>
              <strong>{overviewTitle || 'None selected'}</strong>
            </div>
            <div className="rds-shell-meta-pill">
              <span>Engine</span>
              <strong>{selectedEngine}</strong>
            </div>
          </div>
        </div>
        <div className="rds-shell-hero-stats">
          <div className="rds-shell-stat-card rds-shell-stat-card-accent">
            <span>{fleetLabel}</span>
            <strong>{totalInventory}</strong>
            <small>{filteredInventory} visible with current filters</small>
          </div>
          <div className="rds-shell-stat-card">
            <span>Available</span>
            <strong>{availableInventory}</strong>
            <small>{mainTab === 'instances' ? 'Instances ready for connections' : 'Clusters ready for writes'}</small>
          </div>
          <div className="rds-shell-stat-card">
            <span>{mainTab === 'instances' ? 'Replica coverage' : 'Topology nodes'}</span>
            <strong>{topologyCount}</strong>
            <small>{mainTab === 'instances' ? 'Resources participating in replication' : 'Writer and reader nodes discovered'}</small>
          </div>
          <div className={`rds-shell-stat-card ${selectedFindingCount > 0 ? 'warning' : 'success'}`}>
            <span>{selectionLabel}</span>
            <strong>{overviewStatus ? prettifyStatusLabel(overviewStatus) : 'Standby'}</strong>
            <small>{selectedFindingCount} findings, {selectedMaintenanceCount} maintenance items</small>
          </div>
        </div>
      </section>

      <div className="rds-shell-toolbar">
        <div className="rds-toolbar">
          <button className={`rds-toolbar-btn ${mainTab === 'instances' ? 'active' : ''}`} type="button" onClick={() => setMainTab('instances')}>
            RDS Instances
          </button>
          <button className={`rds-toolbar-btn ${mainTab === 'aurora' ? 'active' : ''}`} type="button" onClick={() => setMainTab('aurora')}>
            Aurora Clusters
          </button>
          <button
            className="rds-toolbar-btn accent"
            type="button"
            onClick={() => void reload(selectedInstanceId, selectedClusterId, selectedAuroraNodeId)}
          >
            Refresh Inventory
          </button>
        </div>
        <div className="rds-shell-status">
          <div className="rds-shell-status-card">
            <span>Status filter</span>
            <select className="rds-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All statuses</option>
              <option value="available">Available</option>
              <option value="stopped">Stopped</option>
              <option value="starting">Starting</option>
              <option value="stopping">Stopping</option>
              <option value="creating">Creating</option>
              <option value="deleting">Deleting</option>
              <option value="modifying">Modifying</option>
            </select>
          </div>
          <div className="rds-shell-status-card rds-shell-status-search">
            <span>Search</span>
            <input
              className="rds-search-input"
              placeholder="Filter rows across selected columns..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
      </div>

      {msg && <div className={`rds-msg ${messageTone}`}>{msg}</div>}

      <div className="rds-main-layout">
        <div className="rds-table-panel">
          <div className="rds-pane-head">
            <div>
              <span className="rds-pane-kicker">{mainTab === 'instances' ? 'Tracked databases' : 'Tracked clusters'}</span>
              <h3>{mainTab === 'instances' ? 'Fleet inventory' : 'Cluster inventory'}</h3>
            </div>
            <span className="rds-pane-summary">{filteredInventory} shown</span>
          </div>

          <div className="rds-column-chips">
            {(mainTab === 'instances' ? INSTANCE_COLUMNS : AURORA_COLUMNS).map((column) => {
              const active = mainTab === 'instances'
                ? visibleInstanceCols.has(column.key as InstanceColumnKey)
                : visibleAuroraCols.has(column.key as AuroraColumnKey)
              return (
                <button
                  key={column.key}
                  className={`rds-chip ${active ? 'active' : ''}`}
                  type="button"
                  style={active ? { background: column.color, borderColor: column.color, color: '#fff' } : undefined}
                  onClick={() => mainTab === 'instances'
                    ? toggleInstanceCol(column.key as InstanceColumnKey)
                    : toggleAuroraCol(column.key as AuroraColumnKey)}
                >
                  {column.label}
                </button>
              )
            })}
          </div>

          <div className="rds-table-area">
          {mainTab === 'instances' ? (
            <>
              <table className="rds-data-table">
                <thead>
                  <tr>
                    {activeInstanceCols.map((column) => <th key={column.key}>{column.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredInstances.map((inst) => (
                    <tr
                      key={inst.dbInstanceIdentifier}
                      className={inst.dbInstanceIdentifier === selectedInstanceId ? 'active' : ''}
                      onClick={() => void selectInstance(inst.dbInstanceIdentifier)}
                    >
                      {activeInstanceCols.map((column) => (
                        <td key={column.key}>
                          {column.key === 'status' ? <StatusBadge status={inst.status} /> : getInstanceColumnValue(inst, column.key)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredInstances.length && <div className="rds-empty">No RDS instances match filters.</div>}
            </>
          ) : (
            <>
              <table className="rds-data-table">
                <thead>
                  <tr>
                    {activeAuroraCols.map((column) => <th key={column.key}>{column.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredClusters.map((cluster) => (
                    <tr
                      key={cluster.dbClusterIdentifier}
                      className={cluster.dbClusterIdentifier === selectedClusterId ? 'active' : ''}
                      onClick={() => void selectCluster(cluster.dbClusterIdentifier)}
                    >
                      {activeAuroraCols.map((column) => (
                        <td key={column.key}>
                          {column.key === 'status' ? <StatusBadge status={cluster.status} />
                            : column.key === 'cluster' ? cluster.dbClusterIdentifier
                            : column.key === 'engine' ? `${cluster.engine} ${cluster.engineVersion}`
                            : column.key === 'writer' ? (
                              <div className="rds-node-pills">
                                {cluster.writerNodes.length
                                  ? cluster.writerNodes.map((node) => (
                                    <button
                                      key={node.dbInstanceIdentifier}
                                      type="button"
                                      className={`rds-node-pill ${node.dbInstanceIdentifier === selectedAuroraNodeId ? 'active' : ''}`}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void selectCluster(cluster.dbClusterIdentifier, node.dbInstanceIdentifier)
                                      }}
                                    >
                                      {node.dbInstanceIdentifier}
                                    </button>
                                  ))
                                  : <span className="rds-muted">-</span>}
                              </div>
                            )
                            : column.key === 'reader' ? (
                              <div className="rds-node-pills">
                                {cluster.readerNodes.length
                                  ? cluster.readerNodes.map((node) => (
                                    <button
                                      key={node.dbInstanceIdentifier}
                                      type="button"
                                      className={`rds-node-pill ${node.dbInstanceIdentifier === selectedAuroraNodeId ? 'active' : ''}`}
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void selectCluster(cluster.dbClusterIdentifier, node.dbInstanceIdentifier)
                                      }}
                                    >
                                      {node.dbInstanceIdentifier}
                                    </button>
                                  ))
                                  : <span className="rds-muted">-</span>}
                              </div>
                            )
                            : `${cluster.endpoint}:${cluster.port ?? '-'}`}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredClusters.length && <div className="rds-empty">No Aurora clusters match filters.</div>}
            </>
          )}
        </div>
        </div>
        <div className="rds-sidebar">
          {((mainTab === 'instances' && instanceDetail) || (mainTab === 'aurora' && clusterDetail)) ? (
            <>
              <section className="rds-detail-hero">
                <div className="rds-detail-hero-copy">
                  <div className="eyebrow">{mainTab === 'instances' ? 'Instance posture' : 'Cluster posture'}</div>
                  <h3>{overviewTitle}</h3>
                  <p>{mainTab === 'instances' ? 'Operational posture, maintenance windows, and connection metadata for the selected database.' : 'Topology, failover readiness, and maintenance signals for the selected Aurora cluster.'}</p>
                  <div className="rds-detail-meta-strip">
                    <div className="rds-detail-meta-pill">
                      <span>Status</span>
                      <strong>{overviewStatus ? prettifyStatusLabel(overviewStatus) : 'Unknown'}</strong>
                    </div>
                    <div className="rds-detail-meta-pill">
                      <span>Region</span>
                      <strong>{connection.region}</strong>
                    </div>
                    <div className="rds-detail-meta-pill">
                      <span>Mode</span>
                      <strong>{mainTab === 'instances' ? 'RDS instance' : 'Aurora cluster'}</strong>
                    </div>
                    <div className="rds-detail-meta-pill">
                      <span>Timeline</span>
                      <strong>{timelineStart} to {timelineEnd}</strong>
                    </div>
                  </div>
                </div>
                <div className="rds-detail-hero-stats">
                  {detailHeroStats.map((item) => (
                    <div key={item.id} className={`rds-detail-stat-card ${item.tone}`}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                      <small>{tileToneSummary(item.tone)}</small>
                    </div>
                  ))}
                  {!detailHeroStats.length && (
                    <div className="rds-detail-stat-card info">
                      <span>Selection</span>
                      <strong>Standby</strong>
                      <small>Select a resource to inspect posture.</small>
                    </div>
                  )}
                </div>
              </section>

              <div className="rds-side-tabs">
                <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>
                  Overview
                </button>
                <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>
                  Change Timeline
                </button>
              </div>

              {sideTab === 'overview' && (
                <>
                  {overviewPosture && (
                    <>
                      <div className="rds-sidebar-section">
                        <div className="rds-overview-head">
                          <div>
                            <div className="rds-overview-kicker">{mainTab === 'instances' ? 'Instance operations' : 'Cluster operations'}</div>
                            <h3>{overviewTitle}</h3>
                          </div>
                          {overviewStatus && <StatusBadge status={overviewStatus} />}
                        </div>
                        <SummaryTiles items={overviewPosture.summaryTiles} />
                      </div>

                      <div className="rds-sidebar-section">
                        <h3>Posture</h3>
                        <PostureBadges items={overviewPosture.badges} />
                      </div>
                    </>
                  )}

                  {mainTab === 'instances' && instanceDetail && (
                    <>
                      <div className="rds-sidebar-section">
                        <h3>Operational Findings</h3>
                        <FindingsList items={instanceDetail.posture.findings} />
                      </div>

                  <div className="rds-sidebar-section">
                    <h3>Maintenance</h3>
                    <MaintenanceList items={instanceDetail.posture.maintenanceItems} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Instance Detail</h3>
                    <KV items={[
                      ['Identifier', instanceDetail.summary.dbInstanceIdentifier],
                      ['Engine', `${instanceDetail.summary.engine} ${instanceDetail.summary.engineVersion}`],
                      ['Class', instanceDetail.summary.dbInstanceClass],
                      ['AZ', instanceDetail.summary.availabilityZone],
                      ['Storage', `${instanceDetail.summary.allocatedStorage} GiB (${instanceDetail.storageType})`],
                      ['Subnet Group', instanceDetail.subnetGroup],
                      ['Parameter Groups', instanceDetail.parameterGroups.join(', ') || '-'],
                      ['Maintenance Window', instanceDetail.posture.preferredMaintenanceWindow],
                      ['Backup Window', instanceDetail.posture.preferredBackupWindow],
                      ['Public Access', instanceDetail.publiclyAccessible ? 'Yes' : 'No'],
                      ['Encrypted', instanceDetail.storageEncrypted ? 'Yes' : 'No'],
                      ['CA Certificate', instanceDetail.caCertificateIdentifier]
                    ]} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Replica Topology</h3>
                    <KV items={[
                      ['Replica Source', instanceDetail.posture.replicaTopology?.sourceInstanceIdentifier || '-'],
                      ['Replicas', instanceDetail.posture.replicaTopology?.replicaInstanceIdentifiers.join(', ') || '-'],
                      ['Multi-AZ', instanceDetail.summary.multiAz ? 'Yes' : 'No']
                    ]} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Actions</h3>
                    <div className="rds-actions-grid">
                      <button className="rds-action-btn start" type="button" disabled={busy} onClick={() => void runTask(() => startRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier), 'Start requested')}>
                        Start
                      </button>
                      <ConfirmButton className="rds-action-btn stop" disabled={busy} onConfirm={() => void runTask(() => stopRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier), 'Stop requested')}>
                        Stop
                      </ConfirmButton>
                      <ConfirmButton className="rds-action-btn" disabled={busy} modalTitle="Reboot instance" onConfirm={() => void runTask(() => rebootRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier), 'Reboot requested')}>
                        Reboot
                      </ConfirmButton>
                      {instanceDetail.summary.multiAz && (
                        <ConfirmButton
                          className="rds-action-btn"
                          disabled={busy}
                          modalTitle="Failover reboot"
                          modalBody="You are about to force a Multi-AZ failover reboot. Expect a short interruption while RDS promotes the standby."
                          onConfirm={() => void runTask(() => rebootRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier, true), 'Failover reboot requested')}
                        >
                          Failover Reboot
                        </ConfirmButton>
                      )}
                      <button className="rds-action-btn resize" type="button" disabled={busy} onClick={() => setShowResize((value) => !value)}>
                        Resize
                      </button>
                    </div>
                  </div>

                  {showResize && (
                    <div className="rds-sidebar-section">
                      <h3>Resize Instance</h3>
                      <div className="rds-sidebar-hint">Change will be applied immediately.</div>
                      <div className="rds-inline-form">
                        <input placeholder="e.g. db.t3.medium" value={resizeClass} onChange={(event) => setResizeClass(event.target.value)} />
                        <ConfirmButton className="rds-action-btn apply" disabled={busy || !resizeClass.trim()} modalTitle="Resize instance" onConfirm={() => void runTask(() => resizeRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier, resizeClass.trim()), 'Resize requested')}>
                          Apply
                        </ConfirmButton>
                      </div>
                    </div>
                  )}

                  <div className="rds-sidebar-section">
                    <h3>Create Snapshot</h3>
                    <div className="rds-inline-form">
                      <input placeholder="Snapshot identifier" value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)} />
                      <button className="rds-action-btn apply" type="button" disabled={busy || !snapshotId.trim()} onClick={() => void runTask(() => createRdsSnapshot(connection, instanceDetail.summary.dbInstanceIdentifier, snapshotId.trim()), 'Snapshot creation requested')}>
                        Create
                      </button>
                    </div>
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Connection Metadata</h3>
                    <KV items={overviewConnectionDetails.map((item) => [item.label, item.value])} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Operational Recommendations</h3>
                    <div className="rds-suggestions">
                      {instanceDetail.posture.recommendations.map((item) => (
                        <div key={item} className="rds-suggestion-item">{item}</div>
                      ))}
                    </div>
                  </div>
                    </>
                  )}

                  {mainTab === 'aurora' && clusterDetail && (
                    <>
                      <div className="rds-sidebar-section">
                        <h3>Operational Findings</h3>
                        <FindingsList items={clusterDetail.posture.findings} />
                      </div>

                  <div className="rds-sidebar-section">
                    <h3>Maintenance</h3>
                    <MaintenanceList items={clusterDetail.posture.maintenanceItems} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Cluster Detail</h3>
                    <KV items={[
                      ['Cluster', clusterDetail.summary.dbClusterIdentifier],
                      ['Engine', `${clusterDetail.summary.engine} ${clusterDetail.summary.engineVersion}`],
                      ['Database', clusterDetail.databaseName],
                      ['Serverless v2', clusterDetail.serverlessV2Scaling],
                      ['Subnet Group', clusterDetail.subnetGroup],
                      ['Parameter Groups', clusterDetail.parameterGroups.join(', ') || '-'],
                      ['Maintenance Window', clusterDetail.posture.preferredMaintenanceWindow],
                      ['Backup Window', clusterDetail.posture.preferredBackupWindow],
                      ['Encrypted', clusterDetail.summary.storageEncrypted ? 'Yes' : 'No'],
                      ['Multi-AZ', clusterDetail.summary.multiAz ? 'Yes' : 'No']
                    ]} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Topology</h3>
                    <ClusterNodeMatrix writerNodes={clusterDetail.summary.writerNodes} readerNodes={clusterDetail.summary.readerNodes} selectedNodeId={selectedAuroraNodeId} onSelectNode={setSelectedAuroraNodeId} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Failover Readiness</h3>
                    <div className={`rds-state-card ${toneClass(clusterDetail.posture.failoverReadiness?.ready ? 'good' : 'warning')}`}>
                      <strong>{clusterDetail.posture.failoverReadiness?.summary ?? 'No readiness data'}</strong>
                      {clusterDetail.posture.failoverReadiness?.reasons.length ? (
                        <div className="rds-state-card-body">{clusterDetail.posture.failoverReadiness.reasons.join(' ')}</div>
                      ) : (
                        <div className="rds-state-card-body">Writer and reader topology currently support managed failover.</div>
                      )}
                    </div>
                  </div>

                  {selectedAuroraNode && (
                    <div className="rds-sidebar-section">
                      <h3>Selected Node</h3>
                      <KV items={[
                        ['Identifier', selectedAuroraNode.dbInstanceIdentifier],
                        ['Role', selectedAuroraNode.role],
                        ['Status', selectedAuroraNode.status],
                        ['Class', selectedAuroraNode.dbInstanceClass],
                        ['AZ', selectedAuroraNode.availabilityZone],
                        ['Endpoint', `${selectedAuroraNode.endpoint}:${selectedAuroraNode.port ?? '-'}`]
                      ]} />
                    </div>
                  )}

                  <div className="rds-sidebar-section">
                    <h3>Cluster Actions</h3>
                    <div className="rds-actions-grid">
                      <button className="rds-action-btn start" type="button" disabled={busy} onClick={() => void runTask(() => startRdsCluster(connection, clusterDetail.summary.dbClusterIdentifier), 'Cluster start requested')}>
                        Start
                      </button>
                      <ConfirmButton className="rds-action-btn stop" disabled={busy} onConfirm={() => void runTask(() => stopRdsCluster(connection, clusterDetail.summary.dbClusterIdentifier), 'Cluster stop requested')}>
                        Stop
                      </ConfirmButton>
                      <ConfirmButton className="rds-action-btn" disabled={busy || !selectedAuroraNodeId} modalTitle="Reboot selected node" onConfirm={() => void runTask(() => rebootRdsInstance(connection, selectedAuroraNodeId), 'Node reboot requested')}>
                        Reboot Node
                      </ConfirmButton>
                      <ConfirmButton
                        className="rds-action-btn"
                        disabled={busy}
                        modalTitle="Fail over cluster"
                        modalBody="You are about to trigger an Aurora cluster failover. Expect writer endpoint movement and a brief interruption."
                        onConfirm={() => void runTask(() => failoverRdsCluster(connection, clusterDetail.summary.dbClusterIdentifier), 'Failover requested')}
                      >
                        Failover
                      </ConfirmButton>
                      <button className="rds-action-btn resize" type="button" disabled={busy} onClick={() => setShowResize((value) => !value)}>
                        Resize Node
                      </button>
                    </div>
                  </div>

                  {showResize && (
                    <div className="rds-sidebar-section">
                      <h3>Resize Selected Node</h3>
                      <div className="rds-sidebar-hint">Change will be applied immediately to the selected node.</div>
                      <div className="rds-inline-form">
                        <input placeholder="e.g. db.r6g.large" value={resizeClass} onChange={(event) => setResizeClass(event.target.value)} />
                        <ConfirmButton className="rds-action-btn apply" disabled={busy || !selectedAuroraNodeId || !resizeClass.trim()} modalTitle="Resize selected node" onConfirm={() => void runTask(() => resizeRdsInstance(connection, selectedAuroraNodeId, resizeClass.trim()), 'Node resize requested')}>
                          Apply
                        </ConfirmButton>
                      </div>
                    </div>
                  )}

                  <div className="rds-sidebar-section">
                    <h3>Create Cluster Snapshot</h3>
                    <div className="rds-inline-form">
                      <input placeholder="Snapshot identifier" value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)} />
                      <button className="rds-action-btn apply" type="button" disabled={busy || !snapshotId.trim()} onClick={() => void runTask(() => createRdsClusterSnapshot(connection, clusterDetail.summary.dbClusterIdentifier, snapshotId.trim()), 'Cluster snapshot requested')}>
                        Create
                      </button>
                    </div>
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Connection Metadata</h3>
                    <KV items={overviewConnectionDetails.map((item) => [item.label, item.value])} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Operational Recommendations</h3>
                    <div className="rds-suggestions">
                      {clusterDetail.posture.recommendations.map((item) => (
                        <div key={item} className="rds-suggestion-item">{item}</div>
                      ))}
                    </div>
                  </div>
                    </>
                  )}
                </>
              )}

              {sideTab === 'timeline' && (
                <div className="rds-sidebar-section">
                  <div className="rds-timeline-controls">
                    <label>
                      From
                      <input type="date" value={timelineStart} onChange={(event) => setTimelineStart(event.target.value)} />
                    </label>
                    <label>
                      To
                      <input type="date" value={timelineEnd} onChange={(event) => setTimelineEnd(event.target.value)} />
                    </label>
                  </div>
                  {!hasTimelineResource && <div className="rds-empty">Select a resource to view events.</div>}
                  {hasTimelineResource && timelineLoading && <div className="rds-empty">Loading events...</div>}
                  {hasTimelineResource && !timelineLoading && timelineError && <div className="rds-empty" style={{ color: '#f87171' }}>{timelineError}</div>}
                  {hasTimelineResource && !timelineLoading && !timelineError && timelineEvents.length === 0 && <div className="rds-empty">No CloudTrail events found.</div>}
                  {hasTimelineResource && !timelineLoading && timelineEvents.length > 0 && (
                    <div className="rds-timeline-table-wrap">
                      <table className="rds-timeline-table">
                        <thead>
                          <tr>
                            <th>Event</th>
                            <th>User</th>
                            <th>Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {timelineEvents.map((event) => (
                            <tr key={event.eventId}>
                              <td title={event.eventSource}>{event.eventName}</td>
                              <td>{event.username}</td>
                              <td>{event.eventTime !== '-' ? new Date(event.eventTime).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="rds-sidebar-section">
              <div className="rds-empty-state">
                <span className="rds-pane-kicker">{mainTab === 'instances' ? 'No instance selected' : 'No cluster selected'}</span>
                <h3>{mainTab === 'instances' ? 'Choose a database to inspect posture.' : 'Choose a cluster to inspect topology.'}</h3>
                <p>
                  {mainTab === 'instances'
                    ? 'The detail pane will show maintenance windows, replica topology, actions, and CloudTrail changes for the selected instance.'
                    : 'The detail pane will show topology, failover readiness, cluster actions, and CloudTrail changes for the selected Aurora resource.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
