import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { dialog, ipcMain, type BrowserWindow } from 'electron'

import type {
  AwsConnection,
  TerraformAdoptionTarget,
  TerraformCommandRequest,
  TerraformInputConfiguration,
  TerraformRunHistoryFilter
} from '@shared/types'
import { createHandlerWrapper, type OperationOptions } from './operations'
import { getSelectedProjectId, setSelectedProjectId } from './store'
import {
  addProject,
  cancelProjectCommand,
  clearSavedPlan,
  createProjectWorkspace,
  deleteProjectWorkspace,
  detectMissingVars,
  detectTerraformCli,
  getCachedCliInfo,
  getCommandLogs,
  getMissingRequiredInputs,
  getProject,
  getProjectContext,
  hasSavedPlan,
  listProjectSummaries,
  removeProject,
  renameProject,
  runProjectCommand,
  selectProjectWorkspace,
  setActiveTerraformCli,
  updateProjectInputs,
  validateProjectInputs
} from './terraform'
import { detectTerraformAdoption } from './terraformAdoption'
import { generateTerraformAdoptionCode } from './terraformAdoptionCodegen'
import {
  applyTerraformAdoptionCode,
  buildTerraformAdoptionImportExecutionResult
} from './terraformAdoptionExecution'
import { mapTerraformAdoption } from './terraformAdoptionMapping'
import { validateTerraformAdoptionImport } from './terraformAdoptionValidation'
import { generateAzureTerraformObservabilityReport, getAzureTerraformDriftReport } from './azure'
import { getTerraformDriftReport as getAwsTerraformDriftReport } from './terraformDrift'
import { detectGovernanceTools, getCachedGovernanceToolkit, getGovernanceReport, runGovernanceChecks } from './terraformGovernance'
import { deleteRunRecord, getRunOutput, listRunRecords } from './terraformHistoryStore'
import { generateTerraformObservabilityReport as generateAwsTerraformObservabilityReport } from './aws/observabilityLab'
import { generateGcpTerraformObservabilityReport, getGcpTerraformDriftReport } from './gcpTerraformInsights'
import { getDriftProvider, resolveDriftProviderId } from './terraformDriftProvider'
import { getDriftSchedule, updateDriftSchedule, runScheduledDriftCheck, initDriftScheduler } from './terraformDriftScheduler'
import type { TerraformDriftSchedule } from '@shared/types'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const execFileAsync = promisify(execFile)
const wrap: <T>(
  fn: () => Promise<T> | T,
  label?: string,
  options?: OperationOptions
) => Promise<HandlerResult<T>> = createHandlerWrapper('terraform-ipc', { timeoutMs: 60000 })

let terraformIpcHandlersRegistered = false

async function openInVisualStudioCode(targetPath: string): Promise<void> {
  const normalizedPath = path.resolve(targetPath)
  const candidates: Array<{ command: string; args: string[] }> = []

  if (process.platform === 'win32') {
    candidates.push(
      { command: 'cmd.exe', args: ['/c', 'code', '-r', normalizedPath] },
      { command: 'cmd.exe', args: ['/c', 'code.cmd', '-r', normalizedPath] }
    )

    const localAppData = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
    candidates.push(
      { command: path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'), args: ['-r', normalizedPath] },
      { command: path.join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'), args: ['-r', normalizedPath] }
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      { command: 'code', args: ['-r', normalizedPath] },
      { command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', args: ['-r', normalizedPath] }
    )
  } else {
    candidates.push(
      { command: 'code', args: ['-r', normalizedPath] },
      { command: '/snap/bin/code', args: ['-r', normalizedPath] },
      { command: '/usr/bin/code', args: ['-r', normalizedPath] }
    )
  }

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.command, candidate.args, { windowsHide: true })
      return
    } catch {
      continue
    }
  }

  throw new Error('VS Code could not be launched. Install it and ensure the `code` command is available, or install the standard desktop app.')
}

