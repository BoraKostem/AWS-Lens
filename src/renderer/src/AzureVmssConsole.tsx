import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type { AzureMonitorActivityEvent, AzureVmssInstanceSummary, AzureVmssSummary } from '@shared/types'
import {
  listAzureMonitorActivity,
  listAzureVmss,
  listAzureVmssInstances,
  updateAzureVmssCapacity
} from './api'

type VmssColKey = 'instanceId' | 'powerState' | 'provisioningState' | 'latestModelApplied' | 'zone'

const COLUMNS: { key: VmssColKey; label: string; color: string }[] = [
  { key: 'instanceId', label: 'Instance', color: '#3b82f6' },
  { key: 'powerState', label: 'Power State', color: '#22c55e' },
  { key: 'provisioningState', label: 'Provisioning', color: '#f59e0b' },
  { key: 'latestModelApplied', label: 'Model', color: '#8b5cf6' },
  { key: 'zone', label: 'Zone', color: '#06b6d4' }
]

function powerStateBadge(state: string): 'ok' | 'danger' | 'warn' {
  const lower = state.toLowerCase()
  if (lower.includes('running')) return 'ok'
  if (lower.includes('stopped') || lower.includes('deallocated')) return 'danger'
  return 'warn'
}

function provisioningStateBadge(state: string): 'ok' | 'danger' | 'warn' {
  const lower = state.toLowerCase()
  if (lower === 'succeeded') return 'ok'
  if (lower === 'failed') return 'danger'
  return 'warn'
}

function modelBadge(applied: boolean): 'ok' | 'warn' {
  return applied ? 'ok' : 'warn'
}

