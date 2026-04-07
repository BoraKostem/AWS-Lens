import { randomUUID } from 'node:crypto'

import type {
  AwsConnection,
  CorrelatedSignalReference,
  GeneratedArtifact,
  ObservabilityFinding,
  ObservabilityPostureArea,
  ObservabilityPostureReport,
  ObservabilityRecommendation,
  ResilienceExperimentSuggestion,
  TerraformDriftCoverageItem,
  TerraformDriftDifference,
  TerraformDriftHistory,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformDriftSnapshot,
  TerraformDriftStatus,
  TerraformProject,
  TerraformResourceInventoryItem
} from '@shared/types'
import { getCachedCliInfo, getProject } from './terraform'
import {
  getGcpBillingOverview,
  getGcpIamOverview,
  getGcpProjectOverview,
  listGcpComputeInstances,
  listGcpGkeClusters,
  listGcpSqlInstances,
  listGcpStorageBuckets
} from './gcpSdk'

type GcpTerraformContext = { projectId: string; location: string }
type GcpLiveData = {
  projectOverview?: Awaited<ReturnType<typeof getGcpProjectOverview>>
  iamOverview?: Awaited<ReturnType<typeof getGcpIamOverview>>
  computeInstances?: Awaited<ReturnType<typeof listGcpComputeInstances>>
  gkeClusters?: Awaited<ReturnType<typeof listGcpGkeClusters>>
  storageBuckets?: Awaited<ReturnType<typeof listGcpStorageBuckets>>
  sqlInstances?: Awaited<ReturnType<typeof listGcpSqlInstances>>
  billingOverview?: Awaited<ReturnType<typeof getGcpBillingOverview>>
}
type GcpLiveErrors = Partial<Record<keyof GcpLiveData, string>>

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function bool(value: unknown): boolean {
  return value === true
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function firstLocationSegment(value: string): string {
  return value.split('|')[0]?.trim() ?? ''
}

function toneFromScore(score: number): 'good' | 'mixed' | 'weak' {
  if (score >= 0.75) return 'good'
  if (score >= 0.45) return 'mixed'
  return 'weak'
}

function severityRank(severity: ObservabilityFinding['severity']): number {
  return severity === 'critical' ? 5 : severity === 'high' ? 4 : severity === 'medium' ? 3 : severity === 'low' ? 2 : 1
}

function connectionRef(connection: AwsConnection | undefined, context: GcpTerraformContext, profileName: string) {
  return {
    kind: connection?.kind ?? 'profile',
    label: connection?.label || context.projectId || 'Google Cloud',
    profile: connection?.profile || context.projectId || 'gcp',
    region: connection?.region || context.location || 'global',
    sessionId: connection?.sessionId || profileName
  }
}

function buildArtifact(
  id: string,
  title: string,
  type: GeneratedArtifact['type'],
  language: GeneratedArtifact['language'],
  summary: string,
  content: string,
  safety: string,
  isRunnable = false,
  copyLabel = 'Copy artifact',
  runLabel = 'Run in terminal'
): GeneratedArtifact {
  return { id, title, type, language, summary, content, safety, isRunnable, copyLabel, runLabel }
}

function sortReport(report: ObservabilityPostureReport): ObservabilityPostureReport {
  return {
    ...report,
    findings: [...report.findings].sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
  }
}

function parseGcpContext(profileName: string, project: TerraformProject, connection?: AwsConnection): GcpTerraformContext {
  const match = profileName.match(/^provider:gcp:terraform:([^:]+):(.+)$/)
  const inventoryProjectId = project.inventory.map((item) => str(item.values.project) || str(item.values.project_id)).find(Boolean)
  const projectId = [
    connection?.profile,
    match?.[1] && match[1] !== 'unscoped' ? match[1] : '',
    str(project.environment.connectionLabel),
    inventoryProjectId
  ].find((value) => value && value !== 'gcp' && !/local shell/i.test(value)) ?? ''
  const location = [
    firstLocationSegment(connection?.region ?? ''),
    str(project.environment.region),
    match?.[2] && match[2] !== 'global' ? match[2] : ''
  ].find(Boolean) ?? 'global'
  return { projectId, location }
}

function gcpConsoleUrl(servicePath: string, projectId: string): string {
  return `https://console.cloud.google.com/${servicePath}${servicePath.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`
}

function serviceConsoleUrl(resourceType: string, logicalName: string, context: GcpTerraformContext, location = ''): string {
  const locationHint = location || context.location
  switch (resourceType) {
    case 'google_project':
      return gcpConsoleUrl('home/dashboard', context.projectId)
    case 'google_project_service':
      return gcpConsoleUrl(`apis/library/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_service_account':
      return gcpConsoleUrl(`iam-admin/serviceaccounts/details/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_project_iam_member':
      return gcpConsoleUrl('iam-admin/iam', context.projectId)
    case 'google_compute_instance':
      return gcpConsoleUrl(`compute/instancesDetail/zones/${encodeURIComponent(locationHint)}/instances/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_container_cluster':
      return gcpConsoleUrl(`kubernetes/clusters/details/${encodeURIComponent(locationHint)}/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_storage_bucket':
      return gcpConsoleUrl(`storage/browser/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_sql_database_instance':
      return gcpConsoleUrl(`sql/instances/${encodeURIComponent(logicalName)}/overview`, context.projectId)
    default:
      return gcpConsoleUrl('home/dashboard', context.projectId)
  }
}

function createDifference(key: string, label: string, terraformValue: string, liveValue: string): TerraformDriftDifference {
  return { key, label, kind: 'attribute', assessment: 'verified', terraformValue, liveValue }
}

function makeStateShowCommand(address: string): string {
  if (!address) return ''
  const cliPath = getCachedCliInfo().path
  const cliInvocation = cliPath ? `& '${cliPath.replace(/'/g, "''")}'` : 'terraform'
  return `${cliInvocation} state show ${address}`
}

function unsupportedItem(item: TerraformResourceInventoryItem, context: GcpTerraformContext, note: string): TerraformDriftItem {
  return {
    terraformAddress: item.address,
    resourceType: item.type,
    logicalName: item.name || str(item.values.name) || item.address,
    cloudIdentifier: item.name || str(item.values.name) || item.address,
    region: str(item.values.zone) || str(item.values.region) || str(item.values.location) || context.location,
    status: 'unsupported',
    assessment: 'unsupported',
    explanation: note,
    suggestedNextStep: 'Review this resource manually in Google Cloud until live drift coverage lands for this type.',
    consoleUrl: serviceConsoleUrl(item.type, item.name || str(item.values.name), context),
    terminalCommand: makeStateShowCommand(item.address),
    differences: [],
    evidence: [],
    relatedTerraformAddresses: [item.address]
  }
}

function getPathValue(source: unknown, path: Array<string | number>): unknown {
  let current = source
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
      continue
    }
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function normalizeResourceBasename(value: string): string {
  const trimmed = str(value)
  if (!trimmed) return ''
  const segments = trimmed.split('/')
  return segments[segments.length - 1] || trimmed
}

function coverageItem(resourceType: string, verifiedChecks: string[], inferredChecks: string[], notes: string[]): TerraformDriftCoverageItem {
  return { resourceType, coverage: 'partial', verifiedChecks, inferredChecks, notes }
}

function buildSummary(items: TerraformDriftItem[], coverage: TerraformDriftCoverageItem[], scannedAt: string) {
  const statusCounts: Record<TerraformDriftStatus, number> = {
    in_sync: 0,
    drifted: 0,
    missing_in_aws: 0,
    unmanaged_in_aws: 0,
    unsupported: 0
  }
  const resourceTypeMap = new Map<string, number>()
  const unsupportedTypes = new Set<string>()
  let verifiedCount = 0
  let inferredCount = 0

  for (const item of items) {
    statusCounts[item.status] += 1
    resourceTypeMap.set(item.resourceType, (resourceTypeMap.get(item.resourceType) ?? 0) + 1)
    if (item.assessment === 'unsupported') unsupportedTypes.add(item.resourceType)
    else if (item.differences.some((difference) => difference.assessment === 'inferred')) inferredCount += 1
    else verifiedCount += 1
  }

  return {
    total: items.length,
    statusCounts,
    resourceTypeCounts: [...resourceTypeMap.entries()]
      .map(([resourceType, count]) => ({ resourceType, count }))
      .sort((left, right) => right.count - left.count || left.resourceType.localeCompare(right.resourceType)),
    scannedAt,
    verifiedCount,
    inferredCount,
    unsupportedResourceTypes: [...unsupportedTypes].sort(),
    supportedResourceTypes: coverage
  }
}

function computeTrend(snapshots: TerraformDriftSnapshot[]): TerraformDriftHistory['trend'] {
  if (snapshots.length < 2) return 'insufficient_history'
  const latest = snapshots[0]
  const previous = snapshots[1]
  const latestIssues = latest.summary.statusCounts.drifted + latest.summary.statusCounts.missing_in_aws + latest.summary.statusCounts.unmanaged_in_aws
  const previousIssues = previous.summary.statusCounts.drifted + previous.summary.statusCounts.missing_in_aws + previous.summary.statusCounts.unmanaged_in_aws
  if (latestIssues < previousIssues) return 'improving'
  if (latestIssues > previousIssues) return 'worsening'
  return 'unchanged'
}

function buildHistory(snapshots: TerraformDriftSnapshot[]): TerraformDriftHistory {
  return {
    snapshots,
    trend: computeTrend(snapshots),
    latestScanAt: snapshots[0]?.scannedAt ?? '',
    previousScanAt: snapshots[1]?.scannedAt ?? ''
  }
}

async function loadLiveData(context: GcpTerraformContext): Promise<{ data: GcpLiveData; errors: GcpLiveErrors }> {
  const data: GcpLiveData = {}
  const errors: GcpLiveErrors = {}
  if (!context.projectId) {
    return { data, errors }
  }

  const loaders: Array<[keyof GcpLiveData, () => Promise<unknown>]> = [
    ['projectOverview', () => getGcpProjectOverview(context.projectId)],
    ['iamOverview', () => getGcpIamOverview(context.projectId)],
    ['computeInstances', () => listGcpComputeInstances(context.projectId, context.location)],
    ['gkeClusters', () => listGcpGkeClusters(context.projectId, context.location)],
    ['storageBuckets', () => listGcpStorageBuckets(context.projectId, context.location)],
    ['sqlInstances', () => listGcpSqlInstances(context.projectId, context.location)],
    ['billingOverview', () => getGcpBillingOverview(context.projectId, [context.projectId])]
  ]

  const settled = await Promise.allSettled(loaders.map(async ([key, loader]) => ({ key, value: await loader() })))
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      data[result.value.key] = result.value.value as never
      return
    }
    const key = loaders[index]?.[0]
    if (key) {
      errors[key] = result.reason instanceof Error ? result.reason.message : String(result.reason)
    }
  })

  return { data, errors }
}

