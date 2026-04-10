import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import './terraform.css'

import type { AwsConnection, CloudTrailEventSummary, CloudTrailSummary } from '@shared/types'
import { listTrails, lookupCloudTrailEvents } from './api'
import { SvcState } from './SvcState'

type ColKey =
  | 'eventTime'
  | 'eventName'
  | 'eventSource'
  | 'username'
  | 'sourceIpAddress'
  | 'awsRegion'
  | 'resourceType'
  | 'resourceName'
  | 'readOnly'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'eventTime', label: 'Time', color: '#3b82f6' },
  { key: 'eventName', label: 'Event', color: '#14b8a6' },
  { key: 'eventSource', label: 'Source', color: '#8b5cf6' },
  { key: 'username', label: 'User', color: '#22c55e' },
  { key: 'sourceIpAddress', label: 'Source IP', color: '#f59e0b' },
  { key: 'awsRegion', label: 'Region', color: '#06b6d4' },
  { key: 'resourceType', label: 'Resource type', color: '#a855f7' },
  { key: 'resourceName', label: 'Resource', color: '#ec4899' },
  { key: 'readOnly', label: 'Read only', color: '#64748b' }
]

function cellVal(ev: CloudTrailEventSummary, key: ColKey): string {
  if (key === 'eventTime') return ev.eventTime !== '-' ? new Date(ev.eventTime).toLocaleString() : '-'
  if (key === 'readOnly') return ev.readOnly ? 'Yes' : 'No'
  return ev[key] || '-'
}

function formatWindowLabel(startDate: string, startTime: string, endDate: string, endTime: string): string {
  return `${startDate} ${startTime} to ${endDate} ${endTime}`
}

function formatTrailMode(trail: CloudTrailSummary): string {
  return `${trail.isLogging ? 'Logging' : 'Stopped'} | ${trail.isMultiRegion ? 'Multi-region' : 'Single-region'}`
}

