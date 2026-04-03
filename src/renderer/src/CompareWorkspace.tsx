import { useEffect, useMemo, useState } from 'react'
import { SvcState } from './SvcState'
import './compare.css'

import type {
  ComparisonBaseline,
  ComparisonBaselineSummary,
  ComparisonDiffRow,
  ComparisonDiffStatus,
  ComparisonFocusMode,
  ComparisonPreset,
  ComparisonPresetSummary,
  ComparisonRequest,
  ComparisonResult,
  ServiceId
} from '@shared/types'
import {
  deleteComparisonBaseline,
  deleteComparisonPreset,
  getComparisonBaseline,
  getComparisonPreset,
  listComparisonBaselines,
  listComparisonPresets,
  runComparison,
  saveComparisonBaseline,
  saveComparisonPreset
} from './api'
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
    | { kind: 'saved-target'; targetId: string; label?: string }
}

type CompareViewMode = 'flat' | 'grouped'

type BaselineDeltaCounts = {
  added: number
  changed: number
  resolved: number
  unchanged: number
}

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

function requestKey(request: ComparisonRequest): string {
  const left = request.left.kind === 'profile'
    ? `profile:${request.left.profile}:${request.left.region}`
    : request.left.kind === 'saved-target'
      ? `target:${request.left.targetId}:${request.left.region}`
      : `session:${request.left.sessionId}:${request.left.region}`
  const right = request.right.kind === 'profile'
    ? `profile:${request.right.profile}:${request.right.region}`
    : request.right.kind === 'saved-target'
      ? `target:${request.right.targetId}:${request.right.region}`
      : `session:${request.right.sessionId}:${request.right.region}`
  return `${left}=>${right}`
}

function rowSignature(row: ComparisonDiffRow): string {
  return JSON.stringify({
    status: row.status,
    risk: row.risk,
    left: row.left,
    right: row.right,
    detailFields: row.detailFields
  })
}

