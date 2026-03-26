import type {
  TerraformCliInfo,
  TerraformCommandLog,
  TerraformCommandRequest,
  TerraformDriftReport,
  TerraformMissingVarsResult,
  TerraformProject,
  TerraformProjectListItem
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

export async function listProjects(profileName: string): Promise<TerraformProjectListItem[]> {
  return unwrap(await bridge().listProjects(profileName) as Wrapped<TerraformProjectListItem[]>)
}

export async function getProject(profileName: string, projectId: string): Promise<TerraformProject> {
  return unwrap(await bridge().getProject(profileName, projectId) as Wrapped<TerraformProject>)
}

export async function getDrift(profileName: string, projectId: string, connection: { profile: string; region: string }): Promise<TerraformDriftReport> {
  return unwrap(await bridge().getDrift(profileName, projectId, connection) as Wrapped<TerraformDriftReport>)
}

export async function chooseProjectDirectory(): Promise<string> {
  return unwrap(await bridge().chooseProjectDirectory() as Wrapped<string>)
}

export async function chooseVarFile(): Promise<string> {
  return unwrap(await bridge().chooseVarFile() as Wrapped<string>)
}

export async function addProject(profileName: string, rootPath: string): Promise<TerraformProject> {
  return unwrap(await bridge().addProject(profileName, rootPath) as Wrapped<TerraformProject>)
}

export async function renameProject(profileName: string, projectId: string, name: string): Promise<TerraformProject> {
  return unwrap(await bridge().renameProject(profileName, projectId, name) as Wrapped<TerraformProject>)
}

export async function removeProject(profileName: string, projectId: string): Promise<void> {
  return unwrap(await bridge().removeProject(profileName, projectId) as Wrapped<void>)
}

export async function reloadProject(profileName: string, projectId: string): Promise<TerraformProject> {
  return unwrap(await bridge().reloadProject(profileName, projectId) as Wrapped<TerraformProject>)
}

export async function getSelectedProjectId(profileName: string): Promise<string> {
  return unwrap(await bridge().getSelectedProjectId(profileName) as Wrapped<string>)
}

export async function setSelectedProjectId(profileName: string, projectId: string): Promise<void> {
  return unwrap(await bridge().setSelectedProjectId(profileName, projectId) as Wrapped<void>)
}

export async function updateInputs(profileName: string, projectId: string, inputs: Record<string, unknown>, varFile?: string): Promise<TerraformProject> {
  return unwrap(await bridge().updateInputs(profileName, projectId, inputs, varFile) as Wrapped<TerraformProject>)
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

export function subscribe(listener: (event: unknown) => void): void {
  bridge().subscribe(listener)
}

export function unsubscribe(listener: (event: unknown) => void): void {
  bridge().unsubscribe(listener)
}