function truncate(value: string, max = 20): string {
  if (!value) return '-'
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

export function AzureVmssConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenMonitor
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenMonitor: (query: string) => void
}): JSX.Element {
  const [scaleSets, setScaleSets] = useState<AzureVmssSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [instances, setInstances] = useState<AzureVmssInstanceSummary[]>([])
  const [capacity, setCapacity] = useState('0')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<VmssColKey>>(() => new Set(COLUMNS.map((c) => c.key)))
  const [detailTab, setDetailTab] = useState<'instances' | 'timeline'>('instances')
  const [timelineEvents, setTimelineEvents] = useState<AzureMonitorActivityEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')

  async function load(ssName?: string) {
    setError('')
    if (ssName) { setDetailTab('instances'); setTimelineEvents([]); setTimelineError('') }
    try {
      const nextSets = await listAzureVmss(subscriptionId, location)
      setScaleSets(nextSets)
      const resolved = ssName ?? selectedName ?? nextSets[0]?.name ?? ''
      setSelectedName(resolved)
      if (resolved) {
        const selected = nextSets.find((s) => s.name === resolved)
        setCapacity(String(selected?.skuCapacity ?? 0))
        const rg = selected?.resourceGroup ?? ''
        if (rg) {
          setInstances(await listAzureVmssInstances(subscriptionId, rg, resolved))
        } else {
          setInstances([])
        }
      } else {
        setInstances([])
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => {
    void load()
  }, [subscriptionId, location, refreshNonce])

  async function loadTimeline() {
    if (!selectedName || !selectedSet) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const result = await listAzureMonitorActivity(subscriptionId, location, `Microsoft.Compute|virtualMachineScaleSets|${selectedName}`, 168)
      setTimelineEvents(result.events)
    } catch (error) {
      setTimelineEvents([])
      setTimelineError(error instanceof Error ? error.message : 'Failed to load activity')
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (detailTab === 'timeline' && selectedName) void loadTimeline()
  }, [detailTab, selectedName])

  const selectedSet = useMemo(
    () => scaleSets.find((s) => s.name === selectedName) ?? null,
    [scaleSets, selectedName]
  )

  const activeCols = useMemo(
    () => COLUMNS.filter((column) => visCols.has(column.key)),
    [visCols]
  )

  const filteredInstances = useMemo(() => {
    if (!filter) return instances
    const query = filter.toLowerCase()
    return instances.filter((instance) =>
      activeCols.some((column) => {
        const value = instance[column.key]
        return String(value ?? '').toLowerCase().includes(query)
      })
    )
  }, [instances, filter, activeCols])

  const runningCount = useMemo(
    () => instances.filter((instance) => instance.powerState.toLowerCase().includes('running')).length,
    [instances]
  )

  const zoneCount = useMemo(
    () => new Set(instances.map((instance) => instance.zone).filter(Boolean)).size,
    [instances]
  )

  async function doApply() {
    if (!selectedSet) return
    try {
      const result = await updateAzureVmssCapacity(subscriptionId, selectedSet.resourceGroup, selectedName, Number(capacity))
      if (result.accepted) setMsg('Capacity updated')
      else setError(result.error || 'Capacity update failed')
      await load(selectedName)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function cellValue(instance: AzureVmssInstanceSummary, key: VmssColKey): JSX.Element | string {
    switch (key) {
      case 'powerState':
        return <span className={`svc-badge ${powerStateBadge(instance.powerState)}`}>{instance.powerState}</span>
      case 'provisioningState':
        return <span className={`svc-badge ${provisioningStateBadge(instance.provisioningState)}`}>{instance.provisioningState}</span>
      case 'latestModelApplied':
        return <span className={`svc-badge ${modelBadge(instance.latestModelApplied)}`}>{instance.latestModelApplied ? 'Latest' : 'Outdated'}</span>
      default:
        return String(instance[key] ?? '-')
    }
  }

  return (
    <div className="svc-console asg-console azure-vmss-theme">
      <div className="svc-tab-bar asg-tab-bar">
        <button className="svc-tab active" type="button">VM Scale Sets</button>
        <button className="svc-tab right" type="button" onClick={() => void load()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Compute control plane</div>
          <h2>VM Scale Set fleet posture</h2>
          <p>Monitor scale set capacity, inspect instance health, and act on the selected fleet.</p>
          <div className="asg-meta-strip">
            <div className="asg-meta-pill">
              <span>Subscription</span>
              <strong>{truncate(subscriptionId)}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Location</span>
              <strong>{location || 'all'}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Selected scale set</span>
              <strong>{selectedName || 'None selected'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Scale Sets</span>
            <strong>{scaleSets.length}</strong>
            <small>Discovered in the active location.</small>
          </div>
          <div className="asg-stat-card">
            <span>Instances</span>
            <strong>{instances.length}</strong>
            <small>Instances in the selected scale set.</small>
          </div>
          <div className="asg-stat-card">
            <span>Running</span>
            <strong>{runningCount}</strong>
            <small>Instances with a running power state.</small>
          </div>
          <div className="asg-stat-card">
            <span>Availability zones</span>
            <strong>{zoneCount}</strong>
            <small>Distinct zones represented by the fleet.</small>
          </div>
        </div>
      </section>

      <div className="asg-main-layout">
        <aside className="asg-groups-pane">
          <div className="asg-pane-head">
            <div>
              <span className="asg-pane-kicker">Tracked scale sets</span>
              <h3>Fleet inventory</h3>
            </div>
            <span className="asg-pane-summary">{scaleSets.length} total</span>
          </div>
          <div className="asg-group-list">
            {scaleSets.map((ss) => (
              <button
                key={ss.name}
                type="button"
                className={`asg-group-card ${ss.name === selectedName ? 'active' : ''}`}
                onClick={() => void load(ss.name)}
              >
                <div className="asg-group-card-head">
                  <div className="asg-group-card-copy">
                    <strong>{ss.name}</strong>
                    <span>{ss.skuCapacity} instance{ss.skuCapacity === 1 ? '' : 's'}</span>
                  </div>
                  <span className="asg-group-card-badge">{ss.skuCapacity}</span>
                </div>
                <div className="asg-group-card-metrics">
                  <div>
                    <span>SKU</span>
                    <strong>{ss.skuName}</strong>
                  </div>
                  <div>
                    <span>Capacity</span>
                    <strong>{ss.skuCapacity}</strong>
                  </div>
                  <div>
                    <span>Zones</span>
                    <strong>{ss.zones.length ? ss.zones.join(', ') : '-'}</strong>
                  </div>
                </div>
              </button>
            ))}
            {!scaleSets.length && <div className="svc-empty">No VM scale sets were found.</div>}
          </div>
        </aside>

        <section className="asg-detail-pane">
          {selectedName ? (
            <>
              <section className="asg-detail-hero">
                <div className="asg-detail-copy">
                  <div className="eyebrow">Selected fleet</div>
                  <h3>{selectedName}</h3>
                  <p>Capacity controls and live instance status for the active VM scale set.</p>
                  <div className="asg-meta-strip">
                    <div className="asg-meta-pill">
                      <span>SKU</span>
                      <strong>{selectedSet?.skuName ?? '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Capacity</span>
                      <strong>{selectedSet?.skuCapacity ?? '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Orchestration</span>
                      <strong>{selectedSet?.orchestrationMode ?? '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Upgrade Policy</span>
                      <strong>{selectedSet?.upgradePolicy ?? '-'}</strong>
                    </div>
                  </div>
                </div>
                <div className="asg-detail-glance">
                  <div className="asg-stat-card">
                    <span>Running ratio</span>
                    <strong>{instances.length ? `${runningCount}/${instances.length}` : '0/0'}</strong>
                    <small>Instances with a running power state.</small>
                  </div>
                  <div className="asg-stat-card">
                    <span>Zones</span>
                    <strong>{zoneCount}</strong>
                    <small>Distinct availability zones in use.</small>
                  </div>
                </div>
              </section>

              <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
                <button className={`svc-tab ${detailTab === 'instances' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('instances')}>Instances</button>
                <button className={`svc-tab ${detailTab === 'timeline' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('timeline')}>Activity Timeline</button>
              </div>

              {detailTab === 'instances' && (
                <>
                  <div className="asg-toolbar-grid">
                    <section className="svc-panel asg-capacity-panel">
                      <div className="asg-section-head">
                        <div>
                          <span className="asg-pane-kicker">Capacity controls</span>
                          <h3>Adjust scale set capacity</h3>
                        </div>
                      </div>
                      <div className="asg-capacity-grid">
                        <label className="asg-field">
                          <span>Capacity</span>
                          <input value={capacity} onChange={(event) => setCapacity(event.target.value)} />
                        </label>
                      </div>
                      <div className="svc-btn-row">
                        <button type="button" className="svc-btn primary" onClick={() => void doApply()}>Apply capacity</button>
                        <button
                          type="button"
                          className="svc-btn muted"
                          onClick={() => onOpenMonitor(`AzureVmss | where Name == "${selectedName}"`)}
                        >
                          Monitor
                        </button>
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
                              <td key={column.key}>{cellValue(instance, column.key)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!filteredInstances.length && <div className="svc-empty">No instances in this scale set.</div>}
                  </div>
                </>
              )}

              {detailTab === 'timeline' && (
                <section className="svc-panel" style={{ padding: 16 }}>
                  <div className="asg-section-head">
                    <div>
                      <span className="asg-pane-kicker">Azure Monitor</span>
                      <h3>Activity timeline</h3>
                    </div>
                  </div>
                  <div style={{ color: '#9ca7b7', fontSize: 12, marginBottom: 12 }}>
                    Management-plane events for <strong>{selectedName}</strong> from the last 7 days.
                  </div>
                  {timelineLoading && <div className="svc-empty">Loading activity events...</div>}
                  {!timelineLoading && timelineError && <div className="svc-error">{timelineError}</div>}
                  {!timelineLoading && !timelineError && timelineEvents.length === 0 && <div className="svc-empty">No Azure Monitor events found.</div>}
                  {!timelineLoading && timelineEvents.length > 0 && (
                    <div className="svc-table-area asg-table-area">
                      <table className="svc-table">
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
                </section>
              )}
            </>
          ) : (
            <div className="asg-empty-state">
              <div className="eyebrow">No selection</div>
              <h3>Select a VM Scale Set</h3>
              <p>Choose a scale set from the fleet inventory to inspect capacity settings and instance status.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
