import { useEffect, useMemo, useState } from 'react'

import type {
  AwsConnection,
  Ec2InstanceSummary,
  LoadBalancerTimelineEvent,
  LoadBalancerWorkspace
} from '@shared/types'
import { deleteLoadBalancer, listEc2Instances, listLoadBalancerWorkspaces } from './workspaceApi'
import { ConfirmButton } from './ConfirmButton'

/* ── Column definitions ───────────────────────────────────── */

type ColKey = 'name' | 'type' | 'scheme' | 'state' | 'dnsName' | 'listeners' | 'targets'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'type', label: 'Type', color: '#14b8a6' },
  { key: 'scheme', label: 'Scheme', color: '#8b5cf6' },
  { key: 'state', label: 'State', color: '#22c55e' },
  { key: 'dnsName', label: 'DNS', color: '#f59e0b' },
  { key: 'listeners', label: 'Listeners', color: '#06b6d4' },
  { key: 'targets', label: 'Targets', color: '#a855f7' },
]

function getColVal(ws: LoadBalancerWorkspace, key: ColKey): string {
  switch (key) {
    case 'name': return ws.summary.name
    case 'type': return ws.summary.type
    case 'scheme': return ws.summary.scheme
    case 'state': return ws.summary.state
    case 'dnsName': return ws.summary.dnsName
    case 'listeners': return String(ws.listeners.length)
    case 'targets': return String(ws.targetGroups.length)
  }
}

function fmt(value: string) { return value ? new Date(value).toLocaleString() : '-' }

type SideTab = 'details' | 'targets' | 'rules' | 'timeline'

/* ── Main Console ─────────────────────────────────────────── */

