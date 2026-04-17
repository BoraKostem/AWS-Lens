// Public API surface for src/main/gcp/*
// Terraform insights files may import from here; modules in this directory
// must NOT import from terraform insights (one-way dependency).

export {
  GCP_SDK_SCOPES,
  MAX_PAGINATION_PAGES,
  paginationGuard,
  getGcpAuth,
  evictGcpAuthPool,
  classifyGcpError,
  outputIndicatesApiDisabled,
  requestGcp,
  type GcpRequestOptions
} from './client'

// ── Per-service re-exports (replacing the previous `export * from '../gcpSdk'`)
// Each group below corresponds to a module under src/main/gcp/.

// Projects / APIs / service accounts
export {
  listGcpEnabledApis,
  listGcpServiceAccounts,
  getGcpProjectOverview
} from './projects'

// Compute Engine
export {
  listGcpComputeInstances,
  getGcpComputeInstanceDetail,
  listGcpComputeMachineTypes,
  runGcpComputeInstanceAction,
  resizeGcpComputeInstance,
  updateGcpComputeInstanceLabels,
  deleteGcpComputeInstance,
  getGcpComputeSerialOutput
} from './computeEngine'

// VPC / networking
export {
  listGcpFirewallRules,
  listGcpNetworks,
  listGcpSubnetworks,
  listGcpRouters,
  listGcpGlobalAddresses,
  listGcpServiceNetworkingConnections
} from './vpc'

// GKE
export {
  listGcpGkeClusters,
  getGcpGkeClusterDetail,
  listGcpGkeNodePools,
  getGcpGkeClusterCredentials,
  listGcpGkeOperations,
  updateGcpGkeNodePoolScaling
} from './gke'

// Cloud Storage
export {
  listGcpStorageBuckets,
  listGcpStorageObjects,
  getGcpStorageObjectContent,
  putGcpStorageObjectContent,
  uploadGcpStorageObject,
  downloadGcpStorageObjectToPath,
  deleteGcpStorageObject
} from './cloudStorage'

// Cloud SQL
export {
  listGcpSqlInstances,
  listGcpSqlDatabasesForInstances,
  listGcpSqlUsers,
  getGcpSqlInstanceDetail,
  listGcpSqlDatabases,
  listGcpSqlOperations
} from './cloudSql'

// Logging — exports listGcpLogEntries (the gcpSdk variant).  The newer
// paginated variant in ./monitoring is reached via direct import of
// './gcp/monitoring' so it is intentionally not re-exported here to avoid
// colliding on the shared symbol.
export { listGcpLogEntries } from './logging'

// Pub/Sub
export {
  listGcpPubSubTopics,
  listGcpPubSubSubscriptions,
  getGcpPubSubTopicDetail,
  getGcpPubSubSubscriptionDetail
} from './pubSub'

// BigQuery
export {
  listGcpBigQueryDatasetsExported,
  listGcpBigQueryTables,
  getGcpBigQueryTableDetail,
  runGcpBigQueryQuery
} from './bigQuery'

// Security Command Center
export {
  listGcpSccFindings,
  listGcpSccSources,
  getGcpSccFindingDetail,
  getGcpSccSeverityBreakdown,
  getGcpSccPostureReport
} from './scc'

// Firestore
export {
  listGcpFirestoreDatabases,
  listGcpFirestoreCollections,
  listGcpFirestoreDocuments,
  getGcpFirestoreDocumentDetail
} from './firestore'

// Cloud Run
export {
  listGcpCloudRunServices,
  listGcpCloudRunRevisions,
  listGcpCloudRunJobs,
  listGcpCloudRunExecutions,
  listGcpCloudRunDomainMappings
} from './cloudRun'

// Firebase
export {
  getGcpFirebaseProject,
  listGcpFirebaseWebApps,
  listGcpFirebaseAndroidApps,
  listGcpFirebaseIosApps,
  listGcpFirebaseHostingSites,
  listGcpFirebaseHostingReleases,
  listGcpFirebaseHostingDomains,
  listGcpFirebaseHostingChannels
} from './firebase'

