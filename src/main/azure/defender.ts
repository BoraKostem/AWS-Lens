/**
 * Microsoft Defender for Cloud — secure score, recommendations, regulatory
 * compliance, security alerts, and attack path analysis.
 *
 * Uses the Microsoft.Security resource provider's REST API.
 */

import { classifyAzureError, fetchAzureArmCollection, fetchAzureArmJson } from './client'
import type {
  AzureDefenderAlert,
  AzureDefenderAlertSeverity,
  AzureDefenderAssessmentStatus,
  AzureDefenderAttackPath,
  AzureDefenderComplianceStandard,
  AzureDefenderRecommendation,
  AzureDefenderReport,
  AzureDefenderSecureScore,
  AzureDefenderSecureScoreControl
} from '@shared/types'

/* ── Severity Normalization ──────────────────────────────── */

function normalizeSeverity(raw: string | undefined): AzureDefenderAlertSeverity {
  const lower = (raw ?? '').toLowerCase()
  if (lower === 'high') return 'high'
  if (lower === 'medium') return 'medium'
  if (lower === 'low') return 'low'
  return 'informational'
}

function normalizeStatus(raw: string | undefined): AzureDefenderAssessmentStatus {
  const lower = (raw ?? '').toLowerCase()
  if (lower === 'healthy') return 'healthy'
  if (lower === 'unhealthy') return 'unhealthy'
  return 'notApplicable'
}

function pctOf(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 100)
}

/* ── Secure Score ─────────────────────────────────────────── */

type SecureScoreRecord = {
  id?: string
  name?: string
  properties?: {
    displayName?: string
    score?: {
      current?: number
      max?: number
      percentage?: number
    }
    weight?: number
  }
}

export async function getAzureDefenderSecureScore(
  subscriptionId: string
): Promise<AzureDefenderSecureScore | null> {
  const scope = `/subscriptions/${subscriptionId.trim()}`
  try {
    const data = await fetchAzureArmJson<SecureScoreRecord>(
      `${scope}/providers/Microsoft.Security/secureScores/ascScore`,
      '2020-01-01'
    )

    const props = data.properties
    if (!props?.score) return null

    const current = props.score.current ?? 0
    const max = props.score.max ?? 0
    return {
      name: data.name ?? 'ascScore',
      displayName: props.displayName ?? 'ASC score',
      currentScore: current,
      maxScore: max,
      percentage: props.score.percentage !== undefined
        ? Math.round(props.score.percentage * 100)
        : pctOf(current, max),
      weight: props.weight ?? 0
    }
  } catch (error) {
    const msg = String(error)
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) return null
    throw classifyAzureError(`loading Defender secure score for subscription "${subscriptionId}"`, error)
  }
}

/* ── Secure Score Controls ────────────────────────────────── */

type SecureScoreControlRecord = {
  id?: string
  name?: string
  properties?: {
    displayName?: string
    score?: {
      current?: number
      max?: number
      percentage?: number
    }
    healthyResourceCount?: number
    unhealthyResourceCount?: number
    notApplicableResourceCount?: number
    definition?: {
      properties?: {
        displayName?: string
        description?: string
      }
    }
  }
}

export async function listAzureDefenderSecureScoreControls(
  subscriptionId: string
): Promise<AzureDefenderSecureScoreControl[]> {
  const scope = `/subscriptions/${subscriptionId.trim()}`
  try {
    const items = await fetchAzureArmCollection<SecureScoreControlRecord>(
      `${scope}/providers/Microsoft.Security/secureScoreControls`,
      '2020-01-01'
    )

    return items.map((item) => {
      const props = item.properties
      const current = props?.score?.current ?? 0
      const max = props?.score?.max ?? 0
      return {
        id: item.id ?? '',
        name: item.name ?? '',
        displayName:
          props?.displayName ?? props?.definition?.properties?.displayName ?? item.name ?? 'Unknown',
        currentScore: current,
        maxScore: max,
        percentage:
          props?.score?.percentage !== undefined
            ? Math.round(props.score.percentage * 100)
            : pctOf(current, max),
        healthyResourceCount: props?.healthyResourceCount ?? 0,
        unhealthyResourceCount: props?.unhealthyResourceCount ?? 0,
        notApplicableResourceCount: props?.notApplicableResourceCount ?? 0,
        category: props?.definition?.properties?.description ?? 'General'
      }
    }).sort((a, b) => b.unhealthyResourceCount - a.unhealthyResourceCount)
  } catch (error) {
    throw classifyAzureError(`listing Defender secure score controls for subscription "${subscriptionId}"`, error)
  }
}

/* ── Recommendations (Assessments) ────────────────────────── */

