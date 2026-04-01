import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import './route53.css'

import type {
  AwsConnection,
  Route53HostedZoneCreateInput,
  Route53HostedZoneSummary,
  Route53RecordChange,
  Route53RecordSummary,
  VpcSummary
} from '@shared/types'
import {
  createRoute53HostedZone,
  deleteRoute53Record,
  listRoute53HostedZones,
  listRoute53Records,
  listVpcs,
  openExternalUrl,
  upsertRoute53Record
} from './api'

type ColKey = 'name' | 'type' | 'ttl' | 'values' | 'routingPolicy'
type TemplateId = 'apex-alias' | 'www-cname' | 'mx-mail' | 'txt-verification'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'type', label: 'Type', color: '#14b8a6' },
  { key: 'ttl', label: 'TTL', color: '#f59e0b' },
  { key: 'values', label: 'Values', color: '#8b5cf6' },
  { key: 'routingPolicy', label: 'Routing', color: '#22c55e' }
]

const COMMON_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA']

const EMPTY_RECORD: Route53RecordChange = {
  name: '',
  type: 'A',
  ttl: 300,
  values: [''],
  isAlias: false,
  aliasDnsName: '',
  aliasHostedZoneId: '',
  evaluateTargetHealth: false,
  setIdentifier: ''
}

const EMPTY_BOOTSTRAP: Route53HostedZoneCreateInput = {
  domainName: '',
  comment: '',
  privateZone: false,
  vpcId: '',
  vpcRegion: ''
}

function normalizeDnsName(value: string): string {
  return value.trim().replace(/\.+$/, '').toLowerCase()
}

function zoneBaseName(name: string): string {
  return normalizeDnsName(name)
}

function findBestZoneId(zones: Route53HostedZoneSummary[], recordName: string): string {
  const normalizedRecord = normalizeDnsName(recordName)
  const matches = zones.filter((zone) => normalizedRecord.endsWith(normalizeDnsName(zone.name)))
  return matches.sort((left, right) => normalizeDnsName(right.name).length - normalizeDnsName(left.name).length)[0]?.id ?? ''
}

function getRecordValuesSummary(record: Route53RecordSummary): string {
  return record.isAlias ? (record.aliasDnsName || 'Alias target pending') : (record.values.join(', ') || '-')
}

function buildTemplateRecord(templateId: TemplateId, zoneName: string): Route53RecordChange {
  const zone = zoneBaseName(zoneName)
  switch (templateId) {
    case 'apex-alias':
      return { ...EMPTY_RECORD, name: zone, type: 'A', isAlias: true, aliasDnsName: 'dualstack.example-alb-123456.us-east-1.elb.amazonaws.com', aliasHostedZoneId: '', evaluateTargetHealth: true, values: [''] }
    case 'www-cname':
      return { ...EMPTY_RECORD, name: `www.${zone}`, type: 'CNAME', ttl: 300, values: [`${zone}.`] }
    case 'mx-mail':
      return { ...EMPTY_RECORD, name: zone, type: 'MX', ttl: 300, values: [`10 mail.${zone}.`] }
    case 'txt-verification':
      return { ...EMPTY_RECORD, name: `_verify.${zone}`, type: 'TXT', ttl: 300, values: ['"replace-with-verification-token"'] }
  }
}

function buildHealthCheckGuidance(draft: Route53RecordChange): string[] {
  const guidance: string[] = []
  if (draft.isAlias) guidance.push('Alias records ignore TTL. Supply both the target DNS name and hosted zone id, and only enable target health evaluation when the AWS target supports it.')
  else if (['A', 'AAAA', 'CNAME'].includes(draft.type)) guidance.push('A, AAAA, and CNAME records are the best fit for Route 53 health checks when you need DNS failover.')
  else guidance.push('MX, TXT, NS, and verification records usually do not need Route 53 health checks; focus on propagation and correctness.')
  if (draft.setIdentifier.trim()) guidance.push('A set identifier usually means weighted, failover, or latency routing. Keep identifiers unique and pair them with health checks when traffic movement matters.')
  else guidance.push('If this record may become weighted or failover-based later, add a set identifier now to avoid a disruptive rename.')
  guidance.push('Validate public DNS propagation with dig or nslookup before application cutover.')
  return guidance
}

