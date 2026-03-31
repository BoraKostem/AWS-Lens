import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import { getComplianceReport } from './aws/compliance'
import { createHandlerWrapper } from './operations'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('compliance-ipc', { timeoutMs: 60000 })

export function registerComplianceIpcHandlers(): void {
  ipcMain.handle('compliance:report', async (_event, connection: AwsConnection) =>
    wrap(() => getComplianceReport(connection))
  )
}
