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

const wrap = createHandlerWrapper('overview-ipc', { timeoutMs: 60000 })

// The global metrics scan queries 20+ AWS APIs per region. Allow up to 10 minutes
// so large accounts with many regions don't hit the default 60-second timeout.
const METRICS_TIMEOUT_MS = 600_000

export function registerOverviewIpcHandlers(): void {
  ipcMain.handle('overview:metrics', async (_event, connection: AwsConnection, regions: string[]) =>
    wrap(() => getOverviewMetrics(connection, regions), 'handler', { timeoutMs: METRICS_TIMEOUT_MS })
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
