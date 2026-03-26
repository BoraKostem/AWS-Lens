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
import type {
  AwsConnection,
  EcrImageSummary,
  EcrRepositorySummary,
  EcrScanResult
} from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

/* ── Helpers ──────────────────────────────────────────────── */

function formatTs(value: string): string {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function formatMB(bytes: number): string {
  if (bytes <= 0) return '0'
  return (bytes / (1024 * 1024)).toFixed(1)
}

/* ── Column definitions ───────────────────────────────────── */

type RepoColumnKey = 'repositoryName' | 'repositoryUri' | 'imageTagMutability' | 'createdAt'
type ImageColumnKey = 'imageTag' | 'digest' | 'scanStatus' | 'pushedAt' | 'sizeMB' | 'lastPull'

const REPO_COLUMNS: { key: RepoColumnKey; label: string; color: string }[] = [
  { key: 'repositoryName', label: 'RepositoryName', color: '#3b82f6' },
  { key: 'repositoryUri', label: 'RepositoryUri', color: '#14b8a6' },
  { key: 'imageTagMutability', label: 'TagMutability', color: '#8b5cf6' },
  { key: 'createdAt', label: 'CreatedAt', color: '#f59e0b' }
]

const IMAGE_COLUMNS: { key: ImageColumnKey; label: string; color: string }[] = [
  { key: 'imageTag', label: 'ImageTag', color: '#3b82f6' },
  { key: 'digest', label: 'Digest', color: '#14b8a6' },
  { key: 'scanStatus', label: 'ScanStatus', color: '#22c55e' },
  { key: 'pushedAt', label: 'PushedAt', color: '#8b5cf6' },
  { key: 'sizeMB', label: 'SizeMB', color: '#f59e0b' },
  { key: 'lastPull', label: 'LastPull', color: '#06b6d4' }
]

function getRepoCellValue(repo: EcrRepositorySummary, key: RepoColumnKey): string {
  switch (key) {
    case 'repositoryName': return repo.repositoryName
    case 'repositoryUri': return repo.repositoryUri
    case 'imageTagMutability': return repo.imageTagMutability
    case 'createdAt': return formatTs(repo.createdAt)
  }
}

function getImageCellValue(img: EcrImageSummary, key: ImageColumnKey): string {
  switch (key) {
    case 'imageTag': return img.imageTags.length ? img.imageTags.join(', ') : 'untagged'
    case 'digest': return img.imageDigest.slice(0, 19)
    case 'scanStatus': return img.scanStatus
    case 'pushedAt': return formatTs(img.pushedAt)
    case 'sizeMB': return formatMB(img.sizeBytes)
    case 'lastPull': return formatTs(img.lastPull)
  }
}

/* ── Create Repo Dialog ───────────────────────────────────── */

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
        <h3>Create Repository</h3>
        <label className="ecr-dialog-field">
          <span>Repository Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" />
        </label>
        <label className="ecr-dialog-field">
          <span>Tag Mutability</span>
          <select value={mutability} onChange={(e) => setMutability(e.target.value)}>
            <option value="MUTABLE">MUTABLE</option>
            <option value="IMMUTABLE">IMMUTABLE</option>
          </select>
        </label>
        <label className="ecr-dialog-field ecr-dialog-checkbox">
          <input type="checkbox" checked={scanOnPush} onChange={(e) => setScanOnPush(e.target.checked)} />
          <span>Scan on push</span>
        </label>
        <div className="ecr-dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="ecr-action-btn create" disabled={!name.trim()} onClick={() => onCreate(name.trim(), mutability, scanOnPush)}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Scan Findings Dialog ─────────────────────────────────── */

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
        <h3>Scan Findings</h3>
        {loading && <div className="ecr-empty">Loading scan findings...</div>}
        {!loading && !scanResult && <div className="ecr-empty">No scan results available.</div>}
        {!loading && scanResult && (
          <>
            <div style={{ display: 'flex', gap: 20, fontSize: 12, marginBottom: 10 }}>
              <span>Status: <strong>{scanResult.scanStatus}</strong></span>
              <span>Completed: {formatTs(scanResult.scanCompletedAt)}</span>
            </div>
            {Object.keys(scanResult.findingCounts).length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {Object.entries(scanResult.findingCounts).map(([severity, count]) => (
                  <span key={severity} className={`ecr-severity ${severity}`}>
                    {severity}: {count}
                  </span>
                ))}
              </div>
            )}
            {scanResult.findings.length > 0 && (
              <div className="ecr-findings-list">
                {scanResult.findings.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="ecr-finding-row">
                    <span className={`ecr-severity ${f.severity}`}>{f.severity}</span>
                    <strong>{f.name}</strong>
                    <span style={{ color: '#9ca7b7' }}>{f.package} {f.packageVersion !== '-' ? f.packageVersion : ''}</span>
                    <span className="ecr-finding-desc">{f.description}</span>
                  </div>
                ))}
              </div>
            )}
            {scanResult.findings.length === 0 && scanResult.scanStatus === 'COMPLETE' && (
              <div className="ecr-empty">No vulnerabilities found.</div>
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

/* ── Main ECR Console ─────────────────────────────────────── */

export function EcrConsole({ connection }: { connection: AwsConnection }) {
  /* ── Repository state ──────────────────────────────────── */
  const [repos, setRepos] = useState<EcrRepositorySummary[]>([])
  const [selectedRepoName, setSelectedRepoName] = useState('')
  const [repoFilter, setRepoFilter] = useState('')
  const [repoColumns, setRepoColumns] = useState<Set<RepoColumnKey>>(
    () => new Set(REPO_COLUMNS.map((c) => c.key))
  )

  /* ── Image state ───────────────────────────────────────── */
  const [images, setImages] = useState<EcrImageSummary[]>([])
  const [selectedImageDigest, setSelectedImageDigest] = useState('')
  const [imageFilter, setImageFilter] = useState('')
  const [imageColumns, setImageColumns] = useState<Set<ImageColumnKey>>(
    () => new Set(IMAGE_COLUMNS.map((c) => c.key))
  )

  /* ── Docker / actions state ────────────────────────────── */
  const [localImage, setLocalImage] = useState('')
  const [targetTag, setTargetTag] = useState('latest')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [scanResult, setScanResult] = useState<EcrScanResult | null>(null)
  const [scanLoading, setScanLoading] = useState(false)
  const [showFindings, setShowFindings] = useState(false)

  /* ── Derived ───────────────────────────────────────────── */
  const selectedRepo = useMemo(
    () => repos.find((r) => r.repositoryName === selectedRepoName) ?? null,
    [repos, selectedRepoName]
  )

  const selectedImage = useMemo(
    () => images.find((img) => img.imageDigest === selectedImageDigest) ?? null,
    [images, selectedImageDigest]
  )

  const visibleRepoCols = REPO_COLUMNS.filter((c) => repoColumns.has(c.key))
  const visibleImageCols = IMAGE_COLUMNS.filter((c) => imageColumns.has(c.key))

  const filteredRepos = useMemo(() => {
    if (!repoFilter) return repos
    const q = repoFilter.toLowerCase()
    return repos.filter((r) =>
      visibleRepoCols.some((col) => getRepoCellValue(r, col.key).toLowerCase().includes(q))
    )
  }, [repos, repoFilter, visibleRepoCols])

  const filteredImages = useMemo(() => {
    if (!imageFilter) return images
    const q = imageFilter.toLowerCase()
    return images.filter((img) =>
      visibleImageCols.some((col) => getImageCellValue(img, col.key).toLowerCase().includes(q))
    )
  }, [images, imageFilter, visibleImageCols])

  /* ── Load data ─────────────────────────────────────────── */
  useEffect(() => {
    void loadRepos()
}, [connection.sessionId, connection.region])

  async function loadRepos() {
    setError('')
    try {
      const repoList = await listEcrRepositories(connection)
      setRepos(repoList)
      if (repoList.length && !selectedRepoName) {
        await selectRepo(repoList[0].repositoryName)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function selectRepo(name: string) {
    setSelectedRepoName(name)
    setSelectedImageDigest('')
    setScanResult(null)
    setError('')
    try {
      const imgs = await listEcrImages(connection, name)
      setImages(imgs)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Repo actions ──────────────────────────────────────── */
  async function handleCreateRepo(name: string, mutability: string, scanOnPush: boolean) {
    setShowCreateDialog(false)
    setError('')
    try {
      await createEcrRepository(connection, name, mutability, scanOnPush)
      setMsg(`Repository ${name} created`)
      const repoList = await listEcrRepositories(connection)
      setRepos(repoList)
      await selectRepo(name)
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
      const repoList = await listEcrRepositories(connection)
      setRepos(repoList)
      setImages([])
      setSelectedImageDigest('')
      if (repoList.length) await selectRepo(repoList[0].repositoryName)
      else setSelectedRepoName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Image actions ─────────────────────────────────────── */
  async function handleDeleteImage() {
    if (!selectedRepoName || !selectedImageDigest) return
    setError('')
    try {
      await deleteEcrImage(connection, selectedRepoName, selectedImageDigest)
      setMsg('Image deleted')
      const imgs = await listEcrImages(connection, selectedRepoName)
      setImages(imgs)
      setSelectedImageDigest('')
      setScanResult(null)
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

  /* ── Docker actions ────────────────────────────────────── */
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
      const imgs = await listEcrImages(connection, selectedRepoName)
      setImages(imgs)
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

  /* ── Render ────────────────────────────────────────────── */
  return (
    <div className="ecr-console">
      {error && <div className="ecr-error">{error}</div>}
      {msg && (
        <div className="ecr-msg">
          {msg}
          <button type="button" className="ecr-msg-dismiss" onClick={() => setMsg('')}>x</button>
        </div>
      )}

      {showCreateDialog && (
        <CreateRepoDialog
          onClose={() => setShowCreateDialog(false)}
          onCreate={(n, m, s) => void handleCreateRepo(n, m, s)}
        />
      )}

      {showFindings && (
        <ScanFindingsDialog
          scanResult={scanResult}
          loading={scanLoading}
          onClose={() => setShowFindings(false)}
        />
      )}

      <div className="ecr-split">
        {/* ── Left Panel: Repositories ────────────────────── */}
        <div className="ecr-panel">
          <input
            className="ecr-search-input"
            placeholder="Filter rows across selected columns..."
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
          />
          <div className="ecr-column-chips">
            {REPO_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`ecr-chip ${repoColumns.has(col.key) ? 'active' : ''}`}
                type="button"
                style={repoColumns.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                onClick={() => toggleRepoCol(col.key)}
              >
                {col.label}
              </button>
            ))}
          </div>

          <div className="ecr-table-area">
            <table className="ecr-data-table">
              <thead>
                <tr>
                  {visibleRepoCols.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRepos.map((repo) => (
                  <tr
                    key={repo.repositoryName}
                    className={repo.repositoryName === selectedRepoName ? 'active' : ''}
                    onClick={() => void selectRepo(repo.repositoryName)}
                  >
                    {visibleRepoCols.map((col) => (
                      <td key={col.key}>{getRepoCellValue(repo, col.key)}</td>
                    ))}
                  </tr>
                ))}
                {filteredRepos.length === 0 && (
                  <tr><td colSpan={visibleRepoCols.length} className="ecr-empty">No repositories</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="ecr-panel-footer">
            <button type="button" className="ecr-action-btn create" onClick={() => setShowCreateDialog(true)}>
              Create Repo
            </button>
            <ConfirmButton
              type="button"
              className="ecr-action-btn delete"
              disabled={!selectedRepoName}
              confirmLabel="Confirm Delete?"
              onConfirm={() => void handleDeleteRepo()}
            >
              Delete Repo
            </ConfirmButton>
          </div>
        </div>

        {/* ── Right Panel: Images ─────────────────────────── */}
        <div className="ecr-panel">
          <input
            className="ecr-search-input"
            placeholder="Filter rows across selected columns..."
            value={imageFilter}
            onChange={(e) => setImageFilter(e.target.value)}
          />
          <div className="ecr-column-chips">
            {IMAGE_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`ecr-chip ${imageColumns.has(col.key) ? 'active' : ''}`}
                type="button"
                style={imageColumns.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                onClick={() => toggleImageCol(col.key)}
              >
                {col.label}
              </button>
            ))}
          </div>

          <div className="ecr-table-area">
            <table className="ecr-data-table">
              <thead>
                <tr>
                  {visibleImageCols.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredImages.map((img) => (
                  <tr
                    key={img.imageDigest}
                    className={img.imageDigest === selectedImageDigest ? 'active' : ''}
                    onClick={() => {
                      setSelectedImageDigest(img.imageDigest)
                      setScanResult(null)
                    }}
                  >
                    {visibleImageCols.map((col) => (
                      <td key={col.key}>{getImageCellValue(img, col.key)}</td>
                    ))}
                  </tr>
                ))}
                {filteredImages.length === 0 && (
                  <tr><td colSpan={visibleImageCols.length} className="ecr-empty">No images</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Image action buttons */}
          <div className="ecr-panel-footer">
            <button
              type="button"
              className="ecr-action-btn scan"
              disabled={!selectedImageDigest}
              onClick={() => void handleStartScan()}
            >
              Scan This Image
            </button>
            <button
              type="button"
              className="ecr-action-btn"
              disabled={!selectedImageDigest}
              onClick={() => void handleShowFindings()}
            >
              See Scan Details
            </button>
            <ConfirmButton
              type="button"
              className="ecr-action-btn delete"
              disabled={!selectedImageDigest}
              confirmLabel="Confirm Delete?"
              onConfirm={() => void handleDeleteImage()}
            >
              Delete Image
            </ConfirmButton>
          </div>

          {/* Docker / ECR Actions */}
          <div className="ecr-docker-section">
            <div className="ecr-docker-title">Docker / ECR Actions</div>

            <div className="ecr-docker-row">
              <label className="ecr-docker-label">Local image</label>
              <input
                className="ecr-docker-input"
                value={localImage}
                onChange={(e) => setLocalImage(e.target.value)}
                placeholder=""
              />
              <button type="button" className="ecr-action-btn login" onClick={() => void handleDockerLogin()}>
                Docker Login
              </button>
            </div>

            <div className="ecr-docker-row">
              <label className="ecr-docker-label">Target tag</label>
              <input
                className="ecr-docker-input"
                value={targetTag}
                onChange={(e) => setTargetTag(e.target.value)}
                placeholder="latest"
              />
              <button
                type="button"
                className="ecr-action-btn pull"
                disabled={!selectedRepo || !selectedImage}
                onClick={() => void handlePullSelected()}
              >
                Pull Selected
              </button>
            </div>

            <div className="ecr-docker-row ecr-docker-row-end">
              <button
                type="button"
                className="ecr-action-btn push"
                disabled={!selectedRepo || !localImage.trim()}
                onClick={() => void handlePushLocal()}
              >
                Push Local
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
