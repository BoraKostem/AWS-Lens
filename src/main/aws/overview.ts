import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { DescribeInstancesCommand, DescribeKeyPairsCommand, DescribeSecurityGroupsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2'
import { ListFunctionsCommand, LambdaClient, ListTagsCommand as ListLambdaTagsCommand } from '@aws-sdk/client-lambda'
import { DescribeClusterCommand, EKSClient, ListClustersCommand } from '@aws-sdk/client-eks'
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling'
import { GetBucketTaggingCommand, S3Client, ListBucketsCommand } from '@aws-sdk/client-s3'
import { RDSClient, DescribeDBInstancesCommand, ListTagsForResourceCommand as ListRdsTagsForResourceCommand } from '@aws-sdk/client-rds'
import { CloudFormationClient, DescribeStacksCommand, ListStacksCommand } from '@aws-sdk/client-cloudformation'
import { ECRClient, DescribeRepositoriesCommand, ListTagsForResourceCommand as ListEcrTagsForResourceCommand } from '@aws-sdk/client-ecr'
import { DescribeClustersCommand as DescribeEcsClustersCommand, ECSClient, ListClustersCommand as EcsListClustersCommand } from '@aws-sdk/client-ecs'
import { DescribeLoadBalancersCommand, DescribeTagsCommand as DescribeLoadBalancerTagsCommand, ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2'
import { ListHostedZonesCommand, ListTagsForResourcesCommand as ListRoute53TagsForResourcesCommand, Route53Client } from '@aws-sdk/client-route-53'
import { ListTagsForResourceCommand, SNSClient, ListTopicsCommand } from '@aws-sdk/client-sns'
import { ListQueueTagsCommand, SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs'
import { ACMClient, ListCertificatesCommand, ListTagsForCertificateCommand } from '@aws-sdk/client-acm'
import { DescribeKeyCommand, KMSClient, ListKeysCommand, ListResourceTagsCommand } from '@aws-sdk/client-kms'
import { ListTagsForResourceCommand as ListWafTagsForResourceCommand, ListWebACLsCommand, WAFV2Client } from '@aws-sdk/client-wafv2'
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager'
import { CloudWatchClient, DescribeAlarmsCommand, ListTagsForResourceCommand as ListCloudWatchTagsForResourceCommand } from '@aws-sdk/client-cloudwatch'
import { CloudTrailClient, DescribeTrailsCommand, ListTagsCommand as ListCloudTrailTagsCommand } from '@aws-sdk/client-cloudtrail'
import { IAMClient, ListRolesCommand, ListRoleTagsCommand, ListUsersCommand, ListUserTagsCommand } from '@aws-sdk/client-iam'
import {
  DescribeOrganizationCommand,
  ListAccountsForParentCommand,
  ListOrganizationalUnitsForParentCommand,
  ListRootsCommand,
  OrganizationsClient
} from '@aws-sdk/client-organizations'

import { getAwsClient, readTags } from './client'
import { getAwsCapabilitySnapshot } from './capabilities'
import { getCallerIdentity } from './sts'
import { logWarn } from '../observability'
import type {
  AwsConnection,
  BillingLinkedAccountSummary,
  BillingOwnershipValueSummary,
  BillingTagOwnershipHint,
  CostBreakdown,
  CostBreakdownEntry,
  GovernanceTagKey,
  InsightItem,
  OverviewAccountContext,
  OverviewOrganizationContext,
  OverviewOrganizationNode,
  OverviewMetrics,
  OverviewStat,
  OverviewStatistics,
  RegionCostRow,
  RegionMetric,
  RegionalSignal,
  RelationshipMap,
  ServiceRelationship,
  TagCostEntry,
  TagSearchResult,
  TaggedResource
} from '@shared/types'

/* ── Cost Explorer (monthly current-month spend) ──────────── */
const COST_EXPLORER_METRIC = 'UnblendedCost' as const
const COST_EXPLORER_METRIC_LABEL = 'Unblended cost'
const BILLING_HOME_REGION = 'us-east-1'
const ORGANIZATIONS_HOME_REGION = 'us-east-1'
const ORGANIZATION_TREE_DEPTH_LIMIT = 4
const ORGANIZATION_TREE_NODE_LIMIT = 250
const OWNERSHIP_TAG_KEYS: GovernanceTagKey[] = ['Owner', 'Environment', 'Project', 'CostCenter']

/* ── helpers ──────────────────────────────────────────────── */

async function countEc2(connection: AwsConnection): Promise<{
  count: number
  instances: Array<{
    id: string
    name: string
    vpcId: string
    subnetId: string
    state: string
    type: string
    keyName: string
    iamProfile: string
    tags: Record<string, string>
  }>
}> {
  const client = getAwsClient(EC2Client, connection)
  const instances: Array<{
    id: string
    name: string
    vpcId: string
    subnetId: string
    state: string
    type: string
    keyName: string
    iamProfile: string
    tags: Record<string, string>
  }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
    for (const reservation of output.Reservations ?? []) {
      for (const inst of reservation.Instances ?? []) {
        const tags = readTags(inst.Tags)
        instances.push({
          id: inst.InstanceId ?? '-',
          name: tags.Name ?? '-',
          vpcId: inst.VpcId ?? '-',
          subnetId: inst.SubnetId ?? '-',
          state: inst.State?.Name ?? '-',
          type: inst.InstanceType ?? '-',
          keyName: inst.KeyName ?? '-',
          iamProfile: inst.IamInstanceProfile?.Arn ?? '-',
          tags
        })
      }
    }
    nextToken = output.NextToken
  } while (nextToken)

  return { count: instances.length, instances }
}

async function countLambda(connection: AwsConnection): Promise<{
  count: number
  functions: Array<{ name: string; runtime: string; role: string; tags: Record<string, string> }>
}> {
  const client = getAwsClient(LambdaClient, connection)
  const functions: Array<{ name: string; runtime: string; role: string; tags: Record<string, string> }> = []
  let marker: string | undefined

  do {
    const output = await client.send(new ListFunctionsCommand({ Marker: marker }))
    for (const fn of output.Functions ?? []) {
      functions.push({
        name: fn.FunctionName ?? '-',
        runtime: fn.Runtime ?? '-',
        role: fn.Role ?? '-',
        tags: {}
      })
    }
    marker = output.NextMarker
  } while (marker)

  return { count: functions.length, functions }
}

async function countEks(connection: AwsConnection): Promise<{
  count: number
  clusters: Array<{ name: string; roleArn: string; vpcId: string }>
}> {
  const client = getAwsClient(EKSClient, connection)
  const clusters: Array<{ name: string; roleArn: string; vpcId: string }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListClustersCommand({ nextToken }))
    for (const name of output.clusters ?? []) {
      clusters.push({ name, roleArn: '', vpcId: '' })
    }
    nextToken = output.nextToken
  } while (nextToken)

  return { count: clusters.length, clusters }
}

