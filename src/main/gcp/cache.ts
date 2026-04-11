import { logInfo, logWarn } from '../observability'

// ── TTL Presets (milliseconds) ──────────────────────────────────────────────────
//
// Resource types grouped by volatility:
//  - COMPUTE: VM instances, GKE clusters, Cloud Run services, SQL instances
//  - NETWORK: VPCs, subnets, firewall rules, load balancers, DNS zones
//  - DATA:    Storage objects, Firestore docs, BigQuery tables
//  - IAM:     Service accounts, roles, bindings, enabled APIs
//  - BILLING: Billing overview, cost data
//  - MONITOR: Alert policies, uptime checks, SCC findings

/** Compute, GKE, Cloud Run, SQL — 60 s */
export const GCP_TTL_COMPUTE = 60_000

/** VPCs, subnets, firewalls, LBs, DNS — 120 s */
export const GCP_TTL_NETWORK = 120_000

/** Storage objects, Firestore, BigQuery tables — 60 s */
export const GCP_TTL_DATA = 60_000

/** IAM roles, service accounts, enabled APIs — 300 s */
export const GCP_TTL_IAM = 300_000

/** Billing & cost data — 300 s */
export const GCP_TTL_BILLING = 300_000

/** Monitoring, SCC — 120 s */
export const GCP_TTL_MONITOR = 120_000

// ── Internal Types ──────────────────────────────────────────────────────────────

interface CacheEntry<T = unknown> {
  data: T
  fetchedAt: number
  expiresAt: number
  ttl: number
  refreshPromise: Promise<T> | null
}

// ── Constants ───────────────────────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 500
const CLEANUP_INTERVAL_MS = 60_000

// ── Cache Store ─────────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>()

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Returns cached data if fresh, otherwise fetches and caches.
 *
 * **Stale-while-revalidate**: if the entry has expired but data exists,
 * returns the stale value immediately while scheduling a background refresh.
 * Concurrent callers for the same key share one in-flight fetch (dedup).
 */
export async function getOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number
): Promise<T> {
  const now = Date.now()
  const existing = cache.get(key) as CacheEntry<T> | undefined

  // ── Fresh hit ──────────────────────────────────────────────────────────────
  if (existing && now < existing.expiresAt) {
    return existing.data
  }

  // ── Stale hit — return immediately, refresh in background ──────────────────
  if (existing && existing.data !== undefined && existing.fetchedAt > 0) {
    if (!existing.refreshPromise) {
      existing.refreshPromise = fetcher()
        .then((freshData) => {
          const refreshedAt = Date.now()
          cache.set(key, {
            data: freshData,
            fetchedAt: refreshedAt,
            expiresAt: refreshedAt + ttlMs,
            ttl: ttlMs,
            refreshPromise: null
          })
          return freshData
        })
        .catch((error) => {
          existing.refreshPromise = null
          logWarn('gcp.cache.refresh', `Background refresh failed for ${key}`, {}, error)
          return existing.data
        })
    }
    return existing.data
  }

  // ── Cold miss — must fetch synchronously ───────────────────────────────────
  // If an in-flight fetch exists (from a concurrent caller), share it.
  if (existing?.refreshPromise) {
    return existing.refreshPromise
  }

  const fetchPromise = fetcher().then((data) => {
    const fetchedAt = Date.now()
    cache.set(key, {
      data,
      fetchedAt,
      expiresAt: fetchedAt + ttlMs,
      ttl: ttlMs,
      refreshPromise: null
    })
    return data
  })

  // Store the promise for dedup before awaiting.
  cache.set(key, {
    data: undefined as unknown as T,
    fetchedAt: 0,
    expiresAt: 0,
    ttl: ttlMs,
    refreshPromise: fetchPromise
  })

  try {
    return await fetchPromise
  } catch (error) {
    cache.delete(key)
    throw error
  }
}

/**
 * Force-refresh a specific cache key, ignoring any existing cache.
 */
export async function forceRefresh<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number
): Promise<T> {
  cache.delete(key)
  return getOrFetch(key, fetcher, ttlMs)
}

/**
 * Invalidate a specific cache key.
 */
export function invalidateKey(key: string): boolean {
  return cache.delete(key)
}

/**
 * Invalidate all cache keys whose key starts with `prefix`.
 * Useful for invalidating an entire resource type or project.
 *
 * @example invalidatePrefix('proj-123:') // clears all for project
 * @example invalidatePrefix('proj-123:compute') // compute only
 */
export function invalidatePrefix(prefix: string): number {
  let count = 0
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
      count++
    }
  }
  return count
}

/**
 * Clear the entire cache.
 */
export function clearAllCache(): void {
  cache.clear()
  logInfo('gcp.cache', 'All GCP resource cache entries cleared.', {})
}

/**
 * Returns snapshot stats for diagnostics and the renderer cache status widget.
 */
export function getCacheStats(): {
  size: number
  maxSize: number
  fresh: number
  stale: number
  refreshing: number
} {
  const now = Date.now()
  let fresh = 0
  let stale = 0
  let refreshing = 0

  for (const entry of cache.values()) {
    if (now < entry.expiresAt) {
      fresh++
    } else {
      stale++
    }
    if (entry.refreshPromise) {
      refreshing++
    }
  }

  return { size: cache.size, maxSize: MAX_CACHE_ENTRIES, fresh, stale, refreshing }
}

// ── Periodic Eviction ───────────────────────────────────────────────────────────

function evictExpired(): void {
  const now = Date.now()

  // Remove entries that are stale beyond 2× their TTL (grace for stale-while-revalidate).
  for (const [key, entry] of cache.entries()) {
    if (now > entry.expiresAt + entry.ttl && !entry.refreshPromise) {
      cache.delete(key)
    }
  }

  // Hard cap: evict oldest entries when over limit.
  if (cache.size > MAX_CACHE_ENTRIES) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
    const surplus = sorted.slice(0, cache.size - MAX_CACHE_ENTRIES)
    for (const [key] of surplus) {
      cache.delete(key)
    }
  }
}

setInterval(evictExpired, CLEANUP_INTERVAL_MS).unref()
