import { useEffect, useMemo, useState } from 'react'
import './route53.css'

import type { AwsConnection, Route53RecordChange } from '@shared/types'
import { deleteRoute53Record, listRoute53HostedZones, listRoute53Records, upsertRoute53Record } from './api'

type ColKey = 'name' | 'type' | 'ttl' | 'values' | 'routingPolicy'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'type', label: 'Type', color: '#14b8a6' },
  { key: 'ttl', label: 'TTL', color: '#f59e0b' },
  { key: 'values', label: 'Values', color: '#8b5cf6' },
  { key: 'routingPolicy', label: 'Routing', color: '#22c55e' },
]

const EMPTY_RECORD: Route53RecordChange = { name: '', type: 'A', ttl: 300, values: [''], isAlias: false, aliasDnsName: '', aliasHostedZoneId: '', evaluateTargetHealth: false, setIdentifier: '' }

function normalizeDnsName(value: string): string {
  return value.trim().replace(/\.+$/, '').toLowerCase()
}

function findBestZoneId(
  zones: Array<{ id: string; name: string; recordSetCount: number; privateZone: boolean }>,
  recordName: string
): string {
  const normalizedRecord = normalizeDnsName(recordName)
  const matches = zones.filter((zone) => normalizedRecord.endsWith(normalizeDnsName(zone.name)))
  return matches.sort((left, right) => normalizeDnsName(right.name).length - normalizeDnsName(left.name).length)[0]?.id ?? ''
}

