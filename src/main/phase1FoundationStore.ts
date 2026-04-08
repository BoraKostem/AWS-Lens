import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app } from 'electron'

import type {
  CloudWatchInvestigationHistoryEntry,
  CloudWatchInvestigationHistoryInput,
  CloudWatchQueryFilter,
  CloudWatchQueryHistoryEntry,
  CloudWatchQueryHistoryInput,
  CloudWatchSavedQuery,
  CloudWatchSavedQueryInput,
  DbConnectionEngine,
  DbConnectionPreset,
  DbConnectionPresetFilter,
  DbConnectionPresetInput,
  GovernanceTagDefaults,
  GovernanceTagDefaultsUpdate,
  GovernanceTagKey,
  ServiceId
} from '@shared/types'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type Phase1FoundationState = {
  governanceTagDefaults: GovernanceTagDefaults
  cloudWatchSavedQueries: CloudWatchSavedQuery[]
  cloudWatchInvestigationHistory: CloudWatchInvestigationHistoryEntry[]
  cloudWatchQueryHistory: CloudWatchQueryHistoryEntry[]
  dbConnectionPresets: DbConnectionPreset[]
}

const GOVERNANCE_TAG_KEYS: GovernanceTagKey[] = ['Owner', 'Environment', 'Project', 'CostCenter']
const MAX_QUERY_HISTORY = 200
const VALID_DB_ENGINES = new Set<DbConnectionEngine>([
  'postgres',
  'mysql',
  'mariadb',
  'sqlserver',
  'oracle',
  'aurora-postgresql',
  'aurora-mysql',
  'unknown'
])
const VALID_SERVICE_HINTS = new Set<ServiceId | ''>([
  '',
  'terraform',
  'overview',
  'session-hub',
  'compare',
  'compliance-center',
  'ec2',
  'cloudwatch',
  's3',
  'lambda',
  'rds',
  'cloudformation',
  'cloudtrail',
  'ecr',
  'eks',
  'ecs',
  'vpc',
  'load-balancers',
  'auto-scaling',
  'route53',
  'security-groups',
  'iam',
  'identity-center',
  'sns',
  'sqs',
  'acm',
  'secrets-manager',
  'key-pairs',
  'sts',
  'kms',
  'waf'
])

const DEFAULT_GOVERNANCE_TAG_DEFAULTS: GovernanceTagDefaults = {
  inheritByDefault: true,
  values: {
    Owner: '',
    Environment: '',
    Project: '',
    CostCenter: ''
  },
  updatedAt: ''
}

const DEFAULT_STATE: Phase1FoundationState = {
  governanceTagDefaults: DEFAULT_GOVERNANCE_TAG_DEFAULTS,
  cloudWatchSavedQueries: [],
  cloudWatchInvestigationHistory: [],
  cloudWatchQueryHistory: [],
  dbConnectionPresets: []
}

function foundationsPath(): string {
  return path.join(app.getPath('userData'), 'phase1-foundations.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function sanitizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  const normalized = Math.round(value)
  return normalized > 0 ? normalized : fallback
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))]
}

function sanitizeServiceHint(value: unknown): ServiceId | '' {
  return typeof value === 'string' && VALID_SERVICE_HINTS.has(value as ServiceId | '')
    ? value as ServiceId | ''
    : ''
}

function sanitizeGovernanceTagDefaults(value: unknown): GovernanceTagDefaults {
  const raw = isRecord(value) ? value : {}
  const rawValues = isRecord(raw.values) ? raw.values : {}
  const values = GOVERNANCE_TAG_KEYS.reduce<Record<GovernanceTagKey, string>>((acc, key) => {
    acc[key] = sanitizeString(rawValues[key], DEFAULT_GOVERNANCE_TAG_DEFAULTS.values[key])
    return acc
  }, {
    Owner: '',
    Environment: '',
    Project: '',
    CostCenter: ''
  })

  return {
    inheritByDefault: sanitizeBoolean(raw.inheritByDefault, DEFAULT_GOVERNANCE_TAG_DEFAULTS.inheritByDefault),
    values,
    updatedAt: sanitizeString(raw.updatedAt)
  }
}

function sanitizeCloudWatchSavedQuery(value: unknown): CloudWatchSavedQuery | null {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return null
  }

  const id = sanitizeString(raw.id)
  const name = sanitizeString(raw.name)
  const queryString = sanitizeString(raw.queryString)
  const profile = sanitizeString(raw.profile)
  const region = sanitizeString(raw.region)

  if (!id || !name || !queryString || !profile || !region) {
    return null
  }

  return {
    id,
    name,
    description: sanitizeString(raw.description),
    queryString,
    logGroupNames: sanitizeStringArray(raw.logGroupNames),
    profile,
    region,
    serviceHint: sanitizeServiceHint(raw.serviceHint),
    createdAt: sanitizeString(raw.createdAt),
    updatedAt: sanitizeString(raw.updatedAt),
    lastRunAt: sanitizeString(raw.lastRunAt)
  }
}

