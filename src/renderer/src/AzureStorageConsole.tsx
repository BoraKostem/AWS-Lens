import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  AzureMonitorActivityEvent,
  AzureStorageAccountSummary,
  AzureStorageBlobSummary,
  AzureStorageContainerSummary,
  AzureStorageFileShareSummary,
  AzureStorageQueueSummary,
  AzureStorageTableSummary
} from '@shared/types'
import {
  createAzureStorageContainer,
  deleteAzureStorageBlob,
  downloadAzureStorageBlobToPath,
  getAzureStorageBlobContent,
  getAzureStorageBlobSasUrl,
  listAzureMonitorActivity,
  listAzureStorageAccounts,
  listAzureStorageBlobs,
  listAzureStorageContainers,
  openAzureStorageBlob,
  openAzureStorageBlobInVSCode,
  putAzureStorageBlobContent,
  uploadAzureStorageBlob,
  listAzureStorageFileShares,
  listAzureStorageQueues,
  listAzureStorageTables
} from './api'
import { ConfirmButton } from './ConfirmButton'
import { SvcState } from './SvcState'

const TEXT_EXTENSIONS = new Set(['txt', 'json', 'xml', 'csv', 'yaml', 'yml', 'md', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'sh', 'bash', 'env', 'conf', 'cfg', 'ini', 'toml', 'log', 'sql', 'graphql', 'svg', 'tf', 'tfvars', 'tfstate', 'hcl', 'dockerfile', 'makefile', 'gitignore'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

type BlobColKey = 'name' | 'type' | 'key' | 'size' | 'modified' | 'accessTier'

const BLOB_COLUMNS: { key: BlobColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'type', label: 'Type', color: '#8b5cf6' },
  { key: 'key', label: 'Key', color: '#14b8a6' },
  { key: 'size', label: 'Size', color: '#f59e0b' },
  { key: 'modified', label: 'Modified', color: '#06b6d4' },
  { key: 'accessTier', label: 'Access Tier', color: '#22c55e' }
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

function formatTimestamp(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function displayName(key: string, pfx: string): string {
  const relative = key.startsWith(pfx) ? key.slice(pfx.length) : key
  return relative.replace(/\/$/, '') || key
}

function parentBlobPrefix(pfx: string): string {
  const normalized = pfx.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  const next = normalized.split('/').slice(0, -1).join('/')
  return next ? `${next}/` : ''
}

function objectAgeDays(lastModified: string): number {
  if (!lastModified || lastModified === '-') return 0
  return Math.max(0, Math.floor((Date.now() - new Date(lastModified).getTime()) / (24 * 60 * 60 * 1000)))
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function activityStatusTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  const normalized = status.trim().toLowerCase()
  if (normalized.includes('succeed') || normalized.includes('complete')) return 'success'
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel')) return 'danger'
  if (normalized.includes('accept') || normalized.includes('start') || normalized.includes('progress') || normalized.includes('running')) return 'info'
  return 'warning'
}

function getBlobColValue(blob: AzureStorageBlobSummary, col: BlobColKey, pfx: string): string {
  switch (col) {
    case 'name': return displayName(blob.key, pfx)
    case 'type': return blob.isFolder ? 'Folder' : getExtension(blob.key).toUpperCase() || 'File'
    case 'key': return blob.key
    case 'size': return blob.isFolder ? '-' : formatSize(blob.size)
    case 'modified': return blob.lastModified ? formatTimestamp(blob.lastModified) : '-'
    case 'accessTier': return blob.isFolder ? '-' : blob.accessTier || 'Default'
  }
}

function postureBadgeTone(ok: boolean): 'ok' | 'warn' {
  return ok ? 'ok' : 'warn'
}

type HygieneCandidate = {
  key: string
  size: number
  lastModified: string
  ageDays: number
  reasons: string[]
}

export function AzureStorageAccountsConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenMonitor,
  onOpenDirectAccess
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenMonitor: (query: string) => void
  onOpenDirectAccess: () => void
}): JSX.Element {
  const [accounts, setAccounts] = useState<AzureStorageAccountSummary[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountsError, setAccountsError] = useState('')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [containers, setContainers] = useState<AzureStorageContainerSummary[]>([])
  const [containersLoading, setContainersLoading] = useState(false)
  const [containersError, setContainersError] = useState('')
  const [selectedContainer, setSelectedContainer] = useState('')
  const [blobs, setBlobs] = useState<AzureStorageBlobSummary[]>([])
  const [blobsLoading, setBlobsLoading] = useState(false)
  const [blobsError, setBlobsError] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [prefix, setPrefix] = useState('')
  const [previewContent, setPreviewContent] = useState('')
  const [previewContentType, setPreviewContentType] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showPreviewFullscreen, setShowPreviewFullscreen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [accountSearch, setAccountSearch] = useState('')
  const [containerSearch, setContainerSearch] = useState('')
  const [blobSearch, setBlobSearch] = useState('')
  const [detailTab, setDetailTab] = useState<'objects' | 'posture' | 'timeline' | 'fileShares' | 'queues' | 'tables'>('objects')
  const [visibleBlobCols, setVisibleBlobCols] = useState<Set<BlobColKey>>(new Set(['name', 'type', 'key', 'size', 'modified', 'accessTier']))
  const [timelineEvents, setTimelineEvents] = useState<AzureMonitorActivityEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [fileShares, setFileShares] = useState<AzureStorageFileShareSummary[]>([])
  const [fileSharesLoading, setFileSharesLoading] = useState(false)
  const [queues, setQueues] = useState<AzureStorageQueueSummary[]>([])
  const [queuesLoading, setQueuesLoading] = useState(false)
  const [tables, setTables] = useState<AzureStorageTableSummary[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [largeObjectThresholdMb, setLargeObjectThresholdMb] = useState('100')
  const [oldObjectDays, setOldObjectDays] = useState('180')
  const [showLargeOnly, setShowLargeOnly] = useState(false)
  const [showOldOnly, setShowOldOnly] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [showCreateContainer, setShowCreateContainer] = useState(false)
  const [newContainerName, setNewContainerName] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId]
  )
  const selectedBlob = useMemo(
    () => blobs.find((b) => b.key === selectedKey) ?? null,
    [blobs, selectedKey]
  )
  const selectedContainerSummary = useMemo(
    () => containers.find((c) => c.name === selectedContainer) ?? null,
    [containers, selectedContainer]
  )

  const objectFiles = useMemo(() => blobs.filter((b) => !b.isFolder), [blobs])
  const largeThresholdBytes = Math.max(1, Number(largeObjectThresholdMb) || 100) * 1024 * 1024
  const oldThresholdDays = Math.max(1, Number(oldObjectDays) || 180)
  const largeObjects = useMemo(() => objectFiles.filter((b) => b.size >= largeThresholdBytes).sort((a, b) => b.size - a.size), [objectFiles, largeThresholdBytes])
  const oldObjects = useMemo(() => {
    const cutoff = Date.now() - oldThresholdDays * 24 * 60 * 60 * 1000
    return objectFiles.filter((b) => b.lastModified && new Date(b.lastModified).getTime() < cutoff)
  }, [objectFiles, oldThresholdDays])
  const accessTierSummary = useMemo(() => {
    const summary = new Map<string, { tier: string; count: number; totalBytes: number }>()
    for (const obj of objectFiles) {
      const tier = obj.accessTier || 'Default'
      const current = summary.get(tier) ?? { tier, count: 0, totalBytes: 0 }
      current.count += 1
      current.totalBytes += obj.size
      summary.set(tier, current)
    }
    return [...summary.values()].sort((a, b) => b.totalBytes - a.totalBytes)
  }, [objectFiles])
  const hygieneCandidates = useMemo(() => {
    return objectFiles
      .map((obj) => {
        const reasons: string[] = []
        const ageDays = objectAgeDays(obj.lastModified)
        if (obj.size >= largeThresholdBytes) reasons.push(`${formatSize(obj.size)} exceeds ${Number(largeObjectThresholdMb) || 100} MB`)
        if (ageDays >= oldThresholdDays) reasons.push(`${ageDays} days old`)
        return { key: obj.key, size: obj.size, lastModified: obj.lastModified, ageDays, reasons } satisfies HygieneCandidate
      })
      .filter((c) => c.reasons.length > 0)
      .sort((a, b) => {
        const rd = b.reasons.length - a.reasons.length
        if (rd !== 0) return rd
        const sd = b.size - a.size
        if (sd !== 0) return sd
        return b.ageDays - a.ageDays
      })
  }, [largeObjectThresholdMb, largeThresholdBytes, objectFiles, oldThresholdDays])
  const topHygieneCandidates = useMemo(() => hygieneCandidates.slice(0, 8), [hygieneCandidates])

  const activeBlobCols = BLOB_COLUMNS.filter((c) => visibleBlobCols.has(c.key))
  const blobFileCount = objectFiles.length
  const blobFolderCount = blobs.filter((b) => b.isFolder).length

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase()
    if (!q) return accounts
    return accounts.filter((a) =>
      a.name.toLowerCase().includes(q)
      || a.resourceGroup.toLowerCase().includes(q)
      || a.skuName.toLowerCase().includes(q)
    )
  }, [accountSearch, accounts])
  const filteredContainers = useMemo(() => {
    const q = containerSearch.trim().toLowerCase()
    if (!q) return containers
    return containers.filter((c) => c.name.toLowerCase().includes(q))
  }, [containerSearch, containers])
  const filteredBlobs = useMemo(() => {
    const isLargeSet = new Set(largeObjects.map((b) => b.key))
    const isOldSet = new Set(oldObjects.map((b) => b.key))
    return blobs.filter((b) => {
      if (showLargeOnly && !b.isFolder && !isLargeSet.has(b.key)) return false
      if (showOldOnly && !b.isFolder && !isOldSet.has(b.key)) return false
      if (!blobSearch) return true
      return BLOB_COLUMNS.some((col) => getBlobColValue(b, col.key, prefix).toLowerCase().includes(blobSearch.toLowerCase()))
    })
  }, [blobs, blobSearch, largeObjects, oldObjects, prefix, showLargeOnly, showOldOnly])

  async function loadStorageTimeline() {
    if (!selectedAccount) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const result = await listAzureMonitorActivity(subscriptionId, location, `Microsoft.Storage|${selectedAccount.name}`, 168)
      setTimelineEvents(result.events)
    } catch (error) {
      setTimelineEvents([])
      setTimelineError(error instanceof Error ? error.message : 'Failed to load activity')
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (detailTab === 'timeline' && selectedAccount) void loadStorageTimeline()
  }, [detailTab, selectedAccountId])

  useEffect(() => {
    if (!selectedAccount) return

    if (detailTab === 'fileShares' && fileShares.length === 0) {
      setFileSharesLoading(true)
      listAzureStorageFileShares(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name)
        .then(setFileShares).catch(() => setFileShares([])).finally(() => setFileSharesLoading(false))
    }
    if (detailTab === 'queues' && queues.length === 0) {
      setQueuesLoading(true)
      listAzureStorageQueues(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name)
        .then(setQueues).catch(() => setQueues([])).finally(() => setQueuesLoading(false))
    }
    if (detailTab === 'tables' && tables.length === 0) {
      setTablesLoading(true)
      listAzureStorageTables(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name)
        .then(setTables).catch(() => setTables([])).finally(() => setTablesLoading(false))
    }
  }, [detailTab, selectedAccountId])

  function closePreview(): void {
    setShowPreview(false)
    setShowPreviewFullscreen(false)
    setEditing(false)
    setPreviewContent('')
    setPreviewContentType('')
    setPreviewError('')
    setPreviewUrl('')
  }

  async function browseContainer(account: AzureStorageAccountSummary, containerName: string, nextPrefix = ''): Promise<void> {
    setSelectedContainer(containerName)
    setPrefix(nextPrefix)
    setSelectedKey('')
    closePreview()
    setBlobsError('')
    setBlobsLoading(true)
    try {
      setBlobs(await listAzureStorageBlobs(subscriptionId, account.resourceGroup, account.name, containerName, nextPrefix, account.primaryBlobEndpoint))
    } catch (error) {
      setBlobs([])
      setBlobsError(normalizeError(error))
    } finally {
      setBlobsLoading(false)
    }
  }

  async function browseAccount(account: AzureStorageAccountSummary, preferredContainerName = ''): Promise<void> {
    setSelectedAccountId(account.id)
    setSelectedContainer('')
    setContainers([])
    setContainersError('')
    setBlobs([])
    setBlobsError('')
    setSelectedKey('')
    setPrefix('')
    closePreview()
    setDetailTab('objects')
    setTimelineEvents([])
    setTimelineError('')
    setFileShares([])
    setQueues([])
    setTables([])
    setContainersLoading(true)
    try {
      const nextContainers = await listAzureStorageContainers(subscriptionId, account.resourceGroup, account.name, account.primaryBlobEndpoint)
      setContainers(nextContainers)
      const targetContainer = nextContainers.find((c) => c.name === preferredContainerName)?.name ?? nextContainers[0]?.name ?? ''
      if (!targetContainer) {
        setSelectedContainer('')
        setBlobs([])
        return
      }
      await browseContainer(account, targetContainer, '')
    } catch (error) {
      setContainers([])
      setContainersError(normalizeError(error))
      setBlobs([])
    } finally {
      setContainersLoading(false)
    }
  }

  async function doPreview(account: AzureStorageAccountSummary, containerName: string, blob: AzureStorageBlobSummary): Promise<void> {
    setSelectedKey(blob.key)
    setPreviewContent('')
    setPreviewUrl('')
    setPreviewContentType(blob.contentType || '')
    setPreviewError('')
    setEditing(false)
    setEditContent('')

    if (blob.isFolder) {
      await browseContainer(account, containerName, blob.key)
      return
    }

    setShowPreview(true)

    if (isImageFile(blob.key)) {
      setPreviewLoading(true)
      try {
        const url = await getAzureStorageBlobSasUrl(subscriptionId, account.resourceGroup, account.name, containerName, blob.key, account.primaryBlobEndpoint)
        setPreviewUrl(url)
        setPreviewContentType('image')
      } catch (error) {
        setPreviewError(normalizeError(error))
      } finally {
        setPreviewLoading(false)
      }
      return
    }

    if (!isTextFile(blob.key)) {
      setPreviewError('Preview is limited to text and image blobs. Use Download for other binary content.')
      return
    }

    if (blob.size > 1024 * 1024) {
      setPreviewError('Preview is limited to text blobs smaller than 1 MB. Download the blob to inspect larger content.')
      return
    }

    setPreviewLoading(true)
    try {
      const content = await getAzureStorageBlobContent(subscriptionId, account.resourceGroup, account.name, containerName, blob.key, account.primaryBlobEndpoint)
      setPreviewContent(content.body)
      setPreviewContentType(content.contentType || blob.contentType || 'text/plain')
    } catch (error) {
      setPreviewError(normalizeError(error))
    } finally {
      setPreviewLoading(false)
    }
  }

  function goUp(): void {
    if (!prefix || !selectedAccount || !selectedContainerSummary) return
    void browseContainer(selectedAccount, selectedContainerSummary.name, parentBlobPrefix(prefix))
  }

  useEffect(() => {
    let cancelled = false
    setAccountsLoading(true)
    setAccountsError('')

    void listAzureStorageAccounts(subscriptionId, location)
      .then(async (nextAccounts) => {
        if (cancelled) return
        setAccounts(nextAccounts)
        const target = nextAccounts.find((a) => a.id === selectedAccountId) ?? nextAccounts[0] ?? null
        if (!target) {
          setSelectedAccountId('')
          setContainers([])
          setBlobs([])
          return
        }
        await browseAccount(target, selectedContainer)
      })
      .catch((error) => {
        if (cancelled) return
        setAccounts([])
        setAccountsError(normalizeError(error))
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false)
      })

    return () => { cancelled = true }
  }, [location, refreshNonce, subscriptionId])

  const locationLabel = location.trim() || 'all visible regions'

  return (
    <div className="s3-console azure-storage-shell">
      {message ? <div className="s3-msg s3-msg-ok">{message}<button type="button" className="s3-msg-close" onClick={() => setMessage('')}>x</button></div> : null}

      <section className="s3-shell-hero">
        <div className="s3-shell-hero-copy">
          <div className="s3-eyebrow">Azure object storage</div>
          <h2>Storage Accounts</h2>
          <p>Account posture, container visibility, and blob workflows bound to the selected subscription and region context.</p>
          <div className="s3-shell-meta-strip">
            <div className="s3-shell-meta-pill"><span>Subscription</span><strong>{subscriptionId}</strong></div>
            <div className="s3-shell-meta-pill"><span>Region lens</span><strong>{locationLabel}</strong></div>
            <div className="s3-shell-meta-pill"><span>Account</span><strong>{selectedAccount?.name || 'No account selected'}</strong></div>
            <div className="s3-shell-meta-pill"><span>Path</span><strong>/{prefix || ''}</strong></div>
          </div>
        </div>
        <div className="s3-shell-hero-stats">
          <div className="s3-shell-stat-card s3-shell-stat-card-accent"><span>Tracked accounts</span><strong>{accounts.length}</strong><small>Storage accounts visible in the current Azure context.</small></div>
          <div className="s3-shell-stat-card"><span>Containers</span><strong>{containers.length}</strong><small>{containersLoading ? 'Loading container posture.' : 'Discovered on the selected account.'}</small></div>
          <div className="s3-shell-stat-card"><span>Blobs in view</span><strong>{blobFileCount}</strong><small>{blobFolderCount} virtual folders in the current prefix.</small></div>
          <div className="s3-shell-stat-card"><span>Hygiene candidates</span><strong>{hygieneCandidates.length}</strong><small>Large or stale blobs within current thresholds.</small></div>
        </div>
      </section>

      {accountsError ? (
        <section className="panel stack">
          <div className="error-banner">{accountsError}</div>
          <div className="profile-catalog-empty">
            <div className="eyebrow">Azure Storage Access</div>
            <h3>Storage accounts could not be loaded</h3>
            <p className="hero-path">Verify that the selected Azure credential chain can enumerate storage accounts for this subscription and region.</p>
          </div>
        </section>
      ) : accountsLoading ? (
        <section className="panel stack">
          <SvcState variant="loading" resourceName="Azure storage accounts" compact />
        </section>
      ) : accounts.length === 0 ? (
        <section className="panel stack">
          <div className="profile-catalog-empty">
            <div className="eyebrow">No Accounts</div>
            <h3>No Azure storage accounts matched the current region lens</h3>
            <p className="hero-path">Change the Azure region selector or verify that the subscription exposes storage accounts in this view.</p>
          </div>
        </section>
      ) : (
        <>
          <div className="s3-shell-toolbar">
            <div className="s3-toolbar">
              <button className="s3-btn" type="button" onClick={() => selectedAccount && void browseAccount(selectedAccount, selectedContainer)} disabled={!selectedAccount || containersLoading}>Refresh</button>
              <button className={`s3-btn ${detailTab === 'posture' ? 'accent' : ''}`} type="button" onClick={() => setDetailTab('posture')} disabled={!selectedAccount}>Open Posture</button>
              <button className="s3-btn" type="button" onClick={goUp} disabled={!prefix || detailTab !== 'objects'}>Go Up</button>
              <button className="s3-btn" type="button" onClick={() => selectedBlob && selectedAccount && selectedContainerSummary && void doPreview(selectedAccount, selectedContainerSummary.name, selectedBlob)} disabled={!selectedKey || !!selectedBlob?.isFolder || detailTab !== 'objects'}>Open / Preview</button>
              <button className="s3-btn" type="button" onClick={onOpenDirectAccess}>Direct Access</button>
            </div>
            <div className="s3-shell-status">
              <div className="s3-inline-note">{containersLoading || blobsLoading ? 'Refreshing storage workflow...' : 'Console ready'}</div>
            </div>
          </div>

          <div className="s3-layout s3-layout-inventory">
            <div className="s3-bucket-panel s3-bucket-panel-inventory">
              <div className="s3-pane-head">
                <div>
                  <span className="s3-pane-kicker">Tracked accounts</span>
                  <h3>Storage account inventory</h3>
                </div>
                <span className="s3-pane-summary">{filteredAccounts.length} visible</span>
              </div>
              <input className="s3-filter-input" placeholder="Filter storage accounts..." value={accountSearch} onChange={(e) => setAccountSearch(e.target.value)} />
              <div className="s3-bucket-list">
                {filteredAccounts.map((account) => (
                  <button key={account.id} type="button" className={`s3-bucket-row ${selectedAccountId === account.id ? 'active' : ''}`} onClick={() => void browseAccount(account, selectedContainer)}>
                    <div className="s3-bucket-row-top">
                      <div className="s3-bucket-row-identity">
                        <div className="s3-bucket-row-glyph">AZ</div>
                        <div className="s3-bucket-row-copy">
                          <span className="s3-bucket-row-kicker">Storage account</span>
                          <strong>{account.name}</strong>
                          <span>{account.resourceGroup} | {account.location || 'Unknown location'}</span>
                        </div>
                      </div>
                      <span className={`s3-status-badge ${account.publicNetworkAccess.toLowerCase() === 'enabled' ? 'info' : 'success'}`}>
                        {account.publicNetworkAccess || 'Unknown'}
                      </span>
                    </div>
                    <div className="s3-bucket-row-meta">
                      <span>SKU: {account.skuName || 'Unknown'}</span>
                      <span>TLS: {account.minimumTlsVersion || 'Unknown'}</span>
                      <span>Created: {account.location}</span>
                    </div>
                    <div className="s3-bucket-row-metrics">
                      <div className="s3-bucket-row-metric is-primary"><span>Blob public access</span><strong>{account.allowBlobPublicAccess ? 'Allowed' : 'Disabled'}</strong></div>
                      <div className="s3-bucket-row-metric"><span>Versioning</span><strong>{account.versioningEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                      <div className="s3-bucket-row-metric"><span>HTTPS only</span><strong>{account.httpsOnly ? 'Enforced' : 'Off'}</strong></div>
                    </div>
                    <div className="s3-bucket-row-note">{account.notes[0] || 'Account posture ready for deeper blob workflows.'}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="s3-browser-panel s3-browser-panel-inventory">
              {!selectedAccount ? (
                <SvcState variant="no-selection" resourceName="storage account" message="Select a storage account to inspect posture or browse blobs." />
              ) : (
                <>
                  {containersError ? <div className="s3-msg s3-msg-error">{containersError}<button type="button" className="s3-msg-close" onClick={() => setContainersError('')}>x</button></div> : null}
                  {blobsError ? <div className="s3-msg s3-msg-error">{blobsError}<button type="button" className="s3-msg-close" onClick={() => setBlobsError('')}>x</button></div> : null}

                  <section className="s3-detail-hero">
                    <div className="s3-detail-hero-copy">
                      <div className="s3-eyebrow">Account posture</div>
                      <h3>{selectedAccount.name}</h3>
                      <p>{selectedAccount.resourceGroup} | {selectedAccount.location || 'Unknown region'} | /{prefix || ''}</p>
                      <div className="s3-detail-meta-strip">
                        <div className="s3-detail-meta-pill"><span>SKU</span><strong>{selectedAccount.skuName || 'Unknown'}</strong></div>
                        <div className="s3-detail-meta-pill"><span>Access tier</span><strong>{selectedAccount.accessTier || 'n/a'}</strong></div>
                        <div className="s3-detail-meta-pill"><span>Versioning</span><strong>{selectedAccount.versioningEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                        <div className="s3-detail-meta-pill"><span>HTTPS only</span><strong>{selectedAccount.httpsOnly ? 'Enforced' : 'Off'}</strong></div>
                      </div>
                    </div>
                    <div className="s3-detail-hero-stats">
                      <div className={`s3-detail-stat-card ${selectedAccount.publicNetworkAccess.toLowerCase() === 'enabled' ? 'info' : 'success'}`}>
                        <span>Public network</span>
                        <strong>{selectedAccount.publicNetworkAccess || 'Unknown'}</strong>
                        <small>{selectedAccount.notes[0] || 'Network posture loaded from the Azure management plane.'}</small>
                      </div>
                      <div className="s3-detail-stat-card"><span>Containers</span><strong>{containers.length}</strong><small>{containersLoading ? 'Refreshing container posture.' : 'Visible to the current data-plane credentials.'}</small></div>
                      <div className="s3-detail-stat-card"><span>Change feed</span><strong>{selectedAccount.changeFeedEnabled ? 'Enabled' : 'Disabled'}</strong><small>Blob service audit signal for this account.</small></div>
                      <div className="s3-detail-stat-card"><span>Delete retention</span><strong>{selectedAccount.blobDeleteRetentionDays || 0} days</strong><small>Blob soft-delete window configured at the account level.</small></div>
                    </div>
                  </section>

                  <div className="s3-detail-tabs">
                    <button className={detailTab === 'objects' ? 'active' : ''} type="button" onClick={() => setDetailTab('objects')}>Containers & Blobs</button>
                    <button className={detailTab === 'fileShares' ? 'active' : ''} type="button" onClick={() => setDetailTab('fileShares')}>File Shares</button>
                    <button className={detailTab === 'queues' ? 'active' : ''} type="button" onClick={() => setDetailTab('queues')}>Queues</button>
                    <button className={detailTab === 'tables' ? 'active' : ''} type="button" onClick={() => setDetailTab('tables')}>Tables</button>
                    <button className={detailTab === 'posture' ? 'active' : ''} type="button" onClick={() => setDetailTab('posture')}>Account Posture</button>
                    <button className={detailTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setDetailTab('timeline')}>Activity Timeline</button>
                  </div>

                  {detailTab === 'objects' && (
                    <>
                      <div className="s3-layout">
                        <section className="s3-bucket-panel">
                          <div className="s3-pane-head">
                            <div>
                              <span className="s3-pane-kicker">Containers</span>
                              <h3>Data-plane entry points</h3>
                            </div>
                            <span className="s3-pane-summary">{filteredContainers.length} visible</span>
                          </div>
                          <input className="s3-filter-input" placeholder="Filter containers..." value={containerSearch} onChange={(e) => setContainerSearch(e.target.value)} />
                          <div style={{ padding: '0 8px 6px' }}>
                            {showCreateContainer ? (
                              <div className="s3-inline-form">
                                <input placeholder="container name" value={newContainerName} onChange={(e) => setNewContainerName(e.target.value)} />
                                <button className="s3-btn s3-btn-ok" type="button" onClick={() => void (async () => {
                                  if (!newContainerName.trim()) return
                                  try {
                                    await createAzureStorageContainer(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, newContainerName.trim(), selectedAccount.primaryBlobEndpoint)
                                    setMessage(`Container "${newContainerName.trim()}" created`)
                                    setNewContainerName('')
                                    setShowCreateContainer(false)
                                    await browseAccount(selectedAccount, newContainerName.trim())
                                  } catch (error) {
                                    setContainersError(normalizeError(error))
                                  }
                                })()}>Create</button>
                                <button className="s3-btn" type="button" onClick={() => { setShowCreateContainer(false); setNewContainerName('') }}>Cancel</button>
                              </div>
                            ) : (
                              <button className="s3-btn" type="button" onClick={() => setShowCreateContainer(true)} style={{ width: '100%' }}>New Container</button>
                            )}
                          </div>
                          <div className="s3-bucket-list">
                            {filteredContainers.map((container) => (
                              <button key={container.name} type="button" className={`s3-bucket-row ${selectedContainer === container.name ? 'active' : ''}`} onClick={() => void browseContainer(selectedAccount, container.name, '')}>
                                <div className="s3-bucket-row-top">
                                  <div className="s3-bucket-row-identity">
                                    <div className="s3-bucket-row-glyph">BLB</div>
                                    <div className="s3-bucket-row-copy">
                                      <span className="s3-bucket-row-kicker">Container</span>
                                      <strong>{container.name}</strong>
                                      <span>{container.publicAccess} | {container.leaseStatus}</span>
                                    </div>
                                  </div>
                                </div>
                                <div className="s3-bucket-row-meta">
                                  <span>Last modified: {container.lastModified ? formatTimestamp(container.lastModified) : 'Unknown'}</span>
                                </div>
                                <div className="s3-bucket-row-metrics">
                                  <div className="s3-bucket-row-metric is-primary"><span>Metadata</span><strong>{container.metadataCount}</strong></div>
                                  <div className="s3-bucket-row-metric"><span>Immutability</span><strong>{container.hasImmutabilityPolicy ? 'Enabled' : 'Off'}</strong></div>
                                  <div className="s3-bucket-row-metric"><span>Legal hold</span><strong>{container.hasLegalHold ? 'On' : 'Off'}</strong></div>
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>

                        <div className="s3-browser-panel">
                          {!selectedContainerSummary ? (
                            <SvcState variant="no-selection" resourceName="container" message="Select a container to browse blobs, preview text, or perform object workflows." />
                          ) : (
                            <>
                              <div className="s3-path-bar">
                                <span className="s3-path-label">Container: {selectedContainerSummary.name} Path: /{prefix}</span>
                                <div className="s3-path-actions">
                                  <button className="s3-btn" type="button" onClick={goUp} disabled={!prefix}>Up</button>
                                  <button className="s3-btn" type="button" onClick={() => selectedBlob && void doPreview(selectedAccount, selectedContainerSummary.name, selectedBlob)} disabled={!selectedBlob || selectedBlob.isFolder}>Open / Preview</button>
                                </div>
                              </div>

                              <input className="s3-filter-input" value={blobSearch} onChange={(e) => setBlobSearch(e.target.value)} placeholder="Filter blobs..." />

                              <div className="s3-column-chips">
                                {BLOB_COLUMNS.map((col) => (
                                  <button
                                    key={col.key}
                                    className={`s3-chip ${visibleBlobCols.has(col.key) ? 'active' : ''}`}
                                    type="button"
                                    style={visibleBlobCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                                    onClick={() => setVisibleBlobCols((prev) => {
                                      const next = new Set(prev)
                                      next.has(col.key) ? next.delete(col.key) : next.add(col.key)
                                      return next
                                    })}
                                  >
                                    {col.label}
                                  </button>
                                ))}
                              </div>

                              <div className="s3-object-table-wrap">
                                <table className="s3-object-table">
                                  <thead><tr>{activeBlobCols.map((col) => <th key={col.key}>{col.label}</th>)}</tr></thead>
                                  <tbody>
                                    {filteredBlobs.map((blob) => (
                                      <tr key={blob.key} className={selectedKey === blob.key ? 'active' : ''} onClick={() => {
                                        if (blob.isFolder) {
                                          void browseContainer(selectedAccount, selectedContainerSummary.name, blob.key)
                                        } else {
                                          setSelectedKey(blob.key)
                                          void doPreview(selectedAccount, selectedContainerSummary.name, blob)
                                        }
                                      }}>
                                        {activeBlobCols.map((col) => (
                                          <td key={col.key}>
                                            {col.key === 'name' && blob.isFolder && <span className="s3-folder-icon">&#128193; </span>}
                                            {getBlobColValue(blob, col.key, prefix)}
                                          </td>
                                        ))}
                                      </tr>
                                    ))}
                                    {filteredBlobs.length === 0 && (
                                      <tr><td colSpan={activeBlobCols.length}>
                                        {blobs.length === 0
                                          ? <SvcState variant="empty" message="Empty container or prefix." compact />
                                          : <SvcState variant="no-filter-matches" resourceName="blobs" compact />}
                                      </td></tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>

                              {showPreview && selectedKey && (
                                <div className="s3-preview-panel">
                                  <div className="s3-preview-header">
                                    <span className="s3-preview-title">{selectedKey.split('/').pop()}</span>
                                    <div className="s3-preview-actions">
                                      {isTextFile(selectedKey) && !editing && (
                                        <button className="s3-btn s3-btn-edit" type="button" onClick={() => { setEditing(true); setEditContent(previewContent) }}>Edit</button>
                                      )}
                                      <button className="s3-btn" type="button" onClick={() => setShowPreviewFullscreen(true)}>See Full Screen</button>
                                      {editing && (
                                        <>
                                          <button className="s3-btn s3-btn-ok" type="button" disabled={saving} onClick={() => void (async () => {
                                            if (!selectedBlob || !selectedContainerSummary) return
                                            try {
                                              setSaving(true)
                                              await putAzureStorageBlobContent(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, selectedBlob.key, editContent, selectedAccount.primaryBlobEndpoint)
                                              setPreviewContent(editContent)
                                              setEditing(false)
                                              setMessage(`Saved ${selectedBlob.key}`)
                                              await browseContainer(selectedAccount, selectedContainerSummary.name, prefix)
                                            } catch (error) {
                                              setPreviewError(normalizeError(error))
                                            } finally {
                                              setSaving(false)
                                            }
                                          })()}>{saving ? 'Saving...' : 'Save'}</button>
                                          <button className="s3-btn" type="button" onClick={() => setEditing(false)}>Cancel</button>
                                        </>
                                      )}
                                      <button className="s3-btn" type="button" onClick={closePreview}>Close</button>
                                    </div>
                                  </div>
                                  <div className="s3-preview-body">
                                    {previewLoading && <SvcState variant="loading" resourceName="preview" compact />}
                                    {previewError && <div className="error-banner">{previewError}</div>}
                                    {!previewLoading && !previewError && previewUrl && <img src={previewUrl} alt={selectedKey} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />}
                                    {!previewLoading && !previewError && !editing && !previewUrl && previewContent && <pre className="s3-preview-text">{previewContent}</pre>}
                                    {editing && <textarea className="s3-edit-area" value={editContent} onChange={(e) => setEditContent(e.target.value)} />}
                                  </div>
                                </div>
                              )}

                              <div className="s3-action-bar">
                                {showNewFolder ? (
                                  <div className="s3-inline-form">
                                    <input placeholder="folder name" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} />
                                    <button className="s3-btn s3-btn-ok" type="button" onClick={() => void (async () => {
                                      if (!selectedContainerSummary || !newFolderName.trim()) return
                                      try {
                                        const folderKey = `${prefix}${newFolderName.trim().replace(/\/$/, '')}/`
                                        await putAzureStorageBlobContent(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, folderKey, '', selectedAccount.primaryBlobEndpoint)
                                        setMessage(`Folder "${newFolderName}" created`)
                                        setNewFolderName('')
                                        setShowNewFolder(false)
                                        await browseContainer(selectedAccount, selectedContainerSummary.name, prefix)
                                      } catch (error) {
                                        setBlobsError(normalizeError(error))
                                      }
                                    })()}>Create</button>
                                    <button className="s3-btn" type="button" onClick={() => { setShowNewFolder(false); setNewFolderName('') }}>Cancel</button>
                                  </div>
                                ) : <button className="s3-btn" type="button" onClick={() => setShowNewFolder(true)}>New Folder</button>}
                                <button className="s3-btn s3-btn-upload" type="button" onClick={() => fileInputRef.current?.click()}>Upload</button>
                                <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={(e) => {
                                  const file = e.target.files?.[0]
                                  if (file && selectedContainerSummary) {
                                    void (async () => {
                                      try {
                                        const localPath = (file as File & { path?: string }).path?.trim() ?? ''
                                        const blobKey = `${prefix}${file.name}`
                                        if (localPath) {
                                          await uploadAzureStorageBlob(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, blobKey, localPath, selectedAccount.primaryBlobEndpoint)
                                        } else if (isTextFile(file.name)) {
                                          await putAzureStorageBlobContent(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, blobKey, await file.text(), selectedAccount.primaryBlobEndpoint)
                                        } else {
                                          throw new Error('The selected file could not be uploaded because the local filesystem path was not exposed to the app.')
                                        }
                                        setMessage(`Uploaded ${file.name}`)
                                        await browseContainer(selectedAccount, selectedContainerSummary.name, prefix)
                                      } catch (error) {
                                        setBlobsError(normalizeError(error))
                                      }
                                    })()
                                  }
                                  e.target.value = ''
                                }} />
                                <button className="s3-btn" type="button" disabled={!selectedBlob || selectedBlob.isFolder} onClick={() => void (async () => {
                                  if (!selectedBlob || selectedBlob.isFolder || !selectedContainerSummary) return
                                  try {
                                    const filePath = await downloadAzureStorageBlobToPath(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, selectedBlob.key, selectedAccount.primaryBlobEndpoint)
                                    if (filePath) setMessage(`Downloaded to ${filePath}`)
                                  } catch (error) {
                                    setBlobsError(normalizeError(error))
                                  }
                                })()}>Download</button>
                                <button className="s3-btn" type="button" disabled={!selectedBlob || selectedBlob.isFolder} onClick={() => void (async () => {
                                  if (!selectedBlob || selectedBlob.isFolder || !selectedContainerSummary) return
                                  try {
                                    const filePath = await openAzureStorageBlob(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, selectedBlob.key, selectedAccount.primaryBlobEndpoint)
                                    setMessage(`Opened ${selectedBlob.key} (${filePath})`)
                                  } catch (error) {
                                    setBlobsError(normalizeError(error))
                                  }
                                })()}>Open</button>
                                <button className="s3-btn" type="button" disabled={!selectedBlob || selectedBlob.isFolder} onClick={() => void (async () => {
                                  if (!selectedBlob || selectedBlob.isFolder || !selectedContainerSummary) return
                                  try {
                                    const filePath = await openAzureStorageBlobInVSCode(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, selectedBlob.key, selectedAccount.primaryBlobEndpoint)
                                    setMessage(`Opened ${selectedBlob.key} in VSCode (${filePath}). Changes will sync back automatically.`)
                                  } catch (error) {
                                    setBlobsError(normalizeError(error))
                                  }
                                })()}>Open in VSCode</button>
                                <button className="s3-btn" type="button" disabled={!selectedBlob || selectedBlob.isFolder || !canRunTerminalCommand} onClick={() => selectedBlob && onRunTerminalCommand(`az storage blob show --account-name "${selectedAccount.name}" --container-name "${selectedContainerSummary.name}" --name "${selectedBlob.key}" --auth-mode login --output jsonc`)}>Inspect Blob</button>
                                <ConfirmButton className="s3-btn s3-btn-danger" onConfirm={() => void (async () => {
                                  if (!selectedBlob || selectedBlob.isFolder || !selectedContainerSummary) return
                                  const deletedKey = selectedBlob.key
                                  try {
                                    await deleteAzureStorageBlob(subscriptionId, selectedAccount.resourceGroup, selectedAccount.name, selectedContainerSummary.name, deletedKey, selectedAccount.primaryBlobEndpoint)
                                    setMessage(`Deleted ${deletedKey}`)
                                    setSelectedKey('')
                                    closePreview()
                                    await browseContainer(selectedAccount, selectedContainerSummary.name, prefix)
                                  } catch (error) {
                                    setBlobsError(normalizeError(error))
                                  }
                                })()} disabled={!selectedBlob || selectedBlob.isFolder} confirmLabel="Confirm Delete?">Delete</ConfirmButton>
                              </div>

                              {showPreviewFullscreen && showPreview && selectedKey && (
                                <div className="s3-preview-overlay" onClick={() => setShowPreviewFullscreen(false)}>
                                  <div className="s3-preview-overlay-panel" onClick={(e) => e.stopPropagation()}>
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
                                      {previewError && <div className="error-banner">{previewError}</div>}
                                      {!editing && previewUrl && <img src={previewUrl} alt={selectedKey} style={{ maxWidth: '100%', maxHeight: '85vh', objectFit: 'contain' }} />}
                                      {!editing && !previewUrl && previewContent && <pre className="s3-preview-text s3-preview-text-fullscreen">{previewContent}</pre>}
                                      {editing && <textarea className="s3-edit-area s3-edit-area-fullscreen" value={editContent} onChange={(e) => setEditContent(e.target.value)} />}
                                      {!previewContent && !previewUrl && !previewError && !editing && <SvcState variant="loading" resourceName="preview" compact />}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {detailTab === 'posture' && (
                    <div className="s3-governance-panel">
                      <div className="s3-summary-strip">
                        <div className="s3-summary-card"><span>Kind</span><strong>{selectedAccount.kind || 'Unknown'}</strong></div>
                        <div className="s3-summary-card"><span>Blob public access</span><strong>{selectedAccount.allowBlobPublicAccess ? 'Allowed' : 'Disabled'}</strong></div>
                        <div className="s3-summary-card"><span>Shared key access</span><strong>{selectedAccount.allowSharedKeyAccess ? 'Allowed' : 'Disabled'}</strong></div>
                        <div className="s3-summary-card"><span>Versioning</span><strong>{selectedAccount.versioningEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                        <div className="s3-summary-card"><span>Change feed</span><strong>{selectedAccount.changeFeedEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                        <div className="s3-summary-card"><span>Container soft delete</span><strong>{selectedAccount.containerDeleteRetentionDays || 0} days</strong></div>
                      </div>

                      <div className="s3-hygiene-panel">
                        <div className="s3-hygiene-card">
                          <span>Large blobs</span>
                          <strong>{largeObjects.length}</strong>
                          <label>Threshold MB<input value={largeObjectThresholdMb} onChange={(e) => setLargeObjectThresholdMb(e.target.value)} /></label>
                          <button className={`s3-chip ${showLargeOnly ? 'active' : ''}`} type="button" onClick={() => setShowLargeOnly((v) => !v)}>{showLargeOnly ? 'Showing large only' : 'Filter large'}</button>
                        </div>
                        <div className="s3-hygiene-card">
                          <span>Old blobs</span>
                          <strong>{oldObjects.length}</strong>
                          <label>Older than days<input value={oldObjectDays} onChange={(e) => setOldObjectDays(e.target.value)} /></label>
                          <button className={`s3-chip ${showOldOnly ? 'active' : ''}`} type="button" onClick={() => setShowOldOnly((v) => !v)}>{showOldOnly ? 'Showing old only' : 'Filter old'}</button>
                        </div>
                        <div className="s3-hygiene-card s3-hygiene-wide">
                          <span>Access tiers</span>
                          <div className="s3-storage-class-list">
                            {accessTierSummary.length === 0 ? <span className="s3-muted">No blobs in this prefix.</span> : accessTierSummary.map((entry) => (
                              <div key={entry.tier} className="s3-storage-class-row">
                                <strong>{entry.tier}</strong>
                                <span>{entry.count} blobs</span>
                                <span>{formatSize(entry.totalBytes)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="s3-hygiene-queue">
                        <div className="s3-hygiene-queue-header">
                          <div>
                            <strong>Blob Hygiene Triage</strong>
                            <p>Prioritize oversized or stale blobs before changing lifecycle policy.</p>
                          </div>
                          <div className="s3-mini-badges">
                            <span className="s3-mini-badge warn">{hygieneCandidates.length} candidates</span>
                            <button className="s3-btn" type="button" onClick={() => setDetailTab('objects')} disabled={!selectedAccount}>Review Blobs</button>
                          </div>
                        </div>
                        {topHygieneCandidates.length === 0 ? (
                          <SvcState variant="empty" message="No large or old blobs in this prefix for the current thresholds." compact />
                        ) : (
                          <div className="s3-hygiene-queue-list">
                            {topHygieneCandidates.map((candidate) => (
                              <button
                                key={candidate.key}
                                type="button"
                                className={`s3-hygiene-item ${selectedKey === candidate.key ? 'active' : ''}`}
                                onClick={() => {
                                  setSelectedKey(candidate.key)
                                  setDetailTab('objects')
                                  if (selectedAccount && selectedContainerSummary) {
                                    const blob = blobs.find((b) => b.key === candidate.key)
                                    if (blob) void doPreview(selectedAccount, selectedContainerSummary.name, blob)
                                  }
                                }}
                              >
                                <div className="s3-hygiene-item-main">
                                  <strong>{displayName(candidate.key, prefix)}</strong>
                                  <span>{candidate.reasons.join(' | ')}</span>
                                </div>
                                <div className="s3-hygiene-item-meta">
                                  <span>{formatSize(candidate.size)}</span>
                                  <span>{candidate.lastModified ? new Date(candidate.lastModified).toLocaleDateString() : '-'}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="s3-bucket-focus">
                        <div className="s3-bucket-focus-main">
                          <div className="s3-bucket-focus-top">
                            <div>
                              <span className="s3-bucket-focus-kicker">Selected account</span>
                              <h3>{selectedAccount.name}</h3>
                              <p>Subscription {subscriptionId} | Region lens {locationLabel}</p>
                            </div>
                          </div>
                          <div className="s3-bucket-focus-summary">
                            <div className="s3-bucket-focus-stat"><span>Default network action</span><strong>{selectedAccount.defaultNetworkAction || 'Unknown'}</strong></div>
                            <div className="s3-bucket-focus-stat"><span>Minimum TLS</span><strong>{selectedAccount.minimumTlsVersion || 'Unknown'}</strong></div>
                            <div className="s3-bucket-focus-stat"><span>Tags</span><strong>{selectedAccount.tagCount}</strong></div>
                          </div>
                          <div className="s3-bucket-focus-badges">
                            <span className={`s3-mini-badge ${postureBadgeTone(selectedAccount.httpsOnly)}`}>{selectedAccount.httpsOnly ? 'HTTPS Only' : 'HTTPS Not Enforced'}</span>
                            <span className={`s3-mini-badge ${postureBadgeTone(!selectedAccount.allowBlobPublicAccess)}`}>{selectedAccount.allowBlobPublicAccess ? 'Blob Public Access Allowed' : 'Blob Public Access Disabled'}</span>
                            <span className={`s3-mini-badge ${postureBadgeTone(selectedAccount.publicNetworkAccess.toLowerCase() !== 'enabled')}`}>{selectedAccount.publicNetworkAccess || 'Unknown Network Access'}</span>
                            <span className={`s3-mini-badge ${postureBadgeTone(selectedAccount.versioningEnabled)}`}>{selectedAccount.versioningEnabled ? 'Versioning Enabled' : 'No Versioning'}</span>
                            <span className={`s3-mini-badge ${postureBadgeTone(selectedAccount.changeFeedEnabled)}`}>{selectedAccount.changeFeedEnabled ? 'Change Feed On' : 'Change Feed Off'}</span>
                            <span className={`s3-mini-badge ${postureBadgeTone(!selectedAccount.allowSharedKeyAccess)}`}>{selectedAccount.allowSharedKeyAccess ? 'Shared Key Allowed' : 'Shared Key Disabled'}</span>
                          </div>
                          {selectedAccount.notes.length > 0 ? <div className="overview-note-list">{selectedAccount.notes.map((note) => <div key={note} className="overview-note-item">{note}</div>)}</div> : null}
                        </div>

                        <div className="s3-next-actions-panel">
                          <div className="s3-next-actions-header">
                            <strong>Next Actions</strong>
                            <span>3</span>
                          </div>
                          <div className="s3-next-action-card editable">
                            <div className="s3-next-action-copy">
                              <span className="s3-action-mode editable">Operator</span>
                              <strong>Inspect account in terminal</strong>
                              <span>Run the equivalent `az storage account show` command against the same subscription and resource group.</span>
                            </div>
                            <button className="s3-btn s3-next-action-btn" type="button" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az storage account show -g "${selectedAccount.resourceGroup}" -n "${selectedAccount.name}" --subscription "${subscriptionId}" --output jsonc`)}>
                              Open Account
                            </button>
                          </div>
                          <div className="s3-next-action-card editable">
                            <div className="s3-next-action-copy">
                              <span className="s3-action-mode editable">Diagnostics</span>
                              <strong>Open Monitor</strong>
                              <span>Carry the selected storage account context into the Monitor investigation workspace.</span>
                            </div>
                            <button className="s3-btn s3-next-action-btn" type="button" onClick={() => onOpenMonitor(`Microsoft.Storage ${selectedAccount.name}`)}>
                              Open Monitor
                            </button>
                          </div>
                          <div className="s3-next-action-card editable">
                            <div className="s3-next-action-copy">
                              <span className="s3-action-mode editable">Workflow</span>
                              <strong>Return to blob operations</strong>
                              <span>Jump back to container and blob browsing for preview, edit, upload, download, and delete flows.</span>
                            </div>
                            <button className="s3-btn s3-next-action-btn" type="button" onClick={() => setDetailTab('objects')}>
                              Open Objects
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="s3-check-section">
                        <div className="s3-check-section-header">
                          <strong>Account Security Posture</strong>
                          <span>Key security settings for this storage account.</span>
                        </div>
                        <div className="s3-governance-checks">
                          {([
                            { label: 'HTTPS enforcement', status: selectedAccount.httpsOnly ? 'enabled' as const : 'disabled' as const, summary: selectedAccount.httpsOnly ? 'All traffic is forced to HTTPS.' : 'HTTP traffic is allowed. Consider enforcing HTTPS only.' },
                            { label: 'Blob public access', status: selectedAccount.allowBlobPublicAccess ? 'disabled' as const : 'enabled' as const, summary: selectedAccount.allowBlobPublicAccess ? 'Blob-level public access is allowed. Containers can be made public.' : 'Blob-level public access is blocked at the account level.' },
                            { label: 'Public network access', status: selectedAccount.publicNetworkAccess.toLowerCase() === 'enabled' ? 'partial' as const : 'enabled' as const, summary: `Public network access is ${selectedAccount.publicNetworkAccess.toLowerCase()}.` },
                            { label: 'Blob versioning', status: selectedAccount.versioningEnabled ? 'enabled' as const : 'disabled' as const, summary: selectedAccount.versioningEnabled ? 'Blob versioning is enabled for overwrite and delete recovery.' : 'Blob versioning is not enabled. Consider enabling for data protection.' },
                            { label: 'Shared key access', status: selectedAccount.allowSharedKeyAccess ? 'partial' as const : 'enabled' as const, summary: selectedAccount.allowSharedKeyAccess ? 'Shared key authentication is allowed. Consider restricting to Azure AD only.' : 'Shared key access is disabled. Only Azure AD authentication is accepted.' },
                            { label: 'Minimum TLS version', status: (selectedAccount.minimumTlsVersion || '').includes('1.2') || (selectedAccount.minimumTlsVersion || '').includes('1.3') ? 'enabled' as const : 'partial' as const, summary: `Minimum TLS version is ${selectedAccount.minimumTlsVersion || 'unknown'}.` }
                          ]).map(({ label, status, summary }) => (
                            <div key={label} className={`s3-check-card ${status === 'enabled' ? 'readonly' : 'editable'}`}>
                              <div className="s3-check-top"><strong>{label}</strong><span className={`s3-badge s3-check-${status}`}>{status === 'enabled' ? 'Enabled' : status === 'partial' ? 'Partial' : 'Disabled'}</span></div>
                              <p>{summary}</p>
                              <div className="s3-check-mode">{status === 'enabled' ? 'Secure posture confirmed.' : 'Review and harden this setting.'}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="s3-check-section">
                        <div className="s3-check-section-header">
                          <strong>Data Protection</strong>
                          <span>Retention and recovery settings.</span>
                        </div>
                        <div className="s3-governance-checks">
                          {([
                            { label: 'Blob soft-delete retention', status: (selectedAccount.blobDeleteRetentionDays || 0) > 0 ? 'enabled' as const : 'disabled' as const, summary: (selectedAccount.blobDeleteRetentionDays || 0) > 0 ? `Soft-deleted blobs are retained for ${selectedAccount.blobDeleteRetentionDays} days.` : 'Blob soft-delete is not configured. Deleted blobs cannot be recovered.' },
                            { label: 'Container soft-delete retention', status: (selectedAccount.containerDeleteRetentionDays || 0) > 0 ? 'enabled' as const : 'disabled' as const, summary: (selectedAccount.containerDeleteRetentionDays || 0) > 0 ? `Deleted containers are retained for ${selectedAccount.containerDeleteRetentionDays} days.` : 'Container soft-delete is not configured.' },
                            { label: 'Change feed', status: selectedAccount.changeFeedEnabled ? 'enabled' as const : 'disabled' as const, summary: selectedAccount.changeFeedEnabled ? 'Change feed is enabled for audit and tracking of blob changes.' : 'Change feed is disabled. Enable for blob change audit trail.' }
                          ]).map(({ label, status, summary }) => (
                            <div key={label} className={`s3-check-card ${status === 'enabled' ? 'readonly' : 'editable'}`}>
                              <div className="s3-check-top"><strong>{label}</strong><span className={`s3-badge s3-check-${status}`}>{status === 'enabled' ? 'Enabled' : 'Disabled'}</span></div>
                              <p>{summary}</p>
                              <div className="s3-check-mode">{status === 'enabled' ? 'Data protection active.' : 'Consider enabling for data protection.'}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {detailTab === 'timeline' && (
                    <div className="s3-governance-panel s3-timeline-panel" style={{ padding: 16 }}>
                      <div className="s3-timeline-head">
                        <span className="s3-pane-kicker">Azure Monitor</span>
                        <h3>Activity timeline</h3>
                        <p>
                          Management-plane events for <strong>{selectedAccount?.name ?? 'selected account'}</strong> from the last 7 days.
                        </p>
                      </div>
                      {timelineLoading && <SvcState variant="loading" resourceName="activity events" compact />}
                      {!timelineLoading && timelineError && <SvcState variant="error" error={timelineError} />}
                      {!timelineLoading && !timelineError && timelineEvents.length === 0 && <SvcState variant="empty" message="No Azure Monitor events found for this storage account." />}
                      {!timelineLoading && timelineEvents.length > 0 && (
                        <div className="s3-object-table-wrap s3-timeline-table-wrap">
                          <table className="s3-timeline-table">
                            <colgroup>
                              <col className="s3-timeline-col-operation" />
                              <col className="s3-timeline-col-status" />
                              <col className="s3-timeline-col-caller" />
                              <col className="s3-timeline-col-time" />
                            </colgroup>
                            <thead>
                              <tr>
                                <th>Operation</th>
                                <th>Status</th>
                                <th>Caller</th>
                                <th>Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {timelineEvents.map((event) => (
                                <tr key={event.id}>
                                  <td title={event.resourceId || event.resourceType}>
                                    <div className="s3-timeline-primary">{event.operationName || 'Unknown operation'}</div>
                                    <div className="s3-timeline-secondary">{event.resourceType || event.resourceGroup || 'Management event'}</div>
                                  </td>
                                  <td>
                                    <span className={`s3-status-badge ${activityStatusTone(event.status)}`}>{event.status || 'Unknown'}</span>
                                  </td>
                                  <td title={event.caller || '-'}>
                                    <div className="s3-timeline-primary">{event.caller || '-'}</div>
                                    <div className="s3-timeline-secondary">{event.correlationId ? `Correlation: ${event.correlationId}` : (event.level || 'Administrative')}</div>
                                  </td>
                                  <td>
                                    <div className="s3-timeline-primary">{event.timestamp ? new Date(event.timestamp).toLocaleString() : '-'}</div>
                                    <div className="s3-timeline-secondary">{event.summary || event.resourceGroup || 'Azure Monitor activity event'}</div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {detailTab === 'fileShares' && (
                    <div style={{ padding: '12px 0' }}>
                      {fileSharesLoading && <div style={{ color: '#9ca7b7', fontSize: 12 }}>Loading file shares...</div>}
                      {!fileSharesLoading && fileShares.length === 0 && <div style={{ color: '#9ca7b7', fontSize: 12 }}>No file shares found in this storage account.</div>}
                      {!fileSharesLoading && fileShares.length > 0 && (
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Name</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Quota</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Access Tier</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Protocol</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Lease</th>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Used</th>
                              </tr>
                            </thead>
                            <tbody>
                              {fileShares.map((share) => (
                                <tr key={share.name}>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{share.name}</td>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{share.quota} GiB</td>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{share.accessTier || '-'}</td>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{share.enabledProtocols}</td>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{share.leaseStatus || '-'}</td>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{share.usedCapacityBytes > 0 ? formatSize(share.usedCapacityBytes) : '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {detailTab === 'queues' && (
                    <div style={{ padding: '12px 0' }}>
                      {queuesLoading && <div style={{ color: '#9ca7b7', fontSize: 12 }}>Loading queues...</div>}
                      {!queuesLoading && queues.length === 0 && <div style={{ color: '#9ca7b7', fontSize: 12 }}>No queues found in this storage account.</div>}
                      {!queuesLoading && queues.length > 0 && (
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Name</th>
                                <th style={{ textAlign: 'right', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Approx. Messages</th>
                              </tr>
                            </thead>
                            <tbody>
                              {queues.map((q) => (
                                <tr key={q.name}>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{q.name}</td>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2', textAlign: 'right' }}>{q.approximateMessageCount}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {detailTab === 'tables' && (
                    <div style={{ padding: '12px 0' }}>
                      {tablesLoading && <div style={{ color: '#9ca7b7', fontSize: 12 }}>Loading tables...</div>}
                      {!tablesLoading && tables.length === 0 && <div style={{ color: '#9ca7b7', fontSize: 12 }}>No tables found in this storage account.</div>}
                      {!tablesLoading && tables.length > 0 && (
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: 'left', padding: '6px 10px', color: '#9ca7b7', borderBottom: '2px solid #3b4350', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>Table Name</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tables.map((t) => (
                                <tr key={t.name}>
                                  <td style={{ padding: '5px 10px', borderBottom: '1px solid #262c35', color: '#d0d8e2' }}>{t.name}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
