import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import {
  getCostBreakdown,
  getOverviewMetrics,
  getOverviewStatistics,
  getRelationshipMap,
  searchByTag
} from './aws/overview'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerOverviewIpcHandlers(): void {
  ipcMain.handle('overview:metrics', async (_event, connection: AwsConnection, regions: string[]) =>
    wrap(() => getOverviewMetrics(connection, regions))
  )
  ipcMain.handle('overview:statistics', async (_event, connection: AwsConnection) =>
    wrap(() => getOverviewStatistics(connection))
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
