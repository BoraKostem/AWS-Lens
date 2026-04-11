import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog } from 'electron'
import { google } from 'googleapis'

import { logWarn } from './observability'
import {
  GCP_SDK_SCOPES,
  MAX_PAGINATION_PAGES,
  paginationGuard,
  getGcpAuth,
  classifyGcpError,
  outputIndicatesApiDisabled,
  requestGcp,
  type GcpRequestOptions
} from './gcp/client'

import type {
  GcpBillingCapabilityHint,
  GcpBillingLinkedProjectSummary,
  GcpBillingOverview,
  GcpComputeInstanceAction,
  GcpComputeInstanceDetail,
  GcpBillingOwnershipHint,
  GcpBillingOwnershipValue,
  GcpBillingSpendBreakdownEntry,
  GcpBillingSpendTelemetry,
  GcpComputeMachineTypeOption,
  GcpComputeOperationResult,
  GcpComputeSerialOutput,
  GcpEnabledApiSummary,
  GcpFirewallRuleSummary,
  GcpGlobalAddressSummary,
  GcpIamBindingSummary,
  GcpIamCapabilityHint,
  GcpIamOverview,
  GcpIamPrincipalSummary,
  GcpComputeInstanceSummary,
  GcpGkeClusterCredentials,
  GcpGkeClusterDetail,
  GcpGkeOperationResult,
  GcpGkeOperationSummary,
  GcpLogEntryDetail,
  GcpGkeClusterSummary,
  GcpGkeNodePoolSummary,
  GcpLogEntrySummary,
  GcpLogFacetCount,
  GcpLogQueryResult,
  GcpNetworkSummary,
  GcpProjectCapabilityHint,
  GcpProjectOverview,
  GcpRouterNatSummary,
  GcpRouterSummary,
  GcpServiceAccountSummary,
  GcpServiceNetworkingConnectionSummary,
  GcpSqlDatabaseSummary,
  GcpSqlInstanceDetail,
  GcpSqlInstanceSummary,
  GcpSqlOperationSummary,
  GcpStorageBucketSummary,
  GcpStorageObjectContent,
  GcpStorageObjectSummary,
  GcpSubnetworkSummary,
  GcpServiceAccountKeySummary,
  GcpIamRoleSummary,
  GcpIamTestPermissionsResult,
  GcpDnsManagedZoneSummary,
  GcpDnsResourceRecordSetSummary,
  GcpDnsRecordUpsertInput,
  GcpMemorystoreInstanceSummary,
  GcpMemorystoreInstanceDetail,
  GcpUrlMapSummary,
  GcpUrlMapDetail,
  GcpBackendServiceSummary,
  GcpForwardingRuleSummary,
  GcpHealthCheckSummary,
  GcpSecurityPolicySummary,
  GcpSecurityPolicyDetail
} from '@shared/types'

// GCP_SDK_SCOPES is now imported from './gcp/client'
const GCP_REGION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+\d$/
const GCP_ZONE_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+\d-[a-z]$/
const GCP_BILLING_OWNERSHIP_KEYS = ['owner', 'team', 'cost-center', 'cost_center', 'environment', 'env', 'application', 'app', 'service']
const GCP_HIGH_PRIVILEGE_ROLE_MARKERS = [
  'roles/owner',
  'roles/editor',
  'roles/resourcemanager.projectIamAdmin',
  'roles/iam.securityAdmin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountTokenCreator'
]
const GCP_PROJECT_CORE_API_HINTS = [
  { name: 'compute.googleapis.com', title: 'Compute Engine API' },
  { name: 'container.googleapis.com', title: 'GKE API' },
  { name: 'storage.googleapis.com', title: 'Cloud Storage API' },
  { name: 'sqladmin.googleapis.com', title: 'Cloud SQL Admin API' },
  { name: 'logging.googleapis.com', title: 'Cloud Logging API' },
  { name: 'cloudbilling.googleapis.com', title: 'Cloud Billing API' },
  { name: 'bigquery.googleapis.com', title: 'BigQuery API' },
  { name: 'monitoring.googleapis.com', title: 'Cloud Monitoring API' },
  { name: 'securitycenter.googleapis.com', title: 'Security Command Center API' },
  { name: 'firestore.googleapis.com', title: 'Cloud Firestore API' },
  { name: 'pubsub.googleapis.com', title: 'Pub/Sub API' },
  { name: 'run.googleapis.com', title: 'Cloud Run Admin API' },
  { name: 'firebase.googleapis.com', title: 'Firebase Management API' },
  { name: 'firebasehosting.googleapis.com', title: 'Firebase Hosting API' },
  { name: 'redis.googleapis.com', title: 'Memorystore for Redis API' }
]

type GcpBillingProjectRecord = {
  projectId: string
  name: string
  projectNumber: string
  lifecycleState: string
  labelCount: number
  labels: Record<string, string>
  billingEnabled: boolean
  billingAccountName: string
}

type GcpStorageObjectRecord = {
  key: string
  size: number
  lastModified: string
  storageClass: string
}

type GcpSqlScopedDatabaseSummary = {
  instance: string
  name: string
  charset: string
  collation: string
}

type GcpSqlUserSummary = {
  instance: string
  name: string
  host: string
  type: string
}

// GcpRequestOptions type is now imported from './gcp/client'

type GcpBigQueryDatasetRecord = {
  projectId: string
  datasetId: string
  location: string
}

type GcpBigQueryExportTableRecord = {
  projectId: string
  datasetId: string
  tableId: string
  location: string
  priority: number
}

type GcpBigQuerySchemaField = {
  name: string
  fields: GcpBigQuerySchemaField[]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === '1' || normalized === 'enabled'
  }

  if (typeof value === 'number') {
    return value !== 0
  }

  return false
}

function normalizeNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => asString(item))
    .filter(Boolean)
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.trim(), asString(item)])
      .filter((entry) => entry[0] && entry[1])
  )
}

function maskSecret(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= 12) {
    return normalized
  }

  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`
}

function quoteYamlScalar(value: string): string {
  return JSON.stringify(value)
}

function buildGkeContextName(projectId: string, location: string, clusterName: string): string {
  return `gke_${projectId.trim()}_${location.trim()}_${clusterName.trim()}`
}

function buildGkeKubeconfigYaml(contextName: string, endpoint: string, certificateAuthorityData: string, bearerToken: string): string {
  const lines = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    `- name: ${quoteYamlScalar(contextName)}`,
    '  cluster:',
    `    server: ${quoteYamlScalar(`https://${endpoint}`)}`
  ]

  if (certificateAuthorityData.trim()) {
    lines.push(`    certificate-authority-data: ${quoteYamlScalar(certificateAuthorityData.trim())}`)
  }

  lines.push(
    'contexts:',
    `- name: ${quoteYamlScalar(contextName)}`,
    '  context:',
    `    cluster: ${quoteYamlScalar(contextName)}`,
    `    user: ${quoteYamlScalar(contextName)}`,
    `current-context: ${quoteYamlScalar(contextName)}`,
    'users:',
    `- name: ${quoteYamlScalar(contextName)}`,
    '  user:',
    `    token: ${quoteYamlScalar(bearerToken)}`
  )

  return `${lines.join('\n')}\n`
}

function buildContainerApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://container.googleapis.com/v1/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

function formatMaintenanceWindow(value: unknown): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const recurringWindow = record.recurringWindow && typeof record.recurringWindow === 'object'
    ? record.recurringWindow as Record<string, unknown>
    : {}
  const windowRecord = recurringWindow.window && typeof recurringWindow.window === 'object'
    ? recurringWindow.window as Record<string, unknown>
    : {}
  const startTime = asString(windowRecord.startTime)
  const endTime = asString(windowRecord.endTime)
  const recurrence = asString(recurringWindow.recurrence)
  const dailyWindow = record.dailyMaintenanceWindow && typeof record.dailyMaintenanceWindow === 'object'
    ? record.dailyMaintenanceWindow as Record<string, unknown>
    : {}
  const dailyStart = asString(dailyWindow.startTime)

  if (startTime || endTime || recurrence) {
    return [startTime && endTime ? `${startTime} -> ${endTime}` : startTime || endTime, recurrence]
      .filter(Boolean)
      .join(' | ')
  }

  return dailyStart ? `Daily at ${dailyStart}` : ''
}

function normalizeMaintenanceExclusions(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return []
  }

  return Object.entries(value as Record<string, unknown>)
    .map(([name, raw]) => {
      const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const windowRecord = record.startTime || record.endTime
        ? record
        : record.maintenanceExclusionWindow && typeof record.maintenanceExclusionWindow === 'object'
          ? record.maintenanceExclusionWindow as Record<string, unknown>
          : {}
      const startTime = asString(windowRecord.startTime)
      const endTime = asString(windowRecord.endTime)
      const scope = record.exclusionOptions && typeof record.exclusionOptions === 'object'
        ? asString((record.exclusionOptions as Record<string, unknown>).scope)
        : ''
      const summary = [name.trim(), startTime && endTime ? `${startTime} -> ${endTime}` : startTime || endTime, scope].filter(Boolean).join(' | ')
      return summary
    })
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
}

function extractGkeOperationError(operation: unknown): string {
  const record = operation && typeof operation === 'object' ? operation as Record<string, unknown> : {}
  const statusMessage = asString(record.statusMessage)
  if (statusMessage) {
    return statusMessage
  }

  const errorRecord = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
  const message = asString(errorRecord.message)
  if (message) {
    return message
  }

  const details = Array.isArray(errorRecord.details) ? errorRecord.details : []
  return details
    .map((entry) => {
      const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      return asString(item.message) || asString(item.details)
    })
    .filter(Boolean)
    .join(' | ')
}

function titleFromApiName(value: string): string {
  const normalized = value.trim().replace(/\.googleapis\.com$/, '')
  if (!normalized) {
    return ''
  }

  return normalized
    .split('.')
    .flatMap((segment) => segment.split('-'))
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

function isGcpHighPrivilegeRole(role: string): boolean {
  const normalized = role.trim()
  if (!normalized) {
    return false
  }

  return GCP_HIGH_PRIVILEGE_ROLE_MARKERS.includes(normalized)
    || /(^|\/)(.*admin.*)$/i.test(normalized)
}

function isGcpPublicPrincipal(member: string): boolean {
  const normalized = member.trim()
  return normalized === 'allUsers' || normalized === 'allAuthenticatedUsers'
}

// Error classification functions (outputIndicatesApiDisabled, outputIndicatesAdcIssue,
// outputIndicatesPermissionIssue, extractProjectIdFromOutput, buildGcpSdkError) have been
// centralised into src/main/gcp/client.ts as classifyGcpError().
// Alias for backward compatibility within this file:
const buildGcpSdkError = classifyGcpError

// getGcpAuth() and requestGcp() are now imported from './gcp/client' with LRU
// pooling and automatic retry for transient failures (429, 503).

function buildStorageApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://storage.googleapis.com${pathname}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

function buildComputeApiUrl(projectId: string, pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const normalizedPath = pathname.replace(/^\/+/, '')
  const url = new URL(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(projectId)}/${normalizedPath}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

function buildBigQueryApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

function encodeStorageObjectKey(value: string): string {
  return encodeURIComponent(value.trim())
}

function asBuffer(value: ArrayBuffer | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(value)) {
    return value
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }

  return Buffer.from(value)
}

function resourceBasename(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) {
    return ''
  }

  const segments = normalized.split('/')
  return segments[segments.length - 1] ?? normalized
}

function normalizeBucketName(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  return normalized.replace(/^gs:\/\//i, '').replace(/\/+$/, '')
}

function normalizeStorageBucket(entry: unknown): GcpStorageBucketSummary | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const iamConfiguration = (record.iamConfiguration && typeof record.iamConfiguration === 'object'
    ? record.iamConfiguration
    : {}) as Record<string, unknown>
  const uniformBucketLevelAccess = (iamConfiguration.uniformBucketLevelAccess && typeof iamConfiguration.uniformBucketLevelAccess === 'object'
    ? iamConfiguration.uniformBucketLevelAccess
    : {}) as Record<string, unknown>
  const versioning = (record.versioning && typeof record.versioning === 'object'
    ? record.versioning
    : {}) as Record<string, unknown>
  const labels = record.labels && typeof record.labels === 'object'
    ? Object.keys(record.labels as Record<string, unknown>)
    : []
  const name = normalizeBucketName(asString(record.name))

  if (!name) {
    return null
  }

  return {
    name,
    location: asString(record.location),
    locationType: asString(record.locationType),
    storageClass: asString(record.storageClass),
    publicAccessPrevention: asString(iamConfiguration.publicAccessPrevention),
    versioningEnabled: asBoolean(versioning.enabled),
    uniformBucketLevelAccessEnabled: asBoolean(uniformBucketLevelAccess.enabled),
    labelCount: labels.length
  }
}

function normalizeFirewallRule(entry: unknown): GcpFirewallRuleSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    network: resourceBasename(asString(record.network)),
    direction: asString(record.direction),
    priority: asString(record.priority)
  }
}

function normalizeNetwork(entry: unknown): GcpNetworkSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  const routingConfig = toRecord(record.routingConfig)
  return {
    name,
    autoCreateSubnetworks: asBoolean(record.autoCreateSubnetworks ?? record.auto_create_subnetworks),
    routingMode: asString(routingConfig.routingMode ?? record.routing_mode)
  }
}

function normalizeSubnetwork(entry: unknown): GcpSubnetworkSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    region: resourceBasename(asString(record.region)),
    network: resourceBasename(asString(record.network)),
    ipCidrRange: asString(record.ipCidrRange ?? record.ip_cidr_range),
    privateIpGoogleAccess: asBoolean(record.privateIpGoogleAccess ?? record.private_ip_google_access)
  }
}

function normalizeRouter(entry: unknown): GcpRouterSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    region: resourceBasename(asString(record.region)),
    network: resourceBasename(asString(record.network))
  }
}

function normalizeRouterNat(entry: unknown, routerName: string, region: string): GcpRouterNatSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    region,
    router: routerName,
    natIpAllocateOption: asString(record.natIpAllocateOption ?? record.nat_ip_allocate_option)
  }
}

function normalizeGlobalAddress(entry: unknown): GcpGlobalAddressSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    address: asString(record.address),
    addressType: asString(record.addressType ?? record.address_type),
    purpose: asString(record.purpose),
    network: resourceBasename(asString(record.network)),
    prefixLength: asString(record.prefixLength ?? record.prefix_length)
  }
}

function normalizeServiceNetworkingConnection(entry: unknown, networkName: string): GcpServiceNetworkingConnectionSummary | null {
  const record = toRecord(entry)
  const service = asString(record.service)
  if (!service) {
    return null
  }

  return {
    network: networkName,
    service,
    peering: asString(record.peering),
    reservedPeeringRanges: [...new Set(asStringArray(record.reservedPeeringRanges ?? record.reserved_peering_ranges).map((item) => resourceBasename(item)).filter(Boolean))].sort()
  }
}

function normalizeScopedSqlDatabase(entry: unknown, instance: string): GcpSqlScopedDatabaseSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    instance,
    name,
    charset: asString(record.charset),
    collation: asString(record.collation)
  }
}

function normalizeSqlUser(entry: unknown, instance: string): GcpSqlUserSummary | null {
  const record = toRecord(entry)
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    instance,
    name,
    host: asString(record.host),
    type: asString(record.type)
  }
}

function normalizeStorageObjectRecord(entry: unknown, bucketName: string): GcpStorageObjectRecord | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const key = normalizeBucketName(asString(record.name)).replace(new RegExp(`^${bucketName}/`), '')
  if (!key) {
    return null
  }

  return {
    key,
    size: normalizeNumber(record.size),
    lastModified: asString(record.updated) || asString(record.timeCreated),
    storageClass: asString(record.storageClass)
  }
}

function buildGcpStorageObjectSummaries(records: GcpStorageObjectRecord[], prefix: string): GcpStorageObjectSummary[] {
  const normalizedPrefix = prefix.trim()
  const folders = new Map<string, GcpStorageObjectSummary>()
  const files = new Map<string, GcpStorageObjectSummary>()

  for (const record of records) {
    const key = record.key.trim()
    if (!key || (normalizedPrefix && !key.startsWith(normalizedPrefix))) {
      continue
    }

    const suffix = normalizedPrefix ? key.slice(normalizedPrefix.length) : key
    if (!suffix) {
      continue
    }

    const slashIndex = suffix.indexOf('/')
    if (slashIndex >= 0) {
      const folderKey = `${normalizedPrefix}${suffix.slice(0, slashIndex + 1)}`
      if (!folders.has(folderKey)) {
        folders.set(folderKey, {
          key: folderKey,
          size: 0,
          lastModified: '-',
          storageClass: '-',
          isFolder: true
        })
      }
      continue
    }

    files.set(key, {
      key,
      size: record.size,
      lastModified: record.lastModified || '-',
      storageClass: record.storageClass || '-',
      isFolder: false
    })
  }

  return [
    ...[...folders.values()].sort((left, right) => left.key.localeCompare(right.key)),
    ...[...files.values()].sort((left, right) => left.key.localeCompare(right.key))
  ]
}

function guessContentTypeFromKey(key: string): string {
  const extension = path.extname(key).toLowerCase()

  switch (extension) {
    case '.json':
      return 'application/json'
    case '.txt':
    case '.log':
    case '.md':
    case '.tf':
    case '.tfvars':
    case '.yaml':
    case '.yml':
    case '.ini':
    case '.cfg':
    case '.conf':
      return 'text/plain'
    case '.csv':
      return 'text/csv'
    case '.html':
    case '.htm':
      return 'text/html'
    case '.css':
      return 'text/css'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript'
    case '.ts':
    case '.tsx':
      return 'text/typescript'
    case '.xml':
      return 'application/xml'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'text/plain'
  }
}

function formatSqlMaintenanceWindow(day: unknown, hour: unknown): string {
  const hourText = typeof hour === 'number' ? `${String(hour).padStart(2, '0')}:00 UTC` : ''
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const dayText = typeof day === 'number' && day >= 1 && day <= 7 ? dayNames[day - 1] : ''
  if (dayText && hourText) return `${dayText} ${hourText}`
  return dayText || hourText
}

function normalizeSqlInstance(entry: unknown): GcpSqlInstanceSummary | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const settings = (record.settings && typeof record.settings === 'object' ? record.settings : {}) as Record<string, unknown>
  const ipAddresses = Array.isArray(record.ipAddresses) ? record.ipAddresses as Array<Record<string, unknown>> : []
  const maintenanceWindow = (settings.maintenanceWindow && typeof settings.maintenanceWindow === 'object' ? settings.maintenanceWindow : {}) as Record<string, unknown>
  const publicIp = ipAddresses.find((item) => asString(item.type).toUpperCase() === 'PRIMARY')
    ?? ipAddresses.find((item) => {
      const type = asString(item.type).toUpperCase()
      return !type || type === 'OUTGOING'
    })
    ?? ipAddresses[0]
    ?? null
  const privateIp = ipAddresses.find((item) => asString(item.type).toUpperCase() === 'PRIVATE') ?? null
  const name = asString(record.name)

  if (!name) {
    return null
  }

  return {
    name,
    region: asString(record.region),
    zone: asString(record.gceZone),
    state: asString(record.state),
    databaseVersion: asString(record.databaseVersion),
    availabilityType: asString(settings.availabilityType),
    primaryAddress: publicIp ? asString(publicIp.ipAddress) : '',
    privateAddress: privateIp ? asString(privateIp.ipAddress) : '',
    storageAutoResizeEnabled: asBoolean(settings.storageAutoResize),
    diskSizeGb: asString(settings.dataDiskSizeGb),
    deletionProtectionEnabled: asBoolean(record.deletionProtectionEnabled),
    maintenanceWindow: formatSqlMaintenanceWindow(maintenanceWindow.day, maintenanceWindow.hour)
  }
}

function normalizeAuthorizedNetworks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return ''
      }

      const record = entry as Record<string, unknown>
      const name = asString(record.name)
      const cidr = asString(record.value)
      const expirationTime = asString(record.expirationTime)
      const parts = [name, cidr].filter(Boolean)
      const label = parts.join(' ').trim()

      return expirationTime
        ? `${label || cidr || 'network'} (expires ${expirationTime})`
        : (label || cidr)
    })
    .filter(Boolean)
}

function normalizeSqlInstanceDetail(entry: unknown): GcpSqlInstanceDetail | null {
  const summary = normalizeSqlInstance(entry)
  if (!summary || !entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const settings = (record.settings && typeof record.settings === 'object' ? record.settings : {}) as Record<string, unknown>
  const backupConfiguration = (settings.backupConfiguration && typeof settings.backupConfiguration === 'object'
    ? settings.backupConfiguration
    : {}) as Record<string, unknown>
  const ipConfiguration = (settings.ipConfiguration && typeof settings.ipConfiguration === 'object'
    ? settings.ipConfiguration
    : {}) as Record<string, unknown>

  return {
    ...summary,
    activationPolicy: asString(settings.activationPolicy),
    pricingPlan: asString(settings.pricingPlan),
    diskType: asString(settings.dataDiskType),
    connectorEnforcement: asString(settings.connectorEnforcement),
    sslMode: asString(settings.sslMode),
    backupEnabled: asBoolean(backupConfiguration.enabled),
    binaryLogEnabled: asBoolean(backupConfiguration.binaryLogEnabled),
    pointInTimeRecoveryEnabled: asBoolean(backupConfiguration.pointInTimeRecoveryEnabled),
    authorizedNetworks: normalizeAuthorizedNetworks(ipConfiguration.authorizedNetworks)
  }
}

function normalizeSqlDatabase(entry: unknown): GcpSqlDatabaseSummary | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    charset: asString(record.charset),
    collation: asString(record.collation)
  }
}

function normalizeSqlOperation(entry: unknown): GcpSqlOperationSummary | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const errors = (record.error && typeof record.error === 'object'
    ? (record.error as Record<string, unknown>).errors
    : []) as Array<Record<string, unknown>>
  const id = asString(record.name) || asString(record.operation) || asString(record.id)

  if (!id) {
    return null
  }

  return {
    id,
    operationType: asString(record.operationType),
    status: asString(record.status),
    targetId: asString(record.targetId) || asString(record.targetLink),
    targetProject: asString(record.targetProject),
    user: asString(record.user),
    insertTime: asString(record.insertTime),
    endTime: asString(record.endTime),
    error: errors
      .map((item) => [asString(item.code), asString(item.message)].filter(Boolean).join(': '))
      .filter(Boolean)
      .join(' | ')
  }
}

function stringifyLogPayload(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (!value || typeof value !== 'object') {
    return ''
  }

  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function joinLogSummaryParts(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' | ')
}

function buildLogDetailsFromPayload(payload: unknown): GcpLogEntryDetail[] {
  const record = toRecord(payload)
  if (!Object.keys(record).length) {
    return []
  }

  const authenticationInfo = toRecord(record.authenticationInfo)
  const requestMetadata = toRecord(record.requestMetadata)
  const status = toRecord(record.status)
  const location = joinLogSummaryParts([
    asString(record.location),
    asString(record.region),
    asString(record.zone)
  ])

  return [
    { label: 'Method', value: asString(record.methodName) },
    { label: 'Actor', value: asString(authenticationInfo.principalEmail) },
    { label: 'Resource', value: asString(record.resourceName) },
    { label: 'Service', value: asString(record.serviceName) },
    { label: 'Status', value: asString(status.message) },
    { label: 'Caller IP', value: asString(requestMetadata.callerIp) },
    { label: 'Location', value: location },
    { label: 'Agent', value: asString(requestMetadata.callerSuppliedUserAgent) },
    { label: 'Message', value: asString(record.message) || asString(record.eventMessage) || asString(record.description) }
  ].filter((detail) => detail.value.trim())
}

function buildStructuredPayloadSummary(payload: unknown): string {
  const details = buildLogDetailsFromPayload(payload)
  if (details.length) {
    return joinLogSummaryParts(
      details
        .filter((detail) => detail.label !== 'Agent')
        .slice(0, 4)
        .map((detail) => `${detail.label}: ${detail.value}`)
    )
  }

  const record = toRecord(payload)
  if (!Object.keys(record).length) {
    return ''
  }

  const flattened = Object.entries(record)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value.trim() : stringifyLogPayload(value)
      return text ? `${key}: ${text}` : ''
    })
    .filter(Boolean)
    .slice(0, 4)

  return joinLogSummaryParts(flattened)
}

function buildLogDetails(entry: Record<string, unknown>): GcpLogEntryDetail[] {
  const details = [
    ...buildLogDetailsFromPayload(entry.jsonPayload),
    ...buildLogDetailsFromPayload(entry.protoPayload)
  ]

  const seen = new Set<string>()
  const deduped = details.filter((detail) => {
    const key = `${detail.label}:${detail.value}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })

  if (deduped.length) {
    return deduped.slice(0, 6)
  }

  const textPayload = asString(entry.textPayload)
  return textPayload ? [{ label: 'Text payload', value: textPayload }] : []
}

