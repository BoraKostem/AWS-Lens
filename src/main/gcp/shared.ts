/**
 * Shared helpers, constants, types, URL builders, and normalizers for all
 * src/main/gcp/* per-service modules. Extracted verbatim from gcpSdk.ts as
 * part of the monolith decomposition — do not change the semantics of any
 * helper without also updating callers.
 */

import path from 'node:path'
import { google } from 'googleapis'
import { logWarn } from '../observability'
import { classifyGcpError, getGcpAuth, paginationGuard, requestGcp } from './client'
import type {
  GcpBillingCapabilityHint,
  GcpBillingOverview,
  GcpBillingOwnershipHint,
  GcpBillingOwnershipValue,
  GcpBillingSpendBreakdownEntry,
  GcpBillingSpendTelemetry,
  GcpComputeInstanceAction,
  GcpComputeInstanceDetail,
  GcpComputeInstanceSummary,
  GcpComputeMachineTypeOption,
  GcpFirewallRuleSummary,
  GcpGkeClusterSummary,
  GcpGlobalAddressSummary,
  GcpIamBindingSummary,
  GcpIamCapabilityHint,
  GcpIamOverview,
  GcpIamPrincipalSummary,
  GcpLogEntryDetail,
  GcpLogEntrySummary,
  GcpLogFacetCount,
  GcpNetworkSummary,
  GcpProjectCapabilityHint,
  GcpProjectOverview,
  GcpRouterNatSummary,
  GcpRouterSummary,
  GcpServiceNetworkingConnectionSummary,
  GcpSqlDatabaseSummary,
  GcpSqlInstanceDetail,
  GcpSqlInstanceSummary,
  GcpSqlOperationSummary,
  GcpStorageBucketSummary,
  GcpStorageObjectSummary,
  GcpSubnetworkSummary
} from '@shared/types'

// ── Constants ───────────────────────────────────────────────────────────────────

export const GCP_REGION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+\d$/
export const GCP_ZONE_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+\d-[a-z]$/
export const GCP_BILLING_OWNERSHIP_KEYS = ['owner', 'team', 'cost-center', 'cost_center', 'environment', 'env', 'application', 'app', 'service']
export const GCP_HIGH_PRIVILEGE_ROLE_MARKERS = [
  'roles/owner',
  'roles/editor',
  'roles/resourcemanager.projectIamAdmin',
  'roles/iam.securityAdmin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountTokenCreator'
]
export const GCP_PROJECT_CORE_API_HINTS = [
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

// ── Internal types ──────────────────────────────────────────────────────────────

export type GcpBillingProjectRecord = {
  projectId: string
  name: string
  projectNumber: string
  lifecycleState: string
  labelCount: number
  labels: Record<string, string>
  billingEnabled: boolean
  billingAccountName: string
}

export type GcpStorageObjectRecord = {
  key: string
  size: number
  lastModified: string
  storageClass: string
}

export type GcpSqlScopedDatabaseSummary = {
  instance: string
  name: string
  charset: string
  collation: string
}

export type GcpSqlUserSummary = {
  instance: string
  name: string
  host: string
  type: string
}

export type GcpBigQueryDatasetRecord = {
  projectId: string
  datasetId: string
  location: string
}

export type GcpBigQueryExportTableRecord = {
  projectId: string
  datasetId: string
  tableId: string
  location: string
  priority: number
}

export type GcpBigQuerySchemaField = {
  name: string
  fields: GcpBigQuerySchemaField[]
}

// ── Generic helpers ─────────────────────────────────────────────────────────────

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function asBoolean(value: unknown): boolean {
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

export function normalizeNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

export function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => asString(item))
    .filter(Boolean)
}

export function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.trim(), asString(item)])
      .filter((entry) => entry[0] && entry[1])
  )
}

