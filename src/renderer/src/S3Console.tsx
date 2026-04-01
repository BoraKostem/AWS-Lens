import { useEffect, useMemo, useRef, useState } from 'react'
import './s3.css'

const isWebMode = () => !!(window as unknown as Record<string, unknown>).__WEB_MODE__

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

function severityClass(severity: S3GovernanceSeverity): string {
  return `s3-severity-${severity}`
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
    ? `aws-lens:s3-known-buckets:profile:${connection.profile}`
    : `aws-lens:s3-known-buckets:assumed-role:${connection.profile}:${connection.roleArn}`
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

  if (loading && buckets.length === 0) {
    return <div className="s3-empty">Loading S3 data...</div>
  }

  return (
    <div className="s3-console">
      {error && <div className="s3-msg s3-msg-error">{error}<button type="button" className="s3-msg-close" onClick={() => setError('')}>x</button></div>}
      {msg && <div className="s3-msg s3-msg-ok">{msg}<button type="button" className="s3-msg-close" onClick={() => setMsg('')}>x</button></div>}
      <div className="s3-layout">
        <div className="s3-bucket-panel">
          <div className="s3-panel-heading">
            <div>
              <h3>S3 Governance</h3>
              <p>Posture summary, risky buckets, and object hygiene.</p>
            </div>
            <button className="s3-btn" type="button" onClick={() => void refreshAll()} disabled={loading || governanceLoading}>Refresh</button>
          </div>

          {inventoryMessage && <div className="s3-msg">{inventoryMessage}</div>}

          <input className="s3-filter-input" placeholder="Filter buckets..." value={bucketFilter} onChange={(e) => setBucketFilter(e.target.value)} />

          <div className="s3-inline-form">
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

          <div className="s3-column-chips">
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

          <div className="s3-bucket-table-wrap">
            <table className="s3-bucket-table">
              <thead><tr>{activeBucketCols.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
              <tbody>
                {filteredBuckets.map((bucket) => {
                  const posture = bucketPostureMap.get(bucket.name) ?? (governanceDetail?.posture.bucketName === bucket.name ? governanceDetail.posture : null)
                  return (
                    <tr key={bucket.name} className={bucket.name === selectedBucket ? 'active' : ''} onClick={() => void browseBucket(bucket.name)}>
                      {activeBucketCols.map((column) => (
                        <td key={column.key}>
                          {column.key === 'risk' && posture ? (
                            <div className="s3-bucket-risk-cell">
                              <span className={`s3-badge ${severityClass(posture.highestSeverity)}`}>{formatSeverity(posture.highestSeverity)}</span>
                              <div className="s3-mini-badges">
                                <span className={`s3-mini-badge ${badgeTone(posture.publicAccessBlock.status)}`}>{publicBadgeLabel(posture)}</span>
                                <span className={`s3-mini-badge ${badgeTone(posture.encryption.status)}`}>{encryptionBadgeLabel(posture)}</span>
                                <span className={`s3-mini-badge ${badgeTone(posture.versioning.status)}`}>{versioningBadgeLabel(posture)}</span>
                              </div>
                            </div>
                          ) : getBucketColValue(bucket, posture, column.key)}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {showCreateBucket ? (
            <div className="s3-inline-form">
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
        </div>

        <div className="s3-browser-panel">
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
                  <div className="s3-empty">No buckets match this summary card.</div>
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

          <div className="s3-path-bar">
            <span className="s3-path-label">Bucket: {selectedBucket || '-'} Path: /{prefix}</span>
            <div className="s3-path-actions">
              <div className="s3-tab-strip">
                <button className={`s3-tab-btn ${selectedTab === 'objects' ? 'active' : ''}`} type="button" onClick={() => setSelectedTab('objects')}>Objects</button>
                <button className={`s3-tab-btn ${selectedTab === 'governance' ? 'active' : ''}`} type="button" onClick={() => setSelectedTab('governance')} disabled={!selectedBucket}>Governance</button>
              </div>
              <button className="s3-btn" type="button" onClick={goUp} disabled={!prefix || selectedTab !== 'objects'}>Up</button>
              {!isWebMode() && <button className="s3-btn" type="button" onClick={() => void openS3Object(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)} disabled={!selectedKey || !!selectedObj?.isFolder || selectedTab !== 'objects'}>Open / Preview</button>}
            </div>
          </div>

          {selectedTab === 'objects' ? (
            <>
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
                    {filteredObjects.length === 0 && <tr><td colSpan={activeObjCols.length} className="s3-empty">{objects.length === 0 ? 'Empty folder.' : 'No objects match the current filters.'}</td></tr>}
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
                          {!isWebMode() && <button className="s3-btn" type="button" onClick={() => void openS3InVSCode(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)}>Edit in VS Code</button>}
                        </>
                      )}
                      {editing && (
                        <>
                          <button className="s3-btn s3-btn-ok" type="button" onClick={() => void (async () => {
                            setSaving(true)
                            await putS3ObjectContent(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey, editContent, previewContentType)
                            setSaving(false)
                            setEditing(false)
                            setMsg(`Saved ${selectedKey}`)
                            await refreshAll(selectedBucket, prefix)
                            await doPreview(selectedKey)
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
                    {!previewUrl && !previewContent && !editing && <div className="s3-empty">Loading preview...</div>}
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
                      const bucketConnection = resolveBucketConnection(connection, buckets, selectedBucket)
                      if (localPath) await uploadS3Object(bucketConnection, selectedBucket, prefix + file.name, localPath)
                      else await putS3ObjectContent(bucketConnection, selectedBucket, prefix + file.name, await file.text(), file.type || undefined)
                      setMsg(`Uploaded ${file.name}`)
                      await refreshAll(selectedBucket, prefix)
                    })()
                  }
                  e.target.value = ''
                }} />
                {!isWebMode() && <button className="s3-btn" type="button" onClick={() => void (async () => {
                  const path = await downloadS3ObjectTo(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
                  if (path) setMsg(`Downloaded to ${path}`)
                })()} disabled={!selectedKey || !!selectedObj?.isFolder}>Download</button>}
                <button className="s3-btn" type="button" onClick={() => void (async () => {
                  const url = await getS3PresignedUrl(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
                  await navigator.clipboard.writeText(url)
                  setMsg('Pre-signed URL copied to clipboard')
                })()} disabled={!selectedKey || !!selectedObj?.isFolder}>Pre-Signed URL</button>
                <ConfirmButton className="s3-btn s3-btn-danger" type="button" onConfirm={() => void (async () => {
                  await deleteS3Object(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
                  setMsg(`Deleted ${selectedKey}`)
                  await refreshAll(selectedBucket, prefix)
                })()} disabled={!selectedKey} confirmLabel="Confirm Delete?">Delete</ConfirmButton>
              </div>
            </>
          ) : (
            <div className="s3-governance-panel">
              {detailLoading && <div className="s3-empty">Loading governance posture...</div>}
              {!detailLoading && selectedBucket && governanceDetail && (
                <>
                  <div className="s3-governance-header">
                    <div>
                      <h3>{selectedBucket}</h3>
                      <p>
                        <span className={`s3-badge ${severityClass(governanceDetail.posture.highestSeverity)}`}>{formatSeverity(governanceDetail.posture.highestSeverity)}</span>
                        {governanceDetail.posture.important && <span className="s3-badge s3-important-badge">Important</span>}
                      </p>
                    </div>
                    <div className="s3-quick-actions">
                      <ConfirmButton className="s3-btn" onConfirm={() => void (async () => {
                        await enableS3BucketVersioning(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket)
                        setMsg(`Versioning enabled for ${selectedBucket}`)
                        await refreshAll(selectedBucket, prefix)
                        await loadBucketGovernanceDetail(selectedBucket, true)
                      })()} confirmLabel="Enable versioning?" disabled={governanceDetail.posture.versioning.status === 'enabled'}>Enable Versioning</ConfirmButton>
                      <ConfirmButton className="s3-btn" onConfirm={() => void (async () => {
                        await enableS3BucketEncryption(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket)
                        setMsg(`Default encryption enabled for ${selectedBucket}`)
                        await refreshAll(selectedBucket, prefix)
                        await loadBucketGovernanceDetail(selectedBucket, true)
                      })()} confirmLabel="Enable encryption?" disabled={governanceDetail.posture.encryption.status === 'enabled'}>Enable Encryption</ConfirmButton>
                      <button className="s3-btn" type="button" onClick={() => setShowPolicyEditor((value) => !value)}>{showPolicyEditor ? 'Hide Policy JSON' : 'Open Policy JSON'}</button>
                      <button className="s3-btn" type="button" onClick={() => setShowLifecycleJson((value) => !value)}>{showLifecycleJson ? 'Hide Lifecycle JSON' : 'Open Lifecycle JSON'}</button>
                    </div>
                  </div>

                  <div className="s3-governance-checks">
                    {([
                      { label: 'Public access block', check: governanceDetail.posture.publicAccessBlock },
                      { label: 'Default encryption', check: governanceDetail.posture.encryption },
                      { label: 'Versioning', check: governanceDetail.posture.versioning },
                      { label: 'Lifecycle', check: governanceDetail.posture.lifecycle },
                      { label: 'Bucket policy', check: governanceDetail.posture.policy },
                      { label: 'Logging', check: governanceDetail.posture.logging },
                      { label: 'Replication', check: governanceDetail.posture.replication }
                    ] satisfies GovernanceCheckItem[]).map(({ label, check }) => (
                      <div key={label} className="s3-check-card">
                        <div className="s3-check-top"><strong>{label}</strong><span className={`s3-badge s3-check-${check.status}`}>{check.status}</span></div>
                        <p>{check.summary}</p>
                      </div>
                    ))}
                  </div>

                  <div className="s3-findings-panel">
                    <div className="s3-findings-header"><h4>Bucket Findings</h4><span>{governanceDetail.posture.findings.length} findings</span></div>
                    {governanceDetail.posture.findings.length === 0 ? <div className="s3-empty">No governance findings for this bucket.</div> : governanceDetail.posture.findings.map((finding) => (
                      <div key={finding.id} className={`s3-finding-card ${severityClass(finding.severity)}`}>
                        <div className="s3-finding-head"><strong>{finding.title}</strong><span className={`s3-badge ${severityClass(finding.severity)}`}>{formatSeverity(finding.severity)}</span></div>
                        <p>{finding.summary}</p>
                        <div className="s3-finding-next">Next step: {finding.nextStep}</div>
                      </div>
                    ))}
                  </div>

                  {showPolicyEditor && (
                    <div className="s3-json-panel">
                      <div className="s3-json-panel-header">
                        <h4>Bucket Policy JSON</h4>
                        <ConfirmButton className="s3-btn s3-btn-ok" onConfirm={() => void (async () => {
                          JSON.parse(policyEditor)
                          await putS3BucketPolicy(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, policyEditor)
                          setMsg(`Bucket policy saved for ${selectedBucket}`)
                          await loadBucketGovernanceDetail(selectedBucket, true)
                          await loadGovernanceSummary()
                        })()} confirmLabel="Save policy?" disabled={!policyDirty || !policyEditor.trim()}>Save Policy</ConfirmButton>
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
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
