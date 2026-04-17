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

export type NormalizedActorScopeKind = 'account' | 'project' | 'subscription' | 'tenant'

export type NormalizedActorIdentity = {
  providerId: CloudProviderId
  scopeKind: NormalizedActorScopeKind
  scopeId: string
  principalId: string
  principalArn: string
  displayName: string
}

export type NormalizedResourceIdentity = {
  providerId: CloudProviderId
  serviceId: ServiceId | ''
  resourceType: string
  canonicalType: string
  identityKey: string
  displayName: string
  locationId: string
  scopeId: string
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
  environment: string
  criticalAccessLevel: 'low' | 'medium' | 'high' | 'critical'
  tags: string[]
  lastUsedAt: string
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

export type ProviderCliStatusEntry = {
  installed: boolean
  cliName: string
  version: string
  path: string
}

export type ProviderCliStatus = Record<CloudProviderId, ProviderCliStatusEntry>

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

export type AwsSessionExpiryState = 'healthy' | 'expiring' | 'expired'

export type AwsSessionSummary = {
  id: string
  kind: AwsConnection['kind']
  label: string
  sessionName: string
  profile: string
  region: string
  status: AwsSessionStatus
  expiryState: AwsSessionExpiryState
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
  normalizedIdentity: NormalizedActorIdentity
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
  providerId: CloudProviderId
  serviceId: ServiceId
  region: string
  resourceLabel: string
  identity?: NormalizedResourceIdentity
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
  normalizedIdentity: NormalizedResourceIdentity
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

export type ComparisonPresetSummary = {
  id: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  leftLabel: string
  rightLabel: string
}

export type ComparisonPreset = ComparisonPresetSummary & {
  request: ComparisonRequest
}

export type ComparisonPresetInput = {
  id?: string
  name: string
  description: string
  request: ComparisonRequest
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
  defaultProviderId: CloudProviderId
  defaultProfileName: string
  defaultRegion: string
  gcpDefaultModeId: string
  gcpDefaultProjectId: string
  gcpDefaultLocation: string
  azureDefaultModeId: string
  azureDefaultSubscriptionId: string
  azureDefaultSubscriptionLabel: string
  azureDefaultTenantId: string
  azureDefaultLocation: string
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
  gcloudPathOverride: string
  azureCliPathOverride: string
  kubectlPathOverride: string
  dockerPathOverride: string
}

export type AppSettingsUpdates = {
  releaseChannel: AppSettingsReleaseChannelPreference
  autoDownload: boolean
}

export type AppFeatureFlagId =
  | 'labs.observability'
  | 'service.iam'
  | 'service.identity-center'
  | 'service.kms'
  | 'service.sns'
  | 'service.sqs'
  | 'service.waf'
  | 'service.gcp-iam'
  | 'service.gcp-pubsub'
  | 'service.gcp-scc'
  | 'service.gcp-cloud-dns'
  | 'service.gcp-memorystore'
  | 'service.gcp-firebase'
  | 'service.azure-rbac'
  | 'service.azure-key-vault'
  | 'service.azure-event-hub'
  | 'service.azure-event-grid'
  | 'service.azure-firewall'
  | 'service.azure-dns'

export type AppSettingsFeatures = {
  registry: Partial<Record<AppFeatureFlagId, boolean>>
}

export type AppSettings = {
  general: AppSettingsGeneral
  terminal: AppSettingsTerminal
  refresh: AppSettingsRefresh
  toolchain: AppSettingsToolchain
  updates: AppSettingsUpdates
  features: AppSettingsFeatures
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
  | 'gcloud-cli'
  | 'azure-cli'
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

export type GcpCliConfiguration = {
  name: string
  isActive: boolean
  account: string
  projectId: string
  region: string
  zone: string
}

export type GcpCliProject = {
  projectId: string
  name: string
  projectNumber: string
  lifecycleState: string
}

export type GcpCliContext = {
  detected: boolean
  cliPath: string
  activeConfigurationName: string
  activeAccount: string
  activeProjectId: string
  activeRegion: string
  activeZone: string
  configurations: GcpCliConfiguration[]
  projects: GcpCliProject[]
  locations: string[]
}

export type AzureAuthStatus =
  | 'signed-out'
  | 'starting'
  | 'waiting-for-device-code'
  | 'authenticating'
  | 'authenticated'
  | 'error'

export type AzureContextDiagnosticSeverity = 'info' | 'warning' | 'error'

export type AzureContextDiagnosticCode =
  | 'missing-auth'
  | 'expired-auth'
  | 'missing-subscription'
  | 'insufficient-access'
  | 'provider-registration'
  | 'cli-guidance'
  | 'read-only-mode'

export type AzureTenantSummary = {
  tenantId: string
  displayName: string
  defaultDomain: string
  countryCode: string
  tenantCategory: string
}

export type AzureSubscriptionSummary = {
  id?: string
  subscriptionId: string
  displayName: string
  tenantId: string
  state: string
  authorizationSource: string
  managedByTenants?: string[]
  spendingLimit?: string
  quotaId?: string
  locationCount?: number
  locations?: string[]
  managementGroupHints?: string[]
}

export type AzureResourceGroupSummary = {
  id: string
  name: string
  location: string
  provisioningState: string
  managedBy: string
  tags: Record<string, string>
}

export type AzureResourceGroupResourceSummary = {
  id: string
  name: string
  type: string
  location: string
  resourceGroup: string
  kind: string
  provisioningState: string
  tags: Record<string, string>
}

export type AzureLocationSummary = {
  id: string
  name: string
  regionalDisplayName: string
  pairedRegionIds: string[]
}

export type AzureProviderRegistrationSummary = {
  namespace: string
  registrationState: string
}

export type AzureContextDiagnostic = {
  code: AzureContextDiagnosticCode
  severity: AzureContextDiagnosticSeverity
  title: string
  detail: string
  remediation: string
}

export type AzureDeviceCodePrompt = {
  message: string
  userCode: string
  verificationUri: string
}

export type AzureAuthSessionState = {
  status: AzureAuthStatus
  message: string
  prompt: AzureDeviceCodePrompt | null
  signedInAt: string
  lastError: string
}

export type AzureManagementGroupSummary = {
  id: string
  name: string
  displayName: string
  tenantId: string
  parentId: string
  parentDisplayName: string
  childSubscriptionIds: string[]
  childGroupIds: string[]
}

export type AzureCrossSubscriptionQueryResult = {
  totalRecords: number
  data: Record<string, unknown>[]
}

export type AzureProviderContextSnapshot = {
  loadedAt: string
  auth: AzureAuthSessionState
  cloudName: string
  cliPath: string
  activeTenantId: string
  activeSubscriptionId: string
  activeLocation: string
  activeAccountLabel: string
  tenants: AzureTenantSummary[]
  subscriptions: AzureSubscriptionSummary[]
  locations: AzureLocationSummary[]
  recentSubscriptionIds: string[]
  recentSubscriptions: AzureSubscriptionSummary[]
  favoriteSubscriptionIds: string[]
  managementGroups: AzureManagementGroupSummary[]
  providerRegistrations: AzureProviderRegistrationSummary[]
  diagnostics: AzureContextDiagnostic[]
}

export type AzureRoleAssignmentSummary = {
  id: string
  principalId: string
  principalType: string
  roleName: string
  scope: string
  scopeKind: 'subscription' | 'resourceGroup' | 'resource'
  inherited: boolean
  risky: boolean
  condition: string
}

export type AzureRbacOverview = {
  subscriptionId: string
  assignmentCount: number
  principalCount: number
  roleCount: number
  riskyAssignmentCount: number
  inheritedAssignmentCount: number
  assignments: AzureRoleAssignmentSummary[]
  notes: string[]
}

/* ── Azure Defender for Cloud ────────────────────────────── */

export type AzureDefenderAlertSeverity = 'high' | 'medium' | 'low' | 'informational'

export type AzureDefenderAssessmentStatus = 'healthy' | 'unhealthy' | 'notApplicable'

export type AzureDefenderSecureScore = {
  name: string
  displayName: string
  currentScore: number
  maxScore: number
  percentage: number
  weight: number
}

export type AzureDefenderSecureScoreControl = {
  id: string
  name: string
  displayName: string
  currentScore: number
  maxScore: number
  percentage: number
  healthyResourceCount: number
  unhealthyResourceCount: number
  notApplicableResourceCount: number
  category: string
}

export type AzureDefenderRecommendation = {
  id: string
  name: string
  displayName: string
  description: string
  severity: AzureDefenderAlertSeverity
  status: AzureDefenderAssessmentStatus
  category: string
  resourceId: string
  remediation: string
}

export type AzureDefenderAlert = {
  id: string
  name: string
  alertDisplayName: string
  description: string
  severity: AzureDefenderAlertSeverity
  status: string
  intent: string
  timeGenerated: string
  resourceId: string
  compromisedEntity: string
  vendor: string
}

export type AzureDefenderComplianceStandard = {
  id: string
  name: string
  displayName: string
  state: string
  passedControls: number
  failedControls: number
  skippedControls: number
  unsupportedControls: number
  compliancePercentage: number
}

export type AzureDefenderAttackPath = {
  id: string
  name: string
  displayName: string
  description: string
  riskLevel: AzureDefenderAlertSeverity
  riskCategories: string[]
  entryPoint: string
  targetResourceId: string
  stepCount: number
}

export type AzureDefenderReport = {
  generatedAt: string
  subscriptionId: string
  secureScore: AzureDefenderSecureScore | null
  secureScoreControls: AzureDefenderSecureScoreControl[]
  recommendations: AzureDefenderRecommendation[]
  alerts: AzureDefenderAlert[]
  complianceStandards: AzureDefenderComplianceStandard[]
  attackPaths: AzureDefenderAttackPath[]
  recommendationsByCategory: Record<string, number>
  alertsBySeverity: Record<AzureDefenderAlertSeverity, number>
  warnings: string[]
}

export type AzureRoleDefinitionSummary = {
  id: string
  roleName: string
  description: string
  roleType: 'BuiltInRole' | 'CustomRole'
  actions: string[]
  notActions: string[]
  dataActions: string[]
  notDataActions: string[]
  assignableScopes: string[]
}

export type AzureVirtualMachineSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  vmSize: string
  powerState: string
  provisioningState: string
  osType: string
  identityType: string
  privateIp: string
  publicIp: string
  hasPublicIp: boolean
  subnetName: string
  networkInterfaceCount: number
  diagnosticsState: string
  tagCount: number
}

export type AzureVmAction = 'start' | 'powerOff' | 'restart' | 'deallocate'

export type AzureVmActionResult = {
  action: AzureVmAction
  vmName: string
  resourceGroup: string
  accepted: boolean
  error?: string
}

export type AzureVirtualMachineDetail = {
  id: string
  name: string
  resourceGroup: string
  location: string
  vmSize: string
  powerState: string
  provisioningState: string
  osType: string
  osDiskName: string
  osDiskSizeGiB: number
  osDiskType: string
  dataDisks: Array<{ name: string; sizeGiB: number; lun: number; type: string }>
  identityType: string
  privateIp: string
  publicIp: string
  hasPublicIp: boolean
  subnetName: string
  subnetId: string
  vnetName: string
  networkInterfaceCount: number
  networkSecurityGroup: string
  diagnosticsState: string
  tags: Record<string, string>
  imageReference: string
  computerName: string
  adminUsername: string
  availabilityZone: string
  platform: string
}

export type AzureAksClusterSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  kubernetesVersion: string
  provisioningState: string
  powerState: string
  nodePoolCount: number
  nodeCount: number
  privateCluster: boolean
  identityType: string
  workloadIdentityEnabled: boolean
  oidcIssuerEnabled: boolean
  networkPlugin: string
  ingressProfile: string
  agentPoolNames: string[]
  notes: string[]
}

export type AzureAksClusterDetail = {
  name: string
  resourceGroup: string
  location: string
  kubernetesVersion: string
  provisioningState: string
  powerState: string
  fqdn: string
  privateFqdn: string
  privateCluster: boolean
  identityType: string
  workloadIdentityEnabled: boolean
  oidcIssuerEnabled: boolean
  oidcIssuerUrl: string
  networkPlugin: string
  networkPolicy: string
  serviceCidr: string
  dnsServiceIp: string
  podCidr: string
  loadBalancerSku: string
  outboundType: string
  nodeResourceGroup: string
  dnsPrefix: string
  enableRbac: boolean
  createdAt: string
  nodePoolCount: number
  nodeCount: number
  tags: Record<string, string>
  loggingEnabled: string[]
  healthIssues: string[]
}

export type AzureAksNodePoolSummary = {
  name: string
  status: string
  mode: string
  vmSize: string
  osType: string
  osSku: string
  kubernetesVersion: string
  min: number | string
  desired: number | string
  max: number | string
  enableAutoScaling: boolean
  availabilityZones: string[]
  maxPods: number
  osDiskSizeGb: number
  osDiskType: string
  powerState: string
  nodeLabels: Record<string, string>
  nodeTaints: string[]
}

/* ── Azure Network types ─────────────────────────────────── */

export type AzureVNetSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  addressPrefixes: string[]
  subnetCount: number
  provisioningState: string
  enableDdosProtection: boolean
  dnsServers: string[]
  peeringCount: number
  tagCount: number
}

