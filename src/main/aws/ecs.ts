import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
  StopTaskCommand,
  UpdateServiceCommand
} from '@aws-sdk/client-ecs'
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'

import type {
  AwsConnection,
  EcsClusterSummary,
  EcsContainerSummary,
  EcsFargateServiceConfig,
  EcsLogEvent,
  EcsServiceDetail,
  EcsServiceSummary,
  EcsTaskSummary
} from '@shared/types'
import { awsClientConfig } from './client'

export async function listClusters(connection: AwsConnection): Promise<EcsClusterSummary[]> {
  const client = new ECSClient(awsClientConfig(connection))
  const listOutput = await client.send(new ListClustersCommand({}))
  const arns = listOutput.clusterArns ?? []
  if (!arns.length) return []

  const describeOutput = await client.send(new DescribeClustersCommand({ clusters: arns }))
  return (describeOutput.clusters ?? []).map((c) => ({
    clusterName: c.clusterName ?? '-',
    clusterArn: c.clusterArn ?? '-',
    status: c.status ?? '-',
    activeServicesCount: c.activeServicesCount ?? 0,
    runningTasksCount: c.runningTasksCount ?? 0,
    pendingTasksCount: c.pendingTasksCount ?? 0,
    registeredContainerInstancesCount: c.registeredContainerInstancesCount ?? 0
  }))
}

export async function listServices(connection: AwsConnection, clusterArn: string): Promise<EcsServiceSummary[]> {
  const client = new ECSClient(awsClientConfig(connection))
  const serviceArns: string[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListServicesCommand({ cluster: clusterArn, nextToken }))
    serviceArns.push(...(output.serviceArns ?? []))
    nextToken = output.nextToken
  } while (nextToken)

  if (!serviceArns.length) return []

  // DescribeServices accepts max 10 at a time
  const results: EcsServiceSummary[] = []
  for (let i = 0; i < serviceArns.length; i += 10) {
    const batch = serviceArns.slice(i, i + 10)
    const output = await client.send(new DescribeServicesCommand({ cluster: clusterArn, services: batch }))
    for (const s of output.services ?? []) {
      const primaryDeployment = s.deployments?.find((d) => d.status === 'PRIMARY')
      results.push({
        serviceName: s.serviceName ?? '-',
        serviceArn: s.serviceArn ?? '-',
        status: s.status ?? '-',
        desiredCount: s.desiredCount ?? 0,
        runningCount: s.runningCount ?? 0,
        pendingCount: s.pendingCount ?? 0,
        launchType: s.launchType ?? s.capacityProviderStrategy?.[0]?.capacityProvider ?? '-',
        taskDefinition: s.taskDefinition ?? '-',
        deploymentStatus: primaryDeployment?.rolloutState ?? '-'
      })
    }
  }
  return results
}

export async function describeService(
  connection: AwsConnection,
  clusterArn: string,
  serviceName: string
): Promise<EcsServiceDetail> {
  const client = new ECSClient(awsClientConfig(connection))
  const output = await client.send(new DescribeServicesCommand({ cluster: clusterArn, services: [serviceName] }))
  const s = output.services?.[0]
  if (!s) throw new Error(`Service ${serviceName} not found`)

  const netConfig = s.networkConfiguration?.awsvpcConfiguration
  return {
    serviceName: s.serviceName ?? '-',
    serviceArn: s.serviceArn ?? '-',
    clusterArn: s.clusterArn ?? '-',
    status: s.status ?? '-',
    desiredCount: s.desiredCount ?? 0,
    runningCount: s.runningCount ?? 0,
    pendingCount: s.pendingCount ?? 0,
    launchType: s.launchType ?? '-',
    taskDefinition: s.taskDefinition ?? '-',
    platformVersion: s.platformVersion ?? '-',
    networkMode: netConfig ? 'awsvpc' : '-',
    subnets: netConfig?.subnets ?? [],
    securityGroups: netConfig?.securityGroups ?? [],
    assignPublicIp: netConfig?.assignPublicIp ?? '-',
    createdAt: s.createdAt?.toISOString() ?? '-',
    deployments: (s.deployments ?? []).map((d) => ({
      id: d.id ?? '-',
      status: d.status ?? '-',
      taskDefinition: d.taskDefinition ?? '-',
      desiredCount: d.desiredCount ?? 0,
      runningCount: d.runningCount ?? 0,
      pendingCount: d.pendingCount ?? 0,
      rolloutState: d.rolloutState ?? '-',
      createdAt: d.createdAt?.toISOString() ?? '-',
      updatedAt: d.updatedAt?.toISOString() ?? '-'
    })),
    events: (s.events ?? []).slice(0, 25).map((e) => ({
      id: e.id ?? '-',
      createdAt: e.createdAt?.toISOString() ?? '-',
      message: e.message ?? ''
    }))
  }
}

