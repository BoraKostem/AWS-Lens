import { ipcMain, shell } from 'electron'
import { wrap } from './shared'

export function registerShellHandlers(): void {
  ipcMain.handle('shell:open-external', async (_event, url: string) =>
    wrap(() => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Blocked shell.openExternal with disallowed protocol: ${parsed.protocol}`)
      }
      return shell.openExternal(url)
    })
  )
  ipcMain.handle('shell:open-path', async (_event, targetPath: string) =>
    wrap(() => {
      const resolved = require('path').resolve(targetPath)
      if (resolved.includes('..')) {
        throw new Error('Blocked shell.openPath: path traversal detected')
      }
      return shell.openPath(resolved)
    })
  )
}
