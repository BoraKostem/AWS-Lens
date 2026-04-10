import { useEffect, useMemo, useState } from 'react'
import type {
  GcpCloudRunServiceSummary,
  GcpCloudRunRevisionSummary,
  GcpCloudRunJobSummary,
  GcpCloudRunExecutionSummary,
  GcpCloudRunDomainMappingSummary,
  GcpCloudRunCondition
} from '@shared/types'
import {
  listGcpCloudRunServices,
  listGcpCloudRunRevisions,
  listGcpCloudRunJobs,
  listGcpCloudRunExecutions,
  listGcpCloudRunDomainMappings
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Types ──────────────────────────────────────────── */

type MainTab = 'services' | 'revisions' | 'jobs' | 'domains'

const MAIN_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'services', label: 'Services' },
  { id: 'revisions', label: 'Revisions' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'domains', label: 'Domain Mappings' }
]

/* ── Helpers ─────────────────────────────────────────── */

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

function formatDateTime(value: string): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function trunc(s: string, n = 40): string {
  if (!s) return '-'
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s
}

function errMsg(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function conditionBadgeTone(state: string): string {
  const s = state?.toUpperCase()
  if (s === 'CONDITION_SUCCEEDED' || s === 'ACTIVE' || s === 'READY') return 'status-ok'
  if (s === 'CONDITION_FAILED' || s === 'FALSE') return 'status-error'
  if (s === 'CONDITION_RECONCILING' || s === 'UNKNOWN') return 'status-warn'
  return ''
}

function executionStatusLabel(exec: GcpCloudRunExecutionSummary): string {
  if (exec.failedCount > 0) return 'Failed'
  if (exec.runningCount > 0) return 'Running'
  if (exec.succeededCount > 0 && exec.runningCount === 0) return 'Succeeded'
  if (exec.cancelledCount > 0) return 'Cancelled'
  return 'Pending'
}

function executionStatusTone(exec: GcpCloudRunExecutionSummary): string {
  if (exec.failedCount > 0) return 'status-error'
  if (exec.runningCount > 0) return 'status-warn'
  if (exec.succeededCount > 0) return 'status-ok'
  return ''
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="eks-kv-row">
      <div className="eks-kv-label">{label}</div>
      <div className="eks-kv-value">{value || '-'}</div>
    </div>
  )
}

