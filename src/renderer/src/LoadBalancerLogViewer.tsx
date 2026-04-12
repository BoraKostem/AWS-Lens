import { useCallback, useMemo, useState } from 'react'

import { queryLoadBalancerLogs } from './api'
import './lb-logs.css'

import type {
  AwsConnection,
  CloudProviderId,
  LoadBalancerLogEntry,
  LoadBalancerLogFilter,
  LoadBalancerLogQuery,
  LoadBalancerLogResult
} from '@shared/types'

/* ---------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

function defaultTimeRange(): { startTime: string; endTime: string } {
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
  return {
    startTime: toLocalIso(start),
    endTime: toLocalIso(end)
  }
}

function toLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toIsoUtc(localDatetime: string): string {
  if (!localDatetime) return new Date().toISOString()
  return new Date(localDatetime).toISOString()
}

function formatTimestamp(ts: string): string {
  if (!ts) return '-'
  try {
    const d = new Date(ts)
    return d.toLocaleString(undefined, { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions)
  } catch {
    return ts
  }
}

function formatMs(ms: number): string {
  if (ms < 0) return '-'
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function statusClass(code: number): string {
  if (code >= 200 && code < 300) return 'lb-status-2xx'
  if (code >= 300 && code < 400) return 'lb-status-3xx'
  if (code >= 400 && code < 500) return 'lb-status-4xx'
  if (code >= 500) return 'lb-status-5xx'
  return ''
}

/* ---------------------------------------------------------------------------
 * Entry detail modal
 * -------------------------------------------------------------------------*/