export function CloudTrailConsole({ connection }: { connection: AwsConnection }) {
  const [trails, setTrails] = useState<CloudTrailSummary[]>([])
  const [events, setEvents] = useState<CloudTrailEventSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((c) => c.key)))

  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  })
  const [startTime, setStartTime] = useState('00:00')
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [endTime, setEndTime] = useState('23:59')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const start = new Date(`${startDate}T${startTime}:00`).toISOString()
      const end = new Date(`${endDate}T${endTime}:59`).toISOString()
      const [trailList, eventList] = await Promise.all([
        listTrails(connection),
        lookupCloudTrailEvents(connection, start, end)
      ])
      setTrails(trailList)
      setEvents(eventList)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [connection.sessionId, connection.region])

  const activeCols = useMemo(() => COLUMNS.filter((c) => visCols.has(c.key)), [visCols])

  const filteredEvents = useMemo(() => {
    if (!filter) return events
    const q = filter.toLowerCase()
    return events.filter((ev) => activeCols.some((c) => cellVal(ev, c.key).toLowerCase().includes(q)))
  }, [events, filter, activeCols])

  const stats = useMemo(() => {
    const writeEvents = events.filter((event) => !event.readOnly).length
    const readEvents = events.length - writeEvents
    const loggingTrails = trails.filter((trail) => trail.isLogging).length
    const validatedTrails = trails.filter((trail) => trail.hasLogFileValidation).length
    const latestEvent = [...events]
      .filter((event) => event.eventTime && event.eventTime !== '-')
      .sort((a, b) => new Date(b.eventTime).getTime() - new Date(a.eventTime).getTime())[0]

    return {
      writeEvents,
      readEvents,
      loggingTrails,
      validatedTrails,
      latestEventTime: latestEvent ? new Date(latestEvent.eventTime).toLocaleString() : 'No events loaded',
      uniqueUsers: new Set(events.map((event) => event.username).filter((name) => name && name !== '-')).size
    }
  }, [events, trails])

  const windowLabel = formatWindowLabel(startDate, startTime, endDate, endTime)

  return (
    <div className="tf-console ct-console">
      <section className="tf-shell-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">CloudTrail service</div>
          <h2>Trail inventory and event explorer</h2>
          <p>
            Inspect recording posture, validate which trails are actively writing, and search raw event history
            without leaving the service screen.
          </p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.profile}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Query window</span>
              <strong>{windowLabel}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Columns</span>
              <strong>{activeCols.length} visible</strong>
            </div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent">
            <span>Trails</span>
            <strong>{trails.length}</strong>
            <small>{stats.loggingTrails} currently logging</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Events</span>
            <strong>{events.length}</strong>
            <small>{filteredEvents.length} visible in explorer</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Write activity</span>
            <strong>{stats.writeEvents}</strong>
            <small>{stats.readEvents} read-only events in the same window</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Validated trails</span>
            <strong>{stats.validatedTrails}</strong>
            <small>{stats.uniqueUsers} distinct actors observed</small>
          </div>
        </div>
      </section>

      <div className="tf-shell-toolbar">
        <div className="tf-toolbar">
          <button className="tf-toolbar-btn accent" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading...' : 'Fetch Events'}
          </button>
          <div className="ct-toolbar-note">
            Pull trail metadata and event history for the current time range. Existing filters and visible columns stay
            applied after refresh.
          </div>
        </div>
        <div className="tf-shell-status">
          <div className="ct-toolbar-summary">
            <span>Latest event</span>
            <strong>{stats.latestEventTime}</strong>
          </div>
        </div>
      </div>

      {error && <SvcState variant="error" error={error} />}

      <div className="tf-main-layout">
        <aside className="tf-project-table-area ct-trails-pane">
          <div className="tf-pane-head">
            <div>
              <span className="tf-pane-kicker">Trail inventory</span>
              <h3>Recording posture</h3>
            </div>
            <span className="tf-pane-summary">{trails.length} total</span>
          </div>

          {loading && trails.length === 0 ? (
            <SvcState variant="loading" resourceName="trails" />
          ) : trails.length === 0 ? (
            <SvcState
              variant="empty"
              resourceName="trails"
              message="No CloudTrail trails were returned for this connection."
            />
          ) : (
            <div className="tf-project-list">
              {trails.map((trail) => (
                <article key={trail.name} className="ct-trail-card">
                  <div className="ct-trail-card-head">
                    <div>
                      <div className="ct-trail-name">{trail.name}</div>
                      <div className="ct-trail-caption">{trail.homeRegion || connection.region}</div>
                    </div>
                    <span className={`ct-trail-status ${trail.isLogging ? 'is-live' : 'is-idle'}`}>
                      {trail.isLogging ? 'Logging' : 'Stopped'}
                    </span>
                  </div>
                  <div className="ct-trail-metrics">
                    <span>{trail.isMultiRegion ? 'Multi-region' : 'Single-region'}</span>
                    <span>{trail.hasLogFileValidation ? 'Validation on' : 'Validation off'}</span>
                  </div>
                  <div className="ct-trail-detail-grid">
                    <div>
                      <span>Bucket</span>
                      <strong title={trail.s3BucketName || '-'}>{trail.s3BucketName || '-'}</strong>
                    </div>
                    <div>
                      <span>Mode</span>
                      <strong>{formatTrailMode(trail)}</strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </aside>

        <section className="tf-detail-pane ct-detail-pane">
          <section className="tf-detail-hero">
            <div className="tf-detail-hero-copy">
              <div className="eyebrow">Event posture</div>
              <h3>CloudTrail event explorer</h3>
              <p>
                Use the same query workflow as before, but with a clearer split between time range controls, column
                visibility, and the resulting event stream.
              </p>
              <div className="tf-detail-meta-strip">
                <div className="tf-detail-meta-pill">
                  <span>Search filter</span>
                  <strong>{filter || 'No free-text filter'}</strong>
                </div>
                <div className="tf-detail-meta-pill">
                  <span>Visible columns</span>
                  <strong>{activeCols.map((col) => col.label).join(', ')}</strong>
                </div>
                <div className="tf-detail-meta-pill">
                  <span>Window</span>
                  <strong>{windowLabel}</strong>
                </div>
                <div className="tf-detail-meta-pill">
                  <span>Results</span>
                  <strong>{filteredEvents.length} rows</strong>
                </div>
              </div>
            </div>
            <div className="tf-detail-hero-stats">
              <div className="tf-detail-stat-card info">
                <span>Visible rows</span>
                <strong>{filteredEvents.length}</strong>
                <small>Across the active filter and selected columns</small>
              </div>
              <div className="tf-detail-stat-card success">
                <span>Write events</span>
                <strong>{stats.writeEvents}</strong>
                <small>Mutating API calls in the current range</small>
              </div>
              <div className="tf-detail-stat-card">
                <span>Read events</span>
                <strong>{stats.readEvents}</strong>
                <small>Read-only access patterns in the same range</small>
              </div>
              <div className="tf-detail-stat-card">
                <span>Actors</span>
                <strong>{stats.uniqueUsers}</strong>
                <small>Unique usernames present in returned events</small>
              </div>
            </div>
          </section>

          <div className="tf-section">
            <div className="tf-section-head">
              <div>
                <h3>Query Window</h3>
                <div className="tf-section-hint">
                  Update the start and end timestamps, then refresh to pull a new CloudTrail event set.
                </div>
              </div>
            </div>
            <div className="ct-controls">
              <div className="ct-range-row">
                <label className="ct-range-field">
                  <span>From</span>
                  <div className="ct-datetime">
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                    <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                  </div>
                </label>
                <label className="ct-range-field">
                  <span>To</span>
                  <div className="ct-datetime">
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                    <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                  </div>
                </label>
              </div>
              <label className="ct-range-field">
                <span>Filter rows</span>
                <input
                  className="ct-filter-input"
                  placeholder="Search across the currently visible columns..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <div className="ct-column-strip">
                {COLUMNS.map((col) => {
                  const active = visCols.has(col.key)
                  return (
                    <button
                      key={col.key}
                      className={`ct-column-chip ${active ? 'active' : ''}`}
                      type="button"
                      style={active ? ({ '--ct-chip-color': col.color } as CSSProperties) : undefined}
                      onClick={() =>
                        setVisCols((prev) => {
                          const next = new Set(prev)
                          if (next.has(col.key)) next.delete(col.key)
                          else next.add(col.key)
                          return next
                        })
                      }
                    >
                      {col.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="tf-section ct-events-panel">
            <div className="tf-section-head ct-events-panel-head">
              <div>
                <h3>Event Stream</h3>
                <div className="tf-section-hint">
                  Rows remain query-identical to the existing screen. This update only changes layout and visual
                  hierarchy.
                </div>
              </div>
              <div className="ct-table-summary">
                Showing {filteredEvents.length} of {events.length}
              </div>
            </div>

            {activeCols.length === 0 ? (
              <div className="ct-events-state">
                <SvcState
                  variant="unsupported"
                  message="Select at least one visible column to render the event stream."
                />
              </div>
            ) : loading && events.length === 0 ? (
              <div className="ct-events-state">
                <SvcState variant="loading" resourceName="events" />
              </div>
            ) : !loading && filteredEvents.length === 0 ? (
              <div className="ct-events-state">
                <SvcState
                  variant={events.length === 0 ? 'empty' : 'no-filter-matches'}
                  resourceName="events"
                  message={events.length === 0 ? 'No events were returned for the selected range.' : undefined}
                />
              </div>
            ) : (
              <div className="svc-table-area ct-events-table-area">
                <table className="svc-table ct-events-table">
                  <thead>
                    <tr>
                      {activeCols.map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEvents.map((ev) => (
                      <tr key={ev.eventId}>
                        {activeCols.map((c) => (
                          <td key={c.key} title={cellVal(ev, c.key)}>
                            {c.key === 'readOnly' ? (
                              <span className={`ct-event-badge ${ev.readOnly ? 'is-read' : 'is-write'}`}>
                                {ev.readOnly ? 'Yes' : 'No'}
                              </span>
                            ) : (
                              cellVal(ev, c.key)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
