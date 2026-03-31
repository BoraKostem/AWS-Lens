import path from 'node:path'

import { app } from 'electron'

import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type VaultEntryKind = 'aws-profile' | 'ssh-key' | 'pem' | 'access-key' | 'generic'

type VaultEntry = {
  id: string
  kind: VaultEntryKind
  name: string
  secret: string
  metadata: Record<string, string>
  createdAt: string
  updatedAt: string
}

type VaultState = {
  entries: VaultEntry[]
}

export type AwsProfileVaultSecret = {
  accessKeyId: string
  secretAccessKey: string
}

export function getVaultEntryCounts(): {
  all: number
  awsProfiles: number
  sshKeys: number
  pem: number
  accessKeys: number
} {
  return {
    all: listVaultEntries().length,
    awsProfiles: listVaultEntries('aws-profile').length,
    sshKeys: listVaultEntries('ssh-key').length,
    pem: listVaultEntries('pem').length,
    accessKeys: listVaultEntries('access-key').length
  }
}

function vaultPath(): string {
  return path.join(app.getPath('userData'), 'local-vault.json')
}

function readVaultState(): VaultState {
  return readSecureJsonFile<VaultState>(vaultPath(), {
    fallback: { entries: [] },
    fileLabel: 'Local secret vault'
  })
}

function writeVaultState(state: VaultState): void {
  writeSecureJsonFile(vaultPath(), state, 'Local secret vault')
}

function upsertEntry(nextEntry: VaultEntry): void {
  const state = readVaultState()
  const nextEntries = state.entries.filter((entry) => entry.id !== nextEntry.id)
  nextEntries.push(nextEntry)
  nextEntries.sort((left, right) => left.name.localeCompare(right.name))
  writeVaultState({ entries: nextEntries })
}

function getEntry(kind: VaultEntryKind, name: string): VaultEntry | null {
  const normalizedName = name.trim()
  return readVaultState().entries.find((entry) => entry.kind === kind && entry.name === normalizedName) ?? null
}

function deleteEntry(kind: VaultEntryKind, name: string): void {
  const normalizedName = name.trim()
  const state = readVaultState()
  writeVaultState({
    entries: state.entries.filter((entry) => !(entry.kind === kind && entry.name === normalizedName))
  })
}

export function listVaultEntries(kind?: VaultEntryKind): Array<Omit<VaultEntry, 'secret'>> {
  const entries = readVaultState().entries
  return entries
    .filter((entry) => !kind || entry.kind === kind)
    .map(({ secret: _secret, ...entry }) => entry)
}

export function setVaultSecret(kind: VaultEntryKind, name: string, secret: string, metadata: Record<string, string> = {}): void {
  const normalizedName = name.trim()
  if (!normalizedName) {
    throw new Error('Vault entry name is required.')
  }

  const now = new Date().toISOString()
  const existing = getEntry(kind, normalizedName)
  upsertEntry({
    id: existing?.id ?? `${kind}:${normalizedName}`,
    kind,
    name: normalizedName,
    secret,
    metadata,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })
}

export function getVaultSecret(kind: VaultEntryKind, name: string): string | null {
  return getEntry(kind, name)?.secret ?? null
}

export function deleteVaultSecret(kind: VaultEntryKind, name: string): void {
  deleteEntry(kind, name)
}

export function listAwsProfileVaultSecrets(): string[] {
  return listVaultEntries('aws-profile').map((entry) => entry.name)
}

export function getAwsProfileVaultSecret(profileName: string): AwsProfileVaultSecret | null {
  const raw = getVaultSecret('aws-profile', profileName)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AwsProfileVaultSecret>
    if (typeof parsed.accessKeyId !== 'string' || typeof parsed.secretAccessKey !== 'string') {
      return null
    }
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey
    }
  } catch {
    return null
  }
}

export function setAwsProfileVaultSecret(profileName: string, secret: AwsProfileVaultSecret): void {
  setVaultSecret('aws-profile', profileName, JSON.stringify(secret), {
    profileName: profileName.trim()
  })
}

export function deleteAwsProfileVaultSecret(profileName: string): void {
  deleteVaultSecret('aws-profile', profileName)
}