function summarizeLogName(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return 'Unknown log'
  }

  const decoded = normalized.replace(/^projects\/[^/]+\/logs\//, '')
  try {
    return decodeURIComponent(decoded)
  } catch {
    return decoded
  }
}

function buildLogSummary(entry: Record<string, unknown>): string {
  const candidates = [
    asString(entry.textPayload),
    buildStructuredPayloadSummary(entry.jsonPayload),
    buildStructuredPayloadSummary(entry.protoPayload),
    stringifyLogPayload(entry.jsonPayload),
    stringifyLogPayload(entry.protoPayload)
  ].filter(Boolean)

  const summary = candidates[0] ?? ''
  return summary.length > 280 ? `${summary.slice(0, 277)}...` : summary
}

function normalizeLogEntry(entry: unknown): GcpLogEntrySummary | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const resource = (record.resource && typeof record.resource === 'object'
    ? record.resource
    : {}) as Record<string, unknown>
  const insertId = asString(record.insertId)
  const timestamp = asString(record.timestamp) || asString(record.receiveTimestamp)
  const severity = asString(record.severity) || 'DEFAULT'
  const resourceType = asString(resource.type) || 'global'
  const logName = summarizeLogName(asString(record.logName))
  const summary = buildLogSummary(record)
  const details = buildLogDetails(record)

  if (!insertId && !timestamp && !summary) {
    return null
  }

  return {
    insertId: insertId || `${timestamp}:${logName}`,
    timestamp,
    severity,
    resourceType,
    logName,
    summary: summary || 'Structured log entry without preview text.',
    details
  }
}

function toFacetCounts(values: string[]): GcpLogFacetCount[] {
  const counts = new Map<string, number>()

  for (const value of values) {
    const label = value.trim() || 'unknown'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

function escapeLoggingFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildLocationAwareLogFilter(location: string): string {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return ''
  }

  const clauses = GCP_ZONE_PATTERN.test(normalizedLocation)
    ? [
        `resource.labels.zone="${escapeLoggingFilterValue(normalizedLocation)}"`,
        `resource.labels.location="${escapeLoggingFilterValue(normalizedLocation)}"`
      ]
    : [
        `resource.labels.region="${escapeLoggingFilterValue(normalizedLocation)}"`,
        `resource.labels.location="${escapeLoggingFilterValue(normalizedLocation)}"`,
        `resource.labels.zone:"${escapeLoggingFilterValue(`${normalizedLocation}-`)}"`
      ]

  return `(${clauses.join(' OR ')})`
}

function buildGcpLogFilter(location: string, query: string, windowHours: number): string {
  const normalizedQuery = query.trim()
  const normalizedLocationFilter = buildLocationAwareLogFilter(location)
  const normalizedWindowHours = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(Math.max(windowHours, 1), 168) : 24
  const freshnessFilter = `timestamp >= "${new Date(Date.now() - normalizedWindowHours * 60 * 60 * 1000).toISOString()}"`

  return [freshnessFilter, normalizedLocationFilter, normalizedQuery]
    .filter(Boolean)
    .join(' AND ')
}

function filterStorageBucketsByLocation(buckets: GcpStorageBucketSummary[], location: string): GcpStorageBucketSummary[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return buckets
  }

  return [...buckets].sort((left, right) => {
    const leftMatches = left.location.trim().toLowerCase() === normalizedLocation
    const rightMatches = right.location.trim().toLowerCase() === normalizedLocation
    if (leftMatches !== rightMatches) {
      return leftMatches ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
}

function filterSqlInstancesByLocation(instances: GcpSqlInstanceSummary[], location: string): GcpSqlInstanceSummary[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return instances
  }

  const isZoneLocation = /-[a-z]$/.test(normalizedLocation)
  return [...instances].sort((left, right) => {
    const leftRegion = left.region.trim().toLowerCase()
    const rightRegion = right.region.trim().toLowerCase()
    const leftZone = left.zone.trim().toLowerCase()
    const rightZone = right.zone.trim().toLowerCase()
    const leftMatches = isZoneLocation ? leftZone === normalizedLocation : leftRegion === normalizedLocation || leftZone.startsWith(`${normalizedLocation}-`)
    const rightMatches = isZoneLocation ? rightZone === normalizedLocation : rightRegion === normalizedLocation || rightZone.startsWith(`${normalizedLocation}-`)
    if (leftMatches !== rightMatches) {
      return leftMatches ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
}

function filterSubnetworksByLocation(subnetworks: GcpSubnetworkSummary[], location: string): GcpSubnetworkSummary[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return subnetworks
  }

  const normalizedRegion = /-[a-z]$/.test(normalizedLocation)
    ? normalizedLocation.replace(/-[a-z]$/, '')
    : normalizedLocation

  return subnetworks.filter((subnetwork) => subnetwork.region.trim().toLowerCase() === normalizedRegion)
}

function filterRoutersByLocation<T extends { region: string }>(routers: T[], location: string): T[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return routers
  }

  const normalizedRegion = /-[a-z]$/.test(normalizedLocation)
    ? normalizedLocation.replace(/-[a-z]$/, '')
    : normalizedLocation

  return routers.filter((router) => router.region.trim().toLowerCase() === normalizedRegion)
}

function filterComputeInstancesByLocation(instances: GcpComputeInstanceSummary[], location: string): GcpComputeInstanceSummary[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return instances
  }

  const isZoneLocation = /-[a-z]$/.test(normalizedLocation)
  return instances.filter((instance) => {
    const zone = instance.zone.trim().toLowerCase()
    if (!zone) {
      return false
    }
    return isZoneLocation ? zone === normalizedLocation : zone === normalizedLocation || zone.startsWith(`${normalizedLocation}-`)
  })
}

function filterGkeClustersByLocation(clusters: GcpGkeClusterSummary[], location: string): GcpGkeClusterSummary[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return clusters
  }

  const isZoneLocation = /-[a-z]$/.test(normalizedLocation)
  return clusters.filter((cluster) => {
    const clusterLocation = cluster.location.trim().toLowerCase()
    if (!clusterLocation) {
      return false
    }
    return isZoneLocation ? clusterLocation === normalizedLocation : clusterLocation === normalizedLocation || clusterLocation.startsWith(`${normalizedLocation}-`)
  })
}

function isValidGcpLocation(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return normalized === 'global' || GCP_REGION_PATTERN.test(normalized) || GCP_ZONE_PATTERN.test(normalized)
}

async function getGcpProjectBillingInfo(projectId: string): Promise<{ billingEnabled: boolean; billingAccountName: string }> {
  const response = await requestGcp<Record<string, unknown>>(projectId, {
    url: `https://cloudbilling.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/billingInfo`
  })

  return {
    billingEnabled: asBoolean(response.billingEnabled),
    billingAccountName: asString(response.billingAccountName)
  }
}

async function getGcpBillingAccountMetadata(projectId: string, billingAccountName: string): Promise<{ displayName: string; open: boolean }> {
  if (!billingAccountName.trim()) {
    return { displayName: '', open: false }
  }

  const response = await requestGcp<Record<string, unknown>>(projectId, {
    url: `https://cloudbilling.googleapis.com/v1/${billingAccountName}`
  })

  return {
    displayName: asString(response.displayName),
    open: asBoolean(response.open)
  }
}

async function getGcpProjectMetadata(projectId: string): Promise<{
  projectId: string
  name: string
  projectNumber: string
  lifecycleState: string
  parentType: string
  parentId: string
  createTime: string
  labels: Record<string, string>
}> {
  const response = await requestGcp<Record<string, unknown>>(projectId, {
    url: `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`
  })

  const parent = asString(response.parent)
  const [parentType = '', parentId = ''] = parent.split('/')

  return {
    projectId: asString(response.projectId) || projectId,
    name: asString(response.displayName),
    projectNumber: asString(response.projectNumber),
    lifecycleState: asString(response.state),
    parentType,
    parentId,
    createTime: asString(response.createTime),
    labels: normalizeStringRecord(response.labels)
  }
}

/** Requires: serviceusage.services.list — API: serviceusage.googleapis.com */
export async function listGcpEnabledApis(projectId: string): Promise<GcpEnabledApiSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const services: GcpEnabledApiSummary[] = []
    let pageToken = ''
    const canPage = paginationGuard()

    do {
      const response = await requestGcp<{ services?: Array<Record<string, unknown>>; nextPageToken?: string }>(normalizedProjectId, {
        url: `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/services?filter=state:ENABLED&pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })

      for (const entry of response.services ?? []) {
        const config = toRecord(entry.config)
        const name = asString(entry.name).replace(/^projects\/[^/]+\/services\//, '')
        if (!name) {
          continue
        }

        services.push({
          name,
          title: asString(config.title) || titleFromApiName(name)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return services.sort((left, right) => left.title.localeCompare(right.title))
  } catch (error) {
    throw buildGcpSdkError(`listing enabled APIs for project "${normalizedProjectId}"`, error, 'serviceusage.googleapis.com')
  }
}

async function getGcpProjectIamPolicy(projectId: string): Promise<Record<string, unknown>> {
  return requestGcp<Record<string, unknown>>(projectId, {
    url: `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:getIamPolicy`,
    method: 'POST',
    data: {
      options: {
        requestedPolicyVersion: 3
      }
    }
  })
}

/** Requires: iam.serviceAccounts.list — API: iam.googleapis.com */
export async function listGcpServiceAccounts(projectId: string): Promise<GcpServiceAccountSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const accounts: GcpServiceAccountSummary[] = []
    let pageToken = ''
    const canPage = paginationGuard()

    do {
      const response = await requestGcp<{ accounts?: Array<Record<string, unknown>>; nextPageToken?: string }>(normalizedProjectId, {
        url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/serviceAccounts?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })

      for (const entry of response.accounts ?? []) {
        const email = asString(entry.email)
        if (!email) {
          continue
        }

        accounts.push({
          email,
          displayName: asString(entry.displayName),
          uniqueId: asString(entry.uniqueId),
          description: asString(entry.description),
          disabled: asBoolean(entry.disabled)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return accounts.sort((left, right) => left.email.localeCompare(right.email))
  } catch (error) {
    throw buildGcpSdkError(`listing service accounts for project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
  }
}

function buildGcpIamBindings(policy: Record<string, unknown>): GcpIamBindingSummary[] {
  const bindings = Array.isArray(policy.bindings) ? policy.bindings as Array<Record<string, unknown>> : []

  return bindings
    .map((binding) => {
      const role = asString(binding.role)
      if (!role) {
        return null
      }

      const members = Array.isArray(binding.members)
        ? binding.members.map((member) => asString(member)).filter(Boolean)
        : []
      const condition = toRecord(binding.condition)

      return {
        role,
        memberCount: members.length,
        risky: isGcpHighPrivilegeRole(role),
        publicAccess: members.some((member) => isGcpPublicPrincipal(member)),
        conditionTitle: asString(condition.title),
        members: members.slice(0, 6)
      } satisfies GcpIamBindingSummary
    })
    .filter((binding): binding is GcpIamBindingSummary => binding !== null)
    .sort((left, right) => {
      if (left.publicAccess !== right.publicAccess) {
        return left.publicAccess ? -1 : 1
      }
      if (left.risky !== right.risky) {
        return left.risky ? -1 : 1
      }
      return right.memberCount - left.memberCount || left.role.localeCompare(right.role)
    })
}

function buildGcpIamPrincipals(bindings: GcpIamBindingSummary[]): GcpIamPrincipalSummary[] {
  const principals = new Map<string, { bindingCount: number; highPrivilegeRoleCount: number; sampleRoles: string[] }>()

  for (const binding of bindings) {
    for (const member of binding.members) {
      const current = principals.get(member) ?? {
        bindingCount: 0,
        highPrivilegeRoleCount: 0,
        sampleRoles: []
      }

      current.bindingCount += 1
      if (binding.risky) {
        current.highPrivilegeRoleCount += 1
      }
      if (!current.sampleRoles.includes(binding.role)) {
        current.sampleRoles.push(binding.role)
      }

      principals.set(member, current)
    }
  }

  return [...principals.entries()]
    .map(([principal, summary]) => ({
      principal,
      bindingCount: summary.bindingCount,
      highPrivilegeRoleCount: summary.highPrivilegeRoleCount,
      sampleRoles: summary.sampleRoles.slice(0, 3)
    }))
    .sort((left, right) => right.highPrivilegeRoleCount - left.highPrivilegeRoleCount || right.bindingCount - left.bindingCount || left.principal.localeCompare(right.principal))
}

function buildGcpIamCapabilityHints(overview: GcpIamOverview): GcpIamCapabilityHint[] {
  const hints: GcpIamCapabilityHint[] = [
    {
      id: 'project-policy',
      subject: 'Policy',
      severity: 'info',
      title: 'Project-level IAM policy is loaded',
      summary: `This shell is evaluating ${overview.bindingCount} project-level bindings for ${overview.projectId}.`,
      recommendedAction: 'Use this page to review risky grants before opening service consoles or handing the project to operators.'
    }
  ]

  if (overview.publicPrincipalCount > 0) {
    hints.push({
      id: 'public-principals',
      subject: 'Exposure',
      severity: 'error',
      title: 'Public principals are present',
      summary: `${overview.publicPrincipalCount} bindings include allUsers or allAuthenticatedUsers.`,
      recommendedAction: 'Remove public principals unless the project intentionally exposes a public workload.'
    })
  }

  if (overview.riskyBindingCount > 0) {
    hints.push({
      id: 'risky-roles',
      subject: 'Privilege',
      severity: 'warning',
      title: 'High-privilege bindings are present',
      summary: `${overview.riskyBindingCount} bindings use owner, editor, or admin-level roles.`,
      recommendedAction: 'Replace broad roles with narrower predefined or custom roles where possible.'
    })
  }

  if (overview.serviceAccounts.length === 0) {
    hints.push({
      id: 'service-accounts-none',
      subject: 'Service accounts',
      severity: 'info',
      title: 'No service accounts were surfaced',
      summary: 'No project service accounts were returned under the current credentials or the project has not created any.',
      recommendedAction: 'If workloads should have identities here, verify IAM API visibility and project scoping.'
    })
  }

  if (overview.principalCount > 40) {
    hints.push({
      id: 'principal-sprawl',
      subject: 'Sprawl',
      severity: 'warning',
      title: 'Principal sprawl is growing',
      summary: `${overview.principalCount} distinct principals are present in the project-level policy.`,
      recommendedAction: 'Review long principal lists for stale users, overly broad groups, or duplicated grants.'
    })
  }

  return hints
}

function buildGcpProjectCapabilityHints(project: GcpProjectOverview): GcpProjectCapabilityHint[] {
  const hints: GcpProjectCapabilityHint[] = []
  const enabledApiNames = new Set(project.enabledApis.map((entry) => entry.name))
  const missingCoreApis = GCP_PROJECT_CORE_API_HINTS.filter((entry) => !enabledApiNames.has(entry.name))

  hints.push({
    id: 'project-metadata',
    subject: 'Metadata',
    severity: 'info',
    title: 'Project context is bound into the shell',
    summary: `The selected shell is attached to ${project.displayName || project.projectId} and keeps navigation, terminal, and diagnostics in the same project scope.`,
    recommendedAction: 'Use this page before opening service workspaces to confirm project identity, labels, and parent ownership.'
  })

  if (!project.parentType || !project.parentId) {
    hints.push({
      id: 'parent-hidden',
      subject: 'Hierarchy',
      severity: 'warning',
      title: 'Folder or organization parent is not visible',
      summary: 'The current credentials do not expose the project parent relationship, or the project is top-level.',
      recommendedAction: 'Grant Cloud Resource Manager visibility if operators need folder or organization context in this shell.'
    })
  }

  if (project.labels.length === 0) {
    hints.push({
      id: 'labels-missing',
      subject: 'Labels',
      severity: 'warning',
      title: 'Project labels are missing',
      summary: 'The selected project does not expose labels for owner, environment, cost-center, or service identity.',
      recommendedAction: 'Add labels before using this project as a shared operator context so ownership and billing posture remain traceable.'
    })
  }

  if (missingCoreApis.length > 0) {
    hints.push({
      id: 'apis-missing',
      subject: 'APIs',
      severity: 'warning',
      title: 'Some core Google APIs are not enabled',
      summary: `Missing core services: ${missingCoreApis.slice(0, 4).map((entry) => entry.title).join(', ')}${missingCoreApis.length > 4 ? '...' : ''}.`,
      recommendedAction: `Enable missing APIs before expecting all GCP workspaces to load cleanly for project ${project.projectId}.`
    })
  } else {
    hints.push({
      id: 'apis-ready',
      subject: 'APIs',
      severity: 'info',
      title: 'Core operator APIs are enabled',
      summary: 'The common project, billing, compute, storage, SQL, and logging API surfaces are already active.',
      recommendedAction: 'This project is a good candidate for opening the provider workspaces without extra enablement work.'
    })
  }

  if (project.lifecycleState && project.lifecycleState !== 'ACTIVE') {
    hints.push({
      id: 'project-state',
      subject: 'Lifecycle',
      severity: 'error',
      title: `Project state is ${project.lifecycleState}`,
      summary: 'This project is not reported as ACTIVE, which can block normal operator workflows.',
      recommendedAction: 'Verify lifecycle state and billing before attempting changes against this project.'
    })
  }

  return hints
}

function buildGcpBillingProjectRecord(
  projectId: string,
  metadata: {
    projectId: string
    name: string
    projectNumber: string
    lifecycleState: string
    labels: Record<string, string>
  } | null,
  billingInfo: { billingEnabled: boolean; billingAccountName: string }
): GcpBillingProjectRecord {
  const labels = metadata?.labels ?? {}

  return {
    projectId: metadata?.projectId || projectId,
    name: metadata?.name || projectId,
    projectNumber: metadata?.projectNumber || '',
    lifecycleState: metadata?.lifecycleState || '',
    labelCount: Object.keys(labels).length,
    labels,
    billingEnabled: billingInfo.billingEnabled,
    billingAccountName: billingInfo.billingAccountName
  }
}

function summarizeBillingAccountId(value: string): string {
  const normalized = value.trim()
  return normalized ? normalized.replace(/^billingAccounts\//, '') : '-'
}

function computeGcpBillingOwnershipHints(records: GcpBillingProjectRecord[]): GcpBillingOwnershipHint[] {
  const totalProjects = records.length || 1

  return GCP_BILLING_OWNERSHIP_KEYS.map((key) => {
    const counts = new Map<string, number>()
    let labeledProjects = 0

    for (const record of records) {
      const value = record.labels[key]?.trim()
      if (!value) {
        continue
      }

      labeledProjects += 1
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }

    const topValues: GcpBillingOwnershipValue[] = [...counts.entries()]
      .map(([value, projectCount]) => ({
        value,
        projectCount,
        sharePercent: (projectCount / totalProjects) * 100
      }))
      .sort((left, right) => right.projectCount - left.projectCount || left.value.localeCompare(right.value))
      .slice(0, 3)

    return {
      key,
      coveragePercent: (labeledProjects / totalProjects) * 100,
      labeledProjects,
      unlabeledProjects: totalProjects - labeledProjects,
      topValues
    }
  })
    .filter((hint) => hint.labeledProjects > 0 || hint.key === 'owner' || hint.key === 'cost-center' || hint.key === 'environment')
}

function buildGcpBillingCapabilityHints(
  overview: Pick<GcpBillingOverview, 'billingEnabled' | 'billingAccountName' | 'billingAccountDisplayName' | 'billingAccountOpen' | 'linkedProjects' | 'visibility' | 'projectLabelCount' | 'ownershipHints'>,
  projectId: string
): GcpBillingCapabilityHint[] {
  const hints: GcpBillingCapabilityHint[] = []

  if (!overview.billingEnabled) {
    hints.push({
      id: 'billing-disabled',
      subject: 'Billing',
      severity: 'error',
      title: 'Project billing is not enabled',
      summary: `The selected project is not linked to an active billing account, so cost-backed services can fail to provision or continue running.`,
      recommendedAction: `Link project ${projectId} to a billing account in Google Cloud Billing before using cost-bound services.`
    })
  } else {
    hints.push({
      id: 'billing-enabled',
      subject: 'Billing',
      severity: 'info',
      title: 'Project billing is linked',
      summary: overview.billingAccountDisplayName
        ? `Billing is routed through ${overview.billingAccountDisplayName}.`
        : `Billing linkage is enabled for the selected project.`,
      recommendedAction: 'Use this view to confirm the linked billing account and project ownership signals before handing the project to operators.'
    })
  }

  if (overview.billingAccountName && !overview.billingAccountOpen) {
    hints.push({
      id: 'billing-account-closed',
      subject: 'Billing account',
      severity: 'warning',
      title: 'Billing account is not marked open',
      summary: 'The linked billing account metadata does not report an open state.',
      recommendedAction: `Inspect billing account ${summarizeBillingAccountId(overview.billingAccountName)} and verify it is active.`
    })
  }

  if (overview.billingAccountName && !overview.billingAccountDisplayName) {
    hints.push({
      id: 'billing-account-visibility',
      subject: 'Visibility',
      severity: 'warning',
      title: 'Billing account metadata is partially hidden',
      summary: 'Project linkage is visible, but billing account details are limited with the current credentials.',
      recommendedAction: 'Grant Cloud Billing Viewer access if the operator needs the billing account display name and state.'
    })
  }

  if (overview.visibility !== 'full') {
    hints.push({
      id: 'linked-project-visibility',
      subject: 'Visibility',
      severity: 'info',
      title: 'Linked project coverage is partial',
      summary: 'This shell only reports projects visible in the current catalog and under the current credentials.',
      recommendedAction: 'Refresh the project catalog or use broader billing permissions if you expect more linked projects here.'
    })
  }

  if (overview.projectLabelCount === 0) {
    hints.push({
      id: 'project-labels-missing',
      subject: 'Ownership',
      severity: 'warning',
      title: 'Current project has no ownership labels',
      summary: 'The selected project does not expose labels such as owner, environment, or cost-center.',
      recommendedAction: 'Add ownership labels before expanding the billing footprint so chargeback and governance remain traceable.'
    })
  }

  const weakestHint = overview.ownershipHints
    .filter((hint) => ['owner', 'cost-center', 'environment'].includes(hint.key))
    .sort((left, right) => left.coveragePercent - right.coveragePercent)[0]

  if (weakestHint && weakestHint.coveragePercent < 60) {
    hints.push({
      id: `ownership-${weakestHint.key}`,
      subject: 'Ownership',
      severity: 'warning',
      title: `${weakestHint.key} coverage is thin`,
      summary: `${weakestHint.coveragePercent.toFixed(0)}% of linked projects currently expose the ${weakestHint.key} label.`,
      recommendedAction: `Backfill ${weakestHint.key} labels across linked projects before using this view for shared billing ownership reviews.`
    })
  }

  return hints
}

function buildGcpBillingPeriodWindow(now = new Date()): { label: string; start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
  const label = `${now.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })} MTD`

  return {
    label,
    start: start.toISOString(),
    end: now.toISOString()
  }
}

function buildDefaultGcpSpendTelemetry(
  status: GcpBillingSpendTelemetry['status'],
  message: string,
  now = new Date()
): GcpBillingSpendTelemetry {
  const period = buildGcpBillingPeriodWindow(now)

  return {
    status,
    source: 'metadata-only',
    periodLabel: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    totalAmount: 0,
    currency: '',
    serviceBreakdown: [],
    exportProjectId: '',
    exportDatasetId: '',
    exportTableId: '',
    message,
    lastUpdatedAt: now.toISOString()
  }
}

function scoreGcpBillingExportTable(tableId: string): number {
  const normalized = tableId.trim().toLowerCase()
  if (normalized.startsWith('gcp_billing_export_resource_v1_')) {
    return 4
  }

  if (normalized.startsWith('gcp_billing_export_v1_')) {
    return 3
  }

  if (normalized.startsWith('gcp_billing_export_')) {
    return 2
  }

  return normalized.includes('gcp_billing_export') ? 1 : 0
}

function normalizeGcpBigQuerySchemaField(value: unknown): GcpBigQuerySchemaField | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    fields: (Array.isArray(record.fields) ? record.fields : [])
      .map((entry) => normalizeGcpBigQuerySchemaField(entry))
      .filter((entry): entry is GcpBigQuerySchemaField => entry !== null)
  }
}

function findGcpBigQueryField(fields: GcpBigQuerySchemaField[], fieldName: string): GcpBigQuerySchemaField | null {
  const normalized = fieldName.trim().toLowerCase()
  return fields.find((field) => field.name.trim().toLowerCase() === normalized) ?? null
}

function hasGcpBigQueryNestedField(fields: GcpBigQuerySchemaField[], parentName: string, childName: string): boolean {
  const parent = findGcpBigQueryField(fields, parentName)
  return Boolean(parent && findGcpBigQueryField(parent.fields, childName))
}

function buildGcpBillingExportQuery(table: GcpBigQueryExportTableRecord, schemaFields: GcpBigQuerySchemaField[]): string {
  const serviceExpression = hasGcpBigQueryNestedField(schemaFields, 'service', 'description')
    ? 'COALESCE(service.description, "Other")'
    : findGcpBigQueryField(schemaFields, 'service_description')
      ? 'COALESCE(service_description, "Other")'
      : '"Other"'
  const projectIdExpression = hasGcpBigQueryNestedField(schemaFields, 'project', 'id')
    ? 'project.id'
    : hasGcpBigQueryNestedField(schemaFields, 'project', 'project_id')
      ? 'project.project_id'
      : findGcpBigQueryField(schemaFields, 'project_id')
        ? 'project_id'
        : ''
  const usageTimeExpression = findGcpBigQueryField(schemaFields, 'usage_start_time')
    ? 'usage_start_time'
    : findGcpBigQueryField(schemaFields, 'usage_end_time')
      ? 'usage_end_time'
      : ''
  const currencyExpression = findGcpBigQueryField(schemaFields, 'currency')
    ? 'COALESCE(ANY_VALUE(currency), "")'
    : '""'
  const amountExpression = findGcpBigQueryField(schemaFields, 'credits')
    ? 'CAST(cost AS FLOAT64) + IFNULL((SELECT SUM(CAST(credit.amount AS FLOAT64)) FROM UNNEST(credits) AS credit), 0)'
    : 'CAST(cost AS FLOAT64)'

  if (!projectIdExpression || !usageTimeExpression || !findGcpBigQueryField(schemaFields, 'cost')) {
    throw new Error(
      `Billing export table "${table.projectId}.${table.datasetId}.${table.tableId}" uses an unsupported schema for spend aggregation.`
    )
  }

  return `
    SELECT
      ${serviceExpression} AS service,
      ROUND(SUM(${amountExpression}), 2) AS amount,
      ${currencyExpression} AS currency
    FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
    WHERE ${usageTimeExpression} >= TIMESTAMP(@periodStart)
      AND ${usageTimeExpression} < TIMESTAMP(@periodEnd)
      AND ${projectIdExpression} = @projectId
    GROUP BY service
    HAVING ABS(SUM(${amountExpression})) > 0.009
    ORDER BY amount DESC
    LIMIT 12
  `.trim()
}

async function listGcpBigQueryDatasets(projectId: string): Promise<GcpBigQueryDatasetRecord[]> {
  const datasets: GcpBigQueryDatasetRecord[] = []
  let pageToken = ''

  const canPage = paginationGuard()
  do {
    const response = await requestGcp<Record<string, unknown>>(projectId, {
      url: buildBigQueryApiUrl(`projects/${encodeURIComponent(projectId)}/datasets`, {
        all: 'true',
        maxResults: 1000,
        pageToken: pageToken || undefined
      })
    })

    for (const entry of Array.isArray(response.datasets) ? response.datasets : []) {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const reference = record.datasetReference && typeof record.datasetReference === 'object'
        ? record.datasetReference as Record<string, unknown>
        : {}
      const datasetId = asString(reference.datasetId)
      if (!datasetId) {
        continue
      }

      datasets.push({
        projectId: asString(reference.projectId) || projectId,
        datasetId,
        location: asString(record.location)
      })
    }

    pageToken = asString(response.nextPageToken)
  } while (pageToken && canPage())

  return datasets
}

async function listGcpBigQueryBillingExportTables(dataset: GcpBigQueryDatasetRecord): Promise<GcpBigQueryExportTableRecord[]> {
  const tables: GcpBigQueryExportTableRecord[] = []
  let pageToken = ''

  const canPage = paginationGuard()
  do {
    const response = await requestGcp<Record<string, unknown>>(dataset.projectId, {
      url: buildBigQueryApiUrl(
        `projects/${encodeURIComponent(dataset.projectId)}/datasets/${encodeURIComponent(dataset.datasetId)}/tables`,
        {
          maxResults: 1000,
          pageToken: pageToken || undefined
        }
      )
    })

    for (const entry of Array.isArray(response.tables) ? response.tables : []) {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const reference = record.tableReference && typeof record.tableReference === 'object'
        ? record.tableReference as Record<string, unknown>
        : {}
      const tableId = asString(reference.tableId)
      const priority = scoreGcpBillingExportTable(tableId)

      if (!tableId || priority === 0) {
        continue
      }

      tables.push({
        projectId: dataset.projectId,
        datasetId: dataset.datasetId,
        tableId,
        location: dataset.location,
        priority
      })
    }

    pageToken = asString(response.nextPageToken)
  } while (pageToken && canPage())

  return tables
}

async function discoverGcpBillingExportTable(projectId: string, candidateProjectIds: string[]): Promise<{
  table: GcpBigQueryExportTableRecord | null
  errors: string[]
}> {
  const candidates: GcpBigQueryExportTableRecord[] = []
  const errors: string[] = []
  const uniqueProjectIds = [...new Set(candidateProjectIds.map((value) => value.trim()).filter(Boolean))]

  for (const candidateProjectId of uniqueProjectIds) {
    try {
      const datasets = await listGcpBigQueryDatasets(candidateProjectId)

      for (const dataset of datasets) {
        try {
          candidates.push(...await listGcpBigQueryBillingExportTables(dataset))
        } catch (error) {
          errors.push(normalizeError(error))
        }
      }
    } catch (error) {
      errors.push(normalizeError(error))
    }
  }

  const selected = candidates
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority
      }

      if (left.projectId === projectId && right.projectId !== projectId) {
        return -1
      }

      if (right.projectId === projectId && left.projectId !== projectId) {
        return 1
      }

      return `${left.projectId}.${left.datasetId}.${left.tableId}`.localeCompare(`${right.projectId}.${right.datasetId}.${right.tableId}`)
    })[0] ?? null

  return {
    table: selected,
    errors
  }
}

