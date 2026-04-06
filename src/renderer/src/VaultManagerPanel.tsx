import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import type {
  AwsConnection,
  AppSecuritySummary,
  DbConnectionEngine,
  EnterpriseAccessMode,
  KeyPairSummary,
  VaultEntryInput,
  VaultEntryKind,
  VaultEntrySummary,
  VaultOrigin,
  VaultRotationState,
  VaultSshKeyInspection
} from '@shared/types'
import {
  deleteVaultEntry,
  inspectVaultSshKey,
  listKeyPairs,
  listVaultEntries,
  revealVaultEntrySecret,
  saveVaultEntry
} from './api'

type VaultManagerPanelProps = {
  accessMode: EnterpriseAccessMode
  active: boolean
  securitySummary: AppSecuritySummary | null
}

type DraftMode = 'create' | 'import'
type VaultKindFilter = 'all' | VaultEntryKind
type VaultDraft = {
  kind: VaultEntryKind
  origin: VaultOrigin
  name: string
  secret: string
  rotationState: VaultRotationState
  rotationUpdatedAt: string
  reminderAt: string
  expiryAt: string
  accessKeyId: string
  secretAccessKey: string
  usernameHint: string
  dbEngine: DbConnectionEngine
  notes: string
  service: string
}
type ImportSelection = {
  fileName: string
  content: string
  suggestedKind: VaultEntryKind
}

const KIND_LABELS: Record<VaultEntryKind, string> = {
  'aws-profile': 'AWS credentials',
  'ssh-key': 'SSH private key',
  pem: 'PEM key',
  'access-key': 'Access key',
  generic: 'Generic secret',
  'db-credential': 'DB login',
  'kubeconfig-fragment': 'Kubeconfig fragment',
  'api-token': 'API token',
  'connection-secret': 'Connection secret'
}

const ORIGIN_LABELS: Record<VaultOrigin, string> = {
  manual: 'Manual',
  imported: 'Imported',
  'aws-secrets-manager': 'Secrets Manager',
  'aws-ssm': 'SSM Parameter Store',
  generated: 'Generated',
  unknown: 'Unknown'
}

const ORIGIN_OPTIONS: VaultOrigin[] = [
  'manual',
  'imported',
  'aws-secrets-manager',
  'aws-ssm',
  'generated'
]

const ROTATION_LABELS: Record<VaultRotationState, string> = {
  unknown: 'Unknown',
  'not-applicable': 'Not applicable',
  tracked: 'Tracked',
  'rotation-due': 'Rotation due',
  rotated: 'Rotated'
}

const KIND_OPTIONS: Array<{ value: VaultKindFilter; label: string }> = [
  { value: 'all', label: 'All kinds' },
  { value: 'aws-profile', label: 'AWS credentials' },
  { value: 'pem', label: 'PEM keys' },
  { value: 'db-credential', label: 'DB logins' },
  { value: 'kubeconfig-fragment', label: 'Kubeconfig fragments' },
  { value: 'api-token', label: 'API tokens' },
  { value: 'generic', label: 'Generic secrets' },
  { value: 'ssh-key', label: 'SSH keys' },
  { value: 'access-key', label: 'Access keys' },
  { value: 'connection-secret', label: 'Connection secrets' }
]

const DB_ENGINE_OPTIONS: DbConnectionEngine[] = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlserver',
  'oracle',
  'aurora-postgresql',
  'aurora-mysql',
  'unknown'
]

const KIND_DESCRIPTIONS: Record<VaultEntryKind, string> = {
  'aws-profile': 'Store an access key ID and secret access key pair in the vault for app-managed AWS sessions.',
  'ssh-key': 'Store SSH private key material that can be staged into EC2 and bastion workflows.',
  pem: 'Store PEM-formatted private key material for direct SSH and certificate-based access.',
  'access-key': 'Store a raw access key or shared secret without extra structure.',
  generic: 'Store arbitrary secret text, JSON blobs, or copied credentials that do not fit a typed workflow yet.',
  'db-credential': 'Store a reusable database login with engine, username hint, and password metadata.',
  'kubeconfig-fragment': 'Store a kubeconfig snippet or context fragment for future cluster connection presets.',
  'api-token': 'Store a service token or bearer credential together with the service label that uses it.',
  'connection-secret': 'Store a structured connection payload such as JSON returned by another system.'
}

function normalizeDbEngineLabel(engine: DbConnectionEngine): string {
  switch (engine) {
    case 'aurora-postgresql':
      return 'Aurora PostgreSQL'
    case 'aurora-mysql':
      return 'Aurora MySQL'
    case 'sqlserver':
      return 'SQL Server'
    default:
      return engine ? engine.charAt(0).toUpperCase() + engine.slice(1) : 'Unknown'
  }
}

function createDraft(mode: DraftMode): VaultDraft {
  return {
    kind: mode === 'import' ? 'connection-secret' : 'generic',
    origin: mode === 'import' ? 'imported' : 'manual',
    name: '',
    secret: '',
    rotationState: 'unknown',
    rotationUpdatedAt: '',
    reminderAt: '',
    expiryAt: '',
    accessKeyId: '',
    secretAccessKey: '',
    usernameHint: '',
    dbEngine: 'unknown',
    notes: '',
    service: ''
  }
}

