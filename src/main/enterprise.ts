import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app, dialog, type BrowserWindow } from 'electron'

import { PRODUCT_BRAND_NAME, PRODUCT_BRAND_SLUG } from '@shared/branding'
import type {
  AwsConnection,
  CloudProviderId,
  EnterpriseAccessMode,
  EnterpriseAuditEvent,
  EnterpriseAuditExportResult,
  EnterpriseAuditOutcome,
  EnterpriseSettings,
  ServiceId,
  TerraformCommandRequest
} from '@shared/types'
import { getCallerIdentity } from './aws/sts'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'
import { exportAuditEvent } from './exporters'

const DEFAULT_SETTINGS: EnterpriseSettings = {
  accessMode: 'read-only',
  updatedAt: ''
}

const AUDIT_RETENTION_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

const ALWAYS_OPERATOR_CHANNELS = new Set<string>([
  'profiles:delete',
  'profiles:save-credentials',
  'profiles:choose-and-import',
  'session-hub:target:save',
  'session-hub:target:delete',
  'session-hub:session:delete',
  'session-hub:assume',
  'session-hub:assume-target',
  'elbv2:delete-load-balancer',
  'ec2:attach-volume',
  'ec2:detach-volume',
  'ec2:delete-volume',
  'ec2:modify-volume',
  'ec2:action',
  'ec2:terminate',
  'ec2:create-snapshot',
  'ec2:delete-snapshot',
  'ec2:attach-iam-profile',
  'ec2:replace-iam-profile',
  'ec2:remove-iam-profile',
  'ec2:launch-bastion',
  'ec2:delete-bastion',
  'ec2:create-temp-volume-check',
  'ec2:delete-temp-volume-check',
  'ec2:launch-from-snapshot',
  'ec2:send-ssh-public-key',
  'ec2:ssm:start-session',
  'ec2:ssm:send-command',
  'eks:update-nodegroup-scaling',
  'eks:delete-cluster',
  'eks:add-kubeconfig',
  'eks:launch-kubectl',
  'eks:run-command',
  'terraform:projects:add',
  'terraform:projects:rename',
  'terraform:projects:remove',
  'terraform:workspace:create',
  'terraform:workspace:delete',
  'terraform:inputs:update',
  'terraform:history:delete',
  'iam:create-access-key',
  'iam:delete-access-key',
  'iam:update-access-key-status',
  'iam:delete-mfa-device',
  'iam:attach-user-policy',
  'iam:detach-user-policy',
  'iam:put-user-inline-policy',
  'iam:delete-user-inline-policy',
  'iam:add-user-to-group',
  'iam:remove-user-from-group',
  'iam:create-user',
  'iam:delete-user',
  'iam:create-login-profile',
  'iam:delete-login-profile',
  'iam:update-role-trust-policy',
  'iam:attach-role-policy',
  'iam:detach-role-policy',
  'iam:put-role-inline-policy',
  'iam:delete-role-inline-policy',
  'iam:create-role',
  'iam:delete-role',
  'iam:attach-group-policy',
  'iam:detach-group-policy',
  'iam:create-group',
  'iam:delete-group',
  'iam:create-policy-version',
  'iam:delete-policy-version',
  'iam:create-policy',
  'iam:delete-policy',
  'iam:generate-credential-report',
  'acm:request-certificate',
  'acm:delete-certificate',
  'secrets:create',
  'secrets:delete',
  'secrets:restore',
  'secrets:update-value',
  'secrets:update-description',
  'secrets:rotate',
  'secrets:put-policy',
  'secrets:tag',
  'secrets:untag',
  'key-pairs:create',
  'key-pairs:delete',
  'sts:assume-role',
  'waf:create-web-acl',
  'waf:delete-web-acl',
  'waf:add-rule',
  'waf:update-rules-json',
  'waf:delete-rule',
  'waf:associate-resource',
  'waf:disassociate-resource',
  'route53:upsert-record',
  'route53:delete-record',
  'ecs:update-desired-count',
  'ecs:force-redeploy',
  'ecs:stop-task',
  'ecs:delete-service',
  'ecs:create-fargate-service',
  'lambda:invoke',
  'lambda:create',
  'lambda:delete',
  'auto-scaling:update-capacity',
  'auto-scaling:start-refresh',
  'auto-scaling:delete-group',
  's3:create-bucket',
  's3:delete-object',
  's3:create-folder',
  's3:download-object',
  's3:download-object-to',
  's3:open-object',
  's3:open-in-vscode',
  's3:put-object-content',
  's3:upload-object',
  's3:enable-versioning',
  's3:enable-encryption',
  's3:put-bucket-policy',
  'rds:start-instance',
  'rds:stop-instance',
  'rds:reboot-instance',
  'rds:resize-instance',
  'rds:create-snapshot',
  'rds:start-cluster',
  'rds:stop-cluster',
  'rds:failover-cluster',
  'rds:create-cluster-snapshot',
  'cloudformation:create-change-set',
  'cloudformation:execute-change-set',
  'cloudformation:delete-change-set',
  'cloudformation:start-drift-detection',
  'sso:create-instance',
  'sso:delete-instance',
  'sns:create-topic',
  'sns:delete-topic',
  'sns:set-topic-attribute',
  'sns:subscribe',
  'sns:unsubscribe',
  'sns:publish',
  'sns:tag-topic',
  'sns:untag-topic',
  'sqs:create-queue',
  'sqs:delete-queue',
  'sqs:purge-queue',
  'sqs:set-attributes',
  'sqs:send-message',
  'sqs:delete-message',
  'sqs:change-visibility',
  'sqs:tag-queue',
  'sqs:untag-queue',
  'terminal:open-aws',
  'terminal:open-provider-context',
  'terminal:update-aws-context',
  'terminal:update-provider-context',
  'terminal:input',
  'terminal:run-command'
])

