import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import type {
  AzureAuthSessionState,
  AzureContextDiagnostic,
  AzureContextDiagnosticCode,
  AzureLocationSummary,
  AzureProviderContextSnapshot,
  AzureProviderRegistrationSummary,
  AzureSubscriptionSummary,
  AzureTenantSummary
} from '@shared/types'
import { getEnvironmentHealthReport } from './environment'
import { getEnterpriseSettings } from './enterprise'
import { readAzureFoundationStore, updateAzureFoundationStore, type AzureFoundationStore } from './azureFoundationStore'

const MANAGEMENT_SCOPE = 'https://management.azure.com/.default'
const REQUIRED_PROVIDER_NAMESPACES = [
  'Microsoft.Resources',
  'Microsoft.Compute',
  'Microsoft.Storage',
  'Microsoft.ContainerService',
  'Microsoft.Monitor',
  'Microsoft.DBforPostgreSQL',
  'Microsoft.Sql'
]

type AzureCatalogData = {
  tenants: AzureTenantSummary[]
  subscriptions: AzureSubscriptionSummary[]
  locations: AzureLocationSummary[]
  providerRegistrations: AzureProviderRegistrationSummary[]
}

type AzureCredentialSource = 'azure-cli'

type CatalogCache = {
  subscriptionId: string
  data: AzureCatalogData
  cliPath: string
}

type RuntimeState = {
  auth: AzureAuthSessionState
  credentialSource: AzureCredentialSource | null
  authRunId: number
  authFlow: Promise<void> | null
  authProcess: ChildProcessWithoutNullStreams | null
  ambientCredentialDiscovery: Promise<boolean> | null
  skipAmbientDiscoveryOnce: boolean
  catalogCache: CatalogCache | null
}

const runtimeState: RuntimeState = {
  auth: {
    status: 'signed-out',
    message: 'No local az login session was found. Start browser sign-in to connect Azure.',
    prompt: null,
    signedInAt: '',
    lastError: ''
  },
  credentialSource: null,
  authRunId: 0,
  authFlow: null,
  authProcess: null,
  ambientCredentialDiscovery: null,
  skipAmbientDiscoveryOnce: false,
  catalogCache: null
}

const execFileAsync = promisify(execFile)

function trimToEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeAuthState(update: Partial<AzureAuthSessionState>): AzureAuthSessionState {
  const current = runtimeState.auth
  return {
    status: update.status ?? current.status,
    message: update.message ?? current.message,
    prompt: update.prompt ?? current.prompt,
    signedInAt: update.signedInAt ?? current.signedInAt,
    lastError: update.lastError ?? current.lastError
  }
}

function writeAuthState(update: Partial<AzureAuthSessionState>): AzureAuthSessionState {
  runtimeState.auth = normalizeAuthState(update)
  updateAzureFoundationStore({
    lastSignedInAt: runtimeState.auth.signedInAt,
    lastError: runtimeState.auth.lastError
  })
  return runtimeState.auth
}

function resetAuthState(message = 'No local az login session was found. Start browser sign-in to connect Azure.'): AzureAuthSessionState {
  if (runtimeState.authProcess) {
    runtimeState.authProcess.kill()
    runtimeState.authProcess = null
  }
  runtimeState.credentialSource = null
  runtimeState.authRunId += 1
  runtimeState.authFlow = null
  runtimeState.catalogCache = null
  return writeAuthState({
    status: 'signed-out',
    message,
    prompt: null,
    signedInAt: '',
    lastError: ''
  })
}

function formatAzureError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function labelAzureCredentialSource(source: AzureCredentialSource): string {
  switch (source) {
    case 'azure-cli':
      return 'az login'
    default:
      return 'Azure'
  }
}

function activateAzureCredential(
  source: AzureCredentialSource,
  message: string
): AzureAuthSessionState {
  const signedInAt = runtimeState.auth.signedInAt
    || readAzureFoundationStore().lastSignedInAt
    || new Date().toISOString()

  runtimeState.credentialSource = source
  const auth = writeAuthState({
    status: 'authenticated',
    message,
    prompt: null,
    signedInAt,
    lastError: ''
  })
  updateAzureFoundationStore({
    lastSignedInAt: signedInAt,
    lastError: ''
  })
  return auth
}

