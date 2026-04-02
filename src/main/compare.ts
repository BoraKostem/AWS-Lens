import type {
  AcmCertificateSummary,
  AwsConnection,
  ComparisonContextDescriptor,
  ComparisonContextInput,
  ComparisonCoverageItem,
  ComparisonDiffGroup,
  ComparisonDiffRow,
  ComparisonDiffStatus,
  ComparisonFocusMode,
  ComparisonKeyDifferenceItem,
  ComparisonRequest,
  ComparisonResult,
  ComparisonRiskLevel,
  ComparisonSummary,
  ComplianceFinding,
  ComplianceReport,
  CostBreakdown,
  Ec2InstanceSummary,
  EcrRepositorySummary,
  LambdaFunctionSummary,
  LoadBalancerWorkspace,
  NormalizedResourceIdentity,
  OverviewMetrics,
  OverviewStatistics,
  RdsClusterSummary,
  RdsInstanceSummary,
  S3BucketSummary,
  SecurityGroupSummary,
  ServiceId,
  SubnetSummary,
  VpcSummary,
  WafWebAclSummary
} from '@shared/types'
import { toNormalizedActorIdentity } from '@shared/providerAdapters'
import { createBaseConnection, createConnectionFromSession, getSessionSummary } from './sessionHub'
import { listAcmCertificates } from './aws/acm'
import { getComplianceReport } from './aws/compliance'
import { listEc2Instances } from './aws/ec2'
import { listEcrRepositories } from './aws/ecr'
import { listLambdaFunctions } from './aws/lambda'
import { listLoadBalancerWorkspaces } from './aws/loadBalancers'
import { getCostBreakdown, getOverviewMetrics, getOverviewStatistics } from './aws/overview'
import { listDbClusters, listDbInstances } from './aws/rds'
import { listBuckets } from './aws/s3'
import { listSecurityGroups } from './aws/securityGroups'
import { getCallerIdentity } from './aws/sts'
import { listSubnets, listVpcs } from './aws/vpc'
import { listWebAcls } from './aws/waf'

type DiffableRecord = {
  section: string
  title: string
  subtitle: string
  serviceId: ServiceId
  resourceType: string
  identityKey: string
  focusModes: ComparisonFocusMode[]
  value: string
  secondary: string
  risk: ComparisonRiskLevel
  rationale: string
  region: string
  attributes: Record<string, string>
  tags?: Record<string, string>
}

type ContextDataset = {
  descriptor: ComparisonContextDescriptor
  metrics: OverviewMetrics
  statistics: OverviewStatistics
  costBreakdown: CostBreakdown
  compliance: ComplianceReport
  findings: ComplianceFinding[]
  inventory: DiffableRecord[]
}

const GOVERNANCE_TAG_KEYS = ['Owner', 'Environment', 'Project', 'CostCenter']

function toStatus(leftExists: boolean, rightExists: boolean, same: boolean): ComparisonDiffStatus {
  if (leftExists && rightExists) return same ? 'same' : 'different'
  return leftExists ? 'left-only' : 'right-only'
}

function riskRank(value: ComparisonRiskLevel): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : value === 'low' ? 1 : 0
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function attrsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
  return keys.every((key) => (left[key] ?? '') === (right[key] ?? ''))
}

function fieldDetails(left?: Record<string, string>, right?: Record<string, string>) {
  const keys = [...new Set([...(left ? Object.keys(left) : []), ...(right ? Object.keys(right) : [])])].sort((a, b) => a.localeCompare(b))
  return keys.map((key) => ({
    key,
    label: key.replace(/_/g, ' '),
    status: (left && right
      ? ((left[key] ?? '') === (right[key] ?? '') ? 'same' : 'different')
      : 'n/a') as ComparisonDiffStatus | 'n/a',
    leftValue: left?.[key] ?? '',
    rightValue: right?.[key] ?? ''
  }))
}

