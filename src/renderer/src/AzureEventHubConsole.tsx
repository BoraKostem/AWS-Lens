import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type {
  AzureEventHubNamespaceSummary,
  AzureEventHubSummary,
  AzureEventHubConsumerGroupSummary
} from '@shared/types'
import {
  listAzureEventHubNamespaces,
  listAzureEventHubs,
  listAzureEventHubConsumerGroups
} from './api'
import { SvcState } from './SvcState'

function truncate(value: string, max = 24): string {
  if (!value) return '-'
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`
}

function formatDateTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

export function AzureEventHubConsole({
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
  onOpenMonitor: (query: string) => void
}): JSX.Element {
  const [namespaces, setNamespaces] = useState<AzureEventHubNamespaceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedNs, setSelectedNs] = useState('')
  const [hubs, setHubs] = useState<AzureEventHubSummary[]>([])
  const [selectedHub, setSelectedHub] = useState('')
  const [consumerGroups, setConsumerGroups] = useState<AzureEventHubConsumerGroupSummary[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [cgLoading, setCgLoading] = useState(false)
  const [detailTab, setDetailTab] = useState<'hubs' | 'consumer-groups'>('hubs')

  function doRefresh() {
    setLoading(true)
    setError('')
    listAzureEventHubNamespaces(subscriptionId, location)
      .then(setNamespaces)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    listAzureEventHubNamespaces(subscriptionId, location)
      .then((next) => { if (!cancelled) setNamespaces(next) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  const selectedNamespace = useMemo(
    () => namespaces.find((ns) => ns.name === selectedNs) ?? null,
    [namespaces, selectedNs]
  )

  useEffect(() => {
    if (!selectedNamespace) { setHubs([]); setSelectedHub(''); setConsumerGroups([]); return }
    let cancelled = false
    setDetailLoading(true)
    setDetailError('')
    setSelectedHub('')
    setConsumerGroups([])
    setDetailTab('hubs')
    listAzureEventHubs(subscriptionId, selectedNamespace.resourceGroup, selectedNamespace.name)
      .then((next) => { if (!cancelled) setHubs(next) })
      .catch((e) => { if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedNamespace?.name, subscriptionId])

  useEffect(() => {
    if (!selectedHub || !selectedNamespace) { setConsumerGroups([]); return }
    let cancelled = false
    setCgLoading(true)
    listAzureEventHubConsumerGroups(subscriptionId, selectedNamespace.resourceGroup, selectedNamespace.name, selectedHub)
      .then((next) => { if (!cancelled) setConsumerGroups(next) })
      .catch(() => { if (!cancelled) setConsumerGroups([]) })
      .finally(() => { if (!cancelled) setCgLoading(false) })
    return () => { cancelled = true }
  }, [selectedHub, selectedNamespace?.name, subscriptionId])

  const filtered = useMemo(() => {
    if (!filter) return namespaces
    const q = filter.toLowerCase()
    return namespaces.filter((ns) => ns.name.toLowerCase().includes(q) || ns.location.toLowerCase().includes(q))
  }, [namespaces, filter])

  const kafkaCount = useMemo(() => namespaces.filter((ns) => ns.kafkaEnabled).length, [namespaces])
  const totalThroughput = useMemo(() => namespaces.reduce((sum, ns) => sum + ns.skuCapacity, 0), [namespaces])

  if (loading && !namespaces.length) return <SvcState type="loading" message="Loading Event Hub namespaces..." />

  return (
    <div className="svc-console asg-console azure-event-hub-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Messaging control plane</div>
          <h2>Event Hubs posture</h2>
          <p>Browse Event Hub namespaces, inspect hubs and consumer groups, and review throughput and Kafka configuration across the subscription.</p>
          <div className="asg-meta-strip">
            <div className="asg-meta-pill">
              <span>Subscription</span>
              <strong>{truncate(subscriptionId, 20)}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Location</span>
              <strong>{location || 'all'}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Selected namespace</span>
              <strong>{selectedNs || 'None selected'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Namespaces</span>
            <strong>{namespaces.length}</strong>
            <small>Event Hub namespaces discovered.</small>
          </div>
          <div className="asg-stat-card">
            <span>Total TU</span>
            <strong>{totalThroughput}</strong>
            <small>Combined throughput units across namespaces.</small>
          </div>
          <div className="asg-stat-card">
            <span>Kafka-enabled</span>
            <strong>{kafkaCount}</strong>
            <small>Namespaces with Kafka protocol support.</small>
          </div>
          <div className="asg-stat-card">
            <span>Hubs</span>
            <strong>{selectedNs ? hubs.length : '-'}</strong>
            <small>{selectedNs ? 'Hubs in the selected namespace.' : 'Select a namespace to view.'}</small>
          </div>
        </div>
      </section>

      <div className="asg-main-layout">
        {/* ── Left sidebar: Namespace list ── */}
        <aside className="asg-groups-pane">
          <div className="asg-pane-head">
            <div>
              <span className="asg-pane-kicker">Discovered namespaces</span>
              <h3>Namespace inventory</h3>
            </div>
            <span className="asg-pane-summary">{namespaces.length} total</span>
          </div>
          <input
            className="svc-search asg-search"
            placeholder="Filter namespaces..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="asg-group-list">
            {filtered.map((ns) => (
              <button
                key={ns.name}
                type="button"
                className={`asg-group-card ${ns.name === selectedNs ? 'active' : ''}`}
                onClick={() => setSelectedNs(ns.name)}
              >
                <div className="asg-group-card-head">
                  <div className="asg-group-card-copy">
                    <strong>{ns.name}</strong>
                    <span>{ns.skuTier}</span>
                  </div>
                  <span className={`svc-badge ${ns.status === 'Active' ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>{ns.status}</span>
                </div>
                <div className="asg-group-card-metrics">
                  <div>
                    <span>TU</span>
                    <strong>{ns.skuCapacity}</strong>
                  </div>
                  <div>
                    <span>Kafka</span>
                    <strong>{ns.kafkaEnabled ? 'Yes' : 'No'}</strong>
                  </div>
                  <div>
                    <span>Zone</span>
                    <strong>{ns.zoneRedundant ? 'Yes' : 'No'}</strong>
                  </div>
                </div>
              </button>
            ))}
            {!filtered.length && <div className="svc-empty">No Event Hub namespaces found.</div>}
          </div>
        </aside>

        {/* ── Right pane: detail ── */}
        <section className="asg-detail-pane">
          {selectedNamespace ? (
            <>
              {/* Detail hero */}
              <section className="asg-detail-hero">
                <div className="asg-detail-copy">
                  <div className="eyebrow">Selected namespace</div>
                  <h3>{selectedNamespace.name}</h3>
                  <p>Event hubs, consumer groups, and configuration for the active namespace.</p>
                  <div className="asg-meta-strip">
                    <div className="asg-meta-pill">
                      <span>SKU</span>
                      <strong>{selectedNamespace.skuTier} ({selectedNamespace.skuName})</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Throughput</span>
                      <strong>{selectedNamespace.skuCapacity} TU{selectedNamespace.isAutoInflateEnabled ? ` (max ${selectedNamespace.maximumThroughputUnits})` : ''}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Kafka</span>
                      <strong>{selectedNamespace.kafkaEnabled ? 'Enabled' : 'Disabled'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Zone redundant</span>
                      <strong>{selectedNamespace.zoneRedundant ? 'Yes' : 'No'}</strong>
                    </div>
                  </div>
                </div>
                <div className="asg-detail-glance">
                  <div className="asg-stat-card">
                    <span>Event Hubs</span>
                    <strong>{detailLoading ? '...' : hubs.length}</strong>
                    <small>Hubs in this namespace.</small>
                  </div>
                  <div className="asg-stat-card">
                    <span>Consumer Groups</span>
                    <strong>{selectedHub ? (cgLoading ? '...' : consumerGroups.length) : '-'}</strong>
                    <small>{selectedHub ? 'Groups in the selected hub.' : 'Select a hub to view.'}</small>
                  </div>
                </div>
              </section>

              {/* Tab bar */}
              <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
                <button className={`svc-tab ${detailTab === 'hubs' ? 'active' : ''}`} type="button" onClick={() => { setDetailTab('hubs'); setSelectedHub('') }}>Event Hubs ({hubs.length})</button>
                {selectedHub && <button className={`svc-tab ${detailTab === 'consumer-groups' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('consumer-groups')}>{selectedHub} &mdash; Consumer Groups</button>}
                <button className="svc-tab right" type="button" onClick={doRefresh}>Refresh</button>
              </div>

              {detailLoading && <SvcState type="loading" message="Loading event hubs..." />}
              {detailError && <div className="svc-error">{detailError}</div>}

              {/* Hubs tab */}
              {!detailLoading && !detailError && detailTab === 'hubs' && (
                <>
                  <div className="asg-toolbar-grid">
                    <section className="svc-panel asg-capacity-panel">
                      <div className="asg-section-head">
                        <div>
                          <span className="asg-pane-kicker">Namespace configuration</span>
                          <h3>Properties</h3>
                        </div>
                      </div>
                      <table className="svc-kv-table">
                        <tbody>
                          <tr><td>Resource Group</td><td>{selectedNamespace.resourceGroup}</td></tr>
                          <tr><td>Location</td><td>{selectedNamespace.location}</td></tr>
                          <tr><td>Auto-inflate</td><td>{selectedNamespace.isAutoInflateEnabled ? `Enabled (max ${selectedNamespace.maximumThroughputUnits})` : 'Disabled'}</td></tr>
                          <tr><td>Public Access</td><td><span className={`svc-badge ${selectedNamespace.publicNetworkAccess.toLowerCase() === 'enabled' ? 'ok' : 'warn'}`}>{selectedNamespace.publicNetworkAccess}</span></td></tr>
                          <tr><td>Endpoint</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selectedNamespace.serviceBusEndpoint}</code></td></tr>
                        </tbody>
                      </table>
                      <div className="svc-btn-row" style={{ marginTop: 12 }}>
                        <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az eventhubs namespace show --name "${selectedNamespace.name}" --resource-group "${selectedNamespace.resourceGroup}" --output table`)}>CLI details</button>
                        <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.EventHub namespaces ${selectedNamespace.name}`)}>Monitor</button>
                      </div>
                    </section>
                  </div>

                  <div className="svc-table-area asg-table-area">
                    <table className="svc-table">
                      <thead><tr><th>Name</th><th>Partitions</th><th>Retention (days)</th><th>Status</th><th>Created</th></tr></thead>
                      <tbody>
                        {hubs.map((h) => (
                          <tr key={h.id} className="svc-clickable-row" onClick={() => { setSelectedHub(h.name); setDetailTab('consumer-groups') }}>
                            <td><strong>{h.name}</strong></td>
                            <td>{h.partitionCount}</td>
                            <td>{h.messageRetentionInDays}</td>
                            <td><span className={`svc-badge ${h.status === 'Active' ? 'ok' : 'warn'}`}>{h.status}</span></td>
                            <td>{formatDateTime(h.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!hubs.length && <div className="svc-empty">No event hubs in this namespace.</div>}
                  </div>
                </>
              )}

              {/* Consumer groups tab */}
              {!detailLoading && !detailError && detailTab === 'consumer-groups' && selectedHub && (
                <>
                  <div className="asg-toolbar-grid">
                    <section className="svc-panel asg-capacity-panel">
                      <div className="asg-section-head">
                        <div>
                          <span className="asg-pane-kicker">Hub details</span>
                          <h3>{selectedHub}</h3>
                        </div>
                      </div>
                      {(() => {
                        const hub = hubs.find((h) => h.name === selectedHub)
                        if (!hub) return null
                        return (
                          <table className="svc-kv-table">
                            <tbody>
                              <tr><td>Partition Count</td><td>{hub.partitionCount}</td></tr>
                              <tr><td>Message Retention</td><td>{hub.messageRetentionInDays} day{hub.messageRetentionInDays === 1 ? '' : 's'}</td></tr>
                              <tr><td>Partition IDs</td><td>{hub.partitionIds.join(', ') || '-'}</td></tr>
                              <tr><td>Status</td><td><span className={`svc-badge ${hub.status === 'Active' ? 'ok' : 'warn'}`}>{hub.status}</span></td></tr>
                              <tr><td>Created</td><td>{formatDateTime(hub.createdAt)}</td></tr>
                              <tr><td>Updated</td><td>{formatDateTime(hub.updatedAt)}</td></tr>
                            </tbody>
                          </table>
                        )
                      })()}
                    </section>
                  </div>

                  {cgLoading && <SvcState type="loading" message="Loading consumer groups..." />}
                  {!cgLoading && (
                    <div className="svc-table-area asg-table-area">
                      <table className="svc-table">
                        <thead><tr><th>Name</th><th>User Metadata</th><th>Created</th><th>Updated</th></tr></thead>
                        <tbody>
                          {consumerGroups.map((cg) => (
                            <tr key={cg.id}>
                              <td><strong>{cg.name}</strong></td>
                              <td>{cg.userMetadata || '-'}</td>
                              <td>{formatDateTime(cg.createdAt)}</td>
                              <td>{formatDateTime(cg.updatedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!consumerGroups.length && <div className="svc-empty">No consumer groups found.</div>}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="asg-empty-state">
              <div className="eyebrow">No selection</div>
              <h3>Select an Event Hub Namespace</h3>
              <p>Choose a namespace from the inventory to inspect its event hubs, consumer groups, and configuration.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
