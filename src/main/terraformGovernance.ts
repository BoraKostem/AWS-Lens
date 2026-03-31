import { execFile } from 'node:child_process'
import path from 'node:path'

import type {
  TerraformCliKind,
  TerraformGovernanceCheckResult,
  TerraformGovernanceCheckStatus,
  TerraformGovernanceFinding,
  TerraformGovernanceReport,
  TerraformGovernanceToolId,
  TerraformGovernanceToolInfo,
  TerraformGovernanceToolkit
} from '@shared/types'

/* ── Tool Detection ──────────────────────────────────────── */

type ToolSpec = {
  id: TerraformGovernanceToolId
  label: string
  commands: string[]
  versionArgs: string[]
  versionPattern: RegExp
  required: boolean
}

const TOOL_SPECS: ToolSpec[] = [
  {
    id: 'fmt',
    label: 'fmt',
    commands: ['terraform'],
    versionArgs: ['version', '-json'],
    versionPattern: /(\d+\.\d+\.\d+)/,
    required: true
  },
  {
    id: 'validate',
    label: 'validate',
    commands: ['terraform'],
    versionArgs: ['version', '-json'],
    versionPattern: /(\d+\.\d+\.\d+)/,
    required: true
  },
  {
    id: 'tflint',
    label: 'TFLint',
    commands: process.platform === 'win32' ? ['tflint.exe', 'tflint'] : ['tflint'],
    versionArgs: ['--version'],
    versionPattern: /(\d+\.\d+\.\d+)/,
    required: false
  },
  {
    id: 'tfsec',
    label: 'tfsec',
    commands: process.platform === 'win32' ? ['tfsec.exe', 'tfsec'] : ['tfsec'],
    versionArgs: ['--version'],
    versionPattern: /(\d+\.\d+\.\d+)/,
    required: false
  },
  {
    id: 'checkov',
    label: 'Checkov',
    commands: process.platform === 'win32' ? ['checkov.exe', 'checkov'] : ['checkov'],
    versionArgs: ['--version'],
    versionPattern: /(\d+\.\d+\.\d+)/,
    required: false
  }
]

let cachedToolkit: TerraformGovernanceToolkit | null = null
let terraformPath = 'terraform'
let terraformLabel = 'Terraform'
let terraformKind: TerraformCliKind | '' = 'terraform'

function setTerraformRuntime(tfPath: string, cliLabel?: string, cliKind?: TerraformCliKind | ''): void {
  terraformPath = tfPath
  terraformLabel = cliLabel || 'Terraform'
  terraformKind = cliKind ?? 'terraform'
}

async function probeCommand(command: string, args: string[]): Promise<{ found: boolean; path: string; version: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ found: false, path: '', version: '' })
        return
      }
      const combined = `${stdout}\n${stderr}`
      resolve({ found: true, path: command, version: combined.trim().slice(0, 200) })
    })
  })
}

async function detectTool(spec: ToolSpec): Promise<TerraformGovernanceToolInfo> {
  const commands = (spec.id === 'fmt' || spec.id === 'validate')
    ? [terraformPath]
    : spec.commands

  for (const cmd of commands) {
    const result = await probeCommand(cmd, spec.versionArgs)
    if (result.found) {
      const match = result.version.match(spec.versionPattern)
      return {
        id: spec.id,
        label: spec.id === 'fmt' || spec.id === 'validate' ? `${terraformLabel} ${spec.label}` : spec.label,
        available: true,
        path: result.path,
        version: match?.[1] ?? result.version.slice(0, 50),
        required: spec.required
      }
    }
  }
  return {
    id: spec.id,
    label: spec.id === 'fmt' || spec.id === 'validate' ? `${terraformLabel} ${spec.label}` : spec.label,
    available: false,
    path: '',
    version: '',
    required: spec.required
  }
}

