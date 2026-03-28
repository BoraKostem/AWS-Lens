/* ── AWS ──────────────────────────────────────────────────── */

export type AwsProfile = {
  name: string
  source: 'config' | 'credentials'
  region: string
  managedByApp: boolean
}

export type AwsRegionOption = {
  id: string
  name: string
}

export type AwsCredentialSnapshot = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration: string
}

export type AwsAssumeRoleTarget = {
  id: string
  label: string
  roleArn: string
  defaultSessionName: string
  externalId: string
  sourceProfile: string
  defaultRegion: string
  createdAt: string
  updatedAt: string
}

export type AwsBaseConnection = {
  kind: 'profile'
  sessionId: string
  label: string
  profile: string
  region: string
}

export type AwsAssumedRoleConnection = {
  kind: 'assumed-role'
  sessionId: string
  label: string
  profile: string
  sourceProfile: string
  region: string
  roleArn: string
  assumedRoleArn: string
  accountId: string
  accessKeyId: string
  expiration: string
  externalId: string
}

export type AwsConnection = AwsBaseConnection | AwsAssumedRoleConnection

export type AwsSessionStatus = 'active' | 'expired'

export type AwsSessionSummary = {
  id: string
  kind: AwsConnection['kind']
  label: string
  profile: string
  region: string
  status: AwsSessionStatus
  sourceProfile: string
  roleArn: string
  assumedRoleArn: string
  accountId: string
  accessKeyId: string
  expiration: string
  externalId: string
  createdAt: string
  updatedAt: string
}

export type SessionHubState = {
  targets: AwsAssumeRoleTarget[]
  sessions: AwsSessionSummary[]
}

export type AssumeRoleRequest = {
  label: string
  roleArn: string
  sessionName: string
  externalId?: string
  sourceProfile?: string
  region?: string
}

export type CallerIdentity = {
  account: string
  arn: string
  userId: string
}

export type AppReleaseInfo = {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string
  checkedAt: string | null
  error: string | null
}

export type Ec2SsmStatus = 'managed-online' | 'managed-offline' | 'not-managed'

export type SsmManagedInstanceSummary = {
  instanceId: string
  managedInstanceId: string
  name: string
  computerName: string
  pingStatus: string
  lastPingAt: string
  agentVersion: string
  isLatestVersion: boolean
  platformType: string
  platformName: string
  platformVersion: string
  resourceType: string
  ipAddress: string
  source: 'ec2' | 'temp-inspection'
  sourceVolumeId: string
}

export type SsmSessionSummary = {
  sessionId: string
  target: string
  status: string
  documentName: string
  reason: string
  owner: string
  startedAt: string
  endedAt: string
  accessType: 'shell' | 'port-forward'
}

export type SsmCommandExecutionResult = {
  commandId: string
  instanceId: string
  documentName: string
  status: string
  statusDetails: string
  requestedAt: string
  completedAt: string
  responseCode: number | null
  executionType: 'document' | 'shell-command'
  commandLabel: string
  commandText: string
  standardOutput: string
  standardError: string
}

export type SsmPortForwardPreset = {
  id: string
  label: string
  description: string
  documentName: 'AWS-StartPortForwardingSession' | 'AWS-StartPortForwardingSessionToRemoteHost'
  localPort: number
  remotePort: number
  remoteHost: string
}

export type SsmConnectionDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  code: string
  summary: string
  detail: string
}

export type SsmConnectionTarget = {
  instanceId: string
  instanceName: string
  status: Ec2SsmStatus
  managedInstance: SsmManagedInstanceSummary | null
  diagnostics: SsmConnectionDiagnostic[]
  canStartSession: boolean
  shellDocumentName: string
  portForwardPresets: SsmPortForwardPreset[]
}

export type SsmSessionLaunchSpec = {
  summary: SsmSessionSummary
  launchCommand: string
}

export type SsmStartSessionRequest = {
  targetInstanceId: string
  documentName?: string
  reason?: string
  parameters?: Record<string, string[]>
  accessType?: 'shell' | 'port-forward'
}

export type SsmSendCommandRequest = {
  instanceId: string
  documentName: string
  commands?: string[]
  comment?: string
  timeoutSeconds?: number
}

export type Ec2InstanceSummary = {
  name: string
  instanceId: string
  vpcId: string
  subnetId: string
  keyName: string
  type: string
  state: string
  availabilityZone: string
  platform: string
  publicIp: string
  privateIp: string
  iamProfile: string
  launchTime: string
  ssmStatus: Ec2SsmStatus
  ssmPingStatus: string
  ssmLastPingAt: string
  isTempInspectionInstance: boolean
  tempInspectionSourceVolumeId: string
}

export type Ec2InstanceDetail = {
  instanceId: string
  name: string
  state: string
  type: string
  platform: string
  architecture: string
  privateIp: string
  publicIp: string
  vpcId: string
  subnetId: string
  keyName: string
  availabilityZone: string
  launchTime: string
  imageId: string
  rootDeviceType: string
  rootDeviceName: string
  iamProfile: string
  iamAssociationId: string
  securityGroups: Array<{ id: string; name: string }>
  tags: Record<string, string>
  volumes: Array<{ volumeId: string; device: string; deleteOnTermination: boolean }>
  stateReason: string
  stateTransitionReason: string
  ssmStatus: Ec2SsmStatus
  ssmPingStatus: string
  ssmLastPingAt: string
  ssmManagedInstance: SsmManagedInstanceSummary | null
  ssmDiagnostics: SsmConnectionDiagnostic[]
  isTempInspectionInstance: boolean
  tempInspectionSourceVolumeId: string
}

export type Ec2InstanceAction = 'start' | 'stop' | 'reboot'

export type Ec2SnapshotSummary = {
  snapshotId: string
  volumeId: string
  state: string
  startTime: string
  progress: string
  volumeSize: number
  description: string
  encrypted: boolean
  ownerId: string
  tags: Record<string, string>
}

export type EbsVolumeStatus = 'attached' | 'available-orphan' | 'multi-attach' | 'unknown'

export type EbsVolumeAttachment = {
  instanceId: string
  device: string
  state: string
  attachTime: string
  deleteOnTermination: boolean
}

export type EbsTempInspectionEnvironment = {
  tempUuid: string
  purpose: string
  sourceVolumeId: string
  instanceId: string
  instanceState: string
  availabilityZone: string
  subnetId: string
  vpcId: string
  securityGroupId: string
  iamRoleName: string
  instanceProfileName: string
  attachDevice: string
  ssmReady: boolean
  launchTime: string
  tags: Record<string, string>
}