function inferImportKind(fileName: string, content: string): VaultEntryKind {
  const normalized = fileName.trim().toLowerCase()
  const normalizedContent = content.trim().toLowerCase()

  if (normalized.endsWith('.pem') || normalizedContent.includes('-----begin')) {
    return 'pem'
  }
  if (normalized.endsWith('.ppk') || normalized.endsWith('.key')) {
    return 'ssh-key'
  }
  if (
    normalized.includes('kube')
    || (
      normalizedContent.includes('apiversion:')
      && (
        normalizedContent.includes('clusters:')
        || normalizedContent.includes('contexts:')
        || normalizedContent.includes('users:')
      )
    )
  ) {
    return 'kubeconfig-fragment'
  }
  if (normalized.includes('token') || normalized.includes('bearer')) {
    return 'api-token'
  }
  if (normalized.endsWith('.json')) {
    try {
      const parsed = JSON.parse(content) as Partial<{
        accessKeyId: string
        secretAccessKey: string
        password: string
      }>
      if (typeof parsed.accessKeyId === 'string' && typeof parsed.secretAccessKey === 'string') {
        return 'aws-profile'
      }
      if (typeof parsed.password === 'string') {
        return 'db-credential'
      }
    } catch {
      // Fall through to generic connection secret handling.
    }
  }
  if (normalized.endsWith('.json')) {
    return 'connection-secret'
  }

  return 'generic'
}

function defaultRotationState(kind: VaultEntryKind): VaultRotationState {
  return kind === 'pem' || kind === 'ssh-key' ? 'not-applicable' : 'unknown'
}

function normalizeDateTimeInput(value: string): string {
  if (!value.trim()) {
    return ''
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }

  return parsed.toISOString()
}

