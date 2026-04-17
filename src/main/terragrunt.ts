import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app, type BrowserWindow } from 'electron'

import type {
  TerraformAuditProviderId,
  TerraformCommandName,
  TerraformRunRecord,
  TerragruntCliInfo,
  TerragruntRunAllCommand,
  TerragruntRunAllEvent,
  TerragruntRunAllSummary,
  TerragruntStack,
  TerragruntUnit
} from '@shared/types'
import { getResolvedProcessEnv, resolveExecutablePath } from './shell'
import { listToolCommandCandidates } from './toolchain'
import { scanForTerragrunt } from './terragruntDiscovery'
import { redactArgs, saveRunRecord, updateRunRecord } from './terraformHistoryStore'
import { classifyTerraformError } from './terraformErrorClassifier'

const NOT_INSTALLED_ERROR =
  'Terragrunt CLI not found. Install Terragrunt and ensure it is on your PATH, or set an explicit path in Settings.'

const RENDER_JSON_TIMEOUT_MS = 30000

let cachedInfo: TerragruntCliInfo | null = null

type RenderedDependency = { name: string; config_path?: string }
type RenderedTerraform = { source?: string }
type RenderedJson = {
  terraform?: RenderedTerraform
  dependency?: Record<string, RenderedDependency> | RenderedDependency[]
  dependencies?: { paths?: string[] }
  include?: Record<string, { path?: string }> | Array<{ name?: string; path?: string }>
}

type RenderedUnitCacheEntry = {
  configMtimeMs: number
  json: RenderedJson
}

const renderCache = new Map<string, RenderedUnitCacheEntry>()

function terragruntCandidates(): string[] {
  const baseName = 'terragrunt'
  const executableName = process.platform === 'win32' ? `${baseName}.exe` : baseName
  const names = process.platform === 'win32' ? [executableName, baseName] : [baseName]
  const fallbacks: string[] = []

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pfx86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const chocoBin = process.env.ChocolateyInstall
      ? path.join(process.env.ChocolateyInstall, 'bin', executableName)
      : 'C:\\ProgramData\\chocolatey\\bin\\terragrunt.exe'
    const scoopShim = path.join(os.homedir(), 'scoop', 'shims', executableName)
    fallbacks.push(
      chocoBin,
      scoopShim,
      path.join(pf, 'Terragrunt', executableName),
      path.join(pfx86, 'Terragrunt', executableName),
      path.join(os.homedir(), '.tgenv', 'bin', executableName),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Terragrunt', executableName)
    )
  } else if (process.platform === 'darwin') {
    fallbacks.push(
      `/usr/local/bin/${baseName}`,
      `/opt/homebrew/bin/${baseName}`,
      path.join(os.homedir(), '.tgenv', 'bin', baseName),
      path.join(os.homedir(), 'bin', baseName)
    )
  } else {
    fallbacks.push(
      `/usr/local/bin/${baseName}`,
      `/usr/bin/${baseName}`,
      `/snap/bin/${baseName}`,
      path.join(os.homedir(), '.tgenv', 'bin', baseName),
      path.join(os.homedir(), 'bin', baseName)
    )
  }

  return listToolCommandCandidates('terragrunt', [...names, ...fallbacks])
}

function parseVersionOutput(stdout: string): string {
  const match = stdout.match(/terragrunt\s+version\s+v?([0-9][^\s]*)/i)
    ?? stdout.match(/v?([0-9]+\.[0-9]+\.[0-9]+(?:[^\s]*)?)/i)
  return match?.[1] ?? stdout.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? ''
}

async function probeCandidate(
  candidate: string,
  env: Record<string, string>
): Promise<TerragruntCliInfo | null> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(candidate, ['--version'], { env, timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
    const combined = `${result.stdout}\n${result.stderr}`
    const version = parseVersionOutput(combined)
    return {
      found: true,
      path: await resolveExecutablePath(candidate, env),
      version,
      error: ''
    }
  } catch {
    return null
  }
}

export async function detectTerragruntCli(baseEnv?: Record<string, string>): Promise<TerragruntCliInfo> {
  const env = baseEnv ?? await getResolvedProcessEnv()
  for (const candidate of terragruntCandidates()) {
    const info = await probeCandidate(candidate, env)
    if (info) {
      cachedInfo = info
      return info
    }
  }

  cachedInfo = {
    found: false,
    path: '',
    version: '',
    error: NOT_INSTALLED_ERROR
  }
  return cachedInfo
}

