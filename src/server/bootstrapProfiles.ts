/**
 * Bootstrap AWS profiles from environment variables at server startup.
 *
 * Supported env var patterns:
 *
 * 1. Standard AWS env vars → written as the "default" profile:
 *      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
 *
 * 2. Named profiles via JSON env vars:
 *      AWS_LENS_PROFILE_<NAME>={"accessKeyId":"...","secretAccessKey":"...","region":"..."}
 *    Example:
 *      AWS_LENS_PROFILE_BILLING={"accessKeyId":"AKIA...","secretAccessKey":"...","region":"us-east-1"}
 *      AWS_LENS_PROFILE_PROD={"accessKeyId":"AKIA...","secretAccessKey":"...","region":"us-west-2"}
 *
 * Profiles are written to ~/.aws/credentials and ~/.aws/config.
 * Existing entries for the same profile name are overwritten.
 * This runs once at startup — no credentials are logged.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface ProfileSpec {
  name: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}

function ensureAwsDir(): string {
  const dir = path.join(os.homedir(), '.aws')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeCredentialsSection(filePath: string, name: string, spec: ProfileSpec): void {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  content = removeIniSection(content, name)

  const lines = [`[${name}]`, `aws_access_key_id = ${spec.accessKeyId}`, `aws_secret_access_key = ${spec.secretAccessKey}`]
  if (spec.sessionToken) lines.push(`aws_session_token = ${spec.sessionToken}`)

  fs.writeFileSync(filePath, `${content.trim()}\n\n${lines.join('\n')}\n`, 'utf8')
}

function writeConfigSection(filePath: string, name: string, spec: ProfileSpec): void {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  const header = name === 'default' ? '[default]' : `[profile ${name}]`
  content = removeIniSection(content, name === 'default' ? 'default' : `profile ${name}`)

  const lines = [header, `region = ${spec.region}`]
  fs.writeFileSync(filePath, `${content.trim()}\n\n${lines.join('\n')}\n`, 'utf8')
}

function removeIniSection(content: string, sectionName: string): string {
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      skip = trimmed.slice(1, -1).trim() === sectionName
    }
    if (!skip) kept.push(line)
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function collectProfiles(): ProfileSpec[] {
  const profiles: ProfileSpec[] = []

  // Pattern 1: standard AWS env vars → default profile
  const keyId = process.env.AWS_ACCESS_KEY_ID
  const secret = process.env.AWS_SECRET_ACCESS_KEY
  const region = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1'

  if (keyId && secret) {
    profiles.push({
      name: 'default',
      accessKeyId: keyId,
      secretAccessKey: secret,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      region
    })
  }

  // Pattern 2: AWS_LENS_PROFILE_<NAME>=JSON
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AWS_LENS_PROFILE_') || !value) continue

    const name = key.slice('AWS_LENS_PROFILE_'.length).toLowerCase().replace(/_/g, '-')
    if (!name) continue

    try {
      const parsed = JSON.parse(value) as Record<string, string>
      const { accessKeyId, secretAccessKey, region: r, sessionToken } = parsed

      if (!accessKeyId || !secretAccessKey) {
        console.warn(`[bootstrap] ${key}: missing accessKeyId or secretAccessKey — skipped`)
        continue
      }

      profiles.push({
        name,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        region: r ?? 'us-east-1'
      })
    } catch {
      console.warn(`[bootstrap] ${key}: invalid JSON — skipped`)
    }
  }

  return profiles
}

export function bootstrapProfiles(): void {
  const profiles = collectProfiles()
  if (profiles.length === 0) return

  const awsDir = ensureAwsDir()
  const credentialsPath = path.join(awsDir, 'credentials')
  const configPath = path.join(awsDir, 'config')

  for (const spec of profiles) {
    writeCredentialsSection(credentialsPath, spec.name, spec)
    writeConfigSection(configPath, spec.name, spec)
    console.log(`[bootstrap] seeded profile: ${spec.name} (${spec.region})`)
  }
}
