import { useEffect, useMemo, useState } from 'react'
import type {
  GcpMemorystoreInstanceSummary,
  GcpMemorystoreInstanceDetail
} from '@shared/types'
import {
  listGcpMemorystoreInstances,
  getGcpMemorystoreInstanceDetail
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Helpers ──────────────────────────────────────────────── */

type MemorystoreTab = 'instances'

const MAIN_TABS: Array<{ id: MemorystoreTab; label: string }> = [
  { id: 'instances', label: 'Instances' }
]

function extractQuotedCommand(value: string): string | null {
  const straight = value.match(/Run "([^"]+)"/)
  if (straight?.[1]?.trim()) return straight[1].trim()
  const curly = value.match(/Run \u201c([^\u201d]+)\u201d/)
  return curly?.[1]?.trim() ?? null
}

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  return {
    command: extractQuotedCommand(error) ?? fallbackCommand,
    summary
  }
}

function truncate(value: string, max = 48): string {
  if (!value) return '-'
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function stateBadgeTone(state: string): string {
  if (state === 'READY') return 'status-ok'
  if (state === 'CREATING' || state === 'UPDATING') return 'status-warn'
  if (state === 'DELETING' || state === 'FAILING_OVER') return 'status-warn'
  return ''
}

function tierLabel(tier: string): string {
  if (tier === 'BASIC') return 'Basic'
  if (tier === 'STANDARD_HA') return 'Standard (HA)'
  return tier || '-'
}

function formatDateTime(iso: string): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function DetailRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="table-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0' }}>
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  )
}

/* ── Component ────────────────────────────────────────────── */