export async function listTasks(
  connection: AwsConnection,
  clusterArn: string,
  serviceName?: string
): Promise<EcsTaskSummary[]> {
  const client = new ECSClient(awsClientConfig(connection))
  const taskArns: string[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListTasksCommand({
        cluster: clusterArn,
        serviceName,
        nextToken
      })
    )
    taskArns.push(...(output.taskArns ?? []))
    nextToken = output.nextToken
  } while (nextToken)

  if (!taskArns.length) return []

  // DescribeTasks accepts max 100 at a time
  const results: EcsTaskSummary[] = []
  for (let i = 0; i < taskArns.length; i += 100) {
    const batch = taskArns.slice(i, i + 100)
    const output = await client.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: batch }))
    for (const t of output.tasks ?? []) {
      results.push({
        taskArn: t.taskArn ?? '-',
        taskDefinitionArn: t.taskDefinitionArn ?? '-',
        lastStatus: t.lastStatus ?? '-',
        desiredStatus: t.desiredStatus ?? '-',
        launchType: t.launchType ?? '-',
        startedAt: t.startedAt?.toISOString() ?? '-',
        stoppedAt: t.stoppedAt?.toISOString() ?? '-',
        stoppedReason: t.stoppedReason ?? '',
        cpu: t.cpu ?? '-',
        memory: t.memory ?? '-',
        group: t.group ?? '-',
        containers: (t.containers ?? []).map((c) => {
          const logDriver = t.overrides?.containerOverrides?.find(
            (o) => o.name === c.name
          )
          void logDriver
          // Extract log config from task definition name pattern
          const logOptions = extractLogInfo(t.taskDefinitionArn ?? '', c.name ?? '')
          return {
            name: c.name ?? '-',
            containerArn: c.containerArn ?? '-',
            lastStatus: c.lastStatus ?? '-',
            exitCode: c.exitCode ?? null,
            image: c.image ?? '-',
            cpu: c.cpu ?? '-',
            memory: c.memory ?? '-',
            healthStatus: c.healthStatus ?? '-',
            logGroup: logOptions.logGroup,
            logStream: logOptions.logStream
          }
        })
      })
    }
  }
  return results
}

function extractLogInfo(
  taskDefinitionArn: string,
  containerName: string
): { logGroup: string; logStream: string } {
  // Typical awslogs pattern: /ecs/<task-family>
  // Log stream: <prefix>/<container-name>/<task-id>
  const taskId = taskDefinitionArn.split('/').pop()?.split(':')[0] ?? ''
  return {
    logGroup: `/ecs/${taskId}`,
    logStream: `ecs/${containerName}`
  }
}

export async function updateDesiredCount(
  connection: AwsConnection,
  clusterArn: string,
  serviceName: string,
  desiredCount: number
): Promise<void> {
  const client = new ECSClient(awsClientConfig(connection))
  await client.send(
    new UpdateServiceCommand({
      cluster: clusterArn,
      service: serviceName,
      desiredCount
    })
  )
}

export async function forceRedeploy(
  connection: AwsConnection,
  clusterArn: string,
  serviceName: string
): Promise<void> {
  const client = new ECSClient(awsClientConfig(connection))
  await client.send(
    new UpdateServiceCommand({
      cluster: clusterArn,
      service: serviceName,
      forceNewDeployment: true
    })
  )
}

export async function stopTask(
  connection: AwsConnection,
  clusterArn: string,
  taskArn: string,
  reason?: string
): Promise<void> {
  const client = new ECSClient(awsClientConfig(connection))
  await client.send(
    new StopTaskCommand({
      cluster: clusterArn,
      task: taskArn,
      reason: reason || 'Stopped from AWS Lens console'
    })
  )
}

export async function deleteService(
  connection: AwsConnection,
  clusterArn: string,
  serviceName: string
): Promise<void> {
  const client = new ECSClient(awsClientConfig(connection))
  // Scale to 0 first, then delete
  await client.send(
    new UpdateServiceCommand({
      cluster: clusterArn,
      service: serviceName,
      desiredCount: 0
    })
  )
  await client.send(
    new DeleteServiceCommand({
      cluster: clusterArn,
      service: serviceName,
      force: true
    })
  )
}

export async function createFargateService(
  connection: AwsConnection,
  config: EcsFargateServiceConfig
): Promise<void> {
  const client = new ECSClient(awsClientConfig(connection))
  await client.send(
    new CreateServiceCommand({
      cluster: config.clusterArn,
      serviceName: config.serviceName,
      taskDefinition: config.taskDefinition,
      desiredCount: config.desiredCount,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.subnets,
          securityGroups: config.securityGroups,
          assignPublicIp: config.assignPublicIp ? 'ENABLED' : 'DISABLED'
        }
      }
    })
  )
}

export async function getContainerLogs(
  connection: AwsConnection,
  logGroup: string,
  logStream: string,
  startTime?: number
): Promise<EcsLogEvent[]> {
  const client = new CloudWatchLogsClient(awsClientConfig(connection))
  const output = await client.send(
    new GetLogEventsCommand({
      logGroupName: logGroup,
      logStreamName: logStream,
      startFromHead: false,
      startTime,
      limit: 200
    })
  )
  return (output.events ?? []).map((e) => ({
    timestamp: e.timestamp ?? 0,
    message: e.message ?? ''
  }))
}
