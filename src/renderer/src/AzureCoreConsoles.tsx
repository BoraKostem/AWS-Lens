import { useEffect, useMemo, useState } from 'react'
import './ec2.css'
import './eks.css'

import type {
  AzureAksClusterDetail,
  AzureAksClusterSummary,
  AzureAksNodePoolSummary,
  AzureManagedDiskSummary,
  AzureDiskSnapshotSummary,
  AzureMonitorActivityEvent,
  AzureRbacOverview,
  AzureRoleAssignmentSummary,
  AzureRoleDefinitionSummary,
  AzureSubscriptionSummary,
  AzureVirtualMachineDetail,
  AzureVirtualMachineSummary,
  AzureVmAction
} from '@shared/types'
import {
  createAzureRoleAssignment,
  deleteAzureRoleAssignment,
  describeAzureAksCluster,
  describeAzureVirtualMachine,
  getAzureRbacOverview,
  listAzureAksClusters,
  listAzureAksNodePools,
  listAzureManagedDisks,
  listAzureDiskSnapshots,
  listAzureRoleAssignments,
  listAzureRoleDefinitions,
  listAzureSubscriptions,
  listAzureMonitorActivity,
  listAzureVirtualMachines,
  runAzureVmAction,
  addAksToKubeconfig,
  chooseAksKubeconfigPath,
  updateAzureAksNodePoolScaling,
  toggleAzureAksNodePoolAutoscaling
} from './api'
import { ConfirmButton } from './ConfirmButton'
import { SvcState } from './SvcState'

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sortByName<T extends { name?: string; displayName?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => (left.name || left.displayName || '').localeCompare(right.name || right.displayName || ''))
}

function renderTableHeader(columns: string[], gridTemplateColumns: string): JSX.Element {
  return (
    <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns, gap: '1rem' }}>
      {columns.map((column) => <div key={column}>{column}</div>)}
    </div>
  )
}

function formatLocationHint(location: string): string {
  return location.trim() || 'all visible locations'
}

export function AzureSubscriptionsConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenCost,
  onOpenMonitor,
  onOpenService
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenCost: () => void
  onOpenMonitor: () => void
  onOpenService: (serviceId: 'azure-rbac' | 'azure-virtual-machines' | 'azure-aks' | 'azure-storage-accounts' | 'azure-sql' | 'azure-network' | 'azure-vmss' | 'azure-resource-groups') => void
}): JSX.Element {
  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [inspectedId, setInspectedId] = useState('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError('')
      try {
        const next = await listAzureSubscriptions()
        if (!cancelled) {
          setSubscriptions(sortByName(next))
        }
      } catch (err) {
        if (!cancelled) {
          setError(normalizeError(err))
          setSubscriptions([])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => { cancelled = true }
  }, [refreshNonce])

  const selected = subscriptions.find((entry) => entry.subscriptionId === subscriptionId) ?? null
  const inspected = useMemo(
    () => subscriptions.find((entry) => entry.subscriptionId === inspectedId) ?? selected,
    [subscriptions, inspectedId, selected]
  )
  const enabledCount = subscriptions.filter((entry) => entry.state.toLowerCase() === 'enabled').length
  const disabledCount = subscriptions.length - enabledCount
  const uniqueTenants = useMemo(
    () => new Set(subscriptions.map((entry) => entry.tenantId)).size,
    [subscriptions]
  )
  const totalLocations = useMemo(
    () => subscriptions.reduce((total, entry) => total + (entry.locationCount ?? 0), 0),
    [subscriptions]
  )

  const filteredSubscriptions = useMemo(() => {
    if (!searchQuery.trim()) return subscriptions
    const query = searchQuery.trim().toLowerCase()
    return subscriptions.filter((entry) =>
      entry.displayName.toLowerCase().includes(query)
      || entry.subscriptionId.toLowerCase().includes(query)
      || entry.tenantId.toLowerCase().includes(query)
      || entry.state.toLowerCase().includes(query)
    )
  }, [subscriptions, searchQuery])

  const [mainTab, setMainTab] = useState<'inventory' | 'details' | 'actions'>('inventory')

  return (
    <div className="svc-console iam-console azure-rbac-theme">
      {/* ── Hero ────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Azure Subscriptions</div>
          <h2>Subscription control plane</h2>
          <p>Tenant-linked subscription inventory with state visibility, location coverage, and cross-service navigation for the active Azure shell.</p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill">
              <span>Provider</span>
              <strong>Azure</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Subscription</span>
              <strong>{subscriptionId || 'Not selected'}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Location</span>
              <strong>{formatLocationHint(location)}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Visible</span>
            <strong>{subscriptions.length}</strong>
            <small>{loading ? 'Refreshing live data now' : 'Subscriptions in current scope'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Enabled</span>
            <strong>{enabledCount}</strong>
            <small>Active subscriptions ready for use</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Tenants</span>
            <strong>{uniqueTenants}</strong>
            <small>Unique tenant{uniqueTenants !== 1 ? 's' : ''} linked to subscriptions</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Regions</span>
            <strong>{totalLocations}</strong>
            <small>Total locations across all subscriptions</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ─────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <div className="iam-tab-bar">
          <button type="button" className={`svc-tab ${mainTab === 'inventory' ? 'active' : ''}`} onClick={() => setMainTab('inventory')}>Inventory</button>
          <button type="button" className={`svc-tab ${mainTab === 'details' ? 'active' : ''}`} onClick={() => setMainTab('details')}>Details</button>
          <button type="button" className={`svc-tab ${mainTab === 'actions' ? 'active' : ''}`} onClick={() => setMainTab('actions')}>Actions</button>
        </div>
      </div>

      {/* ── Loading / error / empty states ──────────── */}
      {loading ? <SvcState variant="loading" resourceName="Azure subscriptions" compact /> : null}
      {!loading && error ? <SvcState variant="error" error={error} /> : null}
      {!loading && !error && subscriptions.length === 0 ? (
        <SvcState variant="empty" message="No Azure subscriptions were visible to the current credential chain." />
      ) : null}

      {/* ── Inventory tab ──────────────────────────── */}
      {!loading && !error && subscriptions.length > 0 && mainTab === 'inventory' ? (
        <section className="workspace-grid">
          <div className="column stack">
            <div className="panel overview-data-panel">
              <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>Subscription Inventory</h3>
                <input
                  type="text"
                  className="cw-query-filter"
                  placeholder="Filter by name, ID, tenant, or state…"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  style={{ maxWidth: 260, fontSize: '0.78rem', padding: '0.35rem 0.6rem', borderRadius: 8, border: '1px solid rgba(145,176,207,0.18)', background: 'rgba(0,0,0,0.15)', color: 'inherit' }}
                />
              </div>
              <div className="table-grid overview-table-grid">
                {renderTableHeader(['Subscription', 'State', 'Tenant', 'Locations'], '1.4fr 0.6fr 1fr 0.6fr')}
                {filteredSubscriptions.map((entry) => (
                  <button
                    key={entry.subscriptionId}
                    type="button"
                    className={`table-row overview-table-row ${inspected?.subscriptionId === entry.subscriptionId ? 'active' : ''}`}
                    style={{ display: 'grid', gridTemplateColumns: '1.4fr 0.6fr 1fr 0.6fr', gap: '1rem', textAlign: 'left' }}
                    onClick={() => { setInspectedId(entry.subscriptionId); setMainTab('details') }}
                  >
                    <div>
                      <strong>{entry.displayName}</strong>
                      <div className="hero-path">{entry.subscriptionId}</div>
                    </div>
                    <div>
                      <span className={`status-badge ${entry.state.toLowerCase() === 'enabled' ? 'status-ok' : 'status-warn'}`}>
                        {entry.state || '-'}
                      </span>
                    </div>
                    <div className="hero-path">{entry.tenantId || '-'}</div>
                    <div>{entry.locationCount ?? 0}</div>
                  </button>
                ))}
                {filteredSubscriptions.length === 0 && searchQuery.trim() ? (
                  <div className="table-row overview-table-row" style={{ textAlign: 'center', opacity: 0.6 }}>
                    No subscriptions match &ldquo;{searchQuery.trim()}&rdquo;
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="column stack">
            <div className="panel overview-insights-panel">
              <div className="panel-header"><h3>Scope Summary</h3></div>
              <div className="overview-note-list">
                <div className="overview-note-item">{enabledCount} of {subscriptions.length} subscriptions are enabled and active.</div>
                {disabledCount > 0 ? (
                  <div className="overview-note-item">{disabledCount} subscription{disabledCount !== 1 ? 's' : ''} disabled — review state for billing or policy issues.</div>
                ) : null}
                <div className="overview-note-item">{uniqueTenants} unique tenant{uniqueTenants !== 1 ? 's' : ''} linked across all visible subscriptions.</div>
                <div className="overview-note-item">Selected context: {selected?.displayName || 'No active subscription in connection selector.'}</div>
              </div>
            </div>

            <div className="panel overview-insights-panel">
              <div className="panel-header"><h3>Cross-links</h3></div>
              <div className="gcp-overview-actions">
                <button type="button" className="ghost" onClick={() => onOpenService('azure-resource-groups')}>Resource groups</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-rbac')}>RBAC posture</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-virtual-machines')}>Virtual machines</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-aks')}>AKS clusters</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-storage-accounts')}>Storage accounts</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-sql')}>Azure SQL</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-network')}>Network</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-vmss')}>VM Scale Sets</button>
                <button type="button" className="ghost" onClick={onOpenCost}>Cost posture</button>
                <button type="button" className="ghost" onClick={onOpenMonitor}>Monitor</button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Details tab ────────────────────────────── */}
      {!loading && !error && subscriptions.length > 0 && mainTab === 'details' ? (
        <section className="workspace-grid">
          <div className="column stack">
            <div className="panel overview-data-panel">
              <div className="panel-header"><h3>Subscription List</h3></div>
              <div className="table-grid overview-table-grid">
                {renderTableHeader(['Subscription', 'State'], '1fr 0.5fr')}
                {subscriptions.map((entry) => (
                  <button
                    key={entry.subscriptionId}
                    type="button"
                    className={`table-row overview-table-row ${inspected?.subscriptionId === entry.subscriptionId ? 'active' : ''}`}
                    style={{ display: 'grid', gridTemplateColumns: '1fr 0.5fr', gap: '1rem', textAlign: 'left' }}
                    onClick={() => setInspectedId(entry.subscriptionId)}
                  >
                    <div>
                      <strong>{entry.displayName}</strong>
                      <div className="hero-path">{entry.subscriptionId}</div>
                    </div>
                    <div>
                      <span className={`status-badge ${entry.state.toLowerCase() === 'enabled' ? 'status-ok' : 'status-warn'}`}>
                        {entry.state || '-'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="column stack">
            <div className="panel overview-insights-panel">
              <div className="panel-header"><h3>Subscription Details</h3></div>
              {!inspected ? (
                <SvcState variant="no-selection" resourceName="subscription" message="Select a subscription row to inspect its details and posture." />
              ) : (
                <div className="overview-note-list">
                  <div className="overview-note-item"><span className="note-label">Name</span><strong>{inspected.displayName}</strong></div>
                  <div className="overview-note-item"><span className="note-label">Subscription ID</span><span className="hero-path">{inspected.subscriptionId}</span></div>
                  <div className="overview-note-item"><span className="note-label">Tenant ID</span><span className="hero-path">{inspected.tenantId}</span></div>
                  <div className="overview-note-item">
                    <span className="note-label">State</span>
                    <span className={`status-badge ${inspected.state.toLowerCase() === 'enabled' ? 'status-ok' : 'status-warn'}`}>{inspected.state}</span>
                  </div>
                  <div className="overview-note-item"><span className="note-label">Authorization</span>{inspected.authorizationSource || 'Not reported'}</div>
                  <div className="overview-note-item"><span className="note-label">Spending limit</span>{inspected.spendingLimit || 'Not applied'}</div>
                  <div className="overview-note-item"><span className="note-label">Quota</span>{inspected.quotaId || 'Unknown'}</div>
                  <div className="overview-note-item"><span className="note-label">Locations</span>{inspected.locationCount ?? 0} region{(inspected.locationCount ?? 0) !== 1 ? 's' : ''} visible</div>
                  {inspected.managedByTenants && inspected.managedByTenants.length > 0 ? (
                    <div className="overview-note-item"><span className="note-label">Managed by</span>{inspected.managedByTenants.join(', ')}</div>
                  ) : null}
                  {inspected.managementGroupHints && inspected.managementGroupHints.length > 0 ? (
                    <div className="overview-note-item"><span className="note-label">Mgmt groups</span>{inspected.managementGroupHints.join(', ')}</div>
                  ) : null}
                  {inspected.subscriptionId === subscriptionId ? (
                    <div className="overview-note-item" style={{ opacity: 0.7, fontStyle: 'italic' }}>This is the currently active subscription in your connection context.</div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Actions tab ────────────────────────────── */}
      {!loading && !error && subscriptions.length > 0 && mainTab === 'actions' ? (
        <section className="workspace-grid">
          <div className="column stack">
            <div className="panel overview-insights-panel">
              <div className="panel-header"><h3>Terminal Handoff</h3></div>
              <p style={{ color: '#a6bbcf', fontSize: '0.8rem', margin: '0 0 0.5rem', lineHeight: 1.4 }}>
                Run Azure CLI commands against {inspected?.displayName || 'the selected subscription'}. Select a subscription from the Inventory or Details tab to target it.
              </p>
              <div className="gcp-overview-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand || !inspected}
                  onClick={() => inspected && onRunTerminalCommand(`az account show --subscription "${inspected.subscriptionId}" --output jsonc`)}
                >
                  Account snapshot
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand || !inspected}
                  onClick={() => inspected && onRunTerminalCommand(`az account list-locations --subscription "${inspected.subscriptionId}" --output table`)}
                >
                  List locations
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand || !inspected}
                  onClick={() => inspected && onRunTerminalCommand(`az group list --subscription "${inspected.subscriptionId}" --output table`)}
                >
                  Resource groups
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand || !inspected}
                  onClick={() => inspected && onRunTerminalCommand(`az provider list --subscription "${inspected.subscriptionId}" --query "[?registrationState=='Registered'].{Namespace:namespace, State:registrationState}" --output table`)}
                >
                  Providers
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand || !inspected}
                  onClick={() => inspected && onRunTerminalCommand(`az tag list --subscription "${inspected.subscriptionId}" --output table`)}
                >
                  Tags
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canRunTerminalCommand || !inspected}
                  onClick={() => inspected && onRunTerminalCommand(`az resource list --subscription "${inspected.subscriptionId}" --query "[].{Name:name, Type:type, RG:resourceGroup, Location:location}" --output table`)}
                >
                  All resources
                </button>
              </div>
            </div>
          </div>

          <div className="column stack">
            <div className="panel overview-insights-panel">
              <div className="panel-header"><h3>Cross-links</h3></div>
              <div className="gcp-overview-actions">
                <button type="button" className="ghost" onClick={() => onOpenService('azure-resource-groups')}>Resource groups</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-rbac')}>RBAC posture</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-virtual-machines')}>Virtual machines</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-aks')}>AKS clusters</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-storage-accounts')}>Storage accounts</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-sql')}>Azure SQL</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-network')}>Network</button>
                <button type="button" className="ghost" onClick={() => onOpenService('azure-vmss')}>VM Scale Sets</button>
                <button type="button" className="ghost" onClick={onOpenCost}>Cost posture</button>
                <button type="button" className="ghost" onClick={onOpenMonitor}>Monitor</button>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}

