import { useEffect, useState } from 'react'

import { BLOCKED_ACTION_EVENT } from '@shared/branding'
import type {
  AwsCapabilitySnapshot,
  AwsCapabilitySubject,
  AppDiagnosticsFailureInput,
  AppDiagnosticsSnapshot,
  AppSettings,
  ComparisonBaseline,
  ComparisonBaselineInput,
  ComparisonBaselineSummary,
  ComparisonPreset,
  ComparisonPresetInput,
  ComparisonPresetSummary,
  ComparisonRequest,
  ComparisonResult,
  AccessKeyOwnership,
  AcmCertificateDetail,
  AcmCertificateSummary,
  AcmRequestCertificateInput,
  AppDiagnosticsExportResult,
  AzureProviderContextSnapshot,
  EnvironmentHealthReport,
  GcpCliContext,
  GcpBillingOverview,
  GcpComputeInstanceAction,
  GcpComputeInstanceDetail,
  GcpComputeMachineTypeOption,
  GcpComputeOperationResult,
  GcpComputeSerialOutput,
  GcpFirewallRuleSummary,
  GcpGlobalAddressSummary,
  GcpIamOverview,
  GcpComputeInstanceSummary,
  GcpNetworkSummary,
  GcpRouterNatSummary,
  GcpRouterSummary,
  GcpServiceNetworkingConnectionSummary,
  GcpServiceAccountSummary,
  GcpServiceAccountKeySummary,
  GcpIamRoleSummary,
  GcpIamTestPermissionsResult,
  GcpGkeClusterCredentials,
  GcpGkeClusterDetail,
  GcpGkeOperationResult,
  GcpGkeOperationSummary,
  GcpGkeClusterSummary,
  GcpGkeNodePoolSummary,
  GcpLogQueryResult,
  GcpProjectOverview,
  GcpSqlDatabaseSummary,
  GcpSqlInstanceDetail,
  GcpSqlInstanceSummary,
  GcpSqlOperationSummary,
  GcpStorageObjectContent,
  GcpStorageObjectSummary,
  GcpStorageBucketSummary,
  GcpSubnetworkSummary,
  GcpCliProject,
  GcpBigQueryDatasetSummary,
  GcpBigQueryTableSummary,
  GcpBigQueryTableDetail,
  GcpBigQueryQueryResult,
  GcpMonitoringAlertPolicySummary,
  GcpMonitoringUptimeCheckSummary,
  GcpMonitoringMetricDescriptorSummary,
  GcpMonitoringTimeSeriesResult,
  GcpSccFindingSummary,
  GcpSccSourceSummary,
  GcpSccFindingDetail,
  GcpSccSeverityBreakdown,
  GcpSccPostureReport,
  GcpFirestoreDatabaseSummary,
  GcpFirestoreCollectionSummary,
  GcpFirestoreDocumentSummary,
  GcpFirestoreDocumentDetail,
  GcpPubSubTopicSummary,
  GcpPubSubSubscriptionSummary,
  GcpPubSubTopicDetail,
  GcpPubSubSubscriptionDetail,
  GcpCloudRunServiceSummary,
  GcpCloudRunRevisionSummary,
  GcpCloudRunJobSummary,
  GcpCloudRunExecutionSummary,
  GcpCloudRunDomainMappingSummary,
  GcpFirebaseProjectSummary,
  GcpFirebaseWebAppSummary,
  GcpFirebaseAndroidAppSummary,
  GcpFirebaseIosAppSummary,
  GcpFirebaseHostingSiteSummary,
  GcpFirebaseHostingReleaseSummary,
  GcpFirebaseHostingDomainSummary,
  GcpFirebaseHostingChannelSummary,
  GcpDnsManagedZoneSummary,
  GcpDnsResourceRecordSetSummary,
  GcpDnsRecordUpsertInput,
  GcpMemorystoreInstanceSummary,
  GcpMemorystoreInstanceDetail,
  GcpUrlMapSummary,
  GcpUrlMapDetail,
  GcpBackendServiceSummary,
  GcpForwardingRuleSummary,
  GcpHealthCheckSummary,
  GcpSecurityPolicySummary,
  GcpSecurityPolicyDetail,
  AppReleaseInfo,
  AppSecuritySummary,
  AzureAksClusterDetail,
  AzureAksClusterSummary,
  AzureAksNodePoolSummary,
  AzureCostOverview,
  AzureMonitorActivityResult,
  AzureRbacOverview,
  AzureRoleAssignmentSummary,
  AzureRoleDefinitionSummary,
  AzureDefenderAlert,
  AzureDefenderComplianceStandard,
  AzureDefenderAttackPath,
  AzureDefenderRecommendation,
  AzureDefenderReport,
  AzureDefenderSecureScore,
  AzureDefenderSecureScoreControl,
  AzureSqlEstateOverview,
  AzureSqlServerDetail,
  AzurePostgreSqlEstateOverview,
  AzurePostgreSqlServerDetail,
  AzureStorageAccountSummary,
  AzureStorageBlobContent,
  AzureResourceGroupResourceSummary,
  AzureResourceGroupSummary,
  AzureStorageBlobSummary,
  AzureStorageContainerSummary,
  AzureSubscriptionSummary,
  AzureVirtualMachineDetail,
  AzureVirtualMachineSummary,
  AzureVmAction,
  AzureVmActionResult,
  AzureNetworkOverview,
  AzureSubnetSummary,
  AzureNsgRuleSummary,
  AzureVmssSummary,
  AzureVmssInstanceSummary,
  AzureVmssActionResult,
  AzureAppInsightsSummary,
  AzureKeyVaultSummary,
  AzureKeyVaultSecretSummary,
  AzureKeyVaultKeySummary,
  AzureEventHubNamespaceSummary,
  AzureEventHubSummary,
  AzureEventHubConsumerGroupSummary,
  AzureAppServicePlanSummary,
  AzureWebAppSummary,
  AzureWebAppSlotSummary,
  AzureWebAppDeploymentSummary,
  AzureManagedDiskSummary,
  AzureDiskSnapshotSummary,
  AzureVNetPeeringSummary,
  AzureRouteTableSummary,
  AzureNatGatewaySummary,
  AzureLoadBalancerSummary,
  AzureLoadBalancerDetail,
  AzurePrivateEndpointSummary,
  AzureFirewallSummary,
  AzureFirewallDetail,
  AzureStorageFileShareSummary,
  AzureStorageQueueSummary,
  AzureStorageTableSummary,
  AzureMySqlEstateOverview,
  AzureMySqlServerDetail,
  AzureCosmosDbEstateOverview,
  AzureCosmosDbAccountDetail,
  AzureFunctionAppSummary,
  AzureFunctionSummary,
  AzureWebAppConfigSummary,
  AzureWebAppAction,
  AzureWebAppActionResult,
  AzureLogAnalyticsWorkspaceSummary,
  AzureLogAnalyticsQueryResult,
  AzureLogAnalyticsSavedSearch,
  AzureLogAnalyticsLinkedService,
  AzureEventGridTopicSummary,
  AzureEventGridSystemTopicSummary,
  AzureEventGridEventSubscriptionSummary,
  AzureEventGridDomainSummary,
  AzureEventGridDomainTopicSummary,
  AzureDnsZoneSummary,
  AzureDnsRecordSummary,
  AzureDnsRecordUpsertInput,
  CloudProviderId,
  CloudWatchInvestigationHistoryEntry,
  CloudWatchInvestigationHistoryInput,
  CloudWatchQueryFilter,
  CloudWatchQueryExecutionInput,
  CloudWatchQueryExecutionResult,
  CloudWatchQueryHistoryEntry,
  CloudWatchQueryHistoryInput,
  CloudWatchSavedQuery,
  CloudWatchSavedQueryInput,
  DirectAccessResolution,
  DbConnectionResolveInput,
  DbConnectionResolutionResult,
  DbConnectionPreset,
  DbConnectionPresetFilter,
  DbConnectionPresetInput,
  DbVaultCredentialInput,
  DbVaultCredentialSummary,
  EksUpgradePlan,
  EksUpgradePlannerRequest,
  GovernanceTagDefaults,
  GovernanceTagDefaultsUpdate,
  AssumeRoleResult,
  AssumeRoleRequest,
  AwsAssumeRoleTarget,
  AwsConnection,
  AwsProfile,
  AwsRegionOption,
  SessionHubState,
  CallerIdentity,
  SsmCommandExecutionResult,
  SsmConnectionTarget,
  SsmManagedInstanceSummary,
  SsmSendCommandRequest,
  SsmSessionLaunchSpec,
  SsmSessionSummary,
  SsmStartSessionRequest,
  ComplianceFindingWorkflow,
  ComplianceFindingWorkflowUpdate,
  ComplianceReport,
  SecurityScoreReport,
  SecurityScoreWeights,
  SecuritySnapshot,
  SecuritySnapshotInput,
  SecurityThresholds,
  SecurityTrendRange,
  SecurityTrendReport,
  GuardDutyReport,
  EnterpriseAccessMode,
  EnterpriseAuditEvent,
  EnterpriseAuditExportResult,
  EnterpriseSettings,
  ProviderCliStatus,
  ProviderDescriptor,
  ServiceDescriptor,
  WorkspaceCatalog,
  CloudWatchLogEventSummary,
  CloudWatchLogGroupSummary,
  CloudWatchMetricSeries,
  CloudWatchMetricStatistic,
  CloudWatchMetricSummary,
  CloudWatchNamespaceSummary,
  CloudFormationChangeSetDetail,
  CloudFormationChangeSetSummary,
  CloudFormationDriftedResourceRow,
  CloudFormationResourceSummary,
  CloudFormationStackDriftSummary,
  CloudFormationStackSummary,
  CloudTrailEventSummary,
  CloudTrailSummary,
  CreatedKeyPair,
  EcrAuthorizationData,
  EcrImageSummary,
  EcrRepositorySummary,
  EcrScanResult,
  EksClusterDetail,
  EksClusterSummary,
  EksNodegroupSummary,
  EksUpdateEvent,
  IamAccessKeySummary,
  IamAccountSummary,
  IamAttachedPolicy,
  IamCredentialReportEntry,
  IamGroupSummary,
  IamInlinePolicy,
  IamMfaDevice,
  IamPolicySummary,
  IamPolicyVersion,
  IamRoleSummary,
  IamSimulationResult,
  IamUserSummary,
  LambdaCodeResult,
  LambdaCreateConfig,
  LambdaFunctionDetail,
  LambdaFunctionSummary,
  LambdaInvokeResult,
  Ec2InstanceDetail,
  Ec2InstanceSummary,
  KeyPairSummary,
  KmsDecryptResult,
  KmsKeyDetail,
  KmsKeySummary,
  AutoScalingGroupSummary,
  AutoScalingInstanceSummary,
  LoadBalancerLogQuery,
  LoadBalancerLogResult,
  LoadBalancerWorkspace,
  RdsClusterDetail,
  RdsClusterSummary,
  RdsInstanceDetail,
  RdsInstanceSummary,
  Route53HostedZoneCreateInput,
  Route53HostedZoneSummary,
  Route53RecordChange,
  Route53RecordSummary,
  ReachabilityPathResult,
  SecretCreateInput,
  SecretDependencyReport,
  SecretTag,
  SecretsManagerSecretDetail,
  SecretsManagerSecretSummary,
  SecretsManagerSecretValue,
  SnsPublishResult,
  SnsSubscriptionSummary,
  SnsTopicSummary,
  SqsMessage,
  SqsQueueSummary,
  SqsSendResult,
  SqsTimelineEvent,
  S3BucketSummary,
  S3BucketGovernanceDetail,
  S3GovernanceOverview,
  S3ObjectContent,
  S3ObjectSummary,
  StsDecodedAuthorizationMessage,
  TerraformCommandLog,
  TerraformCommandRequest,
  TerraformCliInfo,
  TerraformDriftReport,
  TerraformInputConfiguration,
  TerraformProject,
  TerraformProjectListItem,
  TransitGatewaySummary,
  VpcFlowDiagramData,
  VpcSummary,
  SubnetSummary,
  RouteTableSummary,
  InternetGatewaySummary,
  NatGatewaySummary,
  NetworkInterfaceSummary,
  CostBreakdown,
  OverviewAccountContext,
  OverviewMetrics,
  OverviewStatistics,
  ObservabilityPostureReport,
  RelationshipMap,
  TagSearchResult,
  VpcTopology,
  SecurityGroupDetail,
  SecurityGroupSummary,
  WafCreateWebAclInput,
  WafRuleInput,
  WafScope,
  WafWebAclDetail,
  WafWebAclSummary,
  MaterializedVaultEntryHandle,
  VaultEntryFilter,
  VaultEntryInput,
  VaultEntrySummary,
  VaultEntryUsageInput,
  VaultValidationResult,
  SsoAccountAssignment,
  SsoGroupSummary,
  SsoInstanceSummary,
  SsoPermissionSetSummary,
  SsoSimulationResult,
  SsoUserSummary,
  EcsClusterSummary,
  EcsServiceSummary,
  EcsServiceDetail,
  EcsServiceDiagnostics,
  EcsTaskSummary,
  EcsLogEvent
} from '@shared/types'

type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string }

export class AwsLensApiError extends Error {
  rawMessage: string
  title: string

  constructor(message: string, rawMessage: string, title = 'Operation Failed') {
    super(message)
    this.name = 'AwsLensApiError'
    this.rawMessage = rawMessage
    this.title = title
  }
}

type ProjectEvent =
  | { type: 'started'; projectId: string; log: TerraformCommandLog }
  | { type: 'output'; projectId: string; logId: string; chunk: string }
  | { type: 'completed'; projectId: string; log: TerraformCommandLog; project: TerraformProject | null }

export type TerminalEvent =
  | { sessionId: string; type: 'output'; text: string }
  | { sessionId: string; type: 'exit'; code: number | null }

export type AwsTerminalOpenResult = {
  created: boolean
  history: string
}

export type AwsActivityState = {
  pendingCount: number
  lastCompletedAt: number | null
}

export type ProviderTerminalTarget = {
  providerId: Exclude<CloudProviderId, 'aws'>
  label: string
  modeId: string
  modeLabel: string
  env: Record<string, string>
}

type AwsLensBridge = Window['awsLens']
export type CacheTag =
  | 'phase1-foundations'
  | 'phase2-foundations'
  | 'shell'
  | 'compare'
  | 'overview'
  | 'compliance-center'
  | 'security-score'
  | 'guardduty'
  | 'ec2'
  | 'cloudwatch'
  | 's3'
  | 'lambda'
  | 'auto-scaling'
  | 'rds'
  | 'cloudformation'
  | 'cloudtrail'
  | 'ecr'
  | 'eks'
  | 'ecs'
  | 'vpc'
  | 'load-balancers'
  | 'route53'
  | 'security-groups'
  | 'acm'
  | 'iam'
  | 'identity-center'
  | 'sns'
  | 'sqs'
  | 'secrets-manager'
  | 'key-pairs'
  | 'sts'
  | 'kms'
  | 'waf'

type CacheEntry = {
  status: 'pending' | 'resolved'
  value: Promise<unknown> | unknown
  fetchedAt: number | null
  source: 'live' | 'local' | null
}

type CachedQuerySnapshot<T> = {
  value: T | null
  fetchedAt: number | null
  source: 'live' | 'local' | null
}

const awsActivityListeners = new Set<(state: AwsActivityState) => void>()
const enterpriseListeners = new Set<(settings: EnterpriseSettings) => void>()
const awsBridgeCache = new WeakMap<AwsLensBridge, AwsLensBridge>()
const pageCache = new Map<string, CacheEntry>()
// Deduplicates identical concurrent non-cached calls (e.g. rapid double-clicks or
// parallel component mounts calling the same describe/get method with the same args).
const inflightRequests = new Map<string, Promise<unknown>>()
let pageCacheVersion = 0
let awsActivityState: AwsActivityState = {
  pendingCount: 0,
  lastCompletedAt: null
}
let enterpriseSettingsState: EnterpriseSettings = {
  accessMode: 'read-only',
  updatedAt: ''
}

const CACHE_TAG_BY_METHOD: Partial<Record<keyof AwsLensBridge, CacheTag>> = {
  getGovernanceTagDefaults: 'phase1-foundations',
  updateGovernanceTagDefaults: 'phase1-foundations',
  listCloudWatchSavedQueries: 'phase1-foundations',
  saveCloudWatchSavedQuery: 'phase1-foundations',
  deleteCloudWatchSavedQuery: 'phase1-foundations',
  listCloudWatchInvestigationHistory: 'phase1-foundations',
  recordCloudWatchInvestigationHistory: 'phase1-foundations',
  clearCloudWatchInvestigationHistory: 'phase1-foundations',
  listCloudWatchQueryHistory: 'phase1-foundations',
  recordCloudWatchQueryHistory: 'phase1-foundations',
  clearCloudWatchQueryHistory: 'phase1-foundations',
  listDbConnectionPresets: 'phase1-foundations',
  saveDbConnectionPreset: 'phase1-foundations',
  deleteDbConnectionPreset: 'phase1-foundations',
  markDbConnectionPresetUsed: 'phase1-foundations',
  listDbVaultCredentials: 'phase1-foundations',
  saveDbVaultCredential: 'phase1-foundations',
  deleteDbVaultCredential: 'phase1-foundations',
  getAwsCapabilitySnapshot: 'phase1-foundations',
  listVaultEntries: 'phase2-foundations',
  saveVaultEntry: 'phase2-foundations',
  deleteVaultEntry: 'phase2-foundations',
  recordVaultEntryUse: 'phase2-foundations',
  listComparisonBaselines: 'phase2-foundations',
  listComparisonPresets: 'phase2-foundations',
  getComparisonBaseline: 'phase2-foundations',
  getComparisonPreset: 'phase2-foundations',
  saveComparisonBaseline: 'phase2-foundations',
  saveComparisonPreset: 'phase2-foundations',
  deleteComparisonBaseline: 'phase2-foundations',
  deleteComparisonPreset: 'phase2-foundations',
  buildEksUpgradePlan: 'phase2-foundations',
  resolveDirectAccessInput: 'phase2-foundations',
  listProfiles: 'shell',
  deleteProfile: 'shell',
  chooseAndImportConfig: 'shell',
  saveCredentials: 'shell',
  listRegions: 'shell',
  getWorkspaceCatalog: 'shell',
  listServices: 'shell',
  getCallerIdentity: 'shell',
  runComparison: 'compare',
  getOverviewMetrics: 'overview',
  getOverviewStatistics: 'overview',
  getOverviewAccountContext: 'overview',
  getComplianceReport: 'compliance-center',
  updateComplianceFindingWorkflow: 'compliance-center',
  getSecurityScoreReport: 'security-score',
  getGuardDutyReport: 'guardduty',
  archiveGuardDutyFindings: 'guardduty',
  unarchiveGuardDutyFindings: 'guardduty',
  getRelationshipMap: 'overview',
  getCostBreakdown: 'overview',
  searchByTag: 'overview',
  listEc2Instances: 'ec2',
  runEc2BulkInstanceAction: 'ec2',
  terminateEc2Instances: 'ec2',
  listEc2SshKeySuggestions: 'ec2',
  listSsmManagedInstances: 'ec2',
  getSsmConnectionTarget: 'ec2',
  listSsmSessions: 'ec2',
  listCloudWatchMetrics: 'cloudwatch',
  getEc2MetricSeries: 'cloudwatch',
  listCloudWatchLogGroups: 'cloudwatch',
  listCloudWatchRecentEvents: 'cloudwatch',
  listEc2InstanceMetrics: 'cloudwatch',
  getMetricStatistics: 'cloudwatch',
  getEc2AllMetricSeries: 'cloudwatch',
  listS3Buckets: 's3',
  listS3Governance: 's3',
  getS3GovernanceDetail: 's3',
  listS3Objects: 's3',
  getS3PresignedUrl: 's3',
  getS3ObjectContent: 's3',
  listLambdaFunctions: 'lambda',
  getLambdaFunction: 'lambda',
  getLambdaFunctionCode: 'lambda',
  listAutoScalingGroups: 'auto-scaling',
  listAutoScalingInstances: 'auto-scaling',
  listRdsInstances: 'rds',
  listRdsClusters: 'rds',
  describeRdsInstance: 'rds',
  describeRdsCluster: 'rds',
  listCloudFormationStacks: 'cloudformation',
  listCloudFormationStackResources: 'cloudformation',
  listCloudFormationChangeSets: 'cloudformation',
  getCloudFormationChangeSetDetail: 'cloudformation',
  getCloudFormationDriftSummary: 'cloudformation',
  listTrails: 'cloudtrail',
  lookupCloudTrailEvents: 'cloudtrail',
  lookupCloudTrailEventsByResource: 'cloudtrail',
  listEcrRepositories: 'ecr',
  listEcrImages: 'ecr',
  getEcrScanFindings: 'ecr',
  getEcrAuthorizationToken: 'ecr',
  listEksClusters: 'eks',
  describeEksCluster: 'eks',
  listEksNodegroups: 'eks',
  listEksUpdates: 'eks',
  listEcsClusters: 'ecs',
  listEcsServices: 'ecs',
  describeEcsService: 'ecs',
  getEcsDiagnostics: 'ecs',
  listEcsTasks: 'ecs',
  getEcsContainerLogs: 'ecs',
  listVpcs: 'vpc',
  listSubnets: 'vpc',
  listRouteTables: 'vpc',
  listInternetGateways: 'vpc',
  listNatGateways: 'vpc',
  listTransitGateways: 'vpc',
  listNetworkInterfaces: 'vpc',
  listSecurityGroupsForVpc: 'vpc',
  getVpcTopology: 'vpc',
  getVpcFlowDiagram: 'vpc',
  getReachabilityAnalysis: 'vpc',
  listLoadBalancerWorkspaces: 'load-balancers',
  listRoute53HostedZones: 'route53',
  createRoute53HostedZone: 'route53',
  listRoute53Records: 'route53',
  listSecrets: 'secrets-manager',
  describeSecret: 'secrets-manager',
  getSecretValue: 'secrets-manager',
  listKeyPairs: 'key-pairs',
  getEc2Recommendations: 'ec2',
  decodeAuthorizationMessage: 'sts',
  lookupAccessKeyOwnership: 'sts',
  listKmsKeys: 'kms',
  describeKmsKey: 'kms',
  decryptCiphertext: 'kms',
  listWebAcls: 'waf',
  describeWebAcl: 'waf',
  listSnsTopics: 'sns',
  getSnsTopic: 'sns',
  listSnsSubscriptions: 'sns',
  listSqsQueues: 'sqs',
  getSqsQueue: 'sqs',
  sqsReceiveMessages: 'sqs',
  sqsTimeline: 'sqs',
  chooseEc2SshKey: 'phase2-foundations',
  listSsoInstances: 'identity-center',
  listSsoPermissionSets: 'identity-center',
  listSsoUsers: 'identity-center',
  listSsoGroups: 'identity-center',
  listSsoAccountAssignments: 'identity-center',
  simulateSsoPermissions: 'identity-center',
  listIamUsers: 'iam',
  listIamGroups: 'iam',
  listIamRoles: 'iam',
  listIamPolicies: 'iam',
  getIamAccountSummary: 'iam',
  listIamAccessKeys: 'iam',
  listIamMfaDevices: 'iam',
  listAttachedIamUserPolicies: 'iam',
  listIamUserInlinePolicies: 'iam',
  listIamUserGroups: 'iam',
  listAttachedIamRolePolicies: 'iam',
  listIamRoleInlinePolicies: 'iam',
  getIamRoleTrustPolicy: 'iam',
  listAttachedIamGroupPolicies: 'iam',
  getIamPolicyVersion: 'iam',
  listIamPolicyVersions: 'iam',
  simulateIamPolicy: 'iam',
  getIamCredentialReport: 'iam'
}

