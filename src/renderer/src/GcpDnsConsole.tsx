import { useEffect, useMemo, useState } from 'react'
import './gcp-dns.css'

import type {
  GcpDnsManagedZoneSummary,
  GcpDnsResourceRecordSetSummary,
  GcpDnsRecordUpsertInput
} from '@shared/types'
import {
  listGcpDnsManagedZones,
  listGcpDnsResourceRecordSets,
  createGcpDnsResourceRecordSet,
  updateGcpDnsResourceRecordSet,
  deleteGcpDnsResourceRecordSet
} from './api'
import { SvcState } from './SvcState'

const COMMON_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'CAA', 'PTR']
const NON_DELETABLE_APEX_TYPES = new Set(['SOA', 'NS'])

const EMPTY_DRAFT: GcpDnsRecordUpsertInput = {
  name: '',
  type: 'A',
  ttl: 300,
  rrdatas: ['']
}

export function GcpDnsConsole({
  projectId,
  location,
  refreshNonce
}: {
  projectId: string
  location: string
  refreshNonce: number
}) {
  const [zones, setZones] = useState<GcpDnsManagedZoneSummary[]>([])
  const [selectedZone, setSelectedZone] = useState<string>('')
  const [records, setRecords] = useState<GcpDnsResourceRecordSetSummary[]>([])
  const [draft, setDraft] = useState<GcpDnsRecordUpsertInput>({ ...EMPTY_DRAFT })
  const [isEditing, setIsEditing] = useState(false)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const selectedZoneMeta = useMemo(
    () => zones.find((z) => z.name === selectedZone) ?? null,
    [zones, selectedZone]
  )

  async function loadZones(selectZoneName?: string) {
    setError('')
    setLoading(true)
    try {
      const nextZones = await listGcpDnsManagedZones(projectId)
      setZones(nextZones)
      const target = selectZoneName || selectedZone || nextZones[0]?.name || ''
      setSelectedZone(target)
      if (target) {
        setRecords(await listGcpDnsResourceRecordSets(projectId, target))
      } else {
        setRecords([])
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }

  async function loadRecords(zoneName: string) {
    setError('')
    setLoading(true)
    try {
      setRecords(await listGcpDnsResourceRecordSets(projectId, zoneName))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadZones()
  }, [projectId, location, refreshNonce])

  const filteredRecords = useMemo(() => {
    if (!filter) return records
    const query = filter.toLowerCase()
    return records.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.type.toLowerCase().includes(query) ||
        r.rrdatas.some((v) => v.toLowerCase().includes(query))
    )
  }, [records, filter])

  const publicZoneCount = useMemo(() => zones.filter((z) => z.visibility === 'public').length, [zones])
  const privateZoneCount = useMemo(() => zones.filter((z) => z.visibility !== 'public').length, [zones])
  const dnssecEnabledCount = useMemo(() => zones.filter((z) => z.dnssecState === 'on').length, [zones])
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

  function isApexSystemRecord(record: GcpDnsResourceRecordSetSummary): boolean {
    return selectedZoneMeta != null && record.name === selectedZoneMeta.dnsName && NON_DELETABLE_APEX_TYPES.has(record.type)
  }

  function ensureTrailingDot(name: string): string {
    const trimmed = name.trim()
    return trimmed.endsWith('.') ? trimmed : `${trimmed}.`
  }

  function editRecord(record: GcpDnsResourceRecordSetSummary) {
    setDraft({
      name: record.name,
      type: record.type,
      ttl: record.ttl,
      rrdatas: record.rrdatas.length ? [...record.rrdatas] : ['']
    })
    setIsEditing(true)
    setMsg(`Loaded ${record.name} (${record.type}) for editing.`)
    setError('')
  }

  async function saveRecord() {
    if (!selectedZone) return
    setError('')
    setMsg('')
    try {
      const fqdn = selectedZoneMeta ? ensureTrailingDot(draft.name || selectedZoneMeta.dnsName) : ensureTrailingDot(draft.name)
      const input: GcpDnsRecordUpsertInput = {
        name: fqdn,
        type: draft.type.trim().toUpperCase(),
        ttl: draft.ttl,
        rrdatas: draft.rrdatas.map((v) => v.trim()).filter(Boolean)
      }
      if (input.rrdatas.length === 0) throw new Error('At least one record value is required.')

      if (isEditing) {
        await updateGcpDnsResourceRecordSet(projectId, selectedZone, input)
      } else {
        await createGcpDnsResourceRecordSet(projectId, selectedZone, input)
      }

      setDraft({ ...EMPTY_DRAFT })
      setIsEditing(false)
      setMsg('Record saved.')
      await loadRecords(selectedZone)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  async function removeRecord(record: GcpDnsResourceRecordSetSummary) {
    if (!selectedZone) return
    setError('')
    setMsg('')
    try {
      await deleteGcpDnsResourceRecordSet(projectId, selectedZone, record.name, record.type)
      setMsg('Record deleted.')
      await loadRecords(selectedZone)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  function handleZoneChange(zoneName: string) {
    setSelectedZone(zoneName)
    if (zoneName) void loadRecords(zoneName)
  }

  function startNewRecord() {
    setDraft({ ...EMPTY_DRAFT })
    setIsEditing(false)
  }

  return (
    <div className="svc-console gcp-dns-console">
      <section className="gcp-dns-hero">
        <div className="gcp-dns-hero-copy">
          <span className="gcp-dns-eyebrow">DNS Workspace</span>
          <h2>Cloud DNS zones and record management.</h2>
          <p>Browse managed zones, inspect resource record sets, and manage DNS entries across your GCP project.</p>
          <div className="gcp-dns-meta-strip">
            <div className="gcp-dns-meta-pill"><span>Project</span><strong>{projectId}</strong></div>
            <div className="gcp-dns-meta-pill">
              <span>Zone Scope</span>
              <strong>
                {selectedZoneMeta
                  ? `${selectedZoneMeta.dnsName} (${selectedZoneMeta.visibility})`
                  : 'No zone selected'}
              </strong>
            </div>
          </div>
        </div>
        <div className="gcp-dns-hero-stats">
          <div className="gcp-dns-stat-card gcp-dns-stat-card-accent"><span>Managed Zones</span><strong>{zones.length}</strong><small>{publicZoneCount} public, {privateZoneCount} private.</small></div>
          <div className="gcp-dns-stat-card"><span>Visible Records</span><strong>{filteredRecords.length}</strong><small>{filter ? 'Filtered within the selected zone.' : 'Records in the selected zone.'}</small></div>
          <div className="gcp-dns-stat-card"><span>DNSSEC Enabled</span><strong>{dnssecEnabledCount}</strong><small>{dnssecEnabledCount ? `${dnssecEnabledCount} of ${zones.length} zones protected.` : 'No zones with DNSSEC enabled.'}</small></div>
          <div className="gcp-dns-stat-card"><span>Top Types</span><strong>{topRecordTypes.map(([t]) => t).join(' / ') || '-'}</strong><small>{topRecordTypes.length ? topRecordTypes.map(([t, c]) => `${t}:${c}`).join('  ') : 'No records loaded yet.'}</small></div>
        </div>
      </section>

      <section className="gcp-dns-toolbar">
        <div className="gcp-dns-toolbar-main">
          <div className="gcp-dns-field gcp-dns-zone-field">
            <label htmlFor="gcp-dns-zone">Managed zone</label>
            <select
              id="gcp-dns-zone"
              className="svc-select"
              value={selectedZone}
              onChange={(e) => handleZoneChange(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z.name} value={z.name}>
                  {z.name} ({z.dnsName}) {z.visibility !== 'public' ? '[Private]' : ''} {z.dnssecState === 'on' ? '[DNSSEC]' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="gcp-dns-field gcp-dns-search-field">
            <label htmlFor="gcp-dns-filter">Search records</label>
            <input
              id="gcp-dns-filter"
              className="svc-search"
              placeholder="Filter by name, type, or values"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>
        <div className="gcp-dns-toolbar-actions">
          <button className="gcp-dns-toolbar-btn" type="button" onClick={startNewRecord}>New Draft</button>
          <button className="gcp-dns-toolbar-btn accent" type="button" onClick={() => void loadZones()}>Refresh</button>
        </div>
      </section>

      {msg && <div className="svc-msg route53-banner route53-banner-success">{msg}</div>}
      {error && <div className="svc-error route53-banner route53-banner-error">{error}</div>}

      {loading && records.length === 0 && <SvcState variant="loading" resourceName="DNS zones" />}
      {!loading && zones.length === 0 && <SvcState variant="empty" message="No managed DNS zones found in this project." />}
      {zones.length > 0 && (
        <div className="svc-layout gcp-dns-layout">
          <div className="svc-table-area gcp-dns-table-shell">
            <div className="gcp-dns-table-header">
              <div className="gcp-dns-table-header-main">
                <div>
                  <span className="gcp-dns-section-kicker">Records</span>
                  <h3>Resource record sets</h3>
                  <p>{selectedZoneMeta?.dnsName ?? 'Select a managed zone to view records.'}</p>
                </div>
                <div className="gcp-dns-summary-strip">
                  <div className="gcp-dns-summary-pill"><span>Visible</span><strong>{filteredRecords.length}</strong></div>
                  {selectedZoneMeta && (
                    <>
                      <div className="gcp-dns-summary-pill"><span>Visibility</span><strong><span className={`gcp-dns-badge ${selectedZoneMeta.visibility === 'public' ? 'gcp-dns-badge-public' : 'gcp-dns-badge-private'}`}>{selectedZoneMeta.visibility}</span></strong></div>
                      {selectedZoneMeta.dnssecState === 'on' && (
                        <div className="gcp-dns-summary-pill"><span>DNSSEC</span><strong><span className="gcp-dns-badge gcp-dns-badge-dnssec">enabled</span></strong></div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            <table className="svc-table gcp-dns-table">
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
                      <td title={record.name}>{record.name}</td>
                      <td>{record.type}</td>
                      <td>{record.ttl}</td>
                      <td title={record.rrdatas.join(', ')}>{record.rrdatas.join(', ') || '-'}</td>
                      <td>
                        <div className="gcp-dns-row-actions">
                          <button type="button" className="gcp-dns-inline-btn" onClick={() => editRecord(record)}>Edit</button>
                          {!isApexSystemRecord(record) && (
                            <button type="button" className="gcp-dns-inline-btn danger" onClick={() => void removeRecord(record)}>Delete</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!filteredRecords.length && !loading && <div className="gcp-dns-empty">No records found in the current view.</div>}
          </div>

          <aside className="svc-sidebar gcp-dns-sidebar">
            <div className="svc-section gcp-dns-form-shell">
              <div className="gcp-dns-form-header">
                <span className="gcp-dns-section-kicker">Inspector</span>
                <h3>{isEditing ? 'Update record' : 'Create record'}</h3>
                <p>{isEditing ? 'Modify an existing resource record set.' : 'Add a new resource record set to the active zone.'}</p>
              </div>

              <div className="svc-form gcp-dns-form">
                <label className="gcp-dns-form-row">
                  <span className="gcp-dns-form-label">Name (FQDN)</span>
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft((c) => ({ ...c, name: e.target.value }))}
                    placeholder={selectedZoneMeta ? selectedZoneMeta.dnsName : 'example.com.'}
                    disabled={isEditing}
                  />
                </label>
                <label className="gcp-dns-form-row">
                  <span className="gcp-dns-form-label">Type</span>
                  <select
                    className="svc-select"
                    value={draft.type}
                    onChange={(e) => setDraft((c) => ({ ...c, type: e.target.value }))}
                    disabled={isEditing}
                  >
                    {COMMON_RECORD_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="gcp-dns-form-row">
                  <span className="gcp-dns-form-label">TTL</span>
                  <input value={String(draft.ttl)} onChange={(e) => setDraft((c) => ({ ...c, ttl: Number(e.target.value) || 300 }))} />
                </label>
                <label className="gcp-dns-form-row">
                  <span className="gcp-dns-form-label">Values (rrdatas)</span>
                  <textarea
                    value={draft.rrdatas.join('\n')}
                    onChange={(e) => setDraft((c) => ({ ...c, rrdatas: e.target.value.split('\n') }))}
                    placeholder="One value per line"
                  />
                </label>
              </div>

              <div className="gcp-dns-form-actions">
                <button type="button" className="gcp-dns-toolbar-btn" onClick={startNewRecord}>Reset</button>
                <button
                  type="button"
                  className="gcp-dns-toolbar-btn accent"
                  disabled={!selectedZone || !draft.rrdatas.some((v) => v.trim())}
                  onClick={() => void saveRecord()}
                >
                  {isEditing ? 'Update Record' : 'Create Record'}
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
