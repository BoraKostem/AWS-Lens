/**
 * Shared types + helpers for direct backend state readers (GCS, S3, AzureRM, local).
 * Each reader bypasses terragrunt's config evaluation and terraform's variable
 * validation so a unit with unresolved `dependency.*.outputs` can still be inspected
 * for drift.
 *
 * `.terraform/terraform.tfstate` (written by `terraform init`) carries the *resolved*
 * backend configuration — bucket, region, container, key, etc. — so it's the source
 * of truth for everything the readers need. Raw HCL may still have `${local.X}`
 * interpolations we can't evaluate without running terragrunt.
 */

import fs from 'node:fs'
import path from 'node:path'

export type DirectStatePullResult =
  | { kind: 'ok'; stateJson: string; sourceLabel: string }
  | { kind: 'empty'; sourceLabel: string }
  | { kind: 'backend-mismatch'; expected: string; actual: string }
  | { kind: 'backend-unknown' }
  | { kind: 'error'; message: string; sourceLabel?: string }

export type BackendMeta = {
  type: string
  config: Record<string, unknown>
}

export function readBackendMeta(workingDir: string): BackendMeta | null {
  if (!workingDir) return null
  const metaPath = path.join(workingDir, '.terraform', 'terraform.tfstate')
  let raw: string
  try {
    raw = fs.readFileSync(metaPath, 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { backend?: { type?: string; config?: Record<string, unknown> } }
    if (!parsed.backend || typeof parsed.backend.type !== 'string') return null
    return {
      type: parsed.backend.type,
      config: parsed.backend.config ?? {}
    }
  } catch {
    return null
  }
}

export function readCurrentWorkspace(workingDir: string): string {
  try {
    const envFile = path.join(workingDir, '.terraform', 'environment')
    const name = fs.readFileSync(envFile, 'utf-8').trim()
    if (name) return name
  } catch { /* default workspace */ }
  return 'default'
}

export function isNotFoundMessage(message: string): boolean {
  return /\b404\b/.test(message)
    || /not found/i.test(message)
    || /no such object/i.test(message)
    || /nosuchkey/i.test(message)
    || /blobnotfound/i.test(message)
    || /\benoent\b/i.test(message)
}
