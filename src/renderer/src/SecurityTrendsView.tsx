import { useEffect, useMemo, useState } from 'react'
import './security-trends-view.css'
import { SvcState } from './SvcState'

import type {
  SecurityAlert,
  SecurityScoreDomain,
  SecuritySnapshot,
  SecurityThresholds,
  SecurityTrendRange,
  SecurityTrendReport
} from '@shared/types'
import {
  buildSecurityTrendReport,
  listSecurityScopes,
  updateSecurityThresholds
} from './api'

const RANGES: Array<{ id: SecurityTrendRange; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '1y', label: '1 year' }
]

const DOMAIN_LABELS: Record<SecurityScoreDomain, string> = {
  iam: 'IAM',
  network: 'Network',
  encryption: 'Encryption',
  logging: 'Logging',
  compliance: 'Compliance'
}

const DOMAIN_COLORS: Record<SecurityScoreDomain, string> = {
  iam: '#6366f1',
  network: '#06b6d4',
  encryption: '#22c55e',
  logging: '#eab308',
  compliance: '#f97316'
}

/* ── Chart helpers ───────────────────────────────────────── */

type LineChartProps = {
  width: number
  height: number
  snapshots: SecuritySnapshot[]
  valueKey: (s: SecuritySnapshot) => number
  color: string
  fillColor?: string
  yMin?: number
  yMax?: number
  label?: string
}

function LineChart({
  width,
  height,
  snapshots,
  valueKey,
  color,
  fillColor,
  yMin = 0,
  yMax = 100,
  label
}: LineChartProps) {
  const padding = { top: 16, right: 16, bottom: 24, left: 40 }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom

  if (snapshots.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fill="#94a3b8" fontSize={12}>
          No data
        </text>
      </svg>
    )
  }

  const n = snapshots.length
  const xStep = n > 1 ? innerW / (n - 1) : 0
  const yRange = yMax - yMin || 1

  const points = snapshots.map((s, i) => ({
    x: padding.left + i * xStep,
    y: padding.top + innerH - ((valueKey(s) - yMin) / yRange) * innerH,
    value: valueKey(s),
    label: s.capturedAt
  }))

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const areaD = `${pathD} L ${points[points.length - 1].x} ${padding.top + innerH} L ${points[0].x} ${padding.top + innerH} Z`

  // Y-axis ticks
  const ticks = [0, 25, 50, 75, 100]
  const yTicks = ticks.map((v) => ({
    y: padding.top + innerH - ((v - yMin) / yRange) * innerH,
    value: v
  })).filter((t) => t.value >= yMin && t.value <= yMax)

  return (
    <svg width={width} height={height} className="stv-chart">
      {label && (
        <text x={padding.left} y={padding.top - 4} fill="#aaa" fontSize={11} fontWeight={600}>
          {label}
        </text>
      )}

      {/* Y gridlines */}
      {yTicks.map((t) => (
        <g key={t.value}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={t.y}
            y2={t.y}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={1}
          />
          <text x={padding.left - 6} y={t.y + 3} textAnchor="end" fontSize={10} fill="#94a3b8">
            {t.value}
          </text>
        </g>
      ))}

      {/* Area fill */}
      {fillColor && <path d={areaD} fill={fillColor} />}

      {/* Line */}
      <path d={pathD} fill="none" stroke={color} strokeWidth={2} />

      {/* Points */}
      {points.map((p) => (
        <circle key={p.label} cx={p.x} cy={p.y} r={3} fill={color}>
          <title>{`${p.label}: ${p.value}`}</title>
        </circle>
      ))}

      {/* X-axis dates (first, last, middle) */}
      {points.length > 0 && (
        <>
          <text x={points[0].x} y={height - 6} fontSize={10} fill="#94a3b8" textAnchor="start">
            {points[0].label}
          </text>
          <text x={points[points.length - 1].x} y={height - 6} fontSize={10} fill="#94a3b8" textAnchor="end">
            {points[points.length - 1].label}
          </text>
        </>
      )}
    </svg>
  )
}

