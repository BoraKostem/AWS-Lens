import { useEffect, useMemo, useState } from 'react'
import './ecr.css'

import {
  createEcrRepository,
  deleteEcrImage,
  deleteEcrRepository,
  ecrDockerLogin,
  ecrDockerPull,
  ecrDockerPush,
  getEcrScanFindings,
  listEcrImages,
  listEcrRepositories,
  startEcrImageScan
} from './api'
import { ConfirmButton } from './ConfirmButton'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import { SvcState } from './SvcState'
import type {
  AwsConnection,
  EcrImageSummary,
  EcrRepositorySummary,
  EcrScanResult
} from '@shared/types'

function formatTs(value: string): string {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function formatMB(bytes: number): string {
  if (bytes <= 0) return '0'
  return (bytes / (1024 * 1024)).toFixed(1)
}

function formatDigest(digest: string): string {
  if (!digest) return '-'
  return digest.length > 22 ? `${digest.slice(0, 22)}...` : digest
}

function scanTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  const normalized = status.toUpperCase()
  if (normalized === 'COMPLETE') return 'success'
  if (normalized === 'FAILED' || normalized === 'UNSUPPORTED_IMAGE') return 'danger'
  if (normalized === 'IN_PROGRESS' || normalized === 'PENDING') return 'warning'
  return 'info'
}

function repoStatusTone(mutability: string): 'success' | 'info' {
  return mutability === 'IMMUTABLE' ? 'info' : 'success'
}

type RepoColumnKey = 'repositoryName' | 'repositoryUri' | 'imageTagMutability' | 'createdAt'
type ImageColumnKey = 'imageTag' | 'digest' | 'scanStatus' | 'pushedAt' | 'sizeMB' | 'lastPull'

const REPO_COLUMNS: { key: RepoColumnKey; label: string }[] = [
  { key: 'repositoryName', label: 'Repository Name' },
  { key: 'repositoryUri', label: 'Repository URI' },
  { key: 'imageTagMutability', label: 'Tag Mutability' },
  { key: 'createdAt', label: 'Created At' }
]

const IMAGE_COLUMNS: { key: ImageColumnKey; label: string }[] = [
  { key: 'imageTag', label: 'Image Tag' },
  { key: 'digest', label: 'Digest' },
  { key: 'scanStatus', label: 'Scan Status' },
  { key: 'pushedAt', label: 'Pushed At' },
  { key: 'sizeMB', label: 'Size MB' },
  { key: 'lastPull', label: 'Last Pull' }
]

function getRepoCellValue(repo: EcrRepositorySummary, key: RepoColumnKey): string {
  switch (key) {
    case 'repositoryName':
      return repo.repositoryName
    case 'repositoryUri':
      return repo.repositoryUri
    case 'imageTagMutability':
      return repo.imageTagMutability
    case 'createdAt':
      return formatTs(repo.createdAt)
  }
}

function getImageCellValue(img: EcrImageSummary, key: ImageColumnKey): string {
  switch (key) {
    case 'imageTag':
      return img.imageTags.length ? img.imageTags.join(', ') : 'untagged'
    case 'digest':
      return formatDigest(img.imageDigest)
    case 'scanStatus':
      return img.scanStatus
    case 'pushedAt':
      return formatTs(img.pushedAt)
    case 'sizeMB':
      return formatMB(img.sizeBytes)
    case 'lastPull':
      return formatTs(img.lastPull)
  }
}

function connectionLabel(connection: AwsConnection): string {
  return connection.kind === 'profile' ? connection.profile : connection.label
}

function totalSeverityCount(scanResult: EcrScanResult | null): number {
  if (!scanResult) return 0
  return Object.values(scanResult.findingCounts).reduce((sum, value) => sum + value, 0)
}

