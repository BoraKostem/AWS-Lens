import { useEffect, useMemo, useState } from 'react'
import type {
  GcpMonitoringAlertPolicySummary,
  GcpMonitoringUptimeCheckSummary,
  GcpMonitoringMetricDescriptorSummary,
  GcpMonitoringTimeSeriesResult
} from '@shared/types'
import {
  listGcpMonitoringAlertPolicies,
  listGcpMonitoringUptimeChecks,
  listGcpMonitoringMetricDescriptors,
  queryGcpMonitoringTimeSeries
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Types ──────────────────────────────────────────── */

type MainTab = 'alerts' | 'uptime' | 'metrics'

const MAIN_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'alerts', label: 'Alert Policies' },
  { id: 'uptime', label: 'Uptime Checks' },
  { id: 'metrics', label: 'Metrics' }
]

/* ── Helpers ────────────────────────────────────────── */

function extractQuotedCommand(error: string): string | null {
  const straight = error.match(/Run "([^"]+)"/)
  if (straight?.[1]?.trim()) return straight[1].trim()
  const curly = error.match(/Run \u201c([^\u201d]+)\u201d/)
  return curly?.[1]?.trim() ?? null
}

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  const cmd = extractQuotedCommand(error)
  return { command: cmd ?? fallbackCommand, summary }
}

function formatDateTime(value: string): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatTimestamp(value: string): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function truncate(value: string, max = 48): string {
  if (!value) return '-'
  if (value.length <= max) return value
  return value.slice(0, max - 3) + '...'
}

/* ── Sub-components ─────────────────────────────────── */

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={`eks-badge ${enabled ? 'success' : 'warning'}`}>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  )
}

function ProtocolBadge({ protocol }: { protocol: string }) {
  const tone = protocol.toUpperCase() === 'HTTPS' ? 'success'
    : protocol.toUpperCase() === 'HTTP' ? 'info'
    : protocol.toUpperCase() === 'TCP' ? 'warning'
    : 'info'
  return <span className={`eks-badge ${tone}`}>{protocol || 'UNKNOWN'}</span>
}

function MetricKindBadge({ kind }: { kind: string }) {
  const tone = kind === 'GAUGE' ? 'info'
    : kind === 'DELTA' ? 'success'
    : kind === 'CUMULATIVE' ? 'warning'
    : 'info'
  return <span className={`eks-badge ${tone}`}>{kind || '-'}</span>
}

/* ── Alerts Tab ─────────────────────────────────────── */