const PROVIDER_OPERATOR_SEGMENTS = new Set<string>([
  'add',
  'associate',
  'attach',
  'clear',
  'create',
  'delete',
  'detach',
  'disable',
  'disassociate',
  'download',
  'enable',
  'force',
  'invalidate',
  'invoke',
  'open',
  'publish',
  'purge',
  'put',
  'remove',
  'resize',
  'restore',
  'rotate',
  'send',
  'set',
  'start',
  'stop',
  'subscribe',
  'toggle',
  'undelete',
  'unsubscribe',
  'update',
  'upload',
  'upsert'
])

const PROVIDER_AUDIT_EXCLUDED_PREFIXES = [
  'azure:auth:',
  'azure:context:',
  'gcp:auth:',
  'gcp:cache:'
]

const PROVIDER_SERVICE_PREFIXES: Array<[string, ServiceId]> = [
  ['gcp:projects', 'gcp-projects'],
  ['gcp:iam', 'gcp-iam'],
  ['gcp:compute-engine', 'gcp-compute-engine'],
  ['gcp:vpc', 'gcp-vpc'],
  ['gcp:gke', 'gcp-gke'],
  ['gcp:cloud-storage', 'gcp-cloud-storage'],
  ['gcp:cloud-sql', 'gcp-cloud-sql'],
  ['gcp:logging', 'gcp-logging'],
  ['gcp:billing', 'gcp-billing'],
  ['gcp:bigquery', 'gcp-bigquery'],
  ['gcp:monitoring', 'gcp-monitoring'],
  ['gcp:scc', 'gcp-scc'],
  ['gcp:firestore', 'gcp-firestore'],
  ['gcp:pubsub', 'gcp-pubsub'],
  ['gcp:cloud-run', 'gcp-cloud-run'],
  ['gcp:firebase', 'gcp-firebase'],
  ['gcp:cloud-dns', 'gcp-cloud-dns'],
  ['gcp:memorystore', 'gcp-memorystore'],
  ['gcp:load-balancer', 'gcp-load-balancer'],
  ['azure:subscriptions', 'azure-subscriptions'],
  ['azure:resource-groups', 'azure-resource-groups'],
  ['azure:rbac', 'azure-rbac'],
  ['azure:virtual-machines', 'azure-virtual-machines'],
  ['azure:aks', 'azure-aks'],
  ['azure:storage-', 'azure-storage-accounts'],
  ['azure:sql', 'azure-sql'],
  ['azure:postgresql', 'azure-postgresql'],
  ['azure:monitor', 'azure-monitor'],
  ['azure:cost', 'azure-cost'],
  ['azure:network', 'azure-network'],
  ['azure:vmss', 'azure-vmss'],
  ['azure:app-insights', 'azure-app-insights'],
  ['azure:key-vault', 'azure-key-vault'],
  ['azure:event-hub', 'azure-event-hub'],
  ['azure:app-service', 'azure-app-service'],
  ['azure:mysql', 'azure-mysql'],
  ['azure:cosmos-db', 'azure-cosmos-db'],
  ['azure:log-analytics', 'azure-log-analytics'],
  ['azure:event-grid', 'azure-event-grid'],
  ['azure:firewall', 'azure-firewall'],
  ['azure:load-balancers', 'azure-load-balancers'],
  ['azure:dns', 'azure-dns'],
  ['azure:defender', 'azure-defender']
]

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'enterprise-settings.json')
}

