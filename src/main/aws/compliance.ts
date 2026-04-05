import { DescribeAlarmsCommand, CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2'

import type {
  AwsConnection,
  ComplianceCategory,
  ComplianceFinding,
  CompliancePolicyPack,
  ComplianceReport,
  ComplianceRemediationTemplate,
  ComplianceSeverity,
  ComplianceSummary,
  GovernanceTagKey,
  LoadBalancerWorkspace,
  RdsClusterDetail,
  RdsInstanceDetail,
  SecretsManagerSecretSummary,
  ServiceId,
  TerraformGovernanceCheckResult,
  TerraformGovernanceFinding,
  TerraformProjectListItem,
  WafWebAclSummary
} from '@shared/types'
import { awsClientConfig, readTags } from './client'
import { listTrails } from './cloudtrail'
import { listKeyPairs } from './keyPairs'
import { listLoadBalancerWorkspaces } from './loadBalancers'
import { describeDbCluster, describeDbInstance, listDbClusters, listDbInstances } from './rds'
import { listSecrets } from './secretsManager'
import { listBucketGovernance } from './s3'
import { listSecurityGroups } from './securityGroups'
import { listVpcs } from './vpc'
import { describeWebAcl, listWebAcls } from './waf'
import { getComplianceFindingWorkflow, getCompliancePolicyPacks, getGovernanceTagDefaults } from '../phase1FoundationStore'
import { listProjectSummaries } from '../terraform'
import { getGovernanceReport } from '../terraformGovernance'

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

type ComplianceFindingRecord = Omit<ComplianceFinding, 'workflow'>

const STOPPED_INSTANCE_WARNING_THRESHOLD = 3
const UNUSED_KEY_PAIR_WARNING_THRESHOLD = 5
const LARGE_KEY_PAIR_INVENTORY_THRESHOLD = 10
const VPC_SPRAWL_THRESHOLD = 3
const SECURITY_GROUP_SPRAWL_THRESHOLD = 20
const WEAK_TAGGING_RATIO_THRESHOLD = 0.35
const MIN_TAGGING_SAMPLE_SIZE = 6
const MIN_RDS_BACKUP_RETENTION_DAYS = 7
const TERRAFORM_REGION_FALLBACK = 'global'

const RISKY_PORTS = new Set([20, 21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 389, 443, 445, 1433, 1521, 2049, 2375, 2376, 3000, 3306, 3389, 5432, 5601, 5672, 6379, 8080, 8443, 9200, 9300, 27017])
const GOVERNANCE_TAG_KEYS = ['Name', 'Environment', 'Owner', 'Project', 'CostCenter']

function createEc2Client(connection: AwsConnection): EC2Client {
  return new EC2Client(awsClientConfig(connection))
}

function createCloudWatchClient(connection: AwsConnection): CloudWatchClient {
  return new CloudWatchClient(awsClientConfig(connection))
}

function createSummary(findings: Array<Pick<ComplianceFinding, 'severity' | 'category'>>): ComplianceSummary {
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
  findings: ComplianceFindingRecord[],
  finding: Omit<ComplianceFindingRecord, 'id'> & { idParts: Array<string | number | undefined> }
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
    policyPackIds: finding.policyPackIds,
    remediation: finding.remediation
  })
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  mapper: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length)
  let index = 0

  async function worker(): Promise<void> {
    while (true) {
      const current = index
      index += 1
      if (current >= items.length) {
        return
      }
      results[current] = await mapper(items[current])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

function severityRank(value: ComplianceSeverity): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1
}

function maxSeverity(left: ComplianceSeverity, right: ComplianceSeverity): ComplianceSeverity {
  return severityRank(left) >= severityRank(right) ? left : right
}

function complianceProfileName(connection: AwsConnection): string {
  return connection.kind === 'assumed-role' ? connection.sourceProfile : connection.profile
}

function normalizeTerraformSeverity(
  severity: TerraformGovernanceFinding['severity']
): ComplianceSeverity {
  if (severity === 'critical' || severity === 'high') {
    return 'high'
  }
  if (severity === 'medium') {
    return 'medium'
  }
  return 'low'
}

function terraformCheckSeverity(check: TerraformGovernanceCheckResult): ComplianceSeverity {
  if (check.findings.length > 0) {
    return check.findings.reduce<ComplianceSeverity>(
      (current, finding) => maxSeverity(current, normalizeTerraformSeverity(finding.severity)),
      'low'
    )
  }

  if (check.status === 'error') {
    return check.blocking ? 'high' : 'medium'
  }

  return check.blocking ? 'medium' : 'low'
}

function terraformCheckCategory(check: TerraformGovernanceCheckResult): ComplianceCategory {
  if (check.toolId === 'tfsec' || check.toolId === 'checkov') {
    return 'security'
  }
  if (check.toolId === 'validate') {
    return 'compliance'
  }
  return 'operations'
}

function terraformPolicyPackIds(
  check: TerraformGovernanceCheckResult,
  finding?: TerraformGovernanceFinding
): string[] | undefined {
  const source = `${check.summary} ${finding?.ruleId ?? ''} ${finding?.message ?? ''}`.toLowerCase()
  const packIds = new Set<string>()

  if (/(tag|label|costcenter|cost center|owner|environment|project)/.test(source)) {
    packIds.add('tagging-defaults')
  }
  if (/(encrypt|encryption|kms|cipher|sse|cmk)/.test(source)) {
    packIds.add('encryption-baseline')
  }
  if (/(public|internet|0\.0\.0\.0\/0|::\/0|security group|ingress|exposure|exposed|open port|waf)/.test(source)) {
    packIds.add('public-exposure-guardrails')
  }
  if (/(backup|retention|snapshot|recovery|versioning|restore)/.test(source)) {
    packIds.add('backup-resilience')
  }

  return packIds.size > 0 ? [...packIds] : undefined
}

function terraformResourceId(
  project: TerraformProjectListItem,
  finding?: TerraformGovernanceFinding
): string {
  if (finding) {
    return `${project.name}:${finding.file}:${finding.line}`
  }
  return project.name
}

function addTerraformGovernanceFindings(
  findings: ComplianceFindingRecord[],
  projects: TerraformProjectListItem[]
): void {
  for (const project of projects) {
    const report = getGovernanceReport(project.id)
    if (!report) {
      continue
    }

    const region = project.environment.region || TERRAFORM_REGION_FALLBACK
    const workspace = project.environment.workspaceName || project.currentWorkspace || 'default'

    for (const check of report.checks) {
      if (check.status === 'passed' || check.status === 'skipped') {
        continue
      }

      if (check.findings.length === 0) {
        addFinding(findings, {
          idParts: ['compliance', 'terraform', project.id, check.toolId, check.status],
          title: `${project.name}: ${check.label} requires review`,
          severity: terraformCheckSeverity(check),
          category: terraformCheckCategory(check),
          service: 'terraform',
          region,
          resourceId: terraformResourceId(project),
          description: `${check.label} returned ${check.status} for workspace ${workspace}. Summary: ${check.summary}`,
          recommendedAction: `Review the ${check.label} output for ${project.name}, fix the underlying Terraform issue, then rerun governance checks before treating the workspace as clean.`,
          policyPackIds: terraformPolicyPackIds(check),
          remediation: {
            kind: 'navigate',
            label: 'Open Terraform',
            serviceId: 'terraform'
          }
        })
        continue
      }

      for (const finding of check.findings) {
        addFinding(findings, {
          idParts: ['compliance', 'terraform', project.id, check.toolId, finding.ruleId, finding.file, finding.line],
          title: `${project.name}: ${finding.ruleId}`,
          severity: normalizeTerraformSeverity(finding.severity),
          category: terraformCheckCategory(check),
          service: 'terraform',
          region,
          resourceId: terraformResourceId(project, finding),
          description: `${check.label} flagged ${finding.message} in ${finding.file}:${finding.line} for workspace ${workspace}.`,
          recommendedAction: `Update the Terraform code in ${finding.file}:${finding.line}, rerun ${check.label}, and only keep exceptions that are explicitly reviewed.`,
          policyPackIds: terraformPolicyPackIds(check, finding),
          remediation: {
            kind: 'navigate',
            label: 'Open Terraform',
            serviceId: 'terraform'
          }
        })
      }
    }
  }
}

function buildRemediationTemplates(finding: ComplianceFindingRecord): ComplianceRemediationTemplate[] {
  const resourceId = finding.resourceId || '<resource-id>'
  const region = finding.region

  switch (finding.service) {
    case 'terraform':
      return [{
        id: `${finding.id}:terraform`,
        title: 'Re-run governance checks locally',
        summary: 'Inspect the Terraform workspace, then rerun validation and policy tooling before accepting the finding as reviewed.',
        commands: [
          {
            label: 'Template fmt check',
            command: 'terraform fmt -check -recursive'
          },
          {
            label: 'Template validate',
            command: 'terraform validate'
          },
          {
            label: 'Template security scan',
            command: 'tfsec .'
          }
        ]
      }]
    case 'security-groups':
      return [{
        id: `${finding.id}:security-group`,
        title: 'Restrict public ingress',
        summary: 'Inspect the security group and remove or narrow internet-facing ingress rules before keeping the finding open.',
        commands: [
          {
            label: 'Inspect group',
            command: `aws ec2 describe-security-groups --group-ids ${resourceId} --region ${region}`
          },
          {
            label: 'Review attached ENIs',
            command: `aws ec2 describe-network-interfaces --filters Name=group-id,Values=${resourceId} --region ${region}`
          },
          {
            label: 'Template revoke command',
            command: `aws ec2 revoke-security-group-ingress --group-id ${resourceId} --protocol tcp --port 22 --cidr 0.0.0.0/0 --region ${region}`
          }
        ]
      }]
    case 's3':
      return [{
        id: `${finding.id}:s3`,
        title: 'Harden bucket baseline',
        summary: 'Verify the bucket posture, then apply the matching encryption, public-access, or versioning change in the active region.',
        commands: [
          {
            label: 'Inspect bucket posture',
            command: `aws s3api get-bucket-encryption --bucket ${resourceId} --region ${region}`
          },
          {
            label: 'Check public access block',
            command: `aws s3api get-public-access-block --bucket ${resourceId} --region ${region}`
          },
          {
            label: 'Template enable versioning',
            command: `aws s3api put-bucket-versioning --bucket ${resourceId} --versioning-configuration Status=Enabled --region ${region}`
          }
        ]
      }]
    case 'rds':
      return [{
        id: `${finding.id}:rds`,
        title: 'Review database posture',
        summary: 'Inspect the current database posture, then adjust retention or network exposure. Encryption gaps usually require restore-or-replace planning.',
        commands: [
          {
            label: 'Inspect instance',
            command: `aws rds describe-db-instances --db-instance-identifier ${resourceId} --region ${region}`
          },
          {
            label: 'Inspect cluster',
            command: `aws rds describe-db-clusters --db-cluster-identifier ${resourceId} --region ${region}`
          },
          {
            label: 'Template raise backup retention',
            command: `aws rds modify-db-instance --db-instance-identifier ${resourceId} --backup-retention-period 7 --apply-immediately --region ${region}`
          }
        ]
      }]
    case 'secrets-manager':
      return [{
        id: `${finding.id}:secret`,
        title: 'Rotate or verify secret',
        summary: 'Review rotation state and dependency context before rotating the secret or attaching an automated rotation workflow.',
        commands: [
          {
            label: 'Inspect secret',
            command: `aws secretsmanager describe-secret --secret-id ${resourceId} --region ${region}`
          },
          {
            label: 'List current version ids',
            command: `aws secretsmanager list-secret-version-ids --secret-id ${resourceId} --region ${region}`
          },
          {
            label: 'Template rotate secret',
            command: `aws secretsmanager rotate-secret --secret-id ${resourceId} --region ${region}`
          }
        ]
      }]
    case 'cloudtrail':
      return [{
        id: `${finding.id}:cloudtrail`,
        title: 'Restore audit logging',
        summary: 'Confirm trail coverage, then enable or create a centralized trail with logging turned on.',
        commands: [
          {
            label: 'List trails',
            command: `aws cloudtrail describe-trails --include-shadow-trails --region ${region}`
          },
          {
            label: 'Check trail status',
            command: `aws cloudtrail get-trail-status --name <trail-name> --region ${region}`
          },
          {
            label: 'Template start logging',
            command: `aws cloudtrail start-logging --name <trail-name> --region ${region}`
          }
        ]
      }]
    case 'waf':
      return [{
        id: `${finding.id}:waf`,
        title: 'Attach a WAF web ACL',
        summary: 'Inspect current WAF association state, then attach the expected regional web ACL for the exposed load balancer.',
        commands: [
          {
            label: 'Check current association',
            command: `aws wafv2 get-web-acl-for-resource --resource-arn ${resourceId} --region ${region}`
          },
          {
            label: 'List available ACLs',
            command: `aws wafv2 list-web-acls --scope REGIONAL --region ${region}`
          },
          {
            label: 'Template associate ACL',
            command: `aws wafv2 associate-web-acl --web-acl-arn <web-acl-arn> --resource-arn ${resourceId} --region ${region}`
          }
        ]
      }]
    default:
      return [{
        id: `${finding.id}:generic`,
        title: 'Investigate and remediate',
        summary: 'Inspect the affected service resource in the active region, then execute the matching remediation in the terminal with the current AWS context.',
        commands: [
          {
            label: 'Describe current state',
            command: `aws ${finding.service} help`
          },
          {
            label: 'Context check',
            command: `aws sts get-caller-identity --region ${region}`
          }
        ]
      }]
  }
}

function complianceScopeKey(connection: AwsConnection): string {
  return connection.kind === 'assumed-role'
    ? [connection.sourceProfile, connection.roleArn, connection.accountId, connection.region].join('::')
    : [connection.profile, connection.region].join('::')
}

export async function getComplianceReport(connection: AwsConnection): Promise<ComplianceReport> {
  const warnings: string[] = []
  const region = connection.region
  const findings: ComplianceFindingRecord[] = []
  const scopeKey = complianceScopeKey(connection)
  const profileName = complianceProfileName(connection)
  const governanceDefaults = getGovernanceTagDefaults()
  const policyPackDefinitions = getCompliancePolicyPacks()

  const [
    trails,
    ec2Inventory,
    alarmInventory,
    loadBalancers,
    webAcls,
    securityGroups,
    secrets,
    keyPairs,
    vpcs,
    s3Governance,
    rdsInstanceSummaries,
    rdsClusterSummaries
  ] = await Promise.all([
    loadSection(warnings, 'CloudTrail inventory', [] as Awaited<ReturnType<typeof listTrails>>, () => listTrails(connection)),
    loadSection(warnings, 'EC2 inventory', [] as Ec2InventoryItem[], () => listEc2Inventory(connection)),
    loadSection(warnings, 'CloudWatch alarms', { count: 0 }, () => listAlarmInventory(connection)),
    loadSection(warnings, 'Load balancers', [] as LoadBalancerWorkspace[], () => listLoadBalancerWorkspaces(connection)),
    loadSection(warnings, 'WAF web ACLs', [] as WafWebAclSummary[], () => listWebAcls(connection, 'REGIONAL')),
    loadSection(warnings, 'Security groups', [] as Awaited<ReturnType<typeof listSecurityGroups>>, () => listSecurityGroups(connection)),
    loadSection(warnings, 'Secrets Manager', [] as SecretsManagerSecretSummary[], () => listSecrets(connection)),
    loadSection(warnings, 'Key pairs', [] as Awaited<ReturnType<typeof listKeyPairs>>, () => listKeyPairs(connection)),
    loadSection(warnings, 'VPC inventory', [] as Awaited<ReturnType<typeof listVpcs>>, () => listVpcs(connection)),
    loadSection(warnings, 'S3 governance', null as Awaited<ReturnType<typeof listBucketGovernance>> | null, () => listBucketGovernance(connection)),
    loadSection(warnings, 'RDS instances', [] as Awaited<ReturnType<typeof listDbInstances>>, () => listDbInstances(connection)),
    loadSection(warnings, 'RDS clusters', [] as Awaited<ReturnType<typeof listDbClusters>>, () => listDbClusters(connection))
  ])

  const [rdsInstances, rdsClusters] = await Promise.all([
    loadSection(warnings, 'RDS instance posture', [] as RdsInstanceDetail[], () =>
      mapWithConcurrency(rdsInstanceSummaries, 3, (instance) => describeDbInstance(connection, instance.dbInstanceIdentifier))
    ),
    loadSection(warnings, 'RDS cluster posture', [] as RdsClusterDetail[], () =>
      mapWithConcurrency(rdsClusterSummaries, 3, (cluster) => describeDbCluster(connection, cluster.dbClusterIdentifier))
    )
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
      policyPackIds: ['backup-resilience'],
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
        policyPackIds: ['public-exposure-guardrails'],
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
      policyPackIds: ['public-exposure-guardrails'],
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
      policyPackIds: ['encryption-baseline'],
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
      description: `${weakTaggedResources.length} of ${taggingSample.length} sampled resources are missing governance-oriented tags such as ${GOVERNANCE_TAG_KEYS.join(', ')}. Current defaults: ${GOVERNANCE_TAG_KEYS.map((key) => `${key}=${governanceDefaults.values[key as GovernanceTagKey] || '<unset>'}`).join(', ')}.`,
      recommendedAction: 'Review tagging standards for ownership, environment, and cost attribution before enforcing stricter automation.',
      policyPackIds: ['tagging-defaults'],
      remediation: {
        kind: 'terminal',
        label: 'Open Tag Audit Command',
        command: `aws resourcegroupstaggingapi get-resources --region ${region}`
      }
    })
  }

  for (const bucket of s3Governance?.buckets ?? []) {
    if (bucket.encryption.status !== 'enabled') {
      addFinding(findings, {
        idParts: ['compliance', 'bucket-encryption', bucket.bucketName],
        title: 'S3 bucket does not meet encryption baseline',
        severity: bucket.encryption.status === 'unknown' ? 'medium' : 'high',
        category: 'security',
        service: 's3',
        region: bucket.region,
        resourceId: bucket.bucketName,
        description: bucket.encryption.summary,
        recommendedAction: 'Enable default encryption on the bucket and verify the selected SSE mode matches local policy.',
        policyPackIds: ['encryption-baseline'],
        remediation: {
          kind: 'navigate',
          label: 'Open S3',
          serviceId: 's3',
          resourceId: bucket.bucketName
        }
      })
    }

    if (bucket.publicAccessBlock.status !== 'enabled') {
      addFinding(findings, {
        idParts: ['compliance', 'bucket-public-access', bucket.bucketName],
        title: 'S3 bucket does not meet public exposure guardrails',
        severity: bucket.publicAccessBlock.status === 'unknown' ? 'medium' : 'high',
        category: 'security',
        service: 's3',
        region: bucket.region,
        resourceId: bucket.bucketName,
        description: bucket.publicAccessBlock.summary,
        recommendedAction: 'Enable all public access block controls unless the bucket is intentionally public and approved.',
        policyPackIds: ['public-exposure-guardrails'],
        remediation: {
          kind: 'navigate',
          label: 'Open S3',
          serviceId: 's3',
          resourceId: bucket.bucketName
        }
      })
    }

    if (bucket.important && bucket.versioning.status !== 'enabled') {
      addFinding(findings, {
        idParts: ['compliance', 'bucket-versioning', bucket.bucketName],
        title: 'Important S3 bucket misses the backup resilience baseline',
        severity: bucket.versioning.status === 'unknown' ? 'medium' : 'high',
        category: 'compliance',
        service: 's3',
        region: bucket.region,
        resourceId: bucket.bucketName,
        description: `${bucket.versioning.summary} ${bucket.importantReason}`.trim(),
        recommendedAction: 'Enable versioning so rollback and recovery remain available for important bucket contents.',
        policyPackIds: ['backup-resilience'],
        remediation: {
          kind: 'navigate',
          label: 'Open S3',
          serviceId: 's3',
          resourceId: bucket.bucketName
        }
      })
    }
  }

  for (const instance of rdsInstances) {
    if (!instance.storageEncrypted) {
      addFinding(findings, {
        idParts: ['compliance', 'rds-encryption', instance.summary.dbInstanceIdentifier],
        title: 'RDS instance does not meet encryption baseline',
        severity: 'high',
        category: 'security',
        service: 'rds',
        region,
        resourceId: instance.summary.dbInstanceIdentifier,
        description: `${instance.summary.dbInstanceIdentifier} has storage encryption disabled.`,
        recommendedAction: 'Use an encrypted replacement path or snapshot-restore workflow to bring the instance under the local encryption baseline.',
        policyPackIds: ['encryption-baseline'],
        remediation: {
          kind: 'navigate',
          label: 'Open RDS',
          serviceId: 'rds',
          resourceId: instance.summary.dbInstanceIdentifier
        }
      })
    }

    if (instance.publiclyAccessible) {
      addFinding(findings, {
        idParts: ['compliance', 'rds-public', instance.summary.dbInstanceIdentifier],
        title: 'RDS instance is publicly accessible',
        severity: 'high',
        category: 'security',
        service: 'rds',
        region,
        resourceId: instance.summary.dbInstanceIdentifier,
        description: `${instance.summary.dbInstanceIdentifier} exposes a public endpoint, which conflicts with the local public exposure guardrail.`,
        recommendedAction: 'Move the instance behind private networking and verify only trusted operators or workloads can reach it.',
        policyPackIds: ['public-exposure-guardrails'],
        remediation: {
          kind: 'navigate',
          label: 'Open RDS',
          serviceId: 'rds',
          resourceId: instance.summary.dbInstanceIdentifier
        }
      })
    }

    if (instance.backupRetentionPeriod < MIN_RDS_BACKUP_RETENTION_DAYS) {
      addFinding(findings, {
        idParts: ['compliance', 'rds-backup', instance.summary.dbInstanceIdentifier],
        title: 'RDS instance backup retention is below the local baseline',
        severity: instance.backupRetentionPeriod === 0 ? 'high' : 'medium',
        category: 'compliance',
        service: 'rds',
        region,
        resourceId: instance.summary.dbInstanceIdentifier,
        description: `${instance.summary.dbInstanceIdentifier} keeps ${instance.backupRetentionPeriod} day${instance.backupRetentionPeriod === 1 ? '' : 's'} of automated backups; local policy expects at least ${MIN_RDS_BACKUP_RETENTION_DAYS} days.`,
        recommendedAction: 'Raise automated backup retention to the local minimum unless a reviewed exception already exists.',
        policyPackIds: ['backup-resilience'],
        remediation: {
          kind: 'navigate',
          label: 'Open RDS',
          serviceId: 'rds',
          resourceId: instance.summary.dbInstanceIdentifier
        }
      })
    }
  }

  for (const cluster of rdsClusters) {
    if (!cluster.summary.storageEncrypted) {
      addFinding(findings, {
        idParts: ['compliance', 'aurora-encryption', cluster.summary.dbClusterIdentifier],
        title: 'Aurora cluster does not meet encryption baseline',
        severity: 'high',
        category: 'security',
        service: 'rds',
        region,
        resourceId: cluster.summary.dbClusterIdentifier,
        description: `${cluster.summary.dbClusterIdentifier} has storage encryption disabled.`,
        recommendedAction: 'Plan an encrypted replacement or restore path before the cluster handles additional production traffic.',
        policyPackIds: ['encryption-baseline'],
        remediation: {
          kind: 'navigate',
          label: 'Open RDS',
          serviceId: 'rds',
          resourceId: cluster.summary.dbClusterIdentifier
        }
      })
    }

    if (cluster.backupRetentionPeriod < MIN_RDS_BACKUP_RETENTION_DAYS) {
      addFinding(findings, {
        idParts: ['compliance', 'aurora-backup', cluster.summary.dbClusterIdentifier],
        title: 'Aurora backup retention is below the local baseline',
        severity: cluster.backupRetentionPeriod === 0 ? 'high' : 'medium',
        category: 'compliance',
        service: 'rds',
        region,
        resourceId: cluster.summary.dbClusterIdentifier,
        description: `${cluster.summary.dbClusterIdentifier} keeps ${cluster.backupRetentionPeriod} day${cluster.backupRetentionPeriod === 1 ? '' : 's'} of automated backups; local policy expects at least ${MIN_RDS_BACKUP_RETENTION_DAYS} days.`,
        recommendedAction: 'Increase cluster backup retention to the local minimum unless the cluster already has an approved exception.',
        policyPackIds: ['backup-resilience'],
        remediation: {
          kind: 'navigate',
          label: 'Open RDS',
          serviceId: 'rds',
          resourceId: cluster.summary.dbClusterIdentifier
        }
      })
    }
  }

  const terraformProjects = await loadSection(
    warnings,
    'Terraform projects',
    [] as TerraformProjectListItem[],
    () => Promise.resolve(listProjectSummaries(profileName, connection))
  )

  const terraformProjectsInScope = terraformProjects.filter((project) => {
    const projectRegion = project.environment.region?.trim()
    return !projectRegion || projectRegion === region
  })

  addTerraformGovernanceFindings(findings, terraformProjectsInScope)

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

  const policyPacks: CompliancePolicyPack[] = policyPackDefinitions.map((definition) => ({
    ...definition,
    findingCount: findings.filter((finding) => finding.policyPackIds?.includes(definition.id)).length
  })).sort((left, right) => {
    const rightSeverity = findings
      .filter((finding) => finding.policyPackIds?.includes(right.id))
      .reduce<ComplianceSeverity>((severity, finding) => maxSeverity(severity, finding.severity), 'low')
    const leftSeverity = findings
      .filter((finding) => finding.policyPackIds?.includes(left.id))
      .reduce<ComplianceSeverity>((severity, finding) => maxSeverity(severity, finding.severity), 'low')
    return severityRank(rightSeverity) - severityRank(leftSeverity) || right.findingCount - left.findingCount
  })

  const findingsWithWorkflow = findings.map((finding) => ({
    ...finding,
    workflow: getComplianceFindingWorkflow(scopeKey, finding.id),
    remediationTemplates: buildRemediationTemplates(finding)
  }))

  return {
    generatedAt: new Date().toISOString(),
    findings: findingsWithWorkflow,
    policyPacks,
    summary: createSummary(findingsWithWorkflow),
    warnings
  }
}