function CreateRepoDialog({
  onClose,
  onCreate
}: {
  onClose: () => void
  onCreate: (name: string, mutability: string, scanOnPush: boolean) => void
}) {
  const [name, setName] = useState('')
  const [mutability, setMutability] = useState('MUTABLE')
  const [scanOnPush, setScanOnPush] = useState(false)

  return (
    <div className="ecr-dialog-overlay">
      <div className="ecr-dialog">
        <div className="ecr-dialog-head">
          <div>
            <span className="ecr-pane-kicker">Create repository</span>
            <h3>Provision a new ECR target</h3>
          </div>
        </div>
        <label className="ecr-dialog-field">
          <span>Repository name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="team/service" />
        </label>
        <label className="ecr-dialog-field">
          <span>Tag mutability</span>
          <select value={mutability} onChange={(e) => setMutability(e.target.value)}>
            <option value="MUTABLE">MUTABLE</option>
            <option value="IMMUTABLE">IMMUTABLE</option>
          </select>
        </label>
        <label className="ecr-dialog-field ecr-dialog-checkbox">
          <input type="checkbox" checked={scanOnPush} onChange={(e) => setScanOnPush(e.target.checked)} />
          <span>Enable scan on push</span>
        </label>
        <div className="ecr-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="ecr-toolbar-btn accent"
            disabled={!name.trim()}
            onClick={() => onCreate(name.trim(), mutability, scanOnPush)}
          >
            Create Repository
          </button>
        </div>
      </div>
    </div>
  )
}

