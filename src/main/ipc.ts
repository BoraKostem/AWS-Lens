import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { dialog, ipcMain, shell, app, type BrowserWindow, type OpenDialogOptions } from 'electron'

import type {
  AppDiagnosticsActiveContext,
  AppDiagnosticsFailureInput,
  AppSecuritySummary,
  AppSettings,
  AwsConnection,
  Ec2ChosenSshKey,
  TerraformAdoptionTarget,
  TerraformCommandRequest,
  TerraformInputConfiguration,
  TerraformRunHistoryFilter
} from '@shared/types'
import { getAppSettings, resetAppSettings, updateAppSettings } from './appSettings'
import { importAwsConfigFile } from './aws/profiles'
import { getVisibleServiceCatalog } from './catalog'
import { exportDiagnosticsBundle } from './diagnostics'
import { recordDiagnosticsFailure, updateDiagnosticsActiveContext } from './diagnosticsState'
import { getEnvironmentHealthReport } from './environment'
import { exportEnterpriseAuditEvents, getEnterpriseSettings, listEnterpriseAuditEvents, setEnterpriseAccessMode } from './enterprise'
import { getVaultEntryCounts } from './localVault'
import { createHandlerWrapper, type OperationOptions } from './operations'
import { checkForAppUpdates, downloadAppUpdate, getReleaseInfo, installAppUpdate } from './releaseCheck'
import { importSshPrivateKeyToVault, stageVaultSshPrivateKey } from './sshKeyMaterial'
import { getSelectedProjectId, setSelectedProjectId } from './store'
import {
  addProject,
  clearSavedPlan,
  createProjectWorkspace,
  detectMissingVars,
  detectTerraformCli,
  setActiveTerraformCli,
  deleteProjectWorkspace,
  getCachedCliInfo,
  getCommandLogs,
  getMissingRequiredInputs,
  getProject,
  hasSavedPlan,
  listProjectSummaries,
  removeProject,
  renameProject,
  runProjectCommand,
  selectProjectWorkspace,
  updateProjectInputs,
  validateProjectInputs,
  getProjectContext
} from './terraform'
import { detectTerraformAdoption } from './terraformAdoption'
import { getTerraformDriftReport } from './terraformDrift'
import { listRunRecords, getRunOutput, deleteRunRecord } from './terraformHistoryStore'
import { detectGovernanceTools, getCachedGovernanceToolkit, runGovernanceChecks, getGovernanceReport } from './terraformGovernance'
import {
  addUserToGroup, attachGroupPolicy, attachRolePolicy, attachUserPolicy,
  createAccessKey, createGroup, createLoginProfile, createPolicy,
  createPolicyVersion, createRole, createUser, deleteAccessKey,
  deleteGroup, deleteLoginProfile, deletePolicy, deletePolicyVersion,
  deleteRole, deleteRoleInlinePolicy, deleteUser, deleteUserInlinePolicy,
  deleteUserMfaDevice, detachGroupPolicy, detachRolePolicy, detachUserPolicy,
  generateCredentialReport, getAccountSummary, getCredentialReport,
  getPolicyVersion, getRoleTrustPolicy, listAttachedGroupPolicies,
  listAttachedRolePolicies, listAttachedUserPolicies, listIamGroups,
  listIamPolicies, listIamRoles, listIamUsers, listPolicyVersions,
  listRoleInlinePolicies, listUserAccessKeys, listUserGroups,
  listUserInlinePolicies, listUserMfaDevices, putRoleInlinePolicy,
  putUserInlinePolicy, removeUserFromGroup, simulatePolicy,
  updateAccessKeyStatus, updateRoleTrustPolicy
} from './aws/iam'
import { generateTerraformObservabilityReport } from './aws/observabilityLab'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const execFileAsync = promisify(execFile)
const wrap: <T>(
  fn: () => Promise<T> | T,
  label?: string,
  options?: OperationOptions
) => Promise<HandlerResult<T>> = createHandlerWrapper('ipc', { timeoutMs: 60000 })

function normalizeKeyName(value: string): string {
  return value.trim().toLowerCase().replace(/\.pem$|\.ppk$|\.key$/g, '')
}

