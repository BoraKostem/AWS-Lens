import { useEffect, useMemo, useState } from 'react'

import type { GcpComputeInstanceSummary, GcpGkeClusterSummary, GcpSqlInstanceSummary } from '@shared/types'
import { listGcpComputeInstances, listGcpGkeClusters, listGcpSqlInstances } from './api'
import { FreshnessIndicator, useFreshnessState, type RefreshReason } from './freshness'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

type GcpEnableAction = {
  command: string
  summary: string
}

function extractQuotedCommand(value: string): string | null {
  const straight = value.match(/"([^"]+)"/)
  if (straight?.[1]?.trim()) {
    return straight[1].trim()
  }

  const curly = value.match(/[“”]([^“”]+)[“”]/)
  return curly?.[1]?.trim() ?? null
}

function getGcpApiEnableAction(error: string, fallbackCommand: string, summary: string): GcpEnableAction | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) {
    return null
  }

  return {
    command: extractQuotedCommand(error) ?? fallbackCommand,
    summary
  }
}

function uniq(values: string[]): number {
  return new Set(values.filter(Boolean)).size
}

function countBy<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.filter(predicate).length
}

function riskTone(level: 'low' | 'medium' | 'high'): string {
  if (level === 'high') return 'severity-high'
  if (level === 'medium') return 'severity-medium'
  return 'severity-low'
}

function formatTime(value: string): string {
  return value ? new Date(value).toLocaleTimeString() : 'Pending'
}

