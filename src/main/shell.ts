import { spawn } from 'node:child_process'

import type { AwsConnection } from '@shared/types'
import { getConnectionEnv } from './sessionHub'

export type ShellKind = 'powershell' | 'posix'

export type ShellConfig = {
  kind: ShellKind
  command: string
  args: string[]
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
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

  return {
    kind: 'posix',
    command: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: []
  }
}

function unsetPowerShell(name: string): string {
  return `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
}

function unsetPosix(name: string): string {
  return `unset ${name}`
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

  const assignments = Object.entries(env).map(([key, value]) =>
    shell.kind === 'powershell'
      ? `$env:${key} = ${quotePowerShell(value)}`
      : `export ${key}=${quotePosix(value)}`
  )

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

function buildKubectlStartupCommand(connection: AwsConnection, clusterName: string): string {
  const shell = getShellConfig()
  const envCommands = buildEnvCommands(connection)

  if (shell.kind === 'powershell') {
    return [
      buildPowerShellUtf8Command(),
      ...envCommands,
      `Write-Host ${quotePowerShell(`kubectl context ready for cluster: ${clusterName}`)}`,
      'Write-Host ""',
      'kubectl cluster-info'
    ].join('; ')
  }

  return [
    ...envCommands,
    `printf "kubectl context ready for cluster: %s\\n\\n" ${quotePosix(clusterName)}`,
    'kubectl cluster-info'
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
