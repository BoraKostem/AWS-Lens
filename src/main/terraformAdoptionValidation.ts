import type { BrowserWindow } from 'electron'

import type {
  AwsConnection,
  TerraformAdoptionTarget,
  TerraformAdoptionValidationResult,
  TerraformCommandLog,
  TerraformPlanChange,
  TerraformPlanSummary
} from '@shared/types'
import { generateTerraformAdoptionCode } from './terraformAdoptionCodegen'
import { getProject, runProjectCommand } from './terraform'

function emptyPlanSummary(): TerraformPlanSummary {
  return {
    create: 0,
    update: 0,
    delete: 0,
    replace: 0,
    noop: 0,
    hasChanges: false,
    affectedResources: 0,
    affectedModules: [],
    affectedProviders: [],
    affectedServices: [],
    groups: {
      byModule: [],
      byAction: [],
      byResourceType: []
    },
    jsonFieldsUsed: [],
    heuristicNotes: [],
    hasDestructiveChanges: false,
    hasReplacementChanges: false,
    isDeleteHeavy: false,
    request: {
      mode: 'targeted',
      targets: [],
      replaceAddresses: []
    }
  }
}

function summarizeValidation(
  address: string,
  log: TerraformCommandLog,
  planSummary: TerraformPlanSummary,
  matchingChanges: TerraformPlanChange[]
): { status: TerraformAdoptionValidationResult['status']; summary: string } {
  if (!log.success) {
    return {
      status: 'failed',
      summary: `Targeted terraform plan failed for ${address}. Review the command output before continuing.`
    }
  }

  if (matchingChanges.length === 0 && !planSummary.hasChanges) {
    return {
      status: 'passed',
      summary: `Targeted terraform plan reported no remaining changes for ${address}.`
    }
  }

  if (matchingChanges.length > 0) {
    return {
      status: 'needs-review',
      summary: `Targeted terraform plan still shows ${matchingChanges.length} change${matchingChanges.length === 1 ? '' : 's'} for ${address}.`
    }
  }

  return {
    status: 'needs-review',
    summary: `Targeted terraform plan completed, but ${planSummary.affectedResources} resource${planSummary.affectedResources === 1 ? '' : 's'} in the dependency graph still need review.`
  }
}

export async function validateTerraformAdoptionImport(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget,
  window: BrowserWindow | null
): Promise<TerraformAdoptionValidationResult> {
  const codegen = generateTerraformAdoptionCode(profileName, projectId, connection, target)
  const address = codegen.mapping.suggestedAddress
  const log = await runProjectCommand({
    profileName,
    connection,
    projectId,
    command: 'plan',
    planOptions: {
      mode: 'targeted',
      targets: [address]
    }
  }, window)
  const project = getProject(profileName, projectId, connection)
  const planSummary = project?.lastPlanSummary ?? emptyPlanSummary()
  const matchingChanges = (project?.planChanges ?? []).filter((change) => change.address === address && change.actionLabel !== 'no-op')
  const { status, summary } = summarizeValidation(address, log, planSummary, matchingChanges)

  return {
    checkedAt: new Date().toISOString(),
    projectId: codegen.projectId,
    projectName: codegen.projectName,
    address,
    status,
    summary,
    log,
    planSummary,
    matchingChanges
  }
}
