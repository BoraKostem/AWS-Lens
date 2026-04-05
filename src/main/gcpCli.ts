import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

import type { GcpCliConfiguration, GcpCliContext, GcpCliProject, GcpComputeInstanceSummary } from '@shared/types'
import { getResolvedProcessEnv, resolveExecutablePath } from './shell'
import { listToolCommandCandidates } from './toolchain'

type CommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  code: string
  path: string
}

const DEFAULT_GCP_LOCATIONS = [
  'africa-south1',
  'asia-east1',
  'asia-east2',
  'asia-northeast1',
  'asia-northeast2',
  'asia-northeast3',
  'asia-south1',
  'asia-south2',
  'asia-southeast1',
  'asia-southeast2',
  'australia-southeast1',
  'australia-southeast2',
  'europe-central2',
  'europe-north1',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'europe-west4',
  'europe-west6',
  'europe-west8',
  'europe-west9',
  'me-central1',
  'me-central2',
  'me-west1',
  'northamerica-northeast1',
  'northamerica-northeast2',
  'southamerica-east1',
  'southamerica-west1',
  'us-central1',
  'us-east1',
  'us-east4',
  'us-east5',
  'us-south1',
  'us-west1',
  'us-west2',
  'us-west3',
  'us-west4'
] as const

function listGoogleCloudCommandCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      'gcloud',
      '/opt/homebrew/bin/gcloud',
      '/usr/local/bin/gcloud'
    ]
  }

  if (process.platform !== 'win32') {
    return ['gcloud']
  }

  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'

  return [
    path.join(localAppData, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
    path.join(programFiles, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
    path.join(programFilesX86, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
    'C:\\ProgramData\\chocolatey\\lib\\gcloudsdk\\tools\\google-cloud-sdk\\bin\\gcloud.cmd',
    'gcloud.cmd',
    'gcloud.exe',
    'gcloud'
  ]
}

function summarizeOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim()
}

function outputIndicatesMissingCommand(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('is not recognized as an internal or external command')
    || normalized.includes('not found')
    || normalized.includes('no such file or directory')
}

function outputIndicatesAuthIssue(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('gcloud auth login')
    || normalized.includes('gcloud auth application-default login')
    || normalized.includes('reauth')
    || normalized.includes('re-auth')
    || normalized.includes('not have an active account')
    || normalized.includes('no active account')
    || normalized.includes('login required')
    || normalized.includes('invalid_grant')
    || normalized.includes('unauthorized')
    || normalized.includes('access token')
    || normalized.includes('credentials')
}

function outputIndicatesApiDisabled(output: string): boolean {
  const normalized = output.toLowerCase()
  return normalized.includes('api has not been used in project')
    || normalized.includes('it is disabled')
    || normalized.includes('enable it by visiting')
    || normalized.includes('google developers console api activation')
}

function extractProjectIdFromOutput(output: string): string {
  const quotedMatch = output.match(/project\s+"([^"]+)"/i)
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim()
  }

  const plainMatch = output.match(/project\s+([a-z0-9-]+)/i)
  return plainMatch?.[1]?.trim() ?? ''
}

function summarizeCliFailure(stderr: string, stdout: string): string {
  const preferredOutput = stderr.trim() || stdout.trim()

  return preferredOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
}

function buildGcpCliError(label: string, result: CommandResult): Error {
  const output = summarizeOutput(result.stdout, result.stderr)
  const detail = summarizeCliFailure(result.stderr, result.stdout)

  if (outputIndicatesApiDisabled(output)) {
    const projectId = extractProjectIdFromOutput(output)
    const enableCommand = projectId
      ? `gcloud services enable compute.googleapis.com --project ${projectId}`
      : 'gcloud services enable compute.googleapis.com --project <project-id>'

    return new Error(
      `Google Cloud API access failed while ${label}. The required API is disabled for the selected project. Run "${enableCommand}", wait for propagation, and retry.${detail ? ` ${detail}` : ''}`
    )
  }

  if (outputIndicatesAuthIssue(output)) {
    return new Error(
      `Google Cloud CLI authorization failed while ${label}. Run "gcloud auth login" or refresh your current credentials, then try again.${detail ? ` ${detail}` : ''}`
    )
  }

  if (result.code === 'ETIMEDOUT') {
    return new Error(`Google Cloud CLI timed out while ${label}. Try again after the CLI finishes authenticating or checking your organization access.`)
  }

  return new Error(`Google Cloud CLI failed while ${label}.${detail ? ` ${detail}` : ''}`)
}

