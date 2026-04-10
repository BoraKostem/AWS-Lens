import { useEffect, useMemo, useState } from 'react'
import type {
  GcpFirestoreDatabaseSummary,
  GcpFirestoreCollectionSummary,
  GcpFirestoreDocumentSummary,
  GcpFirestoreDocumentDetail
} from '@shared/types'
import {
  listGcpFirestoreDatabases,
  listGcpFirestoreCollections,
  listGcpFirestoreDocuments,
  getGcpFirestoreDocumentDetail
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Helpers ──────────────────────────────────────────────── */

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  const match = error.match(/"([^"]+)"/) ?? error.match(/[\u201c\u201d]([^\u201c\u201d]+)[\u201c\u201d]/)
  return { command: match?.[1]?.trim() ?? fallbackCommand, summary }
}

function formatDateTime(value: string | undefined): string {
  if (!value || value === '-') return '-'
  try { return new Date(value).toLocaleString() } catch { return value }
}

function trunc(s: string, n = 48): string {
  if (!s) return '-'
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s
}

function typeBadgeClass(dbType: string): string {
  if (dbType === 'FIRESTORE_NATIVE') return 'status-badge status-ok'
  if (dbType === 'DATASTORE_MODE') return 'status-badge status-warn'
  return 'status-badge'
}

function typeLabel(dbType: string): string {
  if (dbType === 'FIRESTORE_NATIVE') return 'Native'
  if (dbType === 'DATASTORE_MODE') return 'Datastore'
  return dbType
}

function DetailRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="table-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0' }}>
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  fontSize: '0.78rem', padding: '0.3rem 0.5rem', borderRadius: 8,
  border: '1px solid rgba(145,176,207,0.18)', background: 'rgba(0,0,0,0.15)', color: 'inherit'
}

const sectionBorder: React.CSSProperties = {
  padding: '0.75rem 1rem', borderBottom: '1px solid rgba(145,176,207,0.12)'
}

/* ── Component ────────────────────────────────────────────── */

