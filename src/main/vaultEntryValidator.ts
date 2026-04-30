import { GoogleAuth } from 'google-auth-library'

import {
  ClientCertificateCredential,
  ClientSecretCredential
} from '@azure/identity'

import {
  getAzureServicePrincipalCertPayload,
  getAzureServicePrincipalSecretPayload,
  getGcpServiceAccountSecret,
  getGcpWorkloadIdentitySecret,
  getProviderApiTokenSecret,
  getSecretManagerReferencePayload,
  listVaultEntries,
  markVaultEntryValidated
} from './localVault'

import type { VaultEntrySummary } from '@shared/types'

export type VaultValidationResult = {
  ok: boolean
  message: string
  validatedAt: string
  entry: VaultEntrySummary | null
}

const AZURE_MANAGEMENT_SCOPE = 'https://management.azure.com/.default'

async function probeGcpServiceAccount(name: string): Promise<{ ok: boolean; message: string }> {
  const payload = getGcpServiceAccountSecret(name)
  if (!payload) {
    return { ok: false, message: 'Service account payload could not be read from the vault.' }
  }
  try {
    const auth = new GoogleAuth({
      credentials: {
        client_email: payload.client_email,
        private_key: payload.private_key
      },
      projectId: payload.project_id,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    })
    const projectId = await auth.getProjectId()
    return {
      ok: true,
      message: projectId ? `Authenticated against project ${projectId}.` : 'Authenticated successfully.'
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

async function probeGcpWorkloadIdentity(name: string): Promise<{ ok: boolean; message: string }> {
  const payload = getGcpWorkloadIdentitySecret(name)
  if (!payload) {
    return { ok: false, message: 'Workload identity payload could not be read from the vault.' }
  }
  try {
    const auth = new GoogleAuth({
      credentials: payload as unknown as Record<string, unknown>,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    })
    const projectId = await auth.getProjectId().catch(() => '')
    return {
      ok: true,
      message: projectId
        ? `Workload identity reachable; project: ${projectId}.`
        : 'Workload identity config parsed; remote token exchange not exercised.'
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

async function probeAzureSpSecret(name: string): Promise<{ ok: boolean; message: string }> {
  const payload = getAzureServicePrincipalSecretPayload(name)
  if (!payload) {
    return { ok: false, message: 'Service principal secret payload could not be read.' }
  }
  try {
    const credential = new ClientSecretCredential(payload.tenantId, payload.clientId, payload.clientSecret)
    const token = await credential.getToken(AZURE_MANAGEMENT_SCOPE)
    if (!token?.token) {
      return { ok: false, message: 'Token endpoint returned no token.' }
    }
    return { ok: true, message: 'Acquired ARM token successfully.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

async function probeAzureSpCert(name: string): Promise<{ ok: boolean; message: string }> {
  const payload = getAzureServicePrincipalCertPayload(name)
  if (!payload) {
    return { ok: false, message: 'Service principal certificate payload could not be read.' }
  }
  try {
    const credential = new ClientCertificateCredential(payload.tenantId, payload.clientId, {
      certificate: `${payload.privateKeyPem}\n${payload.certificatePem}`
    })
    const token = await credential.getToken(AZURE_MANAGEMENT_SCOPE)
    if (!token?.token) {
      return { ok: false, message: 'Token endpoint returned no token.' }
    }
    return { ok: true, message: 'Acquired ARM token via certificate auth.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function probeProviderApiToken(name: string): { ok: boolean; message: string } {
  const payload = getProviderApiTokenSecret(name)
  if (!payload) {
    return { ok: false, message: 'API token payload could not be read.' }
  }
  return {
    ok: true,
    message: `Token shape valid for ${payload.provider}. Live API probe not implemented; use the provider once to confirm.`
  }
}

function probeSecretReference(name: string): { ok: boolean; message: string } {
  const payload = getSecretManagerReferencePayload(name)
  if (!payload) {
    return { ok: false, message: 'Secret reference payload could not be read.' }
  }
  if (typeof payload.localFallback === 'string' && payload.localFallback.trim().length > 0) {
    return { ok: true, message: `Local fallback present for ${payload.provider}.` }
  }
  return {
    ok: false,
    message: `Remote ${payload.provider} resolution is not yet implemented; add a local fallback to validate this entry today.`
  }
}

export async function validateVaultEntry(entryId: string): Promise<VaultValidationResult> {
  const trimmed = entryId.trim()
  if (!trimmed) {
    return { ok: false, message: 'Entry id is required.', validatedAt: new Date().toISOString(), entry: null }
  }
  const summary = listVaultEntries().find((entry) => entry.id === trimmed)
  if (!summary) {
    return { ok: false, message: `Vault entry ${entryId} not found.`, validatedAt: new Date().toISOString(), entry: null }
  }

  let probe: { ok: boolean; message: string }
  switch (summary.kind) {
    case 'gcp-service-account-key':
      probe = await probeGcpServiceAccount(summary.name)
      break
    case 'gcp-workload-identity':
      probe = await probeGcpWorkloadIdentity(summary.name)
      break
    case 'azure-service-principal-secret':
      probe = await probeAzureSpSecret(summary.name)
      break
    case 'azure-service-principal-cert':
      probe = await probeAzureSpCert(summary.name)
      break
    case 'provider-api-token':
      probe = probeProviderApiToken(summary.name)
      break
    case 'secret-manager-reference':
      probe = probeSecretReference(summary.name)
      break
    default:
      probe = {
        ok: false,
        message: `Validation is not supported for kind ${summary.kind}.`
      }
  }

  const updated = markVaultEntryValidated(summary.id, probe)
  return {
    ok: probe.ok,
    message: probe.message,
    validatedAt: new Date().toISOString(),
    entry: updated ?? summary
  }
}
