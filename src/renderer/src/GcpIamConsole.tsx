import { useEffect, useMemo, useState } from 'react'
import './gcp-iam-console.css'
import './iam.css'
import {
  getGcpIamOverview,
  addGcpIamBinding,
  removeGcpIamBinding,
  createGcpServiceAccount,
  deleteGcpServiceAccount,
  disableGcpServiceAccount,
  listGcpServiceAccountKeys,
  createGcpServiceAccountKey,
  deleteGcpServiceAccountKey,
  listGcpRoles,
  createGcpCustomRole,
  deleteGcpCustomRole,
  testGcpIamPermissions,
} from './api'
import type {
  GcpIamBindingSummary,
  GcpServiceAccountSummary,
  GcpServiceAccountKeySummary,
  GcpIamRoleSummary,
  GcpIamOverview,
  GcpIamTestPermissionsResult,
} from '@shared/types'
import { SvcState } from './SvcState'

/* Types */
type MainTab = 'bindings' | 'service-accounts' | 'roles' | 'overview' | 'simulator'
type ColDef<T> = { key: string; label: string; color: string; getValue: (item: T) => string }
type RoleScope = 'custom' | 'all'

const MAIN_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'bindings', label: 'Bindings' },
  { id: 'service-accounts', label: 'Service Accounts' },
  { id: 'roles', label: 'Roles' },
  { id: 'overview', label: 'Overview' },
  { id: 'simulator', label: 'Simulator' },
]

const GCP_SIM_PERMISSIONS = [
  'iam.serviceAccounts.list', 'iam.serviceAccounts.create', 'iam.serviceAccounts.delete',
  'iam.serviceAccounts.get', 'iam.serviceAccounts.actAs',
  'iam.serviceAccountKeys.list', 'iam.serviceAccountKeys.create', 'iam.serviceAccountKeys.delete',
  'iam.roles.list', 'iam.roles.create', 'iam.roles.delete', 'iam.roles.get', 'iam.roles.update',
  'resourcemanager.projects.get', 'resourcemanager.projects.list',
  'resourcemanager.projects.setIamPolicy', 'resourcemanager.projects.getIamPolicy',
  'compute.instances.list', 'compute.instances.get', 'compute.instances.create',
  'compute.instances.delete', 'compute.instances.start', 'compute.instances.stop',
  'compute.instances.reset', 'compute.disks.list', 'compute.disks.create',
  'compute.networks.list', 'compute.firewalls.list', 'compute.firewalls.create',
  'compute.firewalls.delete',
  'storage.buckets.list', 'storage.buckets.get', 'storage.buckets.create',
  'storage.buckets.delete', 'storage.objects.list', 'storage.objects.get',
  'storage.objects.create', 'storage.objects.delete',
  'container.clusters.list', 'container.clusters.get', 'container.clusters.create',
  'container.clusters.delete', 'container.clusters.update',
  'cloudsql.instances.list', 'cloudsql.instances.get', 'cloudsql.instances.create',
  'cloudsql.instances.delete', 'cloudsql.instances.update',
  'logging.logEntries.list', 'logging.logEntries.create',
  'bigquery.datasets.get', 'bigquery.datasets.create', 'bigquery.datasets.delete',
  'bigquery.tables.list', 'bigquery.tables.get',
  'cloudkms.keyRings.list', 'cloudkms.cryptoKeys.list', 'cloudkms.cryptoKeyVersions.useToDecrypt',
  'pubsub.topics.list', 'pubsub.topics.create', 'pubsub.subscriptions.list',
  'secretmanager.secrets.list', 'secretmanager.secrets.get', 'secretmanager.versions.access',
  'billing.accounts.get', 'billing.accounts.list',
]


const BINDING_COLS: ColDef<GcpIamBindingSummary>[] = [
  { key: 'role', label: 'Role', color: '#3b82f6', getValue: b => b.role },
  { key: 'members', label: 'Members', color: '#14b8a6', getValue: b => String(b.memberCount) },
  { key: 'type', label: 'Type', color: '#8b5cf6', getValue: b => b.publicAccess ? 'Public' : b.risky ? 'Risky' : 'Standard' },
  { key: 'condition', label: 'Condition', color: '#f59e0b', getValue: b => b.conditionTitle || '-' },
]

const SA_COLS: ColDef<GcpServiceAccountSummary>[] = [
  { key: 'email', label: 'Email', color: '#3b82f6', getValue: sa => sa.email },
  { key: 'displayName', label: 'Display Name', color: '#14b8a6', getValue: sa => sa.displayName || '-' },
  { key: 'status', label: 'Status', color: '#22c55e', getValue: sa => sa.disabled ? 'Disabled' : 'Active' },
]

const ROLE_COLS: ColDef<GcpIamRoleSummary>[] = [
  { key: 'title', label: 'Title', color: '#3b82f6', getValue: r => r.title || r.name },
  { key: 'stage', label: 'Stage', color: '#14b8a6', getValue: r => r.stage || '-' },
  { key: 'type', label: 'Type', color: '#8b5cf6', getValue: r => r.isCustom ? 'Custom' : 'Predefined' },
  { key: 'permissions', label: 'Permissions', color: '#f59e0b', getValue: r => r.isCustom ? String(r.permissionCount) : '-' },
]

function confirmGcpDelete(label: string, name: string): boolean {
  return (
    window.confirm('Delete ' + label + ' "' + name + '"?') &&
    window.confirm('Confirm deletion of ' + label + ' "' + name + '". This action may be irreversible.')
  )
}

function summarizeGcpMember(member: string): string {
  const normalized = member.trim()
  if (!normalized) return '-'
  if (normalized === 'allUsers' || normalized === 'allAuthenticatedUsers') return normalized
  const parts = normalized.split(':')
  return parts.length > 1 ? parts.slice(1).join(':') : normalized
}

