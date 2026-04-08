import fs from 'node:fs'
import path from 'node:path'

import type {
  AwsConnection,
  TerraformAdoptionConfigMatch,
  TerraformAdoptionDetectionResult,
  TerraformAdoptionProjectSignal,
  TerraformAdoptionStateMatch,
  TerraformAdoptionTarget,
  TerraformProjectListItem,
  TerraformResourceInventoryItem
} from '@shared/types'
import { listProjectSummaries } from './terraform'

type SearchHint = {
  matchedOn: TerraformAdoptionConfigMatch['matchedOn']
  value: string
}

const SUPPORTED_STATE_TYPES: Record<TerraformAdoptionTarget['resourceType'], string[]> = {
  aws_instance: ['aws_instance'],
  aws_db_instance: ['aws_db_instance'],
  aws_rds_cluster: ['aws_rds_cluster'],
  aws_s3_bucket: ['aws_s3_bucket'],
  aws_iam_user: ['aws_iam_user'],
  aws_iam_group: ['aws_iam_group'],
  aws_iam_role: ['aws_iam_role'],
  aws_iam_policy: ['aws_iam_policy'],
  aws_security_group: ['aws_security_group'],
  aws_eks_cluster: ['aws_eks_cluster'],
  aws_ecs_service: ['aws_ecs_service'],
  aws_lambda_function: ['aws_lambda_function'],
  aws_route53_zone: ['aws_route53_zone'],
  aws_secretsmanager_secret: ['aws_secretsmanager_secret'],
  aws_kms_key: ['aws_kms_key'],
  aws_sqs_queue: ['aws_sqs_queue'],
  aws_sns_topic: ['aws_sns_topic']
}

const CONFIG_FILE_EXTENSIONS = new Set(['.tf', '.tfvars', '.hcl', '.json'])
const IGNORED_DIRECTORIES = new Set(['.git', '.terraform', 'node_modules', 'dist', 'build', 'out'])
const MAX_CONFIG_MATCHES_PER_PROJECT = 5
const EKS_CLUSTER_TAG_KEYS = ['eks:cluster-name', 'aws:eks:cluster-name', 'alpha.eksctl.io/cluster-name']
const EKS_NODEGROUP_TAG_KEYS = ['eks:nodegroup-name', 'alpha.eksctl.io/nodegroup-name']

function uniqueHints(target: TerraformAdoptionTarget): SearchHint[] {
  const hints: SearchHint[] = []
  const seen = new Set<string>()

  const push = (matchedOn: SearchHint['matchedOn'], value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    if (matchedOn === 'name' && trimmed.length < 3) return
    const key = `${matchedOn}:${trimmed}`
    if (seen.has(key)) return
    seen.add(key)
    hints.push({ matchedOn, value: trimmed })
  }

  push('identifier', target.identifier)
  push('arn', target.arn)
  push('name', target.name)
  return hints
}

function normalizedTags(values: Record<string, unknown>): Record<string, string> {
  const raw = values.tags
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
  )
}

function valueFromTagKeys(tags: Record<string, string> | undefined, keys: string[]): string {
  for (const key of keys) {
    const value = tags?.[key]?.trim()
    if (value) return value
  }
  return ''
}

function inferEksClusterName(tags: Record<string, string> | undefined): string {
  const direct = valueFromTagKeys(tags, EKS_CLUSTER_TAG_KEYS)
  if (direct) return direct

  for (const key of Object.keys(tags ?? {})) {
    if (key.startsWith('kubernetes.io/cluster/')) {
      return key.slice('kubernetes.io/cluster/'.length).trim()
    }
  }

  return ''
}

function inferEksNodegroupName(tags: Record<string, string> | undefined): string {
  return valueFromTagKeys(tags, EKS_NODEGROUP_TAG_KEYS)
}

function stringCandidate(values: Record<string, unknown>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : ''
}

