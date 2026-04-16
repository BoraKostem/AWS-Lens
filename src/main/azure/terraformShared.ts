import { randomUUID } from 'node:crypto'

import type {
  AwsConnection,
  AzureAksNodePoolSummary,
  TerraformDriftCoverageItem,
  TerraformDriftDifference,
  TerraformDriftHistory,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformDriftSnapshot,
  TerraformDriftStatus,
  TerraformProject,
  TerraformResourceInventoryItem
} from '@shared/types'
import {
  listAzureAksNodePools,
  listAzureAppInsightsComponents,
  listAzureAppServicePlans,
  listAzureEventHubNamespaces,
  listAzureEventHubs,
  listAzureKeyVaults,
  listAzureNetworkOverview,
  listAzurePostgreSqlEstate,
  listAzureSqlEstate,
  listAzureStorageAccounts,
  listAzureVirtualMachines,
  listAzureVmss,
  listAzureWebApps,
  listAzureCosmosDbEstate,
  listAzureDnsZones
} from './index'
import { logWarn } from '../observability'

export type AzureTerraformContext = {
  contextId: string
  location: string
}

export type AzureLiveData = {
  virtualMachines?: Awaited<ReturnType<typeof listAzureVirtualMachines>>
  vmss?: Awaited<ReturnType<typeof listAzureVmss>>
  storageAccounts?: Awaited<ReturnType<typeof listAzureStorageAccounts>>
  sqlEstate?: Awaited<ReturnType<typeof listAzureSqlEstate>>
  postgreSqlEstate?: Awaited<ReturnType<typeof listAzurePostgreSqlEstate>>
  keyVaults?: Awaited<ReturnType<typeof listAzureKeyVaults>>
  eventHubNamespaces?: Awaited<ReturnType<typeof listAzureEventHubNamespaces>>
  eventHubsByNamespace?: Record<string, Awaited<ReturnType<typeof listAzureEventHubs>>>
  appServicePlans?: Awaited<ReturnType<typeof listAzureAppServicePlans>>
  webApps?: Awaited<ReturnType<typeof listAzureWebApps>>
  networkOverview?: Awaited<ReturnType<typeof listAzureNetworkOverview>>
  appInsights?: Awaited<ReturnType<typeof listAzureAppInsightsComponents>>
  aksNodePoolsByCluster?: Map<string, AzureAksNodePoolSummary[]>
  cosmosDbEstate?: Awaited<ReturnType<typeof listAzureCosmosDbEstate>>
  dnsZones?: Awaited<ReturnType<typeof listAzureDnsZones>>
}
export type AzureLiveErrors = Partial<Record<keyof AzureLiveData, string>>

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseAzureContext(profileName: string, project: TerraformProject, connection?: AwsConnection): AzureTerraformContext {
  const match = profileName.match(/^provider:azure:terraform:([^:]+):(.+)$/)
  return {
    contextId: connection?.profile || str(project.environment.connectionLabel) || (match?.[1] && match[1] !== 'unscoped' ? match[1] : 'azure'),
    location: connection?.region || str(project.environment.region) || (match?.[2] && match[2] !== 'global' ? match[2] : 'global')
  }
}

export function portalUrl(): string {
  return 'https://portal.azure.com/#home'
}

export function resourceLocation(item: TerraformResourceInventoryItem, fallback: string): string {
  return str(item.values.location) || str(item.values.primary_location) || str(item.values.region) || fallback
}

export function resourceId(item: TerraformResourceInventoryItem): string {
  return str(item.values.id)
}

export function terminalCommand(item: TerraformResourceInventoryItem): string {
  const id = resourceId(item)
  return id
    ? `az resource show --ids "${id}" --output jsonc`
    : `terraform state show ${item.address}`
}

