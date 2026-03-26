import { contextBridge, ipcRenderer } from 'electron'

import type { AwsConnection, BastionLaunchConfig, Ec2InstanceAction, EcsFargateServiceConfig, LambdaCreateConfig, SnapshotLaunchConfig, TerraformCommandRequest } from '@shared/types'

/* ── AWS Lens bridge ──────────────────────────────────────── */

const awsLensApi = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  chooseAndImportConfig: () => ipcRenderer.invoke('profiles:choose-and-import'),
  saveCredentials: (profileName: string, accessKeyId: string, secretAccessKey: string) =>
    ipcRenderer.invoke('profiles:save-credentials', profileName, accessKeyId, secretAccessKey),
  listRegions: () => ipcRenderer.invoke('regions:list'),
  listServices: () => ipcRenderer.invoke('services:list'),
  getCallerIdentity: (connection: AwsConnection) => ipcRenderer.invoke('sts:get-caller-identity', connection),
  listEc2Instances: (connection: AwsConnection) => ipcRenderer.invoke('ec2:list', connection),
  describeEc2Instance: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('ec2:describe', connection, instanceId),
  runEc2InstanceAction: (connection: AwsConnection, instanceId: string, action: Ec2InstanceAction) =>
    ipcRenderer.invoke('ec2:action', connection, instanceId, action),
  terminateEc2Instance: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('ec2:terminate', connection, instanceId),
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
  listLoadBalancerWorkspaces: (connection: AwsConnection) => ipcRenderer.invoke('elbv2:list-workspaces', connection),
  deleteLoadBalancer: (connection: AwsConnection, loadBalancerArn: string) =>
    ipcRenderer.invoke('elbv2:delete-load-balancer', connection, loadBalancerArn),
  listCloudWatchMetrics: (connection: AwsConnection) => ipcRenderer.invoke('cloudwatch:metrics', connection),
  getEc2MetricSeries: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('cloudwatch:ec2-series', connection, instanceId),
  listCloudWatchLogGroups: (connection: AwsConnection) => ipcRenderer.invoke('cloudwatch:log-groups', connection),
  listCloudWatchRecentEvents: (connection: AwsConnection, logGroupName: string) =>
    ipcRenderer.invoke('cloudwatch:recent-events', connection, logGroupName),
  listEc2InstanceMetrics: (connection: AwsConnection, instanceId: string) =>
    ipcRenderer.invoke('cloudwatch:ec2-instance-metrics', connection, instanceId),
  getMetricStatistics: (connection: AwsConnection, metrics: unknown[], periodHours: number) =>
    ipcRenderer.invoke('cloudwatch:metric-stats', connection, metrics, periodHours),
  getEc2AllMetricSeries: (connection: AwsConnection, instanceId: string, periodHours: number) =>
    ipcRenderer.invoke('cloudwatch:ec2-all-series', connection, instanceId, periodHours),
  listRoute53HostedZones: (connection: AwsConnection) => ipcRenderer.invoke('route53:hosted-zones', connection),
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
  getComplianceReport: (connection: AwsConnection) =>
    ipcRenderer.invoke('compliance:report', connection),
  getRelationshipMap: (connection: AwsConnection) =>
    ipcRenderer.invoke('overview:relationships', connection),
  searchByTag: (connection: AwsConnection, tagKey: string, tagValue?: string) =>
    ipcRenderer.invoke('overview:search-tags', connection, tagKey, tagValue),
  getCostBreakdown: (connection: AwsConnection) =>
    ipcRenderer.invoke('overview:cost-breakdown', connection),
  openExternalUrl: (url: string) => ipcRenderer.invoke('shell:open-external', url),

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
  addEksToKubeconfig: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:add-kubeconfig', connection, clusterName),
  launchKubectlTerminal: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:launch-kubectl', connection, clusterName),
  prepareEksKubectlSession: (connection: AwsConnection, clusterName: string) =>
    ipcRenderer.invoke('eks:prepare-kubectl-session', connection, clusterName),
  runEksCommand: (connection: AwsConnection, clusterName: string, kubeconfigPath: string, command: string) =>
    ipcRenderer.invoke('eks:run-command', connection, clusterName, kubeconfigPath, command),

  /* ECS */
  listEcsClusters: (connection: AwsConnection) => ipcRenderer.invoke('ecs:list-clusters', connection),
  listEcsServices: (connection: AwsConnection, clusterArn: string) =>
    ipcRenderer.invoke('ecs:list-services', connection, clusterArn),
  describeEcsService: (connection: AwsConnection, clusterArn: string, serviceName: string) =>
    ipcRenderer.invoke('ecs:describe-service', connection, clusterArn, serviceName),
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
  openAwsTerminal: (connection: AwsConnection, initialCommand?: string) => ipcRenderer.invoke('terminal:open-aws', connection, initialCommand),
  updateAwsTerminalContext: (connection: AwsConnection) => ipcRenderer.invoke('terminal:update-aws-context', connection),
  sendTerminalInput: (input: string) => ipcRenderer.invoke('terminal:input', input),
  runTerminalCommand: (command: string) => ipcRenderer.invoke('terminal:run-command', command),
  resizeTerminal: (cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', cols, rows),
  closeTerminal: () => ipcRenderer.invoke('terminal:close'),
  subscribeTerminal: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    listenerMap.set(listener, wrapped)
    ipcRenderer.on('terminal:event', wrapped)
  },
  unsubscribeTerminal: (listener: (event: unknown) => void) => {
    const wrapped = listenerMap.get(listener)
    if (!wrapped) {
      return
    }
    ipcRenderer.removeListener('terminal:event', wrapped)
    listenerMap.delete(listener)
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

const listenerMap = new Map<(event: unknown) => void, (...args: unknown[]) => void>()

const api = {
  detectCli: () => ipcRenderer.invoke('terraform:cli:detect'),
  getCliInfo: () => ipcRenderer.invoke('terraform:cli:info'),
  listProjects: (profileName: string) => ipcRenderer.invoke('terraform:projects:list', profileName),
  getProject: (profileName: string, projectId: string) => ipcRenderer.invoke('terraform:projects:get', profileName, projectId),
  getDrift: (profileName: string, projectId: string, connection: AwsConnection) =>
    ipcRenderer.invoke('terraform:drift:get', profileName, projectId, connection),
  chooseProjectDirectory: () => ipcRenderer.invoke('terraform:projects:choose-directory'),
  chooseVarFile: () => ipcRenderer.invoke('terraform:projects:choose-file'),
  addProject: (profileName: string, rootPath: string) => ipcRenderer.invoke('terraform:projects:add', profileName, rootPath),
  renameProject: (profileName: string, projectId: string, name: string) => ipcRenderer.invoke('terraform:projects:rename', profileName, projectId, name),
  removeProject: (profileName: string, projectId: string) => ipcRenderer.invoke('terraform:projects:remove', profileName, projectId),
  reloadProject: (profileName: string, projectId: string) => ipcRenderer.invoke('terraform:projects:reload', profileName, projectId),
  getSelectedProjectId: (profileName: string) => ipcRenderer.invoke('terraform:projects:selected:get', profileName),
  setSelectedProjectId: (profileName: string, projectId: string) => ipcRenderer.invoke('terraform:projects:selected:set', profileName, projectId),
  updateInputs: (profileName: string, projectId: string, inputs: Record<string, unknown>, varFile?: string) =>
    ipcRenderer.invoke('terraform:inputs:update', profileName, projectId, inputs, varFile),
  listCommandLogs: (projectId: string) => ipcRenderer.invoke('terraform:logs:list', projectId),
  runCommand: (request: TerraformCommandRequest) => ipcRenderer.invoke('terraform:command:run', request),
  hasSavedPlan: (projectId: string) => ipcRenderer.invoke('terraform:plan:has-saved', projectId),
  clearSavedPlan: (projectId: string) => ipcRenderer.invoke('terraform:plan:clear', projectId),
  detectMissingVars: (output: string) => ipcRenderer.invoke('terraform:detect-missing-vars', output),
  subscribe: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    listenerMap.set(listener, wrapped)
    ipcRenderer.on('terraform:event', wrapped)
  },
  unsubscribe: (listener: (event: unknown) => void) => {
    const wrapped = listenerMap.get(listener)
    if (!wrapped) {
      return
    }
    ipcRenderer.removeListener('terraform:event', wrapped)
    listenerMap.delete(listener)
  }
}

contextBridge.exposeInMainWorld('terraformWorkspace', api)