function mapCounts(values: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()

  for (const value of values) {
    const label = value.trim() || 'unspecified'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

function runTerminalAction(
  canRunTerminalCommand: boolean,
  command: string,
  summary: string,
  onRunTerminalCommand: (command: string) => void,
  setMessage: (message: string) => void
): void {
  if (!canRunTerminalCommand) {
    return
  }

  onRunTerminalCommand(command)
  setMessage(summary)
}

function instanceRiskNotes(instance: GcpComputeInstanceSummary): Array<{ label: string; tone: 'low' | 'medium' | 'high' }> {
  const notes: Array<{ label: string; tone: 'low' | 'medium' | 'high' }> = []
  const status = instance.status.trim().toUpperCase()

  if (instance.externalIp) {
    notes.push({ label: 'External IP exposed', tone: 'high' })
  }
  if (status !== 'RUNNING') {
    notes.push({ label: status ? `${status} lifecycle state` : 'Unknown lifecycle state', tone: 'medium' })
  }
  if (!instance.internalIp) {
    notes.push({ label: 'Missing internal IP', tone: 'medium' })
  }

  if (notes.length === 0) {
    notes.push({ label: 'No immediate exposure signal', tone: 'low' })
  }

  return notes
}

function clusterRiskNotes(cluster: GcpGkeClusterSummary): Array<{ label: string; tone: 'low' | 'medium' | 'high' }> {
  const notes: Array<{ label: string; tone: 'low' | 'medium' | 'high' }> = []
  const status = cluster.status.trim().toUpperCase()
  const releaseChannel = cluster.releaseChannel.trim().toLowerCase()
  const nodeCount = Number(cluster.nodeCount || '0')

  if (status !== 'RUNNING') {
    notes.push({ label: status ? `${status} control plane state` : 'Unknown control plane state', tone: 'high' })
  }
  if (!releaseChannel || releaseChannel === 'unspecified') {
    notes.push({ label: 'Release channel unspecified', tone: 'medium' })
  }
  if (Number.isFinite(nodeCount) && nodeCount === 0) {
    notes.push({ label: 'Node count is zero', tone: 'medium' })
  }
  if (!cluster.endpoint) {
    notes.push({ label: 'Endpoint missing from inventory', tone: 'medium' })
  }

  if (notes.length === 0) {
    notes.push({ label: 'Cluster posture looks stable', tone: 'low' })
  }

  return notes
}

function isCloudSqlRunnable(instance: GcpSqlInstanceSummary): boolean {
  return instance.state.trim().toUpperCase() === 'RUNNABLE'
}

function matchesLocationLens(instance: GcpSqlInstanceSummary, location: string): boolean {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return true
  }

  const region = instance.region.trim().toLowerCase()
  const zone = instance.zone.trim().toLowerCase()

  return region === normalizedLocation || zone === normalizedLocation || zone.startsWith(`${normalizedLocation}-`)
}

function sqlRiskNotes(instance: GcpSqlInstanceSummary): Array<{ label: string; tone: 'low' | 'medium' | 'high' }> {
  const notes: Array<{ label: string; tone: 'low' | 'medium' | 'high' }> = []

  if (!isCloudSqlRunnable(instance)) {
    notes.push({ label: instance.state ? `${instance.state} lifecycle state` : 'Unknown lifecycle state', tone: 'high' })
  }
  if (instance.primaryAddress) {
    notes.push({ label: 'Public IP exposed', tone: 'high' })
  }
  if (!instance.privateAddress) {
    notes.push({ label: 'Private IP unavailable', tone: 'medium' })
  }
  if (!instance.deletionProtectionEnabled) {
    notes.push({ label: 'Deletion protection disabled', tone: 'medium' })
  }
  if (!instance.storageAutoResizeEnabled) {
    notes.push({ label: 'Storage auto-resize disabled', tone: 'medium' })
  }
  if (!instance.maintenanceWindow) {
    notes.push({ label: 'Maintenance window not configured', tone: 'low' })
  }

  if (notes.length === 0) {
    notes.push({ label: 'Posture looks stable', tone: 'low' })
  }

  return notes
}

export function GcpComputeEngineConsolePage({
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
  const [instances, setInstances] = useState<GcpComputeInstanceSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped' | 'public' | 'private'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')
  const [message, setMessage] = useState('')
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  async function loadInventory(trigger: RefreshReason = 'initial'): Promise<void> {
    beginRefresh(trigger)
    setLoading(true)
    setError('')

    try {
      const nextInstances = await listGcpComputeInstances(projectId, location)
      setInstances(nextInstances)
      setSelectedName((current) => current && nextInstances.some((instance) => instance.name === current) ? current : (nextInstances[0]?.name ?? ''))
      setLastLoadedAt(new Date().toISOString())
      completeRefresh()
    } catch (err) {
      setInstances([])
      setSelectedName('')
      setError(err instanceof Error ? err.message : String(err))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadInventory()
  }, [location, projectId, refreshNonce])

  const filteredInstances = useMemo(() => {
    const query = search.trim().toLowerCase()

    return instances.filter((instance) => {
      if (statusFilter === 'running' && instance.status.trim().toUpperCase() !== 'RUNNING') return false
      if (statusFilter === 'stopped' && instance.status.trim().toUpperCase() === 'RUNNING') return false
      if (statusFilter === 'public' && !instance.externalIp) return false
      if (statusFilter === 'private' && Boolean(instance.externalIp)) return false
      if (!query) return true

      return [
        instance.name,
        instance.zone,
        instance.status,
        instance.machineType,
        instance.internalIp,
        instance.externalIp
      ].join(' ').toLowerCase().includes(query)
    })
  }, [instances, search, statusFilter])

  const selectedInstance = useMemo(
    () => filteredInstances.find((instance) => instance.name === selectedName)
      ?? instances.find((instance) => instance.name === selectedName)
      ?? filteredInstances[0]
      ?? instances[0]
      ?? null,
    [filteredInstances, instances, selectedName]
  )

  useEffect(() => {
    if (selectedInstance && selectedInstance.name !== selectedName) {
      setSelectedName(selectedInstance.name)
    }
  }, [selectedInstance, selectedName])

  const locationLabel = location.trim() || 'all locations'
  const runningCount = countBy(instances, (instance) => instance.status.trim().toUpperCase() === 'RUNNING')
  const publicCount = countBy(instances, (instance) => Boolean(instance.externalIp))
  const privateOnlyCount = countBy(instances, (instance) => !instance.externalIp)
  const zoneSpread = uniq(instances.map((instance) => instance.zone))
  const fleetHotspots = mapCounts(instances.map((instance) => instance.zone)).slice(0, 4)
  const enableAction = error ? getGcpApiEnableAction(
    error,
    `gcloud services enable compute.googleapis.com --project ${projectId}`,
    `Compute Engine API is disabled for project ${projectId}.`
  ) : null

  return (
    <div className="overview-surface gcp-runtime-console gcp-runtime-console-compute">
      {message ? <div className="success-banner">{message}</div> : null}
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
                  onClick={() => runTerminalAction(
                    canRunTerminalCommand,
                    enableAction.command,
                    'Enable command sent to the app terminal.',
                    onRunTerminalCommand,
                    setMessage
                  )}
                  title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode to enable terminal actions'}
                >
                  Run enable command
                </button>
              </div>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      <section className="overview-hero-card gcp-runtime-hero-card">
        <div className="overview-hero-copy">
          <div className="eyebrow">Compute Engine</div>
          <h3>{projectId}</h3>
          <p>Operator view for fleet posture, public exposure, per-instance drill-in, and `gcloud` handoff from the shared Google Cloud context.</p>
          <div className="overview-meta-strip">
            <div className="overview-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Selected instance</span>
              <strong>{selectedInstance?.name || 'None selected'}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Last sync</span>
              <strong>{loading ? 'Syncing...' : formatTime(lastLoadedAt)}</strong>
            </div>
          </div>
        </div>
        <div className="overview-hero-stats">
          <div className="overview-glance-card overview-glance-card-accent">
            <span>Total instances</span>
            <strong>{instances.length}</strong>
            <small>Fleet items in the selected location slice</small>
          </div>
          <div className="overview-glance-card">
            <span>Running</span>
            <strong>{runningCount}</strong>
            <small>Instances currently in `RUNNING` state</small>
          </div>
          <div className="overview-glance-card">
            <span>Public exposure</span>
            <strong>{publicCount}</strong>
            <small>Instances with an external IP attached</small>
          </div>
          <div className="overview-glance-card">
            <span>Zone spread</span>
            <strong>{zoneSpread}</strong>
            <small>Unique zones represented in this slice</small>
          </div>
        </div>
      </section>

      <section className="gcp-runtime-toolbar">
        <div className="gcp-runtime-toolbar-main">
          <button type="button" className="accent" disabled={loading} onClick={() => void loadInventory('manual')}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          <button
            type="button"
            disabled={!canRunTerminalCommand}
            onClick={() => runTerminalAction(
              canRunTerminalCommand,
              `gcloud compute instances list --project ${projectId} --format=json`,
              'Compute inventory command sent to the app terminal.',
              onRunTerminalCommand,
              setMessage
            )}
            title={canRunTerminalCommand ? `gcloud compute instances list --project ${projectId} --format=json` : 'Switch to Operator mode to enable terminal actions'}
          >
            List in terminal
          </button>
          <label className="field gcp-runtime-field">
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">All</option>
              <option value="running">Running</option>
              <option value="stopped">Non-running</option>
              <option value="public">Public IP</option>
              <option value="private">Private only</option>
            </select>
          </label>
          <label className="field gcp-runtime-field gcp-runtime-search">
            <span>Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, zone, IP, type" />
          </label>
        </div>
        <div className="gcp-runtime-toolbar-status">
          <FreshnessIndicator freshness={freshness} label="Compute inventory" staleLabel="Refresh inventory" />
        </div>
      </section>

      <section className="overview-tiles gcp-runtime-summary-grid">
        <div className="overview-tile highlight">
          <strong>{privateOnlyCount}</strong>
          <span>Private-only instances</span>
        </div>
        <div className="overview-tile">
          <strong>{instances.length - runningCount}</strong>
          <span>Non-running instances</span>
        </div>
        <div className="overview-tile">
          <strong>{fleetHotspots[0]?.label || '-'}</strong>
          <span>Most populated zone</span>
        </div>
        <div className="overview-tile">
          <strong>{selectedInstance?.machineType || '-'}</strong>
          <span>Selected machine type</span>
        </div>
      </section>

      {!loading && !instances.length && !error ? (
        <section className="panel stack">
          <SvcState variant="empty" message={`No Compute Engine instances were found for ${projectId} in ${locationLabel}.`} />
        </section>
      ) : null}

      {instances.length > 0 ? (
        <div className="gcp-runtime-layout">
          <section className="panel stack gcp-runtime-list-panel">
            <div className="panel-header">
              <h3>Instance inventory</h3>
              <span className="signal-region">{filteredInstances.length} shown</span>
            </div>
            <div className="gcp-runtime-list">
              {filteredInstances.map((instance) => (
                <button
                  key={`${instance.zone}:${instance.name}`}
                  type="button"
                  className={`gcp-runtime-card ${selectedInstance?.name === instance.name ? 'active' : ''}`}
                  onClick={() => setSelectedName(instance.name)}
                >
                  <div className="gcp-runtime-card-top">
                    <div className="gcp-runtime-card-copy">
                      <strong>{instance.name}</strong>
                      <span>{instance.machineType || 'Machine type unavailable'}</span>
                    </div>
                    <span className={`signal-badge ${instance.status.trim().toUpperCase() === 'RUNNING' ? 'severity-low' : 'severity-medium'}`}>
                      {instance.status || 'UNKNOWN'}
                    </span>
                  </div>
                  <div className="gcp-runtime-card-meta">
                    <span>{instance.zone || 'Unknown zone'}</span>
                    <span>{instance.internalIp || 'No internal IP'}</span>
                    <span>{instance.externalIp || 'Private only'}</span>
                  </div>
                </button>
              ))}
              {!filteredInstances.length ? <SvcState variant="no-filter-matches" resourceName="instances" compact /> : null}
            </div>
          </section>

          <section className="panel stack gcp-runtime-detail-panel">
            <div className="panel-header">
              <h3>{selectedInstance?.name || 'Instance detail'}</h3>
              {selectedInstance ? <span className="signal-region">{selectedInstance.zone}</span> : null}
            </div>

            {selectedInstance ? (
              <>
                <div className="gcp-runtime-detail-grid">
                  <div className="gcp-runtime-detail-card">
                    <span>Lifecycle</span>
                    <strong>{selectedInstance.status || 'UNKNOWN'}</strong>
                    <small>{selectedInstance.machineType || 'Machine type unavailable'}</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Internal IP</span>
                    <strong>{selectedInstance.internalIp || '-'}</strong>
                    <small>Primary NIC inside the VPC slice</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>External IP</span>
                    <strong>{selectedInstance.externalIp || 'None'}</strong>
                    <small>{selectedInstance.externalIp ? 'Publicly reachable address attached' : 'No public address attached'}</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Zone</span>
                    <strong>{selectedInstance.zone || '-'}</strong>
                    <small>Placement scope from the current inventory slice</small>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Risk notes</h3>
                  </div>
                  <div className="gcp-runtime-chip-row">
                    {instanceRiskNotes(selectedInstance).map((note) => (
                      <span key={note.label} className={`signal-badge ${riskTone(note.tone)}`}>{note.label}</span>
                    ))}
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Terminal handoff</h3>
                  </div>
                  <div className="gcp-runtime-action-grid">
                    <button
                      type="button"
                      className="accent"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud compute instances describe ${selectedInstance.name} --project ${projectId} --zone ${selectedInstance.zone} --format=json`,
                        `Describe command sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Describe instance
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand || selectedInstance.status.trim().toUpperCase() !== 'RUNNING'}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud compute ssh ${selectedInstance.name} --project ${projectId} --zone ${selectedInstance.zone}`,
                        `SSH handoff sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      SSH handoff
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud compute instances get-serial-port-output ${selectedInstance.name} --project ${projectId} --zone ${selectedInstance.zone} --port=1`,
                        `Serial output command sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Serial output
                    </button>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Fleet hotspots</h3>
                  </div>
                  <div className="gcp-runtime-distribution-list">
                    {fleetHotspots.map((zone) => (
                      <div key={zone.label} className="gcp-runtime-distribution-item">
                        <span>{zone.label}</span>
                        <strong>{zone.count}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <SvcState variant="no-selection" message="Select an instance to inspect posture and operator handoff actions." />
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}

export function GcpGkeConsolePage({
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
  const [clusters, setClusters] = useState<GcpGkeClusterSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'non-running' | 'rapid' | 'unspecified'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')
  const [message, setMessage] = useState('')
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  async function loadInventory(trigger: RefreshReason = 'initial'): Promise<void> {
    beginRefresh(trigger)
    setLoading(true)
    setError('')

    try {
      const nextClusters = await listGcpGkeClusters(projectId, location)
      setClusters(nextClusters)
      setSelectedName((current) => current && nextClusters.some((cluster) => cluster.name === current) ? current : (nextClusters[0]?.name ?? ''))
      setLastLoadedAt(new Date().toISOString())
      completeRefresh()
    } catch (err) {
      setClusters([])
      setSelectedName('')
      setError(err instanceof Error ? err.message : String(err))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadInventory()
  }, [location, projectId, refreshNonce])

  const filteredClusters = useMemo(() => {
    const query = search.trim().toLowerCase()

    return clusters.filter((cluster) => {
      const channel = cluster.releaseChannel.trim().toLowerCase() || 'unspecified'
      const isRunning = cluster.status.trim().toUpperCase() === 'RUNNING'

      if (statusFilter === 'running' && !isRunning) return false
      if (statusFilter === 'non-running' && isRunning) return false
      if (statusFilter === 'rapid' && channel !== 'rapid') return false
      if (statusFilter === 'unspecified' && channel !== 'unspecified') return false
      if (!query) return true

      return [
        cluster.name,
        cluster.location,
        cluster.status,
        cluster.masterVersion,
        cluster.releaseChannel,
        cluster.endpoint
      ].join(' ').toLowerCase().includes(query)
    })
  }, [clusters, search, statusFilter])

  const selectedCluster = useMemo(
    () => filteredClusters.find((cluster) => cluster.name === selectedName)
      ?? clusters.find((cluster) => cluster.name === selectedName)
      ?? filteredClusters[0]
      ?? clusters[0]
      ?? null,
    [clusters, filteredClusters, selectedName]
  )

  useEffect(() => {
    if (selectedCluster && selectedCluster.name !== selectedName) {
      setSelectedName(selectedCluster.name)
    }
  }, [selectedCluster, selectedName])

  const locationLabel = location.trim() || 'all locations'
  const runningCount = countBy(clusters, (cluster) => cluster.status.trim().toUpperCase() === 'RUNNING')
  const nonRunningCount = clusters.length - runningCount
  const releaseChannelSpread = uniq(clusters.map((cluster) => cluster.releaseChannel || 'unspecified'))
  const locationSpread = uniq(clusters.map((cluster) => cluster.location))
  const versionSpread = uniq(clusters.map((cluster) => cluster.masterVersion))
  const locationHotspots = mapCounts(clusters.map((cluster) => cluster.location)).slice(0, 4)
  const enableAction = error ? getGcpApiEnableAction(
    error,
    `gcloud services enable container.googleapis.com --project ${projectId}`,
    `GKE API is disabled for project ${projectId}.`
  ) : null

  return (
    <div className="overview-surface gcp-runtime-console gcp-runtime-console-gke">
      {message ? <div className="success-banner">{message}</div> : null}
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
                  onClick={() => runTerminalAction(
                    canRunTerminalCommand,
                    enableAction.command,
                    'Enable command sent to the app terminal.',
                    onRunTerminalCommand,
                    setMessage
                  )}
                  title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode to enable terminal actions'}
                >
                  Run enable command
                </button>
              </div>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      <section className="overview-hero-card gcp-runtime-hero-card">
        <div className="overview-hero-copy">
          <div className="eyebrow">GKE</div>
          <h3>{projectId}</h3>
          <p>Cluster posture view for release channels, version spread, selected-cluster drill-in, and `gcloud` handoff from the shared Google Cloud context.</p>
          <div className="overview-meta-strip">
            <div className="overview-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Selected cluster</span>
              <strong>{selectedCluster?.name || 'None selected'}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Last sync</span>
              <strong>{loading ? 'Syncing...' : formatTime(lastLoadedAt)}</strong>
            </div>
          </div>
        </div>
        <div className="overview-hero-stats">
          <div className="overview-glance-card overview-glance-card-accent">
            <span>Total clusters</span>
            <strong>{clusters.length}</strong>
            <small>Clusters in the selected location slice</small>
          </div>
          <div className="overview-glance-card">
            <span>Healthy</span>
            <strong>{runningCount}</strong>
            <small>Clusters currently in `RUNNING` state</small>
          </div>
          <div className="overview-glance-card">
            <span>Release channels</span>
            <strong>{releaseChannelSpread}</strong>
            <small>Unique channels represented in this slice</small>
          </div>
          <div className="overview-glance-card">
            <span>Version spread</span>
            <strong>{versionSpread}</strong>
            <small>Distinct control-plane versions surfaced</small>
          </div>
        </div>
      </section>

      <section className="gcp-runtime-toolbar">
        <div className="gcp-runtime-toolbar-main">
          <button type="button" className="accent" disabled={loading} onClick={() => void loadInventory('manual')}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          <button
            type="button"
            disabled={!canRunTerminalCommand}
            onClick={() => runTerminalAction(
              canRunTerminalCommand,
              `gcloud container clusters list --project ${projectId} --format=json`,
              'GKE inventory command sent to the app terminal.',
              onRunTerminalCommand,
              setMessage
            )}
            title={canRunTerminalCommand ? `gcloud container clusters list --project ${projectId} --format=json` : 'Switch to Operator mode to enable terminal actions'}
          >
            List in terminal
          </button>
          <label className="field gcp-runtime-field">
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">All</option>
              <option value="running">Running</option>
              <option value="non-running">Non-running</option>
              <option value="rapid">Rapid channel</option>
              <option value="unspecified">Unspecified channel</option>
            </select>
          </label>
          <label className="field gcp-runtime-field gcp-runtime-search">
            <span>Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, location, version, endpoint" />
          </label>
        </div>
        <div className="gcp-runtime-toolbar-status">
          <FreshnessIndicator freshness={freshness} label="GKE inventory" staleLabel="Refresh inventory" />
        </div>
      </section>

      <section className="overview-tiles gcp-runtime-summary-grid">
        <div className="overview-tile highlight">
          <strong>{nonRunningCount}</strong>
          <span>Non-running clusters</span>
        </div>
        <div className="overview-tile">
          <strong>{locationSpread}</strong>
          <span>Cluster locations</span>
        </div>
        <div className="overview-tile">
          <strong>{selectedCluster?.releaseChannel || 'unspecified'}</strong>
          <span>Selected release channel</span>
        </div>
        <div className="overview-tile">
          <strong>{selectedCluster?.masterVersion || '-'}</strong>
          <span>Selected control-plane version</span>
        </div>
      </section>

      {!loading && !clusters.length && !error ? (
        <section className="panel stack">
          <SvcState variant="empty" message={`No GKE clusters were found for ${projectId} in ${locationLabel}.`} />
        </section>
      ) : null}

      {clusters.length > 0 ? (
        <div className="gcp-runtime-layout">
          <section className="panel stack gcp-runtime-list-panel">
            <div className="panel-header">
              <h3>Cluster inventory</h3>
              <span className="signal-region">{filteredClusters.length} shown</span>
            </div>
            <div className="gcp-runtime-list">
              {filteredClusters.map((cluster) => (
                <button
                  key={`${cluster.location}:${cluster.name}`}
                  type="button"
                  className={`gcp-runtime-card ${selectedCluster?.name === cluster.name ? 'active' : ''}`}
                  onClick={() => setSelectedName(cluster.name)}
                >
                  <div className="gcp-runtime-card-top">
                    <div className="gcp-runtime-card-copy">
                      <strong>{cluster.name}</strong>
                      <span>{cluster.masterVersion ? `Master ${cluster.masterVersion}` : 'Master version unavailable'}</span>
                    </div>
                    <span className={`signal-badge ${cluster.status.trim().toUpperCase() === 'RUNNING' ? 'severity-low' : 'severity-high'}`}>
                      {cluster.status || 'UNKNOWN'}
                    </span>
                  </div>
                  <div className="gcp-runtime-card-meta">
                    <span>{cluster.location || 'Unknown location'}</span>
                    <span>{cluster.releaseChannel || 'unspecified'}</span>
                    <span>{cluster.nodeCount || '0'} nodes</span>
                  </div>
                </button>
              ))}
              {!filteredClusters.length ? <SvcState variant="no-filter-matches" resourceName="clusters" compact /> : null}
            </div>
          </section>

          <section className="panel stack gcp-runtime-detail-panel">
            <div className="panel-header">
              <h3>{selectedCluster?.name || 'Cluster detail'}</h3>
              {selectedCluster ? <span className="signal-region">{selectedCluster.location}</span> : null}
            </div>

            {selectedCluster ? (
              <>
                <div className="gcp-runtime-detail-grid">
                  <div className="gcp-runtime-detail-card">
                    <span>Lifecycle</span>
                    <strong>{selectedCluster.status || 'UNKNOWN'}</strong>
                    <small>{selectedCluster.nodeCount || '0'} node count reported by inventory</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Master version</span>
                    <strong>{selectedCluster.masterVersion || '-'}</strong>
                    <small>Control-plane version from current inventory</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Release channel</span>
                    <strong>{selectedCluster.releaseChannel || 'unspecified'}</strong>
                    <small>Upgrade track currently assigned to the cluster</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Endpoint</span>
                    <strong>{selectedCluster.endpoint || 'Unavailable'}</strong>
                    <small>Cluster API endpoint currently surfaced by inventory</small>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Risk notes</h3>
                  </div>
                  <div className="gcp-runtime-chip-row">
                    {clusterRiskNotes(selectedCluster).map((note) => (
                      <span key={note.label} className={`signal-badge ${riskTone(note.tone)}`}>{note.label}</span>
                    ))}
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Terminal handoff</h3>
                  </div>
                  <div className="gcp-runtime-action-grid">
                    <button
                      type="button"
                      className="accent"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud container clusters describe ${selectedCluster.name} --project ${projectId} --location ${selectedCluster.location} --format=json`,
                        `Describe command sent for ${selectedCluster.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Describe cluster
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud container clusters get-credentials ${selectedCluster.name} --project ${projectId} --location ${selectedCluster.location}`,
                        `Credentials handoff sent for ${selectedCluster.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Get credentials
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud container node-pools list --cluster ${selectedCluster.name} --project ${projectId} --location ${selectedCluster.location} --format=json`,
                        `Node pool inventory command sent for ${selectedCluster.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      List node pools
                    </button>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Fleet hotspots</h3>
                  </div>
                  <div className="gcp-runtime-distribution-list">
                    {locationHotspots.map((item) => (
                      <div key={item.label} className="gcp-runtime-distribution-item">
                        <span>{item.label}</span>
                        <strong>{item.count}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <SvcState variant="no-selection" message="Select a cluster to inspect posture and operator handoff actions." />
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}

export function GcpCloudSqlConsolePage({
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
  const [instances, setInstances] = useState<GcpSqlInstanceSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'runnable' | 'non-runnable' | 'public' | 'ha'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')
  const [message, setMessage] = useState('')
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  async function loadInventory(trigger: RefreshReason = 'initial'): Promise<void> {
    beginRefresh(trigger)
    setLoading(true)
    setError('')

    try {
      const nextInstances = await listGcpSqlInstances(projectId, location)
      setInstances(nextInstances)
      setSelectedName((current) => current && nextInstances.some((instance) => instance.name === current) ? current : (nextInstances[0]?.name ?? ''))
      setLastLoadedAt(new Date().toISOString())
      completeRefresh()
    } catch (err) {
      setInstances([])
      setSelectedName('')
      setError(err instanceof Error ? err.message : String(err))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadInventory()
  }, [location, projectId, refreshNonce])

  const filteredInstances = useMemo(() => {
    const query = search.trim().toLowerCase()

    return instances.filter((instance) => {
      const isRunnable = isCloudSqlRunnable(instance)
      const isPublic = Boolean(instance.primaryAddress)
      const isHa = instance.availabilityType.trim().toUpperCase() === 'REGIONAL'

      if (statusFilter === 'runnable' && !isRunnable) return false
      if (statusFilter === 'non-runnable' && isRunnable) return false
      if (statusFilter === 'public' && !isPublic) return false
      if (statusFilter === 'ha' && !isHa) return false
      if (!query) return true

      return [
        instance.name,
        instance.region,
        instance.zone,
        instance.state,
        instance.databaseVersion,
        instance.availabilityType,
        instance.primaryAddress,
        instance.privateAddress,
        instance.maintenanceWindow
      ].join(' ').toLowerCase().includes(query)
    })
  }, [instances, search, statusFilter])

  const selectedInstance = useMemo(
    () => filteredInstances.find((instance) => instance.name === selectedName)
      ?? instances.find((instance) => instance.name === selectedName)
      ?? filteredInstances[0]
      ?? instances[0]
      ?? null,
    [filteredInstances, instances, selectedName]
  )

  useEffect(() => {
    if (selectedInstance && selectedInstance.name !== selectedName) {
      setSelectedName(selectedInstance.name)
    }
  }, [selectedInstance, selectedName])

  const locationLabel = location.trim() || 'all locations'
  const runnableCount = countBy(instances, isCloudSqlRunnable)
  const publicCount = countBy(instances, (instance) => Boolean(instance.primaryAddress))
  const deletionProtectionCount = countBy(instances, (instance) => instance.deletionProtectionEnabled)
  const haCount = countBy(instances, (instance) => instance.availabilityType.trim().toUpperCase() === 'REGIONAL')
  const engineSpread = uniq(instances.map((instance) => instance.databaseVersion))
  const regionSpread = uniq(instances.map((instance) => instance.region))
  const inScopeCount = countBy(instances, (instance) => matchesLocationLens(instance, location))
  const regionHotspots = mapCounts(instances.map((instance) => instance.region)).slice(0, 4)
  const enableAction = error ? getGcpApiEnableAction(
    error,
    `gcloud services enable sqladmin.googleapis.com --project ${projectId}`,
    `Cloud SQL Admin API is disabled for project ${projectId}.`
  ) : null

  return (
    <div className="overview-surface gcp-runtime-console gcp-runtime-console-sql">
      {message ? <div className="success-banner">{message}</div> : null}
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
                  onClick={() => runTerminalAction(
                    canRunTerminalCommand,
                    enableAction.command,
                    'Enable command sent to the app terminal.',
                    onRunTerminalCommand,
                    setMessage
                  )}
                  title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode to enable terminal actions'}
                >
                  Run enable command
                </button>
              </div>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      <section className="overview-hero-card gcp-runtime-hero-card">
        <div className="overview-hero-copy">
          <div className="eyebrow">Cloud SQL</div>
          <h3>{projectId}</h3>
          <p>Operator view for database fleet posture, exposure review, HA coverage, and `gcloud sql` handoff from the shared Google Cloud context.</p>
          <div className="overview-meta-strip">
            <div className="overview-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Location lens</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Selected instance</span>
              <strong>{selectedInstance?.name || 'None selected'}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Last sync</span>
              <strong>{loading ? 'Syncing...' : formatTime(lastLoadedAt)}</strong>
            </div>
          </div>
        </div>
        <div className="overview-hero-stats">
          <div className="overview-glance-card overview-glance-card-accent">
            <span>Total instances</span>
            <strong>{instances.length}</strong>
            <small>Cloud SQL instances returned for this project</small>
          </div>
          <div className="overview-glance-card">
            <span>Runnable</span>
            <strong>{runnableCount}</strong>
            <small>Instances currently in `RUNNABLE` state</small>
          </div>
          <div className="overview-glance-card">
            <span>Public exposure</span>
            <strong>{publicCount}</strong>
            <small>Instances with a public primary address</small>
          </div>
          <div className="overview-glance-card">
            <span>HA coverage</span>
            <strong>{haCount}</strong>
            <small>Instances using regional availability</small>
          </div>
        </div>
      </section>

      <section className="gcp-runtime-toolbar">
        <div className="gcp-runtime-toolbar-main">
          <button type="button" className="accent" disabled={loading} onClick={() => void loadInventory('manual')}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          <button
            type="button"
            disabled={!canRunTerminalCommand}
            onClick={() => runTerminalAction(
              canRunTerminalCommand,
              `gcloud sql instances list --project ${projectId} --format=json`,
              'Cloud SQL inventory command sent to the app terminal.',
              onRunTerminalCommand,
              setMessage
            )}
            title={canRunTerminalCommand ? `gcloud sql instances list --project ${projectId} --format=json` : 'Switch to Operator mode to enable terminal actions'}
          >
            List in terminal
          </button>
          <label className="field gcp-runtime-field">
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">All</option>
              <option value="runnable">Runnable</option>
              <option value="non-runnable">Non-runnable</option>
              <option value="public">Public IP</option>
              <option value="ha">Regional HA</option>
            </select>
          </label>
          <label className="field gcp-runtime-field gcp-runtime-search">
            <span>Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, engine, region, IP, state" />
          </label>
        </div>
        <div className="gcp-runtime-toolbar-status">
          <FreshnessIndicator freshness={freshness} label="Cloud SQL inventory" staleLabel="Refresh inventory" />
        </div>
      </section>

      <section className="overview-tiles gcp-runtime-summary-grid">
        <div className="overview-tile highlight">
          <strong>{inScopeCount}</strong>
          <span>Aligned with location lens</span>
        </div>
        <div className="overview-tile">
          <strong>{deletionProtectionCount}</strong>
          <span>Deletion protection enabled</span>
        </div>
        <div className="overview-tile">
          <strong>{engineSpread}</strong>
          <span>Engine/version variants</span>
        </div>
        <div className="overview-tile">
          <strong>{regionSpread}</strong>
          <span>Regions represented</span>
        </div>
      </section>

      {!loading && !instances.length && !error ? (
        <section className="panel stack">
          <SvcState variant="empty" message={`No Cloud SQL instances were found for ${projectId} in ${locationLabel}.`} />
        </section>
      ) : null}

      {instances.length > 0 ? (
        <div className="gcp-runtime-layout">
          <section className="panel stack gcp-runtime-list-panel">
            <div className="panel-header">
              <h3>Instance inventory</h3>
              <span className="signal-region">{filteredInstances.length} shown</span>
            </div>
            <div className="gcp-runtime-list">
              {filteredInstances.map((instance) => (
                <button
                  key={instance.name}
                  type="button"
                  className={`gcp-runtime-card ${selectedInstance?.name === instance.name ? 'active' : ''}`}
                  onClick={() => setSelectedName(instance.name)}
                >
                  <div className="gcp-runtime-card-top">
                    <div className="gcp-runtime-card-copy">
                      <strong>{instance.name}</strong>
                      <span>{instance.databaseVersion || 'Engine unavailable'}</span>
                    </div>
                    <span className={`signal-badge ${isCloudSqlRunnable(instance) ? 'severity-low' : 'severity-high'}`}>
                      {instance.state || 'UNKNOWN'}
                    </span>
                  </div>
                  <div className="gcp-runtime-card-meta">
                    <span>{instance.region || 'Unknown region'}</span>
                    <span>{instance.availabilityType || 'Availability unknown'}</span>
                    <span>{instance.primaryAddress || instance.privateAddress || 'No IP address'}</span>
                  </div>
                </button>
              ))}
              {!filteredInstances.length ? <SvcState variant="no-filter-matches" resourceName="instances" compact /> : null}
            </div>
          </section>

          <section className="panel stack gcp-runtime-detail-panel">
            <div className="panel-header">
              <h3>{selectedInstance?.name || 'Instance detail'}</h3>
              {selectedInstance ? <span className="signal-region">{selectedInstance.region || selectedInstance.zone || 'Unknown location'}</span> : null}
            </div>

            {selectedInstance ? (
              <>
                <div className="gcp-runtime-detail-grid">
                  <div className="gcp-runtime-detail-card">
                    <span>Lifecycle</span>
                    <strong>{selectedInstance.state || 'UNKNOWN'}</strong>
                    <small>{selectedInstance.databaseVersion || 'Engine unavailable'}</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Availability</span>
                    <strong>{selectedInstance.availabilityType || 'Unspecified'}</strong>
                    <small>{selectedInstance.zone || selectedInstance.region || 'Location unavailable'}</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Public / private IP</span>
                    <strong>{selectedInstance.primaryAddress || 'No public IP'}</strong>
                    <small>{selectedInstance.privateAddress || 'No private IP'}</small>
                  </div>
                  <div className="gcp-runtime-detail-card">
                    <span>Disk / resize</span>
                    <strong>{selectedInstance.diskSizeGb ? `${selectedInstance.diskSizeGb} GB` : '-'}</strong>
                    <small>{selectedInstance.storageAutoResizeEnabled ? 'Auto-resize enabled' : 'Auto-resize disabled'}</small>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Risk notes</h3>
                  </div>
                  <div className="gcp-runtime-chip-row">
                    {sqlRiskNotes(selectedInstance).map((note) => (
                      <span key={note.label} className={`signal-badge ${riskTone(note.tone)}`}>{note.label}</span>
                    ))}
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Posture detail</h3>
                  </div>
                  <div className="gcp-runtime-distribution-list">
                    <div className="gcp-runtime-distribution-item">
                      <span>Deletion protection</span>
                      <strong>{selectedInstance.deletionProtectionEnabled ? 'Enabled' : 'Disabled'}</strong>
                    </div>
                    <div className="gcp-runtime-distribution-item">
                      <span>Maintenance</span>
                      <strong>{selectedInstance.maintenanceWindow || 'Not configured'}</strong>
                    </div>
                    <div className="gcp-runtime-distribution-item">
                      <span>Region</span>
                      <strong>{selectedInstance.region || 'Unknown'}</strong>
                    </div>
                    <div className="gcp-runtime-distribution-item">
                      <span>Zone</span>
                      <strong>{selectedInstance.zone || 'Unavailable'}</strong>
                    </div>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Terminal handoff</h3>
                  </div>
                  <div className="gcp-runtime-action-grid">
                    <button
                      type="button"
                      className="accent"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud sql instances describe ${selectedInstance.name} --project ${projectId} --format=json`,
                        `Describe command sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Describe instance
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud sql databases list --instance ${selectedInstance.name} --project ${projectId} --format=json`,
                        `Database inventory command sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      List databases
                    </button>
                    <button
                      type="button"
                      disabled={!canRunTerminalCommand}
                      onClick={() => runTerminalAction(
                        canRunTerminalCommand,
                        `gcloud sql operations list --instance ${selectedInstance.name} --project ${projectId} --limit=20 --format=json`,
                        `Operations command sent for ${selectedInstance.name}.`,
                        onRunTerminalCommand,
                        setMessage
                      )}
                    >
                      Recent operations
                    </button>
                  </div>
                </div>

                <div className="gcp-runtime-section">
                  <div className="panel-header minor">
                    <h3>Fleet hotspots</h3>
                  </div>
                  <div className="gcp-runtime-distribution-list">
                    {regionHotspots.map((item) => (
                      <div key={item.label} className="gcp-runtime-distribution-item">
                        <span>{item.label}</span>
                        <strong>{item.count}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <SvcState variant="no-selection" message="Select a Cloud SQL instance to inspect posture and operator handoff actions." />
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
