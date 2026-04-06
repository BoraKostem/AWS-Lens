import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import type {
  AppDiagnosticsActiveContext,
  AppDiagnosticsFailureInput,
  AppDiagnosticsSnapshot
} from '@shared/types'

type PersistedDiagnosticsSnapshot = AppDiagnosticsSnapshot & {
  version: 1
}

function diagnosticsStatePath(): string {
  try {
    return path.join(app.getPath('userData'), 'diagnostics-session.json')
  } catch {
    return path.join(process.cwd(), '.tmp', 'diagnostics-session.json')
  }
}

function emptySnapshot(): PersistedDiagnosticsSnapshot {
  return {
    version: 1,
    updatedAt: '',
    activeContext: null,
    lastFailedAction: null
  }
}

function persistSnapshot(snapshot: PersistedDiagnosticsSnapshot): void {
  try {
    const filePath = diagnosticsStatePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  } catch {
    // Diagnostics persistence should never break the app.
  }
}

function loadSnapshot(): PersistedDiagnosticsSnapshot {
  try {
    const raw = fs.readFileSync(diagnosticsStatePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedDiagnosticsSnapshot>

    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      activeContext: parsed.activeContext ?? null,
      lastFailedAction: parsed.lastFailedAction ?? null
    }
  } catch {
    return emptySnapshot()
  }
}

let diagnosticsSnapshot = loadSnapshot()

export function getDiagnosticsSnapshot(): AppDiagnosticsSnapshot {
  return {
    updatedAt: diagnosticsSnapshot.updatedAt,
    activeContext: diagnosticsSnapshot.activeContext,
    lastFailedAction: diagnosticsSnapshot.lastFailedAction
  }
}

export function updateDiagnosticsActiveContext(context: AppDiagnosticsActiveContext): void {
  diagnosticsSnapshot = {
    ...diagnosticsSnapshot,
    updatedAt: context.capturedAt,
    activeContext: context
  }
  persistSnapshot(diagnosticsSnapshot)
}

export function recordDiagnosticsFailure(input: AppDiagnosticsFailureInput): void {
  const capturedAt = new Date().toISOString()

  diagnosticsSnapshot = {
    ...diagnosticsSnapshot,
    updatedAt: capturedAt,
    lastFailedAction: {
      ...input,
      capturedAt,
      activeContext: diagnosticsSnapshot.activeContext
    }
  }

  persistSnapshot(diagnosticsSnapshot)
}
