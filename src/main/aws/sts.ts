import {
  DecodeAuthorizationMessageCommand,
  GetAccessKeyInfoCommand,
  GetCallerIdentityCommand,
  STSClient
} from '@aws-sdk/client-sts'

import type { AccessKeyOwnership, AssumeRoleResult, AwsConnection, CallerIdentity, StsDecodedAuthorizationMessage } from '@shared/types'
import { awsClientConfig } from './client'
import { assumeRoleSession } from '../sessionHub'

function createClient(connection: AwsConnection): STSClient {
  return new STSClient(awsClientConfig(connection))
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
  return assumeRoleSession({
    label: roleArn,
    roleArn,
    sessionName,
    externalId,
    sourceProfile: connection.kind === 'assumed-role' ? connection.sourceProfile : connection.profile,
    region: connection.region
  })
}
