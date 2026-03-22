import { useEffect, useMemo, useState } from 'react'

import type {
  AwsConnection,
  SecurityGroupDetail,
  SecurityGroupRule,
  SecurityGroupRuleInput,
  SecurityGroupSummary
} from '@shared/types'
import {
  addInboundRule,
  addOutboundRule,
  describeSecurityGroup,
  listSecurityGroups,
  revokeInboundRule,
  revokeOutboundRule
} from './sgApi'
import { ConfirmButton } from './ConfirmButton'

/* ── Column definitions ───────────────────────────────────── */

type ColKey = 'groupName' | 'groupId' | 'vpcId' | 'inbound' | 'outbound'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'groupName', label: 'Name', color: '#3b82f6' },
  { key: 'groupId', label: 'GroupId', color: '#14b8a6' },
  { key: 'vpcId', label: 'VPC', color: '#8b5cf6' },
  { key: 'inbound', label: 'Inbound', color: '#22c55e' },
  { key: 'outbound', label: 'Outbound', color: '#f59e0b' },
]

function getColVal(g: SecurityGroupSummary, key: ColKey): string {
  switch (key) {
    case 'groupName': return g.groupName
    case 'groupId': return g.groupId
    case 'vpcId': return g.vpcId
    case 'inbound': return String(g.inboundRuleCount)
    case 'outbound': return String(g.outboundRuleCount)
  }
}

/* ── Helpers ──────────────────────────────────────────────── */

type Direction = 'inbound' | 'outbound'

const PROTOCOL_OPTIONS = [
  { value: 'All', label: 'All traffic' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'icmp', label: 'ICMP' }
]

