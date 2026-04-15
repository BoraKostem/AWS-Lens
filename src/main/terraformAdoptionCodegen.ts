import fs from 'node:fs'
import path from 'node:path'

import type {
  AwsConnection,
  TerraformAdoptionCodegenFilePlan,
  TerraformAdoptionCodegenResult,
  TerraformAdoptionMappingResult,
  TerraformAdoptionRelatedResourceMatch,
  TerraformAdoptionTarget,
  TerraformProject,
  TerraformResourceInventoryItem
} from '@shared/types'
import { logWarn } from './observability'
import { getProject } from './terraform'
import { mapTerraformAdoption } from './terraformAdoptionMapping'

type ParsedNamedBlock = {
  kind: 'resource' | 'data' | 'module'
  firstLabel: string
  secondLabel: string
  body: string
}

function listTerraformFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return []
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tf'))
    .map((entry) => path.join(rootPath, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    logWarn('terraform.adoption.codegen.read-file', 'Failed to read Terraform file while scoring adoption target.', { filePath }, error)
    return ''
  }
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
    let cursor = start

    while (cursor < combined.length && depth > 0) {
      if (combined[cursor] === '{') depth += 1
      else if (combined[cursor] === '}') depth -= 1
      cursor += 1
    }

    blocks.push({ kind, firstLabel, secondLabel, body: combined.slice(start, cursor - 1) })
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

function normalizePath(modulePath: string): string {
  return modulePath && modulePath !== 'root' ? modulePath : 'root'
}

function moduleDisplayPath(modulePath: string): string {
  return modulePath === 'root' ? 'root module' : modulePath
}

function moduleSegmentNames(modulePath: string): string[] {
  if (!modulePath || modulePath === 'root') return []
  const parts = modulePath.split('.')
  const names: string[] = []

  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === 'module' && parts[index + 1]) {
      names.push(parts[index + 1])
      index += 1
    }
  }

  return names
}

function resolveModuleDirectory(project: TerraformProject, modulePath: string): { directory: string; resolvedFully: boolean } {
  let currentDirectory = project.rootPath
  let resolvedFully = true

  for (const moduleName of moduleSegmentNames(modulePath)) {
    const combined = listTerraformFiles(currentDirectory).map(readText).join('\n')
    const block = parseNamedBlocks(combined).find((item) => item.kind === 'module' && item.firstLabel === moduleName)
    const source = block ? extractLocalModuleSource(block.body, currentDirectory) : null

    if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      resolvedFully = false
      break
    }

    currentDirectory = source
  }

  return { directory: currentDirectory, resolvedFully }
}

function classifyFileName(fileName: string): number {
  let score = 0
  if (/(^|[-_.])(ec2|instance|instances|compute|server)([-_.]|$)/i.test(fileName)) score += 22
  if (/(^|[-_.])(gcp|google|gke|cloudsql|cloud[-_]?run|pubsub)([-_.]|$)/i.test(fileName)) score += 22
  if (/(^|[-_.])(azure|azurerm|aks|webapp|cosmosdb|keyvault)([-_.]|$)/i.test(fileName)) score += 22
  if (/^(main|resources)\.tf$/i.test(fileName)) score += 14
  if (/^(providers?|versions?|variables?|outputs?|locals?|backend)\.tf$/i.test(fileName)) score -= 18
  if (/adoption|adopted/i.test(fileName)) score += 10
  return score
}

