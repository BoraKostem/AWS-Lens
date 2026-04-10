import { useMemo } from 'react'

import type { AzureProviderContextSnapshot, AzureSubscriptionSummary } from '@shared/types'

function getAzureBadge(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return 'AZ'
  }

  return normalized
    .split(/[\s-]+/)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function buildSubscriptionMeta(
  subscription: AzureSubscriptionSummary,
  tenantLabel: string
): string[] {
  const meta = [tenantLabel || subscription.tenantId, subscription.subscriptionId].filter(Boolean)
  return meta.slice(0, 2)
}

export function AzureFoundationPanel({
  snapshot,
  busy,
  searchQuery,
  pinnedSubscriptionIds,
  onRefresh,
  onSignIn,
  onSignOut,
  onSelectSubscription,
  onTogglePinSubscription,
  onOpenVerification
}: {
  snapshot: AzureProviderContextSnapshot | null
  busy: boolean
  searchQuery: string
  pinnedSubscriptionIds: string[]
  onRefresh: () => void
  onSignIn: () => void
  onSignOut: () => void
  onSelectSubscription: (subscriptionId: string) => void
  onTogglePinSubscription: (subscriptionId: string) => void
  onOpenVerification: (url: string) => void
}): JSX.Element {
  const auth = snapshot?.auth
  const isAuthenticated = auth?.status === 'authenticated'
  const currentPrompt = auth?.prompt
  const subscriptions = snapshot?.subscriptions ?? []
  const recentSubscriptions = snapshot?.recentSubscriptions ?? []
  const selectedSubscriptionId = snapshot?.activeSubscriptionId ?? ''
  const tenantLabelById = useMemo(
    () => new Map((snapshot?.tenants ?? []).map((tenant) => [tenant.tenantId, tenant.displayName || tenant.defaultDomain || tenant.tenantId])),
    [snapshot?.tenants]
  )

  const filteredSubscriptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) {
      return subscriptions
    }

    return subscriptions.filter((subscription) => {
      const tenantLabel = tenantLabelById.get(subscription.tenantId) ?? ''
      return [
        subscription.displayName,
        subscription.subscriptionId,
        subscription.tenantId,
        tenantLabel
      ].some((value) => value.toLowerCase().includes(query))
    })
  }, [searchQuery, subscriptions, tenantLabelById])

  const recentSubscriptionIds = useMemo(
    () => new Set(recentSubscriptions.map((subscription) => subscription.subscriptionId)),
    [recentSubscriptions]
  )

  if (!isAuthenticated) {
    return (
      <div className="profile-catalog-empty profile-catalog-empty-guided">
        <div className="eyebrow">{currentPrompt ? 'Browser Sign-In' : 'Local Azure CLI'}</div>
        <h3>{currentPrompt ? 'Finish Azure sign-in in the browser' : 'No Azure subscriptions were loaded from az login'}</h3>
        <p className="hero-path">
          {currentPrompt
            ? currentPrompt.message || 'Open the Microsoft verification page and enter the device code to complete sign-in.'
            : 'This selector reads the local Azure CLI session first. If this machine has no az login session yet, start browser sign-in and the catalog will refresh automatically.'}
        </p>
        {currentPrompt ? (
          <p className="hero-path">
            URL: {currentPrompt.verificationUri || 'Pending'} | Code: {currentPrompt.userCode || 'Pending'}
          </p>
        ) : null}
        <div className="profile-catalog-empty__actions">
          {currentPrompt?.verificationUri ? (
            <button type="button" className="accent" onClick={() => onOpenVerification(currentPrompt.verificationUri)}>
              Open login page
            </button>
          ) : (
            <button type="button" className="accent" onClick={onSignIn} disabled={busy}>
              {busy ? 'Starting...' : 'Sign in via browser'}
            </button>
          )}
          <button type="button" onClick={onRefresh} disabled={busy}>
            {busy ? 'Refreshing...' : 'Refresh catalog'}
          </button>
          {currentPrompt ? (
            <button type="button" onClick={onSignOut} disabled={busy}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={`profile-catalog-grid ${filteredSubscriptions.length === 1 ? 'profile-catalog-grid-gcp-single' : ''}`}>
        {filteredSubscriptions.length > 0 ? (
          filteredSubscriptions.map((subscription) => {
            const tenantLabel = tenantLabelById.get(subscription.tenantId) ?? subscription.tenantId
            const meta = buildSubscriptionMeta(subscription, tenantLabel)

            return (
              <div key={subscription.subscriptionId} className={`profile-catalog-card ${selectedSubscriptionId === subscription.subscriptionId ? 'active' : ''}`}>
                <div className="profile-catalog-card-header">
                  <div className="profile-catalog-card-badge">{getAzureBadge(subscription.displayName || tenantLabel)}</div>
                  <div>
                    <div className="project-card-title">{subscription.displayName}</div>
                    <div className="project-card-meta">
                      {meta.map((value) => <span key={value}>{value}</span>)}
                    </div>
                  </div>
                </div>
                <div className="profile-catalog-status">
                  <span>{selectedSubscriptionId === subscription.subscriptionId ? 'Active context' : 'Available'}</span>
                  <div className="enterprise-card-status">
                    {recentSubscriptionIds.has(subscription.subscriptionId) ? <strong>Recent</strong> : null}
                    {pinnedSubscriptionIds.includes(subscription.subscriptionId) && <strong>Pinned</strong>}
                    <span className="enterprise-mode-pill read-only">{subscription.state || 'Unknown'}</span>
                  </div>
                </div>
                <div className="button-row profile-catalog-actions">
                  <button type="button" className="accent" onClick={() => onSelectSubscription(subscription.subscriptionId)}>
                    {selectedSubscriptionId === subscription.subscriptionId ? 'Selected' : 'Select'}
                  </button>
                  <button type="button" className={pinnedSubscriptionIds.includes(subscription.subscriptionId) ? 'active' : ''} onClick={() => onTogglePinSubscription(subscription.subscriptionId)}>
                    {pinnedSubscriptionIds.includes(subscription.subscriptionId) ? 'Unpin' : 'Pin'}
                  </button>
                </div>
              </div>
            )
          })
        ) : (
          <div className="profile-catalog-empty">
            <div className="eyebrow">No Matches</div>
            <h3>No Azure subscriptions match "{searchQuery.trim()}"</h3>
            <p className="hero-path">Try a different subscription id, display name, or tenant name.</p>
          </div>
        )}
      </div>
    </>
  )
}
