import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
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
  EcsDiagnosticsIndicator,
  EcsDiagnosticsLogTarget,
  EcsDiagnosticsStatus,
  EcsDiagnosticsTaskRow,
  EcsDiagnosticsTaskSelection,
  EcsDiagnosticsTimelineItem,
  EcsFargateServiceConfig,
  EcsLogEvent,
  EcsServiceDiagnostics,
  EcsServiceDetail,
  EcsServiceSummary,
  EcsTaskDefinitionReference,
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
  return listTasksByDesiredStatus(connection, clusterArn, serviceName)
}

async function listTasksByDesiredStatus(
  connection: AwsConnection,
  clusterArn: string,
  serviceName?: string,
  desiredStatus?: 'RUNNING' | 'STOPPED'
): Promise<EcsTaskSummary[]> {
  const client = new ECSClient(awsClientConfig(connection))
  const taskArns: string[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListTasksCommand({
        cluster: clusterArn,
        serviceName,
        desiredStatus,
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
            reason: c.reason ?? '',
            image: c.image ?? '-',
            imageDigest: c.imageDigest ?? '',
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

export async function getServiceDiagnostics(
  connection: AwsConnection,
  clusterArn: string,
  serviceName: string
): Promise<EcsServiceDiagnostics> {
  const client = new ECSClient(awsClientConfig(connection))
  const service = await describeService(connection, clusterArn, serviceName)
  const [runningTasks, stoppedTasks, taskDefinition] = await Promise.all([
    listTasksByDesiredStatus(connection, clusterArn, serviceName, 'RUNNING'),
    listTasksByDesiredStatus(connection, clusterArn, serviceName, 'STOPPED'),
    describeTaskDefinitionReference(client, service.taskDefinition)
  ])

  const stoppedTaskRows = stoppedTasks
    .sort((left, right) => byTimestampDesc(left.stoppedAt, right.stoppedAt))
    .slice(0, 20)

  const taskRows = enrichTaskRowsWithLogConfig(
    [...runningTasks, ...stoppedTaskRows].map((task) => toDiagnosticsTaskRow(task)),
    taskDefinition
  )
    .sort((left, right) => {
      const leftTs = left.stoppedAt !== '-' ? left.stoppedAt : left.startedAt
      const rightTs = right.stoppedAt !== '-' ? right.stoppedAt : right.startedAt
      return byTimestampDesc(leftTs, rightTs)
    })

  const unstableTasks = taskRows.filter((task) => task.isFailed || task.healthStatus === 'UNHEALTHY').slice(0, 10)
  const failedTasks = taskRows.filter((task) => task.isFailed).slice(0, 10)
  const pendingTasks = taskRows.filter((task) => task.isPending).slice(0, 10)
  const selectedTask = toTaskSelection(taskRows[0] ?? null)
  const logTargets = buildLogTargets(taskRows)
  const indicators = buildIndicators(service, taskRows, logTargets)
  const summaryTiles = buildSummaryTiles(service, taskRows, indicators)
  const timeline = buildTimeline(service, taskRows)
  const likelyPatterns = buildLikelyPatterns(indicators, service, taskRows)

  return {
    service,
    deployments: service.deployments,
    summaryTiles,
    indicators,
    likelyPatterns,
    timeline,
    recentDeployments: service.deployments.slice(0, 5),
    unstableTasks,
    failedTasks,
    pendingTasks,
    taskRows,
    selectedTask,
    taskDefinition,
    logTargets
  }
}

async function describeTaskDefinitionReference(
  client: ECSClient,
  taskDefinitionArn: string
): Promise<EcsTaskDefinitionReference | null> {
  if (!taskDefinitionArn || taskDefinitionArn === '-') {
    return null
  }

  const output = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }))
  const definition = output.taskDefinition
  if (!definition) {
    return null
  }

  return {
    taskDefinitionArn: definition.taskDefinitionArn ?? taskDefinitionArn,
    family: definition.family ?? '-',
    revision: definition.revision ?? 0,
    networkMode: definition.networkMode ?? '-',
    executionRoleArn: definition.executionRoleArn ?? '',
    taskRoleArn: definition.taskRoleArn ?? '',
    containerImages: (definition.containerDefinitions ?? []).map((container) => ({
      name: container.name ?? '-',
      image: container.image ?? '-',
      imageDigest: '',
      cpu: String(container.cpu ?? '-'),
      memory: String(container.memory ?? '-'),
      essential: container.essential ?? false,
      logDriver: container.logConfiguration?.logDriver ?? '',
      logGroup: container.logConfiguration?.options?.['awslogs-group'] ?? '',
      logRegion: container.logConfiguration?.options?.['awslogs-region'] ?? '',
      logStreamPrefix: container.logConfiguration?.options?.['awslogs-stream-prefix'] ?? ''
    }))
  }
}

function toDiagnosticsTaskRow(task: EcsTaskSummary): EcsDiagnosticsTaskRow {
  const containerStates = task.containers.map((container) => container.lastStatus).filter(Boolean)
  const healthStatuses = task.containers.map((container) => container.healthStatus).filter((status) => status && status !== '-')
  const hasNonZeroExit = task.containers.some((container) => (container.exitCode ?? 0) !== 0 && container.exitCode !== null)
  const unhealthy = healthStatuses.includes('UNHEALTHY')
  const taskId = task.taskArn.split('/').pop() ?? task.taskArn

  return {
    taskArn: task.taskArn,
    taskId,
    taskDefinitionArn: task.taskDefinitionArn,
    lastStatus: task.lastStatus,
    desiredStatus: task.desiredStatus,
    startedAt: task.startedAt,
    stoppedAt: task.stoppedAt,
    stoppedReason: task.stoppedReason,
    launchType: task.launchType,
    healthStatus: unhealthy ? 'UNHEALTHY' : healthStatuses[0] ?? inferTaskHealthFromContainers(containerStates),
    isFailed: task.lastStatus === 'STOPPED' || hasNonZeroExit || unhealthy,
    isPending: task.lastStatus === 'PENDING' || task.desiredStatus === 'PENDING',
    containers: task.containers
  }
}

function inferTaskHealthFromContainers(containerStates: string[]): string {
  if (containerStates.includes('PENDING')) return 'PENDING'
  if (containerStates.includes('RUNNING')) return 'RUNNING'
  if (containerStates.includes('STOPPED')) return 'STOPPED'
  return '-'
}

function toTaskSelection(task: EcsDiagnosticsTaskRow | null): EcsDiagnosticsTaskSelection | null {
  if (!task) return null

  return {
    taskArn: task.taskArn,
    taskId: task.taskId,
    stoppedReason: task.stoppedReason,
    lastStatus: task.lastStatus,
    desiredStatus: task.desiredStatus,
    startedAt: task.startedAt,
    stoppedAt: task.stoppedAt,
    healthStatus: task.healthStatus,
    containers: task.containers
  }
}

function buildLogTargets(taskRows: EcsDiagnosticsTaskRow[]): EcsDiagnosticsLogTarget[] {
  return taskRows.flatMap((task) =>
    task.containers.map((container) => ({
      taskArn: task.taskArn,
      taskId: task.taskId,
      containerName: container.name,
      logGroup: container.logGroup,
      logStream: container.logStream,
      available: Boolean(container.logGroup && container.logStream),
      reason: container.logGroup && container.logStream ? '' : 'No awslogs configuration detected'
    }))
  )
}

function enrichTaskRowsWithLogConfig(
  taskRows: EcsDiagnosticsTaskRow[],
  taskDefinition: EcsTaskDefinitionReference | null
): EcsDiagnosticsTaskRow[] {
  if (!taskDefinition) return taskRows

  const containerConfig = new Map(
    taskDefinition.containerImages.map((container) => [container.name, container] as const)
  )

  return taskRows.map((task) => ({
    ...task,
    containers: task.containers.map((container) => {
      const config = containerConfig.get(container.name)
      if (!config || config.logDriver !== 'awslogs') {
        return container
      }

      const logGroup = config.logGroup || container.logGroup
      const logStream = config.logStreamPrefix && task.taskId
        ? `${config.logStreamPrefix}/${container.name}/${task.taskId}`
        : container.logStream

      return {
        ...container,
        logGroup,
        logStream
      }
    })
  }))
}

function buildIndicators(
  service: EcsServiceDetail,
  taskRows: EcsDiagnosticsTaskRow[],
  logTargets: EcsDiagnosticsLogTarget[]
): EcsDiagnosticsIndicator[] {
  const activeDeployment = service.deployments.find((deployment) => deployment.status === 'PRIMARY') ?? service.deployments[0]
  const failedTasks = taskRows.filter((task) => task.isFailed)
  const repeatedFailures = failedTasks.length >= 3
  const deploymentAgeMinutes = minutesSince(activeDeployment?.updatedAt ?? activeDeployment?.createdAt ?? '-')
  const deploymentStuck = Boolean(
    activeDeployment &&
    activeDeployment.rolloutState === 'IN_PROGRESS' &&
    deploymentAgeMinutes !== null &&
    deploymentAgeMinutes >= 15 &&
    activeDeployment.runningCount < activeDeployment.desiredCount
  )
  const noLogsDetected = logTargets.length > 0 && logTargets.every((target) => !target.available)
  const unhealthyTargets = service.events.some((event) => /unhealthy|target group|health check/i.test(event.message))
  const nonZeroExit = taskRows.some((task) => task.containers.some((container) => (container.exitCode ?? 0) > 0))

  return [
    {
      id: 'under-provisioned',
      title: 'Under desired count',
      severity: service.runningCount < service.desiredCount ? 'warning' : 'info',
      status: service.runningCount < service.desiredCount ? 'detected' : 'clear',
      detail: service.runningCount < service.desiredCount
        ? `Service is running ${service.runningCount} of ${service.desiredCount} desired tasks.`
        : 'Running count matches desired count.'
    },
    {
      id: 'repeated-failures',
      title: 'Repeated task failures',
      severity: repeatedFailures ? 'critical' : 'info',
      status: repeatedFailures ? 'detected' : 'clear',
      detail: repeatedFailures
        ? `${failedTasks.length} recent tasks stopped or failed health checks.`
        : 'No repeated task failure pattern detected.'
    },
    {
      id: 'deployment-stuck',
      title: 'Deployment stuck in progress',
      severity: deploymentStuck ? 'warning' : 'info',
      status: deploymentStuck ? 'detected' : 'clear',
      detail: deploymentStuck
        ? `Primary deployment has remained in progress for ${deploymentAgeMinutes} minutes without reaching desired running count.`
        : 'No stuck deployment pattern detected.'
    },
    {
      id: 'non-zero-exit',
      title: 'Containers exiting non-zero',
      severity: nonZeroExit ? 'critical' : 'info',
      status: nonZeroExit ? 'detected' : 'clear',
      detail: nonZeroExit
        ? 'At least one container exited with a non-zero code in recent tasks.'
        : 'No non-zero container exit codes detected.'
    },
    {
      id: 'missing-logs-or-unhealthy-targets',
      title: 'Logs or target health gap',
      severity: noLogsDetected || unhealthyTargets ? 'warning' : 'info',
      status: noLogsDetected || unhealthyTargets ? 'detected' : 'clear',
      detail: noLogsDetected
        ? 'Container log streams could not be detected from the recent task set.'
        : unhealthyTargets
        ? 'Recent service events mention unhealthy targets or health-check failures.'
        : 'Logs and target health signals look available.'
    }
  ]
}

function buildSummaryTiles(
  service: EcsServiceDetail,
  taskRows: EcsDiagnosticsTaskRow[],
  indicators: EcsDiagnosticsIndicator[]
): Array<{ key: string; label: string; value: string; tone: EcsDiagnosticsStatus; detail: string }> {
  const activeDeployment = service.deployments.find((deployment) => deployment.status === 'PRIMARY') ?? service.deployments[0]
  const failedTasks = taskRows.filter((task) => task.isFailed).length
  const pendingTasks = taskRows.filter((task) => task.isPending).length
  const warningCount = indicators.filter((indicator) => indicator.status === 'detected').length

  return [
    {
      key: 'rollout',
      label: 'Rollout',
      value: activeDeployment?.rolloutState ?? service.status,
      tone: toneFromRollout(activeDeployment?.rolloutState),
      detail: activeDeployment ? `${activeDeployment.runningCount}/${activeDeployment.desiredCount} tasks in primary deployment.` : 'No active deployment information.'
    },
    {
      key: 'capacity',
      label: 'Desired vs Running',
      value: `${service.runningCount}/${service.desiredCount}`,
      tone: service.runningCount < service.desiredCount ? 'warning' : 'healthy',
      detail: `${service.pendingCount} tasks pending.`
    },
    {
      key: 'failed',
      label: 'Failed Tasks',
      value: String(failedTasks),
      tone: failedTasks > 0 ? 'critical' : 'healthy',
      detail: 'Recent tasks with stop/failure signals.'
    },
    {
      key: 'pending',
      label: 'Pending Tasks',
      value: String(pendingTasks),
      tone: pendingTasks > 0 ? 'warning' : 'healthy',
      detail: 'Tasks still waiting to start.'
    },
    {
      key: 'signals',
      label: 'Health Signals',
      value: String(warningCount),
      tone: warningCount >= 3 ? 'critical' : warningCount > 0 ? 'warning' : 'healthy',
      detail: 'Derived deployment diagnostics currently raised.'
    }
  ]
}

function buildTimeline(service: EcsServiceDetail, taskRows: EcsDiagnosticsTaskRow[]): EcsDiagnosticsTimelineItem[] {
  const deploymentItems = service.deployments.map((deployment) => ({
    id: `deployment:${deployment.id}`,
    timestamp: deployment.updatedAt !== '-' ? deployment.updatedAt : deployment.createdAt,
    category: 'deployment' as const,
    severity: deployment.rolloutState === 'FAILED' ? 'critical' as const : deployment.rolloutState === 'IN_PROGRESS' ? 'warning' as const : 'info' as const,
    title: `Deployment ${deployment.id.slice(0, 8)} ${deployment.rolloutState.toLowerCase()}`,
    detail: `${deployment.runningCount}/${deployment.desiredCount} tasks on ${deployment.taskDefinition.split('/').pop() ?? deployment.taskDefinition}`
  }))

  const taskStopItems = taskRows
    .filter((task) => task.stoppedAt !== '-' || task.isFailed)
    .slice(0, 12)
    .map((task) => ({
      id: `task:${task.taskArn}`,
      timestamp: task.stoppedAt !== '-' ? task.stoppedAt : task.startedAt,
      category: 'task-stop' as const,
      severity: task.isFailed ? 'critical' as const : 'info' as const,
      title: `Task ${task.taskId} ${task.lastStatus.toLowerCase()}`,
      detail: task.stoppedReason || summarizeContainerIssues(task.containers) || 'Task state changed.',
      relatedTaskArn: task.taskArn
    }))

  const eventItems = service.events.slice(0, 12).map((event) => ({
    id: `event:${event.id}`,
    timestamp: event.createdAt,
    category: 'service-event' as const,
    severity: /unable|failed|unhealthy|error/i.test(event.message) ? 'critical' as const : /steady state|registered/i.test(event.message) ? 'info' as const : 'warning' as const,
    title: summarizeEventTitle(event.message),
    detail: event.message
  }))

  return [...deploymentItems, ...taskStopItems, ...eventItems]
    .sort((left, right) => byTimestampDesc(left.timestamp, right.timestamp))
    .slice(0, 24)
}

function buildLikelyPatterns(
  indicators: EcsDiagnosticsIndicator[],
  service: EcsServiceDetail,
  taskRows: EcsDiagnosticsTaskRow[]
): string[] {
  const patterns: string[] = []
  const failedTasks = taskRows.filter((task) => task.isFailed)
  const nonZeroContainers = failedTasks.flatMap((task) => task.containers.filter((container) => (container.exitCode ?? 0) > 0))

  if (service.runningCount < service.desiredCount) {
    patterns.push(`Service is under target capacity at ${service.runningCount}/${service.desiredCount}, which usually means placement, startup, or health-check failures are preventing replacement tasks from stabilizing.`)
  }

  if (nonZeroContainers.length > 0) {
    const container = nonZeroContainers[0]
    patterns.push(`Container ${container.name} has recent non-zero exits${container.exitCode !== null ? ` (${container.exitCode})` : ''}, which points to application startup failure, crash-looping, or missing runtime configuration.`)
  }

  if (indicators.some((indicator) => indicator.id === 'deployment-stuck' && indicator.status === 'detected')) {
    patterns.push('The primary deployment is still in progress beyond the normal stabilization window, which usually means new tasks are not becoming healthy quickly enough to replace the old set.')
  }

  if (service.events.some((event) => /target group|health check|unhealthy/i.test(event.message))) {
    patterns.push('Recent service events mention target health problems, so load balancer registration or application readiness checks are likely blocking the rollout.')
  }

  if (patterns.length === 0) {
    patterns.push('No dominant failure pattern was derived from the latest deployments, tasks, and service events.')
  }

  return patterns
}

function summarizeContainerIssues(containers: EcsContainerSummary[]): string {
  const failing = containers.find((container) => (container.exitCode ?? 0) > 0)
  if (failing) {
    return `${failing.name} exited with code ${failing.exitCode}.`
  }

  const unhealthy = containers.find((container) => container.healthStatus === 'UNHEALTHY')
  if (unhealthy) {
    return `${unhealthy.name} reported unhealthy container health.`
  }

  return ''
}

function summarizeEventTitle(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return 'Service event'
  const firstSentence = trimmed.split('. ')[0] ?? trimmed
  return firstSentence.length > 88 ? `${firstSentence.slice(0, 85)}...` : firstSentence
}

function toneFromRollout(rolloutState?: string): EcsDiagnosticsStatus {
  if (!rolloutState || rolloutState === '-') return 'unknown'
  if (rolloutState === 'COMPLETED') return 'healthy'
  if (rolloutState === 'FAILED') return 'critical'
  if (rolloutState === 'IN_PROGRESS') return 'warning'
  return 'unknown'
}

function byTimestampDesc(left: string, right: string): number {
  return parseTimestamp(right) - parseTimestamp(left)
}

function parseTimestamp(value: string): number {
  if (!value || value === '-') return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function minutesSince(value: string): number | null {
  const timestamp = parseTimestamp(value)
  if (!timestamp) return null
  return Math.floor((Date.now() - timestamp) / 60000)
}

function extractLogInfo(
  _taskDefinitionArn: string,
  _containerName: string
): { logGroup: string; logStream: string } {
  return {
    logGroup: '',
    logStream: ''
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
