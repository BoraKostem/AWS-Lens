// @ts-nocheck
/**
 * Web mode implementation of window.awsLens + window.terraformWorkspace.
 * Replaces Electron's contextBridge/ipcRenderer with fetch calls to /api/rpc.
 * Property names match preload/index.ts exactly — any divergence causes
 * "bridge$1(...).xxx is not a function" runtime errors.
 */

async function rpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args })
  })
  if (!res.ok) throw new Error(`RPC ${channel} failed: HTTP ${res.status}`)
  return res.json()
}

// ── Terminal WebSocket ────────────────────────────────────────────────────────
type TerminalListener = (event: unknown) => void
const terminalListeners = new Map<TerminalListener, (event: MessageEvent) => void>()
let terminalWs: WebSocket | null = null

function getTerminalWs(): WebSocket {
  if (terminalWs && terminalWs.readyState !== WebSocket.CLOSED) return terminalWs
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  terminalWs = new WebSocket(`${proto}://${window.location.host}/api/terminal`)
  return terminalWs
}

function addTerminalListener(listener: TerminalListener): void {
  const ws = getTerminalWs()
  const handler = (event: MessageEvent) => {
    try { listener(JSON.parse(event.data as string)) } catch {/* ignore */}
  }
  terminalListeners.set(listener, handler)
  ws.addEventListener('message', handler)
}
function removeTerminalListener(listener: TerminalListener): void {
  const handler = terminalListeners.get(listener)
  if (handler) {
    try { getTerminalWs().removeEventListener('message', handler) } catch {/* ignore */}
    terminalListeners.delete(listener)
  }
}

// ── Push events WebSocket (/api/events) ──────────────────────────────────────
type PushListener = (event: unknown) => void
const pushListeners = new Map<string, Map<PushListener, (event: MessageEvent) => void>>()
let eventsWs: WebSocket | null = null

function getEventsWs(): WebSocket {
  if (eventsWs && eventsWs.readyState !== WebSocket.CLOSED) return eventsWs
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  eventsWs = new WebSocket(`${proto}://${window.location.host}/api/events`)
  return eventsWs
}

function subscribePush(channel: string, listener: PushListener): void {
  const ws = getEventsWs()
  const handler = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string) as { channel: string; payload: unknown }
      if (msg.channel === channel) listener(msg.payload)
    } catch {/* ignore */}
  }
  if (!pushListeners.has(channel)) pushListeners.set(channel, new Map())
  pushListeners.get(channel)!.set(listener, handler)
  if (ws.readyState === WebSocket.OPEN) {
    ws.addEventListener('message', handler)
  } else {
    ws.addEventListener('open', () => ws.addEventListener('message', handler), { once: true })
  }
}

function unsubscribePush(channel: string, listener: PushListener): void {
  const handler = pushListeners.get(channel)?.get(listener)
  if (handler) {
    try { getEventsWs().removeEventListener('message', handler) } catch {/* ignore */}
    pushListeners.get(channel)!.delete(listener)
  }
}

