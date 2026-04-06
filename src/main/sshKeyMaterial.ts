import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'

import type { Ec2ChosenSshKey, VaultSshKeyInspection, VaultSshKeyInspectionSource } from '@shared/types'
import { listVaultEntries, revealVaultEntrySecret, saveVaultEntry } from './localVault'

const execFileAsync = promisify(execFile)

export async function lockDownPrivateKey(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    const username = process.env.USERNAME
    if (!username) {
      throw new Error('Unable to determine the current Windows user for SSH key permissions.')
    }

    await execFileAsync('icacls', [filePath, '/inheritance:r'])
    await execFileAsync('icacls', [filePath, '/grant:r', `${username}:R`])
    return
  }

  await fs.chmod(filePath, 0o600)
}

export async function stageSshPrivateKey(sourcePath: string): Promise<string> {
  const extension = path.extname(sourcePath) || '.pem'
  const targetDir = path.join(app.getPath('temp'), 'aws-lens', 'ssh-keys')
  const targetPath = path.join(targetDir, `${randomUUID()}${extension}`)

  await fs.mkdir(targetDir, { recursive: true })
  await fs.copyFile(sourcePath, targetPath)
  await fs.copyFile(`${sourcePath}.pub`, `${targetPath}.pub`).catch(() => undefined)
  await lockDownPrivateKey(targetPath)

  return targetPath
}

export async function deriveSshPublicKey(privateKeyPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', privateKeyPath], { windowsHide: true })
    return stdout.trim()
  } catch {
    return ''
  }
}

function deriveKeyNameHints(name: string, metadata: Record<string, string>): string[] {
  const candidates = [
    name,
    metadata.fileName,
    metadata.sourcePath ? path.basename(metadata.sourcePath) : '',
    metadata.publicKeyPath ? path.basename(metadata.publicKeyPath) : ''
  ]

  return candidates
    .map((candidate) => candidate?.trim() ?? '')
    .filter(Boolean)
    .map((candidate) => candidate.replace(/\.(pem|ppk|key|pub)$/i, ''))
    .filter((candidate, index, items) => items.indexOf(candidate) === index)
}

async function readEntryPublicKey(entryId: string): Promise<{ publicKey: string; source: VaultSshKeyInspectionSource }> {
  const entry = listVaultEntries().find((candidate) => candidate.id === entryId)
  if (!entry) {
    throw new Error('Selected vault key could not be found.')
  }
  if (entry.kind !== 'pem' && entry.kind !== 'ssh-key') {
    throw new Error('Selected vault entry is not an SSH private key.')
  }

  const inlinePublicKey = entry.metadata.publicKey?.trim() ?? ''
  if (inlinePublicKey) {
    return { publicKey: inlinePublicKey, source: 'metadata-inline' }
  }

  const publicKeyCandidates: Array<{ path: string; source: VaultSshKeyInspectionSource }> = [
    { path: entry.metadata.publicKeyPath?.trim() ?? '', source: 'metadata-path' },
    { path: entry.metadata.sourcePath ? `${entry.metadata.sourcePath}`.trim() + '.pub' : '', source: 'source-path' },
    { path: entry.metadata.stagedPath ? `${entry.metadata.stagedPath}`.trim() + '.pub' : '', source: 'legacy-staged-path' }
  ]

  for (const candidate of publicKeyCandidates) {
    if (!candidate.path) {
      continue
    }

    const publicKey = await fs.readFile(candidate.path, 'utf8').then((value) => value.trim()).catch(() => '')
    if (publicKey) {
      return { publicKey, source: candidate.source }
    }
  }

  const secret = revealVaultEntrySecret(entry.id)
  const extension = path.extname(entry.metadata.fileName || entry.name) || (entry.kind === 'pem' ? '.pem' : '.key')
  const targetDir = path.join(app.getPath('temp'), 'aws-lens', 'ssh-keys')
  const targetPath = path.join(targetDir, `${randomUUID()}${extension}`)

  await fs.mkdir(targetDir, { recursive: true })
  await fs.writeFile(targetPath, secret, 'utf8')

  try {
    const derived = await deriveSshPublicKey(targetPath)
    if (derived) {
      return { publicKey: derived, source: 'derived-from-private-key' }
    }
  } finally {
    await fs.rm(targetPath, { force: true }).catch(() => undefined)
  }

  return { publicKey: '', source: 'unavailable' }
}

async function readFingerprintToken(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', args, { windowsHide: true })
    const token = stdout.trim().split(/\s+/)[1] ?? ''
    return token.trim()
  } catch {
    return ''
  }
}

