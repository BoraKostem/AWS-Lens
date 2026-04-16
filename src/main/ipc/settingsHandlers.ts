import { ipcMain, type BrowserWindow } from 'electron'

import type {
  AppDiagnosticsFailureInput,
  AppDiagnosticsSnapshot,
  AppSecuritySummary,
  AppSettings,
  CloudProviderId
} from '@shared/types'
import { getAppSettings, resetAppSettings, updateAppSettings } from '../appSettings'
import { getVisibleServiceCatalog, getVisibleWorkspaceCatalog } from '../catalog'
import { exportDiagnosticsBundle } from '../diagnostics'
import { recordDiagnosticsFailure, updateDiagnosticsActiveContext } from '../diagnosticsState'
import { detectProviderCliStatus, getEnvironmentHealthReport } from '../environment'
import { getVaultEntryCounts } from '../localVault'
import { checkForAppUpdates, downloadAppUpdate, getReleaseInfo, installAppUpdate } from '../releaseCheck'
import { listProviders } from '../providerRegistry'
import { wrap } from './shared'

export function registerSettingsHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('providers:list', async () => wrap(() => listProviders()))
  ipcMain.handle('providers:cli-status', async () => wrap(() => detectProviderCliStatus()))
  ipcMain.handle('workspace-catalog:get', async (_event, providerId?: CloudProviderId) =>
    wrap(() => getVisibleWorkspaceCatalog(providerId ?? 'aws', getAppSettings().features))
  )
  ipcMain.handle('services:list', async (_event, providerId?: CloudProviderId) =>
    wrap(() => getVisibleServiceCatalog(providerId ?? 'aws', getAppSettings().features))
  )

  ipcMain.handle('app:release-info', async () => wrap(() => getReleaseInfo()))
  ipcMain.handle('app:settings:get', async () => wrap(() => getAppSettings()))
  ipcMain.handle('app:settings:update', async (_event, update: Partial<AppSettings>) => wrap(() => updateAppSettings(update)))
  ipcMain.handle('app:settings:reset', async () => wrap(() => resetAppSettings()))
  ipcMain.handle('app:security-summary', async () => wrap<AppSecuritySummary>(() => ({
    vaultEntryCounts: getVaultEntryCounts()
  })))
  ipcMain.handle('app:environment-health', async () => wrap(() => getEnvironmentHealthReport()))

  ipcMain.handle('app:update:check', async () => wrap(() => checkForAppUpdates()))
  ipcMain.handle('app:update:download', async () => wrap(() => downloadAppUpdate()))
  ipcMain.handle('app:update:install', async () => wrap(() => installAppUpdate()))
  ipcMain.handle('app:diagnostics:set-active-context', async (_event, context: AppDiagnosticsSnapshot) =>
    wrap(() => updateDiagnosticsActiveContext(context))
  )
  ipcMain.handle('app:diagnostics:record-failure', async (_event, input: AppDiagnosticsFailureInput) =>
    wrap(() => recordDiagnosticsFailure(input))
  )
  ipcMain.handle('app:export-diagnostics', async (_event, snapshot: AppDiagnosticsSnapshot | undefined) => wrap(() => exportDiagnosticsBundle(getWindow(), snapshot)))
}