const MUTATING_METHODS = new Set<keyof AwsLensBridge>([
  'updateGovernanceTagDefaults',
  'saveCloudWatchSavedQuery',
  'deleteCloudWatchSavedQuery',
  'recordCloudWatchQueryHistory',
  'clearCloudWatchQueryHistory',
  'saveDbConnectionPreset',
  'deleteDbConnectionPreset',
  'markDbConnectionPresetUsed',
  'saveDbVaultCredential',
  'deleteDbVaultCredential',
  'saveVaultEntry',
  'deleteVaultEntry',
  'recordVaultEntryUse',
  'chooseEc2SshKey',
  'saveComparisonBaseline',
  'saveComparisonPreset',
  'deleteComparisonBaseline',
  'deleteComparisonPreset',
  'deleteProfile',
  'chooseAndImportConfig',
  'saveCredentials',
  'createEcrRepository',
  'deleteEcrRepository',
  'deleteEcrImage',
  'startEcrImageScan',
  'ecrDockerLogin',
  'ecrDockerPull',
  'ecrDockerPush',
  'updateEksNodegroupScaling',
  'deleteEksCluster',
  'addEksToKubeconfig',
  'launchKubectlTerminal',
  'runEksCommand',
  'updateEcsDesiredCount',
  'forceEcsRedeploy',
  'stopEcsTask',
  'updateSubnetPublicIp',
  'createReachabilityPath',
  'createRoute53HostedZone',
  'upsertRoute53Record',
  'deleteRoute53Record',
  'invokeLambdaFunction',
  'createLambdaFunction',
  'deleteLambdaFunction',
  'updateAutoScalingCapacity',
  'startAutoScalingRefresh',
  'deleteAutoScalingGroup',
  'createS3Bucket',
  'deleteS3Object',
  'createS3Folder',
  'downloadS3Object',
  'downloadS3ObjectTo',
  'openS3Object',
  'openS3InVSCode',
  'putS3ObjectContent',
  'uploadS3Object',
  'enableS3BucketVersioning',
  'enableS3BucketEncryption',
  'putS3BucketPolicy',
  'startRdsInstance',
  'stopRdsInstance',
  'rebootRdsInstance',
  'resizeRdsInstance',
  'createRdsSnapshot',
  'startRdsCluster',
  'stopRdsCluster',
  'failoverRdsCluster',
  'createRdsClusterSnapshot',
  'createCloudFormationChangeSet',
  'executeCloudFormationChangeSet',
  'deleteCloudFormationChangeSet',
  'startCloudFormationDriftDetection',
  'deleteLoadBalancer',
  'requestAcmCertificate',
  'deleteAcmCertificate',
  'createSecret',
  'deleteSecret',
  'restoreSecret',
  'updateSecretValue',
  'updateSecretDescription',
  'rotateSecret',
  'putSecretResourcePolicy',
  'tagSecret',
  'untagSecret',
  'createKeyPair',
  'deleteKeyPair',
  'assumeRole',
  'createWebAcl',
  'deleteWebAcl',
  'addWafRule',
  'updateWafRulesJson',
  'deleteWafRule',
  'associateWebAcl',
  'disassociateWebAcl',
  'createSnsTopic',
  'deleteSnsTopic',
  'setSnsTopicAttribute',
  'snsSubscribe',
  'snsUnsubscribe',
  'snsPublish',
  'tagSnsTopic',
  'untagSnsTopic',
  'createSqsQueue',
  'deleteSqsQueue',
  'purgeSqsQueue',
  'setSqsAttributes',
  'sqsSendMessage',
  'sqsDeleteMessage',
  'sqsChangeVisibility',
  'tagSqsQueue',
  'untagSqsQueue',
  'createSsoInstance',
  'deleteSsoInstance',
  'createIamAccessKey',
  'deleteIamAccessKey',
  'updateIamAccessKeyStatus',
  'deleteIamMfaDevice',
  'attachIamUserPolicy',
  'detachIamUserPolicy',
  'putIamUserInlinePolicy',
  'deleteIamUserInlinePolicy',
  'addIamUserToGroup',
  'removeIamUserFromGroup',
  'createIamUser',
  'deleteIamUser',
  'createIamLoginProfile',
  'deleteIamLoginProfile',
  'attachIamRolePolicy',
  'detachIamRolePolicy',
  'putIamRoleInlinePolicy',
  'deleteIamRoleInlinePolicy',
  'updateIamRoleTrustPolicy',
  'createIamRole',
  'deleteIamRole',
  'attachIamGroupPolicy',
  'detachIamGroupPolicy',
  'createIamGroup',
  'deleteIamGroup',
  'createIamPolicyVersion',
  'deleteIamPolicyVersion',
  'createIamPolicy',
  'deleteIamPolicy',
  'generateIamCredentialReport',
  'runEc2BulkInstanceAction',
  'terminateEc2Instances',
  'startSsmSession',
  'sendSsmCommand',
  'upsertAzureDnsRecord',
  'deleteAzureDnsRecord',
  'createAzureDnsZone',
  'createGcpDnsResourceRecordSet',
  'updateGcpDnsResourceRecordSet',
  'deleteGcpDnsResourceRecordSet'
])

const EXTRA_INVALIDATION_TAGS_BY_METHOD: Partial<Record<keyof AwsLensBridge, CacheTag[]>> = {
  saveDbVaultCredential: ['phase2-foundations'],
  deleteDbVaultCredential: ['phase2-foundations'],
  saveVaultEntry: ['phase1-foundations'],
  deleteVaultEntry: ['phase1-foundations'],
  recordVaultEntryUse: ['phase1-foundations']
}

const BACKGROUND_METHODS = new Set<keyof AwsLensBridge>([
  'getEc2Recommendations'
])

function notifyAwsActivity(): void {
  for (const listener of awsActivityListeners) {
    listener(awsActivityState)
  }
}

function beginAwsActivity(): void {
  awsActivityState = {
    ...awsActivityState,
    pendingCount: awsActivityState.pendingCount + 1
  }
  notifyAwsActivity()
}

function endAwsActivity(): void {
  awsActivityState = {
    pendingCount: Math.max(0, awsActivityState.pendingCount - 1),
    lastCompletedAt: Date.now()
  }
  notifyAwsActivity()
}

function getAwsActivityState(): AwsActivityState {
  return awsActivityState
}

function notifyEnterpriseSettings(): void {
  for (const listener of enterpriseListeners) {
    listener(enterpriseSettingsState)
  }
}

function setEnterpriseSettingsState(settings: EnterpriseSettings): EnterpriseSettings {
  enterpriseSettingsState = settings
  notifyEnterpriseSettings()
  return settings
}

function getEnterpriseSettingsState(): EnterpriseSettings {
  return enterpriseSettingsState
}

function cacheKey(tag: CacheTag, method: string, args: unknown[]): string {
  return `${tag}:${method}:${JSON.stringify(args)}`
}

function extractSnapshotValue<T>(value: unknown): T | null {
  return value == null ? null : value as T
}

export function getCachedQuerySnapshot<T>(tag: CacheTag, method: string, args: unknown[]): CachedQuerySnapshot<T> {
  const key = cacheKey(tag, method, args)
  const cached = pageCache.get(key)

  if (cached?.status === 'resolved') {
    const snapshotValue = extractSnapshotValue<T>(cached.value)
    if (snapshotValue === null) {
      return { value: null, fetchedAt: null, source: null }
    }

    return {
      value: snapshotValue,
      fetchedAt: cached.fetchedAt,
      source: cached.source
    }
  }

  return {
    value: null,
    fetchedAt: null,
    source: null
  }
}

function readCached<T>(tag: CacheTag, method: string, args: unknown[], loader: () => Promise<T>): Promise<T> {
  const key = cacheKey(tag, method, args)
  const cached = pageCache.get(key)

  if (cached) {
    return Promise.resolve(cached.value as T)
  }

  const cacheVersionAtLoad = pageCacheVersion
  const pending = loader()
    .then((result) => {
      if (pageCacheVersion === cacheVersionAtLoad) {
        pageCache.set(key, {
          status: 'resolved',
          value: result,
          fetchedAt: Date.now(),
          source: 'live'
        })
      }
      return result
    })
    .catch((error) => {
      if (pageCacheVersion === cacheVersionAtLoad) {
        pageCache.delete(key)
      }
      throw error
    })

  pageCache.set(key, {
    status: 'pending',
    value: pending,
    fetchedAt: null,
    source: null
  })
  return pending
}

export function invalidatePageCache(tag: CacheTag): void {
  const prefix = `${tag}:`
  for (const key of pageCache.keys()) {
    if (key.startsWith(prefix)) {
      pageCache.delete(key)
    }
  }
}

export function invalidateAllPageCaches(): void {
  pageCacheVersion += 1
  pageCache.clear()
}

function terraformBridge() {
  if (!window.terraformWorkspace) {
    throw new Error('Electron preload bridge did not load.')
  }
  return window.terraformWorkspace
}

function rawAwsBridge(): AwsLensBridge {
  if (!window.awsLens) {
    throw new Error('AWS preload bridge did not load.')
  }
  return window.awsLens
}

function awsBridge(): AwsLensBridge {
  const bridge = rawAwsBridge()
  const cached = awsBridgeCache.get(bridge)
  if (cached) {
    return cached
  }

  const wrapper = {} as AwsLensBridge
  for (const key of Object.keys(bridge)) {
    const value = (bridge as Record<string, unknown>)[key]
    if (typeof value === 'function') {
      ;(wrapper as Record<string, unknown>)[key] = (...args: unknown[]) => {
        const method = key as keyof AwsLensBridge
        const tag = CACHE_TAG_BY_METHOD[method]
        const invoke = () => {
          beginAwsActivity()
          return Promise.resolve(value.apply(bridge, args)).finally(() => {
            endAwsActivity()
          })
        }
        const invokeWithoutActivity = () => Promise.resolve(value.apply(bridge, args))
        const loader = BACKGROUND_METHODS.has(method) ? invokeWithoutActivity : invoke
        const isMutatingMethod = MUTATING_METHODS.has(method)

        if (!tag) {
          // For non-cached, non-mutating read methods: deduplicate identical concurrent calls.
          // Mutating methods always fire independently.
          if (!isMutatingMethod) {
            const inflightKey = `${key}:${JSON.stringify(args)}`
            const existing = inflightRequests.get(inflightKey)
            if (existing) {
              return existing
            }
            const request = loader().finally(() => {
              inflightRequests.delete(inflightKey)
            })
            inflightRequests.set(inflightKey, request)
            return request
          }
          return loader()
        }

        if (isMutatingMethod) {
          return invoke().then((result) => {
            invalidatePageCache(tag)
            for (const extraTag of EXTRA_INVALIDATION_TAGS_BY_METHOD[method] ?? []) {
              invalidatePageCache(extraTag)
            }
            return result
          })
        }

        return readCached(tag, key, args, loader)
      }
    } else {
      ;(wrapper as Record<string, unknown>)[key] = value
    }
  }

  awsBridgeCache.set(bridge, wrapper)
  return wrapper
}

export function trackedAwsBridge(): AwsLensBridge {
  return awsBridge()
}

function normalizeUserFacingError(rawError: string): AwsLensApiError {
  const normalized = rawError.toLowerCase()

  if (normalized.includes('read-only mode')) {
    return new AwsLensApiError(
      'This action is blocked in read-only mode. Switch to operator mode to make changes.',
      rawError,
      'Read-Only Mode'
    )
  }

  if (normalized.includes('accessdenied') || normalized.includes('access denied') || normalized.includes('not authorized')) {
    return new AwsLensApiError(
      'Access denied. Check the active credentials or policy scope for the selected account and region.',
      rawError,
      'Access Denied'
    )
  }

  if (normalized.includes('expired token') || normalized.includes('expiredtoken') || normalized.includes('security token')) {
    return new AwsLensApiError(
      'The current session has expired. Refresh credentials or re-authenticate, then retry.',
      rawError,
      'Session Expired'
    )
  }

  if (normalized.includes('throttl') || normalized.includes('rate exceeded') || normalized.includes('too many requests')) {
    return new AwsLensApiError(
      'The cloud provider is rate-limiting this operation. Retry in a moment or narrow the request scope.',
      rawError,
      'Request Throttled'
    )
  }

  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return new AwsLensApiError(
      'The operation timed out. Retry or reduce the amount of data being requested.',
      rawError,
      'Operation Timed Out'
    )
  }

  if (normalized.includes('project not found')) {
    return new AwsLensApiError(
      'The selected Terraform project is no longer available. Refresh the project list and reselect the workspace.',
      rawError,
      'Project Missing'
    )
  }

  if (normalized.includes('no terraform-compatible cli found') || normalized.includes('cli is not available on this machine')) {
    return new AwsLensApiError(
      'Terraform or OpenTofu is not available on this machine. Install a supported CLI and retry.',
      rawError,
      'CLI Missing'
    )
  }

  if (normalized.includes('electron preload bridge did not load')) {
    return new AwsLensApiError(
      'The desktop bridge did not initialize correctly. Reload the app window and retry.',
      rawError,
      'Bridge Not Available'
    )
  }

  if (normalized.includes('network error') || normalized.includes('econnreset') || normalized.includes('socket hang up')) {
    return new AwsLensApiError(
      'A temporary network failure interrupted the operation. Retry, and export diagnostics if it keeps happening.',
      rawError,
      'Temporary Network Failure'
    )
  }

  if (normalized.includes('google cloud api access failed')) {
    return new AwsLensApiError(
      rawError,
      rawError,
      'Google Cloud API Disabled'
    )
  }

  if (normalized.includes('google cloud cli authorization failed')) {
    return new AwsLensApiError(
      'Google Cloud CLI credentials are not valid for this request. Refresh your gcloud login or active account and retry.',
      rawError,
      'Google Cloud Authorization Failed'
    )
  }

  if (normalized.includes('google cloud cli failed while')) {
    return new AwsLensApiError(
      rawError,
      rawError,
      'Google Cloud CLI Failed'
    )
  }

  if (normalized.includes('google cloud sdk failed while')) {
    return new AwsLensApiError(
      rawError,
      rawError,
      'Google Cloud SDK Failed'
    )
  }

  if (normalized.includes('google cloud sdk authorization failed')) {
    return new AwsLensApiError(
      rawError,
      rawError,
      'Google Cloud Authorization Failed'
    )
  }

  return new AwsLensApiError(
    'The operation failed. Review the current context and export diagnostics if the problem persists.',
    rawError
  )
}

function unwrap<T>(result: Wrapped<T>): T {
  if (!result.ok) {
    if (typeof window !== 'undefined' && result.error.includes('read-only mode')) {
        window.dispatchEvent(new CustomEvent(BLOCKED_ACTION_EVENT, { detail: result.error }))
    }
    throw normalizeUserFacingError(result.error)
  }
  return result.data
}

export function subscribeToAwsActivity(listener: (state: AwsActivityState) => void): () => void {
  awsActivityListeners.add(listener)
  listener(getAwsActivityState())
  return () => {
    awsActivityListeners.delete(listener)
  }
}

export function useAwsActivity(): AwsActivityState {
  const [state, setState] = useState<AwsActivityState>(() => getAwsActivityState())

  useEffect(() => subscribeToAwsActivity(setState), [])

  return state
}

export async function openAwsTerminal(sessionId: string, connection: AwsConnection, initialCommand?: string): Promise<AwsTerminalOpenResult> {
  return rawAwsBridge().openAwsTerminal(sessionId, connection, initialCommand) as Promise<AwsTerminalOpenResult>
}

export async function openExternalUrl(url: string): Promise<void> {
  await rawAwsBridge().openExternalUrl(url)
}

export async function updateAwsTerminalContext(sessionId: string, connection: AwsConnection): Promise<void> {
  await rawAwsBridge().updateAwsTerminalContext(sessionId, connection)
}

export async function openProviderTerminal(sessionId: string, target: ProviderTerminalTarget, initialCommand?: string): Promise<AwsTerminalOpenResult> {
  return rawAwsBridge().openProviderTerminal(sessionId, target, initialCommand) as Promise<AwsTerminalOpenResult>
}

export async function updateProviderTerminalContext(sessionId: string, target: ProviderTerminalTarget): Promise<void> {
  await rawAwsBridge().updateProviderTerminalContext(sessionId, target)
}

export async function sendAwsTerminalInput(sessionId: string, input: string): Promise<void> {
  await rawAwsBridge().sendTerminalInput(sessionId, input)
}

export async function runAwsTerminalCommand(sessionId: string, command: string): Promise<void> {
  await rawAwsBridge().runTerminalCommand(sessionId, command)
}

export async function resizeAwsTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  await rawAwsBridge().resizeTerminal(sessionId, cols, rows)
}

export async function closeAwsTerminal(sessionId?: string): Promise<void> {
  await rawAwsBridge().closeTerminal(sessionId)
}

export function subscribeToAwsTerminal(listener: (event: TerminalEvent) => void): () => void {
  const genericListener = (event: unknown) => listener(event as TerminalEvent)
  rawAwsBridge().subscribeTerminal(genericListener)
  return () => rawAwsBridge().unsubscribeTerminal(genericListener)
}

export async function listProfiles(): Promise<AwsProfile[]> {
  return unwrap((await awsBridge().listProfiles()) as Wrapped<AwsProfile[]>)
}

export async function deleteProfile(profileName: string): Promise<void> {
  return unwrap((await awsBridge().deleteProfile(profileName)) as Wrapped<void>)
}

export async function chooseAndImportConfig(): Promise<string[]> {
  return unwrap((await awsBridge().chooseAndImportConfig()) as Wrapped<string[]>)
}

export async function saveCredentials(profileName: string, accessKeyId: string, secretAccessKey: string): Promise<void> {
  unwrap((await awsBridge().saveCredentials(profileName, accessKeyId, secretAccessKey)) as Wrapped<void>)
}

export async function listRegions(): Promise<AwsRegionOption[]> {
  return unwrap((await awsBridge().listRegions()) as Wrapped<AwsRegionOption[]>)
}

export async function getSessionHubState(): Promise<SessionHubState> {
  return unwrap((await awsBridge().getSessionHubState()) as Wrapped<SessionHubState>)
}

export async function runComparison(request: ComparisonRequest): Promise<ComparisonResult> {
  return unwrap((await awsBridge().runComparison(request)) as Wrapped<ComparisonResult>)
}