export function createDifference(key: string, label: string, terraformValue: string, liveValue: string, assessment: TerraformDriftDifference['assessment'] = 'verified'): TerraformDriftDifference {
  return {
    key,
    label,
    kind: 'attribute',
    assessment,
    terraformValue,
    liveValue
  }
}

export function coverageForType(resourceType: string): TerraformDriftCoverageItem {
  switch (resourceType) {
    case 'azurerm_kubernetes_cluster':
      return { resourceType, coverage: 'verified', verifiedChecks: ['default node pool autoscaling', 'min count', 'max count', 'node count', 'vm size'], inferredChecks: [], notes: ['Compares default_node_pool autoscaling settings against the live Azure AKS cluster.'] }
    case 'azurerm_kubernetes_cluster_node_pool':
      return { resourceType, coverage: 'verified', verifiedChecks: ['autoscaling', 'min count', 'max count', 'node count', 'vm size'], inferredChecks: [], notes: ['Compares node pool autoscaling settings against the live Azure AKS node pool.'] }
    case 'azurerm_virtual_machine':
    case 'azurerm_linux_virtual_machine':
    case 'azurerm_windows_virtual_machine':
      return { resourceType, coverage: 'verified', verifiedChecks: ['VM size'], inferredChecks: [], notes: ['Compares VM size against the live Azure virtual machine.'] }
    case 'azurerm_virtual_machine_scale_set':
    case 'azurerm_linux_virtual_machine_scale_set':
    case 'azurerm_windows_virtual_machine_scale_set':
      return { resourceType, coverage: 'verified', verifiedChecks: ['SKU name', 'SKU capacity'], inferredChecks: [], notes: ['Compares SKU name and capacity against the live Azure VMSS.'] }
    case 'azurerm_storage_account':
      return { resourceType, coverage: 'verified', verifiedChecks: ['kind', 'SKU name', 'access tier', 'HTTPS only', 'minimum TLS version'], inferredChecks: [], notes: ['Compares storage account configuration against live Azure inventory.'] }
    case 'azurerm_mssql_server':
      return { resourceType, coverage: 'verified', verifiedChecks: ['version', 'public network access', 'minimal TLS version'], inferredChecks: [], notes: ['Compares SQL Server settings against live Azure SQL estate.'] }
    case 'azurerm_mssql_database':
      return { resourceType, coverage: 'verified', verifiedChecks: ['SKU name', 'max size GB', 'zone redundant'], inferredChecks: [], notes: ['Compares SQL database settings against live Azure SQL estate.'] }
    case 'azurerm_postgresql_flexible_server':
      return { resourceType, coverage: 'verified', verifiedChecks: ['version', 'SKU name', 'storage size GB', 'HA enabled', 'backup retention days'], inferredChecks: [], notes: ['Compares PostgreSQL Flexible Server settings against live Azure inventory.'] }
    case 'azurerm_key_vault':
      return { resourceType, coverage: 'verified', verifiedChecks: ['SKU name', 'soft delete', 'purge protection', 'RBAC authorization'], inferredChecks: [], notes: ['Compares Key Vault configuration against live Azure inventory.'] }
    case 'azurerm_eventhub_namespace':
      return { resourceType, coverage: 'verified', verifiedChecks: ['SKU name', 'SKU capacity', 'Kafka enabled', 'zone redundant'], inferredChecks: [], notes: ['Compares Event Hub namespace settings against live Azure inventory.'] }
    case 'azurerm_eventhub':
      return { resourceType, coverage: 'verified', verifiedChecks: ['partition count', 'message retention in days'], inferredChecks: [], notes: ['Compares Event Hub settings against live Azure inventory.'] }
    case 'azurerm_service_plan':
    case 'azurerm_app_service_plan':
      return { resourceType, coverage: 'verified', verifiedChecks: ['SKU name', 'number of workers'], inferredChecks: [], notes: ['Compares App Service Plan settings against live Azure inventory.'] }
    case 'azurerm_linux_web_app':
    case 'azurerm_windows_web_app':
    case 'azurerm_app_service':
      return { resourceType, coverage: 'verified', verifiedChecks: ['HTTPS only', 'minimum TLS version'], inferredChecks: [], notes: ['Compares Web App settings against live Azure inventory.'] }
    case 'azurerm_virtual_network':
      return { resourceType, coverage: 'verified', verifiedChecks: ['existence'], inferredChecks: [], notes: ['Verifies virtual network existence in live Azure inventory. Address space comparison is excluded due to complexity.'] }
    case 'azurerm_network_security_group':
      return { resourceType, coverage: 'verified', verifiedChecks: ['existence'], inferredChecks: [], notes: ['Verifies network security group existence in live Azure inventory.'] }
    case 'azurerm_application_insights':
      return { resourceType, coverage: 'verified', verifiedChecks: ['retention in days'], inferredChecks: [], notes: ['Compares Application Insights retention against live Azure inventory.'] }
    default:
      return { resourceType, coverage: 'partial', verifiedChecks: [], inferredChecks: ['Terraform state presence', 'Azure resource ID', 'Resource group', 'Location'], notes: ['Azure drift is inferred from Terraform metadata until live Azure SDK collectors are added.'] }
  }
}

