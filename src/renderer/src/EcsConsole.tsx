import { useEffect, useMemo, useState } from 'react'
import './ecs.css'

import type {
  AwsConnection,
  EcsContainerSummary,
  EcsServiceDetail,
  EcsServiceSummary,
  EcsTaskSummary
} from '@shared/types'
import {
  describeEcsService,
  forceEcsRedeploy,
  getEcsContainerLogs,
  listEcsClusters,
  listEcsServices,
  listEcsTasks,
  stopEcsTask,
  updateEcsDesiredCount
} from './api'
import { ConfirmButton } from './ConfirmButton'

type MainTab = 'services' | 'tasks'
type SideTab = 'overview' | 'events'
type ServiceColumnKey = 'serviceName' | 'status' | 'running' | 'launchType' | 'taskDefinition' | 'deploymentStatus'
type TaskColumnKey = 'taskId' | 'lastStatus' | 'startedAt' | 'cpu' | 'memory' | 'containers'

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
  { key: 'startedAt', label: 'Started', color: '#14b8a6' },
  { key: 'cpu', label: 'CPU', color: '#8b5cf6' },
  { key: 'memory', label: 'Memory', color: '#f59e0b' },
  { key: 'containers', label: 'Containers', color: '#06b6d4' }
]

function fmtTs(v: string) { return v && v !== '-' ? new Date(v).toLocaleString() : '-' }

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

