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
import './sg.css'

type ColKey = 'groupName' | 'groupId' | 'vpcId' | 'inbound' | 'outbound'
type Direction = 'inbound' | 'outbound'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'groupName', label: 'Name', color: '#4a8fe7' },
  { key: 'groupId', label: 'Group ID', color: '#4db6ac' },
  { key: 'vpcId', label: 'VPC', color: '#8e7cff' },
  { key: 'inbound', label: 'Inbound', color: '#42c97a' },
  { key: 'outbound', label: 'Outbound', color: '#f59a3d' }
]

const PROTOCOL_OPTIONS = [
  { value: 'All', label: 'All traffic' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
  { value: 'icmp', label: 'ICMP' }
]

function getColVal(group: SecurityGroupSummary, key: ColKey): string {
  switch (key) {
    case 'groupName':
      return group.groupName
    case 'groupId':
      return group.groupId
    case 'vpcId':
      return group.vpcId
    case 'inbound':
      return String(group.inboundRuleCount)
    case 'outbound':
      return String(group.outboundRuleCount)
  }
}

function emptyRuleInput(): SecurityGroupRuleInput {
  return {
    protocol: 'tcp',
    fromPort: 443,
    toPort: 443,
    cidrIp: '0.0.0.0/0',
    sourceGroupId: '',
    description: ''
  }
}

function summarizeSelection(detail: SecurityGroupDetail | null) {
  if (!detail) {
    return {
      tagCount: 0,
      sourceKinds: 0
    }
  }

  const sourceKinds = new Set(
    [...detail.inboundRules, ...detail.outboundRules].flatMap((rule) =>
      rule.sources.map((source) => {
        if (source.startsWith('sg-')) return 'security-group'
        if (source.includes('/')) return 'cidr'
        return 'other'
      })
    )
  )

  return {
    tagCount: Object.keys(detail.tags).length,
    sourceKinds: sourceKinds.size
  }
}

function protocolTone(protocol: string): 'accent' | 'success' | 'warning' | 'muted' {
  if (protocol === 'tcp') return 'accent'
  if (protocol === 'udp') return 'success'
  if (protocol === 'icmp') return 'warning'
  return 'muted'
}

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
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  async function handleSubmit() {
    setBusy(true)
    setError('')

    try {
      if (modal.kind === 'add-rule') {
        const input: SecurityGroupRuleInput = {
          ...draft,
          cidrIp: sourceMode === 'cidr' ? draft.cidrIp : undefined,
          sourceGroupId: sourceMode === 'sg' ? draft.sourceGroupId : undefined
        }
        if (modal.direction === 'inbound') await addInboundRule(connection, groupId, input)
        else await addOutboundRule(connection, groupId, input)
        onDone(`${modal.direction} rule added`)
      } else {
        const rule = modal.rule
        const input: SecurityGroupRuleInput = {
          protocol: rule.protocol === 'All' ? '-1' : rule.protocol,
          fromPort: rule.fromPort,
          toPort: rule.toPort,
          cidrIp: rule.sources.find((source) => source.includes('/')) || undefined,
          sourceGroupId: rule.sources.find((source) => source.startsWith('sg-')) || undefined,
          description: ''
        }
        if (modal.direction === 'inbound') await revokeInboundRule(connection, groupId, input)
        else await revokeOutboundRule(connection, groupId, input)
        onDone(`${modal.direction} rule revoked`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="svc-dialog-overlay" onClick={onClose}>
      <div className="svc-dialog sg-rule-dialog" onClick={(event) => event.stopPropagation()}>
        <h3>{modal.kind === 'add-rule' ? `Add ${modal.direction} rule` : `Revoke ${modal.direction} rule`}</h3>
        {error && <div className="sg-inline-error">{error}</div>}

        {modal.kind === 'delete-rule' ? (
          <>
            <p className="sg-rule-dialog-copy">Revoke the following {modal.direction} rule?</p>
            <div className="svc-kv sg-rule-review">
              <div className="svc-kv-row"><div className="svc-kv-label">Protocol</div><div className="svc-kv-value">{modal.rule.protocol}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">Port Range</div><div className="svc-kv-value">{modal.rule.portRange}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">{modal.direction === 'inbound' ? 'Source' : 'Destination'}</div><div className="svc-kv-value">{modal.rule.sources.join(', ')}</div></div>
            </div>
            <div className="svc-dialog-actions">
              <button type="button" className="svc-btn muted" onClick={onClose}>Cancel</button>
              <button type="button" className="svc-btn danger" disabled={busy} onClick={() => void handleSubmit()}>
                {busy ? 'Revoking...' : 'Revoke Rule'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="svc-form">
              <label>
                <span>Protocol</span>
                <select value={draft.protocol} onChange={(event) => update({ protocol: event.target.value })}>
                  {PROTOCOL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              {draft.protocol !== 'All' && draft.protocol !== 'icmp' && (
                <>
                  <label>
                    <span>From Port</span>
                    <input type="number" value={draft.fromPort} onChange={(event) => update({ fromPort: Number(event.target.value) })} />
                  </label>
                  <label>
                    <span>To Port</span>
                    <input type="number" value={draft.toPort} onChange={(event) => update({ toPort: Number(event.target.value) })} />
                  </label>
                </>
              )}

              <label>
                <span>Source Type</span>
                <select value={sourceMode} onChange={(event) => setSourceMode(event.target.value as 'cidr' | 'sg')}>
                  <option value="cidr">CIDR</option>
                  <option value="sg">Security Group</option>
                </select>
              </label>

              {sourceMode === 'cidr' ? (
                <label>
                  <span>CIDR</span>
                  <input placeholder="0.0.0.0/0" value={draft.cidrIp ?? ''} onChange={(event) => update({ cidrIp: event.target.value })} />
                </label>
              ) : (
                <label>
                  <span>Source SG</span>
                  <input placeholder="sg-..." value={draft.sourceGroupId ?? ''} onChange={(event) => update({ sourceGroupId: event.target.value })} />
                </label>
              )}

              <label>
                <span>Description</span>
                <input placeholder="Optional" value={draft.description} onChange={(event) => update({ description: event.target.value })} />
              </label>
            </div>
            <div className="svc-dialog-actions">
              <button type="button" className="svc-btn muted" onClick={onClose}>Cancel</button>
              <button type="button" className="svc-btn primary" disabled={busy} onClick={() => void handleSubmit()}>
                {busy ? 'Adding...' : 'Add Rule'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function SecurityGroupsConsole({
  connection,
  focusSecurityGroupId
}: {
  connection: AwsConnection
  focusSecurityGroupId?: { token: number; securityGroupId: string } | null
}) {
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [groups, setGroups] = useState<SecurityGroupSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<SecurityGroupDetail | null>(null)
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))
  const [modal, setModal] = useState<
    { kind: 'closed' }
    | { kind: 'add-rule'; direction: Direction }
    | { kind: 'delete-rule'; direction: Direction; rule: SecurityGroupRule }
  >({ kind: 'closed' })
  const [sideTab, setSideTab] = useState<'details' | 'inbound' | 'outbound'>('details')
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)

  async function reload() {
    setLoading(true)
    setMsg('')
    setError('')

    try {
      const items = await listSecurityGroups(connection)
      setGroups(items)

      if (!selectedId || !items.some((group) => group.groupId === selectedId)) {
        const first = items[0]?.groupId ?? ''
        setSelectedId(first)
        if (first) setDetail(await describeSecurityGroup(connection, first))
        else setDetail(null)
      } else {
        setDetail(await describeSecurityGroup(connection, selectedId))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (!focusSecurityGroupId || focusSecurityGroupId.token === appliedFocusToken) return
    setAppliedFocusToken(focusSecurityGroupId.token)
    const match = groups.find((group) => group.groupId === focusSecurityGroupId.securityGroupId)
    if (match) void selectGroup(match.groupId)
  }, [appliedFocusToken, focusSecurityGroupId, groups])

  async function selectGroup(groupId: string) {
    setSelectedId(groupId)
    setMsg('')
    setError('')

    try {
      setDetail(await describeSecurityGroup(connection, groupId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onModalDone(feedbackMsg: string) {
    setModal({ kind: 'closed' })
    setMsg(feedbackMsg)
    setError('')
    if (!selectedId) return

    try {
      setDetail(await describeSecurityGroup(connection, selectedId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const activeCols = useMemo(() => COLUMNS.filter((column) => visCols.has(column.key)), [visCols])

  const filteredGroups = useMemo(() => {
    if (!filter) return groups
    const query = filter.toLowerCase()
    return groups.filter((group) => activeCols.some((column) => getColVal(group, column.key).toLowerCase().includes(query)))
  }, [activeCols, filter, groups])

  const aggregateMetrics = useMemo(() => {
    const inboundRules = groups.reduce((total, group) => total + group.inboundRuleCount, 0)
    const outboundRules = groups.reduce((total, group) => total + group.outboundRuleCount, 0)
    const vpcs = new Set(groups.map((group) => group.vpcId).filter(Boolean))
    return {
      inboundRules,
      outboundRules,
      vpcCount: vpcs.size
    }
  }, [groups])

  const selectedSummary = useMemo(() => summarizeSelection(detail), [detail])
  const selectedGroup = groups.find((group) => group.groupId === selectedId) ?? null

  if (loading && !groups.length && !detail) {
    return <div className="svc-empty sg-loading-state">Loading security groups...</div>
  }

  return (
    <div className="svc-console sg-console">
      <section className="sg-shell-hero">
        <div className="sg-shell-copy">
          <div className="eyebrow">Network perimeter</div>
          <h2>Security groups posture</h2>
          <p>Inspect rule surfaces, drill into one group, and manage inbound or outbound access without changing the underlying service flow.</p>
          <div className="sg-shell-meta-strip">
            <div className="sg-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.kind === 'profile' ? connection.profile : connection.accountId || 'Assumed role'}</strong>
            </div>
            <div className="sg-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="sg-shell-meta-pill">
              <span>Selection</span>
              <strong>{selectedGroup?.groupId || 'No group selected'}</strong>
            </div>
          </div>
        </div>

        <div className="sg-shell-stats">
          <div className="sg-shell-stat-card sg-shell-stat-card-accent">
            <span>Groups</span>
            <strong>{groups.length}</strong>
            <small>Security groups discovered in this region.</small>
          </div>
          <div className="sg-shell-stat-card">
            <span>Inbound rules</span>
            <strong>{aggregateMetrics.inboundRules}</strong>
            <small>Total ingress rules across the inventory.</small>
          </div>
          <div className="sg-shell-stat-card">
            <span>Outbound rules</span>
            <strong>{aggregateMetrics.outboundRules}</strong>
            <small>Total egress rules across the inventory.</small>
          </div>
          <div className="sg-shell-stat-card">
            <span>VPCs</span>
            <strong>{aggregateMetrics.vpcCount}</strong>
            <small>Distinct VPC boundaries represented here.</small>
          </div>
        </div>
      </section>

      <div className="sg-shell-toolbar">
        <div className="sg-toolbar-search">
          <label className="sg-toolbar-label" htmlFor="sg-filter">Inventory filter</label>
          <input
            id="sg-filter"
            className="svc-search sg-search"
            placeholder="Filter across visible columns..."
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        <div className="sg-toolbar-actions">
          <button type="button" className="svc-btn muted" onClick={() => void reload()}>Refresh inventory</button>
        </div>
      </div>

      <div className="svc-chips sg-column-chips">
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            className={`svc-chip ${visCols.has(column.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(column.key) ? { background: column.color, borderColor: column.color } : undefined}
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

      {msg && <div className="sg-banner">{msg}</div>}
      {error && <div className="sg-banner sg-banner-error">{error}</div>}

      <div className="sg-main-layout">
        <aside className="sg-list-rail">
          <div className="sg-pane-head">
            <div>
              <span className="sg-pane-kicker">Tracked inventory</span>
              <h3>Group catalog</h3>
            </div>
            <span className="sg-pane-summary">{filteredGroups.length} shown</span>
          </div>

          <div className="sg-group-list">
            {filteredGroups.length ? (
              filteredGroups.map((group) => (
                <button
                  key={group.groupId}
                  type="button"
                  className={`sg-group-row ${group.groupId === selectedId ? 'active' : ''}`}
                  onClick={() => void selectGroup(group.groupId)}
                >
                  <div className="sg-group-row-top">
                    <div className="sg-group-row-copy">
                      <strong>{group.groupName || 'Unnamed group'}</strong>
                      <span>{group.groupId}</span>
                    </div>
                    <span className="sg-vpc-pill">{group.vpcId}</span>
                  </div>

                  <div className="sg-group-row-meta">
                    <span>{group.inboundRuleCount} inbound</span>
                    <span>{group.outboundRuleCount} outbound</span>
                  </div>
                </button>
              ))
            ) : (
              <div className="svc-empty">No security groups match the active filter.</div>
            )}
          </div>
        </aside>

        <section className="sg-detail-pane">
          {detail ? (
            <>
              <section className="sg-detail-hero">
                <div className="sg-detail-hero-copy">
                  <div className="eyebrow">Selected perimeter</div>
                  <h3>{detail.groupName || detail.groupId}</h3>
                  <p>{detail.description || 'No description provided for this security group.'}</p>
                  <div className="sg-detail-meta-strip">
                    <div className="sg-detail-meta-pill">
                      <span>Group ID</span>
                      <strong>{detail.groupId}</strong>
                    </div>
                    <div className="sg-detail-meta-pill">
                      <span>VPC</span>
                      <strong>{detail.vpcId}</strong>
                    </div>
                    <div className="sg-detail-meta-pill">
                      <span>Owner</span>
                      <strong>{detail.ownerId}</strong>
                    </div>
                  </div>
                </div>

                <div className="sg-detail-hero-stats">
                  <div className="sg-detail-stat-card sg-detail-stat-card-accent">
                    <span>Inbound</span>
                    <strong>{detail.inboundRules.length}</strong>
                    <small>Ingress rules attached to this group.</small>
                  </div>
                  <div className="sg-detail-stat-card">
                    <span>Outbound</span>
                    <strong>{detail.outboundRules.length}</strong>
                    <small>Egress rules attached to this group.</small>
                  </div>
                  <div className="sg-detail-stat-card">
                    <span>Tags</span>
                    <strong>{selectedSummary.tagCount}</strong>
                    <small>Metadata pairs available for filtering and ops.</small>
                  </div>
                  <div className="sg-detail-stat-card">
                    <span>Source kinds</span>
                    <strong>{selectedSummary.sourceKinds}</strong>
                    <small>Distinct source patterns across all rules.</small>
                  </div>
                </div>
              </section>

              <div className="sg-detail-tabs">
                <button className={sideTab === 'details' ? 'active' : ''} type="button" onClick={() => setSideTab('details')}>Details</button>
                <button className={sideTab === 'inbound' ? 'active' : ''} type="button" onClick={() => setSideTab('inbound')}>
                  Inbound ({detail.inboundRules.length})
                </button>
                <button className={sideTab === 'outbound' ? 'active' : ''} type="button" onClick={() => setSideTab('outbound')}>
                  Outbound ({detail.outboundRules.length})
                </button>
              </div>

              {sideTab === 'details' && (
                <div className="sg-section">
                  <div className="sg-section-head">
                    <div>
                      <span className="sg-section-kicker">Identity</span>
                      <h4>Group profile</h4>
                    </div>
                  </div>

                  <div className="svc-kv sg-kv-grid">
                    <div className="svc-kv-row"><div className="svc-kv-label">Group ID</div><div className="svc-kv-value">{detail.groupId}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{detail.groupName || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">VPC</div><div className="svc-kv-value">{detail.vpcId}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Description</div><div className="svc-kv-value">{detail.description || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Owner</div><div className="svc-kv-value">{detail.ownerId}</div></div>
                  </div>

                  <div className="sg-summary-grid">
                    <div className="sg-summary-card">
                      <span>Ingress posture</span>
                      <strong>{detail.inboundRules.length}</strong>
                      <small>Rules currently allow traffic into attached resources.</small>
                    </div>
                    <div className="sg-summary-card">
                      <span>Egress posture</span>
                      <strong>{detail.outboundRules.length}</strong>
                      <small>Rules currently allow traffic out to destinations.</small>
                    </div>
                  </div>

                  <div className="sg-tags-section">
                    <div className="sg-section-subhead">
                      <h5>Tags</h5>
                      <span>{selectedSummary.tagCount} entries</span>
                    </div>
                    {Object.keys(detail.tags).length ? (
                      <div className="sg-tag-cloud">
                        {Object.entries(detail.tags).map(([key, value]) => (
                          <span key={key} className="sg-tag-pill">{key}={value}</span>
                        ))}
                      </div>
                    ) : (
                      <div className="svc-empty">No tags on this security group.</div>
                    )}
                  </div>
                </div>
              )}

              {sideTab === 'inbound' && (
                <div className="sg-section">
                  <div className="sg-section-head">
                    <div>
                      <span className="sg-section-kicker">Ingress</span>
                      <h4>Inbound rules</h4>
                    </div>
                    <button type="button" className="svc-btn success" onClick={() => setModal({ kind: 'add-rule', direction: 'inbound' })}>
                      Add inbound rule
                    </button>
                  </div>

                  {detail.inboundRules.length ? (
                    <div className="sg-rule-list">
                      {detail.inboundRules.map((rule, index) => (
                        <div key={`${rule.protocol}-${rule.portRange}-${index}`} className="sg-rule-card">
                          <div className="sg-rule-card-top">
                            <div className="sg-rule-primary">
                              <span className={`sg-rule-protocol ${protocolTone(rule.protocol)}`}>{rule.protocol}</span>
                              <strong>{rule.portRange}</strong>
                            </div>
                            <ConfirmButton className="svc-btn danger" onConfirm={() => setModal({ kind: 'delete-rule', direction: 'inbound', rule })}>
                              Revoke
                            </ConfirmButton>
                          </div>
                          <div className="sg-rule-sources">
                            {rule.sources.map((source, sourceIndex) => (
                              <span key={`${source}-${sourceIndex}`} className="sg-rule-source-pill">{source}</span>
                            ))}
                          </div>
                          <p>{rule.description || 'No rule description.'}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="svc-empty">No inbound rules.</div>
                  )}
                </div>
              )}

              {sideTab === 'outbound' && (
                <div className="sg-section">
                  <div className="sg-section-head">
                    <div>
                      <span className="sg-section-kicker">Egress</span>
                      <h4>Outbound rules</h4>
                    </div>
                    <button type="button" className="svc-btn success" onClick={() => setModal({ kind: 'add-rule', direction: 'outbound' })}>
                      Add outbound rule
                    </button>
                  </div>

                  {detail.outboundRules.length ? (
                    <div className="sg-rule-list">
                      {detail.outboundRules.map((rule, index) => (
                        <div key={`${rule.protocol}-${rule.portRange}-${index}`} className="sg-rule-card">
                          <div className="sg-rule-card-top">
                            <div className="sg-rule-primary">
                              <span className={`sg-rule-protocol ${protocolTone(rule.protocol)}`}>{rule.protocol}</span>
                              <strong>{rule.portRange}</strong>
                            </div>
                            <ConfirmButton className="svc-btn danger" onConfirm={() => setModal({ kind: 'delete-rule', direction: 'outbound', rule })}>
                              Revoke
                            </ConfirmButton>
                          </div>
                          <div className="sg-rule-sources">
                            {rule.sources.map((source, sourceIndex) => (
                              <span key={`${source}-${sourceIndex}`} className="sg-rule-source-pill">{source}</span>
                            ))}
                          </div>
                          <p>{rule.description || 'No rule description.'}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="svc-empty">No outbound rules.</div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="svc-empty">Select a security group to view details.</div>
          )}
        </section>
      </div>

      {modal.kind !== 'closed' && detail && (
        <RuleModal
          modal={modal}
          groupId={detail.groupId}
          connection={connection}
          onClose={() => setModal({ kind: 'closed' })}
          onDone={(message) => void onModalDone(message)}
        />
      )}
    </div>
  )
}
