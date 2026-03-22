import {
  AssociateIamInstanceProfileCommand,
  CreateSecurityGroupCommand,
  CreateSnapshotCommand,
  CreateTagsCommand,
  DeleteSecurityGroupCommand,
  DeleteSnapshotCommand,
  DeleteTagsCommand,
  DescribeImagesCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstanceTypesCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeSnapshotsCommand,
  DescribeVpcsCommand,
  DisassociateIamInstanceProfileCommand,
  EC2Client,
  ModifyInstanceAttributeCommand,
  RebootInstancesCommand,
  RegisterImageCommand,
  ReplaceIamInstanceProfileAssociationCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  waitUntilInstanceTerminated,
  type Instance
} from '@aws-sdk/client-ec2'
import { EC2InstanceConnectClient, SendSSHPublicKeyCommand } from '@aws-sdk/client-ec2-instance-connect'

import { awsClientConfig, readTags } from './client'
import type {
  AwsConnection,
  BastionAmiOption,
  BastionConnectionInfo,
  BastionLaunchConfig,
  Ec2IamAssociation,
  Ec2InstanceAction,
  Ec2InstanceDetail,
  Ec2InstanceSummary,
  Ec2InstanceTypeOption,
  Ec2Recommendation,
  Ec2SnapshotSummary,
  Ec2VpcDetail,
  SnapshotLaunchConfig
} from '@shared/types'

function createClient(connection: AwsConnection): EC2Client {
  return new EC2Client(awsClientConfig(connection))
}

const BASTION_TAG_PREFIX = 'aws-lens-bastion#'
const BASTION_PURPOSE_TAG = 'aws-lens:purpose'
const BASTION_UUID_TAG = 'aws-lens:bastion-uuid'
const BASTION_TARGET_INSTANCE_TAG = 'aws-lens:bastion-target-instance-id'
const BASTION_MANAGED_SG_TAG = 'aws-lens:bastion-managed-sg'

function buildBastionTagKey(uuid: string): string {
  return `${BASTION_TAG_PREFIX}${uuid}`
}

function listBastionUuids(tags: Record<string, string> | undefined): string[] {
  return Object.entries(tags ?? {})
    .filter(([key, value]) => key.startsWith(BASTION_TAG_PREFIX) && value === 'true')
    .map(([key]) => key.slice(BASTION_TAG_PREFIX.length))
    .filter(Boolean)
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

/* ── Instance list ─────────────────────────────────────────── */

function toInstanceSummary(instance: Instance): Ec2InstanceSummary {
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
    launchTime: instance.LaunchTime?.toISOString() ?? '-'
  }
}

export async function listEc2Instances(connection: AwsConnection): Promise<Ec2InstanceSummary[]> {
  const client = createClient(connection)
  const instances: Ec2InstanceSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
    for (const reservation of output.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        instances.push(toInstanceSummary(instance))
      }
    }
    nextToken = output.NextToken
  } while (nextToken)

  return instances
}

/* ── Instance detail ───────────────────────────────────────── */

function toInstanceDetail(instance: Instance, iamAssociationId: string): Ec2InstanceDetail {
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
    stateTransitionReason: instance.StateTransitionReason ?? '-'
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

  return toInstanceDetail(instance, iamAssociationId)
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
