import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog } from 'electron'
import { GoogleAuth } from 'google-auth-library'
import { google } from 'googleapis'

import type {
  GcpComputeInstanceSummary,
  GcpGkeClusterSummary,
  GcpSqlInstanceSummary,
  GcpStorageBucketSummary,
  GcpStorageObjectContent,
  GcpStorageObjectSummary
} from '@shared/types'

const GCP_SDK_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']
const GCP_REGION_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+\d$/
const GCP_ZONE_PATTERN = /^[a-z]+(?:-[a-z0-9]+)+\d-[a-z]$/

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
