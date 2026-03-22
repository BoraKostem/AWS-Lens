import { fromIni } from '@aws-sdk/credential-provider-ini'

import type { AwsConnection } from '@shared/types'

export function awsClientConfig(connection: AwsConnection) {
  return {
    region: connection.region,
    credentials: fromIni({ profile: connection.profile })
  }
}

export function readTags(tags?: Array<{ Key?: string; Value?: string }>): Record<string, string> {
  const entries = (tags ?? [])
    .filter((tag) => tag.Key)
    .map((tag) => [tag.Key as string, tag.Value ?? ''])

  return Object.fromEntries(entries)
}
