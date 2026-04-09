import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { app, type BrowserWindow } from 'electron'

import type {
  TerraformActionRow,
  TerraformCliInfo,
  TerraformCliKind,
  TerraformCliOption,
  TerraformCommandLog,
  TerraformCommandRequest,
  TerraformGitChangedFile,
  TerraformGitCommitMetadata,
  TerraformGitStatus,
  TerraformInputConfiguration,
  TerraformInputValidationResult,
  TerraformPlanAction,
  TerraformPlanAttributeChange,
  TerraformDiagram,
  TerraformGraphEdge,
  TerraformGraphNode,
  TerraformMissingVarsResult,
  TerraformPlanChange,
  TerraformPlanCounts,
  TerraformPlanGroup,
  TerraformPlanOptions,
  TerraformPlanOptionsSummary,
  TerraformPlanSummary,
  TerraformProject,
  TerraformProjectEnvironmentMetadata,
  TerraformProjectInputRow,
  TerraformProjectInputsView,
  TerraformProjectListItem,
  TerraformProjectMetadata,
  TerraformProjectStatus,
  TerraformSavedPlanMetadata,
  TerraformResolvedRuntimeInputs,
  TerraformResourceInventoryItem,
  TerraformResourceRow,
  TerraformSecretReference,
  TerraformStateBackupSummary,
  TerraformStateLockInfo,
  TerraformS3BackendConfig,
  TerraformUnresolvedSecret,
  TerraformVariableLayer,
  TerraformVariableSet,
  TerraformWorkspaceSummary,
  TerraformVariableDefinition,
  AwsConnection
} from '@shared/types'
import { getProjects, setPreferredTerraformCliKind, setProjects } from './store'
import { resolveTerraformSecretReference } from './aws/terraformInputs'
import { executeOperation, OperationTimeoutError } from './operations'
import { getResolvedProcessEnv, resolveExecutablePath } from './shell'
import { getConnectionEnv } from './sessionHub'
import { saveRunRecord, updateRunRecord, redactArgs } from './terraformHistoryStore'
import { invalidateTerraformDriftReports } from './terraformDrift'
import { buildTerraformDiagram } from './terraformDiagramParser'
import type { TerraformRunRecord } from '@shared/types'
import { getPreferredTerraformCliKindSetting, listToolCommandCandidates } from './toolchain'
import { readAzureFoundationStore } from './azureFoundationStore'

/* ── Stored project shape (persistence) ───────────────────── */

type StoredProject = {
  id: string
  name: string
  rootPath: string
  varFile: string
  variables: Record<string, unknown>
  inputConfig?: TerraformInputConfiguration
  environment?: TerraformProjectEnvironmentMetadata
}

type ProjectEvent =
  | { type: 'started'; projectId: string; log: TerraformCommandLog }
  | { type: 'output'; projectId: string; logId: string; chunk: string }
  | { type: 'progress'; projectId: string; address: string; status: string; raw: string }
  | { type: 'completed'; projectId: string; log: TerraformCommandLog; project: TerraformProject | null }

const INPUTS_FILE = 'terraform-workspace.auto.tfvars.json'
const PLAN_FILE = '.terraform-workspace.tfplan'
const PLAN_METADATA_FILE = '.terraform-workspace.tfplan.meta.json'
const STATE_CACHE_FILE = '.terraform-workspace.state.json'
const STATE_BACKUP_LIMIT = 20
const COMMAND_LOG_CAP_PER_PROJECT = 100

const commandLogs = new Map<string, TerraformCommandLog[]>()
const savedPlanPaths = new Map<string, string>()
const activeDestructiveCommands = new Map<string, 'apply' | 'destroy'>()
const activeTerraformRuns = new Map<string, ActiveTerraformRun>()

type ActiveTerraformRun = {
  projectId: string
  logId: string
  command: TerraformCommandRequest['command']
  child: ChildProcessWithoutNullStreams | null
  cancelRequested: boolean
  cancelMessage: string
}

/* ── Helpers ──────────────────────────────────────────────── */

function emit(window: BrowserWindow | null, event: ProjectEvent): void {
  window?.webContents.send('terraform:event', event)
}

function readText(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8') } catch { return '' }
}

function parseJsonFile<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T } catch { return fallback }
}

function listTerraformFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return []
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tf'))
    .map((e) => path.join(rootPath, e.name))
}

function managedInputsPath(rootPath: string): string {
  return path.join(path.resolve(rootPath), INPUTS_FILE)
}

function temporaryStateVarFilePath(rootPath: string): string {
  return path.join(path.resolve(rootPath), 'terraform.tfvars.json')
}

function stateCachePath(rootPath: string): string {
  return path.join(path.resolve(rootPath), STATE_CACHE_FILE)
}

function planPath(rootPath: string): string {
  return path.join(path.resolve(rootPath), PLAN_FILE)
}

function planJsonPath(rootPath: string): string {
  return `${planPath(rootPath)}.json`
}

function planMetadataPath(rootPath: string): string {
  return path.join(rootPath, PLAN_METADATA_FILE)
}

function stateBackupDir(projectId: string): string {
  return path.join(app.getPath('userData'), 'terraform-state-backups', projectId)
}

function hasSavedPlanArtifacts(rootPath: string): boolean {
  return fs.existsSync(planPath(rootPath)) && fs.existsSync(planJsonPath(rootPath))
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

class TerraformCommandCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerraformCommandCancelledError'
  }
}

function buildCancelledMessage(command: TerraformCommandRequest['command']): string {
  return `Terraform ${command} cancelled by operator.`
}

function terminateChildProcess(child: ChildProcessWithoutNullStreams | null): void {
  if (!child) return

  if (process.platform === 'win32' && child.pid) {
    try {
      // Wait for the kill command to exit so we know the process tree is gone before we proceed.
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false
      })
      return
    } catch {
      /* fall back to direct kill */
    }
  }

  try {
    child.kill()
  } catch {
    /* ignore kill failures */
  }
}

function terraformCommand(): string {
  return cachedCli?.found && cachedCli.path ? cachedCli.path : 'terraform'
}

function terraformCliLabel(): string {
  return cachedCli?.label || 'Terraform'
}

function inferTerraformProviderId(
  profileName: string,
  connection?: AwsConnection
): 'aws' | 'gcp' | 'azure' | 'local' {
  if (connection?.providerId === 'gcp' || profileName.startsWith('provider:gcp:terraform:')) return 'gcp'
  if (connection?.providerId === 'azure' || profileName.startsWith('provider:azure:terraform:')) return 'azure'
  if (connection?.providerId === 'aws' || profileName.startsWith('profile:') || profileName.startsWith('assumed-role:')) return 'aws'
  return 'local'
}

function parseScopedTerraformProfileName(
  profileName: string
): { providerId: 'gcp' | 'azure'; scopeId: string; location: string } | null {
  const match = profileName.match(/^provider:(gcp|azure):terraform:([^:]+):(.+)$/)
  if (!match) return null
  return {
    providerId: match[1] as 'gcp' | 'azure',
    scopeId: match[2] === 'unscoped' ? '' : match[2],
    location: match[3] === 'global' ? '' : match[3]
  }
}

function displayConnectionLabel(profileName: string, connection?: AwsConnection): string {
  if (connection?.label) return connection.label
  const scopedProfile = parseScopedTerraformProfileName(profileName)
  if (scopedProfile) {
    return [scopedProfile.scopeId, scopedProfile.location].filter(Boolean).join(' | ')
  }
  if (profileName.startsWith('profile:')) return profileName.slice('profile:'.length)
  return ''
}

function inferVarSetLabel(project: StoredProject): string {
  const config = normalizeInputConfig(project)
  const selected = getSelectedVariableSet(config)
  return selected?.name ?? ''
}

function inferEnvironmentLabel(workspaceName: string): string {
  if (!workspaceName || workspaceName === 'default') return 'Default'
  return workspaceName
}

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function isRelevantTerraformFile(filePath: string): boolean {
  const normalized = normalizeGitPath(filePath).toLowerCase()
  return normalized.endsWith('.tf')
    || normalized.endsWith('.tfvars')
    || normalized.endsWith('.tfvars.json')
    || normalized.endsWith('.terraform.lock.hcl')
}

function toShortCommitSha(commitSha: string): string {
  return commitSha.slice(0, 8)
}

function toGitCommitMetadata(git: TerraformProjectMetadata['git']): TerraformGitCommitMetadata | null {
  if (!git || git.status !== 'ready' || !git.commitSha) return null
  return {
    repoRoot: git.repoRoot,
    branch: git.branch,
    commitSha: git.commitSha,
    shortCommitSha: git.shortCommitSha,
    isDetached: git.isDetached,
    isDirty: git.isDirty
  }
}

function buildUnavailableGitMetadata(status: TerraformGitStatus, error = ''): TerraformProjectMetadata['git'] {
  return {
    status,
    repoRoot: '',
    projectRelativePath: '.',
    branch: '',
    commitSha: '',
    shortCommitSha: '',
    isDetached: false,
    isDirty: false,
    changedTerraformFiles: [],
    error: error || (status === 'not-repo'
      ? 'This project is not inside a Git repository.'
      : status === 'git-missing'
        ? 'Git executable was not found.'
        : 'Git metadata could not be determined.')
  }
}

function parseGitStatusLine(line: string): { status: string; path: string } | null {
  if (!line.trim()) return null
  const status = line.slice(0, 2)
  const rawPath = line.slice(3).trim()
  if (!rawPath) return null
  const pathPart = rawPath.includes(' -> ') ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4) : rawPath
  return {
    status: status.trim() || '??',
    path: pathPart.replace(/^"+|"+$/g, '')
  }
}

function detectGitMetadata(rootPath: string): TerraformProjectMetadata['git'] {
  try {
    const repoRoot = normalizeGitPath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: rootPath,
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString().trim())
    if (!repoRoot) return buildUnavailableGitMetadata('not-repo')

    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootPath,
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString().trim()

    let branch = ''
    let isDetached = false
    try {
      branch = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
        cwd: rootPath,
        timeout: 10000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }).toString().trim()
      isDetached = !branch
    } catch {
      isDetached = true
    }
    if (isDetached) branch = 'detached HEAD'

    const statusOutput = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: rootPath,
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString()
    const allChanges = statusOutput
      .split(/\r?\n/)
      .map((line) => parseGitStatusLine(line))
      .filter((item): item is { status: string; path: string } => item !== null)

    const projectRelativePathRaw = normalizeGitPath(path.relative(repoRoot, rootPath))
    const projectRelativePath = projectRelativePathRaw && projectRelativePathRaw !== '' ? projectRelativePathRaw : '.'
    const projectPrefix = projectRelativePath === '.' ? '' : `${projectRelativePath}/`
    const changedTerraformFiles: TerraformGitChangedFile[] = allChanges
      .filter((item) => isRelevantTerraformFile(item.path))
      .filter((item) => !projectPrefix || normalizeGitPath(item.path).startsWith(projectPrefix))
      .map((item) => ({
        status: item.status,
        path: projectPrefix ? normalizeGitPath(item.path).slice(projectPrefix.length) : normalizeGitPath(item.path)
      }))

    return {
      status: 'ready',
      repoRoot,
      projectRelativePath,
      branch,
      commitSha,
      shortCommitSha: toShortCommitSha(commitSha),
      isDetached,
      isDirty: allChanges.length > 0,
      changedTerraformFiles,
      error: ''
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not a git repository/i.test(message)) {
      return buildUnavailableGitMetadata('not-repo')
    }
    if (/ENOENT/i.test(message) || /not recognized as an internal or external command/i.test(message)) {
      return buildUnavailableGitMetadata('git-missing')
    }
    return buildUnavailableGitMetadata('error', message)
  }
}

function normalizePlanOptions(options?: TerraformPlanOptions): TerraformPlanOptionsSummary {
  const mode = options?.mode ?? 'standard'
  const targets = uniqueStrings((options?.targets ?? []).map((item) => item.trim()))
  const replaceAddresses = uniqueStrings((options?.replaceAddresses ?? []).map((item) => item.trim()))
  if (mode === 'refresh-only') {
    return { mode, targets: [], replaceAddresses: [] }
  }
  if (mode === 'targeted') {
    return { mode, targets, replaceAddresses: [] }
  }
  if (mode === 'replace') {
    return { mode, targets: [], replaceAddresses }
  }
  return { mode: 'standard', targets: [], replaceAddresses: [] }
}

function normalizeSavedPlanMetadata(raw: unknown): TerraformSavedPlanMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const request = normalizePlanOptions((record.request ?? record) as TerraformPlanOptions | undefined)
  const gitRecord = record.git
  const git = gitRecord && typeof gitRecord === 'object' && !Array.isArray(gitRecord)
    ? {
        repoRoot: typeof (gitRecord as Record<string, unknown>).repoRoot === 'string' ? (gitRecord as Record<string, unknown>).repoRoot as string : '',
        branch: typeof (gitRecord as Record<string, unknown>).branch === 'string' ? (gitRecord as Record<string, unknown>).branch as string : '',
        commitSha: typeof (gitRecord as Record<string, unknown>).commitSha === 'string' ? (gitRecord as Record<string, unknown>).commitSha as string : '',
        shortCommitSha: typeof (gitRecord as Record<string, unknown>).shortCommitSha === 'string' && (gitRecord as Record<string, unknown>).shortCommitSha
          ? (gitRecord as Record<string, unknown>).shortCommitSha as string
          : toShortCommitSha(typeof (gitRecord as Record<string, unknown>).commitSha === 'string' ? (gitRecord as Record<string, unknown>).commitSha as string : ''),
        isDetached: Boolean((gitRecord as Record<string, unknown>).isDetached),
        isDirty: Boolean((gitRecord as Record<string, unknown>).isDirty)
      }
    : null

  return {
    request,
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : '',
    git: git && git.commitSha ? git : null
  }
}

function readPlanMetadata(rootPath: string): TerraformSavedPlanMetadata | null {
  return normalizeSavedPlanMetadata(parseJsonFile<unknown>(planMetadataPath(rootPath), null))
}

function readPlanOptions(rootPath: string): TerraformPlanOptionsSummary {
  return readPlanMetadata(rootPath)?.request ?? normalizePlanOptions()
}

function writePlanMetadata(rootPath: string, options: TerraformPlanOptions | undefined, git: TerraformGitCommitMetadata | null): void {
  const metadata: TerraformSavedPlanMetadata = {
    request: normalizePlanOptions(options),
    generatedAt: new Date().toISOString(),
    git
  }
  fs.writeFileSync(planMetadataPath(rootPath), JSON.stringify(metadata, null, 2), 'utf-8')
}

/* ── CLI Detection ────────────────────────────────────────── */

let cachedCli: TerraformCliInfo | null = null

