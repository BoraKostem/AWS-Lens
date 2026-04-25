import { X509Certificate } from 'node:crypto'
import path from 'node:path'

import { app } from 'electron'

/** Parse JSON while stripping prototype-polluting keys (__proto__, constructor, prototype) */
function safeJsonParse<T>(raw: string): T {
  return JSON.parse(raw, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined
    return value
  }) as T
}

import type {
  AzureServicePrincipalCertPayload,
  AzureServicePrincipalSecretPayload,
  CloudProviderId,
  GcpExternalAccountPayload,
  GcpServiceAccountKeyPayload,
  ProviderApiTokenPayload,
  SecretManagerReferencePayload,
  VaultApiTokenProvider,
  VaultEntryFilter,
  VaultEntryInput,
  VaultEntryKind,
  VaultEntrySummary,
  VaultEntryUsage,
  VaultEntryUsageInput,
  VaultOrigin,
  VaultRotationState,
  VaultSecretReferenceProvider,
  DbConnectionEngine,
  DbVaultCredentialInput,
  DbVaultCredentialSummary
} from '@shared/types'
import { VAULT_METADATA_KEYS } from '@shared/types'
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
  reminderAt: string
  expiryAt: string
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

const ROTATION_DUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function isExpiringSoon(expiryAt: string): boolean {
  if (!expiryAt) {
    return false
  }
  const expiry = new Date(expiryAt).getTime()
  if (Number.isNaN(expiry)) {
    return false
  }
  const now = Date.now()
  return expiry - now > 0 && expiry - now <= ROTATION_DUE_WINDOW_MS
}

export function getVaultEntryCounts(): {
  all: number
  awsProfiles: number
  sshKeys: number
  pem: number
  accessKeys: number
  gcpServiceAccountKeys: number
  gcpWorkloadIdentities: number
  azureServicePrincipals: number
  providerApiTokens: number
  secretManagerReferences: number
  expiringSoon: number
  rotationDue: number
} {
  const all = listVaultEntries()
  let expiringSoon = 0
  let rotationDue = 0
  for (const entry of all) {
    if (isExpiringSoon(entry.expiryAt)) {
      expiringSoon += 1
    }
    if (entry.rotationState === 'rotation-due') {
      rotationDue += 1
    }
  }
  return {
    all: all.length,
    awsProfiles: all.filter((entry) => entry.kind === 'aws-profile').length,
    sshKeys: all.filter((entry) => entry.kind === 'ssh-key').length,
    pem: all.filter((entry) => entry.kind === 'pem').length,
    accessKeys: all.filter((entry) => entry.kind === 'access-key').length,
    gcpServiceAccountKeys: all.filter((entry) => entry.kind === 'gcp-service-account-key').length,
    gcpWorkloadIdentities: all.filter((entry) => entry.kind === 'gcp-workload-identity').length,
    azureServicePrincipals: all.filter(
      (entry) => entry.kind === 'azure-service-principal-secret' || entry.kind === 'azure-service-principal-cert'
    ).length,
    providerApiTokens: all.filter((entry) => entry.kind === 'provider-api-token').length,
    secretManagerReferences: all.filter((entry) => entry.kind === 'secret-manager-reference').length,
    expiringSoon,
    rotationDue
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
    case 'kubeconfig-fragment':
    case 'api-token':
    case 'connection-secret':
    case 'gcp-service-account-key':
    case 'gcp-workload-identity':
    case 'azure-service-principal-secret':
    case 'azure-service-principal-cert':
    case 'provider-api-token':
    case 'secret-manager-reference':
      return value
    default:
      return 'generic'
  }
}

function sanitizeOrigin(value: unknown): VaultOrigin {
  switch (value) {
    case 'manual':
    case 'imported':
    case 'imported-file':
    case 'aws-secrets-manager':
    case 'aws-ssm':
    case 'aws-iam':
    case 'gcp-iam-key':
    case 'gcp-secret-manager':
    case 'azure-app-registration':
    case 'azure-key-vault':
    case 'generated':
    case 'unknown':
      return value
    default:
      return DEFAULT_VAULT_ORIGIN
  }
}

