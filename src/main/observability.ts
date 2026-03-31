import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

export type LogLevel = 'info' | 'warn' | 'error'

type SerializableContext = Record<string, unknown>

type AppLogEntry = {
  timestamp: string
  level: LogLevel
  event: string
  message: string
  context?: SerializableContext
  error?: {
    name: string
    message: string
    stack: string
  }
}

const SENSITIVE_PATTERNS = [
  /secret/i,
  /token/i,
  /password/i,
  /accesskey/i,
  /secretaccesskey/i,
  /sessiontoken/i,
  /authorization/i,
  /credential/i
]

let initialized = false

function fallbackLogsDir(): string {
  return path.join(process.cwd(), '.tmp', 'logs')
}

function logsDir(): string {
  try {
    return path.join(app.getPath('userData'), 'logs')
  } catch {
    return fallbackLogsDir()
  }
}

function logFilePath(): string {
  return path.join(logsDir(), 'app.log')
}

function ensureLogsDir(): void {
  fs.mkdirSync(logsDir(), { recursive: true })
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key))
}

function redactValue(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) {
    return '[REDACTED]'
  }

  if (value === null || value === undefined) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item))
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? ''
    }
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey)
      ])
    )
  }

  if (typeof value === 'string' && value.length > 4000) {
    return `${value.slice(0, 4000)}...[truncated]`
  }

  return value
}

function normalizeContext(context?: SerializableContext): SerializableContext | undefined {
  if (!context) {
    return undefined
  }

  return redactValue(context) as SerializableContext
}

function normalizeError(error: unknown): AppLogEntry['error'] | undefined {
  if (!error) {
    return undefined
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? ''
    }
  }

  return {
    name: 'UnknownError',
    message: String(error),
    stack: ''
  }
}

function appendEntry(entry: AppLogEntry): void {
  try {
    ensureLogsDir()
    fs.appendFileSync(logFilePath(), `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch {
    // Logging must never break the app.
  }
}

export function logEvent(
  level: LogLevel,
  event: string,
  message: string,
  context?: SerializableContext,
  error?: unknown
): void {
  appendEntry({
    timestamp: new Date().toISOString(),
    level,
    event,
    message,
    context: normalizeContext(context),
    error: normalizeError(error)
  })
}

export function logInfo(event: string, message: string, context?: SerializableContext): void {
  logEvent('info', event, message, context)
}

export function logWarn(event: string, message: string, context?: SerializableContext, error?: unknown): void {
  logEvent('warn', event, message, context, error)
}

export function logError(event: string, message: string, context?: SerializableContext, error?: unknown): void {
  logEvent('error', event, message, context, error)
}

export function initializeObservability(): void {
  if (initialized) {
    return
  }

  initialized = true

  process.on('uncaughtException', (error) => {
    logError('process.uncaught-exception', 'Unhandled exception reached the process boundary.', undefined, error)
  })

  process.on('unhandledRejection', (reason) => {
    logError('process.unhandled-rejection', 'Unhandled promise rejection reached the process boundary.', undefined, reason)
  })

  app.on('render-process-gone', (_event, webContents, details) => {
    logError('app.render-process-gone', 'Renderer process exited unexpectedly.', {
      reason: details.reason,
      exitCode: details.exitCode,
      webContentsId: webContents.id,
      url: webContents.getURL()
    })
  })

  app.on('child-process-gone', (_event, details) => {
    logWarn('app.child-process-gone', 'Electron child process exited.', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName ?? ''
    })
  })
}

export function getStructuredLogPath(): string {
  ensureLogsDir()
  return logFilePath()
}
