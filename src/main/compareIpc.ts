import { ipcMain } from 'electron'

import type { ComparisonRequest } from '@shared/types'
import { runComparison } from './compare'
import { createHandlerWrapper } from './operations'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('compare-ipc', { timeoutMs: 60000 })

export function registerCompareIpcHandlers(): void {
  ipcMain.handle('compare:run', async (_event, request: ComparisonRequest) =>
    wrap(() => runComparison(request))
  )
}