type AssessmentRecord = {
  id?: string
  name?: string
  properties?: {
    displayName?: string
    status?: {
      code?: string
      cause?: string
      description?: string
    }
    resourceDetails?: {
      Id?: string
      id?: string
    }
    metadata?: {
      displayName?: string
      description?: string
      severity?: string
      category?: string[] | string
      remediationDescription?: string
    }
  }
}

export async function listAzureDefenderRecommendations(
  subscriptionId: string
): Promise<AzureDefenderRecommendation[]> {
  const scope = `/subscriptions/${subscriptionId.trim()}`
  try {
    const items = await fetchAzureArmCollection<AssessmentRecord>(
      `${scope}/providers/Microsoft.Security/assessments`,
      '2020-01-01'
    )

    return items.map((item) => {
      const props = item.properties
      const meta = props?.metadata
      const category = Array.isArray(meta?.category) ? meta?.category?.[0] : meta?.category
      const resourceId =
        props?.resourceDetails?.Id ?? props?.resourceDetails?.id ?? ''
      return {
        id: item.id ?? '',
        name: item.name ?? '',
        displayName: props?.displayName ?? meta?.displayName ?? item.name ?? 'Unknown',
        description: meta?.description ?? props?.status?.description ?? '',
        severity: normalizeSeverity(meta?.severity),
        status: normalizeStatus(props?.status?.code),
        category: category ?? 'General',
        resourceId,
        remediation: meta?.remediationDescription ?? ''
      }
    }).sort((a, b) => {
      // Unhealthy items first
      if (a.status === 'unhealthy' && b.status !== 'unhealthy') return -1
      if (a.status !== 'unhealthy' && b.status === 'unhealthy') return 1
      const sevOrder: Record<AzureDefenderAlertSeverity, number> = {
        high: 0, medium: 1, low: 2, informational: 3
      }
      return sevOrder[a.severity] - sevOrder[b.severity]
    })
  } catch (error) {
    throw classifyAzureError(`listing Defender recommendations for subscription "${subscriptionId}"`, error)
  }
}

/* ── Security Alerts ──────────────────────────────────────── */

type AlertRecord = {
  id?: string
  name?: string
  properties?: {
    alertDisplayName?: string
    description?: string
    severity?: string
    status?: string
    intent?: string
    timeGeneratedUtc?: string
    reportedTimeUtc?: string
    vendorName?: string
    compromisedEntity?: string
    resourceIdentifiers?: Array<{
      azureResourceId?: string
      type?: string
    }>
  }
}

export async function listAzureDefenderAlerts(
  subscriptionId: string
): Promise<AzureDefenderAlert[]> {
  const scope = `/subscriptions/${subscriptionId.trim()}`
  try {
    const items = await fetchAzureArmCollection<AlertRecord>(
      `${scope}/providers/Microsoft.Security/alerts`,
      '2022-01-01'
    )

    return items.map((item) => {
      const props = item.properties
      const resourceId = props?.resourceIdentifiers?.[0]?.azureResourceId ?? ''
      return {
        id: item.id ?? '',
        name: item.name ?? '',
        alertDisplayName: props?.alertDisplayName ?? item.name ?? 'Unknown alert',
        description: props?.description ?? '',
        severity: normalizeSeverity(props?.severity),
        status: props?.status ?? 'Unknown',
        intent: props?.intent ?? '',
        timeGenerated: props?.timeGeneratedUtc ?? props?.reportedTimeUtc ?? '',
        resourceId,
        compromisedEntity: props?.compromisedEntity ?? '',
        vendor: props?.vendorName ?? 'Microsoft Defender for Cloud'
      }
    }).sort((a, b) => {
      const sevOrder: Record<AzureDefenderAlertSeverity, number> = {
        high: 0, medium: 1, low: 2, informational: 3
      }
      const sevDelta = sevOrder[a.severity] - sevOrder[b.severity]
      if (sevDelta !== 0) return sevDelta
      return new Date(b.timeGenerated).getTime() - new Date(a.timeGenerated).getTime()
    })
  } catch (error) {
    throw classifyAzureError(`listing Defender alerts for subscription "${subscriptionId}"`, error)
  }
}

/* ── Regulatory Compliance Standards ──────────────────────── */

type ComplianceStandardRecord = {
  id?: string
  name?: string
  properties?: {
    displayName?: string
    state?: string
    passedControls?: number
    failedControls?: number
    skippedControls?: number
    unsupportedControls?: number
  }
}