export async function saveAssumeRoleTarget(target: Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<AwsAssumeRoleTarget> {
  return unwrap((await awsBridge().saveAssumeRoleTarget(target)) as Wrapped<AwsAssumeRoleTarget>)
}

export async function deleteAssumeRoleTarget(targetId: string): Promise<void> {
  return unwrap((await awsBridge().deleteAssumeRoleTarget(targetId)) as Wrapped<void>)
}

export async function deleteAssumedSession(sessionId: string): Promise<void> {
  return unwrap((await awsBridge().deleteAssumedSession(sessionId)) as Wrapped<void>)
}

export async function assumeRoleSession(request: AssumeRoleRequest): Promise<AssumeRoleResult> {
  return unwrap((await awsBridge().assumeRoleSession(request)) as Wrapped<AssumeRoleResult>)
}

export async function refreshAssumedSession(sessionId: string): Promise<AssumeRoleResult> {
  return unwrap((await awsBridge().refreshAssumedSession(sessionId)) as Wrapped<AssumeRoleResult>)
}

export async function assumeSavedRoleTarget(targetId: string): Promise<AssumeRoleResult> {
  return unwrap((await awsBridge().assumeSavedRoleTarget(targetId)) as Wrapped<AssumeRoleResult>)
}

export async function getAssumedSessionCredentials(sessionId: string): Promise<{ secretAccessKey: string; sessionToken: string }> {
  return unwrap((await rawAwsBridge().getAssumedSessionCredentials(sessionId)) as Wrapped<{ secretAccessKey: string; sessionToken: string }>)
}

export async function listProviders(): Promise<ProviderDescriptor[]> {
  return unwrap((await awsBridge().listProviders()) as Wrapped<ProviderDescriptor[]>)
}

export async function getProviderCliStatus(): Promise<ProviderCliStatus> {
  return unwrap((await rawAwsBridge().getProviderCliStatus()) as Wrapped<ProviderCliStatus>)
}

export async function getWorkspaceCatalog(providerId?: CloudProviderId): Promise<WorkspaceCatalog> {
  return unwrap((await awsBridge().getWorkspaceCatalog(providerId)) as Wrapped<WorkspaceCatalog>)
}

export async function listServices(providerId?: CloudProviderId): Promise<ServiceDescriptor[]> {
  return unwrap((await awsBridge().listServices(providerId)) as Wrapped<ServiceDescriptor[]>)
}

export async function getGovernanceTagDefaults(): Promise<GovernanceTagDefaults> {
  return unwrap((await awsBridge().getGovernanceTagDefaults()) as Wrapped<GovernanceTagDefaults>)
}

export async function updateGovernanceTagDefaults(update: GovernanceTagDefaultsUpdate): Promise<GovernanceTagDefaults> {
  return unwrap((await awsBridge().updateGovernanceTagDefaults(update)) as Wrapped<GovernanceTagDefaults>)
}

export async function listCloudWatchSavedQueries(filter?: CloudWatchQueryFilter): Promise<CloudWatchSavedQuery[]> {
  return unwrap((await awsBridge().listCloudWatchSavedQueries(filter)) as Wrapped<CloudWatchSavedQuery[]>)
}

export async function saveCloudWatchSavedQuery(input: CloudWatchSavedQueryInput): Promise<CloudWatchSavedQuery> {
  return unwrap((await awsBridge().saveCloudWatchSavedQuery(input)) as Wrapped<CloudWatchSavedQuery>)
}

export async function deleteCloudWatchSavedQuery(id: string): Promise<void> {
  return unwrap((await awsBridge().deleteCloudWatchSavedQuery(id)) as Wrapped<void>)
}

export async function listCloudWatchInvestigationHistory(
  filter?: CloudWatchQueryFilter
): Promise<CloudWatchInvestigationHistoryEntry[]> {
  return unwrap((await awsBridge().listCloudWatchInvestigationHistory(filter)) as Wrapped<CloudWatchInvestigationHistoryEntry[]>)
}

export async function recordCloudWatchInvestigationHistory(
  input: CloudWatchInvestigationHistoryInput
): Promise<CloudWatchInvestigationHistoryEntry> {
  return unwrap((await awsBridge().recordCloudWatchInvestigationHistory(input)) as Wrapped<CloudWatchInvestigationHistoryEntry>)
}

export async function clearCloudWatchInvestigationHistory(filter?: CloudWatchQueryFilter): Promise<number> {
  return unwrap((await awsBridge().clearCloudWatchInvestigationHistory(filter)) as Wrapped<number>)
}

export async function listCloudWatchQueryHistory(filter?: CloudWatchQueryFilter): Promise<CloudWatchQueryHistoryEntry[]> {
  return unwrap((await awsBridge().listCloudWatchQueryHistory(filter)) as Wrapped<CloudWatchQueryHistoryEntry[]>)
}

export async function recordCloudWatchQueryHistory(input: CloudWatchQueryHistoryInput): Promise<CloudWatchQueryHistoryEntry> {
  return unwrap((await awsBridge().recordCloudWatchQueryHistory(input)) as Wrapped<CloudWatchQueryHistoryEntry>)
}

export async function clearCloudWatchQueryHistory(filter?: CloudWatchQueryFilter): Promise<number> {
  return unwrap((await awsBridge().clearCloudWatchQueryHistory(filter)) as Wrapped<number>)
}

export async function listDbConnectionPresets(filter?: DbConnectionPresetFilter): Promise<DbConnectionPreset[]> {
  return unwrap((await awsBridge().listDbConnectionPresets(filter)) as Wrapped<DbConnectionPreset[]>)
}

export async function saveDbConnectionPreset(input: DbConnectionPresetInput): Promise<DbConnectionPreset> {
  return unwrap((await awsBridge().saveDbConnectionPreset(input)) as Wrapped<DbConnectionPreset>)
}

export async function deleteDbConnectionPreset(id: string): Promise<void> {
  return unwrap((await awsBridge().deleteDbConnectionPreset(id)) as Wrapped<void>)
}

export async function markDbConnectionPresetUsed(id: string): Promise<DbConnectionPreset> {
  return unwrap((await awsBridge().markDbConnectionPresetUsed(id)) as Wrapped<DbConnectionPreset>)
}

export async function listDbVaultCredentials(): Promise<DbVaultCredentialSummary[]> {
  return unwrap((await awsBridge().listDbVaultCredentials()) as Wrapped<DbVaultCredentialSummary[]>)
}

export async function saveDbVaultCredential(input: DbVaultCredentialInput): Promise<DbVaultCredentialSummary> {
  return unwrap((await awsBridge().saveDbVaultCredential(input)) as Wrapped<DbVaultCredentialSummary>)
}

export async function deleteDbVaultCredential(name: string): Promise<void> {
  return unwrap((await awsBridge().deleteDbVaultCredential(name)) as Wrapped<void>)
}

export async function resolveDbConnectionMaterial(
  connection: AwsConnection,
  input: DbConnectionResolveInput
): Promise<DbConnectionResolutionResult> {
  return unwrap((await rawAwsBridge().resolveDbConnectionMaterial(connection, input)) as Wrapped<DbConnectionResolutionResult>)
}

export async function getAwsCapabilitySnapshot(region: string, subjects?: AwsCapabilitySubject[]): Promise<AwsCapabilitySnapshot> {
  return unwrap((await awsBridge().getAwsCapabilitySnapshot(region, subjects)) as Wrapped<AwsCapabilitySnapshot>)
}

export async function listVaultEntries(filter?: VaultEntryFilter): Promise<VaultEntrySummary[]> {
  return unwrap((await awsBridge().listVaultEntries(filter)) as Wrapped<VaultEntrySummary[]>)
}

export async function saveVaultEntry(input: VaultEntryInput): Promise<VaultEntrySummary> {
  return unwrap((await awsBridge().saveVaultEntry(input)) as Wrapped<VaultEntrySummary>)
}

export async function deleteVaultEntry(entryId: string): Promise<void> {
  return unwrap((await awsBridge().deleteVaultEntry(entryId)) as Wrapped<void>)
}

export async function revealVaultEntrySecret(entryId: string): Promise<string> {
  return unwrap((await rawAwsBridge().revealVaultEntrySecret(entryId)) as Wrapped<string>)
}

export async function recordVaultEntryUse(input: VaultEntryUsageInput): Promise<VaultEntrySummary> {
  return unwrap((await rawAwsBridge().recordVaultEntryUse(input)) as Wrapped<VaultEntrySummary>)
}

export async function materializeVaultEntry(entryId: string): Promise<MaterializedVaultEntryHandle> {
  return unwrap(
    (await rawAwsBridge().materializeVaultEntry(entryId)) as Wrapped<MaterializedVaultEntryHandle>
  )
}

export async function disposeMaterializedVaultEntry(disposeToken: string): Promise<void> {
  return unwrap(
    (await rawAwsBridge().disposeMaterializedVaultEntry(disposeToken)) as Wrapped<void>
  )
}

export async function listActiveVaultCredentials(): Promise<{ aws?: string; gcp?: string; azure?: string }> {
  return unwrap(
    (await rawAwsBridge().listActiveVaultCredentials()) as Wrapped<{ aws?: string; gcp?: string; azure?: string }>
  )
}

export async function getActiveVaultCredential(provider: CloudProviderId): Promise<string | null> {
  return unwrap(
    (await rawAwsBridge().getActiveVaultCredential(provider)) as Wrapped<string | null>
  )
}

export async function setActiveVaultCredential(provider: CloudProviderId, entryId: string | null): Promise<void> {
  return unwrap(
    (await rawAwsBridge().setActiveVaultCredential(provider, entryId)) as Wrapped<void>
  )
}

export async function validateVaultEntry(entryId: string): Promise<VaultValidationResult> {
  return unwrap(
    (await rawAwsBridge().validateVaultEntry(entryId)) as Wrapped<VaultValidationResult>
  )
}

export async function listSshKeysForProvider(provider?: CloudProviderId): Promise<VaultEntrySummary[]> {
  return unwrap(
    (await rawAwsBridge().listSshKeysForProvider(provider)) as Wrapped<VaultEntrySummary[]>
  )
}

export async function listComparisonBaselines(): Promise<ComparisonBaselineSummary[]> {
  return unwrap((await awsBridge().listComparisonBaselines()) as Wrapped<ComparisonBaselineSummary[]>)
}

export async function listComparisonPresets(): Promise<ComparisonPresetSummary[]> {
  return unwrap((await awsBridge().listComparisonPresets()) as Wrapped<ComparisonPresetSummary[]>)
}

export async function getComparisonBaseline(baselineId: string): Promise<ComparisonBaseline | null> {
  return unwrap((await awsBridge().getComparisonBaseline(baselineId)) as Wrapped<ComparisonBaseline | null>)
}

export async function getComparisonPreset(presetId: string): Promise<ComparisonPreset | null> {
  return unwrap((await awsBridge().getComparisonPreset(presetId)) as Wrapped<ComparisonPreset | null>)
}

export async function saveComparisonBaseline(input: ComparisonBaselineInput): Promise<ComparisonBaselineSummary> {
  return unwrap((await awsBridge().saveComparisonBaseline(input)) as Wrapped<ComparisonBaselineSummary>)
}

export async function saveComparisonPreset(input: ComparisonPresetInput): Promise<ComparisonPresetSummary> {
  return unwrap((await awsBridge().saveComparisonPreset(input)) as Wrapped<ComparisonPresetSummary>)
}

export async function deleteComparisonBaseline(baselineId: string): Promise<void> {
  return unwrap((await awsBridge().deleteComparisonBaseline(baselineId)) as Wrapped<void>)
}

export async function deleteComparisonPreset(presetId: string): Promise<void> {
  return unwrap((await awsBridge().deleteComparisonPreset(presetId)) as Wrapped<void>)
}

export async function buildEksUpgradePlan(
  connection: AwsConnection,
  request: EksUpgradePlannerRequest
): Promise<EksUpgradePlan> {
  return unwrap((await awsBridge().buildEksUpgradePlan(connection, request)) as Wrapped<EksUpgradePlan>)
}

export async function resolveDirectAccessInput(input: string): Promise<DirectAccessResolution> {
  return unwrap((await awsBridge().resolveDirectAccessInput(input)) as Wrapped<DirectAccessResolution>)
}

export function subscribeToEnterpriseSettings(listener: (settings: EnterpriseSettings) => void): () => void {
  enterpriseListeners.add(listener)
  listener(getEnterpriseSettingsState())
  return () => {
    enterpriseListeners.delete(listener)
  }
}

export function useEnterpriseSettings(): EnterpriseSettings {
  const [state, setState] = useState<EnterpriseSettings>(() => getEnterpriseSettingsState())

  useEffect(() => subscribeToEnterpriseSettings(setState), [])

  return state
}

export async function getEnterpriseSettings(): Promise<EnterpriseSettings> {
  return setEnterpriseSettingsState(unwrap((await rawAwsBridge().getEnterpriseSettings()) as Wrapped<EnterpriseSettings>))
}

export async function setEnterpriseAccessMode(accessMode: EnterpriseAccessMode): Promise<EnterpriseSettings> {
  return setEnterpriseSettingsState(
    unwrap((await rawAwsBridge().setEnterpriseAccessMode(accessMode)) as Wrapped<EnterpriseSettings>)
  )
}

export async function listEnterpriseAuditEvents(): Promise<EnterpriseAuditEvent[]> {
  return unwrap((await rawAwsBridge().listEnterpriseAuditEvents()) as Wrapped<EnterpriseAuditEvent[]>)
}

export async function exportEnterpriseAuditEvents(): Promise<EnterpriseAuditExportResult> {
  return unwrap((await rawAwsBridge().exportEnterpriseAuditEvents()) as Wrapped<EnterpriseAuditExportResult>)
}

export async function getAppReleaseInfo(): Promise<AppReleaseInfo> {
  return unwrap((await rawAwsBridge().getReleaseInfo()) as Wrapped<AppReleaseInfo>)
}

export async function getAppSettings(): Promise<AppSettings> {
  return unwrap((await rawAwsBridge().getAppSettings()) as Wrapped<AppSettings>)
}

export async function getAppSecuritySummary(): Promise<AppSecuritySummary> {
  return unwrap((await rawAwsBridge().getAppSecuritySummary()) as Wrapped<AppSecuritySummary>)
}

export async function updateAppSettings(update: Partial<AppSettings>): Promise<AppSettings> {
  return unwrap((await rawAwsBridge().updateAppSettings(update)) as Wrapped<AppSettings>)
}

export async function resetAppSettings(): Promise<AppSettings> {
  return unwrap((await rawAwsBridge().resetAppSettings()) as Wrapped<AppSettings>)
}

export async function getEnvironmentHealth(): Promise<EnvironmentHealthReport> {
  return unwrap((await rawAwsBridge().getEnvironmentHealth()) as Wrapped<EnvironmentHealthReport>)
}

export async function getAzureProviderContext(): Promise<AzureProviderContextSnapshot> {
  return unwrap((await rawAwsBridge().getAzureProviderContext()) as unknown as Wrapped<AzureProviderContextSnapshot>)
}

export async function startAzureDeviceCodeSignIn(): Promise<AzureProviderContextSnapshot> {
  return unwrap((await rawAwsBridge().startAzureDeviceCodeSignIn()) as unknown as Wrapped<AzureProviderContextSnapshot>)
}

export async function signOutAzureProvider(): Promise<AzureProviderContextSnapshot> {
  return unwrap((await rawAwsBridge().signOutAzureProvider()) as unknown as Wrapped<AzureProviderContextSnapshot>)
}

export async function setAzureActiveTenant(tenantId: string): Promise<AzureProviderContextSnapshot> {
  return unwrap((await rawAwsBridge().setAzureActiveTenant(tenantId)) as unknown as Wrapped<AzureProviderContextSnapshot>)
}

export async function setAzureActiveSubscription(subscriptionId: string): Promise<AzureProviderContextSnapshot> {
  return unwrap((await rawAwsBridge().setAzureActiveSubscription(subscriptionId)) as unknown as Wrapped<AzureProviderContextSnapshot>)
}

export async function setAzureActiveLocation(location: string): Promise<AzureProviderContextSnapshot> {
  return unwrap((await rawAwsBridge().setAzureActiveLocation(location)) as unknown as Wrapped<AzureProviderContextSnapshot>)
}

export async function getGcpCliContext(): Promise<GcpCliContext> {
  return unwrap((await rawAwsBridge().getGcpCliContext()) as Wrapped<GcpCliContext>)
}

export async function listGcpProjects(): Promise<GcpCliProject[]> {
  return unwrap((await rawAwsBridge().listGcpProjects()) as Wrapped<GcpCliProject[]>)
}

export async function getGcpProjectOverview(projectId: string): Promise<GcpProjectOverview> {
  return unwrap((await rawAwsBridge().getGcpProjectOverview(projectId)) as Wrapped<GcpProjectOverview>)
}

export async function getGcpIamOverview(projectId: string): Promise<GcpIamOverview> {
  return unwrap((await rawAwsBridge().getGcpIamOverview(projectId)) as Wrapped<GcpIamOverview>)
}

export async function addGcpIamBinding(projectId: string, role: string, member: string): Promise<void> {
  return unwrap((await rawAwsBridge().addGcpIamBinding(projectId, role, member)) as Wrapped<void>)
}

export async function removeGcpIamBinding(projectId: string, role: string, member: string): Promise<void> {
  return unwrap((await rawAwsBridge().removeGcpIamBinding(projectId, role, member)) as Wrapped<void>)
}

export async function createGcpServiceAccount(projectId: string, accountId: string, displayName: string, description: string): Promise<GcpServiceAccountSummary> {
  return unwrap((await rawAwsBridge().createGcpServiceAccount(projectId, accountId, displayName, description)) as Wrapped<GcpServiceAccountSummary>)
}

export async function deleteGcpServiceAccount(projectId: string, email: string): Promise<void> {
  return unwrap((await rawAwsBridge().deleteGcpServiceAccount(projectId, email)) as Wrapped<void>)
}

export async function disableGcpServiceAccount(projectId: string, email: string, disable: boolean): Promise<void> {
  return unwrap((await rawAwsBridge().disableGcpServiceAccount(projectId, email, disable)) as Wrapped<void>)
}

export async function listGcpServiceAccountKeys(projectId: string, email: string): Promise<GcpServiceAccountKeySummary[]> {
  return unwrap((await rawAwsBridge().listGcpServiceAccountKeys(projectId, email)) as Wrapped<GcpServiceAccountKeySummary[]>)
}

export async function createGcpServiceAccountKey(projectId: string, email: string): Promise<{ keyId: string; privateKeyData: string; validAfterTime: string; validBeforeTime: string }> {
  return unwrap((await rawAwsBridge().createGcpServiceAccountKey(projectId, email)) as Wrapped<{ keyId: string; privateKeyData: string; validAfterTime: string; validBeforeTime: string }>)
}

export async function deleteGcpServiceAccountKey(projectId: string, email: string, keyId: string): Promise<void> {
  return unwrap((await rawAwsBridge().deleteGcpServiceAccountKey(projectId, email, keyId)) as Wrapped<void>)
}

export async function listGcpRoles(projectId: string, scope: 'custom' | 'all'): Promise<GcpIamRoleSummary[]> {
  return unwrap((await rawAwsBridge().listGcpRoles(projectId, scope)) as Wrapped<GcpIamRoleSummary[]>)
}

export async function createGcpCustomRole(projectId: string, roleId: string, title: string, description: string, permissions: string[]): Promise<GcpIamRoleSummary> {
  return unwrap((await rawAwsBridge().createGcpCustomRole(projectId, roleId, title, description, permissions)) as Wrapped<GcpIamRoleSummary>)
}

export async function deleteGcpCustomRole(projectId: string, roleName: string): Promise<void> {
  return unwrap((await rawAwsBridge().deleteGcpCustomRole(projectId, roleName)) as Wrapped<void>)
}

export async function testGcpIamPermissions(projectId: string, permissions: string[]): Promise<GcpIamTestPermissionsResult[]> {
  return unwrap((await rawAwsBridge().testGcpIamPermissions(projectId, permissions)) as Wrapped<GcpIamTestPermissionsResult[]>)
}

export async function listGcpComputeInstances(projectId: string, location: string): Promise<GcpComputeInstanceSummary[]> {
  return unwrap((await rawAwsBridge().listGcpComputeInstances(projectId, location)) as Wrapped<GcpComputeInstanceSummary[]>)
}

export async function getGcpComputeInstanceDetail(projectId: string, zone: string, instanceName: string): Promise<GcpComputeInstanceDetail | null> {
  return unwrap((await rawAwsBridge().getGcpComputeInstanceDetail(projectId, zone, instanceName)) as Wrapped<GcpComputeInstanceDetail | null>)
}

export async function listGcpComputeMachineTypes(projectId: string, zone: string): Promise<GcpComputeMachineTypeOption[]> {
  return unwrap((await rawAwsBridge().listGcpComputeMachineTypes(projectId, zone)) as Wrapped<GcpComputeMachineTypeOption[]>)
}

export async function runGcpComputeInstanceAction(
  projectId: string,
  zone: string,
  instanceName: string,
  action: GcpComputeInstanceAction
): Promise<GcpComputeOperationResult> {
  return unwrap((await rawAwsBridge().runGcpComputeInstanceAction(projectId, zone, instanceName, action)) as Wrapped<GcpComputeOperationResult>)
}

export async function resizeGcpComputeInstance(
  projectId: string,
  zone: string,
  instanceName: string,
  machineType: string
): Promise<GcpComputeOperationResult> {
  return unwrap((await rawAwsBridge().resizeGcpComputeInstance(projectId, zone, instanceName, machineType)) as Wrapped<GcpComputeOperationResult>)
}

export async function updateGcpComputeInstanceLabels(
  projectId: string,
  zone: string,
  instanceName: string,
  labels: Record<string, string>
): Promise<GcpComputeOperationResult> {
  return unwrap((await rawAwsBridge().updateGcpComputeInstanceLabels(projectId, zone, instanceName, labels)) as Wrapped<GcpComputeOperationResult>)
}

export async function deleteGcpComputeInstance(projectId: string, zone: string, instanceName: string): Promise<GcpComputeOperationResult> {
  return unwrap((await rawAwsBridge().deleteGcpComputeInstance(projectId, zone, instanceName)) as Wrapped<GcpComputeOperationResult>)
}

export async function getGcpComputeSerialOutput(
  projectId: string,
  zone: string,
  instanceName: string,
  port?: number,
  start?: number
): Promise<GcpComputeSerialOutput> {
  return unwrap((await rawAwsBridge().getGcpComputeSerialOutput(projectId, zone, instanceName, port, start)) as Wrapped<GcpComputeSerialOutput>)
}

export async function listGcpNetworks(projectId: string): Promise<GcpNetworkSummary[]> {
  return unwrap((await rawAwsBridge().listGcpNetworks(projectId)) as Wrapped<GcpNetworkSummary[]>)
}

export async function listGcpSubnetworks(projectId: string, location: string): Promise<GcpSubnetworkSummary[]> {
  return unwrap((await rawAwsBridge().listGcpSubnetworks(projectId, location)) as Wrapped<GcpSubnetworkSummary[]>)
}

export async function listGcpFirewallRules(projectId: string): Promise<GcpFirewallRuleSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirewallRules(projectId)) as Wrapped<GcpFirewallRuleSummary[]>)
}

export async function listGcpRouters(projectId: string, location: string): Promise<{ routers: GcpRouterSummary[]; nats: GcpRouterNatSummary[] }> {
  return unwrap((await rawAwsBridge().listGcpRouters(projectId, location)) as Wrapped<{ routers: GcpRouterSummary[]; nats: GcpRouterNatSummary[] }>)
}

export async function listGcpGlobalAddresses(projectId: string): Promise<GcpGlobalAddressSummary[]> {
  return unwrap((await rawAwsBridge().listGcpGlobalAddresses(projectId)) as Wrapped<GcpGlobalAddressSummary[]>)
}

export async function listGcpServiceNetworkingConnections(projectId: string, networkNames: string[]): Promise<GcpServiceNetworkingConnectionSummary[]> {
  return unwrap((await rawAwsBridge().listGcpServiceNetworkingConnections(projectId, networkNames)) as Wrapped<GcpServiceNetworkingConnectionSummary[]>)
}

export async function listGcpGkeClusters(projectId: string, location: string): Promise<GcpGkeClusterSummary[]> {
  return unwrap((await rawAwsBridge().listGcpGkeClusters(projectId, location)) as Wrapped<GcpGkeClusterSummary[]>)
}

export async function getGcpGkeClusterDetail(projectId: string, location: string, clusterName: string): Promise<GcpGkeClusterDetail> {
  return unwrap((await rawAwsBridge().getGcpGkeClusterDetail(projectId, location, clusterName)) as Wrapped<GcpGkeClusterDetail>)
}

export async function listGcpGkeNodePools(projectId: string, location: string, clusterName: string): Promise<GcpGkeNodePoolSummary[]> {
  return unwrap((await rawAwsBridge().listGcpGkeNodePools(projectId, location, clusterName)) as Wrapped<GcpGkeNodePoolSummary[]>)
}

export async function getGcpGkeClusterCredentials(
  projectId: string,
  location: string,
  clusterName: string,
  contextName?: string,
  kubeconfigPath?: string
): Promise<GcpGkeClusterCredentials> {
  return unwrap((await rawAwsBridge().getGcpGkeClusterCredentials(projectId, location, clusterName, contextName, kubeconfigPath)) as Wrapped<GcpGkeClusterCredentials>)
}

export async function listGcpGkeOperations(projectId: string, location: string, clusterName: string): Promise<GcpGkeOperationSummary[]> {
  return unwrap((await rawAwsBridge().listGcpGkeOperations(projectId, location, clusterName)) as Wrapped<GcpGkeOperationSummary[]>)
}

export async function updateGcpGkeNodePoolScaling(projectId: string, location: string, clusterName: string, nodePoolName: string, minimum: number, desired: number, maximum: number): Promise<GcpGkeOperationResult> {
  return unwrap((await rawAwsBridge().updateGcpGkeNodePoolScaling(projectId, location, clusterName, nodePoolName, minimum, desired, maximum)) as Wrapped<GcpGkeOperationResult>)
}

