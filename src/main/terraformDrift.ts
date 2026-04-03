import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app } from 'electron'
import { CloudWatchClient, DescribeAlarmsCommand, ListTagsForResourceCommand as ListCloudWatchTagsForResourceCommand } from '@aws-sdk/client-cloudwatch'
import { DescribeAddressesCommand, EC2Client } from '@aws-sdk/client-ec2'
import { DescribeClustersCommand, DescribeTaskDefinitionCommand, ECSClient, ListClustersCommand } from '@aws-sdk/client-ecs'
import { IAMClient, ListAttachedRolePoliciesCommand } from '@aws-sdk/client-iam'
import { DescribeDBInstancesCommand, DescribeDBSubnetGroupsCommand, RDSClient } from '@aws-sdk/client-rds'

import type {
  AwsConnection,
  CloudWatchLogGroupSummary,
  Ec2InstanceSummary,
  EcsClusterSummary,
  EcsServiceSummary,
  EcsTaskDefinitionReference,
  EcrRepositorySummary,
  EksClusterSummary,
  InternetGatewaySummary,
  IamRoleSummary,
  LambdaFunctionSummary,
  LoadBalancerListener,
  LoadBalancerSummary,
  LoadBalancerTargetGroup,
  LoadBalancerWorkspace,
  NatGatewaySummary,
  NetworkInterfaceSummary,
  RdsClusterSummary,
  RdsInstanceSummary,
  Route53RecordSummary,
  RouteTableSummary,
  S3BucketSummary,
  SecurityGroupSummary,
  SubnetSummary,
  TerraformDriftCoverageItem,
  TerraformDriftDifference,
  TerraformDriftHistory,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformDriftSnapshot,
  TerraformDriftStatus,
  TerraformProject,
  TerraformResourceInventoryItem,
  TransitGatewaySummary,
  VpcSummary
} from '@shared/types'
import { awsClientConfig, readTags } from './aws/client'
import { listCloudWatchLogGroups } from './aws/cloudwatch'
import { listEc2Instances } from './aws/ec2'
import { listEcrRepositories } from './aws/ecr'
import { listClusters as listEcsClusters, listServices as listEcsServices } from './aws/ecs'
import { listEksClusters, listEksNodegroups } from './aws/eks'
import { listIamRoles } from './aws/iam'
import { listLambdaFunctions } from './aws/lambda'
import { listLoadBalancerWorkspaces } from './aws/loadBalancers'
import { listDbClusters, listDbInstances } from './aws/rds'
import { listRoute53HostedZones, listRoute53Records } from './aws/route53'
import { listBuckets } from './aws/s3'
import { listSecurityGroups } from './aws/securityGroups'
import {
  listInternetGateways,
  listNatGateways,
  listNetworkInterfaces,
  listRouteTables,
  listSubnets,
  listTransitGateways,
  listVpcs
} from './aws/vpc'
import { getCachedCliInfo, getProject } from './terraform'

type ComparableValue = string | number | boolean
type IdentityKey = 'cloudIdentifier' | 'logicalName'

type ComparableResource = {
  resourceType: string
  logicalName: string
  cloudIdentifier: string
  region: string
  consoleUrl: string
  attributes: Record<string, ComparableValue>
  tags: Record<string, string>
}

type EcsClusterCapacityProviderSummary = {
  clusterName: string
  capacityProviders: string[]
  defaultStrategy: string[]
}

type EksNodegroupLiveSummary = {
  clusterName: string
  nodegroupName: string
  status: string
  minSize: number
  desiredSize: number
  maxSize: number
  instanceTypes: string[]
}

type IamRolePolicyAttachmentSummary = {
  roleName: string
  policyArn: string
  policyName: string
}

type ElasticIpSummary = {
  allocationId: string
  publicIp: string
  privateIp: string
  domain: string
  networkInterfaceId: string
  instanceId: string
  tags: Record<string, string>
}

type DbSubnetGroupSummary = {
  name: string
  description: string
  vpcId: string
  subnetCount: number
}

type AuroraClusterInstanceSummary = {
  dbInstanceIdentifier: string
  dbClusterIdentifier: string
  engine: string
  dbInstanceClass: string
  availabilityZone: string
}

type RouteTableAssociationSummary = {
  associationId: string
  routeTableId: string
  subnetId: string
  gatewayId: string
  isMain: boolean
}

type SecurityGroupRuleSummary = {
  securityGroupId: string
  direction: 'ingress' | 'egress'
  protocol: string
  fromPort: number
  toPort: number
  source: string
  description: string
}

type EcsServiceLiveSummary = EcsServiceSummary & {
  clusterArn: string
  clusterName: string
}

type CloudWatchAlarmLiveSummary = {
  alarmArn: string
  alarmName: string
  comparisonOperator: string
  evaluationPeriods: number
  threshold: number
  namespace: string
  metricName: string
  dimensions: Record<string, string>
  tags: Record<string, string>
}

type Route53RecordLiveSummary = Route53RecordSummary & {
  hostedZoneId: string
}

type LoadBalancerListenerLiveSummary = LoadBalancerListener & {
  loadBalancerArn: string
  loadBalancerName: string
}

type LoadBalancerTargetGroupLiveSummary = LoadBalancerTargetGroup & {
  loadBalancerArn: string
  loadBalancerName: string
}

type LiveInventory = {
  aws_instance: Ec2InstanceSummary[]
  aws_security_group: SecurityGroupSummary[]
  aws_vpc: VpcSummary[]
  aws_subnet: SubnetSummary[]
  aws_route_table: RouteTableSummary[]
  aws_internet_gateway: InternetGatewaySummary[]
  aws_nat_gateway: NatGatewaySummary[]
  aws_ec2_transit_gateway: TransitGatewaySummary[]
  aws_network_interface: NetworkInterfaceSummary[]
  aws_s3_bucket: S3BucketSummary[]
  aws_lambda_function: LambdaFunctionSummary[]
  aws_db_instance: RdsInstanceSummary[]
  aws_rds_cluster: RdsClusterSummary[]
  aws_ecr_repository: EcrRepositorySummary[]
  aws_eks_cluster: EksClusterSummary[]
  aws_ecs_cluster: EcsClusterSummary[]
  aws_ecs_cluster_capacity_providers: EcsClusterCapacityProviderSummary[]
  aws_eks_node_group: EksNodegroupLiveSummary[]
  aws_iam_role: IamRoleSummary[]
  aws_iam_role_policy_attachment: IamRolePolicyAttachmentSummary[]
  aws_eip: ElasticIpSummary[]
  aws_db_subnet_group: DbSubnetGroupSummary[]
  aws_rds_cluster_instance: AuroraClusterInstanceSummary[]
  aws_route_table_association: RouteTableAssociationSummary[]
  aws_security_group_rule: SecurityGroupRuleSummary[]
  aws_lb: LoadBalancerSummary[]
  aws_ecs_service: EcsServiceLiveSummary[]
  aws_cloudwatch_metric_alarm: CloudWatchAlarmLiveSummary[]
  aws_route53_record: Route53RecordLiveSummary[]
  aws_cloudwatch_log_group: CloudWatchLogGroupSummary[]
  aws_ecs_task_definition: EcsTaskDefinitionReference[]
  aws_lb_listener: LoadBalancerListenerLiveSummary[]
  aws_lb_target_group: LoadBalancerTargetGroupLiveSummary[]
}

type SupportedResourceType = keyof LiveInventory

type SupportedHandler<TLive> = {
  normalizeTerraform: (item: TerraformResourceInventoryItem, connection: AwsConnection) => ComparableResource | null
  normalizeLive: (item: TLive, connection: AwsConnection) => ComparableResource
  identityKeys: IdentityKey[]
  verifiedChecks: string[]
  inferredChecks: string[]
  notes: string[]
}

type NormalizedTerraformResource = {
  resource: TerraformResourceInventoryItem
  comparable: ComparableResource
}

type StoredDriftContext = {
  projectId: string
  projectName: string
  profileName: string
  region: string
  snapshots: TerraformDriftSnapshot[]
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function list(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function count(values: unknown): number {
  return Array.isArray(values) ? values.length : 0
}

function firstObject(values: unknown): Record<string, unknown> {
  if (Array.isArray(values)) {
    const first = values.find((value) => value && typeof value === 'object')
    return first && typeof first === 'object' ? first as Record<string, unknown> : {}
  }
  return values && typeof values === 'object' ? values as Record<string, unknown> : {}
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function normalizeTags(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0)
      .map(([key, value]) => [key, value.trim()])
  )
}

function terraformTags(values: Record<string, unknown>): Record<string, string> {
  const tagsAll = normalizeTags(values.tags_all)
  return Object.keys(tagsAll).length > 0 ? tagsAll : normalizeTags(values.tags)
}

function extractArn(values: Record<string, unknown>): string {
  return str(values.arn)
}

function extractRegion(values: Record<string, unknown>): string {
  const arn = extractArn(values)
  if (arn) {
    const parts = arn.split(':')
    if (parts.length >= 4 && parts[3]) return parts[3]
  }
  const region = str(values.region)
  if (region) return region
  const az = str(values.availability_zone)
  if (az) return az.replace(/[a-z]$/, '')
  return ''
}

function formatValue(value: string | number | boolean | undefined): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return value ?? ''
}

function consoleUrl(servicePath: string, region: string): string {
  return `https://${region ? `${region}.` : ''}console.aws.amazon.com/${servicePath}`
}

function normalizeDnsName(value: string): string {
  return value.trim().replace(/\.+$/, '').toLowerCase()
}

function normalizeOptionalDnsName(value: string): string {
  const normalized = normalizeDnsName(value)
  return normalized || ''
}

function stableComparableKey(item: ComparableResource): string {
  return item.cloudIdentifier || item.logicalName || item.consoleUrl
}

function createDifference(
  key: string,
  label: string,
  kind: TerraformDriftDifference['kind'],
  terraformValue: string,
  liveValue: string,
  assessment: TerraformDriftDifference['assessment'] = 'verified'
): TerraformDriftDifference {
  return { key, label, kind, terraformValue, liveValue, assessment }
}

function compareAttributes(terraform: ComparableResource, live: ComparableResource): TerraformDriftDifference[] {
  const keys = unique([...Object.keys(terraform.attributes), ...Object.keys(live.attributes)])
  return keys.flatMap((key) => {
    const left = terraform.attributes[key]
    const right = live.attributes[key]
    if (left === undefined || right === undefined || left === right) return []
    if (typeof left === 'string' && left.trim().length === 0) return []
    return [createDifference(key, key.replaceAll('_', ' '), 'attribute', formatValue(left), formatValue(right))]
  })
}

function compareTags(terraform: ComparableResource, live: ComparableResource): TerraformDriftDifference[] {
  // Some list/summary APIs in this workspace do not hydrate tags for every
  // resource type. Treat an empty live tag set as "unknown" instead of
  // "definitively no tags" to avoid false-positive drift immediately after apply.
  if (Object.keys(live.tags).length === 0) return []
  const keys = unique([...Object.keys(terraform.tags), ...Object.keys(live.tags)]).sort()
  return keys.flatMap((key) => {
    const left = terraform.tags[key] ?? ''
    const right = live.tags[key] ?? ''
    if (left === right) return []
    return [createDifference(`tag:${key}`, `tag:${key}`, 'tag', left, right)]
  })
}

function sortItems(items: TerraformDriftItem[]): TerraformDriftItem[] {
  const statusOrder: Record<TerraformDriftStatus, number> = {
    drifted: 0,
    missing_in_aws: 1,
    in_sync: 2,
    unmanaged_in_aws: 3,
    unsupported: 4
  }
  return [...items].sort((left, right) =>
    statusOrder[left.status] - statusOrder[right.status] ||
    left.resourceType.localeCompare(right.resourceType) ||
    left.logicalName.localeCompare(right.logicalName) ||
    left.terraformAddress.localeCompare(right.terraformAddress)
  )
}

