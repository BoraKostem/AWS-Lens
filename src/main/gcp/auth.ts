import { GoogleAuth, type AuthClient, Impersonated } from 'google-auth-library'
import { getActiveVaultCredential } from '../activeVaultCredentialStore'
import { listVaultEntries, recordVaultEntryUseByKindAndName } from '../localVault'
import { logInfo, logWarn } from '../observability'

// ── Constants ───────────────────────────────────────────────────────────────────

const GCP_SDK_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']
const CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60 * 1000 // 5 minutes before expiry
const CREDENTIAL_CHECK_INTERVAL_MS = 60 * 1000      // check every 60s
const MAX_CACHED_CREDENTIALS = 20

// ── Types ───────────────────────────────────────────────────────────────────────

export type GcpCredentialStatus = {
  /** Whether valid credentials are available. */
  authenticated: boolean
  /** The GCP project ID associated with the active credentials. */
  projectId: string
  /** The client email or account (for service accounts). */
  account: string
  /** The credential source type. */
  source: 'adc' | 'service-account' | 'impersonation' | 'workforce-identity' | 'unknown'
  /** Human-readable status message. */
  message: string
  /** ISO timestamp of the last successful auth check. */
  lastCheckedAt: string
}

interface CredentialEntry {
  auth: GoogleAuth
  client: AuthClient | null
  projectId: string
  account: string
  lastUsedAt: number
  expiresAt: number | null
}

// ── Credential Manager ──────────────────────────────────────────────────────────

const credentials = new Map<string, CredentialEntry>()
let impersonationTarget: string | null = null

function credentialKey(projectId: string): string {
  const base = projectId.trim() || '__default__'
  return impersonationTarget ? `${base}::impersonate::${impersonationTarget}` : base
}

/**
 * Returns a GoogleAuth instance for the given project, reusing cached
 * credentials when available. Handles proactive eviction when credentials
 * are nearing expiry.
 */
export function getCredentialAuth(projectId = ''): GoogleAuth {
  const key = credentialKey(projectId)
  const now = Date.now()

  const existing = credentials.get(key)
  if (existing) {
    // Evict if credentials are about to expire
    if (existing.expiresAt !== null && now >= existing.expiresAt - CREDENTIAL_REFRESH_BUFFER_MS) {
      credentials.delete(key)
    } else {
      existing.lastUsedAt = now
      return existing.auth
    }
  }

  // Enforce max cache size via LRU eviction
  if (credentials.size >= MAX_CACHED_CREDENTIALS) {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [k, entry] of credentials.entries()) {
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt
        oldestKey = k
      }
    }
    if (oldestKey) credentials.delete(oldestKey)
  }

  const auth = new GoogleAuth({
    projectId: projectId.trim() || undefined,
    scopes: GCP_SDK_SCOPES
  })

  credentials.set(key, {
    auth,
    client: null,
    projectId: projectId.trim(),
    account: '',
    lastUsedAt: now,
    expiresAt: null
  })

  return auth
}

function recordActiveVaultUse(projectId: string): void {
  const entryId = getActiveVaultCredential('gcp')
  if (!entryId) {
    return
  }
  const summary = listVaultEntries().find((entry) => entry.id === entryId)
  if (!summary) {
    return
  }
  if (summary.kind !== 'gcp-service-account-key' && summary.kind !== 'gcp-workload-identity') {
    return
  }
  try {
    recordVaultEntryUseByKindAndName(summary.kind, summary.name, {
      source: 'gcp:auth:credential-load',
      profile: projectId.trim(),
      cloudProvider: 'gcp'
    })
  } catch (err) {
    logWarn('gcp.auth.vault-telemetry', 'Failed to record GCP vault credential use.', { entryId }, err)
  }
}

/**
 * Returns an authenticated client for the given project, with support for
 * service account impersonation when configured.
 */
export async function getCredentialClient(projectId = ''): Promise<AuthClient> {
  const key = credentialKey(projectId)
  const entry = credentials.get(key)

  if (entry?.client) {
    return entry.client
  }

  const auth = getCredentialAuth(projectId)
  let client = await auth.getClient()
  recordActiveVaultUse(projectId)

  // Apply service account impersonation if configured
  if (impersonationTarget) {
    client = new Impersonated({
      sourceClient: client,
      targetPrincipal: impersonationTarget,
      targetScopes: GCP_SDK_SCOPES,
      lifetime: 3600
    })
  }

  // Update entry with resolved client
  if (entry) {
    entry.client = client
    try {
      const creds = await auth.getCredentials()
      entry.account = typeof creds.client_email === 'string' ? creds.client_email.trim() : ''
    } catch { /* not all credential types expose client_email */ }
  }

  return client
}

