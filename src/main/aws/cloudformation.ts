import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  ListStacksCommand
} from '@aws-sdk/client-cloudformation'

import type {
  AwsConnection,
  CloudFormationResourceSummary,
  CloudFormationStackSummary
} from '@shared/types'
import { awsClientConfig } from './client'

function createClient(connection: AwsConnection): CloudFormationClient {
  return new CloudFormationClient(awsClientConfig(connection))
}

export async function listStacks(connection: AwsConnection): Promise<CloudFormationStackSummary[]> {
  const client = createClient(connection)
  const stacks: CloudFormationStackSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListStacksCommand({
      NextToken: nextToken,
      StackStatusFilter: [
        'CREATE_COMPLETE',
        'CREATE_FAILED',
        'ROLLBACK_COMPLETE',
        'ROLLBACK_FAILED',
        'UPDATE_COMPLETE',
        'UPDATE_ROLLBACK_COMPLETE',
        'UPDATE_IN_PROGRESS',
        'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'
      ]
    }))

    for (const item of output.StackSummaries ?? []) {
      stacks.push({
        stackName: item.StackName ?? '-',
        stackId: item.StackId ?? '-',
        status: item.StackStatus ?? '-',
        description: '',
        creationTime: item.CreationTime?.toISOString() ?? '-',
        lastUpdatedTime: item.LastUpdatedTime?.toISOString() ?? '-'
      })
    }

    nextToken = output.NextToken
  } while (nextToken)

  return stacks.sort((left, right) => left.stackName.localeCompare(right.stackName))
}

export async function listStackResources(
  connection: AwsConnection,
  stackName: string
): Promise<CloudFormationResourceSummary[]> {
  const client = createClient(connection)
  const output = await client.send(new DescribeStackResourcesCommand({ StackName: stackName }))

  return (output.StackResources ?? []).map((item) => ({
    logicalResourceId: item.LogicalResourceId ?? '-',
    physicalResourceId: item.PhysicalResourceId ?? '-',
    resourceType: item.ResourceType ?? '-',
    resourceStatus: item.ResourceStatus ?? '-',
    timestamp: item.Timestamp?.toISOString() ?? '-'
  }))
}
