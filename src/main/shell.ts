import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

import type { AppSettingsTerminalShellPreference, AwsConnection, CloudProviderId } from '@shared/types'
import { getAppSettings } from './appSettings'
import { getConnectionEnv } from './sessionHub'
import { getToolCommand } from './toolchain'

export type ShellKind = 'powershell' | 'posix'

export type ShellConfig = {
  kind: ShellKind
  command: string
  args: string[]
}

type ShellEnvironmentCacheEntry = {
  key: string
  promise: Promise<Record<string, string>>
}

let shellEnvironmentCache: ShellEnvironmentCacheEntry | null = null

function getShellPreference(): AppSettingsTerminalShellPreference {
  try {
    return getAppSettings().terminal.shellPreference
  } catch {
    return ''
  }
}

function getDefaultPosixShell(): string {
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

function looksLikeExplicitPath(command: string): boolean {
  return path.isAbsolute(command) || command.includes('/') || command.includes('\\')
}

function parseEnvOutput(output: string): Record<string, string> {
  const parsed: Record<string, string> = {}

  for (const entry of output.split('\0')) {
    if (!entry) {
      continue
    }

    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = entry.slice(0, separatorIndex)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue
    }

    parsed[key] = entry.slice(separatorIndex + 1)
  }

  return parsed
}

function execFileText(command: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env,
        timeout: 12000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          resolve('')
          return
        }

        resolve(stdout)
      }
    )
  })
}

async function loadShellEnvironment(): Promise<Record<string, string>> {
  const baseEnv = { ...process.env as Record<string, string> }
  if (process.platform === 'win32') {
    return baseEnv
  }

  const shell = getShellConfig()
  if (shell.kind !== 'posix') {
    return baseEnv
  }

  const output = await execFileText(shell.command, ['-lc', 'env -0'], {
    ...baseEnv,
    TERM: 'dumb'
  })
  const parsed = parseEnvOutput(output)

  if (!parsed.PATH) {
    return baseEnv
  }

  return {
    ...baseEnv,
    ...parsed
  }
}

function shellEnvironmentCacheKey(): string {
  const shell = getShellConfig()
  return [
    process.platform,
    shell.kind,
    shell.command,
    getShellPreference(),
    process.env.SHELL ?? '',
    process.env.HOME ?? '',
    process.env.PATH ?? ''
  ].join('|')
}

export function invalidateResolvedProcessEnv(): void {
  shellEnvironmentCache = null
}

export async function getResolvedProcessEnv(options: { fresh?: boolean } = {}): Promise<Record<string, string>> {
  if (process.platform === 'win32') {
    return { ...process.env as Record<string, string> }
  }

  const key = shellEnvironmentCacheKey()
  if (!options.fresh && shellEnvironmentCache?.key === key) {
    return { ...await shellEnvironmentCache.promise }
  }

  const promise = loadShellEnvironment()
  if (!options.fresh) {
    shellEnvironmentCache = { key, promise }
  }

  return { ...await promise }
}

export async function resolveExecutablePath(command: string, env?: Record<string, string>): Promise<string> {
  if (!command.trim()) {
    return ''
  }

  if (looksLikeExplicitPath(command)) {
    return command
  }

  const baseEnv = env ?? await getResolvedProcessEnv()
  const probeCommand = process.platform === 'win32' ? 'where.exe' : 'which'
  const output = await execFileText(probeCommand, [command], baseEnv)
  const resolved = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return resolved || command
}

export function listSessionManagerPluginCommandCandidates(): string[] {
  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          'session-manager-plugin.exe',
          'session-manager-plugin',
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Amazon', 'SessionManagerPlugin', 'bin', 'session-manager-plugin.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Amazon', 'SessionManagerPlugin', 'bin', 'session-manager-plugin.exe')
        ]
      : process.platform === 'darwin'
        ? [
            'session-manager-plugin',
            '/opt/homebrew/bin/session-manager-plugin',
            '/usr/local/bin/session-manager-plugin',
            path.join(homeDir, '.local', 'bin', 'session-manager-plugin')
          ]
        : [
            'session-manager-plugin',
            '/usr/local/bin/session-manager-plugin',
            '/usr/bin/session-manager-plugin',
            path.join(homeDir, '.local', 'bin', 'session-manager-plugin')
          ]

  return [...new Set(candidates)]
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function quoteShellValue(value: string): string {
  return getShellConfig().kind === 'powershell' ? quotePowerShell(value) : quotePosix(value)
}

