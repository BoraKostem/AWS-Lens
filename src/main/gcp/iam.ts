/**
 * GCP IAM Console Feature Parity — extends the existing IAM surface in gcpSdk.ts
 * with service-account–level IAM policies, custom role updates, workload identity,
 * IAM audit log entries, and cross-project credential reports.
 *
 * Depends on: gcp/client.ts (requestGcp, paginationGuard, classifyGcpError)
 */

import { classifyGcpError, paginationGuard, requestGcp } from './client'
import type {
  GcpIamRoleSummary,
  GcpServiceAccountDetail,
  GcpServiceAccountIamBinding,
  GcpServiceAccountKeyReport,
  GcpServiceAccountKeyReportEntry,
  GcpIamAuditEntry,
  GcpWorkloadIdentityPoolSummary,
  GcpWorkloadIdentityProviderSummary,
  GcpIamRecommendation,
  GcpIamPolicyAnalysisResult,
  GcpIamPolicyAnalysisAccessEntry
} from '@shared/types'

// ── Helpers ─────────────────────────────────────────────────────────────────────

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true'
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const IAM_API = 'iam.googleapis.com'
const CRM_API = 'cloudresourcemanager.googleapis.com'
const AUDIT_API = 'logging.googleapis.com'
const RECOMMENDER_API = 'recommender.googleapis.com'
const POLICY_ANALYZER_API = 'cloudasset.googleapis.com'

// ── Service Account Detail ──────────────────────────────────────────────────────

/**
 * Fetches full detail for a single service account, including the SA-level IAM
 * policy (who can impersonate / manage the SA) and key age summary.
 *
 * Requires: iam.serviceAccounts.get, iam.serviceAccounts.getIamPolicy,
 *           iam.serviceAccountKeys.list
 */
export async function getGcpServiceAccountDetail(
  projectId: string,
  email: string
): Promise<GcpServiceAccountDetail> {
  const pid = projectId.trim()
  const saResource = `projects/${encodeURIComponent(pid)}/serviceAccounts/${encodeURIComponent(email)}`

  try {
    const [account, iamPolicy, keys] = await Promise.all([
      requestGcp<Record<string, unknown>>(pid, {
        url: `https://iam.googleapis.com/v1/${saResource}`
      }),
      requestGcp<Record<string, unknown>>(pid, {
        url: `https://iam.googleapis.com/v1/${saResource}:getIamPolicy`,
        method: 'POST',
        data: { options: { requestedPolicyVersion: 3 } }
      }).catch(() => ({ bindings: [] })),
      requestGcp<{ keys?: Array<Record<string, unknown>> }>(pid, {
        url: `https://iam.googleapis.com/v1/${saResource}/keys?keyTypes=USER_MANAGED`
      }).catch(() => ({ keys: [] }))
    ])

    const iamBindings = buildSaIamBindings(iamPolicy)
    const keyEntries = (keys.keys ?? []).map(parseKeyRecord)
    const now = Date.now()

    return {
      email: asString(account.email) || email,
      displayName: asString(account.displayName),
      uniqueId: asString(account.uniqueId),
      description: asString(account.description),
      disabled: asBoolean(account.disabled),
      oauth2ClientId: asString(account.oauth2ClientId),
      projectId: asString(account.projectId) || pid,
      iamBindings,
      keys: keyEntries,
      keyCount: keyEntries.length,
      oldestKeyAgeDays: keyEntries.length > 0
        ? Math.max(...keyEntries.map((k) => k.validAfterTime ? Math.floor((now - new Date(k.validAfterTime).getTime()) / 86_400_000) : 0))
        : 0
    }
  } catch (error) {
    throw classifyGcpError(`loading detail for service account "${email}"`, error, IAM_API)
  }
}

function buildSaIamBindings(policy: Record<string, unknown>): GcpServiceAccountIamBinding[] {
  const rawBindings = Array.isArray(policy.bindings) ? policy.bindings as Array<Record<string, unknown>> : []
  return rawBindings.map((binding) => {
    const role = asString(binding.role)
    const members = Array.isArray(binding.members)
      ? (binding.members as unknown[]).map((m) => asString(m)).filter(Boolean)
      : []
    const condition = toRecord(binding.condition)
    return {
      role,
      members,
      conditionTitle: asString(condition.title),
      conditionExpression: asString(condition.expression)
    }
  }).filter((b) => b.role !== '')
}

