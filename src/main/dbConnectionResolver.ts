import type {
  AwsConnection,
  DbConnectionEngine,
  DbConnectionResolveInput,
  DbConnectionResolutionResult
} from '@shared/types'
import { getSecretValue } from './aws/secretsManager'
import { getDbVaultCredentialSecret, recordVaultEntryUseByKindAndName } from './localVault'

type ParsedSecretMaterial = {
  username: string
  password: string
  host: string
  port: number | null
  databaseName: string
}

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeEngine(value: DbConnectionEngine): DbConnectionEngine {
  switch (value) {
    case 'postgres':
    case 'mysql':
    case 'mariadb':
    case 'sqlserver':
    case 'oracle':
    case 'aurora-postgresql':
    case 'aurora-mysql':
      return value
    default:
      return 'unknown'
  }
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function encodeUriSegment(value: string): string {
  return encodeURIComponent(value)
}

function buildConnectionUri(
  engine: DbConnectionEngine,
  host: string,
  port: number,
  databaseName: string,
  username: string,
  password: string
): string {
  const encodedUser = encodeUriSegment(username)
  const encodedPassword = encodeUriSegment(password)
  const encodedDb = encodeUriSegment(databaseName)

  switch (engine) {
    case 'postgres':
    case 'aurora-postgresql':
      return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${encodedDb}?sslmode=require`
    case 'mysql':
    case 'mariadb':
    case 'aurora-mysql':
      return `mysql://${encodedUser}:${encodedPassword}@${host}:${port}/${encodedDb}?ssl-mode=REQUIRED`
    case 'sqlserver':
      return `sqlserver://${encodedUser}:${encodedPassword}@${host}:${port};database=${databaseName};encrypt=true;trustServerCertificate=false`
    case 'oracle':
      return `oracle://${encodedUser}:${encodedPassword}@${host}:${port}/${encodedDb}`
    default:
      return `${username}@${host}:${port}/${databaseName}`
  }
}

function buildCliCommand(
  engine: DbConnectionEngine,
  host: string,
  port: number,
  databaseName: string,
  username: string
): string {
  switch (engine) {
    case 'postgres':
    case 'aurora-postgresql':
      return `psql "host=${host} port=${port} dbname=${databaseName} user=${username} sslmode=require" -W`
    case 'mysql':
    case 'mariadb':
    case 'aurora-mysql':
      return `mysql --host=${host} --port=${port} --user=${username} --database=${databaseName} --ssl-mode=REQUIRED -p`
    case 'sqlserver':
      return `sqlcmd -S tcp:${host},${port} -d ${databaseName} -U ${username} -P <password>`
    case 'oracle':
      return `sqlplus ${username}/<password>@//${host}:${port}/${databaseName}`
    default:
      return `${username}@${host}:${port}/${databaseName}`
  }
}

function buildTerminalCommand(
  engine: DbConnectionEngine,
  host: string,
  port: number,
  databaseName: string,
  username: string
): string {
  switch (engine) {
    case 'postgres':
    case 'aurora-postgresql':
      return `psql "host=${host} port=${port} dbname=${databaseName} user=${username} sslmode=require" -W`
    case 'mysql':
    case 'mariadb':
    case 'aurora-mysql':
      return `mysql --host=${host} --port=${port} --user=${username} --database=${databaseName} --ssl-mode=REQUIRED -p`
    case 'sqlserver':
      return [
        '$pw = Read-Host "DB password"',
        `sqlcmd -S ${escapeShellArg(`tcp:${host},${port}`)} -d ${escapeShellArg(databaseName)} -U ${escapeShellArg(username)} -P $pw`
      ].join('; ')
    case 'oracle':
      return [
        '$pw = Read-Host "DB password"',
        `sqlplus "${username}/$pw@//${host}:${port}/${databaseName}"`
      ].join('; ')
    default:
      return `Write-Host ${escapeShellArg(`Connect with ${username}@${host}:${port}/${databaseName}`)}`
  }
}

function parseSecretString(secretString: string): ParsedSecretMaterial {
  const trimmed = secretString.trim()
  if (!trimmed) {
    return {
      username: '',
      password: '',
      host: '',
      port: null,
      databaseName: ''
    }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) {
      return {
        username: '',
        password: trimmed,
        host: '',
        port: null,
        databaseName: ''
      }
    }

    return {
      username: trim(parsed.username) || trim(parsed.user),
      password: trim(parsed.password),
      host: trim(parsed.host) || trim(parsed.hostname) || trim(parsed.address),
      port: parsePort(parsed.port),
      databaseName: trim(parsed.dbname) || trim(parsed.database) || trim(parsed.db)
    }
  } catch {
    return {
      username: '',
      password: trimmed,
      host: '',
      port: null,
      databaseName: ''
    }
  }
}

function summarizeSource(kind: DbConnectionResolveInput['credentialSourceKind'], ref: string): string {
  switch (kind) {
    case 'local-vault':
      return `Local vault: ${ref}`
    case 'aws-secrets-manager':
      return `AWS Secrets Manager: ${ref}`
    default:
      return 'Manual password entry'
  }
}