function sanitizeCloudWatchInvestigationHistoryEntry(value: unknown): CloudWatchInvestigationHistoryEntry | null {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return null
  }

  const id = sanitizeString(raw.id)
  const profile = sanitizeString(raw.profile)
  const region = sanitizeString(raw.region)
  const title = sanitizeString(raw.title)
  const detail = sanitizeString(raw.detail)
  const kind = raw.kind === 'focus' ||
    raw.kind === 'open-log-group' ||
    raw.kind === 'investigate-log-group' ||
    raw.kind === 'run-query' ||
    raw.kind === 'save-query'
    ? raw.kind
    : ''
  const severity = raw.severity === 'info' ||
    raw.severity === 'success' ||
    raw.severity === 'warning' ||
    raw.severity === 'error'
    ? raw.severity
    : ''

  if (!id || !profile || !region || !title || !detail || !kind || !severity) {
    return null
  }

  return {
    id,
    profile,
    region,
    serviceHint: sanitizeServiceHint(raw.serviceHint),
    logGroupNames: sanitizeStringArray(raw.logGroupNames),
    kind,
    title,
    detail,
    severity,
    occurredAt: sanitizeString(raw.occurredAt)
  }
}

function sanitizeCloudWatchQueryHistoryEntry(value: unknown): CloudWatchQueryHistoryEntry | null {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return null
  }

  const id = sanitizeString(raw.id)
  const queryString = sanitizeString(raw.queryString)
  const profile = sanitizeString(raw.profile)
  const region = sanitizeString(raw.region)
  const status = raw.status === 'failed' ? 'failed' : raw.status === 'success' ? 'success' : ''

  if (!id || !queryString || !profile || !region || !status) {
    return null
  }

  return {
    id,
    queryString,
    logGroupNames: sanitizeStringArray(raw.logGroupNames),
    profile,
    region,
    serviceHint: sanitizeServiceHint(raw.serviceHint),
    savedQueryId: sanitizeString(raw.savedQueryId),
    status,
    durationMs: sanitizePositiveInteger(raw.durationMs, 1),
    resultSummary: sanitizeString(raw.resultSummary),
    executedAt: sanitizeString(raw.executedAt)
  }
}

function sanitizeDbEngine(value: unknown): DbConnectionEngine {
  return typeof value === 'string' && VALID_DB_ENGINES.has(value as DbConnectionEngine)
    ? value as DbConnectionEngine
    : 'unknown'
}

function sanitizeDbConnectionPreset(value: unknown): DbConnectionPreset | null {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return null
  }

  const id = sanitizeString(raw.id)
  const name = sanitizeString(raw.name)
  const profile = sanitizeString(raw.profile)
  const region = sanitizeString(raw.region)
  const host = sanitizeString(raw.host)

  if (!id || !name || !profile || !region || !host) {
    return null
  }

  const resourceKind = raw.resourceKind === 'rds-instance' || raw.resourceKind === 'rds-cluster' || raw.resourceKind === 'aurora-cluster'
    ? raw.resourceKind
    : 'manual'
  const credentialSourceKind = raw.credentialSourceKind === 'local-vault' || raw.credentialSourceKind === 'aws-secrets-manager'
    ? raw.credentialSourceKind
    : 'manual'

  return {
    id,
    name,
    profile,
    region,
    resourceKind,
    resourceId: sanitizeString(raw.resourceId),
    engine: sanitizeDbEngine(raw.engine),
    host,
    port: sanitizePositiveInteger(raw.port, 5432),
    databaseName: sanitizeString(raw.databaseName),
    username: sanitizeString(raw.username),
    credentialSourceKind,
    credentialSourceRef: sanitizeString(raw.credentialSourceRef),
    notes: sanitizeString(raw.notes),
    createdAt: sanitizeString(raw.createdAt),
    updatedAt: sanitizeString(raw.updatedAt),
    lastUsedAt: sanitizeString(raw.lastUsedAt)
  }
}