export async function listGcpStorageBuckets(projectId: string, location: string): Promise<GcpStorageBucketSummary[]> {
  return unwrap((await rawAwsBridge().listGcpStorageBuckets(projectId, location)) as Wrapped<GcpStorageBucketSummary[]>)
}

export async function listGcpStorageObjects(projectId: string, bucketName: string, prefix = ''): Promise<GcpStorageObjectSummary[]> {
  return unwrap((await rawAwsBridge().listGcpStorageObjects(projectId, bucketName, prefix)) as Wrapped<GcpStorageObjectSummary[]>)
}

export async function getGcpStorageObjectContent(projectId: string, bucketName: string, key: string): Promise<GcpStorageObjectContent> {
  return unwrap((await rawAwsBridge().getGcpStorageObjectContent(projectId, bucketName, key)) as Wrapped<GcpStorageObjectContent>)
}

export async function putGcpStorageObjectContent(projectId: string, bucketName: string, key: string, content: string): Promise<void> {
  return unwrap((await rawAwsBridge().putGcpStorageObjectContent(projectId, bucketName, key, content)) as Wrapped<void>)
}

export async function uploadGcpStorageObject(projectId: string, bucketName: string, key: string, localPath: string): Promise<void> {
  return unwrap((await rawAwsBridge().uploadGcpStorageObject(projectId, bucketName, key, localPath)) as Wrapped<void>)
}

export async function downloadGcpStorageObjectToPath(projectId: string, bucketName: string, key: string): Promise<string> {
  return unwrap((await rawAwsBridge().downloadGcpStorageObjectToPath(projectId, bucketName, key)) as Wrapped<string>)
}

export async function deleteGcpStorageObject(projectId: string, bucketName: string, key: string): Promise<void> {
  return unwrap((await rawAwsBridge().deleteGcpStorageObject(projectId, bucketName, key)) as Wrapped<void>)
}

export async function listGcpLogEntries(projectId: string, location: string, query: string, windowHours = 24): Promise<GcpLogQueryResult> {
  return unwrap((await rawAwsBridge().listGcpLogEntries(projectId, location, query, windowHours)) as Wrapped<GcpLogQueryResult>)
}

export async function listGcpSqlInstances(projectId: string, location: string): Promise<GcpSqlInstanceSummary[]> {
  return unwrap((await rawAwsBridge().listGcpSqlInstances(projectId, location)) as Wrapped<GcpSqlInstanceSummary[]>)
}

export async function getGcpSqlInstanceDetail(projectId: string, instanceName: string): Promise<GcpSqlInstanceDetail> {
  return unwrap((await rawAwsBridge().getGcpSqlInstanceDetail(projectId, instanceName)) as Wrapped<GcpSqlInstanceDetail>)
}

export async function listGcpSqlDatabases(projectId: string, instanceName: string): Promise<GcpSqlDatabaseSummary[]> {
  return unwrap((await rawAwsBridge().listGcpSqlDatabases(projectId, instanceName)) as Wrapped<GcpSqlDatabaseSummary[]>)
}

export async function listGcpSqlOperations(projectId: string, instanceName: string): Promise<GcpSqlOperationSummary[]> {
  return unwrap((await rawAwsBridge().listGcpSqlOperations(projectId, instanceName)) as Wrapped<GcpSqlOperationSummary[]>)
}

export async function getGcpBillingOverview(projectId: string, catalogProjectIds: string[]): Promise<GcpBillingOverview> {
  return unwrap((await rawAwsBridge().getGcpBillingOverview(projectId, catalogProjectIds)) as Wrapped<GcpBillingOverview>)
}

// Pub/Sub
export async function listGcpPubSubTopics(projectId: string): Promise<GcpPubSubTopicSummary[]> {
  return unwrap((await rawAwsBridge().listGcpPubSubTopics(projectId)) as Wrapped<GcpPubSubTopicSummary[]>)
}
export async function listGcpPubSubSubscriptions(projectId: string): Promise<GcpPubSubSubscriptionSummary[]> {
  return unwrap((await rawAwsBridge().listGcpPubSubSubscriptions(projectId)) as Wrapped<GcpPubSubSubscriptionSummary[]>)
}
export async function getGcpPubSubTopicDetail(projectId: string, topicId: string): Promise<GcpPubSubTopicDetail> {
  return unwrap((await rawAwsBridge().getGcpPubSubTopicDetail(projectId, topicId)) as Wrapped<GcpPubSubTopicDetail>)
}
export async function getGcpPubSubSubscriptionDetail(projectId: string, subscriptionId: string): Promise<GcpPubSubSubscriptionDetail> {
  return unwrap((await rawAwsBridge().getGcpPubSubSubscriptionDetail(projectId, subscriptionId)) as Wrapped<GcpPubSubSubscriptionDetail>)
}

// BigQuery
export async function listGcpBigQueryDatasets(projectId: string): Promise<GcpBigQueryDatasetSummary[]> {
  return unwrap((await rawAwsBridge().listGcpBigQueryDatasets(projectId)) as Wrapped<GcpBigQueryDatasetSummary[]>)
}
export async function listGcpBigQueryTables(projectId: string, datasetId: string): Promise<GcpBigQueryTableSummary[]> {
  return unwrap((await rawAwsBridge().listGcpBigQueryTables(projectId, datasetId)) as Wrapped<GcpBigQueryTableSummary[]>)
}
export async function getGcpBigQueryTableDetail(projectId: string, datasetId: string, tableId: string): Promise<GcpBigQueryTableDetail> {
  return unwrap((await rawAwsBridge().getGcpBigQueryTableDetail(projectId, datasetId, tableId)) as Wrapped<GcpBigQueryTableDetail>)
}
export async function runGcpBigQueryQuery(projectId: string, queryText: string, maxResults?: number): Promise<GcpBigQueryQueryResult> {
  return unwrap((await rawAwsBridge().runGcpBigQueryQuery(projectId, queryText, maxResults)) as Wrapped<GcpBigQueryQueryResult>)
}

// Cloud Monitoring
export async function listGcpMonitoringAlertPolicies(projectId: string): Promise<GcpMonitoringAlertPolicySummary[]> {
  return unwrap((await rawAwsBridge().listGcpMonitoringAlertPolicies(projectId)) as Wrapped<GcpMonitoringAlertPolicySummary[]>)
}
export async function listGcpMonitoringUptimeChecks(projectId: string): Promise<GcpMonitoringUptimeCheckSummary[]> {
  return unwrap((await rawAwsBridge().listGcpMonitoringUptimeChecks(projectId)) as Wrapped<GcpMonitoringUptimeCheckSummary[]>)
}
export async function listGcpMonitoringMetricDescriptors(projectId: string, filter?: string): Promise<GcpMonitoringMetricDescriptorSummary[]> {
  return unwrap((await rawAwsBridge().listGcpMonitoringMetricDescriptors(projectId, filter)) as Wrapped<GcpMonitoringMetricDescriptorSummary[]>)
}
export async function queryGcpMonitoringTimeSeries(projectId: string, metricType: string, intervalMinutes: number): Promise<GcpMonitoringTimeSeriesResult[]> {
  return unwrap((await rawAwsBridge().queryGcpMonitoringTimeSeries(projectId, metricType, intervalMinutes)) as Wrapped<GcpMonitoringTimeSeriesResult[]>)
}

// Security Command Center
export async function listGcpSccFindings(projectId: string, location?: string, filter?: string): Promise<GcpSccFindingSummary[]> {
  return unwrap((await rawAwsBridge().listGcpSccFindings(projectId, location, filter)) as Wrapped<GcpSccFindingSummary[]>)
}
export async function listGcpSccSources(projectId: string, location?: string): Promise<GcpSccSourceSummary[]> {
  return unwrap((await rawAwsBridge().listGcpSccSources(projectId, location)) as Wrapped<GcpSccSourceSummary[]>)
}
export async function getGcpSccFindingDetail(projectId: string, findingName: string, location?: string): Promise<GcpSccFindingDetail> {
  return unwrap((await rawAwsBridge().getGcpSccFindingDetail(projectId, findingName, location)) as Wrapped<GcpSccFindingDetail>)
}
export async function getGcpSccSeverityBreakdown(projectId: string, location?: string): Promise<GcpSccSeverityBreakdown> {
  return unwrap((await rawAwsBridge().getGcpSccSeverityBreakdown(projectId, location)) as Wrapped<GcpSccSeverityBreakdown>)
}
export async function getGcpSccPostureReport(projectId: string, location?: string): Promise<GcpSccPostureReport> {
  return unwrap((await rawAwsBridge().getGcpSccPostureReport(projectId, location)) as Wrapped<GcpSccPostureReport>)
}

// Firestore
export async function listGcpFirestoreDatabases(projectId: string): Promise<GcpFirestoreDatabaseSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirestoreDatabases(projectId)) as Wrapped<GcpFirestoreDatabaseSummary[]>)
}
export async function listGcpFirestoreCollections(projectId: string, databaseId: string, parentDocumentPath?: string): Promise<GcpFirestoreCollectionSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirestoreCollections(projectId, databaseId, parentDocumentPath)) as Wrapped<GcpFirestoreCollectionSummary[]>)
}
export async function listGcpFirestoreDocuments(projectId: string, databaseId: string, collectionId: string, pageSize?: number): Promise<GcpFirestoreDocumentSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirestoreDocuments(projectId, databaseId, collectionId, pageSize)) as Wrapped<GcpFirestoreDocumentSummary[]>)
}
export async function getGcpFirestoreDocumentDetail(projectId: string, databaseId: string, documentPath: string): Promise<GcpFirestoreDocumentDetail> {
  return unwrap((await rawAwsBridge().getGcpFirestoreDocumentDetail(projectId, databaseId, documentPath)) as Wrapped<GcpFirestoreDocumentDetail>)
}

// ── Cloud Run ──
export async function listGcpCloudRunServices(projectId: string, location: string): Promise<GcpCloudRunServiceSummary[]> {
  return unwrap((await rawAwsBridge().listGcpCloudRunServices(projectId, location)) as Wrapped<GcpCloudRunServiceSummary[]>)
}
export async function listGcpCloudRunRevisions(projectId: string, location: string, serviceId: string): Promise<GcpCloudRunRevisionSummary[]> {
  return unwrap((await rawAwsBridge().listGcpCloudRunRevisions(projectId, location, serviceId)) as Wrapped<GcpCloudRunRevisionSummary[]>)
}
export async function listGcpCloudRunJobs(projectId: string, location: string): Promise<GcpCloudRunJobSummary[]> {
  return unwrap((await rawAwsBridge().listGcpCloudRunJobs(projectId, location)) as Wrapped<GcpCloudRunJobSummary[]>)
}
export async function listGcpCloudRunExecutions(projectId: string, location: string, jobId: string): Promise<GcpCloudRunExecutionSummary[]> {
  return unwrap((await rawAwsBridge().listGcpCloudRunExecutions(projectId, location, jobId)) as Wrapped<GcpCloudRunExecutionSummary[]>)
}
export async function listGcpCloudRunDomainMappings(projectId: string, location: string): Promise<GcpCloudRunDomainMappingSummary[]> {
  return unwrap((await rawAwsBridge().listGcpCloudRunDomainMappings(projectId, location)) as Wrapped<GcpCloudRunDomainMappingSummary[]>)
}

// ── Firebase ──
export async function getGcpFirebaseProject(projectId: string): Promise<GcpFirebaseProjectSummary> {
  return unwrap((await rawAwsBridge().getGcpFirebaseProject(projectId)) as Wrapped<GcpFirebaseProjectSummary>)
}
export async function listGcpFirebaseWebApps(projectId: string): Promise<GcpFirebaseWebAppSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirebaseWebApps(projectId)) as Wrapped<GcpFirebaseWebAppSummary[]>)
}
export async function listGcpFirebaseAndroidApps(projectId: string): Promise<GcpFirebaseAndroidAppSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirebaseAndroidApps(projectId)) as Wrapped<GcpFirebaseAndroidAppSummary[]>)
}
export async function listGcpFirebaseIosApps(projectId: string): Promise<GcpFirebaseIosAppSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirebaseIosApps(projectId)) as Wrapped<GcpFirebaseIosAppSummary[]>)
}
export async function listGcpFirebaseHostingSites(projectId: string): Promise<GcpFirebaseHostingSiteSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirebaseHostingSites(projectId)) as Wrapped<GcpFirebaseHostingSiteSummary[]>)
}
export async function listGcpFirebaseHostingReleases(projectId: string, siteId: string): Promise<GcpFirebaseHostingReleaseSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirebaseHostingReleases(projectId, siteId)) as Wrapped<GcpFirebaseHostingReleaseSummary[]>)
}
export async function listGcpFirebaseHostingDomains(projectId: string, siteId: string): Promise<GcpFirebaseHostingDomainSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirebaseHostingDomains(projectId, siteId)) as Wrapped<GcpFirebaseHostingDomainSummary[]>)
}
export async function listGcpFirebaseHostingChannels(projectId: string, siteId: string): Promise<GcpFirebaseHostingChannelSummary[]> {
  return unwrap((await rawAwsBridge().listGcpFirebaseHostingChannels(projectId, siteId)) as Wrapped<GcpFirebaseHostingChannelSummary[]>)
}

/* ── Cloud DNS ── */
export async function listGcpDnsManagedZones(projectId: string): Promise<GcpDnsManagedZoneSummary[]> {
  return unwrap((await rawAwsBridge().listGcpDnsManagedZones(projectId)) as Wrapped<GcpDnsManagedZoneSummary[]>)
}
export async function listGcpDnsResourceRecordSets(projectId: string, managedZone: string): Promise<GcpDnsResourceRecordSetSummary[]> {
  return unwrap((await rawAwsBridge().listGcpDnsResourceRecordSets(projectId, managedZone)) as Wrapped<GcpDnsResourceRecordSetSummary[]>)
}
export async function createGcpDnsResourceRecordSet(projectId: string, managedZone: string, input: GcpDnsRecordUpsertInput): Promise<void> {
  return unwrap((await rawAwsBridge().createGcpDnsResourceRecordSet(projectId, managedZone, input)) as Wrapped<void>)
}
export async function updateGcpDnsResourceRecordSet(projectId: string, managedZone: string, input: GcpDnsRecordUpsertInput): Promise<void> {
  return unwrap((await rawAwsBridge().updateGcpDnsResourceRecordSet(projectId, managedZone, input)) as Wrapped<void>)
}
export async function deleteGcpDnsResourceRecordSet(projectId: string, managedZone: string, name: string, type: string): Promise<void> {
  return unwrap((await rawAwsBridge().deleteGcpDnsResourceRecordSet(projectId, managedZone, name, type)) as Wrapped<void>)
}

// Memorystore (Redis)
export async function listGcpMemorystoreInstances(projectId: string, location: string): Promise<GcpMemorystoreInstanceSummary[]> {
  return unwrap((await rawAwsBridge().listGcpMemorystoreInstances(projectId, location)) as Wrapped<GcpMemorystoreInstanceSummary[]>)
}
export async function getGcpMemorystoreInstanceDetail(projectId: string, instanceName: string): Promise<GcpMemorystoreInstanceDetail> {
  return unwrap((await rawAwsBridge().getGcpMemorystoreInstanceDetail(projectId, instanceName)) as Wrapped<GcpMemorystoreInstanceDetail>)
}

// Load Balancer + Cloud Armor
export async function listGcpUrlMaps(projectId: string): Promise<GcpUrlMapSummary[]> {
  return unwrap((await rawAwsBridge().listGcpUrlMaps(projectId)) as Wrapped<GcpUrlMapSummary[]>)
}
export async function getGcpUrlMapDetail(projectId: string, urlMapName: string, region?: string): Promise<GcpUrlMapDetail> {
  return unwrap((await rawAwsBridge().getGcpUrlMapDetail(projectId, urlMapName, region)) as Wrapped<GcpUrlMapDetail>)
}
export async function listGcpBackendServices(projectId: string): Promise<GcpBackendServiceSummary[]> {
  return unwrap((await rawAwsBridge().listGcpBackendServices(projectId)) as Wrapped<GcpBackendServiceSummary[]>)
}
export async function listGcpForwardingRules(projectId: string): Promise<GcpForwardingRuleSummary[]> {
  return unwrap((await rawAwsBridge().listGcpForwardingRules(projectId)) as Wrapped<GcpForwardingRuleSummary[]>)
}
export async function listGcpHealthChecks(projectId: string): Promise<GcpHealthCheckSummary[]> {
  return unwrap((await rawAwsBridge().listGcpHealthChecks(projectId)) as Wrapped<GcpHealthCheckSummary[]>)
}
export async function listGcpSecurityPolicies(projectId: string): Promise<GcpSecurityPolicySummary[]> {
  return unwrap((await rawAwsBridge().listGcpSecurityPolicies(projectId)) as Wrapped<GcpSecurityPolicySummary[]>)
}
export async function getGcpSecurityPolicyDetail(projectId: string, policyName: string): Promise<GcpSecurityPolicyDetail> {
  return unwrap((await rawAwsBridge().getGcpSecurityPolicyDetail(projectId, policyName)) as Wrapped<GcpSecurityPolicyDetail>)
}

export async function listAzureSubscriptions(): Promise<AzureSubscriptionSummary[]> {
  return unwrap((await rawAwsBridge().listAzureSubscriptions()) as Wrapped<AzureSubscriptionSummary[]>)
}

export async function listAzureResourceGroups(subscriptionId: string): Promise<AzureResourceGroupSummary[]> {
  return unwrap((await rawAwsBridge().listAzureResourceGroups(subscriptionId)) as Wrapped<AzureResourceGroupSummary[]>)
}

export async function listAzureResourceGroupResources(
  subscriptionId: string,
  resourceGroupName: string
): Promise<AzureResourceGroupResourceSummary[]> {
  return unwrap(
    (await rawAwsBridge().listAzureResourceGroupResources(subscriptionId, resourceGroupName)) as Wrapped<AzureResourceGroupResourceSummary[]>
  )
}

export async function getAzureRbacOverview(subscriptionId: string): Promise<AzureRbacOverview> {
  return unwrap((await rawAwsBridge().getAzureRbacOverview(subscriptionId)) as Wrapped<AzureRbacOverview>)
}

export async function listAzureRoleAssignments(subscriptionId: string): Promise<AzureRoleAssignmentSummary[]> {
  return unwrap((await rawAwsBridge().listAzureRoleAssignments(subscriptionId)) as Wrapped<AzureRoleAssignmentSummary[]>)
}

export async function listAzureRoleDefinitions(subscriptionId: string): Promise<AzureRoleDefinitionSummary[]> {
  return unwrap((await rawAwsBridge().listAzureRoleDefinitions(subscriptionId)) as Wrapped<AzureRoleDefinitionSummary[]>)
}

export async function createAzureRoleAssignment(subscriptionId: string, principalId: string, roleDefinitionId: string, scope: string): Promise<void> {
  return unwrap((await rawAwsBridge().createAzureRoleAssignment(subscriptionId, principalId, roleDefinitionId, scope)) as Wrapped<void>)
}

export async function deleteAzureRoleAssignment(assignmentId: string): Promise<void> {
  return unwrap((await rawAwsBridge().deleteAzureRoleAssignment(assignmentId)) as Wrapped<void>)
}

export async function getAzureDefenderSecureScore(subscriptionId: string): Promise<AzureDefenderSecureScore | null> {
  return unwrap(
    (await rawAwsBridge().getAzureDefenderSecureScore(subscriptionId)) as Wrapped<AzureDefenderSecureScore | null>
  )
}

export async function listAzureDefenderSecureScoreControls(
  subscriptionId: string
): Promise<AzureDefenderSecureScoreControl[]> {
  return unwrap(
    (await rawAwsBridge().listAzureDefenderSecureScoreControls(subscriptionId)) as Wrapped<AzureDefenderSecureScoreControl[]>
  )
}

export async function listAzureDefenderRecommendations(
  subscriptionId: string
): Promise<AzureDefenderRecommendation[]> {
  return unwrap(
    (await rawAwsBridge().listAzureDefenderRecommendations(subscriptionId)) as Wrapped<AzureDefenderRecommendation[]>
  )
}

export async function listAzureDefenderAlerts(subscriptionId: string): Promise<AzureDefenderAlert[]> {
  return unwrap(
    (await rawAwsBridge().listAzureDefenderAlerts(subscriptionId)) as Wrapped<AzureDefenderAlert[]>
  )
}

export async function listAzureDefenderComplianceStandards(
  subscriptionId: string
): Promise<AzureDefenderComplianceStandard[]> {
  return unwrap(
    (await rawAwsBridge().listAzureDefenderComplianceStandards(subscriptionId)) as Wrapped<AzureDefenderComplianceStandard[]>
  )
}

export async function listAzureDefenderAttackPaths(
  subscriptionId: string
): Promise<AzureDefenderAttackPath[]> {
  return unwrap(
    (await rawAwsBridge().listAzureDefenderAttackPaths(subscriptionId)) as Wrapped<AzureDefenderAttackPath[]>
  )
}

export async function getAzureDefenderReport(subscriptionId: string): Promise<AzureDefenderReport> {
  return unwrap(
    (await rawAwsBridge().getAzureDefenderReport(subscriptionId)) as Wrapped<AzureDefenderReport>
  )
}

export async function listAzureVirtualMachines(subscriptionId: string, location: string): Promise<AzureVirtualMachineSummary[]> {
  return unwrap((await rawAwsBridge().listAzureVirtualMachines(subscriptionId, location)) as Wrapped<AzureVirtualMachineSummary[]>)
}

export async function describeAzureVirtualMachine(subscriptionId: string, resourceGroup: string, vmName: string): Promise<AzureVirtualMachineDetail> {
  return unwrap((await rawAwsBridge().describeAzureVirtualMachine(subscriptionId, resourceGroup, vmName)) as Wrapped<AzureVirtualMachineDetail>)
}

export async function runAzureVmAction(subscriptionId: string, resourceGroup: string, vmName: string, action: AzureVmAction): Promise<AzureVmActionResult> {
  return unwrap((await rawAwsBridge().runAzureVmAction(subscriptionId, resourceGroup, vmName, action)) as Wrapped<AzureVmActionResult>)
}

export async function listAzureAksClusters(subscriptionId: string, location: string): Promise<AzureAksClusterSummary[]> {
  return unwrap((await rawAwsBridge().listAzureAksClusters(subscriptionId, location)) as Wrapped<AzureAksClusterSummary[]>)
}

