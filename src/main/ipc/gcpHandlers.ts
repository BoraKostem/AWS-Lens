import { ipcMain } from 'electron'

import type {
  GcpBillingAccountSummary,
  GcpBillingBudgetSummary,
  GcpBillingCostAnomaly,
  GcpBillingCostByLabel,
  GcpBillingCostForecast,
  GcpBillingCostTrend,
  GcpBillingDailyCostTrend,
  GcpBillingSkuBreakdown,
  GcpComputeInstanceAction,
  GcpDnsRecordUpsertInput,
  GcpIamAuditEntry,
  GcpIamPolicyAnalysisResult,
  GcpIamRecommendation,
  GcpIamRoleSummary,
  GcpLogEntriesResult,
  GcpMonitoringAggregatedMetric,
  GcpMonitoringDashboardDetail,
  GcpMonitoringDashboardSummary,
  GcpMonitoringGroupSummary,
  GcpMonitoringNotificationChannelSummary,
  GcpMonitoringServiceSummary,
  GcpMonitoringSloSummary,
  GcpServiceAccountDetail,
  GcpServiceAccountKeyReport,
  GcpWorkloadIdentityPoolSummary,
  GcpWorkloadIdentityProviderSummary
} from '@shared/types'
import {
  getGcpCliContext,
  listGcpProjects
} from '../gcpCli'
import { wrap } from './shared'

// ── Lazy loaders ──────────────────────────────────────────────────────────────

type GcpSdkModule = typeof import('../gcp')
type GcpIamModule = typeof import('../gcp/iam')
type GcpBillingModule = typeof import('../gcp/billing')
type GcpMonitoringModule = typeof import('../gcp/monitoring')

let gcpSdkPromise: Promise<GcpSdkModule> | null = null
let gcpIamPromise: Promise<GcpIamModule> | null = null
let gcpBillingPromise: Promise<GcpBillingModule> | null = null
let gcpMonitoringPromise: Promise<GcpMonitoringModule> | null = null

function loadGcpSdk(): Promise<GcpSdkModule> {
  if (!gcpSdkPromise) gcpSdkPromise = import('../gcp')
  return gcpSdkPromise
}

function loadGcpIam(): Promise<GcpIamModule> {
  if (!gcpIamPromise) gcpIamPromise = import('../gcp/iam')
  return gcpIamPromise
}

function loadGcpBilling(): Promise<GcpBillingModule> {
  if (!gcpBillingPromise) gcpBillingPromise = import('../gcp/billing')
  return gcpBillingPromise
}

function loadGcpMonitoring(): Promise<GcpMonitoringModule> {
  if (!gcpMonitoringPromise) gcpMonitoringPromise = import('../gcp/monitoring')
  return gcpMonitoringPromise
}

// ── GCP Cached Wrapper ──────────────────────────────────────────────────────────
const GCP_TTL = {
  COMPUTE: 60_000,
  NETWORK: 120_000,
  DATA: 60_000,
  IAM: 300_000,
  BILLING: 300_000,
  MONITOR: 120_000
} as const

let gcpCacheModule: typeof import('../gcp/cache') | null = null

async function loadGcpCache(): Promise<typeof import('../gcp/cache')> {
  if (!gcpCacheModule) gcpCacheModule = await import('../gcp/cache')
  return gcpCacheModule
}

async function cachedGcp<T>(
  cacheKey: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cache = await loadGcpCache()
  return cache.getOrFetch(cacheKey, fetcher, ttlMs)
}

// ── Handler registration ────────────────────────────────────────────────────────

