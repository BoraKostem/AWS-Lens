import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage } from 'electron'

import { hasPendingAwsCredentialActivity, waitForAwsCredentialActivity } from './aws/client'
import { registerAwsIpcHandlers } from './awsIpc'
import { registerCompareIpcHandlers } from './compareIpc'
import { registerComplianceIpcHandlers } from './complianceIpc'
import { registerEc2IpcHandlers } from './ec2Ipc'
import { assertEnterpriseAccess, recordEnterpriseAuditEvent } from './enterprise'
import { registerEcrIpcHandlers } from './ecrIpc'
import { registerEksIpcHandlers } from './eksIpc'
import { registerIpcHandlers } from './ipc'
import { registerOverviewIpcHandlers } from './overviewIpc'
import { registerSecurityIpcHandlers } from './securityIpc'
import { registerServiceIpcHandlers } from './serviceIpc'
import { registerSgIpcHandlers } from './sgIpc'
import { registerTerminalIpcHandlers } from './terminalIpc'
import { registerVpcIpcHandlers } from './vpcIpc'
import { initializeObservability, logError, logInfo, logWarn } from './observability'
import { startReleaseCheck } from './releaseCheck'
import { hasActiveTerraformApplyOrDestroy } from './terraform'

let mainWindow: BrowserWindow | null = null
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function showTerraformCloseWarning(owner?: BrowserWindow): number {
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Close App'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Terraform operation in progress',
    message: 'Terraform apply or destroy is still running.',
    detail: 'Closing the app now can interrupt the operation and leave infrastructure in a partially changed state.'
  }

  return owner ? dialog.showMessageBoxSync(owner, options) : dialog.showMessageBoxSync(options)
}

/* ── Graceful shutdown: track in-flight IPC requests ─────── */
const pendingRequests = new Set<Promise<unknown>>()
type HandlerFailure = { ok: false; error: string }

function asHandlerFailure(error: unknown): HandlerFailure {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }
}

const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel: string, listener: (...args: any[]) => any) => {
  originalHandle(channel, async (...args: any[]) => {
    const enterpriseArgs = args.slice(1)
    let settings

    try {
      settings = assertEnterpriseAccess(channel, enterpriseArgs)
    } catch (error) {
      logWarn('ipc.enterprise-blocked', `IPC call ${channel} was blocked before execution.`, {
        channel
      }, error)
      const fallbackSettings = { accessMode: 'read-only', updatedAt: '' } as const
      await recordEnterpriseAuditEvent(
        channel,
        enterpriseArgs,
        error instanceof Error && error.message.includes('read-only mode') ? 'blocked' : 'failed',
        fallbackSettings,
        error instanceof Error ? error.message : String(error)
      )
      return asHandlerFailure(error)
    }

    try {
      const result = listener(...args)
      if (result && typeof result.then === 'function') {
        pendingRequests.add(result)
        try {
          const settled = await result
          pendingRequests.delete(result)
          logInfo('ipc.async-success', `IPC call ${channel} completed.`, { channel })
          await recordEnterpriseAuditEvent(channel, enterpriseArgs, 'success', settings)
          return settled
        } catch (error) {
          pendingRequests.delete(result)
          logError('ipc.async-failure', `IPC call ${channel} failed.`, { channel }, error)
          await recordEnterpriseAuditEvent(
            channel,
            enterpriseArgs,
            error instanceof Error && error.message.includes('read-only mode') ? 'blocked' : 'failed',
            settings,
            error instanceof Error ? error.message : String(error)
          )
          return asHandlerFailure(error)
        }
      }

      logInfo('ipc.sync-success', `IPC call ${channel} completed synchronously.`, { channel })
      await recordEnterpriseAuditEvent(channel, enterpriseArgs, 'success', settings)
      return result
    } catch (error) {
      logError('ipc.sync-failure', `IPC call ${channel} failed synchronously.`, { channel }, error)
      await recordEnterpriseAuditEvent(
        channel,
        enterpriseArgs,
        'failed',
        settings,
        error instanceof Error ? error.message : String(error)
      )
      return asHandlerFailure(error)
    }
  })
}

initializeObservability()

function resolvePreloadPath(): string {
  const candidates = [
    path.join(__dirname, '../preload/index.mjs'),
    path.join(__dirname, '../preload/index.js'),
    path.join(process.cwd(), 'out/preload/index.mjs'),
    path.join(process.cwd(), 'out/preload/index.js')
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return candidates[0]
}

function resolveIconPath(forDock = false): string {
  // nativeImage doesn't read .icns properly, so use PNG for dock icon on macOS
  const ext = process.platform === 'darwin'
    ? (forDock ? 'png' : 'icns')
    : process.platform === 'win32' ? 'ico' : 'png'
  const filename = forDock ? 'aws-lens-logo-dock' : 'aws-lens-logo'
  const candidates = [
    path.join(process.resourcesPath, 'assets', `${filename}.${ext}`),
    path.join(app.getAppPath(), `assets/${filename}.${ext}`),
    path.join(__dirname, `../../assets/${filename}.${ext}`),
    path.join(process.cwd(), `assets/${filename}.${ext}`)
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Fallback to regular icon if dock-specific not found
  if (forDock) return resolveIconPath(false)
  return candidates[0]
}

function createWindow(): void {
  const iconPath = resolveIconPath()
  const icon = nativeImage.createFromPath(iconPath)

  // Set dock icon on macOS (Windows/Linux use BrowserWindow.icon automatically)
  if (process.platform === 'darwin' && app.dock) {
    const dockIconPath = resolveIconPath(true)
    const dockIcon = nativeImage.createFromPath(dockIconPath)
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon)
    }
  }

  mainWindow = new BrowserWindow({
    title: 'AWS Lens',
    icon: icon.isEmpty() ? undefined : icon,
    width: 1640,
    height: 1040,
    minWidth: 1280,
    minHeight: 800,
    backgroundColor: '#0d1417',
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (isQuitting || !hasActiveTerraformApplyOrDestroy()) {
      return
    }

    const choice = showTerraformCloseWarning(mainWindow ?? undefined)

    if (choice === 0) {
      event.preventDefault()
      return
    }

    isQuitting = true
  })
}

app.whenReady().then(() => {
  logInfo('app.ready', 'Electron app is ready.')
  Menu.setApplicationMenu(null)
  registerIpcHandlers(() => mainWindow)
  registerAwsIpcHandlers()
  registerCompareIpcHandlers()
  registerComplianceIpcHandlers()
  registerEc2IpcHandlers()
  registerEcrIpcHandlers()
  registerEksIpcHandlers(() => mainWindow)
  registerOverviewIpcHandlers()
  registerSecurityIpcHandlers()
  registerServiceIpcHandlers()
  registerSgIpcHandlers()
  registerTerminalIpcHandlers()
  registerVpcIpcHandlers()
  startReleaseCheck()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let isQuitting = false
app.on('before-quit', (e) => {
  if (!isQuitting && hasActiveTerraformApplyOrDestroy()) {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const choice = showTerraformCloseWarning(owner)

    if (choice === 0) {
      e.preventDefault()
      return
    }

    isQuitting = true
  }

  if (isQuitting || (pendingRequests.size === 0 && !hasPendingAwsCredentialActivity())) return
  isQuitting = true
  e.preventDefault()
  const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000))
  Promise.race([
    Promise.all([
      Promise.allSettled([...pendingRequests]),
      waitForAwsCredentialActivity(5000)
    ]),
    timeout
  ]).then(() => {
    app.quit()
  })
})