function cliCandidates(kind: TerraformCliKind): string[] {
  const baseName = kind === 'opentofu' ? 'tofu' : 'terraform'
  const executableName = process.platform === 'win32' ? `${baseName}.exe` : baseName
  const names = process.platform === 'win32' ? [executableName, baseName] : [baseName]
  const fallbacks: string[] = []

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pfx86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    if (kind === 'opentofu') {
      fallbacks.push(
        path.join(pf, 'OpenTofu', 'tofu.exe'),
        path.join(pfx86, 'OpenTofu', 'tofu.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenTofu', 'tofu.exe')
      )
    } else {
      fallbacks.push(
        path.join(pf, 'Terraform', 'terraform.exe'),
        path.join(pfx86, 'Terraform', 'terraform.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Terraform', 'terraform.exe')
      )
    }
    fallbacks.push(path.join(os.homedir(), '.tfenv', 'bin', executableName))
  } else if (process.platform === 'darwin') {
    fallbacks.push(
      `/usr/local/bin/${baseName}`,
      `/opt/homebrew/bin/${baseName}`,
      path.join(os.homedir(), '.tfenv', 'bin', baseName),
      path.join(os.homedir(), 'bin', baseName)
    )
  } else {
    fallbacks.push(
      `/usr/local/bin/${baseName}`,
      `/usr/bin/${baseName}`,
      `/snap/bin/${baseName}`,
      path.join(os.homedir(), '.tfenv', 'bin', baseName),
      path.join(os.homedir(), 'bin', baseName)
    )
  }

  return listToolCommandCandidates(kind, [...names, ...fallbacks])
}

function cliKindLabel(kind: TerraformCliKind): string {
  return kind === 'opentofu' ? 'OpenTofu' : 'Terraform'
}

async function probeCliCandidate(
  kind: TerraformCliKind,
  candidate: string,
  env: Record<string, string>
): Promise<TerraformCliOption | null> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(candidate, ['version', '-json'], { env, timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
    let version = ''
    try {
      const json = JSON.parse(result.stdout) as { terraform_version?: string }
      version = json.terraform_version ?? ''
    } catch {
      const match = result.stdout.match(/(?:Terraform|OpenTofu)\s+v([\d.]+)/i)
      version = match?.[1] ?? result.stdout.trim().slice(0, 40)
    }
    return {
      kind,
      label: cliKindLabel(kind),
      path: await resolveExecutablePath(candidate, env),
      version
    }
  } catch {
    return null
  }
}

async function detectAvailableCliOptions(env: Record<string, string>): Promise<TerraformCliOption[]> {
  const discovered: TerraformCliOption[] = []
  for (const kind of ['opentofu', 'terraform'] as const) {
    for (const candidate of cliCandidates(kind)) {
      const option = await probeCliCandidate(kind, candidate, env)
      if (!option) continue
      if (discovered.some((item) => item.kind === option.kind)) break
      discovered.push(option)
      break
    }
  }
  return discovered
}

function chooseActiveCli(options: TerraformCliOption[], preferredKind: TerraformCliKind | ''): TerraformCliOption | null {
  if (preferredKind) {
    const preferred = options.find((item) => item.kind === preferredKind)
    if (preferred) return preferred
  }
  return options.find((item) => item.kind === 'opentofu')
    ?? options.find((item) => item.kind === 'terraform')
    ?? null
}

export async function detectTerraformCli(baseEnv?: Record<string, string>): Promise<TerraformCliInfo> {
  const env = baseEnv ?? await getResolvedProcessEnv()
  const available = await detectAvailableCliOptions(env)
  const selected = chooseActiveCli(available, getPreferredTerraformCliKindSetting())
  if (selected) {
    cachedCli = {
      found: true,
      kind: selected.kind,
      label: selected.label,
      path: selected.path,
      version: selected.version,
      error: '',
      available
    }
    return cachedCli
  }

  cachedCli = {
    found: false,
    kind: '',
    label: '',
    path: '',
    version: '',
    error: 'No Terraform-compatible CLI found. Install OpenTofu or Terraform and ensure it is on your PATH.',
    available: []
  }
  return cachedCli
}

export function getCachedCliInfo(): TerraformCliInfo {
  return cachedCli ?? {
    found: false,
    kind: '',
    label: '',
    path: '',
    version: '',
    error: 'CLI detection has not run yet.',
    available: []
  }
}

export async function setActiveTerraformCli(kind: TerraformCliKind): Promise<TerraformCliInfo> {
  setPreferredTerraformCliKind(kind)
  const info = await detectTerraformCli()
  if (!info.found || info.kind !== kind) {
    throw new Error(`${cliKindLabel(kind)} CLI is not available on this machine.`)
  }
  return info
}

/* ── S3 Backend Parsing ───────────────────────────────────── */

function parseS3Backend(rootPath: string): TerraformS3BackendConfig | null {
  const tfFiles = listTerraformFiles(rootPath)
  const combined = tfFiles.map(readText).join('\n')
  const match = combined.match(/backend\s+"s3"\s*\{([\s\S]*?)\}/)
  if (!match) return null
  const body = match[1]
  const bucket = body.match(/bucket\s*=\s*"([^"]*)"/)?.[1] ?? ''
  const key = body.match(/key\s*=\s*"([^"]*)"/)?.[1] ?? ''
  const region = body.match(/region\s*=\s*"([^"]*)"/)?.[1] ?? ''
  const workspaceKeyPrefix = body.match(/workspace_key_prefix\s*=\s*"([^"]*)"/)?.[1] ?? 'env:'
  if (!bucket || !key) return null
  return { bucket, key, region, workspaceKeyPrefix }
}

function resolveS3StateKey(config: TerraformS3BackendConfig, rootPath: string): string {
  const envFile = path.join(rootPath, '.terraform', 'environment')
  const workspace = readText(envFile).trim() || 'default'
  if (workspace === 'default') return config.key
  return `${config.workspaceKeyPrefix}/${workspace}/${config.key}`
}

function buildBackendDetails(rootPath: string, backendType: string, s3Backend: TerraformS3BackendConfig | null): TerraformProjectMetadata['backend'] {
  if (backendType === 's3' && s3Backend) {
    return {
      ...s3Backend,
      type: 's3',
      label: `s3://${s3Backend.bucket}/${resolveS3StateKey(s3Backend, rootPath)}`,
      effectiveStateKey: resolveS3StateKey(s3Backend, rootPath)
    }
  }
  if (backendType === 'local') {
    return {
      type: 'local',
      label: path.join(rootPath, 'terraform.tfstate'),
      stateLocation: path.join(rootPath, 'terraform.tfstate')
    }
  }
  return {
    type: backendType,
    label: backendType,
    summary: `Backend type ${backendType}`
  }
}

function fallbackWorkspaceSnapshot(rootPath: string): { currentWorkspace: string; workspaces: TerraformWorkspaceSummary[] } {
  const currentWorkspace = readText(path.join(rootPath, '.terraform', 'environment')).trim() || 'default'
  const names = new Set<string>(['default'])
  const workspaceDir = path.join(rootPath, 'terraform.tfstate.d')
  if (fs.existsSync(workspaceDir)) {
    for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name) {
        names.add(entry.name)
      }
    }
  }
  names.add(currentWorkspace)
  const workspaces = [...names].sort().map((name) => ({ name, isCurrent: name === currentWorkspace }))
  return { currentWorkspace, workspaces }
}

function parseWorkspaceList(output: string, currentWorkspace: string): TerraformWorkspaceSummary[] {
  const parsed = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\*)?\s*(.+)$/)
      if (!match) return []
      const name = match[2]?.trim()
      if (!name || name.startsWith('The currently selected workspace')) return []
      return [{
        name,
        isCurrent: Boolean(match[1]) || name === currentWorkspace
      }]
    })

  const names = new Map<string, TerraformWorkspaceSummary>()
  for (const workspace of parsed) {
    names.set(workspace.name, workspace)
  }
  if (!names.has(currentWorkspace)) {
    names.set(currentWorkspace, { name: currentWorkspace, isCurrent: true })
  }
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function readWorkspaceSnapshot(
  profileName: string,
  project: StoredProject,
  connection?: AwsConnection
): { currentWorkspace: string; workspaces: TerraformWorkspaceSummary[] } {
  const fallback = fallbackWorkspaceSnapshot(project.rootPath)

  try {
    const env = buildEnvWithVars(project, profileName, connection)
    const currentWorkspace = stripAnsi(execFileSync(terraformCommand(), ['workspace', 'show'], {
      cwd: project.rootPath,
      env,
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString()).trim() || fallback.currentWorkspace

    const workspaceOutput = execFileSync(terraformCommand(), ['workspace', 'list'], {
      cwd: project.rootPath,
      env,
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString()

    return {
      currentWorkspace,
      workspaces: parseWorkspaceList(workspaceOutput, currentWorkspace)
    }
  } catch {
    return fallback
  }
}

/* ── Terraform Config Parsing (for dependency graph) ──────── */

type ConfigBlock = {
  blockType: 'resource' | 'data'
  tfType: string
  tfName: string
  body: string
  modulePath: string
}

type ParsedNamedBlock = {
  kind: 'resource' | 'data' | 'module'
  firstLabel: string
  secondLabel: string
  body: string
}

const RESOURCE_REFERENCE_PATTERN = '(?:module\\.[\\w-]+\\.)*(?:data\\.)?[a-z][\\w-]*_[\\w-]+\\.[\\w-]+'
const RESOURCE_REFERENCE_RE = new RegExp(RESOURCE_REFERENCE_PATTERN, 'g')
const LEADING_RESOURCE_REFERENCE_RE = new RegExp(`^${RESOURCE_REFERENCE_PATTERN}`)

function prefixAddress(modulePath: string, address: string): string {
  return modulePath ? `${modulePath}.${address}` : address
}

function normalizeConfigReference(reference: string, modulePath: string): string {
  if (!reference) return ''
  const trimmed = reference.trim()
  if (
    trimmed.startsWith('var.')
    || trimmed.startsWith('local.')
    || trimmed.startsWith('path.')
    || trimmed.startsWith('terraform.')
    || trimmed.startsWith('provider.')
    || trimmed.startsWith('count.')
    || trimmed.startsWith('each.')
    || trimmed.startsWith('self.')
  ) {
    return ''
  }
  const resourceReference = trimmed.match(LEADING_RESOURCE_REFERENCE_RE)?.[0] ?? ''
  if (!resourceReference) return ''
  if (resourceReference.startsWith('module.')) {
    return resourceReference
  }
  return prefixAddress(modulePath, resourceReference)
}

function parseNamedBlocks(combined: string): ParsedNamedBlock[] {
  const blocks: ParsedNamedBlock[] = []
  const blockRe = /\b(resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/g
  let match: RegExpExecArray | null

  while ((match = blockRe.exec(combined)) !== null) {
    const kind = match[1] as ParsedNamedBlock['kind']
    const firstLabel = match[2]
    const secondLabel = match[3] ?? ''
    const start = match.index + match[0].length
    let depth = 1
    let i = start

    while (i < combined.length && depth > 0) {
      if (combined[i] === '{') depth++
      else if (combined[i] === '}') depth--
      i++
    }

    blocks.push({ kind, firstLabel, secondLabel, body: combined.slice(start, i - 1) })
  }

  return blocks
}

function extractLocalModuleSource(body: string, moduleDir: string): string | null {
  const source = body.match(/source\s*=\s*"([^"]+)"/)?.[1]?.trim()
  if (!source) return null
  if (/^\.\.?(?:[\\/]|$)/.test(source) || /^\.?[\\/]/.test(source)) {
    return path.resolve(moduleDir, source)
  }
  return null
}

function collectConfigBlocks(
  rootPath: string,
  modulePath: string,
  visitedPaths: Set<string>
): ConfigBlock[] {
  const resolvedRoot = path.resolve(rootPath)
  const visitKey = `${modulePath}::${resolvedRoot}`
  if (visitedPaths.has(visitKey)) return []
  visitedPaths.add(visitKey)

  const tfFiles = listTerraformFiles(resolvedRoot)
  const combined = tfFiles.map(readText).join('\n')
  const parsedBlocks = parseNamedBlocks(combined)
  const configBlocks: ConfigBlock[] = []

  for (const block of parsedBlocks) {
    if (block.kind === 'resource' || block.kind === 'data') {
      configBlocks.push({
        blockType: block.kind,
        tfType: block.firstLabel,
        tfName: block.secondLabel,
        body: block.body,
        modulePath
      })
      continue
    }

    const localModuleSource = extractLocalModuleSource(block.body, resolvedRoot)
    if (!localModuleSource || !fs.existsSync(localModuleSource) || !fs.statSync(localModuleSource).isDirectory()) {
      continue
    }

    const childModulePath = prefixAddress(modulePath, `module.${block.firstLabel}`)
    configBlocks.push(...collectConfigBlocks(localModuleSource, childModulePath, visitedPaths))
  }

  return configBlocks
}

function parseConfigBlocks(rootPath: string): ConfigBlock[] {
  return collectConfigBlocks(rootPath, '', new Set<string>())
}

function buildConfigEdges(blocks: ConfigBlock[]): TerraformGraphEdge[] {
  const edges: TerraformGraphEdge[] = []
  const edgeSet = new Set<string>()
  for (const block of blocks) {
    const baseAddress = block.blockType === 'data'
      ? `data.${block.tfType}.${block.tfName}`
      : `${block.tfType}.${block.tfName}`
    const address = prefixAddress(block.modulePath, baseAddress)
    // Parse depends_on
    const dependsMatch = block.body.match(/depends_on\s*=\s*\[([\s\S]*?)\]/)
    if (dependsMatch) {
      const deps = dependsMatch[1].match(/[\w.]+/g) ?? []
      for (const dep of deps) {
        const normalizedDep = normalizeConfigReference(dep, block.modulePath)
        const key = `${normalizedDep}->${address}`
        if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: normalizedDep, to: address, relation: 'depends_on' }) }
      }
    }
    // Detect references like aws_vpc.main, data.aws_ami.latest
    const refRe = new RegExp(RESOURCE_REFERENCE_RE)
    let refMatch: RegExpExecArray | null
    while ((refMatch = refRe.exec(block.body)) !== null) {
      const ref = normalizeConfigReference(refMatch[0], block.modulePath)
      if (ref && ref !== address && !ref.startsWith(address + '.')) {
        const key = `${ref}->${address}`
        if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: ref, to: address, relation: 'reference' }) }
      }
    }
  }
  return edges
}

/* ── Dynamic Identity Inference for Graph Edges ───────────── */

const IDENTITY_KEYS = ['id', 'arn', 'name', 'bucket', 'cluster_identifier', 'db_instance_identifier', 'self_link', 'email']
const REFERENCE_KEYS = [
  'vpc_id', 'subnet_id', 'security_group_id', 'role_arn', 'instance_id', 'cluster_name',
  'target_group_arn', 'load_balancer_arn', 'log_group_name', 'kms_key_id', 'certificate_arn',
  'hosted_zone_id', 'db_subnet_group_name', 'execution_role_arn', 'task_role_arn',
  'network', 'subnetwork', 'router', 'instance', 'cluster'
]
const PLURAL_REFERENCE_KEYS = ['subnet_ids', 'security_group_ids', 'security_groups', 'vpc_security_group_ids', 'reserved_peering_ranges']

function collectExpressionReferences(value: unknown, sink: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectExpressionReferences(item, sink)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (Array.isArray(record.references)) {
    for (const item of record.references) {
      if (typeof item === 'string' && item.trim()) sink.add(item.trim())
    }
  }
  for (const nested of Object.values(record)) {
    collectExpressionReferences(nested, sink)
  }
}

