import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'

import { app, type BrowserWindow } from 'electron'

import type {
  TerraformActionRow,
  TerraformCliInfo,
  TerraformCommandLog,
  TerraformCommandRequest,
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
  TerraformProjectListItem,
  TerraformProjectMetadata,
  TerraformProjectStatus,
  TerraformResourceInventoryItem,
  TerraformResourceRow,
  TerraformStateBackupSummary,
  TerraformStateLockInfo,
  TerraformS3BackendConfig,
  TerraformWorkspaceSummary,
  TerraformVariableDefinition,
  AwsConnection
} from '@shared/types'
import { getProjects, setProjects } from './store'
import { getConnectionEnv } from './sessionHub'
import { saveRunRecord, updateRunRecord, redactArgs } from './terraformHistoryStore'
import type { TerraformRunRecord } from '@shared/types'

/* ── Stored project shape (persistence) ───────────────────── */

type StoredProject = {
  id: string
  name: string
  rootPath: string
  varFile: string
  variables: Record<string, unknown>
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

const commandLogs = new Map<string, TerraformCommandLog[]>()
const savedPlanPaths = new Map<string, string>()
const activeDestructiveCommands = new Map<string, 'apply' | 'destroy'>()

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
  return path.join(rootPath, INPUTS_FILE)
}

function temporaryStateVarFilePath(rootPath: string): string {
  return path.join(rootPath, 'terraform.tfvars.json')
}

function stateCachePath(rootPath: string): string {
  return path.join(rootPath, STATE_CACHE_FILE)
}

function planPath(rootPath: string): string {
  return path.join(rootPath, PLAN_FILE)
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

function terraformCommand(): string {
  return cachedCli?.found && cachedCli.path ? cachedCli.path : 'terraform'
}

function displayConnectionLabel(profileName: string, connection?: AwsConnection): string {
  if (connection?.label) return connection.label
  if (profileName.startsWith('profile:')) return profileName.slice('profile:'.length)
  return ''
}

function inferVarSetLabel(project: StoredProject): string {
  const hasInlineVars = Object.keys(project.variables ?? {}).length > 0
  if (project.varFile) {
    return hasInlineVars ? `${path.basename(project.varFile)} + inline inputs` : path.basename(project.varFile)
  }
  return hasInlineVars ? 'Inline inputs' : ''
}

function inferEnvironmentLabel(workspaceName: string): string {
  if (!workspaceName || workspaceName === 'default') return 'Default'
  return workspaceName
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

function readPlanOptions(rootPath: string): TerraformPlanOptionsSummary {
  return normalizePlanOptions(parseJsonFile<TerraformPlanOptions | null>(planMetadataPath(rootPath), null) ?? undefined)
}

function writePlanOptions(rootPath: string, options?: TerraformPlanOptions): void {
  fs.writeFileSync(planMetadataPath(rootPath), JSON.stringify(normalizePlanOptions(options), null, 2), 'utf-8')
}

/* ── CLI Detection ────────────────────────────────────────── */

let cachedCli: TerraformCliInfo | null = null

function terraformCandidates(): string[] {
  const names = process.platform === 'win32' ? ['terraform.exe', 'terraform'] : ['terraform']
  const fallbacks: string[] = []
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pfx86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    fallbacks.push(
      path.join(pf, 'Terraform', 'terraform.exe'),
      path.join(pfx86, 'Terraform', 'terraform.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Terraform', 'terraform.exe'),
      path.join(os.homedir(), '.tfenv', 'bin', 'terraform.exe')
    )
  } else if (process.platform === 'darwin') {
    fallbacks.push(
      '/usr/local/bin/terraform',
      '/opt/homebrew/bin/terraform',
      path.join(os.homedir(), '.tfenv', 'bin', 'terraform'),
      path.join(os.homedir(), 'bin', 'terraform')
    )
  } else {
    fallbacks.push(
      '/usr/local/bin/terraform',
      '/usr/bin/terraform',
      '/snap/bin/terraform',
      path.join(os.homedir(), '.tfenv', 'bin', 'terraform'),
      path.join(os.homedir(), 'bin', 'terraform')
    )
  }
  return [...names, ...fallbacks]
}

export async function detectTerraformCli(): Promise<TerraformCliInfo> {
  for (const candidate of terraformCandidates()) {
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(candidate, ['version', '-json'], { timeout: 10000 }, (err, stdout, stderr) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
      let version = ''
      try {
        const json = JSON.parse(result.stdout) as { terraform_version?: string }
        version = json.terraform_version ?? ''
      } catch {
        const match = result.stdout.match(/Terraform v([\d.]+)/)
        version = match?.[1] ?? result.stdout.trim().slice(0, 40)
      }
      cachedCli = { found: true, path: candidate, version, error: '' }
      return cachedCli
    } catch {
      continue
    }
  }
  cachedCli = { found: false, path: '', version: '', error: 'Terraform CLI not found. Please install Terraform and ensure it is on your PATH.' }
  return cachedCli
}

export function getCachedCliInfo(): TerraformCliInfo {
  return cachedCli ?? { found: false, path: '', version: '', error: 'CLI detection has not run yet.' }
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

function readWorkspaceSnapshot(project: StoredProject, connection?: AwsConnection): { currentWorkspace: string; workspaces: TerraformWorkspaceSummary[] } {
  const fallback = fallbackWorkspaceSnapshot(project.rootPath)

  try {
    const env = buildEnvWithVars(project, connection)
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

function prefixAddress(modulePath: string, address: string): string {
  return modulePath ? `${modulePath}.${address}` : address
}

function normalizeConfigReference(reference: string, modulePath: string): string {
  if (!reference) return ''
  if (reference.startsWith('module.') || reference.startsWith('var.') || reference.startsWith('local.') || reference.startsWith('path.')) {
    return reference
  }
  if (reference.startsWith('data.')) {
    return prefixAddress(modulePath, reference)
  }
  if (/^aws_[\w-]+\.[\w-]+$/.test(reference)) {
    return prefixAddress(modulePath, reference)
  }
  return reference
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
    const refRe = /(?:data\.)?aws_[\w]+\.[\w]+/g
    let refMatch: RegExpExecArray | null
    while ((refMatch = refRe.exec(block.body)) !== null) {
      const ref = normalizeConfigReference(refMatch[0], block.modulePath)
      if (ref !== address && !ref.startsWith(address + '.')) {
        const key = `${ref}->${address}`
        if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: ref, to: address, relation: 'reference' }) }
      }
    }
  }
  return edges
}

