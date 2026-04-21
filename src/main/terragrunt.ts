import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app, type BrowserWindow } from 'electron'

import type {
  AwsConnection,
  TerraformAuditProviderId,
  TerraformCommandName,
  TerraformRunRecord,
  TerragruntCliInfo,
  TerragruntInputEntry,
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
import { pullGcsStateDirect } from './gcp/terraformState'
import { pullS3StateDirect } from './aws/terraformState'
import { pullAzureBlobStateDirect } from './azure/terraformState'
import { pullLocalStateDirect } from './terraformStateLocal'
import { type DirectStatePullResult, readBackendMeta } from './terraformStateTypes'

const NOT_INSTALLED_ERROR =
  'Terragrunt CLI not found. Install Terragrunt and ensure it is on your PATH, or set an explicit path in Settings.'

const RENDER_JSON_TIMEOUT_MS = 20000

let cachedInfo: TerragruntCliInfo | null = null

type RenderedDependency = { name: string; config_path?: string }
type RenderedTerraform = { source?: string }
type RenderedJson = {
  terraform?: RenderedTerraform
  dependency?: Record<string, RenderedDependency> | RenderedDependency[]
  dependencies?: { paths?: string[] }
  include?: Record<string, { path?: string }> | Array<{ name?: string; path?: string }>
  inputs?: Record<string, unknown>
  locals?: Record<string, unknown>
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
  // Modern Terragrunt (0.73+) uses --non-interactive; older builds accepted
  // --terragrunt-non-interactive but the new CLI forwards that straight to `terraform`, which
  // rejects it. Prefer the modern form everywhere.
  const base = ['--non-interactive', '-no-color']
  switch (command) {
    case 'init':
      return ['init', '--non-interactive']
    case 'plan':
      return ['plan', ...base]
    case 'apply':
      return ['apply', ...base, '-auto-approve']
    case 'destroy':
      return ['destroy', ...base, '-auto-approve']
    case 'state-list':
      return ['state', 'list', '--non-interactive']
    case 'state-pull':
      return ['state', 'pull', '--non-interactive']
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

type RenderJsonStrategy =
  | { kind: 'render-out' }          // `terragrunt render --format=json --out=<file>` (current CLI, 0.73+)
  | { kind: 'render-json-out' }     // `terragrunt render-json --out=<file>` (brief transitional form)
  | { kind: 'legacy-prefix' }       // `terragrunt render-json --terragrunt-json-out=<file>` (pre-0.73)
  | { kind: 'render-stdout' }       // `terragrunt render --format=json` → stdout (newest, no `--out`)
  | { kind: 'stdout' }              // `terragrunt render-json` → stdout (legacy fallback)

const RENDER_JSON_STRATEGIES: RenderJsonStrategy[] = [
  { kind: 'render-out' },
  { kind: 'render-json-out' },
  { kind: 'legacy-prefix' },
  { kind: 'render-stdout' },
  { kind: 'stdout' }
]

let cachedRenderJsonStrategy: RenderJsonStrategy | null = null

function renderJsonArgs(strategy: RenderJsonStrategy, outFile: string): string[] {
  // Modern CLI uses `--non-interactive`; older CLI accepted `--terragrunt-non-interactive` as a
  // terragrunt-specific flag. Newer versions now forward the prefixed form to terraform, which
  // explodes. Keep the non-interactive flag only on the strategies where it's known-safe, and
  // omit it entirely from the legacy-prefix / stdout probes to avoid passthrough failures.
  switch (strategy.kind) {
    case 'render-out':
      return ['render', '--format=json', `--out=${outFile}`, '--non-interactive']
    case 'render-json-out':
      return ['render-json', `--out=${outFile}`, '--non-interactive']
    case 'legacy-prefix':
      return ['render-json', `--terragrunt-json-out=${outFile}`]
    case 'render-stdout':
      return ['render', '--format=json', '--non-interactive']
    case 'stdout':
      return ['render-json']
  }
}

function isUnknownFlagError(stderr: string): boolean {
  const text = stderr.toLowerCase()
  return text.includes('flag provided but not defined')
    || text.includes('unknown flag')
    || text.includes('unknown command')
    || text.includes('unrecognized flag')
    || text.includes('is not a valid flag')
    || text.includes('is not a valid global flag')
    || text.includes('is not a valid command')
    || text.includes('did you mean')
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return trimmed
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }
  return ''
}

async function attemptRenderJson(
  strategy: RenderJsonStrategy,
  cliPath: string,
  unitPath: string,
  outFile: string,
  env: Record<string, string>
): Promise<{ ok: boolean; json: string; error: string; unknownFlag: boolean }> {
  const args = renderJsonArgs(strategy, outFile)
  const result = await invokeTerragrunt(cliPath, unitPath, args, env, RENDER_JSON_TIMEOUT_MS)
  const usesStdout = strategy.kind === 'stdout' || strategy.kind === 'render-stdout'
  if (result.exitCode !== 0) {
    const stderr = result.stderr || result.stdout
    return { ok: false, json: '', error: stderr.slice(-600), unknownFlag: isUnknownFlagError(stderr) }
  }
  if (usesStdout) {
    const json = extractJsonObject(result.stdout)
    return {
      ok: json.length > 0,
      json,
      error: json ? '' : 'no JSON payload on stdout',
      unknownFlag: false
    }
  }
  try {
    const raw = fs.readFileSync(outFile, 'utf-8')
    return { ok: raw.trim().length > 0, json: raw, error: raw ? '' : 'empty output file', unknownFlag: false }
  } catch (err) {
    return { ok: false, json: '', error: (err as Error).message, unknownFlag: false }
  }
}

async function invokeRenderJson(
  cliPath: string,
  unitPath: string,
  outFile: string,
  env: Record<string, string>
): Promise<string> {
  const errors: string[] = []

  // If we already know which flag-form this Terragrunt accepts, try it first. A non-flag failure
  // (bad config, missing creds) is almost certainly a real error for this unit — surface it
  // immediately instead of cycling through every other form and returning a confusing chain.
  if (cachedRenderJsonStrategy) {
    const attempt = await attemptRenderJson(cachedRenderJsonStrategy, cliPath, unitPath, outFile, env)
    if (attempt.ok) return attempt.json
    errors.push(`[${cachedRenderJsonStrategy.kind}] ${attempt.error}`)
    if (!attempt.unknownFlag) {
      throw new Error(`terragrunt render-json failed: ${errors.join(' | ')}`)
    }
    // Cached strategy no longer recognised — Terragrunt may have been upgraded. Fall through and
    // probe all strategies to rediscover the working form.
  }

  for (const strategy of RENDER_JSON_STRATEGIES) {
    if (cachedRenderJsonStrategy && strategy.kind === cachedRenderJsonStrategy.kind) continue
    const attempt = await attemptRenderJson(strategy, cliPath, unitPath, outFile, env)
    if (attempt.ok) {
      cachedRenderJsonStrategy = strategy
      return attempt.json
    }
    errors.push(`[${strategy.kind}] ${attempt.error}`)
  }
  throw new Error(`terragrunt render-json failed across all strategies: ${errors.join(' | ')}`)
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
    const raw = await invokeRenderJson(info.path, unitPath, outFile, env)
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

function summarizeInputValue(value: unknown): TerragruntInputEntry['valueSummary'] {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const preview = value.slice(0, 5).map((v) => summarizeInputValue(v)).join(', ')
    return value.length > 5 ? `[${preview}, +${value.length - 5} more]` : `[${preview}]`
  }
  try {
    const json = JSON.stringify(value)
    return json.length > 160 ? `${json.slice(0, 157)}…` : json
  } catch {
    return '[unserialisable value]'
  }
}

function classifyInputValueType(value: unknown): TerragruntInputEntry['valueType'] {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'list'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  if (t === 'object') return 'object'
  return 'unknown'
}

const SENSITIVE_NAME_PATTERN = /(password|secret|token|private_key|api_key|credentials?)$/i

function buildInputEntries(raw: Record<string, unknown> | undefined): TerragruntInputEntry[] {
  if (!raw) return []
  return Object.entries(raw)
    .map(([name, value]) => ({
      name,
      valueSummary: summarizeInputValue(value),
      valueType: classifyInputValueType(value),
      isSensitive: SENSITIVE_NAME_PATTERN.test(name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
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

  next.inputs = buildInputEntries(json.inputs)

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

const RESOLVE_CONCURRENCY = 4

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers: Promise<void>[] = []
  const workerCount = Math.min(limit, Math.max(1, items.length))
  for (let w = 0; w < workerCount; w += 1) {
    workers.push((async () => {
      while (true) {
        const idx = cursor
        cursor += 1
        if (idx >= items.length) return
        results[idx] = await mapper(items[idx], idx)
      }
    })())
  }
  await Promise.all(workers)
  return results
}

export async function resolveStack(rootPath: string): Promise<ResolvedStack> {
  const discovery = scanForTerragrunt(rootPath)
  const info = await detectTerragruntCli()
  const cliAvailable = info.found
  const resolveErrors: Array<{ unitPath: string; error: string }> = []

  let units: TerragruntUnit[] = discovery.units
  let rootConfig: TerragruntUnit | null = discovery.rootConfig ?? null
  if (cliAvailable) {
    if (units.length > 0) {
      // First unit serially so its probe can populate cachedRenderJsonStrategy before we fan out.
      const [head, ...tail] = units
      const headResolved = await resolveSingleUnit(head, resolveErrors)
      const tailResolved = tail.length > 0
        ? await mapWithConcurrency(tail, RESOLVE_CONCURRENCY, (u) => resolveSingleUnit(u, resolveErrors))
        : []
      units = [headResolved, ...tailResolved]
    }
    if (rootConfig) {
      rootConfig = await resolveSingleUnit(rootConfig, resolveErrors)
    }
  } else {
    units = applyStaticResolution(units)
    if (rootConfig) {
      rootConfig = applyStaticResolution([rootConfig])[0]
    }
  }

  const { dependencyOrder, cycles } = buildDependencyGraph(units)

  return {
    stack: {
      stackRoot: discovery.stackRoot || path.resolve(rootPath),
      units,
      dependencyOrder,
      cycles,
      rootConfig
    },
    cliAvailable,
    resolveErrors
  }
}

/* ── run-all orchestration ───────────────────────────────── */

async function resolveSingleUnit(
  unit: TerragruntUnit,
  resolveErrors: Array<{ unitPath: string; error: string }>
): Promise<TerragruntUnit> {
  try {
    const json = await renderUnitJson(unit.unitPath)
    return applyRenderedResolution(unit, json)
  } catch (err) {
    const message = (err as Error).message
    resolveErrors.push({ unitPath: unit.unitPath, error: message })
    return {
      ...unit,
      resolveError: message,
      dependencies: unit.dependencies.map((d) => ({
        ...d,
        resolvedPath: d.resolvedPath || resolveStaticDependencyPath(unit, d.configPath)
      }))
    }
  }
}

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
  /** Optional set of absolute unit paths to include. Units outside this set are skipped. */
  unitFilter?: string[]
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

function reverseDependencyMap(forward: Map<string, Set<string>>): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>()
  for (const node of forward.keys()) reverse.set(node, new Set())
  for (const [node, deps] of forward) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set())
      reverse.get(dep)!.add(node)
    }
  }
  return reverse
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

function runUnitTimeoutMs(command: TerragruntRunAllCommand): number {
  switch (command) {
    case 'plan': return 15 * 60 * 1000
    case 'apply':
    case 'destroy': return 30 * 60 * 1000
    default: return 15 * 60 * 1000
  }
}

function classifyUnitRunError(command: TerragruntRunAllCommand, errorText: string): string {
  const low = errorText.toLowerCase()
  if (low.includes('detected no outputs') || low.includes('there is no variable named "dependency"')) {
    return [
      '[InfraLens] This unit references a `dependency` whose upstream has no state — either it was never applied, or its state file is empty.',
      `For 'run-all ${command}' to work across an unapplied stack, add \`mock_outputs = { ... }\` (and \`mock_outputs_allowed_terraform_commands = ["plan", "validate"]\`) to the dependency block. Otherwise, apply the upstream units first, then re-run.`,
      '',
      errorText
    ].join('\n')
  }
  if (low.includes('resourceinuseByanotherresource') || low.includes('resource in use') || low.includes('is already being used')) {
    return [
      '[InfraLens] Destroy failed because another resource still references this one.',
      'This usually means leaf units (VMs, firewalls) weren\'t torn down before their upstream (subnets, VPCs). InfraLens runs destroy phase-N → 0; if a unit was skipped or failed upstream, re-run destroy to let the failed parent retry.',
      '',
      errorText
    ].join('\n')
  }
  return errorText
}

function runUnitProcess(params: {
  binary: string
  args: string[]
  env: Record<string, string>
  unitPath: string
  command: TerragruntRunAllCommand
  onOutput: (chunk: string) => void
  active: ActiveRunAll
  timeoutMs: number
}): Promise<{ exitCode: number; error: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    if (params.active.cancelled) {
      resolve({ exitCode: 130, error: 'cancelled before start', timedOut: false })
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
    let timedOut = false
    let settled = false
    const timer = params.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          terminateRunAllChild(child)
        }, params.timeoutMs)
      : null
    const finish = (result: { exitCode: number; error: string; timedOut: boolean }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      params.active.children.delete(child)
      resolve(result)
    }
    child.stdout.on('data', (buf) => params.onOutput(buf.toString()))
    child.stderr.on('data', (buf) => {
      const chunk = buf.toString()
      errorText += chunk
      params.onOutput(chunk)
    })
    child.on('error', (err) => {
      finish({ exitCode: -1, error: err.message, timedOut })
    })
    child.on('close', (code) => {
      const rawError = timedOut
        ? `unit timed out after ${Math.round(params.timeoutMs / 1000)}s`
        : errorText.slice(-2000)
      const error = timedOut ? rawError : classifyUnitRunError(params.command, rawError)
      finish({ exitCode: code ?? -1, error, timedOut })
    })
  })
}

