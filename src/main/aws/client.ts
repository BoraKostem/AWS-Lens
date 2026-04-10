import type { AwsConnection } from '@shared/types'
import { getSessionCredentials } from '../sessionHub'
import { createProfileCredentialsProvider } from './profileCredentials'

type AwsCredentialsProvider = () => Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}>

// ── SDK Client Pool ────────────────────────────────────────────────────────────
// Clients are cached per (serviceClass, profile/sessionId, region) to avoid
// re-initialising middleware stacks on every API call.

type AnyConstructor<T> = new (config: ReturnType<typeof awsClientConfig>) => T

interface PoolEntry {
  client: unknown
  lastUsedAt: number
}

const CLIENT_TTL_MS = 10 * 60 * 1000 // 10 minutes idle TTL
const CLIENT_POOL_MAX_SIZE = 200      // evict LRU entries when exceeded
const clientPool = new Map<string, PoolEntry>()

function connectionKey(connection: AwsConnection): string {
  const id = connection.kind === 'assumed-role' ? connection.sessionId : connection.profile
  // Use a separator that cannot appear in profile names or session IDs (UUIDs)
  return `${encodeURIComponent(id)}\x00${connection.region}`
}

/**
 * Returns a cached SDK client for the given service class and connection.
 * Clients are reused across calls and evicted after CLIENT_TTL_MS of inactivity.
 */
export function getAwsClient<T>(ClientClass: AnyConstructor<T>, connection: AwsConnection): T {
  // Use a fully-qualified key that cannot collide across class names or connection params
  const key = `${encodeURIComponent(ClientClass.name)}\x00${connectionKey(connection)}`
  const now = Date.now()

  const existing = clientPool.get(key)
  if (existing) {
    existing.lastUsedAt = now
    return existing.client as T
  }

  // Enforce max pool size by evicting the least-recently-used entry
  if (clientPool.size >= CLIENT_POOL_MAX_SIZE) {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [k, entry] of clientPool.entries()) {
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt
        oldestKey = k
      }
    }
    if (oldestKey) {
      clientPool.delete(oldestKey)
    }
  }

  const client = new ClientClass(awsClientConfig(connection))
  clientPool.set(key, { client, lastUsedAt: now })
  return client
}

/**
 * Evicts all cached clients for a given connection (e.g. on credential refresh).
 * If no connection is provided, clears the entire pool.
 */
export function evictClientPool(connection?: AwsConnection): void {
  if (!connection) {
    clientPool.clear()
    return
  }
  const connKey = connectionKey(connection)
  for (const key of clientPool.keys()) {
    // key format: encodedClassName\x00connKey
    if (key.endsWith(`\x00${connKey}`)) {
      clientPool.delete(key)
    }
  }
}

// Periodically evict idle clients to avoid holding stale credentials in memory.
setInterval(() => {
  try {
    const cutoff = Date.now() - CLIENT_TTL_MS
    for (const [key, entry] of clientPool.entries()) {
      if (entry.lastUsedAt < cutoff) {
        clientPool.delete(key)
      }
    }
  } catch {
    /* silently ignore cleanup errors so the interval keeps running */
  }
}, CLIENT_TTL_MS).unref()

function evictPooledClientsForProfile(profile: string): void {
  const needle = `\x00${encodeURIComponent(profile)}\x00`
  for (const key of clientPool.keys()) {
    if (key.includes(needle)) {
      clientPool.delete(key)
    }
  }
}

// ── Credential Providers ───────────────────────────────────────────────────────

// How far before expiry to proactively evict the cached provider and its clients.
const CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60 * 1000 // 5 minutes before expiry

interface CredentialProviderEntry {
  provider: AwsCredentialsProvider
  // Earliest known expiration across all credentials returned by this provider.
  // null = no expiration info yet (e.g. long-term IAM keys).
  expiresAt: number | null
}

const credentialProviders = new Map<string, CredentialProviderEntry>()
const pendingCredentialLoads = new Set<Promise<unknown>>()

function trackCredentialLoad<T>(promise: Promise<T>): Promise<T> {
  pendingCredentialLoads.add(promise)
  const cleanup = () => {
    pendingCredentialLoads.delete(promise)
  }
  promise.then(cleanup, cleanup)
  return promise
}

export function getProfileCredentialsProvider(profile: string): AwsCredentialsProvider {
  const entry = credentialProviders.get(profile)

  // Evict if we know the credentials are about to expire
  if (entry) {
    const isExpiringSoon = entry.expiresAt !== null && Date.now() >= entry.expiresAt - CREDENTIAL_REFRESH_BUFFER_MS
    if (!isExpiringSoon) {
      return entry.provider
    }
    // Proactively evict stale provider and its pooled clients
    credentialProviders.delete(profile)
    evictPooledClientsForProfile(profile)
  }

  const baseProvider = createProfileCredentialsProvider(profile)
  const providerEntry: CredentialProviderEntry = { provider: null as unknown as AwsCredentialsProvider, expiresAt: null }

  const trackedProvider: AwsCredentialsProvider = async () => {
    const creds = await trackCredentialLoad(baseProvider())
    // Track the earliest expiration we've seen for this provider
    if (creds.expiration) {
      const expiresAt = creds.expiration.getTime()
      if (providerEntry.expiresAt === null || expiresAt < providerEntry.expiresAt) {
        providerEntry.expiresAt = expiresAt
      }
    }
    return creds
  }

  providerEntry.provider = trackedProvider
  credentialProviders.set(profile, providerEntry)
  return trackedProvider
}

/**
 * Force-invalidates the credential provider and all pooled clients for a profile.
 * Call this when the user explicitly refreshes credentials or switches sessions.
 */
export function refreshCredentialsForProfile(profile: string): void {
  credentialProviders.delete(profile)
  evictPooledClientsForProfile(profile)
}

export function clearCredentialsProviderCache(profile?: string): void {
  if (profile) {
    credentialProviders.delete(profile)
    evictPooledClientsForProfile(profile)
    return
  }

  credentialProviders.clear()
  clientPool.clear()
}
export function awsClientConfig(connection: AwsConnection) {
  const credentials = connection.kind === 'assumed-role'
    ? (() => {
        const snapshot = getSessionCredentials(connection.sessionId)
        return {
          accessKeyId: snapshot.accessKeyId,
          secretAccessKey: snapshot.secretAccessKey,
          sessionToken: snapshot.sessionToken,
          expiration: new Date(snapshot.expiration)
        }
      })()
    : getProfileCredentialsProvider(connection.profile)

  return {
    region: connection.region,
    credentials
  }
}

export async function waitForAwsCredentialActivity(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (pendingCredentialLoads.size > 0) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return
    }

    await Promise.race([
      Promise.allSettled([...pendingCredentialLoads]),
      new Promise<void>((resolve) => setTimeout(resolve, remainingMs))
    ])
  }
}

export function hasPendingAwsCredentialActivity(): boolean {
  return pendingCredentialLoads.size > 0
}

export function readTags(tags?: Array<{ Key?: string; Value?: string }>): Record<string, string> {
  const entries = (tags ?? [])
    .filter((tag) => tag.Key)
    .map((tag) => [tag.Key as string, tag.Value ?? ''])

  return Object.fromEntries(entries)
}
