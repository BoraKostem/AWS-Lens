import { promises as fs } from 'node:fs'

import { stageVaultSshPrivateKey } from '../sshKeyMaterial'

export type GceSshCommandSpec = {
  command: string
  args: string[]
  /** Temporary key file path used by the spawned ssh process. Caller must dispose. */
  privateKeyPath: string | null
  cleanup: () => Promise<void>
}

export type GceSshCommandRequest = {
  instanceName: string
  zone: string
  projectId?: string
  vaultEntryId?: string
  user?: string
  internalIp?: boolean
}

/**
 * Build a `gcloud compute ssh` invocation backed by an optional vault SSH key.
 * When a vault entry is supplied, the key is materialized to a temp file with
 * tight permissions and the returned `cleanup` removes it after the session
 * ends. Without a vault entry, gcloud's default key discovery is used.
 */
export async function buildGceSshCommand(request: GceSshCommandRequest): Promise<GceSshCommandSpec> {
  const args: string[] = ['compute', 'ssh', request.instanceName, '--zone', request.zone]
  if (request.projectId) {
    args.push('--project', request.projectId)
  }
  if (request.internalIp) {
    args.push('--internal-ip')
  }

  let privateKeyPath: string | null = null
  if (request.vaultEntryId) {
    privateKeyPath = await stageVaultSshPrivateKey(request.vaultEntryId, { source: 'gcp:vm:ssh' })
    args.push('--ssh-key-file', privateKeyPath)
  }

  if (request.user) {
    // gcloud expects user@instance for non-default user; supply via --command? No, embed in target.
    args[2] = `${request.user}@${request.instanceName}`
  }

  return {
    command: 'gcloud',
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