function buildSupportedCoverage(): TerraformDriftCoverageItem[] {
  return [
    coverageItem('google_project', ['Project exists', 'Display name'], [], ['Confirms the selected project still exists and the display name matches Terraform inputs when set.']),
    coverageItem('google_project_service', ['API enabled state'], [], ['Focuses on live enablement only. Default Google-managed services are not backfilled as unmanaged noise.']),
    coverageItem('google_service_account', ['Service account exists', 'Display name', 'Disabled flag'], [], ['Email is derived from Terraform when only account_id is available.']),
    coverageItem('google_project_iam_member', ['Role/member binding exists'], [], ['Treats additive IAM changes outside Terraform as manual review, not unmanaged live inventory.']),
    coverageItem('google_compute_instance', ['Instance exists', 'Zone', 'Machine type'], [], ['Operational runtime flags such as current status are kept as evidence, not config drift.']),
    coverageItem('google_container_cluster', ['Cluster exists', 'Location', 'Release channel when declared'], [], ['Control-plane runtime version changes are not treated as Terraform drift.']),
    coverageItem('google_storage_bucket', ['Bucket exists', 'Location', 'Storage class', 'Versioning', 'Uniform bucket-level access'], [], ['Lifecycle rules and IAM are out of scope for this slice.']),
    coverageItem('google_sql_database_instance', ['Instance exists', 'Region', 'Database version', 'Availability type', 'Deletion protection'], [], ['Flags only fields that are typically set directly in Terraform.'])
  ].sort((left, right) => left.resourceType.localeCompare(right.resourceType))
}

