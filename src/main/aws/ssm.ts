import { spawn } from 'node:child_process'

import {
  DescribeInstancesCommand,
  DescribeRouteTablesCommand,
  DescribeSubnetsCommand,
  DescribeVpcEndpointsCommand,
  EC2Client,
  type Instance,
  type RouteTable,
  type Subnet
} from '@aws-sdk/client-ec2'
import {
  GetInstanceProfileCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand
} from '@aws-sdk/client-iam'
import {
  DescribeInstanceInformationCommand,
  DescribeSessionsCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
  SSMClient,
  type InstanceInformation,
  type SessionFilter,
  type Session
} from '@aws-sdk/client-ssm'

import { awsClientConfig, readTags } from './client'
import { buildAwsCliCommand } from '../shell'
import type {
  AwsConnection,
  Ec2SsmStatus,
  SsmCommandExecutionResult,
  SsmConnectionDiagnostic,
  SsmConnectionTarget,
  SsmManagedInstanceSummary,
  SsmPortForwardPreset,
  SsmSendCommandRequest,
  SsmSessionLaunchSpec,
  SsmSessionSummary,
  SsmStartSessionRequest
} from '@shared/types'

const TEMP_PURPOSE_TAG = 'aws-lens:purpose'
const TEMP_PURPOSE_EBS_INSPECTION = 'ebs-inspection'
const TEMP_SOURCE_VOLUME_TAG = 'aws-lens:source-volume-id'
const SSM_MANAGED_POLICY_ARN = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'
const TERMINAL_COMMAND_TIMEOUTS = new Set([
  'Success',
  'Cancelled',
  'TimedOut',
  'Failed',
  'Cancelling',
  'Undeliverable',
  'Terminated'
])

function createEc2Client(connection: AwsConnection): EC2Client {
  return new EC2Client(awsClientConfig(connection))
}

function createIamClient(connection: AwsConnection): IAMClient {
  return new IAMClient(awsClientConfig(connection))
}

function createSsmClient(connection: AwsConnection): SSMClient {
  return new SSMClient(awsClientConfig(connection))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTempInspectionInstance(instance: Instance | null | undefined): boolean {
  return readTags(instance?.Tags)[TEMP_PURPOSE_TAG] === TEMP_PURPOSE_EBS_INSPECTION
}

function sourceVolumeId(instance: Instance | null | undefined): string {
  return readTags(instance?.Tags)[TEMP_SOURCE_VOLUME_TAG] ?? '-'
}

async function loadInstance(ec2Client: EC2Client, instanceId: string): Promise<Instance | null> {
  const output = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
  for (const reservation of output.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      return instance
    }
  }
  return null
}

async function listAllEc2Instances(ec2Client: EC2Client): Promise<Instance[]> {
  const instances: Instance[] = []
  let nextToken: string | undefined

  do {
    const output = await ec2Client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
    for (const reservation of output.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        instances.push(instance)
      }
    }
    nextToken = output.NextToken
  } while (nextToken)

  return instances
}

async function listManagedInstanceInformation(ssmClient: SSMClient, instanceIds?: string[]): Promise<InstanceInformation[]> {
  const rows: InstanceInformation[] = []
  let nextToken: string | undefined

  do {
    const output = await ssmClient.send(
      new DescribeInstanceInformationCommand({
        NextToken: nextToken,
        Filters: instanceIds && instanceIds.length > 0 ? [{ Key: 'InstanceIds', Values: instanceIds }] : undefined
      })
    )
    rows.push(...(output.InstanceInformationList ?? []))
    nextToken = output.NextToken
  } while (nextToken)

  return rows
}