function isWindowsBatchCommand(command: string): boolean {
  if (process.platform !== 'win32') {
    return false
  }

  const extension = path.extname(command.trim()).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function buildExecution(command: string, args: string[]): { command: string; args: string[] } {
  if (!isWindowsBatchCommand(command)) {
    return { command, args }
  }

  return {
    command: 'cmd.exe',
    args: ['/d', '/c', command, ...args]
  }
}

function buildGcloudArgs(args: string[]): string[] {
  return ['--quiet', '--verbosity=error', ...args]
}

async function runCommand(command: string, args: string[], env: Record<string, string>, timeout = 20000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const execution = buildExecution(command, args)

    try {
      execFile(
        execution.command,
        execution.args,
        {
          env,
          timeout,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 4
        },
        async (error, stdout, stderr) => {
          const output = summarizeOutput(stdout, stderr)
          const code = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : ''

          if (error && (code === 'ENOENT' || code === 'EINVAL' || outputIndicatesMissingCommand(output))) {
            resolve({
              ok: false,
              stdout: '',
              stderr: '',
              code,
              path: ''
            })
            return
          }

          let resolvedPath = command
          try {
            resolvedPath = await resolveExecutablePath(command, env)
          } catch {
            resolvedPath = command
          }

          resolve({
            ok: !error,
            stdout,
            stderr,
            code,
            path: resolvedPath
          })
        }
      )
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        code,
        path: ''
      })
    }
  })
}

async function resolveGcloudCommand(env: Record<string, string>): Promise<{ command: string; path: string } | null> {
  for (const candidate of listToolCommandCandidates('gcloud-cli', listGoogleCloudCommandCandidates())) {
    const probe = await runCommand(candidate, ['--version'], env)
    if (!probe.path) {
      continue
    }

    return {
      command: candidate,
      path: probe.path
    }
  }

  return null
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeConfiguration(entry: unknown): GcpCliConfiguration | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const properties = (record.properties && typeof record.properties === 'object' ? record.properties : {}) as Record<string, unknown>
  const core = (properties.core && typeof properties.core === 'object' ? properties.core : {}) as Record<string, unknown>
  const compute = (properties.compute && typeof properties.compute === 'object' ? properties.compute : {}) as Record<string, unknown>
  const name = asString(record.name)

  if (!name) {
    return null
  }

  return {
    name,
    isActive: record.is_active === true,
    account: asString(core.account),
    projectId: asString(core.project),
    region: asString(compute.region),
    zone: asString(compute.zone)
  }
}

function normalizeProject(entry: unknown): GcpCliProject | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const record = entry as Record<string, unknown>
  const projectId = asString(record.projectId)
  if (!projectId) {
    return null
  }

  return {
    projectId,
    name: asString(record.name),
    projectNumber: asString(record.projectNumber),
    lifecycleState: asString(record.lifecycleState)
  }
}

function mergeProjects(...lists: Array<GcpCliProject[]>): GcpCliProject[] {
  const merged = new Map<string, GcpCliProject>()

  for (const list of lists) {
    for (const project of list) {
      const existing = merged.get(project.projectId)
      if (!existing) {
        merged.set(project.projectId, project)
        continue
      }

      merged.set(project.projectId, {
        projectId: project.projectId,
        name: project.name || existing.name,
        projectNumber: project.projectNumber || existing.projectNumber,
        lifecycleState: project.lifecycleState || existing.lifecycleState
      })
    }
  }

  return [...merged.values()].sort((left, right) => left.projectId.localeCompare(right.projectId))
}