export async function detectGovernanceTools(
  tfCliPath?: string,
  cliLabel?: string,
  cliKind?: TerraformCliKind | ''
): Promise<TerraformGovernanceToolkit> {
  if (tfCliPath) setTerraformRuntime(tfCliPath, cliLabel, cliKind)

  const tools = await Promise.all(TOOL_SPECS.map(detectTool))
  cachedToolkit = {
    tools,
    detectedAt: new Date().toISOString(),
    cliKind: terraformKind,
    cliLabel: terraformLabel,
    cliPath: terraformPath
  }
  return cachedToolkit
}

export function getCachedGovernanceToolkit(): TerraformGovernanceToolkit {
  return cachedToolkit ?? {
    tools: [],
    detectedAt: '',
    cliKind: '',
    cliLabel: '',
    cliPath: ''
  }
}

/* ── Check Runners ───────────────────────────────────────── */

function runToolProcess(
  cwd: string,
  command: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim()
      const exitCode = err && 'code' in err ? (err as { code: number }).code : (err ? -1 : 0)
      resolve({ output, exitCode })
    })
  })
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/* ── terraform fmt ───────────────────────────────────────── */

async function runFmtCheck(rootPath: string, tfPath: string): Promise<TerraformGovernanceCheckResult> {
  const start = Date.now()
  const { output, exitCode } = await runToolProcess(rootPath, tfPath, ['fmt', '-check', '-no-color', '-diff'])
  const clean = stripAnsi(output)
  const findings: TerraformGovernanceFinding[] = []

  // Each filename on its own line in fmt -check output indicates an unformatted file
  for (const line of clean.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && trimmed.endsWith('.tf') && !trimmed.startsWith('---') && !trimmed.startsWith('+++') && !trimmed.startsWith('@@')) {
      findings.push({
        severity: 'low',
        ruleId: 'fmt',
        message: `File needs formatting: ${trimmed}`,
        file: trimmed,
        line: 0
      })
    }
  }

  const status: TerraformGovernanceCheckStatus = exitCode === 0 ? 'passed' : 'failed'
  return {
    toolId: 'fmt',
    label: 'Format Check',
    status,
    blocking: false,
    summary: status === 'passed'
      ? 'All files correctly formatted'
      : `${findings.length} file${findings.length !== 1 ? 's' : ''} need formatting`,
    findings,
    output: clean,
    durationMs: Date.now() - start,
    ranAt: new Date().toISOString()
  }
}

/* ── terraform validate ──────────────────────────────────── */

async function runValidateCheck(rootPath: string, tfPath: string, env: Record<string, string>): Promise<TerraformGovernanceCheckResult> {
  const start = Date.now()
  const { output, exitCode } = await runToolProcess(rootPath, tfPath, ['validate', '-json', '-no-color'], env)
  const clean = stripAnsi(output)
  const findings: TerraformGovernanceFinding[] = []
  let summary = ''

  try {
    const json = JSON.parse(clean) as {
      valid?: boolean
      error_count?: number
      warning_count?: number
      diagnostics?: Array<{
        severity?: string
        summary?: string
        detail?: string
        range?: { filename?: string; start?: { line?: number } }
      }>
    }

    if (json.diagnostics) {
      for (const diag of json.diagnostics) {
        findings.push({
          severity: diag.severity === 'error' ? 'high' : 'medium',
          ruleId: 'validate',
          message: [diag.summary, diag.detail].filter(Boolean).join(': '),
          file: diag.range?.filename ?? '',
          line: diag.range?.start?.line ?? 0
        })
      }
    }
    summary = json.valid
      ? 'Configuration is valid'
      : `${json.error_count ?? 0} error(s), ${json.warning_count ?? 0} warning(s)`
  } catch {
    summary = exitCode === 0 ? 'Validation passed' : 'Validation failed (non-JSON output)'
  }

  return {
    toolId: 'validate',
    label: 'Validate',
    status: exitCode === 0 ? 'passed' : 'failed',
    blocking: true,
    summary,
    findings,
    output: clean,
    durationMs: Date.now() - start,
    ranAt: new Date().toISOString()
  }
}

/* ── tflint ──────────────────────────────────────────────── */

