import { useEffect, useMemo, useState } from 'react'

import './terraform.css'
import './waf.css'

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

type ColKey = 'name' | 'scope' | 'capacity' | 'description'
type RuleColKey = 'name' | 'priority' | 'action' | 'statementType'
type MainTab = 'acls' | 'create'
type DetailTab = 'overview' | 'rules' | 'json' | 'associations'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'scope', label: 'Scope', color: '#14b8a6' },
  { key: 'capacity', label: 'WCU', color: '#f59e0b' },
  { key: 'description', label: 'Description', color: '#f97316' }
]

const RULE_COLUMNS: { key: RuleColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'priority', label: 'Priority', color: '#22c55e' },
  { key: 'action', label: 'Action', color: '#f59e0b' },
  { key: 'statementType', label: 'Statement', color: '#a855f7' }
]

function getColValue(acl: WafWebAclSummary, key: ColKey): string {
  switch (key) {
    case 'name':
      return acl.name
    case 'scope':
      return acl.scope
    case 'capacity':
      return String(acl.capacity)
    case 'description':
      return acl.description || '-'
  }
}

function getActionTone(action: string): 'success' | 'warning' | 'danger' {
  if (action === 'Allow') return 'success'
  if (action === 'Count') return 'warning'
  return 'danger'
}

function getScopeTone(scope: WafScope): 'info' | 'warning' {
  return scope === 'REGIONAL' ? 'info' : 'warning'
}

function truncateArn(value: string, tail = 56): string {
  if (value.length <= tail) return value
  return `...${value.slice(-tail)}`
}

function scopeDescription(scope: WafScope, region: string): string {
  return scope === 'REGIONAL'
    ? `Regional protections in ${region}`
    : 'Global protections for CloudFront distributions'
}

