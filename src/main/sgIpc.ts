import { ipcMain } from 'electron'

import type { AwsConnection, SecurityGroupRuleInput } from '@shared/types'
import {
  addInboundRule,
  addOutboundRule,
  describeSecurityGroup,
  listSecurityGroups,
  revokeInboundRule,
  revokeOutboundRule
} from './aws/securityGroups'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerSgIpcHandlers(): void {
  ipcMain.handle('sg:list', async (_event, connection: AwsConnection, vpcId?: string) =>
    wrap(() => listSecurityGroups(connection, vpcId))
  )
  ipcMain.handle('sg:describe', async (_event, connection: AwsConnection, groupId: string) =>
    wrap(() => describeSecurityGroup(connection, groupId))
  )
  ipcMain.handle(
    'sg:add-inbound',
    async (_event, connection: AwsConnection, groupId: string, rule: SecurityGroupRuleInput) =>
      wrap(() => addInboundRule(connection, groupId, rule))
  )
  ipcMain.handle(
    'sg:revoke-inbound',
    async (_event, connection: AwsConnection, groupId: string, rule: SecurityGroupRuleInput) =>
      wrap(() => revokeInboundRule(connection, groupId, rule))
  )
  ipcMain.handle(
    'sg:add-outbound',
    async (_event, connection: AwsConnection, groupId: string, rule: SecurityGroupRuleInput) =>
      wrap(() => addOutboundRule(connection, groupId, rule))
  )
  ipcMain.handle(
    'sg:revoke-outbound',
    async (_event, connection: AwsConnection, groupId: string, rule: SecurityGroupRuleInput) =>
      wrap(() => revokeOutboundRule(connection, groupId, rule))
  )
}
