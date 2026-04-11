import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  AppDiagnosticsFailureInput,
  AppDiagnosticsSnapshot,
  AppSecuritySummary,
  AppSettings,
  AwsConnection,
  AzureProviderContextSnapshot,
  AzureVmAction,
  AzureWebAppAction,
  AzureDnsRecordUpsertInput,
  CloudProviderId,
  GcpComputeInstanceAction,
  GcpDnsRecordUpsertInput
} from '@shared/types'
import { getAppSettings, resetAppSettings, updateAppSettings } from './appSettings'
import { importAwsConfigFile } from './aws/profiles'
import { getVisibleServiceCatalog, getVisibleWorkspaceCatalog } from './catalog'
import { exportDiagnosticsBundle } from './diagnostics'
import { recordDiagnosticsFailure, updateDiagnosticsActiveContext } from './diagnosticsState'
import { detectProviderCliStatus, getEnvironmentHealthReport } from './environment'
import { exportEnterpriseAuditEvents, getEnterpriseSettings, listEnterpriseAuditEvents, setEnterpriseAccessMode } from './enterprise'
import {
  getGcpCliContext,
  listGcpProjects
} from './gcpCli'
import { getVaultEntryCounts } from './localVault'
import { createHandlerWrapper, type OperationOptions } from './operations'
import {
  getAzureProviderContext,
  setAzureActiveLocation,
  setAzureActiveSubscription,
  setAzureActiveTenant,
  signOutAzureProvider,
  startAzureDeviceCodeSignIn
} from './azureFoundation'
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
type AzureSdkModule = typeof import('./azureSdk')

let gcpSdkPromise: Promise<GcpSdkModule> | null = null
let azureSdkPromise: Promise<AzureSdkModule> | null = null

function loadGcpSdk(): Promise<GcpSdkModule> {
  if (!gcpSdkPromise) {
    gcpSdkPromise = import('./gcpSdk')
  }

  return gcpSdkPromise
}