function driftStoreDir(): string {
  return path.join(app.getPath('userData'), 'terraform-drift-history')
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function driftStorePath(profileName: string, projectId: string, region: string): string {
  return path.join(driftStoreDir(), `${sanitizeFileSegment(profileName)}-${sanitizeFileSegment(region)}-${sanitizeFileSegment(projectId)}.json`)
}

export function invalidateTerraformDriftReport(profileName: string, projectId: string, region: string): void {
  try {
    fs.rmSync(driftStorePath(profileName, projectId, region), { force: true })
  } catch {
    // Ignore cache invalidation failures. Drift can always be re-scanned.
  }
}

export function invalidateTerraformDriftReports(profileName: string, projectId: string): void {
  try {
    const suffix = `-${sanitizeFileSegment(projectId)}.json`
    for (const entry of fs.readdirSync(driftStoreDir(), { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith(`${sanitizeFileSegment(profileName)}-`)) continue
      if (!entry.name.endsWith(suffix)) continue
      try {
        fs.rmSync(path.join(driftStoreDir(), entry.name), { force: true })
      } catch {
        // Ignore per-file invalidation failures.
      }
    }
  } catch {
    // Ignore cache invalidation failures. Drift can always be re-scanned.
  }
}

function readStoredContext(profileName: string, projectId: string, region: string): StoredDriftContext | null {
  try {
    return JSON.parse(fs.readFileSync(driftStorePath(profileName, projectId, region), 'utf-8')) as StoredDriftContext
  } catch {
    return null
  }
}

function writeStoredContext(profileName: string, projectId: string, region: string, context: StoredDriftContext): void {
  fs.mkdirSync(driftStoreDir(), { recursive: true })
  fs.writeFileSync(driftStorePath(profileName, projectId, region), JSON.stringify(context, null, 2), 'utf-8')
}

function computeTrend(snapshots: TerraformDriftSnapshot[]): TerraformDriftHistory['trend'] {
  if (snapshots.length < 2) return 'insufficient_history'
  const [latest, previous] = snapshots
  const latestIssues = latest.summary.statusCounts.drifted + latest.summary.statusCounts.missing_in_aws + latest.summary.statusCounts.unmanaged_in_aws
  const previousIssues = previous.summary.statusCounts.drifted + previous.summary.statusCounts.missing_in_aws + previous.summary.statusCounts.unmanaged_in_aws
  if (latestIssues < previousIssues) return 'improving'
  if (latestIssues > previousIssues) return 'worsening'
  return 'unchanged'
}

function buildHistory(snapshots: TerraformDriftSnapshot[]): TerraformDriftHistory {
  return {
    snapshots,
    trend: computeTrend(snapshots),
    latestScanAt: snapshots[0]?.scannedAt ?? '',
    previousScanAt: snapshots[1]?.scannedAt ?? ''
  }
}

function buildSummary(items: TerraformDriftItem[], coverage: TerraformDriftCoverageItem[], scannedAt: string) {
  const statusCounts: Record<TerraformDriftStatus, number> = {
    in_sync: 0,
    drifted: 0,
    missing_in_aws: 0,
    unmanaged_in_aws: 0,
    unsupported: 0
  }
  const resourceTypeMap = new Map<string, number>()
  const unsupportedTypes = new Set<string>()
  let verifiedCount = 0
  let inferredCount = 0

  for (const item of items) {
    statusCounts[item.status] += 1
    resourceTypeMap.set(item.resourceType, (resourceTypeMap.get(item.resourceType) ?? 0) + 1)
    if (item.assessment === 'unsupported') unsupportedTypes.add(item.resourceType)
    else if (item.differences.some((difference) => difference.assessment === 'inferred')) inferredCount += 1
    else verifiedCount += 1
  }

  return {
    total: items.length,
    statusCounts,
    resourceTypeCounts: Array.from(resourceTypeMap.entries())
      .map(([resourceType, count]) => ({ resourceType, count }))
      .sort((left, right) => right.count - left.count || left.resourceType.localeCompare(right.resourceType)),
    scannedAt,
    verifiedCount,
    inferredCount,
    unsupportedResourceTypes: [...unsupportedTypes].sort(),
    supportedResourceTypes: coverage
  }
}

function makeStateShowCommand(project: TerraformProject, address: string): string {
  if (!address) return ''
  const escapedRoot = project.rootPath.replace(/'/g, "''")
  const cliPath = getCachedCliInfo().path
  const cliInvocation = cliPath ? `& '${cliPath.replace(/'/g, "''")}'` : 'terraform'
  return `Set-Location '${escapedRoot}'; ${cliInvocation} state show ${address}`
}

function findLiveMatch(terraform: ComparableResource, live: ComparableResource[], identityKeys: IdentityKey[]): ComparableResource | null {
  for (const key of identityKeys) {
    const needle = terraform[key]
    if (!needle) continue
    const match = live.find((candidate) => candidate[key] === needle)
    if (match) return match
  }
  return null
}

function supportedCoverage(): TerraformDriftCoverageItem[] {
  return Object.entries(SUPPORTED_HANDLERS)
    .map(([resourceType, handler]) => coverageItem(resourceType, handler.verifiedChecks, handler.inferredChecks, handler.notes))
    .sort((left, right) => left.resourceType.localeCompare(right.resourceType))
}

function normalizeRuleProtocol(value: string): string {
  if (value === '-1' || value.toLowerCase() === 'all') return 'all'
  return value.toLowerCase()
}

function normalizeRuleSource(values: Record<string, unknown>, direction: 'ingress' | 'egress'): string {
  const key = direction === 'ingress' ? 'source_security_group_id' : 'source_security_group_id'
  return str(values[key])
    || list(values.prefix_list_ids)[0]
    || list(values.cidr_blocks)[0]
    || list(values.ipv6_cidr_blocks)[0]
    || '0.0.0.0/0'
}

function canonicalSecurityGroupRuleKey(
  groupId: string,
  direction: 'ingress' | 'egress',
  protocol: string,
  fromPort: number,
  toPort: number,
  source: string
): string {
  return [groupId, direction, normalizeRuleProtocol(protocol), fromPort, toPort, source].join('|')
}

function canonicalCapacityProviderStrategy(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values
    .map((value) => {
      const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const provider = str(item.capacity_provider)
      if (!provider) return ''
      const base = num(item.base)
      const weight = num(item.weight)
      return `${provider}:${base ?? 0}:${weight ?? 0}`
    })
    .filter(Boolean)
    .sort()
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0)
      .map(([key, mapValue]) => [key, mapValue])
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

function encodeStringMap(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, mapValue]) => `${key}=${mapValue}`)
    .sort()
    .join(',')
}

function normalizeEcsClusterRef(value: string): string {
  if (!value) return ''
  const match = value.match(/cluster\/(.+)$/)
  return match?.[1] ?? value
}

function normalizeTaskDefinitionRef(value: string): string {
  if (!value) return ''
  const match = value.match(/task-definition\/(.+)$/)
  return match?.[1] ?? value
}

function normalizeTaskDefinitionFamily(value: string): string {
  const normalized = normalizeTaskDefinitionRef(value)
  return normalized.split(':')[0] ?? normalized
}

function normalizeTaskDefinitionRevision(value: string): number {
  const normalized = normalizeTaskDefinitionRef(value)
  const revision = Number(normalized.split(':')[1] ?? '')
  return Number.isFinite(revision) ? revision : 0
}

function normalizeTargetGroupRef(value: string): string {
  if (!value) return ''
  const segments = value.split('/').filter(Boolean)
  if (segments.length >= 2) {
    return segments[segments.length - 2] ?? value
  }
  return value
}

function normalizeContainerDefinitions(raw: unknown): Array<Record<string, unknown>> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : []
  } catch {
    return []
  }
}

function extractContainerLogGroups(definitions: Array<Record<string, unknown>>): string[] {
  return definitions
    .map((container) => {
      const logConfiguration = container.logConfiguration
      if (!logConfiguration || typeof logConfiguration !== 'object') return ''
      const options = (logConfiguration as Record<string, unknown>).options
      if (!options || typeof options !== 'object') return ''
      return str((options as Record<string, unknown>)['awslogs-group'])
    })
    .filter(Boolean)
    .sort()
}

function normalizeListenerActions(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values
    .map((value) => {
      const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const type = str(item.type)
      const targetGroupArn = str(item.target_group_arn)
      const redirect = firstObject(item.redirect)
      const fixedResponse = firstObject(item.fixed_response)
      if (type === 'forward' && targetGroupArn) return `forward:${normalizeTargetGroupRef(targetGroupArn)}`
      if (type === 'redirect') {
        return `redirect:${str(redirect.protocol)}:${str(redirect.port)}:${str(redirect.status_code)}`
      }
      if (type === 'fixed-response') {
        return `fixed-response:${str(fixedResponse.content_type)}:${str(fixedResponse.status_code)}`
      }
      return type
    })
    .filter(Boolean)
    .sort()
}

function route53RecordKey(hostedZoneId: string, name: string, type: string, setIdentifier: string): string {
  return [hostedZoneId, normalizeDnsName(name), type.toUpperCase(), setIdentifier.trim()].join('|')
}

function inferTerraformRoute53RoutingPolicy(values: Record<string, unknown>): string {
  const failover = firstObject(values.failover_routing_policy)
  if (str(failover.type)) return `Failover ${str(failover.type)}`
  const latency = firstObject(values.latency_routing_policy)
  if (str(latency.region)) return `Latency ${str(latency.region)}`
  const geo = firstObject(values.geolocation_routing_policy)
  if (str(geo.country) || str(geo.continent)) return 'Geolocation'
  const weighted = firstObject(values.weighted_routing_policy)
  if (num(weighted.weight) !== null) return `Weighted ${num(weighted.weight)}`
  if (bool(values.multivalue_answer_routing_policy) ?? false) return 'Multivalue'
  return 'Simple'
}

async function listEcsClusterCapacityProviders(connection: AwsConnection): Promise<EcsClusterCapacityProviderSummary[]> {
  const client = new ECSClient(awsClientConfig(connection))
  const listOutput = await client.send(new ListClustersCommand({}))
  const clusterArns = listOutput.clusterArns ?? []
  if (clusterArns.length === 0) return []

  const describeOutput = await client.send(new DescribeClustersCommand({ clusters: clusterArns }))
  return (describeOutput.clusters ?? []).map((cluster) => ({
    clusterName: cluster.clusterName ?? '-',
    capacityProviders: [...(cluster.capacityProviders ?? [])].sort(),
    defaultStrategy: (cluster.defaultCapacityProviderStrategy ?? [])
      .map((item) => `${item.capacityProvider ?? ''}:${item.base ?? 0}:${item.weight ?? 0}`)
      .filter((item) => item.split(':')[0])
      .sort()
  }))
}

async function listElasticIps(connection: AwsConnection): Promise<ElasticIpSummary[]> {
  const client = new EC2Client(awsClientConfig(connection))
  const output = await client.send(new DescribeAddressesCommand({}))
  return (output.Addresses ?? []).map((address) => ({
    allocationId: address.AllocationId ?? '-',
    publicIp: address.PublicIp ?? '-',
    privateIp: address.PrivateIpAddress ?? '-',
    domain: address.Domain ?? '-',
    networkInterfaceId: address.NetworkInterfaceId ?? '-',
    instanceId: address.InstanceId ?? '-',
    tags: readTags(address.Tags)
  }))
}

async function listDbSubnetGroups(connection: AwsConnection): Promise<DbSubnetGroupSummary[]> {
  const client = new RDSClient(awsClientConfig(connection))
  const output = await client.send(new DescribeDBSubnetGroupsCommand({}))
  return (output.DBSubnetGroups ?? []).map((group) => ({
    name: group.DBSubnetGroupName ?? '-',
    description: group.DBSubnetGroupDescription ?? '-',
    vpcId: group.VpcId ?? '-',
    subnetCount: group.Subnets?.length ?? 0
  }))
}

async function listAuroraClusterInstances(connection: AwsConnection): Promise<AuroraClusterInstanceSummary[]> {
  const client = new RDSClient(awsClientConfig(connection))
  const output = await client.send(new DescribeDBInstancesCommand({}))
  return (output.DBInstances ?? [])
    .filter((instance) => Boolean(instance.DBClusterIdentifier))
    .map((instance) => ({
      dbInstanceIdentifier: instance.DBInstanceIdentifier ?? '-',
      dbClusterIdentifier: instance.DBClusterIdentifier ?? '-',
      engine: instance.Engine ?? '-',
      dbInstanceClass: instance.DBInstanceClass ?? '-',
      availabilityZone: instance.AvailabilityZone ?? '-'
    }))
}

