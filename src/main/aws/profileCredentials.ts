import { fromIni } from '@aws-sdk/credential-provider-ini'

import { getAwsProfileVaultSecret, recordVaultEntryUseByKindAndName } from '../localVault'

export function createProfileCredentialsProvider(profile: string) {
  return async () => {
    const vaultSecret = getAwsProfileVaultSecret(profile)
    if (vaultSecret) {
      recordVaultEntryUseByKindAndName('aws-profile', profile, {
        source: 'aws-profile-provider',
        profile,
        resourceId: profile,
        resourceLabel: profile
      })

      return {
        accessKeyId: vaultSecret.accessKeyId,
        secretAccessKey: vaultSecret.secretAccessKey
      }
    }

    return fromIni({ profile })()
  }
}