/* ── Dynamic Identity Inference for Graph Edges ───────────── */

const IDENTITY_KEYS = ['id', 'arn', 'name', 'bucket', 'cluster_identifier', 'db_instance_identifier']
const REFERENCE_KEYS = [
  'vpc_id', 'subnet_id', 'security_group_id', 'role_arn', 'instance_id', 'cluster_name',
  'target_group_arn', 'load_balancer_arn', 'log_group_name', 'kms_key_id', 'certificate_arn',
  'hosted_zone_id', 'db_subnet_group_name', 'execution_role_arn', 'task_role_arn'
]
const PLURAL_REFERENCE_KEYS = ['subnet_ids', 'security_group_ids', 'security_groups', 'vpc_security_group_ids']

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

  return {
    metadata: {
      terraformVersionConstraint: versionConstraint,
      backendType,
      backend: buildBackendDetails(rootPath, backendType, s3Backend),
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
  return typeof values.arn === 'string' ? values.arn : ''
}

function extractRegion(values: Record<string, unknown>): string {
  const arn = extractArn(values)
  if (arn) {
    const parts = arn.split(':')
    if (parts.length >= 4 && parts[3]) return parts[3]
  }
  if (typeof values.region === 'string' && values.region) return values.region
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
    nodeMap.set(item.address, { id: item.address, label: item.address, category: item.type || 'resource' })
    for (const dep of item.dependsOn) {
      addEdge({ from: dep, to: item.address, relation: 'depends_on' })
      if (!nodeMap.has(dep)) nodeMap.set(dep, { id: dep, label: dep, category: 'dependency' })
    }
  }

  // Nodes from plan changes
  for (const change of changes) {
    nodeMap.set(change.address, {
      id: change.address,
      label: `${change.address} (${change.actionLabel})`,
      category: change.actionLabel
    })
  }

  // Static config edges
  const configBlocks = parseConfigBlocks(rootPath)
  for (const edge of buildConfigEdges(configBlocks)) {
    addEdge(edge)
    if (!nodeMap.has(edge.from)) nodeMap.set(edge.from, { id: edge.from, label: edge.from, category: 'config' })
    if (!nodeMap.has(edge.to)) nodeMap.set(edge.to, { id: edge.to, label: edge.to, category: 'config' })
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

function buildEnvWithVars(project: StoredProject, connection?: AwsConnection): Record<string, string> {
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
  if (process.platform === 'win32') {
    env.APPDATA = tmpDir
  } else {
    env.XDG_CONFIG_HOME = tmpDir
  }
  const resolvedVarFile = resolveVarFilePath(project.varFile, project.rootPath)
  const varFileValues = readVarFileValues(resolvedVarFile)
  // Export variables as TF_VAR_*
  for (const [key, value] of Object.entries(varFileValues)) {
    if (typeof value === 'string') env[`TF_VAR_${key}`] = value
    else env[`TF_VAR_${key}`] = JSON.stringify(value)
  }
  if (project.variables && typeof project.variables === 'object') {
    for (const [key, value] of Object.entries(project.variables)) {
      if (typeof value === 'string') env[`TF_VAR_${key}`] = value
      else env[`TF_VAR_${key}`] = JSON.stringify(value)
    }
  }

  if (connection) {
    delete env.AWS_PROFILE
    delete env.AWS_ACCESS_KEY_ID
    delete env.AWS_SECRET_ACCESS_KEY
    delete env.AWS_SESSION_TOKEN
    Object.assign(env, getConnectionEnv(connection))
  }

  return env
}

function writeAutoTfvars(project: StoredProject): void {
  const mergedValues = readMergedInputValues(project)
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

function readMergedInputValues(project: StoredProject): Record<string, unknown> {
  const resolvedVarFile = resolveVarFilePath(project.varFile, project.rootPath)
  return {
    ...readVarFileValues(resolvedVarFile),
    ...((project.variables && typeof project.variables === 'object') ? project.variables : {})
  }
}

function buildEnvironmentMetadata(
  project: StoredProject,
  profileName: string,
  connection: AwsConnection | undefined,
  metadata: TerraformProjectMetadata,
  currentWorkspace: string
): TerraformProjectEnvironmentMetadata {
  return {
    environmentLabel: inferEnvironmentLabel(currentWorkspace),
    workspaceName: currentWorkspace,
    region: connection?.region ?? project.environment?.region ?? metadata.s3Backend?.region ?? '',
    connectionLabel: displayConnectionLabel(profileName, connection) || project.environment?.connectionLabel || '',
    backendType: metadata.backendType,
    varSetLabel: inferVarSetLabel(project) || project.environment?.varSetLabel || ''
  }
}

export function getMissingRequiredInputs(profileName: string, projectId: string): string[] {
  const project = getStoredProjects(profileName).find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')

  const { variables } = inferMetadata(project.rootPath)
  const mergedInputs = readMergedInputValues(project)

  return variables
    .filter((variable) => {
      if (variable.hasDefault) return false
      if (!(variable.name in mergedInputs)) return true
      const value = mergedInputs[variable.name]
      if (value === null || value === undefined) return true
      if (typeof value === 'string' && value.trim().length === 0) return true
      return false
    })
    .map((variable) => variable.name)
}

function prepareStateCommandVarFile(project: StoredProject): (() => void) | null {
  const mergedValues = readMergedInputValues(project)
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
  onChunk?: (chunk: string) => void
): Promise<{ output: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true })
    let output = ''
    child.stdout.on('data', (buf) => {
      const chunk = buf.toString(); output += chunk; onChunk?.(chunk)
    })
    child.stderr.on('data', (buf) => {
      const chunk = buf.toString(); output += chunk; onChunk?.(chunk)
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => resolve({ output, exitCode: code ?? -1 }))
  })
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
      }, providerNames: [],
      resourceCount: 0, moduleCount: 0, variableCount: 0, outputsCount: 0, tfFileCount: 0,
      lastScannedAt: '', s3Backend: null
    }
    const currentWorkspace = project.environment?.workspaceName || 'default'
    return {
      id: project.id, name: project.name, rootPath: project.rootPath,
      varFile: project.varFile ?? '', variables: project.variables ?? {},
      environment: buildEnvironmentMetadata(project, profileName, connection, emptyMeta, currentWorkspace),
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
      hasSavedPlan: savedPlanPaths.has(project.id) || hasSavedPlanArtifacts(project.rootPath)
    }
  }

  const { metadata, variables } = inferMetadata(project.rootPath)
  const { currentWorkspace, workspaces } = readWorkspaceSnapshot(project, connection)
  const inputs = parseJsonFile<Record<string, unknown>>(managedInputsPath(project.rootPath), {})
  const { inventory, stateAddresses, rawStateJson, stateSource } = readStateSnapshot(project.rootPath)
  const { planChanges, lastPlanSummary } = readPlanSnapshot(project.rootPath)
  const actionRows = buildActionRows(planChanges, inventory)
  const resourceRows = buildResourceRows(inventory)
  const diagram = buildDiagram(inventory, planChanges, project.rootPath)
  const environment = buildEnvironmentMetadata(project, profileName, connection, metadata, currentWorkspace)
  const stateBackups = listStateBackups(project.id)
  const stateLockInfo = readStateLockInfo(project.rootPath, metadata.backendType)

  return {
    id: project.id, name: project.name, rootPath: project.rootPath,
    varFile: project.varFile ?? '', variables: project.variables ?? {},
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
    hasSavedPlan: savedPlanPaths.has(project.id) || hasSavedPlanArtifacts(project.rootPath)
  }
}

