import type { BrowserWindow } from 'electron'
import { registerAwsHandlers } from './awsHandlers'
import { registerAzureHandlers } from './azureHandlers'
import { registerEnterpriseHandlers } from './enterpriseHandlers'
import { registerGcpHandlers } from './gcpHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerShellHandlers } from './shellHandlers'

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  registerSettingsHandlers(getWindow)
  registerShellHandlers()
  registerAzureHandlers(getWindow)
  registerGcpHandlers()
  registerAwsHandlers(getWindow)
  registerEnterpriseHandlers(getWindow)
}