function ScanFindingsDialog({
  scanResult,
  loading,
  onClose
}: {
  scanResult: EcrScanResult | null
  loading: boolean
  onClose: () => void
}) {
  return (
    <div className="ecr-dialog-overlay">
      <div className="ecr-dialog ecr-dialog-wide">
        <div className="ecr-dialog-head">
          <div>
            <span className="ecr-pane-kicker">Scan findings</span>
            <h3>Vulnerability review</h3>
          </div>
        </div>
        {loading && <SvcState variant="loading" resourceName="scan findings" message="Loading scan findings..." />}
        {!loading && !scanResult && <SvcState variant="empty" message="No scan results available for the selected image." />}
        {!loading && scanResult && (
          <>
            <div className="ecr-scan-summary">
              <div className="ecr-scan-summary-card">
                <span>Status</span>
                <strong>{scanResult.scanStatus}</strong>
              </div>
              <div className="ecr-scan-summary-card">
                <span>Completed</span>
                <strong>{formatTs(scanResult.scanCompletedAt)}</strong>
              </div>
              <div className="ecr-scan-summary-card">
                <span>Findings</span>
                <strong>{totalSeverityCount(scanResult)}</strong>
              </div>
            </div>
            {Object.keys(scanResult.findingCounts).length > 0 && (
              <div className="ecr-severity-strip">
                {Object.entries(scanResult.findingCounts).map(([severity, count]) => (
                  <span key={severity} className={`ecr-severity ${severity}`}>
                    {severity}: {count}
                  </span>
                ))}
              </div>
            )}
            {scanResult.findings.length > 0 ? (
              <div className="ecr-findings-list">
                {scanResult.findings.map((finding, index) => (
                  <div key={`${finding.name}-${index}`} className="ecr-finding-row">
                    <span className={`ecr-severity ${finding.severity}`}>{finding.severity}</span>
                    <strong>{finding.name}</strong>
                    <span className="ecr-finding-package">
                      {finding.package} {finding.packageVersion !== '-' ? finding.packageVersion : ''}
                    </span>
                    <span className="ecr-finding-desc">{finding.description}</span>
                  </div>
                ))}
              </div>
            ) : (
              <SvcState variant="empty" message="No vulnerabilities found in the selected image." />
            )}
          </>
        )}
        <div className="ecr-dialog-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

export function EcrConsole({ connection }: { connection: AwsConnection }) {
  const [repos, setRepos] = useState<EcrRepositorySummary[]>([])
  const [selectedRepoName, setSelectedRepoName] = useState('')
  const [repoFilter, setRepoFilter] = useState('')
  const [repoColumns, setRepoColumns] = useState<Set<RepoColumnKey>>(
    () => new Set(REPO_COLUMNS.map((column) => column.key))
  )

  const [images, setImages] = useState<EcrImageSummary[]>([])
  const [selectedImageDigest, setSelectedImageDigest] = useState('')
  const [imageFilter, setImageFilter] = useState('')
  const [imageColumns, setImageColumns] = useState<Set<ImageColumnKey>>(
    () => new Set(IMAGE_COLUMNS.map((column) => column.key))
  )

  const [localImage, setLocalImage] = useState('')
  const [targetTag, setTargetTag] = useState('latest')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [scanResult, setScanResult] = useState<EcrScanResult | null>(null)
  const [scanLoading, setScanLoading] = useState(false)
  const [showFindings, setShowFindings] = useState(false)

  const {
    freshness: repoFreshness,
    beginRefresh: beginRepoRefresh,
    completeRefresh: completeRepoRefresh,
    failRefresh: failRepoRefresh
  } = useFreshnessState()
  const {
    freshness: imageFreshness,
    beginRefresh: beginImageRefresh,
    completeRefresh: completeImageRefresh,
    failRefresh: failImageRefresh,
    replaceFetchedAt: replaceImageFetchedAt
  } = useFreshnessState()

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.repositoryName === selectedRepoName) ?? null,
    [repos, selectedRepoName]
  )

  const selectedImage = useMemo(
    () => images.find((img) => img.imageDigest === selectedImageDigest) ?? null,
    [images, selectedImageDigest]
  )

  const visibleRepoCols = useMemo(
    () => REPO_COLUMNS.filter((column) => repoColumns.has(column.key)),
    [repoColumns]
  )
  const visibleImageCols = useMemo(
    () => IMAGE_COLUMNS.filter((column) => imageColumns.has(column.key)),
    [imageColumns]
  )

  const filteredRepos = useMemo(() => {
    if (!repoFilter) return repos
    const query = repoFilter.toLowerCase()
    return repos.filter((repo) =>
      visibleRepoCols.some((column) => getRepoCellValue(repo, column.key).toLowerCase().includes(query))
    )
  }, [repos, repoFilter, visibleRepoCols])

  const filteredImages = useMemo(() => {
    if (!imageFilter) return images
    const query = imageFilter.toLowerCase()
    return images.filter((img) =>
      visibleImageCols.some((column) => getImageCellValue(img, column.key).toLowerCase().includes(query))
    )
  }, [images, imageFilter, visibleImageCols])

  const inventorySummary = useMemo(() => {
    const immutableRepos = repos.filter((repo) => repo.imageTagMutability === 'IMMUTABLE').length
    const scanOnPushRepos = repos.filter((repo) => repo.scanOnPush).length
    const totalImages = repos.reduce((sum, repo) => sum + repo.imageCount, 0)
    return {
      immutableRepos,
      scanOnPushRepos,
      totalImages
    }
  }, [repos])

  useEffect(() => {
    void loadRepos('initial')
  }, [connection.sessionId, connection.region])

  async function loadRepos(reason: 'initial' | 'manual' | 'workflow' | 'selection' = 'manual', preferredRepoName?: string) {
    beginRepoRefresh(reason)
    setError('')
    try {
      const repoList = await listEcrRepositories(connection)
      setRepos(repoList)

      const nextRepoName = preferredRepoName && repoList.some((repo) => repo.repositoryName === preferredRepoName)
        ? preferredRepoName
        : repoList.some((repo) => repo.repositoryName === selectedRepoName)
          ? selectedRepoName
          : repoList[0]?.repositoryName ?? ''

      if (!nextRepoName) {
        setSelectedRepoName('')
        setImages([])
        setSelectedImageDigest('')
        setScanResult(null)
        replaceImageFetchedAt(null)
      } else {
        await loadImages(nextRepoName, reason === 'initial' ? 'initial' : 'selection')
      }

      completeRepoRefresh()
    } catch (e) {
      failRepoRefresh()
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function loadImages(repoName: string, reason: 'initial' | 'manual' | 'workflow' | 'selection' = 'selection') {
    const changingRepo = repoName !== selectedRepoName
    beginImageRefresh(reason)
    setSelectedRepoName(repoName)
    setScanResult(null)
    setError('')
    if (changingRepo) {
      setSelectedImageDigest('')
    }

    try {
      const imageList = await listEcrImages(connection, repoName)
      setImages(imageList)
      setSelectedImageDigest((current) => {
        if (changingRepo) return ''
        return imageList.some((img) => img.imageDigest === current) ? current : ''
      })
      completeImageRefresh()
    } catch (e) {
      setImages([])
      setSelectedImageDigest('')
      failImageRefresh()
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreateRepo(name: string, mutability: string, scanOnPush: boolean) {
    setShowCreateDialog(false)
    setError('')
    try {
      await createEcrRepository(connection, name, mutability, scanOnPush)
      setMsg(`Repository ${name} created`)
      await loadRepos('workflow', name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteRepo() {
    if (!selectedRepoName) return
    setError('')
    try {
      await deleteEcrRepository(connection, selectedRepoName, true)
      setMsg(`Repository ${selectedRepoName} deleted`)
      await loadRepos('workflow')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteImage() {
    if (!selectedRepoName || !selectedImageDigest) return
    setError('')
    try {
      await deleteEcrImage(connection, selectedRepoName, selectedImageDigest)
      setMsg('Image deleted')
      await loadImages(selectedRepoName, 'workflow')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleStartScan() {
    if (!selectedRepoName || !selectedImageDigest) return
    setError('')
    try {
      const tag = selectedImage?.imageTags[0]
      await startEcrImageScan(connection, selectedRepoName, selectedImageDigest, tag)
      setMsg('Scan started successfully')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleShowFindings() {
    if (!selectedRepoName || !selectedImageDigest) return
    setScanLoading(true)
    setShowFindings(true)
    setError('')
    try {
      const result = await getEcrScanFindings(connection, selectedRepoName, selectedImageDigest)
      setScanResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanLoading(false)
    }
  }

  async function handleDockerLogin() {
    setError('')
    setMsg('')
    try {
      const result = await ecrDockerLogin(connection)
      setMsg(result || 'Docker login successful')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handlePullSelected() {
    if (!selectedRepo || !selectedImage) return
    setError('')
    setMsg('')
    try {
      const tag = selectedImage.imageTags[0] || targetTag
      const result = await ecrDockerPull(selectedRepo.repositoryUri, tag)
      setMsg(result || 'Pull complete')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handlePushLocal() {
    if (!selectedRepo || !localImage.trim()) return
    setError('')
    setMsg('')
    try {
      const result = await ecrDockerPush(localImage.trim(), selectedRepo.repositoryUri, targetTag)
      setMsg(result || 'Push complete')
      await loadImages(selectedRepo.repositoryName, 'workflow')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function toggleRepoCol(key: RepoColumnKey) {
    setRepoColumns((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleImageCol(key: ImageColumnKey) {
    setImageColumns((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="ecr-console">
      {showCreateDialog && (
        <CreateRepoDialog
          onClose={() => setShowCreateDialog(false)}
          onCreate={(name, mutability, scanOnPush) => void handleCreateRepo(name, mutability, scanOnPush)}
        />
      )}

      {showFindings && (
        <ScanFindingsDialog
          scanResult={scanResult}
          loading={scanLoading}
          onClose={() => setShowFindings(false)}
        />
      )}

      <section className="ecr-shell-hero">
        <div className="ecr-shell-hero-copy">
          <div className="eyebrow">Registry operations</div>
          <h2>Elastic Container Registry</h2>
          <p>
            Manage repository posture, inspect image inventory, trigger vulnerability scans, and move container
            artifacts through the selected AWS registry without leaving the service workspace.
          </p>
          <div className="ecr-shell-meta-strip">
            <div className="ecr-shell-meta-pill">
              <span>Connection</span>
              <strong>{connectionLabel(connection)}</strong>
            </div>
            <div className="ecr-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="ecr-shell-meta-pill">
              <span>Selected repo</span>
              <strong>{selectedRepoName || 'None selected'}</strong>
            </div>
            <div className="ecr-shell-meta-pill">
              <span>Registry mode</span>
              <strong>{connection.kind === 'assumed-role' ? 'Assumed role' : 'Profile session'}</strong>
            </div>
          </div>
        </div>
        <div className="ecr-shell-hero-stats">
          <div className="ecr-shell-stat-card ecr-shell-stat-card-accent">
            <span>Repositories</span>
            <strong>{repos.length}</strong>
            <small>Tracked registry targets in this region</small>
          </div>
          <div className="ecr-shell-stat-card">
            <span>Images</span>
            <strong>{inventorySummary.totalImages}</strong>
            <small>Total image manifests across repositories</small>
          </div>
          <div className="ecr-shell-stat-card">
            <span>Immutable repos</span>
            <strong>{inventorySummary.immutableRepos}</strong>
            <small>Repositories with immutable image tags</small>
          </div>
          <div className="ecr-shell-stat-card">
            <span>Scan on push</span>
            <strong>{inventorySummary.scanOnPushRepos}</strong>
            <small>Repositories that scan each incoming image</small>
          </div>
        </div>
      </section>

      <div className="ecr-shell-toolbar">
        <div className="ecr-toolbar">
          <button type="button" className="ecr-toolbar-btn accent" onClick={() => void loadRepos('manual')}>
            Refresh Inventory
          </button>
          <button type="button" className="ecr-toolbar-btn" onClick={() => setShowCreateDialog(true)}>
            Create Repo
          </button>
          <ConfirmButton
            type="button"
            className="ecr-toolbar-btn danger"
            disabled={!selectedRepoName}
            confirmLabel="Confirm Delete?"
            onConfirm={() => void handleDeleteRepo()}
          >
            Delete Repo
          </ConfirmButton>
          <button type="button" className="ecr-toolbar-btn" onClick={() => void handleDockerLogin()}>
            Docker Login
          </button>
        </div>
        <div className="ecr-shell-status">
          <FreshnessIndicator freshness={repoFreshness} label="Repository inventory" />
          {selectedRepoName && <FreshnessIndicator freshness={imageFreshness} label="Image inventory" staleLabel="Reload images" />}
        </div>
      </div>

      {error && <SvcState variant="error" message={error} error={error} />}
      {msg && (
        <div className="ecr-msg">
          <span>{msg}</span>
          <button type="button" className="ecr-msg-dismiss" onClick={() => setMsg('')} aria-label="Dismiss message">
            x
          </button>
        </div>
      )}

      <div className="ecr-main-layout">
        <div className="ecr-repo-list-area">
          <div className="ecr-pane-head">
            <div>
              <span className="ecr-pane-kicker">Tracked repositories</span>
              <h3>Registry inventory</h3>
            </div>
            <span className="ecr-pane-summary">{filteredRepos.length} visible</span>
          </div>

          <input
            className="ecr-search-input"
            placeholder="Filter repositories across visible fields..."
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
          />

          <div className="ecr-column-chips">
            {REPO_COLUMNS.map((column) => (
              <button
                key={column.key}
                className={`ecr-chip ${repoColumns.has(column.key) ? 'active' : ''}`}
                type="button"
                onClick={() => toggleRepoCol(column.key)}
              >
                {column.label}
              </button>
            ))}
          </div>

          <div className="ecr-repo-list">
            {repos.length === 0 ? (
              <SvcState variant="empty" message="No repositories found in the selected region." />
            ) : filteredRepos.length === 0 ? (
              <SvcState variant="no-filter-matches" resourceName="repositories" />
            ) : (
              filteredRepos.map((repo) => (
                <button
                  key={repo.repositoryName}
                  type="button"
                  className={`ecr-repo-row ${repo.repositoryName === selectedRepoName ? 'active' : ''}`}
                  onClick={() => void loadImages(repo.repositoryName, 'selection')}
                >
                  <div className="ecr-repo-row-top">
                    <div className="ecr-repo-row-copy">
                      <strong>{repo.repositoryName}</strong>
                      <span title={repo.repositoryUri}>{repo.repositoryUri}</span>
                    </div>
                    <span className={`ecr-status-badge ${repoStatusTone(repo.imageTagMutability)}`}>
                      {repo.imageTagMutability}
                    </span>
                  </div>
                  <div className="ecr-repo-row-meta">
                    <span>{repo.scanOnPush ? 'Scan on push' : 'Manual scan'}</span>
                    <span>{repo.registryId}</span>
                    <span>{repo.imageCount} images</span>
                  </div>
                  <div className="ecr-repo-row-fields">
                    {visibleRepoCols.map((column) => (
                      <div key={column.key} className="ecr-repo-row-field">
                        <span>{column.label}</span>
                        <strong>{getRepoCellValue(repo, column.key)}</strong>
                      </div>
                    ))}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="ecr-detail-pane">
          {!selectedRepo ? (
            <SvcState variant="no-selection" resourceName="repository" message="Select a repository to inspect image inventory and actions." />
          ) : (
            <>
              <section className="ecr-detail-hero">
                <div className="ecr-detail-hero-copy">
                  <div className="eyebrow">Repository posture</div>
                  <h3>{selectedRepo.repositoryName}</h3>
                  <p>{selectedRepo.repositoryUri}</p>
                  <div className="ecr-detail-meta-strip">
                    <div className="ecr-detail-meta-pill">
                      <span>Registry</span>
                      <strong>{selectedRepo.registryId}</strong>
                    </div>
                    <div className="ecr-detail-meta-pill">
                      <span>Mutability</span>
                      <strong>{selectedRepo.imageTagMutability}</strong>
                    </div>
                    <div className="ecr-detail-meta-pill">
                      <span>Scan on push</span>
                      <strong>{selectedRepo.scanOnPush ? 'Enabled' : 'Disabled'}</strong>
                    </div>
                    <div className="ecr-detail-meta-pill">
                      <span>Created</span>
                      <strong>{formatTs(selectedRepo.createdAt)}</strong>
                    </div>
                  </div>
                </div>
                <div className="ecr-detail-hero-stats">
                  <div className="ecr-detail-stat-card info">
                    <span>Image count</span>
                    <strong>{selectedRepo.imageCount}</strong>
                    <small>Current manifests in the selected repository</small>
                  </div>
                  <div className={`ecr-detail-stat-card ${scanTone(selectedImage?.scanStatus ?? 'NOT_SCANNED')}`}>
                    <span>Selected image</span>
                    <strong>{selectedImage ? (selectedImage.imageTags[0] || 'untagged') : 'None'}</strong>
                    <small>{selectedImage ? selectedImage.scanStatus : 'Choose an image to inspect scan posture'}</small>
                  </div>
                  <div className="ecr-detail-stat-card">
                    <span>Visible images</span>
                    <strong>{filteredImages.length}</strong>
                    <small>Images matching the current inventory filter</small>
                  </div>
                  <div className={`ecr-detail-stat-card ${scanTone(scanResult?.scanStatus ?? 'UNKNOWN')}`}>
                    <span>Known findings</span>
                    <strong>{totalSeverityCount(scanResult)}</strong>
                    <small>{scanResult ? 'Loaded from the latest scan result' : 'Open scan details to inspect findings'}</small>
                  </div>
                </div>
              </section>

              <div className="ecr-detail-grid">
                <section className="ecr-section">
                  <div className="ecr-pane-head">
                    <div>
                      <span className="ecr-pane-kicker">Repository metadata</span>
                      <h3>Deployment target</h3>
                    </div>
                  </div>
                  <div className="ecr-kv">
                    <div className="ecr-kv-row"><div className="ecr-kv-label">Repository URI</div><div className="ecr-kv-value">{selectedRepo.repositoryUri}</div></div>
                    <div className="ecr-kv-row"><div className="ecr-kv-label">Registry ID</div><div className="ecr-kv-value">{selectedRepo.registryId}</div></div>
                    <div className="ecr-kv-row"><div className="ecr-kv-label">Tag mutability</div><div className="ecr-kv-value">{selectedRepo.imageTagMutability}</div></div>
                    <div className="ecr-kv-row"><div className="ecr-kv-label">Scan on push</div><div className="ecr-kv-value">{selectedRepo.scanOnPush ? 'Enabled' : 'Disabled'}</div></div>
                    <div className="ecr-kv-row"><div className="ecr-kv-label">Created</div><div className="ecr-kv-value">{formatTs(selectedRepo.createdAt)}</div></div>
                    <div className="ecr-kv-row"><div className="ecr-kv-label">Region</div><div className="ecr-kv-value">{connection.region}</div></div>
                  </div>
                </section>

                <section className="ecr-section">
                  <div className="ecr-pane-head">
                    <div>
                      <span className="ecr-pane-kicker">Selected image</span>
                      <h3>Scan and lifecycle actions</h3>
                    </div>
                  </div>
                  {!selectedImage ? (
                    <SvcState variant="no-selection" resourceName="image" message="Select an image to inspect digest, scan posture, and lifecycle actions." />
                  ) : (
                    <>
                      <div className="ecr-kv">
                        <div className="ecr-kv-row"><div className="ecr-kv-label">Tag</div><div className="ecr-kv-value">{selectedImage.imageTags.join(', ') || 'untagged'}</div></div>
                        <div className="ecr-kv-row"><div className="ecr-kv-label">Digest</div><div className="ecr-kv-value">{selectedImage.imageDigest}</div></div>
                        <div className="ecr-kv-row"><div className="ecr-kv-label">Pushed</div><div className="ecr-kv-value">{formatTs(selectedImage.pushedAt)}</div></div>
                        <div className="ecr-kv-row"><div className="ecr-kv-label">Last pull</div><div className="ecr-kv-value">{formatTs(selectedImage.lastPull)}</div></div>
                        <div className="ecr-kv-row"><div className="ecr-kv-label">Size</div><div className="ecr-kv-value">{formatMB(selectedImage.sizeBytes)} MB</div></div>
                        <div className="ecr-kv-row"><div className="ecr-kv-label">Scan status</div><div className="ecr-kv-value"><span className={`ecr-status-badge ${scanTone(selectedImage.scanStatus)}`}>{selectedImage.scanStatus}</span></div></div>
                      </div>
                      <div className="ecr-action-cluster">
                        <button
                          type="button"
                          className="ecr-toolbar-btn"
                          onClick={() => void handleStartScan()}
                        >
                          Scan This Image
                        </button>
                        <button
                          type="button"
                          className="ecr-toolbar-btn"
                          onClick={() => void handleShowFindings()}
                        >
                          See Scan Details
                        </button>
                        <ConfirmButton
                          type="button"
                          className="ecr-toolbar-btn danger"
                          disabled={!selectedImageDigest}
                          confirmLabel="Confirm Delete?"
                          onConfirm={() => void handleDeleteImage()}
                        >
                          Delete Image
                        </ConfirmButton>
                      </div>
                    </>
                  )}
                </section>
              </div>

              <section className="ecr-section">
                <div className="ecr-pane-head">
                  <div>
                    <span className="ecr-pane-kicker">Image inventory</span>
                    <h3>Repository manifests</h3>
                  </div>
                  <span className="ecr-pane-summary">{filteredImages.length} visible</span>
                </div>

                <input
                  className="ecr-search-input ecr-section-search"
                  placeholder="Filter images across visible fields..."
                  value={imageFilter}
                  onChange={(e) => setImageFilter(e.target.value)}
                />

                <div className="ecr-column-chips ecr-section-chips">
                  {IMAGE_COLUMNS.map((column) => (
                    <button
                      key={column.key}
                      className={`ecr-chip ${imageColumns.has(column.key) ? 'active' : ''}`}
                      type="button"
                      onClick={() => toggleImageCol(column.key)}
                    >
                      {column.label}
                    </button>
                  ))}
                </div>

                <div className="ecr-image-list">
                  {images.length === 0 ? (
                    <SvcState variant="empty" message="No images found in the selected repository." />
                  ) : filteredImages.length === 0 ? (
                    <SvcState variant="no-filter-matches" resourceName="images" />
                  ) : (
                    filteredImages.map((img) => (
                      <button
                        key={img.imageDigest}
                        type="button"
                        className={`ecr-image-row ${img.imageDigest === selectedImageDigest ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedImageDigest(img.imageDigest)
                          setScanResult(null)
                        }}
                      >
                        <div className="ecr-image-row-top">
                          <div className="ecr-image-row-copy">
                            <strong>{img.imageTags[0] || 'untagged'}</strong>
                            <span>{formatDigest(img.imageDigest)}</span>
                          </div>
                          <span className={`ecr-status-badge ${scanTone(img.scanStatus)}`}>{img.scanStatus}</span>
                        </div>
                        <div className="ecr-image-row-fields">
                          {visibleImageCols.map((column) => (
                            <div key={column.key} className="ecr-image-row-field">
                              <span>{column.label}</span>
                              <strong>{getImageCellValue(img, column.key)}</strong>
                            </div>
                          ))}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </section>

              <section className="ecr-section">
                <div className="ecr-pane-head">
                  <div>
                    <span className="ecr-pane-kicker">Docker workflow</span>
                    <h3>Publish and retrieve images</h3>
                  </div>
                </div>
                <div className="ecr-docker-layout">
                  <label className="ecr-dialog-field">
                    <span>Local image</span>
                    <input
                      value={localImage}
                      onChange={(e) => setLocalImage(e.target.value)}
                      placeholder="local-image:tag"
                    />
                  </label>
                  <label className="ecr-dialog-field">
                    <span>Target tag</span>
                    <input
                      value={targetTag}
                      onChange={(e) => setTargetTag(e.target.value)}
                      placeholder="latest"
                    />
                  </label>
                </div>
                <div className="ecr-action-cluster">
                  <button type="button" className="ecr-toolbar-btn" onClick={() => void handleDockerLogin()}>
                    Docker Login
                  </button>
                  <button
                    type="button"
                    className="ecr-toolbar-btn"
                    disabled={!selectedRepo || !selectedImage}
                    onClick={() => void handlePullSelected()}
                  >
                    Pull Selected
                  </button>
                  <button
                    type="button"
                    className="ecr-toolbar-btn accent"
                    disabled={!selectedRepo || !localImage.trim()}
                    onClick={() => void handlePushLocal()}
                  >
                    Push Local
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
