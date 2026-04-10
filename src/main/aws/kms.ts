import { DecryptCommand, DescribeKeyCommand, KMSClient, ListAliasesCommand, ListKeysCommand } from '@aws-sdk/client-kms'

import type { AwsConnection, KmsDecryptResult, KmsKeyDetail, KmsKeySummary } from '@shared/types'
import { getAwsClient } from './client'

function toIso(value: Date | undefined): string {
  return value ? value.toISOString() : ''
}

async function listAliasesByKey(connection: AwsConnection): Promise<Map<string, string[]>> {
  const client = getAwsClient(KMSClient, connection)
  const aliasMap = new Map<string, string[]>()
  let marker: string | undefined

  do {
    const response = await client.send(new ListAliasesCommand({ Marker: marker }))
    for (const alias of response.Aliases ?? []) {
      if (!alias.TargetKeyId || !alias.AliasName) continue
      const current = aliasMap.get(alias.TargetKeyId) ?? []
      current.push(alias.AliasName)
      aliasMap.set(alias.TargetKeyId, current)
    }
    marker = response.NextMarker
  } while (marker)

  return aliasMap
}

export async function listKmsKeys(connection: AwsConnection): Promise<KmsKeySummary[]> {
  const client = getAwsClient(KMSClient, connection)
  const aliases = await listAliasesByKey(connection)
  const keys: KmsKeySummary[] = []
  let marker: string | undefined

  do {
    const response = await client.send(new ListKeysCommand({ Marker: marker }))
    for (const item of response.Keys ?? []) {
      if (!item.KeyId) continue
      const detail = await client.send(new DescribeKeyCommand({ KeyId: item.KeyId }))
      const metadata = detail.KeyMetadata
      if (!metadata) continue
      keys.push({
        keyId: metadata.KeyId ?? '',
        keyArn: metadata.Arn ?? '',
        aliasNames: aliases.get(metadata.KeyId ?? '') ?? [],
        description: metadata.Description ?? '',
        enabled: Boolean(metadata.Enabled),
        keyState: metadata.KeyState ?? '',
        keyUsage: metadata.KeyUsage ?? '',
        keySpec: metadata.KeySpec ?? '',
        creationDate: toIso(metadata.CreationDate)
      })
    }
    marker = response.NextMarker
  } while (marker)

  return keys
}

export async function describeKmsKey(connection: AwsConnection, keyId: string): Promise<KmsKeyDetail> {
  const client = getAwsClient(KMSClient, connection)
  const [detail, aliases] = await Promise.all([
    client.send(new DescribeKeyCommand({ KeyId: keyId })),
    listAliasesByKey(connection)
  ])
  const metadata = detail.KeyMetadata

  if (!metadata) {
    throw new Error('KMS key not found.')
  }

  return {
    keyId: metadata.KeyId ?? keyId,
    keyArn: metadata.Arn ?? '',
    description: metadata.Description ?? '',
    enabled: Boolean(metadata.Enabled),
    keyState: metadata.KeyState ?? '',
    keyManager: metadata.KeyManager ?? '',
    origin: metadata.Origin ?? '',
    keyUsage: metadata.KeyUsage ?? '',
    keySpec: metadata.KeySpec ?? '',
    encryptionAlgorithms: metadata.EncryptionAlgorithms ?? [],
    signingAlgorithms: metadata.SigningAlgorithms ?? [],
    multiRegion: Boolean(metadata.MultiRegion),
    deletionDate: toIso(metadata.DeletionDate),
    creationDate: toIso(metadata.CreationDate),
    aliasNames: aliases.get(metadata.KeyId ?? '') ?? []
  }
}

export async function decryptCiphertext(connection: AwsConnection, ciphertext: string): Promise<KmsDecryptResult> {
  const client = getAwsClient(KMSClient, connection)
  const blob = Uint8Array.from(Buffer.from(ciphertext.trim(), 'base64'))
  const response = await client.send(new DecryptCommand({ CiphertextBlob: blob }))
  const plaintextBuffer = Buffer.from(response.Plaintext ?? new Uint8Array())

  return {
    plaintext: plaintextBuffer.toString('utf8'),
    plaintextBase64: plaintextBuffer.toString('base64'),
    keyId: response.KeyId ?? '',
    encryptionAlgorithm: response.EncryptionAlgorithm ?? ''
  }
}
