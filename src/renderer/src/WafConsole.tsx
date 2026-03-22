import { useEffect, useMemo, useState } from 'react'

import type {
  AwsConnection,
  WafScope,
  WafWebAclDetail,
  WafWebAclSummary
} from '@shared/types'
import {
  addWafRule,
  associateWebAcl,
  createWebAcl,
  deleteWafRule,
  deleteWebAcl,
  describeWebAcl,
  disassociateWebAcl,
  listWebAcls,
  updateWafRulesJson
} from './api'
import { ConfirmButton } from './ConfirmButton'

/* ── Column definitions for the ACL table ─────────────────── */

type ColKey = 'name' | 'scope' | 'capacity' | 'description'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'scope', label: 'Scope', color: '#14b8a6' },
  { key: 'capacity', label: 'WCU', color: '#f59e0b' },
  { key: 'description', label: 'Description', color: '#8b5cf6' },
]

function getColValue(acl: WafWebAclSummary, key: ColKey): string {
  switch (key) {
    case 'name': return acl.name
    case 'scope': return acl.scope
    case 'capacity': return String(acl.capacity)
    case 'description': return acl.description || '-'
  }
}

/* ── Column definitions for rules sub-table ───────────────── */

type RuleColKey = 'name' | 'priority' | 'action' | 'statementType'

const RULE_COLUMNS: { key: RuleColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'priority', label: 'Priority', color: '#22c55e' },
  { key: 'action', label: 'Action', color: '#f59e0b' },
  { key: 'statementType', label: 'Statement', color: '#8b5cf6' },
]

/* ── Helpers ──────────────────────────────────────────────── */

/* ── Main tab type ────────────────────────────────────────── */

type MainTab = 'acls' | 'create'

/* ══════════════════════════════════════════════════════════════
   WAF Console
   ══════════════════════════════════════════════════════════════ */

