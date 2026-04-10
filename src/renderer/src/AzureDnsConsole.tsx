import { useEffect, useMemo, useState } from 'react'
import './azure-dns.css'

import type {
  AzureDnsZoneSummary,
  AzureDnsRecordSummary,
  AzureDnsRecordUpsertInput
} from '@shared/types'
import {
  listAzureDnsZones,
  listAzureDnsRecordSets,
  upsertAzureDnsRecord,
  deleteAzureDnsRecord,
  createAzureDnsZone
} from './api'
import { SvcState } from './SvcState'

const COMMON_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'CAA', 'PTR']
const SYSTEM_RECORD_TYPES = new Set(['SOA', 'NS'])

const EMPTY_DRAFT: AzureDnsRecordUpsertInput = {
  name: '',
  type: 'A',
  ttl: 3600,
  values: ['']
}

export function AzureDnsConsole({
  subscriptionId,
  location,
  refreshNonce
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
}) {
  const [zones, setZones] = useState<AzureDnsZoneSummary[]>([])
  const [selectedZone, setSelectedZone] = useState<AzureDnsZoneSummary | null>(null)
  const [records, setRecords] = useState<AzureDnsRecordSummary[]>([])
  const [draft, setDraft] = useState<AzureDnsRecordUpsertInput>({ ...EMPTY_DRAFT })
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [showCreateZone, setShowCreateZone] = useState(false)
  const [newZoneName, setNewZoneName] = useState('')
  const [newZoneResourceGroup, setNewZoneResourceGroup] = useState('')
  const [newZoneType, setNewZoneType] = useState<'Public' | 'Private'>('Public')
  const [createZoneBusy, setCreateZoneBusy] = useState(false)

  async function loadZones(selectZoneName?: string) {
    setError('')
    setLoading(true)
    try {
      const nextZones = await listAzureDnsZones(subscriptionId, location)
      setZones(nextZones)
      const target = selectZoneName
        ? nextZones.find((z) => z.name === selectZoneName) ?? nextZones[0] ?? null
        : selectedZone
          ? nextZones.find((z) => z.name === selectedZone.name) ?? nextZones[0] ?? null
          : nextZones[0] ?? null
      setSelectedZone(target)
      if (target) {
        const nextRecords = await listAzureDnsRecordSets(subscriptionId, target.resourceGroup, target.name)
        setRecords(nextRecords)
      } else {
        setRecords([])
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }

  async function loadRecords(zone: AzureDnsZoneSummary) {
    setError('')
    setLoading(true)
    try {
      setRecords(await listAzureDnsRecordSets(subscriptionId, zone.resourceGroup, zone.name))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadZones()
  }, [subscriptionId, location, refreshNonce])

  const filteredRecords = useMemo(() => {
    if (!filter) return records
    const query = filter.toLowerCase()
    return records.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.type.toLowerCase().includes(query) ||
        r.values.some((v) => v.toLowerCase().includes(query))
    )
  }, [records, filter])

  const publicZoneCount = useMemo(() => zones.filter((z) => z.zoneType === 'Public').length, [zones])
  const privateZoneCount = useMemo(() => zones.filter((z) => z.zoneType !== 'Public').length, [zones])
  const topRecordTypes = useMemo(
    () =>
      Object.entries(
        filteredRecords.reduce<Record<string, number>>((acc, r) => {
          acc[r.type] = (acc[r.type] ?? 0) + 1
          return acc
        }, {})
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
    [filteredRecords]
  )

  function isSystemRecord(record: AzureDnsRecordSummary): boolean {
    return record.name === '@' && SYSTEM_RECORD_TYPES.has(record.type)
  }

  function editRecord(record: AzureDnsRecordSummary) {
    setDraft({
      name: record.name,
      type: record.type,
      ttl: record.ttl,
      values: record.values.length ? [...record.values] : ['']
    })
    setMsg(`Loaded ${record.name} (${record.type}) for editing.`)
    setError('')
  }

  async function saveRecord() {
    if (!selectedZone) return
    setError('')
    setMsg('')
    try {
      const input: AzureDnsRecordUpsertInput = {
        name: draft.name.trim() || '@',
        type: draft.type.trim().toUpperCase(),
        ttl: draft.ttl,
        values: draft.values.map((v) => v.trim()).filter(Boolean)
      }
      if (input.values.length === 0) throw new Error('At least one record value is required.')
      await upsertAzureDnsRecord(subscriptionId, selectedZone.resourceGroup, selectedZone.name, input)
      setDraft({ ...EMPTY_DRAFT })
      setMsg('Record saved.')
      await loadRecords(selectedZone)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  async function removeRecord(record: AzureDnsRecordSummary) {
    if (!selectedZone) return
    setError('')
    setMsg('')
    try {
      await deleteAzureDnsRecord(subscriptionId, selectedZone.resourceGroup, selectedZone.name, record.type, record.name)
      setMsg('Record deleted.')
      await loadRecords(selectedZone)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  async function handleCreateZone() {
    if (!newZoneName.trim() || !newZoneResourceGroup.trim()) return
    setCreateZoneBusy(true)
    setError('')
    setMsg('')
    try {
      const created = await createAzureDnsZone(subscriptionId, newZoneResourceGroup.trim(), newZoneName.trim(), newZoneType)
      setNewZoneName('')
      setNewZoneResourceGroup('')
      setShowCreateZone(false)
      setMsg(`Zone created: ${created.name}`)
      await loadZones(created.name)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setCreateZoneBusy(false)
    }
  }

  function handleZoneChange(zoneName: string) {
    const zone = zones.find((z) => z.name === zoneName) ?? null
    setSelectedZone(zone)
    if (zone) void loadRecords(zone)
  }

  return (
    <div className="svc-console azure-dns-console">
      <section className="azure-dns-hero">
        <div className="azure-dns-hero-copy">
          <span className="azure-dns-eyebrow">DNS Workspace</span>
          <h2>Azure DNS zones and record management.</h2>
          <p>Browse DNS zones, inspect record sets, create records, and manage zone-level settings across your subscription.</p>
          <div className="azure-dns-meta-strip">
            <div className="azure-dns-meta-pill"><span>Subscription</span><strong>{subscriptionId}</strong></div>
            <div className="azure-dns-meta-pill"><span>Zone Scope</span><strong>{selectedZone ? `${selectedZone.name} (${selectedZone.zoneType})` : 'No zone selected'}</strong></div>
          </div>
        </div>
        <div className="azure-dns-hero-stats">
          <div className="azure-dns-stat-card azure-dns-stat-card-accent"><span>DNS Zones</span><strong>{zones.length}</strong><small>{publicZoneCount} public, {privateZoneCount} private.</small></div>
          <div className="azure-dns-stat-card"><span>Visible Records</span><strong>{filteredRecords.length}</strong><small>{filter ? 'Filtered within the selected zone.' : 'Records in the selected zone.'}</small></div>
          <div className="azure-dns-stat-card"><span>Name Servers</span><strong>{selectedZone?.nameServers.length ?? 0}</strong><small>{selectedZone ? selectedZone.nameServers.slice(0, 2).join(', ') : 'Select a zone.'}</small></div>
          <div className="azure-dns-stat-card"><span>Top Types</span><strong>{topRecordTypes.map(([t]) => t).join(' / ') || '-'}</strong><small>{topRecordTypes.length ? topRecordTypes.map(([t, c]) => `${t}:${c}`).join('  ') : 'No records loaded yet.'}</small></div>
        </div>
      </section>

      <section className="azure-dns-toolbar">
        <div className="azure-dns-toolbar-main">
          <div className="azure-dns-field azure-dns-zone-field">
            <label htmlFor="azure-dns-zone">DNS zone</label>
            <select
              id="azure-dns-zone"
              className="svc-select"
              value={selectedZone?.name ?? ''}
              onChange={(e) => handleZoneChange(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z.name} value={z.name}>
                  {z.name} ({z.zoneType} / {z.resourceGroup} / {z.numberOfRecordSets} records)
                </option>
              ))}
            </select>
          </div>
          <div className="azure-dns-field azure-dns-search-field">
            <label htmlFor="azure-dns-filter">Search records</label>
            <input
              id="azure-dns-filter"
              className="svc-search"
              placeholder="Filter by name, type, or values"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>
        <div className="azure-dns-toolbar-actions">
          <button className="azure-dns-toolbar-btn" type="button" onClick={() => setDraft({ ...EMPTY_DRAFT })}>New Draft</button>
          <button className="azure-dns-toolbar-btn accent" type="button" onClick={() => void loadZones()}>Refresh</button>
          <button className="azure-dns-toolbar-btn" type="button" onClick={() => setShowCreateZone(!showCreateZone)}>
            {showCreateZone ? 'Hide Create Zone' : 'Create Zone'}
          </button>
        </div>
      </section>

      {showCreateZone && (
        <section className="azure-dns-panel">
          <div className="azure-dns-panel-head">
            <div>
              <span className="azure-dns-section-kicker">Zone Bootstrap</span>
              <h3>Create a new DNS zone</h3>
              <p>Create a public or private DNS zone in a resource group within this subscription.</p>
            </div>
          </div>
          <div className="azure-dns-bootstrap-grid">
            <label className="azure-dns-field">
              <span>Domain name</span>
              <input className="svc-search" value={newZoneName} onChange={(e) => setNewZoneName(e.target.value)} placeholder="example.com" />
            </label>
            <label className="azure-dns-field">
              <span>Resource group</span>
              <input className="svc-search" value={newZoneResourceGroup} onChange={(e) => setNewZoneResourceGroup(e.target.value)} placeholder="my-resource-group" />
            </label>
            <label className="azure-dns-field">
              <span>Zone type</span>
              <select className="svc-select" value={newZoneType} onChange={(e) => setNewZoneType(e.target.value as 'Public' | 'Private')}>
                <option value="Public">Public</option>
                <option value="Private">Private</option>
              </select>
            </label>
          </div>
          <div className="azure-dns-toolbar-actions">
            <button
              className="azure-dns-toolbar-btn accent"
              type="button"
              disabled={createZoneBusy || !newZoneName.trim() || !newZoneResourceGroup.trim()}
              onClick={() => void handleCreateZone()}
            >
              {createZoneBusy ? 'Creating...' : 'Create Zone'}
            </button>
            <button className="azure-dns-toolbar-btn" type="button" onClick={() => setShowCreateZone(false)}>Cancel</button>
          </div>
        </section>
      )}

      {msg && <div className="svc-msg route53-banner route53-banner-success">{msg}</div>}
      {error && <div className="svc-error route53-banner route53-banner-error">{error}</div>}

      {loading && records.length === 0 && <SvcState variant="loading" resourceName="DNS zones" />}
      {!loading && zones.length === 0 && <SvcState variant="empty" message="No DNS zones found in this subscription." />}
      {zones.length > 0 && (
        <div className="svc-layout azure-dns-layout">
          <div className="svc-table-area azure-dns-table-shell">
            <div className="azure-dns-table-header">
              <div className="azure-dns-table-header-main">
                <div>
                  <span className="azure-dns-section-kicker">Records</span>
                  <h3>Zone record sets</h3>
                  <p>{selectedZone?.name ?? 'Select a zone to view records.'}</p>
                </div>
                <div className="azure-dns-summary-strip">
                  <div className="azure-dns-summary-pill"><span>Visible</span><strong>{filteredRecords.length}</strong></div>
                  <div className="azure-dns-summary-pill"><span>Zone Type</span><strong><span className={`azure-dns-badge ${selectedZone?.zoneType === 'Public' ? 'azure-dns-badge-public' : 'azure-dns-badge-private'}`}>{selectedZone?.zoneType ?? '-'}</span></strong></div>
                </div>
              </div>
            </div>

            <table className="svc-table azure-dns-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>TTL</th>
                  <th>Values</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={5}>Gathering data</td></tr>}
                {!loading &&
                  filteredRecords.map((record) => (
                    <tr key={`${record.name}-${record.type}`}>
                      <td title={record.fqdn}>{record.name}</td>
                      <td>{record.type}</td>
                      <td>{record.ttl}</td>
                      <td title={record.values.join(', ')}>{record.values.join(', ') || '-'}</td>
                      <td>
                        <div className="azure-dns-row-actions">
                          <button type="button" className="azure-dns-inline-btn" onClick={() => editRecord(record)}>Edit</button>
                          {!isSystemRecord(record) && (
                            <button type="button" className="azure-dns-inline-btn danger" onClick={() => void removeRecord(record)}>Delete</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!filteredRecords.length && !loading && <div className="azure-dns-empty">No records found in the current view.</div>}
          </div>

          <aside className="svc-sidebar azure-dns-sidebar">
            <div className="svc-section azure-dns-form-shell">
              <div className="azure-dns-form-header">
                <span className="azure-dns-section-kicker">Inspector</span>
                <h3>Upsert record</h3>
                <p>Create or update a record set in the active DNS zone.</p>
              </div>

              <div className="svc-form azure-dns-form">
                <label className="azure-dns-form-row">
                  <span className="azure-dns-form-label">Name</span>
                  <input value={draft.name} onChange={(e) => setDraft((c) => ({ ...c, name: e.target.value }))} placeholder="@ for apex, or subdomain name" />
                </label>
                <label className="azure-dns-form-row">
                  <span className="azure-dns-form-label">Type</span>
                  <select className="svc-select" value={draft.type} onChange={(e) => setDraft((c) => ({ ...c, type: e.target.value }))}>
                    {COMMON_RECORD_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="azure-dns-form-row">
                  <span className="azure-dns-form-label">TTL</span>
                  <input value={String(draft.ttl)} onChange={(e) => setDraft((c) => ({ ...c, ttl: Number(e.target.value) || 3600 }))} />
                </label>
                <label className="azure-dns-form-row">
                  <span className="azure-dns-form-label">Values</span>
                  <textarea
                    value={draft.values.join('\n')}
                    onChange={(e) => setDraft((c) => ({ ...c, values: e.target.value.split('\n') }))}
                    placeholder="One value per line"
                  />
                </label>
              </div>

              <div className="azure-dns-form-actions">
                <button type="button" className="azure-dns-toolbar-btn" onClick={() => setDraft({ ...EMPTY_DRAFT })}>Reset</button>
                <button
                  type="button"
                  className="azure-dns-toolbar-btn accent"
                  disabled={!selectedZone || !draft.values.some((v) => v.trim())}
                  onClick={() => void saveRecord()}
                >
                  Save Record
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