async function getGcpBigQueryTableSchema(table: GcpBigQueryExportTableRecord): Promise<GcpBigQuerySchemaField[]> {
  const response = await requestGcp<Record<string, unknown>>(table.projectId, {
    url: buildBigQueryApiUrl(
      `projects/${encodeURIComponent(table.projectId)}/datasets/${encodeURIComponent(table.datasetId)}/tables/${encodeURIComponent(table.tableId)}`
    )
  })
  const schema = response.schema && typeof response.schema === 'object' ? response.schema as Record<string, unknown> : {}
  return (Array.isArray(schema.fields) ? schema.fields : [])
    .map((entry) => normalizeGcpBigQuerySchemaField(entry))
    .filter((entry): entry is GcpBigQuerySchemaField => entry !== null)
}

async function executeGcpBigQueryQuery(
  authProjectId: string,
  location: string,
  query: string,
  parameters: Array<{ name: string; type: 'STRING' | 'TIMESTAMP'; value: string }>
): Promise<Record<string, unknown>> {
  const initial = await requestGcp<Record<string, unknown>>(authProjectId, {
    url: buildBigQueryApiUrl(`projects/${encodeURIComponent(authProjectId)}/queries`),
    method: 'POST',
    data: {
      query,
      useLegacySql: false,
      timeoutMs: 20000,
      location: location || undefined,
      parameterMode: 'NAMED',
      queryParameters: parameters.map((parameter) => ({
        name: parameter.name,
        parameterType: { type: parameter.type },
        parameterValue: { value: parameter.value }
      }))
    }
  })

  let response = initial
  let attempts = 0
  const jobReference = initial.jobReference && typeof initial.jobReference === 'object'
    ? initial.jobReference as Record<string, unknown>
    : {}
  const jobId = asString(jobReference.jobId)

  while (!asBoolean(response.jobComplete) && jobId && attempts < 12) {
    attempts += 1
    await sleep(500)
    response = await requestGcp<Record<string, unknown>>(authProjectId, {
      url: buildBigQueryApiUrl(`projects/${encodeURIComponent(authProjectId)}/queries/${encodeURIComponent(jobId)}`, {
        location: location || undefined,
        maxResults: 50
      })
    })
  }

  return response
}

function normalizeGcpBigQuerySpendRows(rows: unknown): Array<{ service: string; amount: number; currency: string }> {
  if (!Array.isArray(rows)) {
    return []
  }

  return rows
    .map((entry) => {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const values = Array.isArray(record.f) ? record.f : []
      const service = asString(values[0] && typeof values[0] === 'object' ? (values[0] as Record<string, unknown>).v : '')
      const amount = normalizeNumber(values[1] && typeof values[1] === 'object' ? (values[1] as Record<string, unknown>).v : 0)
      const currency = asString(values[2] && typeof values[2] === 'object' ? (values[2] as Record<string, unknown>).v : '')

      return service ? { service, amount, currency } : null
    })
    .filter((entry): entry is { service: string; amount: number; currency: string } => entry !== null)
}

function buildGcpBillingSpendEntries(rows: Array<{ service: string; amount: number; currency: string }>, totalAmount: number): GcpBillingSpendBreakdownEntry[] {
  return rows.map((row) => ({
    service: row.service,
    amount: row.amount,
    currency: row.currency,
    sharePercent: totalAmount > 0 ? (row.amount / totalAmount) * 100 : 0
  }))
}

function isLikelyGcpAccessLimitedError(error: unknown): boolean {
  const detail = normalizeError(error).toLowerCase()
  return detail.includes('permission')
    || detail.includes('forbidden')
    || detail.includes('access denied')
    || detail.includes('not authorized')
    || detail.includes('bigquery.jobs.create')
}

function isLikelyGcpBigQueryApiDisabledError(error: unknown): boolean {
  return outputIndicatesApiDisabled(normalizeError(error))
    || normalizeError(error).toLowerCase().includes('bigquery api')
}

async function loadGcpBillingSpendTelemetry(projectId: string, candidateProjectIds: string[], billingEnabled: boolean): Promise<GcpBillingSpendTelemetry> {
  if (!billingEnabled) {
    return buildDefaultGcpSpendTelemetry('billing-disabled', 'Project billing is not enabled, so spend telemetry is not available.')
  }

  const discovery = await discoverGcpBillingExportTable(projectId, candidateProjectIds)
  if (!discovery.table) {
    const actionableErrors = discovery.errors.filter((error) => !isLikelyGcpBigQueryApiDisabledError(error))

    if (actionableErrors.length > 0) {
      return buildDefaultGcpSpendTelemetry(
        isLikelyGcpAccessLimitedError(actionableErrors[0]) ? 'access-limited' : 'error',
        `Spend telemetry could not inspect billing export datasets with the current credentials. ${actionableErrors[0]}`
      )
    }

    return buildDefaultGcpSpendTelemetry(
      'missing-export',
      'No BigQuery Cloud Billing export table was discovered in the linked billing scope.'
    )
  }

  const period = buildGcpBillingPeriodWindow()

  try {
    const schemaFields = await getGcpBigQueryTableSchema(discovery.table)
    const query = buildGcpBillingExportQuery(discovery.table, schemaFields)
    const queryProjects = [...new Set([discovery.table.projectId, projectId].filter(Boolean))]
    let lastError: unknown = null

    for (const queryProjectId of queryProjects) {
      try {
        const response = await executeGcpBigQueryQuery(
          queryProjectId,
          discovery.table.location,
          query,
          [
            { name: 'periodStart', type: 'TIMESTAMP', value: period.start },
            { name: 'periodEnd', type: 'TIMESTAMP', value: period.end },
            { name: 'projectId', type: 'STRING', value: projectId }
          ]
        )
        const rows = normalizeGcpBigQuerySpendRows(response.rows)
        const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0)
        const currency = rows.find((row) => row.currency)?.currency ?? ''

        return {
          status: 'available',
          source: 'bigquery-export',
          periodLabel: period.label,
          periodStart: period.start,
          periodEnd: period.end,
          totalAmount,
          currency,
          serviceBreakdown: buildGcpBillingSpendEntries(rows, totalAmount),
          exportProjectId: discovery.table.projectId,
          exportDatasetId: discovery.table.datasetId,
          exportTableId: discovery.table.tableId,
          message: `Spend telemetry is sourced from BigQuery export ${discovery.table.projectId}.${discovery.table.datasetId}.${discovery.table.tableId}.`,
          lastUpdatedAt: new Date().toISOString()
        }
      } catch (error) {
        lastError = error
      }
    }

    throw lastError ?? new Error('BigQuery query did not return a result.')
  } catch (error) {
    return buildDefaultGcpSpendTelemetry(
      isLikelyGcpAccessLimitedError(error) ? 'access-limited' : 'error',
      `Spend telemetry could not be queried from ${discovery.table.projectId}.${discovery.table.datasetId}.${discovery.table.tableId}. ${normalizeError(error)}`
    )
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeGcpComputeLabels(labels: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(labels)
    .map(([key, value]) => ({ key: key.trim(), value: value.trim() }))
    .filter((entry) => entry.key)
    .sort((left, right) => left.key.localeCompare(right.key))
}

function normalizeGcpComputeMetadata(items: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const record = entry as Record<string, unknown>
      const key = asString(record.key)
      if (!key) {
        return null
      }

      return {
        key,
        value: asString(record.value)
      }
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null)
    .sort((left, right) => left.key.localeCompare(right.key))
}

function summarizeGcpComputeScheduling(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return ''
  }

  const scheduling = value as Record<string, unknown>
  const parts: string[] = []
  const provisioningModel = asString(scheduling.provisioningModel)
  const onHostMaintenance = asString(scheduling.onHostMaintenance)

  if (provisioningModel) {
    parts.push(provisioningModel)
  }
  if (asBoolean(scheduling.preemptible)) {
    parts.push('Preemptible')
  }
  if (onHostMaintenance) {
    parts.push(`On host maintenance: ${onHostMaintenance}`)
  }

  return parts.join(' | ')
}

function normalizeGcpComputeInstanceDetail(instance: unknown): GcpComputeInstanceDetail | null {
  if (!instance || typeof instance !== 'object') {
    return null
  }

  const record = instance as Record<string, unknown>
  const name = asString(record.name)
  if (!name) {
    return null
  }

  const networkInterfaces = Array.isArray(record.networkInterfaces)
    ? record.networkInterfaces as Array<Record<string, unknown>>
    : []
  const firstNetwork = networkInterfaces[0] ?? {}
  const firstAccessConfig = Array.isArray(firstNetwork.accessConfigs)
    ? (firstNetwork.accessConfigs as Array<Record<string, unknown>>)[0] ?? {}
    : {}
  const disks = Array.isArray(record.disks) ? record.disks as Array<Record<string, unknown>> : []
  const serviceAccounts = Array.isArray(record.serviceAccounts) ? record.serviceAccounts as Array<Record<string, unknown>> : []
  const tags = record.tags && typeof record.tags === 'object'
    ? record.tags as Record<string, unknown>
    : {}
  const metadata = record.metadata && typeof record.metadata === 'object'
    ? record.metadata as Record<string, unknown>
    : {}
  const shielded = record.shieldedInstanceConfig && typeof record.shieldedInstanceConfig === 'object'
    ? record.shieldedInstanceConfig as Record<string, unknown>
    : {}

  return {
    id: asString(record.id),
    name,
    zone: resourceBasename(asString(record.zone)),
    status: asString(record.status),
    machineType: resourceBasename(asString(record.machineType)),
    cpuPlatform: asString(record.cpuPlatform),
    internalIp: asString(firstNetwork.networkIP),
    externalIp: asString(firstAccessConfig.natIP),
    canIpForward: asBoolean(record.canIpForward),
    deletionProtection: asBoolean(record.deletionProtection),
    creationTimestamp: asString(record.creationTimestamp),
    lastStartTimestamp: asString(record.lastStartTimestamp),
    lastStopTimestamp: asString(record.lastStopTimestamp),
    scheduling: summarizeGcpComputeScheduling(record.scheduling),
    tags: Array.isArray(tags.items) ? (tags.items as unknown[]).map(asString).filter(Boolean).sort((left, right) => left.localeCompare(right)) : [],
    labels: normalizeGcpComputeLabels(normalizeStringRecord(record.labels)),
    metadata: normalizeGcpComputeMetadata(metadata.items),
    networks: networkInterfaces.map((entry) => {
      const accessConfig = Array.isArray(entry.accessConfigs)
        ? (entry.accessConfigs as Array<Record<string, unknown>>)[0] ?? {}
        : {}

      return {
        name: asString(entry.name),
        network: resourceBasename(asString(entry.network)),
        subnetwork: resourceBasename(asString(entry.subnetwork)),
        internalIp: asString(entry.networkIP),
        externalIp: asString(accessConfig.natIP),
        stackType: asString(entry.stackType)
      }
    }),
    disks: disks.map((entry) => ({
      deviceName: asString(entry.deviceName),
      type: resourceBasename(asString(entry.type)),
      sizeGb: asString(entry.diskSizeGb),
      status: asString(entry.status),
      mode: asString(entry.mode),
      interface: asString(entry.interface),
      boot: asBoolean(entry.boot),
      autoDelete: asBoolean(entry.autoDelete)
    })),
    serviceAccounts: serviceAccounts.map((entry) => ({
      email: asString(entry.email),
      scopes: Array.isArray(entry.scopes) ? (entry.scopes as unknown[]).map((scope) => asString(scope)).filter(Boolean) : []
    })),
    shieldedIntegrityMonitoring: asBoolean(shielded.enableIntegrityMonitoring),
    shieldedSecureBoot: asBoolean(shielded.enableSecureBoot),
    shieldedVtpm: asBoolean(shielded.enableVtpm)
  }
}

function normalizeGcpComputeMachineTypeOption(entry: unknown): GcpComputeMachineTypeOption | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const name = asString(record.name)
  if (!name) {
    return null
  }

  return {
    name,
    guestCpus: normalizeNumber(record.guestCpus),
    memoryMb: normalizeNumber(record.memoryMb),
    description: asString(record.description),
    isSharedCpu: asBoolean(record.isSharedCpu)
  }
}

function buildGcpComputeActionSummary(action: GcpComputeInstanceAction, instanceName: string, completed: boolean): string {
  const verb = action === 'reset'
    ? 'reset'
    : action === 'resume'
      ? 'resume'
      : action === 'suspend'
        ? 'suspend'
        : action

  return completed
    ? `${instanceName} ${verb} completed.`
    : `${instanceName} ${verb} request was accepted and is still in progress.`
}

function buildGcpComputeResizeSummary(instanceName: string, machineType: string, completed: boolean): string {
  return completed
    ? `${instanceName} resized to ${machineType}.`
    : `${instanceName} resize to ${machineType} was accepted and is still in progress.`
}

function buildGcpComputeLabelSummary(instanceName: string, completed: boolean): string {
  return completed
    ? `${instanceName} labels updated.`
    : `${instanceName} label update was accepted and is still in progress.`
}

function buildGcpComputeDeleteSummary(instanceName: string, completed: boolean): string {
  return completed
    ? `${instanceName} deletion completed.`
    : `${instanceName} delete request was accepted and is still in progress.`
}

function buildGcpMachineTypeResource(zone: string, machineType: string): string {
  const normalizedMachineType = machineType.trim()
  if (!normalizedMachineType) {
    return ''
  }

  return normalizedMachineType.includes('/')
    ? normalizedMachineType
    : `zones/${zone.trim()}/machineTypes/${normalizedMachineType}`
}

function extractGcpZoneOperationError(operation: unknown): string {
  if (!operation || typeof operation !== 'object') {
    return ''
  }

  const record = operation as Record<string, unknown>
  const error = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : {}
  const errors = Array.isArray(error.errors) ? error.errors as Array<Record<string, unknown>> : []

  return errors
    .map((entry) => [asString(entry.code), asString(entry.message)].filter(Boolean).join(': '))
    .filter(Boolean)
    .join(' | ')
}

async function waitForGcpZoneOperation(projectId: string, zone: string, operationName: string, timeoutMs = 45000): Promise<{ completed: boolean; status: string }> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedOperation = operationName.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedOperation) {
    return { completed: false, status: 'PENDING' }
  }

  const auth = getGcpAuth(normalizedProjectId)
  const compute = google.compute({ version: 'v1', auth })
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const response = await compute.zoneOperations.get({
      project: normalizedProjectId,
      zone: normalizedZone,
      operation: normalizedOperation
    })
    const status = asString(response.data.status) || 'PENDING'

    if (status === 'DONE') {
      const errorMessage = extractGcpZoneOperationError(response.data)
      if (errorMessage) {
        throw new Error(errorMessage)
      }

      return { completed: true, status }
    }

    await sleep(2000)
  }

  return { completed: false, status: 'PENDING' }
}

async function waitForGkeOperation(projectId: string, location: string, operationName: string, timeoutMs = 120000): Promise<{ completed: boolean; status: string }> {
  const normalizedProjectId = projectId.trim()
  const normalizedLocation = location.trim()
  const normalizedOperation = operationName.trim()

  if (!normalizedProjectId || !normalizedLocation || !normalizedOperation) {
    return { completed: false, status: 'PENDING' }
  }

  const auth = getGcpAuth(normalizedProjectId)
  const container = google.container({ version: 'v1' as never, auth: auth as never })
  const operations = (((container.projects as any)?.locations as any)?.operations ?? {}) as Record<string, (...args: unknown[]) => Promise<unknown>>
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const response = await operations.get?.({
      name: `projects/${normalizedProjectId}/locations/${normalizedLocation}/operations/${normalizedOperation}`
    }) as { data?: unknown } | undefined
    const record = response?.data
    const status = asString((record as Record<string, unknown> | undefined)?.status) || 'PENDING'

    if (status === 'DONE') {
      const errorMessage = extractGkeOperationError(record)
      if (errorMessage) {
        throw new Error(errorMessage)
      }

      return { completed: true, status }
    }

    await sleep(2500)
  }

  return { completed: false, status: 'PENDING' }
}