/* ── Azure RBAC types & constants ─────────────────────────── */

type RbacTab = 'assignments' | 'roles' | 'overview'
type RbacColDef<T> = { key: string; label: string; color: string; getValue: (item: T) => string }

const RBAC_TABS: Array<{ id: RbacTab; label: string }> = [
  { id: 'assignments', label: 'Assignments' },
  { id: 'roles', label: 'Roles' },
  { id: 'overview', label: 'Overview' }
]

const ASSIGNMENT_COLS: RbacColDef<AzureRoleAssignmentSummary>[] = [
  { key: 'roleName', label: 'Role', color: '#3b82f6', getValue: a => a.roleName },
  { key: 'principalId', label: 'Principal', color: '#14b8a6', getValue: a => a.principalId },
  { key: 'principalType', label: 'Type', color: '#8b5cf6', getValue: a => a.principalType },
  { key: 'scopeKind', label: 'Scope', color: '#22c55e', getValue: a => `${a.scopeKind}${a.inherited ? ' (inherited)' : ''}` },
  { key: 'risky', label: 'Risk', color: '#f59e0b', getValue: a => a.risky ? 'High' : 'Standard' }
]

const ROLE_DEF_COLS: RbacColDef<AzureRoleDefinitionSummary>[] = [
  { key: 'roleName', label: 'Role Name', color: '#3b82f6', getValue: r => r.roleName },
  { key: 'roleType', label: 'Type', color: '#14b8a6', getValue: r => r.roleType === 'CustomRole' ? 'Custom' : 'Built-in' },
  { key: 'description', label: 'Description', color: '#22c55e', getValue: r => r.description || '-' }
]

function confirmRbacDelete(actionLabel: string, targetLabel: string): boolean {
  const firstPrompt = `Delete ${actionLabel} ${targetLabel}?`
  const secondPrompt = `Confirm deletion of ${actionLabel} ${targetLabel}. This action may be irreversible.`
  return window.confirm(firstPrompt) && window.confirm(secondPrompt)
}