export function WafConsole({ connection }: { connection: AwsConnection }) {
  const [mainTab, setMainTab] = useState<MainTab>('acls')
  const [loading, setLoading] = useState(false)
  const [scope, setScope] = useState<WafScope>('REGIONAL')
  const [webAcls, setWebAcls] = useState<WafWebAclSummary[]>([])
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null)
  const [detail, setDetail] = useState<WafWebAclDetail | null>(null)
  const [rulesDraft, setRulesDraft] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  /* ── Filter & column state ───────────────────────────────── */
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))
  const [ruleVisCols, setRuleVisCols] = useState<Set<RuleColKey>>(() => new Set(RULE_COLUMNS.map(c => c.key)))

  /* ── Create ACL form state ──────────────────────────────── */
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [defaultAction, setDefaultAction] = useState<'Allow' | 'Block'>('Allow')

  /* ── Add rule form state ────────────────────────────────── */
  const [ruleName, setRuleName] = useState('')
  const [rulePriority, setRulePriority] = useState('0')
  const [ruleRate, setRuleRate] = useState('1000')
  const [ruleAction, setRuleAction] = useState<'Allow' | 'Block' | 'Count'>('Block')
  const [ruleIpSetArn, setRuleIpSetArn] = useState('')

  /* ── Resource association state ─────────────────────────── */
  const [resourceArn, setResourceArn] = useState('')

  /* ── Data loading ───────────────────────────────────────── */

  async function refresh(next: { id: string; name: string } | null = selected) {
    setError('')
    setLoading(true)
    try {
      const list = await listWebAcls(connection, scope)
      setWebAcls(list)
      const target = next ?? (list[0] ? { id: list[0].id, name: list[0].name } : null)
      setSelected(target)
      if (!target) {
        setDetail(null)
        setRulesDraft('')
        return
      }
      const nextDetail = await describeWebAcl(connection, scope, target.id, target.name)
      setDetail(nextDetail)
      setRulesDraft(nextDetail.rawRulesJson)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh(null) }, [connection.profile, connection.region, scope])

  /* ── Action handlers ────────────────────────────────────── */

  async function doCreate() {
    if (!createName) return
    setError('')
    try {
      await createWebAcl(connection, { name: createName, description: createDescription, scope, defaultAction })
      setMsg('Web ACL created')
      setCreateName('')
      setCreateDescription('')
      setMainTab('acls')
      await refresh(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDelete() {
    if (!detail) return
    setError('')
    try {
      await deleteWebAcl(connection, scope, detail.id, detail.name, detail.lockToken)
      setMsg('Web ACL deleted')
      await refresh(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doAddRule() {
    if (!detail || !ruleName) return
    setError('')
    try {
      await addWafRule(connection, scope, detail.id, detail.name, detail.lockToken, {
        name: ruleName,
        priority: Number(rulePriority),
        action: ruleAction,
        rateLimit: Number(ruleRate),
        ipSetArn: ruleIpSetArn,
        metricName: ruleName.replace(/\s+/g, '-')
      })
      setMsg('Rule added')
      setRuleName('')
      setRulePriority('0')
      setRuleRate('1000')
      setRuleIpSetArn('')
      await refresh({ id: detail.id, name: detail.name })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDeleteRule(rName: string) {
    if (!detail) return
    setError('')
    try {
      await deleteWafRule(connection, scope, detail.id, detail.name, detail.lockToken, rName)
      setMsg(`Rule "${rName}" deleted`)
      await refresh({ id: detail.id, name: detail.name })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doSaveRulesJson() {
    if (!detail) return
    setError('')
    try {
      await updateWafRulesJson(connection, scope, detail.id, detail.name, detail.lockToken, detail.defaultAction as 'Allow' | 'Block', detail.description, rulesDraft)
      setMsg('Rules JSON saved')
      await refresh({ id: detail.id, name: detail.name })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doAttach() {
    if (!detail || !resourceArn) return
    setError('')
    try {
      await associateWebAcl(connection, resourceArn, detail.arn)
      setMsg('Resource attached')
      setResourceArn('')
      await refresh({ id: detail.id, name: detail.name })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDetach(resArn: string) {
    setError('')
    try {
      await disassociateWebAcl(connection, resArn)
      setMsg('Resource detached')
      if (detail) await refresh({ id: detail.id, name: detail.name })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /* ── Filtering & derived data ───────────────────────────── */

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))
  const activeRuleCols = RULE_COLUMNS.filter(c => ruleVisCols.has(c.key))

  const filteredAcls = useMemo(() => {
    if (!filter) return webAcls
    const q = filter.toLowerCase()
    return webAcls.filter(acl =>
      activeCols.some(c => getColValue(acl, c.key).toLowerCase().includes(q))
    )
  }, [webAcls, filter, activeCols])

  /* ── Create view ────────────────────────────────────────── */

  if (mainTab === 'create') {
    return (
      <div className="svc-console">
        <div className="svc-tab-bar">
          <button className="svc-tab" type="button" onClick={() => setMainTab('acls')}>Cancel</button>
          <button className="svc-tab active" type="button">Create Web ACL</button>
        </div>

        {error && <div className="svc-error">{error}</div>}

        <div className="svc-panel">
          <div className="svc-form">
            <label>
              <span>Name</span>
              <input value={createName} onChange={e => setCreateName(e.target.value)} placeholder="my-web-acl" />
            </label>
            <label>
              <span>Description</span>
              <input value={createDescription} onChange={e => setCreateDescription(e.target.value)} placeholder="Optional description" />
            </label>
            <label>
              <span>Default Action</span>
              <select className="svc-select" value={defaultAction} onChange={e => setDefaultAction(e.target.value as 'Allow' | 'Block')}>
                <option value="Allow">Allow</option>
                <option value="Block">Block</option>
              </select>
            </label>
            <label>
              <span>Scope</span>
              <select className="svc-select" value={scope} onChange={e => setScope(e.target.value as WafScope)}>
                <option value="REGIONAL">REGIONAL</option>
                <option value="CLOUDFRONT">CLOUDFRONT</option>
              </select>
            </label>
          </div>
          <button type="button" className="svc-btn success" disabled={!createName} onClick={() => void doCreate()}>Create Web ACL</button>
        </div>
      </div>
    )
  }

  /* ── Main ACL list view ─────────────────────────────────── */

  return (
    <div className="svc-console">
      {/* ── Tab bar ─────────────────────────────────────── */}
      <div className="svc-tab-bar">
        <button className={`svc-tab ${mainTab === 'acls' ? 'active' : ''}`} type="button" onClick={() => setMainTab('acls')}>Web ACLs</button>
        <label className="svc-tab" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Scope
          <select className="svc-select" value={scope} onChange={e => { setScope(e.target.value as WafScope) }} style={{ marginLeft: 4 }}>
            <option value="REGIONAL">REGIONAL</option>
            <option value="CLOUDFRONT">CLOUDFRONT</option>
          </select>
        </label>
        <button className="svc-tab right" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* ── Search ──────────────────────────────────────── */}
      <input
        className="svc-search"
        placeholder="Filter rows across selected columns..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />

      {/* ── Column toggle chips ─────────────────────────── */}
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

      {/* ── Layout: table + sidebar ─────────────────────── */}
      <div className="svc-layout">
        {/* ── Table area ────────────────────────────────── */}
        <div className="svc-table-area">
          <table className="svc-table">
            <thead>
              <tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length}>Gathering data</td></tr>}
              {!loading && filteredAcls.map(acl => (
                <tr
                  key={acl.id}
                  className={selected?.id === acl.id ? 'active' : ''}
                  onClick={() => void refresh({ id: acl.id, name: acl.name })}
                >
                  {activeCols.map(c => (
                    <td key={c.key}>
                      {c.key === 'scope'
                        ? <span className={`svc-badge ${acl.scope === 'REGIONAL' ? 'ok' : 'warn'}`}>{acl.scope}</span>
                        : getColValue(acl, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredAcls.length && !loading && <div className="svc-empty">No web ACLs found.</div>}
        </div>

        {/* ── Sidebar ───────────────────────────────────── */}
        <div className="svc-sidebar">
          {/* Actions */}
          <div className="svc-section">
            <h3>Actions</h3>
            <div className="svc-actions">
              <button className="svc-btn success" type="button" onClick={() => setMainTab('create')}>New Web ACL</button>
              <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete()}>Delete ACL</ConfirmButton>
            </div>
          </div>

          {/* Selected ACL Detail */}
          <div className="svc-section">
            <h3>ACL Detail</h3>
            {detail ? (
              <div className="svc-kv">
                <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{detail.name}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Default Action</div><div className="svc-kv-value">{detail.defaultAction}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Scope</div><div className="svc-kv-value">{detail.scope}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Capacity</div><div className="svc-kv-value">{detail.capacity} WCU</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Description</div><div className="svc-kv-value">{detail.description || '-'}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value" style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all' }}>{detail.arn}</div></div>
              </div>
            ) : <div className="svc-empty">Select a web ACL.</div>}
          </div>

          {/* Add Rule */}
          {detail && (
            <div className="svc-section">
              <h3>Add Rule</h3>
              <div className="svc-form">
                <label><span>Rule Name</span><input value={ruleName} onChange={e => setRuleName(e.target.value)} placeholder="my-rule" /></label>
                <label><span>Priority</span><input value={rulePriority} onChange={e => setRulePriority(e.target.value)} placeholder="0" /></label>
                <label><span>Rate Limit</span><input value={ruleRate} onChange={e => setRuleRate(e.target.value)} placeholder="1000" /></label>
                <label>
                  <span>Action</span>
                  <select className="svc-select" value={ruleAction} onChange={e => setRuleAction(e.target.value as 'Allow' | 'Block' | 'Count')}>
                    <option value="Allow">Allow</option>
                    <option value="Block">Block</option>
                    <option value="Count">Count</option>
                  </select>
                </label>
                <label><span>IP Set ARN</span><input value={ruleIpSetArn} onChange={e => setRuleIpSetArn(e.target.value)} placeholder="Optional IP set ARN" /></label>
              </div>
              <button type="button" className="svc-btn success" disabled={!ruleName} onClick={() => void doAddRule()}>Add Rule</button>
            </div>
          )}

          {/* Rules Table */}
          {detail && detail.rules.length > 0 && (
            <div className="svc-section">
              <h3>Rules ({detail.rules.length})</h3>
              <div className="svc-chips" style={{ marginBottom: 10 }}>
                {RULE_COLUMNS.map(col => (
                  <button
                    key={col.key}
                    className={`svc-chip ${ruleVisCols.has(col.key) ? 'active' : ''}`}
                    type="button"
                    style={ruleVisCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
                    onClick={() => setRuleVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
                  >{col.label}</button>
                ))}
              </div>
              <div style={{ maxHeight: 'calc(100vh - 600px)', overflow: 'auto' }}>
                <table className="svc-table">
                  <thead>
                    <tr>
                      {activeRuleCols.map(c => <th key={c.key}>{c.label}</th>)}
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rules.map(rule => (
                      <tr key={rule.name}>
                        {activeRuleCols.map(c => (
                          <td key={c.key}>
                            {c.key === 'action'
                              ? <span className={`svc-badge ${rule.action === 'Block' ? 'danger' : rule.action === 'Allow' ? 'ok' : 'warn'}`}>{rule.action}</span>
                              : String(rule[c.key])}
                          </td>
                        ))}
                        <td>
                          <ConfirmButton className="svc-btn danger" onConfirm={() => void doDeleteRule(rule.name)}>Delete</ConfirmButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Rules JSON Editor */}
          {detail && (
            <div className="svc-section">
              <h3>Rules JSON Editor</h3>
              <textarea
                value={rulesDraft}
                onChange={e => setRulesDraft(e.target.value)}
                rows={10}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', padding: 10, resize: 'vertical' }}
              />
              <button type="button" className="svc-btn primary" onClick={() => void doSaveRulesJson()}>Save Rules JSON</button>
            </div>
          )}

          {/* Protected Resources */}
          {detail && (
            <div className="svc-section">
              <h3>Protected Resources ({detail.associations.length})</h3>
              <div className="svc-inline">
                <input value={resourceArn} onChange={e => setResourceArn(e.target.value)} placeholder="Resource ARN" />
                <button type="button" className="svc-btn success" disabled={!resourceArn} onClick={() => void doAttach()}>Attach</button>
              </div>
              {detail.associations.length > 0 && (
                <table className="svc-table" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Resource ARN</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.associations.map(assoc => (
                      <tr key={assoc.resourceArn}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>{assoc.resourceArn}</td>
                        <td>
                          <ConfirmButton className="svc-btn danger" onConfirm={() => void doDetach(assoc.resourceArn)}>Detach</ConfirmButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {detail.associations.length === 0 && <div className="svc-empty">No resources attached.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
