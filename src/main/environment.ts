import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  EnvironmentCheckSeverity,
  EnvironmentHealthReport,
  EnvironmentPermissionCheck,
  EnvironmentToolCheck,
  EnvironmentToolId
} from '@shared/types'
import { getResolvedProcessEnv, listSessionManagerPluginCommandCandidates, resolveExecutablePath } from './shell'
import { detectTerraformCli } from './terraform'
import type { ToolchainOverrideId } from './toolchain'
import { listToolCommandCandidates } from './toolchain'

type ToolProbeSpec = {
  id: EnvironmentToolId
  label: string
  required: boolean
  overrideId?: ToolchainOverrideId
  commands: string[]
  versionArgs: string[]
  versionPattern: RegExp
  remediation: string
  detailWhenMissing: string
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

function listAzureCliCommandCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      'az',
      '/opt/homebrew/bin/az',
      '/usr/local/bin/az'
    ]
  }

  if (process.platform !== 'win32') {
    return ['az']
  }

  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'

  return [
    path.join(programFiles, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin', 'az.cmd'),
    path.join(programFilesX86, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin', 'az.cmd'),
    path.join(localAppData, 'Programs', 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin', 'az.cmd'),
    'az.cmd',
    'az.exe',
    'az'
  ]
}

const TOOL_SPECS: ToolProbeSpec[] = [
  {
    id: 'aws-cli',
    label: 'AWS CLI',
    required: true,
    overrideId: 'aws-cli',
    commands: process.platform === 'win32' ? ['aws.exe', 'aws'] : ['aws'],
    versionArgs: ['--version'],
    versionPattern: /aws-cli\/([^\s]+)/i,
    remediation: 'Install AWS CLI v2 and ensure the `aws` command is available on your PATH.',
    detailWhenMissing: 'AWS CLI is required for session flows, shell-based integrations, and several operator actions.'
  },
  {
    id: 'gcloud-cli',
    label: 'Google Cloud CLI',
    required: false,
    overrideId: 'gcloud-cli',
    commands: listGoogleCloudCommandCandidates(),
    versionArgs: ['--version'],
    versionPattern: /Google Cloud SDK\s+([^\s]+)/i,
    remediation: 'Install Google Cloud CLI if you want GCP shell flows, auth inspection, and project-scoped operator actions.',
    detailWhenMissing: 'GCP terminal and project-aware operator workflows depend on a local gcloud installation.'
  },
  {
    id: 'azure-cli',
    label: 'Azure CLI',
    required: false,
    overrideId: 'azure-cli',
    commands: listAzureCliCommandCandidates(),
    versionArgs: ['version', '--output', 'json'],
    versionPattern: /"azure-cli"\s*:\s*"([^"]+)"/i,
    remediation: 'Install Azure CLI if you want Azure terminal flows, subscription inspection, and resource-group operator actions.',
    detailWhenMissing: 'Azure terminal and subscription-scoped operator workflows depend on a local Azure CLI installation.'
  },
  {
    id: 'session-manager-plugin',
    label: 'Session Manager Plugin',
    required: false,
    commands: listSessionManagerPluginCommandCandidates(),
    versionArgs: ['--version'],
    versionPattern: /([\d.]+)/,
    remediation: 'Install the AWS Session Manager Plugin if you want shell and port-forwarding flows from the app.',
    detailWhenMissing: 'SSM shell launch flows depend on the Session Manager Plugin.'
  },
  {
    id: 'kubectl',
    label: 'kubectl',
    required: false,
    overrideId: 'kubectl',
    commands: process.platform === 'win32' ? ['kubectl.exe', 'kubectl'] : ['kubectl'],
    versionArgs: ['version', '--client', '--output=json'],
    versionPattern: /"gitVersion"\s*:\s*"v?([^"]+)"/i,
    remediation: 'Install kubectl if you want EKS shell, observability, and workload inspection workflows.',
    detailWhenMissing: 'EKS deep-dive workflows and kubectl-backed diagnostics will stay unavailable.'
  },
  {
    id: 'docker',
    label: 'Docker',
    required: false,
    overrideId: 'docker',
    commands: process.platform === 'win32' ? ['docker.exe', 'docker'] : ['docker'],
    versionArgs: ['--version'],
    versionPattern: /Docker version\s+([^\s,]+)/i,
    remediation: 'Install Docker Desktop or another Docker runtime if you want ECR login, pull, and push flows.',
    detailWhenMissing: 'ECR image pull and push actions rely on a local Docker runtime.'
  }
]

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

