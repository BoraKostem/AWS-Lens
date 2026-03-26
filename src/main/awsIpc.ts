import { ipcMain } from 'electron'

import type { AssumeRoleRequest, AwsAssumeRoleTarget, AwsConnection } from '@shared/types'
import { deleteLoadBalancer, listLoadBalancerWorkspaces } from './aws/loadBalancers'
import { deleteAwsProfile, listAwsProfiles, saveAwsCredentials } from './aws/profiles'
import { listAwsRegions } from './aws/regions'
import { getCallerIdentity } from './aws/sts'
import {
  assumeRoleSession,
  deleteAssumeRoleTarget,
  deleteSession,
  getAssumeRoleTarget,
  listSessionHubState,
  saveAssumeRoleTarget
} from './sessionHub'

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
  ipcMain.handle('profiles:delete', async (_event, profileName: string) => wrap(() => deleteAwsProfile(profileName)))
  ipcMain.handle('regions:list', async () => wrap(() => listAwsRegions()))
  ipcMain.handle('session-hub:list', async () => wrap(() => listSessionHubState()))
  ipcMain.handle('session-hub:target:save', async (_event, target: Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) =>
    wrap(() => saveAssumeRoleTarget(target))
  )
  ipcMain.handle('session-hub:target:delete', async (_event, targetId: string) =>
    wrap(() => deleteAssumeRoleTarget(targetId))
  )
  ipcMain.handle('session-hub:session:delete', async (_event, sessionId: string) =>
    wrap(() => deleteSession(sessionId))
  )
  ipcMain.handle('session-hub:assume', async (_event, request: AssumeRoleRequest) =>
    wrap(() => assumeRoleSession(request))
  )
  ipcMain.handle('session-hub:assume-target', async (_event, targetId: string) =>
    wrap(async () => {
      const target = getAssumeRoleTarget(targetId)
      if (!target) {
        throw new Error('Saved assume-role target was not found.')
      }

      return assumeRoleSession({
        label: target.label,
        roleArn: target.roleArn,
        sessionName: target.defaultSessionName,
        externalId: target.externalId || undefined,
        sourceProfile: target.sourceProfile || undefined,
        region: target.defaultRegion || undefined
      })
    })
  )
  ipcMain.handle('sts:get-caller-identity', async (_event, connection: AwsConnection) =>
    wrap(() => getCallerIdentity(connection))
  )
  ipcMain.handle('profiles:save-credentials', async (_event, profileName: string, accessKeyId: string, secretAccessKey: string) =>
    wrap(() => saveAwsCredentials(profileName, accessKeyId, secretAccessKey))
  )
  ipcMain.handle('elbv2:list-workspaces', async (_event, connection: AwsConnection) =>
    wrap(() => listLoadBalancerWorkspaces(connection))
  )
  ipcMain.handle('elbv2:delete-load-balancer', async (_event, connection: AwsConnection, loadBalancerArn: string) =>
    wrap(() => deleteLoadBalancer(connection, loadBalancerArn))
  )
}
