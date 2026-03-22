import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetResourcePolicyCommand,
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  ListSecretsCommand,
  PutResourcePolicyCommand,
  RestoreSecretCommand,
  RotateSecretCommand,
  SecretsManagerClient,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateSecretCommand
} from '@aws-sdk/client-secrets-manager'

import type {
  AwsConnection,
  SecretCreateInput,
  SecretTag,
  SecretsManagerSecretDetail,
  SecretsManagerSecretSummary,
  SecretsManagerSecretValue
} from '@shared/types'
import { awsClientConfig, readTags } from './client'

function createClient(connection: AwsConnection): SecretsManagerClient {
  return new SecretsManagerClient(awsClientConfig(connection))
}

function toIso(value: Date | undefined): string {
  return value ? value.toISOString() : ''
}

function normalizeTags(tags: SecretTag[]) {
  return tags.filter((tag) => tag.key.trim()).map((tag) => ({ Key: tag.key.trim(), Value: tag.value }))
}

export async function listSecrets(connection: AwsConnection): Promise<SecretsManagerSecretSummary[]> {
  const client = createClient(connection)
  const items: SecretsManagerSecretSummary[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(new ListSecretsCommand({ NextToken: nextToken, IncludePlannedDeletion: true }))
    for (const secret of response.SecretList ?? []) {
      items.push({
        arn: secret.ARN ?? '',
        name: secret.Name ?? '',
        description: secret.Description ?? '',
        owningService: secret.OwningService ?? '',
        primaryRegion: secret.PrimaryRegion ?? '',
        rotationEnabled: Boolean(secret.RotationEnabled),
        deletedDate: toIso(secret.DeletedDate),
        lastChangedDate: toIso(secret.LastChangedDate),
        lastAccessedDate: toIso(secret.LastAccessedDate),
        versionCount: secret.SecretVersionsToStages ? Object.keys(secret.SecretVersionsToStages).length : 0,
        tags: readTags(secret.Tags)
      })
    }
    nextToken = response.NextToken
  } while (nextToken)

  return items
}

export async function describeSecret(connection: AwsConnection, secretId: string): Promise<SecretsManagerSecretDetail> {
  const client = createClient(connection)
  const [detail, versions, policy] = await Promise.all([
    client.send(new DescribeSecretCommand({ SecretId: secretId })),
    client.send(new ListSecretVersionIdsCommand({ SecretId: secretId, IncludeDeprecated: true })),
    client.send(new GetResourcePolicyCommand({ SecretId: secretId })).catch(() => ({ ResourcePolicy: '' }))
  ])

  return {
    arn: detail.ARN ?? '',
    name: detail.Name ?? '',
    description: detail.Description ?? '',
    kmsKeyId: detail.KmsKeyId ?? '',
    owningService: detail.OwningService ?? '',
    primaryRegion: detail.PrimaryRegion ?? '',
    rotationEnabled: Boolean(detail.RotationEnabled),
    rotationLambdaArn: detail.RotationLambdaARN ?? '',
    deletedDate: toIso(detail.DeletedDate),
    lastChangedDate: toIso(detail.LastChangedDate),
    lastAccessedDate: toIso(detail.LastAccessedDate),
    nextRotationDate: toIso(detail.NextRotationDate),
    tags: readTags(detail.Tags),
    versions: (versions.Versions ?? []).map((version) => ({
      versionId: version.VersionId ?? '',
      createdDate: toIso(version.CreatedDate),
      stages: version.VersionStages ?? [],
      isCurrent: (version.VersionStages ?? []).includes('AWSCURRENT')
    })),
    policy: (policy as { ResourcePolicy?: string }).ResourcePolicy ?? ''
  }
}

export async function getSecretValue(connection: AwsConnection, secretId: string, versionId?: string): Promise<SecretsManagerSecretValue> {
  const client = createClient(connection)
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId, VersionId: versionId || undefined }))

  return {
    secretString: response.SecretString ?? '',
    secretBinary: response.SecretBinary ? Buffer.from(response.SecretBinary as Uint8Array).toString('base64') : '',
    versionId: response.VersionId ?? '',
    versionStages: response.VersionStages ?? [],
    createdDate: ''
  }
}

export async function createSecret(connection: AwsConnection, input: SecretCreateInput): Promise<string> {
  const client = createClient(connection)
  const response = await client.send(
    new CreateSecretCommand({
      Name: input.name,
      Description: input.description || undefined,
      SecretString: input.secretString,
      KmsKeyId: input.kmsKeyId || undefined,
      Tags: normalizeTags(input.tags)
    })
  )

  return response.ARN ?? ''
}

export async function deleteSecret(connection: AwsConnection, secretId: string, forceDeleteWithoutRecovery: boolean): Promise<void> {
  const client = createClient(connection)
  await client.send(
    new DeleteSecretCommand({
      SecretId: secretId,
      ForceDeleteWithoutRecovery: forceDeleteWithoutRecovery || undefined,
      RecoveryWindowInDays: forceDeleteWithoutRecovery ? undefined : 7
    })
  )
}

export async function restoreSecret(connection: AwsConnection, secretId: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new RestoreSecretCommand({ SecretId: secretId }))
}

export async function updateSecretValue(connection: AwsConnection, secretId: string, secretString: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new UpdateSecretCommand({ SecretId: secretId, SecretString: secretString }))
}

export async function updateSecretDescription(connection: AwsConnection, secretId: string, description: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new UpdateSecretCommand({ SecretId: secretId, Description: description }))
}

export async function rotateSecret(connection: AwsConnection, secretId: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new RotateSecretCommand({ SecretId: secretId, RotateImmediately: true }))
}

export async function putSecretResourcePolicy(connection: AwsConnection, secretId: string, policy: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new PutResourcePolicyCommand({ SecretId: secretId, ResourcePolicy: policy }))
}

export async function tagSecret(connection: AwsConnection, secretId: string, tags: SecretTag[]): Promise<void> {
  const client = createClient(connection)
  await client.send(new TagResourceCommand({ SecretId: secretId, Tags: normalizeTags(tags) }))
}

export async function untagSecret(connection: AwsConnection, secretId: string, tagKeys: string[]): Promise<void> {
  const client = createClient(connection)
  await client.send(new UntagResourceCommand({ SecretId: secretId, TagKeys: tagKeys }))
}
