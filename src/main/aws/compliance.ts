import { DescribeAlarmsCommand, CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2'

import type {
  AwsConnection,
  ComplianceCategory,
  ComplianceFinding,
  ComplianceReport,
  ComplianceSeverity,
  ComplianceSummary,
  LoadBalancerWorkspace,
  SecretsManagerSecretSummary,
  ServiceId,
  WafWebAclSummary
} from '@shared/types'
import { awsClientConfig, readTags } from './client'
import { listTrails } from './cloudtrail'
import { listKeyPairs } from './keyPairs'
import { listLoadBalancerWorkspaces } from './loadBalancers'
import { listSecrets } from './secretsManager'
import { listSecurityGroups } from './securityGroups'
import { listVpcs } from './vpc'
import { describeWebAcl, listWebAcls } from './waf'

type Ec2InventoryItem = {
  instanceId: string
  name: string
  state: string
  keyName: string
  tags: Record<string, string>
}

type AlarmInventory = {
  count: number
}

type TaggableInventoryItem = {
  service: ServiceId
  resourceId: string
  name: string
  tags: Record<string, string>
}

const STOPPED_INSTANCE_WARNING_THRESHOLD = 3
const UNUSED_KEY_PAIR_WARNING_THRESHOLD = 5
const LARGE_KEY_PAIR_INVENTORY_THRESHOLD = 10
const VPC_SPRAWL_THRESHOLD = 3
const SECURITY_GROUP_SPRAWL_THRESHOLD = 20
const WEAK_TAGGING_RATIO_THRESHOLD = 0.35
const MIN_TAGGING_SAMPLE_SIZE = 6

const RISKY_PORTS = new Set([20, 21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 389, 443, 445, 1433, 1521, 2049, 2375, 2376, 3000, 3306, 3389, 5432, 5601, 5672, 6379, 8080, 8443, 9200, 9300, 27017])
const GOVERNANCE_TAG_KEYS = ['Name', 'Environment', 'Owner', 'Project', 'CostCenter']

function createEc2Client(connection: AwsConnection): EC2Client {
  return new EC2Client(awsClientConfig(connection))
}

function createCloudWatchClient(connection: AwsConnection): CloudWatchClient {
  return new CloudWatchClient(awsClientConfig(connection))
}

function createSummary(findings: ComplianceFinding[]): ComplianceSummary {
  const summary: ComplianceSummary = {
    total: findings.length,
    bySeverity: { high: 0, medium: 0, low: 0 },
    byCategory: { security: 0, cost: 0, operations: 0, compliance: 0 }
  }

  for (const finding of findings) {
    summary.bySeverity[finding.severity] += 1
    summary.byCategory[finding.category] += 1
  }

  return summary
}

function findingId(parts: Array<string | number | undefined>): string {
  return parts
    .filter((part): part is string | number => part !== undefined && part !== '')
    .join(':')
    .replace(/\s+/g, '-')
    .toLowerCase()
}

function formatResourceLabel(resourceId: string, name?: string): string {
  if (name && name !== '-' && name !== resourceId) {
    return `${name} (${resourceId})`
  }
  return resourceId
}

function isWideOpen(source: string): boolean {
  return source === '0.0.0.0/0' || source === '::/0'
}

function isRiskyRule(protocol: string, portRange: string): boolean {
  if (protocol === 'All') return true
  if (portRange === 'All') return true

  const [fromText, toText = fromText] = portRange.split('-')
  const from = Number(fromText)
  const to = Number(toText)

  if (Number.isNaN(from) || Number.isNaN(to)) {
    return false
  }

  for (const port of RISKY_PORTS) {
    if (port >= from && port <= to) {
      return true
    }
  }

  return false
}

function isWeakTagging(tags: Record<string, string>): boolean {
  const nonEmptyTags = Object.entries(tags).filter(([, value]) => value.trim())
  if (nonEmptyTags.length === 0) {
    return true
  }

  const governanceTagCount = GOVERNANCE_TAG_KEYS.filter((key) => Boolean(tags[key]?.trim())).length
  return governanceTagCount === 0 || (governanceTagCount === 1 && nonEmptyTags.length < 2)
}

async function loadSection<T>(
  warnings: string[],
  label: string,
  fallback: T,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    return fallback
  }
}

