import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { AppReleaseInfo } from '@shared/types'
import { getAppSettings } from './appSettings'
import { executeOperation } from './operations'
import { logError, logInfo, logWarn } from './observability'

const RELEASES_URL = 'https://github.com/BoraKostem/InfraLens/releases/'
const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/BoraKostem/InfraLens/releases/latest'
declare const __INFRA_LENS_BUILD_HASH__: string
declare const __INFRA_LENS_RELEASE_CHANNEL__: string

function normalizeVersion(value: string): string {
  return value.trim().replace(/^[^\d]*/, '')
}

function inferReleaseChannel(version: string): 'stable' | 'preview' | 'unknown' {
  const normalized = version.trim().toLowerCase()

  if (!normalized) {
    return 'unknown'
  }

  if (normalized.includes('-') || normalized.includes('preview') || normalized.includes('beta') || normalized.includes('rc')) {
    return 'preview'
  }

  return 'stable'
}

function configuredReleaseChannel(currentVersion: string): 'stable' | 'preview' | 'unknown' {
  const preferred = getAppSettings().updates.releaseChannel
  if (preferred === 'stable' || preferred === 'preview') {
    return preferred
  }

  const configured = typeof __INFRA_LENS_RELEASE_CHANNEL__ === 'string' ? __INFRA_LENS_RELEASE_CHANNEL__.trim().toLowerCase() : ''

  if (configured === 'stable' || configured === 'preview') {
    return configured
  }

  return inferReleaseChannel(currentVersion)
}

function currentBuildHash(): string | null {
  const rawValue = (typeof __INFRA_LENS_BUILD_HASH__ === 'string' ? __INFRA_LENS_BUILD_HASH__ : '')
    || process.env.INFRA_LENS_BUILD_HASH
    || process.env.GITHUB_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || ''
  const normalized = rawValue.trim()

  return normalized ? normalized.slice(0, 12) : null
}

function supportsAutoUpdate(): boolean {
  return app.isPackaged
}

function updaterChannelName(channel: 'stable' | 'preview' | 'unknown'): string {
  return channel === 'preview' ? 'preview' : 'latest'
}

function releaseNotesAsText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  if (Array.isArray(value)) {
    const collected = value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry.trim()
        }

        if (entry && typeof entry === 'object' && 'note' in entry && typeof entry.note === 'string') {
          return entry.note.trim()
        }

        return ''
      })
      .filter(Boolean)

    return collected.length > 0 ? collected.join('\n\n') : null
  }

  return null
}

function updateActionState(info: AppReleaseInfo): Pick<AppReleaseInfo, 'canCheckForUpdates' | 'canDownloadUpdate' | 'canInstallUpdate'> {
  if (!info.supportsAutoUpdate) {
    return {
      canCheckForUpdates: false,
      canDownloadUpdate: false,
      canInstallUpdate: false
    }
  }

  return {
    canCheckForUpdates: !startupReleaseCheckPromise && info.updateStatus !== 'downloading',
    canDownloadUpdate: info.updateStatus === 'available',
    canInstallUpdate: info.updateStatus === 'downloaded'
  }
}

function commitReleaseInfo(update: Partial<AppReleaseInfo>): AppReleaseInfo {
  const next: AppReleaseInfo = {
    ...cachedReleaseInfo,
    ...update,
    currentBuild: {
      ...cachedReleaseInfo.currentBuild,
      ...update.currentBuild
    },
    latestRelease: {
      ...cachedReleaseInfo.latestRelease,
      ...update.latestRelease
    }
  }

  const actions = updateActionState(next)
  cachedReleaseInfo = {
    ...next,
    ...actions
  }

  return cachedReleaseInfo
}

