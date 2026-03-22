import {
  AddUserToGroupCommand,
  AttachGroupPolicyCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreateGroupCommand,
  CreateLoginProfileCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateRoleCommand,
  CreateUserCommand,
  DeactivateMFADeviceCommand,
  DeleteAccessKeyCommand,
  DeleteGroupCommand,
  DeleteLoginProfileCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  DeleteVirtualMFADeviceCommand,
  DetachGroupPolicyCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  GenerateCredentialReportCommand,
  GetAccountSummaryCommand,
  GetCredentialReportCommand,
  GetGroupCommand,
  GetLoginProfileCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  GetUserPolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListAttachedGroupPoliciesCommand,
  ListAttachedRolePoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupPoliciesCommand,
  ListGroupsCommand,
  ListGroupsForUserCommand,
  ListMFADevicesCommand,
  ListPoliciesCommand,
  ListPolicyVersionsCommand,
  ListRolePoliciesCommand,
  ListRolesCommand,
  ListUserPoliciesCommand,
  ListUsersCommand,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
  RemoveUserFromGroupCommand,
  SimulatePrincipalPolicyCommand,
  UpdateAccessKeyCommand,
  UpdateAssumeRolePolicyCommand
} from '@aws-sdk/client-iam'

import { awsClientConfig } from './client'
import type {
  AwsConnection,
  IamAccessKeySummary,
  IamAccountSummary,
  IamAttachedPolicy,
  IamCredentialReportEntry,
  IamGroupSummary,
  IamInlinePolicy,
  IamMfaDevice,
  IamPolicySummary,
  IamPolicyVersion,
  IamRoleSummary,
  IamSimulationResult,
  IamUserSummary
} from '@shared/types'

function createClient(connection: AwsConnection): IAMClient {
  return new IAMClient(awsClientConfig(connection))
}

/* ── Users ────────────────────────────────────────────────── */

