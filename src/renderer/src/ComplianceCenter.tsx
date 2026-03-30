import { useEffect, useMemo, useState } from 'react'
import './compliance-center.css'
import { SvcState } from './SvcState'
import { FreshnessIndicator, useFreshnessState } from './freshness'

import type {
  AwsConnection,
  ComplianceCategory,
  ComplianceFinding,
  ComplianceReport,
  ComplianceSeverity,
  ServiceId
} from '@shared/types'
import { getComplianceReport, invalidatePageCache, rotateSecret } from './api'
import { ConfirmButton } from './ConfirmButton'

const SEVERITY_ORDER: ComplianceSeverity[] = ['high', 'medium', 'low']
const CATEGORY_ORDER: ComplianceCategory[] = ['security', 'compliance', 'operations', 'cost']

const SERVICE_LABELS: Partial<Record<ServiceId, string>> = {
  'compliance-center': 'Compliance Center',
  overview: 'Overview',
  ec2: 'EC2',
  cloudwatch: 'CloudWatch',
  cloudtrail: 'CloudTrail',
  'load-balancers': 'Load Balancers',
  'security-groups': 'Security Groups',
  'secrets-manager': 'Secrets Manager',
  'key-pairs': 'Key Pairs',
  vpc: 'VPC',
  waf: 'WAF'
}

function formatService(service: ServiceId): string {
  return SERVICE_LABELS[service] ?? service
}