function formatDateTimeInput(value: string): string {
  if (!value) {
    return ''
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }

  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  const hours = String(parsed.getHours()).padStart(2, '0')
  const minutes = String(parsed.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function describeTimeDistance(value: string): string {
  if (!value) {
    return 'Not scheduled'
  }

  const target = new Date(value)
  if (Number.isNaN(target.getTime())) {
    return value
  }

  const diffMs = target.getTime() - Date.now()
  const absHours = Math.round(Math.abs(diffMs) / (1000 * 60 * 60))
  if (absHours < 24) {
    return diffMs >= 0 ? `in ${absHours}h` : `${absHours}h ago`
  }

  const absDays = Math.round(absHours / 24)
  return diffMs >= 0 ? `in ${absDays}d` : `${absDays}d ago`
}

function isTimestampDue(value: string): boolean {
  if (!value) {
    return false
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }

  return parsed.getTime() <= Date.now()
}

function hasRecentUse(value: string): boolean {
  if (!value) {
    return false
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }

  return Date.now() - parsed.getTime() <= 1000 * 60 * 60 * 24 * 14
}

function buildCreatePayload(draft: VaultDraft): VaultEntryInput {
  const name = draft.name.trim()

  switch (draft.kind) {
    case 'aws-profile': {
      const accessKeyId = draft.accessKeyId.trim()
      const secretAccessKey = draft.secretAccessKey.trim()
      if (!accessKeyId || !secretAccessKey) {
        throw new Error('AWS credentials require both access key ID and secret access key.')
      }

      return {
        kind: draft.kind,
        name,
        secret: JSON.stringify({
          accessKeyId,
          secretAccessKey
        }),
        origin: draft.origin,
        rotationState: draft.rotationState,
        rotationUpdatedAt: draft.rotationUpdatedAt,
        reminderAt: draft.reminderAt,
        expiryAt: draft.expiryAt,
        metadata: {
          profileName: name
        }
      }
    }
    case 'db-credential': {
      const password = draft.secret.trim()
      if (!password) {
        throw new Error('DB login requires a password.')
      }

      return {
        kind: draft.kind,
        name,
        secret: JSON.stringify({
          password,
          usernameHint: draft.usernameHint.trim(),
          engine: draft.dbEngine,
          notes: draft.notes.trim()
        }),
        origin: draft.origin,
        rotationState: draft.rotationState,
        rotationUpdatedAt: draft.rotationUpdatedAt,
        reminderAt: draft.reminderAt,
        expiryAt: draft.expiryAt,
        metadata: {
          usernameHint: draft.usernameHint.trim(),
          engine: draft.dbEngine,
          notes: draft.notes.trim()
        }
      }
    }
    case 'api-token':
      return {
        kind: draft.kind,
        name,
        secret: draft.secret,
        origin: draft.origin,
        rotationState: draft.rotationState,
        rotationUpdatedAt: draft.rotationUpdatedAt,
        reminderAt: draft.reminderAt,
        expiryAt: draft.expiryAt,
        metadata: {
          service: draft.service.trim(),
          notes: draft.notes.trim()
        }
      }
    case 'kubeconfig-fragment':
      return {
        kind: draft.kind,
        name,
        secret: draft.secret,
        origin: draft.origin,
        rotationState: draft.rotationState,
        rotationUpdatedAt: draft.rotationUpdatedAt,
        reminderAt: draft.reminderAt,
        expiryAt: draft.expiryAt,
        metadata: {
          format: 'kubeconfig'
        }
      }
    default:
      return {
        kind: draft.kind,
        name,
        secret: draft.secret,
        origin: draft.origin,
        rotationState: draft.rotationState,
        rotationUpdatedAt: draft.rotationUpdatedAt,
        reminderAt: draft.reminderAt,
        expiryAt: draft.expiryAt
      }
  }
}

function describeOriginSelection(origin: VaultOrigin): string {
  switch (origin) {
    case 'manual':
      return 'Secret was entered directly in AWS Lens and is stored locally.'
    case 'imported':
      return 'Secret was imported from a file or copied from an external source into the local vault.'
    case 'aws-secrets-manager':
      return 'Secret material originated from AWS Secrets Manager before being stored or mirrored locally.'
    case 'aws-ssm':
      return 'Secret material originated from AWS Systems Manager Parameter Store.'
    case 'generated':
      return 'Secret was generated by AWS Lens or an adjacent automation workflow.'
    default:
      return 'Origin is not classified.'
  }
}

function getSecretFieldLabel(kind: VaultEntryKind): string {
  switch (kind) {
    case 'pem':
      return 'PEM contents'
    case 'ssh-key':
      return 'SSH private key'
    case 'api-token':
      return 'Token'
    case 'kubeconfig-fragment':
      return 'Kubeconfig fragment'
    case 'connection-secret':
      return 'Connection payload'
    default:
      return 'Secret'
  }
}

function getSecretPlaceholder(kind: VaultEntryKind): string {
  switch (kind) {
    case 'pem':
      return '-----BEGIN PRIVATE KEY-----'
    case 'ssh-key':
      return 'Paste the SSH private key contents'
    case 'api-token':
      return 'Paste the API token or bearer secret'
    case 'kubeconfig-fragment':
      return 'apiVersion: v1\nkind: Config\nclusters:\n  - name: ...'
    case 'connection-secret':
      return 'Paste the JSON connection payload or secret blob'
    case 'access-key':
      return 'Paste the raw access key or shared secret'
    default:
      return 'Paste the secret value or JSON blob'
  }
}

function formatTimestamp(value: string): string {
  if (!value) {
    return 'Not recorded'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString()
}

function formatListTimestamp(entry: VaultEntrySummary): string {
  if (entry.expiryAt && isTimestampDue(entry.expiryAt)) {
    return `Expired ${formatTimestamp(entry.expiryAt)}`
  }

  if (entry.reminderAt && isTimestampDue(entry.reminderAt)) {
    return `Reminder due ${formatTimestamp(entry.reminderAt)}`
  }

  if (entry.lastUsedAt) {
    return `Used ${formatTimestamp(entry.lastUsedAt)}`
  }

  if (entry.updatedAt) {
    return `Updated ${formatTimestamp(entry.updatedAt)}`
  }

  return 'No activity yet'
}

function describeUsage(entry: VaultEntrySummary): string {
  if (!entry.lastUsedContext) {
    return 'No usage telemetry recorded yet.'
  }

  const parts = [
    entry.lastUsedContext.source,
    entry.lastUsedContext.profile ? `profile ${entry.lastUsedContext.profile}` : '',
    entry.lastUsedContext.region ? entry.lastUsedContext.region : '',
    entry.lastUsedContext.resourceLabel || entry.lastUsedContext.resourceId
  ].filter(Boolean)

  return parts.join(' | ')
}

function describeUsageStatus(entry: VaultEntrySummary): string {
  if (!entry.lastUsedAt) {
    return 'Never used'
  }

  return hasRecentUse(entry.lastUsedAt) ? 'Used in the last 14 days' : 'No recent usage'
}

function describeReminderStatus(entry: VaultEntrySummary): string {
  if (!entry.reminderAt) {
    return 'No reminder set'
  }

  return isTimestampDue(entry.reminderAt)
    ? `Reminder due (${describeTimeDistance(entry.reminderAt)})`
    : `Reminder scheduled ${describeTimeDistance(entry.reminderAt)}`
}

function describeExpiryStatus(entry: VaultEntrySummary): string {
  if (!entry.expiryAt) {
    return 'No expiry tracked'
  }

  return isTimestampDue(entry.expiryAt)
    ? `Expired ${describeTimeDistance(entry.expiryAt)}`
    : `Expires ${describeTimeDistance(entry.expiryAt)}`
}

function isSshVaultEntry(entry: VaultEntrySummary | null): entry is VaultEntrySummary {
  return entry?.kind === 'pem' || entry?.kind === 'ssh-key'
}

function normalizeSshKeyName(value: string): string {
  return value.trim().toLowerCase().replace(/\.(pem|ppk|key|pub)$/g, '')
}

function normalizeFingerprint(value: string): string {
  return value.trim().replace(/^md5:/i, '').toLowerCase()
}

function fingerprintsMatch(pair: KeyPairSummary, inspection: VaultSshKeyInspection): boolean {
  const pairFingerprint = normalizeFingerprint(pair.fingerprint)
  if (!pairFingerprint) {
    return false
  }

  return pairFingerprint === normalizeFingerprint(inspection.fingerprintSha256)
    || pairFingerprint === normalizeFingerprint(inspection.fingerprintMd5)
}

function describeInspectionSource(source: VaultSshKeyInspection['publicKeySource']): string {
  switch (source) {
    case 'metadata-inline':
      return 'Stored with the vault entry'
    case 'metadata-path':
      return 'Read from the saved public key path'
    case 'source-path':
      return 'Read from the original import path'
    case 'legacy-staged-path':
      return 'Recovered from legacy staged temp metadata'
    case 'derived-from-private-key':
      return 'Derived from the private key contents'
    default:
      return 'Public key unavailable'
  }
}

function buildVaultLookupConnection(entry: VaultEntrySummary): AwsConnection | null {
  const profile = entry.lastUsedContext?.profile?.trim()
  const region = entry.lastUsedContext?.region?.trim()
  if (!profile || !region) {
    return null
  }

  return {
    kind: 'profile',
    sessionId: `vault-keypair-lookup:${entry.id}`,
    label: `Vault lookup ${profile}`,
    profile,
    region
  }
}

export function VaultManagerPanel({
  accessMode,
  active,
  securitySummary
}: VaultManagerPanelProps): JSX.Element {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const [allEntries, setAllEntries] = useState<VaultEntrySummary[]>([])
  const [selectedEntryId, setSelectedEntryId] = useState('')
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<VaultKindFilter>('all')
  const [inventoryBusy, setInventoryBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [draftMode, setDraftMode] = useState<DraftMode>('create')
  const [draft, setDraft] = useState<VaultDraft>(() => createDraft('create'))
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null)
  const [revealedEntryId, setRevealedEntryId] = useState('')
  const [revealedSecret, setRevealedSecret] = useState('')
  const [sshInspection, setSshInspection] = useState<VaultSshKeyInspection | null>(null)
  const [sshInspectionBusy, setSshInspectionBusy] = useState(false)
  const [sshInspectionError, setSshInspectionError] = useState('')
  const [relatedKeyPairs, setRelatedKeyPairs] = useState<KeyPairSummary[]>([])
  const [relatedKeyPairsBusy, setRelatedKeyPairsBusy] = useState(false)
  const [relatedKeyPairsError, setRelatedKeyPairsError] = useState('')

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase()

    return allEntries.filter((entry) => {
      if (kindFilter !== 'all' && entry.kind !== kindFilter) {
        return false
      }

      if (!query) {
        return true
      }

      return [
        entry.name,
        entry.kind,
        entry.origin,
        entry.lastUsedContext?.source ?? '',
        ...Object.entries(entry.metadata).flatMap(([key, value]) => [key, value])
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
  }, [allEntries, kindFilter, search])

  const selectedEntry = useMemo(
    () => allEntries.find((entry) => entry.id === selectedEntryId) ?? null,
    [allEntries, selectedEntryId]
  )

  const lookupConnection = useMemo(
    () => (selectedEntry ? buildVaultLookupConnection(selectedEntry) : null),
    [selectedEntry]
  )

  const rotationSummary = useMemo(() => ({
    due: allEntries.filter((entry) => entry.rotationState === 'rotation-due' || isTimestampDue(entry.reminderAt)).length,
    expired: allEntries.filter((entry) => isTimestampDue(entry.expiryAt)).length,
    recentlyUsed: allEntries.filter((entry) => hasRecentUse(entry.lastUsedAt)).length
  }), [allEntries])

  const countsByKind = useMemo(() => {
    const counts = {
      total: allEntries.length,
      'aws-profile': 0,
      'ssh-key': 0,
      pem: 0,
      'access-key': 0,
      'db-credential': 0,
      'kubeconfig-fragment': 0,
      'api-token': 0,
      'connection-secret': 0,
      generic: 0
    }

    for (const entry of allEntries) {
      counts[entry.kind] += 1
    }

    return counts
  }, [allEntries])

  const relatedKeyPairSummary = useMemo(() => {
    if (!sshInspection) {
      return {
        fingerprintMatches: [] as KeyPairSummary[],
        nameMatches: [] as KeyPairSummary[]
      }
    }

    const normalizedHints = sshInspection.keyNameHints.map((hint) => normalizeSshKeyName(hint))
    const fingerprintMatches: KeyPairSummary[] = []
    const nameMatches: KeyPairSummary[] = []

    for (const pair of relatedKeyPairs) {
      if (fingerprintsMatch(pair, sshInspection)) {
        fingerprintMatches.push(pair)
        continue
      }

      if (normalizedHints.includes(normalizeSshKeyName(pair.keyName))) {
        nameMatches.push(pair)
      }
    }

    return {
      fingerprintMatches,
      nameMatches
    }
  }, [relatedKeyPairs, sshInspection])

  useEffect(() => {
    if (!selectedEntryId || visibleEntries.some((entry) => entry.id === selectedEntryId)) {
      return
    }

    setSelectedEntryId(visibleEntries[0]?.id ?? '')
  }, [selectedEntryId, visibleEntries])

  useEffect(() => {
    if (!selectedEntry || selectedEntry.id === revealedEntryId) {
      return
    }

    setRevealedEntryId('')
    setRevealedSecret('')
  }, [revealedEntryId, selectedEntry])

  useEffect(() => {
    if (!active) {
      return
    }

    void hydrateEntries()
  }, [active])

  useEffect(() => {
    let cancelled = false

    async function hydrateSshInspection(): Promise<void> {
      if (!selectedEntry || !isSshVaultEntry(selectedEntry)) {
        setSshInspection(null)
        setSshInspectionError('')
        setSshInspectionBusy(false)
        setRelatedKeyPairs([])
        setRelatedKeyPairsError('')
        setRelatedKeyPairsBusy(false)
        return
      }

      setSshInspectionBusy(true)
      setSshInspectionError('')
      try {
        const inspection = await inspectVaultSshKey(selectedEntry.id)
        if (!cancelled) {
          setSshInspection(inspection)
        }
      } catch (error) {
        if (!cancelled) {
          setSshInspection(null)
          setSshInspectionError(error instanceof Error ? error.message : 'Failed to inspect the selected key.')
        }
      } finally {
        if (!cancelled) {
          setSshInspectionBusy(false)
        }
      }

      if (!lookupConnection) {
        if (!cancelled) {
          setRelatedKeyPairs([])
          setRelatedKeyPairsError('')
          setRelatedKeyPairsBusy(false)
        }
        return
      }

      setRelatedKeyPairsBusy(true)
      setRelatedKeyPairsError('')
      try {
        const keyPairs = await listKeyPairs(lookupConnection)
        if (!cancelled) {
          setRelatedKeyPairs(keyPairs)
        }
      } catch (error) {
        if (!cancelled) {
          setRelatedKeyPairs([])
          setRelatedKeyPairsError(error instanceof Error ? error.message : 'Failed to load EC2 key pairs for this context.')
        }
      } finally {
        if (!cancelled) {
          setRelatedKeyPairsBusy(false)
        }
      }
    }

    void hydrateSshInspection()

    return () => {
      cancelled = true
    }
  }, [lookupConnection, selectedEntry])

  async function hydrateEntries(preferredSelectionId?: string): Promise<void> {
    setInventoryBusy(true)
    setErrorMessage('')

    try {
      const entries = await listVaultEntries()
      setAllEntries(entries)

      const nextSelectionId = preferredSelectionId && entries.some((entry) => entry.id === preferredSelectionId)
        ? preferredSelectionId
        : entries[0]?.id ?? ''
      setSelectedEntryId(nextSelectionId)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load vault entries.')
    } finally {
      setInventoryBusy(false)
    }
  }

  function resetDraft(mode: DraftMode, options?: { clearFeedback?: boolean }): void {
    setDraftMode(mode)
    setDraft(createDraft(mode))
    setImportSelection(null)
    if (options?.clearFeedback !== false) {
      setStatusMessage('')
      setErrorMessage('')
    }
  }

  async function handleSaveDraft(): Promise<void> {
    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')

    try {
      const saved = await saveVaultEntry(buildCreatePayload(draft))
      setStatusMessage(`${draftMode === 'import' ? 'Imported' : 'Saved'} vault entry: ${saved.name}`)
      await hydrateEntries(saved.id)
      resetDraft(draftMode, { clearFeedback: false })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save vault entry.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handlePickImportFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')

    try {
      const content = await file.text()
      const selected = {
        fileName: file.name,
        content,
        suggestedKind: inferImportKind(file.name, content)
      }

      setImportSelection(selected)
      setDraftMode('import')
      setDraft({
        ...createDraft('import'),
        kind: selected.suggestedKind,
        rotationState: defaultRotationState(selected.suggestedKind),
        name: selected.fileName,
        secret: selected.content
      })
      setStatusMessage(`Selected import file: ${selected.fileName}`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to choose import file.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleImportSelection(): Promise<void> {
    if (!importSelection) {
      setErrorMessage('Choose a file to import first.')
      return
    }

    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')

    try {
      const saved = await saveVaultEntry({
        kind: draft.kind,
        name: draft.name,
        secret: importSelection.content,
        origin: draft.origin,
        rotationState: draft.rotationState,
        rotationUpdatedAt: draft.rotationUpdatedAt,
        reminderAt: draft.reminderAt,
        expiryAt: draft.expiryAt,
        metadata: {
          fileName: importSelection.fileName
        }
      })
      setStatusMessage(`Imported vault entry: ${saved.name}`)
      await hydrateEntries(saved.id)
      resetDraft('import', { clearFeedback: false })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to import vault entry.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleRevealSecret(entry: VaultEntrySummary): Promise<void> {
    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')

    try {
      if (revealedEntryId === entry.id && revealedSecret) {
        setRevealedEntryId('')
        setRevealedSecret('')
        return
      }

      const secret = await revealVaultEntrySecret(entry.id)
      setRevealedEntryId(entry.id)
      setRevealedSecret(secret)
      setStatusMessage(`Secret revealed for ${entry.name}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to reveal secret.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleCopySecret(entry: VaultEntrySummary): Promise<void> {
    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')

    try {
      const secret = await revealVaultEntrySecret(entry.id)
      await navigator.clipboard.writeText(secret)
      setStatusMessage(`Secret copied for ${entry.name}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to copy secret.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleDeleteEntry(entry: VaultEntrySummary): Promise<void> {
    const confirmed = window.confirm(`Delete vault entry "${entry.name}"?`)
    if (!confirmed) {
      return
    }

    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')

    try {
      await deleteVaultEntry(entry.id)
      setRevealedEntryId('')
      setRevealedSecret('')
      setStatusMessage(`Deleted vault entry: ${entry.name}`)
      await hydrateEntries(entry.id === selectedEntryId ? '' : selectedEntryId)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to delete vault entry.')
    } finally {
      setActionBusy(false)
    }
  }

  function updateDraftKind(nextKind: VaultEntryKind): void {
    setDraft((current) => ({
      ...current,
      kind: nextKind,
      rotationState: defaultRotationState(nextKind)
    }))
  }

  const typeSummaryChips = allEntries.length > 0
    ? [
        `Total ${countsByKind.total}`,
        `AWS ${countsByKind['aws-profile']}`,
        `DB ${countsByKind['db-credential']}`,
        `API ${countsByKind['api-token']}`,
        `Kube ${countsByKind['kubeconfig-fragment']}`,
        `SSH ${countsByKind['ssh-key']}`,
        `PEM ${countsByKind.pem}`,
        `Keys ${countsByKind['access-key']}`
      ]
    : [
        `Total ${securitySummary?.vaultEntryCounts.all ?? 0}`,
        `AWS ${securitySummary?.vaultEntryCounts.awsProfiles ?? 0}`,
        `SSH ${securitySummary?.vaultEntryCounts.sshKeys ?? 0}`,
        `PEM ${securitySummary?.vaultEntryCounts.pem ?? 0}`,
        `Keys ${securitySummary?.vaultEntryCounts.accessKeys ?? 0}`
      ]

  const lifecycleSummaryChips = [
    `Due ${rotationSummary.due}`,
    `Expired ${rotationSummary.expired}`,
    `Recent use ${rotationSummary.recentlyUsed}`,
    `${visibleEntries.length} visible`
  ]

  return (
    <div className="vault-manager">
      <div className="vault-manager-summary">
        <div className="vault-manager-summary__group">
          <div className="vault-manager-summary__label">Types</div>
          <div className="settings-security-inline">
            {typeSummaryChips.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        </div>
        <div className="vault-manager-summary__group">
          <div className="vault-manager-summary__label">Lifecycle</div>
          <div className="settings-security-inline">
            {lifecycleSummaryChips.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="vault-manager-toolbar">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search names, metadata, source, or origin"
        />
        <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as VaultKindFilter)}>
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <button type="button" onClick={() => void hydrateEntries(selectedEntryId)} disabled={inventoryBusy}>
          {inventoryBusy ? 'Refreshing...' : 'Refresh'}
        </button>
        <button type="button" onClick={() => resetDraft('create')} disabled={actionBusy}>
          New entry
        </button>
        <button type="button" onClick={() => resetDraft('import')} disabled={actionBusy}>
          Import
        </button>
      </div>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}
      {!errorMessage && statusMessage && <div className="success-banner">{statusMessage}</div>}

      <div className="vault-manager-shell">
        <div className="vault-manager-list">
          <div className="vault-manager-pane__title">Inventory</div>
          <div className="vault-manager-list__items">
            {visibleEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`vault-manager-entry ${selectedEntryId === entry.id ? 'active' : ''}`}
                onClick={() => setSelectedEntryId(entry.id)}
              >
                <div>
                  <strong>{entry.name}</strong>
                  <div className="vault-manager-entry__meta">
                    <span>{KIND_LABELS[entry.kind]}</span>
                    <span>{ORIGIN_LABELS[entry.origin]}</span>
                  </div>
                </div>
                <span>{formatListTimestamp(entry)}</span>
              </button>
            ))}
            {!inventoryBusy && visibleEntries.length === 0 && (
              <div className="vault-manager-empty">
                <strong>No vault entries match this filter.</strong>
                <span>Adjust the search or create/import a new entry.</span>
              </div>
            )}
            {inventoryBusy && (
              <div className="vault-manager-empty">
                <strong>Loading vault inventory</strong>
                <span>Encrypted entries are being refreshed from local storage.</span>
              </div>
            )}
          </div>
        </div>

        <div className="vault-manager-detail">
          <div className="vault-manager-pane__title">Detail</div>
          {selectedEntry ? (
            <div className="vault-manager-card vault-manager-card-detail">
              <div className="vault-manager-card__header">
                <div>
                  <h3>{selectedEntry.name}</h3>
                  <p>{KIND_LABELS[selectedEntry.kind]} | {ORIGIN_LABELS[selectedEntry.origin]}</p>
                </div>
                <div className="settings-inline-actions">
                  <button type="button" onClick={() => void handleRevealSecret(selectedEntry)} disabled={actionBusy}>
                    {revealedEntryId === selectedEntry.id && revealedSecret ? 'Hide secret' : 'Reveal secret'}
                  </button>
                  <button type="button" onClick={() => void handleCopySecret(selectedEntry)} disabled={actionBusy}>
                    Copy secret
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteEntry(selectedEntry)}
                    disabled={actionBusy || accessMode !== 'operator'}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="vault-manager-detail-grid">
                <div className="vault-manager-stat">
                  <span>Rotation state</span>
                  <strong>{ROTATION_LABELS[selectedEntry.rotationState]}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Rotation updated</span>
                  <strong>{formatTimestamp(selectedEntry.rotationUpdatedAt)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Created</span>
                  <strong>{formatTimestamp(selectedEntry.createdAt)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Updated</span>
                  <strong>{formatTimestamp(selectedEntry.updatedAt)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Reminder</span>
                  <strong>{describeReminderStatus(selectedEntry)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Expiry</span>
                  <strong>{describeExpiryStatus(selectedEntry)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Last used</span>
                  <strong>{formatTimestamp(selectedEntry.lastUsedAt)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Usage status</span>
                  <strong>{describeUsageStatus(selectedEntry)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Usage context</span>
                  <strong>{describeUsage(selectedEntry)}</strong>
                </div>
              </div>

              {revealedEntryId === selectedEntry.id && revealedSecret && (
                <div className="vault-manager-secret">
                  <div className="vault-manager-pane__subtitle">Revealed secret</div>
                  <pre>{revealedSecret}</pre>
                </div>
              )}

              {isSshVaultEntry(selectedEntry) && (
                <div className="vault-manager-metadata">
                  <div className="vault-manager-pane__subtitle">Fingerprint verification</div>
                  {sshInspectionBusy ? (
                    <div className="settings-static-muted">Inspecting SSH key material and public fingerprint data.</div>
                  ) : sshInspectionError ? (
                    <div className="settings-static-muted">{sshInspectionError}</div>
                  ) : sshInspection ? (
                    <>
                      <div className="vault-manager-metadata__list">
                        <div className="vault-manager-metadata__row">
                          <span>Verification status</span>
                          <strong>
                            {relatedKeyPairSummary.fingerprintMatches.length > 0
                              ? `Verified against ${relatedKeyPairSummary.fingerprintMatches.length} EC2 key pair`
                              : sshInspection.publicKeyAvailable
                                ? 'No matching EC2 fingerprint yet'
                                : 'Public key unavailable'}
                          </strong>
                        </div>
                        <div className="vault-manager-metadata__row">
                          <span>SHA256 fingerprint</span>
                          <strong>{sshInspection.fingerprintSha256 || '-'}</strong>
                        </div>
                        <div className="vault-manager-metadata__row">
                          <span>MD5 fingerprint</span>
                          <strong>{sshInspection.fingerprintMd5 || '-'}</strong>
                        </div>
                        <div className="vault-manager-metadata__row">
                          <span>Public key source</span>
                          <strong>{describeInspectionSource(sshInspection.publicKeySource)}</strong>
                        </div>
                        <div className="vault-manager-metadata__row">
                          <span>Key pair name hints</span>
                          <strong>{sshInspection.keyNameHints.join(', ') || '-'}</strong>
                        </div>
                        <div className="vault-manager-metadata__row">
                          <span>Lookup context</span>
                          <strong>
                            {lookupConnection
                              ? `${lookupConnection.profile} | ${lookupConnection.region}`
                              : 'No AWS profile/region context recorded yet'}
                          </strong>
                        </div>
                      </div>

                      <div className="vault-manager-related-pairs">
                        <div className="vault-manager-pane__subtitle">Related EC2 key pairs</div>
                        {relatedKeyPairsBusy ? (
                          <div className="settings-static-muted">Loading EC2 key pairs for the last used profile and region.</div>
                        ) : relatedKeyPairsError ? (
                          <div className="settings-static-muted">{relatedKeyPairsError}</div>
                        ) : !lookupConnection ? (
                          <div className="settings-static-muted">Use this key in an EC2 workflow once to capture profile/region context for live key pair matching.</div>
                        ) : relatedKeyPairSummary.fingerprintMatches.length === 0 && relatedKeyPairSummary.nameMatches.length === 0 ? (
                          <div className="settings-static-muted">No EC2 key pairs in the last used context matched this key by fingerprint or normalized name.</div>
                        ) : (
                          <>
                            {relatedKeyPairSummary.fingerprintMatches.map((pair) => (
                              <div key={`fingerprint:${pair.keyPairId || pair.keyName}`} className="vault-manager-related-pair">
                                <strong>{pair.keyName}</strong>
                                <div className="vault-manager-related-pair__meta">
                                  <span>Fingerprint verified</span>
                                  <span>{pair.keyPairId || 'No key pair ID'}</span>
                                  <span>{pair.keyType || 'Unknown type'}</span>
                                  <span>{pair.fingerprint || 'No fingerprint'}</span>
                                </div>
                              </div>
                            ))}
                            {relatedKeyPairSummary.nameMatches.map((pair) => (
                              <div key={`name:${pair.keyPairId || pair.keyName}`} className="vault-manager-related-pair">
                                <strong>{pair.keyName}</strong>
                                <div className="vault-manager-related-pair__meta">
                                  <span>Name match only</span>
                                  <span>{pair.keyPairId || 'No key pair ID'}</span>
                                  <span>{pair.keyType || 'Unknown type'}</span>
                                  <span>{pair.fingerprint || 'No fingerprint'}</span>
                                </div>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="settings-static-muted">No fingerprint details available for this key yet.</div>
                  )}
                </div>
              )}

              <div className="vault-manager-metadata">
                <div className="vault-manager-pane__subtitle">Metadata and dependencies</div>
                {Object.keys(selectedEntry.metadata).length > 0 ? (
                  <div className="vault-manager-metadata__list">
                    {Object.entries(selectedEntry.metadata).map(([key, value]) => (
                      <div key={key} className="vault-manager-metadata__row">
                        <span>{key}</span>
                        <strong>{value || '-'}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="settings-static-muted">No dependency or metadata fields are stored for this entry.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="vault-manager-card vault-manager-card-empty">
              <strong>No vault entry selected.</strong>
              <span>Select an entry from the inventory to inspect it.</span>
            </div>
          )}

          <div className="vault-manager-card">
            <div className="vault-manager-card__header">
              <div>
                <h3>{draftMode === 'import' ? 'Import vault entry' : 'Create vault entry'}</h3>
                <p>{draftMode === 'import'
                  ? 'Choose a file and import its contents directly into the encrypted local vault.'
                  : 'Add a new secret directly to the encrypted local vault.'}</p>
              </div>
              <div className="settings-static-value">{accessMode === 'operator' ? 'Operator' : 'Read-only'}</div>
            </div>

            <div className="vault-manager-mode-toggle">
              <button
                type="button"
                className={draftMode === 'create' ? 'accent' : ''}
                onClick={() => resetDraft('create')}
                disabled={actionBusy}
              >
                Create
              </button>
              <button
                type="button"
                className={draftMode === 'import' ? 'accent' : ''}
                onClick={() => resetDraft('import')}
                disabled={actionBusy}
              >
                Import
              </button>
            </div>

            {draftMode === 'create' ? (
              <>
                <div className="vault-manager-form vault-manager-form-simple">
                  <label className="vault-manager-form__field">
                    <span>Kind</span>
                    <select value={draft.kind} onChange={(event) => updateDraftKind(event.target.value as VaultEntryKind)}>
                      {KIND_OPTIONS.filter((option) => option.value !== 'all').map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Origin</span>
                    <select value={draft.origin} onChange={(event) => setDraft((current) => ({ ...current, origin: event.target.value as VaultOrigin }))}>
                      {ORIGIN_OPTIONS.map((origin) => (
                        <option key={origin} value={origin}>{ORIGIN_LABELS[origin]}</option>
                      ))}
                    </select>
                  </label>
                  <div className="settings-static-muted vault-manager-form__field-span-2">{KIND_DESCRIPTIONS[draft.kind]}</div>
                  <div className="settings-static-muted vault-manager-form__field-span-2">{describeOriginSelection(draft.origin)}</div>
                  <label className="vault-manager-form__field">
                    <span>Rotation state</span>
                    <select value={draft.rotationState} onChange={(event) => setDraft((current) => ({ ...current, rotationState: event.target.value as VaultRotationState }))}>
                      {Object.entries(ROTATION_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Rotation updated</span>
                    <input
                      type="datetime-local"
                      value={formatDateTimeInput(draft.rotationUpdatedAt)}
                      onChange={(event) => setDraft((current) => ({ ...current, rotationUpdatedAt: normalizeDateTimeInput(event.target.value) }))}
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Reminder at</span>
                    <input
                      type="datetime-local"
                      value={formatDateTimeInput(draft.reminderAt)}
                      onChange={(event) => setDraft((current) => ({ ...current, reminderAt: normalizeDateTimeInput(event.target.value) }))}
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Expiry at</span>
                    <input
                      type="datetime-local"
                      value={formatDateTimeInput(draft.expiryAt)}
                      onChange={(event) => setDraft((current) => ({ ...current, expiryAt: normalizeDateTimeInput(event.target.value) }))}
                    />
                  </label>

                  {draft.kind === 'aws-profile' ? (
                    <>
                      <label className="vault-manager-form__field">
                        <span>Name</span>
                        <input
                          value={draft.name}
                          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                          placeholder="prod-admin or audit-readonly"
                        />
                      </label>
                      <label className="vault-manager-form__field">
                        <span>Access key ID</span>
                        <input
                          value={draft.accessKeyId}
                          onChange={(event) => setDraft((current) => ({ ...current, accessKeyId: event.target.value }))}
                          placeholder="AKIA..."
                        />
                      </label>
                      <label className="vault-manager-form__field vault-manager-form__field-span-2">
                        <span>Secret access key</span>
                        <input
                          type="password"
                          value={draft.secretAccessKey}
                          onChange={(event) => setDraft((current) => ({ ...current, secretAccessKey: event.target.value }))}
                          placeholder="Paste the AWS secret access key"
                        />
                      </label>
                    </>
                  ) : draft.kind === 'db-credential' ? (
                    <>
                      <label className="vault-manager-form__field">
                        <span>Name</span>
                        <input
                          value={draft.name}
                          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                          placeholder="orders-prod-admin"
                        />
                      </label>
                      <label className="vault-manager-form__field">
                        <span>Engine</span>
                        <select value={draft.dbEngine} onChange={(event) => setDraft((current) => ({ ...current, dbEngine: event.target.value as DbConnectionEngine }))}>
                          {DB_ENGINE_OPTIONS.map((engine) => (
                            <option key={engine} value={engine}>{normalizeDbEngineLabel(engine)}</option>
                          ))}
                        </select>
                      </label>
                      <label className="vault-manager-form__field">
                        <span>Username hint</span>
                        <input
                          value={draft.usernameHint}
                          onChange={(event) => setDraft((current) => ({ ...current, usernameHint: event.target.value }))}
                          placeholder="db_admin"
                        />
                      </label>
                      <label className="vault-manager-form__field">
                        <span>Password</span>
                        <input
                          type="password"
                          value={draft.secret}
                          onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))}
                          placeholder="Paste the database password"
                        />
                      </label>
                      <label className="vault-manager-form__field vault-manager-form__field-span-2">
                        <span>Notes</span>
                        <input
                          value={draft.notes}
                          onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                          placeholder="Optional connection or owner note"
                        />
                      </label>
                    </>
                  ) : draft.kind === 'api-token' ? (
                    <>
                      <label className="vault-manager-form__field">
                        <span>Name</span>
                        <input
                          value={draft.name}
                          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                          placeholder="grafana-cloud-api"
                        />
                      </label>
                      <label className="vault-manager-form__field">
                        <span>Service</span>
                        <input
                          value={draft.service}
                          onChange={(event) => setDraft((current) => ({ ...current, service: event.target.value }))}
                          placeholder="Grafana Cloud"
                        />
                      </label>
                      <label className="vault-manager-form__field vault-manager-form__field-span-2">
                        <span>{getSecretFieldLabel(draft.kind)}</span>
                        <input
                          type="password"
                          value={draft.secret}
                          onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))}
                          placeholder={getSecretPlaceholder(draft.kind)}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="vault-manager-form__field">
                        <span>Name</span>
                        <input
                          value={draft.name}
                          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                          placeholder="human-readable entry name"
                        />
                      </label>
                      <label className="vault-manager-form__field vault-manager-form__field-span-2">
                        <span>{getSecretFieldLabel(draft.kind)}</span>
                        <textarea
                          value={draft.secret}
                          onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))}
                          placeholder={getSecretPlaceholder(draft.kind)}
                        />
                      </label>
                    </>
                  )}
                </div>

                <div className="settings-inline-actions">
                  <button type="button" onClick={() => resetDraft('create')} disabled={actionBusy}>
                    Reset
                  </button>
                  <button
                    type="button"
                    className="accent"
                    onClick={() => void handleSaveDraft()}
                    disabled={actionBusy || accessMode !== 'operator'}
                  >
                    Save entry
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="vault-manager-form vault-manager-form-simple">
                  <label className="vault-manager-form__field vault-manager-form__field-span-2">
                    <span>Import file</span>
                    <div className="vault-manager-import-row">
                      <input
                        value={importSelection?.fileName ?? ''}
                        placeholder="Choose a PEM, key, JSON, or text secret file"
                        readOnly
                      />
                      <button type="button" onClick={() => importInputRef.current?.click()} disabled={actionBusy}>
                        Browse
                      </button>
                    </div>
                    <input
                      ref={importInputRef}
                      type="file"
                      className="vault-manager-file-input"
                      accept=".pem,.ppk,.key,.json,.txt,.env,.config"
                      onChange={(event) => void handlePickImportFile(event)}
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Kind</span>
                    <select value={draft.kind} onChange={(event) => updateDraftKind(event.target.value as VaultEntryKind)}>
                      {KIND_OPTIONS.filter((option) => option.value !== 'all').map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Origin</span>
                    <select value={draft.origin} onChange={(event) => setDraft((current) => ({ ...current, origin: event.target.value as VaultOrigin }))}>
                      {ORIGIN_OPTIONS.map((origin) => (
                        <option key={origin} value={origin}>{ORIGIN_LABELS[origin]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Rotation state</span>
                    <select value={draft.rotationState} onChange={(event) => setDraft((current) => ({ ...current, rotationState: event.target.value as VaultRotationState }))}>
                      {Object.entries(ROTATION_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Name</span>
                    <input
                      value={draft.name}
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="vault entry name"
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Reminder at</span>
                    <input
                      type="datetime-local"
                      value={formatDateTimeInput(draft.reminderAt)}
                      onChange={(event) => setDraft((current) => ({ ...current, reminderAt: normalizeDateTimeInput(event.target.value) }))}
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Expiry at</span>
                    <input
                      type="datetime-local"
                      value={formatDateTimeInput(draft.expiryAt)}
                      onChange={(event) => setDraft((current) => ({ ...current, expiryAt: normalizeDateTimeInput(event.target.value) }))}
                    />
                  </label>
                  <div className="settings-static-muted vault-manager-form__field-span-2">{describeOriginSelection(draft.origin)}</div>
                </div>

                {importSelection && (
                  <div className="vault-manager-import-summary">
                    <span>{importSelection.fileName}</span>
                    <strong>{KIND_LABELS[draft.kind]}</strong>
                  </div>
                )}

                <div className="settings-inline-actions">
                  <button type="button" onClick={() => resetDraft('import')} disabled={actionBusy}>
                    Clear
                  </button>
                  <button
                    type="button"
                    className="accent"
                    onClick={() => void handleImportSelection()}
                    disabled={actionBusy || accessMode !== 'operator' || !importSelection}
                  >
                    Import entry
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