export async function listGcpComputeInstances(projectId: string, location: string): Promise<GcpComputeInstanceSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const compute = google.compute({ version: 'v1', auth })
    const instances: GcpComputeInstanceSummary[] = []
    let pageToken: string | undefined

    const canPage = paginationGuard()
    do {
      const response = await compute.instances.aggregatedList({ project: normalizedProjectId, maxResults: 500, pageToken })
      for (const scoped of Object.values(response.data.items ?? {})) {
        const scopedRecord = scoped as { instances?: Array<Record<string, unknown>> } | null | undefined
        for (const instance of scopedRecord?.instances ?? []) {
          const name = asString(instance.name)
          if (!name) {
            continue
          }
          instances.push({
            name,
            zone: resourceBasename(asString(instance.zone)),
            status: asString(instance.status),
            machineType: resourceBasename(asString(instance.machineType)),
            internalIp: asString((instance.networkInterfaces as Array<Record<string, unknown>> | undefined)?.[0]?.networkIP),
            externalIp: asString((((instance.networkInterfaces as Array<Record<string, unknown>> | undefined)?.[0]?.accessConfigs as Array<Record<string, unknown>> | undefined)?.[0]?.natIP))
          })
        }
      }
      pageToken = asString(response.data.nextPageToken) || undefined
    } while (pageToken && canPage())

    return filterComputeInstancesByLocation(instances, location)
      .sort((left, right) => left.zone.localeCompare(right.zone) || left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing Compute Engine instances for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function getGcpComputeInstanceDetail(projectId: string, zone: string, instanceName: string): Promise<GcpComputeInstanceDetail | null> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedInstanceName) {
    return null
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const compute = google.compute({ version: 'v1', auth })
    const response = await compute.instances.get({
      project: normalizedProjectId,
      zone: normalizedZone,
      instance: normalizedInstanceName
    })

    return normalizeGcpComputeInstanceDetail(response.data)
  } catch (error) {
    throw buildGcpSdkError(`describing Compute Engine instance "${normalizedInstanceName}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpComputeMachineTypes(projectId: string, zone: string): Promise<GcpComputeMachineTypeOption[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()

  if (!normalizedProjectId || !normalizedZone) {
    return []
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const compute = google.compute({ version: 'v1', auth })
    const machineTypes: GcpComputeMachineTypeOption[] = []
    let pageToken: string | undefined

    const canPage = paginationGuard()
    do {
      const response = await compute.machineTypes.list({
        project: normalizedProjectId,
        zone: normalizedZone,
        maxResults: 500,
        pageToken
      })

      for (const entry of response.data.items ?? []) {
        const normalized = normalizeGcpComputeMachineTypeOption(entry)
        if (normalized) {
          machineTypes.push(normalized)
        }
      }

      pageToken = asString(response.data.nextPageToken) || undefined
    } while (pageToken && canPage())

    return machineTypes.sort((left, right) =>
      left.guestCpus - right.guestCpus
      || left.memoryMb - right.memoryMb
      || left.name.localeCompare(right.name)
    )
  } catch (error) {
    throw buildGcpSdkError(`listing machine types for zone "${normalizedZone}"`, error, 'compute.googleapis.com')
  }
}

export async function runGcpComputeInstanceAction(
  projectId: string,
  zone: string,
  instanceName: string,
  action: GcpComputeInstanceAction
): Promise<GcpComputeOperationResult> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedInstanceName) {
    throw new Error('Project, zone, and instance name are required.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const compute = google.compute({ version: 'v1', auth })
    let response

    switch (action) {
      case 'start':
        response = await compute.instances.start({ project: normalizedProjectId, zone: normalizedZone, instance: normalizedInstanceName })
        break
      case 'stop':
        response = await compute.instances.stop({ project: normalizedProjectId, zone: normalizedZone, instance: normalizedInstanceName })
        break
      case 'reset':
        response = await compute.instances.reset({ project: normalizedProjectId, zone: normalizedZone, instance: normalizedInstanceName })
        break
      case 'resume':
        response = await compute.instances.resume({ project: normalizedProjectId, zone: normalizedZone, instance: normalizedInstanceName })
        break
      case 'suspend':
        response = await compute.instances.suspend({ project: normalizedProjectId, zone: normalizedZone, instance: normalizedInstanceName })
        break
      default:
        throw new Error(`Unsupported Compute Engine action: ${action}`)
    }

    const operationName = asString(response.data.name)
    const result = await waitForGcpZoneOperation(normalizedProjectId, normalizedZone, operationName)

    return {
      operationName,
      completed: result.completed,
      status: result.status,
      summary: buildGcpComputeActionSummary(action, normalizedInstanceName, result.completed)
    }
  } catch (error) {
    throw buildGcpSdkError(`running ${action} on Compute Engine instance "${normalizedInstanceName}"`, error, 'compute.googleapis.com')
  }
}

export async function resizeGcpComputeInstance(
  projectId: string,
  zone: string,
  instanceName: string,
  machineType: string
): Promise<GcpComputeOperationResult> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedInstanceName = instanceName.trim()
  const normalizedMachineType = machineType.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedInstanceName || !normalizedMachineType) {
    throw new Error('Project, zone, instance name, and machine type are required.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const compute = google.compute({ version: 'v1', auth })
    const response = await compute.instances.setMachineType({
      project: normalizedProjectId,
      zone: normalizedZone,
      instance: normalizedInstanceName,
      requestBody: {
        machineType: buildGcpMachineTypeResource(normalizedZone, normalizedMachineType)
      }
    })

    const operationName = asString(response.data.name)
    const result = await waitForGcpZoneOperation(normalizedProjectId, normalizedZone, operationName)

    return {
      operationName,
      completed: result.completed,
      status: result.status,
      summary: buildGcpComputeResizeSummary(normalizedInstanceName, normalizedMachineType, result.completed)
    }
  } catch (error) {
    throw buildGcpSdkError(`resizing Compute Engine instance "${normalizedInstanceName}"`, error, 'compute.googleapis.com')
  }
}

export async function updateGcpComputeInstanceLabels(
  projectId: string,
  zone: string,
  instanceName: string,
  labels: Record<string, string>
): Promise<GcpComputeOperationResult> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedInstanceName) {
    throw new Error('Project, zone, and instance name are required.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const compute = google.compute({ version: 'v1', auth })
    const current = await compute.instances.get({
      project: normalizedProjectId,
      zone: normalizedZone,
      instance: normalizedInstanceName
    })
    const fingerprint = asString(current.data.labelFingerprint)

    if (!fingerprint) {
      throw new Error('The instance label fingerprint is missing. Refresh and retry.')
    }

    const normalizedLabels = Object.fromEntries(
      Object.entries(labels)
        .map(([key, value]) => [key.trim(), value.trim()] as const)
        .filter(([key]) => Boolean(key))
    )

    const response = await compute.instances.setLabels({
      project: normalizedProjectId,
      zone: normalizedZone,
      instance: normalizedInstanceName,
      requestBody: {
        labelFingerprint: fingerprint,
        labels: normalizedLabels
      }
    })

    const operationName = asString(response.data.name)
    const result = await waitForGcpZoneOperation(normalizedProjectId, normalizedZone, operationName)

    return {
      operationName,
      completed: result.completed,
      status: result.status,
      summary: buildGcpComputeLabelSummary(normalizedInstanceName, result.completed)
    }
  } catch (error) {
    throw buildGcpSdkError(`updating labels on Compute Engine instance "${normalizedInstanceName}"`, error, 'compute.googleapis.com')
  }
}

export async function deleteGcpComputeInstance(projectId: string, zone: string, instanceName: string): Promise<GcpComputeOperationResult> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedInstanceName) {
    throw new Error('Project, zone, and instance name are required.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const compute = google.compute({ version: 'v1', auth })
    const response = await compute.instances.delete({
      project: normalizedProjectId,
      zone: normalizedZone,
      instance: normalizedInstanceName
    })

    const operationName = asString(response.data.name)
    const result = await waitForGcpZoneOperation(normalizedProjectId, normalizedZone, operationName)

    return {
      operationName,
      completed: result.completed,
      status: result.status,
      summary: buildGcpComputeDeleteSummary(normalizedInstanceName, result.completed)
    }
  } catch (error) {
    throw buildGcpSdkError(`deleting Compute Engine instance "${normalizedInstanceName}"`, error, 'compute.googleapis.com')
  }
}

export async function getGcpComputeSerialOutput(
  projectId: string,
  zone: string,
  instanceName: string,
  port = 1,
  start = 0
): Promise<GcpComputeSerialOutput> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedInstanceName) {
    return { contents: '', nextStart: 0, port }
  }

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildComputeApiUrl(normalizedProjectId, `zones/${normalizedZone}/instances/${normalizedInstanceName}/serialPort`, {
        port,
        start
      })
    })

    return {
      contents: asString(response.contents),
      nextStart: normalizeNumber(response.next),
      port
    }
  } catch (error) {
    throw buildGcpSdkError(`reading serial output for Compute Engine instance "${normalizedInstanceName}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpFirewallRules(projectId: string): Promise<GcpFirewallRuleSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const items: GcpFirewallRuleSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: unknown[]; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'global/firewalls', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      items.push(
        ...(response.items ?? [])
          .map((entry) => normalizeFirewallRule(entry))
          .filter((entry): entry is GcpFirewallRuleSummary => entry !== null)
      )

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing firewall rules for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpNetworks(projectId: string): Promise<GcpNetworkSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const items: GcpNetworkSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: unknown[]; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'global/networks', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      items.push(
        ...(response.items ?? [])
          .map((entry) => normalizeNetwork(entry))
          .filter((entry): entry is GcpNetworkSummary => entry !== null)
      )

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing VPC networks for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpSubnetworks(projectId: string, location: string): Promise<GcpSubnetworkSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const items: GcpSubnetworkSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: Record<string, { subnetworks?: unknown[] }>; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'aggregated/subnetworks', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const scoped of Object.values(response.items ?? {})) {
        for (const entry of scoped?.subnetworks ?? []) {
          const normalized = normalizeSubnetwork(entry)
          if (normalized) {
            items.push(normalized)
          }
        }
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return filterSubnetworksByLocation(items, location)
      .sort((left, right) => left.region.localeCompare(right.region) || left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing subnetworks for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpRouters(projectId: string, location: string): Promise<{ routers: GcpRouterSummary[]; nats: GcpRouterNatSummary[] }> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return { routers: [], nats: [] }
  }

  try {
    const routers: GcpRouterSummary[] = []
    const nats: GcpRouterNatSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: Record<string, { routers?: unknown[] }>; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'aggregated/routers', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const scoped of Object.values(response.items ?? {})) {
        for (const entry of scoped?.routers ?? []) {
          const router = normalizeRouter(entry)
          if (!router) {
            continue
          }

          routers.push(router)
          const record = toRecord(entry)
          for (const natEntry of Array.isArray(record.nats) ? record.nats : []) {
            const nat = normalizeRouterNat(natEntry, router.name, router.region)
            if (nat) {
              nats.push(nat)
            }
          }
        }
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return {
      routers: filterRoutersByLocation(routers, location)
        .sort((left, right) => left.region.localeCompare(right.region) || left.name.localeCompare(right.name)),
      nats: filterRoutersByLocation(nats, location)
        .sort((left, right) => left.region.localeCompare(right.region) || left.router.localeCompare(right.router) || left.name.localeCompare(right.name))
    }
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Routers for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpGlobalAddresses(projectId: string): Promise<GcpGlobalAddressSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const items: GcpGlobalAddressSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: unknown[]; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'global/addresses', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      items.push(
        ...(response.items ?? [])
          .map((entry) => normalizeGlobalAddress(entry))
          .filter((entry): entry is GcpGlobalAddressSummary => entry !== null)
      )

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing global addresses for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpServiceNetworkingConnections(projectId: string, networkNames: string[]): Promise<GcpServiceNetworkingConnectionSummary[]> {
  const normalizedProjectId = projectId.trim()
  const targets = [...new Set(networkNames.map((value) => resourceBasename(value)).filter(Boolean))]
  if (!normalizedProjectId || targets.length === 0) {
    return []
  }

  try {
    const items: GcpServiceNetworkingConnectionSummary[] = []

    for (const networkName of targets) {
      const response = await requestGcp<{ connections?: unknown[] }>(normalizedProjectId, {
        url: `https://servicenetworking.googleapis.com/v1/services/servicenetworking.googleapis.com/connections?network=${encodeURIComponent(`projects/${normalizedProjectId}/global/networks/${networkName}`)}`
      })

      items.push(
        ...(response.connections ?? [])
          .map((entry) => normalizeServiceNetworkingConnection(entry, networkName))
          .filter((entry): entry is GcpServiceNetworkingConnectionSummary => entry !== null)
      )
    }

    return items.sort((left, right) => left.network.localeCompare(right.network) || left.service.localeCompare(right.service))
  } catch (error) {
    throw buildGcpSdkError(`listing service networking connections for project "${normalizedProjectId}"`, error, 'servicenetworking.googleapis.com')
  }
}

export async function getGcpProjectOverview(projectId: string): Promise<GcpProjectOverview> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return {
      projectId: '',
      projectNumber: '',
      displayName: '',
      lifecycleState: '',
      parentType: '',
      parentId: '',
      createTime: '',
      labels: [],
      enabledApis: [],
      enabledApiCount: 0,
      capabilityHints: [],
      notes: []
    }
  }

  try {
    const [metadata, enabledApis] = await Promise.all([
      getGcpProjectMetadata(normalizedProjectId),
      listGcpEnabledApis(normalizedProjectId)
    ])

    const overview: GcpProjectOverview = {
      projectId: metadata.projectId,
      projectNumber: metadata.projectNumber,
      displayName: metadata.name,
      lifecycleState: metadata.lifecycleState,
      parentType: metadata.parentType,
      parentId: metadata.parentId,
      createTime: metadata.createTime,
      labels: Object.entries(metadata.labels)
        .map(([key, value]) => ({ key, value }))
        .sort((left, right) => left.key.localeCompare(right.key)),
      enabledApis: enabledApis.slice(0, 18),
      enabledApiCount: enabledApis.length,
      capabilityHints: [],
      notes: [
        'Enabled API sampling is trimmed in the UI for readability, but the total count reflects the full list returned by Service Usage.',
        'This slice focuses on project metadata and API posture. Quotas, IAM bindings, and organization policy are not wired yet.'
      ]
    }

    overview.capabilityHints = buildGcpProjectCapabilityHints(overview)
    return overview
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    const serviceName = detail.includes('service usage')
      ? 'serviceusage.googleapis.com'
      : 'cloudresourcemanager.googleapis.com'

    throw buildGcpSdkError(`loading project overview for project "${normalizedProjectId}"`, error, serviceName)
  }
}

export async function getGcpIamOverview(projectId: string): Promise<GcpIamOverview> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return {
      projectId: '',
      bindingCount: 0,
      principalCount: 0,
      riskyBindingCount: 0,
      publicPrincipalCount: 0,
      bindings: [],
      principals: [],
      serviceAccounts: [],
      capabilityHints: [],
      notes: []
    }
  }

  try {
    const [policy, serviceAccounts] = await Promise.all([
      getGcpProjectIamPolicy(normalizedProjectId),
      listGcpServiceAccounts(normalizedProjectId).catch((error) => {
        if (outputIndicatesApiDisabled(error instanceof Error ? error.message : String(error))) {
          throw buildGcpSdkError(`listing service accounts for project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
        }
        return []
      })
    ])

    const bindings = buildGcpIamBindings(policy)
    const principals = buildGcpIamPrincipals(bindings)
    const overview: GcpIamOverview = {
      projectId: normalizedProjectId,
      bindingCount: bindings.length,
      principalCount: principals.length,
      riskyBindingCount: bindings.filter((binding) => binding.risky).length,
      publicPrincipalCount: bindings.filter((binding) => binding.publicAccess).length,
      bindings,
      principals: principals.slice(0, 20),
      serviceAccounts: serviceAccounts.slice(0, 20),
      capabilityHints: [],
      notes: [
        'This slice evaluates project-level IAM policy only. Inherited organization or folder bindings are not expanded here.',
        'Service accounts are listed separately so operators can quickly see workload identities next to policy bindings.'
      ]
    }

    overview.capabilityHints = buildGcpIamCapabilityHints(overview)
    return overview
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    const serviceName = detail.includes('service account')
      ? 'iam.googleapis.com'
      : 'cloudresourcemanager.googleapis.com'

    throw buildGcpSdkError(`loading IAM posture for project "${normalizedProjectId}"`, error, serviceName)
  }
}

export async function addGcpIamBinding(projectId: string, role: string, member: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  try {
    const policy = await getGcpProjectIamPolicy(normalizedProjectId)
    const bindings = Array.isArray(policy.bindings) ? policy.bindings as Array<Record<string, unknown>> : []
    const existing = bindings.find((b) => asString(b.role) === role)
    if (existing) {
      const members = Array.isArray(existing.members) ? existing.members as string[] : []
      if (!members.includes(member)) {
        members.push(member)
        existing.members = members
      }
    } else {
      bindings.push({ role, members: [member] })
    }
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}:setIamPolicy`,
      method: 'POST',
      data: { policy: { ...policy, bindings }, updateMask: 'bindings' }
    })
  } catch (error) {
    throw buildGcpSdkError(`adding IAM binding for project "${normalizedProjectId}"`, error, 'cloudresourcemanager.googleapis.com')
  }
}

export async function removeGcpIamBinding(projectId: string, role: string, member: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  try {
    const policy = await getGcpProjectIamPolicy(normalizedProjectId)
    const bindings = Array.isArray(policy.bindings) ? (policy.bindings as Array<Record<string, unknown>>) : []
    const updated = bindings
      .map((b) => {
        if (asString(b.role) !== role) return b
        const members = (Array.isArray(b.members) ? b.members as string[] : []).filter((m) => m !== member)
        return members.length ? { ...b, members } : null
      })
      .filter((b): b is Record<string, unknown> => b !== null)
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}:setIamPolicy`,
      method: 'POST',
      data: { policy: { ...policy, bindings: updated }, updateMask: 'bindings' }
    })
  } catch (error) {
    throw buildGcpSdkError(`removing IAM binding for project "${normalizedProjectId}"`, error, 'cloudresourcemanager.googleapis.com')
  }
}

export async function createGcpServiceAccount(
  projectId: string,
  accountId: string,
  displayName: string,
  description: string
): Promise<GcpServiceAccountSummary> {
  const normalizedProjectId = projectId.trim()
  try {
    const result = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/serviceAccounts`,
      method: 'POST',
      data: { accountId, serviceAccount: { displayName, description } }
    })
    return {
      email: asString(result.email),
      displayName: asString(result.displayName),
      uniqueId: asString(result.uniqueId),
      description: asString(result.description),
      disabled: asBoolean(result.disabled)
    }
  } catch (error) {
    throw buildGcpSdkError(`creating service account in project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
  }
}

export async function deleteGcpServiceAccount(projectId: string, email: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  try {
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/serviceAccounts/${encodeURIComponent(email)}`,
      method: 'DELETE'
    })
  } catch (error) {
    throw buildGcpSdkError(`deleting service account "${email}" in project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
  }
}

export async function disableGcpServiceAccount(projectId: string, email: string, disable: boolean): Promise<void> {
  const normalizedProjectId = projectId.trim()
  const action = disable ? 'disable' : 'enable'
  try {
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/serviceAccounts/${encodeURIComponent(email)}:${action}`,
      method: 'POST',
      data: {}
    })
  } catch (error) {
    throw buildGcpSdkError(`${action}ing service account "${email}" in project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
  }
}

export async function listGcpServiceAccountKeys(projectId: string, email: string): Promise<GcpServiceAccountKeySummary[]> {
  const normalizedProjectId = projectId.trim()
  try {
    const result = await requestGcp<{ keys?: Array<Record<string, unknown>> }>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/serviceAccounts/${encodeURIComponent(email)}/keys?keyTypes=USER_MANAGED`
    })
    return (result.keys ?? []).map((k) => {
      const name = asString(k.name)
      const keyId = name.split('/').pop() ?? name
      return {
        name,
        keyId,
        keyType: asString(k.keyType),
        keyOrigin: asString(k.keyOrigin),
        validAfterTime: asString(k.validAfterTime),
        validBeforeTime: asString(k.validBeforeTime),
        disabled: asBoolean(k.disabled)
      } satisfies GcpServiceAccountKeySummary
    })
  } catch (error) {
    throw buildGcpSdkError(`listing keys for service account "${email}"`, error, 'iam.googleapis.com')
  }
}

export async function createGcpServiceAccountKey(
  projectId: string,
  email: string
): Promise<{ keyId: string; privateKeyData: string; validAfterTime: string; validBeforeTime: string }> {
  const normalizedProjectId = projectId.trim()
  try {
    const result = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/serviceAccounts/${encodeURIComponent(email)}/keys`,
      method: 'POST',
      data: { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' }
    })
    const name = asString(result.name)
    return {
      keyId: name.split('/').pop() ?? name,
      privateKeyData: asString(result.privateKeyData),
      validAfterTime: asString(result.validAfterTime),
      validBeforeTime: asString(result.validBeforeTime)
    }
  } catch (error) {
    throw buildGcpSdkError(`creating key for service account "${email}"`, error, 'iam.googleapis.com')
  }
}

export async function deleteGcpServiceAccountKey(projectId: string, email: string, keyId: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  try {
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/serviceAccounts/${encodeURIComponent(email)}/keys/${encodeURIComponent(keyId)}`,
      method: 'DELETE'
    })
  } catch (error) {
    throw buildGcpSdkError(`deleting key "${keyId}" for service account "${email}"`, error, 'iam.googleapis.com')
  }
}

export async function listGcpRoles(projectId: string, scope: 'custom' | 'all'): Promise<GcpIamRoleSummary[]> {
  const normalizedProjectId = projectId.trim()
  try {
    const roles: GcpIamRoleSummary[] = []
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const result = await requestGcp<{ roles?: Array<Record<string, unknown>>; nextPageToken?: string }>(normalizedProjectId, {
        url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/roles?view=FULL&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })
      for (const r of result.roles ?? []) {
        const name = asString(r.name)
        const perms = Array.isArray(r.includedPermissions) ? r.includedPermissions.map((p) => asString(p)).filter(Boolean) : []
        roles.push({
          name,
          title: asString(r.title) || name.split('/').pop() || name,
          description: asString(r.description),
          stage: asString(r.stage) || 'GA',
          isCustom: true,
          permissionCount: perms.length,
          includedPermissions: perms
        } satisfies GcpIamRoleSummary)
      }
      pageToken = asString(result.nextPageToken)
    } while (pageToken && canPage())

    if (scope === 'all') {
      let predefinedPageToken = ''
      do {
        const result = await requestGcp<{ roles?: Array<Record<string, unknown>>; nextPageToken?: string }>(normalizedProjectId, {
          url: `https://iam.googleapis.com/v1/roles?view=BASIC&pageSize=200${predefinedPageToken ? `&pageToken=${encodeURIComponent(predefinedPageToken)}` : ''}`
        })
        for (const r of result.roles ?? []) {
          const name = asString(r.name)
          if (!name) continue
          roles.push({
            name,
            title: asString(r.title) || name.split('/').pop() || name,
            description: asString(r.description),
            stage: asString(r.stage) || 'GA',
            isCustom: false,
            permissionCount: 0,
            includedPermissions: []
          } satisfies GcpIamRoleSummary)
        }
        predefinedPageToken = asString(result.nextPageToken)
      } while (predefinedPageToken)
    }

    return roles.sort((a, b) => {
      if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1
      return a.title.localeCompare(b.title)
    })
  } catch (error) {
    throw buildGcpSdkError(`listing roles for project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
  }
}

export async function createGcpCustomRole(
  projectId: string,
  roleId: string,
  title: string,
  description: string,
  includedPermissions: string[]
): Promise<GcpIamRoleSummary> {
  const normalizedProjectId = projectId.trim()
  try {
    const result = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}/roles`,
      method: 'POST',
      data: { roleId, role: { title, description, includedPermissions, stage: 'GA' } }
    })
    const name = asString(result.name)
    const perms = Array.isArray(result.includedPermissions)
      ? (result.includedPermissions as unknown[]).map((p) => asString(p as string)).filter(Boolean)
      : includedPermissions
    return {
      name,
      title: asString(result.title) || title,
      description: asString(result.description) || description,
      stage: asString(result.stage) || 'GA',
      isCustom: true,
      permissionCount: perms.length,
      includedPermissions: perms
    }
  } catch (error) {
    throw buildGcpSdkError(`creating custom role "${roleId}" in project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
  }
}

export async function deleteGcpCustomRole(projectId: string, roleName: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  try {
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: `https://iam.googleapis.com/v1/${encodeURIComponent(roleName)}`,
      method: 'DELETE'
    })
  } catch (error) {
    throw buildGcpSdkError(`deleting custom role "${roleName}" in project "${normalizedProjectId}"`, error, 'iam.googleapis.com')
  }
}

export async function testGcpIamPermissions(projectId: string, permissions: string[]): Promise<GcpIamTestPermissionsResult[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedPermissions = [...new Set(permissions.map((value) => value.trim()).filter(Boolean))]

  if (!normalizedProjectId || normalizedPermissions.length === 0) {
    return []
  }

  try {
    const executePermissionTest = async (
      targetPermissions: string[]
    ): Promise<{
      resolved: Map<string, boolean>
      failures: Map<string, unknown>
    }> => {
      try {
        const result = await requestGcp<{ permissions?: string[] }>(normalizedProjectId, {
          url: `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(normalizedProjectId)}:testIamPermissions`,
          method: 'POST',
          data: { permissions: targetPermissions }
        })
        const allowed = new Set(result.permissions ?? [])
        return {
          resolved: new Map(targetPermissions.map((permission) => [permission, allowed.has(permission)])),
          failures: new Map()
        }
      } catch (error) {
        if (targetPermissions.length === 1) {
          return {
            resolved: new Map(),
            failures: new Map([[targetPermissions[0], error]])
          }
        }

        const midpoint = Math.ceil(targetPermissions.length / 2)
        const [left, right] = await Promise.all([
          executePermissionTest(targetPermissions.slice(0, midpoint)),
          executePermissionTest(targetPermissions.slice(midpoint))
        ])

        return {
          resolved: new Map([...left.resolved, ...right.resolved]),
          failures: new Map([...left.failures, ...right.failures])
        }
      }
    }

    const outcome = await executePermissionTest(normalizedPermissions)
    if (outcome.resolved.size === 0 && outcome.failures.size > 0) {
      throw outcome.failures.values().next().value
    }

    return normalizedPermissions.map((permission) => ({
      permission,
      allowed: outcome.resolved.get(permission) ?? false
    }))
  } catch (error) {
    throw buildGcpSdkError(`testing IAM permissions for project "${normalizedProjectId}"`, error, 'cloudresourcemanager.googleapis.com')
  }
}

