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

const SUPPORTED_TARGET_TYPES = new Set<TerraformAdoptionTarget['resourceType']>([
  'aws_instance',
  'google_compute_instance', 'google_compute_network', 'google_compute_subnetwork',
  'google_compute_firewall', 'google_storage_bucket', 'google_sql_database_instance',
  'google_container_cluster', 'google_cloud_run_service', 'google_pubsub_topic',
  'google_pubsub_subscription', 'google_dns_managed_zone', 'google_project_iam_member',
  'google_service_account',
  'azurerm_virtual_machine', 'azurerm_resource_group', 'azurerm_virtual_network',
  'azurerm_subnet', 'azurerm_network_security_group', 'azurerm_storage_account',
  'azurerm_sql_server', 'azurerm_kubernetes_cluster', 'azurerm_app_service',
  'azurerm_cosmosdb_account', 'azurerm_key_vault', 'azurerm_dns_zone',
  'azurerm_eventhub_namespace', 'azurerm_postgresql_flexible_server'
])
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

function detectProviderPrefix(resourceType: string): string {
  if (resourceType.startsWith('google_')) return 'google'
  if (resourceType.startsWith('azurerm_')) return 'azurerm'
  return 'aws'
}

function hasMatchingProvider(providerAddress: string, resourceType: string): boolean {
  const prefix = detectProviderPrefix(resourceType)
  if (prefix === 'google') return providerAddress.includes('/google')
  if (prefix === 'azurerm') return providerAddress.includes('/azurerm')
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
    if (!item.provider || !hasMatchingProvider(item.provider, resourceType)) continue
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

function buildUniqueResourceName(project: TerraformProject, baseName: string, modulePath: string, resourceType: string): string {
  const existingNames = new Set(
    project.inventory
      .filter((item) => item.mode === 'managed' && item.type === resourceType && normalizePath(item.modulePath) === normalizePath(modulePath))
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

function detectGcpRelatedResources(project: TerraformProject, target: TerraformAdoptionTarget): WeightedRelatedMatch[] {
  const related: WeightedRelatedMatch[] = []
  const gcpNetwork = target.resourceContext?.gcpNetwork?.trim() ?? ''
  const gcpSubnetwork = target.resourceContext?.gcpSubnetwork?.trim() ?? ''
  const gcpServiceAccount = target.resourceContext?.gcpServiceAccountEmail?.trim() ?? ''

  for (const item of project.inventory) {
    const values = item.values ?? {}
    const modulePath = normalizePath(item.modulePath)
    const valueSelfLink = readString(values.self_link)
    const valueName = readString(values.name)
    const valueEmail = readString(values.email)

    if (gcpNetwork && item.type === 'google_compute_network' && (valueSelfLink === gcpNetwork || valueName === gcpNetwork)) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'gcp-network', matchedValue: gcpNetwork,
        weight: item.mode === 'managed' ? 5 : 3
      })
    }

    if (gcpSubnetwork && item.type === 'google_compute_subnetwork' && (valueSelfLink === gcpSubnetwork || valueName === gcpSubnetwork)) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'gcp-subnetwork', matchedValue: gcpSubnetwork,
        weight: item.mode === 'managed' ? 6 : 4
      })
    }

    if (gcpServiceAccount && item.type === 'google_service_account' && valueEmail === gcpServiceAccount) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'gcp-service-account', matchedValue: gcpServiceAccount,
        weight: item.mode === 'managed' ? 4 : 2
      })
    }

    if (target.resourceType === 'google_container_cluster' && item.type === 'google_compute_network' && gcpNetwork && (valueSelfLink === gcpNetwork || valueName === gcpNetwork)) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'gke-cluster', matchedValue: gcpNetwork,
        weight: item.mode === 'managed' ? 7 : 5
      })
    }
  }

  const deduped = new Map<string, WeightedRelatedMatch>()
  for (const match of related) {
    const key = `${match.address}:${match.matchedOn}:${match.matchedValue}`
    const existing = deduped.get(key)
    if (!existing || existing.weight < match.weight) deduped.set(key, match)
  }
  return [...deduped.values()].sort((left, right) =>
    right.weight - left.weight || left.address.localeCompare(right.address)
  )
}

