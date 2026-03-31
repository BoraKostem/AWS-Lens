import { app } from 'electron'

import type { AppReleaseInfo } from '@shared/types'
import { executeOperation } from './operations'

const RELEASES_URL = 'https://github.com/BoraKostem/AWS-Lens/releases/'
const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/BoraKostem/AWS-Lens/releases/latest'

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

function currentBuildHash(): string | null {
  const rawValue = process.env.AWS_LENS_BUILD_HASH
    ?? process.env.GITHUB_SHA
    ?? process.env.VERCEL_GIT_COMMIT_SHA
    ?? ''
  const normalized = rawValue.trim()

  return normalized ? normalized.slice(0, 12) : null
}

function baseReleaseInfo(): AppReleaseInfo {
  const currentVersion = app.getVersion()
  const releaseUrl = RELEASES_URL

  return {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl,
    checkedAt: null,
    error: null,
    checkStatus: 'idle',
    updateMechanism: 'github-release-check',
    currentBuild: {
      version: currentVersion,
      buildHash: currentBuildHash(),
      channel: inferReleaseChannel(currentVersion)
    },
    latestRelease: {
      version: null,
      name: null,
      notes: null,
      publishedAt: null,
      url: releaseUrl
    }
  }
}

let cachedReleaseInfo: AppReleaseInfo = baseReleaseInfo()

let startupReleaseCheckPromise: Promise<AppReleaseInfo> | null = null

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

async function fetchLatestReleaseInfo(): Promise<AppReleaseInfo> {
  const currentVersion = app.getVersion()
  const releaseUrl = RELEASES_URL
  const currentBuild = {
    version: currentVersion,
    buildHash: currentBuildHash(),
    channel: inferReleaseChannel(currentVersion)
  }

  cachedReleaseInfo = {
    ...cachedReleaseInfo,
    currentVersion,
    releaseUrl,
    error: null,
    checkStatus: 'checking',
    currentBuild
  }

  try {
    const response = await executeOperation('release-check.fetch-latest', async () =>
      await fetch(LATEST_RELEASE_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AWS-Lens'
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

    cachedReleaseInfo = {
      currentVersion,
      latestVersion: rawLatestVersion ? normalizeVersion(rawLatestVersion) : null,
      updateAvailable: rawLatestVersion ? compareVersions(currentVersion, rawLatestVersion) < 0 : false,
      releaseUrl: latestReleaseUrl,
      checkedAt: new Date().toISOString(),
      error: null,
      checkStatus: 'ready',
      updateMechanism: 'github-release-check',
      currentBuild,
      latestRelease: {
        version: rawLatestVersion ? normalizeVersion(rawLatestVersion) : null,
        name: latestReleaseName,
        notes: latestReleaseNotes,
        publishedAt: latestReleasePublishedAt,
        url: latestReleaseUrl
      }
    }
  } catch (error) {
    cachedReleaseInfo = {
      ...cachedReleaseInfo,
      currentVersion,
      releaseUrl,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      checkStatus: 'error',
      currentBuild
    }
  }

  return cachedReleaseInfo
}

export function startReleaseCheck(): void {
  cachedReleaseInfo = {
    ...baseReleaseInfo(),
    checkStatus: 'checking'
  }
  if (!startupReleaseCheckPromise) {
    startupReleaseCheckPromise = fetchLatestReleaseInfo().finally(() => {
      startupReleaseCheckPromise = null
    })
  }
}

export async function getReleaseInfo(): Promise<AppReleaseInfo> {
  if (startupReleaseCheckPromise) {
    return startupReleaseCheckPromise
  }

  return cachedReleaseInfo
}