function parseKeyRecord(k: Record<string, unknown>): {
  keyId: string
  keyType: string
  keyOrigin: string
  validAfterTime: string
  validBeforeTime: string
  disabled: boolean
} {
  const name = asString(k.name)
  return {
    keyId: name.split('/').pop() ?? name,
    keyType: asString(k.keyType),
    keyOrigin: asString(k.keyOrigin),
    validAfterTime: asString(k.validAfterTime),
    validBeforeTime: asString(k.validBeforeTime),
    disabled: asBoolean(k.disabled)
  }
}

// ── Update Service Account Metadata ─────────────────────────────────────────────

/**
 * Updates a service account's display name and/or description.
 * Requires: iam.serviceAccounts.update
 */
export async function updateGcpServiceAccount(
  projectId: string,
  email: string,
  displayName: string,
  description: string
): Promise<void> {
  const pid = projectId.trim()
  const saResource = `projects/${encodeURIComponent(pid)}/serviceAccounts/${encodeURIComponent(email)}`
  try {
    await requestGcp<Record<string, unknown>>(pid, {
      url: `https://iam.googleapis.com/v1/${saResource}`,
      method: 'PATCH',
      data: {
        serviceAccount: { displayName, description },
        updateMask: 'display_name,description'
      }
    })
  } catch (error) {
    throw classifyGcpError(`updating service account "${email}"`, error, IAM_API)
  }
}

// ── Service Account IAM Bindings (Trust Policy Equivalent) ──────────────────────

/**
 * Adds an IAM binding to the service account itself (e.g., roles/iam.serviceAccountUser
 * to allow impersonation). GCP's equivalent of an AWS role trust policy.
 *
 * Requires: iam.serviceAccounts.setIamPolicy
 */
export async function addGcpServiceAccountIamBinding(
  projectId: string,
  email: string,
  role: string,
  member: string
): Promise<void> {
  const pid = projectId.trim()
  const saResource = `projects/${encodeURIComponent(pid)}/serviceAccounts/${encodeURIComponent(email)}`
  try {
    const policy = await requestGcp<Record<string, unknown>>(pid, {
      url: `https://iam.googleapis.com/v1/${saResource}:getIamPolicy`,
      method: 'POST',
      data: { options: { requestedPolicyVersion: 3 } }
    })

    const bindings = Array.isArray(policy.bindings) ? policy.bindings as Array<Record<string, unknown>> : []
    const existing = bindings.find((b) => asString(b.role) === role)
    if (existing) {
      const members = Array.isArray(existing.members) ? existing.members as string[] : []
      if (!members.includes(member)) {
        members.push(member)
        existing.members = members
      }
    } else {
      bindings.push({ role, members: [member] })
    }

    await requestGcp<Record<string, unknown>>(pid, {
      url: `https://iam.googleapis.com/v1/${saResource}:setIamPolicy`,
      method: 'POST',
      data: { policy: { ...policy, bindings }, updateMask: 'bindings' }
    })
  } catch (error) {
    throw classifyGcpError(`adding IAM binding to service account "${email}"`, error, IAM_API)
  }
}

/**
 * Removes an IAM binding from the service account itself.
 * Requires: iam.serviceAccounts.setIamPolicy
 */