// Parse a single key-value log line terragrunt emits with `--log-format=key-value`.
// Terragrunt's output looks like `time=... level=stdout prefix=/abs/path msg=Destroy complete!`
// — the `msg=` value is frequently UNQUOTED and contains spaces, so a naive `\S+` capture
// truncates it to the first word. An unquoted value therefore extends until the next
// ` <key>=` pattern or end of line, not just the next whitespace.
function parseTerragruntKeyValueLine(line: string): { prefix: string; display: string } | null {
  const trimmed = line.replace(/\r$/, '')
  if (!trimmed) return null

  const fields = new Map<string, string>()
  let i = 0
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1
    if (i >= trimmed.length) break

    const keyStart = i
    while (i < trimmed.length && /[\w.-]/.test(trimmed[i])) i += 1
    const key = trimmed.slice(keyStart, i)
    if (!key || trimmed[i] !== '=') {
      while (i < trimmed.length && !/\s/.test(trimmed[i])) i += 1
      continue
    }
    i += 1 // consume '='

    let value = ''
    if (trimmed[i] === '"') {
      i += 1
      const valStart = i
      while (i < trimmed.length) {
        if (trimmed[i] === '\\' && i + 1 < trimmed.length) { i += 2; continue }
        if (trimmed[i] === '"') break
        i += 1
      }
      value = trimmed.slice(valStart, i).replace(/\\(.)/g, '$1')
      if (trimmed[i] === '"') i += 1
    } else {
      // Unquoted — extend until we hit ` <word>=` or end of line.
      const valStart = i
      while (i < trimmed.length) {
        if (/\s/.test(trimmed[i])) {
          let j = i
          while (j < trimmed.length && /\s/.test(trimmed[j])) j += 1
          const peekStart = j
          while (j < trimmed.length && /[\w.-]/.test(trimmed[j])) j += 1
          if (j > peekStart && trimmed[j] === '=') break
        }
        i += 1
      }
      value = trimmed.slice(valStart, i).trimEnd()
    }
    fields.set(key, value)
  }

  const prefix = fields.get('prefix') ?? ''
  if (!fields.has('msg') && !fields.has('level') && !prefix) return null
  const level = fields.get('level') ?? ''
  const msg = fields.get('msg') ?? ''
  const display = level ? `${level.toUpperCase().padEnd(5)} ${msg}` : msg
  return { prefix, display }
}

