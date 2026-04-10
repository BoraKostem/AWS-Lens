import { contextBridge, ipcRenderer } from 'electron'

import type {
  AwsCapabilitySubject,
  AppDiagnosticsFailureInput,
  AppDiagnosticsSnapshot,
  AppSettings,
  ComparisonBaselineInput,
  ComparisonPresetInput,
  ComparisonRequest,
  AssumeRoleRequest,
  AwsAssumeRoleTarget,
  CloudWatchInvestigationHistoryInput,
  CloudWatchQueryFilter,
  CloudWatchQueryExecutionInput,
  CloudWatchQueryHistoryInput,
  CloudWatchSavedQueryInput,
  CloudProviderId,
  DirectAccessResolution,
  AwsConnection,
  BastionLaunchConfig,
  DbConnectionResolveInput,
  DbConnectionPresetFilter,
  DbConnectionPresetInput,
  DbVaultCredentialInput,
  AzureProviderContextSnapshot,
  AzureVmAction,
  EksUpgradePlannerRequest,
  GcpComputeInstanceAction,
  Ec2BulkInstanceAction,
  Ec2InstanceAction,
  EbsVolumeAttachRequest,
  EbsVolumeDetachRequest,
  EbsVolumeModifyRequest,
  EbsTempInspectionProgress,
  EcsFargateServiceConfig,
  LambdaCreateConfig,
  Route53HostedZoneCreateInput,
  SsmSendCommandRequest,
  SsmStartSessionRequest,
  TerraformAdoptionCodegenResult,
  TerraformAdoptionDetectionResult,
  TerraformAdoptionImportExecutionResult,
  TerraformAdoptionMappingResult,
  TerraformAdoptionTarget,
  TerraformAdoptionValidationResult,
  SnapshotLaunchConfig,
  TerraformInputConfiguration,
  TerraformCommandRequest,
  TerraformInputValidationResult,
  TerraformRunHistoryFilter,
  VaultEntryFilter,
  VaultEntryInput,
  VaultEntryUsageInput
} from '@shared/types'

const terminalListenerMap = new Map<(event: unknown) => void, (...args: unknown[]) => void>()
const tempVolumeProgressListenerMap = new Map<(event: unknown) => void, (...args: unknown[]) => void>()

/* ── AWS Lens bridge ──────────────────────────────────────── */

