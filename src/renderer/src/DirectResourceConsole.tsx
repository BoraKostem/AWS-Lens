import { useMemo, useState } from 'react'
import './direct-resource.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import { CollapsibleInfoPanel } from './CollapsibleInfoPanel'
import { SvcState } from './SvcState'
import type { AwsConnection, DirectAccessIdentifierMatch, DirectAccessPlaybook, DirectAccessServiceTarget, NavigationFocus, ServiceId, WafScope } from '@shared/types'
import {
  describeAcmCertificate,
  describeEcsService,
  describeEc2Instance,
  describeEksCluster,
  describeKmsKey,
  describeRdsCluster,
  describeRdsInstance,
  describeSecret,
  describeSecurityGroup,
  describeWebAcl,
  getIamPolicyVersion,
  getIamRoleTrustPolicy,
  getLambdaFunction,
  getSecretValue,
  getSnsTopic,
  getSqsQueue,
  listAttachedIamRolePolicies,
  listAttachedIamUserPolicies,
  listCloudFormationStackResources,
  listCloudWatchLogGroups,
  listCloudWatchRecentEvents,
  listEcrImages,
  listEcsTasks,
  listEksNodegroups,
  listEksUpdates,
  listIamAccessKeys,
  listIamMfaDevices,
  listIamPolicies,
  listIamPolicyVersions,
  listIamRoleInlinePolicies,
  listIamRoles,
  listIamUserGroups,
  listIamUserInlinePolicies,
  listIamUsers,
  listLoadBalancerWorkspaces,
  listRoute53Records,
  listS3Objects,
  listSnsSubscriptions,
  resolveDirectAccessInput,
  sqsTimeline
} from './api'

type DirectServiceKey = DirectAccessServiceTarget
type DirectField = { key: string; label: string; placeholder: string; required?: boolean }
type DirectServiceDefinition = { key: DirectServiceKey; label: string; description: string; fields: DirectField[]; isReady?: (form: Record<string, string>) => boolean }
type ResultSection = { title: string; data: unknown }
type DirectConsoleLink = { label: string; description: string; focus?: NavigationFocus; serviceId?: ServiceId }

const LB_ARN = 'loadBalancerArn'
const LB_NAME = 'loadBalancerName'
const USER_NAME = 'userName'
const USER_ARN = 'userArn'
const ROLE_NAME = 'roleName'
const ROLE_ARN = 'roleArn'
const POLICY_NAME = 'policyName'
const POLICY_ARN = 'policyArn'

const TARGET_LABELS: Record<DirectServiceKey, string> = {
  ec2: 'EC2 Instance',
  'security-group': 'Security Group',
  'load-balancer': 'Load Balancer',
  'iam-user': 'IAM User',
  'iam-role': 'IAM Role',
  'iam-policy': 'IAM Policy',
  'cloudwatch-log-group': 'CloudWatch Log Group',
  s3: 'S3 Bucket',
  lambda: 'Lambda Function',
  'rds-instance': 'RDS Instance',
  'rds-cluster': 'Aurora Cluster',
  ecr: 'ECR Repository',
  ecs: 'ECS Service',
  eks: 'EKS Cluster',
  cloudformation: 'CloudFormation Stack',
  route53: 'Route53 Hosted Zone',
  'secrets-manager': 'Secrets Manager Secret',
  sns: 'SNS Topic',
  sqs: 'SQS Queue',
  kms: 'KMS Key',
  waf: 'WAF Web ACL',
  acm: 'ACM Certificate'
}

