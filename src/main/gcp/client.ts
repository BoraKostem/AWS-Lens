import { GoogleAuth } from 'google-auth-library'
import { logInfo, logWarn } from '../observability'
import { incrementAmbientRetryCount } from '../terraformAudit'

// ── Scopes & Constants ──────────────────────────────────────────────────────────

export const GCP_SDK_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']

/** Maximum number of pages to fetch in any paginated loop to prevent runaways. */
export const MAX_PAGINATION_PAGES = 100

/**
 * Creates a pagination guard that returns true up to MAX_PAGINATION_PAGES times.
 * Usage: `const canPage = paginationGuard(); do { ... } while (token && canPage())`
 */
export function paginationGuard(maxPages = MAX_PAGINATION_PAGES): () => boolean {
  let count = 0
  return () => ++count < maxPages
}

// ── Auth Client Pool ────────────────────────────────────────────────────────────
// GoogleAuth instances are pooled per projectId to avoid re-initialising on every
// call. Mirrors the LRU pattern in src/main/aws/client.ts.

const AUTH_POOL_TTL_MS = 10 * 60 * 1000 // 10 minutes idle TTL
const AUTH_POOL_MAX_SIZE = 50

interface AuthPoolEntry {
  auth: GoogleAuth
  lastUsedAt: number
}

const authPool = new Map<string, AuthPoolEntry>()

/**
 * Returns a cached GoogleAuth instance for the given project, creating one if
 * needed. The pool uses LRU eviction when it reaches capacity.
 */
export function getGcpAuth(projectId = ''): GoogleAuth {
  const key = projectId.trim() || '__default__'
  const now = Date.now()

  const existing = authPool.get(key)
  if (existing) {
    existing.lastUsedAt = now
    return existing.auth
  }

  // Enforce max pool size by evicting the least-recently-used entry
  if (authPool.size >= AUTH_POOL_MAX_SIZE) {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [k, entry] of authPool.entries()) {
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt
        oldestKey = k
      }
    }
    if (oldestKey) {
      authPool.delete(oldestKey)
    }
  }

  const auth = new GoogleAuth({
    projectId: projectId.trim() || undefined,
    scopes: GCP_SDK_SCOPES
  })

  authPool.set(key, { auth, lastUsedAt: now })
  return auth
}

/**
 * Evicts all cached auth clients for a given project (e.g. on credential
 * refresh). If no projectId is provided, clears the entire pool.
 */
export function evictGcpAuthPool(projectId?: string): void {
  if (!projectId) {
    authPool.clear()
    return
  }
  authPool.delete(projectId.trim() || '__default__')
}

// Periodically evict idle auth instances.
setInterval(() => {
  try {
    const cutoff = Date.now() - AUTH_POOL_TTL_MS
    for (const [key, entry] of authPool.entries()) {
      if (entry.lastUsedAt < cutoff) {
        authPool.delete(key)
      }
    }
  } catch {
    /* silently ignore cleanup errors so the interval keeps running */
  }
}, AUTH_POOL_TTL_MS).unref()

// ── Error Classification ────────────────────────────────────────────────────────

export function outputIndicatesApiDisabled(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('api has not been used in project')
    || normalized.includes('it is disabled')
    || normalized.includes('enable it by visiting')
    || normalized.includes('service disabled')
}

function outputIndicatesAdcIssue(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('application default credentials')
    || normalized.includes('could not load the default credentials')
    || normalized.includes('default credentials')
    || normalized.includes('could not authenticate')
    || normalized.includes('login required')
}

function outputIndicatesPermissionIssue(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('permission denied')
    || normalized.includes('forbidden')
    || normalized.includes('does not have permission')
    || normalized.includes('insufficient authentication scopes')
    || normalized.includes('permission')
}

function outputIndicatesNotFound(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('not found')
    || normalized.includes('404')
    || normalized.includes('does not exist')
}

function outputIndicatesQuotaExceeded(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('quota exceeded')
    || normalized.includes('rate limit')
    || normalized.includes('rateLimitExceeded')
    || normalized.includes('resource exhausted')
}

