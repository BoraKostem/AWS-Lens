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
import { enrichTerragruntProjectInventory, getCachedCliInfo, getProject, loadTerragruntUnitInventory, type TerragruntUnitInventoryResult } from './terraform'
import { createTraceContext, withAudit } from './terraformAudit'
import {
  getGcpBillingOverview,
  getGcpComputeInstanceDetail,
  getGcpIamOverview,
  getGcpGkeClusterDetail,
  getGcpProjectOverview,
  getGcpSqlInstanceDetail,
  listGcpBigQueryDatasetsExported,
  listGcpBigQueryTables,
  listGcpComputeInstances,
  listGcpEnabledApis,
  listGcpFirestoreDatabases,
  listGcpFirewallRules,
  listGcpGkeClusters,
  listGcpGkeNodePools,
  listGcpGlobalAddresses,
  listGcpMonitoringAlertPolicies,
  listGcpMonitoringUptimeChecks,
  listGcpNetworks,
  listGcpPubSubSubscriptions,
  listGcpPubSubTopics,
  listGcpRouters,
  listGcpServiceAccounts,
  listGcpServiceNetworkingConnections,
  listGcpSqlDatabasesForInstances,
  listGcpSqlInstances,
  listGcpSqlUsers,
  listGcpSubnetworks,
  listGcpStorageBuckets,
  listGcpCloudRunServices,
  listGcpDnsManagedZones
} from './gcp'

type GcpTerraformContext = { projectId: string; location: string }
type GcpLiveData = {
  projectOverview?: Awaited<ReturnType<typeof getGcpProjectOverview>>
  iamOverview?: Awaited<ReturnType<typeof getGcpIamOverview>>
  enabledApis?: Awaited<ReturnType<typeof listGcpEnabledApis>>
  serviceAccounts?: Awaited<ReturnType<typeof listGcpServiceAccounts>>
  computeInstances?: Awaited<ReturnType<typeof listGcpComputeInstances>>
  computeInstanceDetails?: Record<string, Awaited<ReturnType<typeof getGcpComputeInstanceDetail>>>
  firewallRules?: Awaited<ReturnType<typeof listGcpFirewallRules>>
  gkeClusters?: Awaited<ReturnType<typeof listGcpGkeClusters>>
  gkeClusterDetails?: Record<string, Awaited<ReturnType<typeof getGcpGkeClusterDetail>>>
  gkeNodePoolsByCluster?: Record<string, Awaited<ReturnType<typeof listGcpGkeNodePools>>>
  networks?: Awaited<ReturnType<typeof listGcpNetworks>>
  subnetworks?: Awaited<ReturnType<typeof listGcpSubnetworks>>
  routers?: Awaited<ReturnType<typeof listGcpRouters>>
  globalAddresses?: Awaited<ReturnType<typeof listGcpGlobalAddresses>>
  serviceNetworkingConnections?: Awaited<ReturnType<typeof listGcpServiceNetworkingConnections>>
  storageBuckets?: Awaited<ReturnType<typeof listGcpStorageBuckets>>
  sqlInstances?: Awaited<ReturnType<typeof listGcpSqlInstances>>
  sqlInstanceDetails?: Record<string, Awaited<ReturnType<typeof getGcpSqlInstanceDetail>>>
  sqlDatabases?: Awaited<ReturnType<typeof listGcpSqlDatabasesForInstances>>
  sqlUsers?: Awaited<ReturnType<typeof listGcpSqlUsers>>
  billingOverview?: Awaited<ReturnType<typeof getGcpBillingOverview>>
  pubsubTopics?: Awaited<ReturnType<typeof listGcpPubSubTopics>>
  pubsubSubscriptions?: Awaited<ReturnType<typeof listGcpPubSubSubscriptions>>
  bigqueryDatasets?: Awaited<ReturnType<typeof listGcpBigQueryDatasetsExported>>
  bigqueryTablesByDataset?: Record<string, Awaited<ReturnType<typeof listGcpBigQueryTables>>>
  monitoringAlertPolicies?: Awaited<ReturnType<typeof listGcpMonitoringAlertPolicies>>
  monitoringUptimeChecks?: Awaited<ReturnType<typeof listGcpMonitoringUptimeChecks>>
  firestoreDatabases?: Awaited<ReturnType<typeof listGcpFirestoreDatabases>>
  cloudRunServices?: Awaited<ReturnType<typeof listGcpCloudRunServices>>
  dnsManagedZones?: Awaited<ReturnType<typeof listGcpDnsManagedZones>>
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((item) => str(item)).filter(Boolean)
}

function sortedStringList(value: unknown): string[] {
  return unique(stringList(value).map((item) => normalizeResourceBasename(item))).sort()
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
  // Prefer the project ID from terraform state over the connection profile. The profile
  // name is often an AWS-style label ("aws-lens", etc.) that doesn't map to a real GCP
  // project — passing it to the Compute API returns an empty inventory, which surfaces
  // as every resource being "missing in GCP" even when it's running. State values carry
  // the authoritative project reference whenever the unit has applied resources.
  const projectId = [
    inventoryProjectId,
    match?.[1] && match[1] !== 'unscoped' ? match[1] : '',
    str(project.environment.connectionLabel),
    connection?.profile
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
    case 'google_compute_firewall':
      return gcpConsoleUrl('networking/firewalls/list', context.projectId)
    case 'google_compute_network':
      return gcpConsoleUrl(`networking/networks/details/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_compute_subnetwork':
      return gcpConsoleUrl(`networking/subnetworks/details/${encodeURIComponent(locationHint)}/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_compute_router':
    case 'google_compute_router_nat':
      return gcpConsoleUrl('hybrid/cloudrouters/list', context.projectId)
    case 'google_compute_global_address':
      return gcpConsoleUrl('networking/addresses/list', context.projectId)
    case 'google_compute_instance':
      return gcpConsoleUrl(`compute/instancesDetail/zones/${encodeURIComponent(locationHint)}/instances/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_container_cluster':
      return gcpConsoleUrl(`kubernetes/clusters/details/${encodeURIComponent(locationHint)}/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_container_node_pool':
      return gcpConsoleUrl('kubernetes/list/overview', context.projectId)
    case 'google_service_networking_connection':
      return gcpConsoleUrl('networking/servicenetworking', context.projectId)
    case 'google_storage_bucket':
      return gcpConsoleUrl(`storage/browser/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_sql_database_instance':
      return gcpConsoleUrl(`sql/instances/${encodeURIComponent(logicalName)}/overview`, context.projectId)
    case 'google_sql_database':
      return gcpConsoleUrl(`sql/instances/${encodeURIComponent(locationHint)}/databases`, context.projectId)
    case 'google_sql_user':
      return gcpConsoleUrl(`sql/instances/${encodeURIComponent(locationHint)}/users`, context.projectId)
    case 'google_pubsub_topic':
      return gcpConsoleUrl(`cloudpubsub/topic/detail/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_pubsub_subscription':
      return gcpConsoleUrl(`cloudpubsub/subscription/detail/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_bigquery_dataset':
      return gcpConsoleUrl(`bigquery?d=${encodeURIComponent(logicalName)}&p=${encodeURIComponent(context.projectId)}`, context.projectId)
    case 'google_bigquery_table':
      return gcpConsoleUrl('bigquery', context.projectId)
    case 'google_monitoring_alert_policy':
      return gcpConsoleUrl('monitoring/alerting', context.projectId)
    case 'google_monitoring_uptime_check_config':
      return gcpConsoleUrl('monitoring/uptime', context.projectId)
    case 'google_firestore_database':
      return gcpConsoleUrl('firestore/databases', context.projectId)
    case 'google_cloud_run_service':
      return gcpConsoleUrl(`run/detail/${encodeURIComponent(locationHint)}/${encodeURIComponent(logicalName)}`, context.projectId)
    case 'google_dns_managed_zone':
      return gcpConsoleUrl(`net-services/dns/zones/${encodeURIComponent(logicalName)}`, context.projectId)
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

function terraformFlatPathKey(path: Array<string | number>): string {
  return path.map((segment) => String(segment)).join('.')
}

function getTerraformPathValue(source: unknown, path: Array<string | number>): unknown {
  const nestedValue = getPathValue(source, path)
  if (nestedValue !== undefined) {
    return nestedValue
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined
  }

  return (source as Record<string, unknown>)[terraformFlatPathKey(path)]
}

function setPathValue(target: Record<string, unknown> | unknown[], path: Array<string | number>, value: unknown): void {
  let current: Record<string, unknown> | unknown[] = target

  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]
    const isLast = index === path.length - 1
    const nextSegment = path[index + 1]

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        return
      }

      if (isLast) {
        current[segment] = value
        return
      }

      let nextValue = current[segment]
      if (!nextValue || typeof nextValue !== 'object') {
        nextValue = typeof nextSegment === 'number' ? [] : {}
        current[segment] = nextValue
      }
      current = nextValue as Record<string, unknown> | unknown[]
      continue
    }

    if (Array.isArray(current)) {
      return
    }

    if (isLast) {
      current[segment] = value
      return
    }

    let nextValue = current[segment]
    if (!nextValue || typeof nextValue !== 'object') {
      nextValue = typeof nextSegment === 'number' ? [] : {}
      current[segment] = nextValue
    }
    current = nextValue as Record<string, unknown> | unknown[]
  }
}

function getTerraformObjectArray(source: unknown, path: Array<string | number>): Record<string, unknown>[] {
  const directValue = getTerraformPathValue(source, path)
  if (Array.isArray(directValue)) {
    return directValue
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return []
  }

  const prefix = `${terraformFlatPathKey(path)}.`
  const grouped = new Map<number, Record<string, unknown>>()
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (!key.startsWith(prefix)) {
      continue
    }

    const remainder = key.slice(prefix.length)
    const match = remainder.match(/^(\d+)\.(.+)$/)
    if (!match) {
      continue
    }

    const index = Number(match[1])
    const nestedPath = match[2]
      .split('.')
      .map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment)
    const current = grouped.get(index) ?? {}
    setPathValue(current, nestedPath, value)
    grouped.set(index, current)
  }

  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value)
}

function getTerraformStringList(source: unknown, path: Array<string | number>): string[] {
  const directValue = getTerraformPathValue(source, path)
  if (Array.isArray(directValue)) {
    return stringList(directValue)
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return []
  }

  const record = source as Record<string, unknown>
  const prefix = terraformFlatPathKey(path)
  const indexedEntries = Object.entries(record)
    .map(([key, value]) => {
      const match = key.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`))
      if (!match) {
        return null
      }

      return { index: Number(match[1]), value: str(value) }
    })
    .filter((entry): entry is { index: number; value: string } => Boolean(entry?.value))
    .sort((left, right) => left.index - right.index)

  return indexedEntries.map((entry) => entry.value)
}

function normalizeResourceBasename(value: string): string {
  const trimmed = str(value)
  if (!trimmed) return ''
  const segments = trimmed.split('/')
  return segments[segments.length - 1] || trimmed
}

function compareSortedLists(differences: TerraformDriftDifference[], key: string, label: string, terraformValues: string[], liveValues: string[]) {
  compareValues(differences, key, label, terraformValues.join(', '), liveValues.join(', '))
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.trim(), str(item)])
      .filter(([key, item]) => key && item)
      .sort((left, right) => left[0].localeCompare(right[0]))
  )
}

function normalizeComparableGcpLabelMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(normalizeStringMap(value))
      .filter(([key]) => !key.toLowerCase().startsWith('goog-'))
  )
}

function mapEntries(value: Record<string, string>): string[] {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .sort((left, right) => left.localeCompare(right))
}

function compareStringMaps(differences: TerraformDriftDifference[], key: string, label: string, terraformValue: Record<string, string>, liveValue: Record<string, string>) {
  compareSortedLists(differences, key, label, mapEntries(terraformValue), mapEntries(liveValue))
}

function compareBooleanPath(differences: TerraformDriftDifference[], source: Record<string, unknown>, path: Array<string | number>, key: string, label: string, liveValue: boolean) {
  const terraformValue = getTerraformPathValue(source, path)
  if (terraformValue === undefined || terraformValue === null) {
    return
  }

  const normalized = typeof terraformValue === 'boolean'
    ? String(terraformValue)
    : typeof terraformValue === 'string'
      ? terraformValue.trim().toLowerCase()
      : typeof terraformValue === 'number'
        ? String(terraformValue !== 0)
        : ''
  if (normalized !== 'true' && normalized !== 'false') {
    return
  }

  compareValues(differences, key, label, normalized, String(liveValue))
}

function recordKey(regionOrZone: string, name: string): string {
  return `${regionOrZone.trim().toLowerCase()}::${name.trim().toLowerCase()}`
}

function extractAuthorizedNetworks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      const cidr = str(getPathValue(item, ['value']))
      const name = str(getPathValue(item, ['name']))
      return cidr || name
    })
    .filter(Boolean)
    .sort()
}

function resolveSqlInstanceName(item: TerraformResourceInventoryItem): string {
  return str(item.values.instance) || str(item.values.instance_name)
}

function toNumberString(value: unknown): string {
  return typeof value === 'number'
    ? String(value)
    : typeof value === 'string' && value.trim()
      ? value.trim()
      : ''
}

function toScalarString(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : ''
}

function firstDefinedPathValue(source: unknown, paths: Array<Array<string | number>>): unknown {
  for (const path of paths) {
    const value = getTerraformPathValue(source, path)
    if (value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())) {
      return value
    }
  }

  return undefined
}

function nodePoolDesiredSizeValue(source: unknown): string {
  return toNumberString(firstDefinedPathValue(source, [
    ['node_count'],
    ['nodeCount'],
    ['initial_node_count'],
    ['initialNodeCount']
  ]))
}

function nodePoolMinSizeValue(source: unknown): string {
  return toNumberString(firstDefinedPathValue(source, [
    ['autoscaling', 0, 'min_node_count'],
    ['autoscaling', 'min_node_count'],
    ['autoscaling', 0, 'minNodeCount'],
    ['autoscaling', 'minNodeCount'],
    ['min_node_count'],
    ['minNodeCount']
  ]))
}

function nodePoolMaxSizeValue(source: unknown): string {
  return toNumberString(firstDefinedPathValue(source, [
    ['autoscaling', 0, 'max_node_count'],
    ['autoscaling', 'max_node_count'],
    ['autoscaling', 0, 'maxNodeCount'],
    ['autoscaling', 'maxNodeCount'],
    ['max_node_count'],
    ['maxNodeCount']
  ]))
}

function gkeClusterLocation(item: TerraformResourceInventoryItem, context: GcpTerraformContext): string {
  return str(item.values.location) || str(item.values.region) || str(item.values.zone) || context.location
}

function gkeClusterName(item: TerraformResourceInventoryItem): string {
  if (item.type === 'google_container_node_pool') {
    return normalizeResourceBasename(str(item.values.cluster))
  }
  return normalizeResourceBasename(str(item.values.name) || item.name)
}

function gkeNodePoolKey(location: string, clusterName: string): string {
  return `${location.trim().toLowerCase()}::${clusterName.trim().toLowerCase()}`
}

type TerraformGkeNodePoolSpec = {
  name: string
  clusterName: string
  location: string
  nodeCount: string
  compareDesiredSize: boolean
  autoscalingConfigured: boolean
  minNodeCount: string
  maxNodeCount: string
  machineType: string
  imageType: string
  diskSizeGb: string
  version: string
  autoUpgradeEnabled: string
  autoRepairEnabled: string
  spotEnabled: string
  preemptible: string
  locations: string[]
}

function buildTerraformGkeNodePoolSpecs(item: TerraformResourceInventoryItem, context: GcpTerraformContext): TerraformGkeNodePoolSpec[] {
  if (item.type === 'google_container_node_pool') {
    const autoscalingConfigured = firstDefinedPathValue(item.values, [
      ['autoscaling', 0, 'min_node_count'],
      ['autoscaling', 'min_node_count'],
      ['autoscaling', 0, 'max_node_count'],
      ['autoscaling', 'max_node_count'],
      ['autoscaling', 0, 'minNodeCount'],
      ['autoscaling', 'minNodeCount'],
      ['autoscaling', 0, 'maxNodeCount'],
      ['autoscaling', 'maxNodeCount'],
      ['min_node_count'],
      ['minNodeCount'],
      ['max_node_count'],
      ['maxNodeCount']
    ]) !== undefined

    return [{
      name: str(item.values.name) || item.name,
      clusterName: normalizeResourceBasename(str(item.values.cluster)),
      location: gkeClusterLocation(item, context),
      nodeCount: nodePoolDesiredSizeValue(item.values),
      compareDesiredSize: firstDefinedPathValue(item.values, [['node_count'], ['nodeCount']]) !== undefined,
      autoscalingConfigured,
      minNodeCount: nodePoolMinSizeValue(item.values),
      maxNodeCount: nodePoolMaxSizeValue(item.values),
      machineType: toScalarString(getTerraformPathValue(item.values, ['node_config', 0, 'machine_type'])),
      imageType: toScalarString(getTerraformPathValue(item.values, ['node_config', 0, 'image_type'])),
      diskSizeGb: toNumberString(getTerraformPathValue(item.values, ['node_config', 0, 'disk_size_gb'])),
      version: toScalarString(getTerraformPathValue(item.values, ['version'])),
      autoUpgradeEnabled: toScalarString(getTerraformPathValue(item.values, ['management', 0, 'auto_upgrade'])),
      autoRepairEnabled: toScalarString(getTerraformPathValue(item.values, ['management', 0, 'auto_repair'])),
      spotEnabled: toScalarString(getTerraformPathValue(item.values, ['node_config', 0, 'spot'])),
      preemptible: toScalarString(getTerraformPathValue(item.values, ['node_config', 0, 'preemptible'])),
      locations: getTerraformStringList(item.values, ['node_locations']).sort()
    }].filter((entry) => entry.name && entry.clusterName)
  }

  if (item.type !== 'google_container_cluster') {
    return []
  }

  const clusterName = gkeClusterName(item)
  const location = gkeClusterLocation(item, context)
  const nodePools = getTerraformObjectArray(item.values, ['node_pool'])
  if (nodePools.length === 0) {
    return []
  }

  return nodePools
    .map((pool) => {
      const autoscalingConfigured = firstDefinedPathValue(pool, [
        ['autoscaling', 0, 'min_node_count'],
        ['autoscaling', 'min_node_count'],
        ['autoscaling', 0, 'max_node_count'],
        ['autoscaling', 'max_node_count'],
        ['autoscaling', 0, 'minNodeCount'],
        ['autoscaling', 'minNodeCount'],
        ['autoscaling', 0, 'maxNodeCount'],
        ['autoscaling', 'maxNodeCount'],
        ['min_node_count'],
        ['minNodeCount'],
        ['max_node_count'],
        ['maxNodeCount']
      ]) !== undefined

      return {
        name: toScalarString(getTerraformPathValue(pool, ['name'])),
        clusterName,
        location,
        nodeCount: nodePoolDesiredSizeValue(pool),
        compareDesiredSize: firstDefinedPathValue(pool, [['node_count'], ['nodeCount']]) !== undefined,
        autoscalingConfigured,
        minNodeCount: nodePoolMinSizeValue(pool),
        maxNodeCount: nodePoolMaxSizeValue(pool),
        machineType: toScalarString(getTerraformPathValue(pool, ['node_config', 0, 'machine_type'])),
        imageType: toScalarString(getTerraformPathValue(pool, ['node_config', 0, 'image_type'])),
        diskSizeGb: toNumberString(getTerraformPathValue(pool, ['node_config', 0, 'disk_size_gb'])),
        version: toScalarString(getTerraformPathValue(pool, ['version'])),
        autoUpgradeEnabled: toScalarString(getTerraformPathValue(pool, ['management', 0, 'auto_upgrade'])),
        autoRepairEnabled: toScalarString(getTerraformPathValue(pool, ['management', 0, 'auto_repair'])),
        spotEnabled: toScalarString(getTerraformPathValue(pool, ['node_config', 0, 'spot'])),
        preemptible: toScalarString(getTerraformPathValue(pool, ['node_config', 0, 'preemptible'])),
        locations: getTerraformStringList(pool, ['node_locations']).sort()
      }
    })
    .filter((entry) => entry.name)
}

