import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog } from 'electron'
import { GoogleAuth } from 'google-auth-library'
import { google } from 'googleapis'

import type {
  GcpBillingCapabilityHint,
  GcpBillingLinkedProjectSummary,
  GcpBillingOverview,
  GcpBillingOwnershipHint,
  GcpBillingOwnershipValue,
  GcpEnabledApiSummary,
  GcpIamBindingSummary,
  GcpIamCapabilityHint,
  GcpIamOverview,
  GcpIamPrincipalSummary,
  GcpComputeInstanceSummary,
  GcpLogEntryDetail,
  GcpGkeClusterSummary,
  GcpLogEntrySummary,
  GcpLogFacetCount,
  GcpLogQueryResult,
  GcpProjectCapabilityHint,
  GcpProjectOverview,
  GcpServiceAccountSummary,
  GcpSqlInstanceSummary,
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

type GcpRequestOptions = {
  data?: unknown
  headers?: Record<string, string>
  method?: 'DELETE' | 'GET' | 'POST'
  responseType?: 'arraybuffer' | 'json' | 'text'
  url: string
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

function formatMaintenanceWindow(day: unknown, hour: unknown): string {
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
    maintenanceWindow: formatMaintenanceWindow(maintenanceWindow.day, maintenanceWindow.hour)
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

async function listEnabledGcpApis(projectId: string): Promise<GcpEnabledApiSummary[]> {
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

async function listGcpServiceAccounts(projectId: string): Promise<GcpServiceAccountSummary[]> {
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
      listEnabledGcpApis(normalizedProjectId)
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
      notes: [
        'Linked-project analysis is limited to projects visible in the current catalog and under the current credentials.',
        'This slice focuses on linkage, visibility, and ownership posture. Spend exports and budget telemetry are not wired yet.'
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