function toManagedInstanceSummary(info: InstanceInformation, instance: Instance | null | undefined): SsmManagedInstanceSummary {
  const tags = readTags(instance?.Tags)

  return {
    instanceId: instance?.InstanceId ?? info.InstanceId ?? '-',
    managedInstanceId: info.InstanceId ?? '-',
    name: tags.Name ?? '-',
    computerName: info.ComputerName ?? '-',
    pingStatus: info.PingStatus ?? '-',
    lastPingAt: info.LastPingDateTime?.toISOString() ?? '-',
    agentVersion: info.AgentVersion ?? '-',
    isLatestVersion: info.IsLatestVersion ?? false,
    platformType: info.PlatformType ?? '-',
    platformName: info.PlatformName ?? '-',
    platformVersion: info.PlatformVersion ?? '-',
    resourceType: info.ResourceType ?? '-',
    ipAddress: info.IPAddress ?? instance?.PrivateIpAddress ?? '-',
    source: isTempInspectionInstance(instance) ? 'temp-inspection' : 'ec2',
    sourceVolumeId: sourceVolumeId(instance)
  }
}

function directPortForwardPresets(instance: Instance | null | undefined): SsmPortForwardPreset[] {
  const isWindows = /windows/i.test(instance?.PlatformDetails ?? '')

  return [
    {
      id: isWindows ? 'rdp' : 'ssh',
      label: isWindows ? 'RDP 3389' : 'SSH 22',
      description: isWindows
        ? 'Forward local 13389 to the instance RDP port 3389.'
        : 'Forward local 10022 to the instance SSH port 22.',
      documentName: 'AWS-StartPortForwardingSession',
      localPort: isWindows ? 13389 : 10022,
      remotePort: isWindows ? 3389 : 22,
      remoteHost: ''
    },
    {
      id: 'postgres-5432',
      label: 'Postgres 5432',
      description: 'Forward local 15432 to the instance port 5432.',
      documentName: 'AWS-StartPortForwardingSession',
      localPort: 15432,
      remotePort: 5432,
      remoteHost: ''
    }
  ]
}

async function hasAwsManagedSsmPolicy(iamClient: IAMClient, instance: Instance | null): Promise<boolean | null> {
  const profileArn = instance?.IamInstanceProfile?.Arn
  if (!profileArn) {
    return null
  }

  const profileName = profileArn.split('/').pop()
  if (!profileName) {
    return null
  }

  const profile = await iamClient.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }))
  for (const role of profile.InstanceProfile?.Roles ?? []) {
    if (!role.RoleName) {
      continue
    }
    const attached = await iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: role.RoleName }))
    if ((attached.AttachedPolicies ?? []).some((policy) => policy.PolicyArn === SSM_MANAGED_POLICY_ARN)) {
      return true
    }
  }

  return false
}

async function findRouteTableForSubnet(ec2Client: EC2Client, subnet: Subnet): Promise<RouteTable | null> {
  if (!subnet.SubnetId || !subnet.VpcId) {
    return null
  }

  const direct = await ec2Client.send(
    new DescribeRouteTablesCommand({
      Filters: [{ Name: 'association.subnet-id', Values: [subnet.SubnetId] }]
    })
  )
  const directTable = direct.RouteTables?.find((table) => table.RouteTableId)
  if (directTable) {
    return directTable
  }

  const main = await ec2Client.send(
    new DescribeRouteTablesCommand({
      Filters: [
        { Name: 'vpc-id', Values: [subnet.VpcId] },
        { Name: 'association.main', Values: ['true'] }
      ]
    })
  )

  return main.RouteTables?.find((table) => table.RouteTableId) ?? null
}

async function vpcHasRequiredSsmEndpoints(ec2Client: EC2Client, vpcId: string): Promise<boolean> {
  const output = await ec2Client.send(
    new DescribeVpcEndpointsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'state', Values: ['available'] }
      ]
    })
  )
  const services = new Set((output.VpcEndpoints ?? []).map((endpoint) => endpoint.ServiceName ?? ''))
  return ['ssm', 'ssmmessages', 'ec2messages'].every((suffix) =>
    [...services].some((service) => service.endsWith(`.${suffix}`) || service.endsWith(`:${suffix}`))
  )
}