function extractProjectIdFromOutput(output: string): string {
  const quotedMatch = output.match(/project\s+"([^"]+)"/i)
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim()
  }

  const plainMatch = output.match(/project\s+([a-z0-9-]+)/i)
  return plainMatch?.[1]?.trim() ?? ''
}

/**
 * Classifies a GCP error into a human-readable Error with remediation guidance.
 * Centralises the logic that was previously duplicated across gcpSdk.ts and gcpCli.ts.
 */
export function classifyGcpError(label: string, error: unknown, apiServiceName = 'compute.googleapis.com'): Error {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim()

  if (outputIndicatesApiDisabled(detail)) {
    const projectId = extractProjectIdFromOutput(detail)
    const enableCommand = projectId
      ? `gcloud services enable ${apiServiceName} --project ${projectId}`
      : `gcloud services enable ${apiServiceName} --project <project-id>`

    return new Error(
      `Google Cloud API access failed while ${label}. The required API is disabled for the selected project. Run "${enableCommand}", wait for propagation, and retry.${detail ? ` ${detail}` : ''}`
    )
  }

  if (outputIndicatesAdcIssue(detail)) {
    return new Error(
      `Google Cloud SDK authorization failed while ${label}. Run "gcloud auth application-default login" or provide GOOGLE_APPLICATION_CREDENTIALS, then try again.${detail ? ` ${detail}` : ''}`
    )
  }

  if (outputIndicatesPermissionIssue(detail)) {
    return new Error(
      `Google Cloud SDK authorization failed while ${label}. Verify the selected credentials have the required IAM access for this project.${detail ? ` ${detail}` : ''}`
    )
  }

  if (outputIndicatesQuotaExceeded(detail)) {
    return new Error(
      `Google Cloud API quota exceeded while ${label}. Wait a moment and try again, or request a quota increase in the Cloud Console.${detail ? ` ${detail}` : ''}`
    )
  }

  if (outputIndicatesNotFound(detail)) {
    return new Error(
      `Google Cloud resource not found while ${label}.${detail ? ` ${detail}` : ''}`
    )
  }

  return new Error(`Google Cloud SDK failed while ${label}.${detail ? ` ${detail}` : ''}`)
}

// ── Request with Retry ──────────────────────────────────────────────────────────

export type GcpRequestOptions = {
  data?: unknown
  headers?: Record<string, string>
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST'
  responseType?: 'arraybuffer' | 'json' | 'text'
  url: string
}

const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 500

function isRetryableStatusCode(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // HTTP 429 (rate limit) and 503 (service unavailable) are retryable
  return /\b429\b/.test(message)
    || /\b503\b/.test(message)
    || /ECONNRESET/i.test(message)
    || /socket hang up/i.test(message)
    || /ETIMEDOUT/i.test(message)
    || /resource exhausted/i.test(message)
    || /rate limit/i.test(message)
    || /too many requests/i.test(message)
}

/**
 * Sends an authenticated GCP REST API request with automatic retry for
 * transient failures (429, 503, connection resets).
 *
 * @param projectId  The GCP project ID used for auth scoping.
 * @param options    URL, method, data, and other request options.
 * @returns          The parsed response body.
 */
export async function requestGcp<T>(projectId: string, options: GcpRequestOptions): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await getGcpAuth(projectId).getClient()
      const response = await client.request<T>({
        url: options.url,
        method: options.method ?? 'GET',
        headers: options.headers,
        data: options.data,
        responseType: options.responseType
      })

      return response.data
    } catch (error) {
      lastError = error

      if (attempt < MAX_RETRIES && isRetryableStatusCode(error)) {
        // Exponential backoff with ±25% jitter
        const baseDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
        const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1)
        const delayMs = Math.max(0, Math.round(baseDelay + jitter))

        logWarn('gcp.request.retry', `Retrying GCP request (attempt ${attempt}/${MAX_RETRIES}).`, {
          url: options.url,
          attempt,
          delayMs
        }, error)

        incrementAmbientRetryCount()
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        continue
      }

      throw error
    }
  }

  // Should not reach here, but just in case
  throw lastError
}