export function GcpMemorystoreConsole({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const [mainTab, setMainTab] = useState<MemorystoreTab>('instances')
  const [tabsOpen, setTabsOpen] = useState(true)

  const [instances, setInstances] = useState<GcpMemorystoreInstanceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedInstance, setSelectedInstance] = useState<GcpMemorystoreInstanceSummary | null>(null)
  const [instanceDetail, setInstanceDetail] = useState<GcpMemorystoreInstanceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [instanceFilter, setInstanceFilter] = useState('')

  /* ── Data fetching ────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    listGcpMemorystoreInstances(projectId, location.trim() || '-')
      .then((result) => {
        if (cancelled) return
        setInstances(result)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, location, refreshNonce])

  /* Load instance detail on selection */
  useEffect(() => {
    if (!selectedInstance) {
      setInstanceDetail(null)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    setDetailError('')

    getGcpMemorystoreInstanceDetail(projectId, selectedInstance.name)
      .then((detail) => {
        if (!cancelled) setInstanceDetail(detail)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, selectedInstance?.name])

  /* ── Derived data ─────────────────────────────────────────── */

  const locationLabel = location.trim() || 'all regions'
  const totalMemoryGb = useMemo(
    () => instances.reduce((sum, i) => sum + i.memorySizeGb, 0),
    [instances]
  )
  const haCount = useMemo(
    () => instances.filter((i) => i.tier === 'STANDARD_HA').length,
    [instances]
  )

  const filteredInstances = useMemo(() => {
    if (!instanceFilter.trim()) return instances
    const q = instanceFilter.trim().toLowerCase()
    return instances.filter((i) =>
      i.displayName.toLowerCase().includes(q) ||
      i.instanceId.toLowerCase().includes(q) ||
      i.redisVersion.toLowerCase().includes(q) ||
      i.state.toLowerCase().includes(q) ||
      i.tier.toLowerCase().includes(q)
    )
  }, [instances, instanceFilter])

  const enableAction = error
    ? getGcpApiEnableAction(
        error,
        `gcloud services enable redis.googleapis.com --project ${projectId}`,
        `Memorystore for Redis API is disabled for project ${projectId}.`
      )
    : null

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="svc-console">
      {/* ── Error banner ────────────────────────────── */}
      {error ? (
        <section className="panel stack">
          {enableAction ? (
            <div className="error-banner gcp-enable-error-banner">
              <div className="gcp-enable-error-copy">
                <strong>{enableAction.summary}</strong>
                <p>
                  {canRunTerminalCommand
                    ? 'Run the enable command in the terminal, wait for propagation, then refresh the inventory.'
                    : 'Switch Settings > Access Mode to Operator to enable terminal actions for this command.'}
                </p>
              </div>
              <div className="gcp-enable-error-actions">
                <button
                  type="button"
                  className="accent"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(enableAction.command)}
                  title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode to enable terminal actions'}
                >
                  Enable API
                </button>
              </div>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      {/* ── Hero ────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Data store posture</div>
          <h2>Memorystore (Redis)</h2>
          <p>
            Redis instance inventory with tier, memory, version, and connection
            metadata for the active Google Cloud project.
          </p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Selection</span>
              <strong>{selectedInstance?.displayName || 'No selection'}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Instances</span>
            <strong>{instances.length}</strong>
            <small>{loading ? 'Refreshing live data now' : 'Redis instances in scope'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Total Memory</span>
            <strong>{totalMemoryGb} GB</strong>
            <small>Sum of all instance memory allocations</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Standard HA</span>
            <strong>{haCount}</strong>
            <small>Instances with high availability tier</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Basic</span>
            <strong>{instances.length - haCount}</strong>
            <small>Instances with basic tier</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ─────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <button className="svc-tab-hamburger" type="button" onClick={() => setTabsOpen((p) => !p)}>
          <span className={`hamburger-icon ${tabsOpen ? 'open' : ''}`}>
            <span /><span /><span />
          </span>
        </button>
        <div className="iam-tab-bar">
          {tabsOpen && MAIN_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`svc-tab ${mainTab === t.id ? 'active' : ''}`}
              onClick={() => setMainTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Loading state ───────────────────────────── */}
      {loading && <SvcState variant="loading" resourceName="Memorystore instances" message="Fetching Redis instances..." />}

      {/* ══════════════ INSTANCES TAB ══════════════ */}
      {!loading && !error && mainTab === 'instances' && (
        <div className="overview-surface">
          <div className="panel">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <span>Instances ({filteredInstances.length})</span>
              <input
                className="svc-search"
                style={{ maxWidth: 280 }}
                placeholder="Filter instances..."
                value={instanceFilter}
                onChange={(e) => setInstanceFilter(e.target.value)}
              />
            </div>

            {/* Table header */}
            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1.5fr 1fr 1fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Name</span>
              <span>State</span>
              <span>Tier</span>
              <span>Memory</span>
              <span>Host:Port</span>
              <span>Version</span>
              <span>Location</span>
            </div>

            {/* Table rows */}
            {filteredInstances.length === 0 && (
              <SvcState variant="empty" message="No Memorystore instances found in this project." compact />
            )}
            {filteredInstances.map((inst) => (
              <div
                key={inst.name}
                className={`table-row overview-table-row ${selectedInstance?.name === inst.name ? 'active' : ''}`}
                style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1.5fr 1fr 1fr', gap: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
                onClick={() => setSelectedInstance((prev) => prev?.name === inst.name ? null : inst)}
              >
                <span title={inst.name}>{truncate(inst.displayName)}</span>
                <span className={`status-badge ${stateBadgeTone(inst.state)}`}>{inst.state || '-'}</span>
                <span>{tierLabel(inst.tier)}</span>
                <span>{inst.memorySizeGb} GB</span>
                <span title={`${inst.host}:${inst.port}`}>{inst.host ? `${truncate(inst.host, 24)}:${inst.port}` : '-'}</span>
                <span>{inst.redisVersion || '-'}</span>
                <span>{inst.currentLocationId || inst.locationId || '-'}</span>
              </div>
            ))}
          </div>

          {/* ── Instance detail panel ───────────────── */}
          {selectedInstance && (
            <div className="panel" style={{ marginTop: '1rem' }}>
              <div className="panel-header">
                Instance detail: <strong>{selectedInstance.displayName}</strong>
                <span className={`status-badge ${stateBadgeTone(selectedInstance.state)}`} style={{ marginLeft: '0.5rem' }}>{selectedInstance.state}</span>
              </div>

              {detailLoading && (
                <SvcState variant="loading" resourceName="instance detail" compact />
              )}
              {detailError && (
                <SvcState variant="error" error={detailError} compact />
              )}

              {instanceDetail && !detailLoading && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', padding: '1rem' }}>
                  {/* Left column: connection & general */}
                  <div>
                    <h4 style={{ margin: '0 0 0.75rem' }}>Connection</h4>
                    <DetailRow label="Host" value={instanceDetail.host || '-'} />
                    <DetailRow label="Port" value={String(instanceDetail.port || '-')} />
                    <DetailRow label="Read Endpoint" value={instanceDetail.readEndpoint || '-'} />
                    <DetailRow label="Read Endpoint Port" value={instanceDetail.readEndpointPort ? String(instanceDetail.readEndpointPort) : '-'} />
                    <DetailRow label="Connect Mode" value={instanceDetail.connectMode || '-'} />
                    <DetailRow label="Auth Enabled" value={instanceDetail.authEnabled ? 'Yes' : 'No'} />
                    <DetailRow label="Transit Encryption" value={instanceDetail.transitEncryptionMode || '-'} />
                    <DetailRow label="Authorized Network" value={instanceDetail.authorizedNetwork ? truncate(instanceDetail.authorizedNetwork, 36) : '-'} title={instanceDetail.authorizedNetwork} />
                    <DetailRow label="Reserved IP Range" value={instanceDetail.reservedIpRange || '-'} />

                    <h4 style={{ margin: '1rem 0 0.75rem' }}>General</h4>
                    <DetailRow label="Redis Version" value={instanceDetail.redisVersion || '-'} />
                    <DetailRow label="Tier" value={tierLabel(instanceDetail.tier)} />
                    <DetailRow label="Memory" value={`${instanceDetail.memorySizeGb} GB`} />
                    <DetailRow label="Replica Count" value={String(instanceDetail.replicaCount)} />
                    <DetailRow label="Location" value={instanceDetail.currentLocationId || instanceDetail.locationId || '-'} />
                    <DetailRow label="Alt Location" value={instanceDetail.alternativeLocationId || '-'} />
                    <DetailRow label="Created" value={formatDateTime(instanceDetail.createTime)} />
                  </div>

                  {/* Right column: persistence, maintenance, nodes */}
                  <div>
                    <h4 style={{ margin: '0 0 0.75rem' }}>Persistence</h4>
                    <DetailRow label="Mode" value={instanceDetail.persistenceConfig.persistenceMode || 'DISABLED'} />
                    {instanceDetail.persistenceConfig.persistenceMode && instanceDetail.persistenceConfig.persistenceMode !== 'DISABLED' && (
                      <>
                        <DetailRow label="Snapshot Period" value={instanceDetail.persistenceConfig.rdbSnapshotPeriod || '-'} />
                        <DetailRow label="Snapshot Start" value={instanceDetail.persistenceConfig.rdbSnapshotStartTime || '-'} />
                      </>
                    )}

                    <h4 style={{ margin: '1rem 0 0.75rem' }}>Maintenance</h4>
                    {instanceDetail.maintenancePolicy ? (
                      instanceDetail.maintenancePolicy.weeklyMaintenanceWindow.map((w, i) => (
                        <DetailRow key={i} label={`Window ${i + 1}`} value={`${w.day} ${w.startTime} (${w.duration})`} />
                      ))
                    ) : (
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No maintenance policy configured.</p>
                    )}
                    {instanceDetail.maintenanceSchedule && (
                      <>
                        <DetailRow label="Next Start" value={formatDateTime(instanceDetail.maintenanceSchedule.startTime)} />
                        <DetailRow label="Next End" value={formatDateTime(instanceDetail.maintenanceSchedule.endTime)} />
                      </>
                    )}

                    <h4 style={{ margin: '1rem 0 0.75rem' }}>Nodes ({instanceDetail.nodes.length})</h4>
                    {instanceDetail.nodes.length === 0 ? (
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No node information available.</p>
                    ) : (
                      instanceDetail.nodes.map((node) => (
                        <DetailRow key={node.id} label={node.id || 'Node'} value={node.zone || '-'} />
                      ))
                    )}

                    {Object.keys(instanceDetail.redisConfigs).length > 0 && (
                      <>
                        <h4 style={{ margin: '1rem 0 0.75rem' }}>Redis Config</h4>
                        {Object.entries(instanceDetail.redisConfigs).map(([k, v]) => (
                          <DetailRow key={k} label={k} value={v} />
                        ))}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