async function listIamRolePolicyAttachments(connection: AwsConnection, roles: IamRoleSummary[]): Promise<IamRolePolicyAttachmentSummary[]> {
  const client = new IAMClient(awsClientConfig(connection))
  const attachments = await Promise.all(roles.map(async (role) => {
    const output = await client.send(new ListAttachedRolePoliciesCommand({ RoleName: role.roleName }))
    return (output.AttachedPolicies ?? []).map((policy) => ({
      roleName: role.roleName,
      policyArn: policy.PolicyArn ?? '-',
      policyName: policy.PolicyName ?? '-'
    }))
  }))
  return attachments.flat()
}

async function listLoadBalancerSummaries(connection: AwsConnection): Promise<LoadBalancerSummary[]> {
  const workspaces = await listLoadBalancerWorkspaces(connection)
  return workspaces.map((workspace) => workspace.summary)
}

async function listEcsServiceSummaries(connection: AwsConnection, clusters: EcsClusterSummary[]): Promise<EcsServiceLiveSummary[]> {
  const servicesByCluster = await Promise.all(
    clusters.map(async (cluster) => {
      const services = await listEcsServices(connection, cluster.clusterArn)
      return services.map((service) => ({
        ...service,
        clusterArn: cluster.clusterArn,
        clusterName: cluster.clusterName
      }))
    })
  )
  return servicesByCluster.flat()
}

async function listCloudWatchAlarmSummaries(connection: AwsConnection): Promise<CloudWatchAlarmLiveSummary[]> {
  const client = new CloudWatchClient(awsClientConfig(connection))
  const alarms: CloudWatchAlarmLiveSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeAlarmsCommand({ NextToken: nextToken }))
    const pageItems = await Promise.all((output.MetricAlarms ?? []).map(async (alarm) => {
      const dimensions = Object.fromEntries(
        (alarm.Dimensions ?? [])
          .filter((dimension): dimension is { Name: string; Value: string } => Boolean(dimension.Name && dimension.Value))
          .map((dimension) => [dimension.Name, dimension.Value])
          .sort(([left], [right]) => left.localeCompare(right))
      )
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
        alarmArn: alarm.AlarmArn ?? '',
        alarmName: alarm.AlarmName ?? '-',
        comparisonOperator: alarm.ComparisonOperator ?? '-',
        evaluationPeriods: alarm.EvaluationPeriods ?? 0,
        threshold: typeof alarm.Threshold === 'number' ? alarm.Threshold : 0,
        namespace: alarm.Namespace ?? '',
        metricName: alarm.MetricName ?? '',
        dimensions,
        tags
      }
    }))

    alarms.push(...pageItems)
    nextToken = output.NextToken
  } while (nextToken)

  return alarms
}

async function listRoute53RecordSummaries(connection: AwsConnection): Promise<Route53RecordLiveSummary[]> {
  const zones = await listRoute53HostedZones(connection)
  const recordsByZone = await Promise.all(
    zones.map(async (zone) => {
      const records = await listRoute53Records(connection, zone.id)
      return records.map((record) => ({
        ...record,
        hostedZoneId: zone.id
      }))
    })
  )
  return recordsByZone.flat()
}

function flattenLoadBalancerListeners(workspaces: LoadBalancerWorkspace[]): LoadBalancerListenerLiveSummary[] {
  return workspaces.flatMap((workspace) =>
    workspace.listeners.map((listener) => ({
      ...listener,
      loadBalancerArn: workspace.summary.arn,
      loadBalancerName: workspace.summary.name
    }))
  )
}

function flattenLoadBalancerTargetGroups(workspaces: LoadBalancerWorkspace[]): LoadBalancerTargetGroupLiveSummary[] {
  return workspaces.flatMap((workspace) =>
    workspace.targetGroups.map((targetGroup) => ({
      ...targetGroup,
      loadBalancerArn: workspace.summary.arn,
      loadBalancerName: workspace.summary.name
    }))
  )
}

async function listEcsTaskDefinitionSummaries(
  connection: AwsConnection,
  inventory: TerraformResourceInventoryItem[]
): Promise<EcsTaskDefinitionReference[]> {
  const client = new ECSClient(awsClientConfig(connection))
  const references = unique(
    inventory
      .filter((item) => item.type === 'aws_ecs_task_definition' && item.mode === 'managed')
      .map((item) => normalizeTaskDefinitionRef(extractArn(item.values) || str(item.values.arn_without_revision) || str(item.values.family)))
      .filter(Boolean)
  )

  const definitions = await Promise.all(references.map(async (reference) => {
    try {
      const output = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: reference }))
      const definition = output.taskDefinition
      if (!definition) return null
      return {
        taskDefinitionArn: definition.taskDefinitionArn ?? reference,
        family: definition.family ?? normalizeTaskDefinitionFamily(reference),
        revision: definition.revision ?? normalizeTaskDefinitionRevision(reference),
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
      } satisfies EcsTaskDefinitionReference
    } catch {
      return null
    }
  }))

  return definitions.filter((item): item is EcsTaskDefinitionReference => Boolean(item))
}

function flattenRouteTableAssociations(routeTables: RouteTableSummary[]): RouteTableAssociationSummary[] {
  return routeTables.flatMap((routeTable) => {
    const subnetAssociations = routeTable.associatedSubnets.map((subnetId) => ({
      associationId: `${routeTable.routeTableId}:${subnetId}`,
      routeTableId: routeTable.routeTableId,
      subnetId,
      gatewayId: '',
      isMain: false
    }))
    if (!routeTable.isMain) return subnetAssociations
    return [{
      associationId: `${routeTable.routeTableId}:main`,
      routeTableId: routeTable.routeTableId,
      subnetId: '',
      gatewayId: '',
      isMain: true
    }, ...subnetAssociations]
  })
}

function flattenSecurityGroupRules(groups: SecurityGroupSummary[]): SecurityGroupRuleSummary[] {
  return groups.flatMap((group) => [
    ...(group.inboundRules ?? []).map((rule) => ({
      securityGroupId: group.groupId,
      direction: 'ingress' as const,
      protocol: rule.protocol,
      fromPort: rule.portRange === 'All' ? -1 : Number(rule.portRange.split('-')[0] ?? '-1'),
      toPort: rule.portRange === 'All'
        ? -1
        : Number((rule.portRange.includes('-') ? rule.portRange.split('-')[1] : rule.portRange) ?? '-1'),
      source: rule.source,
      description: rule.description
    })),
    ...(group.outboundRules ?? []).map((rule) => ({
      securityGroupId: group.groupId,
      direction: 'egress' as const,
      protocol: rule.protocol,
      fromPort: rule.portRange === 'All' ? -1 : Number(rule.portRange.split('-')[0] ?? '-1'),
      toPort: rule.portRange === 'All'
        ? -1
        : Number((rule.portRange.includes('-') ? rule.portRange.split('-')[1] : rule.portRange) ?? '-1'),
      source: rule.destination,
      description: rule.description
    }))
  ])
}

async function listEksNodegroupSummaries(connection: AwsConnection, clusters: EksClusterSummary[]): Promise<EksNodegroupLiveSummary[]> {
  const nodegroups = await Promise.all(clusters.map(async (cluster) => {
    const items = await listEksNodegroups(connection, cluster.name)
    return items.map((item) => ({
      clusterName: cluster.name,
      nodegroupName: item.name,
      status: item.status,
      minSize: typeof item.min === 'number' ? item.min : Number(item.min) || 0,
      desiredSize: typeof item.desired === 'number' ? item.desired : Number(item.desired) || 0,
      maxSize: typeof item.max === 'number' ? item.max : Number(item.max) || 0,
      instanceTypes: item.instanceTypes === '-' ? [] : item.instanceTypes.split(',').map((value) => value.trim()).filter(Boolean).sort()
    }))
  }))
  return nodegroups.flat()
}

function sanitizeSnapshot(snapshot: TerraformDriftSnapshot): TerraformDriftSnapshot {
  const items = snapshot.items.filter((item) => item.status !== 'unmanaged_in_aws')
  return {
    ...snapshot,
    items,
    summary: buildSummary(items, snapshot.summary.supportedResourceTypes.length > 0 ? snapshot.summary.supportedResourceTypes : supportedCoverage(), snapshot.scannedAt)
  }
}

function sanitizeStoredContext(context: StoredDriftContext): StoredDriftContext {
  return {
    ...context,
    snapshots: context.snapshots.map((snapshot) => sanitizeSnapshot(snapshot))
  }
}

function coverageItem(resourceType: string, verifiedChecks: string[], inferredChecks: string[], notes: string[]): TerraformDriftCoverageItem {
  return { resourceType, coverage: 'partial', verifiedChecks, inferredChecks, notes }
}

function buildNextStepForDiff(resource: TerraformResourceInventoryItem, differences: TerraformDriftDifference[]): string {
  if (differences.some((difference) => difference.kind === 'tag')) {
    return `Review ${resource.address} with state show, reconcile the mismatched tags in configuration or AWS, then run a manual drift re-scan.`
  }
  return `Review ${resource.address} with state show, decide whether configuration or AWS is the source of truth for the changed fields, then re-scan after reconciliation.`
}

function buildSupportedItems<TLive>(
  project: TerraformProject,
  connection: AwsConnection,
  type: SupportedResourceType,
  inventory: TerraformResourceInventoryItem[],
  liveRaw: TLive[],
  handler: SupportedHandler<TLive>
): TerraformDriftItem[] {
  const terraformResources = inventory
    .filter((item) => item.type === type && item.mode === 'managed')
    .map((resource) => {
      const comparable = handler.normalizeTerraform(resource, connection)
      return comparable ? { resource, comparable } : null
    })
    .filter((entry): entry is NormalizedTerraformResource => Boolean(entry))

  const liveResources = liveRaw.map((item) => handler.normalizeLive(item, connection))
  const matchedLiveKeys = new Set<string>()
  const items: TerraformDriftItem[] = []

  for (const terraformResource of terraformResources) {
    const match = findLiveMatch(terraformResource.comparable, liveResources, handler.identityKeys)
    if (!match) {
      items.push({
        terraformAddress: terraformResource.resource.address,
        resourceType: terraformResource.resource.type,
        logicalName: terraformResource.comparable.logicalName || terraformResource.resource.name,
        cloudIdentifier: terraformResource.comparable.cloudIdentifier,
        region: terraformResource.comparable.region,
        status: 'missing_in_aws',
        assessment: 'verified',
        explanation: 'Terraform state references this resource, but no matching live AWS resource was found in the scanned inventory.',
        suggestedNextStep: `Run state show for ${terraformResource.resource.address}, verify whether the resource was deleted or renamed, and decide whether to recreate it or remove the stale state entry.`,
        consoleUrl: terraformResource.comparable.consoleUrl,
        terminalCommand: makeStateShowCommand(project, terraformResource.resource.address),
        differences: [],
        evidence: [
          `State address ${terraformResource.resource.address} was scanned.`,
          `No live ${type} matched by ${handler.identityKeys.join(' or ')} in region ${connection.region}.`
        ],
        relatedTerraformAddresses: []
      })
      continue
    }

    matchedLiveKeys.add(stableComparableKey(match))
    const differences = [...compareAttributes(terraformResource.comparable, match), ...compareTags(terraformResource.comparable, match)]
    items.push({
      terraformAddress: terraformResource.resource.address,
      resourceType: terraformResource.resource.type,
      logicalName: terraformResource.comparable.logicalName || match.logicalName || terraformResource.resource.name,
      cloudIdentifier: match.cloudIdentifier || terraformResource.comparable.cloudIdentifier,
      region: match.region || terraformResource.comparable.region,
      status: differences.length > 0 ? 'drifted' : 'in_sync',
      assessment: 'verified',
      explanation: differences.length > 0
        ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} between Terraform and the live AWS resource.`
        : 'Terraform state and the live AWS resource match on the tracked identifiers and supported drift checks.',
      suggestedNextStep: differences.length > 0
        ? buildNextStepForDiff(terraformResource.resource, differences)
        : 'No action is required unless you want a deeper verification with terraform plan.',
      consoleUrl: match.consoleUrl || terraformResource.comparable.consoleUrl,
      terminalCommand: makeStateShowCommand(project, terraformResource.resource.address),
      differences,
      evidence: [
        `Matched live ${type} by ${handler.identityKeys.join(' or ')}.`,
        ...differences.slice(0, 5).map((difference) => `${difference.label}: terraform=${difference.terraformValue || '-'} aws=${difference.liveValue || '-'}`)
      ],
      relatedTerraformAddresses: []
    })
  }

  return items
}

function buildUnsupportedItems(project: TerraformProject, inventory: TerraformResourceInventoryItem[]): TerraformDriftItem[] {
  return inventory
    .filter((item) => item.mode === 'managed' && !(item.type in SUPPORTED_HANDLERS))
    .map((item) => ({
      terraformAddress: item.address,
      resourceType: item.type,
      logicalName: item.name,
      cloudIdentifier: str(item.values.id) || extractArn(item.values),
      region: extractRegion(item.values),
      status: 'unsupported' as const,
      assessment: 'unsupported' as const,
      explanation: 'This Terraform resource type is present in state, but this app does not yet verify live reconciliation for it.',
      suggestedNextStep: `Use plan or state show for ${item.address}. This app keeps unsupported types explicit so you can track the remaining coverage gap.`,
      consoleUrl: '',
      terminalCommand: makeStateShowCommand(project, item.address),
      differences: [],
      evidence: ['Unsupported types remain visible instead of being excluded from the drift report.'],
      relatedTerraformAddresses: []
    }))
}

function normalizeAwsInstance(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  return {
    resourceType: item.type,
    logicalName: tags.Name || str(values.instance_state) || item.name,
    cloudIdentifier: str(values.id) || extractArn(values),
    region,
    consoleUrl: consoleUrl(`ec2/v2/home?region=${region}#InstanceDetails:instanceId=${str(values.id)}`, region),
    attributes: { instance_type: str(values.instance_type), subnet_id: str(values.subnet_id), vpc_id: str(values.vpc_id) },
    tags
  }
}

function normalizeAwsSecurityGroup(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  return {
    resourceType: item.type,
    logicalName: str(values.name) || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`ec2/v2/home?region=${region}#SecurityGroup:groupId=${str(values.id)}`, region),
      attributes: {
        name: str(values.name),
        vpc_id: str(values.vpc_id),
        description: str(values.description)
      },
      tags: terraformTags(values)
    }
  }

