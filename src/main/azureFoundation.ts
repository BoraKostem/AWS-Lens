import { DeviceCodeCredential } from '@azure/identity'
import { ResourceManagementClient } from '@azure/arm-resources'
import { SubscriptionClient } from '@azure/arm-subscriptions'

import type {
  AzureAuthSessionState,
  AzureAuthStatus,
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
  'Microsoft.Monitor'
]

type AzureCatalogData = {
  tenants: AzureTenantSummary[]
  subscriptions: AzureSubscriptionSummary[]
  locations: AzureLocationSummary[]
  providerRegistrations: AzureProviderRegistrationSummary[]
}

type RuntimeState = {
  auth: AzureAuthSessionState
  credential: DeviceCodeCredential | null
  authRunId: number
  authFlow: Promise<void> | null
}

const runtimeState: RuntimeState = {
  auth: {
    status: 'signed-out',
    message: 'Azure sign-in required.',
    prompt: null,
    signedInAt: '',
    lastError: ''
  },
  credential: null,
  authRunId: 0,
  authFlow: null
}

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

function resetAuthState(message = 'Azure sign-in required.'): AzureAuthSessionState {
  runtimeState.credential = null
  runtimeState.authRunId += 1
  runtimeState.authFlow = null
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
    subscriptionId: trimToEmpty(entry.subscriptionId) || trimToEmpty(entry.subscriptionID),
    displayName: trimToEmpty(entry.displayName) || trimToEmpty(entry.subscriptionName) || trimToEmpty(entry.subscriptionId),
    state: trimToEmpty(entry.state) || 'Unknown',
    tenantId: trimToEmpty(entry.tenantId) || trimToEmpty(entry.homeTenantId),
    authorizationSource: trimToEmpty(entry.authorizationSource),
    managedByTenants
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

async function listPagerEntries(pager: unknown): Promise<Record<string, unknown>[]> {
  if (!pager || typeof pager !== 'object' || !(Symbol.asyncIterator in pager)) {
    return []
  }

  const results: Record<string, unknown>[] = []
  for await (const entry of pager as AsyncIterable<unknown>) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      results.push(entry as Record<string, unknown>)
    }
  }

  return results
}