async function tryHydrateAmbientAzureCredential(): Promise<boolean> {
  if (runtimeState.credentialSource === 'azure-cli' || runtimeState.authFlow) {
    return runtimeState.auth.status === 'authenticated'
  }

  if (runtimeState.ambientCredentialDiscovery) {
    return runtimeState.ambientCredentialDiscovery
  }

  runtimeState.ambientCredentialDiscovery = (async () => {
    try {
      const cliCatalog = await loadAzureCliCatalogData()
      if (cliCatalog.tenants.length === 0 && cliCatalog.subscriptions.length === 0) {
        return false
      }

      activateAzureCredential(
        'azure-cli',
        `Connected using the local ${labelAzureCredentialSource('azure-cli')} session.`
      )
      return true
    } catch {
      return false
    }
  })().finally(() => {
    runtimeState.ambientCredentialDiscovery = null
  })

  return runtimeState.ambientCredentialDiscovery
}

function mergeRecentSubscriptionIds(current: string[], activeSubscriptionId: string): string[] {
  const normalizedActive = activeSubscriptionId.trim()
  const merged = [
    normalizedActive,
    ...current.map((entry) => entry.trim()).filter(Boolean)
  ].filter(Boolean)

  return [...new Set(merged)].slice(0, 8)
}

function mergeRecentSubscriptions(
  current: AzureFoundationStore['recentSubscriptions'],
  subscriptions: AzureSubscriptionSummary[],
  activeSubscriptionId: string
): AzureSubscriptionSummary[] {
  const subscriptionMap = new Map(subscriptions.map((entry) => [entry.subscriptionId, entry]))
  const orderedIds = [
    activeSubscriptionId.trim(),
    ...current.map((entry) => entry.subscriptionId),
    ...subscriptions.map((entry) => entry.subscriptionId)
  ].filter(Boolean)

  const dedupedIds = [...new Set(orderedIds)].slice(0, 8)
  return dedupedIds
    .map((subscriptionId) => {
      const live = subscriptionMap.get(subscriptionId)
      if (live) {
        return live
      }

      const persisted = current.find((entry) => entry.subscriptionId === subscriptionId)
      if (!persisted) {
        return null
      }

      return {
        id: persisted.subscriptionId,
        subscriptionId: persisted.subscriptionId,
        displayName: persisted.displayName || persisted.subscriptionId,
        state: 'Persisted',
        tenantId: persisted.tenantId,
        authorizationSource: '',
        managedByTenants: []
      } satisfies AzureSubscriptionSummary
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
}

function sortSubscriptionsByRecent(subscriptions: AzureSubscriptionSummary[], recentSubscriptions: AzureSubscriptionSummary[]): AzureSubscriptionSummary[] {
  const order = new Map(recentSubscriptions.map((entry, index) => [entry.subscriptionId, index]))
  return [...subscriptions].sort((left, right) => {
    const leftIndex = order.get(left.subscriptionId)
    const rightIndex = order.get(right.subscriptionId)
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER)
    }

    return left.displayName.localeCompare(right.displayName)
  })
}

function selectActiveTenantId(store: AzureFoundationStore, tenants: AzureTenantSummary[], subscriptions: AzureSubscriptionSummary[]): string {
  const requested = store.activeTenantId.trim()
  const availableTenantIds = new Set([
    ...tenants.map((entry) => entry.tenantId.trim()).filter(Boolean),
    ...subscriptions.map((entry) => entry.tenantId.trim()).filter(Boolean)
  ])

  if (requested && availableTenantIds.has(requested)) {
    return requested
  }

  return subscriptions.find((entry) => entry.tenantId.trim())?.tenantId.trim()
    || tenants.find((entry) => entry.tenantId.trim())?.tenantId.trim()
    || ''
}

function filterSubscriptionsByTenant(subscriptions: AzureSubscriptionSummary[], activeTenantId: string): AzureSubscriptionSummary[] {
  const normalizedTenantId = activeTenantId.trim()
  if (!normalizedTenantId) {
    return subscriptions
  }

  const filtered = subscriptions.filter((entry) => entry.tenantId.trim() === normalizedTenantId)
  return filtered.length > 0 ? filtered : subscriptions
}

function selectActiveSubscription(store: AzureFoundationStore, subscriptions: AzureSubscriptionSummary[]): AzureSubscriptionSummary | null {
  const requested = store.activeSubscriptionId.trim()
  if (requested) {
    const matched = subscriptions.find((entry) => entry.subscriptionId.trim() === requested)
    if (matched) {
      return matched
    }
  }

  return subscriptions[0] ?? null
}

function selectActiveLocation(store: AzureFoundationStore, locations: AzureLocationSummary[]): string {
  const requested = store.activeLocation.trim()
  if (requested && locations.some((entry) => entry.name === requested || entry.id === requested)) {
    return requested
  }

  return locations[0]?.name ?? ''
}

