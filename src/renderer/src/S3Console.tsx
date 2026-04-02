import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { LEGACY_STORAGE_NAMESPACE } from '@shared/branding'
import './s3.css'
import { SvcState, variantForError } from './SvcState'

import type {
  AwsConnection,
  S3BucketGovernanceDetail,
  S3BucketGovernancePosture,
  S3BucketSummary,
  S3GovernanceOverview,
  S3GovernanceSeverity,
  S3ObjectSummary
} from '@shared/types'
import {
  createS3Bucket,
  createS3Folder,
  deleteS3Object,
  downloadS3ObjectTo,
  enableS3BucketEncryption,
  enableS3BucketVersioning,
  getS3GovernanceDetail,
  getS3ObjectContent,
  getS3PresignedUrl,
  listS3Buckets,
  listS3Governance,
  listS3Objects,
  openS3InVSCode,
  openS3Object,
  putS3BucketPolicy,
  putS3ObjectContent,
  uploadS3Object
} from './api'
import { ConfirmButton } from './ConfirmButton'

const TEXT_EXTENSIONS = new Set(['txt', 'json', 'xml', 'csv', 'yaml', 'yml', 'md', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'sh', 'bash', 'env', 'conf', 'cfg', 'ini', 'toml', 'log', 'sql', 'graphql', 'svg', 'tf', 'tfvars', 'tfstate', 'hcl', 'dockerfile', 'makefile', 'gitignore'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

type BucketTab = 'objects' | 'governance'
type BucketColKey = 'name' | 'created' | 'region' | 'risk'
type ColKey = 'name' | 'type' | 'key' | 'size' | 'modified' | 'storageClass'
type SummaryFilterKey = 'all' | 'high-risk' | 'public-risk' | 'no-encryption' | 'no-lifecycle' | 'important-no-versioning'
type BucketGroupKey = 'urgent' | 'attention' | 'covered' | 'unverified'
type GovernanceCheckItem = {
  label: string
  check:
    | S3BucketGovernancePosture['publicAccessBlock']
    | S3BucketGovernancePosture['encryption']
    | S3BucketGovernancePosture['versioning']
    | S3BucketGovernancePosture['lifecycle']
    | S3BucketGovernancePosture['policy']
    | S3BucketGovernancePosture['logging']
    | S3BucketGovernancePosture['replication']
}
type RemediationActionItem = {
  id: string
  title: string
  description: string
  detail: string
  actionLabel: string
  disabled?: boolean
  readOnly?: boolean
  onAction?: () => void
}
type RemediationFeedback = {
  bucketName: string
  action: string
  completedAt: string
  changedChecks: Array<{ label: string; before: string; after: string }>
  beforeSeverity: S3GovernanceSeverity
  afterSeverity: S3GovernanceSeverity
}
type HygieneCandidate = {
  key: string
  size: number
  lastModified: string
  ageDays: number
  reasons: string[]
}

const BUCKET_COLUMNS: { key: BucketColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'created', label: 'Created', color: '#14b8a6' },
  { key: 'region', label: 'Region', color: '#f97316' },
  { key: 'risk', label: 'Posture', color: '#ef4444' }
]

const OBJ_COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'type', label: 'Type', color: '#8b5cf6' },
  { key: 'key', label: 'Key', color: '#14b8a6' },
  { key: 'size', label: 'Size', color: '#f59e0b' },
  { key: 'modified', label: 'Modified', color: '#06b6d4' },
  { key: 'storageClass', label: 'Storage Class', color: '#22c55e' }
]

function getExtension(key: string): string {
  const parts = key.split('.')
  return parts.length > 1 ? parts.pop()!.toLowerCase() : ''
}

function isTextFile(key: string): boolean {
  const ext = getExtension(key)
  const name = key.split('/').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(name)
}

function isImageFile(key: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(key))
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatSeverity(severity: S3GovernanceSeverity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1)
}

function severityPriority(severity: S3GovernanceSeverity): number {
  switch (severity) {
    case 'critical': return 5
    case 'high': return 4
    case 'medium': return 3
    case 'low': return 2
    case 'info': return 1
  }
}

function severityClass(severity: S3GovernanceSeverity): string {
  return `s3-severity-${severity}`
}

function severityTone(severity: S3GovernanceSeverity | null): 'success' | 'warning' | 'danger' | 'info' {
  if (severity === 'critical' || severity === 'high') return 'danger'
  if (severity === 'medium' || severity === 'low') return 'warning'
  if (severity === 'info') return 'success'
  return 'info'
}

function publicBadgeLabel(posture: S3BucketGovernancePosture): string {
  switch (posture.publicAccessBlock.status) {
    case 'enabled': return 'Public Blocked'
    case 'partial': return 'Public Partial'
    case 'disabled': return 'Public Risk'
    default: return 'Public Unknown'
  }
}

function encryptionBadgeLabel(posture: S3BucketGovernancePosture): string {
  switch (posture.encryption.status) {
    case 'enabled': return 'Encrypted'
    case 'disabled': return 'No Encryption'
    default: return 'Encrypt Unknown'
  }
}

function versioningBadgeLabel(posture: S3BucketGovernancePosture): string {
  switch (posture.versioning.status) {
    case 'enabled': return 'Versioned'
    case 'suspended': return 'Version Suspended'
    case 'disabled': return 'Not Versioned'
    default: return 'Version Unknown'
  }
}

function badgeTone(status: 'enabled' | 'present' | 'disabled' | 'missing' | 'partial' | 'suspended' | 'unknown'): 'ok' | 'warn' | 'risk' {
  if (status === 'enabled' || status === 'present') return 'ok'
  if (status === 'partial' || status === 'suspended' || status === 'unknown') return 'warn'
  return 'risk'
}

function checkStatusLabel(status: S3BucketGovernancePosture['publicAccessBlock']['status']): string {
  switch (status) {
    case 'enabled': return 'Enabled'
    case 'present': return 'Present'
    case 'disabled': return 'Disabled'
    case 'missing': return 'Missing'
    case 'partial': return 'Partial'
    case 'suspended': return 'Suspended'
    case 'unknown': return 'Unknown'
  }
}

function bucketGroupKey(posture: S3BucketGovernancePosture | null): BucketGroupKey {
  if (!posture) return 'unverified'
  if (posture.highestSeverity === 'critical' || posture.highestSeverity === 'high') return 'urgent'
  if (posture.highestSeverity === 'medium' || posture.highestSeverity === 'low') return 'attention'
  return 'covered'
}

function bucketGroupLabel(group: BucketGroupKey): string {
  switch (group) {
    case 'urgent': return 'Urgent Buckets'
    case 'attention': return 'Needs Attention'
    case 'covered': return 'Stable / Covered'
    case 'unverified': return 'Unverified'
  }
}

function objectAgeDays(lastModified: string): number {
  if (lastModified === '-') return 0
  return Math.max(0, Math.floor((Date.now() - new Date(lastModified).getTime()) / (24 * 60 * 60 * 1000)))
}

function displayName(key: string, prefix: string): string {
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return relative.replace(/\/$/, '') || key
}

function resolveBucketConnection(connection: AwsConnection, buckets: S3BucketSummary[], bucketName: string): AwsConnection {
  const bucket = buckets.find((entry) => entry.name === bucketName)
  return bucket?.region ? { ...connection, region: bucket.region } : connection
}

function bucketStorageKey(connection: AwsConnection): string {
    return connection.kind === 'profile'
      ? `${LEGACY_STORAGE_NAMESPACE}:s3-known-buckets:profile:${connection.profile}`
      : `${LEGACY_STORAGE_NAMESPACE}:s3-known-buckets:assumed-role:${connection.profile}:${connection.roleArn}`
}

