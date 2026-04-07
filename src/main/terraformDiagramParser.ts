import fs from 'node:fs'
import path from 'node:path'

import type {
  TerraformDiagram,
  TerraformGraphEdge,
  TerraformGraphNode,
  TerraformPlanChange,
  TerraformResourceInventoryItem
} from '@shared/types'

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

type DiagramParserProfile = {
  id: 'generic' | 'aws' | 'gcp' | 'azure' | 'huaweicloud'
  resourcePrefixes: string[]
  identityKeys: string[]
  referenceKeys: string[]
  pluralReferenceKeys: string[]
}

const PLAN_FILE = '.terraform-workspace.tfplan'
const RESOURCE_REFERENCE_PATTERN = '(?:module\\.[\\w-]+\\.)*(?:data\\.)?[a-z][\\w-]*_[\\w-]+\\.[\\w-]+'
const RESOURCE_REFERENCE_RE = new RegExp(RESOURCE_REFERENCE_PATTERN, 'g')
const LEADING_RESOURCE_REFERENCE_RE = new RegExp(`^${RESOURCE_REFERENCE_PATTERN}`)
const TF_FILE_SUFFIXES = ['.tf', '.tfvars', '.tfvars.json', '.terraform.lock.hcl']

const DIAGRAM_PARSER_PROFILES: DiagramParserProfile[] = [
  {
    id: 'generic',
    resourcePrefixes: [],
    identityKeys: ['id', 'name', 'self_link', 'arn'],
    referenceKeys: ['network', 'subnetwork', 'router', 'instance', 'cluster'],
    pluralReferenceKeys: []
  },
  {
    id: 'aws',
    resourcePrefixes: ['aws_'],
    identityKeys: ['bucket', 'cluster_identifier', 'db_instance_identifier'],
    referenceKeys: [
      'vpc_id', 'subnet_id', 'security_group_id', 'role_arn', 'instance_id', 'cluster_name',
      'target_group_arn', 'load_balancer_arn', 'log_group_name', 'kms_key_id', 'certificate_arn',
      'hosted_zone_id', 'db_subnet_group_name', 'execution_role_arn', 'task_role_arn'
    ],
    pluralReferenceKeys: ['subnet_ids', 'security_group_ids', 'security_groups', 'vpc_security_group_ids']
  },
  {
    id: 'gcp',
    resourcePrefixes: ['google_'],
    identityKeys: ['email'],
    referenceKeys: [
      'project', 'service_account', 'member', 'private_network', 'service', 'target', 'backend_service',
      'network', 'subnetwork', 'router', 'cluster', 'instance'
    ],
    pluralReferenceKeys: ['reserved_peering_ranges', 'target_tags']
  },
  {
    id: 'azure',
    resourcePrefixes: ['azurerm_'],
    identityKeys: ['resource_group_name'],
    referenceKeys: ['resource_group_name', 'virtual_network_name', 'subnet_id', 'public_ip_address_id'],
    pluralReferenceKeys: ['backend_address_pool_ids']
  },
  {
    id: 'huaweicloud',
    resourcePrefixes: ['huaweicloud_'],
    identityKeys: ['region'],
    referenceKeys: ['vpc_id', 'subnet_id', 'security_group_id'],
    pluralReferenceKeys: ['security_group_ids']
  }
]

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function parseJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function listTerraformFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return []
  const entries = fs.readdirSync(rootPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && TF_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
    .map((entry) => path.join(rootPath, entry.name))
}

function planJsonPath(rootPath: string): string {
  return path.join(rootPath, `${PLAN_FILE}.json`)
}

function prefixAddress(modulePath: string, address: string): string {
  return modulePath ? `${modulePath}.${address}` : address
}

