import { useEffect, useMemo, useState } from 'react'
import type {
  GcpBigQueryDatasetSummary,
  GcpBigQueryTableSummary,
  GcpBigQueryTableDetail,
  GcpBigQueryQueryResult
} from '@shared/types'
import {
  listGcpBigQueryDatasets,
  listGcpBigQueryTables,
  getGcpBigQueryTableDetail,
  runGcpBigQueryQuery
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'


/* ── Helpers ──────────────────────────────────────────────── */

type MainTab = 'datasets' | 'query'

const MAIN_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'datasets', label: 'Datasets' },
  { id: 'query', label: 'Query' }
]

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extractQuotedCommand(value: string): string | null {
  const straight = value.match(/"([^"]+)"/)
  if (straight?.[1]?.trim()) {
    return straight[1].trim()
  }
  const curly = value.match(/[\u201C\u201D]([^\u201C\u201D]+)[\u201C\u201D]/)
  return curly?.[1]?.trim() ?? null
}

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  const match = error.match(/"([^"]+)"/) ?? error.match(/[\u201C\u201D]([^\u201C\u201D]+)[\u201C\u201D]/)
  return { command: match?.[1]?.trim() ?? fallbackCommand, summary }
}

function formatDateTime(value: string): string {
  if (!value || value === '-') return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatBytes(bytes: number | string): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes
  if (!Number.isFinite(n) || n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  const value = n / Math.pow(1024, exp)
  return `${value.toFixed(exp > 0 ? 1 : 0)} ${units[exp]}`
}

function formatRowCount(count: number | string): string {
  const n = typeof count === 'string' ? Number(count) : count
  if (!Number.isFinite(n)) return '-'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function trunc(s: string, n: number): string {
  if (!s) return '-'
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s
}

function renderTableHeader(columns: string[], gridTemplateColumns: string): JSX.Element {
  return (
    <div
      className="table-row table-head"
      style={{ display: 'grid', gridTemplateColumns, gap: '1rem' }}
    >
      {columns.map((column) => <div key={column}>{column}</div>)}
    </div>
  )
}

function typeBadgeClass(type: string): string {
  const t = type.toUpperCase()
  if (t === 'VIEW') return 'status-badge status-warn'
  if (t === 'TABLE') return 'status-badge status-ok'
  return 'status-badge'
}


/* ── Schema table sub-component ───────────────────────────── */

function SchemaTable({
  fields,
  depth = 0
}: {
  fields: GcpBigQueryTableDetail['schema']
  depth?: number
}) {
  if (!fields || fields.length === 0) {
    return <div style={{ color: '#8fa3ba', fontSize: '0.78rem', padding: '8px 0' }}>No schema fields available.</div>
  }

  return (
    <table className="svc-table" style={{ width: '100%', tableLayout: 'fixed' }}>
      {depth === 0 && (
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Field</th>
            <th style={{ width: '20%' }}>Type</th>
            <th style={{ width: '15%' }}>Mode</th>
            <th style={{ width: '35%' }}>Description</th>
          </tr>
        </thead>
      )}
      <tbody>
        {fields.map((field) => (
          <>
            <tr key={`${depth}-${field.name}`}>
              <td style={{ paddingLeft: depth * 16 + 8 }}>
                {depth > 0 ? '\u2514 ' : ''}{field.name}
              </td>
              <td>{field.type}</td>
              <td>{field.mode || '-'}</td>
              <td style={{ color: '#98afc3', fontSize: '0.78rem' }}>{field.description || '-'}</td>
            </tr>
            {field.fields && field.fields.length > 0 && (
              <tr key={`${depth}-${field.name}-nested`}>
                <td colSpan={4} style={{ padding: 0, border: 'none' }}>
                  <SchemaTable fields={field.fields} depth={depth + 1} />
                </td>
              </tr>
            )}
          </>
        ))}
      </tbody>
    </table>
  )
}


/* ── Query results sub-component ──────────────────────────── */

function QueryResultsTable({ result }: { result: GcpBigQueryQueryResult }) {
  if (!result.columns || result.columns.length === 0) {
    return <div style={{ color: '#8fa3ba', fontSize: '0.78rem', padding: '8px 0' }}>Query returned no columns.</div>
  }

  return (
    <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 540px)' }}>
      <table className="svc-table" style={{ width: '100%', minWidth: result.columns.length * 140 }}>
        <thead>
          <tr>
            {result.columns.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {row.map((cell, colIdx) => (
                <td key={colIdx} style={{ fontSize: '0.78rem', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cell ?? '-'}
                </td>
              ))}
            </tr>
          ))}
          {result.rows.length === 0 && (
            <tr>
              <td colSpan={result.columns.length} style={{ textAlign: 'center', color: '#6b7688' }}>
                No rows returned.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}


/* ── Main component ───────────────────────────────────────── */

export function GcpBigQueryConsole({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  /* ── Dataset inventory state ────────────────────────────── */
  const [datasets, setDatasets] = useState<GcpBigQueryDatasetSummary[]>([])
  const [datasetsLoading, setDatasetsLoading] = useState(true)
  const [datasetsError, setDatasetsError] = useState('')

  /* ── Selected dataset + tables ──────────────────────────── */
  const [selectedDatasetId, setSelectedDatasetId] = useState('')
  const [tables, setTables] = useState<GcpBigQueryTableSummary[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesError, setTablesError] = useState('')

  /* ── Selected table detail ──────────────────────────────── */
  const [selectedTableId, setSelectedTableId] = useState('')
  const [tableDetail, setTableDetail] = useState<GcpBigQueryTableDetail | null>(null)
  const [tableDetailLoading, setTableDetailLoading] = useState(false)
  const [tableDetailError, setTableDetailError] = useState('')

  /* ── Query state ────────────────────────────────────────── */
  const [queryText, setQueryText] = useState('')
  const [maxResults, setMaxResults] = useState(100)
  const [queryResult, setQueryResult] = useState<GcpBigQueryQueryResult | null>(null)
  const [queryLoading, setQueryLoading] = useState(false)
  const [queryError, setQueryError] = useState('')

  /* ── UI state ───────────────────────────────────────────── */
  const [mainTab, setMainTab] = useState<MainTab>('datasets')
  const [datasetSearch, setDatasetSearch] = useState('')
  const [tableSearch, setTableSearch] = useState('')


  /* ── Derived values ─────────────────────────────────────── */

  const totalTables = useMemo(
    () => datasets.reduce((sum, ds) => sum + (Number.isFinite(ds.tableCount) ? ds.tableCount : 0), 0),
    [datasets]
  )

  const uniqueLocations = useMemo(
    () => new Set(datasets.map((ds) => ds.location).filter(Boolean)).size,
    [datasets]
  )

  const filteredDatasets = useMemo(() => {
    if (!datasetSearch.trim()) return datasets
    const q = datasetSearch.trim().toLowerCase()
    return datasets.filter(
      (ds) =>
        ds.datasetId.toLowerCase().includes(q) ||
        (ds.friendlyName || '').toLowerCase().includes(q) ||
        (ds.location || '').toLowerCase().includes(q) ||
        (ds.description || '').toLowerCase().includes(q)
    )
  }, [datasets, datasetSearch])

  const filteredTables = useMemo(() => {
    if (!tableSearch.trim()) return tables
    const q = tableSearch.trim().toLowerCase()
    return tables.filter(
      (t) =>
        t.tableId.toLowerCase().includes(q) ||
        (t.type || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
    )
  }, [tables, tableSearch])


  /* ── Enable-API error detection ─────────────────────────── */

  const enableAction = datasetsError
    ? getGcpApiEnableAction(
        datasetsError,
        `gcloud services enable bigquery.googleapis.com --project ${projectId}`,
        `BigQuery API access failed for project ${projectId}.`
      )
    : null


  /* ── Data fetching: datasets ────────────────────────────── */

  useEffect(() => {
    let cancelled = false
    setDatasetsLoading(true)
    setDatasetsError('')

    listGcpBigQueryDatasets(projectId)
      .then((data) => {
        if (!cancelled) {
          setDatasets(data)
          setSelectedDatasetId('')
          setTables([])
          setSelectedTableId('')
          setTableDetail(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDatasetsError(normalizeError(err))
          setDatasets([])
        }
      })
      .finally(() => {
        if (!cancelled) setDatasetsLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, refreshNonce])


  /* ── Data fetching: tables for selected dataset ─────────── */

  useEffect(() => {
    if (!selectedDatasetId) {
      setTables([])
      setSelectedTableId('')
      setTableDetail(null)
      return
    }

    let cancelled = false
    setTablesLoading(true)
    setTablesError('')
    setSelectedTableId('')
    setTableDetail(null)

    listGcpBigQueryTables(projectId, selectedDatasetId)
      .then((data) => {
        if (!cancelled) setTables(data)
      })
      .catch((err) => {
        if (!cancelled) {
          setTablesError(normalizeError(err))
          setTables([])
        }
      })
      .finally(() => {
        if (!cancelled) setTablesLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, selectedDatasetId])


  /* ── Data fetching: table detail ────────────────────────── */

  useEffect(() => {
    if (!selectedDatasetId || !selectedTableId) {
      setTableDetail(null)
      return
    }

    let cancelled = false
    setTableDetailLoading(true)
    setTableDetailError('')

    getGcpBigQueryTableDetail(projectId, selectedDatasetId, selectedTableId)
      .then((data) => {
        if (!cancelled) setTableDetail(data)
      })
      .catch((err) => {
        if (!cancelled) {
          setTableDetailError(normalizeError(err))
          setTableDetail(null)
        }
      })
      .finally(() => {
        if (!cancelled) setTableDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, selectedDatasetId, selectedTableId])


  /* ── Query execution ────────────────────────────────────── */

  async function handleRunQuery(): Promise<void> {
    if (!queryText.trim()) return
    setQueryLoading(true)
    setQueryError('')
    setQueryResult(null)

    try {
      const result = await runGcpBigQueryQuery(projectId, queryText.trim(), maxResults)
      setQueryResult(result)
    } catch (err) {
      setQueryError(normalizeError(err))
    } finally {
      setQueryLoading(false)
    }
  }


  /* ── Refresh datasets ───────────────────────────────────── */

  function handleRefreshDatasets(): void {
    setDatasetsLoading(true)
    setDatasetsError('')

    listGcpBigQueryDatasets(projectId)
      .then((data) => {
        setDatasets(data)
        setSelectedDatasetId('')
        setTables([])
        setSelectedTableId('')
        setTableDetail(null)
      })
      .catch((err) => {
        setDatasetsError(normalizeError(err))
        setDatasets([])
      })
      .finally(() => {
        setDatasetsLoading(false)
      })
  }


  /* ── Early loading state ────────────────────────────────── */

  if (datasetsLoading && datasets.length === 0 && !datasetsError) {
    return <SvcState variant="loading" resourceName="BigQuery datasets" />
  }


  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="svc-console iam-console">
      {/* ── Hero section ────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Data warehouse posture</div>
          <h2>BigQuery Operations</h2>
          <p>
            Dataset and table inventory for the active GCP project. Drill into
            schemas, run ad-hoc queries, and inspect data warehouse posture from
            a single surface.
          </p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill">
              <span>Provider</span>
              <strong>GCP</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Project</span>
              <strong>{trunc(projectId, 28)}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Location</span>
              <strong>{location.trim() || 'global'}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Datasets</span>
            <strong>{datasets.length}</strong>
            <small>{datasetsLoading ? 'Refreshing live data now' : 'Datasets in current project'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Total Tables</span>
            <strong>{totalTables}</strong>
            <small>{totalTables === 1 ? '1 table across all datasets' : `${totalTables} tables across all datasets`}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Locations</span>
            <strong>{uniqueLocations}</strong>
            <small>{uniqueLocations === 1 ? '1 distinct data location' : `${uniqueLocations} distinct data locations`}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Active Tab</span>
            <strong>{MAIN_TABS.find((t) => t.id === mainTab)?.label ?? 'BigQuery'}</strong>
            <small>Current workspace surface</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ────────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <div className="iam-tab-bar">
          {MAIN_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`svc-tab ${mainTab === tab.id ? 'active' : ''}`}
              onClick={() => setMainTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Enable-API error banner ────────────────────── */}
      {enableAction ? (
        <div className="error-banner gcp-enable-error-banner">
          <div className="gcp-enable-error-copy">
            <strong>{enableAction.summary}</strong>
            <p>
              {canRunTerminalCommand
                ? 'Run the enable command in the terminal, wait for propagation, then retry.'
                : 'Switch Settings to Operator mode to enable terminal actions.'}
            </p>
          </div>
          <div className="gcp-enable-error-actions">
            <button
              type="button"
              disabled={!canRunTerminalCommand}
              onClick={() => onRunTerminalCommand(enableAction.command)}
              title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode'}
            >
              Run enable command in terminal
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Non-API errors ─────────────────────────────── */}
      {datasetsError && !enableAction ? <SvcState variant="error" error={datasetsError} /> : null}
      {datasetsLoading ? <SvcState variant="loading" resourceName="BigQuery datasets" compact /> : null}


      {/* ══════════════════════════════════════════════════ */}
      {/* ── DATASETS TAB                                   */}
      {/* ══════════════════════════════════════════════════ */}
      {mainTab === 'datasets' && !datasetsLoading && !datasetsError && (
        <section className="overview-surface" style={{ gap: 12 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: selectedDatasetId ? 'minmax(280px, 0.85fr) minmax(0, 1.15fr)' : '1fr',
              gap: 12,
              minWidth: 0
            }}
          >
            {/* ── Left panel: dataset list ──────────────── */}
            <div className="panel" style={{ minWidth: 0 }}>
              <div
                className="panel-header"
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <h3>Datasets</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="Filter datasets..."
                    value={datasetSearch}
                    onChange={(e) => setDatasetSearch(e.target.value)}
                    style={{
                      maxWidth: 200,
                      fontSize: '0.78rem',
                      padding: '0.35rem 0.6rem',
                      borderRadius: 8,
                      border: '1px solid rgba(145,176,207,0.18)',
                      background: 'rgba(0,0,0,0.15)',
                      color: 'inherit'
                    }}
                  />
                  <button
                    type="button"
                    className="svc-btn"
                    disabled={datasetsLoading}
                    onClick={handleRefreshDatasets}
                    style={{ fontSize: '0.76rem', padding: '0.35rem 0.7rem' }}
                  >
                    {datasetsLoading ? 'Loading...' : 'Refresh'}
                  </button>
                </div>
              </div>

              {filteredDatasets.length === 0 ? (
                <SvcState
                  variant={datasetSearch.trim() ? 'no-filter-matches' : 'empty'}
                  message={
                    datasetSearch.trim()
                      ? `No datasets match "${datasetSearch.trim()}".`
                      : 'No BigQuery datasets found in this project.'
                  }
                />
              ) : (
                <div className="table-grid overview-table-grid">
                  {renderTableHeader(
                    ['Dataset', 'Location', 'Friendly Name'],
                    '1fr 0.6fr 1fr'
                  )}
                  {filteredDatasets.map((ds) => (
                    <button
                      key={ds.datasetId}
                      type="button"
                      className={`table-row overview-table-row ${selectedDatasetId === ds.datasetId ? 'active' : ''}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 0.6fr 1fr',
                        gap: '1rem',
                        textAlign: 'left'
                      }}
                      onClick={() => setSelectedDatasetId(
                        selectedDatasetId === ds.datasetId ? '' : ds.datasetId
                      )}
                    >
                      <div>
                        <strong>{ds.datasetId}</strong>
                        {ds.description && (
                          <div style={{ color: '#8fa3ba', fontSize: '0.72rem', marginTop: 2 }}>
                            {trunc(ds.description, 60)}
                          </div>
                        )}
                      </div>
                      <div style={{ color: '#98afc3', fontSize: '0.82rem' }}>
                        {ds.location || '-'}
                      </div>
                      <div style={{ color: '#c4d3e4', fontSize: '0.82rem' }}>
                        {ds.friendlyName || '-'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ── Right panel: tables + schema ─────────── */}
            {selectedDatasetId && (
              <div className="panel" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* ── Tables list ───────────────────────── */}
                <div>
                  <div
                    className="panel-header"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <h3>Tables in {selectedDatasetId}</h3>
                    <input
                      type="text"
                      placeholder="Filter tables..."
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      style={{
                        maxWidth: 200,
                        fontSize: '0.78rem',
                        padding: '0.35rem 0.6rem',
                        borderRadius: 8,
                        border: '1px solid rgba(145,176,207,0.18)',
                        background: 'rgba(0,0,0,0.15)',
                        color: 'inherit'
                      }}
                    />
                  </div>

                  {tablesLoading ? (
                    <SvcState variant="loading" resourceName="tables" compact />
                  ) : tablesError ? (
                    <SvcState variant="error" error={tablesError} />
                  ) : filteredTables.length === 0 ? (
                    <SvcState
                      variant={tableSearch.trim() ? 'no-filter-matches' : 'empty'}
                      message={
                        tableSearch.trim()
                          ? `No tables match "${tableSearch.trim()}".`
                          : `No tables found in dataset ${selectedDatasetId}.`
                      }
                    />
                  ) : (
                    <div className="table-grid overview-table-grid" style={{ maxHeight: tableDetail ? 'calc(50vh - 200px)' : 'calc(100vh - 420px)', overflowY: 'auto' }}>
                      {renderTableHeader(
                        ['Table', 'Type', 'Rows', 'Size'],
                        '1.2fr 0.6fr 0.6fr 0.6fr'
                      )}
                      {filteredTables.map((t) => (
                        <button
                          key={t.tableId}
                          type="button"
                          className={`table-row overview-table-row ${selectedTableId === t.tableId ? 'active' : ''}`}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1.2fr 0.6fr 0.6fr 0.6fr',
                            gap: '1rem',
                            textAlign: 'left'
                          }}
                          onClick={() => setSelectedTableId(
                            selectedTableId === t.tableId ? '' : t.tableId
                          )}
                        >
                          <div>
                            <strong>{t.tableId}</strong>
                            {t.description && (
                              <div style={{ color: '#8fa3ba', fontSize: '0.72rem', marginTop: 2 }}>
                                {trunc(t.description, 50)}
                              </div>
                            )}
                          </div>
                          <div>
                            <span className={typeBadgeClass(t.type)}>
                              {t.type || '-'}
                            </span>
                          </div>
                          <div style={{ color: '#c4d3e4', fontSize: '0.82rem' }}>
                            {formatRowCount(t.rowCount)}
                          </div>
                          <div style={{ color: '#98afc3', fontSize: '0.82rem' }}>
                            {formatBytes(t.sizeBytes)}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* ── Table schema detail ───────────────── */}
                {selectedTableId && (
                  <div style={{ borderTop: '1px solid rgba(145,176,207,0.1)', paddingTop: 12 }}>
                    <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3>
                        Schema: {selectedTableId}
                        {tableDetail && (
                          <span style={{ fontWeight: 400, fontSize: '0.78rem', color: '#8fa3ba', marginLeft: 8 }}>
                            ({tableDetail.schema?.length ?? 0} fields)
                          </span>
                        )}
                      </h3>
                      {tableDetail && (
                        <div style={{ display: 'flex', gap: 12, fontSize: '0.76rem', color: '#98afc3' }}>
                          <span>Location: {tableDetail.location || '-'}</span>
                          <span>Modified: {formatDateTime(tableDetail.lastModifiedTime)}</span>
                        </div>
                      )}
                    </div>

                    {tableDetailLoading ? (
                      <SvcState variant="loading" resourceName="table schema" compact />
                    ) : tableDetailError ? (
                      <SvcState variant="error" error={tableDetailError} />
                    ) : tableDetail ? (
                      <div style={{ maxHeight: 'calc(50vh - 160px)', overflowY: 'auto' }}>
                        <SchemaTable fields={tableDetail.schema} />
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Dataset metadata strip ─────────────────── */}
          {selectedDatasetId && (() => {
            const ds = datasets.find((d) => d.datasetId === selectedDatasetId)
            if (!ds) return null
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 0' }}>
                {[
                  { label: 'Dataset', value: ds.datasetId },
                  { label: 'Project', value: ds.projectId || projectId },
                  { label: 'Location', value: ds.location || '-' },
                  { label: 'Tables', value: String(ds.tableCount ?? 0) },
                  { label: 'Created', value: formatDateTime(ds.creationTime) },
                  { label: 'Modified', value: formatDateTime(ds.lastModifiedTime) }
                ].map((item) => (
                  <div
                    key={item.label}
                    className="iam-shell-meta-pill"
                    style={{ flex: '0 1 auto' }}
                  >
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            )
          })()}
        </section>
      )}

      {/* Empty state for datasets tab when no datasets */}
      {mainTab === 'datasets' && !datasetsLoading && !datasetsError && datasets.length === 0 && (
        <SvcState
          variant="empty"
          message="No BigQuery datasets were found for this project. Create a dataset using the bq CLI or the Google Cloud Console."
        />
      )}


      {/* ══════════════════════════════════════════════════ */}
      {/* ── QUERY TAB                                      */}
      {/* ══════════════════════════════════════════════════ */}
      {mainTab === 'query' && (
        <section className="overview-surface" style={{ gap: 12 }}>
          {/* ── Query input area ───────────────────────── */}
          <div className="panel">
            <div className="panel-header">
              <h3>SQL Query</h3>
            </div>

            <textarea
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder={`SELECT * FROM \`${projectId}.dataset_name.table_name\` LIMIT 100`}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: 140,
                maxHeight: 320,
                resize: 'vertical',
                padding: '12px 14px',
                fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
                fontSize: '0.82rem',
                lineHeight: 1.6,
                color: '#edf4fb',
                background: 'rgba(8, 14, 22, 0.64)',
                border: '1px solid rgba(145, 176, 207, 0.15)',
                borderRadius: 12,
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                alignItems: 'center',
                marginTop: 10
              }}
            >
              <button
                type="button"
                className="svc-btn success"
                disabled={queryLoading || !queryText.trim()}
                onClick={() => void handleRunQuery()}
                style={{ minWidth: 120 }}
              >
                {queryLoading ? 'Running...' : 'Run Query'}
              </button>

              <label
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  fontSize: '0.78rem',
                  color: '#98afc3'
                }}
              >
                Max results:
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={maxResults}
                  onChange={(e) => setMaxResults(Math.max(1, Math.min(10000, Number(e.target.value) || 100)))}
                  style={{
                    width: 72,
                    padding: '0.3rem 0.5rem',
                    fontSize: '0.78rem',
                    borderRadius: 8,
                    border: '1px solid rgba(145,176,207,0.18)',
                    background: 'rgba(0,0,0,0.15)',
                    color: 'inherit',
                    textAlign: 'center'
                  }}
                />
              </label>

              {queryResult && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto' }}>
                  {queryResult.cacheHit && (
                    <span className="status-badge status-ok">Cache Hit</span>
                  )}
                  {!queryResult.cacheHit && queryResult.jobComplete && (
                    <span className="status-badge">Full Scan</span>
                  )}
                  <span style={{ fontSize: '0.78rem', color: '#98afc3' }}>
                    {queryResult.totalRows != null
                      ? `${formatRowCount(queryResult.totalRows)} total rows`
                      : 'Rows unknown'}
                    {queryResult.rows
                      ? ` (showing ${queryResult.rows.length})`
                      : ''}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Query error ────────────────────────────── */}
          {queryError && (
            <div className="error-banner" style={{ fontSize: '0.82rem' }}>
              {queryError}
            </div>
          )}

          {/* ── Query loading ──────────────────────────── */}
          {queryLoading && <SvcState variant="loading" resourceName="query results" compact />}

          {/* ── Query results ──────────────────────────── */}
          {queryResult && !queryLoading && (
            <div className="panel">
              <div
                className="panel-header"
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <h3>Results</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {queryResult.jobComplete ? (
                    <span className="status-badge status-ok">Job Complete</span>
                  ) : (
                    <span className="status-badge status-warn">Job Incomplete</span>
                  )}
                </div>
              </div>
              <QueryResultsTable result={queryResult} />
            </div>
          )}

          {/* ── Quick query templates ──────────────────── */}
          {!queryResult && !queryLoading && !queryError && datasets.length > 0 && (
            <div className="panel" style={{ opacity: 0.85 }}>
              <div className="panel-header">
                <h3>Quick Templates</h3>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {[
                  {
                    label: 'List tables in INFORMATION_SCHEMA',
                    sql: `SELECT table_catalog, table_schema, table_name, table_type\nFROM \`${projectId}.${datasets[0]?.datasetId ?? 'dataset'}.INFORMATION_SCHEMA.TABLES\``
                  },
                  {
                    label: 'Row counts by table',
                    sql: `SELECT table_id, row_count, size_bytes\nFROM \`${projectId}.${datasets[0]?.datasetId ?? 'dataset'}\`.__TABLES__\nORDER BY row_count DESC`
                  },
                  {
                    label: 'Dataset metadata',
                    sql: `SELECT schema_name, creation_time, last_modified_time\nFROM \`${projectId}.INFORMATION_SCHEMA.SCHEMATA\``
                  }
                ].map((tmpl) => (
                  <button
                    key={tmpl.label}
                    type="button"
                    className="svc-btn"
                    style={{ fontSize: '0.76rem', padding: '0.35rem 0.7rem' }}
                    onClick={() => setQueryText(tmpl.sql)}
                  >
                    {tmpl.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
