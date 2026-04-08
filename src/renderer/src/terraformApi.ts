import type {
  AwsConnection,
  ObservabilityPostureReport,
  TerraformCliInfo,
  TerraformCommandLog,
  TerraformCommandRequest,
  TerraformDriftReport,
  TerraformGovernanceReport,
  TerraformGovernanceToolkit,
  TerraformInputConfiguration,
  TerraformInputValidationResult,
  TerraformMissingVarsResult,
  TerraformProject,
  TerraformProjectListItem,
  TerraformRunHistoryFilter,
  TerraformRunRecord
} from '@shared/types'
import { makeBridgeCall } from './bridgeUtils'

function getTerraformBridge() {
  if (!(window as unknown as Record<string, unknown>).terraformWorkspace) {
    throw new Error('Terraform preload bridge did not load.')
  }
  return (window as unknown as { terraformWorkspace: Record<string, (...args: unknown[]) => unknown> }).terraformWorkspace
}

const call = makeBridgeCall(getTerraformBridge)

export const detectCli = call<[], TerraformCliInfo>('detectCli')
export const getCliInfo = call<[], TerraformCliInfo>('getCliInfo')
export const setCliKind = call<[kind: 'terraform' | 'opentofu'], TerraformCliInfo>('setCliKind')
export const listProjects = call<[profileName: string, connection?: AwsConnection], TerraformProjectListItem[]>('listProjects')
export const getProject = call<[profileName: string, projectId: string, connection?: AwsConnection], TerraformProject>('getProject')
export const getDrift = call<[profileName: string, projectId: string, connection: { profile: string; region: string }, options?: { forceRefresh?: boolean }], TerraformDriftReport>('getDrift')
export const getObservabilityReport = call<[profileName: string, projectId: string, connection: { profile: string; region: string }], ObservabilityPostureReport>('getObservabilityReport')
export const chooseProjectDirectory = call<[], string>('chooseProjectDirectory')
export const chooseVarFile = call<[], string>('chooseVarFile')
export const addProject = call<[profileName: string, rootPath: string, connection?: AwsConnection], TerraformProject>('addProject')
export const renameProject = call<[profileName: string, projectId: string, name: string], TerraformProject>('renameProject')
export const openProjectInVsCode = call<[projectPath: string], void>('openProjectInVsCode')
export const removeProject = call<[profileName: string, projectId: string], void>('removeProject')
export const reloadProject = call<[profileName: string, projectId: string, connection?: AwsConnection], TerraformProject>('reloadProject')
export const selectWorkspace = call<[profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection], TerraformProject>('selectWorkspace')
export const createWorkspace = call<[profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection], TerraformProject>('createWorkspace')
export const deleteWorkspace = call<[profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection], TerraformProject>('deleteWorkspace')
export const getSelectedProjectId = call<[profileName: string], string>('getSelectedProjectId')
export const setSelectedProjectId = call<[profileName: string, projectId: string], void>('setSelectedProjectId')
export const updateInputs = call<[profileName: string, projectId: string, inputConfig: TerraformInputConfiguration, connection?: AwsConnection], TerraformProject>('updateInputs')
export const getMissingRequiredInputs = call<[profileName: string, projectId: string], string[]>('getMissingRequiredInputs')
export const validateProjectInputs = call<[profileName: string, projectId: string, connection?: AwsConnection], TerraformInputValidationResult>('validateProjectInputs')
export const listCommandLogs = call<[projectId: string], TerraformCommandLog[]>('listCommandLogs')
export const runCommand = call<[request: TerraformCommandRequest], TerraformCommandLog>('runCommand')
export const cancelCommand = call<[projectId: string], boolean>('cancelCommand')
export const hasSavedPlan = call<[projectId: string], boolean>('hasSavedPlan')
export const clearSavedPlan = call<[projectId: string], void>('clearSavedPlan')
export const detectMissingVars = call<[output: string], TerraformMissingVarsResult>('detectMissingVars')
export const listRunHistory = call<[filter?: TerraformRunHistoryFilter], TerraformRunRecord[]>('listRunHistory')
export const getRunOutput = call<[runId: string], string>('getRunOutput')
export const deleteRunRecord = call<[runId: string], void>('deleteRunRecord')
export const detectGovernanceTools = call<[tfCliPath?: string, cliLabel?: string, cliKind?: 'terraform' | 'opentofu' | ''], TerraformGovernanceToolkit>('detectGovernanceTools')
export const getGovernanceToolkit = call<[], TerraformGovernanceToolkit>('getGovernanceToolkit')
export const runGovernanceChecks = call<[profileName: string, projectId: string, connection?: AwsConnection], TerraformGovernanceReport>('runGovernanceChecks')
export const getGovernanceReport = call<[projectId: string], TerraformGovernanceReport | null>('getGovernanceReport')

// Non-standard: synchronous event subscription, not async calls
export function subscribe(listener: (event: unknown) => void): void {
  getTerraformBridge().subscribe(listener)
}

export function unsubscribe(listener: (event: unknown) => void): void {
  getTerraformBridge().unsubscribe(listener)
}
