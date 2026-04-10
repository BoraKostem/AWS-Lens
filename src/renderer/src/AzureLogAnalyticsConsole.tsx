import { useEffect, useMemo, useRef, useState } from 'react'
import './autoscaling.css'
import './azure-log-analytics.css'

import type {
  AzureLogAnalyticsWorkspaceSummary,
  AzureLogAnalyticsQueryResult,
  AzureLogAnalyticsSavedSearch,
  AzureLogAnalyticsLinkedService
} from '@shared/types'
import {
  listAzureLogAnalyticsWorkspaces,
  queryAzureLogAnalytics,
  listAzureLogAnalyticsSavedSearches,
  listAzureLogAnalyticsLinkedServices
} from './api'
import { SvcState } from './SvcState'

/* ── Helpers ──────────────────────────────────────────────── */

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s
}

function normalizeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/* ── Query presets ────────────────────────────────────────── */

const QUERY_PRESETS: Array<{ label: string; query: string }> = [
  {
    label: 'Heartbeat',
    query: 'Heartbeat | summarize count() by Computer | top 10 by count_'
  },
  {
    label: 'Errors',
    query: 'Event | where EventLevelName == "Error" | top 100 by TimeGenerated'
  },
  {
    label: 'Perf',
    query:
      'Perf | where ObjectName == "Processor" | summarize avg(CounterValue) by Computer, bin(TimeGenerated, 5m)'
  },
  {
    label: 'Security',
    query: 'SecurityEvent | summarize count() by Activity | top 20 by count_'
  }
]

const TIMESPAN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'PT1H', label: 'Last 1 hour' },
  { value: 'PT4H', label: 'Last 4 hours' },
  { value: 'PT12H', label: 'Last 12 hours' },
  { value: 'P1D', label: 'Last 1 day' },
  { value: 'P3D', label: 'Last 3 days' },
  { value: 'P7D', label: 'Last 7 days' }
]

/* ── Tab types ────────────────────────────────────────────── */

type TabId = 'workspaces' | 'query' | 'savedSearches' | 'linkedServices'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'query', label: 'Query' },
  { id: 'savedSearches', label: 'Saved Searches' },
  { id: 'linkedServices', label: 'Linked Services' }
]

/* ── Component ────────────────────────────────────────────── */

