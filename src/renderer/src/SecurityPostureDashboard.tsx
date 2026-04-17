import { useEffect, useState } from 'react'
import './security-posture-dashboard.css'
import { SvcState } from './SvcState'
import { FreshnessIndicator, useFreshnessState } from './freshness'

import type {
  AwsConnection,
  SecurityDomainResult,
  SecurityScoreDomain,
  SecurityScoreReport,
  SecurityScoreWeights
} from '@shared/types'
import { getSecurityScoreReport, invalidatePageCache, recordSecuritySnapshot } from './api'

const DOMAIN_LABELS: Record<SecurityScoreDomain, string> = {
  iam: 'IAM & Access',
  network: 'Network Security',
  encryption: 'Encryption',
  logging: 'Logging & Monitoring',
  compliance: 'Compliance Benchmarks'
}

const DOMAIN_ICONS: Record<SecurityScoreDomain, string> = {
  iam: '\u{1F511}',
  network: '\u{1F310}',
  encryption: '\u{1F512}',
  logging: '\u{1F4CA}',
  compliance: '\u{2705}'
}

function scoreGrade(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

function scoreColor(score: number): string {
  if (score >= 90) return 'var(--score-excellent, #22c55e)'
  if (score >= 70) return 'var(--score-good, #eab308)'
  if (score >= 50) return 'var(--score-fair, #f97316)'
  return 'var(--score-poor, #ef4444)'
}

function ScoreRing({ score, size = 140 }: { score: number; size?: number }) {
  const radius = (size - 16) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference

  return (
    <svg width={size} height={size} className="score-ring">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--ring-bg, #333)"
        strokeWidth={8}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={scoreColor(score)}
        strokeWidth={8}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x={size / 2}
        y={size / 2 - 8}
        textAnchor="middle"
        dominantBaseline="central"
        className="score-ring-value"
        fill="var(--text-primary, #fff)"
      >
        {score}
      </text>
      <text
        x={size / 2}
        y={size / 2 + 16}
        textAnchor="middle"
        dominantBaseline="central"
        className="score-ring-grade"
        fill={scoreColor(score)}
      >
        {scoreGrade(score)}
      </text>
    </svg>
  )
}

function DomainCard({
  result,
  expanded,
  onToggle
}: {
  result: SecurityDomainResult
  expanded: boolean
  onToggle: () => void
}) {
  const passed = result.checks.filter((c) => c.passed).length
  const total = result.checks.length

  return (
    <div className={`domain-card domain-card--${result.score >= 70 ? 'ok' : result.score >= 50 ? 'warn' : 'critical'}`}>
      <button className="domain-card-header" onClick={onToggle} type="button">
        <span className="domain-icon">{DOMAIN_ICONS[result.domain]}</span>
        <div className="domain-info">
          <span className="domain-label">{DOMAIN_LABELS[result.domain]}</span>
          <span className="domain-check-count">
            {passed}/{total} checks passed
          </span>
        </div>
        <div className="domain-score" style={{ color: scoreColor(result.score) }}>
          {result.score}
        </div>
        <span className={`domain-expand-icon ${expanded ? 'expanded' : ''}`}>&#9662;</span>
      </button>

      {expanded && (
        <div className="domain-checks">
          {result.checks.map((check) => (
            <div
              key={check.id}
              className={`check-row check-row--${check.passed ? 'pass' : 'fail'}`}
            >
              <span className="check-icon">{check.passed ? '\u2713' : '\u2717'}</span>
              <div className="check-body">
                <span className="check-label">{check.label}</span>
                <span className="check-detail">{check.detail}</span>
              </div>
              <span className={`check-severity severity--${check.severity}`}>{check.severity}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WeightsEditor({
  weights,
  onChange
}: {
  weights: SecurityScoreWeights
  onChange: (domain: SecurityScoreDomain, value: number) => void
}) {
  const domains: SecurityScoreDomain[] = ['iam', 'network', 'encryption', 'logging', 'compliance']

  return (
    <div className="weights-editor">
      <h4>Score Weights</h4>
      {domains.map((domain) => (
        <div key={domain} className="weight-row">
          <label>{DOMAIN_LABELS[domain]}</label>
          <input
            type="range"
            min={0}
            max={50}
            value={weights[domain]}
            onChange={(e) => onChange(domain, Number(e.target.value))}
          />
          <span className="weight-value">{weights[domain]}%</span>
        </div>
      ))}
    </div>
  )
}

export function SecurityPostureDashboard({
  connection,
  refreshNonce = 0
}: {
  connection: AwsConnection
  refreshNonce?: number
}) {
  const [report, setReport] = useState<SecurityScoreReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedDomain, setExpandedDomain] = useState<SecurityScoreDomain | null>(null)
  const [showWeights, setShowWeights] = useState(false)
  const [weights, setWeights] = useState<SecurityScoreWeights>({
    iam: 30,
    network: 25,
    encryption: 20,
    logging: 15,
    compliance: 10
  })
  const freshness = useFreshnessState()

  async function loadReport() {
    setLoading(true)
    setError('')
    try {
      const result = await getSecurityScoreReport(connection, weights)
      setReport(result)
      freshness.markRefreshed()

      // Capture a daily snapshot for trend analysis. Failure here is non-fatal.
      try {
        const failedChecks = result.domainResults.flatMap((d) => d.checks.filter((c) => !c.passed))
        const high = failedChecks.filter((c) => c.severity === 'high').length
        const medium = failedChecks.filter((c) => c.severity === 'medium').length
        const low = failedChecks.filter((c) => c.severity === 'low').length
        const total = failedChecks.length
        const complianceDomain = result.domainResults.find((d) => d.domain === 'compliance')
        const passRate = complianceDomain ? complianceDomain.score : 0
        const scope = `${connection.profile || 'session'}::${connection.region}`
        const scopeLabel = connection.profile
          ? `${connection.profile} / ${connection.region}`
          : `session / ${connection.region}`

        const domainScores: Record<SecurityScoreDomain, number> = {
          iam: 0, network: 0, encryption: 0, logging: 0, compliance: 0
        }
        for (const d of result.domainResults) {
          domainScores[d.domain] = d.score
        }

        await recordSecuritySnapshot({
          scope,
          scopeLabel,
          overallScore: result.overallScore,
          domainScores,
          findingCounts: { high, medium, low, total },
          complianceBenchmarkPassRate: passRate,
          newFindings: 0,
          remediatedFindings: 0
        })
      } catch {
        /* snapshot is best-effort — do not surface to user */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadReport()
  }, [connection.profile, connection.region, refreshNonce])

  function handleRefresh() {
    invalidatePageCache('security-score')
    loadReport()
  }

  function handleWeightChange(domain: SecurityScoreDomain, value: number) {
    setWeights((prev) => ({ ...prev, [domain]: value }))
  }

  function handleApplyWeights() {
    invalidatePageCache('security-score')
    loadReport()
  }

  if (loading && !report) {
    return <SvcState variant="loading" resourceName="Security Score" />
  }

  if (error && !report) {
    return <SvcState variant="error" resourceName="Security Score" error={error} />
  }

  if (!report) {
    return <SvcState variant="empty" resourceName="Security Score" />
  }

  const failedChecks = report.domainResults.flatMap((d) => d.checks.filter((c) => !c.passed))
  const highFailures = failedChecks.filter((c) => c.severity === 'high')
  const mediumFailures = failedChecks.filter((c) => c.severity === 'medium')

  return (
    <div className="security-posture-dashboard">
      <div className="spd-header">
        <h2>Security Posture</h2>
        <div className="spd-header-actions">
          <FreshnessIndicator state={freshness} />
          <button className="btn btn-secondary" onClick={() => setShowWeights(!showWeights)} type="button">
            {showWeights ? 'Hide Weights' : 'Adjust Weights'}
          </button>
          <button className="btn btn-primary" onClick={handleRefresh} disabled={loading} type="button">
            {loading ? 'Scanning\u2026' : 'Rescan'}
          </button>
        </div>
      </div>

      {report.warnings.length > 0 && (
        <div className="spd-warnings">
          {report.warnings.map((w, i) => (
            <div key={i} className="spd-warning">{w}</div>
          ))}
        </div>
      )}

      <div className="spd-score-section">
        <div className="spd-score-main">
          <ScoreRing score={report.overallScore} />
          <div className="spd-score-summary">
            <div className="spd-score-headline">
              Overall Security Score: <strong>{report.overallScore}/100</strong>
            </div>
            <div className="spd-score-meta">
              {highFailures.length > 0 && (
                <span className="severity--high">{highFailures.length} critical finding(s)</span>
              )}
              {mediumFailures.length > 0 && (
                <span className="severity--medium">{mediumFailures.length} warning(s)</span>
              )}
              {failedChecks.length === 0 && <span className="severity--pass">All checks passed</span>}
            </div>
          </div>
        </div>

        <div className="spd-domain-bars">
          {report.domainResults.map((result) => (
            <div key={result.domain} className="domain-bar-row">
              <span className="domain-bar-label">{DOMAIN_LABELS[result.domain]}</span>
              <div className="domain-bar-track">
                <div
                  className="domain-bar-fill"
                  style={{ width: `${result.score}%`, backgroundColor: scoreColor(result.score) }}
                />
              </div>
              <span className="domain-bar-value">{result.score}</span>
            </div>
          ))}
        </div>
      </div>

      {showWeights && (
        <div className="spd-weights-section">
          <WeightsEditor weights={weights} onChange={handleWeightChange} />
          <button className="btn btn-primary" onClick={handleApplyWeights} type="button">
            Recalculate
          </button>
        </div>
      )}

      <div className="spd-domains">
        {report.domainResults.map((result) => (
          <DomainCard
            key={result.domain}
            result={result}
            expanded={expandedDomain === result.domain}
            onToggle={() =>
              setExpandedDomain(expandedDomain === result.domain ? null : result.domain)
            }
          />
        ))}
      </div>
    </div>
  )
}
