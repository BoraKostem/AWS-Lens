import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'

import type { BrowserWindow } from 'electron'

import type {
  TerraformActionRow,
  TerraformCliInfo,
  TerraformCommandLog,
  TerraformCommandRequest,
  TerraformDiagram,
  TerraformGraphEdge,
  TerraformGraphNode,
  TerraformMissingVarsResult,
  TerraformPlanChange,
  TerraformProject,
  TerraformProjectListItem,
  TerraformProjectMetadata,
  TerraformProjectStatus,
  TerraformResourceInventoryItem,
  TerraformResourceRow,
  TerraformS3BackendConfig,
  TerraformVariableDefinition
} from '@shared/types'
import { getProjects, setProjects } from './store'

/* ── Stored project shape (persistence) ───────────────────── */

type StoredProject = {
  id: string
  name: string
  rootPath: string
  varFile: string
  variables: Record<string, unknown>
}

type ProjectEvent =
  | { type: 'started'; projectId: string; log: TerraformCommandLog }
  | { type: 'output'; projectId: string; logId: string; chunk: string }
  | { type: 'progress'; projectId: string; address: string; status: string; raw: string }
  | { type: 'completed'; projectId: string; log: TerraformCommandLog; project: TerraformProject | null }

const INPUTS_FILE = '.terraform-workspace.auto.tfvars.json'
const PLAN_FILE = '.terraform-workspace.tfplan'
const STATE_CACHE_FILE = '.terraform-workspace.state.json'

const commandLogs = new Map<string, TerraformCommandLog[]>()
const savedPlanPaths = new Map<string, string>()

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