export type AzureSubnetSummary = {
  id: string
  name: string
  addressPrefix: string
  provisioningState: string
  nsgName: string
  routeTableName: string
  delegations: string[]
  privateEndpointCount: number
  natGatewayName: string
}

export type AzureNsgSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  securityRuleCount: number
  defaultRuleCount: number
  associatedSubnetCount: number
  associatedNicCount: number
  provisioningState: string
}

export type AzureNsgRuleSummary = {
  name: string
  priority: number
  direction: 'Inbound' | 'Outbound'
  access: 'Allow' | 'Deny'
  protocol: string
  sourceAddressPrefix: string
  sourcePortRange: string
  destinationAddressPrefix: string
  destinationPortRange: string
}

export type AzurePublicIpSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  ipAddress: string
  allocationMethod: string
  sku: string
  associatedResourceName: string
  provisioningState: string
  dnsLabel: string
  fqdn: string
}

export type AzureNetworkInterfaceSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  privateIp: string
  publicIp: string
  subnetName: string
  vnetName: string
  nsgName: string
  macAddress: string
  attachedVmName: string
  provisioningState: string
  enableAcceleratedNetworking: boolean
}

export type AzureNetworkOverview = {
  vnets: AzureVNetSummary[]
  nsgs: AzureNsgSummary[]
  publicIps: AzurePublicIpSummary[]
  networkInterfaces: AzureNetworkInterfaceSummary[]
  routeTables: AzureRouteTableSummary[]
  natGateways: AzureNatGatewaySummary[]
  loadBalancers: AzureLoadBalancerSummary[]
  privateEndpoints: AzurePrivateEndpointSummary[]
}

/* ── Azure VMSS types ────────────────────────────────────── */

export type AzureVmssSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  skuCapacity: number
  provisioningState: string
  orchestrationMode: string
  upgradePolicy: string
  platformFaultDomainCount: number
  overprovision: boolean
  singlePlacementGroup: boolean
  identityType: string
  tagCount: number
  zones: string[]
}

export type AzureVmssInstanceSummary = {
  instanceId: string
  name: string
  provisioningState: string
  powerState: string
  latestModelApplied: boolean
  vmSize: string
  protectionFromScaleIn: boolean
  zone: string
}

export type AzureVmssActionResult = {
  action: string
  vmssName: string
  resourceGroup: string
  accepted: boolean
  error?: string
}

/* ── Azure Application Insights types ───────────────────── */

export type AzureAppInsightsSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  instrumentationKey: string
  applicationId: string
  applicationType: string
  kind: string
  ingestionMode: string
  retentionInDays: number
  publicNetworkAccessForIngestion: string
  publicNetworkAccessForQuery: string
  provisioningState: string
  connectionString: string
  workspaceResourceId: string
  tagCount: number
}

/* ── Azure Key Vault types ──────────────────────────────── */

export type AzureKeyVaultSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  vaultUri: string
  skuName: string
  tenantId: string
  enableSoftDelete: boolean
  softDeleteRetentionInDays: number
  enablePurgeProtection: boolean
  enableRbacAuthorization: boolean
  publicNetworkAccess: string
  provisioningState: string
  tagCount: number
}

export type AzureKeyVaultSecretSummary = {
  id: string
  name: string
  enabled: boolean
  contentType: string
  managed: boolean
  created: string
  updated: string
}

export type AzureKeyVaultKeySummary = {
  id: string
  name: string
  enabled: boolean
  keyType: string
  keyOps: string[]
  created: string
  updated: string
}

/* ── Azure Event Hub types ──────────────────────────────── */

export type AzureEventHubNamespaceSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  skuTier: string
  skuCapacity: number
  isAutoInflateEnabled: boolean
  maximumThroughputUnits: number
  kafkaEnabled: boolean
  zoneRedundant: boolean
  publicNetworkAccess: string
  provisioningState: string
  status: string
  serviceBusEndpoint: string
  tagCount: number
}

export type AzureEventHubSummary = {
  id: string
  name: string
  partitionCount: number
  messageRetentionInDays: number
  status: string
  createdAt: string
  updatedAt: string
  partitionIds: string[]
}

export type AzureEventHubConsumerGroupSummary = {
  id: string
  name: string
  userMetadata: string
  createdAt: string
  updatedAt: string
}

/* ── Azure App Service types ────────────────────────────── */

export type AzureAppServicePlanSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  skuTier: string
  skuCapacity: number
  kind: string
  numberOfWorkers: number
  numberOfSites: number
  status: string
  reserved: boolean
  zoneRedundant: boolean
  provisioningState: string
  tagCount: number
}

export type AzureWebAppSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  kind: string
  state: string
  defaultHostName: string
  httpsOnly: boolean
  enabled: boolean
  appServicePlanName: string
  runtimeStack: string
  ftpsState: string
  http20Enabled: boolean
  minTlsVersion: string
  publicNetworkAccess: string
  provisioningState: string
  lastModifiedTimeUtc: string
  tagCount: number
}

export type AzureWebAppSlotSummary = {
  id: string
  name: string
  slotName: string
  state: string
  hostName: string
  enabled: boolean
  httpsOnly: boolean
  lastModifiedTimeUtc: string
}

export type AzureWebAppDeploymentSummary = {
  id: string
  deploymentId: string
  status: number
  message: string
  author: string
  deployer: string
  startTime: string
  endTime: string
  active: boolean
}

export type AzureStorageAccountSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  kind: string
  skuName: string
  accessTier: string
  publicNetworkAccess: string
  defaultNetworkAction: string
  minimumTlsVersion: string
  allowBlobPublicAccess: boolean
  allowSharedKeyAccess: boolean
  httpsOnly: boolean
  versioningEnabled: boolean
  changeFeedEnabled: boolean
  blobDeleteRetentionDays: number
  containerDeleteRetentionDays: number
  primaryBlobEndpoint: string
  primaryFileEndpoint: string
  primaryQueueEndpoint: string
  primaryTableEndpoint: string
  containerCount: number
  tagCount: number
  notes: string[]
}

export type AzureStorageContainerSummary = {
  name: string
  publicAccess: string
  metadataCount: number
  leaseStatus: string
  lastModified: string
  hasImmutabilityPolicy: boolean
  hasLegalHold: boolean
  defaultEncryptionScope: string
  denyEncryptionScopeOverride: boolean
}

export type AzureStorageBlobSummary = {
  key: string
  size: number
  lastModified: string
  contentType: string
  accessTier: string
  isFolder: boolean
}

export type AzureStorageBlobContent = {
  body: string
  contentType: string
}

export type AzureSqlServerSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  version: string
  fullyQualifiedDomainName: string
  publicNetworkAccess: string
  minimalTlsVersion: string
  administratorType: string
  outboundNetworkRestriction: string
  databaseCount: number
  elasticPoolCount: number
  tagCount: number
  notes: string[]
}

export type AzureSqlDatabaseSummary = {
  id: string
  name: string
  serverName: string
  resourceGroup: string
  location: string
  status: string
  skuName: string
  edition: string
  maxSizeGb: number
  zoneRedundant: boolean
  readScale: string
  autoPauseDelayMinutes: number
  backupStorageRedundancy: string
}

export type AzureSqlEstateOverview = {
  subscriptionId: string
  serverCount: number
  databaseCount: number
  publicServerCount: number
  servers: AzureSqlServerSummary[]
  databases: AzureSqlDatabaseSummary[]
  notes: string[]
}

export type AzureSqlOperationalTone = 'good' | 'warning' | 'risk' | 'info' | 'neutral'

export type AzureSqlPostureBadge = {
  id: string
  label: string
  value: string
  tone: AzureSqlOperationalTone
}

export type AzureSqlSummaryTile = {
  id: string
  label: string
  value: string
  tone: AzureSqlOperationalTone
}

export type AzureSqlFinding = {
  id: string
  severity: 'info' | 'warning' | 'risk'
  title: string
  message: string
  recommendation: string
}

export type AzureSqlFirewallRule = {
  name: string
  startIpAddress: string
  endIpAddress: string
}

export type AzureSqlServerDetail = {
  server: AzureSqlServerSummary
  databases: AzureSqlDatabaseSummary[]
  firewallRules: AzureSqlFirewallRule[]
  badges: AzureSqlPostureBadge[]
  summaryTiles: AzureSqlSummaryTile[]
  findings: AzureSqlFinding[]
  recommendations: string[]
  connectionDetails: Array<{ label: string; value: string }>
}

export type AzurePostgreSqlServerSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  version: string
  fullyQualifiedDomainName: string
  publicNetworkAccess: string
  state: string
  skuName: string
  skuTier: string
  storageSizeGb: number
  haEnabled: boolean
  haState: string
  backupRetentionDays: number
  geoRedundantBackup: boolean
  availabilityZone: string
  databaseCount: number
  tagCount: number
  notes: string[]
}

export type AzurePostgreSqlDatabaseSummary = {
  id: string
  name: string
  serverName: string
  resourceGroup: string
  charset: string
  collation: string
}

export type AzurePostgreSqlEstateOverview = {
  subscriptionId: string
  serverCount: number
  databaseCount: number
  publicServerCount: number
  servers: AzurePostgreSqlServerSummary[]
  databases: AzurePostgreSqlDatabaseSummary[]
  notes: string[]
}

export type AzurePostgreSqlFirewallRule = {
  name: string
  startIpAddress: string
  endIpAddress: string
}

export type AzurePostgreSqlOperationalTone = 'good' | 'warning' | 'risk' | 'info' | 'neutral'

export type AzurePostgreSqlPostureBadge = {
  id: string
  label: string
  value: string
  tone: AzurePostgreSqlOperationalTone
}

export type AzurePostgreSqlSummaryTile = {
  id: string
  label: string
  value: string
  tone: AzurePostgreSqlOperationalTone
}

export type AzurePostgreSqlFinding = {
  id: string
  severity: 'info' | 'warning' | 'risk'
  title: string
  message: string
  recommendation: string
}

export type AzurePostgreSqlServerDetail = {
  server: AzurePostgreSqlServerSummary
  databases: AzurePostgreSqlDatabaseSummary[]
  firewallRules: AzurePostgreSqlFirewallRule[]
  badges: AzurePostgreSqlPostureBadge[]
  summaryTiles: AzurePostgreSqlSummaryTile[]
  findings: AzurePostgreSqlFinding[]
  recommendations: string[]
  connectionDetails: Array<{ label: string; value: string }>
}

export type AzureMonitorFacetCount = {
  label: string
  count: number
}

export type AzureMonitorActivityEvent = {
  id: string
  timestamp: string
  level: string
  status: string
  resourceGroup: string
  resourceType: string
  operationName: string
  resourceId: string
  caller: string
  correlationId: string
  summary: string
}

export type AzureMonitorActivityResult = {
  query: string
  events: AzureMonitorActivityEvent[]
  statusCounts: AzureMonitorFacetCount[]
  resourceTypeCounts: AzureMonitorFacetCount[]
  notes: string[]
}

export type AzureCostBreakdownEntry = {
  label: string
  amount: number
  currency: string
  sharePercent: number
}

export type AzureCostDailyEntry = {
  date: string
  amount: number
  currency: string
}

export type AzureCostOverview = {
  subscriptionId: string
  timeframeLabel: string
  totalAmount: number
  currency: string
  dailyAverage: number
  topServiceName: string
  topServiceAmount: number
  serviceCount: number
  resourceGroupCount: number
  topServices: AzureCostBreakdownEntry[]
  topResourceGroups: AzureCostBreakdownEntry[]
  dailyCosts: AzureCostDailyEntry[]
  notes: string[]
}

