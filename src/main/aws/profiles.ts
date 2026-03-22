import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AwsProfile } from '@shared/types'

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

export function listAwsProfiles(): AwsProfile[] {
  const awsDir = path.join(os.homedir(), '.aws')
  const configPath = path.join(awsDir, 'config')
  const credentialsPath = path.join(awsDir, 'credentials')
  const configProfiles = parseIniSections(configPath)
  const credentialProfiles = parseIniSections(credentialsPath)
  const regions = parseConfigRegions(configPath)

  const merged = new Map<string, AwsProfile>()

  for (const name of configProfiles) {
    merged.set(name, {
      name,
      source: 'config',
      region: regions.get(name) ?? 'us-east-1'
    })
  }

  for (const name of credentialProfiles) {
    if (!merged.has(name)) {
      merged.set(name, {
        name,
        source: 'credentials',
        region: regions.get(name) ?? 'us-east-1'
      })
    }
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}
