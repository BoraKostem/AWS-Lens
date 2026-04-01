import {
  AttachVolumeCommand,
  AssociateIamInstanceProfileCommand,
  CreateSecurityGroupCommand,
  CreateSnapshotCommand,
  CreateTagsCommand,
  DeleteSecurityGroupCommand,
  DeleteSnapshotCommand,
  DeleteTagsCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstanceTypesCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeRouteTablesCommand,
  DescribeVolumesCommand,
  DescribeVpcEndpointsCommand,
  DescribeSubnetsCommand,
  DescribeSnapshotsCommand,
  DescribeVpcsCommand,
  DetachVolumeCommand,
  DisassociateIamInstanceProfileCommand,
  EC2Client,
  ModifyInstanceAttributeCommand,
  ModifyVolumeCommand,
  RebootInstancesCommand,
  RegisterImageCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceTerminated,
  type Instance,
  type RouteTable,
  type Subnet,
  type Volume
} from '@aws-sdk/client-ec2'
import { EC2InstanceConnectClient, SendSSHPublicKeyCommand } from '@aws-sdk/client-ec2-instance-connect'
import {
  AttachRolePolicyCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  DeleteInstanceProfileCommand,
  DeleteRoleCommand,
  DetachRolePolicyCommand,
  GetInstanceProfileCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListInstanceProfilesCommand,
  ListInstanceProfileTagsCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
  RemoveRoleFromInstanceProfileCommand,
  AddRoleToInstanceProfileCommand
} from '@aws-sdk/client-iam'
import {
  DescribeInstanceInformationCommand,
  SSMClient,
  type InstanceInformation
} from '@aws-sdk/client-ssm'

import { awsClientConfig, readTags } from './client'
import type {
  AwsConnection,
  BastionAmiOption,
  BastionConnectionInfo,
  BastionLaunchConfig,
  Ec2BulkInstanceAction,
  Ec2BulkInstanceActionItemResult,
  Ec2BulkInstanceActionResult,
  Ec2IamAssociation,
  Ec2InstanceAction,
  Ec2InstanceDetail,
  Ec2InstanceSummary,
  Ec2InstanceTypeOption,
  Ec2Recommendation,
  Ec2SnapshotSummary,
  Ec2VpcDetail,
  EbsTempInspectionEnvironment,
  EbsTempInspectionProgress,
  EbsVolumeAttachRequest,
  EbsVolumeAttachment,
  EbsVolumeDetail,
  EbsVolumeDetachRequest,
  EbsVolumeModifyRequest,
  EbsVolumeStatus,
  EbsVolumeSummary,
  SsmConnectionDiagnostic,
  SsmManagedInstanceSummary,
  SnapshotLaunchConfig
} from '@shared/types'
import { getSsmConnectionTarget } from './ssm'

function createClient(connection: AwsConnection): EC2Client {
  return new EC2Client(awsClientConfig(connection))
}

const BASTION_TAG_PREFIX = 'aws-lens-bastion/'
const LEGACY_BASTION_TAG_PREFIX = 'aws-lens-bastion#'
const BASTION_PURPOSE_TAG = 'aws-lens:purpose'
const BASTION_UUID_TAG = 'aws-lens:bastion-uuid'
const BASTION_TARGET_INSTANCE_TAG = 'aws-lens:bastion-target-instance-id'
const BASTION_MANAGED_SG_TAG = 'aws-lens:bastion-managed-sg'
const TEMP_TAG_PREFIX = 'aws-lens-temp/'
const LEGACY_TEMP_TAG_PREFIX = 'aws-lens-temp#'
const TEMP_PURPOSE_TAG = 'aws-lens:purpose'
const TEMP_UUID_TAG = 'aws-lens:temp-uuid'
const TEMP_SOURCE_VOLUME_TAG = 'aws-lens:source-volume-id'
const TEMP_PURPOSE_EBS_INSPECTION = 'ebs-inspection'
const TEMP_MANAGED_SG_TAG = 'aws-lens:temp-managed-sg'
const TEMP_MANAGED_ROLE_TAG = 'aws-lens:temp-managed-role'
const TEMP_MANAGED_INSTANCE_PROFILE_TAG = 'aws-lens:temp-managed-instance-profile'
const TEMP_ATTACH_DEVICE = '/dev/sdf'
const GOVERNANCE_TAG_KEYS = ['Owner', 'Environment', 'CostCenter']
const SSM_MANAGED_POLICY_ARN = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'
const TEMP_INSPECTION_AMI_ID = 'ami-096a4fdbcf530d8e0'

type TempProgressReporter = (progress: EbsTempInspectionProgress) => void

function createIamClient(connection: AwsConnection): IAMClient {
  return new IAMClient(awsClientConfig(connection))
}

function createSsmClient(connection: AwsConnection): SSMClient {
  return new SSMClient(awsClientConfig(connection))
}

function buildBastionTagKey(uuid: string): string {
  return `${BASTION_TAG_PREFIX}${uuid}`
}

function listBastionUuids(tags: Record<string, string> | undefined): string[] {
  return Object.entries(tags ?? {})
    .filter(([, value]) => value === 'true')
    .map(([key]) => {
      if (key.startsWith(BASTION_TAG_PREFIX)) {
        return key.slice(BASTION_TAG_PREFIX.length)
      }
      if (key.startsWith(LEGACY_BASTION_TAG_PREFIX)) {
        return key.slice(LEGACY_BASTION_TAG_PREFIX.length)
      }
      return ''
    })
    .filter(Boolean)
}

function buildTempTagKey(uuid: string): string {
  return `${TEMP_TAG_PREFIX}${uuid}`
}

function listTempUuids(tags: Record<string, string> | undefined): string[] {
  return Object.entries(tags ?? {})
    .filter(([, value]) => value === 'true')
    .map(([key]) => {
      if (key.startsWith(TEMP_TAG_PREFIX)) {
        return key.slice(TEMP_TAG_PREFIX.length)
      }
      if (key.startsWith(LEGACY_TEMP_TAG_PREFIX)) {
        return key.slice(LEGACY_TEMP_TAG_PREFIX.length)
      }
      return ''
    })
    .filter(Boolean)
}

function buildTempTags(uuid: string, volumeId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [buildTempTagKey(uuid)]: 'true',
    [TEMP_PURPOSE_TAG]: TEMP_PURPOSE_EBS_INSPECTION,
    [TEMP_UUID_TAG]: uuid,
    [TEMP_SOURCE_VOLUME_TAG]: volumeId,
    ...extra
  }
}

function sshPortForPlatform(platform: string): number {
  return /windows/i.test(platform) ? 3389 : 22
}

async function loadSingleInstance(client: EC2Client, instanceId: string): Promise<Instance | null> {
  const output = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
  for (const reservation of output.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      return instance
    }
  }
  return null
}

async function describeTargetInstance(client: EC2Client, instanceId: string): Promise<Instance> {
  const instance = await loadSingleInstance(client, instanceId)
  if (!instance) {
    throw new Error(`Selected EC2 instance ${instanceId} was not found`)
  }
  if (!instance.VpcId || !instance.SubnetId) {
    throw new Error('Selected EC2 instance must be inside a VPC subnet')
  }
  return instance
}

async function ensureSubnetMatchesVpc(client: EC2Client, subnetId: string, vpcId: string): Promise<void> {
  const output = await client.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }))
  const subnet = output.Subnets?.[0]
  if (!subnet) {
    throw new Error(`Subnet ${subnetId} was not found`)
  }
  if ((subnet.VpcId ?? '') !== vpcId) {
    throw new Error(`Subnet ${subnetId} is not in the target instance VPC ${vpcId}`)
  }
}

async function tagResources(client: EC2Client, resourceIds: string[], tags: Record<string, string>): Promise<void> {
  if (resourceIds.length === 0) return
  await client.send(
    new CreateTagsCommand({
      Resources: resourceIds,
      Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
    })
  )
}

async function removeTagKeys(client: EC2Client, resourceIds: string[], tagKeys: string[]): Promise<void> {
  if (resourceIds.length === 0 || tagKeys.length === 0) return
  await client.send(
    new DeleteTagsCommand({
      Resources: resourceIds,
      Tags: tagKeys.map((Key) => ({ Key }))
    })
  )
}

async function createManagedBastionSecurityGroup(
  client: EC2Client,
  vpcId: string,
  uuid: string,
  targetInstanceId: string
): Promise<string> {
  const tagKey = buildBastionTagKey(uuid)
  const output = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: `aws-lens-bastion-${uuid}`,
      Description: `AWS Lens bastion access for ${targetInstanceId}`,
      VpcId: vpcId,
      TagSpecifications: [
        {
          ResourceType: 'security-group',
          Tags: [
            { Key: 'Name', Value: `aws-lens-bastion-${uuid}` },
            { Key: tagKey, Value: 'true' },
            { Key: BASTION_PURPOSE_TAG, Value: 'bastion' },
            { Key: BASTION_UUID_TAG, Value: uuid },
            { Key: BASTION_TARGET_INSTANCE_TAG, Value: targetInstanceId },
            { Key: BASTION_MANAGED_SG_TAG, Value: 'true' }
          ]
        }
      ]
    })
  )
  if (!output.GroupId) {
    throw new Error('Failed to create bastion security group')
  }
  return output.GroupId
}

