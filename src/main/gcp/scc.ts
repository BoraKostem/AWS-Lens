/**
 * Security Command Center wrappers — findings, sources, detail, severity
 * breakdown. Extracted verbatim from gcpSdk.ts as part of the monolith
 * decomposition.
 */

import type {
  GcpSccFindingClass,
  GcpSccFindingDetail,
  GcpSccFindingSummary,
  GcpSccHealthAnalytics,
  GcpSccPostureReport,
  GcpSccSeverityBreakdown,
  GcpSccSourceSummary
} from '@shared/types'

import { paginationGuard, requestGcp } from './client'
import { asString, buildGcpSdkError } from './shared'

function buildSccApiUrl(pathname: string, query: Record<string, number | string | undefined> = {}, version: 'v1' | 'v2' = 'v2'): string {
  const url = new URL(`https://securitycenter.googleapis.com/${version}/${pathname.replace(/^\/+/, '')}`)

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

export async function listGcpSccFindings(projectId: string, _location?: string, filter?: string): Promise<GcpSccFindingSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const findings: GcpSccFindingSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildSccApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/sources/-/locations/global/findings`, {
          pageSize: 500,
          filter: filter || 'state="ACTIVE"',
          pageToken: pageToken || undefined
        })
      })

      const listFindings = Array.isArray(response.listFindingsResults) ? response.listFindingsResults : []
      for (const wrapper of listFindings) {
        const wrapperObj = wrapper && typeof wrapper === 'object' ? wrapper as Record<string, unknown> : {}
        const record = wrapperObj.finding && typeof wrapperObj.finding === 'object' ? wrapperObj.finding as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        const resource = record.resourceName ? record : (wrapperObj.resource && typeof wrapperObj.resource === 'object' ? wrapperObj.resource as Record<string, unknown> : {})

        findings.push({
          name,
          category: asString(record.category),
          state: asString(record.state),
          severity: asString(record.severity),
          resourceName: asString(resource.name ?? record.resourceName),
          resourceType: asString((wrapperObj.resource && typeof wrapperObj.resource === 'object' ? wrapperObj.resource as Record<string, unknown> : {}).type),
          sourceDisplayName: asString(record.canonicalName ? record.canonicalName : record.parent)?.split('/').slice(0, 4).join('/') ?? '',
          eventTime: asString(record.eventTime),
          createTime: asString(record.createTime),
          description: asString(record.description),
          externalUri: asString(record.externalUri)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return findings
  } catch (error) {
    if (String(error).includes('404') || String(error).toLowerCase().includes('not found')) return []
    throw buildGcpSdkError(`listing Security Command Center findings for project "${normalizedProjectId}"`, error, 'securitycenter.googleapis.com')
  }
}

export async function listGcpSccSources(projectId: string, location?: string): Promise<GcpSccSourceSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return []

  try {
    const sources: GcpSccSourceSummary[] = []
    let pageToken = ''

    const canPage = paginationGuard()
    do {
      const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
        url: buildSccApiUrl(`projects/${encodeURIComponent(normalizedProjectId)}/sources`, {
          pageSize: 500,
          pageToken: pageToken || undefined
        })
      })

      for (const entry of Array.isArray(response.sources) ? response.sources : []) {
        const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = asString(record.name)
        if (!name) continue

        sources.push({
          name,
          displayName: asString(record.displayName),
          description: asString(record.description)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return sources
  } catch (error) {
    if (String(error).includes('404') || String(error).toLowerCase().includes('not found')) return []
    throw buildGcpSdkError(`listing Security Command Center sources for project "${normalizedProjectId}"`, error, 'securitycenter.googleapis.com')
  }
}

export async function getGcpSccFindingDetail(projectId: string, findingName: string, _location?: string): Promise<GcpSccFindingDetail> {
  const normalizedProjectId = projectId.trim()

  try {
    const response = await requestGcp<Record<string, unknown>>(normalizedProjectId, {
      url: buildSccApiUrl(findingName.trim())
    })

    const sourceProperties = response.sourceProperties && typeof response.sourceProperties === 'object'
      ? Object.fromEntries(
        Object.entries(response.sourceProperties as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')])
      )
      : {}

    return {
      name: asString(response.name),
      category: asString(response.category),
      state: asString(response.state),
      severity: asString(response.severity),
      resourceName: asString(response.resourceName),
      resourceType: asString((response.resource && typeof response.resource === 'object' ? response.resource as Record<string, unknown> : {}).type),
      sourceDisplayName: asString(response.sourceDisplayName),
      sourceProperties,
      eventTime: asString(response.eventTime),
      createTime: asString(response.createTime),
      description: asString(response.description),
      nextSteps: asString(response.nextSteps),
      externalUri: asString(response.externalUri),
      mute: asString(response.mute)
    }
  } catch (error) {
    throw buildGcpSdkError(`getting SCC finding detail for "${findingName}"`, error, 'securitycenter.googleapis.com')
  }
}

/** Requires: securitycenter.findings.list — API: securitycenter.googleapis.com */
export async function getGcpSccSeverityBreakdown(projectId: string, location?: string): Promise<GcpSccSeverityBreakdown> {
  try {
    const findings = await listGcpSccFindings(projectId, location, 'state="ACTIVE"')
    const breakdown: GcpSccSeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, unspecified: 0 }

    for (const finding of findings) {
      const severity = finding.severity.toUpperCase()
      if (severity === 'CRITICAL') breakdown.critical++
      else if (severity === 'HIGH') breakdown.high++
      else if (severity === 'MEDIUM') breakdown.medium++
      else if (severity === 'LOW') breakdown.low++
      else breakdown.unspecified++
    }

    return breakdown
  } catch (error) {
    throw buildGcpSdkError(`loading SCC severity breakdown for project "${projectId}"`, error, 'securitycenter.googleapis.com')
  }
}

/* ── v2.8.0 — Enhanced SCC posture report ────────────────── */

const VULNERABILITY_CATEGORIES = new Set([
  'PUBLIC_BUCKET_ACL', 'SQL_PUBLIC_IP', 'OPEN_FIREWALL', 'OPEN_SSH_PORT',
  'OPEN_RDP_PORT', 'WEB_UI_ENABLED', 'MASTER_AUTHORIZED_NETWORKS_DISABLED',
  'LEGACY_AUTHORIZATION_ENABLED', 'CLUSTER_SHIELDED_NODES_DISABLED',
  'OVER_PRIVILEGED_SERVICE_ACCOUNT_USER', 'OS_VULNERABILITY', 'SOFTWARE_VULNERABILITY'
])

const THREAT_CATEGORIES = new Set([
  'MALWARE', 'CRYPTOMINING', 'BRUTE_FORCE', 'OUTGOING_INTRUSION_ATTEMPT',
  'INCOMING_INTRUSION_ATTEMPT', 'REVERSE_SHELL', 'SUSPICIOUS_LOGIN',
  'DATA_EXFILTRATION', 'PRIVILEGE_ESCALATION', 'DEFENSE_EVASION',
  'INITIAL_ACCESS', 'ADDED_BINARY_EXECUTED', 'MODIFIED_MALICIOUS_BINARY_EXECUTED'
])

function classifyFinding(category: string): GcpSccFindingClass {
  const upper = category.toUpperCase().replace(/[- ]/g, '_')
  if (THREAT_CATEGORIES.has(upper)) return 'threat'
  if (VULNERABILITY_CATEGORIES.has(upper)) return 'vulnerability'
  if (upper.includes('MISCONFIGURATION') || upper.includes('COMPLIANCE') ||
      upper.includes('AUDIT_LOGGING') || upper.includes('MFA_NOT_ENFORCED') ||
      upper.includes('DEFAULT_SERVICE_ACCOUNT') || upper.includes('NON_ORG_IAM_MEMBER')) {
    return 'misconfiguration'
  }
  if (upper.includes('OBSERVATION') || upper.includes('INFORMATIONAL')) return 'observation'
  // Default: check source display name for clues
  return 'other'
}

function buildHealthAnalytics(findings: GcpSccFindingSummary[]): GcpSccHealthAnalytics {
  const activeFindings = findings.filter((f) => f.state === 'ACTIVE')

  const byClass: Record<GcpSccFindingClass, number> = {
    vulnerability: 0, misconfiguration: 0, threat: 0, observation: 0, other: 0
  }
  const bySeverity: GcpSccSeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, unspecified: 0 }
  const categoryCounts = new Map<string, number>()
  const resourceCounts = new Map<string, number>()

  for (const f of activeFindings) {
    byClass[classifyFinding(f.category)] += 1

    const sev = f.severity.toUpperCase()
    if (sev === 'CRITICAL') bySeverity.critical++
    else if (sev === 'HIGH') bySeverity.high++
    else if (sev === 'MEDIUM') bySeverity.medium++
    else if (sev === 'LOW') bySeverity.low++
    else bySeverity.unspecified++

    categoryCounts.set(f.category, (categoryCounts.get(f.category) ?? 0) + 1)
    if (f.resourceName) {
      resourceCounts.set(f.resourceName, (resourceCounts.get(f.resourceName) ?? 0) + 1)
    }
  }

  const topCategories = Array.from(categoryCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const topResources = Array.from(resourceCounts.entries())
    .map(([resourceName, count]) => ({ resourceName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    totalFindings: findings.length,
    activeFindings: activeFindings.length,
    byClass,
    bySeverity,
    topCategories,
    topResources
  }
}

export async function getGcpSccPostureReport(projectId: string, location?: string): Promise<GcpSccPostureReport> {
  const normalizedProjectId = projectId.trim()
  const warnings: string[] = []

  let allFindings: GcpSccFindingSummary[] = []
  try {
    allFindings = await listGcpSccFindings(normalizedProjectId, location)
  } catch (error) {
    warnings.push(`Findings: ${error instanceof Error ? error.message : String(error)}`)
  }

  let sources: GcpSccSourceSummary[] = []
  try {
    sources = await listGcpSccSources(normalizedProjectId, location)
  } catch (error) {
    warnings.push(`Sources: ${error instanceof Error ? error.message : String(error)}`)
  }

  const activeFindings = allFindings.filter((f) => f.state === 'ACTIVE')
  const findingsByClass: Record<GcpSccFindingClass, GcpSccFindingSummary[]> = {
    vulnerability: [], misconfiguration: [], threat: [], observation: [], other: []
  }

  for (const f of activeFindings) {
    findingsByClass[classifyFinding(f.category)].push(f)
  }

  const healthAnalytics = buildHealthAnalytics(allFindings)

  return {
    generatedAt: new Date().toISOString(),
    projectId: normalizedProjectId,
    healthAnalytics,
    findingsByClass,
    sources,
    warnings
  }
}
