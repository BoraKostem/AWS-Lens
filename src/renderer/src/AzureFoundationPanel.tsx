import type { AzureProviderContextSnapshot } from '@shared/types'

type AzureFoundationMode = {
  id: string
  label: string
  detail: string
  status: string
}

function titleCaseStatus(status: string): string {
  return status.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

export function AzureFoundationPanel({
  snapshot,
  busy,
  error,
  modes,
  selectedModeId,
  onSelectMode,
  onRefresh,
  onSignIn,
  onSignOut,
  onSelectTenant,
  onSelectSubscription,
  onSelectLocation,
  onOpenVerification
}: {
  snapshot: AzureProviderContextSnapshot | null
  busy: boolean
  error: string
  modes: AzureFoundationMode[]
  selectedModeId: string
  onSelectMode: (modeId: string) => void
  onRefresh: () => void
  onSignIn: () => void
  onSignOut: () => void
  onSelectTenant: (tenantId: string) => void
  onSelectSubscription: (subscriptionId: string) => void
  onSelectLocation: (location: string) => void
  onOpenVerification: (url: string) => void
}): JSX.Element {
  const auth = snapshot?.auth
  const isAuthenticated = auth?.status === 'authenticated'
  const currentPrompt = auth?.prompt
  const subscriptions = snapshot?.subscriptions ?? []
  const tenants = snapshot?.tenants ?? []
  const locations = snapshot?.locations ?? []
  const diagnostics = snapshot?.diagnostics ?? []
  const recentSubscriptionIds = new Set(snapshot?.recentSubscriptionIds ?? [])

  return (
    <section className="provider-context-shell provider-context-shell-azure">
      <div className="provider-context-shell__header">
        <div>
          <div className="eyebrow">Azure Foundation</div>
          <h3>SDK-first connection and context foundation</h3>
          <p className="hero-path">
            Device-code sign-in, tenant selection, subscription memory, region binding, and remediation all resolve from one Azure provider snapshot.
          </p>
        </div>
        <div className={`provider-context-shell__status ${isAuthenticated ? 'ready' : ''}`}>
          <span>Auth State</span>
          <strong>{titleCaseStatus(auth?.status ?? 'signed-out')}</strong>
          <small>{auth?.message || 'Azure sign-in required.'}</small>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="provider-context-shell__footer">
        <small>
          {snapshot?.activeAccountLabel
            ? `Active Azure account: ${snapshot.activeAccountLabel}`
            : 'No Azure account context is active yet.'}
        </small>
        <div className="button-row">
          <button type="button" onClick={onRefresh} disabled={busy}>
            {busy ? 'Refreshing...' : 'Refresh context'}
          </button>
          {currentPrompt?.verificationUri ? (
            <button type="button" onClick={() => onOpenVerification(currentPrompt.verificationUri)}>
              Open verification page
            </button>
          ) : null}
          {isAuthenticated ? (
            <button type="button" onClick={onSignOut} disabled={busy}>
              Sign out
            </button>
          ) : (
            <button type="button" className="accent" onClick={onSignIn} disabled={busy}>
              {auth?.status === 'starting' || auth?.status === 'waiting-for-device-code' ? 'Waiting for sign-in...' : 'Sign in with device code'}
            </button>
          )}
        </div>
      </div>

      {currentPrompt ? (
        <div className="settings-environment-row provider-diagnostics-row">
          <div>
            <strong>Device code verification</strong>
            <p>{currentPrompt.message || 'Open the verification page and enter the device code shown below.'}</p>
            <small>
              Verification URL: {currentPrompt.verificationUri || 'Not provided yet'} | Code: {currentPrompt.userCode || 'Pending'}
            </small>
          </div>
          <div className="settings-environment-meta">
            <span className="settings-status-pill settings-status-pill-preview">pending</span>
          </div>
        </div>
      ) : null}

      <div className="provider-preview-grid">
        {modes.map((mode) => (
          <article
            key={mode.id}
            className={`profile-catalog-card provider-mode-card provider-mode-card-azure ${selectedModeId === mode.id ? 'active' : ''}`}
          >
            <div className="profile-catalog-status">
              <span>{mode.label}</span>
              <strong>{mode.status}</strong>
            </div>
            <p className="provider-mode-card-copy">{mode.detail}</p>
            <div className="button-row profile-catalog-actions">
              <button
                type="button"
                className={selectedModeId === mode.id ? 'accent' : ''}
                onClick={() => onSelectMode(mode.id)}
              >
                {selectedModeId === mode.id ? 'Selected' : 'Use mode'}
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="provider-discovery-grid">
        <section className="provider-discovery-column">
          <div className="provider-discovery-column__label">Tenants</div>
          <div className="provider-discovery-list">
            {tenants.length > 0 ? (
              tenants.map((tenant) => (
                <button
                  key={tenant.tenantId}
                  type="button"
                  className={`provider-discovery-item ${snapshot?.activeTenantId === tenant.tenantId ? 'active' : ''}`}
                  onClick={() => onSelectTenant(tenant.tenantId)}
                >
                  <strong>{tenant.displayName || tenant.tenantId}</strong>
                  <small>{tenant.defaultDomain || tenant.tenantId}</small>
                </button>
              ))
            ) : (
              <div className="provider-discovery-empty">
                Sign in to load Azure tenants.
              </div>
            )}
          </div>
        </section>
        <section className="provider-discovery-column">
          <div className="provider-discovery-column__label">Subscriptions</div>
          <div className="provider-discovery-list">
            {subscriptions.length > 0 ? (
              subscriptions.map((subscription) => (
                <button
                  key={subscription.subscriptionId}
                  type="button"
                  className={`provider-discovery-item ${snapshot?.activeSubscriptionId === subscription.subscriptionId ? 'active' : ''}`}
                  onClick={() => onSelectSubscription(subscription.subscriptionId)}
                >
                  <strong>{subscription.displayName}</strong>
                  <small>
                    {subscription.subscriptionId}
                    {recentSubscriptionIds.has(subscription.subscriptionId) ? ' | recent' : ''}
                  </small>
                </button>
              ))
            ) : (
              <div className="provider-discovery-empty">
                No Azure subscriptions are available for the current tenant selection.
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="provider-context-grid">
        <label className="field">
          <span>Cloud</span>
          <input value={snapshot?.cloudName ?? 'AzureCloud'} readOnly />
        </label>
        <label className="field">
          <span>Location</span>
          <select
            value={snapshot?.activeLocation ?? ''}
            onChange={(event) => onSelectLocation(event.target.value)}
            disabled={locations.length === 0}
          >
            {!snapshot?.activeLocation ? (
              <option value="" disabled>
                {locations.length > 0 ? 'Select location' : 'No locations loaded'}
              </option>
            ) : null}
            {locations.map((location) => (
              <option key={location.name} value={location.name}>
                {location.regionalDisplayName}
              </option>
            ))}
          </select>
          <small className="field-note">
            Selected Azure location is reused by runtime and shell entry points where a regional default matters.
          </small>
        </label>
        <label className="field">
          <span>CLI guidance</span>
          <input value={snapshot?.cliPath || 'Azure CLI not detected'} readOnly />
          <small className="field-note">
            Azure CLI is optional. SDK-backed auth and account discovery remain the primary product path.
          </small>
        </label>
      </div>

      <section className="provider-diagnostics-shell provider-diagnostics-shell-azure compact">
        <div className="provider-diagnostics-header">
          <div>
            <div className="eyebrow">Remediation</div>
            <h3>Azure context diagnostics</h3>
            <p className="hero-path">
              Distinct auth, permission, provider-registration, and subscription-state problems are surfaced here instead of collapsing into a generic preview error.
            </p>
          </div>
          <div className="provider-diagnostics-summary">
            <span className="provider-diagnostics-summary__chip">Azure</span>
            <strong>{diagnostics.length}</strong>
            <small>{diagnostics.length === 1 ? 'signal' : 'signals'}</small>
          </div>
        </div>
        <div className="provider-diagnostics-grid">
          <section className="provider-diagnostics-column">
            <div className="eyebrow">State</div>
            {diagnostics.length > 0 ? (
              diagnostics.map((diagnostic) => (
                <div key={`${diagnostic.code}-${diagnostic.title}`} className="settings-environment-row provider-diagnostics-row">
                  <div>
                    <strong>{diagnostic.title}</strong>
                    <p>{diagnostic.detail}</p>
                    <small>{diagnostic.remediation}</small>
                  </div>
                  <div className="settings-environment-meta">
                    <span className={`settings-status-pill settings-status-pill-${diagnostic.severity === 'error' ? 'preview' : diagnostic.severity === 'warning' ? 'unknown' : 'stable'}`}>
                      {diagnostic.severity}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="settings-static-muted">
                Sign in to start evaluating Azure diagnostics.
              </div>
            )}
          </section>
          <section className="provider-diagnostics-column">
            <div className="eyebrow">Provider Registration</div>
            {snapshot?.providerRegistrations.length ? (
              snapshot.providerRegistrations.map((provider) => (
                <div key={provider.namespace} className="settings-environment-row provider-diagnostics-row">
                  <div>
                    <strong>{provider.namespace}</strong>
                    <p>{provider.registrationState || 'Unknown'}</p>
                  </div>
                  <div className="settings-environment-meta">
                    <span className={`settings-status-pill settings-status-pill-${provider.registrationState.toLowerCase() === 'registered' ? 'stable' : 'unknown'}`}>
                      {provider.registrationState || 'Unknown'}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="settings-static-muted">
                Provider registration details appear after a subscription is selected.
              </div>
            )}
          </section>
        </div>
      </section>
    </section>
  )
}

