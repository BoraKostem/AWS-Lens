import { spawn } from 'node:child_process'

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

export function buildAwsContextCommand(profile: string, region: string): string {
  const shell = getShellConfig()

  if (shell.kind === 'powershell') {
    return [
      `$env:AWS_PROFILE = ${quotePowerShell(profile)}`,
      `$env:AWS_DEFAULT_REGION = ${quotePowerShell(region)}`,
      `$env:AWS_REGION = ${quotePowerShell(region)}`,
      `Write-Host ("AWS context: profile=" + $env:AWS_PROFILE + " region=" + $env:AWS_REGION)`
    ].join('; ')
  }

  return [
    `export AWS_PROFILE=${quotePosix(profile)}`,
    `export AWS_DEFAULT_REGION=${quotePosix(region)}`,
    `export AWS_REGION=${quotePosix(region)}`,
    'printf "AWS context: profile=%s region=%s\\n" "$AWS_PROFILE" "$AWS_REGION"'
  ].join('; ')
}

function buildKubectlStartupCommand(profile: string, region: string, clusterName: string): string {
  const shell = getShellConfig()

  if (shell.kind === 'powershell') {
    return [
      `$env:AWS_PROFILE = ${quotePowerShell(profile)}`,
      `$env:AWS_DEFAULT_REGION = ${quotePowerShell(region)}`,
      `$env:AWS_REGION = ${quotePowerShell(region)}`,
      `Write-Host ${quotePowerShell(`kubectl context ready for cluster: ${clusterName}`)}`,
      'Write-Host ""',
      'kubectl cluster-info'
    ].join('; ')
  }

  return [
    `export AWS_PROFILE=${quotePosix(profile)}`,
    `export AWS_DEFAULT_REGION=${quotePosix(region)}`,
    `export AWS_REGION=${quotePosix(region)}`,
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

export async function launchKubectlShell(profile: string, region: string, clusterName: string, kubeconfigPath: string): Promise<void> {
  const shell = getShellConfig()
  const kubeconfigCommand = shell.kind === 'powershell'
    ? `$env:KUBECONFIG = ${quotePowerShell(kubeconfigPath)}`
    : `export KUBECONFIG=${quotePosix(kubeconfigPath)}`
  const command = [kubeconfigCommand, buildKubectlStartupCommand(profile, region, clusterName)].join('; ')

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