export async function listIamUsers(connection: AwsConnection): Promise<IamUserSummary[]> {
  const client = createClient(connection)
  const users: IamUserSummary[] = []
  let marker: string | undefined

  do {
    const output = await client.send(new ListUsersCommand({ Marker: marker }))
    for (const u of output.Users ?? []) {
      const userName = u.UserName ?? ''

      const [mfaRes, keysRes, groupsRes, hasConsole] = await Promise.all([
        client.send(new ListMFADevicesCommand({ UserName: userName })),
        client.send(new ListAccessKeysCommand({ UserName: userName })),
        client.send(new ListGroupsForUserCommand({ UserName: userName })),
        client
          .send(new GetLoginProfileCommand({ UserName: userName }))
          .then(() => true)
          .catch(() => false)
      ])

      users.push({
        userName,
        userId: u.UserId ?? '',
        arn: u.Arn ?? '',
        path: u.Path ?? '/',
        createDate: u.CreateDate?.toISOString() ?? '',
        passwordLastUsed: u.PasswordLastUsed?.toISOString() ?? '',
        hasMfa: (mfaRes.MFADevices ?? []).length > 0,
        accessKeyCount: (keysRes.AccessKeyMetadata ?? []).length,
        groupCount: (groupsRes.Groups ?? []).length,
        hasConsoleAccess: hasConsole
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return users
}

/* ── Groups ───────────────────────────────────────────────── */

export async function listIamGroups(connection: AwsConnection): Promise<IamGroupSummary[]> {
  const client = createClient(connection)
  const groups: IamGroupSummary[] = []
  let marker: string | undefined

  do {
    const output = await client.send(new ListGroupsCommand({ Marker: marker }))
    for (const g of output.Groups ?? []) {
      const groupName = g.GroupName ?? ''

      const [groupDetail, attachedRes, inlineRes] = await Promise.all([
        client.send(new GetGroupCommand({ GroupName: groupName })),
        client.send(new ListAttachedGroupPoliciesCommand({ GroupName: groupName })),
        client.send(new ListGroupPoliciesCommand({ GroupName: groupName }))
      ])

      groups.push({
        groupName,
        groupId: g.GroupId ?? '',
        arn: g.Arn ?? '',
        path: g.Path ?? '/',
        createDate: g.CreateDate?.toISOString() ?? '',
        memberCount: (groupDetail.Users ?? []).length,
        policyCount:
          (attachedRes.AttachedPolicies ?? []).length + (inlineRes.PolicyNames ?? []).length
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return groups
}

/* ── Roles ────────────────────────────────────────────────── */

export async function listIamRoles(connection: AwsConnection): Promise<IamRoleSummary[]> {
  const client = createClient(connection)
  const roles: IamRoleSummary[] = []
  let marker: string | undefined

  do {
    const output = await client.send(new ListRolesCommand({ Marker: marker }))
    for (const r of output.Roles ?? []) {
      const roleName = r.RoleName ?? ''

      const attachedRes = await client.send(
        new ListAttachedRolePoliciesCommand({ RoleName: roleName })
      )

      roles.push({
        roleName,
        roleId: r.RoleId ?? '',
        arn: r.Arn ?? '',
        path: r.Path ?? '/',
        createDate: r.CreateDate?.toISOString() ?? '',
        maxSessionDuration: r.MaxSessionDuration ?? 3600,
        description: r.Description ?? '',
        attachedPolicyCount: (attachedRes.AttachedPolicies ?? []).length
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return roles
}

/* ── Policies ─────────────────────────────────────────────── */

export async function listIamPolicies(
  connection: AwsConnection,
  scope: string
): Promise<IamPolicySummary[]> {
  const client = createClient(connection)
  const policies: IamPolicySummary[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new ListPoliciesCommand({ Scope: scope as 'All' | 'AWS' | 'Local', Marker: marker })
    )
    for (const p of output.Policies ?? []) {
      policies.push({
        policyName: p.PolicyName ?? '',
        policyId: p.PolicyId ?? '',
        arn: p.Arn ?? '',
        path: p.Path ?? '/',
        createDate: p.CreateDate?.toISOString() ?? '',
        updateDate: p.UpdateDate?.toISOString() ?? '',
        attachmentCount: p.AttachmentCount ?? 0,
        defaultVersionId: p.DefaultVersionId ?? '',
        isAwsManaged: p.Arn?.startsWith('arn:aws:iam::aws:') ?? false,
        description: p.Description ?? ''
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return policies
}

/* ── Account summary ──────────────────────────────────────── */

export async function getAccountSummary(connection: AwsConnection): Promise<IamAccountSummary> {
  const client = createClient(connection)
  const output = await client.send(new GetAccountSummaryCommand({}))
  return (output.SummaryMap as Record<string, number>) ?? {}
}

/* ── Access keys ──────────────────────────────────────────── */

export async function listUserAccessKeys(
  connection: AwsConnection,
  userName: string
): Promise<IamAccessKeySummary[]> {
  const client = createClient(connection)
  const output = await client.send(new ListAccessKeysCommand({ UserName: userName }))
  return (output.AccessKeyMetadata ?? []).map((k) => ({
    accessKeyId: k.AccessKeyId ?? '',
    status: k.Status ?? '',
    createDate: k.CreateDate?.toISOString() ?? '',
    userName: k.UserName ?? ''
  }))
}

export async function createAccessKey(
  connection: AwsConnection,
  userName: string
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const client = createClient(connection)
  const output = await client.send(new CreateAccessKeyCommand({ UserName: userName }))
  return {
    accessKeyId: output.AccessKey?.AccessKeyId ?? '',
    secretAccessKey: output.AccessKey?.SecretAccessKey ?? ''
  }
}

export async function deleteAccessKey(
  connection: AwsConnection,
  userName: string,
  accessKeyId: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }))
}

export async function updateAccessKeyStatus(
  connection: AwsConnection,
  userName: string,
  accessKeyId: string,
  status: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new UpdateAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId, Status: status as 'Active' | 'Inactive' })
  )
}

/* ── MFA devices ──────────────────────────────────────────── */

export async function listUserMfaDevices(
  connection: AwsConnection,
  userName: string
): Promise<IamMfaDevice[]> {
  const client = createClient(connection)
  const output = await client.send(new ListMFADevicesCommand({ UserName: userName }))
  return (output.MFADevices ?? []).map((d) => ({
    serialNumber: d.SerialNumber ?? '',
    enableDate: d.EnableDate?.toISOString() ?? '',
    userName: d.UserName ?? ''
  }))
}

export async function deleteUserMfaDevice(
  connection: AwsConnection,
  userName: string,
  serialNumber: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new DeactivateMFADeviceCommand({ UserName: userName, SerialNumber: serialNumber })
  )
  await client.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: serialNumber }))
}

/* ── User policies ────────────────────────────────────────── */

export async function listAttachedUserPolicies(
  connection: AwsConnection,
  userName: string
): Promise<IamAttachedPolicy[]> {
  const client = createClient(connection)
  const policies: IamAttachedPolicy[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new ListAttachedUserPoliciesCommand({ UserName: userName, Marker: marker })
    )
    for (const p of output.AttachedPolicies ?? []) {
      policies.push({
        policyName: p.PolicyName ?? '',
        policyArn: p.PolicyArn ?? ''
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return policies
}

export async function listUserInlinePolicies(
  connection: AwsConnection,
  userName: string
): Promise<IamInlinePolicy[]> {
  const client = createClient(connection)
  const names: string[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new ListUserPoliciesCommand({ UserName: userName, Marker: marker })
    )
    names.push(...(output.PolicyNames ?? []))
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  const policies: IamInlinePolicy[] = []
  for (const policyName of names) {
    const detail = await client.send(
      new GetUserPolicyCommand({ UserName: userName, PolicyName: policyName })
    )
    policies.push({
      policyName,
      policyDocument: decodeURIComponent(detail.PolicyDocument ?? '')
    })
  }

  return policies
}

export async function attachUserPolicy(
  connection: AwsConnection,
  userName: string,
  policyArn: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new AttachUserPolicyCommand({ UserName: userName, PolicyArn: policyArn }))
}

export async function detachUserPolicy(
  connection: AwsConnection,
  userName: string,
  policyArn: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DetachUserPolicyCommand({ UserName: userName, PolicyArn: policyArn }))
}

export async function putUserInlinePolicy(
  connection: AwsConnection,
  userName: string,
  policyName: string,
  policyDocument: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new PutUserPolicyCommand({
      UserName: userName,
      PolicyName: policyName,
      PolicyDocument: policyDocument
    })
  )
}

export async function deleteUserInlinePolicy(
  connection: AwsConnection,
  userName: string,
  policyName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: policyName }))
}

/* ── User groups ──────────────────────────────────────────── */

export async function listUserGroups(
  connection: AwsConnection,
  userName: string
): Promise<string[]> {
  const client = createClient(connection)
  const groups: string[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new ListGroupsForUserCommand({ UserName: userName, Marker: marker })
    )
    for (const g of output.Groups ?? []) {
      groups.push(g.GroupName ?? '')
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return groups
}

export async function addUserToGroup(
  connection: AwsConnection,
  userName: string,
  groupName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new AddUserToGroupCommand({ UserName: userName, GroupName: groupName }))
}

export async function removeUserFromGroup(
  connection: AwsConnection,
  userName: string,
  groupName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new RemoveUserFromGroupCommand({ UserName: userName, GroupName: groupName }))
}

/* ── User lifecycle ───────────────────────────────────────── */

export async function createUser(
  connection: AwsConnection,
  userName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new CreateUserCommand({ UserName: userName }))
}

