import type { AzureProviderContextSnapshot } from '@shared/types'

export type AzureProviderModeLike = {
  id: string
  label: string
  status: string
} | null

export type AzureProviderConsumptionState = {
  ready: boolean
  scopeKind: 'none' | 'tenant' | 'subscription'
  activeScopeLabel: string
  profileLabel: string
  profileMeta: string
  providerMeta: string
  previewContextLabel?: string
  previewContextDetail?: string
  footerHint: string
  activityLabel: string
  sidebarContextTitle: string
  sidebarContextDetail: string
}

function isAzureContextReady(
  mode: AzureProviderModeLike,
  snapshot: AzureProviderContextSnapshot | null
): boolean {
  if (!mode || !snapshot || snapshot.auth.status !== 'authenticated') {
    return false
  }

  if (mode.id === 'azure-tenant') {
    return Boolean(snapshot.activeTenantId.trim())
  }

  return Boolean(snapshot.activeSubscriptionId.trim())
}

export function buildAzureProviderConsumptionState(
  snapshot: AzureProviderContextSnapshot | null,
  selectedMode: AzureProviderModeLike
): AzureProviderConsumptionState {
  const ready = isAzureContextReady(selectedMode, snapshot)
  const scopeKind =
    selectedMode?.id === 'azure-tenant'
      ? 'tenant'
      : selectedMode
        ? 'subscription'
        : 'none'

  const activeTenant = snapshot?.tenants.find((entry) => entry.tenantId === snapshot.activeTenantId) ?? null
  const activeSubscription = snapshot?.subscriptions.find((entry) => entry.subscriptionId === snapshot.activeSubscriptionId) ?? null
  const activeLocation = snapshot?.activeLocation || 'global'
  const activeTenantLabel = activeTenant?.displayName || snapshot?.activeTenantId || ''
  const activeSubscriptionLabel = activeSubscription?.displayName || snapshot?.activeSubscriptionId || ''
  const activeScopeLabel =
    scopeKind === 'tenant'
      ? activeTenantLabel || selectedMode?.label || 'Azure context pending'
      : activeSubscriptionLabel || activeTenantLabel || selectedMode?.label || 'Azure context pending'

  const providerMeta = ready
    ? scopeKind === 'tenant'
      ? `Tenant: ${activeTenantLabel || '-'} | Location: ${activeLocation}`
      : `Subscription: ${activeSubscriptionLabel || '-'} | Location: ${activeLocation}`
    : selectedMode
      ? `Mode: ${selectedMode.label}`
      : 'Subscription or tenant'

  const profileMeta = ready
    ? `${selectedMode?.label || 'Azure context'} | ${activeLocation} ready`
    : selectedMode
      ? `${selectedMode.status} | finish Azure context`
      : 'Select a connection mode'

  const sidebarContextDetail = ready
    ? scopeKind === 'tenant'
      ? `Tenant ${activeTenantLabel || '-'} | Location ${activeLocation}`
      : `Tenant ${snapshot?.activeTenantId || '-'} | Subscription ${activeSubscriptionLabel || '-'}`
    : selectedMode
      ? 'Complete Azure sign-in and subscription selection to bind shell context.'
      : 'Open the Azure foundation panel to start SDK-backed sign-in and context selection.'

  const footerHint = ready
    ? scopeKind === 'tenant'
      ? `Azure env values are ready for tenant ${activeTenantLabel || snapshot?.activeTenantId || '-'} in ${activeLocation}. Open the terminal to use the selected Azure context.`
      : `Azure env values are ready for subscription ${activeSubscriptionLabel || '-'} in ${activeLocation}. Open the terminal to use the selected Azure context.`
    : selectedMode
      ? selectedMode.id === 'azure-tenant'
        ? `Complete Azure sign-in and tenant selection for ${selectedMode.label} before opening the terminal.`
        : 'Complete Azure sign-in and select a subscription before opening the terminal.'
      : 'Select an Azure connection mode before opening the terminal.'

  return {
    ready,
    scopeKind,
    activeScopeLabel,
    profileLabel: activeScopeLabel === 'Azure context pending' ? 'No profile selected' : activeScopeLabel,
    profileMeta,
    providerMeta,
    previewContextLabel: ready ? activeScopeLabel : undefined,
    previewContextDetail: ready ? `${activeLocation} | ${selectedMode?.label || 'Azure context'}` : undefined,
    footerHint,
    activityLabel: ready
      ? `${activeScopeLabel} | ${activeLocation}`
      : selectedMode
        ? `${selectedMode.label} selected`
        : 'Azure preview',
    sidebarContextTitle: ready ? activeLocation || activeScopeLabel : activeScopeLabel,
    sidebarContextDetail
  }
}