export function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

export function bool(value: unknown): boolean {
  return value === true
}

export function firstObject(values: unknown): Record<string, unknown> {
  if (Array.isArray(values)) {
    const first = values.find((value) => value && typeof value === 'object')
    return first && typeof first === 'object' ? first as Record<string, unknown> : {}
  }
  return values && typeof values === 'object' ? values as Record<string, unknown> : {}
}

export function formatValue(value: string | number | boolean | undefined): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return value ?? ''
}

export function extractSubscriptionId(azureResourceId: string): string {
  const match = azureResourceId.match(/\/subscriptions\/([^/]+)/i)
  return match?.[1] ?? ''
}

export function extractTerraformResourceGroup(azureResourceId: string): string {
  const match = azureResourceId.match(/\/resourceGroups\/([^/]+)/i)
  return match?.[1] ?? ''
}

export function extractClusterName(azureResourceId: string): string {
  const match = azureResourceId.match(/\/managedClusters\/([^/]+)/i)
  return match?.[1] ?? ''
}

export function extractSubscriptionIdFromInventory(inventory: TerraformResourceInventoryItem[]): string {
  for (const item of inventory) {
    const id = resourceId(item)
    if (id) {
      const subId = extractSubscriptionId(id)
      if (subId) return subId
    }
  }
  return ''
}

export async function loadAzureLiveData(subscriptionId: string, location: string): Promise<{ data: AzureLiveData; errors: AzureLiveErrors }> {
  const data: AzureLiveData = {}
  const errors: AzureLiveErrors = {}
  if (!subscriptionId) {
    return { data, errors }
  }

  const loaders: Array<[keyof AzureLiveData, () => Promise<unknown>]> = [
    ['virtualMachines', () => listAzureVirtualMachines(subscriptionId, location)],
    ['vmss', () => listAzureVmss(subscriptionId, location)],
    ['storageAccounts', () => listAzureStorageAccounts(subscriptionId, location)],
    ['sqlEstate', () => listAzureSqlEstate(subscriptionId, location)],
    ['postgreSqlEstate', () => listAzurePostgreSqlEstate(subscriptionId, location)],
    ['keyVaults', () => listAzureKeyVaults(subscriptionId, location)],
    ['eventHubNamespaces', () => listAzureEventHubNamespaces(subscriptionId, location)],
    ['appServicePlans', () => listAzureAppServicePlans(subscriptionId, location)],
    ['webApps', () => listAzureWebApps(subscriptionId, location)],
    ['networkOverview', () => listAzureNetworkOverview(subscriptionId, location)],
    ['appInsights', () => listAzureAppInsightsComponents(subscriptionId, location)],
    ['cosmosDbEstate', () => listAzureCosmosDbEstate(subscriptionId, location)],
    ['dnsZones', () => listAzureDnsZones(subscriptionId, location)]
  ]

  const settled = await Promise.allSettled(loaders.map(async ([key, loader]) => ({ key, value: await loader() })))
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      data[result.value.key] = result.value.value as never
      return
    }
    const key = loaders[index]?.[0]
    if (key) {
      errors[key] = result.reason instanceof Error ? result.reason.message : String(result.reason)
    }
  })

  return { data, errors }
}