async function hasSsmNetworkPath(ec2Client: EC2Client, instance: Instance | null): Promise<boolean | null> {
  if (!instance?.SubnetId) {
    return null
  }

  const subnets = await ec2Client.send(new DescribeSubnetsCommand({ SubnetIds: [instance.SubnetId] }))
  const subnet = subnets.Subnets?.[0]
  if (!subnet) {
    return null
  }

  const routeTable = await findRouteTableForSubnet(ec2Client, subnet)
  const hasOutboundRoute = (routeTable?.Routes ?? []).some((route) =>
    route.DestinationCidrBlock === '0.0.0.0/0' && Boolean(route.GatewayId || route.NatGatewayId || route.TransitGatewayId)
  )
  if (hasOutboundRoute) {
    return true
  }

  return subnet.VpcId ? vpcHasRequiredSsmEndpoints(ec2Client, subnet.VpcId) : null
}

function summarizeStatus(managed: InstanceInformation | undefined): Ec2SsmStatus {
  if (!managed) {
    return 'not-managed'
  }
  return managed.PingStatus === 'Online' ? 'managed-online' : 'managed-offline'
}

function connectionDiagnostics(
  instance: Instance | null,
  managedInfo: InstanceInformation | undefined,
  hasPolicy: boolean | null,
  hasNetworkPath: boolean | null
): SsmConnectionDiagnostic[] {
  const diagnostics: SsmConnectionDiagnostic[] = []

  if ((instance?.State?.Name ?? '') !== 'running') {
    diagnostics.push({
      severity: 'warning',
      code: 'instance-not-running',
      summary: 'Instance is not running.',
      detail: 'Start the instance before attempting a Session Manager shell or command.'
    })
  }

  if (!instance?.IamInstanceProfile?.Arn) {
    diagnostics.push({
      severity: 'error',
      code: 'missing-instance-role',
      summary: 'No instance profile is attached.',
      detail: 'Attach an instance role with AmazonSSMManagedInstanceCore or equivalent SSM permissions.'
    })
  } else if (hasPolicy === false) {
    diagnostics.push({
      severity: 'warning',
      code: 'missing-ssm-policy',
      summary: 'AmazonSSMManagedInstanceCore is not attached to the instance role.',
      detail: 'Attach AmazonSSMManagedInstanceCore, or confirm the role has equivalent inline SSM permissions.'
    })
  }

  if (!managedInfo) {
    diagnostics.push({
      severity: 'error',
      code: 'not-managed',
      summary: 'The instance is not registered as a managed instance.',
      detail: 'Confirm the SSM agent is installed, the instance role is correct, and the instance can reach SSM endpoints.'
    })
  } else if ((managedInfo.PingStatus ?? '') !== 'Online') {
    diagnostics.push({
      severity: 'error',
      code: 'agent-offline',
      summary: `SSM agent status is ${managedInfo.PingStatus ?? 'unknown'}.`,
      detail: 'The instance is registered but not currently reachable through Session Manager.'
    })
  }

  if (hasNetworkPath === false) {
    diagnostics.push({
      severity: 'warning',
      code: 'missing-network-path',
      summary: 'No outbound path or required SSM VPC endpoints were detected.',
      detail: 'Provide NAT/internet egress or create the ssm, ssmmessages, and ec2messages interface endpoints.'
    })
  }

  if (diagnostics.length === 0 && managedInfo?.PingStatus === 'Online') {
    diagnostics.push({
      severity: 'info',
      code: 'ready',
      summary: 'Session Manager connectivity looks healthy.',
      detail: 'The instance is online in SSM and ready for shell sessions or Run Command.'
    })
  }

  return diagnostics
}

