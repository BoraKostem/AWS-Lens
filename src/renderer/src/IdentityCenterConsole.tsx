import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  createSsoInstance,
  deleteSsoInstance,
  listSsoGroups,
  listSsoInstances,
  listSsoPermissionSets,
  listSsoUsers,
  simulateSsoPermissions
} from './api'
import './identity-center.css'
import type {
  AwsConnection,
  SsoGroupSummary,
  SsoInstanceSummary,
  SsoPermissionSetSummary,
  SsoSimulationResult,
  SsoUserSummary
} from '@shared/types'

type SsoTab = 'users' | 'groups' | 'permissions' | 'simulate'
type UserColKey = 'userName' | 'displayName' | 'email' | 'userId'
type GroupColKey = 'displayName' | 'description' | 'groupId'
type PsColKey = 'name' | 'description' | 'sessionDuration' | 'createdDate'

const USER_COLUMNS: Array<{ key: UserColKey; label: string }> = [
  { key: 'userName', label: 'Username' },
  { key: 'displayName', label: 'Display Name' },
  { key: 'email', label: 'Email' },
  { key: 'userId', label: 'User ID' }
]

const GROUP_COLUMNS: Array<{ key: GroupColKey; label: string }> = [
  { key: 'displayName', label: 'Group Name' },
  { key: 'description', label: 'Description' },
  { key: 'groupId', label: 'Group ID' }
]

const PS_COLUMNS: Array<{ key: PsColKey; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'sessionDuration', label: 'Session Duration' },
  { key: 'createdDate', label: 'Created' }
]