export async function removeGcpServiceAccountIamBinding(
  projectId: string,
  email: string,
  role: string,
  member: string
): Promise<void> {
  const pid = projectId.trim()
  const saResource = `projects/${encodeURIComponent(pid)}/serviceAccounts/${encodeURIComponent(email)}`
  try {
    const policy = await requestGcp<Record<string, unknown>>(pid, {
      url: `https://iam.googleapis.com/v1/${saResource}:getIamPolicy`,
      method: 'POST',
      data: { options: { requestedPolicyVersion: 3 } }
    })

    const bindings = Array.isArray(policy.bindings) ? (policy.bindings as Array<Record<string, unknown>>) : []
    const updated = bindings
      .map((b) => {
        if (asString(b.role) !== role) return b
        const members = (Array.isArray(b.members) ? b.members as string[] : []).filter((m) => m !== member)
        return members.length > 0 ? { ...b, members } : null
      })
      .filter((b): b is Record<string, unknown> => b !== null)

    await requestGcp<Record<string, unknown>>(pid, {
      url: `https://iam.googleapis.com/v1/${saResource}:setIamPolicy`,
      method: 'POST',
      data: { policy: { ...policy, bindings: updated }, updateMask: 'bindings' }
    })
  } catch (error) {
    throw classifyGcpError(`removing IAM binding from service account "${email}"`, error, IAM_API)
  }
}

// ── Custom Role Updates ─────────────────────────────────────────────────────────

/**
 * Updates an existing custom role's title, description, stage, and/or permissions.
 * Requires: iam.roles.update
 */
export async function updateGcpCustomRole(
  projectId: string,
  roleName: string,
  title: string,
  description: string,
  stage: string,
  includedPermissions: string[]
): Promise<GcpIamRoleSummary> {
  const pid = projectId.trim()
  try {
    const result = await requestGcp<Record<string, unknown>>(pid, {
      url: `https://iam.googleapis.com/v1/${roleName}`,
      method: 'PATCH',
      data: { title, description, stage, includedPermissions }
    })

    const name = asString(result.name)
    const perms = Array.isArray(result.includedPermissions)
      ? (result.includedPermissions as unknown[]).map((p) => asString(p)).filter(Boolean)
      : includedPermissions
    return {
      name,
      title: asString(result.title) || title,
      description: asString(result.description) || description,
      stage: asString(result.stage) || stage,
      isCustom: true,
      permissionCount: perms.length,
      includedPermissions: perms
    }
  } catch (error) {
    throw classifyGcpError(`updating custom role "${roleName}"`, error, IAM_API)
  }
}

/**
 * Undeletes (restores) a previously soft-deleted custom role.
 * Requires: iam.roles.undelete
 */
export async function undeleteGcpCustomRole(projectId: string, roleName: string): Promise<GcpIamRoleSummary> {
  const pid = projectId.trim()
  try {
    const result = await requestGcp<Record<string, unknown>>(pid, {
      url: `https://iam.googleapis.com/v1/${roleName}:undelete`,
      method: 'POST',
      data: {}
    })

    const name = asString(result.name)
    const perms = Array.isArray(result.includedPermissions)
      ? (result.includedPermissions as unknown[]).map((p) => asString(p)).filter(Boolean)
      : []
    return {
      name,
      title: asString(result.title) || name.split('/').pop() || name,
      description: asString(result.description),
      stage: asString(result.stage) || 'GA',
      isCustom: true,
      permissionCount: perms.length,
      includedPermissions: perms
    }
  } catch (error) {
    throw classifyGcpError(`restoring custom role "${roleName}"`, error, IAM_API)
  }
}

// ── IAM Audit Log ───────────────────────────────────────────────────────────────

/**
 * Fetches recent IAM-related audit log entries from Cloud Logging. Covers
 * SetIamPolicy, CreateServiceAccount, DeleteServiceAccount, CreateRole,
 * DeleteRole, and CreateServiceAccountKey.
 *
 * Requires: logging.logEntries.list — API: logging.googleapis.com
 */
