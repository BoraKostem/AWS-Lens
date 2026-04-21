import type {
  AwsConnection,
  CorrelatedSignalReference,
  ObservabilityFinding,
  ObservabilityPostureArea,
  ObservabilityPostureReport,
  ObservabilityRecommendation
} from '@shared/types'
import { enrichTerragruntProjectInventory, getProject } from '../terraform'
import { parseAzureContext, str } from './terraformShared'

function postureArea(id: string, label: string, value: string, tone: ObservabilityPostureArea['tone'], detail: string): ObservabilityPostureArea {
  return { id, label, value, tone, detail }
}

function finding(id: string, title: string, severity: ObservabilityFinding['severity'], summary: string, detail: string, impact: string, recommendationId: string, inference = true): ObservabilityFinding {
  return {
    id,
    title,
    severity,
    category: 'deployment',
    summary,
    detail,
    evidence: [],
    impact,
    inference,
    recommendedActionIds: [recommendationId]
  }
}

function recommendation(id: string, title: string, summary: string, rationale: string, expectedBenefit: string, risk: string, rollback: string): ObservabilityRecommendation {
  return {
    id,
    title,
    type: 'manual-check',
    summary,
    rationale,
    expectedBenefit,
    risk,
    rollback,
    prerequisiteLevel: 'required',
    setupEffort: 'low',
    labels: ['azure', 'terraform']
  }
}

export async function generateAzureTerraformObservabilityReport(
  profileName: string,
  projectId: string,
  connection?: AwsConnection
): Promise<ObservabilityPostureReport> {
  const baseProject = await getProject(profileName, projectId, connection)
  // loadProject's inventory is empty for terragrunt + remote backend. Without the pull the
  // resource-count heuristics below read zero Azure resources and emit misleading findings.
  const project = (baseProject.kind === 'terragrunt-unit' || baseProject.kind === 'terragrunt-stack')
    ? { ...baseProject, inventory: await enrichTerragruntProjectInventory(profileName, connection, baseProject) }
    : baseProject
  const context = parseAzureContext(profileName, project, connection)
  const azureResources = project.inventory.filter((item) => item.mode === 'managed' && item.type.startsWith('azurerm_'))
  const monitorCount = azureResources.filter((item) => item.type.includes('monitor_') || item.type.includes('log_analytics_')).length
  const taggedCount = azureResources.filter((item) => {
    const tags = item.values.tags
    return Boolean(tags && typeof tags === 'object' && Object.keys(tags as Record<string, unknown>).length > 0)
  }).length
  const tagCoverage = azureResources.length > 0 ? Math.round((taggedCount / azureResources.length) * 100) : 0

  const recommendations: ObservabilityRecommendation[] = [
    recommendation('azure-backend', 'Move state to a shared backend', 'Prefer a remote backend for Azure shared workspaces.', 'Shared workspaces rely on consistent state access and recoverability.', 'Improves recovery and operator confidence.', 'Backend migration needs coordination.', 'Revert backend configuration and reinitialize if the migration is blocked.'),
    recommendation('azure-monitor', 'Add Azure Monitor anchors', 'Track diagnostic settings and Log Analytics resources in Terraform.', 'Shared Overview and Direct Access become more actionable when monitoring surfaces exist in state.', 'Improves observability and handoff quality.', 'Additional resources may increase cost.', 'Remove the monitor resources from Terraform if they are not desired.')
  ]

  const findings: ObservabilityFinding[] = []
  if (project.metadata.backendType === 'local') {
    findings.push(finding('local-backend', 'Terraform state uses a local backend', 'high', 'Local backend detected', 'The project is still using a local backend, which weakens shared operator recovery flows.', 'Operators have lower confidence during incident response or drift review.', 'azure-backend'))
  }
  if (monitorCount === 0 && azureResources.length > 0) {
    findings.push(finding('monitor-gap', 'Azure Monitor resources are not tracked in Terraform', 'medium', 'No monitor anchors found', 'No Azure Monitor diagnostic or Log Analytics resources are visible in the current Terraform inventory.', 'Overview and resilience workflows have fewer observability pivots.', 'azure-monitor'))
  }

  const correlatedSignals: CorrelatedSignalReference[] = [
    { id: 'azure-terraform', title: 'Terraform workspace', detail: project.name, serviceId: 'terraform', targetView: 'drift' },
    { id: 'azure-overview', title: 'Shared overview', detail: context.contextId, serviceId: 'overview', targetView: 'overview' },
    { id: 'azure-compliance', title: 'Compliance queue', detail: 'Azure heuristic findings', serviceId: 'compliance-center', targetView: 'tasks' },
    { id: 'azure-compare', title: 'Compare workspace', detail: 'Cross-project Azure Terraform comparison', serviceId: 'compare', targetView: 'services' }
  ]

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      kind: 'terraform',
      connection: {
        kind: connection?.kind ?? 'profile',
        label: connection?.label || context.contextId,
        profile: connection?.profile || context.contextId,
        region: connection?.region || context.location,
        sessionId: connection?.sessionId || profileName
      },
      projectId: project.id,
      projectName: project.name,
      rootPath: project.rootPath
    },
    summary: [
      postureArea('resources', 'Tracked resources', String(azureResources.length), azureResources.length > 0 ? 'mixed' : 'weak', 'Azure observability inference currently works from Terraform inventory only.'),
      postureArea('backend', 'Backend', project.metadata.backendType, project.metadata.backendType === 'local' ? 'weak' : 'good', 'Remote backends improve shared operator recovery and drift workflows.'),
      postureArea('monitor', 'Monitor coverage', String(monitorCount), monitorCount > 0 ? 'good' : 'weak', 'Diagnostic settings and Log Analytics resources act as observability anchors.'),
      postureArea('tags', 'Tag coverage', `${tagCoverage}%`, tagCoverage >= 70 ? 'good' : tagCoverage >= 40 ? 'mixed' : 'weak', 'Tags help correlate cost, ownership, and remediation queues.')
    ],
    findings,
    recommendations,
    experiments: [],
    artifacts: [],
    safetyNotes: [
      {
        title: 'Azure Terraform observability is inferred',
        blastRadius: 'Low',
        prerequisites: ['Use the terminal handoff for stronger live verification when needed.'],
        rollback: 'No rollback required; this report does not mutate infrastructure.'
      }
    ],
    correlatedSignals
  }
}