export async function describeAzureAksCluster(subscriptionId: string, resourceGroup: string, clusterName: string): Promise<AzureAksClusterDetail> {
  return unwrap((await rawAwsBridge().describeAzureAksCluster(subscriptionId, resourceGroup, clusterName)) as Wrapped<AzureAksClusterDetail>)
}

export async function listAzureAksNodePools(subscriptionId: string, resourceGroup: string, clusterName: string): Promise<AzureAksNodePoolSummary[]> {
  return unwrap((await rawAwsBridge().listAzureAksNodePools(subscriptionId, resourceGroup, clusterName)) as Wrapped<AzureAksNodePoolSummary[]>)
}

export async function updateAzureAksNodePoolScaling(subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, min: number, desired: number, max: number): Promise<void> {
  return unwrap((await rawAwsBridge().updateAzureAksNodePoolScaling(subscriptionId, resourceGroup, clusterName, nodePoolName, min, desired, max)) as Wrapped<void>)
}

export async function toggleAzureAksNodePoolAutoscaling(subscriptionId: string, resourceGroup: string, clusterName: string, nodePoolName: string, enable: boolean, minCount?: number, maxCount?: number): Promise<void> {
  return unwrap((await rawAwsBridge().toggleAzureAksNodePoolAutoscaling(subscriptionId, resourceGroup, clusterName, nodePoolName, enable, minCount, maxCount)) as Wrapped<void>)
}

export async function addAksToKubeconfig(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  contextName: string,
  kubeconfigPath: string
): Promise<string> {
  return unwrap((await rawAwsBridge().addAksToKubeconfig(subscriptionId, resourceGroup, clusterName, contextName, kubeconfigPath)) as Wrapped<string>)
}

export async function chooseAksKubeconfigPath(currentPath?: string): Promise<string> {
  return unwrap((await rawAwsBridge().chooseAksKubeconfigPath(currentPath)) as Wrapped<string>)
}

export async function listAzureStorageAccounts(subscriptionId: string, location: string): Promise<AzureStorageAccountSummary[]> {
  return unwrap((await rawAwsBridge().listAzureStorageAccounts(subscriptionId, location)) as Wrapped<AzureStorageAccountSummary[]>)
}

export async function listAzureStorageContainers(subscriptionId: string, resourceGroup: string, accountName: string, blobEndpoint = ''): Promise<AzureStorageContainerSummary[]> {
  return unwrap((await rawAwsBridge().listAzureStorageContainers(subscriptionId, resourceGroup, accountName, blobEndpoint)) as Wrapped<AzureStorageContainerSummary[]>)
}

export async function listAzureStorageBlobs(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, prefix: string, blobEndpoint = ''): Promise<AzureStorageBlobSummary[]> {
  return unwrap((await rawAwsBridge().listAzureStorageBlobs(subscriptionId, resourceGroup, accountName, containerName, prefix, blobEndpoint)) as Wrapped<AzureStorageBlobSummary[]>)
}

export async function getAzureStorageBlobContent(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint = ''): Promise<AzureStorageBlobContent> {
  return unwrap((await rawAwsBridge().getAzureStorageBlobContent(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)) as Wrapped<AzureStorageBlobContent>)
}

export async function putAzureStorageBlobContent(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, content: string, blobEndpoint = ''): Promise<void> {
  await unwrap((await rawAwsBridge().putAzureStorageBlobContent(subscriptionId, resourceGroup, accountName, containerName, key, content, blobEndpoint)) as Wrapped<void>)
}

export async function uploadAzureStorageBlob(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, localPath: string, blobEndpoint = ''): Promise<void> {
  await unwrap((await rawAwsBridge().uploadAzureStorageBlob(subscriptionId, resourceGroup, accountName, containerName, key, localPath, blobEndpoint)) as Wrapped<void>)
}

export async function downloadAzureStorageBlobToPath(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint = ''): Promise<string> {
  return unwrap((await rawAwsBridge().downloadAzureStorageBlobToPath(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)) as Wrapped<string>)
}

export async function deleteAzureStorageBlob(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint = ''): Promise<void> {
  await unwrap((await rawAwsBridge().deleteAzureStorageBlob(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)) as Wrapped<void>)
}

export async function createAzureStorageContainer(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, blobEndpoint = ''): Promise<void> {
  await unwrap((await rawAwsBridge().createAzureStorageContainer(subscriptionId, resourceGroup, accountName, containerName, blobEndpoint)) as Wrapped<void>)
}

export async function openAzureStorageBlob(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint = ''): Promise<string> {
  return unwrap((await rawAwsBridge().openAzureStorageBlob(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)) as Wrapped<string>)
}

export async function openAzureStorageBlobInVSCode(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint = ''): Promise<string> {
  return unwrap((await rawAwsBridge().openAzureStorageBlobInVSCode(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)) as Wrapped<string>)
}

export async function getAzureStorageBlobSasUrl(subscriptionId: string, resourceGroup: string, accountName: string, containerName: string, key: string, blobEndpoint = ''): Promise<string> {
  return unwrap((await rawAwsBridge().getAzureStorageBlobSasUrl(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)) as Wrapped<string>)
}

export async function getAzureSqlEstate(subscriptionId: string, location: string): Promise<AzureSqlEstateOverview> {
  return unwrap((await rawAwsBridge().getAzureSqlEstate(subscriptionId, location)) as Wrapped<AzureSqlEstateOverview>)
}

export async function describeAzureSqlServer(subscriptionId: string, resourceGroup: string, serverName: string): Promise<AzureSqlServerDetail> {
  return unwrap((await rawAwsBridge().describeAzureSqlServer(subscriptionId, resourceGroup, serverName)) as Wrapped<AzureSqlServerDetail>)
}

export async function getAzurePostgreSqlEstate(subscriptionId: string, location: string): Promise<AzurePostgreSqlEstateOverview> {
  return unwrap((await rawAwsBridge().getAzurePostgreSqlEstate(subscriptionId, location)) as Wrapped<AzurePostgreSqlEstateOverview>)
}

export async function describeAzurePostgreSqlServer(subscriptionId: string, resourceGroup: string, serverName: string): Promise<AzurePostgreSqlServerDetail> {
  return unwrap((await rawAwsBridge().describeAzurePostgreSqlServer(subscriptionId, resourceGroup, serverName)) as Wrapped<AzurePostgreSqlServerDetail>)
}

export async function listAzureMonitorActivity(subscriptionId: string, location: string, query: string, windowHours?: number): Promise<AzureMonitorActivityResult> {
  return unwrap((await rawAwsBridge().listAzureMonitorActivity(subscriptionId, location, query, windowHours)) as Wrapped<AzureMonitorActivityResult>)
}

export async function getAzureCostOverview(subscriptionId: string): Promise<AzureCostOverview> {
  return unwrap((await rawAwsBridge().getAzureCostOverview(subscriptionId)) as Wrapped<AzureCostOverview>)
}

export async function getAzureNetworkOverview(subscriptionId: string, location: string): Promise<AzureNetworkOverview> {
  return unwrap((await rawAwsBridge().getAzureNetworkOverview(subscriptionId, location)) as Wrapped<AzureNetworkOverview>)
}

export async function listAzureVNetSubnets(subscriptionId: string, resourceGroup: string, vnetName: string): Promise<AzureSubnetSummary[]> {
  return unwrap((await rawAwsBridge().listAzureVNetSubnets(subscriptionId, resourceGroup, vnetName)) as Wrapped<AzureSubnetSummary[]>)
}

export async function listAzureNsgRules(subscriptionId: string, resourceGroup: string, nsgName: string): Promise<AzureNsgRuleSummary[]> {
  return unwrap((await rawAwsBridge().listAzureNsgRules(subscriptionId, resourceGroup, nsgName)) as Wrapped<AzureNsgRuleSummary[]>)
}

export async function listAzureVmss(subscriptionId: string, location: string): Promise<AzureVmssSummary[]> {
  return unwrap((await rawAwsBridge().listAzureVmss(subscriptionId, location)) as Wrapped<AzureVmssSummary[]>)
}

export async function listAzureVmssInstances(subscriptionId: string, resourceGroup: string, vmssName: string): Promise<AzureVmssInstanceSummary[]> {
  return unwrap((await rawAwsBridge().listAzureVmssInstances(subscriptionId, resourceGroup, vmssName)) as Wrapped<AzureVmssInstanceSummary[]>)
}

export async function updateAzureVmssCapacity(subscriptionId: string, resourceGroup: string, vmssName: string, capacity: number): Promise<AzureVmssActionResult> {
  return unwrap((await rawAwsBridge().updateAzureVmssCapacity(subscriptionId, resourceGroup, vmssName, capacity)) as Wrapped<AzureVmssActionResult>)
}

export async function runAzureVmssInstanceAction(subscriptionId: string, resourceGroup: string, vmssName: string, instanceId: string, action: string): Promise<AzureVmssActionResult> {
  return unwrap((await rawAwsBridge().runAzureVmssInstanceAction(subscriptionId, resourceGroup, vmssName, instanceId, action)) as Wrapped<AzureVmssActionResult>)
}

/* ── Application Insights ── */

export async function listAzureAppInsightsComponents(subscriptionId: string, location: string): Promise<AzureAppInsightsSummary[]> {
  return unwrap((await rawAwsBridge().listAzureAppInsightsComponents(subscriptionId, location)) as Wrapped<AzureAppInsightsSummary[]>)
}

/* ── Key Vault ── */

export async function listAzureKeyVaults(subscriptionId: string, location: string): Promise<AzureKeyVaultSummary[]> {
  return unwrap((await rawAwsBridge().listAzureKeyVaults(subscriptionId, location)) as Wrapped<AzureKeyVaultSummary[]>)
}

export async function describeAzureKeyVault(subscriptionId: string, resourceGroup: string, vaultName: string): Promise<AzureKeyVaultSummary> {
  return unwrap((await rawAwsBridge().describeAzureKeyVault(subscriptionId, resourceGroup, vaultName)) as Wrapped<AzureKeyVaultSummary>)
}

export async function listAzureKeyVaultSecrets(subscriptionId: string, resourceGroup: string, vaultName: string): Promise<AzureKeyVaultSecretSummary[]> {
  return unwrap((await rawAwsBridge().listAzureKeyVaultSecrets(subscriptionId, resourceGroup, vaultName)) as Wrapped<AzureKeyVaultSecretSummary[]>)
}

export async function listAzureKeyVaultKeys(subscriptionId: string, resourceGroup: string, vaultName: string): Promise<AzureKeyVaultKeySummary[]> {
  return unwrap((await rawAwsBridge().listAzureKeyVaultKeys(subscriptionId, resourceGroup, vaultName)) as Wrapped<AzureKeyVaultKeySummary[]>)
}

/* ── Event Hub ── */

export async function listAzureEventHubNamespaces(subscriptionId: string, location: string): Promise<AzureEventHubNamespaceSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventHubNamespaces(subscriptionId, location)) as Wrapped<AzureEventHubNamespaceSummary[]>)
}

export async function listAzureEventHubs(subscriptionId: string, resourceGroup: string, namespaceName: string): Promise<AzureEventHubSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventHubs(subscriptionId, resourceGroup, namespaceName)) as Wrapped<AzureEventHubSummary[]>)
}

export async function listAzureEventHubConsumerGroups(subscriptionId: string, resourceGroup: string, namespaceName: string, eventHubName: string): Promise<AzureEventHubConsumerGroupSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventHubConsumerGroups(subscriptionId, resourceGroup, namespaceName, eventHubName)) as Wrapped<AzureEventHubConsumerGroupSummary[]>)
}

/* ── App Service ── */

export async function listAzureAppServicePlans(subscriptionId: string, location: string): Promise<AzureAppServicePlanSummary[]> {
  return unwrap((await rawAwsBridge().listAzureAppServicePlans(subscriptionId, location)) as Wrapped<AzureAppServicePlanSummary[]>)
}

export async function listAzureWebApps(subscriptionId: string, location: string): Promise<AzureWebAppSummary[]> {
  return unwrap((await rawAwsBridge().listAzureWebApps(subscriptionId, location)) as Wrapped<AzureWebAppSummary[]>)
}

export async function describeAzureWebApp(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureWebAppSummary> {
  return unwrap((await rawAwsBridge().describeAzureWebApp(subscriptionId, resourceGroup, siteName)) as Wrapped<AzureWebAppSummary>)
}

export async function listAzureWebAppSlots(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureWebAppSlotSummary[]> {
  return unwrap((await rawAwsBridge().listAzureWebAppSlots(subscriptionId, resourceGroup, siteName)) as Wrapped<AzureWebAppSlotSummary[]>)
}

export async function listAzureWebAppDeployments(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureWebAppDeploymentSummary[]> {
  return unwrap((await rawAwsBridge().listAzureWebAppDeployments(subscriptionId, resourceGroup, siteName)) as Wrapped<AzureWebAppDeploymentSummary[]>)
}

/* ── Managed Disks ── */

export async function listAzureManagedDisks(subscriptionId: string, location: string): Promise<AzureManagedDiskSummary[]> {
  return unwrap((await rawAwsBridge().listAzureManagedDisks(subscriptionId, location)) as Wrapped<AzureManagedDiskSummary[]>)
}

export async function listAzureDiskSnapshots(subscriptionId: string, location: string): Promise<AzureDiskSnapshotSummary[]> {
  return unwrap((await rawAwsBridge().listAzureDiskSnapshots(subscriptionId, location)) as Wrapped<AzureDiskSnapshotSummary[]>)
}

/* ── Network Enrichment ── */

export async function listAzureVNetPeerings(subscriptionId: string, resourceGroup: string, vnetName: string): Promise<AzureVNetPeeringSummary[]> {
  return unwrap((await rawAwsBridge().listAzureVNetPeerings(subscriptionId, resourceGroup, vnetName)) as Wrapped<AzureVNetPeeringSummary[]>)
}

export async function listAzureRouteTables(subscriptionId: string, location: string): Promise<AzureRouteTableSummary[]> {
  return unwrap((await rawAwsBridge().listAzureRouteTables(subscriptionId, location)) as Wrapped<AzureRouteTableSummary[]>)
}

export async function listAzureNatGateways(subscriptionId: string, location: string): Promise<AzureNatGatewaySummary[]> {
  return unwrap((await rawAwsBridge().listAzureNatGateways(subscriptionId, location)) as Wrapped<AzureNatGatewaySummary[]>)
}

export async function listAzureLoadBalancers(subscriptionId: string, location: string): Promise<AzureLoadBalancerSummary[]> {
  return unwrap((await rawAwsBridge().listAzureLoadBalancers(subscriptionId, location)) as Wrapped<AzureLoadBalancerSummary[]>)
}

export async function listAzurePrivateEndpoints(subscriptionId: string, location: string): Promise<AzurePrivateEndpointSummary[]> {
  return unwrap((await rawAwsBridge().listAzurePrivateEndpoints(subscriptionId, location)) as Wrapped<AzurePrivateEndpointSummary[]>)
}

/* ── Azure Firewall ── */
export async function listAzureFirewalls(subscriptionId: string, location: string): Promise<AzureFirewallSummary[]> {
  return unwrap((await rawAwsBridge().listAzureFirewalls(subscriptionId, location)) as Wrapped<AzureFirewallSummary[]>)
}
export async function describeAzureFirewall(subscriptionId: string, resourceGroup: string, firewallName: string): Promise<AzureFirewallDetail> {
  return unwrap((await rawAwsBridge().describeAzureFirewall(subscriptionId, resourceGroup, firewallName)) as Wrapped<AzureFirewallDetail>)
}

/* ── Azure Load Balancers (detail) ── */
export async function describeAzureLoadBalancer(subscriptionId: string, resourceGroup: string, lbName: string): Promise<AzureLoadBalancerDetail> {
  return unwrap((await rawAwsBridge().describeAzureLoadBalancer(subscriptionId, resourceGroup, lbName)) as Wrapped<AzureLoadBalancerDetail>)
}

/* ── Azure DNS ── */
export async function listAzureDnsZones(subscriptionId: string, location: string): Promise<AzureDnsZoneSummary[]> {
  return unwrap((await rawAwsBridge().listAzureDnsZones(subscriptionId, location)) as Wrapped<AzureDnsZoneSummary[]>)
}
export async function listAzureDnsRecordSets(subscriptionId: string, resourceGroup: string, zoneName: string): Promise<AzureDnsRecordSummary[]> {
  return unwrap((await rawAwsBridge().listAzureDnsRecordSets(subscriptionId, resourceGroup, zoneName)) as Wrapped<AzureDnsRecordSummary[]>)
}
export async function upsertAzureDnsRecord(subscriptionId: string, resourceGroup: string, zoneName: string, input: AzureDnsRecordUpsertInput): Promise<void> {
  return unwrap((await rawAwsBridge().upsertAzureDnsRecord(subscriptionId, resourceGroup, zoneName, input)) as Wrapped<void>)
}
export async function deleteAzureDnsRecord(subscriptionId: string, resourceGroup: string, zoneName: string, recordType: string, recordName: string): Promise<void> {
  return unwrap((await rawAwsBridge().deleteAzureDnsRecord(subscriptionId, resourceGroup, zoneName, recordType, recordName)) as Wrapped<void>)
}
export async function createAzureDnsZone(subscriptionId: string, resourceGroup: string, zoneName: string, zoneType: 'Public' | 'Private'): Promise<AzureDnsZoneSummary> {
  return unwrap((await rawAwsBridge().createAzureDnsZone(subscriptionId, resourceGroup, zoneName, zoneType)) as Wrapped<AzureDnsZoneSummary>)
}

/* ── Storage Enrichment ── */

export async function listAzureStorageFileShares(subscriptionId: string, resourceGroup: string, accountName: string): Promise<AzureStorageFileShareSummary[]> {
  return unwrap((await rawAwsBridge().listAzureStorageFileShares(subscriptionId, resourceGroup, accountName)) as Wrapped<AzureStorageFileShareSummary[]>)
}

export async function listAzureStorageQueues(subscriptionId: string, resourceGroup: string, accountName: string): Promise<AzureStorageQueueSummary[]> {
  return unwrap((await rawAwsBridge().listAzureStorageQueues(subscriptionId, resourceGroup, accountName)) as Wrapped<AzureStorageQueueSummary[]>)
}

export async function listAzureStorageTables(subscriptionId: string, resourceGroup: string, accountName: string): Promise<AzureStorageTableSummary[]> {
  return unwrap((await rawAwsBridge().listAzureStorageTables(subscriptionId, resourceGroup, accountName)) as Wrapped<AzureStorageTableSummary[]>)
}

/* ── MySQL ── */

export async function getAzureMySqlEstate(subscriptionId: string, location: string): Promise<AzureMySqlEstateOverview> {
  return unwrap((await rawAwsBridge().getAzureMySqlEstate(subscriptionId, location)) as Wrapped<AzureMySqlEstateOverview>)
}

export async function describeAzureMySqlServer(subscriptionId: string, resourceGroup: string, serverName: string): Promise<AzureMySqlServerDetail> {
  return unwrap((await rawAwsBridge().describeAzureMySqlServer(subscriptionId, resourceGroup, serverName)) as Wrapped<AzureMySqlServerDetail>)
}

/* ── Cosmos DB ── */

export async function getAzureCosmosDbEstate(subscriptionId: string, location: string): Promise<AzureCosmosDbEstateOverview> {
  return unwrap((await rawAwsBridge().getAzureCosmosDbEstate(subscriptionId, location)) as Wrapped<AzureCosmosDbEstateOverview>)
}

export async function describeAzureCosmosDbAccount(subscriptionId: string, resourceGroup: string, accountName: string): Promise<AzureCosmosDbAccountDetail> {
  return unwrap((await rawAwsBridge().describeAzureCosmosDbAccount(subscriptionId, resourceGroup, accountName)) as Wrapped<AzureCosmosDbAccountDetail>)
}

/* ── App Service / Functions Enrichment ── */

export async function listAzureFunctionApps(subscriptionId: string, location: string): Promise<AzureFunctionAppSummary[]> {
  return unwrap((await rawAwsBridge().listAzureFunctionApps(subscriptionId, location)) as Wrapped<AzureFunctionAppSummary[]>)
}

export async function listAzureFunctions(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureFunctionSummary[]> {
  return unwrap((await rawAwsBridge().listAzureFunctions(subscriptionId, resourceGroup, siteName)) as Wrapped<AzureFunctionSummary[]>)
}

export async function getAzureWebAppConfiguration(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureWebAppConfigSummary> {
  return unwrap((await rawAwsBridge().getAzureWebAppConfiguration(subscriptionId, resourceGroup, siteName)) as Wrapped<AzureWebAppConfigSummary>)
}

export async function runAzureWebAppAction(subscriptionId: string, resourceGroup: string, siteName: string, action: AzureWebAppAction): Promise<AzureWebAppActionResult> {
  return unwrap((await rawAwsBridge().runAzureWebAppAction(subscriptionId, resourceGroup, siteName, action)) as Wrapped<AzureWebAppActionResult>)
}

/* ── Log Analytics ── */

export async function listAzureLogAnalyticsWorkspaces(subscriptionId: string, location: string): Promise<AzureLogAnalyticsWorkspaceSummary[]> {
  return unwrap((await rawAwsBridge().listAzureLogAnalyticsWorkspaces(subscriptionId, location)) as Wrapped<AzureLogAnalyticsWorkspaceSummary[]>)
}

export async function queryAzureLogAnalytics(workspaceId: string, query: string, timespan?: string): Promise<AzureLogAnalyticsQueryResult> {
  return unwrap((await rawAwsBridge().queryAzureLogAnalytics(workspaceId, query, timespan)) as Wrapped<AzureLogAnalyticsQueryResult>)
}

export async function listAzureLogAnalyticsSavedSearches(subscriptionId: string, resourceGroup: string, workspaceName: string): Promise<AzureLogAnalyticsSavedSearch[]> {
  return unwrap((await rawAwsBridge().listAzureLogAnalyticsSavedSearches(subscriptionId, resourceGroup, workspaceName)) as Wrapped<AzureLogAnalyticsSavedSearch[]>)
}

export async function listAzureLogAnalyticsLinkedServices(subscriptionId: string, resourceGroup: string, workspaceName: string): Promise<AzureLogAnalyticsLinkedService[]> {
  return unwrap((await rawAwsBridge().listAzureLogAnalyticsLinkedServices(subscriptionId, resourceGroup, workspaceName)) as Wrapped<AzureLogAnalyticsLinkedService[]>)
}

/* ── Event Grid ── */

export async function listAzureEventGridTopics(subscriptionId: string, location: string): Promise<AzureEventGridTopicSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventGridTopics(subscriptionId, location)) as Wrapped<AzureEventGridTopicSummary[]>)
}

export async function listAzureEventGridSystemTopics(subscriptionId: string, location: string): Promise<AzureEventGridSystemTopicSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventGridSystemTopics(subscriptionId, location)) as Wrapped<AzureEventGridSystemTopicSummary[]>)
}

