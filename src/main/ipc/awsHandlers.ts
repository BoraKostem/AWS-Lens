import { dialog, ipcMain, type BrowserWindow } from 'electron'

import type { AwsConnection, LoadBalancerLogQuery } from '@shared/types'
import { importAwsConfigFile } from '../aws/profiles'
import {
  addUserToGroup, attachGroupPolicy, attachRolePolicy, attachUserPolicy,
  createAccessKey, createGroup, createLoginProfile, createPolicy,
  createPolicyVersion, createRole, createUser, deleteAccessKey,
  deleteGroup, deleteLoginProfile, deletePolicy, deletePolicyVersion,
  deleteRole, deleteRoleInlinePolicy, deleteUser, deleteUserInlinePolicy,
  deleteUserMfaDevice, detachGroupPolicy, detachRolePolicy, detachUserPolicy,
  generateCredentialReport, getAccountSummary, getCredentialReport,
  getPolicyVersion, getRoleTrustPolicy, listAttachedGroupPolicies,
  listAttachedRolePolicies, listAttachedUserPolicies, listIamGroups,
  listIamPolicies, listIamRoles, listIamUsers, listPolicyVersions,
  listRoleInlinePolicies, listUserAccessKeys, listUserGroups,
  listUserInlinePolicies, listUserMfaDevices, putRoleInlinePolicy,
  putUserInlinePolicy, removeUserFromGroup, simulatePolicy,
  updateAccessKeyStatus, updateRoleTrustPolicy
} from '../aws/iam'
import { wrap } from './shared'

type AwsLbLogsModule = typeof import('../aws/loadBalancerLogs')
let awsLbLogsPromise: Promise<AwsLbLogsModule> | null = null

function loadAwsLbLogs(): Promise<AwsLbLogsModule> {
  if (!awsLbLogsPromise) awsLbLogsPromise = import('../aws/loadBalancerLogs')
  return awsLbLogsPromise
}