function StackedAreaChart({
  width,
  height,
  snapshots
}: {
  width: number
  height: number
  snapshots: SecuritySnapshot[]
}) {
  const padding = { top: 16, right: 16, bottom: 24, left: 40 }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom

  if (snapshots.length === 0) {
    return (
      <svg width={width} height={height}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fill="#94a3b8" fontSize={12}>
          No data
        </text>
      </svg>
    )
  }

  const maxTotal = Math.max(
    1,
    ...snapshots.map((s) => s.findingCounts.high + s.findingCounts.medium + s.findingCounts.low)
  )

  const n = snapshots.length
  const xStep = n > 1 ? innerW / (n - 1) : 0

  function series(getValue: (s: SecuritySnapshot) => number, offset: (s: SecuritySnapshot) => number): string {
    const pts = snapshots.map((s, i) => ({
      x: padding.left + i * xStep,
      yTop: padding.top + innerH - ((offset(s) + getValue(s)) / maxTotal) * innerH,
      yBottom: padding.top + innerH - (offset(s) / maxTotal) * innerH
    }))
    const top = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.yTop}`).join(' ')
    const bottom = pts.slice().reverse().map((p) => `L ${p.x} ${p.yBottom}`).join(' ')
    return `${top} ${bottom} Z`
  }

  const highPath = series((s) => s.findingCounts.high, () => 0)
  const mediumPath = series((s) => s.findingCounts.medium, (s) => s.findingCounts.high)
  const lowPath = series(
    (s) => s.findingCounts.low,
    (s) => s.findingCounts.high + s.findingCounts.medium
  )

  return (
    <svg width={width} height={height} className="stv-chart">
      <text x={padding.left} y={padding.top - 4} fill="#aaa" fontSize={11} fontWeight={600}>
        Findings by severity
      </text>
      <path d={lowPath} fill="rgba(234,179,8,0.4)" stroke="#eab308" strokeWidth={1} />
      <path d={mediumPath} fill="rgba(249,115,22,0.4)" stroke="#f97316" strokeWidth={1} />
      <path d={highPath} fill="rgba(239,68,68,0.4)" stroke="#ef4444" strokeWidth={1} />

      {/* Legend */}
      <g transform={`translate(${width - 140}, ${padding.top})`}>
        <rect x={0} y={0} width={10} height={10} fill="#ef4444" />
        <text x={14} y={9} fontSize={10} fill="#ccc">High</text>
        <rect x={0} y={14} width={10} height={10} fill="#f97316" />
        <text x={14} y={23} fontSize={10} fill="#ccc">Medium</text>
        <rect x={0} y={28} width={10} height={10} fill="#eab308" />
        <text x={14} y={37} fontSize={10} fill="#ccc">Low</text>
      </g>
    </svg>
  )
}

function DomainBreakdownChart({
  width,
  height,
  snapshots
}: {
  width: number
  height: number
  snapshots: SecuritySnapshot[]
}) {
  const padding = { top: 16, right: 16, bottom: 24, left: 40 }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom

  if (snapshots.length === 0) {
    return null
  }

  const domains: SecurityScoreDomain[] = ['iam', 'network', 'encryption', 'logging', 'compliance']
  const n = snapshots.length
  const xStep = n > 1 ? innerW / (n - 1) : 0

  function pathFor(domain: SecurityScoreDomain): string {
    return snapshots
      .map((s, i) => {
        const x = padding.left + i * xStep
        const y = padding.top + innerH - (s.domainScores[domain] / 100) * innerH
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`
      })
      .join(' ')
  }

  return (
    <svg width={width} height={height} className="stv-chart">
      <text x={padding.left} y={padding.top - 4} fill="#aaa" fontSize={11} fontWeight={600}>
        Domain scores over time
      </text>
      {[0, 25, 50, 75, 100].map((v) => {
        const y = padding.top + innerH - (v / 100) * innerH
        return (
          <g key={v}>
            <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" />
            <text x={padding.left - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#94a3b8">{v}</text>
          </g>
        )
      })}
      {domains.map((d) => (
        <path key={d} d={pathFor(d)} fill="none" stroke={DOMAIN_COLORS[d]} strokeWidth={1.8} />
      ))}

      {/* Legend */}
      <g transform={`translate(${width - 110}, ${padding.top})`}>
        {domains.map((d, i) => (
          <g key={d} transform={`translate(0, ${i * 14})`}>
            <rect x={0} y={0} width={10} height={10} fill={DOMAIN_COLORS[d]} />
            <text x={14} y={9} fontSize={10} fill="#ccc">{DOMAIN_LABELS[d]}</text>
          </g>
        ))}
      </g>
    </svg>
  )
}

/* ── Sub-components ──────────────────────────────────────── */

