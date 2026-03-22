import {
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  type IpPermission
} from '@aws-sdk/client-ec2'

import { awsClientConfig, readTags } from './client'
import type {
  AwsConnection,
  SecurityGroupDetail,
  SecurityGroupRule,
  SecurityGroupRuleInput,
  SecurityGroupSummary
} from '@shared/types'

function createClient(connection: AwsConnection): EC2Client {
  return new EC2Client(awsClientConfig(connection))
}

/* ── helpers ───────────────────────────────────────────────── */

function formatPort(from?: number, to?: number): string {
  if (from === undefined && to === undefined) return 'All'
  if (from === -1 || to === -1) return 'All'
  if (from === to) return String(from)
  return `${from}-${to}`
}

function extractSources(rule: IpPermission): string[] {
  const sources: string[] = []
  for (const range of rule.IpRanges ?? []) {
    if (range.CidrIp) sources.push(range.CidrIp)
  }
  for (const range of rule.Ipv6Ranges ?? []) {
    if (range.CidrIpv6) sources.push(range.CidrIpv6)
  }
  for (const pair of rule.UserIdGroupPairs ?? []) {
    if (pair.GroupId) sources.push(pair.GroupId)
  }
  for (const prefix of rule.PrefixListIds ?? []) {
    if (prefix.PrefixListId) sources.push(prefix.PrefixListId)
  }
  return sources.length ? sources : ['-']
}

function toRule(perm: IpPermission): SecurityGroupRule {
  return {
    protocol: perm.IpProtocol === '-1' ? 'All' : (perm.IpProtocol ?? '-'),
    fromPort: perm.FromPort ?? -1,
    toPort: perm.ToPort ?? -1,
    portRange: formatPort(perm.FromPort, perm.ToPort),
    sources: extractSources(perm),
    description:
      perm.IpRanges?.[0]?.Description ??
      perm.Ipv6Ranges?.[0]?.Description ??
      perm.UserIdGroupPairs?.[0]?.Description ??
      ''
  }
}

function buildIpPermission(rule: SecurityGroupRuleInput): IpPermission {
  const perm: IpPermission = {
    IpProtocol: rule.protocol === 'All' ? '-1' : rule.protocol,
    FromPort: rule.protocol === 'All' || rule.protocol === '-1' ? -1 : rule.fromPort,
    ToPort: rule.protocol === 'All' || rule.protocol === '-1' ? -1 : rule.toPort
  }

  if (rule.sourceGroupId) {
    perm.UserIdGroupPairs = [{ GroupId: rule.sourceGroupId, Description: rule.description || undefined }]
  } else {
    perm.IpRanges = [{ CidrIp: rule.cidrIp || '0.0.0.0/0', Description: rule.description || undefined }]
  }

  return perm
}

/* ── list security groups ──────────────────────────────────── */

export async function listSecurityGroups(
  connection: AwsConnection,
  vpcId?: string
): Promise<SecurityGroupSummary[]> {
  const client = createClient(connection)
  const groups: SecurityGroupSummary[] = []
  let nextToken: string | undefined
  const filters = vpcId ? [{ Name: 'vpc-id', Values: [vpcId] }] : undefined

  do {
    const output = await client.send(new DescribeSecurityGroupsCommand({ Filters: filters, NextToken: nextToken }))
    for (const sg of output.SecurityGroups ?? []) {
      const tags = readTags(sg.Tags)
      groups.push({
        groupId: sg.GroupId ?? '-',
        groupName: sg.GroupName ?? '-',
        vpcId: sg.VpcId ?? '-',
        description: sg.Description ?? '-',
        inboundRuleCount: sg.IpPermissions?.length ?? 0,
        outboundRuleCount: sg.IpPermissionsEgress?.length ?? 0,
        inboundRules: (sg.IpPermissions ?? []).map((rule) => ({
          protocol: rule.IpProtocol === '-1' ? 'All' : (rule.IpProtocol ?? '-'),
          portRange: formatPort(rule.FromPort, rule.ToPort),
          source:
            rule.IpRanges?.[0]?.CidrIp ??
            rule.UserIdGroupPairs?.[0]?.GroupId ??
            rule.PrefixListIds?.[0]?.PrefixListId ??
            '-',
          description: rule.IpRanges?.[0]?.Description ?? ''
        })),
        outboundRules: (sg.IpPermissionsEgress ?? []).map((rule) => ({
          protocol: rule.IpProtocol === '-1' ? 'All' : (rule.IpProtocol ?? '-'),
          portRange: formatPort(rule.FromPort, rule.ToPort),
          destination:
            rule.IpRanges?.[0]?.CidrIp ??
            rule.UserIdGroupPairs?.[0]?.GroupId ??
            '-',
          description: rule.IpRanges?.[0]?.Description ?? ''
        })),
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return groups
}

/* ── describe single group ─────────────────────────────────── */

export async function describeSecurityGroup(
  connection: AwsConnection,
  groupId: string
): Promise<SecurityGroupDetail | null> {
  const client = createClient(connection)
  const output = await client.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }))
  const sg = output.SecurityGroups?.[0]
  if (!sg) return null

  const tags = readTags(sg.Tags)
  return {
    groupId: sg.GroupId ?? '-',
    groupName: sg.GroupName ?? '-',
    vpcId: sg.VpcId ?? '-',
    description: sg.Description ?? '-',
    ownerId: sg.OwnerId ?? '-',
    tags,
    inboundRules: (sg.IpPermissions ?? []).map(toRule),
    outboundRules: (sg.IpPermissionsEgress ?? []).map(toRule)
  }
}

/* ── inbound rule mutations ────────────────────────────────── */

export async function addInboundRule(
  connection: AwsConnection,
  groupId: string,
  rule: SecurityGroupRuleInput
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [buildIpPermission(rule)]
    })
  )
}

export async function revokeInboundRule(
  connection: AwsConnection,
  groupId: string,
  rule: SecurityGroupRuleInput
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new RevokeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [buildIpPermission(rule)]
    })
  )
}

/* ── outbound rule mutations ───────────────────────────────── */

export async function addOutboundRule(
  connection: AwsConnection,
  groupId: string,
  rule: SecurityGroupRuleInput
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new AuthorizeSecurityGroupEgressCommand({
      GroupId: groupId,
      IpPermissions: [buildIpPermission(rule)]
    })
  )
}

export async function revokeOutboundRule(
  connection: AwsConnection,
  groupId: string,
  rule: SecurityGroupRuleInput
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new RevokeSecurityGroupEgressCommand({
      GroupId: groupId,
      IpPermissions: [buildIpPermission(rule)]
    })
  )
}