export async function deleteUser(
  connection: AwsConnection,
  userName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteUserCommand({ UserName: userName }))
}

export async function createLoginProfile(
  connection: AwsConnection,
  userName: string,
  password: string,
  requireReset: boolean
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new CreateLoginProfileCommand({
      UserName: userName,
      Password: password,
      PasswordResetRequired: requireReset
    })
  )
}

export async function deleteLoginProfile(
  connection: AwsConnection,
  userName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteLoginProfileCommand({ UserName: userName }))
}

/* ── Role policies ────────────────────────────────────────── */

export async function listAttachedRolePolicies(
  connection: AwsConnection,
  roleName: string
): Promise<IamAttachedPolicy[]> {
  const client = createClient(connection)
  const policies: IamAttachedPolicy[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker })
    )
    for (const p of output.AttachedPolicies ?? []) {
      policies.push({
        policyName: p.PolicyName ?? '',
        policyArn: p.PolicyArn ?? ''
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return policies
}

export async function listRoleInlinePolicies(
  connection: AwsConnection,
  roleName: string
): Promise<IamInlinePolicy[]> {
  const client = createClient(connection)
  const names: string[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker })
    )
    names.push(...(output.PolicyNames ?? []))
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  const policies: IamInlinePolicy[] = []
  for (const policyName of names) {
    const detail = await client.send(
      new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName })
    )
    policies.push({
      policyName,
      policyDocument: decodeURIComponent(detail.PolicyDocument ?? '')
    })
  }

  return policies
}