export type EbsTempInspectionProgress = {
  mode: 'create' | 'delete'
  tempUuid: string
  volumeId: string
  instanceId: string
  stage:
    | 'preparing'
    | 'creating-iam-profile-if-needed'
    | 'creating-instance'
    | 'waiting-for-instance-readiness'
    | 'verifying-ssm-readiness'
    | 'attaching-target-volume'
    | 'detaching-inspected-volume-if-needed'
    | 'deleting-temp-resources'
    | 'terminating-instance'
    | 'waiting-for-termination'
    | 'finalizing'
    | 'completed'
    | 'failed'
  status: 'running' | 'completed' | 'failed'
  message: string
  error?: string
}

export type EbsVolumeSummary = {
  volumeId: string
  name: string
  state: string
  status: EbsVolumeStatus
  sizeGiB: number
  type: string
  iops: number
  throughput: number
  encrypted: boolean
  availabilityZone: string
  createTime: string
  snapshotId: string
  multiAttachEnabled: boolean
  attachments: EbsVolumeAttachment[]
  attachedInstanceIds: string[]
  attachedDevices: string[]
  tags: Record<string, string>
  tempEnvironment: EbsTempInspectionEnvironment | null
}

export type EbsVolumeDetail = EbsVolumeSummary & {
  isOrphan: boolean
}

export type Ec2InstanceTypeOption = {
  instanceType: string
  vcpus: number
  memoryMiB: number
  architecture: string
  currentGeneration: boolean
}

export type Ec2Recommendation = {
  instanceId: string
  instanceName: string
  currentType: string
  suggestedType: string
  reason: string
  avgCpu: number
  maxCpu: number
  severity: 'info' | 'warning'
}

export type Ec2IamAssociation = {
  associationId: string
  instanceId: string
  iamProfileArn: string
  iamProfileId: string
  state: string
}

export type Ec2VpcDetail = {
  vpcId: string
  cidrBlock: string
  state: string
  isDefault: boolean
  tags: Record<string, string>
}

export type BastionLaunchConfig = {
  imageId: string
  instanceType: string
  subnetId: string
  keyName: string
  securityGroupIds: string[]
  targetInstanceId: string
}

export type BastionAmiOption = {
  imageId: string
  name: string
  description: string
  platform: string
  architecture: string
  creationDate: string
}

export type BastionConnectionInfo = {
  bastionUuid: string
  targetInstanceId: string
  bastionInstanceIds: string[]
  bastionSecurityGroupId: string
  targetSecurityGroupIds: string[]
}

export type SnapshotLaunchConfig = {
  snapshotId: string
  name: string
  instanceType: string
  subnetId: string
  keyName: string
  securityGroupIds: string[]
  architecture: string
}

export type LambdaFunctionSummary = {
  functionName: string
  handler: string
  runtime: string
  memory: number | string
  lastModified: string
}

export type LambdaInvokeResult = {
  statusCode: number | null
  functionError: string
  executedVersion: string
  payload: unknown
  rawPayload: string
}

export type LambdaFunctionDetail = {
  functionName: string
  functionArn: string
  runtime: string
  handler: string
  role: string
  description: string
  timeout: number
  memorySize: number
  lastModified: string
  state: string
  lastUpdateStatus: string
  environment: Record<string, string>
}

export type LambdaCodeResult = {
  files: Array<{ path: string; content: string }>
  truncated: boolean
}

export type LambdaCreateConfig = {
  functionName: string
  runtime: string
  handler: string
  role: string
  code: string
  description?: string
  timeout?: number
  memorySize?: number
}

export type EksClusterSummary = {
  name: string
  status: string
  version: string
  endpoint: string
  roleArn: string
}

export type EksClusterDetail = {
  name: string
  status: string
  version: string
  platformVersion: string
  endpoint: string
  roleArn: string
  createdAt: string
  vpcId: string
  subnetIds: string[]
  securityGroupIds: string[]
  clusterSecurityGroupId: string
  serviceIpv4Cidr: string
  endpointPublicAccess: boolean
  endpointPrivateAccess: boolean
  publicAccessCidrs: string[]
  loggingEnabled: string[]
  tags: Record<string, string>
  oidcIssuer: string
}

export type EksNodegroupSummary = {
  name: string
  status: string
  min: number | string
  desired: number | string
  max: number | string
  instanceTypes: string
}

export type EksUpdateEvent = {
  id: string
  type: string
  status: string
  createdAt: string
  params: Array<{ type: string; value: string }>
  errors: string[]
}

export type AutoScalingGroupSummary = {
  name: string
  min: number | string
  desired: number | string
  max: number | string
  instances: number
  healthCheck: string
  instanceRefresh: string
}

export type AutoScalingInstanceSummary = {
  instanceId: string
  lifecycleState: string
  healthStatus: string
  protectedFromScaleIn: boolean
  availabilityZone: string
}

export type LoadBalancerSummary = {
  arn: string
  name: string
  dnsName: string
  type: string
  scheme: string
  state: string
  vpcId: string
  availabilityZones: string[]
  securityGroups: string[]
  createdTime: string
}

export type LoadBalancerListener = {
  arn: string
  port: number
  protocol: string
  sslPolicy: string
  certificates: string[]
  defaultActions: string[]
}

export type LoadBalancerRule = {
  arn: string
  listenerArn: string
  priority: string
  isDefault: boolean
  conditions: string[]
  actions: string[]
}

export type TargetGroupHealthCheck = {
  protocol: string
  port: string
  path: string
  intervalSeconds: number
  timeoutSeconds: number
  healthyThreshold: number
  unhealthyThreshold: number
  matcher: string
}

export type LoadBalancerTargetGroup = {
  arn: string
  name: string
  protocol: string
  port: number
  targetType: string
  vpcId: string
  loadBalancerArns: string[]
  healthCheck: TargetGroupHealthCheck
}

export type LoadBalancerTargetHealth = {
  id: string
  port: number | null
  availabilityZone: string
  state: string
  reason: string
  description: string
}

export type LoadBalancerTimelineEvent = {
  id: string
  timestamp: string
  title: string
  detail: string
  severity: 'info' | 'warning' | 'error'
}

export type LoadBalancerWorkspace = {
  summary: LoadBalancerSummary
  listeners: LoadBalancerListener[]
  rulesByListener: Record<string, LoadBalancerRule[]>
  targetGroups: LoadBalancerTargetGroup[]
  targetsByGroup: Record<string, LoadBalancerTargetHealth[]>
  timeline: LoadBalancerTimelineEvent[]
}

export type ServiceId =
  | 'terraform'
  | 'overview'
  | 'session-hub'
  | 'compliance-center'
    | 'ec2'
    | 'cloudwatch'
    | 's3'
    | 'lambda'
  | 'rds'
  | 'cloudformation'
  | 'cloudtrail'
    | 'ecr'
    | 'eks'
    | 'ecs'
    | 'vpc'
    | 'load-balancers'
    | 'auto-scaling'
    | 'route53'
    | 'security-groups'
  | 'iam'
    | 'identity-center'
    | 'sns'
    | 'sqs'
    | 'acm'
    | 'secrets-manager'
  | 'key-pairs'
  | 'sts'
  | 'kms'
  | 'waf'