// ── Bridge object — property names MUST match preload/index.ts exactly ────────
export const webBridge: Window['awsLens'] = {
  // ── Profiles ──────────────────────────────────────────────────────────────
  listProfiles: () => rpc('profiles:list'),
  deleteProfile: (n) => rpc('profiles:delete', n),
  chooseAndImportConfig: () => rpc('profiles:choose-and-import'),
  saveCredentials: (p, k, s) => rpc('profiles:save-credentials', p, k, s),

  // ── Regions / session hub ─────────────────────────────────────────────────
  listRegions: () => rpc('regions:list'),
  getSessionHubState: () => rpc('session-hub:list'),
  saveAssumeRoleTarget: (t) => rpc('session-hub:target:save', t),
  deleteAssumeRoleTarget: (id) => rpc('session-hub:target:delete', id),
  deleteAssumedSession: (id) => rpc('session-hub:session:delete', id),
  assumeRoleSession: (r) => rpc('session-hub:assume', r),
  assumeSavedRoleTarget: (id) => rpc('session-hub:assume-target', id),
  runComparison: (r) => rpc('compare:run', r),

  // ── Services + release ────────────────────────────────────────────────────
  listServices: () => rpc('services:list'),
  getReleaseInfo: () => rpc('app:release-info'),
  // In web mode, open URLs in a new browser tab instead of via Electron shell
  openExternalUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); return Promise.resolve() },

  // ── STS / identity ────────────────────────────────────────────────────────
  getCallerIdentity: (c) => rpc('sts:get-caller-identity', c),
  lookupAccessKeyOwnership: (c, k) => rpc('sts:lookup-access-key', c, k),
  decodeAuthorizationMessage: (c, m) => rpc('sts:decode-auth-message', c, m),
  assumeRole: (c, r) => rpc('sts:assume-role', c, r),

  // ── EC2 ───────────────────────────────────────────────────────────────────
  listEc2Instances: (c) => rpc('ec2:list', c),
  describeEc2Instance: (c, id) => rpc('ec2:describe', c, id),
  listEbsVolumes: (c) => rpc('ec2:list-volumes', c),
  describeEbsVolume: (c, id) => rpc('ec2:describe-volume', c, id),
  runEc2InstanceAction: (c, id, action) => rpc('ec2:action', c, id, action),
  terminateEc2Instance: (c, id) => rpc('ec2:terminate', c, id),
  resizeEc2Instance: (c, id, type) => rpc('ec2:resize', c, id, type),
  listInstanceTypes: (c) => rpc('ec2:list-instance-types', c),
  listEc2Snapshots: (c, id) => rpc('ec2:list-snapshots', c, id),
  createEc2Snapshot: (c, id) => rpc('ec2:create-snapshot', c, id),
  deleteEc2Snapshot: (c, id) => rpc('ec2:delete-snapshot', c, id),
  tagEc2Snapshot: (c, id, tags) => rpc('ec2:tag-snapshot', c, id, tags),
  launchFromSnapshot: (c, cfg) => rpc('ec2:launch-from-snapshot', c, cfg),
  sendSshPublicKey: (c, id, key) => rpc('ec2:send-ssh-public-key', c, id, key),
  getIamAssociation: (c, id) => rpc('ec2:get-iam-association', c, id),
  attachIamProfile: (c, id, arn) => rpc('ec2:attach-iam-profile', c, id, arn),
  replaceIamProfile: (c, id, arn) => rpc('ec2:replace-iam-profile', c, id, arn),
  removeIamProfile: (c, id) => rpc('ec2:remove-iam-profile', c, id),
  launchBastion: (c, cfg) => rpc('ec2:launch-bastion', c, cfg),
  findBastionConnectionsForInstance: (c, id) => rpc('ec2:find-bastion-connections', c, id),
  deleteBastion: (c, id) => rpc('ec2:delete-bastion', c, id),
  listBastions: (c) => rpc('ec2:list-bastions', c),
  listPopularBastionAmis: (c, arch) => rpc('ec2:list-popular-bastion-amis', c, arch),
  createTempVolumeCheck: (c, volumeId) => rpc('ec2:create-temp-volume-check', c, volumeId),
  deleteTempVolumeCheck: (c, id) => rpc('ec2:delete-temp-volume-check', c, id),
  describeVpc: (c, id) => rpc('ec2:describe-vpc', c, id),
  getEc2Recommendations: (c) => rpc('ec2:recommendations', c),
  chooseEc2SshKey: () => rpc('ec2:ssh:choose-key'),

  // EC2 SSM
  listSsmManagedInstances: (c) => rpc('ec2:ssm:list-managed', c),
  getSsmConnectionTarget: (c, id) => rpc('ec2:ssm:target', c, id),
  listSsmSessions: (c) => rpc('ec2:ssm:list-sessions', c),
  startSsmSession: (c, r) => rpc('ec2:ssm:start-session', c, r),
  sendSsmCommand: (c, r) => rpc('ec2:ssm:send-command', c, r),

  // Push events — EC2
  subscribeTempVolumeProgress: (listener) => subscribePush('ec2:temp-volume-progress', listener),
  unsubscribeTempVolumeProgress: (listener) => unsubscribePush('ec2:temp-volume-progress', listener),

  // ── ECR ───────────────────────────────────────────────────────────────────
  listEcrRepositories: (c) => rpc('ecr:list-repos', c),
  listEcrImages: (c, repo) => rpc('ecr:list-images', c, repo),
  createEcrRepository: (c, name, cfg) => rpc('ecr:create-repo', c, name, cfg),
  deleteEcrRepository: (c, name) => rpc('ecr:delete-repo', c, name),
  deleteEcrImage: (c, repo, digest) => rpc('ecr:delete-image', c, repo, digest),
  startEcrImageScan: (c, repo, tag) => rpc('ecr:start-scan', c, repo, tag),
  getEcrScanFindings: (c, repo, tag) => rpc('ecr:scan-findings', c, repo, tag),
  getEcrAuthorizationToken: (c) => rpc('ecr:get-login', c),
  ecrDockerLogin: (c) => rpc('ecr:docker-login', c),
  ecrDockerPull: (c, repo, tag) => rpc('ecr:docker-pull', c, repo, tag),
  ecrDockerPush: (c, repo, tag) => rpc('ecr:docker-push', c, repo, tag),

  // ── ECS ───────────────────────────────────────────────────────────────────
  listEcsClusters: (c) => rpc('ecs:list-clusters', c),
  listEcsServices: (c, cluster) => rpc('ecs:list-services', c, cluster),
  describeEcsService: (c, cluster, svc) => rpc('ecs:describe-service', c, cluster, svc),
  listEcsTasks: (c, cluster, svc) => rpc('ecs:list-tasks', c, cluster, svc),
  stopEcsTask: (c, cluster, task) => rpc('ecs:stop-task', c, cluster, task),
  updateEcsDesiredCount: (c, cluster, svc, count) => rpc('ecs:update-desired-count', c, cluster, svc, count),
  forceEcsRedeploy: (c, cluster, svc) => rpc('ecs:force-redeploy', c, cluster, svc),
  deleteEcsService: (c, cluster, svc) => rpc('ecs:delete-service', c, cluster, svc),
  createEcsFargateService: (c, cfg) => rpc('ecs:create-fargate-service', c, cfg),
  getEcsContainerLogs: (c, cluster, task, container) => rpc('ecs:get-container-logs', c, cluster, task, container),
  getEcsDiagnostics: (c, cluster, svc) => rpc('ecs:get-diagnostics', c, cluster, svc),
  getEcsObservabilityReport: (c, cluster) => rpc('ecs:get-observability-report', c, cluster),

  // ── EKS ───────────────────────────────────────────────────────────────────
  listEksClusters: (c) => rpc('eks:list-clusters', c),
  describeEksCluster: (c, name) => rpc('eks:describe-cluster', c, name),
  listEksNodegroups: (c, name) => rpc('eks:list-nodegroups', c, name),
  updateEksNodegroupScaling: (c, cluster, ng, min, desired, max) => rpc('eks:update-nodegroup-scaling', c, cluster, ng, min, desired, max),
  listEksUpdates: (c, name) => rpc('eks:list-updates', c, name),
  deleteEksCluster: (c, name) => rpc('eks:delete-cluster', c, name),
  addEksToKubeconfig: (c, name, alias) => rpc('eks:add-kubeconfig', c, name, alias),
  launchKubectlTerminal: (c, name) => rpc('eks:launch-kubectl', c, name),
  prepareEksKubectlSession: (c, name) => rpc('eks:prepare-kubectl-session', c, name),
  runEksCommand: (c, cluster, kubeconfig, cmd) => rpc('eks:run-command', c, cluster, kubeconfig, cmd),
  getEksObservabilityReport: (c, name) => rpc('eks:get-observability-report', c, name),

  // ── ELBv2 ─────────────────────────────────────────────────────────────────
  listLoadBalancerWorkspaces: (c) => rpc('elbv2:list-workspaces', c),
  deleteLoadBalancer: (c, arn) => rpc('elbv2:delete-load-balancer', c, arn),

  // ── Overview ──────────────────────────────────────────────────────────────
  getOverviewMetrics: (c) => rpc('overview:metrics', c),
  getOverviewStatistics: (c) => rpc('overview:statistics', c),
  getCostBreakdown: (c) => rpc('overview:cost-breakdown', c),
  getRelationshipMap: (c) => rpc('overview:relationships', c),
  searchByTag: (c, q) => rpc('overview:search-tags', c, q),

  // ── Security groups ────────────────────────────────────────────────────────
  listSecurityGroups: (c) => rpc('sg:list', c),
  describeSecurityGroup: (c, id) => rpc('sg:describe', c, id),
  addInboundRule: (c, id, rule) => rpc('sg:add-inbound', c, id, rule),
  revokeInboundRule: (c, id, rule) => rpc('sg:revoke-inbound', c, id, rule),
  addOutboundRule: (c, id, rule) => rpc('sg:add-outbound', c, id, rule),
  revokeOutboundRule: (c, id, rule) => rpc('sg:revoke-outbound', c, id, rule),

  // ── VPC ───────────────────────────────────────────────────────────────────
  listVpcs: (c) => rpc('vpc:list', c),
  listSubnets: (c, vpcId) => rpc('vpc:subnets', c, vpcId),
  listRouteTables: (c, vpcId) => rpc('vpc:route-tables', c, vpcId),
  listInternetGateways: (c, vpcId) => rpc('vpc:internet-gateways', c, vpcId),
  listNatGateways: (c, vpcId) => rpc('vpc:nat-gateways', c, vpcId),
  listNetworkInterfaces: (c, vpcId) => rpc('vpc:network-interfaces', c, vpcId),
  listTransitGateways: (c) => rpc('vpc:transit-gateways', c),
  listSecurityGroupsForVpc: (c, vpcId) => rpc('vpc:security-groups', c, vpcId),
  getVpcTopology: (c, vpcId) => rpc('vpc:topology', c, vpcId),
  getVpcFlowDiagram: (c, vpcId) => rpc('vpc:flow-diagram', c, vpcId),
  updateSubnetPublicIp: (c, id, enable) => rpc('vpc:subnet-update-public-ip', c, id, enable),
  createReachabilityPath: (c, src, dst) => rpc('vpc:reachability-create', c, src, dst),
  getReachabilityAnalysis: (c, pathId) => rpc('vpc:reachability-get', c, pathId),
  deleteReachabilityAnalysis: (c, id) => rpc('vpc:reachability-delete-analysis', c, id),
  deleteReachabilityPath: (c, id) => rpc('vpc:reachability-delete-path', c, id),

  // ── Compliance ────────────────────────────────────────────────────────────
  getComplianceReport: (c) => rpc('compliance:report', c),

  // ── IAM ───────────────────────────────────────────────────────────────────
  getIamAccountSummary: (c) => rpc('iam:account-summary', c),
  listIamUsers: (c) => rpc('iam:list-users', c),
  createIamUser: (c, u) => rpc('iam:create-user', c, u),
  deleteIamUser: (c, u) => rpc('iam:delete-user', c, u),
  listIamUserGroups: (c, u) => rpc('iam:list-user-groups', c, u),
  addIamUserToGroup: (c, u, g) => rpc('iam:add-user-to-group', c, u, g),
  removeIamUserFromGroup: (c, u, g) => rpc('iam:remove-user-from-group', c, u, g),
  createIamLoginProfile: (c, u, pw, reset) => rpc('iam:create-login-profile', c, u, pw, reset),
  deleteIamLoginProfile: (c, u) => rpc('iam:delete-login-profile', c, u),
  listIamAccessKeys: (c, u) => rpc('iam:list-access-keys', c, u),
  createIamAccessKey: (c, u) => rpc('iam:create-access-key', c, u),
  deleteIamAccessKey: (c, u, k) => rpc('iam:delete-access-key', c, u, k),
  updateIamAccessKeyStatus: (c, u, k, s) => rpc('iam:update-access-key-status', c, u, k, s),
  listIamMfaDevices: (c, u) => rpc('iam:list-mfa-devices', c, u),
  deleteIamMfaDevice: (c, u, sn) => rpc('iam:delete-mfa-device', c, u, sn),
  listAttachedIamUserPolicies: (c, u) => rpc('iam:list-attached-user-policies', c, u),
  listIamUserInlinePolicies: (c, u) => rpc('iam:list-user-inline-policies', c, u),
  attachIamUserPolicy: (c, u, arn) => rpc('iam:attach-user-policy', c, u, arn),
  detachIamUserPolicy: (c, u, arn) => rpc('iam:detach-user-policy', c, u, arn),
  putIamUserInlinePolicy: (c, u, n, d) => rpc('iam:put-user-inline-policy', c, u, n, d),
  deleteIamUserInlinePolicy: (c, u, n) => rpc('iam:delete-user-inline-policy', c, u, n),
  listIamGroups: (c) => rpc('iam:list-groups', c),
  createIamGroup: (c, g) => rpc('iam:create-group', c, g),
  deleteIamGroup: (c, g) => rpc('iam:delete-group', c, g),
  listAttachedIamGroupPolicies: (c, g) => rpc('iam:list-attached-group-policies', c, g),
  attachIamGroupPolicy: (c, g, arn) => rpc('iam:attach-group-policy', c, g, arn),
  detachIamGroupPolicy: (c, g, arn) => rpc('iam:detach-group-policy', c, g, arn),
  listIamRoles: (c) => rpc('iam:list-roles', c),
  createIamRole: (c, name, tp, desc) => rpc('iam:create-role', c, name, tp, desc),
  deleteIamRole: (c, name) => rpc('iam:delete-role', c, name),
  listAttachedIamRolePolicies: (c, r) => rpc('iam:list-attached-role-policies', c, r),
  attachIamRolePolicy: (c, r, arn) => rpc('iam:attach-role-policy', c, r, arn),
  detachIamRolePolicy: (c, r, arn) => rpc('iam:detach-role-policy', c, r, arn),
  listIamRoleInlinePolicies: (c, r) => rpc('iam:list-role-inline-policies', c, r),
  putIamRoleInlinePolicy: (c, r, n, d) => rpc('iam:put-role-inline-policy', c, r, n, d),
  deleteIamRoleInlinePolicy: (c, r, n) => rpc('iam:delete-role-inline-policy', c, r, n),
  getIamRoleTrustPolicy: (c, r) => rpc('iam:get-role-trust-policy', c, r),
  updateIamRoleTrustPolicy: (c, r, d) => rpc('iam:update-role-trust-policy', c, r, d),
  listIamPolicies: (c, scope) => rpc('iam:list-policies', c, scope),
  getIamPolicyVersion: (c, arn, v) => rpc('iam:get-policy-version', c, arn, v),
  listIamPolicyVersions: (c, arn) => rpc('iam:list-policy-versions', c, arn),
  createIamPolicyVersion: (c, arn, doc, set) => rpc('iam:create-policy-version', c, arn, doc, set),
  deleteIamPolicyVersion: (c, arn, v) => rpc('iam:delete-policy-version', c, arn, v),
  createIamPolicy: (c, n, doc, desc) => rpc('iam:create-policy', c, n, doc, desc),
  deleteIamPolicy: (c, arn) => rpc('iam:delete-policy', c, arn),
  simulateIamPolicy: (c, arn, actions, resources) => rpc('iam:simulate-policy', c, arn, actions, resources),
  generateIamCredentialReport: (c) => rpc('iam:generate-credential-report', c),
  getIamCredentialReport: (c) => rpc('iam:get-credential-report', c),

  // ── Key Pairs ─────────────────────────────────────────────────────────────
  listKeyPairs: (c) => rpc('key-pairs:list', c),
  createKeyPair: (c, name) => rpc('key-pairs:create', c, name),
  deleteKeyPair: (c, name) => rpc('key-pairs:delete', c, name),

  // ── KMS ───────────────────────────────────────────────────────────────────
  listKmsKeys: (c) => rpc('kms:list-keys', c),
  describeKmsKey: (c, id) => rpc('kms:describe-key', c, id),
  decryptCiphertext: (c, keyId, ciphertext) => rpc('kms:decrypt', c, keyId, ciphertext),

  // ── Lambda ────────────────────────────────────────────────────────────────
  listLambdaFunctions: (c) => rpc('lambda:list-functions', c),
  getLambdaFunction: (c, name) => rpc('lambda:get-function', c, name),
  getLambdaFunctionCode: (c, name) => rpc('lambda:get-code', c, name),
  invokeLambdaFunction: (c, name, payload) => rpc('lambda:invoke', c, name, payload),
  createLambdaFunction: (c, cfg) => rpc('lambda:create', c, cfg),
  deleteLambdaFunction: (c, name) => rpc('lambda:delete', c, name),

  // ── RDS ───────────────────────────────────────────────────────────────────
  listRdsInstances: (c) => rpc('rds:list-instances', c),
  describeRdsInstance: (c, id) => rpc('rds:describe-instance', c, id),
  startRdsInstance: (c, id) => rpc('rds:start-instance', c, id),
  stopRdsInstance: (c, id) => rpc('rds:stop-instance', c, id),
  rebootRdsInstance: (c, id) => rpc('rds:reboot-instance', c, id),
  resizeRdsInstance: (c, id, cls) => rpc('rds:resize-instance', c, id, cls),
  createRdsSnapshot: (c, id, snapshotId) => rpc('rds:create-snapshot', c, id, snapshotId),
  listRdsClusters: (c) => rpc('rds:list-clusters', c),
  describeRdsCluster: (c, id) => rpc('rds:describe-cluster', c, id),
  startRdsCluster: (c, id) => rpc('rds:start-cluster', c, id),
  stopRdsCluster: (c, id) => rpc('rds:stop-cluster', c, id),
  failoverRdsCluster: (c, id) => rpc('rds:failover-cluster', c, id),
  createRdsClusterSnapshot: (c, id, snapshotId) => rpc('rds:create-cluster-snapshot', c, id, snapshotId),

  // ── Route53 ───────────────────────────────────────────────────────────────
  listRoute53HostedZones: (c) => rpc('route53:hosted-zones', c),
  listRoute53Records: (c, zoneId) => rpc('route53:records', c, zoneId),
  upsertRoute53Record: (c, zoneId, change) => rpc('route53:upsert-record', c, zoneId, change),
  deleteRoute53Record: (c, zoneId, change) => rpc('route53:delete-record', c, zoneId, change),

  // ── S3 ────────────────────────────────────────────────────────────────────
  listS3Buckets: (c) => rpc('s3:list-buckets', c),
  listS3Governance: (c) => rpc('s3:list-governance', c),
  getS3GovernanceDetail: (c, bucket) => rpc('s3:get-governance-detail', c, bucket),
  listS3Objects: (c, bucket, prefix) => rpc('s3:list-objects', c, bucket, prefix),
  createS3Bucket: (c, name, region) => rpc('s3:create-bucket', c, name, region),
  deleteS3Object: (c, bucket, key) => rpc('s3:delete-object', c, bucket, key),
  getS3PresignedUrl: (c, bucket, key) => rpc('s3:presigned-url', c, bucket, key),
  createS3Folder: (c, bucket, prefix) => rpc('s3:create-folder', c, bucket, prefix),
  downloadS3Object: (c, bucket, key) => rpc('s3:download-object', c, bucket, key),
  downloadS3ObjectTo: (c, bucket, key, dest) => rpc('s3:download-object-to', c, bucket, key, dest),
  openS3Object: (c, bucket, key) => rpc('s3:open-object', c, bucket, key),
  openS3InVSCode: (c, bucket, prefix) => rpc('s3:open-in-vscode', c, bucket, prefix),
  getS3ObjectContent: (c, bucket, key) => rpc('s3:get-object-content', c, bucket, key),
  putS3ObjectContent: (c, bucket, key, body) => rpc('s3:put-object-content', c, bucket, key, body),
  uploadS3Object: (c, bucket, key, filePath) => rpc('s3:upload-object', c, bucket, key, filePath),
  enableS3BucketVersioning: (c, bucket) => rpc('s3:enable-versioning', c, bucket),
  enableS3BucketEncryption: (c, bucket) => rpc('s3:enable-encryption', c, bucket),
  putS3BucketPolicy: (c, bucket, policy) => rpc('s3:put-policy', c, bucket, policy),

  // ── Secrets Manager ───────────────────────────────────────────────────────
  listSecrets: (c) => rpc('secrets:list', c),
  describeSecret: (c, id) => rpc('secrets:describe', c, id),
  getSecretDependencyReport: (c, id) => rpc('secrets:dependency-report', c, id),
  getSecretValue: (c, id) => rpc('secrets:get-value', c, id),
  createSecret: (c, input) => rpc('secrets:create', c, input),
  deleteSecret: (c, id) => rpc('secrets:delete', c, id),
  restoreSecret: (c, id) => rpc('secrets:restore', c, id),
  updateSecretValue: (c, id, value) => rpc('secrets:update-value', c, id, value),
  updateSecretDescription: (c, id, desc) => rpc('secrets:update-description', c, id, desc),
  rotateSecret: (c, id) => rpc('secrets:rotate', c, id),
  putSecretResourcePolicy: (c, id, policy) => rpc('secrets:put-policy', c, id, policy),
  tagSecret: (c, id, tags) => rpc('secrets:tag', c, id, tags),
  untagSecret: (c, id, keys) => rpc('secrets:untag', c, id, keys),

  // ── SNS ───────────────────────────────────────────────────────────────────
  listSnsTopics: (c) => rpc('sns:list-topics', c),
  getSnsTopic: (c, arn) => rpc('sns:get-topic', c, arn),
  createSnsTopic: (c, name) => rpc('sns:create-topic', c, name),
  deleteSnsTopic: (c, arn) => rpc('sns:delete-topic', c, arn),
  setSnsTopicAttribute: (c, arn, attr, value) => rpc('sns:set-attribute', c, arn, attr, value),
  listSnsSubscriptions: (c, arn) => rpc('sns:list-subscriptions', c, arn),
  snsSubscribe: (c, arn, proto, endpoint) => rpc('sns:subscribe', c, arn, proto, endpoint),
  snsUnsubscribe: (c, sub) => rpc('sns:unsubscribe', c, sub),
  snsPublish: (c, arn, msg, subject) => rpc('sns:publish', c, arn, msg, subject),
  tagSnsTopic: (c, arn, tags) => rpc('sns:tag', c, arn, tags),
  untagSnsTopic: (c, arn, keys) => rpc('sns:untag', c, arn, keys),

  // ── SQS ───────────────────────────────────────────────────────────────────
  listSqsQueues: (c) => rpc('sqs:list-queues', c),
  getSqsQueue: (c, url) => rpc('sqs:get-queue', c, url),
  createSqsQueue: (c, name, attrs) => rpc('sqs:create-queue', c, name, attrs),
  deleteSqsQueue: (c, url) => rpc('sqs:delete-queue', c, url),
  purgeSqsQueue: (c, url) => rpc('sqs:purge-queue', c, url),
  setSqsAttributes: (c, url, attrs) => rpc('sqs:set-attributes', c, url, attrs),
  sqsSendMessage: (c, url, body, attrs) => rpc('sqs:send-message', c, url, body, attrs),
  sqsReceiveMessages: (c, url, max) => rpc('sqs:receive-messages', c, url, max),
  sqsDeleteMessage: (c, url, handle) => rpc('sqs:delete-message', c, url, handle),
  sqsChangeVisibility: (c, url, handle, timeout) => rpc('sqs:change-visibility', c, url, handle, timeout),
  tagSqsQueue: (c, url, tags) => rpc('sqs:tag', c, url, tags),
  untagSqsQueue: (c, url, keys) => rpc('sqs:untag', c, url, keys),
  sqsTimeline: (c, url) => rpc('sqs:timeline', c, url),

  // ── ACM ───────────────────────────────────────────────────────────────────
  listAcmCertificates: (c) => rpc('acm:list-certificates', c),
  describeAcmCertificate: (c, arn) => rpc('acm:describe-certificate', c, arn),
  requestAcmCertificate: (c, input) => rpc('acm:request-certificate', c, input),
  deleteAcmCertificate: (c, arn) => rpc('acm:delete-certificate', c, arn),

  // ── Auto Scaling ──────────────────────────────────────────────────────────
  listAutoScalingGroups: (c) => rpc('auto-scaling:list-groups', c),
  listAutoScalingInstances: (c, group) => rpc('auto-scaling:list-instances', c, group),
  updateAutoScalingCapacity: (c, group, min, max, desired) => rpc('auto-scaling:update-capacity', c, group, min, max, desired),
  startAutoScalingRefresh: (c, group) => rpc('auto-scaling:start-refresh', c, group),
  deleteAutoScalingGroup: (c, group) => rpc('auto-scaling:delete-group', c, group),

  // ── CloudFormation ────────────────────────────────────────────────────────
  listCloudFormationStacks: (c) => rpc('cloudformation:list-stacks', c),
  listCloudFormationStackResources: (c, stack) => rpc('cloudformation:list-stack-resources', c, stack),
  listCloudFormationChangeSets: (c, stack) => rpc('cloudformation:list-change-sets', c, stack),
  createCloudFormationChangeSet: (c, stack, cfg) => rpc('cloudformation:create-change-set', c, stack, cfg),
  getCloudFormationChangeSetDetail: (c, stack, name) => rpc('cloudformation:get-change-set-detail', c, stack, name),
  executeCloudFormationChangeSet: (c, stack, name) => rpc('cloudformation:execute-change-set', c, stack, name),
  deleteCloudFormationChangeSet: (c, stack, name) => rpc('cloudformation:delete-change-set', c, stack, name),
  startCloudFormationDriftDetection: (c, stack) => rpc('cloudformation:start-drift-detection', c, stack),
  getCloudFormationDriftSummary: (c, stack) => rpc('cloudformation:get-drift-summary', c, stack),
  getCloudFormationDriftDetectionStatus: (c, stack, id) => rpc('cloudformation:get-drift-detection-status', c, stack, id),

  // ── CloudTrail ────────────────────────────────────────────────────────────
  listTrails: (c) => rpc('cloudtrail:list-trails', c),
  lookupCloudTrailEvents: (c, trailArn, filter) => rpc('cloudtrail:lookup-events', c, trailArn, filter),
  lookupCloudTrailEventsByResource: (c, resourceArn) => rpc('cloudtrail:lookup-events-by-resource', c, resourceArn),

  // ── CloudWatch ────────────────────────────────────────────────────────────
  listCloudWatchMetrics: (c, namespace) => rpc('cloudwatch:metrics', c, namespace),
  getEc2MetricSeries: (c, id, metric) => rpc('cloudwatch:ec2-series', c, id, metric),
  listCloudWatchLogGroups: (c) => rpc('cloudwatch:log-groups', c),
  listCloudWatchRecentEvents: (c, group, stream) => rpc('cloudwatch:recent-events', c, group, stream),
  listEc2InstanceMetrics: (c, id) => rpc('cloudwatch:ec2-instance-metrics', c, id),
  getMetricStatistics: (c, req) => rpc('cloudwatch:metric-stats', c, req),
  getEc2AllMetricSeries: (c) => rpc('cloudwatch:ec2-all-series', c),

  // ── SSO / Identity Center ─────────────────────────────────────────────────
  listSsoInstances: (c) => rpc('sso:list-instances', c),
  createSsoInstance: (c, cfg) => rpc('sso:create-instance', c, cfg),
  deleteSsoInstance: (c, id) => rpc('sso:delete-instance', c, id),
  listSsoPermissionSets: (c, instanceArn) => rpc('sso:list-permission-sets', c, instanceArn),
  listSsoAccountAssignments: (c, instanceArn, permSetArn) => rpc('sso:list-account-assignments', c, instanceArn, permSetArn),
  listSsoUsers: (c, identityStoreId) => rpc('sso:list-users', c, identityStoreId),
  listSsoGroups: (c, identityStoreId) => rpc('sso:list-groups', c, identityStoreId),
  simulateSsoPermissions: (c, req) => rpc('sso:simulate-permissions', c, req),

  // ── WAF ───────────────────────────────────────────────────────────────────
  listWebAcls: (c, scope) => rpc('waf:list-web-acls', c, scope),
  describeWebAcl: (c, id, name, scope) => rpc('waf:describe-web-acl', c, id, name, scope),
  createWebAcl: (c, cfg) => rpc('waf:create-web-acl', c, cfg),
  deleteWebAcl: (c, id, name, scope, lockToken) => rpc('waf:delete-web-acl', c, id, name, scope, lockToken),
  addWafRule: (c, aclId, aclName, scope, lockToken, rule) => rpc('waf:add-rule', c, aclId, aclName, scope, lockToken, rule),
  updateWafRulesJson: (c, aclId, aclName, scope, lockToken, rules) => rpc('waf:update-rules-json', c, aclId, aclName, scope, lockToken, rules),
  deleteWafRule: (c, aclId, aclName, scope, lockToken, ruleName) => rpc('waf:delete-rule', c, aclId, aclName, scope, lockToken, ruleName),
  associateWebAcl: (c, aclArn, resourceArn) => rpc('waf:associate-resource', c, aclArn, resourceArn),
  disassociateWebAcl: (c, resourceArn) => rpc('waf:disassociate-resource', c, resourceArn),

  // ── Terminal (WebSocket-backed) ────────────────────────────────────────────
  openAwsTerminal: (connection, initialCommand?) => {
    const ws = getTerminalWs()
    const send = () => {
      // Pass connection so the server injects AWS env vars + context command,
      // matching the behaviour of terminalIpc.ts createSession()
      ws.send(JSON.stringify({ type: 'open', connection, initialCommand, cols: 120, rows: 24 }))
    }
    if (ws.readyState === WebSocket.OPEN) send()
    else ws.addEventListener('open', send, { once: true })
    return Promise.resolve()
  },
  updateAwsTerminalContext: (connection) => {
    getTerminalWs().send(JSON.stringify({ type: 'update-context', connection }))
    return Promise.resolve()
  },
  sendTerminalInput: (input) => { getTerminalWs().send(JSON.stringify({ type: 'input', data: input })); return Promise.resolve() },
  runTerminalCommand: (cmd) => { getTerminalWs().send(JSON.stringify({ type: 'run-command', command: cmd })); return Promise.resolve() },
  resizeTerminal: (cols, rows) => { getTerminalWs().send(JSON.stringify({ type: 'resize', cols, rows })); return Promise.resolve() },
  closeTerminal: () => {
    if (terminalWs) { terminalWs.send(JSON.stringify({ type: 'close' })); terminalWs = null }
    return Promise.resolve()
  },
  onTerminalEvent: (listener) => addTerminalListener(listener),
  offTerminalEvent: (listener) => removeTerminalListener(listener),
  subscribeTerminal: (listener) => addTerminalListener(listener),
  unsubscribeTerminal: (listener) => removeTerminalListener(listener),

  // ── Desktop-only stubs (no-ops in web mode) ───────────────────────────────
  showItemInFolder: (_path) => Promise.resolve(),
  chooseDirectory: () => Promise.resolve({ canceled: true, path: undefined }),
}