export function GcpFirestoreConsole({
  projectId, location, refreshNonce, onRunTerminalCommand, canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  /* ── State ─────────────────────────────────────────────── */
  const [databases, setDatabases] = useState<GcpFirestoreDatabaseSummary[]>([])
  const [databasesLoading, setDatabasesLoading] = useState(true)
  const [databasesError, setDatabasesError] = useState('')
  const [selectedDatabaseId, setSelectedDatabaseId] = useState('')

  const [collections, setCollections] = useState<GcpFirestoreCollectionSummary[]>([])
  const [collectionsLoading, setCollectionsLoading] = useState(false)
  const [collectionsError, setCollectionsError] = useState('')
  const [selectedCollectionId, setSelectedCollectionId] = useState('')

  const [documents, setDocuments] = useState<GcpFirestoreDocumentSummary[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [documentsError, setDocumentsError] = useState('')
  const [selectedDocumentId, setSelectedDocumentId] = useState('')

  const [documentDetail, setDocumentDetail] = useState<GcpFirestoreDocumentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [collectionFilter, setCollectionFilter] = useState('')
  const [documentFilter, setDocumentFilter] = useState('')

  /* ── Derived values ────────────────────────────────────── */
  const locationLabel = location.trim() || 'global'

  const databaseTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const db of databases) counts[db.type] = (counts[db.type] || 0) + 1
    return counts
  }, [databases])

  const filteredCollections = useMemo(() => {
    if (!collectionFilter.trim()) return collections
    const q = collectionFilter.trim().toLowerCase()
    return collections.filter((c) => c.collectionId.toLowerCase().includes(q))
  }, [collections, collectionFilter])

  const filteredDocuments = useMemo(() => {
    if (!documentFilter.trim()) return documents
    const q = documentFilter.trim().toLowerCase()
    return documents.filter((d) => d.documentId.toLowerCase().includes(q))
  }, [documents, documentFilter])

  const enableAction = databasesError
    ? getGcpApiEnableAction(
        databasesError,
        `gcloud services enable firestore.googleapis.com --project ${projectId}`,
        `Firestore API is disabled for project ${projectId}.`
      )
    : null

  /* ── Data fetching: databases ──────────────────────────── */
  useEffect(() => {
    let cancelled = false
    setDatabasesLoading(true)
    setDatabasesError('')
    listGcpFirestoreDatabases(projectId)
      .then((data) => {
        if (cancelled) return
        setDatabases(data)
        if (data.length > 0) {
          setSelectedDatabaseId(data[0].name.split('/').pop() || data[0].name)
        } else {
          setSelectedDatabaseId('')
          setCollections([])
          setDocuments([])
          setDocumentDetail(null)
        }
      })
      .catch((err) => {
        if (!cancelled) { setDatabasesError(normalizeError(err)); setDatabases([]) }
      })
      .finally(() => { if (!cancelled) setDatabasesLoading(false) })
    return () => { cancelled = true }
  }, [projectId, refreshNonce])

  /* ── Data fetching: collections ────────────────────────── */
  useEffect(() => {
    if (!selectedDatabaseId) {
      setCollections([]); setSelectedCollectionId('')
      setDocuments([]); setDocumentDetail(null)
      return
    }
    let cancelled = false
    setCollectionsLoading(true); setCollectionsError('')
    setSelectedCollectionId(''); setDocuments([]); setDocumentDetail(null)
    listGcpFirestoreCollections(projectId, selectedDatabaseId)
      .then((data) => {
        if (cancelled) return
        setCollections(data)
        if (data.length > 0) setSelectedCollectionId(data[0].collectionId)
      })
      .catch((err) => {
        if (!cancelled) { setCollectionsError(normalizeError(err)); setCollections([]) }
      })
      .finally(() => { if (!cancelled) setCollectionsLoading(false) })
    return () => { cancelled = true }
  }, [projectId, selectedDatabaseId])

  /* ── Data fetching: documents ──────────────────────────── */
  useEffect(() => {
    if (!selectedDatabaseId || !selectedCollectionId) {
      setDocuments([]); setSelectedDocumentId(''); setDocumentDetail(null)
      return
    }
    let cancelled = false
    setDocumentsLoading(true); setDocumentsError('')
    setSelectedDocumentId(''); setDocumentDetail(null)
    listGcpFirestoreDocuments(projectId, selectedDatabaseId, selectedCollectionId)
      .then((data) => { if (!cancelled) setDocuments(data) })
      .catch((err) => {
        if (!cancelled) { setDocumentsError(normalizeError(err)); setDocuments([]) }
      })
      .finally(() => { if (!cancelled) setDocumentsLoading(false) })
    return () => { cancelled = true }
  }, [projectId, selectedDatabaseId, selectedCollectionId])

  /* ── Data fetching: document detail ────────────────────── */
  useEffect(() => {
    if (!selectedDatabaseId || !selectedCollectionId || !selectedDocumentId) {
      setDocumentDetail(null); return
    }
    let cancelled = false
    setDetailLoading(true); setDetailError('')
    const documentPath = `${selectedCollectionId}/${selectedDocumentId}`
    getGcpFirestoreDocumentDetail(projectId, selectedDatabaseId, documentPath)
      .then((data) => { if (!cancelled) setDocumentDetail(data) })
      .catch((err) => {
        if (!cancelled) { setDetailError(normalizeError(err)); setDocumentDetail(null) }
      })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [projectId, selectedDatabaseId, selectedCollectionId, selectedDocumentId])

  /* ── Early loading state ───────────────────────────────── */
  if (databasesLoading && databases.length === 0 && !databasesError) {
    return <SvcState variant="loading" resourceName="Firestore databases" />
  }

  /* ── Render ────────────────────────────────────────────── */
  return (
    <div className="svc-console iam-console">
      {/* ── Error banner ─────────────────────────── */}
      {databasesError ? (
        <section className="panel stack">
          {enableAction ? (
            <div className="error-banner gcp-enable-error-banner">
              <div className="gcp-enable-error-copy">
                <strong>{enableAction.summary}</strong>
                <p>
                  {canRunTerminalCommand
                    ? 'Run the enable command in the terminal, wait for propagation, then refresh the inventory.'
                    : 'Switch Settings > Access Mode to Operator to enable terminal actions for this command.'}
                </p>
              </div>
              <div className="gcp-enable-error-actions">
                <button
                  type="button" className="accent" disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(enableAction.command)}
                  title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode to enable terminal actions'}
                >Enable API</button>
              </div>
            </div>
          ) : (
            <SvcState variant="error" error={databasesError} />
          )}
        </section>
      ) : null}

      {/* ── Hero section ─────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Document database posture</div>
          <h2>Firestore Operations</h2>
          <p>
            Database, collection, and document browser for the active GCP project.
            Inspect document fields, review collection structure, and explore the
            Firestore data model from a single surface.
          </p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill"><span>Project</span><strong>{trunc(projectId, 28)}</strong></div>
            <div className="iam-shell-meta-pill"><span>Location</span><strong>{locationLabel}</strong></div>
            <div className="iam-shell-meta-pill">
              <span>Selection</span>
              <strong>
                {selectedCollectionId
                  ? selectedDocumentId
                    ? `${trunc(selectedCollectionId, 16)}/${trunc(selectedDocumentId, 16)}`
                    : trunc(selectedCollectionId, 32)
                  : 'No selection'}
              </strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Databases</span>
            <strong>{databases.length}</strong>
            <small>{databasesLoading ? 'Refreshing live data now' : 'Databases in current project'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Database Types</span>
            <strong>
              {Object.entries(databaseTypeCounts).map(([type, count]) => (
                <span key={type} className={typeBadgeClass(type)} style={{ marginRight: 6, fontSize: '0.78rem' }}>
                  {typeLabel(type)} ({count})
                </span>
              ))}
              {databases.length === 0 && '-'}
            </strong>
            <small>Mode distribution across databases</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Collections</span>
            <strong>{collections.length}</strong>
            <small>{selectedDatabaseId ? `In database ${trunc(selectedDatabaseId, 20)}` : 'Select a database'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Documents</span>
            <strong>{documents.length}</strong>
            <small>{selectedCollectionId ? `In collection ${trunc(selectedCollectionId, 18)}` : 'Select a collection'}</small>
          </div>
        </div>
      </section>

      {databasesLoading && <SvcState variant="loading" resourceName="Firestore databases" compact />}

      {/* ── Three-panel browser ──────────────────── */}
      {!databasesLoading && !databasesError && (
        <section className="overview-surface" style={{ gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr 1fr', gap: '12px' }}>

            {/* ── Left panel: database picker + collections ── */}
            <div className="panel" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
              {/* Database picker (multi) */}
              {databases.length > 1 && (
                <div style={sectionBorder}>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: '#8fa3ba', marginBottom: 4 }}>Database</label>
                  <select
                    value={selectedDatabaseId}
                    onChange={(e) => setSelectedDatabaseId(e.target.value)}
                    style={{ ...inputStyle, width: '100%', padding: '0.35rem 0.5rem' }}
                  >
                    {databases.map((db) => {
                      const dbId = db.name.split('/').pop() || db.name
                      return <option key={dbId} value={dbId}>{dbId} ({typeLabel(db.type)})</option>
                    })}
                  </select>
                </div>
              )}
              {/* Database indicator (single) */}
              {databases.length === 1 && (
                <div style={sectionBorder}>
                  <label style={{ display: 'block', fontSize: '0.72rem', color: '#8fa3ba', marginBottom: 4 }}>Database</label>
                  <strong style={{ fontSize: '0.85rem' }}>{selectedDatabaseId}</strong>
                  <span className={typeBadgeClass(databases[0].type)} style={{ marginLeft: 8, fontSize: '0.72rem' }}>
                    {typeLabel(databases[0].type)}
                  </span>
                </div>
              )}

              <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '0.85rem' }}>Collections</h3>
              </div>
              <div style={{ padding: '0.4rem 0.75rem' }}>
                <input
                  type="text" placeholder="Filter collections..." value={collectionFilter}
                  onChange={(e) => setCollectionFilter(e.target.value)}
                  style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
                />
              </div>

              {collectionsLoading && <SvcState variant="loading" resourceName="collections" compact />}
              {collectionsError && !collectionsLoading && <SvcState variant="error" error={collectionsError} compact />}
              {!collectionsLoading && !collectionsError && filteredCollections.length === 0 && (
                <SvcState
                  variant={collectionFilter.trim() ? 'no-filter-matches' : 'empty'}
                  message={collectionFilter.trim() ? `No collections match "${collectionFilter.trim()}".` : 'No collections found in this database.'}
                  compact
                />
              )}
              {!collectionsLoading && !collectionsError && filteredCollections.length > 0 && (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {filteredCollections.map((col) => (
                    <button
                      key={col.collectionId} type="button"
                      className={`table-row overview-table-row ${selectedCollectionId === col.collectionId ? 'active' : ''}`}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '0.5rem 0.75rem', textAlign: 'left', cursor: 'pointer' }}
                      onClick={() => { setSelectedCollectionId(selectedCollectionId === col.collectionId ? '' : col.collectionId); setSelectedDocumentId(''); setDocumentDetail(null) }}
                    >
                      <span style={{ fontSize: '0.82rem' }} title={col.collectionId}>{trunc(col.collectionId, 22)}</span>
                      <span style={{ fontSize: '0.72rem', color: '#8fa3ba' }}>{col.documentCount} docs</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ── Middle panel: document list ──────────── */}
            <div className="panel" style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '0.85rem' }}>
                  {selectedCollectionId ? `Documents in ${trunc(selectedCollectionId, 20)}` : 'Documents'}
                </h3>
                {selectedCollectionId && (
                  <input
                    type="text" placeholder="Filter documents..." value={documentFilter}
                    onChange={(e) => setDocumentFilter(e.target.value)}
                    style={{ ...inputStyle, maxWidth: 180 }}
                  />
                )}
              </div>

              {!selectedCollectionId && <SvcState variant="empty" message="Select a collection to browse documents." compact />}
              {selectedCollectionId && documentsLoading && <SvcState variant="loading" resourceName="documents" compact />}
              {selectedCollectionId && documentsError && !documentsLoading && <SvcState variant="error" error={documentsError} compact />}

              {selectedCollectionId && !documentsLoading && !documentsError && (
                <>
                  <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 0.8fr', gap: '0.75rem' }}>
                    <div>Document ID</div>
                    <div>Updated At</div>
                    <div>Field Count</div>
                  </div>
                  {filteredDocuments.length === 0 ? (
                    <SvcState
                      variant={documentFilter.trim() ? 'no-filter-matches' : 'empty'}
                      message={documentFilter.trim() ? `No documents match "${documentFilter.trim()}".` : 'No documents found in this collection.'}
                      compact
                    />
                  ) : (
                    <div style={{ flex: 1, overflowY: 'auto' }}>
                      {filteredDocuments.map((doc) => (
                        <button
                          key={doc.documentId} type="button"
                          className={`table-row overview-table-row ${selectedDocumentId === doc.documentId ? 'active' : ''}`}
                          style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 0.8fr', gap: '0.75rem', width: '100%', textAlign: 'left', cursor: 'pointer' }}
                          onClick={() => setSelectedDocumentId(selectedDocumentId === doc.documentId ? '' : doc.documentId)}
                        >
                          <span title={doc.documentId} style={{ fontSize: '0.82rem' }}><strong>{trunc(doc.documentId, 28)}</strong></span>
                          <span style={{ fontSize: '0.78rem', color: '#98afc3' }}>{formatDateTime(doc.updateTime)}</span>
                          <span style={{ fontSize: '0.78rem', color: '#98afc3' }}>{doc.fieldCount}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── Right panel: document detail ────────── */}
            <div className="panel" style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div className="panel-header">
                <h3 style={{ margin: 0, fontSize: '0.85rem' }}>
                  {documentDetail ? `Document: ${trunc(documentDetail.documentId, 24)}` : 'Document Detail'}
                </h3>
              </div>

              {!selectedDocumentId && <SvcState variant="empty" message="Select a document to view its detail." compact />}
              {selectedDocumentId && detailLoading && <SvcState variant="loading" resourceName="document detail" compact />}
              {selectedDocumentId && detailError && !detailLoading && <SvcState variant="error" error={detailError} compact />}

              {documentDetail && !detailLoading && !detailError && (
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1rem' }}>
                  <h4 style={{ margin: '0 0 0.75rem', fontSize: '0.82rem' }}>Metadata</h4>
                  <DetailRow label="Document ID" value={documentDetail.documentId} />
                  <DetailRow label="Created" value={formatDateTime(documentDetail.createTime)} />
                  <DetailRow label="Updated" value={formatDateTime(documentDetail.updateTime)} />
                  <DetailRow label="Full Path" value={trunc(documentDetail.name, 40)} title={documentDetail.name} />

                  <h4 style={{ margin: '1.25rem 0 0.75rem', fontSize: '0.82rem' }}>Fields</h4>
                  {documentDetail.fields && Object.keys(documentDetail.fields).length > 0 ? (
                    <pre style={{
                      background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(145,176,207,0.12)',
                      borderRadius: 8, padding: '0.75rem 1rem', fontSize: '0.76rem', lineHeight: 1.55,
                      overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#c4d3e4', margin: 0
                    }}>
                      {JSON.stringify(documentDetail.fields, null, 2)}
                    </pre>
                  ) : (
                    <p style={{ color: '#8fa3ba', fontSize: '0.82rem' }}>No fields present in this document.</p>
                  )}
                </div>
              )}
            </div>

          </div>
        </section>
      )}
    </div>
  )
}