function loadStoredBuckets(connection: AwsConnection): S3BucketSummary[] {
  try {
    const raw = window.localStorage.getItem(bucketStorageKey(connection))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is S3BucketSummary => Boolean(entry) && typeof entry === 'object' && typeof (entry as S3BucketSummary).name === 'string')
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

function persistBuckets(connection: AwsConnection, bucketList: S3BucketSummary[]): void {
  try {
    window.localStorage.setItem(bucketStorageKey(connection), JSON.stringify(bucketList))
  } catch {
    // Ignore storage failures.
  }
}

function upsertBucket(bucketList: S3BucketSummary[], bucket: S3BucketSummary): S3BucketSummary[] {
  const merged = new Map(bucketList.map((entry) => [entry.name, entry]))
  const existing = merged.get(bucket.name)
  merged.set(bucket.name, {
    name: bucket.name,
    creationDate: bucket.creationDate !== '-' ? bucket.creationDate : existing?.creationDate ?? '-',
    region: bucket.region || existing?.region || ''
  })
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function isBucketInventoryPermissionError(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('listallmybuckets') || normalized.includes('listbuckets') || normalized.includes('accessdenied') || normalized.includes('access denied') || normalized.includes('not authorized')
}

function getObjectColValue(obj: S3ObjectSummary, col: ColKey, prefix: string): string {
  switch (col) {
    case 'name': return displayName(obj.key, prefix)
    case 'type': return obj.isFolder ? 'Folder' : getExtension(obj.key).toUpperCase() || 'File'
    case 'key': return obj.key
    case 'size': return obj.isFolder ? '-' : formatSize(obj.size)
    case 'modified': return obj.lastModified !== '-' ? new Date(obj.lastModified).toLocaleString() : '-'
    case 'storageClass': return obj.isFolder ? '-' : obj.storageClass
  }
}

function getBucketColValue(bucket: S3BucketSummary, posture: S3BucketGovernancePosture | null, col: BucketColKey): string {
  switch (col) {
    case 'name': return bucket.name
    case 'created': return bucket.creationDate !== '-' ? new Date(bucket.creationDate).toLocaleString() : '-'
    case 'region': return bucket.region || '-'
    case 'risk': return posture ? formatSeverity(posture.highestSeverity) : 'Pending'
  }
}

function getSummaryFilterLabel(filter: SummaryFilterKey): string {
  switch (filter) {
    case 'all': return 'All Buckets'
    case 'high-risk': return 'High/Critical Buckets'
    case 'public-risk': return 'Buckets With Public Access Risk'
    case 'no-encryption': return 'Buckets Without Default Encryption'
    case 'no-lifecycle': return 'Buckets Missing Lifecycle Rules'
    case 'important-no-versioning': return 'Important Buckets Without Versioning'
  }
}

function sortObjects(items: S3ObjectSummary[]): S3ObjectSummary[] {
  return [...items].sort((left, right) => {
    if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1
    return left.key.localeCompare(right.key)
  })
}

function upsertObject(items: S3ObjectSummary[], next: S3ObjectSummary): S3ObjectSummary[] {
  const filtered = items.filter((item) => item.key !== next.key)
  return sortObjects([...filtered, next])
}

export function S3Console({ connection }: { connection: AwsConnection }) {
  const [buckets, setBuckets] = useState<S3BucketSummary[]>(() => loadStoredBuckets(connection))
  const [governanceOverview, setGovernanceOverview] = useState<S3GovernanceOverview | null>(null)
  const [selectedBucket, setSelectedBucket] = useState('')
  const [selectedTab, setSelectedTab] = useState<BucketTab>('objects')
  const [bucketFilter, setBucketFilter] = useState('')
  const [visibleBucketCols, setVisibleBucketCols] = useState<Set<BucketColKey>>(new Set(['name', 'created', 'region', 'risk']))
  const [newBucketName, setNewBucketName] = useState('')
  const [showCreateBucket, setShowCreateBucket] = useState(false)
  const [manualBucketName, setManualBucketName] = useState('')
  const [inventoryMessage, setInventoryMessage] = useState('')
  const [objects, setObjects] = useState<S3ObjectSummary[]>([])
  const [prefix, setPrefix] = useState('')
  const [objectFilter, setObjectFilter] = useState('')
  const [visibleObjCols, setVisibleObjCols] = useState<Set<ColKey>>(new Set(['name', 'type', 'key', 'size', 'modified', 'storageClass']))
  const [selectedKey, setSelectedKey] = useState('')
  const [largeObjectThresholdMb, setLargeObjectThresholdMb] = useState('100')
  const [oldObjectDays, setOldObjectDays] = useState('180')
  const [showLargeOnly, setShowLargeOnly] = useState(false)
  const [showOldOnly, setShowOldOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [governanceLoading, setGovernanceLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [previewContent, setPreviewContent] = useState('')
  const [previewContentType, setPreviewContentType] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showPreviewFullscreen, setShowPreviewFullscreen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [governanceDetail, setGovernanceDetail] = useState<S3BucketGovernanceDetail | null>(null)
  const [policyEditor, setPolicyEditor] = useState('')
  const [showLifecycleJson, setShowLifecycleJson] = useState(false)
  const [showPolicyEditor, setShowPolicyEditor] = useState(false)
  const [selectedSummaryFilter, setSelectedSummaryFilter] = useState<SummaryFilterKey | null>(null)
  const [activeBucketAction, setActiveBucketAction] = useState('')
  const [remediationFeedback, setRemediationFeedback] = useState<RemediationFeedback | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const bucketPostureMap = useMemo(() => new Map((governanceOverview?.buckets ?? []).map((bucket) => [bucket.bucketName, bucket])), [governanceOverview])
  const selectedObj = objects.find((obj) => obj.key === selectedKey) ?? null
  const largeThresholdBytes = Math.max(1, Number(largeObjectThresholdMb) || 100) * 1024 * 1024
  const oldThresholdDays = Math.max(1, Number(oldObjectDays) || 180)
  const objectFiles = useMemo(() => objects.filter((obj) => !obj.isFolder), [objects])
  const largeObjects = useMemo(() => objectFiles.filter((obj) => obj.size >= largeThresholdBytes).sort((left, right) => right.size - left.size), [objectFiles, largeThresholdBytes])
  const oldObjects = useMemo(() => {
    const cutoff = Date.now() - oldThresholdDays * 24 * 60 * 60 * 1000
    return objectFiles.filter((obj) => obj.lastModified !== '-' && new Date(obj.lastModified).getTime() < cutoff)
  }, [objectFiles, oldThresholdDays])
  const storageClassSummary = useMemo(() => {
    const summary = new Map<string, { storageClass: string; count: number; totalBytes: number }>()
    for (const obj of objectFiles) {
      const key = obj.storageClass || 'STANDARD'
      const current = summary.get(key) ?? { storageClass: key, count: 0, totalBytes: 0 }
      current.count += 1
      current.totalBytes += obj.size
      summary.set(key, current)
    }
    return [...summary.values()].sort((left, right) => right.totalBytes - left.totalBytes)
  }, [objectFiles])
  const policyDirty = governanceDetail !== null && policyEditor !== governanceDetail.policyJson
  const selectedPosture = governanceDetail?.posture.bucketName === selectedBucket
    ? governanceDetail.posture
    : bucketPostureMap.get(selectedBucket) ?? null
  const hygieneCandidates = useMemo(() => {
    return objectFiles
      .map((obj) => {
        const reasons: string[] = []
        const ageDays = objectAgeDays(obj.lastModified)
        if (obj.size >= largeThresholdBytes) {
          reasons.push(`${formatSize(obj.size)} exceeds ${Number(largeObjectThresholdMb) || 100} MB`)
        }
        if (ageDays >= oldThresholdDays) {
          reasons.push(`${ageDays} days old`)
        }
        return {
          key: obj.key,
          size: obj.size,
          lastModified: obj.lastModified,
          ageDays,
          reasons
        } satisfies HygieneCandidate
      })
      .filter((candidate) => candidate.reasons.length > 0)
      .sort((left, right) => {
        const reasonDelta = right.reasons.length - left.reasons.length
        if (reasonDelta !== 0) return reasonDelta
        const sizeDelta = right.size - left.size
        if (sizeDelta !== 0) return sizeDelta
        return right.ageDays - left.ageDays
      })
  }, [largeObjectThresholdMb, largeThresholdBytes, objectFiles, oldThresholdDays])
  const topHygieneCandidates = useMemo(() => hygieneCandidates.slice(0, 8), [hygieneCandidates])

  const summaryFilterBuckets = useMemo(() => {
    const postures = governanceOverview?.buckets ?? []
    if (!selectedSummaryFilter) return []
    return postures.flatMap((posture) => {
      switch (selectedSummaryFilter) {
        case 'all':
          return [{ bucketName: posture.bucketName, reason: `${formatSeverity(posture.highestSeverity)} posture in ${posture.region}.` }]
        case 'high-risk':
          return posture.highestSeverity === 'critical' || posture.highestSeverity === 'high'
            ? [{ bucketName: posture.bucketName, reason: posture.findings[0]?.title ?? `${formatSeverity(posture.highestSeverity)} governance finding.` }]
            : []
        case 'public-risk':
          return posture.publicAccessBlock.status !== 'enabled'
            ? [{ bucketName: posture.bucketName, reason: posture.publicAccessBlock.summary }]
            : []
        case 'no-encryption':
          return posture.encryption.status !== 'enabled'
            ? [{ bucketName: posture.bucketName, reason: posture.encryption.summary }]
            : []
        case 'no-lifecycle':
          return posture.lifecycle.status === 'missing'
            ? [{ bucketName: posture.bucketName, reason: posture.lifecycle.summary }]
            : []
        case 'important-no-versioning':
          return posture.important && posture.versioning.status !== 'enabled'
            ? [{ bucketName: posture.bucketName, reason: posture.versioning.summary || posture.importantReason }]
            : []
      }
    })
  }, [governanceOverview, selectedSummaryFilter])

  function replaceBuckets(nextBuckets: S3BucketSummary[]): void {
    setBuckets(nextBuckets)
    persistBuckets(connection, nextBuckets)
  }

  async function loadGovernanceSummary(): Promise<void> {
    setGovernanceLoading(true)
    try {
      setGovernanceOverview(await listS3Governance(connection))
    } catch (e) {
      setGovernanceOverview(null)
      if (!isBucketInventoryPermissionError(e instanceof Error ? e.message : String(e))) {
        setError(e instanceof Error ? e.message : String(e))
      } else {
        setError('')
      }
    } finally {
      setGovernanceLoading(false)
    }
  }

  async function loadBucketGovernanceDetail(bucketName: string, force = false): Promise<void> {
    if (!bucketName) return
    if (!force && governanceDetail?.posture.bucketName === bucketName) return
    setDetailLoading(true)
    try {
      const detail = await getS3GovernanceDetail(resolveBucketConnection(connection, buckets, bucketName), bucketName)
      setGovernanceDetail(detail)
      setPolicyEditor(detail.policyJson)
      setShowPolicyEditor(Boolean(detail.policyJson))
    } catch (e) {
      setGovernanceDetail(null)
      setPolicyEditor('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetailLoading(false)
    }
  }

  async function loadBucketsAndSelection(selectBucket?: string, nextPrefix = ''): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const bucketList = await listS3Buckets(connection)
      replaceBuckets(bucketList)
      setInventoryMessage('')
      const targetBucket = selectBucket ?? selectedBucket ?? bucketList[0]?.name ?? ''
      if (!targetBucket) {
        setObjects([])
        setSelectedBucket('')
        setPrefix('')
        return
      }
      setSelectedBucket(targetBucket)
      setPrefix(nextPrefix)
      setSelectedKey('')
      closePreview()
      setObjects(await listS3Objects(resolveBucketConnection(connection, bucketList, targetBucket), targetBucket, nextPrefix))
      if (selectedTab === 'governance') {
        await loadBucketGovernanceDetail(targetBucket, true)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (isBucketInventoryPermissionError(message)) {
        replaceBuckets(loadStoredBuckets(connection))
        setGovernanceOverview(null)
        setInventoryMessage('This profile cannot list every bucket. Open a bucket directly by name, or pick one that was previously opened.')
        setError('')
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }

  async function openBucketByName(name: string, newPrefix = ''): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    setLoading(true)
    try {
      const nextBuckets = upsertBucket(buckets, { name: trimmed, creationDate: '-', region: connection.region })
      replaceBuckets(nextBuckets)
      setSelectedBucket(trimmed)
      setPrefix(newPrefix)
      setSelectedKey('')
      closePreview()
      setObjects(await listS3Objects(resolveBucketConnection(connection, nextBuckets, trimmed), trimmed, newPrefix))
      setInventoryMessage((current) => current || 'Bucket inventory is limited for this profile. Open buckets directly by name.')
      setManualBucketName('')
      if (selectedTab === 'governance') {
        await loadBucketGovernanceDetail(trimmed, true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function browseBucket(name: string, newPrefix = ''): Promise<void> {
    setSelectedBucket(name)
    setPrefix(newPrefix)
    setSelectedKey('')
    setGovernanceDetail(null)
    closePreview()
    try {
      setObjects(await listS3Objects(resolveBucketConnection(connection, buckets, name), name, newPrefix))
      if (selectedTab === 'governance') {
        await loadBucketGovernanceDetail(name, true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function refreshAll(bucketName = selectedBucket, nextPrefix = prefix): Promise<void> {
    await Promise.all([loadBucketsAndSelection(bucketName, nextPrefix), loadGovernanceSummary()])
  }

  function refreshObjectsInBackground(bucketName = selectedBucket, nextPrefix = prefix): void {
    if (!bucketName) return
    void listS3Objects(resolveBucketConnection(connection, buckets, bucketName), bucketName, nextPrefix)
      .then((nextObjects) => {
        setObjects(nextObjects)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  function refreshAllInBackground(bucketName = selectedBucket, nextPrefix = prefix): void {
    void refreshAll(bucketName, nextPrefix).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  async function runBucketRemediation(actionLabel: string, mutation: () => Promise<void>): Promise<void> {
    if (!selectedBucket) return
    const beforePosture = governanceDetail?.posture.bucketName === selectedBucket
      ? governanceDetail.posture
      : bucketPostureMap.get(selectedBucket) ?? null

    setActiveBucketAction(actionLabel)
    setError('')

    try {
      await mutation()
      await refreshAll(selectedBucket, prefix)
      const refreshedDetail = await getS3GovernanceDetail(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket)
      setGovernanceDetail(refreshedDetail)
      setPolicyEditor(refreshedDetail.policyJson)
      setShowPolicyEditor((current) => current || Boolean(refreshedDetail.policyJson))

      const changedChecks = beforePosture ? [
        { label: 'Public access block', before: beforePosture.publicAccessBlock.status, after: refreshedDetail.posture.publicAccessBlock.status },
        { label: 'Default encryption', before: beforePosture.encryption.status, after: refreshedDetail.posture.encryption.status },
        { label: 'Versioning', before: beforePosture.versioning.status, after: refreshedDetail.posture.versioning.status },
        { label: 'Lifecycle', before: beforePosture.lifecycle.status, after: refreshedDetail.posture.lifecycle.status },
        { label: 'Bucket policy', before: beforePosture.policy.status, after: refreshedDetail.posture.policy.status }
      ]
        .filter((entry) => entry.before !== entry.after)
        .map((entry) => ({
          label: entry.label,
          before: checkStatusLabel(entry.before),
          after: checkStatusLabel(entry.after)
        })) : []

      setRemediationFeedback({
        bucketName: selectedBucket,
        action: actionLabel,
        completedAt: new Date().toISOString(),
        changedChecks,
        beforeSeverity: beforePosture?.highestSeverity ?? refreshedDetail.posture.highestSeverity,
        afterSeverity: refreshedDetail.posture.highestSeverity
      })

      setMsg(changedChecks.length > 0
        ? `${actionLabel} applied to ${selectedBucket}. ${changedChecks.map((entry) => `${entry.label}: ${entry.after}`).join(' | ')}`
        : `${actionLabel} applied to ${selectedBucket}. Posture refreshed.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActiveBucketAction('')
    }
  }

  function goUp(): void {
    if (!prefix) return
    const parts = prefix.replace(/\/$/, '').split('/')
    parts.pop()
    const nextPrefix = parts.length ? `${parts.join('/')}/` : ''
    setPrefix(nextPrefix)
    void browseBucket(selectedBucket, nextPrefix)
  }

  async function doPreview(key: string): Promise<void> {
    if (!selectedBucket) return
    setShowPreview(true)
    setEditing(false)
    setPreviewContent('')
    setPreviewUrl('')
    if (isImageFile(key)) {
      const url = await getS3PresignedUrl(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, key)
      setPreviewUrl(url)
      setPreviewContentType('image')
      return
    }
    if (isTextFile(key)) {
      const result = await getS3ObjectContent(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, key)
      setPreviewContent(result.body)
      setPreviewContentType(result.contentType)
      return
    }
    setPreviewContent('Preview not available for this file type.')
    setPreviewContentType('unsupported')
  }

  function closePreview(): void {
    setShowPreview(false)
    setShowPreviewFullscreen(false)
    setEditing(false)
    setPreviewContent('')
    setPreviewUrl('')
  }

  useEffect(() => {
    void refreshAll()
  }, [connection.sessionId, connection.region])

  useEffect(() => {
    setBuckets(loadStoredBuckets(connection))
    setGovernanceOverview(null)
    setSelectedBucket('')
    setSelectedTab('objects')
    setObjects([])
    setPrefix('')
    setSelectedKey('')
    setGovernanceDetail(null)
    setPolicyEditor('')
    setSelectedSummaryFilter(null)
    setActiveBucketAction('')
    setRemediationFeedback(null)
    setInventoryMessage('')
    setManualBucketName('')
    closePreview()
  }, [connection.sessionId])

  useEffect(() => {
    if (selectedTab === 'governance' && selectedBucket) {
      void loadBucketGovernanceDetail(selectedBucket)
    }
  }, [selectedTab, selectedBucket])

  const filteredBuckets = buckets.filter((bucket) => {
    if (!bucketFilter) return true
    const search = bucketFilter.toLowerCase()
    const posture = bucketPostureMap.get(bucket.name) ?? (governanceDetail?.posture.bucketName === bucket.name ? governanceDetail.posture : null)
    return BUCKET_COLUMNS.some((column) => getBucketColValue(bucket, posture, column.key).toLowerCase().includes(search))
  })
  const groupedBuckets = useMemo(() => {
    const groups = new Map<BucketGroupKey, Array<{ bucket: S3BucketSummary; posture: S3BucketGovernancePosture | null }>>([
      ['urgent', []],
      ['attention', []],
      ['covered', []],
      ['unverified', []]
    ])

    for (const bucket of filteredBuckets) {
      const posture = bucketPostureMap.get(bucket.name) ?? (governanceDetail?.posture.bucketName === bucket.name ? governanceDetail.posture : null)
      groups.get(bucketGroupKey(posture))!.push({ bucket, posture })
    }

    for (const [, entries] of groups) {
      entries.sort((left, right) => {
        const severityDelta = severityPriority(right.posture?.highestSeverity ?? 'info') - severityPriority(left.posture?.highestSeverity ?? 'info')
        if (severityDelta !== 0) return severityDelta
        return left.bucket.name.localeCompare(right.bucket.name)
      })
    }

    return groups
  }, [bucketPostureMap, filteredBuckets, governanceDetail])

  const activeBucketCols = BUCKET_COLUMNS.filter((column) => visibleBucketCols.has(column.key))
  const filteredObjects = objects.filter((obj) => {
    const isLarge = obj.isFolder || obj.size >= largeThresholdBytes
    const isOld = obj.isFolder || oldObjects.some((oldObj) => oldObj.key === obj.key)
    if (showLargeOnly && !isLarge) return false
    if (showOldOnly && !isOld) return false
    if (!objectFilter) return true
    return OBJ_COLUMNS.some((column) => getObjectColValue(obj, column.key, prefix).toLowerCase().includes(objectFilter.toLowerCase()))
  })

  const activeObjCols = OBJ_COLUMNS.filter((column) => visibleObjCols.has(column.key))
  const selectedBucketSummary = buckets.find((bucket) => bucket.name === selectedBucket) ?? null
  const selectedBucketTone = severityTone(selectedPosture?.highestSeverity ?? null)
  const selectedFolderCount = objects.filter((obj) => obj.isFolder).length
  const bucketCount = governanceOverview?.summary.bucketCount ?? buckets.length
  const riskyBucketCount = governanceOverview?.summary.riskyBucketCount ?? 0
  const lifecycleGapCount = governanceOverview?.summary.missingLifecycleCount ?? 0
  const unversionedImportantCount = governanceOverview?.summary.importantWithoutVersioningCount ?? 0
  const nextActions = useMemo<RemediationActionItem[]>(() => {
    if (!selectedBucket || !selectedPosture) return []

    const actions: RemediationActionItem[] = []

    if (selectedPosture.encryption.status !== 'enabled') {
      actions.push({
        id: 'enable-encryption',
        title: 'Enable default encryption',
        description: 'Protect new uploads with bucket-level default encryption.',
        detail: selectedPosture.encryption.summary,
        actionLabel: activeBucketAction === 'Enable default encryption' ? 'Applying...' : 'Enable Encryption',
        disabled: activeBucketAction.length > 0,
        onAction: () => {
          setSelectedTab('governance')
          void runBucketRemediation('Enable default encryption', async () => {
          await enableS3BucketEncryption(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket)
          })
        }
      })
    }

    if (selectedPosture.versioning.status !== 'enabled') {
      actions.push({
        id: 'enable-versioning',
        title: 'Enable versioning',
        description: selectedPosture.important ? 'Recommended first for important buckets.' : 'Improve overwrite and delete recovery.',
        detail: selectedPosture.versioning.summary,
        actionLabel: activeBucketAction === 'Enable versioning' ? 'Applying...' : 'Enable Versioning',
        disabled: activeBucketAction.length > 0,
        onAction: () => {
          setSelectedTab('governance')
          void runBucketRemediation('Enable versioning', async () => {
          await enableS3BucketVersioning(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket)
          })
        }
      })
    }

    actions.push({
      id: 'policy-editor',
      title: 'Review bucket policy',
      description: policyDirty ? 'Unsaved edits are ready to apply.' : 'Inspect or update the current bucket policy JSON.',
      detail: selectedPosture.policy.summary,
      actionLabel: showPolicyEditor ? 'Hide Policy' : 'Open Policy',
      onAction: () => {
        setSelectedTab('governance')
        setShowPolicyEditor((current) => !current)
      }
    })

    actions.push({
      id: 'lifecycle-inspect',
      title: 'Inspect lifecycle configuration',
      description: selectedPosture.lifecycle.status === 'missing'
        ? 'No lifecycle rules are configured. Review object hygiene first.'
        : 'Inspect lifecycle rules before tuning hygiene or retention.',
      detail: selectedPosture.lifecycle.summary,
      actionLabel: showLifecycleJson ? 'Hide Lifecycle' : 'Inspect Lifecycle',
      readOnly: true,
      onAction: () => {
        setSelectedTab('governance')
        setShowLifecycleJson((current) => !current)
      }
    })

    if (selectedPosture.publicAccessBlock.status !== 'enabled') {
      actions.push({
        id: 'public-access',
        title: 'Review public access posture',
        description: 'This finding is surfaced clearly but remains read-only here.',
        detail: selectedPosture.publicAccessBlock.summary,
        actionLabel: 'Open Governance',
        readOnly: true,
        onAction: () => setSelectedTab('governance')
      })
    }

    if (topHygieneCandidates.length > 0) {
      actions.push({
        id: 'object-hygiene',
        title: 'Triage object hygiene',
        description: `${topHygieneCandidates.length} large or old object candidates are visible in this prefix.`,
        detail: topHygieneCandidates[0]?.reasons.join(' | ') ?? '',
        actionLabel: 'Open Hygiene',
        readOnly: true,
        onAction: () => setSelectedTab('objects')
      })
    }

    return actions
  }, [
    activeBucketAction,
    buckets,
    connection,
    policyDirty,
    selectedBucket,
    selectedPosture,
    showLifecycleJson,
    showPolicyEditor,
    topHygieneCandidates
  ])

  if (loading && buckets.length === 0) {
    return <SvcState variant="loading" resourceName="S3" />
  }

  return (
    <div className="s3-console">
      {inventoryMessage && (
        <SvcState
          variant="partial-data"
          message={inventoryMessage}
          onDismiss={() => setInventoryMessage('')}
        />
      )}
      {error && <SvcState variant={variantForError(error)} error={error} onDismiss={() => setError('')} />}
      {msg && <div className="s3-msg s3-msg-ok">{msg}<button type="button" className="s3-msg-close" onClick={() => setMsg('')}>x</button></div>}
      <section className="s3-shell-hero">
        <div className="s3-shell-hero-copy">
          <div className="s3-eyebrow">Object storage posture</div>
          <h2>S3 Operations</h2>
          <p>Bucket governance, object hygiene, and object editing mapped onto the Terraform console language without changing S3 workflows.</p>
          <div className="s3-shell-meta-strip">
            <div className="s3-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.kind === 'profile' ? connection.profile : connection.roleArn}</strong>
            </div>
            <div className="s3-shell-meta-pill">
              <span>Selected bucket</span>
              <strong>{selectedBucket || 'No bucket selected'}</strong>
            </div>
            <div className="s3-shell-meta-pill">
              <span>Path</span>
              <strong>/{prefix || ''}</strong>
            </div>
            <div className="s3-shell-meta-pill">
              <span>Mode</span>
              <strong>{selectedTab === 'objects' ? 'Object browser' : 'Governance review'}</strong>
            </div>
          </div>
        </div>
        <div className="s3-shell-hero-stats">
          <div className="s3-shell-stat-card s3-shell-stat-card-accent">
            <span>Tracked buckets</span>
            <strong>{bucketCount}</strong>
            <small>Inventory cached locally and refreshed from AWS.</small>
          </div>
          <div className="s3-shell-stat-card danger">
            <span>High-risk buckets</span>
            <strong>{riskyBucketCount}</strong>
            <small>Critical or high severity governance posture.</small>
          </div>
          <div className="s3-shell-stat-card">
            <span>Lifecycle gaps</span>
            <strong>{lifecycleGapCount}</strong>
            <small>Buckets missing lifecycle automation.</small>
          </div>
          <div className="s3-shell-stat-card">
            <span>Important unversioned</span>
            <strong>{unversionedImportantCount}</strong>
            <small>Important buckets still lacking versioning.</small>
          </div>
        </div>
      </section>

      <div className="s3-shell-toolbar">
        <div className="s3-toolbar">
          <button className="s3-btn" type="button" onClick={() => void refreshAll()} disabled={loading || governanceLoading}>Refresh</button>
          <button className={`s3-btn ${selectedTab === 'governance' ? 'accent' : ''}`} type="button" onClick={() => setSelectedTab('governance')} disabled={!selectedBucket}>Open Governance</button>
          <button className="s3-btn" type="button" onClick={goUp} disabled={!prefix || selectedTab !== 'objects'}>Go Up</button>
          <button className="s3-btn" type="button" onClick={() => void openS3Object(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)} disabled={!selectedKey || !!selectedObj?.isFolder || selectedTab !== 'objects'}>Open / Preview</button>
        </div>
        <div className="s3-shell-status">
          {inventoryMessage && <div className="s3-inline-note">{inventoryMessage}</div>}
          <div className="s3-inline-note">{loading || governanceLoading ? 'Refreshing inventory...' : 'Console ready'}</div>
        </div>
      </div>

      <div className="s3-layout">
        <div className="s3-bucket-panel">
          <div className="s3-pane-head">
            <div>
              <span className="s3-pane-kicker">Tracked buckets</span>
              <h3>Workspace inventory</h3>
            </div>
            <span className="s3-pane-summary">{filteredBuckets.length} visible</span>
          </div>

          <input className="s3-filter-input" placeholder="Filter buckets..." value={bucketFilter} onChange={(e) => setBucketFilter(e.target.value)} />

          <div className="s3-inline-form s3-inline-form-stacked">
            <input
              placeholder="open bucket by name"
              value={manualBucketName}
              onChange={(e) => setManualBucketName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void openBucketByName(manualBucketName) }}
            />
            <button className="s3-btn" type="button" onClick={() => void openBucketByName(manualBucketName)} disabled={!manualBucketName.trim()}>
              Open Bucket
            </button>
          </div>

          {showCreateBucket ? (
            <div className="s3-inline-form s3-inline-form-stacked">
              <input placeholder="bucket-name" value={newBucketName} onChange={(e) => setNewBucketName(e.target.value)} />
              <button className="s3-btn s3-btn-ok" type="button" onClick={() => void (async () => {
                await createS3Bucket(connection, newBucketName)
                replaceBuckets(upsertBucket(buckets, { name: newBucketName, creationDate: '-', region: connection.region }))
                setMsg(`Bucket "${newBucketName}" created`)
                setNewBucketName('')
                setShowCreateBucket(false)
                await refreshAll(newBucketName, '')
              })()}>Create</button>
              <button className="s3-btn" type="button" onClick={() => setShowCreateBucket(false)}>Cancel</button>
            </div>
          ) : <button className="s3-btn s3-btn-create-bucket" type="button" onClick={() => setShowCreateBucket(true)}>Create Bucket</button>}

          <div className="s3-column-chips s3-column-chips-muted">
            {BUCKET_COLUMNS.map((column) => (
              <button
                key={column.key}
                className={`s3-chip ${visibleBucketCols.has(column.key) ? 'active' : ''}`}
                type="button"
                style={visibleBucketCols.has(column.key) ? { background: column.color, borderColor: column.color, color: '#fff' } : undefined}
                onClick={() => setVisibleBucketCols((prev) => {
                  const next = new Set(prev)
                  next.has(column.key) ? next.delete(column.key) : next.add(column.key)
                  return next
                })}
              >
                {column.label}
              </button>
            ))}
          </div>

          <div className="s3-bucket-list">
            {(['urgent', 'attention', 'covered', 'unverified'] as BucketGroupKey[]).map((group) => {
              const entries = groupedBuckets.get(group) ?? []
              if (entries.length === 0) return null
              return (
                <Fragment key={group}>
                  <div className="s3-group-header">
                    <strong>{bucketGroupLabel(group)}</strong>
                    <span>{entries.length}</span>
                  </div>
                  {entries.map(({ bucket, posture }) => (
                    <button
                      key={bucket.name}
                      type="button"
                      className={`s3-bucket-row ${bucket.name === selectedBucket ? 'active' : ''}`}
                      onClick={() => void browseBucket(bucket.name)}
                    >
                      <div className="s3-bucket-row-top">
                        <div className="s3-bucket-row-identity">
                          <div className="s3-bucket-row-glyph">S3</div>
                          <div className="s3-bucket-row-copy">
                            <span className="s3-bucket-row-kicker">Bucket</span>
                            <strong>{bucket.name}</strong>
                            <span>{bucket.region || 'Region pending'} | {bucket.creationDate !== '-' ? new Date(bucket.creationDate).toLocaleDateString() : 'Creation date pending'}</span>
                          </div>
                        </div>
                        <span className={`s3-status-badge ${posture ? severityTone(posture.highestSeverity) : 'info'}`}>
                          {posture ? formatSeverity(posture.highestSeverity) : 'Pending'}
                        </span>
                      </div>
                      <div className="s3-bucket-row-meta">
                        {activeBucketCols.filter((column) => column.key !== 'risk' && column.key !== 'name').map((column) => (
                          <span key={column.key}>{column.label}: {getBucketColValue(bucket, posture, column.key)}</span>
                        ))}
                      </div>
                      <div className="s3-bucket-row-metrics">
                        <div className="s3-bucket-row-metric is-primary">
                          <span>Findings</span>
                          <strong>{posture?.findings.length ?? 0}</strong>
                        </div>
                        <div className="s3-bucket-row-metric">
                          <span>Access</span>
                          <strong>{posture ? publicBadgeLabel(posture) : 'Pending'}</strong>
                        </div>
                        <div className="s3-bucket-row-metric">
                          <span>Encryption</span>
                          <strong>{posture ? encryptionBadgeLabel(posture) : 'Pending'}</strong>
                        </div>
                      </div>
                      {posture?.findings[0] && <div className="s3-bucket-row-note">{posture.findings[0].title}</div>}
                    </button>
                  ))}
                </Fragment>
              )
            })}
          </div>
        </div>

        <div className="s3-browser-panel">
          {!selectedBucket ? (
            <SvcState variant="no-selection" resourceName="bucket" message="Select a bucket to view objects or governance posture." />
          ) : (
            <>
              <section className="s3-detail-hero">
                <div className="s3-detail-hero-copy">
                  <div className="s3-eyebrow">Bucket posture</div>
                  <h3>{selectedBucket}</h3>
                  <p>{selectedBucketSummary?.region ? `Region ${selectedBucketSummary.region}` : 'Region not loaded yet'} | /{prefix || ''}</p>
                  <div className="s3-detail-meta-strip">
                    <div className="s3-detail-meta-pill">
                      <span>Created</span>
                      <strong>{selectedBucketSummary?.creationDate && selectedBucketSummary.creationDate !== '-' ? new Date(selectedBucketSummary.creationDate).toLocaleString() : 'Pending'}</strong>
                    </div>
                    <div className="s3-detail-meta-pill">
                      <span>Public access</span>
                      <strong>{selectedPosture ? publicBadgeLabel(selectedPosture) : 'Pending posture'}</strong>
                    </div>
                    <div className="s3-detail-meta-pill">
                      <span>Encryption</span>
                      <strong>{selectedPosture ? encryptionBadgeLabel(selectedPosture) : 'Pending posture'}</strong>
                    </div>
                    <div className="s3-detail-meta-pill">
                      <span>Versioning</span>
                      <strong>{selectedPosture ? versioningBadgeLabel(selectedPosture) : 'Pending posture'}</strong>
                    </div>
                  </div>
                </div>
                <div className="s3-detail-hero-stats">
                  <div className={`s3-detail-stat-card ${selectedBucketTone}`}>
                    <span>Bucket state</span>
                    <strong>{selectedPosture ? formatSeverity(selectedPosture.highestSeverity) : 'Pending'}</strong>
                    <small>{selectedPosture?.findings[0]?.title ?? 'Governance posture is available from the right-side tab.'}</small>
                  </div>
                  <div className="s3-detail-stat-card">
                    <span>Objects in view</span>
                    <strong>{objectFiles.length}</strong>
                    <small>{selectedFolderCount} folders in the current prefix.</small>
                  </div>
                  <div className="s3-detail-stat-card">
                    <span>Hygiene candidates</span>
                    <strong>{hygieneCandidates.length}</strong>
                    <small>Large or stale objects within current thresholds.</small>
                  </div>
                  <div className="s3-detail-stat-card">
                    <span>Next actions</span>
                    <strong>{nextActions.length}</strong>
                    <small>{selectedTab === 'governance' ? 'Governance actions ready.' : 'Switch tabs to review governance follow-up.'}</small>
                  </div>
                </div>
              </section>

              <div className="s3-detail-tabs">
                <button className={selectedTab === 'objects' ? 'active' : ''} type="button" onClick={() => setSelectedTab('objects')}>Objects</button>
                <button className={selectedTab === 'governance' ? 'active' : ''} type="button" onClick={() => setSelectedTab('governance')}>Governance</button>
              </div>

              <div className="s3-path-bar">
                <span className="s3-path-label">Bucket: {selectedBucket} Path: /{prefix}</span>
                <div className="s3-path-actions">
                  <button className="s3-btn" type="button" onClick={goUp} disabled={!prefix || selectedTab !== 'objects'}>Up</button>
                  <button className="s3-btn" type="button" onClick={() => void openS3Object(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)} disabled={!selectedKey || !!selectedObj?.isFolder || selectedTab !== 'objects'}>Open / Preview</button>
                </div>
              </div>

          {remediationFeedback && remediationFeedback.bucketName === selectedBucket && (
            <div className="s3-remediation-feedback">
              <div className="s3-remediation-feedback-head">
                <strong>{remediationFeedback.action}</strong>
                <span>{new Date(remediationFeedback.completedAt).toLocaleString()}</span>
              </div>
              <div className="s3-remediation-feedback-summary">
                Severity {formatSeverity(remediationFeedback.beforeSeverity)} -&gt; {formatSeverity(remediationFeedback.afterSeverity)}
              </div>
              {remediationFeedback.changedChecks.length > 0 ? remediationFeedback.changedChecks.map((entry) => (
                <div key={entry.label} className="s3-remediation-feedback-item">
                  <span>{entry.label}</span>
                  <strong>{entry.before} -&gt; {entry.after}</strong>
                </div>
              )) : <div className="s3-remediation-feedback-item"><span>Posture</span><strong>Refreshed after action</strong></div>}
            </div>
          )}

          {selectedTab === 'objects' ? (
            <>
              <input className="s3-filter-input" placeholder="Filter objects..." value={objectFilter} onChange={(e) => setObjectFilter(e.target.value)} />

              <div className="s3-column-chips">
                {OBJ_COLUMNS.map((column) => (
                  <button
                    key={column.key}
                    className={`s3-chip ${visibleObjCols.has(column.key) ? 'active' : ''}`}
                    type="button"
                    style={visibleObjCols.has(column.key) ? { background: column.color, borderColor: column.color, color: '#fff' } : undefined}
                    onClick={() => setVisibleObjCols((prev) => {
                      const next = new Set(prev)
                      next.has(column.key) ? next.delete(column.key) : next.add(column.key)
                      return next
                    })}
                  >
                    {column.label}
                  </button>
                ))}
              </div>

              <div className="s3-object-table-wrap">
                <table className="s3-object-table">
                  <thead><tr>{activeObjCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
                  <tbody>
                    {filteredObjects.map((obj) => (
                      <tr key={obj.key} className={obj.key === selectedKey ? 'active' : ''} onClick={() => {
                        if (obj.isFolder) {
                          void browseBucket(selectedBucket, obj.key)
                        } else {
                          setSelectedKey(obj.key)
                          void doPreview(obj.key)
                        }
                      }}>
                        {activeObjCols.map((column) => <td key={column.key}>{column.key === 'name' && obj.isFolder && <span className="s3-folder-icon">&#128193; </span>}{getObjectColValue(obj, column.key, prefix)}</td>)}
                      </tr>
                    ))}
                    {filteredObjects.length === 0 && <tr><td colSpan={activeObjCols.length}>{objects.length === 0 ? <SvcState variant="empty" message="Empty folder." compact /> : <SvcState variant="no-filter-matches" resourceName="objects" compact />}</td></tr>}
                  </tbody>
                </table>
              </div>

              {showPreview && selectedKey && (
                <div className="s3-preview-panel">
                  <div className="s3-preview-header">
                    <span className="s3-preview-title">{selectedKey.split('/').pop()}</span>
                    <div className="s3-preview-actions">
                      {isTextFile(selectedKey) && !editing && (
                        <>
                          <button className="s3-btn s3-btn-edit" type="button" onClick={() => { setEditing(true); setEditContent(previewContent) }}>Edit</button>
                          <button className="s3-btn" type="button" onClick={() => void openS3InVSCode(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)}>Edit in VS Code</button>
                        </>
                      )}
                      <button className="s3-btn" type="button" onClick={() => setShowPreviewFullscreen(true)}>See Full Screen</button>
                      {editing && (
                        <>
                          <button className="s3-btn s3-btn-ok" type="button" onClick={() => void (async () => {
                            setSaving(true)
                            await putS3ObjectContent(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey, editContent, previewContentType)
                            setSaving(false)
                            setEditing(false)
                            setPreviewContent(editContent)
                            setMsg(`Saved ${selectedKey}`)
                            refreshObjectsInBackground(selectedBucket, prefix)
                            refreshAllInBackground(selectedBucket, prefix)
                          })()} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                          <button className="s3-btn" type="button" onClick={() => setEditing(false)}>Cancel</button>
                        </>
                      )}
                      <button className="s3-btn" type="button" onClick={closePreview}>Close</button>
                    </div>
                  </div>
                  <div className="s3-preview-body">
                    {previewUrl && previewContentType === 'image' && <img src={previewUrl} alt={selectedKey} className="s3-preview-image" />}
                    {!previewUrl && !editing && previewContent && <pre className="s3-preview-text">{previewContent}</pre>}
                    {editing && <textarea className="s3-edit-area" value={editContent} onChange={(e) => setEditContent(e.target.value)} />}
                    {!previewUrl && !previewContent && !editing && <SvcState variant="loading" resourceName="preview" compact />}
                  </div>
                </div>
              )}

              <div className="s3-action-bar">
                {showNewFolder ? (
                  <div className="s3-inline-form">
                    <input placeholder="folder name" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} />
                    <button className="s3-btn s3-btn-ok" type="button" onClick={() => void (async () => {
                      await createS3Folder(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, prefix + newFolderName)
                      setMsg(`Folder "${newFolderName}" created`)
                      setNewFolderName('')
                      setShowNewFolder(false)
                      await refreshAll(selectedBucket, prefix)
                    })()}>Create</button>
                    <button className="s3-btn" type="button" onClick={() => { setShowNewFolder(false); setNewFolderName('') }}>Cancel</button>
                  </div>
                ) : <button className="s3-btn" type="button" onClick={() => setShowNewFolder(true)}>New Folder</button>}
                <button className="s3-btn s3-btn-upload" type="button" onClick={() => fileInputRef.current?.click()}>Upload</button>
                <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) {
                    void (async () => {
                      const localPath = (file as File & { path?: string }).path
                      const objectKey = prefix + file.name
                      const bucketConnection = resolveBucketConnection(connection, buckets, selectedBucket)
                      if (localPath) await uploadS3Object(bucketConnection, selectedBucket, objectKey, localPath)
                      else await putS3ObjectContent(bucketConnection, selectedBucket, objectKey, await file.text(), file.type || undefined)
                      setObjects((current) => upsertObject(current, {
                        key: objectKey,
                        size: file.size,
                        lastModified: new Date(file.lastModified || Date.now()).toISOString(),
                        storageClass: 'STANDARD',
                        isFolder: false
                      }))
                      setMsg(`Uploaded ${file.name}`)
                      refreshObjectsInBackground(selectedBucket, prefix)
                      refreshAllInBackground(selectedBucket, prefix)
                    })()
                  }
                  e.target.value = ''
                }} />
                <button className="s3-btn" type="button" onClick={() => void (async () => {
                  const path = await downloadS3ObjectTo(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
                  if (path) setMsg(`Downloaded to ${path}`)
                })()} disabled={!selectedKey || !!selectedObj?.isFolder}>Download</button>
                <button className="s3-btn" type="button" onClick={() => void (async () => {
                  const url = await getS3PresignedUrl(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
                  await navigator.clipboard.writeText(url)
                  setMsg('Pre-signed URL copied to clipboard')
                })()} disabled={!selectedKey || !!selectedObj?.isFolder}>Pre-Signed URL</button>
                <ConfirmButton className="s3-btn s3-btn-danger" type="button" onConfirm={() => void (async () => {
                  const deletedKey = selectedKey
                  await deleteS3Object(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
                  setObjects((current) => current.filter((item) => item.key !== deletedKey))
                  closePreview()
                  setSelectedKey('')
                  setMsg(`Deleted ${deletedKey}`)
                  refreshObjectsInBackground(selectedBucket, prefix)
                  refreshAllInBackground(selectedBucket, prefix)
                })()} disabled={!selectedKey} confirmLabel="Confirm Delete?">Delete</ConfirmButton>
              </div>

              {showPreviewFullscreen && showPreview && selectedKey && (
                <div className="s3-preview-overlay" onClick={() => setShowPreviewFullscreen(false)}>
                  <div className="s3-preview-overlay-panel" onClick={(event) => event.stopPropagation()}>
                    <div className="s3-preview-header s3-preview-header-fullscreen">
                      <span className="s3-preview-title">{selectedKey}</span>
                      <div className="s3-preview-actions">
                        {isTextFile(selectedKey) && !editing && (
                          <button className="s3-btn s3-btn-edit" type="button" onClick={() => { setEditing(true); setEditContent(previewContent) }}>Edit</button>
                        )}
                        <button className="s3-btn" type="button" onClick={() => setShowPreviewFullscreen(false)}>Exit Full Screen</button>
                      </div>
                    </div>
                    <div className="s3-preview-body s3-preview-body-fullscreen">
                      {previewUrl && previewContentType === 'image' && <img src={previewUrl} alt={selectedKey} className="s3-preview-image s3-preview-image-fullscreen" />}
                      {!previewUrl && !editing && previewContent && <pre className="s3-preview-text s3-preview-text-fullscreen">{previewContent}</pre>}
                      {editing && <textarea className="s3-edit-area s3-edit-area-fullscreen" value={editContent} onChange={(e) => setEditContent(e.target.value)} />}
                      {!previewUrl && !previewContent && !editing && <SvcState variant="loading" resourceName="preview" compact />}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="s3-governance-panel">
              {governanceOverview && (
                <div className="s3-summary-strip">
                  <button className={`s3-summary-card s3-summary-button ${selectedSummaryFilter === 'all' ? 'active' : ''}`} type="button" onClick={() => setSelectedSummaryFilter((value) => value === 'all' ? null : 'all')}><span>Total buckets</span><strong>{governanceOverview.summary.bucketCount}</strong></button>
                  <button className={`s3-summary-card s3-summary-risk s3-summary-button ${selectedSummaryFilter === 'high-risk' ? 'active' : ''}`} type="button" onClick={() => setSelectedSummaryFilter((value) => value === 'high-risk' ? null : 'high-risk')}><span>High/Critical</span><strong>{governanceOverview.summary.riskyBucketCount}</strong></button>
                  <button className={`s3-summary-card s3-summary-button ${selectedSummaryFilter === 'public-risk' ? 'active' : ''}`} type="button" onClick={() => setSelectedSummaryFilter((value) => value === 'public-risk' ? null : 'public-risk')}><span>Public risk</span><strong>{governanceOverview.summary.publicAccessRiskCount}</strong></button>
                  <button className={`s3-summary-card s3-summary-button ${selectedSummaryFilter === 'no-encryption' ? 'active' : ''}`} type="button" onClick={() => setSelectedSummaryFilter((value) => value === 'no-encryption' ? null : 'no-encryption')}><span>No encryption</span><strong>{governanceOverview.summary.unencryptedBucketCount}</strong></button>
                  <button className={`s3-summary-card s3-summary-button ${selectedSummaryFilter === 'no-lifecycle' ? 'active' : ''}`} type="button" onClick={() => setSelectedSummaryFilter((value) => value === 'no-lifecycle' ? null : 'no-lifecycle')}><span>No lifecycle</span><strong>{governanceOverview.summary.missingLifecycleCount}</strong></button>
                  <button className={`s3-summary-card s3-summary-button ${selectedSummaryFilter === 'important-no-versioning' ? 'active' : ''}`} type="button" onClick={() => setSelectedSummaryFilter((value) => value === 'important-no-versioning' ? null : 'important-no-versioning')}><span>Important no versioning</span><strong>{governanceOverview.summary.importantWithoutVersioningCount}</strong></button>
                </div>
              )}

              {selectedSummaryFilter && (
                <div className="s3-summary-detail-panel">
                  <div className="s3-summary-detail-header">
                    <strong>{getSummaryFilterLabel(selectedSummaryFilter)}</strong>
                    <button className="s3-btn" type="button" onClick={() => setSelectedSummaryFilter(null)}>Close</button>
                  </div>
                  <div className="s3-summary-detail-list">
                    {summaryFilterBuckets.length === 0 ? (
                      <SvcState variant="no-filter-matches" resourceName="buckets" compact />
                    ) : summaryFilterBuckets.map((entry) => (
                      <button
                        key={`${selectedSummaryFilter}-${entry.bucketName}`}
                        type="button"
                        className="s3-summary-detail-item"
                        onClick={() => {
                          setSelectedTab('governance')
                          void browseBucket(entry.bucketName)
                        }}
                      >
                        <strong>{entry.bucketName}</strong>
                        <span>{entry.reason}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="s3-hygiene-panel">
                <div className="s3-hygiene-card">
                  <span>Large objects</span>
                  <strong>{largeObjects.length}</strong>
                  <label>Threshold MB<input value={largeObjectThresholdMb} onChange={(e) => setLargeObjectThresholdMb(e.target.value)} /></label>
                  <button className={`s3-chip ${showLargeOnly ? 'active' : ''}`} type="button" onClick={() => setShowLargeOnly((value) => !value)}>{showLargeOnly ? 'Showing large only' : 'Filter large'}</button>
                </div>
                <div className="s3-hygiene-card">
                  <span>Old objects</span>
                  <strong>{oldObjects.length}</strong>
                  <label>Older than days<input value={oldObjectDays} onChange={(e) => setOldObjectDays(e.target.value)} /></label>
                  <button className={`s3-chip ${showOldOnly ? 'active' : ''}`} type="button" onClick={() => setShowOldOnly((value) => !value)}>{showOldOnly ? 'Showing old only' : 'Filter old'}</button>
                </div>
                <div className="s3-hygiene-card s3-hygiene-wide">
                  <span>Storage classes</span>
                  <div className="s3-storage-class-list">
                    {storageClassSummary.length === 0 ? <span className="s3-muted">No objects in this prefix.</span> : storageClassSummary.map((entry) => (
                      <div key={entry.storageClass} className="s3-storage-class-row">
                        <strong>{entry.storageClass}</strong>
                        <span>{entry.count} objects</span>
                        <span>{formatSize(entry.totalBytes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="s3-hygiene-queue">
                <div className="s3-hygiene-queue-header">
                  <div>
                    <strong>Object Hygiene Triage</strong>
                    <p>Prioritize oversized or stale objects before changing lifecycle policy.</p>
                  </div>
                  <div className="s3-mini-badges">
                    <span className="s3-mini-badge warn">{hygieneCandidates.length} candidates</span>
                    <button className="s3-btn" type="button" onClick={() => setSelectedTab('objects')} disabled={!selectedBucket}>Review Objects</button>
                  </div>
                </div>
                {topHygieneCandidates.length === 0 ? (
                  <SvcState variant="empty" message="No large or old objects in this prefix for the current thresholds." compact />
                ) : (
                  <div className="s3-hygiene-queue-list">
                    {topHygieneCandidates.map((candidate) => (
                      <button
                        key={candidate.key}
                        type="button"
                        className={`s3-hygiene-item ${selectedKey === candidate.key ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedKey(candidate.key)
                          setSelectedTab('objects')
                          void doPreview(candidate.key)
                        }}
                      >
                        <div className="s3-hygiene-item-main">
                          <strong>{displayName(candidate.key, prefix)}</strong>
                          <span>{candidate.reasons.join(' | ')}</span>
                        </div>
                        <div className="s3-hygiene-item-meta">
                          <span>{formatSize(candidate.size)}</span>
                          <span>{candidate.lastModified !== '-' ? new Date(candidate.lastModified).toLocaleDateString() : '-'}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {detailLoading && <SvcState variant="loading" resourceName="governance posture" compact />}
              {!detailLoading && selectedBucket && governanceDetail && (
                <>
                  {selectedPosture && (
                    <div className="s3-bucket-focus">
                      <div className="s3-bucket-focus-main">
                        <div className="s3-bucket-focus-kicker">Governance focus</div>
                        <div className="s3-bucket-focus-top">
                          <div>
                            <h3>{selectedBucket}</h3>
                            <p>{selectedPosture.important ? selectedPosture.importantReason : `Region ${selectedPosture.region}`}</p>
                          </div>
                          <div className="s3-bucket-focus-status">
                            <span className={`s3-badge ${severityClass(selectedPosture.highestSeverity)}`}>{formatSeverity(selectedPosture.highestSeverity)}</span>
                            {selectedPosture.important && <span className="s3-badge s3-important-badge">Important</span>}
                          </div>
                        </div>
                        <div className="s3-bucket-focus-summary">
                          <div className="s3-bucket-focus-stat">
                            <span>Findings</span>
                            <strong>{selectedPosture.findings.length}</strong>
                          </div>
                          <div className="s3-bucket-focus-stat">
                            <span>Region</span>
                            <strong>{selectedPosture.region}</strong>
                          </div>
                          <div className="s3-bucket-focus-stat">
                            <span>Lifecycle</span>
                            <strong>{selectedPosture.lifecycle.ruleCount > 0 ? `${selectedPosture.lifecycle.ruleCount} rule${selectedPosture.lifecycle.ruleCount === 1 ? '' : 's'}` : 'Missing'}</strong>
                          </div>
                        </div>
                        <div className="s3-bucket-focus-badges">
                          <span className={`s3-mini-badge ${badgeTone(selectedPosture.publicAccessBlock.status)}`}>{publicBadgeLabel(selectedPosture)}</span>
                          <span className={`s3-mini-badge ${badgeTone(selectedPosture.encryption.status)}`}>{encryptionBadgeLabel(selectedPosture)}</span>
                          <span className={`s3-mini-badge ${badgeTone(selectedPosture.versioning.status)}`}>{versioningBadgeLabel(selectedPosture)}</span>
                          <span className={`s3-mini-badge ${badgeTone(selectedPosture.lifecycle.status)}`}>{selectedPosture.lifecycle.ruleCount > 0 ? `${selectedPosture.lifecycle.ruleCount} lifecycle rule${selectedPosture.lifecycle.ruleCount === 1 ? '' : 's'}` : 'No lifecycle'}</span>
                        </div>
                      </div>
                      <div className="s3-next-actions-panel">
                        <div className="s3-next-actions-header">
                          <strong>Next Actions</strong>
                          <span>{nextActions.length}</span>
                        </div>
                        {nextActions.length === 0 ? (
                          <div className="s3-next-action-empty">No immediate actions. Review objects or governance details for manual follow-up.</div>
                        ) : nextActions.slice(0, 5).map((item) => (
                          <div key={item.id} className={`s3-next-action-card ${item.readOnly ? 'readonly' : 'editable'}`}>
                            <div className="s3-next-action-head">
                              <strong>{item.title}</strong>
                              <span className={`s3-action-mode ${item.readOnly ? 'readonly' : 'editable'}`}>{item.readOnly ? 'Read-only / Inspect' : 'Editable'}</span>
                            </div>
                            <div className="s3-next-action-body">
                              <div className="s3-next-action-copy">
                                <p>{item.description}</p>
                                <div className="s3-next-action-detail">{item.detail}</div>
                              </div>
                              <button className="s3-btn s3-next-action-btn" type="button" onClick={item.onAction} disabled={item.disabled}>{item.actionLabel}</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="s3-governance-header">
                    <div>
                      <h3>{selectedBucket}</h3>
                      <p>
                        <span className={`s3-badge ${severityClass(governanceDetail.posture.highestSeverity)}`}>{formatSeverity(governanceDetail.posture.highestSeverity)}</span>
                        {governanceDetail.posture.important && <span className="s3-badge s3-important-badge">Important</span>}
                      </p>
                    </div>
                    <div className="s3-quick-actions">
                      <ConfirmButton className="s3-btn" onConfirm={() => void runBucketRemediation('Enable versioning', async () => {
                        await enableS3BucketVersioning(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket)
                      })} confirmLabel="Enable versioning?" disabled={governanceDetail.posture.versioning.status === 'enabled' || activeBucketAction.length > 0}>Enable Versioning</ConfirmButton>
                      <ConfirmButton className="s3-btn" onConfirm={() => void runBucketRemediation('Enable default encryption', async () => {
                        await enableS3BucketEncryption(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket)
                      })} confirmLabel="Enable encryption?" disabled={governanceDetail.posture.encryption.status === 'enabled' || activeBucketAction.length > 0}>Enable Encryption</ConfirmButton>
                      <button className="s3-btn" type="button" onClick={() => setShowPolicyEditor((value) => !value)}>{showPolicyEditor ? 'Hide Policy JSON' : 'Open Policy JSON'}</button>
                      <button className="s3-btn" type="button" onClick={() => setShowLifecycleJson((value) => !value)}>{showLifecycleJson ? 'Hide Lifecycle JSON' : 'Open Lifecycle JSON'}</button>
                    </div>
                  </div>

                  {(showPolicyEditor || showLifecycleJson) && (
                    <div className="s3-governance-json-stack">
                      {showPolicyEditor && (
                        <div className="s3-json-panel">
                          <div className="s3-json-panel-header">
                            <h4>Bucket Policy JSON</h4>
                            <ConfirmButton className="s3-btn s3-btn-ok" onConfirm={() => void (async () => {
                              JSON.parse(policyEditor)
                              await runBucketRemediation('Save bucket policy', async () => {
                                await putS3BucketPolicy(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, policyEditor)
                              })
                            })()} confirmLabel="Save policy?" disabled={!policyDirty || !policyEditor.trim() || activeBucketAction.length > 0}>Save Policy</ConfirmButton>
                          </div>
                          <textarea className="s3-edit-area" value={policyEditor} onChange={(e) => setPolicyEditor(e.target.value)} placeholder="No bucket policy is currently configured." />
                        </div>
                      )}

                      {showLifecycleJson && (
                        <div className="s3-json-panel">
                          <div className="s3-json-panel-header"><h4>Lifecycle Configuration</h4></div>
                          <textarea className="s3-edit-area" value={governanceDetail.lifecycleJson || 'No lifecycle configuration is currently configured.'} readOnly />
                        </div>
                      )}
                    </div>
                  )}

                  <div className="s3-check-section">
                    <div className="s3-check-section-header">
                      <strong>Editable Settings</strong>
                      <span>Direct actions stay behind confirmation.</span>
                    </div>
                    <div className="s3-governance-checks">
                      {([
                        { label: 'Default encryption', check: governanceDetail.posture.encryption },
                        { label: 'Versioning', check: governanceDetail.posture.versioning },
                        { label: 'Lifecycle', check: governanceDetail.posture.lifecycle },
                        { label: 'Bucket policy', check: governanceDetail.posture.policy }
                      ] satisfies GovernanceCheckItem[]).map(({ label, check }) => (
                        <div key={label} className="s3-check-card editable">
                          <div className="s3-check-top"><strong>{label}</strong><span className={`s3-badge s3-check-${check.status}`}>{checkStatusLabel(check.status)}</span></div>
                          <p>{check.summary}</p>
                          <div className="s3-check-mode">Editable or inspectable from this panel.</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="s3-check-section">
                    <div className="s3-check-section-header">
                      <strong>Read-Only Findings</strong>
                      <span>Visible here, but not modified by quick actions.</span>
                    </div>
                    <div className="s3-governance-checks">
                      {([
                        { label: 'Public access block', check: governanceDetail.posture.publicAccessBlock },
                        { label: 'Logging', check: governanceDetail.posture.logging },
                        { label: 'Replication', check: governanceDetail.posture.replication }
                      ] satisfies GovernanceCheckItem[]).map(({ label, check }) => (
                        <div key={label} className="s3-check-card readonly">
                          <div className="s3-check-top"><strong>{label}</strong><span className={`s3-badge s3-check-${check.status}`}>{checkStatusLabel(check.status)}</span></div>
                          <p>{check.summary}</p>
                          <div className="s3-check-mode">Read-only posture signal.</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="s3-findings-panel">
                    <div className="s3-findings-header"><h4>Bucket Findings</h4><span>{governanceDetail.posture.findings.length} findings</span></div>
                    {governanceDetail.posture.findings.length === 0 ? <SvcState variant="empty" message="No governance findings for this bucket." compact /> : governanceDetail.posture.findings.map((finding) => (
                      <div key={finding.id} className={`s3-finding-card ${severityClass(finding.severity)}`}>
                        <div className="s3-finding-head"><strong>{finding.title}</strong><span className={`s3-badge ${severityClass(finding.severity)}`}>{formatSeverity(finding.severity)}</span></div>
                        <p>{finding.summary}</p>
                        <div className="s3-finding-next">Next step: {finding.nextStep}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
