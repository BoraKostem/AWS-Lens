import fs from 'node:fs'
import path from 'node:path'

import { safeStorage } from 'electron'

import { logWarn } from './observability'

const SECURE_FILE_PREFIX = 'infra-lens-secure:v1:'

type ReadOptions<T> = {
  fallback: T
  fileLabel: string
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function encryptJson(value: unknown, fileLabel: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`${fileLabel} could not be protected because OS-backed encryption is unavailable on this machine.`)
  }

  const serialized = JSON.stringify(value)
  const encrypted = safeStorage.encryptString(serialized)
  return `${SECURE_FILE_PREFIX}${encrypted.toString('base64')}`
}

function decryptJson<T>(raw: string, fileLabel: string): T {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`${fileLabel} could not be unlocked because OS-backed encryption is unavailable on this machine.`)
  }

  const encryptedPayload = raw.slice(SECURE_FILE_PREFIX.length)
  const decrypted = safeStorage.decryptString(Buffer.from(encryptedPayload, 'base64'))
  return JSON.parse(decrypted) as T
}

export function readSecureJsonFile<T>(filePath: string, options: ReadOptions<T>): T {
  if (!fs.existsSync(filePath)) {
    return options.fallback
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) {
      return options.fallback
    }

    if (raw.startsWith(SECURE_FILE_PREFIX)) {
      return decryptJson<T>(raw, options.fileLabel)
    }

    logWarn(
      'secureJson.plaintext-fallback',
      `${options.fileLabel} is stored as plaintext instead of encrypted — migrating to encrypted storage.`,
      { filePath }
    )
    const parsed = JSON.parse(raw) as T
    try {
      writeSecureJsonFile(filePath, parsed, options.fileLabel)
    } catch {
      /* migration is best-effort — encrypted write may fail if safeStorage is unavailable */
    }
    return parsed
  } catch {
    return options.fallback
  }
}

export function writeSecureJsonFile(filePath: string, value: unknown, fileLabel: string): void {
  ensureParentDirectory(filePath)
  fs.writeFileSync(filePath, `${encryptJson(value, fileLabel)}\n`, 'utf8')
}
