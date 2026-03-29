/**
 * Mock electron module for the web server build.
 * Vite aliases "electron" → this file during the server bundle.
 * All ipcMain.handle() calls register into the webRegistry Map.
 * The Express server reads from that Map to dispatch RPC calls.
 */

type IpcHandler = (_event: null, ...args: unknown[]) => unknown

export const webRegistry = new Map<string, (...args: unknown[]) => Promise<unknown>>()

export const ipcMain = {
  handle(channel: string, fn: IpcHandler) {
    webRegistry.set(channel, (...args: unknown[]) => Promise.resolve(fn(null, ...args)))
  },
  on() {},
  off() {},
  removeAllListeners() {}
}

export const app = {
  getVersion: () => process.env.APP_VERSION ?? '0.1.0',
  getName: () => 'aws-lens',
  getPath: (name: string) => {
    const os = require('os') as typeof import('os')
    const path = require('path') as typeof import('path')
    const base = os.homedir()
    const map: Record<string, string> = {
      home: base,
      appData: path.join(base, '.aws-lens'),
      userData: path.join(base, '.aws-lens'),
      temp: os.tmpdir(),
      exe: process.execPath,
      logs: path.join(base, '.aws-lens', 'logs')
    }
    return map[name] ?? base
  },
  quit: () => process.exit(0),
  on: () => {},
  whenReady: () => Promise.resolve()
}

export const dialog = {
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: () => undefined,
  showMessageBox: async () => ({ response: 0 }),
  showMessageBoxSync: () => 0,
  showErrorBox: () => {}
}

export const shell = {
  openExternal: async (_url: string) => {},
  openPath: async (_path: string) => '',
  showItemInFolder: () => {}
}

export class BrowserWindow {
  static getAllWindows() { return [] }
  static getFocusedWindow() { return null }
  webContents = { send: () => {}, id: 0 }
  isDestroyed() { return false }
  close() {}
  on() { return this }
}

export const Menu = {
  buildFromTemplate: () => ({}),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null
}

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
  createEmpty: () => ({ isEmpty: () => true })
}

export const Notification = class {
  constructor() {}
  show() {}
  on() { return this }
}

// Default export for CJS compat
const electron = { ipcMain, app, dialog, shell, BrowserWindow, Menu, nativeImage, Notification, webRegistry }
export default electron
