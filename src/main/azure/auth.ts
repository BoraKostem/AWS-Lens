import {
  ClientCertificateCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
  type DeviceCodeInfo,
  type TokenCredential
} from '@azure/identity'
import { getActiveVaultCredential } from '../activeVaultCredentialStore'
import {
  getAzureServicePrincipalCertPayload,
  getAzureServicePrincipalSecretPayload,
  listVaultEntries,
  recordVaultEntryUseByKindAndName
} from '../localVault'
import { logInfo, logWarn } from '../observability'

// ── Constants ───────────────────────────────────────────────────────────────────

const MANAGEMENT_SCOPE = 'https://management.azure.com/.default'
const TOKEN_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000  // check every 5 min
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000          // refresh if within 10 min of expiry

// ── Types ───────────────────────────────────────────────────────────────────────

export type AzureCredentialStatus = {
  /** Whether valid credentials are available via SDK. */
  authenticated: boolean
  /** The auth method currently in use. */
  authMethod: 'sdk' | 'cli' | 'none'
  /** Human-readable status message. */
  message: string
  /** ISO timestamp of the last successful token refresh. */
  lastTokenRefreshAt: string
  /** ISO timestamp when the current token expires, or null. */
  tokenExpiresAt: string | null
  /** ISO timestamp of the last credential status check. */
  lastCheckedAt: string
}

export type DeviceCodePromptInfo = {
  message: string
  userCode: string
  verificationUri: string
}

// ── SDK Auth State ──────────────────────────────────────────────────────────────

let sdkCredential: TokenCredential | null = null
let sdkTokenExpiresAt: number | null = null
let lastTokenRefreshAt = ''

/**
 * Returns the active SDK credential, or null if SDK auth has not been performed.
 */
export function getSdkCredential(): TokenCredential | null {
  return sdkCredential
}

/**
 * Clears all SDK auth state. Call when the user signs out.
 */
export function clearSdkAuth(): void {
  sdkCredential = null
  sdkTokenExpiresAt = null
  lastTokenRefreshAt = ''
  logInfo('azure.auth.clear', 'SDK auth state cleared.', {})
}

/**
 * Starts an SDK-based device code authentication flow.
 * The onPrompt callback is invoked with the device code and verification URI
 * when the user needs to authenticate in a browser.
 *
 * Returns true if authentication succeeded, false otherwise.
 * Throws on unrecoverable errors (MFA, conditional access, etc.).
 */
export async function startSdkDeviceCodeAuth(
  tenantId: string | undefined,
  onPrompt: (info: DeviceCodePromptInfo) => void
): Promise<boolean> {
  const credential = new DeviceCodeCredential({
    tenantId: tenantId || undefined,
    // Note: persistent token caching requires @azure/identity-cache-extensions.
    // Add tokenCachePersistenceOptions when that package is available.
    userPromptCallback: (info: DeviceCodeInfo) => {
      onPrompt({
        message: info.message,
        userCode: info.userCode,
        verificationUri: info.verificationUri
      })
    }
  })

  const result = await credential.getToken(MANAGEMENT_SCOPE)
  if (!result?.token) {
    return false
  }

  sdkCredential = credential
  sdkTokenExpiresAt = result.expiresOnTimestamp
  lastTokenRefreshAt = new Date().toISOString()

  logInfo('azure.auth.sdk', 'SDK device code authentication succeeded.', {})
  recordActiveAzureVaultUse('azure:auth:device-code')
  return true
}

function recordActiveAzureVaultUse(source: string): void {
  const entryId = getActiveVaultCredential('azure')
  if (!entryId) {
    return
  }
  const summary = listVaultEntries().find((entry) => entry.id === entryId)
  if (!summary) {
    return
  }
  if (
    summary.kind !== 'azure-service-principal-secret' &&
    summary.kind !== 'azure-service-principal-cert'
  ) {
    return
  }
  try {
    recordVaultEntryUseByKindAndName(summary.kind, summary.name, {
      source,
      cloudProvider: 'azure'
    })
  } catch (err) {
    logWarn('azure.auth.vault-telemetry', 'Failed to record Azure vault credential use.', { entryId }, err)
  }
}

/**
 * Hydrate an Azure service principal credential from the vault by entry name.
 * Returns either ClientSecretCredential or ClientCertificateCredential, or
 * null when the entry is missing/unsupported. Records vault usage telemetry
 * on success.
 */
export function loadAzureSpCredentialFromVault(name: string): TokenCredential | null {
  const trimmed = name.trim()
  if (!trimmed) {
    return null
  }
  const secretPayload = getAzureServicePrincipalSecretPayload(trimmed)
  if (secretPayload) {
    const credential = new ClientSecretCredential(
      secretPayload.tenantId,
      secretPayload.clientId,
      secretPayload.clientSecret
    )
    try {
      recordVaultEntryUseByKindAndName('azure-service-principal-secret', trimmed, {
        source: 'azure:auth:vault-secret-load',
        cloudProvider: 'azure'
      })
    } catch { /* never block auth */ }
    return credential
  }
  const certPayload = getAzureServicePrincipalCertPayload(trimmed)
  if (certPayload) {
    const credential = new ClientCertificateCredential(
      certPayload.tenantId,
      certPayload.clientId,
      {
        certificate: `${certPayload.privateKeyPem}\n${certPayload.certificatePem}`
      }
    )
    try {
      recordVaultEntryUseByKindAndName('azure-service-principal-cert', trimmed, {
        source: 'azure:auth:vault-cert-load',
        cloudProvider: 'azure'
      })
    } catch { /* never block auth */ }
    return credential
  }
  return null
}