async function runTflintCheck(rootPath: string, tflintPath: string): Promise<TerraformGovernanceCheckResult> {
  const start = Date.now()
  const { output, exitCode } = await runToolProcess(rootPath, tflintPath, ['--format=json', '--no-color'])
  const clean = stripAnsi(output)
  const findings: TerraformGovernanceFinding[] = []

  try {
    const json = JSON.parse(clean) as {
      issues?: Array<{
        rule?: { name?: string; severity?: string }
        message?: string
        range?: { filename?: string; start?: { line?: number } }
      }>
      errors?: Array<{ message?: string }>
    }

    if (json.issues) {
      for (const issue of json.issues) {
        const severity = issue.rule?.severity === 'error' ? 'high'
          : issue.rule?.severity === 'warning' ? 'medium' : 'low'
        findings.push({
          severity,
          ruleId: issue.rule?.name ?? 'tflint',
          message: issue.message ?? '',
          file: issue.range?.filename ?? '',
          line: issue.range?.start?.line ?? 0
        })
      }
    }
    if (json.errors) {
      for (const err of json.errors) {
        findings.push({
          severity: 'high',
          ruleId: 'tflint-error',
          message: err.message ?? 'Unknown error',
          file: '',
          line: 0
        })
      }
    }
  } catch {
    // Non-JSON output — treat lines as findings
    for (const line of clean.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('{')) {
        findings.push({
          severity: 'medium',
          ruleId: 'tflint',
          message: trimmed,
          file: '',
          line: 0
        })
      }
    }
  }

  const errorCount = findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length
  return {
    toolId: 'tflint',
    label: 'TFLint',
    status: exitCode === 0 && errorCount === 0 ? 'passed' : (exitCode === 2 || errorCount > 0 ? 'failed' : 'passed'),
    blocking: false,
    summary: findings.length === 0
      ? 'No issues found'
      : `${findings.length} issue${findings.length !== 1 ? 's' : ''} (${errorCount} error${errorCount !== 1 ? 's' : ''})`,
    findings,
    output: clean,
    durationMs: Date.now() - start,
    ranAt: new Date().toISOString()
  }
}

/* ── tfsec ───────────────────────────────────────────────── */

async function runTfsecCheck(rootPath: string, tfsecPath: string): Promise<TerraformGovernanceCheckResult> {
  const start = Date.now()
  const { output, exitCode } = await runToolProcess(rootPath, tfsecPath, ['--format=json', '--no-color', '.'])
  const clean = stripAnsi(output)
  const findings: TerraformGovernanceFinding[] = []

  try {
    const json = JSON.parse(clean) as {
      results?: Array<{
        rule_id?: string
        long_id?: string
        severity?: string
        description?: string
        location?: { filename?: string; start_line?: number }
      }>
    }

    if (json.results) {
      for (const result of json.results) {
        const sev = (result.severity ?? '').toUpperCase()
        const severity: TerraformGovernanceFinding['severity'] =
          sev === 'CRITICAL' ? 'critical'
            : sev === 'HIGH' ? 'high'
              : sev === 'MEDIUM' ? 'medium'
                : sev === 'LOW' ? 'low' : 'info'
        findings.push({
          severity,
          ruleId: result.long_id ?? result.rule_id ?? 'tfsec',
          message: result.description ?? '',
          file: result.location?.filename ?? '',
          line: result.location?.start_line ?? 0
        })
      }
    }
  } catch {
    // Ignore parse errors
  }

  const criticalOrHigh = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length
  return {
    toolId: 'tfsec',
    label: 'Security Scan (tfsec)',
    status: findings.length === 0 ? 'passed' : (criticalOrHigh > 0 ? 'failed' : 'passed'),
    blocking: false,
    summary: findings.length === 0
      ? 'No security issues found'
      : `${findings.length} finding${findings.length !== 1 ? 's' : ''} (${criticalOrHigh} critical/high)`,
    findings,
    output: clean,
    durationMs: Date.now() - start,
    ranAt: new Date().toISOString()
  }
}

/* ── checkov ─────────────────────────────────────────────── */