function auditPath(): string {
  return path.join(app.getPath('userData'), 'enterprise-audit-log.json')
}

function readSettings(): EnterpriseSettings {
  const stored = readSecureJsonFile<EnterpriseSettings>(settingsPath(), {
    fallback: DEFAULT_SETTINGS,
    fileLabel: 'Enterprise settings'
  })

  const accessMode: EnterpriseAccessMode = stored.accessMode === 'operator' ? 'operator' : 'read-only'
  return {
    accessMode,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : ''
  }
}

function writeSettings(settings: EnterpriseSettings): EnterpriseSettings {
  writeSecureJsonFile(settingsPath(), settings, 'Enterprise settings')
  return settings
}

function isWithinRetention(entry: EnterpriseAuditEvent, retentionDays = AUDIT_RETENTION_DAYS): boolean {
  const happenedAt = new Date(entry.happenedAt).getTime()
  if (!Number.isFinite(happenedAt)) {
    return false
  }

  return happenedAt >= Date.now() - (retentionDays * MS_PER_DAY)
}

function readAuditLog(): EnterpriseAuditEvent[] {
  const entries = readSecureJsonFile<EnterpriseAuditEvent[]>(auditPath(), {
    fallback: [],
    fileLabel: 'Enterprise audit log'
  })

  if (!Array.isArray(entries)) {
    return []
  }

  const filtered = entries
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string')
    .filter((entry) => isWithinRetention(entry))
    .sort((left, right) => right.happenedAt.localeCompare(left.happenedAt))

  if (filtered.length !== entries.length) {
    writeSecureJsonFile(auditPath(), filtered, 'Enterprise audit log')
  }

  return filtered
}

function writeAuditLog(entries: EnterpriseAuditEvent[]): void {
  writeSecureJsonFile(
    auditPath(),
    entries.filter((entry) => isWithinRetention(entry)),
    'Enterprise audit log'
  )
}

const accountIdCache = new Map<string, string>()

function accountCacheKey(connection: AwsConnection): string {
  return `${connection.kind}:${connection.sessionId}:${connection.region}`
}

function stringArg(args: unknown[], index: number): string {
  const value = args[index]
  return typeof value === 'string' ? value.trim() : ''
}

function lastStringArg(args: unknown[]): string {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const value = stringArg(args, index)
    if (value) return value
  }

  return ''
}

async function resolveAccountId(connection?: AwsConnection | null): Promise<string> {
  if (!connection) {
    return ''
  }

  if (connection.kind === 'assumed-role') {
    accountIdCache.set(accountCacheKey(connection), connection.accountId)
    return connection.accountId
  }

  const cacheKey = accountCacheKey(connection)
  const cached = accountIdCache.get(cacheKey)
  if (cached) {
    return cached
  }

  try {
    const identity = await Promise.race([
      getCallerIdentity(connection),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getCallerIdentity timed out after 10s')), 10_000)
      )
    ])
    const accountId = identity.account ?? ''
    if (accountId) {
      accountIdCache.set(cacheKey, accountId)
    }
    return accountId
  } catch {
    return ''
  }
}

async function summarizeConnection(connection?: AwsConnection | null): Promise<Pick<EnterpriseAuditEvent, 'providerId' | 'actorLabel' | 'accountId' | 'region'>> {
  if (!connection) {
    return {
      providerId: undefined,
      actorLabel: 'local-app',
      accountId: '',
      region: ''
    }
  }

  if (connection.kind === 'assumed-role') {
    return {
      providerId: 'aws',
      actorLabel: `${connection.label} (${connection.sourceProfile})`,
      accountId: await resolveAccountId(connection),
      region: connection.region
    }
  }

  return {
    providerId: 'aws',
    actorLabel: connection.profile,
    accountId: await resolveAccountId(connection),
    region: connection.region
  }
}

