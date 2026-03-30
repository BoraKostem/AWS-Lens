import { useEffect, useMemo, useState } from 'react'
import { SvcState } from './SvcState'
import './compare.css'

import type {
  ComparisonDiffRow,
  ComparisonDiffStatus,
  ComparisonFocusMode,
  ComparisonRequest,
  ComparisonResult,
  ServiceId
} from '@shared/types'
import { runComparison } from './api'
import type { useAwsPageConnection } from './AwsPage'

type CompareSeed = {
  token: number
  request: ComparisonRequest
}

type SelectorOption = {
  key: string
  label: string
  requestBase:
    | { kind: 'profile'; profile: string; label?: string }
    | { kind: 'assumed-role'; sessionId: string; label?: string }
}

type CompareViewMode = 'flat' | 'grouped'

const FOCUS_OPTIONS: Array<{ value: ComparisonFocusMode; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'security', label: 'Security' },
  { value: 'compute', label: 'Compute' },
  { value: 'networking', label: 'Networking' },
  { value: 'storage', label: 'Storage' },
  { value: 'drift-compliance', label: 'Drift / Compliance' },
  { value: 'cost', label: 'Cost' }
]

function defaultLeftKey(state: ReturnType<typeof useAwsPageConnection>, options: SelectorOption[]): string {
  if (state.activeSession) {
    const sessionKey = `session:${state.activeSession.id}`
    if (options.some((option) => option.key === sessionKey)) {
      return sessionKey
    }
  }

  const profileKey = state.profile ? `profile:${state.profile}` : ''
  if (profileKey && options.some((option) => option.key === profileKey)) {
    return profileKey
  }

  return options[0]?.key ?? ''
}

function defaultRightKey(leftKey: string, options: SelectorOption[]): string {
  return options.find((option) => option.key !== leftKey)?.key ?? leftKey
}

