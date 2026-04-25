import { promises as fs } from 'node:fs'

import { stageVaultSshPrivateKey } from '../sshKeyMaterial'

export type AzureVmSshCommandSpec = {
  command: string
  args: string[]
  privateKeyPath: string | null
  cleanup: () => Promise<void>
}

export type AzureVmSshCommandRequest = {
  vmName: string
  resourceGroup: string
  subscriptionId?: string
  vaultEntryId?: string
  user?: string
  /**
   * When true, prefer a direct `ssh` invocation with the vault key over
   * `az ssh vm` (which performs additional Azure AD-based provisioning).
   */
  useDirectSsh?: boolean
  /** Optional public IP / DNS to use with direct ssh. */
  host?: string
}

/**
 * Build a command spec to SSH into an Azure VM. When a vault SSH key is
 * supplied, the key is materialized to a temp file and either passed to
 * `az ssh vm --private-key-file` or wired into a direct `ssh -i …` call.
 * Without a vault entry, `az ssh vm` falls back to its default behavior.
 */
export async function buildAzureVmSshCommand(request: AzureVmSshCommandRequest): Promise<AzureVmSshCommandSpec> {
  let privateKeyPath: string | null = null
  if (request.vaultEntryId) {
    privateKeyPath = await stageVaultSshPrivateKey(request.vaultEntryId, { source: 'azure:vm:ssh' })
  }

  if (request.useDirectSsh && request.host) {
    const args: string[] = []
    if (privateKeyPath) {
      args.push('-i', privateKeyPath)
    }
    args.push('-o', 'StrictHostKeyChecking=accept-new')
    args.push(request.user ? `${request.user}@${request.host}` : request.host)
    return {
      command: 'ssh',
      args,
      privateKeyPath,
      cleanup: async () => {
        if (privateKeyPath) {
          await fs.rm(privateKeyPath, { force: true }).catch(() => undefined)
          await fs.rm(`${privateKeyPath}.pub`, { force: true }).catch(() => undefined)
        }
      }
    }
  }

  const args: string[] = ['ssh', 'vm', '--name', request.vmName, '--resource-group', request.resourceGroup]
  if (request.subscriptionId) {
    args.push('--subscription', request.subscriptionId)
  }
  if (privateKeyPath) {
    args.push('--private-key-file', privateKeyPath)
  }
  if (request.user) {
    args.push('--local-user', request.user)
  }

  return {
    command: 'az',
    args,
    privateKeyPath,
    cleanup: async () => {
      if (privateKeyPath) {
        await fs.rm(privateKeyPath, { force: true }).catch(() => undefined)
        await fs.rm(`${privateKeyPath}.pub`, { force: true }).catch(() => undefined)
      }
    }
  }
}
