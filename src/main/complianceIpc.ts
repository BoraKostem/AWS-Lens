import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import { getComplianceReport } from './aws/compliance'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerComplianceIpcHandlers(): void {
  ipcMain.handle('compliance:report', async (_event, connection: AwsConnection) =>
    wrap(() => getComplianceReport(connection))
  )
}