function mergeLocations(...lists: Array<string[]>): string[] {
  const merged = new Set<string>()

  for (const list of lists) {
    for (const location of list) {
      const normalized = location.trim()
      if (!normalized) {
        continue
      }

      merged.add(normalized)
    }
  }

  return [...merged].sort((left, right) => {
    if (left === 'global') {
      return -1
    }

    if (right === 'global') {
      return 1
    }

    return left.localeCompare(right)
  })
}

function getGcpConfigRoot(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud')
  }

  return path.join(process.env.HOME ?? os.homedir(), '.config', 'gcloud')
}

function parseIni(contents: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let currentSection = ''

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim().toLowerCase()
      sections[currentSection] = sections[currentSection] ?? {}
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase()
    const value = line.slice(separatorIndex + 1).trim()
    sections[currentSection] = sections[currentSection] ?? {}
    sections[currentSection][key] = value
  }

  return sections
}

async function readGcpConfigFallback(): Promise<{ activeConfigurationName: string; configurations: GcpCliConfiguration[] }> {
  const root = getGcpConfigRoot()
  const configsDir = path.join(root, 'configurations')
  const activeConfigurationName = await readFile(path.join(root, 'active_config'), 'utf8')
    .then((value) => value.trim())
    .catch(() => '')

  const entries = await readdir(configsDir, { withFileTypes: true }).catch(() => [])
  const configurations = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('config_'))
    .map(async (entry) => {
      const contents = await readFile(path.join(configsDir, entry.name), 'utf8').catch(() => '')
      if (!contents) {
        return null
      }

      const parsed = parseIni(contents)
      const core = parsed.core ?? {}
      const compute = parsed.compute ?? {}
      const name = entry.name.slice('config_'.length)

      return {
        name,
        isActive: name === activeConfigurationName,
        account: core.account ?? '',
        projectId: core.project ?? '',
        region: compute.region ?? '',
        zone: compute.zone ?? ''
      } satisfies GcpCliConfiguration
    }))

  return {
    activeConfigurationName,
    configurations: configurations.filter((entry): entry is GcpCliConfiguration => entry !== null)
  }
}

function deriveProjectsFromConfigurations(configurations: GcpCliConfiguration[]): GcpCliProject[] {
  const seen = new Set<string>()
  const projects: GcpCliProject[] = []

  for (const configuration of configurations) {
    const projectId = configuration.projectId.trim()
    if (!projectId || seen.has(projectId)) {
      continue
    }

    seen.add(projectId)
    projects.push({
      projectId,
      name: '',
      projectNumber: '',
      lifecycleState: ''
    })
  }

  return projects
}

function deriveLocationsFromConfigurations(configurations: GcpCliConfiguration[]): string[] {
  return mergeLocations(
    ['global'],
    [...DEFAULT_GCP_LOCATIONS],
    configurations.map((configuration) => configuration.region),
    configurations.map((configuration) => configuration.zone)
  )
}

function safeParseList<T>(value: string, normalize: (entry: unknown) => T | null): T[] {
  if (!value.trim()) {
    return []
  }

  try {
    const parsed = parseJson<unknown[]>(value)
    return parsed.map(normalize).filter((entry): entry is T => entry !== null)
  } catch {
    return []
  }
}

function normalizeValueBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === 'yes' || normalized === '1'
}

function parseGcloudValueRows(value: string): string[][] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t').map((column) => column.trim()))
}

function parseConfigurationValueRows(value: string): GcpCliConfiguration[] {
  return parseGcloudValueRows(value)
    .map((columns) => {
      const [name = '', isActive = '', account = '', projectId = '', region = '', zone = ''] = columns
      if (!name) {
        return null
      }

      return {
        name,
        isActive: normalizeValueBoolean(isActive),
        account,
        projectId,
        region,
        zone
      } satisfies GcpCliConfiguration
    })
    .filter((entry): entry is GcpCliConfiguration => entry !== null)
}