export function AzureLogAnalyticsConsole({
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
  /* ── Primary state ── */
  const [workspaces, setWorkspaces] = useState<AzureLogAnalyticsWorkspaceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<TabId>('workspaces')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [filter, setFilter] = useState('')

  /* ── Query state ── */
  const [queryText, setQueryText] = useState('')
  const [queryTimespan, setQueryTimespan] = useState('PT12H')
  const [queryResult, setQueryResult] = useState<AzureLogAnalyticsQueryResult | null>(null)
  const [queryLoading, setQueryLoading] = useState(false)
  const [queryError, setQueryError] = useState('')
  const [queryWorkspaceId, setQueryWorkspaceId] = useState('')
  const queryStartRef = useRef<number>(0)

  /* ── Saved searches & linked services (lazy-loaded) ── */
  const [savedSearches, setSavedSearches] = useState<AzureLogAnalyticsSavedSearch[]>([])
  const [linkedServices, setLinkedServices] = useState<AzureLogAnalyticsLinkedService[]>([])
  const [savedSearchLoading, setSavedSearchLoading] = useState(false)
  const [linkedServiceLoading, setLinkedServiceLoading] = useState(false)
  const [savedSearchError, setSavedSearchError] = useState('')
  const [linkedServiceError, setLinkedServiceError] = useState('')

  /* ── Derived ── */
  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId]
  )

  const filtered = useMemo(() => {
    if (!filter) return workspaces
    const q = filter.toLowerCase()
    return workspaces.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.resourceGroup.toLowerCase().includes(q) ||
        w.location.toLowerCase().includes(q) ||
        w.skuName.toLowerCase().includes(q)
    )
  }, [workspaces, filter])

  const avgRetention = useMemo(() => {
    if (!workspaces.length) return 0
    return Math.round(workspaces.reduce((sum, w) => sum + w.retentionInDays, 0) / workspaces.length)
  }, [workspaces])

  const skuBreakdown = useMemo(() => {
    const map: Record<string, number> = {}
    for (const w of workspaces) {
      const key = w.skuName || 'Unknown'
      map[key] = (map[key] || 0) + 1
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([sku, count]) => `${sku} (${count})`)
      .join(', ')
  }, [workspaces])

  /* ── Data fetching: workspaces ── */

  function doRefresh(): void {
    setLoading(true)
    setError('')
    listAzureLogAnalyticsWorkspaces(subscriptionId, location)
      .then(setWorkspaces)
      .catch((e) => setError(normalizeError(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    listAzureLogAnalyticsWorkspaces(subscriptionId, location)
      .then((next) => {
        if (!cancelled) setWorkspaces(next)
      })
      .catch((e) => {
        if (!cancelled) setError(normalizeError(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [subscriptionId, location, refreshNonce])

  /* ── Auto-select query workspace when workspaces load ── */
  useEffect(() => {
    if (workspaces.length && !queryWorkspaceId) {
      setQueryWorkspaceId(workspaces[0].id)
    }
  }, [workspaces, queryWorkspaceId])

  /* ── Lazy-load saved searches when tab opens + workspace selected ── */
  useEffect(() => {
    if (activeTab !== 'savedSearches' || !selectedWorkspace) {
      return
    }
    let cancelled = false
    setSavedSearchLoading(true)
    setSavedSearchError('')
    listAzureLogAnalyticsSavedSearches(
      subscriptionId,
      selectedWorkspace.resourceGroup,
      selectedWorkspace.name
    )
      .then((next) => {
        if (!cancelled) setSavedSearches(next)
      })
      .catch((e) => {
        if (!cancelled) setSavedSearchError(normalizeError(e))
      })
      .finally(() => {
        if (!cancelled) setSavedSearchLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, selectedWorkspace?.id, subscriptionId])

  /* ── Lazy-load linked services when tab opens + workspace selected ── */
  useEffect(() => {
    if (activeTab !== 'linkedServices' || !selectedWorkspace) {
      return
    }
    let cancelled = false
    setLinkedServiceLoading(true)
    setLinkedServiceError('')
    listAzureLogAnalyticsLinkedServices(
      subscriptionId,
      selectedWorkspace.resourceGroup,
      selectedWorkspace.name
    )
      .then((next) => {
        if (!cancelled) setLinkedServices(next)
      })
      .catch((e) => {
        if (!cancelled) setLinkedServiceError(normalizeError(e))
      })
      .finally(() => {
        if (!cancelled) setLinkedServiceLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab, selectedWorkspace?.id, subscriptionId])

  /* ── Query execution ── */
  function runQuery(): void {
    if (!queryWorkspaceId || !queryText.trim()) return
    const ws = workspaces.find((w) => w.id === queryWorkspaceId)
    if (!ws) return

    setQueryLoading(true)
    setQueryError('')
    setQueryResult(null)
    queryStartRef.current = Date.now()

    queryAzureLogAnalytics(ws.workspaceId, queryText.trim(), queryTimespan)
      .then((result) => {
        if (result.error) {
          setQueryError(result.error)
        } else {
          setQueryResult(result)
        }
      })
      .catch((e) => setQueryError(normalizeError(e)))
      .finally(() => setQueryLoading(false))
  }

  function applyPreset(query: string): void {
    setQueryText(query)
  }

  function handleQueryKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      runQuery()
    }
    /* Allow Tab for indentation in the editor */
    if (e.key === 'Tab') {
      e.preventDefault()
      const target = e.currentTarget
      const start = target.selectionStart
      const end = target.selectionEnd
      const value = target.value
      setQueryText(value.substring(0, start) + '    ' + value.substring(end))
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 4
      })
    }
  }

  /* ── Loading state ── */
  if (loading && !workspaces.length) {
    return <SvcState variant="loading" message="Loading Log Analytics workspaces..." />
  }

  /* ── Render ── */
  return (
    <div className="svc-console asg-console azure-log-analytics-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Azure Monitor</div>
          <h2>Log Analytics</h2>
          <p>
            Query and analyze log data from Azure resources with KQL, manage
            workspaces, saved searches, and linked services.
          </p>
          <div className="asg-meta-strip">
            <div className="asg-meta-pill">
              <span>Subscription</span>
              <strong>{trunc(subscriptionId, 20)}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Location</span>
              <strong>{location || 'all'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Workspaces</span>
            <strong>{workspaces.length}</strong>
            <small>Log Analytics workspaces discovered.</small>
          </div>
          <div className="asg-stat-card">
            <span>Avg Retention</span>
            <strong>{avgRetention}d</strong>
            <small>Average retention across workspaces.</small>
          </div>
          <div className="asg-stat-card">
            <span>SKU Breakdown</span>
            <strong>{workspaces.length ? trunc(skuBreakdown, 18) : '-'}</strong>
            <small>{skuBreakdown || 'No workspaces.'}</small>
          </div>
          <div className="asg-stat-card">
            <span>Selected</span>
            <strong>{selectedWorkspace ? trunc(selectedWorkspace.name, 16) : '-'}</strong>
            <small>
              {selectedWorkspace
                ? `${selectedWorkspace.skuName} \u2022 ${selectedWorkspace.retentionInDays}d retention`
                : 'Select a workspace to inspect.'}
            </small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ────────────────────────────────────────── */}
      <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`svc-tab ${activeTab === t.id ? 'active' : ''}`}
            type="button"
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            {t.id === 'workspaces' ? ` (${workspaces.length})` : ''}
            {t.id === 'savedSearches' && savedSearches.length
              ? ` (${savedSearches.length})`
              : ''}
            {t.id === 'linkedServices' && linkedServices.length
              ? ` (${linkedServices.length})`
              : ''}
          </button>
        ))}
        <button className="svc-tab right" type="button" onClick={doRefresh}>
          Refresh
        </button>
      </div>

      {/* ── Workspaces tab ─────────────────────────────────── */}
      {activeTab === 'workspaces' && (
        <div className="asg-main-layout">
          {/* Left sidebar: workspace list */}
          <aside className="asg-groups-pane">
            <div className="asg-pane-head">
              <div>
                <span className="asg-pane-kicker">Discovered workspaces</span>
                <h3>Workspace inventory</h3>
              </div>
              <span className="asg-pane-summary">{workspaces.length} total</span>
            </div>
            <input
              className="svc-search asg-search"
              placeholder="Filter workspaces..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="asg-group-list">
              {filtered.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={`asg-group-card ${w.id === selectedWorkspaceId ? 'active' : ''}`}
                  onClick={() => setSelectedWorkspaceId(w.id)}
                >
                  <div className="asg-group-card-head">
                    <div className="asg-group-card-copy">
                      <strong>{w.name}</strong>
                      <span>{w.resourceGroup}</span>
                    </div>
                    <span
                      className={`svc-badge ${w.provisioningState === 'Succeeded' ? 'ok' : 'warn'}`}
                      style={{ fontSize: 10 }}
                    >
                      {w.provisioningState}
                    </span>
                  </div>
                  <div className="asg-group-card-metrics">
                    <div>
                      <span>SKU</span>
                      <strong>{w.skuName}</strong>
                    </div>
                    <div>
                      <span>Retain</span>
                      <strong>{w.retentionInDays}d</strong>
                    </div>
                    <div>
                      <span>Tags</span>
                      <strong>{w.tagCount}</strong>
                    </div>
                  </div>
                </button>
              ))}
              {!filtered.length && (
                <div className="svc-empty">No Log Analytics workspaces found.</div>
              )}
            </div>
          </aside>

          {/* Right detail pane */}
          <section className="asg-detail-pane">
            {selectedWorkspace ? (
              <>
                <section className="asg-detail-hero">
                  <div className="asg-detail-copy">
                    <div className="eyebrow">Selected workspace</div>
                    <h3>{selectedWorkspace.name}</h3>
                    <p>
                      Workspace configuration, retention settings, and network access
                      controls.
                    </p>
                    <div className="asg-meta-strip">
                      <div className="asg-meta-pill">
                        <span>SKU</span>
                        <strong>{selectedWorkspace.skuName}</strong>
                      </div>
                      <div className="asg-meta-pill">
                        <span>Retention</span>
                        <strong>{selectedWorkspace.retentionInDays} days</strong>
                      </div>
                      <div className="asg-meta-pill">
                        <span>Daily Quota</span>
                        <strong>
                          {selectedWorkspace.dailyQuotaGb > 0
                            ? `${selectedWorkspace.dailyQuotaGb} GB`
                            : 'Unlimited'}
                        </strong>
                      </div>
                    </div>
                  </div>
                  <div className="asg-detail-glance">
                    <div className="asg-stat-card">
                      <span>Retention</span>
                      <strong>{selectedWorkspace.retentionInDays}d</strong>
                      <small>Data retention period.</small>
                    </div>
                    <div className="asg-stat-card">
                      <span>Tags</span>
                      <strong>{selectedWorkspace.tagCount}</strong>
                      <small>Resource tags applied.</small>
                    </div>
                  </div>
                </section>

                {/* Properties table */}
                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Workspace configuration</span>
                        <h3>Properties</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr>
                          <td>Name</td>
                          <td>{selectedWorkspace.name}</td>
                        </tr>
                        <tr>
                          <td>Resource Group</td>
                          <td>{selectedWorkspace.resourceGroup}</td>
                        </tr>
                        <tr>
                          <td>Location</td>
                          <td>{selectedWorkspace.location}</td>
                        </tr>
                        <tr>
                          <td>SKU</td>
                          <td>{selectedWorkspace.skuName}</td>
                        </tr>
                        <tr>
                          <td>Retention</td>
                          <td>{selectedWorkspace.retentionInDays} days</td>
                        </tr>
                        <tr>
                          <td>Daily Quota</td>
                          <td>
                            {selectedWorkspace.dailyQuotaGb > 0
                              ? `${selectedWorkspace.dailyQuotaGb} GB`
                              : 'Unlimited'}
                          </td>
                        </tr>
                        <tr>
                          <td>Workspace ID</td>
                          <td>
                            <code style={{ wordBreak: 'break-all', fontSize: 11 }}>
                              {selectedWorkspace.workspaceId}
                            </code>
                          </td>
                        </tr>
                        <tr>
                          <td>Customer ID</td>
                          <td>
                            <code style={{ wordBreak: 'break-all', fontSize: 11 }}>
                              {selectedWorkspace.customerId}
                            </code>
                          </td>
                        </tr>
                        <tr>
                          <td>Ingestion Access</td>
                          <td>
                            <span
                              className={`svc-badge ${selectedWorkspace.publicNetworkAccessForIngestion.toLowerCase() === 'enabled' ? 'ok' : 'warn'}`}
                            >
                              {selectedWorkspace.publicNetworkAccessForIngestion}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td>Query Access</td>
                          <td>
                            <span
                              className={`svc-badge ${selectedWorkspace.publicNetworkAccessForQuery.toLowerCase() === 'enabled' ? 'ok' : 'warn'}`}
                            >
                              {selectedWorkspace.publicNetworkAccessForQuery}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td>Provisioning State</td>
                          <td>
                            <span
                              className={`svc-badge ${selectedWorkspace.provisioningState === 'Succeeded' ? 'ok' : 'warn'}`}
                            >
                              {selectedWorkspace.provisioningState}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td>Tags</td>
                          <td>{selectedWorkspace.tagCount} tag{selectedWorkspace.tagCount === 1 ? '' : 's'}</td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="svc-btn primary"
                        disabled={!canRunTerminalCommand}
                        onClick={() =>
                          onRunTerminalCommand(
                            `az monitor log-analytics workspace show --workspace-name "${selectedWorkspace.name}" --resource-group "${selectedWorkspace.resourceGroup}" --output table`
                          )
                        }
                      >
                        CLI details
                      </button>
                      {onOpenMonitor && (
                        <button
                          type="button"
                          className="svc-btn muted"
                          onClick={() =>
                            onOpenMonitor(
                              `Microsoft.OperationalInsights workspaces ${selectedWorkspace.name}`
                            )
                          }
                        >
                          Monitor
                        </button>
                      )}
                      <button
                        type="button"
                        className="svc-btn muted"
                        onClick={() => {
                          setQueryWorkspaceId(selectedWorkspace.id)
                          setActiveTab('query')
                        }}
                      >
                        Open in Query Editor
                      </button>
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <div className="asg-empty-state">
                <div className="eyebrow">No selection</div>
                <h3>Select a Workspace</h3>
                <p>
                  Choose a Log Analytics workspace from the inventory to inspect its
                  configuration, retention, and access settings.
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Query tab (KQL editor) ─────────────────────────── */}
      {activeTab === 'query' && (
        <div className="la-query-area">
          {/* Workspace selector + timespan */}
          <div className="la-query-controls">
            <label style={{ fontSize: 12, color: '#9ca7b7' }}>Workspace:</label>
            <select
              className="la-workspace-select"
              value={queryWorkspaceId}
              onChange={(e) => setQueryWorkspaceId(e.target.value)}
            >
              {!workspaces.length && <option value="">No workspaces</option>}
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.resourceGroup})
                </option>
              ))}
            </select>

            <label style={{ fontSize: 12, color: '#9ca7b7', marginLeft: 8 }}>
              Timespan:
            </label>
            <select
              className="la-timespan-select"
              value={queryTimespan}
              onChange={(e) => setQueryTimespan(e.target.value)}
            >
              {TIMESPAN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* KQL editor */}
          <textarea
            className="la-query-editor"
            placeholder="Enter a KQL query... (Ctrl+Enter to run)"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={handleQueryKeyDown}
            spellCheck={false}
            rows={10}
          />

          {/* Preset buttons + Run */}
          <div className="la-query-controls">
            <button
              type="button"
              className="svc-btn primary"
              disabled={queryLoading || !queryWorkspaceId || !queryText.trim()}
              onClick={runQuery}
            >
              {queryLoading ? 'Running...' : 'Run Query'}
            </button>

            <div style={{ width: 1, height: 20, background: '#3b4350', margin: '0 4px' }} />

            <span style={{ fontSize: 11, color: '#9ca7b7', marginRight: 4 }}>Presets:</span>
            <div className="la-query-presets">
              {QUERY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="la-query-preset-btn"
                  onClick={() => applyPreset(preset.query)}
                  title={preset.query}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Query loading */}
          {queryLoading && <SvcState variant="loading" message="Executing KQL query..." />}

          {/* Query error */}
          {queryError && !queryLoading && (
            <div className="la-query-error">{queryError}</div>
          )}

          {/* Query results */}
          {queryResult && !queryLoading && !queryError && (
            <>
              {/* Statistics */}
              <div className="la-query-stats">
                {queryResult.statistics?.query?.executionTime != null && (
                  <span>
                    Execution time:{' '}
                    <strong>{queryResult.statistics.query.executionTime.toFixed(2)}s</strong>
                  </span>
                )}
                {queryResult.tables.length > 0 && (
                  <span>
                    Tables: <strong>{queryResult.tables.length}</strong>
                  </span>
                )}
                {queryResult.tables.length > 0 && queryResult.tables[0].rows.length > 0 && (
                  <span>
                    Rows: <strong>{queryResult.tables[0].rows.length}</strong>
                  </span>
                )}
              </div>

              {/* Render each result table */}
              {queryResult.tables.map((table, tableIdx) => (
                <div key={`table-${tableIdx}`}>
                  {queryResult.tables.length > 1 && (
                    <div className="la-row-count">
                      Table: <strong>{table.name}</strong> &mdash; {table.rows.length} row
                      {table.rows.length === 1 ? '' : 's'}
                    </div>
                  )}

                  {table.rows.length > 0 ? (
                    <div className="la-results-table">
                      <table>
                        <thead>
                          <tr>
                            {table.columns.map((col, colIdx) => (
                              <th key={colIdx} title={`${col.name} (${col.type})`}>
                                {col.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {table.rows.map((row, rowIdx) => (
                            <tr key={rowIdx}>
                              {row.map((cell, cellIdx) => (
                                <td key={cellIdx} title={String(cell ?? '')}>
                                  {formatCell(cell)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="la-results-empty">
                      Query returned no rows for table &ldquo;{table.name}&rdquo;.
                    </div>
                  )}
                </div>
              ))}

              {queryResult.tables.length === 0 && (
                <div className="la-results-empty">Query returned no result tables.</div>
              )}
            </>
          )}

          {/* Empty state when no query has run */}
          {!queryResult && !queryLoading && !queryError && (
            <div className="la-empty-query">
              <strong>KQL Query Editor</strong>
              Enter a Kusto Query Language expression above and press{' '}
              <kbd style={{ background: '#1e232b', padding: '2px 6px', borderRadius: 3, fontSize: 11, border: '1px solid #3b4350' }}>
                Ctrl+Enter
              </kbd>{' '}
              or click <em>Run Query</em> to execute. Use the preset buttons to load
              common queries.
            </div>
          )}
        </div>
      )}

      {/* ── Saved Searches tab ─────────────────────────────── */}
      {activeTab === 'savedSearches' && (
        <div style={{ padding: 12 }}>
          {!selectedWorkspace && (
            <div className="asg-empty-state">
              <div className="eyebrow">No workspace selected</div>
              <h3>Select a Workspace First</h3>
              <p>
                Switch to the Workspaces tab and select a workspace, then return here
                to view its saved searches.
              </p>
            </div>
          )}

          {selectedWorkspace && savedSearchLoading && (
            <SvcState variant="loading" message="Loading saved searches..." />
          )}

          {selectedWorkspace && savedSearchError && !savedSearchLoading && (
            <div className="svc-error">{savedSearchError}</div>
          )}

          {selectedWorkspace && !savedSearchLoading && !savedSearchError && (
            <>
              <div style={{ marginBottom: 10 }}>
                <span className="asg-pane-kicker">
                  Saved searches for{' '}
                  <strong style={{ color: '#eef0f4' }}>{selectedWorkspace.name}</strong>
                </span>
              </div>

              {savedSearches.length > 0 ? (
                <div className="la-saved-search-grid">
                  {savedSearches.map((s) => (
                    <div key={s.id} className="la-saved-search-card">
                      <div className="la-saved-search-card-head">
                        <strong>{s.displayName || s.name}</strong>
                        <span className="svc-badge ok" style={{ fontSize: 10 }}>
                          {s.category}
                        </span>
                      </div>
                      <div className="la-saved-search-card-query" title={s.query}>
                        {trunc(s.query, 120)}
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          fontSize: 11,
                          color: '#7d8a9c'
                        }}
                      >
                        {s.functionAlias && (
                          <span>
                            Alias: <strong style={{ color: '#d0d8e2' }}>{s.functionAlias}</strong>
                          </span>
                        )}
                        {s.functionParameters && (
                          <span>
                            Params:{' '}
                            <strong style={{ color: '#d0d8e2' }}>
                              {trunc(s.functionParameters, 40)}
                            </strong>
                          </span>
                        )}
                      </div>
                      <div className="svc-btn-row" style={{ marginTop: 4 }}>
                        <button
                          type="button"
                          className="svc-btn muted"
                          style={{ fontSize: 11, padding: '3px 8px' }}
                          onClick={() => {
                            setQueryText(s.query)
                            setActiveTab('query')
                          }}
                        >
                          Load in Editor
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="svc-empty">No saved searches found for this workspace.</div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Linked Services tab ────────────────────────────── */}
      {activeTab === 'linkedServices' && (
        <div style={{ padding: 12 }}>
          {!selectedWorkspace && (
            <div className="asg-empty-state">
              <div className="eyebrow">No workspace selected</div>
              <h3>Select a Workspace First</h3>
              <p>
                Switch to the Workspaces tab and select a workspace, then return here
                to view its linked services.
              </p>
            </div>
          )}

          {selectedWorkspace && linkedServiceLoading && (
            <SvcState variant="loading" message="Loading linked services..." />
          )}

          {selectedWorkspace && linkedServiceError && !linkedServiceLoading && (
            <div className="svc-error">{linkedServiceError}</div>
          )}

          {selectedWorkspace && !linkedServiceLoading && !linkedServiceError && (
            <>
              <div style={{ marginBottom: 10 }}>
                <span className="asg-pane-kicker">
                  Linked services for{' '}
                  <strong style={{ color: '#eef0f4' }}>{selectedWorkspace.name}</strong>
                </span>
              </div>

              {linkedServices.length > 0 ? (
                <div className="la-linked-services-grid">
                  {linkedServices.map((ls) => (
                    <div key={ls.id} className="la-linked-service-card">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8
                        }}
                      >
                        <strong>{ls.name}</strong>
                        <span
                          className={`svc-badge ${ls.provisioningState === 'Succeeded' ? 'ok' : 'warn'}`}
                          style={{ fontSize: 10 }}
                        >
                          {ls.provisioningState}
                        </span>
                      </div>
                      {ls.resourceId && (
                        <code style={{ fontSize: 11, color: '#7d8a9c', wordBreak: 'break-all' }}>
                          {ls.resourceId}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="svc-empty">No linked services found for this workspace.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Cell formatting helper ───────────────────────────────── */

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') {
    /* Try to format ISO dates inline */
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const d = new Date(value)
      if (!Number.isNaN(d.valueOf())) return d.toLocaleString()
    }
    return value
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(4)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  /* Objects / arrays: compact JSON */
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
