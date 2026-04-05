import { useEffect, useMemo, useState } from 'react'
import './compliance-center.css'
import { SvcState } from './SvcState'
import { FreshnessIndicator, useFreshnessState } from './freshness'

import type {
  AwsConnection,
  ComplianceCategory,
  ComplianceFinding,
  ComplianceFindingStatus,
  ComplianceFindingWorkflowUpdate,
  ComplianceReport,
  ComplianceSeverity,
  ServiceId
} from '@shared/types'
import { getComplianceReport, invalidatePageCache, rotateSecret, updateComplianceFindingWorkflow } from './api'
import { ConfirmButton } from './ConfirmButton'

const SEVERITY_ORDER: ComplianceSeverity[] = ['high', 'medium', 'low']
const CATEGORY_ORDER: ComplianceCategory[] = ['security', 'compliance', 'operations', 'cost']
const FINDING_STATUS_OPTIONS: ComplianceFindingStatus[] = ['open', 'in-progress', 'accepted-risk', 'resolved']

type WorkflowDraft = {
  owner: string
  status: ComplianceFindingStatus
  acceptedRisk: string
  snoozeUntil: string
  lastReviewedAt: string
}

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

function safeFilterLabel(value: string): string {
  return value.replace(/-/g, ' ')
}

function buildComplianceReportMarkdown(
  connection: AwsConnection,
  report: ComplianceReport,
  findings: ComplianceFinding[],
  filters: {
    severity: 'all' | ComplianceSeverity
    category: 'all' | ComplianceCategory
    service: 'all' | ServiceId
    search: string
  },
  policyPackTitles: Map<string, string>
): string {
  const lines: string[] = [
    '# AWS Lens Remediation Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Context: ${(connection.profile || 'session')} / ${connection.region || 'global'}`,
    `Visible findings: ${findings.length} of ${report.summary.total}`,
    '',
    '## Active Filters',
    `- Severity: ${filters.severity === 'all' ? 'All severities' : filters.severity}`,
    `- Category: ${filters.category === 'all' ? 'All categories' : filters.category}`,
    `- Service: ${filters.service === 'all' ? 'All services' : formatService(filters.service)}`,
    `- Search: ${filters.search.trim() || 'None'}`,
    '',
    '## Summary',
    `- High: ${findings.filter((finding) => finding.severity === 'high').length}`,
    `- Medium: ${findings.filter((finding) => finding.severity === 'medium').length}`,
    `- Low: ${findings.filter((finding) => finding.severity === 'low').length}`,
    ''
  ]

  for (const finding of findings) {
    lines.push(`## ${finding.title}`)
    lines.push(`- Severity: ${finding.severity}`)
    lines.push(`- Category: ${finding.category}`)
    lines.push(`- Service: ${formatService(finding.service)}`)
    lines.push(`- Region: ${finding.region || 'global'}`)
    lines.push(`- Resource: ${finding.resourceId || 'n/a'}`)
    lines.push(`- Status: ${safeFilterLabel(finding.workflow.status)}`)
    lines.push(`- Owner: ${finding.workflow.owner || 'Unassigned'}`)
    lines.push(`- Snooze Until: ${finding.workflow.snoozeUntil || 'Active'}`)
    lines.push(`- Last Reviewed: ${finding.workflow.lastReviewedAt || 'Not reviewed'}`)
    if (finding.workflow.acceptedRisk) {
      lines.push(`- Accepted Risk: ${finding.workflow.acceptedRisk}`)
    }
    if (finding.policyPackIds?.length) {
      lines.push(`- Policy Packs: ${finding.policyPackIds.map((packId) => policyPackTitles.get(packId) ?? packId).join(', ')}`)
    }
    lines.push('')
    lines.push('Description:')
    lines.push(finding.description)
    lines.push('')
    lines.push('Recommended Action:')
    lines.push(finding.recommendedAction)

    if (finding.remediationTemplates?.length) {
      lines.push('')
      lines.push('Remediation Templates:')
      for (const template of finding.remediationTemplates) {
        lines.push(`- ${template.title}: ${template.summary}`)
        for (const command of template.commands) {
          lines.push(`  - ${command.label}: \`${command.command}\``)
        }
      }
    }

    lines.push('')
  }

  return `${lines.join('\n').trim()}\n`
}