function sanitizeState(value: unknown): Phase1FoundationState {
  const raw = isRecord(value) ? value : {}
  return {
    governanceTagDefaults: sanitizeGovernanceTagDefaults(raw.governanceTagDefaults),
    cloudWatchSavedQueries: Array.isArray(raw.cloudWatchSavedQueries)
      ? raw.cloudWatchSavedQueries
        .map((entry) => sanitizeCloudWatchSavedQuery(entry))
        .filter((entry): entry is CloudWatchSavedQuery => Boolean(entry))
      : [],
    cloudWatchInvestigationHistory: Array.isArray(raw.cloudWatchInvestigationHistory)
      ? raw.cloudWatchInvestigationHistory
        .map((entry) => sanitizeCloudWatchInvestigationHistoryEntry(entry))
        .filter((entry): entry is CloudWatchInvestigationHistoryEntry => Boolean(entry))
      : [],
    cloudWatchQueryHistory: Array.isArray(raw.cloudWatchQueryHistory)
      ? raw.cloudWatchQueryHistory
        .map((entry) => sanitizeCloudWatchQueryHistoryEntry(entry))
        .filter((entry): entry is CloudWatchQueryHistoryEntry => Boolean(entry))
      : [],
    dbConnectionPresets: Array.isArray(raw.dbConnectionPresets)
      ? raw.dbConnectionPresets
        .map((entry) => sanitizeDbConnectionPreset(entry))
        .filter((entry): entry is DbConnectionPreset => Boolean(entry))
      : []
  }
}

function readState(): Phase1FoundationState {
  return sanitizeState(readSecureJsonFile<Phase1FoundationState>(foundationsPath(), {
    fallback: DEFAULT_STATE,
    fileLabel: 'Phase 1 foundations'
  }))
}

function writeState(state: Phase1FoundationState): Phase1FoundationState {
  const sanitized = sanitizeState(state)
  writeSecureJsonFile(foundationsPath(), sanitized, 'Phase 1 foundations')
  return sanitized
}

function sortSavedQueries(queries: CloudWatchSavedQuery[]): CloudWatchSavedQuery[] {
  return [...queries].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name)
  )
}

function sortInvestigationHistory(entries: CloudWatchInvestigationHistoryEntry[]): CloudWatchInvestigationHistoryEntry[] {
  return [...entries].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
}

function sortQueryHistory(entries: CloudWatchQueryHistoryEntry[]): CloudWatchQueryHistoryEntry[] {
  return [...entries].sort((left, right) => right.executedAt.localeCompare(left.executedAt))
}

function sortDbConnectionPresets(presets: DbConnectionPreset[]): DbConnectionPreset[] {
  return [...presets].sort((left, right) =>
    (right.lastUsedAt || right.updatedAt).localeCompare(left.lastUsedAt || left.updatedAt) ||
    left.name.localeCompare(right.name)
  )
}

function matchesCloudWatchFilter(
  entry: Pick<CloudWatchSavedQuery, 'profile' | 'region' | 'serviceHint' | 'logGroupNames'>,
  filter?: CloudWatchQueryFilter
): boolean {
  if (!filter) {
    return true
  }

  if (filter.profile && entry.profile !== filter.profile.trim()) {
    return false
  }
  if (filter.region && entry.region !== filter.region.trim()) {
    return false
  }
  if (typeof filter.serviceHint === 'string' && entry.serviceHint !== filter.serviceHint) {
    return false
  }
  if (filter.logGroupName) {
    const needle = filter.logGroupName.trim()
    if (!entry.logGroupNames.includes(needle)) {
      return false
    }
  }

  return true
}

export function getGovernanceTagDefaults(): GovernanceTagDefaults {
  return readState().governanceTagDefaults
}

export function updateGovernanceTagDefaults(update: GovernanceTagDefaultsUpdate): GovernanceTagDefaults {
  const state = readState()
  const nextDefaults: GovernanceTagDefaults = {
    inheritByDefault: typeof update.inheritByDefault === 'boolean'
      ? update.inheritByDefault
      : state.governanceTagDefaults.inheritByDefault,
    values: {
      ...state.governanceTagDefaults.values,
      ...(update.values ?? {})
    },
    updatedAt: new Date().toISOString()
  }

  writeState({
    ...state,
    governanceTagDefaults: sanitizeGovernanceTagDefaults(nextDefaults)
  })

  return getGovernanceTagDefaults()
}

export function listCloudWatchSavedQueries(filter?: CloudWatchQueryFilter): CloudWatchSavedQuery[] {
  const state = readState()
  const filtered = state.cloudWatchSavedQueries.filter((entry) => matchesCloudWatchFilter(entry, filter))
  const sorted = sortSavedQueries(filtered)
  const limit = typeof filter?.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
    ? Math.round(filter.limit)
    : 0
  return limit > 0 ? sorted.slice(0, limit) : sorted
}