export function EcsConsole({ connection }: { connection: AwsConnection }) {
  const [mainTab, setMainTab] = useState<MainTab>('services')
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  /* ── Filter state ──────────────────────────────────────── */
  const [search, setSearch] = useState('')
  const [visibleServiceCols, setVisibleServiceCols] = useState<Set<ServiceColumnKey>>(
    new Set(SERVICE_COLUMNS.map(c => c.key))
  )
  const [visibleTaskCols, setVisibleTaskCols] = useState<Set<TaskColumnKey>>(
    new Set(TASK_COLUMNS.map(c => c.key))
  )

  /* ── Data state ────────────────────────────────────────── */
  const [clusters, setClusters] = useState<Array<{ clusterArn: string; clusterName: string; activeServicesCount: number; runningTasksCount: number }>>([])
  const [selectedClusterArn, setSelectedClusterArn] = useState('')
  const [services, setServices] = useState<EcsServiceSummary[]>([])
  const [selectedServiceName, setSelectedServiceName] = useState('')
  const [detail, setDetail] = useState<EcsServiceDetail | null>(null)
  const [tasks, setTasks] = useState<EcsTaskSummary[]>([])
  const [logs, setLogs] = useState<Array<{ timestamp: number; message: string }>>([])
  const [logContainer, setLogContainer] = useState('')

  /* ── Action state ──────────────────────────────────────── */
  const [desiredCount, setDesiredCount] = useState('1')

  /* ── Derived ───────────────────────────────────────────── */
  const selectedCluster = useMemo(() => clusters.find(c => c.clusterArn === selectedClusterArn) ?? null, [clusters, selectedClusterArn])

  const activeServiceCols = SERVICE_COLUMNS.filter(c => visibleServiceCols.has(c.key))
  const activeTaskCols = TASK_COLUMNS.filter(c => visibleTaskCols.has(c.key))

  const filteredServices = useMemo(() => {
    if (!search) return services
    const q = search.toLowerCase()
    return services.filter(svc =>
      Array.from(visibleServiceCols).some(key => getServiceCellValue(svc, key).toLowerCase().includes(q))
    )
  }, [services, search, visibleServiceCols])

  const filteredTasks = useMemo(() => {
    if (!search) return tasks
    const q = search.toLowerCase()
    return tasks.filter(t => {
      const taskId = t.taskArn.split('/').pop() ?? ''
      return taskId.toLowerCase().includes(q) || t.lastStatus.toLowerCase().includes(q)
    })
  }, [tasks, search])

  /* ── Data loading ──────────────────────────────────────── */
  async function load(clusterArn?: string, serviceName?: string) {
    setLoading(true)
    setError('')
    try {
      const nextClusters = await listEcsClusters(connection)
      setClusters(nextClusters)
      const resolvedCluster = clusterArn ?? selectedClusterArn ?? nextClusters[0]?.clusterArn ?? ''
      setSelectedClusterArn(resolvedCluster)
      if (!resolvedCluster) { setLoading(false); return }

      const nextServices = await listEcsServices(connection, resolvedCluster)
      setServices(nextServices)
      const resolvedService = serviceName ?? selectedServiceName ?? nextServices[0]?.serviceName ?? ''
      setSelectedServiceName(resolvedService)

      if (resolvedService) {
        const [nextDetail, nextTasks] = await Promise.all([
          describeEcsService(connection, resolvedCluster, resolvedService),
          listEcsTasks(connection, resolvedCluster, resolvedService)
        ])
        setDetail(nextDetail)
        setDesiredCount(String(nextDetail.desiredCount))
        setTasks(nextTasks)
      } else {
        setDetail(null)
        setTasks([])
      }
      setLogs([])
      setLogContainer('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

useEffect(() => { void load() }, [connection.sessionId, connection.region])

  async function selectService(serviceName: string) {
    setSelectedServiceName(serviceName)
    setSideTab('overview')
    setMsg('')
    setLogs([])
    setLogContainer('')
    try {
      const [nextDetail, nextTasks] = await Promise.all([
        describeEcsService(connection, selectedClusterArn, serviceName),
        listEcsTasks(connection, selectedClusterArn, serviceName)
      ])
      setDetail(nextDetail)
      setDesiredCount(String(nextDetail.desiredCount))
      setTasks(nextTasks)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Actions ───────────────────────────────────────────── */
  async function doScale() {
    setBusy(true)
    setMsg('')
    try {
      await updateEcsDesiredCount(connection, selectedClusterArn, selectedServiceName, Number(desiredCount) || 0)
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
      await forceEcsRedeploy(connection, selectedClusterArn, selectedServiceName)
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
      await stopEcsTask(connection, selectedClusterArn, taskArn)
      setMsg('Task stopped')
      await load(selectedClusterArn, selectedServiceName)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function loadLogs(container: EcsContainerSummary) {
    if (!container.logGroup || !container.logStream) return
    setLogContainer(container.name)
    try {
      setLogs(await getEcsContainerLogs(connection, container.logGroup, container.logStream))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function toggleServiceCol(key: ServiceColumnKey) {
    setVisibleServiceCols(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }

  function toggleTaskCol(key: TaskColumnKey) {
    setVisibleTaskCols(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }

  if (loading) return <div className="ecs-empty">Loading ECS data...</div>

  return (
    <div className="ecs-console">
      {/* ── Main tabs ─────────────────────────────────── */}
      <div className="ecs-tab-bar">
        <button
          className={`ecs-tab ${mainTab === 'services' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('services')}
        >Services</button>
        <button
          className={`ecs-tab ${mainTab === 'tasks' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('tasks')}
        >Tasks ({tasks.length})</button>
        <button className="ecs-tab" type="button" onClick={() => void load(selectedClusterArn, selectedServiceName)} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      {error && <div className="ecs-error">{error}</div>}
      {msg && <div className="ecs-msg">{msg}</div>}

      {/* ── Cluster selector ─────────────────────────── */}
      <div className="ecs-filter-bar">
        <span className="ecs-filter-label">Cluster</span>
        <select
          className="ecs-select"
          value={selectedClusterArn}
          onChange={e => void load(e.target.value)}
        >
          {clusters.map(c => (
            <option key={c.clusterArn} value={c.clusterArn}>{c.clusterName} ({c.activeServicesCount} svc / {c.runningTasksCount} tasks)</option>
          ))}
          {!clusters.length && <option value="">No clusters</option>}
        </select>
      </div>

      <input
        className="ecs-search-input"
        placeholder="Filter rows across selected columns..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      <div className="ecs-column-chips">
        {(mainTab === 'services' ? SERVICE_COLUMNS : TASK_COLUMNS).map(col => {
          const active = mainTab === 'services'
            ? visibleServiceCols.has(col.key as ServiceColumnKey)
            : visibleTaskCols.has(col.key as TaskColumnKey)
          return (
            <button
              key={col.key}
              className={`ecs-chip ${active ? 'active' : ''}`}
              type="button"
              style={active ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
              onClick={() => mainTab === 'services'
                ? toggleServiceCol(col.key as ServiceColumnKey)
                : toggleTaskCol(col.key as TaskColumnKey)
              }
            >
              {col.label}
            </button>
          )
        })}
      </div>

      {/* ── Main layout (table + sidebar) ─────────────── */}
      <div className="ecs-main-layout">
        <div className="ecs-table-area">
          {mainTab === 'services' ? (
            <>
              <table className="ecs-data-table">
                <thead>
                  <tr>
                    {activeServiceCols.map(col => <th key={col.key}>{col.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredServices.map(svc => (
                    <tr
                      key={svc.serviceName}
                      className={svc.serviceName === selectedServiceName ? 'active' : ''}
                      onClick={() => void selectService(svc.serviceName)}
                    >
                      {activeServiceCols.map(col => (
                        <td key={col.key}>
                          {col.key === 'status'
                            ? <span className={`ecs-badge ${svc.status}`}>{svc.status}</span>
                            : col.key === 'deploymentStatus'
                            ? <span className={`ecs-badge ${svc.deploymentStatus}`}>{svc.deploymentStatus}</span>
                            : getServiceCellValue(svc, col.key)
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredServices.length && <div className="ecs-empty">No services match filters.</div>}
            </>
          ) : (
            <>
              <table className="ecs-data-table">
                <thead>
                  <tr>
                    {activeTaskCols.map(col => <th key={col.key}>{col.label}</th>)}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map(t => {
                    const taskId = t.taskArn.split('/').pop() ?? t.taskArn
                    return (
                      <tr key={t.taskArn}>
                        {activeTaskCols.map(col => (
                          <td key={col.key}>
                            {col.key === 'taskId' ? taskId
                              : col.key === 'lastStatus' ? <span className={`ecs-badge ${t.lastStatus}`}>{t.lastStatus}</span>
                              : col.key === 'startedAt' ? fmtTs(t.startedAt)
                              : col.key === 'cpu' ? t.cpu
                              : col.key === 'memory' ? t.memory
                              : col.key === 'containers' ? (
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                  {t.containers.map(c => (
                                    <button
                                      key={c.name}
                                      type="button"
                                      className={`ecs-container-pill ${logContainer === c.name ? 'active' : ''}`}
                                      onClick={() => void loadLogs(c)}
                                    >
                                      {c.name}
                                    </button>
                                  ))}
                                </div>
                              ) : ''
                            }
                          </td>
                        ))}
                        <td>
                          <ConfirmButton
                            className="ecs-action-btn stop"
                            type="button"
                            disabled={busy}
                            confirmLabel="Confirm?"
                            onConfirm={() => void doStopTask(t.taskArn)}
                            style={{ padding: '3px 8px', fontSize: 11 }}
                          >Stop</ConfirmButton>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!filteredTasks.length && <div className="ecs-empty">No tasks running.</div>}
            </>
          )}
        </div>

        {/* ── Sidebar ─────────────────────────────── */}
        <div className="ecs-sidebar">
          <div className="ecs-side-tabs">
            <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>Overview</button>
            <button className={sideTab === 'events' ? 'active' : ''} type="button" onClick={() => setSideTab('events')}>Events</button>
          </div>

          {sideTab === 'overview' && (
            <>
              {/* Service details */}
              {detail && (
                <div className="ecs-sidebar-section">
                  <h3>Service Details</h3>
                  <KV items={[
                    ['Service', detail.serviceName],
                    ['Status', detail.status],
                    ['Task Def', detail.taskDefinition.split('/').pop() ?? detail.taskDefinition],
                    ['Running', `${detail.runningCount}/${detail.desiredCount}`],
                    ['Pending', String(detail.pendingCount)],
                    ['Launch Type', detail.launchType],
                    ['Platform', detail.platformVersion],
                    ['Network', detail.networkMode],
                    ['Public IP', detail.assignPublicIp],
                    ['Created', fmtTs(detail.createdAt)],
                  ]} />
                </div>
              )}

              {/* Actions */}
              {detail && (
                <div className="ecs-sidebar-section">
                  <h3>Service Actions</h3>
                  <div className="ecs-actions-grid">
                    <button className="ecs-action-btn redeploy" type="button" disabled={busy} onClick={() => void doRedeploy()}>Force Redeploy</button>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <div className="ecs-sidebar-hint">Scale desired count</div>
                    <div className="ecs-inline-form">
                      <input value={desiredCount} onChange={e => setDesiredCount(e.target.value)} style={{ width: 60, flex: 'none' }} />
                      <button className="ecs-action-btn apply" type="button" disabled={busy} onClick={() => void doScale()}>Apply</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Deployments */}
              {detail && detail.deployments.length > 0 && (
                <div className="ecs-sidebar-section">
                  <h3>Deployments</h3>
                  <table className="ecs-deploy-table">
                    <thead><tr><th>ID</th><th>State</th><th>Counts</th></tr></thead>
                    <tbody>
                      {detail.deployments.map(d => (
                        <tr key={d.id}>
                          <td title={d.taskDefinition}>{d.id.slice(0, 8)}</td>
                          <td><span className={`ecs-badge ${d.rolloutState}`}>{d.rolloutState}</span></td>
                          <td>{d.runningCount}/{d.desiredCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Container Logs */}
              <div className="ecs-sidebar-section">
                <h3>Container Logs {logContainer ? `(${logContainer})` : ''}</h3>
                {logs.length > 0 ? (
                  <div className="ecs-log-viewer">
                    {logs.map((item, i) => (
                      <div key={`${item.timestamp}-${i}`} className="ecs-log-line">
                        <span className="ecs-log-timestamp">{new Date(item.timestamp).toLocaleTimeString()}</span>
                        {item.message}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ecs-empty">Click a container pill in the Tasks table to view logs.</div>
                )}
              </div>

              {!detail && (
                <div className="ecs-sidebar-section">
                  <div className="ecs-empty">Select a service to view details.</div>
                </div>
              )}
            </>
          )}

          {sideTab === 'events' && (
            <div className="ecs-sidebar-section">
              <h3>Service Events</h3>
              {detail && detail.events.length > 0 ? (
                <div className="ecs-event-list">
                  {detail.events.map(ev => (
                    <div key={ev.id} className="ecs-event-item">
                      <span className="ecs-event-time">{fmtTs(ev.createdAt)}</span>
                      {ev.message}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ecs-empty">{detail ? 'No recent events.' : 'Select a service to view events.'}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