export async function listGcpGkeClusters(projectId: string, location: string): Promise<GcpGkeClusterSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const container = google.container({ version: 'v1' as never, auth: auth as never })
    const response = await container.projects.locations.clusters.list({
      parent: `projects/${normalizedProjectId}/locations/-`
    })
    const items = Array.isArray(response.data.clusters) ? response.data.clusters : []
    const clusters = items
      .map((cluster) => {
        const name = asString(cluster.name)
        if (!name) {
          return null
        }
        return {
          name,
          location: asString(cluster.location),
          status: asString(cluster.status),
          masterVersion: asString(cluster.currentMasterVersion),
          nodeCount: String(cluster.currentNodeCount ?? ''),
          releaseChannel: asString(cluster.releaseChannel?.channel),
          endpoint: asString(cluster.endpoint)
        } satisfies GcpGkeClusterSummary
      })
      .filter((entry): entry is GcpGkeClusterSummary => entry !== null)

    return filterGkeClustersByLocation(clusters, location)
      .sort((left, right) => left.location.localeCompare(right.location) || left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing GKE clusters for project "${normalizedProjectId}"`, error, 'container.googleapis.com')
  }
}

export async function getGcpGkeClusterDetail(projectId: string, location: string, clusterName: string): Promise<GcpGkeClusterDetail> {
  const normalizedProjectId = projectId.trim()
  const normalizedLocation = location.trim()
  const normalizedClusterName = clusterName.trim()

  if (!normalizedProjectId || !normalizedLocation || !normalizedClusterName) {
    throw new Error('Project, location, and cluster name are required to load GKE cluster detail.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const container = google.container({ version: 'v1' as never, auth: auth as never })
    const response = await container.projects.locations.clusters.get({
      name: `projects/${normalizedProjectId}/locations/${normalizedLocation}/clusters/${normalizedClusterName}`
    })
    const cluster = response.data

    return {
      name: asString(cluster.name) || normalizedClusterName,
      location: asString(cluster.location) || normalizedLocation,
      status: asString(cluster.status),
      endpoint: asString(cluster.endpoint),
      masterVersion: asString(cluster.currentMasterVersion),
      nodeVersion: asString(cluster.currentNodeVersion),
      releaseChannel: asString(cluster.releaseChannel?.channel),
      autopilotEnabled: asBoolean(cluster.autopilot?.enabled),
      privateClusterEnabled: asBoolean(cluster.privateClusterConfig?.enablePrivateNodes),
      shieldedNodesEnabled: asBoolean(cluster.shieldedNodes?.enabled),
      verticalPodAutoscalingEnabled: asBoolean(cluster.verticalPodAutoscaling?.enabled),
      currentNodeCount: normalizeNumber(cluster.currentNodeCount),
      nodePoolCount: Array.isArray(cluster.nodePools) ? cluster.nodePools.length : 0,
      workloadIdentityPool: asString(cluster.workloadIdentityConfig?.workloadPool),
      network: asString(cluster.network),
      subnetwork: asString(cluster.subnetwork),
      clusterIpv4Cidr: asString(cluster.clusterIpv4Cidr),
      servicesIpv4Cidr: asString(cluster.servicesIpv4Cidr),
      controlPlaneIpv4Cidr: asString(cluster.privateClusterConfig?.masterIpv4CidrBlock),
      loggingService: asString(cluster.loggingService),
      monitoringService: asString(cluster.monitoringService),
      maintenanceWindow: formatMaintenanceWindow(cluster.maintenancePolicy?.window),
      maintenanceExclusions: normalizeMaintenanceExclusions((cluster.maintenancePolicy as { maintenanceExclusions?: unknown } | undefined)?.maintenanceExclusions),
      resourceLabels: normalizeStringRecord(cluster.resourceLabels)
    }
  } catch (error) {
    throw buildGcpSdkError(`loading GKE cluster detail for "${normalizedClusterName}"`, error, 'container.googleapis.com')
  }
}

async function resolveGkeNodePoolTargetSize(projectId: string, instanceGroupUrls: string[], fallback: number): Promise<number> {
  const targets = instanceGroupUrls.map((value) => value.trim()).filter(Boolean)
  if (targets.length === 0) {
    return fallback
  }

  const sizes = await Promise.all(targets.map(async (url) => {
    try {
      const response = await requestGcp<Record<string, unknown>>(projectId, { url })
      return normalizeNumber(response.targetSize)
    } catch (error) {
      logWarn('gcpSdk.resolveGkeNodePoolTargetSize', 'Failed to fetch instance group target size; reporting 0.', { url }, error)
      return 0
    }
  }))

  const total = sizes.reduce((sum, value) => sum + value, 0)
  return total > 0 ? total : fallback
}

export async function listGcpGkeNodePools(projectId: string, location: string, clusterName: string): Promise<GcpGkeNodePoolSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedLocation = location.trim()
  const normalizedClusterName = clusterName.trim()

  if (!normalizedProjectId || !normalizedLocation || !normalizedClusterName) {
    return []
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const container = google.container({ version: 'v1' as never, auth: auth as never })
    const response = await container.projects.locations.clusters.nodePools.list({
      parent: `projects/${normalizedProjectId}/locations/${normalizedLocation}/clusters/${normalizedClusterName}`
    })
    const items = Array.isArray(response.data.nodePools) ? response.data.nodePools : []

    const normalizedItems = await Promise.all(items.map(async (pool) => {
        const name = asString(pool.name)
        if (!name) {
          return null
        }

        const autoscalingEnabled = asBoolean(pool.autoscaling?.enabled)
        const minNodeCount = normalizeNumber(pool.autoscaling?.minNodeCount)
        const maxNodeCount = normalizeNumber(pool.autoscaling?.maxNodeCount)
        const fallbackNodeCount = normalizeNumber(pool.initialNodeCount)
        const nodeCount = await resolveGkeNodePoolTargetSize(
          normalizedProjectId,
          asStringArray((pool as { instanceGroupUrls?: unknown }).instanceGroupUrls),
          fallbackNodeCount
        )

        return {
          name,
          status: asString(pool.status),
          version: asString(pool.version),
          nodeCount,
          minNodeCount,
          maxNodeCount,
          machineType: asString(pool.config?.machineType),
          imageType: asString(pool.config?.imageType),
          diskSizeGb: String(pool.config?.diskSizeGb ?? ''),
          autoscaling: autoscalingEnabled ? `${minNodeCount}-${maxNodeCount}` : 'disabled',
          autoUpgradeEnabled: asBoolean(pool.management?.autoUpgrade),
          autoRepairEnabled: asBoolean(pool.management?.autoRepair),
          spotEnabled: asBoolean(pool.config?.spot),
          preemptible: asBoolean(pool.config?.preemptible),
          locations: asStringArray(pool.locations)
        } satisfies GcpGkeNodePoolSummary
      }))

    return normalizedItems
      .filter((entry): entry is GcpGkeNodePoolSummary => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing GKE node pools for "${normalizedClusterName}"`, error, 'container.googleapis.com')
  }
}

export async function getGcpGkeClusterCredentials(
  projectId: string,
  location: string,
  clusterName: string,
  requestedContextName?: string,
  kubeconfigPath = '~/.kube/config'
): Promise<GcpGkeClusterCredentials> {
  const normalizedProjectId = projectId.trim()
  const normalizedLocation = location.trim()
  const normalizedClusterName = clusterName.trim()

  if (!normalizedProjectId || !normalizedLocation || !normalizedClusterName) {
    throw new Error('Project, location, and cluster name are required to load GKE credentials.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const client = await auth.getClient()
    const accessToken = await client.getAccessToken()
    const bearerToken = typeof accessToken === 'string'
      ? accessToken
      : asString(accessToken?.token)

    if (!bearerToken) {
      throw new Error('Unable to obtain an access token from the active Google Cloud credentials.')
    }

    const container = google.container({ version: 'v1' as never, auth: auth as never })
    const response = await container.projects.locations.clusters.get({
      name: `projects/${normalizedProjectId}/locations/${normalizedLocation}/clusters/${normalizedClusterName}`
    })
    const cluster = response.data
    const endpoint = asString(cluster.endpoint)
    if (!endpoint) {
      throw new Error(`Cluster "${normalizedClusterName}" did not return an API endpoint.`)
    }

    const certificateAuthorityData = asString(cluster.masterAuth?.clusterCaCertificate)
    const normalizedContextName = requestedContextName?.trim()
    const contextName = normalizedContextName || buildGkeContextName(normalizedProjectId, normalizedLocation, normalizedClusterName)
    const credentialsWithExpiry = client as { credentials?: { expiry_date?: number | null } }
    const expiryDate = credentialsWithExpiry.credentials?.expiry_date
    const tokenExpiresAt = typeof expiryDate === 'number' && Number.isFinite(expiryDate)
      ? new Date(expiryDate).toISOString()
      : ''

    return {
      clusterName: normalizedClusterName,
      location: normalizedLocation,
      endpoint,
      contextName,
      kubeconfigPath: kubeconfigPath.trim() || '~/.kube/config',
      authProvider: 'Application Default Credentials',
      tokenPreview: maskSecret(bearerToken),
      tokenExpiresAt,
      certificateAuthorityData,
      bearerToken,
      kubeconfigYaml: buildGkeKubeconfigYaml(contextName, endpoint, certificateAuthorityData, bearerToken)
    }
  } catch (error) {
    throw buildGcpSdkError(`loading GKE credentials for "${normalizedClusterName}"`, error, 'container.googleapis.com')
  }
}

export async function listGcpGkeOperations(projectId: string, location: string, clusterName: string): Promise<GcpGkeOperationSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedLocation = location.trim()
  const normalizedClusterName = clusterName.trim()

  if (!normalizedProjectId || !normalizedLocation || !normalizedClusterName) {
    return []
  }

  try {
    const response = await requestGcp<{ operations?: unknown[] }>(normalizedProjectId, {
      url: buildContainerApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/locations/${encodeURIComponent(normalizedLocation)}/operations`)
    })

    return (response.operations ?? [])
      .map((entry) => {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const target = asString(record.targetLink)
        const id = asString(record.name)
        if (!id || (!target.includes(`/clusters/${normalizedClusterName}`) && !asString(record.detail).includes(normalizedClusterName))) {
          return null
        }

        return {
          id,
          type: asString(record.operationType) || asString(record.type),
          status: asString(record.status),
          detail: asString(record.detail) || asString(record.statusMessage),
          target,
          location: asString(record.location) || normalizedLocation,
          startedAt: asString(record.startTime),
          endedAt: asString(record.endTime)
        } satisfies GcpGkeOperationSummary
      })
      .filter((entry): entry is GcpGkeOperationSummary => entry !== null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  } catch (error) {
    throw buildGcpSdkError(`listing GKE operations for "${normalizedClusterName}"`, error, 'container.googleapis.com')
  }
}

export async function updateGcpGkeNodePoolScaling(
  projectId: string,
  location: string,
  clusterName: string,
  nodePoolName: string,
  minimum: number,
  desired: number,
  maximum: number
): Promise<GcpGkeOperationResult> {
  const normalizedProjectId = projectId.trim()
  const normalizedLocation = location.trim()
  const normalizedClusterName = clusterName.trim()
  const normalizedNodePoolName = nodePoolName.trim()

  if (!normalizedProjectId || !normalizedLocation || !normalizedClusterName || !normalizedNodePoolName) {
    throw new Error('Project, location, cluster, and node pool are required.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const container = google.container({ version: 'v1' as never, auth: auth as never })
    const nodePools = (((container.projects as any)?.locations as any)?.clusters?.nodePools ?? {}) as Record<string, (...args: unknown[]) => Promise<unknown>>
    const nodePoolPath = `projects/${normalizedProjectId}/locations/${normalizedLocation}/clusters/${normalizedClusterName}/nodePools/${normalizedNodePoolName}`

    const autoscalingResponse = await nodePools.setAutoscaling?.({
      name: nodePoolPath,
      requestBody: {
        autoscaling: {
          enabled: true,
          minNodeCount: minimum,
          maxNodeCount: maximum
        }
      }
    }) as { data?: Record<string, unknown> } | undefined

    const autoscalingOperationName = asString(autoscalingResponse?.data?.name)
    if (autoscalingOperationName) {
      await waitForGkeOperation(normalizedProjectId, normalizedLocation, autoscalingOperationName)
    }

    const sizeResponse = await nodePools.setSize?.({
      name: nodePoolPath,
      requestBody: {
        nodeCount: desired
      }
    }) as { data?: Record<string, unknown> } | undefined

    const operationName = asString(sizeResponse?.data?.name) || autoscalingOperationName
    const result = operationName
      ? await waitForGkeOperation(normalizedProjectId, normalizedLocation, operationName)
      : { completed: true, status: 'DONE' }

    return {
      operationName,
      completed: result.completed,
      status: result.status,
      summary: `Scaled node pool ${normalizedNodePoolName} to min ${minimum}, desired ${desired}, max ${maximum}.`
    }
  } catch (error) {
    throw buildGcpSdkError(`scaling GKE node pool "${normalizedNodePoolName}"`, error, 'container.googleapis.com')
  }
}

export async function listGcpStorageBuckets(projectId: string, location: string): Promise<GcpStorageBucketSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const response = await requestGcp<{ items?: unknown[] }>(normalizedProjectId, {
      url: buildStorageApiUrl('/storage/v1/b', {
        project: normalizedProjectId,
        maxResults: 500
      })
    })
    const buckets = (response.items ?? [])
      .map((bucket) => normalizeStorageBucket(bucket))
      .filter((entry): entry is GcpStorageBucketSummary => entry !== null)

    return filterStorageBucketsByLocation(buckets, location)
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Storage buckets for project "${normalizedProjectId}"`, error, 'storage.googleapis.com')
  }
}

export async function listGcpStorageObjects(projectId: string, bucketName: string, prefix = ''): Promise<GcpStorageObjectSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedBucketName = bucketName.trim()
  const normalizedPrefix = prefix.trim()
  if (!normalizedProjectId || !normalizedBucketName) {
    return []
  }

  try {
    const response = await requestGcp<{ items?: unknown[]; prefixes?: string[] }>(normalizedProjectId, {
      url: buildStorageApiUrl(`/storage/v1/b/${encodeURIComponent(normalizedBucketName)}/o`, {
        maxResults: 500,
        prefix: normalizedPrefix || undefined,
        delimiter: '/'
      })
    })

    const records = [
      ...(response.items ?? [])
        .map((file) => normalizeStorageObjectRecord(file, normalizedBucketName))
        .filter((entry): entry is GcpStorageObjectRecord => entry !== null),
      ...(response.prefixes ?? []).map((folderPrefix) => ({
        key: folderPrefix,
        size: 0,
        lastModified: '',
        storageClass: ''
      }))
    ]

    return buildGcpStorageObjectSummaries(records, normalizedPrefix)
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Storage objects for bucket "${normalizedBucketName}"`, error, 'storage.googleapis.com')
  }
}

export async function getGcpStorageObjectContent(projectId: string, bucketName: string, key: string): Promise<GcpStorageObjectContent> {
  const normalizedProjectId = projectId.trim()
  const normalizedBucketName = bucketName.trim()
  const normalizedKey = key.trim()
  if (!normalizedProjectId || !normalizedBucketName || !normalizedKey) {
    return { body: '', contentType: guessContentTypeFromKey(normalizedKey) }
  }

  try {
    const objectPath = `/storage/v1/b/${encodeURIComponent(normalizedBucketName)}/o/${encodeStorageObjectKey(normalizedKey)}`
    const [metadata, body] = await Promise.all([
      requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildStorageApiUrl(objectPath)
      }),
      requestGcp<string>(normalizedProjectId, {
        url: buildStorageApiUrl(objectPath, { alt: 'media' }),
        responseType: 'text'
      })
    ])

    return {
      body,
      contentType: asString(metadata.contentType) || guessContentTypeFromKey(normalizedKey)
    }
  } catch (error) {
    throw buildGcpSdkError(`reading Cloud Storage object "${normalizedKey}"`, error, 'storage.googleapis.com')
  }
}

export async function putGcpStorageObjectContent(projectId: string, bucketName: string, key: string, content: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  const normalizedBucketName = bucketName.trim()
  const normalizedKey = key.trim()
  if (!normalizedProjectId || !normalizedBucketName || !normalizedKey) {
    return
  }

  try {
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildStorageApiUrl(`/upload/storage/v1/b/${encodeURIComponent(normalizedBucketName)}/o`, {
        uploadType: 'media',
        name: normalizedKey
      }),
      method: 'POST',
      headers: {
        'Content-Type': guessContentTypeFromKey(normalizedKey)
      },
      data: content
    })
  } catch (error) {
    throw buildGcpSdkError(`writing Cloud Storage object "${normalizedKey}"`, error, 'storage.googleapis.com')
  }
}

export async function uploadGcpStorageObject(projectId: string, bucketName: string, key: string, localPath: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  const normalizedBucketName = bucketName.trim()
  const normalizedKey = key.trim()
  const normalizedLocalPath = localPath.trim()
  if (!normalizedProjectId || !normalizedBucketName || !normalizedKey || !normalizedLocalPath) {
    return
  }

  try {
    const fileBody = await readFile(normalizedLocalPath)
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildStorageApiUrl(`/upload/storage/v1/b/${encodeURIComponent(normalizedBucketName)}/o`, {
        uploadType: 'media',
        name: normalizedKey
      }),
      method: 'POST',
      headers: {
        'Content-Type': guessContentTypeFromKey(normalizedKey || normalizedLocalPath)
      },
      data: fileBody
    })
  } catch (error) {
    throw buildGcpSdkError(`uploading Cloud Storage object "${normalizedKey}"`, error, 'storage.googleapis.com')
  }
}

export async function downloadGcpStorageObjectToPath(projectId: string, bucketName: string, key: string): Promise<string> {
  const normalizedProjectId = projectId.trim()
  const normalizedBucketName = bucketName.trim()
  const normalizedKey = key.trim()
  if (!normalizedProjectId || !normalizedBucketName || !normalizedKey) {
    return ''
  }

  const fileName = path.basename(normalizedKey) || 'download'
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(owner, {
    defaultPath: fileName,
    title: 'Save Cloud Storage Object'
  })

  if (result.canceled || !result.filePath) {
    return ''
  }

  try {
    const body = await requestGcp<ArrayBuffer | Buffer | Uint8Array>(normalizedProjectId, {
      url: buildStorageApiUrl(`/storage/v1/b/${encodeURIComponent(normalizedBucketName)}/o/${encodeStorageObjectKey(normalizedKey)}`, {
        alt: 'media'
      }),
      responseType: 'arraybuffer'
    })
    await writeFile(result.filePath, asBuffer(body))
    return result.filePath
  } catch (error) {
    throw buildGcpSdkError(`downloading Cloud Storage object "${normalizedKey}"`, error, 'storage.googleapis.com')
  }
}

export async function deleteGcpStorageObject(projectId: string, bucketName: string, key: string): Promise<void> {
  const normalizedProjectId = projectId.trim()
  const normalizedBucketName = bucketName.trim()
  const normalizedKey = key.trim()
  if (!normalizedProjectId || !normalizedBucketName || !normalizedKey) {
    return
  }

  try {
    await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildStorageApiUrl(`/storage/v1/b/${encodeURIComponent(normalizedBucketName)}/o/${encodeStorageObjectKey(normalizedKey)}`),
      method: 'DELETE'
    })
  } catch (error) {
    throw buildGcpSdkError(`deleting Cloud Storage object "${normalizedKey}"`, error, 'storage.googleapis.com')
  }
}

export async function listGcpLogEntries(projectId: string, location: string, query: string, windowHours = 24): Promise<GcpLogQueryResult> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return {
      query: '',
      entries: [],
      severityCounts: [],
      resourceTypeCounts: []
    }
  }

  const appliedFilter = buildGcpLogFilter(location, query, windowHours)

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const logging = google.logging({ version: 'v2' as never, auth: auth as never })
    const response = await logging.entries.list({
      requestBody: {
        resourceNames: [`projects/${normalizedProjectId}`],
        orderBy: 'timestamp desc',
        pageSize: 100,
        filter: appliedFilter
      }
    } as never)

    const entries = ((response.data.entries as unknown[]) ?? [])
      .map((entry) => normalizeLogEntry(entry))
      .filter((entry): entry is GcpLogEntrySummary => entry !== null)

    return {
      query: appliedFilter,
      entries,
      severityCounts: toFacetCounts(entries.map((entry) => entry.severity)),
      resourceTypeCounts: toFacetCounts(entries.map((entry) => entry.resourceType))
    }
  } catch (error) {
    throw buildGcpSdkError(`querying Cloud Logging entries for project "${normalizedProjectId}"`, error, 'logging.googleapis.com')
  }
}

export async function listGcpSqlInstances(projectId: string, location: string): Promise<GcpSqlInstanceSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const sqladmin = google.sqladmin({ version: 'v1beta4', auth })
    const response = await sqladmin.instances.list({ project: normalizedProjectId, maxResults: 500 })
    const instances = ((response.data.items as unknown[]) ?? [])
      .map((entry) => normalizeSqlInstance(entry))
      .filter((entry): entry is GcpSqlInstanceSummary => entry !== null)

    return filterSqlInstancesByLocation(instances, location)
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud SQL instances for project "${normalizedProjectId}"`, error, 'sqladmin.googleapis.com')
  }
}

export async function listGcpSqlDatabasesForInstances(projectId: string, instanceNames: string[] = []): Promise<GcpSqlScopedDatabaseSummary[]> {
  const normalizedProjectId = projectId.trim()
  const targets = [...new Set(instanceNames.map((value) => value.trim()).filter(Boolean))]
  if (!normalizedProjectId || targets.length === 0) {
    return []
  }

  try {
    const items: GcpSqlScopedDatabaseSummary[] = []

    for (const instanceName of targets) {
      const response = await requestGcp<{ items?: unknown[] }>(normalizedProjectId, {
        url: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${encodeURIComponent(normalizedProjectId)}/instances/${encodeURIComponent(instanceName)}/databases`
      })

      items.push(
        ...(response.items ?? [])
          .map((entry) => normalizeScopedSqlDatabase(entry, instanceName))
          .filter((entry): entry is GcpSqlScopedDatabaseSummary => entry !== null)
      )
    }

    return items.sort((left, right) => left.instance.localeCompare(right.instance) || left.name.localeCompare(right.name))
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud SQL databases for project "${normalizedProjectId}"`, error, 'sqladmin.googleapis.com')
  }
}

export async function listGcpSqlUsers(projectId: string, instanceNames: string[] = []): Promise<GcpSqlUserSummary[]> {
  const normalizedProjectId = projectId.trim()
  const targets = [...new Set(instanceNames.map((value) => value.trim()).filter(Boolean))]
  if (!normalizedProjectId || targets.length === 0) {
    return []
  }

  try {
    const items: GcpSqlUserSummary[] = []

    for (const instanceName of targets) {
      const response = await requestGcp<{ items?: unknown[] }>(normalizedProjectId, {
        url: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${encodeURIComponent(normalizedProjectId)}/instances/${encodeURIComponent(instanceName)}/users`
      })

      items.push(
        ...(response.items ?? [])
          .map((entry) => normalizeSqlUser(entry, instanceName))
          .filter((entry): entry is GcpSqlUserSummary => entry !== null)
      )
    }

    return items.sort((left, right) => left.instance.localeCompare(right.instance) || left.name.localeCompare(right.name) || left.host.localeCompare(right.host))
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud SQL users for project "${normalizedProjectId}"`, error, 'sqladmin.googleapis.com')
  }
}

export async function getGcpSqlInstanceDetail(projectId: string, instanceName: string): Promise<GcpSqlInstanceDetail> {
  const normalizedProjectId = projectId.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedInstanceName) {
    throw new Error('Project and instance name are required to load Cloud SQL instance detail.')
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const sqladmin = google.sqladmin({ version: 'v1beta4', auth })
    const response = await sqladmin.instances.get({
      project: normalizedProjectId,
      instance: normalizedInstanceName
    })
    const detail = normalizeSqlInstanceDetail(response.data)

    if (!detail) {
      throw new Error(`Cloud SQL instance "${normalizedInstanceName}" was not found in project "${normalizedProjectId}".`)
    }

    return detail
  } catch (error) {
    throw buildGcpSdkError(`loading Cloud SQL instance detail for "${normalizedInstanceName}"`, error, 'sqladmin.googleapis.com')
  }
}

export async function listGcpSqlDatabases(projectId: string, instanceName: string): Promise<GcpSqlDatabaseSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedInstanceName) {
    return []
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const sqladmin = google.sqladmin({ version: 'v1beta4', auth })
    const response = await sqladmin.databases.list({
      project: normalizedProjectId,
      instance: normalizedInstanceName
    })

    return ((response.data.items as unknown[]) ?? [])
      .map((entry) => normalizeSqlDatabase(entry))
      .filter((entry): entry is GcpSqlDatabaseSummary => entry !== null)
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud SQL databases for "${normalizedInstanceName}"`, error, 'sqladmin.googleapis.com')
  }
}

export async function listGcpSqlOperations(projectId: string, instanceName: string): Promise<GcpSqlOperationSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedInstanceName = instanceName.trim()

  if (!normalizedProjectId || !normalizedInstanceName) {
    return []
  }

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const sqladmin = google.sqladmin({ version: 'v1beta4', auth })
    const response = await sqladmin.operations.list({
      project: normalizedProjectId,
      instance: normalizedInstanceName,
      maxResults: 20
    })

    return ((response.data.items as unknown[]) ?? [])
      .map((entry) => normalizeSqlOperation(entry))
      .filter((entry): entry is GcpSqlOperationSummary => entry !== null)
      .sort((left, right) => right.insertTime.localeCompare(left.insertTime))
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud SQL operations for "${normalizedInstanceName}"`, error, 'sqladmin.googleapis.com')
  }
}