function inferProviderId(channel: string): CloudProviderId | undefined {
  if (channel.startsWith('gcp:')) return 'gcp'
  if (channel.startsWith('azure:')) return 'azure'
  return undefined
}

function inferProviderLocation(channel: string, args: unknown[]): string {
  if (channel.startsWith('gcp:compute-engine:')) return stringArg(args, 1)
  if (channel.startsWith('gcp:gke:')) return stringArg(args, 1)
  if (channel.startsWith('gcp:cloud-run:')) return stringArg(args, 1)
  if (channel.startsWith('gcp:memorystore:')) return stringArg(args, 1)
  if (channel.startsWith('gcp:logging:')) return stringArg(args, 1)
  return ''
}

async function summarizeAuditContext(channel: string, args: unknown[]): Promise<Pick<EnterpriseAuditEvent, 'providerId' | 'actorLabel' | 'accountId' | 'region'>> {
  const connection = findConnection(args)
  if (connection) {
    return summarizeConnection(connection)
  }

  const providerId = inferProviderId(channel)
  if (!providerId) {
    return summarizeConnection(null)
  }

  const scope = stringArg(args, 0)
  return {
    providerId,
    actorLabel: providerId === 'gcp' ? 'gcp-project' : 'azure-subscription',
    accountId: scope,
    region: inferProviderLocation(channel, args)
  }
}

function findConnection(args: unknown[]): AwsConnection | null {
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') {
      continue
    }

    if ('kind' in arg && 'region' in arg && 'sessionId' in arg) {
      return arg as AwsConnection
    }

    if ('connection' in arg && arg.connection && typeof arg.connection === 'object') {
      return arg.connection as AwsConnection
    }
  }

  return null
}

function isProviderOperatorAction(channel: string): boolean {
  if (!channel.startsWith('gcp:') && !channel.startsWith('azure:')) {
    return false
  }

  if (PROVIDER_AUDIT_EXCLUDED_PREFIXES.some((prefix) => channel.startsWith(prefix))) {
    return false
  }

  return channel
    .split(':')
    .some((segment) => {
      if (PROVIDER_OPERATOR_SEGMENTS.has(segment)) {
        return true
      }

      const [verb] = segment.split('-')
      return PROVIDER_OPERATOR_SEGMENTS.has(verb)
    })
}

function isOperatorAction(channel: string, args: unknown[]): boolean {
  if (ALWAYS_OPERATOR_CHANNELS.has(channel)) {
    return true
  }

  if (channel === 'terraform:command:run') {
    const request = args[0] as TerraformCommandRequest | undefined
    return Boolean(request && ['apply', 'destroy', 'import', 'state-mv', 'state-rm', 'force-unlock'].includes(request.command))
  }

  return isProviderOperatorAction(channel)
}

function inferServiceId(channel: string): ServiceId | '' {
  const providerService = PROVIDER_SERVICE_PREFIXES.find(([prefix]) => channel.startsWith(prefix))
  if (providerService) return providerService[1]

  if (channel.startsWith('ec2:')) return 'ec2'
  if (channel.startsWith('cloudtrail:')) return 'cloudtrail'
  if (channel.startsWith('cloudformation:')) return 'cloudformation'
  if (channel.startsWith('eks:')) return 'eks'
  if (channel.startsWith('ecs:')) return 'ecs'
  if (channel.startsWith('route53:')) return 'route53'
  if (channel.startsWith('lambda:')) return 'lambda'
  if (channel.startsWith('auto-scaling:')) return 'auto-scaling'
  if (channel.startsWith('s3:')) return 's3'
  if (channel.startsWith('rds:')) return 'rds'
  if (channel.startsWith('sns:')) return 'sns'
  if (channel.startsWith('sqs:')) return 'sqs'
  if (channel.startsWith('sso:')) return 'identity-center'
  if (channel.startsWith('iam:')) return 'iam'
  if (channel.startsWith('acm:')) return 'acm'
  if (channel.startsWith('secrets:')) return 'secrets-manager'
  if (channel.startsWith('key-pairs:')) return 'key-pairs'
  if (channel.startsWith('sts:')) return 'sts'
  if (channel.startsWith('waf:')) return 'waf'
  if (channel.startsWith('elbv2:')) return 'load-balancers'
  if (channel.startsWith('terminal:')) return 'session-hub'
  if (channel.startsWith('session-hub:')) return 'session-hub'
  if (channel.startsWith('profiles:')) return 'session-hub'
  if (channel.startsWith('terraform:')) return 'terraform'
  return ''
}

