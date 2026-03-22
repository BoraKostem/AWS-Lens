import {
  AssumeRoleCommand,
  DecodeAuthorizationMessageCommand,
  GetAccessKeyInfoCommand,
  GetCallerIdentityCommand,
  STSClient
} from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-provider-ini'

import type { AccessKeyOwnership, AssumeRoleResult, AwsConnection, CallerIdentity, StsDecodedAuthorizationMessage } from '@shared/types'

function createClient(connection: AwsConnection): STSClient {
  return new STSClient({
    region: connection.region,
    credentials: fromIni({ profile: connection.profile })
  })
}

export async function getCallerIdentity(connection: AwsConnection): Promise<CallerIdentity> {
  const client = createClient(connection)
  const output = await client.send(new GetCallerIdentityCommand({}))

  return {
    account: output.Account ?? '',
    arn: output.Arn ?? '',
    userId: output.UserId ?? ''
  }
}

export async function decodeAuthorizationMessage(
  connection: AwsConnection,
  encodedMessage: string
): Promise<StsDecodedAuthorizationMessage> {
  const client = createClient(connection)
  const output = await client.send(new DecodeAuthorizationMessageCommand({ EncodedMessage: encodedMessage }))

  return {
    decodedMessage: output.DecodedMessage ?? ''
  }
}

export async function lookupAccessKeyOwnership(connection: AwsConnection, accessKeyId: string): Promise<AccessKeyOwnership> {
  const client = createClient(connection)
  const output = await client.send(new GetAccessKeyInfoCommand({ AccessKeyId: accessKeyId }))

  return {
    account: output.Account ?? '',
    arn: '',
    userId: ''
  }
}

export async function assumeRole(
  connection: AwsConnection,
  roleArn: string,
  sessionName: string,
  externalId?: string
): Promise<AssumeRoleResult> {
  const client = createClient(connection)
  const output = await client.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      ExternalId: externalId || undefined
    })
  )

  return {
    assumedRoleArn: output.AssumedRoleUser?.Arn ?? '',
    assumedRoleId: output.AssumedRoleUser?.AssumedRoleId ?? '',
    accessKeyId: output.Credentials?.AccessKeyId ?? '',
    secretAccessKey: output.Credentials?.SecretAccessKey ?? '',
    sessionToken: output.Credentials?.SessionToken ?? '',
    expiration: output.Credentials?.Expiration?.toISOString() ?? '',
    packedPolicySize: output.PackedPolicySize ?? 0
  }
}