// ── Azure Cost Management Extended Types ────────────────────────────────────────

export type AzureCostTrendMonth = {
  month: string
  totalAmount: number
  currency: string
  topServices: { service: string; amount: number }[]
}

export type AzureCostTrend = {
  subscriptionId: string
  months: AzureCostTrendMonth[]
  currency: string
  message: string
}

export type AzureCostResourceGroupEntry = {
  resourceGroup: string
  amount: number
  currency: string
  sharePercent: number
  topServices: { service: string; amount: number }[]
}

export type AzureCostByResourceGroup = {
  subscriptionId: string
  entries: AzureCostResourceGroupEntry[]
  totalAmount: number
  currency: string
  message: string
}

export type AzureCostMeterEntry = {
  meterCategory: string
  meterSubCategory: string
  amount: number
  currency: string
  sharePercent: number
}

export type AzureCostByMeterCategory = {
  subscriptionId: string
  entries: AzureCostMeterEntry[]
  totalAmount: number
  currency: string
  message: string
}

export type AzureCostTagEntry = {
  tagValue: string
  amount: number
  currency: string
  sharePercent: number
}

export type AzureCostByTag = {
  subscriptionId: string
  tagKey: string
  entries: AzureCostTagEntry[]
  totalAmount: number
  currency: string
  message: string
}

export type AzureCostForecastEntry = {
  date: string
  amount: number
  costType: 'actual' | 'forecast'
  currency: string
}

export type AzureCostForecast = {
  subscriptionId: string
  actualTotal: number
  forecastTotal: number
  entries: AzureCostForecastEntry[]
  currency: string
  confidence: 'low' | 'medium' | 'high'
  message: string
}

export type AzureBudgetSummary = {
  name: string
  id: string
  amount: number
  timeGrain: string
  currency: string
  startDate: string
  endDate: string
  currentSpend: number
  forecastSpend: number
  thresholdPercents: number[]
  category: string
  utilizationPercent: number
}

export type AzureReservationEntry = {
  reservationId: string
  reservationOrderId: string
  skuName: string
  avgUtilizationPercent: number
  minUtilizationPercent: number
  maxUtilizationPercent: number
  reservedHours: number
  usedHours: number
  usageDate: string
}

export type AzureReservationUtilization = {
  subscriptionId: string
  entries: AzureReservationEntry[]
  averageUtilization: number
  message: string
}

export type AzureCostAnomaly = {
  service: string
  currentAmount: number
  previousAmount: number
  absoluteChange: number
  percentChange: number
  severity: 'info' | 'warning' | 'critical'
  comparisonBasis: string
}

export type GcpProjectLabelSummary = {
  key: string
  value: string
}

export type GcpEnabledApiSummary = {
  name: string
  title: string
}

export type GcpProjectCapabilityHint = {
  id: string
  subject: string
  severity: 'info' | 'warning' | 'error'
  title: string
  summary: string
  recommendedAction: string
}

export type GcpProjectOverview = {
  projectId: string
  projectNumber: string
  displayName: string
  lifecycleState: string
  parentType: string
  parentId: string
  createTime: string
  labels: GcpProjectLabelSummary[]
  enabledApis: GcpEnabledApiSummary[]
  enabledApiCount: number
  capabilityHints: GcpProjectCapabilityHint[]
  notes: string[]
}

export type GcpIamBindingSummary = {
  role: string
  memberCount: number
  risky: boolean
  publicAccess: boolean
  conditionTitle: string
  members: string[]
}

export type GcpIamPrincipalSummary = {
  principal: string
  bindingCount: number
  highPrivilegeRoleCount: number
  sampleRoles: string[]
}

export type GcpServiceAccountSummary = {
  email: string
  displayName: string
  uniqueId: string
  description: string
  disabled: boolean
}

export type GcpServiceAccountKeySummary = {
  name: string
  keyId: string
  keyType: string
  keyOrigin: string
  validAfterTime: string
  validBeforeTime: string
  disabled: boolean
}

export type GcpIamRoleSummary = {
  name: string
  title: string
  description: string
  stage: string
  isCustom: boolean
  permissionCount: number
  includedPermissions: string[]
}

export type GcpIamTestPermissionsResult = {
  permission: string
  allowed: boolean
}

export type GcpIamCapabilityHint = {
  id: string
  subject: string
  severity: 'info' | 'warning' | 'error'
  title: string
  summary: string
  recommendedAction: string
}

export type GcpIamOverview = {
  projectId: string
  bindingCount: number
  principalCount: number
  riskyBindingCount: number
  publicPrincipalCount: number
  bindings: GcpIamBindingSummary[]
  principals: GcpIamPrincipalSummary[]
  serviceAccounts: GcpServiceAccountSummary[]
  capabilityHints: GcpIamCapabilityHint[]
  notes: string[]
}

// ── GCP IAM Extended Types (Console Feature Parity) ─────────────────────────────

export type GcpServiceAccountIamBinding = {
  role: string
  members: string[]
  conditionTitle: string
  conditionExpression: string
}

export type GcpServiceAccountDetail = {
  email: string
  displayName: string
  uniqueId: string
  description: string
  disabled: boolean
  oauth2ClientId: string
  projectId: string
  iamBindings: GcpServiceAccountIamBinding[]
  keys: {
    keyId: string
    keyType: string
    keyOrigin: string
    validAfterTime: string
    validBeforeTime: string
    disabled: boolean
  }[]
  keyCount: number
  oldestKeyAgeDays: number
}

export type GcpServiceAccountKeyReportEntry = {
  email: string
  displayName: string
  disabled: boolean
  keys: {
    keyId: string
    validAfterTime: string
    validBeforeTime: string
    ageDays: number
    disabled: boolean
  }[]
  keyCount: number
  oldestKeyAgeDays: number
}

export type GcpServiceAccountKeyReport = {
  projectId: string
  generatedAt: string
  entries: GcpServiceAccountKeyReportEntry[]
  summary: {
    totalAccounts: number
    totalKeys: number
    keysOlderThan90Days: number
    keysOlderThan365Days: number
    disabledAccounts: number
  }
}

export type GcpIamAuditEntry = {
  timestamp: string
  severity: string
  methodName: string
  principalEmail: string
  callerIp: string
  resourceName: string
  serviceName: string
  statusCode: number
  statusMessage: string
}

export type GcpWorkloadIdentityPoolSummary = {
  name: string
  displayName: string
  description: string
  state: string
  disabled: boolean
  expireTime: string
}

export type GcpWorkloadIdentityProviderSummary = {
  name: string
  displayName: string
  description: string
  state: string
  disabled: boolean
  providerType: string
  attributeMapping: Record<string, string>
  attributeCondition: string
}

export type GcpIamRecommendation = {
  name: string
  description: string
  priority: string
  recommenderSubtype: string
  state: string
  category: string
  affectedMember: string
  currentRole: string
  recommendedRole: string
  lastRefreshTime: string
}

export type GcpIamPolicyAnalysisAccessEntry = {
  role: string
  members: string[]
  identities: string[]
  resources: string[]
  accesses: string[]
  conditionTitle: string
}

export type GcpIamPolicyAnalysisResult = {
  analysisResults: GcpIamPolicyAnalysisAccessEntry[]
  fullyExplored: boolean
}

export type GcpComputeInstanceSummary = {
  name: string
  zone: string
  status: string
  machineType: string
  internalIp: string
  externalIp: string
}

export type GcpLabelEntry = {
  key: string
  value: string
}

export type GcpMetadataEntry = {
  key: string
  value: string
}

export type GcpComputeNetworkInterfaceSummary = {
  name: string
  network: string
  subnetwork: string
  internalIp: string
  externalIp: string
  stackType: string
}

export type GcpComputeDiskSummary = {
  deviceName: string
  type: string
  sizeGb: string
  status: string
  mode: string
  interface: string
  boot: boolean
  autoDelete: boolean
}

export type GcpComputeServiceAccountDetail = {
  email: string
  scopes: string[]
}

export type GcpComputeInstanceDetail = {
  id: string
  name: string
  zone: string
  status: string
  machineType: string
  cpuPlatform: string
  internalIp: string
  externalIp: string
  canIpForward: boolean
  deletionProtection: boolean
  creationTimestamp: string
  lastStartTimestamp: string
  lastStopTimestamp: string
  scheduling: string
  tags: string[]
  labels: GcpLabelEntry[]
  metadata: GcpMetadataEntry[]
  networks: GcpComputeNetworkInterfaceSummary[]
  disks: GcpComputeDiskSummary[]
  serviceAccounts: GcpComputeServiceAccountDetail[]
  shieldedIntegrityMonitoring: boolean
  shieldedSecureBoot: boolean
  shieldedVtpm: boolean
}

export type GcpComputeMachineTypeOption = {
  name: string
  guestCpus: number
  memoryMb: number
  description: string
  isSharedCpu: boolean
}

export type GcpComputeSerialOutput = {
  contents: string
  nextStart: number
  port: number
}

export type GcpComputeInstanceAction = 'start' | 'stop' | 'reset' | 'resume' | 'suspend'

export type GcpComputeOperationResult = {
  operationName: string
  completed: boolean
  status: string
  summary: string
}

export type GcpGkeClusterSummary = {
  name: string
  location: string
  status: string
  masterVersion: string
  nodeCount: string
  releaseChannel: string
  endpoint: string
}

export type GcpGkeClusterDetail = {
  name: string
  location: string
  status: string
  endpoint: string
  masterVersion: string
  nodeVersion: string
  releaseChannel: string
  autopilotEnabled: boolean
  privateClusterEnabled: boolean
  shieldedNodesEnabled: boolean
  verticalPodAutoscalingEnabled: boolean
  currentNodeCount: number
  nodePoolCount: number
  workloadIdentityPool: string
  network: string
  subnetwork: string
  clusterIpv4Cidr: string
  servicesIpv4Cidr: string
  controlPlaneIpv4Cidr: string
  loggingService: string
  monitoringService: string
  maintenanceWindow: string
  maintenanceExclusions: string[]
  resourceLabels: Record<string, string>
}

export type GcpGkeNodePoolSummary = {
  name: string
  status: string
  version: string
  nodeCount: number
  minNodeCount: number
  maxNodeCount: number
  machineType: string
  imageType: string
  diskSizeGb: string
  autoscaling: string
  autoUpgradeEnabled: boolean
  autoRepairEnabled: boolean
  spotEnabled: boolean
  preemptible: boolean
  locations: string[]
}

export type GcpGkeOperationSummary = {
  id: string
  type: string
  status: string
  detail: string
  target: string
  location: string
  startedAt: string
  endedAt: string
}

export type GcpGkeOperationResult = {
  operationName: string
  completed: boolean
  status: string
  summary: string
}

export type GcpGkeClusterCredentials = {
  clusterName: string
  location: string
  endpoint: string
  contextName: string
  kubeconfigPath: string
  authProvider: string
  tokenPreview: string
  tokenExpiresAt: string
  certificateAuthorityData: string
  bearerToken: string
  kubeconfigYaml: string
}

export type GcpStorageBucketSummary = {
  name: string
  location: string
  locationType: string
  storageClass: string
  publicAccessPrevention: string
  versioningEnabled: boolean
  uniformBucketLevelAccessEnabled: boolean
  labelCount: number
}

export type GcpStorageObjectSummary = {
  key: string
  size: number
  lastModified: string
  storageClass: string
  isFolder: boolean
}

export type GcpStorageObjectContent = {
  body: string
  contentType: string
}

export type GcpSqlInstanceSummary = {
  name: string
  region: string
  zone: string
  state: string
  databaseVersion: string
  availabilityType: string
  primaryAddress: string
  privateAddress: string
  storageAutoResizeEnabled: boolean
  diskSizeGb: string
  deletionProtectionEnabled: boolean
  maintenanceWindow: string
}

export type GcpSqlInstanceDetail = {
  name: string
  region: string
  zone: string
  state: string
  databaseVersion: string
  availabilityType: string
  primaryAddress: string
  privateAddress: string
  diskSizeGb: string
  storageAutoResizeEnabled: boolean
  deletionProtectionEnabled: boolean
  maintenanceWindow: string
  activationPolicy: string
  pricingPlan: string
  diskType: string
  connectorEnforcement: string
  sslMode: string
  backupEnabled: boolean
  binaryLogEnabled: boolean
  pointInTimeRecoveryEnabled: boolean
  authorizedNetworks: string[]
}