export function AzureRbacConsole({
  subscriptionId,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenCompliance,
  onOpenMonitor
}: {
  subscriptionId: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenCompliance: () => void
  onOpenMonitor: () => void
}): JSX.Element {
  /* ── Tab state ──────────────────────────────────────────── */
  const [mainTab, setMainTab] = useState<RbacTab>('assignments')
  const [mainTabLoading, setMainTabLoading] = useState<RbacTab | null>('assignments')
  const [tabsOpen, setTabsOpen] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  /* ── Assignments state ──────────────────────────────────── */
  const [assignments, setAssignments] = useState<AzureRoleAssignmentSummary[]>([])
  const [selectedAssignment, setSelectedAssignment] = useState<AzureRoleAssignmentSummary | null>(null)
  const [assignmentFilter, setAssignmentFilter] = useState('')
  const [assignmentVisibleCols, setAssignmentVisibleCols] = useState(() => new Set(ASSIGNMENT_COLS.map(c => c.key)))

  /* ── Create assignment form ─────────────────────────────── */
  const [newPrincipalId, setNewPrincipalId] = useState('')
  const [newRoleDefId, setNewRoleDefId] = useState('')
  const [newScope, setNewScope] = useState('')

  /* ── Roles state ────────────────────────────────────────── */
  const [roleDefinitions, setRoleDefinitions] = useState<AzureRoleDefinitionSummary[]>([])
  const [selectedRole, setSelectedRole] = useState<AzureRoleDefinitionSummary | null>(null)
  const [roleFilter, setRoleFilter] = useState('')
  const [roleVisibleCols, setRoleVisibleCols] = useState(() => new Set(ROLE_DEF_COLS.map(c => c.key)))
  const [roleTypeFilter, setRoleTypeFilter] = useState<'All' | 'BuiltIn' | 'Custom'>('All')

  /* ── Overview state ─────────────────────────────────────── */
  const [overview, setOverview] = useState<AzureRbacOverview | null>(null)

  /* ── Sidebar sections ───────────────────────────────────── */
  const [expandedSections, setExpandedSections] = useState(() => new Set(['details', 'scope', 'permissions', 'rbacActions', 'dataActions', 'assignableScopes']))

  /* ── Effects ────────────────────────────────────────────── */

  useEffect(() => {
    void loadTab('assignments')
  }, [refreshNonce, subscriptionId])

  function switchTab(tab: RbacTab) {
    setMainTab(tab)
    setSelectedAssignment(null)
    setSelectedRole(null)
    setError('')
    setSuccess('')
    void loadTab(tab)
  }

  async function loadTab(tab: RbacTab) {
    setMainTabLoading(tab)
    try {
      if (tab === 'assignments') {
        setAssignments(await listAzureRoleAssignments(subscriptionId))
      } else if (tab === 'roles') {
        setRoleDefinitions(await listAzureRoleDefinitions(subscriptionId))
      } else if (tab === 'overview') {
        setOverview(await getAzureRbacOverview(subscriptionId))
      }
    } catch (e) {
      setError(normalizeError(e))
    } finally {
      setMainTabLoading(current => current === tab ? null : current)
    }
  }

  /* ── Assignment actions ─────────────────────────────────── */

  async function handleCreateAssignment() {
    if (!newPrincipalId.trim() || !newRoleDefId.trim()) return
    setError('')
    setSuccess('')
    try {
      const scope = newScope.trim() || `/subscriptions/${subscriptionId}`
      await createAzureRoleAssignment(subscriptionId, newPrincipalId.trim(), newRoleDefId.trim(), scope)
      setNewPrincipalId('')
      setNewRoleDefId('')
      setNewScope('')
      setSuccess('Role assignment created successfully.')
      setAssignments(await listAzureRoleAssignments(subscriptionId))
    } catch (e) {
      setError(normalizeError(e))
    }
  }

  async function handleDeleteAssignment(assignment: AzureRoleAssignmentSummary) {
    if (!confirmRbacDelete('role assignment', `${assignment.roleName} for ${assignment.principalId}`)) return
    setError('')
    setSuccess('')
    try {
      await deleteAzureRoleAssignment(assignment.id)
      if (selectedAssignment?.id === assignment.id) setSelectedAssignment(null)
      setSuccess(`Deleted role assignment ${assignment.roleName} for ${assignment.principalId}.`)
      setAssignments(await listAzureRoleAssignments(subscriptionId))
    } catch (e) {
      setError(normalizeError(e))
    }
  }

  /* ── Helpers ────────────────────────────────────────────── */

  function rbacToggleSection(id: string) {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function rbacToggleCol(setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) {
    setter(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function rbacFilterItems<T>(items: T[], filter: string, cols: RbacColDef<T>[], visible: Set<string>): T[] {
    if (!filter) return items
    const s = filter.toLowerCase()
    const active = cols.filter(c => visible.has(c.key))
    return items.filter(item => active.some(c => c.getValue(item).toLowerCase().includes(s)))
  }

  const filteredAssignments = rbacFilterItems(assignments, assignmentFilter, ASSIGNMENT_COLS, assignmentVisibleCols)
  const activeAssignmentCols = ASSIGNMENT_COLS.filter(c => assignmentVisibleCols.has(c.key))

  const visibleRoles = roleTypeFilter === 'All'
    ? roleDefinitions
    : roleTypeFilter === 'Custom'
      ? roleDefinitions.filter(r => r.roleType === 'CustomRole')
      : roleDefinitions.filter(r => r.roleType === 'BuiltInRole')
  const filteredRoles = rbacFilterItems(visibleRoles, roleFilter, ROLE_DEF_COLS, roleVisibleCols)
  const activeRoleCols = ROLE_DEF_COLS.filter(c => roleVisibleCols.has(c.key))

  const inventoryCount = mainTab === 'assignments'
    ? assignments.length
    : mainTab === 'roles'
      ? roleDefinitions.length
      : overview?.assignmentCount ?? 0
  const selectedSummary = mainTab === 'assignments'
    ? selectedAssignment ? `${selectedAssignment.roleName} → ${selectedAssignment.principalType}` : undefined
    : mainTab === 'roles'
      ? selectedRole?.roleName
      : undefined
  const riskyCount = mainTab === 'assignments'
    ? assignments.filter(a => a.risky).length
    : overview?.riskyAssignmentCount ?? 0

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="svc-console iam-console azure-rbac-theme">
      {/* ── Hero ────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Azure RBAC Posture</div>
          <h2>RBAC control plane</h2>
          <p>Subscription-scope role assignment visibility with inherited scope surfacing, risky-role prioritization, and role definition inspection.</p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill">
              <span>Provider</span>
              <strong>Azure</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Subscription</span>
              <strong>{subscriptionId}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Selection</span>
              <strong>{selectedSummary || 'No selection'}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Active surface</span>
            <strong>{RBAC_TABS.find(t => t.id === mainTab)?.label ?? 'RBAC'}</strong>
            <small>{mainTabLoading === mainTab ? 'Refreshing live data now' : 'Current workspace is ready for review'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Inventory</span>
            <strong>{inventoryCount}</strong>
            <small>Objects loaded in the current tab</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Risky roles</span>
            <strong>{riskyCount}</strong>
            <small>High-privilege assignments in scope</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Principals</span>
            <strong>{new Set(assignments.map(a => a.principalId)).size}</strong>
            <small>Unique principals across assignments</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ─────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <button className="svc-tab-hamburger" type="button" onClick={() => setTabsOpen(p => !p)}>
          <span className={`hamburger-icon ${tabsOpen ? 'open' : ''}`}>
            <span /><span /><span />
          </span>
        </button>
        <div className="iam-tab-bar">
          {tabsOpen && RBAC_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              className={`svc-tab ${mainTab === t.id ? 'active' : ''}`}
              onClick={() => switchTab(t.id)}
            >{t.label}</button>
          ))}
        </div>
        {tabsOpen && <button className="iam-refresh-btn" type="button" onClick={() => void loadTab(mainTab)}>Refresh</button>}
      </div>

      {error && <div className="svc-error">{error}</div>}
      {success && <div className="svc-msg">{success}</div>}

      {/* ══════════════════ ASSIGNMENTS ══════════════════ */}
      {mainTab === 'assignments' && (
        <>
          <div className="iam-surface">
            <div className="iam-filter-shell">
              <div>
                <span className="iam-pane-kicker">Assignments</span>
                <h3>Role assignment inventory</h3>
              </div>
              <input
                className="svc-search iam-search"
                placeholder="Filter rows across selected columns..."
                value={assignmentFilter}
                onChange={e => setAssignmentFilter(e.target.value)}
              />
            </div>
            <div className="svc-chips iam-chip-row">
              {ASSIGNMENT_COLS.map(c => (
                <button
                  key={c.key}
                  type="button"
                  className={`svc-chip ${assignmentVisibleCols.has(c.key) ? 'active' : ''}`}
                  style={assignmentVisibleCols.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
                  onClick={() => rbacToggleCol(setAssignmentVisibleCols, c.key)}
                >{c.label}</button>
              ))}
            </div>
          </div>

          <div className="iam-layout">
            {/* ── Left: Assignments table ──────────────── */}
            <div className="iam-table-area">
              <table className="svc-table">
                <thead>
                  <tr>{activeAssignmentCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {mainTabLoading === 'assignments' && (
                    <tr><td colSpan={activeAssignmentCols.length}>Gathering data</td></tr>
                  )}
                  {mainTabLoading !== 'assignments' && filteredAssignments.map(a => (
                    <tr
                      key={a.id}
                      className={selectedAssignment?.id === a.id ? 'active' : ''}
                      onClick={() => setSelectedAssignment(a)}
                    >
                      {activeAssignmentCols.map(c => (
                        <td key={c.key}>
                          {c.key === 'risky'
                            ? <span className={a.risky ? 'svc-badge danger' : 'svc-badge muted'}>{c.getValue(a)}</span>
                            : c.getValue(a)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredAssignments.length && mainTabLoading !== 'assignments' && <div className="svc-empty">No role assignments found.</div>}

              <div className="iam-bottom-actions">
                <input placeholder="Principal ID" value={newPrincipalId} onChange={e => setNewPrincipalId(e.target.value)} />
                <input placeholder="Role Definition ID" value={newRoleDefId} onChange={e => setNewRoleDefId(e.target.value)} />
                <button className="svc-btn success" type="button" onClick={() => void handleCreateAssignment()}>Create Assignment</button>
                <button
                  className="svc-btn danger"
                  type="button"
                  disabled={!selectedAssignment}
                  onClick={() => selectedAssignment && void handleDeleteAssignment(selectedAssignment)}
                >Delete Assignment</button>
              </div>
            </div>

            {/* ── Right: Sidebar ──────────────────────── */}
            <div className="iam-sidebar">
              {!selectedAssignment && <div className="iam-sidebar-placeholder">Select an assignment to view details</div>}

              {selectedAssignment && (
                <>
                  {/* ── Details ─────────────────────── */}
                  <div className="iam-section-header" onClick={() => rbacToggleSection('details')}>
                    {expandedSections.has('details') ? '−' : '+'} Assignment Details
                  </div>
                  {expandedSections.has('details') && (
                    <div className="iam-section-content">
                      <div className="iam-metadata-grid">
                        <div>
                          <span>Role</span>
                          <strong>{selectedAssignment.roleName}</strong>
                        </div>
                        <div>
                          <span>Principal ID</span>
                          <strong style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>{selectedAssignment.principalId}</strong>
                        </div>
                        <div>
                          <span>Principal Type</span>
                          <strong>{selectedAssignment.principalType}</strong>
                        </div>
                        <div>
                          <span>Risk Level</span>
                          <strong><span className={selectedAssignment.risky ? 'svc-badge danger' : 'svc-badge ok'}>{selectedAssignment.risky ? 'High Privilege' : 'Standard'}</span></strong>
                        </div>
                        <div>
                          <span>Inherited</span>
                          <strong>{selectedAssignment.inherited ? 'Yes' : 'No'}</strong>
                        </div>
                        <div>
                          <span>Scope Kind</span>
                          <strong>{selectedAssignment.scopeKind}</strong>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Scope ──────────────────────── */}
                  <div className="iam-section-header" onClick={() => rbacToggleSection('scope')}>
                    {expandedSections.has('scope') ? '−' : '+'} Scope
                  </div>
                  {expandedSections.has('scope') && (
                    <div className="iam-section-content">
                      <div className="iam-output-panel">
                        <pre style={{ margin: 0 }}>{selectedAssignment.scope}</pre>
                      </div>
                      {selectedAssignment.condition && (
                        <>
                          <span style={{ color: '#8fa3ba', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 8, display: 'block' }}>Condition</span>
                          <div className="iam-output-panel">
                            <pre style={{ margin: 0 }}>{selectedAssignment.condition}</pre>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ── Actions ────────────────────── */}
                  <div className="iam-section-header" onClick={() => rbacToggleSection('rbacActions')}>
                    {expandedSections.has('rbacActions') ? '−' : '+'} Actions
                  </div>
                  {expandedSections.has('rbacActions') && (
                    <div className="iam-section-content">
                      <div className="svc-btn-row">
                        <button
                          className="svc-btn muted"
                          type="button"
                          disabled={!canRunTerminalCommand}
                          onClick={() => onRunTerminalCommand(`az role assignment list --subscription "${subscriptionId}" --assignee "${selectedAssignment.principalId}" --output table`)}
                        >List principal assignments</button>
                        <button
                          className="svc-btn danger"
                          type="button"
                          onClick={() => void handleDeleteAssignment(selectedAssignment)}
                        >Delete this assignment</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════ ROLES ══════════════════ */}
      {mainTab === 'roles' && (
        <>
          <div className="iam-surface">
            <div className="iam-filter-shell iam-filter-shell-policy">
              <div>
                <span className="iam-pane-kicker">Role Definitions</span>
                <h3>Permission boundaries</h3>
              </div>
              <div className="svc-btn-row iam-scope-switch">
                <button type="button" className={`svc-btn ${roleTypeFilter === 'All' ? 'primary' : 'muted'}`} onClick={() => setRoleTypeFilter('All')}>All</button>
                <button type="button" className={`svc-btn ${roleTypeFilter === 'BuiltIn' ? 'primary' : 'muted'}`} onClick={() => setRoleTypeFilter('BuiltIn')}>Built-in</button>
                <button type="button" className={`svc-btn ${roleTypeFilter === 'Custom' ? 'primary' : 'muted'}`} onClick={() => setRoleTypeFilter('Custom')}>Custom</button>
              </div>
              <input
                className="svc-search iam-search"
                placeholder="Filter rows across selected columns..."
                value={roleFilter}
                onChange={e => setRoleFilter(e.target.value)}
              />
            </div>
            <div className="svc-chips iam-chip-row">
              {ROLE_DEF_COLS.map(c => (
                <button
                  key={c.key}
                  type="button"
                  className={`svc-chip ${roleVisibleCols.has(c.key) ? 'active' : ''}`}
                  style={roleVisibleCols.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
                  onClick={() => rbacToggleCol(setRoleVisibleCols, c.key)}
                >{c.label}</button>
              ))}
            </div>
          </div>

          <div className="iam-layout">
            {/* ── Left: Roles table ───────────────────── */}
            <div className="iam-table-area">
              <table className="svc-table">
                <thead>
                  <tr>{activeRoleCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {mainTabLoading === 'roles' && (
                    <tr><td colSpan={activeRoleCols.length}>Gathering data</td></tr>
                  )}
                  {mainTabLoading !== 'roles' && filteredRoles.map(r => (
                    <tr
                      key={r.id}
                      className={selectedRole?.id === r.id ? 'active' : ''}
                      onClick={() => setSelectedRole(r)}
                    >
                      {activeRoleCols.map(c => (
                        <td key={c.key}>
                          {c.key === 'roleType'
                            ? <span className={r.roleType === 'CustomRole' ? 'svc-badge warn' : 'svc-badge muted'}>{c.getValue(r)}</span>
                            : c.getValue(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredRoles.length && mainTabLoading !== 'roles' && <div className="svc-empty">No role definitions found.</div>}

              <div className="iam-bottom-actions">
                <button
                  className="svc-btn muted"
                  type="button"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(`az role definition list --subscription "${subscriptionId}" --output table`)}
                >List in terminal</button>
                <button
                  className="svc-btn muted"
                  type="button"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(`az role definition list --subscription "${subscriptionId}" --custom-role-only true --output table`)}
                >List custom roles</button>
              </div>
            </div>

            {/* ── Right: Role sidebar ─────────────────── */}
            <div className="iam-sidebar">
              {!selectedRole && <div className="iam-sidebar-placeholder">Select a role to view details</div>}

              {selectedRole && (
                <>
                  {/* ── Details ─────────────────────── */}
                  <div className="iam-section-header" onClick={() => rbacToggleSection('details')}>
                    {expandedSections.has('details') ? '−' : '+'} Role Details
                  </div>
                  {expandedSections.has('details') && (
                    <div className="iam-section-content">
                      <div className="iam-metadata-grid">
                        <div>
                          <span>Name</span>
                          <strong>{selectedRole.roleName}</strong>
                        </div>
                        <div>
                          <span>Type</span>
                          <strong><span className={selectedRole.roleType === 'CustomRole' ? 'svc-badge warn' : 'svc-badge muted'}>{selectedRole.roleType === 'CustomRole' ? 'Custom' : 'Built-in'}</span></strong>
                        </div>
                      </div>
                      {selectedRole.description && (
                        <div style={{ color: '#a6bbcf', fontSize: '0.8rem', lineHeight: 1.5, marginTop: 8 }}>{selectedRole.description}</div>
                      )}
                    </div>
                  )}

                  {/* ── Permissions (Actions) ─────── */}
                  <div className="iam-section-header" onClick={() => rbacToggleSection('permissions')}>
                    {expandedSections.has('permissions') ? '−' : '+'} Actions ({selectedRole.actions.length})
                  </div>
                  {expandedSections.has('permissions') && (
                    <div className="iam-section-content">
                      {selectedRole.actions.length > 0 ? (
                        <div className="iam-output-panel" style={{ maxHeight: 200 }}>
                          <pre style={{ margin: 0 }}>{selectedRole.actions.join('\n')}</pre>
                        </div>
                      ) : <div className="svc-empty" style={{ padding: '8px 0', fontSize: '11px' }}>No actions.</div>}
                      {selectedRole.notActions.length > 0 && (
                        <>
                          <span style={{ color: '#f59e0b', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 8, display: 'block' }}>Not Actions ({selectedRole.notActions.length})</span>
                          <div className="iam-output-panel" style={{ maxHeight: 160 }}>
                            <pre style={{ margin: 0 }}>{selectedRole.notActions.join('\n')}</pre>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ── Data Actions ──────────────── */}
                  <div className="iam-section-header" onClick={() => rbacToggleSection('dataActions')}>
                    {expandedSections.has('dataActions') ? '−' : '+'} Data Actions ({selectedRole.dataActions.length})
                  </div>
                  {expandedSections.has('dataActions') && (
                    <div className="iam-section-content">
                      {selectedRole.dataActions.length > 0 ? (
                        <div className="iam-output-panel" style={{ maxHeight: 200 }}>
                          <pre style={{ margin: 0 }}>{selectedRole.dataActions.join('\n')}</pre>
                        </div>
                      ) : <div className="svc-empty" style={{ padding: '8px 0', fontSize: '11px' }}>No data actions.</div>}
                      {selectedRole.notDataActions.length > 0 && (
                        <>
                          <span style={{ color: '#f59e0b', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 8, display: 'block' }}>Not Data Actions ({selectedRole.notDataActions.length})</span>
                          <div className="iam-output-panel" style={{ maxHeight: 160 }}>
                            <pre style={{ margin: 0 }}>{selectedRole.notDataActions.join('\n')}</pre>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ── Assignable Scopes ─────────── */}
                  <div className="iam-section-header" onClick={() => rbacToggleSection('assignableScopes')}>
                    {expandedSections.has('assignableScopes') ? '−' : '+'} Assignable Scopes ({selectedRole.assignableScopes.length})
                  </div>
                  {expandedSections.has('assignableScopes') && (
                    <div className="iam-section-content">
                      {selectedRole.assignableScopes.length > 0 ? (
                        <div className="iam-output-panel" style={{ maxHeight: 160 }}>
                          <pre style={{ margin: 0 }}>{selectedRole.assignableScopes.join('\n')}</pre>
                        </div>
                      ) : <div className="svc-empty" style={{ padding: '8px 0', fontSize: '11px' }}>No assignable scopes.</div>}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════ OVERVIEW ══════════════════ */}
      {mainTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mainTabLoading === 'overview' && <SvcState variant="loading" resourceName="RBAC overview" compact />}
          {overview && (
            <>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#d0d8e2' }}>Posture Summary</h3>
              <div className="iam-metadata-grid">
                <div>
                  <span>Assignments</span>
                  <strong>{overview.assignmentCount}</strong>
                </div>
                <div>
                  <span>Risky Roles</span>
                  <strong>{overview.riskyAssignmentCount}</strong>
                </div>
                <div>
                  <span>Inherited</span>
                  <strong>{overview.inheritedAssignmentCount}</strong>
                </div>
                <div>
                  <span>Principals</span>
                  <strong>{overview.principalCount}</strong>
                </div>
                <div>
                  <span>Unique Roles</span>
                  <strong>{overview.roleCount}</strong>
                </div>
              </div>

              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#d0d8e2' }}>Scope Notes</h3>
              <div className="iam-metadata-grid">
                {(overview.notes.length > 0
                  ? overview.notes
                  : [
                    `${overview.riskyAssignmentCount} risky assignments should be reviewed before widening operator access.`,
                    `${overview.roleCount} unique roles are visible under the selected subscription.`,
                    'Inherited scope entries indicate role bindings attached below the subscription root.'
                  ]
                ).map((note, i) => (
                  <div key={i}>
                    <span>Note</span>
                    <strong style={{ fontSize: '0.8rem', fontWeight: 400, lineHeight: 1.4 }}>{note}</strong>
                  </div>
                ))}
              </div>

              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#d0d8e2' }}>Terminal Handoff</h3>
              <div className="svc-btn-row">
                <button
                  className="svc-btn muted"
                  type="button"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(`az role assignment list --subscription "${subscriptionId}" --all --output table`)}
                >List assignments</button>
                <button
                  className="svc-btn muted"
                  type="button"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(`az role definition list --subscription "${subscriptionId}" --output table`)}
                >List roles</button>
                <button className="svc-btn muted" type="button" onClick={onOpenCompliance}>Open compliance</button>
                <button className="svc-btn muted" type="button" onClick={onOpenMonitor}>Open monitor</button>
              </div>
            </>
          )}
          {!mainTabLoading && !overview && (
            <div className="svc-empty">RBAC posture was not available for the selected subscription.</div>
          )}
        </div>
      )}
    </div>
  )
}

type AzureVmColumnKey = 'name' | 'powerState' | 'vmSize' | 'osType' | 'location' | 'privateIp' | 'publicIp' | 'identityType'

const AZURE_VM_COLUMNS: { key: AzureVmColumnKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'powerState', label: 'Power', color: '#22c55e' },
  { key: 'vmSize', label: 'Size', color: '#8b5cf6' },
  { key: 'osType', label: 'OS', color: '#f59e0b' },
  { key: 'location', label: 'Location', color: '#06b6d4' },
  { key: 'privateIp', label: 'PrivateIp', color: '#a855f7' },
  { key: 'publicIp', label: 'PublicIp', color: '#14b8a6' },
  { key: 'identityType', label: 'Identity', color: '#ef4444' }
]

function getAzureVmColumnValue(vm: AzureVirtualMachineSummary, key: AzureVmColumnKey): string {
  switch (key) {
    case 'name': return vm.name
    case 'powerState': return vm.powerState || vm.provisioningState
    case 'vmSize': return vm.vmSize
    case 'osType': return vm.osType
    case 'location': return vm.location
    case 'privateIp': return vm.privateIp
    case 'publicIp': return vm.publicIp
    case 'identityType': return vm.identityType
  }
}

function azureVmPowerBadgeClass(powerState: string): string {
  const lower = powerState.toLowerCase()
  if (lower.includes('running')) return 'running'
  if (lower.includes('stopped') || lower.includes('deallocat')) return 'stopped'
  if (lower.includes('starting') || lower.includes('creating')) return 'pending'
  return ''
}

function AzureVmKV({ items }: { items: Array<[string, string]> }): JSX.Element {
  return (
    <div className="ec2-kv">
      {items.map(([label, value]) => (
        <div key={label} className="ec2-kv-row">
          <div className="ec2-kv-label">{label}</div>
          <div className="ec2-kv-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

export function AzureVirtualMachinesConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenMonitor,
  onOpenDirectAccess,
  pendingFocus,
  onFocusConsumed
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenMonitor: (query: string) => void
  onOpenDirectAccess: () => void
  pendingFocus?: { resourceId: string; resourceName: string; resourceGroup: string; token: number } | null
  onFocusConsumed?: () => void
}): JSX.Element {
  type VmTopTab = 'vms' | 'disks' | 'snapshots'
  const [vmTopTab, setVmTopTab] = useState<VmTopTab>('vms')

  const [machines, setMachines] = useState<AzureVirtualMachineSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const [stateFilter, setStateFilter] = useState('all')
  const [searchFilter, setSearchFilter] = useState('')
  const [visibleCols, setVisibleCols] = useState<Set<AzureVmColumnKey>>(
    new Set(['name', 'powerState', 'vmSize', 'osType', 'location', 'privateIp', 'publicIp'])
  )

  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<AzureVirtualMachineDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [vmSideTab, setVmSideTab] = useState<'overview' | 'timeline'>('overview')
  const [timelineEvents, setTimelineEvents] = useState<AzureMonitorActivityEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')

  /* ── Disks & Snapshots state ── */
  const [disks, setDisks] = useState<AzureManagedDiskSummary[]>([])
  const [disksLoading, setDisksLoading] = useState(false)
  const [disksError, setDisksError] = useState('')
  const [selectedDiskId, setSelectedDiskId] = useState('')
  const [diskFilter, setDiskFilter] = useState('')

  const [snapshots, setSnapshots] = useState<AzureDiskSnapshotSummary[]>([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [snapshotsError, setSnapshotsError] = useState('')
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('')
  const [snapshotFilter, setSnapshotFilter] = useState('')

  useEffect(() => {
    if (vmTopTab === 'disks' && disks.length === 0 && !disksLoading) {
      setDisksLoading(true)
      setDisksError('')
      listAzureManagedDisks(subscriptionId, location)
        .then((next) => { setDisks(sortByName(next)); if (next.length > 0 && !selectedDiskId) setSelectedDiskId(next[0].id) })
        .catch((err) => setDisksError(normalizeError(err)))
        .finally(() => setDisksLoading(false))
    }
    if (vmTopTab === 'snapshots' && snapshots.length === 0 && !snapshotsLoading) {
      setSnapshotsLoading(true)
      setSnapshotsError('')
      listAzureDiskSnapshots(subscriptionId, location)
        .then((next) => { setSnapshots(sortByName(next)); if (next.length > 0 && !selectedSnapshotId) setSelectedSnapshotId(next[0].id) })
        .catch((err) => setSnapshotsError(normalizeError(err)))
        .finally(() => setSnapshotsLoading(false))
    }
  }, [vmTopTab, subscriptionId, location, refreshNonce])

  async function reload(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const next = await listAzureVirtualMachines(subscriptionId, location)
      const sorted = sortByName(next)
      setMachines(sorted)
      const resolvedId = selectedId && sorted.some((vm) => vm.id === selectedId)
        ? selectedId
        : (sorted[0]?.id ?? '')
      if (resolvedId && resolvedId !== selectedId) {
        const match = sorted.find((vm) => vm.id === resolvedId)
        if (match) void selectVm(match)
      } else if (resolvedId) {
        setSelectedId(resolvedId)
      }
    } catch (err) {
      setError(normalizeError(err))
      setMachines([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [location, refreshNonce, subscriptionId])

  useEffect(() => {
    if (!pendingFocus || machines.length === 0) return
    const match = machines.find((vm) =>
      vm.id === pendingFocus.resourceId ||
      (vm.name === pendingFocus.resourceName && vm.resourceGroup === pendingFocus.resourceGroup)
    )
    if (match) {
      setVmTopTab('vms')
      void selectVm(match)
      onFocusConsumed?.()
    }
  }, [pendingFocus?.token, machines])

  async function selectVm(vm: AzureVirtualMachineSummary): Promise<void> {
    setSelectedId(vm.id)
    setDetailLoading(true)
    setMsg('')
    setVmSideTab('overview')
    setTimelineEvents([])
    setTimelineError('')
    try {
      const d = await describeAzureVirtualMachine(subscriptionId, vm.resourceGroup, vm.name)
      setDetail(d)
    } catch (err) {
      setDetail(null)
      setMsg(normalizeError(err))
    } finally {
      setDetailLoading(false)
    }
  }

  async function loadVmTimeline() {
    if (!detail) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const result = await listAzureMonitorActivity(subscriptionId, location, `Microsoft.Compute|${detail.name}`, 168)
      setTimelineEvents(result.events)
    } catch (error) {
      setTimelineEvents([])
      setTimelineError(error instanceof Error ? error.message : 'Failed to load activity')
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (vmSideTab === 'timeline' && detail) void loadVmTimeline()
  }, [vmSideTab, selectedId])

  async function doVmAction(action: AzureVmAction): Promise<void> {
    if (!detail) return
    setActionBusy(true)
    try {
      const result = await runAzureVmAction(subscriptionId, detail.resourceGroup, detail.name, action)
      if (result.accepted) {
        setMsg(`${action} sent to ${detail.name}`)
      } else {
        setMsg(result.error || `${action} failed`)
      }
      setTimeout(() => void reload(), 5000)
    } catch (err) {
      setMsg(normalizeError(err))
    } finally {
      setActionBusy(false)
    }
  }

  const filteredMachines = machines.filter((vm) => {
    if (stateFilter !== 'all') {
      const power = vm.powerState.toLowerCase()
      if (stateFilter === 'running' && !power.includes('running')) return false
      if (stateFilter === 'stopped' && !power.includes('stopped') && !power.includes('deallocat')) return false
      if (stateFilter === 'deallocated' && !power.includes('deallocat')) return false
    }
    if (searchFilter) {
      const search = searchFilter.toLowerCase()
      const cols = Array.from(visibleCols)
      return cols.some((col) => getAzureVmColumnValue(vm, col).toLowerCase().includes(search))
    }
    return true
  })

  function toggleColumn(key: AzureVmColumnKey): void {
    setVisibleCols((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const activeCols = AZURE_VM_COLUMNS.filter((c) => visibleCols.has(c.key))
  const selectedVm = machines.find((vm) => vm.id === selectedId) ?? null
  const runningCount = machines.filter((vm) => vm.powerState.toLowerCase().includes('running')).length
  const stoppedCount = machines.filter((vm) => {
    const p = vm.powerState.toLowerCase()
    return p.includes('stopped') || p.includes('deallocat')
  }).length
  const publicCount = machines.filter((vm) => vm.hasPublicIp).length

  const heroStats = [
    { label: 'Fleet', value: String(machines.length), detail: `${runningCount} running / ${stoppedCount} stopped`, tone: 'accent' as const },
    { label: 'Public Exposure', value: String(publicCount), detail: 'VMs with a public IP', tone: publicCount > 0 ? 'warning' as const : 'default' as const },
    { label: 'Filtered', value: String(filteredMachines.length), detail: `of ${machines.length} total VMs`, tone: 'info' as const },
    { label: 'Selection', value: selectedVm?.name || 'No VM selected', detail: selectedVm ? `${selectedVm.vmSize} in ${selectedVm.location}` : 'pick a VM to inspect', tone: 'default' as const }
  ]

  const isRunning = detail?.powerState.toLowerCase().includes('running')
  const isStopped = detail?.powerState.toLowerCase().includes('stopped') || detail?.powerState.toLowerCase().includes('deallocat')
  const tagEntries = detail ? Object.entries(detail.tags) : []

  if (loading && machines.length === 0) return <SvcState variant="loading" resourceName="Azure Virtual Machines" />

  return (
    <div className="ec2-console azure-vm-console">
      <section className="ec2-shell-hero">
        <div className="ec2-shell-hero-copy">
          <span className="ec2-shell-kicker">Compute Operations</span>
          <h2>Azure VM inventory, actions, and posture in one workspace.</h2>
          <p>Review fleet state, inspect VM details, manage power state, and drive terminal commands from the same operational surface.</p>
          <div className="ec2-shell-meta-strip">
            <div className="ec2-shell-meta-pill"><span>Subscription</span><strong>{subscriptionId.slice(0, 13)}...</strong></div>
            <div className="ec2-shell-meta-pill"><span>Location</span><strong>{formatLocationHint(location)}</strong></div>
            <div className="ec2-shell-meta-pill"><span>Provider</span><strong>Azure</strong></div>
            <div className="ec2-shell-meta-pill"><span>Focus</span><strong>Virtual Machines</strong></div>
          </div>
        </div>
        <div className="ec2-shell-hero-stats">
          {heroStats.map((stat) => (
            <div key={stat.label} className={`ec2-shell-stat-card${stat.tone === 'accent' ? ' accent' : stat.tone === 'warning' ? ' warning' : stat.tone === 'info' ? ' info' : ''}`}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small>{stat.detail}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="ec2-shell-toolbar">
        <div className="ec2-shell-status" />
        <div className="ec2-tab-bar">
          <button className={`ec2-tab${vmTopTab === 'vms' ? ' active' : ''}`} type="button" onClick={() => setVmTopTab('vms')}>Instances</button>
          <button className={`ec2-tab${vmTopTab === 'disks' ? ' active' : ''}`} type="button" onClick={() => setVmTopTab('disks')}>Managed Disks</button>
          <button className={`ec2-tab${vmTopTab === 'snapshots' ? ' active' : ''}`} type="button" onClick={() => setVmTopTab('snapshots')}>Snapshots</button>
          <button className="ec2-toolbar-btn accent" type="button" onClick={() => { if (vmTopTab === 'vms') void reload(); else if (vmTopTab === 'disks') { setDisks([]); setDisksLoading(false) } else { setSnapshots([]); setSnapshotsLoading(false) } }}>Refresh</button>
        </div>
      </div>

      {vmTopTab === 'vms' && msg && <div className="ec2-msg">{msg}</div>}
      {vmTopTab === 'vms' && !loading && error ? <SvcState variant="error" error={error} /> : null}
      {vmTopTab === 'vms' && !loading && !error && machines.length === 0 ? (
        <SvcState variant="empty" message="No Azure virtual machines were discovered for the selected subscription/location." />
      ) : null}

      {vmTopTab === 'vms' && machines.length > 0 && (
        <>
          <div className="ec2-filter-shell">
            <div className="ec2-filter-grid">
              <div className="ec2-filter-field">
                <span className="ec2-filter-label">State</span>
                <select className="ec2-select" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                  <option value="all">All states</option>
                  <option value="running">Running</option>
                  <option value="stopped">Stopped / Deallocated</option>
                  <option value="deallocated">Deallocated</option>
                </select>
              </div>
              <div className="ec2-filter-field ec2-filter-field-search">
                <span className="ec2-filter-label">Search</span>
                <input className="ec2-search-input" placeholder="Filter rows across selected columns..." value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} />
              </div>
            </div>
            <div className="ec2-column-chips">
              {AZURE_VM_COLUMNS.map((col) => (
                <button key={col.key} className={`ec2-chip ${visibleCols.has(col.key) ? 'active' : ''}`} type="button" style={visibleCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined} onClick={() => toggleColumn(col.key)}>{col.label}</button>
              ))}
            </div>
          </div>

          <div className="ec2-main-layout">
            <div className="ec2-table-shell">
              <div className="ec2-table-shell-header">
                <div>
                  <h3>VM Inventory</h3>
                  <p>{filteredMachines.length} visible rows across {activeCols.length} active columns.</p>
                </div>
                <div className="ec2-table-shell-meta">
                  <span className="ec2-workspace-badge">{runningCount} running</span>
                  <span className="ec2-workspace-badge">{publicCount} public IP</span>
                </div>
              </div>
              <div className="ec2-table-area">
                <table className="ec2-data-table">
                  <thead>
                    <tr>
                      {activeCols.map((col) => <th key={col.key}>{col.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMachines.map((vm) => (
                      <tr key={vm.id} className={vm.id === selectedId ? 'active' : ''} onClick={() => void selectVm(vm)}>
                        {activeCols.map((col) => (
                          <td key={col.key}>
                            {col.key === 'powerState'
                              ? <span className={`ec2-badge ${azureVmPowerBadgeClass(vm.powerState)}`}>{vm.powerState || vm.provisioningState}</span>
                              : col.key === 'name'
                                ? (<div className="ec2-cell-stack"><span>{vm.name}</span><small style={{ color: '#9ca7b7', fontSize: '10px' }}>{vm.resourceGroup}</small></div>)
                                : getAzureVmColumnValue(vm, col.key) || '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filteredMachines.length && <SvcState variant="no-filter-matches" resourceName="virtual machines" compact />}
              </div>
            </div>

            <div className="ec2-sidebar">
              <div className="ec2-side-tabs">
                <button className={vmSideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setVmSideTab('overview')}>Overview</button>
                <button className={vmSideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setVmSideTab('timeline')}>Activity Timeline</button>
              </div>

              {vmSideTab === 'overview' && (
                <>
                  <div className="ec2-sidebar-section">
                    <h3>Actions</h3>
                    <div className="ec2-actions-grid">
                      <button className="ec2-action-btn start" type="button" disabled={!detail || isRunning || actionBusy} onClick={() => void doVmAction('start')}>Start</button>
                      <ConfirmButton className="ec2-action-btn stop" type="button" disabled={!detail || isStopped || actionBusy} onConfirm={() => void doVmAction('deallocate')}>Deallocate</ConfirmButton>
                      <ConfirmButton className="ec2-action-btn" type="button" disabled={!detail || !isRunning || actionBusy} onConfirm={() => void doVmAction('restart')}>Restart</ConfirmButton>
                      <ConfirmButton className="ec2-action-btn stop" type="button" disabled={!detail || !isRunning || actionBusy} onConfirm={() => void doVmAction('powerOff')}>Power Off</ConfirmButton>
                      <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand || !detail} onClick={() => { if (detail) onRunTerminalCommand(`az vm show -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}" -d --output jsonc`) }}>Describe</button>
                      <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand || !detail} onClick={() => { if (detail) onRunTerminalCommand(`az serial-console connect -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}"`) }}>Serial Console</button>
                      <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand || !detail} onClick={() => { if (detail) onRunTerminalCommand(`az vm run-command invoke -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}" --command-id RunShellScript --scripts "uname -a && whoami && df -h"`) }}>Run Command</button>
                      <button className="ec2-action-btn" type="button" onClick={() => onOpenMonitor('Microsoft.Compute virtualMachines')}>Monitor</button>
                      <button className="ec2-action-btn" type="button" onClick={onOpenDirectAccess}>Direct Access</button>
                    </div>
                  </div>

                  {detailLoading && (<div className="ec2-sidebar-section"><SvcState variant="loading" resourceName="VM detail" compact /></div>)}

                  {detail && !detailLoading && (
                    <>
                      <div className="ec2-sidebar-section">
                        <h3>Instance Detail</h3>
                        <AzureVmKV items={[['Name', detail.name], ['Resource Group', detail.resourceGroup], ['Location', detail.location], ['VM Size', detail.vmSize], ['Power State', detail.powerState], ['Provisioning', detail.provisioningState], ['OS Type', detail.osType], ['Computer Name', detail.computerName || '-'], ['Admin User', detail.adminUsername || '-'], ['Availability Zone', detail.availabilityZone || '-'], ['Image', detail.imageReference || '-'], ['Identity', detail.identityType]]} />
                      </div>

                      <div className="ec2-sidebar-section">
                        <h3>Networking</h3>
                        <AzureVmKV items={[['Private IP', detail.privateIp || '-'], ['Public IP', detail.publicIp || '-'], ['VNet', detail.vnetName || '-'], ['Subnet', detail.subnetName || '-'], ['NSG', detail.networkSecurityGroup || '-'], ['NICs', String(detail.networkInterfaceCount)]]} />
                      </div>

                      <div className="ec2-sidebar-section">
                        <h3>Storage</h3>
                        <AzureVmKV items={[['OS Disk', detail.osDiskName || '-'], ['OS Disk Size', detail.osDiskSizeGiB ? `${detail.osDiskSizeGiB} GiB` : '-'], ['OS Disk Type', detail.osDiskType || '-'], ['Data Disks', String(detail.dataDisks.length)], ['Boot Diagnostics', detail.diagnosticsState]]} />
                        {detail.dataDisks.length > 0 && (
                          <div style={{ marginTop: 8 }}>
                            {detail.dataDisks.map((disk) => (
                              <div key={disk.name} className="ec2-kv-row">
                                <div className="ec2-kv-label">LUN {disk.lun}</div>
                                <div className="ec2-kv-value">{disk.name} ({disk.sizeGiB} GiB, {disk.type || 'unknown'})</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {tagEntries.length > 0 && (
                        <div className="ec2-sidebar-section">
                          <h3>Tags ({tagEntries.length})</h3>
                          <AzureVmKV items={tagEntries.map(([k, v]) => [k, v])} />
                        </div>
                      )}

                      <div className="ec2-sidebar-section">
                        <h3>Terminal Handoff</h3>
                        <div className="ec2-actions-grid">
                          <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az vm list-ip-addresses -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}" --output table`)}>IP Addresses</button>
                          <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az vm get-instance-view -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}" --output jsonc`)}>Instance View</button>
                          <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az disk list -g "${detail.resourceGroup}" --subscription "${subscriptionId}" --output table`)}>List Disks</button>
                          <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az vm list -g "${detail.resourceGroup}" --subscription "${subscriptionId}" -d --output table`)}>List VMs in RG</button>
                          <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az network nsg list -g "${detail.resourceGroup}" --subscription "${subscriptionId}" --output table`)}>List NSGs</button>
                          <button className="ec2-action-btn" type="button" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az vm boot-diagnostics get-boot-log -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}"`)}>Boot Log</button>
                        </div>
                      </div>
                    </>
                  )}

                  {!detail && !detailLoading && (
                    <div className="ec2-sidebar-section">
                      <div className="ec2-empty">Select a virtual machine to view details, run actions, and inspect configuration.</div>
                    </div>
                  )}
                </>
              )}

              {vmSideTab === 'timeline' && (
                <div className="ec2-sidebar-section">
                  <h3>Azure Monitor Activity</h3>
                  <div style={{ color: '#9ca7b7', fontSize: 12, marginBottom: 8 }}>
                    Management-plane events for <strong>{detail?.name ?? 'selected VM'}</strong> from the last 7 days.
                  </div>
                  {!detail && <div className="ec2-empty">Select a virtual machine to view activity.</div>}
                  {detail && timelineLoading && <div className="ec2-empty">Loading activity events...</div>}
                  {detail && !timelineLoading && timelineError && <div className="ec2-empty" style={{ color: '#f87171' }}>{timelineError}</div>}
                  {detail && !timelineLoading && !timelineError && timelineEvents.length === 0 && <div className="ec2-empty">No Azure Monitor events found.</div>}
                  {detail && !timelineLoading && timelineEvents.length > 0 && (
                    <div className="ec2-timeline-table-wrap">
                      <table className="ec2-timeline-table">
                        <thead><tr><th>Operation</th><th>Status</th><th>Caller</th><th>Time</th></tr></thead>
                        <tbody>
                          {timelineEvents.map((event) => (
                            <tr key={event.id}>
                              <td title={event.resourceType}>{event.operationName}</td>
                              <td>{event.status}</td>
                              <td>{event.caller}</td>
                              <td>{event.timestamp ? new Date(event.timestamp).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Managed Disks tab ── */}
      {vmTopTab === 'disks' && disksLoading && <SvcState variant="loading" resourceName="managed disks" />}
      {vmTopTab === 'disks' && !disksLoading && disksError && <SvcState variant="error" error={disksError} />}
      {vmTopTab === 'disks' && !disksLoading && !disksError && disks.length === 0 && <SvcState variant="empty" message="No managed disks found." />}
      {vmTopTab === 'disks' && !disksLoading && disks.length > 0 && (() => {
        const filteredDisks = diskFilter
          ? disks.filter((d) => d.name.toLowerCase().includes(diskFilter.toLowerCase()) || d.resourceGroup.toLowerCase().includes(diskFilter.toLowerCase()))
          : disks
        const selectedDisk = disks.find((d) => d.id === selectedDiskId)
        const orphanedCount = disks.filter((d) => !d.managedBy).length
        return (
          <div className="ec2-main-layout">
            <div className="ec2-table-shell">
              <div className="ec2-table-shell-header">
                <div>
                  <h3>Managed Disks</h3>
                  <p>{filteredDisks.length} disks, {orphanedCount} orphaned (unattached)</p>
                </div>
              </div>
              <div style={{ padding: '6px 12px' }}>
                <input className="ec2-search-input" placeholder="Filter disks..." value={diskFilter} onChange={(e) => setDiskFilter(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div className="ec2-table-area">
                <table className="ec2-data-table">
                  <thead><tr><th>Name</th><th>State</th><th>Size</th><th>SKU</th><th>OS</th><th>Attached To</th><th>Location</th></tr></thead>
                  <tbody>
                    {filteredDisks.map((d) => (
                      <tr key={d.id} className={d.id === selectedDiskId ? 'active' : ''} onClick={() => setSelectedDiskId(d.id)}>
                        <td><div className="ec2-cell-stack"><span>{d.name}</span><small style={{ color: '#9ca7b7', fontSize: '10px' }}>{d.resourceGroup}</small></div></td>
                        <td><span className={`ec2-badge ${d.diskState.toLowerCase() === 'attached' ? 'ok' : d.diskState.toLowerCase() === 'unattached' ? 'warn' : ''}`}>{d.diskState}</span></td>
                        <td>{d.diskSizeGb} GiB</td>
                        <td>{d.skuName}</td>
                        <td>{d.osType || '-'}</td>
                        <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.managedBy ? d.managedBy.split('/').pop() : <span style={{ color: '#f59e0b' }}>Orphaned</span>}</td>
                        <td>{d.location}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="ec2-sidebar">
              {selectedDisk ? (
                <>
                  <div className="ec2-sidebar-section">
                    <h3>Disk Detail</h3>
                    <AzureVmKV items={[
                      ['Name', selectedDisk.name],
                      ['Resource Group', selectedDisk.resourceGroup],
                      ['Location', selectedDisk.location],
                      ['Disk State', selectedDisk.diskState],
                      ['SKU', selectedDisk.skuName],
                      ['Size', `${selectedDisk.diskSizeGb} GiB`],
                      ['OS Type', selectedDisk.osType || '-'],
                      ['Created', selectedDisk.timeCreated ? new Date(selectedDisk.timeCreated).toLocaleString() : '-'],
                      ['Network Policy', selectedDisk.networkAccessPolicy || '-'],
                      ['Zones', selectedDisk.zones.length > 0 ? selectedDisk.zones.join(', ') : '-'],
                      ['Provisioning', selectedDisk.provisioningState],
                      ['Tags', String(selectedDisk.tagCount)]
                    ]} />
                  </div>
                  <div className="ec2-sidebar-section">
                    <h3>Attached VM</h3>
                    {selectedDisk.managedBy
                      ? <AzureVmKV items={[['VM', selectedDisk.managedBy.split('/').pop() ?? '-'], ['Resource ID', selectedDisk.managedBy]]} />
                      : <div className="ec2-empty" style={{ color: '#f59e0b' }}>This disk is not attached to any VM (orphaned).</div>}
                  </div>
                  {canRunTerminalCommand && (
                    <div className="ec2-sidebar-section">
                      <h3>Terminal</h3>
                      <div className="ec2-actions-grid">
                        <button className="ec2-action-btn" type="button" onClick={() => onRunTerminalCommand(`az disk show -g "${selectedDisk.resourceGroup}" -n "${selectedDisk.name}" --subscription "${subscriptionId}" --output jsonc`)}>Describe</button>
                        <button className="ec2-action-btn" type="button" onClick={() => onRunTerminalCommand(`az snapshot list -g "${selectedDisk.resourceGroup}" --subscription "${subscriptionId}" --query "[?creationData.sourceResourceId=='${selectedDisk.id}']" --output table`)}>Snapshots</button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="ec2-sidebar-section"><div className="ec2-empty">Select a disk to view details.</div></div>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Snapshots tab ── */}
      {vmTopTab === 'snapshots' && snapshotsLoading && <SvcState variant="loading" resourceName="disk snapshots" />}
      {vmTopTab === 'snapshots' && !snapshotsLoading && snapshotsError && <SvcState variant="error" error={snapshotsError} />}
      {vmTopTab === 'snapshots' && !snapshotsLoading && !snapshotsError && snapshots.length === 0 && <SvcState variant="empty" message="No disk snapshots found." />}
      {vmTopTab === 'snapshots' && !snapshotsLoading && snapshots.length > 0 && (() => {
        const filteredSnaps = snapshotFilter
          ? snapshots.filter((s) => s.name.toLowerCase().includes(snapshotFilter.toLowerCase()) || s.resourceGroup.toLowerCase().includes(snapshotFilter.toLowerCase()))
          : snapshots
        const selectedSnap = snapshots.find((s) => s.id === selectedSnapshotId)
        const incrementalCount = snapshots.filter((s) => s.incremental).length
        return (
          <div className="ec2-main-layout">
            <div className="ec2-table-shell">
              <div className="ec2-table-shell-header">
                <div>
                  <h3>Disk Snapshots</h3>
                  <p>{filteredSnaps.length} snapshots, {incrementalCount} incremental</p>
                </div>
              </div>
              <div style={{ padding: '6px 12px' }}>
                <input className="ec2-search-input" placeholder="Filter snapshots..." value={snapshotFilter} onChange={(e) => setSnapshotFilter(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div className="ec2-table-area">
                <table className="ec2-data-table">
                  <thead><tr><th>Name</th><th>Size</th><th>SKU</th><th>Incremental</th><th>Source</th><th>Created</th><th>Location</th></tr></thead>
                  <tbody>
                    {filteredSnaps.map((s) => (
                      <tr key={s.id} className={s.id === selectedSnapshotId ? 'active' : ''} onClick={() => setSelectedSnapshotId(s.id)}>
                        <td><div className="ec2-cell-stack"><span>{s.name}</span><small style={{ color: '#9ca7b7', fontSize: '10px' }}>{s.resourceGroup}</small></div></td>
                        <td>{s.diskSizeGb} GiB</td>
                        <td>{s.skuName}</td>
                        <td><span className={`ec2-badge ${s.incremental ? 'ok' : ''}`}>{s.incremental ? 'Yes' : 'Full'}</span></td>
                        <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.sourceResourceId ? s.sourceResourceId.split('/').pop() : '-'}</td>
                        <td>{s.timeCreated ? new Date(s.timeCreated).toLocaleDateString() : '-'}</td>
                        <td>{s.location}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="ec2-sidebar">
              {selectedSnap ? (
                <div className="ec2-sidebar-section">
                  <h3>Snapshot Detail</h3>
                  <AzureVmKV items={[
                    ['Name', selectedSnap.name],
                    ['Resource Group', selectedSnap.resourceGroup],
                    ['Location', selectedSnap.location],
                    ['SKU', selectedSnap.skuName],
                    ['Size', `${selectedSnap.diskSizeGb} GiB`],
                    ['Incremental', selectedSnap.incremental ? 'Yes' : 'Full'],
                    ['Source Disk', selectedSnap.sourceResourceId ? selectedSnap.sourceResourceId.split('/').pop() ?? '-' : '-'],
                    ['Created', selectedSnap.timeCreated ? new Date(selectedSnap.timeCreated).toLocaleString() : '-'],
                    ['Provisioning', selectedSnap.provisioningState],
                    ['Tags', String(selectedSnap.tagCount)]
                  ]} />
                </div>
              ) : (
                <div className="ec2-sidebar-section"><div className="ec2-empty">Select a snapshot to view details.</div></div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

type AksNodePoolCol = 'name' | 'status' | 'min' | 'desired' | 'max' | 'vmSize' | 'version' | 'mode'
const AKS_NODEPOOL_COLUMNS: { key: AksNodePoolCol; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#4a8fe7' },
  { key: 'status', label: 'Status', color: '#59c58c' },
  { key: 'min', label: 'Min', color: '#9ec7ff' },
  { key: 'desired', label: 'Desired', color: '#f59a3d' },
  { key: 'max', label: 'Max', color: '#ff8f7d' },
  { key: 'vmSize', label: 'VM Size', color: '#7adbd1' },
  { key: 'version', label: 'Version', color: '#b59cff' },
  { key: 'mode', label: 'Mode', color: '#d3b46f' }
]
function getAksNpVal(pool: AzureAksNodePoolSummary, key: AksNodePoolCol): string {
  switch (key) {
    case 'name': return pool.name
    case 'status': return pool.status
    case 'min': return String(pool.min)
    case 'desired': return String(pool.desired)
    case 'max': return String(pool.max)
    case 'vmSize': return pool.vmSize
    case 'version': return pool.kubernetesVersion
    case 'mode': return pool.mode
  }
}
function aksStatusTone(s: string): 'success' | 'warning' | 'danger' | 'info' {
  const l = s.toLowerCase()
  if (l === 'succeeded' || l === 'running' || l === 'ready' || l === 'active') return 'success'
  if (l === 'creating' || l === 'updating' || l === 'scaling' || l === 'upgrading' || l === 'warning') return 'warning'
  if (l === 'failed' || l === 'stopped' || l.includes('delet') || l.includes('fail') || l.includes('degrad')) return 'danger'
  return 'info'
}
function AksBadge({ status }: { status: string }) { return <span className={`eks-badge ${aksStatusTone(status)}`}>{status}</span> }
function AksCard({ label, value, note, tone = 'info' }: { label: string; value: string | number; note: string; tone?: 'success' | 'warning' | 'danger' | 'info' }) { return <div className={`eks-stat-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div> }
function AksKv({ label, value }: { label: string; value: string }) { return <div className="eks-kv-row"><div className="eks-kv-label">{label}</div><div className="eks-kv-value">{value || '-'}</div></div> }
function aksFmt(v: string): string { if (!v || v === '-') return '-'; try { return new Date(v).toLocaleString() } catch { return v } }
function aksTrunc(v: string, m = 52): string { if (!v) return '-'; return v.length <= m ? v : `${v.slice(0, m - 3)}...` }
function aksAccess(d: AzureAksClusterDetail | null): string { return !d ? '-' : d.privateCluster ? 'Private API' : 'Public API' }

export function AzureAksConsole({ subscriptionId, location, refreshNonce, onRunTerminalCommand, canRunTerminalCommand, onOpenMonitor, pendingFocus, onFocusConsumed }: { subscriptionId: string; location: string; refreshNonce: number; onRunTerminalCommand: (command: string) => void; canRunTerminalCommand: boolean; onOpenMonitor: (query: string) => void; pendingFocus?: { resourceId: string; resourceName: string; resourceGroup: string; token: number } | null; onFocusConsumed?: () => void }): JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [clusters, setClusters] = useState<AzureAksClusterSummary[]>([])
  const [selectedCluster, setSelectedCluster] = useState('')
  const [detail, setDetail] = useState<AzureAksClusterDetail | null>(null)
  const [clusterSearch, setClusterSearch] = useState('')
  const [nodePools, setNodePools] = useState<AzureAksNodePoolSummary[]>([])
  const [npSearch, setNpSearch] = useState('')
  const [visibleNpCols, setVisibleNpCols] = useState<Set<AksNodePoolCol>>(new Set(['name', 'status', 'min', 'desired', 'max', 'vmSize', 'version', 'mode']))
  const [selectedNp, setSelectedNp] = useState('')
  const [sideTab, setSideTab] = useState<'overview' | 'details' | 'timeline'>('overview')
  const [aksTimelineEvents, setAksTimelineEvents] = useState<AzureMonitorActivityEvent[]>([])
  const [aksTimelineLoading, setAksTimelineLoading] = useState(false)
  const [aksTimelineError, setAksTimelineError] = useState('')
  const [showDescribe, setShowDescribe] = useState(false)
  const [showScale, setShowScale] = useState(false)
  const [scaleMin, setScaleMin] = useState('')
  const [scaleDesired, setScaleDesired] = useState('')
  const [scaleMax, setScaleMax] = useState('')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleErr, setScaleErr] = useState('')
  const [showKubeconfigForm, setShowKubeconfigForm] = useState(false)
  const [kubeconfigContextName, setKubeconfigContextName] = useState('')
  const [kubeconfigLocation, setKubeconfigLocation] = useState('.kube/config')
  const [kubeconfigBusy, setKubeconfigBusy] = useState(false)
  const [kubeconfigErr, setKubeconfigErr] = useState('')
  const [showAutoscaleToggle, setShowAutoscaleToggle] = useState(false)
  const [autoscaleToggleBusy, setAutoscaleToggleBusy] = useState(false)
  const [autoscaleToggleErr, setAutoscaleToggleErr] = useState('')
  const [autoscaleMinInput, setAutoscaleMinInput] = useState('')
  const [autoscaleMaxInput, setAutoscaleMaxInput] = useState('')

  const activeNpCols = AKS_NODEPOOL_COLUMNS.filter((c) => visibleNpCols.has(c.key))
  const filteredClusters = useMemo(() => { const q = clusterSearch.trim().toLowerCase(); if (!q) return clusters; return clusters.filter((c) => c.name.toLowerCase().includes(q) || c.kubernetesVersion.toLowerCase().includes(q) || c.provisioningState.toLowerCase().includes(q) || c.location.toLowerCase().includes(q)) }, [clusterSearch, clusters])
  const filteredNodePools = useMemo(() => { const q = npSearch.trim().toLowerCase(); if (!q) return nodePools; return nodePools.filter((p) => activeNpCols.some((c) => getAksNpVal(p, c.key).toLowerCase().includes(q))) }, [activeNpCols, npSearch, nodePools])
  const selectedNodePool = useMemo(() => nodePools.find((p) => p.name === selectedNp) ?? null, [nodePools, selectedNp])
  const healthyClusters = useMemo(() => clusters.filter((c) => aksStatusTone(c.provisioningState) === 'success').length, [clusters])
  const totalDesiredNodes = useMemo(() => nodePools.reduce((s, p) => s + Number(p.desired || 0), 0), [nodePools])

  async function reload() { setLoading(true); setError(''); try { const list = await listAzureAksClusters(subscriptionId, location); setClusters(sortByName(list)); if (list.length && !selectedCluster) await doSelect(list[0]) } catch (e) { setError(normalizeError(e)) } finally { setLoading(false) } }
  useEffect(() => { void reload() }, [refreshNonce, subscriptionId, location])

  useEffect(() => {
    if (!pendingFocus || clusters.length === 0) return
    const match = clusters.find((c) =>
      c.id === pendingFocus.resourceId ||
      (c.name === pendingFocus.resourceName && c.resourceGroup === pendingFocus.resourceGroup)
    )
    if (match) {
      void doSelect(match)
      onFocusConsumed?.()
    }
  }, [pendingFocus?.token, clusters])

  async function doSelect(cluster: AzureAksClusterSummary) {
    setSelectedCluster(cluster.name); setError(''); setMsg(''); setShowDescribe(false); setShowScale(false); setShowAutoscaleToggle(false)
    setSideTab('overview'); setAksTimelineEvents([]); setAksTimelineError('')
    try { const [d, np] = await Promise.all([describeAzureAksCluster(subscriptionId, cluster.resourceGroup, cluster.name), listAzureAksNodePools(subscriptionId, cluster.resourceGroup, cluster.name)]); setDetail(d); setNodePools(np); setSelectedNp(np[0]?.name ?? '') } catch (e) { setError(normalizeError(e)) }
  }

  async function loadAksTimeline() {
    if (!selectedCluster || !detail) return
    setAksTimelineLoading(true)
    setAksTimelineError('')
    try {
      const result = await listAzureMonitorActivity(subscriptionId, location, `Microsoft.ContainerService|${detail.name}`, 168)
      setAksTimelineEvents(result.events)
    } catch (error) {
      setAksTimelineEvents([])
      setAksTimelineError(error instanceof Error ? error.message : 'Failed to load activity')
    } finally {
      setAksTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (sideTab === 'timeline' && selectedCluster) void loadAksTimeline()
  }, [sideTab, selectedCluster])

  async function handleScale() {
    if (!selectedCluster || !selectedNp || !detail) return
    const mn = Number(scaleMin), dn = Number(scaleDesired), mx = Number(scaleMax)
    if (Number.isNaN(mn) || Number.isNaN(dn) || Number.isNaN(mx)) return setScaleErr('Values must be numbers')
    if (mn < 0 || dn < mn || dn > mx) return setScaleErr('Must satisfy: 0 <= min <= desired <= max')
    setScaleErr(''); setScaleBusy(true)
    try { await updateAzureAksNodePoolScaling(subscriptionId, detail.resourceGroup, selectedCluster, selectedNp, mn, dn, mx); setNodePools(await listAzureAksNodePools(subscriptionId, detail.resourceGroup, selectedCluster)); setShowScale(false); setMsg(`Scaled ${selectedNp} successfully`) } catch (e) { setScaleErr(normalizeError(e)) } finally { setScaleBusy(false) }
  }

  function openScaleForm() { setShowAutoscaleToggle(false); const p = nodePools.find((i) => i.name === selectedNp); if (p) { setScaleMin(String(p.min === '-' ? 0 : p.min)); setScaleDesired(String(p.desired === '-' ? 0 : p.desired)); setScaleMax(String(p.max === '-' ? 0 : p.max)) } setScaleErr(''); setShowScale(true) }

  function openAutoscaleToggleForm() {
    if (!selectedNodePool) return
    setShowScale(false)
    setAutoscaleToggleErr('')
    const currentDesired = String(selectedNodePool.desired === '-' ? 1 : selectedNodePool.desired)
    setAutoscaleMinInput(selectedNodePool.enableAutoScaling ? '' : currentDesired)
    setAutoscaleMaxInput(selectedNodePool.enableAutoScaling ? '' : currentDesired)
    setShowAutoscaleToggle(true)
  }

  async function handleAutoscaleToggle() {
    if (!selectedCluster || !selectedNp || !detail || !selectedNodePool) return
    const willEnable = !selectedNodePool.enableAutoScaling
    if (willEnable) {
      const mn = Number(autoscaleMinInput), mx = Number(autoscaleMaxInput)
      if (Number.isNaN(mn) || Number.isNaN(mx)) return setAutoscaleToggleErr('Min and max must be numbers')
      if (mn < 1) return setAutoscaleToggleErr('Min count must be at least 1')
      if (mn > mx) return setAutoscaleToggleErr('Min must be less than or equal to max')
      setAutoscaleToggleErr(''); setAutoscaleToggleBusy(true)
      try { await toggleAzureAksNodePoolAutoscaling(subscriptionId, detail.resourceGroup, selectedCluster, selectedNp, true, mn, mx); setNodePools(await listAzureAksNodePools(subscriptionId, detail.resourceGroup, selectedCluster)); setShowAutoscaleToggle(false); setMsg(`Enabled autoscaling on ${selectedNp} (min: ${mn}, max: ${mx})`) } catch (e) { setAutoscaleToggleErr(normalizeError(e)) } finally { setAutoscaleToggleBusy(false) }
    } else {
      setAutoscaleToggleErr(''); setAutoscaleToggleBusy(true)
      try { await toggleAzureAksNodePoolAutoscaling(subscriptionId, detail.resourceGroup, selectedCluster, selectedNp, false); setNodePools(await listAzureAksNodePools(subscriptionId, detail.resourceGroup, selectedCluster)); setShowAutoscaleToggle(false); setMsg(`Disabled autoscaling on ${selectedNp}`) } catch (e) { setAutoscaleToggleErr(normalizeError(e)) } finally { setAutoscaleToggleBusy(false) }
    }
  }

  function openKubeconfigForm() {
    if (!selectedCluster) return
    setShowKubeconfigForm(true)
    setKubeconfigContextName(selectedCluster)
    setKubeconfigLocation('.kube/config')
    setKubeconfigErr('')
  }

  async function browseKubeconfigLocation() {
    if (kubeconfigBusy) return
    setKubeconfigErr('')
    try {
      const selectedPath = await chooseAksKubeconfigPath(kubeconfigLocation)
      if (selectedPath) setKubeconfigLocation(selectedPath)
    } catch (e) {
      setKubeconfigErr(normalizeError(e))
    }
  }

  async function handleKubeconfig() {
    if (!selectedCluster || !detail) return
    const contextName = kubeconfigContextName.trim()
    const kubeconfigPath = kubeconfigLocation.trim()
    if (!contextName) return setKubeconfigErr('Context name is required')
    if (!kubeconfigPath) return setKubeconfigErr('Config location is required')
    setMsg(''); setError(''); setKubeconfigErr(''); setKubeconfigBusy(true)
    try {
      const result = await addAksToKubeconfig(subscriptionId, detail.resourceGroup, selectedCluster, contextName, kubeconfigPath)
      setMsg(result || `Added ${selectedCluster} to kubeconfig as context "${contextName}"`)
      setShowKubeconfigForm(false)
    } catch (e) {
      setKubeconfigErr(normalizeError(e))
    } finally {
      setKubeconfigBusy(false)
    }
  }

  function openKubectl() { if (!selectedCluster || !detail) return; onRunTerminalCommand(`az aks get-credentials -g "${detail.resourceGroup}" -n "${selectedCluster}" --subscription "${subscriptionId}" --overwrite-existing; Write-Host 'kubectl context ready for cluster: ${selectedCluster}'; Write-Host ''; kubectl cluster-info`); setMsg(`Opened kubectl terminal for ${selectedCluster} in the app terminal`) }
  function toggleNpCol(key: AksNodePoolCol) { setVisibleNpCols((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n }) }

  if (loading && !clusters.length) return <SvcState variant="loading" resourceName="AKS clusters" />

  return (
    <div className="eks-console azure-aks-theme">
      <section className="eks-shell-hero">
        <div className="eks-shell-hero-copy">
          <div className="eyebrow">AKS service</div>
          <h2>{detail ? detail.name : 'Kubernetes operations center'}</h2>
          <p>{detail ? `Inspect control plane posture, node pool capacity, and kubeconfig workflows for ${detail.name}.` : 'Review cluster health, drill into node pools, and move into kubectl workflows from one AKS workspace.'}</p>
          <div className="eks-shell-meta-strip">
            <div className="eks-shell-meta-pill"><span>Subscription</span><strong>{aksTrunc(subscriptionId, 28)}</strong></div>
            <div className="eks-shell-meta-pill"><span>Location</span><strong>{formatLocationHint(location)}</strong></div>
            <div className="eks-shell-meta-pill"><span>Selected cluster</span><strong>{selectedCluster || 'None selected'}</strong></div>
            <div className="eks-shell-meta-pill"><span>Access</span><strong>{aksAccess(detail)}</strong></div>
          </div>
        </div>
        <div className="eks-shell-hero-stats">
          <AksCard label="Clusters" value={clusters.length} note={`${healthyClusters} healthy in this location`} tone="success" />
          <AksCard label="Node pools" value={selectedCluster ? nodePools.length : 0} note={selectedCluster ? 'Attached to the selected cluster' : 'Select a cluster to inspect capacity'} />
          <AksCard label="Desired nodes" value={selectedCluster ? totalDesiredNodes : 0} note={selectedCluster ? 'Aggregated desired count across visible node pools' : 'No cluster selected yet'} tone="warning" />
          <AksCard label="Identity" value={detail?.identityType || '-'} note={detail?.workloadIdentityEnabled ? 'Workload identity enabled' : 'Workload identity not enabled'} />
        </div>
      </section>

      <div className="eks-shell-toolbar">
        <div className="eks-toolbar">
          <button className="eks-toolbar-btn accent" type="button" onClick={() => void reload()} disabled={loading}>Reload inventory</button>
          <button className="eks-toolbar-btn" type="button" onClick={() => setShowDescribe((c) => !c)} disabled={!selectedCluster}>{showDescribe ? 'Hide details' : 'Describe cluster'}</button>
          <button className="eks-toolbar-btn" type="button" onClick={openKubeconfigForm} disabled={!selectedCluster}>Add to kubeconfig</button>
          <button className="eks-toolbar-btn" type="button" onClick={() => { if (detail) onRunTerminalCommand(`az aks get-credentials -g "${detail.resourceGroup}" -n "${selectedCluster}" --subscription "${subscriptionId}" --overwrite-existing`) }} disabled={!selectedCluster || !canRunTerminalCommand}>Get kubeconfig</button>
          {selectedNodePool?.enableAutoScaling !== false && <button className="eks-toolbar-btn" type="button" onClick={openScaleForm} disabled={!selectedCluster || !nodePools.length}>Scale node pool</button>}
          <button className="eks-toolbar-btn" type="button" onClick={openAutoscaleToggleForm} disabled={!selectedCluster || !selectedNp}>{selectedNodePool?.enableAutoScaling ? 'Disable autoscaling' : 'Enable autoscaling'}</button>
          <button className="eks-toolbar-btn" type="button" onClick={openKubectl} disabled={!selectedCluster || !canRunTerminalCommand}>Open kubectl terminal</button>
        </div>
        <div className="eks-shell-status">
          <div className="eks-status-card"><span>Inventory</span><strong>{loading ? 'Refreshing' : `${clusters.length} clusters loaded`}</strong></div>
          <div className="eks-status-card"><span>Selection</span><strong>{selectedCluster ? aksTrunc(selectedCluster, 28) : 'Waiting for selection'}</strong></div>
          <div className="eks-status-card"><span>Mode</span><strong>{sideTab === 'overview' ? 'Capacity review' : sideTab === 'details' ? 'Cluster details' : 'Activity timeline'}</strong></div>
        </div>
      </div>

      {error && <SvcState variant="error" error={error} />}
      {msg && <div className="eks-msg">{msg}</div>}

      <div className="eks-main-layout">
        <div className="eks-project-table-area">
          <div className="eks-pane-head"><div><span className="eks-pane-kicker">Cluster inventory</span><h3>Regional clusters</h3></div><span className="eks-pane-summary">{filteredClusters.length} shown</span></div>
          <input className="eks-search-input" placeholder="Filter clusters across name, version, state, location..." value={clusterSearch} onChange={(e) => setClusterSearch(e.target.value)} />
          {filteredClusters.length === 0 ? <SvcState variant="empty" message="No clusters found for the active filters." /> : (
            <div className="eks-project-list">
              {filteredClusters.map((cluster) => (
                <button key={cluster.id} type="button" className={`eks-project-row ${cluster.name === selectedCluster ? 'active' : ''}`} onClick={() => void doSelect(cluster)}>
                  <div className="eks-project-row-top"><div className="eks-project-row-copy"><strong>{cluster.name}</strong><span title={cluster.resourceGroup}>{cluster.resourceGroup} | {cluster.location}</span></div><AksBadge status={cluster.provisioningState} /></div>
                  <div className="eks-project-row-meta"><span>Kubernetes {cluster.kubernetesVersion}</span><span>{cluster.location}</span></div>
                  <div className="eks-project-row-metrics"><div><span>Nodes</span><strong>{cluster.nodeCount}</strong></div><div><span>Node pools</span><strong>{cluster.nodePoolCount}</strong></div><div><span>Network</span><strong>{cluster.privateCluster ? 'Private' : 'Public'}</strong></div></div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="eks-detail-pane">
          {!detail ? <SvcState variant="no-selection" resourceName="cluster" message="Select a cluster to view AKS details." /> : (
            <>
              <section className="eks-detail-hero">
                <div className="eks-detail-hero-copy">
                  <div className="eyebrow">Cluster posture</div>
                  <h3>{detail.name}</h3>
                  <p>{detail.privateCluster ? aksTrunc(detail.privateFqdn, 88) : aksTrunc(detail.fqdn, 88)}</p>
                  <div className="eks-detail-meta-strip">
                    <div className="eks-detail-meta-pill"><span>State</span><strong>{detail.provisioningState}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Version</span><strong>{detail.kubernetesVersion}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Power</span><strong>{detail.powerState}</strong></div>
                    <div className="eks-detail-meta-pill"><span>Network</span><strong>{detail.networkPlugin}</strong></div>
                  </div>
                </div>
                <div className="eks-detail-hero-stats">
                  <AksCard label="API access" value={aksAccess(detail)} note={detail.privateCluster ? 'Private endpoint only' : 'Public endpoint available'} tone={detail.privateCluster ? 'success' : 'warning'} />
                  <AksCard label="Node pools" value={nodePools.length} note={selectedNodePool ? `${selectedNodePool.name} selected` : 'No node pools found'} />
                  <AksCard label="Add-ons" value={detail.loggingEnabled.length || 0} note={detail.loggingEnabled.length ? detail.loggingEnabled.join(', ') : 'No active add-ons detected'} tone={detail.loggingEnabled.length ? 'info' : 'danger'} />
                  <AksCard label="Created" value={aksFmt(detail.createdAt)} note="Cluster creation time" />
                </div>
              </section>

              <div className="eks-detail-tabs">
                <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>Overview</button>
                <button className={sideTab === 'details' ? 'active' : ''} type="button" onClick={() => setSideTab('details')}>Cluster details</button>
                <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>Activity Timeline</button>
              </div>

              {sideTab === 'overview' && (
                <section className="eks-section eks-nodegroups-section">
                  {showDescribe && (
                    <section className="eks-section eks-cluster-details-panel">
                      <div className="eks-section-head"><div><span className="eks-section-kicker">Describe</span><h4>Cluster details</h4></div><span className="eks-section-hint">Detailed control plane and networking configuration for the selected cluster.</span></div>
                      <div className="eks-kv">
                        <AksKv label="FQDN" value={detail.fqdn} /><AksKv label="Private FQDN" value={detail.privateFqdn} /><AksKv label="DNS prefix" value={detail.dnsPrefix} />
                        <AksKv label="Node resource group" value={detail.nodeResourceGroup} /><AksKv label="OIDC issuer" value={detail.oidcIssuerUrl} /><AksKv label="Identity type" value={detail.identityType} />
                        <AksKv label="Network plugin" value={detail.networkPlugin} /><AksKv label="Network policy" value={detail.networkPolicy} /><AksKv label="Service CIDR" value={detail.serviceCidr} />
                        <AksKv label="DNS service IP" value={detail.dnsServiceIp} /><AksKv label="Pod CIDR" value={detail.podCidr} /><AksKv label="Load balancer SKU" value={detail.loadBalancerSku} />
                        <AksKv label="Outbound type" value={detail.outboundType} /><AksKv label="RBAC enabled" value={detail.enableRbac ? 'Yes' : 'No'} /><AksKv label="Workload identity" value={detail.workloadIdentityEnabled ? 'Enabled' : 'Disabled'} />
                        <AksKv label="Tags" value={Object.entries(detail.tags).map(([k, v]) => `${k}=${v}`).join(', ') || '-'} />
                      </div>
                    </section>
                  )}
                  <section className="eks-section">
                    <div className="eks-section-head"><div><span className="eks-section-kicker">Operations</span><h4>Cluster actions</h4></div><span className="eks-section-hint">Actions operate on the selected cluster and its node pools.</span></div>
                    <div className="eks-action-grid">
                      <button type="button" className="eks-action-btn accent" onClick={openKubeconfigForm}>Add to kubeconfig</button>
                      <button type="button" className="eks-action-btn" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az aks get-credentials -g "${detail.resourceGroup}" -n "${selectedCluster}" --subscription "${subscriptionId}" --overwrite-existing`)}>Get kubeconfig</button>
                      {selectedNodePool?.enableAutoScaling !== false && <button type="button" className="eks-action-btn" onClick={openScaleForm} disabled={!nodePools.length}>Scale node pool</button>}
                      <button type="button" className="eks-action-btn" onClick={openAutoscaleToggleForm} disabled={!nodePools.length}>{selectedNodePool?.enableAutoScaling ? 'Disable autoscaling' : 'Enable autoscaling'}</button>
                      <button type="button" className="eks-action-btn" onClick={openKubectl} disabled={!canRunTerminalCommand}>Open kubectl terminal</button>
                      <button type="button" className="eks-action-btn" onClick={() => onOpenMonitor('Microsoft.ContainerService managedClusters')}>Open monitor</button>
                    </div>
                    {showScale && (
                      <section className="eks-inline-panel eks-scale-inline-panel">
                        <div className="eks-section-head"><div><span className="eks-section-kicker">Scaling</span><h4>Scale node pool</h4></div><button type="button" className="eks-toolbar-btn" onClick={() => setShowScale(false)} disabled={scaleBusy}>Close</button></div>
                        <div className="eks-scale-form">
                          <label>Node pool<select value={selectedNp} onChange={(e) => { setSelectedNp(e.target.value); const p = nodePools.find((i) => i.name === e.target.value); if (p) { setScaleMin(String(p.min === '-' ? 0 : p.min)); setScaleDesired(String(p.desired === '-' ? 0 : p.desired)); setScaleMax(String(p.max === '-' ? 0 : p.max)) } }}>{nodePools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
                          <label>Min<input type="number" value={scaleMin} onChange={(e) => setScaleMin(e.target.value)} /></label>
                          <label>Desired<input type="number" value={scaleDesired} onChange={(e) => setScaleDesired(e.target.value)} /></label>
                          <label>Max<input type="number" value={scaleMax} onChange={(e) => setScaleMax(e.target.value)} /></label>
                          <button type="button" className="eks-toolbar-btn accent" disabled={scaleBusy} onClick={() => void handleScale()}>{scaleBusy ? 'Applying...' : 'Apply scale change'}</button>
                        </div>
                        {scaleErr && <div className="eks-inline-error">{scaleErr}</div>}
                      </section>
                    )}
                    {showAutoscaleToggle && selectedNodePool && (
                      <section className="eks-inline-panel eks-scale-inline-panel">
                        <div className="eks-section-head"><div><span className="eks-section-kicker">Autoscaling</span><h4>{selectedNodePool.enableAutoScaling ? 'Disable' : 'Enable'} autoscaling</h4></div><button type="button" className="eks-toolbar-btn" onClick={() => setShowAutoscaleToggle(false)} disabled={autoscaleToggleBusy}>Close</button></div>
                        <div className="eks-scale-form">
                          <label>Node pool<select value={selectedNp} onChange={(e) => { setSelectedNp(e.target.value); const p = nodePools.find((i) => i.name === e.target.value); if (p) { const d = String(p.desired === '-' ? 1 : p.desired); setAutoscaleMinInput(p.enableAutoScaling ? '' : d); setAutoscaleMaxInput(p.enableAutoScaling ? '' : d) } }}>{nodePools.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.enableAutoScaling ? 'autoscaling on' : 'autoscaling off'})</option>)}</select></label>
                          {!selectedNodePool.enableAutoScaling && (
                            <>
                              <label>Min count<input type="number" value={autoscaleMinInput} onChange={(e) => setAutoscaleMinInput(e.target.value)} min={1} /></label>
                              <label>Max count<input type="number" value={autoscaleMaxInput} onChange={(e) => setAutoscaleMaxInput(e.target.value)} min={1} /></label>
                            </>
                          )}
                          <p style={{ margin: '0.5rem 0', opacity: 0.7, fontSize: '0.85rem' }}>{selectedNodePool.enableAutoScaling ? `Disabling autoscaling will fix the node count at the current desired value (${selectedNodePool.desired}). The cluster autoscaler will no longer manage this pool.` : 'Enabling autoscaling allows the cluster autoscaler to adjust node count between the specified min and max bounds.'}</p>
                          <button type="button" className="eks-toolbar-btn accent" disabled={autoscaleToggleBusy} onClick={() => void handleAutoscaleToggle()}>{autoscaleToggleBusy ? 'Applying...' : (selectedNodePool.enableAutoScaling ? 'Disable autoscaling' : 'Enable autoscaling')}</button>
                        </div>
                        {autoscaleToggleErr && <div className="eks-inline-error">{autoscaleToggleErr}</div>}
                      </section>
                    )}
                  </section>
                  <div className="eks-section-head"><div><span className="eks-section-kicker">Capacity</span><h4>Node pool inventory</h4></div><span className="eks-section-hint">{filteredNodePools.length} node pools match the active filters.</span></div>
                  <input className="eks-search-input" placeholder="Filter node pools across selected columns..." value={npSearch} onChange={(e) => setNpSearch(e.target.value)} />
                  <div className="eks-column-chips">
                    {AKS_NODEPOOL_COLUMNS.map((col) => (<button key={col.key} className={`eks-chip ${visibleNpCols.has(col.key) ? 'active' : ''}`} type="button" style={visibleNpCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#08111b' } : undefined} onClick={() => toggleNpCol(col.key)}>{col.label}</button>))}
                  </div>
                  <div className="eks-nodegroup-layout">
                    <div className="eks-table-shell"><div className="eks-ng-scroll">
                      <table className="eks-data-table">
                        <thead><tr>{activeNpCols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                        <tbody>
                          {!filteredNodePools.length && <tr><td colSpan={activeNpCols.length} className="eks-table-empty">{selectedCluster ? 'No node pools found.' : 'Select a cluster.'}</td></tr>}
                          {filteredNodePools.map((pool) => (<tr key={pool.name} className={pool.name === selectedNp ? 'active' : ''} onClick={() => setSelectedNp(pool.name)}>{activeNpCols.map((c) => <td key={c.key}>{c.key === 'status' ? <AksBadge status={pool.status} /> : getAksNpVal(pool, c.key)}</td>)}</tr>))}
                        </tbody>
                      </table>
                    </div></div>
                    <aside className="eks-side-card">
                      <div className="eks-section-head"><div><span className="eks-section-kicker">Selection</span><h4>{selectedNodePool?.name || 'Node pool details'}</h4></div></div>
                      {selectedNodePool ? (
                        <>
                          <div className="eks-side-card-grid">
                            <AksCard label="Desired" value={selectedNodePool.desired} note="Current desired capacity" tone="warning" />
                            <AksCard label="Min" value={selectedNodePool.min} note={selectedNodePool.enableAutoScaling ? 'Lower autoscaling bound' : 'Autoscaling disabled'} />
                            <AksCard label="Max" value={selectedNodePool.max} note={selectedNodePool.enableAutoScaling ? 'Upper autoscaling bound' : 'Autoscaling disabled'} />
                            <AksCard label="Status" value={selectedNodePool.status} note="Latest node pool lifecycle state" tone={aksStatusTone(selectedNodePool.status)} />
                          </div>
                          <div className="eks-mini-kv">
                            <AksKv label="VM size" value={selectedNodePool.vmSize} />
                            <AksKv label="OS type" value={`${selectedNodePool.osType} (${selectedNodePool.osSku})`} />
                            <AksKv label="Availability zones" value={selectedNodePool.availabilityZones.join(', ') || 'None'} />
                            <AksKv label="Max pods" value={String(selectedNodePool.maxPods)} />
                            <AksKv label="OS disk" value={`${selectedNodePool.osDiskSizeGb} GB (${selectedNodePool.osDiskType})`} />
                            <AksKv label="Mode" value={selectedNodePool.mode} />
                            <AksKv label="Autoscaling" value={selectedNodePool.enableAutoScaling ? 'Enabled' : 'Disabled'} />
                            <AksKv label="Labels" value={Object.entries(selectedNodePool.nodeLabels).map(([k, v]) => `${k}=${v}`).join(', ') || 'None'} />
                            <AksKv label="Taints" value={selectedNodePool.nodeTaints.join(', ') || 'None'} />
                          </div>
                        </>
                      ) : <SvcState variant="empty" resourceName="node pool" compact />}
                    </aside>
                  </div>
                </section>
              )}
              {sideTab === 'details' && (
                <section className="eks-section">
                  <div className="eks-section-head"><div><span className="eks-section-kicker">Configuration</span><h4>Full cluster configuration</h4></div><span className="eks-section-hint">Complete cluster networking, identity, and operational configuration.</span></div>
                  <div className="eks-planner-summary">
                    <div className="eks-side-card">
                      <div className="eks-section-head"><div><span className="eks-section-kicker">Identity &amp; Security</span><h4>Access posture</h4></div></div>
                      <div className="eks-side-card-grid">
                        <AksCard label="Identity" value={detail.identityType} note="Cluster identity type" />
                        <AksCard label="Workload ID" value={detail.workloadIdentityEnabled ? 'Enabled' : 'Disabled'} note="Workload identity federation" tone={detail.workloadIdentityEnabled ? 'success' : 'info'} />
                        <AksCard label="OIDC issuer" value={detail.oidcIssuerEnabled ? 'Enabled' : 'Disabled'} note="OIDC issuer profile" tone={detail.oidcIssuerEnabled ? 'success' : 'info'} />
                        <AksCard label="RBAC" value={detail.enableRbac ? 'Enabled' : 'Disabled'} note="Kubernetes RBAC enforcement" tone={detail.enableRbac ? 'success' : 'danger'} />
                      </div>
                      <div className="eks-mini-kv"><AksKv label="OIDC issuer URL" value={detail.oidcIssuerUrl} /><AksKv label="API access" value={detail.privateCluster ? 'Private cluster' : 'Public cluster'} /></div>
                    </div>
                    <div className="eks-side-card">
                      <div className="eks-section-head"><div><span className="eks-section-kicker">Networking</span><h4>Network configuration</h4></div></div>
                      <div className="eks-side-card-grid">
                        <AksCard label="Plugin" value={detail.networkPlugin} note="CNI network plugin" />
                        <AksCard label="Policy" value={detail.networkPolicy} note="Network policy engine" />
                        <AksCard label="LB SKU" value={detail.loadBalancerSku} note="Load balancer tier" />
                        <AksCard label="Outbound" value={detail.outboundType} note="Egress routing type" />
                      </div>
                      <div className="eks-mini-kv"><AksKv label="Service CIDR" value={detail.serviceCidr} /><AksKv label="DNS service IP" value={detail.dnsServiceIp} /><AksKv label="Pod CIDR" value={detail.podCidr} /><AksKv label="FQDN" value={detail.fqdn} /><AksKv label="Private FQDN" value={detail.privateFqdn} /></div>
                    </div>
                  </div>
                  <section className="eks-section">
                    <div className="eks-section-head"><div><span className="eks-section-kicker">Handoff commands</span><h4>CLI snippets</h4></div><span className="eks-section-hint">Terminal commands for common AKS operations on this cluster.</span></div>
                    <div className="eks-planner-card-grid">
                      {[
                        { label: 'Get credentials', shell: 'az-cli', desc: 'Merge AKS cluster credentials into your local kubeconfig.', cmd: `az aks get-credentials -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}" --overwrite-existing` },
                        { label: 'Cluster info', shell: 'az-cli', desc: 'Show detailed cluster information from Azure.', cmd: `az aks show -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}" -o jsonc` },
                        { label: 'Available upgrades', shell: 'az-cli', desc: 'List available Kubernetes version upgrades for this cluster.', cmd: `az aks get-upgrades -g "${detail.resourceGroup}" -n "${detail.name}" --subscription "${subscriptionId}" -o table` },
                        { label: 'Node pool list', shell: 'az-cli', desc: 'List all node pools for this managed cluster.', cmd: `az aks nodepool list -g "${detail.resourceGroup}" --cluster-name "${detail.name}" --subscription "${subscriptionId}" -o table` },
                        { label: 'kubectl cluster-info', shell: 'kubectl', desc: 'Display addresses of the control plane and services.', cmd: 'kubectl cluster-info' },
                        { label: 'kubectl get nodes', shell: 'kubectl', desc: 'List all nodes in the current cluster context.', cmd: 'kubectl get nodes -o wide' }
                      ].map((h) => (
                        <article key={h.label} className="eks-planner-card">
                          <div className="eks-project-row-top"><strong>{h.label}</strong><AksBadge status={h.shell} /></div>
                          <p>{h.desc}</p>
                          <pre className="eks-command-block"><code>{h.cmd}</code></pre>
                          <div className="eks-inline-actions">
                            <button className="eks-toolbar-btn" type="button" onClick={() => { void navigator.clipboard.writeText(h.cmd) }}>Copy command</button>
                            <button className="eks-toolbar-btn" type="button" onClick={() => onRunTerminalCommand(h.cmd)} disabled={!canRunTerminalCommand}>Run in terminal</button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                </section>
              )}
              {sideTab === 'timeline' && (
                <section className="eks-section">
                  <div className="eks-section-head">
                    <div><span className="eks-section-kicker">Azure Monitor</span><h4>Activity timeline</h4></div>
                    <span className="eks-section-hint">Management-plane events for <strong>{detail?.name ?? selectedCluster}</strong> from the last 7 days.</span>
                  </div>
                  {!selectedCluster && <SvcState variant="empty" resourceName="cluster" compact />}
                  {selectedCluster && aksTimelineLoading && <SvcState variant="loading" resourceName="activity events" compact />}
                  {selectedCluster && !aksTimelineLoading && aksTimelineError && <div className="eks-inline-error">{aksTimelineError}</div>}
                  {selectedCluster && !aksTimelineLoading && !aksTimelineError && aksTimelineEvents.length === 0 && <SvcState variant="empty" message="No Azure Monitor events found for this cluster." />}
                  {selectedCluster && !aksTimelineLoading && aksTimelineEvents.length > 0 && (
                    <div className="eks-table-shell">
                      <div className="eks-ng-scroll">
                        <table className="eks-data-table">
                          <thead><tr><th>Operation</th><th>Status</th><th>Caller</th><th>Time</th></tr></thead>
                          <tbody>
                            {aksTimelineEvents.map((event) => (
                              <tr key={event.id}>
                                <td title={event.resourceType}>{event.operationName}</td>
                                <td>{event.status}</td>
                                <td>{event.caller}</td>
                                <td>{event.timestamp ? new Date(event.timestamp).toLocaleString() : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {showKubeconfigForm && (
        <div className="eks-modal-backdrop" onClick={() => { if (!kubeconfigBusy) setShowKubeconfigForm(false) }}>
          <section className="eks-modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="eks-section-head">
              <div><span className="eks-section-kicker">Kubeconfig</span><h4>Add selected cluster</h4></div>
            </div>
            <div className="eks-form-grid">
              <label>Context name<input value={kubeconfigContextName} onChange={(event) => setKubeconfigContextName(event.target.value)} placeholder="my-aks-context" autoFocus /></label>
              <label>
                Config location
                <div className="eks-picker-field">
                  <input value={kubeconfigLocation} placeholder=".kube/config" readOnly />
                  <button type="button" className="eks-toolbar-btn" onClick={() => void browseKubeconfigLocation()} disabled={kubeconfigBusy}>Browse</button>
                </div>
              </label>
            </div>
            <div className="eks-inline-actions">
              <button type="button" className="eks-toolbar-btn" onClick={() => setShowKubeconfigForm(false)} disabled={kubeconfigBusy}>Cancel</button>
              <button type="button" className="eks-toolbar-btn accent" onClick={() => void handleKubeconfig()} disabled={kubeconfigBusy}>{kubeconfigBusy ? 'Adding...' : 'Add to kubeconfig'}</button>
            </div>
            {kubeconfigErr && <div className="eks-inline-error">{kubeconfigErr}</div>}
          </section>
        </div>
      )}
    </div>
  )
}