export function registerTerraformIpcHandlers(getWindow: () => BrowserWindow | null): void {
  if (terraformIpcHandlersRegistered) {
    return
  }
  terraformIpcHandlersRegistered = true

  ipcMain.handle('terraform:cli:detect', async () => wrap(() => detectTerraformCli()))
  ipcMain.handle('terraform:cli:info', async () => wrap(() => getCachedCliInfo()))
  ipcMain.handle('terraform:cli:set-kind', async (_event, kind: 'terraform' | 'opentofu') =>
    wrap(() => setActiveTerraformCli(kind))
  )
  ipcMain.handle('terraform:projects:list', async (_event, profileName: string, connection?: AwsConnection) =>
    wrap(() => listProjectSummaries(profileName, connection))
  )
  ipcMain.handle('terraform:projects:get', async (_event, profileName: string, projectId: string, connection?: AwsConnection) =>
    wrap(() => getProject(profileName, projectId, connection))
  )
  ipcMain.handle('terraform:projects:selected:get', async (_event, profileName: string) =>
    wrap(() => getSelectedProjectId(profileName))
  )
  ipcMain.handle('terraform:projects:selected:set', async (_event, profileName: string, projectId: string) =>
    wrap(() => setSelectedProjectId(profileName, projectId))
  )
  ipcMain.handle('terraform:projects:choose-directory', async () =>
    wrap(async () => {
      const owner = getWindow()
      const result = owner
        ? await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? '' : result.filePaths[0] ?? ''
    })
  )
  ipcMain.handle('terraform:projects:choose-file', async () =>
    wrap(async () => {
      const owner = getWindow()
      const result = owner
        ? await dialog.showOpenDialog(owner, { properties: ['openFile'], filters: [{ name: 'Terraform Vars', extensions: ['tfvars', 'json', 'tfvars.json'] }] })
        : await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Terraform Vars', extensions: ['tfvars', 'json', 'tfvars.json'] }] })
      return result.canceled ? '' : result.filePaths[0] ?? ''
    })
  )
  ipcMain.handle('terraform:projects:add', async (_event, profileName: string, rootPath: string, connection?: AwsConnection) =>
    wrap(() => addProject(profileName, path.resolve(rootPath), connection))
  )
  ipcMain.handle('terraform:projects:rename', async (_event, profileName: string, projectId: string, name: string) =>
    wrap(() => renameProject(profileName, projectId, name))
  )
  ipcMain.handle('terraform:projects:open-vscode', async (_event, projectPath: string) =>
    wrap(() => openInVisualStudioCode(path.resolve(projectPath)))
  )
  ipcMain.handle('terraform:projects:remove', async (_event, profileName: string, projectId: string) =>
    wrap(() => removeProject(profileName, projectId))
  )
  ipcMain.handle('terraform:projects:reload', async (_event, profileName: string, projectId: string, connection?: AwsConnection) =>
    wrap(() => getProject(profileName, projectId, connection))
  )
  ipcMain.handle('terraform:workspace:select', async (_event, profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) =>
    wrap(() => selectProjectWorkspace(profileName, projectId, workspaceName, connection))
  )
  ipcMain.handle('terraform:workspace:create', async (_event, profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) =>
    wrap(() => createProjectWorkspace(profileName, projectId, workspaceName, connection))
  )
  ipcMain.handle('terraform:workspace:delete', async (_event, profileName: string, projectId: string, workspaceName: string, connection?: AwsConnection) =>
    wrap(() => deleteProjectWorkspace(profileName, projectId, workspaceName, connection))
  )
  ipcMain.handle('terraform:drift:get', async (_event, profileName: string, projectId: string, connection: AwsConnection, options?: { forceRefresh?: boolean }) =>
    wrap(() => {
      const providerId = resolveDriftProviderId(profileName, connection)
      return getDriftProvider(providerId).getDriftReport(profileName, projectId, connection, options)
    })
  )
  ipcMain.handle('terraform:observability-report:get', async (_event, profileName: string, projectId: string, connection: AwsConnection) =>
    wrap(() => {
      if (connection?.providerId === 'gcp' || profileName.startsWith('provider:gcp:terraform:')) {
        return generateGcpTerraformObservabilityReport(profileName, projectId, connection)
      }
      if (connection?.providerId === 'azure' || profileName.startsWith('provider:azure:terraform:')) {
        return generateAzureTerraformObservabilityReport(profileName, projectId, connection)
      }
      return generateAwsTerraformObservabilityReport(profileName, projectId, connection)
    })
  )
  ipcMain.handle('terraform:adoption:detect', async (_event, profileName: string, connection: AwsConnection | undefined, target: TerraformAdoptionTarget) =>
    wrap(() => detectTerraformAdoption(profileName, connection, target))
  )
  ipcMain.handle('terraform:adoption:map', async (_event, profileName: string, projectId: string, connection: AwsConnection | undefined, target: TerraformAdoptionTarget) =>
    wrap(() => mapTerraformAdoption(profileName, projectId, connection, target))
  )
  ipcMain.handle('terraform:adoption:codegen', async (_event, profileName: string, projectId: string, connection: AwsConnection | undefined, target: TerraformAdoptionTarget) =>
    wrap(() => generateTerraformAdoptionCode(profileName, projectId, connection, target))
  )
  ipcMain.handle('terraform:adoption:execute-import', async (_event, profileName: string, projectId: string, connection: AwsConnection | undefined, target: TerraformAdoptionTarget) =>
    wrap(async () => {
      const applyResult = await applyTerraformAdoptionCode(profileName, projectId, connection, target)
      const log = await runProjectCommand({
        profileName,
        connection,
        projectId,
        command: 'import',
        importAddress: applyResult.codegen.mapping.suggestedAddress,
        importId: applyResult.codegen.mapping.importId
      }, getWindow())
      return buildTerraformAdoptionImportExecutionResult(applyResult, log)
    })
  )
  ipcMain.handle('terraform:adoption:validate', async (_event, profileName: string, projectId: string, connection: AwsConnection | undefined, target: TerraformAdoptionTarget) =>
    wrap(() => validateTerraformAdoptionImport(profileName, projectId, connection, target, getWindow()))
  )
  ipcMain.handle('terraform:inputs:update', async (_event, profileName: string, projectId: string, inputConfig: TerraformInputConfiguration, connection?: AwsConnection) =>
    wrap(() => updateProjectInputs(profileName, projectId, inputConfig, connection))
  )
  ipcMain.handle('terraform:inputs:missing-required', async (_event, profileName: string, projectId: string) =>
    wrap(() => getMissingRequiredInputs(profileName, projectId))
  )
  ipcMain.handle('terraform:inputs:validate', async (_event, profileName: string, projectId: string, connection?: AwsConnection) =>
    wrap(() => validateProjectInputs(profileName, projectId, connection))
  )
  ipcMain.handle('terraform:logs:list', async (_event, projectId: string) =>
    wrap(() => getCommandLogs(projectId))
  )
  ipcMain.handle('terraform:command:run', async (_event, request: TerraformCommandRequest) =>
    wrap(() => runProjectCommand(request, getWindow()), 'terraform:command:run', { timeoutMs: 4 * 60 * 60 * 1000 })
  )
  ipcMain.handle('terraform:command:cancel', async (_event, projectId: string) =>
    wrap(() => cancelProjectCommand(projectId))
  )
  ipcMain.handle('terraform:plan:has-saved', async (_event, projectId: string) =>
    wrap(() => hasSavedPlan(projectId))
  )
  ipcMain.handle('terraform:plan:clear', async (_event, projectId: string) =>
    wrap(() => clearSavedPlan(projectId))
  )
  ipcMain.handle('terraform:detect-missing-vars', async (_event, output: string) =>
    wrap(() => detectMissingVars(output))
  )
  ipcMain.handle('terraform:history:list', async (_event, filter?: TerraformRunHistoryFilter) =>
    wrap(() => listRunRecords(filter))
  )
  ipcMain.handle('terraform:history:get-output', async (_event, runId: string) =>
    wrap(() => getRunOutput(runId))
  )
  ipcMain.handle('terraform:history:delete', async (_event, runId: string) =>
    wrap(() => deleteRunRecord(runId))
  )
  ipcMain.handle('terraform:governance:detect-tools', async (_event, tfCliPath?: string, cliLabel?: string, cliKind?: 'terraform' | 'opentofu' | '') =>
    wrap(() => detectGovernanceTools(tfCliPath, cliLabel, cliKind))
  )
  ipcMain.handle('terraform:governance:toolkit', async () =>
    wrap(() => getCachedGovernanceToolkit())
  )
  ipcMain.handle('terraform:governance:run-checks', async (_event, profileName: string, projectId: string, connection?: AwsConnection) =>
    wrap(() => {
      const ctx = getProjectContext(profileName, projectId, connection)
      return detectGovernanceTools(ctx.tfCliPath, ctx.tfCliLabel, ctx.tfCliKind)
        .then(() => runGovernanceChecks(projectId, ctx.rootPath, ctx.env))
    })
  )
  ipcMain.handle('terraform:governance:get-report', async (_event, projectId: string) =>
    wrap(() => getGovernanceReport(projectId))
  )

  // Drift scheduling handlers
  ipcMain.handle('terraform:drift:schedule:get', async () =>
    wrap(() => getDriftSchedule())
  )
  ipcMain.handle('terraform:drift:schedule:update', async (_event, update: Partial<TerraformDriftSchedule>) =>
    wrap(() => updateDriftSchedule(update))
  )
  ipcMain.handle('terraform:drift:schedule:run-now', async () =>
    wrap(() => runScheduledDriftCheck())
  )

  // Initialize drift scheduler with access to main window
  initDriftScheduler(getWindow)
}