export function compareValues(differences: TerraformDriftDifference[], key: string, label: string, terraformValue: string, liveValue: string) {
  if (!terraformValue || !liveValue || terraformValue === liveValue) return
  differences.push(createDifference(key, label, terraformValue, liveValue))
}

export function buildVerifiedAzureItem(
  item: TerraformResourceInventoryItem,
  fallbackLocation: string,
  matchState: {
    exists: boolean
    cloudIdentifier: string
    explanation: string
    evidence?: string[]
    differences?: TerraformDriftDifference[]
  }
): TerraformDriftItem {
  const logicalName = str(item.values.name) || item.name || item.address
  const differences = matchState.differences ?? []
  const location = resourceLocation(item, fallbackLocation)
  const status: TerraformDriftStatus = !matchState.exists
    ? 'missing_in_aws'
    : differences.length > 0 ? 'drifted' : 'in_sync'
  return {
    terraformAddress: item.address,
    resourceType: item.type,
    logicalName,
    cloudIdentifier: matchState.cloudIdentifier || logicalName,
    region: location,
    status,
    assessment: 'verified',
    explanation: matchState.explanation,
    suggestedNextStep: status === 'in_sync'
      ? 'No action required.'
      : status === 'missing_in_aws'
        ? `Verify whether ${item.address} was removed or renamed in Azure, and reconcile the Terraform state.`
        : `Review ${item.address}, reconcile the changed fields in Terraform or Azure Portal, then run a manual drift re-scan.`,
    consoleUrl: portalUrl(),
    terminalCommand: terminalCommand(item),
    differences,
    evidence: matchState.evidence ?? [],
    relatedTerraformAddresses: [item.address]
  }
}

export type AksClusterKey = { subscriptionId: string; resourceGroup: string; clusterName: string }

export function aksClusterKeyId(key: AksClusterKey): string {
  return `${key.subscriptionId}/${key.resourceGroup}/${key.clusterName}`.toLowerCase()
}

export async function fetchLiveNodePools(clusters: AksClusterKey[]): Promise<Map<string, AzureAksNodePoolSummary[]>> {
  const result = new Map<string, AzureAksNodePoolSummary[]>()
  const seen = new Set<string>()
  for (const cluster of clusters) {
    const key = aksClusterKeyId(cluster)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const pools = await listAzureAksNodePools(cluster.subscriptionId, cluster.resourceGroup, cluster.clusterName)
      result.set(key, pools)
    } catch (error) {
      logWarn('azureTerraformInsights.fetchLiveNodePools', `Failed to fetch live node pools for AKS cluster ${cluster.clusterName}.`, { cluster: cluster.clusterName, resourceGroup: cluster.resourceGroup }, error)
    }
  }
  return result
}