function compareGkeNodePoolSpecs(
  differences: TerraformDriftDifference[],
  specs: TerraformGkeNodePoolSpec[],
  liveNodePools: Array<{
    name: string
    nodeCount: number
    minNodeCount: number
    maxNodeCount: number
    machineType: string
    imageType: string
    diskSizeGb: string
    version: string
    autoUpgradeEnabled: boolean
    autoRepairEnabled: boolean
    spotEnabled: boolean
    preemptible: boolean
    locations: string[]
  }>
) {
  for (const spec of specs) {
    const liveNodePool = liveNodePools.find((entry) => entry.name === spec.name)
    if (!liveNodePool) {
      differences.push(createDifference(`nodePool:${spec.name}:exists`, `Node Pool ${spec.name}`, 'present in Terraform', 'missing in GKE'))
      continue
    }

    const liveAutoscalingEnabled = liveNodePool.minNodeCount > 0 || liveNodePool.maxNodeCount > 0

    if (spec.compareDesiredSize && spec.nodeCount) {
      compareValues(differences, `nodePool:${spec.name}:nodeCount`, `Node Pool ${spec.name} Desired Size`, spec.nodeCount, String(liveNodePool.nodeCount))
    }
    if (spec.minNodeCount) {
      compareValues(differences, `nodePool:${spec.name}:minNodeCount`, `Node Pool ${spec.name} Min Size`, spec.minNodeCount, String(liveNodePool.minNodeCount))
    } else if (!spec.autoscalingConfigured && liveAutoscalingEnabled && liveNodePool.minNodeCount > 0) {
      differences.push(createDifference(`nodePool:${spec.name}:minNodeCount`, `Node Pool ${spec.name} Min Size`, 'not configured in Terraform', String(liveNodePool.minNodeCount)))
    }
    if (spec.maxNodeCount) {
      compareValues(differences, `nodePool:${spec.name}:maxNodeCount`, `Node Pool ${spec.name} Max Size`, spec.maxNodeCount, String(liveNodePool.maxNodeCount))
    } else if (!spec.autoscalingConfigured && liveAutoscalingEnabled && liveNodePool.maxNodeCount > 0) {
      differences.push(createDifference(`nodePool:${spec.name}:maxNodeCount`, `Node Pool ${spec.name} Max Size`, 'not configured in Terraform', String(liveNodePool.maxNodeCount)))
    }
    compareValues(differences, `nodePool:${spec.name}:machineType`, `Node Pool ${spec.name} Machine Type`, spec.machineType, String(liveNodePool.machineType))
    compareValues(differences, `nodePool:${spec.name}:imageType`, `Node Pool ${spec.name} Image Type`, spec.imageType, String(liveNodePool.imageType))
    compareValues(differences, `nodePool:${spec.name}:diskSizeGb`, `Node Pool ${spec.name} Disk Size (GB)`, spec.diskSizeGb, String(liveNodePool.diskSizeGb))
    compareValues(differences, `nodePool:${spec.name}:version`, `Node Pool ${spec.name} Version`, spec.version, String(liveNodePool.version))
    compareValues(differences, `nodePool:${spec.name}:autoUpgradeEnabled`, `Node Pool ${spec.name} Auto Upgrade`, spec.autoUpgradeEnabled, String(liveNodePool.autoUpgradeEnabled))
    compareValues(differences, `nodePool:${spec.name}:autoRepairEnabled`, `Node Pool ${spec.name} Auto Repair`, spec.autoRepairEnabled, String(liveNodePool.autoRepairEnabled))
    compareValues(differences, `nodePool:${spec.name}:spotEnabled`, `Node Pool ${spec.name} Spot`, spec.spotEnabled, String(liveNodePool.spotEnabled))
    compareValues(differences, `nodePool:${spec.name}:preemptible`, `Node Pool ${spec.name} Preemptible`, spec.preemptible, String(liveNodePool.preemptible))
    compareSortedLists(differences, `nodePool:${spec.name}:locations`, `Node Pool ${spec.name} Locations`, spec.locations, [...liveNodePool.locations].sort())
  }
}

function isManagedGkeNodeInstance(name: string, managedClusterNames: string[]): boolean {
  return managedClusterNames.some((clusterName) => clusterName && name.startsWith(`gke-${clusterName}-`))
}