/**
 * Forces all cached credentials to be evicted, triggering re-authentication
 * on the next call. Call this when the user explicitly refreshes credentials
 * or when a 401 is detected.
 */
export function refreshCredentials(projectId?: string): void {
  if (!projectId) {
    credentials.clear()
    logInfo('gcp.auth.refresh', 'Cleared all cached GCP credentials.', {})
    return
  }

  // Clear all entries for this projectId (with and without impersonation)
  for (const key of credentials.keys()) {
    if (key === projectId.trim() || key.startsWith(`${projectId.trim()}::`)) {
      credentials.delete(key)
    }
  }

  logInfo('gcp.auth.refresh', `Cleared cached GCP credentials for project "${projectId}".`, { projectId })
}

/**
 * Configures service account impersonation. Pass null to disable.
 * Clears all cached credentials so the next call uses the new configuration.
 */
export function setImpersonationTarget(targetServiceAccount: string | null): void {
  impersonationTarget = targetServiceAccount?.trim() || null
  credentials.clear()
  logInfo('gcp.auth.impersonation', `Service account impersonation ${impersonationTarget ? `set to "${impersonationTarget}"` : 'disabled'}.`, {
    target: impersonationTarget ?? ''
  })
}

/**
 * Returns the current impersonation target, or null if not configured.
 */
export function getImpersonationTarget(): string | null {
  return impersonationTarget
}

/**
 * Checks the health of the current credentials and returns a status snapshot.
 * This is safe to call frequently — it uses cached auth when available.
 */
export async function getCredentialStatus(projectId = ''): Promise<GcpCredentialStatus> {
  const now = new Date().toISOString()

  try {
    const auth = getCredentialAuth(projectId)
    const resolvedProjectId = (await auth.getProjectId())?.trim() ?? ''
    const creds = await auth.getCredentials()
    const account = typeof creds.client_email === 'string' ? creds.client_email.trim() : ''

    let source: GcpCredentialStatus['source'] = 'unknown'
    if (impersonationTarget) {
      source = 'impersonation'
    } else if (creds.client_email?.includes('iam.gserviceaccount.com')) {
      source = 'service-account'
    } else if (typeof (creds as Record<string, unknown>).type === 'string' && String((creds as Record<string, unknown>).type).includes('external_account')) {
      source = 'workforce-identity'
    } else {
      source = 'adc'
    }

    return {
      authenticated: true,
      projectId: resolvedProjectId || projectId.trim(),
      account: impersonationTarget || account,
      source,
      message: impersonationTarget
        ? `Authenticated via service account impersonation (${impersonationTarget}).`
        : `Authenticated as ${account || 'application default credentials'}.`,
      lastCheckedAt: now
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const normalized = detail.toLowerCase()

    let message = 'GCP credentials are not configured.'
    if (normalized.includes('invalid_grant') || normalized.includes('token has been expired')) {
      message = 'GCP credentials have expired. Run "gcloud auth application-default login" to refresh.'
      // Proactively evict stale credentials
      refreshCredentials(projectId)
    } else if (normalized.includes('revoked') || normalized.includes('access_denied')) {
      message = 'GCP credentials have been revoked. Run "gcloud auth application-default login" to re-authenticate.'
      refreshCredentials(projectId)
    } else if (normalized.includes('could not load the default credentials') || normalized.includes('application default credentials')) {
      message = 'No GCP credentials found. Run "gcloud auth application-default login" or set GOOGLE_APPLICATION_CREDENTIALS.'
    }

    return {
      authenticated: false,
      projectId: projectId.trim(),
      account: '',
      source: 'unknown',
      message,
      lastCheckedAt: now
    }
  }
}

// ── Periodic Credential Health Check ────────────────────────────────────────────

setInterval(() => {
  try {
    const now = Date.now()
    for (const [key, entry] of credentials.entries()) {
      // Evict credentials that have been idle for 10+ minutes
      if (now - entry.lastUsedAt > 10 * 60 * 1000) {
        credentials.delete(key)
        continue
      }
      // Evict credentials nearing expiry
      if (entry.expiresAt !== null && now >= entry.expiresAt - CREDENTIAL_REFRESH_BUFFER_MS) {
        credentials.delete(key)
      }
    }
  } catch {
    /* silently ignore cleanup errors */
  }
}, CREDENTIAL_CHECK_INTERVAL_MS).unref()
