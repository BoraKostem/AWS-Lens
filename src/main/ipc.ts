import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'

import type {
  AppDiagnosticsFailureInput,
  AppDiagnosticsSnapshot,
  AppSecuritySummary,
  AppSettings,
  AwsConnection,
  AzureProviderContextSnapshot,
  CloudProviderId,
  GcpComputeInstanceAction
} from '@shared/types'
import { getAppSettings, resetAppSettings, updateAppSettings } from './appSettings'
import { importAwsConfigFile } from './aws/profiles'
import { getVisibleServiceCatalog, getVisibleWorkspaceCatalog } from './catalog'
import { exportDiagnosticsBundle } from './diagnostics'
import { recordDiagnosticsFailure, updateDiagnosticsActiveContext } from './diagnosticsState'
import { getEnvironmentHealthReport } from './environment'
import { exportEnterpriseAuditEvents, getEnterpriseSettings, listEnterpriseAuditEvents, setEnterpriseAccessMode } from './enterprise'
import {
  getGcpCliContext,
  listGcpProjects
} from './gcpCli'
import { getVaultEntryCounts } from './localVault'
import { createHandlerWrapper, type OperationOptions } from './operations'
import { checkForAppUpdates, downloadAppUpdate, getReleaseInfo, installAppUpdate } from './releaseCheck'
import { listProviders } from './providerRegistry'
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
} from './aws/iam'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(
  fn: () => Promise<T> | T,
  label?: string,
  options?: OperationOptions
) => Promise<HandlerResult<T>> = createHandlerWrapper('ipc', { timeoutMs: 60000 })

type GcpSdkModule = typeof import('./gcpSdk')
type AzureFoundationModule = typeof import('./azureFoundation')

let gcpSdkPromise: Promise<GcpSdkModule> | null = null
let azureFoundationPromise: Promise<AzureFoundationModule> | null = null

function loadGcpSdk(): Promise<GcpSdkModule> {
  if (!gcpSdkPromise) {
    gcpSdkPromise = import('./gcpSdk')
  }

  return gcpSdkPromise
}