function summarizeGcpResource(channel: string, args: unknown[]): { resourceId: string; details: string[] } {
  const details: string[] = ['provider:gcp']
  const projectId = stringArg(args, 0)
  if (projectId) details.push(`project:${projectId}`)

  if (channel.startsWith('gcp:iam:')) {
    if (channel.includes('binding')) {
      const role = stringArg(args, 1)
      const member = stringArg(args, 2)
      if (role) details.push(`role:${role}`)
      if (member) details.push(`member:${member}`)
      return { resourceId: role || member || projectId, details }
    }

    const identity = stringArg(args, 1)
    return { resourceId: identity || projectId, details }
  }

  if (channel.startsWith('gcp:compute-engine:')) {
    const zone = stringArg(args, 1)
    const instanceName = stringArg(args, 2)
    const requestedAction = stringArg(args, 3)
    if (zone) details.push(`zone:${zone}`)
    if (requestedAction) details.push(`requested-action:${requestedAction}`)
    return { resourceId: instanceName || projectId, details }
  }

  if (channel.startsWith('gcp:gke:')) {
    const location = stringArg(args, 1)
    const clusterName = stringArg(args, 2)
    const nodePoolName = stringArg(args, 3)
    if (location) details.push(`location:${location}`)
    if (nodePoolName) details.push(`node-pool:${nodePoolName}`)
    return { resourceId: clusterName || projectId, details }
  }

  if (channel.startsWith('gcp:cloud-storage:')) {
    const bucketName = stringArg(args, 1)
    const key = stringArg(args, 2)
    if (bucketName) details.push(`bucket:${bucketName}`)
    if (key) details.push(`object:${key}`)
    return { resourceId: key ? `${bucketName}/${key}` : bucketName || projectId, details }
  }

  if (channel.startsWith('gcp:cloud-dns:')) {
    const managedZone = stringArg(args, 1)
    const recordName = channel.endsWith(':delete-record') ? stringArg(args, 2) : ''
    if (managedZone) details.push(`zone:${managedZone}`)
    if (recordName) details.push(`record:${recordName}`)
    return { resourceId: recordName || managedZone || projectId, details }
  }

  if (channel.startsWith('gcp:monitoring:')) {
    const target = stringArg(args, 1)
    return { resourceId: target || projectId, details }
  }

  return { resourceId: lastStringArg(args) || projectId, details }
}

