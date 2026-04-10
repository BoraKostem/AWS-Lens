import {
  CreateInstanceCommand,
  DeleteInstanceCommand,
  DescribePermissionSetCommand,
  GetInlinePolicyForPermissionSetCommand,
  ListAccountAssignmentsCommand,
  ListCustomerManagedPolicyReferencesInPermissionSetCommand,
  ListInstancesCommand,
  ListManagedPoliciesInPermissionSetCommand,
  ListPermissionSetsCommand,
  SSOAdminClient
} from '@aws-sdk/client-sso-admin'
import {
  IdentitystoreClient,
  ListGroupsCommand,
  ListUsersCommand
} from '@aws-sdk/client-identitystore'

import type {
  AwsConnection,
  SsoAccountAssignment,
  SsoGroupSummary,
  SsoInstanceSummary,
  SsoPermissionSetSummary,
  SsoSimulationResult,
  SsoUserSummary
} from '@shared/types'
import { getAwsClient } from './client'

/* ── Instances ────────────────────────────────────────────── */

export async function listInstances(connection: AwsConnection): Promise<SsoInstanceSummary[]> {
  const client = getAwsClient(SSOAdminClient, connection)
  const output = await client.send(new ListInstancesCommand({}))
  return (output.Instances ?? []).map((i) => ({
    instanceArn: i.InstanceArn ?? '-',
    identityStoreId: i.IdentityStoreId ?? '-',
    name: i.Name ?? '-',
    status: i.Status ?? '-',
    ownerAccountId: i.OwnerAccountId ?? '-',
    createdDate: i.CreatedDate?.toISOString() ?? '-'
  }))
}

export async function createInstance(connection: AwsConnection, name: string): Promise<string> {
  const client = getAwsClient(SSOAdminClient, connection)
  const output = await client.send(new CreateInstanceCommand({ Name: name }))
  return output.InstanceArn ?? ''
}

export async function deleteInstance(connection: AwsConnection, instanceArn: string): Promise<void> {
  const client = getAwsClient(SSOAdminClient, connection)
  await client.send(new DeleteInstanceCommand({ InstanceArn: instanceArn }))
}

/* ── Permission Sets ──────────────────────────────────────── */

export async function listPermissionSets(
  connection: AwsConnection,
  instanceArn: string
): Promise<SsoPermissionSetSummary[]> {
  const client = getAwsClient(SSOAdminClient, connection)
  const arns: string[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListPermissionSetsCommand({ InstanceArn: instanceArn, NextToken: nextToken })
    )
    arns.push(...(output.PermissionSets ?? []))
    nextToken = output.NextToken
  } while (nextToken)

  const results: SsoPermissionSetSummary[] = []
  for (const arn of arns) {
    const detail = await client.send(
      new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn })
    )
    const ps = detail.PermissionSet
    if (ps) {
      results.push({
        permissionSetArn: ps.PermissionSetArn ?? '-',
        name: ps.Name ?? '-',
        description: ps.Description ?? '',
        sessionDuration: ps.SessionDuration ?? '-',
        relayState: ps.RelayState ?? '',
        createdDate: ps.CreatedDate?.toISOString() ?? '-'
      })
    }
  }
  return results
}

/* ── Users & Groups (Identity Store) ──────────────────────── */

export async function listUsers(
  connection: AwsConnection,
  identityStoreId: string
): Promise<SsoUserSummary[]> {
  const client = getAwsClient(IdentitystoreClient, connection)
  const results: SsoUserSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListUsersCommand({ IdentityStoreId: identityStoreId, NextToken: nextToken })
    )
    for (const u of output.Users ?? []) {
      const primaryEmail = u.Emails?.find((e) => e.Primary)?.Value ?? u.Emails?.[0]?.Value ?? ''
      results.push({
        userId: u.UserId ?? '-',
        userName: u.UserName ?? '-',
        displayName: u.DisplayName ?? '-',
        email: primaryEmail,
        identityStoreId
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return results
}

export async function listGroups(
  connection: AwsConnection,
  identityStoreId: string
): Promise<SsoGroupSummary[]> {
  const client = getAwsClient(IdentitystoreClient, connection)
  const results: SsoGroupSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListGroupsCommand({ IdentityStoreId: identityStoreId, NextToken: nextToken })
    )
    for (const g of output.Groups ?? []) {
      results.push({
        groupId: g.GroupId ?? '-',
        displayName: g.DisplayName ?? '-',
        description: g.Description ?? '',
        identityStoreId
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return results
}

/* ── Account Assignments ──────────────────────────────────── */

export async function listAccountAssignments(
  connection: AwsConnection,
  instanceArn: string,
  accountId: string,
  permissionSetArn: string
): Promise<SsoAccountAssignment[]> {
  const client = getAwsClient(SSOAdminClient, connection)
  const results: SsoAccountAssignment[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListAccountAssignmentsCommand({
        InstanceArn: instanceArn,
        AccountId: accountId,
        PermissionSetArn: permissionSetArn,
        NextToken: nextToken
      })
    )
    for (const a of output.AccountAssignments ?? []) {
      results.push({
        accountId: a.AccountId ?? '-',
        permissionSetArn: a.PermissionSetArn ?? '-',
        permissionSetName: '',
        principalType: a.PrincipalType ?? '-',
        principalId: a.PrincipalId ?? '-',
        principalName: ''
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return results
}

/* ── Permission Simulation ────────────────────────────────── */

export async function simulatePermissions(
  connection: AwsConnection,
  instanceArn: string,
  permissionSetArn: string
): Promise<SsoSimulationResult> {
  const client = getAwsClient(SSOAdminClient, connection)

  // Describe the permission set
  const describeOutput = await client.send(
    new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: permissionSetArn })
  )
  const psName = describeOutput.PermissionSet?.Name ?? '-'

  // Get managed policies
  const managedOutput = await client.send(
    new ListManagedPoliciesInPermissionSetCommand({
      InstanceArn: instanceArn,
      PermissionSetArn: permissionSetArn
    })
  )
  const managedPolicies = (managedOutput.AttachedManagedPolicies ?? []).map(
    (p) => p.Arn ?? p.Name ?? '-'
  )

  // Get inline policy
  const inlineOutput = await client.send(
    new GetInlinePolicyForPermissionSetCommand({
      InstanceArn: instanceArn,
      PermissionSetArn: permissionSetArn
    })
  )
  const inlinePolicy = inlineOutput.InlinePolicy ?? ''

  // Get customer managed policies
  const customerOutput = await client.send(
    new ListCustomerManagedPolicyReferencesInPermissionSetCommand({
      InstanceArn: instanceArn,
      PermissionSetArn: permissionSetArn
    })
  )
  const customerManagedPolicies = (customerOutput.CustomerManagedPolicyReferences ?? []).map(
    (p) => `${p.Path ?? '/'}${p.Name ?? '-'}`
  )

  return {
    permissionSetName: psName,
    principalName: '',
    managedPolicies,
    inlinePolicy,
    customerManagedPolicies
  }
}