export function maskSecret(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= 12) {
    return normalized
  }

  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`
}

export function quoteYamlScalar(value: string): string {
  return JSON.stringify(value)
}

export function buildGkeContextName(projectId: string, location: string, clusterName: string): string {
  return `gke_${projectId.trim()}_${location.trim()}_${clusterName.trim()}`
}

export function buildGkeKubeconfigYaml(contextName: string, endpoint: string, certificateAuthorityData: string, bearerToken: string): string {
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

export function buildContainerApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://container.googleapis.com/v1/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export function formatMaintenanceWindow(value: unknown): string {
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

export function normalizeMaintenanceExclusions(value: unknown): string[] {
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

export function extractGkeOperationError(operation: unknown): string {
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

export function titleFromApiName(value: string): string {
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

export function isGcpHighPrivilegeRole(role: string): boolean {
  const normalized = role.trim()
  if (!normalized) {
    return false
  }

  return GCP_HIGH_PRIVILEGE_ROLE_MARKERS.includes(normalized)
    || /(^|\/)(.*admin.*)$/i.test(normalized)
}

export function isGcpPublicPrincipal(member: string): boolean {
  const normalized = member.trim()
  return normalized === 'allUsers' || normalized === 'allAuthenticatedUsers'
}

/**
 * Alias for classifyGcpError — matches the historical name used throughout
 * the gcpSdk.ts monolith. New code should prefer classifyGcpError directly.
 */
export const buildGcpSdkError = classifyGcpError

// ── URL builders ────────────────────────────────────────────────────────────────

export function buildStorageApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://storage.googleapis.com${pathname}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export function buildComputeApiUrl(projectId: string, pathname: string, query: Record<string, number | string | undefined> = {}): string {
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

export function buildBigQueryApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}): string {
  const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export function encodeStorageObjectKey(value: string): string {
  return encodeURIComponent(value.trim())
}

export function asBuffer(value: ArrayBuffer | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(value)) {
    return value
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value)
  }

  return Buffer.from(value)
}

export function resourceBasename(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) {
    return ''
  }

  const segments = normalized.split('/')
  return segments[segments.length - 1] ?? normalized
}

export function normalizeBucketName(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  return normalized.replace(/^gs:\/\//i, '').replace(/\/+$/, '')
}

// ── Normalizers ─────────────────────────────────────────────────────────────────

export function normalizeStorageBucket(entry: unknown): GcpStorageBucketSummary | null {
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

export function normalizeFirewallRule(entry: unknown): GcpFirewallRuleSummary | null {
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

export function normalizeNetwork(entry: unknown): GcpNetworkSummary | null {
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

export function normalizeSubnetwork(entry: unknown): GcpSubnetworkSummary | null {
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

export function normalizeRouter(entry: unknown): GcpRouterSummary | null {
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

export function normalizeRouterNat(entry: unknown, routerName: string, region: string): GcpRouterNatSummary | null {
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

export function normalizeGlobalAddress(entry: unknown): GcpGlobalAddressSummary | null {
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

export function normalizeServiceNetworkingConnection(entry: unknown, networkName: string): GcpServiceNetworkingConnectionSummary | null {
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

export function normalizeScopedSqlDatabase(entry: unknown, instance: string): GcpSqlScopedDatabaseSummary | null {
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

export function normalizeSqlUser(entry: unknown, instance: string): GcpSqlUserSummary | null {
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

export function normalizeStorageObjectRecord(entry: unknown, bucketName: string): GcpStorageObjectRecord | null {
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

export function buildGcpStorageObjectSummaries(records: GcpStorageObjectRecord[], prefix: string): GcpStorageObjectSummary[] {
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

export function guessContentTypeFromKey(key: string): string {
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

export function formatSqlMaintenanceWindow(day: unknown, hour: unknown): string {
  const hourText = typeof hour === 'number' ? `${String(hour).padStart(2, '0')}:00 UTC` : ''
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const dayText = typeof day === 'number' && day >= 1 && day <= 7 ? dayNames[day - 1] : ''
  if (dayText && hourText) return `${dayText} ${hourText}`
  return dayText || hourText
}

export function normalizeSqlInstance(entry: unknown): GcpSqlInstanceSummary | null {
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

export function normalizeAuthorizedNetworks(value: unknown): string[] {
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

export function normalizeSqlInstanceDetail(entry: unknown): GcpSqlInstanceDetail | null {
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

export function normalizeSqlDatabase(entry: unknown): GcpSqlDatabaseSummary | null {
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

export function normalizeSqlOperation(entry: unknown): GcpSqlOperationSummary | null {
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

export function stringifyLogPayload(value: unknown): string {
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

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function joinLogSummaryParts(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' | ')
}

export function buildLogDetailsFromPayload(payload: unknown): GcpLogEntryDetail[] {
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

export function buildStructuredPayloadSummary(payload: unknown): string {
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

export function buildLogDetails(entry: Record<string, unknown>): GcpLogEntryDetail[] {
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

export function summarizeLogName(value: string): string {
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

export function buildLogSummary(entry: Record<string, unknown>): string {
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

export function normalizeLogEntry(entry: unknown): GcpLogEntrySummary | null {
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

export function toFacetCounts(values: string[]): GcpLogFacetCount[] {
  const counts = new Map<string, number>()

  for (const value of values) {
    const label = value.trim() || 'unknown'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

export function escapeLoggingFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildLocationAwareLogFilter(location: string): string {
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

export function buildGcpLogFilter(location: string, query: string, windowHours: number): string {
  const normalizedQuery = query.trim()
  const normalizedLocationFilter = buildLocationAwareLogFilter(location)
  const normalizedWindowHours = Number.isFinite(windowHours) && windowHours > 0 ? Math.min(Math.max(windowHours, 1), 168) : 24
  const freshnessFilter = `timestamp >= "${new Date(Date.now() - normalizedWindowHours * 60 * 60 * 1000).toISOString()}"`

  return [freshnessFilter, normalizedLocationFilter, normalizedQuery]
    .filter(Boolean)
    .join(' AND ')
}

// ── Location filters ────────────────────────────────────────────────────────────

export function filterStorageBucketsByLocation(buckets: GcpStorageBucketSummary[], location: string): GcpStorageBucketSummary[] {
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

export function filterSqlInstancesByLocation(instances: GcpSqlInstanceSummary[], location: string): GcpSqlInstanceSummary[] {
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

export function filterSubnetworksByLocation(subnetworks: GcpSubnetworkSummary[], location: string): GcpSubnetworkSummary[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return subnetworks
  }

  const normalizedRegion = /-[a-z]$/.test(normalizedLocation)
    ? normalizedLocation.replace(/-[a-z]$/, '')
    : normalizedLocation

  return subnetworks.filter((subnetwork) => subnetwork.region.trim().toLowerCase() === normalizedRegion)
}

export function filterRoutersByLocation<T extends { region: string }>(routers: T[], location: string): T[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return routers
  }

  const normalizedRegion = /-[a-z]$/.test(normalizedLocation)
    ? normalizedLocation.replace(/-[a-z]$/, '')
    : normalizedLocation

  return routers.filter((router) => router.region.trim().toLowerCase() === normalizedRegion)
}

export function filterComputeInstancesByLocation(instances: GcpComputeInstanceSummary[], location: string): GcpComputeInstanceSummary[] {
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

export function filterGkeClustersByLocation(clusters: GcpGkeClusterSummary[], location: string): GcpGkeClusterSummary[] {
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

export function isValidGcpLocation(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return normalized === 'global' || GCP_REGION_PATTERN.test(normalized) || GCP_ZONE_PATTERN.test(normalized)
}

// ── Project / billing helpers (internal) ────────────────────────────────────────

export async function getGcpProjectBillingInfo(projectId: string): Promise<{ billingEnabled: boolean; billingAccountName: string }> {
  const response = await requestGcp<Record<string, unknown>>(projectId, {
    url: `https://cloudbilling.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/billingInfo`
  })

  return {
    billingEnabled: asBoolean(response.billingEnabled),
    billingAccountName: asString(response.billingAccountName)
  }
}