export type ServiceDescriptor = {
  id: ServiceId
  label: string
  category: string
  migrated: boolean
}

/* ── VPC ─────────────────────────────────────────────────── */

export type VpcSummary = {
  vpcId: string
  cidrBlock: string
  state: string
  isDefault: boolean
  name: string
  ownerId: string
  tags: Record<string, string>
}

export type SubnetSummary = {
  subnetId: string
  vpcId: string
  cidrBlock: string
  availabilityZone: string
  availableIpAddressCount: number
  mapPublicIpOnLaunch: boolean
  state: string
  name: string
  tags: Record<string, string>
}

export type RouteTableSummary = {
  routeTableId: string
  vpcId: string
  name: string
  isMain: boolean
  associatedSubnets: string[]
  routes: Array<{
    destination: string
    target: string
    state: string
  }>
  tags: Record<string, string>
}

export type InternetGatewaySummary = {
  igwId: string
  state: string
  attachedVpcId: string
  name: string
  tags: Record<string, string>
}

export type NatGatewaySummary = {
  natGatewayId: string
  state: string
  subnetId: string
  vpcId: string
  connectivityType: string
  publicIp: string
  privateIp: string
  name: string
  tags: Record<string, string>
}

export type TransitGatewaySummary = {
  tgwId: string
  state: string
  ownerId: string
  description: string
  amazonSideAsn: string
  name: string
  tags: Record<string, string>
}

export type NetworkInterfaceSummary = {
  networkInterfaceId: string
  vpcId: string
  subnetId: string
  availabilityZone: string
  privateIp: string
  publicIp: string
  status: string
  interfaceType: string
  description: string
  attachedInstanceId: string
  securityGroups: Array<{ id: string; name: string }>
  tags: Record<string, string>
}

export type SecurityGroupSummary = {
  groupId: string
  groupName: string
  vpcId: string
  description: string
  inboundRuleCount: number
  outboundRuleCount: number
  inboundRules: Array<{
    protocol: string
    portRange: string
    source: string
    description: string
  }>
  outboundRules: Array<{
    protocol: string
    portRange: string
    destination: string
    description: string
  }>
  tags: Record<string, string>
}

export type SecurityGroupDetail = {
  groupId: string
  groupName: string
  vpcId: string
  description: string
  ownerId: string
  tags: Record<string, string>
  inboundRules: SecurityGroupRule[]
  outboundRules: SecurityGroupRule[]
}

export type SecurityGroupRule = {
  protocol: string
  fromPort: number
  toPort: number
  portRange: string
  sources: string[]
  description: string
}

export type SecurityGroupRuleInput = {
  protocol: string
  fromPort: number
  toPort: number
  cidrIp?: string
  sourceGroupId?: string
  description: string
}

export type VpcTopology = {
  vpcs: VpcSummary[]
  subnets: SubnetSummary[]
  routeTables: RouteTableSummary[]
  internetGateways: InternetGatewaySummary[]
  natGateways: NatGatewaySummary[]
}

export type VpcFlowDiagramData = {
  nodes: Array<{ id: string; type: string; label: string; detail: string }>
  edges: Array<{ source: string; target: string; label: string }>
}

export type ReachabilityPathResult = {
  analysisId: string
  status: string
  statusMessage: string
  source: string
  destination: string
  protocol: string
  reachable: boolean | null
  explanations: string[]
}

/* ── CloudWatch ───────────────────────────────────────────── */

export type CloudWatchMetricSummary = {
  namespace: string
  metricName: string
  dimensions: string[]
}

export type CloudWatchNamespaceSummary = {
  namespace: string
  metricCount: number
  dimensionKeys: string[]
}

export type CloudWatchDatapoint = {
  timestamp: string
  value: number
}

export type CloudWatchMetricSeries = {
  metricName: string
  unit: string
  points: CloudWatchDatapoint[]
}

export type CloudWatchLogGroupSummary = {
  name: string
  arn: string
  storedBytes: number
  retentionInDays: number | null
  logClass: string
}

export type CloudWatchMetricStatistic = {
  namespace: string
  metricName: string
  dimensions: string[]
  latest: number | null
  average: number | null
  min: number | null
  max: number | null
  unit: string
}

export type CloudWatchLogEventSummary = {
  eventId: string
  ingestionTime: string
  timestamp: string
  logStreamName: string
  message: string
}

export type Route53HostedZoneSummary = {
  id: string
  name: string
  privateZone: boolean
  recordSetCount: number
  comment: string
}

export type Route53RecordSummary = {
  name: string
  type: string
  ttl: number | null
  values: string[]
  isAlias: boolean
  aliasDnsName: string
  aliasHostedZoneId: string
  evaluateTargetHealth: boolean
  setIdentifier: string
  routingPolicy: string
}

export type Route53RecordChange = {
  name: string
  type: string
  ttl: number | null
  values: string[]
  isAlias: boolean
  aliasDnsName: string
  aliasHostedZoneId: string
  evaluateTargetHealth: boolean
  setIdentifier: string
}

/* ── Overview ─────────────────────────────────────────────── */

export type RegionMetric = {
  region: string
  ec2Count: number
  lambdaCount: number
  eksCount: number
  asgCount: number
  s3Count: number
  rdsCount: number
  cloudformationCount: number
  ecrCount: number
  ecsCount: number
  vpcCount: number
  loadBalancerCount: number
  route53Count: number
  securityGroupCount: number
  snsCount: number
  sqsCount: number
  acmCount: number
  kmsCount: number
  wafCount: number
  secretsManagerCount: number
  keyPairCount: number
  cloudwatchCount: number
  cloudtrailCount: number
  iamCount: number
  totalResources: number
}

export type RegionCostRow = {
  region: string
  ec2Cost: number
  lambdaCost: number
  eksCost: number
  asgCost: number
  s3Cost: number
  rdsCost: number
  cfnCost: number
  ecrCost: number
  ecsCost: number
  vpcCost: number
  elbCost: number
  r53Cost: number
  sgCost: number
  snsCost: number
  sqsCost: number
  acmCost: number
  kmsCost: number
  wafCost: number
  smCost: number
  kpCost: number
  cwCost: number
  totalCost: number
}

export type OverviewMetrics = {
  regions: RegionMetric[]
  costs: RegionCostRow[]
  globalTotals: {
    totalResources: number
    totalCost: number
    regionCount: number
  }
}

export type CostBreakdownEntry = {
  service: string
  amount: number
}

