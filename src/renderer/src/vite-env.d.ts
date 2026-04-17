/// <reference types="vite/client" />

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
  AwsConnection,
  AzureProviderContextSnapshot,
  CloudProviderId,
  CloudWatchInvestigationHistoryInput,
  BastionLaunchConfig,
  CloudWatchQueryFilter,
  CloudWatchQueryExecutionInput,
  CloudWatchQueryHistoryInput,
  CloudWatchSavedQueryInput,
  EksUpgradePlannerRequest,
  DbConnectionResolveInput,
  DbConnectionPresetFilter,
  DbConnectionPresetInput,
  DbVaultCredentialInput,
  AzureVmAction,
  GcpComputeInstanceAction,
  Ec2BulkInstanceAction,
  Ec2InstanceAction,
  EbsTempInspectionProgress,
  EcsFargateServiceConfig,
  LambdaCreateConfig,
  LoadBalancerLogQuery,
  Route53HostedZoneCreateInput,
  SsmSendCommandRequest,
  SsmStartSessionRequest,
  SnapshotLaunchConfig,
  TerraformAdoptionTarget,
  TerraformInputConfiguration,
  TerraformInputValidationResult,
  TerraformCommandRequest,
  VaultEntryFilter,
  VaultEntryInput,
  VaultEntryUsageInput
} from '@shared/types'

