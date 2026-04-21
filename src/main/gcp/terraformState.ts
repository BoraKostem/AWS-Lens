/**
 * Direct-from-GCS terraform state reader. Bypasses terragrunt and terraform entirely —
 * reads the state object straight out of the bucket using the auth pool from client.ts.
 *
 * Why this exists: terragrunt's `state pull` path evaluates the full config (including
 * unresolved `dependency.*.outputs`), and terraform's fallback validates required input
 * variables even though `state pull` doesn't actually use them. Both break for a unit
 * that has upstream dependencies with no outputs yet, or whose placeholder tfvars isn't
 * auto-loaded. We don't need any of that machinery to GET an object from GCS.
 */

import { requestGcp } from './client'
import { buildStorageApiUrl } from './shared'
import {
  type DirectStatePullResult,
  isNotFoundMessage,
  readBackendMeta,
  readCurrentWorkspace
} from '../terraformStateTypes'

export type GcsBackendConfig = {
  bucket: string
  prefix: string
}

/** @deprecated use DirectStatePullResult from ../terraformStateTypes */
export type GcsStatePullResult = DirectStatePullResult

/**
 * Parse the backend metadata cached by `terraform init`. Returns the *resolved*
 * bucket/prefix values — raw HCL may still have `${local.X}` interpolations.
 */
export function readGcsBackendConfig(workingDir: string): GcsBackendConfig | null {
  const meta = readBackendMeta(workingDir)
  if (!meta || meta.type !== 'gcs') return null
  const cfg = meta.config
  const bucket = typeof cfg.bucket === 'string' ? cfg.bucket.trim() : ''
  const prefix = typeof cfg.prefix === 'string' ? cfg.prefix.trim() : ''
  if (!bucket) return null
  return { bucket, prefix }
}

/**
 * Build the GCS object name for the unit's state file. Terraform's gcs backend stores
 * state at `<prefix>/<workspace>.tfstate`. Prefixes written on Windows sometimes end up
 * with backslashes (terragrunt's `path_relative_to_include()` can leak them into the
 * rendered config); we leave the literal prefix alone since GCS treats the object name
 * as an opaque string — whatever terraform writes is what we need to read.
 */
function stateObjectKey(prefix: string, workspace: string): string {
  const trimmed = prefix.replace(/\/+$/, '')
  return trimmed ? `${trimmed}/${workspace}.tfstate` : `${workspace}.tfstate`
}

/**
 * Fetch the state JSON directly from GCS using the app's cached ADC client. Returns a
 * discriminated result so callers can distinguish "no state yet" (404 — unit never
 * applied) from auth/permission/transport errors.
 */
export async function pullGcsStateDirect(
  workingDir: string,
  projectIdHint = ''
): Promise<DirectStatePullResult> {
  if (!workingDir) return { kind: 'backend-unknown' }
  const backend = readGcsBackendConfig(workingDir)
  if (!backend) {
    const meta = readBackendMeta(workingDir)
    if (!meta) return { kind: 'backend-unknown' }
    return { kind: 'backend-mismatch', expected: 'gcs', actual: meta.type }
  }

  const workspace = readCurrentWorkspace(workingDir)
  const objectKey = stateObjectKey(backend.prefix, workspace)
  const sourceLabel = `gs://${backend.bucket}/${objectKey}`
  const url = buildStorageApiUrl(
    `/storage/v1/b/${encodeURIComponent(backend.bucket)}/o/${encodeURIComponent(objectKey)}`,
    { alt: 'media' }
  )

  try {
    const body = await requestGcp<string>(projectIdHint, { url, responseType: 'text' })
    const trimmed = (body ?? '').trim()
    if (!trimmed) return { kind: 'empty', sourceLabel }
    return { kind: 'ok', stateJson: trimmed, sourceLabel }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isNotFoundMessage(message)) return { kind: 'empty', sourceLabel }
    return { kind: 'error', message, sourceLabel }
  }
}