export type CostBreakdown = {
  entries: CostBreakdownEntry[]
  total: number
  period: string
}

export type ServiceRelationship = {
  source: string
  sourceType: string
  target: string
  targetType: string
  relation: string
}

export type RelationshipMap = {
  nodes: Array<{ id: string; type: string; label: string }>
  edges: ServiceRelationship[]
}

export type OverviewStat = {
  label: string
  value: string
  detail: string
  trend: 'up' | 'down' | 'neutral'
}

export type InsightItem = {
  severity: 'info' | 'warning' | 'error'
  message: string
  service: string
  timestamp: string
}

export type RegionalSignal = {
  severity: 'low' | 'medium' | 'high'
  region: string
  title: string
  description: string
  nextStep: string
  category: 'cost' | 'security' | 'operations' | 'cleanup'
}

export type OverviewStatistics = {
  stats: OverviewStat[]
  insights: InsightItem[]
  signals: RegionalSignal[]
}

export type ComplianceSeverity = 'high' | 'medium' | 'low'

export type ComplianceCategory = 'security' | 'cost' | 'operations' | 'compliance'

export type ComplianceRemediationAction =
  | {
      kind: 'navigate'
      label: string
      serviceId: ServiceId
      resourceId?: string
    }
  | {
      kind: 'terminal'
      label: string
      command: string
    }
  | {
      kind: 'secret-rotate'
      label: string
      secretId: string
    }

export type ComplianceFinding = {
  id: string
  title: string
  severity: ComplianceSeverity
  category: ComplianceCategory
  service: ServiceId
  region: string
  resourceId: string
  description: string
  recommendedAction: string
  remediation?: ComplianceRemediationAction
}

export type ComplianceSummary = {
  total: number
  bySeverity: Record<ComplianceSeverity, number>
  byCategory: Record<ComplianceCategory, number>
}

export type ComplianceReport = {
  generatedAt: string
  findings: ComplianceFinding[]
  summary: ComplianceSummary
  warnings: string[]
}

export type TaggedResource = {
  resourceId: string
  resourceType: string
  service: string
  name: string
  tags: Record<string, string>
}

export type TagCostEntry = {
  tagKey: string
  tagValue: string
  resourceCount: number
  monthlyCost: number
}

export type TagSearchResult = {
  resources: TaggedResource[]
  costBreakdown: TagCostEntry[]
}

/* ── ECR ─────────────────────────────────────────────────── */

export type EcrRepositorySummary = {
  repositoryName: string
  repositoryUri: string
  registryId: string
  imageCount: number
  createdAt: string
  imageTagMutability: string
  scanOnPush: boolean
}

export type EcrImageSummary = {
  imageDigest: string
  imageTags: string[]
  pushedAt: string
  sizeBytes: number
  scanStatus: string
  lastScanAt: string
  lastPull: string
}

export type EcrScanFinding = {
  name: string
  severity: string
  description: string
  uri: string
  package: string
  packageVersion: string
}

export type EcrScanResult = {
  imageDigest: string
  scanStatus: string
  findingCounts: Record<string, number>
  findings: EcrScanFinding[]
  scanCompletedAt: string
}

export type EcrAuthorizationData = {
  proxyEndpoint: string
  token: string
  expiresAt: string
  loginCommand: string
}

/* ── CloudTrail ───────────────────────────────────────────── */

export type CloudTrailSummary = {
  name: string
  s3BucketName: string
  isMultiRegion: boolean
  isLogging: boolean
  homeRegion: string
  hasLogFileValidation: boolean
}

export type CloudTrailEventSummary = {
  eventId: string
  eventName: string
  eventSource: string
  eventTime: string
  username: string
  sourceIpAddress: string
  awsRegion: string
  resourceType: string
  resourceName: string
  readOnly: boolean
}

/* S3 */

export type S3BucketSummary = {
  name: string
  creationDate: string
  region: string
}

export type S3GovernanceSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type S3GovernanceFlagStatus =
  | 'enabled'
  | 'disabled'
  | 'partial'
  | 'present'
  | 'missing'
  | 'suspended'
  | 'unknown'

export type S3BucketGovernanceCheck = {
  status: S3GovernanceFlagStatus
  summary: string
}

export type S3BucketGovernanceFinding = {
  id: string
  severity: S3GovernanceSeverity
  title: string
  summary: string
  nextStep: string
}

export type S3BucketGovernancePosture = {
  bucketName: string
  region: string
  publicAccessBlock: S3BucketGovernanceCheck & {
    blockPublicAcls: boolean | null
    ignorePublicAcls: boolean | null
    blockPublicPolicy: boolean | null
    restrictPublicBuckets: boolean | null
  }
  encryption: S3BucketGovernanceCheck & {
    algorithm: string
    kmsKeyId: string
  }
  versioning: S3BucketGovernanceCheck & {
    mfaDelete: boolean | null
  }
  lifecycle: S3BucketGovernanceCheck & {
    ruleCount: number
  }
  policy: S3BucketGovernanceCheck & {
    statementCount: number
  }
  logging: S3BucketGovernanceCheck & {
    targetBucket: string
    targetPrefix: string
  }
  replication: S3BucketGovernanceCheck & {
    ruleCount: number
    destinationBuckets: string[]
  }
  important: boolean
  importantReason: string
  highestSeverity: S3GovernanceSeverity
  findings: S3BucketGovernanceFinding[]
}

export type S3GovernanceSummary = {
  bucketCount: number
  riskyBucketCount: number
  publicAccessRiskCount: number
  unencryptedBucketCount: number
  missingLifecycleCount: number
  importantWithoutVersioningCount: number
  bucketsBySeverity: Record<S3GovernanceSeverity, number>
}

export type S3GovernanceOverview = {
  generatedAt: string
  summary: S3GovernanceSummary
  buckets: S3BucketGovernancePosture[]
}

export type S3BucketGovernanceDetail = {
  posture: S3BucketGovernancePosture
  policyJson: string
  lifecycleJson: string
}

export type S3ObjectSummary = {
  key: string
  size: number
  lastModified: string
  storageClass: string
  isFolder: boolean
}

export type S3PresignedResult = {
  url: string
}

export type S3ObjectContent = {
  body: string
  contentType: string
}

/* RDS */

export type RdsInstanceSummary = {
  dbInstanceIdentifier: string
  engine: string
  engineVersion: string
  dbInstanceClass: string
  status: string
  endpoint: string
  port: number | null
  multiAz: boolean
  allocatedStorage: number
  availabilityZone: string
  dbClusterIdentifier: string
  isAurora: boolean
}

export type RdsClusterNodeSummary = {
  dbInstanceIdentifier: string
  role: 'writer' | 'reader'
  status: string
  dbInstanceClass: string
  availabilityZone: string
  endpoint: string
  port: number | null
  promotionTier: number | null
}