async function inspectPublicKey(publicKey: string): Promise<{ fingerprintSha256: string; fingerprintMd5: string }> {
  if (!publicKey) {
    return {
      fingerprintSha256: '',
      fingerprintMd5: ''
    }
  }

  const targetDir = path.join(app.getPath('temp'), 'aws-lens', 'ssh-keys')
  const targetPath = path.join(targetDir, `${randomUUID()}.pub`)

  await fs.mkdir(targetDir, { recursive: true })
  await fs.writeFile(targetPath, `${publicKey}\n`, 'utf8')

  try {
    const fingerprintSha256 = await readFingerprintToken(['-lf', targetPath])
    const fingerprintMd5Token = await readFingerprintToken(['-E', 'md5', '-lf', targetPath])

    return {
      fingerprintSha256,
      fingerprintMd5: fingerprintMd5Token.replace(/^MD5:/i, '').toLowerCase()
    }
  } finally {
    await fs.rm(targetPath, { force: true }).catch(() => undefined)
  }
}

export async function inspectVaultSshKey(entryId: string): Promise<VaultSshKeyInspection> {
  const entry = listVaultEntries().find((candidate) => candidate.id === entryId)
  if (!entry) {
    throw new Error('Selected vault key could not be found.')
  }
  if (entry.kind !== 'pem' && entry.kind !== 'ssh-key') {
    throw new Error('Selected vault entry is not an SSH private key.')
  }

  const { publicKey, source } = await readEntryPublicKey(entryId)
  const fingerprints = await inspectPublicKey(publicKey)
  const fingerprintSha256 = fingerprints.fingerprintSha256 || entry.metadata.sshFingerprintSha256 || ''
  const fingerprintMd5 = fingerprints.fingerprintMd5 || entry.metadata.sshFingerprintMd5 || ''

  return {
    entryId: entry.id,
    entryName: entry.name,
    kind: entry.kind,
    keyNameHints: deriveKeyNameHints(entry.name, entry.metadata),
    fingerprintSha256,
    fingerprintMd5,
    publicKeySource: source,
    publicKeyAvailable: Boolean(publicKey || fingerprintSha256 || fingerprintMd5)
  }
}

export async function stageVaultSshPrivateKey(entryId: string): Promise<string> {
  const entry = listVaultEntries().find((candidate) => candidate.id === entryId)
  if (!entry) {
    throw new Error('Selected vault key could not be found.')
  }
  if (entry.kind !== 'pem' && entry.kind !== 'ssh-key') {
    throw new Error('Selected vault entry is not an SSH private key.')
  }

  const secret = revealVaultEntrySecret(entry.id)
  const extension = path.extname(entry.metadata.fileName || entry.name) || (entry.kind === 'pem' ? '.pem' : '.key')
  const targetDir = path.join(app.getPath('temp'), 'aws-lens', 'ssh-keys')
  const targetPath = path.join(targetDir, `${randomUUID()}${extension}`)

  await fs.mkdir(targetDir, { recursive: true })
  await fs.writeFile(targetPath, secret, 'utf8')

  const { publicKey } = await readEntryPublicKey(entry.id)
  if (publicKey) {
    await fs.writeFile(`${targetPath}.pub`, `${publicKey}\n`, 'utf8')
  }

  await lockDownPrivateKey(targetPath)
  return targetPath
}

export function inferSshVaultKind(filePath: string): 'pem' | 'ssh-key' {
  return path.extname(filePath).toLowerCase() === '.pem' ? 'pem' : 'ssh-key'
}

export async function importSshPrivateKeyToVault(sourcePath: string): Promise<Ec2ChosenSshKey> {
  const stagedPath = await stageSshPrivateKey(sourcePath)
  const content = await fs.readFile(sourcePath, 'utf8')
  const baseName = path.basename(sourcePath)
  const publicKey = await fs.readFile(`${sourcePath}.pub`, 'utf8').then((value) => value.trim()).catch(() => '')
  const fingerprints = await inspectPublicKey(publicKey)
  const saved = saveVaultEntry({
    kind: inferSshVaultKind(sourcePath),
    name: baseName,
    secret: content,
    metadata: {
      sourcePath,
      fileName: baseName,
      publicKey,
      publicKeyPath: `${sourcePath}.pub`,
      sshFingerprintSha256: fingerprints.fingerprintSha256,
      sshFingerprintMd5: fingerprints.fingerprintMd5
    },
    origin: 'imported',
    rotationState: 'not-applicable'
  })

  return {
    stagedPath,
    originalPath: sourcePath,
    vaultEntryId: saved.id,
    vaultEntryName: saved.name
  }
}