function loadAzureSdk(): Promise<AzureSdkModule> {
  if (!azureSdkPromise) {
    azureSdkPromise = import('./azureSdk')
  }

  return azureSdkPromise
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('providers:list', async () => wrap(() => listProviders()))
  ipcMain.handle('providers:cli-status', async () => wrap(() => detectProviderCliStatus()))
  ipcMain.handle('workspace-catalog:get', async (_event, providerId?: CloudProviderId) =>
    wrap(() => getVisibleWorkspaceCatalog(providerId ?? 'aws', getAppSettings().features))
  )
  ipcMain.handle('services:list', async (_event, providerId?: CloudProviderId) =>
    wrap(() => getVisibleServiceCatalog(providerId ?? 'aws', getAppSettings().features))
  )
  ipcMain.handle('shell:open-external', async (_event, url: string) =>
    wrap(() => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Blocked shell.openExternal with disallowed protocol: ${parsed.protocol}`)
      }
      return shell.openExternal(url)
    })
  )
  ipcMain.handle('shell:open-path', async (_event, targetPath: string) =>
    wrap(() => {
      const resolved = require('path').resolve(targetPath)
      if (resolved.includes('..')) {
        throw new Error('Blocked shell.openPath: path traversal detected')
      }
      return shell.openPath(resolved)
    })
  )
  ipcMain.handle('app:release-info', async () => wrap(() => getReleaseInfo()))
  ipcMain.handle('app:settings:get', async () => wrap(() => getAppSettings()))
  ipcMain.handle('app:settings:update', async (_event, update: Partial<AppSettings>) => wrap(() => updateAppSettings(update)))
  ipcMain.handle('app:settings:reset', async () => wrap(() => resetAppSettings()))
  ipcMain.handle('app:security-summary', async () => wrap<AppSecuritySummary>(() => ({
    vaultEntryCounts: getVaultEntryCounts()
  })))
  ipcMain.handle('app:environment-health', async () => wrap(() => getEnvironmentHealthReport()))
  ipcMain.handle('azure:context:get', async () =>
    wrap<AzureProviderContextSnapshot>(async () => getAzureProviderContext())
  )
  ipcMain.handle('azure:context:start-device-code-sign-in', async () =>
    wrap<AzureProviderContextSnapshot>(async () => startAzureDeviceCodeSignIn())
  )
  ipcMain.handle('azure:context:sign-out', async () =>
    wrap<AzureProviderContextSnapshot>(async () => signOutAzureProvider())
  )
  ipcMain.handle('azure:context:set-tenant', async (_event, tenantId: string) =>
    wrap<AzureProviderContextSnapshot>(async () => setAzureActiveTenant(tenantId))
  )
  ipcMain.handle('azure:context:set-subscription', async (_event, subscriptionId: string) =>
    wrap<AzureProviderContextSnapshot>(async () => setAzureActiveSubscription(subscriptionId))
  )
  ipcMain.handle('azure:context:set-location', async (_event, location: string) =>
    wrap<AzureProviderContextSnapshot>(async () => setAzureActiveLocation(location))
  )
  ipcMain.handle('gcp:cli-context', async () => wrap(() => getGcpCliContext()))
  ipcMain.handle('gcp:auth:status', async (_event, projectId: string) =>
    wrap(async () => {
      const { getCredentialStatus } = await import('./gcp/auth')
      return getCredentialStatus(projectId)
    })
  )
  ipcMain.handle('gcp:auth:refresh', async (_event, projectId: string) =>
    wrap(async () => {
      const { refreshCredentials } = await import('./gcp/auth')
      refreshCredentials(projectId)
      return { refreshed: true }
    })
  )
  ipcMain.handle('gcp:auth:set-impersonation', async (_event, targetServiceAccount: string | null) =>
    wrap(async () => {
      const { setImpersonationTarget } = await import('./gcp/auth')
      setImpersonationTarget(targetServiceAccount)
      return { target: targetServiceAccount }
    })
  )
  ipcMain.handle('gcp:projects', async () => wrap(() => listGcpProjects()))
  ipcMain.handle('gcp:projects:get-overview', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpProjectOverview(projectId))
  )
  ipcMain.handle('gcp:iam:get-overview', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpIamOverview(projectId))
  )
  ipcMain.handle('gcp:iam:add-binding', async (_event, projectId: string, role: string, member: string) =>
    wrap(async () => (await loadGcpSdk()).addGcpIamBinding(projectId, role, member))
  )
  ipcMain.handle('gcp:iam:remove-binding', async (_event, projectId: string, role: string, member: string) =>
    wrap(async () => (await loadGcpSdk()).removeGcpIamBinding(projectId, role, member))
  )
  ipcMain.handle('gcp:iam:create-service-account', async (_event, projectId: string, accountId: string, displayName: string, description: string) =>
    wrap(async () => (await loadGcpSdk()).createGcpServiceAccount(projectId, accountId, displayName, description))
  )
  ipcMain.handle('gcp:iam:delete-service-account', async (_event, projectId: string, email: string) =>
    wrap(async () => (await loadGcpSdk()).deleteGcpServiceAccount(projectId, email))
  )
  ipcMain.handle('gcp:iam:disable-service-account', async (_event, projectId: string, email: string, disable: boolean) =>
    wrap(async () => (await loadGcpSdk()).disableGcpServiceAccount(projectId, email, disable))
  )
  ipcMain.handle('gcp:iam:list-service-account-keys', async (_event, projectId: string, email: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpServiceAccountKeys(projectId, email))
  )
  ipcMain.handle('gcp:iam:create-service-account-key', async (_event, projectId: string, email: string) =>
    wrap(async () => (await loadGcpSdk()).createGcpServiceAccountKey(projectId, email))
  )
  ipcMain.handle('gcp:iam:delete-service-account-key', async (_event, projectId: string, email: string, keyId: string) =>
    wrap(async () => (await loadGcpSdk()).deleteGcpServiceAccountKey(projectId, email, keyId))
  )
  ipcMain.handle('gcp:iam:list-roles', async (_event, projectId: string, scope: 'custom' | 'all') =>
    wrap(async () => (await loadGcpSdk()).listGcpRoles(projectId, scope))
  )
  ipcMain.handle('gcp:iam:create-custom-role', async (_event, projectId: string, roleId: string, title: string, description: string, permissions: string[]) =>
    wrap(async () => (await loadGcpSdk()).createGcpCustomRole(projectId, roleId, title, description, permissions))
  )
  ipcMain.handle('gcp:iam:delete-custom-role', async (_event, projectId: string, roleName: string) =>
    wrap(async () => (await loadGcpSdk()).deleteGcpCustomRole(projectId, roleName))
  )
  ipcMain.handle('gcp:iam:test-permissions', async (_event, projectId: string, permissions: string[]) =>
    wrap(async () => (await loadGcpSdk()).testGcpIamPermissions(projectId, permissions))
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
  ipcMain.handle('gcp:vpc:list-networks', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpNetworks(projectId))
  )
  ipcMain.handle('gcp:vpc:list-subnetworks', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpSubnetworks(projectId, location))
  )
  ipcMain.handle('gcp:vpc:list-firewall-rules', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirewallRules(projectId))
  )
  ipcMain.handle('gcp:vpc:list-routers', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpRouters(projectId, location))
  )
  ipcMain.handle('gcp:vpc:list-global-addresses', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpGlobalAddresses(projectId))
  )
  ipcMain.handle('gcp:vpc:list-service-networking-connections', async (_event, projectId: string, networkNames: string[]) =>
    wrap(async () => (await loadGcpSdk()).listGcpServiceNetworkingConnections(projectId, networkNames))
  )

  /* ── Cloud DNS ── */
  ipcMain.handle('gcp:cloud-dns:list-zones', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpDnsManagedZones(projectId))
  )
  ipcMain.handle('gcp:cloud-dns:list-records', async (_event, projectId: string, managedZone: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpDnsResourceRecordSets(projectId, managedZone))
  )
  ipcMain.handle('gcp:cloud-dns:create-record', async (_event, projectId: string, managedZone: string, input: GcpDnsRecordUpsertInput) =>
    wrap(async () => (await loadGcpSdk()).createGcpDnsResourceRecordSet(projectId, managedZone, input))
  )
  ipcMain.handle('gcp:cloud-dns:update-record', async (_event, projectId: string, managedZone: string, input: GcpDnsRecordUpsertInput) =>
    wrap(async () => (await loadGcpSdk()).updateGcpDnsResourceRecordSet(projectId, managedZone, input))
  )
  ipcMain.handle('gcp:cloud-dns:delete-record', async (_event, projectId: string, managedZone: string, name: string, type: string) =>
    wrap(async () => (await loadGcpSdk()).deleteGcpDnsResourceRecordSet(projectId, managedZone, name, type))
  )

  // Memorystore (Redis)
  ipcMain.handle('gcp:memorystore:list-instances', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpMemorystoreInstances(projectId, location))
  )
  ipcMain.handle('gcp:memorystore:get-instance-detail', async (_event, projectId: string, instanceName: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpMemorystoreInstanceDetail(projectId, instanceName))
  )

  // Load Balancer + Cloud Armor
  ipcMain.handle('gcp:load-balancer:list-url-maps', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpUrlMaps(projectId))
  )
  ipcMain.handle('gcp:load-balancer:get-url-map-detail', async (_event, projectId: string, urlMapName: string, region?: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpUrlMapDetail(projectId, urlMapName, region))
  )
  ipcMain.handle('gcp:load-balancer:list-backend-services', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpBackendServices(projectId))
  )
  ipcMain.handle('gcp:load-balancer:list-forwarding-rules', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpForwardingRules(projectId))
  )
  ipcMain.handle('gcp:load-balancer:list-health-checks', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpHealthChecks(projectId))
  )
  ipcMain.handle('gcp:cloud-armor:list-security-policies', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpSecurityPolicies(projectId))
  )
  ipcMain.handle('gcp:cloud-armor:get-security-policy-detail', async (_event, projectId: string, policyName: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpSecurityPolicyDetail(projectId, policyName))
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

  // Pub/Sub
  ipcMain.handle('gcp:pubsub:list-topics', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpPubSubTopics(projectId))
  )
  ipcMain.handle('gcp:pubsub:list-subscriptions', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpPubSubSubscriptions(projectId))
  )
  ipcMain.handle('gcp:pubsub:get-topic-detail', async (_event, projectId: string, topicId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpPubSubTopicDetail(projectId, topicId))
  )
  ipcMain.handle('gcp:pubsub:get-subscription-detail', async (_event, projectId: string, subscriptionId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpPubSubSubscriptionDetail(projectId, subscriptionId))
  )

  // BigQuery
  ipcMain.handle('gcp:bigquery:list-datasets', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpBigQueryDatasetsExported(projectId))
  )
  ipcMain.handle('gcp:bigquery:list-tables', async (_event, projectId: string, datasetId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpBigQueryTables(projectId, datasetId))
  )
  ipcMain.handle('gcp:bigquery:get-table-detail', async (_event, projectId: string, datasetId: string, tableId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpBigQueryTableDetail(projectId, datasetId, tableId))
  )
  ipcMain.handle('gcp:bigquery:run-query', async (_event, projectId: string, queryText: string, maxResults?: number) =>
    wrap(async () => (await loadGcpSdk()).runGcpBigQueryQuery(projectId, queryText, maxResults))
  )

  // Cloud Monitoring
  ipcMain.handle('gcp:monitoring:list-alert-policies', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpMonitoringAlertPolicies(projectId))
  )
  ipcMain.handle('gcp:monitoring:list-uptime-checks', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpMonitoringUptimeChecks(projectId))
  )
  ipcMain.handle('gcp:monitoring:list-metric-descriptors', async (_event, projectId: string, filter?: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpMonitoringMetricDescriptors(projectId, filter))
  )
  ipcMain.handle('gcp:monitoring:query-time-series', async (_event, projectId: string, metricType: string, intervalMinutes: number) =>
    wrap(async () => (await loadGcpSdk()).queryGcpMonitoringTimeSeries(projectId, metricType, intervalMinutes))
  )

  // Security Command Center
  ipcMain.handle('gcp:scc:list-findings', async (_event, projectId: string, location?: string, filter?: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpSccFindings(projectId, location, filter))
  )
  ipcMain.handle('gcp:scc:list-sources', async (_event, projectId: string, location?: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpSccSources(projectId, location))
  )
  ipcMain.handle('gcp:scc:get-finding-detail', async (_event, projectId: string, findingName: string, location?: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpSccFindingDetail(projectId, findingName, location))
  )
  ipcMain.handle('gcp:scc:get-severity-breakdown', async (_event, projectId: string, location?: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpSccSeverityBreakdown(projectId, location))
  )

  // Firestore
  ipcMain.handle('gcp:firestore:list-databases', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirestoreDatabases(projectId))
  )
  ipcMain.handle('gcp:firestore:list-collections', async (_event, projectId: string, databaseId: string, parentDocumentPath?: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirestoreCollections(projectId, databaseId, parentDocumentPath))
  )
  ipcMain.handle('gcp:firestore:list-documents', async (_event, projectId: string, databaseId: string, collectionId: string, pageSize?: number) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirestoreDocuments(projectId, databaseId, collectionId, pageSize))
  )
  ipcMain.handle('gcp:firestore:get-document-detail', async (_event, projectId: string, databaseId: string, documentPath: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpFirestoreDocumentDetail(projectId, databaseId, documentPath))
  )

  // ── Cloud Run ──
  ipcMain.handle('gcp:cloud-run:list-services', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpCloudRunServices(projectId, location))
  )
  ipcMain.handle('gcp:cloud-run:list-revisions', async (_event, projectId: string, location: string, serviceId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpCloudRunRevisions(projectId, location, serviceId))
  )
  ipcMain.handle('gcp:cloud-run:list-jobs', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpCloudRunJobs(projectId, location))
  )
  ipcMain.handle('gcp:cloud-run:list-executions', async (_event, projectId: string, location: string, jobId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpCloudRunExecutions(projectId, location, jobId))
  )
  ipcMain.handle('gcp:cloud-run:list-domain-mappings', async (_event, projectId: string, location: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpCloudRunDomainMappings(projectId, location))
  )

  // ── Firebase ──
  ipcMain.handle('gcp:firebase:get-project', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpFirebaseProject(projectId))
  )
  ipcMain.handle('gcp:firebase:list-web-apps', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirebaseWebApps(projectId))
  )
  ipcMain.handle('gcp:firebase:list-android-apps', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirebaseAndroidApps(projectId))
  )
  ipcMain.handle('gcp:firebase:list-ios-apps', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirebaseIosApps(projectId))
  )
  ipcMain.handle('gcp:firebase:list-hosting-sites', async (_event, projectId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirebaseHostingSites(projectId))
  )
  ipcMain.handle('gcp:firebase:list-hosting-releases', async (_event, projectId: string, siteId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirebaseHostingReleases(projectId, siteId))
  )
  ipcMain.handle('gcp:firebase:list-hosting-domains', async (_event, projectId: string, siteId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirebaseHostingDomains(projectId, siteId))
  )
  ipcMain.handle('gcp:firebase:list-hosting-channels', async (_event, projectId: string, siteId: string) =>
    wrap(async () => (await loadGcpSdk()).listGcpFirebaseHostingChannels(projectId, siteId))
  )

  ipcMain.handle('azure:subscriptions:list', async () =>
    wrap(async () => (await loadAzureSdk()).listAzureSubscriptions())
  )
  ipcMain.handle('azure:rbac:get-overview', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).getAzureRbacOverview(subscriptionId))
  )
  ipcMain.handle('azure:rbac:list-assignments', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureRoleAssignments(subscriptionId))
  )
  ipcMain.handle('azure:rbac:list-role-definitions', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureRoleDefinitions(subscriptionId))
  )
  ipcMain.handle('azure:rbac:create-assignment', async (_event, subscriptionId: string, principalId: string, roleDefinitionId: string, scope: string) =>
    wrap(async () => (await loadAzureSdk()).createAzureRoleAssignment(subscriptionId, principalId, roleDefinitionId, scope))
  )
  ipcMain.handle('azure:rbac:delete-assignment', async (_event, assignmentId: string) =>
    wrap(async () => (await loadAzureSdk()).deleteAzureRoleAssignment(assignmentId))
  )
  ipcMain.handle('azure:virtual-machines:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureVirtualMachines(subscriptionId, location))
  )
  ipcMain.handle('azure:virtual-machines:describe', async (_event, subscriptionId: string, resourceGroup: string, vmName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureVirtualMachine(subscriptionId, resourceGroup, vmName))
  )
  ipcMain.handle('azure:virtual-machines:action', async (_event, subscriptionId: string, resourceGroup: string, vmName: string, action: AzureVmAction) =>
    wrap(async () => (await loadAzureSdk()).runAzureVmAction(subscriptionId, resourceGroup, vmName, action))
  )
  ipcMain.handle('azure:aks:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureAksClusters(subscriptionId, location))
  )
  ipcMain.handle('azure:aks:describe', async (_event, subscriptionId: string, resourceGroup: string, clusterName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureAksCluster(subscriptionId, resourceGroup, clusterName))
  )
  ipcMain.handle('azure:aks:list-node-pools', async (_event, subscriptionId: string, resourceGroup: string, clusterName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureAksNodePools(subscriptionId, resourceGroup, clusterName))
  )
  ipcMain.handle('azure:aks:update-node-pool-scaling', async (_event, subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, min: number, desired: number, max: number) =>
    wrap(async () => (await loadAzureSdk()).updateAzureAksNodePoolScaling(subscriptionId, resourceGroup, clusterName, nodePoolName, min, desired, max))
  )
  ipcMain.handle('azure:aks:toggle-node-pool-autoscaling', async (_event, subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, enable: boolean, minCount?: number, maxCount?: number) =>
    wrap(async () => (await loadAzureSdk()).toggleAzureAksNodePoolAutoscaling(subscriptionId, resourceGroup, clusterName, nodePoolName, enable, minCount, maxCount))
  )
  ipcMain.handle(
    'azure:aks:add-kubeconfig',
    async (_event, subscriptionId: string, resourceGroup: string, clusterName: string, contextName: string, kubeconfigPath: string) =>
      wrap(async () => (await loadAzureSdk()).addAksToKubeconfig(subscriptionId, resourceGroup, clusterName, contextName, kubeconfigPath))
  )
  ipcMain.handle('azure:aks:choose-kubeconfig-path', async (_event, currentPath?: string) =>
    wrap(async () => {
      const owner = getWindow()
      const normalizedCurrentPath = currentPath?.trim()
      const defaultPath = normalizedCurrentPath
        ? (normalizedCurrentPath === '.kube/config' || normalizedCurrentPath === '.kube\\config'
            ? path.join(os.homedir(), '.kube', 'config')
            : normalizedCurrentPath)
        : path.join(os.homedir(), '.kube', 'config')

      const result = owner
        ? await dialog.showSaveDialog(owner, {
            title: 'Choose kubeconfig location',
            defaultPath,
            buttonLabel: 'Select config'
          })
        : await dialog.showSaveDialog({
            title: 'Choose kubeconfig location',
            defaultPath,
            buttonLabel: 'Select config'
          })

      return result.canceled ? '' : result.filePath ?? ''
    })
  )
  ipcMain.handle('azure:storage-accounts:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageAccounts(subscriptionId, location))
  )
  ipcMain.handle('azure:storage-containers:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageContainers(subscriptionId, resourceGroup, accountName, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blobs:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, prefix: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageBlobs(subscriptionId, resourceGroup, accountName, containerName, prefix, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:get-content', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).getAzureStorageBlobContent(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:put-content', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, content: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).putAzureStorageBlobContent(subscriptionId, resourceGroup, accountName, containerName, key, content, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:upload', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, localPath: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).uploadAzureStorageBlob(subscriptionId, resourceGroup, accountName, containerName, key, localPath, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:download', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).downloadAzureStorageBlobToPath(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:delete', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).deleteAzureStorageBlob(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint))
  )
  ipcMain.handle('azure:storage-container:create', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).createAzureStorageContainer(subscriptionId, resourceGroup, accountName, containerName, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:open', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).openAzureStorageBlob(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:open-in-vscode', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).openAzureStorageBlobInVSCode(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint))
  )
  ipcMain.handle('azure:storage-blob:sas-url', async (_event, subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    wrap(async () => (await loadAzureSdk()).generateAzureStorageBlobSasUrl(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint))
  )
  ipcMain.handle('azure:sql:get-estate', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureSqlEstate(subscriptionId, location))
  )
  ipcMain.handle('azure:sql:describe-server', async (_event, subscriptionId: string, resourceGroup: string, serverName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureSqlServer(subscriptionId, resourceGroup, serverName))
  )
  ipcMain.handle('azure:postgresql:get-estate', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzurePostgreSqlEstate(subscriptionId, location))
  )
  ipcMain.handle('azure:postgresql:describe-server', async (_event, subscriptionId: string, resourceGroup: string, serverName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzurePostgreSqlServer(subscriptionId, resourceGroup, serverName))
  )
  ipcMain.handle('azure:monitor:list-activity', async (_event, subscriptionId: string, location: string, query: string, windowHours?: number) =>
    wrap(async () => (await loadAzureSdk()).listAzureMonitorActivity(subscriptionId, location, query, windowHours))
  )
  ipcMain.handle('azure:cost:get-overview', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).getAzureCostOverview(subscriptionId))
  )
  ipcMain.handle('azure:network:get-overview', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureNetworkOverview(subscriptionId, location))
  )
  ipcMain.handle('azure:network:list-subnets', async (_event, subscriptionId: string, resourceGroup: string, vnetName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureVNetSubnets(subscriptionId, resourceGroup, vnetName))
  )
  ipcMain.handle('azure:network:list-nsg-rules', async (_event, subscriptionId: string, resourceGroup: string, nsgName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureNsgRules(subscriptionId, resourceGroup, nsgName))
  )
  ipcMain.handle('azure:vmss:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureVmss(subscriptionId, location))
  )
  ipcMain.handle('azure:vmss:list-instances', async (_event, subscriptionId: string, resourceGroup: string, vmssName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureVmssInstances(subscriptionId, resourceGroup, vmssName))
  )
  ipcMain.handle('azure:vmss:update-capacity', async (_event, subscriptionId: string, resourceGroup: string, vmssName: string, capacity: number) =>
    wrap(async () => (await loadAzureSdk()).updateAzureVmssCapacity(subscriptionId, resourceGroup, vmssName, capacity))
  )
  ipcMain.handle('azure:vmss:instance-action', async (_event, subscriptionId: string, resourceGroup: string, vmssName: string, instanceId: string, action: string) =>
    wrap(async () => (await loadAzureSdk()).runAzureVmssInstanceAction(subscriptionId, resourceGroup, vmssName, instanceId, action as 'start' | 'powerOff' | 'restart' | 'deallocate'))
  )
  /* ── Application Insights ── */
  ipcMain.handle('azure:app-insights:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureAppInsightsComponents(subscriptionId, location))
  )

  /* ── Key Vault ── */
  ipcMain.handle('azure:key-vault:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureKeyVaults(subscriptionId, location))
  )
  ipcMain.handle('azure:key-vault:describe', async (_event, subscriptionId: string, resourceGroup: string, vaultName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureKeyVault(subscriptionId, resourceGroup, vaultName))
  )
  ipcMain.handle('azure:key-vault:list-secrets', async (_event, subscriptionId: string, resourceGroup: string, vaultName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureKeyVaultSecrets(subscriptionId, resourceGroup, vaultName))
  )
  ipcMain.handle('azure:key-vault:list-keys', async (_event, subscriptionId: string, resourceGroup: string, vaultName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureKeyVaultKeys(subscriptionId, resourceGroup, vaultName))
  )

  /* ── Event Hub ── */
  ipcMain.handle('azure:event-hub:list-namespaces', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventHubNamespaces(subscriptionId, location))
  )
  ipcMain.handle('azure:event-hub:list-hubs', async (_event, subscriptionId: string, resourceGroup: string, namespaceName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventHubs(subscriptionId, resourceGroup, namespaceName))
  )
  ipcMain.handle('azure:event-hub:list-consumer-groups', async (_event, subscriptionId: string, resourceGroup: string, namespaceName: string, eventHubName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventHubConsumerGroups(subscriptionId, resourceGroup, namespaceName, eventHubName))
  )

  /* ── App Service ── */
  ipcMain.handle('azure:app-service:list-plans', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureAppServicePlans(subscriptionId, location))
  )
  ipcMain.handle('azure:app-service:list-web-apps', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureWebApps(subscriptionId, location))
  )
  ipcMain.handle('azure:app-service:describe-web-app', async (_event, subscriptionId: string, resourceGroup: string, siteName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureWebApp(subscriptionId, resourceGroup, siteName))
  )
  ipcMain.handle('azure:app-service:list-slots', async (_event, subscriptionId: string, resourceGroup: string, siteName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureWebAppSlots(subscriptionId, resourceGroup, siteName))
  )
  ipcMain.handle('azure:app-service:list-deployments', async (_event, subscriptionId: string, resourceGroup: string, siteName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureWebAppDeployments(subscriptionId, resourceGroup, siteName))
  )

  /* ── Managed Disks ── */
  ipcMain.handle('azure:disks:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureManagedDisks(subscriptionId, location))
  )
  ipcMain.handle('azure:disk-snapshots:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDiskSnapshots(subscriptionId, location))
  )

  /* ── Network Enrichment ── */
  ipcMain.handle('azure:network:list-peerings', async (_event, subscriptionId: string, resourceGroup: string, vnetName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureVNetPeerings(subscriptionId, resourceGroup, vnetName))
  )
  ipcMain.handle('azure:network:list-route-tables', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureRouteTables(subscriptionId, location))
  )
  ipcMain.handle('azure:network:list-nat-gateways', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureNatGateways(subscriptionId, location))
  )
  ipcMain.handle('azure:network:list-load-balancers', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureLoadBalancers(subscriptionId, location))
  )
  ipcMain.handle('azure:network:list-private-endpoints', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzurePrivateEndpoints(subscriptionId, location))
  )

  /* ── Azure DNS ── */
  ipcMain.handle('azure:dns:list-zones', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDnsZones(subscriptionId, location))
  )
  ipcMain.handle('azure:dns:list-records', async (_event, subscriptionId: string, resourceGroup: string, zoneName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDnsRecordSets(subscriptionId, resourceGroup, zoneName))
  )
  ipcMain.handle('azure:dns:upsert-record', async (_event, subscriptionId: string, resourceGroup: string, zoneName: string, input: AzureDnsRecordUpsertInput) =>
    wrap(async () => (await loadAzureSdk()).upsertAzureDnsRecord(subscriptionId, resourceGroup, zoneName, input))
  )
  ipcMain.handle('azure:dns:delete-record', async (_event, subscriptionId: string, resourceGroup: string, zoneName: string, recordType: string, recordName: string) =>
    wrap(async () => (await loadAzureSdk()).deleteAzureDnsRecord(subscriptionId, resourceGroup, zoneName, recordType, recordName))
  )
  ipcMain.handle('azure:dns:create-zone', async (_event, subscriptionId: string, resourceGroup: string, zoneName: string, zoneType: 'Public' | 'Private') =>
    wrap(async () => (await loadAzureSdk()).createAzureDnsZone(subscriptionId, resourceGroup, zoneName, zoneType))
  )

  /* ── Storage Enrichment ── */
  ipcMain.handle('azure:storage-file-shares:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageFileShares(subscriptionId, resourceGroup, accountName))
  )
  ipcMain.handle('azure:storage-queues:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageQueues(subscriptionId, resourceGroup, accountName))
  )
  ipcMain.handle('azure:storage-tables:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageTables(subscriptionId, resourceGroup, accountName))
  )

  /* ── MySQL ── */
  ipcMain.handle('azure:mysql:get-estate', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureMySqlEstate(subscriptionId, location))
  )
  ipcMain.handle('azure:mysql:describe-server', async (_event, subscriptionId: string, resourceGroup: string, serverName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureMySqlServer(subscriptionId, resourceGroup, serverName))
  )

  /* ── Cosmos DB ── */
  ipcMain.handle('azure:cosmos-db:get-estate', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureCosmosDbEstate(subscriptionId, location))
  )
  ipcMain.handle('azure:cosmos-db:describe-account', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureCosmosDbAccount(subscriptionId, resourceGroup, accountName))
  )

  /* ── App Service / Functions Enrichment ── */
  ipcMain.handle('azure:app-service:list-function-apps', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureFunctionApps(subscriptionId, location))
  )
  ipcMain.handle('azure:app-service:list-functions', async (_event, subscriptionId: string, resourceGroup: string, siteName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureFunctions(subscriptionId, resourceGroup, siteName))
  )
  ipcMain.handle('azure:app-service:get-config', async (_event, subscriptionId: string, resourceGroup: string, siteName: string) =>
    wrap(async () => (await loadAzureSdk()).getAzureWebAppConfiguration(subscriptionId, resourceGroup, siteName))
  )
  ipcMain.handle('azure:app-service:action', async (_event, subscriptionId: string, resourceGroup: string, siteName: string, action: AzureWebAppAction) =>
    wrap(async () => (await loadAzureSdk()).runAzureWebAppAction(subscriptionId, resourceGroup, siteName, action))
  )

  /* ── Log Analytics ── */
  ipcMain.handle('azure:log-analytics:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureLogAnalyticsWorkspaces(subscriptionId, location))
  )
  ipcMain.handle('azure:log-analytics:query', async (_event, workspaceId: string, query: string, timespan: string) =>
    wrap(async () => (await loadAzureSdk()).queryAzureLogAnalytics(workspaceId, query, timespan))
  )
  ipcMain.handle('azure:log-analytics:list-saved-searches', async (_event, subscriptionId: string, resourceGroup: string, workspaceName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureLogAnalyticsSavedSearches(subscriptionId, resourceGroup, workspaceName))
  )
  ipcMain.handle('azure:log-analytics:list-linked-services', async (_event, subscriptionId: string, resourceGroup: string, workspaceName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureLogAnalyticsLinkedServices(subscriptionId, resourceGroup, workspaceName))
  )

  /* ── Event Grid ── */
  ipcMain.handle('azure:event-grid:list-topics', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventGridTopics(subscriptionId, location))
  )
  ipcMain.handle('azure:event-grid:list-system-topics', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventGridSystemTopics(subscriptionId, location))
  )
  ipcMain.handle('azure:event-grid:list-event-subscriptions', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventGridEventSubscriptions(subscriptionId))
  )
  ipcMain.handle('azure:event-grid:list-domains', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventGridDomains(subscriptionId, location))
  )
  ipcMain.handle('azure:event-grid:list-domain-topics', async (_event, subscriptionId: string, resourceGroup: string, domainName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventGridDomainTopics(subscriptionId, resourceGroup, domainName))
  )

  /* ── Azure Firewall ── */
  ipcMain.handle('azure:firewall:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureFirewalls(subscriptionId, location))
  )
  ipcMain.handle('azure:firewall:describe', async (_event, subscriptionId: string, resourceGroup: string, firewallName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureFirewall(subscriptionId, resourceGroup, firewallName))
  )

  /* ── Azure Load Balancers (detail) ── */
  ipcMain.handle('azure:load-balancers:describe', async (_event, subscriptionId: string, resourceGroup: string, lbName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureLoadBalancer(subscriptionId, resourceGroup, lbName))
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
