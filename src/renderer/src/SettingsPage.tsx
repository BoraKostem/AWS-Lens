import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CollapsibleInfoPanel } from './CollapsibleInfoPanel'
import { ProviderPermissionDiagnosticsPanel } from './ProviderPermissionDiagnosticsPanel'
import { VaultManagerPanel } from './VaultManagerPanel'

import type {
  AppReleaseInfo,
  AppSecuritySummary,
  AppSettings,
  AwsProfile,
  AwsRegionOption,
  AzureProviderContextSnapshot,
  CloudProviderId,
  EnterpriseAccessMode,
  EnterpriseAuditEvent,
  EnterpriseSettings,
  EnvironmentPermissionCheck,
  EnvironmentHealthReport,
  EnvironmentToolCheck,
  GcpCliContext,
  GovernanceTagDefaults,
  ProviderDescriptor,
  TerraformCliInfo
} from '@shared/types'
import type { ProviderPermissionDiagnosticsReport } from './providerPermissionDiagnostics'

type SettingsTab = 'general' | 'terminal' | 'refresh' | 'governance' | 'toolchain' | 'updates' | 'security'

type SettingsPageProps = {
  isVisible: boolean
  appSettings: AppSettings | null
  providers: ProviderDescriptor[]
  providerConnectionModes: Record<CloudProviderId, Array<{ id: string; label: string }>>
  profiles: AwsProfile[]
  regions: AwsRegionOption[]
  gcpCliContext: GcpCliContext | null
  azureProviderContext: AzureProviderContextSnapshot | null
  toolchainInfo: TerraformCliInfo | null
  securitySummary: AppSecuritySummary | null
  enterpriseSettings: EnterpriseSettings
  auditSummary: {
    total: number
    blocked: number
    failed: number
  }
  auditEvents: EnterpriseAuditEvent[]
  activeSessionLabel: string
  releaseInfo: AppReleaseInfo | null
  releaseStateLabel: string
  releaseStateTone: string
  environmentHealth: EnvironmentHealthReport | null
  providerPermissionDiagnostics: ProviderPermissionDiagnosticsReport
  environmentBusy: boolean
  governanceDefaults: GovernanceTagDefaults | null
  toolchainBusy: boolean
  enterpriseBusy: boolean
  settingsMessage: string
  onUpdateGeneralSettings: (update: AppSettings['general']) => void
  onUpdateTerminalSettings: (update: AppSettings['terminal']) => void
  onUpdateRefreshSettings: (update: AppSettings['refresh']) => void
  onUpdateGovernanceDefaults: (update: GovernanceTagDefaults) => void
  onUpdateToolchainSettings: (update: AppSettings['toolchain']) => void
  onUpdatePreferences: (update: AppSettings['updates']) => void
  onAccessModeChange: (accessMode: EnterpriseAccessMode) => void
  onAuditExport: () => void
  onDiagnosticsExport: () => void
  onClearActiveSession: () => void
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
  onInstallUpdate: () => void
  onOpenReleasePage: () => void
  onRefreshEnvironment: () => void
}

const TAB_ITEMS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'App' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'refresh', label: 'Refresh' },
  { id: 'governance', label: 'Governance' },
  { id: 'toolchain', label: 'Toolchain' },
  { id: 'updates', label: 'Updates' },
  { id: 'security', label: 'Security' }
]

const GENERAL_LAUNCH_SCREEN_OPTIONS: Array<{ value: AppSettings['general']['launchScreen']; label: string }> = [
  { value: 'profiles', label: 'Profile catalog' },
  { value: 'settings', label: 'Settings' },
  { value: 'session-hub', label: 'Session Hub' },
  { value: 'terraform', label: 'Terraform' },
  { value: 'overview', label: 'Overview' }
]

const RELEASE_CHANNEL_OPTIONS: Array<{ value: AppSettings['updates']['releaseChannel']; label: string }> = [
  { value: 'system', label: 'System / build default' },
  { value: 'stable', label: 'Stable' },
  { value: 'preview', label: 'Preview' }
]

const TERMINAL_SHELL_OPTIONS: Array<{ value: AppSettings['terminal']['shellPreference']; label: string }> = [
  { value: '', label: 'System default' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'pwsh', label: 'PowerShell 7' },
  { value: 'cmd', label: 'Command Prompt' },
  { value: 'bash', label: 'Bash' },
  { value: 'zsh', label: 'Zsh' }
]