function compareValues(differences: TerraformDriftDifference[], key: string, label: string, terraformValue: string, liveValue: string) {
  if (!terraformValue || !liveValue || terraformValue === liveValue) return
  differences.push(createDifference(key, label, terraformValue, liveValue))
}

function buildTerraformItem(
  item: TerraformResourceInventoryItem,
  context: GcpTerraformContext,
  matchState: {
    exists: boolean
    cloudIdentifier: string
    region?: string
    explanation: string
    evidence?: string[]
    differences?: TerraformDriftDifference[]
  }
): TerraformDriftItem {
  const logicalName = item.name || str(item.values.name) || str(item.values.account_id) || item.address
  const differences = matchState.differences ?? []
  const status: TerraformDriftStatus = !matchState.exists
    ? 'missing_in_aws'
    : differences.length > 0 ? 'drifted' : 'in_sync'
  const liveRegion = matchState.region || str(item.values.zone) || str(item.values.region) || str(item.values.location) || context.location
  return {
    terraformAddress: item.address,
    resourceType: item.type,
    logicalName,
    cloudIdentifier: matchState.cloudIdentifier || logicalName,
    region: liveRegion,
    status,
    assessment: 'verified',
    explanation: matchState.explanation,
    suggestedNextStep: status === 'in_sync'
      ? 'No reconciliation action is needed right now.'
      : status === 'missing_in_aws'
        ? `Recreate or re-import ${item.address} after confirming whether Terraform or Google Cloud is the source of truth.`
        : `Review ${item.address}, reconcile the changed fields in Terraform or Google Cloud, then run a manual drift re-scan.`,
    consoleUrl: serviceConsoleUrl(item.type, logicalName, context, liveRegion),
    terminalCommand: makeStateShowCommand(item.address),
    differences,
    evidence: matchState.evidence ?? [],
    relatedTerraformAddresses: [item.address]
  }
}

function buildUnmanagedItem(
  resourceType: string,
  logicalName: string,
  cloudIdentifier: string,
  region: string,
  context: GcpTerraformContext,
  evidence: string[],
  explanation: string
): TerraformDriftItem {
  return {
    terraformAddress: '',
    resourceType,
    logicalName,
    cloudIdentifier,
    region,
    status: 'unmanaged_in_aws',
    assessment: 'inferred',
    explanation,
    suggestedNextStep: 'Decide whether this live resource should be imported into Terraform, explicitly ignored, or removed from the project.',
    consoleUrl: serviceConsoleUrl(resourceType, logicalName, context, region),
    terminalCommand: '',
    differences: [],
    evidence,
    relatedTerraformAddresses: []
  }
}

function hasResource(project: TerraformProject, prefix: string): boolean {
  return project.inventory.some((item) => item.mode === 'managed' && item.type.startsWith(prefix))
}

function inventoryText(project: TerraformProject): string {
  return project.inventory.map((item) => `${item.address} ${item.type} ${JSON.stringify(item.values)}`).join('\n').toLowerCase()
}

