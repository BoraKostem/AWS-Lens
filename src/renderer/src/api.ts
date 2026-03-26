import { useEffect, useState } from 'react'

import type {
  AccessKeyOwnership,
  AcmCertificateDetail,
  AcmCertificateSummary,
  AcmRequestCertificateInput,
  AssumeRoleResult,
  AwsConnection,
  AwsProfile,
  AwsRegionOption,
  CallerIdentity,
  ServiceDescriptor,
  CloudWatchLogEventSummary,
  CloudWatchLogGroupSummary,
  CloudWatchMetricSeries,
  CloudWatchMetricStatistic,
  CloudWatchMetricSummary,
  CloudWatchNamespaceSummary,
  CloudFormationResourceSummary,
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
  Ec2InstanceSummary,
  KeyPairSummary,
  KmsDecryptResult,
  KmsKeyDetail,
  KmsKeySummary,
  AutoScalingGroupSummary,
  AutoScalingInstanceSummary,
  LoadBalancerWorkspace,
  RdsClusterDetail,
  RdsClusterSummary,
  RdsInstanceDetail,
  RdsInstanceSummary,
  Route53HostedZoneSummary,
  Route53RecordChange,
  Route53RecordSummary,
  ReachabilityPathResult,
  SecretCreateInput,
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
  S3ObjectContent,
  S3ObjectSummary,
  StsDecodedAuthorizationMessage,
  TerraformCommandLog,
  TerraformCommandRequest,
  TerraformDriftReport,
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
  OverviewMetrics,
  OverviewStatistics,
  RelationshipMap,
  TagSearchResult,
  VpcTopology,
  SecurityGroupSummary,
  WafCreateWebAclInput,
  WafRuleInput,
  WafScope,
  WafWebAclDetail,
  WafWebAclSummary,
  SsoAccountAssignment,
  SsoGroupSummary,
  SsoInstanceSummary,
  SsoPermissionSetSummary,
  SsoSimulationResult,
  SsoUserSummary
} from '@shared/types'

type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string }

type ProjectEvent =
  | { type: 'started'; projectId: string; log: TerraformCommandLog }
  | { type: 'output'; projectId: string; logId: string; chunk: string }
  | { type: 'completed'; projectId: string; log: TerraformCommandLog; project: TerraformProject | null }

export type TerminalEvent =
  | { type: 'output'; text: string }
  | { type: 'exit'; code: number | null }

export type AwsActivityState = {
  pendingCount: number
  lastCompletedAt: number | null
}

type AwsLensBridge = Window['awsLens']
export type CacheTag =
  | 'shell'
  | 'overview'
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
}

const awsActivityListeners = new Set<(state: AwsActivityState) => void>()
const awsBridgeCache = new WeakMap<AwsLensBridge, AwsLensBridge>()
const pageCache = new Map<string, CacheEntry>()
let awsActivityState: AwsActivityState = {
  pendingCount: 0,
  lastCompletedAt: null
}

const CACHE_TAG_BY_METHOD: Partial<Record<keyof AwsLensBridge, CacheTag>> = {
  listProfiles: 'shell',
  chooseAndImportConfig: 'shell',
  saveCredentials: 'shell',
  listRegions: 'shell',
  listServices: 'shell',
  getCallerIdentity: 'shell',
  getOverviewMetrics: 'overview',
  getOverviewStatistics: 'overview',
  getRelationshipMap: 'overview',
  getCostBreakdown: 'overview',
  searchByTag: 'overview',
  listEc2Instances: 'ec2',
  listCloudWatchMetrics: 'cloudwatch',
  getEc2MetricSeries: 'cloudwatch',
  listCloudWatchLogGroups: 'cloudwatch',
  listCloudWatchRecentEvents: 'cloudwatch',
  listEc2InstanceMetrics: 'cloudwatch',
  getMetricStatistics: 'cloudwatch',
  getEc2AllMetricSeries: 'cloudwatch',
  listS3Buckets: 's3',
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
  listRoute53Records: 'route53',
  listSecrets: 'secrets-manager',
  describeSecret: 'secrets-manager',
  getSecretValue: 'secrets-manager',
  listKeyPairs: 'key-pairs',
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
  'startRdsInstance',
  'stopRdsInstance',
  'rebootRdsInstance',
  'resizeRdsInstance',
  'createRdsSnapshot',
  'startRdsCluster',
  'stopRdsCluster',
  'failoverRdsCluster',
  'createRdsClusterSnapshot',
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
  'generateIamCredentialReport'
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

function cacheKey(tag: CacheTag, method: string, args: unknown[]): string {
  return `${tag}:${method}:${JSON.stringify(args)}`
}

function readCached<T>(tag: CacheTag, method: string, args: unknown[], loader: () => Promise<T>): Promise<T> {
  const key = cacheKey(tag, method, args)
  const cached = pageCache.get(key)

  if (cached) {
    return Promise.resolve(cached.value as T)
  }

  const pending = loader()
    .then((result) => {
      pageCache.set(key, { status: 'resolved', value: result })
      return result
    })
    .catch((error) => {
      pageCache.delete(key)
      throw error
    })

  pageCache.set(key, { status: 'pending', value: pending })
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

        if (!tag) {
          return invoke()
        }

        if (MUTATING_METHODS.has(method)) {
          return invoke().then((result) => {
            invalidatePageCache(tag)
            return result
          })
        }

        return readCached(tag, key, args, invoke)
      }
    } else {
      ;(wrapper as Record<string, unknown>)[key] = value
    }
  }

  awsBridgeCache.set(bridge, wrapper)
  return wrapper
}