export function buildAksClusterDriftItem(
  item: TerraformResourceInventoryItem,
  livePools: AzureAksNodePoolSummary[],
  fallbackLocation: string
): TerraformDriftItem {
  const id = resourceId(item)
  const location = resourceLocation(item, fallbackLocation)
  const defaultNodePool = firstObject(item.values.default_node_pool)
  const tfAutoScaling = bool(defaultNodePool.enable_auto_scaling)
  const tfMinCount = num(defaultNodePool.min_count) ?? 0
  const tfMaxCount = num(defaultNodePool.max_count) ?? 0
  const tfNodeCount = num(defaultNodePool.node_count) ?? 0
  const tfVmSize = str(defaultNodePool.vm_size)
  const tfPoolName = str(defaultNodePool.name) || 'default'

  const livePool = livePools.find((pool) => pool.name.toLowerCase() === tfPoolName.toLowerCase())
  if (!livePool) {
    return {
      terraformAddress: item.address,
      resourceType: item.type,
      logicalName: str(item.values.name) || item.name || item.address,
      cloudIdentifier: id || str(item.values.name) || item.address,
      region: location,
      status: 'missing_in_aws',
      assessment: 'verified',
      explanation: `Default node pool "${tfPoolName}" exists in Terraform state but was not found in the live AKS cluster.`,
      suggestedNextStep: 'Verify whether the node pool was removed or renamed in Azure, and reconcile the Terraform state.',
      consoleUrl: portalUrl(),
      terminalCommand: terminalCommand(item),
      differences: [],
      evidence: [`Terraform address: ${item.address}`, `Default node pool "${tfPoolName}" not found in live Azure inventory.`],
      relatedTerraformAddresses: [item.address]
    }
  }

  const differences: TerraformDriftDifference[] = []
  const liveAutoScaling = livePool.enableAutoScaling
  if (tfAutoScaling !== liveAutoScaling) {
    differences.push(createDifference('enable_auto_scaling', 'auto scaling', formatValue(tfAutoScaling), formatValue(liveAutoScaling)))
  }
  if (liveAutoScaling) {
    const liveMin = typeof livePool.min === 'number' ? livePool.min : 0
    const liveMax = typeof livePool.max === 'number' ? livePool.max : 0
    if (tfAutoScaling && tfMinCount !== liveMin) {
      differences.push(createDifference('min_count', 'min count', formatValue(tfMinCount), formatValue(liveMin)))
    }
    if (tfAutoScaling && tfMaxCount !== liveMax) {
      differences.push(createDifference('max_count', 'max count', formatValue(tfMaxCount), formatValue(liveMax)))
    }
  }
  const liveDesired = typeof livePool.desired === 'number' ? livePool.desired : 0
  if (tfNodeCount !== liveDesired) {
    differences.push(createDifference('node_count', 'node count', formatValue(tfNodeCount), formatValue(liveDesired)))
  }
  if (tfVmSize && livePool.vmSize !== '-' && tfVmSize.toLowerCase() !== livePool.vmSize.toLowerCase()) {
    differences.push(createDifference('vm_size', 'VM size', tfVmSize, livePool.vmSize))
  }

  const status: TerraformDriftStatus = differences.length > 0 ? 'drifted' : 'in_sync'
  return {
    terraformAddress: item.address,
    resourceType: item.type,
    logicalName: str(item.values.name) || item.name || item.address,
    cloudIdentifier: id || str(item.values.name) || item.address,
    region: location,
    status,
    assessment: 'verified',
    explanation: differences.length > 0
      ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} between Terraform and the live AKS default node pool.`
      : 'Terraform state and live Azure AKS default node pool match on tracked autoscaling attributes.',
    suggestedNextStep: differences.length > 0
      ? 'Review the AKS autoscaling changes in Azure Portal and decide whether to update Terraform or revert the Azure change.'
      : 'No action required.',
    consoleUrl: portalUrl(),
    terminalCommand: terminalCommand(item),
    differences,
    evidence: [
      `Matched live AKS default node pool "${tfPoolName}" by name.`,
      ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)
    ],
    relatedTerraformAddresses: [item.address]
  }
}

export function buildAksNodePoolDriftItem(
  item: TerraformResourceInventoryItem,
  livePools: AzureAksNodePoolSummary[],
  fallbackLocation: string
): TerraformDriftItem {
  const id = resourceId(item)
  const location = resourceLocation(item, fallbackLocation)
  const tfPoolName = str(item.values.name)
  const tfAutoScaling = bool(item.values.enable_auto_scaling)
  const tfMinCount = num(item.values.min_count) ?? 0
  const tfMaxCount = num(item.values.max_count) ?? 0
  const tfNodeCount = num(item.values.node_count) ?? 0
  const tfVmSize = str(item.values.vm_size)

  const livePool = livePools.find((pool) => pool.name.toLowerCase() === tfPoolName.toLowerCase())
  if (!livePool) {
    return {
      terraformAddress: item.address,
      resourceType: item.type,
      logicalName: tfPoolName || item.name || item.address,
      cloudIdentifier: id || tfPoolName || item.address,
      region: location,
      status: 'missing_in_aws',
      assessment: 'verified',
      explanation: `Node pool "${tfPoolName}" exists in Terraform state but was not found in the live AKS cluster.`,
      suggestedNextStep: 'Verify whether the node pool was removed or renamed in Azure, and reconcile the Terraform state.',
      consoleUrl: portalUrl(),
      terminalCommand: terminalCommand(item),
      differences: [],
      evidence: [`Terraform address: ${item.address}`, `Node pool "${tfPoolName}" not found in live Azure inventory.`],
      relatedTerraformAddresses: [item.address]
    }
  }

  const differences: TerraformDriftDifference[] = []
  const liveAutoScaling = livePool.enableAutoScaling
  if (tfAutoScaling !== liveAutoScaling) {
    differences.push(createDifference('enable_auto_scaling', 'auto scaling', formatValue(tfAutoScaling), formatValue(liveAutoScaling)))
  }
  if (liveAutoScaling) {
    const liveMin = typeof livePool.min === 'number' ? livePool.min : 0
    const liveMax = typeof livePool.max === 'number' ? livePool.max : 0
    if (tfAutoScaling && tfMinCount !== liveMin) {
      differences.push(createDifference('min_count', 'min count', formatValue(tfMinCount), formatValue(liveMin)))
    }
    if (tfAutoScaling && tfMaxCount !== liveMax) {
      differences.push(createDifference('max_count', 'max count', formatValue(tfMaxCount), formatValue(liveMax)))
    }
  }
  const liveDesired = typeof livePool.desired === 'number' ? livePool.desired : 0
  if (tfNodeCount !== liveDesired) {
    differences.push(createDifference('node_count', 'node count', formatValue(tfNodeCount), formatValue(liveDesired)))
  }
  if (tfVmSize && livePool.vmSize !== '-' && tfVmSize.toLowerCase() !== livePool.vmSize.toLowerCase()) {
    differences.push(createDifference('vm_size', 'VM size', tfVmSize, livePool.vmSize))
  }

  const status: TerraformDriftStatus = differences.length > 0 ? 'drifted' : 'in_sync'
  return {
    terraformAddress: item.address,
    resourceType: item.type,
    logicalName: tfPoolName || item.name || item.address,
    cloudIdentifier: id || tfPoolName || item.address,
    region: location,
    status,
    assessment: 'verified',
    explanation: differences.length > 0
      ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} between Terraform and the live AKS node pool.`
      : 'Terraform state and live Azure AKS node pool match on tracked autoscaling attributes.',
    suggestedNextStep: differences.length > 0
      ? 'Review the AKS autoscaling changes in Azure Portal and decide whether to update Terraform or revert the Azure change.'
      : 'No action required.',
    consoleUrl: portalUrl(),
    terminalCommand: terminalCommand(item),
    differences,
    evidence: [
      `Matched live AKS node pool "${tfPoolName}" by name.`,
      ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)
    ],
    relatedTerraformAddresses: [item.address]
  }
}

