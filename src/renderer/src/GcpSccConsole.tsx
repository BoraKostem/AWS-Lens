import { useEffect, useMemo, useState } from 'react'
import type {
  GcpSccFindingClass,
  GcpSccFindingSummary,
  GcpSccPostureReport,
  GcpSccSourceSummary,
  GcpSccFindingDetail,
  GcpSccSeverityBreakdown
} from '@shared/types'
import {
  listGcpSccFindings,
  listGcpSccSources,
  getGcpSccFindingDetail,
  getGcpSccSeverityBreakdown,
  getGcpSccPostureReport
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Types ──────────────────────────────────────────── */

type MainTab = 'findings' | 'sources' | 'posture' | 'health'

const MAIN_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'findings', label: 'Findings' },
  { id: 'sources', label: 'Sources' },
  { id: 'posture', label: 'Posture' },
  { id: 'health', label: 'Security Health' }
]

const FINDING_CLASS_LABELS: Record<GcpSccFindingClass, string> = {
  vulnerability: 'Vulnerabilities',
  misconfiguration: 'Misconfigurations',
  threat: 'Threats',
  observation: 'Observations',
  other: 'Other'
}

const FINDING_CLASS_COLORS: Record<GcpSccFindingClass, string> = {
  vulnerability: '#ef4444',
  misconfiguration: '#f97316',
  threat: '#dc2626',
  observation: '#6366f1',
  other: '#94a3b8'
}

/* ── Helpers ────────────────────────────────────────── */

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  const match = error.match(/Run "([^"]+)"/) ?? error.match(/Run [\u201c]([^\u201d]+)[\u201d]/)
  return { command: match?.[1]?.trim() ?? fallbackCommand, summary }
}

function formatDateTime(value: string): string {
  if (!value) return '-'
  try { return new Date(value).toLocaleString() } catch { return value }
}

function truncate(value: string, max = 48): string {
  if (!value) return '-'
  return value.length <= max ? value : value.slice(0, max - 3) + '...'
}