async function loadCliPath(): Promise<string> {
  try {
    const environmentHealth = await getEnvironmentHealthReport()
    return environmentHealth.tools.find((tool) => tool.id === 'azure-cli' && tool.found)?.path.trim() ?? ''
  } catch {
    return ''
  }
}

function toTenantSummary(entry: Record<string, unknown>): AzureTenantSummary {
  return {
    tenantId: trimToEmpty(entry.tenantId) || trimToEmpty(entry.tenantID),
    displayName: trimToEmpty(entry.displayName) || trimToEmpty(entry.defaultDomain) || trimToEmpty(entry.tenantId) || trimToEmpty(entry.tenantID),
    defaultDomain: trimToEmpty(entry.defaultDomain),
    countryCode: trimToEmpty(entry.countryCode),
    tenantCategory: trimToEmpty(entry.tenantCategory)
  }
}

function toSubscriptionSummary(entry: Record<string, unknown>): AzureSubscriptionSummary {
  const managedByTenants = Array.isArray(entry.managedByTenants)
    ? entry.managedByTenants
      .map((tenant) => {
        if (tenant && typeof tenant === 'object' && !Array.isArray(tenant)) {
          return trimToEmpty((tenant as Record<string, unknown>).tenantId)
        }

        return trimToEmpty(tenant)
      })
      .filter(Boolean)
    : []

  return {
    id: trimToEmpty(entry.id) || trimToEmpty(entry.subscriptionId),
    subscriptionId: trimToEmpty(entry.subscriptionId) || trimToEmpty(entry.subscriptionID) || trimToEmpty(entry.id),
    displayName: trimToEmpty(entry.displayName) || trimToEmpty(entry.name) || trimToEmpty(entry.subscriptionName) || trimToEmpty(entry.subscriptionId) || trimToEmpty(entry.id),
    state: trimToEmpty(entry.state) || 'Unknown',
    tenantId: trimToEmpty(entry.tenantId) || trimToEmpty(entry.homeTenantId),
    authorizationSource: trimToEmpty(entry.authorizationSource),
    managedByTenants
  }
}