export async function listGcpIamAuditEntries(
  projectId: string,
  windowHours = 24
): Promise<GcpIamAuditEntry[]> {
  const pid = projectId.trim()
  if (!pid) return []

  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const filter = [
    `logName="projects/${pid}/logs/cloudaudit.googleapis.com%2Factivity"`,
    `timestamp>="${cutoff}"`,
    '(protoPayload.methodName="SetIamPolicy"',
    ' OR protoPayload.methodName="google.iam.admin.v1.CreateServiceAccount"',
    ' OR protoPayload.methodName="google.iam.admin.v1.DeleteServiceAccount"',
    ' OR protoPayload.methodName="google.iam.admin.v1.CreateRole"',
    ' OR protoPayload.methodName="google.iam.admin.v1.DeleteRole"',
    ' OR protoPayload.methodName="google.iam.admin.v1.CreateServiceAccountKey"',
    ' OR protoPayload.methodName="google.iam.admin.v1.DisableServiceAccount"',
    ' OR protoPayload.methodName="google.iam.admin.v1.EnableServiceAccount")'
  ].join('')

  try {
    const entries: GcpIamAuditEntry[] = []
    let pageToken = ''
    const canPage = paginationGuard(10) // Cap at 10 pages for audit queries

    do {
      const response = await requestGcp<{
        entries?: Array<Record<string, unknown>>
        nextPageToken?: string
      }>(pid, {
        url: 'https://logging.googleapis.com/v2/entries:list',
        method: 'POST',
        data: {
          resourceNames: [`projects/${pid}`],
          filter,
          orderBy: 'timestamp desc',
          pageSize: 100,
          ...(pageToken ? { pageToken } : {})
        }
      })

      for (const entry of response.entries ?? []) {
        const payload = toRecord(entry.protoPayload)
        const authInfo = toRecord(payload.authenticationInfo)
        const requestMetadata = toRecord(payload.requestMetadata)

        entries.push({
          timestamp: asString(entry.timestamp),
          severity: asString(entry.severity) || 'INFO',
          methodName: asString(payload.methodName),
          principalEmail: asString(authInfo.principalEmail),
          callerIp: asString(requestMetadata.callerIp),
          resourceName: asString(payload.resourceName),
          serviceName: asString(payload.serviceName),
          statusCode: typeof (toRecord(payload.status)).code === 'number'
            ? (toRecord(payload.status)).code as number
            : 0,
          statusMessage: asString((toRecord(payload.status)).message)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return entries.slice(0, 200) // Hard cap at 200 entries
  } catch (error) {
    throw classifyGcpError(`listing IAM audit entries for project "${pid}"`, error, AUDIT_API)
  }
}

// ── Service Account Key Report (Credential Report Equivalent) ───────────────────

/**
 * Scans all service accounts in a project and produces a key-age report.
 * This is GCP's equivalent of the AWS credential report — it surfaces stale
 * keys, disabled accounts, and key rotation recommendations.
 *
 * Requires: iam.serviceAccounts.list, iam.serviceAccountKeys.list
 */
export async function generateGcpServiceAccountKeyReport(
  projectId: string
): Promise<GcpServiceAccountKeyReport> {
  const pid = projectId.trim()
  if (!pid) {
    return { projectId: '', generatedAt: new Date().toISOString(), entries: [], summary: { totalAccounts: 0, totalKeys: 0, keysOlderThan90Days: 0, keysOlderThan365Days: 0, disabledAccounts: 0 } }
  }

  try {
    // 1. List all service accounts
    const accounts: Array<Record<string, unknown>> = []
    let saPageToken = ''
    const canPage = paginationGuard()
    do {
      const saResponse = await requestGcp<{ accounts?: Array<Record<string, unknown>>; nextPageToken?: string }>(pid, {
        url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(pid)}/serviceAccounts?pageSize=100${saPageToken ? `&pageToken=${encodeURIComponent(saPageToken)}` : ''}`
      })
      accounts.push(...(saResponse.accounts ?? []))
      saPageToken = asString(saResponse.nextPageToken)
    } while (saPageToken && canPage())

    // 2. Fetch keys in parallel batches
    const now = Date.now()
    const batchSize = 10
    const entries: GcpServiceAccountKeyReportEntry[] = []

    for (let i = 0; i < accounts.length; i += batchSize) {
      const batch = accounts.slice(i, i + batchSize)
      const keyBatch = await Promise.all(
        batch.map(async (sa) => {
          const email = asString(sa.email)
          if (!email) return null
          try {
            const keysResult = await requestGcp<{ keys?: Array<Record<string, unknown>> }>(pid, {
              url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(pid)}/serviceAccounts/${encodeURIComponent(email)}/keys?keyTypes=USER_MANAGED`
            })
            const keys = (keysResult.keys ?? []).map((k) => {
              const validAfter = asString(k.validAfterTime)
              const ageDays = validAfter ? Math.floor((now - new Date(validAfter).getTime()) / 86_400_000) : 0
              return {
                keyId: asString(k.name).split('/').pop() ?? '',
                validAfterTime: validAfter,
                validBeforeTime: asString(k.validBeforeTime),
                ageDays,
                disabled: asBoolean(k.disabled)
              }
            })
            return {
              email,
              displayName: asString(sa.displayName),
              disabled: asBoolean(sa.disabled),
              keys,
              keyCount: keys.length,
              oldestKeyAgeDays: keys.length > 0 ? Math.max(...keys.map((k) => k.ageDays)) : 0
            } satisfies GcpServiceAccountKeyReportEntry
          } catch {
            return {
              email,
              displayName: asString(sa.displayName),
              disabled: asBoolean(sa.disabled),
              keys: [],
              keyCount: 0,
              oldestKeyAgeDays: 0
            } satisfies GcpServiceAccountKeyReportEntry
          }
        })
      )
      entries.push(...keyBatch.filter((e): e is GcpServiceAccountKeyReportEntry => e !== null))
    }

    const allKeys = entries.flatMap((e) => e.keys)
    return {
      projectId: pid,
      generatedAt: new Date().toISOString(),
      entries: entries.sort((a, b) => b.oldestKeyAgeDays - a.oldestKeyAgeDays),
      summary: {
        totalAccounts: entries.length,
        totalKeys: allKeys.length,
        keysOlderThan90Days: allKeys.filter((k) => k.ageDays > 90).length,
        keysOlderThan365Days: allKeys.filter((k) => k.ageDays > 365).length,
        disabledAccounts: entries.filter((e) => e.disabled).length
      }
    }
  } catch (error) {
    throw classifyGcpError(`generating key report for project "${pid}"`, error, IAM_API)
  }
}

