import { useEffect, useState } from 'react'
import './iam.css'

import {
  listIamUsers,
  listIamGroups,
  listIamRoles,
  listIamPolicies,
  getIamAccountSummary,
  listIamAccessKeys,
  createIamAccessKey,
  deleteIamAccessKey,
  updateIamAccessKeyStatus,
  listIamMfaDevices,
  deleteIamMfaDevice,
  listAttachedIamUserPolicies,
  listIamUserInlinePolicies,
  attachIamUserPolicy,
  detachIamUserPolicy,
  putIamUserInlinePolicy,
  deleteIamUserInlinePolicy,
  listIamUserGroups,
  addIamUserToGroup,
  removeIamUserFromGroup,
  createIamUser,
  deleteIamUser,
  createIamLoginProfile,
  deleteIamLoginProfile,
  listAttachedIamRolePolicies,
  listIamRoleInlinePolicies,
  getIamRoleTrustPolicy,
  updateIamRoleTrustPolicy,
  attachIamRolePolicy,
  detachIamRolePolicy,
  putIamRoleInlinePolicy,
  deleteIamRoleInlinePolicy,
  createIamRole,
  deleteIamRole,
  listAttachedIamGroupPolicies,
  attachIamGroupPolicy,
  detachIamGroupPolicy,
  createIamGroup,
  deleteIamGroup,
  getIamPolicyVersion,
  listIamPolicyVersions,
  createIamPolicyVersion,
  deleteIamPolicyVersion,
  createIamPolicy,
  deleteIamPolicy,
  simulateIamPolicy,
  generateIamCredentialReport,
  getIamCredentialReport
} from './api'
import type {
  AwsConnection,
  IamUserSummary,
  IamGroupSummary,
  IamRoleSummary,
  IamPolicySummary,
  IamAccessKeySummary,
  IamMfaDevice,
  IamAttachedPolicy,
  IamInlinePolicy,
  IamPolicyVersion,
  IamAccountSummary,
  IamSimulationResult,
  IamCredentialReportEntry
} from '@shared/types'

/* ── Types ────────────────────────────────────────────────── */

type MainTab = 'users' | 'groups' | 'roles' | 'policies' | 'account' | 'simulator'
type ColDef<T> = { key: string; label: string; color: string; getValue: (item: T) => string }

/* ── Constants ────────────────────────────────────────────── */

const MAIN_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'users', label: 'Users' },
  { id: 'groups', label: 'Groups' },
  { id: 'roles', label: 'Roles' },
  { id: 'policies', label: 'Policies' },
  { id: 'simulator', label: 'Simulator' }
]

type SimEntity = { type: 'User' | 'Role'; name: string; arn: string }

const SIM_IAM_ACTIONS = [
  // IAM / STS
  'iam:ListUsers', 'iam:GetUser', 'iam:CreateUser', 'iam:DeleteUser',
  'iam:ListAccessKeys', 'iam:CreateAccessKey', 'iam:DeleteAccessKey', 'iam:UpdateAccessKey',
  'iam:GetLoginProfile', 'iam:CreateLoginProfile', 'iam:DeleteLoginProfile',
  'iam:ListMFADevices', 'iam:DeactivateMFADevice',
  'iam:ListGroupsForUser', 'iam:AddUserToGroup', 'iam:RemoveUserFromGroup',
  'iam:ListGroups', 'iam:GetGroup', 'iam:CreateGroup', 'iam:DeleteGroup',
  'iam:ListRoles', 'iam:GetRole', 'iam:CreateRole', 'iam:DeleteRole',
  'iam:UpdateAssumeRolePolicy', 'iam:PassRole',
  'iam:ListPolicies', 'iam:GetPolicy', 'iam:GetPolicyVersion',
  'iam:CreatePolicy', 'iam:DeletePolicy',
  'iam:AttachUserPolicy', 'iam:DetachUserPolicy',
  'iam:PutUserPolicy', 'iam:GetUserPolicy', 'iam:DeleteUserPolicy',
  'iam:AttachGroupPolicy', 'iam:DetachGroupPolicy',
  'iam:PutGroupPolicy', 'iam:GetGroupPolicy', 'iam:DeleteGroupPolicy',
  'iam:AttachRolePolicy', 'iam:DetachRolePolicy',
  'iam:PutRolePolicy', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy',
  'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:ListPolicyVersions',
  'iam:GetAccountSummary', 'iam:GetAccountPasswordPolicy',
  'iam:SimulatePrincipalPolicy', 'iam:GenerateCredentialReport', 'iam:GetCredentialReport',
  'iam:ListInstanceProfiles',
  'sts:AssumeRole', 'sts:GetCallerIdentity',

  // IAM Identity Center / SSO / Identity Store
  'sso:DescribeRegisteredRegions', 'sso:ListDirectoryAssociations',
  'sso:ListProfiles', 'sso:ListApplications', 'sso:DescribeApplication',
  'sso:AssociateProfile', 'sso:DisassociateProfile',
  'sso:CreateManagedApplicationInstance', 'sso:DeleteManagedApplicationInstance',
  'sso-directory:DescribeDirectory', 'sso-directory:SearchUsers', 'sso-directory:SearchGroups',
  'identitystore:ListUsers', 'identitystore:DescribeUser',
  'identitystore:CreateUser', 'identitystore:UpdateUser', 'identitystore:DeleteUser',
  'identitystore:ListGroups', 'identitystore:DescribeGroup',
  'identitystore:CreateGroup', 'identitystore:UpdateGroup', 'identitystore:DeleteGroup',
  'identitystore:ListGroupMemberships', 'identitystore:IsMemberInGroups',

  // ACM
  'acm:ListCertificates', 'acm:DescribeCertificate',
  'acm:RequestCertificate', 'acm:DeleteCertificate',

  // Auto Scaling
  'autoscaling:DescribeAutoScalingGroups', 'autoscaling:UpdateAutoScalingGroup',
  'autoscaling:DeleteAutoScalingGroup', 'autoscaling:DescribePolicies', 'autoscaling:ExecutePolicy',

  // CloudFormation
  'cloudformation:DescribeStacks', 'cloudformation:DescribeStackResources',
  'cloudformation:GetTemplate', 'cloudformation:ValidateTemplate',
  'cloudformation:CreateStack', 'cloudformation:UpdateStack',
  'cloudformation:RollbackStack', 'cloudformation:ContinueUpdateRollback',
  'cloudformation:CancelUpdateStack', 'cloudformation:DeleteStack',

  // CloudTrail
  'cloudtrail:LookupEvents', 'cloudtrail:DescribeTrails',

  // CloudWatch / Logs
  'cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics', 'cloudwatch:GetMetricData',
  'logs:DescribeLogGroups', 'logs:DescribeLogStreams',
  'logs:GetLogEvents', 'logs:CreateLogGroup',

  // Cost Explorer
  'ce:GetCostAndUsage', 'ce:GetCostForecast',

  // EC2 / Networking
  'ec2:DescribeInstances', 'ec2:DescribeInstanceStatus',
  'ec2:DescribeImages', 'ec2:DescribeSnapshots',
  'ec2:CreateImage', 'ec2:DeregisterImage', 'ec2:DeleteSnapshot',
  'ec2:RunInstances', 'ec2:StartInstances', 'ec2:StopInstances',
  'ec2:RebootInstances', 'ec2:TerminateInstances',
  'ec2:ModifyInstanceAttribute', 'ec2:CreateTags', 'ec2:DeleteTags',
  'ec2:DescribeVolumes', 'ec2:DescribeSecurityGroups',
  'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup',
  'ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress',
  'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress',
  'ec2:DescribeKeyPairs', 'ec2:CreateKeyPair', 'ec2:DeleteKeyPair',
  'ec2:DescribeVpcs', 'ec2:DescribeSubnets', 'ec2:DescribeRouteTables',
  'ec2:DescribeNetworkAcls', 'ec2:DescribeNetworkInterfaces',
  'ec2:DescribeInternetGateways', 'ec2:DescribeNatGateways',
  'ec2:DescribeTransitGateways', 'ec2:DescribeNetworkInsightsPaths',
  'ec2:DescribeNetworkInsightsAnalyses', 'ec2:CreateNetworkInsightsPath',
  'ec2:StartNetworkInsightsAnalysis',

  // ECR
  'ecr:DescribeRepositories', 'ecr:CreateRepository', 'ecr:DeleteRepository',
  'ecr:ListImages', 'ecr:BatchDeleteImage',
  'ecr:PutImageTagMutability', 'ecr:PutLifecyclePolicy', 'ecr:GetLifecyclePolicy',
  'ecr:GetAuthorizationToken', 'ecr:BatchGetImage',

  // ECS
  'ecs:ListClusters', 'ecs:DescribeClusters',
  'ecs:ListTasks', 'ecs:DescribeTasks',
  'ecs:ListServices', 'ecs:DescribeServices', 'ecs:UpdateService',
  'ecs:ExecuteCommand', 'ecs:RunTask', 'ecs:StopTask',
  'ecs:DescribeTaskDefinition',

  // EKS
  'eks:ListClusters', 'eks:DescribeCluster',
  'eks:ListNodegroups', 'eks:DescribeNodegroup',
  'eks:CreateCluster', 'eks:UpdateClusterVersion', 'eks:DeleteCluster',

  // Lambda
  'lambda:ListFunctions', 'lambda:GetFunction',
  'lambda:CreateFunction', 'lambda:DeleteFunction',
  'lambda:UpdateFunctionCode', 'lambda:InvokeFunction',

  // Elastic Load Balancing
  'elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeRules', 'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetHealth', 'elasticloadbalancing:DeleteLoadBalancer',

  // S3
  's3:ListBucket', 's3:ListAllMyBuckets',
  's3:GetObject', 's3:HeadObject',
  's3:CreateBucket', 's3:PutObject', 's3:DeleteObject',

  // RDS
  'rds:DescribeDBInstances', 'rds:DescribeDBClusters', 'rds:DescribeDBSnapshots',
  'rds:CreateDBInstance', 'rds:CreateDBSnapshot',
  'rds:StartDBInstance', 'rds:StopDBInstance', 'rds:RebootDBInstance', 'rds:DeleteDBInstance',
  'rds:StopDBCluster', 'rds:StartDBCluster', 'rds:DeleteDBCluster', 'rds:ModifyDBInstance',

  // Route 53
  'route53:ListHostedZones', 'route53:ListResourceRecordSets', 'route53:ChangeResourceRecordSets',

  // Secrets Manager
  'secretsmanager:GetSecretValue', 'secretsmanager:ListSecrets', 'secretsmanager:DescribeSecret',
  'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:RestoreSecret',
  'secretsmanager:RotateSecret', 'secretsmanager:TagResource', 'secretsmanager:UntagResource',
  'secretsmanager:ListSecretVersionIds', 'secretsmanager:GetResourcePolicy',
  'secretsmanager:PutResourcePolicy', 'secretsmanager:DeleteResourcePolicy',

  // KMS
  'kms:Decrypt', 'kms:Encrypt', 'kms:ListAliases',
  'kms:ListKeys', 'kms:DescribeKey',

  // SNS
  'sns:ListTopics', 'sns:GetTopicAttributes', 'sns:ListSubscriptionsByTopic',
  'sns:ListTagsForResource', 'sns:CreateTopic', 'sns:DeleteTopic',
  'sns:Publish', 'sns:Subscribe', 'sns:Unsubscribe',
  'sns:TagResource', 'sns:UntagResource',

  // SQS
  'sqs:ListQueues', 'sqs:GetQueueAttributes', 'sqs:ListQueueTags',
  'sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:PurgeQueue', 'sqs:SetQueueAttributes',
  'sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage',
  'sqs:ChangeMessageVisibility', 'sqs:TagQueue', 'sqs:UntagQueue',

  // Tagging
  'tag:GetResources',

  // WAFv2
  'wafv2:ListWebACLs', 'wafv2:GetWebACL', 'wafv2:CreateWebACL',
  'wafv2:AssociateWebACL', 'wafv2:DisassociateWebACL', 'wafv2:UpdateWebACL',
]