export type RdsClusterSummary = {
  dbClusterIdentifier: string
  clusterArn: string
  engine: string
  engineVersion: string
  status: string
  endpoint: string
  readerEndpoint: string
  port: number | null
  multiAz: boolean
  storageEncrypted: boolean
  writerNodes: RdsClusterNodeSummary[]
  readerNodes: RdsClusterNodeSummary[]
}

export type RdsOperationalStatusTone = 'good' | 'neutral' | 'warning' | 'risk'

export type RdsMaintenanceItem = {
  resourceIdentifier: string
  resourceType: 'instance' | 'cluster'
  sourceIdentifier: string
  action: string
  description: string
  autoAppliedAfter: string
  currentApplyDate: string
  optInStatus: string
}

export type RdsRiskFinding = {
  id: string
  severity: 'info' | 'warning' | 'risk'
  title: string
  message: string
  recommendation: string
}

export type RdsPostureBadge = {
  id: string
  label: string
  value: string
  tone: RdsOperationalStatusTone
}

export type RdsSummaryTile = {
  id: string
  label: string
  value: string
  tone: RdsOperationalStatusTone
}

export type RdsReplicaTopology = {
  sourceInstanceIdentifier: string
  replicaInstanceIdentifiers: string[]
}

export type RdsClusterFailoverReadiness = {
  ready: boolean
  summary: string
  reasons: string[]
}

export type RdsOperationalPosture = {
  badges: RdsPostureBadge[]
  summaryTiles: RdsSummaryTile[]
  findings: RdsRiskFinding[]
  maintenanceItems: RdsMaintenanceItem[]
  recommendations: string[]
  parameterGroupReferences: string[]
  subnetGroupReferences: string[]
  backupRetentionPeriod: number
  preferredBackupWindow: string
  preferredMaintenanceWindow: string
  isEncrypted: boolean
  isPubliclyAccessible: boolean
  isMultiAz: boolean
  replicaTopology?: RdsReplicaTopology
  failoverReadiness?: RdsClusterFailoverReadiness
}

export type RdsInstanceDetail = {
  summary: RdsInstanceSummary
  arn: string
  resourceId: string
  storageType: string
  storageEncrypted: boolean
  publiclyAccessible: boolean
  backupRetentionPeriod: number
  preferredBackupWindow: string
  preferredMaintenanceWindow: string
  caCertificateIdentifier: string
  masterUsername: string
  databaseName: string
  subnetGroup: string
  parameterGroups: string[]
  vpcSecurityGroupIds: string[]
  posture: RdsOperationalPosture
  connectionDetails: Array<{ label: string; value: string }>
  rawJson: string
}

export type RdsClusterDetail = {
  summary: RdsClusterSummary
  databaseName: string
  masterUsername: string
  backupRetentionPeriod: number
  preferredBackupWindow: string
  preferredMaintenanceWindow: string
  parameterGroups: string[]
  subnetGroup: string
  vpcSecurityGroupIds: string[]
  serverlessV2Scaling: string
  posture: RdsOperationalPosture
  connectionDetails: Array<{ label: string; value: string }>
  rawJson: string
}

/* CloudFormation */

export type CloudFormationStackSummary = {
  stackName: string
  stackId: string
  status: string
  description: string
  creationTime: string
  lastUpdatedTime: string
}

export type CloudFormationResourceSummary = {
  logicalResourceId: string
  physicalResourceId: string
  resourceType: string
  resourceStatus: string
  timestamp: string
}

export type CloudFormationChangeSetSummary = {
  stackName: string
  stackId: string
  changeSetName: string
  changeSetId: string
  description: string
  status: string
  executionStatus: string
  statusReason: string
  changeSetType: string
  creationTime: string
}

export type CloudFormationChangeSetDetail = {
  summary: CloudFormationChangeSetSummary
  parameters: Array<{
    parameterKey: string
    parameterValue: string
    usePreviousValue: boolean
  }>
  capabilities: string[]
  changes: Array<{
    action: string
    logicalResourceId: string
    physicalResourceId: string
    resourceType: string
    replacement: string
    scope: string[]
    details: string[]
  }>
  rawJson: string
}

export type CloudFormationStackDriftSummary = {
  stackName: string
  stackId: string
  stackDriftStatus: string
  detectionStatus: string
  detectionStatusReason: string
  driftDetectionId: string
  lastCheckTimestamp: string
}

export type CloudFormationDriftedResourceRow = {
  logicalResourceId: string
  physicalResourceId: string
  resourceType: string
  driftStatus: string
  details: string
  propertyDifferences: Array<{
    propertyPath: string
    expectedValue: string
    actualValue: string
    differenceType: string
  }>
  rawJson: string
}

/* ── ECS ──────────────────────────────────────────────────── */

export type EcsClusterSummary = {
  clusterName: string
  clusterArn: string
  status: string
  activeServicesCount: number
  runningTasksCount: number
  pendingTasksCount: number
  registeredContainerInstancesCount: number
}

export type EcsServiceSummary = {
  serviceName: string
  serviceArn: string
  status: string
  desiredCount: number
  runningCount: number
  pendingCount: number
  launchType: string
  taskDefinition: string
  deploymentStatus: string
}

export type EcsTaskSummary = {
  taskArn: string
  taskDefinitionArn: string
  lastStatus: string
  desiredStatus: string
  launchType: string
  startedAt: string
  stoppedAt: string
  stoppedReason: string
  cpu: string
  memory: string
  group: string
  containers: EcsContainerSummary[]
}

export type EcsContainerSummary = {
  name: string
  containerArn: string
  lastStatus: string
  exitCode: number | null
  reason: string
  image: string
  imageDigest: string
  cpu: string
  memory: string
  healthStatus: string
  logGroup: string
  logStream: string
}

export type EcsServiceDetail = {
  serviceName: string
  serviceArn: string
  clusterArn: string
  status: string
  desiredCount: number
  runningCount: number
  pendingCount: number
  launchType: string
  taskDefinition: string
  platformVersion: string
  networkMode: string
  subnets: string[]
  securityGroups: string[]
  assignPublicIp: string
  createdAt: string
  deployments: EcsDeployment[]
  events: EcsServiceEvent[]
}

export type EcsDeployment = {
  id: string
  status: string
  taskDefinition: string
  desiredCount: number
  runningCount: number
  pendingCount: number
  rolloutState: string
  createdAt: string
  updatedAt: string
}

export type EcsServiceEvent = {
  id: string
  createdAt: string
  message: string
}

export type EcsFargateServiceConfig = {
  clusterArn: string
  serviceName: string
  taskDefinition: string
  desiredCount: number
  subnets: string[]
  securityGroups: string[]
  assignPublicIp: boolean
}

