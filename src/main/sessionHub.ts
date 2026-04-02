import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { app } from 'electron'

import type {
  AssumeRoleRequest,
  AssumeRoleResult,
  AwsAssumeRoleTarget,
  AwsConnection,
  AwsCredentialSnapshot,
  AwsSessionSummary,
  SessionHubState
} from '@shared/types'
import { createProfileCredentialsProvider } from './aws/profileCredentials'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type PersistedState = {
  targets: AwsAssumeRoleTarget[]
}

type InMemorySession = {
  id: string
  label: string
  roleArn: string
  sourceProfile: string
  region: string
  externalId: string
  createdAt: string
  updatedAt: string
  assumedRoleArn: string
  assumedRoleId: string
  accountId: string
  credentials: AwsCredentialSnapshot
}

const sessionStore = new Map<string, InMemorySession>()

const REGION_NORMALIZATIONS: Record<string, string> = {
  'eu-cental-1': 'eu-central-1',
  'ca-cental-1': 'ca-central-1',
  'me-cental-1': 'me-central-1',
  'il-cental-1': 'il-central-1'
}

function normalizeRegion(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }

  const lower = trimmed.toLowerCase()
  return REGION_NORMALIZATIONS[lower] ?? lower
}

function sessionHubPath(): string {
  return path.join(app.getPath('userData'), 'session-hub.json')
}

function readPersistedState(): PersistedState {
  const parsed = readSecureJsonFile<Partial<PersistedState>>(sessionHubPath(), {
    fallback: { targets: [] },
    fileLabel: 'Session Hub state'
  })
  return {
    targets: Array.isArray(parsed.targets) ? parsed.targets.filter(isAssumeRoleTarget) : []
  }
}

function writePersistedState(state: PersistedState): void {
  writeSecureJsonFile(sessionHubPath(), state, 'Session Hub state')
}

function isAssumeRoleTarget(value: unknown): value is AwsAssumeRoleTarget {
  if (!value || typeof value !== 'object') {
    return false
  }

  const target = value as Record<string, unknown>
  return (
    typeof target.id === 'string' &&
    typeof target.label === 'string' &&
    typeof target.roleArn === 'string' &&
    typeof target.defaultSessionName === 'string' &&
    typeof target.externalId === 'string' &&
    typeof target.sourceProfile === 'string' &&
    typeof target.defaultRegion === 'string' &&
    typeof target.createdAt === 'string' &&
    typeof target.updatedAt === 'string'
  )
}

function sortTargets(targets: AwsAssumeRoleTarget[]): AwsAssumeRoleTarget[] {
  return [...targets].sort((left, right) => left.label.localeCompare(right.label))
}

