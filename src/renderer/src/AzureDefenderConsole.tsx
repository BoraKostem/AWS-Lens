import { useEffect, useMemo, useState } from 'react'
import './azure-defender-console.css'
import { SvcState } from './SvcState'

import type {
  AzureDefenderAlert,
  AzureDefenderAlertSeverity,
  AzureDefenderRecommendation,
  AzureDefenderReport
} from '@shared/types'
import { getAzureDefenderReport } from './api'

type DefenderTab = 'overview' | 'recommendations' | 'alerts' | 'compliance' | 'attack-paths'

const TABS: Array<{ id: DefenderTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'recommendations', label: 'Recommendations' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'attack-paths', label: 'Attack Paths' }
]

const SEVERITY_ORDER: AzureDefenderAlertSeverity[] = ['high', 'medium', 'low', 'informational']

function scoreColor(pct: number): string {
  if (pct >= 80) return '#22c55e'
  if (pct >= 60) return '#eab308'
  if (pct >= 40) return '#f97316'
  return '#ef4444'
}

function severityLabel(sev: string): string {
  return sev.charAt(0).toUpperCase() + sev.slice(1)
}

function formatTimestamp(value: string): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

/* ── Sub-components ────────────────────────────────────────── */

function SecureScoreRing({ score, size = 160 }: { score: number; size?: number }) {
  const radius = (size - 16) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  const color = scoreColor(score)

  return (
    <svg width={size} height={size} className="ad-score-ring">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={10} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        className="ad-score-ring-value"
        fill="currentColor"
      >
        {score}%
      </text>
    </svg>
  )
}

