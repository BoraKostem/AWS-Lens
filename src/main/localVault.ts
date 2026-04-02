import path from 'node:path'

import { app } from 'electron'

import type {
  VaultEntryFilter,
  VaultEntryInput,
  VaultEntryKind,
  VaultEntrySummary,
  VaultEntryUsage,
  VaultEntryUsageInput,
  VaultOrigin,
  VaultRotationState,
  DbConnectionEngine,
  DbVaultCredentialInput,
  DbVaultCredentialSummary
} from '@shared/types'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type VaultEntry = {
  id: string
  kind: VaultEntryKind
  name: string
  secret: string
  metadata: Record<string, string>
  createdAt: string
  updatedAt: string
  origin: VaultOrigin
  rotationState: VaultRotationState
  rotationUpdatedAt: string
  lastUsedAt: string
  lastUsedContext: VaultEntryUsage | null
}

type VaultState = {
  entries: VaultEntry[]
}

export type AwsProfileVaultSecret = {
  accessKeyId: string
  secretAccessKey: string
}

type DbVaultCredentialSecret = {
  password: string
  usernameHint: string
  engine: DbConnectionEngine
  notes: string
}

const DEFAULT_VAULT_ORIGIN: VaultOrigin = 'unknown'
const DEFAULT_ROTATION_STATE: VaultRotationState = 'unknown'

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

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0)
      .map(([key, entryValue]) => [key.trim(), entryValue.trim()])
  )
}

function sanitizeKind(value: unknown): VaultEntryKind {
  switch (value) {
    case 'aws-profile':
    case 'ssh-key':
    case 'pem':
    case 'access-key':
    case 'generic':
    case 'db-credential':
    case 'connection-secret':
      return value
    default:
      return 'generic'
  }
}

function sanitizeOrigin(value: unknown): VaultOrigin {
  switch (value) {
    case 'manual':
    case 'imported-file':
    case 'aws-secrets-manager':
    case 'aws-iam':
    case 'generated':
    case 'unknown':
      return value
    default:
      return DEFAULT_VAULT_ORIGIN
  }
}

function sanitizeRotationState(value: unknown): VaultRotationState {
  switch (value) {
    case 'unknown':
    case 'not-applicable':
    case 'tracked':
    case 'rotation-due':
    case 'rotated':
      return value
    default:
      return DEFAULT_ROTATION_STATE
  }
}

function sanitizeLastUsedContext(value: unknown): VaultEntryUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return {
    usedAt: sanitizeString((value as Record<string, unknown>).usedAt),
    source: sanitizeString((value as Record<string, unknown>).source),
    profile: sanitizeString((value as Record<string, unknown>).profile),
    region: sanitizeString((value as Record<string, unknown>).region),
    resourceId: sanitizeString((value as Record<string, unknown>).resourceId),
    resourceLabel: sanitizeString((value as Record<string, unknown>).resourceLabel)
  }
}

function sanitizeVaultEntry(value: unknown): VaultEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Record<string, unknown>
  const kind = sanitizeKind(raw.kind)
  const name = sanitizeString(raw.name)
  if (!name) {
    return null
  }

  const createdAt = sanitizeString(raw.createdAt)
  const updatedAt = sanitizeString(raw.updatedAt)

  return {
    id: sanitizeString(raw.id) || `${kind}:${name}`,
    kind,
    name,
    secret: typeof raw.secret === 'string' ? raw.secret : '',
    metadata: sanitizeMetadata(raw.metadata),
    createdAt,
    updatedAt: updatedAt || createdAt,
    origin: sanitizeOrigin(raw.origin),
    rotationState: sanitizeRotationState(raw.rotationState),
    rotationUpdatedAt: sanitizeString(raw.rotationUpdatedAt),
    lastUsedAt: sanitizeString(raw.lastUsedAt),
    lastUsedContext: sanitizeLastUsedContext(raw.lastUsedContext)
  }
}

function readEntries(): VaultEntry[] {
  const state = readVaultState()
  return state.entries
    .map((entry) => sanitizeVaultEntry(entry))
    .filter((entry): entry is VaultEntry => Boolean(entry))
}

function toSummary(entry: VaultEntry): VaultEntrySummary {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    origin: entry.origin,
    rotationState: entry.rotationState,
    rotationUpdatedAt: entry.rotationUpdatedAt,
    lastUsedAt: entry.lastUsedAt,
    lastUsedContext: entry.lastUsedContext
  }
}