function normalizeConfigReference(reference: string, modulePath: string): string {
  if (!reference) return ''
  const trimmed = reference.trim()
  if (
    trimmed.startsWith('var.')
    || trimmed.startsWith('local.')
    || trimmed.startsWith('path.')
    || trimmed.startsWith('terraform.')
    || trimmed.startsWith('provider.')
    || trimmed.startsWith('count.')
    || trimmed.startsWith('each.')
    || trimmed.startsWith('self.')
  ) {
    return ''
  }
  const resourceReference = trimmed.match(LEADING_RESOURCE_REFERENCE_RE)?.[0] ?? ''
  if (!resourceReference) return ''
  if (resourceReference.startsWith('module.')) {
    return resourceReference
  }
  return prefixAddress(modulePath, resourceReference)
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

function collectConfigBlocks(rootPath: string, modulePath: string, visitedPaths: Set<string>): ConfigBlock[] {
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

    const dependsMatch = block.body.match(/depends_on\s*=\s*\[([\s\S]*?)\]/)
    if (dependsMatch) {
      const deps = dependsMatch[1].match(/[\w.]+/g) ?? []
      for (const dep of deps) {
        const normalizedDep = normalizeConfigReference(dep, block.modulePath)
        if (!normalizedDep) continue
        const key = `${normalizedDep}->${address}`
        if (!edgeSet.has(key)) {
          edgeSet.add(key)
          edges.push({ from: normalizedDep, to: address, relation: 'depends_on' })
        }
      }
    }

    let refMatch: RegExpExecArray | null
    while ((refMatch = RESOURCE_REFERENCE_RE.exec(block.body)) !== null) {
      const ref = normalizeConfigReference(refMatch[0], block.modulePath)
      if (!ref || ref === address || ref.startsWith(`${address}.`)) continue
      const key = `${ref}->${address}`
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        edges.push({ from: ref, to: address, relation: 'reference' })
      }
    }
    RESOURCE_REFERENCE_RE.lastIndex = 0
  }
  return edges
}

function collectExpressionReferences(value: unknown, sink: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectExpressionReferences(item, sink)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (Array.isArray(record.references)) {
    for (const item of record.references) {
      if (typeof item === 'string' && item.trim()) sink.add(item.trim())
    }
  }
  for (const nested of Object.values(record)) {
    collectExpressionReferences(nested, sink)
  }
}

function buildPlanConfigEdges(rootPath: string): TerraformGraphEdge[] {
  const plan = parseJsonFile<Record<string, unknown> | null>(planJsonPath(rootPath), null)
  const configuration = plan?.configuration
  if (!configuration || typeof configuration !== 'object') return []
  const rootModule = (configuration as Record<string, unknown>).root_module
  if (!rootModule || typeof rootModule !== 'object') return []

  const edges: TerraformGraphEdge[] = []
  const edgeSet = new Set<string>()

  function addEdge(from: string, to: string): void {
    if (!from || !to || from === to || from.startsWith(`${to}.`)) return
    const key = `${from}->${to}`
    if (!edgeSet.has(key)) {
      edgeSet.add(key)
      edges.push({ from, to, relation: 'reference' })
    }
  }

  function walkModule(moduleNode: Record<string, unknown>, modulePath: string): void {
    const resources = Array.isArray(moduleNode.resources) ? moduleNode.resources : []
    for (const entry of resources) {
      const resource = entry as Record<string, unknown>
      const localAddress = typeof resource.address === 'string' ? resource.address : ''
      if (!localAddress) continue
      const address = prefixAddress(modulePath, localAddress)
      const refs = new Set<string>()
      collectExpressionReferences(resource.expressions, refs)
      const dependsOn = Array.isArray(resource.depends_on)
        ? resource.depends_on.filter((value): value is string => typeof value === 'string')
        : []
      for (const rawRef of [...refs, ...dependsOn]) {
        const normalized = normalizeConfigReference(rawRef, modulePath)
        if (normalized) addEdge(normalized, address)
      }
    }

    const moduleCalls = moduleNode.module_calls
    if (!moduleCalls || typeof moduleCalls !== 'object') return
    for (const [moduleName, entry] of Object.entries(moduleCalls as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const childModule = (entry as Record<string, unknown>).module
      if (!childModule || typeof childModule !== 'object') continue
      walkModule(childModule as Record<string, unknown>, prefixAddress(modulePath, `module.${moduleName}`))
    }
  }

  walkModule(rootModule as Record<string, unknown>, '')
  return edges
}

function activeProfiles(inventory: TerraformResourceInventoryItem[]): DiagramParserProfile[] {
  const detected = new Set<DiagramParserProfile['id']>(['generic'])
  for (const item of inventory) {
    for (const profile of DIAGRAM_PARSER_PROFILES) {
      if (profile.resourcePrefixes.length > 0 && profile.resourcePrefixes.some((prefix) => item.type.startsWith(prefix))) {
        detected.add(profile.id)
      }
    }
  }
  return DIAGRAM_PARSER_PROFILES.filter((profile) => detected.has(profile.id))
}

function inferDynamicEdges(
  inventory: TerraformResourceInventoryItem[],
  profiles: DiagramParserProfile[]
): TerraformGraphEdge[] {
  const identityKeys = [...new Set(profiles.flatMap((profile) => profile.identityKeys))]
  const referenceKeys = [...new Set(profiles.flatMap((profile) => profile.referenceKeys))]
  const pluralReferenceKeys = [...new Set(profiles.flatMap((profile) => profile.pluralReferenceKeys))]
  const identityIndex = new Map<string, string>()

  for (const item of inventory) {
    for (const key of identityKeys) {
      const value = item.values[key]
      if (typeof value === 'string' && value) identityIndex.set(value, item.address)
    }
  }

  const edges: TerraformGraphEdge[] = []
  const edgeSet = new Set<string>()

  for (const item of inventory) {
    for (const key of referenceKeys) {
      const value = item.values[key]
      if (typeof value !== 'string' || !value) continue
      const target = identityIndex.get(value)
      if (!target || target === item.address) continue
      const edgeKey = `${target}->${item.address}`
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey)
        edges.push({ from: target, to: item.address, relation: 'inferred' })
      }
    }

    for (const key of pluralReferenceKeys) {
      const value = item.values[key]
      if (!Array.isArray(value)) continue
      for (const entry of value) {
        if (typeof entry !== 'string') continue
        const target = identityIndex.get(entry)
        if (!target || target === item.address) continue
        const edgeKey = `${target}->${item.address}`
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey)
          edges.push({ from: target, to: item.address, relation: 'inferred' })
        }
      }
    }
  }

  return edges
}

