import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type {
  AzureCostOverview,
  AzureMonitorActivityEvent,
  AzureMonitorActivityResult
} from '@shared/types'
import { getAzureCostOverview, listAzureMonitorActivity } from './api'
import { SvcState } from './SvcState'

export { AzureSqlConsole } from './AzureSqlConsole'

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2
    }).format(amount)
  } catch {
    return `${currency || 'USD'} ${amount.toFixed(2)}`
  }
}

function formatDateTime(value: string): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function inferAzureServiceFromMonitor(resourceType: string): 'azure-virtual-machines' | 'azure-aks' | 'azure-storage-accounts' | 'azure-sql' | 'azure-rbac' | null {
  const normalized = resourceType.trim().toLowerCase()
  if (normalized.includes('microsoft.compute')) return 'azure-virtual-machines'
  if (normalized.includes('microsoft.containerservice')) return 'azure-aks'
  if (normalized.includes('microsoft.storage')) return 'azure-storage-accounts'
  if (normalized.includes('microsoft.sql')) return 'azure-sql'
  if (normalized.includes('microsoft.authorization')) return 'azure-rbac'
  return null
}

/* ─── Azure Monitor types & helpers ─── */

type MonitorTimeRange = 1 | 3 | 12 | 24 | 72 | 168
type MonitorTab = { type: 'overview' } | { type: 'event-detail'; eventId: string; label: string }

interface MonitorSavedQuery {
  id: string
  name: string
  description: string
  query: string
  createdAt: string
  lastRunAt: string
}

interface MonitorQueryHistoryEntry {
  id: string
  query: string
  executedAt: string
  durationMs: number
  status: 'success' | 'failed'
  resultSummary: string
}

const MONITOR_TIME_RANGES: { value: MonitorTimeRange; label: string }[] = [
  { value: 1, label: '1 hour' },
  { value: 3, label: '3 hours' },
  { value: 12, label: '12 hours' },
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' }
]

const MONITOR_PRESETS: { id: string; label: string; query: string }[] = [
  { id: 'all', label: 'All', query: '' },
  { id: 'failed', label: 'Failed', query: 'Failed' },
  { id: 'succeeded', label: 'Succeeded', query: 'Succeeded' },
  { id: 'warning', label: 'Warning', query: 'Warning' },
  { id: 'compute', label: 'Compute', query: 'Microsoft.Compute' },
  { id: 'storage', label: 'Storage', query: 'Microsoft.Storage' }
]

function eventSeverity(event: AzureMonitorActivityEvent): string {
  const status = event.status.toLowerCase()
  const level = event.level.toLowerCase()
  if (status.includes('failed') || level.includes('error') || level.includes('critical')) return 'error'
  if (level.includes('warning') || status.includes('warning')) return 'warn'
  if (level.includes('informational') || status.includes('succeeded') || status.includes('started') || status.includes('accepted')) return 'info'
  return 'debug'
}

function formatCompactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function persistToStorage<T>(key: string, data: T): void {
  try { window.localStorage.setItem(key, JSON.stringify(data)) } catch { /* ignore */ }
}

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

/* ─── Sub-components ─── */

