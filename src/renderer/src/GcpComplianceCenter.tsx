import { useEffect, useMemo, useState } from 'react'

import type { ComplianceCategory, ComplianceFinding, ComplianceReport, ComplianceSeverity, GcpCliProject, ServiceId } from '@shared/types'
import {
  getGcpBillingOverview,
  getGcpIamOverview,
  getGcpProjectOverview,
  listGcpComputeInstances,
  listGcpGkeClusters,
  listGcpSqlInstances,
  listGcpStorageBuckets
} from './api'
import './compliance-center.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import { SvcState } from './SvcState'

const SEVERITY_ORDER: ComplianceSeverity[] = ['high', 'medium', 'low']
const CATEGORY_ORDER: ComplianceCategory[] = ['security', 'compliance', 'operations', 'cost']
const SERVICE_LABELS: Partial<Record<ServiceId, string>> = {
  'gcp-projects': 'Projects',
  'gcp-iam': 'IAM Posture',
  'gcp-compute-engine': 'Compute Engine',
  'gcp-gke': 'GKE',
  'gcp-cloud-storage': 'Cloud Storage',
  'gcp-cloud-sql': 'Cloud SQL',
  'gcp-billing': 'Billing'
}

function serviceLabel(service: ServiceId): string {
  return SERVICE_LABELS[service] ?? service
}

function issue(id: string, title: string, severity: ComplianceSeverity, category: ComplianceCategory, service: ServiceId, region: string, resourceId: string, description: string, recommendedAction: string, remediation?: ComplianceFinding['remediation']): ComplianceFinding {
  return {
    id,
    title,
    severity,
    category,
    service,
    region,
    resourceId,
    description,
    recommendedAction,
    policyPackIds: [],
    workflow: {
      owner: '',
      status: 'open',
      acceptedRisk: '',
      snoozeUntil: '',
      lastReviewedAt: '',
      updatedAt: ''
    },
    remediationTemplates: [],
    remediation
  }
}

function summarize(findings: ComplianceFinding[]) {
  return {
    total: findings.length,
    bySeverity: {
      high: findings.filter((finding) => finding.severity === 'high').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      low: findings.filter((finding) => finding.severity === 'low').length
    },
    byCategory: {
      security: findings.filter((finding) => finding.category === 'security').length,
      compliance: findings.filter((finding) => finding.category === 'compliance').length,
      operations: findings.filter((finding) => finding.category === 'operations').length,
      cost: findings.filter((finding) => finding.category === 'cost').length
    }
  }
}

