import type {
  AwsConnection,
  AzureAksNodePoolSummary,
  TerraformDriftDifference,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformDriftStatus,
  TerraformProject
} from '@shared/types'
import {
  listAzureEventHubs
} from './index'
import { enrichTerragruntProjectInventory, getProject, loadTerragruntUnitInventory, type TerragruntUnitInventoryResult } from '../terraform'
import { createTraceContext, withAudit } from '../terraformAudit'
import {
  type AksClusterKey,
  type AzureLiveData,
  aksClusterKeyId,
  bool,
  buildAksClusterDriftItem,
  buildAksNodePoolDriftItem,
  buildDriftItem,
  buildVerifiedAzureItem,
  compareValues,
  createDifference,
  extractClusterName,
  extractSubscriptionId,
  extractSubscriptionIdFromInventory,
  extractTerraformResourceGroup,
  fetchLiveNodePools,
  firstObject,
  formatValue,
  loadAzureLiveData,
  num,
  parseAzureContext,
  portalUrl,
  resourceId,
  resourceLocation,
  singleSnapshot,
  str,
  summarizeItems,
  terminalCommand
} from './terraformShared'

/**
 * Per-unit Terragrunt drift reporter for Azure. Same rationale as the GCP equivalent:
 * a separate function with required `unitPath` prevents esbuild's whole-program DCE
 * from eliminating the unit-scope substitution branch.
 */
export async function getAzureTerragruntUnitDriftReport(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  unitPath: string,
  preloadedInventory: TerragruntUnitInventoryResult | null
): Promise<TerraformDriftReport> {
  const baseProject = await getProject(profileName, projectId, connection)
  const pulled = preloadedInventory ?? await loadTerragruntUnitInventory(profileName, projectId, connection, unitPath)
  if (pulled.error) {
    throw new Error(pulled.error)
  }
  let hasManaged = false
  for (const item of pulled.inventory) {
    if (item.mode === 'managed') { hasManaged = true; break }
  }
  if (!hasManaged) {
    throw new Error([
      `State pull for ${unitPath} returned no managed resources.`,
      `stateSource=${pulled.stateSource || '(empty)'}, rawBytes=${pulled.rawStateJson.length}.`,
      'If the unit was applied successfully, the state object exists but parsing dropped every resource — share this message so it can be fixed.',
      'If the unit was never applied, run `terragrunt apply` on it first.'
    ].join('\n'))
  }
  const project: TerraformProject = {
    ...baseProject,
    inventory: pulled.inventory,
    stateAddresses: pulled.stateAddresses,
    rawStateJson: pulled.rawStateJson,
    stateSource: pulled.stateSource || baseProject.stateSource
  }
  return runAzureDriftReport(profileName, project, connection, unitPath)
}

export async function getAzureTerraformDriftReport(
  profileName: string,
  projectId: string,
  connection?: AwsConnection,
  _options?: { forceRefresh?: boolean }
): Promise<TerraformDriftReport> {
  const baseProject = await getProject(profileName, projectId, connection)
  // Same rationale as getGcpTerraformDriftReport: loadProject only reads local state files, so
  // a terragrunt project with a remote backend lands here with an empty inventory and every
  // live Azure resource reads as "missing from state". For terragrunt-unit we pull the single
  // unit (hard error surfaces to UI); for terragrunt-stack we aggregate across all discovered
  // units with per-unit failures tolerated.
  const project: TerraformProject = baseProject.kind === 'terragrunt-unit'
    ? await (async () => {
        const pulled = await loadTerragruntUnitInventory(profileName, projectId, connection, baseProject.rootPath)
        if (pulled.error) throw new Error(pulled.error)
        return {
          ...baseProject,
          inventory: pulled.inventory,
          stateAddresses: pulled.stateAddresses,
          rawStateJson: pulled.rawStateJson,
          stateSource: pulled.stateSource || baseProject.stateSource
        }
      })()
    : baseProject.kind === 'terragrunt-stack'
      ? { ...baseProject, inventory: await enrichTerragruntProjectInventory(profileName, connection, baseProject) }
      : baseProject
  return runAzureDriftReport(profileName, project, connection, '')
}

async function runAzureDriftReport(
  profileName: string,
  project: TerraformProject,
  connection: AwsConnection | undefined,
  unitScopeLabel: string
): Promise<TerraformDriftReport> {
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
    const rg = str(item.values.resource_group_name) || extractTerraformResourceGroup(id)
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
    const rg = extractTerraformResourceGroup(resolvedClusterId)
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
        const rg = str(item.values.resource_group_name) || extractTerraformResourceGroup(id)
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
        const rg = extractTerraformResourceGroup(resolvedClusterId)
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
