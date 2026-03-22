import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'

import { registerAwsIpcHandlers } from './awsIpc'
import { registerEc2IpcHandlers } from './ec2Ipc'
import { registerEcrIpcHandlers } from './ecrIpc'
import { registerEksIpcHandlers } from './eksIpc'
import { registerIpcHandlers } from './ipc'
import { registerOverviewIpcHandlers } from './overviewIpc'
import { registerSecurityIpcHandlers } from './securityIpc'
import { registerServiceIpcHandlers } from './serviceIpc'
import { registerSgIpcHandlers } from './sgIpc'
import { registerTerminalIpcHandlers } from './terminalIpc'
import { registerVpcIpcHandlers } from './vpcIpc'

let mainWindow: BrowserWindow | null = null
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/* ── Graceful shutdown: track in-flight IPC requests ─────── */
const pendingRequests = new Set<Promise<unknown>>()

const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel: string, listener: (...args: any[]) => any) => {
  originalHandle(channel, (...args: any[]) => {
    const result = listener(...args)
    if (result && typeof result.then === 'function') {
      pendingRequests.add(result)
      const cleanup = () => { pendingRequests.delete(result) }
      result.then(cleanup, cleanup)
    }
    return result
  })
}

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

function resolveIconPath(): string {
  const ext = process.platform === 'darwin' ? 'icns' : process.platform === 'win32' ? 'ico' : 'png'
  const candidates = [
    path.join(process.resourcesPath, 'assets', `aws-lens-logo.${ext}`),
    path.join(__dirname, `../../assets/aws-lens-logo.${ext}`),
    path.join(process.cwd(), `assets/aws-lens-logo.${ext}`)
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return candidates[0]
}

function createWindow(): void {
  const icon = nativeImage.createFromPath(resolveIconPath())

  mainWindow = new BrowserWindow({
    title: 'AWS Lens',
    icon,
    width: 1640,
    height: 1040,
    minWidth: 1280,
    minHeight: 800,
    backgroundColor: '#0d1417',
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
}

app.whenReady().then(() => {
  registerIpcHandlers(() => mainWindow)
  registerAwsIpcHandlers()
  registerEc2IpcHandlers()
  registerEcrIpcHandlers()
  registerEksIpcHandlers()
  registerOverviewIpcHandlers()
  registerSecurityIpcHandlers()
  registerServiceIpcHandlers()
  registerSgIpcHandlers()
  registerTerminalIpcHandlers()
  registerVpcIpcHandlers()
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
  if (isQuitting || pendingRequests.size === 0) return
  isQuitting = true
  e.preventDefault()
  const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000))
  Promise.race([Promise.allSettled([...pendingRequests]), timeout]).then(() => {
    app.quit()
  })
})
