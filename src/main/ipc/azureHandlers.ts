import { dialog, ipcMain, type BrowserWindow } from 'electron'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  AzureApplicationGatewaySummary,
  AzureBudgetSummary,
  AzureCostAnomaly,
  AzureCostByMeterCategory,
  AzureCostByResourceGroup,
  AzureCostByTag,
  AzureCostForecast,
  AzureCostTrend,
  AzureCrossSubscriptionQueryResult,
  AzureDiagnosticSettingSummary,
  AzureDnsRecordUpsertInput,
  AzureActionGroupSummary,
  AzureEffectiveNsgRule,
  AzureEffectiveRoute,
  AzureExpressRouteCircuitSummary,
  AzureLogAnalyticsHistoryEntry,
  AzureLogAnalyticsQueryTemplate,
  AzureLogAnalyticsQueryWithMeta,
  AzureManagementGroupSummary,
  AzureMetricAlertRuleSummary,
  AzureMetricQueryResult,
  AzureNetworkTopology,
  AzurePrivateDnsVNetLink,
  AzurePrivateDnsZoneSummary,
  AzureProviderContextSnapshot,
  AzureReservationUtilization,
  AzureResourceHealthSummary,
  AzureScheduledQueryRuleSummary,
  AzureServiceHealthEvent,
  AzureVmAction,
  AzureVNetTopologyDetail,
  AzureVpnGatewaySummary,
  AzureWebAppAction
} from '@shared/types'
import {
  getAzureProviderContext,
  listAzureManagementGroups,
  queryCrossSubscriptionResources,
  setAzureActiveLocation,
  setAzureActiveSubscription,
  setAzureActiveTenant,
  signOutAzureProvider,
  startAzureDeviceCodeSignIn,
  toggleAzureFavoriteSubscription
} from '../azureFoundation'
import { wrap } from './shared'

// ── Lazy loader ──────────────────────────────────────────────────────────────

type AzureSdkModule = typeof import('../azure')
let azureSdkPromise: Promise<AzureSdkModule> | null = null

function loadAzureSdk(): Promise<AzureSdkModule> {
  if (!azureSdkPromise) azureSdkPromise = import('../azure')
  return azureSdkPromise
}

// ── Handler registration ──────��─────────────────────────────────────────────────