function computeBaselineDelta(result: ComparisonResult | null, baseline: ComparisonBaseline | null): BaselineDeltaCounts | null {
  if (!result || !baseline) return null
  const currentRows = result.groups.flatMap((group) => group.rows)
  const baselineRows = baseline.result.groups.flatMap((group) => group.rows)
  const currentMap = new Map(currentRows.map((row) => [row.id, rowSignature(row)]))
  const baselineMap = new Map(baselineRows.map((row) => [row.id, rowSignature(row)]))

  let added = 0
  let changed = 0
  let unchanged = 0
  let resolved = 0

  for (const [id, signature] of currentMap) {
    if (!baselineMap.has(id)) {
      added += 1
      continue
    }
    if (baselineMap.get(id) === signature) unchanged += 1
    else changed += 1
  }

  for (const id of baselineMap.keys()) {
    if (!currentMap.has(id)) resolved += 1
  }

  return { added, changed, resolved, unchanged }
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
    const targetOptions = connectionState.targets.map((target) => ({
      key: `target:${target.id}`,
      label: `Saved target: ${target.label} (${target.sourceProfile})`,
      requestBase: { kind: 'saved-target' as const, targetId: target.id, label: target.label }
    }))
    const sessionOptions = connectionState.sessions
      .filter((session) => session.status === 'active')
      .map((session) => ({
        key: `session:${session.id}`,
        label: `Session: ${session.label} (${session.accountId || 'unknown'})`,
        requestBase: { kind: 'assumed-role' as const, sessionId: session.id, label: session.label }
      }))

    return [...profileOptions, ...targetOptions, ...sessionOptions]
  }, [connectionState.profiles, connectionState.sessions, connectionState.targets])

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
  const [activeRequest, setActiveRequest] = useState<ComparisonRequest | null>(null)
  const [selectedRowId, setSelectedRowId] = useState('')
  const [viewMode, setViewMode] = useState<CompareViewMode>('flat')
  const [baselines, setBaselines] = useState<ComparisonBaselineSummary[]>([])
  const [selectedBaselineId, setSelectedBaselineId] = useState('')
  const [loadedBaseline, setLoadedBaseline] = useState<ComparisonBaseline | null>(null)
  const [presets, setPresets] = useState<ComparisonPresetSummary[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [loadedPreset, setLoadedPreset] = useState<ComparisonPreset | null>(null)
  const [presetLoading, setPresetLoading] = useState(false)
  const [presetSaving, setPresetSaving] = useState(false)
  const [presetDeleting, setPresetDeleting] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetDescription, setPresetDescription] = useState('')
  const [presetMessage, setPresetMessage] = useState('')
  const [baselineLoading, setBaselineLoading] = useState(false)
  const [baselineSaving, setBaselineSaving] = useState(false)
  const [baselineDeleting, setBaselineDeleting] = useState(false)
  const [baselineName, setBaselineName] = useState('')
  const [baselineDescription, setBaselineDescription] = useState('')
  const [baselineMessage, setBaselineMessage] = useState('')

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
      : seed.request.left.kind === 'saved-target'
        ? `target:${seed.request.left.targetId}`
      : `session:${seed.request.left.sessionId}`
    const nextRightKey = seed.request.right.kind === 'profile'
      ? `profile:${seed.request.right.profile}`
      : seed.request.right.kind === 'saved-target'
        ? `target:${seed.request.right.targetId}`
      : `session:${seed.request.right.sessionId}`

    setLeftKey(nextLeftKey)
    setRightKey(nextRightKey)
    setLeftRegion(seed.request.left.region)
    setRightRegion(seed.request.right.region)
    void handleCompare(seed.request)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token])

  async function refreshBaselines(): Promise<void> {
    try {
      const next = await listComparisonBaselines()
      setBaselines(next)
      setSelectedBaselineId((current) => {
        if (current && next.some((baseline) => baseline.id === current)) return current
        return next[0]?.id ?? ''
      })
    } catch (baselineError) {
      setBaselineMessage(baselineError instanceof Error ? baselineError.message : String(baselineError))
    }
  }

  useEffect(() => {
    void refreshBaselines()
  }, [])

  async function refreshPresets(): Promise<void> {
    try {
      const next = await listComparisonPresets()
      setPresets(next)
      setSelectedPresetId((current) => {
        if (current && next.some((preset) => preset.id === current)) return current
        return next[0]?.id ?? ''
      })
    } catch (presetError) {
      setPresetMessage(presetError instanceof Error ? presetError.message : String(presetError))
    }
  }

  useEffect(() => {
    void refreshPresets()
  }, [])

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
  const baselineDelta = useMemo(() => computeBaselineDelta(result, loadedBaseline), [loadedBaseline, result])
  const baselineMatchesCurrent = useMemo(() => {
    if (!activeRequest || !loadedBaseline) return false
    return requestKey(activeRequest) === requestKey(loadedBaseline.request)
  }, [activeRequest, loadedBaseline])

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
      setActiveRequest(request)
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

  function applyRequestToSelectors(request: ComparisonRequest): void {
    setLeftKey(
      request.left.kind === 'profile'
        ? `profile:${request.left.profile}`
        : request.left.kind === 'saved-target'
          ? `target:${request.left.targetId}`
          : `session:${request.left.sessionId}`
    )
    setRightKey(
      request.right.kind === 'profile'
        ? `profile:${request.right.profile}`
        : request.right.kind === 'saved-target'
          ? `target:${request.right.targetId}`
          : `session:${request.right.sessionId}`
    )
    setLeftRegion(request.left.region)
    setRightRegion(request.right.region)
  }

  async function handleLoadPreset(): Promise<void> {
    if (!selectedPresetId) return
    setPresetLoading(true)
    setPresetMessage('')
    try {
      const preset = await getComparisonPreset(selectedPresetId)
      if (!preset) {
        setLoadedPreset(null)
        setPresetMessage('Selected compare preset no longer exists.')
        await refreshPresets()
        return
      }
      setLoadedPreset(preset)
      applyRequestToSelectors(preset.request)
      setPresetName(preset.name)
      setPresetDescription(preset.description)
      setPresetMessage(`Loaded compare preset "${preset.name}".`)
    } catch (presetError) {
      setPresetMessage(presetError instanceof Error ? presetError.message : String(presetError))
    } finally {
      setPresetLoading(false)
    }
  }

  async function handleSavePreset(): Promise<void> {
    const request = buildRequest()
    if (!request) {
      setPresetMessage('Choose two contexts before saving a compare preset.')
      return
    }
    if (!presetName.trim()) {
      setPresetMessage('Enter a compare preset name.')
      return
    }

    setPresetSaving(true)
    setPresetMessage('')
    try {
      const summary = await saveComparisonPreset({
        id: loadedPreset?.id,
        name: presetName.trim(),
        description: presetDescription.trim(),
        request
      })
      await refreshPresets()
      setSelectedPresetId(summary.id)
      setLoadedPreset(await getComparisonPreset(summary.id))
      setPresetMessage(`Saved compare preset "${summary.name}".`)
    } catch (presetError) {
      setPresetMessage(presetError instanceof Error ? presetError.message : String(presetError))
    } finally {
      setPresetSaving(false)
    }
  }

  async function handleDeletePreset(): Promise<void> {
    if (!selectedPresetId) return
    setPresetDeleting(true)
    setPresetMessage('')
    try {
      await deleteComparisonPreset(selectedPresetId)
      if (loadedPreset?.id === selectedPresetId) {
        setLoadedPreset(null)
      }
      setPresetName('')
      setPresetDescription('')
      await refreshPresets()
      setPresetMessage('Compare preset deleted.')
    } catch (presetError) {
      setPresetMessage(presetError instanceof Error ? presetError.message : String(presetError))
    } finally {
      setPresetDeleting(false)
    }
  }

  async function handleLoadBaseline(): Promise<void> {
    if (!selectedBaselineId) return
    setBaselineLoading(true)
    setBaselineMessage('')
    try {
      const baseline = await getComparisonBaseline(selectedBaselineId)
      if (!baseline) {
        setLoadedBaseline(null)
        setBaselineMessage('Selected baseline no longer exists.')
        await refreshBaselines()
        return
      }
      setLoadedBaseline(baseline)
      applyRequestToSelectors(baseline.request)
      setBaselineName(baseline.name)
      setBaselineDescription(baseline.description)
      setBaselineMessage(`Loaded baseline "${baseline.name}". Run Diff to compare live state against it.`)
    } catch (baselineError) {
      setBaselineMessage(baselineError instanceof Error ? baselineError.message : String(baselineError))
    } finally {
      setBaselineLoading(false)
    }
  }

  async function handleSaveBaseline(): Promise<void> {
    const request = activeRequest ?? buildRequest()
    if (!request || !result) {
      setBaselineMessage('Run a comparison before saving a baseline.')
      return
    }
    if (!baselineName.trim()) {
      setBaselineMessage('Enter a baseline name.')
      return
    }
    setBaselineSaving(true)
    setBaselineMessage('')
    try {
      const summary = await saveComparisonBaseline({
        id: loadedBaseline?.id,
        name: baselineName.trim(),
        description: baselineDescription.trim(),
        request,
        result
      })
      await refreshBaselines()
      setSelectedBaselineId(summary.id)
      setLoadedBaseline(await getComparisonBaseline(summary.id))
      setBaselineMessage(`Saved baseline "${summary.name}".`)
    } catch (baselineError) {
      setBaselineMessage(baselineError instanceof Error ? baselineError.message : String(baselineError))
    } finally {
      setBaselineSaving(false)
    }
  }

  async function handleDeleteBaseline(): Promise<void> {
    if (!selectedBaselineId) return
    setBaselineDeleting(true)
    setBaselineMessage('')
    try {
      await deleteComparisonBaseline(selectedBaselineId)
      if (loadedBaseline?.id === selectedBaselineId) {
        setLoadedBaseline(null)
      }
      setBaselineName('')
      setBaselineDescription('')
      await refreshBaselines()
      setBaselineMessage('Baseline deleted.')
    } catch (baselineError) {
      setBaselineMessage(baselineError instanceof Error ? baselineError.message : String(baselineError))
    } finally {
      setBaselineDeleting(false)
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
            <div className="compare-shell-meta-pill">
              <span>Baseline</span>
              <strong>{loadedBaseline?.name ?? 'None loaded'}</strong>
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
          <div className="compare-shell-stat-card">
            <span>Baseline delta</span>
            <strong>{baselineDelta ? `${baselineDelta.added}/${baselineDelta.changed}/${baselineDelta.resolved}` : 'No baseline'}</strong>
            <small>{baselineDelta ? 'Added / changed / resolved rows against the loaded baseline' : 'Load a baseline to compare current output against a saved snapshot'}</small>
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

      <section className="compare-baseline-panel">
        <div className="compare-pane-head">
          <div>
            <span className="compare-pane-kicker">Saved compare presets</span>
            <h3>Create reusable Session Hub and Compare Workspace context pairs</h3>
          </div>
          <span className="compare-pane-summary">{presets.length} saved</span>
        </div>
        <div className="compare-baseline-grid">
          <label className="field">
            <span>Saved presets</span>
            <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)}>
              <option value="">Select a preset</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.leftLabel} vs {preset.rightLabel})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Preset name</span>
            <input
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder="Prod vs staging roles"
            />
          </label>
          <label className="field compare-baseline-description">
            <span>Description</span>
            <input
              value={presetDescription}
              onChange={(event) => setPresetDescription(event.target.value)}
              placeholder="Optional note about this reusable compare context"
            />
          </label>
        </div>
        <div className="compare-baseline-actions">
          <button type="button" className="tf-toolbar-btn" disabled={!selectedPresetId || presetLoading} onClick={() => void handleLoadPreset()}>
            {presetLoading ? 'Loading...' : 'Load preset'}
          </button>
          <button type="button" className="tf-toolbar-btn accent" disabled={presetSaving} onClick={() => void handleSavePreset()}>
            {presetSaving ? 'Saving...' : (loadedPreset ? 'Update preset' : 'Save current as preset')}
          </button>
          <button type="button" className="tf-toolbar-btn" disabled={!selectedPresetId || presetDeleting} onClick={() => void handleDeletePreset()}>
            {presetDeleting ? 'Deleting...' : 'Delete preset'}
          </button>
        </div>
        <div className="compare-baseline-meta">
          <div className="compare-shell-meta-pill">
            <span>Loaded preset</span>
            <strong>{loadedPreset?.name ?? 'None'}</strong>
          </div>
          <div className="compare-shell-meta-pill">
            <span>Preset request</span>
            <strong>{loadedPreset ? `${loadedPreset.leftLabel} vs ${loadedPreset.rightLabel}` : 'No preset selected'}</strong>
          </div>
          <div className="compare-shell-meta-pill">
            <span>Current selectors</span>
            <strong>{buildRequest() ? 'Ready to save or run' : 'Choose two contexts'}</strong>
          </div>
        </div>
        {presetMessage && <div className="compare-baseline-message">{presetMessage}</div>}
      </section>

      <section className="compare-baseline-panel">
        <div className="compare-pane-head">
          <div>
            <span className="compare-pane-kicker">Baseline snapshots</span>
            <h3>Save, load, and inspect local compare baselines</h3>
          </div>
          <span className="compare-pane-summary">{baselines.length} saved</span>
        </div>
        <div className="compare-baseline-grid">
          <label className="field">
            <span>Saved baselines</span>
            <select value={selectedBaselineId} onChange={(event) => setSelectedBaselineId(event.target.value)}>
              <option value="">Select a baseline</option>
              {baselines.map((baseline) => (
                <option key={baseline.id} value={baseline.id}>
                  {baseline.name} ({baseline.leftLabel} vs {baseline.rightLabel})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Baseline name</span>
            <input
              value={baselineName}
              onChange={(event) => setBaselineName(event.target.value)}
              placeholder="Production weekly snapshot"
            />
          </label>
          <label className="field compare-baseline-description">
            <span>Description</span>
            <input
              value={baselineDescription}
              onChange={(event) => setBaselineDescription(event.target.value)}
              placeholder="Optional note about why this snapshot was captured"
            />
          </label>
        </div>
        <div className="compare-baseline-actions">
          <button type="button" className="tf-toolbar-btn" disabled={!selectedBaselineId || baselineLoading} onClick={() => void handleLoadBaseline()}>
            {baselineLoading ? 'Loading...' : 'Load baseline'}
          </button>
          <button type="button" className="tf-toolbar-btn accent" disabled={baselineSaving || !result} onClick={() => void handleSaveBaseline()}>
            {baselineSaving ? 'Saving...' : (loadedBaseline ? 'Update baseline' : 'Save current as baseline')}
          </button>
          <button type="button" className="tf-toolbar-btn" disabled={!selectedBaselineId || baselineDeleting} onClick={() => void handleDeleteBaseline()}>
            {baselineDeleting ? 'Deleting...' : 'Delete baseline'}
          </button>
        </div>
        <div className="compare-baseline-meta">
          <div className="compare-shell-meta-pill">
            <span>Loaded baseline</span>
            <strong>{loadedBaseline?.name ?? 'None'}</strong>
          </div>
          <div className="compare-shell-meta-pill">
            <span>Baseline request</span>
            <strong>{loadedBaseline ? `${loadedBaseline.leftLabel} vs ${loadedBaseline.rightLabel}` : 'No baseline selected'}</strong>
          </div>
          <div className="compare-shell-meta-pill">
            <span>Live match</span>
            <strong>{loadedBaseline ? (baselineMatchesCurrent ? 'Current selectors match' : 'Selectors differ') : 'Not applicable'}</strong>
          </div>
          <div className="compare-shell-meta-pill">
            <span>Baseline delta</span>
            <strong>{baselineDelta ? `${baselineDelta.added} added, ${baselineDelta.changed} changed, ${baselineDelta.resolved} resolved` : 'Load baseline and run diff'}</strong>
          </div>
        </div>
        {baselineMessage && <div className="compare-baseline-message">{baselineMessage}</div>}
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
          <SvcState variant="no-selection" message="Choose two contexts, then run the diff to load summary totals, inventory deltas, compliance changes, ownership tags, and cost signals." />
        </section>
      )}
    </div>
  )
}
