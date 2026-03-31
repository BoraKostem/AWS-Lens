import type { AwsConnection } from '@shared/types'
import { getSessionCredentials } from '../sessionHub'
import { createProfileCredentialsProvider } from './profileCredentials'

type AwsCredentialsProvider = () => Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}>

const credentialProviders = new Map<string, AwsCredentialsProvider>()
const pendingCredentialLoads = new Set<Promise<unknown>>()

function trackCredentialLoad<T>(promise: Promise<T>): Promise<T> {
  pendingCredentialLoads.add(promise)
  const cleanup = () => {
    pendingCredentialLoads.delete(promise)
  }
  promise.then(cleanup, cleanup)
  return promise
}

export function getProfileCredentialsProvider(profile: string): AwsCredentialsProvider {
  const cached = credentialProviders.get(profile)
  if (cached) {
    return cached
  }

  const baseProvider = createProfileCredentialsProvider(profile)
  const trackedProvider: AwsCredentialsProvider = async () =>
    trackCredentialLoad(baseProvider())

  credentialProviders.set(profile, trackedProvider)
  return trackedProvider
}

export function clearCredentialsProviderCache(profile?: string): void {
  if (profile) {
    credentialProviders.delete(profile)
    return
  }

  credentialProviders.clear()
}

export function awsClientConfig(connection: AwsConnection) {
  const credentials = connection.kind === 'assumed-role'
    ? (() => {
        const snapshot = getSessionCredentials(connection.sessionId)
        return {
          accessKeyId: snapshot.accessKeyId,
          secretAccessKey: snapshot.secretAccessKey,
          sessionToken: snapshot.sessionToken,
          expiration: new Date(snapshot.expiration)
        }
      })()
    : getProfileCredentialsProvider(connection.profile)

  return {
    region: connection.region,
    credentials
  }
}

export async function waitForAwsCredentialActivity(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (pendingCredentialLoads.size > 0) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return
    }

    await Promise.race([
      Promise.allSettled([...pendingCredentialLoads]),
      new Promise<void>((resolve) => setTimeout(resolve, remainingMs))
    ])
  }
}

export function hasPendingAwsCredentialActivity(): boolean {
  return pendingCredentialLoads.size > 0
}

export function readTags(tags?: Array<{ Key?: string; Value?: string }>): Record<string, string> {
  const entries = (tags ?? [])
    .filter((tag) => tag.Key)
    .map((tag) => [tag.Key as string, tag.Value ?? ''])

  return Object.fromEntries(entries)
}
