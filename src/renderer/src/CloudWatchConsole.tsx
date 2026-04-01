import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type {
  AwsConnection,
  CloudWatchDatapoint,
  CloudWatchLogEventSummary,
  CloudWatchLogGroupSummary,
  CloudWatchMetricSeries,
  CloudWatchMetricStatistic,
  CloudWatchMetricSummary,
  CloudWatchNamespaceSummary,
  CloudWatchQueryExecutionResult,
  CloudWatchQueryHistoryEntry,
  CloudWatchSavedQuery,
  ServiceId,
  TokenizedFocus
} from '@shared/types'
import {
  clearCloudWatchQueryHistory,
  deleteCloudWatchSavedQuery,
  getEc2AllMetricSeries,
  getMetricStatistics,
  listCloudWatchLogGroups,
  listCloudWatchMetrics,
  listCloudWatchQueryHistory,
  listCloudWatchRecentEvents,
  listCloudWatchSavedQueries,
  listEc2InstanceMetrics,
  recordCloudWatchQueryHistory,
  runCloudWatchQuery,
  saveCloudWatchSavedQuery
} from './api'
import { formatDateTime } from './AwsPage'
import './cloudwatch.css'

type TimeRange = 1 | 3 | 12 | 24 | 72 | 168
type OpenTab = { type: 'overview' } | { type: 'log-group'; name: string }
type CloudWatchFocus = TokenizedFocus<'cloudwatch'> | null | undefined
type QueryPreset = { id: string; label: string; queryString: string }

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: 1, label: '1 hour' },
  { value: 3, label: '3 hours' },
  { value: 12, label: '12 hours' },
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' }
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatMetricValue(value: number | null, unit: string): string {
  if (value === null) return '-'
  if (unit === 'Percent') return `${value.toFixed(2)}%`
  if (unit === 'Bytes') return formatBytes(value)
  if (unit === 'Seconds') return `${value.toFixed(3)}s`
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toFixed(2)
}

function formatCompactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function serviceHintLabel(serviceHint: ServiceId | ''): string {
  if (serviceHint === 'lambda') return 'Lambda'
  if (serviceHint === 'ecs') return 'ECS'
  if (serviceHint === 'rds') return 'RDS'
  if (serviceHint === 'ec2') return 'EC2'
  return 'AWS context'
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function defaultQuery(serviceHint: ServiceId | '', sourceLabel: string): string {
  const label = escapeRegex(sourceLabel || 'current')
  const extra = serviceHint === 'rds'
    ? 'deadlock|fail|timeout'
    : serviceHint === 'ecs'
      ? 'unhealthy|throttle|error'
      : serviceHint === 'lambda'
        ? 'request|error|timeout'
        : 'error|exception|timeout'

  return [
    'fields @timestamp, @logStream, @message',
    `| filter @message like /(?i)(${label}|${extra})/`,
    '| sort @timestamp desc',
    '| limit 50'
  ].join('\n')
}

function severity(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('error') || lower.includes('fatal') || lower.includes('exception')) return 'error'
  if (lower.includes('warn')) return 'warn'
  if (lower.includes('debug') || lower.includes('trace')) return 'debug'
  return 'info'
}

function matchesEc2LogGroup(group: CloudWatchLogGroupSummary, instanceId: string): boolean {
  const needle = instanceId.toLowerCase()
  return group.name.toLowerCase().includes(needle) || group.arn.toLowerCase().includes(needle)
}

function summarizeResult(result: CloudWatchQueryExecutionResult): string {
  return `${result.rows.length} rows, ${formatBytes(result.statistics.bytesScanned)} scanned`
}