async function allowManagedBastionToReachTarget(
  client: EC2Client,
  targetSecurityGroupIds: string[],
  bastionSecurityGroupId: string,
  platform: string
): Promise<void> {
  const port = sshPortForPlatform(platform)
  for (const securityGroupId of targetSecurityGroupIds) {
    const permissions = [
      {
        IpProtocol: 'tcp',
        FromPort: port,
        ToPort: port,
        UserIdGroupPairs: [
          {
            GroupId: bastionSecurityGroupId,
            Description: `AWS Lens bastion access on port ${port}`
          }
        ]
      },
      {
        IpProtocol: 'icmp',
        FromPort: -1,
        ToPort: -1,
        UserIdGroupPairs: [
          {
            GroupId: bastionSecurityGroupId,
            Description: 'AWS Lens bastion ping access'
          }
        ]
      }
    ]

    for (const permission of permissions) {
      try {
        await client.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: securityGroupId,
            IpPermissions: [permission]
          })
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/InvalidPermission\.Duplicate|already exists/i.test(message)) {
          throw error
        }
      }
    }
  }
}

async function revokeManagedBastionFromTarget(
  client: EC2Client,
  targetSecurityGroupIds: string[],
  bastionSecurityGroupId: string,
  platform: string
): Promise<void> {
  const port = sshPortForPlatform(platform)
  for (const securityGroupId of targetSecurityGroupIds) {
    const permissions = [
      {
        IpProtocol: 'tcp',
        FromPort: port,
        ToPort: port,
        UserIdGroupPairs: [{ GroupId: bastionSecurityGroupId }]
      },
      {
        IpProtocol: 'icmp',
        FromPort: -1,
        ToPort: -1,
        UserIdGroupPairs: [{ GroupId: bastionSecurityGroupId }]
      }
    ]

    for (const permission of permissions) {
      try {
        await client.send(
          new RevokeSecurityGroupIngressCommand({
            GroupId: securityGroupId,
            IpPermissions: [permission]
          })
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/InvalidPermission\.NotFound|does not exist|not found/i.test(message)) {
          throw error
        }
      }
    }
  }
}

async function findBastionConnectionByUuid(
  client: EC2Client,
  uuid: string
): Promise<BastionConnectionInfo | null> {
  const tagKey = buildBastionTagKey(uuid)
  const output = await client.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${tagKey}`, Values: ['true'] },
        { Name: 'tag:aws-lens:purpose', Values: ['bastion'] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }
      ]
    })
  )

  const bastionInstanceIds: string[] = []
  let targetInstanceId = ''
  let bastionSecurityGroupId = ''
  for (const reservation of output.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (instance.InstanceId) {
        bastionInstanceIds.push(instance.InstanceId)
      }
      const tags = readTags(instance.Tags)
      targetInstanceId = targetInstanceId || tags[BASTION_TARGET_INSTANCE_TAG] || ''
      const managedGroup = (instance.SecurityGroups ?? []).find(
        (group) => group.GroupId && (group.GroupName ?? '').startsWith(`aws-lens-bastion-${uuid}`)
      )
      bastionSecurityGroupId = bastionSecurityGroupId || managedGroup?.GroupId || ''
    }
  }

  const targetInstance = targetInstanceId ? await loadSingleInstance(client, targetInstanceId) : null
  const targetSecurityGroupIds = (targetInstance?.SecurityGroups ?? [])
    .map((group) => group.GroupId ?? '')
    .filter(Boolean)

  if (!bastionSecurityGroupId) {
    const groupsOutput = await client.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: `tag:${tagKey}`, Values: ['true'] }]
      })
    )
    const group = groupsOutput.SecurityGroups?.find((candidate) => candidate.GroupId)
    bastionSecurityGroupId = group?.GroupId ?? ''
  }

  if (!bastionSecurityGroupId || !targetInstanceId) {
    return null
  }

  return {
    bastionUuid: uuid,
    targetInstanceId,
    bastionInstanceIds,
    bastionSecurityGroupId,
    targetSecurityGroupIds
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeVolumeAttachment(attachment: NonNullable<Volume['Attachments']>[number]): EbsVolumeAttachment {
  return {
    instanceId: attachment?.InstanceId ?? '-',
    device: attachment?.Device ?? '-',
    state: attachment?.State ?? '-',
    attachTime: attachment?.AttachTime?.toISOString() ?? '-',
    deleteOnTermination: attachment?.DeleteOnTermination ?? false
  }
}

function hasActiveVolumeAttachments(attachments: EbsVolumeAttachment[]): boolean {
  return attachments.some((attachment) => attachment.state !== 'detached' && attachment.instanceId !== '-')
}

function classifyVolumeStatus(volume: Volume, attachments: EbsVolumeAttachment[]): EbsVolumeStatus {
  if (volume.MultiAttachEnabled) {
    return 'multi-attach'
  }
  if ((volume.State ?? '') === 'available' && !hasActiveVolumeAttachments(attachments)) {
    return 'available-orphan'
  }
  if (hasActiveVolumeAttachments(attachments)) {
    return 'attached'
  }
  return 'unknown'
}

async function findTempInspectionEnvironmentByUuid(
  client: EC2Client,
  uuid: string
): Promise<EbsTempInspectionEnvironment | null> {
  const output = await client.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${buildTempTagKey(uuid)}`, Values: ['true'] },
        { Name: `tag:${TEMP_PURPOSE_TAG}`, Values: [TEMP_PURPOSE_EBS_INSPECTION] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }
      ]
    })
  )

  for (const reservation of output.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (!instance.InstanceId) {
        continue
      }
      const tags = readTags(instance.Tags)
      const managedGroup = (instance.SecurityGroups ?? []).find((group) => group.GroupId && group.GroupName?.startsWith(`aws-lens-ebs-inspection-${uuid}`))
      return {
        tempUuid: uuid,
        purpose: tags[TEMP_PURPOSE_TAG] ?? TEMP_PURPOSE_EBS_INSPECTION,
        sourceVolumeId: tags[TEMP_SOURCE_VOLUME_TAG] ?? '-',
        instanceId: instance.InstanceId,
        instanceState: instance.State?.Name ?? '-',
        availabilityZone: instance.Placement?.AvailabilityZone ?? '-',
        subnetId: instance.SubnetId ?? '-',
        vpcId: instance.VpcId ?? '-',
        securityGroupId: managedGroup?.GroupId ?? instance.SecurityGroups?.[0]?.GroupId ?? '-',
        iamRoleName: tags[TEMP_MANAGED_ROLE_TAG] ?? '',
        instanceProfileName: tags[TEMP_MANAGED_INSTANCE_PROFILE_TAG] ?? '',
        attachDevice: TEMP_ATTACH_DEVICE,
        ssmReady: false,
        launchTime: instance.LaunchTime?.toISOString() ?? '-',
        tags
      }
    }
  }

  return null
}

