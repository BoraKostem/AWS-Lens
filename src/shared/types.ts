/* ── AWS ──────────────────────────────────────────────────── */

export type ProviderProfileSource = string

export type ProviderProfileState = 'available' | 'connected' | 'expired'

export type ProviderProfileRecord<TSource extends ProviderProfileSource = ProviderProfileSource> = {
  providerId: CloudProviderId
  id: string
  label: string
  source: TSource
  defaultLocationId: string
  managedByApp: boolean
}

export type ProviderLocationOption<TKind extends ProviderLocationKind = ProviderLocationKind> = {
  providerId: CloudProviderId
  id: string
  name: string
  kind: TKind
}

export type ProviderIdentity = {
  providerId: CloudProviderId
  accountId: string
  principalArn: string
  principalId: string
}

export type ProviderScopedConnection<TKind extends ProviderConnectionKind = ProviderConnectionKind> = {
  providerId: CloudProviderId
  kind: TKind
  sessionId: string
  label: string
  profileId: string
  locationId: string
}

export type AwsProfile = ProviderProfileRecord<'config' | 'credentials'> & {
  name: string
  region: string
}

export type AwsRegionOption = ProviderLocationOption<'region'>

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

export type AwsBaseConnection = ProviderScopedConnection<'profile'> & {
  profile: string
  region: string
}

