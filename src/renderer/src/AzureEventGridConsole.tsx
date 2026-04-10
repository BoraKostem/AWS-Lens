import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type {
  AzureEventGridTopicSummary,
  AzureEventGridSystemTopicSummary,
  AzureEventGridEventSubscriptionSummary,
  AzureEventGridDomainSummary,
} from '@shared/types'
import {
  listAzureEventGridTopics,
  listAzureEventGridSystemTopics,
  listAzureEventGridEventSubscriptions,
  listAzureEventGridDomains,
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

function accessBadge(access: string): JSX.Element {
  const lower = access.toLowerCase()
  const cls = lower === 'enabled' ? 'ok' : 'warn'
  return <span className={`svc-badge ${cls}`}>{access}</span>
}

/* ── Component ── */

type TabId = 'topics' | 'systemTopics' | 'domains' | 'subscriptions'

export function AzureEventGridConsole({
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
  const [topics, setTopics] = useState<AzureEventGridTopicSummary[]>([])
  const [systemTopics, setSystemTopics] = useState<AzureEventGridSystemTopicSummary[]>([])
  const [domains, setDomains] = useState<AzureEventGridDomainSummary[]>([])
  const [eventSubscriptions, setEventSubscriptions] = useState<AzureEventGridEventSubscriptionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabId>('topics')
  const [selectedTopicId, setSelectedTopicId] = useState('')
  const [selectedSystemTopicId, setSelectedSystemTopicId] = useState('')
  const [selectedDomainId, setSelectedDomainId] = useState('')
  const [filter, setFilter] = useState('')

  /* ── Data fetching ── */

  function fetchAll(subId: string, loc: string) {
    setLoading(true)
    setError('')
    Promise.allSettled([
      listAzureEventGridTopics(subId, loc),
      listAzureEventGridSystemTopics(subId, loc),
      listAzureEventGridDomains(subId, loc),
      listAzureEventGridEventSubscriptions(subId),
    ]).then(([topicsRes, sysRes, domRes, subsRes]) => {
      if (topicsRes.status === 'fulfilled') setTopics(topicsRes.value)
      else setTopics([])
      if (sysRes.status === 'fulfilled') setSystemTopics(sysRes.value)
      else setSystemTopics([])
      if (domRes.status === 'fulfilled') setDomains(domRes.value)
      else setDomains([])
      if (subsRes.status === 'fulfilled') setEventSubscriptions(subsRes.value)
      else setEventSubscriptions([])

      const errors: string[] = []
      if (topicsRes.status === 'rejected') errors.push(`Topics: ${normalizeError(topicsRes.reason)}`)
      if (sysRes.status === 'rejected') errors.push(`System Topics: ${normalizeError(sysRes.reason)}`)
      if (domRes.status === 'rejected') errors.push(`Domains: ${normalizeError(domRes.reason)}`)
      if (subsRes.status === 'rejected') errors.push(`Subscriptions: ${normalizeError(subsRes.reason)}`)
      setError(errors.join('; '))
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.allSettled([
      listAzureEventGridTopics(subscriptionId, location),
      listAzureEventGridSystemTopics(subscriptionId, location),
      listAzureEventGridDomains(subscriptionId, location),
      listAzureEventGridEventSubscriptions(subscriptionId),
    ]).then(([topicsRes, sysRes, domRes, subsRes]) => {
      if (cancelled) return
      if (topicsRes.status === 'fulfilled') setTopics(topicsRes.value); else setTopics([])
      if (sysRes.status === 'fulfilled') setSystemTopics(sysRes.value); else setSystemTopics([])
      if (domRes.status === 'fulfilled') setDomains(domRes.value); else setDomains([])
      if (subsRes.status === 'fulfilled') setEventSubscriptions(subsRes.value); else setEventSubscriptions([])

      const errors: string[] = []
      if (topicsRes.status === 'rejected') errors.push(`Topics: ${normalizeError(topicsRes.reason)}`)
      if (sysRes.status === 'rejected') errors.push(`System Topics: ${normalizeError(sysRes.reason)}`)
      if (domRes.status === 'rejected') errors.push(`Domains: ${normalizeError(domRes.reason)}`)
      if (subsRes.status === 'rejected') errors.push(`Subscriptions: ${normalizeError(subsRes.reason)}`)
      if (!cancelled) setError(errors.join('; '))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  /* ── Derived state ── */

  const selectedTopic = useMemo(
    () => topics.find((t) => t.id === selectedTopicId) ?? null,
    [topics, selectedTopicId]
  )
  const selectedSystemTopic = useMemo(
    () => systemTopics.find((t) => t.id === selectedSystemTopicId) ?? null,
    [systemTopics, selectedSystemTopicId]
  )
  const selectedDomain = useMemo(
    () => domains.find((d) => d.id === selectedDomainId) ?? null,
    [domains, selectedDomainId]
  )

  const filteredTopics = useMemo(() => {
    if (!filter) return topics
    const q = filter.toLowerCase()
    return topics.filter((t) => t.name.toLowerCase().includes(q) || t.location.toLowerCase().includes(q))
  }, [topics, filter])

  const filteredSystemTopics = useMemo(() => {
    if (!filter) return systemTopics
    const q = filter.toLowerCase()
    return systemTopics.filter((t) => t.name.toLowerCase().includes(q) || t.topicType.toLowerCase().includes(q))
  }, [systemTopics, filter])

  const filteredDomains = useMemo(() => {
    if (!filter) return domains
    const q = filter.toLowerCase()
    return domains.filter((d) => d.name.toLowerCase().includes(q) || d.location.toLowerCase().includes(q))
  }, [domains, filter])

  const filteredSubscriptions = useMemo(() => {
    if (!filter) return eventSubscriptions
    const q = filter.toLowerCase()
    return eventSubscriptions.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.topicName.toLowerCase().includes(q) ||
      s.destinationType.toLowerCase().includes(q)
    )
  }, [eventSubscriptions, filter])

  /* ── Loading gate ── */

  if (loading && !topics.length && !systemTopics.length && !domains.length && !eventSubscriptions.length) {
    return <SvcState variant="loading" message="Loading Event Grid resources..." />
  }

  /* ── Render ── */

  return (
    <div className="svc-console asg-console azure-event-grid-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Azure Event Grid</div>
          <h2>Event Grid</h2>
          <p>Event routing service for reactive event-driven architectures with topics, system topics, domains, and subscriptions.</p>
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
            <span>Topics</span>
            <strong>{topics.length}</strong>
            <small>Custom topics discovered.</small>
          </div>
          <div className="asg-stat-card">
            <span>System Topics</span>
            <strong>{systemTopics.length}</strong>
            <small>Azure-managed system topics.</small>
          </div>
          <div className="asg-stat-card">
            <span>Domains</span>
            <strong>{domains.length}</strong>
            <small>Event domains for multi-tenant routing.</small>
          </div>
          <div className="asg-stat-card">
            <span>Subscriptions</span>
            <strong>{eventSubscriptions.length}</strong>
            <small>Event subscriptions across all topics.</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ── */}
      <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
        <button className={`svc-tab ${activeTab === 'topics' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('topics')}>Topics ({topics.length})</button>
        <button className={`svc-tab ${activeTab === 'systemTopics' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('systemTopics')}>System Topics ({systemTopics.length})</button>
        <button className={`svc-tab ${activeTab === 'domains' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('domains')}>Domains ({domains.length})</button>
        <button className={`svc-tab ${activeTab === 'subscriptions' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('subscriptions')}>Subscriptions ({eventSubscriptions.length})</button>
        <button className="svc-tab right" type="button" onClick={() => fetchAll(subscriptionId, location)}>Refresh</button>
      </div>

      {/* ── Topics tab ── */}
      {activeTab === 'topics' && (
        <div className="asg-main-layout">
          <aside className="asg-groups-pane">
            <div className="asg-pane-head">
              <div>
                <span className="asg-pane-kicker">Custom topics</span>
                <h3>Topic inventory</h3>
              </div>
              <span className="asg-pane-summary">{topics.length} total</span>
            </div>
            <input
              className="svc-search asg-search"
              placeholder="Filter topics..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="asg-group-list">
              {filteredTopics.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`asg-group-card ${t.id === selectedTopicId ? 'active' : ''}`}
                  onClick={() => setSelectedTopicId(t.id)}
                >
                  <div className="asg-group-card-head">
                    <div className="asg-group-card-copy">
                      <strong>{t.name}</strong>
                      <span>{t.inputSchema}</span>
                    </div>
                    {provisionBadge(t.provisioningState)}
                  </div>
                  <div className="asg-group-card-metrics">
                    <div>
                      <span>Access</span>
                      <strong>{t.publicNetworkAccess === 'Enabled' ? 'Public' : 'Private'}</strong>
                    </div>
                    <div>
                      <span>Tags</span>
                      <strong>{t.tagCount}</strong>
                    </div>
                    <div>
                      <span>Region</span>
                      <strong>{trunc(t.location, 12)}</strong>
                    </div>
                  </div>
                </button>
              ))}
              {!filteredTopics.length && <div className="svc-empty">No custom topics found.</div>}
            </div>
          </aside>

          <section className="asg-detail-pane">
            {selectedTopic ? (
              <>
                <section className="asg-detail-hero">
                  <div className="asg-detail-copy">
                    <div className="eyebrow">Selected topic</div>
                    <h3>{selectedTopic.name}</h3>
                    <p>Properties and configuration for the selected Event Grid topic.</p>
                    <div className="asg-meta-strip">
                      <div className="asg-meta-pill">
                        <span>Schema</span>
                        <strong>{selectedTopic.inputSchema}</strong>
                      </div>
                      <div className="asg-meta-pill">
                        <span>Public Access</span>
                        <strong>{selectedTopic.publicNetworkAccess}</strong>
                      </div>
                    </div>
                  </div>
                </section>

                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Topic configuration</span>
                        <h3>Properties</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Resource Group</td><td>{selectedTopic.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selectedTopic.location}</td></tr>
                        <tr><td>Endpoint</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selectedTopic.endpoint}</code></td></tr>
                        <tr><td>Input Schema</td><td>{selectedTopic.inputSchema}</td></tr>
                        <tr><td>Public Network Access</td><td>{accessBadge(selectedTopic.publicNetworkAccess)}</td></tr>
                        <tr><td>Provisioning State</td><td>{provisionBadge(selectedTopic.provisioningState)}</td></tr>
                        <tr><td>Tags</td><td>{selectedTopic.tagCount} tag{selectedTopic.tagCount === 1 ? '' : 's'}</td></tr>
                      </tbody>
                    </table>
                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az eventgrid topic show --name "${selectedTopic.name}" --resource-group "${selectedTopic.resourceGroup}" --output table`)}>CLI details</button>
                      {onOpenMonitor && <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.EventGrid topics ${selectedTopic.name}`)}>Monitor</button>}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="asg-empty-state">
                <div className="eyebrow">No selection</div>
                <h3>Select a Topic</h3>
                <p>Choose a custom topic from the inventory to view its endpoint, schema, and configuration.</p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── System Topics tab ── */}
      {activeTab === 'systemTopics' && (
        <div className="asg-main-layout">
          <aside className="asg-groups-pane">
            <div className="asg-pane-head">
              <div>
                <span className="asg-pane-kicker">Azure-managed topics</span>
                <h3>System topic inventory</h3>
              </div>
              <span className="asg-pane-summary">{systemTopics.length} total</span>
            </div>
            <input
              className="svc-search asg-search"
              placeholder="Filter system topics..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="asg-group-list">
              {filteredSystemTopics.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`asg-group-card ${t.id === selectedSystemTopicId ? 'active' : ''}`}
                  onClick={() => setSelectedSystemTopicId(t.id)}
                >
                  <div className="asg-group-card-head">
                    <div className="asg-group-card-copy">
                      <strong>{t.name}</strong>
                      <span>{trunc(t.topicType, 28)}</span>
                    </div>
                    {provisionBadge(t.provisioningState)}
                  </div>
                  <div className="asg-group-card-metrics">
                    <div>
                      <span>Region</span>
                      <strong>{trunc(t.location, 12)}</strong>
                    </div>
                    <div>
                      <span>Type</span>
                      <strong>{trunc(t.topicType.split('.').pop() || t.topicType, 14)}</strong>
                    </div>
                  </div>
                </button>
              ))}
              {!filteredSystemTopics.length && <div className="svc-empty">No system topics found.</div>}
            </div>
          </aside>

          <section className="asg-detail-pane">
            {selectedSystemTopic ? (
              <>
                <section className="asg-detail-hero">
                  <div className="asg-detail-copy">
                    <div className="eyebrow">Selected system topic</div>
                    <h3>{selectedSystemTopic.name}</h3>
                    <p>Azure-managed event source and routing metadata for this system topic.</p>
                    <div className="asg-meta-strip">
                      <div className="asg-meta-pill">
                        <span>Topic Type</span>
                        <strong>{trunc(selectedSystemTopic.topicType, 30)}</strong>
                      </div>
                      <div className="asg-meta-pill">
                        <span>Location</span>
                        <strong>{selectedSystemTopic.location}</strong>
                      </div>
                    </div>
                  </div>
                </section>

                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">System topic configuration</span>
                        <h3>Properties</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Resource Group</td><td>{selectedSystemTopic.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selectedSystemTopic.location}</td></tr>
                        <tr><td>Source</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selectedSystemTopic.source}</code></td></tr>
                        <tr><td>Topic Type</td><td>{selectedSystemTopic.topicType}</td></tr>
                        <tr><td>Provisioning State</td><td>{provisionBadge(selectedSystemTopic.provisioningState)}</td></tr>
                        <tr><td>Metric Resource ID</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selectedSystemTopic.metricResourceId || '-'}</code></td></tr>
                      </tbody>
                    </table>
                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az eventgrid system-topic show --name "${selectedSystemTopic.name}" --resource-group "${selectedSystemTopic.resourceGroup}" --output table`)}>CLI details</button>
                      {onOpenMonitor && <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.EventGrid systemTopics ${selectedSystemTopic.name}`)}>Monitor</button>}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="asg-empty-state">
                <div className="eyebrow">No selection</div>
                <h3>Select a System Topic</h3>
                <p>Choose a system topic from the inventory to view its event source, type, and metric details.</p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Domains tab ── */}
      {activeTab === 'domains' && (
        <div className="asg-main-layout">
          <aside className="asg-groups-pane">
            <div className="asg-pane-head">
              <div>
                <span className="asg-pane-kicker">Event domains</span>
                <h3>Domain inventory</h3>
              </div>
              <span className="asg-pane-summary">{domains.length} total</span>
            </div>
            <input
              className="svc-search asg-search"
              placeholder="Filter domains..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="asg-group-list">
              {filteredDomains.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`asg-group-card ${d.id === selectedDomainId ? 'active' : ''}`}
                  onClick={() => setSelectedDomainId(d.id)}
                >
                  <div className="asg-group-card-head">
                    <div className="asg-group-card-copy">
                      <strong>{d.name}</strong>
                      <span>{d.inputSchema}</span>
                    </div>
                    {provisionBadge(d.provisioningState)}
                  </div>
                  <div className="asg-group-card-metrics">
                    <div>
                      <span>Access</span>
                      <strong>{d.publicNetworkAccess === 'Enabled' ? 'Public' : 'Private'}</strong>
                    </div>
                    <div>
                      <span>Tags</span>
                      <strong>{d.tagCount}</strong>
                    </div>
                    <div>
                      <span>Region</span>
                      <strong>{trunc(d.location, 12)}</strong>
                    </div>
                  </div>
                </button>
              ))}
              {!filteredDomains.length && <div className="svc-empty">No event domains found.</div>}
            </div>
          </aside>

          <section className="asg-detail-pane">
            {selectedDomain ? (
              <>
                <section className="asg-detail-hero">
                  <div className="asg-detail-copy">
                    <div className="eyebrow">Selected domain</div>
                    <h3>{selectedDomain.name}</h3>
                    <p>Properties and configuration for the selected Event Grid domain.</p>
                    <div className="asg-meta-strip">
                      <div className="asg-meta-pill">
                        <span>Schema</span>
                        <strong>{selectedDomain.inputSchema}</strong>
                      </div>
                      <div className="asg-meta-pill">
                        <span>Public Access</span>
                        <strong>{selectedDomain.publicNetworkAccess}</strong>
                      </div>
                    </div>
                  </div>
                </section>

                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Domain configuration</span>
                        <h3>Properties</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Resource Group</td><td>{selectedDomain.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selectedDomain.location}</td></tr>
                        <tr><td>Endpoint</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selectedDomain.endpoint}</code></td></tr>
                        <tr><td>Input Schema</td><td>{selectedDomain.inputSchema}</td></tr>
                        <tr><td>Public Network Access</td><td>{accessBadge(selectedDomain.publicNetworkAccess)}</td></tr>
                        <tr><td>Provisioning State</td><td>{provisionBadge(selectedDomain.provisioningState)}</td></tr>
                        <tr><td>Tags</td><td>{selectedDomain.tagCount} tag{selectedDomain.tagCount === 1 ? '' : 's'}</td></tr>
                      </tbody>
                    </table>
                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az eventgrid domain show --name "${selectedDomain.name}" --resource-group "${selectedDomain.resourceGroup}" --output table`)}>CLI details</button>
                      {onOpenMonitor && <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.EventGrid domains ${selectedDomain.name}`)}>Monitor</button>}
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="asg-empty-state">
                <div className="eyebrow">No selection</div>
                <h3>Select a Domain</h3>
                <p>Choose an event domain from the inventory to view its endpoint, schema, and configuration.</p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Subscriptions tab ── */}
      {activeTab === 'subscriptions' && (
        <div className="svc-table-area asg-table-area">
          <div className="asg-pane-head" style={{ marginBottom: 8 }}>
            <div>
              <span className="asg-pane-kicker">Event delivery</span>
              <h3>Event Subscriptions</h3>
            </div>
            <span className="asg-pane-summary">{eventSubscriptions.length} total</span>
          </div>
          <input
            className="svc-search asg-search"
            placeholder="Filter subscriptions..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <table className="svc-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Topic</th>
                <th>Destination Type</th>
                <th>Delivery Schema</th>
                <th>Retry Attempts</th>
                <th>TTL (min)</th>
                <th>Labels</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {filteredSubscriptions.map((s) => (
                <tr key={s.id}>
                  <td><strong>{trunc(s.name, 32)}</strong></td>
                  <td>{trunc(s.topicName, 28)}</td>
                  <td>{s.destinationType || '-'}</td>
                  <td>{s.eventDeliverySchema || '-'}</td>
                  <td>{s.retryMaxDeliveryAttempts}</td>
                  <td>{s.eventTimeToLiveInMinutes}</td>
                  <td>{s.labels.length ? trunc(s.labels.join(', '), 30) : '-'}</td>
                  <td>{provisionBadge(s.provisioningState)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredSubscriptions.length && <div className="svc-empty">No event subscriptions found.</div>}
          <div style={{ color: '#9ca7b7', fontSize: 11, padding: '8px 4px' }}>
            Showing subscription-level event subscriptions. Topic-scoped subscriptions are listed under individual topics in the Azure Portal.
          </div>
        </div>
      )}
    </div>
  )
}