export function getCachedTerragruntCliInfo(): TerragruntCliInfo {
  return cachedInfo ?? {
    found: false,
    path: '',
    version: '',
    error: 'Terragrunt CLI detection has not run yet.'
  }
}

export async function resolveTerragruntExecutable(): Promise<string> {
  const info = cachedInfo ?? await detectTerragruntCli()
  if (!info.found) throw new Error(NOT_INSTALLED_ERROR)
  return info.path
}

export function buildTerragruntCommandArgs(command: TerraformCommandName): string[] {
  const base = ['--terragrunt-non-interactive', '-no-color']
  switch (command) {
    case 'init':
      return ['init', '--terragrunt-non-interactive']
    case 'plan':
      return ['plan', ...base]
    case 'apply':
      return ['apply', ...base, '-auto-approve']
    case 'destroy':
      return ['destroy', ...base, '-auto-approve']
    case 'state-list':
      return ['state', 'list', '--terragrunt-non-interactive']
    case 'state-pull':
      return ['state', 'pull', '--terragrunt-non-interactive']
    case 'version':
      return ['--version']
    default:
      throw new Error(`Terragrunt runs do not support command "${command}" yet.`)
  }
}

/* ── render-json ─────────────────────────────────────────── */

function renderJsonTempPath(): string {
  const dir = path.join(app.getPath('temp'), 'infralens-terragrunt-render')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${randomUUID()}.json`)
}

function configFileMtime(configFile: string): number {
  try { return fs.statSync(configFile).mtimeMs } catch { return 0 }
}

async function invokeRenderJson(
  cliPath: string,
  unitPath: string,
  outFile: string,
  env: Record<string, string>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      cliPath,
      ['render-json', '--terragrunt-json-out', outFile],
      { cwd: unitPath, env, timeout: RENDER_JSON_TIMEOUT_MS, windowsHide: true },
      (err) => {
        if (err) reject(err)
        else resolve()
      }
    )
  })
}

export async function renderUnitJson(unitPath: string): Promise<RenderedJson> {
  const configFile = path.join(unitPath, 'terragrunt.hcl')
  if (!fs.existsSync(configFile)) {
    throw new Error(`No terragrunt.hcl at ${unitPath}`)
  }
  const mtime = configFileMtime(configFile)
  const cached = renderCache.get(configFile)
  if (cached && cached.configMtimeMs === mtime) return cached.json

  const info = cachedInfo ?? await detectTerragruntCli()
  if (!info.found) throw new Error(NOT_INSTALLED_ERROR)

  const env = await getResolvedProcessEnv()
  const outFile = renderJsonTempPath()
  try {
    await invokeRenderJson(info.path, unitPath, outFile, env)
    const raw = fs.readFileSync(outFile, 'utf-8')
    const parsed = JSON.parse(raw) as RenderedJson
    renderCache.set(configFile, { configMtimeMs: mtime, json: parsed })
    return parsed
  } finally {
    try { fs.unlinkSync(outFile) } catch { /* ignore */ }
  }
}

/* ── Dependency graph ────────────────────────────────────── */

function resolveStaticDependencyPath(unit: TerragruntUnit, rawPath: string): string {
  if (!rawPath) return ''
  return path.resolve(unit.unitPath, rawPath)
}

function applyStaticResolution(units: TerragruntUnit[]): TerragruntUnit[] {
  return units.map((unit) => ({
    ...unit,
    dependencies: unit.dependencies.map((dep) => ({
      ...dep,
      resolvedPath: dep.resolvedPath || resolveStaticDependencyPath(unit, dep.configPath)
    }))
  }))
}

function applyRenderedResolution(unit: TerragruntUnit, json: RenderedJson): TerragruntUnit {
  const next = { ...unit }
  const source = json.terraform?.source
  if (typeof source === 'string' && source) next.terraformSource = source

  const depMap = new Map<string, string>()
  if (json.dependency) {
    const entries = Array.isArray(json.dependency)
      ? json.dependency.map((d) => [d.name ?? '', d.config_path ?? ''] as const)
      : Object.entries(json.dependency).map(([name, d]) => [name, d?.config_path ?? ''] as const)
    for (const [name, cfg] of entries) {
      if (name && cfg) depMap.set(name, cfg)
    }
  }
  next.dependencies = unit.dependencies.map((dep) => {
    const rendered = depMap.get(dep.name) ?? ''
    const resolvedPath = rendered
      ? (path.isAbsolute(rendered) ? rendered : path.resolve(unit.unitPath, rendered))
      : resolveStaticDependencyPath(unit, dep.configPath)
    return { ...dep, resolvedPath }
  })

  const extraPaths = json.dependencies?.paths
  if (Array.isArray(extraPaths)) {
    next.additionalDependencyPaths = extraPaths.map((p) =>
      path.isAbsolute(p) ? p : path.resolve(unit.unitPath, p)
    )
  }

  next.resolvedAt = new Date().toISOString()
  next.resolveError = ''
  return next
}

export function buildDependencyGraph(units: TerragruntUnit[]): {
  dependencyOrder: string[][]
  cycles: string[][]
} {
  const unitPaths = new Set(units.map((u) => u.unitPath))
  const deps = new Map<string, Set<string>>()

  for (const unit of units) {
    const set = new Set<string>()
    for (const dep of unit.dependencies) {
      const resolved = dep.resolvedPath || resolveStaticDependencyPath(unit, dep.configPath)
      if (resolved && unitPaths.has(resolved) && resolved !== unit.unitPath) {
        set.add(resolved)
      }
    }
    for (const raw of unit.additionalDependencyPaths) {
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(unit.unitPath, raw)
      if (unitPaths.has(resolved) && resolved !== unit.unitPath) set.add(resolved)
    }
    deps.set(unit.unitPath, set)
  }

  const phases: string[][] = []
  const pending = new Map<string, Set<string>>()
  for (const [k, v] of deps) pending.set(k, new Set(v))

  while (pending.size > 0) {
    const ready: string[] = []
    for (const [node, nodeDeps] of pending) {
      if (nodeDeps.size === 0) ready.push(node)
    }
    if (ready.length === 0) break
    ready.sort()
    phases.push(ready)
    for (const r of ready) pending.delete(r)
    for (const [, nodeDeps] of pending) {
      for (const r of ready) nodeDeps.delete(r)
    }
  }

  const cycles = pending.size > 0 ? findCycles(pending) : []
  return { dependencyOrder: phases, cycles }
}

function findCycles(remaining: Map<string, Set<string>>): string[][] {
  const nodes = [...remaining.keys()]
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  let counter = 0

  const strongConnect = (v: string): void => {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)

    const next = remaining.get(v) ?? new Set<string>()
    for (const w of next) {
      if (!index.has(w)) {
        strongConnect(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }

    if (low.get(v) === index.get(v)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(w)
      } while (w !== v)
      if (component.length > 1 || (remaining.get(v)?.has(v) ?? false)) {
        components.push(component.sort())
      }
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) strongConnect(node)
  }
  return components
}

/* ── Public resolve API ──────────────────────────────────── */

export type ResolvedStack = {
  stack: TerragruntStack
  cliAvailable: boolean
  resolveErrors: Array<{ unitPath: string; error: string }>
}

export async function resolveStack(rootPath: string): Promise<ResolvedStack> {
  const discovery = scanForTerragrunt(rootPath)
  const info = await detectTerragruntCli()
  const cliAvailable = info.found
  const resolveErrors: Array<{ unitPath: string; error: string }> = []

  let units: TerragruntUnit[] = discovery.units
  if (cliAvailable) {
    const resolved: TerragruntUnit[] = []
    for (const unit of units) {
      try {
        const json = await renderUnitJson(unit.unitPath)
        resolved.push(applyRenderedResolution(unit, json))
      } catch (err) {
        resolveErrors.push({ unitPath: unit.unitPath, error: (err as Error).message })
        resolved.push({
          ...unit,
          resolveError: (err as Error).message,
          dependencies: unit.dependencies.map((d) => ({
            ...d,
            resolvedPath: d.resolvedPath || resolveStaticDependencyPath(unit, d.configPath)
          }))
        })
      }
    }
    units = resolved
  } else {
    units = applyStaticResolution(units)
  }

  const { dependencyOrder, cycles } = buildDependencyGraph(units)

  return {
    stack: {
      stackRoot: discovery.stackRoot || path.resolve(rootPath),
      units,
      dependencyOrder,
      cycles
    },
    cliAvailable,
    resolveErrors
  }
}

/* ── run-all orchestration ───────────────────────────────── */

export type RunAllHistoryIdentity = {
  stackProjectId: string
  stackProjectName: string
  workspace: string
  region: string
  connectionLabel: string
  backendType: string
  provider: TerraformAuditProviderId
}

export type RunAllStartOptions = {
  stack: TerragruntStack
  command: TerragruntRunAllCommand
  env: Record<string, string>
  identity: RunAllHistoryIdentity
  window: BrowserWindow | null
}

type ActiveRunAll = {
  runId: string
  stackRoot: string
  cancelled: boolean
  children: Set<ChildProcessWithoutNullStreams>
  done: Promise<void>
}

const activeRunAlls = new Map<string, ActiveRunAll>()

function terminateRunAllChild(child: ChildProcessWithoutNullStreams | null): void {
  if (!child) return
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false
      })
      return
    } catch {
      /* fall back */
    }
  }
  try { child.kill() } catch { /* ignore */ }
}

function emitRunAllEvent(window: BrowserWindow | null, event: TerragruntRunAllEvent): void {
  window?.webContents.send('terragrunt:run-all:event', event)
}

function buildDependencyMap(units: TerragruntUnit[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const unitPaths = new Set(units.map((u) => u.unitPath))
  for (const unit of units) {
    const deps = new Set<string>()
    for (const dep of unit.dependencies) {
      const resolved = dep.resolvedPath || path.resolve(unit.unitPath, dep.configPath || '')
      if (resolved && unitPaths.has(resolved) && resolved !== unit.unitPath) deps.add(resolved)
    }
    for (const raw of unit.additionalDependencyPaths) {
      const resolved = path.isAbsolute(raw) ? raw : path.resolve(unit.unitPath, raw)
      if (unitPaths.has(resolved) && resolved !== unit.unitPath) deps.add(resolved)
    }
    map.set(unit.unitPath, deps)
  }
  return map
}

function makeRunRecord(params: {
  id: string
  stackRoot: string
  unitPath: string
  phase: number
  command: TerraformCommandName
  args: string[]
  identity: RunAllHistoryIdentity
  startedAt: string
}): TerraformRunRecord {
  return {
    id: params.id,
    projectId: params.identity.stackProjectId,
    projectName: params.identity.stackProjectName,
    command: params.command,
    args: redactArgs(params.args),
    workspace: params.identity.workspace,
    region: params.identity.region,
    connectionLabel: params.identity.connectionLabel,
    backendType: params.identity.backendType,
    stateSource: '',
    startedAt: params.startedAt,
    finishedAt: null,
    exitCode: null,
    success: null,
    planSummary: null,
    planJsonPath: '',
    backupPath: '',
    backupCreatedAt: '',
    stateOperationSummary: '',
    git: null,
    provider: params.identity.provider,
    module: params.identity.stackProjectName,
    resource: '',
    durationMs: null,
    retryCount: 0,
    errorClass: null,
    suggestedAction: '',
    stackRoot: params.stackRoot,
    unitPath: params.unitPath,
    dependencyPhase: params.phase
  }
}

function runUnitProcess(params: {
  binary: string
  args: string[]
  env: Record<string, string>
  unitPath: string
  command: TerragruntRunAllCommand
  onOutput: (chunk: string) => void
  active: ActiveRunAll
}): Promise<{ exitCode: number; error: string }> {
  return new Promise((resolve) => {
    if (params.active.cancelled) {
      resolve({ exitCode: 130, error: 'cancelled before start' })
      return
    }
    const child = spawn(params.binary, params.args, {
      cwd: params.unitPath,
      env: params.env,
      shell: false,
      windowsHide: true
    })
    params.active.children.add(child)
    let errorText = ''
    child.stdout.on('data', (buf) => params.onOutput(buf.toString()))
    child.stderr.on('data', (buf) => {
      const chunk = buf.toString()
      errorText += chunk
      params.onOutput(chunk)
    })
    child.on('error', (err) => {
      params.active.children.delete(child)
      resolve({ exitCode: -1, error: err.message })
    })
    child.on('close', (code) => {
      params.active.children.delete(child)
      resolve({ exitCode: code ?? -1, error: errorText.slice(-500) })
    })
  })
}

export async function startRunAll(options: RunAllStartOptions): Promise<{ runId: string; phases: string[][] }> {
  if (options.stack.cycles.length > 0) {
    throw new Error(`Stack has dependency cycles: ${options.stack.cycles.map((c) => c.join(' -> ')).join('; ')}`)
  }
  if (activeRunAlls.has(options.stack.stackRoot)) {
    throw new Error('A run-all is already active for this stack.')
  }

  const binary = await resolveTerragruntExecutable()
  const baseArgs = buildTerragruntCommandArgs(options.command)
  const runId = randomUUID()
  const depsMap = buildDependencyMap(options.stack.units)
  const phases = options.stack.dependencyOrder

  const active: ActiveRunAll = {
    runId,
    stackRoot: options.stack.stackRoot,
    cancelled: false,
    children: new Set(),
    done: Promise.resolve()
  }

  emitRunAllEvent(options.window, {
    type: 'stack-started',
    runId,
    stackRoot: options.stack.stackRoot,
    command: options.command,
    phases
  })

  const succeeded = new Set<string>()
  const failed = new Set<string>()
  const blocked = new Set<string>()
  const cancelled = new Set<string>()

  active.done = (async () => {
    try {
      for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx += 1) {
        const phase = phases[phaseIdx]
        const tasks: Promise<void>[] = []
        for (const unitPath of phase) {
          const deps = depsMap.get(unitPath) ?? new Set<string>()
          const failedDeps = [...deps].filter((d) => failed.has(d) || blocked.has(d))
          if (failedDeps.length > 0) {
            blocked.add(unitPath)
            emitRunAllEvent(options.window, { type: 'unit-blocked', runId, unitPath, blockedBy: failedDeps })
            continue
          }
          if (active.cancelled) {
            cancelled.add(unitPath)
            emitRunAllEvent(options.window, { type: 'unit-cancelled', runId, unitPath })
            continue
          }
          const unitRunId = randomUUID()
          const startedAt = new Date().toISOString()
          const unitArgs = [...baseArgs]
          if (options.command === 'plan') {
            clearSavedTerragruntPlan(options.identity.stackProjectId, unitPath)
            unitArgs.push(`-out=${ensureTerragruntPlanFilePath(options.identity.stackProjectId, unitPath)}`)
          } else if (options.command === 'apply' || options.command === 'destroy') {
            clearSavedTerragruntPlan(options.identity.stackProjectId, unitPath)
          }
          const record = makeRunRecord({
            id: unitRunId,
            stackRoot: options.stack.stackRoot,
            unitPath,
            phase: phaseIdx,
            command: options.command,
            args: unitArgs,
            identity: options.identity,
            startedAt
          })
          saveRunRecord(record, '')
          emitRunAllEvent(options.window, { type: 'unit-started', runId, unitPath, phase: phaseIdx, unitRunId })

          let outputBuffer = ''
          const task = runUnitProcess({
            binary,
            args: unitArgs,
            env: options.env,
            unitPath,
            command: options.command,
            onOutput: (chunk) => {
              outputBuffer += chunk
              emitRunAllEvent(options.window, { type: 'unit-output', runId, unitPath, chunk })
            },
            active
          }).then((result) => {
            const startedAtMs = Date.parse(startedAt)
            const finishedAt = new Date().toISOString()
            const durationMs = Date.parse(finishedAt) - (Number.isFinite(startedAtMs) ? startedAtMs : Date.now())
            if (active.cancelled && result.exitCode !== 0) {
              cancelled.add(unitPath)
              updateRunRecord(unitRunId, {
                finishedAt,
                exitCode: 130,
                success: false,
                durationMs,
                errorClass: null,
                suggestedAction: ''
              }, outputBuffer)
              emitRunAllEvent(options.window, { type: 'unit-cancelled', runId, unitPath })
              return
            }
            const success = options.command === 'plan'
              ? (result.exitCode === 0 || result.exitCode === 2)
              : result.exitCode === 0
            if (success) {
              succeeded.add(unitPath)
              if (options.command === 'plan') {
                recordTerragruntSavedPlan(options.identity.stackProjectId, unitPath)
              }
              updateRunRecord(unitRunId, {
                finishedAt,
                exitCode: result.exitCode,
                success: true,
                durationMs,
                errorClass: null,
                suggestedAction: ''
              }, outputBuffer)
              emitRunAllEvent(options.window, {
                type: 'unit-completed',
                runId,
                unitPath,
                exitCode: result.exitCode,
                success: true
              })
            } else {
              failed.add(unitPath)
              const classified = classifyTerraformError({
                output: outputBuffer,
                exitCode: result.exitCode,
                errorMessage: result.error,
                provider: options.identity.provider,
                errorName: ''
              })
              updateRunRecord(unitRunId, {
                finishedAt,
                exitCode: result.exitCode,
                success: false,
                durationMs,
                errorClass: classified.errorClass,
                suggestedAction: classified.suggestedAction
              }, outputBuffer)
              emitRunAllEvent(options.window, {
                type: 'unit-completed',
                runId,
                unitPath,
                exitCode: result.exitCode,
                success: false
              })
            }
          })
          tasks.push(task)
        }
        await Promise.all(tasks)
      }
    } finally {
      activeRunAlls.delete(options.stack.stackRoot)
      const summary: TerragruntRunAllSummary = {
        succeeded: [...succeeded].sort(),
        failed: [...failed].sort(),
        blocked: [...blocked].sort(),
        cancelled: [...cancelled].sort()
      }
      emitRunAllEvent(options.window, { type: 'stack-completed', runId, summary })
    }
  })()

  activeRunAlls.set(options.stack.stackRoot, active)
  return { runId, phases }
}

export function cancelRunAll(runId: string): boolean {
  for (const [, active] of activeRunAlls) {
    if (active.runId === runId) {
      if (active.cancelled) return true
      active.cancelled = true
      for (const child of active.children) terminateRunAllChild(child)
      return true
    }
  }
  return false
}

export function listActiveRunAllStackRoots(): string[] {
  return [...activeRunAlls.keys()]
}

/* ── Saved plan namespacing ──────────────────────────────── */

const TERRAGRUNT_PLAN_FILENAME = 'plan.tfplan'
const TERRAGRUNT_PLAN_METADATA_FILENAME = 'plan.meta.json'

function terragruntPlanRoot(): string {
  return path.join(app.getPath('userData'), 'infralens-terragrunt-plans')
}

function unitDirectoryHash(unitPath: string): string {
  return createHash('sha256').update(path.resolve(unitPath)).digest('hex').slice(0, 16)
}

export function terragruntPlanDir(projectId: string, unitPath: string): string {
  return path.join(terragruntPlanRoot(), projectId, unitDirectoryHash(unitPath))
}

export function terragruntPlanFilePath(projectId: string, unitPath: string): string {
  return path.join(terragruntPlanDir(projectId, unitPath), TERRAGRUNT_PLAN_FILENAME)
}

function terragruntPlanMetadataPath(projectId: string, unitPath: string): string {
  return path.join(terragruntPlanDir(projectId, unitPath), TERRAGRUNT_PLAN_METADATA_FILENAME)
}

export function ensureTerragruntPlanFilePath(projectId: string, unitPath: string): string {
  const dir = terragruntPlanDir(projectId, unitPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return terragruntPlanFilePath(projectId, unitPath)
}

export function hasSavedTerragruntPlan(projectId: string, unitPath: string): boolean {
  return fs.existsSync(terragruntPlanFilePath(projectId, unitPath))
}

export type SavedTerragruntPlanSummary = {
  unitPath: string
  planFile: string
  savedAt: string
  sizeBytes: number
}

export function listSavedTerragruntPlans(projectId: string): SavedTerragruntPlanSummary[] {
  const projectDir = path.join(terragruntPlanRoot(), projectId)
  if (!fs.existsSync(projectDir)) return []
  const result: SavedTerragruntPlanSummary[] = []
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const planFile = path.join(projectDir, entry.name, TERRAGRUNT_PLAN_FILENAME)
    const metaFile = path.join(projectDir, entry.name, TERRAGRUNT_PLAN_METADATA_FILENAME)
    if (!fs.existsSync(planFile)) continue
    let unitPath = ''
    let savedAt = ''
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as { unitPath?: string; savedAt?: string }
      unitPath = meta.unitPath ?? ''
      savedAt = meta.savedAt ?? ''
    } catch { /* ignore */ }
    let sizeBytes = 0
    try { sizeBytes = fs.statSync(planFile).size } catch { /* ignore */ }
    result.push({ unitPath, planFile, savedAt, sizeBytes })
  }
  return result
}

export function recordTerragruntSavedPlan(projectId: string, unitPath: string): void {
  const dir = terragruntPlanDir(projectId, unitPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const metadata = {
    projectId,
    unitPath: path.resolve(unitPath),
    savedAt: new Date().toISOString()
  }
  fs.writeFileSync(terragruntPlanMetadataPath(projectId, unitPath), JSON.stringify(metadata, null, 2), 'utf-8')
}

export function clearSavedTerragruntPlan(projectId: string, unitPath: string): void {
  const dir = terragruntPlanDir(projectId, unitPath)
  if (!fs.existsSync(dir)) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

export function clearAllSavedTerragruntPlansForProject(projectId: string): void {
  const projectDir = path.join(terragruntPlanRoot(), projectId)
  if (!fs.existsSync(projectDir)) return
  try { fs.rmSync(projectDir, { recursive: true, force: true }) } catch { /* ignore */ }
}