export function registerGcpHandlers(): void {
  ipcMain.handle('gcp:cli-context', async () => wrap(() => getGcpCliContext()))
  ipcMain.handle('gcp:auth:status', async (_event, projectId: string) =>
    wrap(async () => {
      const { getCredentialStatus } = await import('../gcp/auth')
      return getCredentialStatus(projectId)
    })
  )
  ipcMain.handle('gcp:auth:refresh', async (_event, projectId: string) =>
    wrap(async () => {
      const { refreshCredentials } = await import('../gcp/auth')
      refreshCredentials(projectId)
      return { refreshed: true }
    })
  )
  ipcMain.handle('gcp:auth:set-impersonation', async (_event, targetServiceAccount: string | null) =>
    wrap(async () => {
      const { setImpersonationTarget } = await import('../gcp/auth')
      setImpersonationTarget(targetServiceAccount)
      return { target: targetServiceAccount }
    })
  )
  ipcMain.handle('gcp:cache:invalidate', async (_event, prefix: string) =>
    wrap(async () => {
      const cache = await loadGcpCache()
      const count = prefix ? cache.invalidatePrefix(prefix) : (cache.clearAllCache(), 0)
      return { invalidated: count }
    })
  )
  ipcMain.handle('gcp:cache:stats', async () =>
    wrap(async () => {
      const cache = await loadGcpCache()
      return cache.getCacheStats()
    })
  )
  ipcMain.handle('gcp:projects', async () => wrap(() => listGcpProjects()))
  ipcMain.handle('gcp:projects:get-overview', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:project-overview`, GCP_TTL.IAM, async () => (await loadGcpSdk()).getGcpProjectOverview(projectId)))
  )
  ipcMain.handle('gcp:iam:get-overview', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:iam-overview`, GCP_TTL.IAM, async () => (await loadGcpSdk()).getGcpIamOverview(projectId)))
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
    wrap(() => cachedGcp(`${projectId}:sa-keys:${email}`, GCP_TTL.IAM, async () => (await loadGcpSdk()).listGcpServiceAccountKeys(projectId, email)))
  )
  ipcMain.handle('gcp:iam:create-service-account-key', async (_event, projectId: string, email: string) =>
    wrap(async () => (await loadGcpSdk()).createGcpServiceAccountKey(projectId, email))
  )
  ipcMain.handle('gcp:iam:delete-service-account-key', async (_event, projectId: string, email: string, keyId: string) =>
    wrap(async () => (await loadGcpSdk()).deleteGcpServiceAccountKey(projectId, email, keyId))
  )
  ipcMain.handle('gcp:iam:list-roles', async (_event, projectId: string, scope: 'custom' | 'all') =>
    wrap(() => cachedGcp(`${projectId}:iam-roles:${scope}`, GCP_TTL.IAM, async () => (await loadGcpSdk()).listGcpRoles(projectId, scope)))
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

  // ── GCP IAM Extended (Console Feature Parity) ──────────────────────────────────
  ipcMain.handle('gcp:iam:get-service-account-detail', async (_event, projectId: string, email: string) =>
    wrap<GcpServiceAccountDetail>(() => cachedGcp(`${projectId}:sa-detail:${email}`, GCP_TTL.IAM, async () => (await loadGcpIam()).getGcpServiceAccountDetail(projectId, email)))
  )
  ipcMain.handle('gcp:iam:update-service-account', async (_event, projectId: string, email: string, displayName: string, description: string) =>
    wrap(async () => (await loadGcpIam()).updateGcpServiceAccount(projectId, email, displayName, description))
  )
  ipcMain.handle('gcp:iam:add-service-account-iam-binding', async (_event, projectId: string, email: string, role: string, member: string) =>
    wrap(async () => (await loadGcpIam()).addGcpServiceAccountIamBinding(projectId, email, role, member))
  )
  ipcMain.handle('gcp:iam:remove-service-account-iam-binding', async (_event, projectId: string, email: string, role: string, member: string) =>
    wrap(async () => (await loadGcpIam()).removeGcpServiceAccountIamBinding(projectId, email, role, member))
  )
  ipcMain.handle('gcp:iam:update-custom-role', async (_event, projectId: string, roleName: string, title: string, description: string, stage: string, permissions: string[]) =>
    wrap<GcpIamRoleSummary>(async () => (await loadGcpIam()).updateGcpCustomRole(projectId, roleName, title, description, stage, permissions))
  )
  ipcMain.handle('gcp:iam:undelete-custom-role', async (_event, projectId: string, roleName: string) =>
    wrap<GcpIamRoleSummary>(async () => (await loadGcpIam()).undeleteGcpCustomRole(projectId, roleName))
  )
  ipcMain.handle('gcp:iam:list-audit-entries', async (_event, projectId: string, windowHours?: number) =>
    wrap<GcpIamAuditEntry[]>(() => cachedGcp(`${projectId}:iam-audit:${windowHours ?? 24}`, GCP_TTL.IAM, async () => (await loadGcpIam()).listGcpIamAuditEntries(projectId, windowHours)))
  )
  ipcMain.handle('gcp:iam:generate-key-report', async (_event, projectId: string) =>
    wrap<GcpServiceAccountKeyReport>(() => cachedGcp(`${projectId}:sa-key-report`, GCP_TTL.IAM, async () => (await loadGcpIam()).generateGcpServiceAccountKeyReport(projectId)))
  )
  ipcMain.handle('gcp:iam:list-workload-identity-pools', async (_event, projectId: string) =>
    wrap<GcpWorkloadIdentityPoolSummary[]>(() => cachedGcp(`${projectId}:wi-pools`, GCP_TTL.IAM, async () => (await loadGcpIam()).listGcpWorkloadIdentityPools(projectId)))
  )
  ipcMain.handle('gcp:iam:list-workload-identity-providers', async (_event, projectId: string, poolId: string) =>
    wrap<GcpWorkloadIdentityProviderSummary[]>(() => cachedGcp(`${projectId}:wi-providers:${poolId}`, GCP_TTL.IAM, async () => (await loadGcpIam()).listGcpWorkloadIdentityProviders(projectId, poolId)))
  )
  ipcMain.handle('gcp:iam:list-recommendations', async (_event, projectId: string) =>
    wrap<GcpIamRecommendation[]>(() => cachedGcp(`${projectId}:iam-recommendations`, GCP_TTL.IAM, async () => (await loadGcpIam()).listGcpIamRecommendations(projectId)))
  )
  ipcMain.handle('gcp:iam:analyze-policy', async (_event, projectId: string, fullResourceName: string, permissions: string[], identity?: string) =>
    wrap<GcpIamPolicyAnalysisResult>(async () => (await loadGcpIam()).analyzeGcpIamPolicy(projectId, fullResourceName, permissions, identity))
  )

  // ── Compute Engine ─────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:compute-engine:list', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:compute:${location}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpComputeInstances(projectId, location)))
  )
  ipcMain.handle('gcp:compute-engine:get-detail', async (_event, projectId: string, zone: string, instanceName: string) =>
    wrap(() => cachedGcp(`${projectId}:compute-detail:${zone}:${instanceName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).getGcpComputeInstanceDetail(projectId, zone, instanceName)))
  )
  ipcMain.handle('gcp:compute-engine:list-machine-types', async (_event, projectId: string, zone: string) =>
    wrap(() => cachedGcp(`${projectId}:machine-types:${zone}`, GCP_TTL.IAM, async () => (await loadGcpSdk()).listGcpComputeMachineTypes(projectId, zone)))
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

  // ── VPC / Networking ───────────────────────────────────────────────────────────
  ipcMain.handle('gcp:vpc:list-networks', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:networks`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpNetworks(projectId)))
  )
  ipcMain.handle('gcp:vpc:list-subnetworks', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:subnets:${location}`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpSubnetworks(projectId, location)))
  )
  ipcMain.handle('gcp:vpc:list-firewall-rules', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:firewall-rules`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpFirewallRules(projectId)))
  )
  ipcMain.handle('gcp:vpc:list-routers', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:routers:${location}`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpRouters(projectId, location)))
  )
  ipcMain.handle('gcp:vpc:list-global-addresses', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:global-addresses`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpGlobalAddresses(projectId)))
  )
  ipcMain.handle('gcp:vpc:list-service-networking-connections', async (_event, projectId: string, networkNames: string[]) =>
    wrap(() => cachedGcp(`${projectId}:svc-net:${networkNames.join(',')}`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpServiceNetworkingConnections(projectId, networkNames)))
  )

  /* ── Cloud DNS ── */
  ipcMain.handle('gcp:cloud-dns:list-zones', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:dns-zones`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpDnsManagedZones(projectId)))
  )
  ipcMain.handle('gcp:cloud-dns:list-records', async (_event, projectId: string, managedZone: string) =>
    wrap(() => cachedGcp(`${projectId}:dns-records:${managedZone}`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpDnsResourceRecordSets(projectId, managedZone)))
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
    wrap(() => cachedGcp(`${projectId}:memorystore:${location}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpMemorystoreInstances(projectId, location)))
  )
  ipcMain.handle('gcp:memorystore:get-instance-detail', async (_event, projectId: string, instanceName: string) =>
    wrap(() => cachedGcp(`${projectId}:memorystore-detail:${instanceName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).getGcpMemorystoreInstanceDetail(projectId, instanceName)))
  )

  // Load Balancer + Cloud Armor
  ipcMain.handle('gcp:load-balancer:list-url-maps', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:url-maps`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpUrlMaps(projectId)))
  )
  ipcMain.handle('gcp:load-balancer:get-url-map-detail', async (_event, projectId: string, urlMapName: string, region?: string) =>
    wrap(() => cachedGcp(`${projectId}:url-map-detail:${urlMapName}:${region ?? ''}`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).getGcpUrlMapDetail(projectId, urlMapName, region)))
  )
  ipcMain.handle('gcp:load-balancer:list-backend-services', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:backend-services`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpBackendServices(projectId)))
  )
  ipcMain.handle('gcp:load-balancer:list-forwarding-rules', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:forwarding-rules`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpForwardingRules(projectId)))
  )
  ipcMain.handle('gcp:load-balancer:list-health-checks', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:health-checks`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpHealthChecks(projectId)))
  )
  ipcMain.handle('gcp:cloud-armor:list-security-policies', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:security-policies`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).listGcpSecurityPolicies(projectId)))
  )
  ipcMain.handle('gcp:cloud-armor:get-security-policy-detail', async (_event, projectId: string, policyName: string) =>
    wrap(() => cachedGcp(`${projectId}:security-policy:${policyName}`, GCP_TTL.NETWORK, async () => (await loadGcpSdk()).getGcpSecurityPolicyDetail(projectId, policyName)))
  )

  // ── GKE ────────────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:gke:list', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:gke:${location}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpGkeClusters(projectId, location)))
  )
  ipcMain.handle('gcp:gke:get-detail', async (_event, projectId: string, location: string, clusterName: string) =>
    wrap(() => cachedGcp(`${projectId}:gke-detail:${location}:${clusterName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).getGcpGkeClusterDetail(projectId, location, clusterName)))
  )
  ipcMain.handle('gcp:gke:list-node-pools', async (_event, projectId: string, location: string, clusterName: string) =>
    wrap(() => cachedGcp(`${projectId}:gke-nodepools:${location}:${clusterName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpGkeNodePools(projectId, location, clusterName)))
  )
  ipcMain.handle('gcp:gke:get-credentials', async (_event, projectId: string, location: string, clusterName: string, contextName?: string, kubeconfigPath?: string) =>
    wrap(async () => (await loadGcpSdk()).getGcpGkeClusterCredentials(projectId, location, clusterName, contextName, kubeconfigPath))
  )
  ipcMain.handle('gcp:gke:list-operations', async (_event, projectId: string, location: string, clusterName: string) =>
    wrap(() => cachedGcp(`${projectId}:gke-ops:${location}:${clusterName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpGkeOperations(projectId, location, clusterName)))
  )
  ipcMain.handle('gcp:gke:update-node-pool-scaling', async (_event, projectId: string, location: string, clusterName: string, nodePoolName: string, minimum: number, desired: number, maximum: number) =>
    wrap(async () => (await loadGcpSdk()).updateGcpGkeNodePoolScaling(projectId, location, clusterName, nodePoolName, minimum, desired, maximum))
  )

  // ── Cloud Storage ──────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:cloud-storage:list', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:buckets:${location}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpStorageBuckets(projectId, location)))
  )
  ipcMain.handle('gcp:cloud-storage:objects:list', async (_event, projectId: string, bucketName: string, prefix: string) =>
    wrap(() => cachedGcp(`${projectId}:objects:${bucketName}:${prefix}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpStorageObjects(projectId, bucketName, prefix)))
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

  // ── Logging ────────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:logging:list', async (_event, projectId: string, location: string, query: string, windowHours?: number) =>
    wrap(async () => (await loadGcpSdk()).listGcpLogEntries(projectId, location, query, windowHours))
  )

  // ── Cloud SQL ──────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:cloud-sql:list', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:sql:${location}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpSqlInstances(projectId, location)))
  )
  ipcMain.handle('gcp:cloud-sql:get-detail', async (_event, projectId: string, instanceName: string) =>
    wrap(() => cachedGcp(`${projectId}:sql-detail:${instanceName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).getGcpSqlInstanceDetail(projectId, instanceName)))
  )
  ipcMain.handle('gcp:cloud-sql:databases:list', async (_event, projectId: string, instanceName: string) =>
    wrap(() => cachedGcp(`${projectId}:sql-dbs:${instanceName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpSqlDatabases(projectId, instanceName)))
  )
  ipcMain.handle('gcp:cloud-sql:operations:list', async (_event, projectId: string, instanceName: string) =>
    wrap(() => cachedGcp(`${projectId}:sql-ops:${instanceName}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpSqlOperations(projectId, instanceName)))
  )

  // ── Billing ────────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:billing:get-overview', async (_event, projectId: string, catalogProjectIds: string[]) =>
    wrap(() => cachedGcp(`${projectId}:billing:${catalogProjectIds.join(',')}`, GCP_TTL.BILLING, async () => (await loadGcpSdk()).getGcpBillingOverview(projectId, catalogProjectIds)))
  )
  ipcMain.handle('gcp:billing:list-accounts', async (_event, projectId: string) =>
    wrap<GcpBillingAccountSummary[]>(() => cachedGcp(`${projectId}:billing-accounts`, GCP_TTL.BILLING, async () => (await loadGcpBilling()).listGcpBillingAccounts(projectId)))
  )
  ipcMain.handle('gcp:billing:cost-trend', async (_event, projectId: string, months?: number, catalogProjectIds?: string[]) =>
    wrap<GcpBillingCostTrend>(() => cachedGcp(`${projectId}:cost-trend:${months ?? 6}`, GCP_TTL.BILLING, async () => (await loadGcpBilling()).getGcpCostTrend(projectId, months, catalogProjectIds)))
  )
  ipcMain.handle('gcp:billing:daily-cost-trend', async (_event, projectId: string, days?: number, catalogProjectIds?: string[]) =>
    wrap<GcpBillingDailyCostTrend>(() => cachedGcp(`${projectId}:daily-cost:${days ?? 30}`, GCP_TTL.BILLING, async () => (await loadGcpBilling()).getGcpDailyCostTrend(projectId, days, catalogProjectIds)))
  )
  ipcMain.handle('gcp:billing:cost-by-label', async (_event, projectId: string, labelKey: string, catalogProjectIds?: string[]) =>
    wrap<GcpBillingCostByLabel>(async () => (await loadGcpBilling()).getGcpCostByLabel(projectId, labelKey, catalogProjectIds))
  )
  ipcMain.handle('gcp:billing:sku-breakdown', async (_event, projectId: string, serviceName: string, catalogProjectIds?: string[]) =>
    wrap<GcpBillingSkuBreakdown>(async () => (await loadGcpBilling()).getGcpSkuCostBreakdown(projectId, serviceName, catalogProjectIds))
  )
  ipcMain.handle('gcp:billing:list-budgets', async (_event, projectId: string, billingAccountName: string) =>
    wrap<GcpBillingBudgetSummary[]>(() => cachedGcp(`${projectId}:budgets:${billingAccountName}`, GCP_TTL.BILLING, async () => (await loadGcpBilling()).listGcpBillingBudgets(projectId, billingAccountName)))
  )
  ipcMain.handle('gcp:billing:cost-forecast', async (_event, projectId: string, catalogProjectIds?: string[]) =>
    wrap<GcpBillingCostForecast>(() => cachedGcp(`${projectId}:cost-forecast`, GCP_TTL.BILLING, async () => (await loadGcpBilling()).getGcpCostForecast(projectId, catalogProjectIds)))
  )
  ipcMain.handle('gcp:billing:cost-anomalies', async (_event, projectId: string, catalogProjectIds?: string[]) =>
    wrap<GcpBillingCostAnomaly[]>(() => cachedGcp(`${projectId}:cost-anomalies`, GCP_TTL.BILLING, async () => (await loadGcpBilling()).getGcpCostAnomalies(projectId, catalogProjectIds)))
  )

  // ── Pub/Sub ────────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:pubsub:list-topics', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:pubsub-topics`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpPubSubTopics(projectId)))
  )
  ipcMain.handle('gcp:pubsub:list-subscriptions', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:pubsub-subs`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpPubSubSubscriptions(projectId)))
  )
  ipcMain.handle('gcp:pubsub:get-topic-detail', async (_event, projectId: string, topicId: string) =>
    wrap(() => cachedGcp(`${projectId}:pubsub-topic:${topicId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).getGcpPubSubTopicDetail(projectId, topicId)))
  )
  ipcMain.handle('gcp:pubsub:get-subscription-detail', async (_event, projectId: string, subscriptionId: string) =>
    wrap(() => cachedGcp(`${projectId}:pubsub-sub:${subscriptionId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).getGcpPubSubSubscriptionDetail(projectId, subscriptionId)))
  )

  // ── BigQuery ───────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:bigquery:list-datasets', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:bq-datasets`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpBigQueryDatasetsExported(projectId)))
  )
  ipcMain.handle('gcp:bigquery:list-tables', async (_event, projectId: string, datasetId: string) =>
    wrap(() => cachedGcp(`${projectId}:bq-tables:${datasetId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpBigQueryTables(projectId, datasetId)))
  )
  ipcMain.handle('gcp:bigquery:get-table-detail', async (_event, projectId: string, datasetId: string, tableId: string) =>
    wrap(() => cachedGcp(`${projectId}:bq-table:${datasetId}:${tableId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).getGcpBigQueryTableDetail(projectId, datasetId, tableId)))
  )
  ipcMain.handle('gcp:bigquery:run-query', async (_event, projectId: string, queryText: string, maxResults?: number) =>
    wrap(async () => (await loadGcpSdk()).runGcpBigQueryQuery(projectId, queryText, maxResults))
  )

  // ── Cloud Monitoring ───────────────────────────────────────────────────────────
  ipcMain.handle('gcp:monitoring:list-alert-policies', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:monitoring-alerts`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).listGcpMonitoringAlertPolicies(projectId)))
  )
  ipcMain.handle('gcp:monitoring:list-uptime-checks', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:monitoring-uptime`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).listGcpMonitoringUptimeChecks(projectId)))
  )
  ipcMain.handle('gcp:monitoring:list-metric-descriptors', async (_event, projectId: string, filter?: string) =>
    wrap(() => cachedGcp(`${projectId}:metric-descriptors:${filter ?? ''}`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).listGcpMonitoringMetricDescriptors(projectId, filter)))
  )
  ipcMain.handle('gcp:monitoring:query-time-series', async (_event, projectId: string, metricType: string, intervalMinutes: number) =>
    wrap(async () => (await loadGcpSdk()).queryGcpMonitoringTimeSeries(projectId, metricType, intervalMinutes))
  )
  ipcMain.handle('gcp:monitoring:toggle-alert-policy', async (_event, projectId: string, policyName: string, enabled: boolean) =>
    wrap(async () => (await loadGcpMonitoring()).toggleGcpAlertPolicy(projectId, policyName, enabled))
  )
  ipcMain.handle('gcp:monitoring:delete-alert-policy', async (_event, projectId: string, policyName: string) =>
    wrap(async () => (await loadGcpMonitoring()).deleteGcpAlertPolicy(projectId, policyName))
  )
  ipcMain.handle('gcp:monitoring:create-alert-policy', async (_event, projectId: string, displayName: string, metricType: string, threshold: number, comparison: string, durationSeconds: number, notificationChannelNames: string[]) =>
    wrap(async () => (await loadGcpMonitoring()).createGcpAlertPolicy(projectId, displayName, metricType, threshold, comparison as 'COMPARISON_GT' | 'COMPARISON_LT' | 'COMPARISON_GE' | 'COMPARISON_LE', durationSeconds, notificationChannelNames))
  )
  ipcMain.handle('gcp:monitoring:list-notification-channels', async (_event, projectId: string) =>
    wrap<GcpMonitoringNotificationChannelSummary[]>(() => cachedGcp(`${projectId}:notification-channels`, GCP_TTL.MONITOR, async () => (await loadGcpMonitoring()).listGcpNotificationChannels(projectId)))
  )
  ipcMain.handle('gcp:monitoring:create-uptime-check', async (_event, projectId: string, displayName: string, host: string, path: string, useSsl: boolean, periodSeconds: number) =>
    wrap(async () => (await loadGcpMonitoring()).createGcpUptimeCheck(projectId, displayName, host, path, useSsl, periodSeconds))
  )
  ipcMain.handle('gcp:monitoring:delete-uptime-check', async (_event, projectId: string, uptimeCheckName: string) =>
    wrap(async () => (await loadGcpMonitoring()).deleteGcpUptimeCheck(projectId, uptimeCheckName))
  )
  ipcMain.handle('gcp:monitoring:query-aggregated-metric', async (_event, projectId: string, metricType: string, intervalMinutes: number, alignmentPeriodSeconds: number, aggregation: string, resourceFilter?: string) =>
    wrap<GcpMonitoringAggregatedMetric>(async () => (await loadGcpMonitoring()).queryGcpAggregatedMetric(projectId, metricType, intervalMinutes, alignmentPeriodSeconds, aggregation as 'ALIGN_MEAN' | 'ALIGN_MAX' | 'ALIGN_MIN' | 'ALIGN_SUM' | 'ALIGN_COUNT' | 'ALIGN_PERCENTILE_99', resourceFilter))
  )
  ipcMain.handle('gcp:monitoring:list-groups', async (_event, projectId: string) =>
    wrap<GcpMonitoringGroupSummary[]>(() => cachedGcp(`${projectId}:monitoring-groups`, GCP_TTL.MONITOR, async () => (await loadGcpMonitoring()).listGcpMonitoringGroups(projectId)))
  )
  ipcMain.handle('gcp:monitoring:list-dashboards', async (_event, projectId: string) =>
    wrap<GcpMonitoringDashboardSummary[]>(() => cachedGcp(`${projectId}:dashboards`, GCP_TTL.MONITOR, async () => (await loadGcpMonitoring()).listGcpMonitoringDashboards(projectId)))
  )
  ipcMain.handle('gcp:monitoring:get-dashboard', async (_event, projectId: string, dashboardName: string) =>
    wrap<GcpMonitoringDashboardDetail>(() => cachedGcp(`${projectId}:dashboard:${dashboardName}`, GCP_TTL.MONITOR, async () => (await loadGcpMonitoring()).getGcpMonitoringDashboard(projectId, dashboardName)))
  )
  ipcMain.handle('gcp:monitoring:list-log-entries', async (_event, projectId: string, filter: string, orderBy?: string, pageSize?: number, pageToken?: string) =>
    wrap<GcpLogEntriesResult>(async () => (await loadGcpMonitoring()).listGcpLogEntries(projectId, filter, orderBy as 'timestamp asc' | 'timestamp desc' | undefined, pageSize, pageToken))
  )
  ipcMain.handle('gcp:monitoring:list-services', async (_event, projectId: string) =>
    wrap<GcpMonitoringServiceSummary[]>(() => cachedGcp(`${projectId}:monitoring-services`, GCP_TTL.MONITOR, async () => (await loadGcpMonitoring()).listGcpMonitoringServices(projectId)))
  )
  ipcMain.handle('gcp:monitoring:list-slos', async (_event, projectId: string, serviceName: string) =>
    wrap<GcpMonitoringSloSummary[]>(() => cachedGcp(`${projectId}:slos:${serviceName}`, GCP_TTL.MONITOR, async () => (await loadGcpMonitoring()).listGcpMonitoringSlos(projectId, serviceName)))
  )

  // ── Security Command Center ────────────────────────────────────────────────────
  ipcMain.handle('gcp:scc:list-findings', async (_event, projectId: string, location?: string, filter?: string) =>
    wrap(() => cachedGcp(`${projectId}:scc-findings:${location ?? ''}:${filter ?? ''}`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).listGcpSccFindings(projectId, location, filter)))
  )
  ipcMain.handle('gcp:scc:list-sources', async (_event, projectId: string, location?: string) =>
    wrap(() => cachedGcp(`${projectId}:scc-sources:${location ?? ''}`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).listGcpSccSources(projectId, location)))
  )
  ipcMain.handle('gcp:scc:get-finding-detail', async (_event, projectId: string, findingName: string, location?: string) =>
    wrap(() => cachedGcp(`${projectId}:scc-finding:${findingName}`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).getGcpSccFindingDetail(projectId, findingName, location)))
  )
  ipcMain.handle('gcp:scc:get-severity-breakdown', async (_event, projectId: string, location?: string) =>
    wrap(() => cachedGcp(`${projectId}:scc-severity:${location ?? ''}`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).getGcpSccSeverityBreakdown(projectId, location)))
  )
  ipcMain.handle('gcp:scc:get-posture-report', async (_event, projectId: string, location?: string) =>
    wrap(() => cachedGcp(`${projectId}:scc-posture:${location ?? ''}`, GCP_TTL.MONITOR, async () => (await loadGcpSdk()).getGcpSccPostureReport(projectId, location)))
  )

  // ── Firestore ──────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:firestore:list-databases', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:firestore-dbs`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirestoreDatabases(projectId)))
  )
  ipcMain.handle('gcp:firestore:list-collections', async (_event, projectId: string, databaseId: string, parentDocumentPath?: string) =>
    wrap(() => cachedGcp(`${projectId}:firestore-cols:${databaseId}:${parentDocumentPath ?? ''}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirestoreCollections(projectId, databaseId, parentDocumentPath)))
  )
  ipcMain.handle('gcp:firestore:list-documents', async (_event, projectId: string, databaseId: string, collectionId: string, pageSize?: number) =>
    wrap(() => cachedGcp(`${projectId}:firestore-docs:${databaseId}:${collectionId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirestoreDocuments(projectId, databaseId, collectionId, pageSize)))
  )
  ipcMain.handle('gcp:firestore:get-document-detail', async (_event, projectId: string, databaseId: string, documentPath: string) =>
    wrap(() => cachedGcp(`${projectId}:firestore-doc:${databaseId}:${documentPath}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).getGcpFirestoreDocumentDetail(projectId, databaseId, documentPath)))
  )

  // ── Cloud Run ──────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:cloud-run:list-services', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:run-services:${location}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpCloudRunServices(projectId, location)))
  )
  ipcMain.handle('gcp:cloud-run:list-revisions', async (_event, projectId: string, location: string, serviceId: string) =>
    wrap(() => cachedGcp(`${projectId}:run-revisions:${location}:${serviceId}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpCloudRunRevisions(projectId, location, serviceId)))
  )
  ipcMain.handle('gcp:cloud-run:list-jobs', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:run-jobs:${location}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpCloudRunJobs(projectId, location)))
  )
  ipcMain.handle('gcp:cloud-run:list-executions', async (_event, projectId: string, location: string, jobId: string) =>
    wrap(() => cachedGcp(`${projectId}:run-execs:${location}:${jobId}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpCloudRunExecutions(projectId, location, jobId)))
  )
  ipcMain.handle('gcp:cloud-run:list-domain-mappings', async (_event, projectId: string, location: string) =>
    wrap(() => cachedGcp(`${projectId}:run-domains:${location}`, GCP_TTL.COMPUTE, async () => (await loadGcpSdk()).listGcpCloudRunDomainMappings(projectId, location)))
  )

  // ── Firebase ───────────────────────────────────────────────────────────────────
  ipcMain.handle('gcp:firebase:get-project', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-project`, GCP_TTL.DATA, async () => (await loadGcpSdk()).getGcpFirebaseProject(projectId)))
  )
  ipcMain.handle('gcp:firebase:list-web-apps', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-web-apps`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirebaseWebApps(projectId)))
  )
  ipcMain.handle('gcp:firebase:list-android-apps', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-android-apps`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirebaseAndroidApps(projectId)))
  )
  ipcMain.handle('gcp:firebase:list-ios-apps', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-ios-apps`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirebaseIosApps(projectId)))
  )
  ipcMain.handle('gcp:firebase:list-hosting-sites', async (_event, projectId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-hosting-sites`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirebaseHostingSites(projectId)))
  )
  ipcMain.handle('gcp:firebase:list-hosting-releases', async (_event, projectId: string, siteId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-releases:${siteId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirebaseHostingReleases(projectId, siteId)))
  )
  ipcMain.handle('gcp:firebase:list-hosting-domains', async (_event, projectId: string, siteId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-domains:${siteId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirebaseHostingDomains(projectId, siteId)))
  )
  ipcMain.handle('gcp:firebase:list-hosting-channels', async (_event, projectId: string, siteId: string) =>
    wrap(() => cachedGcp(`${projectId}:firebase-channels:${siteId}`, GCP_TTL.DATA, async () => (await loadGcpSdk()).listGcpFirebaseHostingChannels(projectId, siteId)))
  )
}