async function executableExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise((resolve) => {
    const child = spawn(probe, [command], { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

function toSessionSummary(session: Session, accessType: 'shell' | 'port-forward'): SsmSessionSummary {
  return {
    sessionId: session.SessionId ?? '-',
    target: session.Target ?? '-',
    status: session.Status ?? '-',
    documentName: session.DocumentName ?? '-',
    reason: session.Reason ?? '-',
    owner: session.Owner ?? '-',
    startedAt: session.StartDate?.toISOString() ?? '-',
    endedAt: session.EndDate?.toISOString() ?? '-',
    accessType
  }
}

function formatCliParameters(parameters: Record<string, string[]>): string {
  return Object.entries(parameters)
    .map(([key, values]) => `${key}=${values.map((value) => JSON.stringify(value)).join(',')}`)
    .join(',')
}

export async function listSsmManagedInstances(connection: AwsConnection): Promise<SsmManagedInstanceSummary[]> {
  const ec2Client = createEc2Client(connection)
  const ssmClient = createSsmClient(connection)
  const [ec2Instances, managedInfos] = await Promise.all([
    listAllEc2Instances(ec2Client),
    listManagedInstanceInformation(ssmClient)
  ])

  const instanceMap = new Map(ec2Instances.map((instance) => [instance.InstanceId ?? '', instance]))

  return managedInfos
    .filter((info) => info.ResourceType === 'EC2Instance')
    .map((info) => toManagedInstanceSummary(info, instanceMap.get(info.InstanceId ?? '')))
    .sort((left, right) => {
      if (left.pingStatus !== right.pingStatus) {
        return left.pingStatus === 'Online' ? -1 : 1
      }
      return left.instanceId.localeCompare(right.instanceId)
    })
}

export async function getSsmConnectionTarget(connection: AwsConnection, instanceId: string): Promise<SsmConnectionTarget> {
  const ec2Client = createEc2Client(connection)
  const iamClient = createIamClient(connection)
  const ssmClient = createSsmClient(connection)
  const instance = await loadInstance(ec2Client, instanceId)

  if (!instance) {
    throw new Error(`EC2 instance ${instanceId} was not found`)
  }

  const [managedInfo] = await listManagedInstanceInformation(ssmClient, [instanceId])
  const [hasPolicy, hasNetworkPath] = await Promise.all([
    hasAwsManagedSsmPolicy(iamClient, instance),
    hasSsmNetworkPath(ec2Client, instance)
  ])

  const status = summarizeStatus(managedInfo)
  const managedInstance = managedInfo ? toManagedInstanceSummary(managedInfo, instance) : null
  const diagnostics = connectionDiagnostics(instance, managedInfo, hasPolicy, hasNetworkPath)

  return {
    instanceId,
    instanceName: readTags(instance.Tags).Name ?? '-',
    status,
    managedInstance,
    diagnostics,
    canStartSession: status === 'managed-online' && (instance.State?.Name ?? '') === 'running',
    shellDocumentName: 'SSM-SessionManagerRunShell',
    portForwardPresets: directPortForwardPresets(instance)
  }
}

export async function listSsmSessions(connection: AwsConnection, targetInstanceId?: string): Promise<SsmSessionSummary[]> {
  const ssmClient = createSsmClient(connection)
  const filters: SessionFilter[] | undefined = targetInstanceId ? [{ key: 'Target', value: targetInstanceId }] : undefined
  const [active, history] = await Promise.all([
    ssmClient.send(new DescribeSessionsCommand({ State: 'Active', Filters: filters, MaxResults: 20 })),
    ssmClient.send(new DescribeSessionsCommand({ State: 'History', Filters: filters, MaxResults: 20 }))
  ])

  const entries = [...(active.Sessions ?? []), ...(history.Sessions ?? [])]
  const deduped = new Map<string, SsmSessionSummary>()
  for (const session of entries) {
    const accessType = /PortForward/i.test(session.DocumentName ?? '') ? 'port-forward' : 'shell'
    deduped.set(session.SessionId ?? `${session.Target}-${session.StartDate?.toISOString() ?? ''}`, toSessionSummary(session, accessType))
  }

  return [...deduped.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

export async function startSsmSession(connection: AwsConnection, request: SsmStartSessionRequest): Promise<SsmSessionLaunchSpec> {
  const target = await getSsmConnectionTarget(connection, request.targetInstanceId)
  if (!target.canStartSession) {
    const reason = target.diagnostics
      .filter((item) => item.severity !== 'info')
      .map((item) => item.summary)
      .join(' ')
    throw new Error(reason || `Instance ${request.targetInstanceId} is not ready for Session Manager`)
  }

  const [hasAwsCli, hasPlugin] = await Promise.all([
    executableExists('aws'),
    executableExists('session-manager-plugin')
  ])

  if (!hasAwsCli) {
    throw new Error('AWS CLI is not installed on this machine.')
  }
  if (!hasPlugin) {
    throw new Error('Session Manager Plugin is not installed on this machine.')
  }

  const args = ['ssm', 'start-session', '--target', request.targetInstanceId, '--region', connection.region]
  if (request.documentName) {
    args.push('--document-name', request.documentName)
  }
  if (request.reason?.trim()) {
    args.push('--reason', request.reason.trim())
  }
  if (request.parameters && Object.keys(request.parameters).length > 0) {
    args.push('--parameters', formatCliParameters(request.parameters))
  }

  return {
    summary: {
      sessionId: `launch-${Date.now()}`,
      target: request.targetInstanceId,
      status: 'launching',
      documentName: request.documentName ?? 'SSM-SessionManagerRunShell',
      reason: request.reason?.trim() || '-',
      owner: connection.label,
      startedAt: new Date().toISOString(),
      endedAt: '-',
      accessType: request.accessType ?? 'shell'
    },
    launchCommand: buildAwsCliCommand(args)
  }
}

export async function sendSsmCommand(connection: AwsConnection, request: SsmSendCommandRequest): Promise<SsmCommandExecutionResult> {
  const target = await getSsmConnectionTarget(connection, request.instanceId)
  if (target.status !== 'managed-online') {
    throw new Error(`Instance ${request.instanceId} is not online in Systems Manager.`)
  }

  const ssmClient = createSsmClient(connection)
  const output = await ssmClient.send(
    new SendCommandCommand({
      InstanceIds: [request.instanceId],
      DocumentName: request.documentName,
      Comment: request.comment,
      TimeoutSeconds: request.timeoutSeconds,
      Parameters: request.commands && request.commands.length > 0 ? { commands: request.commands } : undefined
    })
  )
  const commandId = output.Command?.CommandId
  const requestedAt = output.Command?.RequestedDateTime?.toISOString() ?? new Date().toISOString()
  if (!commandId) {
    throw new Error('SendCommand did not return a command id.')
  }

  for (;;) {
    await sleep(2000)
    let invocation
    try {
      invocation = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: request.instanceId
        })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/InvocationDoesNotExist/i.test(message)) {
        continue
      }
      throw error
    }

    const status = invocation.StatusDetails ?? invocation.Status ?? '-'
    if (!TERMINAL_COMMAND_TIMEOUTS.has(status)) {
      continue
    }

    return {
      commandId,
      instanceId: request.instanceId,
      documentName: request.documentName,
      status: invocation.Status ?? '-',
      statusDetails: status,
      requestedAt,
      completedAt: invocation.ExecutionEndDateTime || invocation.ExecutionStartDateTime || '-',
      responseCode: typeof invocation.ResponseCode === 'number' ? invocation.ResponseCode : null,
      executionType: /^AWS-Run(Shell|PowerShell)Script$/i.test(request.documentName) ? 'shell-command' : 'document',
      commandLabel: request.comment?.trim() || request.documentName,
      commandText: request.commands?.join('\n') || request.documentName,
      standardOutput: invocation.StandardOutputContent ?? '',
      standardError: invocation.StandardErrorContent ?? ''
    }
  }
}