function normalizeAwsVpc(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  return {
    resourceType: item.type,
    logicalName: tags.Name || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#VpcDetails:VpcId=${str(values.id)}`, region),
    attributes: { cidr_block: str(values.cidr_block), is_default: bool(values.default) ?? false },
    tags
  }
}

function normalizeAwsSubnet(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  return {
    resourceType: item.type,
    logicalName: tags.Name || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#SubnetDetails:subnetId=${str(values.id)}`, region),
    attributes: {
      vpc_id: str(values.vpc_id),
      cidr_block: str(values.cidr_block),
      availability_zone: str(values.availability_zone),
      map_public_ip_on_launch: bool(values.map_public_ip_on_launch) ?? false
    },
    tags
  }
}

function normalizeAwsRouteTable(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  return {
    resourceType: item.type,
    logicalName: tags.Name || item.name,
      cloudIdentifier: str(values.id),
      region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#RouteTableDetails:routeTableId=${str(values.id)}`, region),
      attributes: { vpc_id: str(values.vpc_id) },
      tags
    }
  }

function normalizeAwsInternetGateway(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  const attachment = firstObject(values.attachment)
    return {
      resourceType: item.type,
      logicalName: tags.Name || item.name,
      cloudIdentifier: str(values.id),
      region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#InternetGatewayDetails:internetGatewayId=${str(values.id)}`, region),
      attributes: { vpc_id: str(values.vpc_id) || str(attachment.vpc_id) },
      tags
    }
  }

function normalizeAwsNatGateway(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  return {
    resourceType: item.type,
    logicalName: tags.Name || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`vpc/home?region=${region}#NatGatewayDetails:natGatewayId=${str(values.id)}`, region),
      attributes: {
        subnet_id: str(values.subnet_id),
        vpc_id: str(values.vpc_id),
        connectivity_type: str(values.connectivity_type)
      },
      tags
    }
  }

function normalizeAwsTransitGateway(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  const options = firstObject(values.options)
  return {
    resourceType: item.type,
    logicalName: tags.Name || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#TransitGatewayDetails:transitGatewayId=${str(values.id)}`, region),
    attributes: { amazon_side_asn: str(options.amazon_side_asn), state: str(values.state) },
    tags
  }
}

function normalizeAwsNetworkInterface(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const tags = terraformTags(values)
  return {
    resourceType: item.type,
    logicalName: tags.Name || str(values.private_ip) || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`ec2/v2/home?region=${region}#NIC:networkInterfaceId=${str(values.id)}`, region),
    attributes: {
      vpc_id: str(values.vpc_id),
      subnet_id: str(values.subnet_id),
      interface_type: str(values.interface_type),
      status: str(values.status),
      attached_instance_id: str(firstObject(values.attachment).instance),
      security_group_count: count(values.security_groups)
    },
    tags
  }
}

