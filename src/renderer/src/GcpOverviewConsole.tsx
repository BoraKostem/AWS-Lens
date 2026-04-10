import { useEffect, useMemo, useState } from 'react'

import type {
  GcpBillingOverview,
  GcpCliProject,
  GcpComputeInstanceSummary,
  GcpGkeClusterSummary,
  GcpIamOverview,
  GcpLogQueryResult,
  GcpProjectOverview,
  GcpSqlInstanceSummary,
  GcpStorageBucketSummary,
  ServiceId
} from '@shared/types'
import {
  getGcpBillingOverview,
  getGcpIamOverview,
  getGcpProjectOverview,
  listGcpComputeInstances,
  listGcpGkeClusters,
  listGcpLogEntries,
  listGcpSqlInstances,
  listGcpStorageBuckets,
  openExternalUrl
} from './api'
import { SvcState } from './SvcState'

type SectionState<T> = {
  status: 'idle' | 'ready' | 'error'
  data: T
  error: string
}

type GcpOverviewState = {
  project: SectionState<GcpProjectOverview | null>
  iam: SectionState<GcpIamOverview | null>
  billing: SectionState<GcpBillingOverview | null>
  compute: SectionState<GcpComputeInstanceSummary[]>
  gke: SectionState<GcpGkeClusterSummary[]>
  storage: SectionState<GcpStorageBucketSummary[]>
  sql: SectionState<GcpSqlInstanceSummary[]>
  logs: SectionState<GcpLogQueryResult | null>
}

type OverviewInsight = {
  id: string
  subject: string
  severity: 'info' | 'warning' | 'error'
  title: string
  summary: string
  recommendedAction: string
}

type RouteTile = {
  serviceId: ServiceId
  label: string
  value: string
  detail: string
  highlight?: boolean
}

type OverviewSignalTile = {
  kicker: string
  value: string
  detail: string
  actionLabel?: string
  onAction?: () => void
}