export type GcpSqlDatabaseSummary = {
  name: string
  charset: string
  collation: string
}

export type GcpSqlOperationSummary = {
  id: string
  operationType: string
  status: string
  targetId: string
  targetProject: string
  user: string
  insertTime: string
  endTime: string
  error: string
}

export type GcpLogEntryDetail = {
  label: string
  value: string
}

export type GcpLogEntrySummary = {
  insertId: string
  timestamp: string
  severity: string
  resourceType: string
  logName: string
  summary: string
  details: GcpLogEntryDetail[]
}

export type GcpLogFacetCount = {
  label: string
  count: number
}

export type GcpLogQueryResult = {
  query: string
  entries: GcpLogEntrySummary[]
  severityCounts: GcpLogFacetCount[]
  resourceTypeCounts: GcpLogFacetCount[]
}

export type GcpBillingLinkedProjectSummary = {
  projectId: string
  name: string
  projectNumber: string
  lifecycleState: string
  labelCount: number
  billingEnabled: boolean
}

export type GcpBillingCapabilityHint = {
  id: string
  subject: string
  severity: 'info' | 'warning' | 'error'
  title: string
  summary: string
  recommendedAction: string
}

export type GcpBillingOwnershipValue = {
  value: string
  projectCount: number
  sharePercent: number
}

export type GcpBillingOwnershipHint = {
  key: string
  coveragePercent: number
  labeledProjects: number
  unlabeledProjects: number
  topValues: GcpBillingOwnershipValue[]
}

export type GcpBillingVisibility = 'full' | 'billing-account-only' | 'project-only'

export type GcpBillingSpendTelemetryStatus =
  | 'available'
  | 'billing-disabled'
  | 'missing-export'
  | 'access-limited'
  | 'error'

export type GcpBillingSpendBreakdownEntry = {
  service: string
  amount: number
  currency: string
  sharePercent: number
}

export type GcpBillingSpendTelemetry = {
  status: GcpBillingSpendTelemetryStatus
  source: 'bigquery-export' | 'metadata-only'
  periodLabel: string
  periodStart: string
  periodEnd: string
  totalAmount: number
  currency: string
  serviceBreakdown: GcpBillingSpendBreakdownEntry[]
  exportProjectId: string
  exportDatasetId: string
  exportTableId: string
  message: string
  lastUpdatedAt: string
}

export type GcpBillingOverview = {
  projectId: string
  projectNumber: string
  projectName: string
  billingEnabled: boolean
  billingAccountName: string
  billingAccountDisplayName: string
  billingAccountOpen: boolean
  accessibleProjectCount: number
  linkedProjects: GcpBillingLinkedProjectSummary[]
  capabilityHints: GcpBillingCapabilityHint[]
  ownershipHints: GcpBillingOwnershipHint[]
  spendTelemetry: GcpBillingSpendTelemetry
  notes: string[]
  projectLabelCount: number
  linkedProjectLabelCoveragePercent: number
  visibility: GcpBillingVisibility
  lastUpdatedAt: string
}

// ── GCP Billing & Cost Analysis Extended Types ──────────────────────────────────

export type GcpBillingAccountSummary = {
  name: string
  displayName: string
  open: boolean
  masterBillingAccount: string
}

export type GcpBillingCostTrendMonth = {
  month: string
  totalAmount: number
  currency: string
  topServices: { service: string; amount: number }[]
}

export type GcpBillingCostTrend = {
  projectId: string
  months: GcpBillingCostTrendMonth[]
  currency: string
  message: string
}

export type GcpBillingDailyCostEntry = {
  date: string
  amount: number
  currency: string
}

export type GcpBillingDailyCostTrend = {
  projectId: string
  days: GcpBillingDailyCostEntry[]
  currency: string
  message: string
}

export type GcpBillingLabelCostEntry = {
  labelValue: string
  amount: number
  currency: string
  sharePercent: number
}

export type GcpBillingCostByLabel = {
  projectId: string
  labelKey: string
  entries: GcpBillingLabelCostEntry[]
  totalAmount: number
  currency: string
  message: string
}

export type GcpBillingSkuCostEntry = {
  skuDescription: string
  amount: number
  currency: string
  sharePercent: number
}

export type GcpBillingSkuBreakdown = {
  projectId: string
  serviceName: string
  entries: GcpBillingSkuCostEntry[]
  totalAmount: number
  currency: string
  message: string
}

export type GcpBillingBudgetSummary = {
  name: string
  displayName: string
  budgetAmount: number
  currency: string
  scopeProjectIds: string[]
  thresholdPercents: number[]
  calendarPeriod: string
}

export type GcpBillingCostForecast = {
  projectId: string
  currentMonthSpend: number
  forecastedMonthEnd: number
  averageDailySpend: number
  daysElapsed: number
  daysRemaining: number
  currency: string
  confidence: 'low' | 'medium' | 'high'
  message: string
}

export type GcpBillingCostAnomaly = {
  service: string
  currentAmount: number
  previousAmount: number
  absoluteChange: number
  percentChange: number
  severity: 'info' | 'warning' | 'critical'
  comparisonBasis: string
}

export type GcpBigQueryDatasetSummary = {
  datasetId: string
  projectId: string
  location: string
  friendlyName: string
  description: string
  creationTime: string
  lastModifiedTime: string
  tableCount: number
}

export type GcpBigQueryTableSummary = {
  tableId: string
  datasetId: string
  projectId: string
  type: string
  creationTime: string
  expirationTime: string
  rowCount: string
  sizeBytes: string
  description: string
}

export type GcpBigQuerySchemaFieldSummary = {
  name: string
  type: string
  mode: string
  description: string
  fields: GcpBigQuerySchemaFieldSummary[]
}

export type GcpBigQueryTableDetail = {
  tableId: string
  datasetId: string
  projectId: string
  type: string
  schema: GcpBigQuerySchemaFieldSummary[]
  rowCount: string
  sizeBytes: string
  creationTime: string
  lastModifiedTime: string
  description: string
  location: string
}

export type GcpBigQueryQueryResult = {
  columns: string[]
  rows: string[][]
  totalRows: string
  jobComplete: boolean
  cacheHit: boolean
}

export type GcpMonitoringAlertPolicySummary = {
  name: string
  displayName: string
  enabled: boolean
  conditionCount: number
  notificationChannelCount: number
  combiner: string
  creationTime: string
  mutationTime: string
}

export type GcpMonitoringUptimeCheckSummary = {
  name: string
  displayName: string
  monitoredResource: string
  protocol: string
  period: string
  timeout: string
  selectedRegions: string[]
  isInternal: boolean
}

export type GcpMonitoringMetricDescriptorSummary = {
  type: string
  displayName: string
  description: string
  metricKind: string
  valueType: string
  unit: string
  launchStage: string
}

export type GcpMonitoringTimeSeriesPoint = {
  timestamp: string
  value: number
}

export type GcpMonitoringTimeSeriesResult = {
  metric: string
  resource: string
  points: GcpMonitoringTimeSeriesPoint[]
}

// ── GCP Monitoring Extended Types (Console Feature Parity) ──────────────────────

export type GcpMonitoringNotificationChannelSummary = {
  name: string
  displayName: string
  type: string
  enabled: boolean
  description: string
  labels: Record<string, string>
  verificationStatus: string
  creationTime: string
  mutationTime: string
}

export type GcpMonitoringGroupSummary = {
  name: string
  displayName: string
  filter: string
  parentName: string
  isCluster: boolean
}

export type GcpMonitoringDashboardSummary = {
  name: string
  displayName: string
  etag: string
  widgetCount: number
}

export type GcpMonitoringDashboardDetail = {
  name: string
  displayName: string
  etag: string
  widgets: {
    title: string
    widgetType: string
    metricTypes: string[]
  }[]
}

export type GcpMonitoringAggregatedPoint = {
  timestamp: string
  value: number
}

export type GcpMonitoringAggregatedMetric = {
  metricType: string
  timeSeries: {
    metricType: string
    resourceType: string
    resourceLabels: Record<string, string>
    metricLabels: Record<string, string>
    points: GcpMonitoringAggregatedPoint[]
  }[]
  alignmentPeriod: string
  aggregation: string
}

export type GcpLogEntry = {
  logName: string
  timestamp: string
  severity: string
  insertId: string
  resourceType: string
  resourceLabels: Record<string, string>
  textPayload: string
  jsonPayloadSummary: string
  httpMethod: string
  httpStatus: number
  httpUrl: string
  trace: string
  spanId: string
}

export type GcpLogEntriesResult = {
  entries: GcpLogEntry[]
  nextPageToken: string
}

export type GcpMonitoringServiceSummary = {
  name: string
  displayName: string
  serviceType: string
  telemetryResourceName: string
}

export type GcpMonitoringSloSummary = {
  name: string
  displayName: string
  goal: number
  rollingPeriodDays: number
  calendarPeriod: string
  sliType: string
}

export type GcpSccFindingSummary = {
  name: string
  category: string
  state: string
  severity: string
  resourceName: string
  resourceType: string
  sourceDisplayName: string
  eventTime: string
  createTime: string
  description: string
  externalUri: string
}

export type GcpSccSourceSummary = {
  name: string
  displayName: string
  description: string
}

export type GcpSccFindingDetail = {
  name: string
  category: string
  state: string
  severity: string
  resourceName: string
  resourceType: string
  sourceDisplayName: string
  sourceProperties: Record<string, string>
  eventTime: string
  createTime: string
  description: string
  nextSteps: string
  externalUri: string
  mute: string
}

export type GcpSccSeverityBreakdown = {
  critical: number
  high: number
  medium: number
  low: number
  unspecified: number
}

export type GcpSccFindingClass = 'vulnerability' | 'misconfiguration' | 'threat' | 'observation' | 'other'

export type GcpSccHealthAnalytics = {
  totalFindings: number
  activeFindings: number
  byClass: Record<GcpSccFindingClass, number>
  bySeverity: GcpSccSeverityBreakdown
  topCategories: Array<{ category: string; count: number }>
  topResources: Array<{ resourceName: string; count: number }>
}

export type GcpSccPostureReport = {
  generatedAt: string
  projectId: string
  healthAnalytics: GcpSccHealthAnalytics
  findingsByClass: Record<GcpSccFindingClass, GcpSccFindingSummary[]>
  sources: GcpSccSourceSummary[]
  warnings: string[]
}

export type GcpFirestoreDatabaseSummary = {
  name: string
  uid: string
  locationId: string
  type: string
  concurrencyMode: string
  deleteProtectionState: string
  earliestVersionTime: string
}

export type GcpFirestoreCollectionSummary = {
  collectionId: string
  documentCount: number
}

export type GcpFirestoreDocumentSummary = {
  name: string
  documentId: string
  createTime: string
  updateTime: string
  fieldCount: number
}

export type GcpFirestoreDocumentDetail = {
  name: string
  documentId: string
  createTime: string
  updateTime: string
  fields: Record<string, unknown>
}

export type GcpPubSubTopicSummary = {
  name: string
  topicId: string
  labels: Record<string, string>
  messageRetentionDuration: string
  kmsKeyName: string
  schemaSettings: string
}

export type GcpPubSubSubscriptionSummary = {
  name: string
  subscriptionId: string
  topic: string
  topicId: string
  ackDeadlineSeconds: number
  messageRetentionDuration: string
  pushEndpoint: string
  deliveryType: string
  filter: string
  enableExactlyOnceDelivery: boolean
  state: string
  detached: boolean
}

export type GcpPubSubTopicDetail = {
  name: string
  topicId: string
  labels: Record<string, string>
  messageRetentionDuration: string
  kmsKeyName: string
  schemaSettings: string
  subscriptionCount: number
}

export type GcpPubSubSubscriptionDetail = {
  name: string
  subscriptionId: string
  topic: string
  ackDeadlineSeconds: number
  messageRetentionDuration: string
  retainAckedMessages: boolean
  pushConfig: { pushEndpoint: string; attributes: Record<string, string> } | null
  deadLetterPolicy: { deadLetterTopic: string; maxDeliveryAttempts: number } | null
  retryPolicy: { minimumBackoff: string; maximumBackoff: string } | null
  filter: string
  enableExactlyOnceDelivery: boolean
  state: string
  expirationTtl: string
}

/* ── Cloud Run ───────────────────────────────────── */