export type EcsLogEvent = {
  timestamp: number
  message: string
}

export type EcsDiagnosticsSeverity = 'critical' | 'warning' | 'info'

export type EcsDiagnosticsStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

export type EcsDiagnosticsSummaryTile = {
  key: string
  label: string
  value: string
  tone: EcsDiagnosticsStatus
  detail: string
}

export type EcsDiagnosticsIndicator = {
  id: string
  title: string
  severity: EcsDiagnosticsSeverity
  status: 'detected' | 'clear'
  detail: string
}

export type EcsDiagnosticsTimelineItem = {
  id: string
  timestamp: string
  category: 'deployment' | 'service-event' | 'task-stop'
  severity: EcsDiagnosticsSeverity
  title: string
  detail: string
  relatedTaskArn?: string
}

export type EcsTaskDefinitionContainerReference = {
  name: string
  image: string
  imageDigest: string
  cpu: string
  memory: string
  essential: boolean
  logDriver: string
  logGroup: string
  logRegion: string
  logStreamPrefix: string
}

export type EcsTaskDefinitionReference = {
  taskDefinitionArn: string
  family: string
  revision: number
  networkMode: string
  executionRoleArn: string
  taskRoleArn: string
  containerImages: EcsTaskDefinitionContainerReference[]
}

export type EcsDiagnosticsTaskRow = {
  taskArn: string
  taskId: string
  taskDefinitionArn: string
  lastStatus: string
  desiredStatus: string
  startedAt: string
  stoppedAt: string
  stoppedReason: string
  launchType: string
  healthStatus: string
  isFailed: boolean
  isPending: boolean
  containers: EcsContainerSummary[]
}

export type EcsDiagnosticsTaskSelection = {
  taskArn: string
  taskId: string
  stoppedReason: string
  lastStatus: string
  desiredStatus: string
  startedAt: string
  stoppedAt: string
  healthStatus: string
  containers: EcsContainerSummary[]
}

export type EcsDiagnosticsLogTarget = {
  taskArn: string
  taskId: string
  containerName: string
  logGroup: string
  logStream: string
  available: boolean
  reason: string
}

export type EcsServiceDiagnostics = {
  service: EcsServiceDetail
  deployments: EcsDeployment[]
  summaryTiles: EcsDiagnosticsSummaryTile[]
  indicators: EcsDiagnosticsIndicator[]
  likelyPatterns: string[]
  timeline: EcsDiagnosticsTimelineItem[]
  recentDeployments: EcsDeployment[]
  unstableTasks: EcsDiagnosticsTaskRow[]
  failedTasks: EcsDiagnosticsTaskRow[]
  pendingTasks: EcsDiagnosticsTaskRow[]
  taskRows: EcsDiagnosticsTaskRow[]
  selectedTask: EcsDiagnosticsTaskSelection | null
  taskDefinition: EcsTaskDefinitionReference | null
  logTargets: EcsDiagnosticsLogTarget[]
}

/* ── IAM ─────────────────────────────────────────────────── */

export type IamUserSummary = {
  userName: string
  userId: string
  arn: string
  path: string
  createDate: string
  passwordLastUsed: string
  hasMfa: boolean
  accessKeyCount: number
  groupCount: number
  hasConsoleAccess: boolean
}

export type IamGroupSummary = {
  groupName: string
  groupId: string
  arn: string
  path: string
  createDate: string
  memberCount: number
  policyCount: number
}

export type IamRoleSummary = {
  roleName: string
  roleId: string
  arn: string
  path: string
  createDate: string
  maxSessionDuration: number
  description: string
  attachedPolicyCount: number
}

export type IamPolicySummary = {
  policyName: string
  policyId: string
  arn: string
  path: string
  createDate: string
  updateDate: string
  attachmentCount: number
  defaultVersionId: string
  isAwsManaged: boolean
  description: string
}

export type IamAccessKeySummary = {
  accessKeyId: string
  status: string
  createDate: string
  userName: string
}

export type IamMfaDevice = {
  serialNumber: string
  enableDate: string
  userName: string
}

export type IamAttachedPolicy = {
  policyName: string
  policyArn: string
}

export type IamInlinePolicy = {
  policyName: string
  policyDocument: string
}

export type IamPolicyVersion = {
  versionId: string
  isDefaultVersion: boolean
  createDate: string
  document: string
}

export type IamAccountSummary = Record<string, number>

export type IamSimulationResult = {
  actionName: string
  resourceArn: string
  decision: string
  matchedStatements: Array<{ sourcePolicyId: string; sourcePolicyType: string }>
}

export type IamCredentialReportEntry = {
  user: string
  arn: string
  userCreationTime: string
  passwordEnabled: string
  passwordLastUsed: string
  passwordLastChanged: string
  passwordNextRotation: string
  mfaActive: string
  accessKey1Active: string
  accessKey1LastRotated: string
  accessKey1LastUsedDate: string
  accessKey1LastUsedRegion: string
  accessKey1LastUsedService: string
  accessKey2Active: string
  accessKey2LastRotated: string
  accessKey2LastUsedDate: string
  accessKey2LastUsedRegion: string
  accessKey2LastUsedService: string
}

/* ── SNS ─────────────────────────────────────────────────── */

export type SnsTopicSummary = {
  topicArn: string
  name: string
  displayName: string
  subscriptionCount: number
  policy: string
  deliveryPolicy: string
  effectiveDeliveryPolicy: string
  owner: string
  kmsMasterKeyId: string
  fifoTopic: boolean
  contentBasedDeduplication: boolean
  tags: Record<string, string>
}

export type SnsSubscriptionSummary = {
  subscriptionArn: string
  topicArn: string
  protocol: string
  endpoint: string
  owner: string
  confirmationWasAuthenticated: boolean
  pendingConfirmation: boolean
  rawMessageDelivery: boolean
  filterPolicy: string
}

export type SnsPublishResult = {
  messageId: string
  sequenceNumber: string
}

/* ── SQS ─────────────────────────────────────────────────── */

export type SqsQueueSummary = {
  queueUrl: string
  queueName: string
  approximateMessageCount: number
  approximateNotVisibleCount: number
  approximateDelayedCount: number
  createdTimestamp: string
  lastModifiedTimestamp: string
  visibilityTimeout: number
  maximumMessageSize: number
  messageRetentionPeriod: number
  delaySeconds: number
  fifoQueue: boolean
  contentBasedDeduplication: boolean
  policy: string
  redrivePolicy: string
  redriveAllowPolicy: string
  deadLetterTargetArn: string
  maxReceiveCount: number
  kmsMasterKeyId: string
  tags: Record<string, string>
}

