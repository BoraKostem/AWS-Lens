import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type {
  AzureFirewallSummary,
  AzureFirewallDetail,
} from '@shared/types'
import {
  listAzureFirewalls,
  describeAzureFirewall,
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

function tierBadge(tier: string): JSX.Element {
  const cls = tier === 'Premium' ? 'ok' : tier === 'Basic' ? 'warn' : 'info'
  return <span className={`svc-badge ${cls}`}>{tier || '-'}</span>
}

function threatIntelBadge(mode: string): JSX.Element {
  const cls = mode === 'Deny' ? 'ok' : mode === 'Alert' ? 'warn' : 'danger'
  return <span className={`svc-badge ${cls}`}>{mode || 'Off'}</span>
}

/* ── Component ── */

type TabId = 'firewalls' | 'ipConfigs' | 'ruleCollections'

export function AzureFirewallConsole({
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
  const [firewalls, setFirewalls] = useState<AzureFirewallSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabId>('firewalls')
  const [selectedFirewallId, setSelectedFirewallId] = useState('')
  const [detail, setDetail] = useState<AzureFirewallDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [filter, setFilter] = useState('')

  /* ── Data fetching ── */

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    listAzureFirewalls(subscriptionId, location)
      .then((result) => { if (!cancelled) setFirewalls(result) })
      .catch((e) => { if (!cancelled) setError(normalizeError(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  /* ── Detail fetch on selection ── */

  useEffect(() => {
    if (!selectedFirewallId) { setDetail(null); return }
    const fw = firewalls.find((f) => f.id === selectedFirewallId)
    if (!fw) { setDetail(null); return }
    let cancelled = false
    setDetailLoading(true)
    describeAzureFirewall(subscriptionId, fw.resourceGroup, fw.name)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setDetail(null) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedFirewallId, subscriptionId, firewalls])

  /* ── Derived state ── */

  const selectedFirewall = useMemo(
    () => firewalls.find((f) => f.id === selectedFirewallId) ?? null,
    [firewalls, selectedFirewallId]
  )

  const filteredFirewalls = useMemo(() => {
    if (!filter) return firewalls
    const q = filter.toLowerCase()
    return firewalls.filter((f) => f.name.toLowerCase().includes(q) || f.resourceGroup.toLowerCase().includes(q) || f.location.toLowerCase().includes(q))
  }, [firewalls, filter])

  const totalRuleCollections = useMemo(
    () => firewalls.reduce((sum, f) => sum + f.networkRuleCollectionCount + f.applicationRuleCollectionCount + f.natRuleCollectionCount, 0),
    [firewalls]
  )

  const premiumCount = useMemo(() => firewalls.filter((f) => f.skuTier === 'Premium').length, [firewalls])
  const standardCount = useMemo(() => firewalls.filter((f) => f.skuTier === 'Standard').length, [firewalls])

  /* ── Loading gate ── */

  if (loading && !firewalls.length) {
    return <SvcState variant="loading" message="Loading Azure Firewall resources..." />
  }

  /* ── Render ── */

  function refreshAll() {
    setLoading(true)
    setError('')
    listAzureFirewalls(subscriptionId, location)
      .then(setFirewalls)
      .catch((e) => setError(normalizeError(e)))
      .finally(() => setLoading(false))
  }

  return (
    <div className="svc-console asg-console azure-firewall-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Azure Firewall</div>
          <h2>Firewall</h2>
          <p>Cloud-native network firewall service with built-in high availability, threat intelligence filtering, and centralized policy management.</p>
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
            <span>Firewalls</span>
            <strong>{firewalls.length}</strong>
            <small>Azure Firewall instances discovered.</small>
          </div>
          <div className="asg-stat-card">
            <span>Premium</span>
            <strong>{premiumCount}</strong>
            <small>Premium tier firewalls.</small>
          </div>
          <div className="asg-stat-card">
            <span>Standard</span>
            <strong>{standardCount}</strong>
            <small>Standard tier firewalls.</small>
          </div>
          <div className="asg-stat-card">
            <span>Rule Collections</span>
            <strong>{totalRuleCollections}</strong>
            <small>Total rule collections across all firewalls.</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ── */}
      <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
        <button className={`svc-tab ${activeTab === 'firewalls' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('firewalls')}>Firewalls ({firewalls.length})</button>
        <button className={`svc-tab ${activeTab === 'ipConfigs' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('ipConfigs')}>IP Configurations ({detail?.ipConfigurations.length ?? 0})</button>
        <button className={`svc-tab ${activeTab === 'ruleCollections' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('ruleCollections')}>Rule Collections ({detail?.ruleCollections.length ?? 0})</button>
        <button className="svc-tab right" type="button" onClick={refreshAll}>Refresh</button>
      </div>

      {/* ── Firewalls tab (master-detail) ── */}
      {activeTab === 'firewalls' && (
        <div className="asg-main-layout">
          <aside className="asg-groups-pane">
            <div className="asg-pane-head">
              <div>
                <span className="asg-pane-kicker">Azure Firewall</span>
                <h3>Firewall inventory</h3>
              </div>
              <span className="asg-pane-summary">{firewalls.length} total</span>
            </div>
            <input
              className="svc-search asg-search"
              placeholder="Filter firewalls..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="asg-group-list">
              {filteredFirewalls.map((fw) => (
                <button
                  key={fw.id}
                  type="button"
                  className={`asg-group-card ${fw.id === selectedFirewallId ? 'active' : ''}`}
                  onClick={() => setSelectedFirewallId(fw.id)}
                >
                  <div className="asg-group-card-head">
                    <div className="asg-group-card-copy">
                      <strong>{fw.name}</strong>
                      <span>{fw.skuName} / {fw.skuTier}</span>
                    </div>
                    {provisionBadge(fw.provisioningState)}
                  </div>
                  <div className="asg-group-card-metrics">
                    <div>
                      <span>Threat Intel</span>
                      <strong>{fw.threatIntelMode || 'Off'}</strong>
                    </div>
                    <div>
                      <span>IP Configs</span>
                      <strong>{fw.ipConfigurationCount}</strong>
                    </div>
                    <div>
                      <span>Rules</span>
                      <strong>{fw.networkRuleCollectionCount + fw.applicationRuleCollectionCount + fw.natRuleCollectionCount}</strong>
                    </div>
                  </div>
                </button>
              ))}
              {!filteredFirewalls.length && <div className="svc-empty">No firewalls found.</div>}
            </div>
          </aside>

          <section className="asg-detail-pane">
            {selectedFirewall ? (
              <>
                <section className="asg-detail-hero">
                  <div className="asg-detail-copy">
                    <div className="eyebrow">Selected firewall</div>
                    <h3>{selectedFirewall.name}</h3>
                    <p>Properties and configuration for the selected Azure Firewall instance.</p>
                    <div className="asg-meta-strip">
                      <div className="asg-meta-pill">
                        <span>SKU</span>
                        <strong>{selectedFirewall.skuName} / {selectedFirewall.skuTier}</strong>
                      </div>
                      <div className="asg-meta-pill">
                        <span>Threat Intel</span>
                        <strong>{selectedFirewall.threatIntelMode || 'Off'}</strong>
                      </div>
                    </div>
                  </div>
                </section>

                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Firewall configuration</span>
                        <h3>Properties</h3>
                      </div>
                    </div>
                    {detailLoading && <SvcState variant="loading" resourceName="firewall details" compact />}
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Resource Group</td><td>{selectedFirewall.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selectedFirewall.location}</td></tr>
                        <tr><td>SKU Name</td><td>{selectedFirewall.skuName}</td></tr>
                        <tr><td>SKU Tier</td><td>{tierBadge(selectedFirewall.skuTier)}</td></tr>
                        <tr><td>Threat Intel Mode</td><td>{threatIntelBadge(selectedFirewall.threatIntelMode)}</td></tr>
                        <tr><td>Firewall Policy</td><td>{selectedFirewall.firewallPolicyId ? trunc(selectedFirewall.firewallPolicyId.split('/').pop() ?? '', 30) : 'None'}</td></tr>
                        <tr><td>IP Configurations</td><td>{selectedFirewall.ipConfigurationCount}</td></tr>
                        <tr><td>Network Rule Collections</td><td>{selectedFirewall.networkRuleCollectionCount}</td></tr>
                        <tr><td>Application Rule Collections</td><td>{selectedFirewall.applicationRuleCollectionCount}</td></tr>
                        <tr><td>NAT Rule Collections</td><td>{selectedFirewall.natRuleCollectionCount}</td></tr>
                        <tr><td>Provisioning State</td><td>{provisionBadge(selectedFirewall.provisioningState)}</td></tr>
                      </tbody>
                    </table>
                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az network firewall show --name "${selectedFirewall.name}" --resource-group "${selectedFirewall.resourceGroup}" --output table`)}>CLI details</button>
                      {onOpenMonitor && <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.Network azureFirewalls ${selectedFirewall.name}`)}>Monitor</button>}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="asg-empty-state">
                <div className="eyebrow">No selection</div>
                <h3>Select a Firewall</h3>
                <p>Choose an Azure Firewall from the inventory to view its configuration, IP settings, and rule collections.</p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── IP Configurations tab ── */}
      {activeTab === 'ipConfigs' && (
        <div style={{ padding: '16px' }}>
          {!selectedFirewall && <SvcState variant="empty" message="Select a firewall from the Firewalls tab to view IP configurations." />}
          {selectedFirewall && detailLoading && <SvcState variant="loading" resourceName="IP configurations" compact />}
          {selectedFirewall && !detailLoading && (!detail || detail.ipConfigurations.length === 0) && <SvcState variant="empty" message="No IP configurations found for the selected firewall." />}
          {selectedFirewall && !detailLoading && detail && detail.ipConfigurations.length > 0 && (
            <div className="asg-table-wrap">
              <table className="asg-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Private IP</th>
                    <th>Public IP</th>
                    <th>Subnet</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.ipConfigurations.map((cfg) => (
                    <tr key={cfg.name}>
                      <td>{cfg.name}</td>
                      <td>{cfg.privateIPAddress || '-'}</td>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cfg.publicIPAddressId ? trunc(cfg.publicIPAddressId.split('/').pop() ?? '', 28) : '-'}</td>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cfg.subnetId ? trunc(cfg.subnetId.split('/').pop() ?? '', 28) : '-'}</td>
                      <td>{provisionBadge(cfg.provisioningState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Rule Collections tab ── */}
      {activeTab === 'ruleCollections' && (
        <div style={{ padding: '16px' }}>
          {!selectedFirewall && <SvcState variant="empty" message="Select a firewall from the Firewalls tab to view rule collections." />}
          {selectedFirewall && detailLoading && <SvcState variant="loading" resourceName="rule collections" compact />}
          {selectedFirewall && !detailLoading && (!detail || detail.ruleCollections.length === 0) && (
            <SvcState variant="empty" message={selectedFirewall.firewallPolicyId ? 'No inline rule collections. Rules may be managed by the linked Firewall Policy.' : 'No rule collections found for the selected firewall.'} />
          )}
          {selectedFirewall && !detailLoading && detail && detail.ruleCollections.length > 0 && (
            <div className="asg-table-wrap">
              <table className="asg-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Priority</th>
                    <th>Action</th>
                    <th>Rules</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.ruleCollections.map((rc) => (
                    <tr key={`${rc.kind}-${rc.name}`}>
                      <td>{rc.name}</td>
                      <td><span className={`svc-badge ${rc.kind === 'Network' ? 'info' : rc.kind === 'Application' ? 'ok' : 'warn'}`}>{rc.kind}</span></td>
                      <td>{rc.priority}</td>
                      <td>{rc.action}</td>
                      <td>{rc.ruleCount}</td>
                      <td>{provisionBadge(rc.provisioningState)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
