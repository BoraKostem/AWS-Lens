import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog } from 'electron'
import { GoogleAuth } from 'google-auth-library'
import { google } from 'googleapis'

import { logWarn } from './observability'

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
  GcpProjectCapabilityHint,
  GcpProjectOverview,
  GcpServiceAccountSummary,
  GcpSqlDatabaseSummary,
  GcpSqlInstanceDetail,
  GcpSqlInstanceSummary,
  GcpSqlOperationSummary,
  GcpStorageBucketSummary,
  GcpStorageObjectContent,
  GcpStorageObjectSummary
} from '@shared/types'

const GCP_SDK_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']
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
  { name: 'cloudbilling.googleapis.com', title: 'Cloud Billing API' }
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

type GcpFirewallRuleSummary = {
  name: string
  network: string
  direction: string
  priority: string
}

type GcpNetworkSummary = {
  name: string
  autoCreateSubnetworks: boolean
  routingMode: string
}

type GcpSubnetworkSummary = {
  name: string
  region: string
  network: string
  ipCidrRange: string
  privateIpGoogleAccess: boolean
}

type GcpRouterSummary = {
  name: string
  region: string
  network: string
}

type GcpRouterNatSummary = {
  name: string
  region: string
  router: string
  natIpAllocateOption: string
}

type GcpGlobalAddressSummary = {
  name: string
  address: string
  addressType: string
  purpose: string
  network: string
  prefixLength: string
}

type GcpServiceNetworkingConnectionSummary = {
  network: string
  service: string
  peering: string
  reservedPeeringRanges: string[]
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

type GcpRequestOptions = {
  data?: unknown
  headers?: Record<string, string>
  method?: 'DELETE' | 'GET' | 'POST'
  responseType?: 'arraybuffer' | 'json' | 'text'
  url: string
}

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

function outputIndicatesApiDisabled(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('api has not been used in project')
    || normalized.includes('it is disabled')
    || normalized.includes('enable it by visiting')
    || normalized.includes('service disabled')
}

function outputIndicatesAdcIssue(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('application default credentials')
    || normalized.includes('could not load the default credentials')
    || normalized.includes('default credentials')
    || normalized.includes('could not authenticate')
    || normalized.includes('login required')
}

function outputIndicatesPermissionIssue(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('permission denied')
    || normalized.includes('forbidden')
    || normalized.includes('does not have permission')
    || normalized.includes('insufficient authentication scopes')
    || normalized.includes('permission')
}

function extractProjectIdFromOutput(output: string): string {
  const quotedMatch = output.match(/project\s+"([^"]+)"/i)
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim()
  }

  const plainMatch = output.match(/project\s+([a-z0-9-]+)/i)
  return plainMatch?.[1]?.trim() ?? ''
}

function buildGcpSdkError(label: string, error: unknown, apiServiceName = 'compute.googleapis.com'): Error {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim()

  if (outputIndicatesApiDisabled(detail)) {
    const projectId = extractProjectIdFromOutput(detail)
    const enableCommand = projectId
      ? `gcloud services enable ${apiServiceName} --project ${projectId}`
      : `gcloud services enable ${apiServiceName} --project <project-id>`

    return new Error(
      `Google Cloud API access failed while ${label}. The required API is disabled for the selected project. Run "${enableCommand}", wait for propagation, and retry.${detail ? ` ${detail}` : ''}`
    )
  }

  if (outputIndicatesAdcIssue(detail)) {
    return new Error(
      `Google Cloud SDK authorization failed while ${label}. Run "gcloud auth application-default login" or provide GOOGLE_APPLICATION_CREDENTIALS, then try again.${detail ? ` ${detail}` : ''}`
    )
  }

  if (outputIndicatesPermissionIssue(detail)) {
    return new Error(
      `Google Cloud SDK authorization failed while ${label}. Verify the selected credentials have the required IAM access for this project.${detail ? ` ${detail}` : ''}`
    )
  }

  return new Error(`Google Cloud SDK failed while ${label}.${detail ? ` ${detail}` : ''}`)
}

function getGcpAuth(projectId = ''): GoogleAuth {
  return new GoogleAuth({
    projectId: projectId.trim() || undefined,
    scopes: GCP_SDK_SCOPES
  })
}

async function requestGcp<T>(projectId: string, options: GcpRequestOptions): Promise<T> {
  const client = await getGcpAuth(projectId).getClient()
  const response = await client.request<T>({
    url: options.url,
    method: options.method ?? 'GET',
    headers: options.headers,
    data: options.data,
    responseType: options.responseType
  })

  return response.data
}

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

export async function listGcpEnabledApis(projectId: string): Promise<GcpEnabledApiSummary[]> {
  const services: GcpEnabledApiSummary[] = []
  let pageToken = ''

  do {
    const response = await requestGcp<{ services?: Array<Record<string, unknown>>; nextPageToken?: string }>(projectId, {
      url: `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services?filter=state:ENABLED&pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
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
  } while (pageToken)

  return services.sort((left, right) => left.title.localeCompare(right.title))
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

export async function listGcpServiceAccounts(projectId: string): Promise<GcpServiceAccountSummary[]> {
  const accounts: GcpServiceAccountSummary[] = []
  let pageToken = ''

  do {
    const response = await requestGcp<{ accounts?: Array<Record<string, unknown>>; nextPageToken?: string }>(projectId, {
      url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    })

    for (const entry of response.accounts ?? []) {
      const email = asString(entry.email)
      if (!email) {
        continue
      }

      accounts.push({
        email,
        displayName: asString(entry.displayName),
        disabled: asBoolean(entry.disabled)
      })
    }

    pageToken = asString(response.nextPageToken)
  } while (pageToken)

  return accounts.sort((left, right) => left.email.localeCompare(right.email))
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
  } while (pageToken)

  return datasets
}

async function listGcpBigQueryBillingExportTables(dataset: GcpBigQueryDatasetRecord): Promise<GcpBigQueryExportTableRecord[]> {
  const tables: GcpBigQueryExportTableRecord[] = []
  let pageToken = ''

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
  } while (pageToken)

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
    } while (pageToken)

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
    } while (pageToken)

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
    } while (pageToken)

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
    } while (pageToken)

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
    } while (pageToken)

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
    } while (pageToken)

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
    } while (pageToken)

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