const awsLensApi = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  deleteProfile: (profileName: string) => ipcRenderer.invoke('profiles:delete', profileName),
  chooseAndImportConfig: () => ipcRenderer.invoke('profiles:choose-and-import'),
  saveCredentials: (profileName: string, accessKeyId: string, secretAccessKey: string) =>
    ipcRenderer.invoke('profiles:save-credentials', profileName, accessKeyId, secretAccessKey),
  listRegions: () => ipcRenderer.invoke('regions:list'),
  getSessionHubState: () => ipcRenderer.invoke('session-hub:list'),
  runComparison: (request: ComparisonRequest) => ipcRenderer.invoke('compare:run', request),
  saveAssumeRoleTarget: (target: Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) =>
    ipcRenderer.invoke('session-hub:target:save', target),
  deleteAssumeRoleTarget: (targetId: string) => ipcRenderer.invoke('session-hub:target:delete', targetId),
  deleteAssumedSession: (sessionId: string) => ipcRenderer.invoke('session-hub:session:delete', sessionId),
  assumeRoleSession: (request: AssumeRoleRequest) => ipcRenderer.invoke('session-hub:assume', request),
  refreshAssumedSession: (sessionId: string) => ipcRenderer.invoke('session-hub:session:refresh', sessionId),
  assumeSavedRoleTarget: (targetId: string) => ipcRenderer.invoke('session-hub:assume-target', targetId),
  getAssumedSessionCredentials: (sessionId: string) => ipcRenderer.invoke('aws:sts:get-session-credentials', sessionId),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  getProviderCliStatus: () => ipcRenderer.invoke('providers:cli-status'),
  getWorkspaceCatalog: (providerId?: CloudProviderId) => ipcRenderer.invoke('workspace-catalog:get', providerId),
  listServices: (providerId?: CloudProviderId) => ipcRenderer.invoke('services:list', providerId),
  getGovernanceTagDefaults: () => ipcRenderer.invoke('phase1:get-governance-tag-defaults'),
  updateGovernanceTagDefaults: (update: unknown) => ipcRenderer.invoke('phase1:update-governance-tag-defaults', update),
  listCloudWatchSavedQueries: (filter?: CloudWatchQueryFilter) => ipcRenderer.invoke('phase1:list-cloudwatch-saved-queries', filter),
  saveCloudWatchSavedQuery: (input: CloudWatchSavedQueryInput) => ipcRenderer.invoke('phase1:save-cloudwatch-saved-query', input),
  deleteCloudWatchSavedQuery: (id: string) => ipcRenderer.invoke('phase1:delete-cloudwatch-saved-query', id),
  listCloudWatchInvestigationHistory: (filter?: CloudWatchQueryFilter) => ipcRenderer.invoke('phase1:list-cloudwatch-investigation-history', filter),
  recordCloudWatchInvestigationHistory: (input: CloudWatchInvestigationHistoryInput) => ipcRenderer.invoke('phase1:record-cloudwatch-investigation-history', input),
  clearCloudWatchInvestigationHistory: (filter?: CloudWatchQueryFilter) => ipcRenderer.invoke('phase1:clear-cloudwatch-investigation-history', filter),
  listCloudWatchQueryHistory: (filter?: CloudWatchQueryFilter) => ipcRenderer.invoke('phase1:list-cloudwatch-query-history', filter),
  recordCloudWatchQueryHistory: (input: CloudWatchQueryHistoryInput) => ipcRenderer.invoke('phase1:record-cloudwatch-query-history', input),
  clearCloudWatchQueryHistory: (filter?: CloudWatchQueryFilter) => ipcRenderer.invoke('phase1:clear-cloudwatch-query-history', filter),
  listDbConnectionPresets: (filter?: DbConnectionPresetFilter) => ipcRenderer.invoke('phase1:list-db-connection-presets', filter),
  saveDbConnectionPreset: (input: DbConnectionPresetInput) => ipcRenderer.invoke('phase1:save-db-connection-preset', input),
  deleteDbConnectionPreset: (id: string) => ipcRenderer.invoke('phase1:delete-db-connection-preset', id),
  markDbConnectionPresetUsed: (id: string) => ipcRenderer.invoke('phase1:mark-db-connection-preset-used', id),
  listDbVaultCredentials: () => ipcRenderer.invoke('phase1:list-db-vault-credentials'),
  saveDbVaultCredential: (input: DbVaultCredentialInput) => ipcRenderer.invoke('phase1:save-db-vault-credential', input),
  deleteDbVaultCredential: (name: string) => ipcRenderer.invoke('phase1:delete-db-vault-credential', name),
  resolveDbConnectionMaterial: (connection: AwsConnection, input: DbConnectionResolveInput) =>
    ipcRenderer.invoke('phase1:resolve-db-connection-material', connection, input),
  getAwsCapabilitySnapshot: (region: string, subjects?: AwsCapabilitySubject[]) => ipcRenderer.invoke('phase1:get-aws-capability-snapshot', region, subjects),
  listVaultEntries: (filter?: VaultEntryFilter) => ipcRenderer.invoke('phase2:list-vault-entries', filter),
  saveVaultEntry: (input: VaultEntryInput) => ipcRenderer.invoke('phase2:save-vault-entry', input),
  deleteVaultEntry: (entryId: string) => ipcRenderer.invoke('phase2:delete-vault-entry', entryId),
  revealVaultEntrySecret: (entryId: string) => ipcRenderer.invoke('phase2:reveal-vault-entry-secret', entryId),
  recordVaultEntryUse: (input: VaultEntryUsageInput) => ipcRenderer.invoke('phase2:record-vault-entry-use', input),
  listComparisonBaselines: () => ipcRenderer.invoke('phase2:list-comparison-baselines'),
  listComparisonPresets: () => ipcRenderer.invoke('phase2:list-comparison-presets'),
  getComparisonBaseline: (baselineId: string) => ipcRenderer.invoke('phase2:get-comparison-baseline', baselineId),
  getComparisonPreset: (presetId: string) => ipcRenderer.invoke('phase2:get-comparison-preset', presetId),
  saveComparisonBaseline: (input: ComparisonBaselineInput) => ipcRenderer.invoke('phase2:save-comparison-baseline', input),
  saveComparisonPreset: (input: ComparisonPresetInput) => ipcRenderer.invoke('phase2:save-comparison-preset', input),
  deleteComparisonBaseline: (baselineId: string) => ipcRenderer.invoke('phase2:delete-comparison-baseline', baselineId),
  deleteComparisonPreset: (presetId: string) => ipcRenderer.invoke('phase2:delete-comparison-preset', presetId),
  buildEksUpgradePlan: (connection: AwsConnection, request: EksUpgradePlannerRequest) =>
    ipcRenderer.invoke('phase2:build-eks-upgrade-plan', connection, request),
  resolveDirectAccessInput: (input: string): Promise<DirectAccessResolution> =>
    ipcRenderer.invoke('phase2:resolve-direct-access-input', input),
  getReleaseInfo: () => ipcRenderer.invoke('app:release-info'),
  getAppSettings: () => ipcRenderer.invoke('app:settings:get'),
  updateAppSettings: (update: Partial<AppSettings>) => ipcRenderer.invoke('app:settings:update', update),
  resetAppSettings: () => ipcRenderer.invoke('app:settings:reset'),
  getAppSecuritySummary: () => ipcRenderer.invoke('app:security-summary'),
  getEnvironmentHealth: () => ipcRenderer.invoke('app:environment-health'),
  getAzureProviderContext: (): Promise<AzureProviderContextSnapshot> => ipcRenderer.invoke('azure:context:get'),
  startAzureDeviceCodeSignIn: (): Promise<AzureProviderContextSnapshot> => ipcRenderer.invoke('azure:context:start-device-code-sign-in'),
  signOutAzureProvider: (): Promise<AzureProviderContextSnapshot> => ipcRenderer.invoke('azure:context:sign-out'),
  setAzureActiveTenant: (tenantId: string): Promise<AzureProviderContextSnapshot> => ipcRenderer.invoke('azure:context:set-tenant', tenantId),
  setAzureActiveSubscription: (subscriptionId: string): Promise<AzureProviderContextSnapshot> => ipcRenderer.invoke('azure:context:set-subscription', subscriptionId),
  setAzureActiveLocation: (location: string): Promise<AzureProviderContextSnapshot> => ipcRenderer.invoke('azure:context:set-location', location),
  getGcpCliContext: () => ipcRenderer.invoke('gcp:cli-context'),
  listGcpProjects: () => ipcRenderer.invoke('gcp:projects'),
  getGcpProjectOverview: (projectId: string) => ipcRenderer.invoke('gcp:projects:get-overview', projectId),
  getGcpIamOverview: (projectId: string) => ipcRenderer.invoke('gcp:iam:get-overview', projectId),
  addGcpIamBinding: (projectId: string, role: string, member: string) => ipcRenderer.invoke('gcp:iam:add-binding', projectId, role, member),
  removeGcpIamBinding: (projectId: string, role: string, member: string) => ipcRenderer.invoke('gcp:iam:remove-binding', projectId, role, member),
  createGcpServiceAccount: (projectId: string, accountId: string, displayName: string, description: string) => ipcRenderer.invoke('gcp:iam:create-service-account', projectId, accountId, displayName, description),
  deleteGcpServiceAccount: (projectId: string, email: string) => ipcRenderer.invoke('gcp:iam:delete-service-account', projectId, email),
  disableGcpServiceAccount: (projectId: string, email: string, disable: boolean) => ipcRenderer.invoke('gcp:iam:disable-service-account', projectId, email, disable),
  listGcpServiceAccountKeys: (projectId: string, email: string) => ipcRenderer.invoke('gcp:iam:list-service-account-keys', projectId, email),
  createGcpServiceAccountKey: (projectId: string, email: string) => ipcRenderer.invoke('gcp:iam:create-service-account-key', projectId, email),
  deleteGcpServiceAccountKey: (projectId: string, email: string, keyId: string) => ipcRenderer.invoke('gcp:iam:delete-service-account-key', projectId, email, keyId),
  listGcpRoles: (projectId: string, scope: 'custom' | 'all') => ipcRenderer.invoke('gcp:iam:list-roles', projectId, scope),
  createGcpCustomRole: (projectId: string, roleId: string, title: string, description: string, permissions: string[]) => ipcRenderer.invoke('gcp:iam:create-custom-role', projectId, roleId, title, description, permissions),
  deleteGcpCustomRole: (projectId: string, roleName: string) => ipcRenderer.invoke('gcp:iam:delete-custom-role', projectId, roleName),
  testGcpIamPermissions: (projectId: string, permissions: string[]) => ipcRenderer.invoke('gcp:iam:test-permissions', projectId, permissions),
  listGcpComputeInstances: (projectId: string, location: string) => ipcRenderer.invoke('gcp:compute-engine:list', projectId, location),
  getGcpComputeInstanceDetail: (projectId: string, zone: string, instanceName: string) =>
    ipcRenderer.invoke('gcp:compute-engine:get-detail', projectId, zone, instanceName),
  listGcpComputeMachineTypes: (projectId: string, zone: string) =>
    ipcRenderer.invoke('gcp:compute-engine:list-machine-types', projectId, zone),
  runGcpComputeInstanceAction: (projectId: string, zone: string, instanceName: string, action: GcpComputeInstanceAction) =>
    ipcRenderer.invoke('gcp:compute-engine:action', projectId, zone, instanceName, action),
  resizeGcpComputeInstance: (projectId: string, zone: string, instanceName: string, machineType: string) =>
    ipcRenderer.invoke('gcp:compute-engine:resize', projectId, zone, instanceName, machineType),
  updateGcpComputeInstanceLabels: (projectId: string, zone: string, instanceName: string, labels: Record<string, string>) =>
    ipcRenderer.invoke('gcp:compute-engine:update-labels', projectId, zone, instanceName, labels),
  deleteGcpComputeInstance: (projectId: string, zone: string, instanceName: string) =>
    ipcRenderer.invoke('gcp:compute-engine:delete', projectId, zone, instanceName),
  getGcpComputeSerialOutput: (projectId: string, zone: string, instanceName: string, port?: number, start?: number) =>
    ipcRenderer.invoke('gcp:compute-engine:get-serial-output', projectId, zone, instanceName, port, start),
  listGcpNetworks: (projectId: string) => ipcRenderer.invoke('gcp:vpc:list-networks', projectId),
  listGcpSubnetworks: (projectId: string, location: string) => ipcRenderer.invoke('gcp:vpc:list-subnetworks', projectId, location),
  listGcpFirewallRules: (projectId: string) => ipcRenderer.invoke('gcp:vpc:list-firewall-rules', projectId),
  listGcpRouters: (projectId: string, location: string) => ipcRenderer.invoke('gcp:vpc:list-routers', projectId, location),
  listGcpGlobalAddresses: (projectId: string) => ipcRenderer.invoke('gcp:vpc:list-global-addresses', projectId),
  listGcpServiceNetworkingConnections: (projectId: string, networkNames: string[]) =>
    ipcRenderer.invoke('gcp:vpc:list-service-networking-connections', projectId, networkNames),

  /* ── Cloud DNS ── */
  listGcpDnsManagedZones: (projectId: string) =>
    ipcRenderer.invoke('gcp:cloud-dns:list-zones', projectId),
  listGcpDnsResourceRecordSets: (projectId: string, managedZone: string) =>
    ipcRenderer.invoke('gcp:cloud-dns:list-records', projectId, managedZone),
  createGcpDnsResourceRecordSet: (projectId: string, managedZone: string, input: unknown) =>
    ipcRenderer.invoke('gcp:cloud-dns:create-record', projectId, managedZone, input),
  updateGcpDnsResourceRecordSet: (projectId: string, managedZone: string, input: unknown) =>
    ipcRenderer.invoke('gcp:cloud-dns:update-record', projectId, managedZone, input),
  deleteGcpDnsResourceRecordSet: (projectId: string, managedZone: string, name: string, type: string) =>
    ipcRenderer.invoke('gcp:cloud-dns:delete-record', projectId, managedZone, name, type),

  // Memorystore (Redis)
  listGcpMemorystoreInstances: (projectId: string, location: string) =>
    ipcRenderer.invoke('gcp:memorystore:list-instances', projectId, location),
  getGcpMemorystoreInstanceDetail: (projectId: string, instanceName: string) =>
    ipcRenderer.invoke('gcp:memorystore:get-instance-detail', projectId, instanceName),

  // Load Balancer + Cloud Armor
  listGcpUrlMaps: (projectId: string) =>
    ipcRenderer.invoke('gcp:load-balancer:list-url-maps', projectId),
  getGcpUrlMapDetail: (projectId: string, urlMapName: string, region?: string) =>
    ipcRenderer.invoke('gcp:load-balancer:get-url-map-detail', projectId, urlMapName, region),
  listGcpBackendServices: (projectId: string) =>
    ipcRenderer.invoke('gcp:load-balancer:list-backend-services', projectId),
  listGcpForwardingRules: (projectId: string) =>
    ipcRenderer.invoke('gcp:load-balancer:list-forwarding-rules', projectId),
  listGcpHealthChecks: (projectId: string) =>
    ipcRenderer.invoke('gcp:load-balancer:list-health-checks', projectId),
  listGcpSecurityPolicies: (projectId: string) =>
    ipcRenderer.invoke('gcp:cloud-armor:list-security-policies', projectId),
  getGcpSecurityPolicyDetail: (projectId: string, policyName: string) =>
    ipcRenderer.invoke('gcp:cloud-armor:get-security-policy-detail', projectId, policyName),

  listGcpGkeClusters: (projectId: string, location: string) => ipcRenderer.invoke('gcp:gke:list', projectId, location),
  getGcpGkeClusterDetail: (projectId: string, location: string, clusterName: string) => ipcRenderer.invoke('gcp:gke:get-detail', projectId, location, clusterName),
  listGcpGkeNodePools: (projectId: string, location: string, clusterName: string) => ipcRenderer.invoke('gcp:gke:list-node-pools', projectId, location, clusterName),
  getGcpGkeClusterCredentials: (projectId: string, location: string, clusterName: string, contextName?: string, kubeconfigPath?: string) =>
    ipcRenderer.invoke('gcp:gke:get-credentials', projectId, location, clusterName, contextName, kubeconfigPath),
  listGcpGkeOperations: (projectId: string, location: string, clusterName: string) => ipcRenderer.invoke('gcp:gke:list-operations', projectId, location, clusterName),
  updateGcpGkeNodePoolScaling: (projectId: string, location: string, clusterName: string, nodePoolName: string, minimum: number, desired: number, maximum: number) =>
    ipcRenderer.invoke('gcp:gke:update-node-pool-scaling', projectId, location, clusterName, nodePoolName, minimum, desired, maximum),
  listGcpStorageBuckets: (projectId: string, location: string) => ipcRenderer.invoke('gcp:cloud-storage:list', projectId, location),
  listGcpStorageObjects: (projectId: string, bucketName: string, prefix: string) => ipcRenderer.invoke('gcp:cloud-storage:objects:list', projectId, bucketName, prefix),
  getGcpStorageObjectContent: (projectId: string, bucketName: string, key: string) => ipcRenderer.invoke('gcp:cloud-storage:object:get-content', projectId, bucketName, key),
  putGcpStorageObjectContent: (projectId: string, bucketName: string, key: string, content: string) => ipcRenderer.invoke('gcp:cloud-storage:object:put-content', projectId, bucketName, key, content),
  uploadGcpStorageObject: (projectId: string, bucketName: string, key: string, localPath: string) => ipcRenderer.invoke('gcp:cloud-storage:object:upload', projectId, bucketName, key, localPath),
  downloadGcpStorageObjectToPath: (projectId: string, bucketName: string, key: string) => ipcRenderer.invoke('gcp:cloud-storage:object:download', projectId, bucketName, key),
  deleteGcpStorageObject: (projectId: string, bucketName: string, key: string) => ipcRenderer.invoke('gcp:cloud-storage:object:delete', projectId, bucketName, key),
  listGcpLogEntries: (projectId: string, location: string, query: string, windowHours?: number) => ipcRenderer.invoke('gcp:logging:list', projectId, location, query, windowHours),
  listGcpSqlInstances: (projectId: string, location: string) => ipcRenderer.invoke('gcp:cloud-sql:list', projectId, location),
  getGcpSqlInstanceDetail: (projectId: string, instanceName: string) => ipcRenderer.invoke('gcp:cloud-sql:get-detail', projectId, instanceName),
  listGcpSqlDatabases: (projectId: string, instanceName: string) => ipcRenderer.invoke('gcp:cloud-sql:databases:list', projectId, instanceName),
  listGcpSqlOperations: (projectId: string, instanceName: string) => ipcRenderer.invoke('gcp:cloud-sql:operations:list', projectId, instanceName),
  getGcpBillingOverview: (projectId: string, catalogProjectIds: string[]) => ipcRenderer.invoke('gcp:billing:get-overview', projectId, catalogProjectIds),

  // Pub/Sub
  listGcpPubSubTopics: (projectId: string) => ipcRenderer.invoke('gcp:pubsub:list-topics', projectId),
  listGcpPubSubSubscriptions: (projectId: string) => ipcRenderer.invoke('gcp:pubsub:list-subscriptions', projectId),
  getGcpPubSubTopicDetail: (projectId: string, topicId: string) => ipcRenderer.invoke('gcp:pubsub:get-topic-detail', projectId, topicId),
  getGcpPubSubSubscriptionDetail: (projectId: string, subscriptionId: string) => ipcRenderer.invoke('gcp:pubsub:get-subscription-detail', projectId, subscriptionId),

  // BigQuery
  listGcpBigQueryDatasets: (projectId: string) => ipcRenderer.invoke('gcp:bigquery:list-datasets', projectId),
  listGcpBigQueryTables: (projectId: string, datasetId: string) => ipcRenderer.invoke('gcp:bigquery:list-tables', projectId, datasetId),
  getGcpBigQueryTableDetail: (projectId: string, datasetId: string, tableId: string) => ipcRenderer.invoke('gcp:bigquery:get-table-detail', projectId, datasetId, tableId),
  runGcpBigQueryQuery: (projectId: string, queryText: string, maxResults?: number) => ipcRenderer.invoke('gcp:bigquery:run-query', projectId, queryText, maxResults),

  // Cloud Monitoring
  listGcpMonitoringAlertPolicies: (projectId: string) => ipcRenderer.invoke('gcp:monitoring:list-alert-policies', projectId),
  listGcpMonitoringUptimeChecks: (projectId: string) => ipcRenderer.invoke('gcp:monitoring:list-uptime-checks', projectId),
  listGcpMonitoringMetricDescriptors: (projectId: string, filter?: string) => ipcRenderer.invoke('gcp:monitoring:list-metric-descriptors', projectId, filter),
  queryGcpMonitoringTimeSeries: (projectId: string, metricType: string, intervalMinutes: number) => ipcRenderer.invoke('gcp:monitoring:query-time-series', projectId, metricType, intervalMinutes),

  // Security Command Center
  listGcpSccFindings: (projectId: string, location?: string, filter?: string) => ipcRenderer.invoke('gcp:scc:list-findings', projectId, location, filter),
  listGcpSccSources: (projectId: string, location?: string) => ipcRenderer.invoke('gcp:scc:list-sources', projectId, location),
  getGcpSccFindingDetail: (projectId: string, findingName: string, location?: string) => ipcRenderer.invoke('gcp:scc:get-finding-detail', projectId, findingName, location),
  getGcpSccSeverityBreakdown: (projectId: string, location?: string) => ipcRenderer.invoke('gcp:scc:get-severity-breakdown', projectId, location),

  // Firestore
  listGcpFirestoreDatabases: (projectId: string) => ipcRenderer.invoke('gcp:firestore:list-databases', projectId),
  listGcpFirestoreCollections: (projectId: string, databaseId: string, parentDocumentPath?: string) => ipcRenderer.invoke('gcp:firestore:list-collections', projectId, databaseId, parentDocumentPath),
  listGcpFirestoreDocuments: (projectId: string, databaseId: string, collectionId: string, pageSize?: number) => ipcRenderer.invoke('gcp:firestore:list-documents', projectId, databaseId, collectionId, pageSize),
  getGcpFirestoreDocumentDetail: (projectId: string, databaseId: string, documentPath: string) => ipcRenderer.invoke('gcp:firestore:get-document-detail', projectId, databaseId, documentPath),

  // ── Cloud Run ──
  listGcpCloudRunServices: (projectId: string, location: string) => ipcRenderer.invoke('gcp:cloud-run:list-services', projectId, location),
  listGcpCloudRunRevisions: (projectId: string, location: string, serviceId: string) => ipcRenderer.invoke('gcp:cloud-run:list-revisions', projectId, location, serviceId),
  listGcpCloudRunJobs: (projectId: string, location: string) => ipcRenderer.invoke('gcp:cloud-run:list-jobs', projectId, location),
  listGcpCloudRunExecutions: (projectId: string, location: string, jobId: string) => ipcRenderer.invoke('gcp:cloud-run:list-executions', projectId, location, jobId),
  listGcpCloudRunDomainMappings: (projectId: string, location: string) => ipcRenderer.invoke('gcp:cloud-run:list-domain-mappings', projectId, location),

  // ── Firebase ──
  getGcpFirebaseProject: (projectId: string) => ipcRenderer.invoke('gcp:firebase:get-project', projectId),
  listGcpFirebaseWebApps: (projectId: string) => ipcRenderer.invoke('gcp:firebase:list-web-apps', projectId),
  listGcpFirebaseAndroidApps: (projectId: string) => ipcRenderer.invoke('gcp:firebase:list-android-apps', projectId),
  listGcpFirebaseIosApps: (projectId: string) => ipcRenderer.invoke('gcp:firebase:list-ios-apps', projectId),
  listGcpFirebaseHostingSites: (projectId: string) => ipcRenderer.invoke('gcp:firebase:list-hosting-sites', projectId),
  listGcpFirebaseHostingReleases: (projectId: string, siteId: string) => ipcRenderer.invoke('gcp:firebase:list-hosting-releases', projectId, siteId),
  listGcpFirebaseHostingDomains: (projectId: string, siteId: string) => ipcRenderer.invoke('gcp:firebase:list-hosting-domains', projectId, siteId),
  listGcpFirebaseHostingChannels: (projectId: string, siteId: string) => ipcRenderer.invoke('gcp:firebase:list-hosting-channels', projectId, siteId),

  listAzureSubscriptions: () => ipcRenderer.invoke('azure:subscriptions:list'),
  getAzureRbacOverview: (subscriptionId: string) => ipcRenderer.invoke('azure:rbac:get-overview', subscriptionId),
  listAzureRoleAssignments: (subscriptionId: string) => ipcRenderer.invoke('azure:rbac:list-assignments', subscriptionId),
  listAzureRoleDefinitions: (subscriptionId: string) => ipcRenderer.invoke('azure:rbac:list-role-definitions', subscriptionId),
  createAzureRoleAssignment: (subscriptionId: string, principalId: string, roleDefinitionId: string, scope: string) =>
    ipcRenderer.invoke('azure:rbac:create-assignment', subscriptionId, principalId, roleDefinitionId, scope),
  deleteAzureRoleAssignment: (assignmentId: string) => ipcRenderer.invoke('azure:rbac:delete-assignment', assignmentId),
  listAzureVirtualMachines: (subscriptionId: string, location: string) => ipcRenderer.invoke('azure:virtual-machines:list', subscriptionId, location),
  describeAzureVirtualMachine: (subscriptionId: string, resourceGroup: string, vmName: string) =>
    ipcRenderer.invoke('azure:virtual-machines:describe', subscriptionId, resourceGroup, vmName),
  runAzureVmAction: (subscriptionId: string, resourceGroup: string, vmName: string, action: AzureVmAction) =>
    ipcRenderer.invoke('azure:virtual-machines:action', subscriptionId, resourceGroup, vmName, action),
  listAzureAksClusters: (subscriptionId: string, location: string) => ipcRenderer.invoke('azure:aks:list', subscriptionId, location),
  describeAzureAksCluster: (subscriptionId: string, resourceGroup: string, clusterName: string) =>
    ipcRenderer.invoke('azure:aks:describe', subscriptionId, resourceGroup, clusterName),
  listAzureAksNodePools: (subscriptionId: string, resourceGroup: string, clusterName: string) =>
    ipcRenderer.invoke('azure:aks:list-node-pools', subscriptionId, resourceGroup, clusterName),
  updateAzureAksNodePoolScaling: (subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, min: number, desired: number, max: number) =>
    ipcRenderer.invoke('azure:aks:update-node-pool-scaling', subscriptionId, resourceGroup, clusterName, nodePoolName, min, desired, max),
  toggleAzureAksNodePoolAutoscaling: (subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, enable: boolean, minCount?: number, maxCount?: number) =>
    ipcRenderer.invoke('azure:aks:toggle-node-pool-autoscaling', subscriptionId, resourceGroup, clusterName, nodePoolName, enable, minCount, maxCount),
  addAksToKubeconfig: (subscriptionId: string, resourceGroup: string, clusterName: string, contextName: string, kubeconfigPath: string) =>
    ipcRenderer.invoke('azure:aks:add-kubeconfig', subscriptionId, resourceGroup, clusterName, contextName, kubeconfigPath),
  chooseAksKubeconfigPath: (currentPath?: string) =>
    ipcRenderer.invoke('azure:aks:choose-kubeconfig-path', currentPath),
  listAzureStorageAccounts: (subscriptionId: string, location: string) => ipcRenderer.invoke('azure:storage-accounts:list', subscriptionId, location),
  listAzureStorageContainers: (subscriptionId: string, resourceGroup: string, accountName: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-containers:list', subscriptionId, resourceGroup, accountName, blobEndpoint),
  listAzureStorageBlobs: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, prefix: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blobs:list', subscriptionId, resourceGroup, accountName, containerName, prefix, blobEndpoint),
  getAzureStorageBlobContent: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:get-content', subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint),
  putAzureStorageBlobContent: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, content: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:put-content', subscriptionId, resourceGroup, accountName, containerName, key, content, blobEndpoint),
  uploadAzureStorageBlob: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, localPath: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:upload', subscriptionId, resourceGroup, accountName, containerName, key, localPath, blobEndpoint),
  downloadAzureStorageBlobToPath: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:download', subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint),
  deleteAzureStorageBlob: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:delete', subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint),
  createAzureStorageContainer: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-container:create', subscriptionId, resourceGroup, accountName, containerName, blobEndpoint),
  openAzureStorageBlob: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:open', subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint),
  openAzureStorageBlobInVSCode: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:open-in-vscode', subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint),
  getAzureStorageBlobSasUrl: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) =>
    ipcRenderer.invoke('azure:storage-blob:sas-url', subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint),
  getAzureSqlEstate: (subscriptionId: string, location: string) => ipcRenderer.invoke('azure:sql:get-estate', subscriptionId, location),
  describeAzureSqlServer: (subscriptionId: string, resourceGroup: string, serverName: string) => ipcRenderer.invoke('azure:sql:describe-server', subscriptionId, resourceGroup, serverName),
  getAzurePostgreSqlEstate: (subscriptionId: string, location: string) => ipcRenderer.invoke('azure:postgresql:get-estate', subscriptionId, location),
  describeAzurePostgreSqlServer: (subscriptionId: string, resourceGroup: string, serverName: string) => ipcRenderer.invoke('azure:postgresql:describe-server', subscriptionId, resourceGroup, serverName),
  listAzureMonitorActivity: (subscriptionId: string, location: string, query: string, windowHours?: number) =>
    ipcRenderer.invoke('azure:monitor:list-activity', subscriptionId, location, query, windowHours),
  getAzureCostOverview: (subscriptionId: string) => ipcRenderer.invoke('azure:cost:get-overview', subscriptionId),
  getAzureNetworkOverview: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:network:get-overview', subscriptionId, location),
  listAzureVNetSubnets: (subscriptionId: string, resourceGroup: string, vnetName: string) =>
    ipcRenderer.invoke('azure:network:list-subnets', subscriptionId, resourceGroup, vnetName),
  listAzureNsgRules: (subscriptionId: string, resourceGroup: string, nsgName: string) =>
    ipcRenderer.invoke('azure:network:list-nsg-rules', subscriptionId, resourceGroup, nsgName),
  listAzureVmss: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:vmss:list', subscriptionId, location),
  listAzureVmssInstances: (subscriptionId: string, resourceGroup: string, vmssName: string) =>
    ipcRenderer.invoke('azure:vmss:list-instances', subscriptionId, resourceGroup, vmssName),
  updateAzureVmssCapacity: (subscriptionId: string, resourceGroup: string, vmssName: string, capacity: number) =>
    ipcRenderer.invoke('azure:vmss:update-capacity', subscriptionId, resourceGroup, vmssName, capacity),
  runAzureVmssInstanceAction: (subscriptionId: string, resourceGroup: string, vmssName: string, instanceId: string, action: string) =>
    ipcRenderer.invoke('azure:vmss:instance-action', subscriptionId, resourceGroup, vmssName, instanceId, action),
  /* ── Application Insights ── */
  listAzureAppInsightsComponents: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:app-insights:list', subscriptionId, location),

  /* ── Key Vault ── */
  listAzureKeyVaults: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:key-vault:list', subscriptionId, location),
  describeAzureKeyVault: (subscriptionId: string, resourceGroup: string, vaultName: string) =>
    ipcRenderer.invoke('azure:key-vault:describe', subscriptionId, resourceGroup, vaultName),
  listAzureKeyVaultSecrets: (subscriptionId: string, resourceGroup: string, vaultName: string) =>
    ipcRenderer.invoke('azure:key-vault:list-secrets', subscriptionId, resourceGroup, vaultName),
  listAzureKeyVaultKeys: (subscriptionId: string, resourceGroup: string, vaultName: string) =>
    ipcRenderer.invoke('azure:key-vault:list-keys', subscriptionId, resourceGroup, vaultName),

  /* ── Event Hub ── */
  listAzureEventHubNamespaces: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:event-hub:list-namespaces', subscriptionId, location),
  listAzureEventHubs: (subscriptionId: string, resourceGroup: string, namespaceName: string) =>
    ipcRenderer.invoke('azure:event-hub:list-hubs', subscriptionId, resourceGroup, namespaceName),
  listAzureEventHubConsumerGroups: (subscriptionId: string, resourceGroup: string, namespaceName: string, eventHubName: string) =>
    ipcRenderer.invoke('azure:event-hub:list-consumer-groups', subscriptionId, resourceGroup, namespaceName, eventHubName),

  /* ── App Service ── */
  listAzureAppServicePlans: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:app-service:list-plans', subscriptionId, location),
  listAzureWebApps: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:app-service:list-web-apps', subscriptionId, location),
  describeAzureWebApp: (subscriptionId: string, resourceGroup: string, siteName: string) =>
    ipcRenderer.invoke('azure:app-service:describe-web-app', subscriptionId, resourceGroup, siteName),
  listAzureWebAppSlots: (subscriptionId: string, resourceGroup: string, siteName: string) =>
    ipcRenderer.invoke('azure:app-service:list-slots', subscriptionId, resourceGroup, siteName),
  listAzureWebAppDeployments: (subscriptionId: string, resourceGroup: string, siteName: string) =>
    ipcRenderer.invoke('azure:app-service:list-deployments', subscriptionId, resourceGroup, siteName),

  /* ── Managed Disks ── */
  listAzureManagedDisks: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:disks:list', subscriptionId, location),
  listAzureDiskSnapshots: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:disk-snapshots:list', subscriptionId, location),

  /* ── Network Enrichment ── */
  listAzureVNetPeerings: (subscriptionId: string, resourceGroup: string, vnetName: string) =>
    ipcRenderer.invoke('azure:network:list-peerings', subscriptionId, resourceGroup, vnetName),
  listAzureRouteTables: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:network:list-route-tables', subscriptionId, location),
  listAzureNatGateways: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:network:list-nat-gateways', subscriptionId, location),
  listAzureLoadBalancers: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:network:list-load-balancers', subscriptionId, location),
  listAzurePrivateEndpoints: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:network:list-private-endpoints', subscriptionId, location),

  /* ── Azure DNS ── */
  listAzureDnsZones: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:dns:list-zones', subscriptionId, location),
  listAzureDnsRecordSets: (subscriptionId: string, resourceGroup: string, zoneName: string) =>
    ipcRenderer.invoke('azure:dns:list-records', subscriptionId, resourceGroup, zoneName),
  upsertAzureDnsRecord: (subscriptionId: string, resourceGroup: string, zoneName: string, input: unknown) =>
    ipcRenderer.invoke('azure:dns:upsert-record', subscriptionId, resourceGroup, zoneName, input),
  deleteAzureDnsRecord: (subscriptionId: string, resourceGroup: string, zoneName: string, recordType: string, recordName: string) =>
    ipcRenderer.invoke('azure:dns:delete-record', subscriptionId, resourceGroup, zoneName, recordType, recordName),
  createAzureDnsZone: (subscriptionId: string, resourceGroup: string, zoneName: string, zoneType: string) =>
    ipcRenderer.invoke('azure:dns:create-zone', subscriptionId, resourceGroup, zoneName, zoneType),

  /* ── Storage Enrichment ── */
  listAzureStorageFileShares: (subscriptionId: string, resourceGroup: string, accountName: string) =>
    ipcRenderer.invoke('azure:storage-file-shares:list', subscriptionId, resourceGroup, accountName),
  listAzureStorageQueues: (subscriptionId: string, resourceGroup: string, accountName: string) =>
    ipcRenderer.invoke('azure:storage-queues:list', subscriptionId, resourceGroup, accountName),
  listAzureStorageTables: (subscriptionId: string, resourceGroup: string, accountName: string) =>
    ipcRenderer.invoke('azure:storage-tables:list', subscriptionId, resourceGroup, accountName),

  /* ── MySQL ── */
  getAzureMySqlEstate: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:mysql:get-estate', subscriptionId, location),
  describeAzureMySqlServer: (subscriptionId: string, resourceGroup: string, serverName: string) =>
    ipcRenderer.invoke('azure:mysql:describe-server', subscriptionId, resourceGroup, serverName),

  /* ── Cosmos DB ── */
  getAzureCosmosDbEstate: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:cosmos-db:get-estate', subscriptionId, location),
  describeAzureCosmosDbAccount: (subscriptionId: string, resourceGroup: string, accountName: string) =>
    ipcRenderer.invoke('azure:cosmos-db:describe-account', subscriptionId, resourceGroup, accountName),

  /* ── App Service / Functions Enrichment ── */
  listAzureFunctionApps: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:app-service:list-function-apps', subscriptionId, location),
  listAzureFunctions: (subscriptionId: string, resourceGroup: string, siteName: string) =>
    ipcRenderer.invoke('azure:app-service:list-functions', subscriptionId, resourceGroup, siteName),
  getAzureWebAppConfiguration: (subscriptionId: string, resourceGroup: string, siteName: string) =>
    ipcRenderer.invoke('azure:app-service:get-config', subscriptionId, resourceGroup, siteName),
  runAzureWebAppAction: (subscriptionId: string, resourceGroup: string, siteName: string, action: string) =>
    ipcRenderer.invoke('azure:app-service:action', subscriptionId, resourceGroup, siteName, action),

  /* ── Log Analytics ── */
  listAzureLogAnalyticsWorkspaces: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:log-analytics:list', subscriptionId, location),
  queryAzureLogAnalytics: (workspaceId: string, query: string, timespan?: string) =>
    ipcRenderer.invoke('azure:log-analytics:query', workspaceId, query, timespan),
  listAzureLogAnalyticsSavedSearches: (subscriptionId: string, resourceGroup: string, workspaceName: string) =>
    ipcRenderer.invoke('azure:log-analytics:list-saved-searches', subscriptionId, resourceGroup, workspaceName),
  listAzureLogAnalyticsLinkedServices: (subscriptionId: string, resourceGroup: string, workspaceName: string) =>
    ipcRenderer.invoke('azure:log-analytics:list-linked-services', subscriptionId, resourceGroup, workspaceName),

  /* ── Event Grid ── */
  listAzureEventGridTopics: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:event-grid:list-topics', subscriptionId, location),
  listAzureEventGridSystemTopics: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:event-grid:list-system-topics', subscriptionId, location),
  listAzureEventGridEventSubscriptions: (subscriptionId: string) =>
    ipcRenderer.invoke('azure:event-grid:list-event-subscriptions', subscriptionId),
  listAzureEventGridDomains: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:event-grid:list-domains', subscriptionId, location),
  listAzureEventGridDomainTopics: (subscriptionId: string, resourceGroup: string, domainName: string) =>
    ipcRenderer.invoke('azure:event-grid:list-domain-topics', subscriptionId, resourceGroup, domainName),

  /* ── Azure Firewall ── */
  listAzureFirewalls: (subscriptionId: string, location: string) =>
    ipcRenderer.invoke('azure:firewall:list', subscriptionId, location),
  describeAzureFirewall: (subscriptionId: string, resourceGroup: string, firewallName: string) =>
    ipcRenderer.invoke('azure:firewall:describe', subscriptionId, resourceGroup, firewallName),

  /* ── Azure Load Balancers (detail) ── */
  describeAzureLoadBalancer: (subscriptionId: string, resourceGroup: string, lbName: string) =>
    ipcRenderer.invoke('azure:load-balancers:describe', subscriptionId, resourceGroup, lbName),

  checkForAppUpdates: () => ipcRenderer.invoke('app:update:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('app:update:download'),
  installAppUpdate: () => ipcRenderer.invoke('app:update:install'),
  setAppDiagnosticsActiveContext: (snapshot: AppDiagnosticsSnapshot) =>
    ipcRenderer.invoke('app:diagnostics:set-active-context', snapshot),
  recordAppDiagnosticsFailure: (input: AppDiagnosticsFailureInput) =>
    ipcRenderer.invoke('app:diagnostics:record-failure', input),
  exportDiagnosticsBundle: (snapshot?: AppDiagnosticsSnapshot) => ipcRenderer.invoke('app:export-diagnostics', snapshot),
  getCallerIdentity: (connection: AwsConnection) => ipcRenderer.invoke('sts:get-caller-identity', connection),
  listEc2Instances: (connection: AwsConnection) => ipcRenderer.invoke('ec2:list', connection),
  listEbsVolumes: (connection: AwsConnection) => ipcRenderer.invoke('ec2:list-volumes', connection),
  describeEc2Instance: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('ec2:describe', connection, instanceId),
  describeEbsVolume: (connection: AwsConnection, volumeId: string) =>
    ipcRenderer.invoke('ec2:describe-volume', connection, volumeId),
  tagEbsVolume: (connection: AwsConnection, volumeId: string, tags: Record<string, string>) =>
    ipcRenderer.invoke('ec2:tag-volume', connection, volumeId, tags),
  untagEbsVolume: (connection: AwsConnection, volumeId: string, tagKeys: string[]) =>
    ipcRenderer.invoke('ec2:untag-volume', connection, volumeId, tagKeys),
  attachEbsVolume: (connection: AwsConnection, volumeId: string, request: EbsVolumeAttachRequest) =>
    ipcRenderer.invoke('ec2:attach-volume', connection, volumeId, request),
  detachEbsVolume: (connection: AwsConnection, volumeId: string, request?: EbsVolumeDetachRequest) =>
    ipcRenderer.invoke('ec2:detach-volume', connection, volumeId, request),
  deleteEbsVolume: (connection: AwsConnection, volumeId: string) =>
    ipcRenderer.invoke('ec2:delete-volume', connection, volumeId),
  modifyEbsVolume: (connection: AwsConnection, volumeId: string, request: EbsVolumeModifyRequest) =>
    ipcRenderer.invoke('ec2:modify-volume', connection, volumeId, request),
  runEc2InstanceAction: (connection: AwsConnection, instanceId: string, action: Ec2InstanceAction) =>
    ipcRenderer.invoke('ec2:action', connection, instanceId, action),
  runEc2BulkInstanceAction: (connection: AwsConnection, instanceIds: string[], action: Ec2BulkInstanceAction) =>
    ipcRenderer.invoke('ec2:action-bulk', connection, instanceIds, action),
  terminateEc2Instance: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('ec2:terminate', connection, instanceId),
  terminateEc2Instances: (connection: AwsConnection, instanceIds: string[]) =>
    ipcRenderer.invoke('ec2:terminate-bulk', connection, instanceIds),
  resizeEc2Instance: (connection: AwsConnection, instanceId: string, instanceType: string) =>
    ipcRenderer.invoke('ec2:resize', connection, instanceId, instanceType),
  listInstanceTypes: (connection: AwsConnection, architecture?: string, currentGenerationOnly?: boolean) =>
    ipcRenderer.invoke('ec2:list-instance-types', connection, architecture, currentGenerationOnly),
  listEc2Snapshots: (connection: AwsConnection) => ipcRenderer.invoke('ec2:list-snapshots', connection),
  createEc2Snapshot: (connection: AwsConnection, volumeId: string, description: string) =>
    ipcRenderer.invoke('ec2:create-snapshot', connection, volumeId, description),
  deleteEc2Snapshot: (connection: AwsConnection, snapshotId: string) =>
    ipcRenderer.invoke('ec2:delete-snapshot', connection, snapshotId),
  tagEc2Snapshot: (connection: AwsConnection, snapshotId: string, tags: Record<string, string>) =>
    ipcRenderer.invoke('ec2:tag-snapshot', connection, snapshotId, tags),
  getIamAssociation: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('ec2:get-iam-association', connection, instanceId),
  attachIamProfile: (connection: AwsConnection, instanceId: string, profileName: string) =>
    ipcRenderer.invoke('ec2:attach-iam-profile', connection, instanceId, profileName),
  replaceIamProfile: (connection: AwsConnection, associationId: string, profileName: string) =>
    ipcRenderer.invoke('ec2:replace-iam-profile', connection, associationId, profileName),
  removeIamProfile: (connection: AwsConnection, associationId: string) =>
    ipcRenderer.invoke('ec2:remove-iam-profile', connection, associationId),
  launchBastion: (connection: AwsConnection, config: BastionLaunchConfig) =>
    ipcRenderer.invoke('ec2:launch-bastion', connection, config),
  findBastionConnectionsForInstance: (connection: AwsConnection, targetInstanceId: string) =>
    ipcRenderer.invoke('ec2:find-bastion-connections', connection, targetInstanceId),
  deleteBastion: (connection: AwsConnection, targetInstanceId: string) =>
    ipcRenderer.invoke('ec2:delete-bastion', connection, targetInstanceId),
  createTempVolumeCheck: (connection: AwsConnection, volumeId: string) =>
    ipcRenderer.invoke('ec2:create-temp-volume-check', connection, volumeId),
  deleteTempVolumeCheck: (connection: AwsConnection, tempUuidOrInstanceId: string) =>
    ipcRenderer.invoke('ec2:delete-temp-volume-check', connection, tempUuidOrInstanceId),
  listBastions: (connection: AwsConnection) => ipcRenderer.invoke('ec2:list-bastions', connection),
  listPopularBastionAmis: (connection: AwsConnection, architecture?: string) =>
    ipcRenderer.invoke('ec2:list-popular-bastion-amis', connection, architecture),
  describeVpc: (connection: AwsConnection, vpcId: string) =>
    ipcRenderer.invoke('ec2:describe-vpc', connection, vpcId),
  launchFromSnapshot: (connection: AwsConnection, config: SnapshotLaunchConfig) =>
    ipcRenderer.invoke('ec2:launch-from-snapshot', connection, config),
  sendSshPublicKey: (connection: AwsConnection, instanceId: string, osUser: string, publicKey: string, az: string) =>
    ipcRenderer.invoke('ec2:send-ssh-public-key', connection, instanceId, osUser, publicKey, az),
  getEc2Recommendations: (connection: AwsConnection) =>
    ipcRenderer.invoke('ec2:recommendations', connection),
  listSsmManagedInstances: (connection: AwsConnection) =>
    ipcRenderer.invoke('ec2:ssm:list-managed', connection),
  getSsmConnectionTarget: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('ec2:ssm:target', connection, instanceId),
  listSsmSessions: (connection: AwsConnection, targetInstanceId?: string) =>
    ipcRenderer.invoke('ec2:ssm:list-sessions', connection, targetInstanceId),
  startSsmSession: (connection: AwsConnection, request: SsmStartSessionRequest) =>
    ipcRenderer.invoke('ec2:ssm:start-session', connection, request),
  sendSsmCommand: (connection: AwsConnection, request: SsmSendCommandRequest) =>
    ipcRenderer.invoke('ec2:ssm:send-command', connection, request),
  listLoadBalancerWorkspaces: (connection: AwsConnection) => ipcRenderer.invoke('elbv2:list-workspaces', connection),
  deleteLoadBalancer: (connection: AwsConnection, loadBalancerArn: string) =>
    ipcRenderer.invoke('elbv2:delete-load-balancer', connection, loadBalancerArn),
  listCloudWatchMetrics: (connection: AwsConnection) => ipcRenderer.invoke('cloudwatch:metrics', connection),
  getEc2MetricSeries: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('cloudwatch:ec2-series', connection, instanceId),
  listCloudWatchLogGroups: (connection: AwsConnection) => ipcRenderer.invoke('cloudwatch:log-groups', connection),
  listCloudWatchRecentEvents: (connection: AwsConnection, logGroupName: string, periodHours?: number) =>
    ipcRenderer.invoke('cloudwatch:recent-events', connection, logGroupName, periodHours),
  listEc2InstanceMetrics: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('cloudwatch:ec2-instance-metrics', connection, instanceId),
  getMetricStatistics: (connection: AwsConnection, metrics: unknown[], periodHours: number) =>
    ipcRenderer.invoke('cloudwatch:metric-stats', connection, metrics, periodHours),
  getEc2AllMetricSeries: (connection: AwsConnection, instanceId: string, periodHours: number) =>
    ipcRenderer.invoke('cloudwatch:ec2-all-series', connection, instanceId, periodHours),
  runCloudWatchQuery: (connection: AwsConnection, input: CloudWatchQueryExecutionInput) =>
    ipcRenderer.invoke('cloudwatch:run-query', connection, input),
  listRoute53HostedZones: (connection: AwsConnection) => ipcRenderer.invoke('route53:hosted-zones', connection),
  createRoute53HostedZone: (connection: AwsConnection, input: Route53HostedZoneCreateInput) =>
    ipcRenderer.invoke('route53:create-hosted-zone', connection, input),
  listRoute53Records: (connection: AwsConnection, hostedZoneId: string) =>
    ipcRenderer.invoke('route53:records', connection, hostedZoneId),
  upsertRoute53Record: (connection: AwsConnection, hostedZoneId: string, record: unknown) =>
    ipcRenderer.invoke('route53:upsert-record', connection, hostedZoneId, record),
  deleteRoute53Record: (connection: AwsConnection, hostedZoneId: string, record: unknown) =>
    ipcRenderer.invoke('route53:delete-record', connection, hostedZoneId, record),
  listTrails: (connection: AwsConnection) => ipcRenderer.invoke('cloudtrail:list-trails', connection),
  lookupCloudTrailEvents: (connection: AwsConnection, startTime: string, endTime: string) =>
    ipcRenderer.invoke('cloudtrail:lookup-events', connection, startTime, endTime),
  lookupCloudTrailEventsByResource: (connection: AwsConnection, resourceName: string, startTime: string, endTime: string) =>
    ipcRenderer.invoke('cloudtrail:lookup-events-by-resource', connection, resourceName, startTime, endTime),
  getOverviewMetrics: (connection: AwsConnection, regions: string[]) =>
    ipcRenderer.invoke('overview:metrics', connection, regions),
  getOverviewStatistics: (connection: AwsConnection) =>
    ipcRenderer.invoke('overview:statistics', connection),
  getOverviewAccountContext: (connection: AwsConnection) =>
    ipcRenderer.invoke('overview:account-context', connection),
  getComplianceReport: (connection: AwsConnection) =>
    ipcRenderer.invoke('compliance:report', connection),
  updateComplianceFindingWorkflow: (
    connection: AwsConnection,
    findingId: string,
    update: unknown
  ) => ipcRenderer.invoke('compliance:update-finding-workflow', connection, findingId, update),
  getRelationshipMap: (connection: AwsConnection) =>
    ipcRenderer.invoke('overview:relationships', connection),
  searchByTag: (connection: AwsConnection, tagKey: string, tagValue?: string) =>
    ipcRenderer.invoke('overview:search-tags', connection, tagKey, tagValue),
  getCostBreakdown: (connection: AwsConnection) =>
    ipcRenderer.invoke('overview:cost-breakdown', connection),
  openExternalUrl: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  openPath: (targetPath: string) => ipcRenderer.invoke('shell:open-path', targetPath),
  chooseEc2SshKey: () => ipcRenderer.invoke('ec2:ssh:choose-key'),
  listEc2SshKeySuggestions: (preferredKeyName?: string) => ipcRenderer.invoke('ec2:ssh:list-key-suggestions', preferredKeyName),
  materializeEc2VaultSshKey: (entryId: string) => ipcRenderer.invoke('ec2:ssh:materialize-vault-key', entryId),
  getEnterpriseSettings: () => ipcRenderer.invoke('enterprise:get-settings'),
  setEnterpriseAccessMode: (accessMode: 'read-only' | 'operator') => ipcRenderer.invoke('enterprise:set-access-mode', accessMode),
  listEnterpriseAuditEvents: () => ipcRenderer.invoke('enterprise:audit:list'),
  exportEnterpriseAuditEvents: () => ipcRenderer.invoke('enterprise:audit:export'),

  /* EKS */
  listEksClusters: (connection: AwsConnection) => ipcRenderer.invoke('eks:list-clusters', connection),
  describeEksCluster: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:describe-cluster', connection, clusterName),
  listEksNodegroups: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:list-nodegroups', connection, clusterName),
  updateEksNodegroupScaling: (
    connection: AwsConnection,
    clusterName: string,
    nodegroupName: string,
    min: number,
    desired: number,
    max: number
  ) => ipcRenderer.invoke('eks:update-nodegroup-scaling', connection, clusterName, nodegroupName, min, desired, max),
  listEksUpdates: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:list-updates', connection, clusterName),
  deleteEksCluster: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:delete-cluster', connection, clusterName),
  addEksToKubeconfig: (connection: AwsConnection, clusterName: string, contextName: string, kubeconfigPath: string) =>
    ipcRenderer.invoke('eks:add-kubeconfig', connection, clusterName, contextName, kubeconfigPath),
  chooseEksKubeconfigPath: (currentPath?: string) =>
    ipcRenderer.invoke('eks:choose-kubeconfig-path', currentPath),
  launchKubectlTerminal: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:launch-kubectl', connection, clusterName),
  prepareEksKubectlSession: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:prepare-kubectl-session', connection, clusterName),
  runEksCommand: (connection: AwsConnection, clusterName: string, kubeconfigPath: string, command: string) =>
    ipcRenderer.invoke('eks:run-command', connection, clusterName, kubeconfigPath, command),
  getEksObservabilityReport: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:get-observability-report', connection, clusterName),

  /* ECS */
  listEcsClusters: (connection: AwsConnection) => ipcRenderer.invoke('ecs:list-clusters', connection),
  listEcsServices: (connection: AwsConnection, clusterArn: string) =>
    ipcRenderer.invoke('ecs:list-services', connection, clusterArn),
  describeEcsService: (connection: AwsConnection, clusterArn: string, serviceName: string) =>
    ipcRenderer.invoke('ecs:describe-service', connection, clusterArn, serviceName),
  getEcsDiagnostics: (connection: AwsConnection, clusterArn: string, serviceName: string) =>
    ipcRenderer.invoke('ecs:get-diagnostics', connection, clusterArn, serviceName),
  getEcsObservabilityReport: (connection: AwsConnection, clusterArn: string, serviceName: string) =>
    ipcRenderer.invoke('ecs:get-observability-report', connection, clusterArn, serviceName),
  listEcsTasks: (connection: AwsConnection, clusterArn: string, serviceName?: string) =>
    ipcRenderer.invoke('ecs:list-tasks', connection, clusterArn, serviceName),
  updateEcsDesiredCount: (connection: AwsConnection, clusterArn: string, serviceName: string, desiredCount: number) =>
    ipcRenderer.invoke('ecs:update-desired-count', connection, clusterArn, serviceName, desiredCount),
  forceEcsRedeploy: (connection: AwsConnection, clusterArn: string, serviceName: string) =>
    ipcRenderer.invoke('ecs:force-redeploy', connection, clusterArn, serviceName),
  stopEcsTask: (connection: AwsConnection, clusterArn: string, taskArn: string, reason?: string) =>
    ipcRenderer.invoke('ecs:stop-task', connection, clusterArn, taskArn, reason),
  deleteEcsService: (connection: AwsConnection, clusterArn: string, serviceName: string) =>
    ipcRenderer.invoke('ecs:delete-service', connection, clusterArn, serviceName),
  createEcsFargateService: (connection: AwsConnection, config: EcsFargateServiceConfig) =>
    ipcRenderer.invoke('ecs:create-fargate-service', connection, config),
  getEcsContainerLogs: (connection: AwsConnection, logGroup: string, logStream: string, startTime?: number) =>
    ipcRenderer.invoke('ecs:get-container-logs', connection, logGroup, logStream, startTime),

  /* Lambda */
  listLambdaFunctions: (connection: AwsConnection) => ipcRenderer.invoke('lambda:list-functions', connection),
  getLambdaFunction: (connection: AwsConnection, functionName: string) =>
    ipcRenderer.invoke('lambda:get-function', connection, functionName),
  invokeLambdaFunction: (connection: AwsConnection, functionName: string, payload: string) =>
    ipcRenderer.invoke('lambda:invoke', connection, functionName, payload),
  getLambdaFunctionCode: (connection: AwsConnection, functionName: string) =>
    ipcRenderer.invoke('lambda:get-code', connection, functionName),
  createLambdaFunction: (connection: AwsConnection, config: LambdaCreateConfig) =>
    ipcRenderer.invoke('lambda:create', connection, config),
  deleteLambdaFunction: (connection: AwsConnection, functionName: string) =>
    ipcRenderer.invoke('lambda:delete', connection, functionName),

  /* Auto Scaling */
  listAutoScalingGroups: (connection: AwsConnection) => ipcRenderer.invoke('auto-scaling:list-groups', connection),
  listAutoScalingInstances: (connection: AwsConnection, groupName: string) =>
    ipcRenderer.invoke('auto-scaling:list-instances', connection, groupName),
  updateAutoScalingCapacity: (connection: AwsConnection, groupName: string, minimum: number, desired: number, maximum: number) =>
    ipcRenderer.invoke('auto-scaling:update-capacity', connection, groupName, minimum, desired, maximum),
  startAutoScalingRefresh: (connection: AwsConnection, groupName: string) =>
    ipcRenderer.invoke('auto-scaling:start-refresh', connection, groupName),
  deleteAutoScalingGroup: (connection: AwsConnection, groupName: string, forceDelete = false) =>
    ipcRenderer.invoke('auto-scaling:delete-group', connection, groupName, forceDelete),

  /* S3 */
  listS3Buckets: (connection: AwsConnection) => ipcRenderer.invoke('s3:list-buckets', connection),
  listS3Governance: (connection: AwsConnection) => ipcRenderer.invoke('s3:list-governance', connection),
  getS3GovernanceDetail: (connection: AwsConnection, bucketName: string) =>
    ipcRenderer.invoke('s3:get-governance-detail', connection, bucketName),
  listS3Objects: (connection: AwsConnection, bucketName: string, prefix: string) =>
    ipcRenderer.invoke('s3:list-objects', connection, bucketName, prefix),
  createS3Bucket: (connection: AwsConnection, bucketName: string) =>
    ipcRenderer.invoke('s3:create-bucket', connection, bucketName),
  deleteS3Object: (connection: AwsConnection, bucketName: string, key: string) =>
    ipcRenderer.invoke('s3:delete-object', connection, bucketName, key),
  getS3PresignedUrl: (connection: AwsConnection, bucketName: string, key: string) =>
    ipcRenderer.invoke('s3:presigned-url', connection, bucketName, key),
  createS3Folder: (connection: AwsConnection, bucketName: string, folderKey: string) =>
    ipcRenderer.invoke('s3:create-folder', connection, bucketName, folderKey),
  downloadS3Object: (connection: AwsConnection, bucketName: string, key: string) =>
    ipcRenderer.invoke('s3:download-object', connection, bucketName, key),
  downloadS3ObjectTo: (connection: AwsConnection, bucketName: string, key: string) =>
    ipcRenderer.invoke('s3:download-object-to', connection, bucketName, key),
  openS3Object: (connection: AwsConnection, bucketName: string, key: string) =>
    ipcRenderer.invoke('s3:open-object', connection, bucketName, key),
  openS3InVSCode: (connection: AwsConnection, bucketName: string, key: string) =>
    ipcRenderer.invoke('s3:open-in-vscode', connection, bucketName, key),
  getS3ObjectContent: (connection: AwsConnection, bucketName: string, key: string) =>
    ipcRenderer.invoke('s3:get-object-content', connection, bucketName, key),
  putS3ObjectContent: (connection: AwsConnection, bucketName: string, key: string, content: string, contentType?: string) =>
    ipcRenderer.invoke('s3:put-object-content', connection, bucketName, key, content, contentType),
  uploadS3Object: (connection: AwsConnection, bucketName: string, key: string, localPath: string) =>
    ipcRenderer.invoke('s3:upload-object', connection, bucketName, key, localPath),
  enableS3BucketVersioning: (connection: AwsConnection, bucketName: string) =>
    ipcRenderer.invoke('s3:enable-versioning', connection, bucketName),
  enableS3BucketEncryption: (connection: AwsConnection, bucketName: string) =>
    ipcRenderer.invoke('s3:enable-encryption', connection, bucketName),
  putS3BucketPolicy: (connection: AwsConnection, bucketName: string, policyJson: string) =>
    ipcRenderer.invoke('s3:put-policy', connection, bucketName, policyJson),

  /* RDS */
  listRdsInstances: (connection: AwsConnection) => ipcRenderer.invoke('rds:list-instances', connection),
  listRdsClusters: (connection: AwsConnection) => ipcRenderer.invoke('rds:list-clusters', connection),
  describeRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) =>
    ipcRenderer.invoke('rds:describe-instance', connection, dbInstanceIdentifier),
  describeRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) =>
    ipcRenderer.invoke('rds:describe-cluster', connection, dbClusterIdentifier),
  startRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) =>
    ipcRenderer.invoke('rds:start-instance', connection, dbInstanceIdentifier),
  stopRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) =>
    ipcRenderer.invoke('rds:stop-instance', connection, dbInstanceIdentifier),
  rebootRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string, forceFailover?: boolean) =>
    ipcRenderer.invoke('rds:reboot-instance', connection, dbInstanceIdentifier, forceFailover),
  resizeRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string, dbInstanceClass: string) =>
    ipcRenderer.invoke('rds:resize-instance', connection, dbInstanceIdentifier, dbInstanceClass),
  createRdsSnapshot: (connection: AwsConnection, dbInstanceIdentifier: string, dbSnapshotIdentifier: string) =>
    ipcRenderer.invoke('rds:create-snapshot', connection, dbInstanceIdentifier, dbSnapshotIdentifier),
  startRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) =>
    ipcRenderer.invoke('rds:start-cluster', connection, dbClusterIdentifier),
  stopRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) =>
    ipcRenderer.invoke('rds:stop-cluster', connection, dbClusterIdentifier),
  failoverRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) =>
    ipcRenderer.invoke('rds:failover-cluster', connection, dbClusterIdentifier),
  createRdsClusterSnapshot: (connection: AwsConnection, dbClusterIdentifier: string, dbClusterSnapshotIdentifier: string) =>
    ipcRenderer.invoke('rds:create-cluster-snapshot', connection, dbClusterIdentifier, dbClusterSnapshotIdentifier),

  /* CloudFormation */
  listCloudFormationStacks: (connection: AwsConnection) => ipcRenderer.invoke('cloudformation:list-stacks', connection),
  listCloudFormationStackResources: (connection: AwsConnection, stackName: string) =>
    ipcRenderer.invoke('cloudformation:list-stack-resources', connection, stackName),
  listCloudFormationChangeSets: (connection: AwsConnection, stackName: string) =>
    ipcRenderer.invoke('cloudformation:list-change-sets', connection, stackName),
  createCloudFormationChangeSet: (connection: AwsConnection, input: unknown) =>
    ipcRenderer.invoke('cloudformation:create-change-set', connection, input),
  getCloudFormationChangeSetDetail: (connection: AwsConnection, stackName: string, changeSetName: string) =>
    ipcRenderer.invoke('cloudformation:get-change-set-detail', connection, stackName, changeSetName),
  executeCloudFormationChangeSet: (connection: AwsConnection, stackName: string, changeSetName: string) =>
    ipcRenderer.invoke('cloudformation:execute-change-set', connection, stackName, changeSetName),
  deleteCloudFormationChangeSet: (connection: AwsConnection, stackName: string, changeSetName: string) =>
    ipcRenderer.invoke('cloudformation:delete-change-set', connection, stackName, changeSetName),
  getCloudFormationDriftSummary: (connection: AwsConnection, stackName: string) =>
    ipcRenderer.invoke('cloudformation:get-drift-summary', connection, stackName),
  startCloudFormationDriftDetection: (connection: AwsConnection, stackName: string) =>
    ipcRenderer.invoke('cloudformation:start-drift-detection', connection, stackName),
  getCloudFormationDriftDetectionStatus: (connection: AwsConnection, stackName: string, driftDetectionId: string) =>
    ipcRenderer.invoke('cloudformation:get-drift-detection-status', connection, stackName, driftDetectionId),

  /* ECR */
  listEcrRepositories: (connection: AwsConnection) => ipcRenderer.invoke('ecr:list-repos', connection),
  listEcrImages: (connection: AwsConnection, repositoryName: string) =>
    ipcRenderer.invoke('ecr:list-images', connection, repositoryName),
  createEcrRepository: (connection: AwsConnection, repositoryName: string, imageTagMutability: string, scanOnPush: boolean) =>
    ipcRenderer.invoke('ecr:create-repo', connection, repositoryName, imageTagMutability, scanOnPush),
  deleteEcrRepository: (connection: AwsConnection, repositoryName: string, force: boolean) =>
    ipcRenderer.invoke('ecr:delete-repo', connection, repositoryName, force),
  deleteEcrImage: (connection: AwsConnection, repositoryName: string, imageDigest: string) =>
    ipcRenderer.invoke('ecr:delete-image', connection, repositoryName, imageDigest),
  startEcrImageScan: (connection: AwsConnection, repositoryName: string, imageDigest: string, imageTag?: string) =>
    ipcRenderer.invoke('ecr:start-scan', connection, repositoryName, imageDigest, imageTag),
  getEcrScanFindings: (connection: AwsConnection, repositoryName: string, imageDigest: string) =>
    ipcRenderer.invoke('ecr:scan-findings', connection, repositoryName, imageDigest),
  getEcrAuthorizationToken: (connection: AwsConnection) => ipcRenderer.invoke('ecr:get-login', connection),
  ecrDockerLogin: (connection: AwsConnection) => ipcRenderer.invoke('ecr:docker-login', connection),
  ecrDockerPull: (repositoryUri: string, tag: string) =>
    ipcRenderer.invoke('ecr:docker-pull', repositoryUri, tag),
  ecrDockerPush: (localImage: string, repositoryUri: string, tag: string) =>
    ipcRenderer.invoke('ecr:docker-push', localImage, repositoryUri, tag),

  /* VPC */
  listVpcs: (connection: AwsConnection) => ipcRenderer.invoke('vpc:list', connection),
  listSubnets: (connection: AwsConnection, vpcId?: string) => ipcRenderer.invoke('vpc:subnets', connection, vpcId),
  listRouteTables: (connection: AwsConnection, vpcId?: string) => ipcRenderer.invoke('vpc:route-tables', connection, vpcId),
  listInternetGateways: (connection: AwsConnection, vpcId?: string) => ipcRenderer.invoke('vpc:internet-gateways', connection, vpcId),
  listNatGateways: (connection: AwsConnection, vpcId?: string) => ipcRenderer.invoke('vpc:nat-gateways', connection, vpcId),
  listTransitGateways: (connection: AwsConnection) => ipcRenderer.invoke('vpc:transit-gateways', connection),
  listNetworkInterfaces: (connection: AwsConnection, vpcId?: string) => ipcRenderer.invoke('vpc:network-interfaces', connection, vpcId),
  listSecurityGroupsForVpc: (connection: AwsConnection, vpcId?: string) => ipcRenderer.invoke('vpc:security-groups', connection, vpcId),
  getVpcTopology: (connection: AwsConnection, vpcId: string) => ipcRenderer.invoke('vpc:topology', connection, vpcId),
  getVpcFlowDiagram: (connection: AwsConnection, vpcId: string) => ipcRenderer.invoke('vpc:flow-diagram', connection, vpcId),
  updateSubnetPublicIp: (connection: AwsConnection, subnetId: string, mapPublic: boolean) =>
    ipcRenderer.invoke('vpc:subnet-update-public-ip', connection, subnetId, mapPublic),
  createReachabilityPath: (connection: AwsConnection, sourceId: string, destId: string, protocol: string) =>
    ipcRenderer.invoke('vpc:reachability-create', connection, sourceId, destId, protocol),
  getReachabilityAnalysis: (connection: AwsConnection, analysisId: string) =>
    ipcRenderer.invoke('vpc:reachability-get', connection, analysisId),
  deleteReachabilityPath: (connection: AwsConnection, pathId: string) =>
    ipcRenderer.invoke('vpc:reachability-delete-path', connection, pathId),
  deleteReachabilityAnalysis: (connection: AwsConnection, analysisId: string) =>
    ipcRenderer.invoke('vpc:reachability-delete-analysis', connection, analysisId),

  /* Security Groups */
  listSecurityGroups: (connection: AwsConnection, vpcId?: string) =>
    ipcRenderer.invoke('sg:list', connection, vpcId),
  describeSecurityGroup: (connection: AwsConnection, groupId: string) =>
    ipcRenderer.invoke('sg:describe', connection, groupId),
  addInboundRule: (connection: AwsConnection, groupId: string, rule: unknown) =>
    ipcRenderer.invoke('sg:add-inbound', connection, groupId, rule),
  revokeInboundRule: (connection: AwsConnection, groupId: string, rule: unknown) =>
    ipcRenderer.invoke('sg:revoke-inbound', connection, groupId, rule),
  addOutboundRule: (connection: AwsConnection, groupId: string, rule: unknown) =>
    ipcRenderer.invoke('sg:add-outbound', connection, groupId, rule),
  revokeOutboundRule: (connection: AwsConnection, groupId: string, rule: unknown) =>
    ipcRenderer.invoke('sg:revoke-outbound', connection, groupId, rule),

  /* SNS */
  listSnsTopics: (connection: AwsConnection) => ipcRenderer.invoke('sns:list-topics', connection),
  getSnsTopic: (connection: AwsConnection, topicArn: string) => ipcRenderer.invoke('sns:get-topic', connection, topicArn),
  createSnsTopic: (connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) =>
    ipcRenderer.invoke('sns:create-topic', connection, name, fifo, attrs),
  deleteSnsTopic: (connection: AwsConnection, topicArn: string) => ipcRenderer.invoke('sns:delete-topic', connection, topicArn),
  setSnsTopicAttribute: (connection: AwsConnection, topicArn: string, attrName: string, attrValue: string) =>
    ipcRenderer.invoke('sns:set-attribute', connection, topicArn, attrName, attrValue),
  listSnsSubscriptions: (connection: AwsConnection, topicArn: string) => ipcRenderer.invoke('sns:list-subscriptions', connection, topicArn),
  snsSubscribe: (connection: AwsConnection, topicArn: string, protocol: string, endpoint: string) =>
    ipcRenderer.invoke('sns:subscribe', connection, topicArn, protocol, endpoint),
  snsUnsubscribe: (connection: AwsConnection, subscriptionArn: string) => ipcRenderer.invoke('sns:unsubscribe', connection, subscriptionArn),
  snsPublish: (connection: AwsConnection, topicArn: string, message: string, subject?: string, groupId?: string, dedupId?: string) =>
    ipcRenderer.invoke('sns:publish', connection, topicArn, message, subject, groupId, dedupId),
  tagSnsTopic: (connection: AwsConnection, topicArn: string, tags: Record<string, string>) =>
    ipcRenderer.invoke('sns:tag', connection, topicArn, tags),
  untagSnsTopic: (connection: AwsConnection, topicArn: string, tagKeys: string[]) =>
    ipcRenderer.invoke('sns:untag', connection, topicArn, tagKeys),

  /* SQS */
  listSqsQueues: (connection: AwsConnection) => ipcRenderer.invoke('sqs:list-queues', connection),
  getSqsQueue: (connection: AwsConnection, queueUrl: string) => ipcRenderer.invoke('sqs:get-queue', connection, queueUrl),
  createSqsQueue: (connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) =>
    ipcRenderer.invoke('sqs:create-queue', connection, name, fifo, attrs),
  deleteSqsQueue: (connection: AwsConnection, queueUrl: string) => ipcRenderer.invoke('sqs:delete-queue', connection, queueUrl),
  purgeSqsQueue: (connection: AwsConnection, queueUrl: string) => ipcRenderer.invoke('sqs:purge-queue', connection, queueUrl),
  setSqsAttributes: (connection: AwsConnection, queueUrl: string, attrs: Record<string, string>) =>
    ipcRenderer.invoke('sqs:set-attributes', connection, queueUrl, attrs),
  sqsSendMessage: (connection: AwsConnection, queueUrl: string, body: string, delay?: number, groupId?: string, dedupId?: string) =>
    ipcRenderer.invoke('sqs:send-message', connection, queueUrl, body, delay, groupId, dedupId),
  sqsReceiveMessages: (connection: AwsConnection, queueUrl: string, max: number, wait: number) =>
    ipcRenderer.invoke('sqs:receive-messages', connection, queueUrl, max, wait),
  sqsDeleteMessage: (connection: AwsConnection, queueUrl: string, receiptHandle: string) =>
    ipcRenderer.invoke('sqs:delete-message', connection, queueUrl, receiptHandle),
  sqsChangeVisibility: (connection: AwsConnection, queueUrl: string, receiptHandle: string, timeout: number) =>
    ipcRenderer.invoke('sqs:change-visibility', connection, queueUrl, receiptHandle, timeout),
  tagSqsQueue: (connection: AwsConnection, queueUrl: string, tags: Record<string, string>) =>
    ipcRenderer.invoke('sqs:tag', connection, queueUrl, tags),
  untagSqsQueue: (connection: AwsConnection, queueUrl: string, tagKeys: string[]) =>
    ipcRenderer.invoke('sqs:untag', connection, queueUrl, tagKeys),
  sqsTimeline: (connection: AwsConnection, queueUrl: string) => ipcRenderer.invoke('sqs:timeline', connection, queueUrl),

  /* Identity Center / SSO */
  listSsoInstances: (connection: AwsConnection) => ipcRenderer.invoke('sso:list-instances', connection),
  createSsoInstance: (connection: AwsConnection, name: string) => ipcRenderer.invoke('sso:create-instance', connection, name),
  deleteSsoInstance: (connection: AwsConnection, instanceArn: string) => ipcRenderer.invoke('sso:delete-instance', connection, instanceArn),
  listSsoPermissionSets: (connection: AwsConnection, instanceArn: string) => ipcRenderer.invoke('sso:list-permission-sets', connection, instanceArn),
  listSsoUsers: (connection: AwsConnection, identityStoreId: string) => ipcRenderer.invoke('sso:list-users', connection, identityStoreId),
  listSsoGroups: (connection: AwsConnection, identityStoreId: string) => ipcRenderer.invoke('sso:list-groups', connection, identityStoreId),
  listSsoAccountAssignments: (connection: AwsConnection, instanceArn: string, accountId: string, permissionSetArn: string) =>
    ipcRenderer.invoke('sso:list-account-assignments', connection, instanceArn, accountId, permissionSetArn),
  simulateSsoPermissions: (connection: AwsConnection, instanceArn: string, permissionSetArn: string) =>
    ipcRenderer.invoke('sso:simulate-permissions', connection, instanceArn, permissionSetArn),

  /* ACM */
  listAcmCertificates: (connection: AwsConnection) => ipcRenderer.invoke('acm:list-certificates', connection),
  describeAcmCertificate: (connection: AwsConnection, certificateArn: string) =>
    ipcRenderer.invoke('acm:describe-certificate', connection, certificateArn),
  requestAcmCertificate: (connection: AwsConnection, input: unknown) =>
    ipcRenderer.invoke('acm:request-certificate', connection, input),
  deleteAcmCertificate: (connection: AwsConnection, certificateArn: string) =>
    ipcRenderer.invoke('acm:delete-certificate', connection, certificateArn),

  /* Secrets Manager */
  listSecrets: (connection: AwsConnection) => ipcRenderer.invoke('secrets:list', connection),
  describeSecret: (connection: AwsConnection, secretId: string) => ipcRenderer.invoke('secrets:describe', connection, secretId),
  getSecretDependencyReport: (connection: AwsConnection, secretId: string) =>
    ipcRenderer.invoke('secrets:dependency-report', connection, secretId),
  getSecretValue: (connection: AwsConnection, secretId: string, versionId?: string) =>
    ipcRenderer.invoke('secrets:get-value', connection, secretId, versionId),
  createSecret: (connection: AwsConnection, input: unknown) => ipcRenderer.invoke('secrets:create', connection, input),
  deleteSecret: (connection: AwsConnection, secretId: string, forceDeleteWithoutRecovery: boolean) =>
    ipcRenderer.invoke('secrets:delete', connection, secretId, forceDeleteWithoutRecovery),
  restoreSecret: (connection: AwsConnection, secretId: string) => ipcRenderer.invoke('secrets:restore', connection, secretId),
  updateSecretValue: (connection: AwsConnection, secretId: string, secretString: string) =>
    ipcRenderer.invoke('secrets:update-value', connection, secretId, secretString),
  updateSecretDescription: (connection: AwsConnection, secretId: string, description: string) =>
    ipcRenderer.invoke('secrets:update-description', connection, secretId, description),
  rotateSecret: (connection: AwsConnection, secretId: string) => ipcRenderer.invoke('secrets:rotate', connection, secretId),
  putSecretResourcePolicy: (connection: AwsConnection, secretId: string, policy: string) =>
    ipcRenderer.invoke('secrets:put-policy', connection, secretId, policy),
  tagSecret: (connection: AwsConnection, secretId: string, tags: unknown) =>
    ipcRenderer.invoke('secrets:tag', connection, secretId, tags),
  untagSecret: (connection: AwsConnection, secretId: string, tagKeys: string[]) =>
    ipcRenderer.invoke('secrets:untag', connection, secretId, tagKeys),

  /* Key Pairs */
  listKeyPairs: (connection: AwsConnection) => ipcRenderer.invoke('key-pairs:list', connection),
  createKeyPair: (connection: AwsConnection, keyName: string) => ipcRenderer.invoke('key-pairs:create', connection, keyName),
  deleteKeyPair: (connection: AwsConnection, keyName: string) => ipcRenderer.invoke('key-pairs:delete', connection, keyName),

  /* STS tools */
  decodeAuthorizationMessage: (connection: AwsConnection, encodedMessage: string) =>
    ipcRenderer.invoke('sts:decode-auth-message', connection, encodedMessage),
  lookupAccessKeyOwnership: (connection: AwsConnection, accessKeyId: string) =>
    ipcRenderer.invoke('sts:lookup-access-key', connection, accessKeyId),
  assumeRole: (connection: AwsConnection, roleArn: string, sessionName: string, externalId?: string) =>
    ipcRenderer.invoke('sts:assume-role', connection, roleArn, sessionName, externalId),

  /* KMS */
  listKmsKeys: (connection: AwsConnection) => ipcRenderer.invoke('kms:list-keys', connection),
  describeKmsKey: (connection: AwsConnection, keyId: string) => ipcRenderer.invoke('kms:describe-key', connection, keyId),
  decryptCiphertext: (connection: AwsConnection, ciphertext: string) => ipcRenderer.invoke('kms:decrypt', connection, ciphertext),

  /* WAF */
  listWebAcls: (connection: AwsConnection, scope: string) => ipcRenderer.invoke('waf:list-web-acls', connection, scope),
  describeWebAcl: (connection: AwsConnection, scope: string, id: string, name: string) =>
    ipcRenderer.invoke('waf:describe-web-acl', connection, scope, id, name),
  createWebAcl: (connection: AwsConnection, input: unknown) => ipcRenderer.invoke('waf:create-web-acl', connection, input),
  deleteWebAcl: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string) =>
    ipcRenderer.invoke('waf:delete-web-acl', connection, scope, id, name, lockToken),
  addWafRule: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string, input: unknown) =>
    ipcRenderer.invoke('waf:add-rule', connection, scope, id, name, lockToken, input),
  updateWafRulesJson: (
    connection: AwsConnection,
    scope: string,
    id: string,
    name: string,
    lockToken: string,
    defaultAction: string,
    description: string,
    rulesJson: string
  ) => ipcRenderer.invoke('waf:update-rules-json', connection, scope, id, name, lockToken, defaultAction, description, rulesJson),
  deleteWafRule: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string, ruleName: string) =>
    ipcRenderer.invoke('waf:delete-rule', connection, scope, id, name, lockToken, ruleName),
  associateWebAcl: (connection: AwsConnection, resourceArn: string, webAclArn: string) =>
    ipcRenderer.invoke('waf:associate-resource', connection, resourceArn, webAclArn),
  disassociateWebAcl: (connection: AwsConnection, resourceArn: string) =>
    ipcRenderer.invoke('waf:disassociate-resource', connection, resourceArn),

  /* App terminal */
  openAwsTerminal: (sessionId: string, connection: AwsConnection, initialCommand?: string) =>
    ipcRenderer.invoke('terminal:open-aws', sessionId, connection, initialCommand),
  updateAwsTerminalContext: (sessionId: string, connection: AwsConnection) =>
    ipcRenderer.invoke('terminal:update-aws-context', sessionId, connection),
  openProviderTerminal: (
    sessionId: string,
    target: { providerId: 'gcp' | 'azure'; label: string; modeId: string; modeLabel: string; env: Record<string, string> },
    initialCommand?: string
  ) =>
    ipcRenderer.invoke('terminal:open-provider-context', sessionId, target, initialCommand),
  updateProviderTerminalContext: (
    sessionId: string,
    target: { providerId: 'gcp' | 'azure'; label: string; modeId: string; modeLabel: string; env: Record<string, string> }
  ) =>
    ipcRenderer.invoke('terminal:update-provider-context', sessionId, target),
  sendTerminalInput: (sessionId: string, input: string) => ipcRenderer.invoke('terminal:input', sessionId, input),
  runTerminalCommand: (sessionId: string, command: string) => ipcRenderer.invoke('terminal:run-command', sessionId, command),
  resizeTerminal: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', sessionId, cols, rows),
  closeTerminal: (sessionId?: string) => ipcRenderer.invoke('terminal:close', sessionId),
  subscribeTerminal: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    terminalListenerMap.set(listener, wrapped)
    ipcRenderer.on('terminal:event', wrapped)
  },
  unsubscribeTerminal: (listener: (event: unknown) => void) => {
    const wrapped = terminalListenerMap.get(listener)
    if (!wrapped) {
      return
    }
    ipcRenderer.removeListener('terminal:event', wrapped)
    terminalListenerMap.delete(listener)
  },
  subscribeTempVolumeProgress: (listener: (event: EbsTempInspectionProgress) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload as EbsTempInspectionProgress)
    tempVolumeProgressListenerMap.set(listener as (event: unknown) => void, wrapped)
    ipcRenderer.on('ec2:temp-volume-progress', wrapped)
  },
  unsubscribeTempVolumeProgress: (listener: (event: EbsTempInspectionProgress) => void) => {
    const wrapped = tempVolumeProgressListenerMap.get(listener as (event: unknown) => void)
    if (!wrapped) {
      return
    }
    ipcRenderer.removeListener('ec2:temp-volume-progress', wrapped)
    tempVolumeProgressListenerMap.delete(listener as (event: unknown) => void)
  },

  /* IAM */
  listIamUsers: (c: AwsConnection) => ipcRenderer.invoke('iam:list-users', c),
  listIamGroups: (c: AwsConnection) => ipcRenderer.invoke('iam:list-groups', c),
  listIamRoles: (c: AwsConnection) => ipcRenderer.invoke('iam:list-roles', c),
  listIamPolicies: (c: AwsConnection, scope: string) => ipcRenderer.invoke('iam:list-policies', c, scope),
  getIamAccountSummary: (c: AwsConnection) => ipcRenderer.invoke('iam:account-summary', c),
  listIamAccessKeys: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:list-access-keys', c, u),
  createIamAccessKey: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:create-access-key', c, u),
  deleteIamAccessKey: (c: AwsConnection, u: string, k: string) => ipcRenderer.invoke('iam:delete-access-key', c, u, k),
  updateIamAccessKeyStatus: (c: AwsConnection, u: string, k: string, s: string) => ipcRenderer.invoke('iam:update-access-key-status', c, u, k, s),
  listIamMfaDevices: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:list-mfa-devices', c, u),
  deleteIamMfaDevice: (c: AwsConnection, u: string, sn: string) => ipcRenderer.invoke('iam:delete-mfa-device', c, u, sn),
  listAttachedIamUserPolicies: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:list-attached-user-policies', c, u),
  listIamUserInlinePolicies: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:list-user-inline-policies', c, u),
  attachIamUserPolicy: (c: AwsConnection, u: string, a: string) => ipcRenderer.invoke('iam:attach-user-policy', c, u, a),
  detachIamUserPolicy: (c: AwsConnection, u: string, a: string) => ipcRenderer.invoke('iam:detach-user-policy', c, u, a),
  putIamUserInlinePolicy: (c: AwsConnection, u: string, n: string, d: string) => ipcRenderer.invoke('iam:put-user-inline-policy', c, u, n, d),
  deleteIamUserInlinePolicy: (c: AwsConnection, u: string, n: string) => ipcRenderer.invoke('iam:delete-user-inline-policy', c, u, n),
  listIamUserGroups: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:list-user-groups', c, u),
  addIamUserToGroup: (c: AwsConnection, u: string, g: string) => ipcRenderer.invoke('iam:add-user-to-group', c, u, g),
  removeIamUserFromGroup: (c: AwsConnection, u: string, g: string) => ipcRenderer.invoke('iam:remove-user-from-group', c, u, g),
  createIamUser: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:create-user', c, u),
  deleteIamUser: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:delete-user', c, u),
  createIamLoginProfile: (c: AwsConnection, u: string, pw: string, r: boolean) => ipcRenderer.invoke('iam:create-login-profile', c, u, pw, r),
  deleteIamLoginProfile: (c: AwsConnection, u: string) => ipcRenderer.invoke('iam:delete-login-profile', c, u),
  listAttachedIamRolePolicies: (c: AwsConnection, r: string) => ipcRenderer.invoke('iam:list-attached-role-policies', c, r),
  listIamRoleInlinePolicies: (c: AwsConnection, r: string) => ipcRenderer.invoke('iam:list-role-inline-policies', c, r),
  getIamRoleTrustPolicy: (c: AwsConnection, r: string) => ipcRenderer.invoke('iam:get-role-trust-policy', c, r),
  updateIamRoleTrustPolicy: (c: AwsConnection, r: string, d: string) => ipcRenderer.invoke('iam:update-role-trust-policy', c, r, d),
  attachIamRolePolicy: (c: AwsConnection, r: string, a: string) => ipcRenderer.invoke('iam:attach-role-policy', c, r, a),
  detachIamRolePolicy: (c: AwsConnection, r: string, a: string) => ipcRenderer.invoke('iam:detach-role-policy', c, r, a),
  putIamRoleInlinePolicy: (c: AwsConnection, r: string, n: string, d: string) => ipcRenderer.invoke('iam:put-role-inline-policy', c, r, n, d),
  deleteIamRoleInlinePolicy: (c: AwsConnection, r: string, n: string) => ipcRenderer.invoke('iam:delete-role-inline-policy', c, r, n),
  createIamRole: (c: AwsConnection, r: string, tp: string, desc: string) => ipcRenderer.invoke('iam:create-role', c, r, tp, desc),
  deleteIamRole: (c: AwsConnection, r: string) => ipcRenderer.invoke('iam:delete-role', c, r),
  listAttachedIamGroupPolicies: (c: AwsConnection, g: string) => ipcRenderer.invoke('iam:list-attached-group-policies', c, g),
  attachIamGroupPolicy: (c: AwsConnection, g: string, a: string) => ipcRenderer.invoke('iam:attach-group-policy', c, g, a),
  detachIamGroupPolicy: (c: AwsConnection, g: string, a: string) => ipcRenderer.invoke('iam:detach-group-policy', c, g, a),
  createIamGroup: (c: AwsConnection, g: string) => ipcRenderer.invoke('iam:create-group', c, g),
  deleteIamGroup: (c: AwsConnection, g: string) => ipcRenderer.invoke('iam:delete-group', c, g),
  getIamPolicyVersion: (c: AwsConnection, a: string, v: string) => ipcRenderer.invoke('iam:get-policy-version', c, a, v),
  listIamPolicyVersions: (c: AwsConnection, a: string) => ipcRenderer.invoke('iam:list-policy-versions', c, a),
  createIamPolicyVersion: (c: AwsConnection, a: string, d: string, s: boolean) => ipcRenderer.invoke('iam:create-policy-version', c, a, d, s),
  deleteIamPolicyVersion: (c: AwsConnection, a: string, v: string) => ipcRenderer.invoke('iam:delete-policy-version', c, a, v),
  createIamPolicy: (c: AwsConnection, n: string, d: string, desc: string) => ipcRenderer.invoke('iam:create-policy', c, n, d, desc),
  deleteIamPolicy: (c: AwsConnection, a: string) => ipcRenderer.invoke('iam:delete-policy', c, a),
  simulateIamPolicy: (c: AwsConnection, a: string, actions: string[], resources: string[]) => ipcRenderer.invoke('iam:simulate-policy', c, a, actions, resources),
  generateIamCredentialReport: (c: AwsConnection) => ipcRenderer.invoke('iam:generate-credential-report', c),
  getIamCredentialReport: (c: AwsConnection) => ipcRenderer.invoke('iam:get-credential-report', c)
}