export function WafConsole({ connection, focusWebAcl }: {
  connection: AwsConnection
  focusWebAcl?: { token: number; webAclName: string } | null
}) {
  const [mainTab, setMainTab] = useState<MainTab>('acls')
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [loading, setLoading] = useState(false)
  const [scope, setScope] = useState<WafScope>('REGIONAL')
  const [webAcls, setWebAcls] = useState<WafWebAclSummary[]>([])
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null)
  const [detail, setDetail] = useState<WafWebAclDetail | null>(null)
  const [rulesDraft, setRulesDraft] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))
  const [ruleVisCols, setRuleVisCols] = useState<Set<RuleColKey>>(() => new Set(RULE_COLUMNS.map((column) => column.key)))

  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [defaultAction, setDefaultAction] = useState<'Allow' | 'Block'>('Allow')

  const [ruleName, setRuleName] = useState('')
  const [rulePriority, setRulePriority] = useState('0')
  const [ruleRate, setRuleRate] = useState('1000')
  const [ruleAction, setRuleAction] = useState<'Allow' | 'Block' | 'Count'>('Block')
  const [ruleIpSetArn, setRuleIpSetArn] = useState('')

  const [resourceArn, setResourceArn] = useState('')

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh(null)
  }, [connection.sessionId, connection.region, scope])

  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  useEffect(() => {
    if (!focusWebAcl || focusWebAcl.token === appliedFocusToken) return
    setAppliedFocusToken(focusWebAcl.token)
    const match = webAcls.find((acl) => acl.name === focusWebAcl.webAclName)
    if (!match) return
    setMainTab('acls')
    setDetailTab('overview')
    void refresh({ id: match.id, name: match.name })
  }, [appliedFocusToken, focusWebAcl, webAcls])

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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function doDelete() {
    if (!detail) return
    setError('')

    try {
      await deleteWebAcl(connection, scope, detail.id, detail.name, detail.lockToken)
      setMsg('Web ACL deleted')
      await refresh(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function doDeleteRule(ruleToDelete: string) {
    if (!detail) return
    setError('')

    try {
      await deleteWafRule(connection, scope, detail.id, detail.name, detail.lockToken, ruleToDelete)
      setMsg(`Rule "${ruleToDelete}" deleted`)
      await refresh({ id: detail.id, name: detail.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function doSaveRulesJson() {
    if (!detail) return
    setError('')

    try {
      await updateWafRulesJson(
        connection,
        scope,
        detail.id,
        detail.name,
        detail.lockToken,
        detail.defaultAction as 'Allow' | 'Block',
        detail.description,
        rulesDraft
      )
      setMsg('Rules JSON saved')
      await refresh({ id: detail.id, name: detail.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function doAttach() {
    if (!detail || !resourceArn) return
    setError('')

    try {
      await associateWebAcl(connection, resourceArn, detail.arn)
      setMsg('Resource attached')
      setResourceArn('')
      await refresh({ id: detail.id, name: detail.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function doDetach(targetArn: string) {
    setError('')

    try {
      await disassociateWebAcl(connection, targetArn)
      setMsg('Resource detached')
      if (detail) {
        await refresh({ id: detail.id, name: detail.name })
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const activeCols = COLUMNS.filter((column) => visCols.has(column.key))
  const activeRuleCols = RULE_COLUMNS.filter((column) => ruleVisCols.has(column.key))

  const filteredAcls = useMemo(() => {
    if (!filter) return webAcls
    const query = filter.toLowerCase()
    return webAcls.filter((acl) => activeCols.some((column) => getColValue(acl, column.key).toLowerCase().includes(query)))
  }, [activeCols, filter, webAcls])

  const totalCapacity = useMemo(() => webAcls.reduce((sum, acl) => sum + acl.capacity, 0), [webAcls])
  const selectedSummary = useMemo(
    () => webAcls.find((acl) => acl.id === selected?.id) ?? null,
    [selected?.id, webAcls]
  )
  const selectedRuleCount = detail?.rules.length ?? 0
  const selectedAssociationCount = detail?.associations.length ?? 0

  return (
    <div className="tf-console waf-console">
      <section className="tf-shell-hero waf-shell-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">Web Application Firewall</div>
          <h2>Policy posture and attachment control</h2>
          <p>
            Review Web ACL inventory, adjust rule behavior, and manage protected resources with the
            same compact operator workflow used in Terraform.
          </p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.label}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Scope</span>
              <strong>{scopeDescription(scope, connection.region)}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Selected ACL</span>
              <strong>{detail?.name ?? 'No ACL selected'}</strong>
            </div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent">
            <span>Web ACLs</span>
            <strong>{webAcls.length}</strong>
            <small>{loading ? 'Refreshing inventory' : 'Policies visible in the current scope'}</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Rules</span>
            <strong>{selectedRuleCount}</strong>
            <small>{detail ? `Configured on ${detail.name}` : 'Select a policy to inspect rule coverage'}</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Protected resources</span>
            <strong>{selectedAssociationCount}</strong>
            <small>{detail ? 'Attached resources for the selected policy' : 'No policy selected'}</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Total WCU</span>
            <strong>{detail?.capacity ?? totalCapacity}</strong>
            <small>{detail ? 'Capacity for the selected ACL' : 'Combined capacity across the current inventory'}</small>
          </div>
        </div>
      </section>

      <div className="tf-shell-toolbar waf-shell-toolbar">
        <div className="tf-toolbar">
          <button
            type="button"
            className={`tf-toolbar-btn ${mainTab === 'create' ? '' : 'accent'}`}
            onClick={() => setMainTab(mainTab === 'create' ? 'acls' : 'create')}
          >
            {mainTab === 'create' ? 'Back to inventory' : 'New Web ACL'}
          </button>
          <button type="button" className="tf-toolbar-btn" onClick={() => void refresh()}>
            Refresh
          </button>
          {detail && mainTab === 'acls' && (
            <ConfirmButton className="tf-toolbar-btn danger" onConfirm={() => void doDelete()}>
              Delete ACL
            </ConfirmButton>
          )}
        </div>
        <div className="waf-toolbar-status">
          <label className="waf-toolbar-field">
            <span>Scope</span>
            <select value={scope} onChange={(event) => setScope(event.target.value as WafScope)}>
              <option value="REGIONAL">REGIONAL</option>
              <option value="CLOUDFRONT">CLOUDFRONT</option>
            </select>
          </label>
          <div className="waf-toolbar-badge">
            <span>Status</span>
            <strong>{loading ? 'Gathering data' : 'Ready'}</strong>
          </div>
        </div>
      </div>

      {msg && <div className="tf-msg">{msg}</div>}
      {error && <div className="tf-msg error">{error}</div>}

      <div className="tf-main-layout">
        <aside className="tf-project-table-area waf-list-pane">
          <div className="tf-pane-head">
            <div>
              <span className="tf-pane-kicker">Tracked policies</span>
              <h3>ACL inventory</h3>
            </div>
            <span className="tf-pane-summary">{filteredAcls.length} visible</span>
          </div>

          <div className="waf-filter-shell">
            <input
              className="waf-search-input"
              placeholder="Filter by visible columns"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div className="waf-chip-row">
              {COLUMNS.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  className={`waf-chip ${visCols.has(column.key) ? 'active' : ''}`}
                  style={visCols.has(column.key) ? { background: column.color, borderColor: column.color } : undefined}
                  onClick={() => setVisCols((current) => {
                    const next = new Set(current)
                    if (next.has(column.key)) next.delete(column.key)
                    else next.add(column.key)
                    return next
                  })}
                >
                  {column.label}
                </button>
              ))}
            </div>
          </div>

          <div className="tf-project-list">
            {loading && webAcls.length === 0 && <div className="tf-empty">Gathering Web ACL inventory.</div>}
            {!loading && filteredAcls.length === 0 && <div className="tf-empty">No Web ACLs match the current scope or filter.</div>}
            {filteredAcls.map((acl) => (
              <button
                key={acl.id}
                type="button"
                className={`tf-project-row waf-acl-row ${selected?.id === acl.id && mainTab === 'acls' ? 'active' : ''}`}
                onClick={() => {
                  setMainTab('acls')
                  setDetailTab('overview')
                  void refresh({ id: acl.id, name: acl.name })
                }}
              >
                <div className="tf-project-row-top">
                  <div className="tf-project-row-copy">
                    <strong>{acl.name}</strong>
                    <span>{acl.description || 'No description provided'}</span>
                  </div>
                  <span className={`tf-status-badge ${getScopeTone(acl.scope)}`}>{acl.scope}</span>
                </div>
                <div className="tf-project-row-meta">
                  <span>{truncateArn(acl.arn, 26)}</span>
                  <span>{acl.capacity} WCU</span>
                </div>
                <div className="tf-project-row-metrics">
                  <div>
                    <span>Scope</span>
                    <strong>{acl.scope}</strong>
                  </div>
                  <div>
                    <span>Capacity</span>
                    <strong>{acl.capacity}</strong>
                  </div>
                  <div>
                    <span>Selection</span>
                    <strong>{selectedSummary?.id === acl.id ? 'Focused' : 'Available'}</strong>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="tf-detail-pane waf-detail-pane">
          {mainTab === 'create' ? (
            <>
              <section className="tf-detail-hero waf-detail-hero">
                <div className="tf-detail-hero-copy">
                  <div className="eyebrow">Create policy</div>
                  <h3>Provision a new Web ACL</h3>
                  <p>
                    Define the initial protection stance, then return to the inventory view to add
                    rules, attach resources, or refine JSON directly.
                  </p>
                  <div className="tf-detail-meta-strip">
                    <div className="tf-detail-meta-pill">
                      <span>Scope</span>
                      <strong>{scope}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Region</span>
                      <strong>{connection.region}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Default action</span>
                      <strong>{defaultAction}</strong>
                    </div>
                  </div>
                </div>
                <div className="tf-detail-hero-stats">
                  <div className="tf-detail-stat-card info">
                    <span>Current inventory</span>
                    <strong>{webAcls.length}</strong>
                    <small>Existing policies in this scope</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Mode</span>
                    <strong>{scope === 'REGIONAL' ? 'Regional' : 'Global'}</strong>
                    <small>{scopeDescription(scope, connection.region)}</small>
                  </div>
                </div>
              </section>

              <div className="tf-section">
                <div className="waf-section-head">
                  <div>
                    <span className="tf-pane-kicker">Provisioning</span>
                    <h3>Create Web ACL</h3>
                  </div>
                </div>
                <div className="waf-form-grid">
                  <label className="waf-field">
                    <span>Name</span>
                    <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="my-web-acl" />
                  </label>
                  <label className="waf-field">
                    <span>Scope</span>
                    <select value={scope} onChange={(event) => setScope(event.target.value as WafScope)}>
                      <option value="REGIONAL">REGIONAL</option>
                      <option value="CLOUDFRONT">CLOUDFRONT</option>
                    </select>
                  </label>
                  <label className="waf-field waf-field-span-2">
                    <span>Description</span>
                    <input
                      value={createDescription}
                      onChange={(event) => setCreateDescription(event.target.value)}
                      placeholder="Optional description"
                    />
                  </label>
                  <label className="waf-field">
                    <span>Default action</span>
                    <select value={defaultAction} onChange={(event) => setDefaultAction(event.target.value as 'Allow' | 'Block')}>
                      <option value="Allow">Allow</option>
                      <option value="Block">Block</option>
                    </select>
                  </label>
                </div>
                <div className="waf-action-row">
                  <button type="button" className="tf-toolbar-btn accent" disabled={!createName} onClick={() => void doCreate()}>
                    Create Web ACL
                  </button>
                </div>
              </div>
            </>
          ) : !detail ? (
            <div className="tf-empty">Select a Web ACL to view its policy posture, rules, and associations.</div>
          ) : (
            <>
              <section className="tf-detail-hero waf-detail-hero">
                <div className="tf-detail-hero-copy">
                  <div className="eyebrow">Selected policy</div>
                  <h3>{detail.name}</h3>
                  <p>{detail.description || 'No description provided for this Web ACL.'}</p>
                  <div className="tf-detail-meta-strip">
                    <div className="tf-detail-meta-pill">
                      <span>Default action</span>
                      <strong>{detail.defaultAction}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Scope</span>
                      <strong>{detail.scope}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>ARN</span>
                      <strong>{truncateArn(detail.arn, 44)}</strong>
                    </div>
                  </div>
                </div>
                <div className="tf-detail-hero-stats">
                  <div className={`tf-detail-stat-card ${getActionTone(detail.defaultAction)}`}>
                    <span>Traffic posture</span>
                    <strong>{detail.defaultAction}</strong>
                    <small>Fallback action when rules do not match</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Rules</span>
                    <strong>{detail.rules.length}</strong>
                    <small>Policies currently evaluated in this ACL</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Associations</span>
                    <strong>{detail.associations.length}</strong>
                    <small>Protected resources linked to this policy</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Capacity</span>
                    <strong>{detail.capacity}</strong>
                    <small>Total WCU consumed by the active ruleset</small>
                  </div>
                </div>
              </section>

              <div className="tf-detail-tabs">
                <button className={detailTab === 'overview' ? 'active' : ''} onClick={() => setDetailTab('overview')}>Overview</button>
                <button className={detailTab === 'rules' ? 'active' : ''} onClick={() => setDetailTab('rules')}>Rules</button>
                <button className={detailTab === 'json' ? 'active' : ''} onClick={() => setDetailTab('json')}>JSON</button>
                <button className={detailTab === 'associations' ? 'active' : ''} onClick={() => setDetailTab('associations')}>Associations</button>
              </div>

              {detailTab === 'overview' && (
                <>
                  <div className="tf-section tf-project-info-shell">
                    <details className="tf-collapsible" open>
                      <summary className="tf-collapsible-summary">ACL Detail</summary>
                      <div className="tf-kv tf-collapsible-body">
                        <div className="tf-kv-row"><div className="tf-kv-label">Name</div><div className="tf-kv-value">{detail.name}</div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">Description</div><div className="tf-kv-value">{detail.description || '-'}</div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">Scope</div><div className="tf-kv-value"><span className={`tf-status-badge ${getScopeTone(detail.scope)}`}>{detail.scope}</span></div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">Default Action</div><div className="tf-kv-value"><span className={`tf-status-badge ${getActionTone(detail.defaultAction)}`}>{detail.defaultAction}</span></div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">Capacity</div><div className="tf-kv-value">{detail.capacity} WCU</div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">Rules</div><div className="tf-kv-value">{detail.rules.length}</div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">Protected Resources</div><div className="tf-kv-value">{detail.associations.length}</div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">Token Domains</div><div className="tf-kv-value">{detail.tokenDomains.length ? detail.tokenDomains.join(', ') : '-'}</div></div>
                        <div className="tf-kv-row"><div className="tf-kv-label">ARN</div><div className="tf-kv-value waf-mono">{detail.arn}</div></div>
                      </div>
                    </details>
                  </div>

                  <div className="tf-section">
                    <div className="waf-section-head">
                      <div>
                        <span className="tf-pane-kicker">Lifecycle</span>
                        <h3>Policy actions</h3>
                      </div>
                    </div>
                    <div className="waf-action-row">
                      <button type="button" className="tf-toolbar-btn" onClick={() => void refresh({ id: detail.id, name: detail.name })}>
                        Reload detail
                      </button>
                      <ConfirmButton className="tf-toolbar-btn danger" onConfirm={() => void doDelete()}>
                        Delete ACL
                      </ConfirmButton>
                    </div>
                  </div>
                </>
              )}
              {detailTab === 'rules' && (
                <>
                  <div className="tf-section">
                    <div className="waf-section-head">
                      <div>
                        <span className="tf-pane-kicker">Rule authoring</span>
                        <h3>Add rule</h3>
                      </div>
                    </div>
                    <div className="waf-form-grid">
                      <label className="waf-field">
                        <span>Rule name</span>
                        <input value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="my-rule" />
                      </label>
                      <label className="waf-field">
                        <span>Priority</span>
                        <input value={rulePriority} onChange={(event) => setRulePriority(event.target.value)} placeholder="0" />
                      </label>
                      <label className="waf-field">
                        <span>Rate limit</span>
                        <input value={ruleRate} onChange={(event) => setRuleRate(event.target.value)} placeholder="1000" />
                      </label>
                      <label className="waf-field">
                        <span>Action</span>
                        <select value={ruleAction} onChange={(event) => setRuleAction(event.target.value as 'Allow' | 'Block' | 'Count')}>
                          <option value="Allow">Allow</option>
                          <option value="Block">Block</option>
                          <option value="Count">Count</option>
                        </select>
                      </label>
                      <label className="waf-field waf-field-span-2">
                        <span>IP set ARN</span>
                        <input
                          value={ruleIpSetArn}
                          onChange={(event) => setRuleIpSetArn(event.target.value)}
                          placeholder="Optional IP set ARN"
                        />
                      </label>
                    </div>
                    <div className="waf-action-row">
                      <button type="button" className="tf-toolbar-btn accent" disabled={!ruleName} onClick={() => void doAddRule()}>
                        Add Rule
                      </button>
                    </div>
                  </div>

                  <div className="tf-section">
                    <div className="waf-section-head">
                      <div>
                        <span className="tf-pane-kicker">Ruleset</span>
                        <h3>Configured rules</h3>
                      </div>
                      <span className="tf-pane-summary">{detail.rules.length} total</span>
                    </div>
                    <div className="waf-chip-row waf-chip-row-tight">
                      {RULE_COLUMNS.map((column) => (
                        <button
                          key={column.key}
                          type="button"
                          className={`waf-chip ${ruleVisCols.has(column.key) ? 'active' : ''}`}
                          style={ruleVisCols.has(column.key) ? { background: column.color, borderColor: column.color } : undefined}
                          onClick={() => setRuleVisCols((current) => {
                            const next = new Set(current)
                            if (next.has(column.key)) next.delete(column.key)
                            else next.add(column.key)
                            return next
                          })}
                        >
                          {column.label}
                        </button>
                      ))}
                    </div>

                    {detail.rules.length === 0 ? (
                      <div className="tf-empty">No rules configured for this Web ACL.</div>
                    ) : (
                      <div className="waf-grid-table">
                        <div className="waf-grid-table-head waf-rule-grid">
                          {activeRuleCols.map((column) => <div key={column.key}>{column.label}</div>)}
                          <div>Mutation</div>
                        </div>
                        {detail.rules.map((rule) => (
                          <div key={rule.name} className="waf-grid-table-row waf-rule-grid">
                            {activeRuleCols.map((column) => (
                              <div key={column.key}>
                                {column.key === 'action' ? (
                                  <span className={`tf-status-badge ${getActionTone(rule.action)}`}>{rule.action}</span>
                                ) : (
                                  String(rule[column.key])
                                )}
                              </div>
                            ))}
                            <div>
                              <ConfirmButton className="tf-toolbar-btn danger waf-inline-action" onConfirm={() => void doDeleteRule(rule.name)}>
                                Delete
                              </ConfirmButton>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {detailTab === 'json' && (
                <div className="tf-section">
                  <div className="waf-section-head">
                    <div>
                      <span className="tf-pane-kicker">Direct editing</span>
                      <h3>Rules JSON editor</h3>
                    </div>
                  </div>
                  <textarea
                    className="waf-json-editor"
                    value={rulesDraft}
                    onChange={(event) => setRulesDraft(event.target.value)}
                    rows={16}
                  />
                  <div className="waf-action-row">
                    <button type="button" className="tf-toolbar-btn accent" onClick={() => void doSaveRulesJson()}>
                      Save Rules JSON
                    </button>
                  </div>
                </div>
              )}

              {detailTab === 'associations' && (
                <div className="tf-section">
                  <div className="waf-section-head">
                    <div>
                      <span className="tf-pane-kicker">Protected resources</span>
                      <h3>Associations</h3>
                    </div>
                    <span className="tf-pane-summary">{detail.associations.length} attached</span>
                  </div>
                  <div className="waf-inline-form">
                    <input value={resourceArn} onChange={(event) => setResourceArn(event.target.value)} placeholder="Resource ARN" />
                    <button type="button" className="tf-toolbar-btn accent" disabled={!resourceArn} onClick={() => void doAttach()}>
                      Attach
                    </button>
                  </div>

                  {detail.associations.length === 0 ? (
                    <div className="tf-empty">No resources attached.</div>
                  ) : (
                    <div className="waf-grid-table">
                      <div className="waf-grid-table-head waf-association-grid">
                        <div>Resource ARN</div>
                        <div>Mutation</div>
                      </div>
                      {detail.associations.map((association) => (
                        <div key={association.resourceArn} className="waf-grid-table-row waf-association-grid">
                          <div className="waf-mono">{association.resourceArn}</div>
                          <div>
                            <ConfirmButton className="tf-toolbar-btn danger waf-inline-action" onConfirm={() => void doDetach(association.resourceArn)}>
                              Detach
                            </ConfirmButton>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
