import type {
  TerraformCliInfo,
  TerraformCommandLog,
  TerraformCommandRequest,
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

export async function listProjects(): Promise<TerraformProjectListItem[]> {
  return unwrap(await bridge().listProjects() as Wrapped<TerraformProjectListItem[]>)
}

export async function getProject(projectId: string): Promise<TerraformProject> {
  return unwrap(await bridge().getProject(projectId) as Wrapped<TerraformProject>)
}

export async function chooseProjectDirectory(): Promise<string> {
  return unwrap(await bridge().chooseProjectDirectory() as Wrapped<string>)
}

export async function chooseVarFile(): Promise<string> {
  return unwrap(await bridge().chooseVarFile() as Wrapped<string>)
}

export async function addProject(rootPath: string): Promise<TerraformProject> {
  return unwrap(await bridge().addProject(rootPath) as Wrapped<TerraformProject>)
}

export async function renameProject(projectId: string, name: string): Promise<TerraformProject> {
  return unwrap(await bridge().renameProject(projectId, name) as Wrapped<TerraformProject>)
}

export async function removeProject(projectId: string): Promise<void> {
  return unwrap(await bridge().removeProject(projectId) as Wrapped<void>)
}

export async function reloadProject(projectId: string): Promise<TerraformProject> {
  return unwrap(await bridge().reloadProject(projectId) as Wrapped<TerraformProject>)
}

export async function getSelectedProjectId(): Promise<string> {
  return unwrap(await bridge().getSelectedProjectId() as Wrapped<string>)
}

export async function setSelectedProjectId(projectId: string): Promise<void> {
  return unwrap(await bridge().setSelectedProjectId(projectId) as Wrapped<void>)
}

export async function updateInputs(projectId: string, inputs: Record<string, unknown>, varFile?: string): Promise<TerraformProject> {
  return unwrap(await bridge().updateInputs(projectId, inputs, varFile) as Wrapped<TerraformProject>)
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