function resourceIdentifierCandidates(values: Record<string, unknown>, tags: Record<string, string>): string[] {
  return [
    stringCandidate(values, 'id'),
    stringCandidate(values, 'arn'),
    stringCandidate(values, 'name'),
    stringCandidate(values, 'bucket'),
    stringCandidate(values, 'identifier'),
    stringCandidate(values, 'db_instance_identifier'),
    stringCandidate(values, 'cluster_identifier'),
    stringCandidate(values, 'group_name'),
    stringCandidate(values, 'user_name'),
    stringCandidate(values, 'role_name'),
    stringCandidate(values, 'policy_name'),
    stringCandidate(values, 'function_name'),
    stringCandidate(values, 'queue_name'),
    stringCandidate(values, 'key_id'),
    stringCandidate(values, 'zone_id'),
    stringCandidate(values, 'service_name'),
    stringCandidate(values, 'cluster_name'),
    stringCandidate(values, 'instance_id'),
    tags.Name?.trim() ?? ''
  ].filter(Boolean)
}

function resourceNameCandidates(values: Record<string, unknown>, tags: Record<string, string>): string[] {
  return [
    stringCandidate(values, 'name'),
    stringCandidate(values, 'bucket'),
    stringCandidate(values, 'identifier'),
    stringCandidate(values, 'db_instance_identifier'),
    stringCandidate(values, 'cluster_identifier'),
    stringCandidate(values, 'group_name'),
    stringCandidate(values, 'user_name'),
    stringCandidate(values, 'role_name'),
    stringCandidate(values, 'policy_name'),
    stringCandidate(values, 'function_name'),
    stringCandidate(values, 'queue_name'),
    stringCandidate(values, 'service_name'),
    stringCandidate(values, 'cluster_name'),
    tags.Name?.trim() ?? ''
  ].filter(Boolean)
}

function detectEksNodegroupStateMatches(
  inventory: TerraformResourceInventoryItem[],
  target: TerraformAdoptionTarget
): TerraformAdoptionStateMatch[] {
  const clusterName = inferEksClusterName(target.tags)
  const nodegroupName = inferEksNodegroupName(target.tags)
  if (!clusterName || !nodegroupName) return []

  return inventory.flatMap((item) => {
    if (item.mode !== 'managed') return []
    if (item.type !== 'aws_eks_node_group') return []

    const values = item.values ?? {}
    const inventoryClusterName = typeof values.cluster_name === 'string' ? values.cluster_name.trim() : ''
    const inventoryNodegroupName =
      typeof values.node_group_name === 'string' ? values.node_group_name.trim() : (
        typeof values.nodegroup_name === 'string' ? values.nodegroup_name.trim() : ''
      )

    if (inventoryClusterName !== clusterName || inventoryNodegroupName !== nodegroupName) {
      return []
    }

    return [{
      address: item.address,
      resourceType: item.type,
      matchedOn: 'eks-nodegroup',
      matchedValue: `${clusterName}:${nodegroupName}`
    }]
  })
}

function detectStateMatches(
  inventory: TerraformResourceInventoryItem[],
  target: TerraformAdoptionTarget
): TerraformAdoptionStateMatch[] {
  const resourceTypes = SUPPORTED_STATE_TYPES[target.resourceType]
  if (!resourceTypes) return []

  const directMatches = inventory.flatMap((item) => {
    if (item.mode !== 'managed') return []
    if (!resourceTypes.includes(item.type)) return []

    const values = item.values ?? {}
    const tags = normalizedTags(values)
    const matches: TerraformAdoptionStateMatch[] = []

    const identifierCandidates = resourceIdentifierCandidates(values, tags)
    if (identifierCandidates.includes(target.identifier)) {
      matches.push({
        address: item.address,
        resourceType: item.type,
        matchedOn: 'identifier',
        matchedValue: target.identifier
      })
    }

    if (typeof values.arn === 'string' && target.arn && values.arn === target.arn) {
      matches.push({
        address: item.address,
        resourceType: item.type,
        matchedOn: 'arn',
        matchedValue: target.arn
      })
    }

    if (target.name) {
      const stateNames = resourceNameCandidates(values, tags)
      if (stateNames.includes(target.name)) {
        matches.push({
          address: item.address,
          resourceType: item.type,
          matchedOn: 'name',
          matchedValue: target.name
        })
      }
    }

    return dedupeStateMatches(matches)
  })

  return dedupeStateMatches([
    ...directMatches,
    ...detectEksNodegroupStateMatches(inventory, target)
  ])
}