function runNativeRunAllDestroy(params: {
  binary: string
  env: Record<string, string>
  window: BrowserWindow | null
  runId: string
  identity: RunAllHistoryIdentity
  active: ActiveRunAll
  stack: TerragruntStack
  phases: string[][]
  timeoutMs: number
}): Promise<{
  succeeded: Set<string>
  failed: Set<string>
  blocked: Set<string>
  cancelled: Set<string>
}> {
  return new Promise((resolve) => {
    const { binary, env, window, runId, identity, active, stack, phases, timeoutMs } = params

    // `terragrunt run --all destroy` at the stack root (formerly `run-all destroy`, renamed
    // in 0.73+). The run-all form is required because per-unit `terragrunt destroy` fails to
    // resolve `dependency.<x>.outputs.*` references when the upstream hasn't been applied or
    // its state isn't reachable from the unit's cwd; the run-all path parses the full
    // dependency graph and handles this uniformly.
    //
    // `--log-format=key-value --log-show-abs-paths` forces parseable output where each line
    // carries a `prefix=<absolute-unit-path>` field, which we use to route output to the
    // right unit in the UI.
    const args = [
      'run', '--all',
      '--non-interactive',
      '--log-format=key-value',
      '--log-show-abs-paths',
      '--',
      'destroy',
      '-auto-approve'
    ]
    const child = spawn(binary, args, { cwd: stack.stackRoot, env, shell: false, windowsHide: true })
    active.children.add(child)

    const succeeded = new Set<string>()
    const failed = new Set<string>()
    const cancelled = new Set<string>()
    const blocked = new Set<string>()

    const phaseByUnit = new Map<string, number>()
    phases.forEach((phase, idx) => {
      for (const unit of phase) phaseByUnit.set(unit, idx)
    })

    // Emit unit-started for every unit upfront. run-all destroy doesn't stream per-unit
    // start events, so we anchor the UI to all expected units immediately; that way
    // progress is visible even if a unit never produces any prefix-tagged log line.
    //
    // `sawCompletion` / `sawUnitError` track per-unit success signals from prefix-routed
    // lines only — broadcast stack-level chatter (including the word "error" in TIP messages
    // or diagnostics that don't belong to this unit) does not flip these flags, which was
    // the root cause of every unit being marked failed after a successful destroy.
    const unitRecords = new Map<string, {
      unitRunId: string
      startedAt: string
      output: string
      phase: number
      sawCompletion: boolean
      sawUnitError: boolean
    }>()
    for (const unitPath of stack.units.map((u) => u.unitPath)) {
      const unitRunId = randomUUID()
      const startedAt = new Date().toISOString()
      const phase = phaseByUnit.get(unitPath) ?? 0
      unitRecords.set(unitPath, { unitRunId, startedAt, output: '', phase, sawCompletion: false, sawUnitError: false })
      const record = makeRunRecord({
        id: unitRunId,
        stackRoot: stack.stackRoot,
        unitPath,
        phase,
        command: 'destroy',
        args,
        identity,
        startedAt
      })
      saveRunRecord(record, '')
      emitRunAllEvent(window, { type: 'unit-started', runId, unitPath, phase, unitRunId })
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => terminateRunAllChild(child), timeoutMs)
      : null

    // Completion and error markers emitted by terraform (not terragrunt wrappers). These
    // only flip the per-unit success flags when seen in *prefix-routed* output — broadcast
    // stack chatter does not contribute to per-unit outcome.
    const COMPLETION_RE = /(?:destroy complete!|apply complete!|no changes\.|no objects need to be destroyed)/i
    const UNIT_ERROR_RE = /^\s*(?:│\s*)?error:/i

    let leftover = ''
    const routeLine = (rawLine: string): void => {
      const parsed = parseTerragruntKeyValueLine(rawLine)
      if (!parsed) return
      const prefix = parsed.prefix ? path.resolve(parsed.prefix) : ''
      const chunk = parsed.display + '\n'
      if (prefix && unitRecords.has(prefix)) {
        const rec = unitRecords.get(prefix)!
        rec.output += chunk
        if (rec.output.length > 500_000) rec.output = rec.output.slice(-500_000)
        if (COMPLETION_RE.test(parsed.display)) rec.sawCompletion = true
        if (UNIT_ERROR_RE.test(parsed.display)) rec.sawUnitError = true
        emitRunAllEvent(window, { type: 'unit-output', runId, unitPath: prefix, chunk })
        return
      }
      // Stack-level message (no prefix, or prefix not in our known units). Broadcast to
      // every in-scope unit so early errors are visible; they'll be deduped naturally
      // since we cap each unit's output buffer. Do NOT touch sawCompletion/sawUnitError
      // here — those are per-unit signals tied to prefix-routed lines only.
      for (const [unitPath, rec] of unitRecords) {
        rec.output += chunk
        if (rec.output.length > 500_000) rec.output = rec.output.slice(-500_000)
        emitRunAllEvent(window, { type: 'unit-output', runId, unitPath, chunk })
      }
    }

    const processText = (text: string): void => {
      const combined = leftover + text
      const lines = combined.split(/\r?\n/)
      leftover = lines.pop() ?? ''
      for (const line of lines) routeLine(line)
    }

    child.stdout.on('data', (buf) => processText(buf.toString()))
    child.stderr.on('data', (buf) => processText(buf.toString()))

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      active.children.delete(child)
      const spawnMsg = `\n─── InfraLens: terragrunt run-all destroy spawn error ───\n${err.message}\n`
      for (const [unitPath, rec] of unitRecords) {
        rec.output += spawnMsg
        emitRunAllEvent(window, { type: 'unit-output', runId, unitPath, chunk: spawnMsg })
        failed.add(unitPath)
        emitRunAllEvent(window, { type: 'unit-completed', runId, unitPath, exitCode: -1, success: false })
      }
      resolve({ succeeded, failed, blocked, cancelled })
    })

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      active.children.delete(child)
      if (leftover.trim()) routeLine(leftover)
      const overallOk = code === 0
      for (const [unit, rec] of unitRecords) {
        const startedAtMs = Date.parse(rec.startedAt)
        const finishedAt = new Date().toISOString()
        const durationMs = Date.parse(finishedAt) - (Number.isFinite(startedAtMs) ? startedAtMs : Date.now())
        // Unit-level outcome is derived from prefix-routed markers, not from the shared
        // `rec.output` buffer (which pollutes every unit with stack-level error chatter).
        // A unit is successful if terraform emitted a completion line for it and no error
        // line was routed to it. Fall back to the overall exit code when the unit never
        // produced any routed lines — e.g. it was blocked by an upstream failure.
        const unitProducedSignal = rec.sawCompletion || rec.sawUnitError
        const unitSucceeded = unitProducedSignal
          ? rec.sawCompletion && !rec.sawUnitError
          : overallOk
        if (active.cancelled) {
          cancelled.add(unit)
          updateRunRecord(rec.unitRunId, { finishedAt, exitCode: 130, success: false, durationMs }, rec.output)
          emitRunAllEvent(window, { type: 'unit-cancelled', runId, unitPath: unit })
        } else if (unitSucceeded) {
          succeeded.add(unit)
          updateRunRecord(rec.unitRunId, { finishedAt, exitCode: 0, success: true, durationMs }, rec.output)
          emitRunAllEvent(window, { type: 'unit-completed', runId, unitPath: unit, exitCode: 0, success: true })
        } else {
          failed.add(unit)
          const classified = classifyTerraformError({
            output: rec.output,
            exitCode: code ?? -1,
            errorMessage: rec.output.slice(-500),
            provider: identity.provider,
            errorName: ''
          })
          const hint = classifyUnitRunError('destroy', rec.output.slice(-2000))
          if (hint && !rec.output.includes(hint)) {
            const banner = `\n─── InfraLens diagnosis ───\n${hint}\n`
            rec.output += banner
            emitRunAllEvent(window, { type: 'unit-output', runId, unitPath: unit, chunk: banner })
          }
          updateRunRecord(rec.unitRunId, {
            finishedAt,
            exitCode: code ?? -1,
            success: false,
            durationMs,
            errorClass: classified.errorClass,
            suggestedAction: classified.suggestedAction
          }, rec.output)
          emitRunAllEvent(window, { type: 'unit-completed', runId, unitPath: unit, exitCode: code ?? -1, success: false })
        }
      }
      resolve({ succeeded, failed, blocked, cancelled })
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
  const forwardDepsMap = buildDependencyMap(options.stack.units)
  // For destroy, a unit is blocked by failures on its *dependents* (downstream), not its
  // dependencies: if a VM fails to destroy, its subnet still has an in-use reference and must
  // wait. Flip the edges in destroy mode.
  const depsMap: Map<string, Set<string>> = options.command === 'destroy'
    ? reverseDependencyMap(forwardDepsMap)
    : forwardDepsMap
  const filterSet = options.unitFilter && options.unitFilter.length > 0
    ? new Set(options.unitFilter.map((p) => path.resolve(p)))
    : null
  const orderedPhases = filterSet
    ? options.stack.dependencyOrder
        .map((phase) => phase.filter((unitPath) => filterSet.has(unitPath)))
        .filter((phase) => phase.length > 0)
    : options.stack.dependencyOrder
  // Destroy must run leaf-first: a subnet can't be deleted while a VM in a later phase still
  // references it. Apply/plan keep the natural dependency order (phase 0 → N); destroy flips
  // to (phase N → 0). Units within a phase can still run in parallel — they're independent by
  // definition of the topological sort.
  const phases = options.command === 'destroy'
    ? [...orderedPhases].reverse()
    : orderedPhases

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

  let succeeded = new Set<string>()
  let failed = new Set<string>()
  let blocked = new Set<string>()
  let cancelled = new Set<string>()

  // Destroy goes through `terragrunt run --all destroy` natively so we inherit terragrunt's
  // cross-unit dependency-output resolution (per-unit `terragrunt destroy` fails with
  // "There is no variable named 'dependency'" when a unit references an upstream's outputs
  // and the upstream's state can't be read from the unit's cwd).
  //
  // Native run-all, however, ignores our unit filter — it will tear down every unit in the
  // stack. So only take the native path when the user has "All environments" selected; if a
  // filter is set, fall back to per-unit destroy to respect the user's scope.
  if (options.command === 'destroy' && !filterSet) {
    active.done = (async () => {
      try {
        const result = await runNativeRunAllDestroy({
          binary,
          env: options.env,
          window: options.window,
          runId,
          identity: options.identity,
          active,
          stack: options.stack,
          phases,
          timeoutMs: 4 * 60 * 60 * 1000
        })
        succeeded = result.succeeded
        failed = result.failed
        blocked = new Set([...blocked, ...result.blocked])
        cancelled = result.cancelled
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
            timeoutMs: runUnitTimeoutMs(options.command),
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
              // Append the classified hint to the streamed output so the UI monitor picks it
              // up alongside the raw terragrunt / terraform error.
              if (result.error && !outputBuffer.includes(result.error)) {
                const banner = `\n─── InfraLens diagnosis ───\n${result.error}\n`
                outputBuffer += banner
                emitRunAllEvent(options.window, { type: 'unit-output', runId, unitPath, chunk: banner })
              }
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

/* ── Effective working directory & state pull ────────────── */

const STATE_PULL_TIMEOUT_MS = 90000
const INIT_TIMEOUT_MS = 10 * 60 * 1000

function terragruntCacheDir(unitPath: string): string {
  return path.join(unitPath, '.terragrunt-cache')
}

export function resolveTerragruntWorkingDirectory(unitPath: string): string {
  const cache = terragruntCacheDir(unitPath)
  if (!fs.existsSync(cache)) return ''

  const visited = new Set<string>()
  const queue: string[] = [cache]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    const hasTfFiles = entries.some((e) => e.isFile() && e.name.endsWith('.tf'))
    if (hasTfFiles) return current
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name))
    }
  }
  return ''
}

async function invokeTerragrunt(
  cliPath: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve) => {
    const child = spawn(cliPath, args, { cwd, env, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolve({ stdout, stderr: stderr + '\n[infralens] terragrunt invocation timed out', exitCode: -1 })
    }, timeoutMs)
    child.stdout.on('data', (buf) => { stdout += buf.toString() })
    child.stderr.on('data', (buf) => { stderr += buf.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: -1 })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}

export async function ensureTerragruntUnitInitialized(
  unitPath: string,
  env: Record<string, string>
): Promise<{ ok: boolean; workingDir: string; error: string }> {
  if (!fs.existsSync(path.join(unitPath, 'terragrunt.hcl'))) {
    return { ok: false, workingDir: '', error: 'No terragrunt.hcl at unit path.' }
  }
  let workingDir = resolveTerragruntWorkingDirectory(unitPath)
  if (!workingDir) {
    const info = cachedInfo ?? await detectTerragruntCli()
    if (!info.found) return { ok: false, workingDir: '', error: NOT_INSTALLED_ERROR }
    const result = await invokeTerragrunt(info.path, unitPath, ['init', '--non-interactive', '-no-color'], env, INIT_TIMEOUT_MS)
    if (result.exitCode !== 0) {
      return { ok: false, workingDir: '', error: (result.stderr || result.stdout || 'terragrunt init failed').slice(-500) }
    }
    workingDir = resolveTerragruntWorkingDirectory(unitPath)
  }
  return workingDir ? { ok: true, workingDir, error: '' } : { ok: false, workingDir: '', error: 'Terragrunt cache not found after init.' }
}

function extractStatePayload(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  // Terragrunt prints log lines before the state JSON on stdout (timestamp + level + message).
  // Find the first `{` that opens the state object and the last `}` that closes it. That brackets
  // the JSON payload no matter how much terragrunt chatter precedes it.
  if (trimmed.startsWith('{')) return trimmed
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return ''
  return trimmed.slice(start, end + 1)
}

async function runTerraformInCache(
  workingDir: string,
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Try terraform on PATH — terragrunt requires it to be there anyway, and it sidesteps
  // terragrunt's log interleaving on stdout.
  const binary = process.platform === 'win32' ? 'terraform.exe' : 'terraform'
  return await invokeTerragrunt(binary, workingDir, args, env, STATE_PULL_TIMEOUT_MS)
}

/**
 * Scan `.tf` files under the terragrunt cache's working dir and synthesize a type-appropriate
 * placeholder value for every `variable "..."` block that has no `default = ...`.
 *
 * Terraform refuses to run *any* command — including `state pull` — when a required variable
 * has no value, even though state pull never evaluates user config. When terragrunt can't
 * compute its `inputs` (e.g. a `dependency` output is unresolved), the cache has no tfvars
 * and terraform errors out. Feeding dummy values via `TF_VAR_<name>` lets validation pass.
 *
 * Empty strings are unreliable — on Windows / via Node's spawn, an env var set to ""
 * effectively disappears from the child's environment, so terraform still reports the
 * variable as unset. The placeholder for strings is therefore non-empty; for other types
 * we pick literal values that satisfy terraform's type check.
 */
function collectRequiredVariablePlaceholders(workingDir: string): Record<string, string> {
  const result: Record<string, string> = {}
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workingDir, { withFileTypes: true })
  } catch {
    return result
  }
  const variableBlockRe = /variable\s+"([^"]+)"\s*\{([\s\S]*?)^\}/gm
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tf')) continue
    let source: string
    try {
      source = fs.readFileSync(path.join(workingDir, entry.name), 'utf-8')
    } catch {
      continue
    }
    let match: RegExpExecArray | null
    while ((match = variableBlockRe.exec(source)) !== null) {
      const name = match[1]
      const body = match[2]
      if (/^\s*default\s*=/m.test(body)) continue
      const typeMatch = body.match(/^\s*type\s*=\s*([^\n]+)/m)
      const typeExpr = typeMatch ? typeMatch[1].trim() : 'string'
      result[name] = placeholderForTerraformType(typeExpr)
    }
  }
  return result
}