export async function getGcpBillingOverview(projectId: string, catalogProjectIds: string[] = []): Promise<GcpBillingOverview> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return {
      projectId: '',
      projectNumber: '',
      projectName: '',
      billingEnabled: false,
      billingAccountName: '',
      billingAccountDisplayName: '',
      billingAccountOpen: false,
      accessibleProjectCount: 0,
      linkedProjects: [],
      capabilityHints: [],
      ownershipHints: [],
      spendTelemetry: buildDefaultGcpSpendTelemetry('missing-export', 'Select a project to load GCP billing telemetry.'),
      notes: [],
      projectLabelCount: 0,
      linkedProjectLabelCoveragePercent: 0,
      visibility: 'project-only',
      lastUpdatedAt: new Date().toISOString()
    }
  }

  try {
    const currentBillingInfo = await getGcpProjectBillingInfo(normalizedProjectId)
    const currentMetadata = await getGcpProjectMetadata(normalizedProjectId).catch(() => null)
    const currentRecord = buildGcpBillingProjectRecord(normalizedProjectId, currentMetadata, currentBillingInfo)
    const uniqueCandidateIds = [...new Set([normalizedProjectId, ...catalogProjectIds.map((value) => value.trim()).filter(Boolean)])].slice(0, 24)
    let linkedProjects: GcpBillingProjectRecord[] = [currentRecord]
    let billingAccountDisplayName = ''
    let billingAccountOpen = false
    let visibility: GcpBillingOverview['visibility'] = 'project-only'

    if (currentBillingInfo.billingAccountName) {
      visibility = 'billing-account-only'

      try {
        const accountMetadata = await getGcpBillingAccountMetadata(normalizedProjectId, currentBillingInfo.billingAccountName)
        billingAccountDisplayName = accountMetadata.displayName
        billingAccountOpen = accountMetadata.open
      } catch (error) {
        if (outputIndicatesApiDisabled(error instanceof Error ? error.message : String(error))) {
          throw buildGcpSdkError(`loading billing account metadata for project "${normalizedProjectId}"`, error, 'cloudbilling.googleapis.com')
        }
      }

      const candidateRecords = await Promise.all(uniqueCandidateIds.map(async (candidateProjectId) => {
        try {
          const billingInfo = candidateProjectId === normalizedProjectId
            ? currentBillingInfo
            : await getGcpProjectBillingInfo(candidateProjectId)

          if (billingInfo.billingAccountName !== currentBillingInfo.billingAccountName || !billingInfo.billingEnabled) {
            return null
          }

          const metadata = candidateProjectId === normalizedProjectId
            ? currentMetadata
            : await getGcpProjectMetadata(candidateProjectId).catch(() => null)

          return buildGcpBillingProjectRecord(candidateProjectId, metadata, billingInfo)
        } catch {
          return null
        }
      }))

      linkedProjects = candidateRecords.filter((entry): entry is GcpBillingProjectRecord => entry !== null)
      if (linkedProjects.length > 0) {
        visibility = 'full'
      }
    }

    const ownershipHints = computeGcpBillingOwnershipHints(linkedProjects)
    const spendTelemetryProjectIds = linkedProjects.length > 0
      ? linkedProjects.map((entry) => entry.projectId)
      : [normalizedProjectId]
    const spendTelemetry = await loadGcpBillingSpendTelemetry(normalizedProjectId, spendTelemetryProjectIds, currentRecord.billingEnabled)
    const linkedProjectLabelCoveragePercent = linkedProjects.length === 0
      ? 0
      : (linkedProjects.filter((entry) => entry.labelCount > 0).length / linkedProjects.length) * 100
    const overview: GcpBillingOverview = {
      projectId: currentRecord.projectId,
      projectNumber: currentRecord.projectNumber,
      projectName: currentRecord.name,
      billingEnabled: currentRecord.billingEnabled,
      billingAccountName: currentRecord.billingAccountName,
      billingAccountDisplayName,
      billingAccountOpen,
      accessibleProjectCount: uniqueCandidateIds.length,
      linkedProjects: linkedProjects
        .map((entry) => ({
          projectId: entry.projectId,
          name: entry.name,
          projectNumber: entry.projectNumber,
          lifecycleState: entry.lifecycleState,
          labelCount: entry.labelCount,
          billingEnabled: entry.billingEnabled
        } satisfies GcpBillingLinkedProjectSummary))
        .sort((left, right) => left.projectId.localeCompare(right.projectId)),
      capabilityHints: [],
      ownershipHints,
      spendTelemetry,
      notes: [
        'Linked-project analysis is limited to projects visible in the current catalog and under the current credentials.',
        spendTelemetry.message
      ],
      projectLabelCount: currentRecord.labelCount,
      linkedProjectLabelCoveragePercent,
      visibility,
      lastUpdatedAt: new Date().toISOString()
    }

    overview.capabilityHints = buildGcpBillingCapabilityHints(overview, normalizedProjectId)
    return overview
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const serviceName = detail.toLowerCase().includes('cloud resource manager')
      ? 'cloudresourcemanager.googleapis.com'
      : 'cloudbilling.googleapis.com'

    throw buildGcpSdkError(`loading Billing overview for project "${normalizedProjectId}"`, error, serviceName)
  }
}

// ---------------------------------------------------------------------------
// Pub/Sub
// ---------------------------------------------------------------------------

function buildPubSubApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://pubsub.googleapis.com/v1/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export async function listGcpPubSubTopics(projectId: string): Promise<import('@shared/types').GcpPubSubTopicSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const topics: import('@shared/types').GcpPubSubTopicSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildPubSubApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/topics`, {
          pageSize: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.topics) ? response.topics : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        const topicId = name.split('/').pop() ?? name
        const labels = record.labels && typeof record.labels === 'object' ? record.labels as Record<string, string> : {}
        const schemaSettings = record.schemaSettings && typeof record.schemaSettings === 'object'
          ? asString((record.schemaSettings as Record<string, unknown>).schema)
          : ''

        topics.push({
          name,
          topicId,
          labels,
          messageRetentionDuration: asString(record.messageRetentionDuration),
          kmsKeyName: asString(record.kmsKeyName),
          schemaSettings
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return topics
  } catch (error) {
    throw buildGcpSdkError(`listing Pub/Sub topics for project "${normalizedProjectId}"`, error, 'pubsub.googleapis.com')
  }
}

export async function listGcpPubSubSubscriptions(projectId: string): Promise<import('@shared/types').GcpPubSubSubscriptionSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const subscriptions: import('@shared/types').GcpPubSubSubscriptionSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildPubSubApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/subscriptions`, {
          pageSize: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.subscriptions) ? response.subscriptions : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        const subscriptionId = name.split('/').pop() ?? name
        const topic = asString(record.topic)
        const topicId = topic.split('/').pop() ?? topic
        const pushConfig = record.pushConfig && typeof record.pushConfig === 'object'
          ? record.pushConfig as Record<string, unknown>
          : null
        const pushEndpoint = pushConfig ? asString(pushConfig.pushEndpoint) : ''
        const bigqueryConfig = record.bigqueryConfig && typeof record.bigqueryConfig === 'object' ? record.bigqueryConfig : null
        const cloudStorageConfig = record.cloudStorageConfig && typeof record.cloudStorageConfig === 'object' ? record.cloudStorageConfig : null

        let deliveryType = 'pull'
        if (pushEndpoint) deliveryType = 'push'
        else if (bigqueryConfig) deliveryType = 'bigquery'
        else if (cloudStorageConfig) deliveryType = 'cloud-storage'

        subscriptions.push({
          name,
          subscriptionId,
          topic,
          topicId,
          ackDeadlineSeconds: normalizeNumber(record.ackDeadlineSeconds),
          messageRetentionDuration: asString(record.messageRetentionDuration),
          pushEndpoint,
          deliveryType,
          filter: asString(record.filter),
          enableExactlyOnceDelivery: asBoolean(record.enableExactlyOnceDelivery),
          state: asString(record.state) || 'ACTIVE',
          detached: asBoolean(record.detached)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return subscriptions
  } catch (error) {
    throw buildGcpSdkError(`listing Pub/Sub subscriptions for project "${normalizedProjectId}"`, error, 'pubsub.googleapis.com')
  }
}

export async function getGcpPubSubTopicDetail(projectId: string, topicId: string): Promise<import('@shared/types').GcpPubSubTopicDetail> {
  const normalizedProjectId = projectId.trim()
  const normalizedTopicId = topicId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildPubSubApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/topics/${encodeURIComponent(normalizedTopicId)}`)
    })

    const name = asString(response.name) || `projects/${normalizedProjectId}/topics/${normalizedTopicId}`
    const labels = response.labels && typeof response.labels === 'object' ? response.labels as Record<string, string> : {}
    const schemaSettings = response.schemaSettings && typeof response.schemaSettings === 'object'
      ? asString((response.schemaSettings as Record<string, unknown>).schema)
      : ''

    const subscriptions = await listGcpPubSubSubscriptions(normalizedProjectId)
    const subscriptionCount = subscriptions.filter((sub) => sub.topicId === normalizedTopicId).length

    return {
      name,
      topicId: normalizedTopicId,
      labels,
      messageRetentionDuration: asString(response.messageRetentionDuration),
      kmsKeyName: asString(response.kmsKeyName),
      schemaSettings,
      subscriptionCount
    }
  } catch (error) {
    throw buildGcpSdkError(`getting Pub/Sub topic detail for "${normalizedTopicId}"`, error, 'pubsub.googleapis.com')
  }
}

export async function getGcpPubSubSubscriptionDetail(projectId: string, subscriptionId: string): Promise<import('@shared/types').GcpPubSubSubscriptionDetail> {
  const normalizedProjectId = projectId.trim()
  const normalizedSubscriptionId = subscriptionId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildPubSubApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/subscriptions/${encodeURIComponent(normalizedSubscriptionId)}`)
    })

    const pushConfig = response.pushConfig && typeof response.pushConfig === 'object'
      ? response.pushConfig as Record<string, unknown>
      : null
    const pushEndpoint = pushConfig ? asString(pushConfig.pushEndpoint) : ''
    const pushAttributes = pushConfig && pushConfig.attributes && typeof pushConfig.attributes === 'object'
      ? pushConfig.attributes as Record<string, string>
      : {}

    const deadLetterPolicy = response.deadLetterPolicy && typeof response.deadLetterPolicy === 'object'
      ? response.deadLetterPolicy as Record<string, unknown>
      : null

    const retryPolicy = response.retryPolicy && typeof response.retryPolicy === 'object'
      ? response.retryPolicy as Record<string, unknown>
      : null

    const expirationPolicy = response.expirationPolicy && typeof response.expirationPolicy === 'object'
      ? response.expirationPolicy as Record<string, unknown>
      : null

    return {
      name: asString(response.name),
      subscriptionId: normalizedSubscriptionId,
      topic: asString(response.topic),
      ackDeadlineSeconds: normalizeNumber(response.ackDeadlineSeconds),
      messageRetentionDuration: asString(response.messageRetentionDuration),
      retainAckedMessages: asBoolean(response.retainAckedMessages),
      pushConfig: pushEndpoint ? { pushEndpoint, attributes: pushAttributes } : null,
      deadLetterPolicy: deadLetterPolicy
        ? { deadLetterTopic: asString(deadLetterPolicy.deadLetterTopic), maxDeliveryAttempts: normalizeNumber(deadLetterPolicy.maxDeliveryAttempts) }
        : null,
      retryPolicy: retryPolicy
        ? { minimumBackoff: asString(retryPolicy.minimumBackoff), maximumBackoff: asString(retryPolicy.maximumBackoff) }
        : null,
      filter: asString(response.filter),
      enableExactlyOnceDelivery: asBoolean(response.enableExactlyOnceDelivery),
      state: asString(response.state) || 'ACTIVE',
      expirationTtl: expirationPolicy ? asString(expirationPolicy.ttl) : ''
    }
  } catch (error) {
    throw buildGcpSdkError(`getting Pub/Sub subscription detail for "${normalizedSubscriptionId}"`, error, 'pubsub.googleapis.com')
  }
}

// ---------------------------------------------------------------------------
// BigQuery (exported wrappers around existing private helpers)
// ---------------------------------------------------------------------------

export async function listGcpBigQueryDatasetsExported(projectId: string): Promise<import('@shared/types').GcpBigQueryDatasetSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const summaries: import('@shared/types').GcpBigQueryDatasetSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildBigQueryApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/datasets`, {
          all: 'true',
          maxResults: 1000,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.datasets) ? response.datasets : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const reference = record.datasetReference && typeof record.datasetReference === 'object'
          ? record.datasetReference as Record<string, unknown>
          : {}
        const datasetId = asString(reference.datasetId)
        if (!datasetId) continue

        summaries.push({
          datasetId,
          projectId: asString(reference.projectId) || normalizedProjectId,
          location: asString(record.location),
          friendlyName: asString(record.friendlyName),
          description: asString((record as Record<string, unknown>).description),
          creationTime: asString(record.creationTime),
          lastModifiedTime: asString(record.lastModifiedTime),
          tableCount: 0
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return summaries
  } catch (error) {
    throw buildGcpSdkError(`listing BigQuery datasets for project "${normalizedProjectId}"`, error, 'bigquery.googleapis.com')
  }
}

export async function listGcpBigQueryTables(projectId: string, datasetId: string): Promise<import('@shared/types').GcpBigQueryTableSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedDatasetId = datasetId.trim()
  if (!normalizedProjectId || !normalizedDatasetId) return []

  try {
    const tables: import('@shared/types').GcpBigQueryTableSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildBigQueryApiUrl(
          `projects/${encodeURIComponent(normalizedProjectId)}/datasets/${encodeURIComponent(normalizedDatasetId)}/tables`,
          { maxResults: 1000, pageToken: pageToken || undefined }
        )
      })

      for (const entry of Array.isArray(response.tables) ? response.tables : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const reference = record.tableReference && typeof record.tableReference === 'object'
          ? record.tableReference as Record<string, unknown>
          : {}
        const tableId = asString(reference.tableId)
        if (!tableId) continue

        tables.push({
          tableId,
          datasetId: normalizedDatasetId,
          projectId: normalizedProjectId,
          type: asString(record.type),
          creationTime: asString(record.creationTime),
          expirationTime: asString(record.expirationTime),
          rowCount: asString((record as Record<string, unknown>).numRows),
          sizeBytes: asString((record as Record<string, unknown>).numBytes),
          description: asString((record as Record<string, unknown>).description)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return tables
  } catch (error) {
    throw buildGcpSdkError(`listing BigQuery tables for dataset "${normalizedDatasetId}"`, error, 'bigquery.googleapis.com')
  }
}

export async function getGcpBigQueryTableDetail(projectId: string, datasetId: string, tableId: string): Promise<import('@shared/types').GcpBigQueryTableDetail> {
  const normalizedProjectId = projectId.trim()
  const normalizedDatasetId = datasetId.trim()
  const normalizedTableId = tableId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildBigQueryApiUrl(
        `projects/${encodeURIComponent(normalizedProjectId)}/datasets/${encodeURIComponent(normalizedDatasetId)}/tables/${encodeURIComponent(normalizedTableId)}`
      )
    })

    const schema = response.schema && typeof response.schema === 'object' ? response.schema as Record<string, unknown> : {}
    const fields = (Array.isArray(schema.fields) ? schema.fields : [])
      .map((entry: unknown) => normalizeBigQuerySchemaField(entry))
      .filter((field): field is import('@shared/types').GcpBigQuerySchemaFieldSummary => field !== null)

    return {
      tableId: normalizedTableId,
      datasetId: normalizedDatasetId,
      projectId: normalizedProjectId,
      type: asString(response.type),
      schema: fields,
      rowCount: asString(response.numRows),
      sizeBytes: asString(response.numBytes),
      creationTime: asString(response.creationTime),
      lastModifiedTime: asString(response.lastModifiedTime),
      description: asString((response as Record<string, unknown>).description),
      location: asString(response.location)
    }
  } catch (error) {
    throw buildGcpSdkError(`getting BigQuery table detail for "${normalizedTableId}"`, error, 'bigquery.googleapis.com')
  }
}

function normalizeBigQuerySchemaField(entry: unknown): import('@shared/types').GcpBigQuerySchemaFieldSummary | null {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const name = asString(record.name)
  if (!name) return null

  const subFields = Array.isArray(record.fields)
    ? record.fields.map((child: unknown) => normalizeBigQuerySchemaField(child)).filter((f): f is import('@shared/types').GcpBigQuerySchemaFieldSummary => f !== null)
    : []

  return {
    name,
    type: asString(record.type),
    mode: asString(record.mode),
    description: asString(record.description),
    fields: subFields
  }
}

export async function runGcpBigQueryQuery(projectId: string, queryText: string, maxResults = 100): Promise<import('@shared/types').GcpBigQueryQueryResult> {
  const normalizedProjectId = projectId.trim()

  try {
    const initial = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildBigQueryApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/queries`),
      method: 'POST',
      data: {
        query: queryText,
        useLegacySql: false,
        timeoutMs: 20000,
        maxResults
      }
    })

    let response = initial
    let attempts = 0
    const jobReference = initial.jobReference && typeof initial.jobReference === 'object'
      ? initial.jobReference as Record<string, unknown>
      : {}
    const jobId = asString(jobReference.jobId)

    while (!asBoolean(response.jobComplete) && jobId && attempts < 12) {
      attempts += 1
      await sleep(500)
      response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildBigQueryApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/queries/${encodeURIComponent(jobId)}`, {
          maxResults
        })
      })
    }

    const schemaObj = response.schema && typeof response.schema === 'object' ? response.schema as Record<string, unknown> : {}
    const schemaFields = Array.isArray(schemaObj.fields) ? schemaObj.fields : []
    const columns = schemaFields.map((field: unknown) => {
      if (field && typeof field === 'object') return asString((field as Record<string, unknown>).name)
      return ''
    })

    const rawRows = Array.isArray(response.rows) ? response.rows : []
    const rows = rawRows.map((row: unknown) => {
      if (!row || typeof row !== 'object') return []
      const values = Array.isArray((row as Record<string, unknown>).f) ? (row as Record<string, unknown>).f as unknown[] : []
      return values.map((cell: unknown) => {
        if (!cell || typeof cell !== 'object') return ''
        return asString((cell as Record<string, unknown>).v)
      })
    })

    return {
      columns,
      rows,
      totalRows: asString(response.totalRows),
      jobComplete: asBoolean(response.jobComplete),
      cacheHit: asBoolean(response.cacheHit)
    }
  } catch (error) {
    throw buildGcpSdkError(`running BigQuery query for project "${normalizedProjectId}"`, error, 'bigquery.googleapis.com')
  }
}

// ---------------------------------------------------------------------------
// Cloud Monitoring
// ---------------------------------------------------------------------------

function buildMonitoringApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://monitoring.googleapis.com/v3/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export async function listGcpMonitoringAlertPolicies(projectId: string): Promise<import('@shared/types').GcpMonitoringAlertPolicySummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const policies: import('@shared/types').GcpMonitoringAlertPolicySummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildMonitoringApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/alertPolicies`, {
          pageSize: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.alertPolicies) ? response.alertPolicies : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        const conditions = Array.isArray(record.conditions) ? record.conditions : []
        const channels = Array.isArray(record.notificationChannels) ? record.notificationChannels : []

        policies.push({
          name,
          displayName: asString(record.displayName),
          enabled: asBoolean(record.enabled),
          conditionCount: conditions.length,
          notificationChannelCount: channels.length,
          combiner: asString(record.combiner),
          creationTime: asString((record.creationRecord && typeof record.creationRecord === 'object' ? record.creationRecord as Record<string, unknown> : {}).mutateTime),
          mutationTime: asString((record.mutationRecord && typeof record.mutationRecord === 'object' ? record.mutationRecord as Record<string, unknown> : {}).mutateTime)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return policies
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Monitoring alert policies for project "${normalizedProjectId}"`, error, 'monitoring.googleapis.com')
  }
}

export async function listGcpMonitoringUptimeChecks(projectId: string): Promise<import('@shared/types').GcpMonitoringUptimeCheckSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const checks: import('@shared/types').GcpMonitoringUptimeCheckSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildMonitoringApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/uptimeCheckConfigs`, {
          pageSize: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.uptimeCheckConfigs) ? response.uptimeCheckConfigs : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        const monitoredResource = record.monitoredResource && typeof record.monitoredResource === 'object'
          ? asString((record.monitoredResource as Record<string, unknown>).type)
          : ''
        const httpCheck = record.httpCheck && typeof record.httpCheck === 'object' ? record.httpCheck as Record<string, unknown> : null
        const tcpCheck = record.tcpCheck && typeof record.tcpCheck === 'object' ? record.tcpCheck : null
        const protocol = httpCheck ? (asBoolean(httpCheck.useSsl) ? 'HTTPS' : 'HTTP') : tcpCheck ? 'TCP' : 'UNKNOWN'

        checks.push({
          name,
          displayName: asString(record.displayName),
          monitoredResource,
          protocol,
          period: asString(record.period),
          timeout: asString(record.timeout),
          selectedRegions: asStringArray(record.selectedRegions),
          isInternal: asBoolean(record.isInternal)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return checks
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Monitoring uptime checks for project "${normalizedProjectId}"`, error, 'monitoring.googleapis.com')
  }
}

export async function listGcpMonitoringMetricDescriptors(projectId: string, filter?: string): Promise<import('@shared/types').GcpMonitoringMetricDescriptorSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const descriptors: import('@shared/types').GcpMonitoringMetricDescriptorSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildMonitoringApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/metricDescriptors`, {
          pageSize: 500,
          filter: filter || undefined,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.metricDescriptors) ? response.metricDescriptors : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const type = asString(record.type)
        if (!type) continue

        descriptors.push({
          type,
          displayName: asString(record.displayName),
          description: asString(record.description),
          metricKind: asString(record.metricKind),
          valueType: asString(record.valueType),
          unit: asString(record.unit),
          launchStage: asString(record.launchStage)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return descriptors
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Monitoring metric descriptors for project "${normalizedProjectId}"`, error, 'monitoring.googleapis.com')
  }
}

export async function queryGcpMonitoringTimeSeries(
  projectId: string,
  metricType: string,
  intervalMinutes: number
): Promise<import('@shared/types').GcpMonitoringTimeSeriesResult[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const now = new Date()
    const startTime = new Date(now.getTime() - intervalMinutes * 60 * 1000)
    const filter = `metric.type="${metricType}"`

    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildMonitoringApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/timeSeries`, {
        filter,
        'interval.startTime': startTime.toISOString(),
        'interval.endTime': now.toISOString(),
        pageSize: 100
      })
    })

    const results: import('@shared/types').GcpMonitoringTimeSeriesResult[] = []
    for (const entry of Array.isArray(response.timeSeries) ? response.timeSeries : []) {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const metricObj = record.metric && typeof record.metric === 'object' ? record.metric as Record<string, unknown> : {}
      const resourceObj = record.resource && typeof record.resource === 'object' ? record.resource as Record<string, unknown> : {}
      const rawPoints = Array.isArray(record.points) ? record.points : []

      const points = rawPoints.map((point: unknown) => {
        if (!point || typeof point !== 'object') return null
        const p = point as Record<string, unknown>
        const interval = p.interval && typeof p.interval === 'object' ? p.interval as Record<string, unknown> : {}
        const value = p.value && typeof p.value === 'object' ? p.value as Record<string, unknown> : {}
        const numericValue = normalizeNumber(value.int64Value ?? value.doubleValue ?? value.value ?? 0)
        return {
          timestamp: asString(interval.endTime),
          value: numericValue
        }
      }).filter((p): p is import('@shared/types').GcpMonitoringTimeSeriesPoint => p !== null)

      results.push({
        metric: asString(metricObj.type),
        resource: asString(resourceObj.type),
        points
      })
    }

    return results
  } catch (error) {
    throw buildGcpSdkError(`querying Cloud Monitoring time series for project "${normalizedProjectId}"`, error, 'monitoring.googleapis.com')
  }
}

// ---------------------------------------------------------------------------
// Security Command Center
// ---------------------------------------------------------------------------

function buildSccApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}, version: 'v1' | 'v2' = 'v2'): string {
  const url = new URL(`https://securitycenter.googleapis.com/${version}/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export async function listGcpSccFindings(projectId: string, _location?: string, filter?: string): Promise<import('@shared/types').GcpSccFindingSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const findings: import('@shared/types').GcpSccFindingSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildSccApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/sources/-/locations/global/findings`, {
          pageSize: 500,
          filter: filter || 'state="ACTIVE"',
          pageToken: pageToken || undefined
        })
      })

      const listFindings = Array.isArray(response.listFindingsResults) ? response.listFindingsResults : []
      for (const wrapper of listFindings) {
        const wrapperObj = wrapper && typeof wrapper === 'object' ? wrapper as Record<string, unknown> : {}
        const record = wrapperObj.finding && typeof wrapperObj.finding === 'object' ? wrapperObj.finding as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        const resource = record.resourceName ? record : (wrapperObj.resource && typeof wrapperObj.resource === 'object' ? wrapperObj.resource as Record<string, unknown> : {})

        findings.push({
          name,
          category: asString(record.category),
          state: asString(record.state),
          severity: asString(record.severity),
          resourceName: asString(resource.name ?? record.resourceName),
          resourceType: asString((wrapperObj.resource && typeof wrapperObj.resource === 'object' ? wrapperObj.resource as Record<string, unknown> : {}).type),
          sourceDisplayName: asString(record.canonicalName ? record.canonicalName : record.parent)?.split('/').slice(0, 4).join('/') ?? '',
          eventTime: asString(record.eventTime),
          createTime: asString(record.createTime),
          description: asString(record.description),
          externalUri: asString(record.externalUri)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return findings
  } catch (error) {
    if (String(error).includes('404') || String(error).toLowerCase().includes('not found')) return []
    throw buildGcpSdkError(`listing Security Command Center findings for project "${normalizedProjectId}"`, error, 'securitycenter.googleapis.com')
  }
}

export async function listGcpSccSources(projectId: string, location?: string): Promise<import('@shared/types').GcpSccSourceSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const sources: import('@shared/types').GcpSccSourceSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildSccApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/sources`, {
          pageSize: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.sources) ? response.sources : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        sources.push({
          name,
          displayName: asString(record.displayName),
          description: asString(record.description)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return sources
  } catch (error) {
    if (String(error).includes('404') || String(error).toLowerCase().includes('not found')) return []
    throw buildGcpSdkError(`listing Security Command Center sources for project "${normalizedProjectId}"`, error, 'securitycenter.googleapis.com')
  }
}

export async function getGcpSccFindingDetail(projectId: string, findingName: string, _location?: string): Promise<import('@shared/types').GcpSccFindingDetail> {
  const normalizedProjectId = projectId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildSccApiUrl(findingName.trim())
    })

    const sourceProperties = response.sourceProperties && typeof response.sourceProperties === 'object'
      ? Object.fromEntries(
        Object.entries(response.sourceProperties as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')])
      )
      : {}

    return {
      name: asString(response.name),
      category: asString(response.category),
      state: asString(response.state),
      severity: asString(response.severity),
      resourceName: asString(response.resourceName),
      resourceType: asString((response.resource && typeof response.resource === 'object' ? response.resource as Record<string, unknown> : {}).type),
      sourceDisplayName: asString(response.sourceDisplayName),
      sourceProperties,
      eventTime: asString(response.eventTime),
      createTime: asString(response.createTime),
      description: asString(response.description),
      nextSteps: asString(response.nextSteps),
      externalUri: asString(response.externalUri),
      mute: asString(response.mute)
    }
  } catch (error) {
    throw buildGcpSdkError(`getting SCC finding detail for "${findingName}"`, error, 'securitycenter.googleapis.com')
  }
}

/** Requires: securitycenter.findings.list — API: securitycenter.googleapis.com */
export async function getGcpSccSeverityBreakdown(projectId: string, location?: string): Promise<import('@shared/types').GcpSccSeverityBreakdown> {
  try {
    const findings = await listGcpSccFindings(projectId, location, 'state="ACTIVE"')
    const breakdown: import('@shared/types').GcpSccSeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, unspecified: 0 }

    for (const finding of findings) {
      const severity = finding.severity.toUpperCase()
      if (severity === 'CRITICAL') breakdown.critical++
      else if (severity === 'HIGH') breakdown.high++
      else if (severity === 'MEDIUM') breakdown.medium++
      else if (severity === 'LOW') breakdown.low++
      else breakdown.unspecified++
    }

    return breakdown
  } catch (error) {
    throw buildGcpSdkError(`loading SCC severity breakdown for project "${projectId}"`, error, 'securitycenter.googleapis.com')
  }
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

function buildFirestoreApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://firestore.googleapis.com/v1/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export async function listGcpFirestoreDatabases(projectId: string): Promise<import('@shared/types').GcpFirestoreDatabaseSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildFirestoreApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/databases`)
    })

    const databases: import('@shared/types').GcpFirestoreDatabaseSummary[] = []
    for (const entry of Array.isArray(response.databases) ? response.databases : []) {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const name = asString(record.name)
      if (!name) continue

      databases.push({
        name,
        uid: asString(record.uid),
        locationId: asString(record.locationId),
        type: asString(record.type),
        concurrencyMode: asString(record.concurrencyMode),
        deleteProtectionState: asString(record.deleteProtectionState),
        earliestVersionTime: asString(record.earliestVersionTime)
      })
    }

    return databases
  } catch (error) {
    throw buildGcpSdkError(`listing Firestore databases for project "${normalizedProjectId}"`, error, 'firestore.googleapis.com')
  }
}

