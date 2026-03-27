import { ipcMain } from 'electron'

import type { AwsConnection, CloudWatchMetricSummary, EcsFargateServiceConfig, LambdaCreateConfig, Route53RecordChange } from '@shared/types'
import { listAutoScalingGroupInstances, listAutoScalingGroups, deleteAutoScalingGroup, startAutoScalingInstanceRefresh, updateAutoScalingGroupCapacity } from './aws/autoScaling'
import { listCloudWatchLogGroups, listCloudWatchMetrics, listRecentLogEvents, getEc2MetricSeries, listEc2InstanceMetrics, getMetricStatistics, getEc2AllMetricSeries } from './aws/cloudwatch'
import { lookupEvents, lookupEventsByResource, listTrails } from './aws/cloudtrail'
import {
  createChangeSet,
  deleteChangeSet,
  executeChangeSet,
  getChangeSetDetail,
  getStackDriftDetectionStatus,
  getStackDriftSummary,
  listChangeSets,
  listStacks,
  listStackResources,
  startStackDriftDetection
} from './aws/cloudformation'
import { createFargateService, deleteService, describeService, forceRedeploy, getContainerLogs, listClusters, listServices, listTasks, stopTask, updateDesiredCount } from './aws/ecs'
import { createInstance, deleteInstance, listAccountAssignments, listGroups, listInstances, listPermissionSets, listUsers, simulatePermissions } from './aws/identityCenter'
import { createLambdaFunction, deleteLambdaFunction, getLambdaFunctionCode, getLambdaFunctionDetails, invokeLambdaFunction, listLambdaFunctions } from './aws/lambda'
import {
  createDbClusterSnapshot,
  createDbSnapshot,
  describeDbCluster,
  describeDbInstance,
  failoverDbCluster,
  listDbClusters,
  listDbInstances,
  rebootDbInstance,
  resizeDbInstance,
  startDbCluster,
  startDbInstance,
  stopDbCluster,
  stopDbInstance
} from './aws/rds'
import { deleteRoute53Record, listRoute53HostedZones, listRoute53Records, upsertRoute53Record } from './aws/route53'
import {
  createBucket,
  createFolder,
  deleteObject,
  downloadObject,
  downloadObjectToPath,
  enableBucketEncryption,
  enableBucketVersioning,
  getBucketGovernanceDetail,
  getObjectContent,
  getPresignedUrl,
  listBucketGovernance,
  listBucketObjects,
  listBuckets,
  openDownloadedObject,
  openInVSCode,
  putBucketPolicy,
  putObjectContent,
  uploadObject
} from './aws/s3'
import { createTopic, deleteTopic, getTopicDetail, listSubscriptions, listTopics, publishMessage, setTopicAttribute, subscribe, tagTopic, unsubscribe, untagTopic } from './aws/sns'
import { buildQueueTimeline, changeMessageVisibility, createQueue, deleteMessage, deleteQueue, getQueueDetail, listQueues, purgeQueue, receiveMessages, sendMessage, setQueueAttributes, tagQueue, untagQueue } from './aws/sqs'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerServiceIpcHandlers(): void {
  ipcMain.handle('cloudwatch:metrics', async (_event, connection: AwsConnection) =>
    wrap(() => listCloudWatchMetrics(connection))
  )
  ipcMain.handle('cloudwatch:ec2-series', async (_event, connection: AwsConnection, instanceId: string) =>
    wrap(() => getEc2MetricSeries(connection, instanceId))
  )
  ipcMain.handle('cloudwatch:log-groups', async (_event, connection: AwsConnection) =>
    wrap(() => listCloudWatchLogGroups(connection))
  )
  ipcMain.handle('cloudwatch:recent-events', async (_event, connection: AwsConnection, logGroupName: string) =>
    wrap(() => listRecentLogEvents(connection, logGroupName))
  )
  ipcMain.handle('cloudwatch:ec2-instance-metrics', async (_event, connection: AwsConnection, instanceId: string) =>
    wrap(() => listEc2InstanceMetrics(connection, instanceId))
  )
  ipcMain.handle('cloudwatch:metric-stats', async (_event, connection: AwsConnection, metrics: CloudWatchMetricSummary[], periodHours: number) =>
    wrap(() => getMetricStatistics(connection, metrics, periodHours))
  )
  ipcMain.handle('cloudwatch:ec2-all-series', async (_event, connection: AwsConnection, instanceId: string, periodHours: number) =>
    wrap(() => getEc2AllMetricSeries(connection, instanceId, periodHours))
  )

  ipcMain.handle('cloudtrail:list-trails', async (_event, connection: AwsConnection) =>
    wrap(() => listTrails(connection))
  )
  ipcMain.handle('cloudtrail:lookup-events', async (_event, connection: AwsConnection, startTime: string, endTime: string) =>
    wrap(() => lookupEvents(connection, startTime, endTime))
  )
  ipcMain.handle('cloudtrail:lookup-events-by-resource', async (_event, connection: AwsConnection, resourceName: string, startTime: string, endTime: string) =>
    wrap(() => lookupEventsByResource(connection, resourceName, startTime, endTime))
  )

  ipcMain.handle('route53:hosted-zones', async (_event, connection: AwsConnection) =>
    wrap(() => listRoute53HostedZones(connection))
  )
  ipcMain.handle('route53:records', async (_event, connection: AwsConnection, hostedZoneId: string) =>
    wrap(() => listRoute53Records(connection, hostedZoneId))
  )
  ipcMain.handle('route53:upsert-record', async (_event, connection: AwsConnection, hostedZoneId: string, record: Route53RecordChange) =>
    wrap(() => upsertRoute53Record(connection, hostedZoneId, record))
  )
  ipcMain.handle('route53:delete-record', async (_event, connection: AwsConnection, hostedZoneId: string, record: Route53RecordChange) =>
    wrap(() => deleteRoute53Record(connection, hostedZoneId, record))
  )

  ipcMain.handle('ecs:list-clusters', async (_event, connection: AwsConnection) =>
    wrap(() => listClusters(connection))
  )
  ipcMain.handle('ecs:list-services', async (_event, connection: AwsConnection, clusterArn: string) =>
    wrap(() => listServices(connection, clusterArn))
  )
  ipcMain.handle('ecs:describe-service', async (_event, connection: AwsConnection, clusterArn: string, serviceName: string) =>
    wrap(() => describeService(connection, clusterArn, serviceName))
  )
  ipcMain.handle('ecs:list-tasks', async (_event, connection: AwsConnection, clusterArn: string, serviceName?: string) =>
    wrap(() => listTasks(connection, clusterArn, serviceName))
  )
  ipcMain.handle('ecs:update-desired-count', async (_event, connection: AwsConnection, clusterArn: string, serviceName: string, desiredCount: number) =>
    wrap(() => updateDesiredCount(connection, clusterArn, serviceName, desiredCount))
  )
  ipcMain.handle('ecs:force-redeploy', async (_event, connection: AwsConnection, clusterArn: string, serviceName: string) =>
    wrap(() => forceRedeploy(connection, clusterArn, serviceName))
  )
  ipcMain.handle('ecs:stop-task', async (_event, connection: AwsConnection, clusterArn: string, taskArn: string, reason?: string) =>
    wrap(() => stopTask(connection, clusterArn, taskArn, reason))
  )
  ipcMain.handle('ecs:delete-service', async (_event, connection: AwsConnection, clusterArn: string, serviceName: string) =>
    wrap(() => deleteService(connection, clusterArn, serviceName))
  )
  ipcMain.handle('ecs:create-fargate-service', async (_event, connection: AwsConnection, config: EcsFargateServiceConfig) =>
    wrap(() => createFargateService(connection, config))
  )
  ipcMain.handle('ecs:get-container-logs', async (_event, connection: AwsConnection, logGroup: string, logStream: string, startTime?: number) =>
    wrap(() => getContainerLogs(connection, logGroup, logStream, startTime))
  )

  ipcMain.handle('lambda:list-functions', async (_event, connection: AwsConnection) =>
    wrap(() => listLambdaFunctions(connection))
  )
  ipcMain.handle('lambda:get-function', async (_event, connection: AwsConnection, functionName: string) =>
    wrap(() => getLambdaFunctionDetails(connection, functionName))
  )
  ipcMain.handle('lambda:invoke', async (_event, connection: AwsConnection, functionName: string, payload: string) =>
    wrap(() => invokeLambdaFunction(connection, functionName, payload))
  )
  ipcMain.handle('lambda:get-code', async (_event, connection: AwsConnection, functionName: string) =>
    wrap(() => getLambdaFunctionCode(connection, functionName))
  )
  ipcMain.handle('lambda:create', async (_event, connection: AwsConnection, config: LambdaCreateConfig) =>
    wrap(() => createLambdaFunction(connection, config))
  )
  ipcMain.handle('lambda:delete', async (_event, connection: AwsConnection, functionName: string) =>
    wrap(() => deleteLambdaFunction(connection, functionName))
  )

  ipcMain.handle('auto-scaling:list-groups', async (_event, connection: AwsConnection) =>
    wrap(() => listAutoScalingGroups(connection))
  )
  ipcMain.handle('auto-scaling:list-instances', async (_event, connection: AwsConnection, groupName: string) =>
    wrap(() => listAutoScalingGroupInstances(connection, groupName))
  )
  ipcMain.handle(
    'auto-scaling:update-capacity',
    async (_event, connection: AwsConnection, groupName: string, minimum: number, desired: number, maximum: number) =>
      wrap(() => updateAutoScalingGroupCapacity(connection, groupName, minimum, desired, maximum))
  )
  ipcMain.handle('auto-scaling:start-refresh', async (_event, connection: AwsConnection, groupName: string) =>
    wrap(() => startAutoScalingInstanceRefresh(connection, groupName))
  )
  ipcMain.handle('auto-scaling:delete-group', async (_event, connection: AwsConnection, groupName: string, forceDelete = false) =>
    wrap(() => deleteAutoScalingGroup(connection, groupName, forceDelete))
  )

  ipcMain.handle('s3:list-buckets', async (_event, connection: AwsConnection) =>
    wrap(() => listBuckets(connection))
  )
  ipcMain.handle('s3:list-governance', async (_event, connection: AwsConnection) =>
    wrap(() => listBucketGovernance(connection))
  )
  ipcMain.handle('s3:get-governance-detail', async (_event, connection: AwsConnection, bucketName: string) =>
    wrap(() => getBucketGovernanceDetail(connection, bucketName))
  )
  ipcMain.handle('s3:list-objects', async (_event, connection: AwsConnection, bucketName: string, prefix: string) =>
    wrap(() => listBucketObjects(connection, bucketName, prefix))
  )
  ipcMain.handle('s3:create-bucket', async (_event, connection: AwsConnection, bucketName: string) =>
    wrap(() => createBucket(connection, bucketName))
  )
  ipcMain.handle('s3:delete-object', async (_event, connection: AwsConnection, bucketName: string, key: string) =>
    wrap(() => deleteObject(connection, bucketName, key))
  )
  ipcMain.handle('s3:presigned-url', async (_event, connection: AwsConnection, bucketName: string, key: string) =>
    wrap(() => getPresignedUrl(connection, bucketName, key))
  )
  ipcMain.handle('s3:create-folder', async (_event, connection: AwsConnection, bucketName: string, folderKey: string) =>
    wrap(() => createFolder(connection, bucketName, folderKey))
  )
  ipcMain.handle('s3:download-object', async (_event, connection: AwsConnection, bucketName: string, key: string) =>
    wrap(() => downloadObject(connection, bucketName, key))
  )
  ipcMain.handle('s3:download-object-to', async (_event, connection: AwsConnection, bucketName: string, key: string) =>
    wrap(() => downloadObjectToPath(connection, bucketName, key))
  )
  ipcMain.handle('s3:open-object', async (_event, connection: AwsConnection, bucketName: string, key: string) =>
    wrap(() => openDownloadedObject(connection, bucketName, key))
  )
  ipcMain.handle('s3:open-in-vscode', async (_event, connection: AwsConnection, bucketName: string, key: string) =>
    wrap(() => openInVSCode(connection, bucketName, key))
  )
  ipcMain.handle('s3:get-object-content', async (_event, connection: AwsConnection, bucketName: string, key: string) =>
    wrap(() => getObjectContent(connection, bucketName, key))
  )
  ipcMain.handle('s3:put-object-content', async (_event, connection: AwsConnection, bucketName: string, key: string, content: string, contentType?: string) =>
    wrap(() => putObjectContent(connection, bucketName, key, content, contentType))
  )
  ipcMain.handle('s3:upload-object', async (_event, connection: AwsConnection, bucketName: string, key: string, localPath: string) =>
    wrap(() => uploadObject(connection, bucketName, key, localPath))
  )
  ipcMain.handle('s3:enable-versioning', async (_event, connection: AwsConnection, bucketName: string) =>
    wrap(() => enableBucketVersioning(connection, bucketName))
  )
  ipcMain.handle('s3:enable-encryption', async (_event, connection: AwsConnection, bucketName: string) =>
    wrap(() => enableBucketEncryption(connection, bucketName))
  )
  ipcMain.handle('s3:put-policy', async (_event, connection: AwsConnection, bucketName: string, policyJson: string) =>
    wrap(() => putBucketPolicy(connection, bucketName, policyJson))
  )

  ipcMain.handle('rds:list-instances', async (_event, connection: AwsConnection) =>
    wrap(() => listDbInstances(connection))
  )
  ipcMain.handle('rds:list-clusters', async (_event, connection: AwsConnection) =>
    wrap(() => listDbClusters(connection))
  )
  ipcMain.handle('rds:describe-instance', async (_event, connection: AwsConnection, dbInstanceIdentifier: string) =>
    wrap(() => describeDbInstance(connection, dbInstanceIdentifier))
  )
  ipcMain.handle('rds:describe-cluster', async (_event, connection: AwsConnection, dbClusterIdentifier: string) =>
    wrap(() => describeDbCluster(connection, dbClusterIdentifier))
  )
  ipcMain.handle('rds:start-instance', async (_event, connection: AwsConnection, dbInstanceIdentifier: string) =>
    wrap(() => startDbInstance(connection, dbInstanceIdentifier))
  )
  ipcMain.handle('rds:stop-instance', async (_event, connection: AwsConnection, dbInstanceIdentifier: string) =>
    wrap(() => stopDbInstance(connection, dbInstanceIdentifier))
  )
  ipcMain.handle('rds:reboot-instance', async (_event, connection: AwsConnection, dbInstanceIdentifier: string, forceFailover = false) =>
    wrap(() => rebootDbInstance(connection, dbInstanceIdentifier, forceFailover))
  )
  ipcMain.handle('rds:resize-instance', async (_event, connection: AwsConnection, dbInstanceIdentifier: string, dbInstanceClass: string) =>
    wrap(() => resizeDbInstance(connection, dbInstanceIdentifier, dbInstanceClass))
  )
  ipcMain.handle('rds:create-snapshot', async (_event, connection: AwsConnection, dbInstanceIdentifier: string, dbSnapshotIdentifier: string) =>
    wrap(() => createDbSnapshot(connection, dbInstanceIdentifier, dbSnapshotIdentifier))
  )
  ipcMain.handle('rds:start-cluster', async (_event, connection: AwsConnection, dbClusterIdentifier: string) =>
    wrap(() => startDbCluster(connection, dbClusterIdentifier))
  )
  ipcMain.handle('rds:stop-cluster', async (_event, connection: AwsConnection, dbClusterIdentifier: string) =>
    wrap(() => stopDbCluster(connection, dbClusterIdentifier))
  )
  ipcMain.handle('rds:failover-cluster', async (_event, connection: AwsConnection, dbClusterIdentifier: string) =>
    wrap(() => failoverDbCluster(connection, dbClusterIdentifier))
  )
  ipcMain.handle('rds:create-cluster-snapshot', async (_event, connection: AwsConnection, dbClusterIdentifier: string, dbClusterSnapshotIdentifier: string) =>
    wrap(() => createDbClusterSnapshot(connection, dbClusterIdentifier, dbClusterSnapshotIdentifier))
  )

  ipcMain.handle('cloudformation:list-stacks', async (_event, connection: AwsConnection) =>
    wrap(() => listStacks(connection))
  )
  ipcMain.handle('cloudformation:list-stack-resources', async (_event, connection: AwsConnection, stackName: string) =>
    wrap(() => listStackResources(connection, stackName))
  )
  ipcMain.handle('cloudformation:list-change-sets', async (_event, connection: AwsConnection, stackName: string) =>
    wrap(() => listChangeSets(connection, stackName))
  )
  ipcMain.handle(
    'cloudformation:create-change-set',
    async (_event, connection: AwsConnection, input: {
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
    }) => wrap(() => createChangeSet(connection, input))
  )
  ipcMain.handle(
    'cloudformation:get-change-set-detail',
    async (_event, connection: AwsConnection, stackName: string, changeSetName: string) =>
      wrap(() => getChangeSetDetail(connection, stackName, changeSetName))
  )
  ipcMain.handle(
    'cloudformation:execute-change-set',
    async (_event, connection: AwsConnection, stackName: string, changeSetName: string) =>
      wrap(() => executeChangeSet(connection, stackName, changeSetName))
  )
  ipcMain.handle(
    'cloudformation:delete-change-set',
    async (_event, connection: AwsConnection, stackName: string, changeSetName: string) =>
      wrap(() => deleteChangeSet(connection, stackName, changeSetName))
  )
  ipcMain.handle('cloudformation:get-drift-summary', async (_event, connection: AwsConnection, stackName: string) =>
    wrap(() => getStackDriftSummary(connection, stackName))
  )
  ipcMain.handle('cloudformation:start-drift-detection', async (_event, connection: AwsConnection, stackName: string) =>
    wrap(() => startStackDriftDetection(connection, stackName))
  )
  ipcMain.handle(
    'cloudformation:get-drift-detection-status',
    async (_event, connection: AwsConnection, stackName: string, driftDetectionId: string) =>
      wrap(() => getStackDriftDetectionStatus(connection, stackName, driftDetectionId))
  )

  ipcMain.handle('sso:list-instances', async (_event, connection: AwsConnection) =>
    wrap(() => listInstances(connection))
  )
  ipcMain.handle('sso:create-instance', async (_event, connection: AwsConnection, name: string) =>
    wrap(() => createInstance(connection, name))
  )
  ipcMain.handle('sso:delete-instance', async (_event, connection: AwsConnection, instanceArn: string) =>
    wrap(() => deleteInstance(connection, instanceArn))
  )
  ipcMain.handle('sso:list-permission-sets', async (_event, connection: AwsConnection, instanceArn: string) =>
    wrap(() => listPermissionSets(connection, instanceArn))
  )
  ipcMain.handle('sso:list-users', async (_event, connection: AwsConnection, identityStoreId: string) =>
    wrap(() => listUsers(connection, identityStoreId))
  )
  ipcMain.handle('sso:list-groups', async (_event, connection: AwsConnection, identityStoreId: string) =>
    wrap(() => listGroups(connection, identityStoreId))
  )
  ipcMain.handle('sso:list-account-assignments', async (_event, connection: AwsConnection, instanceArn: string, accountId: string, permissionSetArn: string) =>
    wrap(() => listAccountAssignments(connection, instanceArn, accountId, permissionSetArn))
  )
  ipcMain.handle('sso:simulate-permissions', async (_event, connection: AwsConnection, instanceArn: string, permissionSetArn: string) =>
    wrap(() => simulatePermissions(connection, instanceArn, permissionSetArn))
  )

  ipcMain.handle('sns:list-topics', async (_event, connection: AwsConnection) => wrap(() => listTopics(connection)))
  ipcMain.handle('sns:get-topic', async (_event, connection: AwsConnection, topicArn: string) => wrap(() => getTopicDetail(connection, topicArn)))
  ipcMain.handle('sns:create-topic', async (_event, connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) =>
    wrap(() => createTopic(connection, name, fifo, attrs))
  )
  ipcMain.handle('sns:delete-topic', async (_event, connection: AwsConnection, topicArn: string) => wrap(() => deleteTopic(connection, topicArn)))
  ipcMain.handle('sns:set-attribute', async (_event, connection: AwsConnection, topicArn: string, attrName: string, attrValue: string) =>
    wrap(() => setTopicAttribute(connection, topicArn, attrName, attrValue))
  )
  ipcMain.handle('sns:list-subscriptions', async (_event, connection: AwsConnection, topicArn: string) => wrap(() => listSubscriptions(connection, topicArn)))
  ipcMain.handle('sns:subscribe', async (_event, connection: AwsConnection, topicArn: string, protocol: string, endpoint: string) =>
    wrap(() => subscribe(connection, topicArn, protocol, endpoint))
  )
  ipcMain.handle('sns:unsubscribe', async (_event, connection: AwsConnection, subscriptionArn: string) => wrap(() => unsubscribe(connection, subscriptionArn)))
  ipcMain.handle('sns:publish', async (_event, connection: AwsConnection, topicArn: string, message: string, subject?: string, groupId?: string, dedupId?: string) =>
    wrap(() => publishMessage(connection, topicArn, message, subject, groupId, dedupId))
  )
  ipcMain.handle('sns:tag', async (_event, connection: AwsConnection, topicArn: string, tags: Record<string, string>) => wrap(() => tagTopic(connection, topicArn, tags)))
  ipcMain.handle('sns:untag', async (_event, connection: AwsConnection, topicArn: string, tagKeys: string[]) => wrap(() => untagTopic(connection, topicArn, tagKeys)))

  ipcMain.handle('sqs:list-queues', async (_event, connection: AwsConnection) => wrap(() => listQueues(connection)))
  ipcMain.handle('sqs:get-queue', async (_event, connection: AwsConnection, queueUrl: string) => wrap(() => getQueueDetail(connection, queueUrl)))
  ipcMain.handle('sqs:create-queue', async (_event, connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) =>
    wrap(() => createQueue(connection, name, fifo, attrs))
  )
  ipcMain.handle('sqs:delete-queue', async (_event, connection: AwsConnection, queueUrl: string) => wrap(() => deleteQueue(connection, queueUrl)))
  ipcMain.handle('sqs:purge-queue', async (_event, connection: AwsConnection, queueUrl: string) => wrap(() => purgeQueue(connection, queueUrl)))
  ipcMain.handle('sqs:set-attributes', async (_event, connection: AwsConnection, queueUrl: string, attrs: Record<string, string>) =>
    wrap(() => setQueueAttributes(connection, queueUrl, attrs))
  )
  ipcMain.handle('sqs:send-message', async (_event, connection: AwsConnection, queueUrl: string, body: string, delay?: number, groupId?: string, dedupId?: string) =>
    wrap(() => sendMessage(connection, queueUrl, body, delay, groupId, dedupId))
  )
  ipcMain.handle('sqs:receive-messages', async (_event, connection: AwsConnection, queueUrl: string, max: number, wait: number) =>
    wrap(() => receiveMessages(connection, queueUrl, max, wait))
  )
  ipcMain.handle('sqs:delete-message', async (_event, connection: AwsConnection, queueUrl: string, receiptHandle: string) =>
    wrap(() => deleteMessage(connection, queueUrl, receiptHandle))
  )
  ipcMain.handle('sqs:change-visibility', async (_event, connection: AwsConnection, queueUrl: string, receiptHandle: string, timeout: number) =>
    wrap(() => changeMessageVisibility(connection, queueUrl, receiptHandle, timeout))
  )
  ipcMain.handle('sqs:tag', async (_event, connection: AwsConnection, queueUrl: string, tags: Record<string, string>) => wrap(() => tagQueue(connection, queueUrl, tags)))
  ipcMain.handle('sqs:untag', async (_event, connection: AwsConnection, queueUrl: string, tagKeys: string[]) => wrap(() => untagQueue(connection, queueUrl, tagKeys)))
  ipcMain.handle('sqs:timeline', async (_event, connection: AwsConnection, queueUrl: string) =>
    wrap(async () => buildQueueTimeline(await getQueueDetail(connection, queueUrl)))
  )
}
