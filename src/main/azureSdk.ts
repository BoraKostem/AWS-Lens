import { app, dialog, BrowserWindow, shell } from 'electron'
import { execFile } from 'node:child_process'
import { createWriteStream, watchFile, unwatchFile } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob'
import { DefaultAzureCredential } from '@azure/identity'

import type {
  AzureAksClusterDetail,
  AzureAksClusterSummary,
  AzureAksNodePoolSummary,
  AzureCostBreakdownEntry,
  AzureCostDailyEntry,
  AzureCostOverview,
  AzureMonitorActivityEvent,
  AzureMonitorActivityResult,
  AzureMonitorFacetCount,
  AzureRbacOverview,
  AzureRoleAssignmentSummary,
  AzureRoleDefinitionSummary,
  AzureSqlDatabaseSummary,
  AzureSqlEstateOverview,
  AzureSqlFinding,
  AzureSqlFirewallRule,
  AzureSqlPostureBadge,
  AzureSqlServerDetail,
  AzureSqlServerSummary,
  AzureSqlSummaryTile,
  AzureStorageAccountSummary,
  AzureStorageBlobContent,
  AzureStorageBlobSummary,
  AzureStorageContainerSummary,
  AzureSubscriptionSummary,
  AzureVirtualMachineDetail,
  AzureVirtualMachineSummary,
  AzureVmAction,
  AzureVmActionResult,
  AzureVNetSummary,
  AzureSubnetSummary,
  AzureNsgSummary,
  AzureNsgRuleSummary,
  AzurePublicIpSummary,
  AzureNetworkInterfaceSummary,
  AzureNetworkOverview,
  AzureVmssSummary,
  AzureVmssInstanceSummary,
  AzureVmssActionResult,
  AzurePostgreSqlServerSummary,
  AzurePostgreSqlDatabaseSummary,
  AzurePostgreSqlEstateOverview,
  AzurePostgreSqlFirewallRule,
  AzurePostgreSqlPostureBadge,
  AzurePostgreSqlSummaryTile,
  AzurePostgreSqlFinding,
  AzurePostgreSqlServerDetail,
  AzureAppInsightsSummary,
  AzureKeyVaultSummary,
  AzureKeyVaultSecretSummary,
  AzureKeyVaultKeySummary,
  AzureEventHubNamespaceSummary,
  AzureEventHubSummary,
  AzureEventHubConsumerGroupSummary,
  AzureAppServicePlanSummary,
  AzureWebAppSummary,
  AzureWebAppSlotSummary,
  AzureWebAppDeploymentSummary
} from '@shared/types'

import { getEnvironmentHealthReport } from './environment'
import { logInfo, logWarn } from './observability'

const execFileAsync = promisify(execFile)

async function loadAzureCliPath(): Promise<string> {
  try {
    const report = await getEnvironmentHealthReport()
    return report.tools.find((t) => t.id === 'azure-cli' && t.found)?.path.trim() ?? ''
  } catch {
    return ''
  }
}

function isWindowsBatchFile(command: string): boolean {
  if (process.platform !== 'win32') return false
  const ext = extname(command.trim()).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

function resolveKubeconfigPath(kubeconfigPath: string): string {
  const trimmed = kubeconfigPath.trim()
  if (!trimmed) return join(homedir(), '.kube', 'config')
  if (trimmed === '.kube/config' || trimmed === '.kube\\config') return join(homedir(), '.kube', 'config')
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return resolve(homedir(), trimmed.slice(2))
  if (isAbsolute(trimmed)) return trimmed
  return resolve(homedir(), trimmed)
}

let azureCredential: DefaultAzureCredential | null = null
const azureBlobServiceClientCache = new Map<string, Promise<BlobServiceClient>>()
const AZURE_RISKY_ROLE_MARKERS = [
  'owner',
  'contributor',
  'user access administrator',
  'role based access control administrator'
] as const

function getAzureCredential(): DefaultAzureCredential {
  if (!azureCredential) {
    azureCredential = new DefaultAzureCredential()
  }

  return azureCredential
}

function normalizeLocationList(locations: string[]): string[] {
  return [...new Set(
    locations
      .map((value) => value.trim())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right))
}

async function getAzureAccessToken(): Promise<string> {
  const token = await getAzureCredential().getToken('https://management.azure.com/.default')
  if (!token?.token) {
    throw new Error('Azure credential chain did not return a management-plane access token.')
  }

  return token.token
}

async function fetchAzureArmJson<T>(path: string, apiVersion: string, init?: RequestInit): Promise<T> {
  const url = /^https?:\/\//i.test(path)
    ? path
    : `https://management.azure.com${path}${path.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(apiVersion)}`
  const response: Response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${await getAzureAccessToken()}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Azure ARM request failed (${response.status} ${response.statusText}): ${body || path}`)
  }

  return await response.json() as T
}

async function fetchAzureArmCollection<T>(path: string, apiVersion: string): Promise<T[]> {
  const items: T[] = []
  let nextLink: string | null = path

  while (nextLink) {
    const page: { value?: T[]; nextLink?: string } = await fetchAzureArmJson(nextLink, apiVersion)
    items.push(...(page.value ?? []))
    nextLink = page.nextLink ?? null
  }

  return items
}

function extractResourceGroup(resourceId: string): string {
  const match = resourceId.match(/\/resourceGroups\/([^/]+)/i)
  return match?.[1] ?? ''
}

function extractResourceName(resourceId: string): string {
  const segments = resourceId.split('/').filter(Boolean)
  return segments.at(-1) ?? ''
}

function extractPowerState(statuses: Array<{ code?: string; displayStatus?: string }>): string {
  const match = statuses.find((status) => status.code?.toLowerCase().startsWith('powerstate/'))
  return match?.displayStatus?.trim() || match?.code?.split('/').pop()?.trim() || 'Unknown'
}

function extractProvisioningState(statuses: Array<{ code?: string; displayStatus?: string }>, fallback: string): string {
  const match = statuses.find((status) => status.code?.toLowerCase().startsWith('provisioningstate/'))
  return match?.displayStatus?.trim() || fallback.trim() || 'Unknown'
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  )

  return results
}

function inferScopeKind(scope: string, subscriptionScope: string): AzureRoleAssignmentSummary['scopeKind'] {
  const normalizedScope = scope.toLowerCase()
  const normalizedSubscriptionScope = subscriptionScope.toLowerCase()

  if (normalizedScope === normalizedSubscriptionScope) {
    return 'subscription'
  }

  if (normalizedScope.includes('/resourcegroups/')) {
    return 'resourceGroup'
  }

  return 'resource'
}

function normalizeRegion<T extends { location: string }>(items: T[], location: string): T[] {
  const normalizedLocation = location.trim().toLowerCase().replace(/\s+/g, '')
  if (!normalizedLocation) {
    return items
  }

  return items.filter((item) => item.location.trim().toLowerCase().replace(/\s+/g, '') === normalizedLocation)
}

function toFacetCounts(values: string[]): AzureMonitorFacetCount[] {
  const counts = new Map<string, number>()
  for (const value of values.map((entry) => entry.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}

function guessContentTypeFromKey(key: string): string {
  switch (extname(key.trim()).toLowerCase()) {
    case '.json':
      return 'application/json'
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.ts':
    case '.tsx':
      return 'application/javascript'
    case '.html':
      return 'text/html'
    case '.css':
      return 'text/css'
    case '.md':
      return 'text/markdown'
    case '.xml':
      return 'application/xml'
    case '.yaml':
    case '.yml':
      return 'application/yaml'
    case '.csv':
      return 'text/csv'
    case '.txt':
    case '.log':
    case '.sh':
    case '.ps1':
    case '.tf':
    case '.tfvars':
      return 'text/plain'
    case '.sql':
      return 'application/sql'
    default:
      return 'application/octet-stream'
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream | null | undefined): Promise<Buffer> {
  if (!stream) {
    return Buffer.alloc(0)
  }

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

async function getAzureStorageAccountKey(subscriptionId: string, resourceGroup: string, accountName: string): Promise<string> {
  const response = await fetchAzureArmJson<{
    keys?: Array<{
      permissions?: string
      value?: string
    }>
  }>(
    `/subscriptions/${encodeURIComponent(subscriptionId.trim())}/resourceGroups/${encodeURIComponent(resourceGroup.trim())}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(accountName.trim())}/listKeys`,
    '2024-01-01',
    { method: 'POST' }
  )

  const key = response.keys?.find((entry) => entry.value?.trim())?.value?.trim() || ''
  if (!key) {
    throw new Error(`No Azure storage account key was returned for account "${accountName}".`)
  }

  return key
}

async function getAzureBlobServiceClient(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  blobEndpoint = ''
): Promise<BlobServiceClient> {
  const cacheKey = `${subscriptionId.trim()}:${resourceGroup.trim().toLowerCase()}:${accountName.trim().toLowerCase()}`
  const cached = azureBlobServiceClientCache.get(cacheKey)
  if (cached) {
    return await cached
  }

  const pending = (async () => {
    const key = await getAzureStorageAccountKey(subscriptionId, resourceGroup, accountName)
    const endpoint = blobEndpoint.trim() || `https://${accountName.trim()}.blob.core.windows.net`
    const credential = new StorageSharedKeyCredential(accountName.trim(), key)
    return new BlobServiceClient(endpoint, credential)
  })()

  azureBlobServiceClientCache.set(cacheKey, pending)

  try {
    return await pending
  } catch (error) {
    azureBlobServiceClientCache.delete(cacheKey)
    throw error
  }
}