function detectAzureRelatedResources(project: TerraformProject, target: TerraformAdoptionTarget): WeightedRelatedMatch[] {
  const related: WeightedRelatedMatch[] = []
  const azureVnet = target.resourceContext?.azureVnetId?.trim() ?? ''
  const azureSubnet = target.resourceContext?.azureSubnetId?.trim() ?? ''
  const azureResourceGroup = target.resourceContext?.azureResourceGroup?.trim() ?? ''

  for (const item of project.inventory) {
    const values = item.values ?? {}
    const modulePath = normalizePath(item.modulePath)
    const valueId = readString(values.id)
    const valueName = readString(values.name)
    const valueRgName = readString(values.resource_group_name)

    if (azureResourceGroup && item.type === 'azurerm_resource_group' && valueName.toLowerCase() === azureResourceGroup.toLowerCase()) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'azure-resource-group', matchedValue: azureResourceGroup,
        weight: item.mode === 'managed' ? 3 : 2
      })
    }

    if (azureVnet && item.type === 'azurerm_virtual_network' && (valueId.toLowerCase() === azureVnet.toLowerCase() || valueName === azureVnet)) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'azure-vnet', matchedValue: azureVnet,
        weight: item.mode === 'managed' ? 5 : 3
      })
    }

    if (azureSubnet && item.type === 'azurerm_subnet' && (valueId.toLowerCase() === azureSubnet.toLowerCase() || valueName === azureSubnet)) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'azure-subnet', matchedValue: azureSubnet,
        weight: item.mode === 'managed' ? 6 : 4
      })
    }

    if (item.type === 'azurerm_network_security_group' && azureResourceGroup && valueRgName.toLowerCase() === azureResourceGroup.toLowerCase()) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'azure-nsg', matchedValue: valueRgName,
        weight: item.mode === 'managed' ? 4 : 2
      })
    }

    if (target.resourceType === 'azurerm_kubernetes_cluster' && item.type === 'azurerm_virtual_network' && azureVnet && (valueId.toLowerCase() === azureVnet.toLowerCase() || valueName === azureVnet)) {
      related.push({
        address: item.address, resourceType: item.type, modulePath, mode: item.mode,
        matchedOn: 'aks-cluster', matchedValue: azureVnet,
        weight: item.mode === 'managed' ? 7 : 5
      })
    }
  }

  const deduped = new Map<string, WeightedRelatedMatch>()
  for (const match of related) {
    const key = `${match.address}:${match.matchedOn}:${match.matchedValue}`
    const existing = deduped.get(key)
    if (!existing || existing.weight < match.weight) deduped.set(key, match)
  }
  return [...deduped.values()].sort((left, right) =>
    right.weight - left.weight || left.address.localeCompare(right.address)
  )
}

function detectRelatedResources(project: TerraformProject, target: TerraformAdoptionTarget): WeightedRelatedMatch[] {
  const prefix = detectProviderPrefix(target.resourceType)
  if (prefix === 'google') return detectGcpRelatedResources(project, target)
  if (prefix === 'azurerm') return detectAzureRelatedResources(project, target)
  return detectEc2RelatedResources(project, target)
}

