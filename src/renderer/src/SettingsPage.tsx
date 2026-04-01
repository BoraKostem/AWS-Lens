import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CollapsibleInfoPanel } from './CollapsibleInfoPanel'

import type {
  AppReleaseInfo,
  AppSecuritySummary,
  AppSettings,
  AwsProfile,
  AwsRegionOption,
  EnterpriseAccessMode,
  EnterpriseAuditEvent,
  EnterpriseSettings,
  EnvironmentHealthReport,
  GovernanceTagDefaults,
  TerraformCliInfo
} from '@shared/types'

type SettingsTab = 'general' | 'terminal' | 'refresh' | 'governance' | 'toolchain' | 'updates' | 'security'

type SettingsPageProps = {
  appSettings: AppSettings | null
  profiles: AwsProfile[]
  regions: AwsRegionOption[]
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
  appSettings,
  profiles,
  regions,
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
    defaultProfileName: '',
    defaultRegion: 'us-east-1',
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
    awsCliPathOverride: '',
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

  const releaseNotesPreview = releaseInfo?.latestRelease.notes?.trim() ?? ''
  const selectedTabLabel = TAB_ITEMS.find((item) => item.id === activeTab)?.label ?? 'App'

  const toolchainSummary = useMemo(() => {
    if (!toolchainInfo) return 'CLI state loading'
    if (!toolchainInfo.found) return toolchainInfo.error || 'No CLI detected'
    return `${toolchainInfo.label} ${toolchainInfo.version}`
  }, [toolchainInfo])

  function renderGeneralTab(): JSX.Element {
    return (
      <>
        <SettingSection title="Startup">
          <SettingRow label="Default profile" description="Select the profile AWS Lens should prefer when no manual profile is pinned.">
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
          </SettingRow>
          <SettingRow label="Default region" description="Used when the workspace starts without an explicit region context.">
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
            Save app preferences
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
          <SettingRow label="Apply defaults automatically" description="When enabled, AWS Lens applies the saved Owner, Environment, Project, and CostCenter tags to supported EC2 workflows it creates.">
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
          <SettingRow label="Configured values" description="Only non-empty values are applied to new supported resources and the EC2 apply-defaults shortcuts.">
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
          <SettingRow label="AWS CLI path override">
            <input
              value={toolchainDraft.awsCliPathOverride}
              onChange={(event) => setToolchainDraft((current) => ({ ...current, awsCliPathOverride: event.target.value }))}
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

        <SettingSection title="Release State">
          <SettingRow label="Current version">
            <div className="settings-static-value">{releaseInfo?.currentVersion ? `v${releaseInfo.currentVersion}` : 'Unknown'}</div>
          </SettingRow>
          <SettingRow label="Selected channel">
            <div className="settings-static-value">{releaseInfo?.selectedChannel ?? 'unknown'}</div>
          </SettingRow>
          <SettingRow label="Latest release">
            <div className="settings-static-value">{releaseInfo?.latestVersion ? `v${releaseInfo.latestVersion}` : 'Unavailable'}</div>
          </SettingRow>
          <SettingRow label="Last checked">
            <div className="settings-static-value">
              {releaseInfo?.checkedAt
                ? new Date(releaseInfo.checkedAt).toLocaleString()
                : releaseInfo?.supportsAutoUpdate
                  ? 'Not checked yet'
                  : 'Disabled in dev build'}
            </div>
          </SettingRow>
          <SettingRow label="Release actions" description={releaseInfo?.error ?? (releaseNotesPreview || 'No release notes are available yet.')}>
            <div className="settings-inline-actions">
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
                Release page
              </button>
            </div>
          </SettingRow>
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

        <SettingSection title="Vault and Session State">
          <SettingRow label="Vault entries" description="Counts of encrypted local secrets tracked by AWS Lens.">
            <div className="settings-static-value">{securitySummary ? `${securitySummary.vaultEntryCounts.all} total` : 'Loading'}</div>
          </SettingRow>
          <SettingRow label="Breakdown">
            <div className="settings-security-inline">
              <span>AWS {securitySummary?.vaultEntryCounts.awsProfiles ?? '-'}</span>
              <span>SSH {securitySummary?.vaultEntryCounts.sshKeys ?? '-'}</span>
              <span>PEM {securitySummary?.vaultEntryCounts.pem ?? '-'}</span>
              <span>Keys {securitySummary?.vaultEntryCounts.accessKeys ?? '-'}</span>
            </div>
          </SettingRow>
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
              {activeTab === 'general' && <p>Set the default profile, region, and launch screen when you want AWS Lens to boot into a predictable operator context.</p>}
              {activeTab === 'terminal' && <p>Terminal preferences control how the embedded shell opens after a session becomes active. Operator mode is still required for command execution.</p>}
              {activeTab === 'refresh' && <p>Use refresh policy to decide whether heavy screens re-query automatically or only on demand. Conservative defaults reduce surprise AWS API traffic.</p>}
              {activeTab === 'governance' && <p>Governance defaults define reusable ownership tags that AWS Lens can inherit into supported EC2 workflows and reapply from resource consoles.</p>}
              {activeTab === 'toolchain' && <p>Toolchain settings define which local CLI AWS Lens should prefer and let you override executable paths when workstation PATH state is inconsistent.</p>}
              {activeTab === 'updates' && <p>Update preferences let you pin stable versus preview behavior, check release state manually, and decide whether packages download automatically.</p>}
              {activeTab === 'security' && <p>Security is the operational control plane for workspace mode, vault summary, audit export, diagnostics export, and active session review.</p>}
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