export type GcpCloudRunServiceSummary = {
  name: string
  serviceId: string
  description: string
  uri: string
  creator: string
  lastModifier: string
  createTime: string
  updateTime: string
  ingressSetting: string
  launchStage: string
  latestReadyRevision: string
  latestCreatedRevision: string
  trafficStatuses: GcpCloudRunTrafficStatus[]
  containerImage: string
  containerPort: number
  serviceAccountEmail: string
  vpcConnector: string
  executionEnvironment: string
  cpuLimit: string
  memoryLimit: string
  maxInstanceRequestConcurrency: number
  timeout: string
  conditions: GcpCloudRunCondition[]
}

export type GcpCloudRunTrafficStatus = {
  type: string
  revisionName: string
  percent: number
  tag: string
  uri: string
}

export type GcpCloudRunCondition = {
  type: string
  state: string
  message: string
  lastTransitionTime: string
  severity: string
}

export type GcpCloudRunRevisionSummary = {
  name: string
  revisionId: string
  generation: string
  createTime: string
  updateTime: string
  launchStage: string
  containerImage: string
  cpuLimit: string
  memoryLimit: string
  maxInstanceRequestConcurrency: number
  timeout: string
  serviceAccountEmail: string
  scaling: { minInstanceCount: number; maxInstanceCount: number }
  conditions: GcpCloudRunCondition[]
  logUri: string
}

export type GcpCloudRunJobSummary = {
  name: string
  jobId: string
  createTime: string
  updateTime: string
  creator: string
  lastModifier: string
  launchStage: string
  containerImage: string
  taskCount: number
  maxRetries: number
  timeout: string
  cpuLimit: string
  memoryLimit: string
  serviceAccountEmail: string
  executionCount: number
  latestExecution: string
  conditions: GcpCloudRunCondition[]
}

export type GcpCloudRunExecutionSummary = {
  name: string
  executionId: string
  createTime: string
  startTime: string
  completionTime: string
  runningCount: number
  succeededCount: number
  failedCount: number
  cancelledCount: number
  taskCount: number
  logUri: string
  conditions: GcpCloudRunCondition[]
}

export type GcpCloudRunDomainMappingSummary = {
  name: string
  routeName: string
  createTime: string
  conditions: GcpCloudRunCondition[]
  mappedRouteName: string
  records: { type: string; rrdata: string }[]
}

/* ── Firebase ────────────────────────────────────── */

export type GcpFirebaseProjectSummary = {
  projectId: string
  projectNumber: string
  displayName: string
  state: string
  resources: {
    hostingSite: string
    storageBucket: string
    locationId: string
    realtimeDatabaseInstance: string
  }
}

export type GcpFirebaseWebAppSummary = {
  name: string
  appId: string
  displayName: string
  projectId: string
  appUrls: string[]
  state: string
  apiKeyId: string
}

export type GcpFirebaseAndroidAppSummary = {
  name: string
  appId: string
  displayName: string
  projectId: string
  packageName: string
  state: string
  sha1Hashes: string[]
  sha256Hashes: string[]
}

export type GcpFirebaseIosAppSummary = {
  name: string
  appId: string
  displayName: string
  projectId: string
  bundleId: string
  appStoreId: string
  state: string
  teamId: string
}

export type GcpFirebaseHostingSiteSummary = {
  name: string
  siteId: string
  defaultUrl: string
  appId: string
  type: string
  labels: Record<string, string>
}

export type GcpFirebaseHostingReleaseSummary = {
  name: string
  version: string
  type: string
  message: string
  releaseTime: string
  releaseUser: { email: string; imageUrl: string }
  status: string
  fileCount: number
  versionBytes: string
}

export type GcpFirebaseHostingDomainSummary = {
  domainName: string
  site: string
  updateTime: string
  status: string
  provisioning: string
  domainRedirect: { domainName: string; type: string } | null
}

export type GcpFirebaseHostingChannelSummary = {
  name: string
  channelId: string
  url: string
  expireTime: string
  retainedReleaseCount: number
  createTime: string
  updateTime: string
  labels: Record<string, string>
}

export type GcpFirewallRuleSummary = {
  name: string
  network: string
  direction: string
  priority: string
}

export type GcpNetworkSummary = {
  name: string
  autoCreateSubnetworks: boolean
  routingMode: string
}

export type GcpSubnetworkSummary = {
  name: string
  region: string
  network: string
  ipCidrRange: string
  privateIpGoogleAccess: boolean
}

export type GcpRouterSummary = {
  name: string
  region: string
  network: string
}

export type GcpRouterNatSummary = {
  name: string
  region: string
  router: string
  natIpAllocateOption: string
}

export type GcpGlobalAddressSummary = {
  name: string
  address: string
  addressType: string
  purpose: string
  network: string
  prefixLength: string
}

export type GcpServiceNetworkingConnectionSummary = {
  network: string
  service: string
  peering: string
  reservedPeeringRanges: string[]
}

/* ── GCP Memorystore (Redis) ──────────────────────────────── */

export type GcpMemorystoreInstanceSummary = {
  name: string
  instanceId: string
  displayName: string
  state: string
  tier: string
  memorySizeGb: number
  host: string
  port: number
  redisVersion: string
  createTime: string
  currentLocationId: string
  connectMode: string
  authEnabled: boolean
  transitEncryptionMode: string
  replicaCount: number
  readEndpoint: string
  readEndpointPort: number
  locationId: string
  alternativeLocationId: string
  labels: Record<string, string>
}

export type GcpMemorystoreInstanceDetail = {
  name: string
  instanceId: string
  displayName: string
  state: string
  tier: string
  memorySizeGb: number
  host: string
  port: number
  redisVersion: string
  createTime: string
  currentLocationId: string
  connectMode: string
  authEnabled: boolean
  transitEncryptionMode: string
  replicaCount: number
  readEndpoint: string
  readEndpointPort: number
  locationId: string
  alternativeLocationId: string
  labels: Record<string, string>
  redisConfigs: Record<string, string>
  persistenceConfig: {
    persistenceMode: string
    rdbSnapshotPeriod: string
    rdbSnapshotStartTime: string
  }
  maintenancePolicy: {
    weeklyMaintenanceWindow: Array<{
      day: string
      startTime: string
      duration: string
    }>
  } | null
  maintenanceSchedule: {
    startTime: string
    endTime: string
    scheduleDeadlineTime: string
  } | null
  nodes: Array<{
    id: string
    zone: string
  }>
  authorizedNetwork: string
  reservedIpRange: string
}

/* ── GCP Load Balancer + Cloud Armor ─────────────────────── */

export type GcpUrlMapSummary = {
  name: string
  description: string
  selfLink: string
  defaultService: string
  hostRuleCount: number
  pathMatcherCount: number
  creationTimestamp: string
  region: string
  fingerprint: string
}

export type GcpUrlMapDetail = {
  name: string
  description: string
  selfLink: string
  defaultService: string
  hostRules: Array<{
    hosts: string[]
    pathMatcher: string
  }>
  pathMatchers: Array<{
    name: string
    defaultService: string
    pathRules: Array<{
      paths: string[]
      service: string
    }>
  }>
  creationTimestamp: string
  fingerprint: string
}

export type GcpBackendServiceSummary = {
  name: string
  description: string
  selfLink: string
  protocol: string
  port: number
  portName: string
  timeoutSec: number
  healthChecks: string[]
  backendsCount: number
  loadBalancingScheme: string
  sessionAffinity: string
  region: string
  creationTimestamp: string
  securityPolicy: string
}

export type GcpForwardingRuleSummary = {
  name: string
  description: string
  selfLink: string
  IPAddress: string
  IPProtocol: string
  portRange: string
  target: string
  loadBalancingScheme: string
  network: string
  region: string
  creationTimestamp: string
}

export type GcpHealthCheckSummary = {
  name: string
  description: string
  selfLink: string
  type: string
  checkIntervalSec: number
  timeoutSec: number
  unhealthyThreshold: number
  healthyThreshold: number
  creationTimestamp: string
}

export type GcpSecurityPolicySummary = {
  name: string
  description: string
  selfLink: string
  type: string
  ruleCount: number
  adaptiveProtection: boolean
  creationTimestamp: string
  fingerprint: string
}