function formatTs(value: string): string {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function confirmIamDelete(actionLabel: string, targetLabel: string): boolean {
  const firstPrompt = `Delete ${actionLabel} ${targetLabel}?`
  const secondPrompt = `Confirm deletion of ${actionLabel} ${targetLabel}. This action may be irreversible.`

  return window.confirm(firstPrompt) && window.confirm(secondPrompt)
}

const USER_COLS: ColDef<IamUserSummary>[] = [
  { key: 'userName', label: 'UserName', color: '#3b82f6', getValue: u => u.userName },
  { key: 'userId', label: 'UserId', color: '#14b8a6', getValue: u => u.userId },
  { key: 'path', label: 'Path', color: '#8b5cf6', getValue: u => u.path },
  { key: 'createDate', label: 'CreateDate', color: '#22c55e', getValue: u => formatTs(u.createDate) },
  { key: 'passwordLastUsed', label: 'PasswordLastUsed', color: '#f59e0b', getValue: u => u.passwordLastUsed ? formatTs(u.passwordLastUsed) : '-' },
]

const AK_COLS: ColDef<IamAccessKeySummary>[] = [
  { key: 'accessKeyId', label: 'AccessKeyId', color: '#3b82f6', getValue: k => k.accessKeyId },
  { key: 'status', label: 'Status', color: '#14b8a6', getValue: k => k.status },
  { key: 'createDate', label: 'CreateDate', color: '#22c55e', getValue: k => formatTs(k.createDate) },
]

const UG_COLS: ColDef<{ name: string }>[] = [
  { key: 'groupName', label: 'GroupName', color: '#22c55e', getValue: g => g.name },
  { key: 'groupId', label: 'GroupId', color: '#3b82f6', getValue: () => '-' },
]

const UP_COLS: ColDef<IamAttachedPolicy>[] = [
  { key: 'policyName', label: 'PolicyName', color: '#3b82f6', getValue: p => p.policyName },
  { key: 'policyArn', label: 'PolicyArn', color: '#14b8a6', getValue: p => p.policyArn },
  { key: 'resources', label: 'Resources', color: '#22c55e', getValue: () => '-' },
]

const GROUP_COLS: ColDef<IamGroupSummary>[] = [
  { key: 'groupName', label: 'GroupName', color: '#22c55e', getValue: g => g.groupName },
  { key: 'groupId', label: 'GroupId', color: '#3b82f6', getValue: g => g.groupId },
]

const ROLE_COLS: ColDef<IamRoleSummary>[] = [
  { key: 'roleName', label: 'RoleName', color: '#3b82f6', getValue: r => r.roleName },
  { key: 'description', label: 'Description', color: '#14b8a6', getValue: r => r.description || '-' },
  { key: 'policies', label: 'Policies', color: '#22c55e', getValue: r => String(r.attachedPolicyCount) },
]

const POLICY_COLS: ColDef<IamPolicySummary>[] = [
  { key: 'policyName', label: 'PolicyName', color: '#3b82f6', getValue: p => p.policyName },
  { key: 'attachments', label: 'Attachments', color: '#14b8a6', getValue: p => String(p.attachmentCount) },
  { key: 'scope', label: 'Scope', color: '#22c55e', getValue: p => p.isAwsManaged ? 'AWS' : 'Local' },
]

/* ── Helper components ────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase()
  const cls =
    s === 'active' || s === 'allowed' || s === 'true'
      ? 'svc-badge ok'
      : s === 'inactive' || s === 'pending' || s === 'implicitdeny'
        ? 'svc-badge warn'
        : s === 'denied' || s === 'explicitdeny' || s === 'false'
          ? 'svc-badge danger'
          : 'svc-badge muted'
  return <span className={cls}>{status}</span>
}

function MiniFilterTable<T>({
  columns,
  data,
  getKey,
}: {
  columns: ColDef<T>[]
  data: T[]
  getKey: (item: T) => string
}) {
  const [filter, setFilter] = useState('')
  const [visibleCols, setVisibleCols] = useState(() => new Set(columns.map(c => c.key)))

  const activeCols = columns.filter(c => visibleCols.has(c.key))
  const filtered = data.filter(item => {
    if (!filter) return true
    const s = filter.toLowerCase()
    return activeCols.some(c => c.getValue(item).toLowerCase().includes(s))
  })

  function toggleCol(key: string) {
    setVisibleCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  return (
    <>
      <input
        className="iam-section-search"
        placeholder="Filter rows across selected columns..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <div className="iam-section-chips">
        {columns.map(c => (
          <button
            key={c.key}
            type="button"
            className={`svc-chip ${visibleCols.has(c.key) ? 'active' : ''}`}
            style={visibleCols.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
            onClick={() => toggleCol(c.key)}
          >{c.label}</button>
        ))}
      </div>
      <div className="iam-caret">▽</div>
      <table className="iam-mini-table">
        <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {filtered.map(item => (
            <tr key={getKey(item)}>
              {activeCols.map(c => <td key={c.key}>{c.getValue(item)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {!filtered.length && <div className="svc-empty" style={{ padding: '8px 0', fontSize: '11px' }}>No items.</div>}
    </>
  )
}

/* ── Simulator Panel ─────────────────────────────────────── */

const SIM_ENTITY_COLS = [
  { key: 'type', label: 'Type' },
  { key: 'name', label: 'Name' },
  { key: 'arn', label: 'Arn' },
]
const SIM_RESULT_COLS = [
  { key: 'service', label: 'Service' },
  { key: 'action', label: 'Action' },
  { key: 'resources', label: 'Resources' },
  { key: 'decision', label: 'Decision' },
]

function SimulatorPanel({
  entities, entitiesLoading, selectedEntity, onSelectEntity,
  results, loading, onSimulate,
}: {
  entities: SimEntity[]
  entitiesLoading: boolean
  selectedEntity: SimEntity | null
  onSelectEntity: (e: SimEntity | null) => void
  results: IamSimulationResult[]
  loading: boolean
  onSimulate: () => void
}) {
  const [leftFilter, setLeftFilter] = useState('')
  const [leftCols, setLeftCols] = useState(() => new Set(SIM_ENTITY_COLS.map(c => c.key)))
  const [rightFilter, setRightFilter] = useState('')
  const [rightCols, setRightCols] = useState(() => new Set(SIM_RESULT_COLS.map(c => c.key)))

  const activeLCols = SIM_ENTITY_COLS.filter(c => leftCols.has(c.key))
  const filteredEntities = entities.filter(e => {
    if (!leftFilter) return true
    const s = leftFilter.toLowerCase()
    return (leftCols.has('type') && e.type.toLowerCase().includes(s)) ||
      (leftCols.has('name') && e.name.toLowerCase().includes(s)) ||
      (leftCols.has('arn') && e.arn.toLowerCase().includes(s))
  })

  const activeRCols = SIM_RESULT_COLS.filter(c => rightCols.has(c.key))
  const resultRows = results.map(r => ({
    service: r.actionName.split(':')[0] || '',
    action: r.actionName,
    resources: r.resourceArn || '-',
    decision: r.decision,
  }))
  const filteredResults = resultRows.filter(r => {
    if (!rightFilter) return true
    const s = rightFilter.toLowerCase()
    return (rightCols.has('service') && r.service.toLowerCase().includes(s)) ||
      (rightCols.has('action') && r.action.toLowerCase().includes(s)) ||
      (rightCols.has('resources') && r.resources.toLowerCase().includes(s)) ||
      (rightCols.has('decision') && r.decision.toLowerCase().includes(s))
  })

  return (
    <div className="sim-layout">
      {/* ── Left: Entities ── */}
      <div className="sim-panel">
        <div className="sim-panel-body">
          <input
            className="iam-section-search"
            placeholder="Filter rows across selected columns..."
            value={leftFilter}
            onChange={e => setLeftFilter(e.target.value)}
          />
          <div className="iam-section-chips">
            {SIM_ENTITY_COLS.map(c => (
              <button
                key={c.key}
                type="button"
                className={`svc-chip ${leftCols.has(c.key) ? 'active' : ''}`}
                style={leftCols.has(c.key) ? { background: '#3b82f6', borderColor: '#3b82f6' } : undefined}
                onClick={() => setLeftCols(prev => {
                  const n = new Set(prev); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n
                })}
              >{c.label}</button>
            ))}
          </div>
          <div className="iam-caret">▽</div>
          <div className="sim-table-scroll">
            <table className="iam-mini-table">
              <thead>
                <tr>{activeLCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {entitiesLoading && <tr><td colSpan={activeLCols.length} style={{ textAlign: 'center', color: '#6b7688' }}>Loading...</td></tr>}
                {!entitiesLoading && filteredEntities.map(e => (
                  <tr
                    key={e.arn}
                    className={selectedEntity?.arn === e.arn ? 'sim-row-selected' : ''}
                    onClick={() => onSelectEntity(selectedEntity?.arn === e.arn ? null : e)}
                    style={{ cursor: 'pointer' }}
                  >
                    {leftCols.has('type') && <td><span className={`sim-type-badge ${e.type.toLowerCase()}`}>{e.type}</span></td>}
                    {leftCols.has('name') && <td className={selectedEntity?.arn === e.arn ? 'sim-name-selected' : ''}>{e.name}</td>}
                    {leftCols.has('arn') && <td style={{ fontSize: '0.72rem', maxWidth: 160 }}>{e.arn}</td>}
                  </tr>
                ))}
                {!entitiesLoading && !filteredEntities.length && (
                  <tr><td colSpan={activeLCols.length} style={{ textAlign: 'center', color: '#6b7688', padding: 16 }}>No items.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="sim-panel-footer">
          <button
            className="svc-btn success"
            type="button"
            disabled={loading || !selectedEntity}
            onClick={onSimulate}
          >
            {loading ? 'Simulating...' : 'Simulate Selected'}
          </button>
        </div>
      </div>

      {/* ── Right: Results ── */}
      <div className="sim-panel">
        <div className="sim-panel-body">
          <input
            className="iam-section-search"
            placeholder="Filter rows across selected columns..."
            value={rightFilter}
            onChange={e => setRightFilter(e.target.value)}
          />
          <div className="iam-section-chips">
            {SIM_RESULT_COLS.map(c => (
              <button
                key={c.key}
                type="button"
                className={`svc-chip ${rightCols.has(c.key) ? 'active' : ''}`}
                style={rightCols.has(c.key) ? { background: '#3b82f6', borderColor: '#3b82f6' } : undefined}
                onClick={() => setRightCols(prev => {
                  const n = new Set(prev); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n
                })}
              >{c.label}</button>
            ))}
          </div>
          <div className="iam-caret">▽</div>
          <div className="sim-table-scroll">
            <table className="iam-mini-table">
              <thead>
                <tr>{activeRCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={activeRCols.length} style={{ textAlign: 'center', color: '#6b7688' }}>Simulating...</td></tr>}
                {!loading && filteredResults.map((r, i) => (
                  <tr key={i}>
                    {rightCols.has('service') && <td><span className="sim-service-icon">⚠</span> {r.service}</td>}
                    {rightCols.has('action') && <td>{r.action}</td>}
                    {rightCols.has('resources') && <td>{r.resources}</td>}
                    {rightCols.has('decision') && <td><StatusBadge status={r.decision} /></td>}
                  </tr>
                ))}
                {!loading && !filteredResults.length && !results.length && (
                  <tr><td colSpan={activeRCols.length} style={{ textAlign: 'center', color: '#6b7688', padding: 16 }}>Select an entity and click Simulate Selected.</td></tr>
                )}
                {!loading && !filteredResults.length && results.length > 0 && (
                  <tr><td colSpan={activeRCols.length} style={{ textAlign: 'center', color: '#6b7688', padding: 16 }}>No matching results.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Main IAM Console ────────────────────────────────────── */

export function IamConsole({ connection }: { connection: AwsConnection }) {

  /* ── Main tab ────────────────────────────────────────────── */
  const [mainTab, setMainTab] = useState<MainTab>('users')
  const [mainTabLoading, setMainTabLoading] = useState<MainTab | null>('users')
  const [tabsOpen, setTabsOpen] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  /* ── Users ───────────────────────────────────────────────── */
  const [users, setUsers] = useState<IamUserSummary[]>([])
  const [selectedUser, setSelectedUser] = useState<IamUserSummary | null>(null)
  const [accessKeys, setAccessKeys] = useState<IamAccessKeySummary[]>([])
  const [newKeySecret, setNewKeySecret] = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null)
  const [mfaDevices, setMfaDevices] = useState<IamMfaDevice[]>([])
  const [userGroups, setUserGroups] = useState<string[]>([])
  const [userAttachedPolicies, setUserAttachedPolicies] = useState<IamAttachedPolicy[]>([])
  const [userInlinePolicies, setUserInlinePolicies] = useState<IamInlinePolicy[]>([])
  const [newUserName, setNewUserName] = useState('')
  const [addGroupName, setAddGroupName] = useState('')
  const [attachPolicyArn, setAttachPolicyArn] = useState('')
  const [inlinePolicyName, setInlinePolicyName] = useState('')
  const [inlinePolicyJson, setInlinePolicyJson] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginRequireReset, setLoginRequireReset] = useState(true)

  /* ── Groups ──────────────────────────────────────────────── */
  const [groups, setGroups] = useState<IamGroupSummary[]>([])
  const [selectedGroup, setSelectedGroup] = useState<IamGroupSummary | null>(null)
  const [groupAttachedPolicies, setGroupAttachedPolicies] = useState<IamAttachedPolicy[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [groupAttachArn, setGroupAttachArn] = useState('')

  /* ── Roles ───────────────────────────────────────────────── */
  const [roles, setRoles] = useState<IamRoleSummary[]>([])
  const [selectedRole, setSelectedRole] = useState<IamRoleSummary | null>(null)
  const [roleAttachedPolicies, setRoleAttachedPolicies] = useState<IamAttachedPolicy[]>([])
  const [roleInlinePolicies, setRoleInlinePolicies] = useState<IamInlinePolicy[]>([])
  const [roleTrustPolicy, setRoleTrustPolicy] = useState('')
  const [roleAttachArn, setRoleAttachArn] = useState('')
  const [roleInlineName, setRoleInlineName] = useState('')
  const [roleInlineJson, setRoleInlineJson] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleTrust, setNewRoleTrust] = useState('')
  const [newRoleDesc, setNewRoleDesc] = useState('')

  /* ── Policies ────────────────────────────────────────────── */
  const [policies, setPolicies] = useState<IamPolicySummary[]>([])
  const [policyScope, setPolicyScope] = useState<'Local' | 'All'>('Local')
  const [selectedPolicy, setSelectedPolicy] = useState<IamPolicySummary | null>(null)
  const [policyVersions, setPolicyVersions] = useState<IamPolicyVersion[]>([])
  const [viewVersionDoc, setViewVersionDoc] = useState('')
  const [newVersionJson, setNewVersionJson] = useState('')
  const [newVersionDefault, setNewVersionDefault] = useState(true)
  const [newPolicyName, setNewPolicyName] = useState('')
  const [newPolicyJson, setNewPolicyJson] = useState('')
  const [newPolicyDesc, setNewPolicyDesc] = useState('')

  /* ── Account Summary ─────────────────────────────────────── */
  const [accountSummary, setAccountSummary] = useState<IamAccountSummary | null>(null)
  const [credReport, setCredReport] = useState<IamCredentialReportEntry[]>([])
  const [credReportLoading, setCredReportLoading] = useState(false)

  /* ── Policy Simulator ────────────────────────────────────── */
  const [simEntities, setSimEntities] = useState<SimEntity[]>([])
  const [selectedSimEntity, setSelectedSimEntity] = useState<SimEntity | null>(null)
  const [simResults, setSimResults] = useState<IamSimulationResult[]>([])
  const [simLoading, setSimLoading] = useState(false)
  const [simEntitiesLoading, setSimEntitiesLoading] = useState(false)

  /* ── UI state ────────────────────────────────────────────── */
  const [userFilter, setUserFilter] = useState('')
  const [userVisibleCols, setUserVisibleCols] = useState(() => new Set(USER_COLS.map(c => c.key)))
  const [groupFilter, setGroupFilter] = useState('')
  const [groupVisibleCols, setGroupVisibleCols] = useState(() => new Set(GROUP_COLS.map(c => c.key)))
  const [roleFilter, setRoleFilter] = useState('')
  const [roleVisibleCols, setRoleVisibleCols] = useState(() => new Set(ROLE_COLS.map(c => c.key)))
  const [policyFilter, setPolicyFilter] = useState('')
  const [policyVisibleCols, setPolicyVisibleCols] = useState(() => new Set(POLICY_COLS.map(c => c.key)))
  const [expandedSections, setExpandedSections] = useState(() => new Set(['accessKeys', 'groups', 'policies', 'attached', 'inline', 'trust', 'versions']))

  /* ── Effects ─────────────────────────────────────────────── */

  useEffect(() => {
    void loadMainTab('users', connection)
}, [connection.sessionId, connection.region])

  function switchMainTab(tab: MainTab) {
    setMainTab(tab)
    setSelectedUser(null)
    setSelectedGroup(null)
    setSelectedRole(null)
    setSelectedPolicy(null)
    setSelectedSimEntity(null)
    setSimResults([])
    setError('')
    setSuccess('')
    void loadMainTab(tab)
  }

  async function loadMainTab(tab: MainTab, conn?: AwsConnection) {
    const c = conn ?? connection
    setMainTabLoading(tab)
    try {
      if (tab === 'users') setUsers(await listIamUsers(c))
      else if (tab === 'groups') setGroups(await listIamGroups(c))
      else if (tab === 'roles') setRoles(await listIamRoles(c))
      else if (tab === 'policies') setPolicies(await listIamPolicies(c, policyScope))
      else if (tab === 'account') setAccountSummary(await getIamAccountSummary(c))
      else if (tab === 'simulator') {
        setSimEntitiesLoading(true)
        try {
          const [u, r] = await Promise.all([listIamUsers(c), listIamRoles(c)])
          setSimEntities([
            ...u.map(x => ({ type: 'User' as const, name: x.userName, arn: x.arn })),
            ...r.map(x => ({ type: 'Role' as const, name: x.roleName, arn: x.arn }))
          ])
        } finally {
          setSimEntitiesLoading(false)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMainTabLoading((current) => (current === tab ? null : current))
    }
  }

  /* ── User detail loaders ─────────────────────────────────── */

  async function selectUser(user: IamUserSummary) {
    if (!connection) return
    setSelectedUser(user)
    setNewKeySecret(null)
    setError('')
    try {
      const [keys, mfa, grps, attached, inline] = await Promise.all([
        listIamAccessKeys(connection, user.userName),
        listIamMfaDevices(connection, user.userName),
        listIamUserGroups(connection, user.userName),
        listAttachedIamUserPolicies(connection, user.userName),
        listIamUserInlinePolicies(connection, user.userName)
      ])
      setAccessKeys(keys)
      setMfaDevices(mfa)
      setUserGroups(grps)
      setUserAttachedPolicies(attached)
      setUserInlinePolicies(inline)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreateAccessKey() {
    if (!connection || !selectedUser) return
    setError('')
    try {
      const result = await createIamAccessKey(connection, selectedUser.userName)
      setNewKeySecret(result)
      setAccessKeys(await listIamAccessKeys(connection, selectedUser.userName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteAccessKey(keyId: string) {
    if (!connection || !selectedUser) return
    if (!confirmIamDelete('access key', `${keyId} for user ${selectedUser.userName}`)) return
    setError('')
    try {
      await deleteIamAccessKey(connection, selectedUser.userName, keyId)
      setAccessKeys(await listIamAccessKeys(connection, selectedUser.userName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleToggleAccessKey(keyId: string, currentStatus: string) {
    if (!connection || !selectedUser) return
    const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active'
    setError('')
    try {
      await updateIamAccessKeyStatus(connection, selectedUser.userName, keyId, newStatus)
      setAccessKeys(await listIamAccessKeys(connection, selectedUser.userName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteMfa(serialNumber: string) {
    if (!connection || !selectedUser) return
    if (!confirmIamDelete('MFA device', `${serialNumber} for user ${selectedUser.userName}`)) return
    setError('')
    try {
      await deleteIamMfaDevice(connection, selectedUser.userName, serialNumber)
      setMfaDevices(await listIamMfaDevices(connection, selectedUser.userName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleAddToGroup() {
    if (!connection || !selectedUser || !addGroupName.trim()) return
    setError('')
    try {
      await addIamUserToGroup(connection, selectedUser.userName, addGroupName.trim())
      setUserGroups(await listIamUserGroups(connection, selectedUser.userName))
      setAddGroupName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleRemoveFromGroup(groupName: string) {
    if (!connection || !selectedUser) return
    setError('')
    try {
      await removeIamUserFromGroup(connection, selectedUser.userName, groupName)
      setUserGroups(await listIamUserGroups(connection, selectedUser.userName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleAttachUserPolicy() {
    if (!connection || !selectedUser || !attachPolicyArn.trim()) return
    setError('')
    try {
      await attachIamUserPolicy(connection, selectedUser.userName, attachPolicyArn.trim())
      setUserAttachedPolicies(await listAttachedIamUserPolicies(connection, selectedUser.userName))
      setAttachPolicyArn('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDetachUserPolicy(arn: string) {
    if (!connection || !selectedUser) return
    setError('')
    try {
      await detachIamUserPolicy(connection, selectedUser.userName, arn)
      setUserAttachedPolicies(await listAttachedIamUserPolicies(connection, selectedUser.userName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handlePutUserInlinePolicy() {
    if (!connection || !selectedUser || !inlinePolicyName.trim() || !inlinePolicyJson.trim()) return
    setError('')
    setSuccess('')
    try {
      const policyName = inlinePolicyName.trim()
      await putIamUserInlinePolicy(connection, selectedUser.userName, policyName, inlinePolicyJson.trim())
      setUserInlinePolicies(await listIamUserInlinePolicies(connection, selectedUser.userName))
      setInlinePolicyName('')
      setInlinePolicyJson('')
      setSuccess(`Saved inline policy ${policyName} for user ${selectedUser.userName}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteUserInlinePolicy(policyName: string) {
    if (!connection || !selectedUser) return
    if (!confirmIamDelete('inline policy', `${policyName} for user ${selectedUser.userName}`)) return
    setError('')
    setSuccess('')
    try {
      await deleteIamUserInlinePolicy(connection, selectedUser.userName, policyName)
      setUserInlinePolicies(await listIamUserInlinePolicies(connection, selectedUser.userName))
      setSuccess(`Deleted inline policy ${policyName} from user ${selectedUser.userName}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreateLoginProfile() {
    if (!connection || !selectedUser || !loginPassword.trim()) return
    setError('')
    try {
      await createIamLoginProfile(connection, selectedUser.userName, loginPassword.trim(), loginRequireReset)
      setLoginPassword('')
      setUsers(await listIamUsers(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteLoginProfile() {
    if (!connection || !selectedUser) return
    if (!confirmIamDelete('console login profile', `for user ${selectedUser.userName}`)) return
    setError('')
    try {
      await deleteIamLoginProfile(connection, selectedUser.userName)
      setUsers(await listIamUsers(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreateUser() {
    if (!connection || !newUserName.trim()) return
    setError('')
    try {
      await createIamUser(connection, newUserName.trim())
      setNewUserName('')
      setUsers(await listIamUsers(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteUser(userName: string) {
    if (!connection) return
    if (!confirmIamDelete('IAM user', userName)) return
    setError('')
    try {
      await deleteIamUser(connection, userName)
      if (selectedUser?.userName === userName) setSelectedUser(null)
      setUsers(await listIamUsers(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Group handlers ──────────────────────────────────────── */

  async function selectGroup(group: IamGroupSummary) {
    if (!connection) return
    setSelectedGroup(group)
    setError('')
    try {
      setGroupAttachedPolicies(await listAttachedIamGroupPolicies(connection, group.groupName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleAttachGroupPolicy() {
    if (!connection || !selectedGroup || !groupAttachArn.trim()) return
    setError('')
    try {
      await attachIamGroupPolicy(connection, selectedGroup.groupName, groupAttachArn.trim())
      setGroupAttachedPolicies(await listAttachedIamGroupPolicies(connection, selectedGroup.groupName))
      setGroupAttachArn('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDetachGroupPolicy(arn: string) {
    if (!connection || !selectedGroup) return
    setError('')
    try {
      await detachIamGroupPolicy(connection, selectedGroup.groupName, arn)
      setGroupAttachedPolicies(await listAttachedIamGroupPolicies(connection, selectedGroup.groupName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreateGroup() {
    if (!connection || !newGroupName.trim()) return
    setError('')
    try {
      await createIamGroup(connection, newGroupName.trim())
      setNewGroupName('')
      setGroups(await listIamGroups(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteGroup(groupName: string) {
    if (!connection) return
    if (!confirmIamDelete('IAM group', groupName)) return
    setError('')
    try {
      await deleteIamGroup(connection, groupName)
      if (selectedGroup?.groupName === groupName) setSelectedGroup(null)
      setGroups(await listIamGroups(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Role handlers ───────────────────────────────────────── */

  async function selectRole(role: IamRoleSummary) {
    if (!connection) return
    setSelectedRole(role)
    setError('')
    try {
      const [attached, inline, trust] = await Promise.all([
        listAttachedIamRolePolicies(connection, role.roleName),
        listIamRoleInlinePolicies(connection, role.roleName),
        getIamRoleTrustPolicy(connection, role.roleName)
      ])
      setRoleAttachedPolicies(attached)
      setRoleInlinePolicies(inline)
      setRoleTrustPolicy(typeof trust === 'string' ? trust : JSON.stringify(trust, null, 2))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleAttachRolePolicy() {
    if (!connection || !selectedRole || !roleAttachArn.trim()) return
    setError('')
    try {
      await attachIamRolePolicy(connection, selectedRole.roleName, roleAttachArn.trim())
      setRoleAttachedPolicies(await listAttachedIamRolePolicies(connection, selectedRole.roleName))
      setRoleAttachArn('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDetachRolePolicy(arn: string) {
    if (!connection || !selectedRole) return
    setError('')
    try {
      await detachIamRolePolicy(connection, selectedRole.roleName, arn)
      setRoleAttachedPolicies(await listAttachedIamRolePolicies(connection, selectedRole.roleName))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handlePutRoleInlinePolicy() {
    if (!connection || !selectedRole || !roleInlineName.trim() || !roleInlineJson.trim()) return
    setError('')
    setSuccess('')
    try {
      const policyName = roleInlineName.trim()
      await putIamRoleInlinePolicy(connection, selectedRole.roleName, policyName, roleInlineJson.trim())
      setRoleInlinePolicies(await listIamRoleInlinePolicies(connection, selectedRole.roleName))
      setRoleInlineName('')
      setRoleInlineJson('')
      setSuccess(`Saved inline policy ${policyName} for role ${selectedRole.roleName}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteRoleInlinePolicy(policyName: string) {
    if (!connection || !selectedRole) return
    if (!confirmIamDelete('inline policy', `${policyName} for role ${selectedRole.roleName}`)) return
    setError('')
    setSuccess('')
    try {
      await deleteIamRoleInlinePolicy(connection, selectedRole.roleName, policyName)
      setRoleInlinePolicies(await listIamRoleInlinePolicies(connection, selectedRole.roleName))
      setSuccess(`Deleted inline policy ${policyName} from role ${selectedRole.roleName}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleUpdateTrustPolicy() {
    if (!connection || !selectedRole || !roleTrustPolicy.trim()) return
    setError('')
    setSuccess('')
    try {
      await updateIamRoleTrustPolicy(connection, selectedRole.roleName, roleTrustPolicy.trim())
      setSuccess(`Updated trust policy for role ${selectedRole.roleName}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreateRole() {
    if (!connection || !newRoleName.trim() || !newRoleTrust.trim()) return
    setError('')
    try {
      await createIamRole(connection, newRoleName.trim(), newRoleTrust.trim(), newRoleDesc.trim())
      setNewRoleName('')
      setNewRoleTrust('')
      setNewRoleDesc('')
      setRoles(await listIamRoles(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteRole(roleName: string) {
    if (!connection) return
    if (!confirmIamDelete('IAM role', roleName)) return
    setError('')
    try {
      await deleteIamRole(connection, roleName)
      if (selectedRole?.roleName === roleName) setSelectedRole(null)
      setRoles(await listIamRoles(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Policy handlers ─────────────────────────────────────── */

  async function loadPolicies(scope?: 'Local' | 'All') {
    if (!connection) return
    const s = scope ?? policyScope
    try {
      setPolicies(await listIamPolicies(connection, s))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function selectPolicy(policy: IamPolicySummary) {
    if (!connection) return
    setSelectedPolicy(policy)
    setViewVersionDoc('')
    setError('')
    try {
      setPolicyVersions(await listIamPolicyVersions(connection, policy.arn))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleViewPolicyVersion(arn: string, versionId: string) {
    if (!connection) return
    setError('')
    try {
      const doc = await getIamPolicyVersion(connection, arn, versionId)
      setViewVersionDoc(typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreatePolicyVersion() {
    if (!connection || !selectedPolicy || !newVersionJson.trim()) return
    setError('')
    try {
      await createIamPolicyVersion(connection, selectedPolicy.arn, newVersionJson.trim(), newVersionDefault)
      setPolicyVersions(await listIamPolicyVersions(connection, selectedPolicy.arn))
      setNewVersionJson('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeletePolicyVersion(versionId: string) {
    if (!connection || !selectedPolicy) return
    if (!confirmIamDelete('policy version', `${versionId} from ${selectedPolicy.policyName}`)) return
    setError('')
    try {
      await deleteIamPolicyVersion(connection, selectedPolicy.arn, versionId)
      setPolicyVersions(await listIamPolicyVersions(connection, selectedPolicy.arn))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleCreatePolicy() {
    if (!connection || !newPolicyName.trim() || !newPolicyJson.trim()) return
    setError('')
    try {
      await createIamPolicy(connection, newPolicyName.trim(), newPolicyJson.trim(), newPolicyDesc.trim())
      setNewPolicyName('')
      setNewPolicyJson('')
      setNewPolicyDesc('')
      await loadPolicies()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeletePolicy(arn: string) {
    if (!connection) return
    const targetLabel = selectedPolicy?.arn === arn ? selectedPolicy.policyName : arn
    if (!confirmIamDelete('IAM policy', targetLabel)) return
    setError('')
    try {
      await deleteIamPolicy(connection, arn)
      if (selectedPolicy?.arn === arn) setSelectedPolicy(null)
      await loadPolicies()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Account / Credential Report ─────────────────────────── */

  async function handleGenerateCredReport() {
    if (!connection) return
    setCredReportLoading(true)
    setError('')
    try {
      await generateIamCredentialReport(connection)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCredReportLoading(false)
    }
  }

  async function handleGetCredReport() {
    if (!connection) return
    setCredReportLoading(true)
    setError('')
    try {
      setCredReport(await getIamCredentialReport(connection))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCredReportLoading(false)
    }
  }

  /* ── Policy Simulator ────────────────────────────────────── */

  async function handleSimulate() {
    if (!connection || !selectedSimEntity) return
    setSimLoading(true)
    setSimResults([])
    setError('')
    try {
      setSimResults(await simulateIamPolicy(connection, selectedSimEntity.arn, SIM_IAM_ACTIONS, ['*']))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSimLoading(false)
    }
  }

  /* ── Helpers ─────────────────────────────────────────────── */

  function toggleSection(id: string) {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleCol(setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) {
    setter(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function filterItems<T>(items: T[], filter: string, cols: ColDef<T>[], visible: Set<string>): T[] {
    if (!filter) return items
    const s = filter.toLowerCase()
    const active = cols.filter(c => visible.has(c.key))
    return items.filter(item => active.some(c => c.getValue(item).toLowerCase().includes(s)))
  }

  const filteredUsers = filterItems(users, userFilter, USER_COLS, userVisibleCols)
  const activeUserCols = USER_COLS.filter(c => userVisibleCols.has(c.key))
  const filteredGroups = filterItems(groups, groupFilter, GROUP_COLS, groupVisibleCols)
  const activeGroupCols = GROUP_COLS.filter(c => groupVisibleCols.has(c.key))
  const filteredRoles = filterItems(roles, roleFilter, ROLE_COLS, roleVisibleCols)
  const activeRoleCols = ROLE_COLS.filter(c => roleVisibleCols.has(c.key))
  const filteredPolicies = filterItems(policies, policyFilter, POLICY_COLS, policyVisibleCols)
  const activePolicyCols = POLICY_COLS.filter(c => policyVisibleCols.has(c.key))

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className="svc-console">
      {/* ── Main tabs ──────────────────────────────────── */}
      <div className="svc-tab-bar">
        <button className="svc-tab-hamburger" type="button" onClick={() => setTabsOpen(p => !p)}>
          <span className={`hamburger-icon ${tabsOpen ? 'open' : ''}`}>
            <span /><span /><span />
          </span>
        </button>
        {tabsOpen && MAIN_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`svc-tab ${mainTab === t.id ? 'active' : ''}`}
            onClick={() => switchMainTab(t.id)}
          >{t.label}</button>
        ))}
        {tabsOpen && <button className="svc-tab right" type="button" onClick={() => void loadMainTab(mainTab)}>Refresh</button>}
      </div>

      {error && <div className="svc-error">{error}</div>}
      {success && <div className="empty-state compact">{success}</div>}

      {/* ══════════════════ USERS ══════════════════ */}
      {mainTab === 'users' && (
        <>
          <input
            className="svc-search"
            placeholder="Filter rows across selected columns..."
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
          />
          <div className="svc-chips">
            {USER_COLS.map(c => (
              <button
                key={c.key}
                type="button"
                className={`svc-chip ${userVisibleCols.has(c.key) ? 'active' : ''}`}
                style={userVisibleCols.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
                onClick={() => toggleCol(setUserVisibleCols, c.key)}
              >{c.label}</button>
            ))}
          </div>

          <div className="iam-layout">
            {/* ── Left: Users table ────────────────────── */}
            <div className="iam-table-area">
              <table className="svc-table">
                <thead>
                  <tr>{activeUserCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {mainTabLoading === 'users' && (
                    <tr><td colSpan={activeUserCols.length}>Gathering data</td></tr>
                  )}
                  {mainTabLoading !== 'users' && filteredUsers.map(u => (
                    <tr
                      key={u.userName}
                      className={selectedUser?.userName === u.userName ? 'active' : ''}
                      onClick={() => void selectUser(u)}
                    >
                      {activeUserCols.map(c => <td key={c.key}>{c.getValue(u)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredUsers.length && mainTabLoading !== 'users' && <div className="svc-empty">No IAM users found.</div>}

              <div className="iam-bottom-actions">
                <input placeholder="New user name" value={newUserName} onChange={e => setNewUserName(e.target.value)} />
                <button className="svc-btn success" type="button" onClick={() => void handleCreateUser()}>Create User</button>
                <button
                  className="svc-btn danger"
                  type="button"
                  disabled={!selectedUser}
                  onClick={() => selectedUser && void handleDeleteUser(selectedUser.userName)}
                >Delete User</button>
              </div>
            </div>

            {/* ── Right: Sidebar ───────────────────────── */}
            <div className="iam-sidebar">
              {!selectedUser && <div className="iam-sidebar-placeholder">Select a user to view details</div>}

              {selectedUser && (
                <>
                  {/* ── Access Keys ───────────────────── */}
                  <div className="iam-section-header" onClick={() => toggleSection('accessKeys')}>
                    {expandedSections.has('accessKeys') ? '−' : '+'} Access Keys
                  </div>
                  {expandedSections.has('accessKeys') && (
                    <div className="iam-section-content">
                      {newKeySecret && (
                        <div className="iam-key-banner">
                          <strong>New Access Key (copy secret now):</strong>
                          <div>Access Key ID: <span className="mono">{newKeySecret.accessKeyId}</span></div>
                          <div>Secret: <span className="mono">{newKeySecret.secretAccessKey}</span></div>
                        </div>
                      )}
                      <MiniFilterTable<IamAccessKeySummary>
                        columns={AK_COLS}
                        data={accessKeys}
                        getKey={k => k.accessKeyId}
                      />
                      <div className="svc-btn-row">
                        <button className="svc-btn success" type="button" onClick={() => void handleCreateAccessKey()}>Create Key</button>
                        <button
                          className="svc-btn danger"
                          type="button"
                          disabled={!accessKeys.length}
                          onClick={() => {
                            if (accessKeys.length) void handleDeleteAccessKey(accessKeys[0].accessKeyId)
                          }}
                        >Delete Key</button>
                        {accessKeys.map(k => (
                          <button
                            key={k.accessKeyId}
                            className="svc-btn muted"
                            type="button"
                            onClick={() => void handleToggleAccessKey(k.accessKeyId, k.status)}
                          >
                            {k.status === 'Active' ? 'Deactivate' : 'Activate'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Groups ────────────────────────── */}
                  <div className="iam-section-header" onClick={() => toggleSection('groups')}>
                    {expandedSections.has('groups') ? '−' : '+'} Groups
                  </div>
                  {expandedSections.has('groups') && (
                    <div className="iam-section-content">
                      <MiniFilterTable<{ name: string }>
                        columns={UG_COLS}
                        data={userGroups.map(g => ({ name: g }))}
                        getKey={g => g.name}
                      />
                      <div className="iam-inline-input">
                        <input placeholder="Group name" value={addGroupName} onChange={e => setAddGroupName(e.target.value)} />
                      </div>
                      <div className="svc-btn-row">
                        <button className="svc-btn success" type="button" onClick={() => void handleAddToGroup()}>Add to Group</button>
                        {userGroups.map(g => (
                          <button
                            key={g}
                            className="svc-btn danger"
                            type="button"
                            onClick={() => void handleRemoveFromGroup(g)}
                          >Remove from Group</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Attached Policies ─────────────── */}
                  <div className="iam-section-header" onClick={() => toggleSection('policies')}>
                    {expandedSections.has('policies') ? '−' : '+'} Attached Policies
                  </div>
                  {expandedSections.has('policies') && (
                    <div className="iam-section-content">
                      <MiniFilterTable<IamAttachedPolicy>
                        columns={UP_COLS}
                        data={userAttachedPolicies}
                        getKey={p => p.policyArn}
                      />
                      <div className="iam-inline-input">
                        <input placeholder="Policy ARN" value={attachPolicyArn} onChange={e => setAttachPolicyArn(e.target.value)} />
                      </div>
                      <div className="svc-btn-row">
                        <button className="svc-btn success" type="button" onClick={() => void handleAttachUserPolicy()}>Attach Policy</button>
                        {userAttachedPolicies.map(p => (
                          <button
                            key={p.policyArn}
                            className="svc-btn danger"
                            type="button"
                            onClick={() => void handleDetachUserPolicy(p.policyArn)}
                          >Detach Policy</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Console Access / MFA ──────────── */}
                  <div className="iam-console-mfa">
                    <strong>Console Access_MFA</strong>
                  </div>
                  <div className="iam-section-content">
                    <div className="svc-btn-row" style={{ alignItems: 'center' }}>
                      <span style={{ color: '#9ca7b7', fontSize: '12px' }}>—</span>
                      <button className="svc-btn success" type="button" onClick={() => void handleCreateLoginProfile()}>Enable Console</button>
                      <button className="svc-btn danger" type="button" onClick={() => void handleDeleteLoginProfile()}>Disable Console</button>
                      <span style={{ color: '#9ca7b7', fontSize: '12px' }}>MFA: {mfaDevices.length > 0 ? 'Active' : '—'}</span>
                      {mfaDevices.map(d => (
                        <button
                          key={d.serialNumber}
                          className="svc-btn danger"
                          type="button"
                          onClick={() => void handleDeleteMfa(d.serialNumber)}
                        >Deactivate MFA</button>
                      ))}
                      {!mfaDevices.length && (
                        <button className="svc-btn danger" type="button" disabled>Deactivate MFA</button>
                      )}
                    </div>
                    <div className="iam-inline-input" style={{ marginTop: '4px' }}>
                      <input type="password" placeholder="Password (for Enable Console)" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════ GROUPS ══════════════════ */}
      {mainTab === 'groups' && (
        <>
          <input
            className="svc-search"
            placeholder="Filter rows across selected columns..."
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
          />
          <div className="svc-chips">
            {GROUP_COLS.map(c => (
              <button
                key={c.key}
                type="button"
                className={`svc-chip ${groupVisibleCols.has(c.key) ? 'active' : ''}`}
                style={groupVisibleCols.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
                onClick={() => toggleCol(setGroupVisibleCols, c.key)}
              >{c.label}</button>
            ))}
          </div>

          <div className="iam-layout">
            <div className="iam-table-area">
              <table className="svc-table">
                <thead>
                  <tr>{activeGroupCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {mainTabLoading === 'groups' && (
                    <tr><td colSpan={activeGroupCols.length}>Gathering data</td></tr>
                  )}
                  {mainTabLoading !== 'groups' && filteredGroups.map(g => (
                    <tr
                      key={g.groupName}
                      className={selectedGroup?.groupName === g.groupName ? 'active' : ''}
                      onClick={() => void selectGroup(g)}
                    >
                      {activeGroupCols.map(c => <td key={c.key}>{c.getValue(g)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredGroups.length && mainTabLoading !== 'groups' && <div className="svc-empty">No IAM groups found.</div>}

              <div className="iam-bottom-actions">
                <input placeholder="New group name" value={newGroupName} onChange={e => setNewGroupName(e.target.value)} />
                <button className="svc-btn success" type="button" onClick={() => void handleCreateGroup()}>Create Group</button>
                <button
                  className="svc-btn danger"
                  type="button"
                  disabled={!selectedGroup}
                  onClick={() => selectedGroup && void handleDeleteGroup(selectedGroup.groupName)}
                >Delete Group</button>
              </div>
            </div>

            <div className="iam-sidebar">
              {!selectedGroup && <div className="iam-sidebar-placeholder">Select a group to view details</div>}

              {selectedGroup && (
                <>
                  <div className="iam-section-header" onClick={() => toggleSection('attached')}>
                    {expandedSections.has('attached') ? '−' : '+'} Attached Policies
                  </div>
                  {expandedSections.has('attached') && (
                    <div className="iam-section-content">
                      <MiniFilterTable<IamAttachedPolicy>
                        columns={UP_COLS}
                        data={groupAttachedPolicies}
                        getKey={p => p.policyArn}
                      />
                      <div className="iam-inline-input">
                        <input placeholder="Policy ARN" value={groupAttachArn} onChange={e => setGroupAttachArn(e.target.value)} />
                      </div>
                      <div className="svc-btn-row">
                        <button className="svc-btn success" type="button" onClick={() => void handleAttachGroupPolicy()}>Attach Policy</button>
                        {groupAttachedPolicies.map(p => (
                          <button
                            key={p.policyArn}
                            className="svc-btn danger"
                            type="button"
                            onClick={() => void handleDetachGroupPolicy(p.policyArn)}
                          >Detach</button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════ ROLES ══════════════════ */}
      {mainTab === 'roles' && (
        <>
          <input
            className="svc-search"
            placeholder="Filter rows across selected columns..."
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value)}
          />
          <div className="svc-chips">
            {ROLE_COLS.map(c => (
              <button
                key={c.key}
                type="button"
                className={`svc-chip ${roleVisibleCols.has(c.key) ? 'active' : ''}`}
                style={roleVisibleCols.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
                onClick={() => toggleCol(setRoleVisibleCols, c.key)}
              >{c.label}</button>
            ))}
          </div>

          <div className="iam-layout">
            <div className="iam-table-area">
              <table className="svc-table">
                <thead>
                  <tr>{activeRoleCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {mainTabLoading === 'roles' && (
                    <tr><td colSpan={activeRoleCols.length}>Gathering data</td></tr>
                  )}
                  {mainTabLoading !== 'roles' && filteredRoles.map(r => (
                    <tr
                      key={r.roleName}
                      className={selectedRole?.roleName === r.roleName ? 'active' : ''}
                      onClick={() => void selectRole(r)}
                    >
                      {activeRoleCols.map(c => <td key={c.key}>{c.getValue(r)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredRoles.length && mainTabLoading !== 'roles' && <div className="svc-empty">No IAM roles found.</div>}

              <div className="iam-bottom-actions">
                <input placeholder="Role name" value={newRoleName} onChange={e => setNewRoleName(e.target.value)} />
                <button className="svc-btn success" type="button" onClick={() => void handleCreateRole()}>Create Role</button>
                <button
                  className="svc-btn danger"
                  type="button"
                  disabled={!selectedRole}
                  onClick={() => selectedRole && void handleDeleteRole(selectedRole.roleName)}
                >Delete Role</button>
              </div>
            </div>

            <div className="iam-sidebar">
              {!selectedRole && <div className="iam-sidebar-placeholder">Select a role to view details</div>}

              {selectedRole && (
                <>
                  {/* ── Attached Policies ─────────────── */}
                  <div className="iam-section-header" onClick={() => toggleSection('attached')}>
                    {expandedSections.has('attached') ? '−' : '+'} Attached Policies
                  </div>
                  {expandedSections.has('attached') && (
                    <div className="iam-section-content">
                      <MiniFilterTable<IamAttachedPolicy>
                        columns={UP_COLS}
                        data={roleAttachedPolicies}
                        getKey={p => p.policyArn}
                      />
                      <div className="iam-inline-input">
                        <input placeholder="Policy ARN" value={roleAttachArn} onChange={e => setRoleAttachArn(e.target.value)} />
                      </div>
                      <div className="svc-btn-row">
                        <button className="svc-btn success" type="button" onClick={() => void handleAttachRolePolicy()}>Attach Policy</button>
                        {roleAttachedPolicies.map(p => (
                          <button
                            key={p.policyArn}
                            className="svc-btn danger"
                            type="button"
                            onClick={() => void handleDetachRolePolicy(p.policyArn)}
                          >Detach</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Inline Policies ───────────────── */}
                  <div className="iam-section-header" onClick={() => toggleSection('inline')}>
                    {expandedSections.has('inline') ? '−' : '+'} Inline Policies
                  </div>
                  {expandedSections.has('inline') && (
                    <div className="iam-section-content">
                      <MiniFilterTable<IamInlinePolicy>
                        columns={[
                          { key: 'policyName', label: 'PolicyName', color: '#3b82f6', getValue: p => p.policyName },
                        ]}
                        data={roleInlinePolicies}
                        getKey={p => p.policyName}
                      />
                      <div className="iam-sidebar-form">
                        <input placeholder="Inline policy name" value={roleInlineName} onChange={e => setRoleInlineName(e.target.value)} />
                        <textarea
                          className="iam-policy-editor"
                          placeholder='{"Version":"2012-10-17","Statement":[...]}'
                          value={roleInlineJson}
                          onChange={e => setRoleInlineJson(e.target.value)}
                          rows={4}
                        />
                      </div>
                      <div className="svc-btn-row">
                        <button className="svc-btn success" type="button" onClick={() => void handlePutRoleInlinePolicy()}>Create Inline Policy</button>
                        {roleInlinePolicies.map(p => (
                          <button
                            key={p.policyName}
                            className="svc-btn danger"
                            type="button"
                            onClick={() => void handleDeleteRoleInlinePolicy(p.policyName)}
                          >Delete {p.policyName}</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Trust Policy ──────────────────── */}
                  <div className="iam-section-header" onClick={() => toggleSection('trust')}>
                    {expandedSections.has('trust') ? '−' : '+'} Trust Policy
                  </div>
                  {expandedSections.has('trust') && (
                    <div className="iam-section-content">
                      <textarea
                        className="iam-policy-editor"
                        value={roleTrustPolicy}
                        onChange={e => setRoleTrustPolicy(e.target.value)}
                        rows={10}
                      />
                      <div className="svc-btn-row">
                        <button className="svc-btn success" type="button" onClick={() => void handleUpdateTrustPolicy()}>Update Trust Policy</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════ POLICIES ══════════════════ */}
      {mainTab === 'policies' && (
        <>
          <div className="svc-btn-row" style={{ marginBottom: 4 }}>
            <button
              type="button"
              className={`svc-btn ${policyScope === 'Local' ? 'primary' : 'muted'}`}
              onClick={() => { setPolicyScope('Local'); void loadPolicies('Local') }}
            >Local</button>
            <button
              type="button"
              className={`svc-btn ${policyScope === 'All' ? 'primary' : 'muted'}`}
              onClick={() => { setPolicyScope('All'); void loadPolicies('All') }}
            >All</button>
          </div>

          <input
            className="svc-search"
            placeholder="Filter rows across selected columns..."
            value={policyFilter}
            onChange={e => setPolicyFilter(e.target.value)}
          />
          <div className="svc-chips">
            {POLICY_COLS.map(c => (
              <button
                key={c.key}
                type="button"
                className={`svc-chip ${policyVisibleCols.has(c.key) ? 'active' : ''}`}
                style={policyVisibleCols.has(c.key) ? { background: c.color, borderColor: c.color } : undefined}
                onClick={() => toggleCol(setPolicyVisibleCols, c.key)}
              >{c.label}</button>
            ))}
          </div>

          <div className="iam-layout">
            <div className="iam-table-area">
              <table className="svc-table">
                <thead>
                  <tr>{activePolicyCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {mainTabLoading === 'policies' && (
                    <tr><td colSpan={activePolicyCols.length}>Gathering data</td></tr>
                  )}
                  {mainTabLoading !== 'policies' && filteredPolicies.map(p => (
                    <tr
                      key={p.arn}
                      className={selectedPolicy?.arn === p.arn ? 'active' : ''}
                      onClick={() => void selectPolicy(p)}
                    >
                      {activePolicyCols.map(c => <td key={c.key}>{c.getValue(p)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredPolicies.length && mainTabLoading !== 'policies' && <div className="svc-empty">No IAM policies found.</div>}

              <div className="iam-bottom-actions">
                <input placeholder="Policy name" value={newPolicyName} onChange={e => setNewPolicyName(e.target.value)} />
                <button className="svc-btn success" type="button" onClick={() => void handleCreatePolicy()}>Create Policy</button>
                <button
                  className="svc-btn danger"
                  type="button"
                  disabled={!selectedPolicy || selectedPolicy.isAwsManaged}
                  onClick={() => selectedPolicy && void handleDeletePolicy(selectedPolicy.arn)}
                >Delete Policy</button>
              </div>
            </div>

            <div className="iam-sidebar">
              {!selectedPolicy && <div className="iam-sidebar-placeholder">Select a policy to view details</div>}

              {selectedPolicy && (
                <>
                  {/* ── Versions ──────────────────────── */}
                  <div className="iam-section-header" onClick={() => toggleSection('versions')}>
                    {expandedSections.has('versions') ? '−' : '+'} Versions
                  </div>
                  {expandedSections.has('versions') && (
                    <div className="iam-section-content">
                      <table className="iam-mini-table">
                        <thead>
                          <tr>
                            <th>Version</th>
                            <th>Default</th>
                            <th>Created</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {policyVersions.map(v => (
                            <tr key={v.versionId}>
                              <td>{v.versionId}</td>
                              <td><StatusBadge status={v.isDefaultVersion ? 'Active' : 'Inactive'} /></td>
                              <td>{formatTs(v.createDate)}</td>
                              <td>
                                <div className="svc-btn-row">
                                  <button className="svc-btn muted" type="button" onClick={() => void handleViewPolicyVersion(selectedPolicy.arn, v.versionId)}>View</button>
                                  {!v.isDefaultVersion && (
                                    <button className="svc-btn danger" type="button" onClick={() => void handleDeletePolicyVersion(v.versionId)}>Delete</button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!policyVersions.length && <div className="svc-empty" style={{ fontSize: '11px' }}>No versions.</div>}

                      {viewVersionDoc && (
                        <div className="iam-output-panel">
                          <pre style={{ margin: 0 }}>{viewVersionDoc}</pre>
                        </div>
                      )}

                      <div className="iam-sidebar-form" style={{ marginTop: 8 }}>
                        <textarea
                          className="iam-policy-editor"
                          placeholder="Policy document JSON"
                          value={newVersionJson}
                          onChange={e => setNewVersionJson(e.target.value)}
                          rows={4}
                        />
                        <label>
                          <input type="checkbox" checked={newVersionDefault} onChange={e => setNewVersionDefault(e.target.checked)} />
                          <span>Set as default version</span>
                        </label>
                        <button className="svc-btn success" type="button" onClick={() => void handleCreatePolicyVersion()}>Create Version</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════ ACCOUNT SUMMARY ══════════════════ */}
      {mainTab === 'account' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {accountSummary && (
            <>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#d0d8e2' }}>Account Summary</h3>
              <div className="iam-metadata-grid">
                {Object.entries(accountSummary).map(([k, v]) => (
                  <div key={k}>
                    <span>{k}</span>
                    <strong>{String(v)}</strong>
                  </div>
                ))}
              </div>
            </>
          )}

          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#d0d8e2' }}>Credential Report</h3>
          <div className="svc-btn-row">
            <button className="svc-btn success" type="button" disabled={credReportLoading} onClick={() => void handleGenerateCredReport()}>
              {credReportLoading ? 'Generating...' : 'Generate Report'}
            </button>
            <button className="svc-btn muted" type="button" disabled={credReportLoading} onClick={() => void handleGetCredReport()}>
              {credReportLoading ? 'Loading...' : 'Get Report'}
            </button>
          </div>

          {credReport.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="svc-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>ARN</th>
                    <th>Password</th>
                    <th>MFA</th>
                    <th>Key 1</th>
                    <th>Key 2</th>
                  </tr>
                </thead>
                <tbody>
                  {credReport.map(entry => (
                    <tr key={entry.user}>
                      <td>{entry.user}</td>
                      <td style={{ fontSize: '0.72rem', wordBreak: 'break-all', whiteSpace: 'normal', maxWidth: 200 }}>{entry.arn}</td>
                      <td><StatusBadge status={entry.passwordEnabled} /></td>
                      <td><StatusBadge status={entry.mfaActive} /></td>
                      <td><StatusBadge status={entry.accessKey1Active} /></td>
                      <td><StatusBadge status={entry.accessKey2Active} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!credReport.length && !credReportLoading && (
            <div className="svc-empty">Generate and retrieve a credential report to view details.</div>
          )}
        </div>
      )}

      {/* ══════════════════ POLICY SIMULATOR ══════════════════ */}
      {mainTab === 'simulator' && <SimulatorPanel
        entities={simEntities}
        entitiesLoading={simEntitiesLoading}
        selectedEntity={selectedSimEntity}
        onSelectEntity={setSelectedSimEntity}
        results={simResults}
        loading={simLoading}
        onSimulate={() => void handleSimulate()}
      />}
    </div>
  )
}
