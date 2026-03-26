import { useEffect, useMemo, useState } from 'react'

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
  onNavigate: (serviceId: ServiceId) => void
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

  async function load(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      setReport(await getComplianceReport(connection))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.profile, connection.region, refreshNonce])

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

  async function handleRotateSecret(secretId: string): Promise<void> {
    setRotatingSecretId(secretId)
    setError('')
    setMessage('')
    try {
      await rotateSecret(connection, secretId)
      invalidatePageCache('compliance-center')
      invalidatePageCache('secrets-manager')
      setMessage('Secret rotation started.')
      await load()
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
          onClick={() => onNavigate(remediation.serviceId)}
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
    <div className="stack">
      {(error || message) && (
        <div className={error ? 'error-banner' : 'svc-msg'}>
          {error || message}
        </div>
      )}

      <section className="overview-tiles compliance-summary-grid">
        <div className="overview-tile highlight">
          <strong>{report?.summary.total ?? 0}</strong>
          <span>Total Findings</span>
        </div>
        <div className="overview-tile">
          <strong>{report?.summary.bySeverity.high ?? 0}</strong>
          <span>High</span>
        </div>
        <div className="overview-tile">
          <strong>{report?.summary.bySeverity.medium ?? 0}</strong>
          <span>Medium</span>
        </div>
        <div className="overview-tile">
          <strong>{report?.summary.bySeverity.low ?? 0}</strong>
          <span>Low</span>
        </div>
        <div className="overview-tile">
          <strong>{formatTimestamp(report?.generatedAt ?? '')}</strong>
          <span>Last Scan</span>
        </div>
      </section>

      <section className="panel stack">
        <div className="panel-header">
          <h3>Categories</h3>
          <span className="hero-path" style={{ margin: 0 }}>
            {filteredFindings.length} finding{filteredFindings.length === 1 ? '' : 's'} after filters
          </span>
        </div>
        <div className="overview-chip-row">
          {CATEGORY_ORDER.map((category) => (
            <button
              key={category}
              type="button"
              className={`overview-service-chip ${categoryFilter === category ? 'active' : ''}`}
              onClick={() => setCategoryFilter((current) => current === category ? 'all' : category)}
            >
              <span>{category}</span>
              <strong>{report?.summary.byCategory[category] ?? 0}</strong>
            </button>
          ))}
        </div>
      </section>

      {report?.warnings.length ? (
        <section className="panel stack">
          <div className="panel-header">
            <h3>Collection Warnings</h3>
          </div>
          <div className="selection-list">
            {report.warnings.map((warning) => (
              <div key={warning} className="selection-item">
                <span>{warning}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel stack">
        <div className="panel-header">
          <h3>Filters</h3>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        <div className="inline-form compliance-filter-grid">
          <label className="field">
            <span>Severity</span>
            <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as 'all' | ComplianceSeverity)}>
              <option value="all">All severities</option>
              {SEVERITY_ORDER.map((severity) => (
                <option key={severity} value={severity}>{severity}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Category</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | ComplianceCategory)}>
              <option value="all">All categories</option>
              {CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Service</span>
            <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value as 'all' | ServiceId)}>
              <option value="all">All services</option>
              {serviceOptions.map((service) => (
                <option key={service} value={service}>{formatService(service)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title, resource, action"
            />
          </label>
        </div>
      </section>

      {loading && !report ? <div className="empty-state compact">Loading compliance findings...</div> : null}

      {!loading && filteredFindings.length === 0 ? (
        <div className="empty-state compact">No findings match the current filters.</div>
      ) : null}

      {SEVERITY_ORDER.map((severity) => {
        const severityGroups = groupedFindings.get(severity)
        const severityCount = filteredFindings.filter((finding) => finding.severity === severity).length
        if (!severityGroups || severityCount === 0) {
          return null
        }

        return (
          <section key={severity} className="panel stack">
            <div className="panel-header">
              <h3>{severity.charAt(0).toUpperCase() + severity.slice(1)} Severity</h3>
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
                    <span>{items.length}</span>
                  </div>
                  <div className="compliance-finding-list">
                    {items.map((finding) => (
                      <article key={finding.id} className="compliance-finding-card">
                        <div className="compliance-finding-header">
                          <div>
                            <div className="compliance-finding-badges">
                              <span className={`signal-badge severity-${finding.severity}`}>{finding.severity}</span>
                              <span className="signal-badge">{finding.category}</span>
                              <span className="signal-badge">{formatService(finding.service)}</span>
                            </div>
                            <h5>{finding.title}</h5>
                          </div>
                          {renderAction(finding)}
                        </div>
                        <div className="hero-path compliance-finding-meta">
                          <span>{finding.region}</span>
                          {finding.resourceId ? <span>{finding.resourceId}</span> : null}
                        </div>
                        <p>{finding.description}</p>
                        <div className="compliance-next-step">
                          Recommended action: {finding.recommendedAction}
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
