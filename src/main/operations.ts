import { logInfo, logWarn } from './observability'

export type OperationOptions = {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  context?: Record<string, unknown>
  retryOn?: (error: unknown) => boolean
  /**
   * Observability hook. Called once per attempt with the current 1-based attempt number
   * (attempt=1 is the first try). Exceptions thrown inside the callback are swallowed so
   * instrumentation never breaks the operation.
   */
  onAttempt?: (attempt: number) => void
}

export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationTimeoutError'
  }
}

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

const RETRYABLE_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /throttl/i,
  /rate exceeded/i,
  /too many requests/i,
  /econnreset/i,
  /socket hang up/i,
  /temporar/i,
  /network/i
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableError(error: unknown): boolean {
  const message = errorMessage(error)
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OperationTimeoutError(`${name} timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    promise.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

const SENSITIVE_CONTEXT_KEYS = new Set([
  'password', 'secret', 'token', 'key', 'apiKey', 'api_key',
  'accessKey', 'access_key', 'secretKey', 'secret_key',
  'credential', 'credentials', 'authorization', 'auth'
])

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> {
  if (!context) return {}
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(context)) {
    result[k] = SENSITIVE_CONTEXT_KEYS.has(k.toLowerCase()) ? '[redacted]' : v
  }
  return result
}

export async function executeOperation<T>(
  name: string,
  fn: () => Promise<T>,
  options: OperationOptions = {}
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 0)
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 400)
  const safeCtx = sanitizeContext(options.context)
  let attempt = 0

  while (true) {
    const startedAt = Date.now()
    attempt += 1

    if (options.onAttempt) {
      try {
        options.onAttempt(attempt)
      } catch {
        // Observability must never break the operation.
      }
    }

    logInfo('operation.start', `Starting ${name}.`, {
      operation: name,
      attempt,
      retries,
      ...safeCtx
    })

    try {
      const result = options.timeoutMs && options.timeoutMs > 0
        ? await withTimeout(fn(), options.timeoutMs, name)
        : await fn()

      logInfo('operation.success', `Completed ${name}.`, {
        operation: name,
        attempt,
        durationMs: Date.now() - startedAt,
        ...safeCtx
      })

      return result
    } catch (error) {
      const canRetry = attempt <= retries && (options.retryOn ? options.retryOn(error) : isRetryableError(error))

      logWarn('operation.failure', `Operation ${name} failed.`, {
        operation: name,
        attempt,
        durationMs: Date.now() - startedAt,
        willRetry: canRetry,
        ...safeCtx
      }, error)

      if (!canRetry) {
        throw error
      }

      // Exponential backoff with ±25% jitter to reduce retry storms
      const baseDelay = retryDelayMs * Math.pow(2, attempt - 1)
      const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1)
      await delay(Math.max(0, Math.round(baseDelay + jitter)))
    }
  }
}

export function createHandlerWrapper(
  scope: string,
  defaults: OperationOptions = {}
): <T>(fn: () => Promise<T> | T, label?: string, options?: OperationOptions) => Promise<HandlerResult<T>> {
  return async function wrap<T>(
    fn: () => Promise<T> | T,
    label = 'handler',
    options: OperationOptions = {}
  ): Promise<HandlerResult<T>> {
    try {
      const data = await executeOperation(`${scope}.${label}`, () => Promise.resolve(fn()), {
        ...defaults,
        ...options,
        context: {
          ...(defaults.context ?? {}),
          ...(options.context ?? {})
        }
      })

      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }
}