function upsertEntry(nextEntry: VaultEntry): void {
  const nextEntries = readEntries().filter((entry) => entry.id !== nextEntry.id)
  nextEntries.push(nextEntry)
  nextEntries.sort((left, right) => left.name.localeCompare(right.name))
  writeVaultState({ entries: nextEntries })
}

function getEntry(kind: VaultEntryKind, name: string): VaultEntry | null {
  const normalizedName = name.trim()
  return readEntries().find((entry) => entry.kind === kind && entry.name === normalizedName) ?? null
}

function getEntryById(entryId: string): VaultEntry | null {
  const normalizedId = entryId.trim()
  return readEntries().find((entry) => entry.id === normalizedId) ?? null
}

function deleteEntry(kind: VaultEntryKind, name: string): void {
  const normalizedName = name.trim()
  writeVaultState({
    entries: readEntries().filter((entry) => !(entry.kind === kind && entry.name === normalizedName))
  })
}

export function listVaultEntries(kind?: VaultEntryKind): VaultEntrySummary[] {
  const entries = readEntries()
  return entries
    .filter((entry) => !kind || entry.kind === kind)
    .map((entry) => toSummary(entry))
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
    updatedAt: now,
    origin: existing?.origin ?? DEFAULT_VAULT_ORIGIN,
    rotationState: existing?.rotationState ?? DEFAULT_ROTATION_STATE,
    rotationUpdatedAt: existing?.rotationUpdatedAt ?? '',
    lastUsedAt: existing?.lastUsedAt ?? '',
    lastUsedContext: existing?.lastUsedContext ?? null
  })
}

export function getVaultSecret(kind: VaultEntryKind, name: string): string | null {
  return getEntry(kind, name)?.secret ?? null
}

export function deleteVaultSecret(kind: VaultEntryKind, name: string): void {
  deleteEntry(kind, name)
}

