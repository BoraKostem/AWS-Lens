import type { SecretManagerReferencePayload } from '@shared/types'

export class SecretReferenceNotImplementedError extends Error {
  readonly provider: SecretManagerReferencePayload['provider']

  constructor(provider: SecretManagerReferencePayload['provider'], message?: string) {
    super(
      message ??
        `Remote ${provider} resolution is not yet implemented. Provide a local fallback or wait for the next release.`
    )
    this.name = 'SecretReferenceNotImplementedError'
    this.provider = provider
  }
}

export type ResolvedSecret = {
  secret: string
  resolvedAt: string
  provider: SecretManagerReferencePayload['provider']
  uri: string
}

export function resolveSecretManagerReferenceSync(payload: SecretManagerReferencePayload): ResolvedSecret {
  if (typeof payload.localFallback === 'string' && payload.localFallback.trim().length > 0) {
    return {
      secret: payload.localFallback,
      resolvedAt: new Date().toISOString(),
      provider: payload.provider,
      uri: payload.uri
    }
  }

  throw new SecretReferenceNotImplementedError(payload.provider)
}

export async function resolveSecretManagerReference(
  payload: SecretManagerReferencePayload
): Promise<ResolvedSecret> {
  return resolveSecretManagerReferenceSync(payload)
}
