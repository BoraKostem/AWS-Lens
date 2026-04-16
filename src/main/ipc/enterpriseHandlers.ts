import { ipcMain, type BrowserWindow } from 'electron'
import { exportEnterpriseAuditEvents, getEnterpriseSettings, listEnterpriseAuditEvents, setEnterpriseAccessMode } from '../enterprise'
import { wrap } from './shared'

export function registerEnterpriseHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('enterprise:get-settings', async () => wrap(() => getEnterpriseSettings()))
  ipcMain.handle('enterprise:set-access-mode', async (_event, accessMode: 'read-only' | 'operator') =>
    wrap(() => setEnterpriseAccessMode(accessMode))
  )
  ipcMain.handle('enterprise:audit:list', async () => wrap(() => listEnterpriseAuditEvents()))
  ipcMain.handle('enterprise:audit:export', async () => wrap(() => exportEnterpriseAuditEvents(getWindow())))
}