function buildProbeExecution(command: string, args: string[]): { command: string; args: string[] } {
  if (!isWindowsBatchCommand(command)) {
    return { command, args }
  }

  return {
    command: 'cmd.exe',
    args: ['/d', '/c', command, ...args]
  }
}

function probeCommand(
  command: string,
  args: string[],
  env: Record<string, string>
): Promise<{ found: boolean; path: string; output: string }> {
  return new Promise((resolve) => {
    if (!command.trim()) {
      resolve({ found: false, path: '', output: '' })
      return
    }

    let settled = false
    let safetyTimer: NodeJS.Timeout | null = null
    const finish = (result: { found: boolean; path: string; output: string }) => {
      if (settled) {
        return
      }

      settled = true
      if (safetyTimer) {
        clearTimeout(safetyTimer)
      }
      resolve(result)
    }

    try {
      const execution = buildProbeExecution(command, args)
      const child = execFile(execution.command, execution.args, { env, timeout: 12000, windowsHide: true }, async (error, stdout, stderr) => {
        const output = summarizeOutput(stdout, stderr)

        if (error) {
          const errorCode = typeof error === 'object' && error && 'code' in error ? String(error.code ?? '') : ''
          const canTreatAsInstalled =
            Boolean(output)
            && errorCode !== 'ENOENT'
            && errorCode !== 'EINVAL'
            && !outputIndicatesMissingCommand(output)

          if (!canTreatAsInstalled) {
            finish({ found: false, path: '', output: '' })
            return
          }

          let resolvedPath = command
          try {
            resolvedPath = await resolveExecutablePath(command, env)
          } catch {
            resolvedPath = command
          }

          finish({
            found: true,
            path: resolvedPath,
            output
          })
          return
        }

        let resolvedPath = command
        try {
          resolvedPath = await resolveExecutablePath(command, env)
        } catch {
          resolvedPath = command
        }

        finish({
          found: true,
          path: resolvedPath,
          output
        })
      })

      safetyTimer = setTimeout(() => {
        child.kill()
        finish({ found: false, path: '', output: '' })
      }, 15000)
    } catch {
      finish({ found: false, path: '', output: '' })
    }
  })
}