export async function listAzureEventGridEventSubscriptions(subscriptionId: string): Promise<AzureEventGridEventSubscriptionSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventGridEventSubscriptions(subscriptionId)) as Wrapped<AzureEventGridEventSubscriptionSummary[]>)
}

export async function listAzureEventGridDomains(subscriptionId: string, location: string): Promise<AzureEventGridDomainSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventGridDomains(subscriptionId, location)) as Wrapped<AzureEventGridDomainSummary[]>)
}

export async function listAzureEventGridDomainTopics(subscriptionId: string, resourceGroup: string, domainName: string): Promise<AzureEventGridDomainTopicSummary[]> {
  return unwrap((await rawAwsBridge().listAzureEventGridDomainTopics(subscriptionId, resourceGroup, domainName)) as Wrapped<AzureEventGridDomainTopicSummary[]>)
}

export async function checkForAppUpdates(): Promise<AppReleaseInfo> {
  return unwrap((await rawAwsBridge().checkForAppUpdates()) as Wrapped<AppReleaseInfo>)
}

export async function downloadAppUpdate(): Promise<AppReleaseInfo> {
  return unwrap((await rawAwsBridge().downloadAppUpdate()) as Wrapped<AppReleaseInfo>)
}

export async function installAppUpdate(): Promise<AppReleaseInfo> {
  return unwrap((await rawAwsBridge().installAppUpdate()) as Wrapped<AppReleaseInfo>)
}

export async function exportDiagnosticsBundle(snapshot?: AppDiagnosticsSnapshot): Promise<AppDiagnosticsExportResult> {
  return unwrap((await rawAwsBridge().exportDiagnosticsBundle(snapshot)) as Wrapped<AppDiagnosticsExportResult>)
}

export async function setAppDiagnosticsActiveContext(snapshot: AppDiagnosticsSnapshot): Promise<void> {
  return unwrap((await rawAwsBridge().setAppDiagnosticsActiveContext(snapshot)) as Wrapped<void>)
}

export async function recordAppDiagnosticsFailure(input: AppDiagnosticsFailureInput): Promise<void> {
  return unwrap((await rawAwsBridge().recordAppDiagnosticsFailure(input)) as Wrapped<void>)
}

export async function openPath(targetPath: string): Promise<void> {
  await rawAwsBridge().openPath(targetPath)
}

export async function getCallerIdentity(connection: AwsConnection): Promise<CallerIdentity> {
  return unwrap((await awsBridge().getCallerIdentity(connection)) as Wrapped<CallerIdentity>)
}

export async function listEc2Instances(connection: AwsConnection): Promise<Ec2InstanceSummary[]> {
  return unwrap((await awsBridge().listEc2Instances(connection)) as Wrapped<Ec2InstanceSummary[]>)
}

export async function describeEc2Instance(connection: AwsConnection, instanceId: string): Promise<Ec2InstanceDetail> {
  return unwrap((await awsBridge().describeEc2Instance(connection, instanceId)) as Wrapped<Ec2InstanceDetail>)
}

export async function listSsmManagedInstances(connection: AwsConnection): Promise<SsmManagedInstanceSummary[]> {
  return unwrap((await awsBridge().listSsmManagedInstances(connection)) as Wrapped<SsmManagedInstanceSummary[]>)
}

export async function getSsmConnectionTarget(connection: AwsConnection, instanceId: string): Promise<SsmConnectionTarget> {
  return unwrap((await awsBridge().getSsmConnectionTarget(connection, instanceId)) as Wrapped<SsmConnectionTarget>)
}

export async function listSsmSessions(connection: AwsConnection, targetInstanceId?: string): Promise<SsmSessionSummary[]> {
  return unwrap((await awsBridge().listSsmSessions(connection, targetInstanceId)) as Wrapped<SsmSessionSummary[]>)
}

export async function startSsmSession(connection: AwsConnection, request: SsmStartSessionRequest): Promise<SsmSessionLaunchSpec> {
  return unwrap((await awsBridge().startSsmSession(connection, request)) as Wrapped<SsmSessionLaunchSpec>)
}

export async function sendSsmCommand(connection: AwsConnection, request: SsmSendCommandRequest): Promise<SsmCommandExecutionResult> {
  return unwrap((await awsBridge().sendSsmCommand(connection, request)) as Wrapped<SsmCommandExecutionResult>)
}

export async function listEcrRepositories(connection: AwsConnection): Promise<EcrRepositorySummary[]> {
  return unwrap((await awsBridge().listEcrRepositories(connection)) as Wrapped<EcrRepositorySummary[]>)
}

export async function listEcrImages(connection: AwsConnection, repositoryName: string): Promise<EcrImageSummary[]> {
  return unwrap((await awsBridge().listEcrImages(connection, repositoryName)) as Wrapped<EcrImageSummary[]>)
}

export async function createEcrRepository(connection: AwsConnection, repositoryName: string, imageTagMutability: string, scanOnPush: boolean): Promise<string> {
  return unwrap((await awsBridge().createEcrRepository(connection, repositoryName, imageTagMutability, scanOnPush)) as Wrapped<string>)
}

export async function deleteEcrRepository(connection: AwsConnection, repositoryName: string, force: boolean): Promise<void> {
  return unwrap((await awsBridge().deleteEcrRepository(connection, repositoryName, force)) as Wrapped<void>)
}

export async function deleteEcrImage(connection: AwsConnection, repositoryName: string, imageDigest: string): Promise<void> {
  return unwrap((await awsBridge().deleteEcrImage(connection, repositoryName, imageDigest)) as Wrapped<void>)
}

export async function startEcrImageScan(connection: AwsConnection, repositoryName: string, imageDigest: string, imageTag?: string): Promise<void> {
  return unwrap((await awsBridge().startEcrImageScan(connection, repositoryName, imageDigest, imageTag)) as Wrapped<void>)
}

export async function getEcrScanFindings(connection: AwsConnection, repositoryName: string, imageDigest: string): Promise<EcrScanResult> {
  return unwrap((await awsBridge().getEcrScanFindings(connection, repositoryName, imageDigest)) as Wrapped<EcrScanResult>)
}

export async function getEcrAuthorizationToken(connection: AwsConnection): Promise<EcrAuthorizationData> {
  return unwrap((await awsBridge().getEcrAuthorizationToken(connection)) as Wrapped<EcrAuthorizationData>)
}

export async function ecrDockerLogin(connection: AwsConnection): Promise<string> {
  return unwrap((await awsBridge().ecrDockerLogin(connection)) as Wrapped<string>)
}

export async function ecrDockerPull(repositoryUri: string, tag: string): Promise<string> {
  return unwrap((await awsBridge().ecrDockerPull(repositoryUri, tag)) as Wrapped<string>)
}

export async function ecrDockerPush(localImage: string, repositoryUri: string, tag: string): Promise<string> {
  return unwrap((await awsBridge().ecrDockerPush(localImage, repositoryUri, tag)) as Wrapped<string>)
}

export async function listEksClusters(connection: AwsConnection): Promise<EksClusterSummary[]> {
  return unwrap((await awsBridge().listEksClusters(connection)) as Wrapped<EksClusterSummary[]>)
}

export async function describeEksCluster(connection: AwsConnection, clusterName: string): Promise<EksClusterDetail> {
  return unwrap((await awsBridge().describeEksCluster(connection, clusterName)) as Wrapped<EksClusterDetail>)
}

export async function listEksNodegroups(connection: AwsConnection, clusterName: string): Promise<EksNodegroupSummary[]> {
  return unwrap((await awsBridge().listEksNodegroups(connection, clusterName)) as Wrapped<EksNodegroupSummary[]>)
}

export async function updateEksNodegroupScaling(
  connection: AwsConnection,
  clusterName: string,
  nodegroupName: string,
  min: number,
  desired: number,
  max: number
): Promise<void> {
  return unwrap((await awsBridge().updateEksNodegroupScaling(connection, clusterName, nodegroupName, min, desired, max)) as Wrapped<void>)
}

export async function listEksUpdates(connection: AwsConnection, clusterName: string): Promise<EksUpdateEvent[]> {
  return unwrap((await awsBridge().listEksUpdates(connection, clusterName)) as Wrapped<EksUpdateEvent[]>)
}

export async function deleteEksCluster(connection: AwsConnection, clusterName: string): Promise<void> {
  return unwrap((await awsBridge().deleteEksCluster(connection, clusterName)) as Wrapped<void>)
}

export async function addEksToKubeconfig(
  connection: AwsConnection,
  clusterName: string,
  contextName: string,
  kubeconfigPath: string
): Promise<string> {
  return unwrap((await awsBridge().addEksToKubeconfig(connection, clusterName, contextName, kubeconfigPath)) as Wrapped<string>)
}

export async function chooseEksKubeconfigPath(currentPath?: string): Promise<string> {
  return unwrap((await rawAwsBridge().chooseEksKubeconfigPath(currentPath)) as Wrapped<string>)
}

export async function launchKubectlTerminal(connection: AwsConnection, clusterName: string): Promise<void> {
  return unwrap((await awsBridge().launchKubectlTerminal(connection, clusterName)) as Wrapped<void>)
}

export async function prepareEksKubectlSession(
  connection: AwsConnection,
  clusterName: string
): Promise<{ path: string; output: string }> {
  return unwrap((await awsBridge().prepareEksKubectlSession(connection, clusterName)) as Wrapped<{ path: string; output: string }>)
}

export async function runEksCommand(
  connection: AwsConnection,
  clusterName: string,
  kubeconfigPath: string,
  command: string
): Promise<string> {
  return unwrap((await awsBridge().runEksCommand(connection, clusterName, kubeconfigPath, command)) as Wrapped<string>)
}

export async function getEksObservabilityReport(connection: AwsConnection, clusterName: string): Promise<ObservabilityPostureReport> {
  return unwrap((await awsBridge().getEksObservabilityReport(connection, clusterName)) as Wrapped<ObservabilityPostureReport>)
}

export async function listEcsClusters(connection: AwsConnection): Promise<EcsClusterSummary[]> {
  return unwrap((await awsBridge().listEcsClusters(connection)) as Wrapped<EcsClusterSummary[]>)
}

export async function listEcsServices(connection: AwsConnection, clusterArn: string): Promise<EcsServiceSummary[]> {
  return unwrap((await awsBridge().listEcsServices(connection, clusterArn)) as Wrapped<EcsServiceSummary[]>)
}

export async function describeEcsService(connection: AwsConnection, clusterArn: string, serviceName: string): Promise<EcsServiceDetail> {
  return unwrap((await awsBridge().describeEcsService(connection, clusterArn, serviceName)) as Wrapped<EcsServiceDetail>)
}

export async function getEcsDiagnostics(connection: AwsConnection, clusterArn: string, serviceName: string): Promise<EcsServiceDiagnostics> {
  return unwrap((await awsBridge().getEcsDiagnostics(connection, clusterArn, serviceName)) as Wrapped<EcsServiceDiagnostics>)
}

export async function getEcsObservabilityReport(connection: AwsConnection, clusterArn: string, serviceName: string): Promise<ObservabilityPostureReport> {
  return unwrap((await awsBridge().getEcsObservabilityReport(connection, clusterArn, serviceName)) as Wrapped<ObservabilityPostureReport>)
}

export async function listEcsTasks(connection: AwsConnection, clusterArn: string, serviceName?: string): Promise<EcsTaskSummary[]> {
  return unwrap((await awsBridge().listEcsTasks(connection, clusterArn, serviceName)) as Wrapped<EcsTaskSummary[]>)
}

export async function updateEcsDesiredCount(connection: AwsConnection, clusterArn: string, serviceName: string, desiredCount: number): Promise<void> {
  return unwrap((await awsBridge().updateEcsDesiredCount(connection, clusterArn, serviceName, desiredCount)) as Wrapped<void>)
}

export async function forceEcsRedeploy(connection: AwsConnection, clusterArn: string, serviceName: string): Promise<void> {
  return unwrap((await awsBridge().forceEcsRedeploy(connection, clusterArn, serviceName)) as Wrapped<void>)
}

export async function stopEcsTask(connection: AwsConnection, clusterArn: string, taskArn: string, reason?: string): Promise<void> {
  return unwrap((await awsBridge().stopEcsTask(connection, clusterArn, taskArn, reason)) as Wrapped<void>)
}

export async function getEcsContainerLogs(connection: AwsConnection, logGroup: string, logStream: string, startTime?: number): Promise<EcsLogEvent[]> {
  return unwrap((await awsBridge().getEcsContainerLogs(connection, logGroup, logStream, startTime)) as Wrapped<EcsLogEvent[]>)
}

export async function listVpcs(connection: AwsConnection): Promise<VpcSummary[]> {
  return unwrap((await awsBridge().listVpcs(connection)) as Wrapped<VpcSummary[]>)
}

export async function listSubnets(connection: AwsConnection, vpcId?: string): Promise<SubnetSummary[]> {
  return unwrap((await awsBridge().listSubnets(connection, vpcId)) as Wrapped<SubnetSummary[]>)
}

export async function listRouteTables(connection: AwsConnection, vpcId?: string): Promise<RouteTableSummary[]> {
  return unwrap((await awsBridge().listRouteTables(connection, vpcId)) as Wrapped<RouteTableSummary[]>)
}

export async function listInternetGateways(connection: AwsConnection, vpcId?: string): Promise<InternetGatewaySummary[]> {
  return unwrap((await awsBridge().listInternetGateways(connection, vpcId)) as Wrapped<InternetGatewaySummary[]>)
}

export async function listNatGateways(connection: AwsConnection, vpcId?: string): Promise<NatGatewaySummary[]> {
  return unwrap((await awsBridge().listNatGateways(connection, vpcId)) as Wrapped<NatGatewaySummary[]>)
}

export async function listTransitGateways(connection: AwsConnection): Promise<TransitGatewaySummary[]> {
  return unwrap((await awsBridge().listTransitGateways(connection)) as Wrapped<TransitGatewaySummary[]>)
}

export async function listNetworkInterfaces(connection: AwsConnection, vpcId?: string): Promise<NetworkInterfaceSummary[]> {
  return unwrap((await awsBridge().listNetworkInterfaces(connection, vpcId)) as Wrapped<NetworkInterfaceSummary[]>)
}

export async function listSecurityGroupsForVpc(connection: AwsConnection, vpcId?: string): Promise<SecurityGroupSummary[]> {
  return unwrap((await awsBridge().listSecurityGroupsForVpc(connection, vpcId)) as Wrapped<SecurityGroupSummary[]>)
}

export async function describeSecurityGroup(connection: AwsConnection, groupId: string): Promise<SecurityGroupDetail> {
  return unwrap((await awsBridge().describeSecurityGroup(connection, groupId)) as Wrapped<SecurityGroupDetail>)
}

export async function getVpcTopology(connection: AwsConnection, vpcId: string): Promise<VpcTopology> {
  return unwrap((await awsBridge().getVpcTopology(connection, vpcId)) as Wrapped<VpcTopology>)
}

export async function getVpcFlowDiagram(connection: AwsConnection, vpcId: string): Promise<VpcFlowDiagramData> {
  return unwrap((await awsBridge().getVpcFlowDiagram(connection, vpcId)) as Wrapped<VpcFlowDiagramData>)
}

export async function updateSubnetPublicIp(connection: AwsConnection, subnetId: string, mapPublic: boolean): Promise<void> {
  return unwrap((await awsBridge().updateSubnetPublicIp(connection, subnetId, mapPublic)) as Wrapped<void>)
}

export async function createReachabilityPath(connection: AwsConnection, sourceId: string, destId: string, protocol: string): Promise<ReachabilityPathResult> {
  return unwrap((await awsBridge().createReachabilityPath(connection, sourceId, destId, protocol)) as Wrapped<ReachabilityPathResult>)
}

export async function getReachabilityAnalysis(connection: AwsConnection, analysisId: string): Promise<ReachabilityPathResult> {
  return unwrap((await awsBridge().getReachabilityAnalysis(connection, analysisId)) as Wrapped<ReachabilityPathResult>)
}

export async function listCloudWatchMetrics(
  connection: AwsConnection
): Promise<{ metrics: CloudWatchMetricSummary[]; namespaces: CloudWatchNamespaceSummary[] }> {
  return unwrap(
    (await awsBridge().listCloudWatchMetrics(connection)) as Wrapped<{
      metrics: CloudWatchMetricSummary[]
      namespaces: CloudWatchNamespaceSummary[]
    }>
  )
}

export async function getEc2MetricSeries(connection: AwsConnection, instanceId: string): Promise<CloudWatchMetricSeries[]> {
  return unwrap((await awsBridge().getEc2MetricSeries(connection, instanceId)) as Wrapped<CloudWatchMetricSeries[]>)
}

export async function listCloudWatchLogGroups(connection: AwsConnection): Promise<CloudWatchLogGroupSummary[]> {
  return unwrap((await awsBridge().listCloudWatchLogGroups(connection)) as Wrapped<CloudWatchLogGroupSummary[]>)
}

export async function listCloudWatchRecentEvents(connection: AwsConnection, logGroupName: string, periodHours?: number): Promise<CloudWatchLogEventSummary[]> {
  return unwrap((await awsBridge().listCloudWatchRecentEvents(connection, logGroupName, periodHours)) as Wrapped<CloudWatchLogEventSummary[]>)
}

export async function listEc2InstanceMetrics(connection: AwsConnection, instanceId: string): Promise<CloudWatchMetricSummary[]> {
  return unwrap((await awsBridge().listEc2InstanceMetrics(connection, instanceId)) as Wrapped<CloudWatchMetricSummary[]>)
}

export async function getMetricStatistics(connection: AwsConnection, metrics: CloudWatchMetricSummary[], periodHours: number): Promise<CloudWatchMetricStatistic[]> {
  return unwrap((await awsBridge().getMetricStatistics(connection, metrics, periodHours)) as Wrapped<CloudWatchMetricStatistic[]>)
}

export async function getEc2AllMetricSeries(connection: AwsConnection, instanceId: string, periodHours: number): Promise<CloudWatchMetricSeries[]> {
  return unwrap((await awsBridge().getEc2AllMetricSeries(connection, instanceId, periodHours)) as Wrapped<CloudWatchMetricSeries[]>)
}

export async function runCloudWatchQuery(connection: AwsConnection, input: CloudWatchQueryExecutionInput): Promise<CloudWatchQueryExecutionResult> {
  return unwrap((await awsBridge().runCloudWatchQuery(connection, input)) as Wrapped<CloudWatchQueryExecutionResult>)
}

export async function listRoute53HostedZones(connection: AwsConnection): Promise<Route53HostedZoneSummary[]> {
  return unwrap((await awsBridge().listRoute53HostedZones(connection)) as Wrapped<Route53HostedZoneSummary[]>)
}

export async function createRoute53HostedZone(connection: AwsConnection, input: Route53HostedZoneCreateInput): Promise<Route53HostedZoneSummary> {
  return unwrap((await awsBridge().createRoute53HostedZone(connection, input)) as Wrapped<Route53HostedZoneSummary>)
}

export async function listRoute53Records(connection: AwsConnection, hostedZoneId: string): Promise<Route53RecordSummary[]> {
  return unwrap((await awsBridge().listRoute53Records(connection, hostedZoneId)) as Wrapped<Route53RecordSummary[]>)
}

export async function upsertRoute53Record(connection: AwsConnection, hostedZoneId: string, record: Route53RecordChange): Promise<void> {
  return unwrap((await awsBridge().upsertRoute53Record(connection, hostedZoneId, record)) as Wrapped<void>)
}

export async function deleteRoute53Record(connection: AwsConnection, hostedZoneId: string, record: Route53RecordChange): Promise<void> {
  return unwrap((await awsBridge().deleteRoute53Record(connection, hostedZoneId, record)) as Wrapped<void>)
}

export async function listTrails(connection: AwsConnection): Promise<CloudTrailSummary[]> {
  return unwrap((await awsBridge().listTrails(connection)) as Wrapped<CloudTrailSummary[]>)
}

export async function lookupCloudTrailEvents(connection: AwsConnection, startTime: string, endTime: string): Promise<CloudTrailEventSummary[]> {
  return unwrap((await awsBridge().lookupCloudTrailEvents(connection, startTime, endTime)) as Wrapped<CloudTrailEventSummary[]>)
}

export async function lookupCloudTrailEventsByResource(connection: AwsConnection, resourceName: string, startTime: string, endTime: string): Promise<CloudTrailEventSummary[]> {
  return unwrap((await awsBridge().lookupCloudTrailEventsByResource(connection, resourceName, startTime, endTime)) as Wrapped<CloudTrailEventSummary[]>)
}

export async function listLambdaFunctions(connection: AwsConnection): Promise<LambdaFunctionSummary[]> {
  return unwrap((await awsBridge().listLambdaFunctions(connection)) as Wrapped<LambdaFunctionSummary[]>)
}

export async function getLambdaFunction(connection: AwsConnection, functionName: string): Promise<LambdaFunctionDetail> {
  return unwrap((await awsBridge().getLambdaFunction(connection, functionName)) as Wrapped<LambdaFunctionDetail>)
}

export async function invokeLambdaFunction(connection: AwsConnection, functionName: string, payload: string): Promise<LambdaInvokeResult> {
  return unwrap((await awsBridge().invokeLambdaFunction(connection, functionName, payload)) as Wrapped<LambdaInvokeResult>)
}

export async function getLambdaFunctionCode(connection: AwsConnection, functionName: string): Promise<LambdaCodeResult> {
  return unwrap((await awsBridge().getLambdaFunctionCode(connection, functionName)) as Wrapped<LambdaCodeResult>)
}

export async function createLambdaFunction(connection: AwsConnection, config: LambdaCreateConfig): Promise<void> {
  return unwrap((await awsBridge().createLambdaFunction(connection, config)) as Wrapped<void>)
}

export async function deleteLambdaFunction(connection: AwsConnection, functionName: string): Promise<void> {
  return unwrap((await awsBridge().deleteLambdaFunction(connection, functionName)) as Wrapped<void>)
}

export async function listAutoScalingGroups(connection: AwsConnection): Promise<AutoScalingGroupSummary[]> {
  return unwrap((await awsBridge().listAutoScalingGroups(connection)) as Wrapped<AutoScalingGroupSummary[]>)
}

export async function listAutoScalingInstances(connection: AwsConnection, groupName: string): Promise<AutoScalingInstanceSummary[]> {
  return unwrap((await awsBridge().listAutoScalingInstances(connection, groupName)) as Wrapped<AutoScalingInstanceSummary[]>)
}

