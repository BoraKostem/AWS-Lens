import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type {
  AzureLoadBalancerSummary,
  AzureLoadBalancerDetail,
} from '@shared/types'
import {
  listAzureLoadBalancers,
  describeAzureLoadBalancer,
} from './api'
import { SvcState } from './SvcState'

/* ── Helpers ── */

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s
}

function normalizeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function provisionBadge(state: string): JSX.Element {
  const cls = state === 'Succeeded' ? 'ok' : state === 'Failed' ? 'danger' : 'warn'
  return <span className={`svc-badge ${cls}`} style={{ fontSize: 10 }}>{state}</span>
}

function skuBadge(sku: string): JSX.Element {
  const cls = sku === 'Standard' ? 'ok' : sku === 'Basic' ? 'warn' : 'info'
  return <span className={`svc-badge ${cls}`}>{sku || '-'}</span>
}

/* ── Component ── */

type TabId = 'loadBalancers' | 'rules' | 'probes' | 'backends'

export function AzureLoadBalancersConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenMonitor
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenMonitor?: (query: string) => void
}): JSX.Element {
  const [loadBalancers, setLoadBalancers] = useState<AzureLoadBalancerSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabId>('loadBalancers')
  const [selectedLbId, setSelectedLbId] = useState('')
  const [detail, setDetail] = useState<AzureLoadBalancerDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [filter, setFilter] = useState('')

  /* ── Data fetching ── */

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    listAzureLoadBalancers(subscriptionId, location)
      .then((result) => { if (!cancelled) setLoadBalancers(result) })
      .catch((e) => { if (!cancelled) setError(normalizeError(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  /* ── Detail fetch on selection ── */

  useEffect(() => {
    if (!selectedLbId) { setDetail(null); return }
    const lb = loadBalancers.find((l) => l.id === selectedLbId)
    if (!lb) { setDetail(null); return }
    let cancelled = false
    setDetailLoading(true)
    describeAzureLoadBalancer(subscriptionId, lb.resourceGroup, lb.name)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setDetail(null) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedLbId, subscriptionId, loadBalancers])

  /* ── Derived state ── */

  const selectedLb = useMemo(
    () => loadBalancers.find((l) => l.id === selectedLbId) ?? null,
    [loadBalancers, selectedLbId]
  )

  const filteredLbs = useMemo(() => {
    if (!filter) return loadBalancers
    const q = filter.toLowerCase()
    return loadBalancers.filter((lb) => lb.name.toLowerCase().includes(q) || lb.resourceGroup.toLowerCase().includes(q) || lb.location.toLowerCase().includes(q))
  }, [loadBalancers, filter])

  const totalFrontends = useMemo(() => loadBalancers.reduce((sum, lb) => sum + lb.frontendIpCount, 0), [loadBalancers])
  const totalRules = useMemo(() => loadBalancers.reduce((sum, lb) => sum + lb.ruleCount, 0), [loadBalancers])
  const standardCount = useMemo(() => loadBalancers.filter((lb) => lb.skuName === 'Standard').length, [loadBalancers])
  const basicCount = useMemo(() => loadBalancers.filter((lb) => lb.skuName === 'Basic').length, [loadBalancers])

  /* ── Loading gate ── */

  if (loading && !loadBalancers.length) {
    return <SvcState variant="loading" message="Loading Load Balancer resources..." />
  }

  /* ── Render ── */

  function refreshAll() {
    setLoading(true)
    setError('')
    listAzureLoadBalancers(subscriptionId, location)
      .then(setLoadBalancers)
      .catch((e) => setError(normalizeError(e)))
      .finally(() => setLoading(false))
  }

  return (
    <div className="svc-console asg-console azure-load-balancers-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Azure Load Balancers</div>
          <h2>Load Balancers</h2>
          <p>Layer-4 load balancing service with frontend IP configurations, backend pools, health probes, and load balancing rules.</p>
          <div className="asg-meta-strip">
            <div className="asg-meta-pill">
              <span>Subscription</span>
              <strong>{trunc(subscriptionId, 20)}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Location</span>
              <strong>{location || 'All'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Load Balancers</span>
            <strong>{loadBalancers.length}</strong>
            <small>{standardCount} Standard, {basicCount} Basic.</small>
          </div>
          <div className="asg-stat-card">
            <span>Frontend IPs</span>
            <strong>{totalFrontends}</strong>
            <small>Total frontend IP configurations.</small>
          </div>
          <div className="asg-stat-card">
            <span>Rules</span>
            <strong>{totalRules}</strong>
            <small>Total load balancing rules.</small>
          </div>
          <div className="asg-stat-card">
            <span>Standard SKU</span>
            <strong>{standardCount}</strong>
            <small>Standard tier load balancers.</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ── */}
      <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
        <button className={`svc-tab ${activeTab === 'loadBalancers' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('loadBalancers')}>Load Balancers ({loadBalancers.length})</button>
        <button className={`svc-tab ${activeTab === 'rules' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('rules')}>Rules ({detail ? detail.rules.length + detail.inboundNatRules.length : 0})</button>
        <button className={`svc-tab ${activeTab === 'probes' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('probes')}>Health Probes ({detail?.probes.length ?? 0})</button>
        <button className={`svc-tab ${activeTab === 'backends' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('backends')}>Backend Pools ({detail?.backendPools.length ?? 0})</button>
        <button className="svc-tab right" type="button" onClick={refreshAll}>Refresh</button>
      </div>

      {/* ── Load Balancers tab (master-detail) ── */}
      {activeTab === 'loadBalancers' && (
        <div className="asg-main-layout">
          <aside className="asg-groups-pane">
            <div className="asg-pane-head">
              <div>
                <span className="asg-pane-kicker">Azure Load Balancer</span>
                <h3>Load balancer inventory</h3>
              </div>
              <span className="asg-pane-summary">{loadBalancers.length} total</span>
            </div>
            <input
              className="svc-search asg-search"
              placeholder="Filter load balancers..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="asg-group-list">
              {filteredLbs.map((lb) => (
                <button
                  key={lb.id}
                  type="button"
                  className={`asg-group-card ${lb.id === selectedLbId ? 'active' : ''}`}
                  onClick={() => setSelectedLbId(lb.id)}
                >
                  <div className="asg-group-card-head">
                    <div className="asg-group-card-copy">
                      <strong>{lb.name}</strong>
                      <span>{lb.skuName} / {lb.skuTier}</span>
                    </div>
                    {provisionBadge(lb.provisioningState)}
                  </div>
                  <div className="asg-group-card-metrics">
                    <div>
                      <span>Frontends</span>
                      <strong>{lb.frontendIpCount}</strong>
                    </div>
                    <div>
                      <span>Backends</span>
                      <strong>{lb.backendPoolCount}</strong>
                    </div>
                    <div>
                      <span>Rules</span>
                      <strong>{lb.ruleCount}</strong>
                    </div>
                  </div>
                </button>
              ))}
              {!filteredLbs.length && <div className="svc-empty">No load balancers found.</div>}
            </div>
          </aside>

          <section className="asg-detail-pane">
            {selectedLb ? (
              <>
                <section className="asg-detail-hero">
                  <div className="asg-detail-copy">
                    <div className="eyebrow">Selected load balancer</div>
                    <h3>{selectedLb.name}</h3>
                    <p>Properties and configuration for the selected Load Balancer.</p>
                    <div className="asg-meta-strip">
                      <div className="asg-meta-pill">
                        <span>SKU</span>
                        <strong>{selectedLb.skuName} / {selectedLb.skuTier}</strong>
                      </div>
                      <div className="asg-meta-pill">
                        <span>Frontends</span>
                        <strong>{selectedLb.frontendIpCount}</strong>
                      </div>
                    </div>
                  </div>
                </section>

                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Load balancer configuration</span>
                        <h3>Properties</h3>
                      </div>
                    </div>
                    {detailLoading && <SvcState variant="loading" resourceName="load balancer details" compact />}
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Resource Group</td><td>{selectedLb.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selectedLb.location}</td></tr>
                        <tr><td>SKU Name</td><td>{skuBadge(selectedLb.skuName)}</td></tr>
                        <tr><td>SKU Tier</td><td>{selectedLb.skuTier}</td></tr>
                        <tr><td>Frontend IPs</td><td>{selectedLb.frontendIpCount}</td></tr>
                        <tr><td>Backend Pools</td><td>{selectedLb.backendPoolCount}</td></tr>
                        <tr><td>Rules</td><td>{selectedLb.ruleCount}</td></tr>
                        <tr><td>Probes</td><td>{selectedLb.probeCount}</td></tr>
                        <tr><td>Provisioning State</td><td>{provisionBadge(selectedLb.provisioningState)}</td></tr>
                      </tbody>
                    </table>

                    {/* Inline frontend IPs */}
                    {detail && detail.frontendIpConfigurations.length > 0 && (
                      <>
                        <div className="asg-section-head" style={{ marginTop: 16 }}>
                          <div>
                            <span className="asg-pane-kicker">Frontend IP configurations</span>
                          </div>
                        </div>
                        <div className="asg-table-wrap">
                          <table className="asg-table" style={{ fontSize: 11 }}>
                            <thead>
                              <tr><th>Name</th><th>Private IP</th><th>Allocation</th><th>Public IP</th><th>Zones</th></tr>
                            </thead>
                            <tbody>
                              {detail.frontendIpConfigurations.map((fe) => (
                                <tr key={fe.name}>
                                  <td>{fe.name}</td>
                                  <td>{fe.privateIPAddress || '-'}</td>
                                  <td>{fe.privateIPAllocationMethod || '-'}</td>
                                  <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{fe.publicIPAddressId ? trunc(fe.publicIPAddressId.split('/').pop() ?? '', 24) : '-'}</td>
                                  <td>{fe.zones.length > 0 ? fe.zones.join(', ') : '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}

                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az network lb show --name "${selectedLb.name}" --resource-group "${selectedLb.resourceGroup}" --output table`)}>CLI details</button>
                      {onOpenMonitor && <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.Network loadBalancers ${selectedLb.name}`)}>Monitor</button>}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="asg-empty-state">
                <div className="eyebrow">No selection</div>
                <h3>Select a Load Balancer</h3>
                <p>Choose a load balancer from the inventory to view its frontend IPs, backend pools, rules, and health probes.</p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Rules tab ── */}
      {activeTab === 'rules' && (
        <div style={{ padding: '16px' }}>
          {!selectedLb && <SvcState variant="empty" message="Select a load balancer from the Load Balancers tab to view rules." />}
          {selectedLb && detailLoading && <SvcState variant="loading" resourceName="rules" compact />}
          {selectedLb && !detailLoading && detail && (detail.rules.length > 0 || detail.inboundNatRules.length > 0) && (
            <div className="asg-table-wrap">
              <table className="asg-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Protocol</th>
                    <th>Frontend Port</th>
                    <th>Backend Port</th>
                    <th>Frontend IP</th>
                    <th>Backend Pool</th>
                    <th>Probe</th>
                    <th>Floating IP</th>
                    <th>Idle Timeout</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.rules.map((r) => (
                    <tr key={`lb-${r.name}`}>
                      <td>{r.name}</td>
                      <td><span className="svc-badge info">LB Rule</span></td>
                      <td>{r.protocol}</td>
                      <td>{r.frontendPort}</td>
                      <td>{r.backendPort}</td>
                      <td>{r.frontendIPConfigurationName || '-'}</td>
                      <td>{r.backendAddressPoolName || '-'}</td>
                      <td>{r.probeName || '-'}</td>
                      <td>{r.enableFloatingIP ? 'Yes' : 'No'}</td>
                      <td>{r.idleTimeoutInMinutes}m</td>
                      <td>{provisionBadge(r.provisioningState)}</td>
                    </tr>
                  ))}
                  {detail.inboundNatRules.map((nr) => (
                    <tr key={`nat-${nr.name}`}>
                      <td>{nr.name}</td>
                      <td><span className="svc-badge warn">Inbound NAT</span></td>
                      <td>{nr.protocol}</td>
                      <td>{nr.frontendPort}</td>
                      <td>{nr.backendPort}</td>
                      <td>{nr.frontendIPConfigurationName || '-'}</td>
                      <td>-</td>
                      <td>-</td>
                      <td>{nr.enableFloatingIP ? 'Yes' : 'No'}</td>
                      <td>{nr.idleTimeoutInMinutes}m</td>
                      <td>{provisionBadge(nr.provisioningState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selectedLb && !detailLoading && detail && detail.rules.length === 0 && detail.inboundNatRules.length === 0 && (
            <SvcState variant="empty" message="No load balancing rules or inbound NAT rules found." />
          )}
        </div>
      )}

      {/* ── Health Probes tab ── */}
      {activeTab === 'probes' && (
        <div style={{ padding: '16px' }}>
          {!selectedLb && <SvcState variant="empty" message="Select a load balancer from the Load Balancers tab to view health probes." />}
          {selectedLb && detailLoading && <SvcState variant="loading" resourceName="health probes" compact />}
          {selectedLb && !detailLoading && detail && detail.probes.length > 0 && (
            <div className="asg-table-wrap">
              <table className="asg-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Protocol</th>
                    <th>Port</th>
                    <th>Request Path</th>
                    <th>Interval (s)</th>
                    <th>Probe Count</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.probes.map((p) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td>{p.protocol}</td>
                      <td>{p.port}</td>
                      <td>{p.requestPath || '-'}</td>
                      <td>{p.intervalInSeconds}</td>
                      <td>{p.numberOfProbes}</td>
                      <td>{provisionBadge(p.provisioningState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selectedLb && !detailLoading && detail && detail.probes.length === 0 && (
            <SvcState variant="empty" message="No health probes found for the selected load balancer." />
          )}
        </div>
      )}

      {/* ── Backend Pools tab ── */}
      {activeTab === 'backends' && (
        <div style={{ padding: '16px' }}>
          {!selectedLb && <SvcState variant="empty" message="Select a load balancer from the Load Balancers tab to view backend pools." />}
          {selectedLb && detailLoading && <SvcState variant="loading" resourceName="backend pools" compact />}
          {selectedLb && !detailLoading && detail && detail.backendPools.length > 0 && (
            <div className="asg-table-wrap">
              <table className="asg-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Backend Addresses</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.backendPools.map((bp) => (
                    <tr key={bp.name}>
                      <td>{bp.name}</td>
                      <td>{bp.backendAddressCount}</td>
                      <td>{provisionBadge(bp.provisioningState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selectedLb && !detailLoading && detail && detail.backendPools.length === 0 && (
            <SvcState variant="empty" message="No backend pools found for the selected load balancer." />
          )}
        </div>
      )}
    </div>
  )
}
