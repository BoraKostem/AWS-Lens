import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { DescribeInstancesCommand, DescribeKeyPairsCommand, DescribeSecurityGroupsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2'
import { ListFunctionsCommand, LambdaClient, ListTagsCommand as ListLambdaTagsCommand } from '@aws-sdk/client-lambda'
import { DescribeClusterCommand, EKSClient, ListClustersCommand } from '@aws-sdk/client-eks'
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling'
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3'
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { CloudFormationClient, ListStacksCommand } from '@aws-sdk/client-cloudformation'
import { ECRClient, DescribeRepositoriesCommand } from '@aws-sdk/client-ecr'
import { ECSClient, ListClustersCommand as EcsListClustersCommand } from '@aws-sdk/client-ecs'
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { Route53Client, ListHostedZonesCommand } from '@aws-sdk/client-route-53'
import { ListTagsForResourceCommand, SNSClient, ListTopicsCommand } from '@aws-sdk/client-sns'
import { ListQueueTagsCommand, SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs'
import { ACMClient, ListCertificatesCommand } from '@aws-sdk/client-acm'
import { KMSClient, ListKeysCommand } from '@aws-sdk/client-kms'
import { WAFV2Client, ListWebACLsCommand } from '@aws-sdk/client-wafv2'
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager'
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch'
import { CloudTrailClient, DescribeTrailsCommand } from '@aws-sdk/client-cloudtrail'
import { IAMClient, ListUsersCommand, ListRolesCommand } from '@aws-sdk/client-iam'

import { awsClientConfig, readTags } from './client'
import type {
  AwsConnection,
  CostBreakdown,
  CostBreakdownEntry,
  InsightItem,
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

/* ── cost heuristics (monthly USD estimates per resource) ── */
const COST_EC2_INSTANCE = 43.8
const COST_LAMBDA_FUNCTION = 5.0
const COST_EKS_CLUSTER = 73.0
const COST_ASG_INSTANCE = 43.8
const COST_S3_BUCKET = 2.3
const COST_RDS_INSTANCE = 48.5
const COST_CFN_STACK = 0
const COST_ECR_REPO = 1.0
const COST_ECS_CLUSTER = 36.0
const COST_VPC = 4.5
const COST_LOAD_BALANCER = 16.2
const COST_ROUTE53_ZONE = 0.5
const COST_SECURITY_GROUP = 0
const COST_SNS_TOPIC = 0.5
const COST_SQS_QUEUE = 0.4
const COST_ACM_CERT = 0
const COST_KMS_KEY = 1.0
const COST_WAF_ACL = 5.0
const COST_SECRET = 0.4
const COST_KEY_PAIR = 0
const COST_CW_ALARM = 0.1

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
  const client = new EC2Client(awsClientConfig(connection))
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
  const client = new LambdaClient(awsClientConfig(connection))
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
  const client = new EKSClient(awsClientConfig(connection))
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
  const client = new AutoScalingClient(awsClientConfig(connection))
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
  const client = new S3Client(awsClientConfig(connection))
  const output = await client.send(new ListBucketsCommand({}))
  return output.Buckets?.length ?? 0
}

async function countRds(connection: AwsConnection): Promise<number> {
  const client = new RDSClient(awsClientConfig(connection))
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
  const client = new CloudFormationClient(awsClientConfig(connection))
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
  const client = new ECRClient(awsClientConfig(connection))
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
  const client = new ECSClient(awsClientConfig(connection))
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
  const client = new EC2Client(awsClientConfig(connection))
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
  const client = new ElasticLoadBalancingV2Client(awsClientConfig(connection))
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
  const client = new Route53Client(awsClientConfig(connection))
  const output = await client.send(new ListHostedZonesCommand({}))
  return output.HostedZones?.length ?? 0
}

async function countSecurityGroups(connection: AwsConnection): Promise<number> {
  const client = new EC2Client(awsClientConfig(connection))
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
  const client = new SNSClient(awsClientConfig(connection))
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
  const client = new SQSClient(awsClientConfig(connection))
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
  const client = new ACMClient(awsClientConfig(connection))
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
  const client = new KMSClient(awsClientConfig(connection))
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
  const client = new WAFV2Client(awsClientConfig(connection))
  const output = await client.send(new ListWebACLsCommand({ Scope: 'REGIONAL', Limit: 100 }))
  return output.WebACLs?.length ?? 0
}

async function countSecretsManager(connection: AwsConnection): Promise<number> {
  const client = new SecretsManagerClient(awsClientConfig(connection))
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
  const client = new EC2Client(awsClientConfig(connection))
  const output = await client.send(new DescribeKeyPairsCommand({}))
  return output.KeyPairs?.length ?? 0
}

async function countCloudWatch(connection: AwsConnection): Promise<number> {
  const client = new CloudWatchClient(awsClientConfig(connection))
  const output = await client.send(new DescribeAlarmsCommand({}))
  return output.MetricAlarms?.length ?? 0
}

async function countCloudTrail(connection: AwsConnection): Promise<number> {
  const client = new CloudTrailClient(awsClientConfig(connection))
  const output = await client.send(new DescribeTrailsCommand({}))
  return output.trailList?.length ?? 0
}

async function countIam(connection: AwsConnection): Promise<number> {
  const client = new IAMClient(awsClientConfig(connection))
  const [users, roles] = await Promise.all([
    client.send(new ListUsersCommand({})),
    client.send(new ListRolesCommand({}))
  ])
  return (users.Users?.length ?? 0) + (roles.Roles?.length ?? 0)
}

/* ── safe-fetch: returns zero counts on permission / network errors ── */

async function safeCount<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function listTaggedLambda(connection: AwsConnection): Promise<Array<{ id: string; name: string; tags: Record<string, string> }>> {
  const client = new LambdaClient(awsClientConfig(connection))
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
  const client = new EKSClient(awsClientConfig(connection))
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
  const client = new EC2Client(awsClientConfig(connection))
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
  const client = new EC2Client(awsClientConfig(connection))
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
  const client = new SNSClient(awsClientConfig(connection))
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
  const client = new SQSClient(awsClientConfig(connection))
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
  const client = new SecretsManagerClient(awsClientConfig(connection))
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
  const client = new EC2Client(awsClientConfig(connection))
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
  costMap: Map<string, { count: number; cost: number }>,
  item: { resourceId: string; resourceType: string; service: string; name: string; tags: Record<string, string> },
  matchedTag: { key: string; value: string },
  estimatedCost: number
): void {
  resources.push(item)

  const mapKey = `${matchedTag.key}=${matchedTag.value}`
  const existing = costMap.get(mapKey) ?? { count: 0, cost: 0 }
  existing.count += 1
  existing.cost += estimatedCost
  costMap.set(mapKey, existing)
}

/* ── public API ───────────────────────────────────────────── */

export async function getOverviewMetrics(
  connection: AwsConnection,
  regions: string[]
): Promise<OverviewMetrics> {
  const regionMetrics: RegionMetric[] = []
  const regionCosts: RegionCostRow[] = []

  // Global services (not region-scoped) — query once using the first region
  const globalConn = { ...connection, region: regions[0] ?? connection.region }
  const [s3Global, r53Global, iamGlobal, ctGlobal] = await Promise.all([
    safeCount(() => countS3(globalConn), 0),
    safeCount(() => countRoute53(globalConn), 0),
    safeCount(() => countIam(globalConn), 0),
    safeCount(() => countCloudTrail(globalConn), 0)
  ])

  await Promise.all(
    regions.map(async (region, index) => {
      const regionConn = { ...connection, region }
      const [ec2, lambda, eks, asg, rds, cfn, ecr, ecs, vpc, elb, sg, sns, sqs, acm, kms, waf, sm, kp, cw] = await Promise.all([
        safeCount(() => countEc2(regionConn), { count: 0, instances: [] }),
        safeCount(() => countLambda(regionConn), { count: 0, functions: [] }),
        safeCount(() => countEks(regionConn), { count: 0, clusters: [] }),
        safeCount(() => countAsg(regionConn), { count: 0, groups: [] }),
        safeCount(() => countRds(regionConn), 0),
        safeCount(() => countCloudFormation(regionConn), 0),
        safeCount(() => countEcr(regionConn), 0),
        safeCount(() => countEcs(regionConn), 0),
        safeCount(() => countVpc(regionConn), 0),
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

      regionMetrics.push({
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
      })

      const ec2Cost = ec2.count * COST_EC2_INSTANCE
      const lambdaCost = lambda.count * COST_LAMBDA_FUNCTION
      const eksCost = eks.count * COST_EKS_CLUSTER
      const asgCost = asg.groups.reduce((sum, g) => sum + g.instances * COST_ASG_INSTANCE, 0)
      const s3Cost = s3 * COST_S3_BUCKET
      const rdsCost = rds * COST_RDS_INSTANCE
      const cfnCost = cfn * COST_CFN_STACK
      const ecrCost = ecr * COST_ECR_REPO
      const ecsCost = ecs * COST_ECS_CLUSTER
      const vpcCost = vpc * COST_VPC
      const elbCost = elb * COST_LOAD_BALANCER
      const r53Cost = r53 * COST_ROUTE53_ZONE
      const sgCost = sg * COST_SECURITY_GROUP
      const snsCost = sns * COST_SNS_TOPIC
      const sqsCost = sqs * COST_SQS_QUEUE
      const acmCost = acm * COST_ACM_CERT
      const kmsCost = kms * COST_KMS_KEY
      const wafCost = waf * COST_WAF_ACL
      const smCost = sm * COST_SECRET
      const kpCost = kp * COST_KEY_PAIR
      const cwCost = cw * COST_CW_ALARM

      const totalCost = ec2Cost + lambdaCost + eksCost + asgCost + s3Cost + rdsCost +
        cfnCost + ecrCost + ecsCost + vpcCost + elbCost + r53Cost + sgCost +
        snsCost + sqsCost + acmCost + kmsCost + wafCost + smCost + kpCost + cwCost

      regionCosts.push({
        region, ec2Cost, lambdaCost, eksCost, asgCost, s3Cost, rdsCost, cfnCost,
        ecrCost, ecsCost, vpcCost, elbCost, r53Cost, sgCost, snsCost, sqsCost,
        acmCost, kmsCost, wafCost, smCost, kpCost, cwCost, totalCost
      })
    })
  )

  const totalResources = regionMetrics.reduce((s, r) => s + r.totalResources, 0)
  const totalCost = regionCosts.reduce((s, r) => s + r.totalCost, 0)

  return {
    regions: regionMetrics,
    costs: regionCosts,
    globalTotals: {
      totalResources,
      totalCost,
      regionCount: regions.length
    }
  }
}

/* ── Cost Explorer: real billing data ─────────────────────── */

export async function getCostBreakdown(connection: AwsConnection): Promise<CostBreakdown> {
  const client = new CostExplorerClient(awsClientConfig({ ...connection, region: 'us-east-1' }))

  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  // Use tomorrow as end date to ensure we get all MTD data
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  const resp = await client.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: fmt(start), End: fmt(end) },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  }))

  // Aggregate across all ResultsByTime entries
  const serviceMap = new Map<string, number>()

  for (const result of resp.ResultsByTime ?? []) {
    for (const group of result.Groups ?? []) {
      const service = group.Keys?.[0] ?? 'Unknown'
      const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount ?? '0')
      serviceMap.set(service, (serviceMap.get(service) ?? 0) + amount)
    }
  }

  const entries: CostBreakdownEntry[] = []
  let total = 0

  for (const [service, amount] of serviceMap) {
    if (amount > 0.001) {
      entries.push({ service, amount: Math.round(amount * 100) / 100 })
      total += amount
    }
  }

  entries.sort((a, b) => b.amount - a.amount)
  total = Math.round(total * 100) / 100

  const period = `${start.toLocaleString('en', { month: 'short' })} ${start.getFullYear()}`

  return { entries, total, period }
}