async function listSubscriptionLocations(subscriptionId: string): Promise<string[]> {
  const locations: string[] = []

  try {
    const response = await fetchAzureArmJson<{ value?: Array<{ name?: string; displayName?: string }> }>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}/locations`,
      '2022-12-01'
    )
    for (const location of response.value ?? []) {
      const label = location.name?.trim() || location.displayName?.trim() || ''
      if (label) {
        locations.push(label)
      }
    }
  } catch (error) {
    logWarn('azureSdk.listSubscriptionLocations', 'Failed to enumerate Azure subscription locations.', { subscriptionId }, error)
  }

  return normalizeLocationList(locations)
}

export async function listAzureSubscriptions(): Promise<AzureSubscriptionSummary[]> {
  const subscriptions: AzureSubscriptionSummary[] = []
  const response = await fetchAzureArmJson<{
    value?: Array<{
      subscriptionId?: string
      displayName?: string
      tenantId?: string
      state?: string
      authorizationSource?: string
      subscriptionPolicies?: {
        spendingLimit?: string
        quotaId?: string
      }
    }>
  }>('/subscriptions', '2020-01-01')

  for (const entry of response.value ?? []) {
    const subscriptionId = entry.subscriptionId?.trim() ?? ''
    if (!subscriptionId) {
      continue
    }

    const locations = await listSubscriptionLocations(subscriptionId)
    subscriptions.push({
      subscriptionId,
      displayName: entry.displayName?.trim() || subscriptionId,
      tenantId: entry.tenantId?.trim() || '',
      state: entry.state?.trim() || '',
      authorizationSource: entry.authorizationSource?.trim() || '',
      spendingLimit: entry.subscriptionPolicies?.spendingLimit?.trim() || '',
      quotaId: entry.subscriptionPolicies?.quotaId?.trim() || '',
      locationCount: locations.length,
      locations,
      managementGroupHints: []
    })
  }

  return subscriptions.sort((left, right) => left.displayName.localeCompare(right.displayName))
}

export async function getAzureRbacOverview(subscriptionId: string): Promise<AzureRbacOverview> {
  const subscriptionScope = `/subscriptions/${subscriptionId.trim()}`
  const [assignments, roleDefinitions] = await Promise.all([
    fetchAzureArmCollection<{
      id?: string
      properties?: {
        principalId?: string
        principalType?: string
        roleDefinitionId?: string
        scope?: string
        condition?: string
      }
    }>(`${subscriptionScope}/providers/Microsoft.Authorization/roleAssignments`, '2022-04-01'),
    fetchAzureArmCollection<{
      id?: string
      properties?: {
        roleName?: string
      }
    }>(`${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions`, '2022-04-01')
  ])

  const roleNameById = new Map<string, string>()
  for (const definition of roleDefinitions) {
    const definitionId = definition.id?.trim().toLowerCase()
    const roleName = definition.properties?.roleName?.trim()
    if (definitionId && roleName) {
      roleNameById.set(definitionId, roleName)
    }
  }

  const normalizedSubscriptionScope = subscriptionScope.toLowerCase()
  const mappedAssignments: AzureRoleAssignmentSummary[] = assignments.map((assignment) => {
    const roleDefinitionId = assignment.properties?.roleDefinitionId?.trim().toLowerCase() ?? ''
    const roleName = roleNameById.get(roleDefinitionId) ?? roleDefinitionId.split('/').pop() ?? 'Unknown role'
    const scope = assignment.properties?.scope?.trim() || subscriptionScope
    const risky = AZURE_RISKY_ROLE_MARKERS.some((marker) => roleName.toLowerCase().includes(marker))

    return {
      id: assignment.id?.trim() || `${scope}:${assignment.properties?.principalId?.trim() || 'unknown'}`,
      principalId: assignment.properties?.principalId?.trim() || 'unknown',
      principalType: assignment.properties?.principalType?.trim() || 'Unknown',
      roleName,
      scope,
      scopeKind: inferScopeKind(scope, subscriptionScope),
      inherited: scope.toLowerCase() !== normalizedSubscriptionScope,
      risky,
      condition: assignment.properties?.condition?.trim() || ''
    }
  }).sort((left, right) => {
    if (left.risky !== right.risky) {
      return left.risky ? -1 : 1
    }

    return left.roleName.localeCompare(right.roleName)
  })

  return {
    subscriptionId,
    assignmentCount: mappedAssignments.length,
    principalCount: new Set(mappedAssignments.map((assignment) => assignment.principalId)).size,
    roleCount: new Set(mappedAssignments.map((assignment) => assignment.roleName)).size,
    riskyAssignmentCount: mappedAssignments.filter((assignment) => assignment.risky).length,
    inheritedAssignmentCount: mappedAssignments.filter((assignment) => assignment.inherited).length,
    assignments: mappedAssignments,
    notes: mappedAssignments.length === 0
      ? ['No role assignments were visible for the selected subscription scope.']
      : []
  }
}

export async function listAzureRoleDefinitions(subscriptionId: string): Promise<AzureRoleDefinitionSummary[]> {
  const subscriptionScope = `/subscriptions/${subscriptionId.trim()}`
  const definitions = await fetchAzureArmCollection<{
    id?: string
    properties?: {
      roleName?: string
      description?: string
      type?: string
      permissions?: Array<{
        actions?: string[]
        notActions?: string[]
        dataActions?: string[]
        notDataActions?: string[]
      }>
      assignableScopes?: string[]
    }
  }>(`${subscriptionScope}/providers/Microsoft.Authorization/roleDefinitions`, '2022-04-01')

  return definitions.map((definition) => {
    const permissions = definition.properties?.permissions?.[0]
    return {
      id: definition.id?.trim() || '',
      roleName: definition.properties?.roleName?.trim() || 'Unknown',
      description: definition.properties?.description?.trim() || '',
      roleType: (definition.properties?.type === 'CustomRole' ? 'CustomRole' : 'BuiltInRole') as 'BuiltInRole' | 'CustomRole',
      actions: permissions?.actions ?? [],
      notActions: permissions?.notActions ?? [],
      dataActions: permissions?.dataActions ?? [],
      notDataActions: permissions?.notDataActions ?? [],
      assignableScopes: definition.properties?.assignableScopes ?? []
    }
  }).sort((left, right) => left.roleName.localeCompare(right.roleName))
}

export async function listAzureRoleAssignments(subscriptionId: string): Promise<AzureRoleAssignmentSummary[]> {
  const overview = await getAzureRbacOverview(subscriptionId)
  return overview.assignments
}

export async function createAzureRoleAssignment(
  subscriptionId: string,
  principalId: string,
  roleDefinitionId: string,
  scope: string
): Promise<void> {
  const assignmentId = crypto.randomUUID()
  const assignmentPath = `${scope.trim()}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`
  await fetchAzureArmJson(assignmentPath, '2022-04-01', {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        principalId: principalId.trim(),
        roleDefinitionId: roleDefinitionId.trim()
      }
    })
  })
}

export async function deleteAzureRoleAssignment(assignmentId: string): Promise<void> {
  await fetchAzureArmJson(assignmentId.trim(), '2022-04-01', { method: 'DELETE' })
}

async function resolveAzureVmNetworkSummary(
  nicIds: string[]
): Promise<{ privateIp: string; publicIp: string; hasPublicIp: boolean; subnetName: string }> {
  if (nicIds.length === 0) {
    return { privateIp: '', publicIp: '', hasPublicIp: false, subnetName: '' }
  }

  try {
    const nic = await fetchAzureArmJson<{
      properties?: {
        ipConfigurations?: Array<{
          properties?: {
            privateIPAddress?: string
            subnet?: { id?: string }
            publicIPAddress?: { id?: string }
          }
        }>
      }
    }>(nicIds[0], '2024-05-01')
    const ipConfiguration = nic.properties?.ipConfigurations?.[0]
    const privateIp = ipConfiguration?.properties?.privateIPAddress?.trim() || ''
    const subnetName = extractResourceName(ipConfiguration?.properties?.subnet?.id ?? '')
    const publicIpResourceId = ipConfiguration?.properties?.publicIPAddress?.id?.trim() || ''

    if (!publicIpResourceId) {
      return { privateIp, publicIp: '', hasPublicIp: false, subnetName }
    }

    const publicIp = await fetchAzureArmJson<{ properties?: { ipAddress?: string } }>(publicIpResourceId, '2024-05-01')
    return {
      privateIp,
      publicIp: publicIp.properties?.ipAddress?.trim() || '',
      hasPublicIp: Boolean(publicIp.properties?.ipAddress?.trim()),
      subnetName
    }
  } catch (error) {
    logWarn('azureSdk.resolveAzureVmNetworkSummary', 'Failed to enrich Azure VM networking posture.', { nicCount: nicIds.length }, error)
    return { privateIp: '', publicIp: '', hasPublicIp: false, subnetName: '' }
  }
}

export async function listAzureVirtualMachines(subscriptionId: string, location: string): Promise<AzureVirtualMachineSummary[]> {
  const allVms = await fetchAzureArmCollection<{
    id?: string
    name?: string
    location?: string
    tags?: Record<string, string>
    properties?: {
      provisioningState?: string
      storageProfile?: { osDisk?: { osType?: string } }
      hardwareProfile?: { vmSize?: string }
      diagnosticsProfile?: { bootDiagnostics?: { enabled?: boolean } }
      networkProfile?: { networkInterfaces?: Array<{ id?: string }> }
    }
    identity?: { type?: string }
  }>(`/subscriptions/${subscriptionId.trim()}/providers/Microsoft.Compute/virtualMachines`, '2023-09-01')

  const normalizedLocation = location.trim().toLowerCase()
  const filtered = normalizedLocation
    ? allVms.filter((vm) => (vm.location?.trim().toLowerCase() ?? '') === normalizedLocation)
    : allVms

  const results = await mapWithConcurrency(filtered, 5, async (vm) => {
    const nicIds = (vm.properties?.networkProfile?.networkInterfaces ?? [])
      .map((item) => item.id?.trim() || '')
      .filter(Boolean)

    const [instanceView, network] = await Promise.all([
      fetchAzureArmJson<{
        statuses?: Array<{ code?: string; displayStatus?: string }>
      }>(`${vm.id}/instanceView`, '2023-09-01').catch((error) => {
        logWarn('azureSdk.listAzureVirtualMachines', `Failed to fetch instanceView for VM ${vm.name ?? vm.id}.`, { vmId: vm.id }, error)
        return null
      }),
      resolveAzureVmNetworkSummary(nicIds)
    ])

    const statuses = instanceView?.statuses ?? []

    return {
      id: vm.id?.trim() || '',
      name: vm.name?.trim() || extractResourceName(vm.id ?? ''),
      resourceGroup: extractResourceGroup(vm.id ?? ''),
      location: vm.location?.trim() || '',
      vmSize: vm.properties?.hardwareProfile?.vmSize?.trim() || '',
      powerState: statuses.length > 0
        ? extractPowerState(statuses)
        : (vm.properties?.provisioningState?.trim() || 'Unknown'),
      provisioningState: statuses.length > 0
        ? extractProvisioningState(statuses, vm.properties?.provisioningState ?? '')
        : (vm.properties?.provisioningState?.trim() || 'Unknown'),
      osType: vm.properties?.storageProfile?.osDisk?.osType?.trim() || '',
      identityType: vm.identity?.type?.trim() || 'None',
      privateIp: network.privateIp,
      publicIp: network.publicIp,
      hasPublicIp: network.hasPublicIp,
      subnetName: network.subnetName,
      networkInterfaceCount: nicIds.length,
      diagnosticsState: vm.properties?.diagnosticsProfile?.bootDiagnostics?.enabled ? 'Boot diagnostics enabled' : 'Boot diagnostics off',
      tagCount: Object.keys(vm.tags ?? {}).length
    } satisfies AzureVirtualMachineSummary
  })

  return results.sort((left, right) => left.name.localeCompare(right.name))
}

export async function describeAzureVirtualMachine(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string
): Promise<AzureVirtualMachineDetail> {
  const vm = await fetchAzureArmJson<{
    id?: string
    name?: string
    location?: string
    zones?: string[]
    tags?: Record<string, string>
    properties?: {
      provisioningState?: string
      storageProfile?: {
        osDisk?: { osType?: string; name?: string; diskSizeGB?: number; managedDisk?: { storageAccountType?: string } }
        dataDisks?: Array<{ name?: string; diskSizeGB?: number; lun?: number; managedDisk?: { storageAccountType?: string } }>
        imageReference?: { publisher?: string; offer?: string; sku?: string; version?: string }
      }
      hardwareProfile?: { vmSize?: string }
      osProfile?: { computerName?: string; adminUsername?: string }
      diagnosticsProfile?: { bootDiagnostics?: { enabled?: boolean } }
      networkProfile?: { networkInterfaces?: Array<{ id?: string }> }
      instanceView?: { statuses?: Array<{ code?: string; displayStatus?: string }> }
    }
    identity?: { type?: string }
  }>(
    `/subscriptions/${subscriptionId.trim()}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(vmName)}?$expand=instanceView`,
    '2023-09-01'
  )

  const nicIds = (vm.properties?.networkProfile?.networkInterfaces ?? [])
    .map((item) => item.id?.trim() || '')
    .filter(Boolean)
  const network = await resolveAzureVmNetworkSummary(nicIds)
  const statuses = vm.properties?.instanceView?.statuses ?? []
  const imageRef = vm.properties?.storageProfile?.imageReference
  const imageReference = imageRef
    ? [imageRef.publisher, imageRef.offer, imageRef.sku, imageRef.version].filter(Boolean).join(' / ')
    : ''

  let networkSecurityGroup = ''
  let subnetId = ''
  let vnetName = ''
  if (nicIds[0]) {
    try {
      const nic = await fetchAzureArmJson<{
        properties?: {
          networkSecurityGroup?: { id?: string }
          ipConfigurations?: Array<{ properties?: { subnet?: { id?: string } } }>
        }
      }>(nicIds[0], '2024-05-01')
      networkSecurityGroup = extractResourceName(nic.properties?.networkSecurityGroup?.id ?? '')
      subnetId = nic.properties?.ipConfigurations?.[0]?.properties?.subnet?.id?.trim() || ''
      const vnetMatch = subnetId.match(/\/virtualNetworks\/([^/]+)/i)
      vnetName = vnetMatch?.[1] ?? ''
    } catch {
      // Network enrichment is non-critical
    }
  }

  return {
    id: vm.id?.trim() || '',
    name: vm.name?.trim() || '',
    resourceGroup,
    location: vm.location?.trim() || '',
    vmSize: vm.properties?.hardwareProfile?.vmSize?.trim() || '',
    powerState: extractPowerState(statuses),
    provisioningState: extractProvisioningState(statuses, vm.properties?.provisioningState ?? ''),
    osType: vm.properties?.storageProfile?.osDisk?.osType?.trim() || '',
    osDiskName: vm.properties?.storageProfile?.osDisk?.name?.trim() || '',
    osDiskSizeGiB: vm.properties?.storageProfile?.osDisk?.diskSizeGB ?? 0,
    osDiskType: vm.properties?.storageProfile?.osDisk?.managedDisk?.storageAccountType?.trim() || '',
    dataDisks: (vm.properties?.storageProfile?.dataDisks ?? []).map((disk) => ({
      name: disk.name?.trim() || '',
      sizeGiB: disk.diskSizeGB ?? 0,
      lun: disk.lun ?? 0,
      type: disk.managedDisk?.storageAccountType?.trim() || ''
    })),
    identityType: vm.identity?.type?.trim() || 'None',
    privateIp: network.privateIp,
    publicIp: network.publicIp,
    hasPublicIp: network.hasPublicIp,
    subnetName: network.subnetName,
    subnetId,
    vnetName,
    networkInterfaceCount: nicIds.length,
    networkSecurityGroup,
    diagnosticsState: vm.properties?.diagnosticsProfile?.bootDiagnostics?.enabled ? 'Boot diagnostics enabled' : 'Boot diagnostics off',
    tags: vm.tags ?? {},
    imageReference,
    computerName: vm.properties?.osProfile?.computerName?.trim() || '',
    adminUsername: vm.properties?.osProfile?.adminUsername?.trim() || '',
    availabilityZone: (vm.zones ?? [])[0] || '',
    platform: vm.properties?.storageProfile?.osDisk?.osType?.trim() || ''
  } satisfies AzureVirtualMachineDetail
}

export async function runAzureVmAction(
  subscriptionId: string,
  resourceGroup: string,
  vmName: string,
  action: AzureVmAction
): Promise<AzureVmActionResult> {
  const normalizedSub = subscriptionId.trim()
  const normalizedRg = encodeURIComponent(resourceGroup.trim())
  const normalizedVm = encodeURIComponent(vmName.trim())
  const path = `/subscriptions/${normalizedSub}/resourceGroups/${normalizedRg}/providers/Microsoft.Compute/virtualMachines/${normalizedVm}/${action}`
  const url = `https://management.azure.com${path}?api-version=2023-09-01`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getAzureAccessToken()}`,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const body = await response.text()
      return { action, vmName, resourceGroup, accepted: false, error: `${response.status}: ${body || response.statusText}` }
    }

    return { action, vmName, resourceGroup, accepted: true }
  } catch (error) {
    return { action, vmName, resourceGroup, accepted: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function listAksAgentPools(subscriptionId: string, clusterId: string): Promise<{ count: number; nodeCount: number; names: string[] }> {
  const resourceGroup = extractResourceGroup(clusterId)
  const clusterName = extractResourceName(clusterId)

  if (!resourceGroup || !clusterName) {
    return { count: 0, nodeCount: 0, names: [] }
  }

  try {
    const agentPools = await fetchAzureArmCollection<{
      name?: string
      properties?: {
        count?: number
      }
    }>(
      `/subscriptions/${subscriptionId.trim()}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(clusterName)}/agentPools`,
      '2024-02-01'
    )

    return {
      count: agentPools.length,
      nodeCount: agentPools.reduce((total, pool) => total + (pool.properties?.count ?? 0), 0),
      names: agentPools.map((pool) => pool.name?.trim() || '').filter(Boolean)
    }
  } catch (error) {
    logWarn('azureSdk.listAksAgentPools', 'Failed to enumerate AKS agent pools.', { subscriptionId, clusterId }, error)
    return { count: 0, nodeCount: 0, names: [] }
  }
}

export async function listAzureAksClusters(subscriptionId: string, location: string): Promise<AzureAksClusterSummary[]> {
  const allClusters = await fetchAzureArmCollection<{
    id?: string
    name?: string
    location?: string
    properties?: {
      kubernetesVersion?: string
      provisioningState?: string
      powerState?: { code?: string }
      securityProfile?: { workloadIdentity?: { enabled?: boolean } }
      oidcIssuerProfile?: { enabled?: boolean }
      apiServerAccessProfile?: { enablePrivateCluster?: boolean }
      networkProfile?: { networkPlugin?: string }
      addonProfiles?: {
        ingressApplicationGateway?: { enabled?: boolean }
      }
    }
    identity?: { type?: string }
  }>(`/subscriptions/${subscriptionId.trim()}/providers/Microsoft.ContainerService/managedClusters`, '2024-02-01')

  const normalizedLocation = location.trim().toLowerCase()
  const filtered = normalizedLocation
    ? allClusters.filter((cluster) => (cluster.location?.trim().toLowerCase() ?? '') === normalizedLocation)
    : allClusters

  const results = await Promise.all(filtered.map(async (cluster) => {
    const agentPools = await listAksAgentPools(subscriptionId, cluster.id?.trim() || '')

    return {
      id: cluster.id?.trim() || '',
      name: cluster.name?.trim() || extractResourceName(cluster.id ?? ''),
      resourceGroup: extractResourceGroup(cluster.id ?? ''),
      location: cluster.location?.trim() || '',
      kubernetesVersion: cluster.properties?.kubernetesVersion?.trim() || '',
      provisioningState: cluster.properties?.provisioningState?.trim() || '',
      powerState: cluster.properties?.powerState?.code?.trim() || '',
      nodePoolCount: agentPools.count,
      nodeCount: agentPools.nodeCount,
      privateCluster: cluster.properties?.apiServerAccessProfile?.enablePrivateCluster === true,
      identityType: cluster.identity?.type?.trim() || 'None',
      workloadIdentityEnabled: cluster.properties?.securityProfile?.workloadIdentity?.enabled === true,
      oidcIssuerEnabled: cluster.properties?.oidcIssuerProfile?.enabled === true,
      networkPlugin: cluster.properties?.networkProfile?.networkPlugin?.trim() || '',
      ingressProfile: cluster.properties?.addonProfiles?.ingressApplicationGateway?.enabled ? 'App Gateway enabled' : 'Addon not enabled',
      agentPoolNames: agentPools.names,
      notes: agentPools.count === 0 ? ['Agent pool inventory was not visible for this cluster.'] : []
    } satisfies AzureAksClusterSummary
  }))

  return results.sort((left, right) => left.name.localeCompare(right.name))
}

export async function describeAzureAksCluster(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string
): Promise<AzureAksClusterDetail> {
  const raw = await fetchAzureArmJson<{
    name?: string
    location?: string
    tags?: Record<string, string>
    identity?: { type?: string }
    properties?: {
      kubernetesVersion?: string
      provisioningState?: string
      powerState?: { code?: string }
      fqdn?: string
      privateFqdn?: string
      dnsPrefix?: string
      nodeResourceGroup?: string
      enableRBAC?: boolean
      createdAt?: string
      securityProfile?: { workloadIdentity?: { enabled?: boolean } }
      oidcIssuerProfile?: { enabled?: boolean; issuerURL?: string }
      apiServerAccessProfile?: { enablePrivateCluster?: boolean }
      networkProfile?: {
        networkPlugin?: string
        networkPolicy?: string
        serviceCidr?: string
        dnsServiceIP?: string
        podCidr?: string
        loadBalancerSku?: string
        outboundType?: string
      }
      addonProfiles?: {
        omsagent?: { enabled?: boolean }
        azurepolicy?: { enabled?: boolean }
        httpApplicationRouting?: { enabled?: boolean }
      }
      agentPoolProfiles?: Array<{
        count?: number
      }>
    }
  }>(
    `/subscriptions/${subscriptionId.trim()}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(clusterName)}`,
    '2024-02-01'
  )

  const props = raw.properties
  const netProfile = props?.networkProfile

  const loggingEnabled: string[] = []
  if (props?.addonProfiles?.omsagent?.enabled) loggingEnabled.push('omsagent')
  if (props?.addonProfiles?.azurepolicy?.enabled) loggingEnabled.push('azurepolicy')
  if (props?.addonProfiles?.httpApplicationRouting?.enabled) loggingEnabled.push('httpApplicationRouting')

  const agentPools = props?.agentPoolProfiles ?? []
  const nodeCount = agentPools.reduce((total, pool) => total + (pool.count ?? 0), 0)

  return {
    name: raw.name?.trim() || clusterName,
    resourceGroup,
    location: raw.location?.trim() || '',
    kubernetesVersion: props?.kubernetesVersion?.trim() || '-',
    provisioningState: props?.provisioningState?.trim() || '-',
    powerState: props?.powerState?.code?.trim() || '-',
    fqdn: props?.fqdn?.trim() || '-',
    privateFqdn: props?.privateFqdn?.trim() || '-',
    privateCluster: props?.apiServerAccessProfile?.enablePrivateCluster === true,
    identityType: raw.identity?.type?.trim() || 'None',
    workloadIdentityEnabled: props?.securityProfile?.workloadIdentity?.enabled === true,
    oidcIssuerEnabled: props?.oidcIssuerProfile?.enabled === true,
    oidcIssuerUrl: props?.oidcIssuerProfile?.issuerURL?.trim() || '-',
    networkPlugin: netProfile?.networkPlugin?.trim() || '-',
    networkPolicy: netProfile?.networkPolicy?.trim() || '-',
    serviceCidr: netProfile?.serviceCidr?.trim() || '-',
    dnsServiceIp: netProfile?.dnsServiceIP?.trim() || '-',
    podCidr: netProfile?.podCidr?.trim() || '-',
    loadBalancerSku: netProfile?.loadBalancerSku?.trim() || '-',
    outboundType: netProfile?.outboundType?.trim() || '-',
    nodeResourceGroup: props?.nodeResourceGroup?.trim() || '-',
    dnsPrefix: props?.dnsPrefix?.trim() || '-',
    enableRbac: props?.enableRBAC === true,
    createdAt: props?.createdAt?.trim() || '-',
    nodePoolCount: agentPools.length,
    nodeCount,
    tags: raw.tags ?? {},
    loggingEnabled,
    healthIssues: []
  }
}

export async function listAzureAksNodePools(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string
): Promise<AzureAksNodePoolSummary[]> {
  const pools = await fetchAzureArmCollection<{
    name?: string
    properties?: {
      provisioningState?: string
      mode?: string
      vmSize?: string
      osType?: string
      osSKU?: string
      orchestratorVersion?: string
      count?: number
      minCount?: number
      maxCount?: number
      enableAutoScaling?: boolean
      availabilityZones?: string[]
      maxPods?: number
      osDiskSizeGB?: number
      osDiskType?: string
      powerState?: { code?: string }
      nodeLabels?: Record<string, string>
      nodeTaints?: string[]
    }
  }>(
    `/subscriptions/${subscriptionId.trim()}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(clusterName)}/agentPools`,
    '2024-02-01'
  )

  return pools.map((pool) => {
    const props = pool.properties
    const autoScaling = props?.enableAutoScaling === true
    return {
      name: pool.name?.trim() || '-',
      status: props?.provisioningState?.trim() || '-',
      mode: props?.mode?.trim() || 'User',
      vmSize: props?.vmSize?.trim() || '-',
      osType: props?.osType?.trim() || '-',
      osSku: props?.osSKU?.trim() || '-',
      kubernetesVersion: props?.orchestratorVersion?.trim() || '-',
      min: autoScaling ? (props?.minCount ?? '-') : '-',
      desired: props?.count ?? '-',
      max: autoScaling ? (props?.maxCount ?? '-') : '-',
      enableAutoScaling: autoScaling,
      availabilityZones: props?.availabilityZones ?? [],
      maxPods: props?.maxPods ?? 0,
      osDiskSizeGb: props?.osDiskSizeGB ?? 0,
      osDiskType: props?.osDiskType?.trim() || '-',
      powerState: props?.powerState?.code?.trim() || '-',
      nodeLabels: props?.nodeLabels ?? {},
      nodeTaints: props?.nodeTaints ?? []
    } satisfies AzureAksNodePoolSummary
  }).sort((left, right) => left.name.localeCompare(right.name))
}

export async function updateAzureAksNodePoolScaling(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  nodePoolName: string,
  min: number,
  desired: number,
  max: number
): Promise<void> {
  const poolPath = `/subscriptions/${subscriptionId.trim()}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(clusterName)}/agentPools/${encodeURIComponent(nodePoolName)}`

  const pool = await fetchAzureArmJson<Record<string, unknown> & {
    properties?: Record<string, unknown> & { enableAutoScaling?: boolean }
  }>(poolPath, '2024-02-01')

  const autoScaling = pool.properties?.enableAutoScaling === true

  const updatedProperties = autoScaling
    ? { ...pool.properties, count: desired, minCount: min, maxCount: max, enableAutoScaling: true }
    : { ...pool.properties, count: desired }

  await fetchAzureArmJson(
    poolPath,
    '2024-02-01',
    { method: 'PUT', body: JSON.stringify({ ...pool, properties: updatedProperties }) }
  )
}

export async function toggleAzureAksNodePoolAutoscaling(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  nodePoolName: string,
  enable: boolean,
  minCount?: number,
  maxCount?: number
): Promise<void> {
  const poolPath = `/subscriptions/${subscriptionId.trim()}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(clusterName)}/agentPools/${encodeURIComponent(nodePoolName)}`

  const pool = await fetchAzureArmJson<Record<string, unknown> & {
    properties?: Record<string, unknown> & { enableAutoScaling?: boolean; count?: number }
  }>(poolPath, '2024-02-01')

  let updatedProperties: Record<string, unknown>
  if (enable) {
    if (minCount == null || maxCount == null) throw new Error('minCount and maxCount are required when enabling autoscaling')
    updatedProperties = { ...pool.properties, enableAutoScaling: true, minCount, maxCount }
  } else {
    updatedProperties = { ...pool.properties, enableAutoScaling: false }
    delete updatedProperties.minCount
    delete updatedProperties.maxCount
  }

  await fetchAzureArmJson(
    poolPath,
    '2024-02-01',
    { method: 'PUT', body: JSON.stringify({ ...pool, properties: updatedProperties }) }
  )
}

export async function addAksToKubeconfig(
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  contextName: string,
  kubeconfigPath: string
): Promise<string> {
  const normalizedContextName = contextName.trim()
  const targetKubeconfigPath = resolveKubeconfigPath(kubeconfigPath)
  await mkdir(dirname(targetKubeconfigPath), { recursive: true })

  const cliPath = await loadAzureCliPath()
  const resolved = cliPath || (process.platform === 'win32' ? 'az.cmd' : 'az')
  const fullArgs = [
    'aks', 'get-credentials',
    '-g', resourceGroup,
    '-n', clusterName,
    '--subscription', subscriptionId,
    '--context', normalizedContextName,
    '--file', targetKubeconfigPath,
    '--overwrite-existing'
  ]

  const [command, execArgs] = isWindowsBatchFile(resolved)
    ? ['cmd.exe', ['/d', '/c', resolved, ...fullArgs]]
    : [resolved, fullArgs]

  const { stdout, stderr } = await execFileAsync(command, execArgs, {
    windowsHide: true,
    timeout: 20000,
    env: process.env
  })
  return (stdout || stderr).trim()
}

export async function listAzureStorageAccounts(subscriptionId: string, location: string): Promise<AzureStorageAccountSummary[]> {
  const accounts = await fetchAzureArmCollection<{
    id?: string
    name?: string
    location?: string
    kind?: string
    sku?: { name?: string }
    tags?: Record<string, string>
    properties?: {
      accessTier?: string
      publicNetworkAccess?: string
      minimumTlsVersion?: string
      allowBlobPublicAccess?: boolean
      allowSharedKeyAccess?: boolean
      supportsHttpsTrafficOnly?: boolean
      networkAcls?: {
        defaultAction?: string
      }
      primaryEndpoints?: {
        blob?: string
      }
    }
  }>(`/subscriptions/${subscriptionId.trim()}/providers/Microsoft.Storage/storageAccounts`, '2024-01-01')

  const filteredAccounts = normalizeRegion(
    accounts.map((account) => ({
      id: account.id?.trim() || '',
      name: account.name?.trim() || extractResourceName(account.id ?? ''),
      resourceGroup: extractResourceGroup(account.id ?? ''),
      location: account.location?.trim() || '',
      kind: account.kind?.trim() || '',
      skuName: account.sku?.name?.trim() || '',
      accessTier: account.properties?.accessTier?.trim() || '',
      publicNetworkAccess: account.properties?.publicNetworkAccess?.trim() || 'Enabled',
      defaultNetworkAction: account.properties?.networkAcls?.defaultAction?.trim() || 'Allow',
      minimumTlsVersion: account.properties?.minimumTlsVersion?.trim() || 'TLS1_0',
      allowBlobPublicAccess: account.properties?.allowBlobPublicAccess === true,
      allowSharedKeyAccess: account.properties?.allowSharedKeyAccess !== false,
      httpsOnly: account.properties?.supportsHttpsTrafficOnly !== false,
      primaryBlobEndpoint: account.properties?.primaryEndpoints?.blob?.trim() || '',
      tagCount: Object.keys(account.tags ?? {}).length
    })),
    location
  )

  const results = await Promise.all(filteredAccounts.map(async (account) => {
    try {
      const serviceProperties = await fetchAzureArmJson<{
        properties?: {
          isVersioningEnabled?: boolean
          changeFeed?: { enabled?: boolean }
          deleteRetentionPolicy?: { enabled?: boolean; days?: number }
          containerDeleteRetentionPolicy?: { enabled?: boolean; days?: number }
        }
      }>(
        `/subscriptions/${encodeURIComponent(subscriptionId.trim())}/resourceGroups/${encodeURIComponent(account.resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(account.name)}/blobServices/default`,
        '2024-01-01'
      )

      const notes: string[] = []
      if (account.publicNetworkAccess.toLowerCase() === 'enabled' && account.defaultNetworkAction.toLowerCase() === 'allow') {
        notes.push('Public network access is enabled with allow-by-default network rules.')
      }
      if (!account.httpsOnly) {
        notes.push('HTTPS-only traffic enforcement is disabled.')
      }
      if (account.allowBlobPublicAccess) {
        notes.push('Blob public access is allowed on this account.')
      }
      if (!account.allowSharedKeyAccess) {
        notes.push('Shared key access is disabled; data-plane mutations may require alternate auth paths.')
      }

      return {
        ...account,
        versioningEnabled: serviceProperties.properties?.isVersioningEnabled === true,
        changeFeedEnabled: serviceProperties.properties?.changeFeed?.enabled === true,
        blobDeleteRetentionDays: serviceProperties.properties?.deleteRetentionPolicy?.enabled
          ? serviceProperties.properties?.deleteRetentionPolicy?.days ?? 0
          : 0,
        containerDeleteRetentionDays: serviceProperties.properties?.containerDeleteRetentionPolicy?.enabled
          ? serviceProperties.properties?.containerDeleteRetentionPolicy?.days ?? 0
          : 0,
        containerCount: 0,
        notes
      } satisfies AzureStorageAccountSummary
    } catch (error) {
      logWarn('azureSdk.listAzureStorageAccounts', 'Failed to load blob service properties for Azure storage account.', { account: account.name }, error)
      return {
        ...account,
        versioningEnabled: false,
        changeFeedEnabled: false,
        blobDeleteRetentionDays: 0,
        containerDeleteRetentionDays: 0,
        containerCount: 0,
        notes: ['Blob service properties were not fully visible for this account.']
      } satisfies AzureStorageAccountSummary
    }
  }))

  return results.sort((left, right) => left.name.localeCompare(right.name))
}

export async function listAzureStorageContainers(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  blobEndpoint = ''
): Promise<AzureStorageContainerSummary[]> {
  try {
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    const iterator = serviceClient.listContainers({ includeMetadata: true })
    const basicContainers = []
    for await (const container of iterator) {
      basicContainers.push(container)
    }

    const results = await Promise.all(basicContainers.map(async (container) => {
      const containerClient = serviceClient.getContainerClient(container.name)
      const properties = await containerClient.getProperties()

      return {
        name: container.name,
        publicAccess: properties.blobPublicAccess?.trim() || 'private',
        metadataCount: Object.keys(container.metadata ?? {}).length,
        leaseStatus: properties.leaseStatus?.trim() || 'unlocked',
        lastModified: properties.lastModified?.toISOString() || '',
        hasImmutabilityPolicy: properties.hasImmutabilityPolicy === true,
        hasLegalHold: properties.hasLegalHold === true,
        defaultEncryptionScope: properties.defaultEncryptionScope?.trim() || '',
        denyEncryptionScopeOverride: properties.denyEncryptionScopeOverride === true
      } satisfies AzureStorageContainerSummary
    }))

    return results.sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    throw new Error(`Failed to list Azure storage containers for "${accountName}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function listAzureStorageBlobs(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  prefix = '',
  blobEndpoint = ''
): Promise<AzureStorageBlobSummary[]> {
  try {
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    const containerClient = serviceClient.getContainerClient(containerName.trim())
    const iterator = containerClient.listBlobsByHierarchy('/', { prefix: prefix.trim() || undefined })
    const items: AzureStorageBlobSummary[] = []

    for await (const item of iterator) {
      if (item.kind === 'prefix') {
        items.push({
          key: item.name,
          size: 0,
          lastModified: '',
          contentType: '',
          accessTier: '',
          isFolder: true
        })
        continue
      }

      items.push({
        key: item.name,
        size: item.properties.contentLength ?? 0,
        lastModified: item.properties.lastModified?.toISOString() || '',
        contentType: item.properties.contentType?.trim() || guessContentTypeFromKey(item.name),
        accessTier: item.properties.accessTier?.toString().trim() || '',
        isFolder: false
      })
    }

    return items.sort((left, right) => {
      if (left.isFolder !== right.isFolder) {
        return left.isFolder ? -1 : 1
      }

      return left.key.localeCompare(right.key)
    })
  } catch (error) {
    throw new Error(`Failed to list Azure storage blobs for "${accountName}/${containerName}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function getAzureStorageBlobContent(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  blobEndpoint = ''
): Promise<AzureStorageBlobContent> {
  try {
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    const blobClient = serviceClient.getContainerClient(containerName.trim()).getBlobClient(key.trim())
    const [properties, download] = await Promise.all([
      blobClient.getProperties(),
      blobClient.download()
    ])

    return {
      body: (await streamToBuffer(download.readableStreamBody)).toString('utf8'),
      contentType: properties.contentType?.trim() || guessContentTypeFromKey(key)
    }
  } catch (error) {
    throw new Error(`Failed to read Azure blob "${key}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function putAzureStorageBlobContent(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  content: string,
  blobEndpoint = ''
): Promise<void> {
  try {
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    const blockBlobClient = serviceClient.getContainerClient(containerName.trim()).getBlockBlobClient(key.trim())
    await blockBlobClient.uploadData(Buffer.from(content, 'utf8'), {
      blobHTTPHeaders: {
        blobContentType: guessContentTypeFromKey(key)
      }
    })
  } catch (error) {
    throw new Error(`Failed to write Azure blob "${key}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function uploadAzureStorageBlob(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  localPath: string,
  blobEndpoint = ''
): Promise<void> {
  try {
    const body = await readFile(localPath.trim())
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    const blockBlobClient = serviceClient.getContainerClient(containerName.trim()).getBlockBlobClient(key.trim())
    await blockBlobClient.uploadData(body, {
      blobHTTPHeaders: {
        blobContentType: guessContentTypeFromKey(key || localPath)
      }
    })
  } catch (error) {
    throw new Error(`Failed to upload Azure blob "${key}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function downloadAzureStorageBlobToPath(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  blobEndpoint = ''
): Promise<string> {
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(owner, {
    defaultPath: basename(key.trim()) || 'download',
    title: 'Save Azure Blob'
  })

  if (result.canceled || !result.filePath) {
    return ''
  }

  try {
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    const blobClient = serviceClient.getContainerClient(containerName.trim()).getBlobClient(key.trim())
    const download = await blobClient.download()
    await writeFile(result.filePath, await streamToBuffer(download.readableStreamBody))
    return result.filePath
  } catch (error) {
    throw new Error(`Failed to download Azure blob "${key}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function deleteAzureStorageBlob(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  blobEndpoint = ''
): Promise<void> {
  try {
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    await serviceClient.getContainerClient(containerName.trim()).deleteBlob(key.trim())
  } catch (error) {
    throw new Error(`Failed to delete Azure blob "${key}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function createAzureStorageContainer(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  blobEndpoint = ''
): Promise<void> {
  try {
    const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
    await serviceClient.getContainerClient(containerName.trim()).create({ access: undefined })
  } catch (error) {
    throw new Error(`Failed to create Azure container "${containerName}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function downloadAzureStorageBlobToTemp(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  blobEndpoint = ''
): Promise<string> {
  const serviceClient = await getAzureBlobServiceClient(subscriptionId, resourceGroup, accountName, blobEndpoint)
  const blobClient = serviceClient.getContainerClient(containerName.trim()).getBlobClient(key.trim())
  const download = await blobClient.download()

  const fileName = basename(key.split('/').pop() || 'download').replace(/\.\./g, '_')
  const tempDir = app.getPath('temp')
  const filePath = join(tempDir, `azure-blob-${Date.now()}-${fileName}`)

  const buf = await streamToBuffer(download.readableStreamBody)
  await writeFile(filePath, buf, { mode: 0o600 })
  return filePath
}

export async function openAzureStorageBlob(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  blobEndpoint = ''
): Promise<string> {
  try {
    const filePath = await downloadAzureStorageBlobToTemp(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)
    void shell.openPath(filePath)
    return filePath
  } catch (error) {
    throw new Error(`Failed to open Azure blob "${key}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

const azureBlobWatchedFiles = new Set<string>()

export async function openAzureStorageBlobInVSCode(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  blobEndpoint = ''
): Promise<string> {
  try {
    const filePath = await downloadAzureStorageBlobToTemp(subscriptionId, resourceGroup, accountName, containerName, key, blobEndpoint)
    void shell.openExternal(`vscode://file/${encodeURI(filePath)}`)

    if (azureBlobWatchedFiles.has(filePath)) {
      unwatchFile(filePath)
    }

    let uploading = false
    watchFile(filePath, { interval: 1000 }, async (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs || uploading) return
      uploading = true
      try {
        await uploadAzureStorageBlob(subscriptionId, resourceGroup, accountName, containerName, key, filePath, blobEndpoint)
      } catch {
        unwatchFile(filePath)
        azureBlobWatchedFiles.delete(filePath)
      } finally {
        uploading = false
      }
    })

    azureBlobWatchedFiles.add(filePath)

    app.once('before-quit', () => {
      unwatchFile(filePath)
      azureBlobWatchedFiles.delete(filePath)
    })

    return filePath
  } catch (error) {
    throw new Error(`Failed to open Azure blob "${key}" in VSCode: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function generateAzureStorageBlobSasUrl(
  subscriptionId: string,
  resourceGroup: string,
  accountName: string,
  containerName: string,
  key: string,
  blobEndpoint = '',
  expiresInSeconds = 3600
): Promise<string> {
  try {
    const storageKey = await getAzureStorageAccountKey(subscriptionId, resourceGroup, accountName)
    const credential = new StorageSharedKeyCredential(accountName.trim(), storageKey)
    const endpoint = blobEndpoint.trim() || `https://${accountName.trim()}.blob.core.windows.net`

    const startsOn = new Date()
    const expiresOn = new Date(startsOn.getTime() + expiresInSeconds * 1000)

    const sasToken = generateBlobSASQueryParameters({
      containerName: containerName.trim(),
      blobName: key.trim(),
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn
    }, credential).toString()

    return `${endpoint}/${containerName.trim()}/${key.trim()}?${sasToken}`
  } catch (error) {
    throw new Error(`Failed to generate SAS URL for Azure blob "${key}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function listAzureSqlEstate(subscriptionId: string, location: string): Promise<AzureSqlEstateOverview> {
  const servers = await fetchAzureArmCollection<{
    id?: string
    name?: string
    location?: string
    tags?: Record<string, string>
    properties?: {
      version?: string
      fullyQualifiedDomainName?: string
      publicNetworkAccess?: string
      minimalTlsVersion?: string
      administrators?: { administratorType?: string }
      restrictOutboundNetworkAccess?: string
    }
  }>(`/subscriptions/${subscriptionId.trim()}/providers/Microsoft.Sql/servers`, '2023-08-01-preview')

  const filteredServers = normalizeRegion(
    servers.map((server) => ({
      id: server.id?.trim() || '',
      name: server.name?.trim() || extractResourceName(server.id ?? ''),
      resourceGroup: extractResourceGroup(server.id ?? ''),
      location: server.location?.trim() || '',
      version: server.properties?.version?.trim() || '',
      fullyQualifiedDomainName: server.properties?.fullyQualifiedDomainName?.trim() || '',
      publicNetworkAccess: server.properties?.publicNetworkAccess?.trim() || 'Enabled',
      minimalTlsVersion: server.properties?.minimalTlsVersion?.trim() || '',
      administratorType: server.properties?.administrators?.administratorType?.trim() || '',
      outboundNetworkRestriction: server.properties?.restrictOutboundNetworkAccess?.trim() || '',
      tagCount: Object.keys(server.tags ?? {}).length
    })),
    location
  )

  const serverDetails = await Promise.all(filteredServers.map(async (server) => {
    const [databases, elasticPools] = await Promise.all([
      fetchAzureArmCollection<{
        id?: string
        name?: string
        location?: string
        sku?: { name?: string; tier?: string }
        properties?: {
          status?: string
          maxSizeBytes?: number
          zoneRedundant?: boolean
          readScale?: string
          autoPauseDelay?: number
          requestedBackupStorageRedundancy?: string
        }
      }>(`/subscriptions/${encodeURIComponent(subscriptionId.trim())}/resourceGroups/${encodeURIComponent(server.resourceGroup)}/providers/Microsoft.Sql/servers/${encodeURIComponent(server.name)}/databases`, '2023-08-01-preview'),
      fetchAzureArmCollection<unknown>(`/subscriptions/${encodeURIComponent(subscriptionId.trim())}/resourceGroups/${encodeURIComponent(server.resourceGroup)}/providers/Microsoft.Sql/servers/${encodeURIComponent(server.name)}/elasticPools`, '2023-08-01-preview')
    ])

    const mappedDatabases = databases
      .filter((database) => (database.name?.trim().toLowerCase() ?? '') !== 'master')
      .map((database) => ({
        id: database.id?.trim() || '',
        name: database.name?.trim() || '',
        serverName: server.name,
        resourceGroup: server.resourceGroup,
        location: database.location?.trim() || server.location,
        status: database.properties?.status?.trim() || '',
        skuName: database.sku?.name?.trim() || '',
        edition: database.sku?.tier?.trim() || '',
        maxSizeGb: database.properties?.maxSizeBytes ? Number((database.properties.maxSizeBytes / (1024 ** 3)).toFixed(1)) : 0,
        zoneRedundant: database.properties?.zoneRedundant === true,
        readScale: database.properties?.readScale?.trim() || '',
        autoPauseDelayMinutes: database.properties?.autoPauseDelay ?? 0,
        backupStorageRedundancy: database.properties?.requestedBackupStorageRedundancy?.trim() || ''
      } satisfies AzureSqlDatabaseSummary))

    const notes: string[] = []
    if (server.publicNetworkAccess.toLowerCase() === 'enabled') {
      notes.push('Public network access is enabled for this SQL server.')
    }
    if ((server.minimalTlsVersion || '').toUpperCase() && (server.minimalTlsVersion || '').toUpperCase() !== '1.2') {
      notes.push(`Minimal TLS version is ${server.minimalTlsVersion}.`)
    }

    return {
      server: {
        ...server,
        databaseCount: mappedDatabases.length,
        elasticPoolCount: elasticPools.length,
        notes
      } satisfies AzureSqlServerSummary,
      databases: mappedDatabases
    }
  }))

  const mappedServers = serverDetails.map((entry) => entry.server).sort((left, right) => left.name.localeCompare(right.name))
  const mappedDatabases = serverDetails.flatMap((entry) => entry.databases).sort((left, right) => left.name.localeCompare(right.name))

  return {
    subscriptionId,
    serverCount: mappedServers.length,
    databaseCount: mappedDatabases.length,
    publicServerCount: mappedServers.filter((server) => server.publicNetworkAccess.toLowerCase() === 'enabled').length,
    servers: mappedServers,
    databases: mappedDatabases,
    notes: mappedServers.length === 0
      ? [
          'No Azure SQL servers were visible for the selected subscription and region.',
          'If servers exist in the Azure Portal, verify that the Microsoft.Sql resource provider is registered on this subscription and that your identity has Reader access to SQL Server resources.'
        ]
      : []
  }
}

export async function describeAzureSqlServer(subscriptionId: string, resourceGroup: string, serverName: string): Promise<AzureSqlServerDetail> {
  const basePath = `/subscriptions/${encodeURIComponent(subscriptionId.trim())}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Sql/servers/${encodeURIComponent(serverName)}`

  const [serverRaw, databases, firewallRulesRaw, elasticPools] = await Promise.all([
    fetchAzureArmJson<{
      id?: string
      name?: string
      location?: string
      tags?: Record<string, string>
      properties?: {
        version?: string
        fullyQualifiedDomainName?: string
        publicNetworkAccess?: string
        minimalTlsVersion?: string
        administrators?: { administratorType?: string }
        restrictOutboundNetworkAccess?: string
      }
    }>(basePath, '2023-08-01-preview'),
    fetchAzureArmCollection<{
      id?: string
      name?: string
      location?: string
      sku?: { name?: string; tier?: string }
      properties?: {
        status?: string
        maxSizeBytes?: number
        zoneRedundant?: boolean
        readScale?: string
        autoPauseDelay?: number
        requestedBackupStorageRedundancy?: string
      }
    }>(`${basePath}/databases`, '2023-08-01-preview'),
    fetchAzureArmCollection<{
      id?: string
      name?: string
      properties?: { startIpAddress?: string; endIpAddress?: string }
    }>(`${basePath}/firewallRules`, '2023-08-01-preview'),
    fetchAzureArmCollection<unknown>(`${basePath}/elasticPools`, '2023-08-01-preview')
  ])

  const server: AzureSqlServerSummary = {
    id: serverRaw.id?.trim() || '',
    name: serverRaw.name?.trim() || serverName,
    resourceGroup,
    location: serverRaw.location?.trim() || '',
    version: serverRaw.properties?.version?.trim() || '',
    fullyQualifiedDomainName: serverRaw.properties?.fullyQualifiedDomainName?.trim() || '',
    publicNetworkAccess: serverRaw.properties?.publicNetworkAccess?.trim() || 'Enabled',
    minimalTlsVersion: serverRaw.properties?.minimalTlsVersion?.trim() || '',
    administratorType: serverRaw.properties?.administrators?.administratorType?.trim() || '',
    outboundNetworkRestriction: serverRaw.properties?.restrictOutboundNetworkAccess?.trim() || '',
    databaseCount: 0,
    elasticPoolCount: elasticPools.length,
    tagCount: Object.keys(serverRaw.tags ?? {}).length,
    notes: []
  }

  const mappedDatabases: AzureSqlDatabaseSummary[] = databases
    .filter((db) => (db.name?.trim().toLowerCase() ?? '') !== 'master')
    .map((db) => ({
      id: db.id?.trim() || '',
      name: db.name?.trim() || '',
      serverName: server.name,
      resourceGroup,
      location: db.location?.trim() || server.location,
      status: db.properties?.status?.trim() || '',
      skuName: db.sku?.name?.trim() || '',
      edition: db.sku?.tier?.trim() || '',
      maxSizeGb: db.properties?.maxSizeBytes ? Number((db.properties.maxSizeBytes / (1024 ** 3)).toFixed(1)) : 0,
      zoneRedundant: db.properties?.zoneRedundant === true,
      readScale: db.properties?.readScale?.trim() || '',
      autoPauseDelayMinutes: db.properties?.autoPauseDelay ?? 0,
      backupStorageRedundancy: db.properties?.requestedBackupStorageRedundancy?.trim() || ''
    } satisfies AzureSqlDatabaseSummary))

  server.databaseCount = mappedDatabases.length

  const firewallRules: AzureSqlFirewallRule[] = firewallRulesRaw.map((rule) => ({
    name: rule.name?.trim() || '',
    startIpAddress: rule.properties?.startIpAddress?.trim() || '',
    endIpAddress: rule.properties?.endIpAddress?.trim() || ''
  }))

  const isPublic = server.publicNetworkAccess.toLowerCase() === 'enabled'
  const hasWeakTls = !!server.minimalTlsVersion && server.minimalTlsVersion !== '1.2'
  const noTlsMin = !server.minimalTlsVersion
  const hasAadAdmin = !!server.administratorType && server.administratorType.toLowerCase().includes('activedirectory')
  const outboundRestricted = server.outboundNetworkRestriction.toLowerCase() === 'enabled'
  const hasAllowAllRule = firewallRules.some((r) => r.startIpAddress === '0.0.0.0' && r.endIpAddress === '255.255.255.255')
  const hasAllowAzureRule = firewallRules.some((r) => r.startIpAddress === '0.0.0.0' && r.endIpAddress === '0.0.0.0')
  const zoneRedundantCount = mappedDatabases.filter((db) => db.zoneRedundant).length
  const onlineCount = mappedDatabases.filter((db) => db.status.toLowerCase() === 'online').length

  const badges: AzureSqlPostureBadge[] = [
    { id: 'public-access', label: 'Public Access', value: isPublic ? 'Enabled' : 'Disabled', tone: isPublic ? 'risk' : 'good' },
    { id: 'tls', label: 'Min TLS', value: server.minimalTlsVersion || 'Not set', tone: noTlsMin || hasWeakTls ? 'warning' : 'good' },
    { id: 'aad-admin', label: 'AAD Admin', value: hasAadAdmin ? 'Configured' : 'Local only', tone: hasAadAdmin ? 'good' : 'warning' },
    { id: 'outbound', label: 'Outbound', value: outboundRestricted ? 'Restricted' : 'Unrestricted', tone: outboundRestricted ? 'good' : 'info' },
    { id: 'firewall', label: 'Firewall Rules', value: `${firewallRules.length} rules`, tone: hasAllowAllRule ? 'risk' : firewallRules.length === 0 ? 'good' : 'info' }
  ]

  const findings: AzureSqlFinding[] = []
  const recommendations: string[] = []

  if (isPublic) {
    findings.push({ id: 'public-access', severity: 'risk', title: 'Public network access enabled', message: 'This SQL server accepts connections from public IP addresses.', recommendation: 'Disable public network access and use private endpoints for production workloads.' })
    recommendations.push('Disable public network access and use private endpoints for production workloads.')
  }

  if (hasWeakTls) {
    findings.push({ id: 'weak-tls', severity: 'warning', title: `Minimum TLS version is ${server.minimalTlsVersion}`, message: 'The server permits connections using deprecated TLS versions.', recommendation: 'Set the minimum TLS version to 1.2 to enforce modern transport security.' })
    recommendations.push('Set the minimum TLS version to 1.2 to enforce modern transport security.')
  }

  if (noTlsMin) {
    findings.push({ id: 'no-tls-min', severity: 'info', title: 'No minimum TLS version configured', message: 'The server does not enforce a minimum TLS version.', recommendation: 'Explicitly set the minimum TLS version to 1.2.' })
    recommendations.push('Explicitly set the minimum TLS version to 1.2.')
  }

  if (!hasAadAdmin) {
    findings.push({ id: 'no-aad', severity: 'warning', title: 'No Azure AD administrator', message: 'The server uses only SQL authentication without AAD integration.', recommendation: 'Configure an Azure AD administrator for centralized identity management.' })
    recommendations.push('Configure an Azure AD administrator for centralized identity management.')
  }

  if (hasAllowAllRule) {
    findings.push({ id: 'allow-all-firewall', severity: 'risk', title: 'Firewall allows all IP addresses', message: 'A firewall rule permits connections from the entire internet (0.0.0.0 - 255.255.255.255).', recommendation: 'Remove the allow-all firewall rule and restrict to specific IP ranges.' })
    recommendations.push('Remove the allow-all firewall rule and restrict to specific IP ranges.')
  }

  if (hasAllowAzureRule) {
    findings.push({ id: 'allow-azure-services', severity: 'info', title: 'Azure services access allowed', message: 'A special rule allows all Azure services to connect to this server.', recommendation: 'Review whether all Azure services need access or if private endpoints are preferred.' })
    recommendations.push('Review whether all Azure services need access or if private endpoints are preferred.')
  }

  if (recommendations.length === 0) {
    recommendations.push('No immediate operational posture warnings detected. Continue reviewing firewall and access settings during routine checks.')
  }

  const summaryTiles: AzureSqlSummaryTile[] = [
    { id: 'findings', label: 'Findings', value: String(findings.length), tone: findings.some((f) => f.severity === 'risk') ? 'risk' : findings.length ? 'warning' : 'good' },
    { id: 'databases', label: 'Databases', value: `${onlineCount}/${mappedDatabases.length} online`, tone: onlineCount === mappedDatabases.length ? 'good' : 'warning' },
    { id: 'firewall', label: 'Firewall', value: `${firewallRules.length} rules`, tone: hasAllowAllRule ? 'risk' : 'info' },
    { id: 'zone-redundant', label: 'Zone Redundant', value: `${zoneRedundantCount}/${mappedDatabases.length}`, tone: zoneRedundantCount === mappedDatabases.length && mappedDatabases.length > 0 ? 'good' : zoneRedundantCount > 0 ? 'info' : 'neutral' }
  ]

  if (isPublic) server.notes.push('Public network access is enabled for this SQL server.')
  if (hasWeakTls) server.notes.push(`Minimal TLS version is ${server.minimalTlsVersion}.`)

  return {
    server,
    databases: mappedDatabases,
    firewallRules,
    badges,
    summaryTiles,
    findings,
    recommendations,
    connectionDetails: [
      { label: 'FQDN', value: server.fullyQualifiedDomainName || 'N/A' },
      { label: 'Server name', value: server.name },
      { label: 'Resource group', value: server.resourceGroup },
      { label: 'SQL version', value: server.version || 'N/A' },
      { label: 'Port', value: '1433' },
      { label: 'Administrator', value: server.administratorType || 'SQL Authentication' },
      { label: 'Elastic pools', value: String(server.elasticPoolCount) },
      { label: 'Tags', value: String(server.tagCount) }
    ]
  }
}

export async function listAzurePostgreSqlEstate(subscriptionId: string, location: string): Promise<AzurePostgreSqlEstateOverview> {
  const servers = await fetchAzureArmCollection<{
    id?: string
    name?: string
    location?: string
    tags?: Record<string, string>
    sku?: { name?: string; tier?: string }
    properties?: {
      version?: string
      fullyQualifiedDomainName?: string
      network?: { publicNetworkAccess?: string }
      state?: string
      storage?: { storageSizeGB?: number }
      highAvailability?: { mode?: string; state?: string }
      backup?: { backupRetentionDays?: number; geoRedundantBackup?: string }
      availabilityZone?: string
    }
  }>(`/subscriptions/${subscriptionId.trim()}/providers/Microsoft.DBforPostgreSQL/flexibleServers`, '2022-12-01')

  logInfo('azureSdk.listAzurePostgreSqlEstate', `ARM returned ${servers.length} server(s) before region filter.`, {
    subscriptionId,
    location,
    serverLocations: servers.map((s) => s.location ?? '(null)').join(', ') || '(none)'
  })

  const filteredServers = normalizeRegion(
    servers.map((server) => ({
      id: server.id?.trim() || '',
      name: server.name?.trim() || extractResourceName(server.id ?? ''),
      resourceGroup: extractResourceGroup(server.id ?? ''),
      location: server.location?.trim() || '',
      version: server.properties?.version?.trim() || '',
      fullyQualifiedDomainName: server.properties?.fullyQualifiedDomainName?.trim() || '',
      publicNetworkAccess: server.properties?.network?.publicNetworkAccess?.trim() || 'Disabled',
      state: server.properties?.state?.trim() || '',
      skuName: server.sku?.name?.trim() || '',
      skuTier: server.sku?.tier?.trim() || '',
      storageSizeGb: server.properties?.storage?.storageSizeGB ?? 0,
      haEnabled: (server.properties?.highAvailability?.mode ?? '').toLowerCase() !== 'disabled' && (server.properties?.highAvailability?.mode ?? '') !== '',
      haState: server.properties?.highAvailability?.state?.trim() || '',
      backupRetentionDays: server.properties?.backup?.backupRetentionDays ?? 7,
      geoRedundantBackup: (server.properties?.backup?.geoRedundantBackup ?? '').toLowerCase() === 'enabled',
      availabilityZone: server.properties?.availabilityZone?.trim() || '',
      databaseCount: 0,
      tagCount: Object.keys(server.tags ?? {}).length,
      notes: [] as string[]
    })),
    location
  )

  const serverDetails = await Promise.all(filteredServers.map(async (server) => {
    const databases = await fetchAzureArmCollection<{
      id?: string
      name?: string
      properties?: { charset?: string; collation?: string }
    }>(`/subscriptions/${encodeURIComponent(subscriptionId.trim())}/resourceGroups/${encodeURIComponent(server.resourceGroup)}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${encodeURIComponent(server.name)}/databases`, '2022-12-01')

    const mappedDatabases = databases
      .filter((db) => !['azure_maintenance', 'azure_sys'].includes(db.name?.trim().toLowerCase() ?? ''))
      .map((db) => ({
        id: db.id?.trim() || '',
        name: db.name?.trim() || '',
        serverName: server.name,
        resourceGroup: server.resourceGroup,
        charset: db.properties?.charset?.trim() || '',
        collation: db.properties?.collation?.trim() || ''
      } satisfies AzurePostgreSqlDatabaseSummary))

    return {
      server: { ...server, databaseCount: mappedDatabases.length },
      databases: mappedDatabases
    }
  }))

  const mappedServers = serverDetails.map((e) => e.server).sort((a, b) => a.name.localeCompare(b.name))
  const mappedDatabases = serverDetails.flatMap((e) => e.databases).sort((a, b) => a.name.localeCompare(b.name))

  return {
    subscriptionId,
    serverCount: mappedServers.length,
    databaseCount: mappedDatabases.length,
    publicServerCount: mappedServers.filter((s) => s.publicNetworkAccess.toLowerCase() === 'enabled').length,
    servers: mappedServers,
    databases: mappedDatabases,
    notes: mappedServers.length === 0
      ? [
          'No PostgreSQL Flexible Servers were visible for the selected subscription and region.',
          'If servers exist in the Azure Portal, verify that the Microsoft.DBforPostgreSQL resource provider is registered on this subscription and that your identity has Reader access to Flexible Server resources.'
        ]
      : []
  }
}

export async function describeAzurePostgreSqlServer(subscriptionId: string, resourceGroup: string, serverName: string): Promise<AzurePostgreSqlServerDetail> {
  const basePath = `/subscriptions/${encodeURIComponent(subscriptionId.trim())}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${encodeURIComponent(serverName)}`

  const [serverRaw, databases, firewallRulesRaw] = await Promise.all([
    fetchAzureArmJson<{
      id?: string
      name?: string
      location?: string
      tags?: Record<string, string>
      sku?: { name?: string; tier?: string }
      properties?: {
        version?: string
        fullyQualifiedDomainName?: string
        network?: { publicNetworkAccess?: string }
        state?: string
        storage?: { storageSizeGB?: number }
        highAvailability?: { mode?: string; state?: string }
        backup?: { backupRetentionDays?: number; geoRedundantBackup?: string }
        availabilityZone?: string
        administratorLogin?: string
        authConfig?: { activeDirectoryAuth?: string; passwordAuth?: string }
        minorVersion?: string
      }
    }>(basePath, '2022-12-01'),
    fetchAzureArmCollection<{
      id?: string
      name?: string
      properties?: { charset?: string; collation?: string }
    }>(`${basePath}/databases`, '2022-12-01'),
    fetchAzureArmCollection<{
      id?: string
      name?: string
      properties?: { startIpAddress?: string; endIpAddress?: string }
    }>(`${basePath}/firewallRules`, '2022-12-01')
  ])

  const server: AzurePostgreSqlServerSummary = {
    id: serverRaw.id?.trim() || '',
    name: serverRaw.name?.trim() || serverName,
    resourceGroup,
    location: serverRaw.location?.trim() || '',
    version: serverRaw.properties?.version?.trim() || '',
    fullyQualifiedDomainName: serverRaw.properties?.fullyQualifiedDomainName?.trim() || '',
    publicNetworkAccess: serverRaw.properties?.network?.publicNetworkAccess?.trim() || 'Disabled',
    state: serverRaw.properties?.state?.trim() || '',
    skuName: serverRaw.sku?.name?.trim() || '',
    skuTier: serverRaw.sku?.tier?.trim() || '',
    storageSizeGb: serverRaw.properties?.storage?.storageSizeGB ?? 0,
    haEnabled: (serverRaw.properties?.highAvailability?.mode ?? '').toLowerCase() !== 'disabled' && (serverRaw.properties?.highAvailability?.mode ?? '') !== '',
    haState: serverRaw.properties?.highAvailability?.state?.trim() || '',
    backupRetentionDays: serverRaw.properties?.backup?.backupRetentionDays ?? 7,
    geoRedundantBackup: (serverRaw.properties?.backup?.geoRedundantBackup ?? '').toLowerCase() === 'enabled',
    availabilityZone: serverRaw.properties?.availabilityZone?.trim() || '',
    databaseCount: 0,
    tagCount: Object.keys(serverRaw.tags ?? {}).length,
    notes: []
  }

  const mappedDatabases: AzurePostgreSqlDatabaseSummary[] = databases
    .filter((db) => !['azure_maintenance', 'azure_sys'].includes(db.name?.trim().toLowerCase() ?? ''))
    .map((db) => ({
      id: db.id?.trim() || '',
      name: db.name?.trim() || '',
      serverName: server.name,
      resourceGroup,
      charset: db.properties?.charset?.trim() || '',
      collation: db.properties?.collation?.trim() || ''
    } satisfies AzurePostgreSqlDatabaseSummary))

  server.databaseCount = mappedDatabases.length

  const firewallRules: AzurePostgreSqlFirewallRule[] = firewallRulesRaw.map((rule) => ({
    name: rule.name?.trim() || '',
    startIpAddress: rule.properties?.startIpAddress?.trim() || '',
    endIpAddress: rule.properties?.endIpAddress?.trim() || ''
  }))

  const isPublic = server.publicNetworkAccess.toLowerCase() === 'enabled'
  const hasAadAuth = (serverRaw.properties?.authConfig?.activeDirectoryAuth ?? '').toLowerCase() === 'enabled'
  const hasPasswordAuth = (serverRaw.properties?.authConfig?.passwordAuth ?? '').toLowerCase() !== 'disabled'
  const hasAllowAllRule = firewallRules.some((r) => r.startIpAddress === '0.0.0.0' && r.endIpAddress === '255.255.255.255')
  const hasAllowAzureRule = firewallRules.some((r) => r.startIpAddress === '0.0.0.0' && r.endIpAddress === '0.0.0.0')
  const isReady = server.state.toLowerCase() === 'ready'

  const badges: AzurePostgreSqlPostureBadge[] = [
    { id: 'public-access', label: 'Public Access', value: isPublic ? 'Enabled' : 'Disabled', tone: isPublic ? 'risk' : 'good' },
    { id: 'ha', label: 'High Availability', value: server.haEnabled ? `${serverRaw.properties?.highAvailability?.mode ?? 'Enabled'}` : 'Disabled', tone: server.haEnabled ? 'good' : 'info' },
    { id: 'aad-auth', label: 'AAD Auth', value: hasAadAuth ? 'Enabled' : 'Disabled', tone: hasAadAuth ? 'good' : 'warning' },
    { id: 'geo-backup', label: 'Geo Backup', value: server.geoRedundantBackup ? 'Enabled' : 'Disabled', tone: server.geoRedundantBackup ? 'good' : 'info' },
    { id: 'firewall', label: 'Firewall Rules', value: `${firewallRules.length} rules`, tone: hasAllowAllRule ? 'risk' : firewallRules.length === 0 ? 'good' : 'info' }
  ]

  const findings: AzurePostgreSqlFinding[] = []
  const recommendations: string[] = []

  if (isPublic) {
    findings.push({ id: 'public-access', severity: 'risk', title: 'Public network access enabled', message: 'This PostgreSQL server accepts connections from public IP addresses.', recommendation: 'Disable public network access and use private endpoints or VNet integration for production workloads.' })
    recommendations.push('Disable public network access and use private endpoints or VNet integration.')
  }

  if (!hasAadAuth) {
    findings.push({ id: 'no-aad', severity: 'warning', title: 'Azure AD authentication not enabled', message: 'The server relies on password-only authentication without AAD integration.', recommendation: 'Enable Azure AD authentication for centralized identity management.' })
    recommendations.push('Enable Azure AD authentication for centralized identity management.')
  }

  if (!server.haEnabled) {
    findings.push({ id: 'no-ha', severity: 'info', title: 'High availability not configured', message: 'The server has no high-availability standby replica.', recommendation: 'Enable zone-redundant or same-zone HA for production workloads.' })
    recommendations.push('Enable high availability for production workloads.')
  }

  if (!server.geoRedundantBackup) {
    findings.push({ id: 'no-geo-backup', severity: 'info', title: 'Geo-redundant backup disabled', message: 'Backups are stored in a single region only.', recommendation: 'Enable geo-redundant backup for disaster recovery scenarios.' })
    recommendations.push('Enable geo-redundant backup for disaster recovery.')
  }

  if (hasAllowAllRule) {
    findings.push({ id: 'allow-all-firewall', severity: 'risk', title: 'Firewall allows all IP addresses', message: 'A firewall rule permits connections from the entire internet (0.0.0.0 - 255.255.255.255).', recommendation: 'Remove the allow-all firewall rule and restrict to specific IP ranges.' })
    recommendations.push('Remove the allow-all firewall rule and restrict to specific IP ranges.')
  }

  if (hasAllowAzureRule) {
    findings.push({ id: 'allow-azure-services', severity: 'info', title: 'Azure services access allowed', message: 'A special rule allows all Azure services to connect to this server.', recommendation: 'Review whether all Azure services need access or if VNet integration is preferred.' })
    recommendations.push('Review whether all Azure services need access or if VNet integration is preferred.')
  }

  if (server.backupRetentionDays < 14) {
    findings.push({ id: 'short-retention', severity: 'warning', title: `Backup retention is ${server.backupRetentionDays} days`, message: 'Short backup retention reduces your recovery window.', recommendation: 'Increase backup retention to at least 14 days for production workloads.' })
    recommendations.push('Increase backup retention to at least 14 days.')
  }

  if (recommendations.length === 0) {
    recommendations.push('No immediate operational posture warnings detected. Continue reviewing network and access settings during routine checks.')
  }

  const summaryTiles: AzurePostgreSqlSummaryTile[] = [
    { id: 'findings', label: 'Findings', value: String(findings.length), tone: findings.some((f) => f.severity === 'risk') ? 'risk' : findings.length ? 'warning' : 'good' },
    { id: 'state', label: 'State', value: server.state || 'Unknown', tone: isReady ? 'good' : 'warning' },
    { id: 'databases', label: 'Databases', value: String(mappedDatabases.length), tone: 'info' },
    { id: 'firewall', label: 'Firewall', value: `${firewallRules.length} rules`, tone: hasAllowAllRule ? 'risk' : 'info' }
  ]

  if (isPublic) server.notes.push('Public network access is enabled for this PostgreSQL server.')

  return {
    server,
    databases: mappedDatabases,
    firewallRules,
    badges,
    summaryTiles,
    findings,
    recommendations,
    connectionDetails: [
      { label: 'FQDN', value: server.fullyQualifiedDomainName || 'N/A' },
      { label: 'Server name', value: server.name },
      { label: 'Resource group', value: server.resourceGroup },
      { label: 'PG version', value: server.version || 'N/A' },
      { label: 'Minor version', value: serverRaw.properties?.minorVersion?.trim() || 'N/A' },
      { label: 'SKU', value: `${server.skuName} (${server.skuTier})` },
      { label: 'Storage', value: server.storageSizeGb ? `${server.storageSizeGb} GB` : 'N/A' },
      { label: 'Port', value: '5432' },
      { label: 'Admin login', value: serverRaw.properties?.administratorLogin?.trim() || 'N/A' },
      { label: 'Auth', value: [hasPasswordAuth ? 'Password' : '', hasAadAuth ? 'AAD' : ''].filter(Boolean).join(' + ') || 'Password' },
      { label: 'Availability zone', value: server.availabilityZone || 'N/A' },
      { label: 'Backup retention', value: `${server.backupRetentionDays} days` },
      { label: 'Tags', value: String(server.tagCount) }
    ]
  }
}

export async function listAzureMonitorActivity(subscriptionId: string, location: string, query: string, windowHours = 24): Promise<AzureMonitorActivityResult> {
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - windowHours * 60 * 60 * 1000)
  const encodedFilter = encodeURIComponent(`eventTimestamp ge '${startTime.toISOString()}' and eventTimestamp le '${endTime.toISOString()}'`)
  const response = await fetchAzureArmCollection<{
    eventDataId?: string
    eventTimestamp?: string
    level?: string
    resourceGroupName?: string
    resourceProviderName?: { value?: string; localizedValue?: string }
    operationName?: { value?: string; localizedValue?: string }
    resourceId?: string
    caller?: string
    correlationId?: string
    status?: { value?: string; localizedValue?: string }
    subStatus?: { value?: string; localizedValue?: string }
    resourceRegion?: string
  }>(`/subscriptions/${subscriptionId.trim()}/providers/Microsoft.Insights/eventtypes/management/values?$filter=${encodedFilter}`, '2015-04-01')

  const normalizedLocation = location.trim().toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  const events = response
    .map((event) => ({
      id: event.eventDataId?.trim() || `${event.correlationId?.trim() || 'event'}:${event.eventTimestamp || ''}`,
      timestamp: event.eventTimestamp?.trim() || '',
      level: event.level?.trim() || '',
      status: event.status?.localizedValue?.trim() || event.status?.value?.trim() || '',
      resourceGroup: event.resourceGroupName?.trim() || '',
      resourceType: event.resourceProviderName?.localizedValue?.trim() || event.resourceProviderName?.value?.trim() || '',
      operationName: event.operationName?.localizedValue?.trim() || event.operationName?.value?.trim() || '',
      resourceId: event.resourceId?.trim() || '',
      caller: event.caller?.trim() || '',
      correlationId: event.correlationId?.trim() || '',
      summary: event.subStatus?.localizedValue?.trim() || event.subStatus?.value?.trim() || ''
    } satisfies AzureMonitorActivityEvent))
    .filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index)
    .filter((event) => {
      if (normalizedLocation) {
        const regionSource = (response.find((candidate) => (candidate.eventDataId?.trim() || `${candidate.correlationId?.trim() || 'event'}:${candidate.eventTimestamp || ''}`) === event.id)?.resourceRegion ?? '').trim().toLowerCase()
        if (regionSource && regionSource !== normalizedLocation) {
          return false
        }
      }

      if (!normalizedQuery) {
        return true
      }

      const haystack = [
        event.level,
        event.status,
        event.resourceGroup,
        event.resourceType,
        event.operationName,
        event.resourceId,
        event.caller,
        event.summary
      ].join(' ').toLowerCase()

      // Support pipe-separated multi-term queries: split on "|", extract
      // meaningful search terms from each segment, and require ALL to match.
      const segments = normalizedQuery.split('|').map(s => s.trim()).filter(Boolean)
      const terms = segments.map(segment => {
        const whereMatch = segment.match(/^where\s+\w+\s*==\s*["']?(.+?)["']?\s*$/i)
        if (whereMatch) return whereMatch[1].trim().toLowerCase()
        return segment
      })
      return terms.every(term => haystack.includes(term))
    })
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 100)

  return {
    query: query.trim(),
    events,
    statusCounts: toFacetCounts(events.map((event) => event.status)),
    resourceTypeCounts: toFacetCounts(events.map((event) => event.resourceType)),
    notes: events.length === 0 ? ['No Azure Monitor activity events matched the current query window.'] : []
  }
}

export async function getAzureCostOverview(subscriptionId: string): Promise<AzureCostOverview> {
  type CostQueryResponse = {
    properties?: {
      columns?: Array<{ name?: string }>
      rows?: Array<Array<string | number | null>>
    }
  }

  const scope = `/subscriptions/${encodeURIComponent(subscriptionId.trim())}/providers/Microsoft.CostManagement/query`
  const apiVersion = '2023-03-01'

  const [groupedResponse, dailyResponse] = await Promise.all([
    fetchAzureArmJson<CostQueryResponse>(scope, apiVersion, {
      method: 'POST',
      body: JSON.stringify({
        type: 'Usage',
        timeframe: 'MonthToDate',
        dataset: {
          granularity: 'None',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
          grouping: [
            { type: 'Dimension', name: 'ServiceName' },
            { type: 'Dimension', name: 'ResourceGroupName' }
          ]
        }
      })
    }),
    fetchAzureArmJson<CostQueryResponse>(scope, apiVersion, {
      method: 'POST',
      body: JSON.stringify({
        type: 'Usage',
        timeframe: 'MonthToDate',
        dataset: {
          granularity: 'Daily',
          aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }
        }
      })
    })
  ])

  /* ---- grouped (service x resource-group) breakdown ---- */
  const columnNames = (groupedResponse.properties?.columns ?? []).map((column) => column.name?.trim() || '')
  const costIndex = columnNames.findIndex((name) => name === 'Cost')
  const serviceIndex = columnNames.findIndex((name) => name === 'ServiceName')
  const resourceGroupIndex = columnNames.findIndex((name) => name === 'ResourceGroupName')
  const currencyIndex = columnNames.findIndex((name) => name === 'Currency')
  const rows = groupedResponse.properties?.rows ?? []

  const totalAmount = rows.reduce((sum, row) => sum + Number(row[costIndex] ?? 0), 0)
  const currency = String(rows[0]?.[currencyIndex] ?? 'USD')
  const serviceTotals = new Map<string, number>()
  const resourceGroupTotals = new Map<string, number>()

  for (const row of rows) {
    const cost = Number(row[costIndex] ?? 0)
    const service = String(row[serviceIndex] ?? 'Unknown service')
    const resourceGroup = String(row[resourceGroupIndex] ?? 'Unassigned')
    serviceTotals.set(service, (serviceTotals.get(service) ?? 0) + cost)
    resourceGroupTotals.set(resourceGroup, (resourceGroupTotals.get(resourceGroup) ?? 0) + cost)
  }

  const toBreakdown = (entries: Map<string, number>): AzureCostBreakdownEntry[] => [...entries.entries()]
    .map(([label, amount]) => ({
      label,
      amount,
      currency,
      sharePercent: totalAmount > 0 ? Number(((amount / totalAmount) * 100).toFixed(1)) : 0
    }))
    .sort((left, right) => right.amount - left.amount || left.label.localeCompare(right.label))
    .slice(0, 10)

  /* ---- daily cost trend ---- */
  const dailyColumns = (dailyResponse.properties?.columns ?? []).map((column) => column.name?.trim() || '')
  const dailyCostIndex = dailyColumns.findIndex((name) => name === 'Cost')
  const dailyDateIndex = dailyColumns.findIndex((name) => name === 'UsageDate')
  const dailyCurrencyIndex = dailyColumns.findIndex((name) => name === 'Currency')
  const dailyRows = dailyResponse.properties?.rows ?? []

  const dailyCosts: AzureCostDailyEntry[] = dailyRows
    .map((row) => {
      const raw = String(row[dailyDateIndex] ?? '')
      const dateStr = raw.length === 8
        ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
        : raw
      return {
        date: dateStr,
        amount: Number(Number(row[dailyCostIndex] ?? 0).toFixed(2)),
        currency: String(row[dailyCurrencyIndex] ?? currency)
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  const daysWithSpend = dailyCosts.filter((d) => d.amount > 0).length
  const dailyAverage = daysWithSpend > 0 ? Number((totalAmount / daysWithSpend).toFixed(2)) : 0
  const topServices = toBreakdown(serviceTotals)

  return {
    subscriptionId,
    timeframeLabel: 'Month to date',
    totalAmount: Number(totalAmount.toFixed(2)),
    currency,
    dailyAverage,
    topServiceName: topServices[0]?.label ?? '',
    topServiceAmount: topServices[0]?.amount ?? 0,
    serviceCount: serviceTotals.size,
    resourceGroupCount: resourceGroupTotals.size,
    topServices,
    topResourceGroups: toBreakdown(resourceGroupTotals),
    dailyCosts,
    notes: rows.length === 0 ? ['No subscription cost rows were returned for the current month-to-date window.'] : []
  }
}

/* ── Azure Network ───────────────────────────────────────── */

function mapVNet(raw: Record<string, unknown>): AzureVNetSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>
  const addressSpace = (props.addressSpace ?? {}) as Record<string, unknown>
  const subnets = (props.subnets ?? []) as unknown[]
  const peerings = (props.virtualNetworkPeerings ?? []) as unknown[]
  const dhcpOptions = (props.dhcpOptions ?? {}) as Record<string, unknown>
  const tags = (raw.tags ?? {}) as Record<string, unknown>

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    resourceGroup: extractResourceGroup(String(raw.id ?? '')),
    location: String(raw.location ?? ''),
    addressPrefixes: (addressSpace.addressPrefixes ?? []) as string[],
    subnetCount: subnets.length,
    provisioningState: String(props.provisioningState ?? ''),
    enableDdosProtection: Boolean(props.enableDdosProtection),
    dnsServers: ((dhcpOptions.dnsServers ?? []) as string[]),
    peeringCount: peerings.length,
    tagCount: Object.keys(tags).length
  }
}

function mapSubnet(raw: Record<string, unknown>): AzureSubnetSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>
  const nsg = (props.networkSecurityGroup ?? null) as Record<string, unknown> | null
  const routeTable = (props.routeTable ?? null) as Record<string, unknown> | null
  const delegations = (props.delegations ?? []) as Array<Record<string, unknown>>
  const privateEndpoints = (props.privateEndpoints ?? []) as unknown[]
  const natGateway = (props.natGateway ?? null) as Record<string, unknown> | null

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    addressPrefix: String(props.addressPrefix ?? ''),
    provisioningState: String(props.provisioningState ?? ''),
    nsgName: nsg ? extractResourceName(String(nsg.id ?? '')) : '',
    routeTableName: routeTable ? extractResourceName(String(routeTable.id ?? '')) : '',
    delegations: delegations.map((d) => {
      const dProps = (d.properties ?? {}) as Record<string, unknown>
      return String(dProps.serviceName ?? d.name ?? '')
    }),
    privateEndpointCount: privateEndpoints.length,
    natGatewayName: natGateway ? extractResourceName(String(natGateway.id ?? '')) : ''
  }
}

function mapNsg(raw: Record<string, unknown>): AzureNsgSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>
  const rules = (props.securityRules ?? []) as unknown[]
  const defaultRules = (props.defaultSecurityRules ?? []) as unknown[]
  const associatedSubnets = (props.subnets ?? []) as unknown[]
  const associatedNics = (props.networkInterfaces ?? []) as unknown[]

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    resourceGroup: extractResourceGroup(String(raw.id ?? '')),
    location: String(raw.location ?? ''),
    securityRuleCount: rules.length,
    defaultRuleCount: defaultRules.length,
    associatedSubnetCount: associatedSubnets.length,
    associatedNicCount: associatedNics.length,
    provisioningState: String(props.provisioningState ?? '')
  }
}

function mapNsgRule(raw: Record<string, unknown>): AzureNsgRuleSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>

  return {
    name: String(raw.name ?? ''),
    priority: Number(props.priority ?? 0),
    direction: String(props.direction ?? 'Inbound') as 'Inbound' | 'Outbound',
    access: String(props.access ?? 'Allow') as 'Allow' | 'Deny',
    protocol: String(props.protocol ?? '*'),
    sourceAddressPrefix: String(props.sourceAddressPrefix ?? '*'),
    sourcePortRange: String(props.sourcePortRange ?? '*'),
    destinationAddressPrefix: String(props.destinationAddressPrefix ?? '*'),
    destinationPortRange: String(props.destinationPortRange ?? '*')
  }
}

function mapPublicIp(raw: Record<string, unknown>): AzurePublicIpSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>
  const ipConfig = (props.ipConfiguration ?? null) as Record<string, unknown> | null
  const dnsSettings = (props.dnsSettings ?? null) as Record<string, unknown> | null
  const sku = (raw.sku ?? {}) as Record<string, unknown>

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    resourceGroup: extractResourceGroup(String(raw.id ?? '')),
    location: String(raw.location ?? ''),
    ipAddress: String(props.ipAddress ?? ''),
    allocationMethod: String(props.publicIPAllocationMethod ?? ''),
    sku: String(sku.name ?? ''),
    associatedResourceName: ipConfig ? extractResourceName(String(ipConfig.id ?? '')) : '',
    provisioningState: String(props.provisioningState ?? ''),
    dnsLabel: dnsSettings ? String((dnsSettings as Record<string, unknown>).domainNameLabel ?? '') : '',
    fqdn: dnsSettings ? String((dnsSettings as Record<string, unknown>).fqdn ?? '') : ''
  }
}

function mapNetworkInterface(raw: Record<string, unknown>): AzureNetworkInterfaceSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>
  const ipConfigs = (props.ipConfigurations ?? []) as Array<Record<string, unknown>>
  const nsg = (props.networkSecurityGroup ?? null) as Record<string, unknown> | null
  const vmRef = (props.virtualMachine ?? null) as Record<string, unknown> | null

  const primaryConfig = ipConfigs[0] ?? {}
  const primaryProps = ((primaryConfig as Record<string, unknown>).properties ?? {}) as Record<string, unknown>
  const subnetRef = (primaryProps.subnet ?? null) as Record<string, unknown> | null
  const publicIpRef = (primaryProps.publicIPAddress ?? null) as Record<string, unknown> | null

  const subnetId = subnetRef ? String(subnetRef.id ?? '') : ''
  const subnetSegments = subnetId.split('/')
  const subnetName = subnetSegments.at(-1) ?? ''
  const vnetName = subnetSegments.length >= 3 ? subnetSegments[subnetSegments.indexOf('virtualNetworks') + 1] ?? '' : ''

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    resourceGroup: extractResourceGroup(String(raw.id ?? '')),
    location: String(raw.location ?? ''),
    privateIp: String(primaryProps.privateIPAddress ?? ''),
    publicIp: publicIpRef ? extractResourceName(String(publicIpRef.id ?? '')) : '',
    subnetName,
    vnetName,
    nsgName: nsg ? extractResourceName(String(nsg.id ?? '')) : '',
    macAddress: String(props.macAddress ?? ''),
    attachedVmName: vmRef ? extractResourceName(String(vmRef.id ?? '')) : '',
    provisioningState: String(props.provisioningState ?? ''),
    enableAcceleratedNetworking: Boolean(props.enableAcceleratedNetworking)
  }
}

export async function listAzureNetworkOverview(subscriptionId: string, location: string): Promise<AzureNetworkOverview> {
  const basePath = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Network`
  const apiVersion = '2023-11-01'

  const [rawVnets, rawNsgs, rawPublicIps, rawNics] = await Promise.all([
    fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/virtualNetworks`, apiVersion),
    fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/networkSecurityGroups`, apiVersion),
    fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/publicIPAddresses`, apiVersion),
    fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/networkInterfaces`, apiVersion)
  ])

  const locationFilter = location.trim().toLowerCase()
  const filterByLocation = <T extends Record<string, unknown>>(items: T[]): T[] =>
    locationFilter ? items.filter((item) => String(item.location ?? '').toLowerCase() === locationFilter) : items

  return {
    vnets: filterByLocation(rawVnets).map(mapVNet),
    nsgs: filterByLocation(rawNsgs).map(mapNsg),
    publicIps: filterByLocation(rawPublicIps).map(mapPublicIp),
    networkInterfaces: filterByLocation(rawNics).map(mapNetworkInterface)
  }
}

export async function listAzureVNetSubnets(subscriptionId: string, resourceGroup: string, vnetName: string): Promise<AzureSubnetSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Network/virtualNetworks/${encodeURIComponent(vnetName)}/subnets`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-11-01')
  return raw.map(mapSubnet)
}

export async function listAzureNsgRules(subscriptionId: string, resourceGroup: string, nsgName: string): Promise<AzureNsgRuleSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Network/networkSecurityGroups/${encodeURIComponent(nsgName)}`
  const detail = await fetchAzureArmJson<Record<string, unknown>>(path, '2023-11-01')
  const props = (detail.properties ?? {}) as Record<string, unknown>
  const customRules = ((props.securityRules ?? []) as Array<Record<string, unknown>>).map(mapNsgRule)
  const defaultRules = ((props.defaultSecurityRules ?? []) as Array<Record<string, unknown>>).map(mapNsgRule)
  return [...customRules.sort((a, b) => a.priority - b.priority), ...defaultRules.sort((a, b) => a.priority - b.priority)]
}

/* ── Azure VMSS ──────────────────────────────────────────── */

function mapVmss(raw: Record<string, unknown>): AzureVmssSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>
  const sku = (raw.sku ?? {}) as Record<string, unknown>
  const upgradePolicy = (props.upgradePolicy ?? {}) as Record<string, unknown>
  const identity = (raw.identity ?? {}) as Record<string, unknown>
  const tags = (raw.tags ?? {}) as Record<string, unknown>
  const zones = (raw.zones ?? []) as string[]

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    resourceGroup: extractResourceGroup(String(raw.id ?? '')),
    location: String(raw.location ?? ''),
    skuName: String(sku.name ?? ''),
    skuCapacity: Number(sku.capacity ?? 0),
    provisioningState: String(props.provisioningState ?? ''),
    orchestrationMode: String(props.orchestrationMode ?? ''),
    upgradePolicy: String(upgradePolicy.mode ?? ''),
    platformFaultDomainCount: Number(props.platformFaultDomainCount ?? 0),
    overprovision: Boolean(props.overprovision),
    singlePlacementGroup: Boolean(props.singlePlacementGroup),
    identityType: String(identity.type ?? 'None'),
    tagCount: Object.keys(tags).length,
    zones
  }
}

function mapVmssInstance(raw: Record<string, unknown>): AzureVmssInstanceSummary {
  const props = (raw.properties ?? {}) as Record<string, unknown>
  const instanceView = (props.instanceView ?? {}) as Record<string, unknown>
  const statuses = (instanceView.statuses ?? []) as Array<{ code?: string; displayStatus?: string }>
  const protectionPolicy = (props.protectionPolicy ?? {}) as Record<string, unknown>
  const hardwareProfile = (props.hardwareProfile ?? {}) as Record<string, unknown>

  return {
    instanceId: String(raw.instanceId ?? raw.name ?? ''),
    name: String(raw.name ?? ''),
    provisioningState: String(props.provisioningState ?? ''),
    powerState: extractPowerState(statuses),
    latestModelApplied: Boolean(props.latestModelApplied),
    vmSize: String(hardwareProfile.vmSize ?? (raw.sku as Record<string, unknown>)?.name ?? ''),
    protectionFromScaleIn: Boolean(protectionPolicy.protectFromScaleIn),
    zone: String((raw.zones as string[] | undefined)?.[0] ?? '')
  }
}

export async function listAzureVmss(subscriptionId: string, location: string): Promise<AzureVmssSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/virtualMachineScaleSets`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2024-03-01')
  const locationFilter = location.trim().toLowerCase()
  const filtered = locationFilter
    ? raw.filter((item) => String(item.location ?? '').toLowerCase() === locationFilter)
    : raw
  return filtered.map(mapVmss)
}

export async function listAzureVmssInstances(subscriptionId: string, resourceGroup: string, vmssName: string): Promise<AzureVmssInstanceSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachineScaleSets/${encodeURIComponent(vmssName)}/virtualMachines?$expand=instanceView`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2024-03-01')
  return raw.map(mapVmssInstance)
}

export async function updateAzureVmssCapacity(subscriptionId: string, resourceGroup: string, vmssName: string, capacity: number): Promise<AzureVmssActionResult> {
  try {
    const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachineScaleSets/${encodeURIComponent(vmssName)}`
    await fetchAzureArmJson(path, '2024-03-01', {
      method: 'PATCH',
      body: JSON.stringify({ sku: { capacity } })
    })
    return { action: 'updateCapacity', vmssName, resourceGroup, accepted: true }
  } catch (err) {
    return { action: 'updateCapacity', vmssName, resourceGroup, accepted: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function runAzureVmssInstanceAction(
  subscriptionId: string,
  resourceGroup: string,
  vmssName: string,
  instanceId: string,
  action: 'start' | 'powerOff' | 'restart' | 'deallocate'
): Promise<AzureVmssActionResult> {
  try {
    const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachineScaleSets/${encodeURIComponent(vmssName)}/virtualMachines/${encodeURIComponent(instanceId)}/${action}`
    await fetchAzureArmJson(path, '2024-03-01', { method: 'POST' })
    return { action, vmssName, resourceGroup, accepted: true }
  } catch (err) {
    return { action, vmssName, resourceGroup, accepted: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/* ── Azure Application Insights ─────────────────────────── */

export async function listAzureAppInsightsComponents(subscriptionId: string, location: string): Promise<AzureAppInsightsSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Insights/components`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2020-02-02')
  const locationFilter = location.trim().toLowerCase()
  const filtered = locationFilter
    ? raw.filter((item) => String(item.location ?? '').toLowerCase() === locationFilter)
    : raw
  return filtered.map((r): AzureAppInsightsSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      resourceGroup: extractResourceGroup(String(r.id ?? '')),
      location: String(r.location ?? ''),
      instrumentationKey: String(props.InstrumentationKey ?? ''),
      applicationId: String(props.AppId ?? ''),
      applicationType: String(props.Application_Type ?? ''),
      kind: String(r.kind ?? ''),
      ingestionMode: String(props.IngestionMode ?? ''),
      retentionInDays: Number(props.RetentionInDays ?? 90),
      publicNetworkAccessForIngestion: String(props.publicNetworkAccessForIngestion ?? 'Enabled'),
      publicNetworkAccessForQuery: String(props.publicNetworkAccessForQuery ?? 'Enabled'),
      provisioningState: String(props.provisioningState ?? 'Unknown'),
      connectionString: String(props.ConnectionString ?? ''),
      workspaceResourceId: String(props.WorkspaceResourceId ?? ''),
      tagCount: Object.keys((r.tags ?? {}) as Record<string, unknown>).length
    }
  })
}

/* ── Azure Key Vault ────────────────────────────────────── */

export async function listAzureKeyVaults(subscriptionId: string, location: string): Promise<AzureKeyVaultSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.KeyVault/vaults`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-07-01')
  const locationFilter = location.trim().toLowerCase()
  const filtered = locationFilter
    ? raw.filter((item) => String(item.location ?? '').toLowerCase() === locationFilter)
    : raw
  return filtered.map((r): AzureKeyVaultSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      resourceGroup: extractResourceGroup(String(r.id ?? '')),
      location: String(r.location ?? ''),
      vaultUri: String(props.vaultUri ?? ''),
      skuName: String(((props.sku ?? {}) as Record<string, unknown>).name ?? ''),
      tenantId: String(props.tenantId ?? ''),
      enableSoftDelete: Boolean(props.enableSoftDelete),
      softDeleteRetentionInDays: Number(props.softDeleteRetentionInDays ?? 90),
      enablePurgeProtection: Boolean(props.enablePurgeProtection),
      enableRbacAuthorization: Boolean(props.enableRbacAuthorization),
      publicNetworkAccess: String(props.publicNetworkAccess ?? 'Enabled'),
      provisioningState: String(props.provisioningState ?? 'Unknown'),
      tagCount: Object.keys((r.tags ?? {}) as Record<string, unknown>).length
    }
  })
}

export async function describeAzureKeyVault(subscriptionId: string, resourceGroup: string, vaultName: string): Promise<AzureKeyVaultSummary> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.KeyVault/vaults/${encodeURIComponent(vaultName)}`
  const r = await fetchAzureArmJson<Record<string, unknown>>(path, '2023-07-01')
  const props = (r.properties ?? {}) as Record<string, unknown>
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    resourceGroup: extractResourceGroup(String(r.id ?? '')),
    location: String(r.location ?? ''),
    vaultUri: String(props.vaultUri ?? ''),
    skuName: String(((props.sku ?? {}) as Record<string, unknown>).name ?? ''),
    tenantId: String(props.tenantId ?? ''),
    enableSoftDelete: Boolean(props.enableSoftDelete),
    softDeleteRetentionInDays: Number(props.softDeleteRetentionInDays ?? 90),
    enablePurgeProtection: Boolean(props.enablePurgeProtection),
    enableRbacAuthorization: Boolean(props.enableRbacAuthorization),
    publicNetworkAccess: String(props.publicNetworkAccess ?? 'Enabled'),
    provisioningState: String(props.provisioningState ?? 'Unknown'),
    tagCount: Object.keys((r.tags ?? {}) as Record<string, unknown>).length
  }
}

export async function listAzureKeyVaultSecrets(subscriptionId: string, resourceGroup: string, vaultName: string): Promise<AzureKeyVaultSecretSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.KeyVault/vaults/${encodeURIComponent(vaultName)}/secrets`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-07-01')
  return raw.map((r): AzureKeyVaultSecretSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    const attrs = (props.attributes ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      enabled: Boolean(attrs.enabled),
      contentType: String(props.contentType ?? ''),
      managed: Boolean(attrs.managed),
      created: String(attrs.created ?? ''),
      updated: String(attrs.updated ?? '')
    }
  })
}

export async function listAzureKeyVaultKeys(subscriptionId: string, resourceGroup: string, vaultName: string): Promise<AzureKeyVaultKeySummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.KeyVault/vaults/${encodeURIComponent(vaultName)}/keys`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-07-01')
  return raw.map((r): AzureKeyVaultKeySummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    const attrs = (props.attributes ?? {}) as Record<string, unknown>
    const kty = (props.kty ?? '') as string
    const keyOps = Array.isArray(props.keyOps) ? (props.keyOps as string[]) : []
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      enabled: Boolean(attrs.enabled),
      keyType: kty,
      keyOps,
      created: String(attrs.created ?? ''),
      updated: String(attrs.updated ?? '')
    }
  })
}

/* ── Azure Event Hub ────────────────────────────────────── */

export async function listAzureEventHubNamespaces(subscriptionId: string, location: string): Promise<AzureEventHubNamespaceSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.EventHub/namespaces`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2024-01-01')
  const locationFilter = location.trim().toLowerCase()
  const filtered = locationFilter
    ? raw.filter((item) => String(item.location ?? '').toLowerCase() === locationFilter)
    : raw
  return filtered.map((r): AzureEventHubNamespaceSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    const sku = (r.sku ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      resourceGroup: extractResourceGroup(String(r.id ?? '')),
      location: String(r.location ?? ''),
      skuName: String(sku.name ?? ''),
      skuTier: String(sku.tier ?? ''),
      skuCapacity: Number(sku.capacity ?? 0),
      isAutoInflateEnabled: Boolean(props.isAutoInflateEnabled),
      maximumThroughputUnits: Number(props.maximumThroughputUnits ?? 0),
      kafkaEnabled: Boolean(props.kafkaEnabled),
      zoneRedundant: Boolean(props.zoneRedundant),
      publicNetworkAccess: String(props.publicNetworkAccess ?? 'Enabled'),
      provisioningState: String(props.provisioningState ?? 'Unknown'),
      status: String(props.status ?? 'Unknown'),
      serviceBusEndpoint: String(props.serviceBusEndpoint ?? ''),
      tagCount: Object.keys((r.tags ?? {}) as Record<string, unknown>).length
    }
  })
}

export async function listAzureEventHubs(subscriptionId: string, resourceGroup: string, namespaceName: string): Promise<AzureEventHubSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.EventHub/namespaces/${encodeURIComponent(namespaceName)}/eventhubs`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2024-01-01')
  return raw.map((r): AzureEventHubSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      partitionCount: Number(props.partitionCount ?? 0),
      messageRetentionInDays: Number(props.messageRetentionInDays ?? 0),
      status: String(props.status ?? 'Unknown'),
      createdAt: String(props.createdAt ?? ''),
      updatedAt: String(props.updatedAt ?? ''),
      partitionIds: Array.isArray(props.partitionIds) ? (props.partitionIds as string[]) : []
    }
  })
}

export async function listAzureEventHubConsumerGroups(subscriptionId: string, resourceGroup: string, namespaceName: string, eventHubName: string): Promise<AzureEventHubConsumerGroupSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.EventHub/namespaces/${encodeURIComponent(namespaceName)}/eventhubs/${encodeURIComponent(eventHubName)}/consumergroups`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2024-01-01')
  return raw.map((r): AzureEventHubConsumerGroupSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      userMetadata: String(props.userMetadata ?? ''),
      createdAt: String(props.createdAt ?? ''),
      updatedAt: String(props.updatedAt ?? '')
    }
  })
}