function chooseTargetFile(moduleDirectory: string, mapping: TerraformAdoptionMappingResult): TerraformAdoptionCodegenFilePlan {
  const tfFiles = listTerraformFiles(moduleDirectory)
  const scored = tfFiles.map((filePath) => {
    const fileName = path.basename(filePath)
    const contents = readText(filePath)
    let score = classifyFileName(fileName)

    if (contents.includes(`resource "${mapping.recommendedResourceType}"`)) score += 40
    if (contents.includes('resource "aws_') || contents.includes('resource "google_') || contents.includes('resource "azurerm_')) score += 8
    if (mapping.relatedResources.some((resource) => contents.includes(resource.address.split('.').slice(-2).join('.')))) score += 10

    return { filePath, fileName, score }
  }).sort((left, right) =>
    right.score - left.score
    || left.fileName.localeCompare(right.fileName)
  )

  const selected = scored[0]
  if (selected && selected.score >= 16) {
    return {
      moduleDirectory,
      moduleDisplayPath: moduleDisplayPath(mapping.module.modulePath),
      suggestedFilePath: selected.filePath,
      suggestedFileName: selected.fileName,
      action: 'append',
      reason: `Append to ${selected.fileName} because it already groups similar Terraform resources in ${moduleDisplayPath(mapping.module.modulePath)}.`,
      existingFiles: tfFiles.map((filePath) => path.basename(filePath))
    }
  }

  const suggestedFileName = suggestedAdoptionFileName(mapping.recommendedResourceType)
  return {
    moduleDirectory,
    moduleDisplayPath: moduleDisplayPath(mapping.module.modulePath),
    suggestedFilePath: path.join(moduleDirectory, suggestedFileName),
    suggestedFileName,
    action: 'create',
    reason: `Create ${suggestedFileName} because no existing Terraform file in ${moduleDisplayPath(mapping.module.modulePath)} clearly owns ${mapping.recommendedResourceType} resources.`,
    existingFiles: tfFiles.map((filePath) => path.basename(filePath))
  }
}

function findRelatedResourceAddress(
  matches: TerraformAdoptionRelatedResourceMatch[],
  matchedOn: TerraformAdoptionRelatedResourceMatch['matchedOn'],
  resourceType: string
): string {
  return matches.find((match) => match.matchedOn === matchedOn && match.resourceType === resourceType)?.address ?? ''
}

function findRelatedSecurityGroups(
  matches: TerraformAdoptionRelatedResourceMatch[]
): TerraformAdoptionRelatedResourceMatch[] {
  return matches.filter((match) => match.matchedOn === 'security-group' && match.resourceType === 'aws_security_group')
}

function quote(value: string): string {
  return JSON.stringify(value)
}

type AdoptedVariableDef = {
  name: string
  description: string
  type: string
  default: string
}

const ADOPTED_EC2_VARIABLE_DEFS: AdoptedVariableDef[] = [
  {
    name: 'enable_adopted_ec2_instance',
    description: 'Create the standalone EC2 adoption example resource.',
    type: 'bool',
    default: 'false'
  },
  {
    name: 'adopted_ec2_ami',
    description: 'AMI ID for the standalone EC2 adoption example.',
    type: 'string',
    default: 'null'
  },
  {
    name: 'adopted_ec2_instance_type',
    description: 'Instance type for the standalone EC2 adoption example.',
    type: 'string',
    default: '"t3.micro"'
  },
  {
    name: 'adopted_ec2_subnet_id',
    description: 'Subnet ID for the standalone EC2 adoption example.',
    type: 'string',
    default: 'null'
  },
  {
    name: 'adopted_ec2_security_group_ids',
    description: 'Security group IDs for the standalone EC2 adoption example.',
    type: 'list(string)',
    default: '[]'
  },
  {
    name: 'adopted_ec2_iam_instance_profile',
    description: 'Optional IAM instance profile name for the standalone EC2 adoption example.',
    type: 'string',
    default: 'null'
  }
]

function stripHclComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)#[^\n]*/g, '$1')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function findDeclaredVariableNames(moduleDirectory: string): Set<string> {
  const combined = stripHclComments(listTerraformFiles(moduleDirectory).map(readText).join('\n'))
  const names = new Set<string>()
  const re = /\bvariable\s+"([^"]+)"\s*\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(combined)) !== null) {
    names.add(match[1])
  }
  return names
}

function renderVariableBlock(def: AdoptedVariableDef): string {
  return [
    `variable "${def.name}" {`,
    `  description = ${quote(def.description)}`,
    `  type        = ${def.type}`,
    `  default     = ${def.default}`,
    '}'
  ].join('\n')
}