async function findTempInspectionEnvironmentForVolume(
  client: EC2Client,
  volumeId: string
): Promise<EbsTempInspectionEnvironment | null> {
  const output = await client.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${TEMP_PURPOSE_TAG}`, Values: [TEMP_PURPOSE_EBS_INSPECTION] },
        { Name: `tag:${TEMP_SOURCE_VOLUME_TAG}`, Values: [volumeId] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }
      ]
    })
  )

  for (const reservation of output.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      const tags = readTags(instance.Tags)
      const [tempUuid] = listTempUuids(tags)
      if (!tempUuid || !instance.InstanceId) {
        continue
      }
      return {
        tempUuid,
        purpose: tags[TEMP_PURPOSE_TAG] ?? TEMP_PURPOSE_EBS_INSPECTION,
        sourceVolumeId: tags[TEMP_SOURCE_VOLUME_TAG] ?? volumeId,
        instanceId: instance.InstanceId,
        instanceState: instance.State?.Name ?? '-',
        availabilityZone: instance.Placement?.AvailabilityZone ?? '-',
        subnetId: instance.SubnetId ?? '-',
        vpcId: instance.VpcId ?? '-',
        securityGroupId: instance.SecurityGroups?.[0]?.GroupId ?? '-',
        iamRoleName: tags[TEMP_MANAGED_ROLE_TAG] ?? '',
        instanceProfileName: tags[TEMP_MANAGED_INSTANCE_PROFILE_TAG] ?? '',
        attachDevice: TEMP_ATTACH_DEVICE,
        ssmReady: false,
        launchTime: instance.LaunchTime?.toISOString() ?? '-',
        tags
      }
    }
  }

  return null
}

async function toVolumeSummary(client: EC2Client, volume: Volume): Promise<EbsVolumeSummary> {
  const tags = readTags(volume.Tags)
  const attachments = (volume.Attachments ?? []).map(normalizeVolumeAttachment)
  const tempEnvironment = volume.VolumeId
    ? await findTempInspectionEnvironmentForVolume(client, volume.VolumeId)
    : null

  return {
    volumeId: volume.VolumeId ?? '-',
    name: tags.Name ?? '-',
    state: volume.State ?? '-',
    status: classifyVolumeStatus(volume, attachments),
    sizeGiB: volume.Size ?? 0,
    type: volume.VolumeType ?? '-',
    iops: volume.Iops ?? 0,
    throughput: volume.Throughput ?? 0,
    encrypted: volume.Encrypted ?? false,
    availabilityZone: volume.AvailabilityZone ?? '-',
    createTime: volume.CreateTime?.toISOString() ?? '-',
    snapshotId: volume.SnapshotId ?? '-',
    multiAttachEnabled: volume.MultiAttachEnabled ?? false,
    attachments,
    attachedInstanceIds: attachments.map((attachment) => attachment.instanceId).filter((id) => id !== '-'),
    attachedDevices: attachments.map((attachment) => attachment.device).filter((device) => device !== '-'),
    tags,
    tempEnvironment
  }
}

function emitProgress(
  report: TempProgressReporter | undefined,
  progress: EbsTempInspectionProgress
): void {
  report?.(progress)
}

async function loadSingleVolume(client: EC2Client, volumeId: string): Promise<Volume | null> {
  const output = await client.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }))
  return output.Volumes?.[0] ?? null
}

async function describeTargetVolume(client: EC2Client, volumeId: string): Promise<Volume> {
  const volume = await loadSingleVolume(client, volumeId)
  if (!volume) {
    throw new Error(`Selected EBS volume ${volumeId} was not found`)
  }
  return volume
}

async function findRouteTableForSubnet(client: EC2Client, subnet: Subnet): Promise<RouteTable | null> {
  if (!subnet.SubnetId || !subnet.VpcId) {
    return null
  }

  const direct = await client.send(
    new DescribeRouteTablesCommand({
      Filters: [{ Name: 'association.subnet-id', Values: [subnet.SubnetId] }]
    })
  )
  const directTable = direct.RouteTables?.find((table) => table.RouteTableId)
  if (directTable) {
    return directTable
  }

  const main = await client.send(
    new DescribeRouteTablesCommand({
      Filters: [
        { Name: 'vpc-id', Values: [subnet.VpcId] },
        { Name: 'association.main', Values: ['true'] }
      ]
    })
  )
  return main.RouteTables?.find((table) => table.RouteTableId) ?? null
}

async function vpcHasRequiredSsmEndpoints(client: EC2Client, vpcId: string): Promise<boolean> {
  const output = await client.send(
    new DescribeVpcEndpointsCommand({
      Filters: [{ Name: 'vpc-id', Values: [vpcId] }]
    })
  )
  const services = new Set(
    (output.VpcEndpoints ?? [])
      .filter((endpoint) => String(endpoint.State ?? '').toLowerCase() === 'available')
      .map((endpoint) => endpoint.ServiceName ?? '')
  )
  return ['ssm', 'ssmmessages', 'ec2messages'].every((suffix) =>
    [...services].some((service) => service.endsWith(`.${suffix}`))
  )
}

function routeTableHasOutboundAccess(routeTable: RouteTable | null): boolean {
  return (routeTable?.Routes ?? []).some((route) =>
    route.State === 'active' &&
    (route.DestinationCidrBlock === '0.0.0.0/0' || route.DestinationIpv6CidrBlock === '::/0') &&
    Boolean(route.GatewayId || route.NatGatewayId || route.TransitGatewayId || route.NetworkInterfaceId)
  )
}

async function selectInspectionSubnet(client: EC2Client, availabilityZone: string): Promise<{ subnetId: string; vpcId: string }> {
  const output = await client.send(
    new DescribeSubnetsCommand({
      Filters: [
        { Name: 'availability-zone', Values: [availabilityZone] },
        { Name: 'state', Values: ['available'] }
      ]
    })
  )
  const candidates = (output.Subnets ?? []).filter((subnet) => subnet.SubnetId && subnet.VpcId)
  if (candidates.length === 0) {
    throw new Error(`No usable subnet was found in availability zone ${availabilityZone}`)
  }

  const evaluated = await Promise.all(candidates.map(async (subnet) => {
    const routeTable = await findRouteTableForSubnet(client, subnet)
    const hasOutboundRoute = routeTableHasOutboundAccess(routeTable)
    const hasSsmEndpoints = subnet.VpcId ? await vpcHasRequiredSsmEndpoints(client, subnet.VpcId) : false
    return {
      subnet,
      score: [
        subnet.DefaultForAz ? 1 : 0,
        subnet.MapPublicIpOnLaunch ? 1 : 0,
        hasOutboundRoute ? 1 : 0,
        hasSsmEndpoints ? 1 : 0
      ],
      usable: hasOutboundRoute || hasSsmEndpoints
    }
  }))

  const best = evaluated
    .filter((candidate) => candidate.usable)
    .sort((left, right) => right.score.join('').localeCompare(left.score.join('')))[0]

  if (!best?.subnet.SubnetId || !best.subnet.VpcId) {
    throw new Error(
      `No subnet in ${availabilityZone} has outbound access or the required SSM VPC endpoints. ` +
      'Temporary volume inspection requires either internet/NAT egress or SSM interface endpoints.'
    )
  }

  return { subnetId: best.subnet.SubnetId, vpcId: best.subnet.VpcId }
}

async function selectInspectionAmi(client: EC2Client): Promise<string> {
  const output = await client.send(
    new DescribeImagesCommand({
      ImageIds: [TEMP_INSPECTION_AMI_ID]
    })
  )
  const image = output.Images?.find((candidate) => candidate.ImageId === TEMP_INSPECTION_AMI_ID)
  if (!image?.ImageId || image.State !== 'available') {
    throw new Error(`Temporary inspection AMI ${TEMP_INSPECTION_AMI_ID} was not found or is not available in this region`)
  }

  return image.ImageId
}

async function createManagedInspectionSecurityGroup(
  client: EC2Client,
  vpcId: string,
  uuid: string,
  volumeId: string
): Promise<string> {
  const output = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: `aws-lens-ebs-inspection-${uuid}`,
      Description: `AWS Lens temporary EBS inspection for ${volumeId}`,
      VpcId: vpcId,
      TagSpecifications: [
        {
          ResourceType: 'security-group',
          Tags: Object.entries({
            Name: `aws-lens-ebs-inspection-${uuid}`,
            ...buildTempTags(uuid, volumeId, {
              [TEMP_MANAGED_SG_TAG]: 'true'
            })
          }).map(([Key, Value]) => ({ Key, Value }))
        }
      ]
    })
  )
  if (!output.GroupId) {
    throw new Error('Failed to create temporary inspection security group')
  }
  return output.GroupId
}

async function ensureInspectionRole(
  iamClient: IAMClient,
  uuid: string,
  volumeId: string
): Promise<{ roleName: string; instanceProfileName: string }> {
  const shortId = uuid.replace(/[^A-Za-z0-9+=,.@_-]/g, '').slice(0, 12) || 'temp'
  const roleName = `awl-ebs-inspect-role-${shortId}`
  const instanceProfileName = `awl-ebs-inspect-profile-${shortId}`
  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
        Action: 'sts:AssumeRole'
      }
    ]
  })
  const tags = Object.entries(buildTempTags(uuid, volumeId, {
    [TEMP_MANAGED_ROLE_TAG]: roleName,
    [TEMP_MANAGED_INSTANCE_PROFILE_TAG]: instanceProfileName
  })).map(([Key, Value]) => ({ Key, Value }))

  await iamClient.send(
    new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: trustPolicy,
      Description: `AWS Lens temporary EBS inspection role for ${volumeId}`,
      Tags: tags
    })
  )
  await iamClient.send(
    new AttachRolePolicyCommand({
      RoleName: roleName,
      PolicyArn: SSM_MANAGED_POLICY_ARN
    })
  )
  await iamClient.send(
    new CreateInstanceProfileCommand({
      InstanceProfileName: instanceProfileName,
      Tags: tags
    })
  )
  await sleep(3000)
  await iamClient.send(
    new AddRoleToInstanceProfileCommand({
      InstanceProfileName: instanceProfileName,
      RoleName: roleName
    })
  )
  await sleep(5000)

  return { roleName, instanceProfileName }
}

async function waitForSsmReadiness(ssmClient: SSMClient, instanceId: string, timeoutMs = 180000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const output = await ssmClient.send(
      new DescribeInstanceInformationCommand({
        Filters: [
          { Key: 'InstanceIds', Values: [instanceId] }
        ]
      })
    )
    const match = output.InstanceInformationList?.find((entry) => entry.InstanceId === instanceId)
    if (match?.PingStatus === 'Online') {
      return
    }
    await sleep(5000)
  }
  throw new Error(`Timed out waiting for SSM readiness on ${instanceId}`)
}

async function loadManagedInstanceMap(ssmClient: SSMClient): Promise<Map<string, InstanceInformation>> {
  const rows = new Map<string, InstanceInformation>()
  let nextToken: string | undefined

  do {
    const output = await ssmClient.send(new DescribeInstanceInformationCommand({ NextToken: nextToken }))
    for (const info of output.InstanceInformationList ?? []) {
      if (info.InstanceId) {
        rows.set(info.InstanceId, info)
      }
    }
    nextToken = output.NextToken
  } while (nextToken)

  return rows
}

async function waitForVolumeAttachment(
  client: EC2Client,
  volumeId: string,
  instanceId: string,
  desiredState: 'attached' | 'available',
  timeoutMs = 180000
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const volume = await describeTargetVolume(client, volumeId)
    const attachment = (volume.Attachments ?? []).find((entry) => entry.InstanceId === instanceId)
    if (desiredState === 'attached' && attachment?.State === 'attached') {
      return
    }
    if (desiredState === 'available' && !attachment && volume.State === 'available') {
      return
    }
    await sleep(4000)
  }
  throw new Error(`Timed out waiting for volume ${volumeId} to reach ${desiredState}`)
}

async function findTaggedSecurityGroupIds(client: EC2Client, uuid: string): Promise<string[]> {
  const output = await client.send(
    new DescribeSecurityGroupsCommand({
      Filters: [{ Name: `tag:${buildTempTagKey(uuid)}`, Values: ['true'] }]
    })
  )
  return (output.SecurityGroups ?? []).map((group) => group.GroupId ?? '').filter(Boolean)
}

async function listTaggedRoleNames(iamClient: IAMClient, uuid: string): Promise<string[]> {
  const output = await iamClient.send(new ListRolesCommand({}))
  const roleNames: string[] = []
  for (const role of output.Roles ?? []) {
    if (!role.RoleName) {
      continue
    }
    const tags = await iamClient.send(new ListRoleTagsCommand({ RoleName: role.RoleName }))
    if ((tags.Tags ?? []).some((tag) => tag.Key === buildTempTagKey(uuid) && tag.Value === 'true')) {
      roleNames.push(role.RoleName)
    }
  }
  return roleNames
}

async function listTaggedInstanceProfiles(iamClient: IAMClient, uuid: string): Promise<string[]> {
  const output = await iamClient.send(new ListInstanceProfilesCommand({}))
  const profileNames: string[] = []
  for (const profile of output.InstanceProfiles ?? []) {
    if (!profile.InstanceProfileName) {
      continue
    }
    const tags = await iamClient.send(new ListInstanceProfileTagsCommand({ InstanceProfileName: profile.InstanceProfileName }))
    if ((tags.Tags ?? []).some((tag) => tag.Key === buildTempTagKey(uuid) && tag.Value === 'true')) {
      profileNames.push(profile.InstanceProfileName)
    }
  }
  return profileNames
}

/* ── Instance list ─────────────────────────────────────────── */

function toInstanceSummary(instance: Instance, managedInfo?: { PingStatus?: string; LastPingDateTime?: Date }): Ec2InstanceSummary {
  const tags = readTags(instance.Tags)

  return {
    name: tags.Name ?? '-',
    instanceId: instance.InstanceId ?? '-',
    vpcId: instance.VpcId ?? '-',
    subnetId: instance.SubnetId ?? '-',
    keyName: instance.KeyName ?? '-',
    type: instance.InstanceType ?? '-',
    state: instance.State?.Name ?? '-',
    availabilityZone: instance.Placement?.AvailabilityZone ?? '-',
    platform: instance.PlatformDetails ?? 'Linux/UNIX',
    publicIp: instance.PublicIpAddress ?? '-',
    privateIp: instance.PrivateIpAddress ?? '-',
    iamProfile: instance.IamInstanceProfile?.Arn ?? '-',
    launchTime: instance.LaunchTime?.toISOString() ?? '-',
    ssmStatus: managedInfo ? (managedInfo.PingStatus === 'Online' ? 'managed-online' : 'managed-offline') : 'not-managed',
    ssmPingStatus: managedInfo?.PingStatus ?? '-',
    ssmLastPingAt: managedInfo?.LastPingDateTime?.toISOString() ?? '-',
    isTempInspectionInstance: tags[TEMP_PURPOSE_TAG] === TEMP_PURPOSE_EBS_INSPECTION,
    tempInspectionSourceVolumeId: tags[TEMP_SOURCE_VOLUME_TAG] ?? '-',
    tags
  }
}

export async function listEc2Instances(connection: AwsConnection): Promise<Ec2InstanceSummary[]> {
  const client = createClient(connection)
  const ssmClient = createSsmClient(connection)
  const managedInstanceMap = await loadManagedInstanceMap(ssmClient)
  const instances: Ec2InstanceSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
    for (const reservation of output.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        instances.push(toInstanceSummary(instance, managedInstanceMap.get(instance.InstanceId ?? '')))
      }
    }
    nextToken = output.NextToken
  } while (nextToken)

  return instances
}

export async function listEbsVolumes(connection: AwsConnection): Promise<EbsVolumeSummary[]> {
  const client = createClient(connection)
  const output = await client.send(new DescribeVolumesCommand({}))
  const volumes = await Promise.all((output.Volumes ?? []).map((volume) => toVolumeSummary(client, volume)))
  return volumes.sort((left, right) => left.volumeId.localeCompare(right.volumeId))
}

export async function describeEbsVolume(connection: AwsConnection, volumeId: string): Promise<EbsVolumeDetail | null> {
  const client = createClient(connection)
  const volume = await loadSingleVolume(client, volumeId)
  if (!volume) {
    return null
  }
  const summary = await toVolumeSummary(client, volume)
  return {
    ...summary,
    isOrphan: summary.status === 'available-orphan'
  }
}

export async function tagEbsVolume(
  connection: AwsConnection,
  volumeId: string,
  tags: Record<string, string>
): Promise<void> {
  const client = createClient(connection)
  await tagResources(client, [volumeId], tags)
}

export async function untagEbsVolume(
  connection: AwsConnection,
  volumeId: string,
  tagKeys: string[]
): Promise<void> {
  const client = createClient(connection)
  await removeTagKeys(client, [volumeId], tagKeys)
}

export async function attachEbsVolume(
  connection: AwsConnection,
  volumeId: string,
  request: EbsVolumeAttachRequest
): Promise<void> {
  const client = createClient(connection)
  const volume = await describeTargetVolume(client, volumeId)
  const instance = await describeTargetInstance(client, request.instanceId)

  if ((volume.AvailabilityZone ?? '') !== (instance.Placement?.AvailabilityZone ?? '')) {
    throw new Error(`Volume ${volumeId} and instance ${request.instanceId} must be in the same availability zone`)
  }

  await client.send(
    new AttachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: request.instanceId,
      Device: request.device
    })
  )
}

export async function detachEbsVolume(
  connection: AwsConnection,
  volumeId: string,
  request: EbsVolumeDetachRequest = {}
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new DetachVolumeCommand({
      VolumeId: volumeId,
      InstanceId: request.instanceId,
      Device: request.device,
      Force: request.force
    })
  )
}

export async function deleteEbsVolume(connection: AwsConnection, volumeId: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteVolumeCommand({ VolumeId: volumeId }))
}

export async function modifyEbsVolume(
  connection: AwsConnection,
  volumeId: string,
  request: EbsVolumeModifyRequest
): Promise<void> {
  const client = createClient(connection)
  const payload: {
    VolumeId: string
    Size?: number
    VolumeType?: string
    Iops?: number
    Throughput?: number
  } = { VolumeId: volumeId }

  if (request.sizeGiB !== undefined) {
    payload.Size = request.sizeGiB
  }
  if (request.type) {
    payload.VolumeType = request.type as never
  }
  if (request.iops !== undefined) {
    payload.Iops = request.iops
  }
  if (request.throughput !== undefined) {
    payload.Throughput = request.throughput
  }

  if (!('Size' in payload) && !('VolumeType' in payload) && !('Iops' in payload) && !('Throughput' in payload)) {
    throw new Error('Provide at least one volume setting to modify')
  }

  await client.send(new ModifyVolumeCommand(payload as never))
}

/* ── Instance detail ───────────────────────────────────────── */

function toInstanceDetail(
  instance: Instance,
  iamAssociationId: string,
  ssmManagedInstance: SsmManagedInstanceSummary | null,
  ssmDiagnostics: SsmConnectionDiagnostic[]
): Ec2InstanceDetail {
  const tags = readTags(instance.Tags)

  return {
    instanceId: instance.InstanceId ?? '-',
    name: tags.Name ?? '-',
    state: instance.State?.Name ?? '-',
    type: instance.InstanceType ?? '-',
    platform: instance.PlatformDetails ?? 'Linux/UNIX',
    architecture: instance.Architecture ?? '-',
    privateIp: instance.PrivateIpAddress ?? '-',
    publicIp: instance.PublicIpAddress ?? '-',
    vpcId: instance.VpcId ?? '-',
    subnetId: instance.SubnetId ?? '-',
    keyName: instance.KeyName ?? '-',
    availabilityZone: instance.Placement?.AvailabilityZone ?? '-',
    launchTime: instance.LaunchTime?.toISOString() ?? '-',
    imageId: instance.ImageId ?? '-',
    rootDeviceType: instance.RootDeviceType ?? '-',
    rootDeviceName: instance.RootDeviceName ?? '-',
    iamProfile: instance.IamInstanceProfile?.Arn ?? '-',
    iamAssociationId,
    securityGroups: (instance.SecurityGroups ?? []).map((sg) => ({
      id: sg.GroupId ?? '-',
      name: sg.GroupName ?? '-'
    })),
    tags,
    volumes: (instance.BlockDeviceMappings ?? []).map((bdm) => ({
      volumeId: bdm.Ebs?.VolumeId ?? '-',
      device: bdm.DeviceName ?? '-',
      deleteOnTermination: bdm.Ebs?.DeleteOnTermination ?? false
    })),
    stateReason: instance.StateReason?.Message ?? '-',
    stateTransitionReason: instance.StateTransitionReason ?? '-',
    ssmStatus: ssmManagedInstance ? (ssmManagedInstance.pingStatus === 'Online' ? 'managed-online' : 'managed-offline') : 'not-managed',
    ssmPingStatus: ssmManagedInstance?.pingStatus ?? '-',
    ssmLastPingAt: ssmManagedInstance?.lastPingAt ?? '-',
    ssmManagedInstance,
    ssmDiagnostics,
    isTempInspectionInstance: tags[TEMP_PURPOSE_TAG] === TEMP_PURPOSE_EBS_INSPECTION,
    tempInspectionSourceVolumeId: tags[TEMP_SOURCE_VOLUME_TAG] ?? '-'
  }
}

export async function describeEc2Instance(connection: AwsConnection, instanceId: string): Promise<Ec2InstanceDetail | null> {
  const client = createClient(connection)
  const output = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))

  let instance: Instance | undefined
  for (const reservation of output.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      instance = inst
    }
  }
  if (!instance) return null

  let iamAssociationId = ''
  try {
    const assocOutput = await client.send(
      new DescribeIamInstanceProfileAssociationsCommand({
        Filters: [{ Name: 'instance-id', Values: [instanceId] }]
      })
    )
    const assoc = assocOutput.IamInstanceProfileAssociations?.find((a) => a.State === 'associated')
    iamAssociationId = assoc?.AssociationId ?? ''
  } catch {
    /* no association */
  }

  const ssmTarget = await getSsmConnectionTarget(connection, instanceId).catch(() => null)

  return toInstanceDetail(instance, iamAssociationId, ssmTarget?.managedInstance ?? null, ssmTarget?.diagnostics ?? [])
}

/* ── Instance lifecycle ────────────────────────────────────── */

export async function runEc2InstanceAction(
  connection: AwsConnection,
  instanceId: string,
  action: Ec2InstanceAction
): Promise<void> {
  const client = createClient(connection)

  if (action === 'start') {
    await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }))
    return
  }

  if (action === 'stop') {
    await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }))
    return
  }

  await client.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }))
}

export async function terminateEc2Instance(connection: AwsConnection, instanceId: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
}

async function loadInstanceNameMap(client: EC2Client, instanceIds: string[]): Promise<Map<string, string>> {
  if (!instanceIds.length) {
    return new Map()
  }

  const output = await client.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }))
  const nameMap = new Map<string, string>()

  for (const reservation of output.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      const instanceId = instance.InstanceId ?? ''

      if (!instanceId) {
        continue
      }

      nameMap.set(instanceId, readTags(instance.Tags).Name?.trim() || instanceId)
    }
  }

  return nameMap
}

function toBulkActionDetail(action: Ec2BulkInstanceAction): string {
  if (action === 'start') {
    return 'Start sent'
  }

  if (action === 'stop') {
    return 'Stop sent'
  }

  if (action === 'reboot') {
    return 'Reboot sent'
  }

  return 'Terminate sent'
}

export async function runEc2BulkInstanceAction(
  connection: AwsConnection,
  instanceIds: string[],
  action: Ec2BulkInstanceAction
): Promise<Ec2BulkInstanceActionResult> {
  const uniqueInstanceIds = [...new Set(instanceIds.map((instanceId) => instanceId.trim()).filter(Boolean))]

  if (!uniqueInstanceIds.length) {
    return {
      action,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: []
    }
  }

  const client = createClient(connection)
  const nameMap = await loadInstanceNameMap(client, uniqueInstanceIds).catch(() => new Map<string, string>())
  const results: Ec2BulkInstanceActionItemResult[] = []

  for (const instanceId of uniqueInstanceIds) {
    try {
      if (action === 'terminate') {
        await terminateEc2Instance(connection, instanceId)
      } else {
        await runEc2InstanceAction(connection, instanceId, action)
      }

      results.push({
        instanceId,
        name: nameMap.get(instanceId) ?? instanceId,
        action,
        status: 'success',
        detail: toBulkActionDetail(action)
      })
    } catch (error) {
      results.push({
        instanceId,
        name: nameMap.get(instanceId) ?? instanceId,
        action,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const succeeded = results.filter((result) => result.status === 'success').length

  return {
    action,
    attempted: uniqueInstanceIds.length,
    succeeded,
    failed: uniqueInstanceIds.length - succeeded,
    results
  }
}

/* ── Resize ────────────────────────────────────────────────── */

export async function resizeEc2Instance(
  connection: AwsConnection,
  instanceId: string,
  instanceType: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new ModifyInstanceAttributeCommand({
      InstanceId: instanceId,
      InstanceType: { Value: instanceType }
    })
  )
}

/* ── Instance type suggestions ─────────────────────────────── */

export async function listInstanceTypes(
  connection: AwsConnection,
  architecture?: string,
  currentGenerationOnly = true
): Promise<Ec2InstanceTypeOption[]> {
  const client = createClient(connection)
  const types: Ec2InstanceTypeOption[] = []
  let nextToken: string | undefined

  const filters: Array<{ Name: string; Values: string[] }> = []
  if (currentGenerationOnly) {
    filters.push({ Name: 'current-generation', Values: ['true'] })
  }
  if (architecture) {
    filters.push({ Name: 'processor-info.supported-architecture', Values: [architecture] })
  }

  do {
    const output = await client.send(
      new DescribeInstanceTypesCommand({
        Filters: filters,
        NextToken: nextToken,
        MaxResults: 100
      })
    )
    for (const info of output.InstanceTypes ?? []) {
      types.push({
        instanceType: info.InstanceType ?? '-',
        vcpus: info.VCpuInfo?.DefaultVCpus ?? 0,
        memoryMiB: info.MemoryInfo?.SizeInMiB ?? 0,
        architecture: (info.ProcessorInfo?.SupportedArchitectures ?? []).join(', '),
        currentGeneration: info.CurrentGeneration ?? false
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  types.sort((a, b) => {
    const memDiff = a.memoryMiB - b.memoryMiB
    return memDiff !== 0 ? memDiff : a.vcpus - b.vcpus
  })

  return types
}

/* ── Snapshots ─────────────────────────────────────────────── */

export async function listEc2Snapshots(connection: AwsConnection): Promise<Ec2SnapshotSummary[]> {
  const client = createClient(connection)
  const snapshots: Ec2SnapshotSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new DescribeSnapshotsCommand({
        OwnerIds: ['self'],
        NextToken: nextToken
      })
    )
    for (const snap of output.Snapshots ?? []) {
      snapshots.push({
        snapshotId: snap.SnapshotId ?? '-',
        volumeId: snap.VolumeId ?? '-',
        state: snap.State ?? '-',
        startTime: snap.StartTime?.toISOString() ?? '-',
        progress: snap.Progress ?? '-',
        volumeSize: snap.VolumeSize ?? 0,
        description: snap.Description ?? '',
        encrypted: snap.Encrypted ?? false,
        ownerId: snap.OwnerId ?? '-',
        tags: readTags(snap.Tags)
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return snapshots
}

export async function createEc2Snapshot(
  connection: AwsConnection,
  volumeId: string,
  description: string
): Promise<string> {
  const client = createClient(connection)
  const output = await client.send(
    new CreateSnapshotCommand({
      VolumeId: volumeId,
      Description: description,
      TagSpecifications: [
        {
          ResourceType: 'snapshot',
          Tags: [{ Key: 'CreatedBy', Value: 'aws-lens' }]
        }
      ]
    })
  )
  return output.SnapshotId ?? ''
}

export async function deleteEc2Snapshot(connection: AwsConnection, snapshotId: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }))
}

export async function tagEc2Snapshot(
  connection: AwsConnection,
  snapshotId: string,
  tags: Record<string, string>
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new CreateTagsCommand({
      Resources: [snapshotId],
      Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
    })
  )
}

/* ── IAM instance profile ──────────────────────────────────── */

export async function getIamAssociation(
  connection: AwsConnection,
  instanceId: string
): Promise<Ec2IamAssociation | null> {
  const client = createClient(connection)
  const output = await client.send(
    new DescribeIamInstanceProfileAssociationsCommand({
      Filters: [{ Name: 'instance-id', Values: [instanceId] }]
    })
  )
  const assoc = output.IamInstanceProfileAssociations?.find((a) => a.State === 'associated')
  if (!assoc) return null

  return {
    associationId: assoc.AssociationId ?? '-',
    instanceId: assoc.InstanceId ?? instanceId,
    iamProfileArn: assoc.IamInstanceProfile?.Arn ?? '-',
    iamProfileId: assoc.IamInstanceProfile?.Id ?? '-',
    state: assoc.State ?? '-'
  }
}

export async function attachIamProfile(
  connection: AwsConnection,
  instanceId: string,
  profileName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new AssociateIamInstanceProfileCommand({
      InstanceId: instanceId,
      IamInstanceProfile: { Name: profileName }
    })
  )
}

export async function replaceIamProfile(
  connection: AwsConnection,
  associationId: string,
  profileName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new ReplaceIamInstanceProfileAssociationCommand({
      AssociationId: associationId,
      IamInstanceProfile: { Name: profileName }
    })
  )
}

export async function removeIamProfile(connection: AwsConnection, associationId: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DisassociateIamInstanceProfileCommand({ AssociationId: associationId }))
}

/* ── Bastion lifecycle ─────────────────────────────────────── */

export async function launchBastion(connection: AwsConnection, config: BastionLaunchConfig): Promise<string> {
  const client = createClient(connection)
  const targetInstance = await describeTargetInstance(client, config.targetInstanceId)
  await ensureSubnetMatchesVpc(client, config.subnetId, targetInstance.VpcId ?? '')

  const uuid = globalThis.crypto.randomUUID()
  const tagKey = buildBastionTagKey(uuid)
  const bastionSecurityGroupId = await createManagedBastionSecurityGroup(
    client,
    targetInstance.VpcId ?? '',
    uuid,
    config.targetInstanceId
  )

  const targetSecurityGroupIds = (targetInstance.SecurityGroups ?? [])
    .map((group) => group.GroupId ?? '')
    .filter(Boolean)
  await allowManagedBastionToReachTarget(
    client,
    targetSecurityGroupIds,
    bastionSecurityGroupId,
    targetInstance.PlatformDetails ?? 'Linux/UNIX'
  )

  const securityGroupIds = Array.from(new Set([bastionSecurityGroupId, ...config.securityGroupIds].filter(Boolean)))

  try {
    const output = await client.send(
      new RunInstancesCommand({
        ImageId: config.imageId,
        InstanceType: config.instanceType as never,
        MinCount: 1,
        MaxCount: 1,
        KeyName: config.keyName,
        SubnetId: config.subnetId,
        SecurityGroupIds: securityGroupIds,
        TagSpecifications: [
          {
            ResourceType: 'instance',
            Tags: [
              { Key: 'Name', Value: `aws-lens-bastion-${uuid}` },
              { Key: tagKey, Value: 'true' },
              { Key: BASTION_PURPOSE_TAG, Value: 'bastion' },
              { Key: BASTION_UUID_TAG, Value: uuid },
              { Key: BASTION_TARGET_INSTANCE_TAG, Value: config.targetInstanceId }
            ]
          }
        ]
      })
    )
    const instanceId = output.Instances?.[0]?.InstanceId ?? ''
    if (!instanceId) {
      throw new Error('Failed to launch bastion instance')
    }

    await tagResources(client, [config.targetInstanceId], {
      [tagKey]: 'true',
      [BASTION_UUID_TAG]: uuid
    })

    return instanceId
  } catch (error) {
    await revokeManagedBastionFromTarget(
      client,
      targetSecurityGroupIds,
      bastionSecurityGroupId,
      targetInstance.PlatformDetails ?? 'Linux/UNIX'
    )
    await client.send(new DeleteSecurityGroupCommand({ GroupId: bastionSecurityGroupId }))
    throw error
  }
}

export async function listBastions(connection: AwsConnection): Promise<Ec2InstanceSummary[]> {
  const client = createClient(connection)
  const bastions: Ec2InstanceSummary[] = []
  const output = await client.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:aws-lens:purpose', Values: ['bastion'] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }
      ]
    })
  )

  for (const reservation of output.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      bastions.push(toInstanceSummary(instance))
    }
  }

  return bastions
}

export async function findBastionConnectionsForInstance(
  connection: AwsConnection,
  targetInstanceId: string
): Promise<BastionConnectionInfo[]> {
  const client = createClient(connection)
  const targetInstance = await describeTargetInstance(client, targetInstanceId)
  const tags = readTags(targetInstance.Tags)
  const uuids = listBastionUuids(tags)
  const results: BastionConnectionInfo[] = []

  for (const uuid of uuids) {
    const connectionInfo = await findBastionConnectionByUuid(client, uuid)
    if (connectionInfo) {
      results.push(connectionInfo)
    }
  }

  return results
}

export async function deleteBastionForInstance(connection: AwsConnection, targetInstanceId: string): Promise<void> {
  const client = createClient(connection)
  const targetInstance = await describeTargetInstance(client, targetInstanceId)
  const tags = readTags(targetInstance.Tags)
  const uuids = listBastionUuids(tags)

  for (const uuid of uuids) {
    const connectionInfo = await findBastionConnectionByUuid(client, uuid)
    const bastionTagKey = buildBastionTagKey(uuid)

    if (connectionInfo?.bastionInstanceIds.length) {
      await client.send(new TerminateInstancesCommand({ InstanceIds: connectionInfo.bastionInstanceIds }))
      await waitUntilInstanceTerminated(
        { client, maxWaitTime: 180 },
        { InstanceIds: connectionInfo.bastionInstanceIds }
      )
    }

    if (connectionInfo) {
      await revokeManagedBastionFromTarget(
        client,
        connectionInfo.targetSecurityGroupIds,
        connectionInfo.bastionSecurityGroupId,
        targetInstance.PlatformDetails ?? 'Linux/UNIX'
      )

      try {
        await client.send(new DeleteSecurityGroupCommand({ GroupId: connectionInfo.bastionSecurityGroupId }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/InvalidGroup\.NotFound|does not exist|not found/i.test(message)) {
          throw error
        }
      }
    }

    await removeTagKeys(client, [targetInstanceId], [bastionTagKey])
  }

  await removeTagKeys(client, [targetInstanceId], [BASTION_UUID_TAG])
}

export async function createTempInspectionEnvironment(
  connection: AwsConnection,
  volumeId: string,
  reportProgress?: TempProgressReporter
): Promise<EbsTempInspectionEnvironment> {
  const client = createClient(connection)
  const iamClient = createIamClient(connection)
  const ssmClient = createSsmClient(connection)
  const volume = await describeTargetVolume(client, volumeId)
  const attachments = (volume.Attachments ?? []).map(normalizeVolumeAttachment)
  const status = classifyVolumeStatus(volume, attachments)
  if (status !== 'available-orphan') {
    throw new Error(`Volume ${volumeId} is not an orphan volume and cannot be checked`)
  }

  const existing = await findTempInspectionEnvironmentForVolume(client, volumeId)
  if (existing) {
    return existing
  }

  const uuid = globalThis.crypto.randomUUID()
  const baseProgress = {
    mode: 'create' as const,
    tempUuid: uuid,
    volumeId,
    instanceId: ''
  }

  emitProgress(reportProgress, {
    ...baseProgress,
    stage: 'preparing',
    status: 'running',
    message: `Preparing temporary inspection environment for ${volumeId}.`
  })

  const availabilityZone = volume.AvailabilityZone ?? ''
  if (!availabilityZone) {
    throw new Error(`Volume ${volumeId} is missing an availability zone`)
  }

  const amiId = await selectInspectionAmi(client)
  const { subnetId, vpcId } = await selectInspectionSubnet(client, availabilityZone)

  emitProgress(reportProgress, {
    ...baseProgress,
    stage: 'creating-iam-profile-if-needed',
    status: 'running',
    message: 'Creating IAM role and instance profile for Systems Manager.'
  })

  let securityGroupId = ''
  let roleName = ''
  let instanceProfileName = ''
  let instanceId = ''

  try {
    const roleInfo = await ensureInspectionRole(iamClient, uuid, volumeId)
    roleName = roleInfo.roleName
    instanceProfileName = roleInfo.instanceProfileName
    securityGroupId = await createManagedInspectionSecurityGroup(client, vpcId, uuid, volumeId)

    emitProgress(reportProgress, {
      ...baseProgress,
      stage: 'creating-instance',
      status: 'running',
      message: 'Creating temporary inspection instance.'
    })

    const tags = buildTempTags(uuid, volumeId, {
      [TEMP_MANAGED_ROLE_TAG]: roleName,
      [TEMP_MANAGED_INSTANCE_PROFILE_TAG]: instanceProfileName
    })
    const output = await client.send(
      new RunInstancesCommand({
        ImageId: amiId,
        InstanceType: 't3.micro',
        MinCount: 1,
        MaxCount: 1,
        IamInstanceProfile: { Name: instanceProfileName },
        NetworkInterfaces: [
          {
            DeviceIndex: 0,
            AssociatePublicIpAddress: true,
            SubnetId: subnetId,
            Groups: [securityGroupId]
          }
        ],
        UserData: Buffer.from(
          [
            '#!/bin/bash',
            'set -euxo pipefail',
            'mkdir -p /mnt',
            'if ! systemctl list-unit-files | grep -q "^amazon-ssm-agent"; then',
            '  if command -v dnf >/dev/null 2>&1; then dnf install -y amazon-ssm-agent || true; fi',
            '  if command -v yum >/dev/null 2>&1; then yum install -y amazon-ssm-agent || true; fi',
            'fi',
            'systemctl daemon-reload || true',
            'systemctl enable amazon-ssm-agent || true',
            'systemctl restart amazon-ssm-agent || systemctl start amazon-ssm-agent || true',
            'systemctl status amazon-ssm-agent --no-pager || true',
            `cat >/etc/motd <<'EOF'`,
            `AWS Lens attached ${volumeId} to this instance.`,
            'Connect via SSM, inspect the extra device, and mount it under /mnt if needed.',
            'Nitro instances may expose the attached EBS device as /dev/nvme*n1 instead of the AWS attachment name.',
            'EOF'
          ].join('\n')
        ).toString('base64'),
        TagSpecifications: [
          {
            ResourceType: 'instance',
            Tags: Object.entries({
              Name: `aws-lens-ebs-inspection-${uuid}`,
              ...tags
            }).map(([Key, Value]) => ({ Key, Value }))
          },
          {
            ResourceType: 'volume',
            Tags: Object.entries({
              Name: `aws-lens-ebs-inspection-root-${uuid}`,
              ...tags
            }).map(([Key, Value]) => ({ Key, Value }))
          }
        ]
      })
    )
    instanceId = output.Instances?.[0]?.InstanceId ?? ''
    if (!instanceId) {
      throw new Error('Failed to create temporary inspection instance')
    }

    emitProgress(reportProgress, {
      ...baseProgress,
      instanceId,
      stage: 'waiting-for-instance-readiness',
      status: 'running',
      message: `Waiting for ${instanceId} to enter running state.`
    })
    await waitUntilInstanceRunning({ client, maxWaitTime: 180 }, { InstanceIds: [instanceId] })

    emitProgress(reportProgress, {
      ...baseProgress,
      instanceId,
      stage: 'verifying-ssm-readiness',
      status: 'running',
      message: 'Verifying Systems Manager readiness.'
    })
    await waitForSsmReadiness(ssmClient, instanceId)

    emitProgress(reportProgress, {
      ...baseProgress,
      instanceId,
      stage: 'attaching-target-volume',
      status: 'running',
      message: `Attaching ${volumeId} to ${instanceId}.`
    })
    await client.send(
      new AttachVolumeCommand({
        Device: TEMP_ATTACH_DEVICE,
        InstanceId: instanceId,
        VolumeId: volumeId
      })
    )
    await waitForVolumeAttachment(client, volumeId, instanceId, 'attached')

    emitProgress(reportProgress, {
      ...baseProgress,
      instanceId,
      stage: 'finalizing',
      status: 'running',
      message: 'Finalizing temporary inspection environment.'
    })

    const environment = await findTempInspectionEnvironmentByUuid(client, uuid)
    if (!environment) {
      throw new Error('Temporary inspection instance was created but could not be rediscovered')
    }

    emitProgress(reportProgress, {
      ...baseProgress,
      instanceId,
      stage: 'completed',
      status: 'completed',
      message: 'Temporary inspection instance is ready. Connect via SSM and inspect the attached volume under /mnt.'
    })
    return { ...environment, ssmReady: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitProgress(reportProgress, {
      ...baseProgress,
      instanceId,
      stage: 'failed',
      status: 'failed',
      message,
      error: message
    })
    if (instanceId) {
      await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] })).catch(() => undefined)
    }
    if (securityGroupId) {
      await client.send(new DeleteSecurityGroupCommand({ GroupId: securityGroupId })).catch(() => undefined)
    }
    if (instanceProfileName) {
      await iamClient.send(new RemoveRoleFromInstanceProfileCommand({
        InstanceProfileName: instanceProfileName,
        RoleName: roleName
      })).catch(() => undefined)
      await iamClient.send(new DeleteInstanceProfileCommand({ InstanceProfileName: instanceProfileName })).catch(() => undefined)
    }
    if (roleName) {
      await iamClient.send(new DetachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: SSM_MANAGED_POLICY_ARN
      })).catch(() => undefined)
      await iamClient.send(new DeleteRoleCommand({ RoleName: roleName })).catch(() => undefined)
    }
    throw error
  }
}

export async function deleteTempInspectionEnvironment(
  connection: AwsConnection,
  tempUuidOrInstanceId: string,
  reportProgress?: TempProgressReporter
): Promise<void> {
  const client = createClient(connection)
  const iamClient = createIamClient(connection)

  let tempUuid = tempUuidOrInstanceId
  let environment: EbsTempInspectionEnvironment | null = null

  if (tempUuidOrInstanceId.startsWith('i-')) {
    const instance = await loadSingleInstance(client, tempUuidOrInstanceId)
    const tags = readTags(instance?.Tags)
    tempUuid = listTempUuids(tags)[0] ?? tags[TEMP_UUID_TAG] ?? ''
  }

  if (!tempUuid) {
    throw new Error('Could not resolve temporary inspection UUID')
  }

  environment = await findTempInspectionEnvironmentByUuid(client, tempUuid)
  const volumeId = environment?.sourceVolumeId ?? '-'
  const instanceId = environment?.instanceId ?? ''
  const baseProgress = {
    mode: 'delete' as const,
    tempUuid,
    volumeId,
    instanceId
  }

  emitProgress(reportProgress, {
    ...baseProgress,
    stage: 'preparing',
    status: 'running',
    message: `Preparing cleanup for temporary inspection environment ${tempUuid}.`
  })

  if (environment?.sourceVolumeId && environment.instanceId) {
    const volume = await describeTargetVolume(client, environment.sourceVolumeId)
    const attached = (volume.Attachments ?? []).some((attachment) => attachment.InstanceId === environment?.instanceId)
    if (attached) {
      emitProgress(reportProgress, {
        ...baseProgress,
        stage: 'detaching-inspected-volume-if-needed',
        status: 'running',
        message: `Detaching ${environment.sourceVolumeId} from ${environment.instanceId}.`
      })
      await client.send(
        new DetachVolumeCommand({
          VolumeId: environment.sourceVolumeId,
          InstanceId: environment.instanceId,
          Device: TEMP_ATTACH_DEVICE
        })
      )
      await waitForVolumeAttachment(client, environment.sourceVolumeId, environment.instanceId, 'available')
    }
  }

  if (instanceId) {
    emitProgress(reportProgress, {
      ...baseProgress,
      stage: 'terminating-instance',
      status: 'running',
      message: `Terminating ${instanceId}.`
    })
    await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
    emitProgress(reportProgress, {
      ...baseProgress,
      stage: 'waiting-for-termination',
      status: 'running',
      message: `Waiting for ${instanceId} to terminate.`
    })
    await waitUntilInstanceTerminated({ client, maxWaitTime: 180 }, { InstanceIds: [instanceId] })
  }

  emitProgress(reportProgress, {
    ...baseProgress,
    stage: 'deleting-temp-resources',
    status: 'running',
    message: 'Deleting app-created temporary resources.'
  })

  for (const groupId of await findTaggedSecurityGroupIds(client, tempUuid)) {
    await client.send(new DeleteSecurityGroupCommand({ GroupId: groupId })).catch(() => undefined)
  }

  for (const profileName of await listTaggedInstanceProfiles(iamClient, tempUuid)) {
    const profile = await iamClient.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName })).catch(() => null)
    for (const role of profile?.InstanceProfile?.Roles ?? []) {
      if (!role.RoleName) {
        continue
      }
      await iamClient.send(
        new RemoveRoleFromInstanceProfileCommand({
          InstanceProfileName: profileName,
          RoleName: role.RoleName
        })
      ).catch(() => undefined)
    }
    await iamClient.send(new DeleteInstanceProfileCommand({ InstanceProfileName: profileName })).catch(() => undefined)
  }

  for (const roleName of await listTaggedRoleNames(iamClient, tempUuid)) {
    const attachedPolicies = await iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName })).catch(() => null)
    for (const policy of attachedPolicies?.AttachedPolicies ?? []) {
      if (!policy.PolicyArn) {
        continue
      }
      await iamClient.send(
        new DetachRolePolicyCommand({
          RoleName: roleName,
          PolicyArn: policy.PolicyArn
        })
      ).catch(() => undefined)
    }
    await iamClient.send(new DeleteRoleCommand({ RoleName: roleName })).catch(() => undefined)
  }

  emitProgress(reportProgress, {
    ...baseProgress,
    stage: 'finalizing',
    status: 'running',
    message: 'Finalizing cleanup.'
  })
  emitProgress(reportProgress, {
    ...baseProgress,
    stage: 'completed',
    status: 'completed',
    message: 'Temporary inspection resources were deleted.'
  })
}

export async function listPopularBastionAmis(
  connection: AwsConnection,
  architecture?: string
): Promise<BastionAmiOption[]> {
  const client = createClient(connection)
  const families: Array<{
    owner: string
    platform: string
    matcher: RegExp
    includeDescription: RegExp
  }> = [
    {
      owner: '137112412989',
      platform: 'Amazon Linux 2023',
      matcher: architecture === 'arm64'
        ? /al2023-ami-.*-kernel-.*-arm64/i
        : /al2023-ami-.*-kernel-.*-x86_64/i,
      includeDescription: /Amazon Linux 2023/i
    },
    {
      owner: '137112412989',
      platform: 'Amazon Linux 2',
      matcher: architecture === 'arm64'
        ? /amzn2-ami-hvm-.*-arm64/i
        : /amzn2-ami-hvm-.*-x86_64/i,
      includeDescription: /Amazon Linux 2/i
    },
    {
      owner: '099720109477',
      platform: 'Ubuntu 24.04 LTS',
      matcher: architecture === 'arm64'
        ? /ubuntu.*24\.04.*arm64/i
        : /ubuntu.*24\.04.*(amd64|x86_64)/i,
      includeDescription: /Ubuntu/i
    },
    {
      owner: '099720109477',
      platform: 'Ubuntu 22.04 LTS',
      matcher: architecture === 'arm64'
        ? /ubuntu.*22\.04.*arm64/i
        : /ubuntu.*22\.04.*(amd64|x86_64)/i,
      includeDescription: /Ubuntu/i
    }
  ]

  const options: BastionAmiOption[] = []

  for (const family of families) {
    const output = await client.send(
      new DescribeImagesCommand({
        Owners: [family.owner],
        Filters: [
          { Name: 'state', Values: ['available'] },
          { Name: 'root-device-type', Values: ['ebs'] },
          { Name: 'virtualization-type', Values: ['hvm'] },
          ...(architecture ? [{ Name: 'architecture', Values: [architecture] }] : [])
        ]
      })
    )

    const image = [...(output.Images ?? [])]
      .filter((candidate) => {
        const name = candidate.Name ?? ''
        const description = candidate.Description ?? ''
        return family.matcher.test(name) || family.includeDescription.test(description)
      })
      .sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? ''))[0]

    if (!image?.ImageId) {
      continue
    }

    options.push({
      imageId: image.ImageId,
      name: image.Name ?? image.ImageId,
      description: image.Description ?? '',
      platform: family.platform,
      architecture: image.Architecture ?? architecture ?? '-',
      creationDate: image.CreationDate ?? '-'
    })
  }

  return options
}

/* ── VPC pivot ─────────────────────────────────────────────── */

export async function describeVpc(connection: AwsConnection, vpcId: string): Promise<Ec2VpcDetail | null> {
  const client = createClient(connection)
  const output = await client.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }))
  const vpc = output.Vpcs?.[0]
  if (!vpc) return null

  return {
    vpcId: vpc.VpcId ?? '-',
    cidrBlock: vpc.CidrBlock ?? '-',
    state: vpc.State ?? '-',
    isDefault: vpc.IsDefault ?? false,
    tags: readTags(vpc.Tags)
  }
}

/* ── Launch from snapshot ──────────────────────────────────── */

export async function launchFromSnapshot(connection: AwsConnection, config: SnapshotLaunchConfig): Promise<string> {
  const client = createClient(connection)

  const amiOutput = await client.send(
    new RegisterImageCommand({
      Name: config.name,
      Architecture: config.architecture as never,
      RootDeviceName: '/dev/xvda',
      VirtualizationType: 'hvm',
      EnaSupport: true,
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: { SnapshotId: config.snapshotId, VolumeType: 'gp3', DeleteOnTermination: true }
        }
      ]
    })
  )
  const imageId = amiOutput.ImageId
  if (!imageId) throw new Error('Failed to register AMI from snapshot')

  const runOutput = await client.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: config.instanceType as never,
      MinCount: 1,
      MaxCount: 1,
      KeyName: config.keyName,
      SubnetId: config.subnetId,
      SecurityGroupIds: config.securityGroupIds,
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: `launched-from-${config.snapshotId}` },
            { Key: 'aws-lens:source-snapshot', Value: config.snapshotId }
          ]
        }
      ]
    })
  )

  return runOutput.Instances?.[0]?.InstanceId ?? ''
}

/* ── EC2 Instance Connect (temp SSH key) ───────────────────── */

export async function sendSshPublicKey(
  connection: AwsConnection,
  instanceId: string,
  osUser: string,
  publicKey: string,
  availabilityZone: string
): Promise<boolean> {
  const connectClient = new EC2InstanceConnectClient(awsClientConfig(connection))
  const output = await connectClient.send(
    new SendSSHPublicKeyCommand({
      InstanceId: instanceId,
      InstanceOSUser: osUser,
      SSHPublicKey: publicKey,
      AvailabilityZone: availabilityZone
    })
  )
  return output.Success ?? false
}

/* ── Instance right-sizing recommendations ───────────────── */

// Ordered instance size ladder within a family (e.g. t3.micro → t3.small → t3.medium ...)
const SIZE_LADDER = ['nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge', '48xlarge']

function parseFamilySize(instanceType: string): { family: string; size: string } | null {
  const dot = instanceType.indexOf('.')
  if (dot < 0) return null
  return { family: instanceType.substring(0, dot), size: instanceType.substring(dot + 1) }
}

function suggestResize(currentType: string, direction: 'up' | 'down'): string | null {
  const parsed = parseFamilySize(currentType)
  if (!parsed) return null
  const idx = SIZE_LADDER.indexOf(parsed.size)
  if (idx < 0) return null
  const nextIdx = direction === 'up' ? idx + 1 : idx - 1
  if (nextIdx < 0 || nextIdx >= SIZE_LADDER.length) return null
  return `${parsed.family}.${SIZE_LADDER[nextIdx]}`
}

export async function getEc2Recommendations(connection: AwsConnection): Promise<Ec2Recommendation[]> {
  const { CloudWatchClient, GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch')
  const instances = await listEc2Instances(connection)
  const running = instances.filter((i) => i.state === 'running')
  if (running.length === 0) return []

  const client = new CloudWatchClient(awsClientConfig(connection))
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000) // 7 days

  // Query CPU for all running instances in one batch
  const queries = running.map((inst, i) => ({
    Id: `cpu${i}`,
    Label: inst.instanceId,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/EC2',
        MetricName: 'CPUUtilization',
        Dimensions: [{ Name: 'InstanceId', Value: inst.instanceId }]
      },
      Period: 3600, // 1-hour granularity
      Stat: 'Average'
    }
  }))

  // CloudWatch allows max 500 queries per call
  const allResults: Array<{ instanceId: string; values: number[] }> = []
  for (let offset = 0; offset < queries.length; offset += 500) {
    const batch = queries.slice(offset, offset + 500)
    const output = await client.send(new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: batch
    }))
    for (const result of output.MetricDataResults ?? []) {
      allResults.push({
        instanceId: result.Label ?? '',
        values: (result.Values ?? []).map(Number)
      })
    }
  }

  const recommendations: Ec2Recommendation[] = []

  for (const result of allResults) {
    const inst = running.find((i) => i.instanceId === result.instanceId)
    if (!inst || result.values.length === 0) continue

    const avg = result.values.reduce((a, b) => a + b, 0) / result.values.length
    const max = Math.max(...result.values)

    // Underutilized: average CPU < 10% over 7 days → suggest downsizing
    if (avg < 10 && max < 40) {
      const suggested = suggestResize(inst.type, 'down')
      if (suggested) {
        recommendations.push({
          instanceId: inst.instanceId,
          instanceName: inst.name !== '-' ? inst.name : inst.instanceId,
          currentType: inst.type,
          suggestedType: suggested,
          reason: `Average CPU ${avg.toFixed(1)}% (max ${max.toFixed(1)}%) over 7 days — instance is underutilized. Consider downsizing.`,
          avgCpu: Math.round(avg * 10) / 10,
          maxCpu: Math.round(max * 10) / 10,
          severity: 'warning'
        })
      }
    }

    // Overutilized: average CPU > 80% → suggest upsizing
    if (avg > 80) {
      const suggested = suggestResize(inst.type, 'up')
      if (suggested) {
        recommendations.push({
          instanceId: inst.instanceId,
          instanceName: inst.name !== '-' ? inst.name : inst.instanceId,
          currentType: inst.type,
          suggestedType: suggested,
          reason: `Average CPU ${avg.toFixed(1)}% (max ${max.toFixed(1)}%) over 7 days — instance is overutilized. Consider upsizing.`,
          avgCpu: Math.round(avg * 10) / 10,
          maxCpu: Math.round(max * 10) / 10,
          severity: 'warning'
        })
      }
    }

    // Moderately high: average CPU between 60-80%
    if (avg >= 60 && avg <= 80) {
      recommendations.push({
        instanceId: inst.instanceId,
        instanceName: inst.name !== '-' ? inst.name : inst.instanceId,
        currentType: inst.type,
        suggestedType: inst.type,
        reason: `Average CPU ${avg.toFixed(1)}% — monitor for sustained high usage.`,
        avgCpu: Math.round(avg * 10) / 10,
        maxCpu: Math.round(max * 10) / 10,
        severity: 'info'
      })
    }
  }

  return recommendations
}
