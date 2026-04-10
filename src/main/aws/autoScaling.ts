import {
  AutoScalingClient,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
  StartInstanceRefreshCommand,
  UpdateAutoScalingGroupCommand
} from '@aws-sdk/client-auto-scaling'

import { getAwsClient } from './client'
import type { AutoScalingGroupSummary, AutoScalingInstanceSummary, AwsConnection } from '@shared/types'

export async function listAutoScalingGroups(connection: AwsConnection): Promise<AutoScalingGroupSummary[]> {
  const client = getAwsClient(AutoScalingClient, connection)
  const groups: AutoScalingGroupSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeAutoScalingGroupsCommand({ NextToken: nextToken }))
    for (const item of output.AutoScalingGroups ?? []) {
      groups.push({
        name: item.AutoScalingGroupName ?? '-',
        min: item.MinSize ?? '-',
        desired: item.DesiredCapacity ?? '-',
        max: item.MaxSize ?? '-',
        instances: item.Instances?.length ?? 0,
        healthCheck: item.HealthCheckType ?? '-',
        instanceRefresh: item.Status ?? '-'
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return groups
}

export async function listAutoScalingGroupInstances(
  connection: AwsConnection,
  groupName: string
): Promise<AutoScalingInstanceSummary[]> {
  const client = getAwsClient(AutoScalingClient, connection)
  const output = await client.send(
    new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [groupName]
    })
  )
  const group = output.AutoScalingGroups?.[0]

  return (group?.Instances ?? []).map((item) => ({
    instanceId: item.InstanceId ?? '-',
    lifecycleState: item.LifecycleState ?? '-',
    healthStatus: item.HealthStatus ?? '-',
    protectedFromScaleIn: item.ProtectedFromScaleIn ?? false,
    availabilityZone: item.AvailabilityZone ?? '-'
  }))
}

export async function updateAutoScalingGroupCapacity(
  connection: AwsConnection,
  groupName: string,
  minimum: number,
  desired: number,
  maximum: number
): Promise<void> {
  const client = getAwsClient(AutoScalingClient, connection)
  await client.send(
    new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: groupName,
      MinSize: minimum,
      DesiredCapacity: desired,
      MaxSize: maximum
    })
  )
}

export async function startAutoScalingInstanceRefresh(
  connection: AwsConnection,
  groupName: string
): Promise<string> {
  const client = getAwsClient(AutoScalingClient, connection)
  const output = await client.send(
    new StartInstanceRefreshCommand({
      AutoScalingGroupName: groupName
    })
  )

  return output.InstanceRefreshId ?? '-'
}

export async function deleteAutoScalingGroup(
  connection: AwsConnection,
  groupName: string,
  forceDelete = false
): Promise<void> {
  const client = getAwsClient(AutoScalingClient, connection)
  await client.send(
    new DeleteAutoScalingGroupCommand({
      AutoScalingGroupName: groupName,
      ForceDelete: forceDelete
    })
  )
}