function buildShellCommandInvocation(command: string, args: string[]): string {
  const shell = getShellConfig()
  if (shell.kind === 'powershell') {
    return [`& ${quotePowerShell(command)}`, ...args.map((value) => quotePowerShell(value))].join(' ')
  }

  return [quotePosix(command), ...args.map((value) => quotePosix(value))].join(' ')
}

function quoteForAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildPowerShellUtf8Command(): string {
  return [
    'chcp 65001 > $null',
    '$utf8 = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = $utf8',
    '[Console]::OutputEncoding = $utf8',
    '$OutputEncoding = $utf8'
  ].join('; ')
}

export function getTerminalCwd(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd()
}

export function getShellConfig(): ShellConfig {
  if (process.platform === 'win32') {
    return {
      kind: 'powershell',
      command: 'powershell.exe',
      args: ['-NoLogo']
    }
  }

  const preference = getShellPreference()
  if (preference === 'bash') {
    return {
      kind: 'posix',
      command: 'bash',
      args: ['-il']
    }
  }

  if (preference === 'zsh') {
    return {
      kind: 'posix',
      command: 'zsh',
      args: ['-il']
    }
  }

  return {
    kind: 'posix',
    command: getDefaultPosixShell(),
    args: []
  }
}

function unsetPowerShell(name: string): string {
  return `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
}

function unsetPosix(name: string): string {
  return `unset ${name}`
}

function buildShellEnvCommands(env: Record<string, string>): string[] {
  const shell = getShellConfig()

  return Object.entries(env).map(([key, value]) =>
    shell.kind === 'powershell'
      ? `$env:${key} = ${quotePowerShell(value)}`
      : `export ${key}=${quotePosix(value)}`
  )
}

function buildEnvCommands(connection: AwsConnection): string[] {
  const shell = getShellConfig()
  const env = getConnectionEnv(connection)
  const baseCommands = shell.kind === 'powershell'
    ? [
        unsetPowerShell('AWS_PROFILE'),
        unsetPowerShell('AWS_ACCESS_KEY_ID'),
        unsetPowerShell('AWS_SECRET_ACCESS_KEY'),
        unsetPowerShell('AWS_SESSION_TOKEN')
      ]
    : [
        unsetPosix('AWS_PROFILE'),
        unsetPosix('AWS_ACCESS_KEY_ID'),
        unsetPosix('AWS_SECRET_ACCESS_KEY'),
        unsetPosix('AWS_SESSION_TOKEN')
      ]

  const assignments = buildShellEnvCommands(env)

  return [...baseCommands, ...assignments]
}

export function buildAwsContextCommand(connection: AwsConnection): string {
  const shell = getShellConfig()
  const envCommands = buildEnvCommands(connection)
  if (shell.kind === 'powershell') {
    return [
      buildPowerShellUtf8Command(),
      ...envCommands,
      connection.kind === 'profile'
        ? `Write-Host ("AWS context: profile=" + $env:AWS_PROFILE + " region=" + $env:AWS_REGION)`
        : `Write-Host ("AWS context: session=" + ${quotePowerShell(connection.label)} + " region=" + $env:AWS_REGION + " account=" + ${quotePowerShell(connection.accountId)})`
    ].join('; ')
  }

  return [
    ...envCommands,
    connection.kind === 'profile'
      ? 'printf "AWS context: profile=%s region=%s\\n" "$AWS_PROFILE" "$AWS_REGION"'
      : `printf "AWS context: session=%s region=%s account=%s\\n" ${quotePosix(connection.label)} "$AWS_REGION" ${quotePosix(connection.accountId)}`
  ].join('; ')
}

export function buildProviderShellContextCommand(
  providerId: Exclude<CloudProviderId, 'aws'>,
  label: string,
  modeLabel: string,
  env: Record<string, string>
): string {
  const shell = getShellConfig()
  const envCommands = buildShellEnvCommands(env)
  const guidance = providerId === 'gcp'
    ? 'Use gcloud auth list, gcloud config list, and project-scoped commands in this shell.'
    : 'Use az account show, az account list, and tenant or subscription-scoped commands in this shell.'
  const modeSummary = `${providerId === 'gcp' ? 'Google Cloud' : 'Azure'} mode: ${modeLabel}`

  if (shell.kind === 'powershell') {
    return [
      buildPowerShellUtf8Command(),
      ...envCommands,
      `Write-Host ${quotePowerShell(`${label} shell ready`)}`,
      `Write-Host ${quotePowerShell(modeSummary)}`,
      `Write-Host ${quotePowerShell(guidance)}`
    ].join('; ')
  }

  return [
    ...envCommands,
    `printf "%s\\n" ${quotePosix(`${label} shell ready`)}`,
    `printf "%s\\n" ${quotePosix(modeSummary)}`,
    `printf "%s\\n" ${quotePosix(guidance)}`
  ].join('; ')
}

export function buildAwsCliCommand(args: string[]): string {
  return buildShellCommandInvocation(getToolCommand('aws-cli', 'aws'), args)
}

function buildKubectlStartupCommand(connection: AwsConnection, clusterName: string): string {
  const shell = getShellConfig()
  const envCommands = buildEnvCommands(connection)
  const kubectlCommand = buildShellCommandInvocation(getToolCommand('kubectl', 'kubectl'), ['cluster-info'])

  if (shell.kind === 'powershell') {
    return [
      buildPowerShellUtf8Command(),
      ...envCommands,
      `Write-Host ${quotePowerShell(`kubectl context ready for cluster: ${clusterName}`)}`,
      'Write-Host ""',
      kubectlCommand
    ].join('; ')
  }

  return [
    ...envCommands,
    `printf "kubectl context ready for cluster: %s\\n\\n" ${quotePosix(clusterName)}`,
    kubectlCommand
  ].join('; ')
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: getTerminalCwd(),
      detached: true,
      stdio: 'ignore'
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export async function launchKubectlShell(connection: AwsConnection, clusterName: string, kubeconfigPath: string): Promise<void> {
  const shell = getShellConfig()
  const kubeconfigCommand = shell.kind === 'powershell'
    ? `$env:KUBECONFIG = ${quotePowerShell(kubeconfigPath)}`
    : `export KUBECONFIG=${quotePosix(kubeconfigPath)}`
  const command = [kubeconfigCommand, buildKubectlStartupCommand(connection, clusterName)].join('; ')

  if (process.platform === 'win32') {
    await spawnDetached('cmd.exe', ['/c', 'start', '', shell.command, '-NoExit', '-Command', command])
    return
  }

  if (process.platform === 'darwin') {
    await spawnDetached('osascript', [
      '-e',
      `tell application "Terminal" to do script "${quoteForAppleScript(command)}"`
    ])
    return
  }

  const terminalCandidates: Array<{ command: string; args: string[] }> = [
    {
      command: 'x-terminal-emulator',
      args: ['-e', shell.command, '-lc', `${command}; exec ${quotePosix(shell.command)} -l`]
    },
    {
      command: 'gnome-terminal',
      args: ['--', shell.command, '-lc', `${command}; exec ${quotePosix(shell.command)} -l`]
    },
    {
      command: 'konsole',
      args: ['-e', shell.command, '-lc', `${command}; exec ${quotePosix(shell.command)} -l`]
    },
    {
      command: 'xterm',
      args: ['-e', shell.command, '-lc', `${command}; exec ${quotePosix(shell.command)} -l`]
    }
  ]

  for (const candidate of terminalCandidates) {
    try {
      await spawnDetached(candidate.command, candidate.args)
      return
    } catch {
      continue
    }
  }

  throw new Error('No supported terminal emulator was found on this system.')
}
