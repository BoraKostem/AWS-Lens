import { useEffect, useMemo, useRef, useState } from 'react'
import './eks.css'

import type {
  AwsConnection,
  CloudTrailEventSummary,
  EksClusterDetail,
  EksClusterSummary,
  EksNodegroupSummary
} from '@shared/types'
import {
  addEksToKubeconfig,
  describeEksCluster,
  listEksClusters,
  listEksNodegroups,
  lookupCloudTrailEventsByResource,
  prepareEksKubectlSession,
  runEksCommand,
  updateEksNodegroupScaling
} from './api'

/* ── Column definitions ─────────────────────────────────── */

type ClusterCol = 'name' | 'status' | 'version'
const CLUSTER_COLUMNS: { key: ClusterCol; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'version', label: 'Version', color: '#8b5cf6' }
]

type NgCol = 'name' | 'status' | 'min' | 'desired' | 'max' | 'cpu7d' | 'mem7d' | 'recommendation' | 'instanceTypes'
const NG_COLUMNS: { key: NgCol; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'min', label: 'Min', color: '#f59e0b' },
  { key: 'desired', label: 'Desired', color: '#14b8a6' },
  { key: 'max', label: 'Max', color: '#ef4444' },
  { key: 'cpu7d', label: 'CPU7d', color: '#06b6d4' },
  { key: 'mem7d', label: 'Mem7d', color: '#8b5cf6' },
  { key: 'recommendation', label: 'Recommendation', color: '#a855f7' },
  { key: 'instanceTypes', label: 'InstanceTypes', color: '#ec4899' }
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

/* ── Status badge ───────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const cls =
    s === 'active' || s === 'running' || s === 'successful'
      ? 'eks-badge eks-badge-ok'
      : s === 'creating' || s === 'updating' || s === 'pending'
        ? 'eks-badge eks-badge-warn'
        : s.includes('delet') || s.includes('fail') || s.includes('degrad')
          ? 'eks-badge eks-badge-danger'
          : 'eks-badge'
  return <span className={cls}>{status}</span>
}

/* ── Main EKS Console ───────────────────────────────────── */

