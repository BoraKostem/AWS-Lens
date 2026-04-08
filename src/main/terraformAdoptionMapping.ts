import type {
  AwsConnection,
  TerraformAdoptionMappingConfidence,
  TerraformAdoptionMappingResult,
  TerraformAdoptionMappingSource,
  TerraformAdoptionProviderSuggestion,
  TerraformAdoptionRelatedResourceMatch,
  TerraformAdoptionTarget,
  TerraformProject,
  TerraformResourceInventoryItem
} from '@shared/types'
import { getProject } from './terraform'

const SUPPORTED_TARGET_TYPES = new Set<TerraformAdoptionTarget['resourceType']>(['aws_instance'])
const EKS_CLUSTER_TAG_KEYS = ['eks:cluster-name', 'aws:eks:cluster-name', 'alpha.eksctl.io/cluster-name']
const EKS_NODEGROUP_TAG_KEYS = ['eks:nodegroup-name', 'alpha.eksctl.io/nodegroup-name']

type WeightedRelatedMatch = TerraformAdoptionRelatedResourceMatch & {
  weight: number
}

type ProviderCandidate = {
  providerAddress: string
  source: TerraformAdoptionMappingSource
  score: number
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

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePath(pathValue: string): string {
  return pathValue && pathValue !== 'root' ? pathValue : 'root'
}

function moduleDisplayPath(modulePath: string): string {
  return modulePath === 'root' ? 'root module' : modulePath
}

function extractInstanceProfileName(value: string): string {
  if (!value) return ''
  const slashSegment = value.split('/').pop() ?? value
  const colonSegment = slashSegment.split(':').pop() ?? slashSegment
  return colonSegment.trim()
}

function normalizeTerraformName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!normalized) return 'instance'
  return /^[a-z_]/.test(normalized) ? normalized : `instance_${normalized}`
}

function parseProviderSuggestion(providerAddress: string, source: TerraformAdoptionMappingSource): TerraformAdoptionProviderSuggestion {
  const trimmed = providerAddress.trim()
  const aliasMatch = trimmed.match(/\]\.([^.]+)$/)
  const alias = aliasMatch?.[1] ?? ''
  const registryMatch = trimmed.match(/provider\["([^"]+)"\]/)
  const providerName = registryMatch?.[1]?.split('/').pop() ?? 'aws'
  return {
    providerAddress: trimmed,
    alias,
    displayName: alias ? `${providerName}.${alias}` : `${providerName} (default)`,
    source
  }
}

function hasAwsProvider(providerAddress: string): boolean {
  return providerAddress.includes('/aws')
}

function providerScore(
  inventory: TerraformResourceInventoryItem[],
  relatedResources: TerraformAdoptionRelatedResourceMatch[],
  modulePath: string,
  resourceType: string
): ProviderCandidate[] {
  const scores = new Map<string, ProviderCandidate>()
  const relatedAddressSet = new Set(relatedResources.map((resource) => resource.address))

  for (const item of inventory) {
    if (!item.provider || !hasAwsProvider(item.provider)) continue
    if (normalizePath(item.modulePath) !== normalizePath(modulePath)) continue

    let score = 1
    let source: TerraformAdoptionMappingSource = 'default'

    if (relatedAddressSet.has(item.address)) {
      score += 5
      source = 'related-resource'
    } else if (item.type === resourceType) {
      score += 3
      source = 'existing-resource-type'
    }

    const existing = scores.get(item.provider)
    if (!existing || existing.score < score) {
      scores.set(item.provider, { providerAddress: item.provider, source, score })
    } else {
      existing.score += score
      if (existing.source === 'default' && source !== 'default') {
        existing.source = source
      }
    }
  }

  return [...scores.values()].sort((left, right) =>
    right.score - left.score
    || left.providerAddress.localeCompare(right.providerAddress)
  )
}

function buildUniqueResourceName(project: TerraformProject, baseName: string, modulePath: string): string {
  const existingNames = new Set(
    project.inventory
      .filter((item) => item.mode === 'managed' && item.type === 'aws_instance' && normalizePath(item.modulePath) === normalizePath(modulePath))
      .map((item) => item.name)
  )

  if (!existingNames.has(baseName)) return baseName

  for (let index = 2; index < 100; index += 1) {
    const candidate = `${baseName}_${index}`
    if (!existingNames.has(candidate)) {
      return candidate
    }
  }

  return `${baseName}_adopted`
}

function buildAddress(modulePath: string, resourceType: string, resourceName: string): string {
  return modulePath === 'root'
    ? `${resourceType}.${resourceName}`
    : `${modulePath}.${resourceType}.${resourceName}`
}