function placeholderForTerraformType(typeExpr: string): string {
  const low = typeExpr.toLowerCase()
  if (low.startsWith('number')) return '0'
  if (low.startsWith('bool')) return 'false'
  if (low.startsWith('list') || low.startsWith('tuple') || low.startsWith('set')) return '[]'
  if (low.startsWith('map') || low.startsWith('object')) return '{}'
  return '__infralens_placeholder__'
}

/**
 * Translate noisy terragrunt/terraform stderr into a one-screen, actionable message when the
 * failure pattern matches something we recognise. Returns empty string if nothing matches,
 * in which case the caller falls through to dumping the raw output.
 */
function classifyStatePullFailure(terragruntStderr: string, terraformStderr: string): string {
  const combined = `${terragruntStderr}\n${terraformStderr}`
  const depMissing = /detected no outputs/i.test(combined) || /unresolved dependency outputs/i.test(combined)
  if (depMissing) {
    const depMatch = terragruntStderr.match(/([^\s"]*[\\/][^\s"]+terragrunt\.hcl)\s+is a dependency of/i)
    const depPath = depMatch ? depMatch[1] : ''
    return [
      'State pull aborted: an upstream dependency has no outputs yet.',
      depPath ? `Missing outputs from: ${depPath}` : '',
      '',
      'Terragrunt refuses to resolve `dependency.*.outputs` until the upstream unit has been',
      'applied. For state-read commands you can bypass this by adding `"state"`, `"show"`, and',
      '`"output"` to `mock_outputs_allowed_terraform_commands` in the `dependency` block — then',
      'the mock values are fed to terraform and state pull goes straight to the backend.',
      '',
      'Alternatively: apply the upstream unit first, then pull state for this one.'
    ].filter(Boolean).join('\n')
  }
  if (/No value for required variable/i.test(terraformStderr)) {
    const varMatch = terraformStderr.match(/input variable "([^"]+)"/i)
    const varName = varMatch ? varMatch[1] : ''
    return [
      varName
        ? `State pull aborted: terraform rejected placeholder for variable "${varName}".`
        : 'State pull aborted: terraform rejected the placeholder variables.',
      '',
      'The placeholder .auto.tfvars.json and TF_VAR_* env vars were both injected but terraform',
      'did not accept them. This usually means the unit has never been applied and the backend',
      'state object does not exist yet — run apply first, then pull again.'
    ].join('\n')
  }
  return ''
}

