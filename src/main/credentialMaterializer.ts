import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  getAzureServicePrincipalCertPayload,
  getAzureServicePrincipalSecretPayload,
  getGcpServiceAccountSecret,
  getGcpWorkloadIdentitySecret,
  getProviderApiTokenSecret,
  getSecretManagerReferencePayload,
  listVaultEntries,
  recordVaultEntryUseByKindAndName
} from './localVault'
import { logWarn } from './observability'
import { resolveSecretManagerReference } from './secretReferenceResolver'

import type { CloudProviderId } from '@shared/types'

const SESSION_ID = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
const ROOT_DIR_NAME = 'infralens-runtime'

function rootRuntimeDir(): string {
  return path.join(os.tmpdir(), ROOT_DIR_NAME)
}

function sessionRuntimeDir(): string {
  return path.join(rootRuntimeDir(), SESSION_ID)
}

function ensureSessionDir(): string {
  const dir = sessionRuntimeDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export type MaterializedRuntimeCredential = {
  disposeToken: string
  entryId: string
  env: Record<string, string>
  files: string[]
  cloudProvider?: CloudProviderId
}

type ActiveMaterialization = MaterializedRuntimeCredential & {
  dispose: () => Promise<void>
}

const active = new Map<string, ActiveMaterialization>()

function newDisposeToken(): string {
  return crypto.randomUUID()
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (err) {
    logWarn('vault.runtime.dispose', 'Failed to remove materialized credential file.', { filePath }, err)
  }
}

function writeSecureFile(name: string, content: string): string {
  const dir = ensureSessionDir()
  const fileName = `${name}-${crypto.randomBytes(6).toString('hex')}`
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, content, { mode: 0o600 })
  return filePath
}

function recordUsage(
  kind: Parameters<typeof recordVaultEntryUseByKindAndName>[0],
  name: string,
  cloudProvider: CloudProviderId | undefined,
  source: string
): void {
  try {
    recordVaultEntryUseByKindAndName(kind, name, {
      source,
      cloudProvider
    })
  } catch (err) {
    logWarn('vault.runtime.telemetry', 'Failed to record vault entry use.', { kind, name, source }, err)
  }
}

async function materializeGcpServiceAccount(entryId: string, name: string): Promise<MaterializedRuntimeCredential> {
  const payload = getGcpServiceAccountSecret(name)
  if (!payload) {
    throw new Error(`Vault entry ${entryId} is not a valid GCP service account key.`)
  }
  const filePath = writeSecureFile('gcp-sa', JSON.stringify(payload))
  const env: Record<string, string> = {
    GOOGLE_APPLICATION_CREDENTIALS: filePath,
    CLOUDSDK_CORE_PROJECT: payload.project_id
  }
  recordUsage('gcp-service-account-key', name, 'gcp', 'vault:materialize:gcp-service-account')
  return { disposeToken: newDisposeToken(), entryId, env, files: [filePath], cloudProvider: 'gcp' }
}

async function materializeGcpWorkloadIdentity(entryId: string, name: string): Promise<MaterializedRuntimeCredential> {
  const payload = getGcpWorkloadIdentitySecret(name)
  if (!payload) {
    throw new Error(`Vault entry ${entryId} is not a valid GCP workload identity config.`)
  }
  const filePath = writeSecureFile('gcp-wif', JSON.stringify(payload))
  const env: Record<string, string> = { GOOGLE_APPLICATION_CREDENTIALS: filePath }
  recordUsage('gcp-workload-identity', name, 'gcp', 'vault:materialize:gcp-workload-identity')
  return { disposeToken: newDisposeToken(), entryId, env, files: [filePath], cloudProvider: 'gcp' }
}

async function materializeAzureSpSecret(entryId: string, name: string): Promise<MaterializedRuntimeCredential> {
  const payload = getAzureServicePrincipalSecretPayload(name)
  if (!payload) {
    throw new Error(`Vault entry ${entryId} is not a valid Azure SP secret.`)
  }
  const env: Record<string, string> = {
    ARM_TENANT_ID: payload.tenantId,
    ARM_CLIENT_ID: payload.clientId,
    ARM_CLIENT_SECRET: payload.clientSecret,
    ARM_SUBSCRIPTION_ID: payload.subscriptionId,
    AZURE_TENANT_ID: payload.tenantId,
    AZURE_CLIENT_ID: payload.clientId,
    AZURE_CLIENT_SECRET: payload.clientSecret,
    AZURE_SUBSCRIPTION_ID: payload.subscriptionId,
    ARM_USE_CLI: 'false'
  }
  recordUsage('azure-service-principal-secret', name, 'azure', 'vault:materialize:azure-sp-secret')
  return { disposeToken: newDisposeToken(), entryId, env, files: [], cloudProvider: 'azure' }
}

async function materializeAzureSpCert(entryId: string, name: string): Promise<MaterializedRuntimeCredential> {
  const payload = getAzureServicePrincipalCertPayload(name)
  if (!payload) {
    throw new Error(`Vault entry ${entryId} is not a valid Azure SP certificate.`)
  }
  const combined = `${payload.privateKeyPem.trim()}\n${payload.certificatePem.trim()}\n`
  const filePath = writeSecureFile('azure-sp-cert', combined)
  const env: Record<string, string> = {
    ARM_TENANT_ID: payload.tenantId,
    ARM_CLIENT_ID: payload.clientId,
    ARM_SUBSCRIPTION_ID: payload.subscriptionId,
    ARM_CLIENT_CERTIFICATE_PATH: filePath,
    AZURE_TENANT_ID: payload.tenantId,
    AZURE_CLIENT_ID: payload.clientId,
    AZURE_SUBSCRIPTION_ID: payload.subscriptionId,
    AZURE_CLIENT_CERTIFICATE_PATH: filePath,
    ARM_USE_CLI: 'false'
  }
  recordUsage('azure-service-principal-cert', name, 'azure', 'vault:materialize:azure-sp-cert')
  return { disposeToken: newDisposeToken(), entryId, env, files: [filePath], cloudProvider: 'azure' }
}

