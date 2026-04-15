import { DefaultAzureCredential, type TokenCredential } from '@azure/identity'
import { getSdkCredential } from './auth'
import { logWarn } from '../observability'
import { incrementAmbientRetryCount } from '../terraformAudit'

// ── Constants ───────────────────────────────────────────────────────────────────

/** Maximum number of continuation pages to follow via nextLink. */
export const MAX_PAGINATION_PAGES = 200

const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 500

// ── Credential & Token Cache ────────────────────────────────────────────────────

let azureCredential: DefaultAzureCredential | null = null

interface CachedToken {
  token: string
  expiresAt: number // epoch ms
}

let cachedToken: CachedToken | null = null
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

/**
 * Returns the active Azure credential. Prefers the SDK credential (from device
 * code auth) when available, falling back to DefaultAzureCredential.
 */
export function getAzureCredential(): TokenCredential {
  const sdkCred = getSdkCredential()
  if (sdkCred) return sdkCred

  if (!azureCredential) {
    azureCredential = new DefaultAzureCredential()
  }
  return azureCredential
}

/**
 * Resets the credential singleton and clears the token cache.
 * Call this when the user signs out or re-authenticates.
 */
export function resetAzureCredential(): void {
  azureCredential = null
  cachedToken = null
}

/**
 * Returns a cached management-plane access token, refreshing only when
 * the token is expired or within TOKEN_REFRESH_BUFFER_MS of expiry.
 */
export async function getAzureAccessToken(): Promise<string> {
  const now = Date.now()

  if (cachedToken && cachedToken.expiresAt - now > TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.token
  }

  const result = await getAzureCredential().getToken('https://management.azure.com/.default')
  if (!result?.token) {
    throw new Error('Azure credential chain did not return a management-plane access token.')
  }

  cachedToken = {
    token: result.token,
    expiresAt: result.expiresOnTimestamp ?? (now + 60 * 60 * 1000)
  }

  return cachedToken.token
}

// ── Error Classification ────────────────────────────────────────────────────────

/**
 * Classifies an Azure error into a human-readable Error with remediation guidance.
 */
export function classifyAzureError(label: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim()
  const normalized = detail.toLowerCase()

  if (normalized.includes('401') || normalized.includes('unauthorized') || normalized.includes('authentication_failed')) {
    return new Error(
      `Azure authentication failed while ${label}. Run "az login" to refresh credentials.${detail ? ` ${detail}` : ''}`
    )
  }

  if (normalized.includes('403') || normalized.includes('forbidden') || normalized.includes('authorization failed') || normalized.includes('does not have authorization')) {
    return new Error(
      `Azure authorization failed while ${label}. Verify the signed-in account has the required RBAC role for this subscription.${detail ? ` ${detail}` : ''}`
    )
  }

  if (normalized.includes('404') || normalized.includes('not found') || normalized.includes('resource not found')) {
    return new Error(
      `Azure resource not found while ${label}.${detail ? ` ${detail}` : ''}`
    )
  }

  if (normalized.includes('subscription') && (normalized.includes('not found') || normalized.includes('not registered'))) {
    return new Error(
      `Azure subscription not found or not registered while ${label}. Verify the subscription ID is correct and the resource provider is registered.${detail ? ` ${detail}` : ''}`
    )
  }

  if (normalized.includes('429') || normalized.includes('too many requests') || normalized.includes('throttl') || normalized.includes('rate limit')) {
    return new Error(
      `Azure API rate limit exceeded while ${label}. Wait a moment and try again.${detail ? ` ${detail}` : ''}`
    )
  }

  if (/\b5\d{2}\b/.test(detail) || normalized.includes('internal server error') || normalized.includes('service unavailable') || normalized.includes('bad gateway')) {
    return new Error(
      `Azure service error while ${label}. This may be a transient issue — try again shortly.${detail ? ` ${detail}` : ''}`
    )
  }

  return new Error(`Azure ARM request failed while ${label}.${detail ? ` ${detail}` : ''}`)
}

// ── Retry Logic ─────────────────────────────────────────────────────────────────

function isRetryableResponse(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b429\b/.test(message)
    || /\b503\b/.test(message)
    || /\b502\b/.test(message)
    || /ECONNRESET/i.test(message)
    || /socket hang up/i.test(message)
    || /ETIMEDOUT/i.test(message)
    || /too many requests/i.test(message)
    || /throttl/i.test(message)
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null
  const seconds = parseInt(headerValue, 10)
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 120) {
    return seconds * 1000
  }
  return null
}

// ── ARM Request with Retry ──────────────────────────────────────────────────────

/**
 * Sends an authenticated Azure ARM REST API request with automatic retry
 * for throttling (429) and transient server errors (502/503/504).
 * Parses the `Retry-After` header when present.
 */
export async function fetchAzureArmJson<T>(path: string, apiVersion: string, init?: RequestInit): Promise<T> {
  const url = /^https?:\/\//i.test(path)
    ? path
    : `https://management.azure.com${path}${path.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(apiVersion)}`

  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response: Response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${await getAzureAccessToken()}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {})
        }
      })

      if (response.ok) {
        return await response.json() as T
      }

      // Retryable status codes
      if (attempt < MAX_RETRIES && isRetryableResponse(response.status)) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'))
        const baseDelay = retryAfterMs ?? BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
        const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1)
        const delayMs = Math.max(0, Math.round(baseDelay + jitter))

        logWarn('azure.arm.retry', `Retrying Azure ARM request (attempt ${attempt}/${MAX_RETRIES}, status ${response.status}).`, {
          url,
          attempt,
          status: response.status,
          delayMs
        })

        incrementAmbientRetryCount()
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        continue
      }

      const body = await response.text()
      throw new Error(`Azure ARM request failed (${response.status} ${response.statusText}): ${body || path}`)
    } catch (error) {
      lastError = error

      if (attempt < MAX_RETRIES && isRetryableError(error)) {
        const baseDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
        const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1)
        const delayMs = Math.max(0, Math.round(baseDelay + jitter))

        logWarn('azure.arm.retry', `Retrying Azure ARM request after error (attempt ${attempt}/${MAX_RETRIES}).`, {
          url,
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

  throw lastError
}

/**
 * Fetches a paginated Azure ARM collection, following nextLink continuation
 * tokens up to MAX_PAGINATION_PAGES.
 */
export async function fetchAzureArmCollection<T>(path: string, apiVersion: string): Promise<T[]> {
  const items: T[] = []
  let nextLink: string | null = path
  let pages = 0

  while (nextLink && pages < MAX_PAGINATION_PAGES) {
    const page: { value?: T[]; nextLink?: string } = await fetchAzureArmJson(nextLink, apiVersion)
    items.push(...(page.value ?? []))
    nextLink = page.nextLink ?? null
    pages++
  }

  return items
}

// ── Shared Utilities ────────────────────────────────────────────────────────────

/**
 * Maps items concurrently with a configurable concurrency limit.
 * Extracted as a shared utility for reuse across Azure modules.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  )

  return results
}