async function detectTool(spec: ToolProbeSpec, env: Record<string, string>): Promise<EnvironmentToolCheck> {
  for (const command of listToolCommandCandidates(spec.overrideId, spec.commands)) {
    const result = await probeCommand(command, spec.versionArgs, env)
    if (!result.found) {
      continue
    }

    const versionMatch = result.output.match(spec.versionPattern)
    const version = versionMatch?.[1] ?? result.output.slice(0, 80)

    if (versionMatch) {
      return {
        id: spec.id,
        label: spec.label,
        status: 'available',
        found: true,
        required: spec.required,
        version,
        path: result.path,
        detail: `${spec.label} is available on this machine.`,
        remediation: ''
      }
    }

    return {
      id: spec.id,
      label: spec.label,
      status: 'warning',
      found: true,
      required: spec.required,
      version: version || 'detected',
      path: result.path,
      detail: `${spec.label} executable was found, but the version probe did not return the expected output.`,
      remediation: spec.remediation
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    status: spec.required ? 'missing' : 'warning',
    found: false,
    required: spec.required,
    version: '',
    path: '',
    detail: spec.detailWhenMissing,
    remediation: spec.remediation
  }
}

async function detectTerraformFamily(env: Record<string, string>): Promise<EnvironmentToolCheck[]> {
  const cliInfo = await detectTerraformCli(env)

  const terraformTool: EnvironmentToolCheck = {
    id: 'terraform',
    label: 'Terraform',
    status: 'warning',
    found: false,
    required: false,
    version: '',
    path: '',
    detail: 'Terraform CLI is not the currently selected infrastructure CLI.',
    remediation: 'Install Terraform if you need parity with Terraform-native projects.'
  }

  const openTofuTool: EnvironmentToolCheck = {
    id: 'opentofu',
    label: 'OpenTofu',
    status: 'warning',
    found: false,
    required: false,
    version: '',
    path: '',
    detail: 'OpenTofu CLI is not currently available on this machine.',
    remediation: 'Install OpenTofu if you want an open-source Terraform-compatible workflow.'
  }

  for (const option of cliInfo.available) {
    if (option.kind === 'terraform') {
      terraformTool.found = true
      terraformTool.status = 'available'
      terraformTool.version = option.version
      terraformTool.path = option.path
      terraformTool.detail = cliInfo.kind === 'terraform'
        ? 'Terraform is available and selected as the active infrastructure CLI.'
        : 'Terraform is installed and can be selected as the active infrastructure CLI.'
      terraformTool.remediation = ''
    }

    if (option.kind === 'opentofu') {
      openTofuTool.found = true
      openTofuTool.status = 'available'
      openTofuTool.version = option.version
      openTofuTool.path = option.path
      openTofuTool.detail = cliInfo.kind === 'opentofu'
        ? 'OpenTofu is available and selected as the active infrastructure CLI.'
        : 'OpenTofu is installed and can be selected as the active infrastructure CLI.'
      openTofuTool.remediation = ''
    }
  }

  if (!terraformTool.found && !openTofuTool.found) {
    terraformTool.status = 'missing'
    terraformTool.required = true
    terraformTool.detail = 'Neither Terraform nor OpenTofu is currently available on this machine.'
    terraformTool.remediation = 'Install Terraform or OpenTofu and ensure the executable is reachable on your PATH.'
  }

  return [terraformTool, openTofuTool]
}

async function detectPermissions(): Promise<EnvironmentPermissionCheck[]> {
  const tempPath = os.tmpdir()
  const permissions: EnvironmentPermissionCheck[] = []

  try {
    await access(tempPath, constants.R_OK | constants.W_OK)
    permissions.push({
      id: 'temp-dir',
      label: 'Temporary workspace access',
      status: 'ok',
      detail: `The app can read and write temporary files in ${tempPath}.`,
      remediation: ''
    })
  } catch {
    permissions.push({
      id: 'temp-dir',
      label: 'Temporary workspace access',
      status: 'error',
      detail: `The app cannot read and write temporary files in ${tempPath}.`,
      remediation: 'Grant the app access to the system temp directory because SSH staging, diagnostics, and command helpers depend on it.'
    })
  }

  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir()
  const awsConfigDir = path.join(homeDir, '.aws')

  try {
    await access(awsConfigDir, constants.R_OK)
    permissions.push({
      id: 'aws-config-dir',
      label: 'AWS config directory access',
      status: 'ok',
      detail: `AWS config directory is readable at ${awsConfigDir}.`,
      remediation: ''
    })
  } catch {
    permissions.push({
      id: 'aws-config-dir',
      label: 'AWS config directory access',
      status: 'warning',
      detail: `AWS config directory is not readable at ${awsConfigDir}.`,
      remediation: 'This is acceptable if you rely only on the app vault, but external AWS profiles and config import flows will be limited.'
    })
  }

  return permissions
}

function overallSeverity(tools: EnvironmentToolCheck[], permissions: EnvironmentPermissionCheck[]): EnvironmentCheckSeverity {
  if (tools.some((tool) => tool.required && !tool.found) || permissions.some((item) => item.status === 'error')) {
    return 'error'
  }

  if (tools.some((tool) => tool.status === 'warning' || tool.status === 'missing') || permissions.some((item) => item.status === 'warning')) {
    return 'warning'
  }

  return 'info'
}

function buildSummary(tools: EnvironmentToolCheck[], permissions: EnvironmentPermissionCheck[]): string {
  const availableRequired = tools.filter((tool) => tool.required && tool.found).length
  const missingRequired = tools.filter((tool) => tool.required && !tool.found).length
  const optionalMissing = tools.filter((tool) => !tool.required && !tool.found).length
  const permissionProblems = permissions.filter((item) => item.status !== 'ok').length

  if (missingRequired > 0) {
    return `${missingRequired} required ${missingRequired === 1 ? 'dependency is' : 'dependencies are'} missing. Core shell and infrastructure workflows are not fully ready.`
  }

  if (optionalMissing > 0 || permissionProblems > 0) {
    return `${availableRequired} required dependencies are ready, but ${optionalMissing + permissionProblems} optional checks still need attention.`
  }

  return 'All required environment checks passed.'
}

export async function getEnvironmentHealthReport(): Promise<EnvironmentHealthReport> {
  const resolvedEnv = await getResolvedProcessEnv({ fresh: true })
  const [genericTools, terraformTools, permissions] = await Promise.all([
    Promise.all(TOOL_SPECS.map((spec) => detectTool(spec, resolvedEnv))),
    detectTerraformFamily(resolvedEnv),
    detectPermissions()
  ])

  const tools = [...genericTools, ...terraformTools]

  return {
    checkedAt: new Date().toISOString(),
    overallSeverity: overallSeverity(tools, permissions),
    summary: buildSummary(tools, permissions),
    tools,
    permissions
  }
}