function sanitizeCloudProvider(value: unknown): CloudProviderId | undefined {
  switch (value) {
    case 'aws':
    case 'gcp':
    case 'azure':
      return value
    default:
      return undefined
  }
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim())
}

const VALID_API_TOKEN_PROVIDERS: VaultApiTokenProvider[] = [
  'openai',
  'anthropic',
  'gemini',
  'vertex-ai',
  'bedrock',
  'azure-openai',
  'mistral',
  'cohere',
  'other'
]

const VALID_SECRET_REFERENCE_PROVIDERS: VaultSecretReferenceProvider[] = [
  'gcp-secret-manager',
  'azure-key-vault'
]

export class VaultValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'VaultValidationError'
    this.field = field
  }
}

export function parseGcpServiceAccountKey(raw: string): GcpServiceAccountKeyPayload {
  let parsed: Partial<GcpServiceAccountKeyPayload>
  try {
    parsed = safeJsonParse<Partial<GcpServiceAccountKeyPayload>>(raw)
  } catch {
    throw new VaultValidationError('secret', 'Service account key must be valid JSON.')
  }

  if (parsed.type !== 'service_account') {
    throw new VaultValidationError('type', 'Expected "type": "service_account" in the GCP key.')
  }
  const projectId = (parsed.project_id ?? '').trim()
  if (!projectId) {
    throw new VaultValidationError('project_id', 'GCP service account key must include project_id.')
  }
  const clientEmail = (parsed.client_email ?? '').trim()
  if (!clientEmail || !clientEmail.includes('@')) {
    throw new VaultValidationError('client_email', 'GCP service account key must include a valid client_email.')
  }
  const privateKey = parsed.private_key ?? ''
  if (!privateKey.includes('BEGIN PRIVATE KEY') && !privateKey.includes('BEGIN RSA PRIVATE KEY')) {
    throw new VaultValidationError('private_key', 'GCP service account key is missing a PEM private_key block.')
  }
  const privateKeyId = (parsed.private_key_id ?? '').trim()
  if (!privateKeyId) {
    throw new VaultValidationError('private_key_id', 'GCP service account key must include private_key_id.')
  }

  return {
    type: 'service_account',
    project_id: projectId,
    private_key_id: privateKeyId,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: typeof parsed.client_id === 'string' ? parsed.client_id : undefined,
    auth_uri: typeof parsed.auth_uri === 'string' ? parsed.auth_uri : undefined,
    token_uri: typeof parsed.token_uri === 'string' ? parsed.token_uri : undefined,
    auth_provider_x509_cert_url:
      typeof parsed.auth_provider_x509_cert_url === 'string' ? parsed.auth_provider_x509_cert_url : undefined,
    client_x509_cert_url:
      typeof parsed.client_x509_cert_url === 'string' ? parsed.client_x509_cert_url : undefined,
    universe_domain: typeof parsed.universe_domain === 'string' ? parsed.universe_domain : undefined
  }
}

export function parseGcpExternalAccount(raw: string): GcpExternalAccountPayload {
  let parsed: Partial<GcpExternalAccountPayload>
  try {
    parsed = safeJsonParse<Partial<GcpExternalAccountPayload>>(raw)
  } catch {
    throw new VaultValidationError('secret', 'Workload identity payload must be valid JSON.')
  }

  if (parsed.type !== 'external_account') {
    throw new VaultValidationError('type', 'Expected "type": "external_account" in the workload identity config.')
  }
  const audience = (parsed.audience ?? '').trim()
  if (!audience) {
    throw new VaultValidationError('audience', 'Workload identity config must include audience.')
  }
  const subjectTokenType = (parsed.subject_token_type ?? '').trim()
  if (!subjectTokenType) {
    throw new VaultValidationError('subject_token_type', 'Workload identity config must include subject_token_type.')
  }

  return {
    type: 'external_account',
    audience,
    subject_token_type: subjectTokenType,
    token_url: typeof parsed.token_url === 'string' ? parsed.token_url : undefined,
    service_account_impersonation_url:
      typeof parsed.service_account_impersonation_url === 'string'
        ? parsed.service_account_impersonation_url
        : undefined,
    credential_source:
      parsed.credential_source && typeof parsed.credential_source === 'object'
        ? (parsed.credential_source as Record<string, unknown>)
        : undefined,
    workforce_pool_user_project:
      typeof parsed.workforce_pool_user_project === 'string' ? parsed.workforce_pool_user_project : undefined
  }
}

