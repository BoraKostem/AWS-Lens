import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import { deleteLoadBalancer, listLoadBalancerWorkspaces } from './aws/loadBalancers'
import { listAwsProfiles } from './aws/profiles'
import { listAwsRegions } from './aws/regions'
import { getCallerIdentity } from './aws/sts'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerAwsIpcHandlers(): void {
  ipcMain.handle('profiles:list', async () => wrap(() => listAwsProfiles()))
  ipcMain.handle('regions:list', async () => wrap(() => listAwsRegions()))
  ipcMain.handle('sts:get-caller-identity', async (_event, connection: AwsConnection) =>
    wrap(() => getCallerIdentity(connection))
  )
  ipcMain.handle('elbv2:list-workspaces', async (_event, connection: AwsConnection) =>
    wrap(() => listLoadBalancerWorkspaces(connection))
  )
  ipcMain.handle('elbv2:delete-load-balancer', async (_event, connection: AwsConnection, loadBalancerArn: string) =>
    wrap(() => deleteLoadBalancer(connection, loadBalancerArn))
  )
}
