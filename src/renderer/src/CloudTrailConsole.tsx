import { useEffect, useMemo, useState } from 'react'

import type { AwsConnection, CloudTrailEventSummary, CloudTrailSummary } from '@shared/types'
import { listTrails, lookupCloudTrailEvents } from './api'

type ColKey = 'eventTime' | 'eventName' | 'eventSource' | 'username' | 'sourceIpAddress' | 'awsRegion' | 'resourceType' | 'resourceName' | 'readOnly'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'eventTime', label: 'Time', color: '#3b82f6' },
  { key: 'eventName', label: 'Event', color: '#14b8a6' },
  { key: 'eventSource', label: 'Source', color: '#8b5cf6' },
  { key: 'username', label: 'User', color: '#22c55e' },
  { key: 'sourceIpAddress', label: 'SourceIP', color: '#f59e0b' },
  { key: 'awsRegion', label: 'Region', color: '#06b6d4' },
  { key: 'resourceType', label: 'ResourceType', color: '#a855f7' },
  { key: 'resourceName', label: 'Resource', color: '#ec4899' },
  { key: 'readOnly', label: 'ReadOnly', color: '#64748b' },
]

function cellVal(ev: CloudTrailEventSummary, key: ColKey): string {
  if (key === 'eventTime') return ev.eventTime !== '-' ? new Date(ev.eventTime).toLocaleString() : '-'
  if (key === 'readOnly') return ev.readOnly ? 'Yes' : 'No'
  return ev[key] || '-'
}

export function CloudTrailConsole({ connection }: { connection: AwsConnection }) {
  const [trails, setTrails] = useState<CloudTrailSummary[]>([])
  const [events, setEvents] = useState<CloudTrailEventSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  const [startDate, setStartDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10) })
  const [startTime, setStartTime] = useState('00:00')
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [endTime, setEndTime] = useState('23:59')

  async function load() {
    setLoading(true); setError('')
    try {
      const start = new Date(`${startDate}T${startTime}:00`).toISOString()
      const end = new Date(`${endDate}T${endTime}:59`).toISOString()
      const [trailList, eventList] = await Promise.all([listTrails(connection), lookupCloudTrailEvents(connection, start, end)])
      setTrails(trailList); setEvents(eventList)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

useEffect(() => { void load() }, [connection.sessionId, connection.region])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))
  const filteredEvents = useMemo(() => {
    if (!filter) return events
    const q = filter.toLowerCase()
    return events.filter(ev => activeCols.some(c => cellVal(ev, c.key).toLowerCase().includes(q)))
  }, [events, filter, activeCols])

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Events</button>
        <button className="svc-tab right" type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      {error && <div className="svc-error">{error}</div>}

      {/* Stats + Trails */}
      <div className="svc-stat-strip">
        <div className="svc-stat-card"><span>Trails</span><strong>{trails.length}</strong></div>
        <div className="svc-stat-card"><span>Events</span><strong>{events.length}</strong></div>
        <div className="svc-stat-card"><span>Write Events</span><strong>{events.filter(e => !e.readOnly).length}</strong></div>
        {trails.map(t => (
          <div key={t.name} className="svc-stat-card">
            <span>{t.name}</span>
            <strong style={{ fontSize: 12 }}>{t.isLogging ? 'Logging' : 'Stopped'} | {t.isMultiRegion ? 'Multi' : 'Single'}</strong>
          </div>
        ))}
      </div>

      {/* Date range */}
      <div className="svc-panel">
        <div className="svc-inline">
          <label style={{ fontSize: 12, color: '#9ca7b7' }}>From</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: 140, height: 32, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', fontSize: 12, padding: '0 8px' }} />
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} style={{ width: 100, height: 32, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', fontSize: 12, padding: '0 8px' }} />
          <label style={{ fontSize: 12, color: '#9ca7b7' }}>To</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ width: 140, height: 32, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', fontSize: 12, padding: '0 8px' }} />
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} style={{ width: 100, height: 32, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', fontSize: 12, padding: '0 8px' }} />
          <button className="svc-btn primary" type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Loading...' : 'Fetch Events'}</button>
        </div>
      </div>

      <input className="svc-search" placeholder="Filter rows across selected columns..." value={filter} onChange={e => setFilter(e.target.value)} />

      <div className="svc-chips">
        {COLUMNS.map(col => (
          <button
            key={col.key}
            className={`svc-chip ${visCols.has(col.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
            onClick={() => setVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
          >{col.label}</button>
        ))}
      </div>

      <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
        <table className="svc-table">
          <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {filteredEvents.map(ev => (
              <tr key={ev.eventId}>
                {activeCols.map(c => (
                  <td key={c.key} title={cellVal(ev, c.key)}>
                    {c.key === 'readOnly' ? <span className={`svc-badge ${ev.readOnly ? 'muted' : 'warn'}`}>{ev.readOnly ? 'Yes' : 'No'}</span> : cellVal(ev, c.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !filteredEvents.length && <div className="svc-empty">{events.length === 0 ? 'No events in selected range.' : 'No events match filter.'}</div>}
      </div>
      {filteredEvents.length > 0 && <div style={{ fontSize: 11, color: '#9ca7b7', padding: '4px 0' }}>Showing {filteredEvents.length} of {events.length} events</div>}
    </div>
  )
}