function createInitialState(): GcpOverviewState {
  return {
    project: { status: 'idle', data: null, error: '' },
    iam: { status: 'idle', data: null, error: '' },
    billing: { status: 'idle', data: null, error: '' },
    compute: { status: 'idle', data: [], error: '' },
    gke: { status: 'idle', data: [], error: '' },
    storage: { status: 'idle', data: [], error: '' },
    sql: { status: 'idle', data: [], error: '' },
    logs: { status: 'idle', data: null, error: '' }
  }
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeProjectParent(parentType: string, parentId: string): string {
  if (!parentType && !parentId) return 'Unavailable'
  if (!parentId) return parentType || 'Unavailable'
  return parentType ? `${parentType} ${parentId}` : parentId
}

function describeBillingVisibility(value: GcpBillingOverview['visibility'] | null | undefined): string {
  switch (value) {
    case 'full':
      return 'Billing account and linked projects visible'
    case 'billing-account-only':
      return 'Billing account only'
    case 'project-only':
      return 'Project-only billing context'
    default:
      return 'Billing visibility pending'
  }
}

function formatPercent(value: number): string {
  return `${value.toFixed(0)}%`
}

function formatCurrencyAmount(amount: number, currency: string): string {
  if (!currency) {
    return amount.toFixed(2)
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

function describeSpendTelemetryState(billing: GcpBillingOverview | null): string {
  const telemetry = billing?.spendTelemetry
  if (!telemetry) return 'Pending'

  switch (telemetry.status) {
    case 'available':
      return 'Live export'
    case 'billing-disabled':
      return 'Billing disabled'
    case 'missing-export':
      return 'Export missing'
    case 'access-limited':
      return 'Access limited'
    default:
      return 'Unavailable'
  }
}

function describeSpendHeadline(billing: GcpBillingOverview | null): string {
  const telemetry = billing?.spendTelemetry
  if (!telemetry) return 'Pending'

  if (telemetry.status === 'available') {
    return formatCurrencyAmount(telemetry.totalAmount, telemetry.currency)
  }

  switch (telemetry.status) {
    case 'billing-disabled':
      return 'Billing off'
    case 'missing-export':
      return 'Export missing'
    case 'access-limited':
      return 'Access limited'
    default:
      return 'Unavailable'
  }
}

function getGcpBillingExportSetupUrl(projectId: string): string {
  const normalizedProjectId = projectId.trim()
  const baseUrl = 'https://cloud.google.com/billing/docs/how-to/export-data-bigquery'

  return normalizedProjectId
    ? `${baseUrl}?project=${encodeURIComponent(normalizedProjectId)}`
    : baseUrl
}

function formatLogResourceLabel(value: string): string {
  return value.trim() || 'global'
}

function findLogDetail(details: Array<{ label: string; value: string }>, label: string): string {
  return details.find((detail) => detail.label.toLowerCase() === label.toLowerCase())?.value.trim() ?? ''
}

function truncateMiddle(value: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length <= maxLength) {
    return normalized
  }

  const segmentLength = Math.max(8, Math.floor((maxLength - 3) / 2))
  return `${normalized.slice(0, segmentLength)}...${normalized.slice(-segmentLength)}`
}

function summarizeRecentErrorTitle(entry: GcpLogQueryResult['entries'][number]): string {
  const status = findLogDetail(entry.details, 'Status')
  const message = findLogDetail(entry.details, 'Message')
  const method = findLogDetail(entry.details, 'Method')
  const summary = entry.summary.trim()

  if (status) {
    return status
  }

  if (message) {
    return message
  }

  if (method) {
    return method
  }

  return summary.length > 140 ? `${summary.slice(0, 137)}...` : summary
}

function summarizeRecentErrorTokens(entry: GcpLogQueryResult['entries'][number]): string[] {
  const method = findLogDetail(entry.details, 'Method')
  const actor = truncateMiddle(findLogDetail(entry.details, 'Actor'), 44)
  const service = findLogDetail(entry.details, 'Service')

  return [method, actor, service]
    .filter(Boolean)
    .slice(0, 3)
}

function summarizeRecentErrorResource(entry: GcpLogQueryResult['entries'][number]): string {
  const resource = findLogDetail(entry.details, 'Resource')
  return truncateMiddle(resource, 92)
}

function countSeverity(result: GcpLogQueryResult | null, severities: string[]): number {
  if (!result) return 0
  const severitySet = new Set(severities.map((severity) => severity.toUpperCase()))
  return result.severityCounts.reduce((total, item) => (
    severitySet.has(item.label.toUpperCase()) ? total + item.count : total
  ), 0)
}

function toSectionState<T>(data: T): SectionState<T> {
  return { status: 'ready', data, error: '' }
}

function toErrorState<T>(data: T, error: unknown): SectionState<T> {
  return { status: 'error', data, error: normalizeError(error) }
}

function severityWeight(severity: OverviewInsight['severity']): number {
  switch (severity) {
    case 'error':
      return 3
    case 'warning':
      return 2
    default:
      return 1
  }
}

export function GcpOverviewConsole({
  projectId,
  location,
  catalogProjects,
  refreshNonce,
  onNavigate,
  onRunTerminalCommand,
  canRunTerminalCommand
}: {
  projectId: string
  location: string
  catalogProjects: GcpCliProject[]
  refreshNonce: number
  onNavigate: (serviceId: ServiceId) => void
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}): JSX.Element {
  const [overview, setOverview] = useState<GcpOverviewState>(() => createInitialState())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setOverview(createInitialState())

      const catalogProjectIds = [...new Set([projectId, ...catalogProjects.map((project) => project.projectId)])]
      const locationLabel = location.trim() || 'global'

      const [
        projectResult,
        iamResult,
        billingResult,
        computeResult,
        gkeResult,
        storageResult,
        sqlResult,
        logsResult
      ] = await Promise.all([
        getGcpProjectOverview(projectId)
          .then((data) => toSectionState<GcpProjectOverview | null>(data))
          .catch((error) => toErrorState<GcpProjectOverview | null>(null, error)),
        getGcpIamOverview(projectId)
          .then((data) => toSectionState<GcpIamOverview | null>(data))
          .catch((error) => toErrorState<GcpIamOverview | null>(null, error)),
        getGcpBillingOverview(projectId, catalogProjectIds)
          .then((data) => toSectionState<GcpBillingOverview | null>(data))
          .catch((error) => toErrorState<GcpBillingOverview | null>(null, error)),
        listGcpComputeInstances(projectId, locationLabel)
          .then((data) => toSectionState<GcpComputeInstanceSummary[]>(data))
          .catch((error) => toErrorState<GcpComputeInstanceSummary[]>([], error)),
        listGcpGkeClusters(projectId, locationLabel)
          .then((data) => toSectionState<GcpGkeClusterSummary[]>(data))
          .catch((error) => toErrorState<GcpGkeClusterSummary[]>([], error)),
        listGcpStorageBuckets(projectId, locationLabel)
          .then((data) => toSectionState<GcpStorageBucketSummary[]>(data))
          .catch((error) => toErrorState<GcpStorageBucketSummary[]>([], error)),
        listGcpSqlInstances(projectId, locationLabel)
          .then((data) => toSectionState<GcpSqlInstanceSummary[]>(data))
          .catch((error) => toErrorState<GcpSqlInstanceSummary[]>([], error)),
        listGcpLogEntries(projectId, locationLabel, 'severity>=ERROR', 24)
          .then((data) => toSectionState<GcpLogQueryResult | null>(data))
          .catch((error) => toErrorState<GcpLogQueryResult | null>(null, error))
      ])

      if (cancelled) return

      setOverview({
        project: projectResult,
        iam: iamResult,
        billing: billingResult,
        compute: computeResult,
        gke: gkeResult,
        storage: storageResult,
        sql: sqlResult,
        logs: logsResult
      })
      setLoading(false)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [catalogProjects, location, projectId, refreshNonce])

  const locationLabel = location.trim() || 'global'
  const project = overview.project.data
  const iam = overview.iam.data
  const billing = overview.billing.data
  const compute = overview.compute.data
  const gke = overview.gke.data
  const storage = overview.storage.data
  const sql = overview.sql.data
  const logs = overview.logs.data

  const readySections = Object.values(overview).filter((section) => section.status === 'ready').length
  const errorSections = Object.values(overview).filter((section) => section.status === 'error').length
  const hasAnyData = readySections > 0
  const fatalError = !loading && !hasAnyData

  const runningComputeCount = compute.filter((instance) => instance.status.toUpperCase() === 'RUNNING').length
  const externalComputeCount = compute.filter((instance) => Boolean(instance.externalIp)).length
  const activeClusterCount = gke.filter((cluster) => ['RUNNING', 'RECONCILING'].includes(cluster.status.toUpperCase())).length
  const publicAccessProtectedBucketCount = storage.filter((bucket) => bucket.publicAccessPrevention.toLowerCase() === 'enforced').length
  const versionedBucketCount = storage.filter((bucket) => bucket.versioningEnabled).length
  const sqlProtectedCount = sql.filter((instance) => instance.deletionProtectionEnabled).length
  const sqlPrivateCount = sql.filter((instance) => Boolean(instance.privateAddress)).length
  const totalRuntimeResources = compute.length + gke.length + storage.length + sql.length
  const highSeverityLogCount = countSeverity(logs, ['ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'])

  const routeTiles = useMemo<RouteTile[]>(() => [
    {
      serviceId: 'gcp-projects',
      label: 'Project',
      value: project ? String(project.enabledApiCount) : '...',
      detail: project ? 'enabled APIs in scope' : 'project metadata pending',
      highlight: true
    },
    {
      serviceId: 'gcp-iam',
      label: 'IAM',
      value: iam ? String(iam.riskyBindingCount) : '...',
      detail: iam ? 'risky bindings to review' : 'policy summary pending'
    },
    {
      serviceId: 'gcp-billing',
      label: 'Billing',
      value: billing ? formatPercent(billing.linkedProjectLabelCoveragePercent) : '...',
      detail: billing ? 'linked project label coverage' : 'billing visibility pending'
    },
    {
      serviceId: 'gcp-compute-engine',
      label: 'Compute',
      value: String(compute.length),
      detail: `${runningComputeCount} running, ${externalComputeCount} external IP`
    },
    {
      serviceId: 'gcp-gke',
      label: 'GKE',
      value: String(gke.length),
      detail: `${activeClusterCount} active clusters`
    },
    {
      serviceId: 'gcp-cloud-storage',
      label: 'Storage',
      value: String(storage.length),
      detail: `${publicAccessProtectedBucketCount}/${storage.length || 0} protected buckets`
    },
    {
      serviceId: 'gcp-cloud-sql',
      label: 'Cloud SQL',
      value: String(sql.length),
      detail: `${sqlProtectedCount}/${sql.length || 0} deletion-protected`
    },
    {
      serviceId: 'gcp-logging',
      label: 'Logging',
      value: String(highSeverityLogCount),
      detail: 'high-severity log events in 24h'
    }
  ], [
    activeClusterCount,
    billing,
    compute.length,
    externalComputeCount,
    gke.length,
    highSeverityLogCount,
    iam,
    project,
    publicAccessProtectedBucketCount,
    runningComputeCount,
    sql.length,
    sqlProtectedCount,
    storage.length
  ])

  const insightCards = useMemo<OverviewInsight[]>(() => {
    const derived: OverviewInsight[] = []

    if (iam?.publicPrincipalCount) {
      derived.push({
        id: 'iam-public-principals',
        subject: 'iam',
        severity: 'error',
        title: `${iam.publicPrincipalCount} public principal grant${iam.publicPrincipalCount === 1 ? '' : 's'} detected`,
        summary: 'The current project policy exposes roles to all users or all authenticated users.',
        recommendedAction: 'Inspect public bindings in the IAM console and remove grants that are not explicitly required.'
      })
    }

    if (iam?.riskyBindingCount) {
      derived.push({
        id: 'iam-risky-bindings',
        subject: 'iam',
        severity: iam.riskyBindingCount > 2 ? 'error' : 'warning',
        title: `${iam.riskyBindingCount} high-privilege binding${iam.riskyBindingCount === 1 ? '' : 's'} in scope`,
        summary: 'Owner, editor, or admin-level roles are attached inside the selected project shell.',
        recommendedAction: 'Review principal rollups and trim inherited or over-broad roles before expanding workload access.'
      })
    }

    if (billing && billing.linkedProjectLabelCoveragePercent < 80) {
      derived.push({
        id: 'billing-label-coverage',
        subject: 'billing',
        severity: billing.linkedProjectLabelCoveragePercent < 55 ? 'error' : 'warning',
        title: `${formatPercent(billing.linkedProjectLabelCoveragePercent)} ownership coverage across linked projects`,
        summary: 'Billing-linked projects still have unlabeled surface area, which weakens ownership and cost attribution.',
        recommendedAction: 'Use the billing ownership hints to standardize owner, environment, and cost labels.'
      })
    }

    if (billing?.spendTelemetry.status === 'missing-export') {
      derived.push({
        id: 'billing-spend-export-missing',
        subject: 'billing',
        severity: 'warning',
        title: 'Cloud Billing export table is not configured in the visible project catalog',
        summary: 'Billing linkage is visible, but the overview cannot calculate real spend until a BigQuery billing export is available.',
        recommendedAction: 'Enable Cloud Billing export to BigQuery, then refresh this overview to unlock live spend signals.'
      })
    }

    if (billing?.spendTelemetry.status === 'access-limited') {
      derived.push({
        id: 'billing-spend-access-limited',
        subject: 'billing',
        severity: 'warning',
        title: 'Spend telemetry is blocked by current BigQuery access',
        summary: billing.spendTelemetry.message,
        recommendedAction: 'Grant BigQuery dataset read access and query-job permissions for the billing export project, then retry.'
      })
    }

    if (storage.length > 0 && publicAccessProtectedBucketCount < storage.length) {
      const unprotectedCount = storage.length - publicAccessProtectedBucketCount
      derived.push({
        id: 'storage-public-access',
        subject: 'storage',
        severity: unprotectedCount > 1 ? 'warning' : 'info',
        title: `${unprotectedCount} bucket${unprotectedCount === 1 ? '' : 's'} without enforced public access prevention`,
        summary: 'Bucket posture is mixed, so accidental exposure controls are not uniform across the project.',
        recommendedAction: 'Open Cloud Storage inventory and normalize public access prevention plus uniform bucket-level access.'
      })
    }

    if (sql.length > 0 && sqlProtectedCount < sql.length) {
      const uncoveredCount = sql.length - sqlProtectedCount
      derived.push({
        id: 'sql-deletion-protection',
        subject: 'cloud-sql',
        severity: 'warning',
        title: `${uncoveredCount} Cloud SQL instance${uncoveredCount === 1 ? '' : 's'} without deletion protection`,
        summary: 'Database recovery posture is uneven across the current project and location.',
        recommendedAction: 'Review deletion protection and private networking before handing the project to operators.'
      })
    }

    if (highSeverityLogCount > 0) {
      derived.push({
        id: 'logging-errors',
        subject: 'logging',
        severity: highSeverityLogCount > 15 ? 'error' : 'warning',
        title: `${highSeverityLogCount} high-severity log event${highSeverityLogCount === 1 ? '' : 's'} in the last 24 hours`,
        summary: 'Recent errors are already surfacing in Cloud Logging for the selected project context.',
        recommendedAction: 'Jump into Logging to inspect error clusters before changing IAM or runtime posture.'
      })
    }

    if (project && project.enabledApiCount <= 2) {
      derived.push({
        id: 'project-api-footprint',
        subject: 'project',
        severity: 'info',
        title: 'Project API surface is still narrow',
        summary: 'Only a small set of control-plane APIs are enabled, so some service screens may remain intentionally quiet.',
        recommendedAction: 'Use the Projects console to validate which APIs should be staged next for the selected shell.'
      })
    }

    const liftedHints: OverviewInsight[] = [
      ...(project?.capabilityHints ?? []).map((hint) => ({ ...hint })),
      ...(iam?.capabilityHints ?? []).map((hint) => ({ ...hint })),
      ...(billing?.capabilityHints ?? []).map((hint) => ({ ...hint }))
    ]

    const allInsights = [...derived, ...liftedHints]
      .sort((left, right) => severityWeight(right.severity) - severityWeight(left.severity))
      .slice(0, 8)

    if (allInsights.length > 0) {
      return allInsights
    }

    return [{
      id: 'healthy-shell',
      subject: 'overview',
      severity: 'info',
      title: 'No blocking posture regressions surfaced from the current shell',
      summary: 'Project, IAM, billing, and runtime summaries are readable and there are no immediate operator blockers in this slice.',
      recommendedAction: 'Use the service tiles below to inspect deeper runtime details before making changes.'
    }]
  }, [
    billing,
    highSeverityLogCount,
    iam,
    project,
    publicAccessProtectedBucketCount,
    sql.length,
    sqlProtectedCount,
    storage.length
  ])

  const quickCommands = [
    { id: 'project', label: 'Describe project', command: `gcloud projects describe ${projectId}` },
    { id: 'iam', label: 'IAM policy', command: `gcloud projects get-iam-policy ${projectId}` },
    { id: 'apis', label: 'Enabled APIs', command: `gcloud services list --enabled --project ${projectId}` },
    { id: 'logs', label: 'Recent errors', command: `gcloud logging read "severity>=ERROR" --project ${projectId} --limit=20` }
  ]

  const coverageCards = [
    { key: 'project', label: 'Project metadata', detail: overview.project.status === 'ready' ? `${project?.enabledApiCount ?? 0} APIs surfaced` : overview.project.error || 'Pending' },
    { key: 'iam', label: 'IAM policy', detail: overview.iam.status === 'ready' ? `${iam?.bindingCount ?? 0} bindings analyzed` : overview.iam.error || 'Pending' },
    { key: 'billing', label: 'Billing', detail: overview.billing.status === 'ready' ? describeBillingVisibility(billing?.visibility) : overview.billing.error || 'Pending' },
    { key: 'compute', label: 'Compute Engine', detail: overview.compute.status === 'ready' ? `${compute.length} instances in ${locationLabel}` : overview.compute.error || 'Pending' },
    { key: 'gke', label: 'GKE', detail: overview.gke.status === 'ready' ? `${gke.length} clusters in ${locationLabel}` : overview.gke.error || 'Pending' },
    { key: 'storage', label: 'Cloud Storage', detail: overview.storage.status === 'ready' ? `${storage.length} buckets surfaced` : overview.storage.error || 'Pending' },
    { key: 'sql', label: 'Cloud SQL', detail: overview.sql.status === 'ready' ? `${sql.length} instances surfaced` : overview.sql.error || 'Pending' },
    { key: 'logs', label: 'Logging', detail: overview.logs.status === 'ready' ? `${highSeverityLogCount} high-severity events` : overview.logs.error || 'Pending' }
  ]

  const capabilityHints = [
    ...(project?.capabilityHints ?? []),
    ...(iam?.capabilityHints ?? []),
    ...(billing?.capabilityHints ?? [])
  ].slice(0, 6)

  const topServiceTiles = routeTiles.slice(0, 6)

  const serviceBreakdownRows = [
    {
      service: 'Projects',
      visible: project ? 1 : 0,
      posture: project?.lifecycleState || 'Pending',
      detail: `${project?.enabledApiCount ?? 0} APIs | ${project?.labels.length ?? 0} labels`
    },
    {
      service: 'IAM',
      visible: iam?.bindingCount ?? 0,
      posture: `${iam?.riskyBindingCount ?? 0} risky`,
      detail: `${iam?.principalCount ?? 0} principals | ${iam?.serviceAccounts.length ?? 0} service accounts`
    },
    {
      service: 'Compute Engine',
      visible: compute.length,
      posture: `${runningComputeCount} running`,
      detail: `${externalComputeCount} external IP | ${locationLabel}`
    },
    {
      service: 'GKE',
      visible: gke.length,
      posture: `${activeClusterCount} active`,
      detail: `${gke.filter((cluster) => cluster.releaseChannel).length} with release channel`
    },
    {
      service: 'Cloud Storage',
      visible: storage.length,
      posture: `${publicAccessProtectedBucketCount} protected`,
      detail: `${versionedBucketCount} versioned buckets`
    },
    {
      service: 'Cloud SQL',
      visible: sql.length,
      posture: `${sqlProtectedCount} protected`,
      detail: `${sqlPrivateCount} private address`
    }
  ]

  const postureRows = [
    {
      label: 'Project context',
      value: describeProjectParent(project?.parentType || '', project?.parentId || ''),
      detail: project?.displayName || 'Project metadata pending'
    },
    {
      label: 'Billing visibility',
      value: describeBillingVisibility(billing?.visibility),
      detail: billing?.billingAccountDisplayName || billing?.billingAccountName || 'Billing account not surfaced'
    },
    {
      label: 'Ownership coverage',
      value: billing ? formatPercent(billing.linkedProjectLabelCoveragePercent) : '0%',
      detail: `${billing?.accessibleProjectCount ?? 0} linked or accessible projects`
    },
    {
      label: 'Observability',
      value: `${highSeverityLogCount} events`,
      detail: logs?.entries[0]?.summary || 'No high-severity log events captured in the current window'
    }
  ]

  const recentErrorRows = logs?.entries.slice(0, 6) ?? []
  const spendTelemetryState = describeSpendTelemetryState(billing)
  const spendHeadline = describeSpendHeadline(billing)
  const spendTelemetry = billing?.spendTelemetry ?? null
  const primaryOwnershipHint = billing?.ownershipHints[0] ?? null
  const costSignalTiles: OverviewSignalTile[] = [
    {
      kicker: 'Spend',
      value: spendHeadline,
      detail: spendTelemetry?.periodLabel || 'Billing period pending'
    },
    {
      kicker: 'Telemetry',
      value: spendTelemetryState,
      detail: spendTelemetry?.message || 'Billing telemetry pending',
      actionLabel: spendTelemetry?.status === 'missing-export' ? 'Open Export Setup' : undefined,
      onAction: spendTelemetry?.status === 'missing-export'
        ? () => void openExternalUrl(getGcpBillingExportSetupUrl(projectId))
        : undefined
    },
    {
      kicker: 'Billing',
      value: billing?.billingEnabled ? 'Attached' : 'Detached',
      detail: billing?.billingAccountDisplayName || billing?.billingAccountName || 'No billing account surfaced'
    },
    {
      kicker: 'Linked',
      value: String(billing?.linkedProjects.length ?? 0),
      detail: 'Projects sharing the current billing account in scope'
    },
    {
      kicker: 'Coverage',
      value: billing ? formatPercent(billing.linkedProjectLabelCoveragePercent) : '0%',
      detail: 'Linked projects with at least one ownership label'
    },
    {
      kicker: 'Ownership',
      value: primaryOwnershipHint ? primaryOwnershipHint.key : 'Pending',
      detail: primaryOwnershipHint ? `${formatPercent(primaryOwnershipHint.coveragePercent)} coverage on the top ownership key` : 'Ownership hints are not visible yet'
    },
    {
      kicker: 'Updated',
      value: spendTelemetry?.lastUpdatedAt ? new Date(spendTelemetry.lastUpdatedAt).toLocaleDateString() : '-',
      detail: spendTelemetry?.exportTableId
        ? `${spendTelemetry.exportProjectId}.${spendTelemetry.exportDatasetId}.${spendTelemetry.exportTableId}`
        : 'Latest billing telemetry refresh in this overview'
    }
  ]
  const costBreakdownRows = spendTelemetry?.status === 'available' && spendTelemetry.serviceBreakdown.length
    ? spendTelemetry.serviceBreakdown.slice(0, 8)
    : []
  const costBreakdownFallbackRows = [
    {
      label: 'Spend telemetry',
      value: spendTelemetryState,
      detail: spendTelemetry?.message || 'Billing telemetry is pending.'
    },
    {
      label: 'Billing account',
      value: billing?.billingAccountDisplayName || billing?.billingAccountName || '-',
      detail: billing?.billingAccountOpen ? 'Billing account reports open state' : 'Billing account state is closed, hidden, or unavailable'
    },
    {
      label: 'Project billing',
      value: billing?.billingEnabled ? 'Enabled' : 'Disabled',
      detail: `${billing?.linkedProjects.length ?? 0} linked projects visible from the current catalog`
    },
    {
      label: 'Label coverage',
      value: billing ? formatPercent(billing.linkedProjectLabelCoveragePercent) : '0%',
      detail: `${billing?.projectLabelCount ?? 0} labels on the active project`
    },
    {
      label: 'Top ownership signal',
      value: primaryOwnershipHint?.key || '-',
      detail: primaryOwnershipHint
        ? `${primaryOwnershipHint.labeledProjects} labeled vs ${primaryOwnershipHint.unlabeledProjects} unlabeled projects`
        : 'No ownership hint available'
    }
  ]

  return (
    <div className="overview-surface gcp-overview-console">
      <div className="overview-hero-card">
        <div className="overview-hero-copy">
          <div className="eyebrow">Google Cloud Overview</div>
          <h3>{projectId}</h3>
          <p>Project, IAM, billing, runtime, and logging signals in one operator-first surface that mirrors the AWS overview rhythm with the Google green theme.</p>
          <div className="overview-meta-strip">
            <div className="overview-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Location lens</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Lifecycle</span>
              <strong>{project?.lifecycleState || 'Pending'}</strong>
            </div>
            <div className="overview-meta-pill">
              <span>Billing visibility</span>
              <strong>{describeBillingVisibility(billing?.visibility)}</strong>
            </div>
          </div>
        </div>
        <div className="overview-hero-stats">
          <div className="overview-glance-card overview-glance-card-accent">
            <span>Runtime resources</span>
            <strong>{totalRuntimeResources}</strong>
            <small>Compute Engine, GKE, Storage, and Cloud SQL resources visible from this shell.</small>
          </div>
          <div className="overview-glance-card">
            <span>Enabled APIs</span>
            <strong>{project?.enabledApiCount ?? 0}</strong>
            <small>Project control-plane services already staged for inspection.</small>
          </div>
          <div className="overview-glance-card">
            <span>IAM risk</span>
            <strong>{iam?.riskyBindingCount ?? 0}</strong>
            <small>{iam?.publicPrincipalCount ?? 0} public principal grants currently visible.</small>
          </div>
          <div className="overview-glance-card">
            <span>Coverage</span>
            <strong>{readySections}/8</strong>
            <small>{errorSections ? `${errorSections} sections need follow-up` : 'All overview sections responded.'}</small>
          </div>
        </div>
      </div>

      <section className="global-overview-bar gcp-overview-service-bar">
        <div className="overview-chip-row">
          {routeTiles.map((tile) => (
            <button
              key={tile.serviceId}
              type="button"
              className={`overview-service-chip ${tile.highlight ? 'active' : ''}`}
              onClick={() => onNavigate(tile.serviceId)}
              title={tile.detail}
            >
              <span>{tile.label}</span>
              <strong>{tile.value}</strong>
            </button>
          ))}
        </div>
        <div className="hero-path gcp-overview-chip-detail">
          Cross-console footprint for the active Google Cloud shell. Click a tile to jump into the matching workspace.
        </div>
      </section>

      {loading ? <SvcState variant="loading" resourceName="GCP overview" compact /> : null}
      {fatalError ? <SvcState variant="error" error="No Google Cloud overview sections could be loaded for the current project context." /> : null}

      {hasAnyData ? (
        <>
          <div className="overview-section-title">Account And Billing Posture</div>
          <section className="overview-account-grid">
            <article className="overview-account-card">
              <div className="panel-header minor">
                <h3>Project Context</h3>
              </div>
              <div className="overview-account-kv">
                <div>
                  <span>Display name</span>
                  <strong>{project?.displayName || '-'}</strong>
                </div>
                <div>
                  <span>Project number</span>
                  <strong>{project?.projectNumber || '-'}</strong>
                </div>
                <div>
                  <span>Lifecycle</span>
                  <strong>{project?.lifecycleState || '-'}</strong>
                </div>
                <div>
                  <span>Created</span>
                  <strong>{project?.createTime ? new Date(project.createTime).toLocaleDateString() : '-'}</strong>
                </div>
              </div>
              <div className="overview-note-list">
                <div className="overview-note-item">Parent: {describeProjectParent(project?.parentType || '', project?.parentId || '')}</div>
                {(project?.notes ?? []).slice(0, 3).map((note) => (
                  <div key={note} className="overview-note-item">{note}</div>
                ))}
              </div>
            </article>

            <article className="overview-account-card">
              <div className="panel-header minor">
                <h3>Linked Project Coverage</h3>
                <span className="hero-path" style={{ margin: 0 }}>{billing?.accessibleProjectCount ?? 0} projects</span>
              </div>
              {billing?.linkedProjects.length ? (
                <div className="overview-linked-account-list">
                  {billing.linkedProjects.slice(0, 6).map((item) => (
                    <div key={item.projectId} className="overview-linked-account-row">
                      <div>
                        <strong>{item.projectId}</strong>
                        <span>{item.name || item.projectNumber || 'Project metadata partial'}</span>
                      </div>
                      <strong>{item.labelCount} labels</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <SvcState
                  variant="empty"
                  message="Linked-project billing coverage is not visible with the current project scope."
                  compact
                />
              )}
            </article>
          </section>

          <div className="overview-section-title">Capability Hints</div>
          <section className="overview-hint-grid">
            {(capabilityHints.length ? capabilityHints : insightCards.slice(0, 4)).map((insight) => (
              <article key={insight.id} className={`overview-hint-card ${insight.severity}`}>
                <span className="overview-hint-kicker">{insight.subject}</span>
                <strong>{insight.title}</strong>
                <p>{insight.summary}</p>
                <small>{insight.recommendedAction}</small>
              </article>
            ))}
          </section>

          <div className="overview-section-title">Cost Ownership Hints</div>
          <section className="overview-ownership-grid">
            {(billing?.ownershipHints ?? []).slice(0, 4).map((hint) => (
              <article key={hint.key} className="overview-ownership-card">
                <div className="overview-ownership-header">
                  <div>
                    <span>{hint.key}</span>
                    <strong>{formatPercent(hint.coveragePercent)} covered</strong>
                  </div>
                  <div className="overview-ownership-metrics">
                    <span>{hint.labeledProjects} labeled</span>
                    <span>{hint.unlabeledProjects} unlabeled</span>
                  </div>
                </div>
                {hint.topValues.length ? (
                  <div className="overview-ownership-values">
                    {hint.topValues.slice(0, 3).map((value) => (
                      <div key={`${hint.key}-${value.value}`} className="overview-ownership-value">
                        <div>
                          <strong>{value.value}</strong>
                          <span>{formatPercent(value.sharePercent)} of linked projects</span>
                        </div>
                        <strong>{value.projectCount}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="hero-path" style={{ margin: 0 }}>
                    No linked projects currently expose the {hint.key} label.
                  </p>
                )}
              </article>
            ))}
            {!(billing?.ownershipHints.length) ? (
              <article className="overview-ownership-card">
                <div className="overview-ownership-header">
                  <div>
                    <span>Coverage</span>
                    <strong>Pending</strong>
                  </div>
                </div>
                <p className="hero-path" style={{ margin: 0 }}>
                  Ownership hints are not visible for the current billing context.
                </p>
              </article>
            ) : null}
          </section>

          <div className="overview-section-title">Cost Signals</div>
          <section className="overview-tiles overview-tiles-summary">
            {costSignalTiles.map((tile, index) => (
              <div key={tile.kicker} className={`overview-tile ${index === 0 ? 'highlight' : ''}`}>
                <span className="overview-tile-kicker">{tile.kicker}</span>
                <strong>{tile.value}</strong>
                <span>{tile.detail}</span>
                {tile.actionLabel && tile.onAction ? (
                  <button
                    type="button"
                    className="overview-tile-action"
                    onClick={tile.onAction}
                  >
                    {tile.actionLabel}
                  </button>
                ) : null}
              </div>
            ))}
          </section>

          <div className="overview-section-title">Top Services</div>
          <section className="overview-tiles overview-tiles-featured">
            {topServiceTiles.map((tile, index) => (
              <button
                key={tile.serviceId}
                type="button"
                className={`overview-tile clickable ${index === 0 ? 'highlight' : ''}`}
                onClick={() => onNavigate(tile.serviceId)}
                title={tile.detail}
              >
                <span className="overview-tile-kicker">Service</span>
                <strong>{tile.value}</strong>
                <span>{tile.label}</span>
              </button>
            ))}
          </section>

          <div className="overview-section-title">Platform Summary</div>
          <section className="overview-tiles overview-tiles-summary">
            <div className="overview-tile highlight">
              <span className="overview-tile-kicker">Coverage</span>
              <strong>{readySections}/8</strong>
              <span>Overview sections ready</span>
            </div>
            <div className="overview-tile">
              <span className="overview-tile-kicker">Inventory</span>
              <strong>{totalRuntimeResources}</strong>
              <span>Total runtime resources</span>
            </div>
            <div className="overview-tile">
              <span className="overview-tile-kicker">Control Plane</span>
              <strong>{(project?.enabledApiCount ?? 0) + (iam?.bindingCount ?? 0)}</strong>
              <span>APIs plus IAM bindings</span>
            </div>
            <div className="overview-tile">
              <span className="overview-tile-kicker">Ownership</span>
              <strong>{billing ? formatPercent(billing.linkedProjectLabelCoveragePercent) : '0%'}</strong>
              <span>Linked project label coverage</span>
            </div>
            <div className="overview-tile">
              <span className="overview-tile-kicker">Risk</span>
              <strong>{iam?.riskyBindingCount ?? 0}</strong>
              <span>Risky IAM bindings</span>
            </div>
            <div className="overview-tile">
              <span className="overview-tile-kicker">Signals</span>
              <strong>{insightCards.length}</strong>
              <span>Generated insights</span>
            </div>
          </section>

          <div className="overview-bottom-row">
            <span>Current context</span>
            <strong>{projectId}</strong>
            <span className="overview-bottom-row-detail">{locationLabel} | {describeProjectParent(project?.parentType || '', project?.parentId || '')}</span>
          </div>

          <section className="workspace-grid">
            <div className="column stack">
              <div className="panel overview-data-panel">
                <div className="panel-header">
                  <h3>Cost Breakdown</h3>
                  <span className="hero-path" style={{ margin: 0 }}>{spendTelemetryState}</span>
                </div>
                {costBreakdownRows.length ? (
                  <div className="table-grid overview-table-grid">
                    <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.8fr 0.7fr' }}>
                      <div>Service</div><div>Amount</div><div>Share</div>
                    </div>
                    {costBreakdownRows.map((row) => (
                      <div key={row.service} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.8fr 0.7fr', gap: '1rem' }}>
                        <div>{row.service}</div>
                        <div><strong>{formatCurrencyAmount(row.amount, row.currency || spendTelemetry?.currency || '')}</strong></div>
                        <div>{formatPercent(row.sharePercent)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="table-grid overview-table-grid">
                    <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr 1.5fr' }}>
                      <div>Signal</div><div>Value</div><div>Detail</div>
                    </div>
                    {costBreakdownFallbackRows.map((row) => (
                      <div key={row.label} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr 1.5fr', gap: '1rem' }}>
                        <div>{row.label}</div>
                        <div><strong>{row.value}</strong></div>
                        <div>{row.detail}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="panel overview-data-panel">
                <div className="panel-header"><h3>Service Breakdown</h3></div>
                <div className="table-grid overview-table-grid">
                  <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.5fr 0.7fr 1.3fr' }}>
                    <div>Service</div><div>Visible</div><div>Posture</div><div>Detail</div>
                  </div>
                  {serviceBreakdownRows.map((row) => (
                    <div key={row.service} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.5fr 0.7fr 1.3fr', gap: '1rem' }}>
                      <div>{row.service}</div>
                      <div><strong>{row.visible}</strong></div>
                      <div>{row.posture}</div>
                      <div>{row.detail}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel overview-data-panel">
                <div className="panel-header">
                  <h3>Context Breakdown</h3>
                  <span className="hero-path" style={{ margin: 0 }}>{errorSections ? `${errorSections} section errors` : 'No section-level failures'}</span>
                </div>
                <div className="table-grid overview-table-grid">
                  <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr 1.4fr' }}>
                    <div>Area</div><div>Value</div><div>Detail</div>
                  </div>
                  {postureRows.map((row) => (
                    <div key={row.label} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr 1.4fr', gap: '1rem' }}>
                      <div>{row.label}</div>
                      <div><strong>{row.value}</strong></div>
                      <div>{row.detail}</div>
                    </div>
                  ))}
                  {coverageCards.map((item) => (
                    <div key={item.key} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '0.9fr 1fr 1.4fr', gap: '1rem' }}>
                      <div>{item.label}</div>
                      <div><strong>{overview[item.key as keyof GcpOverviewState].status}</strong></div>
                      <div>{item.detail}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="column stack">
              <div className="panel overview-insights-panel">
                <div className="panel-header"><h3>Insights</h3></div>
                {insightCards.map((item) => (
                  <div key={item.id} className="insight-card">
                    <div className="insight-card-badge">
                      <span className={`signal-badge severity-${item.severity === 'error' ? 'high' : item.severity === 'warning' ? 'medium' : 'low'}`}>
                        {item.severity === 'error' ? 'Error' : item.severity === 'warning' ? 'Warn' : 'Info'}
                      </span>
                      <span className="insight-card-service">{item.subject}</span>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="insight-card-message">{item.title}</div>
                      <div className="hero-path" style={{ marginTop: '0.2rem' }}>{item.summary}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="panel overview-insights-panel">
                <div className="panel-header">
                  <h3>Recent Errors</h3>
                  <span className="hero-path" style={{ margin: 0 }}>Last 24 hours</span>
                </div>
                <div className="recent-errors-scroll">
                  {recentErrorRows.length ? recentErrorRows.map((entry) => (
                    <div key={entry.insertId} className="insight-card recent-error-card">
                      <div className="insight-card-badge">
                        <span className={`signal-badge severity-${entry.severity.toUpperCase() === 'ERROR' ? 'high' : 'medium'}`}>
                          {entry.severity}
                        </span>
                        <span className="insight-card-service">{formatLogResourceLabel(entry.resourceType)}</span>
                      </div>
                      <div className="recent-error-content">
                        <div className="insight-card-message">{summarizeRecentErrorTitle(entry)}</div>
                        {summarizeRecentErrorTokens(entry).length ? (
                          <div className="recent-error-token-row">
                            {summarizeRecentErrorTokens(entry).map((token) => (
                              <span key={`${entry.insertId}-${token}`} className="recent-error-token">{token}</span>
                            ))}
                          </div>
                        ) : null}
                        {summarizeRecentErrorResource(entry) ? (
                          <div className="recent-error-resource">{summarizeRecentErrorResource(entry)}</div>
                        ) : null}
                        <div className="recent-error-meta">
                          <span>{new Date(entry.timestamp).toLocaleString()}</span>
                          <span>{entry.logName}</span>
                        </div>
                        {entry.summary.trim() && entry.summary.trim() !== summarizeRecentErrorTitle(entry) ? (
                          <div className="recent-error-detail">{entry.summary.trim()}</div>
                        ) : null}
                      </div>
                    </div>
                  )) : <SvcState variant="empty" resourceName="recent errors" message="No high-severity errors surfaced in the selected window." compact />}
                </div>
              </div>

              <div className="panel overview-insights-panel">
                <div className="panel-header">
                  <h3>Terminal Handoff</h3>
                  <span className="hero-path" style={{ margin: 0 }}>Operator shortcuts</span>
                </div>
                <div className="gcp-overview-actions">
                  {quickCommands.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="ghost"
                      disabled={!canRunTerminalCommand}
                      onClick={() => onRunTerminalCommand(item.command)}
                      title={canRunTerminalCommand ? item.command : 'Switch to Operator mode to enable terminal actions'}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
