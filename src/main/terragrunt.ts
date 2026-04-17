import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

import type { TerragruntCliInfo } from '@shared/types'
import { getResolvedProcessEnv, resolveExecutablePath } from './shell'
import { listToolCommandCandidates } from './toolchain'

const NOT_INSTALLED_ERROR =
  'Terragrunt CLI not found. Install Terragrunt and ensure it is on your PATH, or set an explicit path in Settings.'

let cachedInfo: TerragruntCliInfo | null = null

function terragruntCandidates(): string[] {
  const baseName = 'terragrunt'
  const executableName = process.platform === 'win32' ? `${baseName}.exe` : baseName
  const names = process.platform === 'win32' ? [executableName, baseName] : [baseName]
  const fallbacks: string[] = []

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pfx86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const chocoBin = process.env.ChocolateyInstall
      ? path.join(process.env.ChocolateyInstall, 'bin', executableName)
      : 'C:\\ProgramData\\chocolatey\\bin\\terragrunt.exe'
    const scoopShim = path.join(os.homedir(), 'scoop', 'shims', executableName)
    fallbacks.push(
      chocoBin,
      scoopShim,
      path.join(pf, 'Terragrunt', executableName),
      path.join(pfx86, 'Terragrunt', executableName),
      path.join(os.homedir(), '.tgenv', 'bin', executableName),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Terragrunt', executableName)
    )
  } else if (process.platform === 'darwin') {
    fallbacks.push(
      `/usr/local/bin/${baseName}`,
      `/opt/homebrew/bin/${baseName}`,
      path.join(os.homedir(), '.tgenv', 'bin', baseName),
      path.join(os.homedir(), 'bin', baseName)
    )
  } else {
    fallbacks.push(
      `/usr/local/bin/${baseName}`,
      `/usr/bin/${baseName}`,
      `/snap/bin/${baseName}`,
      path.join(os.homedir(), '.tgenv', 'bin', baseName),
      path.join(os.homedir(), 'bin', baseName)
    )
  }

  return listToolCommandCandidates('terragrunt', [...names, ...fallbacks])
}

function parseVersionOutput(stdout: string): string {
  const match = stdout.match(/terragrunt\s+version\s+v?([0-9][^\s]*)/i)
    ?? stdout.match(/v?([0-9]+\.[0-9]+\.[0-9]+(?:[^\s]*)?)/i)
  return match?.[1] ?? stdout.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? ''
}

async function probeCandidate(
  candidate: string,
  env: Record<string, string>
): Promise<TerragruntCliInfo | null> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(candidate, ['--version'], { env, timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
    const combined = `${result.stdout}\n${result.stderr}`
    const version = parseVersionOutput(combined)
    return {
      found: true,
      path: await resolveExecutablePath(candidate, env),
      version,
      error: ''
    }
  } catch {
    return null
  }
}

export async function detectTerragruntCli(baseEnv?: Record<string, string>): Promise<TerragruntCliInfo> {
  const env = baseEnv ?? await getResolvedProcessEnv()
  for (const candidate of terragruntCandidates()) {
    const info = await probeCandidate(candidate, env)
    if (info) {
      cachedInfo = info
      return info
    }
  }

  cachedInfo = {
    found: false,
    path: '',
    version: '',
    error: NOT_INSTALLED_ERROR
  }
  return cachedInfo
}

export function getCachedTerragruntCliInfo(): TerragruntCliInfo {
  return cachedInfo ?? {
    found: false,
    path: '',
    version: '',
    error: 'Terragrunt CLI detection has not run yet.'
  }
}