/* ── Public API ────────────────────────────────────────────── */

function normalizeStored(raw: Record<string, unknown>): StoredProject | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.rootPath !== 'string') return null
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : path.basename(raw.rootPath as string),
    rootPath: raw.rootPath as string,
    varFile: typeof raw.varFile === 'string' ? raw.varFile : '',
    variables: (raw.variables && typeof raw.variables === 'object' && !Array.isArray(raw.variables)) ? raw.variables as Record<string, unknown> : {},
    environment: (raw.environment && typeof raw.environment === 'object' && !Array.isArray(raw.environment))
      ? raw.environment as TerraformProjectEnvironmentMetadata
      : undefined
  }
}

function validateWorkspaceName(workspaceName: string): string {
  const trimmed = workspaceName.trim()
  if (!trimmed) throw new Error('Workspace name is required.')
  if (/\s/.test(trimmed)) throw new Error('Workspace names cannot contain whitespace.')
  return trimmed
}

async function runWorkspaceCommand(
  project: StoredProject,
  args: string[],
  connection?: AwsConnection
): Promise<void> {
  const env = buildEnvWithVars(project, connection)
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
  inputs: Record<string, unknown>,
  varFile?: string,
  connection?: AwsConnection
): TerraformProject {
  const stored = getStoredProjects(profileName)
  const idx = stored.findIndex((p) => p.id === projectId)
  if (idx < 0) throw new Error('Project not found.')
  const project = stored[idx]
  if (varFile !== undefined) project.varFile = varFile
  project.variables = inputs
  writeAutoTfvars(project)
  setStoredProjects(profileName, stored)
  return getProject(profileName, projectId, connection)
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
  await runWorkspaceCommand(project, ['workspace', 'select', target], connection)
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
  await runWorkspaceCommand(project, ['workspace', 'new', target], connection)
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
  const snapshot = readWorkspaceSnapshot(project, connection)
  if (snapshot.currentWorkspace === target) {
    throw new Error('Select a different workspace before deleting the current workspace.')
  }
  await runWorkspaceCommand(project, ['workspace', 'delete', target], connection)
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
  commandLogs.set(projectId, logs.slice(0, 24))
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

function buildArgs(request: TerraformCommandRequest, project: StoredProject): string[] {
  const varFileArgs: string[] = []
  const resolved = resolveVarFilePath(project.varFile, project.rootPath)
  if (resolved) varFileArgs.push('-var-file', resolved)
  const inputsFile = managedInputsPath(project.rootPath)
  if (fs.existsSync(inputsFile)) varFileArgs.push('-var-file', inputsFile)
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

  const args = buildArgs(request, project)
  const env = buildEnvWithVars(project, request.connection)
  const cleanupStateVarFile = ['state-list', 'state-pull', 'state-show', 'state-mv', 'state-rm', 'force-unlock'].includes(request.command)
    ? prepareStateCommandVarFile(project)
    : null
  const destructiveStateOperation = request.command === 'state-mv' || request.command === 'state-rm' || request.command === 'force-unlock'
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
    stateOperationSummary
  }
  saveRunRecord(runRecord, '')

  if (request.command === 'apply' || request.command === 'destroy') {
    activeDestructiveCommands.set(request.projectId, request.command)
  }

  let lastProgressTime = 0

  try {
    if (destructiveStateOperation) {
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
    })

    log.exitCode = result.exitCode
    log.finishedAt = new Date().toISOString()
    // plan with -detailed-exitcode: 0=no changes, 2=changes present, both are success
    log.success = request.command === 'plan'
      ? (result.exitCode === 0 || result.exitCode === 2)
      : result.exitCode === 0

    // Post-command actions
    if (request.command === 'plan' && log.success) {
      writePlanOptions(project.rootPath, request.planOptions)
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
    log.exitCode = -1
    log.success = false
    log.output += `\n${error instanceof Error ? error.message : String(error)}`
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
    cleanupStateVarFile?.()
    if (request.command === 'apply' || request.command === 'destroy') {
      activeDestructiveCommands.delete(request.projectId)
    }
  }
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
} {
  const project = getStoredProjects(profileName).find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  return {
    rootPath: project.rootPath,
    env: buildEnvWithVars(project, connection),
    tfCliPath: terraformCommand()
  }
}
