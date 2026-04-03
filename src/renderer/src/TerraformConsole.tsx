import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './terraform.css'
import { CollapsibleInfoPanel } from './CollapsibleInfoPanel'
import { SvcState, variantForError } from './SvcState'
import { FreshnessIndicator, useFreshnessState } from './freshness'

import type {
  AwsConnection,
  CorrelatedSignalReference,
  GeneratedArtifact,
  ObservabilityPostureReport,
  TerraformActionRow,
  TerraformCliInfo,
  TerraformCommandLog,
  TerraformCommandName,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformDriftStatus,
  TerraformDiagram,
  TerraformGraphEdge,
  TerraformGraphNode,
  TerraformGovernanceCheckResult,
  TerraformGovernanceFinding,
  TerraformGovernanceReport,
  TerraformGovernanceToolkit,
  TerraformInputConfiguration,
  TerraformPlanAction,
  TerraformPlanChange,
  TerraformPlanGroup,
  TerraformPlanOptions,
  TerraformProject,
  TerraformProjectListItem,
  TerraformResourceRow,
  TerraformRunRecord,
  TerraformSecretReference,
  TerraformVariableLayer,
  TerraformVariableSet,
  TerraformWorkspaceSummary,
  ServiceId
} from '@shared/types'
import { openExternalUrl } from './api'
import {
  addProject,
  chooseProjectDirectory,
  chooseVarFile,
  clearSavedPlan,
  createWorkspace,
  deleteRunRecord,
  detectCli,
  detectGovernanceTools,
  detectMissingVars,
  deleteWorkspace,
  getDrift,
  getGovernanceReport,
  getObservabilityReport,
  getProject,
  getRunOutput,
  listProjects,
  listRunHistory,
  openProjectInVsCode,
  reloadProject,
  removeProject,
  renameProject,
  runCommand,
  runGovernanceChecks,
  selectWorkspace,
  setCliKind,
  setSelectedProjectId,
  subscribe,
  unsubscribe,
  updateInputs,
  validateProjectInputs
} from './terraformApi'
import { ObservabilityResilienceLab } from './ObservabilityResilienceLab'

type DetailTab = 'actions' | 'state' | 'resources' | 'drift' | 'lab' | 'history'

type StateOperationDraft =
  | { mode: 'import'; importAddress: string; importId: string }
  | { mode: 'move'; moveFrom: string; moveTo: string }
  | { mode: 'remove'; removeAddress: string }

/* ── db_password validation ───────────────────────────────── */

function validateDbPassword(val: unknown): string | null {
  if (typeof val !== 'string') return 'db_password must be a string'
  if (!val) return 'db_password must not be empty'
  if (/\s/.test(val)) return 'db_password must not contain spaces'
  if (/[/@"]/.test(val)) return 'db_password must not contain /, @, or "'
  if (!/^[\x20-\x7e]+$/.test(val)) return 'db_password must contain only printable ASCII'
  return null
}

function parseVariableValue(text: string): { parsed: unknown; error: string } {
  if (!text.trim()) return { parsed: '', error: '' }
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'db_password' in parsed) {
      const pwErr = validateDbPassword((parsed as Record<string, unknown>).db_password)
      if (pwErr) return { parsed: null, error: pwErr }
    }
    return { parsed, error: '' }
  } catch (err) {
    const trimmed = text.trim()
    if (trimmed === 'true') return { parsed: true, error: '' }
    if (trimmed === 'false') return { parsed: false, error: '' }
    if (trimmed === 'null') return { parsed: null, error: '' }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { parsed: Number(trimmed), error: '' }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      return { parsed: null, error: err instanceof Error ? err.message : 'Invalid JSON' }
    }
    if (trimmed === '') return { parsed: '', error: '' }
    if (trimmed === '""') return { parsed: '', error: '' }
    if (trimmed === "''") return { parsed: '', error: '' }
    if (trimmed === 'db_password') {
      return { parsed: trimmed, error: '' }
    }
    return { parsed: text, error: '' }
  }
}

function formatVariableValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function cloneInputConfig(config: TerraformInputConfiguration): TerraformInputConfiguration {
  return JSON.parse(JSON.stringify(config)) as TerraformInputConfiguration
}

function emptyVariableLayer(): TerraformVariableLayer {
  return { varFile: '', variables: {}, secretRefs: {} }
}

function ensureVariableSet(config: TerraformInputConfiguration): TerraformVariableSet {
  return config.variableSets.find((item) => item.id === config.selectedVariableSetId) ?? config.variableSets[0]
}

function ensureOverlayLayer(config: TerraformInputConfiguration, variableSet: TerraformVariableSet): TerraformVariableLayer {
  if (!config.selectedOverlay) return emptyVariableLayer()
  if (!variableSet.overlays[config.selectedOverlay]) {
    variableSet.overlays[config.selectedOverlay] = emptyVariableLayer()
  }
  return variableSet.overlays[config.selectedOverlay]
}

function variableLayerMode(layer: TerraformVariableLayer, name: string): 'inherit' | 'value' | 'ssm' | 'secret' {
  if (layer.secretRefs[name]) {
    return layer.secretRefs[name].source === 'ssm-parameter' ? 'ssm' : 'secret'
  }
  if (Object.prototype.hasOwnProperty.call(layer.variables, name)) {
    return 'value'
  }
  return 'inherit'
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function cliDisplayName(cliInfo: TerraformCliInfo | null | undefined): string {
  return cliInfo?.label || 'Infrastructure CLI'
}

function formatIsoDate(iso: string): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return iso
  }
}

function formatGitHead(branch: string, shortCommitSha: string, isDetached: boolean): string {
  if (!shortCommitSha) return '-'
  return isDetached ? `${shortCommitSha} (detached HEAD)` : `${branch || '-'} @ ${shortCommitSha}`
}

function gitStatusSummary(project: TerraformProject): string {
  const git = project.metadata.git
  if (!git) return '-'
  if (git.status === 'ready') {
    return `${formatGitHead(git.branch, git.shortCommitSha, git.isDetached)}${git.isDirty ? ' • dirty' : ' • clean'}`
  }
  return git.error || 'Git metadata unavailable.'
}