function buildPlanConfigEdges(rootPath: string): TerraformGraphEdge[] {
  const plan = parseJsonFile<Record<string, unknown> | null>(planJsonPath(rootPath), null)
  const configuration = plan?.configuration
  if (!configuration || typeof configuration !== 'object') return []
  const rootModule = (configuration as Record<string, unknown>).root_module
  if (!rootModule || typeof rootModule !== 'object') return []

  const edges: TerraformGraphEdge[] = []
  const edgeSet = new Set<string>()

  function addEdge(from: string, to: string): void {
    if (!from || !to || from === to || from.startsWith(`${to}.`)) return
    const key = `${from}->${to}`
    if (!edgeSet.has(key)) {
      edgeSet.add(key)
      edges.push({ from, to, relation: 'reference' })
    }
  }

  function walkModule(moduleNode: Record<string, unknown>, modulePath: string): void {
    const resources = Array.isArray(moduleNode.resources) ? moduleNode.resources : []
    for (const entry of resources) {
      const resource = entry as Record<string, unknown>
      const localAddress = typeof resource.address === 'string' ? resource.address : ''
      if (!localAddress) continue
      const address = prefixAddress(modulePath, localAddress)
      const refs = new Set<string>()
      collectExpressionReferences(resource.expressions, refs)
      const dependsOn = Array.isArray(resource.depends_on)
        ? resource.depends_on.filter((value): value is string => typeof value === 'string')
        : []
      for (const rawRef of [...refs, ...dependsOn]) {
        const normalized = normalizeConfigReference(rawRef, modulePath)
        if (normalized) addEdge(normalized, address)
      }
    }

    const moduleCalls = moduleNode.module_calls
    if (!moduleCalls || typeof moduleCalls !== 'object') return
    for (const [moduleName, entry] of Object.entries(moduleCalls as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const childModule = (entry as Record<string, unknown>).module
      if (!childModule || typeof childModule !== 'object') continue
      walkModule(childModule as Record<string, unknown>, prefixAddress(modulePath, `module.${moduleName}`))
    }
  }

  walkModule(rootModule as Record<string, unknown>, '')
  return edges
}

function buildDiagramNodeLabel(address: string): string {
  const moduleSegments = [...address.matchAll(/module\.([\w-]+)/g)].map((match) => match[1])
  const moduleLabel = moduleSegments.length > 0 ? moduleSegments[moduleSegments.length - 1] : ''
  const resourceReference = address.match(LEADING_RESOURCE_REFERENCE_RE)?.[0] ?? ''
  const baseLabel = resourceReference || address
  const suffix = resourceReference ? address.slice(address.indexOf(resourceReference) + resourceReference.length) : ''
  const withModule = moduleLabel ? `${moduleLabel} / ${baseLabel}${suffix}` : `${baseLabel}${suffix}`
  return withModule.length > 54 ? `${withModule.slice(0, 26)}...${withModule.slice(-24)}` : withModule
}

function inferDynamicEdges(inventory: TerraformResourceInventoryItem[]): TerraformGraphEdge[] {
  const identityIndex = new Map<string, string>() // value -> address
  for (const item of inventory) {
    for (const key of IDENTITY_KEYS) {
      const val = item.values[key]
      if (typeof val === 'string' && val) identityIndex.set(val, item.address)
    }
  }

  const edges: TerraformGraphEdge[] = []
  const edgeSet = new Set<string>()
  for (const item of inventory) {
    for (const key of REFERENCE_KEYS) {
      const val = item.values[key]
      if (typeof val === 'string' && val) {
        const target = identityIndex.get(val)
        if (target && target !== item.address) {
          const edgeKey = `${target}->${item.address}`
          if (!edgeSet.has(edgeKey)) { edgeSet.add(edgeKey); edges.push({ from: target, to: item.address, relation: 'inferred' }) }
        }
      }
    }
    for (const key of PLURAL_REFERENCE_KEYS) {
      const val = item.values[key]
      if (Array.isArray(val)) {
        for (const v of val) {
          if (typeof v === 'string') {
            const target = identityIndex.get(v)
            if (target && target !== item.address) {
              const edgeKey = `${target}->${item.address}`
              if (!edgeSet.has(edgeKey)) { edgeSet.add(edgeKey); edges.push({ from: target, to: item.address, relation: 'inferred' }) }
            }
          }
        }
      }
    }
  }
  return edges
}

/* ── Metadata Inference ───────────────────────────────────── */

function inferMetadata(rootPath: string): {
  metadata: TerraformProjectMetadata
  variables: TerraformVariableDefinition[]
} {
  const tfFiles = listTerraformFiles(rootPath)
  const combined = tfFiles.map(readText).join('\n')

  const providerNames = Array.from(
    combined.matchAll(/provider\s+"([^"]+)"/g), (m) => m[1]
  ).filter((v, i, a) => a.indexOf(v) === i)

  const resourceCount = Array.from(combined.matchAll(/^\s*resource\s+"[^"]+"\s+"[^"]+"/gm)).length
  const moduleCount = Array.from(combined.matchAll(/^\s*module\s+"[^"]+"/gm)).length
  const outputsCount = Array.from(combined.matchAll(/^\s*output\s+"[^"]+"/gm)).length
  const versionConstraint = combined.match(/required_version\s*=\s*"([^"]+)"/)?.[1] ?? ''
  const backendType = combined.match(/backend\s+"([^"]+)"/)?.[1] ?? 'local'

  const variables = Array.from(combined.matchAll(/variable\s+"([^"]+)"\s*\{([\s\S]*?)\}/g)).map((match) => {
    const body = match[2]
    const description = body.match(/description\s*=\s*"([^"]*)"/)?.[1]
      ?? body.match(/description\s*=\s*<<[-\w]*\n([\s\S]*?)\n[-\w]*/)?.[1]?.trim() ?? ''
    const defaultValue = body.match(/default\s*=\s*([^\n]+)/)?.[1]?.trim() ?? ''
    return { name: match[1], description, hasDefault: defaultValue.length > 0, defaultValue }
  })

  const s3Backend = parseS3Backend(rootPath)
  const git = detectGitMetadata(rootPath)

  return {
    metadata: {
      terraformVersionConstraint: versionConstraint,
      backendType,
      backend: buildBackendDetails(rootPath, backendType, s3Backend),
      git,
      providerNames,
      resourceCount,
      moduleCount,
      variableCount: variables.length,
      outputsCount,
      tfFileCount: tfFiles.length,
      lastScannedAt: new Date().toISOString(),
      s3Backend
    },
    variables
  }
}

/* ── State Reading ────────────────────────────────────────── */

function flattenModuleResources(
  moduleNode: Record<string, unknown>,
  resourceMap: Map<string, TerraformResourceInventoryItem>,
  stateAddresses: string[]
): void {
  const moduleAddress = typeof moduleNode.address === 'string' ? moduleNode.address : 'root'
  const resources = Array.isArray(moduleNode.resources) ? moduleNode.resources : []
  for (const resource of resources) {
    const r = resource as Record<string, unknown>
    const addr = typeof r.address === 'string' ? r.address : ''
    if (!addr) continue
    const dependsOn = Array.isArray(r.depends_on) ? r.depends_on.filter((v: unknown): v is string => typeof v === 'string') : []
    const rawValues = (r.values && typeof r.values === 'object') ? r.values as Record<string, unknown> : {}
    resourceMap.set(addr, {
      address: addr,
      type: typeof r.type === 'string' ? r.type : '',
      name: typeof r.name === 'string' ? r.name : '',
      provider: typeof r.provider_name === 'string' ? r.provider_name : '',
      modulePath: moduleAddress,
      mode: r.mode === 'data' ? 'data' : 'managed',
      dependsOn,
      values: rawValues
    })
    stateAddresses.push(addr)
  }
  const childModules = Array.isArray(moduleNode.child_modules) ? moduleNode.child_modules : []
  for (const child of childModules) flattenModuleResources(child as Record<string, unknown>, resourceMap, stateAddresses)
}

function flattenStateResources(
  resources: Array<Record<string, unknown>>,
  resourceMap: Map<string, TerraformResourceInventoryItem>,
  stateAddresses: string[]
): void {
  for (const resource of resources) {
    const mode = resource.mode === 'data' ? 'data' : 'managed'
    const type = typeof resource.type === 'string' ? resource.type : ''
    const name = typeof resource.name === 'string' ? resource.name : ''
    const provider = typeof resource.provider === 'string' ? resource.provider : ''
    const modulePath = typeof resource.module === 'string' ? resource.module : 'root'
    const instances = Array.isArray(resource.instances) ? resource.instances : []

    for (let idx = 0; idx < instances.length; idx++) {
      const instance = instances[idx] as Record<string, unknown>
      const indexKey = instance.index_key
      const addressBase = mode === 'data' ? `data.${type}.${name}` : `${type}.${name}`
      const instanceSuffix = indexKey === undefined
        ? ''
        : typeof indexKey === 'number'
          ? `[${indexKey}]`
          : `["${String(indexKey)}"]`
      const address = modulePath !== 'root'
        ? `${modulePath}.${addressBase}${instanceSuffix}`
        : `${addressBase}${instanceSuffix}`
      const dependsOn = Array.isArray(instance.depends_on)
        ? instance.depends_on.filter((v: unknown): v is string => typeof v === 'string')
        : []
      const rawValues = instance.attributes && typeof instance.attributes === 'object'
        ? instance.attributes as Record<string, unknown>
        : {}

      resourceMap.set(address, {
        address,
        type,
        name,
        provider,
        modulePath,
        mode,
        dependsOn,
        values: rawValues
      })
      stateAddresses.push(address)
    }
  }
}

function findStateSource(rootPath: string): { rawStateJson: string; stateSource: string } {
  // 1. local terraform.tfstate
  const localState = path.join(rootPath, 'terraform.tfstate')
  const localJson = readText(localState)
  if (localJson.trim()) return { rawStateJson: localJson, stateSource: 'local' }

  // 2. newest workspace state
  const stateDir = path.join(rootPath, 'terraform.tfstate.d')
  if (fs.existsSync(stateDir)) {
    try {
      const workspaces = fs.readdirSync(stateDir, { withFileTypes: true }).filter((e) => e.isDirectory())
      let newest = ''
      let newestTime = 0
      for (const ws of workspaces) {
        const wsState = path.join(stateDir, ws.name, 'terraform.tfstate')
        try {
          const stat = fs.statSync(wsState)
          if (stat.mtimeMs > newestTime) { newest = wsState; newestTime = stat.mtimeMs }
        } catch { /* skip */ }
      }
      if (newest) {
        const json = readText(newest)
        if (json.trim()) return { rawStateJson: json, stateSource: `workspace:${path.basename(path.dirname(newest))}` }
      }
    } catch { /* skip */ }
  }

  // 3. cached state from remote pull
  const cached = readText(stateCachePath(rootPath))
  if (cached.trim()) return { rawStateJson: cached, stateSource: 'remote-cache' }

  return { rawStateJson: '', stateSource: 'none' }
}

function readStateSnapshot(rootPath: string): {
  inventory: TerraformResourceInventoryItem[]
  stateAddresses: string[]
  rawStateJson: string
  stateSource: string
} {
  const { rawStateJson, stateSource } = findStateSource(rootPath)
  if (!rawStateJson.trim()) return { inventory: [], stateAddresses: [], rawStateJson: '', stateSource: 'none' }

  try {
    const state = JSON.parse(rawStateJson) as Record<string, unknown>
    // Support both modern (state.values.root_module) and legacy (state.modules[0].resources) shapes
    const values = state.values as Record<string, unknown> | undefined
    const rootModule = values?.root_module as Record<string, unknown> | undefined
    if (rootModule) {
      const resourceMap = new Map<string, TerraformResourceInventoryItem>()
      const stateAddresses: string[] = []
      flattenModuleResources(rootModule, resourceMap, stateAddresses)
      return {
        inventory: Array.from(resourceMap.values()).sort((a, b) => a.address.localeCompare(b.address)),
        stateAddresses: stateAddresses.sort(),
        rawStateJson,
        stateSource
      }
    }
    // Native Terraform state file shape (v4+)
    const resources = state.resources as Array<Record<string, unknown>> | undefined
    if (Array.isArray(resources)) {
      const resourceMap = new Map<string, TerraformResourceInventoryItem>()
      const stateAddresses: string[] = []
      flattenStateResources(resources, resourceMap, stateAddresses)
      return {
        inventory: Array.from(resourceMap.values()).sort((a, b) => a.address.localeCompare(b.address)),
        stateAddresses: stateAddresses.sort(),
        rawStateJson,
        stateSource
      }
    }
    // Legacy v3 state shape
    const modules = state.modules as Array<Record<string, unknown>> | undefined
    if (Array.isArray(modules)) {
      const resourceMap = new Map<string, TerraformResourceInventoryItem>()
      const stateAddresses: string[] = []
      for (const mod of modules) {
        const modPath = typeof mod.path === 'string' ? mod.path : 'root'
        const resources = mod.resources as Record<string, Record<string, unknown>> | undefined
        if (!resources || typeof resources !== 'object') continue
        for (const [key, res] of Object.entries(resources)) {
          const addr = modPath === 'root' ? key : `module.${modPath}.${key}`
          resourceMap.set(addr, {
            address: addr,
            type: typeof res.type === 'string' ? res.type : '',
            name: key.split('.').pop() ?? '',
            provider: typeof res.provider === 'string' ? res.provider : '',
            modulePath: modPath,
            mode: 'managed',
            dependsOn: Array.isArray(res.depends_on) ? res.depends_on.filter((v: unknown): v is string => typeof v === 'string') : [],
            values: (res.primary && typeof res.primary === 'object' && (res.primary as Record<string, unknown>).attributes && typeof (res.primary as Record<string, unknown>).attributes === 'object')
              ? (res.primary as Record<string, unknown>).attributes as Record<string, unknown>
              : {}
          })
          stateAddresses.push(addr)
        }
      }
      return {
        inventory: Array.from(resourceMap.values()).sort((a, b) => a.address.localeCompare(b.address)),
        stateAddresses: stateAddresses.sort(),
        rawStateJson,
        stateSource
      }
    }
    return { inventory: [], stateAddresses: [], rawStateJson, stateSource }
  } catch {
    return { inventory: [], stateAddresses: [], rawStateJson, stateSource }
  }
}

/* ── Plan Reading ─────────────────────────────────────────── */

const EMPTY_PLAN_COUNTS: TerraformPlanCounts = { create: 0, update: 0, delete: 0, replace: 0, noop: 0 }
const PLAN_JSON_FIELDS_USED = [
  'resource_changes[].address',
  'resource_changes[].type',
  'resource_changes[].name',
  'resource_changes[].mode',
  'resource_changes[].module_address',
  'resource_changes[].provider_name',
  'resource_changes[].action_reason',
  'resource_changes[].change.actions',
  'resource_changes[].change.before',
  'resource_changes[].change.after',
  'resource_changes[].change.after_unknown',
  'resource_changes[].change.before_sensitive',
  'resource_changes[].change.after_sensitive',
  'resource_changes[].change.replace_paths'
]
const PLAN_HEURISTIC_NOTES = [
  'Affected services are inferred from Terraform resource types and provider names.',
  'Delete-heavy highlighting is based on action totals, not cloud-provider impact.',
  'Attribute summaries collapse nested structures and unknown values for readability.',
  'Physical identity previews are inferred from common fields such as arn, id, and name.'
]

