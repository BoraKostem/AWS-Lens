import type {
  AwsConnection,
  Ec2InstanceSummary,
  EcrRepositorySummary,
  EksClusterSummary,
  LambdaFunctionSummary,
  RdsClusterSummary,
  RdsInstanceSummary,
  S3BucketSummary,
  SecurityGroupSummary,
  SubnetSummary,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformDriftStatus,
  TerraformProject,
  TerraformResourceInventoryItem,
  VpcSummary
} from '@shared/types'
import { listEc2Instances } from './aws/ec2'
import { listEcrRepositories } from './aws/ecr'
import { listEksClusters } from './aws/eks'
import { listLambdaFunctions } from './aws/lambda'
import { listDbClusters, listDbInstances } from './aws/rds'
import { listBuckets } from './aws/s3'
import { listSecurityGroups } from './aws/securityGroups'
import { listSubnets, listVpcs } from './aws/vpc'
import { getProject } from './terraform'

type ComparableValue = string | number | boolean

type ComparableResource = {
  resourceType: string
  logicalName: string
  cloudIdentifier: string
  region: string
  consoleUrl: string
  attributes: Record<string, ComparableValue>
}

type SupportedHandler = {
  normalizeTerraform: (item: TerraformResourceInventoryItem, connection: AwsConnection) => ComparableResource | null
  normalizeLive: (item: unknown, connection: AwsConnection) => ComparableResource
  fetchLive: (connection: AwsConnection) => Promise<unknown[]>
  identityKeys: string[]
}

type LiveInventory = {
  aws_instance: Ec2InstanceSummary[]
  aws_security_group: SecurityGroupSummary[]
  aws_vpc: VpcSummary[]
  aws_subnet: SubnetSummary[]
  aws_s3_bucket: S3BucketSummary[]
  aws_lambda_function: LambdaFunctionSummary[]
  aws_db_instance: RdsInstanceSummary[]
  aws_rds_cluster: RdsClusterSummary[]
  aws_ecr_repository: EcrRepositorySummary[]
  aws_eks_cluster: EksClusterSummary[]
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

function tags(values: Record<string, unknown>): Record<string, string> {
  const raw = values.tags
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
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

function firstIdentity(values: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function compareAttributes(terraform: ComparableResource, live: ComparableResource): string[] {
  const diffs: string[] = []
  const keys = unique([...Object.keys(terraform.attributes), ...Object.keys(live.attributes)])
  for (const key of keys) {
    const left = terraform.attributes[key]
    const right = live.attributes[key]
    if (left === undefined || right === undefined) continue
    if (Array.isArray(left) || Array.isArray(right)) continue
    if (left !== right) {
      diffs.push(`${key}: terraform=${String(left)} aws=${String(right)}`)
    }
  }
  return diffs
}

function sortItems(items: TerraformDriftItem[]): TerraformDriftItem[] {
  const statusOrder: Record<TerraformDriftStatus, number> = {
    drifted: 0,
    missing_in_aws: 1,
    unmanaged_in_aws: 2,
    unsupported: 4,
    in_sync: 3
  }
  return [...items].sort((left, right) =>
    statusOrder[left.status] - statusOrder[right.status] ||
    left.resourceType.localeCompare(right.resourceType) ||
    left.logicalName.localeCompare(right.logicalName) ||
    left.terraformAddress.localeCompare(right.terraformAddress)
  )
}

function buildSummary(items: TerraformDriftItem[]) {
  const statusCounts: Record<TerraformDriftStatus, number> = {
    in_sync: 0,
    drifted: 0,
    missing_in_aws: 0,
    unmanaged_in_aws: 0,
    unsupported: 0
  }
  const resourceTypeMap = new Map<string, number>()

  for (const item of items) {
    statusCounts[item.status] += 1
    resourceTypeMap.set(item.resourceType, (resourceTypeMap.get(item.resourceType) ?? 0) + 1)
  }

  return {
    total: items.length,
    statusCounts,
    resourceTypeCounts: Array.from(resourceTypeMap.entries())
      .map(([resourceType, count]) => ({ resourceType, count }))
      .sort((left, right) => right.count - left.count || left.resourceType.localeCompare(right.resourceType)),
    scannedAt: new Date().toISOString()
  }
}

function consoleUrl(servicePath: string, region: string): string {
  return `https://${region ? `${region}.` : ''}console.aws.amazon.com/${servicePath}`
}

function normalizeAwsInstance(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const name = tags(values).Name || str(values.instance_state) || item.name
  return {
    resourceType: item.type,
    logicalName: name || item.name,
    cloudIdentifier: str(values.id) || extractArn(values),
    region,
    consoleUrl: consoleUrl(`ec2/v2/home?region=${region}#InstanceDetails:instanceId=${str(values.id)}`, region),
    attributes: {
      instance_type: str(values.instance_type),
      subnet_id: str(values.subnet_id),
      vpc_id: str(values.vpc_security_group_ids) ? '' : str(values.vpc_id)
    }
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
      description: str(values.description),
      ingress_rules: count(values.ingress),
      egress_rules: count(values.egress)
    }
  }
}

function normalizeAwsVpc(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  return {
    resourceType: item.type,
    logicalName: tags(values).Name || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#VpcDetails:VpcId=${str(values.id)}`, region),
    attributes: {
      cidr_block: str(values.cidr_block),
      is_default: bool(values.default) ?? false
    }
  }
}

function normalizeAwsSubnet(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  return {
    resourceType: item.type,
    logicalName: tags(values).Name || item.name,
    cloudIdentifier: str(values.id),
    region,
    consoleUrl: consoleUrl(`vpcconsole/home?region=${region}#SubnetDetails:subnetId=${str(values.id)}`, region),
    attributes: {
      vpc_id: str(values.vpc_id),
      cidr_block: str(values.cidr_block),
      availability_zone: str(values.availability_zone),
      map_public_ip_on_launch: bool(values.map_public_ip_on_launch) ?? false
    }
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
    attributes: {
      bucket: bucket,
      region
    }
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
    attributes: {
      function_name: functionName,
      runtime: str(values.runtime),
      handler: str(values.handler),
      memory: num(values.memory_size) ?? 0,
      timeout: num(values.timeout) ?? 0
    }
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
    }
  }
}

function normalizeAwsRdsCluster(item: TerraformResourceInventoryItem, connection: AwsConnection): ComparableResource | null {
  const values = item.values
  const region = extractRegion(values) || connection.region
  if (region !== connection.region) return null
  const identifier = str(values.cluster_identifier) || str(values.id)
  const availabilityZones = list(values.availability_zones)
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
      multi_az: availabilityZones.length > 1
    }
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
    }
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
    }
  }
}