function planCommitMismatchWarning(project: TerraformProject): string {
  const currentGit = project.metadata.git
  const plannedGit = project.savedPlanMetadata?.git
  if (!currentGit || currentGit.status !== 'ready' || !plannedGit?.commitSha) return ''
  if (currentGit.commitSha === plannedGit.commitSha) return ''
  return `Saved plan was generated from ${plannedGit.shortCommitSha} but the current checkout is ${currentGit.shortCommitSha}. Review the diff before applying; Terraform will still use the saved plan artifact from the older commit.`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function summarizeProjectStatus(project: TerraformProjectListItem): {
  tone: 'success' | 'warning' | 'danger' | 'info'
  label: string
} {
  if (project.status === 'Missing') {
    return { tone: 'danger', label: 'Missing files' }
  }
  if (project.lastPlanSummary?.hasDestructiveChanges || project.lastPlanSummary?.isDeleteHeavy) {
    return { tone: 'warning', label: 'Destructive plan' }
  }
  if (project.lastPlanSummary?.hasChanges) {
    return { tone: 'info', label: 'Pending changes' }
  }
  return { tone: 'success', label: 'Ready' }
}

function formatProjectPath(path: string): string {
  if (path.length <= 56) return path
  return `...${path.slice(-53)}`
}

function truncateMiddle(value: string, options?: { start?: number; end?: number }): string {
  const start = options?.start ?? 20
  const end = options?.end ?? 14
  if (value.length <= start + end + 3) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function formatResourceTagsSummary(tags: string): string {
  if (!tags) return '-'

  try {
    const parsed = JSON.parse(tags) as Record<string, unknown>
    const entries = Object.entries(parsed).filter(([, value]) => value !== undefined && value !== null)
    if (entries.length === 0) return '-'

    const [firstKey, firstValue] = entries[0]
    const firstPair = `${firstKey}=${String(firstValue)}`
    if (entries.length === 1) return firstPair
    if (entries.length === 2) {
      const [secondKey, secondValue] = entries[1]
      return `${firstPair} • ${secondKey}=${String(secondValue)}`
    }
    return `${firstPair} +${entries.length - 1} more`
  } catch {
    return truncateMiddle(tags, { start: 24, end: 16 })
  }
}

const TF_UI_STORAGE_KEY = 'aws-lens:terraform-ui-state'

type TerraformUiState = {
  selectedProjectByContext: Record<string, string>
  detailTabByContext: Record<string, DetailTab>
  driftStatusFilterByProject: Record<string, 'all' | TerraformDriftStatus>
  driftTypeFilterByProject: Record<string, string>
  historyFiltersByProject: Record<string, {
    commandFilter: TerraformCommandName | 'all'
    successFilter: 'all' | 'success' | 'failure'
    projectFilter: 'current' | 'all'
  }>
}

function loadTerraformUiState(): TerraformUiState {
  if (typeof window === 'undefined') {
    return {
      selectedProjectByContext: {},
      detailTabByContext: {},
      driftStatusFilterByProject: {},
      driftTypeFilterByProject: {},
      historyFiltersByProject: {}
    }
  }

  try {
    const raw = window.localStorage.getItem(TF_UI_STORAGE_KEY)
    if (!raw) throw new Error('missing')
    const parsed = JSON.parse(raw) as Partial<TerraformUiState>
    return {
      selectedProjectByContext: parsed.selectedProjectByContext ?? {},
      detailTabByContext: parsed.detailTabByContext ?? {},
      driftStatusFilterByProject: parsed.driftStatusFilterByProject ?? {},
      driftTypeFilterByProject: parsed.driftTypeFilterByProject ?? {},
      historyFiltersByProject: parsed.historyFiltersByProject ?? {}
    }
  } catch {
    return {
      selectedProjectByContext: {},
      detailTabByContext: {},
      driftStatusFilterByProject: {},
      driftTypeFilterByProject: {},
      historyFiltersByProject: {}
    }
  }
}

function saveTerraformUiState(state: TerraformUiState) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(TF_UI_STORAGE_KEY, JSON.stringify(state))
}

function governanceSeverityWeight(severity: TerraformGovernanceFinding['severity']): number {
  return severity === 'critical' ? 5 : severity === 'high' ? 4 : severity === 'medium' ? 3 : severity === 'low' ? 2 : 1
}

function summarizeGovernance(report: TerraformGovernanceReport | null) {
  if (!report) {
    return {
      blockingFailures: 0,
      findings: [] as TerraformGovernanceFinding[],
      findingsByFile: [] as Array<{ file: string; count: number; highestSeverity: TerraformGovernanceFinding['severity'] }>
    }
  }

  const failedBlockingChecks = report.checks.filter((check) => check.blocking && check.status !== 'passed')
  const findings = report.checks
    .flatMap((check) => check.findings)
    .sort((a, b) => governanceSeverityWeight(b.severity) - governanceSeverityWeight(a.severity))

  const byFile = new Map<string, { count: number; highestSeverity: TerraformGovernanceFinding['severity'] }>()
  for (const finding of findings) {
    if (!finding.file) continue
    const existing = byFile.get(finding.file)
    if (!existing) {
      byFile.set(finding.file, { count: 1, highestSeverity: finding.severity })
      continue
    }

    existing.count += 1
    if (governanceSeverityWeight(finding.severity) > governanceSeverityWeight(existing.highestSeverity)) {
      existing.highestSeverity = finding.severity
    }
  }

  return {
    blockingFailures: failedBlockingChecks.length,
    findings,
    findingsByFile: [...byFile.entries()]
      .map(([file, info]) => ({ file, ...info }))
      .sort((a, b) => {
        const severityDelta = governanceSeverityWeight(b.highestSeverity) - governanceSeverityWeight(a.highestSeverity)
        return severityDelta !== 0 ? severityDelta : b.count - a.count
      })
  }
}

function describeRunOutcome(record: TerraformRunRecord): string {
  if (record.success === null) return 'This run is still in progress.'
  if (record.command === 'plan' && record.planSummary) {
    if (!record.success) return 'Terraform could not finish generating a usable plan.'
    if (!record.planSummary.hasChanges) return 'Plan finished cleanly with no actionable infrastructure changes.'
    if (record.planSummary.isDeleteHeavy) return 'Plan succeeded, but the saved plan is delete-heavy and should be reviewed carefully before apply.'
    if (record.planSummary.hasReplacementChanges) return 'Plan succeeded with replacement work. Review replace paths and blast radius before apply.'
    return 'Plan succeeded with a bounded set of changes and no destructive-heavy warning.'
  }
  if (record.command === 'apply') {
    return record.success
      ? 'Apply completed successfully. Treat this as the latest realized project state.'
      : 'Apply failed. Compare the output with drift and state views before retrying.'
  }
  if (record.command === 'destroy') {
    return record.success
      ? 'Destroy completed successfully. Verify any expected removals in drift or state history.'
      : 'Destroy failed. Remaining resources may now need a targeted follow-up or drift review.'
  }
  if (record.command.startsWith('state')) {
    return record.success
      ? 'State operation completed successfully. Validate backups and project state before additional edits.'
      : 'State operation failed. Review the output and current state before attempting another mutation.'
  }
  return record.success ? 'Command completed successfully.' : 'Command failed. Review the output for the exact Terraform error.'
}

  function terraformContextKey(connection: AwsConnection): string {
    return connection.kind === 'profile'
      ? `profile:${connection.profile}`
      : `assumed-role:${connection.sessionId}`
  }

  function connectionForProject(connection: AwsConnection, project: TerraformProject | null): AwsConnection {
    const region = project?.environment.region || connection.region
    return region === connection.region ? connection : { ...connection, region }
  }

/* ── Inputs Dialog ────────────────────────────────────────── */

function InputsDialog({
  project,
  onSave,
  onClose,
  prefillMissing
}: {
  project: TerraformProject
  onSave: (inputConfig: TerraformInputConfiguration) => void
  onClose: () => void
  prefillMissing?: string[]
}) {
  const [config, setConfig] = useState(() => cloneInputConfig(project.inputConfig))
  const [validationError, setValidationError] = useState('')
  const variableSet = ensureVariableSet(config)
  const overlayLayer = ensureOverlayLayer(config, variableSet)
  const overlayOptions = uniqueStrings(['', ...project.inputView.availableOverlays, config.selectedOverlay]).sort((a, b) => a.localeCompare(b))
  const missingNames = useMemo(() => new Set(uniqueStrings([
    ...project.inputView.missingRequired,
    ...(prefillMissing ?? [])
  ])), [project.inputView.missingRequired, prefillMissing])
  const variableNames = useMemo(() => uniqueStrings([
    ...project.inputView.rows.map((row) => row.name),
    ...(prefillMissing ?? [])
  ]).sort((a, b) => {
    const aMissing = missingNames.has(a)
    const bMissing = missingNames.has(b)
    if (aMissing !== bMissing) return aMissing ? -1 : 1
    return a.localeCompare(b)
  }), [missingNames, project.inputView.rows, prefillMissing])

  async function handleBrowse(target: 'base' | 'overlay') {
    const chosen = await chooseVarFile()
    if (!chosen) return
    setConfig((current) => {
      const next = cloneInputConfig(current)
      const nextSet = ensureVariableSet(next)
      const layer = target === 'base' ? nextSet.base : ensureOverlayLayer(next, nextSet)
      layer.varFile = chosen
      return next
    })
  }

  function handleSave() {
    const next = cloneInputConfig(config)
    const selectedSet = ensureVariableSet(next)
    const selectedOverlayLayer = ensureOverlayLayer(next, selectedSet)

    if (!selectedSet.name.trim()) {
      setValidationError('Variable set name is required.')
      return
    }

    for (const name of variableNames) {
      for (const [layerLabel, layer] of [['base', selectedSet.base], ['overlay', selectedOverlayLayer]] as const) {
        if (Object.prototype.hasOwnProperty.call(layer.variables, name) && name === 'db_password') {
          const pwErr = validateDbPassword(layer.variables[name])
          if (pwErr) {
            setValidationError(`${layerLabel} ${name}: ${pwErr}`)
            return
          }
        }
        if (layer.secretRefs[name] && !layer.secretRefs[name].target.trim()) {
          setValidationError(`${layerLabel} ${name}: secret target is required.`)
          return
        }
      }
    }

    setValidationError('')
    onSave(next)
  }

  function updateConfig(mutator: (draft: TerraformInputConfiguration) => void) {
    setConfig((current) => {
      const next = cloneInputConfig(current)
      mutator(next)
      return next
    })
  }

  function updateLayerEntry(
    target: 'base' | 'overlay',
    name: string,
    mode: 'inherit' | 'value' | 'ssm' | 'secret',
    rawValue = ''
  ) {
    updateConfig((next) => {
      const nextSet = ensureVariableSet(next)
      const layer = target === 'base' ? nextSet.base : ensureOverlayLayer(next, nextSet)
      delete layer.variables[name]
      delete layer.secretRefs[name]

      if (mode === 'value') {
        const parsed = parseVariableValue(rawValue)
        if (!parsed.error) {
          layer.variables[name] = parsed.parsed
        }
        return
      }

      if (mode === 'ssm' || mode === 'secret') {
        layer.secretRefs[name] = {
          source: mode === 'ssm' ? 'ssm-parameter' : 'secrets-manager',
          target: rawValue,
          versionId: '',
          jsonKey: '',
          label: ''
        }
      }
    })
  }

  function updateSecretReferenceField(target: 'base' | 'overlay', name: string, field: keyof TerraformSecretReference, value: string) {
    updateConfig((next) => {
      const nextSet = ensureVariableSet(next)
      const layer = target === 'base' ? nextSet.base : ensureOverlayLayer(next, nextSet)
      const current = layer.secretRefs[name]
      if (!current) return
      layer.secretRefs[name] = { ...current, [field]: value }
    })
  }

  function renderLayerEditor(target: 'base' | 'overlay', name: string) {
    const layer = target === 'base' ? variableSet.base : overlayLayer
    const mode = variableLayerMode(layer, name)
    const localValue = Object.prototype.hasOwnProperty.call(layer.variables, name) ? formatVariableValue(layer.variables[name]) : ''
    const secretRef = layer.secretRefs[name]

    return (
      <div className="tf-input-cell">
        <select
          value={mode}
          onChange={(e) => updateLayerEntry(target, name, e.target.value as 'inherit' | 'value' | 'ssm' | 'secret', mode === 'value' ? localValue : secretRef?.target ?? '')}
        >
          <option value="inherit">Inherit</option>
          <option value="value">Local value</option>
          <option value="ssm">SSM ref</option>
          <option value="secret">Secret ref</option>
        </select>
        {mode === 'value' && (
          <textarea
            value={localValue}
            onChange={(e) => {
              const parsed = parseVariableValue(e.target.value)
              if (parsed.error) {
                setValidationError(`${name}: ${parsed.error}`)
                return
              }
              setValidationError('')
              updateLayerEntry(target, name, 'value', e.target.value)
            }}
            placeholder='string, 123, true, {"json":"object"}'
          />
        )}
        {(mode === 'ssm' || mode === 'secret') && secretRef && (
          <div className="tf-secret-ref-fields">
            <input
              value={secretRef.target}
              onChange={(e) => updateSecretReferenceField(target, name, 'target', e.target.value)}
              placeholder={mode === 'ssm' ? '/path/to/parameter' : 'secret-id-or-arn'}
            />
            <div className="tf-secret-ref-grid">
              <input
                value={secretRef.jsonKey}
                onChange={(e) => updateSecretReferenceField(target, name, 'jsonKey', e.target.value)}
                placeholder="JSON key (optional)"
              />
              <input
                value={secretRef.versionId}
                onChange={(e) => updateSecretReferenceField(target, name, 'versionId', e.target.value)}
                placeholder={mode === 'secret' ? 'Version ID (optional)' : 'Label (optional)'}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  function renderQuickMissingEntry(name: string) {
    const writeTarget: 'base' | 'overlay' = config.selectedOverlay ? 'overlay' : 'base'
    const layer = writeTarget === 'base' ? variableSet.base : overlayLayer
    const mode = variableLayerMode(layer, name)
    const localValue = Object.prototype.hasOwnProperty.call(layer.variables, name) ? formatVariableValue(layer.variables[name]) : ''
    const secretRef = layer.secretRefs[name]

    return (
      <div key={name} className="tf-missing-entry-card">
        <div className="tf-missing-entry-head">
          <div>
            <strong>{name}</strong>
            <div className="tf-input-effective-note">
              Writing to {writeTarget === 'overlay' ? `overlay (${config.selectedOverlay})` : `base (${variableSet.name})`}
            </div>
          </div>
          <span className="tf-input-badge required">Missing</span>
        </div>
        <div className="tf-missing-entry-controls">
          <select
            value={mode === 'inherit' ? 'value' : mode}
            onChange={(e) => updateLayerEntry(writeTarget, name, e.target.value as 'value' | 'ssm' | 'secret', mode === 'value' ? localValue : secretRef?.target ?? '')}
          >
            <option value="value">Local value</option>
            <option value="ssm">SSM ref</option>
            <option value="secret">Secret ref</option>
          </select>
          {mode === 'ssm' || mode === 'secret' ? (
            <input
              value={secretRef?.target ?? ''}
              onChange={(e) => {
                if (mode !== 'ssm' && mode !== 'secret') return
                if (!secretRef) {
                  updateLayerEntry(writeTarget, name, mode, e.target.value)
                  return
                }
                updateSecretReferenceField(writeTarget, name, 'target', e.target.value)
              }}
              placeholder={mode === 'ssm' ? '/path/to/parameter' : 'secret-id-or-arn'}
            />
          ) : (
            <input
              value={localValue}
              onChange={(e) => {
                const parsed = parseVariableValue(e.target.value)
                if (parsed.error) {
                  setValidationError(`${name}: ${parsed.error}`)
                  return
                }
                setValidationError('')
                updateLayerEntry(writeTarget, name, 'value', e.target.value)
              }}
              placeholder="Enter required value"
            />
          )}
        </div>
      </div>
    )
  }

  function draftEffectiveInfo(name: string): { source: string; value: string; note: string } {
    const overlaySecret = overlayLayer.secretRefs[name]
    const baseSecret = variableSet.base.secretRefs[name]
    if (overlaySecret) {
      return {
        source: `Overlay secret (${config.selectedOverlay || 'selected'})`,
        value: overlaySecret.target || 'Secret reference',
        note: overlaySecret.source === 'ssm-parameter' ? 'Resolved from SSM at runtime' : 'Resolved from Secrets Manager at runtime'
      }
    }
    if (Object.prototype.hasOwnProperty.call(overlayLayer.variables, name)) {
      return {
        source: `Overlay local (${config.selectedOverlay || 'selected'})`,
        value: formatVariableValue(overlayLayer.variables[name]),
        note: ''
      }
    }
    if (baseSecret) {
      return {
        source: `Variable set secret (${variableSet.name})`,
        value: baseSecret.target || 'Secret reference',
        note: baseSecret.source === 'ssm-parameter' ? 'Resolved from SSM at runtime' : 'Resolved from Secrets Manager at runtime'
      }
    }
    if (Object.prototype.hasOwnProperty.call(variableSet.base.variables, name)) {
      return {
        source: `Variable set local (${variableSet.name})`,
        value: formatVariableValue(variableSet.base.variables[name]),
        note: ''
      }
    }
    const existing = project.inputView.rows.find((item) => item.name === name)
    return {
      source: existing?.effectiveSourceLabel ?? 'Missing',
      value: existing?.effectiveValueSummary ?? '-',
      note: existing?.secretSourceLabel ?? existing?.inheritedFrom ?? ''
    }
  }

  function handleCreateVariableSet() {
    updateConfig((next) => {
      const id = `set-${Date.now()}`
      next.variableSets.push({
        id,
        name: `Variable Set ${next.variableSets.length + 1}`,
        description: '',
        base: emptyVariableLayer(),
        overlays: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
      next.selectedVariableSetId = id
    })
  }

  return (
    <div className="tf-inputs-overlay" onClick={onClose}>
      <div className="tf-inputs-dialog tf-inputs-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Inputs for {project.name}</h3>
        <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>
          Base values stay local, overlays override by environment, and AWS secret refs resolve only at runtime.
        </p>
        {project.inputView.migratedFromLegacy && (
          <p className="tf-inputs-migration-note">
            Existing var file + JSON inputs were migrated into the selected variable set base layer.
          </p>
        )}
        {prefillMissing && prefillMissing.length > 0 && (
          <p className="tf-inputs-warning">
            Required now: {uniqueStrings(prefillMissing).join(', ')}
          </p>
        )}
        {missingNames.size > 0 && (
          <div className="tf-missing-entry-panel">
            <div className="tf-missing-entry-title">Missing Required Inputs</div>
            <div className="tf-missing-entry-list">
              {[...missingNames].sort((a, b) => a.localeCompare(b)).map((name) => renderQuickMissingEntry(name))}
            </div>
          </div>
        )}
        <div className="tf-inputs-toolbar">
          <label>
            Variable Set
            <div className="tf-inline-field">
              <select value={config.selectedVariableSetId} onChange={(e) => updateConfig((next) => { next.selectedVariableSetId = e.target.value })}>
                {config.variableSets.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <button type="button" className="tf-toolbar-btn" onClick={handleCreateVariableSet}>New Set</button>
            </div>
          </label>
          <label>
            Set Name
            <input value={variableSet.name} onChange={(e) => updateConfig((next) => { ensureVariableSet(next).name = e.target.value })} />
          </label>
          <label>
            Environment Overlay
            <div className="tf-inline-field">
              <select value={config.selectedOverlay} onChange={(e) => updateConfig((next) => { next.selectedOverlay = e.target.value })}>
                <option value="">None</option>
                {overlayOptions.filter(Boolean).map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              <input value={config.selectedOverlay} onChange={(e) => updateConfig((next) => { next.selectedOverlay = e.target.value.trim() })} placeholder="dev / stage / prod" />
            </div>
          </label>
        </div>
        <div className="tf-inputs-layout">
          <label>
            Base Var File
            <div className="tf-inline-field">
              <input value={variableSet.base.varFile} onChange={(e) => updateConfig((next) => { ensureVariableSet(next).base.varFile = e.target.value })} placeholder="terraform.tfvars" />
              <button type="button" className="tf-toolbar-btn" onClick={() => void handleBrowse('base')}>Browse</button>
            </div>
          </label>
          <label>
            Overlay Var File
            <div className="tf-inline-field">
              <input value={overlayLayer.varFile} onChange={(e) => updateConfig((next) => { ensureOverlayLayer(next, ensureVariableSet(next)).varFile = e.target.value })} placeholder="env/dev.tfvars" />
              <button type="button" className="tf-toolbar-btn" onClick={() => void handleBrowse('overlay')} disabled={!config.selectedOverlay}>Browse</button>
            </div>
          </label>
        </div>
        <div className="tf-input-grid">
          <div className="tf-input-grid-head">Variable</div>
          <div className="tf-input-grid-head">Base</div>
          <div className="tf-input-grid-head">Overlay</div>
          <div className="tf-input-grid-head">Effective</div>
          {variableNames.map((name) => {
            const row = project.inputView.rows.find((item) => item.name === name)
            const effective = draftEffectiveInfo(name)
            return (
              <Fragment key={name}>
                <div className="tf-input-name-cell">
                  <strong>{name}</strong>
                  <span className={`tf-input-badge ${row?.required ? 'required' : 'optional'}`}>
                    {row?.required ? 'Required' : 'Optional'}
                  </span>
                  {row?.description && <span className="tf-input-description">{row.description}</span>}
                </div>
                {renderLayerEditor('base', name)}
                {renderLayerEditor('overlay', name)}
                <div className="tf-input-effective-cell">
                  <div className="tf-input-effective-source">{effective.source}</div>
                  <div className="tf-input-effective-value">{effective.value || '-'}</div>
                  {effective.note && <div className="tf-input-effective-note">{effective.note}</div>}
                </div>
              </Fragment>
            )
          })}
        </div>
        {validationError && <div className="tf-inputs-error">{validationError}</div>}
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="tf-toolbar-btn accent" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}

function RenameProjectDialog({
  currentName,
  onSave,
  onClose
}: {
  currentName: string
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(currentName)
  const trimmed = name.trim()

  return (
    <div className="tf-inputs-overlay" onClick={onClose}>
      <div className="tf-inputs-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Rename Terraform Project</h3>
        <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>
          This only changes the project label shown inside the app. The folder path is unchanged.
        </p>
        <label>
          Project Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="tf-toolbar-btn accent" onClick={() => onSave(trimmed)} disabled={!trimmed}>Save</button>
        </div>
      </div>
    </div>
  )
}

function WorkspaceCreateDialog({
  currentWorkspace,
  onCreate,
  onClose
}: {
  currentWorkspace: string
  onCreate: (workspaceName: string) => void
  onClose: () => void
}) {
  const [workspaceName, setWorkspaceName] = useState('')
  const trimmed = workspaceName.trim()

  return (
    <div className="tf-inputs-overlay" onClick={onClose}>
      <div className="tf-inputs-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Create Workspace</h3>
        <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>
          Terraform will create the workspace and switch from <strong>{currentWorkspace}</strong> to the new one.
        </p>
        <label>
          Workspace Name
          <input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} autoFocus placeholder="staging" />
        </label>
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="tf-toolbar-btn accent" onClick={() => onCreate(trimmed)} disabled={!trimmed}>Create Workspace</button>
        </div>
      </div>
    </div>
  )
}

function WorkspaceDeleteDialog({
  workspaces,
  onDelete,
  onClose
}: {
  workspaces: TerraformWorkspaceSummary[]
  onDelete: (workspaceName: string) => void
  onClose: () => void
}) {
  const deletable = workspaces.filter((workspace) => !workspace.isCurrent && workspace.name !== 'default')
  const [selectedWorkspace, setSelectedWorkspace] = useState(deletable[0]?.name ?? '')
  const [typed, setTyped] = useState('')

  if (deletable.length === 0) {
    return (
      <div className="tf-inputs-overlay" onClick={onClose}>
        <div className="tf-inputs-dialog" onClick={(e) => e.stopPropagation()}>
          <h3>Delete Workspace</h3>
          <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>
            Only non-default workspaces that are not currently selected can be deleted.
          </p>
          <div className="tf-inputs-buttons">
            <button type="button" className="tf-toolbar-btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="tf-inputs-overlay" onClick={onClose}>
      <div className="tf-inputs-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Delete Workspace</h3>
        <p style={{ margin: 0, fontSize: 12, color: '#ffb3aa' }}>
          This removes the Terraform workspace reference. Terraform will refuse if the backend still has protected state constraints.
        </p>
        <label>
          Workspace
          <select value={selectedWorkspace} onChange={(e) => { setSelectedWorkspace(e.target.value); setTyped('') }}>
            {deletable.map((workspace) => (
              <option key={workspace.name} value={workspace.name}>{workspace.name}</option>
            ))}
          </select>
        </label>
        <label>
          Type Workspace Name To Confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </label>
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="tf-toolbar-btn danger"
            onClick={() => onDelete(selectedWorkspace)}
            disabled={!selectedWorkspace || typed !== selectedWorkspace}
          >
            Delete Workspace
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Typed Confirmation Dialog ────────────────────────────── */

function TypedConfirmDialog({
  title,
  description,
  confirmWord,
  onConfirm,
  onCancel
}: {
  title: string
  description: string
  confirmWord: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  return (
    <div className="tf-confirm-overlay" onClick={onCancel}>
      <div className="tf-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{description}</p>
        <p style={{ fontSize: 12, color: '#e05252' }}>Type <strong>{confirmWord}</strong> to confirm:</p>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="tf-toolbar-btn danger" disabled={typed !== confirmWord} onClick={onConfirm}>{confirmWord}</button>
        </div>
      </div>
    </div>
  )
}

/* ── Summary Confirmation Dialog ──────────────────────────── */

const ACTION_COLORS: Record<string, string> = {
  create: '#2ecc71', update: '#f39c12', delete: '#e74c3c', replace: '#9b59b6', 'no-op': '#5a6a7a'
}

const PLAN_MODE_LABELS: Record<Exclude<TerraformPlanOptions['mode'], undefined>, string> = {
  standard: 'Standard saved plan',
  'refresh-only': 'Refresh-only plan',
  targeted: 'Targeted plan',
  replace: 'Replace plan'
}

function actionSymbol(action: TerraformPlanAction): string {
  if (action === 'create') return '+'
  if (action === 'delete') return '-'
  if (action === 'update') return '~'
  if (action === 'replace') return '±'
  return '·'
}

function parsePlanAddressList(text: string): string[] {
  return [...new Set(
    text
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
  )]
}

function groupLabel(groupBy: 'module' | 'action' | 'resource-type'): string {
  if (groupBy === 'module') return 'Module'
  if (groupBy === 'action') return 'Action'
  return 'Resource type'
}

function emptyPlanSummary(mode: NonNullable<TerraformPlanOptions['mode']> = 'standard'): TerraformProject['lastPlanSummary'] {
  return {
    create: 0,
    update: 0,
    delete: 0,
    replace: 0,
    noop: 0,
    hasChanges: false,
    affectedResources: 0,
    affectedModules: [],
    affectedProviders: [],
    affectedServices: [],
    groups: { byModule: [], byAction: [], byResourceType: [] },
    jsonFieldsUsed: [],
    heuristicNotes: [],
    hasDestructiveChanges: false,
    hasReplacementChanges: false,
    isDeleteHeavy: false,
    request: { mode, targets: [], replaceAddresses: [] }
  }
}

function SummaryConfirmDialog({
  title,
  summary,
  changes,
  onConfirm,
  onCancel
}: {
  title: string
  summary: { create: number; update: number; delete: number; replace: number; noop: number }
  changes?: TerraformPlanChange[]
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="tf-confirm-overlay" onClick={onCancel}>
      <div className="tf-confirm-dialog wide" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="tf-summary">
          <span className="tf-summary-item"><span className="tf-summary-count create">{summary.create}</span> create</span>
          <span className="tf-summary-item"><span className="tf-summary-count update">{summary.update}</span> update</span>
          <span className="tf-summary-item"><span className="tf-summary-count delete">{summary.delete}</span> delete</span>
          <span className="tf-summary-item"><span className="tf-summary-count replace">{summary.replace}</span> replace</span>
        </div>
        {changes && changes.length > 0 && (
          <div className="tf-change-list">
            {changes.filter(c => c.actionLabel !== 'no-op').map((c) => (
              <div key={c.address} className="tf-change-item">
                <span className="tf-change-action" style={{ color: ACTION_COLORS[c.actionLabel] ?? '#9ca7b7' }}>
                  {c.actionLabel === 'create' ? '+' : c.actionLabel === 'delete' ? '-' : c.actionLabel === 'update' ? '~' : '±'} {c.actionLabel}
                </span>
                <span className="tf-change-address">{c.address}</span>
                <span className="tf-change-type">{c.type}</span>
              </div>
            ))}
          </div>
        )}
        <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>Review the changes above before proceeding.</p>
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="tf-toolbar-btn accent" onClick={onConfirm}>Continue</button>
        </div>
      </div>
    </div>
  )
}

/* ── Diagram Component ────────────────────────────────────── */

const NODE_W = 260
const NODE_H = 44
const LAYER_GAP_X = 100
const SLOT_GAP_Y = 18

/* Colour palette – action types get vivid fills so create/delete/update
   are obvious at a glance, while "existing resource" stays muted. */
const CATEGORY_STYLE: Record<string, { fill: string; stroke: string; text: string; badge: string }> = {
  create:     { fill: '#15352a', stroke: '#2ecc71', text: '#5ef5a0', badge: '+ create' },
  update:     { fill: '#352b15', stroke: '#f39c12', text: '#ffd080', badge: '~ update' },
  delete:     { fill: '#351919', stroke: '#e74c3c', text: '#ff9e8e', badge: '- delete' },
  replace:    { fill: '#2b1535', stroke: '#9b59b6', text: '#d3a4f0', badge: 'replace' },
  'no-op':    { fill: '#1e232b', stroke: '#3b4350', text: '#8898a8', badge: '' },
  resource:   { fill: '#1e232b', stroke: '#4a8fe7', text: '#a0c4f0', badge: '' },
  dependency: { fill: '#1e232b', stroke: '#5a6a7a', text: '#8898a8', badge: '' },
  config:     { fill: '#1e232b', stroke: '#5a6a7a', text: '#8898a8', badge: '' },
}

const EDGE_COLORS: Record<string, string> = {
  depends_on: 'rgba(74,143,231,0.55)',
  reference:  'rgba(223,105,42,0.40)',
  inferred:   'rgba(155,89,182,0.40)',
}

function styleFor(category: string) {
  return CATEGORY_STYLE[category] ?? CATEGORY_STYLE.resource
}

/* ── Layered layout with crossing minimisation ────────────── */

function computeLayout(diagram: TerraformDiagram): {
  positions: Map<string, { x: number; y: number; layer: number; slot: number }>
  layers: string[][]
  width: number
  height: number
} {
  type Pos = { x: number; y: number; layer: number; slot: number }
  const positions = new Map<string, Pos>()
  if (diagram.nodes.length === 0) return { positions, layers: [], width: 500, height: 300 }

  const ids = new Set(diagram.nodes.map((n) => n.id))
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  for (const n of diagram.nodes) { incoming.set(n.id, new Set()); outgoing.set(n.id, new Set()) }
  for (const e of diagram.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    incoming.get(e.to)!.add(e.from)
    outgoing.get(e.from)!.add(e.to)
  }

  /* 1 ── longest-path layer assignment ─────────────────── */
  const depth = new Map<string, number>()
  function walk(id: string, visited: Set<string>): number {
    if (depth.has(id)) return depth.get(id)!
    if (visited.has(id)) return 0 // cycle guard
    visited.add(id)
    let maxParent = -1
    for (const p of incoming.get(id) ?? []) maxParent = Math.max(maxParent, walk(p, visited))
    const d = maxParent + 1
    depth.set(id, d)
    return d
  }
  for (const n of diagram.nodes) walk(n.id, new Set())

  const maxLayer = Math.max(0, ...Array.from(depth.values()))
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
  for (const n of diagram.nodes) layers[depth.get(n.id) ?? 0].push(n.id)

  /* 2 ── barycentric ordering (reduces crossings) ──────── */
  for (let pass = 0; pass < 4; pass++) {
    for (let li = 1; li <= maxLayer; li++) {
      const layer = layers[li]
      const bary = new Map<string, number>()
      for (const id of layer) {
        const parents = [...(incoming.get(id) ?? [])]
          .map((p) => layers[depth.get(p) ?? 0].indexOf(p))
          .filter((i) => i >= 0)
        bary.set(id, parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : 0)
      }
      layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
    }
    // reverse pass
    for (let li = maxLayer - 1; li >= 0; li--) {
      const layer = layers[li]
      const bary = new Map<string, number>()
      for (const id of layer) {
        const children = [...(outgoing.get(id) ?? [])]
          .map((c) => layers[depth.get(c) ?? 0].indexOf(c))
          .filter((i) => i >= 0)
        bary.set(id, children.length > 0 ? children.reduce((a, b) => a + b, 0) / children.length : 0)
      }
      layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
    }
  }

  /* 3 ── position each node on the canvas ──────────────── */
  const PAD = 30
  let maxSlotCount = 0
  for (let li = 0; li <= maxLayer; li++) {
    maxSlotCount = Math.max(maxSlotCount, layers[li].length)
    for (let si = 0; si < layers[li].length; si++) {
      positions.set(layers[li][si], {
        x: PAD + li * (NODE_W + LAYER_GAP_X),
        y: PAD + si * (NODE_H + SLOT_GAP_Y),
        layer: li, slot: si
      })
    }
  }

  const width = PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * LAYER_GAP_X
  const height = PAD * 2 + maxSlotCount * NODE_H + (maxSlotCount - 1) * SLOT_GAP_Y
  return { positions, layers, width: Math.max(500, width), height: Math.max(300, height) }
}

/* SVG cubic-bezier edge that exits the right side of `from` and
   enters the left side of `to`, with smooth horizontal tangents.
   Port offsets are spread vertically when a node has many edges
   so lines don't pile on top of each other. */

function buildEdgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromPortOffset: number,
  toPortOffset: number
): string {
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2 + fromPortOffset
  const x2 = to.x
  const y2 = to.y + NODE_H / 2 + toPortOffset

  if (x1 < x2) {
    // Normal left-to-right: smooth bezier
    const cx = (x1 + x2) / 2
    return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`
  }
  // Back edge (cycle or same-layer): route around
  const lift = 30
  const cx1 = x1 + 40
  const cx2 = x2 - 40
  const midY = Math.min(y1, y2) - lift - Math.abs(y1 - y2) * 0.15
  return `M${x1},${y1} C${cx1},${y1} ${cx1},${midY} ${(x1 + x2) / 2},${midY} S${cx2},${y2} ${x2},${y2}`
}

function DiagramView({ diagram }: { diagram: TerraformDiagram }) {
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  /* reset view when data changes */
  useEffect(() => { setZoom(100); setPan({ x: 0, y: 0 }) }, [diagram])

  const { positions, width, height } = useMemo(() => computeLayout(diagram), [diagram])

  /* ── mouse pan ─────────────────────────────────────────── */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // only left button, and not on a control button
    if (e.button !== 0) return
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
    e.preventDefault()
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy })
  }, [])

  const handleMouseUp = useCallback(() => {
    dragging.current = false
  }, [])

  /* stop drag if mouse leaves the window entirely */
  useEffect(() => {
    const stop = () => { dragging.current = false }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  /* ── disable wheel zoom – only buttons control zoom ──── */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
  }, [])

  function handleResetView() {
    setZoom(100)
    setPan({ x: 0, y: 0 })
  }

  /* pre-compute port offsets so that multiple edges from/to a single
     node spread out vertically instead of overlapping */
  const portOffsets = useMemo(() => {
    const outCount = new Map<string, number>()
    const inCount = new Map<string, number>()
    const outIdx = new Map<string, number>()
    const inIdx = new Map<string, number>()
    for (const e of diagram.edges) {
      outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1)
      inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1)
    }
    const offsets: Array<{ fromOff: number; toOff: number }> = []
    const SPREAD = 4
    for (const e of diagram.edges) {
      const oTotal = outCount.get(e.from) ?? 1
      const oI = outIdx.get(e.from) ?? 0
      outIdx.set(e.from, oI + 1)
      const iTotal = inCount.get(e.to) ?? 1
      const iI = inIdx.get(e.to) ?? 0
      inIdx.set(e.to, iI + 1)
      offsets.push({
        fromOff: (oI - (oTotal - 1) / 2) * SPREAD,
        toOff:   (iI - (iTotal - 1) / 2) * SPREAD
      })
    }
    return offsets
  }, [diagram.edges])

  /* build the set of edge ids connected to the hovered node */
  const connectedEdges = useMemo(() => {
    if (!hoveredNode) return null
    const set = new Set<number>()
    diagram.edges.forEach((e, i) => {
      if (e.from === hoveredNode || e.to === hoveredNode) set.add(i)
    })
    return set
  }, [hoveredNode, diagram.edges])

  const connectedNodes = useMemo(() => {
    if (!hoveredNode) return null
    const set = new Set<string>([hoveredNode])
    for (const e of diagram.edges) {
      if (e.from === hoveredNode) set.add(e.to)
      if (e.to === hoveredNode) set.add(e.from)
    }
    return set
  }, [hoveredNode, diagram.edges])

  if (diagram.nodes.length === 0) {
    return <div className="tf-diagram-container"><SvcState variant="empty" message="No resources to display. Run Plan or load state to build the diagram." /></div>
  }

  const scale = zoom / 100

  /* Category legend entries */
  const legendEntries = Array.from(
    new Map(diagram.nodes.map((n) => [n.category, styleFor(n.category)])).entries()
  ).filter(([cat]) => CATEGORY_STYLE[cat]?.badge || ['resource', 'dependency'].includes(cat))

  return (
    <div
      ref={containerRef}
      className={`tf-diagram-container ${fullscreen ? 'fullscreen' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
    >
      <div className="tf-diagram-controls">
        <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? 'Exit' : 'Full'}</button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.max(15, z - 15))}>-</button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={handleResetView}>{zoom}%</button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.min(400, z + 15))}>+</button>
      </div>
      {/* colour legend */}
      <div className="tf-diagram-legend" onMouseDown={(e) => e.stopPropagation()}>
        {legendEntries.map(([cat, s]) => (
          <span key={cat} className="tf-diagram-legend-item">
            <span className="tf-diagram-legend-swatch" style={{ background: s.stroke }} />
            {s.badge || cat}
          </span>
        ))}
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.depends_on }} />depends_on</span>
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.reference }} />reference</span>
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.inferred }} />inferred</span>
      </div>
      <svg
        className="tf-diagram-svg"
        viewBox={`0 0 ${width} ${height}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: '0 0',
          width,
          height,
          userSelect: 'none'
        }}
      >
        <defs>
          {/* Coloured arrowheads for each relation type */}
          <marker id="tf-arr-depends_on" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.depends_on} />
          </marker>
          <marker id="tf-arr-reference" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.reference} />
          </marker>
          <marker id="tf-arr-inferred" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.inferred} />
          </marker>
        </defs>

        {/* ── edges ── */}
        {diagram.edges.map((edge, i) => {
          const from = positions.get(edge.from)
          const to = positions.get(edge.to)
          if (!from || !to) return null
          const { fromOff, toOff } = portOffsets[i]
          const d = buildEdgePath(from, to, fromOff, toOff)
          const color = EDGE_COLORS[edge.relation] ?? EDGE_COLORS.depends_on
          const dimmed = connectedEdges && !connectedEdges.has(i)
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={dimmed ? 1 : 1.5}
              strokeDasharray={edge.relation === 'inferred' ? '6,3' : undefined}
              markerEnd={`url(#tf-arr-${edge.relation in EDGE_COLORS ? edge.relation : 'depends_on'})`}
              opacity={dimmed ? 0.12 : 1}
              style={{ transition: 'opacity 0.15s' }}
            />
          )
        })}

        {/* ── nodes ── */}
        {diagram.nodes.map((node) => {
          const pos = positions.get(node.id)
          if (!pos) return null
          const s = styleFor(node.category)
          const dimmed = connectedNodes && !connectedNodes.has(node.id)
          const label = node.id
          const badgeText = s.badge
          return (
            <g
              key={node.id}
              transform={`translate(${pos.x},${pos.y})`}
              opacity={dimmed ? 0.25 : 1}
              style={{ transition: 'opacity 0.15s', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              <rect width={NODE_W} height={NODE_H} rx="6" fill={s.fill} stroke={s.stroke} strokeWidth="1.5" />
              {/* Action badge (top-right corner) */}
              {badgeText && (
                <>
                  <rect x={NODE_W - 62} y={4} width={56} height={16} rx="3" fill={s.stroke} opacity={0.85} />
                  <text x={NODE_W - 34} y={15} fill="#0f1114" fontSize="9" fontWeight="700" textAnchor="middle" fontFamily="system-ui">{badgeText}</text>
                </>
              )}
              {/* Resource address – full text, clipped to node width */}
              <clipPath id={`clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')}`}>
                <rect x="8" y="0" width={badgeText ? NODE_W - 72 : NODE_W - 16} height={NODE_H} />
              </clipPath>
              <text
                x={10} y={badgeText ? NODE_H / 2 + 5 : NODE_H / 2 + 4}
                fill={s.text} fontSize="11" fontFamily='"Cascadia Code","Fira Code",monospace'
                clipPath={`url(#clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')})`}
              >
                {label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ── Actions Tab ──────────────────────────────────────────── */

function PlanGroupList({
  groups,
  changesByAddress
}: {
  groups: TerraformPlanGroup[]
  changesByAddress: Map<string, TerraformPlanChange>
}) {
  return (
    <div className="tf-plan-group-list">
      {groups.map((group) => (
        <div key={`${group.kind}:${group.key}`} className="tf-plan-group-card">
          <div className="tf-plan-group-head">
            <div>
              <div className="tf-plan-group-label">{group.label}</div>
              <div className="tf-section-hint">{group.count} affected resource{group.count === 1 ? '' : 's'}</div>
            </div>
            <div className="tf-summary">
              <span className="tf-summary-item"><span className="tf-summary-count create">{group.summary.create}</span>create</span>
              <span className="tf-summary-item"><span className="tf-summary-count update">{group.summary.update}</span>update</span>
              <span className="tf-summary-item"><span className="tf-summary-count delete">{group.summary.delete}</span>delete</span>
              <span className="tf-summary-item"><span className="tf-summary-count replace">{group.summary.replace}</span>replace</span>
            </div>
          </div>
          <div className="tf-plan-group-resources">
            {group.resources.slice(0, 8).map((address) => {
              const change = changesByAddress.get(address)
              if (!change) return null
              return (
                <div key={address} className={`tf-plan-change-card compact ${change.isReplacement ? 'replace' : change.isDestructive ? 'destructive' : ''}`}>
                  <div className="tf-plan-change-title">
                    <span className={`tf-plan-action-badge ${change.actionLabel}`}>{actionSymbol(change.actionLabel)} {change.actionLabel}</span>
                    <span className="tf-plan-change-address">{change.address}</span>
                  </div>
                </div>
              )
            })}
            {group.resources.length > 8 && (
              <div className="tf-section-hint">+{group.resources.length - 8} more resources in this group</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Governance / Safety Panel ────────────────────────────── */

const CHECK_STATUS_ICON: Record<string, string> = {
  passed: '\u2713',
  failed: '\u2717',
  skipped: '\u2014',
  error: '!'
}

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  info: 'INFO'
}

function GovernancePanel({
  toolkit,
  report,
  running,
  onRunChecks,
  onDetectTools
}: {
  toolkit: TerraformGovernanceToolkit | null
  report: TerraformGovernanceReport | null
  running: boolean
  onRunChecks: () => void
  onDetectTools: () => void
}) {
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null)

  const hasAnyTool = toolkit?.tools.some((t) => t.available) ?? false
  const governanceSummary = useMemo(() => summarizeGovernance(report), [report])

  return (
    <div className="tf-section tf-governance-panel">
      <div className="tf-section-head">
        <div>
          <h3>Safety Checks</h3>
          {!toolkit?.detectedAt && (
            <div className="tf-section-hint">Detect available tools to enable governance checks.</div>
          )}
        </div>
        <div className="tf-governance-actions">
          {toolkit?.detectedAt ? (
            <button className="tf-toolbar-btn accent" disabled={running || !hasAnyTool} onClick={onRunChecks}>
              {running ? 'Running...' : 'Run Checks'}
            </button>
          ) : (
            <button className="tf-toolbar-btn" onClick={onDetectTools}>Detect Tools</button>
          )}
        </div>
      </div>

      {/* Tool availability */}
      {toolkit?.detectedAt && (
        <div className="tf-governance-tools">
          {toolkit.tools.map((tool) => (
            <span
              key={tool.id}
              className={`tf-governance-tool-badge ${tool.available ? 'available' : 'missing'}`}
              title={tool.available ? `${tool.label} v${tool.version}` : `${tool.label} not found`}
            >
              {tool.available ? '\u2713' : '\u2014'} {tool.label}
              {!tool.available && !tool.required && <span className="tf-governance-optional"> (optional)</span>}
            </span>
          ))}
          <button
            className="tf-governance-rescan"
            onClick={onDetectTools}
            title="Re-detect tools"
          >
            Rescan
          </button>
        </div>
      )}

      {/* Check results */}
      {report && (
        <div className="tf-governance-results">
          <div className="tf-governance-summary-row">
            <span className={`tf-governance-verdict ${report.allBlockingPassed ? 'pass' : 'fail'}`}>
              {report.allBlockingPassed ? '\u2713 All blocking checks passed' : '\u2717 Blocking check(s) failed'}
            </span>
            <span className="tf-governance-timestamp">
              {new Date(report.ranAt).toLocaleTimeString()}
            </span>
          </div>

          <div className="tf-governance-summary-grid">
            <div className="tf-governance-summary-card">
              <div className="tf-plan-summary-label">Blocking Status</div>
              <strong>{governanceSummary.blockingFailures === 0 ? 'Ready' : `${governanceSummary.blockingFailures} failed`}</strong>
              <span>{governanceSummary.blockingFailures === 0 ? 'Required checks are clear.' : 'Apply and destroy stay blocked until fixed.'}</span>
            </div>
            <div className="tf-governance-summary-card">
              <div className="tf-plan-summary-label">Findings</div>
              <strong>{governanceSummary.findings.length}</strong>
              <span>{governanceSummary.findingsByFile.length} file{governanceSummary.findingsByFile.length === 1 ? '' : 's'} affected</span>
            </div>
          </div>

          {governanceSummary.findingsByFile.length > 0 && (
            <div className="tf-governance-file-list">
              {governanceSummary.findingsByFile.slice(0, 6).map((item) => (
                <div key={item.file} className="tf-governance-file-card">
                  <span className={`tf-governance-severity ${item.highestSeverity}`}>
                    {SEVERITY_LABELS[item.highestSeverity] ?? item.highestSeverity}
                  </span>
                  <div className="tf-governance-file-meta">
                    <strong>{item.file}</strong>
                    <span>{item.count} finding{item.count === 1 ? '' : 's'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {report.checks.map((check) => (
            <div
              key={check.toolId}
              className={`tf-governance-check ${check.status}`}
            >
              <div
                className="tf-governance-check-header"
                onClick={() => setExpandedCheck(expandedCheck === check.toolId ? null : check.toolId)}
              >
                <span className={`tf-governance-check-icon ${check.status}`}>
                  {CHECK_STATUS_ICON[check.status] ?? '?'}
                </span>
                <span className="tf-governance-check-label">{check.label}</span>
                {check.blocking && <span className="tf-governance-blocking-badge">blocking</span>}
                <span className="tf-governance-check-summary">{check.summary}</span>
                <span className="tf-governance-check-duration">{check.durationMs}ms</span>
                <span className="tf-governance-check-expand">
                  {expandedCheck === check.toolId ? '\u25BC' : '\u25B6'}
                </span>
              </div>

              {expandedCheck === check.toolId && (
                <div className="tf-governance-check-detail">
                  {check.findings.length > 0 && (
                    <div className="tf-governance-findings">
                      {check.findings.slice(0, 50).map((f, i) => (
                        <div key={i} className={`tf-governance-finding ${f.severity}`}>
                          <span className={`tf-governance-severity ${f.severity}`}>
                            {SEVERITY_LABELS[f.severity] ?? f.severity}
                          </span>
                          <span className="tf-governance-finding-msg">{f.message}</span>
                          {f.file && (
                            <span className="tf-governance-finding-loc">
                              {f.file}{f.line > 0 ? `:${f.line}` : ''}
                            </span>
                          )}
                        </div>
                      ))}
                      {check.findings.length > 50 && (
                        <div className="tf-governance-finding-overflow">
                          ...and {check.findings.length - 50} more
                        </div>
                      )}
                    </div>
                  )}
                  {check.output && (
                    <details className="tf-governance-raw-output">
                      <summary>Raw output</summary>
                      <pre>{check.output}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionsTab({
  project,
  cliOk,
  cliLabel,
  running,
  lastLog,
  onInit,
  onPlan,
  onApply,
  onDestroy,
  governanceToolkit,
  governanceReport,
  governanceRunning,
  onRunGovernanceChecks,
  onDetectGovernanceTools,
  onOpenDriftTab
}: {
  project: TerraformProject
  cliOk: boolean
  cliLabel: string
  running: boolean
  lastLog: TerraformCommandLog | null
  onInit: () => void
  onPlan: (options?: TerraformPlanOptions) => void
  onApply: () => void
  onDestroy: () => void
  governanceToolkit: TerraformGovernanceToolkit | null
  governanceReport: TerraformGovernanceReport | null
  governanceRunning: boolean
  onRunGovernanceChecks: () => void
  onDetectGovernanceTools: () => void
  onOpenDriftTab: () => void
}) {
  const [outputOpen, setOutputOpen] = useState(false)
  const [showPlanControls, setShowPlanControls] = useState(false)
  const [advancedMode, setAdvancedMode] = useState<'refresh-only' | 'targeted' | 'replace'>('refresh-only')
  const [targetText, setTargetText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [actionFilter, setActionFilter] = useState<'all' | TerraformPlanAction>('all')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [groupBy, setGroupBy] = useState<'module' | 'action' | 'resource-type'>('module')

  const s = project.lastPlanSummary
  const hasSavedPlan = project.hasSavedPlan
  const governanceBlocked = governanceReport ? !governanceReport.allBlockingPassed : false
  const moduleOptions = useMemo(() => ['all', ...project.lastPlanSummary.affectedModules], [project.lastPlanSummary.affectedModules])
  const typeOptions = useMemo(
    () => ['all', ...[...new Set(project.planChanges.filter((change) => change.actionLabel !== 'no-op').map((change) => change.type))].sort()],
    [project.planChanges]
  )
  const filteredChanges = useMemo(
    () => project.planChanges.filter((change) =>
      change.actionLabel !== 'no-op'
      && (actionFilter === 'all' || change.actionLabel === actionFilter)
      && (moduleFilter === 'all' || change.modulePath === moduleFilter)
      && (typeFilter === 'all' || change.type === typeFilter)
    ),
    [project.planChanges, actionFilter, moduleFilter, typeFilter]
  )
  const changesByAddress = useMemo(() => new Map(project.planChanges.map((change) => [change.address, change])), [project.planChanges])
  const applyWarning = planCommitMismatchWarning(project)
  const governanceSummary = useMemo(() => summarizeGovernance(governanceReport), [governanceReport])
  const groupedChanges = useMemo(() => {
    const source = groupBy === 'module'
      ? s.groups.byModule
      : groupBy === 'action'
        ? s.groups.byAction
        : s.groups.byResourceType
    const filteredAddresses = new Set(filteredChanges.map((change) => change.address))
    return source
      .map((group) => ({ ...group, resources: group.resources.filter((address) => filteredAddresses.has(address)) }))
      .filter((group) => group.resources.length > 0)
  }, [filteredChanges, groupBy, s.groups])

  const advancedAddresses = advancedMode === 'targeted'
    ? parsePlanAddressList(targetText)
    : parsePlanAddressList(replaceText)
  const canRunAdvancedPlan = advancedMode === 'refresh-only' || advancedAddresses.length > 0
  const destructiveSignal = s.isDeleteHeavy || s.hasDestructiveChanges
  const topFindings = governanceSummary.findings.slice(0, 3)
  const readinessTone = !cliOk
    ? 'blocked'
    : !hasSavedPlan
      ? 'attention'
      : governanceBlocked || applyWarning || destructiveSignal
        ? 'warning'
        : 'ready'
  const readinessTitle = !cliOk
    ? `${cliLabel} unavailable`
    : !hasSavedPlan
      ? 'Run a saved plan before apply'
      : governanceBlocked
        ? 'Fix blocking governance findings'
        : applyWarning
          ? 'Saved plan is behind the current checkout'
          : destructiveSignal
            ? 'High-impact plan requires review'
            : 'Safe to continue to apply review'
  const readinessBody = !cliOk
    ? 'Infrastructure actions remain disabled until a supported CLI is detected.'
    : !hasSavedPlan
      ? 'Apply and destroy stay disabled until a saved plan exists for this project and workspace.'
      : governanceBlocked
        ? 'Required safety checks failed. Resolve the linked findings and rerun Safety Checks.'
        : applyWarning
          ? applyWarning
          : destructiveSignal
            ? 'Delete-heavy or destructive changes were detected. Review the blast radius before confirming.'
            : 'Required checks are clear and the current saved plan can be reviewed for apply.'

  return (
    <>
      <div className="tf-section">
        <div className="tf-section-head">
          <div>
            <h3>Actions</h3>
            <div className="tf-section-hint">Default path: update inputs if needed, generate a saved plan, review the summary, then apply.</div>
          </div>
        </div>
        <div className={`tf-readiness-banner ${readinessTone}`}>
          <div className="tf-readiness-copy">
            <span className="tf-plan-summary-label">Safe To Apply?</span>
            <strong>{readinessTitle}</strong>
            <span>{readinessBody}</span>
          </div>
          <div className="tf-readiness-metrics">
            <div><strong>{hasSavedPlan ? 'Yes' : 'No'}</strong><span>saved plan</span></div>
            <div><strong>{governanceSummary.blockingFailures}</strong><span>blocking failures</span></div>
            <div><strong>{s.affectedResources}</strong><span>resources touched</span></div>
          </div>
        </div>
        <div className="tf-primary-action-area">
          <div className="tf-primary-action-stack">
            <button className="tf-action-btn init" disabled={!cliOk || running} onClick={onInit}>Init</button>
            <button className="tf-action-btn plan primary" disabled={!cliOk || running} onClick={() => onPlan()}>Run Saved Plan</button>
          </div>
          <div className="tf-primary-action-stack tf-primary-action-stack-commit">
            <button
              className={`tf-action-btn apply primary${governanceBlocked ? ' governance-blocked' : ''}`}
              disabled={!cliOk || running || !hasSavedPlan || governanceBlocked}
              onClick={onApply}
              title={!hasSavedPlan ? 'Run Plan first to enable Apply.' : governanceBlocked ? 'Blocked: governance checks failed.' : undefined}
            >
              Apply Saved Plan
            </button>
            <button
              className={`tf-action-btn destroy${governanceBlocked ? ' governance-blocked' : ''}`}
              disabled={!cliOk || running || !hasSavedPlan || governanceBlocked}
              onClick={onDestroy}
              title={!hasSavedPlan ? 'Run Plan first to enable Destroy.' : governanceBlocked ? 'Blocked: governance checks failed.' : undefined}
            >
              Destroy
            </button>
          </div>
        </div>
        <div className="tf-plan-controls-toggle-row">
          <button type="button" className="tf-toolbar-btn" onClick={() => setShowPlanControls((value) => !value)} disabled={!cliOk || running}>
            {showPlanControls ? 'Hide advanced plan controls' : 'Show advanced plan controls'}
          </button>
          {!hasSavedPlan && (
            <div className="tf-section-hint">Run Plan first. Apply and Destroy stay disabled until a saved plan exists.</div>
          )}
          {governanceBlocked && (
            <div className="tf-section-hint" style={{ color: '#e74c3c' }}>Apply/Destroy blocked: required governance check(s) failed. Fix issues and re-run Safety Checks.</div>
          )}
        </div>
        {applyWarning && (
          <div className="tf-section-hint" style={{ color: '#d35400' }}>{applyWarning}</div>
        )}
        {showPlanControls && (
          <div className="tf-plan-controls">
            <div className="tf-plan-mode-row">
              <button type="button" className={advancedMode === 'refresh-only' ? 'active' : ''} onClick={() => setAdvancedMode('refresh-only')}>Refresh-only</button>
              <button type="button" className={advancedMode === 'targeted' ? 'active' : ''} onClick={() => setAdvancedMode('targeted')}>Targeted</button>
              <button type="button" className={advancedMode === 'replace' ? 'active' : ''} onClick={() => setAdvancedMode('replace')}>Replace</button>
            </div>
            <div className="tf-section-hint">
              {advancedMode === 'refresh-only' && 'Refresh-only reads remote objects and updates state without proposing infrastructure mutations.'}
              {advancedMode === 'targeted' && 'Targeted plans should be used sparingly. Enter one resource address per line or comma-separated.'}
              {advancedMode === 'replace' && 'Replace plans force selected resources through destroy/create or create/delete replacement logic.'}
            </div>
            {advancedMode === 'targeted' && (
              <textarea
                className="tf-plan-address-input"
                value={targetText}
                onChange={(event) => setTargetText(event.target.value)}
                placeholder={'module.network.aws_subnet.private[0]\naws_instance.web'}
              />
            )}
            {advancedMode === 'replace' && (
              <textarea
                className="tf-plan-address-input"
                value={replaceText}
                onChange={(event) => setReplaceText(event.target.value)}
                placeholder={'module.app.aws_instance.web\naws_db_instance.main'}
              />
            )}
            <div className="tf-plan-controls-footer">
              <div className="tf-section-hint">
                {advancedMode === 'refresh-only'
                  ? 'This still produces a saved plan file.'
                  : `${advancedAddresses.length} explicit resource address${advancedAddresses.length === 1 ? '' : 'es'} selected.`}
              </div>
              <button
                type="button"
                className="tf-toolbar-btn accent"
                disabled={!cliOk || running || !canRunAdvancedPlan}
                onClick={() => onPlan(
                  advancedMode === 'refresh-only'
                    ? { mode: 'refresh-only' }
                    : advancedMode === 'targeted'
                      ? { mode: 'targeted', targets: advancedAddresses }
                      : { mode: 'replace', replaceAddresses: advancedAddresses }
                )}
              >
                Run {advancedMode === 'refresh-only' ? 'refresh-only' : advancedMode} plan
              </button>
            </div>
          </div>
        )}
      </div>

      <GovernancePanel
        toolkit={governanceToolkit}
        report={governanceReport}
        running={governanceRunning}
        onRunChecks={onRunGovernanceChecks}
        onDetectTools={onDetectGovernanceTools}
      />

      <div className={`tf-section ${s.isDeleteHeavy ? 'tf-plan-section-danger' : s.hasReplacementChanges ? 'tf-plan-section-warning' : ''}`}>
        <div className="tf-section-head">
          <div>
            <h3>Plan Summary</h3>
            <div className="tf-section-hint">
              {PLAN_MODE_LABELS[s.request.mode]}{s.request.targets.length > 0 ? ` • ${s.request.targets.length} target${s.request.targets.length === 1 ? '' : 's'}` : ''}{s.request.replaceAddresses.length > 0 ? ` • ${s.request.replaceAddresses.length} replace address${s.request.replaceAddresses.length === 1 ? '' : 'es'}` : ''}
            </div>
          </div>
          <div className="tf-plan-risk-row">
            {s.hasReplacementChanges && <span className="tf-plan-risk-badge replace">Replacement changes</span>}
            {s.isDeleteHeavy && <span className="tf-plan-risk-badge destructive">Delete-heavy blast radius</span>}
            {governanceBlocked && <span className="tf-plan-risk-badge destructive">Blocked by governance</span>}
          </div>
        </div>
        <div className="tf-plan-summary-grid">
          <div className="tf-plan-summary-card emphasis">
            <div className="tf-plan-summary-label">Decision</div>
            <strong>{destructiveSignal ? 'Review carefully' : s.hasChanges ? 'Low-friction review' : 'No action needed'}</strong>
            <span>
              {destructiveSignal
                ? 'Destructive or replacement signals are present.'
                : s.hasChanges
                  ? 'Most changes are non-destructive.'
                  : 'Current saved plan does not propose changes.'}
            </span>
          </div>
          <div className="tf-plan-summary-card">
            <div className="tf-plan-summary-label">Action totals</div>
            <div className="tf-summary">
              <span className="tf-summary-item"><span className="tf-summary-count create">{s.create}</span> create</span>
              <span className="tf-summary-item"><span className="tf-summary-count update">{s.update}</span> update</span>
              <span className="tf-summary-item"><span className="tf-summary-count delete">{s.delete}</span> delete</span>
              <span className="tf-summary-item"><span className="tf-summary-count replace">{s.replace}</span> replace</span>
              <span className="tf-summary-item"><span className="tf-summary-count" style={{ color: '#5a6a7a' }}>{s.noop}</span> no-op</span>
            </div>
          </div>
          <div className="tf-plan-summary-card">
            <div className="tf-plan-summary-label">Blast radius</div>
            <div className="tf-plan-stat-grid">
              <div><strong>{s.affectedResources}</strong><span>resources</span></div>
              <div><strong>{s.affectedModules.length}</strong><span>modules</span></div>
              <div><strong>{s.affectedProviders.length}</strong><span>providers</span></div>
              <div><strong>{s.affectedServices.length}</strong><span>services</span></div>
            </div>
          </div>
        </div>
        {s.hasChanges ? (
          <>
            <div className="tf-plan-chip-row">
              {s.affectedModules.map((modulePath) => <span key={modulePath} className="tf-plan-chip">{modulePath}</span>)}
            </div>
            <div className="tf-plan-chip-row">
              {s.affectedServices.map((service) => <span key={service} className="tf-plan-chip subtle">{service}</span>)}
            </div>
          </>
        ) : (
          <SvcState variant="empty" message="No actionable changes in the saved plan." compact />
        )}
        <details className="tf-collapsible tf-inline-collapsible">
          <summary className="tf-collapsible-summary">Why this summary looks this way</summary>
          <div className="tf-collapsible-body">
            <div className="tf-section-hint">
              JSON fields used: {s.jsonFieldsUsed.join(', ')}
            </div>
            <div className="tf-section-hint">
              Heuristic areas: {s.heuristicNotes.join(' ')}
            </div>
          </div>
        </details>
      </div>

      {filteredChanges.length > 0 && (
        <div className="tf-section">
          <div className="tf-section-head">
            <div>
              <h3>Change Explorer</h3>
              <div className="tf-section-hint">Filter by action, module, or type, then regroup the remaining resources.</div>
            </div>
            <div className="tf-plan-filters">
              <label className="tf-drift-filter-select">
                Action
                <select value={actionFilter} onChange={(event) => setActionFilter(event.target.value as 'all' | TerraformPlanAction)}>
                  <option value="all">All</option>
                  <option value="create">Create</option>
                  <option value="update">Update</option>
                  <option value="delete">Delete</option>
                  <option value="replace">Replace</option>
                </select>
              </label>
              <label className="tf-drift-filter-select">
                Module
                <select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}>
                  {moduleOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="tf-drift-filter-select">
                Type
                <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  {typeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="tf-drift-filter-select">
                Group
                <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as 'module' | 'action' | 'resource-type')}>
                  <option value="module">Module</option>
                  <option value="action">Action</option>
                  <option value="resource-type">Resource type</option>
                </select>
              </label>
            </div>
          </div>
          <div className="tf-section-hint">{filteredChanges.length} change{filteredChanges.length === 1 ? '' : 's'} match the current filters. Grouped by {groupLabel(groupBy).toLowerCase()}.</div>
          <PlanGroupList groups={groupedChanges} changesByAddress={changesByAddress} />
          <details className="tf-collapsible tf-inline-collapsible">
            <summary className="tf-collapsible-summary">Open detailed change cards</summary>
            <div className="tf-collapsible-body">
              <div className="tf-plan-change-list">
            {filteredChanges.map((change) => (
              <div key={change.address} className={`tf-plan-change-card ${change.isReplacement ? 'replace' : change.isDestructive ? 'destructive' : ''}`}>
                <div className="tf-plan-change-head">
                  <div className="tf-plan-change-title">
                    <span className={`tf-plan-action-badge ${change.actionLabel}`}>{actionSymbol(change.actionLabel)} {change.actionLabel}</span>
                    <span className="tf-plan-change-address">{change.address}</span>
                  </div>
                  <div className="tf-plan-change-meta">
                    <span>{change.type}</span>
                    <span>{change.modulePath}</span>
                    <span>{change.providerDisplayName || change.provider}</span>
                    <span>{change.service}</span>
                  </div>
                </div>
                {(change.replacePaths.length > 0 || change.actionReason) && (
                  <div className="tf-plan-change-flags">
                    {change.replacePaths.map((path) => <span key={path} className="tf-plan-flag replace">replace: {path}</span>)}
                    {change.actionReason && <span className="tf-plan-flag">{change.actionReason}</span>}
                  </div>
                )}
                {change.changedAttributes.length > 0 && (
                  <div className="tf-plan-attribute-list">
                    {change.changedAttributes.slice(0, 8).map((attribute) => (
                      <div key={`${change.address}:${attribute.path}`} className={`tf-plan-attribute-row ${attribute.requiresReplacement ? 'replace' : ''}`}>
                        <div className="tf-plan-attribute-path">{attribute.path}</div>
                        <div className="tf-plan-attribute-values">
                          <span>{attribute.before}</span>
                          <span>→</span>
                          <span>{attribute.after}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
              </div>
            </div>
          </details>
        </div>
      )}

      {(governanceBlocked || topFindings.length > 0) && (
        <div className="tf-section tf-linkage-panel">
          <div className="tf-section-head">
            <div>
              <h3>Governance Focus</h3>
              <div className="tf-section-hint">Fix the exact findings below, then rerun checks and plan review.</div>
            </div>
            <button type="button" className="tf-toolbar-btn" onClick={onRunGovernanceChecks} disabled={governanceRunning || !cliOk}>
              {governanceRunning ? 'Running...' : 'Re-run checks'}
            </button>
          </div>
          {topFindings.length > 0 ? (
            <div className="tf-linked-list">
              {topFindings.map((finding, index) => (
                <div key={`${finding.ruleId}:${finding.file}:${finding.line}:${index}`} className="tf-linked-card">
                  <span className={`tf-governance-severity ${finding.severity}`}>{SEVERITY_LABELS[finding.severity] ?? finding.severity}</span>
                  <div className="tf-linked-copy">
                    <strong>{finding.message}</strong>
                    <span>{finding.file}{finding.line > 0 ? `:${finding.line}` : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <SvcState variant="empty" message="No governance findings are currently linked to this plan." compact />
          )}
        </div>
      )}

      <div className="tf-section tf-linkage-panel">
        <div className="tf-section-head">
          <div>
            <h3>Related Follow-up</h3>
            <div className="tf-section-hint">Open drift after mutating commands to verify realized state against AWS.</div>
          </div>
          <button type="button" className="tf-toolbar-btn" onClick={onOpenDriftTab}>Open Drift</button>
        </div>
      </div>

      <div className="tf-section">
        <h3>Infrastructure Diagram</h3>
        <DiagramView diagram={project.diagram} />
      </div>

      {project.actionRows.length > 0 && (
        <div className="tf-section">
          <details className="tf-collapsible tf-inline-collapsible">
            <summary className="tf-collapsible-summary">Open ordered action table</summary>
            <div className="tf-collapsible-body">
              <div className="tf-action-table-wrap">
                <table className="tf-data-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Action</th>
                      <th>Address</th>
                      <th>ResourceType</th>
                      <th>PhysicalResourceId</th>
                    </tr>
                  </thead>
                  <tbody>
                    {project.actionRows.map((row) => (
                      <tr key={row.order}>
                        <td>{row.order}</td>
                        <td><span className={`tf-summary-count ${row.action}`}>{row.action}</span></td>
                        <td title={row.address}>{row.address}</td>
                        <td>{row.resourceType}</td>
                        <td title={row.physicalResourceId}>{row.physicalResourceId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        </div>
      )}

      <div className="tf-section">
        <button className="tf-output-toggle" onClick={() => setOutputOpen(!outputOpen)}>
          {outputOpen ? '▼' : '▶'} Command Output
          {lastLog && (
            <span style={{ fontWeight: 400, color: lastLog.success ? '#2ecc71' : lastLog.success === false ? '#e74c3c' : '#9ca7b7' }}>
              {' '}({lastLog.command}{lastLog.success !== null ? (lastLog.success ? ' ok' : ' failed') : ' running'})
            </span>
          )}
        </button>
        {outputOpen && lastLog && (
          <div className="tf-output-panel">{lastLog.output || '(no output)'}</div>
        )}
      </div>
    </>
  )
}

function StateTab({
  project,
  running,
  lastLog,
  draft,
  onImport,
  onMove,
  onRemove,
  onUnlock,
  onReload
}: {
  project: TerraformProject
  running: boolean
  lastLog: TerraformCommandLog | null
  draft: StateOperationDraft | null
  onImport: (address: string, importId: string) => void
  onMove: (fromAddress: string, toAddress: string) => void
  onRemove: (address: string) => void
  onUnlock: (lockId: string) => void
  onReload: () => void
}) {
  const [importAddress, setImportAddress] = useState('')
  const [importId, setImportId] = useState('')
  const [moveFrom, setMoveFrom] = useState('')
  const [moveTo, setMoveTo] = useState('')
  const [removeAddress, setRemoveAddress] = useState('')
  const [unlockId, setUnlockId] = useState(project.stateLockInfo?.lockId ?? '')
  const stateAddresses = useMemo(() => project.stateAddresses.slice().sort(), [project.stateAddresses])
  const latestBackup = project.latestStateBackup
  const lockInfo = project.stateLockInfo
  const backendHealth = project.backendHealth
  const lastStateLog = lastLog && ['import', 'state-mv', 'state-rm', 'force-unlock'].includes(lastLog.command) ? lastLog : null
  const backendHealthCardClass = `tf-state-meta-card tf-state-health-card tf-state-health-${backendHealth.status}`

  useEffect(() => {
    setUnlockId(project.stateLockInfo?.lockId ?? '')
  }, [project.stateLockInfo?.lockId])

  useEffect(() => {
    if (!draft) return
    if (draft.mode === 'import') {
      setImportAddress(draft.importAddress)
      setImportId(draft.importId)
      return
    }
    if (draft.mode === 'move') {
      setMoveFrom(draft.moveFrom)
      setMoveTo(draft.moveTo)
      return
    }
    setRemoveAddress(draft.removeAddress)
  }, [draft])

  return (
    <>
      <div className="tf-section tf-state-overview">
        <div className="tf-section-head">
          <div>
            <h3>State Operations Center</h3>
            <div className="tf-section-hint">
              Guided state changes run in the main process. Destructive actions require confirmation and write a local backup first.
            </div>
          </div>
          <button className="tf-toolbar-btn" onClick={onReload} disabled={running}>Refresh State</button>
        </div>
        <div className="tf-state-meta-grid">
          <div className="tf-state-meta-card">
            <div className="tf-state-meta-label">Current state source</div>
            <div className="tf-state-meta-value">{project.stateSource || 'none'}</div>
            <div className="tf-state-meta-subtle">{project.metadata.backend.label}</div>
          </div>
          <div className="tf-state-meta-card">
            <div className="tf-state-meta-label">Latest backup</div>
            <div className="tf-state-meta-value">{latestBackup ? formatIsoDate(latestBackup.createdAt) : 'No backup yet'}</div>
            <div className="tf-state-meta-subtle">
              {latestBackup ? `${formatBytes(latestBackup.sizeBytes)} from ${latestBackup.source}` : 'A backup is created before move, remove, and unlock.'}
            </div>
          </div>
          <div className="tf-state-meta-card">
            <div className="tf-state-meta-label">Backup inventory</div>
            <div className="tf-state-meta-value">{project.stateBackups.length}</div>
            <div className="tf-state-meta-subtle">
              {latestBackup ? latestBackup.path : 'Stored under Electron userData in a project-scoped backup folder.'}
            </div>
          </div>
          <div className={backendHealthCardClass}>
            <div className="tf-state-meta-label">Backend health</div>
            <div className="tf-state-meta-value">{backendHealth.summary}</div>
            <div className="tf-state-meta-subtle">{backendHealth.lockSummary}</div>
          </div>
        </div>
      </div>

      <div className="tf-section">
        <div className="tf-state-card-grid">
          <div className="tf-state-card">
            <h3>Import Resource</h3>
            <div className="tf-section-hint">
              Bring an existing remote object under Terraform state without typing raw CLI syntax.
            </div>
            <label className="tf-state-field">
              <span>Terraform address</span>
              <input value={importAddress} onChange={(e) => setImportAddress(e.target.value)} placeholder="aws_s3_bucket.logs" />
            </label>
            <label className="tf-state-field">
              <span>Provider import ID</span>
              <input value={importId} onChange={(e) => setImportId(e.target.value)} placeholder="my-existing-bucket" />
            </label>
            <button
              className="tf-toolbar-btn accent"
              disabled={running || !importAddress.trim() || !importId.trim()}
              onClick={() => onImport(importAddress.trim(), importId.trim())}
            >
              Run Import
            </button>
          </div>

          <div className="tf-state-card tf-state-card-warning">
            <h3>Move State Address</h3>
            <div className="tf-section-hint">
              Rename or relocate a state entry during refactors. A state backup is captured immediately before the move.
            </div>
            <label className="tf-state-field">
              <span>From address</span>
              <input value={moveFrom} onChange={(e) => setMoveFrom(e.target.value)} placeholder="aws_instance.old_name" list="tf-state-addresses" />
            </label>
            <label className="tf-state-field">
              <span>To address</span>
              <input value={moveTo} onChange={(e) => setMoveTo(e.target.value)} placeholder="module.app.aws_instance.new_name" />
            </label>
            <button
              className="tf-toolbar-btn danger"
              disabled={running || !moveFrom.trim() || !moveTo.trim()}
              onClick={() => onMove(moveFrom.trim(), moveTo.trim())}
            >
              Confirm Move
            </button>
          </div>

          <div className="tf-state-card tf-state-card-danger">
            <h3>Remove From State</h3>
            <div className="tf-section-hint">
              Forget a resource without destroying it in the provider. This is destructive to Terraform state and always creates a backup first.
            </div>
            <label className="tf-state-field">
              <span>State address</span>
              <input value={removeAddress} onChange={(e) => setRemoveAddress(e.target.value)} placeholder="aws_security_group.legacy" list="tf-state-addresses" />
            </label>
            <button
              className="tf-toolbar-btn danger"
              disabled={running || !removeAddress.trim()}
              onClick={() => onRemove(removeAddress.trim())}
            >
              Remove Address
            </button>
          </div>
        </div>
        <datalist id="tf-state-addresses">
          {stateAddresses.map((address) => <option key={address} value={address} />)}
        </datalist>
      </div>

      <div className="tf-section">
        <div className="tf-state-card-grid">
          <div className="tf-state-card">
            <h3>Backend Health</h3>
            <div className="tf-kv">
              <div className="tf-kv-row"><div className="tf-kv-label">Backend</div><div className="tf-kv-value">{project.metadata.backendType}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Health</div><div className="tf-kv-value">{backendHealth.summary}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Lock visibility</div><div className="tf-kv-value">{backendHealth.lockSummary}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Inspection</div><div className="tf-kv-value">{lockInfo?.supported ? 'Available' : 'Limited'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Lock ID</div><div className="tf-kv-value">{lockInfo?.lockId || '(not detected)'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Operation</div><div className="tf-kv-value">{lockInfo?.operation || '-'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Who</div><div className="tf-kv-value">{lockInfo?.who || '-'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Created</div><div className="tf-kv-value">{lockInfo?.created ? formatIsoDate(lockInfo.created) : '-'}</div></div>
            </div>
            {backendHealth.details.map((detail) => (
              <div key={detail} className="tf-state-inline-note">{detail}</div>
            ))}
          </div>

          <div className="tf-state-card tf-state-card-danger">
            <h3>Force Unlock</h3>
            <div className="tf-section-hint">
              Only unlock when you are certain no active Terraform operation is still holding the lock. A state backup is taken before unlock.
            </div>
            <label className="tf-state-field">
              <span>Lock ID</span>
              <input value={unlockId} onChange={(e) => setUnlockId(e.target.value)} placeholder="Paste Terraform lock ID" />
            </label>
            <button
              className="tf-toolbar-btn danger"
              disabled={running || !unlockId.trim()}
              onClick={() => onUnlock(unlockId.trim())}
            >
              Force Unlock
            </button>
          </div>
        </div>
      </div>

      <div className="tf-section">
        <h3>Recent Backups</h3>
        {project.stateBackups.length === 0 ? (
          <SvcState variant="empty" message="No state backups captured yet." />
        ) : (
          <div className="tf-state-backup-list">
            {project.stateBackups.slice(0, 5).map((backup) => (
              <div key={backup.path} className="tf-state-backup-row">
                <div>
                  <div className="tf-state-backup-title">{formatIsoDate(backup.createdAt)}</div>
                  <div className="tf-state-backup-path">{backup.path}</div>
                </div>
                <div className="tf-state-backup-meta">{backup.source} • {formatBytes(backup.sizeBytes)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {lastStateLog && (
        <div className="tf-section">
          <button className="tf-output-toggle" type="button">
            Last State Operation Output: {lastStateLog.command}
          </button>
          <div className="tf-output-panel">{lastStateLog.output || '(no output)'}</div>
        </div>
      )}
    </>
  )
}

function WorkspaceControls({
  project,
  running,
  onSelectWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace
}: {
  project: TerraformProject
  running: boolean
  onSelectWorkspace: (workspaceName: string) => void
  onCreateWorkspace: () => void
  onDeleteWorkspace: () => void
}) {
  const canDeleteWorkspace = project.workspaces.some((workspace) => !workspace.isCurrent && workspace.name !== 'default')

  return (
    <div className="tf-section">
      <div className="tf-section-head">
        <div>
          <h3>Workspace</h3>
          <div className="tf-section-hint">
            Current workspace: <span className="tf-workspace-badge">{project.currentWorkspace}</span>
          </div>
        </div>
        <div className="tf-workspace-controls">
          <select
            className="tf-workspace-select"
            value={project.currentWorkspace}
            disabled={running || project.workspaces.length === 0}
            onChange={(e) => onSelectWorkspace(e.target.value)}
          >
            {project.workspaces.map((workspace) => (
              <option key={workspace.name} value={workspace.name}>{workspace.name}</option>
            ))}
          </select>
          <button type="button" className="tf-toolbar-btn accent" onClick={onCreateWorkspace} disabled={running}>New Workspace</button>
          <button type="button" className="tf-toolbar-btn danger" onClick={onDeleteWorkspace} disabled={running || !canDeleteWorkspace}>Delete Workspace</button>
        </div>
      </div>
    </div>
  )
}

/* ── Resources Tab ────────────────────────────────────────── */

function ResourcesTab({ project }: { project: TerraformProject }) {
  const rows = project.resourceRows
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [query, setQuery] = useState('')
  const categories = useMemo(
    () => [...new Set(rows.map((row) => row.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows]
  )
  const normalizedQuery = query.trim().toLowerCase()
  const filteredRows = useMemo(() => rows.filter((row) => {
    if (categoryFilter !== 'all' && row.category !== categoryFilter) return false
    if (!normalizedQuery) return true

    const haystack = [
      row.category,
      row.address,
      row.type,
      row.arn,
      row.region,
      row.changedBy,
      row.tags
    ].join(' ').toLowerCase()

    return haystack.includes(normalizedQuery)
  }), [categoryFilter, normalizedQuery, rows])

  return (
    <>
      <div className="tf-section">
        <div className="tf-summary">
          <span className="tf-summary-item"><span className="tf-summary-count" style={{ color: '#4a8fe7' }}>{filteredRows.length}</span> resources</span>
          {filteredRows.length !== rows.length && (
            <span className="tf-summary-item">filtered from {rows.length}</span>
          )}
          <span className="tf-summary-item">source: {project.stateSource || 'none'}</span>
        </div>
        {rows.length > 0 && (
          <div className="tf-history-filters tf-resource-filters">
            <div className="tf-history-filter-group">
              <label>Category</label>
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option value="all">All categories</option>
                {categories.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </div>
            <div className="tf-history-filter-group tf-resource-search">
              <label>Search</label>
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Address, type, ARN, region, tags"
              />
            </div>
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="tf-section"><SvcState variant="empty" message="No deployed resources found. Run Init + Apply or load state." /></div>
      ) : filteredRows.length === 0 ? (
        <div className="tf-section"><SvcState variant="no-filter-matches" resourceName="resources" /></div>
      ) : (
        <div className="tf-section">
          <div className="tf-resource-table-wrap">
            <table className="tf-data-table tf-resource-table">
              <colgroup>
                <col className="tf-resource-table__category" />
                <col className="tf-resource-table__address" />
                <col className="tf-resource-table__type" />
                <col className="tf-resource-table__arn" />
                <col className="tf-resource-table__region" />
                <col className="tf-resource-table__changed-by" />
                <col className="tf-resource-table__tags" />
              </colgroup>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Address</th>
                  <th>Type</th>
                  <th>Arn</th>
                  <th>Region</th>
                  <th>ChangedBy</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.address}>
                    <td>
                      <span className="tf-resource-badge">{row.category}</span>
                    </td>
                    <td title={row.address}>
                      <code className="tf-table-code tf-table-code--strong">{truncateMiddle(row.address, { start: 26, end: 18 })}</code>
                    </td>
                    <td title={row.type}>
                      <code className="tf-table-code">{row.type}</code>
                    </td>
                    <td title={row.arn || '-'}>
                      {row.arn ? <code className="tf-table-code">{truncateMiddle(row.arn, { start: 18, end: 22 })}</code> : '-'}
                    </td>
                    <td>{row.region || '-'}</td>
                    <td title={row.changedBy || '-'}>
                      <span className="tf-table-text">{row.changedBy || '-'}</span>
                    </td>
                    <td title={row.tags || '-'}>
                      <span className="tf-table-text">{formatResourceTagsSummary(row.tags)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

/* ── Main Terraform Console ───────────────────────────────── */

const DRIFT_STATUS_LABELS: Record<TerraformDriftStatus, string> = {
  in_sync: 'In Sync',
  drifted: 'Drifted',
  missing_in_aws: 'Missing In AWS',
  unmanaged_in_aws: 'Unmanaged In AWS',
  unsupported: 'Unsupported'
}

const DRIFT_TREND_LABELS: Record<TerraformDriftReport['history']['trend'], string> = {
  improving: 'Improving',
  worsening: 'Worsening',
  unchanged: 'Unchanged',
  insufficient_history: 'Need More History'
}

const DRIFT_ASSESSMENT_LABELS = {
  verified: 'Verified',
  inferred: 'Inferred',
  unsupported: 'Unsupported'
} as const

function driftResourceTypeToService(resourceType: string): ServiceId | null {
  if (resourceType.startsWith('aws_instance') || resourceType === 'aws_eip') return 'ec2'
  if (resourceType.startsWith('aws_vpc') || resourceType.startsWith('aws_subnet') || resourceType.startsWith('aws_route')) return 'vpc'
  if (resourceType.startsWith('aws_security_group')) return 'security-groups'
  if (resourceType.startsWith('aws_lb') || resourceType.startsWith('aws_alb') || resourceType.startsWith('aws_elb')) return 'load-balancers'
  if (resourceType.startsWith('aws_lambda')) return 'lambda'
  if (resourceType.startsWith('aws_ecs')) return 'ecs'
  if (resourceType.startsWith('aws_eks')) return 'eks'
  if (resourceType.startsWith('aws_s3')) return 's3'
  if (resourceType.startsWith('aws_route53')) return 'route53'
  if (resourceType.startsWith('aws_iam')) return 'iam'
  if (resourceType.startsWith('aws_acm')) return 'acm'
  if (resourceType.startsWith('aws_secretsmanager')) return 'secrets-manager'
  if (resourceType.startsWith('aws_waf')) return 'waf'
  if (resourceType.startsWith('aws_rds') || resourceType.startsWith('aws_db')) return 'rds'
  if (resourceType.startsWith('aws_cloudwatch')) return 'cloudwatch'
  if (resourceType.startsWith('aws_kms')) return 'kms'
  if (resourceType.startsWith('aws_sns')) return 'sns'
  if (resourceType.startsWith('aws_sqs')) return 'sqs'
  if (resourceType.startsWith('aws_autoscaling')) return 'auto-scaling'
  if (resourceType.startsWith('aws_cloudformation')) return 'cloudformation'
  if (resourceType.startsWith('aws_ecr')) return 'ecr'
  return null
}

function driftItemKey(item: TerraformDriftItem): string {
  return `${item.terraformAddress}|${item.resourceType}|${item.cloudIdentifier}|${item.logicalName}|${item.status}`
}

function driftSnapshotIdentity(item: TerraformDriftItem): string {
  return `${item.terraformAddress}|${item.resourceType}|${item.cloudIdentifier}|${item.logicalName}`
}

type DriftSnapshotChangeSummary = {
  newIssues: TerraformDriftItem[]
  resolvedIssues: TerraformDriftItem[]
  changedItems: Array<{ latest: TerraformDriftItem; previous: TerraformDriftItem }>
}

function isActionableDriftStatus(status: TerraformDriftStatus): boolean {
  return status === 'drifted' || status === 'missing_in_aws' || status === 'unmanaged_in_aws'
}

function summarizeSnapshotChanges(report: TerraformDriftReport | null): DriftSnapshotChangeSummary | null {
  const latest = report?.history.snapshots[0]
  const previous = report?.history.snapshots[1]
  if (!latest || !previous) return null

  const latestMap = new Map(latest.items.map((item) => [driftSnapshotIdentity(item), item]))
  const previousMap = new Map(previous.items.map((item) => [driftSnapshotIdentity(item), item]))

  const newIssues = latest.items.filter((item) => {
    if (!isActionableDriftStatus(item.status)) return false
    const prior = previousMap.get(driftSnapshotIdentity(item))
    return !prior || !isActionableDriftStatus(prior.status)
  })

  const resolvedIssues = previous.items.filter((item) => {
    if (!isActionableDriftStatus(item.status)) return false
    const current = latestMap.get(driftSnapshotIdentity(item))
    return !current || !isActionableDriftStatus(current.status)
  })

  const changedItems = latest.items.flatMap((item) => {
    const prior = previousMap.get(driftSnapshotIdentity(item))
    if (!prior) return []
    const priorDiff = prior.differences.map((difference) => `${difference.key}:${difference.terraformValue}:${difference.liveValue}`).join('|')
    const currentDiff = item.differences.map((difference) => `${difference.key}:${difference.terraformValue}:${difference.liveValue}`).join('|')
    if (prior.status === item.status && priorDiff === currentDiff) return []
    return [{ latest: item, previous: prior }]
  })

  return { newIssues, resolvedIssues, changedItems }
}

function DriftTab({
  report,
  loading,
  error,
  cliLabel,
  statusFilter,
  typeFilter,
  selectedKey,
  onStatusFilterChange,
  onTypeFilterChange,
  onSelectItem,
  onRefresh,
  onPrepareImport,
  onPrepareMove,
  onPrepareRemove,
  onOpenConsole,
  onRunStateShow,
  onNavigateService
}: {
  report: TerraformDriftReport | null
  loading: boolean
  error: string
  cliLabel: string
  statusFilter: 'all' | TerraformDriftStatus
  typeFilter: string
  selectedKey: string
  onStatusFilterChange: (value: 'all' | TerraformDriftStatus) => void
  onTypeFilterChange: (value: string) => void
  onSelectItem: (key: string) => void
  onRefresh: () => void
  onPrepareImport: (item: TerraformDriftItem) => void
  onPrepareMove: (item: TerraformDriftItem) => void
  onPrepareRemove: (item: TerraformDriftItem) => void
  onOpenConsole: (item: TerraformDriftItem) => void
  onRunStateShow: (item: TerraformDriftItem) => void
  onNavigateService?: (serviceId: ServiceId, resourceId?: string) => void
}) {
  const items = report?.items ?? []
  const snapshotChanges = useMemo(() => summarizeSnapshotChanges(report), [report])
  const resourceTypes = useMemo(
    () => report?.summary.resourceTypeCounts.map((entry) => entry.resourceType) ?? [],
    [report]
  )
  const filteredItems = useMemo(
    () => items.filter((item) =>
      (statusFilter === 'all' || item.status === statusFilter) &&
      (typeFilter === 'all' || item.resourceType === typeFilter)
    ),
    [items, statusFilter, typeFilter]
  )
  const selectedItem = useMemo(
    () => filteredItems.find((item) => driftItemKey(item) === selectedKey) ?? filteredItems[0] ?? null,
    [filteredItems, selectedKey]
  )
  const selectedMoveTarget = selectedItem?.relatedTerraformAddresses[0] ?? ''
  const summaryCards = report ? [
    { label: 'Drifted', value: report.summary.statusCounts.drifted, tone: 'warning' },
    { label: 'Missing', value: report.summary.statusCounts.missing_in_aws, tone: 'danger' },
    { label: 'Unmanaged', value: report.summary.statusCounts.unmanaged_in_aws, tone: 'info' },
    { label: 'In Sync', value: report.summary.statusCounts.in_sync, tone: 'success' }
  ] : []

  return (
    <>
      <div className="tf-section">
        <div className="tf-section-head">
          <div>
            <h3>Drift Summary</h3>
            <div className="tf-section-hint">
              Terraform state vs live AWS inventory for region {report?.region ?? '-'} with persisted reconciliation snapshots.
            </div>
          </div>
          <button type="button" className="tf-toolbar-btn" onClick={onRefresh} disabled={loading}>
            {loading ? 'Scanning...' : 'Manual Re-scan'}
          </button>
        </div>
        {report && (
          <>
            <div className="tf-overview-card-grid">
              {summaryCards.map((card) => (
                <div key={card.label} className={`tf-overview-card ${card.tone}`}>
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                </div>
              ))}
            </div>
            <div className="tf-summary">
              <span className="tf-summary-item"><span className="tf-summary-count">{report.summary.total}</span> total</span>
              <span className="tf-summary-item"><span className="tf-summary-count drifted">{report.summary.statusCounts.drifted}</span> drifted</span>
              <span className="tf-summary-item"><span className="tf-summary-count missing_in_aws">{report.summary.statusCounts.missing_in_aws}</span> missing</span>
              <span className="tf-summary-item"><span className="tf-summary-count unmanaged_in_aws">{report.summary.statusCounts.unmanaged_in_aws}</span> unmanaged</span>
              <span className="tf-summary-item"><span className="tf-summary-count unsupported">{report.summary.statusCounts.unsupported}</span> unsupported</span>
              <span className="tf-summary-item"><span className="tf-summary-count in_sync">{report.summary.statusCounts.in_sync}</span> in sync</span>
            </div>
            <div className="tf-kv" style={{ marginTop: 12 }}>
              <div className="tf-kv-row"><div className="tf-kv-label">Last Drift Scan</div><div className="tf-kv-value">{formatIsoDate(report.history.latestScanAt || report.summary.scannedAt)}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Scan Source</div><div className="tf-kv-value">{report.fromCache ? 'Loaded from local snapshot history' : 'Fresh live AWS scan'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Trend</div><div className="tf-kv-value">{DRIFT_TREND_LABELS[report.history.trend]}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Verified Findings</div><div className="tf-kv-value">{report.summary.verifiedCount}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Items With Inferred Signals</div><div className="tf-kv-value">{report.summary.inferredCount}</div></div>
            </div>
          </>
        )}
        <div className="tf-drift-filters">
          <div className="tf-drift-status-row">
            <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => onStatusFilterChange('all')}>All</button>
            {(Object.keys(DRIFT_STATUS_LABELS) as TerraformDriftStatus[]).map((status) => (
              <button key={status} type="button" className={statusFilter === status ? 'active' : ''} onClick={() => onStatusFilterChange(status)}>
                {DRIFT_STATUS_LABELS[status]}
              </button>
            ))}
          </div>
          <label className="tf-drift-filter-select">
            <span>Type</span>
            <select value={typeFilter} onChange={(event) => onTypeFilterChange(event.target.value)}>
              <option value="all">All resource types</option>
              {resourceTypes.map((resourceType) => (
                <option key={resourceType} value={resourceType}>{resourceType}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
                {error && <div className="tf-section"><SvcState variant={variantForError(error)} error={error} /></div>}
      {!loading && !error && filteredItems.length === 0 && (
        <div className="tf-section"><SvcState variant="no-filter-matches" resourceName="drift items" /></div>
      )}
      {filteredItems.length > 0 && (
        <>
          <div className="tf-section">
            <div className="tf-resource-table-wrap">
              <table className="tf-data-table tf-drift-table">
                <colgroup>
                  <col className="tf-drift-table__status" />
                  <col className="tf-drift-table__type" />
                  <col className="tf-drift-table__logical-name" />
                  <col className="tf-drift-table__terraform-address" />
                  <col className="tf-drift-table__cloud-identifier" />
                  <col className="tf-drift-table__region" />
                  <col className="tf-drift-table__explanation" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Type</th>
                    <th>Logical Name</th>
                    <th>Terraform Address</th>
                    <th>Cloud Identifier</th>
                    <th>Region</th>
                    <th>Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const key = driftItemKey(item)
                    return (
                      <tr key={key} className={selectedItem && driftItemKey(selectedItem) === key ? 'active' : ''} onClick={() => onSelectItem(key)}>
                        <td><span className={`tf-drift-badge ${item.status}`}>{DRIFT_STATUS_LABELS[item.status]}</span></td>
                        <td title={item.resourceType}>
                          <code className="tf-table-code">{item.resourceType}</code>
                        </td>
                        <td title={item.logicalName || '-'}>
                          <span className="tf-table-text">{item.logicalName || '-'}</span>
                        </td>
                        <td title={item.terraformAddress}>
                          <code className="tf-table-code">{item.terraformAddress ? truncateMiddle(item.terraformAddress, { start: 24, end: 18 }) : '-'}</code>
                        </td>
                        <td title={item.cloudIdentifier}>
                          <code className="tf-table-code">{item.cloudIdentifier ? truncateMiddle(item.cloudIdentifier, { start: 18, end: 18 }) : '-'}</code>
                        </td>
                        <td>{item.region || '-'}</td>
                        <td title={item.explanation}>
                          <span className="tf-table-text">{item.explanation}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {selectedItem && (
            <div className="tf-section">
              {(() => {
                const isSelectedItemDrifted = selectedItem.status === 'drifted'
                const navigableService = driftResourceTypeToService(selectedItem.resourceType)

                return (
              <div className="tf-section-head">
                <h3>Selected Drift Item</h3>
                <div className="tf-drift-actions">
                  {isSelectedItemDrifted && (
                    <>
                      <button
                        type="button"
                        className="tf-toolbar-btn"
                        onClick={() => onPrepareImport(selectedItem)}
                        disabled={!selectedItem.cloudIdentifier}
                      >
                        Prepare Import
                      </button>
                      <button
                        type="button"
                        className="tf-toolbar-btn"
                        onClick={() => onPrepareMove(selectedItem)}
                        disabled={!selectedItem.terraformAddress || !selectedMoveTarget}
                      >
                        Prepare Move
                      </button>
                      <button
                        type="button"
                        className="tf-toolbar-btn danger"
                        onClick={() => onPrepareRemove(selectedItem)}
                        disabled={!selectedItem.terraformAddress}
                      >
                        Prepare State Remove
                      </button>
                      <button type="button" className="tf-toolbar-btn" onClick={() => onOpenConsole(selectedItem)} disabled={!selectedItem.consoleUrl}>Open In AWS Console</button>
                    </>
                  )}
                  {onNavigateService && navigableService && (
                    <button type="button" className="tf-toolbar-btn" onClick={() => {
                      onNavigateService(navigableService, selectedItem.cloudIdentifier || undefined)
                    }}>Open in App</button>
                  )}
                  {isSelectedItemDrifted && (
                    <button type="button" className="tf-toolbar-btn" onClick={() => onRunStateShow(selectedItem)} disabled={!selectedItem.terminalCommand}>{cliLabel} state show</button>
                  )}
                </div>
              </div>
                )
              })()}
              <div className="tf-overview-card-grid">
                <div className={`tf-overview-card ${selectedItem.status === 'in_sync' ? 'success' : selectedItem.status === 'unsupported' ? 'info' : 'warning'}`}>
                  <span>Status</span>
                  <strong>{DRIFT_STATUS_LABELS[selectedItem.status]}</strong>
                </div>
                <div className={`tf-overview-card ${selectedItem.assessment === 'verified' ? 'success' : selectedItem.assessment === 'inferred' ? 'warning' : 'info'}`}>
                  <span>Assessment</span>
                  <strong>{DRIFT_ASSESSMENT_LABELS[selectedItem.assessment]}</strong>
                </div>
              </div>
              <div className="tf-kv">
                <div className="tf-kv-row"><div className="tf-kv-label">Status</div><div className="tf-kv-value">{DRIFT_STATUS_LABELS[selectedItem.status]}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Assessment</div><div className="tf-kv-value">{DRIFT_ASSESSMENT_LABELS[selectedItem.assessment]}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Resource Type</div><div className="tf-kv-value">{selectedItem.resourceType}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Logical Name</div><div className="tf-kv-value">{selectedItem.logicalName || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Terraform Address</div><div className="tf-kv-value">{selectedItem.terraformAddress || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Cloud Identifier</div><div className="tf-kv-value">{selectedItem.cloudIdentifier || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Region</div><div className="tf-kv-value">{selectedItem.region || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Explanation</div><div className="tf-kv-value">{selectedItem.explanation}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Suggested Next Step</div><div className="tf-kv-value">{selectedItem.suggestedNextStep}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Evidence</div><div className="tf-kv-value">{selectedItem.evidence.length > 0 ? selectedItem.evidence.join(' | ') : '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Related Terraform Addresses</div><div className="tf-kv-value">{selectedItem.relatedTerraformAddresses.length > 0 ? selectedItem.relatedTerraformAddresses.join(', ') : '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Differences</div><div className="tf-kv-value">{selectedItem.differences.length > 0 ? selectedItem.differences.map((difference) => `${difference.label}: ${difference.terraformValue || '-'} -> ${difference.liveValue || '-'} (${difference.assessment})`).join(' | ') : '-'}</div></div>
              </div>
              <div className="tf-remediation-card">
                <span className="tf-plan-summary-label">Suggested remediation</span>
                <strong>{selectedItem.suggestedNextStep}</strong>
                <span>{selectedItem.relatedTerraformAddresses.length > 0 ? `Related Terraform addresses: ${selectedItem.relatedTerraformAddresses.join(', ')}` : 'No related Terraform addresses were inferred for this item.'}</span>
              </div>
            </div>
          )}
        </>
      )}
      {report && snapshotChanges && (
        <div className="tf-section">
          <div className="tf-section-head">
            <div>
              <h3>Trend Diff</h3>
              <div className="tf-section-hint">
                Delta between the latest drift snapshot and the previous scan.
              </div>
            </div>
          </div>
          <div className="tf-overview-card-grid">
            <div className="tf-overview-card warning">
              <span>New Issues</span>
              <strong>{snapshotChanges.newIssues.length}</strong>
            </div>
            <div className="tf-overview-card success">
              <span>Resolved</span>
              <strong>{snapshotChanges.resolvedIssues.length}</strong>
            </div>
            <div className="tf-overview-card info">
              <span>Changed</span>
              <strong>{snapshotChanges.changedItems.length}</strong>
            </div>
          </div>
          <div className="tf-trend-diff-grid">
            <div className="tf-history-card">
              <div className="tf-history-card-head">
                <strong>New Since Last Scan</strong>
                <span>{formatIsoDate(report.history.latestScanAt)} vs {formatIsoDate(report.history.previousScanAt)}</span>
              </div>
              <div className="tf-trend-diff-list">
                {snapshotChanges.newIssues.length === 0 ? (
                  <span className="tf-section-hint">No newly introduced actionable drift items.</span>
                ) : snapshotChanges.newIssues.slice(0, 8).map((item) => (
                  <div key={`new-${driftSnapshotIdentity(item)}`} className="tf-trend-diff-row">
                    <code>{item.resourceType}</code>
                    <span>{item.logicalName || item.terraformAddress}</span>
                    <strong>{DRIFT_STATUS_LABELS[item.status]}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="tf-history-card">
              <div className="tf-history-card-head">
                <strong>Resolved</strong>
                <span>Items that are no longer actionable drift findings.</span>
              </div>
              <div className="tf-trend-diff-list">
                {snapshotChanges.resolvedIssues.length === 0 ? (
                  <span className="tf-section-hint">No resolved actionable drift items.</span>
                ) : snapshotChanges.resolvedIssues.slice(0, 8).map((item) => (
                  <div key={`resolved-${driftSnapshotIdentity(item)}`} className="tf-trend-diff-row">
                    <code>{item.resourceType}</code>
                    <span>{item.logicalName || item.terraformAddress}</span>
                    <strong>{DRIFT_STATUS_LABELS[item.status]}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="tf-history-card">
              <div className="tf-history-card-head">
                <strong>Changed Findings</strong>
                <span>Status or verified differences changed across scans.</span>
              </div>
              <div className="tf-trend-diff-list">
                {snapshotChanges.changedItems.length === 0 ? (
                  <span className="tf-section-hint">No changed findings between the last two scans.</span>
                ) : snapshotChanges.changedItems.slice(0, 8).map(({ latest, previous }) => (
                  <div key={`changed-${driftSnapshotIdentity(latest)}`} className="tf-trend-diff-row">
                    <code>{latest.resourceType}</code>
                    <span>{latest.logicalName || latest.terraformAddress}</span>
                    <strong>{DRIFT_STATUS_LABELS[previous.status]} {'->'} {DRIFT_STATUS_LABELS[latest.status]}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {report && report.history.snapshots.length > 0 && (
        <div className="tf-section">
          <div className="tf-section-head">
            <div>
              <h3>Snapshot History</h3>
              <div className="tf-section-hint">
                Manual re-scans store timestamped snapshots locally under the app user data directory.
              </div>
            </div>
          </div>
          <div className="tf-history-card-list tf-history-card-list-scroll">
            {report.history.snapshots.map((snapshot, index) => (
              <div key={snapshot.id} className="tf-history-card">
                <div className="tf-history-card-head">
                  <strong>{formatIsoDate(snapshot.scannedAt)}</strong>
                  <span>{snapshot.trigger === 'manual' ? 'Manual re-scan' : 'Initial scan'}</span>
                </div>
                <div className="tf-history-card-metrics">
                  <span>Trend: {index === 0 ? DRIFT_TREND_LABELS[report.history.trend] : 'Previous point'}</span>
                  <span>{snapshot.summary.statusCounts.drifted} drifted</span>
                  <span>{snapshot.summary.statusCounts.missing_in_aws} missing</span>
                  <span>{snapshot.summary.statusCounts.unmanaged_in_aws} unmanaged</span>
                  <span>{snapshot.summary.statusCounts.in_sync} in sync</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {report && report.summary.supportedResourceTypes.length > 0 && (
        <div className="tf-section">
          <div className="tf-section-head">
            <div>
              <h3>Supported Resource Coverage</h3>
              <div className="tf-section-hint">
                Verified checks are direct comparisons. Inferred checks are heuristics, mainly for likely Terraform relationships around unmanaged live resources.
              </div>
            </div>
          </div>
          <div className="tf-resource-table-wrap">
            <table className="tf-data-table">
              <thead>
                <tr>
                  <th>Resource Type</th>
                  <th>Coverage</th>
                  <th>Verified Checks</th>
                  <th>Inferred Checks</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {report.summary.supportedResourceTypes.map((item) => (
                  <tr key={item.resourceType}>
                    <td>{item.resourceType}</td>
                    <td>{item.coverage}</td>
                    <td>{item.verifiedChecks.join(', ') || '-'}</td>
                    <td>{item.inferredChecks.join(', ') || '-'}</td>
                    <td>{item.notes.join(' | ') || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

/* ── History Tab ──────────────────────────────────────────── */

function HistoryTab({
  projectId,
  initialFilters,
  onFiltersChange,
  onOpenProject,
  onOpenTab
}: {
  projectId: string
  initialFilters?: {
    commandFilter: TerraformCommandName | 'all'
    successFilter: 'all' | 'success' | 'failure'
    projectFilter: 'current' | 'all'
  }
  onFiltersChange?: (filters: { commandFilter: TerraformCommandName | 'all'; successFilter: 'all' | 'success' | 'failure'; projectFilter: 'current' | 'all' }) => void
  onOpenProject?: (projectId: string) => void
  onOpenTab?: (tab: DetailTab) => void
}) {
  const [records, setRecords] = useState<TerraformRunRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runOutput, setRunOutput] = useState('')
  const [outputLoading, setOutputLoading] = useState(false)
  const [commandFilter, setCommandFilter] = useState<TerraformCommandName | 'all'>(initialFilters?.commandFilter ?? 'all')
  const [successFilter, setSuccessFilter] = useState<'all' | 'success' | 'failure'>(initialFilters?.successFilter ?? 'all')
  const [projectFilter, setProjectFilter] = useState<'current' | 'all'>(initialFilters?.projectFilter ?? 'current')

  const loadHistory = useCallback(async () => {
    setLoading(true)
    try {
      const filter: Record<string, unknown> = {}
      if (projectFilter === 'current' && projectId) filter.projectId = projectId
      if (commandFilter !== 'all') filter.command = commandFilter
      if (successFilter === 'success') filter.success = true
      if (successFilter === 'failure') filter.success = false
      const data = await listRunHistory(filter as Parameters<typeof listRunHistory>[0])
      setRecords(data)
    } catch {
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [projectId, commandFilter, successFilter, projectFilter])

  useEffect(() => { void loadHistory() }, [loadHistory])

  useEffect(() => {
    onFiltersChange?.({ commandFilter, successFilter, projectFilter })
  }, [commandFilter, onFiltersChange, projectFilter, successFilter])

  useEffect(() => {
    if (!selectedRunId) { setRunOutput(''); return }
    setOutputLoading(true)
    void getRunOutput(selectedRunId).then(setRunOutput).catch(() => setRunOutput('')).finally(() => setOutputLoading(false))
  }, [selectedRunId])

  const selectedRecord = records.find((r) => r.id === selectedRunId)

  function formatDuration(start: string, end: string | null): string {
    if (!end) return 'running...'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (ms < 1000) return `${ms}ms`
    const sec = Math.floor(ms / 1000)
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
  }

  async function handleDelete(id: string) {
    await deleteRunRecord(id)
    if (selectedRunId === id) setSelectedRunId('')
    void loadHistory()
  }

  const historySummary = useMemo(() => ({
    total: records.length,
    success: records.filter((record) => record.success === true).length,
    failed: records.filter((record) => record.success === false).length,
    running: records.filter((record) => record.success === null).length
  }), [records])

  return (
    <>
      <div className="tf-section">
        <h3>Run History</h3>
        <div className="tf-overview-card-grid">
          <div className="tf-overview-card info"><span>Total runs</span><strong>{historySummary.total}</strong></div>
          <div className="tf-overview-card success"><span>Successful</span><strong>{historySummary.success}</strong></div>
          <div className="tf-overview-card danger"><span>Failed</span><strong>{historySummary.failed}</strong></div>
          <div className="tf-overview-card warning"><span>Running</span><strong>{historySummary.running}</strong></div>
        </div>
        <div className="tf-history-filters">
          <div className="tf-history-filter-group">
            <label>Scope</label>
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value as 'current' | 'all')}>
              <option value="current">Current Project</option>
              <option value="all">All Projects</option>
            </select>
          </div>
          <div className="tf-history-filter-group">
            <label>Command</label>
            <select value={commandFilter} onChange={(e) => setCommandFilter(e.target.value as TerraformCommandName | 'all')}>
              <option value="all">All</option>
              <option value="init">init</option>
              <option value="plan">plan</option>
              <option value="apply">apply</option>
              <option value="destroy">destroy</option>
              <option value="import">import</option>
              <option value="state-mv">state mv</option>
              <option value="state-rm">state rm</option>
              <option value="force-unlock">force-unlock</option>
            </select>
          </div>
          <div className="tf-history-filter-group">
            <label>Result</label>
            <select value={successFilter} onChange={(e) => setSuccessFilter(e.target.value as 'all' | 'success' | 'failure')}>
              <option value="all">All</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
            </select>
          </div>
          <button className="tf-toolbar-btn" onClick={() => void loadHistory()} style={{ alignSelf: 'flex-end' }}>Refresh</button>
        </div>
      </div>

      {loading ? (
        <SvcState variant="loading" resourceName="history" />
      ) : records.length === 0 ? (
        <SvcState variant="empty" resourceName="run history" />
      ) : (
        <div className="tf-history-layout">
          <div className="tf-history-list">
            <table className="tf-data-table tf-history-table">
              <colgroup>
                <col className="tf-history-table__time" />
                {projectFilter === 'all' && <col className="tf-history-table__project" />}
                <col className="tf-history-table__command" />
                <col className="tf-history-table__workspace" />
                <col className="tf-history-table__result" />
                <col className="tf-history-table__duration" />
              </colgroup>
              <thead>
                <tr>
                  <th>Time</th>
                  {projectFilter === 'all' && <th>Project</th>}
                  <th>Command</th>
                  <th>Workspace</th>
                  <th>Result</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className={r.id === selectedRunId ? 'active' : ''} onClick={() => setSelectedRunId(r.id)}>
                    <td title={r.startedAt}>
                      <span className="tf-table-text">{formatIsoDate(r.startedAt)}</span>
                    </td>
                    {projectFilter === 'all' && (
                      <td title={r.projectName}>
                        <span className="tf-table-text">{r.projectName}</span>
                      </td>
                    )}
                    <td><span className={`tf-history-cmd ${r.command}`}>{r.command}</span></td>
                    <td title={r.workspace}>
                      <span className="tf-table-text">{r.workspace}</span>
                    </td>
                    <td>
                      {r.success === null
                        ? <span className="tf-history-result running">running</span>
                        : r.success
                          ? <span className="tf-history-result success">success</span>
                          : <span className="tf-history-result failure">failed</span>
                      }
                    </td>
                    <td>
                      <span className="tf-table-text">{formatDuration(r.startedAt, r.finishedAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedRecord && (
            <div className="tf-history-detail">
              <div className="tf-section">
                <div className="tf-section-head">
                  <h3>Run Detail</h3>
                  <div className="tf-history-detail-actions">
                    <button className="tf-toolbar-btn" onClick={() => {
                      onOpenProject?.(selectedRecord.projectId)
                      onOpenTab?.('actions')
                    }}>Open Project</button>
                    <button className="tf-toolbar-btn" onClick={() => {
                      onOpenProject?.(selectedRecord.projectId)
                      onOpenTab?.('drift')
                    }}>Open Drift</button>
                    <button className="tf-toolbar-btn danger" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => void handleDelete(selectedRecord.id)}>Delete</button>
                  </div>
                </div>
                <div className={`tf-remediation-card ${selectedRecord.success ? 'success' : selectedRecord.success === false ? 'danger' : 'warning'}`}>
                  <span className="tf-plan-summary-label">Outcome interpretation</span>
                  <strong>{selectedRecord.success === null ? 'Run in progress' : selectedRecord.success ? 'Successful command' : 'Command failed'}</strong>
                  <span>{describeRunOutcome(selectedRecord)}</span>
                </div>
                <div className="tf-kv">
                  <div className="tf-kv-row"><div className="tf-kv-label">Command</div><div className="tf-kv-value">{selectedRecord.command}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Project</div><div className="tf-kv-value">{selectedRecord.projectName}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Workspace</div><div className="tf-kv-value"><span className="tf-workspace-badge">{selectedRecord.workspace}</span></div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Region</div><div className="tf-kv-value">{selectedRecord.region || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Connection</div><div className="tf-kv-value">{selectedRecord.connectionLabel || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Backend</div><div className="tf-kv-value">{selectedRecord.backendType}</div></div>
                  {selectedRecord.git && (
                    <>
                      <div className="tf-kv-row"><div className="tf-kv-label">Git Head</div><div className="tf-kv-value">{formatGitHead(selectedRecord.git.branch, selectedRecord.git.shortCommitSha, selectedRecord.git.isDetached)}</div></div>
                      <div className="tf-kv-row"><div className="tf-kv-label">Git Tree</div><div className="tf-kv-value">{selectedRecord.git.isDirty ? 'Dirty' : 'Clean'}</div></div>
                      <div className="tf-kv-row"><div className="tf-kv-label">Repo Root</div><div className="tf-kv-value">{selectedRecord.git.repoRoot}</div></div>
                    </>
                  )}
                  <div className="tf-kv-row"><div className="tf-kv-label">State Source</div><div className="tf-kv-value">{selectedRecord.stateSource || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Started</div><div className="tf-kv-value">{selectedRecord.startedAt}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Finished</div><div className="tf-kv-value">{selectedRecord.finishedAt || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Duration</div><div className="tf-kv-value">{formatDuration(selectedRecord.startedAt, selectedRecord.finishedAt)}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Exit Code</div><div className="tf-kv-value">{selectedRecord.exitCode ?? '-'}</div></div>
                  {selectedRecord.stateOperationSummary && (
                    <div className="tf-kv-row"><div className="tf-kv-label">State Op</div><div className="tf-kv-value">{selectedRecord.stateOperationSummary}</div></div>
                  )}
                  {selectedRecord.backupPath && (
                    <div className="tf-kv-row"><div className="tf-kv-label">Backup</div><div className="tf-kv-value">{selectedRecord.backupPath}</div></div>
                  )}
                  {selectedRecord.backupCreatedAt && (
                    <div className="tf-kv-row"><div className="tf-kv-label">Backup Time</div><div className="tf-kv-value">{formatIsoDate(selectedRecord.backupCreatedAt)}</div></div>
                  )}
                  <div className="tf-kv-row">
                    <div className="tf-kv-label">Result</div>
                    <div className="tf-kv-value">
                      {selectedRecord.success === null ? 'Running' : selectedRecord.success ? 'Success' : 'Failed'}
                    </div>
                  </div>
                  {selectedRecord.args.length > 0 && (
                    <div className="tf-kv-row"><div className="tf-kv-label">Args</div><div className="tf-kv-value" style={{ fontFamily: '"Cascadia Code","Fira Code",monospace', fontSize: 11 }}>{selectedRecord.args.join(' ')}</div></div>
                  )}
                </div>
                {selectedRecord.planSummary && (
                  <div className="tf-summary" style={{ marginTop: 12 }}>
                    <span className="tf-summary-item"><span className="tf-summary-count create">{selectedRecord.planSummary.create}</span> create</span>
                    <span className="tf-summary-item"><span className="tf-summary-count update">{selectedRecord.planSummary.update}</span> update</span>
                    <span className="tf-summary-item"><span className="tf-summary-count delete">{selectedRecord.planSummary.delete}</span> delete</span>
                    <span className="tf-summary-item"><span className="tf-summary-count replace">{selectedRecord.planSummary.replace}</span> replace</span>
                  </div>
                )}
              </div>
              <div className="tf-section">
                <h3>Output</h3>
                {outputLoading ? (
                  <SvcState variant="loading" resourceName="output" compact />
                ) : (
                  <div className="tf-output-panel">{runOutput || '(no output)'}</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

export function TerraformConsole({ connection, refreshNonce = 0, onRunTerminalCommand, onNavigateService }: {
  connection: AwsConnection
  refreshNonce?: number
  onRunTerminalCommand?: (command: string) => void
  onNavigateService?: (serviceId: ServiceId, resourceId?: string) => void
}) {
  const [uiState, setUiState] = useState<TerraformUiState>(() => loadTerraformUiState())
  const [cliInfo, setCliInfo] = useState<TerraformCliInfo | null>(null)
  const [projects, setProjectsList] = useState<TerraformProjectListItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<TerraformProject | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('actions')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState('')
  const [lastLog, setLastLog] = useState<TerraformCommandLog | null>(null)
  const [driftReport, setDriftReport] = useState<TerraformDriftReport | null>(null)
  const [driftLoading, setDriftLoading] = useState(false)
  const [driftError, setDriftError] = useState('')
  const [driftStatusFilter, setDriftStatusFilter] = useState<'all' | TerraformDriftStatus>('all')
  const [driftTypeFilter, setDriftTypeFilter] = useState('all')
  const [selectedDriftKey, setSelectedDriftKey] = useState('')
  const [stateDraft, setStateDraft] = useState<StateOperationDraft | null>(null)
  const [labReport, setLabReport] = useState<ObservabilityPostureReport | null>(null)
  const [labLoading, setLabLoading] = useState(false)
  const [labError, setLabError] = useState('')

  // Governance
  const [governanceToolkit, setGovernanceToolkit] = useState<TerraformGovernanceToolkit | null>(null)
  const [governanceReport, setGovernanceReport] = useState<TerraformGovernanceReport | null>(null)
  const [governanceRunning, setGovernanceRunning] = useState(false)

  // Dialogs
  const [showInputs, setShowInputs] = useState(false)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [showCreateWorkspaceDialog, setShowCreateWorkspaceDialog] = useState(false)
  const [showDeleteWorkspaceDialog, setShowDeleteWorkspaceDialog] = useState(false)
  const [prefillMissing, setPrefillMissing] = useState<string[]>([])
  const [resumeCommandAfterInputs, setResumeCommandAfterInputs] = useState<null | {
    command: 'plan' | 'apply' | 'destroy'
    planOptions?: TerraformPlanOptions
  }>(null)
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; description: string; confirmWord: string; onConfirm: () => void
  } | null>(null)
  const [summaryDialog, setSummaryDialog] = useState<{
    title: string; summary: TerraformProject['lastPlanSummary']; changes?: TerraformPlanChange[]; onConfirm: () => void
  } | null>(null)

  // Progress overlay
  const [progressLine, setProgressLine] = useState('')
  const [showProgress, setShowProgress] = useState(false)
  const [progressItems, setProgressItems] = useState<Map<string, { status: string; done: boolean }>>(new Map())
  const driftLoadKeyRef = useRef('')
  const {
    freshness: workspaceFreshness,
    beginRefresh: beginWorkspaceRefresh,
    completeRefresh: completeWorkspaceRefresh,
    failRefresh: failWorkspaceRefresh
  } = useFreshnessState({ staleAfterMs: 5 * 60 * 1000 })
  const {
    freshness: driftFreshness,
    beginRefresh: beginDriftRefresh,
    completeRefresh: completeDriftRefresh,
    failRefresh: failDriftRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  const cliOk = cliInfo?.found === true
  const contextKey = terraformContextKey(connection)
  const projectConnection = connectionForProject(connection, detail)
  const persistedSelectedId = uiState.selectedProjectByContext[contextKey] ?? ''
  const persistedDetailTab = uiState.detailTabByContext[contextKey] ?? 'actions'
  const persistedHistoryFilters = detail ? uiState.historyFiltersByProject[detail.id] : undefined
  const persistedDriftStatusFilter = detail ? (uiState.driftStatusFilterByProject[detail.id] ?? 'all') : 'all'
  const persistedDriftTypeFilter = detail ? (uiState.driftTypeFilterByProject[detail.id] ?? 'all') : 'all'

  useEffect(() => {
    saveTerraformUiState(uiState)
  }, [uiState])

  // Detect CLI on mount
  useEffect(() => {
    void detectCli().then(setCliInfo).catch(() => {
      setCliInfo({ found: false, kind: '', label: '', path: '', version: '', error: 'Failed to detect infrastructure CLI.', available: [] })
    })
  }, [])

  // Reset state only when the AWS/Terraform context changes.
  useEffect(() => {
    setSelectedId(persistedSelectedId)
    setDetail(null)
    setProjectsList([])
    setDriftReport(null)
    setDriftError('')
    setSelectedDriftKey('')
    setLabReport(null)
    setLabError('')
    setDetailTab(persistedDetailTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey])

  // Load projects
  const reload = useCallback(async () => {
    beginWorkspaceRefresh('manual')
    setLoading(true)
    try {
      const list = await listProjects(contextKey, connection)
      setProjectsList(list)
      completeWorkspaceRefresh()
    } catch (err) {
      failWorkspaceRefresh()
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [beginWorkspaceRefresh, completeWorkspaceRefresh, connection, contextKey, failWorkspaceRefresh])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    if (projects.length === 0) return
    if (selectedId && projects.some((project) => project.id === selectedId)) return
    const persistedId = persistedSelectedId
    const fallbackId = projects.some((project) => project.id === persistedId) ? persistedId : projects[0]?.id
    if (fallbackId) setSelectedId(fallbackId)
  }, [contextKey, persistedSelectedId, projects, selectedId])

  useEffect(() => {
    if (refreshNonce === 0) {
      return
    }

    void handleReload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  // Load detail when selected
  useEffect(() => {
    if (!selectedId) { setDetail(null); setDriftReport(null); return }
    void getProject(contextKey, selectedId, connection).then((p) => {
      setDetail(p)
      setDriftReport(null)
      setDriftError('')
      setSelectedDriftKey('')
      setLabReport(null)
      setLabError('')
      void setSelectedProjectId(contextKey, selectedId)
    }).catch(() => setDetail(null))
  }, [connection, contextKey, selectedId])

  useEffect(() => {
    if (!detail) return
    setDriftStatusFilter(persistedDriftStatusFilter)
    setDriftTypeFilter(persistedDriftTypeFilter)
  }, [detail?.id, persistedDriftStatusFilter, persistedDriftTypeFilter])

  useEffect(() => {
    if (!selectedId) return
    setUiState((current) => {
      if (current.selectedProjectByContext[contextKey] === selectedId) return current
      return {
        ...current,
        selectedProjectByContext: {
          ...current.selectedProjectByContext,
          [contextKey]: selectedId
        }
      }
    })
  }, [contextKey, selectedId])

  useEffect(() => {
    setUiState((current) => {
      if (current.detailTabByContext[contextKey] === detailTab) return current
      return {
        ...current,
        detailTabByContext: {
          ...current.detailTabByContext,
          [contextKey]: detailTab
        }
      }
    })
  }, [contextKey, detailTab])

  useEffect(() => {
    if (!detail) return
    setUiState((current) => {
      const statusSame = current.driftStatusFilterByProject[detail.id] === driftStatusFilter
      const typeSame = current.driftTypeFilterByProject[detail.id] === driftTypeFilter
      if (statusSame && typeSame) return current
      return {
        ...current,
        driftStatusFilterByProject: statusSame
          ? current.driftStatusFilterByProject
          : {
              ...current.driftStatusFilterByProject,
              [detail.id]: driftStatusFilter
            },
        driftTypeFilterByProject: typeSame
          ? current.driftTypeFilterByProject
          : {
              ...current.driftTypeFilterByProject,
              [detail.id]: driftTypeFilter
            }
      }
    })
  }, [detail, driftStatusFilter, driftTypeFilter])

  const loadDrift = useCallback(async (options?: { forceRefresh?: boolean }) => {
    if (!detail) return
    const requestKey = `${contextKey}:${detail.id}:${projectConnection.region}:${options?.forceRefresh ? 'force' : 'normal'}`
    if (driftLoadKeyRef.current === requestKey) return
    driftLoadKeyRef.current = requestKey
    beginDriftRefresh(options?.forceRefresh ? 'manual' : 'background')
    setDriftLoading(true)
    setDriftError('')
    try {
      const report = await getDrift(contextKey, detail.id, projectConnection, options)
      setDriftReport(report)
      setSelectedDriftKey((current) => current || (report.items[0] ? driftItemKey(report.items[0]) : ''))
      completeDriftRefresh()
    } catch (err) {
      failDriftRefresh()
      setDriftError(err instanceof Error ? err.message : String(err))
    } finally {
      if (driftLoadKeyRef.current === requestKey) {
        driftLoadKeyRef.current = ''
      }
      setDriftLoading(false)
    }
  }, [beginDriftRefresh, completeDriftRefresh, contextKey, detail, failDriftRefresh, projectConnection])

  const detailTabRef = useRef(detailTab)
  const loadDriftRef = useRef(loadDrift)
  const reloadRef = useRef(reload)

  useEffect(() => {
    detailTabRef.current = detailTab
  }, [detailTab])

  useEffect(() => {
    loadDriftRef.current = loadDrift
  }, [loadDrift])

  useEffect(() => {
    reloadRef.current = reload
  }, [reload])

  useEffect(() => {
    if (detailTab !== 'drift' || !detail) return
    if (driftReport?.projectId === detail.id && driftReport.region === projectConnection.region) return
    void loadDrift()
  }, [detail, detailTab, driftReport, loadDrift, projectConnection.region])

  const loadLab = useCallback(async () => {
    if (!detail) return
    setLabLoading(true)
    setLabError('')
    try {
      const report = await getObservabilityReport(contextKey, detail.id, connection)
      setLabReport(report)
    } catch (err) {
      setLabError(err instanceof Error ? err.message : String(err))
    } finally {
      setLabLoading(false)
    }
  }, [connection, contextKey, detail])

  useEffect(() => {
    if (detailTab !== 'lab' || !detail) return
    if (labReport?.scope.kind === 'terraform' && labReport.scope.projectId === detail.id) return
    void loadLab()
  }, [detail, detailTab, labReport, loadLab])

  // Governance: detect tools once on CLI detect
  useEffect(() => {
    if (cliOk && !governanceToolkit?.detectedAt) {
      void detectGovernanceTools(cliInfo?.path, cliInfo?.label, cliInfo?.kind).then(setGovernanceToolkit).catch(() => {})
    }
  }, [cliOk, cliInfo?.kind, cliInfo?.label, cliInfo?.path, governanceToolkit?.detectedAt])

  // Governance: clear report when switching projects
  useEffect(() => {
    setGovernanceReport(null)
  }, [selectedId])

  const handleDetectGovernanceTools = useCallback(async () => {
    try {
      const tk = await detectGovernanceTools(cliInfo?.path, cliInfo?.label, cliInfo?.kind)
      setGovernanceToolkit(tk)
    } catch { /* ignore */ }
  }, [cliInfo?.kind, cliInfo?.label, cliInfo?.path])

  const handleCliSwitch = useCallback(async (nextKind: 'terraform' | 'opentofu') => {
    try {
      const next = await setCliKind(nextKind)
      setCliInfo(next)
      setGovernanceToolkit(null)
      setGovernanceReport(null)
      if (next.found) {
        const tk = await detectGovernanceTools(next.path, next.label, next.kind)
        setGovernanceToolkit(tk)
      }
      setMsg('')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleRunGovernanceChecks = useCallback(async () => {
    if (!detail) return
    setGovernanceRunning(true)
    try {
      const report = await runGovernanceChecks(contextKey, detail.id, connection)
      setGovernanceReport(report)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setGovernanceRunning(false)
    }
  }, [connection, contextKey, detail])

  // Subscribe to terraform events
  useEffect(() => {
    function handleEvent(event: unknown) {
      const e = event as Record<string, unknown>
      if (e.type === 'completed') {
        setRunning(false)
        setShowProgress(false)
        setProgressItems(new Map())
        const log = e.log as TerraformCommandLog
        setLastLog(log)
        if (e.project) setDetail(e.project as TerraformProject)
        const refreshesDrift = log.success && ['apply', 'destroy', 'import', 'state-mv', 'state-rm'].includes(log.command)
        if (refreshesDrift) {
          setDriftReport(null)
          setDriftError('')
          setSelectedDriftKey('')
          if (detailTabRef.current === 'drift') {
            void loadDriftRef.current({ forceRefresh: true })
          }
        }
        if (log.success && ['import', 'state-mv', 'state-rm', 'force-unlock'].includes(log.command)) {
          setMsg(`Completed ${log.command}. Project state views were reloaded.`)
        }
        void reloadRef.current()
      } else if (e.type === 'started') {
        setRunning(true)
        setShowProgress(true)
        setProgressLine('Starting...')
        setProgressItems(new Map())
        setLastLog(e.log as TerraformCommandLog)
      } else if (e.type === 'progress') {
        const raw = typeof e.raw === 'string' ? e.raw : ''
        if (raw) setProgressLine(raw)
        const address = typeof e.address === 'string' ? e.address : ''
        const status = typeof e.status === 'string' ? e.status : ''
        if (address) {
          setProgressItems(prev => {
            const next = new Map(prev)
            const done = /complete|error/i.test(status)
            next.set(address, { status, done })
            return next
          })
        }
      } else if (e.type === 'output') {
        // Update last log output live
        setLastLog((prev) => {
          if (!prev) return prev
          return { ...prev, output: prev.output + (e.chunk as string) }
        })
      }
    }
    subscribe(handleEvent)
    return () => unsubscribe(handleEvent)
  }, [])

  // Handlers
  async function handleAddProject() {
    const dir = await chooseProjectDirectory()
    if (!dir) return
    try {
      const project = await addProject(contextKey, dir, connection)
      await reload()
      setSelectedId(project.id)
      setMsg('')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemoveProject() {
    if (!selectedId) return
    try {
      await removeProject(contextKey, selectedId)
      setSelectedId('')
      setDetail(null)
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRenameProject(name: string) {
    if (!detail) return
    try {
      const updated = await renameProject(contextKey, detail.id, name)
      setDetail(updated)
      setShowRenameDialog(false)
      setMsg('')
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleOpenInVsCode() {
    if (!detail) return
    try {
      await openProjectInVsCode(detail.rootPath)
      setMsg('Opened Terraform project in VS Code')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleReload() {
    if (!selectedId) { await reload(); return }
    try {
      const p = await reloadProject(contextKey, selectedId, connection)
      setDetail(p)
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSelectWorkspace(workspaceName: string) {
    if (!detail || running || workspaceName === detail.currentWorkspace) return
    try {
      const updated = await selectWorkspace(contextKey, detail.id, workspaceName, connection)
      setDetail(updated)
      setMsg(`Switched to workspace ${updated.currentWorkspace}`)
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCreateWorkspace(workspaceName: string) {
    if (!detail) return
    try {
      const updated = await createWorkspace(contextKey, detail.id, workspaceName, connection)
      setDetail(updated)
      setShowCreateWorkspaceDialog(false)
      setMsg(`Created workspace ${updated.currentWorkspace}`)
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDeleteWorkspace(workspaceName: string) {
    if (!detail) return
    try {
      const updated = await deleteWorkspace(contextKey, detail.id, workspaceName, connection)
      setDetail(updated)
      setShowDeleteWorkspaceDialog(false)
      setMsg(`Deleted workspace ${workspaceName}`)
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  function handleShowInputs() {
    if (!detail) return
    setPrefillMissing([])
    setResumeCommandAfterInputs(null)
    setShowInputs(true)
  }

  async function handleSaveInputs(inputConfig: TerraformInputConfiguration) {
    if (!detail) return
    try {
      const updated = await updateInputs(contextKey, detail.id, inputConfig, connection)
      setDetail(updated)
      setShowInputs(false)
      setPrefillMissing([])
      setMsg('')
      const commandToResume = resumeCommandAfterInputs
      setResumeCommandAfterInputs(null)
      await reload()
      if (commandToResume) {
        const log = await runCommand({
          profileName: contextKey,
          connection,
          projectId: updated.id,
          command: commandToResume.command,
          ...(commandToResume.command === 'plan' ? { planOptions: commandToResume.planOptions } : {})
        })
        setLastLog(log)
        const refreshed = await reloadProject(contextKey, updated.id, connection)
        setDetail(refreshed)
        await reload()
        if (log.success && commandToResume.command === 'plan') {
          setMsg('')
          setDetailTab('actions')
        }
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function execCommand(command: 'init' | 'plan' | 'apply' | 'destroy', planOptions?: TerraformPlanOptions): Promise<TerraformCommandLog | null> {
    if (!detail || running) return null
    setMsg('')
    try {
      const log = await runCommand({ profileName: contextKey, connection, projectId: detail.id, command, ...(command === 'plan' ? { planOptions } : {}) })
      // Handle missing vars
      if (!log.success && log.output) {
        const { missing, invalid } = await detectMissingVars(log.output)
        const unresolved = uniqueStrings([...missing, ...invalid])
        if (unresolved.length > 0) {
          setPrefillMissing(unresolved)
          setMsg(
            unresolved.length === 1
              ? `Missing required Terraform variable: ${unresolved[0]}. The Inputs dialog is open so you can provide it.`
              : `Missing required Terraform variables: ${unresolved.join(', ')}. The Inputs dialog is open so you can provide them.`
          )
          setShowInputs(true)
          return log
        }
      }
      return log
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  function handleInit() { void execCommand('init') }
  function handlePlan(options?: TerraformPlanOptions) {
    if (!detail || running) return
    void validateProjectInputs(contextKey, detail.id, connection)
      .then((validation) => {
        const unresolved = uniqueStrings([
          ...validation.missing,
          ...validation.unresolvedSecrets.map((item) => item.name)
        ])
        if (!validation.valid && unresolved.length > 0) {
          setPrefillMissing(validation.missing)
          setResumeCommandAfterInputs({ command: 'plan', planOptions: options })
          setMsg(
            unresolved.length === 1
              ? `Terraform input needs attention: ${unresolved[0]}. The Inputs dialog is open so you can fix it.`
              : `Terraform inputs need attention: ${unresolved.join(', ')}. The Inputs dialog is open so you can fix them.`
          )
          setShowInputs(true)
          return null
        }
        return execCommand('plan', options)
      })
      .then((log) => {
        if (log) {
          setDetailTab('actions')
        }
      })
      .catch((err) => {
        setMsg(err instanceof Error ? err.message : String(err))
      })
  }

  function handleApply() {
    if (!detail) return
    if (!detail.hasSavedPlan) {
      setMsg('Run Plan first to create a saved plan before applying.')
      return
    }
    // Block apply when governance blocking checks have failed
    if (governanceReport && !governanceReport.allBlockingPassed) {
      setMsg('Apply is blocked: one or more required governance checks failed. Fix the issues and re-run Safety Checks.')
      return
    }
    const applyWarning = planCommitMismatchWarning(detail)
    // Has saved plan - go directly to summary with resource list
    setSummaryDialog({
      title: 'Apply Changes — Review',
      summary: detail.lastPlanSummary,
      changes: detail.planChanges,
      onConfirm: () => {
        setSummaryDialog(null)
        setConfirmDialog({
          title: 'Confirm Apply',
          description: `${applyWarning ? `${applyWarning}\n\n` : ''}You are about to apply ${detail.lastPlanSummary.create} create, ${detail.lastPlanSummary.update} update, ${detail.lastPlanSummary.delete} delete, ${detail.lastPlanSummary.replace} replace. This action cannot be easily undone.`,
          confirmWord: 'APPLY',
          onConfirm: () => {
            setConfirmDialog(null)
            void execCommand('apply')
          }
        })
      }
    })
  }

  function handleDestroy() {
    if (!detail) return
    if (!detail.hasSavedPlan) {
      setMsg('Run Plan first to create a saved plan before destroying.')
      return
    }
    // Block destroy when governance blocking checks have failed
    if (governanceReport && !governanceReport.allBlockingPassed) {
      setMsg('Destroy is blocked: one or more required governance checks failed. Fix the issues and re-run Safety Checks.')
      return
    }
    // First confirmation: show what will be destroyed
    const destroySummary = {
      ...emptyPlanSummary('standard'),
      delete: detail.stateAddresses.length,
      hasChanges: detail.stateAddresses.length > 0,
      affectedResources: detail.stateAddresses.length,
      affectedModules: ['root'],
      hasDestructiveChanges: detail.stateAddresses.length > 0,
      isDeleteHeavy: detail.stateAddresses.length > 0
    }
    const destroyChanges: TerraformPlanChange[] = detail.stateAddresses.map(addr => {
      const parts = addr.split('.')
      const type = parts[0] ?? addr
      return {
        address: addr,
        type,
        name: parts.slice(1).join('.'),
        modulePath: 'root',
        provider: '',
        providerDisplayName: '',
        service: type.startsWith('aws_') ? type.replace(/^aws_/, '').split('_')[0] : 'unknown',
        actions: ['delete'],
        actionLabel: 'delete',
        mode: 'managed',
        actionReason: 'destroy',
        replacePaths: [],
        changedAttributes: [],
        beforeIdentity: addr,
        afterIdentity: 'destroyed',
        isDestructive: true,
        isReplacement: false
      }
    })
    setSummaryDialog({
      title: 'Destroy Infrastructure — Review',
      summary: destroySummary,
      changes: destroyChanges,
      onConfirm: () => {
        setSummaryDialog(null)
        // Second confirmation: typed
        setConfirmDialog({
          title: 'Confirm Destroy',
          description: `This will permanently destroy ${detail.stateAddresses.length} managed resource${detail.stateAddresses.length !== 1 ? 's' : ''}. This cannot be undone.`,
          confirmWord: 'DESTROY',
          onConfirm: () => {
            setConfirmDialog(null)
            void execCommand('destroy')
          }
        })
      }
    })
  }

  async function execStateCommand(request: {
    command: 'import' | 'state-mv' | 'state-rm' | 'force-unlock'
    importAddress?: string
    importId?: string
    stateAddress?: string
    stateFromAddress?: string
    stateToAddress?: string
    lockId?: string
  }) {
    if (!detail || running) return
    setMsg('')
    setDriftReport(null)
    setDriftError('')
    setLabReport(null)
    setLabError('')
    try {
      const log = await runCommand({
        profileName: contextKey,
        connection,
        projectId: detail.id,
        ...request
      })
      setLastLog(log)
      if (!log.success) {
        setMsg(`State operation failed: ${log.output.split('\n').slice(-1)[0] || 'see output for details'}`)
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  function handleStateImport(address: string, importId: string) {
    void execStateCommand({ command: 'import', importAddress: address, importId })
  }

  function handleStateMove(fromAddress: string, toAddress: string) {
    setConfirmDialog({
      title: 'Confirm State Move',
      description: `Move state from ${fromAddress} to ${toAddress}. A local backup will be captured first.`,
      confirmWord: 'MOVE',
      onConfirm: () => {
        setConfirmDialog(null)
        void execStateCommand({ command: 'state-mv', stateFromAddress: fromAddress, stateToAddress: toAddress })
      }
    })
  }

  function handleStateRemove(address: string) {
    setConfirmDialog({
      title: 'Confirm State Remove',
      description: `Remove ${address} from state without deleting the provider resource. A local backup will be captured first.`,
      confirmWord: 'REMOVE',
      onConfirm: () => {
        setConfirmDialog(null)
        void execStateCommand({ command: 'state-rm', stateAddress: address })
      }
    })
  }

  function handleForceUnlock(lockId: string) {
    setConfirmDialog({
      title: 'Confirm Force Unlock',
      description: `Force-unlock state lock ${lockId}. Only continue if no active apply, plan, or state operation still owns the lock. A local backup will be captured first.`,
      confirmWord: 'UNLOCK',
      onConfirm: () => {
        setConfirmDialog(null)
        void execStateCommand({ command: 'force-unlock', lockId })
      }
    })
  }

  function handleOpenDriftConsole(item: TerraformDriftItem) {
    if (!item.consoleUrl) return
    void openExternalUrl(item.consoleUrl)
  }

  function handleRunDriftStateShow(item: TerraformDriftItem) {
    if (!item.terminalCommand) return
    onRunTerminalCommand?.(item.terminalCommand)
    setMsg(`${cliDisplayName(cliInfo)} state command opened in terminal`)
  }

  function handlePrepareDriftImport(item: TerraformDriftItem) {
    const importAddress = item.relatedTerraformAddresses[0] || item.terraformAddress || ''
    const importId = item.cloudIdentifier || item.logicalName || ''
    setStateDraft({ mode: 'import', importAddress, importId })
    setDetailTab('state')
    setMsg('Prepared import flow from the selected drift finding.')
  }

  function handlePrepareDriftMove(item: TerraformDriftItem) {
    const moveFrom = item.terraformAddress || ''
    const moveTo = item.relatedTerraformAddresses[0] || ''
    setStateDraft({ mode: 'move', moveFrom, moveTo })
    setDetailTab('state')
    setMsg('Prepared state move flow from the selected drift finding.')
  }

  function handlePrepareDriftRemove(item: TerraformDriftItem) {
    const removeAddress = item.terraformAddress || ''
    setStateDraft({ mode: 'remove', removeAddress })
    setDetailTab('state')
    setMsg('Prepared state remove flow from the selected drift finding.')
  }

  function handleLabArtifactRun(artifact: GeneratedArtifact) {
    onRunTerminalCommand?.(artifact.content)
    setMsg(`${cliDisplayName(cliInfo)} artifact opened in terminal`)
  }

  function handleLabSignalNavigate(signal: CorrelatedSignalReference) {
    if (signal.targetView === 'drift') {
      setDetailTab('drift')
    }
  }

  const readyProjectCount = projects.filter((project) => project.status !== 'Missing').length
  const totalManagedResources = projects.reduce((sum, project) => sum + (project.metadata?.resourceCount ?? project.inventory?.length ?? 0), 0)
  const workspaceCount = new Set(projects.map((project) => project.currentWorkspace).filter(Boolean)).size
  const selectedPlanSummary = detail?.lastPlanSummary
  const selectedInputIssues = detail ? detail.inputValidation.missing.length + detail.inputValidation.unresolvedSecrets.length : 0
  const selectedProjectStatus = detail
    ? summarizeProjectStatus({
        id: detail.id,
        name: detail.name,
        rootPath: detail.rootPath,
        status: detail.status,
        stateSource: detail.stateSource,
        metadata: detail.metadata,
        lastPlanSummary: detail.lastPlanSummary,
        lastCommandAt: detail.lastCommandAt,
        inventory: detail.inventory,
        environment: detail.environment,
        currentWorkspace: detail.currentWorkspace
      })
    : null

  return (
    <div className="tf-console">
      <section className="tf-shell-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">Terraform / OpenTofu service</div>
          <h2>{detail ? detail.name : 'Infrastructure command center'}</h2>
          <p>
            {detail
              ? `Plan, apply, drift review, state operations, and governance checks for ${detail.environment.environmentLabel}.`
              : 'Select an infrastructure project to review readiness, manage state, inspect drift, and track command history.'}
          </p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill">
              <span>CLI</span>
              <strong>{cliInfo?.found ? `${cliInfo.label} ${cliInfo.version}` : 'Unavailable'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Workspace</span>
              <strong>{detail?.currentWorkspace || `${workspaceCount || 0} active`}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Backend</span>
              <strong>{detail?.metadata.backendType || 'Project inventory'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Context</span>
              <strong>{detail?.environment.connectionLabel || connection?.profile || 'Local shell'}</strong>
            </div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent">
            <span>Projects</span>
            <strong>{projects.length}</strong>
            <small>{readyProjectCount} ready for review</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Managed resources</span>
            <strong>{detail?.metadata.resourceCount ?? totalManagedResources}</strong>
            <small>{detail ? 'Selected project inventory' : 'Across tracked projects'}</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Plan posture</span>
            <strong>{selectedPlanSummary?.affectedResources ?? 0}</strong>
            <small>{detail ? 'Resources touched in last saved plan' : 'Select a project to inspect changes'}</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Input posture</span>
            <strong>{detail ? (selectedInputIssues === 0 ? 'Ready' : selectedInputIssues) : 'Standby'}</strong>
            <small>{detail ? (selectedInputIssues === 0 ? 'No missing inputs' : 'Variables need attention') : 'Project-specific checks appear here'}</small>
          </div>
        </div>
      </section>

      <div className="tf-shell-toolbar">
        <div className="tf-toolbar">
          <button className="tf-toolbar-btn accent" onClick={handleAddProject} disabled={!cliOk}>Add Project</button>
          <button className="tf-toolbar-btn" onClick={() => setShowRenameDialog(true)} disabled={!detail}>Rename</button>
          <button className="tf-toolbar-btn" onClick={() => void handleOpenInVsCode()} disabled={!detail}>Open in VS Code</button>
          <button className="tf-toolbar-btn danger" onClick={handleRemoveProject} disabled={!selectedId}>Remove Project</button>
          <button className="tf-toolbar-btn" onClick={handleReload} disabled={loading}>Reload</button>
          <button className="tf-toolbar-btn" onClick={handleShowInputs} disabled={!detail}>Inputs</button>
        </div>
        <div className="tf-shell-status">
          {cliInfo && !cliInfo.found && (
            <div className="tf-cli-banner">{cliInfo.error || 'OpenTofu or Terraform CLI not found. Please install one of them.'}</div>
          )}
          {cliInfo?.found && (
            <div className="tf-cli-banner success">{cliInfo.path}</div>
          )}
          {cliInfo?.available && cliInfo.available.length > 1 && (
            <label className="tf-cli-banner success" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>Active CLI</span>
              <select
                value={cliInfo.kind}
                onChange={(event) => void handleCliSwitch(event.target.value as 'terraform' | 'opentofu')}
                disabled={running || governanceRunning}
              >
                {cliInfo.available.map((option) => (
                  <option key={option.kind} value={option.kind}>{option.label}</option>
                ))}
              </select>
            </label>
          )}
          <FreshnessIndicator freshness={workspaceFreshness} label="Workspace inventory last updated" />
          {detailTab === 'drift' && <FreshnessIndicator freshness={driftFreshness} label="Drift last updated" staleLabel="Re-scan drift" />}
        </div>
      </div>

      <CollapsibleInfoPanel title="Quick Help" className="tf-info-panel">
        <div className="tf-section-hint">
          Track a project, confirm the active workspace and CLI, review inputs before plan/apply, then use drift, governance, state operations, and run history as follow-up surfaces instead of leaving the shell.
        </div>
      </CollapsibleInfoPanel>

      {msg && <div className={`tf-msg ${msg.toLowerCase().includes('error') || msg.toLowerCase().includes('not found') ? 'error' : ''}`}>{msg}</div>}

      <div className="tf-main-layout">
        <div className="tf-project-table-area">
          {projects.length === 0 ? (
            <SvcState variant="empty" message="No projects added. Click Add Project to get started." />
          ) : (
            <>
              <div className="tf-pane-head">
                <div>
                  <span className="tf-pane-kicker">Tracked projects</span>
                  <h3>Workspace inventory</h3>
                </div>
                <span className="tf-pane-summary">{projects.length} total</span>
              </div>
              <div className="tf-project-list">
                {projects.map((project) => {
                  const status = summarizeProjectStatus(project)
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className={`tf-project-row ${project.id === selectedId ? 'active' : ''}`}
                      onClick={() => setSelectedId(project.id)}
                    >
                      <div className="tf-project-row-top">
                        <div className="tf-project-row-copy">
                          <strong>{project.name}</strong>
                          <span title={project.rootPath}>{formatProjectPath(project.rootPath)}</span>
                        </div>
                        <span className={`tf-status-badge ${status.tone}`}>{status.label}</span>
                      </div>
                      <div className="tf-project-row-meta">
                        <span>{project.currentWorkspace}</span>
                        <span>{project.metadata.backendType}</span>
                        <span>{project.environment.region || 'global'}</span>
                      </div>
                      <div className="tf-project-row-metrics">
                        <div>
                          <span>Resources</span>
                          <strong>{project.inventory?.length ?? project.metadata?.resourceCount ?? 0}</strong>
                        </div>
                        <div>
                          <span>State</span>
                          <strong>{project.stateSource || '-'}</strong>
                        </div>
                        <div>
                          <span>Last run</span>
                          <strong>{project.lastCommandAt ? formatIsoDate(project.lastCommandAt) : 'Not run yet'}</strong>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>

        <div className="tf-detail-pane">
          {!detail ? (
            <SvcState variant="no-selection" resourceName="project" message="Select a project to view details." />
          ) : (
            <>
              <section className="tf-detail-hero">
                <div className="tf-detail-hero-copy">
                  <div className="eyebrow">Project posture</div>
                  <h3>{detail.name}</h3>
                  <p>{detail.rootPath}</p>
                  <div className="tf-detail-meta-strip">
                    <div className="tf-detail-meta-pill">
                      <span>Workspace</span>
                      <strong>{detail.currentWorkspace}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Environment</span>
                      <strong>{detail.environment.environmentLabel}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Backend</span>
                      <strong>{detail.metadata.backend.label}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Git</span>
                      <strong>{gitStatusSummary(detail)}</strong>
                    </div>
                  </div>
                </div>
                <div className="tf-detail-hero-stats">
                  <div className={`tf-detail-stat-card ${selectedProjectStatus?.tone ?? 'info'}`}>
                    <span>Project state</span>
                    <strong>{selectedProjectStatus?.label ?? 'Selected'}</strong>
                    <small>{detail.status ?? 'Ready'}</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Resources</span>
                    <strong>{detail.metadata.resourceCount}</strong>
                    <small>{detail.stateAddresses.length} tracked in state</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Modules</span>
                    <strong>{detail.metadata.moduleCount}</strong>
                    <small>{detail.metadata.providerNames.length} providers</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Plan blast radius</span>
                    <strong>{detail.lastPlanSummary.affectedResources}</strong>
                    <small>{detail.lastPlanSummary.hasChanges ? 'Affected resources in saved plan' : 'No saved changes yet'}</small>
                  </div>
                </div>
              </section>

              <div className="tf-detail-tabs">
                <button className={detailTab === 'actions' ? 'active' : ''} onClick={() => setDetailTab('actions')}>Actions</button>
                <button className={detailTab === 'state' ? 'active' : ''} onClick={() => setDetailTab('state')}>State</button>
                <button className={detailTab === 'resources' ? 'active' : ''} onClick={() => setDetailTab('resources')}>Resources</button>
                <button className={detailTab === 'drift' ? 'active' : ''} onClick={() => setDetailTab('drift')}>Drift</button>
                <button className={detailTab === 'lab' ? 'active' : ''} onClick={() => setDetailTab('lab')}>Lab</button>
                <button className={detailTab === 'history' ? 'active' : ''} onClick={() => setDetailTab('history')}>History</button>
              </div>

              <div className="tf-section tf-project-info-shell">
                <details className="tf-collapsible">
                  <summary className="tf-collapsible-summary">Project Info</summary>
                  <div className="tf-kv tf-collapsible-body">
                    <div className="tf-kv-row"><div className="tf-kv-label">Name</div><div className="tf-kv-value">{detail.name}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Path</div><div className="tf-kv-value">{detail.rootPath}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Environment</div><div className="tf-kv-value">{detail.environment.environmentLabel}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Workspace</div><div className="tf-kv-value"><span className="tf-workspace-badge">{detail.currentWorkspace}</span></div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Overlay</div><div className="tf-kv-value">{detail.inputView.selectedOverlay || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Backend</div><div className="tf-kv-value">{detail.metadata.backendType}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Backend Detail</div><div className="tf-kv-value">{detail.metadata.backend.label}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Git</div><div className="tf-kv-value">{gitStatusSummary(detail)}</div></div>
                  {detail.metadata.git?.status === 'ready' && (
                    <>
                      <div className="tf-kv-row"><div className="tf-kv-label">Repo Root</div><div className="tf-kv-value">{detail.metadata.git.repoRoot}</div></div>
                      <div className="tf-kv-row"><div className="tf-kv-label">Repo Path</div><div className="tf-kv-value">{detail.metadata.git.projectRelativePath}</div></div>
                      {detail.savedPlanMetadata?.git && (
                        <div className="tf-kv-row"><div className="tf-kv-label">Saved Plan Git</div><div className="tf-kv-value">{formatGitHead(detail.savedPlanMetadata.git.branch, detail.savedPlanMetadata.git.shortCommitSha, detail.savedPlanMetadata.git.isDetached)}{detail.savedPlanMetadata.git.isDirty ? ' • dirty' : ''}</div></div>
                      )}
                    </>
                  )}
                  {'effectiveStateKey' in detail.metadata.backend && (
                    <div className="tf-kv-row"><div className="tf-kv-label">State Key</div><div className="tf-kv-value">{detail.metadata.backend.effectiveStateKey}</div></div>
                  )}
                  {'stateLocation' in detail.metadata.backend && (
                    <div className="tf-kv-row"><div className="tf-kv-label">State Path</div><div className="tf-kv-value">{detail.metadata.backend.stateLocation}</div></div>
                  )}
                  <div className="tf-kv-row"><div className="tf-kv-label">Region</div><div className="tf-kv-value">{detail.environment.region || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Profile/Session</div><div className="tf-kv-value">{detail.environment.connectionLabel || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Var Set</div><div className="tf-kv-value">{detail.environment.varSetLabel || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Input Status</div><div className="tf-kv-value">{detail.inputValidation.valid ? 'Ready' : `Needs attention (${detail.inputValidation.missing.length + detail.inputValidation.unresolvedSecrets.length})`}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Providers</div><div className="tf-kv-value">{detail.metadata.providerNames.join(', ') || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">TF Files</div><div className="tf-kv-value">{detail.metadata.tfFileCount}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Resources</div><div className="tf-kv-value">{detail.metadata.resourceCount}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Variables</div><div className="tf-kv-value">{detail.metadata.variableCount}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Var File</div><div className="tf-kv-value">{detail.varFile || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">State Source</div><div className="tf-kv-value">{detail.stateSource || 'none'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Latest Backup</div><div className="tf-kv-value">{detail.latestStateBackup ? formatIsoDate(detail.latestStateBackup.createdAt) : 'none yet'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Backup Folder</div><div className="tf-kv-value">{detail.latestStateBackup?.path || 'created on first destructive state operation'}</div></div>
                  {detail.metadata.git?.status === 'ready' && detail.metadata.git.changedTerraformFiles.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div className="tf-section-hint">Changed Terraform files in this project checkout</div>
                      <div className="tf-kv" style={{ marginTop: 8 }}>
                        {detail.metadata.git.changedTerraformFiles.map((file) => (
                          <div key={`${file.status}:${file.path}`} className="tf-kv-row">
                            <div className="tf-kv-label">{file.status}</div>
                            <div className="tf-kv-value">{file.path}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  </div>
                </details>
              </div>

              <WorkspaceControls
                project={detail}
                running={running}
                onSelectWorkspace={handleSelectWorkspace}
                onCreateWorkspace={() => setShowCreateWorkspaceDialog(true)}
                onDeleteWorkspace={() => setShowDeleteWorkspaceDialog(true)}
              />

              {detailTab === 'actions' && (
                <ActionsTab
                  project={detail}
                  cliOk={cliOk}
                  cliLabel={cliDisplayName(cliInfo)}
                  running={running}
                  lastLog={lastLog}
                  onInit={handleInit}
                  onPlan={handlePlan}
                  onApply={handleApply}
                  onDestroy={handleDestroy}
                  governanceToolkit={governanceToolkit}
                  governanceReport={governanceReport}
                  governanceRunning={governanceRunning}
                  onRunGovernanceChecks={handleRunGovernanceChecks}
                  onDetectGovernanceTools={handleDetectGovernanceTools}
                  onOpenDriftTab={() => setDetailTab('drift')}
              />
              )}
              {detailTab === 'state' && (
                <StateTab
                  project={detail}
                  running={running}
                  lastLog={lastLog}
                  draft={stateDraft}
                  onImport={handleStateImport}
                  onMove={handleStateMove}
                  onRemove={handleStateRemove}
                  onUnlock={handleForceUnlock}
                  onReload={() => void handleReload()}
                />
              )}
              {detailTab === 'resources' && <ResourcesTab project={detail} />}
              {detailTab === 'drift' && (
                <DriftTab
                  report={driftReport}
                  loading={driftLoading}
                  error={driftError}
                  cliLabel={cliDisplayName(cliInfo)}
                  statusFilter={driftStatusFilter}
                  typeFilter={driftTypeFilter}
                  selectedKey={selectedDriftKey}
                  onStatusFilterChange={setDriftStatusFilter}
                  onTypeFilterChange={setDriftTypeFilter}
                  onSelectItem={setSelectedDriftKey}
                  onRefresh={() => void loadDrift({ forceRefresh: true })}
                  onPrepareImport={handlePrepareDriftImport}
                  onPrepareMove={handlePrepareDriftMove}
                  onPrepareRemove={handlePrepareDriftRemove}
                  onOpenConsole={handleOpenDriftConsole}
                  onRunStateShow={handleRunDriftStateShow}
                  onNavigateService={onNavigateService}
                />
              )}
              {detailTab === 'lab' && (
                <ObservabilityResilienceLab
                  report={labReport}
                  loading={labLoading}
                  error={labError}
                  onRefresh={() => void loadLab()}
                  onRunArtifact={handleLabArtifactRun}
                  onNavigateSignal={handleLabSignalNavigate}
                />
              )}
              {detailTab === 'history' && (
                <HistoryTab
                  projectId={detail.id}
                  initialFilters={persistedHistoryFilters}
                  onFiltersChange={(filters) => setUiState((current) => {
                    const existing = current.historyFiltersByProject[detail.id]
                    if (
                      existing?.commandFilter === filters.commandFilter
                      && existing?.successFilter === filters.successFilter
                      && existing?.projectFilter === filters.projectFilter
                    ) {
                      return current
                    }
                    return {
                      ...current,
                      historyFiltersByProject: {
                        ...current.historyFiltersByProject,
                        [detail.id]: filters
                      }
                    }
                  })}
                  onOpenProject={(projectId) => setSelectedId(projectId)}
                  onOpenTab={setDetailTab}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Inputs Dialog */}
      {showInputs && detail && (
        <InputsDialog
          project={detail}
          onSave={handleSaveInputs}
          onClose={() => { setShowInputs(false); setPrefillMissing([]) }}
          prefillMissing={prefillMissing.length > 0 ? prefillMissing : undefined}
        />
      )}

      {showRenameDialog && detail && (
        <RenameProjectDialog
          currentName={detail.name}
          onSave={(name) => void handleRenameProject(name)}
          onClose={() => setShowRenameDialog(false)}
        />
      )}

      {showCreateWorkspaceDialog && detail && (
        <WorkspaceCreateDialog
          currentWorkspace={detail.currentWorkspace}
          onCreate={(workspaceName) => void handleCreateWorkspace(workspaceName)}
          onClose={() => setShowCreateWorkspaceDialog(false)}
        />
      )}

      {showDeleteWorkspaceDialog && detail && (
        <WorkspaceDeleteDialog
          workspaces={detail.workspaces}
          onDelete={(workspaceName) => void handleDeleteWorkspace(workspaceName)}
          onClose={() => setShowDeleteWorkspaceDialog(false)}
        />
      )}

      {/* Summary Confirm Dialog */}
      {summaryDialog && (
        <SummaryConfirmDialog
          title={summaryDialog.title}
          summary={summaryDialog.summary}
          changes={summaryDialog.changes}
          onConfirm={summaryDialog.onConfirm}
          onCancel={() => setSummaryDialog(null)}
        />
      )}

      {/* Typed Confirm Dialog */}
      {confirmDialog && (
        <TypedConfirmDialog
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmWord={confirmDialog.confirmWord}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {/* Progress Overlay */}
      {showProgress && (
        <div className="tf-progress-overlay">
          <h4><span className="tf-progress-spinner" /> Running Terraform...</h4>
          <div className="tf-progress-line">{progressLine}</div>
          {progressItems.size > 0 && (
            <div className="tf-progress-items">
              {[...progressItems.entries()].map(([addr, info]) => (
                <div key={addr} className={`tf-progress-item ${info.done ? 'done' : 'active'}`}>
                  <span className="tf-progress-item-status" style={{ color: /error/i.test(info.status) ? '#e74c3c' : info.done ? '#2ecc71' : '#f39c12' }}>
                    {info.done ? (/error/i.test(info.status) ? '✗' : '✓') : '⟳'}
                  </span>
                  <span className="tf-progress-item-addr">{addr}</span>
                  <span className="tf-progress-item-label">{info.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