async function loadAzureCatalogData(credential: DeviceCodeCredential, activeSubscriptionId: string): Promise<AzureCatalogData> {
  const subscriptionClient = new SubscriptionClient(credential) as unknown as {
    tenants?: { list?: () => unknown }
    subscriptions?: {
      list?: () => unknown
      listLocations?: (subscriptionId: string) => unknown
    }
  }

  const tenants = (await listPagerEntries(subscriptionClient.tenants?.list?.()))
    .map(toTenantSummary)
    .filter((entry) => entry.tenantId)

  const subscriptions = (await listPagerEntries(subscriptionClient.subscriptions?.list?.()))
    .map(toSubscriptionSummary)
    .filter((entry) => entry.subscriptionId)

  let locations: AzureLocationSummary[] = []
  let providerRegistrations: AzureProviderRegistrationSummary[] = []

  if (activeSubscriptionId) {
    locations = (await listPagerEntries(subscriptionClient.subscriptions?.listLocations?.(activeSubscriptionId)))
      .map(toLocationSummary)
      .filter((entry) => entry.name)

    const resourceManagementClient = new ResourceManagementClient(credential, activeSubscriptionId) as unknown as {
      providers?: { list?: () => unknown }
    }
    providerRegistrations = (await listPagerEntries(resourceManagementClient.providers?.list?.()))
      .map(toProviderRegistrationSummary)
      .filter((entry) => REQUIRED_PROVIDER_NAMESPACES.includes(entry.namespace))
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
      'The Azure provider context cannot load subscriptions or locations until the user completes a device-code sign-in.',
      'Start the Azure sign-in flow and complete the device-code verification step.'
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
  const store = readAzureFoundationStore()
  const cliPath = await loadCliPath()
  const auth = runtimeState.auth
  const authenticated = auth.status === 'authenticated' && runtimeState.credential !== null

  let tenants: AzureTenantSummary[] = []
  let subscriptions: AzureSubscriptionSummary[] = []
  let locations: AzureLocationSummary[] = []
  let providerRegistrations: AzureProviderRegistrationSummary[] = []

  if (authenticated && runtimeState.credential) {
    const catalog = await loadAzureCatalogData(runtimeState.credential, store.activeSubscriptionId.trim())
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
      const refreshedCatalog = await loadAzureCatalogData(runtimeState.credential, refreshed.activeSubscriptionId)
      tenants = refreshedCatalog.tenants
      subscriptions = refreshedCatalog.subscriptions
      locations = refreshedCatalog.locations
      providerRegistrations = refreshedCatalog.providerRegistrations
    } else {
      locations = catalog.locations
      providerRegistrations = catalog.providerRegistrations
    }
  }

  const refreshedStore = readAzureFoundationStore()
  const activeTenantId = selectActiveTenantId(refreshedStore, tenants, subscriptions)
  const scopedSubscriptions = filterSubscriptionsByTenant(subscriptions, activeTenantId)
  const activeSubscription = selectActiveSubscription(refreshedStore, scopedSubscriptions)
  const activeSubscriptionId = activeSubscription?.subscriptionId ?? ''
  const activeLocation = selectActiveLocation(refreshedStore, locations)
  const activeTenant = tenants.find((entry) => entry.tenantId === activeTenantId) ?? null
  const activeAccountLabel = activeSubscription
    ? `${activeSubscription.displayName} (${activeSubscription.subscriptionId})`
    : activeTenant
      ? activeTenant.displayName || activeTenant.tenantId
      : authenticated
        ? 'Azure account context pending'
        : 'Azure sign-in required'
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

export async function getAzureProviderContext(): Promise<AzureProviderContextSnapshot> {
  try {
    return await buildAzureProviderContextSnapshot()
  } catch (error) {
    const lastError = formatAzureError(error)
    writeAuthState({
      status: runtimeState.credential ? 'error' : 'signed-out',
      message: runtimeState.credential
        ? 'Azure account context failed to refresh.'
        : 'Azure sign-in required.',
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
      activeAccountLabel: 'Azure context unavailable',
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
  if (runtimeState.authFlow) {
    return getAzureProviderContext()
  }

  const store = readAzureFoundationStore()
  const authRunId = runtimeState.authRunId + 1
  runtimeState.authRunId = authRunId

  const credential = new DeviceCodeCredential({
    tenantId: store.activeTenantId.trim() || undefined,
    additionallyAllowedTenants: ['*'],
    userPromptCallback: async (info: {
      message?: string
      userCode?: string
      verificationUri?: string
      verificationUriComplete?: string
    }) => {
      if (runtimeState.authRunId !== authRunId) {
        return
      }

      writeAuthState({
        status: 'waiting-for-device-code',
        message: 'Open the verification link and enter the Azure device code to finish sign-in.',
        prompt: {
          message: trimToEmpty(info.message),
          userCode: trimToEmpty(info.userCode),
          verificationUri: trimToEmpty(info.verificationUri)
            || trimToEmpty(info.verificationUriComplete)
        },
        lastError: ''
      })
    }
  })

  runtimeState.credential = credential
  writeAuthState({
    status: 'starting',
    message: 'Starting Azure device-code sign-in.',
    prompt: null,
    lastError: ''
  })

  runtimeState.authFlow = (async () => {
    try {
      await credential.getToken(MANAGEMENT_SCOPE)
      if (runtimeState.authRunId !== authRunId) {
        return
      }

      const signedInAt = new Date().toISOString()
      writeAuthState({
        status: 'authenticated',
        message: 'Azure account context is ready.',
        prompt: null,
        signedInAt,
        lastError: ''
      })
      updateAzureFoundationStore({
        lastSignedInAt: signedInAt,
        lastError: ''
      })
    } catch (error) {
      if (runtimeState.authRunId !== authRunId) {
        return
      }

      const message = formatAzureError(error)
      runtimeState.credential = null
      writeAuthState({
        status: 'error',
        message: 'Azure sign-in failed.',
        prompt: null,
        lastError: message
      })
    } finally {
      if (runtimeState.authRunId === authRunId) {
        runtimeState.authFlow = null
      }
    }
  })()

  return getAzureProviderContext()
}

export async function signOutAzureProvider(): Promise<AzureProviderContextSnapshot> {
  resetAuthState('Azure sign-in required.')
  return getAzureProviderContext()
}

export async function setAzureActiveTenant(tenantId: string): Promise<AzureProviderContextSnapshot> {
  updateAzureFoundationStore({
    activeTenantId: tenantId.trim(),
    activeSubscriptionId: '',
    activeLocation: ''
  })
  return getAzureProviderContext()
}

export async function setAzureActiveSubscription(subscriptionId: string): Promise<AzureProviderContextSnapshot> {
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
  return getAzureProviderContext()
}