async function listLocalSshKeySuggestions(preferredKeyName = ''): Promise<Array<{
  privateKeyPath: string
  publicKeyPath: string
  label: string
  source: 'matched-key-name' | 'discovered'
  keyNameMatch: boolean
  hasPublicKey: boolean
}>> {
  const sshDir = path.join(app.getPath('home'), '.ssh')
  const preferred = normalizeKeyName(preferredKeyName)

  let entries: Array<{ isFile: () => boolean; name: string }>
  try {
    entries = (await fs.readdir(sshDir, { withFileTypes: true, encoding: 'utf8' })).map((entry) => ({
      isFile: () => entry.isFile(),
      name: entry.name
    }))
  } catch {
    return []
  }

  const ignoredNames = new Set(['authorized_keys', 'config', 'known_hosts', 'known_hosts.old'])
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith('.pub'))
    .filter((name) => !ignoredNames.has(name))
    .filter((name) => {
      const extension = path.extname(name).toLowerCase()

      if (extension) {
        return extension === '.pem' || extension === '.ppk' || extension === '.key'
      }

      return name.startsWith('id_') || name.includes('aws') || name.includes('ssh')
    })

  const suggestions = await Promise.all(candidates.map(async (name) => {
    const privateKeyPath = path.join(sshDir, name)
    const publicKeyPath = `${privateKeyPath}.pub`
    const hasPublicKey = await fs.access(publicKeyPath).then(() => true).catch(() => false)
    const keyNameMatch = preferred.length > 0 && normalizeKeyName(name) === preferred

    return {
      privateKeyPath,
      publicKeyPath,
      label: keyNameMatch ? `${name} (matches ${preferredKeyName})` : name,
      source: keyNameMatch ? 'matched-key-name' as const : 'discovered' as const,
      keyNameMatch,
      hasPublicKey
    }
  }))

  return suggestions.sort((left, right) => {
    if (left.keyNameMatch !== right.keyNameMatch) {
      return left.keyNameMatch ? -1 : 1
    }

    if (left.hasPublicKey !== right.hasPublicKey) {
      return left.hasPublicKey ? -1 : 1
    }

    return left.label.localeCompare(right.label)
  })
}

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

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('services:list', async () => wrap(() => getVisibleServiceCatalog(getAppSettings().features)))
  ipcMain.handle('terraform:cli:detect', async () => wrap(() => detectTerraformCli()))
  ipcMain.handle('terraform:cli:info', async () => wrap(() => getCachedCliInfo()))
  ipcMain.handle('terraform:cli:set-kind', async (_event, kind: 'terraform' | 'opentofu') => wrap(() => setActiveTerraformCli(kind)))
  ipcMain.handle('terraform:projects:list', async (_event, profileName: string, connection?: AwsConnection) => wrap(() => listProjectSummaries(profileName, connection)))
  ipcMain.handle('terraform:projects:get', async (_event, profileName: string, projectId: string, connection?: AwsConnection) => wrap(() => getProject(profileName, projectId, connection)))
  ipcMain.handle('terraform:projects:selected:get', async (_event, profileName: string) => wrap(() => getSelectedProjectId(profileName)))
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
  ipcMain.handle('ec2:ssh:choose-key', async (): Promise<HandlerResult<Ec2ChosenSshKey | null>> =>
    wrap(async () => {
      const owner = getWindow()
      const dialogOptions: OpenDialogOptions = {
        title: 'Select SSH private key',
        properties: ['openFile'],
        filters: [
          { name: 'SSH Private Keys', extensions: ['pem', 'ppk', 'key'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
      if (result.canceled || !result.filePaths[0]) {
        return null
      }

      return importSshPrivateKeyToVault(result.filePaths[0])
    })
  )
  ipcMain.handle('ec2:ssh:list-key-suggestions', async (_event, preferredKeyName?: string) =>
    wrap(() => listLocalSshKeySuggestions(preferredKeyName))
  )
  ipcMain.handle('ec2:ssh:materialize-vault-key', async (_event, entryId: string) =>
    wrap(() => stageVaultSshPrivateKey(entryId))
  )
  ipcMain.handle('terraform:projects:add', async (_event, profileName: string, rootPath: string, connection?: AwsConnection) => wrap(() => addProject(profileName, rootPath, connection)))
  ipcMain.handle('terraform:projects:rename', async (_event, profileName: string, projectId: string, name: string) =>
    wrap(() => renameProject(profileName, projectId, name))
  )
  ipcMain.handle('terraform:projects:open-vscode', async (_event, projectPath: string) =>
    wrap(() => openInVisualStudioCode(projectPath))
  )
  ipcMain.handle('terraform:projects:remove', async (_event, profileName: string, projectId: string) => wrap(() => removeProject(profileName, projectId)))
  ipcMain.handle('terraform:projects:reload', async (_event, profileName: string, projectId: string, connection?: AwsConnection) => wrap(() => getProject(profileName, projectId, connection)))
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
    wrap(() => getTerraformDriftReport(profileName, projectId, connection, options))
  )
  ipcMain.handle('terraform:observability-report:get', async (_event, profileName: string, projectId: string, connection: AwsConnection) =>
    wrap(() => generateTerraformObservabilityReport(profileName, projectId, connection))
  )
  ipcMain.handle('terraform:adoption:detect', async (_event, profileName: string, connection: AwsConnection | undefined, target: TerraformAdoptionTarget) =>
    wrap(() => detectTerraformAdoption(profileName, connection, target))
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
  ipcMain.handle('terraform:logs:list', async (_event, projectId: string) => wrap(() => getCommandLogs(projectId)))
  ipcMain.handle('terraform:command:run', async (_event, request: TerraformCommandRequest) =>
    // Terraform commands already enforce their own process-level timeout. Disabling
    // the outer IPC wrapper timeout avoids false failures while long-running
    // apply/destroy operations continue streaming progress events.
    wrap(() => runProjectCommand(request, getWindow()), 'terraform:command:run', { timeoutMs: 0 })
  )
  ipcMain.handle('terraform:plan:has-saved', async (_event, projectId: string) => wrap(() => hasSavedPlan(projectId)))
  ipcMain.handle('terraform:plan:clear', async (_event, projectId: string) => wrap(() => clearSavedPlan(projectId)))
  ipcMain.handle('terraform:detect-missing-vars', async (_event, output: string) => wrap(() => detectMissingVars(output)))
  ipcMain.handle('terraform:history:list', async (_event, filter?: TerraformRunHistoryFilter) => wrap(() => listRunRecords(filter)))
  ipcMain.handle('terraform:history:get-output', async (_event, runId: string) => wrap(() => getRunOutput(runId)))
  ipcMain.handle('terraform:history:delete', async (_event, runId: string) => wrap(() => deleteRunRecord(runId)))
  ipcMain.handle('terraform:governance:detect-tools', async (_event, tfCliPath?: string, cliLabel?: string, cliKind?: 'terraform' | 'opentofu' | '') =>
    wrap(() => detectGovernanceTools(tfCliPath, cliLabel, cliKind))
  )
  ipcMain.handle('terraform:governance:toolkit', async () => wrap(() => getCachedGovernanceToolkit()))
  ipcMain.handle('terraform:governance:run-checks', async (_event, profileName: string, projectId: string, connection?: AwsConnection) =>
    wrap(() => {
      const ctx = getProjectContext(profileName, projectId, connection)
      return detectGovernanceTools(ctx.tfCliPath, ctx.tfCliLabel, ctx.tfCliKind)
        .then(() => runGovernanceChecks(projectId, ctx.rootPath, ctx.env))
    })
  )
  ipcMain.handle('terraform:governance:get-report', async (_event, projectId: string) => wrap(() => getGovernanceReport(projectId)))
  ipcMain.handle('shell:open-external', async (_event, url: string) => wrap(() => shell.openExternal(url)))
  ipcMain.handle('shell:open-path', async (_event, targetPath: string) => wrap(() => shell.openPath(targetPath)))
  ipcMain.handle('app:release-info', async () => wrap(() => getReleaseInfo()))
  ipcMain.handle('app:settings:get', async () => wrap(() => getAppSettings()))
  ipcMain.handle('app:settings:update', async (_event, update: Partial<AppSettings>) => wrap(() => updateAppSettings(update)))
  ipcMain.handle('app:settings:reset', async () => wrap(() => resetAppSettings()))
  ipcMain.handle('app:security-summary', async () => wrap<AppSecuritySummary>(() => ({
    vaultEntryCounts: getVaultEntryCounts()
  })))
  ipcMain.handle('app:environment-health', async () => wrap(() => getEnvironmentHealthReport()))
  ipcMain.handle('app:update:check', async () => wrap(() => checkForAppUpdates()))
  ipcMain.handle('app:update:download', async () => wrap(() => downloadAppUpdate()))
  ipcMain.handle('app:update:install', async () => wrap(() => installAppUpdate()))
  ipcMain.handle('app:export-diagnostics', async () => wrap(() => exportDiagnosticsBundle(getWindow())))
  ipcMain.handle('app:diagnostics:set-active-context', async (_event, context: AppDiagnosticsActiveContext): Promise<HandlerResult<null>> => {
    updateDiagnosticsActiveContext(context)
    return { ok: true, data: null }
  })
  ipcMain.handle('app:diagnostics:record-failure', async (_event, input: AppDiagnosticsFailureInput): Promise<HandlerResult<null>> => {
    recordDiagnosticsFailure(input)
    return { ok: true, data: null }
  })
  ipcMain.handle('enterprise:get-settings', async () => wrap(() => getEnterpriseSettings()))
  ipcMain.handle('enterprise:set-access-mode', async (_event, accessMode: 'read-only' | 'operator') =>
    wrap(() => setEnterpriseAccessMode(accessMode))
  )
  ipcMain.handle('enterprise:audit:list', async () => wrap(() => listEnterpriseAuditEvents()))
  ipcMain.handle('enterprise:audit:export', async () => wrap(() => exportEnterpriseAuditEvents(getWindow())))

  /* ── AWS profile import ─────────────────────────────────── */
  ipcMain.handle('profiles:choose-and-import', async () =>
    wrap(async () => {
      const owner = getWindow()
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: 'Select AWS config or credentials file',
            properties: ['openFile'],
            filters: [{ name: 'All Files', extensions: ['*'] }]
          })
        : await dialog.showOpenDialog({
            title: 'Select AWS config or credentials file',
            properties: ['openFile'],
            filters: [{ name: 'All Files', extensions: ['*'] }]
          })
      if (result.canceled || !result.filePaths[0]) {
        return []
      }
      return importAwsConfigFile(result.filePaths[0])
    })
  )

  /* ── AWS core ────────────────────────────────────────────── */

  /* ── IAM ─────────────────────────────────────────────────── */
  ipcMain.handle('iam:list-users', async (_e, c: AwsConnection) => wrap(() => listIamUsers(c)))
  ipcMain.handle('iam:list-groups', async (_e, c: AwsConnection) => wrap(() => listIamGroups(c)))
  ipcMain.handle('iam:list-roles', async (_e, c: AwsConnection) => wrap(() => listIamRoles(c)))
  ipcMain.handle('iam:list-policies', async (_e, c: AwsConnection, scope: string) => wrap(() => listIamPolicies(c, scope)))
  ipcMain.handle('iam:account-summary', async (_e, c: AwsConnection) => wrap(() => getAccountSummary(c)))
  ipcMain.handle('iam:list-access-keys', async (_e, c: AwsConnection, u: string) => wrap(() => listUserAccessKeys(c, u)))
  ipcMain.handle('iam:create-access-key', async (_e, c: AwsConnection, u: string) => wrap(() => createAccessKey(c, u)))
  ipcMain.handle('iam:delete-access-key', async (_e, c: AwsConnection, u: string, k: string) => wrap(() => deleteAccessKey(c, u, k)))
  ipcMain.handle('iam:update-access-key-status', async (_e, c: AwsConnection, u: string, k: string, s: string) => wrap(() => updateAccessKeyStatus(c, u, k, s)))
  ipcMain.handle('iam:list-mfa-devices', async (_e, c: AwsConnection, u: string) => wrap(() => listUserMfaDevices(c, u)))
  ipcMain.handle('iam:delete-mfa-device', async (_e, c: AwsConnection, u: string, sn: string) => wrap(() => deleteUserMfaDevice(c, u, sn)))
  ipcMain.handle('iam:list-attached-user-policies', async (_e, c: AwsConnection, u: string) => wrap(() => listAttachedUserPolicies(c, u)))
  ipcMain.handle('iam:list-user-inline-policies', async (_e, c: AwsConnection, u: string) => wrap(() => listUserInlinePolicies(c, u)))
  ipcMain.handle('iam:attach-user-policy', async (_e, c: AwsConnection, u: string, a: string) => wrap(() => attachUserPolicy(c, u, a)))
  ipcMain.handle('iam:detach-user-policy', async (_e, c: AwsConnection, u: string, a: string) => wrap(() => detachUserPolicy(c, u, a)))
  ipcMain.handle('iam:put-user-inline-policy', async (_e, c: AwsConnection, u: string, n: string, d: string) => wrap(() => putUserInlinePolicy(c, u, n, d)))
  ipcMain.handle('iam:delete-user-inline-policy', async (_e, c: AwsConnection, u: string, n: string) => wrap(() => deleteUserInlinePolicy(c, u, n)))
  ipcMain.handle('iam:list-user-groups', async (_e, c: AwsConnection, u: string) => wrap(() => listUserGroups(c, u)))
  ipcMain.handle('iam:add-user-to-group', async (_e, c: AwsConnection, u: string, g: string) => wrap(() => addUserToGroup(c, u, g)))
  ipcMain.handle('iam:remove-user-from-group', async (_e, c: AwsConnection, u: string, g: string) => wrap(() => removeUserFromGroup(c, u, g)))
  ipcMain.handle('iam:create-user', async (_e, c: AwsConnection, u: string) => wrap(() => createUser(c, u)))
  ipcMain.handle('iam:delete-user', async (_e, c: AwsConnection, u: string) => wrap(() => deleteUser(c, u)))
  ipcMain.handle('iam:create-login-profile', async (_e, c: AwsConnection, u: string, pw: string, r: boolean) => wrap(() => createLoginProfile(c, u, pw, r)))
  ipcMain.handle('iam:delete-login-profile', async (_e, c: AwsConnection, u: string) => wrap(() => deleteLoginProfile(c, u)))
  ipcMain.handle('iam:list-attached-role-policies', async (_e, c: AwsConnection, r: string) => wrap(() => listAttachedRolePolicies(c, r)))
  ipcMain.handle('iam:list-role-inline-policies', async (_e, c: AwsConnection, r: string) => wrap(() => listRoleInlinePolicies(c, r)))
  ipcMain.handle('iam:get-role-trust-policy', async (_e, c: AwsConnection, r: string) => wrap(() => getRoleTrustPolicy(c, r)))
  ipcMain.handle('iam:update-role-trust-policy', async (_e, c: AwsConnection, r: string, d: string) => wrap(() => updateRoleTrustPolicy(c, r, d)))
  ipcMain.handle('iam:attach-role-policy', async (_e, c: AwsConnection, r: string, a: string) => wrap(() => attachRolePolicy(c, r, a)))
  ipcMain.handle('iam:detach-role-policy', async (_e, c: AwsConnection, r: string, a: string) => wrap(() => detachRolePolicy(c, r, a)))
  ipcMain.handle('iam:put-role-inline-policy', async (_e, c: AwsConnection, r: string, n: string, d: string) => wrap(() => putRoleInlinePolicy(c, r, n, d)))
  ipcMain.handle('iam:delete-role-inline-policy', async (_e, c: AwsConnection, r: string, n: string) => wrap(() => deleteRoleInlinePolicy(c, r, n)))
  ipcMain.handle('iam:create-role', async (_e, c: AwsConnection, r: string, tp: string, desc: string) => wrap(() => createRole(c, r, tp, desc)))
  ipcMain.handle('iam:delete-role', async (_e, c: AwsConnection, r: string) => wrap(() => deleteRole(c, r)))
  ipcMain.handle('iam:list-attached-group-policies', async (_e, c: AwsConnection, g: string) => wrap(() => listAttachedGroupPolicies(c, g)))
  ipcMain.handle('iam:attach-group-policy', async (_e, c: AwsConnection, g: string, a: string) => wrap(() => attachGroupPolicy(c, g, a)))
  ipcMain.handle('iam:detach-group-policy', async (_e, c: AwsConnection, g: string, a: string) => wrap(() => detachGroupPolicy(c, g, a)))
  ipcMain.handle('iam:create-group', async (_e, c: AwsConnection, g: string) => wrap(() => createGroup(c, g)))
  ipcMain.handle('iam:delete-group', async (_e, c: AwsConnection, g: string) => wrap(() => deleteGroup(c, g)))
  ipcMain.handle('iam:get-policy-version', async (_e, c: AwsConnection, a: string, v: string) => wrap(() => getPolicyVersion(c, a, v)))
  ipcMain.handle('iam:list-policy-versions', async (_e, c: AwsConnection, a: string) => wrap(() => listPolicyVersions(c, a)))
  ipcMain.handle('iam:create-policy-version', async (_e, c: AwsConnection, a: string, d: string, s: boolean) => wrap(() => createPolicyVersion(c, a, d, s)))
  ipcMain.handle('iam:delete-policy-version', async (_e, c: AwsConnection, a: string, v: string) => wrap(() => deletePolicyVersion(c, a, v)))
  ipcMain.handle('iam:create-policy', async (_e, c: AwsConnection, n: string, d: string, desc: string) => wrap(() => createPolicy(c, n, d, desc)))
  ipcMain.handle('iam:delete-policy', async (_e, c: AwsConnection, a: string) => wrap(() => deletePolicy(c, a)))
  ipcMain.handle('iam:simulate-policy', async (_e, c: AwsConnection, a: string, acts: string[], res: string[]) => wrap(() => simulatePolicy(c, a, acts, res)))
  ipcMain.handle('iam:generate-credential-report', async (_e, c: AwsConnection) => wrap(() => generateCredentialReport(c)))
  ipcMain.handle('iam:get-credential-report', async (_e, c: AwsConnection) => wrap(() => getCredentialReport(c)))
}