export function registerAwsHandlers(getWindow: () => BrowserWindow | null): void {
  /* ── AWS profile import ─────────────────────────────────── */
  ipcMain.handle('profiles:choose-and-import', async () =>
    wrap(async () => {
      const owner = getWindow()
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: 'Select AWS config or credentials file',
            properties: ['openFile'],
            filters: [{ name: 'All Files', extensions: ['*'] }]
          })
        : await dialog.showOpenDialog({
            title: 'Select AWS config or credentials file',
            properties: ['openFile'],
            filters: [{ name: 'All Files', extensions: ['*'] }]
          })
      if (result.canceled || !result.filePaths[0]) {
        return []
      }
      return importAwsConfigFile(result.filePaths[0])
    })
  )

  /* ── IAM ─────────────────────────────────────────────────── */
  ipcMain.handle('iam:list-users', async (_e, c: AwsConnection) => wrap(() => listIamUsers(c)))
  ipcMain.handle('iam:list-groups', async (_e, c: AwsConnection) => wrap(() => listIamGroups(c)))
  ipcMain.handle('iam:list-roles', async (_e, c: AwsConnection) => wrap(() => listIamRoles(c)))
  ipcMain.handle('iam:list-policies', async (_e, c: AwsConnection, scope: string) => wrap(() => listIamPolicies(c, scope)))
  ipcMain.handle('iam:account-summary', async (_e, c: AwsConnection) => wrap(() => getAccountSummary(c)))
  ipcMain.handle('iam:list-access-keys', async (_e, c: AwsConnection, u: string) => wrap(() => listUserAccessKeys(c, u)))
  ipcMain.handle('iam:create-access-key', async (_e, c: AwsConnection, u: string) => wrap(() => createAccessKey(c, u)))
  ipcMain.handle('iam:delete-access-key', async (_e, c: AwsConnection, u: string, k: string) => wrap(() => deleteAccessKey(c, u, k)))
  ipcMain.handle('iam:update-access-key-status', async (_e, c: AwsConnection, u: string, k: string, s: string) => wrap(() => updateAccessKeyStatus(c, u, k, s)))
  ipcMain.handle('iam:list-mfa-devices', async (_e, c: AwsConnection, u: string) => wrap(() => listUserMfaDevices(c, u)))
  ipcMain.handle('iam:delete-mfa-device', async (_e, c: AwsConnection, u: string, sn: string) => wrap(() => deleteUserMfaDevice(c, u, sn)))
  ipcMain.handle('iam:list-attached-user-policies', async (_e, c: AwsConnection, u: string) => wrap(() => listAttachedUserPolicies(c, u)))
  ipcMain.handle('iam:list-user-inline-policies', async (_e, c: AwsConnection, u: string) => wrap(() => listUserInlinePolicies(c, u)))
  ipcMain.handle('iam:attach-user-policy', async (_e, c: AwsConnection, u: string, a: string) => wrap(() => attachUserPolicy(c, u, a)))
  ipcMain.handle('iam:detach-user-policy', async (_e, c: AwsConnection, u: string, a: string) => wrap(() => detachUserPolicy(c, u, a)))
  ipcMain.handle('iam:put-user-inline-policy', async (_e, c: AwsConnection, u: string, n: string, d: string) => wrap(() => putUserInlinePolicy(c, u, n, d)))
  ipcMain.handle('iam:delete-user-inline-policy', async (_e, c: AwsConnection, u: string, n: string) => wrap(() => deleteUserInlinePolicy(c, u, n)))
  ipcMain.handle('iam:list-user-groups', async (_e, c: AwsConnection, u: string) => wrap(() => listUserGroups(c, u)))
  ipcMain.handle('iam:add-user-to-group', async (_e, c: AwsConnection, u: string, g: string) => wrap(() => addUserToGroup(c, u, g)))
  ipcMain.handle('iam:remove-user-from-group', async (_e, c: AwsConnection, u: string, g: string) => wrap(() => removeUserFromGroup(c, u, g)))
  ipcMain.handle('iam:create-user', async (_e, c: AwsConnection, u: string) => wrap(() => createUser(c, u)))
  ipcMain.handle('iam:delete-user', async (_e, c: AwsConnection, u: string) => wrap(() => deleteUser(c, u)))
  ipcMain.handle('iam:create-login-profile', async (_e, c: AwsConnection, u: string, pw: string, r: boolean) => wrap(() => createLoginProfile(c, u, pw, r)))
  ipcMain.handle('iam:delete-login-profile', async (_e, c: AwsConnection, u: string) => wrap(() => deleteLoginProfile(c, u)))
  ipcMain.handle('iam:list-attached-role-policies', async (_e, c: AwsConnection, r: string) => wrap(() => listAttachedRolePolicies(c, r)))
  ipcMain.handle('iam:list-role-inline-policies', async (_e, c: AwsConnection, r: string) => wrap(() => listRoleInlinePolicies(c, r)))
  ipcMain.handle('iam:get-role-trust-policy', async (_e, c: AwsConnection, r: string) => wrap(() => getRoleTrustPolicy(c, r)))
  ipcMain.handle('iam:update-role-trust-policy', async (_e, c: AwsConnection, r: string, d: string) => wrap(() => updateRoleTrustPolicy(c, r, d)))
  ipcMain.handle('iam:attach-role-policy', async (_e, c: AwsConnection, r: string, a: string) => wrap(() => attachRolePolicy(c, r, a)))
  ipcMain.handle('iam:detach-role-policy', async (_e, c: AwsConnection, r: string, a: string) => wrap(() => detachRolePolicy(c, r, a)))
  ipcMain.handle('iam:put-role-inline-policy', async (_e, c: AwsConnection, r: string, n: string, d: string) => wrap(() => putRoleInlinePolicy(c, r, n, d)))
  ipcMain.handle('iam:delete-role-inline-policy', async (_e, c: AwsConnection, r: string, n: string) => wrap(() => deleteRoleInlinePolicy(c, r, n)))
  ipcMain.handle('iam:create-role', async (_e, c: AwsConnection, r: string, tp: string, desc: string) => wrap(() => createRole(c, r, tp, desc)))
  ipcMain.handle('iam:delete-role', async (_e, c: AwsConnection, r: string) => wrap(() => deleteRole(c, r)))
  ipcMain.handle('iam:list-attached-group-policies', async (_e, c: AwsConnection, g: string) => wrap(() => listAttachedGroupPolicies(c, g)))
  ipcMain.handle('iam:attach-group-policy', async (_e, c: AwsConnection, g: string, a: string) => wrap(() => attachGroupPolicy(c, g, a)))
  ipcMain.handle('iam:detach-group-policy', async (_e, c: AwsConnection, g: string, a: string) => wrap(() => detachGroupPolicy(c, g, a)))
  ipcMain.handle('iam:create-group', async (_e, c: AwsConnection, g: string) => wrap(() => createGroup(c, g)))
  ipcMain.handle('iam:delete-group', async (_e, c: AwsConnection, g: string) => wrap(() => deleteGroup(c, g)))
  ipcMain.handle('iam:get-policy-version', async (_e, c: AwsConnection, a: string, v: string) => wrap(() => getPolicyVersion(c, a, v)))
  ipcMain.handle('iam:list-policy-versions', async (_e, c: AwsConnection, a: string) => wrap(() => listPolicyVersions(c, a)))
  ipcMain.handle('iam:create-policy-version', async (_e, c: AwsConnection, a: string, d: string, s: boolean) => wrap(() => createPolicyVersion(c, a, d, s)))
  ipcMain.handle('iam:delete-policy-version', async (_e, c: AwsConnection, a: string, v: string) => wrap(() => deletePolicyVersion(c, a, v)))
  ipcMain.handle('iam:create-policy', async (_e, c: AwsConnection, n: string, d: string, desc: string) => wrap(() => createPolicy(c, n, d, desc)))
  ipcMain.handle('iam:delete-policy', async (_e, c: AwsConnection, a: string) => wrap(() => deletePolicy(c, a)))
  ipcMain.handle('iam:simulate-policy', async (_e, c: AwsConnection, a: string, acts: string[], res: string[]) => wrap(() => simulatePolicy(c, a, acts, res)))
  ipcMain.handle('iam:generate-credential-report', async (_e, c: AwsConnection) => wrap(() => generateCredentialReport(c)))
  ipcMain.handle('iam:get-credential-report', async (_e, c: AwsConnection) => wrap(() => getCredentialReport(c)))

  /* ── Load Balancer Logs (AWS) ── */
  ipcMain.handle('lb:logs:query', async (_event, connection: AwsConnection | undefined, query: LoadBalancerLogQuery, providerContext?: { gcpProjectId?: string; azureWorkspaceId?: string }) =>
    wrap(async () => {
      switch (query.provider) {
        case 'aws': {
          if (!connection) throw new Error('AWS connection is required for ALB/NLB log queries')
          return (await loadAwsLbLogs()).queryAlbAccessLogs(connection, query)
        }
        case 'gcp': {
          const gcpLbLogs = await import('../gcp/loadBalancerLogs')
          const projectId = providerContext?.gcpProjectId ?? ''
          return gcpLbLogs.queryGcpLoadBalancerLogs(projectId, query)
        }
        case 'azure': {
          const azureLbLogs = await import('../azure/loadBalancerLogs')
          return azureLbLogs.queryAzureLoadBalancerLogs(providerContext?.azureWorkspaceId ?? '', query)
        }
        default:
          throw new Error(`Unsupported provider for LB logs: ${query.provider}`)
      }
    }, 'lb:logs:query', { timeoutMs: 120_000 })
  )
  ipcMain.handle('lb:logs:access-log-config', async (_event, connection: AwsConnection, loadBalancerArn: string) =>
    wrap(async () => (await loadAwsLbLogs()).getAlbAccessLogConfig(connection, loadBalancerArn))
  )
}