export type SqsMessage = {
  messageId: string
  receiptHandle: string
  body: string
  md5OfBody: string
  sentTimestamp: string
  approximateReceiveCount: number
  approximateFirstReceiveTimestamp: string
  attributes: Record<string, string>
  messageAttributes: Record<string, string>
}

export type SqsSendResult = {
  messageId: string
  md5OfBody: string
  sequenceNumber: string
}

export type SqsTimelineEvent = {
  timestamp: string
  title: string
  detail: string
  severity: 'info' | 'warning' | 'error'
}

/* ── Identity Center / SSO ────────────────────────────────── */

export type SsoInstanceSummary = {
  instanceArn: string
  identityStoreId: string
  name: string
  status: string
  ownerAccountId: string
  createdDate: string
}

export type SsoPermissionSetSummary = {
  permissionSetArn: string
  name: string
  description: string
  sessionDuration: string
  relayState: string
  createdDate: string
}

export type SsoUserSummary = {
  userId: string
  userName: string
  displayName: string
  email: string
  identityStoreId: string
}

export type SsoGroupSummary = {
  groupId: string
  displayName: string
  description: string
  identityStoreId: string
}

export type SsoAccountAssignment = {
  accountId: string
  permissionSetArn: string
  permissionSetName: string
  principalType: string
  principalId: string
  principalName: string
}

export type SsoSimulationRequest = {
  instanceArn: string
  permissionSetArn: string
  principalId: string
  principalType: 'USER' | 'GROUP'
}

export type SsoSimulationResult = {
  permissionSetName: string
  principalName: string
  managedPolicies: string[]
  inlinePolicy: string
  customerManagedPolicies: string[]
}

/* ── Terraform ────────────────────────────────────────────── */

export type TerraformCommandName =
  | 'init'
  | 'plan'
  | 'apply'
  | 'destroy'
  | 'state-list'
  | 'state-show'
  | 'state-pull'
  | 'version'

export type TerraformCliInfo = {
  found: boolean
  path: string
  version: string
  error: string
}

export type TerraformVariableDefinition = {
  name: string
  description: string
  hasDefault: boolean
  defaultValue: string
}

export type TerraformProjectMetadata = {
  terraformVersionConstraint: string
  backendType: string
  providerNames: string[]
  resourceCount: number
  moduleCount: number
  variableCount: number
  outputsCount: number
  tfFileCount: number
  lastScannedAt: string
  s3Backend: TerraformS3BackendConfig | null
}

export type TerraformS3BackendConfig = {
  bucket: string
  key: string
  region: string
  workspaceKeyPrefix: string
}

export type TerraformResourceInventoryItem = {
  address: string
  type: string
  name: string
  provider: string
  modulePath: string
  mode: 'managed' | 'data'
  dependsOn: string[]
  values: Record<string, unknown>
}

export type TerraformPlanChange = {
  address: string
  type: string
  name: string
  modulePath: string
  provider: string
  actions: string[]
  actionLabel: string
}

export type TerraformActionRow = {
  order: number
  action: string
  address: string
  resourceType: string
  physicalResourceId: string
}

export type TerraformResourceRow = {
  category: string
  address: string
  type: string
  arn: string
  region: string
  changedBy: string
  tags: string
}

export type TerraformGraphNode = {
  id: string
  label: string
  category: string
}

export type TerraformGraphEdge = {
  from: string
  to: string
  relation: string
}

export type TerraformDiagram = {
  nodes: TerraformGraphNode[]
  edges: TerraformGraphEdge[]
}

export type TerraformCommandLog = {
  id: string
  projectId: string
  command: TerraformCommandName
  args: string[]
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  success: boolean | null
  output: string
}

export type TerraformProjectStatus = 'Ready' | 'Missing'

export type TerraformDriftStatus =
  | 'in_sync'
  | 'drifted'
  | 'missing_in_aws'
  | 'unmanaged_in_aws'
  | 'unsupported'

export type TerraformDriftItem = {
  terraformAddress: string
  resourceType: string
  logicalName: string
  cloudIdentifier: string
  region: string
  status: TerraformDriftStatus
  explanation: string
  suggestedNextStep: string
  consoleUrl: string
  terminalCommand: string
}

export type TerraformDriftSummary = {
  total: number
  statusCounts: Record<TerraformDriftStatus, number>
  resourceTypeCounts: Array<{ resourceType: string; count: number }>
  scannedAt: string
}

export type TerraformDriftReport = {
  projectId: string
  projectName: string
  profileName: string
  region: string
  summary: TerraformDriftSummary
  items: TerraformDriftItem[]
}

export type TerraformProject = {
  id: string
  name: string
  rootPath: string
  varFile: string
  variables: Record<string, unknown>
  status: TerraformProjectStatus
  inputsFilePath: string
  detectedVariables: TerraformVariableDefinition[]
  inputs: Record<string, unknown>
  metadata: TerraformProjectMetadata
  inventory: TerraformResourceInventoryItem[]
  planChanges: TerraformPlanChange[]
  actionRows: TerraformActionRow[]
  resourceRows: TerraformResourceRow[]
  diagram: TerraformDiagram
  lastPlanSummary: {
    create: number
    update: number
    delete: number
    replace: number
    noop: number
  }
  lastCommandAt: string
  stateAddresses: string[]
  rawStateJson: string
  stateSource: string
  hasSavedPlan: boolean
}

export type TerraformCommandRequest = {
  profileName: string
  connection?: AwsConnection
  projectId: string
  command: TerraformCommandName
  stateAddress?: string
}

export type TerraformProjectListItem = Pick<
  TerraformProject,
  'id' | 'name' | 'rootPath' | 'status' | 'stateSource' | 'metadata' | 'lastPlanSummary' | 'lastCommandAt' | 'inventory'
>

export type TerraformProgressEvent = {
  address: string
  status: string
  raw: string
}

export type TerraformMissingVarsResult = {
  missing: string[]
  invalid: string[]
}

/* ACM */

export type AcmCertificateSummary = {
  certificateArn: string
  domainName: string
  status: string
  type: string
  inUse: boolean
  unused: boolean
  createdAt: string
  issuedAt: string
  notAfter: string
  daysUntilExpiry: number | null
  urgencySeverity: 'critical' | 'warning' | 'stable' | 'none'
  urgencyReason: string
  renewalEligibility: string
  renewalStatus: string
  pendingValidationCount: number
  dnsValidationIssueCount: number
  inUseByCount: number
  loadBalancerAssociations: AcmLoadBalancerAssociation[]
  inUseAssociations: AcmInUseAssociation[]
}

export type AcmLoadBalancerAssociation = {
  loadBalancerArn: string
  loadBalancerName: string
  dnsName: string
  listenerArn: string
  listenerPort: number
  listenerProtocol: string
}

