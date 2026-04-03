import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

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

  const [configurationsResult, projectsResult] = await Promise.all([
    runCommand(resolved.command, ['config', 'configurations', 'list', '--format=json'], env),
    runCommand(resolved.command, ['projects', 'list', '--format=json'], env)
  ])

  const configurations = configurationsResult.stdout.trim()
    ? parseJson<unknown[]>(configurationsResult.stdout).map(normalizeConfiguration).filter((entry): entry is GcpCliConfiguration => entry !== null)
    : []
  const activeConfiguration = configurations.find((entry) => entry.isActive) ?? configurations[0] ?? null
  const projects = projectsResult.stdout.trim()
    ? parseJson<unknown[]>(projectsResult.stdout).map(normalizeProject).filter((entry): entry is GcpCliProject => entry !== null)
    : []

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
