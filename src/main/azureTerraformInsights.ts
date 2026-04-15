import { randomUUID } from 'node:crypto'

import type {
  AwsConnection,
  AzureAksNodePoolSummary,
  CorrelatedSignalReference,
  ObservabilityFinding,
  ObservabilityPostureArea,
  ObservabilityPostureReport,
  ObservabilityRecommendation,
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
} from './azureSdk'
import { getProject } from './terraform'
import { logWarn } from './observability'
import { createTraceContext, withAudit } from './terraformAudit'

type AzureTerraformContext = {
  contextId: string
  location: string
}

type AzureLiveData = {
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
type AzureLiveErrors = Partial<Record<keyof AzureLiveData, string>>

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseAzureContext(profileName: string, project: TerraformProject, connection?: AwsConnection): AzureTerraformContext {
  const match = profileName.match(/^provider:azure:terraform:([^:]+):(.+)$/)
  return {
    contextId: connection?.profile || str(project.environment.connectionLabel) || (match?.[1] && match[1] !== 'unscoped' ? match[1] : 'azure'),
    location: connection?.region || str(project.environment.region) || (match?.[2] && match[2] !== 'global' ? match[2] : 'global')
  }
}

function portalUrl(): string {
  return 'https://portal.azure.com/#home'
}

function resourceLocation(item: TerraformResourceInventoryItem, fallback: string): string {
  return str(item.values.location) || str(item.values.primary_location) || str(item.values.region) || fallback
}

function resourceId(item: TerraformResourceInventoryItem): string {
  return str(item.values.id)
}

function terminalCommand(item: TerraformResourceInventoryItem): string {
  const id = resourceId(item)
  return id
    ? `az resource show --ids "${id}" --output jsonc`
    : `terraform state show ${item.address}`
}

function createDifference(key: string, label: string, terraformValue: string, liveValue: string, assessment: TerraformDriftDifference['assessment'] = 'verified'): TerraformDriftDifference {
  return {
    key,
    label,
    kind: 'attribute',
    assessment,
    terraformValue,
    liveValue
  }
}

function coverageForType(resourceType: string): TerraformDriftCoverageItem {
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

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function bool(value: unknown): boolean {
  return value === true
}

function firstObject(values: unknown): Record<string, unknown> {
  if (Array.isArray(values)) {
    const first = values.find((value) => value && typeof value === 'object')
    return first && typeof first === 'object' ? first as Record<string, unknown> : {}
  }
  return values && typeof values === 'object' ? values as Record<string, unknown> : {}
}

function formatValue(value: string | number | boolean | undefined): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return value ?? ''
}

function extractSubscriptionId(azureResourceId: string): string {
  const match = azureResourceId.match(/\/subscriptions\/([^/]+)/i)
  return match?.[1] ?? ''
}

function extractResourceGroup(azureResourceId: string): string {
  const match = azureResourceId.match(/\/resourceGroups\/([^/]+)/i)
  return match?.[1] ?? ''
}

function extractClusterName(azureResourceId: string): string {
  const match = azureResourceId.match(/\/managedClusters\/([^/]+)/i)
  return match?.[1] ?? ''
}

function extractSubscriptionIdFromInventory(inventory: TerraformResourceInventoryItem[]): string {
  for (const item of inventory) {
    const id = resourceId(item)
    if (id) {
      const subId = extractSubscriptionId(id)
      if (subId) return subId
    }
  }
  return ''
}

async function loadAzureLiveData(subscriptionId: string, location: string): Promise<{ data: AzureLiveData; errors: AzureLiveErrors }> {
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

function compareValues(differences: TerraformDriftDifference[], key: string, label: string, terraformValue: string, liveValue: string) {
  if (!terraformValue || !liveValue || terraformValue === liveValue) return
  differences.push(createDifference(key, label, terraformValue, liveValue))
}

function buildVerifiedAzureItem(
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

type AksClusterKey = { subscriptionId: string; resourceGroup: string; clusterName: string }

function aksClusterKeyId(key: AksClusterKey): string {
  return `${key.subscriptionId}/${key.resourceGroup}/${key.clusterName}`.toLowerCase()
}

async function fetchLiveNodePools(clusters: AksClusterKey[]): Promise<Map<string, AzureAksNodePoolSummary[]>> {
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

function buildAksClusterDriftItem(
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

function buildAksNodePoolDriftItem(
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

function buildDriftItem(item: TerraformResourceInventoryItem, fallbackLocation: string): TerraformDriftItem {
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

function summarizeItems(items: TerraformDriftItem[], scannedAt: string): TerraformDriftReport['summary'] {
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

function singleSnapshot(summary: TerraformDriftReport['summary'], items: TerraformDriftItem[], scannedAt: string): TerraformDriftHistory {
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

export async function getAzureTerraformDriftReport(
  profileName: string,
  projectId: string,
  connection?: AwsConnection,
  _options?: { forceRefresh?: boolean }
): Promise<TerraformDriftReport> {
  const project = await getProject(profileName, projectId, connection)
  const auditCtx = createTraceContext({
    operation: 'drift-report',
    provider: 'azure',
    module: project.name
  })
  return withAudit(auditCtx, async () => {
  const context = parseAzureContext(profileName, project, connection)
  const scannedAt = new Date().toISOString()
  const azureResources = project.inventory.filter((item) => item.mode === 'managed' && item.type.startsWith('azurerm_'))

  // Extract subscription ID from any Azure resource ID in the inventory
  const subscriptionId = extractSubscriptionIdFromInventory(azureResources)

  // Load all live data in parallel if we have a subscription.
  // Pass empty location so we fetch resources across all regions — Terraform
  // state can reference resources in any location, and filtering by the
  // sidebar location would hide resources deployed to a different region.
  const { data: live } = subscriptionId
    ? await loadAzureLiveData(subscriptionId, '')
    : { data: {} as AzureLiveData }

  // Second-wave fetch: Event Hubs need per-namespace calls
  const eventHubResources = azureResources.filter((item) => item.type === 'azurerm_eventhub')
  if (subscriptionId && eventHubResources.length > 0) {
    const nsNames = new Set<string>()
    const nsResourceGroups = new Map<string, string>()
    for (const item of eventHubResources) {
      const nsName = str(item.values.namespace_name)
      const rg = str(item.values.resource_group_name)
      if (nsName && rg) {
        nsNames.add(nsName)
        nsResourceGroups.set(nsName, rg)
      }
    }
    if (nsNames.size > 0) {
      const ehByNs: Record<string, Awaited<ReturnType<typeof listAzureEventHubs>>> = {}
      const ehSettled = await Promise.allSettled(
        [...nsNames].map(async (nsName) => {
          const rg = nsResourceGroups.get(nsName) ?? ''
          return { nsName, hubs: await listAzureEventHubs(subscriptionId, rg, nsName) }
        })
      )
      for (const result of ehSettled) {
        if (result.status === 'fulfilled') {
          ehByNs[result.value.nsName] = result.value.hubs
        }
      }
      live.eventHubsByNamespace = ehByNs
    }
  }

  // Collect AKS cluster keys for node pool fetches
  const aksClusterResources = azureResources.filter((item) => item.type === 'azurerm_kubernetes_cluster')
  const aksNodePoolResources = azureResources.filter((item) => item.type === 'azurerm_kubernetes_cluster_node_pool')
  const clusterKeys: AksClusterKey[] = []
  for (const item of aksClusterResources) {
    const id = resourceId(item)
    const sub = extractSubscriptionId(id)
    const rg = str(item.values.resource_group_name) || extractResourceGroup(id)
    const name = str(item.values.name) || extractClusterName(id)
    if (sub && rg && name) {
      clusterKeys.push({ subscriptionId: sub, resourceGroup: rg, clusterName: name })
    }
  }
  for (const item of aksNodePoolResources) {
    const clusterId = str(item.values.kubernetes_cluster_id)
    const id = resourceId(item)
    const resolvedClusterId = clusterId || id
    const sub = extractSubscriptionId(resolvedClusterId)
    const rg = extractResourceGroup(resolvedClusterId)
    const name = extractClusterName(resolvedClusterId)
    if (sub && rg && name) {
      clusterKeys.push({ subscriptionId: sub, resourceGroup: rg, clusterName: name })
    }
  }
  live.aksNodePoolsByCluster = clusterKeys.length > 0 ? await fetchLiveNodePools(clusterKeys) : new Map<string, AzureAksNodePoolSummary[]>()

  // Build drift items for every resource
  const items: TerraformDriftItem[] = azureResources.map((item) => {
    switch (item.type) {
      // ── AKS Cluster ──
      case 'azurerm_kubernetes_cluster': {
        const id = resourceId(item)
        const sub = extractSubscriptionId(id)
        const rg = str(item.values.resource_group_name) || extractResourceGroup(id)
        const name = str(item.values.name) || extractClusterName(id)
        const key = aksClusterKeyId({ subscriptionId: sub, resourceGroup: rg, clusterName: name })
        const livePools = live.aksNodePoolsByCluster?.get(key)
        if (livePools) return buildAksClusterDriftItem(item, livePools, context.location)
        return buildDriftItem(item, context.location)
      }

      // ── AKS Node Pool ──
      case 'azurerm_kubernetes_cluster_node_pool': {
        const clusterId = str(item.values.kubernetes_cluster_id)
        const id = resourceId(item)
        const resolvedClusterId = clusterId || id
        const sub = extractSubscriptionId(resolvedClusterId)
        const rg = extractResourceGroup(resolvedClusterId)
        const name = extractClusterName(resolvedClusterId)
        const key = aksClusterKeyId({ subscriptionId: sub, resourceGroup: rg, clusterName: name })
        const livePools = live.aksNodePoolsByCluster?.get(key)
        if (livePools) return buildAksNodePoolDriftItem(item, livePools, context.location)
        return buildDriftItem(item, context.location)
      }

      // ── Virtual Machines ──
      case 'azurerm_virtual_machine':
      case 'azurerm_linux_virtual_machine':
      case 'azurerm_windows_virtual_machine': {
        if (!live.virtualMachines) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveVm = live.virtualMachines.find((vm) => vm.name.toLowerCase() === tfName.toLowerCase())
        if (!liveVm) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Virtual machine "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `VM "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        const tfVmSize = str(item.values.vm_size) || str(item.values.size)
        compareValues(differences, 'vm_size', 'VM size', tfVmSize.toLowerCase(), liveVm.vmSize.toLowerCase())
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveVm.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for virtual machine "${tfName}".`
            : `Terraform state and live Azure virtual machine "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live VM "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── VMSS ──
      case 'azurerm_virtual_machine_scale_set':
      case 'azurerm_linux_virtual_machine_scale_set':
      case 'azurerm_windows_virtual_machine_scale_set': {
        if (!live.vmss) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveVmss = live.vmss.find((v) => v.name.toLowerCase() === tfName.toLowerCase())
        if (!liveVmss) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `VMSS "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `VMSS "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        const tfSkuName = str(item.values.sku) || str(item.values.sku_name)
        compareValues(differences, 'sku_name', 'SKU name', tfSkuName.toLowerCase(), liveVmss.skuName.toLowerCase())
        const tfSkuCapacity = num(item.values.instances) ?? num(item.values.sku_capacity)
        if (tfSkuCapacity !== null && tfSkuCapacity !== liveVmss.skuCapacity) {
          differences.push(createDifference('sku_capacity', 'SKU capacity', formatValue(tfSkuCapacity), formatValue(liveVmss.skuCapacity)))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveVmss.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for VMSS "${tfName}".`
            : `Terraform state and live Azure VMSS "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live VMSS "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── Storage Accounts ──
      case 'azurerm_storage_account': {
        if (!live.storageAccounts) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveAccount = live.storageAccounts.find((a) => a.name.toLowerCase() === tfName.toLowerCase())
        if (!liveAccount) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Storage account "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `Storage account "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'account_kind', 'kind', str(item.values.account_kind), liveAccount.kind)
        compareValues(differences, 'account_replication_type', 'SKU name', str(item.values.account_replication_type), liveAccount.skuName)
        compareValues(differences, 'access_tier', 'access tier', str(item.values.access_tier), liveAccount.accessTier)
        const tfHttpsOnly = formatValue(bool(item.values.enable_https_traffic_only))
        compareValues(differences, 'enable_https_traffic_only', 'HTTPS only', tfHttpsOnly, formatValue(liveAccount.httpsOnly))
        compareValues(differences, 'min_tls_version', 'minimum TLS version', str(item.values.min_tls_version), liveAccount.minimumTlsVersion)
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveAccount.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for storage account "${tfName}".`
            : `Terraform state and live Azure storage account "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live storage account "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── MSSQL Server ──
      case 'azurerm_mssql_server': {
        if (!live.sqlEstate?.servers) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveServer = live.sqlEstate.servers.find((s) => s.name.toLowerCase() === tfName.toLowerCase())
        if (!liveServer) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `SQL Server "${tfName}" exists in Terraform state but was not found in live Azure SQL estate.`,
            evidence: [`Terraform address: ${item.address}`, `SQL Server "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'version', 'version', str(item.values.version), liveServer.version)
        const tfPublicAccess = item.values.public_network_access_enabled
        if (tfPublicAccess !== undefined) {
          const tfVal = formatValue(bool(tfPublicAccess))
          const liveVal = formatValue(liveServer.publicNetworkAccess.toLowerCase() === 'enabled')
          compareValues(differences, 'public_network_access_enabled', 'public network access', tfVal, liveVal)
        }
        compareValues(differences, 'minimum_tls_version', 'minimal TLS version', str(item.values.minimum_tls_version), liveServer.minimalTlsVersion)
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveServer.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for SQL Server "${tfName}".`
            : `Terraform state and live Azure SQL Server "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live SQL Server "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── MSSQL Database ──
      case 'azurerm_mssql_database': {
        if (!live.sqlEstate?.databases) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        // Extract server name from the server_id attribute
        const serverId = str(item.values.server_id)
        const serverNameMatch = serverId.match(/\/servers\/([^/]+)/i)
        const tfServerName = serverNameMatch?.[1] ?? ''
        const liveDb = live.sqlEstate.databases.find((db) =>
          db.name.toLowerCase() === tfName.toLowerCase() &&
          (!tfServerName || db.serverName.toLowerCase() === tfServerName.toLowerCase())
        )
        if (!liveDb) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `SQL database "${tfName}" exists in Terraform state but was not found in live Azure SQL estate.`,
            evidence: [`Terraform address: ${item.address}`, `SQL database "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'sku_name', 'SKU name', str(item.values.sku_name), liveDb.skuName)
        const tfMaxSizeGb = num(item.values.max_size_gb)
        if (tfMaxSizeGb !== null && tfMaxSizeGb !== liveDb.maxSizeGb) {
          differences.push(createDifference('max_size_gb', 'max size GB', formatValue(tfMaxSizeGb), formatValue(liveDb.maxSizeGb)))
        }
        const tfZoneRedundant = item.values.zone_redundant
        if (tfZoneRedundant !== undefined) {
          compareValues(differences, 'zone_redundant', 'zone redundant', formatValue(bool(tfZoneRedundant)), formatValue(liveDb.zoneRedundant))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveDb.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for SQL database "${tfName}".`
            : `Terraform state and live Azure SQL database "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live SQL database "${tfName}" (server: ${liveDb.serverName}) by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── PostgreSQL Flexible Server ──
      case 'azurerm_postgresql_flexible_server': {
        if (!live.postgreSqlEstate?.servers) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveServer = live.postgreSqlEstate.servers.find((s) => s.name.toLowerCase() === tfName.toLowerCase())
        if (!liveServer) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `PostgreSQL Flexible Server "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `PostgreSQL server "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'version', 'version', str(item.values.version), liveServer.version)
        // Terraform stores SKU as "GP_Standard_D2s_v3" (tier prefix + compute),
        // but Azure API returns just "Standard_D2s_v3". Strip the tier prefix
        // (B_, GP_, MO_) before comparing to avoid false drift.
        const tfSku = str(item.values.sku_name)
        const normalizedTfSku = tfSku.replace(/^(B_|GP_|MO_)/i, '')
        const normalizedLiveSku = (liveServer.skuName || '').replace(/^(B_|GP_|MO_)/i, '')
        compareValues(differences, 'sku_name', 'SKU name', normalizedTfSku, normalizedLiveSku)
        const tfStorageMb = num(item.values.storage_mb)
        if (tfStorageMb !== null) {
          const tfStorageSizeGb = Math.floor(tfStorageMb / 1024)
          if (tfStorageSizeGb !== liveServer.storageSizeGb) {
            differences.push(createDifference('storage_mb', 'storage size GB', formatValue(tfStorageSizeGb), formatValue(liveServer.storageSizeGb)))
          }
        }
        const haBlock = firstObject(item.values.high_availability)
        const tfHaMode = str(haBlock.mode)
        if (tfHaMode) {
          const tfHaEnabled = formatValue(tfHaMode.toLowerCase() !== 'disabled')
          compareValues(differences, 'high_availability_mode', 'HA enabled', tfHaEnabled, formatValue(liveServer.haEnabled))
        }
        const tfBackupRetention = num(item.values.backup_retention_days)
        if (tfBackupRetention !== null && tfBackupRetention !== liveServer.backupRetentionDays) {
          differences.push(createDifference('backup_retention_days', 'backup retention days', formatValue(tfBackupRetention), formatValue(liveServer.backupRetentionDays)))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveServer.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for PostgreSQL server "${tfName}".`
            : `Terraform state and live Azure PostgreSQL server "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live PostgreSQL server "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── Key Vault ──
      case 'azurerm_key_vault': {
        if (!live.keyVaults) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveVault = live.keyVaults.find((kv) => kv.name.toLowerCase() === tfName.toLowerCase())
        if (!liveVault) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Key Vault "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `Key Vault "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'sku_name', 'SKU name', str(item.values.sku_name).toLowerCase(), liveVault.skuName.toLowerCase())
        const tfSoftDelete = item.values.soft_delete_enabled
        if (tfSoftDelete !== undefined) {
          compareValues(differences, 'soft_delete_enabled', 'soft delete', formatValue(bool(tfSoftDelete)), formatValue(liveVault.enableSoftDelete))
        }
        const tfPurgeProtection = item.values.purge_protection_enabled
        if (tfPurgeProtection !== undefined) {
          compareValues(differences, 'purge_protection_enabled', 'purge protection', formatValue(bool(tfPurgeProtection)), formatValue(liveVault.enablePurgeProtection))
        }
        const tfRbac = item.values.enable_rbac_authorization
        if (tfRbac !== undefined) {
          compareValues(differences, 'enable_rbac_authorization', 'RBAC authorization', formatValue(bool(tfRbac)), formatValue(liveVault.enableRbacAuthorization))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveVault.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for Key Vault "${tfName}".`
            : `Terraform state and live Azure Key Vault "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live Key Vault "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── Event Hub Namespace ──
      case 'azurerm_eventhub_namespace': {
        if (!live.eventHubNamespaces) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveNs = live.eventHubNamespaces.find((ns) => ns.name.toLowerCase() === tfName.toLowerCase())
        if (!liveNs) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Event Hub namespace "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `Event Hub namespace "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'sku', 'SKU name', str(item.values.sku).toLowerCase(), liveNs.skuName.toLowerCase())
        const tfCapacity = num(item.values.capacity)
        if (tfCapacity !== null && tfCapacity !== liveNs.skuCapacity) {
          differences.push(createDifference('capacity', 'SKU capacity', formatValue(tfCapacity), formatValue(liveNs.skuCapacity)))
        }
        const tfKafka = item.values.kafka_enabled
        if (tfKafka !== undefined) {
          compareValues(differences, 'kafka_enabled', 'Kafka enabled', formatValue(bool(tfKafka)), formatValue(liveNs.kafkaEnabled))
        }
        const tfZoneRedundant = item.values.zone_redundant
        if (tfZoneRedundant !== undefined) {
          compareValues(differences, 'zone_redundant', 'zone redundant', formatValue(bool(tfZoneRedundant)), formatValue(liveNs.zoneRedundant))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveNs.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for Event Hub namespace "${tfName}".`
            : `Terraform state and live Azure Event Hub namespace "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live Event Hub namespace "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── Event Hub ──
      case 'azurerm_eventhub': {
        const nsName = str(item.values.namespace_name)
        const liveHubs = live.eventHubsByNamespace?.[nsName]
        if (!liveHubs) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveHub = liveHubs.find((h) => h.name.toLowerCase() === tfName.toLowerCase())
        if (!liveHub) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Event Hub "${tfName}" in namespace "${nsName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `Event Hub "${tfName}" not found in namespace "${nsName}".`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        const tfPartitionCount = num(item.values.partition_count)
        if (tfPartitionCount !== null && tfPartitionCount !== liveHub.partitionCount) {
          differences.push(createDifference('partition_count', 'partition count', formatValue(tfPartitionCount), formatValue(liveHub.partitionCount)))
        }
        const tfMessageRetention = num(item.values.message_retention)
        if (tfMessageRetention !== null && tfMessageRetention !== liveHub.messageRetentionInDays) {
          differences.push(createDifference('message_retention', 'message retention in days', formatValue(tfMessageRetention), formatValue(liveHub.messageRetentionInDays)))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveHub.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for Event Hub "${tfName}".`
            : `Terraform state and live Azure Event Hub "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live Event Hub "${tfName}" in namespace "${nsName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── App Service Plan ──
      case 'azurerm_service_plan':
      case 'azurerm_app_service_plan': {
        if (!live.appServicePlans) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const livePlan = live.appServicePlans.find((p) => p.name.toLowerCase() === tfName.toLowerCase())
        if (!livePlan) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `App Service Plan "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `App Service Plan "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'sku_name', 'SKU name', str(item.values.sku_name).toLowerCase(), livePlan.skuName.toLowerCase())
        const tfWorkerCount = num(item.values.worker_count)
        if (tfWorkerCount !== null && tfWorkerCount !== livePlan.numberOfWorkers) {
          differences.push(createDifference('worker_count', 'number of workers', formatValue(tfWorkerCount), formatValue(livePlan.numberOfWorkers)))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: livePlan.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for App Service Plan "${tfName}".`
            : `Terraform state and live Azure App Service Plan "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live App Service Plan "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── Web Apps ──
      case 'azurerm_linux_web_app':
      case 'azurerm_windows_web_app':
      case 'azurerm_app_service': {
        if (!live.webApps) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveApp = live.webApps.find((a) => a.name.toLowerCase() === tfName.toLowerCase())
        if (!liveApp) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Web App "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `Web App "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        const tfHttpsOnly = item.values.https_only
        if (tfHttpsOnly !== undefined) {
          compareValues(differences, 'https_only', 'HTTPS only', formatValue(bool(tfHttpsOnly)), formatValue(liveApp.httpsOnly))
        }
        compareValues(differences, 'minimum_tls_version', 'minimum TLS version', str(item.values.minimum_tls_version), liveApp.minTlsVersion)
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveApp.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for Web App "${tfName}".`
            : `Terraform state and live Azure Web App "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live Web App "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── Virtual Network ──
      case 'azurerm_virtual_network': {
        if (!live.networkOverview?.vnets) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveVnet = live.networkOverview.vnets.find((v) => v.name.toLowerCase() === tfName.toLowerCase())
        if (!liveVnet) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Virtual network "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `VNet "${tfName}" not found in live Azure inventory.`]
          })
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveVnet.id || tfName,
          explanation: `Virtual network "${tfName}" exists in both Terraform state and live Azure inventory.`,
          evidence: [`Matched live VNet "${tfName}" by name.`]
        })
      }

      // ── Network Security Group ──
      case 'azurerm_network_security_group': {
        if (!live.networkOverview?.nsgs) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveNsg = live.networkOverview.nsgs.find((n) => n.name.toLowerCase() === tfName.toLowerCase())
        if (!liveNsg) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Network security group "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `NSG "${tfName}" not found in live Azure inventory.`]
          })
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveNsg.id || tfName,
          explanation: `Network security group "${tfName}" exists in both Terraform state and live Azure inventory.`,
          evidence: [`Matched live NSG "${tfName}" by name.`]
        })
      }

      // ── Application Insights ──
      case 'azurerm_application_insights': {
        if (!live.appInsights) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveAi = live.appInsights.find((a) => a.name.toLowerCase() === tfName.toLowerCase())
        if (!liveAi) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Application Insights "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `Application Insights "${tfName}" not found in live Azure inventory.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        const tfRetention = num(item.values.retention_in_days)
        if (tfRetention !== null && tfRetention !== liveAi.retentionInDays) {
          differences.push(createDifference('retention_in_days', 'retention in days', formatValue(tfRetention), formatValue(liveAi.retentionInDays)))
        }
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveAi.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for Application Insights "${tfName}".`
            : `Terraform state and live Azure Application Insights "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live Application Insights "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      case 'azurerm_resource_group': {
        const tfName = str(item.values.name)
        const tfLocation = str(item.values.location)
        const allResourceGroups = new Set<string>()
        for (const vm of live.virtualMachines ?? []) allResourceGroups.add(vm.resourceGroup.toLowerCase())
        for (const sa of live.storageAccounts ?? []) allResourceGroups.add(sa.resourceGroup.toLowerCase())
        for (const vnet of live.networkOverview?.vnets ?? []) allResourceGroups.add(vnet.resourceGroup.toLowerCase())
        const exists = allResourceGroups.has(tfName.toLowerCase())
        return buildVerifiedAzureItem(item, context.location, {
          exists,
          cloudIdentifier: resourceId(item) || tfName,
          explanation: exists
            ? `Resource group "${tfName}" exists in live Azure inventory.`
            : `Resource group "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
          evidence: exists
            ? [`Resource group "${tfName}" confirmed via resource discovery.`, `Location: ${tfLocation || 'not set'}`]
            : [`Terraform address: ${item.address}`, `Resource group "${tfName}" not found in live discovery.`]
        })
      }

      case 'azurerm_subnet': {
        if (!live.networkOverview) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const tfVnetName = str(item.values.virtual_network_name)
        const tfPrefix = str(item.values.address_prefix) || (Array.isArray(item.values.address_prefixes) ? str((item.values.address_prefixes as unknown[])[0]) : '')
        const parentVnet = live.networkOverview.vnets.find((v) => v.name.toLowerCase() === tfVnetName.toLowerCase())
        const exists = Boolean(parentVnet)
        const differences: TerraformDriftDifference[] = []
        return buildVerifiedAzureItem(item, context.location, {
          exists,
          cloudIdentifier: resourceId(item) || `${tfVnetName}/${tfName}`,
          explanation: exists
            ? `Subnet "${tfName}" parent VNet "${tfVnetName}" exists in live Azure inventory.`
            : `Subnet "${tfName}" parent VNet "${tfVnetName}" was not found in live Azure inventory.`,
          evidence: [
            `Terraform address: ${item.address}`,
            `VNet: ${tfVnetName}`,
            `Address prefix: ${tfPrefix || 'not set'}`
          ],
          differences
        })
      }

      case 'azurerm_cosmosdb_account': {
        if (!live.cosmosDbEstate) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveAccount = live.cosmosDbEstate.accounts.find((a) => a.name.toLowerCase() === tfName.toLowerCase())
        if (!liveAccount) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `Cosmos DB account "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `Cosmos DB account "${tfName}" not found.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'kind', 'Kind', str(item.values.kind), liveAccount.kind || '')
        compareValues(differences, 'offer_type', 'Offer Type', str(item.values.offer_type), liveAccount.databaseAccountOfferType || '')
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveAccount.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for Cosmos DB account "${tfName}".`
            : `Terraform state and live Azure Cosmos DB account "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live Cosmos DB account "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      case 'azurerm_dns_zone': {
        if (!live.dnsZones) return buildDriftItem(item, context.location)
        const tfName = str(item.values.name)
        const liveZone = live.dnsZones.find((z) => z.name.toLowerCase() === tfName.toLowerCase())
        if (!liveZone) {
          return buildVerifiedAzureItem(item, context.location, {
            exists: false,
            cloudIdentifier: resourceId(item) || tfName,
            explanation: `DNS zone "${tfName}" exists in Terraform state but was not found in live Azure inventory.`,
            evidence: [`Terraform address: ${item.address}`, `DNS zone "${tfName}" not found.`]
          })
        }
        const differences: TerraformDriftDifference[] = []
        compareValues(differences, 'zone_type', 'Zone Type', str(item.values.zone_type), liveZone.zoneType || '')
        return buildVerifiedAzureItem(item, context.location, {
          exists: true,
          cloudIdentifier: liveZone.id || tfName,
          explanation: differences.length > 0
            ? `Detected ${differences.length} verified drift signal${differences.length === 1 ? '' : 's'} for DNS zone "${tfName}".`
            : `Terraform state and live Azure DNS zone "${tfName}" match on tracked attributes.`,
          evidence: [`Matched live DNS zone "${tfName}" by name.`, ...differences.map((d) => `${d.label}: terraform=${d.terraformValue || '-'} azure=${d.liveValue || '-'}`)],
          differences
        })
      }

      // ── Fallback: inferred drift for unsupported types ──
      default:
        return buildDriftItem(item, context.location)
    }
  })

  const summary = summarizeItems(items, scannedAt)

  return {
    projectId: project.id,
    projectName: project.name,
    profileName,
    region: context.location,
    summary,
    items,
    history: singleSnapshot(summary, items, scannedAt),
    fromCache: false
  }
  }, (report, auditSummary) => ({ ...report, audit: auditSummary }))
}

function postureArea(id: string, label: string, value: string, tone: ObservabilityPostureArea['tone'], detail: string): ObservabilityPostureArea {
  return { id, label, value, tone, detail }
}

function finding(id: string, title: string, severity: ObservabilityFinding['severity'], summary: string, detail: string, impact: string, recommendationId: string, inference = true): ObservabilityFinding {
  return {
    id,
    title,
    severity,
    category: 'deployment',
    summary,
    detail,
    evidence: [],
    impact,
    inference,
    recommendedActionIds: [recommendationId]
  }
}

function recommendation(id: string, title: string, summary: string, rationale: string, expectedBenefit: string, risk: string, rollback: string): ObservabilityRecommendation {
  return {
    id,
    title,
    type: 'manual-check',
    summary,
    rationale,
    expectedBenefit,
    risk,
    rollback,
    prerequisiteLevel: 'required',
    setupEffort: 'low',
    labels: ['azure', 'terraform']
  }
}

export async function generateAzureTerraformObservabilityReport(
  profileName: string,
  projectId: string,
  connection?: AwsConnection
): Promise<ObservabilityPostureReport> {
  const project = await getProject(profileName, projectId, connection)
  const context = parseAzureContext(profileName, project, connection)
  const azureResources = project.inventory.filter((item) => item.mode === 'managed' && item.type.startsWith('azurerm_'))
  const monitorCount = azureResources.filter((item) => item.type.includes('monitor_') || item.type.includes('log_analytics_')).length
  const taggedCount = azureResources.filter((item) => {
    const tags = item.values.tags
    return Boolean(tags && typeof tags === 'object' && Object.keys(tags as Record<string, unknown>).length > 0)
  }).length
  const tagCoverage = azureResources.length > 0 ? Math.round((taggedCount / azureResources.length) * 100) : 0

  const recommendations: ObservabilityRecommendation[] = [
    recommendation('azure-backend', 'Move state to a shared backend', 'Prefer a remote backend for Azure shared workspaces.', 'Shared workspaces rely on consistent state access and recoverability.', 'Improves recovery and operator confidence.', 'Backend migration needs coordination.', 'Revert backend configuration and reinitialize if the migration is blocked.'),
    recommendation('azure-monitor', 'Add Azure Monitor anchors', 'Track diagnostic settings and Log Analytics resources in Terraform.', 'Shared Overview and Direct Access become more actionable when monitoring surfaces exist in state.', 'Improves observability and handoff quality.', 'Additional resources may increase cost.', 'Remove the monitor resources from Terraform if they are not desired.')
  ]

  const findings: ObservabilityFinding[] = []
  if (project.metadata.backendType === 'local') {
    findings.push(finding('local-backend', 'Terraform state uses a local backend', 'high', 'Local backend detected', 'The project is still using a local backend, which weakens shared operator recovery flows.', 'Operators have lower confidence during incident response or drift review.', 'azure-backend'))
  }
  if (monitorCount === 0 && azureResources.length > 0) {
    findings.push(finding('monitor-gap', 'Azure Monitor resources are not tracked in Terraform', 'medium', 'No monitor anchors found', 'No Azure Monitor diagnostic or Log Analytics resources are visible in the current Terraform inventory.', 'Overview and resilience workflows have fewer observability pivots.', 'azure-monitor'))
  }

  const correlatedSignals: CorrelatedSignalReference[] = [
    { id: 'azure-terraform', title: 'Terraform workspace', detail: project.name, serviceId: 'terraform', targetView: 'drift' },
    { id: 'azure-overview', title: 'Shared overview', detail: context.contextId, serviceId: 'overview', targetView: 'overview' },
    { id: 'azure-compliance', title: 'Compliance queue', detail: 'Azure heuristic findings', serviceId: 'compliance-center', targetView: 'tasks' },
    { id: 'azure-compare', title: 'Compare workspace', detail: 'Cross-project Azure Terraform comparison', serviceId: 'compare', targetView: 'services' }
  ]

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      kind: 'terraform',
      connection: {
        kind: connection?.kind ?? 'profile',
        label: connection?.label || context.contextId,
        profile: connection?.profile || context.contextId,
        region: connection?.region || context.location,
        sessionId: connection?.sessionId || profileName
      },
      projectId: project.id,
      projectName: project.name,
      rootPath: project.rootPath
    },
    summary: [
      postureArea('resources', 'Tracked resources', String(azureResources.length), azureResources.length > 0 ? 'mixed' : 'weak', 'Azure observability inference currently works from Terraform inventory only.'),
      postureArea('backend', 'Backend', project.metadata.backendType, project.metadata.backendType === 'local' ? 'weak' : 'good', 'Remote backends improve shared operator recovery and drift workflows.'),
      postureArea('monitor', 'Monitor coverage', String(monitorCount), monitorCount > 0 ? 'good' : 'weak', 'Diagnostic settings and Log Analytics resources act as observability anchors.'),
      postureArea('tags', 'Tag coverage', `${tagCoverage}%`, tagCoverage >= 70 ? 'good' : tagCoverage >= 40 ? 'mixed' : 'weak', 'Tags help correlate cost, ownership, and remediation queues.')
    ],
    findings,
    recommendations,
    experiments: [],
    artifacts: [],
    safetyNotes: [
      {
        title: 'Azure Terraform observability is inferred',
        blastRadius: 'Low',
        prerequisites: ['Use the terminal handoff for stronger live verification when needed.'],
        rollback: 'No rollback required; this report does not mutate infrastructure.'
      }
    ],
    correlatedSignals
  }
}
