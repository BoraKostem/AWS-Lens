import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import {
  getOverviewAccountContext,
  getCostBreakdown,
  getOverviewMetrics,
  getOverviewStatistics,
  getRelationshipMap,
  searchByTag
} from './aws/overview'
import { createHandlerWrapper } from './operations'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('overview-ipc', { timeoutMs: 60000 })

export function registerOverviewIpcHandlers(): void {
  ipcMain.handle('overview:metrics', async (_event, connection: AwsConnection, regions: string[]) =>
    wrap(() => getOverviewMetrics(connection, regions))
  )
  ipcMain.handle('overview:statistics', async (_event, connection: AwsConnection) =>
    wrap(() => getOverviewStatistics(connection))
  )
  ipcMain.handle('overview:account-context', async (_event, connection: AwsConnection) =>
    wrap(() => getOverviewAccountContext(connection))
  )
  ipcMain.handle('overview:relationships', async (_event, connection: AwsConnection) =>
    wrap(() => getRelationshipMap(connection))
  )
  ipcMain.handle('overview:search-tags', async (_event, connection: AwsConnection, tagKey: string, tagValue?: string) =>
    wrap(() => searchByTag(connection, tagKey, tagValue))
  )
  ipcMain.handle('overview:cost-breakdown', async (_event, connection: AwsConnection) =>
    wrap(() => getCostBreakdown(connection))
  )
}