/* ── Azure App Service ──────────────────────────────────── */

export async function listAzureAppServicePlans(subscriptionId: string, location: string): Promise<AzureAppServicePlanSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Web/serverfarms`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-12-01')
  const locationFilter = location.trim().toLowerCase()
  const filtered = locationFilter
    ? raw.filter((item) => String(item.location ?? '').toLowerCase() === locationFilter)
    : raw
  return filtered.map((r): AzureAppServicePlanSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    const sku = (r.sku ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      resourceGroup: extractResourceGroup(String(r.id ?? '')),
      location: String(r.location ?? ''),
      skuName: String(sku.name ?? ''),
      skuTier: String(sku.tier ?? ''),
      skuCapacity: Number(sku.capacity ?? 0),
      kind: String(r.kind ?? ''),
      numberOfWorkers: Number(props.numberOfWorkers ?? 0),
      numberOfSites: Number(props.numberOfSites ?? 0),
      status: String(props.status ?? 'Unknown'),
      reserved: Boolean(props.reserved),
      zoneRedundant: Boolean(props.zoneRedundant),
      provisioningState: String(props.provisioningState ?? 'Unknown'),
      tagCount: Object.keys((r.tags ?? {}) as Record<string, unknown>).length
    }
  })
}

export async function listAzureWebApps(subscriptionId: string, location: string): Promise<AzureWebAppSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Web/sites`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-12-01')
  const locationFilter = location.trim().toLowerCase()
  const filtered = locationFilter
    ? raw.filter((item) => String(item.location ?? '').toLowerCase() === locationFilter)
    : raw
  return filtered.map((r): AzureWebAppSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    const siteConfig = (props.siteConfig ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      resourceGroup: extractResourceGroup(String(r.id ?? '')),
      location: String(r.location ?? ''),
      kind: String(r.kind ?? ''),
      state: String(props.state ?? 'Unknown'),
      defaultHostName: String(props.defaultHostName ?? ''),
      httpsOnly: Boolean(props.httpsOnly),
      enabled: Boolean(props.enabled),
      appServicePlanName: extractResourceName(String(props.serverFarmId ?? '')),
      runtimeStack: String(siteConfig.linuxFxVersion ?? siteConfig.windowsFxVersion ?? siteConfig.netFrameworkVersion ?? ''),
      ftpsState: String(siteConfig.ftpsState ?? ''),
      http20Enabled: Boolean(siteConfig.http20Enabled),
      minTlsVersion: String(siteConfig.minTlsVersion ?? ''),
      publicNetworkAccess: String(props.publicNetworkAccess ?? 'Enabled'),
      provisioningState: String(props.provisioningState ?? 'Unknown'),
      lastModifiedTimeUtc: String(props.lastModifiedTimeUtc ?? ''),
      tagCount: Object.keys((r.tags ?? {}) as Record<string, unknown>).length
    }
  })
}

