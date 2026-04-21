/**
 * Direct-from-S3 terraform state reader. Mirrors `gcp/terraformState.ts`: fetches the
 * state object straight out of the bucket using the AWS SDK client factory, bypassing
 * terragrunt's config evaluation (breaks on unresolved `dependency.*.outputs`) and
 * terraform's variable validation (refuses to run when required vars aren't set, even
 * for commands that don't evaluate user config).
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

import type { AwsConnection } from '@shared/types'
import { getAwsClient } from './client'
import {
  type DirectStatePullResult,
  isNotFoundMessage,
  readBackendMeta,
  readCurrentWorkspace
} from '../terraformStateTypes'

export type S3BackendConfig = {
  bucket: string
  key: string
  region: string
  workspaceKeyPrefix: string
}

/**
 * Parse the S3 backend metadata cached by `terraform init`. Workspace key prefix
 * defaults to `env:` when not explicitly configured (matches terraform's default).
 */
export function readS3BackendConfig(workingDir: string): S3BackendConfig | null {
  const meta = readBackendMeta(workingDir)
  if (!meta || meta.type !== 's3') return null
  const cfg = meta.config
  const bucket = typeof cfg.bucket === 'string' ? cfg.bucket.trim() : ''
  const key = typeof cfg.key === 'string' ? cfg.key.trim() : ''
  const region = typeof cfg.region === 'string' ? cfg.region.trim() : ''
  if (!bucket || !key) return null
  const workspaceKeyPrefix = typeof cfg.workspace_key_prefix === 'string' && cfg.workspace_key_prefix
    ? cfg.workspace_key_prefix
    : 'env:'
  return { bucket, key, region, workspaceKeyPrefix }
}

/**
 * Build the S3 object key for the unit's state file. Terraform's S3 backend stores
 * the `default` workspace at `<key>` and non-default workspaces at
 * `<workspace_key_prefix>/<workspace>/<key>`.
 */
function stateObjectKey(config: S3BackendConfig, workspace: string): string {
  if (workspace === 'default') return config.key
  const prefix = config.workspaceKeyPrefix.replace(/\/+$/, '')
  return `${prefix}/${workspace}/${config.key}`
}

function toBucketConnection(connection: AwsConnection, region: string): AwsConnection {
  if (!region || region === connection.region) return connection
  return { ...connection, region }
}

async function readBody(body: unknown): Promise<string> {
  if (!body) return ''
  // aws-sdk v3 smithy stream exposes transformToString on modern versions.
  if (typeof (body as { transformToString?: (encoding?: string) => Promise<string> }).transformToString === 'function') {
    return (body as { transformToString: (encoding?: string) => Promise<string> }).transformToString('utf-8')
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf-8')
  }
  return String(body)
}

/**
 * Fetch the state JSON directly from S3 using the app's connection credentials.
 * Returns a discriminated result so callers can distinguish "no state yet" (404 —
 * unit never applied) from auth/permission/transport errors.
 */
export async function pullS3StateDirect(
  workingDir: string,
  connection: AwsConnection
): Promise<DirectStatePullResult> {
  const backend = readS3BackendConfig(workingDir)
  if (!backend) {
    const meta = readBackendMeta(workingDir)
    if (!meta) return { kind: 'backend-unknown' }
    return { kind: 'backend-mismatch', expected: 's3', actual: meta.type }
  }

  const workspace = readCurrentWorkspace(workingDir)
  const objectKey = stateObjectKey(backend, workspace)
  const sourceLabel = `s3://${backend.bucket}/${objectKey}`
  const bucketConnection = toBucketConnection(connection, backend.region || connection.region)
  const client = getAwsClient(S3Client, bucketConnection)

  try {
    const output = await client.send(new GetObjectCommand({ Bucket: backend.bucket, Key: objectKey }))
    const body = await readBody(output.Body)
    const trimmed = body.trim()
    if (!trimmed) return { kind: 'empty', sourceLabel }
    return { kind: 'ok', stateJson: trimmed, sourceLabel }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const name = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code ?? ''
    if (name === 'NoSuchKey' || name === 'NotFound' || isNotFoundMessage(message)) {
      return { kind: 'empty', sourceLabel }
    }
    return { kind: 'error', message, sourceLabel }
  }
}
