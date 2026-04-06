import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { app, dialog, type BrowserWindow } from 'electron'

import type { AppDiagnosticsExportResult } from '@shared/types'
import { getDiagnosticsSnapshot } from './diagnosticsState'
import { listEnterpriseAuditEvents } from './enterprise'
import { listVaultEntries } from './localVault'
import { getStructuredLogPath } from './observability'
import { getReleaseInfo } from './releaseCheck'
import { listRunRecords } from './terraformHistoryStore'

type FileMetadata = {
  path: string
  exists: boolean
  sizeBytes: number
  modifiedAt: string
}

type SafeLogEntry = {
  timestamp: string
  level: string
  event: string
  message: string
  context?: Record<string, unknown>
  error?: {
    name: string
    message: string
    stack: string
  }
}

function toIsoOrEmpty(valueMs?: number): string {
  return valueMs ? new Date(valueMs).toISOString() : ''
}

function fileMetadata(filePath: string): FileMetadata {
  try {
    const stat = fs.statSync(filePath)
    return {
      path: filePath,
      exists: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString()
    }
  } catch {
    return {
      path: filePath,
      exists: false,
      sizeBytes: 0,
      modifiedAt: ''
    }
  }
}

function secureStoreMetadata() {
  const userData = app.getPath('userData')
  const stores = [
    'local-vault.json',
    'session-hub.json',
    'profile-registry.json',
    'terraform-workspace-state.json',
    'terraform-run-history.json',
    'enterprise-settings.json',
    'enterprise-audit-log.json'
  ]

  return {
    vaultEntryCounts: {
      all: listVaultEntries().length,
      awsProfiles: listVaultEntries('aws-profile').length,
      sshKeys: listVaultEntries('ssh-key').length,
      pem: listVaultEntries('pem').length,
      accessKeys: listVaultEntries('access-key').length
    },
    files: stores.map((filename) => fileMetadata(path.join(userData, filename)))
  }
}

function buildManifest(logPath: string) {
  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron ?? '',
      chromeVersion: process.versions.chrome ?? '',
      hostname: os.hostname(),
      release: os.release(),
      appPath: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      tempPath: app.getPath('temp'),
      documentsPath: app.getPath('documents')
    },
    structuredLog: fileMetadata(logPath),
    secureStores: secureStoreMetadata()
  }
}

function defaultBundleName(): string {
  return `aws-lens-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`
}

function readSafeLogTail(logPath: string, maxEntries = 160): SafeLogEntry[] {
  if (!fs.existsSync(logPath)) {
    return []
  }

  try {
    const lines = fs.readFileSync(logPath, 'utf-8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)

    return lines
      .slice(-maxEntries)
      .map((line) => {
        try {
          return JSON.parse(line) as SafeLogEntry
        } catch {
          return {
            timestamp: '',
            level: 'info',
            event: 'diagnostics.raw-log-line',
            message: line
          } satisfies SafeLogEntry
        }
      })
  } catch {
    return []
  }
}

function buildSafeLogSummary(entries: SafeLogEntry[]) {
  return {
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    errorCount: entries.filter((entry) => entry.level === 'error').length,
    warningCount: entries.filter((entry) => entry.level === 'warn').length,
    latestErrorAt: [...entries].reverse().find((entry) => entry.level === 'error')?.timestamp ?? '',
    latestEvents: entries.slice(-5).map((entry) => ({
      timestamp: entry.timestamp,
      level: entry.level,
      event: entry.event,
      message: entry.message
    }))
  }
}

export async function exportDiagnosticsBundle(owner?: BrowserWindow | null): Promise<AppDiagnosticsExportResult> {
  const generatedAt = new Date().toISOString()
  const result = owner
    ? await dialog.showSaveDialog(owner, {
        title: 'Export diagnostics bundle',
        defaultPath: path.join(app.getPath('documents'), defaultBundleName()),
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      })
    : await dialog.showSaveDialog({
        title: 'Export diagnostics bundle',
        defaultPath: path.join(app.getPath('documents'), defaultBundleName()),
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      })

  if (result.canceled || !result.filePath) {
    return { path: '', bundleEntries: 0, generatedAt }
  }

  const zip = new AdmZip()
  const logPath = getStructuredLogPath()
  const releaseInfo = await getReleaseInfo()
  const auditEvents = listEnterpriseAuditEvents()
  const terraformHistory = listRunRecords().slice(0, 200)
  const diagnosticsSnapshot = getDiagnosticsSnapshot()
  const safeLogTail = readSafeLogTail(logPath)
  const diagnosticsContext = {
    generatedAt,
    app: {
      name: app.getName(),
      version: app.getVersion()
    },
    activeContext: diagnosticsSnapshot.activeContext,
    lastFailedAction: diagnosticsSnapshot.lastFailedAction
  }

  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(buildManifest(logPath), null, 2)}\n`, 'utf-8'))
  zip.addFile('release-info.json', Buffer.from(`${JSON.stringify(releaseInfo, null, 2)}\n`, 'utf-8'))
  zip.addFile('audit-events.json', Buffer.from(`${JSON.stringify(auditEvents, null, 2)}\n`, 'utf-8'))
  zip.addFile('terraform-run-history.json', Buffer.from(`${JSON.stringify(terraformHistory, null, 2)}\n`, 'utf-8'))
  zip.addFile('diagnostics-context.json', Buffer.from(`${JSON.stringify(diagnosticsContext, null, 2)}\n`, 'utf-8'))
  zip.addFile('safe-log-summary.json', Buffer.from(`${JSON.stringify(buildSafeLogSummary(safeLogTail), null, 2)}\n`, 'utf-8'))
  zip.addFile('safe-log-tail.json', Buffer.from(`${JSON.stringify(safeLogTail, null, 2)}\n`, 'utf-8'))

  if (fs.existsSync(logPath)) {
    zip.addLocalFile(logPath, 'logs')
  }

  zip.writeZip(result.filePath)

  return {
    path: result.filePath,
    bundleEntries: zip.getEntries().length,
    generatedAt
  }
}