function baseReleaseInfo(): AppReleaseInfo {
  const currentVersion = app.getVersion()
  const releaseUrl = RELEASES_URL
  const channel = configuredReleaseChannel(currentVersion)
  const appSettings = getAppSettings()
  const base: AppReleaseInfo = {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl,
    checkedAt: null,
    error: null,
    checkStatus: 'idle',
    updateMechanism: supportsAutoUpdate() ? 'electron-updater' : 'github-release-check',
    updateStatus: 'idle',
    supportsAutoUpdate: supportsAutoUpdate(),
    canCheckForUpdates: false,
    canDownloadUpdate: false,
    canInstallUpdate: false,
    downloadProgressPercent: null,
    selectedChannel: channel,
    autoDownloadEnabled: appSettings.updates.autoDownload,
    currentBuild: {
      version: currentVersion,
      buildHash: currentBuildHash(),
      channel
    },
    latestRelease: {
      version: null,
      name: null,
      notes: null,
      publishedAt: null,
      url: releaseUrl
    }
  }

  return {
    ...base,
    checkedAt: supportsAutoUpdate() ? base.checkedAt : null,
    error: supportsAutoUpdate() ? base.error : null,
    ...updateActionState(base)
  }
}

let startupReleaseCheckPromise: Promise<AppReleaseInfo> | null = null
let cachedReleaseInfo: AppReleaseInfo = baseReleaseInfo()
let autoUpdaterInitialized = false

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = normalizeVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1
    }
  }

  return 0
}