function summarizeAzureResource(channel: string, args: unknown[]): { resourceId: string; details: string[] } {
  const details: string[] = ['provider:azure']
  const subscriptionId = stringArg(args, 0)
  if (subscriptionId) details.push(`subscription:${subscriptionId}`)

  if (channel.startsWith('azure:rbac:create-assignment')) {
    const principalId = stringArg(args, 1)
    const roleDefinitionId = stringArg(args, 2)
    const scope = stringArg(args, 3)
    if (principalId) details.push(`principal:${principalId}`)
    if (roleDefinitionId) details.push(`role:${roleDefinitionId}`)
    return { resourceId: scope || principalId || subscriptionId, details }
  }

  if (channel.startsWith('azure:rbac:delete-assignment')) {
    return { resourceId: subscriptionId, details }
  }

  if (channel.startsWith('azure:virtual-machines:') || channel.startsWith('azure:app-service:')) {
    const resourceGroup = stringArg(args, 1)
    const resourceName = stringArg(args, 2)
    const requestedAction = stringArg(args, 3)
    if (resourceGroup) details.push(`resource-group:${resourceGroup}`)
    if (requestedAction) details.push(`requested-action:${requestedAction}`)
    return { resourceId: resourceName || subscriptionId, details }
  }

  if (channel.startsWith('azure:aks:')) {
    const resourceGroup = stringArg(args, 1)
    const clusterName = stringArg(args, 2)
    const nodePoolName = stringArg(args, 3)
    if (resourceGroup) details.push(`resource-group:${resourceGroup}`)
    if (nodePoolName) details.push(`node-pool:${nodePoolName}`)
    return { resourceId: clusterName || subscriptionId, details }
  }

  if (channel.startsWith('azure:storage-blob:')) {
    const resourceGroup = stringArg(args, 1)
    const accountName = stringArg(args, 2)
    const containerName = stringArg(args, 3)
    const key = stringArg(args, 4)
    if (resourceGroup) details.push(`resource-group:${resourceGroup}`)
    if (accountName) details.push(`account:${accountName}`)
    if (containerName) details.push(`container:${containerName}`)
    if (key) details.push(`object:${key}`)
    return { resourceId: key ? `${accountName}/${containerName}/${key}` : accountName || subscriptionId, details }
  }

  if (channel.startsWith('azure:storage-container:')) {
    const resourceGroup = stringArg(args, 1)
    const accountName = stringArg(args, 2)
    const containerName = stringArg(args, 3)
    if (resourceGroup) details.push(`resource-group:${resourceGroup}`)
    if (accountName) details.push(`account:${accountName}`)
    return { resourceId: containerName || accountName || subscriptionId, details }
  }

  if (channel.startsWith('azure:vmss:')) {
    const resourceGroup = stringArg(args, 1)
    const vmssName = stringArg(args, 2)
    const instanceId = stringArg(args, 3)
    const requestedAction = stringArg(args, 4)
    if (resourceGroup) details.push(`resource-group:${resourceGroup}`)
    if (instanceId) details.push(`instance:${instanceId}`)
    if (requestedAction) details.push(`requested-action:${requestedAction}`)
    return { resourceId: vmssName || subscriptionId, details }
  }

  if (channel.startsWith('azure:dns:')) {
    const resourceGroup = stringArg(args, 1)
    const zoneName = stringArg(args, 2)
    const recordName = stringArg(args, 4)
    if (resourceGroup) details.push(`resource-group:${resourceGroup}`)
    if (recordName) details.push(`record:${recordName}`)
    return { resourceId: recordName || zoneName || subscriptionId, details }
  }

  if (channel.startsWith('azure:log-analytics:')) {
    return { resourceId: subscriptionId, details }
  }

  return { resourceId: lastStringArg(args) || subscriptionId, details }
}

function summarizeResource(channel: string, args: unknown[]): { resourceId: string; details: string[] } {
  const details: string[] = []

  if (channel === 'terraform:command:run') {
    const request = args[0] as TerraformCommandRequest | undefined
    if (!request) {
      return { resourceId: '', details }
    }

    details.push(`command:${request.command}`, `project:${request.projectId}`)
    if (request.stateAddress) details.push(`state-address:${request.stateAddress}`)
    return {
      resourceId: request.projectId,
      details
    }
  }

  if (channel === 'ec2:action') {
    const [, instanceId, action] = args as [AwsConnection | undefined, string | undefined, string | undefined]
    if (typeof action === 'string' && action.trim()) {
      details.push(`requested-action:${action.trim()}`)
    }
    return {
      resourceId: typeof instanceId === 'string' ? instanceId.trim() : '',
      details
    }
  }

  if (channel.startsWith('gcp:')) {
    return summarizeGcpResource(channel, args)
  }

  if (channel.startsWith('azure:')) {
    return summarizeAzureResource(channel, args)
  }

  for (const arg of args) {
    if (typeof arg === 'string' && arg.trim()) {
      return { resourceId: arg.trim(), details }
    }
  }

  return { resourceId: '', details }
}