function detectEc2RelatedResources(project: TerraformProject, target: TerraformAdoptionTarget): WeightedRelatedMatch[] {
  const related: WeightedRelatedMatch[] = []
  const subnetId = target.resourceContext?.subnetId?.trim() ?? ''
  const vpcId = target.resourceContext?.vpcId?.trim() ?? ''
  const securityGroupIds = new Set((target.resourceContext?.securityGroupIds ?? []).map((groupId) => groupId.trim()).filter(Boolean))
  const iamInstanceProfile = target.resourceContext?.iamInstanceProfile?.trim() ?? ''
  const iamInstanceProfileName = extractInstanceProfileName(iamInstanceProfile)
  const clusterName = inferEksClusterName(target.tags)
  const nodegroupName = inferEksNodegroupName(target.tags)

  for (const item of project.inventory) {
    const values = item.values ?? {}
    const modulePath = normalizePath(item.modulePath)
    const valueId = readString(values.id)
    const valueArn = readString(values.arn)
    const valueName = readString(values.name)

    if (subnetId && item.type === 'aws_subnet' && valueId === subnetId) {
      related.push({
        address: item.address,
        resourceType: item.type,
        modulePath,
        mode: item.mode,
        matchedOn: 'subnet-id',
        matchedValue: subnetId,
        weight: item.mode === 'managed' ? 6 : 4
      })
    }

    if (vpcId && item.type === 'aws_vpc' && valueId === vpcId) {
      related.push({
        address: item.address,
        resourceType: item.type,
        modulePath,
        mode: item.mode,
        matchedOn: 'vpc-id',
        matchedValue: vpcId,
        weight: item.mode === 'managed' ? 3 : 2
      })
    }

    if (securityGroupIds.size > 0 && item.type === 'aws_security_group' && securityGroupIds.has(valueId)) {
      related.push({
        address: item.address,
        resourceType: item.type,
        modulePath,
        mode: item.mode,
        matchedOn: 'security-group',
        matchedValue: valueId,
        weight: item.mode === 'managed' ? 5 : 3
      })
    }

    if (iamInstanceProfile && item.type === 'aws_iam_instance_profile') {
      const profileMatched = valueArn === iamInstanceProfile
        || valueName === iamInstanceProfileName
        || valueId === iamInstanceProfileName

      if (profileMatched) {
        related.push({
          address: item.address,
          resourceType: item.type,
          modulePath,
          mode: item.mode,
          matchedOn: 'iam-instance-profile',
          matchedValue: iamInstanceProfileName || iamInstanceProfile,
          weight: item.mode === 'managed' ? 4 : 2
        })
      }
    }

    if (clusterName && nodegroupName && item.type === 'aws_eks_node_group') {
      const inventoryClusterName = readString(values.cluster_name)
      const inventoryNodegroupName = readString(values.node_group_name) || readString(values.nodegroup_name)
      if (inventoryClusterName === clusterName && inventoryNodegroupName === nodegroupName) {
        related.push({
          address: item.address,
          resourceType: item.type,
          modulePath,
          mode: item.mode,
          matchedOn: 'eks-nodegroup',
          matchedValue: `${clusterName}:${nodegroupName}`,
          weight: item.mode === 'managed' ? 7 : 5
        })
      }
    }
  }

  const deduped = new Map<string, WeightedRelatedMatch>()
  for (const match of related) {
    const key = `${match.address}:${match.matchedOn}:${match.matchedValue}`
    const existing = deduped.get(key)
    if (!existing || existing.weight < match.weight) {
      deduped.set(key, match)
    }
  }

  return [...deduped.values()].sort((left, right) =>
    right.weight - left.weight
    || (left.mode === right.mode ? 0 : left.mode === 'managed' ? -1 : 1)
    || left.address.localeCompare(right.address)
  )
}

function chooseModulePath(
  project: TerraformProject,
  target: TerraformAdoptionTarget,
  relatedResources: WeightedRelatedMatch[],
  reasons: string[],
  warnings: string[]
): { modulePath: string; source: TerraformAdoptionMappingSource } {
  if (relatedResources.length > 0) {
    const moduleScores = new Map<string, { score: number; relatedCount: number; managedCount: number }>()
    for (const resource of relatedResources) {
      const entry = moduleScores.get(resource.modulePath) ?? { score: 0, relatedCount: 0, managedCount: 0 }
      entry.score += resource.weight
      entry.relatedCount += 1
      entry.managedCount += resource.mode === 'managed' ? 1 : 0
      moduleScores.set(resource.modulePath, entry)
    }

    const preferred = [...moduleScores.entries()].sort((left, right) =>
      right[1].score - left[1].score
      || right[1].managedCount - left[1].managedCount
      || right[1].relatedCount - left[1].relatedCount
      || left[0].localeCompare(right[0])
    )[0]

    if (preferred) {
      reasons.push(
        `Module placement anchored by ${preferred[1].relatedCount} related Terraform resource${preferred[1].relatedCount === 1 ? '' : 's'} in ${moduleDisplayPath(preferred[0])}.`
      )
      return { modulePath: preferred[0], source: 'related-resource' }
    }
  }

  const existingResourceTypeCounts = new Map<string, number>()
  for (const item of project.inventory) {
    if (item.mode !== 'managed') continue
    if (item.type !== target.resourceType) continue
    const modulePath = normalizePath(item.modulePath)
    existingResourceTypeCounts.set(modulePath, (existingResourceTypeCounts.get(modulePath) ?? 0) + 1)
  }

  if (existingResourceTypeCounts.size > 0) {
    const preferred = [...existingResourceTypeCounts.entries()].sort((left, right) =>
      right[1] - left[1]
      || left[0].localeCompare(right[0])
    )[0]
    reasons.push(
      `Module placement follows existing ${target.resourceType} resources already managed in ${moduleDisplayPath(preferred[0])}.`
    )
    return { modulePath: preferred[0], source: 'existing-resource-type' }
  }

  warnings.push('No related Terraform resources were found in the selected project, so placement falls back to the root module.')
  return { modulePath: 'root', source: 'default' }
}