function normalizeAwsS3Bucket(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource {
  const values = item.values
  const bucket = str(values.bucket) || str(values.id)
  const region = extractRegion(values) || connection.region
  return {
    resourceType: item.type,
    logicalName: bucket || item.name,
    cloudIdentifier: extractArn(values) || bucket,
    region,
    consoleUrl: consoleUrl(`s3/buckets/${bucket}?region=${region}&tab=objects`, region),
    attributes: { bucket, region },
    tags: terraformTags(values)
  }
}

function normalizeAwsLambda(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const functionName = str(values.function_name)
  return {
    resourceType: item.type,
    logicalName: functionName || item.name,
    cloudIdentifier: extractArn(values) || functionName,
    region,
    consoleUrl: consoleUrl(`lambda/home?region=${region}#/functions/${encodeURIComponent(functionName)}?tab=code`, region),
    attributes: { function_name: functionName, runtime: str(values.runtime), handler: str(values.handler), memory: num(values.memory_size) ?? 0 },
    tags: terraformTags(values)
  }
}

function normalizeAwsDbInstance(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const identifier = str(values.identifier) || str(values.id) || str(values.db_instance_identifier)
  return {
    resourceType: item.type,
    logicalName: identifier || item.name,
    cloudIdentifier: extractArn(values) || identifier,
    region,
    consoleUrl: consoleUrl(`rds/home?region=${region}#database:id=${identifier};is-cluster=false`, region),
    attributes: {
      db_instance_identifier: identifier,
      engine: str(values.engine),
      db_instance_class: str(values.instance_class),
      allocated_storage: num(values.allocated_storage) ?? 0,
      multi_az: bool(values.multi_az) ?? false
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsRdsCluster(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const identifier = str(values.cluster_identifier) || str(values.id)
  return {
    resourceType: item.type,
    logicalName: identifier || item.name,
    cloudIdentifier: extractArn(values) || identifier,
    region,
    consoleUrl: consoleUrl(`rds/home?region=${region}#database:id=${identifier};is-cluster=true`, region),
    attributes: {
      cluster_identifier: identifier,
      engine: str(values.engine),
      engine_version: str(values.engine_version),
      port: num(values.port) ?? 0,
      storage_encrypted: bool(values.storage_encrypted) ?? false,
      multi_az: list(values.availability_zones).length > 1
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsEksCluster(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const vpcConfig = firstObject(values.vpc_config)
  return {
    resourceType: item.type,
    logicalName: str(values.name) || item.name,
    cloudIdentifier: extractArn(values) || str(values.name),
    region,
    consoleUrl: consoleUrl(`eks/home?region=${region}#/clusters/${encodeURIComponent(str(values.name))}`, region),
    attributes: {
      name: str(values.name),
      version: str(values.version),
      role_arn: str(values.role_arn),
      vpc_id: str(vpcConfig.vpc_id),
      subnet_count: list(vpcConfig.subnet_ids).length,
      security_group_count: list(vpcConfig.security_group_ids).length
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsEcrRepository(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const name = str(values.name)
  return {
    resourceType: item.type,
    logicalName: name || item.name,
    cloudIdentifier: extractArn(values) || str(values.repository_url) || name,
    region,
    consoleUrl: consoleUrl(`ecr/repositories/private/${encodeURIComponent(name)}?region=${region}`, region),
    attributes: {
      repository_name: name,
      image_tag_mutability: str(values.image_tag_mutability),
      scan_on_push: bool((values.image_scanning_configuration as Record<string, unknown> | undefined)?.scan_on_push) ?? false
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsEcsCluster(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const name = str(values.name)
  return {
    resourceType: item.type,
    logicalName: name || item.name,
    cloudIdentifier: extractArn(values) || name,
    region,
    consoleUrl: consoleUrl(`ecs/v2/clusters/${encodeURIComponent(name)}/services?region=${region}`, region),
    attributes: { cluster_name: name },
    tags: terraformTags(values)
  }
}

function normalizeAwsEcsClusterCapacityProviders(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const clusterName = str(values.cluster_name)
  return {
    resourceType: item.type,
    logicalName: clusterName || item.name,
    cloudIdentifier: clusterName,
    region,
    consoleUrl: consoleUrl(`ecs/v2/clusters/${encodeURIComponent(clusterName)}/services?region=${region}`, region),
    attributes: {
      cluster_name: clusterName,
      capacity_providers: list(values.capacity_providers).sort().join(','),
      default_strategy: canonicalCapacityProviderStrategy(values.default_capacity_provider_strategy).join(',')
    },
    tags: {}
  }
}

function normalizeAwsEksNodeGroup(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const clusterName = str(values.cluster_name)
  const nodeGroupName = str(values.node_group_name) || str(values.nodegroup_name)
  const scaling = firstObject(values.scaling_config)
  return {
    resourceType: item.type,
    logicalName: `${clusterName}/${nodeGroupName}`,
    cloudIdentifier: `${clusterName}:${nodeGroupName}`,
    region,
    consoleUrl: consoleUrl(`eks/home?region=${region}#/clusters/${encodeURIComponent(clusterName)}/nodegroups/${encodeURIComponent(nodeGroupName)}`, region),
    attributes: {
      cluster_name: clusterName,
      nodegroup_name: nodeGroupName,
      min_size: num(scaling.min_size) ?? 0,
      desired_size: num(scaling.desired_size) ?? 0,
      max_size: num(scaling.max_size) ?? 0,
      instance_types: list(values.instance_types).sort().join(',')
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsIamRole(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const name = str(values.name)
  return {
    resourceType: item.type,
    logicalName: name || item.name,
    cloudIdentifier: extractArn(values) || name,
    region: connection.region,
    consoleUrl: consoleUrl(`iamv2/home#/roles/details/${encodeURIComponent(name)}`, connection.region),
    attributes: { role_name: name, max_session_duration: num(values.max_session_duration) ?? 3600 },
    tags: {}
  }
}

function normalizeAwsIamRolePolicyAttachment(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const roleName = str(values.role)
  const policyArn = str(values.policy_arn)
  return {
    resourceType: item.type,
    logicalName: `${roleName}:${policyArn}`,
    cloudIdentifier: `${roleName}:${policyArn}`,
    region: connection.region,
    consoleUrl: consoleUrl(`iamv2/home#/roles/details/${encodeURIComponent(roleName)}`, connection.region),
    attributes: { role_name: roleName, policy_arn: policyArn },
    tags: {}
  }
}

function normalizeAwsElasticIp(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  return {
    resourceType: item.type,
    logicalName: str(values.public_ip) || item.name,
    cloudIdentifier: str(values.allocation_id) || str(values.id),
    region,
    consoleUrl: consoleUrl(`ec2/v2/home?region=${region}#Addresses:search=${encodeURIComponent(str(values.allocation_id) || str(values.public_ip))}`, region),
    attributes: {
      allocation_id: str(values.allocation_id) || str(values.id),
      public_ip: str(values.public_ip),
      domain: str(values.domain),
      network_interface_id: str(values.network_interface),
      instance_id: str(values.instance)
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsDbSubnetGroup(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const name = str(values.name)
  return {
    resourceType: item.type,
    logicalName: name || item.name,
    cloudIdentifier: str(values.arn) || name,
    region,
    consoleUrl: consoleUrl(`rds/home?region=${region}#subnet-group:id=${encodeURIComponent(name)}`, region),
    attributes: {
      name,
      description: str(values.description),
      subnet_count: list(values.subnet_ids).length
    },
    tags: {}
  }
}

function normalizeAwsRdsClusterInstance(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const identifier = str(values.identifier) || str(values.id)
  return {
    resourceType: item.type,
    logicalName: identifier || item.name,
    cloudIdentifier: extractArn(values) || identifier,
    region,
    consoleUrl: consoleUrl(`rds/home?region=${region}#database:id=${identifier};is-cluster=false`, region),
    attributes: {
      db_instance_identifier: identifier,
      cluster_identifier: str(values.cluster_identifier),
      engine: str(values.engine),
      db_instance_class: str(values.instance_class),
      availability_zone: str(values.availability_zone)
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsRouteTableAssociation(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const subnetId = str(values.subnet_id)
  const gatewayId = str(values.gateway_id)
  const routeTableId = str(values.route_table_id)
  const logicalKey = `${routeTableId}|${subnetId || gatewayId || (bool(values.main) ? 'main' : '')}`
  return {
    resourceType: item.type,
    logicalName: logicalKey,
    cloudIdentifier: logicalKey,
    region,
    consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#RouteTableDetails:routeTableId=${routeTableId}`, region),
    attributes: {
      route_table_id: routeTableId,
      subnet_id: subnetId,
      gateway_id: gatewayId,
      is_main: bool(values.main) ?? false
    },
    tags: {}
  }
}

function normalizeAwsSecurityGroupRule(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const direction = str(values.type) === 'egress' ? 'egress' : 'ingress'
  const groupId = str(values.security_group_id)
  const protocol = str(values.protocol)
  const fromPort = num(values.from_port) ?? -1
  const toPort = num(values.to_port) ?? -1
  const source = normalizeRuleSource(values, direction)
  const key = canonicalSecurityGroupRuleKey(groupId, direction, protocol, fromPort, toPort, source)
  return {
    resourceType: item.type,
    logicalName: key,
    cloudIdentifier: key,
    region,
    consoleUrl: consoleUrl(`ec2/v2/home?region=${region}#SecurityGroup:groupId=${groupId}`, region),
    attributes: {
      security_group_id: groupId,
      direction,
      protocol: normalizeRuleProtocol(protocol),
      from_port: fromPort,
      to_port: toPort,
      source
    },
    tags: {}
  }
}

function normalizeAwsLoadBalancer(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const name = str(values.name)
  const arn = extractArn(values) || str(values.id)
  return {
    resourceType: item.type,
    logicalName: name || item.name,
    cloudIdentifier: arn || name,
    region,
    consoleUrl: consoleUrl(`ec2/home?region=${region}#LoadBalancers:search=${encodeURIComponent(name || arn)}`, region),
    attributes: {
      name,
      dns_name: str(values.dns_name),
      load_balancer_type: str(values.load_balancer_type) || str(values.type),
      scheme: str(values.internal) === 'true' ? 'internal' : str(values.internal) === 'false' ? 'internet-facing' : str(values.scheme),
      vpc_id: str(values.vpc_id),
      security_groups: list(values.security_groups).sort().join(',')
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsEcsService(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const clusterRef = normalizeEcsClusterRef(str(values.cluster))
  const serviceName = str(values.name)
  return {
    resourceType: item.type,
    logicalName: `${clusterRef}|${serviceName}`,
    cloudIdentifier: `${clusterRef}|${serviceName}`,
    region,
    consoleUrl: consoleUrl(`ecs/v2/clusters/${encodeURIComponent(clusterRef)}/services/${encodeURIComponent(serviceName)}?region=${region}`, region),
    attributes: {
      cluster: clusterRef,
      service_name: serviceName,
      desired_count: num(values.desired_count) ?? 0,
      launch_type: str(values.launch_type),
      task_definition: normalizeTaskDefinitionRef(str(values.task_definition))
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsCloudWatchMetricAlarm(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const alarmName = str(values.alarm_name)
  return {
    resourceType: item.type,
    logicalName: alarmName || item.name,
    cloudIdentifier: extractArn(values) || alarmName,
    region,
    consoleUrl: consoleUrl(`cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`, region),
    attributes: {
      alarm_name: alarmName,
      comparison_operator: str(values.comparison_operator),
      evaluation_periods: num(values.evaluation_periods) ?? 0,
      threshold: num(values.threshold) ?? 0,
      namespace: str(values.namespace),
      metric_name: str(values.metric_name),
      dimensions: encodeStringMap(normalizeStringMap(values.dimensions))
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsRoute53Record(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const hostedZoneId = str(values.zone_id)
  const name = str(values.name)
  const type = str(values.type)
  const alias = firstObject(values.alias)
  return {
    resourceType: item.type,
    logicalName: route53RecordKey(hostedZoneId, name, type, str(values.set_identifier)),
    cloudIdentifier: route53RecordKey(hostedZoneId, name, type, str(values.set_identifier)),
    region: connection.region,
    consoleUrl: consoleUrl(`route53/v2/hostedzones#ListRecordSets/${hostedZoneId}`, ''),
    attributes: {
      hosted_zone_id: hostedZoneId,
      name: normalizeOptionalDnsName(name),
      type: type.toUpperCase(),
      ttl: num(values.ttl) ?? 0,
      values: list(values.records).sort().join(','),
      alias_dns_name: normalizeOptionalDnsName(str(alias.name)),
      alias_hosted_zone_id: str(alias.zone_id),
      evaluate_target_health: bool(alias.evaluate_target_health) ?? false,
      routing_policy: inferTerraformRoute53RoutingPolicy(values)
    },
    tags: {}
  }
}

function normalizeAwsCloudWatchLogGroup(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const name = str(values.name)
  return {
    resourceType: item.type,
    logicalName: name || item.name,
    cloudIdentifier: extractArn(values) || name,
    region,
    consoleUrl: consoleUrl(`cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(name)}`, region),
    attributes: {
      name,
      retention_in_days: num(values.retention_in_days) ?? 0,
      log_class: str(values.log_group_class) || 'STANDARD'
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsEcsTaskDefinition(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  const family = str(values.family)
  const definitions = normalizeContainerDefinitions(values.container_definitions)
  const reference = normalizeTaskDefinitionRef(extractArn(values) || str(values.arn_without_revision) || family)
  return {
    resourceType: item.type,
    logicalName: family || item.name,
    cloudIdentifier: reference || family,
    region,
    consoleUrl: consoleUrl(`ecs/v2/task-definition/${encodeURIComponent(family)}?region=${region}`, region),
    attributes: {
      family,
      network_mode: str(values.network_mode),
      execution_role_arn: str(values.execution_role_arn),
      task_role_arn: str(values.task_role_arn),
      container_count: definitions.length,
      log_groups: extractContainerLogGroups(definitions).join(',')
    },
    tags: terraformTags(values)
  }
}

function normalizeAwsLbListener(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const arn = extractArn(values) || str(values.id)
  const loadBalancerArn = str(values.load_balancer_arn)
  return {
    resourceType: item.type,
    logicalName: arn || `${loadBalancerArn}|${num(values.port) ?? 0}|${str(values.protocol)}`,
    cloudIdentifier: arn || `${loadBalancerArn}|${num(values.port) ?? 0}|${str(values.protocol)}`,
    region,
    consoleUrl: consoleUrl(`ec2/home?region=${region}#LoadBalancers:search=${encodeURIComponent(loadBalancerArn)}`, region),
    attributes: {
      load_balancer_arn: loadBalancerArn,
      port: num(values.port) ?? 0,
      protocol: str(values.protocol),
      ssl_policy: str(values.ssl_policy),
      certificates: list(values.certificate_arn).join(','),
      default_actions: normalizeListenerActions(values.default_action).join(',')
    },
    tags: {}
  }
}

function normalizeAwsLbTargetGroup(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const arn = extractArn(values) || str(values.id)
  const healthCheck = firstObject(values.health_check)
  return {
    resourceType: item.type,
    logicalName: str(values.name) || item.name,
    cloudIdentifier: arn || str(values.name),
    region,
    consoleUrl: consoleUrl(`ec2/home?region=${region}#TargetGroups:search=${encodeURIComponent(str(values.name) || arn)}`, region),
    attributes: {
      name: str(values.name),
      protocol: str(values.protocol),
      port: num(values.port) ?? 0,
      target_type: str(values.target_type),
      vpc_id: str(values.vpc_id),
      health_check_protocol: str(healthCheck.protocol),
      health_check_port: str(healthCheck.port),
      health_check_path: str(healthCheck.path)
    },
    tags: terraformTags(values)
  }
}

const SUPPORTED_HANDLERS: { [K in SupportedResourceType]: SupportedHandler<LiveInventory[K][number]> } = {
  aws_instance: {
    normalizeTerraform: normalizeAwsInstance,
    normalizeLive: (instance, connection) => ({
      resourceType: 'aws_instance',
      logicalName: instance.name || instance.instanceId,
      cloudIdentifier: instance.instanceId,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/v2/home?region=${connection.region}#InstanceDetails:instanceId=${instance.instanceId}`, connection.region),
      attributes: { instance_type: instance.type, subnet_id: instance.subnetId, vpc_id: instance.vpcId },
      tags: instance.tags ?? {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['instance type', 'subnet', 'VPC', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: ['Only selected config-vs-live fields are verified, not every EC2 argument.']
  },
  aws_security_group: {
    normalizeTerraform: normalizeAwsSecurityGroup,
    normalizeLive: (group, connection) => ({
      resourceType: 'aws_security_group',
      logicalName: group.groupName,
      cloudIdentifier: group.groupId,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/v2/home?region=${connection.region}#SecurityGroup:groupId=${group.groupId}`, connection.region),
      attributes: { name: group.groupName, vpc_id: group.vpcId, description: group.description },
      tags: group.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['group name', 'description', 'VPC', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: ['Security group rules may be managed by separate Terraform resources, so this workspace does not verify rule counts here.']
  },
  aws_vpc: {
    normalizeTerraform: normalizeAwsVpc,
    normalizeLive: (vpc, connection) => ({
      resourceType: 'aws_vpc',
      logicalName: vpc.name !== '-' ? vpc.name : vpc.vpcId,
      cloudIdentifier: vpc.vpcId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#VpcDetails:VpcId=${vpc.vpcId}`, connection.region),
      attributes: { cidr_block: vpc.cidrBlock, is_default: vpc.isDefault },
      tags: vpc.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['CIDR block', 'default flag', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: []
  },
  aws_subnet: {
    normalizeTerraform: normalizeAwsSubnet,
    normalizeLive: (subnet, connection) => ({
      resourceType: 'aws_subnet',
      logicalName: subnet.name !== '-' ? subnet.name : subnet.subnetId,
      cloudIdentifier: subnet.subnetId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#SubnetDetails:subnetId=${subnet.subnetId}`, connection.region),
      attributes: { vpc_id: subnet.vpcId, cidr_block: subnet.cidrBlock, availability_zone: subnet.availabilityZone, map_public_ip_on_launch: subnet.mapPublicIpOnLaunch },
      tags: subnet.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['VPC', 'CIDR block', 'availability zone', 'public IP on launch flag', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: []
  },
  aws_route_table: {
    normalizeTerraform: normalizeAwsRouteTable,
    normalizeLive: (routeTable, connection) => ({
      resourceType: 'aws_route_table',
      logicalName: routeTable.name !== '-' ? routeTable.name : routeTable.routeTableId,
      cloudIdentifier: routeTable.routeTableId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#RouteTableDetails:routeTableId=${routeTable.routeTableId}`, connection.region),
      attributes: { vpc_id: routeTable.vpcId },
      tags: routeTable.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['VPC', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: ['Associations and route entries can be managed by separate Terraform resources or include AWS-managed defaults, so they are not verified here.']
  },
  aws_internet_gateway: {
    normalizeTerraform: normalizeAwsInternetGateway,
    normalizeLive: (gateway, connection) => ({
      resourceType: 'aws_internet_gateway',
      logicalName: gateway.name !== '-' ? gateway.name : gateway.igwId,
      cloudIdentifier: gateway.igwId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#InternetGatewayDetails:internetGatewayId=${gateway.igwId}`, connection.region),
      attributes: { vpc_id: gateway.attachedVpcId },
      tags: gateway.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['attached VPC', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: ['Attachment state is AWS-computed and is not treated as verified drift.']
  },
  aws_nat_gateway: {
    normalizeTerraform: normalizeAwsNatGateway,
    normalizeLive: (gateway, connection) => ({
      resourceType: 'aws_nat_gateway',
      logicalName: gateway.name !== '-' ? gateway.name : gateway.natGatewayId,
      cloudIdentifier: gateway.natGatewayId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpc/home?region=${connection.region}#NatGatewayDetails:natGatewayId=${gateway.natGatewayId}`, connection.region),
      attributes: { subnet_id: gateway.subnetId, vpc_id: gateway.vpcId, connectivity_type: gateway.connectivityType },
      tags: gateway.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['subnet', 'VPC', 'connectivity type', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: ['NAT gateway lifecycle state is AWS-computed and is not treated as verified drift.']
  },
  aws_ec2_transit_gateway: {
    normalizeTerraform: normalizeAwsTransitGateway,
    normalizeLive: (gateway, connection) => ({
      resourceType: 'aws_ec2_transit_gateway',
      logicalName: gateway.name !== '-' ? gateway.name : gateway.tgwId,
      cloudIdentifier: gateway.tgwId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#TransitGatewayDetails:transitGatewayId=${gateway.tgwId}`, connection.region),
      attributes: { amazon_side_asn: gateway.amazonSideAsn, state: gateway.state },
      tags: gateway.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['Amazon-side ASN', 'state', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: []
  },
  aws_network_interface: {
    normalizeTerraform: normalizeAwsNetworkInterface,
    normalizeLive: (networkInterface, connection) => ({
      resourceType: 'aws_network_interface',
      logicalName: networkInterface.tags.Name || networkInterface.privateIp || networkInterface.networkInterfaceId,
      cloudIdentifier: networkInterface.networkInterfaceId,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/v2/home?region=${connection.region}#NIC:networkInterfaceId=${networkInterface.networkInterfaceId}`, connection.region),
      attributes: {
        vpc_id: networkInterface.vpcId,
        subnet_id: networkInterface.subnetId,
        interface_type: networkInterface.interfaceType,
        status: networkInterface.status,
        attached_instance_id: networkInterface.attachedInstanceId,
        security_group_count: networkInterface.securityGroups.length
      },
      tags: networkInterface.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['VPC', 'subnet', 'interface type', 'status', 'attachment', 'security group count', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: []
  },
  aws_s3_bucket: {
    normalizeTerraform: normalizeAwsS3Bucket,
    normalizeLive: (bucket) => ({
      resourceType: 'aws_s3_bucket',
      logicalName: bucket.name,
      cloudIdentifier: bucket.name,
      region: bucket.region,
      consoleUrl: consoleUrl(`s3/buckets/${bucket.name}?region=${bucket.region}&tab=objects`, bucket.region),
      attributes: { bucket: bucket.name, region: bucket.region },
      tags: bucket.tags ?? {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['bucket identity', 'bucket region', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: ['Bucket policy, encryption, and lifecycle posture remain separate from this drift workspace.']
  },
  aws_lambda_function: {
    normalizeTerraform: normalizeAwsLambda,
    normalizeLive: (lambda, connection) => ({
      resourceType: 'aws_lambda_function',
      logicalName: lambda.functionName,
      cloudIdentifier: lambda.functionName,
      region: connection.region,
      consoleUrl: consoleUrl(`lambda/home?region=${connection.region}#/functions/${encodeURIComponent(lambda.functionName)}?tab=code`, connection.region),
      attributes: { function_name: lambda.functionName, runtime: lambda.runtime, handler: lambda.handler, memory: typeof lambda.memory === 'number' ? lambda.memory : 0 },
      tags: lambda.tags ?? {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['function name', 'runtime', 'handler', 'memory', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name/tag heuristic'],
    notes: ['Timeout, environment, and role drift are not yet included.']
  },
  aws_db_instance: {
    normalizeTerraform: normalizeAwsDbInstance,
    normalizeLive: (db, connection) => ({
      resourceType: 'aws_db_instance',
      logicalName: db.dbInstanceIdentifier,
      cloudIdentifier: db.dbInstanceIdentifier,
      region: connection.region,
      consoleUrl: consoleUrl(`rds/home?region=${connection.region}#database:id=${db.dbInstanceIdentifier};is-cluster=false`, connection.region),
      attributes: {
        db_instance_identifier: db.dbInstanceIdentifier,
        engine: db.engine,
        db_instance_class: db.dbInstanceClass,
        allocated_storage: db.allocatedStorage,
        multi_az: db.multiAz
      },
      tags: db.tags ?? {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['identifier', 'engine', 'instance class', 'allocated storage', 'Multi-AZ flag'],
    inferredChecks: ['possible related Terraform addresses by name heuristic'],
    notes: ['RDS tag drift is only available when tags are present in the live summary.']
  },
  aws_rds_cluster: {
    normalizeTerraform: normalizeAwsRdsCluster,
    normalizeLive: (cluster, connection) => ({
      resourceType: 'aws_rds_cluster',
      logicalName: cluster.dbClusterIdentifier,
      cloudIdentifier: cluster.clusterArn || cluster.dbClusterIdentifier,
      region: connection.region,
      consoleUrl: consoleUrl(`rds/home?region=${connection.region}#database:id=${cluster.dbClusterIdentifier};is-cluster=true`, connection.region),
      attributes: {
        cluster_identifier: cluster.dbClusterIdentifier,
        engine: cluster.engine,
        engine_version: cluster.engineVersion,
        port: cluster.port ?? 0,
        storage_encrypted: cluster.storageEncrypted,
        multi_az: cluster.multiAz
      },
      tags: cluster.tags ?? {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['identifier', 'engine', 'engine version', 'port', 'storage encryption', 'Multi-AZ flag'],
    inferredChecks: ['possible related Terraform addresses by name heuristic'],
    notes: ['Cluster membership and parameter-group drift are not yet included.']
  },
  aws_ecr_repository: {
    normalizeTerraform: normalizeAwsEcrRepository,
    normalizeLive: (repo, connection) => ({
      resourceType: 'aws_ecr_repository',
      logicalName: repo.repositoryName,
      cloudIdentifier: repo.repositoryUri,
      region: connection.region,
      consoleUrl: consoleUrl(`ecr/repositories/private/${encodeURIComponent(repo.repositoryName)}?region=${connection.region}`, connection.region),
      attributes: { repository_name: repo.repositoryName, image_tag_mutability: repo.imageTagMutability, scan_on_push: repo.scanOnPush },
      tags: repo.tags ?? {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['repository name', 'image tag mutability', 'scan-on-push', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name heuristic'],
    notes: []
  },
  aws_eks_cluster: {
    normalizeTerraform: normalizeAwsEksCluster,
    normalizeLive: (cluster, connection) => ({
      resourceType: 'aws_eks_cluster',
      logicalName: cluster.name,
      cloudIdentifier: cluster.name,
      region: connection.region,
      consoleUrl: consoleUrl(`eks/home?region=${connection.region}#/clusters/${encodeURIComponent(cluster.name)}`, connection.region),
      attributes: { name: cluster.name, version: cluster.version, role_arn: cluster.roleArn },
      tags: cluster.tags ?? {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['cluster name', 'Kubernetes version', 'role ARN', 'tags'],
    inferredChecks: ['possible related Terraform addresses by name heuristic'],
    notes: ['Subnet and security-group counts are only verified when present in Terraform state.']
  },
  aws_ecs_cluster: {
    normalizeTerraform: normalizeAwsEcsCluster,
    normalizeLive: (cluster, connection) => ({
      resourceType: 'aws_ecs_cluster',
      logicalName: cluster.clusterName,
      cloudIdentifier: cluster.clusterArn,
      region: connection.region,
      consoleUrl: consoleUrl(`ecs/v2/clusters/${encodeURIComponent(cluster.clusterName)}/services?region=${connection.region}`, connection.region),
      attributes: { cluster_name: cluster.clusterName },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['cluster name'],
    inferredChecks: ['possible related Terraform addresses by name heuristic'],
    notes: ['Operational task and service counts are not treated as drift.']
  },
  aws_ecs_cluster_capacity_providers: {
    normalizeTerraform: normalizeAwsEcsClusterCapacityProviders,
    normalizeLive: (cluster, connection) => ({
      resourceType: 'aws_ecs_cluster_capacity_providers',
      logicalName: cluster.clusterName,
      cloudIdentifier: cluster.clusterName,
      region: connection.region,
      consoleUrl: consoleUrl(`ecs/v2/clusters/${encodeURIComponent(cluster.clusterName)}/services?region=${connection.region}`, connection.region),
      attributes: {
        cluster_name: cluster.clusterName,
        capacity_providers: cluster.capacityProviders.join(','),
        default_strategy: cluster.defaultStrategy.join(',')
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['cluster name', 'capacity providers', 'default strategy'],
    inferredChecks: [],
    notes: []
  },
  aws_eks_node_group: {
    normalizeTerraform: normalizeAwsEksNodeGroup,
    normalizeLive: (nodegroup, connection) => ({
      resourceType: 'aws_eks_node_group',
      logicalName: `${nodegroup.clusterName}/${nodegroup.nodegroupName}`,
      cloudIdentifier: `${nodegroup.clusterName}:${nodegroup.nodegroupName}`,
      region: connection.region,
      consoleUrl: consoleUrl(`eks/home?region=${connection.region}#/clusters/${encodeURIComponent(nodegroup.clusterName)}/nodegroups/${encodeURIComponent(nodegroup.nodegroupName)}`, connection.region),
      attributes: {
        cluster_name: nodegroup.clusterName,
        nodegroup_name: nodegroup.nodegroupName,
        min_size: nodegroup.minSize,
        desired_size: nodegroup.desiredSize,
        max_size: nodegroup.maxSize,
        instance_types: nodegroup.instanceTypes.join(',')
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['cluster', 'node group name', 'scaling config', 'instance types'],
    inferredChecks: [],
    notes: ['Node status and release version are not treated as drift.']
  },
  aws_iam_role: {
    normalizeTerraform: normalizeAwsIamRole,
    normalizeLive: (role, connection) => ({
      resourceType: 'aws_iam_role',
      logicalName: role.roleName,
      cloudIdentifier: role.arn,
      region: connection.region,
      consoleUrl: consoleUrl(`iamv2/home#/roles/details/${encodeURIComponent(role.roleName)}`, connection.region),
      attributes: { role_name: role.roleName, max_session_duration: role.maxSessionDuration },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['role name', 'max session duration'],
    inferredChecks: [],
    notes: ['Assume-role policy and tags are not yet verified here.']
  },
  aws_iam_role_policy_attachment: {
    normalizeTerraform: normalizeAwsIamRolePolicyAttachment,
    normalizeLive: (attachment, connection) => ({
      resourceType: 'aws_iam_role_policy_attachment',
      logicalName: `${attachment.roleName}:${attachment.policyArn}`,
      cloudIdentifier: `${attachment.roleName}:${attachment.policyArn}`,
      region: connection.region,
      consoleUrl: consoleUrl(`iamv2/home#/roles/details/${encodeURIComponent(attachment.roleName)}`, connection.region),
      attributes: { role_name: attachment.roleName, policy_arn: attachment.policyArn },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['role', 'attached policy ARN'],
    inferredChecks: [],
    notes: []
  },
  aws_eip: {
    normalizeTerraform: normalizeAwsElasticIp,
    normalizeLive: (address, connection) => ({
      resourceType: 'aws_eip',
      logicalName: address.publicIp,
      cloudIdentifier: address.allocationId,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/v2/home?region=${connection.region}#Addresses:search=${encodeURIComponent(address.allocationId || address.publicIp)}`, connection.region),
      attributes: {
        allocation_id: address.allocationId,
        public_ip: address.publicIp,
        domain: address.domain,
        network_interface_id: address.networkInterfaceId,
        instance_id: address.instanceId
      },
      tags: address.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['allocation ID', 'public IP', 'domain', 'attachment', 'tags'],
    inferredChecks: [],
    notes: []
  },
  aws_db_subnet_group: {
    normalizeTerraform: normalizeAwsDbSubnetGroup,
    normalizeLive: (group, connection) => ({
      resourceType: 'aws_db_subnet_group',
      logicalName: group.name,
      cloudIdentifier: group.name,
      region: connection.region,
      consoleUrl: consoleUrl(`rds/home?region=${connection.region}#subnet-group:id=${encodeURIComponent(group.name)}`, connection.region),
      attributes: { name: group.name, description: group.description, subnet_count: group.subnetCount },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['subnet group name', 'description', 'subnet count'],
    inferredChecks: [],
    notes: ['Subnet membership is reduced to count rather than exact subnet IDs.']
  },
  aws_rds_cluster_instance: {
    normalizeTerraform: normalizeAwsRdsClusterInstance,
    normalizeLive: (instance, connection) => ({
      resourceType: 'aws_rds_cluster_instance',
      logicalName: instance.dbInstanceIdentifier,
      cloudIdentifier: instance.dbInstanceIdentifier,
      region: connection.region,
      consoleUrl: consoleUrl(`rds/home?region=${connection.region}#database:id=${instance.dbInstanceIdentifier};is-cluster=false`, connection.region),
      attributes: {
        db_instance_identifier: instance.dbInstanceIdentifier,
        cluster_identifier: instance.dbClusterIdentifier,
        engine: instance.engine,
        db_instance_class: instance.dbInstanceClass,
        availability_zone: instance.availabilityZone
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['instance identifier', 'cluster identifier', 'engine', 'instance class', 'availability zone'],
    inferredChecks: [],
    notes: []
  },
  aws_route_table_association: {
    normalizeTerraform: normalizeAwsRouteTableAssociation,
    normalizeLive: (association, connection) => ({
      resourceType: 'aws_route_table_association',
      logicalName: `${association.routeTableId}|${association.subnetId || association.gatewayId || (association.isMain ? 'main' : '')}`,
      cloudIdentifier: `${association.routeTableId}|${association.subnetId || association.gatewayId || (association.isMain ? 'main' : '')}`,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#RouteTableDetails:routeTableId=${association.routeTableId}`, connection.region),
      attributes: {
        route_table_id: association.routeTableId,
        subnet_id: association.subnetId,
        gateway_id: association.gatewayId,
        is_main: association.isMain
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['route table association target'],
    inferredChecks: [],
    notes: ['Associations are matched by route table plus subnet/gateway target, not the opaque association ID.']
  },
  aws_security_group_rule: {
    normalizeTerraform: normalizeAwsSecurityGroupRule,
    normalizeLive: (rule, connection) => ({
      resourceType: 'aws_security_group_rule',
      logicalName: canonicalSecurityGroupRuleKey(rule.securityGroupId, rule.direction, rule.protocol, rule.fromPort, rule.toPort, rule.source),
      cloudIdentifier: canonicalSecurityGroupRuleKey(rule.securityGroupId, rule.direction, rule.protocol, rule.fromPort, rule.toPort, rule.source),
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/v2/home?region=${connection.region}#SecurityGroup:groupId=${rule.securityGroupId}`, connection.region),
      attributes: {
        security_group_id: rule.securityGroupId,
        direction: rule.direction,
        protocol: normalizeRuleProtocol(rule.protocol),
        from_port: rule.fromPort,
        to_port: rule.toPort,
        source: rule.source
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['group', 'direction', 'protocol', 'port range', 'source'],
    inferredChecks: [],
    notes: ['Rule descriptions are not verified because AWS summaries may collapse per-source descriptions.']
  },
  aws_lb: {
    normalizeTerraform: normalizeAwsLoadBalancer,
    normalizeLive: (loadBalancer, connection) => ({
      resourceType: 'aws_lb',
      logicalName: loadBalancer.name,
      cloudIdentifier: loadBalancer.arn,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/home?region=${connection.region}#LoadBalancers:search=${encodeURIComponent(loadBalancer.name)}`, connection.region),
      attributes: {
        name: loadBalancer.name,
        dns_name: loadBalancer.dnsName,
        load_balancer_type: loadBalancer.type,
        scheme: loadBalancer.scheme,
        vpc_id: loadBalancer.vpcId,
        security_groups: [...loadBalancer.securityGroups].sort().join(',')
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['load balancer name', 'DNS name', 'type', 'scheme', 'VPC', 'security groups'],
    inferredChecks: [],
    notes: ['Tags are not verified yet because the load balancer workspace summary does not currently hydrate them.']
  },
  aws_ecs_service: {
    normalizeTerraform: normalizeAwsEcsService,
    normalizeLive: (service, connection) => ({
      resourceType: 'aws_ecs_service',
      logicalName: `${service.clusterName}|${service.serviceName}`,
      cloudIdentifier: `${service.clusterName}|${service.serviceName}`,
      region: connection.region,
      consoleUrl: consoleUrl(`ecs/v2/clusters/${encodeURIComponent(service.clusterName)}/services/${encodeURIComponent(service.serviceName)}?region=${connection.region}`, connection.region),
      attributes: {
        cluster: service.clusterName,
        service_name: service.serviceName,
        desired_count: service.desiredCount,
        launch_type: service.launchType,
        task_definition: normalizeTaskDefinitionRef(service.taskDefinition)
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['cluster', 'service name', 'desired count', 'launch type', 'task definition'],
    inferredChecks: [],
    notes: ['Runtime task counts and rollout status are intentionally excluded because they are operational state, not config drift.']
  },
  aws_cloudwatch_metric_alarm: {
    normalizeTerraform: normalizeAwsCloudWatchMetricAlarm,
    normalizeLive: (alarm, connection) => ({
      resourceType: 'aws_cloudwatch_metric_alarm',
      logicalName: alarm.alarmName,
      cloudIdentifier: alarm.alarmArn || alarm.alarmName,
      region: connection.region,
      consoleUrl: consoleUrl(`cloudwatch/home?region=${connection.region}#alarmsV2:alarm/${encodeURIComponent(alarm.alarmName)}`, connection.region),
      attributes: {
        alarm_name: alarm.alarmName,
        comparison_operator: alarm.comparisonOperator,
        evaluation_periods: alarm.evaluationPeriods,
        threshold: alarm.threshold,
        namespace: alarm.namespace,
        metric_name: alarm.metricName,
        dimensions: encodeStringMap(alarm.dimensions)
      },
      tags: alarm.tags
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['alarm name', 'comparison operator', 'evaluation periods', 'threshold', 'metric namespace/name', 'dimensions', 'tags'],
    inferredChecks: [],
    notes: ['Composite alarms and alarm actions are out of scope for this drift pass.']
  },
  aws_route53_record: {
    normalizeTerraform: normalizeAwsRoute53Record,
    normalizeLive: (record) => ({
      resourceType: 'aws_route53_record',
      logicalName: route53RecordKey(record.hostedZoneId, record.name, record.type, record.setIdentifier),
      cloudIdentifier: route53RecordKey(record.hostedZoneId, record.name, record.type, record.setIdentifier),
      region: '',
      consoleUrl: consoleUrl(`route53/v2/hostedzones#ListRecordSets/${record.hostedZoneId}`, ''),
      attributes: {
        hosted_zone_id: record.hostedZoneId,
        name: normalizeOptionalDnsName(record.name),
        type: record.type.toUpperCase(),
        ttl: record.ttl ?? 0,
        values: [...record.values].sort().join(','),
        alias_dns_name: normalizeOptionalDnsName(record.aliasDnsName),
        alias_hosted_zone_id: record.aliasHostedZoneId,
        evaluate_target_health: record.evaluateTargetHealth,
        routing_policy: record.routingPolicy
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['hosted zone', 'record name', 'type', 'TTL/value set', 'alias target', 'routing policy'],
    inferredChecks: [],
    notes: ['Route 53 is global, so the record row uses the hosted zone console instead of a region-scoped console URL.']
  },
  aws_cloudwatch_log_group: {
    normalizeTerraform: normalizeAwsCloudWatchLogGroup,
    normalizeLive: (group, connection) => ({
      resourceType: 'aws_cloudwatch_log_group',
      logicalName: group.name,
      cloudIdentifier: group.arn || group.name,
      region: connection.region,
      consoleUrl: consoleUrl(`cloudwatch/home?region=${connection.region}#logsV2:log-groups/log-group/${encodeURIComponent(group.name)}`, connection.region),
      attributes: {
        name: group.name,
        retention_in_days: group.retentionInDays ?? 0,
        log_class: group.logClass
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['log group name', 'retention days', 'log class'],
    inferredChecks: [],
    notes: ['Tags and KMS settings are not verified here because the current log-group summary does not hydrate them.']
  },
  aws_ecs_task_definition: {
    normalizeTerraform: normalizeAwsEcsTaskDefinition,
    normalizeLive: (taskDefinition, connection) => ({
      resourceType: 'aws_ecs_task_definition',
      logicalName: taskDefinition.family,
      cloudIdentifier: normalizeTaskDefinitionRef(taskDefinition.taskDefinitionArn),
      region: connection.region,
      consoleUrl: consoleUrl(`ecs/v2/task-definition/${encodeURIComponent(taskDefinition.family)}?region=${connection.region}`, connection.region),
      attributes: {
        family: taskDefinition.family,
        network_mode: taskDefinition.networkMode,
        execution_role_arn: taskDefinition.executionRoleArn,
        task_role_arn: taskDefinition.taskRoleArn,
        container_count: taskDefinition.containerImages.length,
        log_groups: taskDefinition.containerImages.map((container) => container.logGroup).filter(Boolean).sort().join(',')
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['family', 'network mode', 'execution role', 'task role', 'container count', 'container log groups'],
    inferredChecks: [],
    notes: ['Container CPU/memory and image digests are not compared in this first pass.']
  },
  aws_lb_listener: {
    normalizeTerraform: normalizeAwsLbListener,
    normalizeLive: (listener, connection) => ({
      resourceType: 'aws_lb_listener',
      logicalName: listener.arn || `${listener.loadBalancerArn}|${listener.port}|${listener.protocol}`,
      cloudIdentifier: listener.arn || `${listener.loadBalancerArn}|${listener.port}|${listener.protocol}`,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/home?region=${connection.region}#LoadBalancers:search=${encodeURIComponent(listener.loadBalancerName)}`, connection.region),
      attributes: {
        load_balancer_arn: listener.loadBalancerArn,
        port: listener.port,
        protocol: listener.protocol,
        ssl_policy: listener.sslPolicy,
        certificates: [...listener.certificates].sort().join(','),
        default_actions: [...listener.defaultActions].sort().join(',')
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['listener ARN', 'load balancer binding', 'port', 'protocol', 'SSL policy', 'certificates', 'default actions'],
    inferredChecks: [],
    notes: ['Listener rules are tracked separately and are not compared here.']
  },
  aws_lb_target_group: {
    normalizeTerraform: normalizeAwsLbTargetGroup,
    normalizeLive: (targetGroup, connection) => ({
      resourceType: 'aws_lb_target_group',
      logicalName: targetGroup.name,
      cloudIdentifier: targetGroup.arn || targetGroup.name,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/home?region=${connection.region}#TargetGroups:search=${encodeURIComponent(targetGroup.name)}`, connection.region),
      attributes: {
        name: targetGroup.name,
        protocol: targetGroup.protocol,
        port: targetGroup.port,
        target_type: targetGroup.targetType,
        vpc_id: targetGroup.vpcId,
        health_check_protocol: targetGroup.healthCheck.protocol,
        health_check_port: targetGroup.healthCheck.port,
        health_check_path: targetGroup.healthCheck.path
      },
      tags: {}
    }),
    identityKeys: ['cloudIdentifier', 'logicalName'],
    verifiedChecks: ['target group ARN', 'name', 'protocol', 'port', 'target type', 'VPC', 'health check fields'],
    inferredChecks: [],
    notes: ['Registered target health is operational state and is not treated as config drift.']
  }
}

async function loadLiveInventory(connection: AwsConnection, inventory: TerraformResourceInventoryItem[]): Promise<LiveInventory> {
  const loadBalancerWorkspacesPromise = listLoadBalancerWorkspaces(connection)
  const [
    instances,
    securityGroups,
    vpcs,
    subnets,
    routeTables,
    internetGateways,
    natGateways,
    transitGateways,
    networkInterfaces,
    buckets,
    lambdas,
    rdsInstances,
    rdsClusters,
    ecrRepositories,
    eksClusters,
    ecsClusters,
    ecsClusterCapacityProviders,
    iamRoles,
    elasticIps,
    dbSubnetGroups,
    auroraClusterInstances,
    cloudWatchAlarms,
    route53Records,
    logGroups,
    loadBalancerWorkspaces
  ] = await Promise.all([
    listEc2Instances(connection),
    listSecurityGroups(connection),
    listVpcs(connection),
    listSubnets(connection),
    listRouteTables(connection),
    listInternetGateways(connection),
    listNatGateways(connection),
    listTransitGateways(connection),
    listNetworkInterfaces(connection),
    listBuckets(connection),
    listLambdaFunctions(connection),
    listDbInstances(connection),
    listDbClusters(connection),
    listEcrRepositories(connection),
    listEksClusters(connection),
    listEcsClusters(connection),
    listEcsClusterCapacityProviders(connection),
    listIamRoles(connection),
    listElasticIps(connection),
    listDbSubnetGroups(connection),
    listAuroraClusterInstances(connection),
    listCloudWatchAlarmSummaries(connection),
    listRoute53RecordSummaries(connection),
    listCloudWatchLogGroups(connection),
    loadBalancerWorkspacesPromise
  ])
  const [eksNodegroups, iamRolePolicyAttachments, ecsServices, ecsTaskDefinitions] = await Promise.all([
    listEksNodegroupSummaries(connection, eksClusters),
    listIamRolePolicyAttachments(connection, iamRoles),
    listEcsServiceSummaries(connection, ecsClusters),
    listEcsTaskDefinitionSummaries(connection, inventory)
  ])
  const loadBalancers = loadBalancerWorkspaces.map((workspace) => workspace.summary)
  const loadBalancerListeners = flattenLoadBalancerListeners(loadBalancerWorkspaces)
  const loadBalancerTargetGroups = flattenLoadBalancerTargetGroups(loadBalancerWorkspaces)
  const routeTableAssociations = flattenRouteTableAssociations(routeTables)
  const securityGroupRules = flattenSecurityGroupRules(securityGroups)

  return {
    aws_instance: instances,
    aws_security_group: securityGroups,
    aws_vpc: vpcs,
    aws_subnet: subnets,
    aws_route_table: routeTables,
    aws_internet_gateway: internetGateways,
    aws_nat_gateway: natGateways,
    aws_ec2_transit_gateway: transitGateways,
    aws_network_interface: networkInterfaces,
    aws_s3_bucket: buckets,
    aws_lambda_function: lambdas,
    aws_db_instance: rdsInstances,
    aws_rds_cluster: rdsClusters,
    aws_ecr_repository: ecrRepositories,
    aws_eks_cluster: eksClusters,
    aws_ecs_cluster: ecsClusters,
    aws_ecs_cluster_capacity_providers: ecsClusterCapacityProviders,
    aws_eks_node_group: eksNodegroups,
    aws_iam_role: iamRoles,
    aws_iam_role_policy_attachment: iamRolePolicyAttachments,
    aws_eip: elasticIps,
    aws_db_subnet_group: dbSubnetGroups,
    aws_rds_cluster_instance: auroraClusterInstances,
    aws_route_table_association: routeTableAssociations,
    aws_security_group_rule: securityGroupRules,
    aws_lb: loadBalancers,
    aws_ecs_service: ecsServices,
    aws_cloudwatch_metric_alarm: cloudWatchAlarms,
    aws_route53_record: route53Records,
    aws_cloudwatch_log_group: logGroups,
    aws_ecs_task_definition: ecsTaskDefinitions,
    aws_lb_listener: loadBalancerListeners,
    aws_lb_target_group: loadBalancerTargetGroups
  }
}

async function scanProjectDrift(
  profileName: string,
  projectId: string,
  connection: AwsConnection,
  trigger: TerraformDriftSnapshot['trigger']
): Promise<StoredDriftContext> {
  const project = getProject(profileName, projectId)
  const liveInventory = await loadLiveInventory(connection, project.inventory)
  const items = [
    ...buildSupportedItems(project, connection, 'aws_instance', project.inventory, liveInventory.aws_instance, SUPPORTED_HANDLERS.aws_instance),
    ...buildSupportedItems(project, connection, 'aws_security_group', project.inventory, liveInventory.aws_security_group, SUPPORTED_HANDLERS.aws_security_group),
    ...buildSupportedItems(project, connection, 'aws_vpc', project.inventory, liveInventory.aws_vpc, SUPPORTED_HANDLERS.aws_vpc),
    ...buildSupportedItems(project, connection, 'aws_subnet', project.inventory, liveInventory.aws_subnet, SUPPORTED_HANDLERS.aws_subnet),
    ...buildSupportedItems(project, connection, 'aws_route_table', project.inventory, liveInventory.aws_route_table, SUPPORTED_HANDLERS.aws_route_table),
    ...buildSupportedItems(project, connection, 'aws_internet_gateway', project.inventory, liveInventory.aws_internet_gateway, SUPPORTED_HANDLERS.aws_internet_gateway),
    ...buildSupportedItems(project, connection, 'aws_nat_gateway', project.inventory, liveInventory.aws_nat_gateway, SUPPORTED_HANDLERS.aws_nat_gateway),
    ...buildSupportedItems(project, connection, 'aws_ec2_transit_gateway', project.inventory, liveInventory.aws_ec2_transit_gateway, SUPPORTED_HANDLERS.aws_ec2_transit_gateway),
    ...buildSupportedItems(project, connection, 'aws_network_interface', project.inventory, liveInventory.aws_network_interface, SUPPORTED_HANDLERS.aws_network_interface),
    ...buildSupportedItems(project, connection, 'aws_s3_bucket', project.inventory, liveInventory.aws_s3_bucket, SUPPORTED_HANDLERS.aws_s3_bucket),
    ...buildSupportedItems(project, connection, 'aws_lambda_function', project.inventory, liveInventory.aws_lambda_function, SUPPORTED_HANDLERS.aws_lambda_function),
    ...buildSupportedItems(project, connection, 'aws_db_instance', project.inventory, liveInventory.aws_db_instance, SUPPORTED_HANDLERS.aws_db_instance),
    ...buildSupportedItems(project, connection, 'aws_rds_cluster', project.inventory, liveInventory.aws_rds_cluster, SUPPORTED_HANDLERS.aws_rds_cluster),
    ...buildSupportedItems(project, connection, 'aws_ecr_repository', project.inventory, liveInventory.aws_ecr_repository, SUPPORTED_HANDLERS.aws_ecr_repository),
    ...buildSupportedItems(project, connection, 'aws_eks_cluster', project.inventory, liveInventory.aws_eks_cluster, SUPPORTED_HANDLERS.aws_eks_cluster),
    ...buildSupportedItems(project, connection, 'aws_ecs_cluster', project.inventory, liveInventory.aws_ecs_cluster, SUPPORTED_HANDLERS.aws_ecs_cluster),
    ...buildSupportedItems(project, connection, 'aws_ecs_cluster_capacity_providers', project.inventory, liveInventory.aws_ecs_cluster_capacity_providers, SUPPORTED_HANDLERS.aws_ecs_cluster_capacity_providers),
    ...buildSupportedItems(project, connection, 'aws_eks_node_group', project.inventory, liveInventory.aws_eks_node_group, SUPPORTED_HANDLERS.aws_eks_node_group),
    ...buildSupportedItems(project, connection, 'aws_iam_role', project.inventory, liveInventory.aws_iam_role, SUPPORTED_HANDLERS.aws_iam_role),
    ...buildSupportedItems(project, connection, 'aws_iam_role_policy_attachment', project.inventory, liveInventory.aws_iam_role_policy_attachment, SUPPORTED_HANDLERS.aws_iam_role_policy_attachment),
    ...buildSupportedItems(project, connection, 'aws_eip', project.inventory, liveInventory.aws_eip, SUPPORTED_HANDLERS.aws_eip),
    ...buildSupportedItems(project, connection, 'aws_db_subnet_group', project.inventory, liveInventory.aws_db_subnet_group, SUPPORTED_HANDLERS.aws_db_subnet_group),
    ...buildSupportedItems(project, connection, 'aws_rds_cluster_instance', project.inventory, liveInventory.aws_rds_cluster_instance, SUPPORTED_HANDLERS.aws_rds_cluster_instance),
    ...buildSupportedItems(project, connection, 'aws_route_table_association', project.inventory, liveInventory.aws_route_table_association, SUPPORTED_HANDLERS.aws_route_table_association),
    ...buildSupportedItems(project, connection, 'aws_security_group_rule', project.inventory, liveInventory.aws_security_group_rule, SUPPORTED_HANDLERS.aws_security_group_rule),
    ...buildSupportedItems(project, connection, 'aws_lb', project.inventory, liveInventory.aws_lb, SUPPORTED_HANDLERS.aws_lb),
    ...buildSupportedItems(project, connection, 'aws_ecs_service', project.inventory, liveInventory.aws_ecs_service, SUPPORTED_HANDLERS.aws_ecs_service),
    ...buildSupportedItems(project, connection, 'aws_cloudwatch_metric_alarm', project.inventory, liveInventory.aws_cloudwatch_metric_alarm, SUPPORTED_HANDLERS.aws_cloudwatch_metric_alarm),
    ...buildSupportedItems(project, connection, 'aws_route53_record', project.inventory, liveInventory.aws_route53_record, SUPPORTED_HANDLERS.aws_route53_record),
    ...buildSupportedItems(project, connection, 'aws_cloudwatch_log_group', project.inventory, liveInventory.aws_cloudwatch_log_group, SUPPORTED_HANDLERS.aws_cloudwatch_log_group),
    ...buildSupportedItems(project, connection, 'aws_ecs_task_definition', project.inventory, liveInventory.aws_ecs_task_definition, SUPPORTED_HANDLERS.aws_ecs_task_definition),
    ...buildSupportedItems(project, connection, 'aws_lb_listener', project.inventory, liveInventory.aws_lb_listener, SUPPORTED_HANDLERS.aws_lb_listener),
    ...buildSupportedItems(project, connection, 'aws_lb_target_group', project.inventory, liveInventory.aws_lb_target_group, SUPPORTED_HANDLERS.aws_lb_target_group),
    ...buildUnsupportedItems(project, project.inventory)
  ]
  const sorted = sortItems(items)
  const scannedAt = new Date().toISOString()
  const summary = buildSummary(
    sorted,
    supportedCoverage(),
    scannedAt
  )
  const snapshot: TerraformDriftSnapshot = { id: randomUUID(), scannedAt, trigger, summary, items: sorted }
  const existing = readStoredContext(profileName, projectId, connection.region)
  const context: StoredDriftContext = {
    projectId: project.id,
    projectName: project.name,
    profileName,
    region: connection.region,
    snapshots: [snapshot, ...(existing?.snapshots ?? [])].slice(0, 20)
  }
  writeStoredContext(profileName, projectId, connection.region, context)
  return context
}

function toReport(context: StoredDriftContext, fromCache: boolean): TerraformDriftReport {
  const sanitized = sanitizeStoredContext(context)
  const latest = sanitized.snapshots[0]
  return {
    projectId: sanitized.projectId,
    projectName: sanitized.projectName,
    profileName: sanitized.profileName,
    region: sanitized.region,
    summary: latest?.summary ?? buildSummary([], [], ''),
    items: latest?.items ?? [],
    history: buildHistory(sanitized.snapshots),
    fromCache
  }
}

export async function getTerraformDriftReport(
  profileName: string,
  projectId: string,
  connection: AwsConnection,
  options?: { forceRefresh?: boolean }
): Promise<TerraformDriftReport> {
  const existing = readStoredContext(profileName, projectId, connection.region)
  if (existing && !options?.forceRefresh) {
    const sanitized = sanitizeStoredContext(existing)
    writeStoredContext(profileName, projectId, connection.region, sanitized)
    return toReport(sanitized, true)
  }
  const scanned = await scanProjectDrift(profileName, projectId, connection, existing ? 'manual' : 'initial')
  return toReport(scanned, false)
}