function initializeAutoUpdater(): void {
  if (autoUpdaterInitialized || !supportsAutoUpdate()) {
    return
  }

  autoUpdaterInitialized = true
  autoUpdater.autoDownload = getAppSettings().updates.autoDownload
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = cachedReleaseInfo.currentBuild.channel === 'preview'
  autoUpdater.channel = updaterChannelName(cachedReleaseInfo.selectedChannel)

  autoUpdater.on('checking-for-update', () => {
    logInfo('app.updater.checking', 'Checking for app updates.', {
      channel: cachedReleaseInfo.currentBuild.channel
    })
    commitReleaseInfo({
      checkStatus: 'checking',
      updateStatus: 'checking',
      error: null,
      checkedAt: new Date().toISOString(),
      downloadProgressPercent: null
    })
  })

  autoUpdater.on('update-available', (info) => {
    logInfo('app.updater.available', 'An application update is available.', {
      version: info.version,
      channel: cachedReleaseInfo.currentBuild.channel
    })
    commitReleaseInfo({
      latestVersion: info.version ?? null,
      updateAvailable: info.version ? compareVersions(cachedReleaseInfo.currentVersion, info.version) < 0 : true,
      releaseUrl: info.releaseNotes && typeof info.releaseNotes === 'string' && info.releaseNotes.includes('http')
        ? cachedReleaseInfo.releaseUrl
        : RELEASES_URL,
      checkedAt: new Date().toISOString(),
      error: null,
      checkStatus: 'ready',
      updateMechanism: 'electron-updater',
      updateStatus: 'available',
      latestRelease: {
        version: info.version ?? null,
        name: typeof info.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim() : info.version ?? null,
        notes: releaseNotesAsText(info.releaseNotes),
        publishedAt: typeof info.releaseDate === 'string' && info.releaseDate.trim() ? info.releaseDate : null,
        url: RELEASES_URL
      }
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    logInfo('app.updater.not-available', 'No newer application update is available.', {
      version: info.version
    })
    commitReleaseInfo({
      latestVersion: info.version ?? cachedReleaseInfo.currentVersion,
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
      error: null,
      checkStatus: 'ready',
      updateMechanism: 'electron-updater',
      updateStatus: 'not-available',
      downloadProgressPercent: null,
      latestRelease: {
        version: info.version ?? cachedReleaseInfo.currentVersion,
        name: typeof info.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim() : info.version ?? cachedReleaseInfo.currentVersion,
        notes: releaseNotesAsText(info.releaseNotes),
        publishedAt: typeof info.releaseDate === 'string' && info.releaseDate.trim() ? info.releaseDate : null,
        url: RELEASES_URL
      }
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    commitReleaseInfo({
      updateStatus: 'downloading',
      downloadProgressPercent: Number.isFinite(progress.percent) ? progress.percent : null,
      error: null
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logInfo('app.updater.downloaded', 'Application update was downloaded and is ready to install.', {
      version: info.version
    })
    commitReleaseInfo({
      latestVersion: info.version ?? cachedReleaseInfo.latestVersion,
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
      checkStatus: 'ready',
      updateMechanism: 'electron-updater',
      updateStatus: 'downloaded',
      downloadProgressPercent: 100,
      latestRelease: {
        version: info.version ?? cachedReleaseInfo.latestRelease.version,
        name: typeof info.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim() : info.version ?? cachedReleaseInfo.latestRelease.name,
        notes: releaseNotesAsText(info.releaseNotes),
        publishedAt: typeof info.releaseDate === 'string' && info.releaseDate.trim() ? info.releaseDate : cachedReleaseInfo.latestRelease.publishedAt,
        url: RELEASES_URL
      }
    })
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    logError('app.updater.error', 'Application updater failed.', {
      channel: cachedReleaseInfo.currentBuild.channel
    }, error)
    commitReleaseInfo({
      checkedAt: new Date().toISOString(),
      error: message,
      checkStatus: 'error',
      updateMechanism: 'electron-updater',
      updateStatus: 'error'
    })
  })
}

async function fetchLatestReleaseInfo(): Promise<AppReleaseInfo> {
  const currentVersion = app.getVersion()
  const releaseUrl = RELEASES_URL
  const currentBuild = {
    version: currentVersion,
    buildHash: currentBuildHash(),
    channel: configuredReleaseChannel(currentVersion)
  }

  commitReleaseInfo({
    currentVersion,
    releaseUrl,
    error: null,
    checkStatus: 'checking',
    updateMechanism: supportsAutoUpdate() ? 'electron-updater' : 'github-release-check',
    updateStatus: 'checking',
    currentBuild,
    downloadProgressPercent: null
  })

  if (supportsAutoUpdate()) {
    initializeAutoUpdater()

    try {
      const result = await executeOperation('release-check.auto-updater', async () => await autoUpdater.checkForUpdates(), {
        timeoutMs: 20000,
        retries: 0,
        context: {
          currentVersion,
          channel: currentBuild.channel
        }
      })

      const info = result?.updateInfo
      if (info) {
        commitReleaseInfo({
          latestVersion: info.version ?? cachedReleaseInfo.latestVersion,
          latestRelease: {
            version: info.version ?? cachedReleaseInfo.latestRelease.version,
            name: typeof info.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim() : info.version ?? cachedReleaseInfo.latestRelease.name,
            notes: releaseNotesAsText(info.releaseNotes),
            publishedAt: typeof info.releaseDate === 'string' && info.releaseDate.trim() ? info.releaseDate : cachedReleaseInfo.latestRelease.publishedAt,
            url: RELEASES_URL
          }
        })
      }

      return cachedReleaseInfo
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logWarn('app.updater.fallback', 'Falling back to GitHub release check after updater failure.', {
        currentVersion,
        channel: currentBuild.channel
      }, error)
      commitReleaseInfo({
        error: message,
        checkStatus: 'error',
        updateMechanism: 'electron-updater',
        updateStatus: 'error'
      })
    }
  }

  try {
    const response = await executeOperation('release-check.fetch-latest', async () =>
      await fetch(LATEST_RELEASE_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'InfraLens'
        }
      }), {
      timeoutMs: 12000,
      retries: 1,
      context: {
        currentVersion
      }
    })

    if (!response.ok) {
      throw new Error(`GitHub release check failed with status ${response.status}.`)
    }

    const payload = await response.json() as {
      html_url?: unknown
      tag_name?: unknown
      name?: unknown
      body?: unknown
      published_at?: unknown
    }
    const rawLatestVersion = typeof payload.tag_name === 'string' && payload.tag_name.trim()
      ? payload.tag_name
      : typeof payload.name === 'string' && payload.name.trim()
        ? payload.name
        : null
    const latestReleaseUrl = typeof payload.html_url === 'string' && payload.html_url.trim()
      ? payload.html_url
      : releaseUrl
    const latestReleaseName = typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : null
    const latestReleaseNotes = typeof payload.body === 'string' && payload.body.trim()
      ? payload.body.trim()
      : null
    const latestReleasePublishedAt = typeof payload.published_at === 'string' && payload.published_at.trim()
      ? payload.published_at
      : null

    commitReleaseInfo({
      currentVersion,
      latestVersion: rawLatestVersion ? normalizeVersion(rawLatestVersion) : null,
      updateAvailable: rawLatestVersion ? compareVersions(currentVersion, rawLatestVersion) < 0 : false,
      releaseUrl: latestReleaseUrl,
      checkedAt: new Date().toISOString(),
      error: null,
      checkStatus: 'ready',
      updateMechanism: 'github-release-check',
      updateStatus: rawLatestVersion ? compareVersions(currentVersion, rawLatestVersion) < 0 ? 'available' : 'not-available' : 'not-available',
      currentBuild,
      latestRelease: {
        version: rawLatestVersion ? normalizeVersion(rawLatestVersion) : null,
        name: latestReleaseName,
        notes: latestReleaseNotes,
        publishedAt: latestReleasePublishedAt,
        url: latestReleaseUrl
      }
    })
  } catch (error) {
    commitReleaseInfo({
      currentVersion,
      releaseUrl,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      checkStatus: 'error',
      updateMechanism: 'github-release-check',
      updateStatus: 'error',
      currentBuild
    })
  }

  return cachedReleaseInfo
}

export function startReleaseCheck(): void {
  if (!supportsAutoUpdate()) {
    cachedReleaseInfo = baseReleaseInfo()
    return
  }

  commitReleaseInfo({
    ...baseReleaseInfo(),
    checkStatus: 'checking',
    updateStatus: 'checking'
  })
  if (!startupReleaseCheckPromise) {
    startupReleaseCheckPromise = fetchLatestReleaseInfo().finally(() => {
      startupReleaseCheckPromise = null
      commitReleaseInfo({
        checkStatus: cachedReleaseInfo.error ? 'error' : 'ready'
      })
    })
  }
}

export async function getReleaseInfo(): Promise<AppReleaseInfo> {
  if (startupReleaseCheckPromise) {
    return startupReleaseCheckPromise
  }

  return cachedReleaseInfo
}

export async function checkForAppUpdates(): Promise<AppReleaseInfo> {
  if (!supportsAutoUpdate()) {
    return commitReleaseInfo({
      checkStatus: 'idle',
      updateStatus: 'idle',
      error: null,
      checkedAt: null
    })
  }

  if (startupReleaseCheckPromise) {
    return startupReleaseCheckPromise
  }

  startupReleaseCheckPromise = fetchLatestReleaseInfo().finally(() => {
    startupReleaseCheckPromise = null
  })

  return startupReleaseCheckPromise
}

export async function downloadAppUpdate(): Promise<AppReleaseInfo> {
  if (!supportsAutoUpdate()) {
    return commitReleaseInfo({
      error: null
    })
  }

  initializeAutoUpdater()
  commitReleaseInfo({
    error: null,
    updateMechanism: 'electron-updater',
    updateStatus: 'downloading',
    downloadProgressPercent: 0
  })

  await executeOperation('release-check.download-update', async () => await autoUpdater.downloadUpdate(), {
    timeoutMs: 120000,
    retries: 0,
    context: {
      latestVersion: cachedReleaseInfo.latestVersion,
      channel: cachedReleaseInfo.currentBuild.channel
    }
  })

  return cachedReleaseInfo
}

export function installAppUpdate(): AppReleaseInfo {
  if (!supportsAutoUpdate() || cachedReleaseInfo.updateStatus !== 'downloaded') {
    return cachedReleaseInfo
  }

  logInfo('app.updater.install', 'Installing downloaded application update.', {
    version: cachedReleaseInfo.latestVersion
  })
  autoUpdater.quitAndInstall()
  return cachedReleaseInfo
}
