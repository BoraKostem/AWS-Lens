export {
  MAX_PAGINATION_PAGES,
  getAzureCredential,
  resetAzureCredential,
  getAzureAccessToken,
  classifyAzureError,
  fetchAzureArmJson,
  fetchAzureArmCollection,
  mapWithConcurrency
} from './client'

export {
  getSdkCredential,
  clearSdkAuth,
  startSdkDeviceCodeAuth,
  silentTokenRefresh,
  tokenNeedsRefresh,
  getAzureCredentialStatus,
  classifyAzureAuthError,
  type AzureCredentialStatus,
  type DeviceCodePromptInfo
} from './auth'

export {
  getAzureCostTrend,
  getAzureCostByResourceGroup,
  getAzureCostByMeterCategory,
  getAzureCostByTag,
  getAzureCostForecast,
  listAzureBudgets,
  getAzureReservationUtilization,
  getAzureCostAnomalies,
  getAzureCostOverview
} from './cost'

export {
  listAzureMetricAlertRules,
  listAzureScheduledQueryRules,
  listAzureActionGroups,
  queryAzureMetrics,
  listAzureDiagnosticSettings,
  getAzureLogAnalyticsQueryTemplates,
  queryAzureLogAnalyticsWithTimeout,
  exportAzureLogAnalyticsResultCsv,
  getAzureLogAnalyticsQueryHistory,
  clearAzureLogAnalyticsQueryHistory,
  listAzureResourceHealth,
  listAzureServiceHealthEvents,
  listAzureMonitorActivity
} from './monitor'

export {
  listAzureApplicationGateways,
  listAzureVpnGateways,
  listAzureExpressRouteCircuits,
  listAzurePrivateDnsZones,
  listAzurePrivateDnsVNetLinks,
  getAzureEffectiveRoutes,
  getAzureEffectiveNsgRules,
  getAzureNetworkTopology,
  getAzureVNetTopologyDetail,
  listAzureNetworkOverview,
  listAzureVNetSubnets,
  listAzureNsgRules,
  listAzureVNetPeerings,
  listAzureRouteTables,
  listAzureNatGateways,
  listAzurePrivateEndpoints
} from './network'

export {
  extractResourceGroup,
  extractResourceName,
  extractPowerState,
  extractProvisioningState,
  normalizeLocationList,
  normalizeRegion,
  inferScopeKind,
  toFacetCounts,
  guessContentTypeFromKey,
  streamToBuffer,
  listSubscriptionLocations,
  isWindowsBatchFile,
  getAzureStorageAccountKey,
  getAzureBlobServiceClient,
  getEnvironmentHealthReport
} from './shared'

export {
  listAzureSubscriptions
} from './subscriptions'

export {
  listAzureResourceGroups,
  listAzureResourceGroupResources
} from './resourceGroups'

export {
  getAzureRbacOverview,
  listAzureRoleDefinitions,
  listAzureRoleAssignments,
  createAzureRoleAssignment,
  deleteAzureRoleAssignment
} from './rbac'

export {
  listAzureVirtualMachines,
  describeAzureVirtualMachine,
  runAzureVmAction
} from './virtualMachines'

export {
  listAzureAksClusters,
  describeAzureAksCluster,
  listAzureAksNodePools,
  updateAzureAksNodePoolScaling,
  toggleAzureAksNodePoolAutoscaling,
  addAksToKubeconfig
} from './aks'

export {
  listAzureVmss,
  listAzureVmssInstances,
  updateAzureVmssCapacity,
  runAzureVmssInstanceAction
} from './vmss'

export {
  listAzureStorageAccounts,
  listAzureStorageContainers,
  listAzureStorageBlobs,
  getAzureStorageBlobContent,
  putAzureStorageBlobContent,
  uploadAzureStorageBlob,
  downloadAzureStorageBlobToPath,
  deleteAzureStorageBlob,
  createAzureStorageContainer,
  openAzureStorageBlob,
  openAzureStorageBlobInVSCode,
  generateAzureStorageBlobSasUrl,
  listAzureStorageFileShares,
  listAzureStorageQueues,
  listAzureStorageTables
} from './storageAccounts'

export {
  listAzureSqlEstate,
  describeAzureSqlServer
} from './sqlServer'

export {
  listAzurePostgreSqlEstate,
  describeAzurePostgreSqlServer
} from './postgresql'

export {
  listAzureManagedDisks,
  listAzureDiskSnapshots
} from './managedDisks'

export {
  listAzureMySqlEstate,
  describeAzureMySqlServer
} from './mysql'

export {
  listAzureCosmosDbEstate,
  describeAzureCosmosDbAccount
} from './cosmosDb'

export {
  listAzureAppInsightsComponents
} from './appInsights'

export {
  listAzureKeyVaults,
  describeAzureKeyVault,
  listAzureKeyVaultSecrets,
  listAzureKeyVaultKeys
} from './keyVault'

export {
  listAzureEventHubNamespaces,
  listAzureEventHubs,
  listAzureEventHubConsumerGroups
} from './eventHubs'

export {
  listAzureAppServicePlans,
  listAzureWebApps,
  describeAzureWebApp,
  listAzureWebAppSlots,
  listAzureWebAppDeployments,
  listAzureFunctionApps,
  listAzureFunctions,
  getAzureWebAppConfiguration,
  runAzureWebAppAction
} from './appService'

export {
  listAzureLogAnalyticsWorkspaces,
  queryAzureLogAnalytics,
  listAzureLogAnalyticsSavedSearches,
  listAzureLogAnalyticsLinkedServices
} from './logAnalytics'

export {
  listAzureEventGridTopics,
  listAzureEventGridSystemTopics,
  listAzureEventGridEventSubscriptions,
  listAzureEventGridDomains,
  listAzureEventGridDomainTopics
} from './eventGrid'

export {
  listAzureDnsZones,
  listAzureDnsRecordSets,
  upsertAzureDnsRecord,
  deleteAzureDnsRecord,
  createAzureDnsZone
} from './dns'

export {
  listAzureFirewalls,
  describeAzureFirewall
} from './firewall'

export {
  listAzureLoadBalancers,
  describeAzureLoadBalancer
} from './loadBalancers'

// ── Terraform Insights ─────────────────────────────────────────────────────
// Terraform insights files may import from here; modules in this directory
// must NOT import from terraform insights (one-way dependency).

export {
  getAzureTerraformDriftReport
} from './terraformDrift'

export {
  generateAzureTerraformObservabilityReport
} from './terraformObservability'