function formatRefreshInterval(seconds: number): string {
  if (seconds <= 0) return 'Disabled'
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function environmentToolTone(status: EnvironmentToolCheck['status']): 'stable' | 'preview' | 'unknown' {
  return status === 'available' ? 'stable' : status === 'missing' ? 'preview' : 'unknown'
}

function environmentPermissionTone(status: EnvironmentPermissionCheck['status']): 'stable' | 'preview' | 'unknown' {
  return status === 'ok' ? 'stable' : status === 'error' ? 'preview' : 'unknown'
}

function mergeDistinctStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function SettingSection({
  title,
  children
}: {
  title: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="settings-tab-section">
      <div className="settings-tab-section__title">{title}</div>
      <div className="settings-tab-section__body">{children}</div>
    </section>
  )
}

function SettingRow({
  label,
  description,
  children
}: {
  label: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong>{label}</strong>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  )
}

export function SettingsPage({
  isVisible,
  appSettings,
  providers,
  providerConnectionModes,
  profiles,
  regions,
  gcpCliContext,
  azureProviderContext,
  toolchainInfo,
  securitySummary,
  enterpriseSettings,
  auditSummary,
  auditEvents,
  activeSessionLabel,
  releaseInfo,
  releaseStateLabel,
  releaseStateTone,
  environmentHealth,
  providerPermissionDiagnostics,
  environmentBusy,
  governanceDefaults,
  toolchainBusy,
  enterpriseBusy,
  settingsMessage,
  onUpdateGeneralSettings,
  onUpdateTerminalSettings,
  onUpdateRefreshSettings,
  onUpdateGovernanceDefaults,
  onUpdateToolchainSettings,
  onUpdatePreferences,
  onAccessModeChange,
  onAuditExport,
  onDiagnosticsExport,
  onClearActiveSession,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenReleasePage,
  onRefreshEnvironment
}: SettingsPageProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [generalDraft, setGeneralDraft] = useState<AppSettings['general']>({
    defaultProviderId: 'aws',
    defaultProfileName: '',
    defaultRegion: 'us-east-1',
    gcpDefaultModeId: 'gcp-adc',
    gcpDefaultProjectId: '',
    gcpDefaultLocation: 'us-central1',
    azureDefaultModeId: 'azure-subscription',
    azureDefaultSubscriptionId: '',
    azureDefaultSubscriptionLabel: '',
    azureDefaultTenantId: '',
    azureDefaultLocation: '',
    launchScreen: 'profiles'
  })
  const [terminalDraft, setTerminalDraft] = useState<AppSettings['terminal']>({
    autoOpen: false,
    defaultCommand: '',
    fontSize: 13,
    shellPreference: ''
  })
  const [refreshDraft, setRefreshDraft] = useState<AppSettings['refresh']>({
    autoRefreshIntervalSeconds: 0,
    heavyScreenMode: 'manual'
  })
  const [governanceDraft, setGovernanceDraft] = useState<GovernanceTagDefaults>({
    inheritByDefault: true,
    values: {
      Owner: '',
      Environment: '',
      Project: '',
      CostCenter: ''
    },
    updatedAt: ''
  })
  const [toolchainDraft, setToolchainDraft] = useState<AppSettings['toolchain']>({
    preferredTerraformCliKind: '',
    terraformPathOverride: '',
    opentofuPathOverride: '',
    terragruntPathOverride: '',
    awsCliPathOverride: '',
    gcloudPathOverride: '',
    azureCliPathOverride: '',
    kubectlPathOverride: '',
    dockerPathOverride: ''
  })
  const [updateDraft, setUpdateDraft] = useState<AppSettings['updates']>({
    releaseChannel: 'system',
    autoDownload: false
  })

  useEffect(() => {
    if (!appSettings) return
    setGeneralDraft(appSettings.general)
    setTerminalDraft(appSettings.terminal)
    setRefreshDraft(appSettings.refresh)
    setToolchainDraft(appSettings.toolchain)
    setUpdateDraft(appSettings.updates)
  }, [appSettings])

  useEffect(() => {
    if (!governanceDefaults) return
    setGovernanceDraft(governanceDefaults)
  }, [governanceDefaults])

  const releaseNotesPreview = releaseInfo?.latestRelease.notes?.trim() || 'No release notes are available yet.'
  const releasePackagingLabel = !releaseInfo?.supportsAutoUpdate
    ? 'Dev shell or unpackaged build'
    : releaseInfo.updateMechanism === 'electron-updater'
      ? 'Packaged auto-update flow'
      : 'Release check only'
  const selectedTabLabel = TAB_ITEMS.find((item) => item.id === activeTab)?.label ?? 'App'

  const toolchainSummary = useMemo(() => {
    if (!toolchainInfo) return 'CLI state loading'
    if (!toolchainInfo.found) return toolchainInfo.error || 'No CLI detected'
    return `${toolchainInfo.label} ${toolchainInfo.version}`
  }, [toolchainInfo])

  const selectedStartupProvider = useMemo<ProviderDescriptor>(() => (
    providers.find((provider) => provider.id === generalDraft.defaultProviderId) ?? providers[0] ?? {
      id: 'aws',
      label: 'AWS',
      shortLabel: 'AWS',
      availability: 'available',
      profileLabel: 'Profile',
      locationLabel: 'Region',
      connectionLabel: 'AWS profile or assumed role'
    }
  ), [generalDraft.defaultProviderId, providers])

  const selectedStartupProviderModes = providerConnectionModes[selectedStartupProvider.id] ?? []
  const selectedAzureSubscription = useMemo(
    () => azureProviderContext?.subscriptions.find((subscription) => subscription.subscriptionId === generalDraft.azureDefaultSubscriptionId) ?? null,
    [azureProviderContext?.subscriptions, generalDraft.azureDefaultSubscriptionId]
  )
  const gcpLocationOptions = useMemo(
    () => mergeDistinctStrings([
      generalDraft.gcpDefaultLocation,
      ...(gcpCliContext?.locations ?? []),
      gcpCliContext?.activeRegion,
      gcpCliContext?.activeZone
    ]),
    [gcpCliContext?.activeRegion, gcpCliContext?.activeZone, gcpCliContext?.locations, generalDraft.gcpDefaultLocation]
  )
  const azureLocationOptions = useMemo(
    () => mergeDistinctStrings([
      generalDraft.azureDefaultLocation,
      ...(selectedAzureSubscription?.locations ?? []),
      ...(azureProviderContext?.locations.map((location) => location.name) ?? []),
      azureProviderContext?.activeLocation
    ]),
    [
      azureProviderContext?.activeLocation,
      azureProviderContext?.locations,
      generalDraft.azureDefaultLocation,
      selectedAzureSubscription?.locations
    ]
  )

  function renderGeneralTab(): JSX.Element {
    const selectedProviderId = generalDraft.defaultProviderId
    const selectedModeId = selectedProviderId === 'gcp'
      ? generalDraft.gcpDefaultModeId
      : selectedProviderId === 'azure'
        ? generalDraft.azureDefaultModeId
        : ''

    return (
      <>
        <SettingSection title="Startup">
          <SettingRow label="Startup provider" description="Choose which cloud provider should be preselected when the app shell opens.">
            <select
              value={selectedProviderId}
              onChange={(event) => setGeneralDraft((current) => ({
                ...current,
                defaultProviderId: event.target.value as CloudProviderId
              }))}
              disabled={!appSettings}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </SettingRow>
          {selectedProviderId !== 'aws' && (
            <SettingRow
              label="Connection mode"
              description={`Choose which ${selectedStartupProvider.label} context model should seed the shared shell.`}
            >
              <select
                value={selectedModeId}
                onChange={(event) => setGeneralDraft((current) => (
                  selectedProviderId === 'gcp'
                    ? { ...current, gcpDefaultModeId: event.target.value }
                    : { ...current, azureDefaultModeId: event.target.value }
                ))}
                disabled={!appSettings}
              >
                {selectedStartupProviderModes.map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.label}</option>
                ))}
                {!selectedStartupProviderModes.some((mode) => mode.id === selectedModeId) && selectedModeId && (
                  <option value={selectedModeId}>{selectedModeId}</option>
                )}
              </select>
            </SettingRow>
          )}
          <SettingRow
            label={`Default ${selectedStartupProvider.profileLabel.toLowerCase()}`}
            description={`Choose which ${selectedStartupProvider.profileLabel.toLowerCase()} the shell should restore for ${selectedStartupProvider.label}.`}
          >
            {selectedProviderId === 'aws' ? (
              <select
                value={generalDraft.defaultProfileName}
                onChange={(event) => setGeneralDraft((current) => ({ ...current, defaultProfileName: event.target.value }))}
                disabled={!appSettings}
              >
                <option value="">Follow manual selection</option>
                {profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>{profile.name}</option>
                ))}
              </select>
            ) : selectedProviderId === 'gcp' ? (
              <select
                value={generalDraft.gcpDefaultProjectId}
                onChange={(event) => setGeneralDraft((current) => ({ ...current, gcpDefaultProjectId: event.target.value }))}
                disabled={!appSettings}
              >
                <option value="">Follow detected project</option>
                {(gcpCliContext?.projects ?? []).map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {project.projectId}{project.name ? ` - ${project.name}` : ''}
                  </option>
                ))}
                {generalDraft.gcpDefaultProjectId && !(gcpCliContext?.projects ?? []).some((project) => project.projectId === generalDraft.gcpDefaultProjectId) && (
                  <option value={generalDraft.gcpDefaultProjectId}>{generalDraft.gcpDefaultProjectId}</option>
                )}
              </select>
            ) : (
              <select
                value={generalDraft.azureDefaultSubscriptionId}
                onChange={(event) => {
                  const subscriptionId = event.target.value
                  const subscription = azureProviderContext?.subscriptions.find((entry) => entry.subscriptionId === subscriptionId) ?? null
                  const nextLocations = mergeDistinctStrings([
                    generalDraft.azureDefaultLocation,
                    ...(subscription?.locations ?? []),
                    ...(azureProviderContext?.locations.map((location) => location.name) ?? [])
                  ])

                  setGeneralDraft((current) => ({
                    ...current,
                    azureDefaultSubscriptionId: subscriptionId,
                    azureDefaultSubscriptionLabel: subscription?.displayName ?? '',
                    azureDefaultTenantId: subscription?.tenantId ?? '',
                    azureDefaultLocation: subscriptionId
                      ? (nextLocations.includes(current.azureDefaultLocation) ? current.azureDefaultLocation : nextLocations[0] ?? '')
                      : current.azureDefaultLocation
                  }))
                }}
                disabled={!appSettings}
              >
                <option value="">Follow active subscription</option>
                {(azureProviderContext?.subscriptions ?? []).map((subscription) => (
                  <option key={subscription.subscriptionId} value={subscription.subscriptionId}>
                    {subscription.displayName || subscription.subscriptionId}
                  </option>
                ))}
                {generalDraft.azureDefaultSubscriptionId
                  && !(azureProviderContext?.subscriptions ?? []).some((subscription) => subscription.subscriptionId === generalDraft.azureDefaultSubscriptionId) && (
                  <option value={generalDraft.azureDefaultSubscriptionId}>
                    {generalDraft.azureDefaultSubscriptionLabel || generalDraft.azureDefaultSubscriptionId}
                  </option>
                )}
              </select>
            )}
          </SettingRow>
          <SettingRow
            label={`Default ${selectedStartupProvider.locationLabel.toLowerCase()}`}
            description={`Used when ${selectedStartupProvider.label} opens without an explicit ${selectedStartupProvider.locationLabel.toLowerCase()} context.`}
          >
            {selectedProviderId === 'aws' ? (
              <select
                value={generalDraft.defaultRegion}
                onChange={(event) => setGeneralDraft((current) => ({ ...current, defaultRegion: event.target.value }))}
                disabled={!appSettings}
              >
                {regions.map((region) => (
                  <option key={region.id} value={region.id}>{region.id} - {region.name}</option>
                ))}
                {!regions.some((region) => region.id === generalDraft.defaultRegion) && (
                  <option value={generalDraft.defaultRegion}>{generalDraft.defaultRegion}</option>
                )}
              </select>
            ) : selectedProviderId === 'gcp' ? (
              <select
                value={generalDraft.gcpDefaultLocation}
                onChange={(event) => setGeneralDraft((current) => ({ ...current, gcpDefaultLocation: event.target.value }))}
                disabled={!appSettings}
              >
                {gcpLocationOptions.map((location) => (
                  <option key={location} value={location}>{location}</option>
                ))}
                {!gcpLocationOptions.includes(generalDraft.gcpDefaultLocation) && (
                  <option value={generalDraft.gcpDefaultLocation}>{generalDraft.gcpDefaultLocation}</option>
                )}
              </select>
            ) : (
              <select
                value={generalDraft.azureDefaultLocation}
                onChange={(event) => setGeneralDraft((current) => ({ ...current, azureDefaultLocation: event.target.value }))}
                disabled={!appSettings}
              >
                {azureLocationOptions.length === 0 ? (
                  <option value="">
                    {selectedAzureSubscription ? 'Select location' : 'Load Azure context to list locations'}
                  </option>
                ) : (
                  azureLocationOptions.map((location) => (
                    <option key={location} value={location}>{location}</option>
                  ))
                )}
                {!azureLocationOptions.includes(generalDraft.azureDefaultLocation) && generalDraft.azureDefaultLocation && (
                  <option value={generalDraft.azureDefaultLocation}>{generalDraft.azureDefaultLocation}</option>
                )}
              </select>
            )}
          </SettingRow>
          <SettingRow label="Launch screen" description="Choose which workspace opens first after the shell loads.">
            <select
              value={generalDraft.launchScreen}
              onChange={(event) => setGeneralDraft((current) => ({
                ...current,
                launchScreen: event.target.value as AppSettings['general']['launchScreen']
              }))}
              disabled={!appSettings}
            >
              {GENERAL_LAUNCH_SCREEN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </SettingRow>
        </SettingSection>

        <div className="settings-tab-actions">
          <button type="button" className="accent" disabled={!appSettings} onClick={() => onUpdateGeneralSettings(generalDraft)}>
            Save startup preferences
          </button>
        </div>
      </>
    )
  }

  function renderTerminalTab(): JSX.Element {
    return (
      <>
        <SettingSection title="Terminal">
          <SettingRow label="Automatically open terminal" description="Open the terminal drawer automatically when an operator-capable session becomes active.">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={terminalDraft.autoOpen}
                onChange={(event) => setTerminalDraft((current) => ({ ...current, autoOpen: event.target.checked }))}
                disabled={!appSettings}
              />
              <span>{terminalDraft.autoOpen ? 'On' : 'Off'}</span>
            </label>
          </SettingRow>
          <SettingRow label="Default command" description="Run this command when a fresh terminal tab opens. Leave empty to start idle.">
            <input
              value={terminalDraft.defaultCommand}
              onChange={(event) => setTerminalDraft((current) => ({ ...current, defaultCommand: event.target.value }))}
              placeholder="Optional startup command"
              disabled={!appSettings}
            />
          </SettingRow>
          <SettingRow label="Font size" description="Controls the xterm surface size used in the drawer.">
            <input
              type="number"
              min={10}
              max={24}
              value={terminalDraft.fontSize}
              onChange={(event) => setTerminalDraft((current) => ({ ...current, fontSize: Number(event.target.value) || 13 }))}
              disabled={!appSettings}
            />
          </SettingRow>
          <SettingRow label="Shell preference" description="Stored now for shell routing. Current terminal execution still follows the existing runtime launch flow.">
            <select
              value={terminalDraft.shellPreference}
              onChange={(event) => setTerminalDraft((current) => ({
                ...current,
                shellPreference: event.target.value as AppSettings['terminal']['shellPreference']
              }))}
              disabled={!appSettings}
            >
              {TERMINAL_SHELL_OPTIONS.map((option) => (
                <option key={option.value || 'system'} value={option.value}>{option.label}</option>
              ))}
            </select>
          </SettingRow>
        </SettingSection>

        <div className="settings-tab-actions">
          <button type="button" className="accent" disabled={!appSettings} onClick={() => onUpdateTerminalSettings(terminalDraft)}>
            Save terminal preferences
          </button>
        </div>
      </>
    )
  }

  function renderRefreshTab(): JSX.Element {
    return (
      <>
        <SettingSection title="Refresh Policy">
          <SettingRow label="Automatic refresh interval" description="Set to 0 to disable background refresh entirely.">
            <input
              type="number"
              min={0}
              step={30}
              value={refreshDraft.autoRefreshIntervalSeconds}
              onChange={(event) => setRefreshDraft((current) => ({
                ...current,
                autoRefreshIntervalSeconds: Math.max(0, Number(event.target.value) || 0)
              }))}
              disabled={!appSettings}
            />
          </SettingRow>
          <SettingRow label="Heavy screen behavior" description="Choose whether expensive screens may refresh automatically.">
            <select
              value={refreshDraft.heavyScreenMode}
              onChange={(event) => setRefreshDraft((current) => ({
                ...current,
                heavyScreenMode: event.target.value as AppSettings['refresh']['heavyScreenMode']
              }))}
              disabled={!appSettings}
            >
              <option value="manual">Manual only</option>
              <option value="automatic">Allow automatic refresh</option>
            </select>
          </SettingRow>
        </SettingSection>

        <SettingSection title="Current State">
          <SettingRow label="Saved interval">
            <div className="settings-static-value">{formatRefreshInterval(appSettings?.refresh.autoRefreshIntervalSeconds ?? 0)}</div>
          </SettingRow>
          <SettingRow label="Heavy screens">
            <div className="settings-static-value">{appSettings?.refresh.heavyScreenMode ?? 'manual'}</div>
          </SettingRow>
        </SettingSection>

        <div className="settings-tab-actions">
          <button type="button" className="accent" disabled={!appSettings} onClick={() => onUpdateRefreshSettings(refreshDraft)}>
            Save refresh preferences
          </button>
        </div>
      </>
    )
  }

  function renderGovernanceTab(): JSX.Element {
    const configuredValues = Object.entries(governanceDraft.values).filter(([, value]) => value.trim())

    return (
      <>
        <SettingSection title="Default Tags">
          <SettingRow label="Apply defaults automatically" description="When enabled, the shell applies the saved Owner, Environment, Project, and CostCenter tags to supported resource workflows it creates.">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={governanceDraft.inheritByDefault}
                onChange={(event) => setGovernanceDraft((current) => ({
                  ...current,
                  inheritByDefault: event.target.checked
                }))}
                disabled={!governanceDefaults}
              />
              <span>{governanceDraft.inheritByDefault ? 'On' : 'Off'}</span>
            </label>
          </SettingRow>
          <SettingRow label="Owner">
            <input
              value={governanceDraft.values.Owner}
              onChange={(event) => setGovernanceDraft((current) => ({
                ...current,
                values: { ...current.values, Owner: event.target.value }
              }))}
              placeholder="team or operator"
              disabled={!governanceDefaults}
            />
          </SettingRow>
          <SettingRow label="Environment">
            <input
              value={governanceDraft.values.Environment}
              onChange={(event) => setGovernanceDraft((current) => ({
                ...current,
                values: { ...current.values, Environment: event.target.value }
              }))}
              placeholder="prod, staging, dev"
              disabled={!governanceDefaults}
            />
          </SettingRow>
          <SettingRow label="Project">
            <input
              value={governanceDraft.values.Project}
              onChange={(event) => setGovernanceDraft((current) => ({
                ...current,
                values: { ...current.values, Project: event.target.value }
              }))}
              placeholder="service or initiative"
              disabled={!governanceDefaults}
            />
          </SettingRow>
          <SettingRow label="Cost center">
            <input
              value={governanceDraft.values.CostCenter}
              onChange={(event) => setGovernanceDraft((current) => ({
                ...current,
                values: { ...current.values, CostCenter: event.target.value }
              }))}
              placeholder="finance code"
              disabled={!governanceDefaults}
            />
          </SettingRow>
        </SettingSection>

        <SettingSection title="Current Coverage">
          <SettingRow label="Configured values" description="Only non-empty values are applied to new supported resources and the apply-defaults shortcuts.">
            <div className="settings-static-value">
              {configuredValues.length > 0
                ? configuredValues.map(([key, value]) => `${key}=${value}`).join(' | ')
                : 'No governance tag defaults configured'}
            </div>
          </SettingRow>
          <SettingRow label="Last updated">
            <div className="settings-static-value">
              {governanceDefaults?.updatedAt ? new Date(governanceDefaults.updatedAt).toLocaleString() : 'Not saved yet'}
            </div>
          </SettingRow>
        </SettingSection>

        <div className="settings-tab-actions">
          <button type="button" className="accent" disabled={!governanceDefaults} onClick={() => onUpdateGovernanceDefaults(governanceDraft)}>
            Save governance defaults
          </button>
        </div>
      </>
    )
  }

  function renderToolchainTab(): JSX.Element {
    const readyTools = environmentHealth?.tools.filter((tool) => tool.status === 'available') ?? []
    const attentionTools = environmentHealth?.tools.filter((tool) => tool.status !== 'available') ?? []
    const readyPermissions = environmentHealth?.permissions.filter((item) => item.status === 'ok') ?? []
    const attentionPermissions = environmentHealth?.permissions.filter((item) => item.status !== 'ok') ?? []

    return (
      <>
        <SettingSection title="CLI Preferences">
          <SettingRow label="Preferred Terraform family" description="Bind the existing Terraform/OpenTofu detection flow to a preferred runtime.">
            <select
              value={toolchainDraft.preferredTerraformCliKind}
              onChange={(event) => setToolchainDraft((current) => ({
                ...current,
                preferredTerraformCliKind: event.target.value as AppSettings['toolchain']['preferredTerraformCliKind']
              }))}
              disabled={!appSettings || toolchainBusy}
            >
              <option value="">Auto detect</option>
              <option value="opentofu">OpenTofu</option>
              <option value="terraform">Terraform</option>
            </select>
          </SettingRow>
          <SettingRow label="Terraform path override">
            <input
              value={toolchainDraft.terraformPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, terraformPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
          <SettingRow label="OpenTofu path override">
            <input
              value={toolchainDraft.opentofuPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, opentofuPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
          <SettingRow label="Terragrunt path override">
            <input
              value={toolchainDraft.terragruntPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, terragruntPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
          <SettingRow label="AWS CLI path override">
            <input
              value={toolchainDraft.awsCliPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, awsCliPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
          <SettingRow label="Google Cloud CLI path override">
            <input
              value={toolchainDraft.gcloudPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, gcloudPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
          <SettingRow label="Azure CLI path override">
            <input
              value={toolchainDraft.azureCliPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, azureCliPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
          <SettingRow label="kubectl path override">
            <input
              value={toolchainDraft.kubectlPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, kubectlPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
          <SettingRow label="Docker path override">
            <input
              value={toolchainDraft.dockerPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, dockerPathOverride: event.target.value }))}
              placeholder="Optional executable path"
              disabled={!appSettings || toolchainBusy}
            />
          </SettingRow>
        </SettingSection>

        <SettingSection title="Environment Checks">
          <SettingRow label="Detected CLI" description={toolchainInfo?.found ? `Path: ${toolchainInfo.path || 'resolved by runtime'}` : (toolchainInfo?.error || 'No CLI detected yet.')}>
            <div className="settings-static-value">{toolchainSummary}</div>
          </SettingRow>
          <SettingRow label="Machine validation" description={environmentHealth?.summary ?? 'Run a rescan to refresh tool and permission state.'}>
            <button type="button" className="accent" disabled={environmentBusy} onClick={onRefreshEnvironment}>
              {environmentBusy ? 'Refreshing...' : 'Rescan environment'}
            </button>
          </SettingRow>
          {environmentHealth && (
            <div className="environment-onboarding-grid">
              <section className="environment-onboarding-section">
                <div className="eyebrow">Ready</div>
                {readyTools.map((tool) => (
                  <div key={tool.id} className="settings-environment-row">
                    <div>
                      <strong>{tool.label}</strong>
                      <p>{tool.detail}</p>
                      {tool.path && <small>Path: {tool.path}</small>}
                    </div>
                    <div className="settings-environment-meta">
                      <span className={`settings-status-pill settings-status-pill-${environmentToolTone(tool.status)}`}>{tool.status}</span>
                      <code>{tool.version || 'available'}</code>
                    </div>
                  </div>
                ))}
                {readyPermissions.map((item) => (
                  <div key={item.id} className="settings-environment-row">
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <div className="settings-environment-meta">
                      <span className={`settings-status-pill settings-status-pill-${environmentPermissionTone(item.status)}`}>{item.status}</span>
                    </div>
                  </div>
                ))}
                {readyTools.length === 0 && readyPermissions.length === 0 && (
                  <div className="settings-static-muted">No checks are marked ready yet.</div>
                )}
              </section>

              <section className="environment-onboarding-section">
                <div className="eyebrow">Needs Attention</div>
                {attentionTools.map((tool) => (
                  <div key={tool.id} className="settings-environment-row">
                    <div>
                      <strong>{tool.label}</strong>
                      <p>{tool.detail}</p>
                      {tool.remediation && <small>{tool.remediation}</small>}
                    </div>
                    <div className="settings-environment-meta">
                      <span className={`settings-status-pill settings-status-pill-${environmentToolTone(tool.status)}`}>{tool.status}</span>
                      <code>{tool.version || 'not found'}</code>
                    </div>
                  </div>
                ))}
                {attentionPermissions.map((item) => (
                  <div key={item.id} className="settings-environment-row">
                    <div>
                      <strong>{item.label}</strong>
                      <p>{item.detail}</p>
                      {item.remediation && <small>{item.remediation}</small>}
                    </div>
                    <div className="settings-environment-meta">
                      <span className={`settings-status-pill settings-status-pill-${environmentPermissionTone(item.status)}`}>{item.status}</span>
                    </div>
                  </div>
                ))}
                {attentionTools.length === 0 && attentionPermissions.length === 0 && (
                  <div className="settings-static-muted">Nothing currently needs attention.</div>
                )}
              </section>
            </div>
          )}
          {!environmentHealth && (
            <div className="settings-static-muted">
              {environmentBusy ? 'Inspecting installed CLIs and local permissions.' : 'Run a rescan to load detailed environment checks.'}
            </div>
          )}
        </SettingSection>

        <div className="settings-tab-actions">
          <button type="button" className="accent" disabled={!appSettings || toolchainBusy} onClick={() => onUpdateToolchainSettings(toolchainDraft)}>
            {toolchainBusy ? 'Saving...' : 'Save toolchain settings'}
          </button>
        </div>
      </>
    )
  }

  function renderUpdatesTab(): JSX.Element {
    return (
      <>
        <SettingSection title="Update Preferences">
          <SettingRow label="Release channel" description="Stable and preview now map to the persisted app preference, while system follows build defaults.">
            <select
              value={updateDraft.releaseChannel}
              onChange={(event) => setUpdateDraft((current) => ({
                ...current,
                releaseChannel: event.target.value as AppSettings['updates']['releaseChannel']
              }))}
              disabled={!appSettings}
            >
              {RELEASE_CHANNEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow label="Automatically download updates" description="Controls whether packaged builds begin downloading immediately after an update is found.">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={updateDraft.autoDownload}
                onChange={(event) => setUpdateDraft((current) => ({ ...current, autoDownload: event.target.checked }))}
                disabled={!appSettings}
              />
              <span>{updateDraft.autoDownload ? 'On' : 'Off'}</span>
            </label>
          </SettingRow>
        </SettingSection>

        <SettingSection title="Release Center">
          <div className="settings-update-overview">
            <div>
              <div className="eyebrow">Release Center</div>
              <h3>Updater, packaging, and release notes</h3>
              <p>Keep all release visibility here: update state, build channel, package behavior, and the latest published notes.</p>
            </div>
            <div className="settings-update-overview__badges">
              <span className={`settings-status-pill settings-status-pill-${releaseInfo?.currentBuild.channel ?? 'unknown'}`}>
                {releaseInfo?.currentBuild.channel ?? 'unknown'}
              </span>
              <span className={`settings-status-pill ${releaseStateTone}`}>{releaseStateLabel}</span>
            </div>
          </div>

          <div className="settings-update-stats">
            <div className="settings-update-stat">
              <span>Current</span>
              <strong>{releaseInfo?.currentVersion ? `v${releaseInfo.currentVersion}` : 'Unknown'}</strong>
            </div>
            <div className="settings-update-stat">
              <span>Selected channel</span>
              <strong>{releaseInfo?.selectedChannel ?? 'unknown'}</strong>
            </div>
            <div className="settings-update-stat">
              <span>Latest</span>
              <strong>{releaseInfo?.latestVersion ? `v${releaseInfo.latestVersion}` : 'Unavailable'}</strong>
            </div>
            <div className="settings-update-stat">
              <span>Packaging</span>
              <strong>{releasePackagingLabel}</strong>
            </div>
            <div className="settings-update-stat">
              <span>Published</span>
              <strong>{releaseInfo?.latestRelease.publishedAt ? new Date(releaseInfo.latestRelease.publishedAt).toLocaleDateString() : 'Unknown'}</strong>
            </div>
            <div className="settings-update-stat">
              <span>Last checked</span>
              <strong>
                {releaseInfo?.checkedAt
                  ? new Date(releaseInfo.checkedAt).toLocaleString()
                  : releaseInfo?.supportsAutoUpdate
                    ? 'Not checked yet'
                    : 'Disabled in dev build'}
              </strong>
            </div>
          </div>

          <div className="settings-release-notes">
            <div className="eyebrow">Release Notes</div>
            <pre>{releaseInfo?.error ?? releaseNotesPreview}</pre>
          </div>

          <div className="settings-action-row">
            <button type="button" className="accent" disabled={!releaseInfo?.canCheckForUpdates} onClick={onCheckForUpdates}>
              {releaseInfo?.checkStatus === 'checking' ? 'Checking...' : 'Check'}
            </button>
            <button type="button" disabled={!releaseInfo?.canDownloadUpdate} onClick={onDownloadUpdate}>
              {releaseInfo?.updateStatus === 'downloading' ? 'Downloading...' : 'Download'}
            </button>
            <button type="button" disabled={!releaseInfo?.canInstallUpdate} onClick={onInstallUpdate}>
              Install
            </button>
            <button type="button" onClick={onOpenReleasePage}>
              Full notes
            </button>
          </div>
        </SettingSection>

        <div className="settings-tab-actions">
          <button type="button" className="accent" disabled={!appSettings} onClick={() => onUpdatePreferences(updateDraft)}>
            Save update preferences
          </button>
        </div>
      </>
    )
  }

  function renderSecurityTab(): JSX.Element {
    return (
      <>
        <SettingSection title="Access Mode">
          <SettingRow label="Workspace mode" description="Read-only blocks mutations and command execution; operator enables critical actions and support workflows.">
            <div className="settings-inline-actions">
              <button
                type="button"
                className={enterpriseSettings.accessMode === 'read-only' ? 'accent' : ''}
                disabled={enterpriseBusy}
                onClick={() => onAccessModeChange('read-only')}
              >
                Read-only
              </button>
              <button
                type="button"
                className={enterpriseSettings.accessMode === 'operator' ? 'accent' : ''}
                disabled={enterpriseBusy}
                onClick={() => onAccessModeChange('operator')}
              >
                Operator
              </button>
            </div>
          </SettingRow>
          <SettingRow label="Updated">
            <div className="settings-static-value">{enterpriseSettings.updatedAt ? new Date(enterpriseSettings.updatedAt).toLocaleString() : 'Not yet changed'}</div>
          </SettingRow>
        </SettingSection>

        <SettingSection title="Vault Manager">
          <VaultManagerPanel
            active={isVisible && activeTab === 'security'}
            accessMode={enterpriseSettings.accessMode}
            securitySummary={securitySummary}
          />
        </SettingSection>

        <SettingSection title="Session State">
          <SettingRow label="Active session" description={activeSessionLabel || 'No active session pinned.'}>
            <button type="button" disabled={!activeSessionLabel} onClick={onClearActiveSession}>
              {activeSessionLabel ? 'Clear active session' : 'No active session'}
            </button>
          </SettingRow>
        </SettingSection>

        <SettingSection title="Audit and Support">
          <SettingRow label="Audit summary">
            <div className="settings-security-inline">
              <span>Total {auditSummary.total}</span>
              <span>Blocked {auditSummary.blocked}</span>
              <span>Failed {auditSummary.failed}</span>
            </div>
          </SettingRow>
          <SettingRow label="Exports">
            <div className="settings-inline-actions">
              <button type="button" disabled={enterpriseBusy || auditEvents.length === 0} onClick={onAuditExport}>
                Export audit
              </button>
              <button type="button" disabled={enterpriseBusy} onClick={onDiagnosticsExport}>
                Diagnostics bundle
              </button>
            </div>
          </SettingRow>
          <div className="settings-audit-compact-list">
            {auditEvents.slice(0, 6).map((event) => (
              <div key={event.id} className={`settings-audit-compact-item ${event.outcome}`}>
                <strong>{event.action}</strong>
                <span>{new Date(event.happenedAt).toLocaleString()}</span>
              </div>
            ))}
            {auditEvents.length === 0 && <div className="settings-static-muted">No audit events yet.</div>}
          </div>
        </SettingSection>

        <SettingSection title="Provider Permission Diagnostics">
          <ProviderPermissionDiagnosticsPanel report={providerPermissionDiagnostics} compact title="Current Provider" />
        </SettingSection>
      </>
    )
  }

  function renderActiveTab(): JSX.Element {
    switch (activeTab) {
      case 'terminal':
        return renderTerminalTab()
      case 'refresh':
        return renderRefreshTab()
      case 'governance':
        return renderGovernanceTab()
      case 'toolchain':
        return renderToolchainTab()
      case 'updates':
        return renderUpdatesTab()
      case 'security':
        return renderSecurityTab()
      case 'general':
      default:
        return renderGeneralTab()
    }
  }

  return (
    <section className="settings-page settings-page-minimal">
      <div className="settings-minimal-shell">
        <aside className="settings-sidebar">
          <div className="settings-sidebar__title">Preferences</div>
          <div className="settings-sidebar__list">
            {TAB_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`settings-sidebar__item ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => setActiveTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="settings-sidebar__meta">
            <span>Mode</span>
            <strong>{enterpriseSettings.accessMode === 'operator' ? 'Operator' : 'Read-only'}</strong>
            <span>Updater</span>
            <strong>{releaseStateLabel}</strong>
          </div>
        </aside>

        <div className="settings-content">
          <div className="settings-content__header">
            <div>
              <div className="eyebrow">Settings</div>
              <h2>{selectedTabLabel}</h2>
            </div>
            <div className="settings-page-header__meta">
              <span className={`settings-status-pill settings-status-pill-${releaseInfo?.currentBuild.channel ?? 'unknown'}`}>
                {releaseInfo?.currentBuild.channel ?? 'unknown'}
              </span>
              <span className={`settings-status-pill ${releaseStateTone}`}>{releaseStateLabel}</span>
            </div>
          </div>

          {settingsMessage && <div className="success-banner">{settingsMessage}</div>}

          <CollapsibleInfoPanel title="Quick Help" className="settings-info-panel">
            <div className="settings-tab-section__body">
              {activeTab === 'general' && <p>Set the default profile, region, and launch screen when you want the shell to boot into a predictable operator context.</p>}
              {activeTab === 'terminal' && <p>Terminal preferences control how the embedded shell opens after a session becomes active. Operator mode is still required for command execution.</p>}
              {activeTab === 'refresh' && <p>Use refresh policy to decide whether heavy screens re-query automatically or only on demand. Conservative defaults reduce surprise provider API traffic.</p>}
              {activeTab === 'governance' && <p>Governance defaults define reusable ownership tags that the shell can inherit into supported resource workflows and reapply from resource consoles across all providers.</p>}
              {activeTab === 'toolchain' && <p>Toolchain settings define which local CLI the shell should prefer and let you override Terraform, AWS, Google Cloud, and Azure executable paths when workstation PATH state is inconsistent.</p>}
              {activeTab === 'updates' && <p>Update preferences let you pin stable versus preview behavior, check release state manually, and decide whether packages download automatically.</p>}
              {activeTab === 'security' && <p>Security is the operational control plane for workspace mode, vault inventory, secret handling, audit export, diagnostics export, and active session review.</p>}
            </div>
          </CollapsibleInfoPanel>

          <div className="settings-tab-content">
            {renderActiveTab()}
          </div>
        </div>
      </div>
    </section>
  )
}