function isWindowsBatchFile(command: string): boolean {
  if (process.platform !== 'win32') {
    return false
  }

  const ext = path.extname(command.trim()).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

async function runAzureCliJson<T>(args: string[]): Promise<T> {
  const cliPath = await loadCliPath()
  const resolved = cliPath || (process.platform === 'win32' ? 'az.cmd' : 'az')
  const fullArgs = [...args, '--output', 'json']

  const [command, execArgs] = isWindowsBatchFile(resolved)
    ? ['cmd.exe', ['/d', '/c', resolved, ...fullArgs]]
    : [resolved, fullArgs]

  const { stdout } = await execFileAsync(command, execArgs, {
    windowsHide: true,
    timeout: 20000,
    env: process.env
  })

  return JSON.parse(stdout) as T
}

async function loadAzureCliCatalogData(): Promise<Pick<AzureCatalogData, 'tenants' | 'subscriptions'>> {
  const [tenantResult, subscriptionResult, currentAccountResult] = await Promise.allSettled([
    runAzureCliJson<Record<string, unknown>[]>(['account', 'tenant', 'list']),
    runAzureCliJson<Record<string, unknown>[]>(['account', 'list', '--all']),
    runAzureCliJson<Record<string, unknown>>(['account', 'show'])
  ])

  const tenantRecords = tenantResult.status === 'fulfilled'
    ? tenantResult.value
    : []
  const subscriptionRecords = subscriptionResult.status === 'fulfilled'
    ? subscriptionResult.value
    : []
  const currentAccountRecord = currentAccountResult.status === 'fulfilled'
    ? currentAccountResult.value
    : null

  const tenants = tenantRecords
    .map(toTenantSummary)
    .filter((entry) => entry.tenantId)

  const subscriptions = subscriptionRecords
    .map(toSubscriptionSummary)
    .filter((entry) => entry.subscriptionId)

  const currentSubscription = currentAccountRecord
    ? toSubscriptionSummary(currentAccountRecord)
    : null

  if (currentSubscription?.subscriptionId && !subscriptions.some((entry) => entry.subscriptionId === currentSubscription.subscriptionId)) {
    subscriptions.unshift(currentSubscription)
  }

  if (currentSubscription?.tenantId && !tenants.some((entry) => entry.tenantId === currentSubscription.tenantId)) {
    tenants.unshift({
      tenantId: currentSubscription.tenantId,
      displayName: currentSubscription.tenantId,
      defaultDomain: '',
      countryCode: '',
      tenantCategory: ''
    })
  }

  return {
    tenants,
    subscriptions
  }
}

async function loadAzureCliLocations(subscriptionId: string): Promise<AzureLocationSummary[]> {
  if (!subscriptionId.trim()) {
    return []
  }

  try {
    const response = await runAzureCliJson<{ value?: Record<string, unknown>[] }>([
      'rest',
      '--method',
      'get',
      '--uri',
      `https://management.azure.com/subscriptions/${encodeURIComponent(subscriptionId)}/locations?api-version=2022-12-01`
    ])
    const records = Array.isArray(response.value) ? response.value : []
    return records
      .map(toLocationSummary)
      .filter((entry) => entry.name)
  } catch {
    return []
  }
}

async function loadAzureCliProviderRegistrations(subscriptionId: string): Promise<AzureProviderRegistrationSummary[]> {
  if (!subscriptionId.trim()) {
    return []
  }

  try {
    const records = await runAzureCliJson<Record<string, unknown>[]>(['provider', 'list', '--subscription', subscriptionId])
    return records
      .map(toProviderRegistrationSummary)
      .filter((entry) => REQUIRED_PROVIDER_NAMESPACES.includes(entry.namespace))
  } catch {
    return []
  }
}

function toLocationSummary(entry: Record<string, unknown>): AzureLocationSummary {
  const pairedRegionIds = Array.isArray(entry.metadata && typeof entry.metadata === 'object' ? (entry.metadata as Record<string, unknown>).pairedRegion : undefined)
    ? ((entry.metadata as Record<string, unknown>).pairedRegion as unknown[])
      .map((paired) => {
        if (paired && typeof paired === 'object' && !Array.isArray(paired)) {
          return trimToEmpty((paired as Record<string, unknown>).name)
        }

        return trimToEmpty(paired)
      })
      .filter(Boolean)
    : []

  return {
    id: trimToEmpty(entry.id) || trimToEmpty(entry.name),
    name: trimToEmpty(entry.name),
    regionalDisplayName: trimToEmpty(entry.regionalDisplayName) || trimToEmpty(entry.displayName) || trimToEmpty(entry.name),
    pairedRegionIds
  }
}

function toProviderRegistrationSummary(entry: Record<string, unknown>): AzureProviderRegistrationSummary {
  return {
    namespace: trimToEmpty(entry.namespace),
    registrationState: trimToEmpty(entry.registrationState) || 'Unknown'
  }
}

async function loadAzureCatalogData(activeSubscriptionId: string): Promise<AzureCatalogData> {
  const cliCatalog = await loadAzureCliCatalogData()
  const tenants = cliCatalog.tenants
  const subscriptions = cliCatalog.subscriptions

  let locations: AzureLocationSummary[] = []
  let providerRegistrations: AzureProviderRegistrationSummary[] = []

  if (activeSubscriptionId) {
    const [cliLocations, cliProviders] = await Promise.all([
      loadAzureCliLocations(activeSubscriptionId),
      loadAzureCliProviderRegistrations(activeSubscriptionId)
    ])
    locations = cliLocations
    providerRegistrations = cliProviders
  }

  return {
    tenants,
    subscriptions,
    locations,
    providerRegistrations
  }
}

function buildDiagnostics(params: {
  auth: AzureAuthSessionState
  cliPath: string
  activeTenantId: string
  activeSubscriptionId: string
  subscriptions: AzureSubscriptionSummary[]
  providerRegistrations: AzureProviderRegistrationSummary[]
}): AzureContextDiagnostic[] {
  const diagnostics: AzureContextDiagnostic[] = []
  const accessMode = getEnterpriseSettings().accessMode
  const authenticated = params.auth.status === 'authenticated'

  const addDiagnostic = (
    code: AzureContextDiagnosticCode,
    severity: AzureContextDiagnostic['severity'],
    title: string,
    detail: string,
    remediation: string
  ): void => {
    diagnostics.push({ code, severity, title, detail, remediation })
  }

  if (params.auth.status === 'signed-out') {
    addDiagnostic(
      'missing-auth',
      'error',
      'Azure sign-in is required',
      'The Azure provider context could not find a local az login session, so tenant and subscription discovery is unavailable.',
      'Run az login on this machine or start the browser sign-in flow here.'
    )
  } else if (params.auth.status === 'error') {
    addDiagnostic(
      'expired-auth',
      'error',
      'Azure authentication failed',
      params.auth.lastError || 'The previous Azure sign-in attempt did not complete successfully.',
      'Retry the device-code flow and confirm the selected tenant or account can access Azure Resource Manager.'
    )
  }

  if (authenticated && !params.activeSubscriptionId) {
    addDiagnostic(
      'missing-subscription',
      'error',
      'No active Azure subscription is selected',
      'The account is authenticated, but no subscription is currently bound to the Azure provider context.',
      'Pick a subscription so shared workspaces, terminal context, and Azure pages can target a real ARM scope.'
    )
  }

  if (authenticated && params.subscriptions.length === 0) {
    addDiagnostic(
      'insufficient-access',
      'warning',
      'No accessible subscriptions were discovered',
      'The signed-in account authenticated successfully but did not return any ARM subscriptions.',
      'Verify the account has at least Reader access on a subscription and that the intended tenant is selected.'
    )
  }

  const unregisteredProviders = params.providerRegistrations.filter((entry) => entry.registrationState.toLowerCase() !== 'registered')
  if (authenticated && params.activeSubscriptionId && unregisteredProviders.length > 0) {
    addDiagnostic(
      'provider-registration',
      'warning',
      'Required Azure resource providers are not fully registered',
      `${unregisteredProviders.map((entry) => `${entry.namespace} (${entry.registrationState || 'Unknown'})`).join(', ')} still need attention on the active subscription.`,
      'Register the missing providers before treating empty service inventory as a permission problem.'
    )
  }

  if (!params.cliPath) {
    addDiagnostic(
      'cli-guidance',
      'info',
      'Azure CLI is optional but not detected',
      'The app uses Azure SDKs for core context resolution, but local `az` tooling is still helpful for shell validation and migration guidance.',
      'Install Azure CLI only if you want optional shell guidance and side-by-side troubleshooting.'
    )
  }

  if (accessMode !== 'operator') {
    addDiagnostic(
      'read-only-mode',
      'info',
      'Workspace is currently read-only',
      'Azure context is available, but terminal mutations and operator actions are disabled by workspace policy.',
      'Switch the workspace to operator mode when you are ready to allow terminal and write paths.'
    )
  }

  if (authenticated && params.activeTenantId) {
    addDiagnostic(
      'insufficient-access',
      'info',
      'Tenant context is active',
      `Azure context is currently scoped through tenant ${params.activeTenantId}.`,
      'If expected subscriptions are missing, verify the tenant selection before escalating permissions.'
    )
  }

  return diagnostics
}

async function buildAzureProviderContextSnapshot(): Promise<AzureProviderContextSnapshot> {
  if (runtimeState.skipAmbientDiscoveryOnce) {
    runtimeState.skipAmbientDiscoveryOnce = false
  } else if (runtimeState.credentialSource !== 'azure-cli' && !runtimeState.authFlow) {
    await tryHydrateAmbientAzureCredential()
  }

  const store = readAzureFoundationStore()
  const cliPath = await loadCliPath()
  const auth = runtimeState.auth
  const authenticated = auth.status === 'authenticated' && runtimeState.credentialSource === 'azure-cli'

  let tenants: AzureTenantSummary[] = []
  let subscriptions: AzureSubscriptionSummary[] = []
  let locations: AzureLocationSummary[] = []
  let providerRegistrations: AzureProviderRegistrationSummary[] = []

  if (authenticated) {
    const existingCache = runtimeState.catalogCache
    if (existingCache && existingCache.subscriptionId === store.activeSubscriptionId.trim()) {
      tenants = existingCache.data.tenants
      subscriptions = existingCache.data.subscriptions
      locations = existingCache.data.locations
      providerRegistrations = existingCache.data.providerRegistrations
    } else {
      const catalog = await loadAzureCatalogData(store.activeSubscriptionId.trim())
      tenants = catalog.tenants
      subscriptions = catalog.subscriptions

      const activeTenantId = selectActiveTenantId(store, tenants, subscriptions)
      const scopedSubscriptions = filterSubscriptionsByTenant(subscriptions, activeTenantId)
      const activeSubscription = selectActiveSubscription(store, scopedSubscriptions)
      const activeSubscriptionId = activeSubscription?.subscriptionId ?? ''

      if (activeSubscriptionId && activeSubscriptionId !== store.activeSubscriptionId) {
        const refreshed = updateAzureFoundationStore({
          activeTenantId,
          activeSubscriptionId,
          recentSubscriptionIds: mergeRecentSubscriptionIds(store.recentSubscriptionIds, activeSubscriptionId)
        })
        const refreshedCatalog = await loadAzureCatalogData(refreshed.activeSubscriptionId)
        tenants = refreshedCatalog.tenants
        subscriptions = refreshedCatalog.subscriptions
        locations = refreshedCatalog.locations
        providerRegistrations = refreshedCatalog.providerRegistrations
      } else {
        locations = catalog.locations
        providerRegistrations = catalog.providerRegistrations
      }
    }
  }

  const refreshedStore = readAzureFoundationStore()
  const activeTenantId = selectActiveTenantId(refreshedStore, tenants, subscriptions)
  const scopedSubscriptions = filterSubscriptionsByTenant(subscriptions, activeTenantId)
  const activeSubscription = selectActiveSubscription(refreshedStore, scopedSubscriptions)
  const activeSubscriptionId = activeSubscription?.subscriptionId ?? ''
  const activeLocation = selectActiveLocation(refreshedStore, locations)
  const activeTenant = tenants.find((entry) => entry.tenantId === activeTenantId) ?? null

  if (authenticated && activeSubscriptionId) {
    runtimeState.catalogCache = {
      subscriptionId: activeSubscriptionId,
      data: { tenants, subscriptions, locations, providerRegistrations },
      cliPath
    }
  }
  const activeAccountLabel = activeSubscription
    ? `${activeSubscription.displayName} (${activeSubscription.subscriptionId})`
    : activeTenant
      ? activeTenant.displayName || activeTenant.tenantId
      : authenticated
        ? 'Azure account context pending'
        : 'No Azure session detected'
  const recentSubscriptionIds = activeSubscriptionId
    ? mergeRecentSubscriptionIds(refreshedStore.recentSubscriptionIds, activeSubscriptionId)
    : refreshedStore.recentSubscriptionIds.filter((entry) => scopedSubscriptions.some((subscription) => subscription.subscriptionId === entry))
  const recentSubscriptions = mergeRecentSubscriptions(refreshedStore.recentSubscriptions, scopedSubscriptions, activeSubscriptionId)
  const orderedSubscriptions = sortSubscriptionsByRecent(scopedSubscriptions, recentSubscriptions)

  if (
    activeTenantId !== refreshedStore.activeTenantId
    || activeSubscriptionId !== refreshedStore.activeSubscriptionId
    || activeLocation !== refreshedStore.activeLocation
    || recentSubscriptionIds.join('|') !== refreshedStore.recentSubscriptionIds.join('|')
    || recentSubscriptions.map((entry) => `${entry.subscriptionId}:${entry.displayName}:${entry.tenantId}`).join('|')
      !== refreshedStore.recentSubscriptions.map((entry) => `${entry.subscriptionId}:${entry.displayName}:${entry.tenantId}`).join('|')
  ) {
    updateAzureFoundationStore({
      activeTenantId,
      activeSubscriptionId,
      activeLocation,
      recentSubscriptionIds,
      recentSubscriptions: recentSubscriptions.map((entry) => ({
        subscriptionId: entry.subscriptionId,
        displayName: entry.displayName,
        tenantId: entry.tenantId
      }))
    })
  }

  return {
    loadedAt: new Date().toISOString(),
    auth: runtimeState.auth,
    cloudName: 'AzureCloud',
    cliPath,
    activeTenantId,
    activeSubscriptionId,
    activeLocation,
    activeAccountLabel,
    tenants,
    subscriptions: orderedSubscriptions,
    locations,
    recentSubscriptionIds,
    recentSubscriptions,
    providerRegistrations,
    diagnostics: buildDiagnostics({
      auth: runtimeState.auth,
      cliPath,
      activeTenantId,
      activeSubscriptionId,
      subscriptions: orderedSubscriptions,
      providerRegistrations
    })
  }
}

function buildSnapshotFromCache(
  cache: CatalogCache,
  store: AzureFoundationStore
): AzureProviderContextSnapshot {
  const { tenants, subscriptions, locations, providerRegistrations } = cache.data
  const cliPath = cache.cliPath

  const activeTenantId = selectActiveTenantId(store, tenants, subscriptions)
  const scopedSubscriptions = filterSubscriptionsByTenant(subscriptions, activeTenantId)
  const activeSubscription = selectActiveSubscription(store, scopedSubscriptions)
  const activeSubscriptionId = activeSubscription?.subscriptionId ?? ''
  const activeLocation = selectActiveLocation(store, locations)
  const activeTenant = tenants.find((entry) => entry.tenantId === activeTenantId) ?? null
  const activeAccountLabel = activeSubscription
    ? `${activeSubscription.displayName} (${activeSubscription.subscriptionId})`
    : activeTenant
      ? activeTenant.displayName || activeTenant.tenantId
      : 'Azure account context pending'
  const recentSubscriptionIds = activeSubscriptionId
    ? mergeRecentSubscriptionIds(store.recentSubscriptionIds, activeSubscriptionId)
    : store.recentSubscriptionIds.filter((entry) =>
        scopedSubscriptions.some((sub) => sub.subscriptionId === entry)
      )
  const recentSubscriptions = mergeRecentSubscriptions(
    store.recentSubscriptions,
    scopedSubscriptions,
    activeSubscriptionId
  )
  const orderedSubscriptions = sortSubscriptionsByRecent(scopedSubscriptions, recentSubscriptions)

  if (
    activeTenantId !== store.activeTenantId
    || activeSubscriptionId !== store.activeSubscriptionId
    || activeLocation !== store.activeLocation
    || recentSubscriptionIds.join('|') !== store.recentSubscriptionIds.join('|')
    || recentSubscriptions.map((e) => `${e.subscriptionId}:${e.displayName}:${e.tenantId}`).join('|')
      !== store.recentSubscriptions.map((e) => `${e.subscriptionId}:${e.displayName}:${e.tenantId}`).join('|')
  ) {
    updateAzureFoundationStore({
      activeTenantId,
      activeSubscriptionId,
      activeLocation,
      recentSubscriptionIds,
      recentSubscriptions: recentSubscriptions.map((entry) => ({
        subscriptionId: entry.subscriptionId,
        displayName: entry.displayName,
        tenantId: entry.tenantId
      }))
    })
  }

  return {
    loadedAt: new Date().toISOString(),
    auth: runtimeState.auth,
    cloudName: 'AzureCloud',
    cliPath,
    activeTenantId,
    activeSubscriptionId,
    activeLocation,
    activeAccountLabel,
    tenants,
    subscriptions: orderedSubscriptions,
    locations,
    recentSubscriptionIds,
    recentSubscriptions,
    providerRegistrations,
    diagnostics: buildDiagnostics({
      auth: runtimeState.auth,
      cliPath,
      activeTenantId,
      activeSubscriptionId,
      subscriptions: orderedSubscriptions,
      providerRegistrations
    })
  }
}

export async function getAzureProviderContext(): Promise<AzureProviderContextSnapshot> {
  try {
    return await buildAzureProviderContextSnapshot()
  } catch (error) {
    const lastError = formatAzureError(error)
    writeAuthState({
      status: runtimeState.credentialSource === 'azure-cli' ? 'error' : 'signed-out',
      message: runtimeState.credentialSource === 'azure-cli'
        ? 'Azure account context failed to refresh.'
        : 'No local az login session was found. Start browser sign-in to connect Azure.',
      prompt: null,
      lastError
    })

    return {
      loadedAt: new Date().toISOString(),
      auth: runtimeState.auth,
      cloudName: 'AzureCloud',
      cliPath: await loadCliPath(),
      activeTenantId: '',
      activeSubscriptionId: '',
      activeLocation: '',
      activeAccountLabel: runtimeState.credentialSource === 'azure-cli' ? 'Azure context unavailable' : 'No local az login session found',
      tenants: [],
      subscriptions: [],
      locations: [],
      recentSubscriptionIds: readAzureFoundationStore().recentSubscriptionIds,
      recentSubscriptions: mergeRecentSubscriptions(readAzureFoundationStore().recentSubscriptions, [], ''),
      providerRegistrations: [],
      diagnostics: buildDiagnostics({
        auth: runtimeState.auth,
        cliPath: '',
        activeTenantId: '',
        activeSubscriptionId: '',
        subscriptions: [],
        providerRegistrations: []
      })
    }
  }
}

export async function startAzureDeviceCodeSignIn(): Promise<AzureProviderContextSnapshot> {
  if (runtimeState.credentialSource === 'azure-cli' && runtimeState.auth.status === 'authenticated') {
    return getAzureProviderContext()
  }

  if (runtimeState.authFlow || runtimeState.authProcess) {
    return getAzureProviderContext()
  }

  const store = readAzureFoundationStore()
  const authRunId = runtimeState.authRunId + 1
  runtimeState.authRunId = authRunId
  writeAuthState({
    status: 'starting',
    message: 'Starting Azure CLI device-code sign-in.',
    prompt: null,
    lastError: ''
  })

  runtimeState.authFlow = (async () => {
    const cliPath = await loadCliPath()
    const command = cliPath || 'az'
    const args = ['login', '--use-device-code', '--output', 'json']
    const tenantId = store.activeTenantId.trim()

    if (tenantId) {
      args.push('--tenant', tenantId)
    }

    const child = spawn(command, args, {
      windowsHide: true,
      env: process.env
    })
    runtimeState.authProcess = child

    let combinedOutput = ''
    let promptPublished = false
    const maybePublishPrompt = (chunk: string): void => {
      combinedOutput = `${combinedOutput}\n${chunk}`.trim()
      if (promptPublished || runtimeState.authRunId !== authRunId) {
        return
      }

      const urlMatch = combinedOutput.match(/https?:\/\/[^\s)]+/i)
      const codeMatch = combinedOutput.match(/enter the code\s+([A-Z0-9-]+)/i)
      if (!urlMatch && !codeMatch) {
        return
      }

      promptPublished = true
      writeAuthState({
        status: 'waiting-for-device-code',
        message: 'Open the verification link and enter the Azure device code to finish sign-in.',
        prompt: {
          message: combinedOutput,
          userCode: codeMatch?.[1] ?? '',
          verificationUri: urlMatch?.[0] ?? ''
        },
        lastError: ''
      })
    }

    child.stdout.on('data', (buffer) => {
      maybePublishPrompt(String(buffer))
    })
    child.stderr.on('data', (buffer) => {
      maybePublishPrompt(String(buffer))
    })

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? 1))
      })

      if (runtimeState.authRunId !== authRunId) {
        return
      }

      if (exitCode !== 0) {
        throw new Error(combinedOutput || `az login exited with code ${exitCode}.`)
      }

      const cliCatalog = await loadAzureCliCatalogData()
      activateAzureCredential(
        'azure-cli',
        cliCatalog.subscriptions.length > 0
          ? 'Connected using the local az login session.'
          : 'Azure CLI sign-in completed, but no subscriptions were returned.'
      )
    } catch (error) {
      if (runtimeState.authRunId !== authRunId) {
        return
      }

      const message = formatAzureError(error)
      runtimeState.credentialSource = null
      writeAuthState({
        status: 'error',
        message: 'Azure sign-in failed.',
        prompt: null,
        lastError: message
      })
    } finally {
      runtimeState.authProcess = null
      if (runtimeState.authRunId === authRunId) {
        runtimeState.authFlow = null
      }
    }
  })()

  return getAzureProviderContext()
}

