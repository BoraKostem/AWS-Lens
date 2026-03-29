import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

import type { AwsConnection, TerraformSecretReference } from '@shared/types'
import { awsClientConfig } from './client'
import { getSecretValue } from './secretsManager'

function createSsmClient(connection: AwsConnection): SSMClient {
  return new SSMClient(awsClientConfig(connection))
}

function parseJsonKey(rawValue: string, jsonKey: string): unknown {
  if (!jsonKey) {
    return rawValue
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    throw new Error(`Secret value is not valid JSON, so jsonKey "${jsonKey}" cannot be read.`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Secret jsonKey "${jsonKey}" requires a JSON object value.`)
  }

  const value = (parsed as Record<string, unknown>)[jsonKey]
  if (value === undefined) {
    throw new Error(`Secret jsonKey "${jsonKey}" was not found.`)
  }

  return value
}

export async function resolveTerraformSecretReference(
  connection: AwsConnection,
  reference: TerraformSecretReference
): Promise<unknown> {
  if (!reference.target.trim()) {
    throw new Error('Secret reference target is required.')
  }

  if (reference.source === 'ssm-parameter') {
    const client = createSsmClient(connection)
    const response = await client.send(new GetParameterCommand({
      Name: reference.target,
      WithDecryption: true
    }))
    const value = response.Parameter?.Value ?? ''
    return parseJsonKey(value, reference.jsonKey)
  }

  const secret = await getSecretValue(connection, reference.target, reference.versionId || undefined)
  return parseJsonKey(secret.secretString ?? '', reference.jsonKey)
}