export type AwsAssumedRoleConnection = ProviderScopedConnection<'assumed-role'> & {
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

export type CloudProviderId = 'aws' | 'gcp' | 'azure'

export type ProviderAvailability = 'available' | 'planned'

export type ProviderWorkspaceKind = 'shared' | 'provider'

export type ProviderConnectionKind =
  | 'profile'
  | 'assumed-role'
  | 'application-default'
  | 'service-account'
  | 'subscription'
  | 'tenant'

export type ProviderLocationKind =
  | 'global'
  | 'region'
  | 'zone'
  | 'project'
  | 'subscription'
  | 'tenant'

export type ProviderDescriptor = {
  id: CloudProviderId
  label: string
  shortLabel: string
  availability: ProviderAvailability
  profileLabel: string
  locationLabel: string
  connectionLabel: string
}

export type ProviderProfileDescriptor = {
  providerId: CloudProviderId
  id: string
  label: string
  source: string
  defaultLocationId: string
  state: ProviderProfileState
}

export type ProviderLocationDescriptor = {
  providerId: CloudProviderId
  id: string
  label: string
  kind: ProviderLocationKind
  parentId?: string
}

export type ProviderConnectionDescriptor = {
  providerId: CloudProviderId
  kind: ProviderConnectionKind
  sessionId: string
  label: string
  profileId: string
  profileLabel: string
  sourceProfileId?: string
  locationId: string
  locationLabel: string
  accountId?: string
}

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

export type ComparisonContextInput =
  | {
      kind: 'profile'
      profile: string
      region: string
      label?: string
    }
  | {
      kind: 'assumed-role'
      sessionId: string
      region: string
      label?: string
    }

export type ComparisonContextDescriptor = {
  kind: ComparisonContextInput['kind']
  sessionId: string
  label: string
  profile: string
  sourceProfile: string
  region: string
  accountId: string
  roleArn: string
  arn: string
}

export type ComparisonRequest = {
  left: ComparisonContextInput
  right: ComparisonContextInput
}

export type ComparisonLayer = 'summary' | 'inventory' | 'posture' | 'tags' | 'cost'

export type ComparisonDiffStatus = 'left-only' | 'right-only' | 'different' | 'same'

export type ComparisonRiskLevel = 'none' | 'low' | 'medium' | 'high'

export type ComparisonFocusMode =
  | 'all'
  | 'security'
  | 'compute'
  | 'networking'
  | 'storage'
  | 'drift-compliance'
  | 'cost'

export type ComparisonCoverageStatus = 'full' | 'partial'

export type ComparisonCoverageItem = {
  id: string
  label: string
  layer: ComparisonLayer
  status: ComparisonCoverageStatus
  detail: string
}

export type ComparisonMetricSide = {
  value: string
  secondary: string
}

export type ComparisonDetailField = {
  key: string
  label: string
  status: ComparisonDiffStatus | 'n/a'
  leftValue: string
  rightValue: string
}

export type ComparisonNavigationTarget = {
  serviceId: ServiceId
  region: string
  resourceLabel: string
}

export type ComparisonDiffRow = {
  id: string
  layer: ComparisonLayer
  section: string
  title: string
  subtitle: string
  status: ComparisonDiffStatus
  risk: ComparisonRiskLevel
  serviceId: ServiceId
  resourceType: string
  identityKey: string
  focusModes: ComparisonFocusMode[]
  rationale: string
  left: ComparisonMetricSide
  right: ComparisonMetricSide
  detailFields: ComparisonDetailField[]
  navigation?: ComparisonNavigationTarget
}

export type ComparisonDiffGroup = {
  id: string
  label: string
  layer: ComparisonLayer
  focusModes: ComparisonFocusMode[]
  coverage: ComparisonCoverageStatus
  counts: Record<ComparisonDiffStatus, number>
  rows: ComparisonDiffRow[]
}

export type ComparisonKeyDifferenceItem = {
  id: string
  title: string
  layer: ComparisonLayer
  risk: ComparisonRiskLevel
  serviceId: ServiceId
  status: ComparisonDiffStatus
  summary: string
}

export type ComparisonSummary = {
  counts: Record<ComparisonDiffStatus, number>
  totals: Array<{
    id: string
    label: string
    leftValue: string
    rightValue: string
    status: ComparisonDiffStatus
  }>
}

export type ComparisonResult = {
  generatedAt: string
  leftContext: ComparisonContextDescriptor
  rightContext: ComparisonContextDescriptor
  coverage: ComparisonCoverageItem[]
  summary: ComparisonSummary
  keyDifferences: ComparisonKeyDifferenceItem[]
  groups: ComparisonDiffGroup[]
}

export type ComparisonBaselineSummary = {
  id: string
  name: string
  description: string
  generatedAt: string
  createdAt: string
  updatedAt: string
  leftLabel: string
  rightLabel: string
}

export type ComparisonBaseline = ComparisonBaselineSummary & {
  request: ComparisonRequest
  result: ComparisonResult
}

export type ComparisonBaselineInput = {
  id?: string
  name: string
  description: string
  request: ComparisonRequest
  result: ComparisonResult
}

export type AssumeRoleRequest = {
  label: string
  roleArn: string
  sessionName: string
  externalId?: string
  sourceProfile?: string
  region?: string
}

export type CallerIdentity = ProviderIdentity & {
  account: string
  arn: string
  userId: string
}

export type AppReleaseChannel = 'stable' | 'preview' | 'unknown'

export type AppReleaseCheckStatus = 'idle' | 'checking' | 'ready' | 'error'

export type AppReleaseMechanism = 'github-release-check' | 'electron-updater'

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type AppReleaseBuildInfo = {
  version: string
  buildHash: string | null
  channel: AppReleaseChannel
}

export type AppReleaseArtifactInfo = {
  version: string | null
  name: string | null
  notes: string | null
  publishedAt: string | null
  url: string
}

export type AppReleaseInfo = {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string
  checkedAt: string | null
  error: string | null
  checkStatus: AppReleaseCheckStatus
  updateMechanism: AppReleaseMechanism
  updateStatus: AppUpdateStatus
  supportsAutoUpdate: boolean
  canCheckForUpdates: boolean
  canDownloadUpdate: boolean
  canInstallUpdate: boolean
  downloadProgressPercent: number | null
  selectedChannel: AppReleaseChannel
  autoDownloadEnabled: boolean
  currentBuild: AppReleaseBuildInfo
  latestRelease: AppReleaseArtifactInfo
}

export type AppSettingsLaunchScreen =
  | 'profiles'
  | 'settings'
  | 'overview'
  | 'session-hub'
  | 'terraform'

export type AppSettingsTerminalShellPreference =
  | ''
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'bash'
  | 'zsh'

export type AppSettingsRefreshMode = 'manual' | 'automatic'

export type AppSettingsReleaseChannelPreference = 'system' | 'stable' | 'preview'

export type AppSettingsGeneral = {
  defaultProfileName: string
  defaultRegion: string
  launchScreen: AppSettingsLaunchScreen
}

export type AppSettingsTerminal = {
  autoOpen: boolean
  defaultCommand: string
  fontSize: number
  shellPreference: AppSettingsTerminalShellPreference
}

export type AppSettingsRefresh = {
  autoRefreshIntervalSeconds: number
  heavyScreenMode: AppSettingsRefreshMode
}

export type AppSettingsToolchain = {
  preferredTerraformCliKind: TerraformCliKind | ''
  terraformPathOverride: string
  opentofuPathOverride: string
  awsCliPathOverride: string
  kubectlPathOverride: string
  dockerPathOverride: string
}

export type AppSettingsUpdates = {
  releaseChannel: AppSettingsReleaseChannelPreference
  autoDownload: boolean
}

export type AppSettings = {
  general: AppSettingsGeneral
  terminal: AppSettingsTerminal
  refresh: AppSettingsRefresh
  toolchain: AppSettingsToolchain
  updates: AppSettingsUpdates
}

export type AppSecuritySummary = {
  vaultEntryCounts: {
    all: number
    awsProfiles: number
    sshKeys: number
    pem: number
    accessKeys: number
  }
}

export type EnvironmentToolId =
  | 'aws-cli'
  | 'session-manager-plugin'
  | 'terraform'
  | 'opentofu'
  | 'kubectl'
  | 'docker'

export type EnvironmentToolStatus = 'available' | 'missing' | 'warning'

export type EnvironmentCheckSeverity = 'info' | 'warning' | 'error'

export type EnvironmentToolCheck = {
  id: EnvironmentToolId
  label: string
  status: EnvironmentToolStatus
  found: boolean
  required: boolean
  version: string
  path: string
  detail: string
  remediation: string
}

export type EnvironmentPermissionCheck = {
  id: string
  label: string
  status: 'ok' | 'warning' | 'error'
  detail: string
  remediation: string
}

export type EnvironmentHealthReport = {
  checkedAt: string
  overallSeverity: EnvironmentCheckSeverity
  summary: string
  tools: EnvironmentToolCheck[]
  permissions: EnvironmentPermissionCheck[]
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
  tags?: Record<string, string>
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

export type Ec2BulkInstanceAction = Ec2InstanceAction | 'terminate'

export type Ec2BulkInstanceActionItemResult = {
  instanceId: string
  name: string
  action: Ec2BulkInstanceAction
  status: 'success' | 'failed'
  detail: string
}

export type Ec2BulkInstanceActionResult = {
  action: Ec2BulkInstanceAction
  attempted: number
  succeeded: number
  failed: number
  results: Ec2BulkInstanceActionItemResult[]
}

export type Ec2SshKeySuggestion = {
  privateKeyPath: string
  publicKeyPath: string
  label: string
  source: 'matched-key-name' | 'discovered'
  keyNameMatch: boolean
  hasPublicKey: boolean
}

export type Ec2ChosenSshKey = {
  stagedPath: string
  originalPath: string
  vaultEntryId: string
  vaultEntryName: string
}

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

export type EbsVolumeAttachRequest = {
  instanceId: string
  device: string
}

export type EbsVolumeDetachRequest = {
  instanceId?: string
  device?: string
  force?: boolean
}

export type EbsVolumeModifyRequest = {
  sizeGiB?: number
  type?: string
  iops?: number
  throughput?: number
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
  tags?: Record<string, string>
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
  tags?: Record<string, string>
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
  healthIssues: string[]
}

export type EksNodegroupSummary = {
  name: string
  status: string
  version: string
  min: number | string
  desired: number | string
  max: number | string
  instanceTypes: string
  releaseVersion: string
  capacityType: string
  amiType: string
}

export type EksUpdateEvent = {
  id: string
  type: string
  status: string
  createdAt: string
  params: Array<{ type: string; value: string }>
  errors: string[]
}

export type EksUpgradeSupportStatus = 'ready' | 'warning' | 'blocked' | 'unknown'

export type EksVersionSkewStatus = 'aligned' | 'supported-skew' | 'unsupported-skew' | 'unknown'

export type EksAddonCompatibility = {
  addonName: string
  currentVersion: string
  targetVersion: string
  status: EksUpgradeSupportStatus
  detail: string
}

export type EksNodegroupUpgradeReadiness = {
  nodegroupName: string
  currentVersion: string
  targetVersion: string
  status: EksUpgradeSupportStatus
  detail: string
  recommendedAction: string
}

export type EksMaintenanceChecklistItem = {
  id: string
  title: string
  status: 'todo' | 'warning' | 'ready'
  detail: string
}

export type EksCommandHandoff = {
  id: string
  label: string
  shell: 'aws-cli' | 'kubectl' | 'shell'
  description: string
  command: string
}

export type EksUpgradePlannerRequest = {
  clusterName: string
  targetVersion?: string
}

export type EksUpgradePlan = {
  generatedAt: string
  clusterName: string
  connectionLabel: string
  profile: string
  region: string
  currentClusterVersion: string
  suggestedTargetVersion: string
  supportStatus: EksUpgradeSupportStatus
  versionSkewStatus: EksVersionSkewStatus
  summary: string
  warnings: string[]
  rollbackNotes: string[]
  recentUpdates: EksUpdateEvent[]
  nodegroups: EksNodegroupUpgradeReadiness[]
  addonCompatibilities: EksAddonCompatibility[]
  maintenanceChecklist: EksMaintenanceChecklistItem[]
  commandHandoffs: EksCommandHandoff[]
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
  | 'compare'
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

export type GovernanceTagKey = 'Owner' | 'Environment' | 'Project' | 'CostCenter'

export type GovernanceTagDefaults = {
  inheritByDefault: boolean
  values: Record<GovernanceTagKey, string>
  updatedAt: string
}

export type GovernanceTagDefaultsUpdate = {
  inheritByDefault?: boolean
  values?: Partial<Record<GovernanceTagKey, string>>
}

export type CloudWatchQueryFilter = {
  profile?: string
  region?: string
  serviceHint?: ServiceId | ''
  logGroupName?: string
  limit?: number
}

export type CloudWatchSavedQuery = {
  id: string
  name: string
  description: string
  queryString: string
  logGroupNames: string[]
  profile: string
  region: string
  serviceHint: ServiceId | ''
  createdAt: string
  updatedAt: string
  lastRunAt: string
}

export type CloudWatchSavedQueryInput = Omit<CloudWatchSavedQuery, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt'> & {
  id?: string
}

export type CloudWatchQueryHistoryStatus = 'success' | 'failed'

export type CloudWatchQueryHistoryEntry = {
  id: string
  queryString: string
  logGroupNames: string[]
  profile: string
  region: string
  serviceHint: ServiceId | ''
  savedQueryId: string
  status: CloudWatchQueryHistoryStatus
  durationMs: number
  resultSummary: string
  executedAt: string
}

export type CloudWatchQueryHistoryInput = Omit<CloudWatchQueryHistoryEntry, 'id' | 'executedAt'>

export type CloudWatchQueryExecutionInput = {
  queryString: string
  logGroupNames: string[]
  startTimeMs: number
  endTimeMs: number
  limit?: number
}

export type CloudWatchQueryExecutionRow = Record<string, string>

export type CloudWatchQueryExecutionStatistics = {
  recordsMatched: number
  recordsScanned: number
  bytesScanned: number
}

export type CloudWatchQueryExecutionResult = {
  queryId: string
  status: string
  queryString: string
  logGroupNames: string[]
  fields: string[]
  rows: CloudWatchQueryExecutionRow[]
  statistics: CloudWatchQueryExecutionStatistics
  limit: number
  startedAt: string
  completedAt: string
}

export type DbConnectionEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'sqlserver'
  | 'oracle'
  | 'aurora-postgresql'
  | 'aurora-mysql'
  | 'unknown'

export type DbConnectionResourceKind =
  | 'rds-instance'
  | 'rds-cluster'
  | 'aurora-cluster'
  | 'manual'

export type DbConnectionCredentialSourceKind = 'local-vault' | 'aws-secrets-manager' | 'manual'

export type VaultEntryKind =
  | 'aws-profile'
  | 'ssh-key'
  | 'pem'
  | 'access-key'
  | 'generic'
  | 'db-credential'
  | 'connection-secret'

export type VaultOrigin =
  | 'manual'
  | 'imported-file'
  | 'aws-secrets-manager'
  | 'aws-iam'
  | 'generated'
  | 'unknown'

export type VaultRotationState = 'unknown' | 'not-applicable' | 'tracked' | 'rotation-due' | 'rotated'

export type VaultEntryUsage = {
  usedAt: string
  source: string
  profile: string
  region: string
  resourceId: string
  resourceLabel: string
}

export type VaultEntrySummary = {
  id: string
  kind: VaultEntryKind
  name: string
  metadata: Record<string, string>
  createdAt: string
  updatedAt: string
  origin: VaultOrigin
  rotationState: VaultRotationState
  rotationUpdatedAt: string
  lastUsedAt: string
  lastUsedContext: VaultEntryUsage | null
}

export type VaultEntryFilter = {
  kind?: VaultEntryKind
  search?: string
}

export type VaultEntryInput = {
  id?: string
  kind: VaultEntryKind
  name: string
  secret: string
  metadata?: Record<string, string>
  origin?: VaultOrigin
  rotationState?: VaultRotationState
  rotationUpdatedAt?: string
}

export type VaultEntryUsageInput = {
  id: string
  usedAt?: string
  source: string
  profile?: string
  region?: string
  resourceId?: string
  resourceLabel?: string
}

export type VaultImportSelection = {
  filePath: string
  fileName: string
  content: string
  suggestedKind: VaultEntryKind
}

export type DbVaultCredentialSummary = {
  name: string
  engine: DbConnectionEngine
  usernameHint: string
  notes: string
  createdAt: string
  updatedAt: string
}

export type DbVaultCredentialInput = {
  name: string
  engine: DbConnectionEngine
  usernameHint: string
  password: string
  notes: string
}

export type DbConnectionPresetFilter = {
  profile?: string
  region?: string
  resourceId?: string
  engine?: DbConnectionEngine
}

export type DbConnectionPreset = {
  id: string
  name: string
  profile: string
  region: string
  resourceKind: DbConnectionResourceKind
  resourceId: string
  engine: DbConnectionEngine
  host: string
  port: number
  databaseName: string
  username: string
  credentialSourceKind: DbConnectionCredentialSourceKind
  credentialSourceRef: string
  notes: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string
}

export type DbConnectionPresetInput = Omit<DbConnectionPreset, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'> & {
  id?: string
}

export type DbConnectionResolveInput = {
  presetId?: string
  resourceKind: DbConnectionResourceKind
  resourceId: string
  resourceLabel: string
  engine: DbConnectionEngine
  host: string
  port: number
  databaseName: string
  username: string
  credentialSourceKind: DbConnectionCredentialSourceKind
  credentialSourceRef: string
  manualPassword: string
}

export type DbConnectionHelperSnippet = {
  id: 'terminal-command' | 'cli-command' | 'masked-uri' | 'connection-uri'
  label: string
  value: string
  sensitive: boolean
}

export type DbConnectionResolutionResult = {
  presetId: string
  displayName: string
  resourceKind: DbConnectionResourceKind
  resourceId: string
  engine: DbConnectionEngine
  host: string
  port: number
  databaseName: string
  username: string
  password: string
  credentialSourceKind: DbConnectionCredentialSourceKind
  credentialSourceRef: string
  sourceSummary: string
  warnings: string[]
  snippets: DbConnectionHelperSnippet[]
  terminalCommand: string
  cliCommand: string
  maskedConnectionUri: string
  connectionUri: string
  resolvedAt: string
}

export type AwsCapabilitySubject =
  | ServiceId
  | 'billing'
  | 'organizations'
  | 'route53-domains'
  | 'local-zones'

export type AwsCapabilityAvailability = 'supported' | 'limited' | 'unsupported'

export type AwsCapabilityHintSeverity = 'info' | 'warning' | 'error'

export type AwsCapabilityHint = {
  id: string
  subject: AwsCapabilitySubject
  region: string
  availability: AwsCapabilityAvailability
  severity: AwsCapabilityHintSeverity
  title: string
  summary: string
  recommendedAction: string
}

export type AwsCapabilitySnapshot = {
  region: string
  generatedAt: string
  hints: AwsCapabilityHint[]
}

export type ServiceMaturity = 'production-ready' | 'beta' | 'experimental'

export type ServiceDescriptor = {
  id: ServiceId
  label: string
  category: string
  migrated: boolean
  maturity: ServiceMaturity
  providerId: CloudProviderId | 'shared'
  providerLabel: string
  workspaceKind: ProviderWorkspaceKind
  supports: CloudProviderId[]
  requiresConnection: boolean
}

export type WorkspaceCatalogSection = {
  id: string
  label: string
  providerId: CloudProviderId | 'shared'
  workspaceKind: ProviderWorkspaceKind
  items: ServiceDescriptor[]
}

export type WorkspaceCatalog = {
  providerId: CloudProviderId
  sharedWorkspaces: WorkspaceCatalogSection[]
  providerWorkspaces: WorkspaceCatalogSection[]
  allServices: ServiceDescriptor[]
}

export type EnterpriseAccessMode = 'read-only' | 'operator'

export type EnterpriseSettings = {
  accessMode: EnterpriseAccessMode
  updatedAt: string
}

export type EnterpriseAuditOutcome = 'success' | 'blocked' | 'failed'

export type EnterpriseAuditEvent = {
  id: string
  happenedAt: string
  accessMode: EnterpriseAccessMode
  outcome: EnterpriseAuditOutcome
  action: string
  channel: string
  summary: string
  actorLabel: string
  accountId: string
  region: string
  serviceId: ServiceId | ''
  resourceId: string
  details: string[]
}

export type EnterpriseAuditExportResult = {
  path: string
  eventCount: number
  rangeDays?: 1 | 7
}

export type AppDiagnosticsExportResult = {
  path: string
  bundleEntries: number
  generatedAt: string
}

/* ── Navigation Focus ────────────────────────────────────── */

export type NavigationFocus = (
  | { service: 'route53'; record: Route53RecordChange }
  | { service: 'load-balancers'; loadBalancerArn: string }
  | { service: 'lambda'; functionName: string }
  | { service: 'ecs'; clusterArn: string; serviceName: string }
  | { service: 'eks'; clusterName: string }
  | { service: 'ec2'; instanceId?: string; volumeId?: string; tab?: 'instances' | 'volumes' | 'snapshots' }
  | {
      service: 'cloudwatch'
      ec2InstanceId?: string
      logGroupNames?: string[]
      queryString?: string
      sourceLabel?: string
      serviceHint?: ServiceId | ''
    }
    | { service: 'vpc'; vpcId: string }
    | { service: 'security-groups'; securityGroupId: string }
    | { service: 'waf'; webAclName: string }
  ) & {
    providerId?: CloudProviderId
    locationId?: string
  }

export type DirectAccessServiceTarget =
  | 's3'
  | 'lambda'
  | 'rds-instance'
  | 'rds-cluster'
  | 'ecr'
  | 'ecs'
  | 'eks'
  | 'cloudformation'
  | 'route53'
  | 'secrets-manager'
  | 'sns'
  | 'sqs'
  | 'kms'
  | 'waf'
  | 'acm'
  | 'ec2'
  | 'security-group'
  | 'load-balancer'
  | 'iam-role'
  | 'iam-user'
  | 'iam-policy'
  | 'cloudwatch-log-group'

export type DirectAccessIdentifierMatch = {
  target: DirectAccessServiceTarget
  confidence: 'high' | 'medium'
  reason: string
  values: Record<string, string>
}

export type DirectAccessPlaybookStep = {
  id: string
  title: string
  detail: string
  kind: 'lookup' | 'permission' | 'navigate' | 'command'
}

export type DirectAccessPlaybook = {
  id: string
  target: DirectAccessServiceTarget
  title: string
  description: string
  supportLevel: 'supported' | 'partial' | 'planned'
  requiredFields: string[]
  suggestedFocus: NavigationFocus | null
  steps: DirectAccessPlaybookStep[]
}

export type DirectAccessResolution = {
  input: string
  matches: DirectAccessIdentifierMatch[]
  playbooks: DirectAccessPlaybook[]
}

export type TokenizedFocus<S extends NavigationFocus['service'] = NavigationFocus['service']> =
  Extract<NavigationFocus, { service: S }> & { token: number }

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

export type Route53HostedZoneCreateInput = {
  domainName: string
  comment: string
  privateZone: boolean
  vpcId: string
  vpcRegion: string
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

export type BillingLinkedAccountSummary = {
  accountId: string
  amount: number
  sharePercent: number
}

export type BillingOwnershipValueSummary = {
  value: string
  amount: number
  sharePercent: number
}

export type BillingTagOwnershipHint = {
  key: GovernanceTagKey
  coveragePercent: number
  taggedAmount: number
  untaggedAmount: number
  topValues: BillingOwnershipValueSummary[]
}

export type OverviewAccountContext = {
  caller: CallerIdentity
  billingHomeRegion: string
  payerVisibility: 'payer-or-management' | 'member-or-standalone' | 'unavailable'
  linkedAccounts: BillingLinkedAccountSummary[]
  ownershipHints: BillingTagOwnershipHint[]
  capabilitySnapshot: AwsCapabilitySnapshot
  notes: string[]
  generatedAt: string
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
  tags?: Record<string, string>
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
  tags?: Record<string, string>
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
  tags?: Record<string, string>
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
  tags?: Record<string, string>
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
  managesMasterUserPassword: boolean
  masterUserSecretArn: string
  masterUserSecretKmsKeyId: string
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
  managesMasterUserPassword: boolean
  masterUserSecretArn: string
  masterUserSecretKmsKeyId: string
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

export type PrerequisiteLevel = 'none' | 'optional' | 'required'

export type SetupEffort = 'none' | 'low' | 'medium' | 'high'

export type ObservabilityLabScope =
  | {
      kind: 'eks'
      connection: Pick<AwsConnection, 'kind' | 'label' | 'profile' | 'region' | 'sessionId'>
      clusterName: string
    }
  | {
      kind: 'ecs'
      connection: Pick<AwsConnection, 'kind' | 'label' | 'profile' | 'region' | 'sessionId'>
      clusterArn: string
      serviceName: string
    }
  | {
      kind: 'terraform'
      connection: Pick<AwsConnection, 'kind' | 'label' | 'profile' | 'region' | 'sessionId'>
      projectId: string
      projectName: string
      rootPath: string
    }

export type ObservabilityFindingCategory =
  | 'logs'
  | 'metrics'
  | 'traces'
  | 'deployment'
  | 'chaos'
  | 'rollback'

export type ObservabilityFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type GeneratedArtifactType =
  | 'yaml'
  | 'shell-command'
  | 'terraform-snippet'
  | 'json-template'
  | 'otel-collector-config'
  | 'kubectl-patch'

export type GeneratedArtifact = {
  id: string
  title: string
  type: GeneratedArtifactType
  language: 'yaml' | 'bash' | 'hcl' | 'json' | 'text'
  summary: string
  content: string
  copyLabel: string
  runLabel: string
  isRunnable: boolean
  safety: string
}

export type RollbackNote = {
  summary: string
  steps: string[]
}

export type ObservabilityRecommendationType =
  | 'command'
  | 'yaml'
  | 'terraform'
  | 'json'
  | 'manual-check'

export type ObservabilityRecommendation = {
  id: string
  title: string
  type: ObservabilityRecommendationType
  summary: string
  rationale: string
  expectedBenefit: string
  risk: string
  rollback: string
  prerequisiteLevel: PrerequisiteLevel
  setupEffort: SetupEffort
  labels: string[]
  artifact?: GeneratedArtifact
}

export type ObservabilityFinding = {
  id: string
  title: string
  severity: ObservabilityFindingSeverity
  category: ObservabilityFindingCategory
  summary: string
  detail: string
  evidence: string[]
  impact: string
  inference: boolean
  recommendedActionIds: string[]
}

export type ResilienceExperimentSuggestion = {
  id: string
  title: string
  summary: string
  hypothesis: string
  blastRadius: string
  prerequisites: string[]
  rollback: string
  setupEffort: SetupEffort
  prerequisiteLevel: PrerequisiteLevel
  artifact?: GeneratedArtifact
}

export type ObservabilityPostureArea = {
  id: string
  label: string
  value: string
  tone: 'good' | 'mixed' | 'weak'
  detail: string
}

export type CorrelatedSignalReference = {
  id: string
  title: string
  detail: string
  serviceId: ServiceId
  targetView: 'overview' | 'timeline' | 'logs' | 'drift' | 'tasks' | 'services'
}

export type ObservabilityPostureReport = {
  generatedAt: string
  scope: ObservabilityLabScope
  summary: ObservabilityPostureArea[]
  findings: ObservabilityFinding[]
  recommendations: ObservabilityRecommendation[]
  experiments: ResilienceExperimentSuggestion[]
  artifacts: GeneratedArtifact[]
  safetyNotes: Array<{
    title: string
    blastRadius: string
    prerequisites: string[]
    rollback: string
  }>
  correlatedSignals: CorrelatedSignalReference[]
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
  | 'import'
  | 'state-mv'
  | 'state-rm'
  | 'force-unlock'
  | 'state-list'
  | 'state-show'
  | 'state-pull'
  | 'version'

export type TerraformCliKind = 'terraform' | 'opentofu'

export type TerraformCliOption = {
  kind: TerraformCliKind
  label: string
  path: string
  version: string
}

export type TerraformCliInfo = {
  found: boolean
  kind: TerraformCliKind | ''
  label: string
  path: string
  version: string
  error: string
  available: TerraformCliOption[]
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
  backend: TerraformBackendDetails
  git: TerraformProjectGitMetadata | null
  providerNames: string[]
  resourceCount: number
  moduleCount: number
  variableCount: number
  outputsCount: number
  tfFileCount: number
  lastScannedAt: string
  s3Backend: TerraformS3BackendConfig | null
}

export type TerraformBackendDetails =
  | TerraformLocalBackendDetails
  | TerraformS3BackendDetails
  | TerraformGenericBackendDetails

export type TerraformLocalBackendDetails = {
  type: 'local'
  label: string
  stateLocation: string
}

export type TerraformS3BackendConfig = {
  bucket: string
  key: string
  region: string
  workspaceKeyPrefix: string
}

export type TerraformS3BackendDetails = TerraformS3BackendConfig & {
  type: 's3'
  label: string
  effectiveStateKey: string
}

export type TerraformGenericBackendDetails = {
  type: string
  label: string
  summary: string
}

export type TerraformGitStatus = 'ready' | 'not-repo' | 'git-missing' | 'error'

export type TerraformGitChangedFile = {
  path: string
  status: string
}

export type TerraformGitCommitMetadata = {
  repoRoot: string
  branch: string
  commitSha: string
  shortCommitSha: string
  isDetached: boolean
  isDirty: boolean
}

export type TerraformProjectGitMetadata = TerraformGitCommitMetadata & {
  status: TerraformGitStatus
  projectRelativePath: string
  changedTerraformFiles: TerraformGitChangedFile[]
  error: string
}

export type TerraformSavedPlanMetadata = {
  request: TerraformPlanOptionsSummary
  generatedAt: string
  git: TerraformGitCommitMetadata | null
}

export type TerraformWorkspaceSummary = {
  name: string
  isCurrent: boolean
}

export type TerraformStateBackupSummary = {
  path: string
  createdAt: string
  sizeBytes: number
  source: string
}

export type TerraformStateLockInfo = {
  supported: boolean
  backendType: string
  lockId: string
  operation: string
  who: string
  version: string
  created: string
  path: string
  infoPath: string
  message: string
  canUnlock: boolean
}

export type TerraformProjectEnvironmentMetadata = {
  environmentLabel: string
  workspaceName: string
  region: string
  connectionLabel: string
  backendType: string
  varSetLabel: string
}

export type TerraformSecretSource = 'ssm-parameter' | 'secrets-manager'

export type TerraformSecretReference = {
  source: TerraformSecretSource
  target: string
  versionId: string
  jsonKey: string
  label: string
}

export type TerraformVariableLayer = {
  varFile: string
  variables: Record<string, unknown>
  secretRefs: Record<string, TerraformSecretReference>
}

export type TerraformVariableSet = {
  id: string
  name: string
  description: string
  base: TerraformVariableLayer
  overlays: Record<string, TerraformVariableLayer>
  createdAt: string
  updatedAt: string
}

export type TerraformInputConfiguration = {
  selectedVariableSetId: string
  selectedOverlay: string
  variableSets: TerraformVariableSet[]
  migratedFromLegacy: boolean
}

export type TerraformRuntimeInputSource =
  | 'var-file'
  | 'variable-set'
  | 'environment-overlay'
  | 'runtime-secret'
  | 'default'
  | 'unset'

export type TerraformRuntimeInputStatus = 'ready' | 'missing' | 'unresolved-secret'

export type TerraformUnresolvedSecret = {
  name: string
  reason: string
}

export type TerraformResolvedRuntimeInputs = {
  values: Record<string, unknown>
  sources: Record<string, TerraformRuntimeInputSource>
  secretNames: string[]
  missingRequired: string[]
  unresolvedSecrets: TerraformUnresolvedSecret[]
}

export type TerraformInputValidationResult = {
  valid: boolean
  missing: string[]
  unresolvedSecrets: TerraformUnresolvedSecret[]
}

export type TerraformProjectInputRow = {
  name: string
  description: string
  required: boolean
  hasDefault: boolean
  effectiveSource: TerraformRuntimeInputSource
  effectiveSourceLabel: string
  effectiveValueSummary: string
  localValueSummary: string
  overlayValueSummary: string
  inheritedFrom: string
  secretRef: TerraformSecretReference | null
  secretSourceLabel: string
  status: TerraformRuntimeInputStatus
  isSecret: boolean
  isSensitive: boolean
  isMissing: boolean
}

export type TerraformProjectInputsView = {
  selectedVariableSetId: string
  selectedVariableSetName: string
  selectedOverlay: string
  availableOverlays: string[]
  rows: TerraformProjectInputRow[]
  missingRequired: string[]
  unresolvedSecrets: TerraformUnresolvedSecret[]
  migratedFromLegacy: boolean
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

export type TerraformPlanAction = 'create' | 'update' | 'delete' | 'replace' | 'no-op'

export type TerraformPlanGroupKind = 'module' | 'action' | 'resource-type'

export type TerraformPlanCounts = {
  create: number
  update: number
  delete: number
  replace: number
  noop: number
}

export type TerraformPlanExecutionMode = 'standard' | 'refresh-only' | 'targeted' | 'replace'

export type TerraformPlanOptions = {
  mode?: TerraformPlanExecutionMode
  targets?: string[]
  replaceAddresses?: string[]
}

export type TerraformPlanOptionsSummary = {
  mode: TerraformPlanExecutionMode
  targets: string[]
  replaceAddresses: string[]
}

export type TerraformPlanAttributeChange = {
  path: string
  changeType: 'add' | 'remove' | 'update' | 'unknown' | 'replace'
  before: string
  after: string
  requiresReplacement: boolean
  sensitive: boolean
  heuristic: boolean
}

export type TerraformPlanChange = {
  address: string
  type: string
  name: string
  modulePath: string
  provider: string
  providerDisplayName: string
  service: string
  actions: string[]
  actionLabel: TerraformPlanAction
  mode: 'managed' | 'data'
  actionReason: string
  replacePaths: string[]
  changedAttributes: TerraformPlanAttributeChange[]
  beforeIdentity: string
  afterIdentity: string
  isDestructive: boolean
  isReplacement: boolean
}

export type TerraformPlanGroup = {
  key: string
  label: string
  kind: TerraformPlanGroupKind
  count: number
  summary: TerraformPlanCounts
  resources: string[]
}

export type TerraformPlanSummary = TerraformPlanCounts & {
  hasChanges: boolean
  affectedResources: number
  affectedModules: string[]
  affectedProviders: string[]
  affectedServices: string[]
  groups: {
    byModule: TerraformPlanGroup[]
    byAction: TerraformPlanGroup[]
    byResourceType: TerraformPlanGroup[]
  }
  jsonFieldsUsed: string[]
  heuristicNotes: string[]
  hasDestructiveChanges: boolean
  hasReplacementChanges: boolean
  isDeleteHeavy: boolean
  request: TerraformPlanOptionsSummary
}

export type TerraformActionRow = {
  order: number
  action: TerraformPlanAction
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

export type TerraformRunRecord = {
  id: string
  projectId: string
  projectName: string
  command: TerraformCommandName
  args: string[]
  workspace: string
  region: string
  connectionLabel: string
  backendType: string
  stateSource: string
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  success: boolean | null
  planSummary: TerraformPlanSummary | null
  planJsonPath: string
  backupPath: string
  backupCreatedAt: string
  stateOperationSummary: string
  git: TerraformGitCommitMetadata | null
}

export type TerraformRunHistoryFilter = {
  projectId?: string
  command?: TerraformCommandName
  success?: boolean
}

/* ── Governance & Safety Checks ────────────────────────────── */

export type TerraformGovernanceToolId = 'fmt' | 'validate' | 'tflint' | 'tfsec' | 'checkov'

export type TerraformGovernanceToolInfo = {
  id: TerraformGovernanceToolId
  label: string
  available: boolean
  path: string
  version: string
  required: boolean
}

export type TerraformGovernanceCheckStatus = 'passed' | 'failed' | 'skipped' | 'error'

export type TerraformGovernanceCheckResult = {
  toolId: TerraformGovernanceToolId
  label: string
  status: TerraformGovernanceCheckStatus
  blocking: boolean
  summary: string
  findings: TerraformGovernanceFinding[]
  output: string
  durationMs: number
  ranAt: string
}

export type TerraformGovernanceFinding = {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  ruleId: string
  message: string
  file: string
  line: number
}

export type TerraformGovernanceSeverity = TerraformGovernanceFinding['severity']

export type TerraformGovernanceReport = {
  projectId: string
  checks: TerraformGovernanceCheckResult[]
  ranAt: string
  allBlockingPassed: boolean
}

export type TerraformGovernanceToolkit = {
  tools: TerraformGovernanceToolInfo[]
  detectedAt: string
  cliKind: TerraformCliKind | ''
  cliLabel: string
  cliPath: string
}

export type TerraformProjectStatus = 'Ready' | 'Missing'

export type TerraformDriftStatus =
  | 'in_sync'
  | 'drifted'
  | 'missing_in_aws'
  | 'unmanaged_in_aws'
  | 'unsupported'

export type TerraformDriftAssessment = 'verified' | 'inferred' | 'unsupported'

export type TerraformDriftDifferenceKind = 'attribute' | 'tag' | 'heuristic'

export type TerraformDriftDifference = {
  key: string
  label: string
  kind: TerraformDriftDifferenceKind
  assessment: Exclude<TerraformDriftAssessment, 'unsupported'>
  terraformValue: string
  liveValue: string
}

export type TerraformDriftCoverageLevel = 'verified' | 'partial'

export type TerraformDriftCoverageItem = {
  resourceType: string
  coverage: TerraformDriftCoverageLevel
  verifiedChecks: string[]
  inferredChecks: string[]
  notes: string[]
}

export type TerraformDriftTrend = 'improving' | 'worsening' | 'unchanged' | 'insufficient_history'

export type TerraformDriftSnapshot = {
  id: string
  scannedAt: string
  trigger: 'manual' | 'initial'
  summary: TerraformDriftSummary
  items: TerraformDriftItem[]
}

export type TerraformDriftHistory = {
  snapshots: TerraformDriftSnapshot[]
  trend: TerraformDriftTrend
  latestScanAt: string
  previousScanAt: string
}

export type TerraformDriftItem = {
  terraformAddress: string
  resourceType: string
  logicalName: string
  cloudIdentifier: string
  region: string
  status: TerraformDriftStatus
  assessment: TerraformDriftAssessment
  explanation: string
  suggestedNextStep: string
  consoleUrl: string
  terminalCommand: string
  differences: TerraformDriftDifference[]
  evidence: string[]
  relatedTerraformAddresses: string[]
}

export type TerraformDriftSummary = {
  total: number
  statusCounts: Record<TerraformDriftStatus, number>
  resourceTypeCounts: Array<{ resourceType: string; count: number }>
  scannedAt: string
  verifiedCount: number
  inferredCount: number
  unsupportedResourceTypes: string[]
  supportedResourceTypes: TerraformDriftCoverageItem[]
}

export type TerraformDriftReport = {
  projectId: string
  projectName: string
  profileName: string
  region: string
  summary: TerraformDriftSummary
  items: TerraformDriftItem[]
  history: TerraformDriftHistory
  fromCache: boolean
}

export type TerraformProject = {
  id: string
  name: string
  rootPath: string
  varFile: string
  variables: Record<string, unknown>
  inputConfig: TerraformInputConfiguration
  inputView: TerraformProjectInputsView
  inputValidation: TerraformInputValidationResult
  environment: TerraformProjectEnvironmentMetadata
  status: TerraformProjectStatus
  inputsFilePath: string
  detectedVariables: TerraformVariableDefinition[]
  inputs: Record<string, unknown>
  metadata: TerraformProjectMetadata
  workspaces: TerraformWorkspaceSummary[]
  currentWorkspace: string
  inventory: TerraformResourceInventoryItem[]
  planChanges: TerraformPlanChange[]
  actionRows: TerraformActionRow[]
  resourceRows: TerraformResourceRow[]
  diagram: TerraformDiagram
  lastPlanSummary: TerraformPlanSummary
  lastCommandAt: string
  stateAddresses: string[]
  rawStateJson: string
  stateSource: string
  stateBackups: TerraformStateBackupSummary[]
  latestStateBackup: TerraformStateBackupSummary | null
  stateLockInfo: TerraformStateLockInfo | null
  hasSavedPlan: boolean
  savedPlanMetadata: TerraformSavedPlanMetadata | null
}

export type TerraformCommandRequest = {
  profileName: string
  connection?: AwsConnection
  projectId: string
  command: TerraformCommandName
  stateAddress?: string
  importAddress?: string
  importId?: string
  stateFromAddress?: string
  stateToAddress?: string
  lockId?: string
  planOptions?: TerraformPlanOptions
}

export type TerraformProjectListItem = Pick<
  TerraformProject,
  'id' | 'name' | 'rootPath' | 'status' | 'stateSource' | 'metadata' | 'lastPlanSummary' | 'lastCommandAt' | 'inventory' | 'environment' | 'currentWorkspace'
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