export async function signOutAzureProvider(): Promise<AzureProviderContextSnapshot> {
  runtimeState.skipAmbientDiscoveryOnce = true
  resetAuthState('No local az login session was found. Start browser sign-in to connect Azure.')
  return getAzureProviderContext()
}

export async function setAzureActiveTenant(tenantId: string): Promise<AzureProviderContextSnapshot> {
  runtimeState.catalogCache = null
  updateAzureFoundationStore({
    activeTenantId: tenantId.trim(),
    activeSubscriptionId: '',
    activeLocation: ''
  })
  return getAzureProviderContext()
}

export async function setAzureActiveSubscription(subscriptionId: string): Promise<AzureProviderContextSnapshot> {
  runtimeState.catalogCache = null
  const normalizedSubscriptionId = subscriptionId.trim()
  const matchedSubscription = (await getAzureProviderContext()).subscriptions.find((entry) => entry.subscriptionId === normalizedSubscriptionId) ?? null
  const currentStore = readAzureFoundationStore()
  const nextRecentSubscriptions = mergeRecentSubscriptions(currentStore.recentSubscriptions, matchedSubscription ? [matchedSubscription] : [], normalizedSubscriptionId)

  updateAzureFoundationStore({
    activeTenantId: matchedSubscription?.tenantId ?? currentStore.activeTenantId,
    activeSubscriptionId: normalizedSubscriptionId,
    activeLocation: '',
    recentSubscriptionIds: mergeRecentSubscriptionIds(currentStore.recentSubscriptionIds, normalizedSubscriptionId),
    recentSubscriptions: nextRecentSubscriptions.map((entry) => ({
      subscriptionId: entry.subscriptionId,
      displayName: entry.displayName,
      tenantId: entry.tenantId
    }))
  })
  return getAzureProviderContext()
}

export async function setAzureActiveLocation(location: string): Promise<AzureProviderContextSnapshot> {
  updateAzureFoundationStore({
    activeLocation: location.trim()
  })

  const cache = runtimeState.catalogCache
  const store = readAzureFoundationStore()
  if (
    cache
    && cache.subscriptionId === store.activeSubscriptionId.trim()
    && runtimeState.credentialSource === 'azure-cli'
    && runtimeState.auth.status === 'authenticated'
  ) {
    return buildSnapshotFromCache(cache, store)
  }

  return getAzureProviderContext()
}