export async function getGcpBillingAccountMetadata(projectId: string, billingAccountName: string): Promise<{ displayName: string; open: boolean }> {
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

export async function getGcpProjectMetadata(projectId: string): Promise<{
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

export async function getGcpProjectIamPolicy(projectId: string): Promise<Record<string, unknown>> {
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

export function buildGcpIamBindings(policy: Record<string, unknown>): GcpIamBindingSummary[] {
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

export function buildGcpIamPrincipals(bindings: GcpIamBindingSummary[]): GcpIamPrincipalSummary[] {
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

export function buildGcpIamCapabilityHints(overview: GcpIamOverview): GcpIamCapabilityHint[] {
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

export function buildGcpProjectCapabilityHints(project: GcpProjectOverview): GcpProjectCapabilityHint[] {
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

export function buildGcpBillingProjectRecord(
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

export function summarizeBillingAccountId(value: string): string {
  const normalized = value.trim()
  return normalized ? normalized.replace(/^billingAccounts\//, '') : '-'
}

export function computeGcpBillingOwnershipHints(records: GcpBillingProjectRecord[]): GcpBillingOwnershipHint[] {
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

export function buildGcpBillingCapabilityHints(
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

export function buildGcpBillingPeriodWindow(now = new Date()): { label: string; start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
  const label = `${now.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })} MTD`

  return {
    label,
    start: start.toISOString(),
    end: now.toISOString()
  }
}

export function buildDefaultGcpSpendTelemetry(
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

// ── Internal BigQuery helpers (used only by billing overview spend telemetry) ──

export function scoreGcpBillingExportTable(tableId: string): number {
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

export function normalizeGcpBigQuerySchemaField(value: unknown): GcpBigQuerySchemaField | null {
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

export function findGcpBigQueryField(fields: GcpBigQuerySchemaField[], fieldName: string): GcpBigQuerySchemaField | null {
  const normalized = fieldName.trim().toLowerCase()
  return fields.find((field) => field.name.trim().toLowerCase() === normalized) ?? null
}

export function hasGcpBigQueryNestedField(fields: GcpBigQuerySchemaField[], parentName: string, childName: string): boolean {
  const parent = findGcpBigQueryField(fields, parentName)
  return Boolean(parent && findGcpBigQueryField(parent.fields, childName))
}

export function buildGcpBillingExportQuery(table: GcpBigQueryExportTableRecord, schemaFields: GcpBigQuerySchemaField[]): string {
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

export async function listGcpBigQueryDatasets(projectId: string): Promise<GcpBigQueryDatasetRecord[]> {
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

export async function listGcpBigQueryBillingExportTables(dataset: GcpBigQueryDatasetRecord): Promise<GcpBigQueryExportTableRecord[]> {
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

export async function discoverGcpBillingExportTable(projectId: string, candidateProjectIds: string[]): Promise<{
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

export async function getGcpBigQueryTableSchema(table: GcpBigQueryExportTableRecord): Promise<GcpBigQuerySchemaField[]> {
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

export async function executeGcpBigQueryQuery(
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

export function normalizeGcpBigQuerySpendRows(rows: unknown): Array<{ service: string; amount: number; currency: string }> {
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

export function buildGcpBillingSpendEntries(rows: Array<{ service: string; amount: number; currency: string }>, totalAmount: number): GcpBillingSpendBreakdownEntry[] {
  return rows.map((row) => ({
    service: row.service,
    amount: row.amount,
    currency: row.currency,
    sharePercent: totalAmount > 0 ? (row.amount / totalAmount) * 100 : 0
  }))
}

export function isLikelyGcpAccessLimitedError(error: unknown): boolean {
  const detail = normalizeError(error).toLowerCase()
  return detail.includes('permission')
    || detail.includes('forbidden')
    || detail.includes('access denied')
    || detail.includes('not authorized')
    || detail.includes('bigquery.jobs.create')
}

export function isLikelyGcpBigQueryApiDisabledError(error: unknown): boolean {
  const detail = normalizeError(error).toLowerCase()
  return detail.includes('api has not been used in project')
    || detail.includes('it is disabled')
    || detail.includes('enable it by visiting')
    || detail.includes('service disabled')
    || detail.includes('bigquery api')
}

export async function loadGcpBillingSpendTelemetry(projectId: string, candidateProjectIds: string[], billingEnabled: boolean): Promise<GcpBillingSpendTelemetry> {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Compute Engine helpers (shared by computeEngine.ts, loadBalancer.ts) ────────

export function normalizeGcpComputeLabels(labels: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(labels)
    .map(([key, value]) => ({ key: key.trim(), value: value.trim() }))
    .filter((entry) => entry.key)
    .sort((left, right) => left.key.localeCompare(right.key))
}

export function normalizeGcpComputeMetadata(items: unknown): Array<{ key: string; value: string }> {
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

export function summarizeGcpComputeScheduling(value: unknown): string {
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

export function normalizeGcpComputeInstanceDetail(instance: unknown): GcpComputeInstanceDetail | null {
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

export function normalizeGcpComputeMachineTypeOption(entry: unknown): GcpComputeMachineTypeOption | null {
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

export function buildGcpComputeActionSummary(action: GcpComputeInstanceAction, instanceName: string, completed: boolean): string {
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

export function buildGcpComputeResizeSummary(instanceName: string, machineType: string, completed: boolean): string {
  return completed
    ? `${instanceName} resized to ${machineType}.`
    : `${instanceName} resize to ${machineType} was accepted and is still in progress.`
}

export function buildGcpComputeLabelSummary(instanceName: string, completed: boolean): string {
  return completed
    ? `${instanceName} labels updated.`
    : `${instanceName} label update was accepted and is still in progress.`
}

export function buildGcpComputeDeleteSummary(instanceName: string, completed: boolean): string {
  return completed
    ? `${instanceName} deletion completed.`
    : `${instanceName} delete request was accepted and is still in progress.`
}

export function buildGcpMachineTypeResource(zone: string, machineType: string): string {
  const normalizedMachineType = machineType.trim()
  if (!normalizedMachineType) {
    return ''
  }

  return normalizedMachineType.includes('/')
    ? normalizedMachineType
    : `zones/${zone.trim()}/machineTypes/${normalizedMachineType}`
}

export function extractGcpZoneOperationError(operation: unknown): string {
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

export async function waitForGcpZoneOperation(projectId: string, zone: string, operationName: string, timeoutMs = 120000): Promise<{ completed: boolean; status: string }> {
  const normalizedProjectId = projectId.trim()
  const normalizedZone = zone.trim()
  const normalizedOperation = operationName.trim()

  if (!normalizedProjectId || !normalizedZone || !normalizedOperation) {
    return { completed: false, status: 'PENDING' }
  }

  const auth = getGcpAuth(normalizedProjectId)
  const compute = google.compute({ version: 'v1', auth })
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const response = await compute.zoneOperations.wait({
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
  }

  return { completed: false, status: 'PENDING' }
}

export async function waitForGkeOperation(projectId: string, location: string, operationName: string, timeoutMs = 120000): Promise<{ completed: boolean; status: string }> {
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

export async function resolveGkeNodePoolTargetSize(projectId: string, instanceGroupUrls: string[], fallback: number): Promise<number> {
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