function toActionLabel(channel: string): string {
  return channel
    .replace(/:/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function inferActionLabel(channel: string, args: unknown[]): string {
  if (channel === 'ec2:action') {
    const [, , action] = args as [AwsConnection | undefined, string | undefined, string | undefined]
    if (typeof action === 'string' && action.trim()) {
      return `${action.trim().replace(/\b\w/g, (char) => char.toUpperCase())} instance`
    }
  }

  if (channel === 'terraform:command:run') {
    const request = args[0] as TerraformCommandRequest | undefined
    if (request?.command) {
      return `Terraform ${request.command}`
    }
  }

  return toActionLabel(channel)
}

// Serialise all audit writes to prevent TOCTOU races under concurrent IPC traffic.
let auditWriteChain: Promise<void> = Promise.resolve()

function appendAuditEvent(event: EnterpriseAuditEvent): Promise<void> {
  return (auditWriteChain = auditWriteChain
    .then(() => {
      const current = readAuditLog()
      const next = [event, ...current].slice(0, 500)
      writeAuditLog(next)
      exportAuditEvent(event)
    })
    .catch(() => { /* never let a write failure break the chain */ }))
}

export function getEnterpriseSettings(): EnterpriseSettings {
  return readSettings()
}

export function setEnterpriseAccessMode(accessMode: EnterpriseAccessMode): EnterpriseSettings {
  const next: EnterpriseSettings = {
    accessMode,
    updatedAt: new Date().toISOString()
  }
  return writeSettings(next)
}

export function assertEnterpriseAccess(channel: string, args: unknown[]): EnterpriseSettings {
  const settings = readSettings()
  if (settings.accessMode !== 'operator' && isOperatorAction(channel, args)) {
      throw new Error(`${PRODUCT_BRAND_NAME} is in read-only mode. Switch to operator mode to run mutating or command execution actions.`)
  }

  return settings
}

export async function recordEnterpriseAuditEvent(
  channel: string,
  args: unknown[],
  outcome: EnterpriseAuditOutcome,
  settings: EnterpriseSettings,
  errorMessage?: string
): Promise<void> {
  if (!isOperatorAction(channel, args)) {
    return
  }

  const summary = await summarizeAuditContext(channel, args)
  const resource = summarizeResource(channel, args)
  const details = [...resource.details]
  if (summary.providerId && !details.some((detail) => detail === `provider:${summary.providerId}`)) {
    details.unshift(`provider:${summary.providerId}`)
  }

  if (errorMessage) {
    details.push(`error:${errorMessage}`)
  }

  await appendAuditEvent({
    id: randomUUID(),
    happenedAt: new Date().toISOString(),
    providerId: summary.providerId,
    accessMode: settings.accessMode,
    outcome,
    action: inferActionLabel(channel, args),
    channel,
    summary: errorMessage ?? inferActionLabel(channel, args),
    actorLabel: summary.actorLabel,
    accountId: summary.accountId,
    region: summary.region,
    serviceId: inferServiceId(channel),
    resourceId: resource.resourceId,
    details
  })
}

export function listEnterpriseAuditEvents(): EnterpriseAuditEvent[] {
  return readAuditLog()
}

export async function exportEnterpriseAuditEvents(owner?: BrowserWindow | null): Promise<EnterpriseAuditExportResult> {
  const scopePrompt = {
    type: 'question' as const,
    buttons: ['Last 7 Days', 'Last 1 Day', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: 'Export audit trail',
    message: 'Choose the audit export range.',
    detail: 'Local audit retention is 7 days. Export either the last 7 days or only the last 1 day.'
  }

  const scopeChoice = owner
    ? await dialog.showMessageBox(owner, scopePrompt)
    : await dialog.showMessageBox(scopePrompt)

  if (scopeChoice.response === 2) {
    return { path: '', eventCount: 0 }
  }

  const rangeDays: 1 | 7 = scopeChoice.response === 1 ? 1 : 7
  const threshold = Date.now() - (rangeDays * MS_PER_DAY)
  const events = readAuditLog().filter((event) => new Date(event.happenedAt).getTime() >= threshold)
  const defaultFileName = `${PRODUCT_BRAND_SLUG}-audit-${rangeDays}d-${new Date().toISOString().slice(0, 10)}.json`
  const result = owner
    ? await dialog.showSaveDialog(owner, {
        title: 'Export audit trail',
        defaultPath: path.join(app.getPath('documents'), defaultFileName),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
    : await dialog.showSaveDialog({
        title: 'Export audit trail',
        defaultPath: path.join(app.getPath('documents'), defaultFileName),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })

  if (result.canceled || !result.filePath) {
    return { path: '', eventCount: 0 }
  }

  fs.writeFileSync(result.filePath, `${JSON.stringify(events, null, 2)}\n`, 'utf8')
  return {
    path: result.filePath,
    eventCount: events.length,
    rangeDays
  }
}
