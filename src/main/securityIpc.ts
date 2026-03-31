import { ipcMain } from 'electron'

import type {
  AcmRequestCertificateInput,
  AwsConnection,
  SecretCreateInput,
  SecretTag,
  WafCreateWebAclInput,
  WafRuleInput,
  WafScope
} from '@shared/types'
import { deleteAcmCertificate, describeAcmCertificate, listAcmCertificates, requestAcmCertificate } from './aws/acm'
import { createKeyPair, deleteKeyPair, listKeyPairs } from './aws/keyPairs'
import { decryptCiphertext, describeKmsKey, listKmsKeys } from './aws/kms'
import {
  createSecret,
  deleteSecret,
  describeSecret,
  getSecretDependencyReport,
  getSecretValue,
  listSecrets,
  putSecretResourcePolicy,
  restoreSecret,
  rotateSecret,
  tagSecret,
  untagSecret,
  updateSecretDescription,
  updateSecretValue
} from './aws/secretsManager'
import { assumeRole, decodeAuthorizationMessage, lookupAccessKeyOwnership } from './aws/sts'
import {
  addWafRule,
  associateWebAcl,
  createWebAcl,
  deleteWafRule,
  deleteWebAcl,
  describeWebAcl,
  disassociateWebAcl,
  listWebAcls,
  updateWafRuleJson
} from './aws/waf'
import { createHandlerWrapper } from './operations'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('security-ipc', { timeoutMs: 60000 })