export async function getGcpTerraformDriftReport(
  profileName: string,
  projectId: string,
  connection?: AwsConnection,
  _options?: { forceRefresh?: boolean }
): Promise<TerraformDriftReport> {
  const project = getProject(profileName, projectId)
  const context = parseGcpContext(profileName, project, connection)
  if (!context.projectId) {
    throw new Error('Choose a GCP project context before loading Terraform drift.')
  }

  const { data: live, errors } = await loadLiveData(context)
  const items: TerraformDriftItem[] = []
  const coverage = buildSupportedCoverage()
  const managedInventory = project.inventory.filter((item) => item.mode === 'managed')

  for (const item of managedInventory) {
    switch (item.type) {
      case 'google_project': {
        if (errors.projectOverview) {
          items.push(unsupportedItem(item, context, `Project live inventory could not be loaded: ${errors.projectOverview}`))
          break
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'displayName', 'Display Name', str(item.values.name), str(live.projectOverview?.displayName))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(live.projectOverview?.projectId),
          cloudIdentifier: live.projectOverview?.projectId || context.projectId,
          explanation: live.projectOverview?.projectId
            ? differences.length > 0
              ? 'Project metadata differs from the current Terraform values.'
              : 'Project metadata matches the selected Terraform inputs.'
            : 'Terraform references a project that is not visible in Google Cloud.',
          evidence: unique([live.projectOverview?.lifecycleState ? `Lifecycle state: ${live.projectOverview.lifecycleState}` : '', ...(live.projectOverview?.notes ?? [])]).filter(Boolean),
          differences
        }))
        break
      }
      case 'google_project_service': {
        if (errors.projectOverview) {
          items.push(unsupportedItem(item, context, `Enabled API inventory could not be loaded: ${errors.projectOverview}`))
          break
        }
        const serviceName = str(item.values.service) || str(item.values.service_name) || item.name
        const enabled = (live.projectOverview?.enabledApis ?? []).some((entry) => entry.name === serviceName)
        items.push(buildTerraformItem(item, context, {
          exists: enabled,
          cloudIdentifier: serviceName,
          explanation: enabled
            ? `API ${serviceName} is enabled in the target project.`
            : `Terraform expects API ${serviceName}, but it is not enabled in the live project.`,
          evidence: live.projectOverview?.enabledApiCount ? [`Enabled APIs visible: ${live.projectOverview.enabledApiCount}`] : []
        }))
        break
      }
      case 'google_service_account': {
        if (errors.iamOverview) {
          items.push(unsupportedItem(item, context, `IAM service account inventory could not be loaded: ${errors.iamOverview}`))
          break
        }
        const accountId = str(item.values.account_id)
        const email = str(item.values.email) || (accountId ? `${accountId}@${context.projectId}.iam.gserviceaccount.com` : '')
        const match = (live.iamOverview?.serviceAccounts ?? []).find((entry) => entry.email === email)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'displayName', 'Display Name', str(item.values.display_name), str(match?.displayName))
        if (typeof getPathValue(item.values, ['disabled']) === 'boolean') {
          compareValues(differences, 'disabled', 'Disabled', String(bool(item.values.disabled)), String(Boolean(match?.disabled)))
        }
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(match),
          cloudIdentifier: email || accountId || item.address,
          explanation: match
            ? differences.length > 0
              ? 'Service account metadata differs from Terraform.'
              : 'Service account identity and metadata match the live project.'
            : 'Terraform expects a service account that is not visible in the live IAM inventory.',
          evidence: match ? [`Service account email: ${match.email}`] : [],
          differences
        }))
        break
      }
      case 'google_project_iam_member': {
        if (errors.iamOverview) {
          items.push(unsupportedItem(item, context, `IAM bindings could not be loaded: ${errors.iamOverview}`))
          break
        }
        const role = str(item.values.role)
        const member = str(item.values.member)
        const binding = (live.iamOverview?.bindings ?? []).find((entry) => entry.role === role && entry.members.includes(member))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(binding),
          cloudIdentifier: `${role}:${member}`,
          explanation: binding
            ? 'The expected IAM role/member binding exists in the live project.'
            : 'Terraform expects an IAM binding that is not present in the live project policy.',
          evidence: binding ? [`Members on role ${role}: ${binding.memberCount}`] : []
        }))
        break
      }
      case 'google_compute_instance': {
        if (errors.computeInstances) {
          items.push(unsupportedItem(item, context, `Compute Engine inventory could not be loaded: ${errors.computeInstances}`))
          break
        }
        const name = str(item.values.name) || item.name
        const zone = normalizeResourceBasename(str(item.values.zone))
        const liveInstance = (live.computeInstances ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'zone', 'Zone', zone, str(liveInstance?.zone))
        compareValues(differences, 'machineType', 'Machine Type', normalizeResourceBasename(str(item.values.machine_type)), str(liveInstance?.machineType))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveInstance),
          cloudIdentifier: name,
          region: liveInstance?.zone || zone,
          explanation: liveInstance
            ? differences.length > 0
              ? 'The live VM differs from the Terraform machine shape or placement.'
              : 'The live VM matches the tracked Terraform attributes.'
            : 'Terraform tracks a VM that is not present in the live Compute Engine inventory.',
          evidence: unique([liveInstance?.status ? `Status: ${liveInstance.status}` : '', liveInstance?.internalIp ? `Internal IP: ${liveInstance.internalIp}` : '', liveInstance?.externalIp ? `External IP: ${liveInstance.externalIp}` : '']).filter(Boolean),
          differences
        }))
        break
      }
      case 'google_container_cluster': {
        if (errors.gkeClusters) {
          items.push(unsupportedItem(item, context, `GKE cluster inventory could not be loaded: ${errors.gkeClusters}`))
          break
        }
        const name = str(item.values.name) || item.name
        const location = str(item.values.location) || str(item.values.region) || str(item.values.zone)
        const liveCluster = (live.gkeClusters ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'location', 'Location', location, str(liveCluster?.location))
        const releaseChannel = str(getPathValue(item.values, ['release_channel', 0, 'channel'])) || str(item.values.release_channel)
        compareValues(differences, 'releaseChannel', 'Release Channel', releaseChannel, str(liveCluster?.releaseChannel))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveCluster),
          cloudIdentifier: name,
          region: liveCluster?.location || location,
          explanation: liveCluster
            ? differences.length > 0
              ? 'The live GKE cluster differs from the Terraform-declared location or release channel.'
              : 'The live GKE cluster matches the Terraform placement signals.'
            : 'Terraform tracks a cluster that is not present in the live GKE inventory.',
          evidence: unique([liveCluster?.status ? `Status: ${liveCluster.status}` : '', liveCluster?.masterVersion ? `Master version: ${liveCluster.masterVersion}` : '', liveCluster?.nodeCount ? `Node count: ${liveCluster.nodeCount}` : '']).filter(Boolean),
          differences
        }))
        break
      }
      case 'google_storage_bucket': {
        if (errors.storageBuckets) {
          items.push(unsupportedItem(item, context, `Cloud Storage inventory could not be loaded: ${errors.storageBuckets}`))
          break
        }
        const name = str(item.values.name) || item.name
        const liveBucket = (live.storageBuckets ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'location', 'Location', str(item.values.location), str(liveBucket?.location))
        compareValues(differences, 'storageClass', 'Storage Class', str(item.values.storage_class), str(liveBucket?.storageClass))
        const versioningEnabled = getPathValue(item.values, ['versioning', 0, 'enabled'])
        if (typeof versioningEnabled === 'boolean') {
          compareValues(differences, 'versioning', 'Versioning Enabled', String(versioningEnabled), String(Boolean(liveBucket?.versioningEnabled)))
        }
        const uble = getPathValue(item.values, ['uniform_bucket_level_access'])
        if (typeof uble === 'boolean') {
          compareValues(differences, 'uniformBucketLevelAccess', 'Uniform Bucket-Level Access', String(uble), String(Boolean(liveBucket?.uniformBucketLevelAccessEnabled)))
        }
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveBucket),
          cloudIdentifier: name,
          region: liveBucket?.location || context.location,
          explanation: liveBucket
            ? differences.length > 0
              ? 'The live bucket differs from the Terraform storage posture.'
              : 'The live bucket matches the tracked Terraform attributes.'
            : 'Terraform tracks a bucket that is not present in the live Cloud Storage inventory.',
          evidence: unique([
            liveBucket?.locationType ? `Location type: ${liveBucket.locationType}` : '',
            liveBucket?.publicAccessPrevention ? `Public access prevention: ${liveBucket.publicAccessPrevention}` : '',
            typeof liveBucket?.labelCount === 'number' ? `Labels: ${liveBucket.labelCount}` : ''
          ].filter(Boolean)),
          differences
        }))
        break
      }
      case 'google_sql_database_instance': {
        if (errors.sqlInstances) {
          items.push(unsupportedItem(item, context, `Cloud SQL inventory could not be loaded: ${errors.sqlInstances}`))
          break
        }
        const name = str(item.values.name) || item.name
        const liveSql = (live.sqlInstances ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'region', 'Region', str(item.values.region), str(liveSql?.region))
        compareValues(differences, 'databaseVersion', 'Database Version', str(item.values.database_version), str(liveSql?.databaseVersion))
        compareValues(differences, 'availabilityType', 'Availability Type', str(getPathValue(item.values, ['settings', 0, 'availability_type'])), str(liveSql?.availabilityType))
        const deletionProtection = getPathValue(item.values, ['deletion_protection']) ?? getPathValue(item.values, ['deletion_protection_enabled'])
        if (typeof deletionProtection === 'boolean') {
          compareValues(differences, 'deletionProtection', 'Deletion Protection', String(deletionProtection), String(Boolean(liveSql?.deletionProtectionEnabled)))
        }
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveSql),
          cloudIdentifier: name,
          region: liveSql?.region || str(item.values.region) || context.location,
          explanation: liveSql
            ? differences.length > 0
              ? 'The live Cloud SQL instance differs from key Terraform database settings.'
              : 'The live Cloud SQL instance matches the tracked Terraform posture.'
            : 'Terraform tracks a Cloud SQL instance that is not present in the live inventory.',
          evidence: unique([
            liveSql?.state ? `State: ${liveSql.state}` : '',
            liveSql?.availabilityType ? `HA mode: ${liveSql.availabilityType}` : '',
            liveSql?.primaryAddress ? `Primary address: ${liveSql.primaryAddress}` : '',
            liveSql?.privateAddress ? `Private address: ${liveSql.privateAddress}` : ''
          ].filter(Boolean)),
          differences
        }))
        break
      }
      default:
        items.push(unsupportedItem(item, context, 'Live drift coverage for this Google resource type has not been implemented yet.'))
    }
  }

  const managedAddressSet = new Set(managedInventory.map((item) => `${item.type}:${str(item.values.name) || str(item.values.account_id) || item.name}`))
  for (const entry of live.computeInstances ?? []) {
    if (!managedAddressSet.has(`google_compute_instance:${entry.name}`)) {
      items.push(buildUnmanagedItem('google_compute_instance', entry.name, entry.name, entry.zone || context.location, context, [`Status: ${entry.status}`, `Machine type: ${entry.machineType}`], 'A live Compute Engine instance was found without a matching Terraform-managed resource.'))
    }
  }
  for (const entry of live.gkeClusters ?? []) {
    if (!managedAddressSet.has(`google_container_cluster:${entry.name}`)) {
      items.push(buildUnmanagedItem('google_container_cluster', entry.name, entry.name, entry.location || context.location, context, [`Status: ${entry.status}`, `Release channel: ${entry.releaseChannel || '-'}`], 'A live GKE cluster exists outside the current Terraform inventory.'))
    }
  }
  for (const entry of live.storageBuckets ?? []) {
    if (!managedAddressSet.has(`google_storage_bucket:${entry.name}`)) {
      items.push(buildUnmanagedItem('google_storage_bucket', entry.name, entry.name, entry.location || context.location, context, [`Storage class: ${entry.storageClass}`, `Versioning: ${entry.versioningEnabled ? 'enabled' : 'disabled'}`], 'A live Cloud Storage bucket exists without a matching Terraform-managed bucket resource.'))
    }
  }
  for (const entry of live.sqlInstances ?? []) {
    if (!managedAddressSet.has(`google_sql_database_instance:${entry.name}`)) {
      items.push(buildUnmanagedItem('google_sql_database_instance', entry.name, entry.name, entry.region || context.location, context, [`State: ${entry.state}`, `Engine: ${entry.databaseVersion}`], 'A live Cloud SQL instance exists outside the current Terraform inventory.'))
    }
  }
  for (const entry of live.iamOverview?.serviceAccounts ?? []) {
    const emailKey = `google_service_account:${entry.email}`
    const accountKey = `google_service_account:${entry.email.split('@')[0] || entry.email}`
    if (!managedAddressSet.has(emailKey) && !managedAddressSet.has(accountKey)) {
      items.push(buildUnmanagedItem('google_service_account', entry.displayName || entry.email, entry.email, context.location, context, [`Disabled: ${entry.disabled ? 'yes' : 'no'}`], 'A live service account exists without a matching Terraform-managed service account resource.'))
    }
  }

  const scannedAt = new Date().toISOString()
  const snapshot: TerraformDriftSnapshot = {
    id: randomUUID(),
    scannedAt,
    trigger: 'manual',
    items,
    summary: buildSummary(items, coverage, scannedAt)
  }

  return {
    projectId,
    projectName: project.name,
    profileName,
    region: context.location,
    summary: snapshot.summary,
    items,
    history: buildHistory([snapshot]),
    fromCache: false
  }
}

