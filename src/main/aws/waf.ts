import {
  AssociateWebACLCommand,
  CreateWebACLCommand,
  DeleteWebACLCommand,
  DisassociateWebACLCommand,
  GetWebACLCommand,
  ListResourcesForWebACLCommand,
  ListWebACLsCommand,
  UpdateWebACLCommand,
  WAFV2Client
} from '@aws-sdk/client-wafv2'

import type {
  AwsConnection,
  WafCreateWebAclInput,
  WafRuleInput,
  WafScope,
  WafWebAclDetail,
  WafWebAclSummary
} from '@shared/types'
import { getAwsClient } from './client'

function defaultVisibilityConfig(metricName: string) {
  return {
    CloudWatchMetricsEnabled: true,
    MetricName: metricName,
    SampledRequestsEnabled: true
  }
}

function parseActionName(rule: any): string {
  if (rule.Action?.Allow) return 'Allow'
  if (rule.Action?.Block) return 'Block'
  if (rule.Action?.Count) return 'Count'
  if (rule.OverrideAction?.None) return 'None'
  return 'Unknown'
}

function parseStatementType(rule: any): string {
  const statement = rule.Statement ?? {}
  return Object.keys(statement)[0] ?? 'Unknown'
}

async function getAssociations(client: WAFV2Client, scope: WafScope, webAclArn: string): Promise<{ resourceArn: string }[]> {
  const response = await client.send(new ListResourcesForWebACLCommand({ WebACLArn: webAclArn, ResourceType: scope === 'REGIONAL' ? 'APPLICATION_LOAD_BALANCER' : undefined as never })).catch(() => ({ ResourceArns: [] }))
  return ((response as { ResourceArns?: string[] }).ResourceArns ?? []).map((resourceArn) => ({ resourceArn }))
}

export async function listWebAcls(connection: AwsConnection, scope: WafScope): Promise<WafWebAclSummary[]> {
  const client = getAwsClient(WAFV2Client, connection)
  const response = await client.send(new ListWebACLsCommand({ Scope: scope, Limit: 100 }))

  return (response.WebACLs ?? []).map((acl) => ({
    id: acl.Id ?? '',
    name: acl.Name ?? '',
    arn: acl.ARN ?? '',
    description: acl.Description ?? '',
    scope,
    capacity: 0,
    lockToken: ''
  }))
}

export async function describeWebAcl(connection: AwsConnection, scope: WafScope, id: string, name: string): Promise<WafWebAclDetail> {
  const client = getAwsClient(WAFV2Client, connection)
  const response = await client.send(new GetWebACLCommand({ Scope: scope, Id: id, Name: name }))
  const acl = response.WebACL

  if (!acl) {
    throw new Error('Web ACL not found.')
  }

  return {
    id: acl.Id ?? id,
    name: acl.Name ?? name,
    arn: acl.ARN ?? '',
    description: acl.Description ?? '',
    scope,
    capacity: acl.Capacity ?? 0,
    defaultAction: acl.DefaultAction?.Allow ? 'Allow' : 'Block',
    lockToken: response.LockToken ?? '',
    tokenDomains: acl.TokenDomains ?? [],
    rules: (acl.Rules ?? []).map((rule: any) => ({
      name: rule.Name ?? '',
      priority: rule.Priority ?? 0,
      action: parseActionName(rule),
      statementType: parseStatementType(rule),
      metricName: rule.VisibilityConfig?.MetricName ?? ''
    })),
    associations: await getAssociations(client, scope, acl.ARN ?? ''),
    rawRulesJson: JSON.stringify(acl.Rules ?? [], null, 2)
  }
}

export async function createWebAcl(connection: AwsConnection, input: WafCreateWebAclInput): Promise<string> {
  const client = getAwsClient(WAFV2Client, connection)
  const response = await client.send(
    new CreateWebACLCommand({
      Name: input.name,
      Description: input.description || undefined,
      Scope: input.scope,
      DefaultAction: input.defaultAction === 'Allow' ? { Allow: {} } : { Block: {} },
      VisibilityConfig: defaultVisibilityConfig(`${input.name}-default`),
      Rules: []
    })
  )

  return response.Summary?.ARN ?? ''
}

export async function deleteWebAcl(connection: AwsConnection, scope: WafScope, id: string, name: string, lockToken: string): Promise<void> {
  const client = getAwsClient(WAFV2Client, connection)
  await client.send(new DeleteWebACLCommand({ Scope: scope, Id: id, Name: name, LockToken: lockToken }))
}

export async function addWafRule(connection: AwsConnection, scope: WafScope, id: string, name: string, lockToken: string, input: WafRuleInput): Promise<void> {
  const detail = await describeWebAcl(connection, scope, id, name)
  const rules = JSON.parse(detail.rawRulesJson || '[]')

  rules.push({
    Name: input.name,
    Priority: input.priority,
    Action: input.action === 'Allow' ? { Allow: {} } : input.action === 'Block' ? { Block: {} } : { Count: {} },
    Statement: input.ipSetArn
      ? { IPSetReferenceStatement: { ARN: input.ipSetArn } }
      : { RateBasedStatement: { Limit: input.rateLimit, AggregateKeyType: 'IP' } },
    VisibilityConfig: defaultVisibilityConfig(input.metricName || input.name.replace(/\s+/g, '-'))
  })

  await updateWebAclRules(connection, scope, id, name, lockToken, detail.defaultAction as 'Allow' | 'Block', detail.description, rules)
}

export async function updateWafRuleJson(
  connection: AwsConnection,
  scope: WafScope,
  id: string,
  name: string,
  lockToken: string,
  defaultAction: 'Allow' | 'Block',
  description: string,
  rulesJson: string
): Promise<void> {
  const rules = JSON.parse(rulesJson)
  await updateWebAclRules(connection, scope, id, name, lockToken, defaultAction, description, rules)
}

export async function deleteWafRule(connection: AwsConnection, scope: WafScope, id: string, name: string, lockToken: string, ruleName: string): Promise<void> {
  const detail = await describeWebAcl(connection, scope, id, name)
  const rules = JSON.parse(detail.rawRulesJson || '[]').filter((rule: any) => rule.Name !== ruleName)
  await updateWebAclRules(connection, scope, id, name, lockToken, detail.defaultAction as 'Allow' | 'Block', detail.description, rules)
}

async function updateWebAclRules(
  connection: AwsConnection,
  scope: WafScope,
  id: string,
  name: string,
  lockToken: string,
  defaultAction: 'Allow' | 'Block',
  description: string,
  rules: any[]
): Promise<void> {
  const client = getAwsClient(WAFV2Client, connection)
  await client.send(
    new UpdateWebACLCommand({
      Scope: scope,
      Id: id,
      Name: name,
      LockToken: lockToken,
      Description: description || undefined,
      DefaultAction: defaultAction === 'Allow' ? { Allow: {} } : { Block: {} },
      VisibilityConfig: defaultVisibilityConfig(`${name}-default`),
      Rules: rules
    })
  )
}

export async function associateWebAcl(connection: AwsConnection, resourceArn: string, webAclArn: string): Promise<void> {
  const client = getAwsClient(WAFV2Client, connection)
  await client.send(new AssociateWebACLCommand({ ResourceArn: resourceArn, WebACLArn: webAclArn }))
}

export async function disassociateWebAcl(connection: AwsConnection, resourceArn: string): Promise<void> {
  const client = getAwsClient(WAFV2Client, connection)
  await client.send(new DisassociateWebACLCommand({ ResourceArn: resourceArn }))
}