const SUPPORTED_HANDLERS: Record<keyof LiveInventory, SupportedHandler> = {
  aws_instance: {
    normalizeTerraform: normalizeAwsInstance,
    normalizeLive: (item: unknown, connection) => {
      const instance = item as Ec2InstanceSummary
      return ({
      resourceType: 'aws_instance',
      logicalName: instance.name || instance.instanceId,
      cloudIdentifier: instance.instanceId,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/v2/home?region=${connection.region}#InstanceDetails:instanceId=${instance.instanceId}`, connection.region),
      attributes: {
        instance_type: instance.type,
        subnet_id: instance.subnetId,
        vpc_id: instance.vpcId
      }
    })},
    fetchLive: listEc2Instances,
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_security_group: {
    normalizeTerraform: normalizeAwsSecurityGroup,
    normalizeLive: (item: unknown, connection) => {
      const group = item as SecurityGroupSummary
      return ({
      resourceType: 'aws_security_group',
      logicalName: group.groupName,
      cloudIdentifier: group.groupId,
      region: connection.region,
      consoleUrl: consoleUrl(`ec2/v2/home?region=${connection.region}#SecurityGroup:groupId=${group.groupId}`, connection.region),
      attributes: {
        name: group.groupName,
        vpc_id: group.vpcId,
        description: group.description,
        ingress_rules: group.inboundRuleCount,
        egress_rules: group.outboundRuleCount
      }
    })},
    fetchLive: (connection) => listSecurityGroups(connection),
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_vpc: {
    normalizeTerraform: normalizeAwsVpc,
    normalizeLive: (item: unknown, connection) => {
      const vpc = item as VpcSummary
      return ({
      resourceType: 'aws_vpc',
      logicalName: vpc.name !== '-' ? vpc.name : vpc.vpcId,
      cloudIdentifier: vpc.vpcId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#VpcDetails:VpcId=${vpc.vpcId}`, connection.region),
      attributes: {
        cidr_block: vpc.cidrBlock,
        is_default: vpc.isDefault
      }
    })},
    fetchLive: listVpcs,
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_subnet: {
    normalizeTerraform: normalizeAwsSubnet,
    normalizeLive: (item: unknown, connection) => {
      const subnet = item as SubnetSummary
      return ({
      resourceType: 'aws_subnet',
      logicalName: subnet.name !== '-' ? subnet.name : subnet.subnetId,
      cloudIdentifier: subnet.subnetId,
      region: connection.region,
      consoleUrl: consoleUrl(`vpcconsole/home?region=${connection.region}#SubnetDetails:subnetId=${subnet.subnetId}`, connection.region),
      attributes: {
        vpc_id: subnet.vpcId,
        cidr_block: subnet.cidrBlock,
        availability_zone: subnet.availabilityZone,
        map_public_ip_on_launch: subnet.mapPublicIpOnLaunch
      }
    })},
    fetchLive: (connection) => listSubnets(connection),
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_s3_bucket: {
    normalizeTerraform: normalizeAwsS3Bucket,
    normalizeLive: (item: unknown) => {
      const bucket = item as S3BucketSummary
      return ({
      resourceType: 'aws_s3_bucket',
      logicalName: bucket.name,
      cloudIdentifier: bucket.name,
      region: bucket.region,
      consoleUrl: consoleUrl(`s3/buckets/${bucket.name}?region=${bucket.region}&tab=objects`, bucket.region),
      attributes: {
        bucket: bucket.name,
        region: bucket.region
      }
    })},
    fetchLive: listBuckets,
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_lambda_function: {
    normalizeTerraform: normalizeAwsLambda,
    normalizeLive: (item: unknown, connection) => {
      const lambda = item as LambdaFunctionSummary
      return ({
      resourceType: 'aws_lambda_function',
      logicalName: lambda.functionName,
      cloudIdentifier: lambda.functionName,
      region: connection.region,
      consoleUrl: consoleUrl(`lambda/home?region=${connection.region}#/functions/${encodeURIComponent(lambda.functionName)}?tab=code`, connection.region),
      attributes: {
        function_name: lambda.functionName,
        runtime: lambda.runtime,
        handler: lambda.handler,
        memory: typeof lambda.memory === 'number' ? lambda.memory : 0
      }
    })},
    fetchLive: listLambdaFunctions,
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_db_instance: {
    normalizeTerraform: normalizeAwsDbInstance,
    normalizeLive: (item: unknown, connection) => {
      const db = item as RdsInstanceSummary
      return ({
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
      }
    })},
    fetchLive: listDbInstances,
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_rds_cluster: {
    normalizeTerraform: normalizeAwsRdsCluster,
    normalizeLive: (item: unknown, connection) => {
      const cluster = item as RdsClusterSummary
      return ({
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
      }
    })},
    fetchLive: listDbClusters,
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_ecr_repository: {
    normalizeTerraform: normalizeAwsEcrRepository,
    normalizeLive: (item: unknown, connection) => {
      const repo = item as EcrRepositorySummary
      return ({
      resourceType: 'aws_ecr_repository',
      logicalName: repo.repositoryName,
      cloudIdentifier: repo.repositoryUri,
      region: connection.region,
      consoleUrl: consoleUrl(`ecr/repositories/private/${encodeURIComponent(repo.repositoryName)}?region=${connection.region}`, connection.region),
      attributes: {
        repository_name: repo.repositoryName,
        image_tag_mutability: repo.imageTagMutability,
        scan_on_push: repo.scanOnPush
      }
    })},
    fetchLive: listEcrRepositories,
    identityKeys: ['cloudIdentifier', 'logicalName']
  },
  aws_eks_cluster: {
    normalizeTerraform: normalizeAwsEksCluster,
    normalizeLive: (item: unknown, connection) => {
      const cluster = item as EksClusterSummary
      return ({
      resourceType: 'aws_eks_cluster',
      logicalName: cluster.name,
      cloudIdentifier: cluster.name,
      region: connection.region,
      consoleUrl: consoleUrl(`eks/home?region=${connection.region}#/clusters/${encodeURIComponent(cluster.name)}`, connection.region),
      attributes: {
        name: cluster.name,
        version: cluster.version,
        role_arn: cluster.roleArn
      }
    })},
    fetchLive: listEksClusters,
    identityKeys: ['cloudIdentifier', 'logicalName']
  }
}

async function loadLiveInventory(connection: AwsConnection): Promise<LiveInventory> {
  const [
    instances,
    securityGroups,
    vpcs,
    subnets,
    buckets,
    lambdas,
    rdsInstances,
    rdsClusters,
    ecrRepositories,
    eksClusters
  ] = await Promise.all([
    listEc2Instances(connection),
    listSecurityGroups(connection),
    listVpcs(connection),
    listSubnets(connection),
    listBuckets(connection),
    listLambdaFunctions(connection),
    listDbInstances(connection),
    listDbClusters(connection),
    listEcrRepositories(connection),
    listEksClusters(connection)
  ])

  return {
    aws_instance: instances,
    aws_security_group: securityGroups,
    aws_vpc: vpcs,
    aws_subnet: subnets,
    aws_s3_bucket: buckets,
    aws_lambda_function: lambdas,
    aws_db_instance: rdsInstances,
    aws_rds_cluster: rdsClusters,
    aws_ecr_repository: ecrRepositories,
    aws_eks_cluster: eksClusters
  }
}

function makeStateShowCommand(project: TerraformProject, address: string): string {
  if (!address) return ''
  const escapedRoot = project.rootPath.replace(/'/g, "''")
  return `Set-Location '${escapedRoot}'; terraform state show ${address}`
}

function findLiveMatch(terraform: ComparableResource, live: ComparableResource[], identityKeys: string[]): ComparableResource | null {
  for (const key of identityKeys) {
    const needle = terraform[key as keyof ComparableResource]
    if (typeof needle !== 'string' || !needle) continue
    const match = live.find((candidate) => candidate[key as keyof ComparableResource] === needle)
    if (match) return match
  }
  return null
}

function buildSupportedItems(
  project: TerraformProject,
  connection: AwsConnection,
  type: keyof LiveInventory,
  inventory: TerraformResourceInventoryItem[],
  liveRaw: LiveInventory[keyof LiveInventory]
): TerraformDriftItem[] {
  const handler = SUPPORTED_HANDLERS[type]
  const live = (liveRaw as Array<unknown>).map((item) => handler.normalizeLive(item as never, connection))
  const matchedLiveIds = new Set<string>()
  const items: TerraformDriftItem[] = []

  for (const resource of inventory.filter((item) => item.type === type && item.mode === 'managed')) {
    const normalized = handler.normalizeTerraform(resource, connection)
    if (!normalized) {
      continue
    }

    const match = findLiveMatch(normalized, live, handler.identityKeys)
    if (!match) {
      items.push({
        terraformAddress: resource.address,
        resourceType: resource.type,
        logicalName: normalized.logicalName || resource.name,
        cloudIdentifier: normalized.cloudIdentifier,
        region: normalized.region,
        status: 'missing_in_aws',
        explanation: 'Terraform state references this resource, but no matching AWS resource was found in the current inventory.',
        suggestedNextStep: 'Run terraform state show or terraform plan, then verify whether the resource was deleted, renamed, or is in a different region/account.',
        consoleUrl: normalized.consoleUrl,
        terminalCommand: makeStateShowCommand(project, resource.address)
      })
      continue
    }

    matchedLiveIds.add(match.cloudIdentifier || match.logicalName)
    const diffs = compareAttributes(normalized, match)
    items.push({
      terraformAddress: resource.address,
      resourceType: resource.type,
      logicalName: normalized.logicalName || match.logicalName || resource.name,
      cloudIdentifier: match.cloudIdentifier || normalized.cloudIdentifier,
      region: match.region || normalized.region,
      status: diffs.length > 0 ? 'drifted' : 'in_sync',
      explanation: diffs.length > 0
        ? `Detected differences in ${diffs.slice(0, 3).join(', ')}.`
        : 'Terraform inventory and the live AWS resource match on the tracked identifiers and attributes.',
      suggestedNextStep: diffs.length > 0
        ? 'Review terraform state show and terraform plan, then decide whether to update Terraform code/state or reconcile the live resource manually.'
        : 'No action is required unless you want a deeper attribute review with terraform plan.',
      consoleUrl: match.consoleUrl || normalized.consoleUrl,
      terminalCommand: makeStateShowCommand(project, resource.address)
    })
  }

  return items
}
export async function getTerraformDriftReport(
  profileName: string,
  projectId: string,
  connection: AwsConnection
): Promise<TerraformDriftReport> {
  const project = getProject(profileName, projectId)
  const liveInventory = await loadLiveInventory(connection)
  const items = [
    ...buildSupportedItems(project, connection, 'aws_instance', project.inventory, liveInventory.aws_instance),
    ...buildSupportedItems(project, connection, 'aws_security_group', project.inventory, liveInventory.aws_security_group),
    ...buildSupportedItems(project, connection, 'aws_vpc', project.inventory, liveInventory.aws_vpc),
    ...buildSupportedItems(project, connection, 'aws_subnet', project.inventory, liveInventory.aws_subnet),
    ...buildSupportedItems(project, connection, 'aws_s3_bucket', project.inventory, liveInventory.aws_s3_bucket),
    ...buildSupportedItems(project, connection, 'aws_lambda_function', project.inventory, liveInventory.aws_lambda_function),
    ...buildSupportedItems(project, connection, 'aws_db_instance', project.inventory, liveInventory.aws_db_instance),
    ...buildSupportedItems(project, connection, 'aws_rds_cluster', project.inventory, liveInventory.aws_rds_cluster),
    ...buildSupportedItems(project, connection, 'aws_ecr_repository', project.inventory, liveInventory.aws_ecr_repository),
    ...buildSupportedItems(project, connection, 'aws_eks_cluster', project.inventory, liveInventory.aws_eks_cluster)
  ]

  const sorted = sortItems(items)
  return {
    projectId: project.id,
    projectName: project.name,
    profileName,
    region: connection.region,
    summary: buildSummary(sorted),
    items: sorted
  }
}