export function CompareWorkspace({
  connectionState,
  seed,
  refreshNonce = 0,
  onNavigate
}: {
  connectionState: ReturnType<typeof useAwsPageConnection>
  seed: CompareSeed | null
  refreshNonce?: number
  onNavigate: (serviceId: ServiceId, resourceId?: string, region?: string) => void
}) {
  const options = useMemo<SelectorOption[]>(() => {
    const profileOptions = connectionState.profiles.map((profile) => ({
      key: `profile:${profile.name}`,
      label: `Profile: ${profile.name}`,
      requestBase: { kind: 'profile' as const, profile: profile.name, label: profile.name }
    }))
    const sessionOptions = connectionState.sessions
      .filter((session) => session.status === 'active')
      .map((session) => ({
        key: `session:${session.id}`,
        label: `Session: ${session.label} (${session.accountId || 'unknown'})`,
        requestBase: { kind: 'assumed-role' as const, sessionId: session.id, label: session.label }
      }))

    return [...profileOptions, ...sessionOptions]
  }, [connectionState.profiles, connectionState.sessions])

  const [leftKey, setLeftKey] = useState('')
  const [rightKey, setRightKey] = useState('')
  const [leftRegion, setLeftRegion] = useState(connectionState.region)
  const [rightRegion, setRightRegion] = useState(connectionState.region)
  const [focusMode, setFocusMode] = useState<ComparisonFocusMode>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | ComparisonDiffStatus>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ComparisonResult | null>(null)
  const [selectedRowId, setSelectedRowId] = useState('')
  const [viewMode, setViewMode] = useState<CompareViewMode>('flat')

  useEffect(() => {
    if (!options.length) {
      setLeftKey('')
      setRightKey('')
      return
    }

    setLeftKey((current) => current || defaultLeftKey(connectionState, options))
    setRightKey((current) => current || defaultRightKey(defaultLeftKey(connectionState, options), options))
  }, [connectionState, options])

  useEffect(() => {
    setLeftRegion(connectionState.region)
    setRightRegion(connectionState.region)
  }, [connectionState.region])

  useEffect(() => {
    if (!seed) {
      return
    }

    const nextLeftKey = seed.request.left.kind === 'profile'
      ? `profile:${seed.request.left.profile}`
      : `session:${seed.request.left.sessionId}`
    const nextRightKey = seed.request.right.kind === 'profile'
      ? `profile:${seed.request.right.profile}`
      : `session:${seed.request.right.sessionId}`

    setLeftKey(nextLeftKey)
    setRightKey(nextRightKey)
    setLeftRegion(seed.request.left.region)
    setRightRegion(seed.request.right.region)
    void handleCompare(seed.request)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token])

  const selectedRow = useMemo(() => {
    return result?.groups.flatMap((group) => group.rows).find((row) => row.id === selectedRowId) ?? null
  }, [result, selectedRowId])

  const filteredGroups = useMemo(() => {
    if (!result) return []
    const query = search.trim().toLowerCase()

    return result.groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => {
          if (focusMode !== 'all' && !row.focusModes.includes(focusMode)) return false
          if (statusFilter !== 'all' && row.status !== statusFilter) return false
          if (!query) return true
          return `${row.title} ${row.subtitle} ${row.left.value} ${row.right.value} ${row.resourceType} ${row.rationale}`.toLowerCase().includes(query)
        })
      }))
      .filter((group) => group.rows.length > 0)
  }, [focusMode, result, search, statusFilter])

  const flatRows = useMemo(() => {
    return filteredGroups.flatMap((group) =>
      group.rows.map((row) => ({
        ...row,
        sectionLabel: group.label
      }))
    )
  }, [filteredGroups])

  const totalRows = useMemo(() => result?.groups.reduce((sum, group) => sum + group.rows.length, 0) ?? 0, [result])
  const changedRows = useMemo(() => result?.groups.reduce((sum, group) => sum + group.rows.filter((row) => row.status === 'different').length, 0) ?? 0, [result])
  const leftOnlyRows = useMemo(() => result?.groups.reduce((sum, group) => sum + group.rows.filter((row) => row.status === 'left-only').length, 0) ?? 0, [result])
  const rightOnlyRows = useMemo(() => result?.groups.reduce((sum, group) => sum + group.rows.filter((row) => row.status === 'right-only').length, 0) ?? 0, [result])
  const sameRows = useMemo(() => result?.groups.reduce((sum, group) => sum + group.rows.filter((row) => row.status === 'same').length, 0) ?? 0, [result])

  function buildRequest(): ComparisonRequest | null {
    const left = options.find((option) => option.key === leftKey)
    const right = options.find((option) => option.key === rightKey)
    if (!left || !right) return null

    return {
      left: { ...left.requestBase, region: leftRegion },
      right: { ...right.requestBase, region: rightRegion }
    }
  }

  async function handleCompare(prebuilt?: ComparisonRequest): Promise<void> {
    const request = prebuilt ?? buildRequest()
    if (!request) {
      setError('Choose two contexts to compare.')
      return
    }

    setLoading(true)
    setError('')
    try {
      const next = await runComparison(request)
      setResult(next)
      setSelectedRowId((current) => {
        const rows = next.groups.flatMap((group) => group.rows)
        return rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? '')
      })
    } catch (compareError) {
      setResult(null)
      setSelectedRowId('')
      setError(compareError instanceof Error ? compareError.message : String(compareError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (refreshNonce === 0 || !result) {
      return
    }

    void handleCompare()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  function renderInventoryCard(row: ComparisonDiffRow, sectionLabel?: string) {
    return (
      <button
        key={row.id}
        type="button"
        className={`compare-inventory-card ${selectedRowId === row.id ? 'active' : ''}`}
        onClick={() => setSelectedRowId(row.id)}
      >
        <div className="compare-inventory-card-head">
          <div className="compare-inventory-card-copy">
            <strong>{row.title}</strong>
            <span>{row.subtitle}</span>
          </div>
          <span className={`status-chip ${row.status}`}>{row.status}</span>
        </div>
        <div className="compare-inventory-card-meta">
          {sectionLabel && <span>{sectionLabel}</span>}
          <span>{row.resourceType}</span>
          <span>Risk {row.risk}</span>
        </div>
        <div className="compare-compare-values">
          <div>
            <small>{result?.leftContext.label || 'Left'}</small>
            <strong>{row.left.value}</strong>
            <span>{row.left.secondary || '-'}</span>
          </div>
          <div>
            <small>{result?.rightContext.label || 'Right'}</small>
            <strong>{row.right.value}</strong>
            <span>{row.right.secondary || '-'}</span>
          </div>
        </div>
        <p>{row.rationale}</p>
      </button>
    )
  }

  return (
    <div className="compare-console">
      {error && <SvcState variant="error" error={error} />}

      <section className="compare-shell-hero">
        <div className="compare-shell-hero-copy">
          <div className="eyebrow">Compare</div>
          <h2>Cross-account drift and posture diff</h2>
          <p>Run the same comparison logic with a Terraform-style operating surface: pick two contexts, scan deltas, and inspect exact field-level variance before jumping into a service.</p>
          <div className="compare-shell-meta-strip">
            <div className="compare-shell-meta-pill">
              <span>Left context</span>
              <strong>{result?.leftContext.label ?? 'Select a source'}</strong>
            </div>
            <div className="compare-shell-meta-pill">
              <span>Right context</span>
              <strong>{result?.rightContext.label ?? 'Select a target'}</strong>
            </div>
            <div className="compare-shell-meta-pill">
              <span>Focus</span>
              <strong>{FOCUS_OPTIONS.find((option) => option.value === focusMode)?.label ?? 'All'}</strong>
            </div>
            <div className="compare-shell-meta-pill">
              <span>View</span>
              <strong>{viewMode === 'flat' ? 'Single table' : 'Grouped tables'}</strong>
            </div>
          </div>
        </div>
        <div className="compare-shell-hero-stats">
          <div className="compare-shell-stat-card compare-shell-stat-card-accent">
            <span>Tracked deltas</span>
            <strong>{totalRows}</strong>
            <small>{result ? 'Rows gathered across all diff sections' : 'Run a comparison to populate inventory'}</small>
          </div>
          <div className="compare-shell-stat-card">
            <span>Different</span>
            <strong>{changedRows}</strong>
            <small>Value, posture, or ownership differences</small>
          </div>
          <div className="compare-shell-stat-card">
            <span>Left only</span>
            <strong>{leftOnlyRows}</strong>
            <small>Present only in the left context</small>
          </div>
          <div className="compare-shell-stat-card">
            <span>Right only</span>
            <strong>{rightOnlyRows}</strong>
            <small>Present only in the right context</small>
          </div>
          <div className="compare-shell-stat-card">
            <span>Same</span>
            <strong>{sameRows}</strong>
            <small>Rows currently aligned</small>
          </div>
          <div className="compare-shell-stat-card">
            <span>Selected row</span>
            <strong>{selectedRow ? selectedRow.title : 'None'}</strong>
            <small>{selectedRow?.resourceType ?? 'Pick a diff row to inspect'}</small>
          </div>
        </div>
      </section>

      <section className="compare-shell-toolbar">
        <div className="compare-toolbar-main">
          <div className="compare-toolbar-copy">
            <span className="compare-pane-kicker">Diff controls</span>
            <h3>Contexts and scope</h3>
          </div>
          <div className="compare-context-grid">
            <label className="field">
              <span>Left Context</span>
              <select value={leftKey} onChange={(event) => setLeftKey(event.target.value)}>
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Left Region</span>
              <select value={leftRegion} onChange={(event) => setLeftRegion(event.target.value)}>
                {connectionState.regions.map((region) => <option key={region.id} value={region.id}>{region.id}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Right Context</span>
              <select value={rightKey} onChange={(event) => setRightKey(event.target.value)}>
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Right Region</span>
              <select value={rightRegion} onChange={(event) => setRightRegion(event.target.value)}>
                {connectionState.regions.map((region) => <option key={region.id} value={region.id}>{region.id}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="compare-toolbar-side">
          <button type="button" className="tf-toolbar-btn accent" disabled={loading} onClick={() => void handleCompare()}>
            {loading ? 'Comparing...' : 'Run Diff'}
          </button>
          <div className="compare-toolbar-status">
            <span>Inventory mode</span>
            <strong>{viewMode === 'flat' ? `${flatRows.length} visible rows` : `${filteredGroups.length} visible groups`}</strong>
          </div>
        </div>
      </section>

      {result ? (
        <div className="compare-main-layout">
          <section className="compare-list-pane">
            <div className="compare-pane-head">
              <div>
                <span className="compare-pane-kicker">Delta inventory</span>
                <h3>{viewMode === 'flat' ? 'All visible rows' : 'Grouped change sets'}</h3>
              </div>
              <span className="compare-pane-summary">{viewMode === 'flat' ? `${flatRows.length} rows` : `${filteredGroups.length} groups`}</span>
            </div>

            {viewMode === 'flat' ? (
              <div className="compare-inventory-list">
                {flatRows.map((row) => renderInventoryCard(row, row.sectionLabel))}
              </div>
            ) : (
              <div className="compare-group-list">
                {filteredGroups.map((group) => (
                  <section key={group.id} className="compare-group-section">
                    <div className="compare-group-head">
                      <strong>{group.label}</strong>
                      <span>{group.rows.length} row{group.rows.length === 1 ? '' : 's'}</span>
                    </div>
                    <div className="compare-inventory-list">
                      {group.rows.map((row) => renderInventoryCard(row, group.label))}
                    </div>
                  </section>
                ))}
              </div>
            )}

            {(viewMode === 'flat' ? flatRows.length === 0 : filteredGroups.length === 0) && (
              <div className="compare-empty">No rows match the current filters.</div>
            )}
          </section>

          <section className="compare-detail-pane">
            <section className="compare-filter-panel">
              <div className="compare-pane-head">
                <div>
                  <span className="compare-pane-kicker">Detail controls</span>
                  <h3>Filters and inspection</h3>
                </div>
              </div>
              <div className="overview-chip-row compare-chip-row compare-chip-row-compact">
                <button
                  type="button"
                  className={`overview-service-chip ${viewMode === 'flat' ? 'active' : ''}`}
                  onClick={() => setViewMode('flat')}
                >
                  <span>Single Table</span>
                </button>
                <button
                  type="button"
                  className={`overview-service-chip ${viewMode === 'grouped' ? 'active' : ''}`}
                  onClick={() => setViewMode('grouped')}
                >
                  <span>Grouped Tables</span>
                </button>
              </div>
              <div className="overview-chip-row compare-chip-row compare-chip-row-full">
                {FOCUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`overview-service-chip ${focusMode === option.value ? 'active' : ''}`}
                    onClick={() => setFocusMode(option.value)}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
              <div className="compare-filter-grid">
                <label className="field">
                  <span>Status</span>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | ComparisonDiffStatus)}>
                    <option value="all">All</option>
                    <option value="different">Different</option>
                    <option value="left-only">Only in left</option>
                    <option value="right-only">Only in right</option>
                    <option value="same">Same</option>
                  </select>
                </label>
                <label className="field">
                  <span>Search</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter rows" />
                </label>
              </div>
            </section>

            {selectedRow ? (
              <>
                {(() => {
                  const navigation = selectedRow.navigation
                  return (
                    <>
                <section className="compare-detail-hero">
                  <div className="compare-detail-hero-copy">
                    <div className="eyebrow">Selected diff</div>
                    <h3>{selectedRow.title}</h3>
                    <p>{selectedRow.rationale}</p>
                    <div className="compare-shell-meta-strip">
                      <div className="compare-shell-meta-pill">
                        <span>Section</span>
                        <strong>{flatRows.find((row) => row.id === selectedRow.id)?.sectionLabel ?? selectedRow.resourceType}</strong>
                      </div>
                      <div className="compare-shell-meta-pill">
                        <span>Resource type</span>
                        <strong>{selectedRow.resourceType}</strong>
                      </div>
                      <div className="compare-shell-meta-pill">
                        <span>Status</span>
                        <strong>{selectedRow.status}</strong>
                      </div>
                      <div className="compare-shell-meta-pill">
                        <span>Risk</span>
                        <strong>{selectedRow.risk}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="compare-detail-hero-stats">
                    <div className="compare-shell-stat-card">
                      <span>{result.leftContext.label}</span>
                      <strong>{selectedRow.left.value}</strong>
                      <small>{selectedRow.left.secondary || '-'}</small>
                    </div>
                    <div className="compare-shell-stat-card">
                      <span>{result.rightContext.label}</span>
                      <strong>{selectedRow.right.value}</strong>
                      <small>{selectedRow.right.secondary || '-'}</small>
                    </div>
                    <div className="compare-shell-stat-card">
                      <span>Subtitle</span>
                      <strong className="compare-shell-stat-card-value compare-shell-stat-card-value-wrap">{selectedRow.subtitle || '-'}</strong>
                      <small>Resource label and locator context</small>
                    </div>
                    <div className="compare-shell-stat-card">
                      <span>Open target</span>
                      <strong className="compare-shell-stat-card-value">{navigation?.serviceId ?? 'Not linked'}</strong>
                      <small>{navigation?.region ?? 'No direct service navigation'}</small>
                    </div>
                  </div>
                </section>

                <section className="compare-detail-section">
                  <div className="compare-pane-head">
                    <div>
                      <span className="compare-pane-kicker">Field comparison</span>
                      <h3>Left versus right values</h3>
                    </div>
                    {navigation && (
                      <button
                        type="button"
                        className="tf-toolbar-btn"
                        onClick={() => onNavigate(navigation.serviceId, navigation.resourceLabel, navigation.region)}
                      >
                        Open {navigation.serviceId}
                      </button>
                    )}
                  </div>
                  <div className="table-grid">
                    <div className="table-row table-head compare-detail-grid">
                      <div>Field</div>
                      <div>{result.leftContext.label}</div>
                      <div>{result.rightContext.label}</div>
                    </div>
                    {selectedRow.detailFields.map((field) => (
                      <div key={field.key} className="table-row compare-detail-grid">
                        <div>{field.label}</div>
                        <div>{field.leftValue || '-'}</div>
                        <div>{field.rightValue || '-'}</div>
                      </div>
                    ))}
                  </div>
                </section>
                    </>
                  )
                })()}
              </>
            ) : (
              <section className="compare-detail-section">
                <SvcState variant="no-selection" message="Select a diff row from the inventory pane to inspect the exact field-level differences." />
              </section>
            )}

            <section className="overview-tiles compare-summary-tiles">
              {result.summary.totals.map((item) => (
                <div key={item.id} className="overview-tile">
                  <strong>{item.leftValue} / {item.rightValue}</strong>
                  <span>{item.label}</span>
                </div>
              ))}
            </section>
          </section>
        </div>
      ) : (
        <section className="compare-detail-section">
          <SvcState variant="no-selection" message="Choose two contexts, then run the diff to load summary totals, inventory deltas, posture changes, ownership tags, and cost signals." />
        </section>
      )}
    </div>
  )
}
