import { useEffect, useRef, useState } from 'react'
import './s3.css'

import type { AwsConnection, S3BucketSummary, S3ObjectSummary } from '@shared/types'
import {
  createS3Bucket,
  createS3Folder,
  deleteS3Object,
  downloadS3ObjectTo,
  getS3ObjectContent,
  getS3PresignedUrl,
  listS3Buckets,
  listS3Objects,
  openS3InVSCode,
  openS3Object,
  putS3ObjectContent,
  uploadS3Object
} from './api'
import { ConfirmButton } from './ConfirmButton'

/* ── Helpers ─────────────────────────────────────────────── */

const TEXT_EXTENSIONS = new Set([
  'txt', 'json', 'xml', 'csv', 'yaml', 'yml', 'md', 'html', 'htm', 'css', 'js', 'ts',
  'jsx', 'tsx', 'py', 'rb', 'sh', 'bash', 'env', 'conf', 'cfg', 'ini', 'toml', 'log',
  'sql', 'graphql', 'svg', 'tf', 'tfvars', 'tfstate', 'hcl', 'dockerfile', 'makefile', 'gitignore'
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])

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

function displayName(key: string, prefix: string): string {
  const relative = key.startsWith(prefix) ? key.slice(prefix.length) : key
  return relative.replace(/\/$/, '') || key
}

function resolveBucketConnection(
  connection: AwsConnection,
  buckets: S3BucketSummary[],
  bucketName: string
): AwsConnection {
  const bucket = buckets.find((entry) => entry.name === bucketName)
  if (!bucket?.region) {
    return connection
  }

  return {
    ...connection,
    region: bucket.region
  }
}

function resolveBucketConnectionFromList(
  connection: AwsConnection,
  bucketList: S3BucketSummary[],
  bucketName: string
): AwsConnection {
  return resolveBucketConnection(connection, bucketList, bucketName)
}

/* ── Column definitions for objects table ─────────────────── */

type ColKey = 'name' | 'type' | 'key' | 'size' | 'modified' | 'storageClass'

const OBJ_COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'type', label: 'Type', color: '#8b5cf6' },
  { key: 'key', label: 'Key', color: '#14b8a6' },
  { key: 'size', label: 'Size', color: '#f59e0b' },
  { key: 'modified', label: 'Modified', color: '#06b6d4' },
  { key: 'storageClass', label: 'StorageClass', color: '#a855f7' },
]

function getColValue(obj: S3ObjectSummary, col: ColKey, prefix: string): string {
  switch (col) {
    case 'name': return displayName(obj.key, prefix)
    case 'type': return obj.isFolder ? 'Folder' : getExtension(obj.key).toUpperCase() || 'File'
    case 'key': return obj.key
    case 'size': return obj.isFolder ? '-' : formatSize(obj.size)
    case 'modified': return obj.lastModified !== '-' ? new Date(obj.lastModified).toLocaleString() : '-'
    case 'storageClass': return obj.isFolder ? '-' : obj.storageClass
  }
}

/* ── Column definitions for bucket list ──────────────────── */

type BucketColKey = 'name' | 'created' | 'public'

const BUCKET_COLUMNS: { key: BucketColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'created', label: 'Created', color: '#14b8a6' },
  { key: 'public', label: 'Public', color: '#8b5cf6' },
]

function getBucketColValue(b: S3BucketSummary, col: BucketColKey): string {
  switch (col) {
    case 'name': return b.name
    case 'created': return b.creationDate !== '-' ? new Date(b.creationDate).toLocaleString() : '-'
    case 'public': return '-'
  }
}

/* ══════════════════════════════════════════════════════════ */

