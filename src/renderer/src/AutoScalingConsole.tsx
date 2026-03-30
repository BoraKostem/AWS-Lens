import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type { AwsConnection } from '@shared/types'
import {
  deleteAutoScalingGroup,
  listAutoScalingGroups,
  listAutoScalingInstances,
  startAutoScalingRefresh,
  updateAutoScalingCapacity
} from './api'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'instanceId' | 'lifecycleState' | 'healthStatus' | 'availabilityZone'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'instanceId', label: 'InstanceId', color: '#3b82f6' },
  { key: 'lifecycleState', label: 'Lifecycle', color: '#22c55e' },
  { key: 'healthStatus', label: 'Health', color: '#f59e0b' },
  { key: 'availabilityZone', label: 'AZ', color: '#8b5cf6' }
]

type AutoScalingGroupRow = {
  name: string
  min: number | string
  desired: number | string
  max: number | string
  instances: number
}

type AutoScalingInstanceRow = {
  instanceId: string
  lifecycleState: string
  healthStatus: string
  availabilityZone: string
}

export function AutoScalingConsole({ connection }: { connection: AwsConnection }) {
  const [groups, setGroups] = useState<AutoScalingGroupRow[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [instances, setInstances] = useState<AutoScalingInstanceRow[]>([])
  const [capacity, setCapacity] = useState({ min: '1', desired: '1', max: '1' })
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))

  async function load(groupName?: string) {
    setError('')
    try {
      const nextGroups = await listAutoScalingGroups(connection)
      setGroups(nextGroups)
      const resolved = groupName ?? selectedName ?? nextGroups[0]?.name ?? ''
      setSelectedName(resolved)
      if (resolved) {
        const selected = nextGroups.find((group) => group.name === resolved)
        setCapacity({
          min: String(selected?.min ?? 1),
          desired: String(selected?.desired ?? 1),
          max: String(selected?.max ?? 1)
        })
        setInstances(await listAutoScalingInstances(connection, resolved))
      } else {
        setInstances([])
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => {
    void load()
  }, [connection.sessionId, connection.region])

  const selectedGroup = useMemo(
    () => groups.find((group) => group.name === selectedName) ?? null,
    [groups, selectedName]
  )

  const activeCols = useMemo(
    () => COLUMNS.filter((column) => visCols.has(column.key)),
    [visCols]
  )

  const filteredInstances = useMemo(() => {
    if (!filter) return instances
    const query = filter.toLowerCase()
    return instances.filter((instance) =>
      activeCols.some((column) => (instance[column.key] ?? '').toLowerCase().includes(query))
    )
  }, [instances, filter, activeCols])

  const inServiceCount = useMemo(
    () => instances.filter((instance) => instance.lifecycleState === 'InService').length,
    [instances]
  )

  const healthyCount = useMemo(
    () => instances.filter((instance) => instance.healthStatus === 'Healthy').length,
    [instances]
  )

  const availabilityZoneCount = useMemo(
    () => new Set(instances.map((instance) => instance.availabilityZone).filter(Boolean)).size,
    [instances]
  )

  async function doApply() {
    try {
      await updateAutoScalingCapacity(
        connection,
        selectedName,
        Number(capacity.min),
        Number(capacity.desired),
        Number(capacity.max)
      )
      setMsg('Capacity updated')
      await load(selectedName)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function doRefresh() {
    try {
      await startAutoScalingRefresh(connection, selectedName)
      setMsg('Instance refresh started')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function doDelete() {
    try {
      await deleteAutoScalingGroup(connection, selectedName, true)
      setMsg('ASG deleted')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div className="svc-console asg-console">
      <div className="svc-tab-bar asg-tab-bar">
        <button className="svc-tab active" type="button">Auto Scaling Groups</button>
        <button className="svc-tab right" type="button" onClick={() => void load()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Compute control plane</div>
          <h2>Auto Scaling fleet posture</h2>
          <p>Monitor group capacity, inspect instance health, and act on the selected fleet without changing the underlying service behavior.</p>
          <div className="asg-meta-strip">
            <div className="asg-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Connection</span>
              <strong>{connection.kind === 'profile' ? connection.profile : connection.label}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Selected group</span>
              <strong>{selectedName || 'None selected'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Groups</span>
            <strong>{groups.length}</strong>
            <small>Discovered in the active region.</small>
          </div>
          <div className="asg-stat-card">
            <span>Instances</span>
            <strong>{selectedGroup?.instances ?? 0}</strong>
            <small>Instances attached to the selected group.</small>
          </div>
          <div className="asg-stat-card">
            <span>Healthy</span>
            <strong>{healthyCount}</strong>
            <small>Healthy instances in the current selection.</small>
          </div>
          <div className="asg-stat-card">
            <span>Availability zones</span>
            <strong>{availabilityZoneCount}</strong>
            <small>Distinct zones represented by the fleet.</small>
          </div>
        </div>
      </section>

      <div className="asg-main-layout">
        <aside className="asg-groups-pane">
          <div className="asg-pane-head">
            <div>
              <span className="asg-pane-kicker">Tracked groups</span>
              <h3>Fleet inventory</h3>
            </div>
            <span className="asg-pane-summary">{groups.length} total</span>
          </div>
          <div className="asg-group-list">
            {groups.map((group) => (
              <button
                key={group.name}
                type="button"
                className={`asg-group-card ${group.name === selectedName ? 'active' : ''}`}
                onClick={() => void load(group.name)}
              >
                <div className="asg-group-card-head">
                  <div className="asg-group-card-copy">
                    <strong>{group.name}</strong>
                    <span>{group.instances} attached instance{group.instances === 1 ? '' : 's'}</span>
                  </div>
                  <span className="asg-group-card-badge">{group.desired}/{group.max}</span>
                </div>
                <div className="asg-group-card-metrics">
                  <div>
                    <span>Min</span>
                    <strong>{group.min}</strong>
                  </div>
                  <div>
                    <span>Desired</span>
                    <strong>{group.desired}</strong>
                  </div>
                  <div>
                    <span>Max</span>
                    <strong>{group.max}</strong>
                  </div>
                </div>
              </button>
            ))}
            {!groups.length && <div className="svc-empty">No auto scaling groups were found.</div>}
          </div>
        </aside>

        <section className="asg-detail-pane">
          {selectedName ? (
            <>
              <section className="asg-detail-hero">
                <div className="asg-detail-copy">
                  <div className="eyebrow">Selected fleet</div>
                  <h3>{selectedName}</h3>
                  <p>Capacity controls and live instance status for the active auto scaling group.</p>
                  <div className="asg-meta-strip">
                    <div className="asg-meta-pill">
                      <span>Min</span>
                      <strong>{selectedGroup?.min ?? '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Desired</span>
                      <strong>{selectedGroup?.desired ?? '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Max</span>
                      <strong>{selectedGroup?.max ?? '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>In service</span>
                      <strong>{inServiceCount}</strong>
                    </div>
                  </div>
                </div>
                <div className="asg-detail-glance">
                  <div className="asg-stat-card">
                    <span>Healthy ratio</span>
                    <strong>{instances.length ? `${healthyCount}/${instances.length}` : '0/0'}</strong>
                    <small>Instances marked healthy by Auto Scaling.</small>
                  </div>
                  <div className="asg-stat-card">
                    <span>Lifecycle</span>
                    <strong>{inServiceCount}</strong>
                    <small>Instances currently in service.</small>
                  </div>
                </div>
              </section>

              <div className="asg-toolbar-grid">
                <section className="svc-panel asg-capacity-panel">
                  <div className="asg-section-head">
                    <div>
                      <span className="asg-pane-kicker">Capacity controls</span>
                      <h3>Adjust group limits</h3>
                    </div>
                  </div>
                  <div className="asg-capacity-grid">
                    <label className="asg-field">
                      <span>Min</span>
                      <input value={capacity.min} onChange={(event) => setCapacity((current) => ({ ...current, min: event.target.value }))} />
                    </label>
                    <label className="asg-field">
                      <span>Desired</span>
                      <input value={capacity.desired} onChange={(event) => setCapacity((current) => ({ ...current, desired: event.target.value }))} />
                    </label>
                    <label className="asg-field">
                      <span>Max</span>
                      <input value={capacity.max} onChange={(event) => setCapacity((current) => ({ ...current, max: event.target.value }))} />
                    </label>
                  </div>
                  <div className="svc-btn-row">
                    <button type="button" className="svc-btn primary" onClick={() => void doApply()}>Apply capacity</button>
                    <button type="button" className="svc-btn muted" onClick={() => void doRefresh()}>Start refresh</button>
                    <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete()}>Delete group</ConfirmButton>
                  </div>
                </section>

                <section className="svc-panel asg-filter-panel">
                  <div className="asg-section-head">
                    <div>
                      <span className="asg-pane-kicker">Instance view</span>
                      <h3>Filter and shape the table</h3>
                    </div>
                  </div>
                  <input
                    className="svc-search asg-search"
                    placeholder="Filter rows across selected columns..."
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  <div className="svc-chips asg-chip-grid">
                    {COLUMNS.map((column) => (
                      <button
                        key={column.key}
                        className={`svc-chip asg-chip ${visCols.has(column.key) ? 'active' : ''}`}
                        type="button"
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
                </section>
              </div>

              <div className="svc-table-area asg-table-area">
                <table className="svc-table">
                  <thead>
                    <tr>{activeCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {filteredInstances.map((instance) => (
                      <tr key={instance.instanceId}>
                        {activeCols.map((column) => (
                          <td key={column.key}>
                            {column.key === 'healthStatus' ? (
                              <span className={`svc-badge ${instance.healthStatus === 'Healthy' ? 'ok' : 'danger'}`}>{instance.healthStatus}</span>
                            ) : column.key === 'lifecycleState' ? (
                              <span className={`svc-badge ${instance.lifecycleState === 'InService' ? 'ok' : 'warn'}`}>{instance.lifecycleState}</span>
                            ) : (
                              instance[column.key]
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filteredInstances.length && <div className="svc-empty">No instances in this group.</div>}
              </div>
            </>
          ) : (
            <div className="asg-empty-state">
              <div className="eyebrow">No selection</div>
              <h3>Select an auto scaling group</h3>
              <p>Choose a group from the fleet inventory to inspect capacity settings and instance health.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