export async function resolveDbConnectionMaterial(
  connection: AwsConnection,
  input: DbConnectionResolveInput
): Promise<DbConnectionResolutionResult> {
  const resourceLabel = input.resourceLabel.trim() || input.resourceId.trim() || 'Database connection'
  const host = input.host.trim()
  const username = input.username.trim()
  const port = parsePort(input.port) ?? 0
  const credentialSourceRef = input.credentialSourceRef.trim()

  if (!host) {
    throw new Error('Database host is required.')
  }
  if (!username) {
    throw new Error('Database username is required.')
  }
  if (!port) {
    throw new Error('Database port is required.')
  }

  let parsedSecret: ParsedSecretMaterial = {
    username: '',
    password: '',
    host: '',
    port: null,
    databaseName: ''
  }

  if (input.credentialSourceKind === 'local-vault') {
    if (!credentialSourceRef) {
      throw new Error('Choose a local vault credential before resolving the connection.')
    }

    const secret = getDbVaultCredentialSecret(credentialSourceRef)
    if (!secret) {
      throw new Error(`Vault credential not found: ${credentialSourceRef}`)
    }

    parsedSecret = {
      username: secret.usernameHint,
      password: secret.password,
      host: '',
      port: null,
      databaseName: ''
    }

    recordVaultEntryUseByKindAndName('db-credential', credentialSourceRef, {
      source: 'rds-connection-helper',
      profile: connection.profile,
      region: connection.region,
      resourceId: input.resourceId.trim(),
      resourceLabel
    })
  } else if (input.credentialSourceKind === 'aws-secrets-manager') {
    if (!credentialSourceRef) {
      throw new Error('Secrets Manager ARN or name is required.')
    }

    const secretValue = await getSecretValue(connection, credentialSourceRef)
    parsedSecret = parseSecretString(secretValue.secretString)
  } else {
    parsedSecret = {
      username: '',
      password: input.manualPassword.trim(),
      host: '',
      port: null,
      databaseName: ''
    }
  }

  if (!parsedSecret.password) {
    throw new Error('No database password could be resolved from the selected credential source.')
  }

  const resolvedHost = parsedSecret.host || host
  const resolvedPort = parsedSecret.port ?? port
  const resolvedDatabaseName = parsedSecret.databaseName || input.databaseName.trim()
  const resolvedUsername = parsedSecret.username || username
  const normalizedEngine = normalizeEngine(input.engine)
  const warnings: string[] = []

  if (parsedSecret.host && parsedSecret.host !== host) {
    warnings.push(`Secret host override applied: ${parsedSecret.host}`)
  }
  if (parsedSecret.port && parsedSecret.port !== port) {
    warnings.push(`Secret port override applied: ${parsedSecret.port}`)
  }
  if (parsedSecret.databaseName && parsedSecret.databaseName !== input.databaseName.trim()) {
    warnings.push(`Secret database override applied: ${parsedSecret.databaseName}`)
  }
  if (parsedSecret.username && parsedSecret.username !== username) {
    warnings.push(`Secret username override applied: ${parsedSecret.username}`)
  }

  const cliCommand = buildCliCommand(normalizedEngine, resolvedHost, resolvedPort, resolvedDatabaseName, resolvedUsername)
  const terminalCommand = buildTerminalCommand(normalizedEngine, resolvedHost, resolvedPort, resolvedDatabaseName, resolvedUsername)
  const connectionUri = buildConnectionUri(
    normalizedEngine,
    resolvedHost,
    resolvedPort,
    resolvedDatabaseName,
    resolvedUsername,
    parsedSecret.password
  )
  const maskedConnectionUri = buildConnectionUri(
    normalizedEngine,
    resolvedHost,
    resolvedPort,
    resolvedDatabaseName,
    resolvedUsername,
    '***'
  )

  return {
    presetId: input.presetId?.trim() ?? '',
    displayName: resourceLabel,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId.trim(),
    engine: normalizedEngine,
    host: resolvedHost,
    port: resolvedPort,
    databaseName: resolvedDatabaseName,
    username: resolvedUsername,
    password: parsedSecret.password,
    credentialSourceKind: input.credentialSourceKind,
    credentialSourceRef,
    sourceSummary: summarizeSource(input.credentialSourceKind, credentialSourceRef),
    warnings,
    snippets: [
      { id: 'terminal-command', label: 'Terminal Command', value: terminalCommand, sensitive: false },
      { id: 'cli-command', label: 'CLI Command', value: cliCommand, sensitive: false },
      { id: 'masked-uri', label: 'Masked Connection URI', value: maskedConnectionUri, sensitive: false },
      { id: 'connection-uri', label: 'Connection URI', value: connectionUri, sensitive: true }
    ],
    terminalCommand,
    cliCommand,
    maskedConnectionUri,
    connectionUri,
    resolvedAt: new Date().toISOString()
  }
}