function ThresholdsEditor({
  thresholds,
  onSave
}: {
  thresholds: SecurityThresholds
  onSave: (update: SecurityThresholds) => Promise<void>
}) {
  const [draft, setDraft] = useState(thresholds)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  useEffect(() => {
    setDraft(thresholds)
  }, [thresholds])

  async function handleSave() {
    setSaving(true)
    setSavedMsg('')
    try {
      await onSave(draft)
      setSavedMsg('Saved')
      setTimeout(() => setSavedMsg(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stv-thresholds-editor">
      <h4>Alert Thresholds</h4>
      <div className="stv-threshold-row">
        <label>Minimum overall score</label>
        <input
          type="number"
          min={0}
          max={100}
          value={draft.minOverallScore}
          onChange={(e) => setDraft({ ...draft, minOverallScore: Number(e.target.value) })}
        />
      </div>
      <div className="stv-threshold-row">
        <label>Max high-severity findings</label>
        <input
          type="number"
          min={0}
          value={draft.maxHighFindings}
          onChange={(e) => setDraft({ ...draft, maxHighFindings: Number(e.target.value) })}
        />
      </div>
      <div className="stv-threshold-row">
        <label>Max total findings</label>
        <input
          type="number"
          min={0}
          value={draft.maxTotalFindings}
          onChange={(e) => setDraft({ ...draft, maxTotalFindings: Number(e.target.value) })}
        />
      </div>
      <div className="stv-threshold-row">
        <label>Score drop alert (%)</label>
        <input
          type="number"
          min={0}
          max={100}
          value={draft.scoreDropPct}
          onChange={(e) => setDraft({ ...draft, scoreDropPct: Number(e.target.value) })}
        />
      </div>
      <div className="stv-threshold-actions">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving\u2026' : 'Save Thresholds'}
        </button>
        {savedMsg && <span className="stv-saved">{savedMsg}</span>}
      </div>
    </div>
  )
}

function AlertsList({ alerts }: { alerts: SecurityAlert[] }) {
  if (alerts.length === 0) {
    return (
      <div className="stv-alerts-empty">
        <span className="stv-alerts-icon">\u2713</span>
        No active alerts — all thresholds satisfied.
      </div>
    )
  }

  return (
    <div className="stv-alerts-list">
      {alerts.map((alert) => (
        <div key={alert.id} className={`stv-alert stv-alert--${alert.severity}`}>
          <div className="stv-alert-icon">\u26A0</div>
          <div className="stv-alert-body">
            <div className="stv-alert-title">{alert.message}</div>
            <div className="stv-alert-detail">{alert.detail}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Main component ──────────────────────────────────────── */

export function SecurityTrendsView({ initialScope }: { initialScope?: string } = {}) {
  const [scopes, setScopes] = useState<Array<{ scope: string; scopeLabel: string; snapshotCount: number }>>([])
  const [activeScope, setActiveScope] = useState<string>(initialScope ?? '')
  const [range, setRange] = useState<SecurityTrendRange>('30d')
  const [report, setReport] = useState<SecurityTrendReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    listSecurityScopes()
      .then((s) => {
        if (cancelled) return
        setScopes(s)
        if (!activeScope && s.length > 0) {
          setActiveScope(s[0].scope)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function loadReport() {
    if (!activeScope) return
    setLoading(true)
    setError('')
    try {
      const r = await buildSecurityTrendReport(activeScope, range)
      setReport(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (activeScope) {
      void loadReport()
    }
  }, [activeScope, range])

  async function handleThresholdsSave(update: SecurityThresholds): Promise<void> {
    await updateSecurityThresholds(update)
    await loadReport()
  }

  const scopeSummary = useMemo(() => {
    if (!report) return null
    const { summary } = report
    const direction = summary.trendDirection === 'up' ? '\u2191' : summary.trendDirection === 'down' ? '\u2193' : '\u2192'
    return { direction, ...summary }
  }, [report])

  if (scopes.length === 0 && !loading) {
    return (
      <div className="security-trends-view">
        <div className="stv-empty-state">
          <h3>No security snapshots yet</h3>
          <p>
            Snapshots are captured from Security Posture Dashboard runs. Open the Security Posture
            Dashboard to generate your first snapshot, then return here to see trends.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="security-trends-view">
      <div className="stv-header">
        <h2>Security Trends & Historical Analysis</h2>
        <div className="stv-header-actions">
          <select value={activeScope} onChange={(e) => setActiveScope(e.target.value)}>
            {scopes.map((s) => (
              <option key={s.scope} value={s.scope}>
                {s.scopeLabel} ({s.snapshotCount})
              </option>
            ))}
          </select>
          <div className="stv-range-tabs">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`stv-range-tab ${range === r.id ? 'active' : ''}`}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={loadReport} disabled={loading} type="button">
            {loading ? 'Loading\u2026' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="stv-error">
          {error}
        </div>
      )}

      {loading && !report ? (
        <SvcState variant="loading" resourceName="Security Trends" />
      ) : report && report.snapshots.length === 0 ? (
        <div className="stv-empty-state">
          <h3>No snapshots in this range</h3>
          <p>Try a longer time range, or capture a new snapshot from the Security Posture Dashboard.</p>
        </div>
      ) : report ? (
        <>
          {/* Summary bar */}
          {scopeSummary && (
            <div className="stv-summary">
              <div className="stv-summary-card">
                <span className="stv-summary-label">Current Score</span>
                <strong className="stv-summary-value">{scopeSummary.currentScore}</strong>
              </div>
              <div className="stv-summary-card">
                <span className="stv-summary-label">Previous</span>
                <strong className="stv-summary-value">{scopeSummary.previousScore}</strong>
              </div>
              <div className={`stv-summary-card stv-summary-card--${scopeSummary.trendDirection}`}>
                <span className="stv-summary-label">Trend</span>
                <strong className="stv-summary-value">
                  {scopeSummary.direction} {scopeSummary.scoreDelta > 0 ? '+' : ''}{scopeSummary.scoreDelta}
                </strong>
              </div>
              <div className="stv-summary-card">
                <span className="stv-summary-label">Snapshots</span>
                <strong className="stv-summary-value">{scopeSummary.snapshotCount}</strong>
              </div>
            </div>
          )}

          {/* Alerts */}
          <div className="stv-panel">
            <h3>Active Alerts</h3>
            <AlertsList alerts={report.alerts} />
          </div>

          {/* Charts */}
          <div className="stv-charts">
            <div className="stv-chart-panel">
              <LineChart
                width={560}
                height={220}
                snapshots={report.snapshots}
                valueKey={(s) => s.overallScore}
                color="#6366f1"
                fillColor="rgba(99, 102, 241, 0.15)"
                label="Overall score over time"
              />
            </div>
            <div className="stv-chart-panel">
              <StackedAreaChart width={560} height={220} snapshots={report.snapshots} />
            </div>
            <div className="stv-chart-panel stv-chart-panel--wide">
              <DomainBreakdownChart width={1136} height={220} snapshots={report.snapshots} />
            </div>
            <div className="stv-chart-panel">
              <LineChart
                width={560}
                height={220}
                snapshots={report.snapshots}
                valueKey={(s) => s.complianceBenchmarkPassRate}
                color="#22c55e"
                fillColor="rgba(34, 197, 94, 0.12)"
                label="Compliance benchmark pass rate (%)"
              />
            </div>
            <div className="stv-chart-panel">
              <LineChart
                width={560}
                height={220}
                snapshots={report.snapshots}
                valueKey={(s) => s.newFindings - s.remediatedFindings}
                color="#f97316"
                yMin={-10}
                yMax={Math.max(
                  10,
                  ...report.snapshots.map((s) => Math.abs(s.newFindings - s.remediatedFindings))
                )}
                label="Net new findings (new \u2212 remediated)"
              />
            </div>
          </div>

          {/* Thresholds */}
          <div className="stv-panel">
            <ThresholdsEditor thresholds={report.thresholds} onSave={handleThresholdsSave} />
          </div>

          {/* Recent snapshots table */}
          <div className="stv-panel">
            <h3>Recent Snapshots</h3>
            <table className="stv-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Overall Score</th>
                  <th>High</th>
                  <th>Medium</th>
                  <th>Low</th>
                  <th>Total</th>
                  <th>Compliance %</th>
                  <th>New</th>
                  <th>Remediated</th>
                </tr>
              </thead>
              <tbody>
                {[...report.snapshots].reverse().slice(0, 20).map((s) => (
                  <tr key={s.id}>
                    <td>{s.capturedAt}</td>
                    <td><strong>{s.overallScore}</strong></td>
                    <td style={{ color: '#ef4444' }}>{s.findingCounts.high}</td>
                    <td style={{ color: '#f97316' }}>{s.findingCounts.medium}</td>
                    <td style={{ color: '#eab308' }}>{s.findingCounts.low}</td>
                    <td>{s.findingCounts.total}</td>
                    <td>{s.complianceBenchmarkPassRate}%</td>
                    <td style={{ color: '#ef4444' }}>+{s.newFindings}</td>
                    <td style={{ color: '#22c55e' }}>-{s.remediatedFindings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  )
}
