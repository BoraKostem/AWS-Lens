// @ts-nocheck
/**
 * Web mode implementation of window.awsLens.
 * Replaces Electron's contextBridge/ipcRenderer with fetch calls to /api/rpc.
 * Injected into window.awsLens at startup when running in browser (not Electron).
 *
 * Channel names match the actual ipcMain.handle() registrations exactly.
 */

async function rpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args })
  })

  if (!res.ok) {
    throw new Error(`RPC ${channel} failed: HTTP ${res.status}`)
  }

  return res.json()
}

// Terminal event listeners — bridged via WebSocket in web mode
type TerminalListener = (event: unknown) => void
const terminalListeners = new Map<TerminalListener, (event: MessageEvent) => void>()
let terminalWs: WebSocket | null = null

function getTerminalWs(): WebSocket {
  if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
    return terminalWs
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  terminalWs = new WebSocket(`${proto}://${window.location.host}/api/terminal`)
  return terminalWs
}

// Build a proxy that maps every Window['awsLens'] method to rpc() by
// inspecting the method name → channel name mapping below.
// All methods are defined explicitly so TypeScript stays happy.

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

  // ── Services + release ────────────────────────────────────────────────────
  listServices: () => rpc('services:list'),
  getReleaseInfo: () => rpc('app:release-info'),
  openExternalUrl: (url) => rpc('shell:open-external', url),

  // ── STS / identity ────────────────────────────────────────────────────────
  getCallerIdentity: (c) => rpc('sts:get-caller-identity', c),
  lookupAccessKey: (c, k) => rpc('sts:lookup-access-key', c, k),
  decodeAuthorizationMessage: (c, m) => rpc('sts:decode-auth-message', c, m),
  assumeRole: (c, r) => rpc('sts:assume-role', c, r),

  // ── EC2 ───────────────────────────────────────────────────────────────────
  listEc2Instances: (c) => rpc('ec2:list', c),
  describeEc2Instance: (c, id) => rpc('ec2:describe', c, id),
  listEbsVolumes: (c) => rpc('ec2:list-volumes', c),
  describeEbsVolume: (c, id) => rpc('ec2:describe-volume', c, id),
  runEc2InstanceAction: (c, id, action) => rpc('ec2:resize', c, id, action),
  terminateInstance: (c, id) => rpc('ec2:terminate', c, id),
  describeVpc: (c, id) => rpc('ec2:describe-vpc', c, id),
  getEc2Recommendations: (c) => rpc('ec2:recommendations', c),
  listInstanceTypes: (c) => rpc('ec2:list-instance-types', c),
  listSnapshots: (c, id) => rpc('ec2:list-snapshots', c, id),
  createSnapshot: (c, id) => rpc('ec2:create-snapshot', c, id),
  deleteSnapshot: (c, id) => rpc('ec2:delete-snapshot', c, id),
  launchInstanceFromSnapshot: (c, cfg) => rpc('ec2:launch-from-snapshot', c, cfg),
  getEc2IamAssociation: (c, id) => rpc('ec2:get-iam-association', c, id),
  removeEc2IamProfile: (c, id) => rpc('ec2:remove-iam-profile', c, id),
  launchBastionInstance: (c, cfg) => rpc('ec2:launch-bastion', c, cfg),
  deleteBastionInstance: (c, id) => rpc('ec2:delete-bastion', c, id),
  listBastionInstances: (c) => rpc('ec2:list-bastions', c),
  findBastionConnections: (c, id) => rpc('ec2:find-bastion-connections', c, id),
  listPopularBastionAmis: (c) => rpc('ec2:list-popular-bastion-amis', c),
  createTempVolumeCheck: (c, cfg) => rpc('ec2:create-temp-volume-check', c, cfg),
  deleteTempVolumeCheck: (c, id) => rpc('ec2:delete-temp-volume-check', c, id),
  chooseEc2SshKey: () => rpc('ec2:ssh:choose-key'),

  // EC2 SSM
  listSsmManagedInstances: (c) => rpc('ec2:ssm:list-managed', c),
  listSsmSessions: (c) => rpc('ec2:ssm:list-sessions', c),
  getSsmTarget: (c, id) => rpc('ec2:ssm:target', c, id),
  sendSsmCommand: (c, r) => rpc('ec2:ssm:send-command', c, r),
  startSsmSession: (c, r) => rpc('ec2:ssm:start-session', c, r),

  // ── ECR ───────────────────────────────────────────────────────────────────
  listEcrRepositories: (c) => rpc('ecr:list-repos', c),
  listEcrImages: (c, repo) => rpc('ecr:list-images', c, repo),
  getEcrLoginPassword: (c) => rpc('ecr:get-login', c),
  dockerLoginEcr: (c) => rpc('ecr:docker-login', c),
  dockerPullEcr: (c, repo, tag) => rpc('ecr:docker-pull', c, repo, tag),

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
  updateEksNodegroupScaling: (c, cluster, ng, min, desired, max) =>
    rpc('eks:update-nodegroup-scaling', c, cluster, ng, min, desired, max),
  listEksUpdates: (c, name) => rpc('eks:list-updates', c, name),
  deleteEksCluster: (c, name) => rpc('eks:delete-cluster', c, name),
  launchEksKubectl: (c, name) => rpc('eks:launch-kubectl', c, name),
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
  getOverviewRelationships: (c) => rpc('overview:relationships', c),
  searchOverviewTags: (c, q) => rpc('overview:search-tags', c, q),

  // ── Security groups ────────────────────────────────────────────────────────
  listSecurityGroups: (c) => rpc('sg:list', c),
  describeSecurityGroup: (c, id) => rpc('sg:describe', c, id),

  // ── VPC ───────────────────────────────────────────────────────────────────
  listVpcs: (c) => rpc('vpc:list', c),
  listSubnets: (c, vpcId) => rpc('vpc:subnets', c, vpcId),
  listRouteTables: (c, vpcId) => rpc('vpc:route-tables', c, vpcId),
  listInternetGateways: (c, vpcId) => rpc('vpc:internet-gateways', c, vpcId),
  listNatGateways: (c, vpcId) => rpc('vpc:nat-gateways', c, vpcId),
  listNetworkInterfaces: (c, vpcId) => rpc('vpc:network-interfaces', c, vpcId),
  listTransitGateways: (c) => rpc('vpc:transit-gateways', c),
  getVpcTopology: (c, vpcId) => rpc('vpc:topology', c, vpcId),
  getVpcFlowDiagram: (c, vpcId) => rpc('vpc:flow-diagram', c, vpcId),
  listVpcSecurityGroups: (c, vpcId) => rpc('vpc:security-groups', c, vpcId),
  updateSubnetPublicIp: (c, id, enable) => rpc('vpc:subnet-update-public-ip', c, id, enable),
  createReachabilityPath: (c, src, dst) => rpc('vpc:reachability-create', c, src, dst),
  getReachabilityPath: (c, pathId) => rpc('vpc:reachability-get', c, pathId),
  deleteReachabilityAnalysis: (c, id) => rpc('vpc:reachability-delete-analysis', c, id),
  deleteReachabilityPath: (c, id) => rpc('vpc:reachability-delete-path', c, id),

  // ── Compare ───────────────────────────────────────────────────────────────
  runComparison: (r) => rpc('compare:run', r),

  // ── Compliance ────────────────────────────────────────────────────────────
  getComplianceReport: (c) => rpc('compliance:report', c),

  // ── IAM ───────────────────────────────────────────────────────────────────
  getIamAccountSummary: (c) => rpc('iam:account-summary', c),
  listIamUsers: (c) => rpc('iam:list-users', c),
  createIamUser: (c, u) => rpc('iam:create-user', c, u),
  deleteIamUser: (c, u) => rpc('iam:delete-user', c, u),
  listUserGroups: (c, u) => rpc('iam:list-user-groups', c, u),
  addUserToGroup: (c, u, g) => rpc('iam:add-user-to-group', c, u, g),
  removeUserFromGroup: (c, u, g) => rpc('iam:remove-user-from-group', c, u, g),
  createLoginProfile: (c, u, pw, reset) => rpc('iam:create-login-profile', c, u, pw, reset),
  deleteLoginProfile: (c, u) => rpc('iam:delete-login-profile', c, u),
  listUserAccessKeys: (c, u) => rpc('iam:list-access-keys', c, u),
  createAccessKey: (c, u) => rpc('iam:create-access-key', c, u),
  deleteAccessKey: (c, u, k) => rpc('iam:delete-access-key', c, u, k),
  updateAccessKeyStatus: (c, u, k, s) => rpc('iam:update-access-key-status', c, u, k, s),
  listUserMfaDevices: (c, u) => rpc('iam:list-mfa-devices', c, u),
  deleteUserMfaDevice: (c, u, sn) => rpc('iam:delete-mfa-device', c, u, sn),
  listAttachedUserPolicies: (c, u) => rpc('iam:list-attached-user-policies', c, u),
  listUserInlinePolicies: (c, u) => rpc('iam:list-user-inline-policies', c, u),
  attachUserPolicy: (c, u, arn) => rpc('iam:attach-user-policy', c, u, arn),
  detachUserPolicy: (c, u, arn) => rpc('iam:detach-user-policy', c, u, arn),
  putUserInlinePolicy: (c, u, n, d) => rpc('iam:put-user-inline-policy', c, u, n, d),
  deleteUserInlinePolicy: (c, u, n) => rpc('iam:delete-user-inline-policy', c, u, n),
  listIamGroups: (c) => rpc('iam:list-groups', c),
  createIamGroup: (c, g) => rpc('iam:create-group', c, g),
  deleteIamGroup: (c, g) => rpc('iam:delete-group', c, g),
  listAttachedGroupPolicies: (c, g) => rpc('iam:list-attached-group-policies', c, g),
  attachGroupPolicy: (c, g, arn) => rpc('iam:attach-group-policy', c, g, arn),
  detachGroupPolicy: (c, g, arn) => rpc('iam:detach-group-policy', c, g, arn),
  listIamRoles: (c) => rpc('iam:list-roles', c),
  createIamRole: (c, name, tp, desc) => rpc('iam:create-role', c, name, tp, desc),
  deleteIamRole: (c, name) => rpc('iam:delete-role', c, name),
  listAttachedRolePolicies: (c, r) => rpc('iam:list-attached-role-policies', c, r),
  attachRolePolicy: (c, r, arn) => rpc('iam:attach-role-policy', c, r, arn),
  detachRolePolicy: (c, r, arn) => rpc('iam:detach-role-policy', c, r, arn),
  listRoleInlinePolicies: (c, r) => rpc('iam:list-role-inline-policies', c, r),
  putRoleInlinePolicy: (c, r, n, d) => rpc('iam:put-role-inline-policy', c, r, n, d),
  deleteRoleInlinePolicy: (c, r, n) => rpc('iam:delete-role-inline-policy', c, r, n),
  getRoleTrustPolicy: (c, r) => rpc('iam:get-role-trust-policy', c, r),
  updateRoleTrustPolicy: (c, r, d) => rpc('iam:update-role-trust-policy', c, r, d),
  listIamPolicies: (c, scope) => rpc('iam:list-policies', c, scope),
  getPolicyVersion: (c, arn, v) => rpc('iam:get-policy-version', c, arn, v),
  listPolicyVersions: (c, arn) => rpc('iam:list-policy-versions', c, arn),
  createPolicyVersion: (c, arn, doc, set) => rpc('iam:create-policy-version', c, arn, doc, set),
  deletePolicyVersion: (c, arn, v) => rpc('iam:delete-policy-version', c, arn, v),
  createIamPolicy: (c, n, doc, desc) => rpc('iam:create-policy', c, n, doc, desc),
  deleteIamPolicy: (c, arn) => rpc('iam:delete-policy', c, arn),
  simulateIamPolicy: (c, arn, actions, resources) => rpc('iam:simulate-policy', c, arn, actions, resources),
  generateCredentialReport: (c) => rpc('iam:generate-credential-report', c),
  getIamCredentialReport: (c) => rpc('iam:get-credential-report', c),

  // ── Key Pairs ─────────────────────────────────────────────────────────────
  listKeyPairs: (c) => rpc('key-pairs:list', c),
  createKeyPair: (c, name) => rpc('key-pairs:create', c, name),
  deleteKeyPair: (c, name) => rpc('key-pairs:delete', c, name),

  // ── KMS ───────────────────────────────────────────────────────────────────
  listKmsKeys: (c) => rpc('kms:list-keys', c),
  describeKmsKey: (c, id) => rpc('kms:describe-key', c, id),
  kmsDecrypt: (c, keyId, ciphertext) => rpc('kms:decrypt', c, keyId, ciphertext),

  // ── Lambda ────────────────────────────────────────────────────────────────
  listLambdaFunctions: (c) => rpc('lambda:list-functions', c),
  getLambdaFunction: (c, name) => rpc('lambda:get-function', c, name),
  getLambdaCode: (c, name) => rpc('lambda:get-code', c, name),
  invokeLambda: (c, name, payload) => rpc('lambda:invoke', c, name, payload),
  createLambda: (c, cfg) => rpc('lambda:create', c, cfg),
  deleteLambda: (c, name) => rpc('lambda:delete', c, name),

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
  listS3Objects: (c, bucket, prefix) => rpc('s3:list-objects', c, bucket, prefix),
  getS3ObjectContent: (c, bucket, key) => rpc('s3:get-object-content', c, bucket, key),
  putS3ObjectContent: (c, bucket, key, body) => rpc('s3:put-object-content', c, bucket, key, body),
  deleteS3Object: (c, bucket, key) => rpc('s3:delete-object', c, bucket, key),
  createS3Folder: (c, bucket, prefix) => rpc('s3:create-folder', c, bucket, prefix),
  createS3Bucket: (c, name, region) => rpc('s3:create-bucket', c, name, region),
  uploadS3Object: (c, bucket, key, filePath) => rpc('s3:upload-object', c, bucket, key, filePath),
  downloadS3Object: (c, bucket, key) => rpc('s3:download-object', c, bucket, key),
  downloadS3ObjectTo: (c, bucket, key, dest) => rpc('s3:download-object-to', c, bucket, key, dest),
  openS3Object: (c, bucket, key) => rpc('s3:open-object', c, bucket, key),
  openS3InVscode: (c, bucket, prefix) => rpc('s3:open-in-vscode', c, bucket, prefix),
  getS3PresignedUrl: (c, bucket, key) => rpc('s3:presigned-url', c, bucket, key),
  enableS3Versioning: (c, bucket) => rpc('s3:enable-versioning', c, bucket),
  enableS3Encryption: (c, bucket) => rpc('s3:enable-encryption', c, bucket),
  putS3BucketPolicy: (c, bucket, policy) => rpc('s3:put-policy', c, bucket, policy),
  listS3Governance: (c) => rpc('s3:list-governance', c),
  getS3GovernanceDetail: (c, bucket) => rpc('s3:get-governance-detail', c, bucket),

  // ── Secrets Manager ───────────────────────────────────────────────────────
  listSecrets: (c) => rpc('secrets:list', c),
  describeSecret: (c, id) => rpc('secrets:describe', c, id),
  getSecretValue: (c, id) => rpc('secrets:get-value', c, id),
  createSecret: (c, input) => rpc('secrets:create', c, input),
  updateSecretValue: (c, id, value) => rpc('secrets:update-value', c, id, value),
  updateSecretDescription: (c, id, desc) => rpc('secrets:update-description', c, id, desc),
  deleteSecret: (c, id) => rpc('secrets:delete', c, id),
  restoreSecret: (c, id) => rpc('secrets:restore', c, id),
  rotateSecret: (c, id) => rpc('secrets:rotate', c, id),
  tagSecret: (c, id, tags) => rpc('secrets:tag', c, id, tags),
  untagSecret: (c, id, keys) => rpc('secrets:untag', c, id, keys),
  getSecretDependencyReport: (c, id) => rpc('secrets:dependency-report', c, id),
  putSecretPolicy: (c, id, policy) => rpc('secrets:put-policy', c, id, policy),

  // ── SNS ───────────────────────────────────────────────────────────────────
  listSnsTopics: (c) => rpc('sns:list-topics', c),
  getSnsTopic: (c, arn) => rpc('sns:get-topic', c, arn),
  createSnsTopic: (c, name) => rpc('sns:create-topic', c, name),
  deleteSnsTopic: (c, arn) => rpc('sns:delete-topic', c, arn),
  setSnsAttribute: (c, arn, attr, value) => rpc('sns:set-attribute', c, arn, attr, value),
  listSnsSubscriptions: (c, arn) => rpc('sns:list-subscriptions', c, arn),
  subscribeSns: (c, arn, proto, endpoint) => rpc('sns:subscribe', c, arn, proto, endpoint),
  unsubscribeSns: (c, sub) => rpc('sns:unsubscribe', c, sub),
  publishSns: (c, arn, msg, subject) => rpc('sns:publish', c, arn, msg, subject),
  tagSns: (c, arn, tags) => rpc('sns:tag', c, arn, tags),
  untagSns: (c, arn, keys) => rpc('sns:untag', c, arn, keys),

  // ── SQS ───────────────────────────────────────────────────────────────────
  listSqsQueues: (c) => rpc('sqs:list-queues', c),
  getSqsQueue: (c, url) => rpc('sqs:get-queue', c, url),
  createSqsQueue: (c, name, attrs) => rpc('sqs:create-queue', c, name, attrs),
  deleteSqsQueue: (c, url) => rpc('sqs:delete-queue', c, url),
  setSqsAttributes: (c, url, attrs) => rpc('sqs:set-attributes', c, url, attrs),
  purgeSqsQueue: (c, url) => rpc('sqs:purge-queue', c, url),
  receiveSqsMessages: (c, url, max) => rpc('sqs:receive-messages', c, url, max),
  sendSqsMessage: (c, url, body, attrs) => rpc('sqs:send-message', c, url, body, attrs),
  deleteSqsMessage: (c, url, handle) => rpc('sqs:delete-message', c, url, handle),
  changeSqsVisibility: (c, url, handle, timeout) => rpc('sqs:change-visibility', c, url, handle, timeout),
  getSqsTimeline: (c, url) => rpc('sqs:timeline', c, url),
  tagSqs: (c, url, tags) => rpc('sqs:tag', c, url, tags),
  untagSqs: (c, url, keys) => rpc('sqs:untag', c, url, keys),

  // ── ACM ───────────────────────────────────────────────────────────────────
  listAcmCertificates: (c) => rpc('acm:list-certificates', c),
  describeAcmCertificate: (c, arn) => rpc('acm:describe-certificate', c, arn),
  requestAcmCertificate: (c, input) => rpc('acm:request-certificate', c, input),
  deleteAcmCertificate: (c, arn) => rpc('acm:delete-certificate', c, arn),

  // ── Auto Scaling ──────────────────────────────────────────────────────────
  listAutoScalingGroups: (c) => rpc('auto-scaling:list-groups', c),
  listAutoScalingInstances: (c, group) => rpc('auto-scaling:list-instances', c, group),
  startAutoScalingRefresh: (c, group) => rpc('auto-scaling:start-refresh', c, group),
  deleteAutoScalingGroup: (c, group) => rpc('auto-scaling:delete-group', c, group),

  // ── CloudFormation ────────────────────────────────────────────────────────
  listCloudFormationStacks: (c) => rpc('cloudformation:list-stacks', c),
  listCloudFormationStackResources: (c, stack) => rpc('cloudformation:list-stack-resources', c, stack),
  startCloudFormationDriftDetection: (c, stack) => rpc('cloudformation:start-drift-detection', c, stack),
  getCloudFormationDriftSummary: (c, stack) => rpc('cloudformation:get-drift-summary', c, stack),
  listCloudFormationChangeSets: (c, stack) => rpc('cloudformation:list-change-sets', c, stack),

  // ── CloudTrail ────────────────────────────────────────────────────────────
  listCloudTrailTrails: (c) => rpc('cloudtrail:list-trails', c),
  lookupCloudTrailEvents: (c, trailArn, filter) => rpc('cloudtrail:lookup-events', c, trailArn, filter),
  lookupCloudTrailEventsByResource: (c, resourceArn) => rpc('cloudtrail:lookup-events-by-resource', c, resourceArn),

  // ── CloudWatch ────────────────────────────────────────────────────────────
  listCloudWatchMetrics: (c, namespace) => rpc('cloudwatch:metrics', c, namespace),
  getCloudWatchMetricStats: (c, req) => rpc('cloudwatch:metric-stats', c, req),
  listCloudWatchLogGroups: (c) => rpc('cloudwatch:log-groups', c),
  getCloudWatchRecentEvents: (c, group, stream) => rpc('cloudwatch:recent-events', c, group, stream),
  getEc2InstanceMetrics: (c, id) => rpc('cloudwatch:ec2-instance-metrics', c, id),
  getEc2MetricSeries: (c, id, metric) => rpc('cloudwatch:ec2-series', c, id, metric),
  getAllEc2MetricSeries: (c) => rpc('cloudwatch:ec2-all-series', c),

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
  listWafWebAcls: (c, scope) => rpc('waf:list-web-acls', c, scope),
  describeWafWebAcl: (c, id, name, scope) => rpc('waf:describe-web-acl', c, id, name, scope),
  createWafWebAcl: (c, cfg) => rpc('waf:create-web-acl', c, cfg),
  deleteWafWebAcl: (c, id, name, scope, lockToken) => rpc('waf:delete-web-acl', c, id, name, scope, lockToken),
  addWafRule: (c, aclId, aclName, scope, lockToken, rule) => rpc('waf:add-rule', c, aclId, aclName, scope, lockToken, rule),
  deleteWafRule: (c, aclId, aclName, scope, lockToken, ruleName) => rpc('waf:delete-rule', c, aclId, aclName, scope, lockToken, ruleName),
  associateWafResource: (c, aclArn, resourceArn) => rpc('waf:associate-resource', c, aclArn, resourceArn),
  disassociateWafResource: (c, resourceArn) => rpc('waf:disassociate-resource', c, resourceArn),

  // ── Terraform ─────────────────────────────────────────────────────────────
  detectTerraformCli: () => rpc('terraform:cli:detect'),
  getTerraformCliInfo: () => rpc('terraform:cli:info'),
  listTerraformProjects: (p, c) => rpc('terraform:projects:list', p, c),
  getTerraformProject: (p, id, c) => rpc('terraform:projects:get', p, id, c),
  getSelectedTerraformProject: (p) => rpc('terraform:projects:selected:get', p),
  setSelectedTerraformProject: (p, id) => rpc('terraform:projects:selected:set', p, id),
  chooseTerraformDirectory: () => rpc('terraform:projects:choose-directory'),
  chooseTerraformFile: () => rpc('terraform:projects:choose-file'),
  addTerraformProject: (p, path, c) => rpc('terraform:projects:add', p, path, c),
  renameTerraformProject: (p, id, name) => rpc('terraform:projects:rename', p, id, name),
  removeTerraformProject: (p, id) => rpc('terraform:projects:remove', p, id),
  reloadTerraformProject: (p, id, c) => rpc('terraform:projects:reload', p, id, c),
  openTerraformInVscode: (path) => rpc('terraform:projects:open-vscode', path),
  selectTerraformWorkspace: (p, id, ws, c) => rpc('terraform:workspace:select', p, id, ws, c),
  createTerraformWorkspace: (p, id, ws, c) => rpc('terraform:workspace:create', p, id, ws, c),
  deleteTerraformWorkspace: (p, id, ws, c) => rpc('terraform:workspace:delete', p, id, ws, c),
  updateTerraformInputs: (p, id, cfg, c) => rpc('terraform:inputs:update', p, id, cfg, c),
  getMissingTerraformInputs: (p, id) => rpc('terraform:inputs:missing-required', p, id),
  validateTerraformInputs: (p, id, c) => rpc('terraform:inputs:validate', p, id, c),
  detectMissingTerraformVars: (output) => rpc('terraform:detect-missing-vars', output),
  runTerraformCommand: (req) => rpc('terraform:command:run', req),
  hasSavedTerraformPlan: (id) => rpc('terraform:plan:has-saved', id),
  clearSavedTerraformPlan: (id) => rpc('terraform:plan:clear', id),
  listTerraformLogs: (id) => rpc('terraform:logs:list', id),
  listTerraformHistory: (filter) => rpc('terraform:history:list', filter),
  getTerraformHistoryOutput: (runId) => rpc('terraform:history:get-output', runId),
  deleteTerraformHistory: (runId) => rpc('terraform:history:delete', runId),
  getTerraformDrift: (p, id, c, opts) => rpc('terraform:drift:get', p, id, c, opts),
  getTerraformObservabilityReport: (p, id, c) => rpc('terraform:observability-report:get', p, id, c),
  detectTerraformGovernanceTools: (path) => rpc('terraform:governance:detect-tools', path),
  getTerraformGovernanceToolkit: () => rpc('terraform:governance:toolkit'),
  runTerraformGovernanceChecks: (p, id, c) => rpc('terraform:governance:run-checks', p, id, c),
  getTerraformGovernanceReport: (id) => rpc('terraform:governance:get-report', id),

  // ── Terminal (WebSocket) ───────────────────────────────────────────────────
  openTerminal: (connection, initialCommand?) => {
    const ws = getTerminalWs()
    const send = () => {
      ws.send(JSON.stringify({ type: 'open', cols: 120, rows: 24 }))
      if (initialCommand) {
        setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `${initialCommand}\r` })), 200)
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      send()
    } else {
      ws.addEventListener('open', send, { once: true })
    }
    return Promise.resolve()
  },
  updateTerminalContext: (_c) => Promise.resolve(),
  sendTerminalInput: (input) => {
    getTerminalWs().send(JSON.stringify({ type: 'input', data: input }))
    return Promise.resolve()
  },
  runTerminalCommand: (cmd) => {
    getTerminalWs().send(JSON.stringify({ type: 'input', data: `${cmd}\r` }))
    return Promise.resolve()
  },
  resizeTerminal: (cols, rows) => {
    getTerminalWs().send(JSON.stringify({ type: 'resize', cols, rows }))
    return Promise.resolve()
  },
  closeTerminal: () => {
    if (terminalWs) {
      terminalWs.send(JSON.stringify({ type: 'close' }))
      terminalWs = null
    }
    return Promise.resolve()
  },
  onTerminalEvent: (listener) => {
    const ws = getTerminalWs()
    const handler = (event: MessageEvent) => {
      try {
        listener(JSON.parse(event.data as string))
      } catch {/* ignore */}
    }
    terminalListeners.set(listener, handler)
    ws.addEventListener('message', handler)
  },
  offTerminalEvent: (listener) => {
    const handler = terminalListeners.get(listener)
    if (handler) {
      try { getTerminalWs().removeEventListener('message', handler) } catch {/* ignore */}
      terminalListeners.delete(listener)
    }
  },

  // ── Desktop-only stubs (no-ops in web mode) ────────────────────────────────
  showItemInFolder: (_path) => Promise.resolve(),
  chooseDirectory: () => Promise.resolve({ canceled: true, path: undefined }),
}