export async function pullTerragruntState(
  unitPath: string,
  env: Record<string, string>,
  connection?: AwsConnection,
  unitDir?: string
): Promise<{ stateJson: string; workingDir: string; error: string }> {
  const info = cachedInfo ?? await detectTerragruntCli()
  if (!info.found) return { stateJson: '', workingDir: '', error: NOT_INSTALLED_ERROR }
  const prepared = await ensureTerragruntUnitInitialized(unitPath, env)
  if (!prepared.ok) return { stateJson: '', workingDir: '', error: prepared.error }

  // Terraform refuses to run `state pull` (or any command) when a required input variable has
  // no value — even though state pull never evaluates user config. When terragrunt couldn't
  // compute its `inputs` (e.g. a `dependency` output isn't available), the cache has no
  // tfvars and every attempt errors with "No value for required variable".
  //
  // Belt-and-suspenders: write a `.auto.tfvars.json` file directly inside the cache's working
  // dir (terraform auto-loads `*.auto.tfvars.json` in the module directory) AND also set
  // TF_VAR_<name> env vars. Some terraform builds don't auto-load the file when invoked for
  // state commands, so the env vars provide a second source of truth. Deleted after the pull.
  const placeholderTfvarsPath = prepared.workingDir
    ? path.join(prepared.workingDir, 'infralens_placeholders.auto.tfvars.json')
    : ''
  const injectedPlaceholders: string[] = []
  let placeholderWriteError = ''
  const placeholderEnv: Record<string, string> = {}
  if (placeholderTfvarsPath) {
    const placeholderValues: Record<string, unknown> = {}
    for (const [varName, placeholder] of Object.entries(collectRequiredVariablePlaceholders(prepared.workingDir))) {
      // Translate the string placeholder into the JSON value terraform expects for that type.
      // Strings pass through; non-strings parse the placeholder literal (`0`, `false`, `[]`, `{}`).
      try {
        placeholderValues[varName] = placeholder.startsWith('__') ? placeholder : JSON.parse(placeholder)
      } catch {
        placeholderValues[varName] = placeholder
      }
      injectedPlaceholders.push(`${varName}=${placeholder}`)
      placeholderEnv[`TF_VAR_${varName}`] = placeholder
    }
    if (injectedPlaceholders.length > 0) {
      try {
        fs.writeFileSync(placeholderTfvarsPath, JSON.stringify(placeholderValues, null, 2), 'utf-8')
        placeholderWriteError = fs.existsSync(placeholderTfvarsPath)
          ? ''
          : 'writeFileSync returned but file does not exist on disk'
      } catch (err) {
        placeholderWriteError = (err as Error).message
      }
    }
  }
  const augmentedEnv = { ...env, ...placeholderEnv }

  try {
    // Strategy 0: direct backend fetch. Reads the resolved backend config from
    // `.terraform/terraform.tfstate` (populated by `terragrunt init`) and GETs the state
    // object from the matching cloud (GCS/S3/Azure Blob) or reads the local file.
    // Sidesteps terragrunt's config evaluation entirely — no dependency resolution, no
    // variable validation, no mock_outputs gymnastics. A direct-fetch failure ('error')
    // falls through to the terragrunt/terraform subprocess strategies below, which may
    // succeed under different auth or by resolving the config that blocked us here.
    if (prepared.workingDir) {
      const meta = readBackendMeta(prepared.workingDir)
      const localDir = unitDir ?? unitPath
      let direct: DirectStatePullResult | null = null
      switch (meta?.type) {
        case 'gcs':
          direct = await pullGcsStateDirect(prepared.workingDir)
          break
        case 's3':
          if (connection) direct = await pullS3StateDirect(prepared.workingDir, connection)
          break
        case 'azurerm':
          direct = await pullAzureBlobStateDirect(prepared.workingDir)
          break
        case 'local':
          direct = await pullLocalStateDirect(prepared.workingDir, localDir)
          break
        default:
          // No backend metadata (no `.terraform/terraform.tfstate`) or an unrecognized
          // backend type — probe for a local state file anyway. Many first-time-run
          // setups and `backend = "local"` units without explicit init land here.
          direct = await pullLocalStateDirect(prepared.workingDir, localDir)
          break
      }
      if (direct?.kind === 'ok') {
        return { stateJson: direct.stateJson, workingDir: prepared.workingDir, error: '' }
      }
      if (direct?.kind === 'empty') {
        return {
          stateJson: '',
          workingDir: prepared.workingDir,
          error: [
            'No state found in the backend yet — this unit has never been applied.',
            'Run apply on this unit (or its upstream dependencies) first, then pull again.'
          ].join('\n')
        }
      }
      // kind === 'backend-mismatch' | 'backend-unknown' | 'error' — fall through.
    }

    // Strategy 1: legacy `terragrunt state pull --non-interactive`. Pre-0.73 and still works on
    // newer CLIs via command forwarding, but stdout has log lines interleaved with JSON.
    const tgLegacy = await invokeTerragrunt(info.path, unitPath, ['state', 'pull', '--non-interactive'], augmentedEnv, STATE_PULL_TIMEOUT_MS)
    if (tgLegacy.exitCode === 0) {
      const payload = extractStatePayload(tgLegacy.stdout)
      if (payload) return { stateJson: payload, workingDir: prepared.workingDir, error: '' }
    }

    // Strategy 2: modern `terragrunt run -- state pull` (0.73+). The `--` separator keeps the
    // state/pull tokens from being parsed by terragrunt itself.
    const tgRun = await invokeTerragrunt(info.path, unitPath, ['run', '--non-interactive', '--', 'state', 'pull'], augmentedEnv, STATE_PULL_TIMEOUT_MS)
    if (tgRun.exitCode === 0) {
      const payload = extractStatePayload(tgRun.stdout)
      if (payload) return { stateJson: payload, workingDir: prepared.workingDir, error: '' }
    }

    // Strategy 3: call `terraform state pull` directly inside the terragrunt-materialised cache
    // dir. Avoids terragrunt log interleaving entirely.
    if (prepared.workingDir) {
      // Re-assert the placeholder tfvars before terraform runs. The terragrunt strategies above
      // may have triggered cache regeneration (terragrunt's init wipes anything that isn't in
      // the source module), so our .auto.tfvars.json could be gone by now.
      let placeholderFileExists = false
      if (placeholderTfvarsPath && injectedPlaceholders.length > 0) {
        try {
          const placeholderValues: Record<string, unknown> = {}
          for (const [varName, placeholder] of Object.entries(collectRequiredVariablePlaceholders(prepared.workingDir))) {
            try {
              placeholderValues[varName] = placeholder.startsWith('__') ? placeholder : JSON.parse(placeholder)
            } catch {
              placeholderValues[varName] = placeholder
            }
          }
          fs.writeFileSync(placeholderTfvarsPath, JSON.stringify(placeholderValues, null, 2), 'utf-8')
          placeholderFileExists = fs.existsSync(placeholderTfvarsPath)
          if (!placeholderWriteError && !placeholderFileExists) {
            placeholderWriteError = 'file missing after re-write before terraform state pull'
          }
        } catch (err) {
          if (!placeholderWriteError) placeholderWriteError = (err as Error).message
        }
      }

      const tfResult = await runTerraformInCache(prepared.workingDir, ['state', 'pull'], augmentedEnv)
      if (tfResult.exitCode === 0) {
        const payload = extractStatePayload(tfResult.stdout)
        if (payload) return { stateJson: payload, workingDir: prepared.workingDir, error: '' }
        // Exit 0 with empty stdout means the backend either has no state object yet (unit never
        // applied) or returned an empty body. Surface both stdout + stderr so the user can tell.
        return {
          stateJson: '',
          workingDir: prepared.workingDir,
          error: [
            'No state found in the backend yet — this unit has never been applied.',
            'Run apply on this unit (or its upstream dependencies) first, then pull again.'
          ].join('\n')
        }
      }

      const tgCombinedStderr = [tgLegacy.stderr, tgRun.stderr].filter(Boolean).join('\n').trim()
      const tfStderr = tfResult.stderr.trim()
      const classified = classifyStatePullFailure(tgCombinedStderr, tfStderr)
      if (classified) {
        return { stateJson: '', workingDir: prepared.workingDir, error: classified }
      }
      return {
        stateJson: '',
        workingDir: prepared.workingDir,
        error: [
          `State pull failed (terragrunt exit ${tgLegacy.exitCode}/${tgRun.exitCode}, terraform exit ${tfResult.exitCode}).`,
          '',
          `── placeholder tfvars injected (${injectedPlaceholders.length}) ──`,
          injectedPlaceholders.length > 0 ? injectedPlaceholders.join(', ') : '(none)',
          `file: ${placeholderTfvarsPath || '(not written)'}`,
          `exists-before-terraform: ${placeholderFileExists}`,
          placeholderWriteError ? `write-error: ${placeholderWriteError}` : '',
          '',
          '── terraform state pull stderr ──',
          tfStderr || tfResult.stdout.trim() || '(empty)',
          '',
          '── terragrunt state pull stderr ──',
          tgCombinedStderr || '(empty)'
        ].filter(Boolean).join('\n')
      }
    }

    const classified = classifyStatePullFailure([tgLegacy.stderr, tgRun.stderr].filter(Boolean).join('\n').trim(), '')
    return {
      stateJson: '',
      workingDir: prepared.workingDir,
      error: classified || [
        `State pull failed (terragrunt exit ${tgLegacy.exitCode}).`,
        '',
        tgLegacy.stderr.trim() || tgLegacy.stdout.trim() || '(no output)'
      ].join('\n')
    }
  } finally {
    if (placeholderTfvarsPath) {
      try { fs.unlinkSync(placeholderTfvarsPath) } catch { /* ignore */ }
    }
  }
}