async function listEc2Inventory(connection: AwsConnection): Promise<Ec2InventoryItem[]> {
  const client = createEc2Client(connection)
  const items: Ec2InventoryItem[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(new DescribeInstancesCommand({ NextToken: nextToken }))
    for (const reservation of response.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const tags = readTags(instance.Tags)
        items.push({
          instanceId: instance.InstanceId ?? '',
          name: tags.Name ?? '',
          state: instance.State?.Name ?? '',
          keyName: instance.KeyName ?? '',
          tags
        })
      }
    }
    nextToken = response.NextToken
  } while (nextToken)

  return items
}

async function listAlarmInventory(connection: AwsConnection): Promise<AlarmInventory> {
  const client = createCloudWatchClient(connection)
  let nextToken: string | undefined
  let count = 0

  do {
    const response = await client.send(new DescribeAlarmsCommand({ NextToken: nextToken }))
    count += response.MetricAlarms?.length ?? 0
    nextToken = response.NextToken
  } while (nextToken)

  return { count }
}

async function listLoadBalancerAssociations(
  connection: AwsConnection,
  webAcls: WafWebAclSummary[]
): Promise<Set<string>> {
  const associations = new Set<string>()

  for (const acl of webAcls) {
    const detail = await describeWebAcl(connection, 'REGIONAL', acl.id, acl.name)
    for (const association of detail.associations) {
      associations.add(association.resourceArn)
    }
  }

  return associations
}

function buildTaggingSample(
  ec2Inventory: Ec2InventoryItem[],
  vpcs: Awaited<ReturnType<typeof listVpcs>>,
  securityGroups: Awaited<ReturnType<typeof listSecurityGroups>>,
  secrets: SecretsManagerSecretSummary[],
  keyPairs: Awaited<ReturnType<typeof listKeyPairs>>
): TaggableInventoryItem[] {
  return [
    ...ec2Inventory.map((item) => ({
      service: 'ec2' as const,
      resourceId: item.instanceId,
      name: item.name,
      tags: item.tags
    })),
    ...vpcs.map((vpc) => ({
      service: 'vpc' as const,
      resourceId: vpc.vpcId,
      name: vpc.name,
      tags: vpc.tags
    })),
    ...securityGroups.map((group) => ({
      service: 'security-groups' as const,
      resourceId: group.groupId,
      name: group.groupName,
      tags: group.tags
    })),
    ...secrets.map((secret) => ({
      service: 'secrets-manager' as const,
      resourceId: secret.arn || secret.name,
      name: secret.name,
      tags: secret.tags
    })),
    ...keyPairs.map((pair) => ({
      service: 'key-pairs' as const,
      resourceId: pair.keyPairId || pair.keyName,
      name: pair.keyName,
      tags: pair.tags
    }))
  ]
}

function addFinding(
  findings: ComplianceFinding[],
  finding: Omit<ComplianceFinding, 'id'> & { idParts: Array<string | number | undefined> }
): void {
  findings.push({
    id: findingId(finding.idParts),
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    service: finding.service,
    region: finding.region,
    resourceId: finding.resourceId,
    description: finding.description,
    recommendedAction: finding.recommendedAction,
    remediation: finding.remediation
  })
}