function loadAzureFoundation(): Promise<AzureFoundationModule> {
  if (!azureFoundationPromise) {
    azureFoundationPromise = import('./azureFoundation')
  }

  return azureFoundationPromise
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('providers:list', async () => wrap(() => listProviders()))
  ipcMain.handle('workspace-catalog:get', async (_event, providerId?: CloudProviderId) =>
    wrap(() => getVisibleWorkspaceCatalog(providerId ?? 'aws', getAppSettings().features))
  )
  ipcMain.handle('services:list', async (_event, providerId?: CloudProviderId) =>
    wrap(() => getVisibleServiceCatalog(providerId ?? 'aws', getAppSettings().features))
  )
  ipcMain.handle('shell:open-external', async (_event, url: string) => wrap(() => shell.openExternal(url)))
  ipcMain.handle('shell:open-path', async (_event, targetPath: string) => wrap(() => shell.openPath(targetPath)))
  ipcMain.handle('app:release-info', async () => wrap(() => getReleaseInfo()))
  ipcMain.handle('app:settings:get', async () => wrap(() => getAppSettings()))
  ipcMain.handle('app:settings:update', async (_event, update: Partial<AppSettings>) => wrap(() => updateAppSettings(update)))
  ipcMain.handle('app:settings:reset', async () => wrap(() => resetAppSettings()))
  ipcMain.handle('app:security-summary', async () => wrap<AppSecuritySummary>(() => ({
    vaultEntryCounts: getVaultEntryCounts()
  })))
  ipcMain.handle('app:environment-health', async () => wrap(() => getEnvironmentHealthReport()))
  ipcMain.handle('azure:context:get', async () =>
    wrap<AzureProviderContextSnapshot>(async () => (await loadAzureFoundation()).getAzureProviderContext())
  )
  ipcMain.handle('azure:context:start-device-code-sign-in', async () =>
    wrap<AzureProviderContextSnapshot>(async () => (await loadAzureFoundation()).startAzureDeviceCodeSignIn())
  )
  ipcMain.handle('azure:context:sign-out', async () =>
    wrap<AzureProviderContextSnapshot>(async () => (await loadAzureFoundation()).signOutAzureProvider())
  )
  ipcMain.handle('azure:context:set-tenant', async (_event, tenantId: string) =>
    wrap<AzureProviderContextSnapshot>(async () => (await loadAzureFoundation()).setAzureActiveTenant(tenantId))
  )
  ipcMain.handle('azure:context:set-subscription', async (_event, subscriptionId: string) =>
    wrap<AzureProviderContextSnapshot>(async () => (await loadAzureFoundation()).setAzureActiveSubscription(subscriptionId))
  )
  ipcMain.handle('azure:context:set-location', async (_event, location: string) =>
    wrap<AzureProviderContextSnapshot>(async () => (await loadAzureFoundation()).setAzureActiveLocation(location))
  )
  ipcMain.handle('gcp:cli-context', async () => wrap(() => getGcpCliContext()))
  ipcMain.handle('gcp:projects', async () => wrap(() => listGcpProjects()))
  ipcMain.handle('gcp:projects:get-overview', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpProjectOverview(projectId))
  )
  ipcMain.handle('gcp:iam:get-overview', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpIamOverview(projectId))
  )
  ipcMain.handle('gcp:compute-engine:list', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpComputeInstances(projectId, location))
  )
  ipcMain.handle('gcp:compute-engine:get-detail', async (_event, projectId: string, zone: string, instanceName: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpComputeInstanceDetail(projectId, zone, instanceName))
  )
  ipcMain.handle('gcp:compute-engine:list-machine-types', async (_event, projectId: string, zone: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpComputeMachineTypes(projectId, zone))
  )
  ipcMain.handle('gcp:compute-engine:action', async (_event, projectId: string, zone: string, instanceName: string, action: GcpComputeInstanceAction) =>
    wrap(async () => (await loadGcpSdk()).runGcpComputeInstanceAction(projectId, zone, instanceName, action))
  )
  ipcMain.handle('gcp:compute-engine:resize', async (_event, projectId: string, zone: string, instanceName: string, machineType: string) =>
    wrap(async () => (await loadGcpSdk()).resizeGcpComputeInstance(projectId, zone, instanceName, machineType))
  )
  ipcMain.handle('gcp:compute-engine:update-labels', async (_event, projectId: string, zone: string, instanceName: string, labels: Record<string, string>) =>
    wrap(async () => (await loadGcpSdk()).updateGcpComputeInstanceLabels(projectId, zone, instanceName, labels))
  )
  ipcMain.handle('gcp:compute-engine:delete', async (_event, projectId: string, zone: string, instanceName: string) =>
    wrap(async () => (await loadGcpSdk()).deleteGcpComputeInstance(projectId, zone, instanceName))
  )
  ipcMain.handle('gcp:compute-engine:get-serial-output', async (_event, projectId: string, zone: string, instanceName: string, port?: number, start?: number) =>
    wrap(async () => (await loadGcpSdk()).getGcpComputeSerialOutput(projectId, zone, instanceName, port, start))
  )
  ipcMain.handle('gcp:gke:list', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpGkeClusters(projectId, location))
  )
  ipcMain.handle('gcp:gke:get-detail', async (_event, projectId: string, location: string, clusterName: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpGkeClusterDetail(projectId, location, clusterName))
  )
  ipcMain.handle('gcp:gke:list-node-pools', async (_event, projectId: string, location: string, clusterName: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpGkeNodePools(projectId, location, clusterName))
  )
  ipcMain.handle('gcp:gke:get-credentials', async (_event, projectId: string, location: string, clusterName: string, contextName?: string, kubeconfigPath?: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpGkeClusterCredentials(projectId, location, clusterName, contextName, kubeconfigPath))
  )
  ipcMain.handle('gcp:gke:list-operations', async (_event, projectId: string, location: string, clusterName: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpGkeOperations(projectId, location, clusterName))
  )
  ipcMain.handle('gcp:gke:update-node-pool-scaling', async (_event, projectId: string, location: string, clusterName: string, nodePoolName: string, minimum: number, desired: number, maximum: number) =>
    wrap(async () => (await loadGcpSdk()).updateGcpGkeNodePoolScaling(projectId, location, clusterName, nodePoolName, minimum, desired, maximum))
  )
  ipcMain.handle('gcp:cloud-storage:list', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpStorageBuckets(projectId, location))
  )
  ipcMain.handle('gcp:cloud-storage:objects:list', async (_event, projectId: string, bucketName: string, prefix: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpStorageObjects(projectId, bucketName, prefix))
  )
  ipcMain.handle('gcp:cloud-storage:object:get-content', async (_event, projectId: string, bucketName: string, key: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpStorageObjectContent(projectId, bucketName, key))
  )
  ipcMain.handle('gcp:cloud-storage:object:put-content', async (_event, projectId: string, bucketName: string, key: string, content: string) =>
    wrap(async () => (await loadGcpSdk()).putGcpStorageObjectContent(projectId, bucketName, key, content))
  )
  ipcMain.handle('gcp:cloud-storage:object:upload', async (_event, projectId: string, bucketName: string, key: string, localPath: string) =>
    wrap(async () => (await loadGcpSdk()).uploadGcpStorageObject(projectId, bucketName, key, localPath))
  )
  ipcMain.handle('gcp:cloud-storage:object:download', async (_event, projectId: string, bucketName: string, key: string) =>
    wrap(async () => (await loadGcpSdk()).downloadGcpStorageObjectToPath(projectId, bucketName, key))
  )
  ipcMain.handle('gcp:cloud-storage:object:delete', async (_event, projectId: string, bucketName: string, key: string) =>
    wrap(async () => (await loadGcpSdk()).deleteGcpStorageObject(projectId, bucketName, key))
  )
  ipcMain.handle('gcp:logging:list', async (_event, projectId: string, location: string, query: string, windowHours?: number) =>
    wrap(async () => (await loadGcpSdk()).listGcpLogEntries(projectId, location, query, windowHours))
  )
  ipcMain.handle('gcp:cloud-sql:list', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpSqlInstances(projectId, location))
  )
  ipcMain.handle('gcp:cloud-sql:get-detail', async (_event, projectId: string, instanceName: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpSqlInstanceDetail(projectId, instanceName))
  )
  ipcMain.handle('gcp:cloud-sql:databases:list', async (_event, projectId: string, instanceName: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpSqlDatabases(projectId, instanceName))
  )
  ipcMain.handle('gcp:cloud-sql:operations:list', async (_event, projectId: string, instanceName: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpSqlOperations(projectId, instanceName))
  )
  ipcMain.handle('gcp:billing:get-overview', async (_event, projectId: string, catalogProjectIds: string[]) =>
    wrap(async () => (await loadGcpSdk()).getGcpBillingOverview(projectId, catalogProjectIds))
  )
  ipcMain.handle('app:update:check', async () => wrap(() => checkForAppUpdates()))
  ipcMain.handle('app:update:download', async () => wrap(() => downloadAppUpdate()))
  ipcMain.handle('app:update:install', async () => wrap(() => installAppUpdate()))
  ipcMain.handle('app:diagnostics:set-active-context', async (_event, context: AppDiagnosticsSnapshot) =>
    wrap(() => updateDiagnosticsActiveContext(context))
  )
  ipcMain.handle('app:diagnostics:record-failure', async (_event, input: AppDiagnosticsFailureInput) =>
    wrap(() => recordDiagnosticsFailure(input))
  )
  ipcMain.handle('app:export-diagnostics', async (_event, snapshot: AppDiagnosticsSnapshot | undefined) => wrap(() => exportDiagnosticsBundle(getWindow(), snapshot)))
  ipcMain.handle('enterprise:get-settings', async () => wrap(() => getEnterpriseSettings()))
  ipcMain.handle('enterprise:set-access-mode', async (_event, accessMode: 'read-only' | 'operator') =>
    wrap(() => setEnterpriseAccessMode(accessMode))
  )
  ipcMain.handle('enterprise:audit:list', async () => wrap(() => listEnterpriseAuditEvents()))
  ipcMain.handle('enterprise:audit:export', async () => wrap(() => exportEnterpriseAuditEvents(getWindow())))

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

  /* ── AWS core ────────────────────────────────────────────── */

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
}