function buildPostureSummary(items: Array<{ id: string; label: string; ok: number; total: number; goodDetail: string; weakDetail: string }>): ObservabilityPostureArea[] {
  return items.map((item) => {
    const ratio = item.total === 0 ? 0 : item.ok / item.total
    return {
      id: item.id,
      label: item.label,
      value: `${item.ok}/${item.total}`,
      tone: toneFromScore(ratio),
      detail: ratio >= 0.75 ? item.goodDetail : item.weakDetail
    }
  })
}

function pushRecommendationArtifacts(
  recommendations: ObservabilityRecommendation[],
  experiments: ResilienceExperimentSuggestion[]
): GeneratedArtifact[] {
  return [
    ...recommendations.flatMap((item) => (item.artifact ? [item.artifact] : [])),
    ...experiments.flatMap((item) => (item.artifact ? [item.artifact] : []))
  ]
}

export async function generateGcpTerraformObservabilityReport(
  profileName: string,
  projectId: string,
  connection?: AwsConnection
): Promise<ObservabilityPostureReport> {
  const project = getProject(profileName, projectId)
  const context = parseGcpContext(profileName, project, connection)
  if (!context.projectId) {
    throw new Error('Choose a GCP project context before loading the Terraform lab.')
  }

  let drift: TerraformDriftReport | null = null
  try {
    drift = await getGcpTerraformDriftReport(profileName, projectId, connection)
  } catch {
    drift = null
  }

  const { data: live, errors } = await loadLiveData(context)
  const inventoryBlob = inventoryText(project)
  const hasLoggingResources = hasResource(project, 'google_logging_')
  const hasMonitoringResources = hasResource(project, 'google_monitoring_')
  const hasTraceSignals = /trace|telemetry|otel|opentelemetry/.test(inventoryBlob)
  const hasGke = hasResource(project, 'google_container_')
  const driftIssueCount = drift ? drift.summary.statusCounts.drifted + drift.summary.statusCounts.missing_in_aws + drift.summary.statusCounts.unmanaged_in_aws : 0
  const planRisk = project.lastPlanSummary.hasDestructiveChanges || project.lastPlanSummary.hasReplacementChanges

  const findings: ObservabilityFinding[] = []
  const recommendations: ObservabilityRecommendation[] = []
  const experiments: ResilienceExperimentSuggestion[] = []
  const correlatedSignals: CorrelatedSignalReference[] = []

  const loggingApiEnabled = (live.projectOverview?.enabledApis ?? []).some((entry) => entry.name === 'logging.googleapis.com')
  const monitoringApiEnabled = (live.projectOverview?.enabledApis ?? []).some((entry) => entry.name === 'monitoring.googleapis.com')
  const billingEnabled = live.billingOverview?.billingEnabled === true

  if (!hasLoggingResources) {
    findings.push({
      id: 'gcp-logging-gap',
      title: 'Terraform does not model project log routing',
      severity: loggingApiEnabled ? 'medium' : 'high',
      category: 'logs',
      summary: 'The inventory does not include a project log sink or logging-specific Terraform resources.',
      detail: 'This makes it harder to prove that platform logs are exported intentionally and consistently across environments.',
      evidence: unique([
        loggingApiEnabled ? 'logging.googleapis.com is enabled.' : 'logging.googleapis.com does not appear in the enabled API list.',
        errors.projectOverview ? `Project/API inspection warning: ${errors.projectOverview}` : ''
      ].filter(Boolean)),
      impact: 'Operators may rely on ad hoc log visibility instead of repeatable routing and retention controls.',
      inference: false,
      recommendedActionIds: ['gcp-log-sink-snippet']
    })
    recommendations.push({
      id: 'gcp-log-sink-snippet',
      title: 'Add a Google Cloud log sink to Terraform',
      type: 'terraform',
      summary: 'Capture project logs through a Terraform-managed sink.',
      rationale: 'A sink makes log export intent explicit and reviewable in the same workflow as the rest of the platform.',
      expectedBenefit: 'Improves auditability and gives the team a stable place to wire exports or retention policy later.',
      risk: 'Low, but destination choice and retention must be reviewed before apply.',
      rollback: 'Remove the sink resource and rerun plan/apply if the route is not desired.',
      prerequisiteLevel: 'optional',
      setupEffort: 'low',
      labels: ['gcp', 'logging', 'terraform'],
      artifact: buildArtifact(
        'gcp-log-sink-snippet',
        'Project Log Sink Snippet',
        'terraform-snippet',
        'hcl',
        'Starter Terraform for a bounded project log sink.',
        `resource "google_logging_project_sink" "platform_errors" {\n  name        = "platform-errors"\n  project     = "${context.projectId}"\n  destination = "storage.googleapis.com/<audit-bucket>"\n  filter      = "severity>=ERROR"\n}\n`,
        'Review destination permissions and retention before applying.'
      )
    })
    correlatedSignals.push({
      id: 'gcp-logging-signal',
      title: 'Open GCP Logging',
      detail: 'Review live logs while deciding how to codify routing.',
      serviceId: 'gcp-logging',
      targetView: 'logs'
    })
  }

  if (!hasMonitoringResources) {
    findings.push({
      id: 'gcp-monitoring-gap',
      title: 'Terraform does not declare monitoring or alert policies',
      severity: monitoringApiEnabled ? 'medium' : 'high',
      category: 'metrics',
      summary: 'The current project inventory does not include Monitoring alert resources.',
      detail: 'Without Terraform-managed alert posture, incident signals are harder to review and reproduce across environments.',
      evidence: unique([
        monitoringApiEnabled ? 'monitoring.googleapis.com is enabled.' : 'monitoring.googleapis.com does not appear in the enabled API list.',
        project.lastCommandAt ? `Last Terraform command: ${project.lastCommandAt}` : 'No Terraform command has been recorded yet.'
      ]),
      impact: 'Teams may not notice platform regressions until customer-facing failures are already visible.',
      inference: false,
      recommendedActionIds: ['gcp-alert-policy-snippet']
    })
    recommendations.push({
      id: 'gcp-alert-policy-snippet',
      title: 'Add a starter alert policy resource',
      type: 'terraform',
      summary: 'Create one Terraform-managed alerting baseline.',
      rationale: 'A minimal alert policy gives the team a reviewable starting point for incident signal coverage.',
      expectedBenefit: 'Raises the floor on metrics posture without requiring a full monitoring redesign first.',
      risk: 'Low; thresholds still need service-specific tuning.',
      rollback: 'Delete the alert policy resource and apply again if it is too noisy.',
      prerequisiteLevel: 'optional',
      setupEffort: 'low',
      labels: ['gcp', 'monitoring', 'alerts'],
      artifact: buildArtifact(
        'gcp-alert-policy-snippet',
        'Alert Policy Snippet',
        'terraform-snippet',
        'hcl',
        'Starter Terraform for a Google Cloud Monitoring alert policy.',
        `resource "google_monitoring_alert_policy" "high_error_rate" {\n  display_name = "High error rate"\n  combiner     = "OR"\n\n  conditions {\n    display_name = "5xx rate"\n    condition_threshold {\n      filter          = "resource.type=\\"global\\" AND metric.type=\\"logging.googleapis.com/user/error_count\\""\n      comparison      = "COMPARISON_GT"\n      threshold_value = 1\n      duration        = "300s"\n    }\n  }\n}\n`,
        'Tune filter, threshold, and notification channels before apply.'
      )
    })
  }

  if (!hasTraceSignals) {
    findings.push({
      id: 'gcp-trace-gap',
      title: 'Tracing and collector intent are not obvious in Terraform',
      severity: 'medium',
      category: 'traces',
      summary: 'The project inventory does not clearly reference OTEL, tracing, or telemetry resources.',
      detail: 'This usually means trace collection still lives outside Terraform or has not been designed yet.',
      evidence: [hasGke ? 'GKE resources exist, so collector deployment could be codified near the platform modules.' : 'No obvious collector modules were found in the Terraform inventory.'],
      impact: 'Cross-service latency and failure analysis will remain slower than logs-plus-metrics alone.',
      inference: true,
      recommendedActionIds: ['gcp-collector-snippet']
    })
    recommendations.push({
      id: 'gcp-collector-snippet',
      title: 'Document collector intent next to the Terraform stack',
      type: 'yaml',
      summary: 'Start with a small collector config or deployment stub.',
      rationale: 'Even a thin stub gives the team a shared contract for where traces should flow.',
      expectedBenefit: 'Reduces ambiguity about telemetry ownership and makes future rollout easier.',
      risk: 'Low; the config is only a starting point.',
      rollback: 'Remove the stub until the destination and service coverage are agreed.',
      prerequisiteLevel: 'optional',
      setupEffort: 'medium',
      labels: ['gcp', 'otel', 'tracing'],
      artifact: buildArtifact(
        'gcp-collector-snippet',
        'Collector Config Stub',
        'otel-collector-config',
        'yaml',
        'Starter OTEL collector config for a GKE-based deployment.',
        `receivers:\n  otlp:\n    protocols:\n      grpc:\n      http:\nprocessors:\n  batch: {}\nexporters:\n  logging:\n    loglevel: info\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [logging]\n`,
        'Replace the logging exporter with the real destination before production rollout.'
      )
    })
  }

  if (driftIssueCount > 0) {
    findings.push({
      id: 'gcp-drift-risk',
      title: 'Terraform and live GCP inventory are out of sync',
      severity: driftIssueCount >= 4 ? 'high' : 'medium',
      category: 'rollback',
      summary: `The latest drift pass found ${driftIssueCount} issue(s) across the tracked Terraform inventory.`,
      detail: 'Rollback and incident response are harder when state, configuration, and live resources disagree.',
      evidence: drift ? [
        `${drift.summary.statusCounts.drifted} drifted`,
        `${drift.summary.statusCounts.missing_in_aws} missing`,
        `${drift.summary.statusCounts.unmanaged_in_aws} unmanaged`
      ] : ['The drift report could not be loaded.'],
      impact: 'Operators may make recovery decisions from stale assumptions about what Terraform actually controls.',
      inference: false,
      recommendedActionIds: ['gcp-refresh-only-plan']
    })
    correlatedSignals.push({
      id: 'gcp-drift-signal',
      title: 'Open Terraform Drift',
      detail: 'Review the exact mismatches before planning any recovery change.',
      serviceId: 'gcp-projects',
      targetView: 'drift'
    })
  }

  if (!billingEnabled) {
    findings.push({
      id: 'gcp-billing-risk',
      title: 'Billing is not clearly enabled for the selected project',
      severity: 'high',
      category: 'deployment',
      summary: 'The billing overview does not show an active billing link for the selected project.',
      detail: 'Even a healthy Terraform plan can fail later if billing posture is incomplete or opaque.',
      evidence: unique([
        live.billingOverview?.billingAccountDisplayName ? `Billing account: ${live.billingOverview.billingAccountDisplayName}` : 'No linked billing account was returned.',
        errors.billingOverview ? `Billing inspection warning: ${errors.billingOverview}` : ''
      ].filter(Boolean)),
      impact: 'Service creation, scaling, and recovery actions may fail for reasons unrelated to Terraform syntax or state.',
      inference: false,
      recommendedActionIds: ['gcp-billing-check']
    })
    correlatedSignals.push({
      id: 'gcp-billing-signal',
      title: 'Open GCP Billing',
      detail: 'Validate the live billing link before running higher-risk Terraform changes.',
      serviceId: 'gcp-billing',
      targetView: 'overview'
    })
  }

  if (planRisk) {
    findings.push({
      id: 'gcp-plan-risk',
      title: 'Latest saved plan carries replacement or destructive risk',
      severity: 'medium',
      category: 'deployment',
      summary: 'The current Terraform project has a replacement-heavy or destructive saved plan.',
      detail: 'Lab work should stay bounded when the last saved plan already suggests notable infrastructure churn.',
      evidence: [
        `Creates: ${project.lastPlanSummary.create}`,
        `Updates: ${project.lastPlanSummary.update}`,
        `Deletes: ${project.lastPlanSummary.delete}`,
        `Replacements: ${project.lastPlanSummary.replace}`
      ],
      impact: 'Operational validation can blur together with unrelated infrastructure change if the baseline plan is already unstable.',
      inference: false,
      recommendedActionIds: ['gcp-refresh-only-plan']
    })
  }

  recommendations.push({
    id: 'gcp-refresh-only-plan',
    title: 'Run a refresh-only plan before deeper testing',
    type: 'command',
    summary: 'Reconcile Terraform state knowledge with live GCP without proposing config changes.',
    rationale: 'A refresh-only plan is the cleanest way to reduce ambiguity before drift review or resilience drills.',
    expectedBenefit: 'Clarifies whether the next issue is configuration drift or an operational problem.',
    risk: 'Low. This command reads live state but does not apply changes.',
    rollback: 'No rollback required; it is an analysis step.',
    prerequisiteLevel: 'none',
    setupEffort: 'none',
    labels: ['terraform', 'refresh-only', 'gcp'],
    artifact: buildArtifact(
      'gcp-refresh-only-plan',
      'Refresh-Only Plan Command',
      'shell-command',
      'bash',
      'Bounded Terraform refresh-only analysis for the selected project.',
      'terraform plan -refresh-only',
      'Read-only analysis command. Review the workspace and variable set before execution.',
      true
    )
  })

  recommendations.push({
    id: 'gcp-cli-health-check',
    title: 'Verify billing and recent platform errors from the CLI',
    type: 'command',
    summary: 'Use one command to verify the project context and another to inspect recent errors.',
    rationale: 'These checks quickly separate context/configuration problems from genuine Terraform defects.',
    expectedBenefit: 'Shortens root-cause time when plans fail for environmental reasons.',
    risk: 'Low. The commands only read project metadata and logs.',
    rollback: 'No rollback required.',
    prerequisiteLevel: 'none',
    setupEffort: 'none',
    labels: ['gcloud', 'billing', 'logging'],
    artifact: buildArtifact(
      'gcp-cli-health-check',
      'GCP Health Check Command',
      'shell-command',
      'bash',
      'Verify billing and inspect the most recent error logs for the selected project.',
      `gcloud beta billing projects describe ${context.projectId}\ngcloud logging read "severity>=ERROR" --project ${context.projectId} --limit=20 --freshness=24h`,
      'Read-only gcloud commands. Confirm the active project before execution.',
      true
    )
  })

  experiments.push({
    id: 'gcp-refresh-drill',
    title: 'Refresh-only drift drill',
    summary: 'Run a refresh-only plan and compare the result with the Drift tab before touching live resources.',
    hypothesis: 'If the environment is stable, refresh-only results should align closely with the current drift report.',
    blastRadius: 'Terraform analysis only. No live mutation.',
    prerequisites: ['Confirm the selected workspace and variable set', 'Review any existing saved plan warnings'],
    rollback: 'No rollback required.',
    setupEffort: 'none',
    prerequisiteLevel: 'none',
    artifact: buildArtifact(
      'gcp-refresh-drill-command',
      'Refresh-Only Drill Command',
      'shell-command',
      'bash',
      'Minimal command for a no-mutation drift validation drill.',
      'terraform plan -refresh-only',
      'Read-only analysis command.',
      true
    )
  })

  if (hasGke) {
    experiments.push({
      id: 'gcp-gke-logs-drill',
      title: 'GKE signal validation drill',
      summary: 'Pick one non-critical workload and confirm that restart-related signals are visible in logs and dashboards.',
      hypothesis: 'A bounded restart should produce an operator-visible trail across logs, metrics, and workload status.',
      blastRadius: 'One non-critical deployment in one namespace.',
      prerequisites: ['Choose a low-risk namespace', 'Validate rollback owner and kubectl access'],
      rollback: 'Roll back the workload deployment or redeploy the previous revision if health does not return quickly.',
      setupEffort: 'low',
      prerequisiteLevel: 'optional',
      artifact: buildArtifact(
        'gcp-gke-logs-drill',
        'GKE Rollout Restart Command',
        'shell-command',
        'bash',
        'Starter command for a bounded GKE rollout restart drill.',
        'kubectl rollout restart deployment/<deployment-name> -n <namespace>',
        'Mutates a workload. Use only on an explicitly approved non-critical deployment.',
        true
      )
    })
  }

  const summary = buildPostureSummary([
    {
      id: 'logs',
      label: 'Logs',
      ok: hasLoggingResources ? 1 : 0,
      total: 1,
      goodDetail: 'Terraform already includes logging-oriented resources for this project.',
      weakDetail: 'Project log routing is not yet clearly modeled in Terraform.'
    },
    {
      id: 'metrics',
      label: 'Metrics',
      ok: hasMonitoringResources ? 1 : 0,
      total: 1,
      goodDetail: 'Monitoring or alerting resources are present in the Terraform inventory.',
      weakDetail: 'Monitoring posture is thin or absent in the current Terraform stack.'
    },
    {
      id: 'traces',
      label: 'Traces',
      ok: hasTraceSignals ? 1 : 0,
      total: 1,
      goodDetail: 'Trace or OTEL signals are visible in the Terraform inventory.',
      weakDetail: 'Trace collection intent is not obvious in the Terraform inventory.'
    },
    {
      id: 'deployment',
      label: 'Deployment',
      ok: planRisk ? 0 : 1,
      total: 1,
      goodDetail: 'The current saved plan does not show destructive-heavy churn.',
      weakDetail: 'The latest saved plan already carries replacement or destructive risk.'
    },
    {
      id: 'rollback',
      label: 'Rollback',
      ok: driftIssueCount === 0 ? 1 : 0,
      total: 1,
      goodDetail: 'Terraform and live GCP appear aligned for the currently covered resources.',
      weakDetail: 'Live GCP and Terraform state still disagree on covered resources.'
    }
  ])

  const artifacts = pushRecommendationArtifacts(recommendations, experiments)

  return sortReport({
    generatedAt: new Date().toISOString(),
    scope: {
      kind: 'terraform',
      connection: connectionRef(connection, context, profileName),
      projectId,
      projectName: project.name,
      rootPath: project.rootPath
    },
    summary,
    findings,
    recommendations,
    experiments,
    artifacts,
    safetyNotes: [
      {
        title: 'Prefer refresh-only checks first',
        blastRadius: 'No live mutation.',
        prerequisites: ['Correct Terraform workspace selected', 'Expected variable set loaded'],
        rollback: 'No rollback required.'
      },
      {
        title: 'Keep workload drills tightly bounded',
        blastRadius: 'Single deployment, namespace, or service only.',
        prerequisites: ['Named owner', 'Rollback path agreed', 'Low-risk time window'],
        rollback: 'Revert the workload deployment or disable the test route immediately.'
      }
    ],
    correlatedSignals
  })
}