export type GcpSecurityPolicyDetail = {
  name: string
  description: string
  selfLink: string
  type: string
  rules: Array<{
    priority: number
    action: string
    description: string
    match: {
      versionedExpr: string
      config: {
        srcIpRanges: string[]
      }
    } | null
    preview: boolean
  }>
  adaptiveProtectionConfig: {
    enabled: boolean
    layer7DdosDefenseConfig: { enable: boolean; ruleVisibility: string } | null
  } | null
  ddosProtectionConfig: string
  fingerprint: string
  creationTimestamp: string
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
  vaultEntryId: string
  vaultEntryName: string
  sourceLabel: string
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

/* ── Load Balancer Log Viewer types ──────────────────────── */

export type LoadBalancerLogEntry = {
  timestamp: string
  clientIp: string
  clientPort: number
  targetIp: string
  targetPort: number
  httpMethod: string
  requestUrl: string
  statusCode: number
  targetStatusCode: number
  sentBytes: number
  receivedBytes: number
  requestProcessingTime: number
  targetProcessingTime: number
  responseProcessingTime: number
  userAgent: string
  sslCipher: string
  sslProtocol: string
  targetGroupArn: string
  traceId: string
  domainName: string
  actionsExecuted: string
  redirectUrl: string
  errorReason: string
  provider: CloudProviderId
  raw: string
}

export type LoadBalancerLogFilter = {
  statusCodeRange?: '2xx' | '3xx' | '4xx' | '5xx' | ''
  clientIp?: string
  requestUrlPattern?: string
  minResponseTimeMs?: number
  httpMethod?: string
  targetIp?: string
  searchText?: string
}

export type LoadBalancerLogTimeRange = {
  startTime: string
  endTime: string
}

export type LoadBalancerLogQuery = {
  loadBalancerIdentifier: string
  provider: CloudProviderId
  timeRange: LoadBalancerLogTimeRange
  filter: LoadBalancerLogFilter
  maxResults: number
  nextToken?: string
}

export type LoadBalancerLogResult = {
  entries: LoadBalancerLogEntry[]
  totalScanned: number
  nextToken?: string
  statusCodeDistribution: Record<string, number>
  notes: string[]
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
  | 'gcp-projects'
  | 'gcp-iam'
  | 'gcp-compute-engine'
  | 'gcp-vpc'
  | 'gcp-gke'
  | 'gcp-cloud-storage'
  | 'gcp-cloud-sql'
  | 'gcp-logging'
  | 'gcp-billing'
  | 'gcp-bigquery'
  | 'gcp-monitoring'
  | 'gcp-scc'
  | 'gcp-firestore'
  | 'gcp-pubsub'
  | 'gcp-cloud-run'
  | 'gcp-firebase'
  | 'gcp-cloud-dns'
  | 'gcp-memorystore'
  | 'gcp-load-balancer'
  | 'azure-subscriptions'
  | 'azure-resource-groups'
  | 'azure-rbac'
  | 'azure-virtual-machines'
  | 'azure-aks'
  | 'azure-storage-accounts'
  | 'azure-sql'
  | 'azure-postgresql'
  | 'azure-monitor'
  | 'azure-cost'
  | 'azure-network'
  | 'azure-vmss'
  | 'azure-app-insights'
  | 'azure-key-vault'
  | 'azure-event-hub'
  | 'azure-app-service'
  | 'azure-mysql'
  | 'azure-cosmos-db'
  | 'azure-log-analytics'
  | 'azure-event-grid'
  | 'azure-firewall'
  | 'azure-load-balancers'
  | 'azure-dns'

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

export type CompliancePolicyPackFocus =
  | 'tagging-defaults'
  | 'encryption'
  | 'public-exposure'
  | 'backup'

export type CompliancePolicyPackDefinition = {
  id: string
  title: string
  focus: CompliancePolicyPackFocus
  description: string
  resourceTypes: string[]
  expectations: string[]
  updatedAt: string
}

export type CloudWatchQueryFilter = {
  profile?: string
  region?: string
  serviceHint?: ServiceId | ''
  logGroupName?: string
  limit?: number
}

export type CloudWatchInvestigationEventKind =
  | 'focus'
  | 'open-log-group'
  | 'investigate-log-group'
  | 'run-query'
  | 'save-query'

export type CloudWatchInvestigationEventSeverity = 'info' | 'success' | 'warning' | 'error'

export type CloudWatchInvestigationHistoryEntry = {
  id: string
  profile: string
  region: string
  serviceHint: ServiceId | ''
  logGroupNames: string[]
  kind: CloudWatchInvestigationEventKind
  title: string
  detail: string
  severity: CloudWatchInvestigationEventSeverity
  occurredAt: string
}

export type CloudWatchInvestigationHistoryInput = Omit<CloudWatchInvestigationHistoryEntry, 'id' | 'occurredAt'>

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
  | 'kubeconfig-fragment'
  | 'api-token'
  | 'connection-secret'

export type VaultOrigin =
  | 'manual'
  | 'imported'
  | 'imported-file'
  | 'aws-secrets-manager'
  | 'aws-ssm'
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
  reminderAt: string
  expiryAt: string
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
  reminderAt?: string
  expiryAt?: string
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

export type VaultSshKeyInspectionSource =
  | 'metadata-inline'
  | 'metadata-path'
  | 'source-path'
  | 'legacy-staged-path'
  | 'derived-from-private-key'
  | 'unavailable'

export type VaultSshKeyInspection = {
  entryId: string
  entryName: string
  kind: Extract<VaultEntryKind, 'pem' | 'ssh-key'>
  keyNameHints: string[]
  fingerprintSha256: string
  fingerprintMd5: string
  publicKeySource: VaultSshKeyInspectionSource
  publicKeyAvailable: boolean
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

export type AppFeatureFlagSurface = 'service' | 'lab'

export type AppFeatureFlagDefinition = {
  id: AppFeatureFlagId
  label: string
  description: string
  maturity: ServiceMaturity
  surface: AppFeatureFlagSurface
  serviceId?: ServiceId
  defaultEnabled: boolean
}

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

export type AppDiagnosticsSnapshot = {
  generatedAt: string
  activeProviderId: CloudProviderId
  activeScreen: string
  selectedServiceId: ServiceId | ''
  accessMode: EnterpriseAccessMode
  terminalOpen: boolean
  terminalContextReady: boolean
  selectedPreviewModeId: string
  selectedPreviewModeLabel: string
  aws?: {
    connected: boolean
    profile: string
    region: string
    activeSessionId: string
    activeSessionLabel: string
  }
  gcp?: {
    cliDetected: boolean
    cliError: string
    activeConfigurationName: string
    activeAccount: string
    activeProjectId: string
    activeRegion: string
    activeZone: string
    selectedProjectId: string
    selectedLocation: string
    recentProjectIds: string[]
    catalogProjectCount: number
    configurationCount: number
    locationCount: number
  }
  azure?: {
    modeId: string
    modeLabel: string
    selectedSubscriptionId?: string
    selectedLocation?: string
    catalogSubscriptionCount?: number
    catalogError?: string
    cliDetected: boolean
    cliPath: string
    activeContextLabel: string
    activeContextDetail: string
    terraformContextKey: string
    terminalReady: boolean
    sharedWorkspaceCount: number
    providerWorkspaceCount: number
  }
}

export type AppDiagnosticsActiveContext = AppDiagnosticsSnapshot

export type AppDiagnosticsFailureInput = {
  action: string
  message: string
  rawMessage: string
  providerId: CloudProviderId | ''
  serviceId: ServiceId | ''
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
  | { service: 'gcp-vpc'; networkName: string }
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

/* ── Azure DNS ─────────────────────────────────────────────── */

export type AzureDnsZoneSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  numberOfRecordSets: number
  maxNumberOfRecordSets: number
  nameServers: string[]
  zoneType: string
  tags: Record<string, string>
}

export type AzureDnsRecordSummary = {
  id: string
  name: string
  fqdn: string
  type: string
  ttl: number
  values: string[]
  metadata: Record<string, string>
}

export type AzureDnsRecordUpsertInput = {
  name: string
  type: string
  ttl: number
  values: string[]
}

/* ── GCP Cloud DNS ─────────────────────────────────────────── */

export type GcpDnsManagedZoneSummary = {
  name: string
  dnsName: string
  description: string
  id: string
  visibility: string
  dnssecState: string
  nameServers: string[]
  creationTime: string
}

export type GcpDnsResourceRecordSetSummary = {
  name: string
  type: string
  ttl: number
  rrdatas: string[]
  signatureRrdatas: string[]
}

export type GcpDnsRecordUpsertInput = {
  name: string
  type: string
  ttl: number
  rrdatas: string[]
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
  metric: string
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
  payerAccountId: string
  payerAccountLabel: string
  linkedAccounts: BillingLinkedAccountSummary[]
  ownershipHints: BillingTagOwnershipHint[]
  organization: OverviewOrganizationContext | null
  capabilitySnapshot: AwsCapabilitySnapshot
  notes: string[]
  generatedAt: string
}

export type OverviewOrganizationNodeType = 'root' | 'organizational-unit' | 'account'

export type OverviewOrganizationNode = {
  id: string
  parentId: string
  type: OverviewOrganizationNodeType
  name: string
  arn: string
  accountId: string
  email: string
}

export type OverviewOrganizationContext = {
  status: 'available' | 'limited' | 'unavailable'
  organizationId: string
  organizationArn: string
  managementAccountId: string
  managementAccountName: string
  rootId: string
  rootName: string
  currentAccountId: string
  currentAccountPath: string[]
  nodes: OverviewOrganizationNode[]
  warning: string
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

export type ComplianceFindingStatus = 'open' | 'in-progress' | 'accepted-risk' | 'resolved'

export type ComplianceFindingWorkflow = {
  owner: string
  status: ComplianceFindingStatus
  acceptedRisk: string
  snoozeUntil: string
  lastReviewedAt: string
  updatedAt: string
}

export type ComplianceFindingWorkflowUpdate = {
  owner?: string
  status?: ComplianceFindingStatus
  acceptedRisk?: string
  snoozeUntil?: string
  lastReviewedAt?: string
}

export type ComplianceRemediationTemplateCommand = {
  label: string
  command: string
}

export type ComplianceRemediationTemplate = {
  id: string
  title: string
  summary: string
  commands: ComplianceRemediationTemplateCommand[]
}

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
  policyPackIds?: string[]
  workflow: ComplianceFindingWorkflow
  remediationTemplates?: ComplianceRemediationTemplate[]
  remediation?: ComplianceRemediationAction
}

export type CompliancePolicyPack = CompliancePolicyPackDefinition & {
  findingCount: number
}

export type ComplianceSummary = {
  total: number
  bySeverity: Record<ComplianceSeverity, number>
  byCategory: Record<ComplianceCategory, number>
}

export type ComplianceReport = {
  generatedAt: string
  findings: ComplianceFinding[]
  policyPacks: CompliancePolicyPack[]
  summary: ComplianceSummary
  warnings: string[]
}

/* ── Security Posture Dashboard ──────────────────────────── */

export type SecurityScoreDomain = 'iam' | 'network' | 'encryption' | 'logging' | 'compliance'

export type SecurityScoreWeights = Record<SecurityScoreDomain, number>

export type SecurityDomainResult = {
  domain: SecurityScoreDomain
  score: number
  maxScore: number
  checks: SecurityCheck[]
}

export type SecurityCheck = {
  id: string
  label: string
  passed: boolean
  severity: ComplianceSeverity
  detail: string
}

export type SecurityScoreReport = {
  generatedAt: string
  overallScore: number
  domainResults: SecurityDomainResult[]
  weights: SecurityScoreWeights
  warnings: string[]
}

/* ── GuardDuty ───────────────────────────────────────────── */

export type GuardDutySeverity = 'critical' | 'high' | 'medium' | 'low'

export type GuardDutyFinding = {
  id: string
  title: string
  description: string
  severity: GuardDutySeverity
  type: string
  category: string
  resourceType: string
  resourceId: string
  region: string
  count: number
  firstSeenAt: string
  lastSeenAt: string
  archived: boolean
}

export type GuardDutySeverityCounts = Record<GuardDutySeverity, number>

export type GuardDutyDetectorSummary = {
  detectorId: string
  status: string
  createdAt: string
}

export type GuardDutyReport = {
  generatedAt: string
  detector: GuardDutyDetectorSummary | null
  findings: GuardDutyFinding[]
  severityCounts: GuardDutySeverityCounts
  topTargetedResources: Array<{ resourceId: string; findingCount: number }>
  categoryBreakdown: Record<string, number>
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

/** Classification of a terraform run failure, used for dashboards and remediation hints. */
export type TerraformErrorClass =
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'state_lock'
  | 'network'
  | 'config'
  | 'plugin'
  | 'cancelled'
  | 'unknown'

export type TerraformAuditProviderId = 'aws' | 'gcp' | 'azure' | 'local'

/**
 * Trace context threaded through a terraform run or drift report.
 * `traceId` stays constant across retries within a single invocation.
 * `retryCount` is mutable — retry layers increment it in place.
 */
export type TerraformAuditTraceContext = {
  traceId: string
  operation: string
  provider: TerraformAuditProviderId
  module: string
  resource: string
  startedAtMs: number
  retryCount: number
}

/**
 * Structured audit summary attached to drift report responses so the UI
 * can surface trace id, duration, classification, and remediation without
 * an extra round-trip.
 */
export type TerraformAuditSummary = {
  traceId: string
  durationMs: number
  retryCount: number
  errorClass: TerraformErrorClass | null
  suggestedAction: string
}

export type TerraformRunRecord = {
  /** Run identifier. Also serves as the `traceId` in structured logs and stays stable across retries. */
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
  /** Cloud provider this run targets, inferred from profile + connection. */
  provider?: TerraformAuditProviderId
  /**
   * Human label for the root terraform module. Currently the project's display name
   * (not a `module.foo.bar` address) — see plan in unified-knitting-patterson.md.
   */
  module?: string
  /** Specific resource address when the command targets one (import, state-mv, state-rm, force-unlock, -target). */
  resource?: string
  /** Wall-clock duration from run start to finish in milliseconds. */
  durationMs?: number | null
  /** Number of retries observed (0 means first attempt succeeded). */
  retryCount?: number
  /** Structured error classification, null when the run succeeded. */
  errorClass?: TerraformErrorClass | null
  /** One-line remediation hint for the classified error; empty string on success. */
  suggestedAction?: string
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
  | 'missing_in_cloud'
  | 'unmanaged_in_cloud'
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
  trigger: 'manual' | 'initial' | 'scheduled'
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
  remediationSuggestions?: TerraformDriftRemediationSuggestion[]
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
  /** Audit summary attached by the drift providers so the UI can show remediation without an extra round-trip. */
  audit?: TerraformAuditSummary
}

export type TerraformDriftRemediationAction = 'update-terraform' | 'apply-terraform' | 'ignore-with-annotation'

export type TerraformDriftRemediationSuggestion = {
  action: TerraformDriftRemediationAction
  riskLevel: 'low' | 'medium' | 'high'
  description: string
  codeSnippet?: string
  terraformCommand?: string
  lifecycleBlock?: string
}

export type TerraformDriftScheduleInterval = 'hourly' | 'daily' | 'weekly'

export type TerraformDriftSchedule = {
  enabled: boolean
  interval: TerraformDriftScheduleInterval
  providers: CloudProviderId[]
  projectIds: string[]
  lastRunAt: string
  nextRunAt: string
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

export type TerraformAdoptionResourceType =
  | 'aws_instance'
  | 'aws_db_instance'
  | 'aws_rds_cluster'
  | 'aws_s3_bucket'
  | 'aws_iam_user'
  | 'aws_iam_group'
  | 'aws_iam_role'
  | 'aws_iam_policy'
  | 'aws_security_group'
  | 'aws_eks_cluster'
  | 'aws_ecs_service'
  | 'aws_lambda_function'
  | 'aws_route53_zone'
  | 'aws_secretsmanager_secret'
  | 'aws_kms_key'
  | 'aws_sqs_queue'
  | 'aws_sns_topic'
  | 'google_compute_instance'
  | 'google_compute_network'
  | 'google_compute_subnetwork'
  | 'google_compute_firewall'
  | 'google_storage_bucket'
  | 'google_sql_database_instance'
  | 'google_container_cluster'
  | 'google_cloud_run_service'
  | 'google_pubsub_topic'
  | 'google_pubsub_subscription'
  | 'google_dns_managed_zone'
  | 'google_project_iam_member'
  | 'google_service_account'
  | 'azurerm_virtual_machine'
  | 'azurerm_resource_group'
  | 'azurerm_virtual_network'
  | 'azurerm_subnet'
  | 'azurerm_network_security_group'
  | 'azurerm_storage_account'
  | 'azurerm_sql_server'
  | 'azurerm_kubernetes_cluster'
  | 'azurerm_app_service'
  | 'azurerm_cosmosdb_account'
  | 'azurerm_key_vault'
  | 'azurerm_dns_zone'
  | 'azurerm_eventhub_namespace'
  | 'azurerm_postgresql_flexible_server'

export type TerraformAdoptionTarget = {
  serviceId: ServiceId
  resourceType: TerraformAdoptionResourceType
  region: string
  displayName: string
  identifier: string
  arn: string
  name: string
  tags?: Record<string, string>
  resourceContext?: {
    vpcId?: string
    subnetId?: string
    securityGroupIds?: string[]
    iamInstanceProfile?: string
    availabilityZone?: string
    instanceType?: string
    imageId?: string
    gcpProject?: string
    gcpZone?: string
    gcpMachineType?: string
    gcpNetwork?: string
    gcpSubnetwork?: string
    gcpServiceAccountEmail?: string
    azureSubscriptionId?: string
    azureResourceGroup?: string
    azureLocation?: string
    azureVmSize?: string
    azureVnetId?: string
    azureSubnetId?: string
  }
}

export type TerraformAdoptionStateMatch = {
  address: string
  resourceType: string
  matchedOn: 'identifier' | 'arn' | 'name' | 'eks-nodegroup' | 'self-link' | 'azure-resource-id'
  matchedValue: string
}

export type TerraformAdoptionConfigMatch = {
  relativePath: string
  lineNumber: number
  matchedOn: 'identifier' | 'arn' | 'name'
  matchedValue: string
  excerpt: string
}

export type TerraformAdoptionProjectSignal = {
  projectId: string
  projectName: string
  rootPath: string
  currentWorkspace: string
  region: string
  backendType: string
  status: 'managed' | 'config-hint'
  stateMatches: TerraformAdoptionStateMatch[]
  configMatches: TerraformAdoptionConfigMatch[]
}

export type TerraformAdoptionDetectionResult = {
  target: TerraformAdoptionTarget
  supported: boolean
  checkedAt: string
  scannedProjectCount: number
  matchingProjectCount: number
  managedProjectCount: number
  configHintProjectCount: number
  projects: TerraformAdoptionProjectSignal[]
}

export type TerraformAdoptionMappingSource = 'related-resource' | 'existing-resource-type' | 'default'

export type TerraformAdoptionMappingConfidence = 'high' | 'medium' | 'low'

export type TerraformAdoptionRelatedResourceMatch = {
  address: string
  resourceType: string
  modulePath: string
  mode: 'managed' | 'data'
  matchedOn: 'subnet-id' | 'vpc-id' | 'security-group' | 'iam-instance-profile' | 'eks-nodegroup'
    | 'gcp-network' | 'gcp-subnetwork' | 'gcp-service-account' | 'gke-cluster'
    | 'azure-vnet' | 'azure-subnet' | 'azure-nsg' | 'azure-resource-group' | 'aks-cluster'
  matchedValue: string
}

export type TerraformAdoptionModuleSuggestion = {
  modulePath: string
  displayPath: string
  source: TerraformAdoptionMappingSource
}

export type TerraformAdoptionProviderSuggestion = {
  providerAddress: string
  alias: string
  displayName: string
  source: TerraformAdoptionMappingSource
}

export type TerraformAdoptionMappingResult = {
  supported: boolean
  checkedAt: string
  projectId: string
  projectName: string
  target: TerraformAdoptionTarget
  recommendedResourceType: string
  importId: string
  suggestedResourceName: string
  suggestedAddress: string
  module: TerraformAdoptionModuleSuggestion
  provider: TerraformAdoptionProviderSuggestion
  confidence: TerraformAdoptionMappingConfidence
  reasons: string[]
  warnings: string[]
  relatedResources: TerraformAdoptionRelatedResourceMatch[]
}

export type TerraformAdoptionCodegenFilePlan = {
  moduleDirectory: string
  moduleDisplayPath: string
  suggestedFilePath: string
  suggestedFileName: string
  action: 'append' | 'create'
  reason: string
  existingFiles: string[]
}

export type TerraformAdoptionCodegenResult = {
  supported: boolean
  checkedAt: string
  projectId: string
  projectName: string
  target: TerraformAdoptionTarget
  mapping: TerraformAdoptionMappingResult
  filePlan: TerraformAdoptionCodegenFilePlan
  resourceBlock: string
  importCommand: string
  workingDirectory: string
  notes: string[]
  warnings: string[]
}

export type TerraformAdoptionCodeApplyResult = {
  checkedAt: string
  projectId: string
  projectName: string
  filePath: string
  action: 'created' | 'appended' | 'skipped'
  bytesWritten: number
  codegen: TerraformAdoptionCodegenResult
}

export type TerraformAdoptionImportExecutionResult = {
  checkedAt: string
  projectId: string
  projectName: string
  applyResult: TerraformAdoptionCodeApplyResult
  log: TerraformCommandLog
}

export type TerraformAdoptionValidationStatus = 'passed' | 'needs-review' | 'failed'

export type TerraformAdoptionValidationResult = {
  checkedAt: string
  projectId: string
  projectName: string
  address: string
  status: TerraformAdoptionValidationStatus
  summary: string
  log: TerraformCommandLog
  planSummary: TerraformPlanSummary
  matchingChanges: TerraformPlanChange[]
}

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
  /** Not returned over IPC. Retrieve via the dedicated `aws:sts:get-session-credentials` channel. */
  secretAccessKey?: string
  /** Not returned over IPC. Retrieve via the dedicated `aws:sts:get-session-credentials` channel. */
  sessionToken?: string
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

/* ── Azure Managed Disks & Snapshots ──────────────────────── */

export type AzureManagedDiskSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  diskSizeGb: number
  diskState: string
  osType: string
  timeCreated: string
  managedBy: string
  zones: string[]
  networkAccessPolicy: string
  provisioningState: string
  tagCount: number
}

export type AzureDiskSnapshotSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  diskSizeGb: number
  timeCreated: string
  sourceResourceId: string
  incremental: boolean
  provisioningState: string
  tagCount: number
}

/* ── Azure VNet Peering, Route Tables, NAT GW, Load Balancers, Private Endpoints ── */

export type AzureVNetPeeringSummary = {
  id: string
  name: string
  peeringState: string
  remoteVNetId: string
  remoteVNetName: string
  allowVirtualNetworkAccess: boolean
  allowForwardedTraffic: boolean
  allowGatewayTransit: boolean
  useRemoteGateways: boolean
  provisioningState: string
}

export type AzureRouteTableSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  disableBgpRoutePropagation: boolean
  routes: AzureRouteSummary[]
  provisioningState: string
  subnetCount: number
}

export type AzureRouteSummary = {
  name: string
  addressPrefix: string
  nextHopType: string
  nextHopIpAddress: string
  provisioningState: string
}

export type AzureNatGatewaySummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  idleTimeoutInMinutes: number
  publicIpCount: number
  subnetCount: number
  provisioningState: string
  zones: string[]
}

export type AzureLoadBalancerSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  skuTier: string
  frontendIpCount: number
  backendPoolCount: number
  ruleCount: number
  probeCount: number
  provisioningState: string
}