export async function updateAutoScalingCapacity(connection: AwsConnection, groupName: string, minimum: number, desired: number, maximum: number): Promise<void> {
  return unwrap((await awsBridge().updateAutoScalingCapacity(connection, groupName, minimum, desired, maximum)) as Wrapped<void>)
}

export async function startAutoScalingRefresh(connection: AwsConnection, groupName: string): Promise<string> {
  return unwrap((await awsBridge().startAutoScalingRefresh(connection, groupName)) as Wrapped<string>)
}

export async function deleteAutoScalingGroup(connection: AwsConnection, groupName: string, forceDelete = false): Promise<void> {
  return unwrap((await awsBridge().deleteAutoScalingGroup(connection, groupName, forceDelete)) as Wrapped<void>)
}

export async function listS3Buckets(connection: AwsConnection): Promise<S3BucketSummary[]> {
  return unwrap((await awsBridge().listS3Buckets(connection)) as Wrapped<S3BucketSummary[]>)
}

export async function listS3Governance(connection: AwsConnection): Promise<S3GovernanceOverview> {
  return unwrap((await awsBridge().listS3Governance(connection)) as Wrapped<S3GovernanceOverview>)
}

export async function getS3GovernanceDetail(connection: AwsConnection, bucketName: string): Promise<S3BucketGovernanceDetail> {
  return unwrap((await awsBridge().getS3GovernanceDetail(connection, bucketName)) as Wrapped<S3BucketGovernanceDetail>)
}

export async function listS3Objects(connection: AwsConnection, bucketName: string, prefix = ''): Promise<S3ObjectSummary[]> {
  return unwrap((await awsBridge().listS3Objects(connection, bucketName, prefix)) as Wrapped<S3ObjectSummary[]>)
}

export async function createS3Bucket(connection: AwsConnection, bucketName: string): Promise<void> {
  return unwrap((await awsBridge().createS3Bucket(connection, bucketName)) as Wrapped<void>)
}

export async function deleteS3Object(connection: AwsConnection, bucketName: string, key: string): Promise<void> {
  return unwrap((await awsBridge().deleteS3Object(connection, bucketName, key)) as Wrapped<void>)
}

export async function getS3PresignedUrl(connection: AwsConnection, bucketName: string, key: string): Promise<string> {
  return unwrap((await awsBridge().getS3PresignedUrl(connection, bucketName, key)) as Wrapped<string>)
}

export async function createS3Folder(connection: AwsConnection, bucketName: string, folderKey: string): Promise<void> {
  return unwrap((await awsBridge().createS3Folder(connection, bucketName, folderKey)) as Wrapped<void>)
}

export async function downloadS3Object(connection: AwsConnection, bucketName: string, key: string): Promise<string> {
  return unwrap((await awsBridge().downloadS3Object(connection, bucketName, key)) as Wrapped<string>)
}

export async function downloadS3ObjectTo(connection: AwsConnection, bucketName: string, key: string): Promise<string> {
  return unwrap((await awsBridge().downloadS3ObjectTo(connection, bucketName, key)) as Wrapped<string>)
}

export async function openS3Object(connection: AwsConnection, bucketName: string, key: string): Promise<string> {
  return unwrap((await awsBridge().openS3Object(connection, bucketName, key)) as Wrapped<string>)
}

export async function openS3InVSCode(connection: AwsConnection, bucketName: string, key: string): Promise<string> {
  return unwrap((await awsBridge().openS3InVSCode(connection, bucketName, key)) as Wrapped<string>)
}

export async function getS3ObjectContent(connection: AwsConnection, bucketName: string, key: string): Promise<S3ObjectContent> {
  return unwrap((await awsBridge().getS3ObjectContent(connection, bucketName, key)) as Wrapped<S3ObjectContent>)
}

export async function putS3ObjectContent(connection: AwsConnection, bucketName: string, key: string, content: string, contentType?: string): Promise<void> {
  return unwrap((await awsBridge().putS3ObjectContent(connection, bucketName, key, content, contentType)) as Wrapped<void>)
}

export async function uploadS3Object(connection: AwsConnection, bucketName: string, key: string, localPath: string): Promise<void> {
  return unwrap((await awsBridge().uploadS3Object(connection, bucketName, key, localPath)) as Wrapped<void>)
}

export async function enableS3BucketVersioning(connection: AwsConnection, bucketName: string): Promise<void> {
  return unwrap((await awsBridge().enableS3BucketVersioning(connection, bucketName)) as Wrapped<void>)
}

export async function enableS3BucketEncryption(connection: AwsConnection, bucketName: string): Promise<void> {
  return unwrap((await awsBridge().enableS3BucketEncryption(connection, bucketName)) as Wrapped<void>)
}

export async function putS3BucketPolicy(connection: AwsConnection, bucketName: string, policyJson: string): Promise<void> {
  return unwrap((await awsBridge().putS3BucketPolicy(connection, bucketName, policyJson)) as Wrapped<void>)
}

export async function listRdsInstances(connection: AwsConnection): Promise<RdsInstanceSummary[]> {
  return unwrap((await awsBridge().listRdsInstances(connection)) as Wrapped<RdsInstanceSummary[]>)
}

export async function listRdsClusters(connection: AwsConnection): Promise<RdsClusterSummary[]> {
  return unwrap((await awsBridge().listRdsClusters(connection)) as Wrapped<RdsClusterSummary[]>)
}

export async function describeRdsInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<RdsInstanceDetail> {
  return unwrap((await awsBridge().describeRdsInstance(connection, dbInstanceIdentifier)) as Wrapped<RdsInstanceDetail>)
}

export async function describeRdsCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<RdsClusterDetail> {
  return unwrap((await awsBridge().describeRdsCluster(connection, dbClusterIdentifier)) as Wrapped<RdsClusterDetail>)
}

export async function startRdsInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<void> {
  return unwrap((await awsBridge().startRdsInstance(connection, dbInstanceIdentifier)) as Wrapped<void>)
}

export async function stopRdsInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<void> {
  return unwrap((await awsBridge().stopRdsInstance(connection, dbInstanceIdentifier)) as Wrapped<void>)
}

export async function rebootRdsInstance(connection: AwsConnection, dbInstanceIdentifier: string, forceFailover = false): Promise<void> {
  return unwrap((await awsBridge().rebootRdsInstance(connection, dbInstanceIdentifier, forceFailover)) as Wrapped<void>)
}

export async function resizeRdsInstance(connection: AwsConnection, dbInstanceIdentifier: string, dbInstanceClass: string): Promise<void> {
  return unwrap((await awsBridge().resizeRdsInstance(connection, dbInstanceIdentifier, dbInstanceClass)) as Wrapped<void>)
}

export async function createRdsSnapshot(connection: AwsConnection, dbInstanceIdentifier: string, dbSnapshotIdentifier: string): Promise<void> {
  return unwrap((await awsBridge().createRdsSnapshot(connection, dbInstanceIdentifier, dbSnapshotIdentifier)) as Wrapped<void>)
}

export async function startRdsCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  return unwrap((await awsBridge().startRdsCluster(connection, dbClusterIdentifier)) as Wrapped<void>)
}

export async function stopRdsCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  return unwrap((await awsBridge().stopRdsCluster(connection, dbClusterIdentifier)) as Wrapped<void>)
}

export async function failoverRdsCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  return unwrap((await awsBridge().failoverRdsCluster(connection, dbClusterIdentifier)) as Wrapped<void>)
}

export async function createRdsClusterSnapshot(connection: AwsConnection, dbClusterIdentifier: string, dbClusterSnapshotIdentifier: string): Promise<void> {
  return unwrap((await awsBridge().createRdsClusterSnapshot(connection, dbClusterIdentifier, dbClusterSnapshotIdentifier)) as Wrapped<void>)
}

export async function listCloudFormationStacks(connection: AwsConnection): Promise<CloudFormationStackSummary[]> {
  return unwrap((await awsBridge().listCloudFormationStacks(connection)) as Wrapped<CloudFormationStackSummary[]>)
}

export async function listCloudFormationStackResources(connection: AwsConnection, stackName: string): Promise<CloudFormationResourceSummary[]> {
  return unwrap((await awsBridge().listCloudFormationStackResources(connection, stackName)) as Wrapped<CloudFormationResourceSummary[]>)
}

export async function listCloudFormationChangeSets(connection: AwsConnection, stackName: string): Promise<CloudFormationChangeSetSummary[]> {
  return unwrap((await awsBridge().listCloudFormationChangeSets(connection, stackName)) as Wrapped<CloudFormationChangeSetSummary[]>)
}

export async function createCloudFormationChangeSet(
  connection: AwsConnection,
  input: {
    stackName: string
    changeSetName: string
    description?: string
    templateBody?: string
    templateUrl?: string
    usePreviousTemplate?: boolean
    capabilities?: string[]
    parameters?: Array<{
      parameterKey: string
      parameterValue?: string
      usePreviousValue?: boolean
    }>
  }
): Promise<CloudFormationChangeSetSummary> {
  return unwrap((await awsBridge().createCloudFormationChangeSet(connection, input)) as Wrapped<CloudFormationChangeSetSummary>)
}

export async function getCloudFormationChangeSetDetail(
  connection: AwsConnection,
  stackName: string,
  changeSetName: string
): Promise<CloudFormationChangeSetDetail> {
  return unwrap((await awsBridge().getCloudFormationChangeSetDetail(connection, stackName, changeSetName)) as Wrapped<CloudFormationChangeSetDetail>)
}

export async function executeCloudFormationChangeSet(connection: AwsConnection, stackName: string, changeSetName: string): Promise<void> {
  return unwrap((await awsBridge().executeCloudFormationChangeSet(connection, stackName, changeSetName)) as Wrapped<void>)
}

export async function deleteCloudFormationChangeSet(connection: AwsConnection, stackName: string, changeSetName: string): Promise<void> {
  return unwrap((await awsBridge().deleteCloudFormationChangeSet(connection, stackName, changeSetName)) as Wrapped<void>)
}

export async function getCloudFormationDriftSummary(connection: AwsConnection, stackName: string): Promise<CloudFormationStackDriftSummary> {
  return unwrap((await awsBridge().getCloudFormationDriftSummary(connection, stackName)) as Wrapped<CloudFormationStackDriftSummary>)
}

export async function startCloudFormationDriftDetection(connection: AwsConnection, stackName: string): Promise<string> {
  return unwrap((await awsBridge().startCloudFormationDriftDetection(connection, stackName)) as Wrapped<string>)
}

export async function getCloudFormationDriftDetectionStatus(
  connection: AwsConnection,
  stackName: string,
  driftDetectionId: string
): Promise<{ summary: CloudFormationStackDriftSummary; rows: CloudFormationDriftedResourceRow[] }> {
  return unwrap(
    (await awsBridge().getCloudFormationDriftDetectionStatus(connection, stackName, driftDetectionId)) as Wrapped<{
      summary: CloudFormationStackDriftSummary
      rows: CloudFormationDriftedResourceRow[]
    }>
  )
}

export async function getOverviewMetrics(connection: AwsConnection, regions: string[]): Promise<OverviewMetrics> {
  return unwrap((await awsBridge().getOverviewMetrics(connection, regions)) as Wrapped<OverviewMetrics>)
}

export async function getCostBreakdown(connection: AwsConnection): Promise<CostBreakdown> {
  return unwrap((await awsBridge().getCostBreakdown(connection)) as Wrapped<CostBreakdown>)
}

export async function getOverviewAccountContext(connection: AwsConnection): Promise<OverviewAccountContext> {
  return unwrap((await awsBridge().getOverviewAccountContext(connection)) as Wrapped<OverviewAccountContext>)
}

export async function getOverviewStatistics(connection: AwsConnection): Promise<OverviewStatistics> {
  return unwrap((await awsBridge().getOverviewStatistics(connection)) as Wrapped<OverviewStatistics>)
}

export async function getComplianceReport(connection: AwsConnection): Promise<ComplianceReport> {
  return unwrap((await awsBridge().getComplianceReport(connection)) as Wrapped<ComplianceReport>)
}

export async function getSecurityScoreReport(
  connection: AwsConnection,
  weights?: Partial<SecurityScoreWeights>
): Promise<SecurityScoreReport> {
  return unwrap(
    (await awsBridge().getSecurityScoreReport(connection, weights)) as Wrapped<SecurityScoreReport>
  )
}

export async function recordSecuritySnapshot(input: SecuritySnapshotInput): Promise<SecuritySnapshot> {
  return unwrap(
    (await awsBridge().recordSecuritySnapshot(input)) as Wrapped<SecuritySnapshot>
  )
}

export async function listSecuritySnapshots(scope: string, range: SecurityTrendRange): Promise<SecuritySnapshot[]> {
  return unwrap(
    (await awsBridge().listSecuritySnapshots(scope, range)) as Wrapped<SecuritySnapshot[]>
  )
}

export async function buildSecurityTrendReport(scope: string, range: SecurityTrendRange): Promise<SecurityTrendReport> {
  return unwrap(
    (await awsBridge().buildSecurityTrendReport(scope, range)) as Wrapped<SecurityTrendReport>
  )
}

export async function getSecurityThresholds(): Promise<SecurityThresholds> {
  return unwrap(
    (await awsBridge().getSecurityThresholds()) as Wrapped<SecurityThresholds>
  )
}

export async function updateSecurityThresholds(update: Partial<SecurityThresholds>): Promise<SecurityThresholds> {
  return unwrap(
    (await awsBridge().updateSecurityThresholds(update)) as Wrapped<SecurityThresholds>
  )
}

export async function listSecurityScopes(): Promise<Array<{ scope: string; scopeLabel: string; snapshotCount: number }>> {
  return unwrap(
    (await awsBridge().listSecurityScopes()) as Wrapped<Array<{ scope: string; scopeLabel: string; snapshotCount: number }>>
  )
}

export async function getGuardDutyReport(connection: AwsConnection): Promise<GuardDutyReport> {
  return unwrap((await awsBridge().getGuardDutyReport(connection)) as Wrapped<GuardDutyReport>)
}

export async function archiveGuardDutyFindings(
  connection: AwsConnection,
  findingIds: string[]
): Promise<void> {
  return unwrap(
    (await awsBridge().archiveGuardDutyFindings(connection, findingIds)) as Wrapped<void>
  )
}

export async function unarchiveGuardDutyFindings(
  connection: AwsConnection,
  findingIds: string[]
): Promise<void> {
  return unwrap(
    (await awsBridge().unarchiveGuardDutyFindings(connection, findingIds)) as Wrapped<void>
  )
}

export async function updateComplianceFindingWorkflow(
  connection: AwsConnection,
  findingId: string,
  update: ComplianceFindingWorkflowUpdate
): Promise<ComplianceFindingWorkflow> {
  return unwrap((await awsBridge().updateComplianceFindingWorkflow(connection, findingId, update)) as Wrapped<ComplianceFindingWorkflow>)
}

export async function getRelationshipMap(connection: AwsConnection): Promise<RelationshipMap> {
  return unwrap((await awsBridge().getRelationshipMap(connection)) as Wrapped<RelationshipMap>)
}

export async function searchByTag(connection: AwsConnection, tagKey: string, tagValue?: string): Promise<TagSearchResult> {
  return unwrap((await awsBridge().searchByTag(connection, tagKey, tagValue)) as Wrapped<TagSearchResult>)
}

export async function listLoadBalancerWorkspaces(connection: AwsConnection): Promise<LoadBalancerWorkspace[]> {
  return unwrap((await awsBridge().listLoadBalancerWorkspaces(connection)) as Wrapped<LoadBalancerWorkspace[]>)
}

export async function deleteLoadBalancer(connection: AwsConnection, loadBalancerArn: string): Promise<void> {
  return unwrap((await awsBridge().deleteLoadBalancer(connection, loadBalancerArn)) as Wrapped<void>)
}

export async function queryLoadBalancerLogs(connection: AwsConnection | undefined, query: LoadBalancerLogQuery, providerContext?: { gcpProjectId?: string; azureWorkspaceId?: string }): Promise<LoadBalancerLogResult> {
  return unwrap((await rawAwsBridge().queryLoadBalancerLogs(connection, query, providerContext)) as Wrapped<LoadBalancerLogResult>)
}

export async function getAlbAccessLogConfig(connection: AwsConnection, loadBalancerArn: string): Promise<{ enabled: boolean; bucket: string; prefix: string }> {
  return unwrap((await rawAwsBridge().getAlbAccessLogConfig(connection, loadBalancerArn)) as Wrapped<{ enabled: boolean; bucket: string; prefix: string }>)
}

export async function listProjects(profileName: string): Promise<TerraformProjectListItem[]> {
  return unwrap((await terraformBridge().listProjects(profileName)) as Wrapped<TerraformProjectListItem[]>)
}

export async function detectTerraformCli(): Promise<TerraformCliInfo> {
  return unwrap((await terraformBridge().detectCli()) as Wrapped<TerraformCliInfo>)
}

export async function getTerraformCliInfo(): Promise<TerraformCliInfo> {
  return unwrap((await terraformBridge().getCliInfo()) as Wrapped<TerraformCliInfo>)
}

export async function setTerraformCliKind(kind: 'terraform' | 'opentofu'): Promise<TerraformCliInfo> {
  return unwrap((await terraformBridge().setCliKind(kind)) as Wrapped<TerraformCliInfo>)
}

export async function getProject(profileName: string, projectId: string): Promise<TerraformProject> {
  return unwrap((await terraformBridge().getProject(profileName, projectId)) as Wrapped<TerraformProject>)
}

export async function chooseProjectDirectory(): Promise<string> {
  return unwrap((await terraformBridge().chooseProjectDirectory()) as Wrapped<string>)
}

export async function addProject(profileName: string, rootPath: string): Promise<TerraformProject> {
  return unwrap((await terraformBridge().addProject(profileName, rootPath)) as Wrapped<TerraformProject>)
}

export async function renameProject(profileName: string, projectId: string, name: string): Promise<TerraformProject> {
  return unwrap((await terraformBridge().renameProject(profileName, projectId, name)) as Wrapped<TerraformProject>)
}

export async function removeProject(profileName: string, projectId: string): Promise<void> {
  return unwrap((await terraformBridge().removeProject(profileName, projectId)) as Wrapped<void>)
}

export async function reloadProject(profileName: string, projectId: string): Promise<TerraformProject> {
  return unwrap((await terraformBridge().reloadProject(profileName, projectId)) as Wrapped<TerraformProject>)
}

export async function getSelectedProjectId(profileName: string): Promise<string> {
  return unwrap((await terraformBridge().getSelectedProjectId(profileName)) as Wrapped<string>)
}

export async function setSelectedProjectId(profileName: string, projectId: string): Promise<void> {
  return unwrap((await terraformBridge().setSelectedProjectId(profileName, projectId)) as Wrapped<void>)
}

export async function updateInputs(profileName: string, projectId: string, inputConfig: TerraformInputConfiguration): Promise<TerraformProject> {
  return unwrap((await terraformBridge().updateInputs(profileName, projectId, inputConfig)) as Wrapped<TerraformProject>)
}

export async function listCommandLogs(projectId: string): Promise<TerraformCommandLog[]> {
  return unwrap((await terraformBridge().listCommandLogs(projectId)) as Wrapped<TerraformCommandLog[]>)
}

export async function runCommand(request: TerraformCommandRequest): Promise<TerraformCommandLog> {
  return unwrap((await terraformBridge().runCommand(request)) as Wrapped<TerraformCommandLog>)
}

export function subscribeToProjectEvents(listener: (event: ProjectEvent) => void): () => void {
  const genericListener = listener as unknown as (event: unknown) => void
  terraformBridge().subscribe(genericListener)
  return () => terraformBridge().unsubscribe(genericListener)
}

export async function listAcmCertificates(connection: AwsConnection): Promise<AcmCertificateSummary[]> {
  return unwrap((await awsBridge().listAcmCertificates(connection)) as Wrapped<AcmCertificateSummary[]>)
}

export async function describeAcmCertificate(connection: AwsConnection, certificateArn: string): Promise<AcmCertificateDetail> {
  return unwrap((await awsBridge().describeAcmCertificate(connection, certificateArn)) as Wrapped<AcmCertificateDetail>)
}

export async function requestAcmCertificate(connection: AwsConnection, input: AcmRequestCertificateInput): Promise<string> {
  return unwrap((await awsBridge().requestAcmCertificate(connection, input)) as Wrapped<string>)
}

export async function deleteAcmCertificate(connection: AwsConnection, certificateArn: string): Promise<void> {
  return unwrap((await awsBridge().deleteAcmCertificate(connection, certificateArn)) as Wrapped<void>)
}

export async function listSecrets(connection: AwsConnection): Promise<SecretsManagerSecretSummary[]> {
  return unwrap((await awsBridge().listSecrets(connection)) as Wrapped<SecretsManagerSecretSummary[]>)
}

export async function describeSecret(connection: AwsConnection, secretId: string): Promise<SecretsManagerSecretDetail> {
  return unwrap((await awsBridge().describeSecret(connection, secretId)) as Wrapped<SecretsManagerSecretDetail>)
}

export async function getSecretDependencyReport(connection: AwsConnection, secretId: string): Promise<SecretDependencyReport> {
  return unwrap((await awsBridge().getSecretDependencyReport(connection, secretId)) as Wrapped<SecretDependencyReport>)
}

export async function getSecretValue(connection: AwsConnection, secretId: string, versionId?: string): Promise<SecretsManagerSecretValue> {
  return unwrap((await awsBridge().getSecretValue(connection, secretId, versionId)) as Wrapped<SecretsManagerSecretValue>)
}

export async function createSecret(connection: AwsConnection, input: SecretCreateInput): Promise<string> {
  return unwrap((await awsBridge().createSecret(connection, input)) as Wrapped<string>)
}

export async function deleteSecret(connection: AwsConnection, secretId: string, forceDeleteWithoutRecovery: boolean): Promise<void> {
  return unwrap((await awsBridge().deleteSecret(connection, secretId, forceDeleteWithoutRecovery)) as Wrapped<void>)
}

export async function restoreSecret(connection: AwsConnection, secretId: string): Promise<void> {
  return unwrap((await awsBridge().restoreSecret(connection, secretId)) as Wrapped<void>)
}

export async function updateSecretValue(connection: AwsConnection, secretId: string, secretString: string): Promise<void> {
  return unwrap((await awsBridge().updateSecretValue(connection, secretId, secretString)) as Wrapped<void>)
}

export async function updateSecretDescription(connection: AwsConnection, secretId: string, description: string): Promise<void> {
  return unwrap((await awsBridge().updateSecretDescription(connection, secretId, description)) as Wrapped<void>)
}

export async function rotateSecret(connection: AwsConnection, secretId: string): Promise<void> {
  return unwrap((await awsBridge().rotateSecret(connection, secretId)) as Wrapped<void>)
}