export async function getRoleTrustPolicy(
  connection: AwsConnection,
  roleName: string
): Promise<string> {
  const client = createClient(connection)
  const output = await client.send(new GetRoleCommand({ RoleName: roleName }))
  return decodeURIComponent(output.Role?.AssumeRolePolicyDocument ?? '')
}

export async function updateRoleTrustPolicy(
  connection: AwsConnection,
  roleName: string,
  policyDocument: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: policyDocument })
  )
}

export async function attachRolePolicy(
  connection: AwsConnection,
  roleName: string,
  policyArn: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }))
}

export async function detachRolePolicy(
  connection: AwsConnection,
  roleName: string,
  policyArn: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }))
}

export async function putRoleInlinePolicy(
  connection: AwsConnection,
  roleName: string,
  policyName: string,
  policyDocument: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: policyDocument
    })
  )
}

export async function deleteRoleInlinePolicy(
  connection: AwsConnection,
  roleName: string,
  policyName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
}

/* ── Role lifecycle ───────────────────────────────────────── */

export async function createRole(
  connection: AwsConnection,
  roleName: string,
  trustPolicy: string,
  description: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: trustPolicy,
      Description: description
    })
  )
}

export async function deleteRole(
  connection: AwsConnection,
  roleName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteRoleCommand({ RoleName: roleName }))
}

/* ── Group policies ───────────────────────────────────────── */

export async function listAttachedGroupPolicies(
  connection: AwsConnection,
  groupName: string
): Promise<IamAttachedPolicy[]> {
  const client = createClient(connection)
  const policies: IamAttachedPolicy[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new ListAttachedGroupPoliciesCommand({ GroupName: groupName, Marker: marker })
    )
    for (const p of output.AttachedPolicies ?? []) {
      policies.push({
        policyName: p.PolicyName ?? '',
        policyArn: p.PolicyArn ?? ''
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return policies
}

export async function attachGroupPolicy(
  connection: AwsConnection,
  groupName: string,
  policyArn: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new AttachGroupPolicyCommand({ GroupName: groupName, PolicyArn: policyArn })
  )
}

export async function detachGroupPolicy(
  connection: AwsConnection,
  groupName: string,
  policyArn: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new DetachGroupPolicyCommand({ GroupName: groupName, PolicyArn: policyArn })
  )
}

/* ── Group lifecycle ──────────────────────────────────────── */

export async function createGroup(
  connection: AwsConnection,
  groupName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new CreateGroupCommand({ GroupName: groupName }))
}

export async function deleteGroup(
  connection: AwsConnection,
  groupName: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteGroupCommand({ GroupName: groupName }))
}

/* ── Policy versions ──────────────────────────────────────── */

export async function getPolicyVersion(
  connection: AwsConnection,
  policyArn: string,
  versionId: string
): Promise<IamPolicyVersion> {
  const client = createClient(connection)
  const output = await client.send(
    new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: versionId })
  )
  const v = output.PolicyVersion
  return {
    versionId: v?.VersionId ?? '',
    isDefaultVersion: v?.IsDefaultVersion ?? false,
    createDate: v?.CreateDate?.toISOString() ?? '',
    document: decodeURIComponent(v?.Document ?? '')
  }
}

export async function listPolicyVersions(
  connection: AwsConnection,
  policyArn: string
): Promise<IamPolicyVersion[]> {
  const client = createClient(connection)
  const output = await client.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }))
  return (output.Versions ?? []).map((v) => ({
    versionId: v.VersionId ?? '',
    isDefaultVersion: v.IsDefaultVersion ?? false,
    createDate: v.CreateDate?.toISOString() ?? '',
    document: ''
  }))
}

