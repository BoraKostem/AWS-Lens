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
  getAzureCostAnomalies
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
  listAzureServiceHealthEvents
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
  getAzureVNetTopologyDetail
} from './network'