async function countAsg(connection: AwsConnection): Promise<{
  count: number
  groups: Array<{
    name: string
    instances: number
    desired: number
    tags: Record<string, string>
  }>
}> {
  const client = getAwsClient(AutoScalingClient, connection)
  const groups: Array<{
    name: string
    instances: number
    desired: number
    tags: Record<string, string>
  }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeAutoScalingGroupsCommand({ NextToken: nextToken }))
    for (const item of output.AutoScalingGroups ?? []) {
      const tags: Record<string, string> = {}
      for (const tag of item.Tags ?? []) {
        if (tag.Key) tags[tag.Key] = tag.Value ?? ''
      }
      groups.push({
        name: item.AutoScalingGroupName ?? '-',
        instances: item.Instances?.length ?? 0,
        desired: item.DesiredCapacity ?? 0,
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return { count: groups.length, groups }
}

async function countS3(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(S3Client, connection)
  const output = await client.send(new ListBucketsCommand({}))
  return output.Buckets?.length ?? 0
}

async function countRds(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(RDSClient, connection)
  let count = 0
  let marker: string | undefined
  do {
    const output = await client.send(new DescribeDBInstancesCommand({ Marker: marker }))
    count += output.DBInstances?.length ?? 0
    marker = output.Marker
  } while (marker)
  return count
}

async function countCloudFormation(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(CloudFormationClient, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new ListStacksCommand({
      NextToken: nextToken,
      StackStatusFilter: [
        'CREATE_COMPLETE',
        'CREATE_IN_PROGRESS',
        'CREATE_FAILED',
        'ROLLBACK_COMPLETE',
        'ROLLBACK_FAILED',
        'UPDATE_COMPLETE',
        'UPDATE_ROLLBACK_COMPLETE',
        'UPDATE_IN_PROGRESS',
        'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'
      ]
    }))
    count += output.StackSummaries?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countEcr(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(ECRClient, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new DescribeRepositoriesCommand({ nextToken }))
    count += output.repositories?.length ?? 0
    nextToken = output.nextToken
  } while (nextToken)
  return count
}

async function countEcs(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(ECSClient, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new EcsListClustersCommand({ nextToken }))
    count += output.clusterArns?.length ?? 0
    nextToken = output.nextToken
  } while (nextToken)
  return count
}

async function countVpc(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(EC2Client, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new DescribeVpcsCommand({ NextToken: nextToken }))
    count += output.Vpcs?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countAllVpc(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(EC2Client, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new DescribeVpcsCommand({ NextToken: nextToken }))
    count += output.Vpcs?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countLoadBalancers(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(ElasticLoadBalancingV2Client, connection)
  let count = 0
  let marker: string | undefined
  do {
    const output = await client.send(new DescribeLoadBalancersCommand({ Marker: marker }))
    count += output.LoadBalancers?.length ?? 0
    marker = output.NextMarker
  } while (marker)
  return count
}

async function countRoute53(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(Route53Client, connection)
  const output = await client.send(new ListHostedZonesCommand({}))
  return output.HostedZones?.length ?? 0
}

async function countSecurityGroups(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(EC2Client, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }))
    count += output.SecurityGroups?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countSns(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(SNSClient, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new ListTopicsCommand({ NextToken: nextToken }))
    count += output.Topics?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countSqs(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(SQSClient, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new ListQueuesCommand({ NextToken: nextToken }))
    count += output.QueueUrls?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countAcm(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(ACMClient, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new ListCertificatesCommand({ NextToken: nextToken }))
    count += output.CertificateSummaryList?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countKms(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(KMSClient, connection)
  let count = 0
  let marker: string | undefined
  do {
    const output = await client.send(new ListKeysCommand({ Marker: marker }))
    count += output.Keys?.length ?? 0
    marker = output.NextMarker
    if (!output.Truncated) break
  } while (marker)
  return count
}

async function countWaf(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(WAFV2Client, connection)
  const output = await client.send(new ListWebACLsCommand({ Scope: 'REGIONAL', Limit: 100 }))
  return output.WebACLs?.length ?? 0
}

async function countSecretsManager(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(SecretsManagerClient, connection)
  let count = 0
  let nextToken: string | undefined
  do {
    const output = await client.send(new ListSecretsCommand({ NextToken: nextToken }))
    count += output.SecretList?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken)
  return count
}

async function countKeyPairs(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(EC2Client, connection)
  const output = await client.send(new DescribeKeyPairsCommand({}))
  return output.KeyPairs?.length ?? 0
}

async function countCloudWatch(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(CloudWatchClient, connection)
  const output = await client.send(new DescribeAlarmsCommand({}))
  return output.MetricAlarms?.length ?? 0
}

async function countCloudTrail(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(CloudTrailClient, connection)
  const output = await client.send(new DescribeTrailsCommand({}))
  return output.trailList?.length ?? 0
}

async function countIam(connection: AwsConnection): Promise<number> {
  const client = getAwsClient(IAMClient, connection)
  const [users, roles] = await Promise.all([
    client.send(new ListUsersCommand({})),
    client.send(new ListRolesCommand({}))
  ])
  return (users.Users?.length ?? 0) + (roles.Roles?.length ?? 0)
}

/* ── safe-fetch: returns zero counts on permission / network errors ── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Throttl|TooManyRequests|RequestLimitExceeded|Timeout|timed out|ECONNRESET|network/i.test(message)
}

async function safeCount<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        return fallback
      }
      await sleep(150 * attempt)
    }
  }

  return fallback
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  )

  return results
}

async function listTaggedLambda(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(LambdaClient, connection)
  const functions: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let marker: string | undefined

  do {
    const output = await client.send(new ListFunctionsCommand({ Marker: marker }))
    for (const fn of output.Functions ?? []) {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListLambdaTagsCommand({ Resource: fn.FunctionArn ?? '' }))
        tags = tagOutput.Tags ?? {}
      } catch {
        tags = {}
      }

      functions.push({
        id: fn.FunctionArn ?? fn.FunctionName ?? '-',
        name: fn.FunctionName ?? '-',
        tags
      })
    }
    marker = output.NextMarker
  } while (marker)

  return functions
}

async function listTaggedEks(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(EKSClient, connection)
  const clusters: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListClustersCommand({ nextToken }))
    for (const name of output.clusters ?? []) {
      let tags: Record<string, string> = {}

      try {
        const detail = await client.send(new DescribeClusterCommand({ name }))
        tags = detail.cluster?.tags ?? {}
      } catch {
        tags = {}
      }

      clusters.push({
        id: name,
        name,
        tags
      })
    }
    nextToken = output.nextToken
  } while (nextToken)

  return clusters
}

async function listTaggedVpcs(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(EC2Client, connection)
  const vpcs: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeVpcsCommand({ NextToken: nextToken }))
    for (const vpc of output.Vpcs ?? []) {
      const tags = readTags(vpc.Tags)
      vpcs.push({
        id: vpc.VpcId ?? '-',
        name: tags.Name ?? vpc.VpcId ?? '-',
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return vpcs
}

async function listTaggedSecurityGroups(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(EC2Client, connection)
  const groups: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }))
    for (const group of output.SecurityGroups ?? []) {
      const tags = readTags(group.Tags)
      groups.push({
        id: group.GroupId ?? '-',
        name: tags.Name ?? group.GroupName ?? group.GroupId ?? '-',
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return groups
}

async function listTaggedSns(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(SNSClient, connection)
  const topics: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListTopicsCommand({ NextToken: nextToken }))
    for (const topic of output.Topics ?? []) {
      const arn = topic.TopicArn ?? '-'
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListTagsForResourceCommand({ ResourceArn: arn }))
        for (const tag of tagOutput.Tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
      } catch {
        tags = {}
      }

      topics.push({
        id: arn,
        name: arn.split(':').pop() ?? arn,
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return topics
}

async function listTaggedSqs(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(SQSClient, connection)
  const queues: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListQueuesCommand({ NextToken: nextToken }))
    for (const queueUrl of output.QueueUrls ?? []) {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListQueueTagsCommand({ QueueUrl: queueUrl }))
        tags = tagOutput.Tags ?? {}
      } catch {
        tags = {}
      }

      queues.push({
        id: queueUrl,
        name: queueUrl.split('/').pop() ?? queueUrl,
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return queues
}

async function listTaggedSecrets(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(SecretsManagerClient, connection)
  const secrets: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListSecretsCommand({ NextToken: nextToken }))
    for (const secret of output.SecretList ?? []) {
      secrets.push({
        id: secret.ARN ?? secret.Name ?? '-',
        name: secret.Name ?? '-',
        tags: readTags(secret.Tags)
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return secrets
}

async function listTaggedKeyPairs(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(EC2Client, connection)
  const output = await client.send(new DescribeKeyPairsCommand({}))

  return (output.KeyPairs ?? []).map((pair) => {
    const tags = readTags(pair.Tags)
    return {
      id: pair.KeyPairId ?? pair.KeyName ?? '-',
      name: tags.Name ?? pair.KeyName ?? '-',
      tags
    }
  })
}

async function listTaggedS3(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(S3Client, connection)
  const output = await client.send(new ListBucketsCommand({}))
  const buckets = output.Buckets ?? []

  return mapWithConcurrency(buckets, 5, async (bucket) => {
    const name = bucket.Name ?? '-'
    let tags: Record<string, string> = {}

    try {
      const tagOutput = await client.send(new GetBucketTaggingCommand({ Bucket: name }))
      for (const tag of tagOutput.TagSet ?? []) {
        if (tag.Key) tags[tag.Key] = tag.Value ?? ''
      }
    } catch {
      tags = {}
    }

    return { id: name, name, tags }
  })
}

async function listTaggedRds(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(RDSClient, connection)
  const instances: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let marker: string | undefined

  do {
    const output = await client.send(new DescribeDBInstancesCommand({ Marker: marker }))
    const pageItems = await mapWithConcurrency(output.DBInstances ?? [], 5, async (instance) => {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListRdsTagsForResourceCommand({ ResourceName: instance.DBInstanceArn ?? '' }))
        tags = readTags(tagOutput.TagList)
      } catch {
        tags = {}
      }

      return {
        id: instance.DBInstanceArn ?? instance.DBInstanceIdentifier ?? '-',
        name: instance.DBInstanceIdentifier ?? '-',
        tags
      }
    })

    instances.push(...pageItems)
    marker = output.Marker
  } while (marker)

  return instances
}

async function listTaggedCloudFormation(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(CloudFormationClient, connection)
  const stacks: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeStacksCommand({ NextToken: nextToken }))
    for (const stack of output.Stacks ?? []) {
      stacks.push({
        id: stack.StackId ?? stack.StackName ?? '-',
        name: stack.StackName ?? '-',
        tags: readTags(stack.Tags)
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return stacks
}

async function listTaggedEcr(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(ECRClient, connection)
  const repositories: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeRepositoriesCommand({ nextToken }))
    const pageItems = await mapWithConcurrency(output.repositories ?? [], 5, async (repository) => {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListEcrTagsForResourceCommand({ resourceArn: repository.repositoryArn ?? '' }))
        for (const tag of tagOutput.tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
      } catch {
        tags = {}
      }

      return {
        id: repository.repositoryArn ?? repository.repositoryName ?? '-',
        name: repository.repositoryName ?? '-',
        tags
      }
    })

    repositories.push(...pageItems)
    nextToken = output.nextToken
  } while (nextToken)

  return repositories
}

async function listTaggedEcs(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(ECSClient, connection)
  const clusters: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new EcsListClustersCommand({ nextToken }))
    const clusterArns = output.clusterArns ?? []

    for (let index = 0; index < clusterArns.length; index += 100) {
      const batch = clusterArns.slice(index, index + 100)
      if (batch.length === 0) continue

      try {
        const detail = await client.send(new DescribeEcsClustersCommand({ clusters: batch, include: ['TAGS'] }))
        for (const cluster of detail.clusters ?? []) {
          const tags: Record<string, string> = {}
          for (const tag of cluster.tags ?? []) {
            if (tag.key) tags[tag.key] = tag.value ?? ''
          }
          clusters.push({
            id: cluster.clusterArn ?? cluster.clusterName ?? '-',
            name: cluster.clusterName ?? cluster.clusterArn ?? '-',
            tags
          })
        }
      } catch {
        for (const arn of batch) {
          clusters.push({
            id: arn,
            name: arn.split('/').pop() ?? arn,
            tags: {}
          })
        }
      }
    }

    nextToken = output.nextToken
  } while (nextToken)

  return clusters
}

async function listTaggedLoadBalancers(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(ElasticLoadBalancingV2Client, connection)
  const balancers: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let marker: string | undefined

  do {
    const output = await client.send(new DescribeLoadBalancersCommand({ Marker: marker }))
    const pageBalancers = output.LoadBalancers ?? []

    for (let index = 0; index < pageBalancers.length; index += 20) {
      const batch = pageBalancers.slice(index, index + 20)
      const arns = batch.map((item) => item.LoadBalancerArn).filter((value): value is string => Boolean(value))
      const tagsByArn = new Map<string, Record<string, string>>()

      if (arns.length > 0) {
        try {
          const tagOutput = await client.send(new DescribeLoadBalancerTagsCommand({ ResourceArns: arns }))
          for (const description of tagOutput.TagDescriptions ?? []) {
            const tags: Record<string, string> = {}
            for (const tag of description.Tags ?? []) {
              if (tag.Key) tags[tag.Key] = tag.Value ?? ''
            }
            if (description.ResourceArn) {
              tagsByArn.set(description.ResourceArn, tags)
            }
          }
        } catch {
          // ignore tag lookup failures
        }
      }

      for (const balancer of batch) {
        const arn = balancer.LoadBalancerArn ?? balancer.LoadBalancerName ?? '-'
        balancers.push({
          id: arn,
          name: balancer.LoadBalancerName ?? arn,
          tags: tagsByArn.get(arn) ?? {}
        })
      }
    }

    marker = output.NextMarker
  } while (marker)

  return balancers
}

async function listTaggedRoute53(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(Route53Client, connection)
  const output = await client.send(new ListHostedZonesCommand({}))
  const zones = output.HostedZones ?? []
  const zoneIds = zones
    .map((zone) => zone.Id?.split('/').pop())
    .filter((value): value is string => Boolean(value))

  const tagsById = new Map<string, Record<string, string>>()
  for (let index = 0; index < zoneIds.length; index += 10) {
    const batch = zoneIds.slice(index, index + 10)
    try {
      const tagOutput = await client.send(new ListRoute53TagsForResourcesCommand({
        ResourceType: 'hostedzone',
        ResourceIds: batch
      }))

      for (const tagged of tagOutput.ResourceTagSets ?? []) {
        const tags: Record<string, string> = {}
        for (const tag of tagged.Tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
        if (tagged.ResourceId) {
          tagsById.set(tagged.ResourceId, tags)
        }
      }
    } catch {
      // ignore tag lookup failures
    }
  }

  return zones.map((zone) => {
    const zoneId = zone.Id?.split('/').pop() ?? zone.Id ?? '-'
    return {
      id: zone.Id ?? zoneId,
      name: zone.Name ?? zoneId,
      tags: tagsById.get(zoneId) ?? {}
    }
  })
}

async function listTaggedAcm(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(ACMClient, connection)
  const certificates: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListCertificatesCommand({ NextToken: nextToken }))
    const pageItems = await mapWithConcurrency(output.CertificateSummaryList ?? [], 5, async (certificate) => {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListTagsForCertificateCommand({ CertificateArn: certificate.CertificateArn ?? '' }))
        for (const tag of tagOutput.Tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
      } catch {
        tags = {}
      }

      return {
        id: certificate.CertificateArn ?? certificate.DomainName ?? '-',
        name: certificate.DomainName ?? certificate.CertificateArn ?? '-',
        tags
      }
    })

    certificates.push(...pageItems)
    nextToken = output.NextToken
  } while (nextToken)

  return certificates
}

async function listTaggedKms(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(KMSClient, connection)
  const keys: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let marker: string | undefined

  do {
    const output = await client.send(new ListKeysCommand({ Marker: marker }))
    const pageItems = await mapWithConcurrency(output.Keys ?? [], 5, async (key) => {
      let tags: Record<string, string> = {}
      let arn = key.KeyArn ?? ''

      try {
        if (!arn && key.KeyId) {
          const detail = await client.send(new DescribeKeyCommand({ KeyId: key.KeyId }))
          arn = detail.KeyMetadata?.Arn ?? arn
        }

        const tagOutput = await client.send(new ListResourceTagsCommand({ KeyId: key.KeyId ?? '' }))
        for (const tag of tagOutput.Tags ?? []) {
          if (tag.TagKey) tags[tag.TagKey] = tag.TagValue ?? ''
        }
      } catch {
        tags = {}
      }

      return {
        id: arn || key.KeyId || '-',
        name: key.KeyId ?? arn ?? '-',
        tags
      }
    })

    keys.push(...pageItems)
    marker = output.NextMarker
    if (!output.Truncated) break
  } while (marker)

  return keys
}

async function listTaggedWaf(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(WAFV2Client, connection)
  const output = await client.send(new ListWebACLsCommand({ Scope: 'REGIONAL', Limit: 100 }))

  return mapWithConcurrency(output.WebACLs ?? [], 5, async (acl) => {
    let tags: Record<string, string> = {}

    try {
      const tagOutput = await client.send(new ListWafTagsForResourceCommand({ ResourceARN: acl.ARN ?? '' }))
      for (const tag of tagOutput.TagInfoForResource?.TagList ?? []) {
        if (tag.Key) tags[tag.Key] = tag.Value ?? ''
      }
    } catch {
      tags = {}
    }

    return {
      id: acl.ARN ?? acl.Name ?? '-',
      name: acl.Name ?? acl.ARN ?? '-',
      tags
    }
  })
}

async function listTaggedCloudWatch(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(CloudWatchClient, connection)
  const alarms: Array<{ id: string; name: string; tags: Record<string, string> }> = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeAlarmsCommand({ NextToken: nextToken }))
    const pageItems = await mapWithConcurrency(output.MetricAlarms ?? [], 5, async (alarm) => {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListCloudWatchTagsForResourceCommand({ ResourceARN: alarm.AlarmArn ?? '' }))
        for (const tag of tagOutput.Tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
      } catch {
        tags = {}
      }

      return {
        id: alarm.AlarmArn ?? alarm.AlarmName ?? '-',
        name: alarm.AlarmName ?? alarm.AlarmArn ?? '-',
        tags
      }
    })

    alarms.push(...pageItems)
    nextToken = output.NextToken
  } while (nextToken)

  return alarms
}

async function listTaggedCloudTrail(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = getAwsClient(CloudTrailClient, connection)
  const output = await client.send(new DescribeTrailsCommand({}))
  const trails = output.trailList ?? []
  const resourceIds = trails.map((trail) => trail.TrailARN ?? trail.Name).filter((value): value is string => Boolean(value))
  const tagsById = new Map<string, Record<string, string>>()

  for (let index = 0; index < resourceIds.length; index += 20) {
    const batch = resourceIds.slice(index, index + 20)
    try {
      const tagOutput = await client.send(new ListCloudTrailTagsCommand({ ResourceIdList: batch }))
      for (const item of tagOutput.ResourceTagList ?? []) {
        const tags: Record<string, string> = {}
        for (const tag of item.TagsList ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
        if (item.ResourceId) {
          tagsById.set(item.ResourceId, tags)
        }
      }
    } catch {
      // ignore tag lookup failures
    }
  }

  return trails.map((trail) => {
    const id = trail.TrailARN ?? trail.Name ?? '-'
    return {
      id,
      name: trail.Name ?? id,
      tags: tagsById.get(id) ?? {}
    }
  })
}

async function listTaggedIam(connection: AwsConnection): Promise<Array<{ id: string; name: string; service: string; resourceType: string; tags: Record<string, string> }>> {
  const client = getAwsClient(IAMClient, connection)
  const resources: Array<{ id: string; name: string; service: string; resourceType: string; tags: Record<string, string> }> = []

  let userMarker: string | undefined
  do {
    const output = await client.send(new ListUsersCommand({ Marker: userMarker }))
    const users = await mapWithConcurrency(output.Users ?? [], 5, async (user) => {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListUserTagsCommand({ UserName: user.UserName ?? '' }))
        for (const tag of tagOutput.Tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
      } catch {
        tags = {}
      }

      return {
        id: user.Arn ?? user.UserName ?? '-',
        name: user.UserName ?? '-',
        service: 'iam',
        resourceType: 'IAM User',
        tags
      }
    })
    resources.push(...users)
    userMarker = output.IsTruncated ? output.Marker : undefined
  } while (userMarker)

  let roleMarker: string | undefined
  do {
    const output = await client.send(new ListRolesCommand({ Marker: roleMarker }))
    const roles = await mapWithConcurrency(output.Roles ?? [], 5, async (role) => {
      let tags: Record<string, string> = {}

      try {
        const tagOutput = await client.send(new ListRoleTagsCommand({ RoleName: role.RoleName ?? '' }))
        for (const tag of tagOutput.Tags ?? []) {
          if (tag.Key) tags[tag.Key] = tag.Value ?? ''
        }
      } catch {
        tags = {}
      }

      return {
        id: role.Arn ?? role.RoleName ?? '-',
        name: role.RoleName ?? '-',
        service: 'iam',
        resourceType: 'IAM Role',
        tags
      }
    })
    resources.push(...roles)
    roleMarker = output.IsTruncated ? output.Marker : undefined
  } while (roleMarker)

  return resources
}

function matchesTag(tags: Record<string, string>, tagKey: string, tagValue?: string): { key: string; value: string } | null {
  const lowerKey = tagKey.toLowerCase()
  const lowerValue = tagValue?.toLowerCase()

  for (const [k, v] of Object.entries(tags)) {
    if (!k.toLowerCase().includes(lowerKey)) {
      continue
    }
    if (lowerValue && !v.toLowerCase().includes(lowerValue)) {
      continue
    }

    return { key: k, value: v }
  }

  return null
}

function addMatchedTaggedResource(
  resources: TaggedResource[],
  countMap: Map<string, number>,
  item: { resourceId: string; resourceType: string; service: string; name: string; tags: Record<string, string> },
  matchedTag: { key: string; value: string }
): void {
  resources.push(item)

  const mapKey = `${matchedTag.key}=${matchedTag.value}`
  countMap.set(mapKey, (countMap.get(mapKey) ?? 0) + 1)
}

function getCurrentMonthTimePeriod(): { start: Date; end: Date; label: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const label = `${start.toLocaleString('en', { month: 'short' })} ${start.getFullYear()}`

  return { start, end, label }
}

function formatCostExplorerDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10
}

function readCostMetricAmount(
  metrics: Record<string, { Amount?: string; Unit?: string } | undefined> | undefined
): number {
  return parseFloat(metrics?.[COST_EXPLORER_METRIC]?.Amount ?? '0')
}

function createBillingCostExplorerClient(connection: AwsConnection): CostExplorerClient {
  return getAwsClient(CostExplorerClient, { ...connection, region: BILLING_HOME_REGION })
}

function getCurrentMonthCostExplorerWindow(): {
  label: string
  timePeriod: {
    Start: string
    End: string
  }
} {
  const { start, end, label } = getCurrentMonthTimePeriod()

  return {
    label,
    timePeriod: {
      Start: formatCostExplorerDate(start),
      End: formatCostExplorerDate(end)
    }
  }
}

function createEmptyCurrentMonthCost(): { total: number; period: string } {
  return {
    total: 0,
    period: getCurrentMonthCostExplorerWindow().label
  }
}

function createRegionCostRow(region: string, totalCost = 0): RegionCostRow {
  return {
    region,
    ec2Cost: 0,
    lambdaCost: 0,
    eksCost: 0,
    asgCost: 0,
    s3Cost: 0,
    rdsCost: 0,
    cfnCost: 0,
    ecrCost: 0,
    ecsCost: 0,
    vpcCost: 0,
    elbCost: 0,
    r53Cost: 0,
    sgCost: 0,
    snsCost: 0,
    sqsCost: 0,
    acmCost: 0,
    kmsCost: 0,
    wafCost: 0,
    smCost: 0,
    kpCost: 0,
    cwCost: 0,
    totalCost: roundCurrency(totalCost)
  }
}

function buildSharePercent(amount: number, total: number): number {
  if (total <= 0) {
    return 0
  }

  return roundPercent((amount / total) * 100)
}

function parseTagGroupValue(tagKey: GovernanceTagKey, rawKey: string): string {
  const prefix = `${tagKey}$`
  const rawValue = rawKey.startsWith(prefix)
    ? rawKey.slice(prefix.length)
    : rawKey.includes('$')
      ? rawKey.slice(rawKey.indexOf('$') + 1)
      : rawKey

  return rawValue.trim()
}

function isAssignedTagValue(value: string): boolean {
  const normalized = value.trim().toLowerCase()

  if (!normalized) {
    return false
  }

  return normalized !== '(none)' &&
    normalized !== '(empty)' &&
    normalized !== 'no tag key' &&
    normalized !== 'untagged' &&
    normalized !== 'null' &&
    normalized !== '__none__'
}

async function fetchCurrentMonthTotalCost(connection: AwsConnection): Promise<{
  total: number
  period: string
}> {
  const client = createBillingCostExplorerClient(connection)
  const { label, timePeriod } = getCurrentMonthCostExplorerWindow()
  const response = await client.send(new GetCostAndUsageCommand({
    TimePeriod: timePeriod,
    Granularity: 'MONTHLY',
    Metrics: [COST_EXPLORER_METRIC]
  }))

  let total = 0
  for (const result of response.ResultsByTime ?? []) {
    total += readCostMetricAmount(result.Total)
  }

  return {
    total: roundCurrency(total),
    period: label
  }
}

async function fetchCurrentMonthGroupedCosts(
  connection: AwsConnection,
  groupBy: { Type: 'DIMENSION' | 'TAG'; Key: string }
): Promise<Array<{ key: string; amount: number }>> {
  const client = createBillingCostExplorerClient(connection)
  const { timePeriod } = getCurrentMonthCostExplorerWindow()
  const response = await client.send(new GetCostAndUsageCommand({
    TimePeriod: timePeriod,
    Granularity: 'MONTHLY',
    Metrics: [COST_EXPLORER_METRIC],
    GroupBy: [groupBy]
  }))

  const groupedAmounts = new Map<string, number>()

  for (const result of response.ResultsByTime ?? []) {
    for (const group of result.Groups ?? []) {
      const key = group.Keys?.[0] ?? 'Unknown'
      const amount = readCostMetricAmount(group.Metrics)
      groupedAmounts.set(key, (groupedAmounts.get(key) ?? 0) + amount)
    }
  }

  return [...groupedAmounts.entries()]
    .map(([key, amount]) => ({ key, amount: roundCurrency(amount) }))
    .filter((entry) => Math.abs(entry.amount) > 0.001)
    .sort((a, b) => b.amount - a.amount)
}

async function fetchCurrentMonthCostBreakdown(connection: AwsConnection): Promise<CostBreakdown> {
  const client = createBillingCostExplorerClient(connection)
  const { label, timePeriod } = getCurrentMonthCostExplorerWindow()

  const [totalResp, groupedResp] = await Promise.all([
    client.send(new GetCostAndUsageCommand({
      TimePeriod: timePeriod,
      Granularity: 'MONTHLY',
      Metrics: [COST_EXPLORER_METRIC]
    })),
    client.send(new GetCostAndUsageCommand({
      TimePeriod: timePeriod,
      Granularity: 'MONTHLY',
      Metrics: [COST_EXPLORER_METRIC],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
    }))
  ])

  const serviceMap = new Map<string, number>()
  let exactTotal = 0

  for (const result of totalResp.ResultsByTime ?? []) {
    exactTotal += readCostMetricAmount(result.Total)
  }

  for (const result of groupedResp.ResultsByTime ?? []) {
    for (const group of result.Groups ?? []) {
      const service = group.Keys?.[0] ?? 'Unknown'
      const amount = readCostMetricAmount(group.Metrics)
      serviceMap.set(service, (serviceMap.get(service) ?? 0) + amount)
    }
  }

  const entries: CostBreakdownEntry[] = []

  for (const [service, amount] of serviceMap) {
    if (Math.abs(amount) > 0.001) {
      entries.push({ service, amount: roundCurrency(amount) })
    }
  }

  entries.sort((a, b) => b.amount - a.amount)

  return { entries, total: roundCurrency(exactTotal), period: label }
}

async function getMonthlyCostForTag(
  connection: AwsConnection,
  tagKey: string,
  tagValue: string
): Promise<number> {
  const client = createBillingCostExplorerClient(connection)
  const { timePeriod } = getCurrentMonthCostExplorerWindow()

  const resp = await client.send(new GetCostAndUsageCommand({
    TimePeriod: timePeriod,
    Granularity: 'MONTHLY',
    Metrics: [COST_EXPLORER_METRIC],
    Filter: {
      Tags: {
        Key: tagKey,
        Values: [tagValue],
        MatchOptions: ['EQUALS']
      }
    }
  }))

  let total = 0
  for (const result of resp.ResultsByTime ?? []) {
    total += readCostMetricAmount(result.Total)
  }

  return roundCurrency(total)
}

function createOrganizationsClient(connection: AwsConnection): OrganizationsClient {
  return getAwsClient(OrganizationsClient, {
    ...connection,
    region: ORGANIZATIONS_HOME_REGION
  })
}

function buildAccountPath(nodes: OverviewOrganizationNode[], currentAccountId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const currentNode = nodes.find((node) => node.type === 'account' && node.accountId === currentAccountId)
  if (!currentNode) {
    return []
  }

  const path: string[] = []
  let cursor: OverviewOrganizationNode | undefined = currentNode
  while (cursor) {
    path.unshift(cursor.name)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }

  return path
}

async function listRootNodes(client: OrganizationsClient): Promise<OverviewOrganizationNode[]> {
  const roots: OverviewOrganizationNode[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListRootsCommand({ NextToken: nextToken }))
    for (const root of output.Roots ?? []) {
      roots.push({
        id: root.Id ?? '',
        parentId: '',
        type: 'root',
        name: root.Name ?? 'Root',
        arn: root.Arn ?? '',
        accountId: '',
        email: ''
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return roots.filter((node) => node.id)
}

async function listOuNodes(client: OrganizationsClient, parentId: string): Promise<OverviewOrganizationNode[]> {
  const ous: OverviewOrganizationNode[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListOrganizationalUnitsForParentCommand({ ParentId: parentId, NextToken: nextToken }))
    for (const ou of output.OrganizationalUnits ?? []) {
      ous.push({
        id: ou.Id ?? '',
        parentId,
        type: 'organizational-unit',
        name: ou.Name ?? 'OU',
        arn: ou.Arn ?? '',
        accountId: '',
        email: ''
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return ous.filter((node) => node.id)
}

async function listAccountNodes(client: OrganizationsClient, parentId: string): Promise<OverviewOrganizationNode[]> {
  const accounts: OverviewOrganizationNode[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListAccountsForParentCommand({ ParentId: parentId, NextToken: nextToken }))
    for (const account of output.Accounts ?? []) {
      accounts.push({
        id: account.Id ?? '',
        parentId,
        type: 'account',
        name: account.Name ?? account.Id ?? 'Account',
        arn: account.Arn ?? '',
        accountId: account.Id ?? '',
        email: account.Email ?? ''
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return accounts.filter((node) => node.id)
}

async function fetchOrganizationContext(
  connection: AwsConnection,
  currentAccountId: string
): Promise<OverviewOrganizationContext | null> {
  const client = createOrganizationsClient(connection)

  try {
    const [organizationOutput, roots] = await Promise.all([
      client.send(new DescribeOrganizationCommand({})),
      listRootNodes(client)
    ])

    const organization = organizationOutput.Organization
    const root = roots[0]
    if (!organization || !root) {
      return {
        status: 'limited',
        organizationId: organization?.Id ?? '',
        organizationArn: organization?.Arn ?? '',
        managementAccountId: organization?.MasterAccountId ?? '',
        managementAccountName: organization?.MasterAccountEmail ?? '',
        rootId: root?.id ?? '',
        rootName: root?.name ?? 'Root',
        currentAccountId,
        currentAccountPath: [],
        nodes: roots,
        warning: 'Organizations metadata is partially available, but the root tree could not be fully resolved.'
      }
    }

    const nodes: OverviewOrganizationNode[] = [...roots]
    let truncated = false

    async function walk(parentId: string, depth: number): Promise<void> {
      if (depth > ORGANIZATION_TREE_DEPTH_LIMIT || nodes.length >= ORGANIZATION_TREE_NODE_LIMIT) {
        truncated = true
        return
      }

      const [ous, accounts] = await Promise.all([
        listOuNodes(client, parentId),
        listAccountNodes(client, parentId)
      ])

      for (const node of [...ous, ...accounts]) {
        if (nodes.some((existing) => existing.id === node.id)) {
          continue
        }
        nodes.push(node)
        if (nodes.length >= ORGANIZATION_TREE_NODE_LIMIT) {
          truncated = true
          return
        }
      }

      for (const ou of ous) {
        await walk(ou.id, depth + 1)
        if (truncated) {
          return
        }
      }
    }

    await walk(root.id, 1)

    const currentAccountPath = buildAccountPath(nodes, currentAccountId)
    const managementAccountId = organization.MasterAccountId ?? ''
    const managementAccountNode = nodes.find((node) => node.type === 'account' && node.accountId === managementAccountId) ?? null

    return {
      status: truncated ? 'limited' : 'available',
      organizationId: organization.Id ?? '',
      organizationArn: organization.Arn ?? '',
      managementAccountId,
      managementAccountName: managementAccountNode?.name || organization.MasterAccountEmail || managementAccountId,
      rootId: root.id,
      rootName: root.name,
      currentAccountId,
      currentAccountPath,
      nodes,
      warning: truncated ? 'Organization tree was truncated to keep the overview responsive.' : ''
    }
  } catch (error) {
    logWarn('overview.organizations.context', 'Failed to load AWS Organizations context for overview.', {
      accountId: currentAccountId,
      profile: connection.profile,
      region: connection.region
    }, error)

    const message = error instanceof Error ? error.message : String(error)
    return {
      status: /access|denied|not authorized|unauthorized/i.test(message) ? 'limited' : 'unavailable',
      organizationId: '',
      organizationArn: '',
      managementAccountId: '',
      managementAccountName: '',
      rootId: '',
      rootName: '',
      currentAccountId,
      currentAccountPath: [],
      nodes: [],
      warning: message
    }
  }
}

export async function getOverviewAccountContext(connection: AwsConnection): Promise<OverviewAccountContext> {
  const caller = await getCallerIdentity(connection)
  const capabilitySnapshot = getAwsCapabilitySnapshot(connection.region, ['billing', 'organizations', 'local-zones'])
  const generatedAt = new Date().toISOString()
  const notes = [
    `Billing aggregation is normalized through ${BILLING_HOME_REGION} even when the active region is ${connection.region}.`,
    'Linked-account visibility depends on payer, management-account, or delegated billing access.'
  ]
  const organization = await fetchOrganizationContext(connection, caller.account)
  const emptyOwnershipHints: BillingTagOwnershipHint[] = OWNERSHIP_TAG_KEYS.map((key) => ({
    key,
    coveragePercent: 0,
    taggedAmount: 0,
    untaggedAmount: 0,
    topValues: []
  }))

  try {
    const [totalCost, linkedAccountGroups, ownershipGroups] = await Promise.all([
      fetchCurrentMonthTotalCost(connection),
      safeCount(
        () => fetchCurrentMonthGroupedCosts(connection, { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' }),
        []
      ),
      Promise.all(
        OWNERSHIP_TAG_KEYS.map(async (key) => ({
          key,
          groups: await safeCount(
            () => fetchCurrentMonthGroupedCosts(connection, { Type: 'TAG', Key: key }),
            []
          )
        }))
      )
    ])

    const linkedAccounts: BillingLinkedAccountSummary[] = linkedAccountGroups
      .map(({ key, amount }) => ({
        accountId: key,
        amount,
        sharePercent: buildSharePercent(amount, totalCost.total)
      }))
      .filter((item) => item.amount > 0)
      .sort((a, b) => b.amount - a.amount)

    const payerVisibility = linkedAccounts.length > 1
      ? 'payer-or-management'
      : totalCost.total > 0
        ? 'member-or-standalone'
        : 'unavailable'
    const payerAccountId = organization?.managementAccountId || (payerVisibility === 'member-or-standalone' ? caller.account : '')
    const payerAccountLabel = organization?.managementAccountName || payerAccountId || 'Unavailable'

    const ownershipHints: BillingTagOwnershipHint[] = ownershipGroups.map(({ key, groups }) => {
      const taggedValues = groups
        .map(({ key: rawKey, amount }) => ({
          value: parseTagGroupValue(key, rawKey),
          amount
        }))
        .filter((item) => isAssignedTagValue(item.value) && item.amount > 0)
        .sort((a, b) => b.amount - a.amount)

      const topValues: BillingOwnershipValueSummary[] = taggedValues
        .slice(0, 3)
        .map((item) => ({
          ...item,
          sharePercent: buildSharePercent(item.amount, totalCost.total)
        }))

      const taggedAmount = roundCurrency(taggedValues.reduce((sum, item) => sum + item.amount, 0))
      const untaggedAmount = roundCurrency(Math.max(totalCost.total - taggedAmount, 0))

      return {
        key,
        coveragePercent: buildSharePercent(taggedAmount, totalCost.total),
        taggedAmount,
        untaggedAmount,
        topValues
      }
    })

    if (payerVisibility === 'payer-or-management') {
      notes.push(`Linked-account rollups show ${linkedAccounts.length} accounts with current-month spend.`)
    } else if (payerVisibility === 'member-or-standalone') {
      notes.push('Only single-account spend is visible from the current credentials, so organization-level grouping is inferred as limited.')
    }
    notes.push(`Cost metric: ${COST_EXPLORER_METRIC_LABEL}.`)

    if (ownershipHints.every((hint) => hint.taggedAmount === 0) && totalCost.total > 0) {
      notes.push('Ownership hints are empty for the current month. AWS cost allocation tags may not be activated for Owner, Environment, Project, or CostCenter.')
    }

    if (organization?.currentAccountPath.length) {
      notes.push(`Organization path: ${organization.currentAccountPath.join(' / ')}.`)
    } else if (organization?.warning) {
      notes.push(`Organizations: ${organization.warning}`)
    }

    return {
      caller,
      billingHomeRegion: BILLING_HOME_REGION,
      payerVisibility,
      payerAccountId,
      payerAccountLabel,
      linkedAccounts,
      ownershipHints,
      organization,
      capabilitySnapshot,
      notes,
      generatedAt
    }
  } catch (error) {
    logWarn('overview.billing.context', 'Failed to load overview billing context.', {
      profile: connection.profile,
      region: connection.region
    }, error)

    notes.push('Cost Explorer billing context is unavailable for these credentials. Overview remains usable, but payer rollups and ownership hints are suppressed.')

    return {
      caller,
      billingHomeRegion: BILLING_HOME_REGION,
      payerVisibility: 'unavailable',
      payerAccountId: organization?.managementAccountId || caller.account,
      payerAccountLabel: organization?.managementAccountName || caller.account || 'Unavailable',
      linkedAccounts: [],
      ownershipHints: emptyOwnershipHints,
      organization,
      capabilitySnapshot,
      notes,
      generatedAt
    }
  }
}

/* ── public API ───────────────────────────────────────────── */

export async function getOverviewMetrics(
  connection: AwsConnection,
  regions: string[]
): Promise<OverviewMetrics> {
  const monthlyCostPromise = safeCount(
    () => fetchCurrentMonthTotalCost(connection),
    createEmptyCurrentMonthCost()
  )

  // Global services (not region-scoped) — query once using the first region
  const globalConn = { ...connection, region: regions[0] ?? connection.region }
  const [s3Global, r53Global, iamGlobal, ctGlobal] = await Promise.all([
    safeCount(() => countS3(globalConn), 0),
    safeCount(() => countRoute53(globalConn), 0),
    safeCount(() => countIam(globalConn), 0),
    safeCount(() => countCloudTrail(globalConn), 0)
  ])

  const regionResults = await mapWithConcurrency(regions, 3, async (region, index) => {
      const regionConn = { ...connection, region }
      const [ec2, lambda, eks, asg, rds, cfn, ecr, ecs, vpc, allVpc, elb, sg, sns, sqs, acm, kms, waf, sm, kp, cw] = await Promise.all([
        safeCount(() => countEc2(regionConn), { count: 0, instances: [] }),
        safeCount(() => countLambda(regionConn), { count: 0, functions: [] }),
        safeCount(() => countEks(regionConn), { count: 0, clusters: [] }),
        safeCount(() => countAsg(regionConn), { count: 0, groups: [] }),
        safeCount(() => countRds(regionConn), 0),
        safeCount(() => countCloudFormation(regionConn), 0),
        safeCount(() => countEcr(regionConn), 0),
        safeCount(() => countEcs(regionConn), 0),
        safeCount(() => countVpc(regionConn), 0),
        safeCount(() => countAllVpc(regionConn), 0),
        safeCount(() => countLoadBalancers(regionConn), 0),
        safeCount(() => countSecurityGroups(regionConn), 0),
        safeCount(() => countSns(regionConn), 0),
        safeCount(() => countSqs(regionConn), 0),
        safeCount(() => countAcm(regionConn), 0),
        safeCount(() => countKms(regionConn), 0),
        safeCount(() => countWaf(regionConn), 0),
        safeCount(() => countSecretsManager(regionConn), 0),
        safeCount(() => countKeyPairs(regionConn), 0),
        safeCount(() => countCloudWatch(regionConn), 0)
      ])

      // Global services only count in the first region to avoid duplication
      const s3 = index === 0 ? s3Global : 0
      const r53 = index === 0 ? r53Global : 0
      const iam = index === 0 ? iamGlobal : 0
      const ct = index === 0 ? ctGlobal : 0

      const totalResources = ec2.count + lambda.count + eks.count + asg.count +
        s3 + rds + cfn + ecr + ecs + vpc + elb + r53 + sg + sns + sqs +
        acm + kms + waf + sm + kp + cw + ct + iam

      const metric: RegionMetric = {
        region,
        ec2Count: ec2.count,
        lambdaCount: lambda.count,
        eksCount: eks.count,
        asgCount: asg.count,
        s3Count: s3,
        rdsCount: rds,
        cloudformationCount: cfn,
        ecrCount: ecr,
        ecsCount: ecs,
        vpcCount: vpc,
        loadBalancerCount: elb,
        route53Count: r53,
        securityGroupCount: sg,
        snsCount: sns,
        sqsCount: sqs,
        acmCount: acm,
        kmsCount: kms,
        wafCount: waf,
        secretsManagerCount: sm,
        keyPairCount: kp,
        cloudwatchCount: cw,
        cloudtrailCount: ct,
        iamCount: iam,
        totalResources
      }

      const cost = createRegionCostRow(region)

      return { metric, cost, isActive: totalResources > 0 || allVpc > 0 }
    }
  )

  const regionMetrics = regionResults.map((result) => result.metric)
  const regionCosts = regionResults.map((result) => result.cost)

  const totalResources = regionMetrics.reduce((s, r) => s + r.totalResources, 0)
  const activeRegionCount = regionResults.filter((result) => result.isActive).length
  const monthlyCost = await monthlyCostPromise

  return {
    regions: regionMetrics,
    costs: regionCosts,
    globalTotals: {
      totalResources,
      totalCost: monthlyCost.total,
      regionCount: activeRegionCount
    }
  }
}

/* ── Cost Explorer: real billing data ─────────────────────── */

export async function getCostBreakdown(
  connection: AwsConnection
): Promise<CostBreakdown> {
  return fetchCurrentMonthCostBreakdown(connection)
}

/* ── relationship-specific fetchers ───────────────────────── */

async function fetchSecurityGroups(connection: AwsConnection): Promise<Array<{ id: string; name: string; vpcId: string }>> {
  const client = getAwsClient(EC2Client, connection)
  const items: Array<{ id: string; name: string; vpcId: string }> = []
  let nextToken: string | undefined
  do {
    const output = await client.send(new DescribeSecurityGroupsCommand({ NextToken: nextToken }))
    for (const sg of output.SecurityGroups ?? []) {
      items.push({ id: sg.GroupId ?? '-', name: sg.GroupName ?? '-', vpcId: sg.VpcId ?? '-' })
    }
    nextToken = output.NextToken
  } while (nextToken)
  return items
}

async function fetchLoadBalancers(connection: AwsConnection): Promise<Array<{ arn: string; name: string; vpcId: string; type: string; securityGroups: string[] }>> {
  const client = getAwsClient(ElasticLoadBalancingV2Client, connection)
  const items: Array<{ arn: string; name: string; vpcId: string; type: string; securityGroups: string[] }> = []
  let marker: string | undefined
  do {
    const output = await client.send(new DescribeLoadBalancersCommand({ Marker: marker }))
    for (const lb of output.LoadBalancers ?? []) {
      items.push({
        arn: lb.LoadBalancerArn ?? '-',
        name: lb.LoadBalancerName ?? '-',
        vpcId: lb.VpcId ?? '-',
        type: lb.Type ?? '-',
        securityGroups: lb.SecurityGroups ?? []
      })
    }
    marker = output.NextMarker
  } while (marker)
  return items
}

async function fetchEcsClusters(connection: AwsConnection): Promise<Array<{ name: string; services: number; tasks: number }>> {
  const client = getAwsClient(ECSClient, connection)
  const arns: string[] = []
  let nextToken: string | undefined
  do {
    const output = await client.send(new EcsListClustersCommand({ nextToken }))
    arns.push(...(output.clusterArns ?? []))
    nextToken = output.nextToken
  } while (nextToken)
  return arns.map((arn) => ({ name: arn.split('/').pop() ?? arn, services: 0, tasks: 0 }))
}

async function fetchSnsTopics(connection: AwsConnection): Promise<Array<{ arn: string; name: string }>> {
  const client = getAwsClient(SNSClient, connection)
  const items: Array<{ arn: string; name: string }> = []
  let nextToken: string | undefined
  do {
    const output = await client.send(new ListTopicsCommand({ NextToken: nextToken }))
    for (const topic of output.Topics ?? []) {
      const arn = topic.TopicArn ?? '-'
      items.push({ arn, name: arn.split(':').pop() ?? arn })
    }
    nextToken = output.NextToken
  } while (nextToken)
  return items
}

async function fetchSqsQueues(connection: AwsConnection): Promise<Array<{ url: string; name: string }>> {
  const client = getAwsClient(SQSClient, connection)
  const items: Array<{ url: string; name: string }> = []
  let nextToken: string | undefined
  do {
    const output = await client.send(new ListQueuesCommand({ NextToken: nextToken }))
    for (const url of output.QueueUrls ?? []) {
      items.push({ url, name: url.split('/').pop() ?? url })
    }
    nextToken = output.NextToken
  } while (nextToken)
  return items
}

export async function getRelationshipMap(connection: AwsConnection): Promise<RelationshipMap> {
  const nodes: RelationshipMap['nodes'] = []
  const edges: ServiceRelationship[] = []
  const nodeSet = new Set<string>()

  function addNode(id: string, type: string, label: string) {
    if (!nodeSet.has(id)) {
      nodeSet.add(id)
      nodes.push({ id, type, label })
    }
  }

  const [ec2, lambda, eks, asg, sgs, lbs, ecsClusters, snsTopics, sqsQueues] = await Promise.all([
    safeCount(() => countEc2(connection), { count: 0, instances: [] }),
    safeCount(() => countLambda(connection), { count: 0, functions: [] }),
    safeCount(() => countEks(connection), { count: 0, clusters: [] }),
    safeCount(() => countAsg(connection), { count: 0, groups: [] }),
    safeCount(() => fetchSecurityGroups(connection), []),
    safeCount(() => fetchLoadBalancers(connection), []),
    safeCount(() => fetchEcsClusters(connection), []),
    safeCount(() => fetchSnsTopics(connection), []),
    safeCount(() => fetchSqsQueues(connection), [])
  ])

  // ── EC2 → VPC, Subnet, KeyPair, IAM, SecurityGroup ──────
  for (const inst of ec2.instances) {
    addNode(inst.id, 'ec2', inst.name !== '-' ? inst.name : inst.id)

    if (inst.vpcId !== '-') {
      addNode(inst.vpcId, 'vpc', inst.vpcId)
      edges.push({ source: inst.id, sourceType: 'ec2', target: inst.vpcId, targetType: 'vpc', relation: 'belongs-to' })
    }

    if (inst.subnetId !== '-') {
      addNode(inst.subnetId, 'subnet', inst.subnetId)
      edges.push({ source: inst.id, sourceType: 'ec2', target: inst.subnetId, targetType: 'subnet', relation: 'in-subnet' })
    }

    if (inst.keyName !== '-') {
      addNode(`kp:${inst.keyName}`, 'key-pair', inst.keyName)
      edges.push({ source: inst.id, sourceType: 'ec2', target: `kp:${inst.keyName}`, targetType: 'key-pair', relation: 'uses-key' })
    }

    if (inst.iamProfile !== '-') {
      const shortProfile = inst.iamProfile.split('/').pop() ?? inst.iamProfile
      addNode(`iam:${shortProfile}`, 'iam', shortProfile)
      edges.push({ source: inst.id, sourceType: 'ec2', target: `iam:${shortProfile}`, targetType: 'iam', relation: 'assumes-role' })
    }
  }

  // ── Lambda → IAM role ────────────────────────────────────
  for (const fn of lambda.functions) {
    addNode(`lambda:${fn.name}`, 'lambda', fn.name)
    if (fn.role !== '-') {
      const shortRole = fn.role.split('/').pop() ?? fn.role
      addNode(`iam:${shortRole}`, 'iam', shortRole)
      edges.push({ source: `lambda:${fn.name}`, sourceType: 'lambda', target: `iam:${shortRole}`, targetType: 'iam', relation: 'execution-role' })
    }
  }

  // ── EKS cluster ──────────────────────────────────────────
  for (const cluster of eks.clusters) {
    addNode(`eks:${cluster.name}`, 'eks', cluster.name)
  }

  // ── ASG → EC2 ────────────────────────────────────────────
  for (const group of asg.groups) {
    addNode(`asg:${group.name}`, 'auto-scaling', group.name)
    if (group.instances > 0) {
      edges.push({ source: `asg:${group.name}`, sourceType: 'auto-scaling', target: 'ec2-pool', targetType: 'ec2', relation: `manages ${group.instances} instances` })
      addNode('ec2-pool', 'ec2', 'EC2 Instance Pool')
    }
  }

  // ── Security Groups → VPC ────────────────────────────────
  for (const sg of sgs) {
    addNode(`sg:${sg.id}`, 'security-group', sg.name !== 'default' ? sg.name : `${sg.id} (default)`)
    if (sg.vpcId !== '-') {
      addNode(sg.vpcId, 'vpc', sg.vpcId)
      edges.push({ source: `sg:${sg.id}`, sourceType: 'security-group', target: sg.vpcId, targetType: 'vpc', relation: 'in-vpc' })
    }
  }

  // ── Load Balancers → VPC, Security Groups ────────────────
  for (const lb of lbs) {
    addNode(`lb:${lb.name}`, 'load-balancer', `${lb.name} (${lb.type})`)
    if (lb.vpcId !== '-') {
      addNode(lb.vpcId, 'vpc', lb.vpcId)
      edges.push({ source: `lb:${lb.name}`, sourceType: 'load-balancer', target: lb.vpcId, targetType: 'vpc', relation: 'in-vpc' })
    }
    for (const sgId of lb.securityGroups) {
      addNode(`sg:${sgId}`, 'security-group', sgId)
      edges.push({ source: `lb:${lb.name}`, sourceType: 'load-balancer', target: `sg:${sgId}`, targetType: 'security-group', relation: 'uses-sg' })
    }
  }

  // ── ECS Clusters ─────────────────────────────────────────
  for (const cluster of ecsClusters) {
    addNode(`ecs:${cluster.name}`, 'ecs', cluster.name)
  }

  // ── SNS Topics ───────────────────────────────────────────
  for (const topic of snsTopics) {
    addNode(`sns:${topic.name}`, 'sns', topic.name)
  }

  // ── SQS Queues ───────────────────────────────────────────
  for (const queue of sqsQueues) {
    addNode(`sqs:${queue.name}`, 'sqs', queue.name)
    // Dead-letter queue links are detected by naming convention
    if (queue.name.endsWith('-dlq') || queue.name.endsWith('-deadletter')) {
      const sourceName = queue.name.replace(/-dlq$/, '').replace(/-deadletter$/, '')
      const sourceQueue = sqsQueues.find((q) => q.name === sourceName)
      if (sourceQueue) {
        edges.push({ source: `sqs:${sourceQueue.name}`, sourceType: 'sqs', target: `sqs:${queue.name}`, targetType: 'sqs', relation: 'dead-letter' })
      }
    }
  }

  // ── Cross-service inferred links ─────────────────────────
  // SNS → SQS naming convention (topic-name matches queue-name prefix)
  for (const topic of snsTopics) {
    for (const queue of sqsQueues) {
      if (queue.name.startsWith(topic.name) && queue.name !== topic.name) {
        edges.push({ source: `sns:${topic.name}`, sourceType: 'sns', target: `sqs:${queue.name}`, targetType: 'sqs', relation: 'publishes-to' })
      }
    }
  }

  // ECS → Load Balancer link (by shared VPC presence)
  // Lambda → SNS/SQS naming convention links
  for (const fn of lambda.functions) {
    for (const topic of snsTopics) {
      if (fn.name.includes(topic.name) || topic.name.includes(fn.name)) {
        edges.push({ source: `lambda:${fn.name}`, sourceType: 'lambda', target: `sns:${topic.name}`, targetType: 'sns', relation: 'triggers' })
      }
    }
    for (const queue of sqsQueues) {
      if (fn.name.includes(queue.name) || queue.name.includes(fn.name)) {
        edges.push({ source: `sqs:${queue.name}`, sourceType: 'sqs', target: `lambda:${fn.name}`, targetType: 'lambda', relation: 'triggers' })
      }
    }
  }

  return { nodes, edges }
}

export async function getOverviewStatistics(connection: AwsConnection): Promise<OverviewStatistics> {
  const [ec2, lambda, eks, asg, s3, rds, cfn, ecr, ecs, vpc, elb, r53, sg, sns, sqs, acm, kms, waf, sm, kp, cw, ct, iam, monthlyCost] = await Promise.all([
    safeCount(() => countEc2(connection), { count: 0, instances: [] }),
    safeCount(() => countLambda(connection), { count: 0, functions: [] }),
    safeCount(() => countEks(connection), { count: 0, clusters: [] }),
    safeCount(() => countAsg(connection), { count: 0, groups: [] }),
    safeCount(() => countS3(connection), 0),
    safeCount(() => countRds(connection), 0),
    safeCount(() => countCloudFormation(connection), 0),
    safeCount(() => countEcr(connection), 0),
    safeCount(() => countEcs(connection), 0),
    safeCount(() => countVpc(connection), 0),
    safeCount(() => countLoadBalancers(connection), 0),
    safeCount(() => countRoute53(connection), 0),
    safeCount(() => countSecurityGroups(connection), 0),
    safeCount(() => countSns(connection), 0),
    safeCount(() => countSqs(connection), 0),
    safeCount(() => countAcm(connection), 0),
    safeCount(() => countKms(connection), 0),
    safeCount(() => countWaf(connection), 0),
    safeCount(() => countSecretsManager(connection), 0),
    safeCount(() => countKeyPairs(connection), 0),
    safeCount(() => countCloudWatch(connection), 0),
    safeCount(() => countCloudTrail(connection), 0),
    safeCount(() => countIam(connection), 0),
    safeCount(() => fetchCurrentMonthTotalCost(connection), createEmptyCurrentMonthCost())
  ])

  const runningEc2 = ec2.instances.filter((i) => i.state === 'running').length
  const stoppedEc2 = ec2.instances.filter((i) => i.state === 'stopped').length
  const totalAsgInstances = asg.groups.reduce((sum, g) => sum + g.instances, 0)
  const totalAsgDesired = asg.groups.reduce((sum, g) => sum + g.desired, 0)
  const pythonLambdas = lambda.functions.filter((f) => f.runtime.includes('python')).length
  const nodeLambdas = lambda.functions.filter((f) => f.runtime.includes('node')).length

  const allResourceTotal = ec2.count + lambda.count + eks.count + asg.count +
    s3 + rds + cfn + ecr + ecs + vpc + elb + r53 + sg + sns + sqs +
    acm + kms + waf + sm + kp + cw + ct + iam

  const stats: OverviewStat[] = [
    { label: 'EC2 Instances', value: String(ec2.count), detail: `${runningEc2} running, ${stoppedEc2} stopped`, trend: runningEc2 > 0 ? 'up' : 'neutral' },
    { label: 'Lambda Functions', value: String(lambda.count), detail: `${pythonLambdas} Python, ${nodeLambdas} Node.js`, trend: lambda.count > 0 ? 'up' : 'neutral' },
    { label: 'EKS Clusters', value: String(eks.count), detail: `${eks.count} cluster${eks.count !== 1 ? 's' : ''} active`, trend: eks.count > 0 ? 'up' : 'neutral' },
    { label: 'Auto Scaling Groups', value: String(asg.count), detail: `${totalAsgInstances} instances (${totalAsgDesired} desired)`, trend: totalAsgInstances > 0 ? 'up' : 'neutral' },
    { label: 'S3 Buckets', value: String(s3), detail: 'Global bucket count', trend: s3 > 0 ? 'up' : 'neutral' },
    { label: 'RDS Instances', value: String(rds), detail: 'Database instances in region', trend: rds > 0 ? 'up' : 'neutral' },
    { label: 'CloudFormation Stacks', value: String(cfn), detail: 'Active stacks (excludes deleted)', trend: cfn > 0 ? 'up' : 'neutral' },
    { label: 'ECR Repositories', value: String(ecr), detail: 'Container image repositories', trend: ecr > 0 ? 'up' : 'neutral' },
    { label: 'ECS Clusters', value: String(ecs), detail: 'Container orchestration clusters', trend: ecs > 0 ? 'up' : 'neutral' },
    { label: 'VPCs', value: String(vpc), detail: 'Virtual private clouds in region', trend: 'neutral' },
    { label: 'Load Balancers', value: String(elb), detail: 'ALB / NLB / GLB in region', trend: elb > 0 ? 'up' : 'neutral' },
    { label: 'Route 53 Zones', value: String(r53), detail: 'Global hosted zones', trend: r53 > 0 ? 'up' : 'neutral' },
    { label: 'Security Groups', value: String(sg), detail: 'Firewall rule groups in region', trend: 'neutral' },
    { label: 'SNS Topics', value: String(sns), detail: 'Notification topics', trend: sns > 0 ? 'up' : 'neutral' },
    { label: 'SQS Queues', value: String(sqs), detail: 'Message queues', trend: sqs > 0 ? 'up' : 'neutral' },
    { label: 'ACM Certificates', value: String(acm), detail: 'SSL/TLS certificates', trend: acm > 0 ? 'up' : 'neutral' },
    { label: 'KMS Keys', value: String(kms), detail: 'Encryption keys', trend: 'neutral' },
    { label: 'WAF Web ACLs', value: String(waf), detail: 'Web application firewall rules', trend: waf > 0 ? 'up' : 'neutral' },
    { label: 'Secrets', value: String(sm), detail: 'Secrets Manager entries', trend: sm > 0 ? 'up' : 'neutral' },
    { label: 'Key Pairs', value: String(kp), detail: 'EC2 SSH key pairs', trend: 'neutral' },
    { label: 'CloudWatch Alarms', value: String(cw), detail: 'Metric alarms configured', trend: cw > 0 ? 'up' : 'neutral' },
    { label: 'CloudTrail Trails', value: String(ct), detail: 'Audit logging trails', trend: ct > 0 ? 'up' : 'neutral' },
    { label: 'IAM Users & Roles', value: String(iam), detail: 'Global identity count', trend: 'neutral' },
    { label: 'Total Resources', value: String(allResourceTotal), detail: 'Across all discovered services', trend: 'neutral' },
    {
      label: 'Monthly Cost',
      value: `$${monthlyCost.total.toFixed(2)}`,
      detail: `Current month (${monthlyCost.period}) from Cost Explorer using ${COST_EXPLORER_METRIC_LABEL}`,
      trend: 'neutral'
    }
  ]

  // ── Insights ──────────────────────────────────────────────
  const insights: InsightItem[] = []
  const now = new Date().toISOString()

  // EC2 insights
  if (stoppedEc2 > 0) {
    insights.push({ severity: 'warning', message: `${stoppedEc2} EC2 instance${stoppedEc2 > 1 ? 's are' : ' is'} stopped — consider terminating unused instances to save costs.`, service: 'ec2', timestamp: now })
  }
  if (ec2.count > 0 && runningEc2 === ec2.count) {
    insights.push({ severity: 'info', message: `All ${runningEc2} EC2 instances are running.`, service: 'ec2', timestamp: now })
  }
  if (ec2.instances.some((i) => i.keyName === '-')) {
    const noKey = ec2.instances.filter((i) => i.keyName === '-').length
    insights.push({ severity: 'info', message: `${noKey} EC2 instance${noKey > 1 ? 's have' : ' has'} no key pair attached — SSH access may rely on SSM or other methods.`, service: 'ec2', timestamp: now })
  }

  // Lambda insights
  if (lambda.count > 0 && lambda.count <= 20) {
    insights.push({ severity: 'info', message: `${lambda.count} Lambda function${lambda.count > 1 ? 's' : ''} deployed (${pythonLambdas} Python, ${nodeLambdas} Node.js).`, service: 'lambda', timestamp: now })
  }
  if (lambda.count > 20) {
    insights.push({ severity: 'warning', message: `${lambda.count} Lambda functions detected — review for unused functions to reduce maintenance burden.`, service: 'lambda', timestamp: now })
  }

  // ASG insights
  if (asg.groups.some((g) => g.instances === 0)) {
    const emptyGroups = asg.groups.filter((g) => g.instances === 0)
    insights.push({ severity: 'warning', message: `${emptyGroups.length} Auto Scaling group${emptyGroups.length > 1 ? 's have' : ' has'} zero instances.`, service: 'auto-scaling', timestamp: now })
  }
  if (asg.count > 0 && totalAsgInstances > totalAsgDesired) {
    insights.push({ severity: 'info', message: `Auto Scaling groups have ${totalAsgInstances} running instances vs ${totalAsgDesired} desired — some groups may be scaling up.`, service: 'auto-scaling', timestamp: now })
  }

  // S3 insights
  if (s3 > 0) {
    insights.push({ severity: 'info', message: `${s3} S3 bucket${s3 > 1 ? 's' : ''} found in the account. Ensure versioning and encryption are enabled on sensitive buckets.`, service: 's3', timestamp: now })
  }
  if (s3 > 50) {
    insights.push({ severity: 'warning', message: `${s3} S3 buckets is a large number — audit for unused or orphaned buckets to reduce storage costs and attack surface.`, service: 's3', timestamp: now })
  }

  // RDS insights
  if (rds > 0) {
    insights.push({ severity: 'info', message: `${rds} RDS instance${rds > 1 ? 's' : ''} running in this region. Review backup retention and multi-AZ configuration.`, service: 'rds', timestamp: now })
  }

  // CloudFormation insights
  if (cfn > 0) {
    insights.push({ severity: 'info', message: `${cfn} CloudFormation stack${cfn > 1 ? 's' : ''} active in this region.`, service: 'cloudformation', timestamp: now })
  }

  // Container insights
  if (ecr > 0) {
    insights.push({ severity: 'info', message: `${ecr} ECR repositor${ecr > 1 ? 'ies' : 'y'} found — verify lifecycle policies to clean up old images.`, service: 'ecr', timestamp: now })
  }
  if (ecs > 0 && eks.count > 0) {
    insights.push({ severity: 'info', message: `Both ECS (${ecs} cluster${ecs > 1 ? 's' : ''}) and EKS (${eks.count} cluster${eks.count > 1 ? 's' : ''}) are in use — consider consolidating container orchestration to reduce operational overhead.`, service: 'ecs', timestamp: now })
  } else if (ecs > 0) {
    insights.push({ severity: 'info', message: `${ecs} ECS cluster${ecs > 1 ? 's' : ''} running in this region.`, service: 'ecs', timestamp: now })
  }
  if (eks.count > 0) {
    insights.push({ severity: 'info', message: `${eks.count} EKS cluster${eks.count > 1 ? 's' : ''} active — ensure cluster version is up to date and node groups are healthy.`, service: 'eks', timestamp: now })
  }

  // VPC & networking insights
  if (vpc > 3) {
    insights.push({ severity: 'warning', message: `${vpc} VPCs in this region — may indicate VPC sprawl. Consider consolidating to reduce complexity and peering costs.`, service: 'vpc', timestamp: now })
  }
  if (elb > 0) {
    insights.push({ severity: 'info', message: `${elb} load balancer${elb > 1 ? 's' : ''} active. Each idle ALB costs ~$16/month.`, service: 'load-balancers', timestamp: now })
  }
  if (r53 > 0) {
    insights.push({ severity: 'info', message: `${r53} Route 53 hosted zone${r53 > 1 ? 's' : ''} configured for DNS management.`, service: 'route53', timestamp: now })
  }

  // Security insights
  if (sg > 20) {
    insights.push({ severity: 'warning', message: `${sg} security groups detected — audit for unused groups and overly permissive inbound rules (0.0.0.0/0).`, service: 'security-groups', timestamp: now })
  } else if (sg > 0) {
    insights.push({ severity: 'info', message: `${sg} security group${sg > 1 ? 's' : ''} in this region.`, service: 'security-groups', timestamp: now })
  }
  if (waf > 0) {
    insights.push({ severity: 'info', message: `${waf} WAF Web ACL${waf > 1 ? 's' : ''} active — web application firewall rules are in place.`, service: 'waf', timestamp: now })
  }
  if (waf === 0 && elb > 0) {
    insights.push({ severity: 'warning', message: 'No WAF Web ACLs configured while load balancers are active — consider adding WAF rules to protect public-facing applications.', service: 'waf', timestamp: now })
  }

  // ACM insights
  if (acm > 0) {
    insights.push({ severity: 'info', message: `${acm} ACM certificate${acm > 1 ? 's' : ''} provisioned. Monitor for upcoming expirations.`, service: 'acm', timestamp: now })
  }

  // KMS insights
  if (kms > 10) {
    insights.push({ severity: 'info', message: `${kms} KMS keys found — each key costs $1/month. Review for unused keys.`, service: 'kms', timestamp: now })
  }

  // Secrets Manager insights
  if (sm > 0) {
    insights.push({ severity: 'info', message: `${sm} secret${sm > 1 ? 's' : ''} stored in Secrets Manager. Each secret costs $0.40/month. Enable automatic rotation where possible.`, service: 'secrets-manager', timestamp: now })
  }

  // Messaging insights
  if (sns > 0 || sqs > 0) {
    const parts: string[] = []
    if (sns > 0) parts.push(`${sns} SNS topic${sns > 1 ? 's' : ''}`)
    if (sqs > 0) parts.push(`${sqs} SQS queue${sqs > 1 ? 's' : ''}`)
    insights.push({ severity: 'info', message: `Messaging infrastructure detected: ${parts.join(' and ')}.`, service: sns > 0 ? 'sns' : 'sqs', timestamp: now })
  }

  // Key Pairs insights
  if (kp > 10) {
    insights.push({ severity: 'warning', message: `${kp} EC2 key pairs found — audit for unused pairs and consider rotating keys periodically.`, service: 'key-pairs', timestamp: now })
  }

  // CloudWatch insights
  if (cw === 0 && ec2.count > 0) {
    insights.push({ severity: 'warning', message: 'No CloudWatch alarms configured while EC2 instances are running — consider setting up CPU, memory, and status check alarms.', service: 'cloudwatch', timestamp: now })
  } else if (cw > 0) {
    insights.push({ severity: 'info', message: `${cw} CloudWatch alarm${cw > 1 ? 's' : ''} configured for monitoring.`, service: 'cloudwatch', timestamp: now })
  }

  // CloudTrail insights
  if (ct === 0) {
    insights.push({ severity: 'warning', message: 'No CloudTrail trails detected — enable CloudTrail for audit logging and compliance.', service: 'cloudtrail', timestamp: now })
  } else {
    insights.push({ severity: 'info', message: `${ct} CloudTrail trail${ct > 1 ? 's' : ''} configured for audit logging.`, service: 'cloudtrail', timestamp: now })
  }

  // IAM insights
  if (iam > 100) {
    insights.push({ severity: 'warning', message: `${iam} IAM users and roles — large identity pools increase attack surface. Audit for unused identities.`, service: 'iam', timestamp: now })
  } else if (iam > 0) {
    insights.push({ severity: 'info', message: `${iam} IAM users and roles in the account.`, service: 'iam', timestamp: now })
  }

  // Overall resource count
  if (allResourceTotal === 0) {
    insights.push({ severity: 'info', message: 'No resources discovered in this region. Verify the profile has adequate permissions.', service: 'overview', timestamp: now })
  }

  // ── Regional signals ──────────────────────────────────────
  const signals: RegionalSignal[] = []
  const region = connection.region

  // Stopped instances signal
  if (stoppedEc2 > 0) {
    signals.push({ severity: stoppedEc2 > 3 ? 'high' : 'medium', region, title: `${stoppedEc2} stopped EC2 instance${stoppedEc2 > 1 ? 's' : ''} detected`, description: `${stoppedEc2} EC2 instance${stoppedEc2 > 1 ? 's are' : ' is'} in a stopped state in ${region}. Stopped instances still incur EBS storage costs and reserve elastic IPs.`, nextStep: 'Review stopped instances and terminate any that are no longer needed to reduce costs.', category: 'cleanup' })
  }

  // Empty ASG signal
  const emptyAsgGroups = asg.groups.filter((g) => g.instances === 0)
  if (emptyAsgGroups.length > 0) {
    signals.push({ severity: 'medium', region, title: `${emptyAsgGroups.length} empty Auto Scaling group${emptyAsgGroups.length > 1 ? 's' : ''}`, description: `${emptyAsgGroups.length} Auto Scaling group${emptyAsgGroups.length > 1 ? 's have' : ' has'} zero running instances in ${region}. This may indicate unused infrastructure or a scaling issue.`, nextStep: 'Verify whether these groups are intentionally scaled to zero or should be cleaned up.', category: 'cleanup' })
  }

  // Cost signals
  if (monthlyCost.total > 500) {
    signals.push({
      severity: 'high',
      region,
      title: 'Elevated monthly spend detected',
      description: `Current month spend visible to these credentials is $${monthlyCost.total.toFixed(0)} from Cost Explorer (${COST_EXPLORER_METRIC_LABEL}).`,
      nextStep: 'Review top services in the cost breakdown and right-size the highest-cost workloads.',
      category: 'cost'
    })
  } else if (monthlyCost.total > 200) {
    signals.push({
      severity: 'medium',
      region,
      title: 'Moderate monthly spend',
      description: `Current month spend visible to these credentials is $${monthlyCost.total.toFixed(0)} from Cost Explorer across ${allResourceTotal} discovered resources.`,
      nextStep: 'Monitor cost trends and review the highest-spend services for optimization opportunities.',
      category: 'cost'
    })
  }

  // Large Lambda fleet signal
  if (lambda.count > 20) {
    signals.push({ severity: 'medium', region, title: 'Large Lambda function fleet', description: `${lambda.count} Lambda functions detected in ${region}. Large fleets can increase maintenance overhead and make it harder to track unused functions.`, nextStep: 'Audit function invocation metrics to identify and remove unused Lambda functions.', category: 'operations' })
  }

  // Security group sprawl signal
  if (sg > 20) {
    signals.push({ severity: 'medium', region, title: 'Security group sprawl', description: `${sg} security groups in ${region}. Excess groups create confusion and may mask overly permissive rules.`, nextStep: 'Audit security groups for unused entries and consolidate where possible.', category: 'security' })
  }

  // VPC sprawl signal
  if (vpc > 3) {
    signals.push({ severity: 'medium', region, title: 'Multiple VPCs detected', description: `${vpc} VPCs in ${region}. Multiple VPCs increase networking complexity and peering costs.`, nextStep: 'Review whether all VPCs are actively used and consolidate if feasible.', category: 'operations' })
  }

  // No monitoring signal
  if (cw === 0 && allResourceTotal > 5) {
    signals.push({ severity: 'high', region, title: 'No CloudWatch alarms configured', description: `${allResourceTotal} resources detected in ${region} but no CloudWatch alarms are set up. This is a monitoring gap.`, nextStep: 'Set up CloudWatch alarms for critical metrics like CPU utilization, error rates, and health checks.', category: 'operations' })
  }

  // No audit logging signal
  if (ct === 0) {
    signals.push({ severity: 'high', region, title: 'No CloudTrail audit logging', description: `No CloudTrail trails detected. API activity in ${region} is not being recorded for audit or compliance purposes.`, nextStep: 'Enable CloudTrail with an S3 bucket for log storage. Consider enabling multi-region trails.', category: 'security' })
  }

  // Missing WAF signal
  if (waf === 0 && elb > 0) {
    signals.push({ severity: 'medium', region, title: 'Public load balancers without WAF', description: `${elb} load balancer${elb > 1 ? 's are' : ' is'} active in ${region} with no WAF Web ACLs for application-layer protection.`, nextStep: 'Associate WAF Web ACLs with public-facing load balancers to protect against common web exploits.', category: 'security' })
  }

  // Secrets management signal
  if (sm > 0) {
    signals.push({ severity: 'low', region, title: `${sm} secret${sm > 1 ? 's' : ''} in Secrets Manager`, description: `${sm} secret${sm > 1 ? 's are' : ' is'} stored in Secrets Manager in ${region}. Ensure automatic rotation is enabled.`, nextStep: 'Review rotation policies and enable rotation for database credentials and API keys.', category: 'security' })
  }

  // RDS signal
  if (rds > 0) {
    signals.push({ severity: 'low', region, title: `${rds} RDS instance${rds > 1 ? 's' : ''} active`, description: `${rds} RDS database instance${rds > 1 ? 's are' : ' is'} running in ${region}. Verify backup retention and encryption settings.`, nextStep: 'Check automated backups, multi-AZ deployment, and encryption at rest status.', category: 'operations' })
  }

  // Container workload signal
  if (ecs > 0 && eks.count > 0) {
    signals.push({ severity: 'medium', region, title: 'Dual container orchestration', description: `Both ECS (${ecs}) and EKS (${eks.count}) are active in ${region}. Running two orchestrators increases operational complexity.`, nextStep: 'Consider standardizing on one container orchestration platform unless there is a clear justification.', category: 'operations' })
  }

  // Stable footprint (only if no other signals)
  if (signals.length === 0) {
    signals.push({ severity: 'low', region, title: 'Regional footprint is stable', description: `No strong cost, deployment, or security anomalies were detected in ${region} from the current overview sample.`, nextStep: 'Load the global overview to compare this region against the rest of the account.', category: 'operations' })
  }

  return { stats, insights, signals }
}

export async function searchByTag(
  connection: AwsConnection,
  tagKey: string,
  tagValue?: string
): Promise<TagSearchResult> {
  const [ec2, asg, lambda, eks, s3Buckets, rdsInstances, cloudformationStacks, ecrRepositories, ecsClusters, vpcs, loadBalancers, route53Zones, securityGroups, snsTopics, sqsQueues, acmCertificates, kmsKeys, wafAcls, secrets, keyPairs, cloudwatchAlarms, cloudtrailTrails, iamResources] = await Promise.all([
    safeCount(() => countEc2(connection), { count: 0, instances: [] }),
    safeCount(() => countAsg(connection), { count: 0, groups: [] }),
    safeCount(() => listTaggedLambda(connection), []),
    safeCount(() => listTaggedEks(connection), []),
    safeCount(() => listTaggedS3(connection), []),
    safeCount(() => listTaggedRds(connection), []),
    safeCount(() => listTaggedCloudFormation(connection), []),
    safeCount(() => listTaggedEcr(connection), []),
    safeCount(() => listTaggedEcs(connection), []),
    safeCount(() => listTaggedVpcs(connection), []),
    safeCount(() => listTaggedLoadBalancers(connection), []),
    safeCount(() => listTaggedRoute53(connection), []),
    safeCount(() => listTaggedSecurityGroups(connection), []),
    safeCount(() => listTaggedSns(connection), []),
    safeCount(() => listTaggedSqs(connection), []),
    safeCount(() => listTaggedAcm(connection), []),
    safeCount(() => listTaggedKms(connection), []),
    safeCount(() => listTaggedWaf(connection), []),
    safeCount(() => listTaggedSecrets(connection), []),
    safeCount(() => listTaggedKeyPairs(connection), []),
    safeCount(() => listTaggedCloudWatch(connection), []),
    safeCount(() => listTaggedCloudTrail(connection), []),
    safeCount(() => listTaggedIam(connection), [])
  ])

  const resources: TaggedResource[] = []
  const countMap = new Map<string, number>()

  // Search EC2 tags
  for (const inst of ec2.instances) {
    const matchedTag = matchesTag(inst.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: inst.id,
        resourceType: 'EC2 Instance',
        service: 'ec2',
        name: inst.name,
        tags: inst.tags
      }, matchedTag)
    }
  }

  // Search ASG tags
  for (const group of asg.groups) {
    const matchedTag = matchesTag(group.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: group.name,
        resourceType: 'Auto Scaling Group',
        service: 'auto-scaling',
        name: group.name,
        tags: group.tags
      }, matchedTag)
    }
  }

  for (const fn of lambda) {
    const matchedTag = matchesTag(fn.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: fn.id,
        resourceType: 'Lambda Function',
        service: 'lambda',
        name: fn.name,
        tags: fn.tags
      }, matchedTag)
    }
  }

  for (const cluster of eks) {
    const matchedTag = matchesTag(cluster.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: cluster.id,
        resourceType: 'EKS Cluster',
        service: 'eks',
        name: cluster.name,
        tags: cluster.tags
      }, matchedTag)
    }
  }

  for (const bucket of s3Buckets) {
    const matchedTag = matchesTag(bucket.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: bucket.id,
        resourceType: 'S3 Bucket',
        service: 's3',
        name: bucket.name,
        tags: bucket.tags
      }, matchedTag)
    }
  }

  for (const instance of rdsInstances) {
    const matchedTag = matchesTag(instance.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: instance.id,
        resourceType: 'RDS Instance',
        service: 'rds',
        name: instance.name,
        tags: instance.tags
      }, matchedTag)
    }
  }

  for (const stack of cloudformationStacks) {
    const matchedTag = matchesTag(stack.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: stack.id,
        resourceType: 'CloudFormation Stack',
        service: 'cloudformation',
        name: stack.name,
        tags: stack.tags
      }, matchedTag)
    }
  }

  for (const repository of ecrRepositories) {
    const matchedTag = matchesTag(repository.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: repository.id,
        resourceType: 'ECR Repository',
        service: 'ecr',
        name: repository.name,
        tags: repository.tags
      }, matchedTag)
    }
  }

  for (const cluster of ecsClusters) {
    const matchedTag = matchesTag(cluster.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: cluster.id,
        resourceType: 'ECS Cluster',
        service: 'ecs',
        name: cluster.name,
        tags: cluster.tags
      }, matchedTag)
    }
  }

  for (const vpc of vpcs) {
    const matchedTag = matchesTag(vpc.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: vpc.id,
        resourceType: 'VPC',
        service: 'vpc',
        name: vpc.name,
        tags: vpc.tags
      }, matchedTag)
    }
  }

  for (const balancer of loadBalancers) {
    const matchedTag = matchesTag(balancer.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: balancer.id,
        resourceType: 'Load Balancer',
        service: 'load-balancers',
        name: balancer.name,
        tags: balancer.tags
      }, matchedTag)
    }
  }

  for (const zone of route53Zones) {
    const matchedTag = matchesTag(zone.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: zone.id,
        resourceType: 'Route 53 Hosted Zone',
        service: 'route53',
        name: zone.name,
        tags: zone.tags
      }, matchedTag)
    }
  }

  for (const group of securityGroups) {
    const matchedTag = matchesTag(group.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: group.id,
        resourceType: 'Security Group',
        service: 'security-groups',
        name: group.name,
        tags: group.tags
      }, matchedTag)
    }
  }

  for (const topic of snsTopics) {
    const matchedTag = matchesTag(topic.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: topic.id,
        resourceType: 'SNS Topic',
        service: 'sns',
        name: topic.name,
        tags: topic.tags
      }, matchedTag)
    }
  }

  for (const queue of sqsQueues) {
    const matchedTag = matchesTag(queue.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: queue.id,
        resourceType: 'SQS Queue',
        service: 'sqs',
        name: queue.name,
        tags: queue.tags
      }, matchedTag)
    }
  }

  for (const certificate of acmCertificates) {
    const matchedTag = matchesTag(certificate.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: certificate.id,
        resourceType: 'ACM Certificate',
        service: 'acm',
        name: certificate.name,
        tags: certificate.tags
      }, matchedTag)
    }
  }

  for (const key of kmsKeys) {
    const matchedTag = matchesTag(key.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: key.id,
        resourceType: 'KMS Key',
        service: 'kms',
        name: key.name,
        tags: key.tags
      }, matchedTag)
    }
  }

  for (const acl of wafAcls) {
    const matchedTag = matchesTag(acl.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: acl.id,
        resourceType: 'WAF Web ACL',
        service: 'waf',
        name: acl.name,
        tags: acl.tags
      }, matchedTag)
    }
  }

  for (const secret of secrets) {
    const matchedTag = matchesTag(secret.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: secret.id,
        resourceType: 'Secret',
        service: 'secrets-manager',
        name: secret.name,
        tags: secret.tags
      }, matchedTag)
    }
  }

  for (const keyPair of keyPairs) {
    const matchedTag = matchesTag(keyPair.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: keyPair.id,
        resourceType: 'Key Pair',
        service: 'key-pairs',
        name: keyPair.name,
        tags: keyPair.tags
      }, matchedTag)
    }
  }

  for (const alarm of cloudwatchAlarms) {
    const matchedTag = matchesTag(alarm.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: alarm.id,
        resourceType: 'CloudWatch Alarm',
        service: 'cloudwatch',
        name: alarm.name,
        tags: alarm.tags
      }, matchedTag)
    }
  }

  for (const trail of cloudtrailTrails) {
    const matchedTag = matchesTag(trail.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: trail.id,
        resourceType: 'CloudTrail Trail',
        service: 'cloudtrail',
        name: trail.name,
        tags: trail.tags
      }, matchedTag)
    }
  }

  for (const resource of iamResources) {
    const matchedTag = matchesTag(resource.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, countMap, {
        resourceId: resource.id,
        resourceType: resource.resourceType,
        service: resource.service,
        name: resource.name,
        tags: resource.tags
      }, matchedTag)
    }
  }

  const monthlyCosts = await mapWithConcurrency(
    Array.from(countMap.entries()),
    4,
    async ([mapKey, resourceCount]) => {
      const separatorIndex = mapKey.indexOf('=')
      const tagKey = separatorIndex >= 0 ? mapKey.slice(0, separatorIndex) : mapKey
      const tagValue = separatorIndex >= 0 ? mapKey.slice(separatorIndex + 1) : ''

      const monthlyCost = await safeCount(
        () => getMonthlyCostForTag(connection, tagKey, tagValue),
        0
      )

      return { tagKey, tagValue, resourceCount, monthlyCost }
    }
  )

  const costBreakdown: TagCostEntry[] = []
  for (const entry of monthlyCosts) {
    costBreakdown.push({
      tagKey: entry.tagKey,
      tagValue: entry.tagValue,
      resourceCount: entry.resourceCount,
      monthlyCost: entry.monthlyCost
    })
  }

  costBreakdown.sort((a, b) => b.monthlyCost - a.monthlyCost)

  return { resources, costBreakdown }
}