// ── Workload Identity Pools ─────────────────────────────────────────────────────

/**
 * Lists Workload Identity Federation pools in a project. These are GCP's
 * equivalent of federated users / external identity sources.
 *
 * Requires: iam.workloadIdentityPools.list — API: iam.googleapis.com
 */
export async function listGcpWorkloadIdentityPools(
  projectId: string
): Promise<GcpWorkloadIdentityPoolSummary[]> {
  const pid = projectId.trim()
  if (!pid) return []

  try {
    const pools: GcpWorkloadIdentityPoolSummary[] = []
    let pageToken = ''
    const canPage = paginationGuard()

    do {
      const response = await requestGcp<{
        workloadIdentityPools?: Array<Record<string, unknown>>
        nextPageToken?: string
      }>(pid, {
        url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(pid)}/locations/global/workloadIdentityPools?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })

      for (const pool of response.workloadIdentityPools ?? []) {
        const name = asString(pool.name)
        pools.push({
          name,
          displayName: asString(pool.displayName) || name.split('/').pop() || name,
          description: asString(pool.description),
          state: asString(pool.state) || 'ACTIVE',
          disabled: asBoolean(pool.disabled),
          expireTime: asString(pool.expireTime)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return pools.sort((a, b) => a.displayName.localeCompare(b.displayName))
  } catch (error) {
    throw classifyGcpError(`listing workload identity pools for project "${pid}"`, error, IAM_API)
  }
}

/**
 * Lists providers within a specific Workload Identity Pool.
 * Requires: iam.workloadIdentityPoolProviders.list
 */
export async function listGcpWorkloadIdentityProviders(
  projectId: string,
  poolId: string
): Promise<GcpWorkloadIdentityProviderSummary[]> {
  const pid = projectId.trim()
  if (!pid || !poolId) return []

  try {
    const providers: GcpWorkloadIdentityProviderSummary[] = []
    let pageToken = ''
    const canPage = paginationGuard()

    do {
      const response = await requestGcp<{
        workloadIdentityPoolProviders?: Array<Record<string, unknown>>
        nextPageToken?: string
      }>(pid, {
        url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(pid)}/locations/global/workloadIdentityPools/${encodeURIComponent(poolId)}/providers?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })

      for (const provider of response.workloadIdentityPoolProviders ?? []) {
        const name = asString(provider.name)
        const oidc = toRecord(provider.oidc)
        const aws = toRecord(provider.aws)
        const saml = toRecord(provider.saml)

        let providerType = 'unknown'
        if (oidc.issuerUri) providerType = 'oidc'
        else if (aws.accountId) providerType = 'aws'
        else if (saml.idpMetadataXml) providerType = 'saml'

        providers.push({
          name,
          displayName: asString(provider.displayName) || name.split('/').pop() || name,
          description: asString(provider.description),
          state: asString(provider.state) || 'ACTIVE',
          disabled: asBoolean(provider.disabled),
          providerType,
          attributeMapping: toStringRecord(provider.attributeMapping),
          attributeCondition: asString(provider.attributeCondition)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return providers.sort((a, b) => a.displayName.localeCompare(b.displayName))
  } catch (error) {
    throw classifyGcpError(`listing workload identity providers for pool "${poolId}"`, error, IAM_API)
  }
}

function toStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = typeof v === 'string' ? v : String(v ?? '')
  }
  return result
}

// ── IAM Recommender ─────────────────────────────────────────────────────────────

/**
 * Fetches IAM role recommendations from the Recommender API. Surfaces
 * suggestions like "remove unused roles" or "replace with narrower role".
 *
 * Requires: recommender.iamPolicyRecommendations.list — API: recommender.googleapis.com
 */
export async function listGcpIamRecommendations(
  projectId: string
): Promise<GcpIamRecommendation[]> {
  const pid = projectId.trim()
  if (!pid) return []

  try {
    const recommendations: GcpIamRecommendation[] = []
    let pageToken = ''
    const canPage = paginationGuard(5)

    // The recommender type for IAM role recommendations
    const recommenderType = 'google.iam.policy.Recommender'
    const parent = `projects/${pid}/locations/global/recommenders/${recommenderType}`

    do {
      const response = await requestGcp<{
        recommendations?: Array<Record<string, unknown>>
        nextPageToken?: string
      }>(pid, {
        url: `https://recommender.googleapis.com/v1/${parent}/recommendations?pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })

      for (const rec of response.recommendations ?? []) {
        const content = toRecord(rec.content)
        const primaryImpact = toRecord(rec.primaryImpact)
        const stateInfo = toRecord(rec.stateInfo)
        const operationGroups = Array.isArray(content.operationGroups)
          ? (content.operationGroups as Array<Record<string, unknown>>)
          : []

        // Extract the member + role being recommended for change
        let affectedMember = ''
        let currentRole = ''
        let recommendedRole = ''
        for (const group of operationGroups) {
          const operations = Array.isArray(group.operations)
            ? (group.operations as Array<Record<string, unknown>>)
            : []
          for (const op of operations) {
            const pathFilters = toRecord(op.pathFilters)
            const binding = asString(pathFilters['/iamPolicy/bindings/*/condition'] || '')
            if (asString(op.action) === 'remove') {
              currentRole = asString(pathFilters['/iamPolicy/bindings/*/role']) || currentRole
              affectedMember = asString(pathFilters['/iamPolicy/bindings/*/members/*']) || affectedMember
            }
            if (asString(op.action) === 'add') {
              recommendedRole = asString(pathFilters['/iamPolicy/bindings/*/role']) || recommendedRole
              if (!affectedMember) {
                affectedMember = asString(pathFilters['/iamPolicy/bindings/*/members/*']) || binding
              }
            }
          }
        }

        recommendations.push({
          name: asString(rec.name),
          description: asString(rec.description),
          priority: asString(rec.priority) || 'P4',
          recommenderSubtype: asString(rec.recommenderSubtype),
          state: asString(stateInfo.state) || 'ACTIVE',
          category: asString(primaryImpact.category) || 'SECURITY',
          affectedMember,
          currentRole,
          recommendedRole,
          lastRefreshTime: asString(rec.lastRefreshTime)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return recommendations.sort((a, b) => {
      const priorityOrder: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 }
      return (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4)
    })
  } catch (error) {
    // Recommender API may not be enabled — return empty instead of throwing
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.toLowerCase().includes('disabled') || detail.toLowerCase().includes('not been used')) {
      return []
    }
    throw classifyGcpError(`listing IAM recommendations for project "${pid}"`, error, RECOMMENDER_API)
  }
}

// ── IAM Policy Analyzer ─────────────────────────────────────────────────────────

/**
 * Analyzes the effective IAM policy to answer: "Who has access to this resource
 * with these permissions?" Uses the Cloud Asset API's analyzeIamPolicy method.
 *
 * Requires: cloudasset.assets.analyzeIamPolicy — API: cloudasset.googleapis.com
 */
export async function analyzeGcpIamPolicy(
  projectId: string,
  fullResourceName: string,
  permissions: string[],
  identity?: string
): Promise<GcpIamPolicyAnalysisResult> {
  const pid = projectId.trim()
  if (!pid) {
    return { analysisResults: [], fullyExplored: false }
  }

  try {
    const params = new URLSearchParams()
    params.set('analysisQuery.scope', `projects/${pid}`)

    if (fullResourceName) {
      params.set('analysisQuery.resourceSelector.fullResourceName', fullResourceName)
    }

    for (const perm of permissions.filter(Boolean)) {
      params.append('analysisQuery.accessSelector.permissions', perm)
    }

    if (identity) {
      params.set('analysisQuery.identitySelector.identity', identity)
    }

    // Request access detail expansion
    params.set('analysisQuery.options.expandGroups', 'true')
    params.set('analysisQuery.options.outputGroupEdges', 'false')

    const response = await requestGcp<Record<string, unknown>>(pid, {
      url: `https://cloudasset.googleapis.com/v1/projects/${encodeURIComponent(pid)}:analyzeIamPolicy?${params.toString()}`
    })

    const mainAnalysis = toRecord(response.mainAnalysis)
    const analysisResults = Array.isArray(mainAnalysis.analysisResults)
      ? (mainAnalysis.analysisResults as Array<Record<string, unknown>>)
      : []

    const fullyExplored = asBoolean(mainAnalysis.fullyExplored)
    const entries: GcpIamPolicyAnalysisAccessEntry[] = []

    for (const result of analysisResults.slice(0, 100)) {
      const iamBinding = toRecord(result.iamBinding)
      const accessControlLists = Array.isArray(result.accessControlLists)
        ? (result.accessControlLists as Array<Record<string, unknown>>)
        : []

      const identities: string[] = []
      const resources: string[] = []
      const accesses: string[] = []

      for (const acl of accessControlLists) {
        const aclResources = Array.isArray(acl.resources)
          ? (acl.resources as Array<Record<string, unknown>>)
          : []
        const aclAccesses = Array.isArray(acl.accesses)
          ? (acl.accesses as Array<Record<string, unknown>>)
          : []

        for (const r of aclResources) {
          const fullName = asString(r.fullResourceName)
          if (fullName && !resources.includes(fullName)) resources.push(fullName)
        }
        for (const a of aclAccesses) {
          const perm = asString(a.permission)
          if (perm && !accesses.includes(perm)) accesses.push(perm)
        }
      }

      const identityList = toRecord(result.identityList)
      const identityEntries = Array.isArray(identityList.identities)
        ? (identityList.identities as Array<Record<string, unknown>>)
        : []
      for (const id of identityEntries) {
        const name = asString(id.name)
        if (name && !identities.includes(name)) identities.push(name)
      }

      entries.push({
        role: asString(iamBinding.role),
        members: Array.isArray(iamBinding.members)
          ? (iamBinding.members as unknown[]).map((m) => asString(m)).filter(Boolean)
          : [],
        identities: identities.slice(0, 20),
        resources: resources.slice(0, 10),
        accesses: accesses.slice(0, 20),
        conditionTitle: asString(toRecord(iamBinding.condition).title)
      })
    }

    return { analysisResults: entries, fullyExplored }
  } catch (error) {
    throw classifyGcpError(`analyzing IAM policy for project "${pid}"`, error, POLICY_ANALYZER_API)
  }
}