export function validateAzureSpSecret(payload: AzureServicePrincipalSecretPayload): AzureServicePrincipalSecretPayload {
  if (payload.authMethod !== 'client-secret') {
    throw new VaultValidationError('authMethod', 'Expected authMethod "client-secret".')
  }
  const tenantId = payload.tenantId.trim()
  if (!isUuid(tenantId)) {
    throw new VaultValidationError('tenantId', 'tenantId must be a valid UUID.')
  }
  const clientId = payload.clientId.trim()
  if (!isUuid(clientId)) {
    throw new VaultValidationError('clientId', 'clientId must be a valid UUID.')
  }
  const subscriptionId = payload.subscriptionId.trim()
  if (!isUuid(subscriptionId)) {
    throw new VaultValidationError('subscriptionId', 'subscriptionId must be a valid UUID.')
  }
  const clientSecret = payload.clientSecret.trim()
  if (!clientSecret) {
    throw new VaultValidationError('clientSecret', 'clientSecret is required.')
  }
  const expiryAt = (payload.expiryAt ?? '').trim()
  if (expiryAt && Number.isNaN(new Date(expiryAt).getTime())) {
    throw new VaultValidationError('expiryAt', 'expiryAt must be an ISO date string.')
  }

  return {
    authMethod: 'client-secret',
    tenantId,
    clientId,
    subscriptionId,
    clientSecret,
    expiryAt: expiryAt || undefined,
    notes: payload.notes?.trim() || undefined
  }
}

function extractCertMetadata(certPem: string): {
  notBefore?: string
  notAfter?: string
  thumbprint?: string
} {
  try {
    const cert = new X509Certificate(certPem)
    const notBefore = cert.validFrom ? new Date(cert.validFrom).toISOString() : undefined
    const notAfter = cert.validTo ? new Date(cert.validTo).toISOString() : undefined
    // fingerprint256 is "AA:BB:CC:..." → strip colons for thumbprint usage
    const thumbprint = typeof cert.fingerprint256 === 'string' ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : undefined
    return {
      notBefore: notBefore && !Number.isNaN(new Date(notBefore).getTime()) ? notBefore : undefined,
      notAfter: notAfter && !Number.isNaN(new Date(notAfter).getTime()) ? notAfter : undefined,
      thumbprint
    }
  } catch {
    return {}
  }
}

export function validateAzureSpCert(payload: AzureServicePrincipalCertPayload): AzureServicePrincipalCertPayload {
  if (payload.authMethod !== 'client-certificate') {
    throw new VaultValidationError('authMethod', 'Expected authMethod "client-certificate".')
  }
  const tenantId = payload.tenantId.trim()
  if (!isUuid(tenantId)) {
    throw new VaultValidationError('tenantId', 'tenantId must be a valid UUID.')
  }
  const clientId = payload.clientId.trim()
  if (!isUuid(clientId)) {
    throw new VaultValidationError('clientId', 'clientId must be a valid UUID.')
  }
  const subscriptionId = payload.subscriptionId.trim()
  if (!isUuid(subscriptionId)) {
    throw new VaultValidationError('subscriptionId', 'subscriptionId must be a valid UUID.')
  }
  const certPem = payload.certificatePem ?? ''
  if (!certPem.includes('BEGIN CERTIFICATE')) {
    throw new VaultValidationError('certificatePem', 'Certificate must be a PEM block (BEGIN CERTIFICATE).')
  }
  const keyPem = payload.privateKeyPem ?? ''
  if (!keyPem.includes('BEGIN PRIVATE KEY') && !keyPem.includes('BEGIN RSA PRIVATE KEY') && !keyPem.includes('BEGIN EC PRIVATE KEY')) {
    throw new VaultValidationError('privateKeyPem', 'Private key must be a PEM block.')
  }

  const certMeta = extractCertMetadata(certPem)
  return {
    authMethod: 'client-certificate',
    tenantId,
    clientId,
    subscriptionId,
    certificatePem: certPem,
    privateKeyPem: keyPem,
    certThumbprint: payload.certThumbprint?.trim() || certMeta.thumbprint,
    notBefore: payload.notBefore?.trim() || certMeta.notBefore,
    notAfter: payload.notAfter?.trim() || certMeta.notAfter,
    notes: payload.notes?.trim() || undefined
  }
}