export function getVaultEntrySummaryByKindAndName(kind: VaultEntryKind, name: string): VaultEntrySummary | null {
  const entry = getEntry(kind, name)
  return entry ? toSummary(entry) : null
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

export function setAwsProfileVaultSecret(
  profileName: string,
  secret: AwsProfileVaultSecret,
  options?: {
    origin?: VaultOrigin
    rotationState?: VaultRotationState
  }
): void {
  saveVaultEntry({
    kind: 'aws-profile',
    name: profileName.trim(),
    secret: JSON.stringify(secret),
    metadata: {
      profileName: profileName.trim()
    },
    origin: options?.origin ?? 'manual',
    rotationState: options?.rotationState ?? DEFAULT_ROTATION_STATE
  })
}

export function deleteAwsProfileVaultSecret(profileName: string): void {
  deleteVaultSecret('aws-profile', profileName)
}

function sanitizeDbEngine(value: unknown): DbConnectionEngine {
  switch (value) {
    case 'postgres':
    case 'mysql':
    case 'mariadb':
    case 'sqlserver':
    case 'oracle':
    case 'aurora-postgresql':
    case 'aurora-mysql':
      return value
    default:
      return 'unknown'
  }
}

function toDbVaultCredentialSummary(entry: Omit<VaultEntry, 'secret'>): DbVaultCredentialSummary {
  return {
    name: entry.name,
    engine: sanitizeDbEngine(entry.metadata.engine),
    usernameHint: entry.metadata.usernameHint?.trim() ?? '',
    notes: entry.metadata.notes?.trim() ?? '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  }
}

export function listDbVaultCredentials(): DbVaultCredentialSummary[] {
  return listVaultEntries('db-credential').map((entry) => toDbVaultCredentialSummary(entry))
}

export function getDbVaultCredentialSecret(name: string): DbVaultCredentialSecret | null {
  const raw = getVaultSecret('db-credential', name)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DbVaultCredentialSecret>
    if (typeof parsed.password !== 'string' || !parsed.password.trim()) {
      return null
    }

    return {
      password: parsed.password,
      usernameHint: typeof parsed.usernameHint === 'string' ? parsed.usernameHint.trim() : '',
      engine: sanitizeDbEngine(parsed.engine),
      notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : ''
    }
  } catch {
    return null
  }
}

export function setDbVaultCredential(input: DbVaultCredentialInput): DbVaultCredentialSummary {
  const name = input.name.trim()
  const password = input.password.trim()

  if (!name) {
    throw new Error('Vault credential name is required.')
  }
  if (!password) {
    throw new Error('Vault credential password is required.')
  }

  const secret: DbVaultCredentialSecret = {
    password,
    usernameHint: input.usernameHint.trim(),
    engine: sanitizeDbEngine(input.engine),
    notes: input.notes.trim()
  }

  saveVaultEntry({
    kind: 'db-credential',
    name,
    secret: JSON.stringify(secret),
    metadata: {
      usernameHint: secret.usernameHint,
      engine: secret.engine,
      notes: secret.notes
    },
    origin: 'manual',
    rotationState: DEFAULT_ROTATION_STATE
  })

  const saved = listVaultEntries('db-credential').find((entry) => entry.name === name)
  if (!saved) {
    throw new Error('Vault credential could not be saved.')
  }

  return toDbVaultCredentialSummary(saved)
}

export function deleteDbVaultCredential(name: string): void {
  deleteVaultSecret('db-credential', name)
}

export function listVaultEntrySummaries(filter?: VaultEntryFilter): VaultEntrySummary[] {
  const query = filter?.search?.trim().toLowerCase() ?? ''

  return readEntries()
    .filter((entry) => !filter?.kind || entry.kind === filter.kind)
    .filter((entry) => {
      if (!query) {
        return true
      }

      return [
        entry.name,
        entry.kind,
        entry.origin,
        entry.lastUsedContext?.source ?? '',
        ...Object.entries(entry.metadata).flatMap(([key, value]) => [key, value])
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
    .map((entry) => toSummary(entry))
}

export function saveVaultEntry(input: VaultEntryInput): VaultEntrySummary {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Vault entry name is required.')
  }

  const secret = input.secret.trim()
  if (!secret) {
    throw new Error('Vault entry secret is required.')
  }

  const now = new Date().toISOString()
  const existing = input.id?.trim()
    ? getEntryById(input.id)
    : getEntry(input.kind, name)

  const nextEntry: VaultEntry = {
    id: existing?.id ?? `${input.kind}:${name}`,
    kind: input.kind,
    name,
    secret,
    metadata: sanitizeMetadata(input.metadata),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    origin: input.origin ?? existing?.origin ?? DEFAULT_VAULT_ORIGIN,
    rotationState: input.rotationState ?? existing?.rotationState ?? DEFAULT_ROTATION_STATE,
    rotationUpdatedAt: sanitizeString(input.rotationUpdatedAt) || existing?.rotationUpdatedAt || '',
    lastUsedAt: existing?.lastUsedAt ?? '',
    lastUsedContext: existing?.lastUsedContext ?? null
  }

  upsertEntry(nextEntry)
  return toSummary(nextEntry)
}

export function deleteVaultEntryById(entryId: string): void {
  const normalizedId = entryId.trim()
  if (!normalizedId) {
    return
  }

  writeVaultState({
    entries: readEntries().filter((entry) => entry.id !== normalizedId)
  })
}

export function revealVaultEntrySecret(entryId: string): string {
  const entry = getEntryById(entryId)
  if (!entry) {
    throw new Error(`Vault entry not found: ${entryId}`)
  }

  return entry.secret
}

export function recordVaultEntryUse(input: VaultEntryUsageInput): VaultEntrySummary {
  const entry = getEntryById(input.id)
  if (!entry) {
    throw new Error(`Vault entry not found: ${input.id}`)
  }

  const usage: VaultEntryUsage = {
    usedAt: sanitizeString(input.usedAt) || new Date().toISOString(),
    source: input.source.trim(),
    profile: sanitizeString(input.profile),
    region: sanitizeString(input.region),
    resourceId: sanitizeString(input.resourceId),
    resourceLabel: sanitizeString(input.resourceLabel)
  }

  if (!usage.source) {
    throw new Error('Vault usage source is required.')
  }

  const nextEntry: VaultEntry = {
    ...entry,
    lastUsedAt: usage.usedAt,
    lastUsedContext: usage
  }

  upsertEntry(nextEntry)
  return toSummary(nextEntry)
}

export function recordVaultEntryUseByKindAndName(
  kind: VaultEntryKind,
  name: string,
  input: Omit<VaultEntryUsageInput, 'id'>
): VaultEntrySummary | null {
  const entry = getEntry(kind, name)
  if (!entry) {
    return null
  }

  return recordVaultEntryUse({
    ...input,
    id: entry.id
  })
}