function shouldIgnoreUnmanagedServiceAccount(email: string, displayName: string): boolean {
  const normalizedEmail = email.trim().toLowerCase()
  const normalizedDisplayName = displayName.trim().toLowerCase()

  return /^\d+-compute@developer\.gserviceaccount\.com$/.test(normalizedEmail)
    || normalizedEmail.endsWith('@cloudservices.gserviceaccount.com')
    || normalizedEmail.includes('gcp-sa-')
    || normalizedDisplayName.includes('default service account')
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
    missing_in_cloud: 0,
    unmanaged_in_cloud: 0,
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
    ['enabledApis', () => listGcpEnabledApis(context.projectId)],
    ['serviceAccounts', () => listGcpServiceAccounts(context.projectId)],
    ['computeInstances', () => listGcpComputeInstances(context.projectId, context.location)],
    ['firewallRules', () => listGcpFirewallRules(context.projectId)],
    ['gkeClusters', () => listGcpGkeClusters(context.projectId, context.location)],
    ['networks', () => listGcpNetworks(context.projectId)],
    ['subnetworks', () => listGcpSubnetworks(context.projectId, context.location)],
    ['routers', () => listGcpRouters(context.projectId, context.location)],
    ['globalAddresses', () => listGcpGlobalAddresses(context.projectId)],
    ['storageBuckets', () => listGcpStorageBuckets(context.projectId, context.location)],
    ['sqlInstances', () => listGcpSqlInstances(context.projectId, context.location)],
    ['billingOverview', () => getGcpBillingOverview(context.projectId, [context.projectId])],
    ['pubsubTopics', () => listGcpPubSubTopics(context.projectId)],
    ['pubsubSubscriptions', () => listGcpPubSubSubscriptions(context.projectId)],
    ['bigqueryDatasets', () => listGcpBigQueryDatasetsExported(context.projectId)],
    ['monitoringAlertPolicies', () => listGcpMonitoringAlertPolicies(context.projectId)],
    ['monitoringUptimeChecks', () => listGcpMonitoringUptimeChecks(context.projectId)],
    ['firestoreDatabases', () => listGcpFirestoreDatabases(context.projectId)],
    ['cloudRunServices', () => listGcpCloudRunServices(context.projectId, context.location)],
    ['dnsManagedZones', () => listGcpDnsManagedZones(context.projectId)]
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
  const items: TerraformDriftCoverageItem[] = [
    coverageItem('google_project', ['Project exists', 'Display name'], [], ['Confirms the selected project still exists and the display name matches Terraform inputs when set.']),
    coverageItem('google_project_service', ['API enabled state'], [], ['Focuses on live enablement only. Default Google-managed services are not backfilled as unmanaged noise.']),
    coverageItem('google_service_account', ['Service account exists', 'Display name', 'Disabled flag'], [], ['Email is derived from Terraform when only account_id is available.']),
    coverageItem('google_project_iam_member', ['Role/member binding exists'], [], ['Treats additive IAM changes outside Terraform as manual review, not unmanaged live inventory.']),
    coverageItem('google_compute_firewall', ['Firewall rule exists', 'Network', 'Direction'], [], ['Priority is included when it is explicitly declared in Terraform.']),
    coverageItem('google_compute_global_address', ['Global address exists', 'Address type', 'Purpose', 'Reserved prefix length'], [], ['Private service ranges are validated from the global address inventory.']),
    coverageItem('google_compute_instance', ['Instance exists', 'Zone', 'Machine type'], [], ['Operational runtime flags such as current status are kept as evidence, not config drift.']),
    coverageItem('google_compute_network', ['VPC network exists', 'Auto subnet mode', 'Routing mode'], [], ['Only top-level network posture is checked in this slice.']),
    coverageItem('google_compute_router', ['Cloud Router exists', 'Region', 'Network'], [], ['BGP runtime state is intentionally excluded from Terraform drift.']),
    coverageItem('google_compute_router_nat', ['Cloud NAT exists', 'Region', 'Router', 'IP allocation mode'], [], ['NAT address reservations are validated separately through global addresses.']),
    coverageItem('google_compute_subnetwork', ['Subnet exists', 'Region', 'Network', 'CIDR range', 'Private Google access'], [], ['Secondary ranges and flow logs are out of scope for this slice.']),
    coverageItem('google_container_cluster', ['Cluster exists', 'Location', 'Release channel when declared', 'Inline node pool min/max sizing when declared'], [], ['Control-plane runtime version changes are not treated as Terraform drift.']),
    coverageItem('google_container_node_pool', ['Node pool exists', 'Desired size when fixed', 'Autoscaling min/max'], [], ['Desired size is compared only for non-autoscaled pools to avoid flagging autoscaler runtime behavior as drift.']),
    coverageItem('google_service_networking_connection', ['Private service connection exists', 'Reserved peering ranges'], [], ['The service endpoint is validated against Service Networking connections on the target VPC.']),
    coverageItem('google_storage_bucket', ['Bucket exists', 'Location', 'Storage class', 'Versioning', 'Uniform bucket-level access'], [], ['Lifecycle rules and IAM are out of scope for this slice.']),
    coverageItem('google_sql_database', ['Database exists', 'Charset', 'Collation'], [], ['Databases are resolved against their parent Cloud SQL instance.']),
    coverageItem('google_sql_database_instance', ['Instance exists', 'Region', 'Database version', 'Availability type', 'Deletion protection'], [], ['Flags only fields that are typically set directly in Terraform.']),
    coverageItem('google_sql_user', ['User exists', 'Host', 'Type'], [], ['Passwords and IAM auth wiring are intentionally excluded from drift output.']),
    coverageItem('google_pubsub_topic', ['Topic exists', 'Message retention duration', 'KMS key name'], [], ['Labels and schema settings are tracked when set in Terraform.']),
    coverageItem('google_pubsub_subscription', ['Subscription exists', 'Topic binding', 'Ack deadline', 'Message retention', 'Push endpoint', 'Filter', 'Exactly-once delivery'], [], ['Dead-letter policy and retry policy are out of scope for this slice.']),
    coverageItem('google_bigquery_dataset', ['Dataset exists', 'Location', 'Friendly name'], [], ['Access controls and default table expiration are out of scope for this slice.']),
    coverageItem('google_bigquery_table', ['Table exists', 'Type'], [], ['Schema and partition configuration are out of scope for this slice.']),
    coverageItem('google_monitoring_alert_policy', ['Alert policy exists', 'Enabled state', 'Condition count'], [], ['Condition details and notification channels are not individually compared.']),
    coverageItem('google_monitoring_uptime_check_config', ['Uptime check exists', 'Protocol', 'Period', 'Timeout'], [], ['Selected regions and content matchers are out of scope for this slice.']),
    coverageItem('google_firestore_database', ['Database exists', 'Location', 'Type', 'Concurrency mode', 'Delete protection'], [], ['Index and field configurations are managed by separate resource types.']),
    coverageItem('google_cloud_run_service', ['Service exists', 'Location'], [], ['Container image and traffic configuration are out of scope for this slice. GCP API responses may lag due to eventual consistency.']),
    coverageItem('google_dns_managed_zone', ['Zone exists', 'DNS name', 'Visibility'], [], ['Record sets and DNSSEC configuration are managed by separate resource types.'])
  ]

  return items.sort((left, right) => left.resourceType.localeCompare(right.resourceType))
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

/**
 * Per-unit Terragrunt drift reporter for GCP. Pulls the unit's state, substitutes it
 * into a copy of the stack-level project, then delegates to the shared drift logic.
 *
 * Factored out as a separate function from `getGcpTerraformDriftReport` because
 * esbuild's whole-program DCE was aggressively eliminating the unit-override branch
 * when it observed other callers (observability, polymorphic provider) passing only
 * 3 args — it concluded `unitPathOverride` was always undefined and stripped the
 * substitution code. Making `unitPath` a required param here blocks that inference.
 */
export async function getGcpTerragruntUnitDriftReport(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  unitPath: string,
  preloadedInventory: TerragruntUnitInventoryResult | null
): Promise<TerraformDriftReport> {
  const baseProject = await getProject(profileName, projectId)
  const pulled = preloadedInventory ?? await loadTerragruntUnitInventory(profileName, projectId, connection, unitPath)
  if (pulled.error) {
    throw new Error(pulled.error)
  }
  let hasManaged = false
  for (const item of pulled.inventory) {
    if (item.mode === 'managed') { hasManaged = true; break }
  }
  if (!hasManaged) {
    throw new Error([
      `State pull for ${unitPath} returned no managed resources.`,
      `stateSource=${pulled.stateSource || '(empty)'}, rawBytes=${pulled.rawStateJson.length}.`,
      'If the unit was applied successfully, the state object exists but parsing dropped every resource — share this message so it can be fixed.',
      'If the unit was never applied, run `terragrunt apply` on it first.'
    ].join('\n'))
  }
  const project: TerraformProject = {
    ...baseProject,
    inventory: pulled.inventory,
    stateAddresses: pulled.stateAddresses,
    rawStateJson: pulled.rawStateJson,
    stateSource: pulled.stateSource || baseProject.stateSource
  }
  return runGcpDriftReport(profileName, project, connection, unitPath)
}

export async function getGcpTerraformDriftReport(
  profileName: string,
  projectId: string,
  connection?: AwsConnection,
  _options?: { forceRefresh?: boolean }
): Promise<TerraformDriftReport> {
  const baseProject = await getProject(profileName, projectId)
  // loadProject only reads local state files. For terragrunt projects with a remote backend
  // (GCS / TFC / cloud) baseProject.inventory is empty, which makes every live GCP resource
  // look `unmanaged_in_aws`. Pull state explicitly: unit projects throw loud on failure so
  // the UI shows a real error; stacks aggregate across all discovered units and tolerate
  // per-unit failures.
  const project: TerraformProject = baseProject.kind === 'terragrunt-unit'
    ? await (async () => {
        const pulled = await loadTerragruntUnitInventory(profileName, projectId, connection, baseProject.rootPath)
        if (pulled.error) throw new Error(pulled.error)
        return {
          ...baseProject,
          inventory: pulled.inventory,
          stateAddresses: pulled.stateAddresses,
          rawStateJson: pulled.rawStateJson,
          stateSource: pulled.stateSource || baseProject.stateSource
        }
      })()
    : baseProject.kind === 'terragrunt-stack'
      ? { ...baseProject, inventory: await enrichTerragruntProjectInventory(profileName, connection, baseProject) }
      : baseProject
  return runGcpDriftReport(profileName, project, connection)
}

async function runGcpDriftReport(
  profileName: string,
  project: TerraformProject,
  connection: AwsConnection | undefined,
  unitScopeLabel: string = ''
): Promise<TerraformDriftReport> {
  const auditCtx = createTraceContext({
    operation: 'drift-report',
    provider: 'gcp',
    module: project.name
  })
  return withAudit(auditCtx, async () => {
  const context = parseGcpContext(profileName, project, connection)
  if (!context.projectId) {
    throw new Error('Choose a GCP project context before loading Terraform drift.')
  }

  const { data: live, errors } = await loadLiveData(context)
  const items: TerraformDriftItem[] = []
  const coverage = buildSupportedCoverage()
  const managedInventory = project.inventory.filter((item) => item.mode === 'managed')
  const sqlInstanceTargets = unique(managedInventory
    .filter((item) => item.type === 'google_sql_database' || item.type === 'google_sql_user')
    .map((item) => resolveSqlInstanceName(item))
    .filter(Boolean))
  const serviceNetworkingTargets = unique(managedInventory
    .filter((item) => item.type === 'google_service_networking_connection')
    .map((item) => normalizeResourceBasename(str(item.values.network)))
    .filter(Boolean))
  const gkeNodePoolTargets = new Map<string, { location: string; clusterName: string }>()
  const computeDetailTargets = new Map<string, { zone: string; name: string }>()
  const sqlDetailTargets = new Map<string, string>()
  const gkeDetailTargets = new Map<string, { location: string; clusterName: string }>()

  for (const item of managedInventory) {
    if (item.type !== 'google_container_cluster' && item.type !== 'google_container_node_pool') {
      if (item.type === 'google_compute_instance') {
        const zone = normalizeResourceBasename(str(item.values.zone))
        const name = str(item.values.name) || item.name
        if (zone && name) {
          computeDetailTargets.set(recordKey(zone, name), { zone, name })
        }
      }

      if (item.type === 'google_sql_database_instance') {
        const name = str(item.values.name) || item.name
        if (name) {
          sqlDetailTargets.set(name.toLowerCase(), name)
        }
      }

      continue
    }

    const clusterName = gkeClusterName(item)
    const location = gkeClusterLocation(item, context)
    if (!clusterName || !location) {
      continue
    }

    gkeNodePoolTargets.set(gkeNodePoolKey(location, clusterName), { location, clusterName })
    gkeDetailTargets.set(gkeNodePoolKey(location, clusterName), { location, clusterName })
  }

  if (sqlInstanceTargets.length > 0) {
    try {
      live.sqlDatabases = await listGcpSqlDatabasesForInstances(context.projectId, sqlInstanceTargets)
    } catch (error) {
      errors.sqlDatabases = error instanceof Error ? error.message : String(error)
    }

    try {
      live.sqlUsers = await listGcpSqlUsers(context.projectId, sqlInstanceTargets)
    } catch (error) {
      errors.sqlUsers = error instanceof Error ? error.message : String(error)
    }
  }

  if (serviceNetworkingTargets.length > 0) {
    try {
      live.serviceNetworkingConnections = await listGcpServiceNetworkingConnections(context.projectId, serviceNetworkingTargets)
    } catch (error) {
      errors.serviceNetworkingConnections = error instanceof Error ? error.message : String(error)
    }
  }

  if (gkeNodePoolTargets.size > 0) {
    live.gkeNodePoolsByCluster = {}
    await Promise.all([...gkeNodePoolTargets.entries()].map(async ([key, target]) => {
      try {
        live.gkeNodePoolsByCluster![key] = await listGcpGkeNodePools(context.projectId, target.location, target.clusterName)
      } catch (error) {
        errors.gkeNodePoolsByCluster = error instanceof Error ? error.message : String(error)
      }
    }))
  }

  if (computeDetailTargets.size > 0) {
    live.computeInstanceDetails = {}
    await Promise.all([...computeDetailTargets.entries()].map(async ([key, target]) => {
      try {
        live.computeInstanceDetails![key] = await getGcpComputeInstanceDetail(context.projectId, target.zone, target.name)
      } catch (error) {
        errors.computeInstanceDetails = error instanceof Error ? error.message : String(error)
      }
    }))
  }

  if (sqlDetailTargets.size > 0) {
    live.sqlInstanceDetails = {}
    await Promise.all([...sqlDetailTargets.entries()].map(async ([key, name]) => {
      try {
        live.sqlInstanceDetails![key] = await getGcpSqlInstanceDetail(context.projectId, name)
      } catch (error) {
        errors.sqlInstanceDetails = error instanceof Error ? error.message : String(error)
      }
    }))
  }

  if (gkeDetailTargets.size > 0) {
    live.gkeClusterDetails = {}
    await Promise.all([...gkeDetailTargets.entries()].map(async ([key, target]) => {
      try {
        live.gkeClusterDetails![key] = await getGcpGkeClusterDetail(context.projectId, target.location, target.clusterName)
      } catch (error) {
        errors.gkeClusterDetails = error instanceof Error ? error.message : String(error)
      }
    }))
  }

  const bigqueryTableTargets = unique(managedInventory
    .filter((item) => item.type === 'google_bigquery_table')
    .map((item) => str(item.values.dataset_id))
    .filter(Boolean))
  if (bigqueryTableTargets.length > 0) {
    live.bigqueryTablesByDataset = {}
    await Promise.all(bigqueryTableTargets.map(async (datasetId) => {
      try {
        live.bigqueryTablesByDataset![datasetId.toLowerCase()] = await listGcpBigQueryTables(context.projectId, datasetId)
      } catch (error) {
        errors.bigqueryTablesByDataset = error instanceof Error ? error.message : String(error)
      }
    }))
  }

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
        if (errors.enabledApis) {
          items.push(unsupportedItem(item, context, `Enabled API inventory could not be loaded: ${errors.enabledApis}`))
          break
        }
        const serviceName = str(item.values.service) || str(item.values.service_name) || item.name
        const enabled = (live.enabledApis ?? []).some((entry) => entry.name === serviceName)
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
        if (errors.serviceAccounts) {
          items.push(unsupportedItem(item, context, `IAM service account inventory could not be loaded: ${errors.serviceAccounts}`))
          break
        }
        const accountId = str(item.values.account_id)
        const email = str(item.values.email) || (accountId ? `${accountId}@${context.projectId}.iam.gserviceaccount.com` : '')
        const match = (live.serviceAccounts ?? []).find((entry) => entry.email === email)
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
      case 'google_compute_firewall': {
        if (errors.firewallRules) {
          items.push(unsupportedItem(item, context, `Firewall inventory could not be loaded: ${errors.firewallRules}`))
          break
        }
        const name = str(item.values.name) || item.name
        const liveFirewall = (live.firewallRules ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'network', 'Network', normalizeResourceBasename(str(item.values.network)), str(liveFirewall?.network))
        compareValues(differences, 'direction', 'Direction', str(item.values.direction), str(liveFirewall?.direction))
        compareValues(differences, 'priority', 'Priority', str(item.values.priority), str(liveFirewall?.priority))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveFirewall),
          cloudIdentifier: name,
          explanation: liveFirewall
            ? differences.length > 0
              ? 'The live firewall rule differs from the Terraform network posture.'
              : 'The live firewall rule matches the tracked Terraform attributes.'
            : 'Terraform tracks a firewall rule that is not present in the live VPC inventory.',
          evidence: liveFirewall ? unique([liveFirewall.network ? `Network: ${liveFirewall.network}` : '', liveFirewall.direction ? `Direction: ${liveFirewall.direction}` : '']).filter(Boolean) : [],
          differences
        }))
        break
      }
      case 'google_compute_global_address': {
        if (errors.globalAddresses) {
          items.push(unsupportedItem(item, context, `Global address inventory could not be loaded: ${errors.globalAddresses}`))
          break
        }
        const name = str(item.values.name) || item.name
        const liveAddress = (live.globalAddresses ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'addressType', 'Address Type', str(item.values.address_type), str(liveAddress?.addressType))
        compareValues(differences, 'purpose', 'Purpose', str(item.values.purpose), str(liveAddress?.purpose))
        compareValues(differences, 'prefixLength', 'Prefix Length', str(item.values.prefix_length), str(liveAddress?.prefixLength))
        compareValues(differences, 'network', 'Network', normalizeResourceBasename(str(item.values.network)), str(liveAddress?.network))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveAddress),
          cloudIdentifier: liveAddress?.address || name,
          explanation: liveAddress
            ? differences.length > 0
              ? 'The live global address differs from the Terraform reservation posture.'
              : 'The live global address matches the Terraform reservation.'
            : 'Terraform tracks a global address that is not present in the live project.',
          evidence: unique([liveAddress?.address ? `Address: ${liveAddress.address}` : '', liveAddress?.purpose ? `Purpose: ${liveAddress.purpose}` : '']).filter(Boolean),
          differences
        }))
        break
      }
      case 'google_compute_network': {
        if (errors.networks) {
          items.push(unsupportedItem(item, context, `VPC network inventory could not be loaded: ${errors.networks}`))
          break
        }
        const name = str(item.values.name) || item.name
        const liveNetwork = (live.networks ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        if (typeof getPathValue(item.values, ['auto_create_subnetworks']) === 'boolean') {
          compareValues(differences, 'autoCreateSubnetworks', 'Auto Create Subnetworks', String(bool(item.values.auto_create_subnetworks)), String(Boolean(liveNetwork?.autoCreateSubnetworks)))
        }
        compareValues(differences, 'routingMode', 'Routing Mode', str(item.values.routing_mode), str(liveNetwork?.routingMode))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveNetwork),
          cloudIdentifier: name,
          explanation: liveNetwork
            ? differences.length > 0
              ? 'The live VPC network differs from the Terraform network posture.'
              : 'The live VPC network matches the tracked Terraform attributes.'
            : 'Terraform tracks a VPC network that is not present in the live project.',
          differences
        }))
        break
      }
      case 'google_compute_subnetwork': {
        if (errors.subnetworks) {
          items.push(unsupportedItem(item, context, `Subnetwork inventory could not be loaded: ${errors.subnetworks}`))
          break
        }
        const name = str(item.values.name) || item.name
        const region = normalizeResourceBasename(str(item.values.region))
        const liveSubnetwork = (live.subnetworks ?? []).find((entry) => entry.name === name && (!region || entry.region === region))
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'region', 'Region', region, str(liveSubnetwork?.region))
        compareValues(differences, 'network', 'Network', normalizeResourceBasename(str(item.values.network)), str(liveSubnetwork?.network))
        compareValues(differences, 'ipCidrRange', 'CIDR Range', str(item.values.ip_cidr_range), str(liveSubnetwork?.ipCidrRange))
        if (typeof getPathValue(item.values, ['private_ip_google_access']) === 'boolean') {
          compareValues(differences, 'privateIpGoogleAccess', 'Private Google Access', String(bool(item.values.private_ip_google_access)), String(Boolean(liveSubnetwork?.privateIpGoogleAccess)))
        }
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveSubnetwork),
          cloudIdentifier: name,
          region: liveSubnetwork?.region || region || context.location,
          explanation: liveSubnetwork
            ? differences.length > 0
              ? 'The live subnet differs from the Terraform network posture.'
              : 'The live subnet matches the tracked Terraform attributes.'
            : 'Terraform tracks a subnet that is not present in the live project.',
          differences
        }))
        break
      }
      case 'google_compute_router': {
        if (errors.routers) {
          items.push(unsupportedItem(item, context, `Cloud Router inventory could not be loaded: ${errors.routers}`))
          break
        }
        const name = str(item.values.name) || item.name
        const region = normalizeResourceBasename(str(item.values.region))
        const liveRouter = (live.routers?.routers ?? []).find((entry) => entry.name === name && (!region || entry.region === region))
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'region', 'Region', region, str(liveRouter?.region))
        compareValues(differences, 'network', 'Network', normalizeResourceBasename(str(item.values.network)), str(liveRouter?.network))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveRouter),
          cloudIdentifier: name,
          region: liveRouter?.region || region || context.location,
          explanation: liveRouter
            ? differences.length > 0
              ? 'The live Cloud Router differs from the Terraform network attachment.'
              : 'The live Cloud Router matches the tracked Terraform attributes.'
            : 'Terraform tracks a Cloud Router that is not present in the live project.',
          differences
        }))
        break
      }
      case 'google_compute_router_nat': {
        if (errors.routers) {
          items.push(unsupportedItem(item, context, `Cloud NAT inventory could not be loaded: ${errors.routers}`))
          break
        }
        const name = str(item.values.name) || item.name
        const routerName = normalizeResourceBasename(str(item.values.router))
        const region = normalizeResourceBasename(str(item.values.region))
        const liveNat = (live.routers?.nats ?? []).find((entry) => entry.name === name && (!routerName || entry.router === routerName) && (!region || entry.region === region))
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'router', 'Router', routerName, str(liveNat?.router))
        compareValues(differences, 'region', 'Region', region, str(liveNat?.region))
        compareValues(differences, 'natIpAllocateOption', 'IP Allocation Mode', str(item.values.nat_ip_allocate_option), str(liveNat?.natIpAllocateOption))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveNat),
          cloudIdentifier: name,
          region: liveNat?.region || region || context.location,
          explanation: liveNat
            ? differences.length > 0
              ? 'The live Cloud NAT differs from the Terraform router attachment or IP allocation mode.'
              : 'The live Cloud NAT matches the tracked Terraform attributes.'
            : 'Terraform tracks a Cloud NAT that is not present in the live project.',
          differences
        }))
        break
      }
      case 'google_compute_instance': {
        if (errors.computeInstances || errors.computeInstanceDetails) {
          items.push(unsupportedItem(item, context, `Compute Engine inventory could not be loaded: ${errors.computeInstances || errors.computeInstanceDetails}`))
          break
        }
        const name = str(item.values.name) || item.name
        const zone = normalizeResourceBasename(str(item.values.zone))
        const liveInstance = (live.computeInstances ?? []).find((entry) => entry.name === name)
        const liveDetail = live.computeInstanceDetails?.[recordKey(zone || liveInstance?.zone || '', name)] ?? null
        const differences: TerraformDriftDifference[] = []
        // Runtime status comparison. `current_status` is what terraform recorded at the last
        // refresh; `desired_status` is the user-set target. If the live instance has been
        // stopped/terminated out-of-band, this is where that shows up as drift.
        const stateStatus = str(item.values.current_status) || str(item.values.desired_status)
        if (stateStatus || liveInstance?.status) {
          compareValues(differences, 'status', 'Status', stateStatus, str(liveInstance?.status))
        }
        compareValues(differences, 'zone', 'Zone', zone, str(liveInstance?.zone))
        compareValues(differences, 'machineType', 'Machine Type', normalizeResourceBasename(str(item.values.machine_type)), str(liveInstance?.machineType))
        compareValues(differences, 'network', 'Network', normalizeResourceBasename(str(getPathValue(item.values, ['network_interface', 0, 'network']))), str(liveDetail?.networks[0]?.network))
        compareValues(differences, 'subnetwork', 'Subnetwork', normalizeResourceBasename(str(getPathValue(item.values, ['network_interface', 0, 'subnetwork']))), str(liveDetail?.networks[0]?.subnetwork))
        compareValues(differences, 'internalIp', 'Internal IP', str(getPathValue(item.values, ['network_interface', 0, 'network_ip'])), str(liveDetail?.internalIp))
        compareValues(differences, 'externalIp', 'External IP', str(getPathValue(item.values, ['network_interface', 0, 'access_config', 0, 'nat_ip'])), str(liveDetail?.externalIp))
        compareBooleanPath(differences, item.values, ['can_ip_forward'], 'canIpForward', 'Can IP Forward', Boolean(liveDetail?.canIpForward))
        compareBooleanPath(differences, item.values, ['deletion_protection'], 'deletionProtection', 'Deletion Protection', Boolean(liveDetail?.deletionProtection))
        compareBooleanPath(differences, item.values, ['shielded_instance_config', 0, 'enable_secure_boot'], 'shieldedSecureBoot', 'Shielded Secure Boot', Boolean(liveDetail?.shieldedSecureBoot))
        compareBooleanPath(differences, item.values, ['shielded_instance_config', 0, 'enable_vtpm'], 'shieldedVtpm', 'Shielded vTPM', Boolean(liveDetail?.shieldedVtpm))
        compareBooleanPath(differences, item.values, ['shielded_instance_config', 0, 'enable_integrity_monitoring'], 'shieldedIntegrityMonitoring', 'Shielded Integrity Monitoring', Boolean(liveDetail?.shieldedIntegrityMonitoring))
        compareSortedLists(differences, 'tags', 'Network Tags', stringList(getPathValue(item.values, ['tags'])).sort(), liveDetail?.tags ?? [])
        compareStringMaps(differences, 'labels', 'Labels', normalizeComparableGcpLabelMap(getPathValue(item.values, ['labels'])), normalizeComparableGcpLabelMap(Object.fromEntries((liveDetail?.labels ?? []).map((entry) => [entry.key, entry.value]))))
        compareStringMaps(differences, 'metadata', 'Metadata', normalizeStringMap(getPathValue(item.values, ['metadata'])), Object.fromEntries((liveDetail?.metadata ?? []).map((entry) => [entry.key, entry.value])))
        compareValues(differences, 'serviceAccountEmail', 'Service Account', str(getPathValue(item.values, ['service_account', 0, 'email'])), str(liveDetail?.serviceAccounts[0]?.email))
        compareSortedLists(differences, 'serviceAccountScopes', 'Service Account Scopes', stringList(getPathValue(item.values, ['service_account', 0, 'scopes'])).sort(), [...(liveDetail?.serviceAccounts[0]?.scopes ?? [])].sort())
        compareValues(differences, 'bootDiskSizeGb', 'Boot Disk Size (GB)', str(getPathValue(item.values, ['boot_disk', 0, 'initialize_params', 0, 'size'])), str(liveDetail?.disks.find((entry) => entry.boot)?.sizeGb))
        compareBooleanPath(differences, item.values, ['boot_disk', 0, 'auto_delete'], 'bootDiskAutoDelete', 'Boot Disk Auto Delete', Boolean(liveDetail?.disks.find((entry) => entry.boot)?.autoDelete))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveInstance),
          cloudIdentifier: name,
          region: liveInstance?.zone || zone,
          explanation: liveInstance
            ? differences.length > 0
              ? 'The live VM differs from the Terraform-declared instance configuration.'
              : 'The live VM matches the tracked Terraform attributes.'
            : 'Terraform tracks a VM that is not present in the live Compute Engine inventory.',
          evidence: unique([liveInstance?.status ? `Status: ${liveInstance.status}` : '', liveDetail?.cpuPlatform ? `CPU platform: ${liveDetail.cpuPlatform}` : '', liveInstance?.internalIp ? `Internal IP: ${liveInstance.internalIp}` : '', liveInstance?.externalIp ? `External IP: ${liveInstance.externalIp}` : '']).filter(Boolean),
          differences
        }))
        break
      }
      case 'google_container_cluster': {
        if (errors.gkeClusters || errors.gkeNodePoolsByCluster || errors.gkeClusterDetails) {
          items.push(unsupportedItem(item, context, `GKE cluster inventory could not be loaded: ${errors.gkeClusters || errors.gkeNodePoolsByCluster || errors.gkeClusterDetails}`))
          break
        }
        const name = str(item.values.name) || item.name
        const location = gkeClusterLocation(item, context)
        const liveCluster = (live.gkeClusters ?? []).find((entry) => entry.name === name)
        const liveDetail = live.gkeClusterDetails?.[gkeNodePoolKey(location, name)]
        const liveNodePools = live.gkeNodePoolsByCluster?.[gkeNodePoolKey(location, name)] ?? []
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'location', 'Location', location, str(liveCluster?.location))
        const releaseChannel = str(getPathValue(item.values, ['release_channel', 0, 'channel'])) || str(item.values.release_channel)
        compareValues(differences, 'releaseChannel', 'Release Channel', releaseChannel, str(liveCluster?.releaseChannel))
        compareValues(differences, 'network', 'Network', normalizeResourceBasename(str(item.values.network)), normalizeResourceBasename(str(liveDetail?.network)))
        compareValues(differences, 'subnetwork', 'Subnetwork', normalizeResourceBasename(str(item.values.subnetwork)), normalizeResourceBasename(str(liveDetail?.subnetwork)))
        compareValues(differences, 'workloadIdentityPool', 'Workload Identity Pool', str(getPathValue(item.values, ['workload_identity_config', 0, 'workload_pool'])), str(liveDetail?.workloadIdentityPool))
        compareBooleanPath(differences, item.values, ['private_cluster_config', 0, 'enable_private_nodes'], 'privateClusterEnabled', 'Private Nodes', Boolean(liveDetail?.privateClusterEnabled))
        compareBooleanPath(differences, item.values, ['shielded_nodes', 0, 'enabled'], 'shieldedNodesEnabled', 'Shielded Nodes', Boolean(liveDetail?.shieldedNodesEnabled))
        compareBooleanPath(differences, item.values, ['vertical_pod_autoscaling', 0, 'enabled'], 'verticalPodAutoscalingEnabled', 'Vertical Pod Autoscaling', Boolean(liveDetail?.verticalPodAutoscalingEnabled))
        compareBooleanPath(differences, item.values, ['enable_autopilot'], 'autopilotEnabled', 'Autopilot', Boolean(liveDetail?.autopilotEnabled))
        compareValues(differences, 'loggingService', 'Logging Service', str(item.values.logging_service), str(liveDetail?.loggingService))
        compareValues(differences, 'monitoringService', 'Monitoring Service', str(item.values.monitoring_service), str(liveDetail?.monitoringService))
        compareValues(differences, 'clusterIpv4Cidr', 'Cluster IPv4 CIDR', str(item.values.cluster_ipv4_cidr), str(liveDetail?.clusterIpv4Cidr))
        compareValues(differences, 'servicesIpv4Cidr', 'Services IPv4 CIDR', str(item.values.services_ipv4_cidr), str(liveDetail?.servicesIpv4Cidr))
        compareStringMaps(differences, 'resourceLabels', 'Resource Labels', normalizeComparableGcpLabelMap(getPathValue(item.values, ['resource_labels'])), normalizeComparableGcpLabelMap(liveDetail?.resourceLabels ?? {}))
        compareGkeNodePoolSpecs(differences, buildTerraformGkeNodePoolSpecs(item, context), liveNodePools)
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
      case 'google_container_node_pool': {
        if (errors.gkeNodePoolsByCluster) {
          items.push(unsupportedItem(item, context, `GKE node pool inventory could not be loaded: ${errors.gkeNodePoolsByCluster}`))
          break
        }
        const name = str(item.values.name) || item.name
        const clusterName = gkeClusterName(item)
        const location = gkeClusterLocation(item, context)
        const liveNodePool = (live.gkeNodePoolsByCluster?.[gkeNodePoolKey(location, clusterName)] ?? []).find((entry) => entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareGkeNodePoolSpecs(differences, buildTerraformGkeNodePoolSpecs(item, context), liveNodePool ? [liveNodePool] : [])
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveNodePool),
          cloudIdentifier: `${clusterName}/${name}`,
          region: location,
          explanation: liveNodePool
            ? differences.length > 0
              ? 'The live GKE node pool sizing differs from Terraform.'
              : 'The live GKE node pool sizing matches Terraform.'
            : 'Terraform tracks a GKE node pool that is not present in the live cluster.',
          evidence: liveNodePool ? unique([
            liveNodePool.autoscaling ? `Autoscaling: ${liveNodePool.autoscaling}` : '',
            liveNodePool.nodeCount >= 0 ? `Desired size: ${liveNodePool.nodeCount}` : ''
          ].filter(Boolean)) : [],
          differences
        }))
        break
      }
      case 'google_service_networking_connection': {
        if (errors.serviceNetworkingConnections) {
          items.push(unsupportedItem(item, context, `Private service connection inventory could not be loaded: ${errors.serviceNetworkingConnections}`))
          break
        }
        const networkName = normalizeResourceBasename(str(item.values.network))
        const reservedRanges = sortedStringList(item.values.reserved_peering_ranges)
        const liveConnection = (live.serviceNetworkingConnections ?? []).find((entry) => entry.network === networkName)
        const differences: TerraformDriftDifference[] = []
        compareSortedLists(differences, 'reservedPeeringRanges', 'Reserved Peering Ranges', reservedRanges, liveConnection?.reservedPeeringRanges ?? [])
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveConnection),
          cloudIdentifier: `${networkName}:${liveConnection?.service || 'servicenetworking.googleapis.com'}`,
          explanation: liveConnection
            ? differences.length > 0
              ? 'The private service networking connection differs from the Terraform-declared reserved ranges.'
              : 'The private service networking connection matches the tracked Terraform attributes.'
            : 'Terraform expects a private service networking connection that is not visible on the target VPC.',
          evidence: unique([liveConnection?.service ? `Service: ${liveConnection.service}` : '', liveConnection?.peering ? `Peering: ${liveConnection.peering}` : '']).filter(Boolean),
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
        if (errors.sqlInstances || errors.sqlInstanceDetails) {
          items.push(unsupportedItem(item, context, `Cloud SQL inventory could not be loaded: ${errors.sqlInstances || errors.sqlInstanceDetails}`))
          break
        }
        const name = str(item.values.name) || item.name
        const liveSql = (live.sqlInstances ?? []).find((entry) => entry.name === name)
        const liveDetail = live.sqlInstanceDetails?.[name.toLowerCase()]
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'region', 'Region', str(item.values.region), str(liveSql?.region))
        compareValues(differences, 'databaseVersion', 'Database Version', str(item.values.database_version), str(liveSql?.databaseVersion))
        compareValues(differences, 'availabilityType', 'Availability Type', str(getPathValue(item.values, ['settings', 0, 'availability_type'])), str(liveSql?.availabilityType))
        const deletionProtection = getPathValue(item.values, ['deletion_protection']) ?? getPathValue(item.values, ['deletion_protection_enabled'])
        if (typeof deletionProtection === 'boolean') {
          compareValues(differences, 'deletionProtection', 'Deletion Protection', String(deletionProtection), String(Boolean(liveSql?.deletionProtectionEnabled)))
        }
        compareValues(differences, 'diskSizeGb', 'Disk Size (GB)', toNumberString(getPathValue(item.values, ['settings', 0, 'disk_size'])), str(liveDetail?.diskSizeGb))
        compareBooleanPath(differences, item.values, ['settings', 0, 'disk_autoresize'], 'storageAutoResizeEnabled', 'Storage Auto Resize', Boolean(liveDetail?.storageAutoResizeEnabled))
        compareValues(differences, 'diskType', 'Disk Type', str(getPathValue(item.values, ['settings', 0, 'disk_type'])), str(liveDetail?.diskType))
        compareValues(differences, 'activationPolicy', 'Activation Policy', str(getPathValue(item.values, ['settings', 0, 'activation_policy'])), str(liveDetail?.activationPolicy))
        compareValues(differences, 'pricingPlan', 'Pricing Plan', str(getPathValue(item.values, ['settings', 0, 'pricing_plan'])), str(liveDetail?.pricingPlan))
        compareValues(differences, 'connectorEnforcement', 'Connector Enforcement', str(getPathValue(item.values, ['settings', 0, 'connector_enforcement'])), str(liveDetail?.connectorEnforcement))
        compareValues(differences, 'sslMode', 'SSL Mode', str(getPathValue(item.values, ['settings', 0, 'ip_configuration', 0, 'ssl_mode'])), str(liveDetail?.sslMode))
        compareBooleanPath(differences, item.values, ['settings', 0, 'backup_configuration', 0, 'enabled'], 'backupEnabled', 'Backups Enabled', Boolean(liveDetail?.backupEnabled))
        compareBooleanPath(differences, item.values, ['settings', 0, 'backup_configuration', 0, 'binary_log_enabled'], 'binaryLogEnabled', 'Binary Log Enabled', Boolean(liveDetail?.binaryLogEnabled))
        compareBooleanPath(differences, item.values, ['settings', 0, 'backup_configuration', 0, 'point_in_time_recovery_enabled'], 'pointInTimeRecoveryEnabled', 'Point In Time Recovery', Boolean(liveDetail?.pointInTimeRecoveryEnabled))
        compareSortedLists(differences, 'authorizedNetworks', 'Authorized Networks', extractAuthorizedNetworks(getPathValue(item.values, ['settings', 0, 'ip_configuration', 0, 'authorized_networks'])), [...(liveDetail?.authorizedNetworks ?? [])].sort())
        const ipv4Enabled = getPathValue(item.values, ['settings', 0, 'ip_configuration', 0, 'ipv4_enabled'])
        if (typeof ipv4Enabled === 'boolean') {
          compareValues(differences, 'publicIpEnabled', 'Public IPv4', String(ipv4Enabled), String(Boolean(liveDetail?.primaryAddress)))
        }
        const privateNetwork = str(getPathValue(item.values, ['settings', 0, 'ip_configuration', 0, 'private_network']))
        if (privateNetwork) {
          compareValues(differences, 'privateNetworkAttached', 'Private Network Attached', 'true', String(Boolean(liveDetail?.privateAddress)))
        }
        compareValues(differences, 'primaryAddress', 'Primary Address', str(getPathValue(item.values, ['first_ip_address'])), str(liveDetail?.primaryAddress))
        compareValues(differences, 'privateAddress', 'Private Address', str(getPathValue(item.values, ['private_ip_address'])), str(liveDetail?.privateAddress))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveSql),
          cloudIdentifier: name,
          region: liveSql?.region || str(item.values.region) || context.location,
          explanation: liveSql
            ? differences.length > 0
              ? 'The live Cloud SQL instance differs from the Terraform-declared database posture.'
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
      case 'google_sql_database': {
        if (errors.sqlDatabases) {
          items.push(unsupportedItem(item, context, `Cloud SQL database inventory could not be loaded: ${errors.sqlDatabases}`))
          break
        }
        const name = str(item.values.name) || item.name
        const instanceName = resolveSqlInstanceName(item)
        const liveDatabase = (live.sqlDatabases ?? []).find((entry) => entry.instance === instanceName && entry.name === name)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'charset', 'Charset', str(item.values.charset), str(liveDatabase?.charset))
        compareValues(differences, 'collation', 'Collation', str(item.values.collation), str(liveDatabase?.collation))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveDatabase),
          cloudIdentifier: `${instanceName}/${name}`,
          region: instanceName || context.location,
          explanation: liveDatabase
            ? differences.length > 0
              ? 'The live Cloud SQL database differs from the Terraform-declared charset or collation.'
              : 'The live Cloud SQL database matches the tracked Terraform attributes.'
            : 'Terraform tracks a Cloud SQL database that is not present on the target instance.',
          differences
        }))
        break
      }
      case 'google_sql_user': {
        if (errors.sqlUsers) {
          items.push(unsupportedItem(item, context, `Cloud SQL user inventory could not be loaded: ${errors.sqlUsers}`))
          break
        }
        const name = str(item.values.name) || item.name
        const host = str(item.values.host)
        const instanceName = resolveSqlInstanceName(item)
        const liveUser = (live.sqlUsers ?? []).find((entry) => entry.instance === instanceName && entry.name === name && (!host || entry.host === host))
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'host', 'Host', host, str(liveUser?.host))
        compareValues(differences, 'type', 'Type', str(item.values.type), str(liveUser?.type))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveUser),
          cloudIdentifier: `${instanceName}/${name}${host ? `@${host}` : ''}`,
          region: instanceName || context.location,
          explanation: liveUser
            ? differences.length > 0
              ? 'The live Cloud SQL user differs from the Terraform host or type.'
              : 'The live Cloud SQL user matches the tracked Terraform attributes.'
            : 'Terraform tracks a Cloud SQL user that is not present on the target instance.',
          differences
        }))
        break
      }
      case 'google_pubsub_topic': {
        if (errors.pubsubTopics) {
          items.push(unsupportedItem(item, context, `Pub/Sub topics could not be loaded: ${errors.pubsubTopics}`))
          break
        }
        const topicName = str(item.values.name) || item.name
        const liveTopic = (live.pubsubTopics ?? []).find((entry) => entry.topicId === topicName || entry.name.endsWith(`/${topicName}`))
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'messageRetentionDuration', 'Message Retention Duration', str(item.values.message_retention_duration), str(liveTopic?.messageRetentionDuration))
        compareValues(differences, 'kmsKeyName', 'KMS Key Name', str(item.values.kms_key_name), str(liveTopic?.kmsKeyName))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveTopic),
          cloudIdentifier: liveTopic?.topicId || topicName,
          explanation: liveTopic
            ? differences.length > 0
              ? 'The live Pub/Sub topic differs from the Terraform configuration.'
              : 'The live Pub/Sub topic matches the tracked Terraform attributes.'
            : 'Terraform tracks a Pub/Sub topic that is not present in the live inventory.',
          evidence: liveTopic?.schemaSettings ? [`Schema: ${liveTopic.schemaSettings}`] : [],
          differences
        }))
        break
      }
      case 'google_pubsub_subscription': {
        if (errors.pubsubSubscriptions) {
          items.push(unsupportedItem(item, context, `Pub/Sub subscriptions could not be loaded: ${errors.pubsubSubscriptions}`))
          break
        }
        const subName = str(item.values.name) || item.name
        const liveSub = (live.pubsubSubscriptions ?? []).find((entry) => entry.subscriptionId === subName || entry.name.endsWith(`/${subName}`))
        const differences: TerraformDriftDifference[] = []
        const tfTopic = normalizeResourceBasename(str(item.values.topic))
        const liveTopic = liveSub?.topicId || normalizeResourceBasename(str(liveSub?.topic))
        compareValues(differences, 'topic', 'Topic', tfTopic, liveTopic)
        compareValues(differences, 'ackDeadlineSeconds', 'Ack Deadline', str(item.values.ack_deadline_seconds), String(liveSub?.ackDeadlineSeconds ?? ''))
        compareValues(differences, 'messageRetentionDuration', 'Message Retention Duration', str(item.values.message_retention_duration), str(liveSub?.messageRetentionDuration))
        compareValues(differences, 'filter', 'Filter', str(item.values.filter), str(liveSub?.filter))
        if (typeof item.values.enable_exactly_once_delivery === 'boolean') {
          compareValues(differences, 'enableExactlyOnceDelivery', 'Exactly-Once Delivery', String(item.values.enable_exactly_once_delivery), String(Boolean(liveSub?.enableExactlyOnceDelivery)))
        }
        const tfPushEndpoint = str(getPathValue(item.values, ['push_config', 0, 'push_endpoint']))
        if (tfPushEndpoint || liveSub?.pushEndpoint) {
          compareValues(differences, 'pushEndpoint', 'Push Endpoint', tfPushEndpoint, str(liveSub?.pushEndpoint))
        }
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveSub),
          cloudIdentifier: liveSub?.subscriptionId || subName,
          explanation: liveSub
            ? differences.length > 0
              ? 'The live Pub/Sub subscription differs from the Terraform configuration.'
              : 'The live Pub/Sub subscription matches the tracked Terraform attributes.'
            : 'Terraform tracks a Pub/Sub subscription that is not present in the live inventory.',
          evidence: unique([
            liveSub?.deliveryType ? `Delivery: ${liveSub.deliveryType}` : '',
            liveSub?.state ? `State: ${liveSub.state}` : ''
          ].filter(Boolean)),
          differences
        }))
        break
      }
      case 'google_bigquery_dataset': {
        if (errors.bigqueryDatasets) {
          items.push(unsupportedItem(item, context, `BigQuery datasets could not be loaded: ${errors.bigqueryDatasets}`))
          break
        }
        const datasetId = str(item.values.dataset_id) || item.name
        const liveDataset = (live.bigqueryDatasets ?? []).find((entry) => entry.datasetId === datasetId)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'location', 'Location', str(item.values.location), str(liveDataset?.location))
        compareValues(differences, 'friendlyName', 'Friendly Name', str(item.values.friendly_name), str(liveDataset?.friendlyName))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveDataset),
          cloudIdentifier: datasetId,
          region: liveDataset?.location || context.location,
          explanation: liveDataset
            ? differences.length > 0
              ? 'The live BigQuery dataset differs from the Terraform configuration.'
              : 'The live BigQuery dataset matches the tracked Terraform attributes.'
            : 'Terraform tracks a BigQuery dataset that is not present in the live inventory.',
          evidence: liveDataset ? [`Tables: ${liveDataset.tableCount}`] : [],
          differences
        }))
        break
      }
      case 'google_bigquery_table': {
        if (errors.bigqueryTablesByDataset) {
          items.push(unsupportedItem(item, context, `BigQuery tables could not be loaded: ${errors.bigqueryTablesByDataset}`))
          break
        }
        const tableId = str(item.values.table_id) || item.name
        const tableDatasetId = str(item.values.dataset_id)
        const liveTables = live.bigqueryTablesByDataset?.[tableDatasetId.toLowerCase()] ?? []
        const liveTable = liveTables.find((entry) => entry.tableId === tableId)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'type', 'Table Type', str(item.values.type) || 'TABLE', str(liveTable?.type))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveTable),
          cloudIdentifier: `${tableDatasetId}.${tableId}`,
          explanation: liveTable
            ? differences.length > 0
              ? 'The live BigQuery table differs from the Terraform configuration.'
              : 'The live BigQuery table matches the tracked Terraform attributes.'
            : 'Terraform tracks a BigQuery table that is not present in the live inventory.',
          evidence: liveTable ? [`Rows: ${liveTable.rowCount}`, `Size: ${liveTable.sizeBytes} bytes`] : [],
          differences
        }))
        break
      }
      case 'google_monitoring_alert_policy': {
        if (errors.monitoringAlertPolicies) {
          items.push(unsupportedItem(item, context, `Monitoring alert policies could not be loaded: ${errors.monitoringAlertPolicies}`))
          break
        }
        const policyDisplayName = str(item.values.display_name) || item.name
        const livePolicy = (live.monitoringAlertPolicies ?? []).find((entry) => entry.displayName === policyDisplayName)
        const differences: TerraformDriftDifference[] = []
        if (typeof item.values.enabled === 'boolean') {
          compareValues(differences, 'enabled', 'Enabled', String(item.values.enabled), String(Boolean(livePolicy?.enabled)))
        }
        const tfConditionCount = Array.isArray(item.values.conditions) ? item.values.conditions.length : 0
        if (livePolicy && tfConditionCount > 0) {
          compareValues(differences, 'conditionCount', 'Condition Count', String(tfConditionCount), String(livePolicy.conditionCount))
        }
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(livePolicy),
          cloudIdentifier: livePolicy?.name || policyDisplayName,
          explanation: livePolicy
            ? differences.length > 0
              ? 'The live monitoring alert policy differs from the Terraform configuration.'
              : 'The live monitoring alert policy matches the tracked Terraform attributes.'
            : 'Terraform tracks a monitoring alert policy that is not present in the live inventory.',
          evidence: livePolicy ? [`Combiner: ${livePolicy.combiner}`, `Notification channels: ${livePolicy.notificationChannelCount}`] : [],
          differences
        }))
        break
      }
      case 'google_monitoring_uptime_check_config': {
        if (errors.monitoringUptimeChecks) {
          items.push(unsupportedItem(item, context, `Monitoring uptime checks could not be loaded: ${errors.monitoringUptimeChecks}`))
          break
        }
        const checkDisplayName = str(item.values.display_name) || item.name
        const liveCheck = (live.monitoringUptimeChecks ?? []).find((entry) => entry.displayName === checkDisplayName)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'period', 'Period', str(item.values.period), str(liveCheck?.period))
        compareValues(differences, 'timeout', 'Timeout', str(item.values.timeout), str(liveCheck?.timeout))
        const tfProtocol = str(getPathValue(item.values, ['http_check']) ? 'HTTP' : getPathValue(item.values, ['tcp_check']) ? 'TCP' : '')
        if (tfProtocol) {
          compareValues(differences, 'protocol', 'Protocol', tfProtocol, str(liveCheck?.protocol))
        }
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveCheck),
          cloudIdentifier: liveCheck?.name || checkDisplayName,
          explanation: liveCheck
            ? differences.length > 0
              ? 'The live uptime check differs from the Terraform configuration.'
              : 'The live uptime check matches the tracked Terraform attributes.'
            : 'Terraform tracks an uptime check that is not present in the live inventory.',
          evidence: liveCheck ? [
            `Monitored resource: ${liveCheck.monitoredResource}`,
            `Regions: ${liveCheck.selectedRegions.join(', ') || 'default'}`
          ] : [],
          differences
        }))
        break
      }
      case 'google_firestore_database': {
        if (errors.firestoreDatabases) {
          items.push(unsupportedItem(item, context, `Firestore databases could not be loaded: ${errors.firestoreDatabases}`))
          break
        }
        const dbName = str(item.values.name) || item.name || '(default)'
        const liveDb = (live.firestoreDatabases ?? []).find((entry) => {
          const liveName = entry.name.split('/').pop() || entry.name
          return liveName === dbName
        })
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'locationId', 'Location', str(item.values.location_id), str(liveDb?.locationId))
        compareValues(differences, 'type', 'Database Type', str(item.values.type), str(liveDb?.type))
        compareValues(differences, 'concurrencyMode', 'Concurrency Mode', str(item.values.concurrency_mode), str(liveDb?.concurrencyMode))
        compareValues(differences, 'deleteProtectionState', 'Delete Protection', str(item.values.delete_protection_state), str(liveDb?.deleteProtectionState))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveDb),
          cloudIdentifier: liveDb?.uid || dbName,
          region: liveDb?.locationId || context.location,
          explanation: liveDb
            ? differences.length > 0
              ? 'The live Firestore database differs from the Terraform configuration.'
              : 'The live Firestore database matches the tracked Terraform attributes.'
            : 'Terraform tracks a Firestore database that is not present in the live inventory.',
          differences
        }))
        break
      }
      case 'google_cloud_run_service': {
        if (errors.cloudRunServices) {
          items.push(unsupportedItem(item, context, `Cloud Run services could not be loaded: ${errors.cloudRunServices}`))
          break
        }
        const runName = str(item.values.name) || item.name
        const liveService = (live.cloudRunServices ?? []).find((entry) => entry.name === runName)
        const differences: TerraformDriftDifference[] = []
        const liveLocation = liveService?.name ? (liveService.name.split('/')[3] || '') : ''
        compareValues(differences, 'location', 'Location', str(item.values.location), liveLocation)
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveService),
          cloudIdentifier: liveService?.name || runName,
          region: liveLocation || context.location,
          explanation: liveService
            ? differences.length > 0
              ? 'The live Cloud Run service differs from the Terraform configuration.'
              : 'The live Cloud Run service matches the tracked Terraform attributes.'
            : 'Terraform tracks a Cloud Run service that is not present in the live inventory.',
          differences
        }))
        break
      }
      case 'google_dns_managed_zone': {
        if (errors.dnsManagedZones) {
          items.push(unsupportedItem(item, context, `DNS managed zones could not be loaded: ${errors.dnsManagedZones}`))
          break
        }
        const zoneName = str(item.values.name) || item.name
        const liveZone = (live.dnsManagedZones ?? []).find((entry) => entry.name === zoneName)
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'dnsName', 'DNS Name', str(item.values.dns_name), str(liveZone?.dnsName))
        compareValues(differences, 'visibility', 'Visibility', str(item.values.visibility), str(liveZone?.visibility))
        items.push(buildTerraformItem(item, context, {
          exists: Boolean(liveZone),
          cloudIdentifier: liveZone?.name || zoneName,
          region: context.location,
          explanation: liveZone
            ? differences.length > 0
              ? 'The live DNS managed zone differs from the Terraform configuration.'
              : 'The live DNS managed zone matches the tracked Terraform attributes.'
            : 'Terraform tracks a DNS managed zone that is not present in the live inventory.',
          differences
        }))
        break
      }
      default:
        items.push(unsupportedItem(item, context, 'Live drift coverage for this Google resource type has not been implemented yet.'))
    }
  }

  // For a per-unit Terragrunt drift scan, skip the project-wide "unmanaged" sweep entirely.
  // A single unit only owns a slice of the project; everything else (other units, other
  // Terraform projects, manually-created resources) would get falsely flagged as unmanaged
  // from this unit's perspective. Only surface unmanaged items for project-wide scans where
  // the inventory actually represents the full Terraform footprint.
  if (!unitScopeLabel) {
    const managedAddressSet = new Set(managedInventory.map((item) => `${item.type}:${str(item.values.name) || str(item.values.account_id) || item.name}`))
    const managedClusterNames = managedInventory
      .filter((item) => item.type === 'google_container_cluster')
      .map((item) => str(item.values.name) || item.name)
      .filter(Boolean)
    for (const entry of live.computeInstances ?? []) {
      if (isManagedGkeNodeInstance(entry.name, managedClusterNames)) {
        continue
      }
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
    for (const entry of live.serviceAccounts ?? []) {
      if (shouldIgnoreUnmanagedServiceAccount(entry.email, entry.displayName)) {
        continue
      }
      const emailKey = `google_service_account:${entry.email}`
      const accountKey = `google_service_account:${entry.email.split('@')[0] || entry.email}`
      if (!managedAddressSet.has(emailKey) && !managedAddressSet.has(accountKey)) {
        items.push(buildUnmanagedItem('google_service_account', entry.displayName || entry.email, entry.email, context.location, context, [`Disabled: ${entry.disabled ? 'yes' : 'no'}`], 'A live service account exists without a matching Terraform-managed service account resource.'))
      }
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
    projectId: project.id,
    projectName: project.name,
    profileName,
    region: context.location,
    summary: snapshot.summary,
    items,
    history: buildHistory([snapshot]),
    fromCache: false
  }
  }, (report, auditSummary) => ({ ...report, audit: auditSummary }))
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
  const baseProject = await getProject(profileName, projectId)
  // Observability scoring counts which resource types are present (hasResource, inventoryText).
  // An empty inventory from loadProject (terragrunt + remote backend) would produce a misleading
  // "no logging / no monitoring / no telemetry" report. Enrich from unit state before scoring.
  const project: TerraformProject = (baseProject.kind === 'terragrunt-unit' || baseProject.kind === 'terragrunt-stack')
    ? { ...baseProject, inventory: await enrichTerragruntProjectInventory(profileName, connection, baseProject) }
    : baseProject
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
