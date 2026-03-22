import type {
  AwsConnection,
  SecurityGroupDetail,
  SecurityGroupRuleInput,
  SecurityGroupSummary
} from '@shared/types'

type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string }

function bridge() {
  if (!window.awsLens) throw new Error('AWS preload bridge did not load.')
  return window.awsLens
}

function unwrap<T>(result: Wrapped<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export async function listSecurityGroups(c: AwsConnection, vpcId?: string): Promise<SecurityGroupSummary[]> {
  return unwrap((await bridge().listSecurityGroups(c, vpcId)) as Wrapped<SecurityGroupSummary[]>)
}

export async function describeSecurityGroup(c: AwsConnection, groupId: string): Promise<SecurityGroupDetail | null> {
  return unwrap((await bridge().describeSecurityGroup(c, groupId)) as Wrapped<SecurityGroupDetail | null>)
}

export async function addInboundRule(c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput): Promise<void> {
  return unwrap((await bridge().addInboundRule(c, groupId, rule)) as Wrapped<void>)
}

export async function revokeInboundRule(c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput): Promise<void> {
  return unwrap((await bridge().revokeInboundRule(c, groupId, rule)) as Wrapped<void>)
}

export async function addOutboundRule(c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput): Promise<void> {
  return unwrap((await bridge().addOutboundRule(c, groupId, rule)) as Wrapped<void>)
}

export async function revokeOutboundRule(c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput): Promise<void> {
  return unwrap((await bridge().revokeOutboundRule(c, groupId, rule)) as Wrapped<void>)
}