export function saveCloudWatchSavedQuery(input: CloudWatchSavedQueryInput): CloudWatchSavedQuery {
  const name = input.name.trim()
  const queryString = input.queryString.trim()
  const profile = input.profile.trim()
  const region = input.region.trim()

  if (!name) {
    throw new Error('Saved query name is required.')
  }
  if (!queryString) {
    throw new Error('CloudWatch query text is required.')
  }
  if (!profile || !region) {
    throw new Error('Saved queries must be scoped to a profile and region.')
  }

  const state = readState()
  const now = new Date().toISOString()
  const existingId = input.id?.trim() ?? ''
  const existing = existingId ? state.cloudWatchSavedQueries.find((entry) => entry.id === existingId) : null
  const nextEntry: CloudWatchSavedQuery = {
    id: existing?.id ?? randomUUID(),
    name,
    description: input.description.trim(),
    queryString,
    logGroupNames: sanitizeStringArray(input.logGroupNames),
    profile,
    region,
    serviceHint: sanitizeServiceHint(input.serviceHint),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt ?? ''
  }

  writeState({
    ...state,
    cloudWatchSavedQueries: sortSavedQueries([
      ...state.cloudWatchSavedQueries.filter((entry) => entry.id !== nextEntry.id),
      nextEntry
    ])
  })

  return nextEntry
}

export function deleteCloudWatchSavedQuery(id: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) {
    return
  }

  const state = readState()
  writeState({
    ...state,
    cloudWatchSavedQueries: state.cloudWatchSavedQueries.filter((entry) => entry.id !== normalizedId)
  })
}

export function listCloudWatchInvestigationHistory(filter?: CloudWatchQueryFilter): CloudWatchInvestigationHistoryEntry[] {
  const state = readState()
  const filtered = state.cloudWatchInvestigationHistory.filter((entry) => matchesCloudWatchFilter(entry, filter))
  const sorted = sortInvestigationHistory(filtered)
  const limit = typeof filter?.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
    ? Math.round(filter.limit)
    : 0
  return limit > 0 ? sorted.slice(0, limit) : sorted
}

export function recordCloudWatchInvestigationHistory(
  input: CloudWatchInvestigationHistoryInput
): CloudWatchInvestigationHistoryEntry {
  const profile = input.profile.trim()
  const region = input.region.trim()
  const title = input.title.trim()
  const detail = input.detail.trim()

  if (!profile || !region) {
    throw new Error('CloudWatch investigation history entries must be scoped to a profile and region.')
  }
  if (!title || !detail) {
    throw new Error('CloudWatch investigation history entries require a title and detail.')
  }

  const state = readState()
  const entry: CloudWatchInvestigationHistoryEntry = {
    id: randomUUID(),
    profile,
    region,
    serviceHint: sanitizeServiceHint(input.serviceHint),
    logGroupNames: sanitizeStringArray(input.logGroupNames),
    kind: input.kind,
    title,
    detail,
    severity: input.severity,
    occurredAt: new Date().toISOString()
  }

  writeState({
    ...state,
    cloudWatchInvestigationHistory: sortInvestigationHistory([entry, ...state.cloudWatchInvestigationHistory]).slice(0, MAX_QUERY_HISTORY)
  })

  return entry
}

export function listCloudWatchQueryHistory(filter?: CloudWatchQueryFilter): CloudWatchQueryHistoryEntry[] {
  const state = readState()
  const filtered = state.cloudWatchQueryHistory.filter((entry) => matchesCloudWatchFilter(entry, filter))
  const sorted = sortQueryHistory(filtered)
  const limit = typeof filter?.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
    ? Math.round(filter.limit)
    : 0
  return limit > 0 ? sorted.slice(0, limit) : sorted
}

export function recordCloudWatchQueryHistory(input: CloudWatchQueryHistoryInput): CloudWatchQueryHistoryEntry {
  const queryString = input.queryString.trim()
  const profile = input.profile.trim()
  const region = input.region.trim()

  if (!queryString) {
    throw new Error('CloudWatch query history entries require query text.')
  }
  if (!profile || !region) {
    throw new Error('CloudWatch query history entries must be scoped to a profile and region.')
  }

  const state = readState()
  const now = new Date().toISOString()
  const entry: CloudWatchQueryHistoryEntry = {
    id: randomUUID(),
    queryString,
    logGroupNames: sanitizeStringArray(input.logGroupNames),
    profile,
    region,
    serviceHint: sanitizeServiceHint(input.serviceHint),
    savedQueryId: input.savedQueryId.trim(),
    status: input.status === 'failed' ? 'failed' : 'success',
    durationMs: sanitizePositiveInteger(input.durationMs, 1),
    resultSummary: input.resultSummary.trim(),
    executedAt: now
  }

  const nextSavedQueries = state.cloudWatchSavedQueries.map((savedQuery) =>
    savedQuery.id === entry.savedQueryId
      ? { ...savedQuery, lastRunAt: now, updatedAt: now }
      : savedQuery
  )

  writeState({
    ...state,
    cloudWatchSavedQueries: sortSavedQueries(nextSavedQueries),
    cloudWatchQueryHistory: sortQueryHistory([entry, ...state.cloudWatchQueryHistory]).slice(0, MAX_QUERY_HISTORY)
  })

  return entry
}