function buildImportId(target: TerraformAdoptionTarget): string {
  const ctx = target.resourceContext
  const prefix = detectProviderPrefix(target.resourceType)

  if (prefix === 'google') {
    const project = ctx?.gcpProject ?? ''
    const zone = ctx?.gcpZone ?? ''
    const name = target.name || target.identifier
    switch (target.resourceType) {
      case 'google_compute_instance': return `projects/${project}/zones/${zone}/instances/${name}`
      case 'google_compute_network': return `projects/${project}/global/networks/${name}`
      case 'google_compute_subnetwork': return `projects/${project}/regions/${target.region}/subnetworks/${name}`
      case 'google_compute_firewall': return `projects/${project}/global/firewalls/${name}`
      case 'google_storage_bucket': return name
      case 'google_sql_database_instance': return `projects/${project}/instances/${name}`
      case 'google_container_cluster': return `projects/${project}/locations/${zone || target.region}/clusters/${name}`
      case 'google_cloud_run_service': return `locations/${target.region}/namespaces/${project}/services/${name}`
      case 'google_pubsub_topic': return `projects/${project}/topics/${name}`
      case 'google_pubsub_subscription': return `projects/${project}/subscriptions/${name}`
      case 'google_dns_managed_zone': return `projects/${project}/managedZones/${name}`
      case 'google_project_iam_member': return target.identifier
      case 'google_service_account': return `projects/${project}/serviceAccounts/${ctx?.gcpServiceAccountEmail || name}`
      default: return target.identifier
    }
  }

  if (prefix === 'azurerm') {
    const sub = ctx?.azureSubscriptionId ?? ''
    const rg = ctx?.azureResourceGroup ?? ''
    const name = target.name || target.identifier
    switch (target.resourceType) {
      case 'azurerm_resource_group': return `/subscriptions/${sub}/resourceGroups/${name}`
      case 'azurerm_virtual_machine': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}`
      case 'azurerm_virtual_network': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${name}`
      case 'azurerm_subnet': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${target.identifier.split('/')[0] || name}/subnets/${name}`
      case 'azurerm_network_security_group': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/networkSecurityGroups/${name}`
      case 'azurerm_storage_account': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}`
      case 'azurerm_sql_server': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Sql/servers/${name}`
      case 'azurerm_kubernetes_cluster': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/${name}`
      case 'azurerm_app_service': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}`
      case 'azurerm_cosmosdb_account': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}`
      case 'azurerm_key_vault': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.KeyVault/vaults/${name}`
      case 'azurerm_dns_zone': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Network/dnszones/${name}`
      case 'azurerm_eventhub_namespace': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.EventHub/namespaces/${name}`
      case 'azurerm_postgresql_flexible_server': return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${name}`
      default: return target.identifier
    }
  }

  return target.identifier
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
    const defaultProvider = detectProviderPrefix(resourceType)
    warnings.push(`No provider alias evidence was found for the suggested module. The mapping falls back to the default ${defaultProvider} provider.`)
    return {
      providerAddress: '',
      alias: '',
      displayName: `${defaultProvider} (default)`,
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

export async function mapTerraformAdoption(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): Promise<TerraformAdoptionMappingResult> {
  const project = await getProject(profileName, projectId, connection)
  const supported = SUPPORTED_TARGET_TYPES.has(target.resourceType)
  const reasons: string[] = []
  const warnings: string[] = []

  if (project.environment.region && target.region && project.environment.region !== target.region) {
    warnings.push(`Project region ${project.environment.region} does not match the selected resource region ${target.region}.`)
  }

  const relatedResources = supported
    ? detectRelatedResources(project, target)
    : []

  const module = chooseModulePath(project, target, relatedResources, reasons, warnings)
  const provider = chooseProviderSuggestion(project, module.modulePath, target.resourceType, relatedResources, reasons, warnings)
  const baseName = normalizeTerraformName(target.name || target.displayName || target.identifier)
  const suggestedResourceName = buildUniqueResourceName(project, baseName, module.modulePath, target.resourceType)
  const suggestedAddress = buildAddress(module.modulePath, target.resourceType, suggestedResourceName)

  if (suggestedResourceName !== baseName) {
    warnings.push(`Resource name ${baseName} already exists in ${moduleDisplayPath(module.modulePath)}, so the mapping uses ${suggestedResourceName}.`)
  }

  const providerPrefix = detectProviderPrefix(target.resourceType)
  if (providerPrefix === 'aws') {
    if (!relatedResources.some((resource) => resource.matchedOn === 'subnet-id')) {
      warnings.push('No matching aws_subnet resource was found in the selected project. Generated HCL may need a data source or variable reference for subnet_id.')
    }
    if (!relatedResources.some((resource) => resource.matchedOn === 'security-group')) {
      warnings.push('No matching aws_security_group resource was found in the selected project. Generated HCL may need data sources or variable references for vpc_security_group_ids.')
    }
  } else if (providerPrefix === 'google') {
    if (!relatedResources.some((resource) => resource.matchedOn === 'gcp-network' || resource.matchedOn === 'gcp-subnetwork')) {
      warnings.push('No matching google_compute_network or google_compute_subnetwork resource was found. Generated HCL may need a data source or variable reference for network configuration.')
    }
  } else if (providerPrefix === 'azurerm') {
    if (!relatedResources.some((resource) => resource.matchedOn === 'azure-resource-group')) {
      warnings.push('No matching azurerm_resource_group resource was found. Generated HCL may need a data source or variable reference for resource_group_name.')
    }
  }

  const confidence = determineConfidence(relatedResources, module.source, provider.source)
  const importId = buildImportId(target)

  if (target.resourceType === 'aws_instance') {
    reasons.unshift(`EC2 adoption maps to Terraform resource type aws_instance with import ID ${target.identifier}.`)
  } else if (providerPrefix === 'google') {
    reasons.unshift(`GCP adoption maps to Terraform resource type ${target.resourceType} with import ID ${importId}.`)
  } else if (providerPrefix === 'azurerm') {
    reasons.unshift(`Azure adoption maps to Terraform resource type ${target.resourceType} with import ID ${importId}.`)
  }

  return {
    supported,
    checkedAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    target,
    recommendedResourceType: target.resourceType,
    importId,
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
