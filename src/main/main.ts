import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session } from 'electron'

import { LEGACY_APP_DATA_DIRECTORY, PRODUCT_BRAND_NAME } from '@shared/branding'
import { hasPendingAwsCredentialActivity, waitForAwsCredentialActivity } from './aws/client'
import { assertEnterpriseAccess, recordEnterpriseAuditEvent } from './enterprise'
import { registerIpcHandlers } from './ipc'
import { initializeObservability, logError, logInfo, logWarn } from './observability'
import { registerProviderIpcHandlers } from './providerIpcRegistry'
import { startReleaseCheck } from './releaseCheck'
import { hasActiveTerraformApplyOrDestroy } from './terraform'

let mainWindow: BrowserWindow | null = null
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function ensureDirectory(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true })
}

function configureAppStoragePaths(): void {
  const appDataPath = app.getPath('appData')
  const rootDataPath = path.join(appDataPath, LEGACY_APP_DATA_DIRECTORY)
  const sessionDataPath = path.join(rootDataPath, 'session')
  const cachePath = path.join(sessionDataPath, 'Cache')
  const gpuCachePath = path.join(sessionDataPath, 'GPUCache')

  ensureDirectory(rootDataPath)
  ensureDirectory(sessionDataPath)
  ensureDirectory(cachePath)
  ensureDirectory(gpuCachePath)

  app.setPath('userData', rootDataPath)
  app.setPath('sessionData', sessionDataPath)
  app.commandLine.appendSwitch('disk-cache-dir', cachePath)
  app.commandLine.appendSwitch('disk-cache-size', `${64 * 1024 * 1024}`)
}

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
type IpcHandleListener = Parameters<typeof originalHandle>[1]
ipcMain.handle = (channel: string, listener: IpcHandleListener) => {
  originalHandle(channel, async (...args: Parameters<IpcHandleListener>) => {
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
          try { await recordEnterpriseAuditEvent(channel, enterpriseArgs, 'success', settings) } catch { /* audit failure must not fail the IPC call */ }
          return settled
        } catch (error) {
          pendingRequests.delete(result)
          logError('ipc.async-failure', `IPC call ${channel} failed.`, { channel }, error)
          try {
            await recordEnterpriseAuditEvent(
              channel,
              enterpriseArgs,
              error instanceof Error && error.message.includes('read-only mode') ? 'blocked' : 'failed',
              settings,
              error instanceof Error ? error.message : String(error)
            )
          } catch { /* audit failure must not fail the IPC call */ }
          return asHandlerFailure(error)
        }
      }

      logInfo('ipc.sync-success', `IPC call ${channel} completed synchronously.`, { channel })
      try { await recordEnterpriseAuditEvent(channel, enterpriseArgs, 'success', settings) } catch { /* audit failure must not fail the IPC call */ }
      return result
    } catch (error) {
      logError('ipc.sync-failure', `IPC call ${channel} failed synchronously.`, { channel }, error)
      try {
        await recordEnterpriseAuditEvent(
          channel,
          enterpriseArgs,
          'failed',
          settings,
          error instanceof Error ? error.message : String(error)
        )
      } catch { /* audit failure must not fail the IPC call */ }
      return asHandlerFailure(error)
    }
  })
}

configureAppStoragePaths()
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
    title: PRODUCT_BRAND_NAME,
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

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        ]
      }
    })
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
  registerProviderIpcHandlers({ getWindow: () => mainWindow })
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
  e.preventDefault()
  if (isQuitting) return
  isQuitting = true
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
