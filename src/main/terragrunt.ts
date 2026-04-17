import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'

import { app } from 'electron'

import type { TerraformCommandName, TerragruntCliInfo, TerragruntStack, TerragruntUnit } from '@shared/types'
import { getResolvedProcessEnv, resolveExecutablePath } from './shell'
import { listToolCommandCandidates } from './toolchain'
import { scanForTerragrunt } from './terragruntDiscovery'

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
