/**
 * Local-backend terraform state reader. For `backend "local"` (or units with no
 * explicit backend), state is a JSON file on disk — we can just read it without
 * touching terraform or terragrunt.
 *
 * Probe order handles the three common layouts:
 *   - resolved path from `.terraform/terraform.tfstate` backend.config.path
 *   - workspace-scoped file under `terraform.tfstate.d/<workspace>/terraform.tfstate`
 *   - default `terraform.tfstate` in the terragrunt cache or unit source dir
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  type DirectStatePullResult,
  readBackendMeta,
  readCurrentWorkspace
} from './terraformStateTypes'

function readFileIfExists(candidate: string): string | null {
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return null
    if (stat.size === 0) return ''
    return fs.readFileSync(candidate, 'utf-8')
  } catch {
    return null
  }
}

function resolvedBackendPath(workingDir: string, configPath: unknown): string | null {
  if (typeof configPath !== 'string' || !configPath.trim()) return null
  return path.isAbsolute(configPath) ? configPath : path.resolve(workingDir, configPath)
}

/**
 * Fetch the state JSON from a local state file. Probes multiple candidate paths —
 * the terragrunt cache working dir and the unit source dir — since terragrunt may
 * materialise the module into `.terragrunt-cache` but some setups keep state next
 * to `terragrunt.hcl` instead.
 */
export async function pullLocalStateDirect(
  workingDir: string,
  unitDir: string
): Promise<DirectStatePullResult> {
  const workspace = readCurrentWorkspace(workingDir)
  const meta = readBackendMeta(workingDir)

  const candidates: string[] = []

  if (meta?.type === 'local') {
    const resolved = resolvedBackendPath(workingDir, (meta.config ?? {}).path)
    if (resolved) candidates.push(resolved)
  }

  if (workingDir) {
    if (workspace !== 'default') {
      candidates.push(path.join(workingDir, 'terraform.tfstate.d', workspace, 'terraform.tfstate'))
    }
    candidates.push(path.join(workingDir, 'terraform.tfstate'))
  }

  if (unitDir && path.resolve(unitDir) !== path.resolve(workingDir)) {
    if (workspace !== 'default') {
      candidates.push(path.join(unitDir, 'terraform.tfstate.d', workspace, 'terraform.tfstate'))
    }
    candidates.push(path.join(unitDir, 'terraform.tfstate'))
  }

  for (const candidate of candidates) {
    const body = readFileIfExists(candidate)
    if (body === null) continue
    const sourceLabel = `file://${candidate}`
    const trimmed = body.trim()
    if (!trimmed) return { kind: 'empty', sourceLabel }
    return { kind: 'ok', stateJson: trimmed, sourceLabel }
  }

  if (meta && meta.type !== 'local') {
    return { kind: 'backend-mismatch', expected: 'local', actual: meta.type }
  }
  return { kind: 'backend-unknown' }
}
