import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

import type { AwsProfile } from '@shared/types'
import { clearCredentialsProviderCache } from './client'

type ProfileRegistry = {
  manualProfiles: string[]
}

function appProfileRegistryPath(): string {
  return path.join(app.getPath('userData'), 'profile-registry.json')
}

function readProfileRegistry(): ProfileRegistry {
  const filePath = appProfileRegistryPath()
  if (!fs.existsSync(filePath)) {
    return { manualProfiles: [] }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ProfileRegistry>
    return {
      manualProfiles: Array.isArray(parsed.manualProfiles)
        ? parsed.manualProfiles.filter((entry): entry is string => typeof entry === 'string')
        : []
    }
  } catch {
    return { manualProfiles: [] }
  }
}

function writeProfileRegistry(registry: ProfileRegistry): void {
  const filePath = appProfileRegistryPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

function markProfileAsManual(profileName: string): void {
  const registry = readProfileRegistry()
  if (registry.manualProfiles.includes(profileName)) {
    return
  }

  registry.manualProfiles.push(profileName)
  registry.manualProfiles.sort((a, b) => a.localeCompare(b))
  writeProfileRegistry(registry)
}

function unmarkProfileAsManual(profileName: string): void {
  const registry = readProfileRegistry()
  const nextProfiles = registry.manualProfiles.filter((entry) => entry !== profileName)
  if (nextProfiles.length === registry.manualProfiles.length) {
    return
  }

  writeProfileRegistry({ manualProfiles: nextProfiles })
}

function isManualProfile(profileName: string): boolean {
  return readProfileRegistry().manualProfiles.includes(profileName)
}

function parseIniSections(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return []
  }

  const text = fs.readFileSync(filePath, 'utf8')
  const names = new Set<string>()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('[') || !line.endsWith(']')) {
      continue
    }

    let name = line.slice(1, -1).trim()
    if (name.startsWith('profile ')) {
      name = name.slice('profile '.length).trim()
    }
    if (name) {
      names.add(name)
    }
  }

  return [...names]
}

function parseConfigRegions(filePath: string): Map<string, string> {
  if (!fs.existsSync(filePath)) {
    return new Map()
  }

  const text = fs.readFileSync(filePath, 'utf8')
  const regions = new Map<string, string>()
  let currentProfile = ''

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      currentProfile = line.slice(1, -1).trim()
      if (currentProfile.startsWith('profile ')) {
        currentProfile = currentProfile.slice('profile '.length).trim()
      }
      continue
    }
    if (!currentProfile) {
      continue
    }
    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (key === 'region' && value) {
      regions.set(currentProfile, value)
    }
  }

  return regions
}

function parseIniFile(filePath: string): Map<string, Map<string, string>> {
  if (!fs.existsSync(filePath)) {
    return new Map()
  }

  const text = fs.readFileSync(filePath, 'utf8')
  const sections = new Map<string, Map<string, string>>()
  let currentSection = ''

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim()
      if (currentSection.startsWith('profile ')) {
        currentSection = currentSection.slice('profile '.length).trim()
      }
      if (!sections.has(currentSection)) {
        sections.set(currentSection, new Map())
      }
      continue
    }
    if (!currentSection) {
      continue
    }
    const separatorIndex = line.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    sections.get(currentSection)!.set(key, value)
  }

  return sections
}

export function importAwsConfigFile(filePath: string): string[] {
  const sections = parseIniFile(filePath)
  if (sections.size === 0) {
    throw new Error('No profiles found in the selected file.')
  }

  const awsDir = path.join(os.homedir(), '.aws')
  if (!fs.existsSync(awsDir)) {
    fs.mkdirSync(awsDir, { recursive: true })
  }

  const credentialsPath = path.join(awsDir, 'credentials')
  const configPath = path.join(awsDir, 'config')
  const imported: string[] = []

  for (const [name, fields] of sections) {
    const hasKey = fields.has('aws_access_key_id')
    const hasSecret = fields.has('aws_secret_access_key')
    const region = fields.get('region')

    if (hasKey && hasSecret) {
      appendCredentialSection(credentialsPath, name, {
        aws_access_key_id: fields.get('aws_access_key_id')!,
        aws_secret_access_key: fields.get('aws_secret_access_key')!,
        ...(fields.has('aws_session_token') ? { aws_session_token: fields.get('aws_session_token')! } : {})
      })
    }

    if (region) {
      appendConfigSection(configPath, name, { region })
    }

    imported.push(name)
  }

  clearCredentialsProviderCache()

  return imported
}

