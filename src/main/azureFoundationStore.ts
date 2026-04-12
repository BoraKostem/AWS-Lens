import path from 'node:path'

import { app } from 'electron'

import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

export type AzureFoundationStore = {
  activeTenantId: string
  activeSubscriptionId: string
  activeLocation: string
  recentSubscriptionIds: string[]
  recentSubscriptions: Array<{
    subscriptionId: string
    displayName: string
    tenantId: string
  }>
  favoriteSubscriptionIds: string[]
  lastSignedInAt: string
  lastError: string
  authMethod: string
  tokenCacheState: string
  lastTokenRefreshAt: string
}

const DEFAULT_AZURE_FOUNDATION_STORE: AzureFoundationStore = {
  activeTenantId: '',
  activeSubscriptionId: '',
  activeLocation: '',
  recentSubscriptionIds: [],
  recentSubscriptions: [],
  favoriteSubscriptionIds: [],
  lastSignedInAt: '',
  lastError: '',
  authMethod: '',
  tokenCacheState: '',
  lastTokenRefreshAt: ''
}

function azureFoundationStorePath(): string {
  return path.join(app.getPath('userData'), 'azure-foundation.json')
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function sanitizeRecentSubscriptionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)

  return [...new Set(normalized)].slice(0, 8)
}

function sanitizeRecentSubscriptions(value: unknown): AzureFoundationStore['recentSubscriptions'] {
  if (!Array.isArray(value)) {
    return []
  }

  const entries = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null
      }

      const raw = entry as Record<string, unknown>
      const subscriptionId = sanitizeString(raw.subscriptionId).trim()
      if (!subscriptionId) {
        return null
      }

      return {
        subscriptionId,
        displayName: sanitizeString(raw.displayName),
        tenantId: sanitizeString(raw.tenantId)
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  return entries.slice(0, 8)
}

function sanitizeAzureFoundationStore(value: unknown): AzureFoundationStore {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

  return {
    activeTenantId: sanitizeString(raw.activeTenantId),
    activeSubscriptionId: sanitizeString(raw.activeSubscriptionId),
    activeLocation: sanitizeString(raw.activeLocation),
    recentSubscriptionIds: sanitizeRecentSubscriptionIds(raw.recentSubscriptionIds),
    recentSubscriptions: sanitizeRecentSubscriptions(raw.recentSubscriptions),
    favoriteSubscriptionIds: sanitizeRecentSubscriptionIds(raw.favoriteSubscriptionIds),
    lastSignedInAt: sanitizeString(raw.lastSignedInAt),
    lastError: sanitizeString(raw.lastError),
    authMethod: sanitizeString(raw.authMethod),
    tokenCacheState: sanitizeString(raw.tokenCacheState),
    lastTokenRefreshAt: sanitizeString(raw.lastTokenRefreshAt)
  }
}

export function getDefaultAzureFoundationStore(): AzureFoundationStore {
  return { ...DEFAULT_AZURE_FOUNDATION_STORE }
}

let azureFoundationStoreCache: AzureFoundationStore | null = null

export function readAzureFoundationStore(): AzureFoundationStore {
  if (azureFoundationStoreCache) {
    return azureFoundationStoreCache
  }

  const parsed = readSecureJsonFile<Record<string, unknown>>(azureFoundationStorePath(), {
    fallback: DEFAULT_AZURE_FOUNDATION_STORE as unknown as Record<string, unknown>,
    fileLabel: 'Azure foundation'
  })

  azureFoundationStoreCache = sanitizeAzureFoundationStore(parsed)
  return azureFoundationStoreCache
}

export function writeAzureFoundationStore(store: AzureFoundationStore): AzureFoundationStore {
  const sanitized = sanitizeAzureFoundationStore(store)
  azureFoundationStoreCache = sanitized
  writeSecureJsonFile(azureFoundationStorePath(), sanitized, 'Azure foundation')
  return sanitized
}

export function updateAzureFoundationStore(update: Partial<AzureFoundationStore>): AzureFoundationStore {
  const current = readAzureFoundationStore()
  return writeAzureFoundationStore({
    ...current,
    ...update
  })
}