export function clearCloudWatchQueryHistory(filter?: CloudWatchQueryFilter): number {
  const state = readState()
  const remaining = state.cloudWatchQueryHistory.filter((entry) => !matchesCloudWatchFilter(entry, filter))
  const removedCount = state.cloudWatchQueryHistory.length - remaining.length

  if (removedCount > 0) {
    writeState({
      ...state,
      cloudWatchQueryHistory: remaining
    })
  }

  return removedCount
}

export function clearCloudWatchInvestigationHistory(filter?: CloudWatchQueryFilter): number {
  const state = readState()
  const remaining = state.cloudWatchInvestigationHistory.filter((entry) => !matchesCloudWatchFilter(entry, filter))
  const removedCount = state.cloudWatchInvestigationHistory.length - remaining.length

  if (removedCount > 0) {
    writeState({
      ...state,
      cloudWatchInvestigationHistory: remaining
    })
  }

  return removedCount
}

export function listDbConnectionPresets(filter?: DbConnectionPresetFilter): DbConnectionPreset[] {
  const state = readState()
  return sortDbConnectionPresets(state.dbConnectionPresets.filter((entry) => {
    if (!filter) {
      return true
    }
    if (filter.profile && entry.profile !== filter.profile.trim()) {
      return false
    }
    if (filter.region && entry.region !== filter.region.trim()) {
      return false
    }
    if (filter.resourceId && entry.resourceId !== filter.resourceId.trim()) {
      return false
    }
    if (filter.engine && entry.engine !== filter.engine) {
      return false
    }
    return true
  }))
}

export function saveDbConnectionPreset(input: DbConnectionPresetInput): DbConnectionPreset {
  const name = input.name.trim()
  const profile = input.profile.trim()
  const region = input.region.trim()
  const host = input.host.trim()

  if (!name) {
    throw new Error('Database connection preset name is required.')
  }
  if (!profile || !region) {
    throw new Error('Database connection presets must be scoped to a profile and region.')
  }
  if (!host) {
    throw new Error('Database host is required.')
  }

  const state = readState()
  const now = new Date().toISOString()
  const existingId = input.id?.trim() ?? ''
  const existing = existingId ? state.dbConnectionPresets.find((entry) => entry.id === existingId) : null
  const nextEntry: DbConnectionPreset = {
    id: existing?.id ?? randomUUID(),
    name,
    profile,
    region,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId.trim(),
    engine: sanitizeDbEngine(input.engine),
    host,
    port: sanitizePositiveInteger(input.port, 5432),
    databaseName: input.databaseName.trim(),
    username: input.username.trim(),
    credentialSourceKind: input.credentialSourceKind,
    credentialSourceRef: input.credentialSourceRef.trim(),
    notes: input.notes.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt ?? ''
  }

  writeState({
    ...state,
    dbConnectionPresets: sortDbConnectionPresets([
      ...state.dbConnectionPresets.filter((entry) => entry.id !== nextEntry.id),
      nextEntry
    ])
  })

  return nextEntry
}

export function deleteDbConnectionPreset(id: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) {
    return
  }

  const state = readState()
  writeState({
    ...state,
    dbConnectionPresets: state.dbConnectionPresets.filter((entry) => entry.id !== normalizedId)
  })
}

export function markDbConnectionPresetUsed(id: string): DbConnectionPreset {
  const normalizedId = id.trim()
  if (!normalizedId) {
    throw new Error('Database connection preset id is required.')
  }

  const state = readState()
  const existing = state.dbConnectionPresets.find((entry) => entry.id === normalizedId)
  if (!existing) {
    throw new Error('Database connection preset was not found.')
  }

  const nextEntry: DbConnectionPreset = {
    ...existing,
    lastUsedAt: new Date().toISOString()
  }

  writeState({
    ...state,
    dbConnectionPresets: sortDbConnectionPresets([
      ...state.dbConnectionPresets.filter((entry) => entry.id !== normalizedId),
      nextEntry
    ])
  })

  return nextEntry
}