export function saveAwsCredentials(profileName: string, accessKeyId: string, secretAccessKey: string): void {
  if (!profileName.trim()) {
    throw new Error('Profile name is required.')
  }
  if (!accessKeyId.trim()) {
    throw new Error('Access Key ID is required.')
  }
  if (!secretAccessKey.trim()) {
    throw new Error('Secret Access Key is required.')
  }

  const awsDir = path.join(os.homedir(), '.aws')
  if (!fs.existsSync(awsDir)) {
    fs.mkdirSync(awsDir, { recursive: true })
  }

  const credentialsPath = path.join(awsDir, 'credentials')
  const trimmedProfileName = profileName.trim()
  appendCredentialSection(credentialsPath, trimmedProfileName, {
    aws_access_key_id: accessKeyId.trim(),
    aws_secret_access_key: secretAccessKey.trim()
  })
  markProfileAsManual(trimmedProfileName)
  clearCredentialsProviderCache(trimmedProfileName)
}

export function deleteAwsProfile(profileName: string): void {
  const trimmed = profileName.trim()
  if (!trimmed) {
    throw new Error('Profile name is required.')
  }
  if (!isManualProfile(trimmed)) {
    throw new Error('Only profiles created manually in AWS Lens can be deleted from the catalog.')
  }

  const awsDir = path.join(os.homedir(), '.aws')
  const credentialsPath = path.join(awsDir, 'credentials')
  const configPath = path.join(awsDir, 'config')

  removeCredentialSection(credentialsPath, trimmed)
  removeConfigSection(configPath, trimmed)
  unmarkProfileAsManual(trimmed)
  clearCredentialsProviderCache(trimmed)
}

function appendCredentialSection(filePath: string, name: string, fields: Record<string, string>): void {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''

  // Remove existing section if present
  content = removeSection(content, [new RegExp(`^\\[${escapeRegExp(name)}\\]$`)])
  content = content.replace(/\n{3,}/g, '\n\n').trim()

  const block = `\n\n[${name}]\n` + Object.entries(fields).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n'
  fs.writeFileSync(filePath, content + block, 'utf8')
}

function appendConfigSection(filePath: string, name: string, fields: Record<string, string>): void {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''

  const header = name === 'default' ? `[${name}]` : `[profile ${name}]`
  content = removeSection(content, name === 'default'
    ? [new RegExp(`^\\[default\\]$`)]
    : [new RegExp(`^\\[profile ${escapeRegExp(name)}\\]$`)]
  )
  content = content.replace(/\n{3,}/g, '\n\n').trim()

  const block = `\n\n${header}\n` + Object.entries(fields).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n'
  fs.writeFileSync(filePath, content + block, 'utf8')
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function removeSection(content: string, headerPatterns: RegExp[]): string {
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()
    const isHeader = trimmed.startsWith('[') && trimmed.endsWith(']')

    if (isHeader) {
      skip = headerPatterns.some((pattern) => pattern.test(trimmed))
    }

    if (!skip) {
      kept.push(line)
    }
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function removeCredentialSection(filePath: string, name: string): void {
  if (!fs.existsSync(filePath)) {
    return
  }

  const next = removeSection(fs.readFileSync(filePath, 'utf8'), [new RegExp(`^\\[${escapeRegExp(name)}\\]$`)])
  writeOrDeleteFile(filePath, next)
}

function removeConfigSection(filePath: string, name: string): void {
  if (!fs.existsSync(filePath)) {
    return
  }

  const patterns = name === 'default'
    ? [new RegExp(`^\\[default\\]$`)]
    : [new RegExp(`^\\[profile ${escapeRegExp(name)}\\]$`)]
  const next = removeSection(fs.readFileSync(filePath, 'utf8'), patterns)
  writeOrDeleteFile(filePath, next)
}

function writeOrDeleteFile(filePath: string, content: string): void {
  const trimmed = content.trim()
  if (!trimmed) {
    fs.unlinkSync(filePath)
    return
  }

  fs.writeFileSync(filePath, `${trimmed}\n`, 'utf8')
}

export function listAwsProfiles(): AwsProfile[] {
  const awsDir = path.join(os.homedir(), '.aws')
  const configPath = path.join(awsDir, 'config')
  const credentialsPath = path.join(awsDir, 'credentials')
  const configProfiles = parseIniSections(configPath)
  const credentialProfiles = parseIniSections(credentialsPath)
  const regions = parseConfigRegions(configPath)
  const manualProfiles = new Set(readProfileRegistry().manualProfiles)

  const merged = new Map<string, AwsProfile>()

  for (const name of configProfiles) {
    merged.set(name, {
      name,
      source: 'config',
      region: regions.get(name) ?? 'us-east-1',
      managedByApp: manualProfiles.has(name)
    })
  }

  for (const name of credentialProfiles) {
    if (!merged.has(name)) {
      merged.set(name, {
        name,
        source: 'credentials',
        region: regions.get(name) ?? 'us-east-1',
        managedByApp: manualProfiles.has(name)
      })
    } else {
      const existing = merged.get(name)
      if (existing) {
        merged.set(name, {
          ...existing,
          managedByApp: existing.managedByApp || manualProfiles.has(name)
        })
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}
