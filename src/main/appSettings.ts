import path from 'node:path'

import { app } from 'electron'

import type {
  AppSettings,
  AppSettingsGeneral,
  AppSettingsFeatures,
  AppSettingsLaunchScreen,
  AppSettingsRefresh,
  AppSettingsRefreshMode,
  AppSettingsReleaseChannelPreference,
  AppSettingsTerminal,
  AppSettingsTerminalShellPreference,
  AppSettingsToolchain,
  AppSettingsUpdates,
  TerraformCliKind
} from '@shared/types'
import { getDefaultAppFeatureSettings, sanitizeAppFeatureSettings } from '@shared/featureFlags'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

const DEFAULT_APP_SETTINGS: AppSettings = {
  general: {
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
  },
  terminal: {
    autoOpen: false,
    defaultCommand: '',
    fontSize: 13,
    shellPreference: ''
  },
  refresh: {
    autoRefreshIntervalSeconds: 0,
    heavyScreenMode: 'manual'
  },
  toolchain: {
    preferredTerraformCliKind: '',
    terraformPathOverride: '',
    opentofuPathOverride: '',
    terragruntPathOverride: '',
    awsCliPathOverride: '',
    gcloudPathOverride: '',
    azureCliPathOverride: '',
    kubectlPathOverride: '',
    dockerPathOverride: ''
  },
  updates: {
    releaseChannel: 'system',
    autoDownload: false
  },
  features: getDefaultAppFeatureSettings()
}

function sanitizeFeatures(value: unknown): AppSettingsFeatures {
  return sanitizeAppFeatureSettings(value)
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'app-settings.json')
}

function sanitizeLaunchScreen(value: unknown): AppSettingsLaunchScreen {
  switch (value) {
    case 'settings':
    case 'overview':
    case 'session-hub':
    case 'terraform':
    case 'profiles':
      return value
    default:
      return DEFAULT_APP_SETTINGS.general.launchScreen
  }
}

function sanitizeProviderId(value: unknown): AppSettings['general']['defaultProviderId'] {
  switch (value) {
    case 'aws':
    case 'gcp':
    case 'azure':
      return value
    default:
      return DEFAULT_APP_SETTINGS.general.defaultProviderId
  }
}

function sanitizeShellPreference(value: unknown): AppSettingsTerminalShellPreference {
  switch (value) {
    case 'powershell':
    case 'pwsh':
    case 'cmd':
    case 'bash':
    case 'zsh':
    case '':
      return value
    default:
      return DEFAULT_APP_SETTINGS.terminal.shellPreference
  }
}

function sanitizeRefreshMode(value: unknown): AppSettingsRefreshMode {
  return value === 'automatic' ? 'automatic' : DEFAULT_APP_SETTINGS.refresh.heavyScreenMode
}

function sanitizeReleaseChannel(value: unknown): AppSettingsReleaseChannelPreference {
  switch (value) {
    case 'stable':
    case 'preview':
    case 'system':
      return value
    default:
      return DEFAULT_APP_SETTINGS.updates.releaseChannel
  }
}

function sanitizeTerraformCliKind(value: unknown): TerraformCliKind | '' {
  return value === 'terraform' || value === 'opentofu' ? value : ''
}

function sanitizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function sanitizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  const normalized = Math.round(value)
  return normalized >= 0 ? normalized : fallback
}

function sanitizeFontSize(value: unknown): number {
  const normalized = sanitizePositiveInteger(value, DEFAULT_APP_SETTINGS.terminal.fontSize)
  if (normalized < 10 || normalized > 24) {
    return DEFAULT_APP_SETTINGS.terminal.fontSize
  }

  return normalized
}

function sanitizeGeneral(value: unknown): AppSettingsGeneral {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    defaultProviderId: sanitizeProviderId(raw.defaultProviderId),
    defaultProfileName: sanitizeString(raw.defaultProfileName),
    defaultRegion: sanitizeString(raw.defaultRegion, DEFAULT_APP_SETTINGS.general.defaultRegion),
    gcpDefaultModeId: sanitizeString(raw.gcpDefaultModeId, DEFAULT_APP_SETTINGS.general.gcpDefaultModeId),
    gcpDefaultProjectId: sanitizeString(raw.gcpDefaultProjectId),
    gcpDefaultLocation: sanitizeString(raw.gcpDefaultLocation, DEFAULT_APP_SETTINGS.general.gcpDefaultLocation),
    azureDefaultModeId: sanitizeString(raw.azureDefaultModeId, DEFAULT_APP_SETTINGS.general.azureDefaultModeId),
    azureDefaultSubscriptionId: sanitizeString(raw.azureDefaultSubscriptionId),
    azureDefaultSubscriptionLabel: sanitizeString(raw.azureDefaultSubscriptionLabel),
    azureDefaultTenantId: sanitizeString(raw.azureDefaultTenantId),
    azureDefaultLocation: sanitizeString(raw.azureDefaultLocation),
    launchScreen: sanitizeLaunchScreen(raw.launchScreen)
  }
}

