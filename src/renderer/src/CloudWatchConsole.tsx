import { useEffect, useMemo, useState } from 'react'

import type {
  AwsConnection,
  CloudWatchDatapoint,
  CloudWatchLogEventSummary,
  CloudWatchLogGroupSummary,
  CloudWatchMetricStatistic,
  CloudWatchMetricSummary,
  CloudWatchNamespaceSummary,
  CloudWatchMetricSeries
} from '@shared/types'
import {
  getEc2AllMetricSeries,
  getMetricStatistics,
  listCloudWatchLogGroups,
  listCloudWatchMetrics,
  listCloudWatchRecentEvents,
  listEc2InstanceMetrics
} from './api'
import { formatDateTime } from './AwsPage'
import './cloudwatch.css'

type TimeRange = 1 | 3 | 12 | 24 | 72 | 168
type OpenTab = { type: 'overview' } | { type: 'log-group'; name: string }
type ExpandedChart =
  | { type: 'namespaces' }
  | { type: 'storage' }
  | { type: 'series'; metricName: string }

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
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
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

function formatTooltipTime(value: string): string {
  return new Date(value).toLocaleString()
}

function matchesEc2LogGroup(logGroup: CloudWatchLogGroupSummary, instanceId: string): boolean {
  const needle = instanceId.toLowerCase()
  return logGroup.name.toLowerCase().includes(needle) || logGroup.arn.toLowerCase().includes(needle)
}

/* ── Sparkline SVG ────────────────────────────────────────── */

