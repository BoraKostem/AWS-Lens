import path from 'node:path'

import { app } from 'electron'

import type { CloudProviderId } from '@shared/types'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type ActiveCredentialState = {
  aws?: string
  gcp?: string
  azure?: string
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'active-vault-credentials.json')
}

let cache: ActiveCredentialState | null = null

function readState(): ActiveCredentialState {
  if (cache) {
    return cache
  }
  cache = readSecureJsonFile<ActiveCredentialState>(storePath(), {
    fallback: {},
    fileLabel: 'Active vault credentials'
  })
  return cache
}

function writeState(state: ActiveCredentialState): void {
  cache = state
  writeSecureJsonFile(storePath(), state, 'Active vault credentials')
}

export function getActiveVaultCredential(provider: CloudProviderId): string | null {
  const state = readState()
  const value = state[provider]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function setActiveVaultCredential(provider: CloudProviderId, entryId: string | null): void {
  const state = { ...readState() }
  if (!entryId || !entryId.trim()) {
    delete state[provider]
  } else {
    state[provider] = entryId.trim()
  }
  writeState(state)
}

export function listActiveVaultCredentials(): ActiveCredentialState {
  return { ...readState() }
}