function ConditionsTable({ conditions }: { conditions: GcpCloudRunCondition[] }) {
  if (!conditions || conditions.length === 0) {
    return <div style={{ color: '#8fa3ba', fontSize: '0.78rem', padding: '8px 0' }}>No conditions available.</div>
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div
        className="table-head"
        style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 3fr', gap: '1rem', padding: '0.5rem 1rem' }}
      >
        <span>Type</span>
        <span>State</span>
        <span>Message</span>
      </div>
      {conditions.map((c, i) => (
        <div
          key={`${c.type}-${i}`}
          className="table-row"
          style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 3fr', gap: '1rem', padding: '0.4rem 1rem' }}
        >
          <span>{c.type}</span>
          <span className={`status-badge ${conditionBadgeTone(c.state)}`}>{c.state || '-'}</span>
          <span style={{ color: '#98afc3', fontSize: '0.82rem' }}>{c.message || '-'}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Component ───────────────────────────────────────── */

export function GcpCloudRunConsole({
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
  const [mainTab, setMainTab] = useState<MainTab>('services')
  const [tabsOpen, setTabsOpen] = useState(true)

  /* ── Top-level data ──────────────────────────────────── */
  const [services, setServices] = useState<GcpCloudRunServiceSummary[]>([])
  const [jobs, setJobs] = useState<GcpCloudRunJobSummary[]>([])
  const [domainMappings, setDomainMappings] = useState<GcpCloudRunDomainMappingSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  /* ── Selection state ─────────────────────────────────── */
  const [selectedService, setSelectedService] = useState<GcpCloudRunServiceSummary | null>(null)
  const [selectedJob, setSelectedJob] = useState<GcpCloudRunJobSummary | null>(null)
  const [selectedDomain, setSelectedDomain] = useState<GcpCloudRunDomainMappingSummary | null>(null)

  /* ── Revision state (loaded per service) ─────────────── */
  const [revisions, setRevisions] = useState<GcpCloudRunRevisionSummary[]>([])
  const [revisionsLoading, setRevisionsLoading] = useState(false)
  const [revisionsError, setRevisionsError] = useState('')
  const [selectedRevision, setSelectedRevision] = useState<GcpCloudRunRevisionSummary | null>(null)

  /* ── Execution state (loaded per job) ────────────────── */
  const [executions, setExecutions] = useState<GcpCloudRunExecutionSummary[]>([])
  const [executionsLoading, setExecutionsLoading] = useState(false)
  const [executionsError, setExecutionsError] = useState('')
  const [selectedExecution, setSelectedExecution] = useState<GcpCloudRunExecutionSummary | null>(null)

  /* ── Filters ─────────────────────────────────────────── */
  const [serviceFilter, setServiceFilter] = useState('')
  const [jobFilter, setJobFilter] = useState('')
  const [domainFilter, setDomainFilter] = useState('')

  /* ── Primary data fetch ──────────────────────────────── */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    Promise.all([
      listGcpCloudRunServices(projectId, location),
      listGcpCloudRunJobs(projectId, location),
      listGcpCloudRunDomainMappings(projectId, location)
    ])
      .then(([svcResult, jobResult, domainResult]) => {
        if (cancelled) return
        setServices(svcResult)
        setJobs(jobResult)
        setDomainMappings(domainResult)
      })
      .catch((err) => {
        if (cancelled) return
        setError(errMsg(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, location, refreshNonce])

  /* ── Load revisions when a service is selected ───────── */
  useEffect(() => {
    if (!selectedService) {
      setRevisions([])
      setSelectedRevision(null)
      setRevisionsError('')
      return
    }

    let cancelled = false
    setRevisionsLoading(true)
    setRevisionsError('')
    setRevisions([])
    setSelectedRevision(null)

    listGcpCloudRunRevisions(projectId, location, selectedService.serviceId)
      .then((result) => {
        if (!cancelled) setRevisions(result)
      })
      .catch((err) => {
        if (!cancelled) setRevisionsError(errMsg(err))
      })
      .finally(() => {
        if (!cancelled) setRevisionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, location, selectedService?.serviceId])

  /* ── Load executions when a job is selected ──────────── */
  useEffect(() => {
    if (!selectedJob) {
      setExecutions([])
      setSelectedExecution(null)
      setExecutionsError('')
      return
    }

    let cancelled = false
    setExecutionsLoading(true)
    setExecutionsError('')
    setExecutions([])
    setSelectedExecution(null)

    listGcpCloudRunExecutions(projectId, location, selectedJob.jobId)
      .then((result) => {
        if (!cancelled) setExecutions(result)
      })
      .catch((err) => {
        if (!cancelled) setExecutionsError(errMsg(err))
      })
      .finally(() => {
        if (!cancelled) setExecutionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId, location, selectedJob?.jobId])

  /* ── Derived / memoized data ─────────────────────────── */

  const locationLabel = location.trim() || 'global'

  const activeRevisionCount = useMemo(
    () =>
      services.filter((s) =>
        s.conditions.some((c) => c.type === 'Ready' && c.state?.toUpperCase().includes('SUCCEEDED'))
      ).length,
    [services]
  )

  const filteredServices = useMemo(() => {
    if (!serviceFilter.trim()) return services
    const q = serviceFilter.trim().toLowerCase()
    return services.filter(
      (s) =>
        s.serviceId.toLowerCase().includes(q) ||
        s.containerImage.toLowerCase().includes(q) ||
        s.uri.toLowerCase().includes(q) ||
        s.ingressSetting.toLowerCase().includes(q)
    )
  }, [services, serviceFilter])

  const filteredJobs = useMemo(() => {
    if (!jobFilter.trim()) return jobs
    const q = jobFilter.trim().toLowerCase()
    return jobs.filter(
      (j) =>
        j.jobId.toLowerCase().includes(q) ||
        j.containerImage.toLowerCase().includes(q) ||
        j.latestExecution.toLowerCase().includes(q)
    )
  }, [jobs, jobFilter])

  const filteredDomains = useMemo(() => {
    if (!domainFilter.trim()) return domainMappings
    const q = domainFilter.trim().toLowerCase()
    return domainMappings.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.routeName.toLowerCase().includes(q) ||
        d.mappedRouteName.toLowerCase().includes(q)
    )
  }, [domainMappings, domainFilter])

  const selectionLabel = useMemo(() => {
    if (mainTab === 'services' && selectedService) return selectedService.serviceId
    if (mainTab === 'revisions' && selectedRevision) return selectedRevision.revisionId
    if (mainTab === 'jobs' && selectedJob) return selectedJob.jobId
    if (mainTab === 'domains' && selectedDomain) return selectedDomain.name
    return 'No selection'
  }, [mainTab, selectedService, selectedRevision, selectedJob, selectedDomain])

  /* ── Enable-API action ───────────────────────────────── */
  const enableAction = error
    ? getGcpApiEnableAction(
        error,
        `gcloud services enable run.googleapis.com --project ${projectId}`,
        `Cloud Run API is disabled for project ${projectId}.`
      )
    : null

  /* ── Render ────────────────────────────────────────────── */
  return (
    <div className="svc-console gcp-runtime-console">
      {/* ── Hero ──────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Container platform</div>
          <h2>Cloud Run Operations</h2>
          <p>
            Serverless container platform with service inventory, revision history,
            job execution tracking, and domain mapping management.
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
              <strong>{selectionLabel}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Services</span>
            <strong>{loading ? '...' : services.length}</strong>
            <small>{loading ? 'Refreshing live data now' : 'Deployed Cloud Run services'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Jobs</span>
            <strong>{loading ? '...' : jobs.length}</strong>
            <small>Configured batch execution jobs</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Active Revisions</span>
            <strong>{loading ? '...' : activeRevisionCount}</strong>
            <small>Services with Ready condition succeeded</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Domain Mappings</span>
            <strong>{loading ? '...' : domainMappings.length}</strong>
            <small>Custom domain routes configured</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ───────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <button className="svc-tab-hamburger" type="button" onClick={() => setTabsOpen((p) => !p)}>
          <span className={`hamburger-icon ${tabsOpen ? 'open' : ''}`}>
            <span /><span /><span />
          </span>
        </button>
        <div className="iam-tab-bar">
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
                onClick={() => onRunTerminalCommand(enableAction.command)}
              >
                Run in terminal
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Global error (non-enable) ─────────────────── */}
      {error && !enableAction && (
        <section className="panel stack">
          <SvcState variant="error" error={error} />
        </section>
      )}

      {/* ── Loading state ─────────────────────────────── */}
      {loading && (
        <SvcState variant="loading" resourceName="Cloud Run resources" message="Fetching services, jobs, and domain mappings..." />
      )}

      {/* ═══════════════ SERVICES TAB ═══════════════ */}
      {!loading && !error && mainTab === 'services' && (
        <div className="overview-surface" style={{ gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: selectedService ? '1fr 1fr' : '1fr', gap: 16 }}>
            {/* ── Service list panel ─────────────────── */}
            <div className="panel">
              <div
                className="panel-header"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}
              >
                <span>Services ({filteredServices.length})</span>
                <input
                  className="svc-search"
                  style={{ maxWidth: 240 }}
                  placeholder="Filter services..."
                  value={serviceFilter}
                  onChange={(e) => setServiceFilter(e.target.value)}
                />
              </div>

              <div
                className="table-head"
                style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 2fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
              >
                <span>Service ID</span>
                <span>Image</span>
                <span>Ingress</span>
                <span>URL</span>
                <span>Updated</span>
              </div>

              {filteredServices.length === 0 && (
                <SvcState variant="empty" resourceName="services" compact />
              )}
              {filteredServices.map((svc) => (
                <div
                  key={svc.serviceId}
                  className={`table-row overview-table-row ${selectedService?.serviceId === svc.serviceId ? 'active' : ''}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 2fr 1fr 2fr 1.5fr',
                    gap: '1rem',
                    padding: '0.5rem 1rem',
                    cursor: 'pointer'
                  }}
                  onClick={() =>
                    setSelectedService((prev) =>
                      prev?.serviceId === svc.serviceId ? null : svc
                    )
                  }
                >
                  <span title={svc.name}>{trunc(svc.serviceId, 32)}</span>
                  <span title={svc.containerImage}>{trunc(svc.containerImage, 36)}</span>
                  <span>{svc.ingressSetting || '-'}</span>
                  <span title={svc.uri}>{trunc(svc.uri, 36)}</span>
                  <span>{formatDateTime(svc.updateTime)}</span>
                </div>
              ))}
            </div>

            {/* ── Service detail panel ───────────────── */}
            {selectedService && (
              <div className="panel">
                <div className="panel-header">
                  Service: <strong>{selectedService.serviceId}</strong>
                </div>

                <div style={{ padding: '1rem' }}>
                  <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Configuration</div>
                  <InfoRow label="URL" value={selectedService.uri} />
                  <InfoRow label="Image" value={trunc(selectedService.containerImage, 64)} />
                  <InfoRow label="Port" value={String(selectedService.containerPort || '-')} />
                  <InfoRow label="CPU / Memory" value={`${selectedService.cpuLimit || '-'} / ${selectedService.memoryLimit || '-'}`} />
                  <InfoRow label="Concurrency" value={String(selectedService.maxInstanceRequestConcurrency)} />
                  <InfoRow label="Timeout" value={selectedService.timeout || '-'} />
                  <InfoRow label="Ingress" value={selectedService.ingressSetting || '-'} />
                  <InfoRow label="VPC Connector" value={selectedService.vpcConnector || '-'} />
                  <InfoRow label="Execution Env" value={selectedService.executionEnvironment || '-'} />
                  <InfoRow label="Service Account" value={trunc(selectedService.serviceAccountEmail, 48)} />
                  <InfoRow label="Launch Stage" value={selectedService.launchStage || '-'} />
                  <InfoRow label="Latest Ready Revision" value={selectedService.latestReadyRevision || '-'} />
                  <InfoRow label="Latest Created Revision" value={selectedService.latestCreatedRevision || '-'} />
                  <InfoRow label="Created" value={formatDateTime(selectedService.createTime)} />
                  <InfoRow label="Updated" value={formatDateTime(selectedService.updateTime)} />
                  <InfoRow label="Creator" value={trunc(selectedService.creator, 48)} />
                  <InfoRow label="Last Modifier" value={trunc(selectedService.lastModifier, 48)} />

                  {/* ── Traffic split ──────────────── */}
                  {selectedService.trafficStatuses.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Traffic Split</div>
                      <div
                        className="table-head"
                        style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 2fr', gap: '1rem', padding: '0.5rem 1rem' }}
                      >
                        <span>Revision</span>
                        <span>Percent</span>
                        <span>Type</span>
                        <span>Tag URI</span>
                      </div>
                      {selectedService.trafficStatuses.map((ts, i) => (
                        <div
                          key={`${ts.revisionName}-${i}`}
                          className="table-row"
                          style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 2fr', gap: '1rem', padding: '0.4rem 1rem' }}
                        >
                          <span>{ts.revisionName || '-'}</span>
                          <span><strong>{ts.percent}%</strong></span>
                          <span>{ts.type || '-'}</span>
                          <span title={ts.uri}>{trunc(ts.uri, 36)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Conditions ─────────────────── */}
                  <div style={{ marginTop: 16 }}>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Conditions</div>
                    <ConditionsTable conditions={selectedService.conditions} />
                  </div>

                  {/* ── Action buttons ─────────────── */}
                  <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {selectedService.uri && (
                      <button
                        className="svc-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        title={canRunTerminalCommand ? `Open ${selectedService.uri}` : 'Switch to Operator mode to enable terminal actions'}
                        onClick={() => onRunTerminalCommand(`start ${selectedService.uri}`)}
                      >
                        Open URL
                      </button>
                    )}
                    <button
                      className="svc-btn"
                      type="button"
                      disabled={!canRunTerminalCommand}
                      title={
                        canRunTerminalCommand
                          ? 'View logs for this service'
                          : 'Switch to Operator mode to enable terminal actions'
                      }
                      onClick={() =>
                        onRunTerminalCommand(
                          `gcloud run services logs read ${selectedService.serviceId} --project ${projectId} --region ${location} --limit 100`
                        )
                      }
                    >
                      View Logs
                    </button>
                    <button
                      className="svc-btn"
                      type="button"
                      disabled={!canRunTerminalCommand}
                      title={
                        canRunTerminalCommand
                          ? 'Describe this service'
                          : 'Switch to Operator mode to enable terminal actions'
                      }
                      onClick={() =>
                        onRunTerminalCommand(
                          `gcloud run services describe ${selectedService.serviceId} --project ${projectId} --region ${location}`
                        )
                      }
                    >
                      Describe
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════ REVISIONS TAB ═══════════════ */}
      {!loading && !error && mainTab === 'revisions' && (
        <div className="overview-surface" style={{ gap: 12 }}>
          {/* ── Service selector ──────────────────────── */}
          <div className="panel">
            <div
              className="panel-header"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}
            >
              <span>Select a service to view its revisions</span>
            </div>

            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Service ID</span>
              <span>Latest Ready</span>
              <span>Ingress</span>
              <span>Updated</span>
            </div>

            {services.length === 0 && <SvcState variant="empty" resourceName="services" compact />}
            {services.map((svc) => (
              <div
                key={svc.serviceId}
                className={`table-row overview-table-row ${selectedService?.serviceId === svc.serviceId ? 'active' : ''}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 2fr 1fr 1.5fr',
                  gap: '1rem',
                  padding: '0.5rem 1rem',
                  cursor: 'pointer'
                }}
                onClick={() =>
                  setSelectedService((prev) =>
                    prev?.serviceId === svc.serviceId ? null : svc
                  )
                }
              >
                <span>{trunc(svc.serviceId, 32)}</span>
                <span>{trunc(svc.latestReadyRevision, 36)}</span>
                <span>{svc.ingressSetting || '-'}</span>
                <span>{formatDateTime(svc.updateTime)}</span>
              </div>
            ))}
          </div>

          {/* ── Revisions for selected service ────────── */}
          {selectedService && (
            <div style={{ display: 'grid', gridTemplateColumns: selectedRevision ? '1fr 1fr' : '1fr', gap: 16 }}>
              <div className="panel">
                <div className="panel-header">
                  Revisions for <strong>{selectedService.serviceId}</strong> ({revisions.length})
                </div>

                {revisionsLoading && <SvcState variant="loading" resourceName="revisions" compact />}
                {revisionsError && <SvcState variant="error" error={revisionsError} compact />}

                {!revisionsLoading && !revisionsError && revisions.length === 0 && (
                  <SvcState variant="empty" resourceName="revisions" compact />
                )}

                {!revisionsLoading && !revisionsError && revisions.length > 0 && (
                  <>
                    <div
                      className="table-head"
                      style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 0.8fr 0.8fr 1.2fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
                    >
                      <span>Revision ID</span>
                      <span>Image</span>
                      <span>CPU</span>
                      <span>Memory</span>
                      <span>Scaling</span>
                      <span>Created</span>
                    </div>

                    {revisions.map((rev) => (
                      <div
                        key={rev.revisionId}
                        className={`table-row overview-table-row ${selectedRevision?.revisionId === rev.revisionId ? 'active' : ''}`}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '2fr 2fr 0.8fr 0.8fr 1.2fr 1.5fr',
                          gap: '1rem',
                          padding: '0.5rem 1rem',
                          cursor: 'pointer'
                        }}
                        onClick={() =>
                          setSelectedRevision((prev) =>
                            prev?.revisionId === rev.revisionId ? null : rev
                          )
                        }
                      >
                        <span title={rev.name}>{trunc(rev.revisionId, 32)}</span>
                        <span title={rev.containerImage}>{trunc(rev.containerImage, 32)}</span>
                        <span>{rev.cpuLimit || '-'}</span>
                        <span>{rev.memoryLimit || '-'}</span>
                        <span>{rev.scaling.minInstanceCount}-{rev.scaling.maxInstanceCount}</span>
                        <span>{formatDateTime(rev.createTime)}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>

              {/* ── Revision detail ───────────────────── */}
              {selectedRevision && (
                <div className="panel">
                  <div className="panel-header">
                    Revision: <strong>{selectedRevision.revisionId}</strong>
                  </div>
                  <div style={{ padding: '1rem' }}>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Configuration</div>
                    <InfoRow label="Revision ID" value={selectedRevision.revisionId} />
                    <InfoRow label="Generation" value={selectedRevision.generation || '-'} />
                    <InfoRow label="Image" value={trunc(selectedRevision.containerImage, 56)} />
                    <InfoRow label="CPU" value={selectedRevision.cpuLimit || '-'} />
                    <InfoRow label="Memory" value={selectedRevision.memoryLimit || '-'} />
                    <InfoRow label="Concurrency" value={String(selectedRevision.maxInstanceRequestConcurrency)} />
                    <InfoRow label="Timeout" value={selectedRevision.timeout || '-'} />
                    <InfoRow label="Min Instances" value={String(selectedRevision.scaling.minInstanceCount)} />
                    <InfoRow label="Max Instances" value={String(selectedRevision.scaling.maxInstanceCount)} />
                    <InfoRow label="Service Account" value={trunc(selectedRevision.serviceAccountEmail, 48)} />
                    <InfoRow label="Launch Stage" value={selectedRevision.launchStage || '-'} />
                    <InfoRow label="Created" value={formatDateTime(selectedRevision.createTime)} />
                    <InfoRow label="Updated" value={formatDateTime(selectedRevision.updateTime)} />

                    {selectedRevision.logUri && (
                      <div style={{ marginTop: 12 }}>
                        <div className="iam-pane-kicker" style={{ marginBottom: 4 }}>Log URI</div>
                        <div style={{ wordBreak: 'break-all', fontSize: '0.82rem', color: '#98afc3' }}>
                          {selectedRevision.logUri}
                        </div>
                      </div>
                    )}

                    <div style={{ marginTop: 16 }}>
                      <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Conditions</div>
                      <ConditionsTable conditions={selectedRevision.conditions} />
                    </div>

                    <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                      <button
                        className="svc-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        title={
                          canRunTerminalCommand
                            ? 'View revision logs'
                            : 'Switch to Operator mode to enable terminal actions'
                        }
                        onClick={() =>
                          onRunTerminalCommand(
                            `gcloud run revisions logs read ${selectedRevision.revisionId} --project ${projectId} --region ${location} --limit 100`
                          )
                        }
                      >
                        View Logs
                      </button>
                      <button
                        className="svc-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        title={
                          canRunTerminalCommand
                            ? 'Describe revision'
                            : 'Switch to Operator mode to enable terminal actions'
                        }
                        onClick={() =>
                          onRunTerminalCommand(
                            `gcloud run revisions describe ${selectedRevision.revisionId} --project ${projectId} --region ${location}`
                          )
                        }
                      >
                        Describe
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ JOBS TAB ═══════════════ */}
      {!loading && !error && mainTab === 'jobs' && (
        <div className="overview-surface" style={{ gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: selectedJob ? '1fr 1fr' : '1fr', gap: 16 }}>
            {/* ── Job list panel ──────────────────────── */}
            <div className="panel">
              <div
                className="panel-header"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}
              >
                <span>Jobs ({filteredJobs.length})</span>
                <input
                  className="svc-search"
                  style={{ maxWidth: 240 }}
                  placeholder="Filter jobs..."
                  value={jobFilter}
                  onChange={(e) => setJobFilter(e.target.value)}
                />
              </div>

              <div
                className="table-head"
                style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 0.8fr 0.8fr 1.5fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
              >
                <span>Job ID</span>
                <span>Image</span>
                <span>Tasks</span>
                <span>Retries</span>
                <span>Last Execution</span>
                <span>Updated</span>
              </div>

              {filteredJobs.length === 0 && <SvcState variant="empty" resourceName="jobs" compact />}
              {filteredJobs.map((job) => (
                <div
                  key={job.jobId}
                  className={`table-row overview-table-row ${selectedJob?.jobId === job.jobId ? 'active' : ''}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 2fr 0.8fr 0.8fr 1.5fr 1.5fr',
                    gap: '1rem',
                    padding: '0.5rem 1rem',
                    cursor: 'pointer'
                  }}
                  onClick={() =>
                    setSelectedJob((prev) =>
                      prev?.jobId === job.jobId ? null : job
                    )
                  }
                >
                  <span title={job.name}>{trunc(job.jobId, 32)}</span>
                  <span title={job.containerImage}>{trunc(job.containerImage, 32)}</span>
                  <span>{job.taskCount}</span>
                  <span>{job.maxRetries}</span>
                  <span title={job.latestExecution}>{trunc(job.latestExecution, 24)}</span>
                  <span>{formatDateTime(job.updateTime)}</span>
                </div>
              ))}
            </div>

            {/* ── Job detail panel ────────────────────── */}
            {selectedJob && (
              <div className="panel">
                <div className="panel-header">
                  Job: <strong>{selectedJob.jobId}</strong>
                </div>

                <div style={{ padding: '1rem' }}>
                  <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Configuration</div>
                  <InfoRow label="Job ID" value={selectedJob.jobId} />
                  <InfoRow label="Image" value={trunc(selectedJob.containerImage, 56)} />
                  <InfoRow label="Task Count" value={String(selectedJob.taskCount)} />
                  <InfoRow label="Max Retries" value={String(selectedJob.maxRetries)} />
                  <InfoRow label="Timeout" value={selectedJob.timeout || '-'} />
                  <InfoRow label="CPU / Memory" value={`${selectedJob.cpuLimit || '-'} / ${selectedJob.memoryLimit || '-'}`} />
                  <InfoRow label="Service Account" value={trunc(selectedJob.serviceAccountEmail, 48)} />
                  <InfoRow label="Launch Stage" value={selectedJob.launchStage || '-'} />
                  <InfoRow label="Execution Count" value={String(selectedJob.executionCount)} />
                  <InfoRow label="Latest Execution" value={selectedJob.latestExecution || '-'} />
                  <InfoRow label="Created" value={formatDateTime(selectedJob.createTime)} />
                  <InfoRow label="Updated" value={formatDateTime(selectedJob.updateTime)} />
                  <InfoRow label="Creator" value={trunc(selectedJob.creator, 48)} />
                  <InfoRow label="Last Modifier" value={trunc(selectedJob.lastModifier, 48)} />

                  <div style={{ marginTop: 16 }}>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Conditions</div>
                    <ConditionsTable conditions={selectedJob.conditions} />
                  </div>

                  {/* ── Action buttons ─────────────── */}
                  <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="svc-btn success"
                      type="button"
                      disabled={!canRunTerminalCommand}
                      title={
                        canRunTerminalCommand
                          ? `Execute job ${selectedJob.jobId}`
                          : 'Switch to Operator mode to enable terminal actions'
                      }
                      onClick={() =>
                        onRunTerminalCommand(
                          `gcloud run jobs execute ${selectedJob.jobId} --project ${projectId} --region ${location}`
                        )
                      }
                    >
                      Execute Job
                    </button>
                    <button
                      className="svc-btn"
                      type="button"
                      disabled={!canRunTerminalCommand}
                      title={
                        canRunTerminalCommand
                          ? 'Describe job'
                          : 'Switch to Operator mode to enable terminal actions'
                      }
                      onClick={() =>
                        onRunTerminalCommand(
                          `gcloud run jobs describe ${selectedJob.jobId} --project ${projectId} --region ${location}`
                        )
                      }
                    >
                      Describe
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Executions for selected job ────────────── */}
          {selectedJob && (
            <div style={{ display: 'grid', gridTemplateColumns: selectedExecution ? '1fr 1fr' : '1fr', gap: 16 }}>
              <div className="panel">
                <div className="panel-header">
                  Executions for <strong>{selectedJob.jobId}</strong> ({executions.length})
                </div>

                {executionsLoading && <SvcState variant="loading" resourceName="executions" compact />}
                {executionsError && <SvcState variant="error" error={executionsError} compact />}

                {!executionsLoading && !executionsError && executions.length === 0 && (
                  <SvcState variant="empty" resourceName="executions" compact />
                )}

                {!executionsLoading && !executionsError && executions.length > 0 && (
                  <>
                    <div
                      className="table-head"
                      style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr 1.5fr 0.8fr', gap: '1rem', padding: '0.5rem 1rem' }}
                    >
                      <span>Execution ID</span>
                      <span>Status</span>
                      <span>Started</span>
                      <span>Completed</span>
                      <span>Tasks</span>
                    </div>

                    {executions.map((exec) => (
                      <div
                        key={exec.executionId}
                        className={`table-row overview-table-row ${selectedExecution?.executionId === exec.executionId ? 'active' : ''}`}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '2fr 1fr 1.5fr 1.5fr 0.8fr',
                          gap: '1rem',
                          padding: '0.5rem 1rem',
                          cursor: 'pointer'
                        }}
                        onClick={() =>
                          setSelectedExecution((prev) =>
                            prev?.executionId === exec.executionId ? null : exec
                          )
                        }
                      >
                        <span title={exec.name}>{trunc(exec.executionId, 32)}</span>
                        <span className={`status-badge ${executionStatusTone(exec)}`}>
                          {executionStatusLabel(exec)}
                        </span>
                        <span>{formatDateTime(exec.startTime)}</span>
                        <span>{formatDateTime(exec.completionTime)}</span>
                        <span>{exec.taskCount}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>

              {/* ── Execution detail ──────────────────── */}
              {selectedExecution && (
                <div className="panel">
                  <div className="panel-header">
                    Execution: <strong>{selectedExecution.executionId}</strong>
                  </div>
                  <div style={{ padding: '1rem' }}>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Details</div>
                    <InfoRow label="Execution ID" value={selectedExecution.executionId} />
                    <InfoRow label="Status" value={executionStatusLabel(selectedExecution)} />
                    <InfoRow label="Task Count" value={String(selectedExecution.taskCount)} />
                    <InfoRow label="Running" value={String(selectedExecution.runningCount)} />
                    <InfoRow label="Succeeded" value={String(selectedExecution.succeededCount)} />
                    <InfoRow label="Failed" value={String(selectedExecution.failedCount)} />
                    <InfoRow label="Cancelled" value={String(selectedExecution.cancelledCount)} />
                    <InfoRow label="Created" value={formatDateTime(selectedExecution.createTime)} />
                    <InfoRow label="Started" value={formatDateTime(selectedExecution.startTime)} />
                    <InfoRow label="Completed" value={formatDateTime(selectedExecution.completionTime)} />

                    {selectedExecution.logUri && (
                      <div style={{ marginTop: 12 }}>
                        <div className="iam-pane-kicker" style={{ marginBottom: 4 }}>Log URI</div>
                        <div style={{ wordBreak: 'break-all', fontSize: '0.82rem', color: '#98afc3' }}>
                          {selectedExecution.logUri}
                        </div>
                      </div>
                    )}

                    <div style={{ marginTop: 16 }}>
                      <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Conditions</div>
                      <ConditionsTable conditions={selectedExecution.conditions} />
                    </div>

                    <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                      {selectedExecution.logUri && (
                        <button
                          className="svc-btn"
                          type="button"
                          disabled={!canRunTerminalCommand}
                          title={
                            canRunTerminalCommand
                              ? 'Open execution logs'
                              : 'Switch to Operator mode to enable terminal actions'
                          }
                          onClick={() => onRunTerminalCommand(`start ${selectedExecution.logUri}`)}
                        >
                          Open Logs
                        </button>
                      )}
                      <button
                        className="svc-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        title={
                          canRunTerminalCommand
                            ? 'Describe execution'
                            : 'Switch to Operator mode to enable terminal actions'
                        }
                        onClick={() =>
                          onRunTerminalCommand(
                            `gcloud run jobs executions describe ${selectedExecution.executionId} --project ${projectId} --region ${location}`
                          )
                        }
                      >
                        Describe
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════ DOMAIN MAPPINGS TAB ═══════════════ */}
      {!loading && !error && mainTab === 'domains' && (
        <div className="overview-surface" style={{ gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: selectedDomain ? '1fr 1fr' : '1fr', gap: 16 }}>
            {/* ── Domain list panel ───────────────────── */}
            <div className="panel">
              <div
                className="panel-header"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}
              >
                <span>Domain Mappings ({filteredDomains.length})</span>
                <input
                  className="svc-search"
                  style={{ maxWidth: 240 }}
                  placeholder="Filter domains..."
                  value={domainFilter}
                  onChange={(e) => setDomainFilter(e.target.value)}
                />
              </div>

              <div
                className="table-head"
                style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1.5fr 1fr', gap: '1rem', padding: '0.5rem 1rem' }}
              >
                <span>Domain Name</span>
                <span>Route</span>
                <span>Created</span>
                <span>Status</span>
              </div>

              {filteredDomains.length === 0 && (
                <SvcState variant="empty" resourceName="domain mappings" compact />
              )}
              {filteredDomains.map((dm) => {
                const readyCondition = dm.conditions.find((c) => c.type === 'Ready')
                const statusLabel = readyCondition
                  ? readyCondition.state?.toUpperCase().includes('SUCCEEDED')
                    ? 'Ready'
                    : readyCondition.state || 'Unknown'
                  : 'Unknown'
                const statusTone = readyCondition
                  ? readyCondition.state?.toUpperCase().includes('SUCCEEDED')
                    ? 'status-ok'
                    : readyCondition.state?.toUpperCase().includes('FAILED')
                      ? 'status-error'
                      : 'status-warn'
                  : ''

                return (
                  <div
                    key={dm.name}
                    className={`table-row overview-table-row ${selectedDomain?.name === dm.name ? 'active' : ''}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '2fr 2fr 1.5fr 1fr',
                      gap: '1rem',
                      padding: '0.5rem 1rem',
                      cursor: 'pointer'
                    }}
                    onClick={() =>
                      setSelectedDomain((prev) =>
                        prev?.name === dm.name ? null : dm
                      )
                    }
                  >
                    <span title={dm.name}>{trunc(dm.name, 36)}</span>
                    <span title={dm.routeName}>{trunc(dm.routeName, 36)}</span>
                    <span>{formatDateTime(dm.createTime)}</span>
                    <span className={`status-badge ${statusTone}`}>{statusLabel}</span>
                  </div>
                )
              })}
            </div>

            {/* ── Domain detail panel ─────────────────── */}
            {selectedDomain && (
              <div className="panel">
                <div className="panel-header">
                  Domain: <strong>{selectedDomain.name}</strong>
                </div>

                <div style={{ padding: '1rem' }}>
                  <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Configuration</div>
                  <InfoRow label="Domain Name" value={selectedDomain.name} />
                  <InfoRow label="Route Name" value={selectedDomain.routeName || '-'} />
                  <InfoRow label="Mapped Route" value={selectedDomain.mappedRouteName || '-'} />
                  <InfoRow label="Created" value={formatDateTime(selectedDomain.createTime)} />

                  {/* ── DNS Records ────────────────── */}
                  {selectedDomain.records.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>DNS Records</div>
                      <div
                        className="table-head"
                        style={{ display: 'grid', gridTemplateColumns: '1fr 3fr', gap: '1rem', padding: '0.5rem 1rem' }}
                      >
                        <span>Type</span>
                        <span>RR Data</span>
                      </div>
                      {selectedDomain.records.map((rec, i) => (
                        <div
                          key={`${rec.type}-${i}`}
                          className="table-row"
                          style={{ display: 'grid', gridTemplateColumns: '1fr 3fr', gap: '1rem', padding: '0.4rem 1rem' }}
                        >
                          <span>
                            <span className="status-badge">{rec.type}</span>
                          </span>
                          <span style={{ wordBreak: 'break-all', fontSize: '0.82rem' }}>{rec.rrdata}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Conditions ─────────────────── */}
                  <div style={{ marginTop: 16 }}>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Conditions</div>
                    <ConditionsTable conditions={selectedDomain.conditions} />
                  </div>

                  <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                    <button
                      className="svc-btn"
                      type="button"
                      disabled={!canRunTerminalCommand}
                      title={
                        canRunTerminalCommand
                          ? 'Describe domain mapping'
                          : 'Switch to Operator mode to enable terminal actions'
                      }
                      onClick={() =>
                        onRunTerminalCommand(
                          `gcloud run domain-mappings describe --domain ${selectedDomain.name} --project ${projectId} --region ${location}`
                        )
                      }
                    >
                      Describe
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