function sanitizeTerminal(value: unknown): AppSettingsTerminal {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    autoOpen: sanitizeBoolean(raw.autoOpen, DEFAULT_APP_SETTINGS.terminal.autoOpen),
    defaultCommand: sanitizeString(raw.defaultCommand),
    fontSize: sanitizeFontSize(raw.fontSize),
    shellPreference: sanitizeShellPreference(raw.shellPreference)
  }
}

function sanitizeRefresh(value: unknown): AppSettingsRefresh {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    autoRefreshIntervalSeconds: sanitizePositiveInteger(
      raw.autoRefreshIntervalSeconds,
      DEFAULT_APP_SETTINGS.refresh.autoRefreshIntervalSeconds
    ),
    heavyScreenMode: sanitizeRefreshMode(raw.heavyScreenMode)
  }
}

function sanitizeToolchain(value: unknown): AppSettingsToolchain {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    preferredTerraformCliKind: sanitizeTerraformCliKind(raw.preferredTerraformCliKind),
    terraformPathOverride: sanitizeString(raw.terraformPathOverride),
    opentofuPathOverride: sanitizeString(raw.opentofuPathOverride),
    terragruntPathOverride: sanitizeString(raw.terragruntPathOverride),
    awsCliPathOverride: sanitizeString(raw.awsCliPathOverride),
    gcloudPathOverride: sanitizeString(raw.gcloudPathOverride),
    azureCliPathOverride: sanitizeString(raw.azureCliPathOverride),
    kubectlPathOverride: sanitizeString(raw.kubectlPathOverride),
    dockerPathOverride: sanitizeString(raw.dockerPathOverride)
  }
}

function sanitizeUpdates(value: unknown): AppSettingsUpdates {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    releaseChannel: sanitizeReleaseChannel(raw.releaseChannel),
    autoDownload: sanitizeBoolean(raw.autoDownload, DEFAULT_APP_SETTINGS.updates.autoDownload)
  }
}

function sanitizeAppSettings(value: unknown): AppSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    general: sanitizeGeneral(raw.general),
    terminal: sanitizeTerminal(raw.terminal),
    refresh: sanitizeRefresh(raw.refresh),
    toolchain: sanitizeToolchain(raw.toolchain),
    updates: sanitizeUpdates(raw.updates),
    features: sanitizeFeatures(raw.features)
  }
}

function write(settings: AppSettings): AppSettings {
  writeSecureJsonFile(settingsPath(), settings, 'App settings')
  return settings
}

export function getDefaultAppSettings(): AppSettings {
  return sanitizeAppSettings(DEFAULT_APP_SETTINGS)
}

let settingsCache: AppSettings | null = null

export function getAppSettings(): AppSettings {
  if (settingsCache) {
    return settingsCache
  }

  const parsed = readSecureJsonFile<Record<string, unknown>>(settingsPath(), {
    fallback: DEFAULT_APP_SETTINGS as unknown as Record<string, unknown>,
    fileLabel: 'App settings'
  })

  settingsCache = sanitizeAppSettings(parsed)
  return settingsCache
}

export function invalidateAppSettingsCache(): void {
  settingsCache = null
}

export function setAppSettings(settings: AppSettings): AppSettings {
  settingsCache = null
  return write(sanitizeAppSettings(settings))
}

export function updateAppSettings(update: Partial<AppSettings>): AppSettings {
  const current = getAppSettings()
  const next = sanitizeAppSettings({
    ...current,
    ...update,
    general: { ...current.general, ...(update.general ?? {}) },
    terminal: { ...current.terminal, ...(update.terminal ?? {}) },
    refresh: { ...current.refresh, ...(update.refresh ?? {}) },
    toolchain: { ...current.toolchain, ...(update.toolchain ?? {}) },
    updates: { ...current.updates, ...(update.updates ?? {}) },
    features: {
      ...current.features,
      ...(update.features ?? {}),
      registry: {
        ...current.features.registry,
        ...(update.features?.registry ?? {})
      }
    }
  })

  settingsCache = null
  return write(next)
}

export function resetAppSettings(): AppSettings {
  settingsCache = null
  return write(getDefaultAppSettings())
}