function AlertsTab({
  policies,
  loading,
  error,
  selectedPolicy,
  onSelect
}: {
  policies: GcpMonitoringAlertPolicySummary[]
  loading: boolean
  error: string
  selectedPolicy: GcpMonitoringAlertPolicySummary | null
  onSelect: (policy: GcpMonitoringAlertPolicySummary | null) => void
}) {
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    if (!filter.trim()) return policies
    const query = filter.trim().toLowerCase()
    return policies.filter(
      (p) =>
        p.displayName.toLowerCase().includes(query) ||
        p.name.toLowerCase().includes(query) ||
        p.combiner.toLowerCase().includes(query)
    )
  }, [policies, filter])

  if (loading) return <SvcState variant="loading" resourceName="alert policies" compact />
  if (error) return <SvcState variant="error" error={error} compact />
  if (policies.length === 0) return <SvcState variant="empty" resourceName="alert policies" />

  return (
    <div className="gcp-monitoring-tab-content">
      <div className="gcp-monitoring-filter-row">
        <input
          className="iam-section-search"
          placeholder="Filter alert policies..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="iam-layout">
        <div className="iam-table-area">
          <table className="svc-table">
            <thead>
              <tr>
                <th>Policy Name</th>
                <th>Enabled</th>
                <th>Conditions</th>
                <th>Channels</th>
                <th>Combiner</th>
                <th>Last Modified</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: '#6b7688' }}>
                    No policies match the current filter.
                  </td>
                </tr>
              )}
              {filtered.map((policy) => (
                <tr
                  key={policy.name}
                  className={selectedPolicy?.name === policy.name ? 'selected' : ''}
                  onClick={() => onSelect(selectedPolicy?.name === policy.name ? null : policy)}
                  style={{ cursor: 'pointer' }}
                >
                  <td title={policy.name}>{truncate(policy.displayName || policy.name)}</td>
                  <td><EnabledBadge enabled={policy.enabled} /></td>
                  <td>{policy.conditionCount}</td>
                  <td>{policy.notificationChannelCount}</td>
                  <td>{policy.combiner || '-'}</td>
                  <td>{formatDateTime(policy.mutationTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedPolicy && (
          <div className="iam-detail-area">
            <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Policy Detail</div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Full Name</div>
              <div className="eks-kv-value">{selectedPolicy.name}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Display Name</div>
              <div className="eks-kv-value">{selectedPolicy.displayName || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Enabled</div>
              <div className="eks-kv-value"><EnabledBadge enabled={selectedPolicy.enabled} /></div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Conditions</div>
              <div className="eks-kv-value">{selectedPolicy.conditionCount}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Notification Channels</div>
              <div className="eks-kv-value">{selectedPolicy.notificationChannelCount}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Combiner</div>
              <div className="eks-kv-value">{selectedPolicy.combiner || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Created</div>
              <div className="eks-kv-value">{formatDateTime(selectedPolicy.creationTime)}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Last Modified</div>
              <div className="eks-kv-value">{formatDateTime(selectedPolicy.mutationTime)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Uptime Tab ─────────────────────────────────────── */

function UptimeTab({
  checks,
  loading,
  error,
  selectedCheck,
  onSelect
}: {
  checks: GcpMonitoringUptimeCheckSummary[]
  loading: boolean
  error: string
  selectedCheck: GcpMonitoringUptimeCheckSummary | null
  onSelect: (check: GcpMonitoringUptimeCheckSummary | null) => void
}) {
  const [filter, setFilter] = useState('')

  const filtered = useMemo(() => {
    if (!filter.trim()) return checks
    const query = filter.trim().toLowerCase()
    return checks.filter(
      (c) =>
        c.displayName.toLowerCase().includes(query) ||
        c.name.toLowerCase().includes(query) ||
        c.protocol.toLowerCase().includes(query) ||
        c.monitoredResource.toLowerCase().includes(query)
    )
  }, [checks, filter])

  if (loading) return <SvcState variant="loading" resourceName="uptime checks" compact />
  if (error) return <SvcState variant="error" error={error} compact />
  if (checks.length === 0) return <SvcState variant="empty" resourceName="uptime checks" />

  return (
    <div className="gcp-monitoring-tab-content">
      <div className="gcp-monitoring-filter-row">
        <input
          className="iam-section-search"
          placeholder="Filter uptime checks..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="iam-layout">
        <div className="iam-table-area">
          <table className="svc-table">
            <thead>
              <tr>
                <th>Check Name</th>
                <th>Protocol</th>
                <th>Period</th>
                <th>Timeout</th>
                <th>Regions</th>
                <th>Internal</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: '#6b7688' }}>
                    No uptime checks match the current filter.
                  </td>
                </tr>
              )}
              {filtered.map((check) => (
                <tr
                  key={check.name}
                  className={selectedCheck?.name === check.name ? 'selected' : ''}
                  onClick={() => onSelect(selectedCheck?.name === check.name ? null : check)}
                  style={{ cursor: 'pointer' }}
                >
                  <td title={check.name}>{truncate(check.displayName || check.name)}</td>
                  <td><ProtocolBadge protocol={check.protocol} /></td>
                  <td>{check.period || '-'}</td>
                  <td>{check.timeout || '-'}</td>
                  <td>{check.selectedRegions.length > 0 ? check.selectedRegions.join(', ') : 'All'}</td>
                  <td>{check.isInternal ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedCheck && (
          <div className="iam-detail-area">
            <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Uptime Check Detail</div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Full Name</div>
              <div className="eks-kv-value">{selectedCheck.name}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Display Name</div>
              <div className="eks-kv-value">{selectedCheck.displayName || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Monitored Resource</div>
              <div className="eks-kv-value">{selectedCheck.monitoredResource || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Protocol</div>
              <div className="eks-kv-value"><ProtocolBadge protocol={selectedCheck.protocol} /></div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Period</div>
              <div className="eks-kv-value">{selectedCheck.period || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Timeout</div>
              <div className="eks-kv-value">{selectedCheck.timeout || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Selected Regions</div>
              <div className="eks-kv-value">
                {selectedCheck.selectedRegions.length > 0
                  ? selectedCheck.selectedRegions.join(', ')
                  : 'All regions'}
              </div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Internal</div>
              <div className="eks-kv-value">{selectedCheck.isInternal ? 'Yes' : 'No'}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Metrics Tab ────────────────────────────────────── */

function MetricsTab({
  projectId,
  descriptors,
  loading,
  error
}: {
  projectId: string
  descriptors: GcpMonitoringMetricDescriptorSummary[]
  loading: boolean
  error: string
}) {
  const [filter, setFilter] = useState('')
  const [selectedMetric, setSelectedMetric] = useState<GcpMonitoringMetricDescriptorSummary | null>(null)
  const [timeSeries, setTimeSeries] = useState<GcpMonitoringTimeSeriesResult[]>([])
  const [tsLoading, setTsLoading] = useState(false)
  const [tsError, setTsError] = useState('')

  const filtered = useMemo(() => {
    if (!filter.trim()) return descriptors
    const query = filter.trim().toLowerCase()
    return descriptors.filter(
      (d) =>
        d.type.toLowerCase().includes(query) ||
        d.displayName.toLowerCase().includes(query) ||
        d.description.toLowerCase().includes(query)
    )
  }, [descriptors, filter])

  async function handleSelectMetric(descriptor: GcpMonitoringMetricDescriptorSummary | null): Promise<void> {
    if (!descriptor || selectedMetric?.type === descriptor.type) {
      setSelectedMetric(null)
      setTimeSeries([])
      setTsError('')
      return
    }

    setSelectedMetric(descriptor)
    setTsLoading(true)
    setTsError('')
    setTimeSeries([])

    try {
      const results = await queryGcpMonitoringTimeSeries(projectId, descriptor.type, 60)
      setTimeSeries(results)
    } catch (e) {
      setTsError(e instanceof Error ? e.message : String(e))
    } finally {
      setTsLoading(false)
    }
  }

  if (loading) return <SvcState variant="loading" resourceName="metric descriptors" compact />
  if (error) return <SvcState variant="error" error={error} compact />
  if (descriptors.length === 0) return <SvcState variant="empty" resourceName="metric descriptors" />

  return (
    <div className="gcp-monitoring-tab-content">
      <div className="gcp-monitoring-filter-row">
        <input
          className="iam-section-search"
          placeholder="Search metric descriptors by name..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ minWidth: 280 }}
        />
      </div>

      <div className="iam-layout">
        <div className="iam-table-area">
          <table className="svc-table">
            <thead>
              <tr>
                <th>Metric Type</th>
                <th>Display Name</th>
                <th>Kind</th>
                <th>Value Type</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: '#6b7688' }}>
                    No metric descriptors match the current filter.
                  </td>
                </tr>
              )}
              {filtered.map((descriptor) => (
                <tr
                  key={descriptor.type}
                  className={selectedMetric?.type === descriptor.type ? 'selected' : ''}
                  onClick={() => void handleSelectMetric(
                    selectedMetric?.type === descriptor.type ? null : descriptor
                  )}
                  style={{ cursor: 'pointer' }}
                >
                  <td title={descriptor.type}>{truncate(descriptor.type, 52)}</td>
                  <td>{truncate(descriptor.displayName, 36)}</td>
                  <td><MetricKindBadge kind={descriptor.metricKind} /></td>
                  <td>{descriptor.valueType || '-'}</td>
                  <td>{descriptor.unit || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedMetric && (
          <div className="iam-detail-area">
            <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Metric Detail</div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Type</div>
              <div className="eks-kv-value">{selectedMetric.type}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Display Name</div>
              <div className="eks-kv-value">{selectedMetric.displayName || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Description</div>
              <div className="eks-kv-value">{selectedMetric.description || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Kind</div>
              <div className="eks-kv-value"><MetricKindBadge kind={selectedMetric.metricKind} /></div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Value Type</div>
              <div className="eks-kv-value">{selectedMetric.valueType || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Unit</div>
              <div className="eks-kv-value">{selectedMetric.unit || '-'}</div>
            </div>
            <div className="eks-kv-row">
              <div className="eks-kv-label">Launch Stage</div>
              <div className="eks-kv-value">{selectedMetric.launchStage || '-'}</div>
            </div>

            {/* Time series results section */}
            <div style={{ marginTop: 16 }}>
              <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>
                Time Series (last 60 min)
              </div>

              {tsLoading && <SvcState variant="loading" resourceName="time series" compact />}
              {!tsLoading && tsError && <SvcState variant="error" error={tsError} compact />}
              {!tsLoading && !tsError && timeSeries.length === 0 && (
                <SvcState variant="empty" message="No time series data returned for this metric in the last 60 minutes." compact />
              )}
              {!tsLoading && !tsError && timeSeries.length > 0 && (
                <div className="gcp-monitoring-ts-results">
                  {timeSeries.map((series, seriesIdx) => (
                    <div key={seriesIdx} className="gcp-monitoring-ts-series">
                      <div className="gcp-monitoring-ts-header">
                        <span className="gcp-monitoring-ts-metric">{series.metric}</span>
                        <span className="gcp-monitoring-ts-resource">{series.resource}</span>
                      </div>
                      {series.points.length > 0 ? (
                        <table className="svc-table" style={{ fontSize: '0.78rem' }}>
                          <thead>
                            <tr>
                              <th>Timestamp</th>
                              <th>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {series.points.map((point, pointIdx) => (
                              <tr key={pointIdx}>
                                <td>{formatTimestamp(point.timestamp)}</td>
                                <td>{point.value}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div style={{ color: '#6b7688', fontSize: '0.82rem', padding: '6px 0' }}>
                          No data points in this series.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Main Console Component ─────────────────────────── */

export function GcpMonitoringConsole({
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
  const [mainTab, setMainTab] = useState<MainTab>('alerts')
  const [tabsOpen, setTabsOpen] = useState(true)

  /* Alert policies */
  const [alertPolicies, setAlertPolicies] = useState<GcpMonitoringAlertPolicySummary[]>([])
  const [alertsLoading, setAlertsLoading] = useState(true)
  const [alertsError, setAlertsError] = useState('')
  const [selectedPolicy, setSelectedPolicy] = useState<GcpMonitoringAlertPolicySummary | null>(null)

  /* Uptime checks */
  const [uptimeChecks, setUptimeChecks] = useState<GcpMonitoringUptimeCheckSummary[]>([])
  const [uptimeLoading, setUptimeLoading] = useState(true)
  const [uptimeError, setUptimeError] = useState('')
  const [selectedCheck, setSelectedCheck] = useState<GcpMonitoringUptimeCheckSummary | null>(null)

  /* Metric descriptors */
  const [metricDescriptors, setMetricDescriptors] = useState<GcpMonitoringMetricDescriptorSummary[]>([])
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [metricsError, setMetricsError] = useState('')

  /* Shared error (for API-not-enabled banner) */
  const [globalError, setGlobalError] = useState('')
  const [message, setMessage] = useState('')

  /* ── Data loading ─────────────────────────────────── */

  useEffect(() => {
    let cancelled = false

    async function loadAll(): Promise<void> {
      setAlertsLoading(true)
      setUptimeLoading(true)
      setMetricsLoading(true)
      setAlertsError('')
      setUptimeError('')
      setMetricsError('')
      setGlobalError('')

      const results = await Promise.allSettled([
        listGcpMonitoringAlertPolicies(projectId),
        listGcpMonitoringUptimeChecks(projectId),
        listGcpMonitoringMetricDescriptors(projectId)
      ])

      if (cancelled) return

      /* Alert policies */
      if (results[0].status === 'fulfilled') {
        setAlertPolicies(results[0].value)
      } else {
        const err = results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason)
        setAlertsError(err)
        setGlobalError((prev) => prev || err)
      }
      setAlertsLoading(false)

      /* Uptime checks */
      if (results[1].status === 'fulfilled') {
        setUptimeChecks(results[1].value)
      } else {
        const err = results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)
        setUptimeError(err)
        setGlobalError((prev) => prev || err)
      }
      setUptimeLoading(false)

      /* Metric descriptors */
      if (results[2].status === 'fulfilled') {
        setMetricDescriptors(results[2].value)
      } else {
        const err = results[2].reason instanceof Error ? results[2].reason.message : String(results[2].reason)
        setMetricsError(err)
        setGlobalError((prev) => prev || err)
      }
      setMetricsLoading(false)
    }

    void loadAll()
    return () => { cancelled = true }
  }, [projectId, refreshNonce])

  /* ── Refresh handler ──────────────────────────────── */

  function handleRefresh(): void {
    setSelectedPolicy(null)
    setSelectedCheck(null)
    setMessage('')

    setAlertsLoading(true)
    setUptimeLoading(true)
    setMetricsLoading(true)
    setAlertsError('')
    setUptimeError('')
    setMetricsError('')
    setGlobalError('')

    Promise.allSettled([
      listGcpMonitoringAlertPolicies(projectId),
      listGcpMonitoringUptimeChecks(projectId),
      listGcpMonitoringMetricDescriptors(projectId)
    ]).then((results) => {
      if (results[0].status === 'fulfilled') {
        setAlertPolicies(results[0].value)
      } else {
        const err = results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason)
        setAlertsError(err)
        setGlobalError((prev) => prev || err)
      }
      setAlertsLoading(false)

      if (results[1].status === 'fulfilled') {
        setUptimeChecks(results[1].value)
      } else {
        const err = results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)
        setUptimeError(err)
        setGlobalError((prev) => prev || err)
      }
      setUptimeLoading(false)

      if (results[2].status === 'fulfilled') {
        setMetricDescriptors(results[2].value)
      } else {
        const err = results[2].reason instanceof Error ? results[2].reason.message : String(results[2].reason)
        setMetricsError(err)
        setGlobalError((prev) => prev || err)
      }
      setMetricsLoading(false)
    })
  }

  /* ── Derived values ───────────────────────────────── */

  const locationLabel = location.trim() || 'global'
  const enabledPolicies = alertPolicies.filter((p) => p.enabled).length
  const totalPolicies = alertPolicies.length
  const totalUptimeChecks = uptimeChecks.length
  const isLoading = alertsLoading || uptimeLoading || metricsLoading

  const enableAction = globalError
    ? getGcpApiEnableAction(
        globalError,
        `gcloud services enable monitoring.googleapis.com --project ${projectId}`,
        `Cloud Monitoring API is disabled for project ${projectId}.`
      )
    : null

  /* ── Render ───────────────────────────────────────── */

  return (
    <div className="svc-console gcp-runtime-console gcp-monitoring-console">
      {/* ── Hero ──────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Observability posture</div>
          <h2>Cloud Monitoring</h2>
          <p>
            Inspect alert policies, uptime checks, and metric descriptors for the active project.
            Query live time series data for any registered metric.
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
              <span>Alerts</span>
              <strong>{isLoading ? '...' : `${enabledPolicies} / ${totalPolicies}`}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Uptime</span>
              <strong>{isLoading ? '...' : String(totalUptimeChecks)}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Active surface</span>
            <strong>{MAIN_TABS.find((t) => t.id === mainTab)?.label ?? 'Monitoring'}</strong>
            <small>{isLoading ? 'Refreshing live data now' : 'Workspace ready for review'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Alert policies</span>
            <strong>{isLoading ? '...' : totalPolicies}</strong>
            <small>{enabledPolicies} enabled, {totalPolicies - enabledPolicies} disabled</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Uptime checks</span>
            <strong>{isLoading ? '...' : totalUptimeChecks}</strong>
            <small>Configured uptime check configurations</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Metric descriptors</span>
            <strong>{isLoading ? '...' : metricDescriptors.length}</strong>
            <small>Registered metric types in scope</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ───────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <div className="iam-tab-bar">
          <button
            className="svc-tab-hamburger"
            type="button"
            onClick={() => setTabsOpen((prev) => !prev)}
          >
            <span className={'hamburger-icon ' + (tabsOpen ? 'open' : '')}>
              <span /><span /><span />
            </span>
          </button>
          {tabsOpen &&
            MAIN_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`svc-tab ${mainTab === t.id ? 'active' : ''}`}
                onClick={() => setMainTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          {tabsOpen && (
            <button
              className="svc-tab"
              type="button"
              disabled={isLoading}
              onClick={handleRefresh}
              style={{ marginLeft: 'auto' }}
            >
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          )}
        </div>
      </div>

      {/* ── API-not-enabled banner ────────────────────── */}
      {enableAction && (
        <div className="ec2-msg gcp-ec2-msg error">
          <div className="gcp-enable-error-banner">
            <div className="gcp-enable-error-copy">
              <strong>{enableAction.summary}</strong>
              <p>Enable the API once, wait for propagation, then refresh the inventory.</p>
            </div>
            <pre className="gcp-runtime-code-block">{enableAction.command}</pre>
            {canRunTerminalCommand && (
              <button
                className="svc-btn success"
                type="button"
                onClick={() => {
                  onRunTerminalCommand(enableAction.command)
                  setMessage('Sent enable command to terminal.')
                }}
              >
                Run in terminal
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Message banner ────────────────────────────── */}
      {message && <div className="success-banner">{message}</div>}

      {/* ── Tab content ───────────────────────────────── */}
      {mainTab === 'alerts' && (
        <AlertsTab
          policies={alertPolicies}
          loading={alertsLoading}
          error={!enableAction ? alertsError : ''}
          selectedPolicy={selectedPolicy}
          onSelect={setSelectedPolicy}
        />
      )}

      {mainTab === 'uptime' && (
        <UptimeTab
          checks={uptimeChecks}
          loading={uptimeLoading}
          error={!enableAction ? uptimeError : ''}
          selectedCheck={selectedCheck}
          onSelect={setSelectedCheck}
        />
      )}

      {mainTab === 'metrics' && (
        <MetricsTab
          projectId={projectId}
          descriptors={metricDescriptors}
          loading={metricsLoading}
          error={!enableAction ? metricsError : ''}
        />
      )}
    </div>
  )
}