export type AzureLoadBalancerFrontendIp = {
  name: string
  privateIPAddress: string
  privateIPAllocationMethod: string
  publicIPAddressId: string
  subnetId: string
  provisioningState: string
  zones: string[]
}

export type AzureLoadBalancerBackendPool = {
  name: string
  backendAddressCount: number
  provisioningState: string
}

export type AzureLoadBalancerRule = {
  name: string
  protocol: string
  frontendPort: number
  backendPort: number
  frontendIPConfigurationName: string
  backendAddressPoolName: string
  probeName: string
  enableFloatingIP: boolean
  idleTimeoutInMinutes: number
  loadDistribution: string
  provisioningState: string
}

export type AzureLoadBalancerProbe = {
  name: string
  protocol: string
  port: number
  intervalInSeconds: number
  numberOfProbes: number
  requestPath: string
  provisioningState: string
}

export type AzureLoadBalancerInboundNatRule = {
  name: string
  protocol: string
  frontendPort: number
  backendPort: number
  frontendIPConfigurationName: string
  enableFloatingIP: boolean
  idleTimeoutInMinutes: number
  provisioningState: string
}

export type AzureLoadBalancerDetail = {
  summary: AzureLoadBalancerSummary
  frontendIpConfigurations: AzureLoadBalancerFrontendIp[]
  backendPools: AzureLoadBalancerBackendPool[]
  rules: AzureLoadBalancerRule[]
  probes: AzureLoadBalancerProbe[]
  inboundNatRules: AzureLoadBalancerInboundNatRule[]
}

export type AzurePrivateEndpointSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  privateLinkServiceId: string
  groupIds: string[]
  provisioningState: string
  customDnsConfigs: Array<{ fqdn: string; ipAddresses: string[] }>
}

/* ── Azure Storage enrichment types ───────────────────────── */

export type AzureStorageFileShareSummary = {
  name: string
  quota: number
  accessTier: string
  enabledProtocols: string
  leaseStatus: string
  lastModified: string
  usedCapacityBytes: number
}

export type AzureStorageFileItem = {
  name: string
  isDirectory: boolean
  contentLength: number
  lastModified: string
  path: string
}

export type AzureStorageQueueSummary = {
  name: string
  approximateMessageCount: number
  metadata: Record<string, string>
}

export type AzureStorageQueueMessage = {
  messageId: string
  insertionTime: string
  expirationTime: string
  dequeueCount: number
  messageText: string
}

export type AzureStorageTableSummary = {
  name: string
}

/* ── Azure MySQL types ────────────────────────────────────── */

export type AzureMySqlOperationalTone = 'good' | 'warning' | 'risk' | 'info' | 'neutral'

export type AzureMySqlServerSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  version: string
  fullyQualifiedDomainName: string
  publicNetworkAccess: string
  state: string
  skuName: string
  skuTier: string
  storageSizeGb: number
  haEnabled: boolean
  haState: string
  backupRetentionDays: number
  geoRedundantBackup: string
  availabilityZone: string
  databaseCount: number
  tagCount: number
  notes: string[]
}

export type AzureMySqlDatabaseSummary = {
  id: string
  name: string
  serverName: string
  resourceGroup: string
  charset: string
  collation: string
}

export type AzureMySqlFirewallRule = {
  name: string
  startIpAddress: string
  endIpAddress: string
}

export type AzureMySqlPostureBadge = {
  id: string
  label: string
  value: string
  tone: AzureMySqlOperationalTone
}

export type AzureMySqlSummaryTile = {
  id: string
  label: string
  value: string
  tone: AzureMySqlOperationalTone
}

export type AzureMySqlFinding = {
  id: string
  severity: string
  title: string
  message: string
  recommendation: string
}

export type AzureMySqlEstateOverview = {
  subscriptionId: string
  serverCount: number
  databaseCount: number
  publicServerCount: number
  servers: AzureMySqlServerSummary[]
  databases: AzureMySqlDatabaseSummary[]
  notes: string[]
}

export type AzureMySqlServerDetail = {
  server: AzureMySqlServerSummary
  databases: AzureMySqlDatabaseSummary[]
  firewallRules: AzureMySqlFirewallRule[]
  badges: AzureMySqlPostureBadge[]
  summaryTiles: AzureMySqlSummaryTile[]
  findings: AzureMySqlFinding[]
}

/* ── Azure Cosmos DB types ────────────────────────────────── */

export type AzureCosmosDbAccountSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  kind: string
  databaseAccountOfferType: string
  consistencyLevel: string
  enableAutomaticFailover: boolean
  enableMultipleWriteLocations: boolean
  publicNetworkAccess: string
  isVirtualNetworkFilterEnabled: boolean
  readLocations: string[]
  writeLocations: string[]
  provisioningState: string
  documentEndpoint: string
  tagCount: number
}

export type AzureCosmosDbDatabaseSummary = {
  id: string
  name: string
  accountName: string
  resourceGroup: string
}

export type AzureCosmosDbContainerSummary = {
  id: string
  name: string
  databaseName: string
  partitionKeyPath: string
  defaultTtl: number
  indexingMode: string
  analyticalStorageTtl: number
}

