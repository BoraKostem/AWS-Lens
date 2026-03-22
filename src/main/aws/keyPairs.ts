import { CreateKeyPairCommand, DeleteKeyPairCommand, DescribeKeyPairsCommand, EC2Client } from '@aws-sdk/client-ec2'

import type { AwsConnection, CreatedKeyPair, KeyPairSummary } from '@shared/types'
import { awsClientConfig, readTags } from './client'

function createClient(connection: AwsConnection): EC2Client {
  return new EC2Client(awsClientConfig(connection))
}

function toIso(value: Date | undefined): string {
  return value ? value.toISOString() : ''
}

export async function listKeyPairs(connection: AwsConnection): Promise<KeyPairSummary[]> {
  const client = createClient(connection)
  const response = await client.send(new DescribeKeyPairsCommand({}))

  return (response.KeyPairs ?? []).map((pair) => ({
    keyName: pair.KeyName ?? '',
    keyPairId: pair.KeyPairId ?? '',
    keyType: pair.KeyType ?? '',
    fingerprint: pair.KeyFingerprint ?? '',
    createdAt: toIso(pair.CreateTime),
    tags: readTags(pair.Tags)
  }))
}

export async function createKeyPair(connection: AwsConnection, keyName: string): Promise<CreatedKeyPair> {
  const client = createClient(connection)
  const response = await client.send(new CreateKeyPairCommand({ KeyName: keyName, KeyType: 'rsa' }))

  return {
    keyName: response.KeyName ?? keyName,
    keyPairId: response.KeyPairId ?? '',
    keyFingerprint: response.KeyFingerprint ?? '',
    keyMaterial: response.KeyMaterial ?? ''
  }
}

export async function deleteKeyPair(connection: AwsConnection, keyName: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteKeyPairCommand({ KeyName: keyName }))
}
