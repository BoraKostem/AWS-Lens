import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { app, dialog, type BrowserWindow } from 'electron'

import { PRODUCT_BRAND_SLUG } from '@shared/branding'
import type { AppDiagnosticsExportResult, AppDiagnosticsSnapshot } from '@shared/types'
import { getDiagnosticsSnapshot, updateDiagnosticsActiveContext } from './diagnosticsState'
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
  return `${PRODUCT_BRAND_SLUG}-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`
}

export async function exportDiagnosticsBundle(owner?: BrowserWindow | null, snapshot?: AppDiagnosticsSnapshot): Promise<AppDiagnosticsExportResult> {
  if (snapshot) {
    updateDiagnosticsActiveContext(snapshot)
  }

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
  const diagnosticsState = getDiagnosticsSnapshot()
  const workspaceContext = snapshot ?? diagnosticsState.activeContext ?? undefined

  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(buildManifest(logPath), null, 2)}\n`, 'utf-8'))
  zip.addFile('release-info.json', Buffer.from(`${JSON.stringify(releaseInfo, null, 2)}\n`, 'utf-8'))
  zip.addFile('audit-events.json', Buffer.from(`${JSON.stringify(auditEvents, null, 2)}\n`, 'utf-8'))
  zip.addFile('terraform-run-history.json', Buffer.from(`${JSON.stringify(terraformHistory, null, 2)}\n`, 'utf-8'))
  if (workspaceContext) {
    zip.addFile('workspace-context.json', Buffer.from(`${JSON.stringify(workspaceContext, null, 2)}\n`, 'utf-8'))
  }
  zip.addFile('diagnostics-session.json', Buffer.from(`${JSON.stringify(diagnosticsState, null, 2)}\n`, 'utf-8'))

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
