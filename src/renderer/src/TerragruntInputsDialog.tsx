import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AwsConnection,
  TerraformProject,
  TerragruntInputEntry,
  TerragruntProjectInfo,
  TerragruntUnit
} from '@shared/types'
import { openProjectInVsCode } from './terraformApi'
import { resolveTerragruntStack, type ResolvedStackResult } from './terragruntApi'

type TerragruntInputsDialogProps = {
  project: TerraformProject
  connection?: AwsConnection
  onClose: () => void
}

const ROOT_MARKER = '__terragrunt-root__'

function extractUnits(info: TerragruntProjectInfo | null | undefined): TerragruntUnit[] {
  if (!info) return []
  if (info.kind === 'terragrunt-unit') return [info.unit]
  const out: TerragruntUnit[] = []
  if (info.stack.rootConfig) out.push(info.stack.rootConfig)
  out.push(...info.stack.units)
  return out
}

function isRootConfig(unit: TerragruntUnit | null): boolean {
  if (!unit) return false
  return (unit.relativePath || '.').replace(/\\/g, '/') === '.'
}

function unitDisplayName(unit: TerragruntUnit): string {
  const segments = (unit.relativePath || '.').split(/[\\/]+/).filter((s) => s && s !== '.')
  if (segments.length === 0) return '.'
  if (segments.length === 1) return segments[0]
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`
}

function unitRelativePath(unit: TerragruntUnit): string {
  return (unit.relativePath || '.').replace(/\\/g, '/')
}

function describeInputSource(unit: TerragruntUnit, _entry: TerragruntInputEntry): { label: string; note: string } {
  if (isRootConfig(unit)) {
    return { label: 'Stack root (shared)', note: 'Declared in the stack root terragrunt.hcl — inherited by every child unit.' }
  }
  // Without deeper trace info from render-json we can't pinpoint whether a value came from a
  // local, an include, or a dependency output — but we can give an honest description.
  if (unit.includes.length === 0 && unit.dependencies.length === 0) {
    return { label: 'Unit inputs block', note: 'Declared directly in this terragrunt.hcl' }
  }
  if (unit.includes.length > 0 && unit.dependencies.length > 0) {
    return { label: 'Resolved', note: `Merged from ${unit.includes.length} include${unit.includes.length === 1 ? '' : 's'} + dependency outputs` }
  }
  if (unit.includes.length > 0) {
    return { label: 'Resolved via include', note: unit.includes.map((i) => i.name).join(', ') }
  }
  return { label: 'Resolved', note: `Includes dependency outputs (${unit.dependencies.length})` }
}

export function TerragruntInputsDialog({ project, onClose }: TerragruntInputsDialogProps): JSX.Element {
  const seedUnits = extractUnits(project.terragrunt)
  const [units, setUnits] = useState<TerragruntUnit[]>(seedUnits)
  const [selectedUnitPath, setSelectedUnitPath] = useState<string>(seedUnits[0]?.unitPath ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lastResolved, setLastResolved] = useState<ResolvedStackResult | null>(null)
  const [showSensitive, setShowSensitive] = useState(false)

  const selectedUnit = useMemo(
    () => units.find((u) => u.unitPath === selectedUnitPath) ?? units[0] ?? null,
    [units, selectedUnitPath]
  )

  const inputs: TerragruntInputEntry[] = selectedUnit?.inputs ?? []
  const needsResolve = !selectedUnit || (inputs.length === 0 && !selectedUnit.resolveError)

  const reload = useCallback(async () => {
    if (!project.rootPath) return
    setBusy(true)
    setError('')
    try {
      const result = await resolveTerragruntStack(project.rootPath)
      setLastResolved(result)
      const combined: TerragruntUnit[] = []
      if (result.stack.rootConfig) combined.push(result.stack.rootConfig)
      combined.push(...result.stack.units)
      setUnits(combined)
      if (!combined.some((u) => u.unitPath === selectedUnitPath)) {
        setSelectedUnitPath(combined[0]?.unitPath ?? '')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [project.rootPath, selectedUnitPath])

  useEffect(() => {
    if (needsResolve && !busy && !lastResolved) {
      void reload()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openInVsCode = useCallback(() => {
    if (!selectedUnit) return
    void openProjectInVsCode(selectedUnit.unitPath)
  }, [selectedUnit])

  const sortedInputs = useMemo(() => {
    return [...inputs].sort((a, b) => a.name.localeCompare(b.name))
  }, [inputs])

  const hasSensitive = sortedInputs.some((i) => i.isSensitive)

  return (
    <div className="tf-inputs-overlay" onClick={onClose}>
      <div className="tf-inputs-dialog tf-inputs-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <h3>Inputs for {project.name}</h3>
        <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>
          Terragrunt inputs are declared in each unit's <code>terragrunt.hcl</code> inside an <code>inputs = {'{ … }'}</code> block and
          resolved by <code>terragrunt render-json</code> together with <code>include</code>, <code>locals</code>, and <code>dependency</code> outputs.
        </p>
        <p className="tf-inputs-warning">
          This view is read-only — InfraLens does not rewrite HCL. Use "Open terragrunt.hcl" to edit the unit's inputs in your editor.
        </p>

        <div className="tf-inputs-toolbar">
          <label>
            Unit
            <div className="tf-inline-field">
              <select
                value={selectedUnitPath}
                onChange={(e) => setSelectedUnitPath(e.target.value)}
                disabled={busy || units.length <= 1}
              >
                {units.map((u) => {
                  const rootish = isRootConfig(u)
                  return (
                    <option key={u.unitPath} value={u.unitPath}>
                      {rootish
                        ? 'Root (shared) — stack-wide inputs and locals'
                        : `${unitDisplayName(u)} — ${unitRelativePath(u)}`}
                    </option>
                  )
                })}
                {units.length === 0 && <option value={ROOT_MARKER}>(no units)</option>}
              </select>
              <button type="button" className="tf-toolbar-btn" onClick={() => void reload()} disabled={busy}>
                {busy ? 'Resolving…' : 'Re-resolve'}
              </button>
            </div>
          </label>
          <label>
            Relative path
            <input readOnly value={selectedUnit ? unitRelativePath(selectedUnit) : ''} />
          </label>
          <label>
            Terraform source
            <input readOnly value={selectedUnit?.terraformSource ?? ''} placeholder="(not set)" />
          </label>
        </div>

        <div className="tf-inputs-layout">
          <label>
            Config file
            <div className="tf-inline-field">
              <input readOnly value={selectedUnit?.configFile ?? ''} />
              <button type="button" className="tf-toolbar-btn" onClick={openInVsCode} disabled={!selectedUnit}>
                Open in VS Code
              </button>
            </div>
          </label>
          <label>
            Resolved at
            <div className="tf-inline-field">
              <input
                readOnly
                value={selectedUnit?.resolvedAt ? new Date(selectedUnit.resolvedAt).toLocaleString() : 'Not resolved yet'}
                placeholder="Not resolved yet"
              />
              {hasSensitive && (
                <button type="button" className="tf-toolbar-btn" onClick={() => setShowSensitive((v) => !v)}>
                  {showSensitive ? 'Hide sensitive' : 'Reveal sensitive'}
                </button>
              )}
            </div>
          </label>
        </div>

        {error && (
          <p className="tf-inputs-warning" style={{ color: '#e74c3c' }}>
            Failed to resolve inputs via <code>terragrunt render-json</code>: {error}
          </p>
        )}

        {selectedUnit?.resolveError && !error && (
          <p className="tf-inputs-warning">
            Render-json reported an error for this unit — only statically-declared values are shown.
          </p>
        )}

        {sortedInputs.length === 0 && !busy && (
          <p className="tf-inputs-warning">
            No inputs resolved. The unit either has no <code>inputs = {'{ … }'}</code> block, or render-json has not run successfully. Click "Re-resolve" to try again.
          </p>
        )}

        {sortedInputs.length > 0 && (
          <div className="tf-input-grid tf-input-grid-terragrunt">
            <div className="tf-input-grid-head">Variable</div>
            <div className="tf-input-grid-head">Value</div>
            <div className="tf-input-grid-head">Type</div>
            <div className="tf-input-grid-head">Source</div>
            {sortedInputs.map((entry) => {
              const source = selectedUnit ? describeInputSource(selectedUnit, entry) : { label: 'Resolved', note: '' }
              const displayValue = entry.isSensitive && !showSensitive ? '•••••' : entry.valueSummary
              return (
                <Fragment key={entry.name}>
                  <div className="tf-input-name-cell">
                    <strong>{entry.name}</strong>
                    <span className={`tf-input-badge ${entry.isSensitive ? 'required' : 'optional'}`}>
                      {entry.isSensitive ? 'Sensitive' : 'Input'}
                    </span>
                    <span className="tf-input-description">
                      {entry.isSensitive
                        ? 'Masked by default — click "Reveal sensitive" to view.'
                        : 'Declared in the unit\'s terragrunt.hcl inputs block.'}
                    </span>
                  </div>
                  <div className="tf-input-effective-cell">
                    <div className="tf-input-effective-value">{displayValue || '-'}</div>
                  </div>
                  <div className="tf-input-effective-cell">
                    <div className="tf-input-effective-source">{entry.valueType}</div>
                  </div>
                  <div className="tf-input-effective-cell">
                    <div className="tf-input-effective-source">{source.label}</div>
                    {source.note && <div className="tf-input-effective-note">{source.note}</div>}
                  </div>
                </Fragment>
              )
            })}
          </div>
        )}

        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={openInVsCode} disabled={!selectedUnit}>
            Open terragrunt.hcl in VS Code
          </button>
          <button type="button" className="tf-toolbar-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