function parseProjectValueRows(value: string): GcpCliProject[] {
  return parseGcloudValueRows(value)
    .map((columns) => {
      const [projectId = '', name = '', projectNumber = '', lifecycleState = ''] = columns
      if (!projectId) {
        return null
      }

      return {
        projectId,
        name,
        projectNumber,
        lifecycleState
      } satisfies GcpCliProject
    })
    .filter((entry): entry is GcpCliProject => entry !== null)
}

function parseLocationValueRows(value: string): string[] {
  return mergeLocations(
    parseGcloudValueRows(value)
      .map((columns) => columns[0] ?? '')
  )
}

function parseComputeInstanceValueRows(value: string): GcpComputeInstanceSummary[] {
  return parseGcloudValueRows(value)
    .map((columns) => {
      const [name = '', zone = '', status = '', machineType = '', internalIp = '', externalIp = ''] = columns
      if (!name) {
        return null
      }

      return {
        name,
        zone,
        status,
        machineType,
        internalIp,
        externalIp
      } satisfies GcpComputeInstanceSummary
    })
    .filter((entry): entry is GcpComputeInstanceSummary => entry !== null)
}

function filterComputeInstancesByLocation(instances: GcpComputeInstanceSummary[], location: string): GcpComputeInstanceSummary[] {
  const normalizedLocation = location.trim().toLowerCase()
  if (!normalizedLocation || normalizedLocation === 'global') {
    return instances
  }

  const isZoneLocation = /-[a-z]$/.test(normalizedLocation)
  return instances.filter((instance) => {
    const zone = instance.zone.trim().toLowerCase()
    if (!zone) {
      return false
    }

    return isZoneLocation
      ? zone === normalizedLocation
      : zone === normalizedLocation || zone.startsWith(`${normalizedLocation}-`)
  })
}

function safeParseItem<T>(value: string, normalize: (entry: unknown) => T | null): T | null {
  if (!value.trim()) {
    return null
  }

  try {
    return normalize(parseJson<unknown>(value))
  } catch {
    return null
  }
}

export async function getGcpCliContext(): Promise<GcpCliContext> {
  const env = await getResolvedProcessEnv({ fresh: true })
  const resolved = await resolveGcloudCommand(env)

  if (!resolved) {
    return {
      detected: false,
      cliPath: '',
      activeConfigurationName: '',
      activeAccount: '',
      activeProjectId: '',
      activeRegion: '',
      activeZone: '',
      configurations: [],
      projects: [],
      locations: []
    }
  }

  const fallback = await readGcpConfigFallback().catch(() => ({
    activeConfigurationName: '',
    configurations: [] as GcpCliConfiguration[]
  }))

  let configurations = fallback.configurations
  if (configurations.length === 0) {
    const configurationsResult = await runCommand(
      resolved.command,
      buildGcloudArgs(['config', 'configurations', 'list', '--format=value(name,is_active,properties.core.account,properties.core.project,properties.compute.region,properties.compute.zone)']),
      env,
      4000
    )
    const cliConfigurations = parseConfigurationValueRows(configurationsResult.stdout)
    configurations = cliConfigurations.length > 0 ? cliConfigurations : fallback.configurations
  }
  const activeConfiguration = configurations.find((entry) => entry.isActive)
    ?? configurations.find((entry) => entry.name === fallback.activeConfigurationName)
    ?? configurations[0]
    ?? null
  const derivedProjects = deriveProjectsFromConfigurations(configurations)
  const derivedLocations = deriveLocationsFromConfigurations(configurations)
  const activeProjectId = activeConfiguration?.projectId ?? ''
  const locationsResultPromise = runCommand(
    resolved.command,
    buildGcloudArgs(['compute', 'regions', 'list', '--format=value(name)', '--limit=500']),
    env,
    5000
  )

  const activeProjectResult = await (
    activeProjectId
      ? runCommand(
          resolved.command,
          buildGcloudArgs(['projects', 'describe', activeProjectId, '--format=json(projectId,name,projectNumber,lifecycleState)']),
          env,
          4000
        )
      : Promise.resolve({
          ok: false,
          stdout: '',
          stderr: '',
          code: '',
          path: resolved.path
        } satisfies CommandResult)
  )

  const activeProject = safeParseItem(activeProjectResult.stdout, normalizeProject)
  const locationsResult = await locationsResultPromise
  const cliLocations = parseLocationValueRows(locationsResult.stdout)
  const locations = mergeLocations(
    cliLocations,
    derivedLocations,
    activeConfiguration?.region ? [activeConfiguration.region] : [],
    activeConfiguration?.zone ? [activeConfiguration.zone] : []
  )
  const projects = mergeProjects(
    activeProject ? [activeProject] : [],
    derivedProjects
  )

  return {
    detected: true,
    cliPath: resolved.path,
    activeConfigurationName: activeConfiguration?.name ?? '',
    activeAccount: activeConfiguration?.account ?? '',
    activeProjectId: activeConfiguration?.projectId ?? '',
    activeRegion: activeConfiguration?.region ?? '',
    activeZone: activeConfiguration?.zone ?? '',
    configurations,
    projects,
    locations
  }
}