// ── terraformWorkspace bridge — short names matching preload ──────────────────
// window.terraformWorkspace is assigned this object in main.tsx.
// Property names must match preload/index.ts contextBridge.exposeInMainWorld('terraformWorkspace', ...)
export const terraformBridge = {
  detectCli: () => rpc('terraform:cli:detect'),
  getCliInfo: () => rpc('terraform:cli:info'),
  listProjects: (p, c) => rpc('terraform:projects:list', p, c),
  getProject: (p, id, c) => rpc('terraform:projects:get', p, id, c),
  getDrift: (p, id, c, opts) => rpc('terraform:drift:get', p, id, c, opts),
  getObservabilityReport: (p, id, c) => rpc('terraform:observability-report:get', p, id, c),
  chooseProjectDirectory: () => rpc('terraform:projects:choose-directory'),
  chooseVarFile: () => rpc('terraform:projects:choose-file'),
  addProject: (p, path, c) => rpc('terraform:projects:add', p, path, c),
  renameProject: (p, id, name) => rpc('terraform:projects:rename', p, id, name),
  openProjectInVsCode: (path) => rpc('terraform:projects:open-vscode', path),
  removeProject: (p, id) => rpc('terraform:projects:remove', p, id),
  reloadProject: (p, id, c) => rpc('terraform:projects:reload', p, id, c),
  selectWorkspace: (p, id, ws, c) => rpc('terraform:workspace:select', p, id, ws, c),
  createWorkspace: (p, id, ws, c) => rpc('terraform:workspace:create', p, id, ws, c),
  deleteWorkspace: (p, id, ws, c) => rpc('terraform:workspace:delete', p, id, ws, c),
  getSelectedProjectId: (p) => rpc('terraform:projects:selected:get', p),
  setSelectedProjectId: (p, id) => rpc('terraform:projects:selected:set', p, id),
  updateInputs: (p, id, cfg, c) => rpc('terraform:inputs:update', p, id, cfg, c),
  getMissingRequiredInputs: (p, id) => rpc('terraform:inputs:missing-required', p, id),
  validateProjectInputs: (p, id, c) => rpc('terraform:inputs:validate', p, id, c),
  listCommandLogs: (id) => rpc('terraform:logs:list', id),
  runCommand: (req) => rpc('terraform:command:run', req),
  hasSavedPlan: (id) => rpc('terraform:plan:has-saved', id),
  clearSavedPlan: (id) => rpc('terraform:plan:clear', id),
  detectMissingVars: (output) => rpc('terraform:detect-missing-vars', output),
  listRunHistory: (filter) => rpc('terraform:history:list', filter),
  getRunOutput: (runId) => rpc('terraform:history:get-output', runId),
  deleteRunRecord: (runId) => rpc('terraform:history:delete', runId),
  detectGovernanceTools: (path) => rpc('terraform:governance:detect-tools', path),
  getGovernanceToolkit: () => rpc('terraform:governance:toolkit'),
  runGovernanceChecks: (p, id, c) => rpc('terraform:governance:run-checks', p, id, c),
  getGovernanceReport: (id) => rpc('terraform:governance:get-report', id),
  subscribe: (listener) => subscribePush('terraform:event', listener),
  unsubscribe: (listener) => unsubscribePush('terraform:event', listener),
}