function buildMissingAdoptedEc2VariableSection(moduleDirectory: string): string {
  const existing = findDeclaredVariableNames(moduleDirectory)
  const blocks = ADOPTED_EC2_VARIABLE_DEFS
    .filter((def) => !existing.has(def.name))
    .map(renderVariableBlock)
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : ''
}

function nonAwsTags(tags: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(tags ?? {})
    .filter(([key]) => !key.startsWith('aws:'))
    .sort((left, right) => left[0].localeCompare(right[0]))
}

function nonGcpLabels(tags: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(tags ?? {})
    .filter(([key]) => !key.startsWith('goog-') && !key.startsWith('google-'))
    .sort((left, right) => left[0].localeCompare(right[0]))
}

function renderTagsBlock(tags: Record<string, string> | undefined): string[] {
  const entries = nonAwsTags(tags)
  if (entries.length === 0) return []

  return [
    '  tags = {',
    ...entries.map(([key, value]) => `    ${key} = ${quote(value)}`),
    '  }'
  ]
}

function renderLabelsBlock(tags: Record<string, string> | undefined): string[] {
  const entries = nonGcpLabels(tags)
  if (entries.length === 0) return []

  return [
    '  labels = {',
    ...entries.map(([key, value]) => `    ${key} = ${quote(value)}`),
    '  }'
  ]
}

function suggestedAdoptionFileName(resourceType: string): string {
  if (resourceType === 'aws_instance') return 'ec2_adoption.tf'
  if (resourceType.startsWith('google_')) return 'gcp_adoption.tf'
  if (resourceType.startsWith('azurerm_')) return 'azure_adoption.tf'
  return 'adoption.tf'
}

function buildSubnetExpression(mapping: TerraformAdoptionMappingResult, target: TerraformAdoptionTarget): string {
  const subnetAddress = findRelatedResourceAddress(mapping.relatedResources, 'subnet-id', 'aws_subnet')
  if (subnetAddress) return `${subnetAddress}.id`
  const subnetId = target.resourceContext?.subnetId?.trim()
  return subnetId ? quote(subnetId) : 'var.subnet_id'
}

function buildSecurityGroupExpressions(mapping: TerraformAdoptionMappingResult, target: TerraformAdoptionTarget): string[] {
  const relatedGroups = findRelatedSecurityGroups(mapping.relatedResources)
  const knownIds = new Set(relatedGroups.map((group) => group.matchedValue))
  const expressions = relatedGroups.map((group) => `${group.address}.id`)

  for (const securityGroupId of target.resourceContext?.securityGroupIds ?? []) {
    if (!knownIds.has(securityGroupId)) {
      expressions.push(quote(securityGroupId))
    }
  }

  return expressions
}

function buildIamProfileExpression(mapping: TerraformAdoptionMappingResult, target: TerraformAdoptionTarget): string {
  const profileAddress = findRelatedResourceAddress(mapping.relatedResources, 'iam-instance-profile', 'aws_iam_instance_profile')
  if (profileAddress) return `${profileAddress}.name`
  const profile = target.resourceContext?.iamInstanceProfile?.trim()
  return profile ? quote(profile.split('/').pop() ?? profile) : ''
}

function buildAwsResourceBlock(mapping: TerraformAdoptionMappingResult): string {
  const target = mapping.target
  const lines: string[] = [
    `resource "${mapping.recommendedResourceType}" "${mapping.suggestedResourceName}" {`,
    `  count = var.enable_adopted_ec2_instance ? 1 : 0`,
    ''
  ]

  if (mapping.provider.alias) {
    lines.push(`  provider = aws.${mapping.provider.alias}`, '')
  }

  lines.push(`  ami                    = var.adopted_ec2_ami`)
  lines.push(`  instance_type          = var.adopted_ec2_instance_type`)
  lines.push(`  subnet_id              = var.adopted_ec2_subnet_id`)
  lines.push(`  vpc_security_group_ids = var.adopted_ec2_security_group_ids`)
  lines.push(`  iam_instance_profile   = var.adopted_ec2_iam_instance_profile`)

  const tagsBlock = renderTagsBlock(target.tags)
  if (tagsBlock.length > 0) {
    lines.push('', ...tagsBlock)
  } else {
    const displayName = target.name || mapping.suggestedResourceName
    lines.push('')
    lines.push('  tags = {')
    lines.push(`    Name = ${quote(displayName)}`)
    lines.push('  }')
  }

  lines.push('}')
  return `${lines.join('\n')}\n`
}

