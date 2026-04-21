/**
 * Direct-from-Azure-Blob terraform state reader. Mirrors `gcp/terraformState.ts` and
 * `aws/terraformState.ts`: fetches the state object straight out of blob storage
 * using Azure credentials, bypassing terragrunt's config evaluation and terraform's
 * variable validation.
 *
 * Auth strategy: try AD auth first (works when the caller has "Storage Blob Data
 * Reader" RBAC and/or the backend is configured with `use_azuread_auth = true`).
 * On 403, fall back to shared-key auth via `getAzureBlobServiceClient`, which needs
 * the subscription + resource group to call `listKeys`.
 */

import { BlobServiceClient } from '@azure/storage-blob'

import { getAzureCredential } from './client'
import { getAzureBlobServiceClient } from './shared'
import {
  type DirectStatePullResult,
  isNotFoundMessage,
  readBackendMeta,
  readCurrentWorkspace
} from '../terraformStateTypes'

export type AzureBlobBackendConfig = {
  storageAccountName: string
  containerName: string
  key: string
  resourceGroupName: string
  subscriptionId: string
  useAzureadAuth: boolean
  endpoint: string
}

export function readAzureBlobBackendConfig(workingDir: string): AzureBlobBackendConfig | null {
  const meta = readBackendMeta(workingDir)
  if (!meta || meta.type !== 'azurerm') return null
  const cfg = meta.config
  const storageAccountName = typeof cfg.storage_account_name === 'string' ? cfg.storage_account_name.trim() : ''
  const containerName = typeof cfg.container_name === 'string' ? cfg.container_name.trim() : ''
  const key = typeof cfg.key === 'string' ? cfg.key.trim() : ''
  if (!storageAccountName || !containerName || !key) return null
  const resourceGroupName = typeof cfg.resource_group_name === 'string' ? cfg.resource_group_name.trim() : ''
  const subscriptionId = typeof cfg.subscription_id === 'string' ? cfg.subscription_id.trim() : ''
  const useAzureadAuth = cfg.use_azuread_auth === true || cfg.use_azuread_auth === 'true'
  const endpointRaw = typeof cfg.endpoint === 'string' ? cfg.endpoint.trim() : ''
  const endpoint = endpointRaw || `https://${storageAccountName}.blob.core.windows.net`
  return { storageAccountName, containerName, key, resourceGroupName, subscriptionId, useAzureadAuth, endpoint }
}

/**
 * Build the blob name for the unit's state. AzureRM backend stores the default
 * workspace at `<key>` and non-default workspaces at `<key>env:<workspace>`.
 */
function stateBlobName(key: string, workspace: string): string {
  return workspace === 'default' ? key : `${key}env:${workspace}`
}

async function downloadBlobText(client: BlobServiceClient, container: string, blob: string): Promise<string> {
  const containerClient = client.getContainerClient(container)
  const blobClient = containerClient.getBlobClient(blob)
  const buffer = await blobClient.downloadToBuffer()
  return buffer.toString('utf-8')
}

function isAuthorizationError(message: string, status: number | undefined): boolean {
  if (status === 403 || status === 401) return true
  return /\b403\b/.test(message)
    || /\b401\b/.test(message)
    || /authorizationpermissionmismatch/i.test(message)
    || /authorizationfailure/i.test(message)
    || /this request is not authorized/i.test(message)
}

function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const candidate = err as { statusCode?: number; status?: number; response?: { status?: number } }
  return candidate.statusCode ?? candidate.status ?? candidate.response?.status
}

/**
 * Fetch the state JSON directly from Azure Blob storage. Returns a discriminated
 * result so callers can distinguish "no state yet" (BlobNotFound — unit never
 * applied) from auth/permission/transport errors.
 */
export async function pullAzureBlobStateDirect(workingDir: string): Promise<DirectStatePullResult> {
  const backend = readAzureBlobBackendConfig(workingDir)
  if (!backend) {
    const meta = readBackendMeta(workingDir)
    if (!meta) return { kind: 'backend-unknown' }
    return { kind: 'backend-mismatch', expected: 'azurerm', actual: meta.type }
  }

  const workspace = readCurrentWorkspace(workingDir)
  const blobName = stateBlobName(backend.key, workspace)
  const sourceLabel = `azurerm://${backend.storageAccountName}/${backend.containerName}/${blobName}`

  // Attempt 1: AD auth. Works when the caller has Storage Blob Data Reader/Owner
  // on the storage account, regardless of whether the backend was configured
  // with use_azuread_auth.
  let adError: { message: string; status: number | undefined } | null = null
  try {
    const credential = getAzureCredential()
    const adClient = new BlobServiceClient(backend.endpoint, credential)
    const body = await downloadBlobText(adClient, backend.containerName, blobName)
    const trimmed = body.trim()
    if (!trimmed) return { kind: 'empty', sourceLabel }
    return { kind: 'ok', stateJson: trimmed, sourceLabel }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = errorStatus(err)
    const name = (err as { code?: string; details?: { errorCode?: string } }).code
      ?? (err as { details?: { errorCode?: string } }).details?.errorCode
      ?? ''
    if (status === 404 || name === 'BlobNotFound' || isNotFoundMessage(message)) {
      return { kind: 'empty', sourceLabel }
    }
    if (!isAuthorizationError(message, status)) {
      return { kind: 'error', message, sourceLabel }
    }
    adError = { message, status }
  }

  // Attempt 2: shared-key fallback via listKeys. Needs subscription + resource group.
  const subscriptionId = backend.subscriptionId || (process.env.ARM_SUBSCRIPTION_ID ?? '').trim()
  if (!subscriptionId || !backend.resourceGroupName) {
    return {
      kind: 'error',
      message: [
        adError
          ? `Azure AD auth rejected (status ${adError.status ?? '?'}): ${adError.message}`
          : 'Azure AD auth failed.',
        'Shared-key fallback unavailable — backend config missing resource_group_name or subscription_id',
        'and ARM_SUBSCRIPTION_ID is not set.'
      ].join('\n'),
      sourceLabel
    }
  }
  try {
    const sharedKeyClient = await getAzureBlobServiceClient(
      subscriptionId,
      backend.resourceGroupName,
      backend.storageAccountName,
      backend.endpoint
    )
    const body = await downloadBlobText(sharedKeyClient, backend.containerName, blobName)
    const trimmed = body.trim()
    if (!trimmed) return { kind: 'empty', sourceLabel }
    return { kind: 'ok', stateJson: trimmed, sourceLabel }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = errorStatus(err)
    const name = (err as { code?: string; details?: { errorCode?: string } }).code
      ?? (err as { details?: { errorCode?: string } }).details?.errorCode
      ?? ''
    if (status === 404 || name === 'BlobNotFound' || isNotFoundMessage(message)) {
      return { kind: 'empty', sourceLabel }
    }
    const adSummary = adError ? `AD auth (status ${adError.status ?? '?'}): ${adError.message}\n` : ''
    return {
      kind: 'error',
      message: `${adSummary}Shared-key fallback: ${message}`,
      sourceLabel
    }
  }
}
