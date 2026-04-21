import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AwsConnection,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformProject,
  TerraformRunRecord,
  TerragruntProjectInfo,
  TerragruntRunAllCommand,
  TerragruntRunAllEvent,
  TerragruntRunAllSummary,
  TerragruntUnit
} from '@shared/types'
import { listRunHistory } from './terraformApi'
import {
  cancelTerragruntRunAll,
  getTerragruntUnitDrift,
  getTerragruntUnitInventory,
  resolveTerragruntStack,
  startTerragruntRunAll,
  subscribeTerragruntRunAll,
  unsubscribeTerragruntRunAll,
  type ResolvedStackResult,
  type TerragruntUnitInventoryResult
} from './terragruntApi'

type UnitStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled'

type UnitPlanSummary = {
  create: number
  change: number
  destroy: number
  noop: boolean
}

type PlanAction = 'create' | 'update' | 'replace' | 'destroy' | 'read' | 'unknown'

type PlanResourceChange = {
  action: PlanAction
  address: string
}

function parsePlanResourceChanges(log: string): PlanResourceChange[] {
  if (!log) return []
  const seen = new Map<string, PlanAction>()
  const pattern = /#\s+([^\s#\n][^\n]*?)\s+will be\s+(created|updated in-place|replaced|destroyed|read during apply)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(log)) !== null) {
    const address = match[1].trim()
    const verb = match[2].toLowerCase()
    let action: PlanAction = 'unknown'
    if (verb.startsWith('created')) action = 'create'
    else if (verb.startsWith('updated')) action = 'update'
    else if (verb.startsWith('replaced')) action = 'replace'
    else if (verb.startsWith('destroyed')) action = 'destroy'
    else if (verb.startsWith('read')) action = 'read'
    // Replace trumps lesser actions; otherwise keep the first seen.
    const prev = seen.get(address)
    if (!prev || action === 'replace') seen.set(address, action)
  }
  return [...seen.entries()]
    .map(([address, action]) => ({ address, action }))
    .sort((a, b) => {
      const order: Record<PlanAction, number> = { destroy: 0, replace: 1, update: 2, create: 3, read: 4, unknown: 5 }
      if (order[a.action] !== order[b.action]) return order[a.action] - order[b.action]
      return a.address.localeCompare(b.address)
    })
}

function parsePlanSummary(log: string): UnitPlanSummary | null {
  if (!log) return null
  // Terraform emits "No changes. Your infrastructure matches the configuration." or
  // "No changes. Your configuration is up-to-date." for plan/apply with no actions.
  if (/no changes\./i.test(log) && /(matches the configuration|infrastructure matches|configuration is up-to-date)/i.test(log)) {
    return { create: 0, change: 0, destroy: 0, noop: true }
  }
  const plan = log.match(/Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy/i)
  if (plan) return { create: +plan[1], change: +plan[2], destroy: +plan[3], noop: false }
  const apply = log.match(/Apply complete!\s*Resources:\s*(\d+)\s+added,\s*(\d+)\s+changed,\s*(\d+)\s+destroyed/i)
  if (apply) return { create: +apply[1], change: +apply[2], destroy: +apply[3], noop: false }
  const destroy = log.match(/Destroy complete!\s*Resources:\s*(\d+)\s+destroyed/i)
  if (destroy) return { create: 0, change: 0, destroy: +destroy[1], noop: false }
  return null
}

type StackTab = 'actions' | 'state' | 'drift' | 'history'

/**
 * Module-level cache keyed by project id so re-mounting the pane (e.g. after switching screens
 * and coming back) doesn't trigger a fresh `terragrunt render-json` sweep across every unit.
 * The cache is write-through: every successful resolve updates it, "Re-resolve stack" forces
 * a fresh call, and the cache survives for the lifetime of the renderer process.
 */
type ResolvedStackCacheEntry = {
  result: ResolvedStackResult
  cachedAt: number
  rootPath: string
}

const resolvedStackCache = new Map<string, ResolvedStackCacheEntry>()

type TerragruntStackPaneProps = {
  project: TerraformProject
  profileName: string
  connection?: AwsConnection
}

function isStackInfo(info: TerragruntProjectInfo | null | undefined): info is Extract<TerragruntProjectInfo, { kind: 'terragrunt-stack' }> {
  return info?.kind === 'terragrunt-stack'
}