export async function listGcpFirestoreCollections(projectId: string, databaseId: string, parentDocumentPath?: string): Promise<import('@shared/types').GcpFirestoreCollectionSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedDatabaseId = databaseId.trim() || '(default)'

  try {
    const basePath = `projects/${encodeURIComponent(normalizedProjectId)}/databases/${encodeURIComponent(normalizedDatabaseId)}/documents`
    const documentPath = parentDocumentPath?.trim() ? `${basePath}/${parentDocumentPath.trim()}` : basePath

    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildFirestoreApiUrl(`${documentPath}:listCollectionIds`),
      method: 'POST',
      data: { pageSize: 500 }
    })

    const collectionIds = Array.isArray(response.collectionIds) ? response.collectionIds : []
    return collectionIds
      .map((id: unknown) => asString(id))
      .filter(Boolean)
      .map((collectionId) => ({ collectionId, documentCount: 0 }))
  } catch (error) {
    throw buildGcpSdkError(`listing Firestore collections for project "${normalizedProjectId}"`, error, 'firestore.googleapis.com')
  }
}

export async function listGcpFirestoreDocuments(projectId: string, databaseId: string, collectionId: string, pageSize = 100): Promise<import('@shared/types').GcpFirestoreDocumentSummary[]> {
  const normalizedProjectId = projectId.trim()
  const normalizedDatabaseId = databaseId.trim() || '(default)'
  const normalizedCollectionId = collectionId.trim()
  if (!normalizedProjectId || !normalizedCollectionId) return []

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildFirestoreApiUrl(
        `projects/${encodeURIComponent(normalizedProjectId)}/databases/${encodeURIComponent(normalizedDatabaseId)}/documents/${encodeURIComponent(normalizedCollectionId)}`,
        { pageSize }
      )
    })

    const documents: import('@shared/types').GcpFirestoreDocumentSummary[] = []
    for (const entry of Array.isArray(response.documents) ? response.documents : []) {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const name = asString(record.name)
      if (!name) continue

      const documentId = name.split('/').pop() ?? name
      const fields = record.fields && typeof record.fields === 'object' ? record.fields as Record<string, unknown> : {}

      documents.push({
        name,
        documentId,
        createTime: asString(record.createTime),
        updateTime: asString(record.updateTime),
        fieldCount: Object.keys(fields).length
      })
    }

    return documents
  } catch (error) {
    throw buildGcpSdkError(`listing Firestore documents for collection "${normalizedCollectionId}"`, error, 'firestore.googleapis.com')
  }
}

export async function getGcpFirestoreDocumentDetail(projectId: string, databaseId: string, documentPath: string): Promise<import('@shared/types').GcpFirestoreDocumentDetail> {
  const normalizedProjectId = projectId.trim()
  const normalizedDatabaseId = databaseId.trim() || '(default)'
  const normalizedPath = documentPath.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildFirestoreApiUrl(
        `projects/${encodeURIComponent(normalizedProjectId)}/databases/${encodeURIComponent(normalizedDatabaseId)}/documents/${normalizedPath}`
      )
    })

    const name = asString(response.name)
    const documentId = name.split('/').pop() ?? name
    const fields = response.fields && typeof response.fields === 'object' ? response.fields as Record<string, unknown> : {}

    return {
      name,
      documentId,
      createTime: asString(response.createTime),
      updateTime: asString(response.updateTime),
      fields
    }
  } catch (error) {
    throw buildGcpSdkError(`getting Firestore document detail for "${normalizedPath}"`, error, 'firestore.googleapis.com')
  }
}

/* ═══════════════════════════════════════════════════
   Cloud Run  (v2 REST API)
   ═══════════════════════════════════════════════════ */

function buildCloudRunApiUrl(pathname: string, query?: Record<string, string>): string {
  const base = 'https://run.googleapis.com/v2/'
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  return `${base}${pathname}${qs}`
}

function normalizeCloudRunCondition(raw: unknown): import('@shared/types').GcpCloudRunCondition {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    type: asString(r.type),
    state: asString(r.state),
    message: asString(r.message),
    lastTransitionTime: asString(r.lastTransitionTime),
    severity: asString(r.severity)
  }
}

function normalizeCloudRunTraffic(raw: unknown): import('@shared/types').GcpCloudRunTrafficStatus {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    type: asString(r.type),
    revisionName: asString(r.revision),
    percent: normalizeNumber(r.percent),
    tag: asString(r.tag),
    uri: asString(r.uri)
  }
}

export async function listGcpCloudRunServices(projectId: string, location: string): Promise<import('@shared/types').GcpCloudRunServiceSummary[]> {
  const normalizedProjectId = projectId.trim()
  const loc = location.trim() || '-'
  const services: import('@shared/types').GcpCloudRunServiceSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildCloudRunApiUrl(`projects/${normalizedProjectId}/locations/${loc}/services`, query)
      })

      const items = Array.isArray(response.services) ? response.services : []
      for (const entry of items) {
        const svc = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(svc.name)
        if (!name) continue

        const template = svc.template && typeof svc.template === 'object' ? svc.template as Record<string, unknown> : {}
        const containers = Array.isArray(template.containers) ? template.containers : []
        const firstContainer = containers[0] && typeof containers[0] === 'object' ? containers[0] as Record<string, unknown> : {}
        const resources = firstContainer.resources && typeof firstContainer.resources === 'object' ? firstContainer.resources as Record<string, unknown> : {}
        const limits = resources.limits && typeof resources.limits === 'object' ? resources.limits as Record<string, unknown> : {}
        const ports = Array.isArray(firstContainer.ports) ? firstContainer.ports : []
        const firstPort = ports[0] && typeof ports[0] === 'object' ? ports[0] as Record<string, unknown> : {}
        const scaling = template.scaling && typeof template.scaling === 'object' ? template.scaling as Record<string, unknown> : {}
        const vpcAccess = template.vpcAccess && typeof template.vpcAccess === 'object' ? template.vpcAccess as Record<string, unknown> : {}
        const conditions = Array.isArray(svc.conditions) ? svc.conditions.map(normalizeCloudRunCondition) : []
        const trafficStatuses = Array.isArray(svc.trafficStatuses) ? svc.trafficStatuses.map(normalizeCloudRunTraffic) : []

        services.push({
          name,
          serviceId: name.split('/').pop() ?? name,
          description: asString(svc.description),
          uri: asString(svc.uri),
          creator: asString(svc.creator),
          lastModifier: asString(svc.lastModifier),
          createTime: asString(svc.createTime),
          updateTime: asString(svc.updateTime),
          ingressSetting: asString(svc.ingress),
          launchStage: asString(svc.launchStage),
          latestReadyRevision: asString(svc.latestReadyRevision),
          latestCreatedRevision: asString(svc.latestCreatedRevision),
          trafficStatuses,
          containerImage: asString(firstContainer.image),
          containerPort: normalizeNumber(firstPort.containerPort),
          serviceAccountEmail: asString(template.serviceAccount),
          vpcConnector: asString(vpcAccess.connector),
          executionEnvironment: asString(template.executionEnvironment),
          cpuLimit: asString(limits.cpu),
          memoryLimit: asString(limits.memory),
          maxInstanceRequestConcurrency: normalizeNumber(template.maxInstanceRequestConcurrency),
          timeout: asString(template.timeout),
          conditions
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return services
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Run services for project "${normalizedProjectId}"`, error, 'run.googleapis.com')
  }
}

export async function listGcpCloudRunRevisions(projectId: string, location: string, serviceId: string): Promise<import('@shared/types').GcpCloudRunRevisionSummary[]> {
  const normalizedProjectId = projectId.trim()
  const loc = location.trim() || '-'
  const revisions: import('@shared/types').GcpCloudRunRevisionSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildCloudRunApiUrl(`projects/${normalizedProjectId}/locations/${loc}/services/${serviceId.trim()}/revisions`, query)
      })

      const items = Array.isArray(response.revisions) ? response.revisions : []
      for (const entry of items) {
        const rev = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(rev.name)
        if (!name) continue

        const containers = Array.isArray(rev.containers) ? rev.containers : []
        const firstContainer = containers[0] && typeof containers[0] === 'object' ? containers[0] as Record<string, unknown> : {}
        const resources = firstContainer.resources && typeof firstContainer.resources === 'object' ? firstContainer.resources as Record<string, unknown> : {}
        const limits = resources.limits && typeof resources.limits === 'object' ? resources.limits as Record<string, unknown> : {}
        const scaling = rev.scaling && typeof rev.scaling === 'object' ? rev.scaling as Record<string, unknown> : {}
        const conditions = Array.isArray(rev.conditions) ? rev.conditions.map(normalizeCloudRunCondition) : []

        revisions.push({
          name,
          revisionId: name.split('/').pop() ?? name,
          generation: asString(rev.generation),
          createTime: asString(rev.createTime),
          updateTime: asString(rev.updateTime),
          launchStage: asString(rev.launchStage),
          containerImage: asString(firstContainer.image),
          cpuLimit: asString(limits.cpu),
          memoryLimit: asString(limits.memory),
          maxInstanceRequestConcurrency: normalizeNumber(rev.maxInstanceRequestConcurrency),
          timeout: asString(rev.timeout),
          serviceAccountEmail: asString(rev.serviceAccount),
          scaling: {
            minInstanceCount: normalizeNumber(scaling.minInstanceCount),
            maxInstanceCount: normalizeNumber(scaling.maxInstanceCount)
          },
          conditions,
          logUri: asString(rev.logUri)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return revisions
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Run revisions for service "${serviceId}"`, error, 'run.googleapis.com')
  }
}

export async function listGcpCloudRunJobs(projectId: string, location: string): Promise<import('@shared/types').GcpCloudRunJobSummary[]> {
  const normalizedProjectId = projectId.trim()
  const loc = location.trim() || '-'
  const jobs: import('@shared/types').GcpCloudRunJobSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildCloudRunApiUrl(`projects/${normalizedProjectId}/locations/${loc}/jobs`, query)
      })

      const items = Array.isArray(response.jobs) ? response.jobs : []
      for (const entry of items) {
        const job = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(job.name)
        if (!name) continue

        const template = job.template && typeof job.template === 'object' ? job.template as Record<string, unknown> : {}
        const taskTemplate = template.template && typeof template.template === 'object' ? template.template as Record<string, unknown> : {}
        const containers = Array.isArray(taskTemplate.containers) ? taskTemplate.containers : []
        const firstContainer = containers[0] && typeof containers[0] === 'object' ? containers[0] as Record<string, unknown> : {}
        const resources = firstContainer.resources && typeof firstContainer.resources === 'object' ? firstContainer.resources as Record<string, unknown> : {}
        const limits = resources.limits && typeof resources.limits === 'object' ? resources.limits as Record<string, unknown> : {}
        const conditions = Array.isArray(job.conditions) ? job.conditions.map(normalizeCloudRunCondition) : []
        const latestExecRef = job.latestCreatedExecution && typeof job.latestCreatedExecution === 'object' ? job.latestCreatedExecution as Record<string, unknown> : {}

        jobs.push({
          name,
          jobId: name.split('/').pop() ?? name,
          createTime: asString(job.createTime),
          updateTime: asString(job.updateTime),
          creator: asString(job.creator),
          lastModifier: asString(job.lastModifier),
          launchStage: asString(job.launchStage),
          containerImage: asString(firstContainer.image),
          taskCount: normalizeNumber(template.taskCount),
          maxRetries: normalizeNumber(template.maxRetries),
          timeout: asString(taskTemplate.timeout),
          cpuLimit: asString(limits.cpu),
          memoryLimit: asString(limits.memory),
          serviceAccountEmail: asString(taskTemplate.serviceAccount),
          executionCount: normalizeNumber(job.executionCount),
          latestExecution: asString(latestExecRef.name),
          conditions
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return jobs
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Run jobs for project "${normalizedProjectId}"`, error, 'run.googleapis.com')
  }
}

export async function listGcpCloudRunExecutions(projectId: string, location: string, jobId: string): Promise<import('@shared/types').GcpCloudRunExecutionSummary[]> {
  const normalizedProjectId = projectId.trim()
  const loc = location.trim() || '-'
  const executions: import('@shared/types').GcpCloudRunExecutionSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildCloudRunApiUrl(`projects/${normalizedProjectId}/locations/${loc}/jobs/${jobId.trim()}/executions`, query)
      })

      const items = Array.isArray(response.executions) ? response.executions : []
      for (const entry of items) {
        const exec = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(exec.name)
        if (!name) continue

        const conditions = Array.isArray(exec.conditions) ? exec.conditions.map(normalizeCloudRunCondition) : []

        executions.push({
          name,
          executionId: name.split('/').pop() ?? name,
          createTime: asString(exec.createTime),
          startTime: asString(exec.startTime),
          completionTime: asString(exec.completionTime),
          runningCount: normalizeNumber(exec.runningCount),
          succeededCount: normalizeNumber(exec.succeededCount),
          failedCount: normalizeNumber(exec.failedCount),
          cancelledCount: normalizeNumber(exec.cancelledCount),
          taskCount: normalizeNumber(exec.taskCount),
          logUri: asString(exec.logUri),
          conditions
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return executions
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud Run executions for job "${jobId}"`, error, 'run.googleapis.com')
  }
}

export async function listGcpCloudRunDomainMappings(projectId: string, location: string): Promise<import('@shared/types').GcpCloudRunDomainMappingSummary[]> {
  const normalizedProjectId = projectId.trim()
  const loc = location.trim() || '-'
  const mappings: import('@shared/types').GcpCloudRunDomainMappingSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      // Domain mappings use the v1 API
      const url = `https://run.googleapis.com/v1/projects/${normalizedProjectId}/locations/${loc}/domainmappings${pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : ''}`
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, { url })

      const items = Array.isArray(response.items) ? response.items : []
      for (const entry of items) {
        const dm = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const metadata = dm.metadata && typeof dm.metadata === 'object' ? dm.metadata as Record<string, unknown> : {}
        const spec = dm.spec && typeof dm.spec === 'object' ? dm.spec as Record<string, unknown> : {}
        const status = dm.status && typeof dm.status === 'object' ? dm.status as Record<string, unknown> : {}
        const conditions = Array.isArray(status.conditions) ? status.conditions.map(normalizeCloudRunCondition) : []
        const resourceRecords = Array.isArray(status.resourceRecords) ? status.resourceRecords : []
        const records = resourceRecords.map((rr: unknown) => {
          const r = rr && typeof rr === 'object' ? rr as Record<string, unknown> : {}
          return { type: asString(r.type), rrdata: asString(r.rrdata) }
        })

        mappings.push({
          name: asString(metadata.name),
          routeName: asString(spec.routeName),
          createTime: asString(metadata.creationTimestamp),
          conditions,
          mappedRouteName: asString(status.mappedRouteName),
          records
        })
      }

      pageToken = asString(response.metadata && typeof response.metadata === 'object' ? (response.metadata as Record<string, unknown>).continue : '')
    } while (pageToken && canPage())

    return mappings
  } catch (error) {
    // Domain mappings may not be available in all regions — return empty instead of throwing
    if (String(error).includes('404') || String(error).includes('not found')) return []
    throw buildGcpSdkError(`listing Cloud Run domain mappings for project "${normalizedProjectId}"`, error, 'run.googleapis.com')
  }
}

/* ═══════════════════════════════════════════════════
   Firebase  (v1beta1 REST API)
   ═══════════════════════════════════════════════════ */

function buildFirebaseManagementApiUrl(pathname: string, query?: Record<string, string>): string {
  const base = 'https://firebase.googleapis.com/v1beta1/'
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  return `${base}${pathname}${qs}`
}

function buildFirebaseHostingApiUrl(pathname: string, query?: Record<string, string>): string {
  const base = 'https://firebasehosting.googleapis.com/v1beta1/'
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  return `${base}${pathname}${qs}`
}

export async function getGcpFirebaseProject(projectId: string): Promise<import('@shared/types').GcpFirebaseProjectSummary> {
  const normalizedProjectId = projectId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildFirebaseManagementApiUrl(`projects/${normalizedProjectId}`)
    })

    const resources = response.resources && typeof response.resources === 'object' ? response.resources as Record<string, unknown> : {}

    return {
      projectId: asString(response.projectId) || normalizedProjectId,
      projectNumber: asString(response.projectNumber),
      displayName: asString(response.displayName),
      state: asString(response.state),
      resources: {
        hostingSite: asString(resources.hostingSite),
        storageBucket: asString(resources.storageBucket),
        locationId: asString(resources.locationId),
        realtimeDatabaseInstance: asString(resources.realtimeDatabaseInstance)
      }
    }
  } catch (error) {
    throw buildGcpSdkError(`getting Firebase project for "${normalizedProjectId}"`, error, 'firebase.googleapis.com')
  }
}

export async function listGcpFirebaseWebApps(projectId: string): Promise<import('@shared/types').GcpFirebaseWebAppSummary[]> {
  const normalizedProjectId = projectId.trim()
  const apps: import('@shared/types').GcpFirebaseWebAppSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildFirebaseManagementApiUrl(`projects/${normalizedProjectId}/webApps`, query)
      })

      const items = Array.isArray(response.apps) ? response.apps : []
      for (const entry of items) {
        const app = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        apps.push({
          name: asString(app.name),
          appId: asString(app.appId),
          displayName: asString(app.displayName),
          projectId: asString(app.projectId) || normalizedProjectId,
          appUrls: Array.isArray(app.appUrls) ? app.appUrls.map(String) : [],
          state: asString(app.state),
          apiKeyId: asString(app.apiKeyId)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return apps
  } catch (error) {
    throw buildGcpSdkError(`listing Firebase web apps for project "${normalizedProjectId}"`, error, 'firebase.googleapis.com')
  }
}

export async function listGcpFirebaseAndroidApps(projectId: string): Promise<import('@shared/types').GcpFirebaseAndroidAppSummary[]> {
  const normalizedProjectId = projectId.trim()
  const apps: import('@shared/types').GcpFirebaseAndroidAppSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildFirebaseManagementApiUrl(`projects/${normalizedProjectId}/androidApps`, query)
      })

      const items = Array.isArray(response.apps) ? response.apps : []
      for (const entry of items) {
        const app = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        apps.push({
          name: asString(app.name),
          appId: asString(app.appId),
          displayName: asString(app.displayName),
          projectId: asString(app.projectId) || normalizedProjectId,
          packageName: asString(app.packageName),
          state: asString(app.state),
          sha1Hashes: Array.isArray(app.sha1Hashes) ? app.sha1Hashes.map(String) : [],
          sha256Hashes: Array.isArray(app.sha256Hashes) ? app.sha256Hashes.map(String) : []
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return apps
  } catch (error) {
    throw buildGcpSdkError(`listing Firebase Android apps for project "${normalizedProjectId}"`, error, 'firebase.googleapis.com')
  }
}

export async function listGcpFirebaseIosApps(projectId: string): Promise<import('@shared/types').GcpFirebaseIosAppSummary[]> {
  const normalizedProjectId = projectId.trim()
  const apps: import('@shared/types').GcpFirebaseIosAppSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildFirebaseManagementApiUrl(`projects/${normalizedProjectId}/iosApps`, query)
      })

      const items = Array.isArray(response.apps) ? response.apps : []
      for (const entry of items) {
        const app = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        apps.push({
          name: asString(app.name),
          appId: asString(app.appId),
          displayName: asString(app.displayName),
          projectId: asString(app.projectId) || normalizedProjectId,
          bundleId: asString(app.bundleId),
          appStoreId: asString(app.appStoreId),
          state: asString(app.state),
          teamId: asString(app.teamId)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return apps
  } catch (error) {
    throw buildGcpSdkError(`listing Firebase iOS apps for project "${normalizedProjectId}"`, error, 'firebase.googleapis.com')
  }
}

export async function listGcpFirebaseHostingSites(projectId: string): Promise<import('@shared/types').GcpFirebaseHostingSiteSummary[]> {
  const normalizedProjectId = projectId.trim()
  const sites: import('@shared/types').GcpFirebaseHostingSiteSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = {}
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildFirebaseHostingApiUrl(`projects/${normalizedProjectId}/sites`, query)
      })

      const items = Array.isArray(response.sites) ? response.sites : []
      for (const entry of items) {
        const site = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(site.name)
        sites.push({
          name,
          siteId: name.split('/').pop() ?? name,
          defaultUrl: asString(site.defaultUrl),
          appId: asString(site.appId),
          type: asString(site.type),
          labels: site.labels && typeof site.labels === 'object' ? Object.fromEntries(Object.entries(site.labels as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])) : {}
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return sites
  } catch (error) {
    if (String(error).includes('404') || String(error).toLowerCase().includes('not found')) return []
    throw buildGcpSdkError(`listing Firebase Hosting sites for project "${normalizedProjectId}"`, error, 'firebasehosting.googleapis.com')
  }
}