async function buildReport(projectId: string, location: string, catalogProjectIds: string[]): Promise<ComplianceReport> {
  const results = await Promise.allSettled([
    getGcpProjectOverview(projectId),
    getGcpIamOverview(projectId),
    listGcpComputeInstances(projectId, location),
    listGcpGkeClusters(projectId, location),
    listGcpStorageBuckets(projectId, location),
    listGcpSqlInstances(projectId, location),
    getGcpBillingOverview(projectId, catalogProjectIds)
  ])

  const [projectResult, iamResult, computeResult, gkeResult, storageResult, sqlResult, billingResult] = results
  const findings: ComplianceFinding[] = []
  const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [`${['Projects', 'IAM', 'Compute', 'GKE', 'Storage', 'SQL', 'Billing'][index]} collector: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : [])

  if (projectResult.status === 'fulfilled') {
    for (const hint of projectResult.value.capabilityHints.filter((hint) => hint.severity !== 'info')) {
      findings.push(issue(`project:${hint.id}`, hint.title, hint.severity === 'error' ? 'high' : 'medium', 'operations', 'gcp-projects', 'global', projectId, hint.summary, hint.recommendedAction, { kind: 'navigate', label: 'Open Projects', serviceId: 'gcp-projects', resourceId: projectId }))
    }
    if (projectResult.value.enabledApiCount < 4) {
      findings.push(issue('project:api-coverage', 'Project has limited enabled API coverage', 'medium', 'operations', 'gcp-projects', 'global', projectId, `Only ${projectResult.value.enabledApiCount} enabled APIs are visible for this project.`, 'Enable the missing Google Cloud APIs required by the current operator slices.', { kind: 'terminal', label: 'List enabled APIs', command: `gcloud services list --enabled --project ${projectId}` }))
    }
  }

  if (iamResult.status === 'fulfilled') {
    if (iamResult.value.publicPrincipalCount > 0) findings.push(issue('iam:public', 'Public principals are present in project IAM', 'high', 'security', 'gcp-iam', 'global', projectId, `${iamResult.value.publicPrincipalCount} public principal bindings are visible in the current IAM posture.`, 'Review and remove broad public access unless it is explicitly intended.', { kind: 'navigate', label: 'Open IAM posture', serviceId: 'gcp-iam', resourceId: projectId }))
    if (iamResult.value.riskyBindingCount > 0) findings.push(issue('iam:risky', 'High-privilege IAM bindings need review', 'high', 'security', 'gcp-iam', 'global', projectId, `${iamResult.value.riskyBindingCount} risky bindings were detected in the project policy.`, 'Inspect affected principals and narrow privileged roles where possible.', { kind: 'terminal', label: 'Get IAM policy', command: `gcloud projects get-iam-policy ${projectId} --format=json` }))
  }

  if (computeResult.status === 'fulfilled') {
    const publicInstances = computeResult.value.filter((instance) => Boolean(instance.externalIp))
    if (publicInstances.length) findings.push(issue('compute:public-ip', 'Some Compute Engine instances expose external IP addresses', 'medium', 'security', 'gcp-compute-engine', location, publicInstances[0].name, `${publicInstances.length} instance${publicInstances.length === 1 ? '' : 's'} expose external IP addresses in the selected location.`, 'Review whether those instances require public exposure or can move to private access paths.', { kind: 'navigate', label: 'Open Compute Engine', serviceId: 'gcp-compute-engine', resourceId: projectId }))
  }

  if (gkeResult.status === 'fulfilled') {
    const unhealthy = gkeResult.value.filter((cluster) => cluster.status !== 'RUNNING')
    if (unhealthy.length) findings.push(issue('gke:status', 'Some GKE clusters are not in RUNNING state', 'medium', 'operations', 'gcp-gke', location, unhealthy[0].name, `${unhealthy.length} cluster${unhealthy.length === 1 ? '' : 's'} are not reporting RUNNING.`, 'Inspect cluster status and maintenance posture before relying on those clusters operationally.', { kind: 'navigate', label: 'Open GKE', serviceId: 'gcp-gke', resourceId: projectId }))
  }

  if (storageResult.status === 'fulfilled') {
    const noPap = storageResult.value.filter((bucket) => bucket.publicAccessPrevention.toLowerCase() !== 'enforced')
    const noUbla = storageResult.value.filter((bucket) => !bucket.uniformBucketLevelAccessEnabled)
    if (noPap.length) findings.push(issue('storage:pap', 'Some buckets do not enforce public access prevention', 'high', 'security', 'gcp-cloud-storage', location, noPap[0].name, `${noPap.length} bucket${noPap.length === 1 ? '' : 's'} are missing enforced public access prevention.`, 'Enable public access prevention on buckets that should never allow broad exposure.', { kind: 'navigate', label: 'Open Cloud Storage', serviceId: 'gcp-cloud-storage', resourceId: projectId }))
    if (noUbla.length) findings.push(issue('storage:ubla', 'Uniform bucket-level access is not fully enabled', 'medium', 'compliance', 'gcp-cloud-storage', location, noUbla[0].name, `${noUbla.length} bucket${noUbla.length === 1 ? '' : 's'} still rely on object ACL style access patterns.`, 'Standardize on uniform bucket-level access where object ACLs are not required.', { kind: 'terminal', label: 'Describe bucket', command: `gcloud storage buckets describe gs://${noUbla[0].name} --project ${projectId}` }))
  }

  if (sqlResult.status === 'fulfilled') {
    const publicSql = sqlResult.value.filter((instance) => Boolean(instance.primaryAddress))
    const unprotected = sqlResult.value.filter((instance) => !instance.deletionProtectionEnabled)
    if (publicSql.length) findings.push(issue('sql:public', 'Some Cloud SQL instances expose public endpoints', 'high', 'security', 'gcp-cloud-sql', location, publicSql[0].name, `${publicSql.length} Cloud SQL instance${publicSql.length === 1 ? '' : 's'} have public primary addresses.`, 'Confirm public exposure is intentional and prefer private connectivity where possible.', { kind: 'navigate', label: 'Open Cloud SQL', serviceId: 'gcp-cloud-sql', resourceId: projectId }))
    if (unprotected.length) findings.push(issue('sql:deletion-protection', 'Deletion protection is disabled on some Cloud SQL instances', 'medium', 'compliance', 'gcp-cloud-sql', location, unprotected[0].name, `${unprotected.length} Cloud SQL instance${unprotected.length === 1 ? '' : 's'} can be removed without deletion protection.`, 'Enable deletion protection on production-grade databases unless a deliberate exception is documented.', { kind: 'terminal', label: 'Describe SQL instance', command: `gcloud sql instances describe ${unprotected[0].name} --project ${projectId}` }))
  }

  if (billingResult.status === 'fulfilled') {
    if (!billingResult.value.billingEnabled) findings.push(issue('billing:detached', 'Project is not linked to an active billing account', 'high', 'cost', 'gcp-billing', 'global', projectId, 'The selected project is not currently attached to billing.', 'Attach the project to the intended billing account before treating it as production-ready.', { kind: 'navigate', label: 'Open Billing', serviceId: 'gcp-billing', resourceId: projectId }))
    if (billingResult.value.visibility !== 'full') findings.push(issue('billing:visibility', 'Billing visibility is limited', 'medium', 'cost', 'gcp-billing', 'global', projectId, `Billing visibility is currently "${billingResult.value.visibility}".`, 'Use a billing-account level context when you need linked-project and ownership coverage.', { kind: 'terminal', label: 'Inspect billing linkage', command: `gcloud beta billing projects describe ${projectId}` }))
    if (billingResult.value.linkedProjectLabelCoveragePercent < 60) findings.push(issue('billing:labels', 'Billing ownership labels have low coverage', 'medium', 'cost', 'gcp-billing', 'global', projectId, `Only ${Math.round(billingResult.value.linkedProjectLabelCoveragePercent)}% of linked projects have ownership labels visible in the current billing slice.`, 'Improve project labeling so cost ownership and review queues are easier to reason about.', { kind: 'navigate', label: 'Open Billing', serviceId: 'gcp-billing', resourceId: projectId }))
  }

  return {
    generatedAt: new Date().toISOString(),
    findings,
    policyPacks: [],
    summary: summarize(findings),
    warnings
  }
}