export async function listAzureDefenderComplianceStandards(
  subscriptionId: string
): Promise<AzureDefenderComplianceStandard[]> {
  const scope = `/subscriptions/${subscriptionId.trim()}`
  try {
    const items = await fetchAzureArmCollection<ComplianceStandardRecord>(
      `${scope}/providers/Microsoft.Security/regulatoryComplianceStandards`,
      '2019-01-01-preview'
    )

    return items.map((item) => {
      const props = item.properties
      const passed = props?.passedControls ?? 0
      const failed = props?.failedControls ?? 0
      const total = passed + failed
      return {
        id: item.id ?? '',
        name: item.name ?? '',
        displayName: props?.displayName ?? item.name ?? 'Unknown',
        state: props?.state ?? 'Unknown',
        passedControls: passed,
        failedControls: failed,
        skippedControls: props?.skippedControls ?? 0,
        unsupportedControls: props?.unsupportedControls ?? 0,
        compliancePercentage: pctOf(passed, total)
      }
    }).sort((a, b) => a.compliancePercentage - b.compliancePercentage)
  } catch (error) {
    const msg = String(error)
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) return []
    throw classifyAzureError(
      `listing Defender regulatory compliance for subscription "${subscriptionId}"`,
      error
    )
  }
}

/* ── Attack Paths (Microsoft.Security/attackPaths) ────────── */

type AttackPathRecord = {
  id?: string
  name?: string
  properties?: {
    displayName?: string
    description?: string
    riskLevel?: string
    riskCategories?: string[]
    entryPoint?: string
    target?: {
      azureResourceId?: string
      id?: string
    }
    attackPathNodes?: unknown[]
  }
}

export async function listAzureDefenderAttackPaths(
  subscriptionId: string
): Promise<AzureDefenderAttackPath[]> {
  const scope = `/subscriptions/${subscriptionId.trim()}`
  try {
    const items = await fetchAzureArmCollection<AttackPathRecord>(
      `${scope}/providers/Microsoft.Security/attackPaths`,
      '2023-11-15'
    )

    return items.map((item) => {
      const props = item.properties
      return {
        id: item.id ?? '',
        name: item.name ?? '',
        displayName: props?.displayName ?? item.name ?? 'Unknown attack path',
        description: props?.description ?? '',
        riskLevel: normalizeSeverity(props?.riskLevel),
        riskCategories: props?.riskCategories ?? [],
        entryPoint: props?.entryPoint ?? '',
        targetResourceId:
          props?.target?.azureResourceId ?? props?.target?.id ?? '',
        stepCount: Array.isArray(props?.attackPathNodes) ? props.attackPathNodes.length : 0
      }
    })
  } catch (error) {
    const msg = String(error)
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) return []
    // Attack paths may not be enabled; don't fail the whole report
    return []
  }
}

/* ── Consolidated Report ──────────────────────────────────── */

export async function getAzureDefenderReport(
  subscriptionId: string
): Promise<AzureDefenderReport> {
  const normalizedId = subscriptionId.trim()
  const warnings: string[] = []

  async function safe<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      return fallback
    }
  }

  const [
    secureScore,
    secureScoreControls,
    recommendations,
    alerts,
    complianceStandards,
    attackPaths
  ] = await Promise.all([
    safe('Secure score', null as AzureDefenderSecureScore | null, () =>
      getAzureDefenderSecureScore(normalizedId)
    ),
    safe('Secure score controls', [] as AzureDefenderSecureScoreControl[], () =>
      listAzureDefenderSecureScoreControls(normalizedId)
    ),
    safe('Recommendations', [] as AzureDefenderRecommendation[], () =>
      listAzureDefenderRecommendations(normalizedId)
    ),
    safe('Alerts', [] as AzureDefenderAlert[], () => listAzureDefenderAlerts(normalizedId)),
    safe('Compliance standards', [] as AzureDefenderComplianceStandard[], () =>
      listAzureDefenderComplianceStandards(normalizedId)
    ),
    safe('Attack paths', [] as AzureDefenderAttackPath[], () =>
      listAzureDefenderAttackPaths(normalizedId)
    )
  ])

  // Category breakdown for recommendations
  const recommendationsByCategory: Record<string, number> = {}
  for (const r of recommendations) {
    if (r.status !== 'unhealthy') continue
    recommendationsByCategory[r.category] = (recommendationsByCategory[r.category] ?? 0) + 1
  }

  // Severity breakdown for alerts
  const alertsBySeverity: Record<AzureDefenderAlertSeverity, number> = {
    high: 0, medium: 1, low: 2, informational: 3
  }
  for (const key of Object.keys(alertsBySeverity) as AzureDefenderAlertSeverity[]) {
    alertsBySeverity[key] = 0
  }
  for (const a of alerts) {
    alertsBySeverity[a.severity] = (alertsBySeverity[a.severity] ?? 0) + 1
  }

  return {
    generatedAt: new Date().toISOString(),
    subscriptionId: normalizedId,
    secureScore,
    secureScoreControls,
    recommendations,
    alerts,
    complianceStandards,
    attackPaths,
    recommendationsByCategory,
    alertsBySeverity,
    warnings
  }
}