// Cloud DNS
export {
  listGcpDnsManagedZones,
  listGcpDnsResourceRecordSets,
  createGcpDnsResourceRecordSet,
  updateGcpDnsResourceRecordSet,
  deleteGcpDnsResourceRecordSet
} from './cloudDns'

// Memorystore
export {
  listGcpMemorystoreInstances,
  getGcpMemorystoreInstanceDetail
} from './memorystore'

// Load Balancer + Cloud Armor
export {
  listGcpUrlMaps,
  getGcpUrlMapDetail,
  listGcpBackendServices,
  listGcpForwardingRules,
  listGcpHealthChecks,
  listGcpSecurityPolicies,
  getGcpSecurityPolicyDetail
} from './loadBalancer'

// ── IAM (existing + gcpSdk-extracted) ───────────────────────────────────────
export {
  // Existing iam.ts surface
  getGcpServiceAccountDetail,
  updateGcpServiceAccount,
  addGcpServiceAccountIamBinding,
  removeGcpServiceAccountIamBinding,
  updateGcpCustomRole,
  undeleteGcpCustomRole,
  listGcpIamAuditEntries,
  generateGcpServiceAccountKeyReport,
  listGcpWorkloadIdentityPools,
  listGcpWorkloadIdentityProviders,
  listGcpIamRecommendations,
  analyzeGcpIamPolicy,
  // Appended from gcpSdk.ts
  getGcpIamOverview,
  addGcpIamBinding,
  removeGcpIamBinding,
  createGcpServiceAccount,
  deleteGcpServiceAccount,
  disableGcpServiceAccount,
  listGcpServiceAccountKeys,
  createGcpServiceAccountKey,
  deleteGcpServiceAccountKey,
  listGcpRoles,
  createGcpCustomRole,
  deleteGcpCustomRole,
  testGcpIamPermissions
} from './iam'

// ── Billing (existing + gcpSdk-extracted) ───────────────────────────────────
export {
  listGcpBillingAccounts,
  getGcpCostTrend,
  getGcpDailyCostTrend,
  getGcpCostByLabel,
  getGcpSkuCostBreakdown,
  listGcpBillingBudgets,
  getGcpCostForecast,
  getGcpCostAnomalies,
  getGcpBillingOverview
} from './billing'

// ── Monitoring (existing + gcpSdk-extracted) ────────────────────────────────
// Note: the paginated `listGcpLogEntries(projectId, filter, orderBy, pageSize,
// pageToken)` variant remains in ./monitoring and is reached via direct import
// of './gcp/monitoring' (not re-exported here to preserve the original gcpSdk
// signature at this barrel's listGcpLogEntries symbol).
export {
  toggleGcpAlertPolicy,
  deleteGcpAlertPolicy,
  createGcpAlertPolicy,
  listGcpNotificationChannels,
  createGcpUptimeCheck,
  deleteGcpUptimeCheck,
  queryGcpAggregatedMetric,
  listGcpMonitoringGroups,
  listGcpMonitoringDashboards,
  getGcpMonitoringDashboard,
  listGcpMonitoringServices,
  listGcpMonitoringSlos,
  listGcpMonitoringAlertPolicies,
  listGcpMonitoringUptimeChecks,
  listGcpMonitoringMetricDescriptors,
  queryGcpMonitoringTimeSeries
} from './monitoring'

export {
  getCredentialAuth,
  getCredentialClient,
  refreshCredentials,
  setImpersonationTarget,
  getImpersonationTarget,
  getCredentialStatus,
  type GcpCredentialStatus
} from './auth'

export {
  GCP_TTL_COMPUTE,
  GCP_TTL_NETWORK,
  GCP_TTL_DATA,
  GCP_TTL_IAM,
  GCP_TTL_BILLING,
  GCP_TTL_MONITOR,
  getOrFetch,
  forceRefresh,
  invalidateKey,
  invalidatePrefix,
  clearAllCache,
  getCacheStats
} from './cache'
