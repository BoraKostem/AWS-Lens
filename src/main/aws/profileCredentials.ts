import { fromIni } from '@aws-sdk/credential-provider-ini'

import { getAwsProfileVaultSecret } from '../localVault'

export function createProfileCredentialsProvider(profile: string) {
  return async () => {
    const vaultSecret = getAwsProfileVaultSecret(profile)
    if (vaultSecret) {
      return {
        accessKeyId: vaultSecret.accessKeyId,
        secretAccessKey: vaultSecret.secretAccessKey
      }
    }

    return fromIni({ profile })()
  }
}