function extractQuotedCommand(error: string): string | null {
  const m = error.match(/Run "([^"]+)"/i)
  return m != null ? m[1].trim() : null
}

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string,
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  const cmd = extractQuotedCommand(error)
  return { command: cmd !== null ? cmd : fallbackCommand, summary }
}

function formatTs(value: string): string {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function gcpPermissionService(perm: string): string {
  const idx = perm.indexOf('.')
  return idx >= 0 ? perm.slice(0, idx) : perm
}

function toggleSetItem(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  return next
}


/* Sub-components */

function ColChips({ cols, visible, onToggle }: {
  cols: ColDef<any>[]
  visible: Set<string>
  onToggle: (key: string) => void
}) {
  return (
    <div className="iam-section-chips">
      {cols.map(c => (
        <button
          key={c.key}
          type="button"
          className={`svc-chip ${visible.has(c.key) ? 'active' : ''}`}
          style={visible.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
          onClick={() => onToggle(c.key)}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

function SidebarSection({ id, label, expanded, onToggle, children }: {
  id: string
  label: string
  expanded: boolean
  onToggle: (id: string) => void
  children: React.ReactNode
}) {
  return (
    <>
      <div className="iam-section-header" onClick={() => onToggle(id)}>
        <span>{expanded ? '−' : '+'}</span>
        <span style={{ flex: 1 }}>{label}</span>
      </div>
      {expanded && <div className="iam-section-content">{children}</div>}
    </>
  )
}


/* BINDINGS TAB */

function BindingsTab({
  projectId,
  bindings,
  loading,
  onRefresh,
}: {
  projectId: string
  bindings: GcpIamBindingSummary[]
  loading: boolean
  onRefresh: () => void
}) {
  const [filter, setFilter] = useState('')
  const [visibleCols, setVisibleCols] = useState(() => new Set(BINDING_COLS.map(c => c.key)))
  const [selected, setSelected] = useState<GcpIamBindingSummary | null>(null)
  const [expandedSections, setExpandedSections] = useState(() => new Set(['members', 'addMember']))
  const [newRole, setNewRole] = useState('')
  const [newMember, setNewMember] = useState('')
  const [addMemberInput, setAddMemberInput] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)

  const activeCols = BINDING_COLS.filter(c => visibleCols.has(c.key))
  const filtered = useMemo(() => {
    if (!filter) return bindings
    const s = filter.toLowerCase()
    return bindings.filter(b => activeCols.some(c => c.getValue(b).toLowerCase().includes(s)))
  }, [bindings, filter, activeCols])

  function toggleSection(id: string) {
    setExpandedSections(prev => toggleSetItem(prev, id))
  }

  async function handleAddBinding() {
    if (!newRole.trim() || !newMember.trim()) return
    setBusy(true); setError(''); setSuccess('')
    try {
      await addGcpIamBinding(projectId, newRole.trim(), newMember.trim())
      setSuccess('Added member "' + newMember.trim() + '" to role "' + newRole.trim() + '".')
      setNewRole('')
      setNewMember('')
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemoveMember(role: string, member: string) {
    if (!window.confirm('Remove member "' + member + '" from role "' + role + '"?')) return
    setBusy(true); setError(''); setSuccess('')
    try {
      await removeGcpIamBinding(projectId, role, member)
      setSuccess('Removed member "' + member + '" from role "' + role + '".')
      setSelected(prev => (prev !== null && prev.role === role) ? null : prev)
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleAddMemberToBinding() {
    if (selected === null || !addMemberInput.trim()) return
    setBusy(true); setError(''); setSuccess('')
    try {
      await addGcpIamBinding(projectId, selected.role, addMemberInput.trim())
      setSuccess('Added member "' + addMemberInput.trim() + '" to role "' + selected.role + '".')
      setAddMemberInput('')
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Create form */}
      <div className="gcp-iam-create-form">
        <span className="iam-pane-kicker" style={{ display: 'block', marginBottom: 8 }}>Add Binding</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="iam-section-search"
            style={{ flex: '1 1 200px' }}
            placeholder="Role (e.g. roles/viewer)"
            value={newRole}
            onChange={e => setNewRole(e.target.value)}
          />
          <input
            className="iam-section-search"
            style={{ flex: '1 1 200px' }}
            placeholder="Member (e.g. user:alice@example.com)"
            value={newMember}
            onChange={e => setNewMember(e.target.value)}
          />
          <button
            className="svc-btn success"
            type="button"
            disabled={busy || !newRole.trim() || !newMember.trim()}
            onClick={() => void handleAddBinding()}
          >
            Add Binding
          </button>
        </div>
      </div>

      {error !== '' && <div className="error-banner">{error}</div>}
      {success !== '' && <div className="success-banner">{success}</div>}

      <div className="gcp-iam-filter-row">
        <input
          className="iam-section-search"
          placeholder="Filter bindings..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <ColChips cols={BINDING_COLS} visible={visibleCols} onToggle={key => setVisibleCols(prev => toggleSetItem(prev, key))} />
      </div>

      <div className="iam-layout">
        {/* Left: table */}
        <div className="iam-table-area">
          <table className="svc-table">
            <thead>
              <tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={activeCols.length} style={{ textAlign: 'center', color: '#6b7688' }}>Loading...</td></tr>
              )}
              {!loading && filtered.map(b => (
                <tr
                  key={b.role}
                  className={selected !== null && selected.role === b.role ? 'active' : ''}
                  onClick={() => setSelected(prev => (prev !== null && prev.role === b.role) ? null : b)}
                  style={{ cursor: 'pointer' }}
                >
                  {activeCols.map(c => {
                    const val = c.getValue(b)
                    if (c.key === 'type') {
                      const cls = val === 'Public' ? 'svc-badge danger' : val === 'Risky' ? 'svc-badge warn' : 'svc-badge muted'
                      return <td key={c.key}><span className={cls}>{val}</span></td>
                    }
                    return <td key={c.key}>{val}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <div className="svc-empty">No bindings found.</div>
          )}
        </div>

        {/* Right: sidebar */}
        <div className="iam-sidebar">
          {selected === null ? (
            <div className="iam-sidebar-placeholder">Select a binding to view members</div>
          ) : (
            <>
              <SidebarSection
                id="members"
                label={'Members (' + String(selected.memberCount) + ')'}
                expanded={expandedSections.has('members')}
                onToggle={toggleSection}
              >
                {selected.memberCount > 6 && (
                  <div style={{ color: '#8fa3ba', fontSize: '11px', marginBottom: 6 }}>
                    {'Showing first ' + String(selected.members.length) + ' of ' + String(selected.memberCount) + ' members.'}
                  </div>
                )}
                {selected.members.length > 0 ? (
                  <table className="iam-mini-table">
                    <thead>
                      <tr><th>Member</th><th>Action</th></tr>
                    </thead>
                    <tbody>
                      {selected.members.map(m => (
                        <tr key={m}>
                          <td title={m}>{summarizeGcpMember(m)}</td>
                          <td>
                            <button
                              className="svc-btn danger"
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRemoveMember(selected.role, m)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="svc-empty" style={{ fontSize: '11px' }}>No members listed.</div>
                )}
              </SidebarSection>

              <SidebarSection
                id="addMember"
                label="Add Member"
                expanded={expandedSections.has('addMember')}
                onToggle={toggleSection}
              >
                <div className="iam-inline-input">
                  <input
                    placeholder="Member (e.g. user:alice@example.com)"
                    value={addMemberInput}
                    onChange={e => setAddMemberInput(e.target.value)}
                  />
                  <button
                    className="svc-btn success"
                    type="button"
                    disabled={busy || !addMemberInput.trim()}
                    onClick={() => void handleAddMemberToBinding()}
                  >
                    Add Member
                  </button>
                </div>
              </SidebarSection>
            </>
          )}
        </div>
      </div>
    </>
  )
}


/* SERVICE ACCOUNTS TAB */

function ServiceAccountsTab({
  projectId,
  serviceAccounts,
  loading,
  onRefresh,
}: {
  projectId: string
  serviceAccounts: GcpServiceAccountSummary[]
  loading: boolean
  onRefresh: () => void
}) {
  const [filter, setFilter] = useState('')
  const [visibleCols, setVisibleCols] = useState(() => new Set(SA_COLS.map(c => c.key)))
  const [selected, setSelected] = useState<GcpServiceAccountSummary | null>(null)
  const [keys, setKeys] = useState<GcpServiceAccountKeySummary[]>([])
  const [keysLoading, setKeysLoading] = useState(false)
  const [newKeyData, setNewKeyData] = useState<{ keyId: string; privateKeyData: string } | null>(null)
  const [expandedSections, setExpandedSections] = useState(() => new Set<string>(['keys']))
  const [newAccountId, setNewAccountId] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)

  const activeCols = SA_COLS.filter(c => visibleCols.has(c.key))
  const filtered = useMemo(() => {
    if (!filter) return serviceAccounts
    const s = filter.toLowerCase()
    return serviceAccounts.filter(sa => activeCols.some(c => c.getValue(sa).toLowerCase().includes(s)))
  }, [serviceAccounts, filter, activeCols])

  function toggleSection(id: string) {
    setExpandedSections(prev => toggleSetItem(prev, id))
  }

  async function selectSA(sa: GcpServiceAccountSummary) {
    setSelected(sa); setNewKeyData(null); setKeys([]); setKeysLoading(true); setError('')
    try {
      const ks = await listGcpServiceAccountKeys(projectId, sa.email)
      setKeys(ks)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setKeysLoading(false) }
  }

  async function handleCreateSA() {
    if (!newAccountId.trim()) return
    setBusy(true); setError(''); setSuccess('')
    try {
      await createGcpServiceAccount(projectId, newAccountId.trim(), newDisplayName.trim(), newDescription.trim())
      setSuccess('Service account created: ' + newAccountId.trim())
      setNewAccountId(''); setNewDisplayName(''); setNewDescription('')
      onRefresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function handleDeleteSA() {
    if (!selected) return
    if (!confirmGcpDelete('service account', selected.email)) return
    setBusy(true); setError(''); setSuccess('')
    try {
      await deleteGcpServiceAccount(projectId, selected.email)
      setSuccess('Deleted: ' + selected.email)
      setSelected(null); setKeys([]); onRefresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function handleToggleDisabled() {
    if (!selected) return
    const nd = !selected.disabled
    setBusy(true); setError(''); setSuccess('')
    try {
      await disableGcpServiceAccount(projectId, selected.email, nd)
      setSuccess((nd ? 'Disabled' : 'Enabled') + ': ' + selected.email)
      setSelected(prev => prev ? { ...prev, disabled: nd } : null)
      onRefresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function handleCreateKey() {
    if (!selected) return
    setBusy(true); setError(''); setSuccess('')
    try {
      const result = await createGcpServiceAccountKey(projectId, selected.email)
      setNewKeyData({ keyId: result.keyId, privateKeyData: result.privateKeyData })
      const ks = await listGcpServiceAccountKeys(projectId, selected.email)
      setKeys(ks)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function handleDeleteKey(keyId: string) {
    if (!selected) return
    if (!confirmGcpDelete('key', keyId)) return
    setBusy(true); setError(''); setSuccess('')
    try {
      await deleteGcpServiceAccountKey(projectId, selected.email, keyId)
      setSuccess('Key deleted: ' + keyId)
      const ks = await listGcpServiceAccountKeys(projectId, selected.email)
      setKeys(ks)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <>
      <div className="gcp-iam-create-form">
        <span className="iam-pane-kicker" style={{ display: 'block', marginBottom: 8 }}>Create Service Account</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="iam-section-search"
            style={{ flex: '1 1 160px' }}
            placeholder="Account ID (e.g. my-service)"
            value={newAccountId}
            onChange={e => setNewAccountId(e.target.value)}
          />
          <input
            className="iam-section-search"
            style={{ flex: '1 1 160px' }}
            placeholder="Display Name"
            value={newDisplayName}
            onChange={e => setNewDisplayName(e.target.value)}
          />
          <input
            className="iam-section-search"
            style={{ flex: '1 1 160px' }}
            placeholder="Description (optional)"
            value={newDescription}
            onChange={e => setNewDescription(e.target.value)}
          />
          <button
            className="svc-btn success"
            type="button"
            disabled={busy || !newAccountId.trim()}
            onClick={() => void handleCreateSA()}
          >Create</button>
        </div>
      </div>

      {error !== '' && <div className="error-banner">{error}</div>}
      {success !== '' && <div className="success-banner">{success}</div>}

      <div className="gcp-iam-filter-row">
        <input
          className="iam-section-search"
          placeholder="Filter service accounts..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <ColChips cols={SA_COLS} visible={visibleCols} onToggle={key => setVisibleCols(prev => toggleSetItem(prev, key))} />
      </div>

      <div className="iam-layout">
        <div className="iam-table-area">
          <table className="svc-table">
            <thead>
              <tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length} style={{ textAlign: 'center', color: '#6b7688' }}>Loading...</td></tr>}
              {!loading && filtered.map(sa => (
                <tr
                  key={sa.email}
                  className={selected?.email === sa.email ? 'active' : ''}
                  onClick={() => void selectSA(sa)}
                  style={{ cursor: 'pointer' }}
                >
                  {activeCols.map(c => {
                    if (c.key === 'status') {
                      const isActive = !sa.disabled
                      return <td key={c.key}><span className={isActive ? 'svc-badge ok' : 'svc-badge muted'}>{c.getValue(sa)}</span></td>
                    }
                    return <td key={c.key}>{c.getValue(sa)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && <div className="svc-empty">No service accounts found.</div>}
        </div>

        <div className="iam-sidebar">
          {!selected ? (
            <div className="iam-sidebar-placeholder">Select a service account to view details</div>
          ) : (
            <>
              <SidebarSection id="keys" label="Keys" expanded={expandedSections.has('keys')} onToggle={toggleSection}>
                {keysLoading && <SvcState variant="loading" resourceName="keys" compact />}
                {!keysLoading && newKeyData && (
                  <div className="gcp-iam-key-reveal">
                    <strong>New Key (copy now — will not be shown again)</strong>
                    <div style={{ fontSize: '11px', color: '#8fa3ba' }}>Key ID: {newKeyData.keyId}</div>
                    <textarea readOnly value={newKeyData.privateKeyData} rows={4} />
                  </div>
                )}
                {!keysLoading && keys.length > 0 && (
                  <table className="iam-mini-table">
                    <thead><tr><th>Key ID</th><th>Type</th><th>Valid After</th><th>Action</th></tr></thead>
                    <tbody>
                      {keys.map(k => (
                        <tr key={k.keyId}>
                          <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{k.keyId.slice(0, 16)}...</td>
                          <td>{k.keyType}</td>
                          <td>{formatTs(k.validAfterTime)}</td>
                          <td>
                            <button
                              className="svc-btn danger"
                              type="button"
                              disabled={busy}
                              onClick={() => void handleDeleteKey(k.keyId)}
                            >Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {!keysLoading && keys.length === 0 && !newKeyData && (
                  <div className="svc-empty" style={{ fontSize: '11px' }}>No keys.</div>
                )}
                <button
                  className="svc-btn success"
                  type="button"
                  style={{ marginTop: 8 }}
                  disabled={busy}
                  onClick={() => void handleCreateKey()}
                >Create Key</button>
              </SidebarSection>

              <SidebarSection id="actions" label="Actions" expanded={expandedSections.has('actions')} onToggle={toggleSection}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    className={selected.disabled ? 'svc-btn success' : 'svc-btn ghost'}
                    type="button"
                    disabled={busy}
                    onClick={() => void handleToggleDisabled()}
                  >
                    {selected.disabled ? 'Enable Service Account' : 'Disable Service Account'}
                  </button>
                  <button
                    className="svc-btn danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDeleteSA()}
                  >Delete Service Account</button>
                </div>
              </SidebarSection>
            </>
          )}
        </div>
      </div>
    </>
  )
}


/* ROLES TAB */

function RolesTab({ projectId }: { projectId: string }) {
  const [scope, setScope] = useState<RoleScope>('custom')
  const [roles, setRoles] = useState<GcpIamRoleSummary[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [visibleCols, setVisibleCols] = useState(() => new Set(ROLE_COLS.map(c => c.key)))
  const [selected, setSelected] = useState<GcpIamRoleSummary | null>(null)
  const [expandedSections, setExpandedSections] = useState(() => new Set<string>(['permissions', 'meta']))
  const [newRoleId, setNewRoleId] = useState('')
  const [newRoleTitle, setNewRoleTitle] = useState('')
  const [newRoleDesc, setNewRoleDesc] = useState('')
  const [newRolePerms, setNewRolePerms] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRolesLoading(true); setError('')
    listGcpRoles(projectId, scope)
      .then(r => setRoles(r))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRolesLoading(false))
  }, [projectId, scope])

  const activeCols = ROLE_COLS.filter(c => visibleCols.has(c.key))
  const filtered = useMemo(() => {
    if (!filter) return roles
    const s = filter.toLowerCase()
    return roles.filter(r => activeCols.some(c => c.getValue(r).toLowerCase().includes(s)))
  }, [roles, filter, activeCols])

  function toggleSection(id: string) {
    setExpandedSections(prev => toggleSetItem(prev, id))
  }

  async function handleCreateRole() {
    if (!newRoleId.trim() || !newRoleTitle.trim()) return
    const perms = newRolePerms.split('\n').map(p => p.trim()).filter(Boolean)
    setBusy(true); setError(''); setSuccess('')
    try {
      await createGcpCustomRole(projectId, newRoleId.trim(), newRoleTitle.trim(), newRoleDesc.trim(), perms)
      setSuccess('Custom role created: ' + newRoleId.trim())
      setNewRoleId(''); setNewRoleTitle(''); setNewRoleDesc(''); setNewRolePerms('')
      setRolesLoading(true)
      const r = await listGcpRoles(projectId, scope)
      setRoles(r)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false); setRolesLoading(false) }
  }

  async function handleDeleteRole() {
    if (!selected || !selected.isCustom) return
    if (!confirmGcpDelete('role', selected.name)) return
    setBusy(true); setError(''); setSuccess('')
    try {
      await deleteGcpCustomRole(projectId, selected.name)
      setSuccess('Role deleted: ' + selected.name)
      setSelected(null)
      const r = await listGcpRoles(projectId, scope)
      setRoles(r)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <>
      <div className="gcp-iam-create-form">
        <span className="iam-pane-kicker" style={{ display: 'block', marginBottom: 8 }}>Create Custom Role</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="iam-section-search" style={{ flex: '1 1 140px' }} placeholder="Role ID" value={newRoleId} onChange={e => setNewRoleId(e.target.value)} />
          <input className="iam-section-search" style={{ flex: '1 1 140px' }} placeholder="Title" value={newRoleTitle} onChange={e => setNewRoleTitle(e.target.value)} />
          <input className="iam-section-search" style={{ flex: '1 1 140px' }} placeholder="Description" value={newRoleDesc} onChange={e => setNewRoleDesc(e.target.value)} />
        </div>
        <div style={{ marginTop: 8 }}>
          <textarea
            className="iam-policy-editor"
            placeholder={'Permissions (one per line)\ne.g. storage.objects.get'}
            value={newRolePerms}
            onChange={e => setNewRolePerms(e.target.value)}
            rows={3}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <button className="svc-btn success" type="button" disabled={busy || !newRoleId.trim() || !newRoleTitle.trim()} onClick={() => void handleCreateRole()}>
            Create Custom Role
          </button>
        </div>
      </div>

      {error !== '' && <div className="error-banner">{error}</div>}
      {success !== '' && <div className="success-banner">{success}</div>}

      <div className="gcp-iam-filter-row">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="iam-section-search" style={{ flex: 1 }} placeholder="Filter roles..." value={filter} onChange={e => setFilter(e.target.value)} />
          <div className="gcp-iam-scope-toggle">
            <button className={`gcp-iam-scope-btn ${scope === 'custom' ? 'active' : ''}`} type="button" onClick={() => { setScope('custom'); setSelected(null) }}>Custom Only</button>
            <button className={`gcp-iam-scope-btn ${scope === 'all' ? 'active' : ''}`} type="button" onClick={() => { setScope('all'); setSelected(null) }}>All Roles</button>
          </div>
        </div>
        <ColChips cols={ROLE_COLS} visible={visibleCols} onToggle={key => setVisibleCols(prev => toggleSetItem(prev, key))} />
      </div>

      <div className="iam-layout">
        <div className="iam-table-area">
          <table className="svc-table">
            <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rolesLoading && <tr><td colSpan={activeCols.length} style={{ textAlign: 'center', color: '#6b7688' }}>Loading...</td></tr>}
              {!rolesLoading && filtered.map(r => (
                <tr
                  key={r.name}
                  className={selected?.name === r.name ? 'active' : ''}
                  onClick={() => setSelected(prev => prev?.name === r.name ? null : r)}
                  style={{ cursor: 'pointer' }}
                >
                  {activeCols.map(c => {
                    if (c.key === 'type') {
                      return <td key={c.key}><span className={r.isCustom ? 'svc-badge ok' : 'svc-badge muted'}>{c.getValue(r)}</span></td>
                    }
                    return <td key={c.key}>{c.getValue(r)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!rolesLoading && filtered.length === 0 && <div className="svc-empty">No roles found.</div>}
        </div>

        <div className="iam-sidebar">
          {!selected ? (
            <div className="iam-sidebar-placeholder">Select a role to view details</div>
          ) : (
            <>
              <SidebarSection id="meta" label="Role Details" expanded={expandedSections.has('meta')} onToggle={toggleSection}>
                <div className="iam-metadata-grid">
                  <div><span>Name</span><strong style={{ wordBreak: 'break-all', fontSize: '0.75rem' }}>{selected.name}</strong></div>
                  <div><span>Stage</span><strong>{selected.stage || '-'}</strong></div>
                  <div><span>Type</span><strong>{selected.isCustom ? 'Custom' : 'Predefined'}</strong></div>
                  <div><span>Permissions</span><strong>{selected.permissionCount}</strong></div>
                </div>
                {selected.description && (
                  <p style={{ marginTop: 8, color: '#a6bbcf', fontSize: '0.8rem' }}>{selected.description}</p>
                )}
                {selected.isCustom && (
                  <button
                    className="svc-btn danger"
                    type="button"
                    style={{ marginTop: 10 }}
                    disabled={busy}
                    onClick={() => void handleDeleteRole()}
                  >Delete Role</button>
                )}
              </SidebarSection>
              <SidebarSection id="permissions" label={'Permissions (' + String(selected.includedPermissions.length) + ')'} expanded={expandedSections.has('permissions')} onToggle={toggleSection}>
                {selected.includedPermissions.length > 0 ? (
                  <table className="iam-mini-table">
                    <thead><tr><th>Service</th><th>Permission</th></tr></thead>
                    <tbody>
                      {selected.includedPermissions.map(p => (
                        <tr key={p}>
                          <td>{gcpPermissionService(p)}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{p}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="svc-empty" style={{ fontSize: '11px' }}>No permissions listed for this role.</div>
                )}
              </SidebarSection>
            </>
          )}
        </div>
      </div>
    </>
  )
}


/* SIMULATOR TAB */

function SimulatorTab({ projectId }: { projectId: string }) {
  const [permFilter, setPermFilter] = useState('')
  const [results, setResults] = useState<GcpIamTestPermissionsResult[]>([])
  const [resultFilter, setResultFilter] = useState('')
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(
    () => new Set(GCP_SIM_PERMISSIONS)
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasRun, setHasRun] = useState(false)

  const filteredPerms = useMemo(() => {
    if (!permFilter) return GCP_SIM_PERMISSIONS
    const s = permFilter.toLowerCase()
    return GCP_SIM_PERMISSIONS.filter(p => p.toLowerCase().includes(s))
  }, [permFilter])

  const filteredResults = useMemo(() => {
    if (!resultFilter) return results
    const s = resultFilter.toLowerCase()
    return results.filter(r => r.permission.toLowerCase().includes(s))
  }, [results, resultFilter])

  const allowedCount = results.filter(r => r.allowed).length
  const deniedCount = results.filter(r => !r.allowed).length
  const selectedPermissionList = GCP_SIM_PERMISSIONS.filter(permission => selectedPermissions.has(permission))
  const selectedVisiblePermissionCount = filteredPerms.filter(permission => selectedPermissions.has(permission)).length

  function togglePermission(permission: string) {
    setSelectedPermissions((current) => {
      const next = new Set(current)
      if (next.has(permission)) next.delete(permission)
      else next.add(permission)
      return next
    })
  }

  async function handleRunTest() {
    if (selectedPermissionList.length === 0) {
      setError('Select at least one permission to test.')
      setResults([])
      setHasRun(false)
      return
    }

    setLoading(true); setError(''); setHasRun(false)
    try {
      const res = await testGcpIamPermissions(projectId, selectedPermissionList)
      setResults(res); setHasRun(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  return (
    <div className="sim-layout">
      {/* Left: Permission list */}
      <div className="sim-panel">
        <div className="sim-panel-body">
          <input
            className="iam-section-search"
            placeholder="Filter permissions..."
            value={permFilter}
            onChange={e => setPermFilter(e.target.value)}
          />
          <div className="iam-caret">
            {selectedPermissionList.length} permissions selected for testing
            {permFilter ? ` • ${selectedVisiblePermissionCount} visible` : ''}
          </div>
          <div className="sim-table-scroll">
            <table className="iam-mini-table">
              <thead>
                <tr><th>Service</th><th>Permission</th></tr>
              </thead>
              <tbody>
                {filteredPerms.map(p => (
                  <tr
                    key={p}
                    className={selectedPermissions.has(p) ? 'sim-row-selected sim-row-clickable' : 'sim-row-clickable'}
                    onClick={() => togglePermission(p)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        togglePermission(p)
                      }
                    }}
                    tabIndex={0}
                    aria-selected={selectedPermissions.has(p)}
                  >
                    <td><span className="sim-service-icon">{gcpPermissionService(p)}</span></td>
                    <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{p}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="sim-panel-footer">
          {error !== '' && <div className="error-banner" style={{ width: '100%', marginBottom: 8 }}>{error}</div>}
          <button
            className="svc-btn success"
            type="button"
            disabled={loading || selectedPermissionList.length === 0}
            onClick={() => void handleRunTest()}
          >
            {loading ? 'Testing...' : 'Run Permission Test'}
          </button>
        </div>
      </div>

      {/* Right: Results */}
      <div className="sim-panel">
        <div className="sim-panel-body">
          {hasRun && (
            <div className="gcp-sim-permission-count">
              <span style={{ color: '#4ade80' }}>{allowedCount} allowed</span>
              <span style={{ color: '#f87171' }}>{deniedCount} denied</span>
              <span>{results.length} total</span>
            </div>
          )}
          <input
            className="iam-section-search"
            placeholder="Filter results..."
            value={resultFilter}
            onChange={e => setResultFilter(e.target.value)}
          />
          <div className="iam-section-chips">
            <span className="iam-pane-kicker">Results</span>
          </div>
          <div className="sim-table-scroll">
            <table className="iam-mini-table">
              <thead>
                <tr><th>Service</th><th>Permission</th><th>Access</th></tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', color: '#6b7688' }}>Running test...</td></tr>
                )}
                {!loading && hasRun && filteredResults.map(r => (
                  <tr key={r.permission}>
                    <td>{gcpPermissionService(r.permission)}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{r.permission}</td>
                    <td>
                      <span className={r.allowed ? 'svc-badge ok' : 'svc-badge danger'}>
                        {r.allowed ? 'Allowed' : 'Denied'}
                      </span>
                    </td>
                  </tr>
                ))}
                {!loading && !hasRun && (
                  <tr>
                    <td colSpan={3} style={{ textAlign: 'center', color: '#6b7688', padding: 16 }}>
                      Click Run Permission Test to check what permissions the current credentials have.
                    </td>
                  </tr>
                )}
                {!loading && hasRun && filteredResults.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ textAlign: 'center', color: '#6b7688', padding: 16 }}>No matching results.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}


/* OVERVIEW TAB */

function OverviewTab({
  projectId,
  location,
  overview,
  loading,
  error,
  onRunTerminalCommand,
  canRunTerminalCommand,
}: {
  projectId: string
  location: string
  overview: GcpIamOverview | null
  loading: boolean
  error: string
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const locationLabel = location.trim() || 'global'
  const enableAction = error ? getGcpApiEnableAction(
    error,
    'gcloud services enable cloudresourcemanager.googleapis.com iam.googleapis.com --project ' + projectId,
    'IAM visibility is incomplete for project ' + projectId + '.',
  ) : null
  const inspectPolicyCommand = 'gcloud projects get-iam-policy ' + projectId
  const listSACommand = 'gcloud iam service-accounts list --project ' + projectId

  return (
    <>
      {enableAction ? (
        <div className="error-banner gcp-enable-error-banner">
          <div className="gcp-enable-error-copy">
            <strong>{enableAction.summary}</strong>
            <p>
              {canRunTerminalCommand
                ? 'Run the enable command in the terminal, wait for propagation, then retry.'
                : 'Switch Settings to Operator mode to enable terminal actions.'}
            </p>
          </div>
          <div className="gcp-enable-error-actions">
            <button
              type="button"
              disabled={!canRunTerminalCommand}
              onClick={() => onRunTerminalCommand(enableAction.command)}
              title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode'}
            >
              Run enable command in terminal
            </button>
          </div>
        </div>
      ) : null}

      {error !== '' && !enableAction ? <SvcState variant="error" error={error} /> : null}
      {loading ? <SvcState variant="loading" resourceName="IAM posture" compact /> : null}

      {overview ? (
        <>
          <div className="overview-section-title">Project IAM Context</div>
          <section className="overview-account-grid">
            <article className="overview-account-card">
              <div className="panel-header minor">
                <h3>Policy Summary</h3>
              </div>
              <div className="overview-account-kv">
                <div><span>Bindings</span><strong>{overview.bindingCount}</strong></div>
                <div><span>Distinct principals</span><strong>{overview.principalCount}</strong></div>
                <div><span>High privilege</span><strong>{overview.riskyBindingCount}</strong></div>
                <div><span>Public exposure</span><strong>{overview.publicPrincipalCount}</strong></div>
              </div>
              <div className="overview-note-list">
                {overview.notes.map(note => (
                  <div key={note} className="overview-note-item">{note}</div>
                ))}
              </div>
              <div className="catalog-toolbar" style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(inspectPolicyCommand)}
                  title={canRunTerminalCommand ? inspectPolicyCommand : 'Switch to Operator mode'}
                >Policy in terminal</button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(listSACommand)}
                  title={canRunTerminalCommand ? listSACommand : 'Switch to Operator mode'}
                >Service accounts in terminal</button>
              </div>
            </article>

            <article className="overview-account-card">
              <div className="panel-header minor">
                <h3>Service Accounts</h3>
                <span className="hero-path" style={{ margin: 0 }}>{overview.serviceAccounts.length} visible</span>
              </div>
              {overview.serviceAccounts.length > 0 ? (
                <div className="overview-linked-account-list">
                  {overview.serviceAccounts.slice(0, 8).map(account => (
                    <div key={account.email} className="overview-linked-account-row">
                      <div>
                        <strong>{account.displayName || account.email}</strong>
                        <span>{account.email}</span>
                      </div>
                      <strong>{account.disabled ? 'Disabled' : 'Active'}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <SvcState variant="empty" message="No project service accounts were surfaced." compact />
              )}
            </article>
          </section>

          <div className="overview-section-title">Capability Hints</div>
          <section className="overview-hint-grid">
            {overview.capabilityHints.length === 0 && (
              <article className="overview-hint-card info">
                <span className="overview-hint-kicker">Posture</span>
                <strong>No capability hints surfaced</strong>
                <p>No privilege, exposure, or sprawl signals were detected for this project.</p>
              </article>
            )}
            {overview.capabilityHints.map(hint => (
              <article key={hint.id} className={'overview-hint-card ' + hint.severity}>
                <span className="overview-hint-kicker">{hint.subject}</span>
                <strong>{hint.title}</strong>
                <p>{hint.summary}</p>
                <small>{hint.recommendedAction}</small>
              </article>
            ))}
          </section>

          <div className="overview-section-title">Risky And Broad Bindings</div>
          <section className="overview-ownership-grid">
            {overview.bindings.filter(b => b.risky || b.publicAccess).slice(0, 8).map(binding => (
              <article key={binding.role + ':' + binding.members.join(',')} className="overview-ownership-card">
                <div className="overview-ownership-header">
                  <div>
                    <span>{binding.publicAccess ? 'Public or shared' : 'High privilege'}</span>
                    <strong>{binding.role}</strong>
                  </div>
                  <div className="overview-ownership-metrics">
                    <span>{binding.memberCount} members</span>
                    {binding.conditionTitle ? <span>{binding.conditionTitle}</span> : null}
                  </div>
                </div>
                <div className="overview-note-list" style={{ marginTop: 0 }}>
                  {binding.members.slice(0, 4).map(m => (
                    <div key={binding.role + ':' + m} className="overview-note-item">{summarizeGcpMember(m)}</div>
                  ))}
                </div>
              </article>
            ))}
            {overview.bindings.filter(b => b.risky || b.publicAccess).length === 0 && (
              <article className="overview-ownership-card">
                <p className="hero-path" style={{ margin: 0 }}>No risky or public project-level bindings were surfaced.</p>
              </article>
            )}
          </section>

          <div className="overview-section-title">Principal Rollup</div>
          <section className="overview-ownership-grid">
            {overview.principals.slice(0, 8).map(principal => (
              <article key={principal.principal} className="overview-ownership-card">
                <div className="overview-ownership-header">
                  <div>
                    <span>Principal</span>
                    <strong>{summarizeGcpMember(principal.principal)}</strong>
                  </div>
                  <div className="overview-ownership-metrics">
                    <span>{principal.bindingCount} bindings</span>
                    <span>{principal.highPrivilegeRoleCount} high privilege</span>
                  </div>
                </div>
                <div className="overview-note-list" style={{ marginTop: 0 }}>
                  {principal.sampleRoles.map(role => (
                    <div key={principal.principal + ':' + role} className="overview-note-item">{role}</div>
                  ))}
                </div>
              </article>
            ))}
          </section>
        </>
      ) : null}
    </>
  )
}


/* MAIN COMPONENT */

export function GcpIamConsole({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const [mainTab, setMainTab] = useState<MainTab>('bindings')
  const [tabsOpen, setTabsOpen] = useState(true)

  /* Overview data shared across bindings/SA/overview tabs */
  const [overview, setOverview] = useState<GcpIamOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState('')

  /* Track which tabs have been loaded */
  const [tabLoading, setTabLoading] = useState<MainTab | null>('bindings')

  /* Load overview on mount and when refreshNonce changes */
  useEffect(() => {
    let cancelled = false
    setOverviewLoading(true)
    setOverviewError('')

    getGcpIamOverview(projectId)
      .then(data => { if (!cancelled) { setOverview(data) } })
      .catch(e => { if (!cancelled) { setOverviewError(e instanceof Error ? e.message : String(e)); setOverview(null) } })
      .finally(() => { if (!cancelled) { setOverviewLoading(false); setTabLoading(null) } })

    return () => { cancelled = true }
  }, [projectId, refreshNonce])

  function handleRefreshOverview() {
    setTabLoading(mainTab)
    setOverviewLoading(true)
    setOverviewError('')

    getGcpIamOverview(projectId)
      .then(data => { setOverview(data) })
      .catch(e => { setOverviewError(e instanceof Error ? e.message : String(e)); setOverview(null) })
      .finally(() => { setOverviewLoading(false); setTabLoading(null) })
  }

  function switchTab(tab: MainTab) {
    setMainTab(tab)
    if (tab === 'bindings' || tab === 'service-accounts' || tab === 'overview') {
      if (!overview && !overviewLoading) handleRefreshOverview()
    }
  }

  const locationLabel = location.trim() || 'global'
  const inventoryCount =
    mainTab === 'bindings' ? (overview?.bindings.length ?? 0) :
    mainTab === 'service-accounts' ? (overview?.serviceAccounts.length ?? 0) :
    mainTab === 'overview' ? (overview?.capabilityHints.length ?? 0) : 0

  return (
    <div className="overview-surface gcp-iam-console gcp-iam-console-surface">
      {/* Hero */}
      <div className="gcp-iam-hero">
        <div className="gcp-iam-hero-copy">
          <div className="eyebrow">GCP IAM Console</div>
          <h2>{projectId}</h2>
          <p>Manage project-level IAM bindings, service accounts, and custom roles. Inspect posture via the Overview tab and test permissions with the Simulator.</p>
          <div className="gcp-iam-meta-strip">
            <div className="gcp-iam-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="gcp-iam-meta-pill">
              <span>Lens</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="gcp-iam-meta-pill">
              <span>Bindings</span>
              <strong>{overview?.bindingCount ?? '—'}</strong>
            </div>
            <div className="gcp-iam-meta-pill">
              <span>Principals</span>
              <strong>{overview?.principalCount ?? '—'}</strong>
            </div>
          </div>
        </div>
        <div className="gcp-iam-hero-stats">
          <div className="gcp-iam-glance-card gcp-iam-glance-card-accent">
            <span>Active surface</span>
            <strong>{MAIN_TABS.find(t => t.id === mainTab)?.label ?? 'IAM'}</strong>
            <small>{tabLoading === mainTab ? 'Refreshing live data now' : 'Workspace ready for review'}</small>
          </div>
          <div className="gcp-iam-glance-card">
            <span>Risky bindings</span>
            <strong>{overview?.riskyBindingCount ?? '—'}</strong>
            <small>Owner, editor, or admin-level grants in project policy</small>
          </div>
          <div className="gcp-iam-glance-card">
            <span>Public principals</span>
            <strong>{overview?.publicPrincipalCount ?? '—'}</strong>
            <small>allUsers and allAuthenticatedUsers grants in scope</small>
          </div>
          <div className="gcp-iam-glance-card">
            <span>Service accounts</span>
            <strong>{overview?.serviceAccounts.length ?? '—'}</strong>
            <small>Workload identities surfaced for this project</small>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="gcp-iam-tabs">
        <button className="svc-tab-hamburger" type="button" onClick={() => setTabsOpen(p => !p)}>
          <span className={'hamburger-icon ' + (tabsOpen ? 'open' : '')}>
            <span /><span /><span />
          </span>
        </button>
        {tabsOpen && MAIN_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={'gcp-iam-tab ' + (mainTab === t.id ? 'active' : '')}
            onClick={() => switchTab(t.id)}
          >{t.label}</button>
        ))}
        {tabsOpen && (
          <button
            className="gcp-iam-refresh-btn"
            type="button"
            onClick={handleRefreshOverview}
          >
            Refresh
          </button>
        )}
      </div>

      {/* Tab content */}
      {mainTab === 'bindings' && (
        <BindingsTab
          projectId={projectId}
          bindings={overview?.bindings ?? []}
          loading={overviewLoading}
          onRefresh={handleRefreshOverview}
        />
      )}

      {mainTab === 'service-accounts' && (
        <ServiceAccountsTab
          projectId={projectId}
          serviceAccounts={overview?.serviceAccounts ?? []}
          loading={overviewLoading}
          onRefresh={handleRefreshOverview}
        />
      )}

      {mainTab === 'roles' && (
        <RolesTab projectId={projectId} />
      )}

      {mainTab === 'overview' && (
        <OverviewTab
          projectId={projectId}
          location={location}
          overview={overview}
          loading={overviewLoading}
          error={overviewError}
          onRunTerminalCommand={onRunTerminalCommand}
          canRunTerminalCommand={canRunTerminalCommand}
        />
      )}

      {mainTab === 'simulator' && (
        <SimulatorTab projectId={projectId} />
      )}
    </div>
  )
}
