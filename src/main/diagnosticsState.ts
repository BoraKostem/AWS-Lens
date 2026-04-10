import path from 'node:path'

import { app } from 'electron'

import type {
  AppDiagnosticsActiveContext,
  AppDiagnosticsFailureInput
} from '@shared/types'
import { logWarn } from './observability'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type PersistedDiagnosticsFailureRecord = AppDiagnosticsFailureInput & {
  capturedAt: string
  activeContext: AppDiagnosticsActiveContext | null
}

type DiagnosticsStateSnapshot = {
  version: 1
  updatedAt: string
  activeContext: AppDiagnosticsActiveContext | null
  lastFailedAction: PersistedDiagnosticsFailureRecord | null
}

const EMPTY_STATE: DiagnosticsStateSnapshot = {
  version: 1,
  updatedAt: '',
  activeContext: null,
  lastFailedAction: null
}

function diagnosticsStatePath(): string {
  return path.join(app.getPath('userData'), 'diagnostics-session.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isDiagnosticsActiveContext(value: unknown): value is AppDiagnosticsActiveContext {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return false
  }

  return (
    typeof raw.generatedAt === 'string' &&
    typeof raw.activeProviderId === 'string' &&
    typeof raw.activeScreen === 'string' &&
    typeof raw.selectedServiceId === 'string' &&
    typeof raw.accessMode === 'string' &&
    typeof raw.terminalOpen === 'boolean' &&
    typeof raw.terminalContextReady === 'boolean' &&
    typeof raw.selectedPreviewModeId === 'string' &&
    typeof raw.selectedPreviewModeLabel === 'string'
  )
}

function sanitizeFailureRecord(value: unknown): PersistedDiagnosticsFailureRecord | null {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return null
  }

  const action = sanitizeString(raw.action)
  const message = sanitizeString(raw.message)
  const rawMessage = sanitizeString(raw.rawMessage)
  const providerId = sanitizeString(raw.providerId)
  const serviceId = sanitizeString(raw.serviceId)
  const capturedAt = sanitizeString(raw.capturedAt)

  if (!action || !message || !capturedAt) {
    return null
  }

  return {
    action,
    message,
    rawMessage,
    providerId: providerId as AppDiagnosticsFailureInput['providerId'],
    serviceId: serviceId as AppDiagnosticsFailureInput['serviceId'],
    capturedAt,
    activeContext: isDiagnosticsActiveContext(raw.activeContext) ? raw.activeContext : null
  }
}

function sanitizeState(value: unknown): DiagnosticsStateSnapshot {
  const raw = isRecord(value) ? value : {}

  return {
    version: 1,
    updatedAt: sanitizeString(raw.updatedAt),
    activeContext: isDiagnosticsActiveContext(raw.activeContext) ? raw.activeContext : null,
    lastFailedAction: sanitizeFailureRecord(raw.lastFailedAction)
  }
}

function readState(): DiagnosticsStateSnapshot {
  return sanitizeState(readSecureJsonFile<DiagnosticsStateSnapshot>(diagnosticsStatePath(), {
    fallback: EMPTY_STATE,
    fileLabel: 'Diagnostics session'
  }))
}

function writeState(state: DiagnosticsStateSnapshot): void {
  try {
    writeSecureJsonFile(diagnosticsStatePath(), sanitizeState(state), 'Diagnostics session')
  } catch (error) {
    logWarn('diagnostics.state.write-failed', 'Failed to persist diagnostics session state.', undefined, error)
  }
}

let diagnosticsState = readState()

export function getDiagnosticsSnapshot(): DiagnosticsStateSnapshot {
  return diagnosticsState
}

export function updateDiagnosticsActiveContext(context: AppDiagnosticsActiveContext): void {
  diagnosticsState = {
    ...diagnosticsState,
    updatedAt: context.generatedAt,
    activeContext: context
  }

  writeState(diagnosticsState)
}

export function recordDiagnosticsFailure(input: AppDiagnosticsFailureInput): void {
  const capturedAt = new Date().toISOString()

  diagnosticsState = {
    ...diagnosticsState,
    updatedAt: capturedAt,
    lastFailedAction: {
      ...input,
      rawMessage: input.rawMessage || input.message,
      capturedAt,
      activeContext: diagnosticsState.activeContext
    }
  }

  writeState(diagnosticsState)
}