contextBridge.exposeInMainWorld('awsLens', awsLensApi)

/* ── Terraform Workspace bridge ───────────────────────────── */

const terraformListeners = new Set<(event: unknown) => void>()
const forwardTerraformEvent = (_event: unknown, payload: unknown) => {
  for (const listener of terraformListeners) {
    listener(payload)
  }
}

ipcRenderer.on('terraform:event', forwardTerraformEvent)

const api = {
  detectCli: () => ipcRenderer.invoke('terraform:cli:detect'),
  getCliInfo: () => ipcRenderer.invoke('terraform:cli:info'),
  setCliKind: (kind: 'terraform' | 'opentofu') => ipcRenderer.invoke('terraform:cli:set-kind', kind),
  listProjects: (profileName: string, connection?: AwsConnection) => ipcRenderer.invoke('terraform:projects:list', profileName, connection),
  getProject: (profileName: string, projectId: string, connection?: AwsConnection) => ipcRenderer.invoke('terraform:projects:get', profileName, projectId, connection),
  getDrift: (profileName: string, projectId: string, connection: AwsConnection, options?: { forceRefresh?: boolean }) =>
    ipcRenderer.invoke('terraform:drift:get', profileName, projectId, connection, options),
  getObservabilityReport: (profileName: string, projectId: string, connection: AwsConnection) =>
    ipcRenderer.invoke('terraform:observability-report:get', profileName, projectId, connection),
  detectAdoption: (
    profileName: string,
    connection: AwsConnection | undefined,
    target: TerraformAdoptionTarget
  ): Promise<TerraformAdoptionDetectionResult> =>
    ipcRenderer.invoke('terraform:adoption:detect', profileName, connection, target),
  mapAdoption: (
    profileName: string,
    projectId: string,
    connection: AwsConnection | undefined,
    target: TerraformAdoptionTarget
  ): Promise<TerraformAdoptionMappingResult> =>
    ipcRenderer.invoke('terraform:adoption:map', profileName, projectId, connection, target),
  generateAdoptionCode: (
    profileName: string,
    projectId: string,
    connection: AwsConnection | undefined,
    target: TerraformAdoptionTarget
  ): Promise<TerraformAdoptionCodegenResult> =>
    ipcRenderer.invoke('terraform:adoption:codegen', profileName, projectId, connection, target),
  executeAdoptionImport: (
    profileName: string,
    projectId: string,
    connection: AwsConnection | undefined,
    target: TerraformAdoptionTarget
  ): Promise<TerraformAdoptionImportExecutionResult> =>
    ipcRenderer.invoke('terraform:adoption:execute-import', profileName, projectId, connection, target),
  validateAdoptionImport: (
    profileName: string,
    projectId: string,
    connection: AwsConnection | undefined,
    target: TerraformAdoptionTarget
  ): Promise<TerraformAdoptionValidationResult> =>
    ipcRenderer.invoke('terraform:adoption:validate', profileName, projectId, connection, target),
  chooseProjectDirectory: () => ipcRenderer.invoke('terraform:projects:choose-directory'),
  chooseVarFile: () => ipcRenderer.invoke('terraform:projects:choose-file'),
  addProject: (profileName: string, rootPath: string, connection?: AwsConnection) => ipcRenderer.invoke('terraform:projects:add', profileName, rootPath, connection),
  renameProject: (profileName: string, projectId: string, name: string) => ipcRenderer.invoke('terraform:projects:rename', profileName, projectId, name),
  openProjectInVsCode: (projectPath: string) => ipcRenderer.invoke('terraform:projects:open-vscode', projectPath),
  removeProject: (profileName: string, projectId: string) => ipcRenderer.invoke('terraform:projects:remove', profileName, projectId),
  reloadProject: (profileName: string, projectId: string, connection?: AwsConnection) => ipcRenderer.invoke('terraform:projects:reload', profileName, projectId, connection),
  selectWorkspace: (profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) =>
    ipcRenderer.invoke('terraform:workspace:select', profileName, projectId, workspaceName, connection),
  createWorkspace: (profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) =>
    ipcRenderer.invoke('terraform:workspace:create', profileName, projectId, workspaceName, connection),
  deleteWorkspace: (profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) =>
    ipcRenderer.invoke('terraform:workspace:delete', profileName, projectId, workspaceName, connection),
  getSelectedProjectId: (profileName: string) => ipcRenderer.invoke('terraform:projects:selected:get', profileName),
  setSelectedProjectId: (profileName: string, projectId: string) => ipcRenderer.invoke('terraform:projects:selected:set', profileName, projectId),
  updateInputs: (profileName: string, projectId: string, inputConfig: TerraformInputConfiguration, connection?: AwsConnection) =>
    ipcRenderer.invoke('terraform:inputs:update', profileName, projectId, inputConfig, connection),
  getMissingRequiredInputs: (profileName: string, projectId: string) =>
    ipcRenderer.invoke('terraform:inputs:missing-required', profileName, projectId),
  validateProjectInputs: (profileName: string, projectId: string, connection?: AwsConnection): Promise<TerraformInputValidationResult> =>
    ipcRenderer.invoke('terraform:inputs:validate', profileName, projectId, connection),
  listCommandLogs: (projectId: string) => ipcRenderer.invoke('terraform:logs:list', projectId),
  runCommand: (request: TerraformCommandRequest) => ipcRenderer.invoke('terraform:command:run', request),
  cancelCommand: (projectId: string) => ipcRenderer.invoke('terraform:command:cancel', projectId),
  hasSavedPlan: (projectId: string) => ipcRenderer.invoke('terraform:plan:has-saved', projectId),
  clearSavedPlan: (projectId: string) => ipcRenderer.invoke('terraform:plan:clear', projectId),
  detectMissingVars: (output: string) => ipcRenderer.invoke('terraform:detect-missing-vars', output),
  listRunHistory: (filter?: TerraformRunHistoryFilter) => ipcRenderer.invoke('terraform:history:list', filter),
  getRunOutput: (runId: string) => ipcRenderer.invoke('terraform:history:get-output', runId),
  deleteRunRecord: (runId: string) => ipcRenderer.invoke('terraform:history:delete', runId),
  detectGovernanceTools: (tfCliPath?: string, cliLabel?: string, cliKind?: 'terraform' | 'opentofu' | '') =>
    ipcRenderer.invoke('terraform:governance:detect-tools', tfCliPath, cliLabel, cliKind),
  getGovernanceToolkit: () => ipcRenderer.invoke('terraform:governance:toolkit'),
  runGovernanceChecks: (profileName: string, projectId: string, connection?: AwsConnection) =>
    ipcRenderer.invoke('terraform:governance:run-checks', profileName, projectId, connection),
  getGovernanceReport: (projectId: string) => ipcRenderer.invoke('terraform:governance:get-report', projectId),
  subscribe: (listener: (event: unknown) => void) => {
    terraformListeners.add(listener)
  },
  unsubscribe: (listener: (event: unknown) => void) => {
    terraformListeners.delete(listener)
  }
}

contextBridge.exposeInMainWorld('terraformWorkspace', api)
