import { useEffect, useMemo, useState } from 'react'

import {
  createSsoInstance,
  deleteSsoInstance,
  listSsoGroups,
  listSsoInstances,
  listSsoPermissionSets,
  listSsoUsers,
  simulateSsoPermissions
} from './api'
import type {
  AwsConnection,
  SsoGroupSummary,
  SsoInstanceSummary,
  SsoPermissionSetSummary,
  SsoSimulationResult,
  SsoUserSummary
} from '@shared/types'

type SsoTab = 'users' | 'groups' | 'permissions' | 'simulate'

/* ── Column definitions ──────────────────────────────────── */

type UserColKey = 'userName' | 'displayName' | 'email' | 'userId'
type GroupColKey = 'displayName' | 'description' | 'groupId'
type PsColKey = 'name' | 'description' | 'sessionDuration' | 'createdDate'

const USER_COLUMNS: { key: UserColKey; label: string; color: string }[] = [
  { key: 'userName', label: 'Username', color: '#3b82f6' },
  { key: 'displayName', label: 'Display Name', color: '#14b8a6' },
  { key: 'email', label: 'Email', color: '#8b5cf6' },
  { key: 'userId', label: 'User ID', color: '#f59e0b' },
]

const GROUP_COLUMNS: { key: GroupColKey; label: string; color: string }[] = [
  { key: 'displayName', label: 'Group Name', color: '#3b82f6' },
  { key: 'description', label: 'Description', color: '#14b8a6' },
  { key: 'groupId', label: 'Group ID', color: '#8b5cf6' },
]

const PS_COLUMNS: { key: PsColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'description', label: 'Description', color: '#22c55e' },
  { key: 'sessionDuration', label: 'Session Duration', color: '#f59e0b' },
  { key: 'createdDate', label: 'Created', color: '#06b6d4' },
]

function getUserVal(u: SsoUserSummary, key: UserColKey): string {
  switch (key) {
    case 'userName': return u.userName
    case 'displayName': return u.displayName
    case 'email': return u.email || '-'
    case 'userId': return u.userId.slice(0, 16)
  }
}

function getGroupVal(g: SsoGroupSummary, key: GroupColKey): string {
  switch (key) {
    case 'displayName': return g.displayName
    case 'description': return g.description || '-'
    case 'groupId': return g.groupId.slice(0, 16)
  }
}

function getPsVal(ps: SsoPermissionSetSummary, key: PsColKey): string {
  switch (key) {
    case 'name': return ps.name
    case 'description': return ps.description || '-'
    case 'sessionDuration': return ps.sessionDuration
    case 'createdDate': return ps.createdDate !== '-' ? new Date(ps.createdDate).toLocaleDateString() : '-'
  }
}

/* ── Main component ──────────────────────────────────────── */