declare global {
  interface Window {
    awsLens: {
      listProfiles: () => Promise<unknown>
      deleteProfile: (profileName: string) => Promise<unknown>
      chooseAndImportConfig: () => Promise<unknown>
      saveCredentials: (profileName: string, accessKeyId: string, secretAccessKey: string) => Promise<unknown>
      listRegions: () => Promise<unknown>
      getSessionHubState: () => Promise<unknown>
      runComparison: (request: ComparisonRequest) => Promise<unknown>
      saveAssumeRoleTarget: (target: Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => Promise<unknown>
      deleteAssumeRoleTarget: (targetId: string) => Promise<unknown>
      deleteAssumedSession: (sessionId: string) => Promise<unknown>
      assumeRoleSession: (request: AssumeRoleRequest) => Promise<unknown>
      refreshAssumedSession: (sessionId: string) => Promise<unknown>
      assumeSavedRoleTarget: (targetId: string) => Promise<unknown>
      getAssumedSessionCredentials: (sessionId: string) => Promise<unknown>
      listProviders: () => Promise<unknown>
      getWorkspaceCatalog: (providerId?: CloudProviderId) => Promise<unknown>
      listServices: (providerId?: CloudProviderId) => Promise<unknown>
      getGovernanceTagDefaults: () => Promise<unknown>
      updateGovernanceTagDefaults: (update: unknown) => Promise<unknown>
      listCloudWatchSavedQueries: (filter?: CloudWatchQueryFilter) => Promise<unknown>
      saveCloudWatchSavedQuery: (input: CloudWatchSavedQueryInput) => Promise<unknown>
      deleteCloudWatchSavedQuery: (id: string) => Promise<unknown>
      listCloudWatchInvestigationHistory: (filter?: CloudWatchQueryFilter) => Promise<unknown>
      recordCloudWatchInvestigationHistory: (input: CloudWatchInvestigationHistoryInput) => Promise<unknown>
      clearCloudWatchInvestigationHistory: (filter?: CloudWatchQueryFilter) => Promise<unknown>
      listCloudWatchQueryHistory: (filter?: CloudWatchQueryFilter) => Promise<unknown>
      recordCloudWatchQueryHistory: (input: CloudWatchQueryHistoryInput) => Promise<unknown>
      clearCloudWatchQueryHistory: (filter?: CloudWatchQueryFilter) => Promise<unknown>
      listDbConnectionPresets: (filter?: DbConnectionPresetFilter) => Promise<unknown>
      saveDbConnectionPreset: (input: DbConnectionPresetInput) => Promise<unknown>
      deleteDbConnectionPreset: (id: string) => Promise<unknown>
      markDbConnectionPresetUsed: (id: string) => Promise<unknown>
      listDbVaultCredentials: () => Promise<unknown>
      saveDbVaultCredential: (input: DbVaultCredentialInput) => Promise<unknown>
      deleteDbVaultCredential: (name: string) => Promise<unknown>
      resolveDbConnectionMaterial: (connection: AwsConnection, input: DbConnectionResolveInput) => Promise<unknown>
      getAwsCapabilitySnapshot: (region: string, subjects?: AwsCapabilitySubject[]) => Promise<unknown>
      listVaultEntries: (filter?: VaultEntryFilter) => Promise<unknown>
      saveVaultEntry: (input: VaultEntryInput) => Promise<unknown>
      deleteVaultEntry: (entryId: string) => Promise<unknown>
      revealVaultEntrySecret: (entryId: string) => Promise<unknown>
      recordVaultEntryUse: (input: VaultEntryUsageInput) => Promise<unknown>
      listComparisonBaselines: () => Promise<unknown>
      listComparisonPresets: () => Promise<unknown>
      getComparisonBaseline: (baselineId: string) => Promise<unknown>
      getComparisonPreset: (presetId: string) => Promise<unknown>
      saveComparisonBaseline: (input: ComparisonBaselineInput) => Promise<unknown>
      saveComparisonPreset: (input: ComparisonPresetInput) => Promise<unknown>
      deleteComparisonBaseline: (baselineId: string) => Promise<unknown>
      deleteComparisonPreset: (presetId: string) => Promise<unknown>
      buildEksUpgradePlan: (connection: AwsConnection, request: EksUpgradePlannerRequest) => Promise<unknown>
      resolveDirectAccessInput: (input: string) => Promise<unknown>
      getReleaseInfo: () => Promise<unknown>
      getAppSettings: () => Promise<unknown>
      updateAppSettings: (update: Partial<AppSettings>) => Promise<unknown>
      resetAppSettings: () => Promise<unknown>
      getAppSecuritySummary: () => Promise<unknown>
      getEnvironmentHealth: () => Promise<unknown>
      getProviderCliStatus: () => Promise<unknown>
      getAzureProviderContext: () => Promise<AzureProviderContextSnapshot>
      startAzureDeviceCodeSignIn: () => Promise<AzureProviderContextSnapshot>
      signOutAzureProvider: () => Promise<AzureProviderContextSnapshot>
      setAzureActiveTenant: (tenantId: string) => Promise<AzureProviderContextSnapshot>
      setAzureActiveSubscription: (subscriptionId: string) => Promise<AzureProviderContextSnapshot>
      setAzureActiveLocation: (location: string) => Promise<AzureProviderContextSnapshot>
      getGcpCliContext: () => Promise<unknown>
      listGcpProjects: () => Promise<unknown>
      getGcpProjectOverview: (projectId: string) => Promise<unknown>
      getGcpIamOverview: (projectId: string) => Promise<unknown>
      addGcpIamBinding: (projectId: string, role: string, member: string) => Promise<unknown>
      removeGcpIamBinding: (projectId: string, role: string, member: string) => Promise<unknown>
      createGcpServiceAccount: (projectId: string, accountId: string, displayName: string, description: string) => Promise<unknown>
      deleteGcpServiceAccount: (projectId: string, email: string) => Promise<unknown>
      disableGcpServiceAccount: (projectId: string, email: string, disable: boolean) => Promise<unknown>
      listGcpServiceAccountKeys: (projectId: string, email: string) => Promise<unknown>
      createGcpServiceAccountKey: (projectId: string, email: string) => Promise<unknown>
      deleteGcpServiceAccountKey: (projectId: string, email: string, keyId: string) => Promise<unknown>
      listGcpRoles: (projectId: string, scope: 'custom' | 'all') => Promise<unknown>
      createGcpCustomRole: (projectId: string, roleId: string, title: string, description: string, permissions: string[]) => Promise<unknown>
      deleteGcpCustomRole: (projectId: string, roleName: string) => Promise<unknown>
      testGcpIamPermissions: (projectId: string, permissions: string[]) => Promise<unknown>
      listGcpComputeInstances: (projectId: string, location: string) => Promise<unknown>
      getGcpComputeInstanceDetail: (projectId: string, zone: string, instanceName: string) => Promise<unknown>
      listGcpComputeMachineTypes: (projectId: string, zone: string) => Promise<unknown>
      runGcpComputeInstanceAction: (projectId: string, zone: string, instanceName: string, action: GcpComputeInstanceAction) => Promise<unknown>
      resizeGcpComputeInstance: (projectId: string, zone: string, instanceName: string, machineType: string) => Promise<unknown>
      updateGcpComputeInstanceLabels: (projectId: string, zone: string, instanceName: string, labels: Record<string, string>) => Promise<unknown>
      deleteGcpComputeInstance: (projectId: string, zone: string, instanceName: string) => Promise<unknown>
      getGcpComputeSerialOutput: (projectId: string, zone: string, instanceName: string, port?: number, start?: number) => Promise<unknown>
      listGcpNetworks: (projectId: string) => Promise<unknown>
      listGcpSubnetworks: (projectId: string, location: string) => Promise<unknown>
      listGcpFirewallRules: (projectId: string) => Promise<unknown>
      listGcpRouters: (projectId: string, location: string) => Promise<unknown>
      listGcpGlobalAddresses: (projectId: string) => Promise<unknown>
      listGcpServiceNetworkingConnections: (projectId: string, networkNames: string[]) => Promise<unknown>
      listGcpDnsManagedZones: (projectId: string) => Promise<unknown>
      listGcpDnsResourceRecordSets: (projectId: string, managedZone: string) => Promise<unknown>
      createGcpDnsResourceRecordSet: (projectId: string, managedZone: string, input: unknown) => Promise<unknown>
      updateGcpDnsResourceRecordSet: (projectId: string, managedZone: string, input: unknown) => Promise<unknown>
      deleteGcpDnsResourceRecordSet: (projectId: string, managedZone: string, name: string, type: string) => Promise<unknown>
      listGcpMemorystoreInstances: (projectId: string, location: string) => Promise<unknown>
      getGcpMemorystoreInstanceDetail: (projectId: string, instanceName: string) => Promise<unknown>
      listGcpUrlMaps: (projectId: string) => Promise<unknown>
      getGcpUrlMapDetail: (projectId: string, urlMapName: string, region?: string) => Promise<unknown>
      listGcpBackendServices: (projectId: string) => Promise<unknown>
      listGcpForwardingRules: (projectId: string) => Promise<unknown>
      listGcpHealthChecks: (projectId: string) => Promise<unknown>
      listGcpSecurityPolicies: (projectId: string) => Promise<unknown>
      getGcpSecurityPolicyDetail: (projectId: string, policyName: string) => Promise<unknown>
      listGcpGkeClusters: (projectId: string, location: string) => Promise<unknown>
      getGcpGkeClusterDetail: (projectId: string, location: string, clusterName: string) => Promise<unknown>
      listGcpGkeNodePools: (projectId: string, location: string, clusterName: string) => Promise<unknown>
      getGcpGkeClusterCredentials: (projectId: string, location: string, clusterName: string, contextName?: string, kubeconfigPath?: string) => Promise<unknown>
      listGcpGkeOperations: (projectId: string, location: string, clusterName: string) => Promise<unknown>
      updateGcpGkeNodePoolScaling: (projectId: string, location: string, clusterName: string, nodePoolName: string, minimum: number, desired: number, maximum: number) => Promise<unknown>
      listGcpStorageBuckets: (projectId: string, location: string) => Promise<unknown>
      listGcpStorageObjects: (projectId: string, bucketName: string, prefix: string) => Promise<unknown>
      getGcpStorageObjectContent: (projectId: string, bucketName: string, key: string) => Promise<unknown>
      putGcpStorageObjectContent: (projectId: string, bucketName: string, key: string, content: string) => Promise<unknown>
      uploadGcpStorageObject: (projectId: string, bucketName: string, key: string, localPath: string) => Promise<unknown>
      downloadGcpStorageObjectToPath: (projectId: string, bucketName: string, key: string) => Promise<unknown>
      deleteGcpStorageObject: (projectId: string, bucketName: string, key: string) => Promise<unknown>
      listGcpLogEntries: (projectId: string, location: string, query: string, windowHours?: number) => Promise<unknown>
      listGcpSqlInstances: (projectId: string, location: string) => Promise<unknown>
      getGcpSqlInstanceDetail: (projectId: string, instanceName: string) => Promise<unknown>
      listGcpSqlDatabases: (projectId: string, instanceName: string) => Promise<unknown>
      listGcpSqlOperations: (projectId: string, instanceName: string) => Promise<unknown>
      getGcpBillingOverview: (projectId: string, catalogProjectIds: string[]) => Promise<unknown>
      listGcpPubSubTopics: (projectId: string) => Promise<unknown>
      listGcpPubSubSubscriptions: (projectId: string) => Promise<unknown>
      getGcpPubSubTopicDetail: (projectId: string, topicId: string) => Promise<unknown>
      getGcpPubSubSubscriptionDetail: (projectId: string, subscriptionId: string) => Promise<unknown>
      listGcpBigQueryDatasets: (projectId: string) => Promise<unknown>
      listGcpBigQueryTables: (projectId: string, datasetId: string) => Promise<unknown>
      getGcpBigQueryTableDetail: (projectId: string, datasetId: string, tableId: string) => Promise<unknown>
      runGcpBigQueryQuery: (projectId: string, queryText: string, maxResults?: number) => Promise<unknown>
      listGcpMonitoringAlertPolicies: (projectId: string) => Promise<unknown>
      listGcpMonitoringUptimeChecks: (projectId: string) => Promise<unknown>
      listGcpMonitoringMetricDescriptors: (projectId: string, filter?: string) => Promise<unknown>
      queryGcpMonitoringTimeSeries: (projectId: string, metricType: string, intervalMinutes: number) => Promise<unknown>
      listGcpSccFindings: (projectId: string, location?: string, filter?: string) => Promise<unknown>
      listGcpSccSources: (projectId: string, location?: string) => Promise<unknown>
      getGcpSccFindingDetail: (projectId: string, findingName: string, location?: string) => Promise<unknown>
      getGcpSccSeverityBreakdown: (projectId: string, location?: string) => Promise<unknown>
      getGcpSccPostureReport: (projectId: string, location?: string) => Promise<unknown>
      listGcpFirestoreDatabases: (projectId: string) => Promise<unknown>
      listGcpFirestoreCollections: (projectId: string, databaseId: string, parentPath?: string) => Promise<unknown>
      listGcpFirestoreDocuments: (projectId: string, databaseId: string, collectionId: string, pageSize?: number) => Promise<unknown>
      getGcpFirestoreDocumentDetail: (projectId: string, databaseId: string, documentPath: string) => Promise<unknown>
      listGcpCloudRunServices: (projectId: string, location: string) => Promise<unknown>
      listGcpCloudRunRevisions: (projectId: string, location: string, serviceId: string) => Promise<unknown>
      listGcpCloudRunJobs: (projectId: string, location: string) => Promise<unknown>
      listGcpCloudRunExecutions: (projectId: string, location: string, jobId: string) => Promise<unknown>
      listGcpCloudRunDomainMappings: (projectId: string, location: string) => Promise<unknown>
      getGcpFirebaseProject: (projectId: string) => Promise<unknown>
      listGcpFirebaseWebApps: (projectId: string) => Promise<unknown>
      listGcpFirebaseAndroidApps: (projectId: string) => Promise<unknown>
      listGcpFirebaseIosApps: (projectId: string) => Promise<unknown>
      listGcpFirebaseHostingSites: (projectId: string) => Promise<unknown>
      listGcpFirebaseHostingReleases: (projectId: string, siteId: string) => Promise<unknown>
      listGcpFirebaseHostingDomains: (projectId: string, siteId: string) => Promise<unknown>
      listGcpFirebaseHostingChannels: (projectId: string, siteId: string) => Promise<unknown>
      listAzureSubscriptions: () => Promise<unknown>
      listAzureResourceGroups: (subscriptionId: string) => Promise<unknown>
      listAzureResourceGroupResources: (subscriptionId: string, resourceGroupName: string) => Promise<unknown>
      getAzureRbacOverview: (subscriptionId: string) => Promise<unknown>
      listAzureRoleAssignments: (subscriptionId: string) => Promise<unknown>
      listAzureRoleDefinitions: (subscriptionId: string) => Promise<unknown>
      createAzureRoleAssignment: (subscriptionId: string, principalId: string, roleDefinitionId: string, scope: string) => Promise<unknown>
      deleteAzureRoleAssignment: (assignmentId: string) => Promise<unknown>
      getAzureDefenderSecureScore: (subscriptionId: string) => Promise<unknown>
      listAzureDefenderSecureScoreControls: (subscriptionId: string) => Promise<unknown>
      listAzureDefenderRecommendations: (subscriptionId: string) => Promise<unknown>
      listAzureDefenderAlerts: (subscriptionId: string) => Promise<unknown>
      listAzureDefenderComplianceStandards: (subscriptionId: string) => Promise<unknown>
      listAzureDefenderAttackPaths: (subscriptionId: string) => Promise<unknown>
      getAzureDefenderReport: (subscriptionId: string) => Promise<unknown>
      listAzureVirtualMachines: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureVirtualMachine: (subscriptionId: string, resourceGroup: string, vmName: string) => Promise<unknown>
      runAzureVmAction: (subscriptionId: string, resourceGroup: string, vmName: string, action: AzureVmAction) => Promise<unknown>
      listAzureAksClusters: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureAksCluster: (subscriptionId: string, resourceGroup: string, clusterName: string) => Promise<unknown>
      listAzureAksNodePools: (subscriptionId: string, resourceGroup: string, clusterName: string) => Promise<unknown>
      updateAzureAksNodePoolScaling: (subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, min: number, desired: number, max: number) => Promise<unknown>
      toggleAzureAksNodePoolAutoscaling: (subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, enable: boolean, minCount?: number, maxCount?: number) => Promise<unknown>
      addAksToKubeconfig: (subscriptionId: string, resourceGroup: string, clusterName: string, contextName: string, kubeconfigPath: string) => Promise<unknown>
      chooseAksKubeconfigPath: (currentPath?: string) => Promise<unknown>
      listAzureStorageAccounts: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureStorageContainers: (subscriptionId: string, resourceGroup: string, accountName: string, blobEndpoint?: string) => Promise<unknown>
      listAzureStorageBlobs: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, prefix: string, blobEndpoint?: string) => Promise<unknown>
      getAzureStorageBlobContent: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) => Promise<unknown>
      putAzureStorageBlobContent: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, content: string, blobEndpoint?: string) => Promise<unknown>
      uploadAzureStorageBlob: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, localPath: string, blobEndpoint?: string) => Promise<unknown>
      downloadAzureStorageBlobToPath: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) => Promise<unknown>
      deleteAzureStorageBlob: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) => Promise<unknown>
      createAzureStorageContainer: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, blobEndpoint?: string) => Promise<unknown>
      openAzureStorageBlob: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) => Promise<unknown>
      openAzureStorageBlobInVSCode: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) => Promise<unknown>
      getAzureStorageBlobSasUrl: (subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint?: string) => Promise<unknown>
      getAzureSqlEstate: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureSqlServer: (subscriptionId: string, resourceGroup: string, serverName: string) => Promise<unknown>
      getAzurePostgreSqlEstate: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzurePostgreSqlServer: (subscriptionId: string, resourceGroup: string, serverName: string) => Promise<unknown>
      getAzureMySqlEstate: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureMySqlServer: (subscriptionId: string, resourceGroup: string, serverName: string) => Promise<unknown>
      getAzureCosmosDbEstate: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureCosmosDbAccount: (subscriptionId: string, resourceGroup: string, accountName: string) => Promise<unknown>
      listAzureMonitorActivity: (subscriptionId: string, location: string, query: string, windowHours?: number) => Promise<unknown>
      getAzureCostOverview: (subscriptionId: string) => Promise<unknown>
      getAzureNetworkOverview: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureVNetSubnets: (subscriptionId: string, resourceGroup: string, vnetName: string) => Promise<unknown>
      listAzureNsgRules: (subscriptionId: string, resourceGroup: string, nsgName: string) => Promise<unknown>
      listAzureVmss: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureVmssInstances: (subscriptionId: string, resourceGroup: string, vmssName: string) => Promise<unknown>
      updateAzureVmssCapacity: (subscriptionId: string, resourceGroup: string, vmssName: string, capacity: number) => Promise<unknown>
      runAzureVmssInstanceAction: (subscriptionId: string, resourceGroup: string, vmssName: string, instanceId: string, action: string) => Promise<unknown>
      listAzureEventGridTopics: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureEventGridSystemTopics: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureEventGridEventSubscriptions: (subscriptionId: string) => Promise<unknown>
      listAzureEventGridDomains: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureEventGridDomainTopics: (subscriptionId: string, resourceGroup: string, domainName: string) => Promise<unknown>
      listAzureAppInsightsComponents: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureKeyVaults: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureKeyVault: (subscriptionId: string, resourceGroup: string, vaultName: string) => Promise<unknown>
      listAzureKeyVaultSecrets: (subscriptionId: string, resourceGroup: string, vaultName: string) => Promise<unknown>
      listAzureKeyVaultKeys: (subscriptionId: string, resourceGroup: string, vaultName: string) => Promise<unknown>
      listAzureEventHubNamespaces: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureEventHubs: (subscriptionId: string, resourceGroup: string, namespaceName: string) => Promise<unknown>
      listAzureEventHubConsumerGroups: (subscriptionId: string, resourceGroup: string, namespaceName: string, eventHubName: string) => Promise<unknown>
      listAzureAppServicePlans: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureWebApps: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureWebApp: (subscriptionId: string, resourceGroup: string, siteName: string) => Promise<unknown>
      listAzureWebAppSlots: (subscriptionId: string, resourceGroup: string, siteName: string) => Promise<unknown>
      listAzureWebAppDeployments: (subscriptionId: string, resourceGroup: string, siteName: string) => Promise<unknown>
      listAzureManagedDisks: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureDiskSnapshots: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureVNetPeerings: (subscriptionId: string, resourceGroup: string, vnetName: string) => Promise<unknown>
      listAzureRouteTables: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureNatGateways: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureLoadBalancers: (subscriptionId: string, location: string) => Promise<unknown>
      listAzurePrivateEndpoints: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureFirewalls: (subscriptionId: string, location: string) => Promise<unknown>
      describeAzureFirewall: (subscriptionId: string, resourceGroup: string, firewallName: string) => Promise<unknown>
      describeAzureLoadBalancer: (subscriptionId: string, resourceGroup: string, lbName: string) => Promise<unknown>
      queryLoadBalancerLogs: (connection: AwsConnection | undefined, query: LoadBalancerLogQuery, providerContext?: { gcpProjectId?: string; azureWorkspaceId?: string }) => Promise<unknown>
      getAlbAccessLogConfig: (connection: AwsConnection, loadBalancerArn: string) => Promise<unknown>
      listAzureDnsZones: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureDnsRecordSets: (subscriptionId: string, resourceGroup: string, zoneName: string) => Promise<unknown>
      upsertAzureDnsRecord: (subscriptionId: string, resourceGroup: string, zoneName: string, input: unknown) => Promise<unknown>
      deleteAzureDnsRecord: (subscriptionId: string, resourceGroup: string, zoneName: string, recordType: string, recordName: string) => Promise<unknown>
      createAzureDnsZone: (subscriptionId: string, resourceGroup: string, zoneName: string, zoneType: string) => Promise<unknown>
      listAzureStorageFileShares: (subscriptionId: string, resourceGroup: string, accountName: string) => Promise<unknown>
      listAzureStorageQueues: (subscriptionId: string, resourceGroup: string, accountName: string) => Promise<unknown>
      listAzureStorageTables: (subscriptionId: string, resourceGroup: string, accountName: string) => Promise<unknown>
      listAzureFunctionApps: (subscriptionId: string, location: string) => Promise<unknown>
      listAzureFunctions: (subscriptionId: string, resourceGroup: string, siteName: string) => Promise<unknown>
      getAzureWebAppConfiguration: (subscriptionId: string, resourceGroup: string, siteName: string) => Promise<unknown>
      runAzureWebAppAction: (subscriptionId: string, resourceGroup: string, siteName: string, action: string) => Promise<unknown>
      listAzureLogAnalyticsWorkspaces: (subscriptionId: string, location: string) => Promise<unknown>
      queryAzureLogAnalytics: (workspaceId: string, query: string, timespan?: string) => Promise<unknown>
      listAzureLogAnalyticsSavedSearches: (subscriptionId: string, resourceGroup: string, workspaceName: string) => Promise<unknown>
      listAzureLogAnalyticsLinkedServices: (subscriptionId: string, resourceGroup: string, workspaceName: string) => Promise<unknown>
      checkForAppUpdates: () => Promise<unknown>
      downloadAppUpdate: () => Promise<unknown>
      installAppUpdate: () => Promise<unknown>
      setAppDiagnosticsActiveContext: (snapshot: AppDiagnosticsSnapshot) => Promise<unknown>
      recordAppDiagnosticsFailure: (input: AppDiagnosticsFailureInput) => Promise<unknown>
      exportDiagnosticsBundle: (snapshot?: AppDiagnosticsSnapshot) => Promise<unknown>
      getCallerIdentity: (connection: AwsConnection) => Promise<unknown>
      listEc2Instances: (connection: AwsConnection) => Promise<unknown>
      listEbsVolumes: (connection: AwsConnection) => Promise<unknown>
      describeEc2Instance: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      describeEbsVolume: (connection: AwsConnection, volumeId: string) => Promise<unknown>
      tagEbsVolume: (connection: AwsConnection, volumeId: string, tags: Record<string, string>) => Promise<unknown>
      untagEbsVolume: (connection: AwsConnection, volumeId: string, tagKeys: string[]) => Promise<unknown>
      attachEbsVolume: (connection: AwsConnection, volumeId: string, request: unknown) => Promise<unknown>
      detachEbsVolume: (connection: AwsConnection, volumeId: string, request?: unknown) => Promise<unknown>
      deleteEbsVolume: (connection: AwsConnection, volumeId: string) => Promise<unknown>
      modifyEbsVolume: (connection: AwsConnection, volumeId: string, request: unknown) => Promise<unknown>
      runEc2InstanceAction: (connection: AwsConnection, instanceId: string, action: Ec2InstanceAction) => Promise<unknown>
      runEc2BulkInstanceAction: (connection: AwsConnection, instanceIds: string[], action: Ec2BulkInstanceAction) => Promise<unknown>
      terminateEc2Instance: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      terminateEc2Instances: (connection: AwsConnection, instanceIds: string[]) => Promise<unknown>
      resizeEc2Instance: (connection: AwsConnection, instanceId: string, instanceType: string) => Promise<unknown>
      listInstanceTypes: (connection: AwsConnection, architecture?: string, currentGenerationOnly?: boolean) => Promise<unknown>
      listEc2Snapshots: (connection: AwsConnection) => Promise<unknown>
      createEc2Snapshot: (connection: AwsConnection, volumeId: string, description: string) => Promise<unknown>
      deleteEc2Snapshot: (connection: AwsConnection, snapshotId: string) => Promise<unknown>
      tagEc2Snapshot: (connection: AwsConnection, snapshotId: string, tags: Record<string, string>) => Promise<unknown>
      getIamAssociation: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      attachIamProfile: (connection: AwsConnection, instanceId: string, profileName: string) => Promise<unknown>
      replaceIamProfile: (connection: AwsConnection, associationId: string, profileName: string) => Promise<unknown>
      removeIamProfile: (connection: AwsConnection, associationId: string) => Promise<unknown>
      launchBastion: (connection: AwsConnection, config: BastionLaunchConfig) => Promise<unknown>
      findBastionConnectionsForInstance: (connection: AwsConnection, targetInstanceId: string) => Promise<unknown>
      deleteBastion: (connection: AwsConnection, targetInstanceId: string) => Promise<unknown>
      createTempVolumeCheck: (connection: AwsConnection, volumeId: string) => Promise<unknown>
      deleteTempVolumeCheck: (connection: AwsConnection, tempUuidOrInstanceId: string) => Promise<unknown>
      listBastions: (connection: AwsConnection) => Promise<unknown>
      listPopularBastionAmis: (connection: AwsConnection, architecture?: string) => Promise<unknown>
      describeVpc: (connection: AwsConnection, vpcId: string) => Promise<unknown>
      launchFromSnapshot: (connection: AwsConnection, config: SnapshotLaunchConfig) => Promise<unknown>
      sendSshPublicKey: (connection: AwsConnection, instanceId: string, osUser: string, publicKey: string, az: string) => Promise<unknown>
      getEc2Recommendations: (connection: AwsConnection) => Promise<unknown>
      listSsmManagedInstances: (connection: AwsConnection) => Promise<unknown>
      getSsmConnectionTarget: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      listSsmSessions: (connection: AwsConnection, targetInstanceId?: string) => Promise<unknown>
      startSsmSession: (connection: AwsConnection, request: SsmStartSessionRequest) => Promise<unknown>
      sendSsmCommand: (connection: AwsConnection, request: SsmSendCommandRequest) => Promise<unknown>
      listLoadBalancerWorkspaces: (connection: AwsConnection) => Promise<unknown>
      deleteLoadBalancer: (connection: AwsConnection, loadBalancerArn: string) => Promise<unknown>
      listCloudWatchMetrics: (connection: AwsConnection) => Promise<unknown>
      getEc2MetricSeries: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      listCloudWatchLogGroups: (connection: AwsConnection) => Promise<unknown>
      listCloudWatchRecentEvents: (connection: AwsConnection, logGroupName: string, periodHours?: number) => Promise<unknown>
      listEc2InstanceMetrics: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      getMetricStatistics: (connection: AwsConnection, metrics: unknown[], periodHours: number) => Promise<unknown>
      getEc2AllMetricSeries: (connection: AwsConnection, instanceId: string, periodHours: number) => Promise<unknown>
      runCloudWatchQuery: (connection: AwsConnection, input: CloudWatchQueryExecutionInput) => Promise<unknown>
      listRoute53HostedZones: (connection: AwsConnection) => Promise<unknown>
      createRoute53HostedZone: (connection: AwsConnection, input: Route53HostedZoneCreateInput) => Promise<unknown>
      listRoute53Records: (connection: AwsConnection, hostedZoneId: string) => Promise<unknown>
      upsertRoute53Record: (connection: AwsConnection, hostedZoneId: string, record: unknown) => Promise<unknown>
      deleteRoute53Record: (connection: AwsConnection, hostedZoneId: string, record: unknown) => Promise<unknown>
      listTrails: (connection: AwsConnection) => Promise<unknown>
      lookupCloudTrailEvents: (connection: AwsConnection, startTime: string, endTime: string) => Promise<unknown>
      lookupCloudTrailEventsByResource: (connection: AwsConnection, resourceName: string, startTime: string, endTime: string) => Promise<unknown>
      getOverviewMetrics: (connection: AwsConnection, regions: string[]) => Promise<unknown>
      getOverviewStatistics: (connection: AwsConnection) => Promise<unknown>
      getOverviewAccountContext: (connection: AwsConnection) => Promise<unknown>
      getComplianceReport: (connection: AwsConnection) => Promise<unknown>
      getSecurityScoreReport: (connection: AwsConnection, weights?: unknown) => Promise<unknown>
      recordSecuritySnapshot: (input: unknown) => Promise<unknown>
      listSecuritySnapshots: (scope: string, range: string) => Promise<unknown>
      buildSecurityTrendReport: (scope: string, range: string) => Promise<unknown>
      getSecurityThresholds: () => Promise<unknown>
      updateSecurityThresholds: (update: unknown) => Promise<unknown>
      listSecurityScopes: () => Promise<unknown>
      getGuardDutyReport: (connection: AwsConnection) => Promise<unknown>
      archiveGuardDutyFindings: (connection: AwsConnection, findingIds: string[]) => Promise<unknown>
      unarchiveGuardDutyFindings: (connection: AwsConnection, findingIds: string[]) => Promise<unknown>
      updateComplianceFindingWorkflow: (connection: AwsConnection, findingId: string, update: unknown) => Promise<unknown>
      getRelationshipMap: (connection: AwsConnection) => Promise<unknown>
      searchByTag: (connection: AwsConnection, tagKey: string, tagValue?: string) => Promise<unknown>
      getCostBreakdown: (connection: AwsConnection) => Promise<unknown>
      openExternalUrl: (url: string) => Promise<unknown>
      openPath: (targetPath: string) => Promise<unknown>
      chooseEc2SshKey: () => Promise<unknown>
      listEc2SshKeySuggestions: (preferredKeyName?: string) => Promise<unknown>
      materializeEc2VaultSshKey: (entryId: string) => Promise<unknown>
      getEnterpriseSettings: () => Promise<unknown>
      setEnterpriseAccessMode: (accessMode: 'read-only' | 'operator') => Promise<unknown>
      listEnterpriseAuditEvents: () => Promise<unknown>
      exportEnterpriseAuditEvents: () => Promise<unknown>
      listEksClusters: (connection: AwsConnection) => Promise<unknown>
      describeEksCluster: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      listEksNodegroups: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      updateEksNodegroupScaling: (
        connection: AwsConnection,
        clusterName: string,
        nodegroupName: string,
        min: number,
        desired: number,
        max: number
      ) => Promise<unknown>
      listEksUpdates: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      deleteEksCluster: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      addEksToKubeconfig: (connection: AwsConnection, clusterName: string, contextName: string, kubeconfigPath: string) => Promise<unknown>
      chooseEksKubeconfigPath: (currentPath?: string) => Promise<unknown>
      launchKubectlTerminal: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      prepareEksKubectlSession: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      runEksCommand: (connection: AwsConnection, clusterName: string, kubeconfigPath: string, command: string) => Promise<unknown>
      getEksObservabilityReport: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      listEcsClusters: (connection: AwsConnection) => Promise<unknown>
      listEcsServices: (connection: AwsConnection, clusterArn: string) => Promise<unknown>
      describeEcsService: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      getEcsDiagnostics: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      getEcsObservabilityReport: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      listEcsTasks: (connection: AwsConnection, clusterArn: string, serviceName?: string) => Promise<unknown>
      updateEcsDesiredCount: (connection: AwsConnection, clusterArn: string, serviceName: string, desiredCount: number) => Promise<unknown>
      forceEcsRedeploy: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      stopEcsTask: (connection: AwsConnection, clusterArn: string, taskArn: string, reason?: string) => Promise<unknown>
      deleteEcsService: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      createEcsFargateService: (connection: AwsConnection, config: EcsFargateServiceConfig) => Promise<unknown>
      getEcsContainerLogs: (connection: AwsConnection, logGroup: string, logStream: string, startTime?: number) => Promise<unknown>
      listLambdaFunctions: (connection: AwsConnection) => Promise<unknown>
      getLambdaFunction: (connection: AwsConnection, functionName: string) => Promise<unknown>
      invokeLambdaFunction: (connection: AwsConnection, functionName: string, payload: string) => Promise<unknown>
      getLambdaFunctionCode: (connection: AwsConnection, functionName: string) => Promise<unknown>
      createLambdaFunction: (connection: AwsConnection, config: LambdaCreateConfig) => Promise<unknown>
      deleteLambdaFunction: (connection: AwsConnection, functionName: string) => Promise<unknown>
      listAutoScalingGroups: (connection: AwsConnection) => Promise<unknown>
      listAutoScalingInstances: (connection: AwsConnection, groupName: string) => Promise<unknown>
      updateAutoScalingCapacity: (connection: AwsConnection, groupName: string, minimum: number, desired: number, maximum: number) => Promise<unknown>
      startAutoScalingRefresh: (connection: AwsConnection, groupName: string) => Promise<unknown>
      deleteAutoScalingGroup: (connection: AwsConnection, groupName: string, forceDelete?: boolean) => Promise<unknown>
      listS3Buckets: (connection: AwsConnection) => Promise<unknown>
      listS3Governance: (connection: AwsConnection) => Promise<unknown>
      getS3GovernanceDetail: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      listS3Objects: (connection: AwsConnection, bucketName: string, prefix: string) => Promise<unknown>
      createS3Bucket: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      deleteS3Object: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      getS3PresignedUrl: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      createS3Folder: (connection: AwsConnection, bucketName: string, folderKey: string) => Promise<unknown>
      downloadS3Object: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      downloadS3ObjectTo: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      openS3Object: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      openS3InVSCode: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      getS3ObjectContent: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      putS3ObjectContent: (connection: AwsConnection, bucketName: string, key: string, content: string, contentType?: string) => Promise<unknown>
      uploadS3Object: (connection: AwsConnection, bucketName: string, key: string, localPath: string) => Promise<unknown>
      enableS3BucketVersioning: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      enableS3BucketEncryption: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      putS3BucketPolicy: (connection: AwsConnection, bucketName: string, policyJson: string) => Promise<unknown>
      listRdsInstances: (connection: AwsConnection) => Promise<unknown>
      listRdsClusters: (connection: AwsConnection) => Promise<unknown>
      describeRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) => Promise<unknown>
      describeRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      startRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) => Promise<unknown>
      stopRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) => Promise<unknown>
      rebootRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string, forceFailover?: boolean) => Promise<unknown>
      resizeRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string, dbInstanceClass: string) => Promise<unknown>
      createRdsSnapshot: (connection: AwsConnection, dbInstanceIdentifier: string, dbSnapshotIdentifier: string) => Promise<unknown>
      startRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      stopRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      failoverRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      createRdsClusterSnapshot: (connection: AwsConnection, dbClusterIdentifier: string, dbClusterSnapshotIdentifier: string) => Promise<unknown>
      listCloudFormationStacks: (connection: AwsConnection) => Promise<unknown>
      listCloudFormationStackResources: (connection: AwsConnection, stackName: string) => Promise<unknown>
      listCloudFormationChangeSets: (connection: AwsConnection, stackName: string) => Promise<unknown>
      createCloudFormationChangeSet: (connection: AwsConnection, input: unknown) => Promise<unknown>
      getCloudFormationChangeSetDetail: (connection: AwsConnection, stackName: string, changeSetName: string) => Promise<unknown>
      executeCloudFormationChangeSet: (connection: AwsConnection, stackName: string, changeSetName: string) => Promise<unknown>
      deleteCloudFormationChangeSet: (connection: AwsConnection, stackName: string, changeSetName: string) => Promise<unknown>
      getCloudFormationDriftSummary: (connection: AwsConnection, stackName: string) => Promise<unknown>
      startCloudFormationDriftDetection: (connection: AwsConnection, stackName: string) => Promise<unknown>
      getCloudFormationDriftDetectionStatus: (connection: AwsConnection, stackName: string, driftDetectionId: string) => Promise<unknown>
      listVpcs: (connection: AwsConnection) => Promise<unknown>
      listSubnets: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listRouteTables: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listInternetGateways: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listNatGateways: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listTransitGateways: (connection: AwsConnection) => Promise<unknown>
      listNetworkInterfaces: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listSecurityGroupsForVpc: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      getVpcTopology: (connection: AwsConnection, vpcId: string) => Promise<unknown>
      getVpcFlowDiagram: (connection: AwsConnection, vpcId: string) => Promise<unknown>
      updateSubnetPublicIp: (connection: AwsConnection, subnetId: string, mapPublic: boolean) => Promise<unknown>
      createReachabilityPath: (connection: AwsConnection, sourceId: string, destId: string, protocol: string) => Promise<unknown>
      getReachabilityAnalysis: (connection: AwsConnection, analysisId: string) => Promise<unknown>
      deleteReachabilityPath: (connection: AwsConnection, pathId: string) => Promise<unknown>
      deleteReachabilityAnalysis: (connection: AwsConnection, analysisId: string) => Promise<unknown>
      listSecurityGroups: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      describeSecurityGroup: (connection: AwsConnection, groupId: string) => Promise<unknown>
      addInboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      revokeInboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      addOutboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      revokeOutboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      listEcrRepositories: (connection: AwsConnection) => Promise<unknown>
      listEcrImages: (connection: AwsConnection, repositoryName: string) => Promise<unknown>
      createEcrRepository: (connection: AwsConnection, repositoryName: string, imageTagMutability: string, scanOnPush: boolean) => Promise<unknown>
      deleteEcrRepository: (connection: AwsConnection, repositoryName: string, force: boolean) => Promise<unknown>
      deleteEcrImage: (connection: AwsConnection, repositoryName: string, imageDigest: string) => Promise<unknown>
      startEcrImageScan: (connection: AwsConnection, repositoryName: string, imageDigest: string, imageTag?: string) => Promise<unknown>
      getEcrScanFindings: (connection: AwsConnection, repositoryName: string, imageDigest: string) => Promise<unknown>
      getEcrAuthorizationToken: (connection: AwsConnection) => Promise<unknown>
      ecrDockerLogin: (connection: AwsConnection) => Promise<unknown>
      ecrDockerPull: (repositoryUri: string, tag: string) => Promise<unknown>
      ecrDockerPush: (localImage: string, repositoryUri: string, tag: string) => Promise<unknown>
      listSnsTopics: (connection: AwsConnection) => Promise<unknown>
      getSnsTopic: (connection: AwsConnection, topicArn: string) => Promise<unknown>
      createSnsTopic: (connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) => Promise<unknown>
      deleteSnsTopic: (connection: AwsConnection, topicArn: string) => Promise<unknown>
      setSnsTopicAttribute: (connection: AwsConnection, topicArn: string, attrName: string, attrValue: string) => Promise<unknown>
      listSnsSubscriptions: (connection: AwsConnection, topicArn: string) => Promise<unknown>
      snsSubscribe: (connection: AwsConnection, topicArn: string, protocol: string, endpoint: string) => Promise<unknown>
      snsUnsubscribe: (connection: AwsConnection, subscriptionArn: string) => Promise<unknown>
      snsPublish: (connection: AwsConnection, topicArn: string, message: string, subject?: string, groupId?: string, dedupId?: string) => Promise<unknown>
      tagSnsTopic: (connection: AwsConnection, topicArn: string, tags: Record<string, string>) => Promise<unknown>
      untagSnsTopic: (connection: AwsConnection, topicArn: string, tagKeys: string[]) => Promise<unknown>
      listSqsQueues: (connection: AwsConnection) => Promise<unknown>
      getSqsQueue: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      createSqsQueue: (connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) => Promise<unknown>
      deleteSqsQueue: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      purgeSqsQueue: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      setSqsAttributes: (connection: AwsConnection, queueUrl: string, attrs: Record<string, string>) => Promise<unknown>
      sqsSendMessage: (connection: AwsConnection, queueUrl: string, body: string, delay?: number, groupId?: string, dedupId?: string) => Promise<unknown>
      sqsReceiveMessages: (connection: AwsConnection, queueUrl: string, max: number, wait: number) => Promise<unknown>
      sqsDeleteMessage: (connection: AwsConnection, queueUrl: string, receiptHandle: string) => Promise<unknown>
      sqsChangeVisibility: (connection: AwsConnection, queueUrl: string, receiptHandle: string, timeout: number) => Promise<unknown>
      tagSqsQueue: (connection: AwsConnection, queueUrl: string, tags: Record<string, string>) => Promise<unknown>
      untagSqsQueue: (connection: AwsConnection, queueUrl: string, tagKeys: string[]) => Promise<unknown>
      sqsTimeline: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      listSsoInstances: (connection: AwsConnection) => Promise<unknown>
      createSsoInstance: (connection: AwsConnection, name: string) => Promise<unknown>
      deleteSsoInstance: (connection: AwsConnection, instanceArn: string) => Promise<unknown>
      listSsoPermissionSets: (connection: AwsConnection, instanceArn: string) => Promise<unknown>
      listSsoUsers: (connection: AwsConnection, identityStoreId: string) => Promise<unknown>
      listSsoGroups: (connection: AwsConnection, identityStoreId: string) => Promise<unknown>
      listSsoAccountAssignments: (connection: AwsConnection, instanceArn: string, accountId: string, permissionSetArn: string) => Promise<unknown>
      simulateSsoPermissions: (connection: AwsConnection, instanceArn: string, permissionSetArn: string) => Promise<unknown>
      listAcmCertificates: (connection: AwsConnection) => Promise<unknown>
      describeAcmCertificate: (connection: AwsConnection, certificateArn: string) => Promise<unknown>
      requestAcmCertificate: (connection: AwsConnection, input: unknown) => Promise<unknown>
      deleteAcmCertificate: (connection: AwsConnection, certificateArn: string) => Promise<unknown>
      listSecrets: (connection: AwsConnection) => Promise<unknown>
      describeSecret: (connection: AwsConnection, secretId: string) => Promise<unknown>
      getSecretDependencyReport: (connection: AwsConnection, secretId: string) => Promise<unknown>
      getSecretValue: (connection: AwsConnection, secretId: string, versionId?: string) => Promise<unknown>
      createSecret: (connection: AwsConnection, input: unknown) => Promise<unknown>
      deleteSecret: (connection: AwsConnection, secretId: string, forceDeleteWithoutRecovery: boolean) => Promise<unknown>
      restoreSecret: (connection: AwsConnection, secretId: string) => Promise<unknown>
      updateSecretValue: (connection: AwsConnection, secretId: string, secretString: string) => Promise<unknown>
      updateSecretDescription: (connection: AwsConnection, secretId: string, description: string) => Promise<unknown>
      rotateSecret: (connection: AwsConnection, secretId: string) => Promise<unknown>
      putSecretResourcePolicy: (connection: AwsConnection, secretId: string, policy: string) => Promise<unknown>
      tagSecret: (connection: AwsConnection, secretId: string, tags: unknown) => Promise<unknown>
      untagSecret: (connection: AwsConnection, secretId: string, tagKeys: string[]) => Promise<unknown>
      listKeyPairs: (connection: AwsConnection) => Promise<unknown>
      createKeyPair: (connection: AwsConnection, keyName: string) => Promise<unknown>
      deleteKeyPair: (connection: AwsConnection, keyName: string) => Promise<unknown>
      decodeAuthorizationMessage: (connection: AwsConnection, encodedMessage: string) => Promise<unknown>
      lookupAccessKeyOwnership: (connection: AwsConnection, accessKeyId: string) => Promise<unknown>
      assumeRole: (connection: AwsConnection, roleArn: string, sessionName: string, externalId?: string) => Promise<unknown>
      listKmsKeys: (connection: AwsConnection) => Promise<unknown>
      describeKmsKey: (connection: AwsConnection, keyId: string) => Promise<unknown>
      decryptCiphertext: (connection: AwsConnection, ciphertext: string) => Promise<unknown>
      listWebAcls: (connection: AwsConnection, scope: string) => Promise<unknown>
      describeWebAcl: (connection: AwsConnection, scope: string, id: string, name: string) => Promise<unknown>
      createWebAcl: (connection: AwsConnection, input: unknown) => Promise<unknown>
      deleteWebAcl: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string) => Promise<unknown>
      addWafRule: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string, input: unknown) => Promise<unknown>
      updateWafRulesJson: (
        connection: AwsConnection,
        scope: string,
        id: string,
        name: string,
        lockToken: string,
        defaultAction: string,
        description: string,
        rulesJson: string
      ) => Promise<unknown>
      deleteWafRule: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string, ruleName: string) => Promise<unknown>
      associateWebAcl: (connection: AwsConnection, resourceArn: string, webAclArn: string) => Promise<unknown>
      disassociateWebAcl: (connection: AwsConnection, resourceArn: string) => Promise<unknown>
      openAwsTerminal: (sessionId: string, connection: AwsConnection, initialCommand?: string) => Promise<unknown>
      updateAwsTerminalContext: (sessionId: string, connection: AwsConnection) => Promise<unknown>
      openProviderTerminal: (
        sessionId: string,
        target: { providerId: 'gcp' | 'azure'; label: string; modeId: string; modeLabel: string; env: Record<string, string> },
        initialCommand?: string
      ) => Promise<unknown>
      updateProviderTerminalContext: (
        sessionId: string,
        target: { providerId: 'gcp' | 'azure'; label: string; modeId: string; modeLabel: string; env: Record<string, string> }
      ) => Promise<unknown>
      sendTerminalInput: (sessionId: string, input: string) => Promise<unknown>
      runTerminalCommand: (sessionId: string, command: string) => Promise<unknown>
      resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<unknown>
      closeTerminal: (sessionId?: string) => Promise<unknown>
      subscribeTerminal: (listener: (event: unknown) => void) => void
      unsubscribeTerminal: (listener: (event: unknown) => void) => void
      subscribeTempVolumeProgress: (listener: (event: EbsTempInspectionProgress) => void) => void
      unsubscribeTempVolumeProgress: (listener: (event: EbsTempInspectionProgress) => void) => void
      listIamUsers: (c: AwsConnection) => Promise<unknown>
      listIamGroups: (c: AwsConnection) => Promise<unknown>
      listIamRoles: (c: AwsConnection) => Promise<unknown>
      listIamPolicies: (c: AwsConnection, scope: string) => Promise<unknown>
      getIamAccountSummary: (c: AwsConnection) => Promise<unknown>
      listIamAccessKeys: (c: AwsConnection, u: string) => Promise<unknown>
      createIamAccessKey: (c: AwsConnection, u: string) => Promise<unknown>
      deleteIamAccessKey: (c: AwsConnection, u: string, k: string) => Promise<unknown>
      updateIamAccessKeyStatus: (c: AwsConnection, u: string, k: string, s: string) => Promise<unknown>
      listIamMfaDevices: (c: AwsConnection, u: string) => Promise<unknown>
      deleteIamMfaDevice: (c: AwsConnection, u: string, sn: string) => Promise<unknown>
      listAttachedIamUserPolicies: (c: AwsConnection, u: string) => Promise<unknown>
      listIamUserInlinePolicies: (c: AwsConnection, u: string) => Promise<unknown>
      attachIamUserPolicy: (c: AwsConnection, u: string, a: string) => Promise<unknown>
      detachIamUserPolicy: (c: AwsConnection, u: string, a: string) => Promise<unknown>
      putIamUserInlinePolicy: (c: AwsConnection, u: string, n: string, d: string) => Promise<unknown>
      deleteIamUserInlinePolicy: (c: AwsConnection, u: string, n: string) => Promise<unknown>
      listIamUserGroups: (c: AwsConnection, u: string) => Promise<unknown>
      addIamUserToGroup: (c: AwsConnection, u: string, g: string) => Promise<unknown>
      removeIamUserFromGroup: (c: AwsConnection, u: string, g: string) => Promise<unknown>
      createIamUser: (c: AwsConnection, u: string) => Promise<unknown>
      deleteIamUser: (c: AwsConnection, u: string) => Promise<unknown>
      createIamLoginProfile: (c: AwsConnection, u: string, pw: string, r: boolean) => Promise<unknown>
      deleteIamLoginProfile: (c: AwsConnection, u: string) => Promise<unknown>
      listAttachedIamRolePolicies: (c: AwsConnection, r: string) => Promise<unknown>
      listIamRoleInlinePolicies: (c: AwsConnection, r: string) => Promise<unknown>
      getIamRoleTrustPolicy: (c: AwsConnection, r: string) => Promise<unknown>
      updateIamRoleTrustPolicy: (c: AwsConnection, r: string, d: string) => Promise<unknown>
      attachIamRolePolicy: (c: AwsConnection, r: string, a: string) => Promise<unknown>
      detachIamRolePolicy: (c: AwsConnection, r: string, a: string) => Promise<unknown>
      putIamRoleInlinePolicy: (c: AwsConnection, r: string, n: string, d: string) => Promise<unknown>
      deleteIamRoleInlinePolicy: (c: AwsConnection, r: string, n: string) => Promise<unknown>
      createIamRole: (c: AwsConnection, r: string, tp: string, desc: string) => Promise<unknown>
      deleteIamRole: (c: AwsConnection, r: string) => Promise<unknown>
      listAttachedIamGroupPolicies: (c: AwsConnection, g: string) => Promise<unknown>
      attachIamGroupPolicy: (c: AwsConnection, g: string, a: string) => Promise<unknown>
      detachIamGroupPolicy: (c: AwsConnection, g: string, a: string) => Promise<unknown>
      createIamGroup: (c: AwsConnection, g: string) => Promise<unknown>
      deleteIamGroup: (c: AwsConnection, g: string) => Promise<unknown>
      getIamPolicyVersion: (c: AwsConnection, a: string, v: string) => Promise<unknown>
      listIamPolicyVersions: (c: AwsConnection, a: string) => Promise<unknown>
      createIamPolicyVersion: (c: AwsConnection, a: string, d: string, s: boolean) => Promise<unknown>
      deleteIamPolicyVersion: (c: AwsConnection, a: string, v: string) => Promise<unknown>
      createIamPolicy: (c: AwsConnection, n: string, d: string, desc: string) => Promise<unknown>
      deleteIamPolicy: (c: AwsConnection, a: string) => Promise<unknown>
      simulateIamPolicy: (c: AwsConnection, a: string, actions: string[], resources: string[]) => Promise<unknown>
      generateIamCredentialReport: (c: AwsConnection) => Promise<unknown>
      getIamCredentialReport: (c: AwsConnection) => Promise<unknown>
    }
    terraformWorkspace: {
      detectCli: () => Promise<unknown>
      getCliInfo: () => Promise<unknown>
      setCliKind: (kind: 'terraform' | 'opentofu') => Promise<unknown>
      listProjects: (profileName: string, connection?: AwsConnection) => Promise<unknown>
      getProject: (profileName: string, projectId: string, connection?: AwsConnection) => Promise<unknown>
      getDrift: (profileName: string, projectId: string, connection: AwsConnection, options?: { forceRefresh?: boolean }) => Promise<unknown>
      getObservabilityReport: (profileName: string, projectId: string, connection: AwsConnection) => Promise<unknown>
      detectAdoption: (profileName: string, connection: AwsConnection | undefined, target: TerraformAdoptionTarget) => Promise<unknown>
      mapAdoption: (
        profileName: string,
        projectId: string,
        connection: AwsConnection | undefined,
        target: TerraformAdoptionTarget
      ) => Promise<unknown>
      generateAdoptionCode: (
        profileName: string,
        projectId: string,
        connection: AwsConnection | undefined,
        target: TerraformAdoptionTarget
      ) => Promise<unknown>
      executeAdoptionImport: (
        profileName: string,
        projectId: string,
        connection: AwsConnection | undefined,
        target: TerraformAdoptionTarget
      ) => Promise<unknown>
      validateAdoptionImport: (
        profileName: string,
        projectId: string,
        connection: AwsConnection | undefined,
        target: TerraformAdoptionTarget
      ) => Promise<unknown>
      chooseProjectDirectory: () => Promise<unknown>
      addProject: (profileName: string, rootPath: string, connection?: AwsConnection) => Promise<unknown>
      renameProject: (profileName: string, projectId: string, name: string) => Promise<unknown>
      removeProject: (profileName: string, projectId: string) => Promise<unknown>
      reloadProject: (profileName: string, projectId: string, connection?: AwsConnection) => Promise<unknown>
      selectWorkspace: (profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) => Promise<unknown>
      createWorkspace: (profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) => Promise<unknown>
      deleteWorkspace: (profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) => Promise<unknown>
      getSelectedProjectId: (profileName: string) => Promise<unknown>
      setSelectedProjectId: (profileName: string, projectId: string) => Promise<unknown>
      updateInputs: (profileName: string, projectId: string, inputConfig: TerraformInputConfiguration, connection?: AwsConnection) => Promise<unknown>
      validateProjectInputs: (profileName: string, projectId: string, connection?: AwsConnection) => Promise<TerraformInputValidationResult>
      listCommandLogs: (projectId: string) => Promise<unknown>
      runCommand: (request: TerraformCommandRequest) => Promise<unknown>
      cancelCommand: (projectId: string) => Promise<unknown>
      subscribe: (listener: (event: unknown) => void) => void
      unsubscribe: (listener: (event: unknown) => void) => void
    }
  }
}

export {}