function buildDiagramNodeLabel(address: string): string {
  const moduleSegments = [...address.matchAll(/module\.([\w-]+)/g)].map((match) => match[1])
  const moduleLabel = moduleSegments.slice(-2).join(' / ')
  const resourceReferenceMatch = address.match(/(?:(?:module\.[\w-]+\.)*)((?:data\.)?[a-z][\w-]*_[\w-]+\.[\w-]+)/)
  const resourceReference = resourceReferenceMatch?.[1] ?? ''
  const fullReference = resourceReferenceMatch?.[0] ?? ''
  const suffix = fullReference ? address.slice(address.indexOf(fullReference) + fullReference.length) : ''
  const baseLabel = resourceReference || address
  const label = moduleLabel ? `${moduleLabel} / ${baseLabel}${suffix}` : `${baseLabel}${suffix}`
  return label.length > 64 ? `${label.slice(0, 31)}...${label.slice(-30)}` : label
}

export function buildTerraformDiagram(
  inventory: TerraformResourceInventoryItem[],
  changes: TerraformPlanChange[],
  rootPath: string
): TerraformDiagram {
  const nodeMap = new Map<string, TerraformGraphNode>()
  const edgeMap = new Map<string, TerraformGraphEdge>()
  const profiles = activeProfiles(inventory)

  function addEdge(edge: TerraformGraphEdge): void {
    const key = `${edge.from}->${edge.to}`
    if (!edgeMap.has(key)) edgeMap.set(key, edge)
  }

  for (const item of inventory) {
    nodeMap.set(item.address, { id: item.address, label: buildDiagramNodeLabel(item.address), category: item.type || 'resource' })
    for (const dep of item.dependsOn) {
      addEdge({ from: dep, to: item.address, relation: 'depends_on' })
      if (!nodeMap.has(dep)) nodeMap.set(dep, { id: dep, label: buildDiagramNodeLabel(dep), category: 'dependency' })
    }
  }

  for (const change of changes) {
    nodeMap.set(change.address, {
      id: change.address,
      label: buildDiagramNodeLabel(change.address),
      category: change.actionLabel
    })
  }

  const configBlocks = parseConfigBlocks(rootPath)
  for (const edge of buildConfigEdges(configBlocks)) {
    addEdge(edge)
    if (!nodeMap.has(edge.from)) nodeMap.set(edge.from, { id: edge.from, label: buildDiagramNodeLabel(edge.from), category: 'config' })
    if (!nodeMap.has(edge.to)) nodeMap.set(edge.to, { id: edge.to, label: buildDiagramNodeLabel(edge.to), category: 'config' })
  }

  for (const edge of buildPlanConfigEdges(rootPath)) {
    addEdge(edge)
    if (!nodeMap.has(edge.from)) nodeMap.set(edge.from, { id: edge.from, label: buildDiagramNodeLabel(edge.from), category: 'config' })
    if (!nodeMap.has(edge.to)) nodeMap.set(edge.to, { id: edge.to, label: buildDiagramNodeLabel(edge.to), category: 'config' })
  }

  for (const edge of inferDynamicEdges(inventory, profiles)) {
    addEdge(edge)
  }

  return { nodes: Array.from(nodeMap.values()), edges: Array.from(edgeMap.values()) }
}