function buildGcpResourceBlock(mapping: TerraformAdoptionMappingResult): string {
  const target = mapping.target
  const ctx = target.resourceContext
  const lines: string[] = [
    `resource "${mapping.recommendedResourceType}" "${mapping.suggestedResourceName}" {`
  ]

  if (mapping.provider.alias) {
    lines.push(`  provider = google.${mapping.provider.alias}`)
  }

  switch (target.resourceType) {
    case 'google_compute_instance':
      lines.push(`  name         = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  machine_type = ${quote(ctx?.gcpMachineType || 'e2-medium')}`)
      lines.push(`  zone         = ${quote(ctx?.gcpZone || target.region)}`)
      lines.push('')
      lines.push('  boot_disk {')
      lines.push('    initialize_params {')
      lines.push(`      image = ${quote(ctx?.imageId || 'REVIEW_ME')}`)
      lines.push('    }')
      lines.push('  }')
      lines.push('')
      lines.push('  network_interface {')
      lines.push(`    network    = ${quote(ctx?.gcpNetwork || 'default')}`)
      if (ctx?.gcpSubnetwork) lines.push(`    subnetwork = ${quote(ctx.gcpSubnetwork)}`)
      lines.push('  }')
      if (ctx?.gcpServiceAccountEmail) {
        lines.push('')
        lines.push('  service_account {')
        lines.push(`    email  = ${quote(ctx.gcpServiceAccountEmail)}`)
        lines.push('    scopes = ["cloud-platform"]')
        lines.push('  }')
      }
      break

    case 'google_compute_network':
      lines.push(`  name                    = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push('  auto_create_subnetworks = false')
      break

    case 'google_compute_subnetwork':
      lines.push(`  name          = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  ip_cidr_range = "REVIEW_ME"`)
      lines.push(`  region        = ${quote(target.region)}`)
      lines.push(`  network       = ${quote(ctx?.gcpNetwork || 'REVIEW_ME')}`)
      break

    case 'google_compute_firewall':
      lines.push(`  name    = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  network = ${quote(ctx?.gcpNetwork || 'REVIEW_ME')}`)
      lines.push('')
      lines.push('  allow {')
      lines.push('    protocol = "tcp"')
      lines.push('    ports    = ["REVIEW_ME"]')
      lines.push('  }')
      break

    case 'google_storage_bucket':
      lines.push(`  name     = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location = ${quote(target.region)}`)
      break

    case 'google_sql_database_instance':
      lines.push(`  name             = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  database_version = "REVIEW_ME"`)
      lines.push(`  region           = ${quote(target.region)}`)
      lines.push('')
      lines.push('  settings {')
      lines.push('    tier = "REVIEW_ME"')
      lines.push('  }')
      break

    case 'google_container_cluster':
      lines.push(`  name     = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location = ${quote(ctx?.gcpZone || target.region)}`)
      lines.push('')
      lines.push('  # Remove default node pool after creation')
      lines.push('  remove_default_node_pool = true')
      lines.push('  initial_node_count       = 1')
      break

    case 'google_cloud_run_service':
      lines.push(`  name     = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location = ${quote(target.region)}`)
      lines.push('')
      lines.push('  template {')
      lines.push('    spec {')
      lines.push('      containers {')
      lines.push(`        image = "REVIEW_ME"`)
      lines.push('      }')
      lines.push('    }')
      lines.push('  }')
      break

    case 'google_pubsub_topic':
      lines.push(`  name = ${quote(target.name || 'REVIEW_ME')}`)
      break

    case 'google_pubsub_subscription':
      lines.push(`  name  = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  topic = "REVIEW_ME"`)
      break

    case 'google_dns_managed_zone':
      lines.push(`  name     = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  dns_name = "REVIEW_ME."`)
      break

    case 'google_project_iam_member':
      lines.push(`  project = ${quote(ctx?.gcpProject || 'REVIEW_ME')}`)
      lines.push(`  role    = "REVIEW_ME"`)
      lines.push(`  member  = "REVIEW_ME"`)
      break

    case 'google_service_account':
      lines.push(`  account_id   = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  display_name = ${quote(target.displayName || target.name || '')}`)
      break

    default:
      lines.push(`  name = ${quote(target.name || 'REVIEW_ME')}`)
      break
  }

  if (ctx?.gcpProject) {
    lines.push(`  project = ${quote(ctx.gcpProject)}`)
  }

  const labelsBlock = renderLabelsBlock(target.tags)
  if (labelsBlock.length > 0) {
    lines.push('', ...labelsBlock)
  }

  lines.push('}')
  return `${lines.join('\n')}\n`
}

function buildAzureResourceBlock(mapping: TerraformAdoptionMappingResult): string {
  const target = mapping.target
  const ctx = target.resourceContext
  const lines: string[] = [
    `resource "${mapping.recommendedResourceType}" "${mapping.suggestedResourceName}" {`
  ]

  if (mapping.provider.alias) {
    lines.push(`  provider = azurerm.${mapping.provider.alias}`)
  }

  switch (target.resourceType) {
    case 'azurerm_resource_group':
      lines.push(`  name     = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location = ${quote(ctx?.azureLocation || target.region)}`)
      break

    case 'azurerm_virtual_machine':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push(`  vm_size             = ${quote(ctx?.azureVmSize || 'Standard_B2s')}`)
      lines.push('')
      lines.push(`  network_interface_ids = ["REVIEW_ME"]`)
      lines.push('')
      lines.push('  os_disk {')
      lines.push('    caching              = "ReadWrite"')
      lines.push('    storage_account_type = "Standard_LRS"')
      lines.push('  }')
      break

    case 'azurerm_virtual_network':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push(`  address_space       = ["REVIEW_ME"]`)
      break

    case 'azurerm_subnet':
      lines.push(`  name                 = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  resource_group_name  = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push(`  virtual_network_name = "REVIEW_ME"`)
      lines.push(`  address_prefixes     = ["REVIEW_ME"]`)
      break

    case 'azurerm_network_security_group':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      break

    case 'azurerm_storage_account':
      lines.push(`  name                     = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location                 = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name      = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push('  account_tier             = "Standard"')
      lines.push('  account_replication_type = "LRS"')
      break

    case 'azurerm_sql_server':
      lines.push(`  name                         = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location                     = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name          = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push(`  version                      = "12.0"`)
      lines.push(`  administrator_login          = "REVIEW_ME"`)
      lines.push(`  administrator_login_password = "REVIEW_ME"`)
      break

    case 'azurerm_kubernetes_cluster':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push(`  dns_prefix          = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push('')
      lines.push('  default_node_pool {')
      lines.push(`    name       = "default"`)
      lines.push('    node_count = 1')
      lines.push(`    vm_size    = ${quote(ctx?.azureVmSize || 'Standard_DS2_v2')}`)
      lines.push('  }')
      lines.push('')
      lines.push('  identity {')
      lines.push('    type = "SystemAssigned"')
      lines.push('  }')
      break

    case 'azurerm_app_service':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push(`  service_plan_id     = "REVIEW_ME"`)
      break

    case 'azurerm_cosmosdb_account':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push('  offer_type          = "Standard"')
      lines.push('  kind                = "GlobalDocumentDB"')
      lines.push('')
      lines.push('  consistency_policy {')
      lines.push('    consistency_level = "Session"')
      lines.push('  }')
      lines.push('')
      lines.push('  geo_location {')
      lines.push(`    location          = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push('    failover_priority = 0')
      lines.push('  }')
      break

    case 'azurerm_key_vault':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push(`  tenant_id           = "REVIEW_ME"`)
      lines.push('  sku_name            = "standard"')
      break

    case 'azurerm_dns_zone':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      break

    case 'azurerm_eventhub_namespace':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push('  sku                 = "Standard"')
      break

    case 'azurerm_postgresql_flexible_server':
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      lines.push('  sku_name            = "REVIEW_ME"')
      lines.push('  version             = "REVIEW_ME"')
      break

    default:
      lines.push(`  name                = ${quote(target.name || 'REVIEW_ME')}`)
      lines.push(`  location            = ${quote(ctx?.azureLocation || target.region)}`)
      lines.push(`  resource_group_name = ${quote(ctx?.azureResourceGroup || 'REVIEW_ME')}`)
      break
  }

  const tagsBlock = renderTagsBlock(target.tags)
  if (tagsBlock.length > 0) {
    lines.push('', ...tagsBlock)
  }

  lines.push('}')
  return `${lines.join('\n')}\n`
}

function buildResourceBlock(_project: TerraformProject, mapping: TerraformAdoptionMappingResult): string {
  if (mapping.recommendedResourceType.startsWith('google_')) return buildGcpResourceBlock(mapping)
  if (mapping.recommendedResourceType.startsWith('azurerm_')) return buildAzureResourceBlock(mapping)
  return buildAwsResourceBlock(mapping)
}

function buildImportCommand(project: TerraformProject, mapping: TerraformAdoptionMappingResult): string {
  const workspaceSegment = project.currentWorkspace && project.currentWorkspace !== 'default'
    ? `terraform workspace select ${project.currentWorkspace} && `
    : ''
  // EC2 adoption is always emitted with count = var.enable_adopted_ec2_instance ? 1 : 0,
  // so the real resource address is <address>[0]. Quote the address so the shell does
  // not interpret the brackets as globs.
  const address = mapping.recommendedResourceType === 'aws_instance'
    ? `'${mapping.suggestedAddress}[0]'`
    : mapping.suggestedAddress
  return `${workspaceSegment}terraform import ${address} ${mapping.importId}`
}

export async function generateTerraformAdoptionCode(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): Promise<TerraformAdoptionCodegenResult> {
  const project = await getProject(profileName, projectId, connection)
  const mapping = await mapTerraformAdoption(profileName, projectId, connection, target)
  const moduleDirectoryResolution = resolveModuleDirectory(project, normalizePath(mapping.module.modulePath))
  const filePlan = chooseTargetFile(moduleDirectoryResolution.directory, mapping)

  let resourceBlock = buildResourceBlock(project, mapping)

  // For AWS EC2 adoption, prepend any missing variable declarations so the
  // generated file validates standalone. Idempotent — skips variables that
  // are already declared in any .tf file in the module directory.
  if (mapping.recommendedResourceType === 'aws_instance') {
    const variablesSection = buildMissingAdoptedEc2VariableSection(moduleDirectoryResolution.directory)
    resourceBlock = `${variablesSection}${resourceBlock}`
  }

  const importCommand = buildImportCommand(project, mapping)
  const providerPrefix = mapping.recommendedResourceType.startsWith('google_') ? 'google'
    : mapping.recommendedResourceType.startsWith('azurerm_') ? 'azurerm' : 'aws'
  const notes = [
    filePlan.reason,
    `Working directory for the next import step is ${moduleDirectoryResolution.directory}.`,
    mapping.provider.alias
      ? `The generated HCL pins provider alias ${providerPrefix}.${mapping.provider.alias} to match the selected module context.`
      : `The generated HCL uses the default ${providerPrefix} provider because no alias evidence was required.`
  ]

  const warnings = [...mapping.warnings]
  if (!moduleDirectoryResolution.resolvedFully && mapping.module.modulePath !== 'root') {
    warnings.push(`Module path ${mapping.module.modulePath} could not be fully resolved to a local directory. The preview falls back to ${moduleDirectoryResolution.directory}.`)
  }

  return {
    supported: mapping.supported,
    checkedAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    target,
    mapping,
    filePlan,
    resourceBlock,
    importCommand,
    workingDirectory: moduleDirectoryResolution.directory,
    notes,
    warnings
  }
}