export async function getComplianceReport(connection: AwsConnection): Promise<ComplianceReport> {
  const warnings: string[] = []
  const region = connection.region
  const findings: ComplianceFinding[] = []

  const [
    trails,
    ec2Inventory,
    alarmInventory,
    loadBalancers,
    webAcls,
    securityGroups,
    secrets,
    keyPairs,
    vpcs
  ] = await Promise.all([
    loadSection(warnings, 'CloudTrail inventory', [] as Awaited<ReturnType<typeof listTrails>>, () => listTrails(connection)),
    loadSection(warnings, 'EC2 inventory', [] as Ec2InventoryItem[], () => listEc2Inventory(connection)),
    loadSection(warnings, 'CloudWatch alarms', { count: 0 }, () => listAlarmInventory(connection)),
    loadSection(warnings, 'Load balancers', [] as LoadBalancerWorkspace[], () => listLoadBalancerWorkspaces(connection)),
    loadSection(warnings, 'WAF web ACLs', [] as WafWebAclSummary[], () => listWebAcls(connection, 'REGIONAL')),
    loadSection(warnings, 'Security groups', [] as Awaited<ReturnType<typeof listSecurityGroups>>, () => listSecurityGroups(connection)),
    loadSection(warnings, 'Secrets Manager', [] as SecretsManagerSecretSummary[], () => listSecrets(connection)),
    loadSection(warnings, 'Key pairs', [] as Awaited<ReturnType<typeof listKeyPairs>>, () => listKeyPairs(connection)),
    loadSection(warnings, 'VPC inventory', [] as Awaited<ReturnType<typeof listVpcs>>, () => listVpcs(connection))
  ])

  const wafAssociations = await loadSection(warnings, 'WAF associations', new Set<string>(), () =>
    listLoadBalancerAssociations(connection, webAcls)
  )

  const activeTrails = trails.filter((trail) => trail.isLogging)
  if (trails.length === 0 || activeTrails.length === 0) {
    addFinding(findings, {
      idParts: ['compliance', 'cloudtrail', region],
      title: 'CloudTrail audit logging is not configured',
      severity: 'high',
      category: 'compliance',
      service: 'cloudtrail',
      region,
      resourceId: '',
      description: trails.length === 0
        ? `No CloudTrail trails were discovered in ${region}.`
        : `CloudTrail trails exist in ${region}, but none are actively logging.`,
      recommendedAction: 'Enable a logging CloudTrail trail with centralized S3 storage and log file validation.',
      remediation: {
        kind: 'navigate',
        label: 'Open CloudTrail',
        serviceId: 'cloudtrail'
      }
    })
  }

  if (ec2Inventory.length > 0 && alarmInventory.count === 0) {
    addFinding(findings, {
      idParts: ['compliance', 'cloudwatch-alarms', region],
      title: 'CloudWatch alarms are missing while EC2 resources exist',
      severity: 'medium',
      category: 'operations',
      service: 'cloudwatch',
      region,
      resourceId: String(ec2Inventory.length),
      description: `${ec2Inventory.length} EC2 instance${ec2Inventory.length === 1 ? '' : 's'} were discovered in ${region}, but no CloudWatch alarms were found.`,
      recommendedAction: 'Create health, CPU, and status-check alarms for the active EC2 fleet.',
      remediation: {
        kind: 'navigate',
        label: 'Open CloudWatch',
        serviceId: 'cloudwatch'
      }
    })
  }

  for (const loadBalancer of loadBalancers) {
    if (!wafAssociations.has(loadBalancer.summary.arn)) {
      addFinding(findings, {
        idParts: ['compliance', 'lb-without-waf', loadBalancer.summary.arn],
        title: 'Load balancer has no WAF association',
        severity: 'medium',
        category: 'security',
        service: 'waf',
        region,
        resourceId: loadBalancer.summary.name || loadBalancer.summary.arn,
        description: `${formatResourceLabel(loadBalancer.summary.arn, loadBalancer.summary.name)} is not associated with a regional WAF web ACL.`,
        recommendedAction: 'Review the load balancer exposure and attach an appropriate WAF web ACL before enabling additional public traffic.',
        remediation: {
          kind: 'navigate',
          label: 'Open WAF',
          serviceId: 'waf',
          resourceId: loadBalancer.summary.arn
        }
      })
    }
  }

  for (const group of securityGroups) {
    const riskyOpenRules = group.inboundRules.filter((rule) => isWideOpen(rule.source) && isRiskyRule(rule.protocol, rule.portRange))
    if (riskyOpenRules.length === 0) {
      continue
    }

    const exposedPorts = [...new Set(riskyOpenRules.map((rule) => `${rule.protocol}/${rule.portRange}`))].join(', ')
    addFinding(findings, {
      idParts: ['compliance', 'sg-open', group.groupId],
      title: 'Security group exposes risky inbound ports to the internet',
      severity: 'high',
      category: 'security',
      service: 'security-groups',
      region,
      resourceId: group.groupId,
      description: `${formatResourceLabel(group.groupId, group.groupName)} allows ${exposedPorts} from 0.0.0.0/0 or ::/0.`,
      recommendedAction: 'Restrict the rule scope to trusted CIDR ranges or private security group references.',
      remediation: {
        kind: 'navigate',
        label: 'Open Security Groups',
        serviceId: 'security-groups',
        resourceId: group.groupId
      }
    })
  }

  for (const secret of secrets) {
    if (secret.rotationEnabled) {
      continue
    }

    addFinding(findings, {
      idParts: ['compliance', 'secret-rotation', secret.arn || secret.name],
      title: 'Secret rotation is disabled',
      severity: 'medium',
      category: 'security',
      service: 'secrets-manager',
      region,
      resourceId: secret.name || secret.arn,
      description: `${secret.name} does not have automatic rotation enabled.`,
      recommendedAction: 'Enable rotation for credentials and API secrets that can be rotated safely.',
      remediation: {
        kind: 'secret-rotate',
        label: 'Rotate Secret',
        secretId: secret.arn || secret.name
      }
    })
  }

  const stoppedInstances = ec2Inventory.filter((instance) => instance.state === 'stopped')
  if (stoppedInstances.length > STOPPED_INSTANCE_WARNING_THRESHOLD) {
    addFinding(findings, {
      idParts: ['compliance', 'stopped-ec2', region],
      title: 'Stopped EC2 inventory exceeds the review threshold',
      severity: stoppedInstances.length > STOPPED_INSTANCE_WARNING_THRESHOLD + 3 ? 'high' : 'medium',
      category: 'cost',
      service: 'ec2',
      region,
      resourceId: String(stoppedInstances.length),
      description: `${stoppedInstances.length} stopped EC2 instance${stoppedInstances.length === 1 ? '' : 's'} were found in ${region}. Example: ${stoppedInstances.slice(0, 3).map((instance) => formatResourceLabel(instance.instanceId, instance.name)).join(', ')}.`,
      recommendedAction: 'Review stopped instances and terminate or restart only the ones that still serve an operational purpose.',
      remediation: {
        kind: 'navigate',
        label: 'Open EC2',
        serviceId: 'ec2'
      }
    })
  }

  const usedKeyNames = new Set(ec2Inventory.map((instance) => instance.keyName).filter(Boolean))
  const unusedKeyPairs = keyPairs.filter((pair) => !usedKeyNames.has(pair.keyName))
  if (keyPairs.length > LARGE_KEY_PAIR_INVENTORY_THRESHOLD || unusedKeyPairs.length > UNUSED_KEY_PAIR_WARNING_THRESHOLD) {
    addFinding(findings, {
      idParts: ['compliance', 'key-pair-inventory', region],
      title: 'Key pair inventory looks oversized for the active fleet',
      severity: keyPairs.length > LARGE_KEY_PAIR_INVENTORY_THRESHOLD + 10 ? 'medium' : 'low',
      category: 'operations',
      service: 'key-pairs',
      region,
      resourceId: String(keyPairs.length),
      description: `${keyPairs.length} key pairs were found in ${region}; ${unusedKeyPairs.length} of them do not match any discovered EC2 instance key name.`,
      recommendedAction: 'Audit the key pair inventory, confirm ownership, and delete only keys that are no longer referenced by active access workflows.',
      remediation: {
        kind: 'navigate',
        label: 'Open Key Pairs',
        serviceId: 'key-pairs'
      }
    })
  }

  if (vpcs.length > VPC_SPRAWL_THRESHOLD) {
    addFinding(findings, {
      idParts: ['compliance', 'vpc-sprawl', region],
      title: 'VPC inventory indicates network sprawl',
      severity: 'medium',
      category: 'operations',
      service: 'vpc',
      region,
      resourceId: String(vpcs.length),
      description: `${vpcs.length} VPCs were found in ${region}, which matches the existing overview sprawl threshold.`,
      recommendedAction: 'Review whether each VPC still hosts distinct workloads and consolidate only when routing, security, and ownership are clear.',
      remediation: {
        kind: 'navigate',
        label: 'Open VPC',
        serviceId: 'vpc'
      }
    })
  }

  if (securityGroups.length > SECURITY_GROUP_SPRAWL_THRESHOLD) {
    addFinding(findings, {
      idParts: ['compliance', 'sg-sprawl', region],
      title: 'Security group inventory indicates sprawl',
      severity: 'medium',
      category: 'operations',
      service: 'security-groups',
      region,
      resourceId: String(securityGroups.length),
      description: `${securityGroups.length} security groups were found in ${region}, exceeding the overview signal threshold.`,
      recommendedAction: 'Identify duplicate or detached groups and consolidate rulesets before deleting anything that could still be attached.',
      remediation: {
        kind: 'navigate',
        label: 'Open Security Groups',
        serviceId: 'security-groups'
      }
    })
  }

  const taggingSample = buildTaggingSample(ec2Inventory, vpcs, securityGroups, secrets, keyPairs)
  const weakTaggedResources = taggingSample.filter((item) => isWeakTagging(item.tags))
  if (taggingSample.length >= MIN_TAGGING_SAMPLE_SIZE && weakTaggedResources.length / taggingSample.length >= WEAK_TAGGING_RATIO_THRESHOLD) {
    const mostCommonService = weakTaggedResources.reduce<Record<string, number>>((acc, item) => {
      acc[item.service] = (acc[item.service] ?? 0) + 1
      return acc
    }, {})
    const primaryService = (Object.entries(mostCommonService).sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'overview') as ServiceId

    addFinding(findings, {
      idParts: ['compliance', 'weak-tagging', region],
      title: 'Tagging coverage is weak across supported resources',
      severity: 'medium',
      category: 'compliance',
      service: primaryService,
      region,
      resourceId: `${weakTaggedResources.length}/${taggingSample.length}`,
      description: `${weakTaggedResources.length} of ${taggingSample.length} sampled resources are missing governance-oriented tags such as ${GOVERNANCE_TAG_KEYS.join(', ')}.`,
      recommendedAction: 'Review tagging standards for ownership, environment, and cost attribution before enforcing stricter automation.',
      remediation: {
        kind: 'terminal',
        label: 'Open Tag Audit Command',
        command: `aws resourcegroupstaggingapi get-resources --region ${region}`
      }
    })
  }

  findings.sort((left, right) => {
    const severityOrder: Record<ComplianceSeverity, number> = { high: 0, medium: 1, low: 2 }
    const severityDelta = severityOrder[left.severity] - severityOrder[right.severity]
    if (severityDelta !== 0) {
      return severityDelta
    }
    const categoryOrder: Record<ComplianceCategory, number> = {
      security: 0,
      compliance: 1,
      operations: 2,
      cost: 3
    }
    const categoryDelta = categoryOrder[left.category] - categoryOrder[right.category]
    if (categoryDelta !== 0) {
      return categoryDelta
    }
    return left.title.localeCompare(right.title)
  })

  return {
    generatedAt: new Date().toISOString(),
    findings,
    summary: createSummary(findings),
    warnings
  }
}