async function materializeProviderApiToken(entryId: string, name: string): Promise<MaterializedRuntimeCredential> {
  const payload = getProviderApiTokenSecret(name)
  if (!payload) {
    throw new Error(`Vault entry ${entryId} is not a valid provider API token.`)
  }
  const env: Record<string, string> = {}
  switch (payload.provider) {
    case 'openai':
      env.OPENAI_API_KEY = payload.token
      if (payload.baseUrl) env.OPENAI_BASE_URL = payload.baseUrl
      break
    case 'anthropic':
      env.ANTHROPIC_API_KEY = payload.token
      if (payload.baseUrl) env.ANTHROPIC_BASE_URL = payload.baseUrl
      break
    case 'gemini':
      env.GOOGLE_API_KEY = payload.token
      env.GEMINI_API_KEY = payload.token
      break
    case 'vertex-ai':
      env.GOOGLE_API_KEY = payload.token
      break
    case 'bedrock':
      env.AWS_BEARER_TOKEN_BEDROCK = payload.token
      break
    case 'azure-openai':
      env.AZURE_OPENAI_API_KEY = payload.token
      if (payload.baseUrl) env.AZURE_OPENAI_ENDPOINT = payload.baseUrl
      break
    case 'mistral':
      env.MISTRAL_API_KEY = payload.token
      break
    case 'cohere':
      env.COHERE_API_KEY = payload.token
      break
    default:
      env.PROVIDER_API_TOKEN = payload.token
  }
  recordUsage('provider-api-token', name, undefined, `vault:materialize:provider-api-token:${payload.provider}`)
  return { disposeToken: newDisposeToken(), entryId, env, files: [] }
}

async function materializeSecretReference(entryId: string, name: string): Promise<MaterializedRuntimeCredential> {
  const payload = getSecretManagerReferencePayload(name)
  if (!payload) {
    throw new Error(`Vault entry ${entryId} is not a valid secret manager reference.`)
  }
  const resolved = await resolveSecretManagerReference(payload)
  recordUsage('secret-manager-reference', name, undefined, `vault:materialize:secret-reference:${payload.provider}`)
  return {
    disposeToken: newDisposeToken(),
    entryId,
    env: { RESOLVED_SECRET: resolved.secret },
    files: []
  }
}

export async function materializeVaultEntryForRuntime(entryId: string): Promise<MaterializedRuntimeCredential> {
  const trimmed = entryId.trim()
  if (!trimmed) {
    throw new Error('Vault entry id is required.')
  }
  const summary = listVaultEntries().find((entry) => entry.id === trimmed)
  if (!summary) {
    throw new Error(`Vault entry not found: ${entryId}`)
  }

  let materialized: MaterializedRuntimeCredential
  switch (summary.kind) {
    case 'gcp-service-account-key':
      materialized = await materializeGcpServiceAccount(summary.id, summary.name)
      break
    case 'gcp-workload-identity':
      materialized = await materializeGcpWorkloadIdentity(summary.id, summary.name)
      break
    case 'azure-service-principal-secret':
      materialized = await materializeAzureSpSecret(summary.id, summary.name)
      break
    case 'azure-service-principal-cert':
      materialized = await materializeAzureSpCert(summary.id, summary.name)
      break
    case 'provider-api-token':
      materialized = await materializeProviderApiToken(summary.id, summary.name)
      break
    case 'secret-manager-reference':
      materialized = await materializeSecretReference(summary.id, summary.name)
      break
    default:
      throw new Error(`Vault entry kind ${summary.kind} cannot be materialized for runtime.`)
  }

  const handle: ActiveMaterialization = {
    ...materialized,
    dispose: async () => {
      for (const file of materialized.files) {
        safeUnlink(file)
      }
      active.delete(materialized.disposeToken)
    }
  }
  active.set(materialized.disposeToken, handle)
  return materialized
}

export async function disposeMaterializedEntry(disposeToken: string): Promise<void> {
  const handle = active.get(disposeToken.trim())
  if (!handle) {
    return
  }
  await handle.dispose()
}

export async function disposeAllRuntimeMaterializations(): Promise<void> {
  const tokens = [...active.keys()]
  for (const token of tokens) {
    await disposeMaterializedEntry(token)
  }
  // Best-effort: remove the per-session directory itself
  try {
    const dir = sessionRuntimeDir()
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch (err) {
    logWarn('vault.runtime.dispose-session', 'Failed to remove session runtime dir.', {}, err)
  }
}

export function cleanupOrphanRuntimeDirs(): void {
  const root = rootRuntimeDir()
  if (!fs.existsSync(root)) {
    return
  }
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch (err) {
    logWarn('vault.runtime.cleanup-list', 'Failed to list runtime root dir.', { root }, err)
    return
  }
  for (const entry of entries) {
    if (entry === SESSION_ID) {
      continue
    }
    const candidate = path.join(root, entry)
    try {
      const stat = fs.statSync(candidate)
      if (!stat.isDirectory()) {
        continue
      }
      // Owned by a previous process; remove.
      fs.rmSync(candidate, { recursive: true, force: true })
    } catch (err) {
      logWarn('vault.runtime.cleanup', 'Failed to remove orphan runtime dir.', { candidate }, err)
    }
  }
}