export function buildDriftItem(item: TerraformResourceInventoryItem, fallbackLocation: string): TerraformDriftItem {
  const id = resourceId(item)
  const location = resourceLocation(item, fallbackLocation)
  const resourceGroup = str(item.values.resource_group_name)
  const evidence = [id ? `Resource ID present: ${id}` : 'Resource ID missing from Terraform state.', resourceGroup ? `Resource group: ${resourceGroup}` : 'Resource group not present in Terraform state.']
  const differences: TerraformDriftDifference[] = []
  let status: TerraformDriftStatus = 'in_sync'
  let explanation = 'Terraform state contains an Azure resource identifier, group, and location. This item is treated as in sync with inferred confidence.'
  let suggestedNextStep = 'Use the terminal handoff to inspect the live Azure resource if you need stronger verification.'

  if (!id) {
    status = 'drifted'
    explanation = 'Terraform state does not expose an Azure resource ID for this resource, so live lookup confidence is reduced.'
    suggestedNextStep = 'Run the suggested terminal command to verify the live resource or refresh state after apply.'
    differences.push(createDifference('resource_id', 'Azure resource ID', 'missing', 'expected from state', 'inferred'))
  } else if (!location) {
    status = 'drifted'
    explanation = 'Terraform state does not expose a location for this resource, which weakens Azure handoff quality and drift confidence.'
    suggestedNextStep = 'Confirm the resource location in Azure and refresh Terraform state.'
    differences.push(createDifference('location', 'Location', 'missing', 'expected from state', 'inferred'))
  }

  return {
    terraformAddress: item.address,
    resourceType: item.type,
    logicalName: str(item.values.name) || item.name || item.address,
    cloudIdentifier: id || str(item.values.name) || item.address,
    region: location || fallbackLocation,
    status,
    assessment: 'inferred',
    explanation,
    suggestedNextStep,
    consoleUrl: portalUrl(),
    terminalCommand: terminalCommand(item),
    differences,
    evidence,
    relatedTerraformAddresses: [item.address]
  }
}