function unwrap<T>(result: Wrapped<T>): T {
  if (!result.ok) {
    throw new Error(result.error)
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

export async function openAwsTerminal(connection: AwsConnection, initialCommand?: string): Promise<void> {
  await rawAwsBridge().openAwsTerminal(connection, initialCommand)
}

export async function openExternalUrl(url: string): Promise<void> {
  await rawAwsBridge().openExternalUrl(url)
}

export async function updateAwsTerminalContext(connection: AwsConnection): Promise<void> {
  await rawAwsBridge().updateAwsTerminalContext(connection)
}

export async function sendAwsTerminalInput(input: string): Promise<void> {
  await rawAwsBridge().sendTerminalInput(input)
}

export async function runAwsTerminalCommand(command: string): Promise<void> {
  await rawAwsBridge().runTerminalCommand(command)
}

export async function resizeAwsTerminal(cols: number, rows: number): Promise<void> {
  await rawAwsBridge().resizeTerminal(cols, rows)
}

export async function closeAwsTerminal(): Promise<void> {
  await rawAwsBridge().closeTerminal()
}

export function subscribeToAwsTerminal(listener: (event: TerminalEvent) => void): () => void {
  const genericListener = (event: unknown) => listener(event as TerminalEvent)
  rawAwsBridge().subscribeTerminal(genericListener)
  return () => rawAwsBridge().unsubscribeTerminal(genericListener)
}

export async function listProfiles(): Promise<AwsProfile[]> {
  return unwrap((await awsBridge().listProfiles()) as Wrapped<AwsProfile[]>)
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

export async function listServices(): Promise<ServiceDescriptor[]> {
  return unwrap((await awsBridge().listServices()) as Wrapped<ServiceDescriptor[]>)
}

export async function getCallerIdentity(connection: AwsConnection): Promise<CallerIdentity> {
  return unwrap((await awsBridge().getCallerIdentity(connection)) as Wrapped<CallerIdentity>)
}

export async function listEc2Instances(connection: AwsConnection): Promise<Ec2InstanceSummary[]> {
  return unwrap((await awsBridge().listEc2Instances(connection)) as Wrapped<Ec2InstanceSummary[]>)
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

export async function addEksToKubeconfig(connection: AwsConnection, clusterName: string): Promise<string> {
  return unwrap((await awsBridge().addEksToKubeconfig(connection, clusterName)) as Wrapped<string>)
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

export async function listEcsClusters(connection: AwsConnection) {
  return unwrap((await awsBridge().listEcsClusters(connection)) as Wrapped<import('@shared/types').EcsClusterSummary[]>)
}

export async function listEcsServices(connection: AwsConnection, clusterArn: string) {
  return unwrap((await awsBridge().listEcsServices(connection, clusterArn)) as Wrapped<import('@shared/types').EcsServiceSummary[]>)
}

export async function describeEcsService(connection: AwsConnection, clusterArn: string, serviceName: string) {
  return unwrap((await awsBridge().describeEcsService(connection, clusterArn, serviceName)) as Wrapped<import('@shared/types').EcsServiceDetail>)
}

export async function listEcsTasks(connection: AwsConnection, clusterArn: string, serviceName?: string) {
  return unwrap((await awsBridge().listEcsTasks(connection, clusterArn, serviceName)) as Wrapped<import('@shared/types').EcsTaskSummary[]>)
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

export async function getEcsContainerLogs(connection: AwsConnection, logGroup: string, logStream: string, startTime?: number) {
  return unwrap((await awsBridge().getEcsContainerLogs(connection, logGroup, logStream, startTime)) as Wrapped<import('@shared/types').EcsLogEvent[]>)
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

export async function listCloudWatchRecentEvents(connection: AwsConnection, logGroupName: string): Promise<CloudWatchLogEventSummary[]> {
  return unwrap((await awsBridge().listCloudWatchRecentEvents(connection, logGroupName)) as Wrapped<CloudWatchLogEventSummary[]>)
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

export async function listRoute53HostedZones(connection: AwsConnection): Promise<Route53HostedZoneSummary[]> {
  return unwrap((await awsBridge().listRoute53HostedZones(connection)) as Wrapped<Route53HostedZoneSummary[]>)
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

export async function getOverviewMetrics(connection: AwsConnection, regions: string[]): Promise<OverviewMetrics> {
  return unwrap((await awsBridge().getOverviewMetrics(connection, regions)) as Wrapped<OverviewMetrics>)
}

export async function getCostBreakdown(connection: AwsConnection): Promise<CostBreakdown> {
  return unwrap((await awsBridge().getCostBreakdown(connection)) as Wrapped<CostBreakdown>)
}

export async function getOverviewStatistics(connection: AwsConnection): Promise<OverviewStatistics> {
  return unwrap((await awsBridge().getOverviewStatistics(connection)) as Wrapped<OverviewStatistics>)
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

export async function listProjects(profileName: string): Promise<TerraformProjectListItem[]> {
  return unwrap((await terraformBridge().listProjects(profileName)) as Wrapped<TerraformProjectListItem[]>)
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

export async function updateInputs(profileName: string, projectId: string, inputs: Record<string, unknown>): Promise<TerraformProject> {
  return unwrap((await terraformBridge().updateInputs(profileName, projectId, inputs)) as Wrapped<TerraformProject>)
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
