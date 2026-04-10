import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'
import './azure-cosmosdb.css'

import type {
  AzureCosmosDbAccountSummary,
  AzureCosmosDbDatabaseSummary,
  AzureCosmosDbContainerSummary,
  AzureCosmosDbEstateOverview,
  AzureCosmosDbAccountDetail,
  AzureMonitorActivityEvent
} from '@shared/types'
import {
  getAzureCosmosDbEstate,
  describeAzureCosmosDbAccount,
  listAzureMonitorActivity
} from './api'
import { SvcState } from './SvcState'

type ConsoleTab = 'accounts' | 'databases' | 'containers' | 'activity'

function trunc(value: string, max = 28): string {
  if (!value) return '-'
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`
}

function normalizeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function boolBadge(value: boolean, trueLabel = 'Enabled', falseLabel = 'Disabled'): JSX.Element {
  return <span className={`svc-badge ${value ? 'ok' : 'danger'}`}>{value ? trueLabel : falseLabel}</span>
}

export function AzureCosmosDbConsole({
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
  const [estate, setEstate] = useState<AzureCosmosDbEstateOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<ConsoleTab>('accounts')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [accountDetail, setAccountDetail] = useState<AzureCosmosDbAccountDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [filter, setFilter] = useState('')

  const [timelineEvents, setTimelineEvents] = useState<AzureMonitorActivityEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')

  const accounts = estate?.accounts ?? []

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId]
  )

  const filteredAccounts = useMemo(() => {
    if (!filter) return accounts
    const q = filter.toLowerCase()
    return accounts.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.resourceGroup.toLowerCase().includes(q) ||
      a.location.toLowerCase().includes(q) ||
      a.kind.toLowerCase().includes(q)
    )
  }, [accounts, filter])

  const databases = accountDetail?.databases ?? []
  const containers = accountDetail?.containers ?? []

  /* ── Data fetching ── */

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    getAzureCosmosDbEstate(subscriptionId, location)
      .then((data) => {
        if (cancelled) return
        setEstate(data)
        if (data.accounts.length && !selectedAccountId) {
          setSelectedAccountId(data.accounts[0].id)
        }
      })
      .catch((err) => { if (!cancelled) setError(normalizeError(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  useEffect(() => {
    if (!selectedAccount) {
      setAccountDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    describeAzureCosmosDbAccount(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name)
      .then((detail) => { if (!cancelled) setAccountDetail(detail) })
      .catch((err) => { if (!cancelled) setError(normalizeError(err)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedAccount?.id, subscriptionId])

  useEffect(() => {
    if (activeTab !== 'activity' || !selectedAccount) return
    let cancelled = false
    setTimelineLoading(true)
    setTimelineError('')
    listAzureMonitorActivity(subscriptionId, location, `Microsoft.DocumentDB|${selectedAccount.name}`, 168)
      .then((result) => { if (!cancelled) setTimelineEvents(result.events) })
      .catch((err) => {
        if (!cancelled) {
          setTimelineEvents([])
          setTimelineError(normalizeError(err))
        }
      })
      .finally(() => { if (!cancelled) setTimelineLoading(false) })
    return () => { cancelled = true }
  }, [activeTab, selectedAccount?.id, subscriptionId, location])

  function selectAccount(id: string) {
    setSelectedAccountId(id)
    setTimelineEvents([])
    setTimelineError('')
  }

  /* ── Loading / error states ── */

  if (loading && !estate) return <SvcState variant="loading" resourceName="Cosmos DB accounts" />
  if (error && !estate) return <SvcState variant="error" error={error} />

  /* ── Render ── */

  return (
    <div className="svc-console asg-console azure-cosmosdb-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Azure Cosmos DB</div>
          <h2>Cosmos DB</h2>
          <p>Globally distributed, multi-model database service with turnkey global distribution, elastic scaling, and low-latency data access.</p>
          <div className="asg-meta-strip">
            <div className="asg-meta-pill">
              <span>Subscription</span>
              <strong>{trunc(subscriptionId, 20)}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Location</span>
              <strong>{location || 'all'}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Selected account</span>
              <strong>{selectedAccount?.name || 'None selected'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Accounts</span>
            <strong>{estate?.accountCount ?? 0}</strong>
            <small>Cosmos DB accounts discovered in the active location.</small>
          </div>
          <div className="asg-stat-card">
            <span>Databases</span>
            <strong>{estate?.databaseCount ?? 0}</strong>
            <small>Total databases across all accounts.</small>
          </div>
          <div className="asg-stat-card">
            <span>Containers</span>
            <strong>{estate?.containerCount ?? 0}</strong>
            <small>Total containers across all accounts.</small>
          </div>
          <div className="asg-stat-card">
            <span>Detail</span>
            <strong>{selectedAccount ? (detailLoading ? '...' : `${databases.length} db / ${containers.length} ctr`) : '-'}</strong>
            <small>{selectedAccount ? 'Databases and containers for selected account.' : 'Select an account to view.'}</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ── */}
      <div className="svc-tab-bar">
        {(['accounts', 'databases', 'containers', 'activity'] as ConsoleTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={activeTab === tab ? 'active' : ''}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'accounts' ? 'Accounts' : tab === 'databases' ? 'Databases' : tab === 'containers' ? 'Containers' : 'Activity'}
          </button>
        ))}
      </div>

      {estate?.notes && estate.notes.length > 0 && (
        <div className="svc-info">{estate.notes.join(' ')}</div>
      )}

      <div className="asg-main-layout">
        {/* ── Left sidebar: account list ── */}
        <aside className="asg-groups-pane">
          <div className="asg-pane-head">
            <div>
              <span className="asg-pane-kicker">Discovered accounts</span>
              <h3>Account inventory</h3>
            </div>
            <span className="asg-pane-summary">{accounts.length} total</span>
          </div>
          <input
            className="svc-search asg-search"
            placeholder="Filter accounts..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="asg-group-list">
            {filteredAccounts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`asg-group-card ${a.id === selectedAccountId ? 'active' : ''}`}
                onClick={() => selectAccount(a.id)}
              >
                <div className="asg-group-card-head">
                  <div className="asg-group-card-copy">
                    <strong>{a.name}</strong>
                    <span>{a.kind}</span>
                  </div>
                  <span className={`svc-badge ${a.provisioningState === 'Succeeded' ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>{a.provisioningState}</span>
                </div>
                <div className="asg-group-card-metrics">
                  <div>
                    <span>Consistency</span>
                    <strong>{trunc(a.consistencyLevel, 12)}</strong>
                  </div>
                  <div>
                    <span>Failover</span>
                    <strong>{a.enableAutomaticFailover ? 'Auto' : 'Manual'}</strong>
                  </div>
                  <div>
                    <span>Multi-Write</span>
                    <strong>{a.enableMultipleWriteLocations ? 'Yes' : 'No'}</strong>
                  </div>
                </div>
              </button>
            ))}
            {!filteredAccounts.length && <div className="svc-empty">No Cosmos DB accounts found.</div>}
          </div>
        </aside>

        {/* ── Right pane: tab content ── */}
        <section className="asg-detail-pane">
          {/* ── Accounts tab ── */}
          {activeTab === 'accounts' && (
            <>
              {selectedAccount ? (
                <>
                  <section className="asg-detail-hero">
                    <div className="asg-detail-copy">
                      <div className="eyebrow">Selected account</div>
                      <h3>{selectedAccount.name}</h3>
                      <p>Configuration, replication topology, and network posture for the active Cosmos DB account.</p>
                      <div className="asg-meta-strip">
                        <div className="asg-meta-pill">
                          <span>Kind</span>
                          <strong>{selectedAccount.kind}</strong>
                        </div>
                        <div className="asg-meta-pill">
                          <span>Consistency</span>
                          <strong>{selectedAccount.consistencyLevel}</strong>
                        </div>
                        <div className="asg-meta-pill">
                          <span>Offer Type</span>
                          <strong>{selectedAccount.databaseAccountOfferType}</strong>
                        </div>
                        <div className="asg-meta-pill">
                          <span>Provisioning</span>
                          <strong>{selectedAccount.provisioningState}</strong>
                        </div>
                      </div>
                    </div>
                  </section>

                  {detailLoading && <SvcState variant="loading" resourceName="account detail" compact />}

                  <div className="asg-detail-section">
                    <h3>Account Configuration</h3>
                    <div className="asg-kv-grid">
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">Kind</span>
                        <span className="asg-kv-value">{selectedAccount.kind}</span>
                      </div>
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">Consistency Level</span>
                        <span className="asg-kv-value">{selectedAccount.consistencyLevel}</span>
                      </div>
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">Automatic Failover</span>
                        <span className="asg-kv-value">{boolBadge(selectedAccount.enableAutomaticFailover)}</span>
                      </div>
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">Multi-region Writes</span>
                        <span className="asg-kv-value">{boolBadge(selectedAccount.enableMultipleWriteLocations)}</span>
                      </div>
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">Public Network Access</span>
                        <span className="asg-kv-value">{selectedAccount.publicNetworkAccess || '-'}</span>
                      </div>
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">VNet Filter</span>
                        <span className="asg-kv-value">{boolBadge(selectedAccount.isVirtualNetworkFilterEnabled)}</span>
                      </div>
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">Provisioning State</span>
                        <span className="asg-kv-value">{selectedAccount.provisioningState}</span>
                      </div>
                      <div className="asg-kv-row">
                        <span className="asg-kv-label">Tags</span>
                        <span className="asg-kv-value">{selectedAccount.tagCount} tag{selectedAccount.tagCount !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                  </div>

                  <div className="asg-detail-section">
                    <h3>Read Locations</h3>
                    {selectedAccount.readLocations.length > 0 ? (
                      <div className="asg-chip-list">
                        {selectedAccount.readLocations.map((loc) => (
                          <span key={loc} className="asg-chip">{loc}</span>
                        ))}
                      </div>
                    ) : (
                      <div className="svc-empty">No read locations reported.</div>
                    )}
                  </div>

                  <div className="asg-detail-section">
                    <h3>Write Locations</h3>
                    {selectedAccount.writeLocations.length > 0 ? (
                      <div className="asg-chip-list">
                        {selectedAccount.writeLocations.map((loc) => (
                          <span key={loc} className="asg-chip">{loc}</span>
                        ))}
                      </div>
                    ) : (
                      <div className="svc-empty">No write locations reported.</div>
                    )}
                  </div>

                  <div className="asg-detail-section">
                    <h3>Document Endpoint</h3>
                    <code className="asg-code-block">{selectedAccount.documentEndpoint || 'N/A'}</code>
                  </div>

                  <div className="asg-detail-section">
                    <h3>Actions</h3>
                    <div className="asg-actions-grid">
                      <button
                        className="asg-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az cosmosdb show -g "${selectedAccount.resourceGroup}" -n "${selectedAccount.name}" --subscription "${subscriptionId}" --output jsonc`)}
                      >
                        Account Snapshot
                      </button>
                      <button
                        className="asg-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az cosmosdb sql database list -g "${selectedAccount.resourceGroup}" -a "${selectedAccount.name}" --subscription "${subscriptionId}" --output table`)}
                      >
                        List Databases
                      </button>
                      <button
                        className="asg-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az cosmosdb keys list -g "${selectedAccount.resourceGroup}" -n "${selectedAccount.name}" --subscription "${subscriptionId}" --output jsonc`)}
                      >
                        List Keys
                      </button>
                      <button
                        className="asg-action-btn"
                        type="button"
                        onClick={() => onOpenMonitor(`Microsoft.DocumentDB ${selectedAccount.name}`)}
                      >
                        Open Monitor
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <SvcState variant="no-selection" resourceName="account" message="Select a Cosmos DB account to inspect its configuration." />
              )}
            </>
          )}

          {/* ── Databases tab ── */}
          {activeTab === 'databases' && (
            <>
              {!selectedAccount && (
                <SvcState variant="no-selection" resourceName="account" message="Select an account from the sidebar to view its databases." />
              )}
              {selectedAccount && detailLoading && (
                <SvcState variant="loading" resourceName="databases" compact />
              )}
              {selectedAccount && !detailLoading && databases.length === 0 && (
                <SvcState variant="empty" resourceName="databases" message="No databases found for this account." />
              )}
              {selectedAccount && !detailLoading && databases.length > 0 && (
                <div className="asg-detail-section">
                  <div className="asg-pane-head">
                    <div>
                      <span className="asg-pane-kicker">{selectedAccount.name}</span>
                      <h3>Database inventory</h3>
                    </div>
                    <span className="asg-pane-summary">{databases.length} databases</span>
                  </div>
                  <div className="asg-table-wrap">
                    <table className="asg-data-table">
                      <thead>
                        <tr>
                          <th>Database</th>
                          <th>Account</th>
                          <th>Resource Group</th>
                        </tr>
                      </thead>
                      <tbody>
                        {databases.map((db) => (
                          <tr key={db.id}>
                            <td>{db.name}</td>
                            <td>{db.accountName}</td>
                            <td>{db.resourceGroup}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Containers tab ── */}
          {activeTab === 'containers' && (
            <>
              {!selectedAccount && (
                <SvcState variant="no-selection" resourceName="account" message="Select an account from the sidebar to view its containers." />
              )}
              {selectedAccount && detailLoading && (
                <SvcState variant="loading" resourceName="containers" compact />
              )}
              {selectedAccount && !detailLoading && containers.length === 0 && (
                <SvcState variant="empty" resourceName="containers" message="No containers found for this account." />
              )}
              {selectedAccount && !detailLoading && containers.length > 0 && (
                <div className="asg-detail-section">
                  <div className="asg-pane-head">
                    <div>
                      <span className="asg-pane-kicker">{selectedAccount.name}</span>
                      <h3>Container inventory</h3>
                    </div>
                    <span className="asg-pane-summary">{containers.length} containers</span>
                  </div>
                  <div className="asg-table-wrap">
                    <table className="asg-data-table">
                      <thead>
                        <tr>
                          <th>Container</th>
                          <th>Database</th>
                          <th>Partition Key</th>
                          <th>Default TTL</th>
                          <th>Indexing Mode</th>
                        </tr>
                      </thead>
                      <tbody>
                        {containers.map((ctr) => (
                          <tr key={ctr.id}>
                            <td>{ctr.name}</td>
                            <td>{ctr.databaseName}</td>
                            <td><code>{ctr.partitionKeyPath || '-'}</code></td>
                            <td>{ctr.defaultTtl === -1 ? 'Off' : ctr.defaultTtl === 0 ? 'None' : `${ctr.defaultTtl}s`}</td>
                            <td>{ctr.indexingMode || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Activity tab ── */}
          {activeTab === 'activity' && (
            <div className="asg-detail-section">
              <h3>Azure Monitor Activity</h3>
              <p className="asg-section-hint">Management-plane events for <strong>{selectedAccount?.name ?? 'N/A'}</strong> from the last 7 days.</p>

              {!selectedAccount && (
                <SvcState variant="no-selection" resourceName="account" message="Select an account to view activity." />
              )}
              {selectedAccount && timelineLoading && (
                <SvcState variant="loading" resourceName="activity events" compact />
              )}
              {selectedAccount && !timelineLoading && timelineError && (
                <div className="svc-error">{timelineError}</div>
              )}
              {selectedAccount && !timelineLoading && !timelineError && timelineEvents.length === 0 && (
                <SvcState variant="empty" resourceName="activity events" message="No Azure Monitor events found for this account." />
              )}
              {selectedAccount && !timelineLoading && timelineEvents.length > 0 && (
                <div className="asg-table-wrap">
                  <table className="asg-data-table">
                    <thead>
                      <tr>
                        <th>Operation</th>
                        <th>Status</th>
                        <th>Caller</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timelineEvents.map((event) => (
                        <tr key={event.id}>
                          <td title={event.resourceType}>{event.operationName}</td>
                          <td>{event.status}</td>
                          <td>{trunc(event.caller, 24)}</td>
                          <td>{event.timestamp ? new Date(event.timestamp).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
