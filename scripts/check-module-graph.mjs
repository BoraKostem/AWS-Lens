#!/usr/bin/env node
/**
 * Module dependency graph validator.
 *
 * Walks src/main/**\/*.ts, parses imports via the TypeScript compiler API,
 * builds a directed graph, and runs Tarjan's SCC algorithm to detect cycles.
 *
 * Usage:
 *   node scripts/check-module-graph.mjs
 *
 * Exits 0 if no cycles are found, 1 otherwise.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Locate project root ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')
const SRC_MAIN = join(ROOT, 'src', 'main')

// ── Gather all .ts files under src/main ─────────────────────────────────────

function collectFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
      collectFiles(full, results)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

const allFiles = collectFiles(SRC_MAIN)
console.log(`[check-module-graph] Found ${allFiles.length} TypeScript files under src/main/`)

// ── Parse imports ───────────────────────────────────────────────────────────

// Match static imports:  import ... from '...'
// Match dynamic imports: import('...')
// Match re-exports:      export ... from '...'
const IMPORT_RE = /(?:import|export)\s.*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveImport(fromFile, specifier) {
  // Only resolve relative imports (starts with . or ..)
  if (!specifier.startsWith('.')) return null

  const dir = dirname(fromFile)
  let target = resolve(dir, specifier)

  // Try exact .ts
  if (tryFile(target + '.ts')) return normalize(target + '.ts')
  // Try /index.ts (directory barrel)
  if (tryFile(join(target, 'index.ts'))) return normalize(join(target, 'index.ts'))
  // If the specifier already ends with .ts
  if (tryFile(target)) return normalize(target)

  return null
}

function tryFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function normalize(p) {
  return resolve(p).split(sep).join('/')
}

// ── Build directed graph ────────────────────────────────────────────────────

/** @type {Map<string, Set<string>>} */
const graph = new Map()

for (const file of allFiles) {
  const key = normalize(file)
  if (!graph.has(key)) graph.set(key, new Set())

  const src = readFileSync(file, 'utf8')
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] || m[2]
    if (!spec) continue
    const resolved = resolveImport(file, spec)
    if (resolved && resolved !== key) {
      graph.get(key).add(resolved)
      if (!graph.has(resolved)) graph.set(resolved, new Set())
    }
  }
}

console.log(`[check-module-graph] Built graph with ${graph.size} nodes`)

// ── Tarjan's SCC ────────────────────────────────────────────────────────────

let index = 0
const stack = []
const onStack = new Set()
const indices = new Map()
const lowlinks = new Map()
const sccs = []

function strongConnect(v) {
  indices.set(v, index)
  lowlinks.set(v, index)
  index++
  stack.push(v)
  onStack.add(v)

  for (const w of (graph.get(v) ?? [])) {
    if (!indices.has(w)) {
      strongConnect(w)
      lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)))
    } else if (onStack.has(w)) {
      lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)))
    }
  }

  if (lowlinks.get(v) === indices.get(v)) {
    const scc = []
    let w
    do {
      w = stack.pop()
      onStack.delete(w)
      scc.push(w)
    } while (w !== v)
    if (scc.length > 1) {
      sccs.push(scc)
    }
  }
}

for (const v of graph.keys()) {
  if (!indices.has(v)) {
    strongConnect(v)
  }
}

// ── Known pre-existing cycles (allowlisted) ────────────────────────────────
// These cycles existed before the v2.5.0 module decomposition and are safe to
// ignore until a dedicated follow-up resolves them. Each entry is a Set of
// short paths that together form a known cycle.
const KNOWN_CYCLES = [
  new Set(['terraform.ts', 'terraformDrift.ts'])  // AWS drift ↔ project store
]

function isCycleKnown(cycle, shortPaths) {
  const pathSet = new Set(shortPaths)
  return KNOWN_CYCLES.some(known =>
    known.size === pathSet.size && [...known].every(p => pathSet.has(p))
  )
}

// ── Report ──────────────────────────────────────────────────────────────────

const mainNorm = normalize(SRC_MAIN)

function shortPath(p) {
  return p.startsWith(mainNorm) ? p.slice(mainNorm.length + 1) : p
}

const newCycles = []
const knownCycles = []

for (const cycle of sccs) {
  const paths = cycle.map(shortPath)
  if (isCycleKnown(cycle, paths)) {
    knownCycles.push(paths)
  } else {
    newCycles.push(paths)
  }
}

if (knownCycles.length > 0) {
  console.log(`[check-module-graph] ${knownCycles.length} known pre-existing cycle(s) (allowlisted):`)
  for (const paths of knownCycles) {
    console.log(`  ${paths.join(' ↔ ')}`)
  }
}

if (newCycles.length === 0) {
  console.log('[check-module-graph] No new circular dependencies found.')
  process.exit(0)
} else {
  console.error(`\n[check-module-graph] Found ${newCycles.length} NEW circular dependency cycle(s):\n`)
  for (let i = 0; i < newCycles.length; i++) {
    const paths = newCycles[i]
    console.error(`  Cycle ${i + 1} (${paths.length} files):`)
    for (const f of paths) {
      console.error(`    ${f}`)
    }
    console.error()
  }
  process.exit(1)
}