export async function createPolicyVersion(
  connection: AwsConnection,
  policyArn: string,
  document: string,
  setAsDefault: boolean
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new CreatePolicyVersionCommand({
      PolicyArn: policyArn,
      PolicyDocument: document,
      SetAsDefault: setAsDefault
    })
  )
}

export async function deletePolicyVersion(
  connection: AwsConnection,
  policyArn: string,
  versionId: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: versionId })
  )
}

/* ── Policy lifecycle ─────────────────────────────────────── */

export async function createPolicy(
  connection: AwsConnection,
  policyName: string,
  document: string,
  description: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new CreatePolicyCommand({
      PolicyName: policyName,
      PolicyDocument: document,
      Description: description
    })
  )
}

export async function deletePolicy(
  connection: AwsConnection,
  policyArn: string
): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeletePolicyCommand({ PolicyArn: policyArn }))
}

/* ── Policy simulator ─────────────────────────────────────── */

export async function simulatePolicy(
  connection: AwsConnection,
  policyArn: string,
  actions: string[],
  resourceArns: string[]
): Promise<IamSimulationResult[]> {
  const client = createClient(connection)
  const results: IamSimulationResult[] = []
  let marker: string | undefined

  do {
    const output = await client.send(
      new SimulatePrincipalPolicyCommand({
        PolicySourceArn: policyArn,
        ActionNames: actions,
        ResourceArns: resourceArns,
        Marker: marker
      })
    )
    for (const r of output.EvaluationResults ?? []) {
      results.push({
        actionName: r.EvalActionName ?? '',
        resourceArn: r.EvalResourceName ?? '',
        decision: r.EvalDecision ?? '',
        matchedStatements: (r.MatchedStatements ?? []).map((s) => ({
          sourcePolicyId: s.SourcePolicyId ?? '',
          sourcePolicyType: s.SourcePolicyType ?? ''
        }))
      })
    }
    marker = output.IsTruncated ? output.Marker : undefined
  } while (marker)

  return results
}

/* ── Credential report ────────────────────────────────────── */

export async function generateCredentialReport(connection: AwsConnection): Promise<void> {
  const client = createClient(connection)
  await client.send(new GenerateCredentialReportCommand({}))
}

export async function getCredentialReport(
  connection: AwsConnection
): Promise<IamCredentialReportEntry[]> {
  const client = createClient(connection)
  const output = await client.send(new GetCredentialReportCommand({}))

  const csv = output.Content ? new TextDecoder().decode(output.Content) : ''
  const lines = csv.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const headers = lines[0].split(',')
  const entries: IamCredentialReportEntry[] = []

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',')
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? ''
    }

    entries.push({
      user: row['user'] ?? '',
      arn: row['arn'] ?? '',
      userCreationTime: row['user_creation_time'] ?? '',
      passwordEnabled: row['password_enabled'] ?? '',
      passwordLastUsed: row['password_last_used'] ?? '',
      passwordLastChanged: row['password_last_changed'] ?? '',
      passwordNextRotation: row['password_next_rotation'] ?? '',
      mfaActive: row['mfa_active'] ?? '',
      accessKey1Active: row['access_key_1_active'] ?? '',
      accessKey1LastRotated: row['access_key_1_last_rotated'] ?? '',
      accessKey1LastUsedDate: row['access_key_1_last_used_date'] ?? '',
      accessKey1LastUsedRegion: row['access_key_1_last_used_region'] ?? '',
      accessKey1LastUsedService: row['access_key_1_last_used_service'] ?? '',
      accessKey2Active: row['access_key_2_active'] ?? '',
      accessKey2LastRotated: row['access_key_2_last_rotated'] ?? '',
      accessKey2LastUsedDate: row['access_key_2_last_used_date'] ?? '',
      accessKey2LastUsedRegion: row['access_key_2_last_used_region'] ?? '',
      accessKey2LastUsedService: row['access_key_2_last_used_service'] ?? ''
    })
  }

  return entries
}
