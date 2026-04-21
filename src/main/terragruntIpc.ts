import path from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'

import type { AwsConnection, TerragruntRunAllCommand } from '@shared/types'
import { createHandlerWrapper, type OperationOptions } from './operations'
import { detectTerragruntCli, getCachedTerragruntCliInfo, resolveStack } from './terragrunt'
import { scanForTerragrunt } from './terragruntDiscovery'
import { cancelTerragruntStackRunAll, loadTerragruntUnitInventory, startTerragruntStackRunAll } from './terraform'
import { getTerragruntUnitDriftReport } from './terraformDrift'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(
  fn: () => Promise<T> | T,
  label?: string,
  options?: OperationOptions
) => Promise<HandlerResult<T>> = createHandlerWrapper('terragrunt-ipc', { timeoutMs: 60000 })

let registered = false

export function registerTerragruntIpcHandlers(getWindow?: () => BrowserWindow | null): void {
  if (registered) return
  registered = true

  ipcMain.handle('terragrunt:cli:detect', async () => wrap(() => detectTerragruntCli()))
  ipcMain.handle('terragrunt:cli:info', async () => wrap(() => getCachedTerragruntCliInfo()))
  ipcMain.handle('terragrunt:discovery:scan', async (_event, rootPath: string) =>
    wrap(() => scanForTerragrunt(path.resolve(rootPath)))
  )
  ipcMain.handle('terragrunt:stack:resolve', async (_event, rootPath: string) =>
    wrap(() => resolveStack(path.resolve(rootPath)), 'terragrunt:stack:resolve', { timeoutMs: 5 * 60 * 1000 })
  )
  ipcMain.handle(
    'terragrunt:run-all:start',
    async (
      _event,
      profileName: string,
      projectId: string,
      command: TerragruntRunAllCommand,
      connection?: AwsConnection,
      unitFilter?: string[]
    ) =>
      wrap(
        () =>
          startTerragruntStackRunAll(
            { profileName, projectId, command, connection, unitFilter },
            getWindow?.() ?? null
          ),
        'terragrunt:run-all:start',
        { timeoutMs: 4 * 60 * 60 * 1000 }
      )
  )
  ipcMain.handle('terragrunt:run-all:cancel', async (_event, runId: string) =>
    wrap(() => cancelTerragruntStackRunAll(runId))
  )
  ipcMain.handle(
    'terragrunt:unit:inventory',
    async (_event, profileName: string, projectId: string, connection?: AwsConnection, unitPath?: string) =>
      wrap(
        () => loadTerragruntUnitInventory(profileName, projectId, connection, unitPath),
        'terragrunt:unit:inventory',
        { timeoutMs: 3 * 60 * 1000 }
      )
  )
  ipcMain.handle(
    'terragrunt:unit:drift',
    async (_event, profileName: string, projectId: string, connection: AwsConnection, unitPath: string) =>
      wrap(
        () => getTerragruntUnitDriftReport(profileName, projectId, connection, unitPath),
        'terragrunt:unit:drift',
        { timeoutMs: 5 * 60 * 1000 }
      )
  )
}
