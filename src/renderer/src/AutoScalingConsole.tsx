import { useEffect, useMemo, useState } from 'react'

import type { AwsConnection } from '@shared/types'
import { deleteAutoScalingGroup, listAutoScalingGroups, listAutoScalingInstances, startAutoScalingRefresh, updateAutoScalingCapacity } from './api'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'instanceId' | 'lifecycleState' | 'healthStatus' | 'availabilityZone'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'instanceId', label: 'InstanceId', color: '#3b82f6' },
  { key: 'lifecycleState', label: 'Lifecycle', color: '#22c55e' },
  { key: 'healthStatus', label: 'Health', color: '#f59e0b' },
  { key: 'availabilityZone', label: 'AZ', color: '#8b5cf6' },
]

export function AutoScalingConsole({ connection }: { connection: AwsConnection }) {
  const [groups, setGroups] = useState<Array<{ name: string; min: number | string; desired: number | string; max: number | string; instances: number }>>([])
  const [selectedName, setSelectedName] = useState('')
  const [instances, setInstances] = useState<Array<{ instanceId: string; lifecycleState: string; healthStatus: string; availabilityZone: string }>>([])
  const [capacity, setCapacity] = useState({ min: '1', desired: '1', max: '1' })
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  async function load(groupName?: string) {
    setError('')
    try {
      const nextGroups = await listAutoScalingGroups(connection)
      setGroups(nextGroups)
      const resolved = groupName ?? selectedName ?? nextGroups[0]?.name ?? ''
      setSelectedName(resolved)
      if (resolved) {
        const selected = nextGroups.find(g => g.name === resolved)
        setCapacity({ min: String(selected?.min ?? 1), desired: String(selected?.desired ?? 1), max: String(selected?.max ?? 1) })
        setInstances(await listAutoScalingInstances(connection, resolved))
      } else { setInstances([]) }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => { void load() }, [connection.profile, connection.region])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))
  const filteredInstances = useMemo(() => {
    if (!filter) return instances
    const q = filter.toLowerCase()
    return instances.filter(i => activeCols.some(c => (i[c.key] ?? '').toLowerCase().includes(q)))
  }, [instances, filter, activeCols])

  async function doApply() {
    try {
      await updateAutoScalingCapacity(connection, selectedName, Number(capacity.min), Number(capacity.desired), Number(capacity.max))
      setMsg('Capacity updated')
      await load(selectedName)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doRefresh() {
    try {
      await startAutoScalingRefresh(connection, selectedName)
      setMsg('Instance refresh started')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDelete() {
    try {
      await deleteAutoScalingGroup(connection, selectedName, true)
      setMsg('ASG deleted')
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Auto Scaling Groups</button>
        <button className="svc-tab right" type="button" onClick={() => void load()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      <div className="svc-stat-strip">
        {groups.map(g => (
          <button
            key={g.name}
            type="button"
            className={`svc-stat-card ${g.name === selectedName ? 'active' : ''}`}
            style={g.name === selectedName ? { borderColor: '#4a8fe7' } : { cursor: 'pointer' }}
            onClick={() => void load(g.name)}
          >
            <span>{g.name}</span>
            <strong>{g.instances}</strong>
          </button>
        ))}
      </div>

      {selectedName && (
        <div className="svc-panel">
          <h3>Capacity — {selectedName}</h3>
          <div className="svc-inline">
            <label style={{ fontSize: 12, color: '#9ca7b7' }}>Min</label>
            <input style={{ width: 60 }} value={capacity.min} onChange={e => setCapacity(c => ({ ...c, min: e.target.value }))} />
            <label style={{ fontSize: 12, color: '#9ca7b7' }}>Desired</label>
            <input style={{ width: 60 }} value={capacity.desired} onChange={e => setCapacity(c => ({ ...c, desired: e.target.value }))} />
            <label style={{ fontSize: 12, color: '#9ca7b7' }}>Max</label>
            <input style={{ width: 60 }} value={capacity.max} onChange={e => setCapacity(c => ({ ...c, max: e.target.value }))} />
            <button type="button" className="svc-btn primary" onClick={() => void doApply()}>Apply</button>
            <button type="button" className="svc-btn muted" onClick={() => void doRefresh()}>Instance Refresh</button>
            <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete()}>Delete ASG</ConfirmButton>
          </div>
        </div>
      )}

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

      <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
        <table className="svc-table">
          <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {filteredInstances.map(i => (
              <tr key={i.instanceId}>
                {activeCols.map(c => (
                  <td key={c.key}>
                    {c.key === 'healthStatus' ? <span className={`svc-badge ${i.healthStatus === 'Healthy' ? 'ok' : 'danger'}`}>{i.healthStatus}</span>
                     : c.key === 'lifecycleState' ? <span className={`svc-badge ${i.lifecycleState === 'InService' ? 'ok' : 'warn'}`}>{i.lifecycleState}</span>
                     : i[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredInstances.length && <div className="svc-empty">No instances in this group.</div>}
      </div>
    </div>
  )
}