async function runCheckovCheck(rootPath: string, checkovPath: string): Promise<TerraformGovernanceCheckResult> {
  const start = Date.now()
  const { output, exitCode } = await runToolProcess(
    rootPath,
    checkovPath,
    ['-d', '.', '--framework', 'terraform', '-o', 'json', '--compact', '--quiet']
  )
  const clean = stripAnsi(output)
  const findings: TerraformGovernanceFinding[] = []

  try {
    // Checkov may output an array or single object
    const raw = JSON.parse(clean)
    const results = Array.isArray(raw) ? raw : [raw]

    for (const block of results) {
      const failed = block?.results?.failed_checks ?? []
      for (const check of failed) {
        const sev = (check.severity ?? check.check_result?.severity ?? '').toUpperCase()
        const severity: TerraformGovernanceFinding['severity'] =
          sev === 'CRITICAL' ? 'critical'
            : sev === 'HIGH' ? 'high'
              : sev === 'MEDIUM' ? 'medium'
                : sev === 'LOW' ? 'low' : 'medium'
        findings.push({
          severity,
          ruleId: check.check_id ?? 'checkov',
          message: check.check_name ?? check.name ?? '',
          file: check.file_path ?? '',
          line: check.file_line_range?.[0] ?? 0
        })
      }
    }
  } catch {
    // Ignore parse errors
  }

  const criticalOrHigh = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length
  return {
    toolId: 'checkov',
    label: 'Security Scan (Checkov)',
    status: findings.length === 0 ? 'passed' : (criticalOrHigh > 0 ? 'failed' : 'passed'),
    blocking: false,
    summary: findings.length === 0
      ? 'All checks passed'
      : `${findings.length} failed check${findings.length !== 1 ? 's' : ''} (${criticalOrHigh} critical/high)`,
    findings,
    output: clean,
    durationMs: Date.now() - start,
    ranAt: new Date().toISOString()
  }
}

/* ── Pipeline Orchestrator ───────────────────────────────── */

const projectReports = new Map<string, TerraformGovernanceReport>()

export async function runGovernanceChecks(
  projectId: string,
  rootPath: string,
  env: Record<string, string>
): Promise<TerraformGovernanceReport> {
  const toolkit = cachedToolkit ?? await detectGovernanceTools()
  const toolMap = new Map(toolkit.tools.map((t) => [t.id, t]))

  const checks: TerraformGovernanceCheckResult[] = []

  // 1. terraform fmt (non-blocking)
  const fmtTool = toolMap.get('fmt')
  if (fmtTool?.available) {
    checks.push(await runFmtCheck(rootPath, fmtTool.path))
  }

  // 2. terraform validate (blocking)
  const validateTool = toolMap.get('validate')
  if (validateTool?.available) {
    checks.push(await runValidateCheck(rootPath, validateTool.path, env))
  }

  // 3. tflint (non-blocking)
  const tflintTool = toolMap.get('tflint')
  if (tflintTool?.available) {
    checks.push(await runTflintCheck(rootPath, tflintTool.path))
  }

  // 4. tfsec (non-blocking) — prefer tfsec, skip if checkov available and tfsec missing
  const tfsecTool = toolMap.get('tfsec')
  if (tfsecTool?.available) {
    checks.push(await runTfsecCheck(rootPath, tfsecTool.path))
  }

  // 5. checkov (non-blocking) — run if available and tfsec was not
  const checkovTool = toolMap.get('checkov')
  if (checkovTool?.available && !tfsecTool?.available) {
    checks.push(await runCheckovCheck(rootPath, checkovTool.path))
  }

  const allBlockingPassed = checks
    .filter((c) => c.blocking)
    .every((c) => c.status === 'passed')

  const report: TerraformGovernanceReport = {
    projectId,
    checks,
    ranAt: new Date().toISOString(),
    allBlockingPassed
  }
  projectReports.set(projectId, report)
  return report
}

export function getGovernanceReport(projectId: string): TerraformGovernanceReport | null {
  return projectReports.get(projectId) ?? null
}

export function clearGovernanceReport(projectId: string): void {
  projectReports.delete(projectId)
}