function downloadMarkdownReport(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function buildReportFilename(connection: AwsConnection): string {
  const context = (connection.profile || 'session').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
  const region = (connection.region || 'global').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
  const stamp = new Date().toISOString().slice(0, 10)
  return `aws-lens-remediation-report-${context}-${region}-${stamp}.md`
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
  const [policyPacksCollapsed, setPolicyPacksCollapsed] = useState(false)
  const [rotatingSecretId, setRotatingSecretId] = useState('')
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, WorkflowDraft>>({})
  const [savingWorkflowId, setSavingWorkflowId] = useState('')
  const [collapsedWorkflows, setCollapsedWorkflows] = useState<Record<string, boolean>>({})
  const [copiedCommandId, setCopiedCommandId] = useState('')
  const [exportingReport, setExportingReport] = useState<'copy' | 'download' | ''>('')
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

  const policyPackTitles = useMemo(() => (
    new Map((report?.policyPacks ?? []).map((pack) => [pack.id, pack.title]))
  ), [report])

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
        ...(finding.policyPackIds ?? []).map((packId) => policyPackTitles.get(packId) ?? packId),
        formatService(finding.service),
        finding.category,
        finding.severity
      ].join(' ').toLowerCase()

      return searchable.includes(query)
    })
  }, [report, severityFilter, categoryFilter, serviceFilter, search, policyPackTitles])

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

  function workflowDraftFor(finding: ComplianceFinding): WorkflowDraft {
    return workflowDrafts[finding.id] ?? {
      owner: finding.workflow.owner,
      status: finding.workflow.status,
      acceptedRisk: finding.workflow.acceptedRisk,
      snoozeUntil: finding.workflow.snoozeUntil ? finding.workflow.snoozeUntil.slice(0, 10) : '',
      lastReviewedAt: finding.workflow.lastReviewedAt
    }
  }

  function patchWorkflowDraft(findingId: string, update: Partial<WorkflowDraft>): void {
    setWorkflowDrafts((current) => ({
      ...current,
      [findingId]: {
        ...(current[findingId] ?? {
          owner: '',
          status: 'open',
          acceptedRisk: '',
          snoozeUntil: '',
          lastReviewedAt: ''
        }),
        ...update
      }
    }))
  }

  async function handleSaveWorkflow(finding: ComplianceFinding, update?: Partial<WorkflowDraft>): Promise<void> {
    const draft = {
      ...workflowDraftFor(finding),
      ...(update ?? {})
    }
    const payload: ComplianceFindingWorkflowUpdate = {
      owner: draft.owner,
      status: draft.status,
      acceptedRisk: draft.acceptedRisk,
      snoozeUntil: draft.snoozeUntil,
      lastReviewedAt: draft.lastReviewedAt
    }

    setSavingWorkflowId(finding.id)
    setError('')
    setMessage('')
    try {
      const workflow = await updateComplianceFindingWorkflow(connection, finding.id, payload)
      setReport((current) => current ? {
        ...current,
        findings: current.findings.map((item) => item.id === finding.id ? { ...item, workflow } : item)
      } : current)
      setWorkflowDrafts((current) => ({
        ...current,
        [finding.id]: {
          owner: workflow.owner,
          status: workflow.status,
          acceptedRisk: workflow.acceptedRisk,
          snoozeUntil: workflow.snoozeUntil ? workflow.snoozeUntil.slice(0, 10) : '',
          lastReviewedAt: workflow.lastReviewedAt
        }
      }))
      setMessage('Compliance workflow updated.')
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setSavingWorkflowId('')
    }
  }

  function formatWorkflowDate(value: string): string {
    return value ? new Date(value).toLocaleString() : 'Not reviewed'
  }

  function isWorkflowCollapsed(findingId: string): boolean {
    return collapsedWorkflows[findingId] ?? true
  }

  function toggleWorkflowCollapsed(findingId: string): void {
    setCollapsedWorkflows((current) => ({
      ...current,
      [findingId]: !(current[findingId] ?? true)
    }))
  }

  async function copyCommand(id: string, command: string): Promise<void> {
    await navigator.clipboard.writeText(command)
    setCopiedCommandId(id)
    window.setTimeout(() => {
      setCopiedCommandId((current) => current === id ? '' : current)
    }, 1200)
  }

  async function handleCopyReport(): Promise<void> {
    if (!report || filteredFindings.length === 0) {
      return
    }

    setExportingReport('copy')
    setError('')
    setMessage('')

    try {
      const markdown = buildComplianceReportMarkdown(
        connection,
        report,
        filteredFindings,
        {
          severity: severityFilter,
          category: categoryFilter,
          service: serviceFilter,
          search
        },
        policyPackTitles
      )
      await navigator.clipboard.writeText(markdown)
      setMessage('Remediation report copied.')
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError))
    } finally {
      setExportingReport('')
    }
  }

  function handleDownloadReport(): void {
    if (!report || filteredFindings.length === 0) {
      return
    }

    setExportingReport('download')
    setError('')
    setMessage('')

    try {
      const markdown = buildComplianceReportMarkdown(
        connection,
        report,
        filteredFindings,
        {
          severity: severityFilter,
          category: categoryFilter,
          service: serviceFilter,
          search
        },
        policyPackTitles
      )
      downloadMarkdownReport(buildReportFilename(connection), markdown)
      setMessage('Remediation report downloaded.')
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError))
    } finally {
      setExportingReport('')
    }
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

      {report?.policyPacks.length ? (
        <section className="panel stack compliance-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow compliance-panel-eyebrow">Local policy packs</div>
              <h3>Governance automation baselines</h3>
            </div>
            <div className="compliance-panel-actions">
              <span className="hero-path compliance-panel-summary">
                {report.policyPacks.length} active pack{report.policyPacks.length === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="compliance-collapse-button"
                onClick={() => setPolicyPacksCollapsed((current) => !current)}
              >
                {policyPacksCollapsed ? 'Expand' : 'Collapse'}
              </button>
            </div>
          </div>
          {policyPacksCollapsed ? (
            <div className="hero-path compliance-policy-pack-collapsed">
              <span>
                {report.policyPacks.reduce((total, pack) => total + pack.findingCount, 0)} finding
                {report.policyPacks.reduce((total, pack) => total + pack.findingCount, 0) === 1 ? '' : 's'}
              </span>
              <span>
                {report.policyPacks.map((pack) => `${pack.title} (${pack.findingCount})`).join(' • ')}
              </span>
            </div>
          ) : (
            <div className="compliance-policy-pack-grid">
              {report.policyPacks.map((pack) => (
                <article key={pack.id} className="compliance-policy-pack-row">
                  <div className="compliance-policy-pack-main">
                    <div className="compliance-finding-badges">
                      <span className="signal-badge">{pack.focus.replace(/-/g, ' ')}</span>
                    </div>
                    <h4>{pack.title}</h4>
                    <p>{pack.description}</p>
                  </div>
                  <div className="compliance-policy-pack-scope">
                    <span className="compliance-policy-pack-label">Coverage</span>
                    <strong>{pack.resourceTypes.join(', ')}</strong>
                  </div>
                  <div className="compliance-policy-pack-expectations">
                    <span className="compliance-policy-pack-label">Expectations</span>
                    <div className="compliance-policy-pack-list">
                      {pack.expectations.map((expectation) => (
                        <span key={expectation}>{expectation}</span>
                      ))}
                    </div>
                  </div>
                  <div className="compliance-policy-pack-count">
                    <strong>{pack.findingCount}</strong>
                    <span>finding{pack.findingCount === 1 ? '' : 's'}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

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

      <div className="tf-shell-toolbar compliance-shell-toolbar compliance-shell-toolbar-inline">
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
          <div className="compliance-toolbar-export">
            <button
              type="button"
              className="compliance-secondary-button"
              onClick={() => void handleCopyReport()}
              disabled={!report || filteredFindings.length === 0 || exportingReport !== ''}
            >
              {exportingReport === 'copy' ? 'Copying...' : 'Copy report'}
            </button>
            <button
              type="button"
              className="compliance-action-button"
              onClick={handleDownloadReport}
              disabled={!report || filteredFindings.length === 0 || exportingReport !== ''}
            >
              {exportingReport === 'download' ? 'Preparing...' : 'Download report'}
            </button>
          </div>
        </div>
        <div className="tf-shell-status compliance-shell-status">
          <FreshnessIndicator freshness={freshness} label="Compliance report" staleLabel="Refresh report" />
        </div>
      </div>

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
                        {(() => {
                          const workflowDraft = workflowDraftFor(finding)
                          const isSavingWorkflow = savingWorkflowId === finding.id
                          const workflowCollapsed = isWorkflowCollapsed(finding.id)

                          return (
                            <>
                        <div className="compliance-finding-header">
                          <div className="compliance-finding-copy">
                            <div className="compliance-finding-badges">
                              <span className={`signal-badge severity-${finding.severity}`}>{finding.severity}</span>
                              <span className="signal-badge">{finding.category}</span>
                              <span className="signal-badge">{workflowDraft.status.replace(/-/g, ' ')}</span>
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
                        <div className="compliance-workflow-shell">
                          <div className="compliance-workflow-summary">
                            <div className="compliance-workflow-summary-item">
                              <span>Owner</span>
                              <strong>{workflowDraft.owner || 'Unassigned'}</strong>
                            </div>
                            <div className="compliance-workflow-summary-item">
                              <span>Status</span>
                              <strong>{workflowDraft.status.replace(/-/g, ' ')}</strong>
                            </div>
                            <div className="compliance-workflow-summary-item">
                              <span>Snooze Until</span>
                              <strong>{workflowDraft.snoozeUntil || 'Active'}</strong>
                            </div>
                            <div className="compliance-workflow-summary-item">
                              <span>Last reviewed</span>
                              <strong>{formatWorkflowDate(finding.workflow.lastReviewedAt)}</strong>
                            </div>
                          </div>
                          <div className="compliance-workflow-actions">
                            <button
                              type="button"
                              className="compliance-secondary-button"
                              onClick={() => toggleWorkflowCollapsed(finding.id)}
                            >
                              {workflowCollapsed ? 'Show Workflow' : 'Hide Workflow'}
                            </button>
                            <button
                              type="button"
                              className="compliance-secondary-button"
                              onClick={() => void handleSaveWorkflow(finding, { lastReviewedAt: new Date().toISOString() })}
                              disabled={isSavingWorkflow}
                            >
                              {isSavingWorkflow ? 'Saving...' : 'Mark Reviewed'}
                            </button>
                            <button
                              type="button"
                              className="compliance-action-button"
                              onClick={() => void handleSaveWorkflow(finding)}
                              disabled={isSavingWorkflow}
                            >
                              {isSavingWorkflow ? 'Saving...' : 'Save Workflow'}
                            </button>
                          </div>
                        </div>
                        {!workflowCollapsed ? (
                          <div className="compliance-workflow-grid">
                            <label className="field compliance-workflow-field">
                              <span>Owner</span>
                              <input
                                value={workflowDraft.owner}
                                onChange={(event) => patchWorkflowDraft(finding.id, { owner: event.target.value })}
                                placeholder="Owner or team"
                              />
                            </label>
                            <label className="field compliance-workflow-field">
                              <span>Status</span>
                              <select
                                value={workflowDraft.status}
                                onChange={(event) => patchWorkflowDraft(finding.id, { status: event.target.value as ComplianceFindingStatus })}
                              >
                                {FINDING_STATUS_OPTIONS.map((status) => (
                                  <option key={status} value={status}>{status}</option>
                                ))}
                              </select>
                            </label>
                            <label className="field compliance-workflow-field">
                              <span>Snooze Until</span>
                              <input
                                type="date"
                                value={workflowDraft.snoozeUntil}
                                onChange={(event) => patchWorkflowDraft(finding.id, { snoozeUntil: event.target.value })}
                              />
                            </label>
                            <label className="field compliance-workflow-field compliance-workflow-notes">
                              <span>Accepted Risk</span>
                              <textarea
                                value={workflowDraft.acceptedRisk}
                                onChange={(event) => patchWorkflowDraft(finding.id, { acceptedRisk: event.target.value })}
                                placeholder="Document why this finding is tolerated, if applicable"
                                rows={2}
                              />
                            </label>
                          </div>
                        ) : null}
                        {finding.remediationTemplates?.length ? (
                          <div className="compliance-remediation-template-list">
                            {finding.remediationTemplates.map((template) => (
                              <section key={template.id} className="compliance-remediation-template">
                                <div className="compliance-remediation-template-head">
                                  <div>
                                    <span>Remediation template</span>
                                    <strong>{template.title}</strong>
                                  </div>
                                </div>
                                <p>{template.summary}</p>
                                <div className="compliance-remediation-command-list">
                                  {template.commands.map((command) => (
                                    <button
                                      key={`${template.id}:${command.label}`}
                                      type="button"
                                      className="compliance-secondary-button"
                                      onClick={() => void copyCommand(`${template.id}:${command.label}`, command.command)}
                                    >
                                      {copiedCommandId === `${template.id}:${command.label}` ? 'Copied' : command.label}
                                    </button>
                                  ))}
                                </div>
                              </section>
                            ))}
                          </div>
                        ) : null}
                        {finding.policyPackIds?.length ? (
                          <div className="compliance-policy-pack-list">
                            {finding.policyPackIds.map((packId) => (
                              <span key={packId}>{policyPackTitles.get(packId) ?? packId}</span>
                            ))}
                          </div>
                        ) : null}
                            </>
                          )
                        })()}
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
