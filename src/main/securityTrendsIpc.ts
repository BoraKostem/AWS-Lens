import { ipcMain } from 'electron'

import type {
  SecuritySnapshotInput,
  SecurityThresholds,
  SecurityTrendRange
} from '@shared/types'
import { createHandlerWrapper } from './operations'
import {
  buildSecurityTrendReport,
  getSecurityThresholds,
  listAllSecurityScopes,
  listSecuritySnapshots,
  recordSecuritySnapshot,
  updateSecurityThresholds
} from './securitySnapshotsStore'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('security-trends-ipc', { timeoutMs: 30000 })

export function registerSecurityTrendsIpcHandlers(): void {
  ipcMain.handle(
    'security-trends:record-snapshot',
    async (_event, input: SecuritySnapshotInput) => wrap(() => recordSecuritySnapshot(input))
  )
  ipcMain.handle(
    'security-trends:list-snapshots',
    async (_event, scope: string, range: SecurityTrendRange) =>
      wrap(() => listSecuritySnapshots(scope, range))
  )
  ipcMain.handle(
    'security-trends:build-report',
    async (_event, scope: string, range: SecurityTrendRange) =>
      wrap(() => buildSecurityTrendReport(scope, range))
  )
  ipcMain.handle(
    'security-trends:get-thresholds',
    async () => wrap(() => getSecurityThresholds())
  )
  ipcMain.handle(
    'security-trends:update-thresholds',
    async (_event, update: Partial<SecurityThresholds>) =>
      wrap(() => updateSecurityThresholds(update))
  )
  ipcMain.handle(
    'security-trends:list-scopes',
    async () => wrap(() => listAllSecurityScopes())
  )
}