export function S3Console({ connection }: { connection: AwsConnection }) {
  /* ── Bucket state ────────────────────────────────────── */
  const [buckets, setBuckets] = useState<S3BucketSummary[]>([])
  const [selectedBucket, setSelectedBucket] = useState('')
  const [bucketFilter, setBucketFilter] = useState('')
  const [visibleBucketCols, setVisibleBucketCols] = useState<Set<BucketColKey>>(new Set(['name', 'created', 'public']))
  const [newBucketName, setNewBucketName] = useState('')
  const [showCreateBucket, setShowCreateBucket] = useState(false)

  /* ── Object browser state ────────────────────────────── */
  const [objects, setObjects] = useState<S3ObjectSummary[]>([])
  const [prefix, setPrefix] = useState('')
  const [objectFilter, setObjectFilter] = useState('')
  const [visibleObjCols, setVisibleObjCols] = useState<Set<ColKey>>(new Set(['name', 'type', 'key', 'size', 'modified', 'storageClass']))
  const [selectedKey, setSelectedKey] = useState('')

  /* ── UI state ────────────────────────────────────────── */
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  /* ── Preview / edit state ────────────────────────────── */
  const [previewContent, setPreviewContent] = useState('')
  const [previewContentType, setPreviewContentType] = useState('')
  const [previewUrl, setPreviewUrl] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)

  /* ── New folder state ────────────────────────────────── */
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)

  /* ── Load buckets ──────────────────────────────────── */
  async function loadBuckets(selectBucket?: string) {
    setLoading(true)
    setError('')
    try {
      const list = await listS3Buckets(connection)
      setBuckets(list)
      const target = selectBucket ?? (selectedBucket || list[0]?.name || '')
      if (target) {
        setSelectedBucket(target)
        setPrefix('')
        setSelectedKey('')
        closePreview()
        setObjects(await listS3Objects(resolveBucketConnectionFromList(connection, list, target), target, ''))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function browseBucket(name: string, newPrefix = '') {
    setSelectedBucket(name)
    setPrefix(newPrefix)
    setSelectedKey('')
    closePreview()
    try {
      setObjects(await listS3Objects(resolveBucketConnection(connection, buckets, name), name, newPrefix))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function reloadBrowserView(bucketName = selectedBucket, nextPrefix = prefix) {
    setLoading(true)
    setError('')
    try {
      const list = await listS3Buckets(connection)
      setBuckets(list)

      const targetBucket = bucketName || list[0]?.name || ''
      if (!targetBucket) {
        setSelectedBucket('')
        setPrefix('')
        setSelectedKey('')
        closePreview()
        setObjects([])
        return
      }

      setSelectedBucket(targetBucket)
      setPrefix(nextPrefix)
      setSelectedKey('')
      closePreview()
      setObjects(await listS3Objects(resolveBucketConnectionFromList(connection, list, targetBucket), targetBucket, nextPrefix))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function navigate(newPrefix: string) {
    setPrefix(newPrefix)
    setSelectedKey('')
    closePreview()
    try {
      setObjects(await listS3Objects(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, newPrefix))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function goUp() {
    if (!prefix) return
    const parts = prefix.replace(/\/$/, '').split('/')
    parts.pop()
    const newPrefix = parts.length ? parts.join('/') + '/' : ''
    void navigate(newPrefix)
  }

useEffect(() => { void loadBuckets() }, [connection.sessionId, connection.region])

  useEffect(() => {
    async function handleWindowFocus() {
      if (!selectedBucket) return

      const previewKey = showPreview && !editing ? selectedKey : ''
      const currentBucket = selectedBucket
      const currentPrefix = prefix

      await reloadBrowserView(currentBucket, currentPrefix)

      if (previewKey) {
        setSelectedKey(previewKey)
        await doPreview(previewKey)
      }
    }

    const onFocus = () => { void handleWindowFocus() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
}, [selectedBucket, prefix, selectedKey, showPreview, editing, connection.sessionId, connection.region, buckets])

  /* ── Object actions ──────────────────────────────────── */
  async function doDownload() {
    if (!selectedKey || !selectedBucket) return
    try {
      const path = await downloadS3ObjectTo(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
      if (path) setMsg(`Downloaded to ${path}`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doOpenPreview() {
    if (!selectedKey || !selectedBucket) return
    try {
      await openS3Object(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doPresignedUrl() {
    if (!selectedKey || !selectedBucket) return
    try {
      const url = await getS3PresignedUrl(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
      await navigator.clipboard.writeText(url)
      setMsg('Pre-signed URL copied to clipboard')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDelete() {
    if (!selectedKey || !selectedBucket) return
    try {
      const bucketConnection = resolveBucketConnection(connection, buckets, selectedBucket)
      await deleteS3Object(bucketConnection, selectedBucket, selectedKey)
      setMsg(`Deleted ${selectedKey}`)
      await reloadBrowserView(selectedBucket, prefix)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doUpload(file: File) {
    if (!selectedBucket) return
    try {
      // Write to temp via FileReader, then pass path
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      // We need to save locally first - use put content for text, or use a data approach
      const key = prefix + file.name
      const text = new TextDecoder().decode(bytes)
      const bucketConnection = resolveBucketConnection(connection, buckets, selectedBucket)
      await putS3ObjectContent(bucketConnection, selectedBucket, key, text, file.type || undefined)
      setMsg(`Uploaded ${file.name}`)
      await reloadBrowserView(selectedBucket, prefix)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doCreateFolder() {
    if (!selectedBucket || !newFolderName) return
    try {
      const bucketConnection = resolveBucketConnection(connection, buckets, selectedBucket)
      await createS3Folder(bucketConnection, selectedBucket, prefix + newFolderName)
      setMsg(`Folder "${newFolderName}" created`)
      setNewFolderName('')
      setShowNewFolder(false)
      await reloadBrowserView(selectedBucket, prefix)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doCreateBucket() {
    if (!newBucketName) return
    try {
      await createS3Bucket(connection, newBucketName)
      setMsg(`Bucket "${newBucketName}" created`)
      setNewBucketName('')
      setShowCreateBucket(false)
      await reloadBrowserView(newBucketName, '')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /* ── Preview / Edit ──────────────────────────────────── */
  async function doPreview(key: string) {
    if (!selectedBucket) return
    setShowPreview(true)
    setEditing(false)
    setPreviewContent('')
    setPreviewUrl('')

    if (isImageFile(key)) {
      try {
        const url = await getS3PresignedUrl(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, key)
        setPreviewUrl(url)
        setPreviewContentType('image')
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    } else if (isTextFile(key)) {
      try {
        const result = await getS3ObjectContent(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, key)
        setPreviewContent(result.body)
        setPreviewContentType(result.contentType)
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    } else {
      setPreviewContent('Preview not available for this file type.')
      setPreviewContentType('unsupported')
    }
  }

  function startEdit() {
    setEditing(true)
    setEditContent(previewContent)
  }

  async function saveEdit() {
    if (!selectedBucket || !selectedKey) return
    setSaving(true)
    try {
      const bucketName = selectedBucket
      const key = selectedKey
      await putS3ObjectContent(resolveBucketConnection(connection, buckets, bucketName), bucketName, key, editContent, previewContentType)
      setMsg(`Saved ${key}`)
      setEditing(false)
      await reloadBrowserView(bucketName, prefix)
      setSelectedKey(key)
      await doPreview(key)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  async function doEditInVSCode() {
    if (!selectedBucket || !selectedKey) return
    try {
      await openS3InVSCode(resolveBucketConnection(connection, buckets, selectedBucket), selectedBucket, selectedKey)
      setMsg('Opened in VS Code')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  function closePreview() {
    setShowPreview(false)
    setEditing(false)
    setPreviewContent('')
    setPreviewUrl('')
  }

  /* ── Filtering ─────────────────────────────────────── */
  const filteredBuckets = buckets.filter(b => {
    if (!bucketFilter) return true
    const search = bucketFilter.toLowerCase()
    return BUCKET_COLUMNS.some(col => getBucketColValue(b, col.key).toLowerCase().includes(search))
  })

  const activeBucketCols = BUCKET_COLUMNS.filter(c => visibleBucketCols.has(c.key))

  const filteredObjects = objects.filter(o => {
    if (!objectFilter) return true
    const search = objectFilter.toLowerCase()
    return OBJ_COLUMNS.some(col => getColValue(o, col.key, prefix).toLowerCase().includes(search))
  })

  const activeObjCols = OBJ_COLUMNS.filter(c => visibleObjCols.has(c.key))

  const selectedObj = objects.find(o => o.key === selectedKey) ?? null

  if (loading && buckets.length === 0) return <div className="s3-empty">Loading S3 data...</div>

  return (
    <div className="s3-console">
      {error && <div className="s3-msg s3-msg-error">{error}<button type="button" className="s3-msg-close" onClick={() => setError('')}>x</button></div>}
      {msg && <div className="s3-msg s3-msg-ok">{msg}<button type="button" className="s3-msg-close" onClick={() => setMsg('')}>x</button></div>}

      <div className="s3-layout">
        {/* ── Left: Bucket list ───────────────────────── */}
        <div className="s3-bucket-panel">
          <input
            className="s3-filter-input"
            placeholder="Filter rows across selected columns..."
            value={bucketFilter}
            onChange={e => setBucketFilter(e.target.value)}
          />
          <div className="s3-column-chips">
            {BUCKET_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`s3-chip ${visibleBucketCols.has(col.key) ? 'active' : ''}`}
                type="button"
                style={visibleBucketCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                onClick={() => setVisibleBucketCols(prev => {
                  const n = new Set(prev); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n
                })}
              >{col.label}</button>
            ))}
          </div>
          <div className="s3-bucket-table-wrap">
            <table className="s3-bucket-table">
              <thead><tr>{activeBucketCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {filteredBuckets.map(b => (
                  <tr
                    key={b.name}
                    className={b.name === selectedBucket ? 'active' : ''}
                    onClick={() => void browseBucket(b.name)}
                  >
                    {activeBucketCols.map(c => <td key={c.key}>{getBucketColValue(b, c.key)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Create Bucket */}
          {showCreateBucket ? (
            <div className="s3-inline-form">
              <input placeholder="bucket-name" value={newBucketName} onChange={e => setNewBucketName(e.target.value)} />
              <button className="s3-btn s3-btn-ok" type="button" onClick={() => void doCreateBucket()}>Create</button>
              <button className="s3-btn" type="button" onClick={() => setShowCreateBucket(false)}>Cancel</button>
            </div>
          ) : (
            <button className="s3-btn s3-btn-create-bucket" type="button" onClick={() => setShowCreateBucket(true)}>Create Bucket</button>
          )}
        </div>

        {/* ── Right: File browser ─────────────────────── */}
        <div className="s3-browser-panel">
          {/* Path bar */}
          <div className="s3-path-bar">
            <span className="s3-path-label">Bucket: {selectedBucket}  Path: /{prefix}</span>
            <div className="s3-path-actions">
              <button className="s3-btn" type="button" onClick={goUp} disabled={!prefix}>Up</button>
              <button className="s3-btn" type="button" onClick={() => void doOpenPreview()} disabled={!selectedKey || !!selectedObj?.isFolder}>Open / Preview</button>
            </div>
          </div>

          {/* Filter + chips */}
          <input
            className="s3-filter-input"
            placeholder="Filter rows across selected columns..."
            value={objectFilter}
            onChange={e => setObjectFilter(e.target.value)}
          />
          <div className="s3-column-chips">
            {OBJ_COLUMNS.map(col => (
              <button
                key={col.key}
                className={`s3-chip ${visibleObjCols.has(col.key) ? 'active' : ''}`}
                type="button"
                style={visibleObjCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                onClick={() => setVisibleObjCols(prev => {
                  const n = new Set(prev); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n
                })}
              >{col.label}</button>
            ))}
          </div>

          {/* Objects table */}
          <div className="s3-object-table-wrap">
            <table className="s3-object-table">
              <thead><tr>{activeObjCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {filteredObjects.map(obj => (
                  <tr
                    key={obj.key}
                    className={obj.key === selectedKey ? 'active' : ''}
                    onClick={() => {
                      if (obj.isFolder) {
                        void navigate(obj.key)
                      } else {
                        setSelectedKey(obj.key)
                        void doPreview(obj.key)
                      }
                    }}
                  >
                    {activeObjCols.map(c => (
                      <td key={c.key}>
                        {c.key === 'name' && obj.isFolder && <span className="s3-folder-icon">&#128193; </span>}
                        {getColValue(obj, c.key, prefix)}
                      </td>
                    ))}
                  </tr>
                ))}
                {filteredObjects.length === 0 && (
                  <tr><td colSpan={activeObjCols.length} className="s3-empty">
                    {objects.length === 0 ? 'Empty folder.' : 'No objects match filter.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Preview panel */}
          {showPreview && selectedKey && (
            <div className="s3-preview-panel">
              <div className="s3-preview-header">
                <span className="s3-preview-title">{selectedKey.split('/').pop()}</span>
                <div className="s3-preview-actions">
                  {isTextFile(selectedKey) && !editing && (
                    <>
                      <button className="s3-btn s3-btn-edit" type="button" onClick={startEdit}>Edit</button>
                      <button className="s3-btn" type="button" onClick={() => void doEditInVSCode()}>Edit in VS Code</button>
                    </>
                  )}
                  {editing && (
                    <>
                      <button className="s3-btn s3-btn-ok" type="button" onClick={() => void saveEdit()} disabled={saving}>
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button className="s3-btn" type="button" onClick={() => setEditing(false)}>Cancel</button>
                    </>
                  )}
                  <button className="s3-btn" type="button" onClick={closePreview}>Close</button>
                </div>
              </div>
              <div className="s3-preview-body">
                {previewUrl && previewContentType === 'image' && (
                  <img src={previewUrl} alt={selectedKey} className="s3-preview-image" />
                )}
                {!previewUrl && !editing && previewContent && (
                  <pre className="s3-preview-text">{previewContent}</pre>
                )}
                {editing && (
                  <textarea
                    className="s3-edit-area"
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                  />
                )}
                {!previewUrl && !previewContent && !editing && (
                  <div className="s3-empty">Loading preview...</div>
                )}
              </div>
            </div>
          )}

          {/* Bottom action bar */}
          <div className="s3-action-bar">
            {showNewFolder ? (
              <div className="s3-inline-form">
                <input placeholder="folder name" value={newFolderName} onChange={e => setNewFolderName(e.target.value)} />
                <button className="s3-btn s3-btn-ok" type="button" onClick={() => void doCreateFolder()}>Create</button>
                <button className="s3-btn" type="button" onClick={() => { setShowNewFolder(false); setNewFolderName('') }}>Cancel</button>
              </div>
            ) : (
              <button className="s3-btn" type="button" onClick={() => setShowNewFolder(true)}>New Folder</button>
            )}
            <button className="s3-btn s3-btn-upload" type="button" onClick={() => fileInputRef.current?.click()}>Upload</button>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={e => {
              const file = e.target.files?.[0]
              if (file) void doUpload(file)
              e.target.value = ''
            }} />
            <button className="s3-btn" type="button" onClick={() => void doDownload()} disabled={!selectedKey || !!selectedObj?.isFolder}>Download</button>
            <button className="s3-btn" type="button" onClick={() => void doPresignedUrl()} disabled={!selectedKey || !!selectedObj?.isFolder}>Pre-Signed URL</button>
            <ConfirmButton className="s3-btn s3-btn-danger" type="button" onConfirm={() => void doDelete()} disabled={!selectedKey} confirmLabel="Confirm Delete?">Delete</ConfirmButton>
          </div>
        </div>
      </div>
    </div>
  )
}