export async function describeAzureWebApp(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureWebAppSummary> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}`
  const r = await fetchAzureArmJson<Record<string, unknown>>(path, '2023-12-01')
  const props = (r.properties ?? {}) as Record<string, unknown>
  const siteConfig = (props.siteConfig ?? {}) as Record<string, unknown>
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    resourceGroup: extractResourceGroup(String(r.id ?? '')),
    location: String(r.location ?? ''),
    kind: String(r.kind ?? ''),
    state: String(props.state ?? 'Unknown'),
    defaultHostName: String(props.defaultHostName ?? ''),
    httpsOnly: Boolean(props.httpsOnly),
    enabled: Boolean(props.enabled),
    appServicePlanName: extractResourceName(String(props.serverFarmId ?? '')),
    runtimeStack: String(siteConfig.linuxFxVersion ?? siteConfig.windowsFxVersion ?? siteConfig.netFrameworkVersion ?? ''),
    ftpsState: String(siteConfig.ftpsState ?? ''),
    http20Enabled: Boolean(siteConfig.http20Enabled),
    minTlsVersion: String(siteConfig.minTlsVersion ?? ''),
    publicNetworkAccess: String(props.publicNetworkAccess ?? 'Enabled'),
    provisioningState: String(props.provisioningState ?? 'Unknown'),
    lastModifiedTimeUtc: String(props.lastModifiedTimeUtc ?? ''),
    tagCount: Object.keys((r.tags ?? {}) as Record<string, unknown>).length
  }
}

export async function listAzureWebAppSlots(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureWebAppSlotSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}/slots`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-12-01')
  return raw.map((r): AzureWebAppSlotSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    const fullName = String(r.name ?? '')
    const slotName = fullName.includes('/') ? fullName.split('/').pop()! : fullName
    return {
      id: String(r.id ?? ''),
      name: fullName,
      slotName,
      state: String(props.state ?? 'Unknown'),
      hostName: String(props.defaultHostName ?? ''),
      enabled: Boolean(props.enabled),
      httpsOnly: Boolean(props.httpsOnly),
      lastModifiedTimeUtc: String(props.lastModifiedTimeUtc ?? '')
    }
  })
}

export async function listAzureWebAppDeployments(subscriptionId: string, resourceGroup: string, siteName: string): Promise<AzureWebAppDeploymentSummary[]> {
  const path = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}/deployments`
  const raw = await fetchAzureArmCollection<Record<string, unknown>>(path, '2023-12-01')
  return raw.map((r): AzureWebAppDeploymentSummary => {
    const props = (r.properties ?? {}) as Record<string, unknown>
    return {
      id: String(r.id ?? ''),
      deploymentId: String(r.name ?? ''),
      status: Number(props.status ?? 0),
      message: String(props.message ?? ''),
      author: String(props.author ?? ''),
      deployer: String(props.deployer ?? ''),
      startTime: String(props.start_time ?? props.startTime ?? ''),
      endTime: String(props.end_time ?? props.endTime ?? ''),
      active: Boolean(props.active)
    }
  })
}