export function EksConsole({ connection }: { connection: AwsConnection }) {
  /* ── State ──────────────────────────────────────────── */
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  // Clusters
  const [clusters, setClusters] = useState<EksClusterSummary[]>([])
  const [selectedCluster, setSelectedCluster] = useState('')
  const [detail, setDetail] = useState<EksClusterDetail | null>(null)
  const [clusterSearch, setClusterSearch] = useState('')
  const [visibleClusterCols, setVisibleClusterCols] = useState<Set<ClusterCol>>(new Set(['name', 'status', 'version']))

  // Node groups
  const [nodegroups, setNodegroups] = useState<EksNodegroupSummary[]>([])
  const [ngSearch, setNgSearch] = useState('')
  const [visibleNgCols, setVisibleNgCols] = useState<Set<NgCol>>(new Set(['name', 'status', 'min', 'desired', 'max', 'cpu7d', 'mem7d', 'recommendation', 'instanceTypes']))
  const [selectedNg, setSelectedNg] = useState('')

  // Tabs
  const [sideTab, setSideTab] = useState<'overview' | 'timeline'>('overview')

  // Describe panel
  const [showDescribe, setShowDescribe] = useState(false)

  // Scale
  const [showScale, setShowScale] = useState(false)
  const [scaleMin, setScaleMin] = useState('')
  const [scaleDesired, setScaleDesired] = useState('')
  const [scaleMax, setScaleMax] = useState('')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleErr, setScaleErr] = useState('')

  // Timeline
  const [timelineEvents, setTimelineEvents] = useState<CloudTrailEventSummary[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [timelineStart, setTimelineStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => new Date().toISOString().slice(0, 10))

  // Terminal
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalCmd, setTerminalCmd] = useState('')
  const [terminalBusy, setTerminalBusy] = useState(false)
  const [terminalKubeconfigPath, setTerminalKubeconfigPath] = useState('')
  const terminalOutputRef = useRef<HTMLDivElement>(null)

  /* ── Derived ────────────────────────────────────────── */
  const activeClusterCols = CLUSTER_COLUMNS.filter(c => visibleClusterCols.has(c.key))
  const activeNgCols = NG_COLUMNS.filter(c => visibleNgCols.has(c.key))

  const filteredClusters = useMemo(() => {
    const q = clusterSearch.trim().toLowerCase()
    if (!q) return clusters
    return clusters.filter(c =>
      activeClusterCols.some(col => {
        const val = col.key === 'name' ? c.name : col.key === 'status' ? c.status : c.version
        return val.toLowerCase().includes(q)
      })
    )
  }, [clusters, clusterSearch, activeClusterCols])

  const filteredNodegroups = useMemo(() => {
    const q = ngSearch.trim().toLowerCase()
    if (!q) return nodegroups
    return nodegroups.filter(ng =>
      activeNgCols.some(col => getNgValue(ng, col.key).toLowerCase().includes(q))
    )
  }, [nodegroups, ngSearch, activeNgCols])

  /* ── Load clusters on mount ─────────────────────────── */
  async function reload() {
    setLoading(true)
    setError('')
    try {
      const list = await listEksClusters(connection)
      setClusters(list)
      if (list.length && !selectedCluster) {
        await selectCluster(list[0].name)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [connection.profile, connection.region])

  async function selectCluster(name: string) {
    setSelectedCluster(name)
    setError('')
    setMsg('')
    setTerminalOpen(false)
    setTerminalKubeconfigPath('')
    setShowDescribe(false)
    setShowScale(false)
    try {
      const [d, ngs] = await Promise.all([
        describeEksCluster(connection, name),
        listEksNodegroups(connection, name)
      ])
      setDetail(d)
      setNodegroups(ngs)
      if (ngs.length) setSelectedNg(ngs[0].name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Timeline ───────────────────────────────────────── */
  async function loadTimeline() {
    if (!selectedCluster) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const events = await lookupCloudTrailEventsByResource(
        connection, selectedCluster,
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
    if (sideTab === 'timeline' && selectedCluster) void loadTimeline()
  }, [sideTab, selectedCluster, timelineStart, timelineEnd])

  /* ── Actions ────────────────────────────────────────── */
  async function handleKubeconfig() {
    if (!selectedCluster) return
    setMsg('')
    setError('')
    try {
      const result = await addEksToKubeconfig(connection, selectedCluster)
      setMsg(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleScale() {
    if (!selectedCluster || !selectedNg) return
    const minN = Number(scaleMin)
    const desN = Number(scaleDesired)
    const maxN = Number(scaleMax)
    if (isNaN(minN) || isNaN(desN) || isNaN(maxN)) {
      setScaleErr('Values must be numbers')
      return
    }
    if (minN < 0 || desN < minN || desN > maxN) {
      setScaleErr('Must satisfy: 0 <= min <= desired <= max')
      return
    }
    setScaleErr('')
    setScaleBusy(true)
    try {
      await updateEksNodegroupScaling(connection, selectedCluster, selectedNg, minN, desN, maxN)
      setNodegroups(await listEksNodegroups(connection, selectedCluster))
      setShowScale(false)
      setMsg(`Scaled ${selectedNg} successfully`)
    } catch (e) {
      setScaleErr(e instanceof Error ? e.message : String(e))
    } finally {
      setScaleBusy(false)
    }
  }

  /* ── Terminal ───────────────────────────────────────── */
  async function openTerminal() {
    if (!selectedCluster || terminalBusy) return

    setTerminalOpen(true)
    setTerminalBusy(true)
    setError('')
    setMsg('')
    setTerminalCmd('')
    setTerminalKubeconfigPath('')
    setTerminalOutput(
      `kubectl terminal for cluster: ${selectedCluster}\nAWS_PROFILE=${connection.profile} AWS_DEFAULT_REGION=${connection.region}\n\nPreparing kubeconfig for ${selectedCluster}...\n`
    )

    try {
      const result = await prepareEksKubectlSession(connection, selectedCluster)
      setTerminalKubeconfigPath(result.path)
      setTerminalOutput(
        `kubectl terminal for cluster: ${selectedCluster}\nAWS_PROFILE=${connection.profile} AWS_DEFAULT_REGION=${connection.region}\nKUBECONFIG=${result.path}\n\n${result.output}\n\n`
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setTerminalOutput(
        `kubectl terminal for cluster: ${selectedCluster}\nAWS_PROFILE=${connection.profile} AWS_DEFAULT_REGION=${connection.region}\n\nError preparing kubeconfig: ${message}\n`
      )
      setError(message)
    } finally {
      setTerminalBusy(false)
    }
  }

  async function runTerminalCommand() {
    if (!terminalCmd.trim() || terminalBusy) return
    const cmd = terminalCmd.trim()
    setTerminalCmd('')
    setTerminalBusy(true)
    setTerminalOutput(prev => prev + `$ ${cmd}\n`)

    try {
      const output = await runEksCommand(connection, selectedCluster, terminalKubeconfigPath, cmd)
      setTerminalOutput(prev => prev + output + '\n')
    } catch (e) {
      setTerminalOutput(prev => prev + `Error: ${e instanceof Error ? e.message : String(e)}\n`)
    } finally {
      setTerminalBusy(false)
      setTimeout(() => {
        if (terminalOutputRef.current) {
          terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight
        }
      }, 50)
    }
  }

  /* ── Scale form pre-fill ────────────────────────────── */
  function openScaleForm() {
    const ng = nodegroups.find(n => n.name === selectedNg)
    if (ng) {
      setScaleMin(String(ng.min))
      setScaleDesired(String(ng.desired))
      setScaleMax(String(ng.max))
    }
    setScaleErr('')
    setShowScale(true)
  }

  /* ── Column toggle helpers ──────────────────────────── */
  function toggleClusterCol(key: ClusterCol) {
    setVisibleClusterCols(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleNgCol(key: NgCol) {
    setVisibleNgCols(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  if (loading && !clusters.length) return <div className="eks-empty">Loading EKS clusters...</div>

  return (
    <div className="eks-console">
      {error && <div className="error-banner" style={{ margin: '8px' }}>{error}</div>}
      {msg && <div className="eks-msg">{msg}</div>}

      <div className="eks-main-layout">
        {/* ── Left: cluster list ──────────────────────── */}
        <div className="eks-list-panel">
          <input
            className="eks-search-input"
            placeholder="Filter rows across selected columns..."
            value={clusterSearch}
            onChange={e => setClusterSearch(e.target.value)}
          />

          <div className="eks-column-chips">
            {CLUSTER_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`eks-chip ${visibleClusterCols.has(col.key) ? 'active' : ''}`}
                type="button"
                style={visibleClusterCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                onClick={() => toggleClusterCol(col.key)}
              >
                {col.label}
              </button>
            ))}
          </div>

          <div className="eks-list-scroll">
            <table className="eks-list-table">
              <thead>
                <tr>
                  {activeClusterCols.map(col => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredClusters.map(c => (
                  <tr
                    key={c.name}
                    className={c.name === selectedCluster ? 'active' : ''}
                    onClick={() => void selectCluster(c.name)}
                  >
                    {activeClusterCols.map(col => (
                      <td key={col.key}>
                        {col.key === 'status' ? <StatusBadge status={c.status} /> :
                         col.key === 'name' ? c.name : c.version}
                      </td>
                    ))}
                  </tr>
                ))}
                {!filteredClusters.length && (
                  <tr><td colSpan={activeClusterCols.length} style={{ color: '#9ca7b7' }}>No clusters found.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Describe panel */}
          {showDescribe && detail && (
            <div className="eks-describe-panel">
              <h4>Cluster: {detail.name}</h4>
              <div className="eks-describe-grid">
                <div className="eks-kv"><span>Status</span><strong>{detail.status}</strong></div>
                <div className="eks-kv"><span>Version</span><strong>{detail.version}</strong></div>
                <div className="eks-kv"><span>Platform</span><strong>{detail.platformVersion}</strong></div>
                <div className="eks-kv"><span>Created</span><strong>{detail.createdAt !== '-' ? new Date(detail.createdAt).toLocaleString() : '-'}</strong></div>
                <div className="eks-kv"><span>VPC</span><strong>{detail.vpcId}</strong></div>
                <div className="eks-kv"><span>Role ARN</span><strong style={{ fontSize: '10px' }}>{detail.roleArn}</strong></div>
                <div className="eks-kv"><span>Public Endpoint</span><strong>{detail.endpointPublicAccess ? 'Yes' : 'No'}</strong></div>
                <div className="eks-kv"><span>Private Endpoint</span><strong>{detail.endpointPrivateAccess ? 'Yes' : 'No'}</strong></div>
                <div className="eks-kv"><span>Service CIDR</span><strong>{detail.serviceIpv4Cidr}</strong></div>
                <div className="eks-kv"><span>OIDC Issuer</span><strong style={{ fontSize: '10px' }}>{detail.oidcIssuer}</strong></div>
                <div className="eks-kv"><span>Subnets</span><strong style={{ fontSize: '10px' }}>{detail.subnetIds.join(', ') || '-'}</strong></div>
                <div className="eks-kv"><span>Logging</span><strong>{detail.loggingEnabled.length ? detail.loggingEnabled.join(', ') : 'None'}</strong></div>
              </div>
            </div>
          )}

          <div className="eks-cluster-actions">
            <button type="button" onClick={() => setShowDescribe(!showDescribe)} disabled={!selectedCluster}>
              Describe
            </button>
            <button type="button" className="accent" onClick={() => void handleKubeconfig()} disabled={!selectedCluster}>
              Add to kubeconfig
            </button>
          </div>
        </div>

        {/* ── Right: detail panel ─────────────────────── */}
        <div className="eks-detail-panel">
          <div className="eks-side-tabs">
            <button
              type="button"
              className={sideTab === 'overview' ? 'active' : ''}
              onClick={() => setSideTab('overview')}
            >Overview</button>
            <button
              type="button"
              className={sideTab === 'timeline' ? 'active' : ''}
              onClick={() => setSideTab('timeline')}
            >Change Timeline</button>
          </div>

          <div className="eks-detail-content">
            {/* ── Overview tab: nodegroup table ──────── */}
            {sideTab === 'overview' && (
              <div className="eks-ng-table-area">
                <input
                  className="eks-search-input"
                  placeholder="Filter rows across selected columns..."
                  value={ngSearch}
                  onChange={e => setNgSearch(e.target.value)}
                />

                <div className="eks-column-chips">
                  {NG_COLUMNS.map(col => (
                    <button
                      key={col.key}
                      className={`eks-chip ${visibleNgCols.has(col.key) ? 'active' : ''}`}
                      type="button"
                      style={visibleNgCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                      onClick={() => toggleNgCol(col.key)}
                    >
                      {col.label}
                    </button>
                  ))}
                </div>

                <div className="eks-ng-scroll">
                  <table className="eks-data-table">
                    <thead>
                      <tr>
                        {activeNgCols.map(col => (
                          <th key={col.key}>{col.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredNodegroups.map(ng => (
                        <tr
                          key={ng.name}
                          className={ng.name === selectedNg ? 'active' : ''}
                          onClick={() => setSelectedNg(ng.name)}
                        >
                          {activeNgCols.map(col => (
                            <td key={col.key}>
                              {col.key === 'status' ? <StatusBadge status={ng.status} /> : getNgValue(ng, col.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {!selectedCluster && (
                        <tr><td colSpan={activeNgCols.length} style={{ color: '#9ca7b7' }}>Select a cluster.</td></tr>
                      )}
                      {selectedCluster && !filteredNodegroups.length && (
                        <tr><td colSpan={activeNgCols.length} style={{ color: '#9ca7b7' }}>No node groups found.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Scale modal */}
                {showScale && (
                  <div className="eks-scale-modal">
                    <h4>Scale Nodegroup: {selectedNg}</h4>
                    <div className="eks-scale-form">
                      <label>
                        Nodegroup
                        <select value={selectedNg} onChange={e => {
                          setSelectedNg(e.target.value)
                          const ng = nodegroups.find(n => n.name === e.target.value)
                          if (ng) { setScaleMin(String(ng.min)); setScaleDesired(String(ng.desired)); setScaleMax(String(ng.max)) }
                        }}>
                          {nodegroups.map(ng => (
                            <option key={ng.name} value={ng.name}>{ng.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>Min<input type="number" value={scaleMin} onChange={e => setScaleMin(e.target.value)} /></label>
                      <label>Desired<input type="number" value={scaleDesired} onChange={e => setScaleDesired(e.target.value)} /></label>
                      <label>Max<input type="number" value={scaleMax} onChange={e => setScaleMax(e.target.value)} /></label>
                      <button type="button" className="eks-scale-apply" disabled={scaleBusy} onClick={() => void handleScale()}>
                        {scaleBusy ? 'Applying...' : 'Apply'}
                      </button>
                    </div>
                    {scaleErr && <div className="eks-scale-err">{scaleErr}</div>}
                  </div>
                )}
              </div>
            )}

            {/* ── Change Timeline tab ───────────────── */}
            {sideTab === 'timeline' && (
              <div className="eks-ng-table-area">
                <div className="eks-timeline-controls">
                  <label>
                    From
                    <input type="date" value={timelineStart} onChange={e => setTimelineStart(e.target.value)} />
                  </label>
                  <label>
                    To
                    <input type="date" value={timelineEnd} onChange={e => setTimelineEnd(e.target.value)} />
                  </label>
                </div>
                {!selectedCluster && <div className="eks-empty">Select a cluster to view events.</div>}
                {selectedCluster && timelineLoading && <div className="eks-empty">Loading events...</div>}
                {selectedCluster && !timelineLoading && timelineError && (
                  <div className="eks-empty" style={{ color: '#f87171' }}>{timelineError}</div>
                )}
                {selectedCluster && !timelineLoading && !timelineError && timelineEvents.length === 0 && (
                  <div className="eks-empty">No CloudTrail events found.</div>
                )}
                {selectedCluster && !timelineLoading && timelineEvents.length > 0 && (
                  <div className="eks-timeline-table-wrap">
                    <table className="eks-timeline-table">
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

          {/* ── Operations bar ──────────────────────── */}
          <div className="eks-operations-bar">
            <h4>Cluster Operations</h4>
            <div className="eks-operations-buttons">
              <button
                type="button"
                className="eks-btn-scale"
                disabled={!selectedCluster || !nodegroups.length}
                onClick={openScaleForm}
              >
                Scale Nodegroup
              </button>
              <button
                type="button"
                className="eks-btn-terminal"
                disabled={!selectedCluster}
                onClick={openTerminal}
              >
                Open kubectl Terminal
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Embedded terminal ──────────────────────────── */}
      {terminalOpen && (
        <div className="eks-terminal-panel">
          <div className="eks-terminal-header">
            <span>kubectl Terminal - {selectedCluster}</span>
            <button type="button" onClick={() => { setTerminalOpen(false); setTerminalKubeconfigPath('') }}>Close</button>
          </div>
          <div className="eks-terminal-output" ref={terminalOutputRef}>
            {terminalOutput}
          </div>
          <div className="eks-terminal-input-row">
            <span className="eks-terminal-prompt">$</span>
            <input
              value={terminalCmd}
              onChange={e => setTerminalCmd(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void runTerminalCommand() }}
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