/* ── relationship-specific fetchers ───────────────────────── */

async function fetchSecurityGroups(connection: AwsConnection): Promise<Array<{ id: string; name: string; vpcId: string }>> {
  const client = new EC2Client(awsClientConfig(connection))
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
  const client = new ElasticLoadBalancingV2Client(awsClientConfig(connection))
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
  const client = new ECSClient(awsClientConfig(connection))
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
  const client = new SNSClient(awsClientConfig(connection))
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
  const client = new SQSClient(awsClientConfig(connection))
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
  const [ec2, lambda, eks, asg, s3, rds, cfn, ecr, ecs, vpc, elb, r53, sg, sns, sqs, acm, kms, waf, sm, kp, cw, ct, iam] = await Promise.all([
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
    safeCount(() => countIam(connection), 0)
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

  const totalCost =
    ec2.count * COST_EC2_INSTANCE +
    lambda.count * COST_LAMBDA_FUNCTION +
    eks.count * COST_EKS_CLUSTER +
    totalAsgInstances * COST_ASG_INSTANCE

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
    { label: 'Est. Monthly Cost', value: `$${totalCost.toFixed(0)}`, detail: 'Based on compute resource heuristics', trend: 'neutral' }
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
  if (totalCost > 500) {
    signals.push({ severity: 'high', region, title: 'Elevated regional spend detected', description: `Estimated monthly cost in ${region} is $${totalCost.toFixed(0)}, driven primarily by ${ec2.count > 0 ? 'EC2' : eks.count > 0 ? 'EKS' : 'compute'} resources.`, nextStep: 'Review resource utilization and consider right-sizing or reserved instances for cost optimization.', category: 'cost' })
  } else if (totalCost > 200) {
    signals.push({ severity: 'medium', region, title: 'Moderate regional spend', description: `Estimated monthly cost in ${region} is $${totalCost.toFixed(0)} across ${allResourceTotal} resources.`, nextStep: 'Monitor spend trends and review resource allocation periodically.', category: 'cost' })
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
  const [ec2, asg, lambda, eks, vpcs, securityGroups, snsTopics, sqsQueues, secrets, keyPairs] = await Promise.all([
    safeCount(() => countEc2(connection), { count: 0, instances: [] }),
    safeCount(() => countAsg(connection), { count: 0, groups: [] }),
    safeCount(() => listTaggedLambda(connection), []),
    safeCount(() => listTaggedEks(connection), []),
    safeCount(() => listTaggedVpcs(connection), []),
    safeCount(() => listTaggedSecurityGroups(connection), []),
    safeCount(() => listTaggedSns(connection), []),
    safeCount(() => listTaggedSqs(connection), []),
    safeCount(() => listTaggedSecrets(connection), []),
    safeCount(() => listTaggedKeyPairs(connection), [])
  ])

  const resources: TaggedResource[] = []
  const costMap = new Map<string, { count: number; cost: number }>()

  // Search EC2 tags
  for (const inst of ec2.instances) {
    const matchedTag = matchesTag(inst.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: inst.id,
        resourceType: 'EC2 Instance',
        service: 'ec2',
        name: inst.name,
        tags: inst.tags
      }, matchedTag, COST_EC2_INSTANCE)
    }
  }

  // Search ASG tags
  for (const group of asg.groups) {
    const matchedTag = matchesTag(group.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: group.name,
        resourceType: 'Auto Scaling Group',
        service: 'auto-scaling',
        name: group.name,
        tags: group.tags
      }, matchedTag, group.instances * COST_ASG_INSTANCE)
    }
  }

  for (const fn of lambda) {
    const matchedTag = matchesTag(fn.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: fn.id,
        resourceType: 'Lambda Function',
        service: 'lambda',
        name: fn.name,
        tags: fn.tags
      }, matchedTag, COST_LAMBDA_FUNCTION)
    }
  }

  for (const cluster of eks) {
    const matchedTag = matchesTag(cluster.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: cluster.id,
        resourceType: 'EKS Cluster',
        service: 'eks',
        name: cluster.name,
        tags: cluster.tags
      }, matchedTag, COST_EKS_CLUSTER)
    }
  }

  for (const vpc of vpcs) {
    const matchedTag = matchesTag(vpc.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: vpc.id,
        resourceType: 'VPC',
        service: 'vpc',
        name: vpc.name,
        tags: vpc.tags
      }, matchedTag, COST_VPC)
    }
  }

  for (const group of securityGroups) {
    const matchedTag = matchesTag(group.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: group.id,
        resourceType: 'Security Group',
        service: 'security-groups',
        name: group.name,
        tags: group.tags
      }, matchedTag, COST_SECURITY_GROUP)
    }
  }

  for (const topic of snsTopics) {
    const matchedTag = matchesTag(topic.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: topic.id,
        resourceType: 'SNS Topic',
        service: 'sns',
        name: topic.name,
        tags: topic.tags
      }, matchedTag, COST_SNS_TOPIC)
    }
  }

  for (const queue of sqsQueues) {
    const matchedTag = matchesTag(queue.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: queue.id,
        resourceType: 'SQS Queue',
        service: 'sqs',
        name: queue.name,
        tags: queue.tags
      }, matchedTag, COST_SQS_QUEUE)
    }
  }

  for (const secret of secrets) {
    const matchedTag = matchesTag(secret.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: secret.id,
        resourceType: 'Secret',
        service: 'secrets-manager',
        name: secret.name,
        tags: secret.tags
      }, matchedTag, COST_SECRET)
    }
  }

  for (const keyPair of keyPairs) {
    const matchedTag = matchesTag(keyPair.tags, tagKey, tagValue)
    if (matchedTag) {
      addMatchedTaggedResource(resources, costMap, {
        resourceId: keyPair.id,
        resourceType: 'Key Pair',
        service: 'key-pairs',
        name: keyPair.name,
        tags: keyPair.tags
      }, matchedTag, COST_KEY_PAIR)
    }
  }

  const costBreakdown: TagCostEntry[] = []
  for (const [mapKey, entry] of costMap) {
    const [key, ...rest] = mapKey.split('=')
    costBreakdown.push({
      tagKey: key,
      tagValue: rest.join('='),
      resourceCount: entry.count,
      estimatedCost: entry.cost
    })
  }

  costBreakdown.sort((a, b) => b.estimatedCost - a.estimatedCost)

  return { resources, costBreakdown }
}
