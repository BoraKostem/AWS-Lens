import { useEffect, useMemo, useState } from 'react'

import type {
  AwsConnection,
  Ec2InstanceSummary,
  LoadBalancerTimelineEvent,
  LoadBalancerWorkspace
} from '@shared/types'
import { ConfirmButton } from './ConfirmButton'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import './load-balancers.css'
import { deleteLoadBalancer, listEc2Instances, listLoadBalancerWorkspaces } from './workspaceApi'

type ColKey = 'name' | 'type' | 'scheme' | 'state' | 'dnsName' | 'listeners' | 'targets'
type SideTab = 'details' | 'targets' | 'rules' | 'timeline'

const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'scheme', label: 'Scheme' },
  { key: 'state', label: 'State' },
  { key: 'dnsName', label: 'DNS' },
  { key: 'listeners', label: 'Listeners' },
  { key: 'targets', label: 'Targets' }
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

function fmt(value: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

function toneForState(state: string): 'ok' | 'warn' | 'danger' | 'muted' {
  const normalized = state.toLowerCase()
  if (normalized === 'active' || normalized === 'healthy') return 'ok'
  if (normalized === 'provisioning' || normalized === 'draining' || normalized === 'initial') return 'warn'
  if (normalized === 'unhealthy' || normalized === 'failed' || normalized === 'error') return 'danger'
  return 'muted'
}

function severityTone(severity: LoadBalancerTimelineEvent['severity']): 'muted' | 'warn' | 'danger' {
  if (severity === 'error') return 'danger'
  if (severity === 'warning') return 'warn'
  return 'muted'
}

function countRules(workspace: LoadBalancerWorkspace | null): number {
  if (!workspace) return 0
  return Object.values(workspace.rulesByListener).flat().length
}

function countTargets(workspace: LoadBalancerWorkspace | null): number {
  if (!workspace) return 0
  return Object.values(workspace.targetsByGroup).flat().length
}

export function WorkspaceApp({
  connection,
  refreshNonce = 0,
  focusLoadBalancer
}: {
  connection: AwsConnection
  refreshNonce?: number
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
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))
  const [sideTab, setSideTab] = useState<SideTab>('details')
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState({ staleAfterMs: 5 * 60 * 1000 })

  const selected = useMemo(() => workspaces.find((workspace) => workspace.summary.arn === selectedArn) ?? null, [workspaces, selectedArn])
  const selectedListener = useMemo(() => selected?.listeners.find((listener) => listener.arn === selectedListenerArn) ?? null, [selected, selectedListenerArn])
  const selectedRules = useMemo(() => (selectedListener ? selected?.rulesByListener[selectedListener.arn] ?? [] : []), [selected, selectedListener])
  const selectedGroup = useMemo(() => selected?.targetGroups.find((group) => group.arn === selectedGroupArn) ?? null, [selected, selectedGroupArn])
  const selectedTargets = useMemo(() => (selectedGroup ? selected?.targetsByGroup[selectedGroup.arn] ?? [] : []), [selected, selectedGroup])
  const selectedTarget = useMemo(() => selectedTargets.find((target) => target.id === selectedTargetId) ?? null, [selectedTargets, selectedTargetId])
  const relatedInstance = useMemo(() => instances.find((instance) => instance.instanceId === selectedTargetId) ?? null, [instances, selectedTargetId])
  const activeCols = useMemo(() => COLUMNS.filter((column) => visCols.has(column.key)), [visCols])
  const filteredWorkspaces = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return workspaces
    return workspaces.filter((workspace) => activeCols.some((column) => getColVal(workspace, column.key).toLowerCase().includes(query)))
  }, [activeCols, filter, workspaces])

  const totalRules = useMemo(() => workspaces.reduce((total, workspace) => total + countRules(workspace), 0), [workspaces])
  const totalTargets = useMemo(() => workspaces.reduce((total, workspace) => total + countTargets(workspace), 0), [workspaces])
  const activeCount = useMemo(() => workspaces.filter((workspace) => workspace.summary.state.toLowerCase() === 'active').length, [workspaces])
  const internetFacingCount = useMemo(() => workspaces.filter((workspace) => workspace.summary.scheme.toLowerCase().includes('internet')).length, [workspaces])

  function pickDefaults(next: LoadBalancerWorkspace[]) {
    const selectedWorkspace = next.find((workspace) => workspace.summary.arn === selectedArn) ?? next[0]
    const nextSelectedArn = selectedWorkspace?.summary.arn ?? ''
    const nextSelectedListener = selectedWorkspace?.listeners.find((listener) => listener.arn === selectedListenerArn) ?? selectedWorkspace?.listeners[0]
    const nextSelectedGroup = selectedWorkspace?.targetGroups.find((group) => group.arn === selectedGroupArn) ?? selectedWorkspace?.targetGroups[0]
    const nextSelectedTarget = nextSelectedGroup
      ? selectedWorkspace?.targetsByGroup[nextSelectedGroup.arn]?.find((target) => target.id === selectedTargetId) ?? selectedWorkspace?.targetsByGroup[nextSelectedGroup.arn]?.[0]
      : null

    setSelectedArn(nextSelectedArn)
    setSelectedListenerArn(nextSelectedListener?.arn ?? '')
    setSelectedGroupArn(nextSelectedGroup?.arn ?? '')
    setSelectedTargetId(nextSelectedTarget?.id ?? '')
  }

  async function load(reason: 'initial' | 'manual' | 'background' = 'manual') {
    beginRefresh(reason)
    setLoading(true)
    setError('')
    try {
      const [loadBalancers, ec2Instances] = await Promise.all([listLoadBalancerWorkspaces(connection), listEc2Instances(connection)])
      setWorkspaces(loadBalancers)
      setInstances(ec2Instances)
      pickDefaults(loadBalancers)
      completeRefresh()
    } catch (loadError) {
      failRefresh()
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('initial')
  }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (refreshNonce !== 0) {
      void load('manual')
    }
  }, [refreshNonce])

  useEffect(() => {
    if (!focusLoadBalancer || focusLoadBalancer.token === appliedFocusToken) return
    const match = workspaces.find((workspace) => workspace.summary.arn === focusLoadBalancer.loadBalancerArn)
    if (!match) return
    setAppliedFocusToken(focusLoadBalancer.token)
    setSideTab('details')
    selectLB(match.summary.arn)
  }, [appliedFocusToken, focusLoadBalancer, workspaces])

  function selectLB(arn: string) {
    const workspace = workspaces.find((item) => item.summary.arn === arn)
    if (!workspace) return
    setSelectedArn(arn)
    setSelectedListenerArn(workspace.listeners[0]?.arn ?? '')
    setSelectedGroupArn(workspace.targetGroups[0]?.arn ?? '')
    setSelectedTargetId(workspace.targetGroups[0] ? workspace.targetsByGroup[workspace.targetGroups[0].arn]?.[0]?.id ?? '' : '')
  }

  async function doDelete() {
    if (!selectedArn) return
    try {
      await deleteLoadBalancer(connection, selectedArn)
      setMsg('Load balancer deleted')
      await load('manual')
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  function toggleColumn(key: ColKey) {
    setVisCols((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="lbw-console">
      <section className="lbw-hero">
        <div className="lbw-hero-copy">
          <div className="eyebrow">Load Balancer Service</div>
          <h2>ALB and NLB workspace with listener, target, and health posture in one surface.</h2>
          <p>Filter the fleet, inspect the selected load balancer, and keep delete and refresh workflows exactly as before.</p>
          <div className="lbw-meta-strip">
            <div className="lbw-meta-pill"><span>Region</span><strong>{connection.region}</strong></div>
            <div className="lbw-meta-pill"><span>Selection</span><strong>{selected?.summary.name ?? 'No load balancer selected'}</strong></div>
            <div className="lbw-meta-pill"><span>Scheme</span><strong>{selected?.summary.scheme ?? 'Mixed'}</strong></div>
            <div className="lbw-meta-pill"><span>Status</span><strong>{selected?.summary.state ?? (loading ? 'Loading' : 'Inventory ready')}</strong></div>
          </div>
        </div>
        <div className="lbw-hero-stats">
          <div className="lbw-stat-card lbw-stat-card-accent"><span>Load Balancers</span><strong>{workspaces.length}</strong><small>{activeCount} active in the current region</small></div>
          <div className="lbw-stat-card"><span>Listeners</span><strong>{selected?.listeners.length ?? 0}</strong><small>{selected ? 'Bound to the selected edge' : 'Select a row to inspect'}</small></div>
          <div className="lbw-stat-card"><span>Rules</span><strong>{selected ? countRules(selected) : totalRules}</strong><small>{selected ? 'Listener routing entries' : 'Across all load balancers'}</small></div>
          <div className="lbw-stat-card"><span>Targets</span><strong>{selected ? countTargets(selected) : totalTargets}</strong><small>{internetFacingCount} internet-facing balancers</small></div>
        </div>
      </section>

      <section className="lbw-toolbar">
        <div className="lbw-toolbar-main">
          <label className="lbw-search-field">
            <span>Inventory Filter</span>
            <input className="lbw-search" placeholder="Search the visible inventory columns" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <div className="lbw-column-pills">
            {COLUMNS.map((column) => (
              <button key={column.key} type="button" className={`lbw-column-pill ${visCols.has(column.key) ? 'active' : ''}`} onClick={() => toggleColumn(column.key)}>
                {column.label}
              </button>
            ))}
          </div>
        </div>
        <div className="lbw-toolbar-side">
          <FreshnessIndicator freshness={freshness} label="Workspace last updated" />
          <button type="button" className="tf-toolbar-btn accent" onClick={() => void load('manual')} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh Inventory'}
          </button>
        </div>
      </section>

      {msg && <div className="tf-msg">{msg}</div>}
      {error && <div className="tf-msg error">{error}</div>}

      <div className="lbw-main-layout">
        <section className="lbw-inventory-pane">
          <div className="lbw-pane-head">
            <div><span className="lbw-pane-kicker">Tracked edges</span><h3>Load balancer inventory</h3></div>
            <span className="lbw-pane-summary">{filteredWorkspaces.length} visible</span>
          </div>
          {loading && workspaces.length === 0 ? (
            <div className="svc-empty">Gathering data</div>
          ) : filteredWorkspaces.length === 0 ? (
            <div className="svc-empty">No load balancers found.</div>
          ) : (
            <div className="lbw-inventory-list">
              {filteredWorkspaces.map((workspace) => {
                const isActive = workspace.summary.arn === selectedArn
                return (
                  <button key={workspace.summary.arn} type="button" className={`lbw-inventory-card ${isActive ? 'active' : ''}`} onClick={() => selectLB(workspace.summary.arn)}>
                    <div className="lbw-inventory-head">
                      <div className="lbw-inventory-copy">
                        <strong>{workspace.summary.name}</strong>
                        <span title={workspace.summary.dnsName}>{workspace.summary.dnsName}</span>
                      </div>
                      <span className={`tf-status-badge ${toneForState(workspace.summary.state)}`}>{workspace.summary.state}</span>
                    </div>
                    <div className="lbw-inventory-tags">
                      {activeCols.map((column) => (
                        <span key={column.key} className="lbw-tag"><em>{column.label}</em><strong>{getColVal(workspace, column.key)}</strong></span>
                      ))}
                    </div>
                    <div className="lbw-inventory-metrics">
                      <div><span>Listeners</span><strong>{workspace.listeners.length}</strong></div>
                      <div><span>Groups</span><strong>{workspace.targetGroups.length}</strong></div>
                      <div><span>Targets</span><strong>{countTargets(workspace)}</strong></div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className="lbw-detail-pane">
          {!selected ? (
            <div className="svc-empty">Select a load balancer to view details.</div>
          ) : (
            <>
              <section className="lbw-detail-hero">
                <div className="lbw-detail-hero-copy">
                  <div className="eyebrow">Selected edge</div>
                  <h3>{selected.summary.name}</h3>
                  <p>{selected.summary.dnsName}</p>
                  <div className="lbw-detail-meta-strip">
                    <div className="lbw-detail-meta-pill"><span>Type</span><strong>{selected.summary.type}</strong></div>
                    <div className="lbw-detail-meta-pill"><span>Scheme</span><strong>{selected.summary.scheme}</strong></div>
                    <div className="lbw-detail-meta-pill"><span>VPC</span><strong>{selected.summary.vpcId}</strong></div>
                    <div className="lbw-detail-meta-pill"><span>Created</span><strong>{fmt(selected.summary.createdTime)}</strong></div>
                  </div>
                </div>
                <div className="lbw-detail-hero-stats">
                  <div className={`tf-detail-stat-card ${toneForState(selected.summary.state) === 'ok' ? 'success' : toneForState(selected.summary.state)}`}><span>State</span><strong>{selected.summary.state}</strong><small>{selected.timeline.length} timeline events recorded</small></div>
                  <div className="tf-detail-stat-card"><span>Listeners</span><strong>{selected.listeners.length}</strong><small>{selectedRules.length} rules on the active listener</small></div>
                  <div className="tf-detail-stat-card"><span>Target Groups</span><strong>{selected.targetGroups.length}</strong><small>{selectedTargets.length} targets in the active group</small></div>
                  <div className="tf-detail-stat-card"><span>Availability Zones</span><strong>{selected.summary.availabilityZones.length}</strong><small>{selected.summary.securityGroups.length} security groups attached</small></div>
                </div>
              </section>

              <div className="tf-detail-tabs">
                <button className={sideTab === 'details' ? 'active' : ''} type="button" onClick={() => setSideTab('details')}>Details</button>
                <button className={sideTab === 'targets' ? 'active' : ''} type="button" onClick={() => setSideTab('targets')}>Targets</button>
                <button className={sideTab === 'rules' ? 'active' : ''} type="button" onClick={() => setSideTab('rules')}>Rules</button>
                <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>Timeline</button>
              </div>

              {sideTab === 'details' && (
                <div className="lbw-tab-stack">
                  <section className="tf-section">
                    <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Action</span><h3>Mutation controls</h3></div></div>
                    <div className="lbw-action-row">
                      <ConfirmButton className="tf-toolbar-btn danger" onConfirm={() => void doDelete()}>Delete load balancer</ConfirmButton>
                    </div>
                  </section>
                  <section className="tf-section">
                    <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Topology</span><h3>Load balancer summary</h3></div></div>
                    <div className="svc-kv">
                      <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{selected.summary.name}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value lbw-mono">{selected.summary.arn}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">DNS</div><div className="svc-kv-value lbw-mono">{selected.summary.dnsName}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">Security Groups</div><div className="svc-kv-value">{selected.summary.securityGroups.join(', ') || '-'}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">Availability Zones</div><div className="svc-kv-value">{selected.summary.availabilityZones.join(', ') || '-'}</div></div>
                    </div>
                  </section>
                  <div className="lbw-dual-grid">
                    <section className="tf-section">
                      <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Listeners</span><h3>Ports and TLS posture</h3></div></div>
                      <div className="lbw-list">
                        {selected.listeners.map((listener) => (
                          <button key={listener.arn} type="button" className={`lbw-list-item ${listener.arn === selectedListenerArn ? 'active' : ''}`} onClick={() => setSelectedListenerArn(listener.arn)}>
                            <div><strong>{listener.protocol}:{listener.port}</strong><span>{listener.sslPolicy || 'No TLS policy'}</span></div>
                            <small>{(selected.rulesByListener[listener.arn] ?? []).length} rules</small>
                          </button>
                        ))}
                      </div>
                    </section>
                    <section className="tf-section">
                      <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Target groups</span><h3>Health check and routing</h3></div></div>
                      <div className="lbw-list">
                        {selected.targetGroups.map((group) => (
                          <button
                            key={group.arn}
                            type="button"
                            className={`lbw-list-item ${group.arn === selectedGroupArn ? 'active' : ''}`}
                            onClick={() => {
                              setSelectedGroupArn(group.arn)
                              setSelectedTargetId(selected.targetsByGroup[group.arn]?.[0]?.id ?? '')
                            }}
                          >
                            <div><strong>{group.name}</strong><span>{group.protocol}:{group.port} · {group.targetType}</span></div>
                            <small>{(selected.targetsByGroup[group.arn] ?? []).length} targets</small>
                          </button>
                        ))}
                      </div>
                      {selectedGroup && (
                        <div className="svc-kv lbw-inline-kv">
                          <div className="svc-kv-row"><div className="svc-kv-label">Health Check</div><div className="svc-kv-value">{selectedGroup.healthCheck.protocol}:{selectedGroup.healthCheck.port}</div></div>
                          <div className="svc-kv-row"><div className="svc-kv-label">Path</div><div className="svc-kv-value">{selectedGroup.healthCheck.path || '-'}</div></div>
                          <div className="svc-kv-row"><div className="svc-kv-label">Matcher</div><div className="svc-kv-value">{selectedGroup.healthCheck.matcher || '-'}</div></div>
                          <div className="svc-kv-row"><div className="svc-kv-label">Thresholds</div><div className="svc-kv-value">{selectedGroup.healthCheck.healthyThreshold}/{selectedGroup.healthCheck.unhealthyThreshold}</div></div>
                        </div>
                      )}
                    </section>
                  </div>
                </div>
              )}

              {sideTab === 'targets' && (
                <div className="lbw-tab-stack">
                  <section className="tf-section">
                    <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Target health</span><h3>{selectedGroup?.name ?? 'Select a target group'}</h3></div></div>
                    <div className="lbw-table-wrap">
                      <table className="svc-table">
                        <thead><tr><th>Target</th><th>Port</th><th>State</th><th>Reason</th></tr></thead>
                        <tbody>
                          {selectedTargets.map((target) => (
                            <tr key={`${target.id}:${target.port}`} className={target.id === selectedTargetId ? 'active' : ''} onClick={() => setSelectedTargetId(target.id)}>
                              <td>{target.id}</td>
                              <td>{target.port ?? '-'}</td>
                              <td><span className={`svc-badge ${toneForState(target.state)}`}>{target.state}</span></td>
                              <td>{target.reason || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!selectedTargets.length && <div className="svc-empty">No targets in this group.</div>}
                  </section>
                  {selectedTarget && relatedInstance && (
                    <section className="tf-section">
                      <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Mapped compute</span><h3>EC2 instance detail</h3></div></div>
                      <div className="svc-kv">
                        <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{relatedInstance.name || '-'}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Instance</div><div className="svc-kv-value">{relatedInstance.instanceId}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">State</div><div className="svc-kv-value">{relatedInstance.state}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Type</div><div className="svc-kv-value">{relatedInstance.type}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Private IP</div><div className="svc-kv-value">{relatedInstance.privateIp || '-'}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Public IP</div><div className="svc-kv-value">{relatedInstance.publicIp || '-'}</div></div>
                      </div>
                    </section>
                  )}
                </div>
              )}

              {sideTab === 'rules' && (
                <section className="tf-section">
                  <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Routing rules</span><h3>{selectedListener ? `${selectedListener.protocol}:${selectedListener.port}` : 'Select a listener'}</h3></div></div>
                  <div className="lbw-table-wrap">
                    <table className="svc-table">
                      <thead><tr><th>Priority</th><th>Conditions</th><th>Actions</th></tr></thead>
                      <tbody>
                        {selectedRules.map((rule) => (
                          <tr key={rule.arn}>
                            <td>{rule.isDefault ? 'default' : rule.priority}</td>
                            <td>{rule.conditions.join(', ') || '-'}</td>
                            <td>{rule.actions.join(', ') || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!selectedRules.length && <div className="svc-empty">Select a listener from the Details tab.</div>}
                </section>
              )}

              {sideTab === 'timeline' && (
                <section className="tf-section">
                  <div className="lbw-section-head"><div><span className="lbw-pane-kicker">Timeline</span><h3>{selected.timeline.length} recorded events</h3></div></div>
                  {selected.timeline.length > 0 ? (
                    <div className="lbw-timeline">
                      {selected.timeline.map((event) => (
                        <article key={event.id} className="lbw-timeline-card">
                          <div className="lbw-timeline-head">
                            <span className={`svc-badge ${severityTone(event.severity)}`}>{event.severity}</span>
                            <span>{fmt(event.timestamp)}</span>
                          </div>
                          <strong>{event.title}</strong>
                          <p>{event.detail}</p>
                        </article>
                      ))}
                    </div>
                  ) : <div className="svc-empty">No timeline events.</div>}
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