function chooseProviderSuggestion(
  project: TerraformProject,
  modulePath: string,
  resourceType: string,
  relatedResources: TerraformAdoptionRelatedResourceMatch[],
  reasons: string[],
  warnings: string[]
): TerraformAdoptionProviderSuggestion {
  const candidates = providerScore(project.inventory, relatedResources, modulePath, resourceType)
  const candidate = candidates[0]

  if (!candidate) {
    warnings.push('No provider alias evidence was found for the suggested module. The mapping falls back to the default aws provider.')
    return {
      providerAddress: '',
      alias: '',
      displayName: 'aws (default)',
      source: 'default'
    }
  }

  const suggestion = parseProviderSuggestion(candidate.providerAddress, candidate.source)
  if (candidate.source === 'related-resource') {
    reasons.push(`Provider alias inferred from related resources already placed in ${moduleDisplayPath(modulePath)}.`)
  } else if (candidate.source === 'existing-resource-type') {
    reasons.push(`Provider alias inferred from existing ${resourceType} resources in ${moduleDisplayPath(modulePath)}.`)
  } else {
    warnings.push('Provider alias suggestion is based on the general module context, not a directly related resource.')
  }

  return suggestion
}

function determineConfidence(
  relatedResources: WeightedRelatedMatch[],
  moduleSource: TerraformAdoptionMappingSource,
  providerSource: TerraformAdoptionMappingSource
): TerraformAdoptionMappingConfidence {
  const weightedScore = relatedResources.reduce((total, resource) => total + resource.weight, 0)

  if (weightedScore >= 9 || (moduleSource === 'related-resource' && providerSource === 'related-resource')) {
    return 'high'
  }
  if (weightedScore >= 4 || moduleSource !== 'default' || providerSource !== 'default') {
    return 'medium'
  }
  return 'low'
}

export function mapTerraformAdoption(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): TerraformAdoptionMappingResult {
  const project = getProject(profileName, projectId, connection)
  const supported = SUPPORTED_TARGET_TYPES.has(target.resourceType)
  const reasons: string[] = []
  const warnings: string[] = []

  if (project.environment.region && target.region && project.environment.region !== target.region) {
    warnings.push(`Project region ${project.environment.region} does not match the selected resource region ${target.region}.`)
  }

  const relatedResources = supported
    ? detectEc2RelatedResources(project, target)
    : []

  const module = chooseModulePath(project, target, relatedResources, reasons, warnings)
  const provider = chooseProviderSuggestion(project, module.modulePath, target.resourceType, relatedResources, reasons, warnings)
  const baseName = normalizeTerraformName(target.name || target.displayName || target.identifier)
  const suggestedResourceName = buildUniqueResourceName(project, baseName, module.modulePath)
  const suggestedAddress = buildAddress(module.modulePath, target.resourceType, suggestedResourceName)

  if (suggestedResourceName !== baseName) {
    warnings.push(`Resource name ${baseName} already exists in ${moduleDisplayPath(module.modulePath)}, so the mapping uses ${suggestedResourceName}.`)
  }

  if (!relatedResources.some((resource) => resource.matchedOn === 'subnet-id')) {
    warnings.push('No matching aws_subnet resource was found in the selected project. Generated HCL may need a data source or variable reference for subnet_id.')
  }

  if (!relatedResources.some((resource) => resource.matchedOn === 'security-group')) {
    warnings.push('No matching aws_security_group resource was found in the selected project. Generated HCL may need data sources or variable references for vpc_security_group_ids.')
  }

  const confidence = determineConfidence(relatedResources, module.source, provider.source)

  if (target.resourceType === 'aws_instance') {
    reasons.unshift(`EC2 adoption maps to Terraform resource type aws_instance with import ID ${target.identifier}.`)
  }

  return {
    supported,
    checkedAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    target,
    recommendedResourceType: target.resourceType,
    importId: target.identifier,
    suggestedResourceName,
    suggestedAddress,
    module: {
      modulePath: module.modulePath,
      displayPath: moduleDisplayPath(module.modulePath),
      source: module.source
    },
    provider,
    confidence,
    reasons,
    warnings,
    relatedResources: relatedResources.map(({ weight: _weight, ...resource }) => resource)
  }
}