export function TerragruntStackPane({ project, profileName, connection }: TerragruntStackPaneProps): JSX.Element {
  const stackInfo = isStackInfo(project.terragrunt) ? project.terragrunt.stack : null
  const initialCached = resolvedStackCache.get(project.id)
  const initialStack = initialCached && initialCached.rootPath === project.rootPath ? initialCached.result : null
  const [resolvedStack, setResolvedStack] = useState<ResolvedStackResult | null>(initialStack)
  const [resolveBusy, setResolveBusy] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [runCommand, setRunCommand] = useState<TerragruntRunAllCommand | null>(null)
  const [unitStatuses, setUnitStatuses] = useState<Record<string, UnitStatus>>({})
  const [summary, setSummary] = useState<TerragruntRunAllSummary | null>(null)
  const [confirmCommand, setConfirmCommand] = useState<TerragruntRunAllCommand | null>(null)
  const [runError, setRunError] = useState('')
  const [starting, setStarting] = useState(false)
  const activeRunIdRef = useRef<string | null>(null)
  const activeCommandRef = useRef<TerragruntRunAllCommand | null>(null)
  const [activeTab, setActiveTab] = useState<StackTab>('actions')
  const [planReady, setPlanReady] = useState(false)
  const [unitLogs, setUnitLogs] = useState<Record<string, string>>({})
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [monitorUnit, setMonitorUnit] = useState<string | null>(null)
  const [outputOpen, setOutputOpen] = useState(false)
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>('all')
  const [diagramEnvironment, setDiagramEnvironment] = useState<string>('all')
  const [unitPlanSummaries, setUnitPlanSummaries] = useState<Record<string, UnitPlanSummary | null>>({})
  const [unitPlanChanges, setUnitPlanChanges] = useState<Record<string, PlanResourceChange[]>>({})
  const [planDetailUnit, setPlanDetailUnit] = useState<string | null>(null)

  const effectiveStack = resolvedStack?.stack ?? stackInfo
  const phases = effectiveStack?.dependencyOrder ?? []
  const units = effectiveStack?.units ?? []
  const cycles = effectiveStack?.cycles ?? []

  const unitByPath = useMemo(() => {
    const map = new Map<string, TerragruntUnit>()
    for (const unit of units) map.set(unit.unitPath, unit)
    return map
  }, [units])

  const resolve = useCallback(async () => {
    if (!project.rootPath) return
    setResolveBusy(true)
    setResolveError('')
    try {
      const result = await resolveTerragruntStack(project.rootPath)
      setResolvedStack(result)
      resolvedStackCache.set(project.id, {
        result,
        cachedAt: Date.now(),
        rootPath: project.rootPath
      })
      // Re-resolving the stack invalidates any in-memory saved-plan readiness because
      // unit topology may have changed.
      setPlanReady(false)
    } catch (err) {
      setResolveError((err as Error).message)
    } finally {
      setResolveBusy(false)
    }
  }, [project.rootPath, project.id])

  useEffect(() => {
    const listener = (event: TerragruntRunAllEvent): void => {
      if (event.type === 'stack-started') {
        if (event.stackRoot !== stackInfo?.stackRoot && event.stackRoot !== resolvedStack?.stack.stackRoot) {
          return
        }
        activeRunIdRef.current = event.runId
        activeCommandRef.current = event.command
        setRunId(event.runId)
        setRunCommand(event.command)
        setSummary(null)
        setUnitStatuses({})
        setUnitLogs({})
        setUnitPlanSummaries({})
        setUnitPlanChanges({})
        setMonitorOpen(true)
        setMonitorUnit(null)
        return
      }
      if (event.runId !== activeRunIdRef.current) return
      switch (event.type) {
        case 'unit-started':
          setUnitStatuses((prev) => ({ ...prev, [event.unitPath]: 'running' }))
          setMonitorUnit((prev) => prev ?? event.unitPath)
          break
        case 'unit-output':
          setUnitLogs((prev) => {
            const existing = prev[event.unitPath] ?? ''
            const next = existing + event.chunk
            // Cap each unit's buffer so a chatty unit doesn't balloon renderer memory.
            return { ...prev, [event.unitPath]: next.length > 500_000 ? next.slice(-500_000) : next }
          })
          break
        case 'unit-completed':
          setUnitStatuses((prev) => ({ ...prev, [event.unitPath]: event.success ? 'succeeded' : 'failed' }))
          if (!event.success) setMonitorUnit(event.unitPath)
          setUnitLogs((logs) => {
            const accumulated = logs[event.unitPath] ?? ''
            const summary = parsePlanSummary(accumulated)
            if (summary) {
              setUnitPlanSummaries((prev) => ({ ...prev, [event.unitPath]: summary }))
            }
            const changes = parsePlanResourceChanges(accumulated)
            if (changes.length > 0) {
              setUnitPlanChanges((prev) => ({ ...prev, [event.unitPath]: changes }))
            }
            return logs
          })
          break
        case 'unit-blocked':
          setUnitStatuses((prev) => ({ ...prev, [event.unitPath]: 'blocked' }))
          break
        case 'unit-cancelled':
          setUnitStatuses((prev) => ({ ...prev, [event.unitPath]: 'cancelled' }))
          break
        case 'stack-completed': {
          const finishedCommand = activeCommandRef.current
          setSummary(event.summary)
          setRunId(null)
          setRunCommand(null)
          activeRunIdRef.current = null
          activeCommandRef.current = null
          if (finishedCommand === 'plan') {
            setPlanReady(event.summary.succeeded.length > 0)
          } else if (finishedCommand === 'apply' || finishedCommand === 'destroy') {
            // Apply / destroy consume or invalidate the saved plans.
            setPlanReady(false)
          }
          break
        }
        default:
          break
      }
    }
    subscribeTerragruntRunAll(listener)
    return () => unsubscribeTerragruntRunAll(listener)
  }, [resolvedStack?.stack.stackRoot, stackInfo?.stackRoot])

  useEffect(() => {
    activeRunIdRef.current = null
    activeCommandRef.current = null
    const cached = resolvedStackCache.get(project.id)
    setResolvedStack(cached && cached.rootPath === project.rootPath ? cached.result : null)
    setResolveError('')
    setRunId(null)
    setRunCommand(null)
    setUnitStatuses({})
    setSummary(null)
    setRunError('')
    setStarting(false)
    setPlanReady(false)
    setUnitLogs({})
    setMonitorOpen(false)
    setMonitorUnit(null)
    setOutputOpen(false)
    setSelectedEnvironment('all')
    setDiagramEnvironment('all')
    setUnitPlanSummaries({})
    setUnitPlanChanges({})
    setPlanDetailUnit(null)
  }, [project.id, project.rootPath])

  useEffect(() => {
    if (!resolvedStack && !resolveBusy) {
      resolve()
    }
  }, [project.id, resolve, resolveBusy, resolvedStack])

  const environments = useMemo(() => deriveEnvironments(units), [units])

  const filteredUnitPaths = useMemo(() => {
    if (selectedEnvironment === 'all' || environments.depth < 0) return null
    return units
      .filter((u) => unitSegmentAt(u, environments.depth) === selectedEnvironment)
      .map((u) => u.unitPath)
  }, [units, environments.depth, selectedEnvironment])

  const scopedUnitCount = filteredUnitPaths ? filteredUnitPaths.length : units.length

  const diagramUnits = useMemo(() => {
    if (diagramEnvironment === 'all' || environments.depth < 0) return units
    return units.filter((u) => unitSegmentAt(u, environments.depth) === diagramEnvironment)
  }, [units, environments.depth, diagramEnvironment])

  const diagramPhases = useMemo(() => {
    if (diagramEnvironment === 'all' || environments.depth < 0) return phases
    const allowed = new Set(diagramUnits.map((u) => u.unitPath))
    return phases
      .map((phase) => phase.filter((p) => allowed.has(p)))
      .filter((phase) => phase.length > 0)
  }, [phases, diagramEnvironment, environments.depth, diagramUnits])

  const handleStart = useCallback(async (command: TerragruntRunAllCommand) => {
    if (starting || runId) return
    setStarting(true)
    setRunError('')
    setSummary(null)
    try {
      const result = await startTerragruntRunAll(
        profileName,
        project.id,
        command,
        connection,
        filteredUnitPaths ?? undefined
      )
      activeRunIdRef.current = result.runId
      setRunId(result.runId)
      setRunCommand(command)
    } catch (err) {
      setRunError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }, [connection, profileName, project.id, runId, starting, filteredUnitPaths])

  const handleCancel = useCallback(async () => {
    if (!runId) return
    try {
      await cancelTerragruntRunAll(runId)
    } catch (err) {
      setRunError((err as Error).message)
    }
  }, [runId])

  const handleConfirm = useCallback(async () => {
    const command = confirmCommand
    setConfirmCommand(null)
    if (command) await handleStart(command)
  }, [confirmCommand, handleStart])

  const running = Boolean(runId) || starting
  const unitCount = units.length
  const phaseCount = phases.length
  const resolveErrorCount = resolvedStack?.resolveErrors.length ?? 0
  const failedCount = summary?.failed.length ?? 0

  return (
    <div className="tg-stack-pane">
      <div className="tf-detail-tabs">
        <button
          type="button"
          className={activeTab === 'actions' ? 'active' : ''}
          onClick={() => setActiveTab('actions')}
        >
          Actions
        </button>
        <button
          type="button"
          className={activeTab === 'state' ? 'active' : ''}
          onClick={() => setActiveTab('state')}
        >
          State
        </button>
        <button
          type="button"
          className={activeTab === 'drift' ? 'active' : ''}
          onClick={() => setActiveTab('drift')}
        >
          Drift
        </button>
        <button
          type="button"
          className={activeTab === 'history' ? 'active' : ''}
          onClick={() => setActiveTab('history')}
        >
          History
        </button>
      </div>

      {activeTab === 'state' && (
        <StackStateTab
          project={project}
          profileName={profileName}
          connection={connection}
          units={units}
        />
      )}

      {activeTab === 'drift' && (
        <StackDriftTab
          project={project}
          profileName={profileName}
          connection={connection}
          units={units}
        />
      )}

      {activeTab === 'history' && (
        <StackHistoryTab projectId={project.id} unitByPath={unitByPath} />
      )}

      {activeTab === 'actions' && (
      <>
      <div className="tf-section">
        <div className="tf-section-head">
          <div>
            <h3>Actions</h3>
            <div className="tf-section-hint">Default path: re-resolve the stack, run plan across every unit, review the summary, then apply.</div>
          </div>
        </div>
        {environments.options.length > 0 && (
          <div className="tf-inputs-toolbar">
            <label>
              Scope
              <select
                value={selectedEnvironment}
                onChange={(e) => setSelectedEnvironment(e.target.value)}
                disabled={running}
              >
                <option value="all">All environments ({units.length})</option>
                {environments.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.value} ({opt.count})
                  </option>
                ))}
              </select>
            </label>
            <div className="tf-section-hint" style={{ alignSelf: 'end', paddingBottom: 6 }}>
              {selectedEnvironment === 'all'
                ? 'Plan / apply / destroy will run across every unit in the stack.'
                : `Scoped to ${scopedUnitCount} unit${scopedUnitCount === 1 ? '' : 's'} under "${selectedEnvironment}". Units in other environments are skipped.`}
            </div>
          </div>
        )}
        <div className={`tf-readiness-banner ${failedCount > 0 ? 'danger' : planReady ? 'ok' : 'info'}`}>
          <div className="tf-readiness-copy">
            <span className="tf-plan-summary-label">Safe To Apply?</span>
            <strong>
              {failedCount > 0
                ? 'Review failed units before applying'
                : planReady
                  ? 'Saved plans are ready across the stack'
                  : 'Run plan before apply or destroy'}
            </strong>
            <span>
              {planReady
                ? 'Apply and destroy consume the saved plans produced by the most recent run-all plan.'
                : 'Apply and destroy stay disabled until a run-all plan completes successfully.'}
              {resolveErrorCount > 0 && ` ${resolveErrorCount} unit${resolveErrorCount === 1 ? '' : 's'} failed to resolve — static edges only.`}
            </span>
          </div>
          <div className="tf-readiness-metrics">
            <div><strong>{planReady ? 'Yes' : 'No'}</strong><span>saved plan</span></div>
            <div><strong>{failedCount}</strong><span>failed last run</span></div>
            <div>
              <strong>{scopedUnitCount}</strong>
              <span>{selectedEnvironment === 'all' ? 'units orchestrated' : `units in "${selectedEnvironment}"`}</span>
            </div>
          </div>
        </div>
        <div className="tf-primary-action-area">
          <div className="tf-primary-action-stack">
            <button
              className="tf-action-btn init"
              onClick={resolve}
              disabled={resolveBusy || running}
              title="Re-scan the stack and rebuild the dependency graph"
            >
              {resolveBusy ? 'Resolving…' : 'Re-resolve stack'}
            </button>
            <button
              className="tf-action-btn plan primary"
              onClick={() => handleStart('plan')}
              disabled={running}
            >
              Run all plan
            </button>
          </div>
          <div className="tf-primary-action-stack tf-primary-action-stack-commit">
            <button
              className="tf-action-btn apply primary"
              onClick={() => setConfirmCommand('apply')}
              disabled={running || !planReady}
              title={!planReady ? 'Run all plan first to enable Apply.' : undefined}
            >
              Run all apply
            </button>
            <button
              className="tf-action-btn destroy"
              onClick={() => setConfirmCommand('destroy')}
              disabled={running || !planReady}
              title={!planReady ? 'Run all plan first to enable Destroy.' : undefined}
            >
              Run all destroy
            </button>
          </div>
        </div>
        <div className="tf-plan-controls-toggle-row">
          {running
            ? (
              <>
                <span className="tf-section-hint">Running: {runCommand ?? 'run-all'} ({unitCount} unit{unitCount === 1 ? '' : 's'}).</span>
                <button type="button" className="tf-toolbar-btn" onClick={() => setMonitorOpen(true)}>View run output</button>
                <button type="button" className="tf-toolbar-btn" onClick={handleCancel}>Cancel run-all</button>
              </>
            )
            : !planReady
              ? <div className="tf-section-hint">Run all plan first. Apply and Destroy stay disabled until a saved plan exists.</div>
              : <div className="tf-section-hint">Saved plans are ready. Run-all orchestrates every unit in dependency order — failed units block downstream phases.</div>}
          {!running && Object.keys(unitLogs).length > 0 && (
            <button type="button" className="tf-toolbar-btn" onClick={() => setMonitorOpen(true)}>Open run output</button>
          )}
          {resolveError && <div className="tf-section-hint" style={{ color: '#e74c3c' }} title={resolveError}>Resolve error: {resolveError.slice(0, 200)}</div>}
          {runError && <div className="tf-section-hint" style={{ color: '#e74c3c' }}>{runError}</div>}
        </div>
      </div>

      {cycles.length > 0 && (
        <div className="tf-section tf-plan-section-danger">
          <div className="tf-section-head">
            <div>
              <h3>Dependency cycles detected</h3>
              <div className="tf-section-hint">Cannot run-all while cycles exist. Resolve cycles then re-resolve the stack.</div>
            </div>
          </div>
          {cycles.map((cycle, i) => (
            <div key={i} className="tg-stack-cycle">{cycle.join(' → ')}</div>
          ))}
        </div>
      )}

      {summary && (
        <PartialFailureSummary
          summary={summary}
          onSelectUnit={(unitPath) => {
            setMonitorUnit(unitPath)
            setMonitorOpen(true)
          }}
        />
      )}

      {units.length > 0 && (
        <div className="tf-section">
          <div className="tf-section-head">
            <div>
              <h3>Dependency diagram</h3>
              <div className="tf-section-hint">
                {diagramEnvironment === 'all'
                  ? `Units grouped by phase with dependency edges. Showing all ${units.length} units.`
                  : `Filtered to "${diagramEnvironment}" — ${diagramUnits.length} of ${units.length} units shown. Dependencies crossing into other environments are hidden.`}
              </div>
            </div>
            {environments.options.length > 0 && (
              <label className="tg-diagram-filter">
                <span>View</span>
                <select
                  value={diagramEnvironment}
                  onChange={(e) => setDiagramEnvironment(e.target.value)}
                >
                  <option value="all">All environments ({units.length})</option>
                  {environments.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.value} ({opt.count})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {diagramUnits.length === 0
            ? <div className="tf-section-hint">No units match the selected filter.</div>
            : <TerragruntTopologyDiagram
                units={diagramUnits}
                phases={diagramPhases}
                unitStatuses={unitStatuses}
                unitPlanSummaries={unitPlanSummaries}
                onSelectUnit={(unitPath) => {
                  // Only open the detail panel for units that actually have planned work to show.
                  if (unitPlanChanges[unitPath]?.length || unitPlanSummaries[unitPath]) {
                    setPlanDetailUnit(unitPath)
                  } else if (unitLogs[unitPath]) {
                    setMonitorUnit(unitPath)
                    setMonitorOpen(true)
                  }
                }}
              />}
        </div>
      )}

      <section className="tf-section tg-stack-topology">
        <div className="tf-section-head">
          <div>
            <h3>Topology</h3>
            <div className="tf-section-hint">Ordered unit list — dependencies in earlier phases run first.</div>
          </div>
        </div>
        {phases.length === 0 && <p className="tg-muted">No runnable phases. Try re-resolving the stack.</p>}
        {phases.map((phase, phaseIdx) => (
          <div key={phaseIdx} className="tg-phase">
            <div className="tg-phase-header">
              <span className="tg-phase-index">Phase {phaseIdx}</span>
              <span className="tg-muted">{phase.length} unit{phase.length === 1 ? '' : 's'}</span>
            </div>
            <div className="tg-phase-units">
              {phase.map((unitPath) => {
                const unit = unitByPath.get(unitPath)
                const status = unitStatuses[unitPath] ?? 'idle'
                return (
                  <div key={unitPath} className={`tg-unit-card status-${status}`}>
                    <div className="tg-unit-header">
                      <strong title={unit ? unitRelativePath(unit) : unitPath}>{unit ? unitDisplayName(unit) : unitPath}</strong>
                      <span className={`tg-status-badge status-${status}`}>{statusLabel(status)}</span>
                    </div>
                    <div className="tg-unit-meta">
                      {unit && <span className="tg-unit-relpath" title={unit.unitPath}>{unitRelativePath(unit)}</span>}
                      {unit?.terraformSource && <span>source: {unit.terraformSource}</span>}
                    </div>
                    {unit && unit.dependencies.length > 0 && (
                      <div className="tg-unit-deps">
                        <span className="tg-muted">depends on</span>
                        {unit.dependencies.map((dep) => (
                          <span key={dep.name} className="tg-dep-chip">{dep.name}</span>
                        ))}
                      </div>
                    )}
                    {unit && unit.resolveError && (
                      <div className="tg-unit-error" title={unit.resolveError}>
                        Resolve error — this unit could not be fully resolved by <code>terragrunt render-json</code>. Static dependency edges are still shown.
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </section>

      <div className="tf-section">
        <button
          className="tf-output-toggle"
          onClick={() => setOutputOpen((value) => !value)}
        >
          {outputOpen ? '▼' : '▶'} Command Output
          {runCommand && (
            <span style={{ fontWeight: 400, color: running ? '#9ca7b7' : '#2ecc71', marginLeft: 8 }}>
              ({runCommand}{running ? ' running' : ''})
            </span>
          )}
        </button>
        {outputOpen && (
          <pre className="tf-output-panel">{buildCombinedLog(units, unitLogs, unitStatuses) || '(no output yet — start a run-all)'}</pre>
        )}
      </div>
      </>
      )}

      {confirmCommand && (
        <RunAllConfirmModal
          command={confirmCommand}
          units={filteredUnitPaths
            ? units.filter((u) => filteredUnitPaths.includes(u.unitPath))
            : units}
          phases={filteredUnitPaths
            ? phases.map((p) => p.filter((path) => filteredUnitPaths.includes(path))).filter((p) => p.length > 0)
            : phases}
          environmentLabel={selectedEnvironment === 'all' ? null : selectedEnvironment}
          onCancel={() => setConfirmCommand(null)}
          onConfirm={handleConfirm}
        />
      )}
      {monitorOpen && (
        <RunMonitorModal
          command={runCommand}
          running={running}
          units={units}
          unitStatuses={unitStatuses}
          unitLogs={unitLogs}
          selectedUnit={monitorUnit}
          onSelect={setMonitorUnit}
          onClose={() => setMonitorOpen(false)}
        />
      )}
      {!monitorOpen && running && (
        <RunMiniIndicator
          command={runCommand}
          units={units}
          unitStatuses={unitStatuses}
          onOpen={() => setMonitorOpen(true)}
          onCancel={handleCancel}
        />
      )}
      {planDetailUnit && (
        <UnitPlanDetailModal
          unit={unitByPath.get(planDetailUnit) ?? null}
          summary={unitPlanSummaries[planDetailUnit] ?? null}
          changes={unitPlanChanges[planDetailUnit] ?? []}
          hasLog={Boolean(unitLogs[planDetailUnit])}
          onClose={() => setPlanDetailUnit(null)}
          onOpenLog={() => {
            setMonitorUnit(planDetailUnit)
            setMonitorOpen(true)
            setPlanDetailUnit(null)
          }}
        />
      )}
    </div>
  )
}

function statusLabel(status: UnitStatus): string {
  switch (status) {
    case 'running': return 'Running'
    case 'succeeded': return 'Succeeded'
    case 'failed': return 'Failed'
    case 'blocked': return 'Blocked'
    case 'cancelled': return 'Cancelled'
    default: return 'Idle'
  }
}

function shortenPath(p: string): string {
  if (p.length < 60) return p
  return `…${p.slice(-60)}`
}

function unitDisplayName(unit: TerragruntUnit): string {
  const rel = unit.relativePath || '.'
  const segments = rel.split(/[\\/]+/).filter((seg) => seg && seg !== '.')
  if (segments.length === 0) return '.'
  if (segments.length === 1) return segments[0]
  const last = segments[segments.length - 1]
  const parent = segments[segments.length - 2]
  return `${parent}/${last}`
}

function unitRelativePath(unit: TerragruntUnit): string {
  const rel = unit.relativePath || '.'
  return rel.replace(/\\/g, '/')
}

const ENV_NAME_PATTERN = /^(dev|development|stage|staging|prod|production|qa|test|preview|sandbox|uat|integration|perf)[-_]?.*$/i

type EnvironmentOption = { value: string; count: number }
type EnvironmentDeriveResult = {
  depth: number
  options: EnvironmentOption[]
}

function deriveEnvironments(units: TerragruntUnit[]): EnvironmentDeriveResult {
  if (units.length === 0) return { depth: -1, options: [] }
  const segmentLists = units.map((u) =>
    (u.relativePath || '.').split(/[\\/]+/).filter((s) => s && s !== '.')
  )
  const maxDepth = Math.max(0, ...segmentLists.map((l) => l.length))
  const buildOptionsAt = (depth: number): EnvironmentOption[] => {
    const counts = new Map<string, number>()
    for (const list of segmentLists) {
      if (depth < list.length) counts.set(list[depth], (counts.get(list[depth]) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value))
  }
  // First pass: prefer a depth whose segments look like env names.
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const options = buildOptionsAt(depth)
    if (options.length < 2) continue
    if (options.some((o) => ENV_NAME_PATTERN.test(o.value))) return { depth, options }
  }
  // Fallback: first depth with any variation.
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const options = buildOptionsAt(depth)
    if (options.length >= 2) return { depth, options }
  }
  return { depth: -1, options: [] }
}

function unitSegmentAt(unit: TerragruntUnit, depth: number): string | null {
  if (depth < 0) return null
  const segments = (unit.relativePath || '.').split(/[\\/]+/).filter((s) => s && s !== '.')
  return depth < segments.length ? segments[depth] : null
}

function PartialFailureSummary(props: {
  summary: TerragruntRunAllSummary
  onSelectUnit: (unitPath: string) => void
}): JSX.Element {
  const { summary, onSelectUnit } = props
  const total = summary.succeeded.length + summary.failed.length + summary.blocked.length + summary.cancelled.length
  return (
    <section className="tf-section">
      <div className="tf-section-head">
        <div>
          <h3>Last run summary</h3>
          <div className="tf-section-hint">{total} unit{total === 1 ? '' : 's'} processed — click a unit to see its output.</div>
        </div>
      </div>
      <div className="tg-summary-grid">
        <SummaryCell label="Succeeded" tone="success" items={summary.succeeded} onSelect={onSelectUnit} />
        <SummaryCell label="Failed" tone="danger" items={summary.failed} onSelect={onSelectUnit} />
        <SummaryCell label="Blocked" tone="warning" items={summary.blocked} onSelect={onSelectUnit} />
        <SummaryCell label="Cancelled" tone="info" items={summary.cancelled} onSelect={onSelectUnit} />
      </div>
    </section>
  )
}

function SummaryCell(props: {
  label: string
  tone: 'success' | 'danger' | 'warning' | 'info'
  items: string[]
  onSelect: (unitPath: string) => void
}): JSX.Element {
  const { label, tone, items, onSelect } = props
  return (
    <div className={`tg-summary-cell tone-${tone}`}>
      <div className="tg-summary-cell-header">
        <span>{label}</span>
        <strong>{items.length}</strong>
      </div>
      {items.length > 0 && (
        <ul>
          {items.slice(0, 6).map((p) => (
            <li key={p}>
              <button type="button" className="tg-summary-item-btn" title={p} onClick={() => onSelect(p)}>
                {shortenPath(p)}
              </button>
            </li>
          ))}
          {items.length > 6 && <li className="tg-muted">+ {items.length - 6} more</li>}
        </ul>
      )}
    </div>
  )
}

function TerragruntTopologyDiagram(props: {
  units: TerragruntUnit[]
  phases: string[][]
  unitStatuses: Record<string, UnitStatus>
  unitPlanSummaries: Record<string, UnitPlanSummary | null>
  onSelectUnit?: (unitPath: string) => void
}): JSX.Element {
  const { units, phases, unitStatuses, unitPlanSummaries, onSelectUnit } = props
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  const NODE_W = 220
  const NODE_H = 74
  const COL_GAP = 110
  const ROW_GAP = 20
  const PAD_X = 32
  const PAD_Y = 40

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button')) return
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

  useEffect(() => {
    const stop = (): void => { dragging.current = false }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const resetView = useCallback(() => {
    setZoom(100)
    setPan({ x: 0, y: 0 })
  }, [])

  const unitByPath = useMemo(() => {
    const map = new Map<string, TerragruntUnit>()
    for (const u of units) map.set(u.unitPath, u)
    return map
  }, [units])

  const { positions, columns, height } = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>()
    const placedColumns: string[][] = []
    const placed = new Set<string>()
    phases.forEach((phase, col) => {
      const filtered = phase.filter((u) => unitByPath.has(u))
      placedColumns.push(filtered)
      filtered.forEach((unitPath, row) => {
        pos.set(unitPath, {
          x: PAD_X + col * (NODE_W + COL_GAP),
          y: PAD_Y + row * (NODE_H + ROW_GAP)
        })
        placed.add(unitPath)
      })
    })
    // Any unit missing from phases (shouldn't happen but be safe) goes in an overflow column.
    const overflow = units.filter((u) => !placed.has(u.unitPath))
    if (overflow.length > 0) {
      const col = placedColumns.length
      placedColumns.push(overflow.map((u) => u.unitPath))
      overflow.forEach((u, row) => {
        pos.set(u.unitPath, {
          x: PAD_X + col * (NODE_W + COL_GAP),
          y: PAD_Y + row * (NODE_H + ROW_GAP)
        })
      })
    }
    const maxRows = placedColumns.reduce((acc, c) => Math.max(acc, c.length), 0)
    const totalHeight = PAD_Y * 2 + Math.max(1, maxRows) * (NODE_H + ROW_GAP) - ROW_GAP
    return { positions: pos, columns: placedColumns, height: totalHeight }
  }, [phases, units, unitByPath])

  const edges = useMemo(() => {
    const list: Array<{ from: string; to: string; kind: 'dep' | 'deps-paths' }> = []
    const unitPaths = new Set(units.map((u) => u.unitPath))
    for (const unit of units) {
      for (const dep of unit.dependencies) {
        if (dep.resolvedPath && unitPaths.has(dep.resolvedPath) && dep.resolvedPath !== unit.unitPath) {
          list.push({ from: dep.resolvedPath, to: unit.unitPath, kind: 'dep' })
        }
      }
      for (const raw of unit.additionalDependencyPaths) {
        if (unitPaths.has(raw) && raw !== unit.unitPath) {
          list.push({ from: raw, to: unit.unitPath, kind: 'deps-paths' })
        }
      }
    }
    return list
  }, [units])

  const width = PAD_X * 2 + columns.length * (NODE_W + COL_GAP) - COL_GAP
  const svgW = Math.max(width, 320)
  const svgH = Math.max(height, 160)
  const scale = zoom / 100

  return (
    <div
      ref={containerRef}
      className={`tf-diagram-container tg-diagram-container ${fullscreen ? 'fullscreen' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
    >
      <div className="tf-diagram-controls">
        <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => setFullscreen((v) => !v)}>
          {fullscreen ? 'Exit' : 'Full'}
        </button>
        <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.max(25, z - 15))}>−</button>
        <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={resetView}>{zoom}%</button>
        <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.min(300, z + 15))}>+</button>
      </div>
      <div className="tf-diagram-legend" onMouseDown={(e) => e.stopPropagation()}>
        <span className="tf-diagram-legend-item">
          <span className="tf-diagram-legend-line" style={{ background: '#9ec7ff' }} />
          dependency
        </span>
        <span className="tf-diagram-legend-item">
          <span className="tf-diagram-legend-line" style={{ background: '#ffd082' }} />
          dependencies.paths
        </span>
      </div>
      <svg
        className="tg-diagram-svg"
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: '0 0',
          width: svgW,
          height: svgH,
          userSelect: 'none'
        }}
      >
        <defs>
          <marker id="tg-arrow-dep" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill="#9ec7ff" />
          </marker>
          <marker id="tg-arrow-paths" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill="#ffd082" />
          </marker>
        </defs>

        {columns.map((_, idx) => (
          <text
            key={idx}
            x={PAD_X + idx * (NODE_W + COL_GAP) + NODE_W / 2}
            y={22}
            className="tg-diagram-col-label"
            textAnchor="middle"
          >
            Phase {idx}
          </text>
        ))}

        {edges.map((edge, i) => {
          const from = positions.get(edge.from)
          const to = positions.get(edge.to)
          if (!from || !to) return null
          const fromX = from.x + NODE_W
          const fromY = from.y + NODE_H / 2
          const toX = to.x
          const toY = to.y + NODE_H / 2
          const controlOffset = Math.max(40, Math.abs(toX - fromX) / 2.5)
          const c1x = fromX + controlOffset
          const c2x = toX - controlOffset
          const d = `M ${fromX} ${fromY} C ${c1x} ${fromY}, ${c2x} ${toY}, ${toX} ${toY}`
          const stroke = edge.kind === 'deps-paths' ? '#ffd082' : '#9ec7ff'
          const marker = edge.kind === 'deps-paths' ? 'url(#tg-arrow-paths)' : 'url(#tg-arrow-dep)'
          return (
            <path
              key={i}
              d={d}
              stroke={stroke}
              strokeWidth={1.4}
              fill="none"
              markerEnd={marker}
              opacity={0.7}
            />
          )
        })}

        {units.map((unit) => {
          const pos = positions.get(unit.unitPath)
          if (!pos) return null
          const status = unitStatuses[unit.unitPath] ?? 'idle'
          const plan = unitPlanSummaries[unit.unitPath] ?? null
          const clickable = Boolean(onSelectUnit)
          const handleNodeClick = (e: React.MouseEvent): void => {
            // Don't treat a pan drag as a click: if the mouse moved while held, ignore.
            if (dragging.current) return
            if (!onSelectUnit) return
            e.stopPropagation()
            onSelectUnit(unit.unitPath)
          }
          return (
            <g
              key={unit.unitPath}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={handleNodeClick}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
            >
              <rect
                className={`tg-diagram-node status-${status}`}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                ry={8}
              />
              <text x={12} y={22} className="tg-diagram-node-title">
                {truncate(unitDisplayName(unit), 30)}
              </text>
              <text x={12} y={42} className="tg-diagram-node-sub">
                {truncate(unit.terraformSource || 'no terraform source', 32)}
              </text>
              {plan ? (
                plan.noop ? (
                  <text x={12} y={62} className="tg-diagram-node-status tg-diagram-plan-noop">
                    NO-OP
                  </text>
                ) : (
                  <g transform="translate(12, 62)">
                    <text className="tg-diagram-plan-create">+{plan.create}</text>
                    <text x={44} className="tg-diagram-plan-change">~{plan.change}</text>
                    <text x={88} className="tg-diagram-plan-destroy">-{plan.destroy}</text>
                  </g>
                )
              ) : (
                <text x={12} y={62} className="tg-diagram-node-status">
                  {statusLabel(status)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function buildCombinedLog(
  units: TerragruntUnit[],
  unitLogs: Record<string, string>,
  unitStatuses: Record<string, UnitStatus>
): string {
  const lines: string[] = []
  for (const unit of units) {
    const log = unitLogs[unit.unitPath]
    if (!log) continue
    const status = unitStatuses[unit.unitPath] ?? 'idle'
    const header = `════ ${unitDisplayName(unit)} · ${unitRelativePath(unit)} · ${statusLabel(status).toUpperCase()} ════`
    lines.push(header)
    lines.push(log.trimEnd())
    lines.push('')
  }
  return lines.join('\n')
}

function StackStateTab(props: {
  project: TerraformProject
  profileName: string
  connection?: AwsConnection
  units: TerragruntUnit[]
}): JSX.Element {
  const { project, profileName, connection, units } = props
  const [selectedUnitPath, setSelectedUnitPath] = useState<string>(units[0]?.unitPath ?? '')
  const [inventory, setInventory] = useState<TerragruntUnitInventoryResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selectedUnitPath && units[0]) setSelectedUnitPath(units[0].unitPath)
  }, [units, selectedUnitPath])

  const load = useCallback(async () => {
    if (!selectedUnitPath) return
    setBusy(true)
    setError('')
    setInventory(null)
    try {
      // Route through the stack project for identity/credentials, but pass the actual
      // absolute unit path so the backend runs `terragrunt state pull` in the unit's
      // directory — not the stack root (which has no state of its own).
      const result = await getTerragruntUnitInventory(profileName, project.id, connection, selectedUnitPath)
      setInventory(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [connection, profileName, project.id, selectedUnitPath])

  const selectedUnit = units.find((u) => u.unitPath === selectedUnitPath) ?? null

  return (
    <section className="tf-section">
      <div className="tf-section-head">
        <div>
          <h3>Unit state</h3>
          <div className="tf-section-hint">Select a unit and pull its live state. Requires terragrunt CLI, backend credentials, and a cache that has been initialised at least once.</div>
        </div>
      </div>
      <div className="tg-unit-picker">
        <label>
          Unit
          <select
            value={selectedUnitPath}
            onChange={(e) => { setSelectedUnitPath(e.target.value); setInventory(null) }}
            disabled={busy}
          >
            {units.map((u) => (
              <option key={u.unitPath} value={u.unitPath}>{unitDisplayName(u)} — {unitRelativePath(u)}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="tf-action-btn plan primary"
          disabled={!selectedUnitPath || busy}
          onClick={load}
        >
          {busy ? 'Pulling state…' : 'Pull state'}
        </button>
      </div>
      {error && <div className="tf-section-hint" style={{ color: '#e74c3c' }} title={error}>State pull failed — see tooltip for terragrunt output.</div>}
      {selectedUnit && (
        <div className="tg-unit-picker-meta">
          <span className="tg-muted">Selected:</span>
          <code>{unitRelativePath(selectedUnit)}</code>
          {selectedUnit.terraformSource && <span className="tg-muted">source: {selectedUnit.terraformSource}</span>}
        </div>
      )}
      {inventory && (
        <div className="tg-state-body">
          <div className="tg-state-meta">
            <span>State source: <code>{inventory.stateSource || 'unknown'}</code></span>
            <span>Working dir: <code>{inventory.workingDir || 'unresolved'}</code></span>
            <span>{inventory.inventory.length} resource{inventory.inventory.length === 1 ? '' : 's'}</span>
          </div>
          {inventory.error && (
            <pre className="tg-muted" style={{ color: '#e74c3c', whiteSpace: 'pre-wrap', marginTop: 8 }}>
              {inventory.error}
            </pre>
          )}
          {inventory.inventory.length === 0 && !inventory.error && (
            <p className="tg-muted">No resources in state. Run apply first, then pull again.</p>
          )}
          {inventory.inventory.length > 0 && (
            <table className="tg-state-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Type</th>
                  <th>Provider</th>
                  <th>Module</th>
                </tr>
              </thead>
              <tbody>
                {inventory.inventory.map((item) => (
                  <tr key={item.address}>
                    <td><code>{item.address}</code></td>
                    <td>{item.type}</td>
                    <td>{item.provider}</td>
                    <td>{item.modulePath || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {!inventory && !busy && !error && <div className="tf-section-hint">Pick a unit and click "Pull state" to fetch its inventory.</div>}
    </section>
  )
}

function StackDriftTab(props: {
  project: TerraformProject
  profileName: string
  connection?: AwsConnection
  units: TerragruntUnit[]
}): JSX.Element {
  const { project, profileName, connection, units } = props
  const [selectedUnitPath, setSelectedUnitPath] = useState<string>(units[0]?.unitPath ?? '')
  const [report, setReport] = useState<TerraformDriftReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selectedUnitPath && units[0]) setSelectedUnitPath(units[0].unitPath)
  }, [units, selectedUnitPath])

  const scan = useCallback(async () => {
    if (!selectedUnitPath) return
    if (!connection) {
      setError('Drift scanning requires a provider connection (profile + region).')
      return
    }
    setBusy(true)
    setError('')
    setReport(null)
    try {
      const result = await getTerragruntUnitDrift(profileName, project.id, connection, selectedUnitPath)
      setReport(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [connection, profileName, project.id, selectedUnitPath])

  const selectedUnit = units.find((u) => u.unitPath === selectedUnitPath) ?? null
  const items: TerraformDriftItem[] = report?.items ?? []
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [selectedAddress, setSelectedAddress] = useState<string>('')
  const selectedItem = useMemo(
    () => items.find((item) => (item.terraformAddress || item.cloudIdentifier) === selectedAddress) ?? null,
    [items, selectedAddress]
  )

  const cloudLabel = useMemo(() => {
    // Infer the cloud from the first item's resource type — all items from a unit share a cloud.
    const first = items[0]?.resourceType ?? ''
    if (first.startsWith('google_')) return 'GCP'
    if (first.startsWith('azurerm_')) return 'Azure'
    return 'AWS'
  }, [items])

  const statusChips: Array<{ key: string; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'in_sync', label: 'In Sync' },
    { key: 'drifted', label: 'Drifted' },
    { key: 'missing_in_aws', label: `Missing In ${cloudLabel}` },
    { key: 'unmanaged_in_aws', label: `Unmanaged In ${cloudLabel}` },
    { key: 'unsupported', label: 'Unsupported' }
  ]

  const resourceTypes = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of items) {
      if (item.resourceType && !seen.has(item.resourceType)) {
        seen.add(item.resourceType)
        out.push(item.resourceType)
      }
    }
    return out.sort()
  }, [items])

  const filteredItems = useMemo(() => items.filter((item) => {
    if (statusFilter !== 'all' && item.status !== statusFilter) return false
    if (typeFilter !== 'all' && item.resourceType !== typeFilter) return false
    return true
  }), [items, statusFilter, typeFilter])

  const statusCounts = useMemo(() => {
    const counts = { in_sync: 0, drifted: 0, missing_in_aws: 0, unmanaged_in_aws: 0, unsupported: 0 }
    for (const item of items) {
      if (item.status in counts) (counts as Record<string, number>)[item.status] += 1
    }
    return counts
  }, [items])

  return (
    <section className="tf-section">
      <div className="tf-section-head">
        <div>
          <h3>Unit drift</h3>
          <div className="tf-section-hint">
            Per-unit drift scan: pulls the unit's state via <code>terragrunt state pull</code>, enumerates live cloud resources
            through the current connection, and reports anything that disagrees. Runs fresh every time (no cache) — pick a unit then "Scan drift".
          </div>
        </div>
      </div>

      <div className="tg-unit-picker">
        <label>
          Unit
          <select
            value={selectedUnitPath}
            onChange={(e) => { setSelectedUnitPath(e.target.value); setReport(null) }}
            disabled={busy}
          >
            {units.map((u) => (
              <option key={u.unitPath} value={u.unitPath}>{unitDisplayName(u)} — {unitRelativePath(u)}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="tf-action-btn plan primary"
          disabled={!selectedUnitPath || busy}
          onClick={scan}
        >
          {busy ? 'Scanning drift…' : 'Scan drift'}
        </button>
      </div>

      {selectedUnit && (
        <div className="tg-unit-picker-meta">
          <span className="tg-muted">Selected:</span>
          <code>{unitRelativePath(selectedUnit)}</code>
          {selectedUnit.terraformSource && <span className="tg-muted">source: {selectedUnit.terraformSource}</span>}
        </div>
      )}

      {error && (
        <div className="tf-section-hint" style={{ color: '#e74c3c' }} title={error}>
          Drift scan failed — see tooltip for details.
        </div>
      )}

      {!report && !busy && !error && (
        <div className="tf-section-hint">
          Pick a unit and click "Scan drift" to compare its state against the live cloud.
        </div>
      )}

      {report && (
        <div className="tg-state-body">
          <div className="tg-state-meta">
            <span>Region: <code>{report.region || '-'}</code></span>
            <span>Items: {items.length}</span>
            <span>Scanned: {report.summary?.scannedAt ? new Date(report.summary.scannedAt).toLocaleString() : '—'}</span>
          </div>
          <div className="tf-summary" style={{ marginTop: 8 }}>
            <span className="tf-summary-item"><span className="tf-summary-count in_sync">{statusCounts.in_sync}</span> in sync</span>
            <span className="tf-summary-item"><span className="tf-summary-count drifted">{statusCounts.drifted}</span> drifted</span>
            <span className="tf-summary-item"><span className="tf-summary-count missing_in_aws">{statusCounts.missing_in_aws}</span> missing</span>
            <span className="tf-summary-item"><span className="tf-summary-count unmanaged_in_aws">{statusCounts.unmanaged_in_aws}</span> unmanaged</span>
            <span className="tf-summary-item"><span className="tf-summary-count unsupported">{statusCounts.unsupported}</span> unsupported</span>
          </div>
          <div className="tf-drift-filters" style={{ marginTop: 12 }}>
            <div className="tf-drift-status-row">
              {statusChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  className={statusFilter === chip.key ? 'active' : ''}
                  onClick={() => setStatusFilter(chip.key)}
                >
                  {chip.label}
                </button>
              ))}
            </div>
            <label className="tf-drift-filter-select">
              <span>Type</span>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="all">All resource types</option>
                {resourceTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>
          {filteredItems.length === 0
            ? <div className="tf-section-hint" style={{ marginTop: 12 }}>
                {items.length === 0
                  ? 'No resources in state to compare. Apply this unit to populate state.'
                  : 'No items match the current filter.'}
              </div>
            : (
              <div className="tf-resource-table-wrap" style={{ marginTop: 12 }}>
                <table className="tf-data-table tf-drift-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Type</th>
                      <th>Logical Name</th>
                      <th>Terraform Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((item) => {
                      const key = item.terraformAddress || item.cloudIdentifier
                      return (
                        <tr
                          key={`${item.status}:${key}`}
                          className={selectedAddress === key ? 'active' : ''}
                          onClick={() => setSelectedAddress(key === selectedAddress ? '' : key)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>
                            <span className={`tf-drift-badge ${item.status}`}>
                              {driftStatusLabel(item.status, item.resourceType)}
                            </span>
                          </td>
                          <td><code>{item.resourceType || '—'}</code></td>
                          <td>{item.logicalName || '—'}</td>
                          <td><code>{item.terraformAddress || item.cloudIdentifier || '—'}</code></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          {selectedItem && (
            <div className="tf-kv" style={{ marginTop: 16 }}>
              <div className="tf-kv-row"><div className="tf-kv-label">Status</div><div className="tf-kv-value">{driftStatusLabel(selectedItem.status, selectedItem.resourceType)}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Resource Type</div><div className="tf-kv-value"><code>{selectedItem.resourceType}</code></div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Logical Name</div><div className="tf-kv-value">{selectedItem.logicalName || '—'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Terraform Address</div><div className="tf-kv-value"><code>{selectedItem.terraformAddress || '—'}</code></div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Cloud Identifier</div><div className="tf-kv-value">{selectedItem.cloudIdentifier || '—'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Region</div><div className="tf-kv-value">{selectedItem.region || '—'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Explanation</div><div className="tf-kv-value">{selectedItem.explanation || '—'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Suggested Next Step</div><div className="tf-kv-value">{selectedItem.suggestedNextStep || '—'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Evidence</div><div className="tf-kv-value">{selectedItem.evidence.length > 0 ? selectedItem.evidence.join(' · ') : '—'}</div></div>
              <div className="tf-kv-row"><div className="tf-kv-label">Differences</div><div className="tf-kv-value">{selectedItem.differences.length > 0 ? selectedItem.differences.map((d) => `${d.label}: terraform=${d.terraformValue || '—'} → live=${d.liveValue || '—'}`).join(' · ') : '—'}</div></div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function driftStatusLabel(status: string, resourceType: string): string {
  // The status enum names (`missing_in_aws` / `unmanaged_in_aws`) predate multi-cloud and
  // are shared across providers. Pick a user-facing cloud name from the resource type
  // prefix so a GCP stack's unmanaged items don't read "Unmanaged in AWS".
  const cloud = resourceType.startsWith('google_') ? 'GCP'
    : resourceType.startsWith('azurerm_') ? 'Azure'
    : 'AWS'
  switch (status) {
    case 'in_sync': return 'In sync'
    case 'drifted': return 'Drifted'
    case 'missing_in_aws': return `Missing in ${cloud}`
    case 'missing_in_cloud': return `Missing in ${cloud}`
    case 'unmanaged_in_aws': return `Unmanaged in ${cloud}`
    case 'unmanaged_in_cloud': return `Unmanaged in ${cloud}`
    case 'unsupported': return 'Unsupported'
    default: return status
  }
}

function StackHistoryTab(props: {
  projectId: string
  unitByPath: Map<string, TerragruntUnit>
}): JSX.Element {
  const { projectId, unitByPath } = props
  const [records, setRecords] = useState<TerraformRunRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const data = await listRunHistory({ projectId })
      setRecords(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <section className="tf-section">
      <div className="tf-section-head">
        <div>
          <h3>Run history</h3>
          <div className="tf-section-hint">Every run-all writes one record per unit with phase and duration. Records are local-only and persisted under this project id.</div>
        </div>
        <button type="button" className="tf-toolbar-btn" onClick={reload} disabled={busy}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error && <div className="tf-section-hint" style={{ color: '#e74c3c' }}>{error}</div>}
      {records.length === 0 && !busy && !error && <div className="tf-section-hint">No runs recorded yet. Launch a Run all plan or apply to populate this tab.</div>}
      {records.length > 0 && (
        <table className="tg-history-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Command</th>
              <th>Unit</th>
              <th>Phase</th>
              <th>Result</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => {
              const unit = r.unitPath ? unitByPath.get(r.unitPath) : null
              const unitLabel = unit ? unitDisplayName(unit) : r.unitPath ? truncate(r.unitPath, 40) : r.projectName
              const resultClass = r.success === true ? 'success' : r.success === false ? 'danger' : 'info'
              const resultText = r.success === true ? 'Success' : r.success === false ? `Failed (${r.exitCode ?? '?'})` : r.finishedAt ? 'Done' : 'Running'
              const duration = typeof r.durationMs === 'number' ? formatDuration(r.durationMs) : '—'
              return (
                <tr key={r.id}>
                  <td>{formatHistoryDate(r.startedAt)}</td>
                  <td>{r.command}</td>
                  <td title={r.unitPath ?? ''}>{unitLabel}</td>
                  <td>{typeof r.dependencyPhase === 'number' ? `Phase ${r.dependencyPhase}` : '—'}</td>
                  <td><span className={`tg-tag ${resultClass}`}>{resultText}</span></td>
                  <td>{duration}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

function formatHistoryDate(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  } catch {
    return iso
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSec = seconds % 60
  return `${minutes}m${remSec.toString().padStart(2, '0')}s`
}

function UnitPlanDetailModal(props: {
  unit: TerragruntUnit | null
  summary: UnitPlanSummary | null
  changes: PlanResourceChange[]
  hasLog: boolean
  onClose: () => void
  onOpenLog: () => void
}): JSX.Element {
  const { unit, summary, changes, hasLog, onClose, onOpenLog } = props
  const grouped = useMemo(() => {
    const groups: Record<PlanAction, PlanResourceChange[]> = {
      destroy: [], replace: [], update: [], create: [], read: [], unknown: []
    }
    for (const c of changes) groups[c.action].push(c)
    return groups
  }, [changes])

  const actionLabel: Record<PlanAction, string> = {
    create: 'Create',
    update: 'Update in-place',
    replace: 'Replace (destroy + create)',
    destroy: 'Destroy',
    read: 'Read',
    unknown: 'Other'
  }

  return (
    <div className="tg-modal-backdrop" onClick={onClose}>
      <div className="tg-plan-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tg-monitor-head">
          <div>
            <strong>{unit ? unitDisplayName(unit) : 'Unit plan details'}</strong>
            <span className="tf-section-hint">
              {unit ? unitRelativePath(unit) : 'No unit selected.'}
              {summary && (
                <>
                  {' · '}
                  {summary.noop ? 'No changes' : `+${summary.create} ~${summary.change} -${summary.destroy}`}
                </>
              )}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {hasLog && (
              <button type="button" className="tf-toolbar-btn" onClick={onOpenLog}>
                Open full log
              </button>
            )}
            <button type="button" className="tf-toolbar-btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="tg-plan-detail-body">
          {summary?.noop && (
            <div className="tf-section-hint">
              Terraform reported <strong>no changes</strong>. The deployed infrastructure matches the configuration.
            </div>
          )}

          {!summary && changes.length === 0 && (
            <div className="tf-section-hint">
              No plan has produced a parseable summary for this unit yet. Run all plan (or run a single-unit plan) first.
            </div>
          )}

          {changes.length > 0 && (
            <div className="tg-plan-detail-groups">
              {(['destroy', 'replace', 'update', 'create', 'read', 'unknown'] as const).map((action) => {
                const items = grouped[action]
                if (items.length === 0) return null
                return (
                  <section key={action} className={`tg-plan-detail-group tone-${action}`}>
                    <div className="tg-plan-detail-group-head">
                      <span className={`tg-plan-detail-action tone-${action}`}>{actionLabel[action]}</span>
                      <strong>{items.length}</strong>
                    </div>
                    <ul className="tg-plan-detail-list">
                      {items.map((c) => (
                        <li key={c.address} title={c.address}>
                          <code>{c.address}</code>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}

          {summary && !summary.noop && changes.length === 0 && (
            <div className="tf-section-hint">
              Terraform reported <code>+{summary.create} ~{summary.change} -{summary.destroy}</code> but no
              per-resource breakdown was captured from the log. Open the full log for details.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RunMiniIndicator(props: {
  command: TerragruntRunAllCommand | null
  units: TerragruntUnit[]
  unitStatuses: Record<string, UnitStatus>
  onOpen: () => void
  onCancel: () => void
}): JSX.Element {
  const { command, units, unitStatuses, onOpen, onCancel } = props

  const counts = useMemo(() => {
    let running = 0, succeeded = 0, failed = 0, blocked = 0, idle = 0
    for (const u of units) {
      const s = unitStatuses[u.unitPath] ?? 'idle'
      if (s === 'running') running += 1
      else if (s === 'succeeded') succeeded += 1
      else if (s === 'failed') failed += 1
      else if (s === 'blocked') blocked += 1
      else idle += 1
    }
    return { running, succeeded, failed, blocked, idle, total: units.length }
  }, [units, unitStatuses])

  const activeRunningUnit = useMemo(() => {
    return units.find((u) => (unitStatuses[u.unitPath] ?? 'idle') === 'running') ?? null
  }, [units, unitStatuses])

  const commandLabel = command ?? 'run-all'
  const subtitle = activeRunningUnit
    ? `Running ${unitDisplayName(activeRunningUnit)} · phase ${resolveUnitPhase(activeRunningUnit, units)} · ${counts.succeeded + counts.failed}/${counts.total} done`
    : counts.idle === counts.total
      ? `Starting ${commandLabel} …`
      : `${counts.succeeded + counts.failed}/${counts.total} done · waiting for next phase`

  return (
    <div className="tg-mini-indicator" role="status" aria-live="polite">
      <button
        type="button"
        className="tg-mini-body"
        onClick={onOpen}
        title="Open run output"
      >
        <span className="tg-mini-spinner" aria-hidden />
        <div className="tg-mini-copy">
          <strong>Running Terragrunt {commandLabel}…</strong>
          <span>{subtitle}</span>
        </div>
      </button>
      <button type="button" className="tg-mini-kill" onClick={onCancel}>
        Kill Switch
      </button>
    </div>
  )
}

function resolveUnitPhase(unit: TerragruntUnit, units: TerragruntUnit[]): number {
  // Phase isn't directly stored on the unit; approximate by locating the unit in the provided
  // list order, which we keep sorted by relative path. For tactful display only.
  const idx = units.findIndex((u) => u.unitPath === unit.unitPath)
  return idx < 0 ? 0 : idx
}

function RunMonitorModal(props: {
  command: TerragruntRunAllCommand | null
  running: boolean
  units: TerragruntUnit[]
  unitStatuses: Record<string, UnitStatus>
  unitLogs: Record<string, string>
  selectedUnit: string | null
  onSelect: (unitPath: string) => void
  onClose: () => void
}): JSX.Element {
  const { command, running, units, unitStatuses, unitLogs, selectedUnit, onSelect, onClose } = props
  const logRef = useRef<HTMLPreElement>(null)

  const orderedUnits = useMemo(() => {
    const getRank = (status: UnitStatus): number => {
      switch (status) {
        case 'running': return 0
        case 'failed': return 1
        case 'blocked': return 2
        case 'cancelled': return 3
        case 'succeeded': return 4
        default: return 5
      }
    }
    return [...units].sort((a, b) => {
      const ra = getRank(unitStatuses[a.unitPath] ?? 'idle')
      const rb = getRank(unitStatuses[b.unitPath] ?? 'idle')
      if (ra !== rb) return ra - rb
      return unitRelativePath(a).localeCompare(unitRelativePath(b))
    })
  }, [units, unitStatuses])

  const activeUnit = selectedUnit
    ? units.find((u) => u.unitPath === selectedUnit) ?? null
    : null
  const activeLog = selectedUnit ? unitLogs[selectedUnit] ?? '' : ''
  const activeStatus = selectedUnit ? unitStatuses[selectedUnit] ?? 'idle' : 'idle'

  const counters = useMemo(() => {
    let running = 0, succeeded = 0, failed = 0, blocked = 0, cancelled = 0, idle = 0
    for (const u of units) {
      const s = unitStatuses[u.unitPath] ?? 'idle'
      if (s === 'running') running += 1
      else if (s === 'succeeded') succeeded += 1
      else if (s === 'failed') failed += 1
      else if (s === 'blocked') blocked += 1
      else if (s === 'cancelled') cancelled += 1
      else idle += 1
    }
    return { running, succeeded, failed, blocked, cancelled, idle }
  }, [units, unitStatuses])

  // Auto-scroll the log pane while the active unit is streaming.
  useEffect(() => {
    if (!logRef.current) return
    if (activeStatus === 'running') {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [activeLog, activeStatus])

  return (
    <div className="tg-modal-backdrop" onClick={onClose}>
      <div className="tg-monitor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tg-monitor-head">
          <div>
            <strong>{running ? 'Run-all in progress' : 'Run-all output'}</strong>
            <span className="tf-section-hint">
              {command ? `Command: ${command}` : 'No command running'}
              {' · '}
              {counters.running > 0 && `${counters.running} running · `}
              {counters.succeeded} ok · {counters.failed} failed · {counters.blocked} blocked
              {counters.cancelled > 0 && ` · ${counters.cancelled} cancelled`}
              {counters.idle > 0 && ` · ${counters.idle} pending`}
            </span>
          </div>
          <button type="button" className="tf-toolbar-btn" onClick={onClose}>Close</button>
        </div>
        <div className="tg-monitor-body">
          <div className="tg-monitor-unit-list">
            {orderedUnits.map((unit) => {
              const status = unitStatuses[unit.unitPath] ?? 'idle'
              const isSelected = unit.unitPath === selectedUnit
              return (
                <button
                  key={unit.unitPath}
                  type="button"
                  className={`tg-monitor-unit ${isSelected ? 'active' : ''}`}
                  onClick={() => onSelect(unit.unitPath)}
                  title={unit.unitPath}
                >
                  <div className="tg-monitor-unit-name">{unitDisplayName(unit)}</div>
                  <div className="tg-monitor-unit-path">{unitRelativePath(unit)}</div>
                  <span className={`tg-status-badge status-${status}`}>{statusLabel(status)}</span>
                </button>
              )
            })}
          </div>
          <div className="tg-monitor-log-pane">
            {activeUnit ? (
              <>
                <div className="tg-monitor-log-head">
                  <div>
                    <strong>{unitDisplayName(activeUnit)}</strong>
                    <span className="tf-section-hint">{unitRelativePath(activeUnit)}</span>
                  </div>
                  <span className={`tg-status-badge status-${activeStatus}`}>{statusLabel(activeStatus)}</span>
                </div>
                <pre ref={logRef} className="tg-monitor-log">{activeLog || '(waiting for output…)'}</pre>
                {activeStatus === 'blocked' && (
                  <div className="tf-section-hint">Blocked: an upstream dependency in this stack failed. See the failing unit's output.</div>
                )}
                {activeStatus === 'cancelled' && (
                  <div className="tf-section-hint">Cancelled by the operator before this unit could finish.</div>
                )}
              </>
            ) : (
              <div className="tg-monitor-log-empty">Pick a unit from the left to see its output.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function RunAllConfirmModal(props: {
  command: TerragruntRunAllCommand
  units: TerragruntUnit[]
  phases: string[][]
  environmentLabel: string | null
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { command, units, phases, environmentLabel, onCancel, onConfirm } = props
  const unitCount = units.length
  const verb = command === 'apply' ? 'apply' : command === 'destroy' ? 'destroy' : command
  return (
    <div className="tg-modal-backdrop" onClick={onCancel}>
      <div className="tg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tg-modal-header">
          <strong>
            Confirm run-all {verb}
            {environmentLabel && <span style={{ color: '#9ec7ff' }}> · {environmentLabel}</span>}
          </strong>
        </div>
        <div className="tg-modal-body">
          <p>
            This will <strong>{verb}</strong>{' '}
            {environmentLabel
              ? <>only the {unitCount} unit{unitCount === 1 ? '' : 's'} under <code>{environmentLabel}</code></>
              : <>across {unitCount} unit{unitCount === 1 ? '' : 's'}</>}
            {' '}in {phases.length} phase{phases.length === 1 ? '' : 's'}.
            {command === 'destroy' && ' Destroy is irreversible — ensure you have backups and understand the blast radius.'}
          </p>
          <div className="tg-modal-phase-list">
            {phases.map((phase, idx) => (
              <div key={idx} className="tg-modal-phase">
                <span className="tg-modal-phase-label">Phase {idx}</span>
                <span className="tg-modal-phase-count">{phase.length} unit{phase.length === 1 ? '' : 's'}</span>
                <ul>
                  {phase.slice(0, 8).map((unitPath) => <li key={unitPath} title={unitPath}>{shortenPath(unitPath)}</li>)}
                  {phase.length > 8 && <li className="tg-muted">+ {phase.length - 8} more</li>}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="tg-modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={command === 'destroy' ? 'danger' : 'accent'}
            onClick={onConfirm}
          >
            {command === 'destroy' ? 'Destroy all' : command === 'apply' ? 'Apply all' : 'Plan all'}
          </button>
        </div>
      </div>
    </div>
  )
}