function formatTimestamp(value: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

export function ComplianceCenter({
  connection,
  refreshNonce = 0,
  onNavigate,
  onRunTerminalCommand
}: {
  connection: AwsConnection
  refreshNonce?: number
  onNavigate: (serviceId: ServiceId, resourceId?: string) => void
  onRunTerminalCommand: (command: string) => void
}) {
  const [report, setReport] = useState<ComplianceReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [severityFilter, setSeverityFilter] = useState<'all' | ComplianceSeverity>('all')
  const [categoryFilter, setCategoryFilter] = useState<'all' | ComplianceCategory>('all')
  const [serviceFilter, setServiceFilter] = useState<'all' | ServiceId>('all')
  const [search, setSearch] = useState('')
  const [rotatingSecretId, setRotatingSecretId] = useState('')
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState()

  async function load(reason: Parameters<typeof beginRefresh>[0] = 'manual'): Promise<void> {
    beginRefresh(reason)
    setLoading(true)
    setError('')
    try {
      const nextReport = await getComplianceReport(connection)
      setReport(nextReport)
      completeRefresh()
    } catch (loadError) {
      failRefresh()
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('session')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.sessionId, connection.region, refreshNonce])

  const serviceOptions = useMemo(() => {
    if (!report) return []
    return [...new Set(report.findings.map((finding) => finding.service))].sort((left, right) =>
      formatService(left).localeCompare(formatService(right))
    )
  }, [report])

  const filteredFindings = useMemo(() => {
    if (!report) return []

    const query = search.trim().toLowerCase()
    return report.findings.filter((finding) => {
      if (severityFilter !== 'all' && finding.severity !== severityFilter) return false
      if (categoryFilter !== 'all' && finding.category !== categoryFilter) return false
      if (serviceFilter !== 'all' && finding.service !== serviceFilter) return false
      if (!query) return true

      const searchable = [
        finding.title,
        finding.description,
        finding.resourceId,
        finding.recommendedAction,
        formatService(finding.service),
        finding.category,
        finding.severity
      ].join(' ').toLowerCase()

      return searchable.includes(query)
    })
  }, [report, severityFilter, categoryFilter, serviceFilter, search])

  const groupedFindings = useMemo(() => {
    const grouped = new Map<ComplianceSeverity, Map<ComplianceCategory, ComplianceFinding[]>>()

    for (const severity of SEVERITY_ORDER) {
      grouped.set(severity, new Map())
    }

    for (const finding of filteredFindings) {
      const severityGroup = grouped.get(finding.severity) ?? new Map<ComplianceCategory, ComplianceFinding[]>()
      const categoryGroup = severityGroup.get(finding.category) ?? []
      categoryGroup.push(finding)
      severityGroup.set(finding.category, categoryGroup)
      grouped.set(finding.severity, severityGroup)
    }

    return grouped
  }, [filteredFindings])

  const topService = useMemo(() => {
    if (!report) return null

    const counts = new Map<ServiceId, number>()
    for (const finding of report.findings) {
      counts.set(finding.service, (counts.get(finding.service) ?? 0) + 1)
    }

    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || formatService(left[0]).localeCompare(formatService(right[0])))[0] ?? null
  }, [report])

  const actionableCount = useMemo(() => (
    report?.findings.filter((finding) => Boolean(finding.remediation)).length ?? 0
  ), [report])

  const visibleHighRiskCount = useMemo(() => (
    filteredFindings.filter((finding) => finding.severity === 'high').length
  ), [filteredFindings])

  async function handleRotateSecret(secretId: string): Promise<void> {
    setRotatingSecretId(secretId)
    setError('')
    setMessage('')
    try {
      await rotateSecret(connection, secretId)
      invalidatePageCache('compliance-center')
      invalidatePageCache('secrets-manager')
      setMessage('Secret rotation started.')
      await load('workflow')
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setRotatingSecretId('')
    }
  }

  function renderAction(finding: ComplianceFinding) {
    const remediation = finding.remediation
    if (!remediation) {
      return null
    }

    if (remediation.kind === 'navigate') {
      return (
        <button
          type="button"
          className="compliance-action-button"
          onClick={() => onNavigate(remediation.serviceId, remediation.resourceId ?? finding.resourceId)}
        >
          {remediation.label}
        </button>
      )
    }

    if (remediation.kind === 'terminal') {
      return (
        <button
          type="button"
          className="compliance-action-button"
          onClick={() => onRunTerminalCommand(remediation.command)}
        >
          {remediation.label}
        </button>
      )
    }

    return (
      <ConfirmButton
        className="compliance-action-button"
        onConfirm={() => void handleRotateSecret(remediation.secretId)}
        disabled={rotatingSecretId === remediation.secretId}
      >
        {rotatingSecretId === remediation.secretId ? 'Rotating...' : remediation.label}
      </ConfirmButton>
    )
  }

  return (
    <div className="stack compliance-center">
      {error && <SvcState variant="error" error={error} />}
      {!error && message && (
        <div className="svc-msg">
          {message}
        </div>
      )}

      <section className="tf-shell-hero compliance-shell-hero">
        <div className="tf-shell-hero-copy compliance-shell-hero-copy">
          <div className="eyebrow">Compliance center</div>
          <h2>Operational findings workspace</h2>
          <p>
            Review security, compliance, operations, and cost findings in one queue with guided remediation for the active AWS context.
          </p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill">
              <span>Context</span>
              <strong>{connection.profile || 'Session context'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region || 'Global'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Services</span>
              <strong>{serviceOptions.length || 0} covered</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Warnings</span>
              <strong>{report?.warnings.length ?? 0} collector notices</strong>
            </div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent">
            <span>Total findings</span>
            <strong>{report?.summary.total ?? 0}</strong>
            <small>{filteredFindings.length} visible in the current queue</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>High severity</span>
            <strong>{report?.summary.bySeverity.high ?? 0}</strong>
            <small>{visibleHighRiskCount} high-severity items match the active filters</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Actionable</span>
            <strong>{actionableCount}</strong>
            <small>Findings with a direct remediation action</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Most affected</span>
            <strong>{topService ? formatService(topService[0]) : 'Waiting'}</strong>
            <small>{topService ? `${topService[1]} findings in the current report` : 'Load a report to rank services'}</small>
          </div>
        </div>
      </section>

      <div className="tf-shell-toolbar compliance-shell-toolbar">
        <div className="tf-toolbar compliance-shell-toolbar-main">
          <button type="button" className="accent" onClick={() => void load('manual')} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh report'}
          </button>
          <label className="field compliance-toolbar-field">
            <span>Severity</span>
            <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as 'all' | ComplianceSeverity)}>
              <option value="all">All severities</option>
              {SEVERITY_ORDER.map((severity) => (
                <option key={severity} value={severity}>{severity}</option>
              ))}
            </select>
          </label>
          <label className="field compliance-toolbar-field">
            <span>Category</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | ComplianceCategory)}>
              <option value="all">All categories</option>
              {CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
          <label className="field compliance-toolbar-field">
            <span>Service</span>
            <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value as 'all' | ServiceId)}>
              <option value="all">All services</option>
              {serviceOptions.map((service) => (
                <option key={service} value={service}>{formatService(service)}</option>
              ))}
            </select>
          </label>
          <label className="field compliance-toolbar-search">
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title, resource, action"
            />
          </label>
        </div>
        <div className="tf-shell-status compliance-shell-status">
          <FreshnessIndicator freshness={freshness} label="Compliance report" staleLabel="Refresh report" />
        </div>
      </div>

      <section className="overview-tiles compliance-summary-grid">
        <div className="overview-tile highlight compliance-overview-tile">
          <strong>{report?.summary.total ?? 0}</strong>
          <span>Total findings</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{report?.summary.bySeverity.high ?? 0}</strong>
          <span>High severity</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{report?.summary.bySeverity.medium ?? 0}</strong>
          <span>Medium severity</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{report?.summary.bySeverity.low ?? 0}</strong>
          <span>Low severity</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{formatTimestamp(report?.generatedAt ?? '')}</strong>
          <span>Last scan</span>
        </div>
      </section>

      <section className="panel stack compliance-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow compliance-panel-eyebrow">Category posture</div>
            <h3>Finding distribution</h3>
          </div>
          <span className="hero-path compliance-panel-summary">
            {filteredFindings.length} finding{filteredFindings.length === 1 ? '' : 's'} in the active queue
          </span>
        </div>
        <div className="compliance-category-strip">
          {CATEGORY_ORDER.map((category) => (
            <button
              key={category}
              type="button"
              className={`compliance-category-chip ${categoryFilter === category ? 'active' : ''}`}
              onClick={() => setCategoryFilter((current) => current === category ? 'all' : category)}
            >
              <span>{category}</span>
              <strong>{report?.summary.byCategory[category] ?? 0}</strong>
            </button>
          ))}
        </div>
      </section>

      {report?.warnings.length ? (
        <section className="panel stack compliance-panel compliance-warning-panel">
          <div className="panel-header">
            <h3>Collection Warnings</h3>
          </div>
          <div className="selection-list compliance-warning-list">
            {report.warnings.map((warning) => (
              <div key={warning} className="selection-item compliance-warning-item">
                <span>{warning}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {loading && !report ? <SvcState variant="loading" resourceName="compliance findings" /> : null}

      {!loading && filteredFindings.length === 0 ? (
        <SvcState variant="no-filter-matches" resourceName="findings" />
      ) : null}

      {SEVERITY_ORDER.map((severity) => {
        const severityGroups = groupedFindings.get(severity)
        const severityCount = filteredFindings.filter((finding) => finding.severity === severity).length
        if (!severityGroups || severityCount === 0) {
          return null
        }

        return (
          <section key={severity} className={`panel stack compliance-panel compliance-severity-panel severity-${severity}`}>
            <div className="panel-header compliance-severity-header">
              <div>
                <h3>{severity.charAt(0).toUpperCase() + severity.slice(1)} Severity</h3>
              </div>
              <span className={`signal-badge severity-${severity}`}>{severityCount}</span>
            </div>

            {CATEGORY_ORDER.map((category) => {
              const items = severityGroups.get(category) ?? []
              if (items.length === 0) {
                return null
              }

              return (
                <div key={`${severity}-${category}`} className="compliance-category-block">
                  <div className="compliance-category-header">
                    <h4>{category}</h4>
                    <span>{items.length} item{items.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="compliance-finding-list">
                    {items.map((finding) => (
                      <article key={finding.id} className={`compliance-finding-card severity-${finding.severity}`}>
                        <div className="compliance-finding-header">
                          <div className="compliance-finding-copy">
                            <div className="compliance-finding-badges">
                              <span className={`signal-badge severity-${finding.severity}`}>{finding.severity}</span>
                              <span className="signal-badge">{finding.category}</span>
                              <span className="signal-badge">{formatService(finding.service)}</span>
                            </div>
                            <h5>{finding.title}</h5>
                            <div className="hero-path compliance-finding-meta">
                              <span>{finding.region}</span>
                              {finding.resourceId ? <span>{finding.resourceId}</span> : null}
                            </div>
                          </div>
                          <div className="compliance-finding-action">
                            {renderAction(finding)}
                          </div>
                        </div>
                        <p>{finding.description}</p>
                        <div className="compliance-next-step">
                          <span>Recommended action</span>
                          <strong>{finding.recommendedAction}</strong>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