function normalizeCanonicalType(providerId: AwsConnection['providerId'], resourceType: string): string {
  return `${providerId}:${resourceType.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function makeResourceIdentity(
  dataset: ContextDataset,
  serviceId: ServiceId,
  resourceType: string,
  identityKey: string,
  displayName: string,
  locationId = dataset.descriptor.region
): NormalizedResourceIdentity {
  return {
    providerId: dataset.descriptor.normalizedIdentity.providerId,
    serviceId,
    resourceType,
    canonicalType: normalizeCanonicalType(dataset.descriptor.normalizedIdentity.providerId, resourceType),
    identityKey,
    displayName,
    locationId,
    scopeId: dataset.descriptor.normalizedIdentity.scopeId
  }
}

function makeDescriptor(connection: AwsConnection, accountId: string, arn: string): ComparisonContextDescriptor {
  return {
    kind: connection.kind,
    sessionId: connection.sessionId,
    label: connection.label,
    profile: connection.profile,
    sourceProfile: connection.kind === 'assumed-role' ? connection.sourceProfile : connection.profile,
    region: connection.region,
    accountId,
    roleArn: connection.kind === 'assumed-role' ? connection.roleArn : '',
    arn,
    normalizedIdentity: toNormalizedActorIdentity({
      providerId: connection.providerId,
      accountId,
      account: accountId,
      principalArn: arn,
      principalId: arn,
      arn,
      userId: arn
    } as const, connection.label)
  }
}

function sgRisk(item: SecurityGroupSummary): ComparisonRiskLevel {
  const risky = item.inboundRules.some((rule) =>
    (rule.source === '0.0.0.0/0' || rule.source === '::/0') &&
    (rule.portRange === 'All' || /22|3389|5432|3306|6379|27017|80|443/.test(rule.portRange))
  )
  return risky ? 'high' : item.inboundRuleCount > 10 ? 'medium' : 'low'
}

function push(records: DiffableRecord[], item: Omit<DiffableRecord, 'region'>, region: string): void {
  records.push({ ...item, region })
}

function normalizeInventory(input: {
  region: string
  ec2: Ec2InstanceSummary[]
  vpcs: VpcSummary[]
  subnets: SubnetSummary[]
  securityGroups: SecurityGroupSummary[]
  loadBalancers: LoadBalancerWorkspace[]
  s3Buckets: S3BucketSummary[]
  lambdaFunctions: LambdaFunctionSummary[]
  rdsInstances: RdsInstanceSummary[]
  rdsClusters: RdsClusterSummary[]
  ecrRepositories: EcrRepositorySummary[]
  acmCertificates: AcmCertificateSummary[]
  wafWebAcls: WafWebAclSummary[]
}): DiffableRecord[] {
  const records: DiffableRecord[] = []
  const region = input.region

  for (const item of input.ec2) {
    const name = item.name.trim() || item.instanceId
    push(records, {
      section: 'EC2 Instances',
      title: name,
      subtitle: item.instanceId,
      serviceId: 'ec2',
      resourceType: 'EC2 Instance',
      identityKey: name,
      focusModes: ['compute'],
      value: item.state,
      secondary: item.type,
      risk: item.publicIp ? 'medium' : 'low',
      rationale: item.publicIp ? 'Public IP exposure differs.' : 'Instance inventory differs.',
      attributes: {
        state: item.state,
        type: item.type,
        availability_zone: item.availabilityZone,
        subnet_id: item.subnetId,
        vpc_id: item.vpcId,
        public_ip: item.publicIp,
        iam_profile: item.iamProfile
      }
    }, region)
  }

  for (const item of input.vpcs) {
    const name = item.name.trim() || item.vpcId
    push(records, {
      section: 'VPCs',
      title: name,
      subtitle: item.vpcId,
      serviceId: 'vpc',
      resourceType: 'VPC',
      identityKey: `${name}:${item.cidrBlock}`,
      focusModes: ['networking'],
      value: item.cidrBlock,
      secondary: item.isDefault ? 'default' : item.state,
      risk: item.isDefault ? 'medium' : 'low',
      rationale: item.isDefault ? 'Default VPC posture may differ.' : 'VPC inventory differs.',
      attributes: {
        cidr_block: item.cidrBlock,
        state: item.state,
        is_default: String(item.isDefault),
        owner_id: item.ownerId
      },
      tags: item.tags
    }, region)
  }

  for (const item of input.subnets) {
    const name = item.name.trim() || item.subnetId
    push(records, {
      section: 'Subnets',
      title: name,
      subtitle: item.subnetId,
      serviceId: 'vpc',
      resourceType: 'Subnet',
      identityKey: `${name}:${item.cidrBlock}`,
      focusModes: ['networking'],
      value: item.cidrBlock,
      secondary: item.availabilityZone,
      risk: item.mapPublicIpOnLaunch ? 'medium' : 'low',
      rationale: item.mapPublicIpOnLaunch ? 'Subnet auto-assigns public IPs.' : 'Subnet inventory differs.',
      attributes: {
        vpc_id: item.vpcId,
        cidr_block: item.cidrBlock,
        availability_zone: item.availabilityZone,
        public_ip_on_launch: String(item.mapPublicIpOnLaunch),
        available_ips: String(item.availableIpAddressCount)
      },
      tags: item.tags
    }, region)
  }

  for (const item of input.securityGroups) {
    push(records, {
      section: 'Security Groups',
      title: item.groupName || item.groupId,
      subtitle: item.groupId,
      serviceId: 'security-groups',
      resourceType: 'Security Group',
      identityKey: `${item.groupName}:${item.vpcId}`,
      focusModes: ['security', 'networking'],
      value: `${item.inboundRuleCount} inbound`,
      secondary: `${item.outboundRuleCount} outbound`,
      risk: sgRisk(item),
      rationale: 'Security group rule posture differs.',
      attributes: {
        vpc_id: item.vpcId,
        inbound_rules: String(item.inboundRuleCount),
        outbound_rules: String(item.outboundRuleCount),
        description: item.description
      },
      tags: item.tags
    }, region)
  }

  for (const item of input.loadBalancers) {
    const unhealthy = item.targetGroups.reduce((sum, group) => sum + (item.targetsByGroup[group.arn] ?? []).filter((target) => target.state !== 'healthy').length, 0)
    push(records, {
      section: 'Load Balancers',
      title: item.summary.name,
      subtitle: item.summary.arn,
      serviceId: 'load-balancers',
      resourceType: 'Load Balancer',
      identityKey: item.summary.name,
      focusModes: ['networking', 'security'],
      value: item.summary.state,
      secondary: item.summary.type,
      risk: unhealthy > 0 ? 'medium' : 'low',
      rationale: unhealthy > 0 ? 'One or more targets are unhealthy.' : 'Load balancer inventory differs.',
      attributes: {
        type: item.summary.type,
        scheme: item.summary.scheme,
        listeners: String(item.listeners.length),
        target_groups: String(item.targetGroups.length),
        unhealthy_targets: String(unhealthy)
      }
    }, region)
  }

  for (const item of input.s3Buckets) {
    push(records, {
      section: 'S3 Buckets',
      title: item.name,
      subtitle: item.region,
      serviceId: 's3',
      resourceType: 'S3 Bucket',
      identityKey: item.name,
      focusModes: ['storage', 'cost'],
      value: item.region,
      secondary: item.creationDate,
      risk: 'low',
      rationale: 'Bucket inventory differs.',
      attributes: { region: item.region, creation_date: item.creationDate }
    }, region)
  }

  for (const item of input.lambdaFunctions) {
    push(records, {
      section: 'Lambda Functions',
      title: item.functionName,
      subtitle: item.runtime,
      serviceId: 'lambda',
      resourceType: 'Lambda Function',
      identityKey: item.functionName,
      focusModes: ['compute', 'cost'],
      value: item.runtime,
      secondary: `${item.memory} MB`,
      risk: 'low',
      rationale: 'Function runtime or memory differs.',
      attributes: {
        runtime: item.runtime,
        handler: item.handler,
        memory_mb: String(item.memory),
        last_modified: item.lastModified
      }
    }, region)
  }

  for (const item of input.rdsInstances) {
    push(records, {
      section: 'RDS Instances',
      title: item.dbInstanceIdentifier,
      subtitle: item.engine,
      serviceId: 'rds',
      resourceType: 'RDS Instance',
      identityKey: item.dbInstanceIdentifier,
      focusModes: ['storage', 'cost'],
      value: item.status,
      secondary: item.dbInstanceClass,
      risk: item.multiAz ? 'low' : 'medium',
      rationale: item.multiAz ? 'Database inventory differs.' : 'Single-AZ database increases operational risk.',
      attributes: {
        engine: item.engine,
        engine_version: item.engineVersion,
        instance_class: item.dbInstanceClass,
        status: item.status,
        multi_az: String(item.multiAz),
        storage_gib: String(item.allocatedStorage)
      }
    }, region)
  }

  for (const item of input.rdsClusters) {
    push(records, {
      section: 'RDS Clusters',
      title: item.dbClusterIdentifier,
      subtitle: item.engine,
      serviceId: 'rds',
      resourceType: 'RDS Cluster',
      identityKey: item.dbClusterIdentifier,
      focusModes: ['storage', 'cost'],
      value: item.status,
      secondary: item.engineVersion,
      risk: item.storageEncrypted ? 'low' : 'high',
      rationale: item.storageEncrypted ? 'Cluster inventory differs.' : 'Cluster encryption posture differs.',
      attributes: {
        engine: item.engine,
        engine_version: item.engineVersion,
        status: item.status,
        multi_az: String(item.multiAz),
        storage_encrypted: String(item.storageEncrypted)
      }
    }, region)
  }

  for (const item of input.ecrRepositories) {
    push(records, {
      section: 'ECR Repositories',
      title: item.repositoryName,
      subtitle: item.repositoryUri,
      serviceId: 'ecr',
      resourceType: 'ECR Repository',
      identityKey: item.repositoryName,
      focusModes: ['compute', 'security', 'cost'],
      value: String(item.imageCount),
      secondary: item.imageTagMutability,
      risk: item.scanOnPush ? 'low' : 'medium',
      rationale: item.scanOnPush ? 'Repository inventory differs.' : 'Image scan on push is disabled.',
      attributes: {
        image_count: String(item.imageCount),
        tag_mutability: item.imageTagMutability,
        scan_on_push: String(item.scanOnPush)
      }
    }, region)
  }

  for (const item of input.acmCertificates) {
    push(records, {
      section: 'ACM Certificates',
      title: item.domainName,
      subtitle: item.certificateArn,
      serviceId: 'acm',
      resourceType: 'ACM Certificate',
      identityKey: item.domainName,
      focusModes: ['security', 'networking'],
      value: item.status,
      secondary: item.urgencyReason,
      risk: item.urgencySeverity === 'critical' ? 'high' : item.urgencySeverity === 'warning' ? 'medium' : 'low',
      rationale: item.urgencyReason || 'Certificate inventory differs.',
      attributes: {
        status: item.status,
        type: item.type,
        in_use: String(item.inUse),
        days_until_expiry: String(item.daysUntilExpiry ?? ''),
        dns_validation_issues: String(item.dnsValidationIssueCount)
      }
    }, region)
  }

  for (const item of input.wafWebAcls) {
    push(records, {
      section: 'WAF Web ACLs',
      title: item.name,
      subtitle: item.arn,
      serviceId: 'waf',
      resourceType: 'WAF Web ACL',
      identityKey: `${item.scope}:${item.name}`,
      focusModes: ['security', 'networking'],
      value: item.scope,
      secondary: String(item.capacity),
      risk: 'medium',
      rationale: 'Web ACL coverage differs.',
      attributes: {
        scope: item.scope,
        capacity: String(item.capacity),
        description: item.description
      }
    }, region)
  }

  return records
}

async function resolveConnection(input: ComparisonContextInput): Promise<AwsConnection> {
  return input.kind === 'profile'
    ? createBaseConnection(input.profile, input.region)
    : createConnectionFromSession(input.sessionId, input.region)
}

async function loadDataset(input: ComparisonContextInput): Promise<ContextDataset> {
  const connection = await resolveConnection(input)
  const [identity, metrics, statistics, compliance, costBreakdown, ec2, vpcs, subnets, securityGroups, loadBalancers, s3Buckets, lambdaFunctions, rdsInstances, rdsClusters, ecrRepositories, acmCertificates, wafWebAcls] = await Promise.all([
    getCallerIdentity(connection),
    getOverviewMetrics(connection, [connection.region]),
    getOverviewStatistics(connection),
    getComplianceReport(connection),
    getCostBreakdown(connection).catch(() => ({ entries: [], total: 0, period: '' })),
    listEc2Instances(connection).catch(() => []),
    listVpcs(connection).catch(() => []),
    listSubnets(connection).catch(() => []),
    listSecurityGroups(connection).catch(() => []),
    listLoadBalancerWorkspaces(connection).catch(() => []),
    listBuckets(connection).catch(() => []),
    listLambdaFunctions(connection).catch(() => []),
    listDbInstances(connection).catch(() => []),
    listDbClusters(connection).catch(() => []),
    listEcrRepositories(connection).catch(() => []),
    listAcmCertificates(connection).catch(() => []),
    listWebAcls(connection, 'REGIONAL').catch(() => [])
  ])

  const summary = input.kind === 'assumed-role' ? getSessionSummary(input.sessionId) : null
  const accountId = identity.account || summary?.accountId || ''
  const descriptor = makeDescriptor(connection, accountId, identity.arn)

  return {
    descriptor: { ...descriptor, label: input.label?.trim() || descriptor.label },
    metrics,
    statistics,
    costBreakdown,
    compliance,
    findings: compliance.findings,
    inventory: normalizeInventory({
      region: connection.region,
      ec2,
      vpcs,
      subnets,
      securityGroups,
      loadBalancers,
      s3Buckets,
      lambdaFunctions,
      rdsInstances,
      rdsClusters,
      ecrRepositories,
      acmCertificates,
      wafWebAcls
    })
  }
}

function statusCounts(rows: ComparisonDiffRow[]): Record<ComparisonDiffStatus, number> {
  return rows.reduce<Record<ComparisonDiffStatus, number>>((acc, row) => {
    acc[row.status] += 1
    return acc
  }, { 'left-only': 0, 'right-only': 0, different: 0, same: 0 })
}

function sortRows(rows: ComparisonDiffRow[]): ComparisonDiffRow[] {
  const order: Record<ComparisonDiffStatus, number> = { different: 0, 'left-only': 1, 'right-only': 2, same: 3 }
  return [...rows].sort((left, right) =>
    riskRank(right.risk) - riskRank(left.risk) ||
    order[left.status] - order[right.status] ||
    left.title.localeCompare(right.title)
  )
}

function buildInventoryGroups(left: ContextDataset, right: ContextDataset): ComparisonDiffGroup[] {
  const sections = [...new Set([...left.inventory.map((item) => item.section), ...right.inventory.map((item) => item.section)])]

  return sections.map((section) => {
    const leftMap = new Map(left.inventory.filter((item) => item.section === section).map((item) => [item.identityKey, item]))
    const rightMap = new Map(right.inventory.filter((item) => item.section === section).map((item) => [item.identityKey, item]))
    const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort((a, b) => a.localeCompare(b))
    const rows = keys.map((key) => {
      const leftItem = leftMap.get(key)
      const rightItem = rightMap.get(key)
      const same = leftItem && rightItem ? attrsEqual(leftItem.attributes, rightItem.attributes) : false
      const source = leftItem ?? rightItem!
      const identityDataset = leftItem ? left : right
      const normalizedIdentity = makeResourceIdentity(identityDataset, source.serviceId, source.resourceType, key, source.title, source.region)

      return {
        id: `inventory:${section}:${key}`,
        layer: 'inventory',
        section,
        title: source.title,
        subtitle: source.subtitle,
        status: toStatus(Boolean(leftItem), Boolean(rightItem), same),
        risk: leftItem && rightItem ? (riskRank(leftItem.risk) >= riskRank(rightItem.risk) ? leftItem.risk : rightItem.risk) : source.risk,
        serviceId: source.serviceId,
        resourceType: source.resourceType,
        identityKey: key,
        normalizedIdentity,
        focusModes: source.focusModes,
        rationale: source.rationale,
        left: { value: leftItem?.value ?? 'Absent', secondary: leftItem?.secondary ?? '' },
        right: { value: rightItem?.value ?? 'Absent', secondary: rightItem?.secondary ?? '' },
        detailFields: fieldDetails(leftItem?.attributes, rightItem?.attributes),
        navigation: {
          providerId: normalizedIdentity.providerId,
          serviceId: source.serviceId,
          region: source.region,
          resourceLabel: source.title,
          identity: normalizedIdentity
        }
      } satisfies ComparisonDiffRow
    })

    return {
      id: `inventory:${section}`,
      label: section,
      layer: 'inventory',
      focusModes: [...new Set(rows.flatMap((row) => row.focusModes))],
      coverage: 'full',
      counts: statusCounts(rows),
      rows: sortRows(rows)
    } satisfies ComparisonDiffGroup
  })
}

function buildPostureGroup(left: ContextDataset, right: ContextDataset): ComparisonDiffGroup {
  const leftMap = new Map(left.findings.map((item) => [`${item.service}:${item.title}:${item.resourceId}`, item]))
  const rightMap = new Map(right.findings.map((item) => [`${item.service}:${item.title}:${item.resourceId}`, item]))
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort((a, b) => a.localeCompare(b))
  const rows = keys.map((key) => {
    const leftItem = leftMap.get(key)
    const rightItem = rightMap.get(key)
    const same = leftItem && rightItem
      ? leftItem.severity === rightItem.severity && leftItem.category === rightItem.category && leftItem.description === rightItem.description
      : false
    const source = leftItem ?? rightItem!
    const risk: ComparisonRiskLevel = source.severity === 'high' ? 'high' : source.severity === 'medium' ? 'medium' : 'low'
    const identityDataset = leftItem ? left : right
    const normalizedIdentity = makeResourceIdentity(
      identityDataset,
      source.service,
      'Compliance Finding',
      key,
      source.resourceId || source.title,
      source.region || identityDataset.descriptor.region
    )

    return {
      id: `posture:${key}`,
      layer: 'posture',
      section: 'Posture / Findings',
      title: source.title,
      subtitle: source.resourceId || source.service,
      status: toStatus(Boolean(leftItem), Boolean(rightItem), same),
      risk,
      serviceId: source.service,
      resourceType: 'Compliance Finding',
      identityKey: key,
      normalizedIdentity,
      focusModes: source.category === 'cost' ? ['cost', 'drift-compliance'] : ['security', 'drift-compliance'],
      rationale: source.recommendedAction,
      left: { value: leftItem ? `${leftItem.severity} ${leftItem.category}` : 'Absent', secondary: leftItem?.description ?? '' },
      right: { value: rightItem ? `${rightItem.severity} ${rightItem.category}` : 'Absent', secondary: rightItem?.description ?? '' },
      detailFields: fieldDetails(
        leftItem ? { severity: leftItem.severity, category: leftItem.category, region: leftItem.region, resource_id: leftItem.resourceId } : undefined,
        rightItem ? { severity: rightItem.severity, category: rightItem.category, region: rightItem.region, resource_id: rightItem.resourceId } : undefined
      ),
      navigation: {
        providerId: normalizedIdentity.providerId,
        serviceId: source.service,
        region: source.region || left.descriptor.region,
        resourceLabel: source.resourceId || source.title,
        identity: normalizedIdentity
      }
    } satisfies ComparisonDiffRow
  })

  return {
    id: 'posture',
    label: 'Posture / Findings',
    layer: 'posture',
    focusModes: ['security', 'drift-compliance', 'cost'],
    coverage: 'partial',
    counts: statusCounts(rows),
    rows: sortRows(rows)
  }
}

function buildComplianceDeltaGroup(left: ContextDataset, right: ContextDataset): ComparisonDiffGroup {
  const makeComplianceIdentity = (
    serviceId: ServiceId,
    resourceType: string,
    identityKey: string,
    displayName: string
  ) => makeResourceIdentity(left, serviceId, resourceType, identityKey, displayName)

  const metricRows: ComparisonDiffRow[] = [
    {
      id: 'compliance:total',
      layer: 'posture',
      section: 'Compliance deltas',
      title: 'Total compliance findings',
      subtitle: 'Summary',
      status: left.compliance.summary.total === right.compliance.summary.total ? 'same' : 'different',
      risk: left.compliance.summary.total === right.compliance.summary.total ? 'low' : 'medium',
      serviceId: 'compliance-center',
      resourceType: 'Compliance Summary',
      identityKey: 'total-findings',
      normalizedIdentity: makeComplianceIdentity('compliance-center', 'Compliance Summary', 'total-findings', 'Total compliance findings'),
      focusModes: ['security', 'drift-compliance', 'cost'],
      rationale: 'Overall compliance volume differs between the selected contexts.',
      left: { value: String(left.compliance.summary.total), secondary: `${left.compliance.warnings.length} warnings` },
      right: { value: String(right.compliance.summary.total), secondary: `${right.compliance.warnings.length} warnings` },
      detailFields: fieldDetails(
        {
          total: String(left.compliance.summary.total),
          warnings: String(left.compliance.warnings.length),
          generated_at: left.compliance.generatedAt
        },
        {
          total: String(right.compliance.summary.total),
          warnings: String(right.compliance.warnings.length),
          generated_at: right.compliance.generatedAt
        }
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'compliance-center',
        region: left.descriptor.region,
        resourceLabel: 'compliance-summary',
        identity: makeComplianceIdentity('compliance-center', 'Compliance Summary', 'total-findings', 'Total compliance findings')
      }
    },
    {
      id: 'compliance:severity:high',
      layer: 'posture',
      section: 'Compliance deltas',
      title: 'High severity findings',
      subtitle: 'Severity',
      status: left.compliance.summary.bySeverity.high === right.compliance.summary.bySeverity.high ? 'same' : 'different',
      risk: (left.compliance.summary.bySeverity.high > 0 || right.compliance.summary.bySeverity.high > 0) ? 'high' : 'low',
      serviceId: 'compliance-center',
      resourceType: 'Compliance Severity',
      identityKey: 'severity-high',
      normalizedIdentity: makeComplianceIdentity('compliance-center', 'Compliance Severity', 'severity-high', 'High severity findings'),
      focusModes: ['security', 'drift-compliance'],
      rationale: 'High-severity compliance pressure differs.',
      left: { value: String(left.compliance.summary.bySeverity.high), secondary: '' },
      right: { value: String(right.compliance.summary.bySeverity.high), secondary: '' },
      detailFields: fieldDetails(
        { high: String(left.compliance.summary.bySeverity.high) },
        { high: String(right.compliance.summary.bySeverity.high) }
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'compliance-center',
        region: left.descriptor.region,
        resourceLabel: 'high-severity',
        identity: makeComplianceIdentity('compliance-center', 'Compliance Severity', 'severity-high', 'High severity findings')
      }
    },
    {
      id: 'compliance:severity:medium',
      layer: 'posture',
      section: 'Compliance deltas',
      title: 'Medium severity findings',
      subtitle: 'Severity',
      status: left.compliance.summary.bySeverity.medium === right.compliance.summary.bySeverity.medium ? 'same' : 'different',
      risk: 'medium',
      serviceId: 'compliance-center',
      resourceType: 'Compliance Severity',
      identityKey: 'severity-medium',
      normalizedIdentity: makeComplianceIdentity('compliance-center', 'Compliance Severity', 'severity-medium', 'Medium severity findings'),
      focusModes: ['security', 'drift-compliance'],
      rationale: 'Medium-severity compliance pressure differs.',
      left: { value: String(left.compliance.summary.bySeverity.medium), secondary: '' },
      right: { value: String(right.compliance.summary.bySeverity.medium), secondary: '' },
      detailFields: fieldDetails(
        { medium: String(left.compliance.summary.bySeverity.medium) },
        { medium: String(right.compliance.summary.bySeverity.medium) }
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'compliance-center',
        region: left.descriptor.region,
        resourceLabel: 'medium-severity',
        identity: makeComplianceIdentity('compliance-center', 'Compliance Severity', 'severity-medium', 'Medium severity findings')
      }
    },
    {
      id: 'compliance:category:security',
      layer: 'posture',
      section: 'Compliance deltas',
      title: 'Security findings',
      subtitle: 'Category',
      status: left.compliance.summary.byCategory.security === right.compliance.summary.byCategory.security ? 'same' : 'different',
      risk: 'medium',
      serviceId: 'compliance-center',
      resourceType: 'Compliance Category',
      identityKey: 'category-security',
      normalizedIdentity: makeComplianceIdentity('compliance-center', 'Compliance Category', 'category-security', 'Security findings'),
      focusModes: ['security', 'drift-compliance'],
      rationale: 'Security-category compliance findings differ.',
      left: { value: String(left.compliance.summary.byCategory.security), secondary: '' },
      right: { value: String(right.compliance.summary.byCategory.security), secondary: '' },
      detailFields: fieldDetails(
        { security: String(left.compliance.summary.byCategory.security) },
        { security: String(right.compliance.summary.byCategory.security) }
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'compliance-center',
        region: left.descriptor.region,
        resourceLabel: 'security-findings',
        identity: makeComplianceIdentity('compliance-center', 'Compliance Category', 'category-security', 'Security findings')
      }
    },
    {
      id: 'compliance:category:cost',
      layer: 'posture',
      section: 'Compliance deltas',
      title: 'Cost findings',
      subtitle: 'Category',
      status: left.compliance.summary.byCategory.cost === right.compliance.summary.byCategory.cost ? 'same' : 'different',
      risk: 'low',
      serviceId: 'compliance-center',
      resourceType: 'Compliance Category',
      identityKey: 'category-cost',
      normalizedIdentity: makeComplianceIdentity('compliance-center', 'Compliance Category', 'category-cost', 'Cost findings'),
      focusModes: ['cost', 'drift-compliance'],
      rationale: 'Cost-oriented compliance findings differ.',
      left: { value: String(left.compliance.summary.byCategory.cost), secondary: '' },
      right: { value: String(right.compliance.summary.byCategory.cost), secondary: '' },
      detailFields: fieldDetails(
        { cost: String(left.compliance.summary.byCategory.cost) },
        { cost: String(right.compliance.summary.byCategory.cost) }
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'compliance-center',
        region: left.descriptor.region,
        resourceLabel: 'cost-findings',
        identity: makeComplianceIdentity('compliance-center', 'Compliance Category', 'category-cost', 'Cost findings')
      }
    }
  ]

  const serviceKeys = [...new Set([
    ...left.findings.map((item) => item.service),
    ...right.findings.map((item) => item.service)
  ])].sort((a, b) => a.localeCompare(b))

  const serviceRows = serviceKeys.map((serviceId) => {
    const leftCount = left.findings.filter((item) => item.service === serviceId).length
    const rightCount = right.findings.filter((item) => item.service === serviceId).length
    return {
      id: `compliance:service:${serviceId}`,
      layer: 'posture',
      section: 'Compliance deltas',
      title: `${serviceId} findings`,
      subtitle: 'Service',
      status: toStatus(leftCount > 0, rightCount > 0, leftCount === rightCount),
      risk: Math.max(leftCount, rightCount) >= 3 ? 'medium' : 'low',
      serviceId: serviceId as ServiceId,
      resourceType: 'Compliance Service Delta',
      identityKey: `service:${serviceId}`,
      normalizedIdentity: makeComplianceIdentity(serviceId as ServiceId, 'Compliance Service Delta', `service:${serviceId}`, `${serviceId} findings`),
      focusModes: ['security', 'drift-compliance', 'cost'],
      rationale: 'Service-specific compliance volume differs.',
      left: { value: String(leftCount), secondary: '' },
      right: { value: String(rightCount), secondary: '' },
      detailFields: fieldDetails(
        leftCount > 0 ? { findings: String(leftCount) } : undefined,
        rightCount > 0 ? { findings: String(rightCount) } : undefined
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'compliance-center',
        region: left.descriptor.region,
        resourceLabel: String(serviceId),
        identity: makeComplianceIdentity(serviceId as ServiceId, 'Compliance Service Delta', `service:${serviceId}`, `${serviceId} findings`)
      }
    } satisfies ComparisonDiffRow
  })

  const rows = [...metricRows, ...serviceRows]

  return {
    id: 'compliance-deltas',
    label: 'Compliance deltas',
    layer: 'posture',
    focusModes: ['security', 'drift-compliance', 'cost'],
    coverage: 'partial',
    counts: statusCounts(rows),
    rows: sortRows(rows)
  }
}

function buildTagGroup(left: ContextDataset, right: ContextDataset): ComparisonDiffGroup {
  const leftMap = new Map(left.inventory.filter((item) => item.tags).map((item) => [item.identityKey, item]))
  const rightMap = new Map(right.inventory.filter((item) => item.tags).map((item) => [item.identityKey, item]))
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort((a, b) => a.localeCompare(b))
  const rows = keys.map((key) => {
    const leftItem = leftMap.get(key)
    const rightItem = rightMap.get(key)
    const leftTags = Object.fromEntries(GOVERNANCE_TAG_KEYS.map((tagKey) => [tagKey, leftItem?.tags?.[tagKey] ?? '']))
    const rightTags = Object.fromEntries(GOVERNANCE_TAG_KEYS.map((tagKey) => [tagKey, rightItem?.tags?.[tagKey] ?? '']))
    const missing = GOVERNANCE_TAG_KEYS.some((tagKey) => !(leftItem?.tags?.[tagKey] ?? rightItem?.tags?.[tagKey] ?? '').trim())
    const source = leftItem ?? rightItem!
    const identityDataset = leftItem ? left : right
    const normalizedIdentity = makeResourceIdentity(identityDataset, source.serviceId, source.resourceType, key, source.title, source.region)

    return {
      id: `tags:${key}`,
      layer: 'tags',
      section: 'Tag / Ownership',
      title: source.title,
      subtitle: source.resourceType,
      status: toStatus(Boolean(leftItem), Boolean(rightItem), leftItem && rightItem ? attrsEqual(leftTags, rightTags) : false),
      risk: missing ? 'medium' : 'low',
      serviceId: source.serviceId,
      resourceType: source.resourceType,
      identityKey: key,
      normalizedIdentity,
      focusModes: ['security', 'drift-compliance', 'cost'],
      rationale: missing ? 'Governance tag coverage is incomplete.' : 'Ownership tags differ.',
      left: { value: leftItem?.tags?.Owner || 'Unassigned', secondary: leftItem?.tags?.Environment || '' },
      right: { value: rightItem?.tags?.Owner || 'Unassigned', secondary: rightItem?.tags?.Environment || '' },
      detailFields: fieldDetails(leftTags, rightTags),
      navigation: {
        providerId: normalizedIdentity.providerId,
        serviceId: source.serviceId,
        region: source.region,
        resourceLabel: source.title,
        identity: normalizedIdentity
      }
    } satisfies ComparisonDiffRow
  }).filter((row) => row.detailFields.length > 0)

  return {
    id: 'tags',
    label: 'Tag / Ownership',
    layer: 'tags',
    focusModes: ['security', 'drift-compliance', 'cost'],
    coverage: 'partial',
    counts: statusCounts(rows),
    rows: sortRows(rows)
  }
}

function buildCostGroup(left: ContextDataset, right: ContextDataset): ComparisonDiffGroup {
  const makeCostIdentity = (
    identityKey: string,
    resourceType: string,
    displayName: string,
    region = left.descriptor.region
  ) => makeResourceIdentity(left, 'overview', resourceType, identityKey, displayName, region)

  const costServices = [...new Set([
    ...left.costBreakdown.entries.map((entry) => entry.service),
    ...right.costBreakdown.entries.map((entry) => entry.service)
  ])].sort((a, b) => a.localeCompare(b))

  const rows: ComparisonDiffRow[] = [
    {
      id: 'cost:total',
      layer: 'cost',
      section: 'Cost / Signals',
      title: 'Estimated Monthly Cost',
      subtitle: left.costBreakdown.period || right.costBreakdown.period || 'current period',
      status: left.costBreakdown.total === right.costBreakdown.total ? 'same' : 'different',
      risk: Math.abs(left.costBreakdown.total - right.costBreakdown.total) >= 100 ? 'medium' : 'low',
      serviceId: 'overview',
      resourceType: 'Cost Summary',
      identityKey: 'monthly-total',
      normalizedIdentity: makeCostIdentity('monthly-total', 'Cost Summary', 'Estimated Monthly Cost'),
      focusModes: ['cost'],
      rationale: 'Estimated monthly spend differs.',
      left: { value: formatCurrency(left.costBreakdown.total), secondary: `${left.costBreakdown.entries.length} services` },
      right: { value: formatCurrency(right.costBreakdown.total), secondary: `${right.costBreakdown.entries.length} services` },
      detailFields: fieldDetails(
        { total: formatCurrency(left.costBreakdown.total), period: left.costBreakdown.period },
        { total: formatCurrency(right.costBreakdown.total), period: right.costBreakdown.period }
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'overview',
        region: left.descriptor.region,
        resourceLabel: 'overview',
        identity: makeCostIdentity('monthly-total', 'Cost Summary', 'Estimated Monthly Cost')
      }
    }
  ]

  for (const service of costServices) {
    const leftEntry = left.costBreakdown.entries.find((entry) => entry.service === service)
    const rightEntry = right.costBreakdown.entries.find((entry) => entry.service === service)
    const leftAmount = leftEntry?.amount ?? 0
    const rightAmount = rightEntry?.amount ?? 0
    rows.push({
      id: `cost:${service}`,
      layer: 'cost',
      section: 'Cost / Signals',
      title: service,
      subtitle: 'Service cost',
      status: toStatus(Boolean(leftEntry), Boolean(rightEntry), leftAmount === rightAmount),
      risk: Math.abs(leftAmount - rightAmount) >= 50 ? 'medium' : 'low',
      serviceId: 'overview',
      resourceType: 'Cost Entry',
      identityKey: service,
      normalizedIdentity: makeCostIdentity(service, 'Cost Entry', service),
      focusModes: ['cost'],
      rationale: 'Service cost differs.',
      left: { value: formatCurrency(leftAmount), secondary: '' },
      right: { value: formatCurrency(rightAmount), secondary: '' },
      detailFields: fieldDetails(leftEntry ? { amount: formatCurrency(leftAmount) } : undefined, rightEntry ? { amount: formatCurrency(rightAmount) } : undefined),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'overview',
        region: left.descriptor.region,
        resourceLabel: service,
        identity: makeCostIdentity(service, 'Cost Entry', service)
      }
    })
  }

  const leftSignalMap = new Map(left.statistics.signals.map((signal) => [`${signal.category}:${signal.title}`, signal]))
  const rightSignalMap = new Map(right.statistics.signals.map((signal) => [`${signal.category}:${signal.title}`, signal]))
  for (const key of [...new Set([...leftSignalMap.keys(), ...rightSignalMap.keys()])].sort((a, b) => a.localeCompare(b))) {
    const leftSignal = leftSignalMap.get(key)
    const rightSignal = rightSignalMap.get(key)
    const source = leftSignal ?? rightSignal!
    rows.push({
      id: `signal:${key}`,
      layer: 'cost',
      section: 'Cost / Signals',
      title: source.title,
      subtitle: source.category,
      status: toStatus(Boolean(leftSignal), Boolean(rightSignal), leftSignal && rightSignal ? leftSignal.severity === rightSignal.severity && leftSignal.description === rightSignal.description : false),
      risk: source.severity === 'high' ? 'high' : source.severity === 'medium' ? 'medium' : 'low',
      serviceId: 'overview',
      resourceType: 'Regional Signal',
      identityKey: key,
      normalizedIdentity: makeCostIdentity(key, 'Regional Signal', source.title, source.region),
      focusModes: source.category === 'cost' ? ['cost'] : ['security', 'drift-compliance'],
      rationale: source.nextStep,
      left: { value: leftSignal ? `${leftSignal.severity} ${leftSignal.region}` : 'Absent', secondary: leftSignal?.description ?? '' },
      right: { value: rightSignal ? `${rightSignal.severity} ${rightSignal.region}` : 'Absent', secondary: rightSignal?.description ?? '' },
      detailFields: fieldDetails(
        leftSignal ? { severity: leftSignal.severity, category: leftSignal.category, next_step: leftSignal.nextStep } : undefined,
        rightSignal ? { severity: rightSignal.severity, category: rightSignal.category, next_step: rightSignal.nextStep } : undefined
      ),
      navigation: {
        providerId: left.descriptor.normalizedIdentity.providerId,
        serviceId: 'overview',
        region: source.region,
        resourceLabel: source.title,
        identity: makeCostIdentity(key, 'Regional Signal', source.title, source.region)
      }
    })
  }

  return {
    id: 'cost',
    label: 'Cost / Signals',
    layer: 'cost',
    focusModes: ['cost', 'security', 'drift-compliance'],
    coverage: 'partial',
    counts: statusCounts(rows),
    rows: sortRows(rows)
  }
}

function buildSummary(left: ContextDataset, right: ContextDataset, groups: ComparisonDiffGroup[]): ComparisonSummary {
  const leftMetrics = left.metrics.regions[0]
  const rightMetrics = right.metrics.regions[0]
  const allRows = groups.flatMap((group) => group.rows)
  return {
    counts: statusCounts(allRows),
    totals: [
      {
        id: 'account',
        label: 'Account',
        leftValue: left.descriptor.accountId || '-',
        rightValue: right.descriptor.accountId || '-',
        status: left.descriptor.accountId === right.descriptor.accountId ? 'same' : 'different'
      },
      {
        id: 'region',
        label: 'Region',
        leftValue: left.descriptor.region,
        rightValue: right.descriptor.region,
        status: left.descriptor.region === right.descriptor.region ? 'same' : 'different'
      },
      {
        id: 'resources',
        label: 'Total Resources',
        leftValue: String(leftMetrics?.totalResources ?? left.metrics.globalTotals.totalResources),
        rightValue: String(rightMetrics?.totalResources ?? right.metrics.globalTotals.totalResources),
        status: (leftMetrics?.totalResources ?? left.metrics.globalTotals.totalResources) === (rightMetrics?.totalResources ?? right.metrics.globalTotals.totalResources) ? 'same' : 'different'
      },
      {
        id: 'cost',
        label: 'Monthly Cost',
        leftValue: formatCurrency(left.costBreakdown.total),
        rightValue: formatCurrency(right.costBreakdown.total),
        status: left.costBreakdown.total === right.costBreakdown.total ? 'same' : 'different'
      },
      {
        id: 'findings',
        label: 'Compliance Findings',
        leftValue: String(left.findings.length),
        rightValue: String(right.findings.length),
        status: left.findings.length === right.findings.length ? 'same' : 'different'
      },
      {
        id: 'signals',
        label: 'Signals',
        leftValue: String(left.statistics.signals.length),
        rightValue: String(right.statistics.signals.length),
        status: left.statistics.signals.length === right.statistics.signals.length ? 'same' : 'different'
      }
    ]
  }
}

function buildCoverage(): ComparisonCoverageItem[] {
  return [
    {
      id: 'inventory',
      label: 'Service inventory',
      layer: 'inventory',
      status: 'full',
      detail: 'Covers EC2, VPCs, subnets, security groups, load balancers, S3 buckets, Lambda, RDS, ECR, ACM, and regional WAF.'
    },
    {
      id: 'posture',
      label: 'Posture / findings',
      layer: 'posture',
      status: 'partial',
      detail: 'Uses Compliance Center findings plus explicit compliance summary deltas for severity, category, and per-service counts.'
    },
    {
      id: 'tags',
      label: 'Tag / ownership',
      layer: 'tags',
      status: 'partial',
      detail: 'Compares governance tags where the normalized inventory already exposes them, with clear partial coverage labeling.'
    },
    {
      id: 'cost',
      label: 'Cost / signals',
      layer: 'cost',
      status: 'partial',
      detail: 'Compares total estimated spend, per-service breakdown, and regional signals from the overview model.'
    }
  ]
}

function buildKeyDifferences(groups: ComparisonDiffGroup[]): ComparisonKeyDifferenceItem[] {
  return groups
    .flatMap((group) => group.rows)
    .filter((row) => row.status !== 'same')
    .sort((left, right) =>
      riskRank(right.risk) - riskRank(left.risk) ||
      left.title.localeCompare(right.title)
    )
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      title: row.title,
      layer: row.layer,
      risk: row.risk,
      serviceId: row.serviceId,
      status: row.status,
      summary: `${row.left.value} vs ${row.right.value}`
    }))
}

export async function runComparison(request: ComparisonRequest): Promise<ComparisonResult> {
  const [left, right] = await Promise.all([loadDataset(request.left), loadDataset(request.right)])
  const groups = [
    ...buildInventoryGroups(left, right),
    buildPostureGroup(left, right),
    buildComplianceDeltaGroup(left, right),
    buildTagGroup(left, right),
    buildCostGroup(left, right)
  ]

  return {
    generatedAt: new Date().toISOString(),
    leftContext: left.descriptor,
    rightContext: right.descriptor,
    coverage: buildCoverage(),
    summary: buildSummary(left, right, groups),
    keyDifferences: buildKeyDifferences(groups),
    groups
  }
}