export function Route53Console({
  connection,
  focusRecord
}: {
  connection: AwsConnection
  focusRecord?: { token: number; record: Route53RecordChange } | null
}) {
  const [zones, setZones] = useState<Route53HostedZoneSummary[]>([])
  const [vpcs, setVpcs] = useState<VpcSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [bootstrapBusy, setBootstrapBusy] = useState(false)
  const [selectedZone, setSelectedZone] = useState('')
  const [records, setRecords] = useState<Route53RecordSummary[]>([])
  const [draft, setDraft] = useState<Route53RecordChange>(EMPTY_RECORD)
  const [bootstrap, setBootstrap] = useState<Route53HostedZoneCreateInput>({ ...EMPTY_BOOTSTRAP, vpcRegion: connection.region })
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))
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
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }

  async function loadVpcChoices(): Promise<void> {
    try {
      setVpcs(await listVpcs(connection))
    } catch {
      setVpcs([])
    }
  }

  useEffect(() => {
    setBootstrap((current) => ({ ...current, vpcRegion: connection.region }))
    void Promise.all([load(), loadVpcChoices()])
  }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (!focusRecord || focusRecord.token === appliedFocusToken || zones.length === 0) return
    setAppliedFocusToken(focusRecord.token)
    setDraft({ ...focusRecord.record, ttl: focusRecord.record.ttl ?? 300, values: focusRecord.record.values.length ? focusRecord.record.values : [''] })
    const matchedZoneId = findBestZoneId(zones, focusRecord.record.name)
    if (matchedZoneId) void load(matchedZoneId)
  }, [appliedFocusToken, focusRecord, zones])

  const activeCols = COLUMNS.filter((column) => visCols.has(column.key))
  const selectedZoneMeta = useMemo(() => zones.find((zone) => zone.id === selectedZone) ?? null, [zones, selectedZone])
  const filteredRecords = useMemo(() => {
    if (!filter) return records
    const query = filter.toLowerCase()
    return records.filter((record) => record.name.toLowerCase().includes(query) || record.type.toLowerCase().includes(query) || getRecordValuesSummary(record).toLowerCase().includes(query))
  }, [records, filter])
  const topRecordTypes = useMemo(() => Object.entries(filteredRecords.reduce<Record<string, number>>((acc, record) => {
    acc[record.type] = (acc[record.type] ?? 0) + 1
    return acc
  }, {})).sort((left, right) => right[1] - left[1]).slice(0, 3), [filteredRecords])
  const aliasCount = useMemo(() => records.filter((record) => record.isAlias).length, [records])
  const privateZoneCount = useMemo(() => zones.filter((zone) => zone.privateZone).length, [zones])
  const healthGuidance = useMemo(() => buildHealthCheckGuidance(draft), [draft])
  const draftRecordTypeOptions = useMemo(() => [...new Set([...COMMON_RECORD_TYPES, draft.type.toUpperCase()])], [draft.type])

  function getVal(record: Route53RecordSummary, key: ColKey): string {
    if (key === 'ttl') return record.ttl != null ? String(record.ttl) : record.isAlias ? 'Alias' : '-'
    if (key === 'values') return getRecordValuesSummary(record)
    return record[key] ?? '-'
  }

  async function saveRecord() {
    if (!selectedZone) return
    setError('')
    setMsg('')
    try {
      const nextRecord: Route53RecordChange = {
        ...draft,
        name: draft.name.trim(),
        type: draft.type.trim().toUpperCase(),
        ttl: draft.isAlias ? null : draft.ttl ?? 300,
        values: draft.isAlias ? [] : draft.values.map((value) => value.trim()).filter(Boolean),
        aliasDnsName: draft.aliasDnsName.trim(),
        aliasHostedZoneId: draft.aliasHostedZoneId.trim(),
        setIdentifier: draft.setIdentifier.trim()
      }
      if (!nextRecord.name) throw new Error('Record name is required.')
      if (nextRecord.isAlias && (!nextRecord.aliasDnsName || !nextRecord.aliasHostedZoneId)) throw new Error('Alias records require both target DNS name and hosted zone id.')
      if (!nextRecord.isAlias && nextRecord.values.length === 0) throw new Error('At least one record value is required.')
      await upsertRoute53Record(connection, selectedZone, nextRecord)
      setDraft(EMPTY_RECORD)
      setMsg('Record saved.')
      await load(selectedZone)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  async function removeRecord(record: Route53RecordSummary) {
    if (!selectedZone) return
    setError('')
    setMsg('')
    try {
      await deleteRoute53Record(connection, selectedZone, {
        name: record.name,
        type: record.type,
        ttl: record.ttl,
        values: record.values,
        isAlias: record.isAlias,
        aliasDnsName: record.aliasDnsName,
        aliasHostedZoneId: record.aliasHostedZoneId,
        evaluateTargetHealth: record.evaluateTargetHealth,
        setIdentifier: record.setIdentifier
      })
      setMsg('Record deleted.')
      await load(selectedZone)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  function editRecord(record: Route53RecordSummary) {
    setDraft({
      name: record.name,
      type: record.type,
      ttl: record.ttl ?? 300,
      values: record.values.length ? record.values : [''],
      isAlias: record.isAlias,
      aliasDnsName: record.aliasDnsName,
      aliasHostedZoneId: record.aliasHostedZoneId,
      evaluateTargetHealth: record.evaluateTargetHealth,
      setIdentifier: record.setIdentifier
    })
    setMsg(`Loaded ${record.name} for editing.`)
    setError('')
  }

  function duplicateRecord(record: Route53RecordSummary) {
    setDraft({
      name: record.name,
      type: record.type,
      ttl: record.ttl ?? 300,
      values: record.values.length ? [...record.values] : [''],
      isAlias: record.isAlias,
      aliasDnsName: record.aliasDnsName,
      aliasHostedZoneId: record.aliasHostedZoneId,
      evaluateTargetHealth: record.evaluateTargetHealth,
      setIdentifier: ''
    })
    setMsg(`Duplicated ${record.name} into the draft.`)
    setError('')
  }

  function applyTemplate(templateId: TemplateId) {
    if (!selectedZoneMeta) {
      setError('Select a hosted zone before applying a DNS template.')
      return
    }
    setDraft(buildTemplateRecord(templateId, selectedZoneMeta.name))
    setMsg('Template loaded into the draft.')
    setError('')
  }

  async function createHostedZone() {
    setBootstrapBusy(true)
    setError('')
    setMsg('')
    try {
      const created = await createRoute53HostedZone(connection, {
        ...bootstrap,
        domainName: bootstrap.domainName.trim(),
        comment: bootstrap.comment.trim(),
        vpcId: bootstrap.privateZone ? bootstrap.vpcId.trim() : '',
        vpcRegion: bootstrap.privateZone ? connection.region : ''
      })
      setBootstrap({ ...EMPTY_BOOTSTRAP, vpcRegion: connection.region })
      setMsg(`Hosted zone created: ${created.name}`)
      await load(created.id)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setBootstrapBusy(false)
    }
  }

  return (
    <div className="svc-console route53-console">
      <section className="route53-hero">
        <div className="route53-hero-copy">
          <span className="route53-eyebrow">DNS Workspace</span>
          <h2>Route 53 now covers first-time setup, templates, and day-2 DNS edits.</h2>
          <p>Bootstrap hosted zones, draft common records from templates, and keep domain and health-check guidance in the same workspace.</p>
          <div className="route53-meta-strip">
            <div className="route53-meta-pill"><span>Session</span><strong>{connection.sessionId}</strong></div>
            <div className="route53-meta-pill"><span>Region</span><strong>{connection.region}</strong></div>
            <div className="route53-meta-pill"><span>Zone Scope</span><strong>{selectedZoneMeta ? (selectedZoneMeta.privateZone ? 'Private hosted zone' : 'Public hosted zone') : 'Waiting for zone selection'}</strong></div>
          </div>
        </div>
        <div className="route53-hero-stats">
          <div className="route53-stat-card route53-stat-card-accent"><span>Hosted Zones</span><strong>{zones.length}</strong><small>{privateZoneCount} private, {Math.max(0, zones.length - privateZoneCount)} public.</small></div>
          <div className="route53-stat-card"><span>Visible Records</span><strong>{filteredRecords.length}</strong><small>{filter ? 'Filtered within the selected zone.' : 'Records in the selected zone.'}</small></div>
          <div className="route53-stat-card"><span>Alias Policies</span><strong>{aliasCount}</strong><small>Records currently using Route 53 alias targets.</small></div>
          <div className="route53-stat-card"><span>Top Types</span><strong>{topRecordTypes.map(([type]) => type).join(' / ') || '-'}</strong><small>{topRecordTypes.length ? topRecordTypes.map(([type, count]) => `${type}:${count}`).join('  ') : 'No records loaded yet.'}</small></div>
        </div>
      </section>

      <section className="route53-toolbar">
        <div className="route53-toolbar-main">
          <div className="route53-field route53-zone-field">
            <label htmlFor="route53-zone">Hosted zone</label>
            <select id="route53-zone" className="svc-select route53-select" value={selectedZone} onChange={(event) => void load(event.target.value)}>
              {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name} ({zone.privateZone ? 'Private' : 'Public'} / {zone.recordSetCount} records)</option>)}
            </select>
          </div>
          <div className="route53-field route53-search-field">
            <label htmlFor="route53-filter">Search records</label>
            <input id="route53-filter" className="svc-search route53-search" placeholder="Filter by name, type, or values" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </div>
        </div>
        <div className="route53-toolbar-actions">
          <button className="route53-toolbar-btn" type="button" onClick={() => setDraft(EMPTY_RECORD)}>New Draft</button>
          <button className="route53-toolbar-btn accent" type="button" onClick={() => void load(selectedZone)}>Refresh</button>
        </div>
      </section>

      <div className="route53-chip-strip">
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            className={`route53-chip ${visCols.has(column.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(column.key) ? ({ ['--route53-chip' as const]: column.color } as CSSProperties) : undefined}
            onClick={() => setVisCols((previous) => {
              const next = new Set(previous)
              if (next.has(column.key)) next.delete(column.key)
              else next.add(column.key)
              return next
            })}
          >
            {column.label}
          </button>
        ))}
      </div>

      {msg && <div className="svc-msg route53-banner route53-banner-success">{msg}</div>}
      {error && <div className="svc-error route53-banner route53-banner-error">{error}</div>}

      <div className="route53-utility-grid">
        <section className="route53-panel route53-bootstrap-panel">
          <div className="route53-panel-head">
            <div>
              <span className="route53-section-kicker">Hosted Zone Bootstrap</span>
              <h3>Create a new zone</h3>
              <p>Start a public zone for a new domain or create a private zone tied to a VPC in the active region.</p>
            </div>
            <div className="route53-summary-pill"><span>VPC choices</span><strong>{vpcs.length}</strong></div>
          </div>
          <div className="route53-bootstrap-grid">
            <label className="route53-field">
              <span>Domain name</span>
              <input className="route53-search" value={bootstrap.domainName} onChange={(event) => setBootstrap((current) => ({ ...current, domainName: event.target.value }))} placeholder="example.com" />
            </label>
            <label className="route53-field">
              <span>Comment</span>
              <input className="route53-search" value={bootstrap.comment} onChange={(event) => setBootstrap((current) => ({ ...current, comment: event.target.value }))} placeholder="Optional hosted zone note" />
            </label>
            <label className="route53-checkbox">
              <input type="checkbox" checked={bootstrap.privateZone} onChange={(event) => setBootstrap((current) => ({ ...current, privateZone: event.target.checked, vpcId: event.target.checked ? current.vpcId : '' }))} />
              <span>Create as private hosted zone</span>
            </label>
            {bootstrap.privateZone && (
              <label className="route53-field">
                <span>Attach to VPC</span>
                <select className="svc-select route53-select" value={bootstrap.vpcId} onChange={(event) => setBootstrap((current) => ({ ...current, vpcId: event.target.value, vpcRegion: connection.region }))}>
                  <option value="">Select a VPC</option>
                  {vpcs.map((vpc) => <option key={vpc.vpcId} value={vpc.vpcId}>{vpc.vpcId} ({vpc.cidrBlock})</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="route53-toolbar-actions">
            <button className="route53-toolbar-btn accent" type="button" disabled={bootstrapBusy || !bootstrap.domainName.trim() || (bootstrap.privateZone && !bootstrap.vpcId)} onClick={() => void createHostedZone()}>
              {bootstrapBusy ? 'Creating...' : 'Create Hosted Zone'}
            </button>
            <button className="route53-toolbar-btn" type="button" onClick={() => setBootstrap({ ...EMPTY_BOOTSTRAP, vpcRegion: connection.region })}>Reset</button>
          </div>
        </section>

        <section className="route53-panel route53-handoff-panel">
          <div className="route53-panel-head">
            <div>
              <span className="route53-section-kicker">Domain Handoff</span>
              <h3>Registration and health-check guidance</h3>
              <p>Domain registration still starts outside this workspace. Use these handoffs, then return here for hosted zone and record work.</p>
            </div>
          </div>
          <div className="route53-toolbar-actions">
            <button className="route53-toolbar-btn" type="button" onClick={() => void openExternalUrl('https://console.aws.amazon.com/route53/domains/home')}>Open Route 53 Domains</button>
            <button className="route53-toolbar-btn" type="button" onClick={() => void openExternalUrl('https://console.aws.amazon.com/route53/healthchecks/home')}>Open Health Checks</button>
            <button className="route53-toolbar-btn" type="button" onClick={() => void openExternalUrl('https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-configuring-new-domain.html')}>Setup Guide</button>
          </div>
          <div className="route53-guidance-list">
            <div className="route53-guidance-card">Register or transfer the domain first, then confirm the hosted zone name servers before moving traffic.</div>
            <div className="route53-guidance-card">Create health checks before weighted or failover records so DNS reacts to origin health instead of static routing.</div>
            <div className="route53-guidance-card">Keep public and private zones separate for the same suffix unless split-horizon DNS is intentional and documented.</div>
          </div>
        </section>
      </div>

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
                <div className="route53-summary-pill"><span>Visible</span><strong>{filteredRecords.length}</strong></div>
                <div className="route53-summary-pill"><span>Policies</span><strong>{aliasCount ? `${aliasCount} alias` : 'Standard'}</strong></div>
                <div className="route53-summary-pill"><span>Columns</span><strong>{activeCols.length} active</strong></div>
              </div>
            </div>
          </div>

          <table className="svc-table route53-table">
            <thead><tr>{activeCols.map((column) => <th key={column.key}>{column.label}</th>)}<th>Actions</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length + 1}>Gathering data</td></tr>}
              {!loading && filteredRecords.map((record) => (
                <tr key={`${record.name}-${record.type}-${record.setIdentifier}`}>
                  {activeCols.map((column) => <td key={column.key} title={getVal(record, column.key)}>{getVal(record, column.key)}</td>)}
                  <td>
                    <div className="route53-row-actions">
                      <button type="button" className="route53-inline-btn" onClick={() => editRecord(record)}>Edit</button>
                      <button type="button" className="route53-inline-btn" onClick={() => duplicateRecord(record)}>Duplicate</button>
                      <button type="button" className="route53-inline-btn danger" onClick={() => void removeRecord(record)}>Delete</button>
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
                <div className="route53-summary-pill"><span>Draft</span><strong>{draft.name ? `Editing ${draft.name}` : 'New record draft'}</strong></div>
                <div className="route53-summary-pill"><span>Zone</span><strong>{selectedZoneMeta?.name || '-'}</strong></div>
              </div>
            </div>

            <div className="route53-template-strip">
              <button type="button" className="route53-template-btn" disabled={!selectedZoneMeta} onClick={() => applyTemplate('apex-alias')}>Apex Alias</button>
              <button type="button" className="route53-template-btn" disabled={!selectedZoneMeta} onClick={() => applyTemplate('www-cname')}>WWW CNAME</button>
              <button type="button" className="route53-template-btn" disabled={!selectedZoneMeta} onClick={() => applyTemplate('mx-mail')}>MX Starter</button>
              <button type="button" className="route53-template-btn" disabled={!selectedZoneMeta} onClick={() => applyTemplate('txt-verification')}>TXT Verify</button>
            </div>

            <div className="svc-form route53-form">
              <label className="route53-form-row">
                <span className="route53-form-label">Name</span>
                <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className="route53-form-row">
                <span className="route53-form-label">Type</span>
                <select className="svc-select route53-select" value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value.toUpperCase() }))}>
                  {draftRecordTypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label className="route53-checkbox route53-checkbox-inline">
                <input type="checkbox" checked={draft.isAlias} onChange={(event) => setDraft((current) => ({ ...current, isAlias: event.target.checked, ttl: event.target.checked ? null : (current.ttl ?? 300), values: event.target.checked ? [''] : current.values }))} />
                <span>Alias target</span>
              </label>
              {!draft.isAlias && (
                <label className="route53-form-row">
                  <span className="route53-form-label">TTL</span>
                  <input value={String(draft.ttl ?? 300)} onChange={(event) => setDraft((current) => ({ ...current, ttl: Number(event.target.value) || 300 }))} />
                </label>
              )}
              <label className="route53-form-row">
                <span className="route53-form-label">Set ID</span>
                <input value={draft.setIdentifier} onChange={(event) => setDraft((current) => ({ ...current, setIdentifier: event.target.value }))} placeholder="Optional routing identifier" />
              </label>

              {draft.isAlias ? (
                <>
                  <label className="route53-form-row route53-form-row-textarea">
                    <span className="route53-form-label">Alias DNS</span>
                    <textarea value={draft.aliasDnsName} onChange={(event) => setDraft((current) => ({ ...current, aliasDnsName: event.target.value }))} placeholder="dualstack.my-alb-123.us-east-1.elb.amazonaws.com" />
                  </label>
                  <label className="route53-form-row">
                    <span className="route53-form-label">Alias Zone ID</span>
                    <input value={draft.aliasHostedZoneId} onChange={(event) => setDraft((current) => ({ ...current, aliasHostedZoneId: event.target.value }))} placeholder="Z35SXDOTRQ7X7K" />
                  </label>
                  <label className="route53-checkbox route53-checkbox-inline">
                    <input type="checkbox" checked={draft.evaluateTargetHealth} onChange={(event) => setDraft((current) => ({ ...current, evaluateTargetHealth: event.target.checked }))} />
                    <span>Evaluate target health</span>
                  </label>
                </>
              ) : (
                <label className="route53-form-row route53-form-row-textarea">
                  <span className="route53-form-label">Values</span>
                  <textarea value={draft.values.join('\n')} onChange={(event) => setDraft((current) => ({ ...current, values: event.target.value.split('\n') }))} placeholder="One value per line" />
                </label>
              )}
            </div>

            <div className="route53-form-actions">
              <button type="button" className="route53-toolbar-btn" onClick={() => setDraft(EMPTY_RECORD)}>Reset</button>
              <button type="button" className="route53-toolbar-btn accent" disabled={!selectedZone || !draft.name.trim()} onClick={() => void saveRecord()}>Save Record</button>
            </div>

            <div className="route53-guidance-list route53-guidance-list-tight">
              {healthGuidance.map((item) => <div key={item} className="route53-guidance-card">{item}</div>)}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
