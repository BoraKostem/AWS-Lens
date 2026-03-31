import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app, dialog, type BrowserWindow } from 'electron'

import type {
  AwsConnection,
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
  'terminal:update-aws-context',
  'terminal:input',
  'terminal:run-command'
])

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
    const identity = await getCallerIdentity(connection)
    const accountId = identity.account ?? ''
    if (accountId) {
      accountIdCache.set(cacheKey, accountId)
    }
    return accountId
  } catch {
    return ''
  }
}

async function summarizeConnection(connection?: AwsConnection | null): Promise<Pick<EnterpriseAuditEvent, 'actorLabel' | 'accountId' | 'region'>> {
  if (!connection) {
    return {
      actorLabel: 'local-app',
      accountId: '',
      region: ''
    }
  }

  if (connection.kind === 'assumed-role') {
    return {
      actorLabel: `${connection.label} (${connection.sourceProfile})`,
      accountId: await resolveAccountId(connection),
      region: connection.region
    }
  }

  return {
    actorLabel: connection.profile,
    accountId: await resolveAccountId(connection),
    region: connection.region
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

function isOperatorAction(channel: string, args: unknown[]): boolean {
  if (ALWAYS_OPERATOR_CHANNELS.has(channel)) {
    return true
  }

  if (channel === 'terraform:command:run') {
    const request = args[0] as TerraformCommandRequest | undefined
    return Boolean(request && ['apply', 'destroy', 'import', 'state-mv', 'state-rm', 'force-unlock'].includes(request.command))
  }

  return false
}

function inferServiceId(channel: string): ServiceId | '' {
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

function appendAuditEvent(event: EnterpriseAuditEvent): void {
  const current = readAuditLog()
  const next = [event, ...current].slice(0, 500)
  writeAuditLog(next)
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
    throw new Error('AWS Lens is in read-only mode. Switch to operator mode to run mutating or command execution actions.')
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

  const connection = findConnection(args)
  const summary = await summarizeConnection(connection)
  const resource = summarizeResource(channel, args)
  const details = [...resource.details]

  if (errorMessage) {
    details.push(`error:${errorMessage}`)
  }

  appendAuditEvent({
    id: randomUUID(),
    happenedAt: new Date().toISOString(),
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
  const defaultFileName = `aws-lens-audit-${rangeDays}d-${new Date().toISOString().slice(0, 10)}.json`
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
