import { logInfo, logWarn } from './observability'

export type OperationOptions = {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  context?: Record<string, unknown>
  retryOn?: (error: unknown) => boolean
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

export async function executeOperation<T>(
  name: string,
  fn: () => Promise<T>,
  options: OperationOptions = {}
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 0)
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 400)
  let attempt = 0

  while (true) {
    const startedAt = Date.now()
    attempt += 1

    logInfo('operation.start', `Starting ${name}.`, {
      operation: name,
      attempt,
      retries,
      ...options.context
    })

    try {
      const result = options.timeoutMs && options.timeoutMs > 0
        ? await withTimeout(fn(), options.timeoutMs, name)
        : await fn()

      logInfo('operation.success', `Completed ${name}.`, {
        operation: name,
        attempt,
        durationMs: Date.now() - startedAt,
        ...options.context
      })

      return result
    } catch (error) {
      const canRetry = attempt <= retries && (options.retryOn ? options.retryOn(error) : isRetryableError(error))

      logWarn('operation.failure', `Operation ${name} failed.`, {
        operation: name,
        attempt,
        durationMs: Date.now() - startedAt,
        willRetry: canRetry,
        ...options.context
      }, error)

      if (!canRetry) {
        throw error
      }

      await delay(retryDelayMs * attempt)
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