function MonitorFilterableTable<T extends Record<string, unknown>>({
  columns,
  data,
  onDoubleClick,
  hint
}: {
  columns: { key: string; label: string; render?: (row: T) => string; renderNode?: (row: T) => ReactNode }[]
  data: T[]
  onDoubleClick?: (row: T) => void
  hint?: string
}) {
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => {
    if (!filter) return data
    const needle = filter.toLowerCase()
    return data.filter((row) => columns.some((col) => {
      const value = col.render ? col.render(row) : String(row[col.key] ?? '')
      return value.toLowerCase().includes(needle)
    }))
  }, [columns, data, filter])

  return (
    <div className="cw-table-section">
      <input className="cw-table-filter" placeholder="Filter rows..." value={filter} onChange={(event) => setFilter(event.target.value)} />
      <div className="cw-column-chips">{columns.map((col) => <span key={col.key} className="cw-chip">{col.label}</span>)}</div>
      {hint && <p className="cw-table-hint">{hint}</p>}
      <div className="cw-table-scroll">
        <table className="cw-table">
          <thead><tr>{columns.map((col) => <th key={col.key}>{col.label}</th>)}</tr></thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td className="cw-empty" colSpan={columns.length}>No data</td></tr>
            ) : filtered.map((row, index) => (
              <tr key={index} onDoubleClick={onDoubleClick ? () => onDoubleClick(row) : undefined} className={onDoubleClick ? 'cw-clickable' : ''}>
                {columns.map((col) => <td key={col.key}>{col.renderNode ? col.renderNode(row) : col.render ? col.render(row) : String(row[col.key] ?? '-')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EventDetailViewer({
  event,
  correlatedEvents,
  onOpenService,
  onOpenDirectAccess,
  onOpenCompliance,
  onRunTerminalCommand,
  canRunTerminalCommand,
  subscriptionId
}: {
  event: AzureMonitorActivityEvent
  correlatedEvents: AzureMonitorActivityEvent[]
  onOpenService: (serviceId: 'azure-virtual-machines' | 'azure-aks' | 'azure-storage-accounts' | 'azure-sql' | 'azure-rbac') => void
  onOpenDirectAccess: () => void
  onOpenCompliance: () => void
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  subscriptionId: string
}) {
  const [search, setSearch] = useState('')
  const relatedService = inferAzureServiceFromMonitor(event.resourceType)

  const filteredCorrelated = useMemo(() => {
    if (!search) return correlatedEvents
    const needle = search.toLowerCase()
    return correlatedEvents.filter((e) =>
      e.operationName.toLowerCase().includes(needle) ||
      e.status.toLowerCase().includes(needle) ||
      e.resourceGroup.toLowerCase().includes(needle) ||
      e.summary.toLowerCase().includes(needle)
    )
  }, [correlatedEvents, search])

  return (
    <div className="cw-log-viewer">
      <div className="cw-log-viewer-header">
        <div>
          <h3>{event.operationName}</h3>
          <span className="cw-log-count">{event.status} | {event.level} | {formatDateTime(event.timestamp)}</span>
        </div>
        <div className="cw-query-actions" style={{ gap: 8 }}>
          {relatedService ? <button type="button" className="cw-expand-btn" onClick={() => onOpenService(relatedService)}>Open service</button> : null}
          <button type="button" className="cw-expand-btn" onClick={onOpenDirectAccess}>Direct access</button>
          <button type="button" className="cw-expand-btn" onClick={onOpenCompliance}>Compliance</button>
        </div>
      </div>

      <div className="cw-section">
        <div className="cw-section-head"><div><h3>Event Attributes</h3><p className="cw-section-subtitle">Full metadata for the selected activity event.</p></div></div>
        <div className="cw-table-scroll">
          <table className="cw-table">
            <thead><tr><th>Attribute</th><th>Value</th></tr></thead>
            <tbody>
              <tr><td>Operation</td><td>{event.operationName}</td></tr>
              <tr><td>Status</td><td>{event.status}</td></tr>
              <tr><td>Level</td><td>{event.level}</td></tr>
              <tr><td>Timestamp</td><td>{formatDateTime(event.timestamp)}</td></tr>
              <tr><td>Resource Group</td><td>{event.resourceGroup || '-'}</td></tr>
              <tr><td>Resource Type</td><td>{event.resourceType || '-'}</td></tr>
              <tr><td>Resource ID</td><td>{event.resourceId || '-'}</td></tr>
              <tr><td>Caller</td><td>{event.caller || '-'}</td></tr>
              <tr><td>Correlation ID</td><td>{event.correlationId || '-'}</td></tr>
              <tr><td>Summary</td><td>{event.summary || 'No sub-status provided'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {correlatedEvents.length > 1 && (
        <div className="cw-section">
          <div className="cw-section-head"><div><h3>Correlated Events</h3><p className="cw-section-subtitle">{filteredCorrelated.length} events sharing correlation ID {event.correlationId}</p></div></div>
          <div className="cw-log-controls">
            <input className="cw-table-filter" placeholder="Search correlated events..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="cw-log-entries">
            {filteredCorrelated.map((e, i) => (
              <div key={`${e.id}-${i}`} className={`cw-log-entry cw-severity-${eventSeverity(e)}`}>
                <div className="cw-log-entry-header">
                  <span className="cw-log-time">{formatDateTime(e.timestamp)}</span>
                  <span className="cw-log-stream">{e.status} | {e.resourceGroup || 'no-rg'}</span>
                </div>
                <pre className="cw-log-message">{e.operationName}{e.summary ? `\n${e.summary}` : ''}</pre>
              </div>
            ))}
            {filteredCorrelated.length === 0 && <div className="cw-empty-logs">No correlated events found.</div>}
          </div>
        </div>
      )}

      <div className="cw-section">
        <div className="cw-section-head"><div><h3>Terminal Handoff</h3><p className="cw-section-subtitle">Run follow-up investigations in the integrated terminal.</p></div></div>
        <div className="cw-query-actions">
          <button type="button" className="cw-toggle" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az monitor activity-log list --subscription "${subscriptionId}" --correlation-id "${event.correlationId}" --output jsonc`)}>Query correlation</button>
          {event.resourceId ? <button type="button" className="cw-toggle" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az resource show --ids "${event.resourceId}" --output jsonc`)}>Inspect resource</button> : null}
          <button type="button" className="cw-toggle" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az monitor activity-log list --subscription "${subscriptionId}" --resource-group "${event.resourceGroup}" --offset 24h --max-events 30 --output jsonc`)}>Query resource group</button>
        </div>
      </div>
    </div>
  )
}

/* ─── Main component ─── */

export function AzureMonitorConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  initialQuery,
  seedToken,
  onOpenCompliance,
  onOpenDirectAccess,
  onOpenService
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  initialQuery: string
  seedToken: number
  onOpenCompliance: () => void
  onOpenDirectAccess: () => void
  onOpenService: (serviceId: 'azure-virtual-machines' | 'azure-aks' | 'azure-storage-accounts' | 'azure-sql' | 'azure-rbac') => void
}): JSX.Element {
  const savedKey = `cloud-lens:azure-monitor-saved:${subscriptionId}`
  const historyKey = `cloud-lens:azure-monitor-history:${subscriptionId}`

  const [timeRange, setTimeRange] = useState<MonitorTimeRange>(24)
  const [tabs, setTabs] = useState<MonitorTab[]>([{ type: 'overview' }])
  const [activeTabIndex, setActiveTabIndex] = useState(0)
  const [queryDraft, setQueryDraft] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [result, setResult] = useState<AzureMonitorActivityResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [queryBusy, setQueryBusy] = useState(false)
  const [queryFeedback, setQueryFeedback] = useState('')
  const [queryError, setQueryError] = useState('')
  const [savedQueries, setSavedQueries] = useState<MonitorSavedQuery[]>([])
  const [queryHistory, setQueryHistory] = useState<MonitorQueryHistoryEntry[]>([])
  const [saveName, setSaveName] = useState('')
  const [saveDescription, setSaveDescription] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const activeTab = tabs[activeTabIndex]

  /* ── Load saved queries (with migration from old string[] format) ── */
  useEffect(() => {
    const raw = loadFromStorage<unknown[]>(savedKey, [])
    if (raw.length > 0 && typeof raw[0] === 'string') {
      const migrated: MonitorSavedQuery[] = (raw as string[]).map((q, i) => ({
        id: `migrated-${i}-${Date.now()}`,
        name: q,
        description: '',
        query: q,
        createdAt: new Date().toISOString(),
        lastRunAt: ''
      }))
      setSavedQueries(migrated)
      persistToStorage(savedKey, migrated)
    } else {
      setSavedQueries(raw as MonitorSavedQuery[])
    }
  }, [savedKey])

  /* ── Load query history ── */
  useEffect(() => {
    setQueryHistory(loadFromStorage<MonitorQueryHistoryEntry[]>(historyKey, []))
  }, [historyKey])

  /* ── Apply initial query from prop ── */
  useEffect(() => {
    if (!initialQuery.trim()) return
    setQueryDraft(initialQuery)
    setAppliedQuery(initialQuery)
  }, [initialQuery, seedToken])

  /* ── Fetch activity events ── */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    void listAzureMonitorActivity(subscriptionId, location, appliedQuery, timeRange)
      .then((next) => {
        if (cancelled) return
        setResult(next)
      })
      .catch((err) => {
        if (cancelled) return
        setResult(null)
        setError(normalizeError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [appliedQuery, location, refreshNonce, subscriptionId, timeRange])

  /* ── Derived data ── */
  const filteredEvents = useMemo(() => {
    if (!result) return []
    if (statusFilter === 'all') return result.events
    return result.events.filter((e) => e.status.toLowerCase() === statusFilter.toLowerCase())
  }, [result, statusFilter])

  const distinctStatuses = useMemo(() => result?.statusCounts.map((f) => f.label) ?? [], [result])
  const topStatusCounts = useMemo(() => [...(result?.statusCounts ?? [])].sort((a, b) => b.count - a.count).slice(0, 8), [result])
  const topResourceTypeCounts = useMemo(() => [...(result?.resourceTypeCounts ?? [])].sort((a, b) => b.count - a.count).slice(0, 8), [result])
  const latestEventTimestamp = useMemo(() => result?.events[0]?.timestamp ?? '', [result])

  /* ── Actions ── */

  function runQuery(queryOverride?: string): void {
    const query = (queryOverride ?? queryDraft).trim()
    setQueryBusy(true)
    setQueryError('')
    setQueryFeedback('')
    const started = Date.now()

    void listAzureMonitorActivity(subscriptionId, location, query, timeRange)
      .then((next) => {
        setResult(next)
        setAppliedQuery(query)
        setQueryFeedback(`Query completed. ${next.events.length} events found across ${next.statusCounts.length} statuses and ${next.resourceTypeCounts.length} resource types.`)
        const entry: MonitorQueryHistoryEntry = {
          id: `history-${Date.now()}`,
          query,
          executedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          status: 'success',
          resultSummary: `${next.events.length} events, ${next.statusCounts.length} statuses`
        }
        const nextHistory = [entry, ...queryHistory].slice(0, 8)
        setQueryHistory(nextHistory)
        persistToStorage(historyKey, nextHistory)
      })
      .catch((err) => {
        const message = normalizeError(err)
        setQueryError(message)
        const entry: MonitorQueryHistoryEntry = {
          id: `history-${Date.now()}`,
          query,
          executedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          status: 'failed',
          resultSummary: message
        }
        const nextHistory = [entry, ...queryHistory].slice(0, 8)
        setQueryHistory(nextHistory)
        persistToStorage(historyKey, nextHistory)
      })
      .finally(() => setQueryBusy(false))
  }

  function saveCurrentQuery(): void {
    if (!saveName.trim()) { setQueryError('Provide a saved query name.'); return }
    const entry: MonitorSavedQuery = {
      id: `saved-${Date.now()}`,
      name: saveName.trim(),
      description: saveDescription.trim(),
      query: queryDraft.trim(),
      createdAt: new Date().toISOString(),
      lastRunAt: ''
    }
    const next = [entry, ...savedQueries].slice(0, 8)
    setSavedQueries(next)
    persistToStorage(savedKey, next)
    setSaveName('')
    setSaveDescription('')
    setQueryFeedback('Saved query stored.')
  }

  function deleteSavedQuery(id: string): void {
    const next = savedQueries.filter((q) => q.id !== id)
    setSavedQueries(next)
    persistToStorage(savedKey, next)
  }

  function loadAndRunSavedQuery(saved: MonitorSavedQuery): void {
    setQueryDraft(saved.query)
    const updated = savedQueries.map((q) => q.id === saved.id ? { ...q, lastRunAt: new Date().toISOString() } : q)
    setSavedQueries(updated)
    persistToStorage(savedKey, updated)
    runQuery(saved.query)
  }

  function clearHistory(): void {
    setQueryHistory([])
    persistToStorage(historyKey, [])
  }

  function openEventDetailTab(event: AzureMonitorActivityEvent): void {
    const existing = tabs.findIndex((tab) => tab.type === 'event-detail' && tab.eventId === event.id)
    if (existing >= 0) {
      setActiveTabIndex(existing)
      return
    }
    const label = event.operationName.length > 30 ? `${event.operationName.slice(0, 30)}...` : event.operationName
    const nextTabs: MonitorTab[] = [...tabs, { type: 'event-detail', eventId: event.id, label }]
    setTabs(nextTabs)
    setActiveTabIndex(nextTabs.length - 1)
  }

  function closeTab(index: number): void {
    if (tabs[index].type === 'overview') return
    const nextTabs = tabs.filter((_, i) => i !== index)
    setTabs(nextTabs)
    setActiveTabIndex((current) => current >= nextTabs.length ? nextTabs.length - 1 : current > index ? current - 1 : current)
  }

  /* ── Render ── */

  const detailEvent = activeTab.type === 'event-detail' ? result?.events.find((e) => e.id === activeTab.eventId) ?? null : null
  const correlatedEvents = detailEvent ? result?.events.filter((e) => e.correlationId && e.correlationId === detailEvent.correlationId) ?? [] : []

  return (
    <div className="cw-console azure-monitor-console">
      {error && !loading && <div className="error-banner">{error}</div>}

      {/* ── Hero ── */}
      <div className="cw-shell-hero">
        <div className="cw-shell-hero-copy">
          <div className="cw-shell-kicker">Azure Monitor</div>
          <h2>Activity log investigations and operational insight in one view</h2>
          <p>Run management-plane activity queries, save working investigations, and browse operational events with distribution analysis.</p>
          <div className="cw-shell-meta-strip">
            <div className="cw-shell-meta-pill"><span>Scope</span><strong>Subscription {subscriptionId}</strong></div>
            <div className="cw-shell-meta-pill"><span>Region lens</span><strong>{location || 'All regions'}</strong></div>
            <div className="cw-shell-meta-pill"><span>Window</span><strong>{MONITOR_TIME_RANGES.find((r) => r.value === timeRange)?.label ?? `${timeRange}h`}</strong></div>
            <div className="cw-shell-meta-pill"><span>Last event</span><strong>{latestEventTimestamp ? formatDateTime(latestEventTimestamp) : 'No events yet'}</strong></div>
          </div>
        </div>
        <div className="cw-shell-hero-stats">
          <div className="cw-shell-stat-card cw-shell-stat-card-accent"><span>Activity Events</span><strong>{formatCompactNumber(result?.events.length ?? 0)}</strong><small>Management-plane events in the current window.</small></div>
          <div className="cw-shell-stat-card"><span>Statuses</span><strong>{formatCompactNumber(result?.statusCounts.length ?? 0)}</strong><small>Distinct status facets in the result set.</small></div>
          <div className="cw-shell-stat-card"><span>Resource Types</span><strong>{formatCompactNumber(result?.resourceTypeCounts.length ?? 0)}</strong><small>Providers represented in the events.</small></div>
          <div className="cw-shell-stat-card"><span>Saved Queries</span><strong>{formatCompactNumber(savedQueries.length)}</strong><small>Reusable investigations for this subscription.</small></div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="cw-shell-toolbar">
        <div className="cw-tabs" role="tablist" aria-label="Monitor tabs">
          {tabs.map((tab, index) => (
            <button key={index} type="button" className={`cw-tab ${index === activeTabIndex ? 'active' : ''}`} onClick={() => setActiveTabIndex(index)}>
              <span>{tab.type === 'overview' ? 'Overview' : tab.label}</span>
              {tab.type !== 'overview' && <span className="cw-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(index) }}>x</span>}
            </button>
          ))}
        </div>
        <div className="cw-toolbar">
          <div className="cw-toolbar-group">
            <span className="cw-toolbar-label">Range</span>
            <select className="cw-time-select" value={timeRange} onChange={(e) => setTimeRange(Number(e.target.value) as MonitorTimeRange)}>
              {MONITOR_TIME_RANGES.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <div className="cw-toolbar-group">
            <span className="cw-toolbar-label">Status</span>
            <select className="cw-ns-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All Statuses</option>
              {distinctStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <span className="cw-toolbar-pill">{loading ? 'Refreshing activity' : 'Activity ready'}</span>
        </div>
      </div>

      {/* ── Tab content ── */}
      {activeTab.type === 'overview' ? (
        <>
          {/* Investigation Workspace */}
          <div className="cw-section">
            <div className="cw-section-head">
              <div><h3>Investigation Workspace</h3><p className="cw-section-subtitle">Query activity events, save working searches, and rerun recent investigations.</p></div>
              <div className="cw-query-headline">
                <span className="cw-toolbar-pill">{filteredEvents.length} events</span>
                <span className="cw-toolbar-pill">{appliedQuery || 'No filter'}</span>
              </div>
            </div>
            <div className="cw-query-layout">
              <div className="cw-query-main">
                <div className="cw-query-target-bar">
                  <span className="cw-query-source">{subscriptionId}</span>
                  <span className="cw-query-source">{location || 'global'}</span>
                  <button type="button" className="cw-toggle" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az monitor activity-log list --subscription "${subscriptionId}" --offset ${timeRange}h --max-events 50 --output jsonc`)}>Rerun in terminal</button>
                </div>
                <div className="cw-query-preset-row">
                  {MONITOR_PRESETS.map((preset) => (
                    <button key={preset.id} type="button" className="cw-chip" onClick={() => setQueryDraft(preset.query)}>{preset.label}</button>
                  ))}
                </div>
                <textarea className="cw-query-editor" value={queryDraft} onChange={(e) => setQueryDraft(e.target.value)} rows={8} spellCheck={false} placeholder={'Enter a text filter to search activity events.\nExamples: Failed, Microsoft.Compute, resourceGroups/my-rg'} />
                <div className="cw-query-actions">
                  <button type="button" className="cw-refresh-btn" disabled={queryBusy} onClick={() => runQuery()}>{queryBusy ? 'Running...' : 'Run Query'}</button>
                  <input className="cw-table-filter" placeholder="Saved query name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
                  <input className="cw-table-filter" placeholder="Description" value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)} />
                  <button type="button" className="cw-expand-btn" onClick={saveCurrentQuery}>Save Query</button>
                  <button type="button" className="cw-toggle" disabled={queryHistory.length === 0} onClick={clearHistory}>Clear History</button>
                </div>
                {queryFeedback && <div className="cw-query-feedback success">{queryFeedback}</div>}
                {queryError && <div className="cw-query-feedback error">{queryError}</div>}
                {loading && <div className="cw-loading">Loading activity events...</div>}

                {/* Query results table */}
                {result && filteredEvents.length > 0 && (
                  <div className="cw-query-results">
                    <div className="cw-section-head">
                      <div><h3>Query Results</h3><p className="cw-section-subtitle">{appliedQuery ? `Filter: "${appliedQuery}"` : 'Unfiltered'} - {filteredEvents.length} events</p></div>
                      <div className="cw-query-headline">
                        <span className="cw-toolbar-pill">{result.statusCounts.length} statuses</span>
                        <span className="cw-toolbar-pill">{result.resourceTypeCounts.length} types</span>
                      </div>
                    </div>
                    <div className="cw-table-scroll">
                      <table className="cw-table">
                        <thead><tr><th>Operation</th><th>Status</th><th>Resource Group</th><th>Timestamp</th></tr></thead>
                        <tbody>
                          {filteredEvents.map((event) => (
                            <tr key={event.id} className="cw-clickable" onDoubleClick={() => openEventDetailTab(event)}>
                              <td>{event.operationName}</td>
                              <td>{event.status}</td>
                              <td>{event.resourceGroup || '-'}</td>
                              <td>{formatDateTime(event.timestamp)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {result && filteredEvents.length === 0 && !loading && (
                  <div className="cw-query-feedback error">No events match the current filter.</div>
                )}
              </div>

              {/* Sidebar */}
              <div className="cw-query-sidebar">
                <div className="cw-query-card">
                  <div className="cw-panel-head"><div><h3>Saved Queries</h3><p className="cw-chart-subtitle">One-click reruns from the current subscription context.</p></div></div>
                  {savedQueries.length === 0 ? <div className="cw-table-hint">No saved queries yet.</div> : (
                    <div className="cw-query-list">
                      {savedQueries.map((saved) => (
                        <div key={saved.id} className="cw-query-list-item">
                          <div>
                            <strong>{saved.name}</strong>
                            <span>{saved.description || saved.query || 'All events'}</span>
                            <small>Last run {saved.lastRunAt ? formatDateTime(saved.lastRunAt) : 'never'}</small>
                          </div>
                          <div className="cw-query-list-actions">
                            <button type="button" className="cw-toggle" onClick={() => { setQueryDraft(saved.query); setQueryFeedback(`Loaded query: ${saved.name}`) }}>Load</button>
                            <button type="button" className="cw-expand-btn" onClick={() => loadAndRunSavedQuery(saved)}>Run</button>
                            <button type="button" className="cw-toggle" onClick={() => deleteSavedQuery(saved.id)}>Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="cw-query-card">
                  <div className="cw-panel-head"><div><h3>Recent Runs</h3><p className="cw-chart-subtitle">Quick rerun for recent investigations.</p></div></div>
                  {queryHistory.length === 0 ? <div className="cw-table-hint">No query history yet.</div> : (
                    <div className="cw-query-list">
                      {queryHistory.map((entry) => (
                        <div key={entry.id} className="cw-query-list-item">
                          <div>
                            <strong>{entry.status === 'success' ? 'Successful run' : 'Failed run'}</strong>
                            <span>{entry.resultSummary}</span>
                            <small>{formatDateTime(entry.executedAt)} - {entry.durationMs} ms</small>
                          </div>
                          <div className="cw-query-list-actions">
                            <button type="button" className="cw-expand-btn" onClick={() => { setQueryDraft(entry.query); runQuery(entry.query) }}>Rerun</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Bar charts */}
          <div className="cw-charts-row">
            <div className="cw-chart-panel">
              <div className="cw-panel-head"><div><h3>Status Distribution</h3><p className="cw-chart-subtitle">Activity event statuses ordered by frequency in the current window.</p></div></div>
              <div className="cw-bar-chart">
                {topStatusCounts.length === 0 ? <div className="cw-table-hint">No status data available.</div> : topStatusCounts.map((facet) => (
                  <div key={facet.label} className="cw-bar-row">
                    <div className="cw-bar-fill" style={{ width: `${Math.max((facet.count / Math.max(...topStatusCounts.map((f) => f.count), 1)) * 100, 2)}%` }} />
                    <span className="cw-bar-label">{facet.label} ({facet.count})</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="cw-chart-panel">
              <div className="cw-panel-head"><div><h3>Resource Type Distribution</h3><p className="cw-chart-subtitle">Providers represented in the current activity window.</p></div></div>
              <div className="cw-bar-chart">
                {topResourceTypeCounts.length === 0 ? <div className="cw-table-hint">No resource type data available.</div> : topResourceTypeCounts.map((facet) => (
                  <div key={facet.label} className="cw-bar-row">
                    <div className="cw-bar-fill" style={{ width: `${Math.max((facet.count / Math.max(...topResourceTypeCounts.map((f) => f.count), 1)) * 100, 2)}%` }} />
                    <span className="cw-bar-label">{facet.label} ({facet.count})</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Activity Events filterable table */}
          <div className="cw-section">
            <div className="cw-section-head">
              <div><h3>Activity Events</h3><p className="cw-section-subtitle">Search and compare events across the current activity window. Double-click to inspect event details.</p></div>
              <div className="cw-query-headline"><span className="cw-toolbar-pill">{filteredEvents.length} events</span></div>
            </div>
            <MonitorFilterableTable
              columns={[
                { key: 'operationName', label: 'Operation' },
                { key: 'status', label: 'Status' },
                { key: 'level', label: 'Level' },
                { key: 'resourceGroup', label: 'Resource Group', render: (row: AzureMonitorActivityEvent) => row.resourceGroup || '-' },
                { key: 'resourceType', label: 'Resource Type', render: (row: AzureMonitorActivityEvent) => row.resourceType || '-' },
                { key: 'caller', label: 'Caller', render: (row: AzureMonitorActivityEvent) => row.caller || '-' },
                { key: 'timestamp', label: 'Timestamp', render: (row: AzureMonitorActivityEvent) => formatDateTime(row.timestamp) }
              ]}
              data={filteredEvents}
              onDoubleClick={(row) => openEventDetailTab(row as unknown as AzureMonitorActivityEvent)}
              hint="Double-click an event to inspect full attributes and correlated activity."
            />
          </div>
        </>
      ) : detailEvent ? (
        <EventDetailViewer
          event={detailEvent}
          correlatedEvents={correlatedEvents}
          onOpenService={onOpenService}
          onOpenDirectAccess={onOpenDirectAccess}
          onOpenCompliance={onOpenCompliance}
          onRunTerminalCommand={onRunTerminalCommand}
          canRunTerminalCommand={canRunTerminalCommand}
          subscriptionId={subscriptionId}
        />
      ) : (
        <div className="cw-loading">Event not found in the current result set.</div>
      )}
    </div>
  )
}

export function AzureCostConsole({
  subscriptionId,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenCompliance,
  onOpenMonitor,
  onOpenDirectAccess
}: {
  subscriptionId: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenCompliance: () => void
  onOpenMonitor: (query: string) => void
  onOpenDirectAccess: () => void
}): JSX.Element {
  const [overview, setOverview] = useState<AzureCostOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedService, setSelectedService] = useState('')
  const [activeTab, setActiveTab] = useState<'services' | 'resource-groups'>('services')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    void getAzureCostOverview(subscriptionId)
      .then((next) => {
        if (!cancelled) {
          setOverview(next)
          setSelectedService((current) => current || next.topServices[0]?.label || '')
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setOverview(null)
          setError(normalizeError(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [refreshNonce, subscriptionId])

  const selectedEntry = overview?.topServices.find((entry) => entry.label === selectedService) ?? overview?.topServices[0] ?? null
  const selectedResourceGroups = useMemo(
    () => overview?.topResourceGroups ?? [],
    [overview]
  )
  const maxDailyAmount = useMemo(
    () => Math.max(...(overview?.dailyCosts.map((d) => d.amount) ?? [0]), 1),
    [overview]
  )

  return (
    <div className="cw-console azure-cost-console">
      {/* ---- hero section ---- */}
      <div className="cw-shell-hero">
        <div className="cw-shell-hero-copy">
          <div className="cw-shell-kicker">Azure Cost Management</div>
          <h2>Cost Analysis</h2>
          <p>Month-to-date spend breakdown with daily trend, service attribution, and resource-group distribution for the active subscription.</p>
          <div className="cw-shell-meta-strip">
            <div className="cw-shell-meta-pill"><span>Subscription</span><strong>{subscriptionId}</strong></div>
            <div className="cw-shell-meta-pill"><span>Currency</span><strong>{overview?.currency ?? 'USD'}</strong></div>
            <div className="cw-shell-meta-pill"><span>Timeframe</span><strong>{overview?.timeframeLabel ?? 'Month to date'}</strong></div>
            <div className="cw-shell-meta-pill"><span>Services</span><strong>{overview?.serviceCount ?? 0}</strong></div>
          </div>
        </div>
        <div className="cw-shell-hero-stats">
          <div className="cw-shell-stat-card cw-shell-stat-card-accent"><span>Total spend</span><strong>{overview ? formatCurrency(overview.totalAmount, overview.currency) : '-'}</strong><small>Month-to-date accumulated cost.</small></div>
          <div className="cw-shell-stat-card"><span>Daily average</span><strong>{overview ? formatCurrency(overview.dailyAverage, overview.currency) : '-'}</strong><small>Average daily spend this period.</small></div>
          <div className="cw-shell-stat-card"><span>Top service</span><strong>{overview?.topServiceName || '-'}</strong><small>{overview ? formatCurrency(overview.topServiceAmount, overview.currency) : 'Pending data.'}</small></div>
          <div className="cw-shell-stat-card"><span>Resource groups</span><strong>{overview?.resourceGroupCount ?? 0}</strong><small>Cost-attributed groups in scope.</small></div>
        </div>
      </div>

      {loading ? <SvcState variant="loading" resourceName="Azure cost analysis" compact /> : null}
      {!loading && error ? <SvcState variant="error" error={error} /> : null}
      {!loading && !error && !overview ? <SvcState variant="empty" message="Azure cost data was not available for the selected subscription." /> : null}

      {overview ? (
        <>
          {/* ---- daily cost trend bars ---- */}
          {overview.dailyCosts.length > 0 ? (
            <div className="cost-daily-panel">
              <div className="panel-header"><h3>Daily Spend Trend</h3><span className="cost-daily-label">{overview.dailyCosts.length} days</span></div>
              <div className="cost-daily-chart">
                {overview.dailyCosts.map((day) => (
                  <div key={day.date} className="cost-daily-bar-wrap" title={`${day.date}: ${formatCurrency(day.amount, day.currency)}`}>
                    <div className="cost-daily-bar" style={{ height: `${Math.max((day.amount / maxDailyAmount) * 100, 2)}%` }} />
                    <span className="cost-daily-date">{day.date.slice(8)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* ---- tab bar ---- */}
          <div className="cw-shell-toolbar">
            <div className="cw-tabs">
              <button type="button" className={`cw-tab ${activeTab === 'services' ? 'active' : ''}`} onClick={() => setActiveTab('services')}>
                <span>Services ({overview.topServices.length})</span>
              </button>
              <button type="button" className={`cw-tab ${activeTab === 'resource-groups' ? 'active' : ''}`} onClick={() => setActiveTab('resource-groups')}>
                <span>Resource Groups ({overview.topResourceGroups.length})</span>
              </button>
            </div>
            <div className="cw-toolbar">
              <button type="button" className="cw-refresh-btn" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az costmanagement query --scope "/subscriptions/${subscriptionId}" --type Usage --timeframe MonthToDate --output jsonc`)}>Export to terminal</button>
            </div>
          </div>

          {/* ---- main content ---- */}
          <div className="cw-section">
            <div className="cw-query-layout">
              <div className="cw-query-main">
                {activeTab === 'services' ? (
                  <div className="cw-results-table">
                    <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.8fr 0.6fr 1fr', gap: '1rem', padding: '8px 12px' }}>
                      <div>Service</div><div>Amount</div><div>Share</div><div>Distribution</div>
                    </div>
                    {overview.topServices.map((entry) => (
                      <button key={entry.label} type="button" className={`cw-result-row ${selectedService === entry.label ? 'active' : ''}`} style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.8fr 0.6fr 1fr', gap: '1rem', textAlign: 'left' }} onClick={() => setSelectedService(entry.label)}>
                        <div><strong>{entry.label}</strong></div>
                        <div>{formatCurrency(entry.amount, entry.currency)}</div>
                        <div>{entry.sharePercent}%</div>
                        <div className="cost-share-bar-track"><div className="cost-share-bar-fill" style={{ width: `${entry.sharePercent}%` }} /></div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="cw-results-table">
                    <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.8fr 0.6fr 1fr', gap: '1rem', padding: '8px 12px' }}>
                      <div>Resource group</div><div>Amount</div><div>Share</div><div>Distribution</div>
                    </div>
                    {selectedResourceGroups.map((entry) => (
                      <div key={entry.label} className="cw-result-row" style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.8fr 0.6fr 1fr', gap: '1rem', textAlign: 'left' }}>
                        <div><strong>{entry.label}</strong></div>
                        <div>{formatCurrency(entry.amount, entry.currency)}</div>
                        <div>{entry.sharePercent}%</div>
                        <div className="cost-share-bar-track"><div className="cost-share-bar-fill" style={{ width: `${entry.sharePercent}%` }} /></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ---- right sidebar ---- */}
              <div className="cw-query-side">
                <div className="panel overview-insights-panel">
                  <div className="panel-header"><h3>Selected Service</h3></div>
                  {!selectedEntry ? (
                    <SvcState variant="no-selection" resourceName="service" message="Select a service from the table to view details." />
                  ) : (
                    <div className="overview-note-list">
                      <div className="overview-note-item">Service: {selectedEntry.label}</div>
                      <div className="overview-note-item">Spend: {formatCurrency(selectedEntry.amount, selectedEntry.currency)}</div>
                      <div className="overview-note-item">Share of total: {selectedEntry.sharePercent}%</div>
                      <div className="overview-note-item">Currency: {selectedEntry.currency}</div>
                    </div>
                  )}
                </div>

                {overview.notes.length > 0 ? (
                  <div className="panel overview-insights-panel">
                    <div className="panel-header"><h3>Notes</h3></div>
                    <div className="overview-note-list">
                      {overview.notes.map((note) => <div key={note} className="overview-note-item">{note}</div>)}
                    </div>
                  </div>
                ) : null}

                <div className="panel overview-insights-panel">
                  <div className="panel-header"><h3>Actions</h3></div>
                  <div className="gcp-overview-actions">
                    <button type="button" className="ghost" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az costmanagement query --scope "/subscriptions/${subscriptionId}" --type Usage --timeframe MonthToDate --dataset-grouping name=ServiceName type=Dimension --output table`)}>Service breakdown</button>
                    <button type="button" className="ghost" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az costmanagement query --scope "/subscriptions/${subscriptionId}" --type Usage --timeframe MonthToDate --dataset-grouping name=ResourceGroupName type=Dimension --output table`)}>RG breakdown</button>
                    <button type="button" className="ghost" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az consumption usage list --subscription "${subscriptionId}" --top 20 --output table`)}>Recent usage</button>
                    <button type="button" className="ghost" onClick={() => onOpenMonitor('Microsoft.CostManagement')}>Open monitor</button>
                    <button type="button" className="ghost" onClick={onOpenDirectAccess}>Direct access</button>
                    <button type="button" className="ghost" onClick={onOpenCompliance}>Compliance</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