export function IdentityCenterConsole({ connection }: { connection: AwsConnection }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  /* ── Instances ──────────────────────────────────────────── */
  const [instances, setInstances] = useState<SsoInstanceSummary[]>([])
  const [selectedInstance, setSelectedInstance] = useState<SsoInstanceSummary | null>(null)
  const [createName, setCreateName] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  /* ── Data ───────────────────────────────────────────────── */
  const [users, setUsers] = useState<SsoUserSummary[]>([])
  const [groups, setGroups] = useState<SsoGroupSummary[]>([])
  const [permissionSets, setPermissionSets] = useState<SsoPermissionSetSummary[]>([])
  const [activeTab, setActiveTab] = useState<SsoTab>('users')

  /* ── Filters ────────────────────────────────────────────── */
  const [userFilter, setUserFilter] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [psFilter, setPsFilter] = useState('')

  /* ── Column visibility ──────────────────────────────────── */
  const [userVisCols, setUserVisCols] = useState<Set<UserColKey>>(() => new Set(USER_COLUMNS.map(c => c.key)))
  const [groupVisCols, setGroupVisCols] = useState<Set<GroupColKey>>(() => new Set(GROUP_COLUMNS.map(c => c.key)))
  const [psVisCols, setPsVisCols] = useState<Set<PsColKey>>(() => new Set(PS_COLUMNS.map(c => c.key)))

  /* ── Simulate ───────────────────────────────────────────── */
  const [simTarget, setSimTarget] = useState('')
  const [simResult, setSimResult] = useState<SsoSimulationResult | null>(null)
  const [simLoading, setSimLoading] = useState(false)

  /* ── Data loading ───────────────────────────────────────── */

  async function loadInstances() {
    setLoading(true)
    setError('')
    try {
      const inst = await listSsoInstances(connection)
      setInstances(inst)
      if (inst.length === 1 && !selectedInstance) {
        await selectInstance(inst[0])
      } else if (selectedInstance) {
        const refreshed = inst.find((i) => i.instanceArn === selectedInstance.instanceArn)
        if (refreshed) await selectInstance(refreshed)
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  async function selectInstance(inst: SsoInstanceSummary) {
    setSelectedInstance(inst)
    setLoading(true)
    setError('')
    setSimResult(null)
    setSimTarget('')
    try {
      const [u, g, ps] = await Promise.all([
        listSsoUsers(connection, inst.identityStoreId),
        listSsoGroups(connection, inst.identityStoreId),
        listSsoPermissionSets(connection, inst.instanceArn)
      ])
      setUsers(u)
      setGroups(g)
      setPermissionSets(ps)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
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
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDeleteInstance(instanceArn: string) {
    setError('')
    try {
      await deleteSsoInstance(connection, instanceArn)
      setMsg('Instance disabled')
      const inst = await listSsoInstances(connection)
      setInstances(inst)
      if (selectedInstance?.instanceArn === instanceArn) {
        setSelectedInstance(null)
        setUsers([])
        setGroups([])
        setPermissionSets([])
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleSimulate() {
    if (!selectedInstance || !simTarget) return
    setSimLoading(true)
    setError('')
    setSimResult(null)
    try {
      const result = await simulateSsoPermissions(connection, selectedInstance.instanceArn, simTarget)
      setSimResult(result)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSimLoading(false) }
  }

  useEffect(() => { void loadInstances() }, [connection.profile, connection.region])

  /* ── Filtering ──────────────────────────────────────────── */

  const activeUserCols = USER_COLUMNS.filter(c => userVisCols.has(c.key))
  const activeGroupCols = GROUP_COLUMNS.filter(c => groupVisCols.has(c.key))
  const activePsCols = PS_COLUMNS.filter(c => psVisCols.has(c.key))

  const filteredUsers = useMemo(() => {
    if (!userFilter.trim()) return users
    const q = userFilter.toLowerCase()
    return users.filter((u) =>
      activeUserCols.some(c => getUserVal(u, c.key).toLowerCase().includes(q))
    )
  }, [users, userFilter, activeUserCols])

  const filteredGroups = useMemo(() => {
    if (!groupFilter.trim()) return groups
    const q = groupFilter.toLowerCase()
    return groups.filter((g) =>
      activeGroupCols.some(c => getGroupVal(g, c.key).toLowerCase().includes(q))
    )
  }, [groups, groupFilter, activeGroupCols])

  const filteredPermissionSets = useMemo(() => {
    if (!psFilter.trim()) return permissionSets
    const q = psFilter.toLowerCase()
    return permissionSets.filter((ps) =>
      activePsCols.some(c => getPsVal(ps, c.key).toLowerCase().includes(q))
    )
  }, [permissionSets, psFilter, activePsCols])

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="svc-console">
      {/* ── Top tab bar ─────────────────────────────────── */}
      <div className="svc-tab-bar">
        <button className={`svc-tab ${activeTab === 'users' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('users')}>Users</button>
        <button className={`svc-tab ${activeTab === 'groups' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('groups')}>Groups</button>
        <button className={`svc-tab ${activeTab === 'permissions' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('permissions')}>Permission Sets</button>
        <button className={`svc-tab ${activeTab === 'simulate' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('simulate')}>Simulate</button>
        <button className="svc-tab right" type="button" onClick={() => void loadInstances()} disabled={loading}>{loading ? 'Gathering data' : 'Refresh'}</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* ── Stats strip ─────────────────────────────────── */}
      <div className="svc-stat-strip">
        <div className="svc-stat-card"><span>Instances</span><strong>{instances.length}</strong></div>
        <div className="svc-stat-card"><span>Users</span><strong>{users.length}</strong></div>
        <div className="svc-stat-card"><span>Groups</span><strong>{groups.length}</strong></div>
        <div className="svc-stat-card"><span>Permission Sets</span><strong>{permissionSets.length}</strong></div>
        {selectedInstance && <div className="svc-stat-card"><span>Status</span><strong>{selectedInstance.status}</strong></div>}
      </div>

      {/* ── Instance selector panel ─────────────────────── */}
      <div className="svc-panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>SSO Instances</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="svc-btn" type="button" onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : '+ New'}</button>
            {selectedInstance && (
              <button className="svc-btn danger" type="button" onClick={() => void handleDeleteInstance(selectedInstance.instanceArn)}>Disable Instance</button>
            )}
          </div>
        </div>

        {showCreate && (
          <div className="svc-inline" style={{ marginBottom: 10 }}>
            <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Instance name" />
            <button type="button" className="svc-btn primary" onClick={() => void handleCreateInstance()}>Create</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {instances.map((inst) => (
            <button
              key={inst.instanceArn}
              type="button"
              className={`svc-chip ${selectedInstance?.instanceArn === inst.instanceArn ? 'active' : ''}`}
              style={selectedInstance?.instanceArn === inst.instanceArn ? { background: '#3b82f6', borderColor: '#3b82f6' } : undefined}
              onClick={() => void selectInstance(inst)}
            >
              {inst.name || 'Default Instance'} ({inst.status})
            </button>
          ))}
          {!instances.length && !loading && <div className="svc-empty" style={{ padding: 4 }}>No SSO instances found.</div>}
        </div>

        {selectedInstance && (
          <div className="svc-kv" style={{ marginTop: 8 }}>
            <div className="svc-kv-row"><div className="svc-kv-label">Instance ARN</div><div className="svc-kv-value">{selectedInstance.instanceArn}</div></div>
            <div className="svc-kv-row"><div className="svc-kv-label">Identity Store</div><div className="svc-kv-value">{selectedInstance.identityStoreId}</div></div>
            <div className="svc-kv-row"><div className="svc-kv-label">Owner Account</div><div className="svc-kv-value">{selectedInstance.ownerAccountId}</div></div>
          </div>
        )}
      </div>

      {/* ══════════════════ USERS TAB ══════════════════ */}
      {activeTab === 'users' && selectedInstance && (
        <>
          <input
            className="svc-search"
            placeholder="Filter users across selected columns..."
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
          />

          <div className="svc-chips">
            {USER_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`svc-chip ${userVisCols.has(col.key) ? 'active' : ''}`}
                type="button"
                style={userVisCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
                onClick={() => setUserVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
              >{col.label}</button>
            ))}
          </div>

          <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
            <table className="svc-table">
              <thead>
                <tr>{activeUserCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={activeUserCols.length}>Gathering data</td></tr>}
                {!loading && filteredUsers.map((u) => (
                  <tr key={u.userId}>
                    {activeUserCols.map(c => (
                      <td key={c.key}>{getUserVal(u, c.key)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredUsers.length && !loading && <div className="svc-empty">No users found.</div>}
          </div>
          {filteredUsers.length > 0 && <div style={{ fontSize: 11, color: '#9ca7b7', padding: '4px 0' }}>Showing {filteredUsers.length} of {users.length} users</div>}
        </>
      )}

      {/* ══════════════════ GROUPS TAB ══════════════════ */}
      {activeTab === 'groups' && selectedInstance && (
        <>
          <input
            className="svc-search"
            placeholder="Filter groups across selected columns..."
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          />

          <div className="svc-chips">
            {GROUP_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`svc-chip ${groupVisCols.has(col.key) ? 'active' : ''}`}
                type="button"
                style={groupVisCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
                onClick={() => setGroupVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
              >{col.label}</button>
            ))}
          </div>

          <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
            <table className="svc-table">
              <thead>
                <tr>{activeGroupCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={activeGroupCols.length}>Gathering data</td></tr>}
                {!loading && filteredGroups.map((g) => (
                  <tr key={g.groupId}>
                    {activeGroupCols.map(c => (
                      <td key={c.key}>{getGroupVal(g, c.key)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredGroups.length && !loading && <div className="svc-empty">No groups found.</div>}
          </div>
          {filteredGroups.length > 0 && <div style={{ fontSize: 11, color: '#9ca7b7', padding: '4px 0' }}>Showing {filteredGroups.length} of {groups.length} groups</div>}
        </>
      )}

      {/* ══════════════════ PERMISSION SETS TAB ══════════════════ */}
      {activeTab === 'permissions' && selectedInstance && (
        <>
          <input
            className="svc-search"
            placeholder="Filter permission sets across selected columns..."
            value={psFilter}
            onChange={(e) => setPsFilter(e.target.value)}
          />

          <div className="svc-chips">
            {PS_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`svc-chip ${psVisCols.has(col.key) ? 'active' : ''}`}
                type="button"
                style={psVisCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
                onClick={() => setPsVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
              >{col.label}</button>
            ))}
          </div>

          <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
            <table className="svc-table">
              <thead>
                <tr>
                  {activePsCols.map(c => <th key={c.key}>{c.label}</th>)}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={activePsCols.length + 1}>Gathering data</td></tr>}
                {!loading && filteredPermissionSets.map((ps) => (
                  <tr key={ps.permissionSetArn}>
                    {activePsCols.map(c => (
                      <td key={c.key}>{getPsVal(ps, c.key)}</td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className="svc-btn"
                        onClick={() => { setSimTarget(ps.permissionSetArn); setActiveTab('simulate') }}
                      >Simulate</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredPermissionSets.length && !loading && <div className="svc-empty">No permission sets found.</div>}
          </div>
          {filteredPermissionSets.length > 0 && <div style={{ fontSize: 11, color: '#9ca7b7', padding: '4px 0' }}>Showing {filteredPermissionSets.length} of {permissionSets.length} permission sets</div>}
        </>
      )}

      {/* ══════════════════ SIMULATE TAB ══════════════════ */}
      {activeTab === 'simulate' && selectedInstance && (
        <div className="svc-panel">
          <h3>Permission Simulation</h3>
          <p style={{ fontSize: 12, color: '#9ca7b7', margin: '0 0 12px' }}>
            Select a permission set to inspect its attached managed policies, inline policy, and customer managed policy references.
          </p>

          <div className="svc-inline" style={{ marginBottom: 12 }}>
            <select value={simTarget} onChange={(e) => setSimTarget(e.target.value)} style={{ flex: 1 }}>
              <option value="">Select a permission set...</option>
              {permissionSets.map((ps) => (
                <option key={ps.permissionSetArn} value={ps.permissionSetArn}>{ps.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="svc-btn primary"
              onClick={() => void handleSimulate()}
              disabled={simLoading || !simTarget}
            >{simLoading ? 'Simulating...' : 'Simulate'}</button>
          </div>

          {simResult && (
            <>
              <div className="svc-section">
                <h3>Permission Set: {simResult.permissionSetName}</h3>
              </div>

              <div className="svc-section">
                <h3>AWS Managed Policies ({simResult.managedPolicies.length})</h3>
                {simResult.managedPolicies.length ? (
                  <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
                    <table className="svc-table">
                      <thead><tr><th>Policy ARN</th></tr></thead>
                      <tbody>
                        {simResult.managedPolicies.map((p) => (
                          <tr key={p}><td>{p}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="svc-empty">No managed policies attached.</div>}
              </div>

              <div className="svc-section">
                <h3>Customer Managed Policies ({simResult.customerManagedPolicies.length})</h3>
                {simResult.customerManagedPolicies.length ? (
                  <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
                    <table className="svc-table">
                      <thead><tr><th>Policy Reference</th></tr></thead>
                      <tbody>
                        {simResult.customerManagedPolicies.map((p) => (
                          <tr key={p}><td>{p}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="svc-empty">No customer managed policies attached.</div>}
              </div>

              <div className="svc-section">
                <h3>Inline Policy</h3>
                {simResult.inlinePolicy ? (
                  <pre className="svc-code">{(() => {
                    try { return JSON.stringify(JSON.parse(simResult.inlinePolicy), null, 2) }
                    catch { return simResult.inlinePolicy }
                  })()}</pre>
                ) : <div className="svc-empty">No inline policy attached.</div>}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── No instance selected ────────────────────────── */}
      {!selectedInstance && !loading && instances.length > 0 && (
        <div className="svc-empty">Select an SSO instance above to manage users, groups, and permission sets.</div>
      )}

      {/* ── No instance selected, tabs hidden when no instance ── */}
      {!selectedInstance && !loading && instances.length === 0 && !error && (
        <div className="svc-empty">No SSO instances found. Create one above to get started.</div>
      )}
    </div>
  )
}