export function registerAzureHandlers(getWindow: () => BrowserWindow | null): void {
  // ── Azure Foundation / Context ──────────────────────────────────────────────
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
  ipcMain.handle('azure:auth:silent-refresh', async () =>
    wrap(async () => {
      const { silentTokenRefresh } = await import('../azure/auth')
      const refreshed = await silentTokenRefresh()
      return { refreshed }
    })
  )
  ipcMain.handle('azure:auth:credential-status', async () =>
    wrap(async () => {
      const { getAzureCredentialStatus } = await import('../azure/auth')
      return getAzureCredentialStatus()
    })
  )
  ipcMain.handle('azure:context:toggle-favorite-subscription', async (_event, subscriptionId: string) =>
    wrap<AzureProviderContextSnapshot>(async () => toggleAzureFavoriteSubscription(subscriptionId))
  )
  ipcMain.handle('azure:context:list-management-groups', async () =>
    wrap<AzureManagementGroupSummary[]>(async () => listAzureManagementGroups())
  )
  ipcMain.handle('azure:context:cross-subscription-query', async (_event, subscriptionIds: string[], query: string) =>
    wrap<AzureCrossSubscriptionQueryResult>(async () => queryCrossSubscriptionResources(subscriptionIds, query))
  )

  // ── Subscriptions / Resource Groups / RBAC ─────────────────────────────────
  ipcMain.handle('azure:subscriptions:list', async () =>
    wrap(async () => (await loadAzureSdk()).listAzureSubscriptions())
  )
  ipcMain.handle('azure:resource-groups:list', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureResourceGroups(subscriptionId))
  )
  ipcMain.handle('azure:resource-groups:list-resources', async (_event, subscriptionId: string, resourceGroupName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureResourceGroupResources(subscriptionId, resourceGroupName))
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

  // ── Defender for Cloud ─────────────────────────────────────────────────────
  ipcMain.handle('azure:defender:get-secure-score', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).getAzureDefenderSecureScore(subscriptionId))
  )
  ipcMain.handle('azure:defender:list-secure-score-controls', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDefenderSecureScoreControls(subscriptionId))
  )
  ipcMain.handle('azure:defender:list-recommendations', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDefenderRecommendations(subscriptionId))
  )
  ipcMain.handle('azure:defender:list-alerts', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDefenderAlerts(subscriptionId))
  )
  ipcMain.handle('azure:defender:list-compliance-standards', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDefenderComplianceStandards(subscriptionId))
  )
  ipcMain.handle('azure:defender:list-attack-paths', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDefenderAttackPaths(subscriptionId))
  )
  ipcMain.handle('azure:defender:get-report', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).getAzureDefenderReport(subscriptionId))
  )

  // ── Virtual Machines ───────────────────────────────────────────────────────
  ipcMain.handle('azure:virtual-machines:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureVirtualMachines(subscriptionId, location))
  )
  ipcMain.handle('azure:virtual-machines:describe', async (_event, subscriptionId: string, resourceGroup: string, vmName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureVirtualMachine(subscriptionId, resourceGroup, vmName))
  )
  ipcMain.handle('azure:virtual-machines:action', async (_event, subscriptionId: string, resourceGroup: string, vmName: string, action: AzureVmAction) =>
    wrap(async () => (await loadAzureSdk()).runAzureVmAction(subscriptionId, resourceGroup, vmName, action))
  )

  // ── AKS ────────────────────────────────────────────────────────────────────
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

  // ── Storage Accounts ────────��──────────────────────────────────────────────
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
  ipcMain.handle('azure:storage-file-shares:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageFileShares(subscriptionId, resourceGroup, accountName))
  )
  ipcMain.handle('azure:storage-queues:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageQueues(subscriptionId, resourceGroup, accountName))
  )
  ipcMain.handle('azure:storage-tables:list', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureStorageTables(subscriptionId, resourceGroup, accountName))
  )

  // ── Databases ──────────────────────────────────────────────────────────────
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
  ipcMain.handle('azure:mysql:get-estate', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureMySqlEstate(subscriptionId, location))
  )
  ipcMain.handle('azure:mysql:describe-server', async (_event, subscriptionId: string, resourceGroup: string, serverName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureMySqlServer(subscriptionId, resourceGroup, serverName))
  )
  ipcMain.handle('azure:cosmos-db:get-estate', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureCosmosDbEstate(subscriptionId, location))
  )
  ipcMain.handle('azure:cosmos-db:describe-account', async (_event, subscriptionId: string, resourceGroup: string, accountName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureCosmosDbAccount(subscriptionId, resourceGroup, accountName))
  )

  // ── Monitor / Activity ─────────────────────────────────────────────────────
  ipcMain.handle('azure:monitor:list-activity', async (_event, subscriptionId: string, location: string, query: string, windowHours?: number) =>
    wrap(async () => (await loadAzureSdk()).listAzureMonitorActivity(subscriptionId, location, query, windowHours))
  )
  ipcMain.handle('azure:cost:get-overview', async (_event, subscriptionId: string) =>
    wrap(async () => (await loadAzureSdk()).getAzureCostOverview(subscriptionId))
  )

  // ── Azure Cost Management Extended ─────────────────────────────────────────
  ipcMain.handle('azure:cost:trend', async (_event, subscriptionId: string, months?: number) =>
    wrap<AzureCostTrend>(async () => {
      const { getAzureCostTrend } = await import('../azure/cost')
      return getAzureCostTrend(subscriptionId, months)
    })
  )
  ipcMain.handle('azure:cost:by-resource-group', async (_event, subscriptionId: string) =>
    wrap<AzureCostByResourceGroup>(async () => {
      const { getAzureCostByResourceGroup } = await import('../azure/cost')
      return getAzureCostByResourceGroup(subscriptionId)
    })
  )
  ipcMain.handle('azure:cost:by-meter-category', async (_event, subscriptionId: string) =>
    wrap<AzureCostByMeterCategory>(async () => {
      const { getAzureCostByMeterCategory } = await import('../azure/cost')
      return getAzureCostByMeterCategory(subscriptionId)
    })
  )
  ipcMain.handle('azure:cost:by-tag', async (_event, subscriptionId: string, tagKey: string) =>
    wrap<AzureCostByTag>(async () => {
      const { getAzureCostByTag } = await import('../azure/cost')
      return getAzureCostByTag(subscriptionId, tagKey)
    })
  )
  ipcMain.handle('azure:cost:forecast', async (_event, subscriptionId: string) =>
    wrap<AzureCostForecast>(async () => {
      const { getAzureCostForecast } = await import('../azure/cost')
      return getAzureCostForecast(subscriptionId)
    })
  )
  ipcMain.handle('azure:cost:list-budgets', async (_event, subscriptionId: string) =>
    wrap<AzureBudgetSummary[]>(async () => {
      const { listAzureBudgets } = await import('../azure/cost')
      return listAzureBudgets(subscriptionId)
    })
  )
  ipcMain.handle('azure:cost:reservation-utilization', async (_event, subscriptionId: string) =>
    wrap<AzureReservationUtilization>(async () => {
      const { getAzureReservationUtilization } = await import('../azure/cost')
      return getAzureReservationUtilization(subscriptionId)
    })
  )
  ipcMain.handle('azure:cost:anomalies', async (_event, subscriptionId: string) =>
    wrap<AzureCostAnomaly[]>(async () => {
      const { getAzureCostAnomalies } = await import('../azure/cost')
      return getAzureCostAnomalies(subscriptionId)
    })
  )

  // ── Azure Monitor / Log Analytics Extended ─────────────────────────────────
  ipcMain.handle('azure:monitor:list-metric-alert-rules', async (_event, subscriptionId: string) =>
    wrap<AzureMetricAlertRuleSummary[]>(async () => {
      const { listAzureMetricAlertRules } = await import('../azure/monitor')
      return listAzureMetricAlertRules(subscriptionId)
    })
  )
  ipcMain.handle('azure:monitor:list-scheduled-query-rules', async (_event, subscriptionId: string) =>
    wrap<AzureScheduledQueryRuleSummary[]>(async () => {
      const { listAzureScheduledQueryRules } = await import('../azure/monitor')
      return listAzureScheduledQueryRules(subscriptionId)
    })
  )
  ipcMain.handle('azure:monitor:list-action-groups', async (_event, subscriptionId: string) =>
    wrap<AzureActionGroupSummary[]>(async () => {
      const { listAzureActionGroups } = await import('../azure/monitor')
      return listAzureActionGroups(subscriptionId)
    })
  )
  ipcMain.handle('azure:monitor:query-metrics', async (_event, resourceId: string, metricNames: string, timespan?: string, interval?: string, aggregation?: string) =>
    wrap<AzureMetricQueryResult>(async () => {
      const { queryAzureMetrics } = await import('../azure/monitor')
      return queryAzureMetrics(resourceId, metricNames, timespan, interval, aggregation)
    })
  )
  ipcMain.handle('azure:monitor:list-diagnostic-settings', async (_event, resourceId: string) =>
    wrap<AzureDiagnosticSettingSummary[]>(async () => {
      const { listAzureDiagnosticSettings } = await import('../azure/monitor')
      return listAzureDiagnosticSettings(resourceId)
    })
  )
  ipcMain.handle('azure:log-analytics:query-templates', async () =>
    wrap<AzureLogAnalyticsQueryTemplate[]>(async () => {
      const { getAzureLogAnalyticsQueryTemplates } = await import('../azure/monitor')
      return getAzureLogAnalyticsQueryTemplates()
    })
  )
  ipcMain.handle('azure:log-analytics:query-with-timeout', async (_event, workspaceId: string, query: string, timespan?: string, timeoutSeconds?: number) =>
    wrap<AzureLogAnalyticsQueryWithMeta>(async () => {
      const { queryAzureLogAnalyticsWithTimeout } = await import('../azure/monitor')
      return queryAzureLogAnalyticsWithTimeout(workspaceId, query, timespan, timeoutSeconds)
    })
  )
  ipcMain.handle('azure:log-analytics:export-csv', async (_event, tables: Array<{ name: string; columns: Array<{ name: string; type: string }>; rows: unknown[][] }>) =>
    wrap<string>(async () => {
      const { exportAzureLogAnalyticsResultCsv } = await import('../azure/monitor')
      return exportAzureLogAnalyticsResultCsv(tables)
    })
  )
  ipcMain.handle('azure:log-analytics:history', async (_event, workspaceId: string) =>
    wrap<AzureLogAnalyticsHistoryEntry[]>(async () => {
      const { getAzureLogAnalyticsQueryHistory } = await import('../azure/monitor')
      return getAzureLogAnalyticsQueryHistory(workspaceId)
    })
  )
  ipcMain.handle('azure:log-analytics:clear-history', async (_event, workspaceId?: string) =>
    wrap<void>(async () => {
      const { clearAzureLogAnalyticsQueryHistory } = await import('../azure/monitor')
      clearAzureLogAnalyticsQueryHistory(workspaceId)
    })
  )
  ipcMain.handle('azure:monitor:list-resource-health', async (_event, subscriptionId: string) =>
    wrap<AzureResourceHealthSummary[]>(async () => {
      const { listAzureResourceHealth } = await import('../azure/monitor')
      return listAzureResourceHealth(subscriptionId)
    })
  )
  ipcMain.handle('azure:monitor:list-service-health-events', async (_event, subscriptionId: string, eventType?: string) =>
    wrap<AzureServiceHealthEvent[]>(async () => {
      const { listAzureServiceHealthEvents } = await import('../azure/monitor')
      return listAzureServiceHealthEvents(subscriptionId, eventType as 'ServiceIssue' | 'PlannedMaintenance' | 'HealthAdvisory' | 'SecurityAdvisory' | undefined)
    })
  )

  // ── Azure Network Topology Extended ────��───────────────────────────────────
  ipcMain.handle('azure:network:list-application-gateways', async (_event, subscriptionId: string, location?: string) =>
    wrap<AzureApplicationGatewaySummary[]>(async () => {
      const { listAzureApplicationGateways } = await import('../azure/network')
      return listAzureApplicationGateways(subscriptionId, location)
    })
  )
  ipcMain.handle('azure:network:list-vpn-gateways', async (_event, subscriptionId: string, location?: string) =>
    wrap<AzureVpnGatewaySummary[]>(async () => {
      const { listAzureVpnGateways } = await import('../azure/network')
      return listAzureVpnGateways(subscriptionId, location)
    })
  )
  ipcMain.handle('azure:network:list-express-route-circuits', async (_event, subscriptionId: string, location?: string) =>
    wrap<AzureExpressRouteCircuitSummary[]>(async () => {
      const { listAzureExpressRouteCircuits } = await import('../azure/network')
      return listAzureExpressRouteCircuits(subscriptionId, location)
    })
  )
  ipcMain.handle('azure:network:list-private-dns-zones', async (_event, subscriptionId: string) =>
    wrap<AzurePrivateDnsZoneSummary[]>(async () => {
      const { listAzurePrivateDnsZones } = await import('../azure/network')
      return listAzurePrivateDnsZones(subscriptionId)
    })
  )
  ipcMain.handle('azure:network:list-private-dns-vnet-links', async (_event, subscriptionId: string, resourceGroup: string, zoneName: string) =>
    wrap<AzurePrivateDnsVNetLink[]>(async () => {
      const { listAzurePrivateDnsVNetLinks } = await import('../azure/network')
      return listAzurePrivateDnsVNetLinks(subscriptionId, resourceGroup, zoneName)
    })
  )
  ipcMain.handle('azure:network:effective-routes', async (_event, subscriptionId: string, resourceGroup: string, nicName: string) =>
    wrap<AzureEffectiveRoute[]>(async () => {
      const { getAzureEffectiveRoutes } = await import('../azure/network')
      return getAzureEffectiveRoutes(subscriptionId, resourceGroup, nicName)
    })
  )
  ipcMain.handle('azure:network:effective-nsg-rules', async (_event, subscriptionId: string, resourceGroup: string, nicName: string) =>
    wrap<AzureEffectiveNsgRule[]>(async () => {
      const { getAzureEffectiveNsgRules } = await import('../azure/network')
      return getAzureEffectiveNsgRules(subscriptionId, resourceGroup, nicName)
    })
  )
  ipcMain.handle('azure:network:topology', async (_event, subscriptionId: string, location?: string) =>
    wrap<AzureNetworkTopology>(async () => {
      const { getAzureNetworkTopology } = await import('../azure/network')
      return getAzureNetworkTopology(subscriptionId, location)
    })
  )
  ipcMain.handle('azure:network:vnet-topology-detail', async (_event, subscriptionId: string, resourceGroup: string, vnetName: string) =>
    wrap<AzureVNetTopologyDetail>(async () => {
      const { getAzureVNetTopologyDetail } = await import('../azure/network')
      return getAzureVNetTopologyDetail(subscriptionId, resourceGroup, vnetName)
    })
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

  // ── VMSS ───────────────────────────────────────────────────────────────────
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

  // ── Application Insights ───────────────────────────────────────────────────
  ipcMain.handle('azure:app-insights:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureAppInsightsComponents(subscriptionId, location))
  )

  // ── Key Vault ─────��────────────────────────────────────────────────────────
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

  // ── Event Hub ──────────────────────────���───────────────────────────────────
  ipcMain.handle('azure:event-hub:list-namespaces', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventHubNamespaces(subscriptionId, location))
  )
  ipcMain.handle('azure:event-hub:list-hubs', async (_event, subscriptionId: string, resourceGroup: string, namespaceName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventHubs(subscriptionId, resourceGroup, namespaceName))
  )
  ipcMain.handle('azure:event-hub:list-consumer-groups', async (_event, subscriptionId: string, resourceGroup: string, namespaceName: string, eventHubName: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureEventHubConsumerGroups(subscriptionId, resourceGroup, namespaceName, eventHubName))
  )

  // ── App Service ────────────────────────────────────────────────────────────
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

  // ── Managed Disks ──────────────────────────────────────────────────────────
  ipcMain.handle('azure:disks:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureManagedDisks(subscriptionId, location))
  )
  ipcMain.handle('azure:disk-snapshots:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureDiskSnapshots(subscriptionId, location))
  )

  // ── DNS ────────────────────────────────────────────────────────────────────
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

  // ── Log Analytics ──────────────────────────────────────────────────────────
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

  // ── Event Grid ────��──────────────────────────────���─────────────────────────
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

  // ── Firewall ───────────────────────────────────────────────────────────────
  ipcMain.handle('azure:firewall:list', async (_event, subscriptionId: string, location: string) =>
    wrap(async () => (await loadAzureSdk()).listAzureFirewalls(subscriptionId, location))
  )
  ipcMain.handle('azure:firewall:describe', async (_event, subscriptionId: string, resourceGroup: string, firewallName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureFirewall(subscriptionId, resourceGroup, firewallName))
  )

  // ── Load Balancers (detail) ──────���─────────────────────────────────────────
  ipcMain.handle('azure:load-balancers:describe', async (_event, subscriptionId: string, resourceGroup: string, lbName: string) =>
    wrap(async () => (await loadAzureSdk()).describeAzureLoadBalancer(subscriptionId, resourceGroup, lbName))
  )
}
