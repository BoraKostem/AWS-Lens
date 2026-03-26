import { useEffect, useMemo, useState } from 'react'

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

  const filteredRecords = useMemo(() => {
    if (!filter) return records
    const q = filter.toLowerCase()
    return records.filter(r => r.name.toLowerCase().includes(q) || r.type.toLowerCase().includes(q) || r.values.join(', ').toLowerCase().includes(q))
  }, [records, filter])

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

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">DNS Records</button>
        <button className="svc-tab right" type="button" onClick={() => void load()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* Zone selector */}
      <div className="svc-filter-bar">
        <span className="svc-filter-label">Zone</span>
        <select className="svc-select" value={selectedZone} onChange={e => void load(e.target.value)}>
          {zones.map(z => <option key={z.id} value={z.id}>{z.name} ({z.privateZone ? 'Private' : 'Public'} / {z.recordSetCount} records)</option>)}
        </select>
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

      <div className="svc-layout">
        <div className="svc-table-area">
          <table className="svc-table">
            <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}<th>Actions</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length + 1}>Gathering data</td></tr>}
              {!loading && filteredRecords.map(r => (
                <tr key={`${r.name}-${r.type}`}>
                  {activeCols.map(c => <td key={c.key} title={getVal(r, c.key)}>{getVal(r, c.key)}</td>)}
                  <td><button type="button" className="svc-btn danger" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => void removeRecord(r)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredRecords.length && !loading && <div className="svc-empty">No records found.</div>}
        </div>

        <div className="svc-sidebar">
          <div className="svc-section">
            <h3>Upsert Record</h3>
            <div className="svc-form">
              <label><span>Name</span><input value={draft.name} onChange={e => setDraft(c => ({ ...c, name: e.target.value }))} /></label>
              <label><span>Type</span><input value={draft.type} onChange={e => setDraft(c => ({ ...c, type: e.target.value.toUpperCase() }))} /></label>
              <label><span>TTL</span><input value={String(draft.ttl ?? 300)} onChange={e => setDraft(c => ({ ...c, ttl: Number(e.target.value) || 300 }))} /></label>
              <label><span>Values</span><textarea value={draft.values.join('\n')} onChange={e => setDraft(c => ({ ...c, values: e.target.value.split('\n') }))} placeholder="One value per line" /></label>
            </div>
            <button type="button" className="svc-btn success" disabled={!selectedZone || !draft.name} onClick={() => void saveRecord()}>Save Record</button>
          </div>
        </div>
      </div>
    </div>
  )
}
