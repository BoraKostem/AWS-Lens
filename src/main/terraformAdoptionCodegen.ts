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
    if (contents.includes('resource "aws_')) score += 8
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

  const suggestedFileName = mapping.recommendedResourceType === 'aws_instance' ? 'ec2_adoption.tf' : 'adoption.tf'
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

function nonAwsTags(tags: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(tags ?? {})
    .filter(([key]) => !key.startsWith('aws:'))
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

function buildResourceBlock(_project: TerraformProject, mapping: TerraformAdoptionMappingResult): string {
  const target = mapping.target
  const lines: string[] = [
    `resource "${mapping.recommendedResourceType}" "${mapping.suggestedResourceName}" {`
  ]

  if (mapping.provider.alias) {
    lines.push(`  provider = aws.${mapping.provider.alias}`)
  }

  lines.push(`  ami           = ${quote(target.resourceContext?.imageId?.trim() || 'ami-REVIEW_ME')}`)
  lines.push(`  instance_type = ${quote(target.resourceContext?.instanceType?.trim() || 't3.micro')}`)
  lines.push(`  subnet_id     = ${buildSubnetExpression(mapping, target)}`)

  const securityGroupExpressions = buildSecurityGroupExpressions(mapping, target)
  if (securityGroupExpressions.length > 0) {
    lines.push('  vpc_security_group_ids = [')
    for (const expression of securityGroupExpressions) {
      lines.push(`    ${expression},`)
    }
    lines.push('  ]')
  }

  const iamInstanceProfile = buildIamProfileExpression(mapping, target)
  if (iamInstanceProfile) {
    lines.push(`  iam_instance_profile = ${iamInstanceProfile}`)
  }

  const tagsBlock = renderTagsBlock(target.tags)
  if (tagsBlock.length > 0) {
    lines.push('', ...tagsBlock)
  }

  lines.push('}')

  const notes: string[] = []
  if (!findRelatedResourceAddress(mapping.relatedResources, 'subnet-id', 'aws_subnet')) {
    notes.push('# Review subnet_id and replace the literal value with a module-appropriate variable or data source if needed.')
  }
  if (securityGroupExpressions.some((expression) => expression.startsWith('"'))) {
    notes.push('# Review vpc_security_group_ids and replace literal security group IDs with references where appropriate.')
  }
  if (notes.length > 0) {
    return `${notes.join('\n')}\n${lines.join('\n')}\n`
  }

  return `${lines.join('\n')}\n`
}

function buildImportCommand(project: TerraformProject, mapping: TerraformAdoptionMappingResult): string {
  const workspaceSegment = project.currentWorkspace && project.currentWorkspace !== 'default'
    ? `terraform workspace select ${project.currentWorkspace} && `
    : ''
  return `${workspaceSegment}terraform import ${mapping.suggestedAddress} ${mapping.importId}`
}

export function generateTerraformAdoptionCode(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): TerraformAdoptionCodegenResult {
  const project = getProject(profileName, projectId, connection)
  const mapping = mapTerraformAdoption(profileName, projectId, connection, target)
  const moduleDirectoryResolution = resolveModuleDirectory(project, normalizePath(mapping.module.modulePath))
  const filePlan = chooseTargetFile(moduleDirectoryResolution.directory, mapping)
  const resourceBlock = buildResourceBlock(project, mapping)
  const importCommand = buildImportCommand(project, mapping)
  const notes = [
    filePlan.reason,
    `Working directory for the next import step is ${moduleDirectoryResolution.directory}.`,
    mapping.provider.alias
      ? `The generated HCL pins provider alias aws.${mapping.provider.alias} to match the selected module context.`
      : 'The generated HCL uses the default aws provider because no alias evidence was required.'
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