export function parseProviderApiToken(payload: ProviderApiTokenPayload): ProviderApiTokenPayload {
  if (!VALID_API_TOKEN_PROVIDERS.includes(payload.provider)) {
    throw new VaultValidationError('provider', `Unsupported API token provider: ${payload.provider}`)
  }
  const token = payload.token.trim()
  if (!token) {
    throw new VaultValidationError('token', 'API token is required.')
  }
  return {
    provider: payload.provider,
    token,
    scope: payload.scope?.trim() || undefined,
    baseUrl: payload.baseUrl?.trim() || undefined,
    expiryAt: payload.expiryAt?.trim() || undefined,
    notes: payload.notes?.trim() || undefined
  }
}

const SECRET_REFERENCE_URI_PATTERNS: Record<VaultSecretReferenceProvider, RegExp> = {
  'gcp-secret-manager': /^gcp-secret-manager:\/\/projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+(?:\/versions\/[A-Za-z0-9_-]+)?$/,
  'azure-key-vault': /^azure-key-vault:\/\/[A-Za-z0-9-]+\/secrets\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/
}

export function parseSecretManagerReference(payload: SecretManagerReferencePayload): SecretManagerReferencePayload {
  if (!VALID_SECRET_REFERENCE_PROVIDERS.includes(payload.provider)) {
    throw new VaultValidationError('provider', `Unsupported secret manager provider: ${payload.provider}`)
  }
  const uri = payload.uri.trim()
  if (!uri) {
    throw new VaultValidationError('uri', 'Secret reference URI is required.')
  }
  const pattern = SECRET_REFERENCE_URI_PATTERNS[payload.provider]
  if (!pattern.test(uri)) {
    throw new VaultValidationError(
      'uri',
      payload.provider === 'gcp-secret-manager'
        ? 'GCP secret URI must look like gcp-secret-manager://projects/<id>/secrets/<name>[/versions/<v>].'
        : 'Azure secret URI must look like azure-key-vault://<vault>/secrets/<name>[/<version>].'
    )
  }

  return {
    provider: payload.provider,
    uri,
    description: payload.description?.trim() || undefined,
    localFallback: payload.localFallback ?? undefined
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

  const raw = value as Record<string, unknown>
  return {
    usedAt: sanitizeString(raw.usedAt),
    source: sanitizeString(raw.source),
    profile: sanitizeString(raw.profile),
    region: sanitizeString(raw.region),
    resourceId: sanitizeString(raw.resourceId),
    resourceLabel: sanitizeString(raw.resourceLabel),
    cloudProvider: sanitizeCloudProvider(raw.cloudProvider)
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
    reminderAt: sanitizeString(raw.reminderAt),
    expiryAt: sanitizeString(raw.expiryAt),
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
    reminderAt: entry.reminderAt,
    expiryAt: entry.expiryAt,
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
    lastUsedContext: existing?.lastUsedContext ?? null,
    reminderAt: existing?.reminderAt ?? '',
    expiryAt: existing?.expiryAt ?? ''
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
    const parsed = safeJsonParse<Partial<AwsProfileVaultSecret>>(raw)
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
    const parsed = safeJsonParse<Partial<DbVaultCredentialSecret>>(raw)
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

type ValidatedVaultPayload = {
  secret: string
  metadata: Record<string, string>
  expiryAt?: string
}

function validateAndPackPayload(input: VaultEntryInput): ValidatedVaultPayload {
  const baseMetadata = sanitizeMetadata(input.metadata)

  switch (input.kind) {
    case 'gcp-service-account-key': {
      const parsed = parseGcpServiceAccountKey(input.secret)
      return {
        secret: JSON.stringify(parsed),
        metadata: {
          ...baseMetadata,
          [VAULT_METADATA_KEYS.cloudProvider]: 'gcp',
          [VAULT_METADATA_KEYS.projectId]: parsed.project_id,
          [VAULT_METADATA_KEYS.clientEmail]: parsed.client_email,
          [VAULT_METADATA_KEYS.privateKeyId]: parsed.private_key_id
        }
      }
    }
    case 'gcp-workload-identity': {
      const parsed = parseGcpExternalAccount(input.secret)
      const metadata: Record<string, string> = {
        ...baseMetadata,
        [VAULT_METADATA_KEYS.cloudProvider]: 'gcp',
        [VAULT_METADATA_KEYS.audience]: parsed.audience,
        [VAULT_METADATA_KEYS.subjectTokenType]: parsed.subject_token_type
      }
      if (parsed.service_account_impersonation_url) {
        metadata[VAULT_METADATA_KEYS.impersonationTarget] = parsed.service_account_impersonation_url
      }
      return { secret: JSON.stringify(parsed), metadata }
    }
    case 'azure-service-principal-secret': {
      let payload: AzureServicePrincipalSecretPayload
      try {
        payload = safeJsonParse<AzureServicePrincipalSecretPayload>(input.secret)
      } catch {
        throw new VaultValidationError('secret', 'Azure service principal payload must be JSON-encoded.')
      }
      const validated = validateAzureSpSecret(payload)
      return {
        secret: JSON.stringify(validated),
        metadata: {
          ...baseMetadata,
          [VAULT_METADATA_KEYS.cloudProvider]: 'azure',
          [VAULT_METADATA_KEYS.tenantId]: validated.tenantId,
          [VAULT_METADATA_KEYS.clientId]: validated.clientId,
          [VAULT_METADATA_KEYS.subscriptionId]: validated.subscriptionId
        },
        expiryAt: validated.expiryAt
      }
    }
    case 'azure-service-principal-cert': {
      let payload: AzureServicePrincipalCertPayload
      try {
        payload = safeJsonParse<AzureServicePrincipalCertPayload>(input.secret)
      } catch {
        throw new VaultValidationError('secret', 'Azure SP cert payload must be JSON-encoded.')
      }
      const validated = validateAzureSpCert(payload)
      const metadata: Record<string, string> = {
        ...baseMetadata,
        [VAULT_METADATA_KEYS.cloudProvider]: 'azure',
        [VAULT_METADATA_KEYS.tenantId]: validated.tenantId,
        [VAULT_METADATA_KEYS.clientId]: validated.clientId,
        [VAULT_METADATA_KEYS.subscriptionId]: validated.subscriptionId
      }
      if (validated.certThumbprint) {
        metadata[VAULT_METADATA_KEYS.certThumbprint] = validated.certThumbprint
      }
      if (validated.notBefore) {
        metadata[VAULT_METADATA_KEYS.certNotBefore] = validated.notBefore
      }
      if (validated.notAfter) {
        metadata[VAULT_METADATA_KEYS.certNotAfter] = validated.notAfter
      }
      return {
        secret: JSON.stringify(validated),
        metadata,
        expiryAt: validated.notAfter
      }
    }
    case 'provider-api-token': {
      let payload: ProviderApiTokenPayload
      try {
        payload = safeJsonParse<ProviderApiTokenPayload>(input.secret)
      } catch {
        throw new VaultValidationError('secret', 'Provider API token payload must be JSON-encoded.')
      }
      const validated = parseProviderApiToken(payload)
      const metadata: Record<string, string> = {
        ...baseMetadata,
        [VAULT_METADATA_KEYS.tokenProvider]: validated.provider
      }
      if (validated.scope) {
        metadata[VAULT_METADATA_KEYS.scope] = validated.scope
      }
      if (validated.baseUrl) {
        metadata[VAULT_METADATA_KEYS.baseUrl] = validated.baseUrl
      }
      return { secret: JSON.stringify(validated), metadata, expiryAt: validated.expiryAt }
    }
    case 'secret-manager-reference': {
      let payload: SecretManagerReferencePayload
      try {
        payload = safeJsonParse<SecretManagerReferencePayload>(input.secret)
      } catch {
        throw new VaultValidationError('secret', 'Secret reference payload must be JSON-encoded.')
      }
      const validated = parseSecretManagerReference(payload)
      const metadata: Record<string, string> = {
        ...baseMetadata,
        [VAULT_METADATA_KEYS.secretReferenceProvider]: validated.provider,
        [VAULT_METADATA_KEYS.secretReferenceUri]: validated.uri
      }
      if (validated.description) {
        metadata.description = validated.description
      }
      if (validated.localFallback !== undefined) {
        metadata[VAULT_METADATA_KEYS.localFallback] = '1'
      }
      return { secret: JSON.stringify(validated), metadata }
    }
    default:
      return { secret: input.secret.trim(), metadata: baseMetadata }
  }
}

export function saveVaultEntry(input: VaultEntryInput): VaultEntrySummary {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Vault entry name is required.')
  }

  if (typeof input.secret !== 'string' || !input.secret.trim()) {
    throw new Error('Vault entry secret is required.')
  }

  const validated = validateAndPackPayload(input)
  const secret = validated.secret.trim()
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
    metadata: validated.metadata,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    origin: input.origin ?? existing?.origin ?? DEFAULT_VAULT_ORIGIN,
    rotationState: input.rotationState ?? existing?.rotationState ?? DEFAULT_ROTATION_STATE,
    rotationUpdatedAt: sanitizeString(input.rotationUpdatedAt) || existing?.rotationUpdatedAt || '',
    reminderAt: sanitizeString(input.reminderAt) || existing?.reminderAt || '',
    expiryAt:
      sanitizeString(input.expiryAt) || validated.expiryAt || existing?.expiryAt || '',
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
    resourceLabel: sanitizeString(input.resourceLabel),
    cloudProvider: sanitizeCloudProvider(input.cloudProvider)
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

/**
 * Mark a vault entry as validated (or failed). Updates lastValidatedAt
 * metadata on success and lastValidationStatus/Message on either path.
 */
export function markVaultEntryValidated(
  entryId: string,
  result: { ok: boolean; message: string }
): VaultEntrySummary | null {
  const entry = getEntryById(entryId)
  if (!entry) {
    return null
  }
  const now = new Date().toISOString()
  const metadata = { ...entry.metadata }
  metadata[VAULT_METADATA_KEYS.lastValidationStatus] = result.ok ? 'ok' : 'failed'
  metadata[VAULT_METADATA_KEYS.lastValidationMessage] = result.message.slice(0, 500)
  if (result.ok) {
    metadata[VAULT_METADATA_KEYS.lastValidatedAt] = now
  }

  // Update rotationState heuristic: cert/secret nearing expiry → 'rotation-due'.
  let rotationState = entry.rotationState
  if (entry.expiryAt) {
    const expiry = new Date(entry.expiryAt).getTime()
    if (!Number.isNaN(expiry)) {
      const diff = expiry - Date.now()
      if (diff <= 0) {
        rotationState = 'rotation-due'
      } else if (diff <= 7 * 24 * 60 * 60 * 1000) {
        rotationState = 'rotation-due'
      }
    }
  }

  const next: VaultEntry = {
    ...entry,
    metadata,
    rotationState,
    rotationUpdatedAt: rotationState !== entry.rotationState ? now : entry.rotationUpdatedAt,
    updatedAt: now
  }
  upsertEntry(next)
  return toSummary(next)
}

// ===== Typed wrappers per kind (mirror getAwsProfileVaultSecret pattern) =====

function readTypedSecret<T>(kind: VaultEntryKind, name: string): T | null {
  const raw = getVaultSecret(kind, name)
  if (!raw) {
    return null
  }
  try {
    return safeJsonParse<T>(raw)
  } catch {
    return null
  }
}

export function listGcpServiceAccountVaultEntries(): VaultEntrySummary[] {
  return listVaultEntries('gcp-service-account-key')
}

export function getGcpServiceAccountSecret(name: string): GcpServiceAccountKeyPayload | null {
  return readTypedSecret<GcpServiceAccountKeyPayload>('gcp-service-account-key', name)
}

export function setGcpServiceAccountVaultEntry(
  name: string,
  rawJson: string,
  options?: { origin?: VaultOrigin; rotationState?: VaultRotationState }
): VaultEntrySummary {
  return saveVaultEntry({
    kind: 'gcp-service-account-key',
    name: name.trim(),
    secret: rawJson,
    origin: options?.origin ?? 'manual',
    rotationState: options?.rotationState ?? 'unknown'
  })
}

export function listGcpWorkloadIdentityVaultEntries(): VaultEntrySummary[] {
  return listVaultEntries('gcp-workload-identity')
}

export function getGcpWorkloadIdentitySecret(name: string): GcpExternalAccountPayload | null {
  return readTypedSecret<GcpExternalAccountPayload>('gcp-workload-identity', name)
}

export function setGcpWorkloadIdentityVaultEntry(
  name: string,
  rawJson: string,
  options?: { origin?: VaultOrigin }
): VaultEntrySummary {
  return saveVaultEntry({
    kind: 'gcp-workload-identity',
    name: name.trim(),
    secret: rawJson,
    origin: options?.origin ?? 'manual',
    rotationState: 'not-applicable'
  })
}

export function listAzureServicePrincipalVaultEntries(): VaultEntrySummary[] {
  return [
    ...listVaultEntries('azure-service-principal-secret'),
    ...listVaultEntries('azure-service-principal-cert')
  ]
}

export function getAzureServicePrincipalSecretPayload(
  name: string
): AzureServicePrincipalSecretPayload | null {
  return readTypedSecret<AzureServicePrincipalSecretPayload>('azure-service-principal-secret', name)
}

export function getAzureServicePrincipalCertPayload(
  name: string
): AzureServicePrincipalCertPayload | null {
  return readTypedSecret<AzureServicePrincipalCertPayload>('azure-service-principal-cert', name)
}

export function setAzureServicePrincipalSecretVaultEntry(
  name: string,
  payload: AzureServicePrincipalSecretPayload,
  options?: { origin?: VaultOrigin }
): VaultEntrySummary {
  return saveVaultEntry({
    kind: 'azure-service-principal-secret',
    name: name.trim(),
    secret: JSON.stringify(payload),
    origin: options?.origin ?? 'manual',
    rotationState: 'unknown'
  })
}

export function setAzureServicePrincipalCertVaultEntry(
  name: string,
  payload: AzureServicePrincipalCertPayload,
  options?: { origin?: VaultOrigin }
): VaultEntrySummary {
  return saveVaultEntry({
    kind: 'azure-service-principal-cert',
    name: name.trim(),
    secret: JSON.stringify(payload),
    origin: options?.origin ?? 'manual',
    rotationState: 'unknown'
  })
}

export function listProviderApiTokenVaultEntries(): VaultEntrySummary[] {
  return listVaultEntries('provider-api-token')
}

export function getProviderApiTokenSecret(name: string): ProviderApiTokenPayload | null {
  return readTypedSecret<ProviderApiTokenPayload>('provider-api-token', name)
}

export function setProviderApiTokenVaultEntry(
  name: string,
  payload: ProviderApiTokenPayload,
  options?: { origin?: VaultOrigin }
): VaultEntrySummary {
  return saveVaultEntry({
    kind: 'provider-api-token',
    name: name.trim(),
    secret: JSON.stringify(payload),
    origin: options?.origin ?? 'manual',
    rotationState: 'unknown'
  })
}

export function listSecretManagerReferenceVaultEntries(): VaultEntrySummary[] {
  return listVaultEntries('secret-manager-reference')
}

export function getSecretManagerReferencePayload(name: string): SecretManagerReferencePayload | null {
  return readTypedSecret<SecretManagerReferencePayload>('secret-manager-reference', name)
}

export function setSecretManagerReferenceVaultEntry(
  name: string,
  payload: SecretManagerReferencePayload,
  options?: { origin?: VaultOrigin }
): VaultEntrySummary {
  return saveVaultEntry({
    kind: 'secret-manager-reference',
    name: name.trim(),
    secret: JSON.stringify(payload),
    origin: options?.origin ?? 'manual',
    rotationState: 'not-applicable'
  })
}