function classifyAction(actions: string[]): TerraformPlanAction {
  const sorted = [...actions].sort()
  const key = sorted.join(',')
  if (key === 'create') return 'create'
  if (key === 'update') return 'update'
  if (key === 'delete') return 'delete'
  if (key === 'create,delete' || key === 'delete,create') return 'replace'
  return 'no-op'
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function shortProviderName(providerName: string): string {
  if (!providerName) return ''
  const parts = providerName.split('/')
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : providerName
}

function inferServiceName(type: string, providerName: string): string {
  if (type.startsWith('aws_')) return cloudTrailServiceForType(type) || 'aws'
  const short = shortProviderName(providerName)
  return short.split('/').pop() ?? short ?? 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function valueAtPath(value: unknown, path: string): unknown {
  if (!path) return value
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => valuesEqual(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => rightKeys.includes(key) && valuesEqual(left[key], right[key]))
  }
  return false
}

function summarizeValue(value: unknown, sensitive = false): string {
  if (sensitive && value !== undefined) return '(sensitive)'
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.length <= 4 && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item) || item === null)) {
      return `[${value.map((item) => summarizeValue(item)).join(', ')}]`
    }
    return `[${value.length} items]`
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    const identity = physicalId(value)
    if (identity !== '-') return identity
    return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', ...' : ''}}`
  }
  return String(value)
}

function collectChangedPaths(before: unknown, after: unknown, prefix = '', depth = 0, limit = 14, acc = new Set<string>()): Set<string> {
  if (acc.size >= limit || valuesEqual(before, after)) return acc
  if (depth < 3 && isRecord(before) && isRecord(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
    for (const key of keys) {
      const nextPath = prefix ? `${prefix}.${key}` : key
      collectChangedPaths(before[key], after[key], nextPath, depth + 1, limit, acc)
      if (acc.size >= limit) break
    }
    if (!prefix && acc.size === 0) acc.add('(root)')
    return acc
  }
  acc.add(prefix || '(root)')
  return acc
}

function collectMarkedPaths(value: unknown, prefix = '', acc = new Set<string>()): Set<string> {
  if (value === true) {
    acc.add(prefix || '(root)')
    return acc
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMarkedPaths(item, prefix ? `${prefix}.${index}` : String(index), acc))
    return acc
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, child]) => collectMarkedPaths(child, prefix ? `${prefix}.${key}` : key, acc))
  }
  return acc
}

function normalizeReplacePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => Array.isArray(item)
      ? item.map((segment) => String(segment)).join('.')
      : typeof item === 'string' ? item : '')
    .filter(Boolean)
}

function buildAttributeChanges(change: Record<string, unknown>): TerraformPlanAttributeChange[] {
  const before = change.before
  const after = change.after
  const unknownPaths = collectMarkedPaths(change.after_unknown)
  const sensitivePaths = collectMarkedPaths(change.before_sensitive)
  collectMarkedPaths(change.after_sensitive, '', sensitivePaths)
  const replacePaths = new Set(normalizeReplacePaths(change.replace_paths))
  const changedPaths = collectChangedPaths(before, after)
  const merged = Array.from(new Set([...changedPaths, ...unknownPaths, ...replacePaths]))
    .filter((path) => path !== '(root)')
    .slice(0, 12)

  return merged.map((path) => {
    const sensitive = sensitivePaths.has(path)
    const unknown = unknownPaths.has(path)
    const requiresReplacement = replacePaths.has(path)
    const beforeValue = valueAtPath(before, path)
    const afterValue = valueAtPath(after, path)
    let changeType: TerraformPlanAttributeChange['changeType'] = 'update'
    if (requiresReplacement) changeType = 'replace'
    else if (unknown) changeType = 'unknown'
    else if (beforeValue === undefined && afterValue !== undefined) changeType = 'add'
    else if (beforeValue !== undefined && afterValue === undefined) changeType = 'remove'

    return {
      path,
      changeType,
      before: summarizeValue(beforeValue, sensitive),
      after: unknown ? '(known after apply)' : summarizeValue(afterValue, sensitive),
      requiresReplacement,
      sensitive,
      heuristic: unknown || Array.isArray(beforeValue) || Array.isArray(afterValue) || isRecord(beforeValue) || isRecord(afterValue)
    }
  })
}

function incrementPlanCounts(summary: TerraformPlanCounts, action: TerraformPlanAction): void {
  if (action === 'create') summary.create++
  else if (action === 'update') summary.update++
  else if (action === 'delete') summary.delete++
  else if (action === 'replace') summary.replace++
  else summary.noop++
}

function summarizePlanGroup(kind: 'module' | 'action' | 'resource-type', entries: Array<{ label: string; key: string; change: TerraformPlanChange }>): TerraformPlanGroup[] {
  const grouped = new Map<string, TerraformPlanGroup>()
  for (const entry of entries) {
    const existing = grouped.get(entry.key) ?? {
      key: entry.key,
      label: entry.label,
      kind,
      count: 0,
      summary: { ...EMPTY_PLAN_COUNTS },
      resources: []
    }
    existing.count++
    incrementPlanCounts(existing.summary, entry.change.actionLabel)
    existing.resources.push(entry.change.address)
    grouped.set(entry.key, existing)
  }
  return [...grouped.values()]
    .map((group) => ({ ...group, resources: group.resources.sort() }))
    .sort((a, b) =>
      b.count - a.count
      || b.summary.replace - a.summary.replace
      || b.summary.delete - a.summary.delete
      || a.label.localeCompare(b.label))
}

function emptyPlanSummary(request: TerraformPlanOptionsSummary): TerraformPlanSummary {
  return {
    ...EMPTY_PLAN_COUNTS,
    hasChanges: false,
    affectedResources: 0,
    affectedModules: [],
    affectedProviders: [],
    affectedServices: [],
    groups: { byModule: [], byAction: [], byResourceType: [] },
    jsonFieldsUsed: [...PLAN_JSON_FIELDS_USED],
    heuristicNotes: [...PLAN_HEURISTIC_NOTES],
    hasDestructiveChanges: false,
    hasReplacementChanges: false,
    isDeleteHeavy: false,
    request
  }
}

function listStateBackups(projectId: string): TerraformStateBackupSummary[] {
  const dir = stateBackupDir(projectId)
  if (!fs.existsSync(dir)) return []

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tfstate.backup.json'))
    .map((entry) => {
      const filePath = path.join(dir, entry.name)
      const stat = fs.statSync(filePath)
      const sourceMatch = entry.name.match(/^[^.]+\.(.+)\.tfstate\.backup\.json$/)
      return {
        path: filePath,
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        source: sourceMatch?.[1] ?? 'state'
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function trimStateBackupHistory(projectId: string): void {
  const backups = listStateBackups(projectId)
  for (const backup of backups.slice(STATE_BACKUP_LIMIT)) {
    try {
      fs.unlinkSync(backup.path)
    } catch {
      /* ok */
    }
  }
}

function sanitizeBackupSource(source: string): string {
  return source.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'state'
}

async function createStateBackup(
  project: StoredProject,
  env: Record<string, string>
): Promise<TerraformStateBackupSummary> {
  const dir = stateBackupDir(project.id)
  fs.mkdirSync(dir, { recursive: true })

  let rawStateJson = ''
  let source = 'state'
  try {
    const pulled = await runChildProcess(project.rootPath, terraformCommand(), ['state', 'pull'], env)
    if (pulled.exitCode === 0 && pulled.output.trim()) {
      rawStateJson = pulled.output
      source = 'remote-pull'
      fs.writeFileSync(stateCachePath(project.rootPath), pulled.output, 'utf-8')
    }
  } catch {
    /* fall back to existing state snapshot */
  }

  if (!rawStateJson.trim()) {
    const snapshot = readStateSnapshot(project.rootPath)
    rawStateJson = snapshot.rawStateJson
    source = snapshot.stateSource || 'state'
  }

  if (!rawStateJson.trim()) {
    throw new Error('No Terraform state snapshot was available to back up before this operation.')
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(dir, `${timestamp}.${sanitizeBackupSource(source)}.tfstate.backup.json`)
  fs.writeFileSync(backupPath, rawStateJson, 'utf-8')
  trimStateBackupHistory(project.id)

  const stat = fs.statSync(backupPath)
  return {
    path: backupPath,
    createdAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    source
  }
}

function readStateLockInfo(rootPath: string, backendType: string): TerraformStateLockInfo | null {
  const candidates = [
    path.join(rootPath, '.terraform.tfstate.lock.info'),
    path.join(rootPath, '.terraform', 'terraform.tfstate.lock.info')
  ]

  for (const infoPath of candidates) {
    if (!fs.existsSync(infoPath)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as Record<string, unknown>
      return {
        supported: true,
        backendType,
        lockId: typeof raw.ID === 'string' ? raw.ID : '',
        operation: typeof raw.Operation === 'string' ? raw.Operation : '',
        who: typeof raw.Who === 'string' ? raw.Who : '',
        version: typeof raw.Version === 'string' ? raw.Version : '',
        created: typeof raw.Created === 'string' ? raw.Created : '',
        path: typeof raw.Path === 'string' ? raw.Path : '',
        infoPath,
        message: '',
        canUnlock: typeof raw.ID === 'string' && raw.ID.trim().length > 0
      }
    } catch {
      return {
        supported: true,
        backendType,
        lockId: '',
        operation: '',
        who: '',
        version: '',
        created: '',
        path: '',
        infoPath,
        message: 'Lock metadata exists but could not be parsed.',
        canUnlock: false
      }
    }
  }

  return {
    supported: backendType === 'local',
    backendType,
    lockId: '',
    operation: '',
    who: '',
    version: '',
    created: '',
    path: '',
    infoPath: '',
    message: backendType === 'local'
      ? 'No local lock file is present.'
      : 'Lock inspection is only available when Terraform leaves a local lock info file. Remote backend lock inspection is not available here.',
    canUnlock: false
  }
}

function readPlanSnapshot(rootPath: string): {
  planChanges: TerraformPlanChange[]
  lastPlanSummary: TerraformPlanSummary
} {
  const request = readPlanOptions(rootPath)
  const plan = parseJsonFile<Record<string, unknown> | null>(planJsonPath(rootPath), null)
  if (!plan || !Array.isArray(plan.resource_changes)) {
    return { planChanges: [], lastPlanSummary: emptyPlanSummary(request) }
  }
  const summary = { ...EMPTY_PLAN_COUNTS }
  const planChanges = plan.resource_changes.flatMap((cr) => {
    if (!cr || typeof cr !== 'object') return []
    const rec = cr as Record<string, unknown>
    const change = rec.change as Record<string, unknown> | undefined
    const actions = Array.isArray(change?.actions) ? change.actions.filter((v): v is string => typeof v === 'string') : []
    const label = classifyAction(actions)
    incrementPlanCounts(summary, label)
    const provider = typeof rec.provider_name === 'string' ? rec.provider_name : ''
    const type = typeof rec.type === 'string' ? rec.type : ''
    const modulePath = typeof rec.module_address === 'string' && rec.module_address ? rec.module_address : 'root'
    const replacePaths = normalizeReplacePaths(change?.replace_paths)
    const mode: 'managed' | 'data' = rec.mode === 'data' ? 'data' : 'managed'
    return [{
      address: typeof rec.address === 'string' ? rec.address : '',
      type,
      name: typeof rec.name === 'string' ? rec.name : '',
      modulePath,
      provider,
      providerDisplayName: shortProviderName(provider),
      service: inferServiceName(type, provider),
      actions,
      actionLabel: label,
      mode,
      actionReason: typeof rec.action_reason === 'string' ? rec.action_reason : '',
      replacePaths,
      changedAttributes: change ? buildAttributeChanges(change) : [],
      beforeIdentity: summarizeValue(change?.before),
      afterIdentity: summarizeValue(change?.after),
      isDestructive: label === 'delete' || label === 'replace',
      isReplacement: label === 'replace' || replacePaths.length > 0
    }].filter((item) => item.address)
  })
  const affectedChanges = planChanges.filter((item) => item.actionLabel !== 'no-op')
  return {
    planChanges,
    lastPlanSummary: {
      ...summary,
      hasChanges: affectedChanges.length > 0,
      affectedResources: affectedChanges.length,
      affectedModules: uniqueStrings(affectedChanges.map((item) => item.modulePath)).sort(),
      affectedProviders: uniqueStrings(affectedChanges.map((item) => item.providerDisplayName || item.provider)).sort(),
      affectedServices: uniqueStrings(affectedChanges.map((item) => item.service)).sort(),
      groups: {
        byModule: summarizePlanGroup('module', affectedChanges.map((change) => ({ key: change.modulePath, label: change.modulePath, change }))),
        byAction: summarizePlanGroup('action', affectedChanges.map((change) => ({ key: change.actionLabel, label: change.actionLabel, change }))),
        byResourceType: summarizePlanGroup('resource-type', affectedChanges.map((change) => ({ key: change.type, label: change.type, change })))
      },
      jsonFieldsUsed: [...PLAN_JSON_FIELDS_USED],
      heuristicNotes: [...PLAN_HEURISTIC_NOTES],
      hasDestructiveChanges: affectedChanges.some((item) => item.isDestructive),
      hasReplacementChanges: affectedChanges.some((item) => item.isReplacement),
      isDeleteHeavy: summary.delete + summary.replace >= Math.max(1, Math.ceil(affectedChanges.length / 2)),
      request
    }
  }
}

/* ── Physical Resource Identity ───────────────────────────── */

const PHYSICAL_ID_KEYS = ['arn', 'id', 'name', 'bucket', 'cluster_identifier', 'db_instance_identifier']

function physicalId(values: Record<string, unknown>): string {
  for (const key of PHYSICAL_ID_KEYS) {
    const val = values[key]
    if (typeof val === 'string' && val) return val
  }
  return '-'
}

/* ── Action Rows (for plan table) ─────────────────────────── */

function buildActionRows(changes: TerraformPlanChange[], inventory: TerraformResourceInventoryItem[]): TerraformActionRow[] {
  const inventoryMap = new Map(inventory.map((i) => [i.address, i]))
  return changes.map((c, idx) => {
    const inv = inventoryMap.get(c.address)
    return {
      order: idx + 1,
      action: c.actionLabel,
      address: c.address,
      resourceType: c.type,
      physicalResourceId: inv ? physicalId(inv.values) : '-'
    }
  })
}

/* ── Resource Rows (for inventory table) ──────────────────── */

function resourceCategory(type: string): string {
  const prefix = type.split('_').slice(0, 2).join('_')
  return prefix || 'unknown'
}

function extractArn(values: Record<string, unknown>): string {
  if (typeof values.arn === 'string' && values.arn) return values.arn
  if (typeof values.id === 'string' && values.id) return values.id
  if (typeof values.self_link === 'string' && values.self_link) return values.self_link
  if (typeof values.resource_id === 'string' && values.resource_id) return values.resource_id
  return ''
}

function extractRegion(values: Record<string, unknown>): string {
  const arn = extractArn(values)
  if (arn) {
    const parts = arn.split(':')
    if (parts.length >= 4 && parts[3]) return parts[3]
  }
  if (typeof values.region === 'string' && values.region) return values.region
  if (typeof values.location === 'string' && values.location) return values.location
  if (typeof values.primary_location === 'string' && values.primary_location) return values.primary_location
  if (typeof values.availability_zone === 'string' && values.availability_zone) {
    return values.availability_zone.replace(/[a-z]$/, '')
  }
  return ''
}

function serializeTags(values: Record<string, unknown>): string {
  const tags = values.tags
  if (!tags || typeof tags !== 'object') return ''
  const entries = Object.entries(tags as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(Object.fromEntries(entries))
}

function buildResourceRows(inventory: TerraformResourceInventoryItem[]): TerraformResourceRow[] {
  return inventory
    .filter((i) => i.mode === 'managed')
    .map((i) => ({
      category: resourceCategory(i.type),
      address: i.address,
      type: i.type,
      arn: extractArn(i.values),
      region: extractRegion(i.values),
      changedBy: '',
      tags: serializeTags(i.values)
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.address.localeCompare(b.address))
}

function inferProjectRegion(
  inventory: TerraformResourceInventoryItem[],
  metadata: TerraformProjectMetadata,
  project: StoredProject,
  connection?: AwsConnection
): string {
  const counts = new Map<string, number>()
  for (const item of inventory) {
    if (item.mode !== 'managed') continue
    const region = extractRegion(item.values)
    if (!region) continue
    counts.set(region, (counts.get(region) ?? 0) + 1)
  }
  const dominantRegion = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
  return dominantRegion || metadata.s3Backend?.region || project.environment?.region || connection?.region || ''
}

/* ── Diagram Builder ──────────────────────────────────────── */

function buildDiagram(
  inventory: TerraformResourceInventoryItem[],
  changes: TerraformPlanChange[],
  rootPath: string
): TerraformDiagram {
  const nodeMap = new Map<string, TerraformGraphNode>()
  const edgeMap = new Map<string, TerraformGraphEdge>()

  function addEdge(edge: TerraformGraphEdge): void {
    const key = `${edge.from}->${edge.to}`
    if (!edgeMap.has(key)) edgeMap.set(key, edge)
  }

  // Nodes from inventory
  for (const item of inventory) {
    nodeMap.set(item.address, { id: item.address, label: buildDiagramNodeLabel(item.address), category: item.type || 'resource' })
    for (const dep of item.dependsOn) {
      addEdge({ from: dep, to: item.address, relation: 'depends_on' })
      if (!nodeMap.has(dep)) nodeMap.set(dep, { id: dep, label: buildDiagramNodeLabel(dep), category: 'dependency' })
    }
  }

  // Nodes from plan changes
  for (const change of changes) {
    nodeMap.set(change.address, {
      id: change.address,
      label: buildDiagramNodeLabel(change.address),
      category: change.actionLabel
    })
  }

  // Static config edges
  const configBlocks = parseConfigBlocks(rootPath)
  for (const edge of buildConfigEdges(configBlocks)) {
    addEdge(edge)
    if (!nodeMap.has(edge.from)) nodeMap.set(edge.from, { id: edge.from, label: buildDiagramNodeLabel(edge.from), category: 'config' })
    if (!nodeMap.has(edge.to)) nodeMap.set(edge.to, { id: edge.to, label: buildDiagramNodeLabel(edge.to), category: 'config' })
  }

  // Saved plan configuration edges capture provider references that do not
  // survive cleanly in state snapshots, especially in Google modules.
  for (const edge of buildPlanConfigEdges(rootPath)) {
    addEdge(edge)
    if (!nodeMap.has(edge.from)) nodeMap.set(edge.from, { id: edge.from, label: buildDiagramNodeLabel(edge.from), category: 'config' })
    if (!nodeMap.has(edge.to)) nodeMap.set(edge.to, { id: edge.to, label: buildDiagramNodeLabel(edge.to), category: 'config' })
  }

  // Dynamic inference edges
  for (const edge of inferDynamicEdges(inventory)) {
    addEdge(edge)
  }

  return { nodes: Array.from(nodeMap.values()), edges: Array.from(edgeMap.values()) }
}

/* ── Variable Passing ─────────────────────────────────────── */

function resolveVarFilePath(varFile: string, rootPath: string): string {
  if (!varFile) return ''
  const resolved = path.isAbsolute(varFile) ? varFile : path.resolve(rootPath, varFile)
  return fs.existsSync(resolved) ? resolved : ''
}

function parseSimpleHclValue(raw: string): unknown {
  const value = raw.trim().replace(/,$/, '').trim()

  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1)
    return inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  return value
}

function stripLineComments(line: string): string {
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const prev = i > 0 ? line[i - 1] : ''

    if (char === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle
      continue
    }
    if (char === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble) {
      if (char === '#') return line.slice(0, i)
      if (char === '/' && line[i + 1] === '/') return line.slice(0, i)
    }
  }

  return line
}

function readVarFileValues(varFilePath: string): Record<string, unknown> {
  if (!varFilePath) return {}
  const lower = varFilePath.toLowerCase()
  if (lower.endsWith('.json') || lower.endsWith('.tfvars.json')) {
    return parseJsonFile<Record<string, unknown>>(varFilePath, {})
  }
  if (!lower.endsWith('.tfvars')) return {}

  const result: Record<string, unknown> = {}
  const lines = readText(varFilePath).split(/\r?\n/)

  for (const rawLine of lines) {
    const line = stripLineComments(rawLine).trim()
    if (!line) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/)
    if (!match) continue
    result[match[1]] = parseSimpleHclValue(match[2])
  }

  return result
}

const DEFAULT_VARIABLE_SET_ID = 'default'
const DEFAULT_VARIABLE_SET_NAME = 'Default'
const COMMON_ENVIRONMENT_OVERLAYS = ['dev', 'stage', 'prod']

function emptyVariableLayer(): TerraformVariableLayer {
  return { varFile: '', variables: {}, secretRefs: {} }
}

function normalizeSecretReference(raw: unknown): TerraformSecretReference | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  return {
    source: item.source === 'ssm-parameter' ? 'ssm-parameter' : 'secrets-manager',
    target: typeof item.target === 'string' ? item.target : '',
    versionId: typeof item.versionId === 'string' ? item.versionId : '',
    jsonKey: typeof item.jsonKey === 'string' ? item.jsonKey : '',
    label: typeof item.label === 'string' ? item.label : ''
  }
}

function normalizeVariableLayer(raw: unknown): TerraformVariableLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyVariableLayer()
  const item = raw as Record<string, unknown>
  const secretRefsRaw = item.secretRefs && typeof item.secretRefs === 'object' && !Array.isArray(item.secretRefs)
    ? item.secretRefs as Record<string, unknown>
    : {}
  const secretRefs = Object.fromEntries(
    Object.entries(secretRefsRaw)
      .map(([key, value]) => [key, normalizeSecretReference(value)])
      .filter((entry): entry is [string, TerraformSecretReference] => Boolean(entry[1]))
  )

  return {
    varFile: typeof item.varFile === 'string' ? item.varFile : '',
    variables: item.variables && typeof item.variables === 'object' && !Array.isArray(item.variables)
      ? item.variables as Record<string, unknown>
      : {},
    secretRefs
  }
}

function createLegacyInputConfig(project: StoredProject): TerraformInputConfiguration {
  const now = new Date().toISOString()
  return {
    selectedVariableSetId: DEFAULT_VARIABLE_SET_ID,
    selectedOverlay: '',
    migratedFromLegacy: true,
    variableSets: [{
      id: DEFAULT_VARIABLE_SET_ID,
      name: DEFAULT_VARIABLE_SET_NAME,
      description: 'Migrated from legacy Terraform input settings.',
      base: {
        varFile: project.varFile ?? '',
        variables: project.variables ?? {},
        secretRefs: {}
      },
      overlays: {},
      createdAt: now,
      updatedAt: now
    }]
  }
}

function normalizeVariableSet(raw: unknown, fallbackIndex = 0): TerraformVariableSet | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const overlaysRaw = item.overlays && typeof item.overlays === 'object' && !Array.isArray(item.overlays)
    ? item.overlays as Record<string, unknown>
    : {}
  const overlays = Object.fromEntries(
    Object.entries(overlaysRaw).map(([key, value]) => [key, normalizeVariableLayer(value)])
  )
  const id = typeof item.id === 'string' && item.id.trim() ? item.id : `${DEFAULT_VARIABLE_SET_ID}-${fallbackIndex + 1}`
  return {
    id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name : `${DEFAULT_VARIABLE_SET_NAME} ${fallbackIndex + 1}`,
    description: typeof item.description === 'string' ? item.description : '',
    base: normalizeVariableLayer(item.base),
    overlays,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : ''
  }
}

function normalizeInputConfig(project: StoredProject): TerraformInputConfiguration {
  const raw = project.inputConfig
  if (!raw || !Array.isArray(raw.variableSets) || raw.variableSets.length === 0) {
    return createLegacyInputConfig(project)
  }

  const variableSets = raw.variableSets
    .map((item, index) => normalizeVariableSet(item, index))
    .filter((item): item is TerraformVariableSet => Boolean(item))

  if (variableSets.length === 0) {
    return createLegacyInputConfig(project)
  }

  const selectedVariableSetId = variableSets.some((item) => item.id === raw.selectedVariableSetId)
    ? raw.selectedVariableSetId
    : variableSets[0].id

  return {
    selectedVariableSetId,
    selectedOverlay: typeof raw.selectedOverlay === 'string' ? raw.selectedOverlay : '',
    migratedFromLegacy: raw.migratedFromLegacy !== false,
    variableSets
  }
}

function getSelectedVariableSet(config: TerraformInputConfiguration): TerraformVariableSet {
  return config.variableSets.find((item) => item.id === config.selectedVariableSetId) ?? config.variableSets[0]
}

function getSelectedOverlayLayer(config: TerraformInputConfiguration, variableSet: TerraformVariableSet): TerraformVariableLayer {
  if (!config.selectedOverlay) return emptyVariableLayer()
  return normalizeVariableLayer(variableSet.overlays[config.selectedOverlay])
}

function listAvailableOverlays(config: TerraformInputConfiguration, variableSet: TerraformVariableSet): string[] {
  return uniqueStrings([
    ...COMMON_ENVIRONMENT_OVERLAYS,
    ...Object.keys(variableSet.overlays),
    config.selectedOverlay
  ]).filter(Boolean)
}

function collectConfiguredInputs(project: StoredProject): {
  config: TerraformInputConfiguration
  variableSet: TerraformVariableSet
  overlayLayer: TerraformVariableLayer
  baseVarFileValues: Record<string, unknown>
  overlayVarFileValues: Record<string, unknown>
  effectiveLocalValues: Record<string, unknown>
  effectiveLocalSources: Record<string, 'var-file' | 'variable-set' | 'environment-overlay'>
  effectiveSecretRefs: Record<string, TerraformSecretReference>
} {
  const config = normalizeInputConfig(project)
  const variableSet = getSelectedVariableSet(config)
  const overlayLayer = getSelectedOverlayLayer(config, variableSet)
  const baseVarFileValues = readVarFileValues(resolveVarFilePath(variableSet.base.varFile, project.rootPath))
  const overlayVarFileValues = readVarFileValues(resolveVarFilePath(overlayLayer.varFile, project.rootPath))

  const effectiveLocalValues: Record<string, unknown> = {}
  const effectiveLocalSources: Record<string, 'var-file' | 'variable-set' | 'environment-overlay'> = {}

  for (const [key, value] of Object.entries(baseVarFileValues)) {
    effectiveLocalValues[key] = value
    effectiveLocalSources[key] = 'var-file'
  }
  for (const [key, value] of Object.entries(variableSet.base.variables)) {
    effectiveLocalValues[key] = value
    effectiveLocalSources[key] = 'variable-set'
  }
  for (const [key, value] of Object.entries(overlayVarFileValues)) {
    effectiveLocalValues[key] = value
    effectiveLocalSources[key] = 'environment-overlay'
  }
  for (const [key, value] of Object.entries(overlayLayer.variables)) {
    effectiveLocalValues[key] = value
    effectiveLocalSources[key] = 'environment-overlay'
  }

  return {
    config,
    variableSet,
    overlayLayer,
    baseVarFileValues,
    overlayVarFileValues,
    effectiveLocalValues,
    effectiveLocalSources,
    effectiveSecretRefs: {
      ...variableSet.base.secretRefs,
      ...overlayLayer.secretRefs
    }
  }
}

function summarizeInputValue(value: unknown, sensitive = false): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (sensitive) return 'Resolved at runtime'
  if (typeof value === 'string') return value.length > 72 ? `${value.slice(0, 69)}...` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const json = JSON.stringify(value)
    return json.length > 72 ? `${json.slice(0, 69)}...` : json
  } catch {
    return String(value)
  }
}

function buildStoredInputValidation(
  project: StoredProject,
  variables: TerraformVariableDefinition[]
): TerraformInputValidationResult {
  const { effectiveLocalValues, effectiveSecretRefs } = collectConfiguredInputs(project)
  const unresolvedSecrets: TerraformUnresolvedSecret[] = Object.entries(effectiveSecretRefs)
    .filter(([, reference]) => !reference.target.trim())
    .map(([name]) => ({ name, reason: 'Secret reference target is required.' }))

  const missing = variables
    .filter((variable) => {
      if (variable.hasDefault) return false
      if (effectiveSecretRefs[variable.name]) return !effectiveSecretRefs[variable.name].target.trim()
      if (!(variable.name in effectiveLocalValues)) return true
      const value = effectiveLocalValues[variable.name]
      if (value === null || value === undefined) return true
      if (typeof value === 'string' && value.trim().length === 0) return true
      return false
    })
    .map((variable) => variable.name)

  return {
    valid: missing.length === 0 && unresolvedSecrets.length === 0,
    missing,
    unresolvedSecrets
  }
}

function buildProjectInputsView(
  project: StoredProject,
  variables: TerraformVariableDefinition[]
): TerraformProjectInputsView {
  const { config, variableSet, overlayLayer, baseVarFileValues, effectiveLocalValues, effectiveLocalSources, effectiveSecretRefs } = collectConfiguredInputs(project)
  const validation = buildStoredInputValidation(project, variables)
  const overlayValues = {
    ...readVarFileValues(resolveVarFilePath(overlayLayer.varFile, project.rootPath)),
    ...overlayLayer.variables
  }
  const allNames = uniqueStrings([
    ...variables.map((item) => item.name),
    ...Object.keys(baseVarFileValues),
    ...Object.keys(variableSet.base.variables),
    ...Object.keys(overlayValues),
    ...Object.keys(effectiveSecretRefs)
  ]).sort((a, b) => a.localeCompare(b))

  const rows = allNames.map((name) => {
    const definition = variables.find((item) => item.name === name)
    const secretRef = effectiveSecretRefs[name] ?? null
    const hasOverlayValue = Object.prototype.hasOwnProperty.call(overlayValues, name)
    const inheritedFrom = hasOverlayValue
      ? (config.selectedOverlay || 'overlay')
      : Object.prototype.hasOwnProperty.call(variableSet.base.variables, name) || Object.prototype.hasOwnProperty.call(baseVarFileValues, name)
        ? variableSet.name
        : ''
    const effectiveSource: TerraformProjectInputRow['effectiveSource'] = secretRef
      ? 'runtime-secret'
      : effectiveLocalSources[name] === 'environment-overlay'
        ? 'environment-overlay'
        : effectiveLocalSources[name] === 'variable-set'
          ? 'variable-set'
          : effectiveLocalSources[name] === 'var-file'
            ? 'var-file'
            : definition?.hasDefault
              ? 'default'
              : 'unset'
    const effectiveSourceLabel = 
        effectiveSource === 'runtime-secret' ? 'AWS runtime secret'
          : effectiveSource === 'environment-overlay' ? `Overlay: ${config.selectedOverlay || 'selected'}`
            : effectiveSource === 'variable-set' ? `Variable set: ${variableSet.name}`
              : effectiveSource === 'var-file' ? 'Var file'
                : effectiveSource === 'default' ? 'Terraform default'
                  : 'Missing'
    const status: TerraformProjectInputRow['status'] = validation.missing.includes(name)
      ? 'missing'
      : validation.unresolvedSecrets.some((item) => item.name === name)
        ? 'unresolved-secret'
        : 'ready'

    return {
      name,
      description: definition?.description ?? '',
      required: Boolean(definition && !definition.hasDefault),
      hasDefault: Boolean(definition?.hasDefault),
      effectiveSource,
      effectiveSourceLabel,
      effectiveValueSummary:
        secretRef
          ? `${secretRef.source === 'ssm-parameter' ? 'SSM' : 'Secrets Manager'}: ${secretRef.label || secretRef.target}`
          : summarizeInputValue(effectiveLocalValues[name]),
      localValueSummary: summarizeInputValue(variableSet.base.variables[name] ?? baseVarFileValues[name]),
      overlayValueSummary: summarizeInputValue(overlayValues[name]),
      inheritedFrom,
      secretRef,
      secretSourceLabel:
        secretRef
          ? `${secretRef.source === 'ssm-parameter' ? 'SSM Parameter' : 'Secrets Manager'}${secretRef.jsonKey ? ` -> ${secretRef.jsonKey}` : ''}`
          : '',
      status,
      isSecret: Boolean(secretRef),
      isSensitive: Boolean(secretRef),
      isMissing: status === 'missing'
    }
  })

  return {
    selectedVariableSetId: variableSet.id,
    selectedVariableSetName: variableSet.name,
    selectedOverlay: config.selectedOverlay,
    availableOverlays: listAvailableOverlays(config, variableSet),
    rows,
    missingRequired: validation.missing,
    unresolvedSecrets: validation.unresolvedSecrets,
    migratedFromLegacy: config.migratedFromLegacy
  }
}

async function resolveRuntimeInputs(
  project: StoredProject,
  variables: TerraformVariableDefinition[],
  connection?: AwsConnection
): Promise<TerraformResolvedRuntimeInputs> {
  const { effectiveLocalValues, effectiveLocalSources, effectiveSecretRefs } = collectConfiguredInputs(project)
  const values = { ...effectiveLocalValues }
  const sources: TerraformResolvedRuntimeInputs['sources'] = Object.fromEntries(
    Object.entries(effectiveLocalSources).map(([key, source]) => [key, source])
  )
  const secretNames: string[] = []
  const unresolvedSecrets: TerraformUnresolvedSecret[] = []

  for (const [name, reference] of Object.entries(effectiveSecretRefs)) {
    if (!reference.target.trim()) {
      unresolvedSecrets.push({ name, reason: 'Secret reference target is required.' })
      continue
    }
    if (!connection) {
      unresolvedSecrets.push({ name, reason: 'An AWS connection is required to resolve runtime secrets.' })
      continue
    }

    try {
      values[name] = await resolveTerraformSecretReference(connection, reference)
      sources[name] = 'runtime-secret'
      secretNames.push(name)
    } catch (error) {
      unresolvedSecrets.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const missingRequired = variables
    .filter((variable) => {
      if (variable.hasDefault) return false
      if (!(variable.name in values)) return true
      const value = values[variable.name]
      if (value === null || value === undefined) return true
      if (typeof value === 'string' && value.trim().length === 0) return true
      return false
    })
    .map((variable) => variable.name)

  return {
    values,
    sources,
    secretNames,
    missingRequired,
    unresolvedSecrets
  }
}

async function validateRuntimeInputs(project: StoredProject, connection?: AwsConnection): Promise<TerraformInputValidationResult> {
  const { variables } = inferMetadata(project.rootPath)
  const resolved = await resolveRuntimeInputs(project, variables, connection)
  return {
    valid: resolved.missingRequired.length === 0 && resolved.unresolvedSecrets.length === 0,
    missing: resolved.missingRequired,
    unresolvedSecrets: resolved.unresolvedSecrets
  }
}

function buildEnvWithVars(
  project: StoredProject,
  profileName: string,
  connection?: AwsConnection,
  runtimeInputs?: TerraformResolvedRuntimeInputs
): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  env.CHECKPOINT_DISABLE = '1'
  env.TF_IN_AUTOMATION = '1'
  // Isolated temp dirs
  const tmpDir = path.join(os.tmpdir(), 'terraform-workspace-cli')
  try { fs.mkdirSync(tmpDir, { recursive: true }) } catch { /* ok */ }
  const cliConfigPath = path.join(tmpDir, '.terraformrc')
  try {
    if (!fs.existsSync(cliConfigPath)) fs.writeFileSync(cliConfigPath, '', 'utf-8')
  } catch { /* ok */ }
  env.TF_CLI_CONFIG_FILE = cliConfigPath

  // Keep the user's native config directories intact so provider CLIs can
  // still discover credentials like GCP ADC under gcloud's default paths.
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
    const adcPath = process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
      : path.join(process.env.HOME ?? os.homedir(), '.config', 'gcloud', 'application_default_credentials.json')
    if (fs.existsSync(adcPath)) {
      env.GOOGLE_APPLICATION_CREDENTIALS = adcPath
    }
  }

  const inputs = runtimeInputs?.values ?? readPersistedInputValues(project)
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === 'string') env[`TF_VAR_${key}`] = value
    else env[`TF_VAR_${key}`] = JSON.stringify(value)
  }

  const providerId = inferTerraformProviderId(profileName, connection)

  if (providerId === 'aws' && connection) {
    delete env.AWS_PROFILE
    delete env.AWS_ACCESS_KEY_ID
    delete env.AWS_SECRET_ACCESS_KEY
    delete env.AWS_SESSION_TOKEN
    Object.assign(env, getConnectionEnv(connection))
  } else if (providerId === 'azure') {
    const azureStore = readAzureFoundationStore()
    const subscriptionId = azureStore.activeSubscriptionId.trim()
    const tenantId = azureStore.activeTenantId.trim()
    const location = connection?.region || project.environment?.region || azureStore.activeLocation.trim()

    if (subscriptionId) env.ARM_SUBSCRIPTION_ID = subscriptionId
    if (tenantId) env.ARM_TENANT_ID = tenantId
    if (location) env.ARM_LOCATION = location
    env.ARM_USE_CLI = 'true'
  }

  return env
}

function writeAutoTfvars(project: StoredProject): void {
  const mergedValues = readPersistedInputValues(project)
  const outputPath = managedInputsPath(project.rootPath)
  const legacyOutputPath = path.join(project.rootPath, '.terraform-workspace.auto.tfvars.json')

  try {
    if (legacyOutputPath !== outputPath && fs.existsSync(legacyOutputPath)) {
      fs.unlinkSync(legacyOutputPath)
    }
  } catch {
    /* ok */
  }

  if (Object.keys(mergedValues).length > 0) {
    fs.writeFileSync(outputPath, JSON.stringify(mergedValues, null, 2) + '\n', 'utf-8')
    return
  }

  try {
    fs.unlinkSync(outputPath)
  } catch {
    /* ok */
  }
}

function readPersistedInputValues(project: StoredProject): Record<string, unknown> {
  return { ...collectConfiguredInputs(project).effectiveLocalValues }
}

function buildEnvironmentMetadata(
  project: StoredProject,
  profileName: string,
  connection: AwsConnection | undefined,
  metadata: TerraformProjectMetadata,
  currentWorkspace: string,
  inventory: TerraformResourceInventoryItem[]
): TerraformProjectEnvironmentMetadata {
  return {
    environmentLabel: inferEnvironmentLabel(currentWorkspace),
    workspaceName: currentWorkspace,
    region: inferProjectRegion(inventory, metadata, project, connection),
    connectionLabel: displayConnectionLabel(profileName, connection) || project.environment?.connectionLabel || '',
    backendType: metadata.backendType,
    varSetLabel: inferVarSetLabel(project) || project.environment?.varSetLabel || ''
  }
}

export function getMissingRequiredInputs(profileName: string, projectId: string): string[] {
  const project = getStoredProjects(profileName).find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')

  const { variables } = inferMetadata(project.rootPath)
  return buildStoredInputValidation(project, variables).missing
}

function writeTemporaryVarFile(rootPath: string, values: Record<string, unknown>, suffix: string): { filePath: string; cleanup: () => void } | null {
  if (Object.keys(values).length === 0) {
    return null
  }

  const tempDir = path.join(os.tmpdir(), 'terraform-workspace-runtime-inputs')
  try {
    fs.mkdirSync(tempDir, { recursive: true })
  } catch {
    /* ok */
  }
  const filePath = path.join(tempDir, `${path.basename(rootPath)}.${suffix}.${randomUUID()}.tfvars.json`)
  fs.writeFileSync(filePath, JSON.stringify(values, null, 2) + '\n', 'utf-8')
  return {
    filePath,
    cleanup: () => {
      try {
        fs.unlinkSync(filePath)
      } catch {
        /* ok */
      }
    }
  }
}

function prepareStateCommandVarFile(project: StoredProject, runtimeInputs?: TerraformResolvedRuntimeInputs): (() => void) | null {
  const mergedValues = runtimeInputs?.values ?? readPersistedInputValues(project)
  if (Object.keys(mergedValues).length === 0) {
    return null
  }

  const tempPath = temporaryStateVarFilePath(project.rootPath)
  const backupPath = `${tempPath}.aws-lens-backup`
  const hadExistingFile = fs.existsSync(tempPath)

  if (hadExistingFile) {
    fs.copyFileSync(tempPath, backupPath)
  }

  fs.writeFileSync(tempPath, JSON.stringify(mergedValues, null, 2) + '\n', 'utf-8')

  return () => {
    try {
      if (hadExistingFile) {
        fs.copyFileSync(backupPath, tempPath)
        fs.unlinkSync(backupPath)
      } else if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
      }
    } catch {
      /* ok */
    }
  }
}

/* ── Child Process Runner ─────────────────────────────────── */

async function runChildProcess(
  cwd: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  onChunk?: (chunk: string) => void,
  options: {
    timeoutMs?: number
    operationName?: string
    context?: Record<string, unknown>
    activeRun?: ActiveTerraformRun
  } = {}
): Promise<{ output: string; exitCode: number }> {
  return await executeOperation(
    options.operationName ?? 'terraform.child-process',
    async () => await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true })
      if (options.activeRun) {
        options.activeRun.child = child
        if (options.activeRun.cancelRequested) {
          terminateChildProcess(child)
        }
      }
      let output = ''
      let timedOut = false
      let settled = false
      const timer = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminateChildProcess(child)
          }, options.timeoutMs)
        : null

      function rejectOnce(error: Error): void {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        reject(error)
      }

      function resolveOnce(result: { output: string; exitCode: number }): void {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(result)
      }

      child.stdout.on('data', (buf) => {
        const chunk = buf.toString()
        output += chunk
        onChunk?.(chunk)
      })

      child.stderr.on('data', (buf) => {
        const chunk = buf.toString()
        output += chunk
        onChunk?.(chunk)
      })

      child.on('error', (err) => {
        if (options.activeRun?.cancelRequested) {
          rejectOnce(new TerraformCommandCancelledError(options.activeRun.cancelMessage || buildCancelledMessage(options.activeRun.command)))
          return
        }
        rejectOnce(err)
      })

      child.on('close', (code) => {
        if (timedOut) {
          rejectOnce(new OperationTimeoutError(`${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms.`))
          return
        }

        if (options.activeRun?.cancelRequested) {
          rejectOnce(new TerraformCommandCancelledError(options.activeRun.cancelMessage || buildCancelledMessage(options.activeRun.command)))
          return
        }

        resolveOnce({ output, exitCode: code ?? -1 })
      })
    }),
    {
      context: {
        cwd,
        command,
        args: redactArgs(args),
        ...(options.context ?? {})
      }
    }
  )
}

/* ── Project Loading ──────────────────────────────────────── */

function projectStatus(rootPath: string): TerraformProjectStatus {
  return fs.existsSync(rootPath) ? 'Ready' : 'Missing'
}

function loadProject(project: StoredProject, profileName = '', connection?: AwsConnection): TerraformProject {
  const status = projectStatus(project.rootPath)
  if (status === 'Missing') {
    const stateBackups = listStateBackups(project.id)
    const emptyMeta: TerraformProjectMetadata = {
      terraformVersionConstraint: '', backendType: 'local', backend: {
        type: 'local',
        label: path.join(project.rootPath, 'terraform.tfstate'),
        stateLocation: path.join(project.rootPath, 'terraform.tfstate')
      }, git: null, providerNames: [],
      resourceCount: 0, moduleCount: 0, variableCount: 0, outputsCount: 0, tfFileCount: 0,
      lastScannedAt: '', s3Backend: null
    }
    const currentWorkspace = project.environment?.workspaceName || 'default'
    const inputConfig = normalizeInputConfig(project)
    const inputValidation = { valid: true, missing: [], unresolvedSecrets: [] }
    return {
      id: project.id, name: project.name, rootPath: project.rootPath,
      varFile: getSelectedVariableSet(inputConfig).base.varFile ?? '',
      variables: readPersistedInputValues(project),
      inputConfig,
      inputView: {
        selectedVariableSetId: inputConfig.selectedVariableSetId,
        selectedVariableSetName: getSelectedVariableSet(inputConfig).name,
        selectedOverlay: inputConfig.selectedOverlay,
        availableOverlays: listAvailableOverlays(inputConfig, getSelectedVariableSet(inputConfig)),
        rows: [],
        missingRequired: [],
        unresolvedSecrets: [],
        migratedFromLegacy: inputConfig.migratedFromLegacy
      },
      inputValidation,
      environment: buildEnvironmentMetadata(project, profileName, connection, emptyMeta, currentWorkspace, []),
      status: 'Missing', inputsFilePath: managedInputsPath(project.rootPath),
      workspaces: [{ name: currentWorkspace, isCurrent: true }],
      currentWorkspace,
      detectedVariables: [], inputs: {}, metadata: emptyMeta,
      inventory: [], planChanges: [], actionRows: [], resourceRows: [],
      diagram: { nodes: [], edges: [] },
      lastPlanSummary: emptyPlanSummary(readPlanOptions(project.rootPath)),
      lastCommandAt: commandLogs.get(project.id)?.[0]?.startedAt ?? '',
      stateAddresses: [], rawStateJson: '', stateSource: 'none',
      stateBackups,
      latestStateBackup: stateBackups[0] ?? null,
      stateLockInfo: null,
      hasSavedPlan: savedPlanPaths.has(project.id) || hasSavedPlanArtifacts(project.rootPath),
      savedPlanMetadata: readPlanMetadata(project.rootPath)
    }
  }

  const { metadata, variables } = inferMetadata(project.rootPath)
  const { currentWorkspace, workspaces } = readWorkspaceSnapshot(profileName, project, connection)
  const inputs = parseJsonFile<Record<string, unknown>>(managedInputsPath(project.rootPath), {})
  const { inventory, stateAddresses, rawStateJson, stateSource } = readStateSnapshot(project.rootPath)
  const { planChanges, lastPlanSummary } = readPlanSnapshot(project.rootPath)
  const actionRows = buildActionRows(planChanges, inventory)
  const resourceRows = buildResourceRows(inventory)
  const diagram = buildTerraformDiagram(inventory, planChanges, project.rootPath)
  const environment = buildEnvironmentMetadata(project, profileName, connection, metadata, currentWorkspace, inventory)
  const stateBackups = listStateBackups(project.id)
  const stateLockInfo = readStateLockInfo(project.rootPath, metadata.backendType)
  const inputConfig = normalizeInputConfig(project)
  const inputView = buildProjectInputsView(project, variables)
  const inputValidation = buildStoredInputValidation(project, variables)

  return {
    id: project.id, name: project.name, rootPath: project.rootPath,
    varFile: getSelectedVariableSet(inputConfig).base.varFile ?? '',
    variables: readPersistedInputValues(project),
    inputConfig,
    inputView,
    inputValidation,
    environment,
    status, inputsFilePath: managedInputsPath(project.rootPath),
    workspaces,
    currentWorkspace,
    detectedVariables: variables, inputs, metadata,
    inventory, planChanges, actionRows, resourceRows, diagram,
    lastPlanSummary, lastCommandAt: commandLogs.get(project.id)?.[0]?.startedAt ?? '',
    stateAddresses, rawStateJson, stateSource,
    stateBackups,
    latestStateBackup: stateBackups[0] ?? null,
    stateLockInfo,
    hasSavedPlan: savedPlanPaths.has(project.id) || hasSavedPlanArtifacts(project.rootPath),
    savedPlanMetadata: readPlanMetadata(project.rootPath)
  }
}

/* ── Public API ────────────────────────────────────────────── */

function normalizeStored(raw: Record<string, unknown>): StoredProject | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.rootPath !== 'string') return null
  const normalized: StoredProject = {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : path.basename(raw.rootPath as string),
    rootPath: raw.rootPath as string,
    varFile: typeof raw.varFile === 'string' ? raw.varFile : '',
    variables: (raw.variables && typeof raw.variables === 'object' && !Array.isArray(raw.variables)) ? raw.variables as Record<string, unknown> : {},
    inputConfig: raw.inputConfig && typeof raw.inputConfig === 'object' && !Array.isArray(raw.inputConfig)
      ? raw.inputConfig as TerraformInputConfiguration
      : undefined,
    environment: (raw.environment && typeof raw.environment === 'object' && !Array.isArray(raw.environment))
      ? raw.environment as TerraformProjectEnvironmentMetadata
      : undefined
  }
  normalized.inputConfig = normalizeInputConfig(normalized)
  return normalized
}

function validateWorkspaceName(workspaceName: string): string {
  const trimmed = workspaceName.trim()
  if (!trimmed) throw new Error('Workspace name is required.')
  if (/\s/.test(trimmed)) throw new Error('Workspace names cannot contain whitespace.')
  return trimmed
}

async function runWorkspaceCommand(
  profileName: string,
  project: StoredProject,
  args: string[],
  connection?: AwsConnection
): Promise<void> {
  const env = buildEnvWithVars(project, profileName, connection)
  const result = await runChildProcess(project.rootPath, terraformCommand(), args, env)
  if (result.exitCode !== 0) {
    throw new Error(stripAnsi(result.output).trim() || `Terraform ${args.join(' ')} failed.`)
  }
}

function getStoredProjects(profileName: string): StoredProject[] {
  return (getProjects(profileName) as unknown as Record<string, unknown>[])
    .map(normalizeStored)
    .filter((p): p is StoredProject => p !== null)
}

function setStoredProjects(profileName: string, projects: StoredProject[]): void {
  setProjects(profileName, projects as unknown as Array<{ id: string; name: string; rootPath: string }>)
}

function syncStoredProjectEnvironment(
  profileName: string,
  projectId: string,
  environment: TerraformProjectEnvironmentMetadata
): void {
  const stored = getStoredProjects(profileName)
  const next = stored.map((project) => project.id === projectId ? { ...project, environment } : project)
  setStoredProjects(profileName, next)
}

export function listProjectSummaries(profileName: string, connection?: AwsConnection): TerraformProjectListItem[] {
  return getStoredProjects(profileName).map((project) => {
    const loaded = loadProject(project, profileName, connection)
    syncStoredProjectEnvironment(profileName, project.id, loaded.environment)
    return loaded
  })
}

export function getProject(profileName: string, projectId: string, connection?: AwsConnection): TerraformProject {
  const project = getStoredProjects(profileName).find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  const loaded = loadProject(project, profileName, connection)
  syncStoredProjectEnvironment(profileName, project.id, loaded.environment)
  return loaded
}

export function addProject(profileName: string, rootPath: string, connection?: AwsConnection): TerraformProject {
  const normalized = path.resolve(rootPath)
  if (!fs.existsSync(normalized)) throw new Error('Selected path does not exist.')
  if (!fs.statSync(normalized).isDirectory()) throw new Error('Project path must be a directory.')
  if (listTerraformFiles(normalized).length === 0) throw new Error('No Terraform files were found in the selected directory.')

  const stored = getStoredProjects(profileName)
  const existing = stored.find((p) => path.normalize(p.rootPath).toLowerCase() === path.normalize(normalized).toLowerCase())
  if (existing) return getProject(profileName, existing.id, connection)

  const created: StoredProject = {
    id: randomUUID(), name: path.basename(normalized), rootPath: normalized, varFile: '', variables: {}
  }
  setStoredProjects(profileName, [...stored, created])
  return getProject(profileName, created.id, connection)
}

export function removeProject(profileName: string, projectId: string): void {
  setStoredProjects(profileName, getStoredProjects(profileName).filter((p) => p.id !== projectId))
  commandLogs.delete(projectId)
  savedPlanPaths.delete(projectId)
}

export function renameProject(profileName: string, projectId: string, name: string): TerraformProject {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Project name is required.')
  const updated = getStoredProjects(profileName).map((p) => p.id === projectId ? { ...p, name: trimmed } : p)
  setStoredProjects(profileName, updated)
  return getProject(profileName, projectId)
}

export function updateProjectInputs(
  profileName: string,
  projectId: string,
  inputConfig: TerraformInputConfiguration,
  connection?: AwsConnection
): TerraformProject {
  const stored = getStoredProjects(profileName)
  const idx = stored.findIndex((p) => p.id === projectId)
  if (idx < 0) throw new Error('Project not found.')
  const project = stored[idx]
  project.inputConfig = normalizeInputConfig({
    ...project,
    inputConfig
  })
  const selectedSet = getSelectedVariableSet(project.inputConfig)
  project.varFile = selectedSet.base.varFile
  project.variables = readPersistedInputValues(project)
  writeAutoTfvars(project)
  setStoredProjects(profileName, stored)
  return getProject(profileName, projectId, connection)
}

export async function validateProjectInputs(
  profileName: string,
  projectId: string,
  connection?: AwsConnection
): Promise<TerraformInputValidationResult> {
  const project = getStoredProjects(profileName).find((item) => item.id === projectId)
  if (!project) throw new Error('Project not found.')
  return validateRuntimeInputs(project, connection)
}

export async function selectProjectWorkspace(
  profileName: string,
  projectId: string,
  workspaceName: string,
  connection?: AwsConnection
): Promise<TerraformProject> {
  const project = getStoredProjects(profileName).find((item) => item.id === projectId)
  if (!project) throw new Error('Project not found.')
  const target = validateWorkspaceName(workspaceName)
  await runWorkspaceCommand(profileName, project, ['workspace', 'select', target], connection)
  clearStateCache(project.rootPath)
  syncStoredProjectEnvironment(profileName, projectId, {
    environmentLabel: inferEnvironmentLabel(target),
    workspaceName: target,
    region: connection?.region ?? project.environment?.region ?? '',
    connectionLabel: displayConnectionLabel(profileName, connection) || project.environment?.connectionLabel || '',
    backendType: project.environment?.backendType ?? 'local',
    varSetLabel: inferVarSetLabel(project) || project.environment?.varSetLabel || ''
  })
  return getProject(profileName, projectId, connection)
}

export async function createProjectWorkspace(
  profileName: string,
  projectId: string,
  workspaceName: string,
  connection?: AwsConnection
): Promise<TerraformProject> {
  const project = getStoredProjects(profileName).find((item) => item.id === projectId)
  if (!project) throw new Error('Project not found.')
  const target = validateWorkspaceName(workspaceName)
  await runWorkspaceCommand(profileName, project, ['workspace', 'new', target], connection)
  clearStateCache(project.rootPath)
  return getProject(profileName, projectId, connection)
}

export async function deleteProjectWorkspace(
  profileName: string,
  projectId: string,
  workspaceName: string,
  connection?: AwsConnection
): Promise<TerraformProject> {
  const project = getStoredProjects(profileName).find((item) => item.id === projectId)
  if (!project) throw new Error('Project not found.')
  const target = validateWorkspaceName(workspaceName)
  if (target === 'default') {
    throw new Error('The default workspace cannot be deleted.')
  }
  const snapshot = readWorkspaceSnapshot(profileName, project, connection)
  if (snapshot.currentWorkspace === target) {
    throw new Error('Select a different workspace before deleting the current workspace.')
  }
  await runWorkspaceCommand(profileName, project, ['workspace', 'delete', target], connection)
  clearStateCache(project.rootPath)
  return getProject(profileName, projectId, connection)
}

export function getCommandLogs(projectId: string): TerraformCommandLog[] {
  return commandLogs.get(projectId) ?? []
}

/* ── Missing variable detection ───────────────────────────── */

export function detectMissingVars(output: string): TerraformMissingVarsResult {
  const missing = new Set<string>()

  for (const m of output.matchAll(/The root module input variable "([^"]+)" is not set/g)) {
    missing.add(m[1])
  }

  for (const m of output.matchAll(/No value for required variable[\s\S]*?variable "([^"]+)" \{/g)) {
    missing.add(m[1])
  }

  return { missing: [...missing], invalid: [] }
}

/* ── CloudTrail ChangedBy Enrichment ──────────────────────── */

const TF_TYPE_TO_CT_SERVICE: Record<string, string> = {
  aws_instance: 'ec2', aws_security_group: 'ec2', aws_vpc: 'ec2', aws_subnet: 'ec2',
  aws_eip: 'ec2', aws_network_interface: 'ec2', aws_internet_gateway: 'ec2',
  aws_nat_gateway: 'ec2', aws_route_table: 'ec2', aws_route: 'ec2',
  aws_s3_bucket: 's3', aws_s3_bucket_policy: 's3', aws_s3_bucket_acl: 's3',
  aws_rds_cluster: 'rds', aws_db_instance: 'rds', aws_db_subnet_group: 'rds',
  aws_eks_cluster: 'eks', aws_eks_node_group: 'eks',
  aws_ecs_cluster: 'ecs', aws_ecs_service: 'ecs', aws_ecs_task_definition: 'ecs',
  aws_lb: 'elasticloadbalancing', aws_alb: 'elasticloadbalancing',
  aws_lb_target_group: 'elasticloadbalancing', aws_lb_listener: 'elasticloadbalancing',
  aws_lambda_function: 'lambda', aws_lambda_permission: 'lambda',
  aws_iam_role: 'iam', aws_iam_policy: 'iam', aws_iam_user: 'iam',
  aws_cloudwatch_log_group: 'logs', aws_cloudwatch_metric_alarm: 'cloudwatch',
  aws_route53_zone: 'route53', aws_route53_record: 'route53',
  aws_kms_key: 'kms', aws_kms_alias: 'kms',
  aws_sns_topic: 'sns', aws_sqs_queue: 'sqs',
  aws_acm_certificate: 'acm', aws_secretsmanager_secret: 'secretsmanager',
  aws_wafv2_web_acl: 'wafv2'
}

function cloudTrailServiceForType(tfType: string): string {
  if (TF_TYPE_TO_CT_SERVICE[tfType]) return TF_TYPE_TO_CT_SERVICE[tfType]
  if (tfType.startsWith('aws_ec2') || tfType.startsWith('aws_vpc') || tfType.startsWith('aws_subnet')
    || tfType.startsWith('aws_network') || tfType.startsWith('aws_eip') || tfType.startsWith('aws_route')
    || tfType.startsWith('aws_internet') || tfType.startsWith('aws_nat') || tfType.startsWith('aws_key_pair')) return 'ec2'
  if (tfType.startsWith('aws_s3')) return 's3'
  if (tfType.startsWith('aws_rds') || tfType.startsWith('aws_db')) return 'rds'
  if (tfType.startsWith('aws_eks')) return 'eks'
  if (tfType.startsWith('aws_ecs')) return 'ecs'
  if (tfType.startsWith('aws_lb') || tfType.startsWith('aws_alb') || tfType.startsWith('aws_elb')) return 'elasticloadbalancing'
  if (tfType.startsWith('aws_lambda')) return 'lambda'
  if (tfType.startsWith('aws_iam')) return 'iam'
  if (tfType.startsWith('aws_cloudwatch')) return 'cloudwatch'
  if (tfType.startsWith('aws_sns')) return 'sns'
  if (tfType.startsWith('aws_sqs')) return 'sqs'
  if (tfType.startsWith('aws_kms')) return 'kms'
  if (tfType.startsWith('aws_acm')) return 'acm'
  if (tfType.startsWith('aws_secretsmanager')) return 'secretsmanager'
  if (tfType.startsWith('aws_waf')) return 'wafv2'
  if (tfType.startsWith('aws_route53')) return 'route53'
  return ''
}

export { cloudTrailServiceForType }

/* ── Command Execution ────────────────────────────────────── */

function pushLog(projectId: string, log: TerraformCommandLog): void {
  const logs = commandLogs.get(projectId) ?? []
  logs.unshift(log)
  commandLogs.set(projectId, logs.slice(0, COMMAND_LOG_CAP_PER_PROJECT))
}

async function runTerraformShowJson(rootPath: string, planPath: string, env: Record<string, string>): Promise<void> {
  const jsonPath = `${planPath}.json`
  const { output } = await runChildProcess(rootPath, terraformCommand(), ['show', '-json', planPath], env)
  fs.writeFileSync(jsonPath, output, 'utf-8')
}

function clearSavedPlanArtifacts(rootPath: string): void {
  for (const filePath of [planPath(rootPath), planJsonPath(rootPath), planMetadataPath(rootPath)]) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* ok */
    }
  }
}

function clearStateCache(rootPath: string): void {
  try {
    fs.unlinkSync(stateCachePath(rootPath))
  } catch {
    /* ok */
  }
}

async function refreshRemoteStateCache(rootPath: string, env: Record<string, string>): Promise<boolean> {
  try {
    const result = await runChildProcess(rootPath, terraformCommand(), ['state', 'pull'], env)
    if (result.exitCode === 0 && result.output.trim()) {
      fs.writeFileSync(stateCachePath(rootPath), result.output, 'utf-8')
      return true
    }
  } catch {
    /* keep previous cache */
  }
  return false
}

function buildArgs(request: TerraformCommandRequest, project: StoredProject, runtimeVarFilePath = ''): string[] {
  const varFileArgs: string[] = []
  const { variableSet, overlayLayer } = collectConfiguredInputs(project)
  const resolvedBase = resolveVarFilePath(variableSet.base.varFile, project.rootPath)
  const resolvedOverlay = resolveVarFilePath(overlayLayer.varFile, project.rootPath)
  if (resolvedBase) varFileArgs.push('-var-file', resolvedBase)
  if (resolvedOverlay) varFileArgs.push('-var-file', resolvedOverlay)
  const inputsFile = managedInputsPath(project.rootPath)
  if (fs.existsSync(inputsFile)) varFileArgs.push('-var-file', inputsFile)
  if (runtimeVarFilePath) varFileArgs.push('-var-file', runtimeVarFilePath)
  const planOptions = normalizePlanOptions(request.planOptions)

  switch (request.command) {
    case 'version':
      return ['version']
    case 'init':
      return ['init', '-input=false', '-no-color']
    case 'plan':
      if (planOptions.mode === 'targeted' && planOptions.targets.length === 0) {
        throw new Error('Targeted plan requires at least one resource address.')
      }
      if (planOptions.mode === 'replace' && planOptions.replaceAddresses.length === 0) {
        throw new Error('Replace plan requires at least one resource address.')
      }
      return [
        'plan',
        '-input=false',
        '-no-color',
        '-detailed-exitcode',
        '-out',
        PLAN_FILE,
        ...(planOptions.mode === 'refresh-only' ? ['-refresh-only'] : []),
        ...planOptions.targets.flatMap((target) => ['-target', target]),
        ...planOptions.replaceAddresses.flatMap((address) => ['-replace', address]),
        ...varFileArgs
      ]
    case 'apply': {
      const planPath = path.join(project.rootPath, PLAN_FILE)
      if (fs.existsSync(planPath)) {
        return ['apply', '-input=false', '-no-color', '-auto-approve', PLAN_FILE]
      }
      return ['apply', '-input=false', '-no-color', '-auto-approve', ...varFileArgs]
    }
    case 'destroy':
      return ['destroy', '-input=false', '-no-color', '-auto-approve', ...varFileArgs]
    case 'import':
      if (!request.importAddress?.trim()) throw new Error('Resource address is required for import.')
      if (!request.importId?.trim()) throw new Error('Import ID is required.')
      return ['import', '-input=false', '-no-color', ...varFileArgs, request.importAddress.trim(), request.importId.trim()]
    case 'state-mv':
      if (!request.stateFromAddress?.trim()) throw new Error('Source address is required for state move.')
      if (!request.stateToAddress?.trim()) throw new Error('Destination address is required for state move.')
      return ['state', 'mv', '-lock=true', request.stateFromAddress.trim(), request.stateToAddress.trim()]
    case 'state-rm':
      if (!request.stateAddress?.trim()) throw new Error('State address is required for state remove.')
      return ['state', 'rm', '-lock=true', request.stateAddress.trim()]
    case 'force-unlock':
      if (!request.lockId?.trim()) throw new Error('Lock ID is required for force unlock.')
      return ['force-unlock', '-force', request.lockId.trim()]
    case 'state-list':
      return ['state', 'list']
    case 'state-pull':
      return ['state', 'pull']
    case 'state-show':
      if (!request.stateAddress?.trim()) throw new Error('State address is required for state show.')
      return ['state', 'show', request.stateAddress.trim()]
  }
}

/* Parse progress lines from streamed terraform output */
function parseProgressLine(raw: string): { address: string; status: string } | null {
  const clean = stripAnsi(raw).trim()
  // Match patterns like: aws_instance.web: Creating... or aws_instance.web: Destruction complete
  const match = clean.match(/^([\w._[\]]+):\s+(.+)$/)
  if (match) return { address: match[1], status: match[2] }
  return null
}

function commandTimeoutMs(command: TerraformCommandRequest['command']): number {
  switch (command) {
    case 'plan':
      return 15 * 60 * 1000
    case 'apply':
    case 'destroy':
      return 30 * 60 * 1000
    case 'init':
    case 'import':
      return 10 * 60 * 1000
    case 'state-list':
    case 'state-pull':
    case 'state-show':
    case 'state-mv':
    case 'state-rm':
    case 'force-unlock':
      return 2 * 60 * 1000
    case 'version':
      return 30 * 1000
    default:
      return 5 * 60 * 1000
  }
}

export async function runProjectCommand(
  request: TerraformCommandRequest,
  window: BrowserWindow | null
): Promise<TerraformCommandLog> {
  const stored = getStoredProjects(request.profileName)
  const project = stored.find((p) => p.id === request.projectId)
  if (!project) throw new Error('Project not found.')

  // Ensure auto.tfvars is written before commands that need it
  if (['init', 'plan', 'apply', 'destroy', 'import', 'state-list', 'state-pull', 'state-show'].includes(request.command)) {
    writeAutoTfvars(project)
  }
  if (request.command === 'plan') {
    savedPlanPaths.delete(project.id)
    clearSavedPlanArtifacts(project.rootPath)
  }

  const commandsNeedingRuntimeInputs = new Set<TerraformCommandRequest['command']>([
    'plan',
    'apply',
    'destroy',
    'import',
    'state-list',
    'state-pull',
    'state-show'
  ])
  const runtimeInputs = commandsNeedingRuntimeInputs.has(request.command)
    ? await resolveRuntimeInputs(project, inferMetadata(project.rootPath).variables, request.connection)
    : undefined

  if (runtimeInputs && (runtimeInputs.missingRequired.length > 0 || runtimeInputs.unresolvedSecrets.length > 0)) {
    const details = [
      runtimeInputs.missingRequired.length > 0 ? `Missing required inputs: ${runtimeInputs.missingRequired.join(', ')}` : '',
      runtimeInputs.unresolvedSecrets.length > 0
        ? `Unresolved runtime secrets: ${runtimeInputs.unresolvedSecrets.map((item) => `${item.name} (${item.reason})`).join(', ')}`
        : ''
    ].filter(Boolean).join('\n')
    throw new Error(details)
  }

  const runtimeVarFile = ['plan', 'apply', 'destroy', 'import'].includes(request.command)
    ? writeTemporaryVarFile(project.rootPath, runtimeInputs?.secretNames.length ? runtimeInputs.values : {}, 'runtime-inputs')
    : null
  const args = buildArgs(request, project, runtimeVarFile?.filePath ?? '')
    const env = buildEnvWithVars(project, request.profileName, request.connection, runtimeInputs)
  const cleanupStateVarFile = ['state-list', 'state-pull', 'state-show', 'state-mv', 'state-rm', 'force-unlock'].includes(request.command)
    ? prepareStateCommandVarFile(project, runtimeInputs)
    : null
  const gitMetadata = detectGitMetadata(project.rootPath)
  const gitCommitMetadata = toGitCommitMetadata(gitMetadata)
  const stateBackupRequired = request.command === 'state-mv' || request.command === 'state-rm'
  const stateOperationSummary =
    request.command === 'import'
      ? `${request.importAddress?.trim() ?? ''} <= ${request.importId?.trim() ?? ''}`
      : request.command === 'state-mv'
        ? `${request.stateFromAddress?.trim() ?? ''} -> ${request.stateToAddress?.trim() ?? ''}`
        : request.command === 'state-rm'
          ? request.stateAddress?.trim() ?? ''
          : request.command === 'force-unlock'
            ? request.lockId?.trim() ?? ''
            : ''
  let backupSummary: TerraformStateBackupSummary | null = null
  const log: TerraformCommandLog = {
    id: randomUUID(), projectId: request.projectId, command: request.command,
    args, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    success: null, output: ''
  }

  pushLog(request.projectId, log)
  emit(window, { type: 'started', projectId: request.projectId, log })

  if (activeTerraformRuns.has(request.projectId)) {
    throw new Error(
      `A Terraform ${activeTerraformRuns.get(request.projectId)!.command} is already running for this project. Wait for it to finish before starting a new one.`
    )
  }

  // Persist run record to history store
  const currentWorkspace = readText(path.join(project.rootPath, '.terraform', 'environment')).trim() || 'default'
  const runRecord: TerraformRunRecord = {
    id: log.id,
    projectId: request.projectId,
    projectName: project.name,
    command: request.command,
    args: redactArgs(args),
    workspace: currentWorkspace,
    region: request.connection?.region ?? project.environment?.region ?? '',
    connectionLabel: displayConnectionLabel(request.profileName, request.connection),
    backendType: project.environment?.backendType ?? 'local',
    stateSource: '',
    startedAt: log.startedAt,
    finishedAt: null,
    exitCode: null,
    success: null,
    planSummary: null,
    planJsonPath: '',
    backupPath: '',
    backupCreatedAt: '',
    stateOperationSummary,
    git: gitCommitMetadata
  }
  saveRunRecord(runRecord, '')

  const activeRun: ActiveTerraformRun = {
    projectId: request.projectId,
    logId: log.id,
    command: request.command,
    child: null,
    cancelRequested: false,
    cancelMessage: ''
  }
  activeTerraformRuns.set(request.projectId, activeRun)

  if (request.command === 'apply' || request.command === 'destroy') {
    activeDestructiveCommands.set(request.projectId, request.command)
  }

  let lastProgressTime = 0

  try {
    if (stateBackupRequired) {
      backupSummary = await createStateBackup(project, env)
      log.output += `[backup] Saved Terraform state backup to ${backupSummary.path}\n`
      emit(window, { type: 'output', projectId: request.projectId, logId: log.id, chunk: `[backup] Saved Terraform state backup to ${backupSummary.path}\n` })
      updateRunRecord(log.id, {
        backupPath: backupSummary.path,
        backupCreatedAt: backupSummary.createdAt
      }, log.output)
    }

    const result = await runChildProcess(project.rootPath, terraformCommand(), args, env, (chunk) => {
      log.output += chunk
      emit(window, { type: 'output', projectId: request.projectId, logId: log.id, chunk })

      // Parse progress for streamed commands
      if (request.command === 'apply' || request.command === 'destroy') {
        const lines = stripAnsi(chunk).split('\n')
        const now = Date.now()
        for (const line of lines) {
          const progress = parseProgressLine(line)
          if (progress) {
            const isImportant = /complete|error|creating|destroying/i.test(progress.status)
            if (isImportant || now - lastProgressTime > 500) {
              lastProgressTime = now
              emit(window, { type: 'progress', projectId: request.projectId, address: progress.address, status: progress.status, raw: line.trim() })
            }
          }
          // Always surface final messages
          if (/Apply complete!|Destroy complete!|Error:/i.test(line)) {
            emit(window, { type: 'progress', projectId: request.projectId, address: '', status: line.trim(), raw: line.trim() })
          }
        }
      }
    }, {
      timeoutMs: commandTimeoutMs(request.command),
      operationName: `terraform.${request.command}`,
      activeRun,
      context: {
        projectId: request.projectId,
        projectName: project.name,
        workspace: currentWorkspace
      }
    })

    log.exitCode = result.exitCode
    log.finishedAt = new Date().toISOString()
    // plan with -detailed-exitcode: 0=no changes, 2=changes present, both are success
    log.success = request.command === 'plan'
      ? (result.exitCode === 0 || result.exitCode === 2)
      : result.exitCode === 0

    // Post-command actions
    if (request.command === 'plan' && log.success) {
      writePlanMetadata(project.rootPath, request.planOptions, gitCommitMetadata)
      await runTerraformShowJson(project.rootPath, planPath(project.rootPath), env)
      savedPlanPaths.set(project.id, planPath(project.rootPath))
    }
    if (request.command === 'apply' || request.command === 'destroy') {
      savedPlanPaths.delete(project.id)
      clearSavedPlanArtifacts(project.rootPath)
      if (result.exitCode === 0) {
        const refreshed = await refreshRemoteStateCache(project.rootPath, env)
        if (request.command === 'destroy' && !refreshed) {
          clearStateCache(project.rootPath)
        }
      }
    }
      if (['import', 'state-mv', 'state-rm', 'force-unlock'].includes(request.command) && result.exitCode === 0) {
        const refreshed = await refreshRemoteStateCache(project.rootPath, env)
        if (!refreshed && request.command === 'state-rm') {
          clearStateCache(project.rootPath)
        }
      if (request.command === 'import' || request.command === 'state-mv' || request.command === 'state-rm') {
        clearSavedPlanArtifacts(project.rootPath)
          savedPlanPaths.delete(project.id)
        }
      }
      if (
        result.exitCode === 0 &&
        ['apply', 'destroy', 'import', 'state-mv', 'state-rm'].includes(request.command)
      ) {
        invalidateTerraformDriftReports(request.profileName, request.projectId)
      }
      if (request.command === 'state-pull' && result.exitCode === 0 && log.output.trim()) {
        fs.writeFileSync(stateCachePath(project.rootPath), log.output, 'utf-8')
      }

    const refreshedProject = getProject(request.profileName, request.projectId, request.connection)
    emit(window, { type: 'completed', projectId: request.projectId, log, project: refreshedProject })

    // Update history record on success
    const planSummary = refreshedProject?.lastPlanSummary ?? null
    const hasPlanChanges = planSummary && (planSummary.create > 0 || planSummary.update > 0 || planSummary.delete > 0 || planSummary.replace > 0)
    updateRunRecord(log.id, {
      finishedAt: log.finishedAt,
      exitCode: log.exitCode,
      success: log.success,
      stateSource: refreshedProject?.stateSource ?? '',
      planSummary: hasPlanChanges ? planSummary : null,
      backupPath: backupSummary?.path ?? '',
      backupCreatedAt: backupSummary?.createdAt ?? '',
      planJsonPath: (request.command === 'plan' && log.success && fs.existsSync(planJsonPath(project.rootPath)))
        ? planJsonPath(project.rootPath) : ''
    }, log.output)

    return log
  } catch (error) {
    log.finishedAt = new Date().toISOString()
    log.exitCode = error instanceof TerraformCommandCancelledError ? 130 : -1
    log.success = false
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (!log.output.includes(errorMessage)) {
      log.output += `${log.output.endsWith('\n') || !log.output ? '' : '\n'}${errorMessage}`
    }
    emit(window, { type: 'completed', projectId: request.projectId, log, project: getProject(request.profileName, request.projectId, request.connection) })

    // Update history record on error
    updateRunRecord(log.id, {
      finishedAt: log.finishedAt,
      exitCode: log.exitCode,
      success: log.success,
      backupPath: backupSummary?.path ?? '',
      backupCreatedAt: backupSummary?.createdAt ?? ''
    }, log.output)

    return log
  } finally {
    runtimeVarFile?.cleanup()
    cleanupStateVarFile?.()
    const trackedRun = activeTerraformRuns.get(request.projectId)
    if (trackedRun?.logId === log.id) {
      activeTerraformRuns.delete(request.projectId)
    }
    if (request.command === 'apply' || request.command === 'destroy') {
      activeDestructiveCommands.delete(request.projectId)
    }
  }
}

export function cancelProjectCommand(projectId: string): boolean {
  const activeRun = activeTerraformRuns.get(projectId)
  if (!activeRun) return false
  if (activeRun.cancelRequested) return true

  activeRun.cancelRequested = true
  activeRun.cancelMessage = buildCancelledMessage(activeRun.command)
  terminateChildProcess(activeRun.child)
  return true
}

export function hasActiveTerraformApplyOrDestroy(): boolean {
  return activeDestructiveCommands.size > 0
}

export function hasSavedPlan(projectId: string): boolean {
  return savedPlanPaths.has(projectId)
}

export function clearSavedPlan(projectId: string): void {
  savedPlanPaths.delete(projectId)
}

export function getProjectContext(profileName: string, projectId: string, connection?: AwsConnection): {
  rootPath: string
  env: Record<string, string>
  tfCliPath: string
  tfCliLabel: string
  tfCliKind: TerraformCliKind | ''
} {
  const project = getStoredProjects(profileName).find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  return {
    rootPath: project.rootPath,
    env: buildEnvWithVars(project, profileName, connection),
    tfCliPath: terraformCommand(),
    tfCliLabel: terraformCliLabel(),
    tfCliKind: cachedCli?.kind ?? ''
  }
}