function sortSessions(sessions: AwsSessionSummary[]): AwsSessionSummary[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function toSessionSummary(session: InMemorySession): AwsSessionSummary {
  return {
    id: session.id,
    kind: 'assumed-role',
    label: session.label,
    profile: session.sourceProfile,
    region: session.region,
    status: isExpired(session.credentials.expiration) ? 'expired' : 'active',
    sourceProfile: session.sourceProfile,
    roleArn: session.roleArn,
    assumedRoleArn: session.assumedRoleArn,
    accountId: session.accountId,
    accessKeyId: session.credentials.accessKeyId,
    expiration: session.credentials.expiration,
    externalId: session.externalId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}

function isExpired(expiration: string): boolean {
  const expiresAt = new Date(expiration).getTime()
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now()
}

function createBaseCredentials(profile: string) {
  return createProfileCredentialsProvider(profile)
}

export function createBaseConnection(profile: string, region: string): AwsConnection {
  return {
    providerId: 'aws',
    kind: 'profile',
    sessionId: `profile:${profile}`,
    label: profile,
    profileId: profile,
    locationId: normalizeRegion(region),
    profile,
    region: normalizeRegion(region)
  }
}

export function listSessionHubState(): SessionHubState {
  return {
    targets: sortTargets(readPersistedState().targets),
    sessions: sortSessions([...sessionStore.values()].map(toSessionSummary))
  }
}

export function listAssumeRoleTargets(): AwsAssumeRoleTarget[] {
  return listSessionHubState().targets
}

export function saveAssumeRoleTarget(
  input: Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): AwsAssumeRoleTarget {
  const label = input.label.trim()
  const roleArn = input.roleArn.trim()
  const defaultSessionName = input.defaultSessionName.trim()
  const sourceProfile = input.sourceProfile.trim()
  const defaultRegion = normalizeRegion(input.defaultRegion)

  if (!label || !roleArn || !defaultSessionName) {
    throw new Error('Label, role ARN, and default session name are required.')
  }

  const now = new Date().toISOString()
  const state = readPersistedState()
  const id = input.id?.trim() || randomUUID()
  const existing = state.targets.find((target) => target.id === id)
  const nextTarget: AwsAssumeRoleTarget = {
    id,
    label,
    roleArn,
    defaultSessionName,
    externalId: input.externalId.trim(),
    sourceProfile,
    defaultRegion,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }

  const nextTargets = state.targets.filter((target) => target.id !== id)
  nextTargets.push(nextTarget)
  writePersistedState({ targets: sortTargets(nextTargets) })
  return nextTarget
}

export function deleteAssumeRoleTarget(targetId: string): void {
  const state = readPersistedState()
  writePersistedState({ targets: state.targets.filter((target) => target.id !== targetId) })
}

export function getAssumeRoleTarget(targetId: string): AwsAssumeRoleTarget | null {
  return readPersistedState().targets.find((target) => target.id === targetId) ?? null
}

export function deleteSession(sessionId: string): void {
  sessionStore.delete(sessionId)
}

export function getSessionSummary(sessionId: string): AwsSessionSummary | null {
  const session = sessionStore.get(sessionId)
  return session ? toSessionSummary(session) : null
}

export function getSessionCredentials(sessionId: string): AwsCredentialSnapshot {
  const session = sessionStore.get(sessionId)
  if (!session) {
    throw new Error('Assumed session was not found. Re-assume the role to continue.')
  }
  if (isExpired(session.credentials.expiration)) {
    throw new Error('Assumed session has expired. Re-assume the role to continue.')
  }
  return session.credentials
}

export function getConnectionEnv(connection: AwsConnection): Record<string, string> {
  const base = {
    AWS_DEFAULT_REGION: connection.region,
    AWS_REGION: connection.region
  }

  if (connection.kind === 'profile') {
    return {
      ...base,
      AWS_PROFILE: connection.profile,
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: ''
    }
  }

  const credentials = getSessionCredentials(connection.sessionId)

  return {
    ...base,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken
  }
}

export function getConnectionStorageKey(connection: AwsConnection): string {
  return connection.kind === 'profile'
    ? `profile:${connection.profile}`
    : `assumed-role:${connection.sessionId}`
}

export function createConnectionFromSession(sessionId: string, region?: string): AwsConnection {
  const session = sessionStore.get(sessionId)
  if (!session) {
    throw new Error('Assumed session was not found. Re-assume the role to continue.')
  }

  return {
    providerId: 'aws',
    kind: 'assumed-role',
    sessionId: session.id,
    label: session.label,
    profileId: session.sourceProfile,
    locationId: normalizeRegion(region ?? session.region),
    profile: session.sourceProfile,
    sourceProfile: session.sourceProfile,
    region: normalizeRegion(region ?? session.region),
    roleArn: session.roleArn,
    assumedRoleArn: session.assumedRoleArn,
    accountId: session.accountId,
    accessKeyId: session.credentials.accessKeyId,
    expiration: session.credentials.expiration,
    externalId: session.externalId
  }
}

export async function assumeRoleSession(request: AssumeRoleRequest): Promise<AssumeRoleResult> {
  const roleArn = request.roleArn.trim()
  const sessionName = request.sessionName.trim()
  const sourceProfile = request.sourceProfile?.trim() ?? ''
  const region = normalizeRegion(request.region || 'us-east-1')

  if (!roleArn || !sessionName || !sourceProfile) {
    throw new Error('Role ARN, source profile, and session name are required.')
  }

  const client = new STSClient({
    region,
    credentials: createBaseCredentials(sourceProfile)
  })

  const assumeOutput = await client.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      ExternalId: request.externalId?.trim() || undefined
    })
  )

  const accessKeyId = assumeOutput.Credentials?.AccessKeyId ?? ''
  const secretAccessKey = assumeOutput.Credentials?.SecretAccessKey ?? ''
  const sessionToken = assumeOutput.Credentials?.SessionToken ?? ''
  const expiration = assumeOutput.Credentials?.Expiration?.toISOString() ?? ''

  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
    throw new Error('STS AssumeRole did not return a complete temporary credential set.')
  }

  const tempClient = new STSClient({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken
    }
  })
  const identity = await tempClient.send(new GetCallerIdentityCommand({}))

  const now = new Date().toISOString()
  const sessionId = randomUUID()
  const assumedSession: InMemorySession = {
    id: sessionId,
    label: request.label.trim() || roleArn,
    roleArn,
    sourceProfile,
    region,
    externalId: request.externalId?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
    assumedRoleArn: assumeOutput.AssumedRoleUser?.Arn ?? '',
    assumedRoleId: assumeOutput.AssumedRoleUser?.AssumedRoleId ?? '',
    accountId: identity.Account ?? '',
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiration
    }
  }

  sessionStore.set(sessionId, assumedSession)

  return {
    sessionId,
    label: assumedSession.label,
    sourceProfile,
    roleArn,
    assumedRoleArn: assumedSession.assumedRoleArn,
    assumedRoleId: assumedSession.assumedRoleId,
    accountId: assumedSession.accountId,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiration,
    packedPolicySize: assumeOutput.PackedPolicySize ?? 0,
    region,
    externalId: assumedSession.externalId
  }
}