function OverviewTab({ report }: { report: AzureDefenderReport }) {
  const unhealthyRecommendations = report.recommendations.filter((r) => r.status === 'unhealthy')
  const highAlerts = report.alerts.filter((a) => a.severity === 'high').length
  const mediumAlerts = report.alerts.filter((a) => a.severity === 'medium').length

  return (
    <div className="ad-overview">
      {/* Secure Score Card */}
      <div className="ad-score-panel">
        <h3>Secure Score</h3>
        {report.secureScore ? (
          <div className="ad-score-main">
            <SecureScoreRing score={report.secureScore.percentage} />
            <div className="ad-score-details">
              <div className="ad-score-row">
                <span>Current Score</span>
                <strong>{report.secureScore.currentScore.toFixed(1)} / {report.secureScore.maxScore}</strong>
              </div>
              <div className="ad-score-row">
                <span>Display Name</span>
                <strong>{report.secureScore.displayName}</strong>
              </div>
            </div>
          </div>
        ) : (
          <div className="ad-empty">Secure score unavailable for this subscription</div>
        )}
      </div>

      {/* Quick stats */}
      <div className="ad-stats-grid">
        <div className="ad-stat-card" style={{ borderTop: '3px solid #ef4444' }}>
          <span className="ad-stat-label">High Alerts</span>
          <strong className="ad-stat-value" style={{ color: '#ef4444' }}>{highAlerts}</strong>
        </div>
        <div className="ad-stat-card" style={{ borderTop: '3px solid #f97316' }}>
          <span className="ad-stat-label">Medium Alerts</span>
          <strong className="ad-stat-value" style={{ color: '#f97316' }}>{mediumAlerts}</strong>
        </div>
        <div className="ad-stat-card" style={{ borderTop: '3px solid #eab308' }}>
          <span className="ad-stat-label">Unhealthy</span>
          <strong className="ad-stat-value" style={{ color: '#eab308' }}>{unhealthyRecommendations.length}</strong>
        </div>
        <div className="ad-stat-card" style={{ borderTop: '3px solid #6366f1' }}>
          <span className="ad-stat-label">Attack Paths</span>
          <strong className="ad-stat-value">{report.attackPaths.length}</strong>
        </div>
      </div>

      {/* Top controls */}
      {report.secureScoreControls.length > 0 && (
        <div className="ad-controls-panel">
          <h4>Security Controls (bottom 10)</h4>
          <table className="ad-table">
            <thead>
              <tr>
                <th>Control</th>
                <th>Score</th>
                <th>Unhealthy</th>
                <th>Healthy</th>
                <th>N/A</th>
              </tr>
            </thead>
            <tbody>
              {report.secureScoreControls.slice(0, 10).map((ctrl) => (
                <tr key={ctrl.id}>
                  <td>{ctrl.displayName}</td>
                  <td>
                    <div className="ad-bar-cell">
                      <div className="ad-bar-track">
                        <div
                          className="ad-bar-fill"
                          style={{ width: `${ctrl.percentage}%`, backgroundColor: scoreColor(ctrl.percentage) }}
                        />
                      </div>
                      <span className="ad-bar-label">{ctrl.percentage}%</span>
                    </div>
                  </td>
                  <td style={{ color: '#ef4444' }}>{ctrl.unhealthyResourceCount}</td>
                  <td style={{ color: '#22c55e' }}>{ctrl.healthyResourceCount}</td>
                  <td style={{ color: '#94a3b8' }}>{ctrl.notApplicableResourceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RecommendationsTab({ recommendations }: { recommendations: AzureDefenderRecommendation[] }) {
  const [severityFilter, setSeverityFilter] = useState<'all' | AzureDefenderAlertSeverity>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'unhealthy' | 'healthy'>('unhealthy')
  const [expanded, setExpanded] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return recommendations.filter((r) => {
      if (severityFilter !== 'all' && r.severity !== severityFilter) return false
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      return true
    })
  }, [recommendations, severityFilter, statusFilter])

  return (
    <div className="ad-recommendations">
      <div className="ad-filters">
        <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value as 'all' | AzureDefenderAlertSeverity)}>
          <option value="all">All severities</option>
          {SEVERITY_ORDER.map((s) => (
            <option key={s} value={s}>{severityLabel(s)}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | 'unhealthy' | 'healthy')}>
          <option value="unhealthy">Unhealthy only</option>
          <option value="healthy">Healthy only</option>
          <option value="all">All statuses</option>
        </select>
        <span className="ad-filter-count">
          {filtered.length} recommendation{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="ad-empty">No recommendations match the filters.</div>
      ) : (
        <table className="ad-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Recommendation</th>
              <th>Category</th>
              <th>Status</th>
              <th>Resource</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((r) => (
              <>
                <tr
                  key={r.id}
                  className={`ad-row ad-row--${r.severity} ${expanded === r.id ? 'expanded' : ''}`}
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                >
                  <td><span className={`ad-severity ad-severity--${r.severity}`}>{r.severity}</span></td>
                  <td>{r.displayName}</td>
                  <td>{r.category}</td>
                  <td><span className={`ad-status ad-status--${r.status}`}>{r.status}</span></td>
                  <td className="ad-resource-cell">{r.resourceId.split('/').slice(-1)[0] || '-'}</td>
                </tr>
                {expanded === r.id && (
                  <tr className="ad-detail-row" key={`${r.id}-detail`}>
                    <td colSpan={5}>
                      <div className="ad-detail-content">
                        <div><strong>Description:</strong> {r.description || '(none)'}</div>
                        {r.remediation && <div><strong>Remediation:</strong> {r.remediation}</div>}
                        <div><strong>Resource ID:</strong> <code>{r.resourceId || '(subscription-level)'}</code></div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function AlertsTab({ alerts }: { alerts: AzureDefenderAlert[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (alerts.length === 0) {
    return <div className="ad-empty">No active security alerts.</div>
  }

  return (
    <table className="ad-table">
      <thead>
        <tr>
          <th>Severity</th>
          <th>Alert</th>
          <th>Status</th>
          <th>Compromised Entity</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((a) => (
          <>
            <tr
              key={a.id}
              className={`ad-row ad-row--${a.severity} ${expanded === a.id ? 'expanded' : ''}`}
              onClick={() => setExpanded(expanded === a.id ? null : a.id)}
            >
              <td><span className={`ad-severity ad-severity--${a.severity}`}>{a.severity}</span></td>
              <td>{a.alertDisplayName}</td>
              <td>{a.status}</td>
              <td>{a.compromisedEntity || '-'}</td>
              <td>{formatTimestamp(a.timeGenerated)}</td>
            </tr>
            {expanded === a.id && (
              <tr className="ad-detail-row" key={`${a.id}-detail`}>
                <td colSpan={5}>
                  <div className="ad-detail-content">
                    <div><strong>Description:</strong> {a.description}</div>
                    {a.intent && <div><strong>Intent:</strong> {a.intent}</div>}
                    <div><strong>Vendor:</strong> {a.vendor}</div>
                    {a.resourceId && <div><strong>Resource:</strong> <code>{a.resourceId}</code></div>}
                  </div>
                </td>
              </tr>
            )}
          </>
        ))}
      </tbody>
    </table>
  )
}

function ComplianceTab({ standards }: { standards: AzureDefenderReport['complianceStandards'] }) {
  if (standards.length === 0) {
    return (
      <div className="ad-empty">
        No regulatory compliance standards. Enable compliance standards in Microsoft Defender for Cloud.
      </div>
    )
  }

  return (
    <div className="ad-compliance-grid">
      {standards.map((s) => (
        <div key={s.id} className="ad-compliance-card">
          <div className="ad-compliance-header">
            <h4>{s.displayName}</h4>
            <span className="ad-compliance-state">{s.state}</span>
          </div>
          <div className="ad-compliance-score">
            <SecureScoreRing score={s.compliancePercentage} size={100} />
          </div>
          <div className="ad-compliance-stats">
            <div><span style={{ color: '#22c55e' }}>\u25CF</span> Passed: <strong>{s.passedControls}</strong></div>
            <div><span style={{ color: '#ef4444' }}>\u25CF</span> Failed: <strong>{s.failedControls}</strong></div>
            <div><span style={{ color: '#94a3b8' }}>\u25CF</span> Skipped: <strong>{s.skippedControls}</strong></div>
          </div>
        </div>
      ))}
    </div>
  )
}

function AttackPathsTab({ paths }: { paths: AzureDefenderReport['attackPaths'] }) {
  if (paths.length === 0) {
    return (
      <div className="ad-empty">
        No attack paths detected. Attack path analysis requires Defender CSPM plan.
      </div>
    )
  }

  return (
    <div className="ad-attack-paths">
      {paths.map((p) => (
        <div key={p.id} className={`ad-attack-path-card ad-attack-path-card--${p.riskLevel}`}>
          <div className="ad-attack-path-header">
            <span className={`ad-severity ad-severity--${p.riskLevel}`}>{p.riskLevel}</span>
            <h4>{p.displayName}</h4>
          </div>
          <p className="ad-attack-path-desc">{p.description}</p>
          <div className="ad-attack-path-meta">
            <div><strong>Entry Point:</strong> {p.entryPoint || '-'}</div>
            <div><strong>Target:</strong> <code>{p.targetResourceId.split('/').slice(-1)[0] || '-'}</code></div>
            <div><strong>Steps:</strong> {p.stepCount}</div>
            {p.riskCategories.length > 0 && (
              <div>
                <strong>Risk Categories:</strong> {p.riskCategories.join(', ')}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Main Console ──────────────────────────────────────────── */

export function AzureDefenderConsole({
  subscriptionId,
  refreshNonce = 0
}: {
  subscriptionId: string
  refreshNonce?: number
}) {
  const [report, setReport] = useState<AzureDefenderReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<DefenderTab>('overview')

  async function loadReport() {
    setLoading(true)
    setError('')
    try {
      const result = await getAzureDefenderReport(subscriptionId)
      setReport(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (subscriptionId) {
      void loadReport()
    }
  }, [subscriptionId, refreshNonce])

  if (!subscriptionId) {
    return <SvcState variant="empty" resourceName="Defender for Cloud" message="Select an Azure subscription to view Defender data." />
  }

  if (loading && !report) {
    return <SvcState variant="loading" resourceName="Defender for Cloud" />
  }

  if (error && !report) {
    return <SvcState variant="error" resourceName="Defender for Cloud" error={error} />
  }

  if (!report) {
    return <SvcState variant="empty" resourceName="Defender for Cloud" />
  }

  return (
    <div className="azure-defender-console">
      <div className="ad-header">
        <h2>Microsoft Defender for Cloud</h2>
        <div className="ad-header-actions">
          <button className="btn btn-primary" onClick={loadReport} disabled={loading} type="button">
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {report.warnings.length > 0 && (
        <div className="ad-warnings">
          {report.warnings.map((w, i) => (
            <div key={i} className="ad-warning">{w}</div>
          ))}
        </div>
      )}

      <div className="ad-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`ad-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ad-tab-content">
        {tab === 'overview' && <OverviewTab report={report} />}
        {tab === 'recommendations' && <RecommendationsTab recommendations={report.recommendations} />}
        {tab === 'alerts' && <AlertsTab alerts={report.alerts} />}
        {tab === 'compliance' && <ComplianceTab standards={report.complianceStandards} />}
        {tab === 'attack-paths' && <AttackPathsTab paths={report.attackPaths} />}
      </div>
    </div>
  )
}