function Sparkline({ points, unit, width = 140, height = 36 }: { points: CloudWatchDatapoint[]; unit: string; width?: number; height?: number }) {
  if (points.length < 2) return <span className="cw-no-data">No data</span>
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = width / (points.length - 1)
  const path = points.map((point, index) => {
    const x = index * stepX
    const y = height - ((point.value - min) / range) * (height - 4) - 2
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return <svg className="cw-sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}><path d={path} fill="none" stroke="#4a8fe7" strokeWidth="1.5" /></svg>
}

function FilterableTable<T extends Record<string, unknown>>({
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

function LogGroupViewer({
  connection,
  logGroupName,
  timeRange,
  onInvestigate
}: {
  connection: AwsConnection
  logGroupName: string
  timeRange: TimeRange
  onInvestigate: (logGroupName: string) => void
}) {
  const [events, setEvents] = useState<CloudWatchLogEventSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    void listCloudWatchRecentEvents(connection, logGroupName, timeRange)
      .then(setEvents)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [connection.sessionId, connection.region, logGroupName, timeRange])

  const filtered = useMemo(() => {
    if (!search) return events
    const needle = search.toLowerCase()
    return events.filter((event) => event.message.toLowerCase().includes(needle) || event.logStreamName.toLowerCase().includes(needle))
  }, [events, search])

  if (loading) return <div className="cw-loading">Loading log events...</div>
  if (error) return <div className="error-banner">{error}</div>

  return (
    <div className="cw-log-viewer">
      <div className="cw-log-viewer-header">
        <div><h3>{logGroupName}</h3><span className="cw-log-count">{filtered.length} events</span></div>
        <button type="button" className="cw-expand-btn" onClick={() => onInvestigate(logGroupName)}>Investigate</button>
      </div>
      <div className="cw-log-controls">
        <input className="cw-table-filter" placeholder="Search log messages..." value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="cw-log-entries">
        {filtered.map((event, index) => (
          <div key={`${event.eventId}-${index}`} className={`cw-log-entry cw-severity-${severity(event.message)}`}>
            <div className="cw-log-entry-header">
              <span className="cw-log-time">{formatDateTime(event.timestamp)}</span>
              <span className="cw-log-stream">{event.logStreamName}</span>
            </div>
            <pre className="cw-log-message">{event.message}</pre>
          </div>
        ))}
        {filtered.length === 0 && <div className="cw-empty-logs">No log events found.</div>}
      </div>
    </div>
  )
}

export function CloudWatchConsole({ connection, focusEc2Instance }: { connection: AwsConnection; focusEc2Instance?: CloudWatchFocus }) {
  const [timeRange, setTimeRange] = useState<TimeRange>(24)
  const [namespaceFilter, setNamespaceFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [namespaces, setNamespaces] = useState<CloudWatchNamespaceSummary[]>([])
  const [logGroups, setLogGroups] = useState<CloudWatchLogGroupSummary[]>([])
  const [metricStats, setMetricStats] = useState<CloudWatchMetricStatistic[]>([])
  const [ec2Series, setEc2Series] = useState<CloudWatchMetricSeries[]>([])
  const [tabs, setTabs] = useState<OpenTab[]>([{ type: 'overview' }])
  const [activeTabIndex, setActiveTabIndex] = useState(0)
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  const [ec2InstanceId, setEc2InstanceId] = useState<string | undefined>(focusEc2Instance?.ec2InstanceId)
  const [queryDraft, setQueryDraft] = useState(defaultQuery('', 'current context'))
  const [queryServiceHint, setQueryServiceHint] = useState<ServiceId | ''>('')
  const [querySourceLabel, setQuerySourceLabel] = useState('current context')
  const [selectedQueryLogGroups, setSelectedQueryLogGroups] = useState<string[]>([])
  const [logGroupToAdd, setLogGroupToAdd] = useState('')
  const [savedQueries, setSavedQueries] = useState<CloudWatchSavedQuery[]>([])
  const [queryHistory, setQueryHistory] = useState<CloudWatchQueryHistoryEntry[]>([])
  const [queryResult, setQueryResult] = useState<CloudWatchQueryExecutionResult | null>(null)
  const [queryBusy, setQueryBusy] = useState(false)
  const [queryFeedback, setQueryFeedback] = useState('')
  const [queryError, setQueryError] = useState('')
  const [saveName, setSaveName] = useState('')
  const [saveDescription, setSaveDescription] = useState('')

  const isEc2Mode = !!ec2InstanceId
  const activeTab = tabs[activeTabIndex]

  useEffect(() => {
    if (!focusEc2Instance || focusEc2Instance.token === appliedFocusToken) return
    setAppliedFocusToken(focusEc2Instance.token)
    setEc2InstanceId(focusEc2Instance.ec2InstanceId)
    setQueryServiceHint(focusEc2Instance.serviceHint ?? (focusEc2Instance.ec2InstanceId ? 'ec2' : ''))
    setQuerySourceLabel(focusEc2Instance.sourceLabel ?? focusEc2Instance.ec2InstanceId ?? 'current context')
    setSelectedQueryLogGroups(focusEc2Instance.logGroupNames ?? [])
    setQueryDraft(focusEc2Instance.queryString?.trim() || defaultQuery(
      focusEc2Instance.serviceHint ?? (focusEc2Instance.ec2InstanceId ? 'ec2' : ''),
      focusEc2Instance.sourceLabel ?? focusEc2Instance.ec2InstanceId ?? 'current context'
    ))
    setActiveTabIndex(0)
  }, [appliedFocusToken, focusEc2Instance])

  useEffect(() => {
    setLoading(true)
    setError('')
    const metricLoader: Promise<{ metrics: CloudWatchMetricSummary[]; namespaces: CloudWatchNamespaceSummary[] }> = isEc2Mode
      ? listEc2InstanceMetrics(connection, ec2InstanceId!).then((metrics) => ({
          metrics,
          namespaces: Array.from(new Set(metrics.map((metric) => metric.namespace))).map((namespace) => ({
            namespace,
            metricCount: metrics.filter((metric) => metric.namespace === namespace).length,
            dimensionKeys: []
          }))
        }))
      : listCloudWatchMetrics(connection)

    void Promise.all([metricLoader, listCloudWatchLogGroups(connection)])
      .then(async ([metricData, nextLogGroups]) => {
        const scopedGroups = isEc2Mode ? nextLogGroups.filter((group) => matchesEc2LogGroup(group, ec2InstanceId!)) : nextLogGroups
        setNamespaces(metricData.namespaces)
        setLogGroups(scopedGroups)
        setMetricStats(await getMetricStatistics(connection, metricData.metrics, timeRange))
        setEc2Series(isEc2Mode ? await getEc2AllMetricSeries(connection, ec2InstanceId!, timeRange) : [])
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [connection.sessionId, connection.region, ec2InstanceId, isEc2Mode, timeRange])

  useEffect(() => {
    void Promise.all([
      listCloudWatchSavedQueries({ profile: connection.profile, region: connection.region, limit: 8 }),
      listCloudWatchQueryHistory({ profile: connection.profile, region: connection.region, limit: 8 })
    ]).then(([nextSaved, nextHistory]) => {
      setSavedQueries(nextSaved)
      setQueryHistory(nextHistory)
    }).catch(() => {
      // Keep the screen usable if query history hydration fails.
    })
  }, [connection.profile, connection.region, connection.sessionId])

  useEffect(() => {
    const available = new Set(logGroups.map((group) => group.name))
    setSelectedQueryLogGroups((current) => {
      const pruned = current.filter((name) => available.has(name))
      if (pruned.length > 0) return pruned
      if (logGroups.length === 0) return []
      return isEc2Mode ? logGroups.slice(0, 3).map((group) => group.name) : [logGroups[0].name]
    })
    setLogGroupToAdd(logGroups[0]?.name ?? '')
  }, [isEc2Mode, logGroups])

  const filteredStats = useMemo(() => namespaceFilter === 'all' ? metricStats : metricStats.filter((item) => item.namespace === namespaceFilter), [metricStats, namespaceFilter])
  const totalStoredBytes = useMemo(() => logGroups.reduce((sum, group) => sum + group.storedBytes, 0), [logGroups])
  const latestMetricTimestamp = useMemo(() => ec2Series.flatMap((series) => series.points.map((point) => point.timestamp)).sort().at(-1) ?? '', [ec2Series])
  const topLogGroups = useMemo(() => [...logGroups].sort((left, right) => right.storedBytes - left.storedBytes).slice(0, 8), [logGroups])
  const quickQueries = useMemo<QueryPreset[]>(() => [
    { id: 'recent', label: 'Recent', queryString: defaultQuery(queryServiceHint, querySourceLabel) },
    { id: 'errors', label: 'Errors', queryString: ['fields @timestamp, @logStream, @message', '| filter @message like /(?i)(error|exception|fail|timeout)/', '| sort @timestamp desc', '| limit 50'].join('\n') },
    { id: 'warnings', label: 'Warnings', queryString: ['fields @timestamp, @logStream, @message', '| filter @message like /(?i)(warn|retry|throttle|backoff)/', '| sort @timestamp desc', '| limit 50'].join('\n') }
  ], [queryServiceHint, querySourceLabel])

  function openLogGroupTab(group: CloudWatchLogGroupSummary): void {
    const existing = tabs.findIndex((tab) => tab.type === 'log-group' && tab.name === group.name)
    setSelectedQueryLogGroups((current) => current.includes(group.name) ? current : [group.name, ...current].slice(0, 6))
    if (existing >= 0) {
      setActiveTabIndex(existing)
      return
    }
    const nextTabs = [...tabs, { type: 'log-group' as const, name: group.name }]
    setTabs(nextTabs)
    setActiveTabIndex(nextTabs.length - 1)
  }

  function refreshQueryLibrary(): Promise<void> {
    return Promise.all([
      listCloudWatchSavedQueries({ profile: connection.profile, region: connection.region, limit: 8 }),
      listCloudWatchQueryHistory({ profile: connection.profile, region: connection.region, limit: 8 })
    ]).then(([nextSaved, nextHistory]) => {
      setSavedQueries(nextSaved)
      setQueryHistory(nextHistory)
    })
  }

  async function runQuery(options?: { queryString?: string; logGroupNames?: string[]; savedQueryId?: string; serviceHint?: ServiceId | ''; sourceLabel?: string }) {
    const queryString = options?.queryString?.trim() || queryDraft.trim()
    const logGroupNames = options?.logGroupNames ?? selectedQueryLogGroups
    const serviceHint = options?.serviceHint ?? queryServiceHint ?? (isEc2Mode ? 'ec2' : '')
    const sourceLabel = options?.sourceLabel ?? querySourceLabel
    if (!queryString) { setQueryError('Enter a query first.'); return }
    if (logGroupNames.length === 0) { setQueryError('Select at least one log group.'); return }
    setQueryBusy(true)
    setQueryError('')
    setQueryFeedback('')
    const started = Date.now()
    try {
      const result = await runCloudWatchQuery(connection, {
        queryString,
        logGroupNames,
        startTimeMs: Date.now() - timeRange * 60 * 60 * 1000,
        endTimeMs: Date.now(),
        limit: 100
      })
      setQueryResult(result)
      setQueryDraft(queryString)
      setQueryServiceHint(serviceHint)
      setQuerySourceLabel(sourceLabel)
      setSelectedQueryLogGroups(logGroupNames)
      setQueryFeedback(`Query completed. ${summarizeResult(result)}.`)
      await recordCloudWatchQueryHistory({
        queryString,
        logGroupNames,
        profile: connection.profile,
        region: connection.region,
        serviceHint,
        savedQueryId: options?.savedQueryId ?? '',
        status: 'success',
        durationMs: Date.now() - started,
        resultSummary: summarizeResult(result)
      })
      await refreshQueryLibrary()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setQueryError(message)
      await recordCloudWatchQueryHistory({
        queryString,
        logGroupNames,
        profile: connection.profile,
        region: connection.region,
        serviceHint,
        savedQueryId: options?.savedQueryId ?? '',
        status: 'failed',
        durationMs: Date.now() - started,
        resultSummary: message
      }).catch(() => {})
      await refreshQueryLibrary().catch(() => {})
    } finally {
      setQueryBusy(false)
    }
  }

  async function saveCurrentQuery() {
    if (!saveName.trim()) { setQueryError('Provide a saved query name.'); return }
    await saveCloudWatchSavedQuery({
      name: saveName.trim(),
      description: saveDescription.trim(),
      queryString: queryDraft.trim(),
      logGroupNames: selectedQueryLogGroups,
      profile: connection.profile,
      region: connection.region,
      serviceHint: queryServiceHint
    })
    setSaveName('')
    setSaveDescription('')
    setQueryFeedback('Saved query stored.')
    await refreshQueryLibrary()
  }

  return (
    <div className="cw-console">
      {error && <div className="error-banner">{error}</div>}
      <div className="cw-shell-hero">
        <div className="cw-shell-hero-copy">
          <div className="cw-shell-kicker">CloudWatch</div>
          <h2>{isEc2Mode ? 'Instance telemetry in one operating surface' : 'Metrics, logs, and investigation flows in one view'}</h2>
          <p>{isEc2Mode ? 'Stay on the focused EC2 instance while running queries, reviewing log groups, and tracking metric movement.' : 'Run Logs Insights style investigations, save useful queries, and keep metrics plus log browsing in the same workspace.'}</p>
          <div className="cw-shell-meta-strip">
            <div className="cw-shell-meta-pill"><span>Scope</span><strong>{isEc2Mode ? `EC2 ${ec2InstanceId}` : `Region ${connection.region}`}</strong></div>
            <div className="cw-shell-meta-pill"><span>Window</span><strong>{TIME_RANGE_OPTIONS.find((item) => item.value === timeRange)?.label ?? `${timeRange}h`}</strong></div>
            <div className="cw-shell-meta-pill"><span>Investigation</span><strong>{serviceHintLabel(queryServiceHint)}</strong></div>
            <div className="cw-shell-meta-pill"><span>Last datapoint</span><strong>{latestMetricTimestamp ? formatDateTime(latestMetricTimestamp) : 'No datapoints yet'}</strong></div>
          </div>
        </div>
        <div className="cw-shell-hero-stats">
          <div className="cw-shell-stat-card cw-shell-stat-card-accent"><span>Tracked Metrics</span><strong>{formatCompactNumber(filteredStats.length)}</strong><small>Metrics with computed statistics in scope.</small></div>
          <div className="cw-shell-stat-card"><span>Namespaces</span><strong>{formatCompactNumber(namespaceFilter === 'all' ? namespaces.length : 1)}</strong><small>Metric families available for drilldown.</small></div>
          <div className="cw-shell-stat-card"><span>Log Groups</span><strong>{formatCompactNumber(logGroups.length)}</strong><small>Visible groups in this context.</small></div>
          <div className="cw-shell-stat-card"><span>Saved Queries</span><strong>{formatCompactNumber(savedQueries.length)}</strong><small>Reusable investigations for this profile and region.</small></div>
        </div>
      </div>

      <div className="cw-shell-toolbar">
        <div className="cw-tabs" role="tablist" aria-label="CloudWatch tabs">
          {tabs.map((tab, index) => <button key={index} type="button" className={`cw-tab ${index === activeTabIndex ? 'active' : ''}`} onClick={() => setActiveTabIndex(index)}><span>{tab.type === 'overview' ? 'Overview' : tab.name}</span></button>)}
        </div>
        <div className="cw-toolbar">
          <div className="cw-toolbar-group">
            <span className="cw-toolbar-label">Range</span>
            <select className="cw-time-select" value={timeRange} onChange={(event) => setTimeRange(Number(event.target.value) as TimeRange)}>
              {TIME_RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {!isEc2Mode && (
            <div className="cw-toolbar-group">
              <span className="cw-toolbar-label">Namespace</span>
              <select className="cw-ns-select" value={namespaceFilter} onChange={(event) => setNamespaceFilter(event.target.value)}>
                <option value="all">All Namespaces</option>
                {namespaces.map((ns) => <option key={ns.namespace} value={ns.namespace}>{ns.namespace}</option>)}
              </select>
            </div>
          )}
          <span className="cw-toolbar-pill">{loading ? 'Refreshing telemetry' : 'Telemetry ready'}</span>
        </div>
      </div>

      {activeTab.type === 'overview' ? (
        <>
          <div className="cw-section">
            <div className="cw-section-head">
              <div><h3>Investigation Workspace</h3><p className="cw-section-subtitle">Query active log groups, save working searches, and rerun recent investigations.</p></div>
              <div className="cw-query-headline"><span className="cw-toolbar-pill">{selectedQueryLogGroups.length} targets</span><span className="cw-toolbar-pill">{serviceHintLabel(queryServiceHint)}</span></div>
            </div>
            <div className="cw-query-layout">
              <div className="cw-query-main">
                <div className="cw-query-target-bar">
                  <select className="cw-time-select" value={logGroupToAdd} onChange={(event) => setLogGroupToAdd(event.target.value)}>{logGroups.map((group) => <option key={group.name} value={group.name}>{group.name}</option>)}</select>
                  <button type="button" className="cw-toggle" onClick={() => logGroupToAdd && !selectedQueryLogGroups.includes(logGroupToAdd) && setSelectedQueryLogGroups((current) => [...current, logGroupToAdd])}>Add Target</button>
                  <span className="cw-query-source">{querySourceLabel}</span>
                </div>
                <div className="cw-query-chip-row">{selectedQueryLogGroups.map((name) => <button key={name} type="button" className="cw-query-chip" onClick={() => setSelectedQueryLogGroups((current) => current.filter((item) => item !== name))}>{name}<span>x</span></button>)}</div>
                <div className="cw-query-preset-row">{quickQueries.map((item) => <button key={item.id} type="button" className="cw-chip" onClick={() => setQueryDraft(item.queryString)}>{item.label}</button>)}</div>
                <textarea className="cw-query-editor" value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} rows={8} spellCheck={false} />
                <div className="cw-query-actions">
                  <button type="button" className="cw-refresh-btn" disabled={queryBusy} onClick={() => void runQuery()}>{queryBusy ? 'Running...' : 'Run Query'}</button>
                  <input className="cw-table-filter" placeholder="Saved query name" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
                  <input className="cw-table-filter" placeholder="Description" value={saveDescription} onChange={(event) => setSaveDescription(event.target.value)} />
                  <button type="button" className="cw-expand-btn" onClick={() => void saveCurrentQuery()}>Save Query</button>
                  <button type="button" className="cw-toggle" disabled={queryHistory.length === 0} onClick={() => void clearCloudWatchQueryHistory({ profile: connection.profile, region: connection.region }).then(() => refreshQueryLibrary())}>Clear History</button>
                </div>
                {queryFeedback && <div className="cw-query-feedback success">{queryFeedback}</div>}
                {queryError && <div className="cw-query-feedback error">{queryError}</div>}
                {queryResult && (
                  <div className="cw-query-results">
                    <div className="cw-section-head"><div><h3>Query Results</h3><p className="cw-section-subtitle">{queryResult.status} - {summarizeResult(queryResult)}</p></div><div className="cw-query-headline"><span className="cw-toolbar-pill">{formatCompactNumber(queryResult.statistics.recordsMatched)} matched</span><span className="cw-toolbar-pill">{formatCompactNumber(queryResult.statistics.recordsScanned)} scanned</span></div></div>
                    <div className="cw-table-scroll"><table className="cw-table"><thead><tr>{queryResult.fields.map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>{queryResult.rows.length === 0 ? <tr><td className="cw-empty" colSpan={Math.max(1, queryResult.fields.length)}>No results returned.</td></tr> : queryResult.rows.map((row, index) => <tr key={`${queryResult.queryId}-${index}`}>{queryResult.fields.map((field) => <td key={field}><span className="cw-query-cell">{row[field] || '-'}</span></td>)}</tr>)}</tbody></table></div>
                  </div>
                )}
              </div>
              <div className="cw-query-sidebar">
                <div className="cw-query-card">
                  <div className="cw-panel-head"><div><h3>Saved Queries</h3><p className="cw-chart-subtitle">One-click reruns from the current AWS context.</p></div></div>
                  {savedQueries.length === 0 ? <div className="cw-table-hint">No saved queries yet.</div> : <div className="cw-query-list">{savedQueries.map((saved) => <div key={saved.id} className="cw-query-list-item"><div><strong>{saved.name}</strong><span>{saved.description || saved.logGroupNames.join(', ')}</span><small>Last run {saved.lastRunAt ? formatDateTime(saved.lastRunAt) : 'never'}</small></div><div className="cw-query-list-actions"><button type="button" className="cw-toggle" onClick={() => { setQueryDraft(saved.queryString); setSelectedQueryLogGroups(saved.logGroupNames); setQueryServiceHint(saved.serviceHint); setQuerySourceLabel(saved.name) }}>Load</button><button type="button" className="cw-expand-btn" onClick={() => void runQuery({ queryString: saved.queryString, logGroupNames: saved.logGroupNames, savedQueryId: saved.id, serviceHint: saved.serviceHint, sourceLabel: saved.name })}>Run</button><button type="button" className="cw-toggle" onClick={() => void deleteCloudWatchSavedQuery(saved.id).then(() => refreshQueryLibrary())}>Delete</button></div></div>)}</div>}
                </div>
                <div className="cw-query-card">
                  <div className="cw-panel-head"><div><h3>Recent Runs</h3><p className="cw-chart-subtitle">Quick rerun for recent investigations.</p></div></div>
                  {queryHistory.length === 0 ? <div className="cw-table-hint">No query history yet.</div> : <div className="cw-query-list">{queryHistory.map((entry) => <div key={entry.id} className="cw-query-list-item"><div><strong>{entry.status === 'success' ? 'Successful run' : 'Failed run'}</strong><span>{entry.resultSummary}</span><small>{formatDateTime(entry.executedAt)} - {entry.durationMs} ms</small></div><div className="cw-query-list-actions"><button type="button" className="cw-expand-btn" onClick={() => void runQuery({ queryString: entry.queryString, logGroupNames: entry.logGroupNames, savedQueryId: entry.savedQueryId, serviceHint: entry.serviceHint, sourceLabel: querySourceLabel })}>Rerun</button></div></div>)}</div>}
                </div>
              </div>
            </div>
          </div>

          <div className="cw-charts-row">
            <div className="cw-chart-panel"><div className="cw-panel-head"><div><h3>Metric Namespaces</h3><p className="cw-chart-subtitle">Observed metric families ordered by discovered volume.</p></div></div><div className="cw-bar-chart">{namespaces.map((ns) => <div key={ns.namespace} className="cw-bar-row"><div className="cw-bar-fill" style={{ width: `${Math.max((ns.metricCount / Math.max(...namespaces.map((item) => item.metricCount), 1)) * 100, 2)}%` }} /><span className="cw-bar-label">{ns.namespace}</span></div>)}</div></div>
            <div className="cw-chart-panel"><div className="cw-panel-head"><div><h3>Top Log Group Storage</h3><p className="cw-chart-subtitle">Largest retained groups in the current scope.</p></div></div><div className="cw-bar-chart">{topLogGroups.map((group) => <div key={group.name} className="cw-bar-row"><div className="cw-bar-fill" style={{ width: `${Math.max((group.storedBytes / Math.max(...topLogGroups.map((item) => item.storedBytes), 1)) * 100, 2)}%` }} /><span className="cw-bar-label">{group.name}</span></div>)}</div></div>
          </div>

          {isEc2Mode && ec2Series.length > 0 && (
            <div className="cw-series-section">
              <div className="cw-section-head"><div><h3>EC2 Metric Series</h3><p className="cw-section-subtitle">Compact sparkline traces for the selected instance.</p></div></div>
              <div className="cw-series-grid">{ec2Series.map((series) => <div key={series.metricName} className="cw-series-card"><div className="cw-series-card-header"><span className="cw-series-name">{series.metricName}</span><span className="cw-series-points">{series.points.length} pts</span></div><Sparkline points={series.points} unit={series.unit} /><div className="cw-series-stats"><span>Latest: {formatMetricValue(series.points.at(-1)?.value ?? null, series.unit)}</span></div></div>)}</div>
            </div>
          )}

          <div className="cw-section">
            <div className="cw-section-head"><div><h3>Metric Summary</h3><p className="cw-section-subtitle">Search and compare aggregate values across the current telemetry window.</p></div></div>
            <FilterableTable columns={[{ key: 'metric', label: 'Metric', render: (row: CloudWatchMetricStatistic) => `${row.namespace} / ${row.metricName}` }, { key: 'latest', label: 'Latest', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.latest, row.unit) }, { key: 'average', label: 'Average', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.average, row.unit) }, { key: 'min', label: 'Min', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.min, row.unit) }, { key: 'max', label: 'Max', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.max, row.unit) }, { key: 'unit', label: 'Unit' }]} data={filteredStats} />
          </div>

          <div className="cw-section">
            <div className="cw-section-head"><div><h3>Log Groups</h3><p className="cw-section-subtitle">Double-click a group to inspect recent events and add it to the query target list.</p></div><div className="cw-query-headline"><span className="cw-toolbar-pill">{formatBytes(totalStoredBytes)}</span></div></div>
            <FilterableTable columns={[{ key: 'name', label: 'Name' }, { key: 'retentionInDays', label: 'Retention', render: (row: CloudWatchLogGroupSummary) => row.retentionInDays !== null ? `${row.retentionInDays} days` : 'Never expire' }, { key: 'storedBytes', label: 'Stored', render: (row: CloudWatchLogGroupSummary) => formatBytes(row.storedBytes) }, { key: 'logClass', label: 'Class' }]} data={logGroups} onDoubleClick={(row) => openLogGroupTab(row as unknown as CloudWatchLogGroupSummary)} hint="Double-click to inspect the recent event stream." />
          </div>
        </>
      ) : (
        <LogGroupViewer connection={connection} logGroupName={activeTab.name} timeRange={timeRange} onInvestigate={(logGroupName) => { setSelectedQueryLogGroups([logGroupName]); setQuerySourceLabel(logGroupName); setQueryDraft(defaultQuery(queryServiceHint, logGroupName)); setActiveTabIndex(0) }} />
      )}
    </div>
  )
}
