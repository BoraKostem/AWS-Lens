import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

import type { GcpCliConfiguration, GcpCliContext, GcpCliProject } from '@shared/types'
import { getResolvedProcessEnv, resolveExecutablePath } from './shell'
import { listToolCommandCandidates } from './toolchain'

type CommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  code: string
  path: string
}

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

async function runCommand(command: string, args: string[], env: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolve) => {
    const execution = buildExecution(command, args)

    try {
      execFile(
        execution.command,
        execution.args,
        {
          env,
          timeout: 20000,
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
      projects: []
    }
  }

  const fallback = await readGcpConfigFallback().catch(() => ({
    activeConfigurationName: '',
    configurations: [] as GcpCliConfiguration[]
  }))

  const [configurationsResult, projectsResult] = await Promise.all([
    runCommand(resolved.command, ['config', 'configurations', 'list', '--format=json'], env),
    runCommand(resolved.command, ['projects', 'list', '--format=json'], env)
  ])

  const cliConfigurations = safeParseList(configurationsResult.stdout, normalizeConfiguration)
  const configurations = cliConfigurations.length > 0
    ? cliConfigurations
    : fallback.configurations
  const activeConfiguration = configurations.find((entry) => entry.isActive)
    ?? configurations.find((entry) => entry.name === fallback.activeConfigurationName)
    ?? configurations[0]
    ?? null
  const cliProjects = safeParseList(projectsResult.stdout, normalizeProject)
  const projects = cliProjects.length > 0
    ? cliProjects
    : deriveProjectsFromConfigurations(configurations)

  return {
    detected: true,
    cliPath: resolved.path,
    activeConfigurationName: activeConfiguration?.name ?? '',
    activeAccount: activeConfiguration?.account ?? '',
    activeProjectId: activeConfiguration?.projectId ?? '',
    activeRegion: activeConfiguration?.region ?? '',
    activeZone: activeConfiguration?.zone ?? '',
    configurations,
    projects
  }
}