function emptyRuleInput(): SecurityGroupRuleInput {
  return { protocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0', sourceGroupId: '', description: '' }
}

/* ── Rule Modal ───────────────────────────────────────────── */

function RuleModal({
  modal,
  groupId,
  connection,
  onClose,
  onDone
}: {
  modal: { kind: 'add-rule'; direction: Direction } | { kind: 'delete-rule'; direction: Direction; rule: SecurityGroupRule }
  groupId: string
  connection: AwsConnection
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [draft, setDraft] = useState<SecurityGroupRuleInput>(emptyRuleInput())
  const [sourceMode, setSourceMode] = useState<'cidr' | 'sg'>('cidr')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function update(patch: Partial<SecurityGroupRuleInput>) {
    setDraft(prev => ({ ...prev, ...patch }))
  }

  async function handleSubmit() {
    setBusy(true); setError('')
    try {
      if (modal.kind === 'add-rule') {
        const input: SecurityGroupRuleInput = { ...draft, cidrIp: sourceMode === 'cidr' ? draft.cidrIp : undefined, sourceGroupId: sourceMode === 'sg' ? draft.sourceGroupId : undefined }
        if (modal.direction === 'inbound') await addInboundRule(connection, groupId, input)
        else await addOutboundRule(connection, groupId, input)
        onDone(`${modal.direction} rule added`)
      } else {
        const r = modal.rule
        const input: SecurityGroupRuleInput = { protocol: r.protocol === 'All' ? '-1' : r.protocol, fromPort: r.fromPort, toPort: r.toPort, cidrIp: r.sources.find(s => s.includes('/')) || undefined, sourceGroupId: r.sources.find(s => s.startsWith('sg-')) || undefined, description: '' }
        if (modal.direction === 'inbound') await revokeInboundRule(connection, groupId, input)
        else await revokeOutboundRule(connection, groupId, input)
        onDone(`${modal.direction} rule revoked`)
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div className="svc-dialog-overlay" onClick={onClose}>
      <div className="svc-dialog" onClick={e => e.stopPropagation()}>
        <h3>{modal.kind === 'add-rule' ? `Add ${modal.direction} rule` : `Revoke ${modal.direction} rule`}</h3>
        {error && <div className="svc-error">{error}</div>}

        {modal.kind === 'delete-rule' ? (
          <>
            <p style={{ color: '#9ca7b7', fontSize: 13, margin: '0 0 12px' }}>Revoke the following {modal.direction} rule?</p>
            <div className="svc-kv">
              <div className="svc-kv-row"><div className="svc-kv-label">Protocol</div><div className="svc-kv-value">{modal.rule.protocol}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">Port Range</div><div className="svc-kv-value">{modal.rule.portRange}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">{modal.direction === 'inbound' ? 'Source' : 'Destination'}</div><div className="svc-kv-value">{modal.rule.sources.join(', ')}</div></div>
            </div>
            <div className="svc-dialog-actions">
              <button type="button" className="svc-btn muted" onClick={onClose}>Cancel</button>
              <button type="button" className="svc-btn danger" disabled={busy} onClick={() => void handleSubmit()}>{busy ? 'Revoking...' : 'Revoke Rule'}</button>
            </div>
          </>
        ) : (
          <>
            <div className="svc-form">
              <label><span>Protocol</span><select value={draft.protocol} onChange={e => update({ protocol: e.target.value })}>{PROTOCOL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
              {draft.protocol !== 'All' && draft.protocol !== 'icmp' && (
                <>
                  <label><span>From Port</span><input type="number" value={draft.fromPort} onChange={e => update({ fromPort: Number(e.target.value) })} /></label>
                  <label><span>To Port</span><input type="number" value={draft.toPort} onChange={e => update({ toPort: Number(e.target.value) })} /></label>
                </>
              )}
              <label><span>Source Type</span><select value={sourceMode} onChange={e => setSourceMode(e.target.value as 'cidr' | 'sg')}><option value="cidr">CIDR</option><option value="sg">Security Group</option></select></label>
              {sourceMode === 'cidr'
                ? <label><span>CIDR</span><input placeholder="0.0.0.0/0" value={draft.cidrIp ?? ''} onChange={e => update({ cidrIp: e.target.value })} /></label>
                : <label><span>Source SG</span><input placeholder="sg-..." value={draft.sourceGroupId ?? ''} onChange={e => update({ sourceGroupId: e.target.value })} /></label>
              }
              <label><span>Description</span><input placeholder="Optional" value={draft.description} onChange={e => update({ description: e.target.value })} /></label>
            </div>
            <div className="svc-dialog-actions">
              <button type="button" className="svc-btn muted" onClick={onClose}>Cancel</button>
              <button type="button" className="svc-btn primary" disabled={busy} onClick={() => void handleSubmit()}>{busy ? 'Adding...' : 'Add Rule'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Main Console ─────────────────────────────────────────── */

export function SecurityGroupsConsole({ connection }: { connection: AwsConnection }) {
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [groups, setGroups] = useState<SecurityGroupSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<SecurityGroupDetail | null>(null)
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))
  const [modal, setModal] = useState<{ kind: 'closed' } | { kind: 'add-rule'; direction: Direction } | { kind: 'delete-rule'; direction: Direction; rule: SecurityGroupRule }>({ kind: 'closed' })
  const [sideTab, setSideTab] = useState<'details' | 'inbound' | 'outbound'>('details')

  async function reload() {
    setLoading(true); setMsg('')
    try {
      const items = await listSecurityGroups(connection)
      setGroups(items)
      if (!selectedId || !items.some(g => g.groupId === selectedId)) {
        const first = items[0]?.groupId ?? ''
        setSelectedId(first)
        if (first) setDetail(await describeSecurityGroup(connection, first))
        else setDetail(null)
      } else {
        setDetail(await describeSecurityGroup(connection, selectedId))
      }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void reload() }, [connection.profile, connection.region])

  async function selectGroup(groupId: string) {
    setSelectedId(groupId); setMsg('')
    try { setDetail(await describeSecurityGroup(connection, groupId)) }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  }

  async function onModalDone(feedbackMsg: string) {
    setModal({ kind: 'closed' }); setMsg(feedbackMsg)
    if (selectedId) setDetail(await describeSecurityGroup(connection, selectedId))
  }

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))

  const filteredGroups = useMemo(() => {
    if (!filter) return groups
    const q = filter.toLowerCase()
    return groups.filter(g => activeCols.some(c => getColVal(g, c.key).toLowerCase().includes(q)))
  }, [groups, filter, activeCols])

  if (loading) return <div className="svc-empty">Loading security groups...</div>

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Security Groups</button>
        <button className="svc-tab right" type="button" onClick={() => void reload()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}

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
        {/* ── Table ────────────────────────────────────────── */}
        <div className="svc-table-area">
          <table className="svc-table">
            <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {filteredGroups.map(g => (
                <tr key={g.groupId} className={g.groupId === selectedId ? 'active' : ''} onClick={() => void selectGroup(g.groupId)}>
                  {activeCols.map(c => <td key={c.key}>{getColVal(g, c.key)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredGroups.length && <div className="svc-empty">No security groups match filter.</div>}
        </div>

        {/* ── Sidebar ─────────────────────────────────────── */}
        <div className="svc-sidebar">
          <div className="svc-side-tabs">
            <button className={sideTab === 'details' ? 'active' : ''} type="button" onClick={() => setSideTab('details')}>Details</button>
            <button className={sideTab === 'inbound' ? 'active' : ''} type="button" onClick={() => setSideTab('inbound')}>Inbound ({detail?.inboundRules.length ?? 0})</button>
            <button className={sideTab === 'outbound' ? 'active' : ''} type="button" onClick={() => setSideTab('outbound')}>Outbound ({detail?.outboundRules.length ?? 0})</button>
          </div>

          {sideTab === 'details' && (
            <div className="svc-section">
              <h3>Group Details</h3>
              {detail ? (
                <>
                  <div className="svc-kv">
                    <div className="svc-kv-row"><div className="svc-kv-label">Group ID</div><div className="svc-kv-value">{detail.groupId}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{detail.groupName}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">VPC</div><div className="svc-kv-value">{detail.vpcId}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Description</div><div className="svc-kv-value">{detail.description}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Owner</div><div className="svc-kv-value">{detail.ownerId}</div></div>
                  </div>
                  {Object.keys(detail.tags).length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <h3 style={{ fontSize: 12, margin: '0 0 6px' }}>Tags</h3>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {Object.entries(detail.tags).map(([k, v]) => (
                          <span key={k} className="svc-tag">{k}={v}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : <div className="svc-empty">Select a security group.</div>}
            </div>
          )}

          {sideTab === 'inbound' && detail && (
            <div className="svc-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>Inbound Rules ({detail.inboundRules.length})</h3>
                <button type="button" className="svc-btn success" onClick={() => setModal({ kind: 'add-rule', direction: 'inbound' })}>Add Rule</button>
              </div>
              <table className="svc-table">
                <thead><tr><th>Protocol</th><th>Ports</th><th>Source</th><th>Desc</th><th></th></tr></thead>
                <tbody>
                  {detail.inboundRules.map((r, i) => (
                    <tr key={`${r.protocol}-${r.portRange}-${i}`}>
                      <td>{r.protocol}</td>
                      <td>{r.portRange}</td>
                      <td>{r.sources.map((s, si) => <span key={si} className="svc-tag" style={{ marginRight: 3 }}>{s}</span>)}</td>
                      <td style={{ color: '#9ca7b7', fontSize: 11 }}>{r.description || '-'}</td>
                      <td><ConfirmButton className="svc-btn danger" onConfirm={() => setModal({ kind: 'delete-rule', direction: 'inbound', rule: r })}>Revoke</ConfirmButton></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!detail.inboundRules.length && <div className="svc-empty">No inbound rules.</div>}
            </div>
          )}

          {sideTab === 'outbound' && detail && (
            <div className="svc-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 style={{ margin: 0 }}>Outbound Rules ({detail.outboundRules.length})</h3>
                <button type="button" className="svc-btn success" onClick={() => setModal({ kind: 'add-rule', direction: 'outbound' })}>Add Rule</button>
              </div>
              <table className="svc-table">
                <thead><tr><th>Protocol</th><th>Ports</th><th>Destination</th><th>Desc</th><th></th></tr></thead>
                <tbody>
                  {detail.outboundRules.map((r, i) => (
                    <tr key={`${r.protocol}-${r.portRange}-${i}`}>
                      <td>{r.protocol}</td>
                      <td>{r.portRange}</td>
                      <td>{r.sources.map((s, si) => <span key={si} className="svc-tag" style={{ marginRight: 3 }}>{s}</span>)}</td>
                      <td style={{ color: '#9ca7b7', fontSize: 11 }}>{r.description || '-'}</td>
                      <td><ConfirmButton className="svc-btn danger" onConfirm={() => setModal({ kind: 'delete-rule', direction: 'outbound', rule: r })}>Revoke</ConfirmButton></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!detail.outboundRules.length && <div className="svc-empty">No outbound rules.</div>}
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {modal.kind !== 'closed' && detail && (
        <RuleModal
          modal={modal}
          groupId={detail.groupId}
          connection={connection}
          onClose={() => setModal({ kind: 'closed' })}
          onDone={m => void onModalDone(m)}
        />
      )}
    </div>
  )
}
