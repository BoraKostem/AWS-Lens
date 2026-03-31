import { app } from 'electron'

import type { AppReleaseInfo } from '@shared/types'
import { executeOperation } from './operations'

const RELEASES_URL = 'https://github.com/BoraKostem/AWS-Lens/releases/'
const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/BoraKostem/AWS-Lens/releases/latest'

let cachedReleaseInfo: AppReleaseInfo = {
  currentVersion: app.getVersion(),
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: RELEASES_URL,
  checkedAt: null,
  error: null
}

let startupReleaseCheckPromise: Promise<AppReleaseInfo> | null = null

function normalizeVersion(value: string): string {
  return value.trim().replace(/^[^\d]*/, '')
}

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

    const payload = await response.json() as { html_url?: unknown; tag_name?: unknown; name?: unknown }
    const rawLatestVersion = typeof payload.tag_name === 'string' && payload.tag_name.trim()
      ? payload.tag_name
      : typeof payload.name === 'string' && payload.name.trim()
        ? payload.name
        : null

    cachedReleaseInfo = {
      currentVersion,
      latestVersion: rawLatestVersion ? normalizeVersion(rawLatestVersion) : null,
      updateAvailable: rawLatestVersion ? compareVersions(currentVersion, rawLatestVersion) < 0 : false,
      releaseUrl: RELEASES_URL,
      checkedAt: new Date().toISOString(),
      error: null
    }
  } catch (error) {
    cachedReleaseInfo = {
      ...cachedReleaseInfo,
      currentVersion,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    }
  }

  return cachedReleaseInfo
}

export function startReleaseCheck(): void {
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