export function summarizeItems(items: TerraformDriftItem[], scannedAt: string): TerraformDriftReport['summary'] {
  const statusCounts: Record<TerraformDriftStatus, number> = {
    in_sync: 0,
    drifted: 0,
    missing_in_aws: 0,
    unmanaged_in_aws: 0,
    missing_in_cloud: 0,
    unmanaged_in_cloud: 0,
    unsupported: 0
  }
  const resourceTypeCounts = new Map<string, number>()
  const supportedResourceTypes = new Map<string, TerraformDriftCoverageItem>()
  const unsupportedTypes = new Set<string>()
  let verifiedCount = 0
  let inferredCount = 0

  for (const item of items) {
    statusCounts[item.status] += 1
    resourceTypeCounts.set(item.resourceType, (resourceTypeCounts.get(item.resourceType) ?? 0) + 1)
    supportedResourceTypes.set(item.resourceType, coverageForType(item.resourceType))
    if (item.assessment === 'unsupported') unsupportedTypes.add(item.resourceType)
    else if (item.assessment === 'verified') verifiedCount += 1
    else inferredCount += 1
  }

  return {
    total: items.length,
    statusCounts,
    resourceTypeCounts: [...resourceTypeCounts.entries()].map(([resourceType, count]) => ({ resourceType, count })).sort((left, right) => right.count - left.count || left.resourceType.localeCompare(right.resourceType)),
    scannedAt,
    verifiedCount,
    inferredCount,
    unsupportedResourceTypes: [...unsupportedTypes].sort(),
    supportedResourceTypes: [...supportedResourceTypes.values()].sort((left, right) => left.resourceType.localeCompare(right.resourceType))
  }
}

export function singleSnapshot(summary: TerraformDriftReport['summary'], items: TerraformDriftItem[], scannedAt: string): TerraformDriftHistory {
  const snapshot: TerraformDriftSnapshot = {
    id: randomUUID(),
    scannedAt,
    trigger: 'manual',
    summary,
    items
  }
  return {
    snapshots: [snapshot],
    trend: 'insufficient_history',
    latestScanAt: scannedAt,
    previousScanAt: ''
  }
}