export function GcpComplianceCenter({ projectId, location, catalogProjects, refreshNonce = 0, onNavigate, onRunTerminalCommand, canRunTerminalCommand }: { projectId: string, location: string, catalogProjects: GcpCliProject[], refreshNonce?: number, onNavigate: (serviceId: ServiceId, resourceId?: string) => void, onRunTerminalCommand: (command: string) => void, canRunTerminalCommand: boolean }) {
  const [report, setReport] = useState<ComplianceReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [severityFilter, setSeverityFilter] = useState<'all' | ComplianceSeverity>('all')
  const [categoryFilter, setCategoryFilter] = useState<'all' | ComplianceCategory>('all')
  const [serviceFilter, setServiceFilter] = useState<'all' | ServiceId>('all')
  const [search, setSearch] = useState('')
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState()

  async function load(reason: Parameters<typeof beginRefresh>[0] = 'manual') {
    beginRefresh(reason); setLoading(true); setError('')
    try { setReport(await buildReport(projectId, location, catalogProjects.map((entry) => entry.projectId))); completeRefresh() } catch (e) { failRefresh(); setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  useEffect(() => { void load('session') }, [projectId, location, refreshNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const serviceOptions = useMemo(() => report ? [...new Set(report.findings.map((finding) => finding.service))].sort((a, b) => serviceLabel(a).localeCompare(serviceLabel(b))) : [], [report])
  const terminalFindingCount = useMemo(
    () => (report?.findings ?? []).filter((finding) => finding.remediation?.kind === 'terminal').length,
    [report]
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (report?.findings ?? []).filter((finding) => (severityFilter === 'all' || finding.severity === severityFilter) && (categoryFilter === 'all' || finding.category === categoryFilter) && (serviceFilter === 'all' || finding.service === serviceFilter) && (!q || [finding.title, finding.description, finding.resourceId, finding.recommendedAction, serviceLabel(finding.service)].join(' ').toLowerCase().includes(q)))
  }, [categoryFilter, report, search, serviceFilter, severityFilter])

  const grouped = useMemo(() => {
    const map = new Map<ComplianceSeverity, Map<ComplianceCategory, ComplianceFinding[]>>()
    for (const severity of SEVERITY_ORDER) map.set(severity, new Map())
    for (const finding of filtered) {
      const severityGroup = map.get(finding.severity) ?? new Map()
      severityGroup.set(finding.category, [...(severityGroup.get(finding.category) ?? []), finding]); map.set(finding.severity, severityGroup)
    }
    return map
  }, [filtered])

  function renderAction(finding: ComplianceFinding) {
    const remediation = finding.remediation
    if (!remediation) return null
    if (remediation.kind === 'navigate') return <button type="button" className="compliance-action-button" onClick={() => onNavigate(remediation.serviceId, remediation.resourceId ?? finding.resourceId)}>{remediation.label}</button>
    if (remediation.kind === 'terminal') return <button type="button" className="compliance-action-button" disabled={!canRunTerminalCommand} title={!canRunTerminalCommand ? 'Available only in operator mode' : undefined} onClick={() => onRunTerminalCommand(remediation.command)}>{remediation.label}</button>
    return null
  }

  return (
    <div className="stack compliance-center gcp-compliance-center">
      {error && <SvcState variant="error" error={error} />}
      {!canRunTerminalCommand && terminalFindingCount > 0 ? (
        <div className="error-banner">
          Read mode active. {terminalFindingCount} terminal action{terminalFindingCount === 1 ? ' is' : 's are'} disabled on this screen. Switch to Operator mode to run `gcloud` remediation commands.
        </div>
      ) : null}
      <section className="tf-shell-hero compliance-shell-hero">
        <div className="tf-shell-hero-copy compliance-shell-hero-copy">
          <div className="eyebrow">Compliance center</div>
          <h2>Google Cloud findings workspace</h2>
          <p>Review GCP project, IAM, storage, SQL, compute, GKE, and billing findings in the shared compliance workspace.</p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill"><span>Project</span><strong>{projectId}</strong></div>
            <div className="tf-shell-meta-pill"><span>Location</span><strong>{location}</strong></div>
            <div className="tf-shell-meta-pill"><span>Services</span><strong>{serviceOptions.length || 0} covered</strong></div>
            <div className="tf-shell-meta-pill"><span>Warnings</span><strong>{report?.warnings.length ?? 0} collector notices</strong></div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent"><span>Total findings</span><strong>{report?.summary.total ?? 0}</strong><small>{filtered.length} visible in the active queue</small></div>
          <div className="tf-shell-stat-card"><span>High severity</span><strong>{report?.summary.bySeverity.high ?? 0}</strong><small>Current high-risk GCP findings</small></div>
          <div className="tf-shell-stat-card"><span>Medium severity</span><strong>{report?.summary.bySeverity.medium ?? 0}</strong><small>Follow-up findings needing review</small></div>
          <div className="tf-shell-stat-card"><span>Last scan</span><strong>{report?.generatedAt ? new Date(report.generatedAt).toLocaleString() : 'Pending'}</strong><small>Refresh to rerun the GCP collectors</small></div>
        </div>
      </section>

      <div className="tf-shell-toolbar compliance-shell-toolbar">
        <div className="tf-toolbar compliance-shell-toolbar-main">
          <button type="button" className="accent" onClick={() => void load('manual')} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh report'}</button>
          <label className="field compliance-toolbar-field"><span>Severity</span><select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as 'all' | ComplianceSeverity)}><option value="all">All severities</option>{SEVERITY_ORDER.map((severity) => <option key={severity} value={severity}>{severity}</option>)}</select></label>
          <label className="field compliance-toolbar-field"><span>Category</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | ComplianceCategory)}><option value="all">All categories</option>{CATEGORY_ORDER.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
          <label className="field compliance-toolbar-field"><span>Service</span><select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value as 'all' | ServiceId)}><option value="all">All services</option>{serviceOptions.map((service) => <option key={service} value={service}>{serviceLabel(service)}</option>)}</select></label>
          <label className="field compliance-toolbar-search"><span>Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, resource, action" /></label>
        </div>
        <div className="tf-shell-status compliance-shell-status"><FreshnessIndicator freshness={freshness} label="Compliance report" staleLabel="Refresh report" /></div>
      </div>

      <section className="overview-tiles compliance-summary-grid">
        <div className="overview-tile highlight compliance-overview-tile"><strong>{report?.summary.total ?? 0}</strong><span>Total findings</span></div>
        <div className="overview-tile compliance-overview-tile"><strong>{report?.summary.bySeverity.high ?? 0}</strong><span>High severity</span></div>
        <div className="overview-tile compliance-overview-tile"><strong>{report?.summary.bySeverity.medium ?? 0}</strong><span>Medium severity</span></div>
        <div className="overview-tile compliance-overview-tile"><strong>{report?.summary.bySeverity.low ?? 0}</strong><span>Low severity</span></div>
        <div className="overview-tile compliance-overview-tile"><strong>{report?.generatedAt ? new Date(report.generatedAt).toLocaleString() : '-'}</strong><span>Last scan</span></div>
      </section>

      {report?.warnings.length ? <section className="panel stack compliance-panel compliance-warning-panel"><div className="panel-header"><h3>Collection Warnings</h3></div><div className="selection-list compliance-warning-list">{report.warnings.map((warning) => <div key={warning} className="selection-item compliance-warning-item"><span>{warning}</span></div>)}</div></section> : null}
      {loading && !report ? <SvcState variant="loading" resourceName="compliance findings" /> : null}
      {!loading && filtered.length === 0 ? <SvcState variant="no-filter-matches" resourceName="findings" /> : null}

      {SEVERITY_ORDER.map((severity) => {
        const severityGroups = grouped.get(severity)
        const severityCount = filtered.filter((finding) => finding.severity === severity).length
        if (!severityGroups || severityCount === 0) return null
        return <section key={severity} className={`panel stack compliance-panel compliance-severity-panel severity-${severity}`}><div className="panel-header compliance-severity-header"><div><h3>{severity.charAt(0).toUpperCase() + severity.slice(1)} Severity</h3></div><span className={`signal-badge severity-${severity}`}>{severityCount}</span></div>{CATEGORY_ORDER.map((category) => { const items = severityGroups.get(category) ?? []; if (!items.length) return null; return <div key={`${severity}-${category}`} className="compliance-category-block"><div className="compliance-category-header"><h4>{category}</h4><span>{items.length} item{items.length === 1 ? '' : 's'}</span></div><div className="compliance-finding-list">{items.map((finding) => <article key={finding.id} className={`compliance-finding-card severity-${finding.severity}`}><div className="compliance-finding-header"><div className="compliance-finding-copy"><div className="compliance-finding-badges"><span className={`signal-badge severity-${finding.severity}`}>{finding.severity}</span><span className="signal-badge">{finding.category}</span><span className="signal-badge">{serviceLabel(finding.service)}</span></div><h5>{finding.title}</h5><div className="hero-path compliance-finding-meta"><span>{finding.region}</span>{finding.resourceId ? <span>{finding.resourceId}</span> : null}</div></div><div className="compliance-finding-action">{renderAction(finding)}</div></div><p>{finding.description}</p><div className="compliance-next-step"><span>Recommended action</span><strong>{finding.recommendedAction}</strong></div></article>)}</div></div> })}</section>
      })}
    </div>
  )
}