export function registerSecurityIpcHandlers(): void {
  ipcMain.handle('acm:list-certificates', async (_event, connection: AwsConnection) => wrap(() => listAcmCertificates(connection)))
  ipcMain.handle('acm:describe-certificate', async (_event, connection: AwsConnection, certificateArn: string) =>
    wrap(() => describeAcmCertificate(connection, certificateArn))
  )
  ipcMain.handle('acm:request-certificate', async (_event, connection: AwsConnection, input: AcmRequestCertificateInput) =>
    wrap(() => requestAcmCertificate(connection, input))
  )
  ipcMain.handle('acm:delete-certificate', async (_event, connection: AwsConnection, certificateArn: string) =>
    wrap(() => deleteAcmCertificate(connection, certificateArn))
  )

  ipcMain.handle('secrets:list', async (_event, connection: AwsConnection) => wrap(() => listSecrets(connection)))
  ipcMain.handle('secrets:describe', async (_event, connection: AwsConnection, secretId: string) =>
    wrap(() => describeSecret(connection, secretId))
  )
  ipcMain.handle('secrets:dependency-report', async (_event, connection: AwsConnection, secretId: string) =>
    wrap(() => getSecretDependencyReport(connection, secretId))
  )
  ipcMain.handle('secrets:get-value', async (_event, connection: AwsConnection, secretId: string, versionId?: string) =>
    wrap(() => getSecretValue(connection, secretId, versionId))
  )
  ipcMain.handle('secrets:create', async (_event, connection: AwsConnection, input: SecretCreateInput) =>
    wrap(() => createSecret(connection, input))
  )
  ipcMain.handle('secrets:delete', async (_event, connection: AwsConnection, secretId: string, forceDeleteWithoutRecovery: boolean) =>
    wrap(() => deleteSecret(connection, secretId, forceDeleteWithoutRecovery))
  )
  ipcMain.handle('secrets:restore', async (_event, connection: AwsConnection, secretId: string) =>
    wrap(() => restoreSecret(connection, secretId))
  )
  ipcMain.handle('secrets:update-value', async (_event, connection: AwsConnection, secretId: string, secretString: string) =>
    wrap(() => updateSecretValue(connection, secretId, secretString))
  )
  ipcMain.handle('secrets:update-description', async (_event, connection: AwsConnection, secretId: string, description: string) =>
    wrap(() => updateSecretDescription(connection, secretId, description))
  )
  ipcMain.handle('secrets:rotate', async (_event, connection: AwsConnection, secretId: string) =>
    wrap(() => rotateSecret(connection, secretId))
  )
  ipcMain.handle('secrets:put-policy', async (_event, connection: AwsConnection, secretId: string, policy: string) =>
    wrap(() => putSecretResourcePolicy(connection, secretId, policy))
  )
  ipcMain.handle('secrets:tag', async (_event, connection: AwsConnection, secretId: string, tags: SecretTag[]) =>
    wrap(() => tagSecret(connection, secretId, tags))
  )
  ipcMain.handle('secrets:untag', async (_event, connection: AwsConnection, secretId: string, tagKeys: string[]) =>
    wrap(() => untagSecret(connection, secretId, tagKeys))
  )

  ipcMain.handle('key-pairs:list', async (_event, connection: AwsConnection) => wrap(() => listKeyPairs(connection)))
  ipcMain.handle('key-pairs:create', async (_event, connection: AwsConnection, keyName: string) =>
    wrap(() => createKeyPair(connection, keyName))
  )
  ipcMain.handle('key-pairs:delete', async (_event, connection: AwsConnection, keyName: string) =>
    wrap(() => deleteKeyPair(connection, keyName))
  )

  ipcMain.handle('sts:decode-auth-message', async (_event, connection: AwsConnection, encodedMessage: string) =>
    wrap(() => decodeAuthorizationMessage(connection, encodedMessage))
  )
  ipcMain.handle('sts:lookup-access-key', async (_event, connection: AwsConnection, accessKeyId: string) =>
    wrap(() => lookupAccessKeyOwnership(connection, accessKeyId))
  )
  ipcMain.handle('sts:assume-role', async (_event, connection: AwsConnection, roleArn: string, sessionName: string, externalId?: string) =>
    wrap(() => assumeRole(connection, roleArn, sessionName, externalId))
  )

  ipcMain.handle('kms:list-keys', async (_event, connection: AwsConnection) => wrap(() => listKmsKeys(connection)))
  ipcMain.handle('kms:describe-key', async (_event, connection: AwsConnection, keyId: string) =>
    wrap(() => describeKmsKey(connection, keyId))
  )
  ipcMain.handle('kms:decrypt', async (_event, connection: AwsConnection, ciphertext: string) =>
    wrap(() => decryptCiphertext(connection, ciphertext))
  )

  ipcMain.handle('waf:list-web-acls', async (_event, connection: AwsConnection, scope: WafScope) =>
    wrap(() => listWebAcls(connection, scope))
  )
  ipcMain.handle('waf:describe-web-acl', async (_event, connection: AwsConnection, scope: WafScope, id: string, name: string) =>
    wrap(() => describeWebAcl(connection, scope, id, name))
  )
  ipcMain.handle('waf:create-web-acl', async (_event, connection: AwsConnection, input: WafCreateWebAclInput) =>
    wrap(() => createWebAcl(connection, input))
  )
  ipcMain.handle('waf:delete-web-acl', async (_event, connection: AwsConnection, scope: WafScope, id: string, name: string, lockToken: string) =>
    wrap(() => deleteWebAcl(connection, scope, id, name, lockToken))
  )
  ipcMain.handle('waf:add-rule', async (_event, connection: AwsConnection, scope: WafScope, id: string, name: string, lockToken: string, input: WafRuleInput) =>
    wrap(() => addWafRule(connection, scope, id, name, lockToken, input))
  )
  ipcMain.handle(
    'waf:update-rules-json',
    async (
      _event,
      connection: AwsConnection,
      scope: WafScope,
      id: string,
      name: string,
      lockToken: string,
      defaultAction: 'Allow' | 'Block',
      description: string,
      rulesJson: string
    ) => wrap(() => updateWafRuleJson(connection, scope, id, name, lockToken, defaultAction, description, rulesJson))
  )
  ipcMain.handle('waf:delete-rule', async (_event, connection: AwsConnection, scope: WafScope, id: string, name: string, lockToken: string, ruleName: string) =>
    wrap(() => deleteWafRule(connection, scope, id, name, lockToken, ruleName))
  )
  ipcMain.handle('waf:associate-resource', async (_event, connection: AwsConnection, resourceArn: string, webAclArn: string) =>
    wrap(() => associateWebAcl(connection, resourceArn, webAclArn))
  )
  ipcMain.handle('waf:disassociate-resource', async (_event, connection: AwsConnection, resourceArn: string) =>
    wrap(() => disassociateWebAcl(connection, resourceArn))
  )
}