function Sparkline({
  points,
  unit,
  width = 120,
  height = 32,
  interactive = false
}: {
  points: CloudWatchDatapoint[]
  unit: string
  width?: number
  height?: number
  interactive?: boolean
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  if (points.length < 2) return <span className="cw-no-data">No data</span>

  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = width / (points.length - 1)
  const plotted = points.map((point, index) => {
    const x = index * stepX
    const y = height - ((point.value - min) / range) * (height - 4) - 2
    return { ...point, x, y }
  })

  const pathData = plotted
    .map((point, index) => {
      return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
    })
    .join(' ')
  const hoveredPoint = hoverIndex === null ? null : plotted[hoverIndex]

  function handleMove(event: React.MouseEvent<SVGRectElement>): void {
    if (!interactive) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const ratio = bounds.width > 0 ? x / bounds.width : 0
    const nextIndex = Math.max(0, Math.min(plotted.length - 1, Math.round(ratio * (plotted.length - 1))))
    setHoverIndex(nextIndex)
  }

  return (
    <div className={`cw-sparkline-wrap ${interactive ? 'interactive' : ''}`}>
      {interactive && hoveredPoint && (
        <div className="cw-sparkline-tooltip">
          <strong>{formatMetricValue(hoveredPoint.value, unit)}</strong>
          <span>{formatTooltipTime(hoveredPoint.timestamp)}</span>
        </div>
      )}
      <svg className="cw-sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <path d={pathData} fill="none" stroke="#4a8fe7" strokeWidth="1.5" />
        {interactive && hoveredPoint && (
          <>
            <line
              x1={hoveredPoint.x}
              y1={0}
              x2={hoveredPoint.x}
              y2={height}
              stroke="rgba(123, 184, 245, 0.45)"
              strokeDasharray="4 4"
            />
            <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r={4} fill="#7bb8f5" stroke="#0f1114" strokeWidth="2" />
          </>
        )}
        {interactive && (
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="transparent"
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
          />
        )}
      </svg>
    </div>
  )
}

/* ── Bar Chart (CSS) ──────────────────────────────────────── */

function BarChart({ items, labelKey, valueKey }: {
  items: Array<Record<string, unknown>>
  labelKey: string
  valueKey: string
}) {
  const maxVal = Math.max(...items.map((it) => Number(it[valueKey]) || 0), 1)

  return (
    <div className="cw-bar-chart">
      {items.map((item, i) => {
        const value = Number(item[valueKey]) || 0
        const pct = (value / maxVal) * 100
        return (
          <div key={i} className="cw-bar-row">
            <div className="cw-bar-fill" style={{ width: `${Math.max(pct, 2)}%` }} />
            <span className="cw-bar-label">{String(item[labelKey])}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ── Filterable Table ─────────────────────────────────────── */

function FilterableTable<T extends Record<string, unknown>>({
  columns,
  data,
  onDoubleClick,
  hint
}: {
  columns: { key: string; label: string; render?: (row: T) => string }[]
  data: T[]
  onDoubleClick?: (row: T) => void
  hint?: string
}) {
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    if (!filter) return data
    const lower = filter.toLowerCase()
    return data.filter((row) =>
      columns.some((col) => {
        const val = col.render ? col.render(row) : String(row[col.key] ?? '')
        return val.toLowerCase().includes(lower)
      })
    )
  }, [data, filter, columns])

  return (
    <div className="cw-table-section">
      <input
        className="cw-table-filter"
        placeholder="Filter rows across selected columns..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="cw-column-chips">
        {columns.map((col) => (
          <span key={col.key} className="cw-chip">{col.label}</span>
        ))}
      </div>
      {hint && <p className="cw-table-hint">{hint}</p>}
      <div className="cw-table-scroll">
        <table className="cw-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={columns.length} className="cw-empty">No data</td></tr>
            ) : (
              filtered.map((row, i) => (
                <tr
                  key={i}
                  onDoubleClick={onDoubleClick ? () => onDoubleClick(row) : undefined}
                  className={onDoubleClick ? 'cw-clickable' : ''}
                >
                  {columns.map((col) => (
                    <td key={col.key}>{col.render ? col.render(row) : String(row[col.key] ?? '-')}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── Log Group Viewer ─────────────────────────────────────── */

function LogGroupViewer({
  connection,
  logGroupName,
  timeRange
}: {
  connection: AwsConnection
  logGroupName: string
  timeRange: TimeRange
}) {
  const [events, setEvents] = useState<CloudWatchLogEventSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchFilter, setSearchFilter] = useState('')
  const [groupByStream, setGroupByStream] = useState(false)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const result = await listCloudWatchRecentEvents(connection, logGroupName)
      setEvents(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [connection.profile, connection.region, logGroupName, timeRange])

  const filtered = useMemo(() => {
    if (!searchFilter) return events
    const lower = searchFilter.toLowerCase()
    return events.filter(
      (e) =>
        e.message.toLowerCase().includes(lower) ||
        e.logStreamName.toLowerCase().includes(lower)
    )
  }, [events, searchFilter])

  const streamGroups = useMemo(() => {
    if (!groupByStream) return null
    const map = new Map<string, CloudWatchLogEventSummary[]>()
    for (const event of filtered) {
      const existing = map.get(event.logStreamName) ?? []
      existing.push(event)
      map.set(event.logStreamName, existing)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered, groupByStream])

  function getSeverity(message: string): string {
    const lower = message.toLowerCase()
    if (lower.includes('error') || lower.includes('fatal') || lower.includes('exception')) return 'error'
    if (lower.includes('warn')) return 'warn'
    if (lower.includes('debug') || lower.includes('trace')) return 'debug'
    return 'info'
  }

  if (loading) return <div className="cw-loading">Loading log events...</div>
  if (error) return <div className="error-banner">{error}</div>

  return (
    <div className="cw-log-viewer">
      <div className="cw-log-viewer-header">
        <h3>{logGroupName}</h3>
        <span className="cw-log-count">{filtered.length} events</span>
      </div>

      <div className="cw-log-controls">
        <input
          className="cw-table-filter"
          placeholder="Search log messages..."
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
        />
        <button
          type="button"
          className={groupByStream ? 'cw-toggle active' : 'cw-toggle'}
          onClick={() => setGroupByStream(!groupByStream)}
        >
          Group by Stream
        </button>
        <button type="button" className="cw-toggle" onClick={() => void load()}>Refresh</button>
      </div>

      {groupByStream && streamGroups ? (
        <div className="cw-stream-groups">
          {streamGroups.map(([streamName, streamEvents]) => (
            <div key={streamName} className="cw-stream-group">
              <div className="cw-stream-header">
                <span className="cw-stream-name">{streamName}</span>
                <span className="cw-stream-count">{streamEvents.length} events</span>
              </div>
              <div className="cw-log-entries">
                {streamEvents.map((event, i) => (
                  <div key={`${event.eventId}-${i}`} className={`cw-log-entry cw-severity-${getSeverity(event.message)}`}>
                    <span className="cw-log-time">{formatDateTime(event.timestamp)}</span>
                    <pre className="cw-log-message">{event.message}</pre>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="cw-log-entries">
          {filtered.map((event, i) => (
            <div key={`${event.eventId}-${i}`} className={`cw-log-entry cw-severity-${getSeverity(event.message)}`}>
              <div className="cw-log-entry-header">
                <span className="cw-log-time">{formatDateTime(event.timestamp)}</span>
                <span className="cw-log-stream">{event.logStreamName}</span>
              </div>
              <pre className="cw-log-message">{event.message}</pre>
            </div>
          ))}
          {filtered.length === 0 && <div className="cw-empty-logs">No log events found in the selected time range.</div>}
        </div>
      )}
    </div>
  )
}

/* ── Main Console ─────────────────────────────────────────── */

export function CloudWatchConsole({
  connection,
  ec2InstanceId
}: {
  connection: AwsConnection
  ec2InstanceId?: string
}) {
  const [timeRange, setTimeRange] = useState<TimeRange>(24)
  const [namespaceFilter, setNamespaceFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Data state
  const [namespaces, setNamespaces] = useState<CloudWatchNamespaceSummary[]>([])
  const [metrics, setMetrics] = useState<CloudWatchMetricSummary[]>([])
  const [logGroups, setLogGroups] = useState<CloudWatchLogGroupSummary[]>([])
  const [metricStats, setMetricStats] = useState<CloudWatchMetricStatistic[]>([])
  const [ec2Series, setEc2Series] = useState<CloudWatchMetricSeries[]>([])

  // Tab state
  const [tabs, setTabs] = useState<OpenTab[]>([{ type: 'overview' }])
  const [activeTabIndex, setActiveTabIndex] = useState(0)
  const [expandedChart, setExpandedChart] = useState<ExpandedChart | null>(null)

  const isEc2Mode = !!ec2InstanceId

  async function load() {
    setLoading(true)
    setError('')
    try {
      if (isEc2Mode) {
        const [ec2Metrics, nextLogGroups] = await Promise.all([
          listEc2InstanceMetrics(connection, ec2InstanceId!),
          listCloudWatchLogGroups(connection)
        ])
        setMetrics(ec2Metrics)
        setLogGroups(nextLogGroups.filter((group) => matchesEc2LogGroup(group, ec2InstanceId!)))

        // Build namespace summary from EC2 metrics
        const nsMap = new Map<string, { count: number; keys: Set<string> }>()
        for (const m of ec2Metrics) {
          const existing = nsMap.get(m.namespace) ?? { count: 0, keys: new Set() }
          existing.count += 1
          for (const d of m.dimensions) existing.keys.add(d.split('=')[0])
          nsMap.set(m.namespace, existing)
        }
        setNamespaces(
          Array.from(nsMap.entries())
            .map(([ns, v]) => ({ namespace: ns, metricCount: v.count, dimensionKeys: Array.from(v.keys) }))
            .sort((a, b) => b.metricCount - a.metricCount)
        )

        // Fetch stats and series in parallel
        const [stats, series] = await Promise.all([
          getMetricStatistics(connection, ec2Metrics, timeRange),
          getEc2AllMetricSeries(connection, ec2InstanceId!, timeRange)
        ])
        setMetricStats(stats)
        setEc2Series(series)
      } else {
        const [metricData, nextLogGroups] = await Promise.all([
          listCloudWatchMetrics(connection),
          listCloudWatchLogGroups(connection)
        ])
        setNamespaces(metricData.namespaces)
        setMetrics(metricData.metrics)
        setLogGroups(nextLogGroups)

        // Fetch metric stats
        const stats = await getMetricStatistics(connection, metricData.metrics, timeRange)
        setMetricStats(stats)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [connection.profile, connection.region, timeRange, ec2InstanceId, isEc2Mode])

  useEffect(() => {
    setTabs([{ type: 'overview' }])
    setActiveTabIndex(0)
    setNamespaceFilter('all')
    setExpandedChart(null)
  }, [ec2InstanceId, connection.profile, connection.region])

  // Filtered metric stats based on namespace filter
  const filteredStats = useMemo(() => {
    if (namespaceFilter === 'all') return metricStats
    return metricStats.filter((s) => s.namespace === namespaceFilter)
  }, [metricStats, namespaceFilter])

  // Top log groups by storage
  const topLogGroupsByStorage = useMemo(
    () => [...logGroups].sort((a, b) => b.storedBytes - a.storedBytes).slice(0, 8),
    [logGroups]
  )

  // EC2 series for sparklines in the metrics table
  const seriesMap = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const s of ec2Series) {
      map.set(s.metricName, s.points.map((p) => p.value))
    }
    return map
  }, [ec2Series])

  function openLogGroupTab(group: CloudWatchLogGroupSummary) {
    const existing = tabs.findIndex((t) => t.type === 'log-group' && t.name === group.name)
    if (existing >= 0) {
      setActiveTabIndex(existing)
    } else {
      const newTabs = [...tabs, { type: 'log-group' as const, name: group.name }]
      setTabs(newTabs)
      setActiveTabIndex(newTabs.length - 1)
    }
  }

  function closeTab(index: number) {
    if (index === 0) return // Can't close Overview
    const newTabs = tabs.filter((_, i) => i !== index)
    setTabs(newTabs)
    if (activeTabIndex >= newTabs.length) {
      setActiveTabIndex(newTabs.length - 1)
    } else if (activeTabIndex === index) {
      setActiveTabIndex(Math.max(0, index - 1))
    }
  }

  const activeTab = tabs[activeTabIndex]
  const expandedSeries = expandedChart?.type === 'series'
    ? ec2Series.find((series) => series.metricName === expandedChart.metricName) ?? null
    : null

  return (
    <div className="cw-console">
      {error && <div className="error-banner">{error}</div>}

      {/* Tab bar */}
      <div className="cw-tab-bar">
        <div className="cw-tabs">
          {tabs.map((tab, i) => (
            <button
              key={i}
              type="button"
              className={`cw-tab ${i === activeTabIndex ? 'active' : ''}`}
              onClick={() => setActiveTabIndex(i)}
            >
              <span>{tab.type === 'overview' ? 'Overview' : tab.name}</span>
              {tab.type !== 'overview' && (
                <span
                  className="cw-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeTab(i) }}
                >
                  x
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="cw-toolbar">
          <select
            className="cw-time-select"
            value={timeRange}
            onChange={(e) => setTimeRange(Number(e.target.value) as TimeRange)}
          >
            {TIME_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {!isEc2Mode && (
            <select
              className="cw-ns-select"
              value={namespaceFilter}
              onChange={(e) => setNamespaceFilter(e.target.value)}
            >
              <option value="all">All Namespaces</option>
              {namespaces.map((ns) => (
                <option key={ns.namespace} value={ns.namespace}>{ns.namespace}</option>
              ))}
            </select>
          )}
          {isEc2Mode && (
            <span className="cw-ec2-badge">{ec2InstanceId}</span>
          )}
        </div>
      </div>

      {/* Overview tab */}
      {activeTab?.type === 'overview' && (
        <>
          {/* Charts row */}
          <div className="cw-charts-row">
            <div className="cw-chart-panel">
              <div className="cw-panel-head">
                <div>
                  <h3>Metric Namespaces</h3>
                  <p className="cw-chart-subtitle">Discovered metric families by namespace.</p>
                </div>
                <button type="button" className="cw-expand-btn" onClick={() => setExpandedChart({ type: 'namespaces' })}>Expand</button>
              </div>
              {loading ? (
                <div className="cw-loading">Loading...</div>
              ) : (
                <BarChart
                  items={namespaces.map((ns) => ({ label: ns.namespace, value: ns.metricCount }))}
                  labelKey="label"
                  valueKey="value"
                />
              )}
            </div>
            <div className="cw-chart-panel">
              <div className="cw-panel-head">
                <div>
                  <h3>Top Log Group Storage</h3>
                  <p className="cw-chart-subtitle">Largest matching log groups by stored bytes.</p>
                </div>
                <button type="button" className="cw-expand-btn" onClick={() => setExpandedChart({ type: 'storage' })}>Expand</button>
              </div>
              {loading ? (
                <div className="cw-loading">Loading...</div>
              ) : (
                <BarChart
                  items={topLogGroupsByStorage.map((g) => ({ label: g.name, value: g.storedBytes }))}
                  labelKey="label"
                  valueKey="value"
                />
              )}
            </div>
          </div>

          {/* EC2 Series Charts (only in EC2 mode) */}
          {isEc2Mode && ec2Series.length > 0 && (
            <div className="cw-series-section">
              <h3>EC2 Metric Series</h3>
              <div className="cw-series-grid">
                {ec2Series.map((series) => (
                  <div key={series.metricName} className="cw-series-card">
                    <div className="cw-series-card-header">
                      <span className="cw-series-name">{series.metricName}</span>
                      <div className="cw-series-card-actions">
                        <span className="cw-series-points">{series.points.length} pts</span>
                        <button type="button" className="cw-expand-btn" onClick={() => setExpandedChart({ type: 'series', metricName: series.metricName })}>Expand</button>
                      </div>
                    </div>
                    <Sparkline points={series.points} unit={series.unit} width={200} height={48} />
                    {series.points.length > 0 && (
                      <div className="cw-series-stats">
                        <span>Latest: {formatMetricValue(series.points[series.points.length - 1].value, series.unit)}</span>
                        <span>Min: {formatMetricValue(Math.min(...series.points.map((p) => p.value)), series.unit)}</span>
                        <span>Max: {formatMetricValue(Math.max(...series.points.map((p) => p.value)), series.unit)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Metric Summary */}
          <div className="cw-section">
            <h3>Metric Summary</h3>
            <FilterableTable
              columns={[
                { key: 'metric', label: 'Metric', render: (row: CloudWatchMetricStatistic) => `${row.namespace} / ${row.metricName}` },
                { key: 'latest', label: 'Latest', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.latest, row.unit) },
                { key: 'average', label: 'Average', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.average, row.unit) },
                { key: 'min', label: 'Min', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.min, row.unit) },
                { key: 'max', label: 'Max', render: (row: CloudWatchMetricStatistic) => formatMetricValue(row.max, row.unit) },
                { key: 'unit', label: 'Unit' },
                ...(isEc2Mode
                  ? [{
                      key: 'trend' as const,
                      label: 'Trend',
                      render: (row: CloudWatchMetricStatistic) => {
                        const pts = seriesMap.get(row.metricName)
                        return pts ? '__sparkline__' : ''
                      }
                    }]
                  : [])
              ]}
              data={filteredStats}
            />
          </div>

          {/* Log Groups */}
          <div className="cw-section">
            <h3>Log Groups</h3>
            <FilterableTable
              columns={[
                { key: 'name', label: 'Name' },
                {
                  key: 'retentionInDays',
                  label: 'RetentionDays',
                  render: (row: CloudWatchLogGroupSummary) => row.retentionInDays !== null ? String(row.retentionInDays) : 'Never expire'
                },
                {
                  key: 'storedBytes',
                  label: 'StoredBytes',
                  render: (row: CloudWatchLogGroupSummary) => formatBytes(row.storedBytes)
                },
                { key: 'logClass', label: 'Class' },
                {
                  key: 'arn',
                  label: 'Arn',
                  render: (row: CloudWatchLogGroupSummary) =>
                    row.arn.length > 40 ? `${row.arn.slice(0, 20)}...${row.arn.slice(-16)}` : row.arn
                }
              ]}
              data={logGroups}
              onDoubleClick={(row) => openLogGroupTab(row as unknown as CloudWatchLogGroupSummary)}
              hint="Double-click a log group to open its recent events in a new tab."
            />
            {isEc2Mode && logGroups.length === 0 && (
              <div className="cw-table-hint">No log groups matched EC2 instance `{ec2InstanceId}`.</div>
            )}
          </div>
        </>
      )}

      {/* Log group tabs */}
      {activeTab?.type === 'log-group' && (
        <LogGroupViewer
          connection={connection}
          logGroupName={activeTab.name}
          timeRange={timeRange}
        />
      )}

      {expandedChart && (
        <div className="cw-overlay" role="dialog" aria-modal="true">
          <div className="cw-overlay-backdrop" onClick={() => setExpandedChart(null)} />
          <div className="cw-overlay-panel">
            <div className="cw-overlay-header">
              <h3>
                {expandedChart.type === 'namespaces' && 'Metric Namespaces'}
                {expandedChart.type === 'storage' && 'Top Log Group Storage'}
                {expandedChart.type === 'series' && expandedChart.metricName}
              </h3>
              <button type="button" className="cw-expand-btn" onClick={() => setExpandedChart(null)}>Close</button>
            </div>
            {expandedChart.type === 'namespaces' && (
              <BarChart
                items={namespaces.map((ns) => ({ label: ns.namespace, value: ns.metricCount }))}
                labelKey="label"
                valueKey="value"
              />
            )}
            {expandedChart.type === 'storage' && (
              <BarChart
                items={topLogGroupsByStorage.map((g) => ({ label: g.name, value: g.storedBytes }))}
                labelKey="label"
                valueKey="value"
              />
            )}
            {expandedSeries && (
              <div className="cw-overlay-series">
                <Sparkline points={expandedSeries.points} unit={expandedSeries.unit} width={960} height={220} interactive />
                <div className="cw-overlay-series-stats">
                  <span>Latest: {formatMetricValue(expandedSeries.points[expandedSeries.points.length - 1]?.value ?? null, expandedSeries.unit)}</span>
                  <span>Min: {formatMetricValue(Math.min(...expandedSeries.points.map((p) => p.value)), expandedSeries.unit)}</span>
                  <span>Max: {formatMetricValue(Math.max(...expandedSeries.points.map((p) => p.value)), expandedSeries.unit)}</span>
                  <span>Points: {expandedSeries.points.length}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