function shorten(value: string, start = 16, end = 8) {
  if (!value) return '-'
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function formatDate(value: string) {
  if (!value || value === '-') return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function getUserValue(user: SsoUserSummary, key: UserColKey) {
  if (key === 'userName') return user.userName
  if (key === 'displayName') return user.displayName
  if (key === 'email') return user.email || '-'
  return shorten(user.userId, 16, 0)
}

function getGroupValue(group: SsoGroupSummary, key: GroupColKey) {
  if (key === 'displayName') return group.displayName
  if (key === 'description') return group.description || '-'
  return shorten(group.groupId, 16, 0)
}

function getPermissionSetValue(permissionSet: SsoPermissionSetSummary, key: PsColKey) {
  if (key === 'name') return permissionSet.name
  if (key === 'description') return permissionSet.description || '-'
  if (key === 'sessionDuration') return permissionSet.sessionDuration
  return formatDate(permissionSet.createdDate)
}

export function IdentityCenterConsole({ connection }: { connection: AwsConnection }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [instances, setInstances] = useState<SsoInstanceSummary[]>([])
  const [selectedInstance, setSelectedInstance] = useState<SsoInstanceSummary | null>(null)
  const [createName, setCreateName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [users, setUsers] = useState<SsoUserSummary[]>([])
  const [groups, setGroups] = useState<SsoGroupSummary[]>([])
  const [permissionSets, setPermissionSets] = useState<SsoPermissionSetSummary[]>([])
  const [activeTab, setActiveTab] = useState<SsoTab>('users')
  const [userFilter, setUserFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [psFilter, setPsFilter] = useState('')
  const [userVisCols, setUserVisCols] = useState<Set<UserColKey>>(() => new Set(USER_COLUMNS.map((column) => column.key)))
  const [groupVisCols, setGroupVisCols] = useState<Set<GroupColKey>>(() => new Set(GROUP_COLUMNS.map((column) => column.key)))
  const [psVisCols, setPsVisCols] = useState<Set<PsColKey>>(() => new Set(PS_COLUMNS.map((column) => column.key)))
  const [simTarget, setSimTarget] = useState('')
  const [simResult, setSimResult] = useState<SsoSimulationResult | null>(null)
  const [simLoading, setSimLoading] = useState(false)

  async function loadInstances() {
    setLoading(true)
    setError('')
    try {
      const next = await listSsoInstances(connection)
      setInstances(next)
      if (next.length === 1 && !selectedInstance) {
        await selectInstance(next[0])
      } else if (selectedInstance) {
        const refreshed = next.find((instance) => instance.instanceArn === selectedInstance.instanceArn)
        if (refreshed) await selectInstance(refreshed)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function selectInstance(instance: SsoInstanceSummary) {
    setSelectedInstance(instance)
    setLoading(true)
    setError('')
    setSimResult(null)
    setSimTarget('')
    try {
      const [nextUsers, nextGroups, nextPermissionSets] = await Promise.all([
        listSsoUsers(connection, instance.identityStoreId),
        listSsoGroups(connection, instance.identityStoreId),
        listSsoPermissionSets(connection, instance.instanceArn)
      ])
      setUsers(nextUsers)
      setGroups(nextGroups)
      setPermissionSets(nextPermissionSets)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateInstance() {
    if (!createName.trim()) return
    setError('')
    try {
      await createSsoInstance(connection, createName.trim())
      setCreateName('')
      setShowCreate(false)
      setMsg('Instance created')
      await loadInstances()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleDeleteInstance(instanceArn: string) {
    setError('')
    try {
      await deleteSsoInstance(connection, instanceArn)
      setMsg('Instance disabled')
      const next = await listSsoInstances(connection)
      setInstances(next)
      if (selectedInstance?.instanceArn === instanceArn) {
        setSelectedInstance(null)
        setUsers([])
        setGroups([])
        setPermissionSets([])
        setSimResult(null)
        setSimTarget('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleSimulate() {
    if (!selectedInstance || !simTarget) return
    setSimLoading(true)
    setError('')
    setSimResult(null)
    try {
      const result = await simulateSsoPermissions(connection, selectedInstance.instanceArn, simTarget)
      setSimResult(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSimLoading(false)
    }
  }

  useEffect(() => {
    void loadInstances()
  }, [connection.sessionId, connection.region])

  const activeUserCols = USER_COLUMNS.filter((column) => userVisCols.has(column.key))
  const activeGroupCols = GROUP_COLUMNS.filter((column) => groupVisCols.has(column.key))
  const activePsCols = PS_COLUMNS.filter((column) => psVisCols.has(column.key))

  const filteredUsers = useMemo(() => {
    if (!userFilter.trim()) return users
    const query = userFilter.toLowerCase()
    return users.filter((user) => activeUserCols.some((column) => getUserValue(user, column.key).toLowerCase().includes(query)))
  }, [activeUserCols, userFilter, users])

  const filteredGroups = useMemo(() => {
    if (!groupFilter.trim()) return groups
    const query = groupFilter.toLowerCase()
    return groups.filter((group) => activeGroupCols.some((column) => getGroupValue(group, column.key).toLowerCase().includes(query)))
  }, [activeGroupCols, groupFilter, groups])

  const filteredPermissionSets = useMemo(() => {
    if (!psFilter.trim()) return permissionSets
    const query = psFilter.toLowerCase()
    return permissionSets.filter((permissionSet) =>
      activePsCols.some((column) => getPermissionSetValue(permissionSet, column.key).toLowerCase().includes(query))
    )
  }, [activePsCols, permissionSets, psFilter])

  const detailStats = selectedInstance ? [
    { label: 'Instance status', value: selectedInstance.status, note: selectedInstance.ownerAccountId, tone: selectedInstance.status.toLowerCase() === 'active' ? 'success' : 'warning' },
    { label: 'Users', value: String(users.length), note: 'Identity store members', tone: 'info' },
    { label: 'Groups', value: String(groups.length), note: 'Directory groups', tone: 'info' },
    { label: 'Permission sets', value: String(permissionSets.length), note: 'Assignable access profiles', tone: 'info' }
  ] : []

  function toggleVisible<T>(key: T, setter: Dispatch<SetStateAction<Set<T>>>) {
    setter((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="ic-console">
      <section className="ic-shell-hero">
        <div className="ic-shell-hero-copy">
          <div className="eyebrow">Identity Center</div>
          <h2>Directory operations with the Terraform page system</h2>
          <p>Manage SSO instances, identity-store objects, permission sets, and effective access from a denser split-pane workspace.</p>
          <div className="ic-shell-meta-strip">
            <div className="ic-shell-meta-pill"><span>Connection</span><strong>{connection.kind === 'profile' ? connection.profile : connection.sessionId}</strong></div>
            <div className="ic-shell-meta-pill"><span>Region</span><strong>{connection.region || 'Global'}</strong></div>
            <div className="ic-shell-meta-pill"><span>Inventory</span><strong>{instances.length} instances tracked</strong></div>
          </div>
        </div>
        <div className="ic-shell-hero-stats">
          <div className="ic-shell-stat-card ic-shell-stat-card-accent"><span>Instances</span><strong>{instances.length}</strong><small>Identity Center control planes</small></div>
          <div className="ic-shell-stat-card"><span>Users</span><strong>{users.length}</strong><small>Loaded for the selected store</small></div>
          <div className="ic-shell-stat-card"><span>Groups</span><strong>{groups.length}</strong><small>Directory group objects</small></div>
          <div className="ic-shell-stat-card"><span>Permission Sets</span><strong>{permissionSets.length}</strong><small>Profiles available for simulation</small></div>
        </div>
      </section>

      <div className="ic-toolbar">
        <div className="ic-toolbar-actions">
          <button type="button" className="tf-toolbar-btn" onClick={() => setShowCreate((current) => !current)}>{showCreate ? 'Cancel Create' : 'Create Instance'}</button>
          <button type="button" className="tf-toolbar-btn accent" onClick={() => void loadInstances()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh Inventory'}</button>
          {selectedInstance ? <button type="button" className="tf-toolbar-btn danger" onClick={() => void handleDeleteInstance(selectedInstance.instanceArn)}>Disable Selected</button> : null}
        </div>
        <div className="ic-toolbar-status">
          {msg ? <div className="tf-msg">{msg}</div> : null}
          {error ? <div className="tf-msg error">{error}</div> : null}
        </div>
      </div>

      {showCreate ? (
        <section className="ic-inline-create">
          <div className="ic-pane-head"><div><span className="ic-pane-kicker">New instance</span><h3>Create an Identity Center instance</h3></div></div>
          <div className="ic-inline-form">
            <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Instance name" />
            <button type="button" className="tf-toolbar-btn accent" onClick={() => void handleCreateInstance()}>Create</button>
          </div>
        </section>
      ) : null}

      <div className="ic-main-layout">
        <aside className="ic-project-table-area">
          <div className="ic-pane-head">
            <div><span className="ic-pane-kicker">Tracked instances</span><h3>Instance inventory</h3></div>
            <span className="ic-pane-summary">{instances.length} total</span>
          </div>
          {instances.length === 0 && !loading ? <div className="ic-empty">No SSO instances found. Create one to begin managing users, groups, and permission sets.</div> : null}
          <div className="ic-project-list">
            {instances.map((instance) => (
              <button key={instance.instanceArn} type="button" className={`ic-project-row ${selectedInstance?.instanceArn === instance.instanceArn ? 'active' : ''}`} onClick={() => void selectInstance(instance)}>
                <div className="ic-project-row-top">
                  <div className="ic-project-row-copy">
                    <strong>{instance.name || 'Default Instance'}</strong>
                    <span title={instance.instanceArn}>{shorten(instance.instanceArn, 18, 10)}</span>
                  </div>
                  <span className={`tf-status-badge ${instance.status.toLowerCase() === 'active' ? 'success' : 'warning'}`}>{instance.status}</span>
                </div>
                <div className="ic-project-row-meta">
                  <span>{shorten(instance.identityStoreId, 14, 0)}</span>
                  <span>{instance.ownerAccountId}</span>
                </div>
                <div className="ic-project-row-metrics">
                  <div><span>Users</span><strong>{selectedInstance?.instanceArn === instance.instanceArn ? users.length : '-'}</strong></div>
                  <div><span>Groups</span><strong>{selectedInstance?.instanceArn === instance.instanceArn ? groups.length : '-'}</strong></div>
                  <div><span>Permission Sets</span><strong>{selectedInstance?.instanceArn === instance.instanceArn ? permissionSets.length : '-'}</strong></div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="ic-detail-pane">
          {!selectedInstance ? (
            <div className="ic-empty ic-empty-large">{instances.length > 0 ? 'Select an SSO instance to inspect users, groups, permission sets, and effective access.' : 'No active Identity Center instance is selected.'}</div>
          ) : (
            <>
              <section className="ic-detail-hero">
                <div className="ic-detail-hero-copy">
                  <div className="eyebrow">Instance posture</div>
                  <h3>{selectedInstance.name || 'Default Instance'}</h3>
                  <p>{selectedInstance.instanceArn}</p>
                  <div className="ic-detail-meta-strip">
                    <div className="ic-detail-meta-pill"><span>Identity Store</span><strong>{selectedInstance.identityStoreId}</strong></div>
                    <div className="ic-detail-meta-pill"><span>Owner Account</span><strong>{selectedInstance.ownerAccountId}</strong></div>
                    <div className="ic-detail-meta-pill"><span>Status</span><strong>{selectedInstance.status}</strong></div>
                  </div>
                </div>
                <div className="ic-detail-hero-stats">
                  {detailStats.map((stat) => (
                    <div key={stat.label} className={`ic-detail-stat-card ${stat.tone}`}>
                      <span>{stat.label}</span>
                      <strong>{stat.value}</strong>
                      <small>{stat.note}</small>
                    </div>
                  ))}
                </div>
              </section>

              <div className="ic-detail-tabs">
                <button className={activeTab === 'users' ? 'active' : ''} onClick={() => setActiveTab('users')}>Users</button>
                <button className={activeTab === 'groups' ? 'active' : ''} onClick={() => setActiveTab('groups')}>Groups</button>
                <button className={activeTab === 'permissions' ? 'active' : ''} onClick={() => setActiveTab('permissions')}>Permission Sets</button>
                <button className={activeTab === 'simulate' ? 'active' : ''} onClick={() => setActiveTab('simulate')}>Simulate</button>
              </div>

              {activeTab === 'users' ? (
                <section className="ic-section">
                  <div className="ic-section-head"><div><span className="ic-pane-kicker">Directory users</span><h3>User inventory</h3></div><span className="ic-section-summary">Showing {filteredUsers.length} of {users.length}</span></div>
                  <input className="ic-search" placeholder="Filter users across visible columns..." value={userFilter} onChange={(event) => setUserFilter(event.target.value)} />
                  <div className="ic-filter-pills">{USER_COLUMNS.map((column) => <button key={column.key} type="button" className={`ic-filter-pill ${userVisCols.has(column.key) ? 'active' : ''}`} onClick={() => toggleVisible(column.key, setUserVisCols)}>{column.label}</button>)}</div>
                  <div className="ic-table-shell"><div className="ic-table-wrap"><table className="ic-table"><thead><tr>{activeUserCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={activeUserCols.length}>Gathering users...</td></tr> : filteredUsers.map((user) => <tr key={user.userId}>{activeUserCols.map((column) => <td key={column.key}>{getUserValue(user, column.key)}</td>)}</tr>)}</tbody></table></div>{!loading && filteredUsers.length === 0 ? <div className="ic-empty">No users found for the current filter.</div> : null}</div>
                </section>
              ) : null}

              {activeTab === 'groups' ? (
                <section className="ic-section">
                  <div className="ic-section-head"><div><span className="ic-pane-kicker">Directory groups</span><h3>Group inventory</h3></div><span className="ic-section-summary">Showing {filteredGroups.length} of {groups.length}</span></div>
                  <input className="ic-search" placeholder="Filter groups across visible columns..." value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} />
                  <div className="ic-filter-pills">{GROUP_COLUMNS.map((column) => <button key={column.key} type="button" className={`ic-filter-pill ${groupVisCols.has(column.key) ? 'active' : ''}`} onClick={() => toggleVisible(column.key, setGroupVisCols)}>{column.label}</button>)}</div>
                  <div className="ic-table-shell"><div className="ic-table-wrap"><table className="ic-table"><thead><tr>{activeGroupCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={activeGroupCols.length}>Gathering groups...</td></tr> : filteredGroups.map((group) => <tr key={group.groupId}>{activeGroupCols.map((column) => <td key={column.key}>{getGroupValue(group, column.key)}</td>)}</tr>)}</tbody></table></div>{!loading && filteredGroups.length === 0 ? <div className="ic-empty">No groups found for the current filter.</div> : null}</div>
                </section>
              ) : null}

              {activeTab === 'permissions' ? (
                <section className="ic-section">
                  <div className="ic-section-head"><div><span className="ic-pane-kicker">Access profiles</span><h3>Permission sets</h3></div><span className="ic-section-summary">Showing {filteredPermissionSets.length} of {permissionSets.length}</span></div>
                  <input className="ic-search" placeholder="Filter permission sets across visible columns..." value={psFilter} onChange={(event) => setPsFilter(event.target.value)} />
                  <div className="ic-filter-pills">{PS_COLUMNS.map((column) => <button key={column.key} type="button" className={`ic-filter-pill ${psVisCols.has(column.key) ? 'active' : ''}`} onClick={() => toggleVisible(column.key, setPsVisCols)}>{column.label}</button>)}</div>
                  <div className="ic-table-shell"><div className="ic-table-wrap"><table className="ic-table"><thead><tr>{activePsCols.map((column) => <th key={column.key}>{column.label}</th>)}<th>Actions</th></tr></thead><tbody>{loading ? <tr><td colSpan={activePsCols.length + 1}>Gathering permission sets...</td></tr> : filteredPermissionSets.map((permissionSet) => <tr key={permissionSet.permissionSetArn}>{activePsCols.map((column) => <td key={column.key}>{getPermissionSetValue(permissionSet, column.key)}</td>)}<td className="ic-table-action-cell"><button type="button" className="tf-toolbar-btn" onClick={() => { setSimTarget(permissionSet.permissionSetArn); setActiveTab('simulate') }}>Simulate</button></td></tr>)}</tbody></table></div>{!loading && filteredPermissionSets.length === 0 ? <div className="ic-empty">No permission sets found for the current filter.</div> : null}</div>
                </section>
              ) : null}

              {activeTab === 'simulate' ? (
                <section className="ic-section">
                  <div className="ic-section-head"><div><span className="ic-pane-kicker">Effective access</span><h3>Permission simulation</h3></div></div>
                  <p className="ic-section-hint">Inspect attached AWS managed policies, customer managed policy references, and inline policy JSON for a permission set.</p>
                  <div className="ic-sim-toolbar">
                    <select value={simTarget} onChange={(event) => setSimTarget(event.target.value)}>
                      <option value="">Select a permission set...</option>
                      {permissionSets.map((permissionSet) => <option key={permissionSet.permissionSetArn} value={permissionSet.permissionSetArn}>{permissionSet.name}</option>)}
                    </select>
                    <button type="button" className="tf-toolbar-btn accent" onClick={() => void handleSimulate()} disabled={simLoading || !simTarget}>{simLoading ? 'Simulating...' : 'Run Simulation'}</button>
                  </div>
                  {!simResult && !simLoading ? <div className="ic-empty">Choose a permission set to inspect its attached policy surface.</div> : null}
                  {simResult ? (
                    <div className="ic-sim-layout">
                      <div className="ic-sim-column">
                        <div className="ic-sim-card"><span className="ic-pane-kicker">Permission set</span><strong>{simResult.permissionSetName}</strong></div>
                        <div className="ic-sim-card"><div className="ic-sim-card-head"><h4>AWS Managed Policies</h4><span>{simResult.managedPolicies.length}</span></div>{simResult.managedPolicies.length ? <ul className="ic-policy-list">{simResult.managedPolicies.map((policy) => <li key={policy}>{policy}</li>)}</ul> : <div className="ic-empty">No managed policies attached.</div>}</div>
                        <div className="ic-sim-card"><div className="ic-sim-card-head"><h4>Customer Managed Policies</h4><span>{simResult.customerManagedPolicies.length}</span></div>{simResult.customerManagedPolicies.length ? <ul className="ic-policy-list">{simResult.customerManagedPolicies.map((policy) => <li key={policy}>{policy}</li>)}</ul> : <div className="ic-empty">No customer managed policies attached.</div>}</div>
                      </div>
                      <div className="ic-sim-column">
                        <div className="ic-sim-card ic-sim-card-fill"><div className="ic-sim-card-head"><h4>Inline Policy</h4></div><pre className="ic-code-block">{simResult.inlinePolicy ? (() => { try { return JSON.stringify(JSON.parse(simResult.inlinePolicy), null, 2) } catch { return simResult.inlinePolicy } })() : 'No inline policy attached.'}</pre></div>
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