const READ_ONLY_PERMISSION_HINTS: Partial<Record<DirectServiceKey, string[]>> = {
  ec2: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus', 'ssm:DescribeInstanceInformation'],
  'security-group': ['ec2:DescribeSecurityGroups'],
  'load-balancer': ['elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeTargetHealth'],
  'iam-user': ['iam:ListUsers', 'iam:ListAccessKeys', 'iam:ListMFADevices', 'iam:ListGroupsForUser', 'iam:ListAttachedUserPolicies', 'iam:ListUserPolicies'],
  'iam-role': ['iam:ListRoles', 'iam:GetRole', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies'],
  'iam-policy': ['iam:ListPolicies', 'iam:ListPolicyVersions', 'iam:GetPolicyVersion'],
  'cloudwatch-log-group': ['logs:DescribeLogGroups', 'logs:FilterLogEvents']
}

const SERVICE_DEFINITIONS: DirectServiceDefinition[] = [
  { key: 'ec2', label: 'EC2 Instance', description: 'Open a known instance by id.', fields: [{ key: 'instanceId', label: 'Instance ID', placeholder: 'i-0123456789abcdef0', required: true }] },
  { key: 'security-group', label: 'Security Group', description: 'Inspect rules from a known group id.', fields: [{ key: 'securityGroupId', label: 'Security Group ID', placeholder: 'sg-0123456789abcdef0', required: true }] },
  { key: 'load-balancer', label: 'Load Balancer', description: 'Use ARN or exact name to fetch listeners and target health.', fields: [{ key: LB_ARN, label: 'Load Balancer ARN', placeholder: 'arn:aws:elasticloadbalancing:...' }, { key: LB_NAME, label: 'Load Balancer Name', placeholder: 'app/prod-web/1234567890abcdef' }], isReady: (form) => !!(form[LB_ARN]?.trim() || form[LB_NAME]?.trim()) },
  { key: 'iam-user', label: 'IAM User', description: 'Review user, keys, MFA, groups, and policies.', fields: [{ key: USER_NAME, label: 'User Name', placeholder: 'incident-user' }, { key: USER_ARN, label: 'User ARN', placeholder: 'arn:aws:iam::123456789012:user/incident-user' }], isReady: (form) => !!(form[USER_NAME]?.trim() || form[USER_ARN]?.trim()) },
  { key: 'iam-role', label: 'IAM Role', description: 'Review trust and attached role policies.', fields: [{ key: ROLE_NAME, label: 'Role Name', placeholder: 'ops-breakglass-role' }, { key: ROLE_ARN, label: 'Role ARN', placeholder: 'arn:aws:iam::123456789012:role/ops-breakglass-role' }], isReady: (form) => !!(form[ROLE_NAME]?.trim() || form[ROLE_ARN]?.trim()) },
  { key: 'iam-policy', label: 'IAM Policy', description: 'Inspect policy versions and default document.', fields: [{ key: POLICY_ARN, label: 'Policy ARN', placeholder: 'arn:aws:iam::123456789012:policy/PolicyName' }, { key: POLICY_NAME, label: 'Policy Name', placeholder: 'PolicyName' }], isReady: (form) => !!(form[POLICY_ARN]?.trim() || form[POLICY_NAME]?.trim()) },
  { key: 'cloudwatch-log-group', label: 'CloudWatch Log Group', description: 'Load a known log group and recent events.', fields: [{ key: 'logGroupName', label: 'Log Group Name', placeholder: '/aws/lambda/my-function', required: true }] },
  { key: 's3', label: 'S3 Bucket', description: 'Open a bucket directly by name.', fields: [{ key: 'bucketName', label: 'Bucket Name', placeholder: 'my-bucket', required: true }, { key: 'prefix', label: 'Prefix', placeholder: 'leave empty for root, or use path/' }] },
  { key: 'lambda', label: 'Lambda Function', description: 'Load a function by name.', fields: [{ key: 'functionName', label: 'Function Name', placeholder: 'my-function', required: true }] },
  { key: 'rds-instance', label: 'RDS Instance', description: 'Describe a DB instance by identifier.', fields: [{ key: 'dbInstanceIdentifier', label: 'DB Instance Identifier', placeholder: 'prod-db-1', required: true }] },
  { key: 'rds-cluster', label: 'Aurora Cluster', description: 'Describe an RDS cluster by identifier.', fields: [{ key: 'dbClusterIdentifier', label: 'DB Cluster Identifier', placeholder: 'prod-cluster', required: true }] },
  { key: 'ecr', label: 'ECR Repository', description: 'Open a repository directly.', fields: [{ key: 'repositoryName', label: 'Repository Name', placeholder: 'team/service', required: true }] },
  { key: 'ecs', label: 'ECS Service', description: 'Describe a service when you know cluster and service.', fields: [{ key: 'clusterArn', label: 'Cluster ARN', placeholder: 'arn:aws:ecs:...', required: true }, { key: 'serviceName', label: 'Service Name', placeholder: 'web', required: true }] },
  { key: 'eks', label: 'EKS Cluster', description: 'Describe an EKS cluster by name.', fields: [{ key: 'clusterName', label: 'Cluster Name', placeholder: 'prod-eks', required: true }] },
  { key: 'cloudformation', label: 'CloudFormation Stack', description: 'List resources for a known stack.', fields: [{ key: 'stackName', label: 'Stack Name', placeholder: 'network-stack', required: true }] },
  { key: 'route53', label: 'Route53 Hosted Zone', description: 'List records for a hosted zone.', fields: [{ key: 'hostedZoneId', label: 'Hosted Zone ID', placeholder: 'Z1234567890ABC', required: true }] },
  { key: 'secrets-manager', label: 'Secrets Manager Secret', description: 'Load a secret by ARN or name.', fields: [{ key: 'secretId', label: 'Secret ID / ARN', placeholder: 'arn:aws:secretsmanager:... or secret-name', required: true }] },
  { key: 'sns', label: 'SNS Topic', description: 'Load a topic by ARN.', fields: [{ key: 'topicArn', label: 'Topic ARN', placeholder: 'arn:aws:sns:...', required: true }] },
  { key: 'sqs', label: 'SQS Queue', description: 'Load a queue by URL.', fields: [{ key: 'queueUrl', label: 'Queue URL', placeholder: 'https://sqs....amazonaws.com/.../queue', required: true }] },
  { key: 'kms', label: 'KMS Key', description: 'Describe a KMS key.', fields: [{ key: 'keyId', label: 'Key ID / ARN / Alias', placeholder: 'alias/my-key or arn:aws:kms:...', required: true }] },
  { key: 'waf', label: 'WAF Web ACL', description: 'Describe a web ACL.', fields: [{ key: 'scope', label: 'Scope', placeholder: 'REGIONAL or CLOUDFRONT', required: true }, { key: 'id', label: 'Web ACL ID', placeholder: '12345678-....', required: true }, { key: 'name', label: 'Web ACL Name', placeholder: 'main-acl', required: true }] },
  { key: 'acm', label: 'ACM Certificate', description: 'Describe a certificate by ARN.', fields: [{ key: 'certificateArn', label: 'Certificate ARN', placeholder: 'arn:aws:acm:...', required: true }] }
]

const INITIAL_FORM: Record<string, string> = {
  instanceId: '', securityGroupId: '', loadBalancerArn: '', loadBalancerName: '', userName: '', userArn: '', roleName: '', roleArn: '', policyArn: '', policyName: '', logGroupName: '', bucketName: '', prefix: '', functionName: '', dbInstanceIdentifier: '', dbClusterIdentifier: '', repositoryName: '', clusterArn: '', serviceName: '', clusterName: '', stackName: '', hostedZoneId: '', secretId: '', topicArn: '', queueUrl: '', keyId: '', scope: 'REGIONAL', id: '', name: '', certificateArn: ''
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2)
const normalizeS3Prefix = (prefix: string) => { const trimmed = prefix.trim(); return !trimmed || trimmed === '/' ? '' : trimmed.replace(/^\/+/, '') }
const fieldValueCount = (definition: DirectServiceDefinition, form: Record<string, string>) => definition.fields.filter((field) => form[field.key]?.trim()).length
const requiredFieldCount = (definition: DirectServiceDefinition) => definition.fields.filter((field) => field.required).length
const summarizeSectionData = (data: unknown) => Array.isArray(data) ? `${data.length} item${data.length === 1 ? '' : 's'}` : data && typeof data === 'object' ? `${Object.keys(data as Record<string, unknown>).length} field${Object.keys(data as Record<string, unknown>).length === 1 ? '' : 's'}` : typeof data === 'string' ? (data.length > 80 ? `${data.length} chars` : data) : data == null ? 'Empty payload' : typeof data
const isDefinitionReady = (definition: DirectServiceDefinition, form: Record<string, string>) => definition.isReady ? definition.isReady(form) : !definition.fields.some((field) => field.required && !form[field.key]?.trim())
const isAccessDeniedError = (message: string) => { const normalized = message.toLowerCase(); return normalized.includes('accessdenied') || normalized.includes('access denied') || normalized.includes('not authorized') || normalized.includes('unauthorizedoperation') || normalized.includes('not authorized to perform') }
const confidenceBadge = (confidence: DirectAccessIdentifierMatch['confidence']) => confidence === 'high' ? 'success' : 'warning'
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function buildManualPlaybook(service: DirectServiceKey, form: Record<string, string>): DirectAccessPlaybook | null {
  if (service === 'ec2' && form.instanceId.trim()) return { id: `manual:ec2:${form.instanceId.trim()}`, target: service, title: 'EC2 incident playbook', description: 'Describe the instance first, then continue in EC2 or CloudWatch.', supportLevel: 'supported', requiredFields: ['instanceId'], suggestedFocus: { service: 'ec2', instanceId: form.instanceId.trim(), tab: 'instances' }, steps: [{ id: 'lookup', title: 'Describe the instance first', detail: 'Capture state, IAM profile, SSM posture, and attached security groups.', kind: 'lookup' }, { id: 'permission', title: 'Keep access narrow', detail: 'If denied, request only ec2:Describe* or ssm:Describe* actions.', kind: 'permission' }, { id: 'navigate', title: 'Continue in EC2', detail: 'Open the EC2 workspace with the same instance in focus.', kind: 'navigate' }] }
  if (service === 'security-group' && form.securityGroupId.trim()) return { id: `manual:sg:${form.securityGroupId.trim()}`, target: service, title: 'Security Group rule playbook', description: 'Review ingress and egress from the exact group id before wider network checks.', supportLevel: 'supported', requiredFields: ['securityGroupId'], suggestedFocus: { service: 'security-groups', securityGroupId: form.securityGroupId.trim() }, steps: [{ id: 'lookup', title: 'Describe the group directly', detail: 'Capture inbound and outbound rules, references, and tags.', kind: 'lookup' }, { id: 'permission', title: 'Stay on describe only', detail: 'If denied, request only ec2:DescribeSecurityGroups.', kind: 'permission' }, { id: 'navigate', title: 'Continue in Security Groups', detail: 'Use the focused console handoff after the direct describe path.', kind: 'navigate' }] }
  if (service === 'load-balancer' && (form[LB_ARN].trim() || form[LB_NAME].trim())) return { id: `manual:lb:${form[LB_ARN].trim() || form[LB_NAME].trim()}`, target: service, title: 'Load Balancer triage playbook', description: 'Review listeners, target groups, and health before broader discovery.', supportLevel: form[LB_ARN].trim() ? 'supported' : 'partial', requiredFields: [LB_ARN, LB_NAME], suggestedFocus: form[LB_ARN].trim() ? { service: 'load-balancers', loadBalancerArn: form[LB_ARN].trim() } : null, steps: [{ id: 'lookup', title: 'Collect listener and health context', detail: 'Inspect listeners, target groups, and timeline anomalies for the matched balancer.', kind: 'lookup' }, { id: 'permission', title: 'Keep ELB permissions read-only', detail: 'Missing access should stay limited to DescribeLoadBalancers, DescribeListeners, DescribeTargetGroups, and DescribeTargetHealth.', kind: 'permission' }, { id: 'navigate', title: 'Continue in Load Balancers', detail: 'Use the console handoff after the direct lookup confirms the target.', kind: 'navigate' }] }
  if (service === 'iam-user' && (form[USER_NAME].trim() || form[USER_ARN].trim())) return { id: `manual:iam-user:${form[USER_ARN].trim() || form[USER_NAME].trim()}`, target: service, title: 'IAM user review playbook', description: 'Capture keys, MFA, groups, and attached policies from the exact user.', supportLevel: 'partial', requiredFields: [USER_NAME, USER_ARN], suggestedFocus: null, steps: [{ id: 'lookup', title: 'Collect the direct user posture', detail: 'Review access keys, MFA devices, groups, and policies for the matched user.', kind: 'lookup' }, { id: 'permission', title: 'Escalate narrowly', detail: 'Request only the missing iam:List* or iam:Get* action if blocked.', kind: 'permission' }, { id: 'navigate', title: 'Continue in IAM', detail: 'Open the IAM workspace once the target is confirmed.', kind: 'navigate' }] }
  if (service === 'iam-role' && (form[ROLE_NAME].trim() || form[ROLE_ARN].trim())) return { id: `manual:iam-role:${form[ROLE_ARN].trim() || form[ROLE_NAME].trim()}`, target: service, title: 'IAM role review playbook', description: 'Capture trust policy and attached permissions from the exact role.', supportLevel: 'partial', requiredFields: [ROLE_NAME, ROLE_ARN], suggestedFocus: null, steps: [{ id: 'lookup', title: 'Collect trust and policy context', detail: 'Inspect trust policy, attached policies, and inline policies for the matched role.', kind: 'lookup' }, { id: 'permission', title: 'Escalate narrowly', detail: 'Keep escalation limited to specific iam:Get* or iam:List* calls.', kind: 'permission' }, { id: 'navigate', title: 'Continue in IAM', detail: 'Open the IAM workspace with the matched role context in hand.', kind: 'navigate' }] }
  if (service === 'iam-policy' && (form[POLICY_ARN].trim() || form[POLICY_NAME].trim())) return { id: `manual:iam-policy:${form[POLICY_ARN].trim() || form[POLICY_NAME].trim()}`, target: service, title: 'IAM policy review playbook', description: 'Inspect policy versions and the default policy document directly.', supportLevel: 'partial', requiredFields: [POLICY_ARN, POLICY_NAME], suggestedFocus: null, steps: [{ id: 'lookup', title: 'Enumerate policy versions', detail: 'Confirm the default version and review the current policy document.', kind: 'lookup' }, { id: 'permission', title: 'Request policy read access only', detail: 'Keep escalation limited to iam:ListPolicies, iam:ListPolicyVersions, and iam:GetPolicyVersion.', kind: 'permission' }, { id: 'navigate', title: 'Continue in IAM', detail: 'Open the IAM workspace after the direct policy lookup is captured.', kind: 'navigate' }] }
  if (service === 'cloudwatch-log-group' && form.logGroupName.trim()) return { id: `manual:log-group:${form.logGroupName.trim()}`, target: service, title: 'CloudWatch Logs playbook', description: 'Review recent events first, then hand off into a scoped CloudWatch query.', supportLevel: 'supported', requiredFields: ['logGroupName'], suggestedFocus: { service: 'cloudwatch', logGroupNames: [form.logGroupName.trim()], sourceLabel: form.logGroupName.trim(), serviceHint: 'cloudwatch', queryString: ['fields @timestamp, @logStream, @message', `| filter @message like /(?i)(${escapeRegex(form.logGroupName.trim())}|error|exception|timeout|denied)/`, '| sort @timestamp desc', '| limit 100'].join('\n') }, steps: [{ id: 'lookup', title: 'Describe the log group directly', detail: 'Capture retention, storage, and recent events from the matched log group.', kind: 'lookup' }, { id: 'permission', title: 'Request only Logs read access', detail: 'If blocked, ask only for logs:DescribeLogGroups and logs:FilterLogEvents.', kind: 'permission' }, { id: 'navigate', title: 'Continue in CloudWatch', detail: 'Open CloudWatch with the matched log group pre-scoped.', kind: 'navigate' }] }
  return null
}

function buildSuggestedLinks(service: DirectServiceKey, form: Record<string, string>, playbook: DirectAccessPlaybook | null): DirectConsoleLink[] {
  if (playbook?.suggestedFocus) return [{ label: `Open ${TARGET_LABELS[service]} console`, description: 'Continue in the deeper console with the direct lookup context carried forward.', focus: playbook.suggestedFocus }]
  if (service === 'lambda' && form.functionName.trim()) return [{ label: 'Open Lambda console', description: 'Continue in the main Lambda workspace with focus applied.', focus: { service: 'lambda', functionName: form.functionName.trim() } }]
  if (service === 'ecs' && form.clusterArn.trim() && form.serviceName.trim()) return [{ label: 'Open ECS service', description: 'Jump into ECS with the selected cluster and service.', focus: { service: 'ecs', clusterArn: form.clusterArn.trim(), serviceName: form.serviceName.trim() } }]
  if (service === 'eks' && form.clusterName.trim()) return [{ label: 'Open EKS cluster', description: 'Continue in the EKS workspace with the cluster preselected.', focus: { service: 'eks', clusterName: form.clusterName.trim() } }]
  if (service === 'waf' && form.name.trim()) return [{ label: 'Open WAF console', description: 'Review the Web ACL inside the main WAF workspace.', focus: { service: 'waf', webAclName: form.name.trim() } }]
  if (service === 'iam-user' || service === 'iam-role' || service === 'iam-policy') return [{ label: 'Open IAM console', description: 'Continue in the IAM workspace after the direct lookup confirms the exact target.', serviceId: 'iam' }]
  return []
}

function findLoadBalancerWorkspace(workspaces: Awaited<ReturnType<typeof listLoadBalancerWorkspaces>>, rawValue: string) {
  const normalized = rawValue.trim().toLowerCase()
  return workspaces.find((workspace) => workspace.summary.arn.toLowerCase() === normalized || workspace.summary.name.toLowerCase() === normalized || workspace.summary.dnsName.toLowerCase() === normalized) ?? null
}

function mergeMatchIntoForm(form: Record<string, string>, match: DirectAccessIdentifierMatch): Record<string, string> {
  return {
    ...form,
    instanceId: match.values.instanceId ?? form.instanceId,
    securityGroupId: match.values.securityGroupId ?? form.securityGroupId,
    loadBalancerArn: match.values.loadBalancerArn ?? form.loadBalancerArn,
    logGroupName: match.values.logGroupName ?? form.logGroupName,
    userName: match.values.userName ?? form.userName,
    userArn: match.values.userArn ?? form.userArn,
    roleName: match.values.roleName ?? form.roleName,
    roleArn: match.values.roleArn ?? form.roleArn,
    policyName: match.values.policyName ?? form.policyName,
    policyArn: match.values.policyArn ?? form.policyArn
  }
}

export function DirectResourceConsole({ connection, onNavigate, onNavigateService }: { connection: AwsConnection; onNavigate: (focus: NavigationFocus) => void; onNavigateService: (serviceId: ServiceId) => void }) {
  const [selectedService, setSelectedService] = useState<DirectServiceKey>('ec2')
  const [form, setForm] = useState<Record<string, string>>(INITIAL_FORM)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sections, setSections] = useState<ResultSection[]>([])
  const [selectedSectionIndex, setSelectedSectionIndex] = useState(0)
  const [smartInput, setSmartInput] = useState('')
  const [smartInputBusy, setSmartInputBusy] = useState(false)
  const [smartInputError, setSmartInputError] = useState('')
  const [resolution, setResolution] = useState<Awaited<ReturnType<typeof resolveDirectAccessInput>> | null>(null)
  const [activePlaybookId, setActivePlaybookId] = useState('')
  const { freshness, beginRefresh, completeRefresh, failRefresh, replaceFetchedAt } = useFreshnessState({ staleAfterMs: 10 * 60 * 1000 })

  const definition = useMemo(() => SERVICE_DEFINITIONS.find((entry) => entry.key === selectedService) ?? SERVICE_DEFINITIONS[0], [selectedService])
  const selectedSection = sections[selectedSectionIndex] ?? null
  const populatedFieldCount = fieldValueCount(definition, form)
  const requiredCount = requiredFieldCount(definition)
  const connectionLabel = connection.kind === 'profile' ? connection.profile : connection.label
  const connectionMode = connection.kind === 'profile' ? 'Profile' : 'Assumed role'
  const openDisabled = !isDefinitionReady(definition, form)
  const manualPlaybook = useMemo(() => buildManualPlaybook(selectedService, form), [selectedService, form])
  const activePlaybook = useMemo(() => resolution?.playbooks.find((playbook) => playbook.id === activePlaybookId && playbook.target === selectedService) ?? manualPlaybook, [activePlaybookId, manualPlaybook, resolution?.playbooks, selectedService])
  const suggestedLinks = useMemo(() => buildSuggestedLinks(selectedService, form, activePlaybook), [activePlaybook, form, selectedService])
  const permissionHints = READ_ONLY_PERMISSION_HINTS[selectedService] ?? []
  const accessDenied = !!error && isAccessDeniedError(error)

  function updateField(key: string, value: string): void { setForm((current) => ({ ...current, [key]: value })) }
  function handleSelectService(key: DirectServiceKey): void { setSelectedService(key); setError(''); setSections([]); setSelectedSectionIndex(0); replaceFetchedAt(null) }
  function handleResetInputs(): void { setForm(INITIAL_FORM); setActivePlaybookId('') }
  function handleClearResults(): void { setError(''); setSections([]); setSelectedSectionIndex(0); replaceFetchedAt(null) }
  function applyResolvedMatch(match: DirectAccessIdentifierMatch, playbook: DirectAccessPlaybook, nextForm?: Record<string, string>): void {
    setSelectedService(match.target)
    setForm(nextForm ?? ((current) => mergeMatchIntoForm(current, match)))
    setActivePlaybookId(playbook.id)
    setError('')
    setSections([])
    setSelectedSectionIndex(0)
    replaceFetchedAt(null)
  }

  async function handleAnalyzeIdentifier(): Promise<void> {
    if (!smartInput.trim()) { setResolution(null); setSmartInputError(''); setActivePlaybookId(''); return }
    setSmartInputBusy(true)
    setSmartInputError('')
    try {
      const nextResolution = await resolveDirectAccessInput(smartInput)
      setResolution(nextResolution)
      if (nextResolution.matches.length === 1 && nextResolution.playbooks.length === 1) {
        const nextForm = mergeMatchIntoForm(form, nextResolution.matches[0])
        applyResolvedMatch(nextResolution.matches[0], nextResolution.playbooks[0], nextForm)
        await handleOpen(nextResolution.matches[0].target, nextForm, nextResolution.playbooks[0].id)
      } else {
        setActivePlaybookId('')
      }
    } catch (err) {
      setResolution(null)
      setActivePlaybookId('')
      setSmartInputError(err instanceof Error ? err.message : String(err))
    } finally {
      setSmartInputBusy(false)
    }
  }

  async function handleOpen(serviceOverride?: DirectServiceKey, formOverride?: Record<string, string>, playbookIdOverride?: string): Promise<void> {
    const currentService = serviceOverride ?? selectedService
    const currentForm = formOverride ?? form
    beginRefresh('manual')
    setLoading(true)
    setError('')
    setSections([])
    setSelectedSectionIndex(0)
    try {
      let nextSections: ResultSection[] = []
      switch (currentService) {
        case 'ec2': {
          const detail = await describeEc2Instance(connection, currentForm.instanceId.trim())
          nextSections = [{ title: `Instance ${detail.instanceId}`, data: detail }, { title: 'Security groups', data: detail.securityGroups }, { title: 'Volumes', data: detail.volumes }, { title: 'SSM diagnostics', data: detail.ssmDiagnostics }]
          break
        }
        case 'security-group': {
          const detail = await describeSecurityGroup(connection, currentForm.securityGroupId.trim())
          nextSections = [{ title: `Group ${detail.groupId}`, data: detail }, { title: 'Inbound rules', data: detail.inboundRules }, { title: 'Outbound rules', data: detail.outboundRules }]
          break
        }
        case 'load-balancer': {
          const lookupValue = currentForm[LB_ARN].trim() || currentForm[LB_NAME].trim()
          const workspace = findLoadBalancerWorkspace(await listLoadBalancerWorkspaces(connection), lookupValue)
          if (!workspace) throw new Error('Load balancer not found in the current region. Use an ARN, exact name, or DNS name from the incident payload.')
          setForm((current) => ({ ...current, loadBalancerArn: workspace.summary.arn, loadBalancerName: workspace.summary.name }))
          nextSections = [{ title: workspace.summary.name, data: workspace.summary }, { title: 'Listeners', data: workspace.listeners }, { title: 'Target groups', data: workspace.targetGroups }, { title: 'Target health', data: workspace.targetsByGroup }, { title: 'Timeline', data: workspace.timeline }]
          break
        }
        case 'iam-user': {
          const inputValue = currentForm[USER_ARN].trim() || currentForm[USER_NAME].trim()
          const user = (await listIamUsers(connection)).find((entry) => entry.arn === inputValue || entry.userName === inputValue)
          if (!user) throw new Error('IAM user not found in the current account. Use an exact username or ARN from the incident payload.')
          setForm((current) => ({ ...current, userName: user.userName, userArn: user.arn }))
          const [accessKeys, mfaDevices, groups, attachedPolicies, inlinePolicies] = await Promise.all([listIamAccessKeys(connection, user.userName), listIamMfaDevices(connection, user.userName), listIamUserGroups(connection, user.userName), listAttachedIamUserPolicies(connection, user.userName), listIamUserInlinePolicies(connection, user.userName)])
          nextSections = [{ title: user.userName, data: user }, { title: 'Access keys', data: accessKeys }, { title: 'MFA devices', data: mfaDevices }, { title: 'Groups', data: groups }, { title: 'Attached policies', data: attachedPolicies }, { title: 'Inline policies', data: inlinePolicies }]
          break
        }
        case 'iam-role': {
          const inputValue = currentForm[ROLE_ARN].trim() || currentForm[ROLE_NAME].trim()
          const role = (await listIamRoles(connection)).find((entry) => entry.arn === inputValue || entry.roleName === inputValue)
          if (!role) throw new Error('IAM role not found in the current account. Use an exact role name or ARN from the incident payload.')
          setForm((current) => ({ ...current, roleName: role.roleName, roleArn: role.arn }))
          const [attachedPolicies, inlinePolicies, trustPolicy] = await Promise.all([listAttachedIamRolePolicies(connection, role.roleName), listIamRoleInlinePolicies(connection, role.roleName), getIamRoleTrustPolicy(connection, role.roleName)])
          nextSections = [{ title: role.roleName, data: role }, { title: 'Attached policies', data: attachedPolicies }, { title: 'Inline policies', data: inlinePolicies }, { title: 'Trust policy', data: trustPolicy }]
          break
        }
        case 'iam-policy': {
          const inputValue = currentForm[POLICY_ARN].trim() || currentForm[POLICY_NAME].trim()
          const policy = (await listIamPolicies(connection, 'All')).find((entry) => entry.arn === inputValue || entry.policyName === inputValue)
          if (!policy) throw new Error('IAM managed policy not found in the current account scope. Use an exact ARN or policy name.')
          setForm((current) => ({ ...current, policyName: policy.policyName, policyArn: policy.arn }))
          const versions = await listIamPolicyVersions(connection, policy.arn)
          const defaultVersion = await getIamPolicyVersion(connection, policy.arn, versions.find((version) => version.isDefaultVersion)?.versionId ?? policy.defaultVersionId)
          nextSections = [{ title: policy.policyName, data: policy }, { title: 'Versions', data: versions }, { title: `Default version ${defaultVersion.versionId}`, data: defaultVersion }]
          break
        }
        case 'cloudwatch-log-group': {
          const selectedGroup = (await listCloudWatchLogGroups(connection)).find((group) => group.name === currentForm.logGroupName.trim() || group.arn === currentForm.logGroupName.trim())
          if (!selectedGroup) throw new Error('Log group not found in the current region. Use the exact log-group name or ARN.')
          setForm((current) => ({ ...current, logGroupName: selectedGroup.name }))
          nextSections = [{ title: selectedGroup.name, data: selectedGroup }, { title: 'Recent events', data: await listCloudWatchRecentEvents(connection, selectedGroup.name, 24) }]
          break
        }
        case 's3':
          nextSections = [{ title: `Bucket ${currentForm.bucketName.trim()}`, data: await listS3Objects(connection, currentForm.bucketName.trim(), normalizeS3Prefix(currentForm.prefix)) }]
          break
        case 'lambda':
          nextSections = [{ title: currentForm.functionName.trim(), data: await getLambdaFunction(connection, currentForm.functionName.trim()) }]
          break
        case 'rds-instance':
          nextSections = [{ title: currentForm.dbInstanceIdentifier.trim(), data: await describeRdsInstance(connection, currentForm.dbInstanceIdentifier.trim()) }]
          break
        case 'rds-cluster':
          nextSections = [{ title: currentForm.dbClusterIdentifier.trim(), data: await describeRdsCluster(connection, currentForm.dbClusterIdentifier.trim()) }]
          break
        case 'ecr':
          nextSections = [{ title: `Repository ${currentForm.repositoryName.trim()}`, data: await listEcrImages(connection, currentForm.repositoryName.trim()) }]
          break
        case 'ecs': {
          const clusterArn = currentForm.clusterArn.trim()
          const serviceName = currentForm.serviceName.trim()
          const [service, tasks] = await Promise.all([describeEcsService(connection, clusterArn, serviceName), listEcsTasks(connection, clusterArn, serviceName)])
          nextSections = [{ title: `Service ${serviceName}`, data: service }, { title: 'Tasks', data: tasks }]
          break
        }
        case 'eks': {
          const clusterName = currentForm.clusterName.trim()
          const [detail, nodegroups, updates] = await Promise.all([describeEksCluster(connection, clusterName), listEksNodegroups(connection, clusterName), listEksUpdates(connection, clusterName)])
          nextSections = [{ title: `Cluster ${clusterName}`, data: detail }, { title: 'Nodegroups', data: nodegroups }, { title: 'Recent updates', data: updates }]
          break
        }
        case 'cloudformation':
          nextSections = [{ title: `Stack ${currentForm.stackName.trim()}`, data: await listCloudFormationStackResources(connection, currentForm.stackName.trim()) }]
          break
        case 'route53':
          nextSections = [{ title: `Hosted Zone ${currentForm.hostedZoneId.trim()}`, data: await listRoute53Records(connection, currentForm.hostedZoneId.trim()) }]
          break
        case 'secrets-manager': {
          const secretId = currentForm.secretId.trim()
          const [detail, value] = await Promise.all([describeSecret(connection, secretId), getSecretValue(connection, secretId)])
          nextSections = [{ title: 'Secret detail', data: detail }, { title: 'Current value', data: value }]
          break
        }
        case 'sns': {
          const topicArn = currentForm.topicArn.trim()
          const [topic, subscriptions] = await Promise.all([getSnsTopic(connection, topicArn), listSnsSubscriptions(connection, topicArn)])
          nextSections = [{ title: 'Topic', data: topic }, { title: 'Subscriptions', data: subscriptions }]
          break
        }
        case 'sqs': {
          const queueUrl = currentForm.queueUrl.trim()
          const [queue, timeline] = await Promise.all([getSqsQueue(connection, queueUrl), sqsTimeline(connection, queueUrl)])
          nextSections = [{ title: 'Queue', data: queue }, { title: 'Timeline', data: timeline }]
          break
        }
        case 'kms':
          nextSections = [{ title: currentForm.keyId.trim(), data: await describeKmsKey(connection, currentForm.keyId.trim()) }]
          break
        case 'waf':
          nextSections = [{ title: currentForm.name.trim(), data: await describeWebAcl(connection, currentForm.scope.trim().toUpperCase() as WafScope, currentForm.id.trim(), currentForm.name.trim()) }]
          break
        case 'acm':
          nextSections = [{ title: currentForm.certificateArn.trim(), data: await describeAcmCertificate(connection, currentForm.certificateArn.trim()) }]
          break
      }
      setSections(nextSections)
      if (serviceOverride) {
        setSelectedService(currentService)
      }
      if (playbookIdOverride) {
        setActivePlaybookId(playbookIdOverride)
      }
      completeRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="svc-console direct-console">
      <section className="direct-shell-hero">
        <div className="direct-shell-copy">
          <div className="eyebrow">Direct resource access</div>
          <h2>{definition.label}</h2>
          <p>Use exact ids, ARNs, or console URLs when list permissions are limited and the incident already names the target.</p>
          <div className="direct-shell-meta-strip">
            <div className="direct-shell-meta-pill"><span>Connection</span><strong>{connectionLabel}</strong></div>
            <div className="direct-shell-meta-pill"><span>Mode</span><strong>{connectionMode}</strong></div>
            <div className="direct-shell-meta-pill"><span>Region</span><strong>{connection.region}</strong></div>
            <div className="direct-shell-meta-pill"><span>Playbook</span><strong>{activePlaybook?.supportLevel ?? 'standby'}</strong></div>
          </div>
        </div>
        <div className="direct-shell-stats">
          <div className="direct-shell-stat-card direct-shell-stat-card-accent"><span>Services</span><strong>{SERVICE_DEFINITIONS.length}</strong><small>Direct lookups available in this console</small></div>
          <div className="direct-shell-stat-card"><span>Inputs ready</span><strong>{populatedFieldCount}/{definition.fields.length}</strong><small>{openDisabled ? 'Complete the required identifiers' : 'Current request is ready to open'}</small></div>
          <div className="direct-shell-stat-card"><span>Result sections</span><strong>{sections.length}</strong><small>{sections.length ? 'Structured payloads returned from AWS' : 'No payload loaded yet'}</small></div>
          <div className="direct-shell-stat-card"><span>Active view</span><strong>{selectedSection?.title || 'Standby'}</strong><small>{selectedSection ? summarizeSectionData(selectedSection.data) : 'Open a resource to inspect details'}</small></div>
        </div>
      </section>

      <div className="direct-shell-toolbar">
        <div className="direct-toolbar">
          <button className="direct-toolbar-btn accent" type="button" onClick={() => void handleOpen()} disabled={loading || openDisabled}>{loading ? 'Opening...' : 'Open Resource'}</button>
          <button className="direct-toolbar-btn" type="button" onClick={handleResetInputs} disabled={loading}>Reset Inputs</button>
          <button className="direct-toolbar-btn" type="button" onClick={handleClearResults} disabled={loading || (!sections.length && !error)}>Clear Results</button>
        </div>
        <div className="direct-shell-status"><FreshnessIndicator freshness={freshness} label="Lookup freshness" staleLabel="Open again to refresh" /></div>
      </div>

      <CollapsibleInfoPanel title="When to use direct access" eyebrow="Example workflows" className="direct-section direct-info-panel">
        <div className="info-card-grid">
          <article className="info-card"><div className="info-card__copy"><strong>Known resource, limited list permissions</strong><p>Open an instance, security group, load balancer, IAM target, or log group directly.</p></div></article>
          <article className="info-card"><div className="info-card__copy"><strong>Paste from a ticket or alert</strong><p>Use the smart identifier field for ARNs, console URLs, bare ids, and log-group names.</p></div></article>
          <article className="info-card"><div className="info-card__copy"><strong>Stay read-only</strong><p>When AccessDenied appears, keep the workflow on describe and list operations and capture the smallest permission gap.</p></div></article>
        </div>
      </CollapsibleInfoPanel>

      {error && <SvcState variant="error" error={error} />}

      <div className="direct-main-layout">
        <div className="direct-service-pane">
          <div className="direct-pane-head"><div><span className="direct-pane-kicker">Service inventory</span><h3>Lookup targets</h3></div><span className="direct-pane-summary">{SERVICE_DEFINITIONS.length} total</span></div>
          <div className="direct-service-list">
            {SERVICE_DEFINITIONS.map((entry) => {
              const isActive = entry.key === selectedService
              const entryRequired = requiredFieldCount(entry)
              const entryFilled = fieldValueCount(entry, form)
              return (
                <button key={entry.key} type="button" className={`direct-service-row ${isActive ? 'active' : ''}`} onClick={() => handleSelectService(entry.key)}>
                  <div className="direct-service-row-top">
                    <div className="direct-service-row-copy"><strong>{entry.label}</strong><span>{entry.description}</span></div>
                    <span className={`tf-status-badge ${isActive ? 'info' : 'success'}`}>{entryRequired || entry.isReady ? 'smart' : `${entryRequired} required`}</span>
                  </div>
                  <div className="direct-service-row-meta"><span>{entry.key}</span><span>{entry.fields.length} field{entry.fields.length === 1 ? '' : 's'}</span><span>{entryFilled}/{entry.fields.length} filled</span></div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="direct-detail-pane">
          <section className="direct-detail-hero">
            <div className="direct-detail-copy">
              <div className="eyebrow">Lookup configuration</div>
              <h3>{definition.label}</h3>
              <p>{definition.description}</p>
              <div className="direct-detail-meta-strip">
                <div className="direct-detail-meta-pill"><span>Required</span><strong>{requiredCount || 'Smart rules'}</strong></div>
                <div className="direct-detail-meta-pill"><span>Total fields</span><strong>{definition.fields.length}</strong></div>
                <div className="direct-detail-meta-pill"><span>Ready state</span><strong>{openDisabled ? 'Needs identifiers' : 'Ready to open'}</strong></div>
                <div className="direct-detail-meta-pill"><span>Payloads</span><strong>{sections.length || 'None yet'}</strong></div>
              </div>
            </div>
            <div className="direct-detail-stats">
              <div className={`direct-detail-stat-card ${openDisabled ? 'warning' : 'success'}`}><span>Request posture</span><strong>{openDisabled ? 'Incomplete' : 'Ready'}</strong><small>{openDisabled ? 'At least one required identifier is missing.' : 'All required identifiers are present.'}</small></div>
              <div className="direct-detail-stat-card"><span>Playbook target</span><strong>{activePlaybook?.title || definition.label}</strong><small>{activePlaybook?.description || 'Targeted read-only lookup guidance appears here.'}</small></div>
            </div>
          </section>

          <section className="direct-section">
            <div className="direct-section-head"><div><span className="direct-pane-kicker">Identifier parser</span><h3>Smart input</h3></div></div>
            <div className="direct-smart-grid">
              <label className="direct-field direct-field-wide"><span>Paste ARN, URL, or resource id</span><input value={smartInput} onChange={(event) => setSmartInput(event.target.value)} placeholder="arn:aws:..., https://console.aws.amazon.com/..., i-..., sg-..., /aws/..." /></label>
              <div className="direct-inline-actions">
                <button type="button" className="direct-toolbar-btn accent" onClick={() => void handleAnalyzeIdentifier()} disabled={smartInputBusy}>{smartInputBusy ? 'Analyzing...' : 'Analyze Identifier'}</button>
                <button type="button" className="direct-toolbar-btn" onClick={() => { setSmartInput(''); setSmartInputError(''); setResolution(null); setActivePlaybookId('') }} disabled={smartInputBusy || (!smartInput && !resolution)}>Clear Parser</button>
              </div>
            </div>
            {smartInputError && <div className="direct-inline-error">{smartInputError}</div>}
            {resolution?.matches.length ? (
              <div className="direct-match-grid">
                {resolution.matches.map((match, index) => {
                  const playbook = resolution.playbooks[index]
                  return (
                    <article key={playbook.id} className={`direct-match-card ${activePlaybookId === playbook.id ? 'active' : ''}`}>
                      <div className="direct-match-head"><div><strong>{TARGET_LABELS[match.target]}</strong><p>{match.reason}</p></div><span className={`tf-status-badge ${confidenceBadge(match.confidence)}`}>{match.confidence}</span></div>
                      <div className="direct-match-values">{Object.entries(match.values).map(([key, value]) => <span key={`${playbook.id}:${key}`}>{key}: {value}</span>)}</div>
                      <div className="direct-inline-actions"><button type="button" className="direct-toolbar-btn" onClick={() => { const nextForm = mergeMatchIntoForm(form, match); applyResolvedMatch(match, playbook, nextForm); void handleOpen(match.target, nextForm, playbook.id) }}>{activePlaybookId === playbook.id ? 'Reload Match' : 'Open Match'}</button></div>
                    </article>
                  )
                })}
              </div>
            ) : resolution ? <SvcState variant="empty" message="No supported direct-access match was detected in that input yet. Use the manual fields below." /> : null}
          </section>

          <section className="direct-section">
            <div className="direct-section-head"><div><span className="direct-pane-kicker">Parameters</span><h3>Known identifiers</h3></div></div>
            <div className="direct-form-grid">
              <label className="direct-field direct-field-wide"><span>Service</span><select value={selectedService} onChange={(e) => handleSelectService(e.target.value as DirectServiceKey)}>{SERVICE_DEFINITIONS.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select></label>
              {definition.fields.map((field) => (
                <label key={field.key} className="direct-field">
                  <span>{field.label}{field.required ? <em>Required</em> : <em>Optional</em>}</span>
                  <input value={form[field.key] ?? ''} onChange={(e) => updateField(field.key, e.target.value)} placeholder={field.placeholder} />
                </label>
              ))}
            </div>
          </section>

          <section className="direct-section">
            <div className="direct-section-head"><div><span className="direct-pane-kicker">Guided support</span><h3>Read-only playbook</h3></div>{activePlaybook && <span className={`tf-status-badge ${activePlaybook.supportLevel === 'supported' ? 'success' : 'warning'}`}>{activePlaybook.supportLevel}</span>}</div>
            {activePlaybook ? (
              <div className="direct-playbook-card">
                <p className="direct-playbook-description">{activePlaybook.description}</p>
                <div className="direct-step-list">{activePlaybook.steps.map((step) => <div key={step.id} className="direct-step-row"><span className={`tf-status-badge ${step.kind === 'navigate' ? 'success' : step.kind === 'permission' ? 'warning' : 'info'}`}>{step.kind}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></div>)}</div>
              </div>
            ) : <SvcState variant="empty" message="Analyze an identifier or fill the direct-access fields to load a guided playbook for this target." />}
          </section>

          {accessDenied && (
            <section className="direct-section direct-permission-panel">
              <div className="direct-section-head"><div><span className="direct-pane-kicker">Permission guidance</span><h3>AccessDenied fallback</h3></div></div>
              <p className="direct-playbook-description">The lookup hit an authorization boundary. Keep the workflow read-only and capture the smallest missing permission set instead of widening access broadly.</p>
              {permissionHints.length ? <div className="direct-hint-list">{permissionHints.map((hint) => <span key={hint}>{hint}</span>)}</div> : <SvcState variant="empty" message="No target-specific permission hints are available for this lookup yet." />}
            </section>
          )}

          <CollapsibleInfoPanel title="Continue in a service console" eyebrow="Next actions" className="direct-section direct-info-panel">
            {suggestedLinks.length > 0 ? (
              <div className="info-card-grid">
                {suggestedLinks.map((link) => (
                  <article key={`${link.label}:${link.focus?.service ?? link.serviceId}`} className="info-card info-card-action">
                    <div className="info-card__copy"><strong>{link.label}</strong><p>{link.description}</p></div>
                    <div className="button-row"><button type="button" className="accent" onClick={() => { if (link.focus) { onNavigate(link.focus); return } if (link.serviceId) onNavigateService(link.serviceId) }}>Open</button></div>
                  </article>
                ))}
              </div>
            ) : <SvcState variant="empty" message="Open a supported direct lookup to unlock a routed next action into the main console." />}
          </CollapsibleInfoPanel>

          <section className="direct-section">
            <div className="direct-section-head"><div><span className="direct-pane-kicker">Response</span><h3>Lookup output</h3></div></div>
            {!sections.length ? loading ? <SvcState variant="loading" resourceName="resource data" message="Opening resource and gathering payloads..." /> : <SvcState variant="empty" message="Enter a known identifier and open the resource directly." /> : (
              <div className="direct-result-layout">
                <div className="direct-result-list">{sections.map((section, index) => <button key={`${section.title}:${index}`} type="button" className={`direct-result-row ${index === selectedSectionIndex ? 'active' : ''}`} onClick={() => setSelectedSectionIndex(index)}><strong>{section.title}</strong><span>{summarizeSectionData(section.data)}</span></button>)}</div>
                <div className="direct-result-viewer">{selectedSection ? <><div className="direct-result-viewer-head"><div><span className="direct-pane-kicker">Selected payload</span><h3>{selectedSection.title}</h3></div><span className="direct-result-summary">{summarizeSectionData(selectedSection.data)}</span></div><pre className="svc-code direct-result-code">{pretty(selectedSection.data)}</pre></> : <SvcState variant="no-selection" resourceName="result section" />}</div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