function dedupeStateMatches(matches: TerraformAdoptionStateMatch[]): TerraformAdoptionStateMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    const key = `${match.address}:${match.matchedOn}:${match.matchedValue}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function shouldScanFile(filePath: string): boolean {
  const base = path.basename(filePath)
  if (base.endsWith('.tfstate') || base.endsWith('.tfplan')) return false
  if (base.endsWith('.auto.tfvars.json')) return false
  const ext = path.extname(filePath)
  if (ext === '.json') return base.endsWith('.tf.json') || base.endsWith('.tfvars.json')
  return CONFIG_FILE_EXTENSIONS.has(ext)
}

function walkProjectFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return []

  const queue = [rootPath]
  const files: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          queue.push(fullPath)
        }
        continue
      }

      if (entry.isFile() && shouldScanFile(fullPath)) {
        files.push(fullPath)
      }
    }
  }

  return files
}

function trimExcerpt(line: string, hint: string): string {
  const index = line.indexOf(hint)
  if (index < 0) return line.trim().slice(0, 180)

  const start = Math.max(0, index - 36)
  const end = Math.min(line.length, index + hint.length + 72)
  return line.slice(start, end).trim()
}

function detectConfigMatches(project: TerraformProjectListItem, target: TerraformAdoptionTarget): TerraformAdoptionConfigMatch[] {
  const hints = uniqueHints(target)
  if (hints.length === 0) return []

  const matches: TerraformAdoptionConfigMatch[] = []

  for (const filePath of walkProjectFiles(project.rootPath)) {
    const contents = fs.readFileSync(filePath, 'utf8')
    const lines = contents.split(/\r?\n/)

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]

      for (const hint of hints) {
        if (!line.includes(hint.value)) continue
        matches.push({
          relativePath: path.relative(project.rootPath, filePath) || path.basename(filePath),
          lineNumber: index + 1,
          matchedOn: hint.matchedOn,
          matchedValue: hint.value,
          excerpt: trimExcerpt(line, hint.value)
        })
        if (matches.length >= MAX_CONFIG_MATCHES_PER_PROJECT) {
          return matches
        }
      }
    }
  }

  return matches
}

function buildProjectSignal(
  project: TerraformProjectListItem,
  target: TerraformAdoptionTarget
): TerraformAdoptionProjectSignal | null {
  const stateMatches = detectStateMatches(project.inventory ?? [], target)
  const configMatches = detectConfigMatches(project, target)

  if (stateMatches.length === 0 && configMatches.length === 0) {
    return null
  }

  return {
    projectId: project.id,
    projectName: project.name,
    rootPath: project.rootPath,
    currentWorkspace: project.currentWorkspace,
    region: project.environment?.region || '',
    backendType: project.metadata?.backendType || '',
    status: stateMatches.length > 0 ? 'managed' : 'config-hint',
    stateMatches,
    configMatches
  }
}

export function detectTerraformAdoption(
  profileName: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): TerraformAdoptionDetectionResult {
  const projects = listProjectSummaries(profileName, connection)
  const signals = projects
    .map((project) => buildProjectSignal(project, target))
    .filter((project): project is TerraformAdoptionProjectSignal => Boolean(project))
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'managed' ? -1 : 1
      return left.projectName.localeCompare(right.projectName)
    })

  const managedProjectCount = signals.filter((project) => project.status === 'managed').length
  const configHintProjectCount = signals.filter((project) => project.status === 'config-hint').length

  return {
    target,
    supported: Object.prototype.hasOwnProperty.call(SUPPORTED_STATE_TYPES, target.resourceType),
    checkedAt: new Date().toISOString(),
    scannedProjectCount: projects.length,
    matchingProjectCount: signals.length,
    managedProjectCount,
    configHintProjectCount,
    projects: signals
  }
}