export async function listGcpFirebaseHostingReleases(projectId: string, siteId: string): Promise<import('@shared/types').GcpFirebaseHostingReleaseSummary[]> {
  const normalizedProjectId = projectId.trim()
  const releases: import('@shared/types').GcpFirebaseHostingReleaseSummary[] = []

  try {
    let pageToken = ''
    const canPage = paginationGuard()
    do {
      const query: Record<string, string> = { pageSize: '25' }
      if (pageToken) query.pageToken = pageToken

      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildFirebaseHostingApiUrl(`sites/${siteId.trim()}/releases`, query)
      })

      const items = Array.isArray(response.releases) ? response.releases : []
      for (const entry of items) {
        const rel = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const user = rel.releaseUser && typeof rel.releaseUser === 'object' ? rel.releaseUser as Record<string, unknown> : {}
        const version = rel.version && typeof rel.version === 'object' ? rel.version as Record<string, unknown> : {}

        releases.push({
          name: asString(rel.name),
          version: asString(version.name),
          type: asString(rel.type),
          message: asString(rel.message),
          releaseTime: asString(rel.releaseTime),
          releaseUser: { email: asString(user.email), imageUrl: asString(user.imageUrl) },
          status: asString(version.status),
          fileCount: normalizeNumber(version.fileCount),
          versionBytes: asString(version.versionBytes)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return releases
  } catch (error) {
    throw buildGcpSdkError(`listing Firebase Hosting releases for site "${siteId}"`, error, 'firebasehosting.googleapis.com')
  }
}

export async function listGcpFirebaseHostingDomains(projectId: string, siteId: string): Promise<import('@shared/types').GcpFirebaseHostingDomainSummary[]> {
  const normalizedProjectId = projectId.trim()
  const domains: import('@shared/types').GcpFirebaseHostingDomainSummary[] = []

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildFirebaseHostingApiUrl(`sites/${siteId.trim()}/domains`)
    })

    const items = Array.isArray(response.domains) ? response.domains : []
    for (const entry of items) {
      const dom = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const redirect = dom.domainRedirect && typeof dom.domainRedirect === 'object' ? dom.domainRedirect as Record<string, unknown> : null

      domains.push({
        domainName: asString(dom.domainName),
        site: asString(dom.site),
        updateTime: asString(dom.updateTime),
        status: asString(dom.status),
        provisioning: asString(dom.provisioning),
        domainRedirect: redirect ? { domainName: asString(redirect.domainName), type: asString(redirect.type) } : null
      })
    }

    return domains
  } catch (error) {
    throw buildGcpSdkError(`listing Firebase Hosting domains for site "${siteId}"`, error, 'firebasehosting.googleapis.com')
  }
}

export async function listGcpFirebaseHostingChannels(projectId: string, siteId: string): Promise<import('@shared/types').GcpFirebaseHostingChannelSummary[]> {
  const normalizedProjectId = projectId.trim()
  const channels: import('@shared/types').GcpFirebaseHostingChannelSummary[] = []

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildFirebaseHostingApiUrl(`sites/${siteId.trim()}/channels`)
    })

    const items = Array.isArray(response.channels) ? response.channels : []
    for (const entry of items) {
      const ch = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const name = asString(ch.name)

      channels.push({
        name,
        channelId: name.split('/').pop() ?? name,
        url: asString(ch.url),
        expireTime: asString(ch.expireTime),
        retainedReleaseCount: normalizeNumber(ch.retainedReleaseCount),
        createTime: asString(ch.createTime),
        updateTime: asString(ch.updateTime),
        labels: ch.labels && typeof ch.labels === 'object' ? Object.fromEntries(Object.entries(ch.labels as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])) : {}
      })
    }

    return channels
  } catch (error) {
    throw buildGcpSdkError(`listing Firebase Hosting channels for site "${siteId}"`, error, 'firebasehosting.googleapis.com')
  }
}

/* ── Cloud DNS ─────────────────────────────────────────────── */

function buildDnsApiUrl(projectId: string, pathname: string): string {
  const normalizedPath = pathname.replace(/^\/+/, '')
  return `https://dns.googleapis.com/dns/v1/projects/${encodeURIComponent(projectId)}/${normalizedPath}`
}

export async function listGcpDnsManagedZones(projectId: string): Promise<GcpDnsManagedZoneSummary[]> {
  try {
    const zones: GcpDnsManagedZoneSummary[] = []
    let pageToken: string | undefined

    while (true) {
      const url = pageToken
        ? `${buildDnsApiUrl(projectId, 'managedZones')}?pageToken=${encodeURIComponent(pageToken)}`
        : buildDnsApiUrl(projectId, 'managedZones')

      const response = await requestGcp<{ managedZones?: Record<string, unknown>[]; nextPageToken?: string }>(projectId, { url })

      for (const z of response.managedZones ?? []) {
        const dnssecConfig = (z.dnssecConfig ?? {}) as Record<string, unknown>
        zones.push({
          name: asString(z.name),
          dnsName: asString(z.dnsName),
          description: asString(z.description),
          id: String(z.id ?? ''),
          visibility: asString(z.visibility) || 'public',
          dnssecState: asString(dnssecConfig.state) || 'off',
          nameServers: Array.isArray(z.nameServers) ? (z.nameServers as string[]) : [],
          creationTime: asString(z.creationTime)
        })
      }

      if (!response.nextPageToken) break
      pageToken = response.nextPageToken
    }

    return zones.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw buildGcpSdkError('listing Cloud DNS managed zones', error, 'dns.googleapis.com')
  }
}

export async function listGcpDnsResourceRecordSets(projectId: string, managedZone: string): Promise<GcpDnsResourceRecordSetSummary[]> {
  try {
    const records: GcpDnsResourceRecordSetSummary[] = []
    let pageToken: string | undefined

    while (true) {
      const url = pageToken
        ? `${buildDnsApiUrl(projectId, `managedZones/${encodeURIComponent(managedZone)}/rrsets`)}?pageToken=${encodeURIComponent(pageToken)}`
        : buildDnsApiUrl(projectId, `managedZones/${encodeURIComponent(managedZone)}/rrsets`)

      const response = await requestGcp<{ rrsets?: Record<string, unknown>[]; nextPageToken?: string }>(projectId, { url })

      for (const r of response.rrsets ?? []) {
        records.push({
          name: asString(r.name),
          type: asString(r.type),
          ttl: normalizeNumber(r.ttl),
          rrdatas: Array.isArray(r.rrdatas) ? (r.rrdatas as string[]) : [],
          signatureRrdatas: Array.isArray(r.signatureRrdatas) ? (r.signatureRrdatas as string[]) : []
        })
      }

      if (!response.nextPageToken) break
      pageToken = response.nextPageToken
    }

    return records
  } catch (error) {
    throw buildGcpSdkError(`listing Cloud DNS record sets for zone "${managedZone}"`, error, 'dns.googleapis.com')
  }
}

export async function createGcpDnsResourceRecordSet(projectId: string, managedZone: string, input: GcpDnsRecordUpsertInput): Promise<void> {
  try {
    await requestGcp(projectId, {
      url: buildDnsApiUrl(projectId, `managedZones/${encodeURIComponent(managedZone)}/rrsets`),
      method: 'POST',
      data: {
        name: input.name,
        type: input.type,
        ttl: input.ttl,
        rrdatas: input.rrdatas
      }
    })
  } catch (error) {
    throw buildGcpSdkError(`creating Cloud DNS record set "${input.name}" (${input.type})`, error, 'dns.googleapis.com')
  }
}

export async function updateGcpDnsResourceRecordSet(projectId: string, managedZone: string, input: GcpDnsRecordUpsertInput): Promise<void> {
  try {
    await requestGcp(projectId, {
      url: buildDnsApiUrl(projectId, `managedZones/${encodeURIComponent(managedZone)}/rrsets/${encodeURIComponent(input.name)}/${encodeURIComponent(input.type)}`),
      method: 'PATCH',
      data: {
        ttl: input.ttl,
        rrdatas: input.rrdatas
      }
    })
  } catch (error) {
    throw buildGcpSdkError(`updating Cloud DNS record set "${input.name}" (${input.type})`, error, 'dns.googleapis.com')
  }
}

export async function deleteGcpDnsResourceRecordSet(projectId: string, managedZone: string, name: string, type: string): Promise<void> {
  try {
    await requestGcp(projectId, {
      url: buildDnsApiUrl(projectId, `managedZones/${encodeURIComponent(managedZone)}/rrsets/${encodeURIComponent(name)}/${encodeURIComponent(type)}`),
      method: 'DELETE'
    })
  } catch (error) {
    throw buildGcpSdkError(`deleting Cloud DNS record set "${name}" (${type})`, error, 'dns.googleapis.com')
  }
}

/* ── Memorystore (Redis) ─────────────────────────────────── */

function buildMemorystoreApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://redis.googleapis.com/v1/${pathname.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function normalizeMemorystoreInstance(entry: unknown): GcpMemorystoreInstanceSummary | null {
  const record = toRecord(entry)
  if (!record) return null

  const fullName = asString(record.name)
  const parts = fullName.split('/')
  const instanceId = parts[parts.length - 1] || ''

  return {
    name: fullName,
    instanceId,
    displayName: asString(record.displayName) || instanceId,
    state: asString(record.state),
    tier: asString(record.tier),
    memorySizeGb: normalizeNumber(record.memorySizeGb),
    host: asString(record.host),
    port: normalizeNumber(record.port),
    redisVersion: asString(record.redisVersion),
    createTime: asString(record.createTime),
    currentLocationId: asString(record.currentLocationId),
    connectMode: asString(record.connectMode),
    authEnabled: asBoolean(record.authEnabled),
    transitEncryptionMode: asString(record.transitEncryptionMode),
    replicaCount: normalizeNumber(record.replicaCount),
    readEndpoint: asString(record.readEndpoint),
    readEndpointPort: normalizeNumber(record.readEndpointPort),
    locationId: asString(record.locationId),
    alternativeLocationId: asString(record.alternativeLocationId),
    labels: record.labels && typeof record.labels === 'object' && !Array.isArray(record.labels)
      ? (record.labels as Record<string, string>)
      : {}
  }
}

export async function listGcpMemorystoreInstances(projectId: string, location: string): Promise<GcpMemorystoreInstanceSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  const loc = location.trim() || '-'

  try {
    const instances: GcpMemorystoreInstanceSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ instances?: unknown[]; nextPageToken?: string }>(normalizedProjectId, {
        url: buildMemorystoreApiUrl(
          `projects/${encodeURIComponent(normalizedProjectId)}/locations/${encodeURIComponent(loc)}/instances`,
          { pageSize: 500, pageToken: pageToken || undefined }
        )
      })

      for (const entry of response.instances ?? []) {
        const instance = normalizeMemorystoreInstance(entry)
        if (instance) instances.push(instance)
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return instances.sort((a, b) => a.displayName.localeCompare(b.displayName))
  } catch (error) {
    throw buildGcpSdkError(`listing Memorystore instances for project "${normalizedProjectId}"`, error, 'redis.googleapis.com')
  }
}

export async function getGcpMemorystoreInstanceDetail(projectId: string, instanceName: string): Promise<GcpMemorystoreInstanceDetail> {
  const normalizedProjectId = projectId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildMemorystoreApiUrl(instanceName)
    })

    const record = response
    const fullName = asString(record.name)
    const parts = fullName.split('/')
    const instanceId = parts[parts.length - 1] || ''

    const persistenceRaw = toRecord(record.persistenceConfig)
    const maintenancePolicyRaw = toRecord(record.maintenancePolicy)
    const maintenanceScheduleRaw = toRecord(record.maintenanceSchedule)

    return {
      name: fullName,
      instanceId,
      displayName: asString(record.displayName) || instanceId,
      state: asString(record.state),
      tier: asString(record.tier),
      memorySizeGb: normalizeNumber(record.memorySizeGb),
      host: asString(record.host),
      port: normalizeNumber(record.port),
      redisVersion: asString(record.redisVersion),
      createTime: asString(record.createTime),
      currentLocationId: asString(record.currentLocationId),
      connectMode: asString(record.connectMode),
      authEnabled: asBoolean(record.authEnabled),
      transitEncryptionMode: asString(record.transitEncryptionMode),
      replicaCount: normalizeNumber(record.replicaCount),
      readEndpoint: asString(record.readEndpoint),
      readEndpointPort: normalizeNumber(record.readEndpointPort),
      locationId: asString(record.locationId),
      alternativeLocationId: asString(record.alternativeLocationId),
      labels: record.labels && typeof record.labels === 'object' && !Array.isArray(record.labels)
        ? (record.labels as Record<string, string>)
        : {},
      redisConfigs: record.redisConfigs && typeof record.redisConfigs === 'object' && !Array.isArray(record.redisConfigs)
        ? (record.redisConfigs as Record<string, string>)
        : {},
      persistenceConfig: {
        persistenceMode: persistenceRaw ? asString(persistenceRaw.persistenceMode) : '',
        rdbSnapshotPeriod: persistenceRaw ? asString(persistenceRaw.rdbSnapshotPeriod) : '',
        rdbSnapshotStartTime: persistenceRaw ? asString(persistenceRaw.rdbSnapshotStartTime) : ''
      },
      maintenancePolicy: maintenancePolicyRaw
        ? {
            weeklyMaintenanceWindow: Array.isArray(maintenancePolicyRaw.weeklyMaintenanceWindow)
              ? (maintenancePolicyRaw.weeklyMaintenanceWindow as Array<Record<string, unknown>>).map((w) => ({
                  day: asString(w.day),
                  startTime: asString((toRecord(w.startTime) ?? {}).hours) + ':' + asString((toRecord(w.startTime) ?? {}).minutes || '00'),
                  duration: asString(w.duration)
                }))
              : []
          }
        : null,
      maintenanceSchedule: maintenanceScheduleRaw
        ? {
            startTime: asString(maintenanceScheduleRaw.startTime),
            endTime: asString(maintenanceScheduleRaw.endTime),
            scheduleDeadlineTime: asString(maintenanceScheduleRaw.scheduleDeadlineTime)
          }
        : null,
      nodes: Array.isArray(record.nodes)
        ? (record.nodes as Array<Record<string, unknown>>).map((n) => ({
            id: asString(n.id),
            zone: asString(n.zone)
          }))
        : [],
      authorizedNetwork: asString(record.authorizedNetwork),
      reservedIpRange: asString(record.reservedIpRange)
    }
  } catch (error) {
    throw buildGcpSdkError(`getting Memorystore instance detail for "${instanceName}"`, error, 'redis.googleapis.com')
  }
}

/* ── Load Balancer + Cloud Armor ─────────────────────────── */

export async function listGcpUrlMaps(projectId: string): Promise<GcpUrlMapSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const items: GcpUrlMapSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: Record<string, { urlMaps?: unknown[] }>; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'aggregated/urlMaps', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const scoped of Object.values(response.items ?? {})) {
        for (const entry of scoped?.urlMaps ?? []) {
          const record = toRecord(entry)
          if (!record) continue
          const selfLink = asString(record.selfLink)
          const regionMatch = selfLink.match(/\/regions\/([^/]+)\//)
          items.push({
            name: asString(record.name),
            description: asString(record.description),
            selfLink,
            defaultService: asString(record.defaultService),
            hostRuleCount: Array.isArray(record.hostRules) ? record.hostRules.length : 0,
            pathMatcherCount: Array.isArray(record.pathMatchers) ? record.pathMatchers.length : 0,
            creationTimestamp: asString(record.creationTimestamp),
            region: regionMatch ? regionMatch[1] : '',
            fingerprint: asString(record.fingerprint)
          })
        }
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw buildGcpSdkError(`listing URL maps for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function getGcpUrlMapDetail(projectId: string, urlMapName: string, region?: string): Promise<GcpUrlMapDetail> {
  const normalizedProjectId = projectId.trim()
  const path = region
    ? `regions/${encodeURIComponent(region)}/urlMaps/${encodeURIComponent(urlMapName)}`
    : `global/urlMaps/${encodeURIComponent(urlMapName)}`

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildComputeApiUrl(normalizedProjectId, path)
    })

    return {
      name: asString(response.name),
      description: asString(response.description),
      selfLink: asString(response.selfLink),
      defaultService: asString(response.defaultService),
      hostRules: Array.isArray(response.hostRules)
        ? (response.hostRules as Array<Record<string, unknown>>).map((hr) => ({
            hosts: Array.isArray(hr.hosts) ? (hr.hosts as string[]) : [],
            pathMatcher: asString(hr.pathMatcher)
          }))
        : [],
      pathMatchers: Array.isArray(response.pathMatchers)
        ? (response.pathMatchers as Array<Record<string, unknown>>).map((pm) => ({
            name: asString(pm.name),
            defaultService: asString(pm.defaultService),
            pathRules: Array.isArray(pm.pathRules)
              ? (pm.pathRules as Array<Record<string, unknown>>).map((pr) => ({
                  paths: Array.isArray(pr.paths) ? (pr.paths as string[]) : [],
                  service: asString(pr.service)
                }))
              : []
          }))
        : [],
      creationTimestamp: asString(response.creationTimestamp),
      fingerprint: asString(response.fingerprint)
    }
  } catch (error) {
    throw buildGcpSdkError(`getting URL map detail for "${urlMapName}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpBackendServices(projectId: string): Promise<GcpBackendServiceSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const items: GcpBackendServiceSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: Record<string, { backendServices?: unknown[] }>; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'aggregated/backendServices', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const scoped of Object.values(response.items ?? {})) {
        for (const entry of scoped?.backendServices ?? []) {
          const record = toRecord(entry)
          if (!record) continue
          const selfLink = asString(record.selfLink)
          const regionMatch = selfLink.match(/\/regions\/([^/]+)\//)
          items.push({
            name: asString(record.name),
            description: asString(record.description),
            selfLink,
            protocol: asString(record.protocol),
            port: normalizeNumber(record.port),
            portName: asString(record.portName),
            timeoutSec: normalizeNumber(record.timeoutSec),
            healthChecks: Array.isArray(record.healthChecks) ? (record.healthChecks as string[]) : [],
            backendsCount: Array.isArray(record.backends) ? record.backends.length : 0,
            loadBalancingScheme: asString(record.loadBalancingScheme),
            sessionAffinity: asString(record.sessionAffinity),
            region: regionMatch ? regionMatch[1] : '',
            creationTimestamp: asString(record.creationTimestamp),
            securityPolicy: asString(record.securityPolicy)
          })
        }
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw buildGcpSdkError(`listing backend services for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpForwardingRules(projectId: string): Promise<GcpForwardingRuleSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const items: GcpForwardingRuleSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: Record<string, { forwardingRules?: unknown[] }>; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'aggregated/forwardingRules', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const scoped of Object.values(response.items ?? {})) {
        for (const entry of scoped?.forwardingRules ?? []) {
          const record = toRecord(entry)
          if (!record) continue
          const selfLink = asString(record.selfLink)
          const regionMatch = selfLink.match(/\/regions\/([^/]+)\//)
          items.push({
            name: asString(record.name),
            description: asString(record.description),
            selfLink,
            IPAddress: asString(record.IPAddress),
            IPProtocol: asString(record.IPProtocol),
            portRange: asString(record.portRange),
            target: asString(record.target),
            loadBalancingScheme: asString(record.loadBalancingScheme),
            network: asString(record.network),
            region: regionMatch ? regionMatch[1] : '',
            creationTimestamp: asString(record.creationTimestamp)
          })
        }
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw buildGcpSdkError(`listing forwarding rules for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpHealthChecks(projectId: string): Promise<GcpHealthCheckSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const items: GcpHealthCheckSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: Record<string, { healthChecks?: unknown[] }>; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'aggregated/healthChecks', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const scoped of Object.values(response.items ?? {})) {
        for (const entry of scoped?.healthChecks ?? []) {
          const record = toRecord(entry)
          if (!record) continue
          items.push({
            name: asString(record.name),
            description: asString(record.description),
            selfLink: asString(record.selfLink),
            type: asString(record.type),
            checkIntervalSec: normalizeNumber(record.checkIntervalSec),
            timeoutSec: normalizeNumber(record.timeoutSec),
            unhealthyThreshold: normalizeNumber(record.unhealthyThreshold),
            healthyThreshold: normalizeNumber(record.healthyThreshold),
            creationTimestamp: asString(record.creationTimestamp)
          })
        }
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw buildGcpSdkError(`listing health checks for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function listGcpSecurityPolicies(projectId: string): Promise<GcpSecurityPolicySummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const items: GcpSecurityPolicySummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<{ items?: unknown[]; nextPageToken?: string }>(normalizedProjectId, {
        url: buildComputeApiUrl(normalizedProjectId, 'global/securityPolicies', {
          maxResults: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of response.items ?? []) {
        const record = toRecord(entry)
        if (!record) continue
        const adaptiveRaw = toRecord(record.adaptiveProtectionConfig)
        items.push({
          name: asString(record.name),
          description: asString(record.description),
          selfLink: asString(record.selfLink),
          type: asString(record.type),
          ruleCount: Array.isArray(record.rules) ? record.rules.length : 0,
          adaptiveProtection: adaptiveRaw
            ? asBoolean((toRecord(adaptiveRaw.layer7DdosDefenseConfig) ?? {}).enable)
            : false,
          creationTimestamp: asString(record.creationTimestamp),
          fingerprint: asString(record.fingerprint)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return items.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw buildGcpSdkError(`listing security policies for project "${normalizedProjectId}"`, error, 'compute.googleapis.com')
  }
}

export async function getGcpSecurityPolicyDetail(projectId: string, policyName: string): Promise<GcpSecurityPolicyDetail> {
  const normalizedProjectId = projectId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildComputeApiUrl(normalizedProjectId, `global/securityPolicies/${encodeURIComponent(policyName)}`)
    })

    const adaptiveRaw = toRecord(response.adaptiveProtectionConfig)
    const l7Raw = adaptiveRaw ? toRecord(adaptiveRaw.layer7DdosDefenseConfig) : null

    return {
      name: asString(response.name),
      description: asString(response.description),
      selfLink: asString(response.selfLink),
      type: asString(response.type),
      rules: Array.isArray(response.rules)
        ? (response.rules as Array<Record<string, unknown>>).map((r) => {
            const matchRaw = toRecord(r.match)
            const configRaw = matchRaw ? toRecord(matchRaw.config) : null
            return {
              priority: normalizeNumber(r.priority),
              action: asString(r.action),
              description: asString(r.description),
              match: matchRaw
                ? {
                    versionedExpr: asString(matchRaw.versionedExpr),
                    config: {
                      srcIpRanges: configRaw && Array.isArray(configRaw.srcIpRanges)
                        ? (configRaw.srcIpRanges as string[])
                        : []
                    }
                  }
                : null,
              preview: asBoolean(r.preview)
            }
          })
        : [],
      adaptiveProtectionConfig: adaptiveRaw
        ? {
            enabled: l7Raw ? asBoolean(l7Raw.enable) : false,
            layer7DdosDefenseConfig: l7Raw
              ? { enable: asBoolean(l7Raw.enable), ruleVisibility: asString(l7Raw.ruleVisibility) }
              : null
          }
        : null,
      ddosProtectionConfig: asString(response.ddosProtectionConfig),
      fingerprint: asString(response.fingerprint),
      creationTimestamp: asString(response.creationTimestamp)
    }
  } catch (error) {
    throw buildGcpSdkError(`getting security policy detail for "${policyName}"`, error, 'compute.googleapis.com')
  }
}