export type AcmInUseAssociation = {
  arn: string
  service: string
  resourceType: string
  label: string
}

export type AcmCertificateDetail = {
  certificateArn: string
  domainName: string
  subjectAlternativeNames: string[]
  status: string
  type: string
  keyAlgorithm: string
  signatureAlgorithm: string
  createdAt: string
  issuedAt: string
  notBefore: string
  notAfter: string
  daysUntilExpiry: number | null
  urgencySeverity: 'critical' | 'warning' | 'stable' | 'none'
  urgencyReason: string
  renewalEligibility: string
  renewalStatus: string
  inUse: boolean
  unused: boolean
  inUseBy: string[]
  inUseAssociations: AcmInUseAssociation[]
  loadBalancerAssociations: AcmLoadBalancerAssociation[]
  pendingValidationCount: number
  dnsValidationIssueCount: number
  domainValidationOptions: Array<{
    domainName: string
    validationStatus: string
    validationMethod: string
    resourceRecordName: string
    resourceRecordType: string
    resourceRecordValue: string
    validationIssue: string
  }>
}

export type AcmRequestCertificateInput = {
  domainName: string
  subjectAlternativeNames: string[]
  validationMethod: 'DNS' | 'EMAIL'
}

/* Secrets Manager */

export type SecretsManagerSecretSummary = {
  arn: string
  name: string
  description: string
  owningService: string
  primaryRegion: string
  rotationEnabled: boolean
  deletedDate: string
  lastChangedDate: string
  lastAccessedDate: string
  versionCount: number
  tags: Record<string, string>
}

export type SecretVersionSummary = {
  versionId: string
  createdDate: string
  stages: string[]
  isCurrent: boolean
}

export type SecretsManagerSecretValue = {
  secretString: string
  secretBinary: string
  versionId: string
  versionStages: string[]
  createdDate: string
}

export type SecretsManagerSecretDetail = {
  arn: string
  name: string
  description: string
  kmsKeyId: string
  owningService: string
  primaryRegion: string
  rotationEnabled: boolean
  rotationLambdaArn: string
  deletedDate: string
  lastChangedDate: string
  lastAccessedDate: string
  nextRotationDate: string
  tags: Record<string, string>
  versions: SecretVersionSummary[]
  policy: string
}

export type SecretDependencyConfidence = 'high' | 'medium' | 'low'

export type SecretDependencySignal = 'confirmed' | 'heuristic'

export type SecretDependencyEvidence = {
  kind:
    | 'direct-arn-reference'
    | 'name-reference'
    | 'task-definition-secret'
    | 'repository-credentials'
    | 'kubectl-config-reference'
  field: string
  summary: string
}

export type SecretDependencyNavigationTarget = {
  service: 'lambda' | 'ecs' | 'eks'
  resourceId: string
  clusterArn: string
  clusterName: string
  serviceName: string
  region: string
}

export type SecretDependencyItem = {
  id: string
  serviceType: string
  resourceName: string
  resourceId: string
  region: string
  evidence: SecretDependencyEvidence[]
  reason: string
  confidence: SecretDependencyConfidence
  signal: SecretDependencySignal
  navigation: SecretDependencyNavigationTarget | null
}

export type SecretDependencyRiskLevel = 'info' | 'warning' | 'critical'

export type SecretDependencyRisk = {
  id:
    | 'rotation-disabled'
    | 'stale-access'
    | 'appears-unused'
    | 'many-consumers'
  level: SecretDependencyRiskLevel
  title: string
  detail: string
}

export type SecretDependencyPosture = {
  rotationEnabled: boolean
  nextRotationDate: string
  versionCount: number
  hasPolicy: boolean
  tags: Record<string, string>
  lastAccessedDate: string
}

export type SecretDependencyReport = {
  secretArn: string
  secretName: string
  region: string
  generatedAt: string
  posture: SecretDependencyPosture
  dependencies: SecretDependencyItem[]
  risks: SecretDependencyRisk[]
  notes: string[]
}

export type SecretTag = {
  key: string
  value: string
}

export type SecretCreateInput = {
  name: string
  description: string
  secretString: string
  kmsKeyId: string
  tags: SecretTag[]
}

export type SecretValueUpdateInput = {
  secretId: string
  secretString: string
}

/* Key pairs */

export type KeyPairSummary = {
  keyName: string
  keyPairId: string
  keyType: string
  fingerprint: string
  createdAt: string
  tags: Record<string, string>
}

export type CreatedKeyPair = {
  keyName: string
  keyPairId: string
  keyFingerprint: string
  keyMaterial: string
}

/* STS */

export type StsDecodedAuthorizationMessage = {
  decodedMessage: string
}

export type AccessKeyOwnership = {
  account: string
  arn: string
  userId: string
}

export type AssumeRoleResult = {
  sessionId: string
  label: string
  sourceProfile: string
  roleArn: string
  assumedRoleArn: string
  assumedRoleId: string
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration: string
  packedPolicySize: number
  region: string
  externalId: string
}

/* KMS */

export type KmsKeySummary = {
  keyId: string
  keyArn: string
  aliasNames: string[]
  description: string
  enabled: boolean
  keyState: string
  keyUsage: string
  keySpec: string
  creationDate: string
}

export type KmsKeyDetail = {
  keyId: string
  keyArn: string
  description: string
  enabled: boolean
  keyState: string
  keyManager: string
  origin: string
  keyUsage: string
  keySpec: string
  encryptionAlgorithms: string[]
  signingAlgorithms: string[]
  multiRegion: boolean
  deletionDate: string
  creationDate: string
  aliasNames: string[]
}

export type KmsDecryptResult = {
  plaintext: string
  plaintextBase64: string
  keyId: string
  encryptionAlgorithm: string
}

/* WAF */

export type WafScope = 'REGIONAL' | 'CLOUDFRONT'

export type WafWebAclSummary = {
  id: string
  name: string
  arn: string
  description: string
  scope: WafScope
  capacity: number
  lockToken: string
}

export type WafRuleSummary = {
  name: string
  priority: number
  action: string
  statementType: string
  metricName: string
}

export type WafAssociationSummary = {
  resourceArn: string
}

export type WafWebAclDetail = {
  id: string
  name: string
  arn: string
  description: string
  scope: WafScope
  capacity: number
  defaultAction: string
  lockToken: string
  tokenDomains: string[]
  rules: WafRuleSummary[]
  associations: WafAssociationSummary[]
  rawRulesJson: string
}

export type WafRuleInput = {
  name: string
  priority: number
  action: 'Allow' | 'Block' | 'Count'
  rateLimit: number
  ipSetArn: string
  metricName: string
}

export type WafCreateWebAclInput = {
  name: string
  description: string
  scope: WafScope
  defaultAction: 'Allow' | 'Block'
}