export function Route53Console({
  connection,
  focusRecord
}: {
  connection: AwsConnection
  focusRecord?: { token: number; record: Route53RecordChange } | null
}) {
  const [zones, setZones] = useState<Array<{ id: string; name: string; recordSetCount: number; privateZone: boolean }>>([])
  const [loading, setLoading] = useState(false)
  const [selectedZone, setSelectedZone] = useState('')
  const [records, setRecords] = useState<Array<{ name: string; type: string; ttl: number | null; values: string[]; routingPolicy: string }>>([])
  const [draft, setDraft] = useState<Route53RecordChange>(EMPTY_RECORD)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)

  async function load(zoneId?: string) {
    setError('')
    setLoading(true)
    try {
      const nextZones = await listRoute53HostedZones(connection)
      setZones(nextZones)
      const resolved = zoneId || selectedZone || nextZones[0]?.id || ''
      setSelectedZone(resolved)
      setRecords(resolved ? await listRoute53Records(connection, resolved) : [])
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (!focusRecord || focusRecord.token === appliedFocusToken || zones.length === 0) {
      return
    }

    setAppliedFocusToken(focusRecord.token)
    setDraft({
      ...focusRecord.record,
      ttl: focusRecord.record.ttl ?? 300,
      values: focusRecord.record.values.length ? focusRecord.record.values : ['']
    })

    const matchedZoneId = findBestZoneId(zones, focusRecord.record.name)
    if (matchedZoneId) {
      void load(matchedZoneId)
    }
  }, [appliedFocusToken, focusRecord, zones])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))
  const selectedZoneMeta = useMemo(() => zones.find((zone) => zone.id === selectedZone) ?? null, [zones, selectedZone])

  const filteredRecords = useMemo(() => {
    if (!filter) return records
    const q = filter.toLowerCase()
    return records.filter(r => r.name.toLowerCase().includes(q) || r.type.toLowerCase().includes(q) || r.values.join(', ').toLowerCase().includes(q))
  }, [records, filter])

  const recordTypeSummary = useMemo(() => {
    return filteredRecords.reduce<Record<string, number>>((acc, record) => {
      acc[record.type] = (acc[record.type] ?? 0) + 1
      return acc
    }, {})
  }, [filteredRecords])

  const topRecordTypes = useMemo(
    () => Object.entries(recordTypeSummary).sort((left, right) => right[1] - left[1]).slice(0, 3),
    [recordTypeSummary]
  )

  const aliasCount = useMemo(
    () => records.filter((record) => record.routingPolicy.toLowerCase().includes('alias')).length,
    [records]
  )
  const activeDraftLabel = draft.name ? `Editing ${draft.name}` : 'New record draft'

  function getVal(r: typeof records[0], k: ColKey) {
    if (k === 'ttl') return r.ttl != null ? String(r.ttl) : '-'
    if (k === 'values') return r.values.join(', ') || '-'
    return r[k] ?? '-'
  }

  async function saveRecord() {
    if (!selectedZone) return
    setError('')
    try {
      await upsertRoute53Record(connection, selectedZone, { ...draft, values: draft.values.filter(Boolean) })
      setDraft(EMPTY_RECORD)
      setMsg('Record saved')
      await load(selectedZone)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function removeRecord(record: typeof records[0]) {
    if (!selectedZone) return
    setError('')
    try {
      await deleteRoute53Record(connection, selectedZone, { ...EMPTY_RECORD, name: record.name, type: record.type, ttl: record.ttl, values: record.values })
      setMsg('Record deleted')
      await load(selectedZone)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  function editRecord(record: typeof records[0]) {
    setDraft({
      ...EMPTY_RECORD,
      name: record.name,
      type: record.type,
      ttl: record.ttl ?? 300,
      values: record.values.length ? record.values : ['']
    })
    setMsg(`Loaded ${record.name} for editing`)
  }

  return (
    <div className="svc-console route53-console">
      <section className="route53-hero">
        <div className="route53-hero-copy">
          <span className="route53-eyebrow">DNS Workspace</span>
          <h2>Route 53 records aligned to the Terraform shell language.</h2>
          <p>
            Operate hosted zones from the same darker, denser workspace style used in Terraform:
            zone context first, records as the main surface, and edits in a focused inspector.
          </p>
          <div className="route53-meta-strip">
            <div className="route53-meta-pill">
              <span>Session</span>
              <strong>{connection.sessionId}</strong>
            </div>
            <div className="route53-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="route53-meta-pill">
              <span>Zone Scope</span>
              <strong>{selectedZoneMeta ? (selectedZoneMeta.privateZone ? 'Private hosted zone' : 'Public hosted zone') : 'Waiting for zone selection'}</strong>
            </div>
          </div>
        </div>

        <div className="route53-hero-stats">
          <div className="route53-stat-card route53-stat-card-accent">
            <span>Hosted Zones</span>
            <strong>{zones.length}</strong>
            <small>Discovered for the active AWS connection.</small>
          </div>
          <div className="route53-stat-card">
            <span>Visible Records</span>
            <strong>{filteredRecords.length}</strong>
            <small>{filter ? 'Filtered within the selected zone.' : 'Records in the selected zone.'}</small>
          </div>
          <div className="route53-stat-card">
            <span>Alias Policies</span>
            <strong>{aliasCount}</strong>
            <small>Records advertising alias-style routing policies.</small>
          </div>
          <div className="route53-stat-card">
            <span>Top Types</span>
            <strong>{topRecordTypes.map(([type]) => type).join(' / ') || '-'}</strong>
            <small>
              {topRecordTypes.length
                ? topRecordTypes.map(([type, count]) => `${type}:${count}`).join('  ')
                : 'No records loaded yet.'}
            </small>
          </div>
        </div>
      </section>

      <section className="route53-toolbar">
        <div className="route53-toolbar-main">
          <div className="route53-field route53-zone-field">
            <label htmlFor="route53-zone">Hosted zone</label>
            <select id="route53-zone" className="svc-select route53-select" value={selectedZone} onChange={e => void load(e.target.value)}>
              {zones.map(z => (
                <option key={z.id} value={z.id}>
                  {z.name} ({z.privateZone ? 'Private' : 'Public'} / {z.recordSetCount} records)
                </option>
              ))}
            </select>
          </div>

          <div className="route53-field route53-search-field">
            <label htmlFor="route53-filter">Search records</label>
            <input
              id="route53-filter"
              className="svc-search route53-search"
              placeholder="Filter by name, type, or values"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
          </div>
        </div>

        <div className="route53-toolbar-actions">
          <button className="route53-toolbar-btn" type="button" onClick={() => setDraft(EMPTY_RECORD)}>
            New Draft
          </button>
          <button className="route53-toolbar-btn accent" type="button" onClick={() => void load(selectedZone)}>
            Refresh
          </button>
        </div>
      </section>

      <div className="route53-chip-strip">
        {COLUMNS.map(col => (
          <button
            key={col.key}
            className={`route53-chip ${visCols.has(col.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(col.key) ? { ['--route53-chip' as const]: col.color } : undefined}
            onClick={() => setVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
          >
            {col.label}
          </button>
        ))}
      </div>

      {msg && <div className="svc-msg route53-banner route53-banner-success">{msg}</div>}
      {error && <div className="svc-error route53-banner route53-banner-error">{error}</div>}

      <div className="svc-layout route53-layout">
        <div className="svc-table-area route53-table-shell">
          <div className="route53-table-header">
            <div className="route53-table-header-main">
              <div>
                <span className="route53-section-kicker">Records</span>
                <h3>Selected zone inventory</h3>
                <p>{selectedZoneMeta?.name || 'Choose a hosted zone to inspect records and routing policies.'}</p>
              </div>
              <div className="route53-summary-strip">
                <div className="route53-summary-pill">
                  <span>Visible</span>
                  <strong>{filteredRecords.length}</strong>
                </div>
                <div className="route53-summary-pill">
                  <span>Policies</span>
                  <strong>{aliasCount ? `${aliasCount} alias` : 'Standard'}</strong>
                </div>
                <div className="route53-summary-pill">
                  <span>Columns</span>
                  <strong>{activeCols.length} active</strong>
                </div>
              </div>
            </div>
          </div>

          <table className="svc-table route53-table">
            <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}<th>Actions</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length + 1}>Gathering data</td></tr>}
              {!loading && filteredRecords.map(r => (
                <tr key={`${r.name}-${r.type}`}>
                  {activeCols.map(c => <td key={c.key} title={getVal(r, c.key)}>{getVal(r, c.key)}</td>)}
                  <td>
                    <div className="route53-row-actions">
                      <button type="button" className="route53-inline-btn" onClick={() => editRecord(r)}>Edit</button>
                      <button type="button" className="route53-inline-btn danger" onClick={() => void removeRecord(r)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredRecords.length && !loading && <div className="svc-empty route53-empty">No records found in the current view.</div>}
        </div>

        <aside className="svc-sidebar route53-sidebar">
          <div className="svc-section route53-form-shell">
            <div className="route53-form-header">
              <span className="route53-section-kicker">Inspector</span>
              <h3>Upsert record</h3>
              <p>Edit a selected DNS record or create a new one in the active hosted zone.</p>
              <div className="route53-inspector-strip">
                <div className="route53-summary-pill">
                  <span>Draft</span>
                  <strong>{activeDraftLabel}</strong>
                </div>
                <div className="route53-summary-pill">
                  <span>Zone</span>
                  <strong>{selectedZoneMeta?.name || '-'}</strong>
                </div>
              </div>
            </div>

            <div className="svc-form route53-form">
              <label className="route53-form-row">
                <span className="route53-form-label">Name</span>
                <input value={draft.name} onChange={e => setDraft(c => ({ ...c, name: e.target.value }))} />
              </label>
              <label className="route53-form-row">
                <span className="route53-form-label">Type</span>
                <input value={draft.type} onChange={e => setDraft(c => ({ ...c, type: e.target.value.toUpperCase() }))} />
              </label>
              <label className="route53-form-row">
                <span className="route53-form-label">TTL</span>
                <input value={String(draft.ttl ?? 300)} onChange={e => setDraft(c => ({ ...c, ttl: Number(e.target.value) || 300 }))} />
              </label>
              <label className="route53-form-row route53-form-row-textarea">
                <span className="route53-form-label">Values</span>
                <textarea value={draft.values.join('\n')} onChange={e => setDraft(c => ({ ...c, values: e.target.value.split('\n') }))} placeholder="One value per line" />
              </label>
            </div>

            <div className="route53-form-actions">
              <button type="button" className="route53-toolbar-btn" onClick={() => setDraft(EMPTY_RECORD)}>Reset</button>
              <button type="button" className="route53-toolbar-btn accent" disabled={!selectedZone || !draft.name} onClick={() => void saveRecord()}>
                Save Record
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