export function WorkspaceApp({
  connection,
  focusLoadBalancer
}: {
  connection: AwsConnection
  focusLoadBalancer?: { token: number; loadBalancerArn: string } | null
}) {
  const [workspaces, setWorkspaces] = useState<LoadBalancerWorkspace[]>([])
  const [instances, setInstances] = useState<Ec2InstanceSummary[]>([])
  const [selectedArn, setSelectedArn] = useState('')
  const [selectedListenerArn, setSelectedListenerArn] = useState('')
  const [selectedGroupArn, setSelectedGroupArn] = useState('')
  const [selectedTargetId, setSelectedTargetId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))
  const [sideTab, setSideTab] = useState<SideTab>('details')
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)

  const selected = useMemo(() => workspaces.find(w => w.summary.arn === selectedArn) ?? null, [workspaces, selectedArn])
  const selectedListener = useMemo(() => selected?.listeners.find(l => l.arn === selectedListenerArn) ?? null, [selected, selectedListenerArn])
  const selectedRules = useMemo(() => selectedListener ? selected?.rulesByListener[selectedListener.arn] ?? [] : [], [selected, selectedListener])
  const selectedGroup = useMemo(() => selected?.targetGroups.find(g => g.arn === selectedGroupArn) ?? null, [selected, selectedGroupArn])
  const selectedTargets = useMemo(() => selectedGroup ? selected?.targetsByGroup[selectedGroup.arn] ?? [] : [], [selected, selectedGroup])
  const selectedTarget = useMemo(() => selectedTargets.find(t => t.id === selectedTargetId) ?? null, [selectedTargets, selectedTargetId])
  const relatedInstance = useMemo(() => instances.find(i => i.instanceId === selectedTargetId) ?? null, [instances, selectedTargetId])

  function pickDefaults(next: LoadBalancerWorkspace[]) {
    const first = next[0]
    setSelectedArn(first?.summary.arn ?? '')
    setSelectedListenerArn(first?.listeners[0]?.arn ?? '')
    setSelectedGroupArn(first?.targetGroups[0]?.arn ?? '')
    setSelectedTargetId(first?.targetGroups[0] ? first.targetsByGroup[first.targetGroups[0].arn]?.[0]?.id ?? '' : '')
  }

  async function load() {
    setLoading(true); setError('')
    try {
      const [lbs, ec2] = await Promise.all([listLoadBalancerWorkspaces(connection), listEc2Instances(connection)])
      setWorkspaces(lbs); setInstances(ec2); pickDefaults(lbs)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (!focusLoadBalancer || focusLoadBalancer.token === appliedFocusToken) {
      return
    }

    const match = workspaces.find((workspace) => workspace.summary.arn === focusLoadBalancer.loadBalancerArn)
    if (!match) {
      return
    }

    setAppliedFocusToken(focusLoadBalancer.token)
    setSideTab('details')
    selectLB(match.summary.arn)
  }, [appliedFocusToken, focusLoadBalancer, workspaces])

  function selectLB(arn: string) {
    const ws = workspaces.find(w => w.summary.arn === arn)
    if (!ws) return
    setSelectedArn(arn)
    setSelectedListenerArn(ws.listeners[0]?.arn ?? '')
    setSelectedGroupArn(ws.targetGroups[0]?.arn ?? '')
    setSelectedTargetId(ws.targetGroups[0] ? ws.targetsByGroup[ws.targetGroups[0].arn]?.[0]?.id ?? '' : '')
  }

  async function doDelete() {
    if (!selectedArn) return
    try {
      await deleteLoadBalancer(connection, selectedArn)
      setMsg('Load balancer deleted')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))

  const filteredWorkspaces = useMemo(() => {
    if (!filter) return workspaces
    const q = filter.toLowerCase()
    return workspaces.filter(ws => activeCols.some(c => getColVal(ws, c.key).toLowerCase().includes(q)))
  }, [workspaces, filter, activeCols])

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Load Balancers</button>
        <button className="svc-tab right" type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* Stats */}
      {selected && (
        <div className="svc-stat-strip">
          <div className="svc-stat-card"><span>Listeners</span><strong>{selected.listeners.length}</strong></div>
          <div className="svc-stat-card"><span>Rules</span><strong>{Object.values(selected.rulesByListener).flat().length}</strong></div>
          <div className="svc-stat-card"><span>Target Groups</span><strong>{selected.targetGroups.length}</strong></div>
          <div className="svc-stat-card"><span>Targets</span><strong>{Object.values(selected.targetsByGroup).flat().length}</strong></div>
          <div className="svc-stat-card"><span>Created</span><strong style={{ fontSize: 12 }}>{fmt(selected.summary.createdTime)}</strong></div>
        </div>
      )}

      <input className="svc-search" placeholder="Filter rows across selected columns..." value={filter} onChange={e => setFilter(e.target.value)} />

      <div className="svc-chips">
        {COLUMNS.map(col => (
          <button
            key={col.key}
            className={`svc-chip ${visCols.has(col.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
            onClick={() => setVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
          >{col.label}</button>
        ))}
      </div>

      <div className="svc-layout">
        {/* ── Table ────────────────────────────────────────── */}
        <div className="svc-table-area">
          <table className="svc-table">
            <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length}>Gathering data</td></tr>}
              {!loading && filteredWorkspaces.map(ws => (
                <tr key={ws.summary.arn} className={ws.summary.arn === selectedArn ? 'active' : ''} onClick={() => selectLB(ws.summary.arn)}>
                  {activeCols.map(c => (
                    <td key={c.key}>
                      {c.key === 'state'
                        ? <span className={`svc-badge ${ws.summary.state === 'active' ? 'ok' : ws.summary.state === 'provisioning' ? 'warn' : 'muted'}`}>{ws.summary.state}</span>
                        : getColVal(ws, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredWorkspaces.length && !loading && <div className="svc-empty">No load balancers found.</div>}
        </div>

        {/* ── Sidebar ─────────────────────────────────────── */}
        <div className="svc-sidebar">
          <div className="svc-side-tabs">
            <button className={sideTab === 'details' ? 'active' : ''} type="button" onClick={() => setSideTab('details')}>Details</button>
            <button className={sideTab === 'targets' ? 'active' : ''} type="button" onClick={() => setSideTab('targets')}>Targets</button>
            <button className={sideTab === 'rules' ? 'active' : ''} type="button" onClick={() => setSideTab('rules')}>Rules</button>
            <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>Timeline</button>
          </div>

          {/* ── Details tab ─────────────────────────────────── */}
          {sideTab === 'details' && (
            <>
              <div className="svc-section">
                <h3>Actions</h3>
                <div className="svc-btn-row">
                  <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete()}>Delete LB</ConfirmButton>
                </div>
              </div>

              {selected && (
                <div className="svc-section">
                  <h3>Load Balancer</h3>
                  <div className="svc-kv">
                    <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{selected.summary.name}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Type</div><div className="svc-kv-value">{selected.summary.type}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Scheme</div><div className="svc-kv-value">{selected.summary.scheme}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">State</div><div className="svc-kv-value">{selected.summary.state}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">DNS</div><div className="svc-kv-value">{selected.summary.dnsName}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">VPC</div><div className="svc-kv-value">{selected.summary.vpcId}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">AZs</div><div className="svc-kv-value">{selected.summary.availabilityZones.join(', ') || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Security Groups</div><div className="svc-kv-value">{selected.summary.securityGroups.join(', ') || '-'}</div></div>
                  </div>
                </div>
              )}

              {selected && (
                <div className="svc-section">
                  <h3>Listeners</h3>
                  <div className="svc-list">
                    {selected.listeners.map(l => (
                      <button key={l.arn} type="button" className={`svc-list-item ${l.arn === selectedListenerArn ? 'active' : ''}`} onClick={() => setSelectedListenerArn(l.arn)}>
                        <div className="svc-list-title">{l.protocol}:{l.port}</div>
                        <div className="svc-list-meta">{l.sslPolicy || 'No TLS'}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selected && (
                <div className="svc-section">
                  <h3>Target Groups</h3>
                  <div className="svc-list">
                    {selected.targetGroups.map(g => (
                      <button key={g.arn} type="button" className={`svc-list-item ${g.arn === selectedGroupArn ? 'active' : ''}`} onClick={() => { setSelectedGroupArn(g.arn); setSelectedTargetId(selected.targetsByGroup[g.arn]?.[0]?.id ?? '') }}>
                        <div className="svc-list-title">{g.name}</div>
                        <div className="svc-list-meta">{g.protocol}:{g.port} | {g.targetType}</div>
                      </button>
                    ))}
                  </div>
                  {selectedGroup && (
                    <div className="svc-kv" style={{ marginTop: 10 }}>
                      <div className="svc-kv-row"><div className="svc-kv-label">Health Check</div><div className="svc-kv-value">{selectedGroup.healthCheck.protocol}:{selectedGroup.healthCheck.port}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">Path</div><div className="svc-kv-value">{selectedGroup.healthCheck.path || '-'}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">Matcher</div><div className="svc-kv-value">{selectedGroup.healthCheck.matcher || '-'}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">Thresholds</div><div className="svc-kv-value">{selectedGroup.healthCheck.healthyThreshold}/{selectedGroup.healthCheck.unhealthyThreshold}</div></div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Targets tab ────────────────────────────────── */}
          {sideTab === 'targets' && (
            <div className="svc-section">
              <h3>Targets — {selectedGroup?.name ?? 'Select a group'}</h3>
              <table className="svc-table">
                <thead><tr><th>Target</th><th>Port</th><th>State</th><th>Reason</th></tr></thead>
                <tbody>
                  {selectedTargets.map(t => (
                    <tr key={`${t.id}:${t.port}`} className={t.id === selectedTargetId ? 'active' : ''} onClick={() => setSelectedTargetId(t.id)}>
                      <td>{t.id}</td>
                      <td>{t.port ?? '-'}</td>
                      <td><span className={`svc-badge ${t.state === 'healthy' ? 'ok' : t.state === 'unhealthy' ? 'danger' : t.state === 'draining' ? 'warn' : 'muted'}`}>{t.state}</span></td>
                      <td style={{ fontSize: 11, color: '#9ca7b7' }}>{t.reason || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!selectedTargets.length && <div className="svc-empty">No targets in this group.</div>}

              {selectedTarget && relatedInstance && (
                <div style={{ marginTop: 12 }}>
                  <h3 style={{ fontSize: 12, margin: '0 0 6px', color: '#9ca7b7' }}>EC2 Instance</h3>
                  <div className="svc-kv">
                    <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{relatedInstance.name || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Instance</div><div className="svc-kv-value">{relatedInstance.instanceId}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">State</div><div className="svc-kv-value">{relatedInstance.state}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Type</div><div className="svc-kv-value">{relatedInstance.type}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Private IP</div><div className="svc-kv-value">{relatedInstance.privateIp || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Public IP</div><div className="svc-kv-value">{relatedInstance.publicIp || '-'}</div></div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Rules tab ──────────────────────────────────── */}
          {sideTab === 'rules' && (
            <div className="svc-section">
              <h3>Rules — {selectedListener ? `${selectedListener.protocol}:${selectedListener.port}` : 'Select a listener'}</h3>
              <table className="svc-table">
                <thead><tr><th>Priority</th><th>Conditions</th><th>Actions</th></tr></thead>
                <tbody>
                  {selectedRules.map(r => (
                    <tr key={r.arn}>
                      <td>{r.isDefault ? 'default' : r.priority}</td>
                      <td style={{ fontSize: 11 }}>{r.conditions.join(', ') || '-'}</td>
                      <td style={{ fontSize: 11 }}>{r.actions.join(', ') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!selectedRules.length && <div className="svc-empty">Select a listener from the Details tab.</div>}
            </div>
          )}

          {/* ── Timeline tab ───────────────────────────────── */}
          {sideTab === 'timeline' && selected && (
            <div className="svc-section">
              <h3>Timeline ({selected.timeline.length})</h3>
              {selected.timeline.length > 0 ? (
                <div style={{ maxHeight: 'calc(100vh - 400px)', overflow: 'auto' }}>
                  {selected.timeline.map((ev: LoadBalancerTimelineEvent) => (
                    <div key={ev.id} style={{ padding: '8px 0', borderBottom: '1px solid #3b4350', fontSize: 12 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                        <span className={`svc-badge ${ev.severity === 'error' ? 'danger' : ev.severity === 'warning' ? 'warn' : 'muted'}`}>{ev.severity}</span>
                        <span style={{ color: '#9ca7b7' }}>{fmt(ev.timestamp)}</span>
                      </div>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{ev.title}</div>
                      <div style={{ color: '#9ca7b7', fontSize: 11 }}>{ev.detail}</div>
                    </div>
                  ))}
                </div>
              ) : <div className="svc-empty">No timeline events.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