export type AzureCosmosDbEstateOverview = {
  subscriptionId: string
  accountCount: number
  databaseCount: number
  containerCount: number
  accounts: AzureCosmosDbAccountSummary[]
  notes: string[]
}

export type AzureCosmosDbAccountDetail = {
  account: AzureCosmosDbAccountSummary
  databases: AzureCosmosDbDatabaseSummary[]
  containers: AzureCosmosDbContainerSummary[]
}

/* ── Azure App Service / Functions enrichment types ───────── */

export type AzureFunctionAppSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  kind: string
  state: string
  defaultHostName: string
  httpsOnly: boolean
  enabled: boolean
  appServicePlanName: string
  runtimeStack: string
  publicNetworkAccess: string
  provisioningState: string
  lastModifiedTimeUtc: string
  tagCount: number
}

export type AzureFunctionSummary = {
  name: string
  scriptHref: string
  configHref: string
  isDisabled: boolean
  language: string
  bindingCount: number
}

export type AzureWebAppConfigSummary = {
  appSettings: Array<{ name: string; value: string; slotSetting: boolean }>
  connectionStrings: Array<{ name: string; type: string; slotSetting: boolean }>
  linuxFxVersion: string
  netFrameworkVersion: string
  phpVersion: string
  pythonVersion: string
  nodeVersion: string
  javaVersion: string
  http20Enabled: boolean
  minTlsVersion: string
  ftpsState: string
  alwaysOn: boolean
}

export type AzureWebAppAction = 'start' | 'stop' | 'restart'

export type AzureWebAppActionResult = {
  action: string
  siteName: string
  resourceGroup: string
  accepted: boolean
  error?: string
}

/* ── Azure Log Analytics types ────────────────────────────── */

export type AzureLogAnalyticsWorkspaceSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  retentionInDays: number
  dailyQuotaGb: number
  workspaceId: string
  customerId: string
  provisioningState: string
  publicNetworkAccessForIngestion: string
  publicNetworkAccessForQuery: string
  tagCount: number
}

export type AzureLogAnalyticsQueryResult = {
  tables: Array<{
    name: string
    columns: Array<{ name: string; type: string }>
    rows: unknown[][]
  }>
  statistics?: { query?: { executionTime?: number } }
  error?: string
}

export type AzureLogAnalyticsSavedSearch = {
  id: string
  name: string
  category: string
  displayName: string
  query: string
  functionAlias: string
  functionParameters: string
}

export type AzureLogAnalyticsLinkedService = {
  id: string
  name: string
  resourceId: string
  provisioningState: string
}

/* ── Azure Event Grid types ───────────────────────────────── */

export type AzureEventGridTopicSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  provisioningState: string
  endpoint: string
  inputSchema: string
  publicNetworkAccess: string
  tagCount: number
}

export type AzureEventGridSystemTopicSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  source: string
  topicType: string
  provisioningState: string
  metricResourceId: string
}

export type AzureEventGridEventSubscriptionSummary = {
  id: string
  name: string
  topicName: string
  destinationType: string
  destinationEndpoint: string
  provisioningState: string
  eventDeliverySchema: string
  retryMaxDeliveryAttempts: number
  eventTimeToLiveInMinutes: number
  labels: string[]
}

export type AzureEventGridDomainSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  provisioningState: string
  endpoint: string
  inputSchema: string
  publicNetworkAccess: string
  tagCount: number
}

export type AzureEventGridDomainTopicSummary = {
  id: string
  name: string
  provisioningState: string
}

/* ── Azure Firewall types ────────────────────────────────── */

export type AzureFirewallSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  skuTier: string
  threatIntelMode: string
  provisioningState: string
  firewallPolicyId: string
  ipConfigurationCount: number
  networkRuleCollectionCount: number
  applicationRuleCollectionCount: number
  natRuleCollectionCount: number
}

export type AzureFirewallIpConfiguration = {
  name: string
  privateIPAddress: string
  publicIPAddressId: string
  subnetId: string
  provisioningState: string
}

export type AzureFirewallRuleCollection = {
  name: string
  kind: string
  priority: number
  action: string
  ruleCount: number
  provisioningState: string
}

export type AzureFirewallDetail = {
  summary: AzureFirewallSummary
  ipConfigurations: AzureFirewallIpConfiguration[]
  ruleCollections: AzureFirewallRuleCollection[]
}

/* ── Azure Monitor / Log Analytics Extended types ───────── */

export type AzureMetricAlertRuleSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  description: string
  severity: number
  enabled: boolean
  evaluationFrequency: string
  windowSize: string
  targetResourceType: string
  targetResourceRegion: string
  scopes: string[]
  criteriaCount: number
  actionGroupIds: string[]
  lastUpdated: string
}

export type AzureScheduledQueryRuleSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  description: string
  severity: number
  enabled: boolean
  evaluationFrequency: string
  windowSize: string
  scopes: string[]
  criteriaCount: number
  actionGroupIds: string[]
  muteActionsDuration: string
  autoMitigate: boolean
  targetResourceTypes: string[]
  kind: string
  lastUpdated: string
}

export type AzureActionGroupSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  groupShortName: string
  enabled: boolean
  emailReceiverCount: number
  smsReceiverCount: number
  webhookReceiverCount: number
  azureAppPushReceiverCount: number
  automationRunbookReceiverCount: number
  logicAppReceiverCount: number
  azureFunctionReceiverCount: number
  armRoleReceiverCount: number
  totalReceiverCount: number
}

export type AzureMetricDataPoint = {
  timestamp: string
  average?: number
  total?: number
  maximum?: number
  minimum?: number
  count?: number
}

export type AzureMetricTimeSeries = {
  metricName: string
  displayName: string
  unit: string
  dataPoints: AzureMetricDataPoint[]
}

export type AzureMetricQueryResult = {
  resourceId: string
  timespan: string
  interval: string
  aggregation: string
  metrics: AzureMetricTimeSeries[]
}

export type AzureDiagnosticSettingSummary = {
  id: string
  name: string
  storageAccountId: string
  workspaceId: string
  eventHubAuthorizationRuleId: string
  eventHubName: string
  logAnalyticsDestinationType: string
  enabledLogCategories: string[]
  enabledMetricCategories: string[]
  totalLogCategories: number
  totalMetricCategories: number
}

export type AzureLogAnalyticsQueryTemplate = {
  id: string
  name: string
  category: string
  description: string
  query: string
  timespan: string
}

export type AzureLogAnalyticsQueryWithMeta = {
  tables: Array<{
    name: string
    columns: Array<{ name: string; type: string }>
    rows: unknown[][]
  }>
  statistics?: { query?: { executionTime?: number } }
  error?: string
  executionTimeMs: number
  rowCount: number
  truncated: boolean
  visualizationHint: 'table' | 'timechart' | 'barchart' | 'piechart' | 'scalar'
}

export type AzureLogAnalyticsHistoryEntry = {
  id: string
  workspaceId: string
  query: string
  executedAt: string
  success: boolean
  executionTimeMs?: number
  errorMessage?: string
}

export type AzureResourceHealthSummary = {
  id: string
  targetResourceId: string
  resourceGroup: string
  availabilityState: string
  title: string
  summary: string
  reasonType: string
  reasonChronicity: string
  occurredTime: string
  reportedTime: string
  resolutionETA: string
  category: string
}

export type AzureServiceHealthEvent = {
  id: string
  name: string
  eventType: string
  eventSource: string
  status: string
  title: string
  summary: string
  header: string
  level: string
  impactStartTime: string
  impactMitigationTime: string
  impactedServices: Array<{
    serviceName: string
    impactedRegions: string[]
  }>
  lastUpdateTime: string
  isHIR: boolean
  priority: number
}

/* ── Azure Network Topology types ──────────────────────── */

export type AzureApplicationGatewaySummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  skuTier: string
  skuCapacity: number
  provisioningState: string
  operationalState: string
  httpListenerCount: number
  requestRoutingRuleCount: number
  backendPoolCount: number
  backendSettingsCount: number
  frontendIpCount: number
  frontendPortCount: number
  sslCertificateCount: number
  probeCount: number
  wafEnabled: boolean
  zones: string[]
}

export type AzureVpnGatewaySummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  gatewayType: string
  vpnType: string
  vpnGatewayGeneration: string
  skuName: string
  skuTier: string
  enableBgp: boolean
  bgpAsn: number
  activeActive: boolean
  ipConfigurationCount: number
  connectedVNetId: string
  vpnClientAddressPrefixes: string[]
  provisioningState: string
  zones: string[]
}

export type AzureExpressRouteCircuitSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  skuName: string
  skuTier: string
  skuFamily: string
  circuitProvisioningState: string
  serviceProviderProvisioningState: string
  serviceProviderName: string
  peeringLocation: string
  bandwidthInMbps: number
  peeringCount: number
  authorizationCount: number
  allowClassicOperations: boolean
  globalReachEnabled: boolean
  provisioningState: string
}

export type AzurePrivateDnsZoneSummary = {
  id: string
  name: string
  resourceGroup: string
  location: string
  numberOfRecordSets: number
  maxNumberOfRecordSets: number
  numberOfVirtualNetworkLinks: number
  maxNumberOfVirtualNetworkLinks: number
  provisioningState: string
}

export type AzurePrivateDnsVNetLink = {
  id: string
  name: string
  virtualNetworkId: string
  registrationEnabled: boolean
  provisioningState: string
}

export type AzureEffectiveRoute = {
  source: string
  state: string
  addressPrefixes: string[]
  nextHopType: string
  nextHopIpAddress: string[]
  disableBgpRoutePropagation: boolean
}

export type AzureEffectiveNsgRule = {
  nsgId: string
  name: string
  protocol: string
  sourcePortRange: string
  destinationPortRange: string
  sourceAddressPrefixes: string[]
  destinationAddressPrefixes: string[]
  access: 'Allow' | 'Deny'
  priority: number
  direction: 'Inbound' | 'Outbound'
}

export type AzureNetworkTopologyNode = {
  id: string
  name: string
  type:
    | 'vnet'
    | 'subnet'
    | 'nsg'
    | 'publicIp'
    | 'loadBalancer'
    | 'applicationGateway'
    | 'vpnGateway'
    | 'firewall'
    | 'privateEndpoint'
    | 'natGateway'
    | 'expressRoute'
  resourceGroup: string
  location: string
  properties: Record<string, unknown>
}

export type AzureNetworkTopologyEdge = {
  source: string
  target: string
  type:
    | 'contains'
    | 'peering'
    | 'secures'
    | 'routes'
    | 'egress'
    | 'frontend'
    | 'deployed'
    | 'gateway'
    | 'assignedTo'
    | 'privateLink'
  label: string
}

export type AzureNetworkTopologySummary = {
  vnetCount: number
  subnetCount: number
  nsgCount: number
  publicIpCount: number
  loadBalancerCount: number
  applicationGatewayCount: number
  vpnGatewayCount: number
  firewallCount: number
  privateEndpointCount: number
  natGatewayCount: number
  expressRouteCount: number
  peeringCount: number
  totalNodeCount: number
  totalEdgeCount: number
}

export type AzureNetworkTopology = {
  subscriptionId: string
  location: string
  nodes: AzureNetworkTopologyNode[]
  edges: AzureNetworkTopologyEdge[]
  summary: AzureNetworkTopologySummary
}

export type AzureVNetTopologySubnetDetail = {
  id: string
  name: string
  addressPrefix: string
  nsgId: string
  nsgName: string
  routeTableId: string
  routeTableName: string
  natGatewayId: string
  delegations: string[]
  serviceEndpoints: string[]
  privateEndpointCount: number
  connectedNicCount: number
  connectedNics: Array<{
    id: string
    name: string
    privateIp: string
    attachedVmName: string
  }>
}

export type AzureVNetTopologyPeering = {
  id: string
  name: string
  peeringState: string
  remoteVNetId: string
  remoteVNetName: string
  allowVirtualNetworkAccess: boolean
  allowForwardedTraffic: boolean
  allowGatewayTransit: boolean
  useRemoteGateways: boolean
}

export type AzureVNetTopologyDetail = {
  id: string
  name: string
  resourceGroup: string
  location: string
  addressPrefixes: string[]
  dnsServers: string[]
  enableDdosProtection: boolean
  subnets: AzureVNetTopologySubnetDetail[]
  peerings: AzureVNetTopologyPeering[]
  hasGatewaySubnet: boolean
  hasFirewallSubnet: boolean
  totalNicCount: number
  provisioningState: string
}