/**
 * Attempts a silent token refresh using the stored SDK credential.
 * Returns true if the refresh succeeded.
 */
export async function silentTokenRefresh(): Promise<boolean> {
  if (!sdkCredential) {
    return false
  }

  try {
    const result = await sdkCredential.getToken(MANAGEMENT_SCOPE)
    if (!result?.token) {
      return false
    }

    sdkTokenExpiresAt = result.expiresOnTimestamp
    lastTokenRefreshAt = new Date().toISOString()
    logInfo('azure.auth.refresh', 'Silent token refresh succeeded.', {})
    recordActiveAzureVaultUse('azure:auth:silent-refresh')
    return true
  } catch (error) {
    logWarn('azure.auth.refresh', 'Silent token refresh failed.', {}, error)
    return false
  }
}

/**
 * Returns true if the current SDK token is nearing expiry and should be refreshed.
 */
export function tokenNeedsRefresh(): boolean {
  if (!sdkCredential || sdkTokenExpiresAt === null) {
    return false
  }
  return Date.now() >= sdkTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS
}

/**
 * Returns a snapshot of the current SDK credential status.
 */
export async function getAzureCredentialStatus(): Promise<AzureCredentialStatus> {
  const now = new Date().toISOString()

  if (!sdkCredential) {
    return {
      authenticated: false,
      authMethod: 'none',
      message: 'No SDK credential available. Using CLI or default credentials.',
      lastTokenRefreshAt,
      tokenExpiresAt: null,
      lastCheckedAt: now
    }
  }

  try {
    const result = await sdkCredential.getToken(MANAGEMENT_SCOPE)
    if (!result?.token) {
      return {
        authenticated: false,
        authMethod: 'sdk',
        message: 'SDK credential did not return a valid token.',
        lastTokenRefreshAt,
        tokenExpiresAt: sdkTokenExpiresAt ? new Date(sdkTokenExpiresAt).toISOString() : null,
        lastCheckedAt: now
      }
    }

    sdkTokenExpiresAt = result.expiresOnTimestamp
    return {
      authenticated: true,
      authMethod: 'sdk',
      message: 'Authenticated via SDK device code flow.',
      lastTokenRefreshAt,
      tokenExpiresAt: new Date(result.expiresOnTimestamp).toISOString(),
      lastCheckedAt: now
    }
  } catch (error) {
    return {
      authenticated: false,
      authMethod: 'sdk',
      message: classifyAzureAuthError(error),
      lastTokenRefreshAt,
      tokenExpiresAt: sdkTokenExpiresAt ? new Date(sdkTokenExpiresAt).toISOString() : null,
      lastCheckedAt: now
    }
  }
}

// ── Error Classification ────────────────────────────────────────────────────────

/**
 * Classifies Azure AD authentication errors into human-readable messages
 * with remediation guidance. Handles common AADSTS error codes including
 * MFA (AADSTS50076), conditional access (AADSTS53003), device code
 * expiry (AADSTS70020), and consent issues (AADSTS65001).
 */
export function classifyAzureAuthError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)

  if (detail.includes('AADSTS50076')) {
    return 'Multi-factor authentication is required. Complete the MFA challenge to continue.'
  }
  if (detail.includes('AADSTS53003')) {
    return 'Conditional access policy blocked sign-in. Verify the device meets policy requirements or contact your administrator.'
  }
  if (detail.includes('AADSTS70020')) {
    return 'Device code has expired. Please start the sign-in flow again.'
  }
  if (detail.includes('AADSTS65001')) {
    return 'Admin consent is required for this application. Contact your Azure AD administrator.'
  }
  if (detail.includes('AADSTS70000') || detail.includes('AADSTS700003')) {
    return 'Authentication grant is invalid or expired. Please sign in again.'
  }
  if (detail.includes('AADSTS90002') || (detail.toLowerCase().includes('tenant') && detail.toLowerCase().includes('not found'))) {
    return 'Azure tenant not found. Verify the tenant ID is correct.'
  }
  if (detail.includes('AADSTS50057')) {
    return 'The user account is disabled. Contact your Azure AD administrator.'
  }
  if (detail.includes('AADSTS50053')) {
    return 'Account has been locked due to too many sign-in attempts. Wait and try again later.'
  }

  const normalized = detail.toLowerCase()
  if (normalized.includes('network') || normalized.includes('econnrefused') || normalized.includes('etimedout') || normalized.includes('enotfound')) {
    return 'Network error during authentication. Check your internet connection and try again.'
  }

  return `Azure authentication failed: ${detail}`
}

// ── Periodic Silent Refresh ─────────────────────────────────────────────────────

setInterval(async () => {
  try {
    if (tokenNeedsRefresh()) {
      await silentTokenRefresh()
    }
  } catch {
    /* silently ignore refresh errors */
  }
}, TOKEN_REFRESH_CHECK_INTERVAL_MS).unref()