function stateCachePath(rootPath: string): string {
  return path.join(rootPath, STATE_CACHE_FILE)
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
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

/* ── Terraform Config Parsing (for dependency graph) ──────── */

type ConfigBlock = { blockType: 'resource' | 'data'; tfType: string; tfName: string; body: string }

function parseConfigBlocks(rootPath: string): ConfigBlock[] {
  const tfFiles = listTerraformFiles(rootPath)
  const combined = tfFiles.map(readText).join('\n')
  const blocks: ConfigBlock[] = []
  const resourceRe = /\b(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/g
  let match: RegExpExecArray | null
  while ((match = resourceRe.exec(combined)) !== null) {
    const start = match.index + match[0].length
    let depth = 1
    let i = start
    while (i < combined.length && depth > 0) {
      if (combined[i] === '{') depth++
      else if (combined[i] === '}') depth--
      i++
    }
    blocks.push({
      blockType: match[1] as 'resource' | 'data',
      tfType: match[2],
      tfName: match[3],
      body: combined.slice(start, i - 1)
    })
  }
  return blocks
}

function buildConfigEdges(blocks: ConfigBlock[]): TerraformGraphEdge[] {
  const edges: TerraformGraphEdge[] = []
  const edgeSet = new Set<string>()
  for (const block of blocks) {
    const address = block.blockType === 'data'
      ? `data.${block.tfType}.${block.tfName}`
      : `${block.tfType}.${block.tfName}`
    // Parse depends_on
    const dependsMatch = block.body.match(/depends_on\s*=\s*\[([\s\S]*?)\]/)
    if (dependsMatch) {
      const deps = dependsMatch[1].match(/[\w.]+/g) ?? []
      for (const dep of deps) {
        const key = `${dep}->${address}`
        if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: dep, to: address, relation: 'depends_on' }) }
      }
    }
    // Detect references like aws_vpc.main, data.aws_ami.latest
    const refRe = /(?:data\.)?aws_[\w]+\.[\w]+/g
    let refMatch: RegExpExecArray | null
    while ((refMatch = refRe.exec(block.body)) !== null) {
      const ref = refMatch[0]
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

function classifyAction(actions: string[]): string {
  const sorted = [...actions].sort()
  const key = sorted.join(',')
  if (key === 'create') return 'create'
  if (key === 'update') return 'update'
  if (key === 'delete') return 'delete'
  if (key === 'create,delete' || key === 'delete,create') return 'replace'
  return 'no-op'
}

function readPlanSnapshot(rootPath: string): {
  planChanges: TerraformPlanChange[]
  lastPlanSummary: { create: number; update: number; delete: number; replace: number; noop: number }
} {
  const planJsonPath = path.join(rootPath, `${PLAN_FILE}.json`)
  const plan = parseJsonFile<Record<string, unknown> | null>(planJsonPath, null)
  if (!plan || !Array.isArray(plan.resource_changes)) {
    return { planChanges: [], lastPlanSummary: { create: 0, update: 0, delete: 0, replace: 0, noop: 0 } }
  }
  const summary = { create: 0, update: 0, delete: 0, replace: 0, noop: 0 }
  const planChanges = plan.resource_changes.flatMap((cr) => {
    if (!cr || typeof cr !== 'object') return []
    const rec = cr as Record<string, unknown>
    const change = rec.change as Record<string, unknown> | undefined
    const actions = Array.isArray(change?.actions) ? change.actions.filter((v): v is string => typeof v === 'string') : []
    const label = classifyAction(actions)
    if (label === 'create') summary.create++
    else if (label === 'update') summary.update++
    else if (label === 'delete') summary.delete++
    else if (label === 'replace') summary.replace++
    else summary.noop++
    return [{
      address: typeof rec.address === 'string' ? rec.address : '',
      type: typeof rec.type === 'string' ? rec.type : '',
      name: typeof rec.name === 'string' ? rec.name : '',
      modulePath: typeof rec.module_address === 'string' ? rec.module_address : 'root',
      provider: typeof rec.provider_name === 'string' ? rec.provider_name : '',
      actions,
      actionLabel: label
    }].filter((item) => item.address)
  })
  return { planChanges, lastPlanSummary: summary }
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

function readJsonVarFile(varFilePath: string): Record<string, unknown> {
  if (!varFilePath) return {}
  const lower = varFilePath.toLowerCase()
  if (!lower.endsWith('.json') && !lower.endsWith('.tfvars.json')) return {}
  return parseJsonFile<Record<string, unknown>>(varFilePath, {})
}

function buildEnvWithVars(project: StoredProject): Record<string, string> {
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
  const varFileValues = readJsonVarFile(resolvedVarFile)
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
  return env
}

function writeAutoTfvars(project: StoredProject): void {
  if (project.variables && typeof project.variables === 'object' && Object.keys(project.variables).length > 0) {
    fs.writeFileSync(managedInputsPath(project.rootPath), JSON.stringify(project.variables, null, 2) + '\n', 'utf-8')
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

function loadProject(project: StoredProject): TerraformProject {
  const status = projectStatus(project.rootPath)
  if (status === 'Missing') {
    const emptyMeta: TerraformProjectMetadata = {
      terraformVersionConstraint: '', backendType: 'local', providerNames: [],
      resourceCount: 0, moduleCount: 0, variableCount: 0, outputsCount: 0, tfFileCount: 0,
      lastScannedAt: '', s3Backend: null
    }
    return {
      id: project.id, name: project.name, rootPath: project.rootPath,
      varFile: project.varFile ?? '', variables: project.variables ?? {},
      status: 'Missing', inputsFilePath: managedInputsPath(project.rootPath),
      detectedVariables: [], inputs: {}, metadata: emptyMeta,
      inventory: [], planChanges: [], actionRows: [], resourceRows: [],
      diagram: { nodes: [], edges: [] },
      lastPlanSummary: { create: 0, update: 0, delete: 0, replace: 0, noop: 0 },
      lastCommandAt: commandLogs.get(project.id)?.[0]?.startedAt ?? '',
      stateAddresses: [], rawStateJson: '', stateSource: 'none',
      hasSavedPlan: savedPlanPaths.has(project.id)
    }
  }

  const { metadata, variables } = inferMetadata(project.rootPath)
  const inputs = parseJsonFile<Record<string, unknown>>(managedInputsPath(project.rootPath), {})
  const { inventory, stateAddresses, rawStateJson, stateSource } = readStateSnapshot(project.rootPath)
  const { planChanges, lastPlanSummary } = readPlanSnapshot(project.rootPath)
  const actionRows = buildActionRows(planChanges, inventory)
  const resourceRows = buildResourceRows(inventory)
  const diagram = buildDiagram(inventory, planChanges, project.rootPath)

  return {
    id: project.id, name: project.name, rootPath: project.rootPath,
    varFile: project.varFile ?? '', variables: project.variables ?? {},
    status, inputsFilePath: managedInputsPath(project.rootPath),
    detectedVariables: variables, inputs, metadata,
    inventory, planChanges, actionRows, resourceRows, diagram,
    lastPlanSummary, lastCommandAt: commandLogs.get(project.id)?.[0]?.startedAt ?? '',
    stateAddresses, rawStateJson, stateSource,
    hasSavedPlan: savedPlanPaths.has(project.id)
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
    variables: (raw.variables && typeof raw.variables === 'object' && !Array.isArray(raw.variables)) ? raw.variables as Record<string, unknown> : {}
  }
}

function getStoredProjects(): StoredProject[] {
  return (getProjects() as unknown as Record<string, unknown>[])
    .map(normalizeStored)
    .filter((p): p is StoredProject => p !== null)
}

function setStoredProjects(projects: StoredProject[]): void {
  setProjects(projects as unknown as Array<{ id: string; name: string; rootPath: string }>)
}

export function listProjectSummaries(): TerraformProjectListItem[] {
  return getStoredProjects().map(loadProject)
}

export function getProject(projectId: string): TerraformProject {
  const project = getStoredProjects().find((p) => p.id === projectId)
  if (!project) throw new Error('Project not found.')
  return loadProject(project)
}

export function addProject(rootPath: string): TerraformProject {
  const normalized = path.resolve(rootPath)
  if (!fs.existsSync(normalized)) throw new Error('Selected path does not exist.')
  if (!fs.statSync(normalized).isDirectory()) throw new Error('Project path must be a directory.')
  if (listTerraformFiles(normalized).length === 0) throw new Error('No Terraform files were found in the selected directory.')

  const stored = getStoredProjects()
  const existing = stored.find((p) => path.normalize(p.rootPath).toLowerCase() === path.normalize(normalized).toLowerCase())
  if (existing) return loadProject(existing)

  const created: StoredProject = {
    id: randomUUID(), name: path.basename(normalized), rootPath: normalized, varFile: '', variables: {}
  }
  setStoredProjects([...stored, created])
  return loadProject(created)
}

export function removeProject(projectId: string): void {
  setStoredProjects(getStoredProjects().filter((p) => p.id !== projectId))
  commandLogs.delete(projectId)
  savedPlanPaths.delete(projectId)
}

export function renameProject(projectId: string, name: string): TerraformProject {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Project name is required.')
  const updated = getStoredProjects().map((p) => p.id === projectId ? { ...p, name: trimmed } : p)
  setStoredProjects(updated)
  return getProject(projectId)
}

export function updateProjectInputs(
  projectId: string,
  inputs: Record<string, unknown>,
  varFile?: string
): TerraformProject {
  const stored = getStoredProjects()
  const idx = stored.findIndex((p) => p.id === projectId)
  if (idx < 0) throw new Error('Project not found.')
  const project = stored[idx]
  if (varFile !== undefined) project.varFile = varFile
  project.variables = inputs
  writeAutoTfvars(project)
  setStoredProjects(stored)
  return loadProject(project)
}

export function getCommandLogs(projectId: string): TerraformCommandLog[] {
  return commandLogs.get(projectId) ?? []
}

/* ── Missing variable detection ───────────────────────────── */

export function detectMissingVars(output: string): TerraformMissingVarsResult {
  const missing: string[] = []
  const invalid: string[] = []
  for (const m of output.matchAll(/The root module input variable "([^"]+)" is not set/g)) {
    missing.push(m[1])
  }
  for (const m of output.matchAll(/variable "([^"]+)" \{/g)) {
    invalid.push(m[1])
  }
  return { missing, invalid }
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
  const { output } = await runChildProcess(rootPath, 'terraform', ['show', '-json', planPath], env)
  fs.writeFileSync(jsonPath, output, 'utf-8')
}

async function refreshRemoteStateCache(rootPath: string, env: Record<string, string>): Promise<void> {
  try {
    const result = await runChildProcess(rootPath, 'terraform', ['state', 'pull'], env)
    if (result.exitCode === 0 && result.output.trim()) {
      fs.writeFileSync(stateCachePath(rootPath), result.output, 'utf-8')
    }
  } catch { /* keep previous cache */ }
}

function buildArgs(request: TerraformCommandRequest, project: StoredProject): string[] {
  const varFileArgs: string[] = []
  const resolved = resolveVarFilePath(project.varFile, project.rootPath)
  if (resolved) varFileArgs.push('-var-file', resolved)
  const inputsFile = managedInputsPath(project.rootPath)
  if (fs.existsSync(inputsFile)) varFileArgs.push('-var-file', inputsFile)

  switch (request.command) {
    case 'version':
      return ['version']
    case 'init':
      return ['init', '-input=false', '-no-color']
    case 'plan':
      return ['plan', '-input=false', '-no-color', '-detailed-exitcode', '-out', PLAN_FILE, ...varFileArgs]
    case 'apply': {
      const planPath = path.join(project.rootPath, PLAN_FILE)
      if (fs.existsSync(planPath)) {
        return ['apply', '-input=false', '-no-color', '-auto-approve', PLAN_FILE]
      }
      return ['apply', '-input=false', '-no-color', '-auto-approve', ...varFileArgs]
    }
    case 'destroy':
      return ['destroy', '-input=false', '-no-color', '-auto-approve', ...varFileArgs]
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
  const stored = getStoredProjects()
  const project = stored.find((p) => p.id === request.projectId)
  if (!project) throw new Error('Project not found.')

  // Ensure auto.tfvars is written before commands that need it
  if (['plan', 'apply', 'destroy'].includes(request.command)) {
    writeAutoTfvars(project)
  }

  const args = buildArgs(request, project)
  const env = buildEnvWithVars(project)
  const log: TerraformCommandLog = {
    id: randomUUID(), projectId: request.projectId, command: request.command,
    args, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null,
    success: null, output: ''
  }

  pushLog(request.projectId, log)
  emit(window, { type: 'started', projectId: request.projectId, log })

  let lastProgressTime = 0

  try {
    const result = await runChildProcess(project.rootPath, 'terraform', args, env, (chunk) => {
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
      await runTerraformShowJson(project.rootPath, path.join(project.rootPath, PLAN_FILE), env)
      savedPlanPaths.set(project.id, path.join(project.rootPath, PLAN_FILE))
    }
    if (request.command === 'apply' || request.command === 'destroy') {
      savedPlanPaths.delete(project.id)
      if (result.exitCode === 0) {
        await refreshRemoteStateCache(project.rootPath, env)
      }
    }
    if (request.command === 'state-pull' && result.exitCode === 0 && log.output.trim()) {
      fs.writeFileSync(stateCachePath(project.rootPath), log.output, 'utf-8')
    }

    const refreshedProject = loadProject(project)
    emit(window, { type: 'completed', projectId: request.projectId, log, project: refreshedProject })
    return log
  } catch (error) {
    log.finishedAt = new Date().toISOString()
    log.exitCode = -1
    log.success = false
    log.output += `\n${error instanceof Error ? error.message : String(error)}`
    emit(window, { type: 'completed', projectId: request.projectId, log, project: loadProject(project) })
    return log
  }
}

export function hasSavedPlan(projectId: string): boolean {
  return savedPlanPaths.has(projectId)
}

export function clearSavedPlan(projectId: string): void {
  savedPlanPaths.delete(projectId)
}
