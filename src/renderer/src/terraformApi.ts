import type {
  AwsConnection,
  TerraformAdoptionCodegenResult,
  ObservabilityPostureReport,
  TerraformAdoptionDetectionResult,
  TerraformAdoptionImportExecutionResult,
  TerraformAdoptionValidationResult,
  TerraformAdoptionMappingResult,
  TerraformAdoptionTarget,
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

type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string }

function bridge() {
  if (!(window as unknown as Record<string, unknown>).terraformWorkspace) {
    throw new Error('Terraform preload bridge did not load.')
  }
  return (window as unknown as { terraformWorkspace: Record<string, (...args: unknown[]) => unknown> }).terraformWorkspace
}

function unwrap<T>(result: Wrapped<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export async function detectCli(): Promise<TerraformCliInfo> {
  return unwrap(await bridge().detectCli() as Wrapped<TerraformCliInfo>)
}

export async function getCliInfo(): Promise<TerraformCliInfo> {
  return unwrap(await bridge().getCliInfo() as Wrapped<TerraformCliInfo>)
}

export async function setCliKind(kind: 'terraform' | 'opentofu'): Promise<TerraformCliInfo> {
  return unwrap(await bridge().setCliKind(kind) as Wrapped<TerraformCliInfo>)
}

export async function listProjects(profileName: string, connection?: AwsConnection): Promise<TerraformProjectListItem[]> {
  return unwrap(await bridge().listProjects(profileName, connection) as Wrapped<TerraformProjectListItem[]>)
}

export async function getProject(profileName: string, projectId: string, connection?: AwsConnection): Promise<TerraformProject> {
  return unwrap(await bridge().getProject(profileName, projectId, connection) as Wrapped<TerraformProject>)
}

export async function getDrift(
  profileName: string,
  projectId: string,
  connection: { profile: string; region: string },
  options?: { forceRefresh?: boolean }
): Promise<TerraformDriftReport> {
  return unwrap(await bridge().getDrift(profileName, projectId, connection, options) as Wrapped<TerraformDriftReport>)
}

export async function getObservabilityReport(profileName: string, projectId: string, connection: { profile: string; region: string }): Promise<ObservabilityPostureReport> {
  return unwrap(await bridge().getObservabilityReport(profileName, projectId, connection) as Wrapped<ObservabilityPostureReport>)
}

export async function detectAdoption(
  profileName: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): Promise<TerraformAdoptionDetectionResult> {
  return unwrap(await bridge().detectAdoption(profileName, connection, target) as Wrapped<TerraformAdoptionDetectionResult>)
}

export async function mapAdoption(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): Promise<TerraformAdoptionMappingResult> {
  return unwrap(await bridge().mapAdoption(profileName, projectId, connection, target) as Wrapped<TerraformAdoptionMappingResult>)
}

export async function generateAdoptionCode(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): Promise<TerraformAdoptionCodegenResult> {
  return unwrap(await bridge().generateAdoptionCode(profileName, projectId, connection, target) as Wrapped<TerraformAdoptionCodegenResult>)
}

export async function executeAdoptionImport(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): Promise<TerraformAdoptionImportExecutionResult> {
  return unwrap(await bridge().executeAdoptionImport(profileName, projectId, connection, target) as Wrapped<TerraformAdoptionImportExecutionResult>)
}

export async function validateAdoptionImport(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): Promise<TerraformAdoptionValidationResult> {
  return unwrap(await bridge().validateAdoptionImport(profileName, projectId, connection, target) as Wrapped<TerraformAdoptionValidationResult>)
}

export async function chooseProjectDirectory(): Promise<string> {
  return unwrap(await bridge().chooseProjectDirectory() as Wrapped<string>)
}

export async function chooseVarFile(): Promise<string> {
  return unwrap(await bridge().chooseVarFile() as Wrapped<string>)
}

export async function addProject(profileName: string, rootPath: string, connection?: AwsConnection): Promise<TerraformProject> {
  return unwrap(await bridge().addProject(profileName, rootPath, connection) as Wrapped<TerraformProject>)
}

export async function renameProject(profileName: string, projectId: string, name: string): Promise<TerraformProject> {
  return unwrap(await bridge().renameProject(profileName, projectId, name) as Wrapped<TerraformProject>)
}

export async function openProjectInVsCode(projectPath: string): Promise<void> {
  return unwrap(await bridge().openProjectInVsCode(projectPath) as Wrapped<void>)
}

export async function removeProject(profileName: string, projectId: string): Promise<void> {
  return unwrap(await bridge().removeProject(profileName, projectId) as Wrapped<void>)
}

export async function reloadProject(profileName: string, projectId: string, connection?: AwsConnection): Promise<TerraformProject> {
  return unwrap(await bridge().reloadProject(profileName, projectId, connection) as Wrapped<TerraformProject>)
}

export async function selectWorkspace(profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection): Promise<TerraformProject> {
  return unwrap(await bridge().selectWorkspace(profileName, projectId, workspaceName, connection) as Wrapped<TerraformProject>)
}

export async function createWorkspace(profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection): Promise<TerraformProject> {
  return unwrap(await bridge().createWorkspace(profileName, projectId, workspaceName, connection) as Wrapped<TerraformProject>)
}

export async function deleteWorkspace(profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection): Promise<TerraformProject> {
  return unwrap(await bridge().deleteWorkspace(profileName, projectId, workspaceName, connection) as Wrapped<TerraformProject>)
}

export async function getSelectedProjectId(profileName: string): Promise<string> {
  return unwrap(await bridge().getSelectedProjectId(profileName) as Wrapped<string>)
}

export async function setSelectedProjectId(profileName: string, projectId: string): Promise<void> {
  return unwrap(await bridge().setSelectedProjectId(profileName, projectId) as Wrapped<void>)
}

export async function updateInputs(profileName: string, projectId: string, inputConfig: TerraformInputConfiguration, connection?: AwsConnection): Promise<TerraformProject> {
  return unwrap(await bridge().updateInputs(profileName, projectId, inputConfig, connection) as Wrapped<TerraformProject>)
}

export async function getMissingRequiredInputs(profileName: string, projectId: string): Promise<string[]> {
  return unwrap(await bridge().getMissingRequiredInputs(profileName, projectId) as Wrapped<string[]>)
}

export async function validateProjectInputs(profileName: string, projectId: string, connection?: AwsConnection): Promise<TerraformInputValidationResult> {
  return unwrap(await bridge().validateProjectInputs(profileName, projectId, connection) as Wrapped<TerraformInputValidationResult>)
}

export async function listCommandLogs(projectId: string): Promise<TerraformCommandLog[]> {
  return unwrap(await bridge().listCommandLogs(projectId) as Wrapped<TerraformCommandLog[]>)
}

export async function runCommand(request: TerraformCommandRequest): Promise<TerraformCommandLog> {
  return unwrap(await bridge().runCommand(request) as Wrapped<TerraformCommandLog>)
}

export async function hasSavedPlan(projectId: string): Promise<boolean> {
  return unwrap(await bridge().hasSavedPlan(projectId) as Wrapped<boolean>)
}

export async function clearSavedPlan(projectId: string): Promise<void> {
  return unwrap(await bridge().clearSavedPlan(projectId) as Wrapped<void>)
}

export async function detectMissingVars(output: string): Promise<TerraformMissingVarsResult> {
  return unwrap(await bridge().detectMissingVars(output) as Wrapped<TerraformMissingVarsResult>)
}

export async function listRunHistory(filter?: TerraformRunHistoryFilter): Promise<TerraformRunRecord[]> {
  return unwrap(await bridge().listRunHistory(filter) as Wrapped<TerraformRunRecord[]>)
}

export async function getRunOutput(runId: string): Promise<string> {
  return unwrap(await bridge().getRunOutput(runId) as Wrapped<string>)
}

export async function deleteRunRecord(runId: string): Promise<void> {
  return unwrap(await bridge().deleteRunRecord(runId) as Wrapped<void>)
}

export async function detectGovernanceTools(
  tfCliPath?: string,
  cliLabel?: string,
  cliKind?: 'terraform' | 'opentofu' | ''
): Promise<TerraformGovernanceToolkit> {
  return unwrap(await bridge().detectGovernanceTools(tfCliPath, cliLabel, cliKind) as Wrapped<TerraformGovernanceToolkit>)
}

export async function getGovernanceToolkit(): Promise<TerraformGovernanceToolkit> {
  return unwrap(await bridge().getGovernanceToolkit() as Wrapped<TerraformGovernanceToolkit>)
}

export async function runGovernanceChecks(profileName: string, projectId: string, connection?: AwsConnection): Promise<TerraformGovernanceReport> {
  return unwrap(await bridge().runGovernanceChecks(profileName, projectId, connection) as Wrapped<TerraformGovernanceReport>)
}

export async function getGovernanceReport(projectId: string): Promise<TerraformGovernanceReport | null> {
  return unwrap(await bridge().getGovernanceReport(projectId) as Wrapped<TerraformGovernanceReport | null>)
}

export function subscribe(listener: (event: unknown) => void): void {
  bridge().subscribe(listener)
}

export function unsubscribe(listener: (event: unknown) => void): void {
  bridge().unsubscribe(listener)
}