export async function putSecretResourcePolicy(connection: AwsConnection, secretId: string, policy: string): Promise<void> {
  return unwrap((await awsBridge().putSecretResourcePolicy(connection, secretId, policy)) as Wrapped<void>)
}

export async function tagSecret(connection: AwsConnection, secretId: string, tags: SecretTag[]): Promise<void> {
  return unwrap((await awsBridge().tagSecret(connection, secretId, tags)) as Wrapped<void>)
}

export async function untagSecret(connection: AwsConnection, secretId: string, tagKeys: string[]): Promise<void> {
  return unwrap((await awsBridge().untagSecret(connection, secretId, tagKeys)) as Wrapped<void>)
}

export async function listKeyPairs(connection: AwsConnection): Promise<KeyPairSummary[]> {
  return unwrap((await awsBridge().listKeyPairs(connection)) as Wrapped<KeyPairSummary[]>)
}

export async function createKeyPair(connection: AwsConnection, keyName: string): Promise<CreatedKeyPair> {
  return unwrap((await awsBridge().createKeyPair(connection, keyName)) as Wrapped<CreatedKeyPair>)
}

export async function deleteKeyPair(connection: AwsConnection, keyName: string): Promise<void> {
  return unwrap((await awsBridge().deleteKeyPair(connection, keyName)) as Wrapped<void>)
}

export async function decodeAuthorizationMessage(connection: AwsConnection, encodedMessage: string): Promise<StsDecodedAuthorizationMessage> {
  return unwrap((await awsBridge().decodeAuthorizationMessage(connection, encodedMessage)) as Wrapped<StsDecodedAuthorizationMessage>)
}

export async function lookupAccessKeyOwnership(connection: AwsConnection, accessKeyId: string): Promise<AccessKeyOwnership> {
  return unwrap((await awsBridge().lookupAccessKeyOwnership(connection, accessKeyId)) as Wrapped<AccessKeyOwnership>)
}

export async function assumeRole(connection: AwsConnection, roleArn: string, sessionName: string, externalId?: string): Promise<AssumeRoleResult> {
  return unwrap((await awsBridge().assumeRole(connection, roleArn, sessionName, externalId)) as Wrapped<AssumeRoleResult>)
}

export async function listKmsKeys(connection: AwsConnection): Promise<KmsKeySummary[]> {
  return unwrap((await awsBridge().listKmsKeys(connection)) as Wrapped<KmsKeySummary[]>)
}

export async function describeKmsKey(connection: AwsConnection, keyId: string): Promise<KmsKeyDetail> {
  return unwrap((await awsBridge().describeKmsKey(connection, keyId)) as Wrapped<KmsKeyDetail>)
}

export async function decryptCiphertext(connection: AwsConnection, ciphertext: string): Promise<KmsDecryptResult> {
  return unwrap((await awsBridge().decryptCiphertext(connection, ciphertext)) as Wrapped<KmsDecryptResult>)
}

export async function listWebAcls(connection: AwsConnection, scope: WafScope): Promise<WafWebAclSummary[]> {
  return unwrap((await awsBridge().listWebAcls(connection, scope)) as Wrapped<WafWebAclSummary[]>)
}

export async function describeWebAcl(connection: AwsConnection, scope: WafScope, id: string, name: string): Promise<WafWebAclDetail> {
  return unwrap((await awsBridge().describeWebAcl(connection, scope, id, name)) as Wrapped<WafWebAclDetail>)
}

export async function createWebAcl(connection: AwsConnection, input: WafCreateWebAclInput): Promise<string> {
  return unwrap((await awsBridge().createWebAcl(connection, input)) as Wrapped<string>)
}

export async function deleteWebAcl(connection: AwsConnection, scope: WafScope, id: string, name: string, lockToken: string): Promise<void> {
  return unwrap((await awsBridge().deleteWebAcl(connection, scope, id, name, lockToken)) as Wrapped<void>)
}

export async function addWafRule(
  connection: AwsConnection,
  scope: WafScope,
  id: string,
  name: string,
  lockToken: string,
  input: WafRuleInput
): Promise<void> {
  return unwrap((await awsBridge().addWafRule(connection, scope, id, name, lockToken, input)) as Wrapped<void>)
}

export async function updateWafRulesJson(
  connection: AwsConnection,
  scope: WafScope,
  id: string,
  name: string,
  lockToken: string,
  defaultAction: 'Allow' | 'Block',
  description: string,
  rulesJson: string
): Promise<void> {
  return unwrap(
    (await awsBridge().updateWafRulesJson(connection, scope, id, name, lockToken, defaultAction, description, rulesJson)) as Wrapped<void>
  )
}

export async function deleteWafRule(
  connection: AwsConnection,
  scope: WafScope,
  id: string,
  name: string,
  lockToken: string,
  ruleName: string
): Promise<void> {
  return unwrap((await awsBridge().deleteWafRule(connection, scope, id, name, lockToken, ruleName)) as Wrapped<void>)
}

export async function associateWebAcl(connection: AwsConnection, resourceArn: string, webAclArn: string): Promise<void> {
  return unwrap((await awsBridge().associateWebAcl(connection, resourceArn, webAclArn)) as Wrapped<void>)
}

export async function disassociateWebAcl(connection: AwsConnection, resourceArn: string): Promise<void> {
  return unwrap((await awsBridge().disassociateWebAcl(connection, resourceArn)) as Wrapped<void>)
}

/* ── SNS API ──────────────────────────────────────────────── */

export async function listSnsTopics(c: AwsConnection): Promise<SnsTopicSummary[]> {
  return unwrap((await awsBridge().listSnsTopics(c)) as Wrapped<SnsTopicSummary[]>)
}
export async function getSnsTopic(c: AwsConnection, arn: string): Promise<SnsTopicSummary> {
  return unwrap((await awsBridge().getSnsTopic(c, arn)) as Wrapped<SnsTopicSummary>)
}
export async function createSnsTopic(c: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>): Promise<string> {
  return unwrap((await awsBridge().createSnsTopic(c, name, fifo, attrs)) as Wrapped<string>)
}
export async function deleteSnsTopic(c: AwsConnection, arn: string): Promise<void> {
  return unwrap((await awsBridge().deleteSnsTopic(c, arn)) as Wrapped<void>)
}
export async function setSnsTopicAttribute(c: AwsConnection, arn: string, n: string, v: string): Promise<void> {
  return unwrap((await awsBridge().setSnsTopicAttribute(c, arn, n, v)) as Wrapped<void>)
}
export async function listSnsSubscriptions(c: AwsConnection, arn: string): Promise<SnsSubscriptionSummary[]> {
  return unwrap((await awsBridge().listSnsSubscriptions(c, arn)) as Wrapped<SnsSubscriptionSummary[]>)
}
export async function snsSubscribe(c: AwsConnection, arn: string, proto: string, ep: string): Promise<string> {
  return unwrap((await awsBridge().snsSubscribe(c, arn, proto, ep)) as Wrapped<string>)
}
export async function snsUnsubscribe(c: AwsConnection, subArn: string): Promise<void> {
  return unwrap((await awsBridge().snsUnsubscribe(c, subArn)) as Wrapped<void>)
}
export async function snsPublish(c: AwsConnection, arn: string, msg: string, subj?: string, gid?: string, did?: string): Promise<SnsPublishResult> {
  return unwrap((await awsBridge().snsPublish(c, arn, msg, subj, gid, did)) as Wrapped<SnsPublishResult>)
}
export async function tagSnsTopic(c: AwsConnection, arn: string, tags: Record<string, string>): Promise<void> {
  return unwrap((await awsBridge().tagSnsTopic(c, arn, tags)) as Wrapped<void>)
}
export async function untagSnsTopic(c: AwsConnection, arn: string, keys: string[]): Promise<void> {
  return unwrap((await awsBridge().untagSnsTopic(c, arn, keys)) as Wrapped<void>)
}

/* ── SQS API ──────────────────────────────────────────────── */

export async function listSqsQueues(c: AwsConnection): Promise<SqsQueueSummary[]> {
  return unwrap((await awsBridge().listSqsQueues(c)) as Wrapped<SqsQueueSummary[]>)
}
export async function getSqsQueue(c: AwsConnection, url: string): Promise<SqsQueueSummary> {
  return unwrap((await awsBridge().getSqsQueue(c, url)) as Wrapped<SqsQueueSummary>)
}
export async function createSqsQueue(c: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>): Promise<string> {
  return unwrap((await awsBridge().createSqsQueue(c, name, fifo, attrs)) as Wrapped<string>)
}
export async function deleteSqsQueue(c: AwsConnection, url: string): Promise<void> {
  return unwrap((await awsBridge().deleteSqsQueue(c, url)) as Wrapped<void>)
}
export async function purgeSqsQueue(c: AwsConnection, url: string): Promise<void> {
  return unwrap((await awsBridge().purgeSqsQueue(c, url)) as Wrapped<void>)
}
export async function setSqsAttributes(c: AwsConnection, url: string, attrs: Record<string, string>): Promise<void> {
  return unwrap((await awsBridge().setSqsAttributes(c, url, attrs)) as Wrapped<void>)
}
export async function sqsSendMessage(c: AwsConnection, url: string, body: string, delay?: number, gid?: string, did?: string): Promise<SqsSendResult> {
  return unwrap((await awsBridge().sqsSendMessage(c, url, body, delay, gid, did)) as Wrapped<SqsSendResult>)
}
export async function sqsReceiveMessages(c: AwsConnection, url: string, max: number, wait: number): Promise<SqsMessage[]> {
  return unwrap((await awsBridge().sqsReceiveMessages(c, url, max, wait)) as Wrapped<SqsMessage[]>)
}
export async function sqsDeleteMessage(c: AwsConnection, url: string, handle: string): Promise<void> {
  return unwrap((await awsBridge().sqsDeleteMessage(c, url, handle)) as Wrapped<void>)
}
export async function sqsChangeVisibility(c: AwsConnection, url: string, handle: string, timeout: number): Promise<void> {
  return unwrap((await awsBridge().sqsChangeVisibility(c, url, handle, timeout)) as Wrapped<void>)
}
export async function tagSqsQueue(c: AwsConnection, url: string, tags: Record<string, string>): Promise<void> {
  return unwrap((await awsBridge().tagSqsQueue(c, url, tags)) as Wrapped<void>)
}
export async function untagSqsQueue(c: AwsConnection, url: string, keys: string[]): Promise<void> {
  return unwrap((await awsBridge().untagSqsQueue(c, url, keys)) as Wrapped<void>)
}
export async function sqsTimeline(c: AwsConnection, url: string): Promise<SqsTimelineEvent[]> {
  return unwrap((await awsBridge().sqsTimeline(c, url)) as Wrapped<SqsTimelineEvent[]>)
}

/* ── Identity Center / SSO ────────────────────────────────── */

export async function listSsoInstances(c: AwsConnection): Promise<SsoInstanceSummary[]> {
  return unwrap((await awsBridge().listSsoInstances(c)) as Wrapped<SsoInstanceSummary[]>)
}
export async function createSsoInstance(c: AwsConnection, name: string): Promise<string> {
  return unwrap((await awsBridge().createSsoInstance(c, name)) as Wrapped<string>)
}
export async function deleteSsoInstance(c: AwsConnection, instanceArn: string): Promise<void> {
  return unwrap((await awsBridge().deleteSsoInstance(c, instanceArn)) as Wrapped<void>)
}
export async function listSsoPermissionSets(c: AwsConnection, instanceArn: string): Promise<SsoPermissionSetSummary[]> {
  return unwrap((await awsBridge().listSsoPermissionSets(c, instanceArn)) as Wrapped<SsoPermissionSetSummary[]>)
}
export async function listSsoUsers(c: AwsConnection, identityStoreId: string): Promise<SsoUserSummary[]> {
  return unwrap((await awsBridge().listSsoUsers(c, identityStoreId)) as Wrapped<SsoUserSummary[]>)
}
export async function listSsoGroups(c: AwsConnection, identityStoreId: string): Promise<SsoGroupSummary[]> {
  return unwrap((await awsBridge().listSsoGroups(c, identityStoreId)) as Wrapped<SsoGroupSummary[]>)
}
export async function listSsoAccountAssignments(c: AwsConnection, instanceArn: string, accountId: string, permissionSetArn: string): Promise<SsoAccountAssignment[]> {
  return unwrap((await awsBridge().listSsoAccountAssignments(c, instanceArn, accountId, permissionSetArn)) as Wrapped<SsoAccountAssignment[]>)
}
export async function simulateSsoPermissions(c: AwsConnection, instanceArn: string, permissionSetArn: string): Promise<SsoSimulationResult> {
  return unwrap((await awsBridge().simulateSsoPermissions(c, instanceArn, permissionSetArn)) as Wrapped<SsoSimulationResult>)
}

/* ── IAM ─────────────────────────────────────────────────── */

export async function listIamUsers(c: AwsConnection): Promise<IamUserSummary[]> { return unwrap((await awsBridge().listIamUsers(c)) as Wrapped<IamUserSummary[]>) }
export async function listIamGroups(c: AwsConnection): Promise<IamGroupSummary[]> { return unwrap((await awsBridge().listIamGroups(c)) as Wrapped<IamGroupSummary[]>) }
export async function listIamRoles(c: AwsConnection): Promise<IamRoleSummary[]> { return unwrap((await awsBridge().listIamRoles(c)) as Wrapped<IamRoleSummary[]>) }
export async function listIamPolicies(c: AwsConnection, scope: string): Promise<IamPolicySummary[]> { return unwrap((await awsBridge().listIamPolicies(c, scope)) as Wrapped<IamPolicySummary[]>) }
export async function getIamAccountSummary(c: AwsConnection): Promise<IamAccountSummary> { return unwrap((await awsBridge().getIamAccountSummary(c)) as Wrapped<IamAccountSummary>) }
export async function listIamAccessKeys(c: AwsConnection, u: string): Promise<IamAccessKeySummary[]> { return unwrap((await awsBridge().listIamAccessKeys(c, u)) as Wrapped<IamAccessKeySummary[]>) }
export async function createIamAccessKey(c: AwsConnection, u: string): Promise<{ accessKeyId: string; secretAccessKey: string }> { return unwrap((await awsBridge().createIamAccessKey(c, u)) as Wrapped<{ accessKeyId: string; secretAccessKey: string }>) }
export async function deleteIamAccessKey(c: AwsConnection, u: string, k: string): Promise<void> { return unwrap((await awsBridge().deleteIamAccessKey(c, u, k)) as Wrapped<void>) }
export async function updateIamAccessKeyStatus(c: AwsConnection, u: string, k: string, s: string): Promise<void> { return unwrap((await awsBridge().updateIamAccessKeyStatus(c, u, k, s)) as Wrapped<void>) }
export async function listIamMfaDevices(c: AwsConnection, u: string): Promise<IamMfaDevice[]> { return unwrap((await awsBridge().listIamMfaDevices(c, u)) as Wrapped<IamMfaDevice[]>) }
export async function deleteIamMfaDevice(c: AwsConnection, u: string, sn: string): Promise<void> { return unwrap((await awsBridge().deleteIamMfaDevice(c, u, sn)) as Wrapped<void>) }
export async function listAttachedIamUserPolicies(c: AwsConnection, u: string): Promise<IamAttachedPolicy[]> { return unwrap((await awsBridge().listAttachedIamUserPolicies(c, u)) as Wrapped<IamAttachedPolicy[]>) }
export async function listIamUserInlinePolicies(c: AwsConnection, u: string): Promise<IamInlinePolicy[]> { return unwrap((await awsBridge().listIamUserInlinePolicies(c, u)) as Wrapped<IamInlinePolicy[]>) }
export async function attachIamUserPolicy(c: AwsConnection, u: string, a: string): Promise<void> { return unwrap((await awsBridge().attachIamUserPolicy(c, u, a)) as Wrapped<void>) }
export async function detachIamUserPolicy(c: AwsConnection, u: string, a: string): Promise<void> { return unwrap((await awsBridge().detachIamUserPolicy(c, u, a)) as Wrapped<void>) }
export async function putIamUserInlinePolicy(c: AwsConnection, u: string, n: string, d: string): Promise<void> { return unwrap((await awsBridge().putIamUserInlinePolicy(c, u, n, d)) as Wrapped<void>) }
export async function deleteIamUserInlinePolicy(c: AwsConnection, u: string, n: string): Promise<void> { return unwrap((await awsBridge().deleteIamUserInlinePolicy(c, u, n)) as Wrapped<void>) }
export async function listIamUserGroups(c: AwsConnection, u: string): Promise<string[]> { return unwrap((await awsBridge().listIamUserGroups(c, u)) as Wrapped<string[]>) }
export async function addIamUserToGroup(c: AwsConnection, u: string, g: string): Promise<void> { return unwrap((await awsBridge().addIamUserToGroup(c, u, g)) as Wrapped<void>) }
export async function removeIamUserFromGroup(c: AwsConnection, u: string, g: string): Promise<void> { return unwrap((await awsBridge().removeIamUserFromGroup(c, u, g)) as Wrapped<void>) }
export async function createIamUser(c: AwsConnection, u: string): Promise<void> { return unwrap((await awsBridge().createIamUser(c, u)) as Wrapped<void>) }
export async function deleteIamUser(c: AwsConnection, u: string): Promise<void> { return unwrap((await awsBridge().deleteIamUser(c, u)) as Wrapped<void>) }
export async function createIamLoginProfile(c: AwsConnection, u: string, pw: string, r: boolean): Promise<void> { return unwrap((await awsBridge().createIamLoginProfile(c, u, pw, r)) as Wrapped<void>) }
export async function deleteIamLoginProfile(c: AwsConnection, u: string): Promise<void> { return unwrap((await awsBridge().deleteIamLoginProfile(c, u)) as Wrapped<void>) }
export async function listAttachedIamRolePolicies(c: AwsConnection, r: string): Promise<IamAttachedPolicy[]> { return unwrap((await awsBridge().listAttachedIamRolePolicies(c, r)) as Wrapped<IamAttachedPolicy[]>) }
export async function listIamRoleInlinePolicies(c: AwsConnection, r: string): Promise<IamInlinePolicy[]> { return unwrap((await awsBridge().listIamRoleInlinePolicies(c, r)) as Wrapped<IamInlinePolicy[]>) }
export async function getIamRoleTrustPolicy(c: AwsConnection, r: string): Promise<string> { return unwrap((await awsBridge().getIamRoleTrustPolicy(c, r)) as Wrapped<string>) }
export async function updateIamRoleTrustPolicy(c: AwsConnection, r: string, d: string): Promise<void> { return unwrap((await awsBridge().updateIamRoleTrustPolicy(c, r, d)) as Wrapped<void>) }
export async function attachIamRolePolicy(c: AwsConnection, r: string, a: string): Promise<void> { return unwrap((await awsBridge().attachIamRolePolicy(c, r, a)) as Wrapped<void>) }
export async function detachIamRolePolicy(c: AwsConnection, r: string, a: string): Promise<void> { return unwrap((await awsBridge().detachIamRolePolicy(c, r, a)) as Wrapped<void>) }
export async function putIamRoleInlinePolicy(c: AwsConnection, r: string, n: string, d: string): Promise<void> { return unwrap((await awsBridge().putIamRoleInlinePolicy(c, r, n, d)) as Wrapped<void>) }
export async function deleteIamRoleInlinePolicy(c: AwsConnection, r: string, n: string): Promise<void> { return unwrap((await awsBridge().deleteIamRoleInlinePolicy(c, r, n)) as Wrapped<void>) }
export async function createIamRole(c: AwsConnection, r: string, tp: string, desc: string): Promise<void> { return unwrap((await awsBridge().createIamRole(c, r, tp, desc)) as Wrapped<void>) }
export async function deleteIamRole(c: AwsConnection, r: string): Promise<void> { return unwrap((await awsBridge().deleteIamRole(c, r)) as Wrapped<void>) }
export async function listAttachedIamGroupPolicies(c: AwsConnection, g: string): Promise<IamAttachedPolicy[]> { return unwrap((await awsBridge().listAttachedIamGroupPolicies(c, g)) as Wrapped<IamAttachedPolicy[]>) }
export async function attachIamGroupPolicy(c: AwsConnection, g: string, a: string): Promise<void> { return unwrap((await awsBridge().attachIamGroupPolicy(c, g, a)) as Wrapped<void>) }
export async function detachIamGroupPolicy(c: AwsConnection, g: string, a: string): Promise<void> { return unwrap((await awsBridge().detachIamGroupPolicy(c, g, a)) as Wrapped<void>) }
export async function createIamGroup(c: AwsConnection, g: string): Promise<void> { return unwrap((await awsBridge().createIamGroup(c, g)) as Wrapped<void>) }
export async function deleteIamGroup(c: AwsConnection, g: string): Promise<void> { return unwrap((await awsBridge().deleteIamGroup(c, g)) as Wrapped<void>) }
export async function getIamPolicyVersion(c: AwsConnection, a: string, v: string): Promise<IamPolicyVersion> { return unwrap((await awsBridge().getIamPolicyVersion(c, a, v)) as Wrapped<IamPolicyVersion>) }
export async function listIamPolicyVersions(c: AwsConnection, a: string): Promise<IamPolicyVersion[]> { return unwrap((await awsBridge().listIamPolicyVersions(c, a)) as Wrapped<IamPolicyVersion[]>) }
export async function createIamPolicyVersion(c: AwsConnection, a: string, d: string, s: boolean): Promise<void> { return unwrap((await awsBridge().createIamPolicyVersion(c, a, d, s)) as Wrapped<void>) }
export async function deleteIamPolicyVersion(c: AwsConnection, a: string, v: string): Promise<void> { return unwrap((await awsBridge().deleteIamPolicyVersion(c, a, v)) as Wrapped<void>) }
export async function createIamPolicy(c: AwsConnection, n: string, d: string, desc: string): Promise<void> { return unwrap((await awsBridge().createIamPolicy(c, n, d, desc)) as Wrapped<void>) }
export async function deleteIamPolicy(c: AwsConnection, a: string): Promise<void> { return unwrap((await awsBridge().deleteIamPolicy(c, a)) as Wrapped<void>) }
export async function simulateIamPolicy(c: AwsConnection, a: string, actions: string[], resources: string[]): Promise<IamSimulationResult[]> { return unwrap((await awsBridge().simulateIamPolicy(c, a, actions, resources)) as Wrapped<IamSimulationResult[]>) }
export async function generateIamCredentialReport(c: AwsConnection): Promise<void> { return unwrap((await awsBridge().generateIamCredentialReport(c)) as Wrapped<void>) }
export async function getIamCredentialReport(c: AwsConnection): Promise<IamCredentialReportEntry[]> { return unwrap((await awsBridge().getIamCredentialReport(c)) as Wrapped<IamCredentialReportEntry[]>) }