export async function listGcpProjects(): Promise<GcpCliProject[]> {
  const env = await getResolvedProcessEnv({ fresh: true })
  const resolved = await resolveGcloudCommand(env)

  if (!resolved) {
    return []
  }

  const fallback = await readGcpConfigFallback().catch(() => ({
    activeConfigurationName: '',
    configurations: [] as GcpCliConfiguration[]
  }))
  const derivedProjects = deriveProjectsFromConfigurations(fallback.configurations)
  const projectsResult = await runCommand(
    resolved.command,
    buildGcloudArgs(['projects', 'list', '--format=value(projectId,name,projectNumber,lifecycleState)', '--page-size=500']),
    env,
    20000
  )

  const cliProjects = parseProjectValueRows(projectsResult.stdout)

  if (!projectsResult.ok && cliProjects.length === 0) {
    throw buildGcpCliError('loading the project catalog', projectsResult)
  }

  if (projectsResult.ok && cliProjects.length === 0 && projectsResult.stderr.trim()) {
    throw buildGcpCliError('loading the project catalog', projectsResult)
  }

  return mergeProjects(
    cliProjects,
    derivedProjects
  )
}

export async function listGcpComputeInstances(projectId: string, location: string): Promise<GcpComputeInstanceSummary[]> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return []
  }

  const env = await getResolvedProcessEnv({ fresh: true })
  const resolved = await resolveGcloudCommand(env)

  if (!resolved) {
    return []
  }

  const instancesResult = await runCommand(
    resolved.command,
    buildGcloudArgs([
      'compute',
      'instances',
      'list',
      '--project',
      normalizedProjectId,
      '--format=value(name,zone.basename(),status,machineType.basename(),networkInterfaces[0].networkIP,networkInterfaces[0].accessConfigs[0].natIP)',
      '--limit=500'
    ]),
    env,
    20000
  )

  const cliInstances = parseComputeInstanceValueRows(instancesResult.stdout)

  if (!instancesResult.ok && cliInstances.length === 0) {
    throw buildGcpCliError(`listing Compute Engine instances for project "${normalizedProjectId}"`, instancesResult)
  }

  if (instancesResult.ok && cliInstances.length === 0 && instancesResult.stderr.trim()) {
    throw buildGcpCliError(`listing Compute Engine instances for project "${normalizedProjectId}"`, instancesResult)
  }

  return filterComputeInstancesByLocation(cliInstances, location)
    .sort((left, right) => left.zone.localeCompare(right.zone) || left.name.localeCompare(right.name))
}
