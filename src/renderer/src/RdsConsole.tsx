import { useEffect, useMemo, useState } from 'react'
import './rds.css'

import type {
  AwsConnection,
  CloudTrailEventSummary,
  RdsClusterDetail,
  RdsClusterSummary,
  RdsInstanceDetail,
  RdsInstanceSummary
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

export function RdsConsole({ connection }: { connection: AwsConnection }) {
  const [mainTab, setMainTab] = useState<MainTab>('instances')
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  /* ── Filter state ──────────────────────────────────────── */
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [visibleInstanceCols, setVisibleInstanceCols] = useState<Set<InstanceColumnKey>>(
    new Set(INSTANCE_COLUMNS.map(c => c.key))
  )
  const [visibleAuroraCols, setVisibleAuroraCols] = useState<Set<AuroraColumnKey>>(
    new Set(AURORA_COLUMNS.map(c => c.key))
  )

  /* ── Data state ────────────────────────────────────────── */
  const [instances, setInstances] = useState<RdsInstanceSummary[]>([])
  const [clusters, setClusters] = useState<RdsClusterSummary[]>([])
  const [selectedInstanceId, setSelectedInstanceId] = useState('')
  const [selectedClusterId, setSelectedClusterId] = useState('')
  const [selectedAuroraNodeId, setSelectedAuroraNodeId] = useState('')
  const [instanceDetail, setInstanceDetail] = useState<RdsInstanceDetail | null>(null)
  const [clusterDetail, setClusterDetail] = useState<RdsClusterDetail | null>(null)

  /* ── Action state ──────────────────────────────────────── */
  const [resizeClass, setResizeClass] = useState('')
  const [showResize, setShowResize] = useState(false)
  const [snapshotId, setSnapshotId] = useState('')

  /* ── Timeline state ────────────────────────────────────── */
  const [timelineEvents, setTimelineEvents] = useState<CloudTrailEventSummary[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [timelineStart, setTimelineStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => new Date().toISOString().slice(0, 10))

  /* ── Derived data ──────────────────────────────────────── */
  const selectedInstance = useMemo(() => instances.find(i => i.dbInstanceIdentifier === selectedInstanceId) ?? null, [instances, selectedInstanceId])
  const selectedCluster = useMemo(() => clusters.find(c => c.dbClusterIdentifier === selectedClusterId) ?? null, [clusters, selectedClusterId])
  const selectedAuroraNode = useMemo(() => {
    if (!selectedCluster) return null
    return [...selectedCluster.writerNodes, ...selectedCluster.readerNodes].find(n => n.dbInstanceIdentifier === selectedAuroraNodeId) ?? null
  }, [selectedCluster, selectedAuroraNodeId])

  const suggestions = useMemo(() => {
    if (mainTab === 'instances' && selectedInstance) {
      const items: string[] = []
      if (selectedInstance.status !== 'available') items.push(`Instance is ${selectedInstance.status}. Avoid resize or snapshot until available.`)
      if (!selectedInstance.multiAz) items.push('Multi-AZ is disabled. Failover protection is limited.')
      if (selectedInstance.allocatedStorage < 100) items.push(`Storage is ${selectedInstance.allocatedStorage} GiB. Verify headroom.`)
      if (selectedInstance.endpoint === '-') items.push('No endpoint exposed. Check start state.')
      return items.length ? items : ['Instance looks healthy. Review timeline before disruptive actions.']
    }
    if (mainTab === 'aurora' && selectedCluster) {
      const items: string[] = []
      if (!selectedCluster.readerNodes.length) items.push('No reader nodes. Read scaling and failover capacity are limited.')
      if (selectedCluster.status !== 'available') items.push(`Cluster is ${selectedCluster.status}. Expect connection churn.`)
      if (!selectedCluster.storageEncrypted) items.push('Storage encryption is disabled.')
      if (!selectedCluster.multiAz) items.push('Single AZ. HA posture may be weaker than expected.')
      return items.length ? items : ['Cluster looks healthy. Use timeline to verify recent changes.']
    }
    return ['Select a resource to see suggestions.']
  }, [mainTab, selectedCluster, selectedInstance])

  /* ── Filtering ─────────────────────────────────────────── */
  const filteredInstances = useMemo(() => {
    return instances.filter(inst => {
      if (statusFilter !== 'all' && inst.status !== statusFilter) return false
      if (search) {
        const needle = search.toLowerCase()
        return Array.from(visibleInstanceCols).some(col => getInstanceColumnValue(inst, col).toLowerCase().includes(needle))
      }
      return true
    })
  }, [instances, statusFilter, search, visibleInstanceCols])

  const filteredClusters = useMemo(() => {
    return clusters.filter(cluster => {
      if (statusFilter !== 'all' && cluster.status !== statusFilter) return false
      if (search) {
        const needle = search.toLowerCase()
        const values: Record<AuroraColumnKey, string> = {
          cluster: cluster.dbClusterIdentifier,
          engine: `${cluster.engine} ${cluster.engineVersion}`,
          status: cluster.status,
          writer: cluster.writerNodes.map(n => n.dbInstanceIdentifier).join(' '),
          reader: cluster.readerNodes.map(n => n.dbInstanceIdentifier).join(' '),
          endpoint: `${cluster.endpoint} ${cluster.readerEndpoint}`
        }
        return [...visibleAuroraCols].some(key => values[key].toLowerCase().includes(needle))
      }
      return true
    })
  }, [clusters, statusFilter, search, visibleAuroraCols])

  const activeInstanceCols = INSTANCE_COLUMNS.filter(c => visibleInstanceCols.has(c.key))
  const activeAuroraCols = AURORA_COLUMNS.filter(c => visibleAuroraCols.has(c.key))

  /* ── Data loading ──────────────────────────────────────── */
  async function reload(preferredInstanceId?: string, preferredClusterId?: string, preferredNodeId?: string) {
    setLoading(true)
    setMsg('')
    try {
      const [nextInstances, nextClusters] = await Promise.all([listRdsInstances(connection), listRdsClusters(connection)])
      setInstances(nextInstances)
      setClusters(nextClusters)

      const resolvedInstanceId = preferredInstanceId && nextInstances.some(i => i.dbInstanceIdentifier === preferredInstanceId)
        ? preferredInstanceId : nextInstances[0]?.dbInstanceIdentifier ?? ''
      const resolvedClusterId = preferredClusterId && nextClusters.some(c => c.dbClusterIdentifier === preferredClusterId)
        ? preferredClusterId : nextClusters[0]?.dbClusterIdentifier ?? ''

      setSelectedInstanceId(resolvedInstanceId)
      setSelectedClusterId(resolvedClusterId)

      if (resolvedInstanceId) {
        const detail = await describeRdsInstance(connection, resolvedInstanceId)
        setInstanceDetail(detail)
        setResizeClass(detail.summary.dbInstanceClass)
        setSnapshotId(buildSnapshotId(detail.summary.dbInstanceIdentifier))
      } else {
        setInstanceDetail(null)
      }

      if (resolvedClusterId) {
        const detail = await describeRdsCluster(connection, resolvedClusterId)
        setClusterDetail(detail)
        const resolvedCluster = nextClusters.find(c => c.dbClusterIdentifier === resolvedClusterId) ?? null
        const defaultNodeId = resolvedCluster?.writerNodes[0]?.dbInstanceIdentifier ?? resolvedCluster?.readerNodes[0]?.dbInstanceIdentifier ?? ''
        const clusterNodes = [...(resolvedCluster?.writerNodes ?? []), ...(resolvedCluster?.readerNodes ?? [])]
        const resolvedNodeId = preferredNodeId && clusterNodes.some(n => n.dbInstanceIdentifier === preferredNodeId) ? preferredNodeId : defaultNodeId
        setSelectedAuroraNodeId(resolvedNodeId)
        const targetNode = detail.summary.writerNodes.find(n => n.dbInstanceIdentifier === resolvedNodeId)
          ?? detail.summary.readerNodes.find(n => n.dbInstanceIdentifier === resolvedNodeId)
        setResizeClass(targetNode?.dbInstanceClass ?? '')
        setSnapshotId(buildSnapshotId(detail.summary.dbClusterIdentifier))
      } else {
        setClusterDetail(null)
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [connection.profile, connection.region])

  async function selectInstance(id: string) {
    setSelectedInstanceId(id)
    setSideTab('overview')
    setMsg('')
    setTimelineEvents([])
    setTimelineError('')
    const detail = await describeRdsInstance(connection, id)
    setInstanceDetail(detail)
    setResizeClass(detail.summary.dbInstanceClass)
    setSnapshotId(buildSnapshotId(detail.summary.dbInstanceIdentifier))
  }

  async function selectCluster(clusterId: string, nodeId?: string) {
    setSelectedClusterId(clusterId)
    setSideTab('overview')
    setMsg('')
    setTimelineEvents([])
    setTimelineError('')
    const detail = await describeRdsCluster(connection, clusterId)
    setClusterDetail(detail)
    const targetNode = detail.summary.writerNodes.find(n => n.dbInstanceIdentifier === nodeId)
      ?? detail.summary.readerNodes.find(n => n.dbInstanceIdentifier === nodeId)
      ?? detail.summary.writerNodes[0]
      ?? detail.summary.readerNodes[0]
      ?? null
    setSelectedAuroraNodeId(targetNode?.dbInstanceIdentifier ?? '')
    setResizeClass(targetNode?.dbInstanceClass ?? '')
    setSnapshotId(buildSnapshotId(detail.summary.dbClusterIdentifier))
  }

  /* ── Action handlers ───────────────────────────────────── */
  async function runTask(task: () => Promise<void>, successMessage: string) {
    setBusy(true)
    setMsg('')
    try {
      await task()
      setMsg(successMessage)
      await reload(selectedInstanceId, selectedClusterId, selectedAuroraNodeId)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /* ── Timeline ──────────────────────────────────────────── */
  async function loadTimeline() {
    const resourceName = mainTab === 'instances' ? selectedInstanceId : selectedAuroraNodeId || selectedClusterId
    if (!resourceName) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const events = await lookupCloudTrailEventsByResource(
        connection, resourceName,
        new Date(timelineStart).toISOString(),
        new Date(timelineEnd + 'T23:59:59').toISOString()
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
    if (sideTab === 'timeline') void loadTimeline()
  }, [sideTab, mainTab, selectedInstanceId, selectedClusterId, selectedAuroraNodeId, timelineStart, timelineEnd])

  function toggleInstanceCol(key: InstanceColumnKey) {
    setVisibleInstanceCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAuroraCol(key: AuroraColumnKey) {
    setVisibleAuroraCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (loading) return <div className="rds-empty">Loading RDS data...</div>

  /* ── Helper: which resource is selected for timeline ──── */
  const hasTimelineResource = mainTab === 'instances' ? !!selectedInstanceId : !!(selectedClusterId || selectedAuroraNodeId)

  return (
    <div className="rds-console">
      {/* ── Main tabs ─────────────────────────────────── */}
      <div className="rds-tab-bar">
        <button
          className={`rds-tab ${mainTab === 'instances' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('instances')}
        >RDS Instances</button>
        <button
          className={`rds-tab ${mainTab === 'aurora' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('aurora')}
        >Aurora Clusters</button>
        <button className="rds-tab" type="button" onClick={() => void reload(selectedInstanceId, selectedClusterId, selectedAuroraNodeId)} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      {msg && <div className="rds-msg">{msg}</div>}

      {/* ── Filter bar ───────────────────────────────── */}
      <div className="rds-filter-bar">
        <span className="rds-filter-label">Status</span>
        <select
          className="rds-select"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
        >
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

      <input
        className="rds-search-input"
        placeholder="Filter rows across selected columns..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      <div className="rds-column-chips">
        {(mainTab === 'instances' ? INSTANCE_COLUMNS : AURORA_COLUMNS).map(col => {
          const active = mainTab === 'instances'
            ? visibleInstanceCols.has(col.key as InstanceColumnKey)
            : visibleAuroraCols.has(col.key as AuroraColumnKey)
          return (
            <button
              key={col.key}
              className={`rds-chip ${active ? 'active' : ''}`}
              type="button"
              style={active ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
              onClick={() => mainTab === 'instances'
                ? toggleInstanceCol(col.key as InstanceColumnKey)
                : toggleAuroraCol(col.key as AuroraColumnKey)
              }
            >
              {col.label}
            </button>
          )
        })}
      </div>

      {/* ── Main layout (table + sidebar) ─────────────── */}
      <div className="rds-main-layout">
        {/* ── Table area ──────────────────────────── */}
        <div className="rds-table-area">
          {mainTab === 'instances' ? (
            <>
              <table className="rds-data-table">
                <thead>
                  <tr>
                    {activeInstanceCols.map(col => (
                      <th key={col.key}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredInstances.map(inst => (
                    <tr
                      key={inst.dbInstanceIdentifier}
                      className={inst.dbInstanceIdentifier === selectedInstanceId ? 'active' : ''}
                      onClick={() => void selectInstance(inst.dbInstanceIdentifier)}
                    >
                      {activeInstanceCols.map(col => (
                        <td key={col.key}>
                          {col.key === 'status'
                            ? <span className={`rds-badge ${inst.status}`}>{inst.status}</span>
                            : getInstanceColumnValue(inst, col.key)
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredInstances.length && (
                <div className="rds-empty">No RDS instances match filters.</div>
              )}
            </>
          ) : (
            <>
              <table className="rds-data-table">
                <thead>
                  <tr>
                    {activeAuroraCols.map(col => (
                      <th key={col.key}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredClusters.map(cluster => (
                    <tr
                      key={cluster.dbClusterIdentifier}
                      className={cluster.dbClusterIdentifier === selectedClusterId ? 'active' : ''}
                      onClick={() => void selectCluster(cluster.dbClusterIdentifier)}
                    >
                      {activeAuroraCols.map(col => (
                        <td key={col.key}>
                          {col.key === 'status'
                            ? <span className={`rds-badge ${cluster.status}`}>{cluster.status}</span>
                            : col.key === 'cluster' ? cluster.dbClusterIdentifier
                            : col.key === 'engine' ? `${cluster.engine} ${cluster.engineVersion}`
                            : col.key === 'writer' ? (
                              <div className="rds-node-pills">
                                {cluster.writerNodes.length ? cluster.writerNodes.map(n => (
                                  <button
                                    key={n.dbInstanceIdentifier}
                                    type="button"
                                    className={`rds-node-pill ${n.dbInstanceIdentifier === selectedAuroraNodeId ? 'active' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); void selectCluster(cluster.dbClusterIdentifier, n.dbInstanceIdentifier) }}
                                  >
                                    {n.dbInstanceIdentifier}
                                  </button>
                                )) : <span className="rds-muted">—</span>}
                              </div>
                            )
                            : col.key === 'reader' ? (
                              <div className="rds-node-pills">
                                {cluster.readerNodes.length ? cluster.readerNodes.map(n => (
                                  <button
                                    key={n.dbInstanceIdentifier}
                                    type="button"
                                    className={`rds-node-pill ${n.dbInstanceIdentifier === selectedAuroraNodeId ? 'active' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); void selectCluster(cluster.dbClusterIdentifier, n.dbInstanceIdentifier) }}
                                  >
                                    {n.dbInstanceIdentifier}
                                  </button>
                                )) : <span className="rds-muted">—</span>}
                              </div>
                            )
                            : col.key === 'endpoint' ? `${cluster.endpoint}:${cluster.port ?? '-'}`
                            : ''
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredClusters.length && (
                <div className="rds-empty">No Aurora clusters match filters.</div>
              )}
            </>
          )}
        </div>

        {/* ── Sidebar ─────────────────────────────── */}
        <div className="rds-sidebar">
          <div className="rds-side-tabs">
            <button
              className={sideTab === 'overview' ? 'active' : ''}
              type="button"
              onClick={() => setSideTab('overview')}
            >Overview</button>
            <button
              className={sideTab === 'timeline' ? 'active' : ''}
              type="button"
              onClick={() => setSideTab('timeline')}
            >Change Timeline</button>
          </div>

          {sideTab === 'overview' && (
            <>
              {/* ══════════════ INSTANCE OVERVIEW ══════════════ */}
              {mainTab === 'instances' && instanceDetail && (
                <>
                  {/* Details */}
                  <div className="rds-sidebar-section">
                    <h3>Instance Details</h3>
                    <KV items={[
                      ['Identifier', instanceDetail.summary.dbInstanceIdentifier],
                      ['Status', instanceDetail.summary.status],
                      ['Engine', `${instanceDetail.summary.engine} ${instanceDetail.summary.engineVersion}`],
                      ['Class', instanceDetail.summary.dbInstanceClass],
                      ['AZ', instanceDetail.summary.availabilityZone],
                      ['Storage', `${instanceDetail.summary.allocatedStorage} GiB (${instanceDetail.storageType})`],
                      ['Multi-AZ', instanceDetail.summary.multiAz ? 'Yes' : 'No'],
                      ['Encrypted', instanceDetail.storageEncrypted ? 'Yes' : 'No'],
                      ['Subnet Group', instanceDetail.subnetGroup],
                      ['Public Access', instanceDetail.publiclyAccessible ? 'Yes' : 'No'],
                    ]} />
                  </div>

                  {/* Actions */}
                  <div className="rds-sidebar-section">
                    <h3>Actions</h3>
                    <div className="rds-actions-grid">
                      <button className="rds-action-btn start" type="button" disabled={busy}
                        onClick={() => void runTask(() => startRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier), 'Start requested')}>Start</button>
                      <ConfirmButton className="rds-action-btn stop" type="button" disabled={busy}
                        onConfirm={() => void runTask(() => stopRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier), 'Stop requested')}>Stop</ConfirmButton>
                      <button className="rds-action-btn" type="button" disabled={busy}
                        onClick={() => void runTask(() => rebootRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier), 'Reboot requested')}>Reboot</button>
                      {instanceDetail.summary.multiAz && (
                        <button className="rds-action-btn" type="button" disabled={busy}
                          onClick={() => void runTask(() => rebootRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier, true), 'Failover reboot requested')}>Failover Reboot</button>
                      )}
                      <button className="rds-action-btn resize" type="button" onClick={() => setShowResize(!showResize)}>Resize</button>
                    </div>
                  </div>

                  {/* Resize (expandable) */}
                  {showResize && (
                    <div className="rds-sidebar-section">
                      <h3>Resize Instance</h3>
                      <div className="rds-sidebar-hint">Change will be applied immediately.</div>
                      <div className="rds-inline-form">
                        <input placeholder="e.g. db.t3.medium" value={resizeClass} onChange={e => setResizeClass(e.target.value)} />
                        <button className="rds-action-btn apply" type="button" disabled={busy || !resizeClass.trim()}
                          onClick={() => void runTask(() => resizeRdsInstance(connection, instanceDetail.summary.dbInstanceIdentifier, resizeClass.trim()), 'Resize requested')}>Apply</button>
                      </div>
                    </div>
                  )}

                  {/* Snapshot */}
                  <div className="rds-sidebar-section">
                    <h3>Create Snapshot</h3>
                    <div className="rds-inline-form">
                      <input placeholder="Snapshot identifier" value={snapshotId} onChange={e => setSnapshotId(e.target.value)} />
                      <button className="rds-action-btn apply" type="button" disabled={busy || !snapshotId.trim()}
                        onClick={() => void runTask(() => createRdsSnapshot(connection, instanceDetail.summary.dbInstanceIdentifier, snapshotId.trim()), 'Snapshot creation requested')}>Create</button>
                    </div>
                  </div>

                  {/* Connection Details */}
                  <div className="rds-sidebar-section">
                    <h3>Connection Details</h3>
                    <KV items={instanceDetail.connectionDetails.map(d => [d.label, d.value])} />
                  </div>

                  {/* Suggestions */}
                  <div className="rds-sidebar-section">
                    <h3>Suggestions</h3>
                    <div className="rds-suggestions">
                      {suggestions.map(item => (
                        <div key={item} className="rds-suggestion-item">{item}</div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* ══════════════ AURORA OVERVIEW ══════════════ */}
              {mainTab === 'aurora' && clusterDetail && (
                <>
                  {/* Cluster Details */}
                  <div className="rds-sidebar-section">
                    <h3>Cluster Details</h3>
                    <KV items={[
                      ['Cluster', clusterDetail.summary.dbClusterIdentifier],
                      ['Status', clusterDetail.summary.status],
                      ['Engine', `${clusterDetail.summary.engine} ${clusterDetail.summary.engineVersion}`],
                      ['Writer Nodes', String(clusterDetail.summary.writerNodes.length)],
                      ['Reader Nodes', String(clusterDetail.summary.readerNodes.length)],
                      ['Encrypted', clusterDetail.summary.storageEncrypted ? 'Yes' : 'No'],
                      ['Multi-AZ', clusterDetail.summary.multiAz ? 'Yes' : 'No'],
                      ['Database', clusterDetail.databaseName],
                      ['Serverless v2', clusterDetail.serverlessV2Scaling],
                    ]} />
                  </div>

                  {/* Selected Node */}
                  {selectedAuroraNode && (
                    <div className="rds-sidebar-section">
                      <h3>Selected Node</h3>
                      <KV items={[
                        ['Identifier', selectedAuroraNode.dbInstanceIdentifier],
                        ['Role', selectedAuroraNode.role],
                        ['Status', selectedAuroraNode.status],
                        ['Class', selectedAuroraNode.dbInstanceClass],
                        ['AZ', selectedAuroraNode.availabilityZone],
                        ['Endpoint', `${selectedAuroraNode.endpoint}:${selectedAuroraNode.port ?? '-'}`],
                      ]} />
                    </div>
                  )}

                  {/* Cluster Actions */}
                  <div className="rds-sidebar-section">
                    <h3>Cluster Actions</h3>
                    <div className="rds-actions-grid">
                      <button className="rds-action-btn start" type="button" disabled={busy}
                        onClick={() => void runTask(() => startRdsCluster(connection, clusterDetail.summary.dbClusterIdentifier), 'Cluster start requested')}>Start</button>
                      <ConfirmButton className="rds-action-btn stop" type="button" disabled={busy}
                        onConfirm={() => void runTask(() => stopRdsCluster(connection, clusterDetail.summary.dbClusterIdentifier), 'Cluster stop requested')}>Stop</ConfirmButton>
                      <button className="rds-action-btn" type="button" disabled={busy || !selectedAuroraNodeId}
                        onClick={() => void runTask(() => rebootRdsInstance(connection, selectedAuroraNodeId), 'Node reboot requested')}>Reboot Node</button>
                      <button className="rds-action-btn" type="button" disabled={busy}
                        onClick={() => void runTask(() => failoverRdsCluster(connection, clusterDetail.summary.dbClusterIdentifier), 'Failover requested')}>Failover</button>
                    </div>
                  </div>

                  {/* Resize Node */}
                  <div className="rds-sidebar-section">
                    <h3>Resize Selected Node</h3>
                    <div className="rds-sidebar-hint">Change will be applied immediately to the selected node.</div>
                    <div className="rds-inline-form">
                      <input placeholder="e.g. db.r6g.large" value={resizeClass} onChange={e => setResizeClass(e.target.value)} />
                      <button className="rds-action-btn apply" type="button" disabled={busy || !selectedAuroraNodeId || !resizeClass.trim()}
                        onClick={() => void runTask(() => resizeRdsInstance(connection, selectedAuroraNodeId, resizeClass.trim()), 'Node resize requested')}>Apply</button>
                    </div>
                  </div>

                  {/* Cluster Snapshot */}
                  <div className="rds-sidebar-section">
                    <h3>Create Cluster Snapshot</h3>
                    <div className="rds-inline-form">
                      <input placeholder="Snapshot identifier" value={snapshotId} onChange={e => setSnapshotId(e.target.value)} />
                      <button className="rds-action-btn apply" type="button" disabled={busy || !snapshotId.trim()}
                        onClick={() => void runTask(() => createRdsClusterSnapshot(connection, clusterDetail.summary.dbClusterIdentifier, snapshotId.trim()), 'Cluster snapshot requested')}>Create</button>
                    </div>
                  </div>

                  {/* Connection Details */}
                  <div className="rds-sidebar-section">
                    <h3>Connection Details</h3>
                    <KV items={clusterDetail.connectionDetails.map(d => [d.label, d.value])} />
                  </div>

                  {/* Suggestions */}
                  <div className="rds-sidebar-section">
                    <h3>Suggestions</h3>
                    <div className="rds-suggestions">
                      {suggestions.map(item => (
                        <div key={item} className="rds-suggestion-item">{item}</div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* No selection */}
              {((mainTab === 'instances' && !instanceDetail) || (mainTab === 'aurora' && !clusterDetail)) && (
                <div className="rds-sidebar-section">
                  <div className="rds-empty">Select a resource to view details.</div>
                </div>
              )}
            </>
          )}

          {sideTab === 'timeline' && (
            <div className="rds-sidebar-section">
              <div className="rds-timeline-controls">
                <label>
                  From
                  <input type="date" value={timelineStart} onChange={e => setTimelineStart(e.target.value)} />
                </label>
                <label>
                  To
                  <input type="date" value={timelineEnd} onChange={e => setTimelineEnd(e.target.value)} />
                </label>
              </div>
              {!hasTimelineResource && <div className="rds-empty">Select a resource to view events.</div>}
              {hasTimelineResource && timelineLoading && <div className="rds-empty">Loading events…</div>}
              {hasTimelineResource && !timelineLoading && timelineError && (
                <div className="rds-empty" style={{ color: '#f87171' }}>{timelineError}</div>
              )}
              {hasTimelineResource && !timelineLoading && !timelineError && timelineEvents.length === 0 && (
                <div className="rds-empty">No CloudTrail events found.</div>
              )}
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
                      {timelineEvents.map(ev => (
                        <tr key={ev.eventId}>
                          <td title={ev.eventSource}>{ev.eventName}</td>
                          <td>{ev.username}</td>
                          <td>{ev.eventTime !== '-' ? new Date(ev.eventTime).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