function errMsg(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/* ── Severity helpers ──────────────────────────────── */

const SEV: Record<string, { bg: string; fg: string }> = {
  CRITICAL: { bg: 'rgba(239, 68, 68, 0.14)', fg: '#f87171' },
  HIGH:     { bg: 'rgba(245, 158, 11, 0.14)', fg: '#fbbf24' },
  MEDIUM:   { bg: 'rgba(234, 179, 8, 0.14)',  fg: '#facc15' },
  LOW:      { bg: 'rgba(34, 197, 94, 0.14)',   fg: '#4ade80' }
}
const SEV_DEFAULT = { bg: 'rgba(148, 163, 184, 0.14)', fg: '#94a3b8' }

function SeverityBadge({ severity }: { severity: string }) {
  const s = SEV[severity?.toUpperCase()] ?? SEV_DEFAULT
  return (
    <span className="eks-badge" style={{ background: s.bg, color: s.fg, fontWeight: 600 }}>
      {severity || 'UNSPECIFIED'}
    </span>
  )
}

function StateBadge({ state }: { state: string }) {
  const tone = state === 'ACTIVE' ? 'success' : state === 'INACTIVE' ? '' : 'warning'
  return <span className={`eks-badge ${tone}`}>{state || 'UNKNOWN'}</span>
}

/* ── Findings Tab ──────────────────────────────────── */

function FindingsTab({ projectId, location, findings, loading, error }: {
  projectId: string; location: string; findings: GcpSccFindingSummary[]; loading: boolean; error: string
}) {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<GcpSccFindingSummary | null>(null)
  const [detail, setDetail] = useState<GcpSccFindingDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const filtered = useMemo(() => {
    if (!filter.trim()) return findings
    const q = filter.trim().toLowerCase()
    return findings.filter((f) =>
      f.category.toLowerCase().includes(q) || f.resourceName.toLowerCase().includes(q) ||
      f.resourceType.toLowerCase().includes(q) || f.severity.toLowerCase().includes(q) ||
      f.sourceDisplayName.toLowerCase().includes(q))
  }, [findings, filter])

  async function handleSelect(f: GcpSccFindingSummary | null): Promise<void> {
    if (!f || selected?.name === f.name) { setSelected(null); setDetail(null); setDetailError(''); return }
    setSelected(f); setDetailLoading(true); setDetailError(''); setDetail(null)
    try { setDetail(await getGcpSccFindingDetail(projectId, f.name, location)) }
    catch (e) { setDetailError(errMsg(e)) }
    finally { setDetailLoading(false) }
  }

  if (loading) return <SvcState variant="loading" resourceName="findings" compact />
  if (error) return <SvcState variant="error" error={error} compact />
  if (findings.length === 0) return <SvcState variant="empty" resourceName="findings" />

  return (
    <div className="gcp-monitoring-tab-content">
      <div className="gcp-monitoring-filter-row">
        <input className="iam-section-search" placeholder="Filter by category, resource, severity..."
          value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="iam-layout">
        <div className="iam-table-area">
          <table className="svc-table">
            <thead><tr>
              <th>Category</th><th>Severity</th><th>Resource</th>
              <th>State</th><th>Source</th><th>Event Time</th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: '#6b7688' }}>
                  No findings match the current filter.</td></tr>
              )}
              {filtered.map((f) => (
                <tr key={f.name} className={selected?.name === f.name ? 'selected' : ''}
                  onClick={() => void handleSelect(selected?.name === f.name ? null : f)}
                  style={{ cursor: 'pointer' }}>
                  <td title={f.category}>{truncate(f.category, 36)}</td>
                  <td><SeverityBadge severity={f.severity} /></td>
                  <td title={f.resourceName}>{truncate(f.resourceName, 36)}</td>
                  <td><StateBadge state={f.state} /></td>
                  <td>{truncate(f.sourceDisplayName, 28)}</td>
                  <td>{formatDateTime(f.eventTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="iam-detail-area">
            <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>Finding Detail</div>
            {detailLoading && <SvcState variant="loading" resourceName="finding detail" compact />}
            {!detailLoading && detailError && <SvcState variant="error" error={detailError} compact />}
            {!detailLoading && !detailError && detail && (<>
              <div className="eks-kv-row"><div className="eks-kv-label">Category</div><div className="eks-kv-value">{detail.category}</div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">Severity</div><div className="eks-kv-value"><SeverityBadge severity={detail.severity} /></div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">State</div><div className="eks-kv-value"><StateBadge state={detail.state} /></div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">Mute</div><div className="eks-kv-value">{detail.mute || '-'}</div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">Resource</div><div className="eks-kv-value">{detail.resourceName}</div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">Resource Type</div><div className="eks-kv-value">{detail.resourceType || '-'}</div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">Source</div><div className="eks-kv-value">{detail.sourceDisplayName || '-'}</div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">Event Time</div><div className="eks-kv-value">{formatDateTime(detail.eventTime)}</div></div>
              <div className="eks-kv-row"><div className="eks-kv-label">Created</div><div className="eks-kv-value">{formatDateTime(detail.createTime)}</div></div>

              {detail.description && (
                <div style={{ marginTop: 12 }}>
                  <div className="iam-pane-kicker" style={{ marginBottom: 4 }}>Description</div>
                  <div style={{ color: '#c4cbd8', fontSize: '0.82rem', lineHeight: 1.5 }}>{detail.description}</div>
                </div>
              )}
              {detail.nextSteps && (
                <div style={{ marginTop: 12 }}>
                  <div className="iam-pane-kicker" style={{ marginBottom: 4 }}>Next Steps</div>
                  <div style={{ color: '#c4cbd8', fontSize: '0.82rem', lineHeight: 1.5 }}>{detail.nextSteps}</div>
                </div>
              )}
              {detail.externalUri && (
                <div style={{ marginTop: 12 }}>
                  <div className="iam-pane-kicker" style={{ marginBottom: 4 }}>External Reference</div>
                  <a href={detail.externalUri} target="_blank" rel="noopener noreferrer"
                    style={{ color: '#60a5fa', fontSize: '0.82rem' }}>{detail.externalUri}</a>
                </div>
              )}
              {detail.sourceProperties && Object.keys(detail.sourceProperties).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="iam-pane-kicker" style={{ marginBottom: 4 }}>Source Properties</div>
                  {Object.entries(detail.sourceProperties).map(([k, v]) => (
                    <div className="eks-kv-row" key={k}>
                      <div className="eks-kv-label">{k}</div>
                      <div className="eks-kv-value">{v || '-'}</div>
                    </div>
                  ))}
                </div>
              )}
            </>)}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Sources Tab ───────────────────────────────────── */

function SourcesTab({ sources, loading, error }: {
  sources: GcpSccSourceSummary[]; loading: boolean; error: string
}) {
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => {
    if (!filter.trim()) return sources
    const q = filter.trim().toLowerCase()
    return sources.filter((s) =>
      s.name.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q))
  }, [sources, filter])

  if (loading) return <SvcState variant="loading" resourceName="sources" compact />
  if (error) return <SvcState variant="error" error={error} compact />
  if (sources.length === 0) return <SvcState variant="empty" resourceName="sources" />

  return (
    <div className="gcp-monitoring-tab-content">
      <div className="gcp-monitoring-filter-row">
        <input className="iam-section-search" placeholder="Filter sources..."
          value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="iam-layout">
        <div className="iam-table-area">
          <table className="svc-table">
            <thead><tr><th>Source Name</th><th>Display Name</th><th>Description</th></tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={3} style={{ textAlign: 'center', color: '#6b7688' }}>
                  No sources match the current filter.</td></tr>
              )}
              {filtered.map((s) => (
                <tr key={s.name}>
                  <td title={s.name}>{truncate(s.name, 40)}</td>
                  <td>{s.displayName || '-'}</td>
                  <td title={s.description}>{truncate(s.description, 60)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ── Posture Tab ───────────────────────────────────── */

function PostureTab({ findings, breakdown, breakdownLoading, breakdownError }: {
  findings: GcpSccFindingSummary[]; breakdown: GcpSccSeverityBreakdown | null
  breakdownLoading: boolean; breakdownError: string
}) {
  const categoryGroups = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const f of findings) { const c = f.category || 'Unknown'; counts[c] = (counts[c] || 0) + 1 }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [findings])

  if (breakdownLoading) return <SvcState variant="loading" resourceName="severity breakdown" compact />
  if (breakdownError) return <SvcState variant="error" error={breakdownError} compact />

  return (
    <div className="gcp-monitoring-tab-content">
      {breakdown && (
        <div style={{ marginBottom: 24 }}>
          <div className="iam-pane-kicker" style={{ marginBottom: 12 }}>Severity Breakdown</div>
          <div className="iam-shell-hero-stats">
            <div className="iam-shell-stat-card" style={{ borderLeft: '3px solid #f87171' }}>
              <span>Critical</span>
              <strong style={{ color: '#f87171' }}>{breakdown.critical}</strong>
              <small>Findings requiring immediate attention</small>
            </div>
            <div className="iam-shell-stat-card" style={{ borderLeft: '3px solid #fbbf24' }}>
              <span>High</span>
              <strong style={{ color: '#fbbf24' }}>{breakdown.high}</strong>
              <small>Findings with high severity</small>
            </div>
            <div className="iam-shell-stat-card" style={{ borderLeft: '3px solid #facc15' }}>
              <span>Medium</span>
              <strong style={{ color: '#facc15' }}>{breakdown.medium}</strong>
              <small>Findings with medium severity</small>
            </div>
            <div className="iam-shell-stat-card" style={{ borderLeft: '3px solid #4ade80' }}>
              <span>Low</span>
              <strong style={{ color: '#4ade80' }}>{breakdown.low}</strong>
              <small>Findings with low severity</small>
            </div>
            <div className="iam-shell-stat-card">
              <span>Unspecified</span>
              <strong>{breakdown.unspecified}</strong>
              <small>Findings without a severity level</small>
            </div>
          </div>
        </div>
      )}
      <div>
        <div className="iam-pane-kicker" style={{ marginBottom: 12 }}>Top Categories</div>
        {categoryGroups.length === 0 ? (
          <SvcState variant="empty" message="No findings available to group by category." compact />
        ) : (
          <div className="iam-layout"><div className="iam-table-area">
            <table className="svc-table">
              <thead><tr><th>Category</th><th>Count</th></tr></thead>
              <tbody>
                {categoryGroups.map(([cat, count]) => (
                  <tr key={cat}><td>{cat}</td><td>{count}</td></tr>
                ))}
              </tbody>
            </table>
          </div></div>
        )}
      </div>
    </div>
  )
}

/* ── Security Health Tab (v2.8.0) ────────────────────── */

function SecurityHealthTab({ projectId, location, refreshNonce }: {
  projectId: string; location: string; refreshNonce: number
}) {
  const [report, setReport] = useState<GcpSccPostureReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeClass, setActiveClass] = useState<GcpSccFindingClass | 'all'>('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    getGcpSccPostureReport(projectId, location)
      .then((r) => { if (!cancelled) setReport(r) })
      .catch((e) => { if (!cancelled) setError(errMsg(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, location, refreshNonce])

  if (loading) return <SvcState variant="loading" resourceName="Security Health Analytics" />
  if (error) return <SvcState variant="error" resourceName="Security Health Analytics" error={error} />
  if (!report) return <SvcState variant="empty" resourceName="Security Health Analytics" />

  const { healthAnalytics, findingsByClass } = report
  const classes: GcpSccFindingClass[] = ['vulnerability', 'misconfiguration', 'threat', 'observation', 'other']

  const displayedFindings = activeClass === 'all'
    ? classes.flatMap((c) => findingsByClass[c])
    : findingsByClass[activeClass] ?? []

  return (
    <div className="gcp-scc-health-tab">
      {report.warnings.length > 0 && (
        <div className="gcp-scc-warnings">
          {report.warnings.map((w, i) => (
            <div key={i} className="ec2-msg warning" style={{ fontSize: 12, padding: '4px 8px' }}>{w}</div>
          ))}
        </div>
      )}

      {/* Summary cards by finding class */}
      <div className="gcp-scc-class-cards">
        {classes.map((cls) => (
          <button
            key={cls}
            type="button"
            className={`gcp-scc-class-card ${activeClass === cls ? 'active' : ''}`}
            style={{ borderTopColor: FINDING_CLASS_COLORS[cls] }}
            onClick={() => setActiveClass(activeClass === cls ? 'all' : cls)}
          >
            <span className="gcp-scc-class-count" style={{ color: FINDING_CLASS_COLORS[cls] }}>
              {healthAnalytics.byClass[cls]}
            </span>
            <span className="gcp-scc-class-label">{FINDING_CLASS_LABELS[cls]}</span>
          </button>
        ))}
      </div>

      {/* Analytics row */}
      <div className="gcp-scc-analytics-row">
        <div className="gcp-scc-analytics-panel">
          <h4>Top Categories</h4>
          {healthAnalytics.topCategories.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 12 }}>No categories</div>
          ) : (
            <div className="gcp-scc-top-list">
              {healthAnalytics.topCategories.map((tc) => (
                <div key={tc.category} className="gcp-scc-top-row">
                  <span className="gcp-scc-top-name">{tc.category.replace(/_/g, ' ')}</span>
                  <span className="gcp-scc-top-count">{tc.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="gcp-scc-analytics-panel">
          <h4>Top Targeted Resources</h4>
          {healthAnalytics.topResources.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 12 }}>No resources</div>
          ) : (
            <div className="gcp-scc-top-list">
              {healthAnalytics.topResources.map((tr) => (
                <div key={tr.resourceName} className="gcp-scc-top-row">
                  <span className="gcp-scc-top-name" title={tr.resourceName}>{truncate(tr.resourceName, 60)}</span>
                  <span className="gcp-scc-top-count">{tr.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Classified findings table */}
      <div className="gcp-scc-class-findings">
        <div className="gcp-scc-class-filter-label">
          Showing: <strong>{activeClass === 'all' ? 'All findings' : FINDING_CLASS_LABELS[activeClass]}</strong>
          {' '}({displayedFindings.length})
        </div>
        {displayedFindings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: '#aaa', fontSize: 13 }}>
            No findings in this category.
          </div>
        ) : (
          <table className="eks-table" style={{ fontSize: 12, width: '100%' }}>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Category</th>
                <th>Resource</th>
                <th>State</th>
                <th>Event Time</th>
              </tr>
            </thead>
            <tbody>
              {displayedFindings.slice(0, 100).map((f) => (
                <tr key={f.name}>
                  <td><SeverityBadge severity={f.severity} /></td>
                  <td>{f.category.replace(/_/g, ' ')}</td>
                  <td title={f.resourceName} style={{ fontFamily: 'monospace', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {truncate(f.resourceName, 40)}
                  </td>
                  <td><StateBadge state={f.state} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(f.eventTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ── Main Console Component ────────────────────────── */

export function GcpSccConsole({
  projectId, location, refreshNonce, onRunTerminalCommand, canRunTerminalCommand
}: {
  projectId: string; location: string; refreshNonce: number
  onRunTerminalCommand: (command: string) => void; canRunTerminalCommand: boolean
}) {
  const [mainTab, setMainTab] = useState<MainTab>('findings')
  const [tabsOpen, setTabsOpen] = useState(true)

  const [findings, setFindings] = useState<GcpSccFindingSummary[]>([])
  const [findingsLoading, setFindingsLoading] = useState(true)
  const [findingsError, setFindingsError] = useState('')

  const [sources, setSources] = useState<GcpSccSourceSummary[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [sourcesError, setSourcesError] = useState('')

  const [breakdown, setBreakdown] = useState<GcpSccSeverityBreakdown | null>(null)
  const [breakdownLoading, setBreakdownLoading] = useState(true)
  const [breakdownError, setBreakdownError] = useState('')

  const [globalError, setGlobalError] = useState('')
  const [message, setMessage] = useState('')

  /* ── Shared settle logic ─────────────────────────── */

  function settleResults(results: PromiseSettledResult<unknown>[]): void {
    if (results[0].status === 'fulfilled') {
      setFindings(results[0].value as GcpSccFindingSummary[])
    } else {
      const e = errMsg(results[0].reason); setFindingsError(e); setGlobalError((p) => p || e)
    }
    setFindingsLoading(false)

    if (results[1].status === 'fulfilled') {
      setSources(results[1].value as GcpSccSourceSummary[])
    } else {
      const e = errMsg(results[1].reason); setSourcesError(e); setGlobalError((p) => p || e)
    }
    setSourcesLoading(false)

    if (results[2].status === 'fulfilled') {
      setBreakdown(results[2].value as GcpSccSeverityBreakdown)
    } else {
      const e = errMsg(results[2].reason); setBreakdownError(e); setGlobalError((p) => p || e)
    }
    setBreakdownLoading(false)
  }

  function resetLoading(): void {
    setFindingsLoading(true); setSourcesLoading(true); setBreakdownLoading(true)
    setFindingsError(''); setSourcesError(''); setBreakdownError(''); setGlobalError('')
  }

  function fetchAll(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled([
      listGcpSccFindings(projectId, location),
      listGcpSccSources(projectId, location),
      getGcpSccSeverityBreakdown(projectId, location)
    ])
  }

  /* ── Data loading ─────────────────────────────────── */

  useEffect(() => {
    let cancelled = false
    resetLoading()
    void fetchAll().then((r) => { if (!cancelled) settleResults(r) })
    return () => { cancelled = true }
  }, [projectId, location, refreshNonce])

  function handleRefresh(): void {
    setMessage('')
    resetLoading()
    void fetchAll().then(settleResults)
  }

  /* ── Derived values ───────────────────────────────── */

  const locationLabel = location.trim() || 'global'
  const isLoading = findingsLoading || sourcesLoading || breakdownLoading
  const activeFindings = findings.filter((f) => f.state === 'ACTIVE')
  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length
  const highCount = findings.filter((f) => f.severity === 'HIGH').length

  const enableAction = globalError
    ? getGcpApiEnableAction(
        globalError,
        `gcloud services enable securitycenter.googleapis.com --project ${projectId}`,
        `Security Command Center API is disabled for project ${projectId}.`
      )
    : null

  /* ── Render ───────────────────────────────────────── */

  return (
    <div className="svc-console gcp-runtime-console gcp-scc-console">
      {/* ── Hero ─────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Security posture</div>
          <h2>Security Command Center</h2>
          <p>
            Review security findings, sources, and severity posture for the active project.
            Drill into individual findings for remediation guidance.
          </p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill"><span>Project</span><strong>{projectId}</strong></div>
            <div className="iam-shell-meta-pill"><span>Location</span><strong>{locationLabel}</strong></div>
            <div className="iam-shell-meta-pill"><span>Active findings</span><strong>{isLoading ? '...' : String(activeFindings.length)}</strong></div>
            <div className="iam-shell-meta-pill"><span>Sources</span><strong>{isLoading ? '...' : String(sources.length)}</strong></div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Total active findings</span>
            <strong>{isLoading ? '...' : activeFindings.length}</strong>
            <small>{isLoading ? 'Refreshing live data now' : 'Across all severity levels'}</small>
          </div>
          <div className="iam-shell-stat-card" style={{ borderLeft: '3px solid #f87171' }}>
            <span>Critical</span>
            <strong style={{ color: '#f87171' }}>{isLoading ? '...' : criticalCount}</strong>
            <small>Require immediate remediation</small>
          </div>
          <div className="iam-shell-stat-card" style={{ borderLeft: '3px solid #fbbf24' }}>
            <span>High</span>
            <strong style={{ color: '#fbbf24' }}>{isLoading ? '...' : highCount}</strong>
            <small>High severity findings</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Sources scanned</span>
            <strong>{isLoading ? '...' : sources.length}</strong>
            <small>Security source integrations</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ──────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <div className="iam-tab-bar">
          <button className="svc-tab-hamburger" type="button" onClick={() => setTabsOpen((p) => !p)}>
            <span className={'hamburger-icon ' + (tabsOpen ? 'open' : '')}><span /><span /><span /></span>
          </button>
          {tabsOpen && MAIN_TABS.map((t) => (
            <button key={t.id} type="button" className={`svc-tab ${mainTab === t.id ? 'active' : ''}`}
              onClick={() => setMainTab(t.id)}>{t.label}</button>
          ))}
          {tabsOpen && (
            <button className="svc-tab" type="button" disabled={isLoading}
              onClick={handleRefresh} style={{ marginLeft: 'auto' }}>
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          )}
        </div>
      </div>

      {/* ── API-not-enabled banner ───────────────────── */}
      {enableAction && (
        <div className="ec2-msg gcp-ec2-msg error">
          <div className="gcp-enable-error-banner">
            <div className="gcp-enable-error-copy">
              <strong>{enableAction.summary}</strong>
              <p>Enable the API once, wait for propagation, then refresh the inventory.</p>
            </div>
            <pre className="gcp-runtime-code-block">{enableAction.command}</pre>
            {canRunTerminalCommand && (
              <button className="svc-btn success" type="button" onClick={() => {
                onRunTerminalCommand(enableAction.command)
                setMessage('Sent enable command to terminal.')
              }}>Run in terminal</button>
            )}
          </div>
        </div>
      )}

      {message && <div className="success-banner">{message}</div>}

      {/* ── Tab content ──────────────────────────────── */}
      {mainTab === 'findings' && (
        <FindingsTab projectId={projectId} location={location} findings={findings}
          loading={findingsLoading} error={!enableAction ? findingsError : ''} />
      )}
      {mainTab === 'sources' && (
        <SourcesTab sources={sources}
          loading={sourcesLoading} error={!enableAction ? sourcesError : ''} />
      )}
      {mainTab === 'posture' && (
        <PostureTab findings={findings} breakdown={breakdown}
          breakdownLoading={breakdownLoading} breakdownError={!enableAction ? breakdownError : ''} />
      )}
      {mainTab === 'health' && (
        <SecurityHealthTab projectId={projectId} location={location} refreshNonce={refreshNonce} />
      )}
    </div>
  )
}