function EntryDetailModal({ entry, onClose }: { entry: LoadBalancerLogEntry; onClose: () => void }) {
  const fields: Array<[string, string]> = [
    ['Timestamp', formatTimestamp(entry.timestamp)],
    ['Client', `${entry.clientIp}:${entry.clientPort}`],
    ['Target', `${entry.targetIp}:${entry.targetPort}`],
    ['Method', entry.httpMethod],
    ['URL', entry.requestUrl],
    ['Status', `${entry.statusCode} (target: ${entry.targetStatusCode})`],
    ['Sent', formatBytes(entry.sentBytes)],
    ['Received', formatBytes(entry.receivedBytes)],
    ['Request Time', formatMs(entry.requestProcessingTime)],
    ['Target Time', formatMs(entry.targetProcessingTime)],
    ['Response Time', formatMs(entry.responseProcessingTime)],
    ['User Agent', entry.userAgent],
    ['SSL', `${entry.sslProtocol} / ${entry.sslCipher}`],
    ['Target Group', entry.targetGroupArn],
    ['Trace ID', entry.traceId],
    ['Domain', entry.domainName],
    ['Actions', entry.actionsExecuted],
    ['Error', entry.errorReason],
    ['Provider', entry.provider.toUpperCase()]
  ]

  return (
    <div className="lb-logs-detail" onClick={onClose}>
      <div className="lb-logs-detail-panel" onClick={(e) => e.stopPropagation()}>
        <h3>Log Entry Detail</h3>
        <table>
          <tbody>
            {fields.filter(([, v]) => v && v !== '-' && v !== '0' && v !== ':0').map(([label, value]) => (
              <tr key={label}><td>{label}</td><td>{value}</td></tr>
            ))}
          </tbody>
        </table>
        <h4>Raw</h4>
        <pre>{entry.raw}</pre>
        <button type="button" className="lb-logs-detail-close" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Main component
 * -------------------------------------------------------------------------*/

type SortField = 'timestamp' | 'statusCode' | 'requestProcessingTime' | 'sentBytes'
type SortDir = 'asc' | 'desc'

export function LoadBalancerLogViewer({
  provider,
  loadBalancerIdentifier,
  connection,
  gcpProjectId,
  azureWorkspaceId
}: {
  provider: CloudProviderId
  loadBalancerIdentifier: string
  connection?: AwsConnection
  gcpProjectId?: string
  azureWorkspaceId?: string
}) {
  const defaults = defaultTimeRange()
  const [startTime, setStartTime] = useState(defaults.startTime)
  const [endTime, setEndTime] = useState(defaults.endTime)

  // Filters
  const [statusCodeRange, setStatusCodeRange] = useState<'' | '2xx' | '3xx' | '4xx' | '5xx'>('')
  const [clientIp, setClientIp] = useState('')
  const [httpMethod, setHttpMethod] = useState('')
  const [requestUrlPattern, setRequestUrlPattern] = useState('')
  const [minResponseTimeMs, setMinResponseTimeMs] = useState<number | ''>('')
  const [searchText, setSearchText] = useState('')

  // State
  const [result, setResult] = useState<LoadBalancerLogResult | null>(null)
  const [allEntries, setAllEntries] = useState<LoadBalancerLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedEntry, setSelectedEntry] = useState<LoadBalancerLogEntry | null>(null)
  const [nextToken, setNextToken] = useState<string | undefined>()

  // Sort
  const [sortField, setSortField] = useState<SortField>('timestamp')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const buildQuery = useCallback((token?: string): LoadBalancerLogQuery => {
    const filter: LoadBalancerLogFilter = {}
    if (statusCodeRange) filter.statusCodeRange = statusCodeRange
    if (clientIp.trim()) filter.clientIp = clientIp.trim()
    if (httpMethod) filter.httpMethod = httpMethod
    if (requestUrlPattern.trim()) filter.requestUrlPattern = requestUrlPattern.trim()
    if (typeof minResponseTimeMs === 'number' && minResponseTimeMs > 0) filter.minResponseTimeMs = minResponseTimeMs
    if (searchText.trim()) filter.searchText = searchText.trim()

    return {
      loadBalancerIdentifier,
      provider,
      timeRange: {
        startTime: toIsoUtc(startTime),
        endTime: toIsoUtc(endTime)
      },
      filter,
      maxResults: 200,
      nextToken: token
    }
  }, [loadBalancerIdentifier, provider, startTime, endTime, statusCodeRange, clientIp, httpMethod, requestUrlPattern, minResponseTimeMs, searchText])

  const runQuery = useCallback(async (append = false) => {
    setLoading(true)
    setError('')
    try {
      const token = append ? nextToken : undefined
      const q = buildQuery(token)
      const res = await queryLoadBalancerLogs(connection, q, { gcpProjectId, azureWorkspaceId })
      setResult(res)
      setNextToken(res.nextToken)
      if (append) {
        setAllEntries((prev) => [...prev, ...res.entries])
      } else {
        setAllEntries(res.entries)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [buildQuery, connection, gcpProjectId, azureWorkspaceId, nextToken])

  const sorted = useMemo(() => {
    const copy = [...allEntries]
    copy.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'timestamp': cmp = a.timestamp.localeCompare(b.timestamp); break
        case 'statusCode': cmp = a.statusCode - b.statusCode; break
        case 'requestProcessingTime': cmp = a.requestProcessingTime - b.requestProcessingTime; break
        case 'sentBytes': cmp = a.sentBytes - b.sentBytes; break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [allEntries, sortField, sortDir])

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const sortIndicator = (field: SortField) => sortField === field ? (sortDir === 'asc' ? ' ^' : ' v') : ''

  return (
    <div className="lb-logs">
      {/* Filter controls */}
      <div className="lb-logs-controls">
        <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} title="Start time" />
        <span>to</span>
        <input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} title="End time" />
        <select value={statusCodeRange} onChange={(e) => setStatusCodeRange(e.target.value as typeof statusCodeRange)} title="Status code filter">
          <option value="">All statuses</option>
          <option value="2xx">2xx</option>
          <option value="3xx">3xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
        </select>
        <select value={httpMethod} onChange={(e) => setHttpMethod(e.target.value)} title="HTTP method">
          <option value="">All methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="DELETE">DELETE</option>
          <option value="PATCH">PATCH</option>
          <option value="HEAD">HEAD</option>
          <option value="OPTIONS">OPTIONS</option>
        </select>
        <input type="text" placeholder="Client IP..." value={clientIp} onChange={(e) => setClientIp(e.target.value)} title="Client IP filter" />
        <input type="text" placeholder="URL pattern (regex)..." value={requestUrlPattern} onChange={(e) => setRequestUrlPattern(e.target.value)} title="Request URL regex" />
        <input type="number" placeholder="Min ms" value={minResponseTimeMs} onChange={(e) => setMinResponseTimeMs(e.target.value ? Number(e.target.value) : '')} title="Minimum response time (ms)" />
        <input type="text" placeholder="Search text..." value={searchText} onChange={(e) => setSearchText(e.target.value)} title="Free text search" />
        <button type="button" onClick={() => runQuery(false)} disabled={loading}>
          {loading ? 'Loading...' : 'Query Logs'}
        </button>
      </div>

      {/* Error */}
      {error && <div className="lb-logs-error">{error}</div>}

      {/* Summary */}
      {result && (
        <div className="lb-logs-summary">
          <span>{allEntries.length} entries ({result.totalScanned} scanned)</span>
          {Object.entries(result.statusCodeDistribution).sort().map(([bucket, count]) => (
            <span key={bucket} className={`lb-status-chip lb-status-${bucket}`}>{bucket}: {count}</span>
          ))}
        </div>
      )}

      {/* Notes */}
      {result?.notes && result.notes.length > 0 && (
        <div className="lb-logs-notes">
          {result.notes.map((note, i) => <div key={i}>{note}</div>)}
        </div>
      )}

      {/* Loading */}
      {loading && !result && <div className="lb-logs-loading">Loading log entries...</div>}

      {/* Table */}
      {allEntries.length > 0 && (
        <div className="lb-logs-table-wrap">
          <table className="lb-logs-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort('timestamp')}>Time{sortIndicator('timestamp')}</th>
                <th>Method</th>
                <th onClick={() => toggleSort('statusCode')}>Status{sortIndicator('statusCode')}</th>
                <th className="lb-col-url">URL</th>
                <th>Client IP</th>
                <th>Target</th>
                <th onClick={() => toggleSort('requestProcessingTime')}>Latency{sortIndicator('requestProcessingTime')}</th>
                <th onClick={() => toggleSort('sentBytes')}>Sent{sortIndicator('sentBytes')}</th>
                <th className="lb-col-ua">User Agent</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry, idx) => (
                <tr key={idx} onDoubleClick={() => setSelectedEntry(entry)} style={{ cursor: 'pointer' }}>
                  <td>{formatTimestamp(entry.timestamp)}</td>
                  <td>{entry.httpMethod}</td>
                  <td><span className={statusClass(entry.statusCode)}>{entry.statusCode}</span></td>
                  <td className="lb-col-url" title={entry.requestUrl}>{entry.requestUrl}</td>
                  <td>{entry.clientIp}</td>
                  <td>{entry.targetIp}</td>
                  <td>{formatMs(entry.requestProcessingTime + entry.targetProcessingTime + entry.responseProcessingTime)}</td>
                  <td>{formatBytes(entry.sentBytes)}</td>
                  <td className="lb-col-ua" title={entry.userAgent}>{entry.userAgent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {result && allEntries.length === 0 && !loading && (
        <div className="lb-logs-empty">No log entries found for the selected time range and filters.</div>
      )}

      {/* Load more */}
      {nextToken && !loading && (
        <div className="lb-logs-load-more">
          <button type="button" onClick={() => runQuery(true)}>Load More</button>
        </div>
      )}

      {/* Detail modal */}
      {selectedEntry && <EntryDetailModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />}
    </div>
  )
}
