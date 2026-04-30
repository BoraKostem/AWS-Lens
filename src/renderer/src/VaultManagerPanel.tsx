import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import type {
  AppSecuritySummary,
  AzureServicePrincipalCertPayload,
  AzureServicePrincipalSecretPayload,
  CloudProviderId,
  EnterpriseAccessMode,
  MaterializedVaultEntryHandle,
  ProviderApiTokenPayload,
  SecretManagerReferencePayload,
  VaultApiTokenProvider,
  VaultEntryInput,
  VaultEntryKind,
  VaultEntrySummary,
  VaultOrigin,
  VaultRotationState,
  VaultSecretReferenceProvider,
  VaultValidationResult
} from '@shared/types'
import {
  deleteVaultEntry,
  disposeMaterializedVaultEntry,
  getActiveVaultCredential,
  invalidatePageCache,
  listActiveVaultCredentials,
  listVaultEntries,
  materializeVaultEntry,
  revealVaultEntrySecret,
  saveVaultEntry,
  setActiveVaultCredential,
  validateVaultEntry
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
  name: string
  secret: string
  // GCP file import (service account / workload identity)
  jsonText: string
  fileName: string
  jsonProjectIdPreview: string
  jsonClientEmailPreview: string
  jsonAudiencePreview: string
  // Azure SP
  tenantId: string
  clientId: string
  subscriptionId: string
  clientSecret: string
  certificatePem: string
  privateKeyPem: string
  certThumbprintPreview: string
  certNotAfterPreview: string
  expiryAt: string
  notes: string
  // Provider API token
  apiTokenProvider: VaultApiTokenProvider
  apiToken: string
  scope: string
  baseUrl: string
  // Secret manager reference
  secretRefProvider: VaultSecretReferenceProvider
  secretRefUri: string
  description: string
  useLocalFallback: boolean
  localFallback: string
  // SSH provider scope (Step 7 hooks already laid out)
  sshCloudProvider: '' | CloudProviderId
  gcpProjectId: string
  gcpInstanceName: string
  azureSubscriptionId: string
  azureResourceGroup: string
  azureVmName: string
  linuxUsername: string
}

type ImportSelection = {
  fileName: string
  content: string
  suggestedKind: VaultEntryKind
}

const KIND_LABELS: Record<VaultEntryKind, string> = {
  'aws-profile': 'AWS profile',
  'ssh-key': 'SSH key',
  pem: 'PEM',
  'access-key': 'Access key',
  generic: 'Generic secret',
  'db-credential': 'DB credential',
  'kubeconfig-fragment': 'Kubeconfig fragment',
  'api-token': 'API token',
  'connection-secret': 'Connection secret',
  'gcp-service-account-key': 'GCP service account key',
  'gcp-workload-identity': 'GCP workload identity',
  'azure-service-principal-secret': 'Azure SP (secret)',
  'azure-service-principal-cert': 'Azure SP (certificate)',
  'provider-api-token': 'Provider API token',
  'secret-manager-reference': 'Secret manager reference'
}

const ORIGIN_LABELS: Record<VaultOrigin, string> = {
  manual: 'Manual',
  imported: 'Imported',
  'imported-file': 'Imported',
  'aws-secrets-manager': 'Secrets Manager',
  'aws-ssm': 'SSM',
  'aws-iam': 'IAM',
  'gcp-iam-key': 'GCP IAM key',
  'gcp-secret-manager': 'GCP Secret Manager',
  'azure-app-registration': 'Azure App registration',
  'azure-key-vault': 'Azure Key Vault',
  generated: 'Generated',
  unknown: 'Unknown'
}

const ROTATION_LABELS: Record<VaultRotationState, string> = {
  unknown: 'Unknown',
  'not-applicable': 'Not applicable',
  tracked: 'Tracked',
  'rotation-due': 'Rotation due',
  rotated: 'Rotated'
}

const KIND_GROUPS: Array<{
  label: string
  kinds: VaultEntryKind[]
}> = [
  {
    label: 'Cloud',
    kinds: [
      'aws-profile',
      'gcp-service-account-key',
      'gcp-workload-identity',
      'azure-service-principal-secret',
      'azure-service-principal-cert'
    ]
  },
  {
    label: 'Operational',
    kinds: ['ssh-key', 'pem', 'access-key', 'generic']
  },
  {
    label: 'Service',
    kinds: [
      'db-credential',
      'kubeconfig-fragment',
      'api-token',
      'connection-secret',
      'provider-api-token',
      'secret-manager-reference'
    ]
  }
]

const KIND_PROVIDER: Partial<Record<VaultEntryKind, CloudProviderId>> = {
  'aws-profile': 'aws',
  'gcp-service-account-key': 'gcp',
  'gcp-workload-identity': 'gcp',
  'azure-service-principal-secret': 'azure',
  'azure-service-principal-cert': 'azure'
}

const PROVIDER_ICON: Record<CloudProviderId, string> = {
  aws: 'AWS',
  gcp: 'GCP',
  azure: 'AZ'
}

const API_TOKEN_PROVIDERS: Array<{ value: VaultApiTokenProvider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'vertex-ai', label: 'Vertex AI' },
  { value: 'bedrock', label: 'AWS Bedrock' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'other', label: 'Other' }
]

const SECRET_REF_PROVIDERS: Array<{ value: VaultSecretReferenceProvider; label: string }> = [
  { value: 'gcp-secret-manager', label: 'GCP Secret Manager' },
  { value: 'azure-key-vault', label: 'Azure Key Vault' }
]

const ROTATION_DUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value.trim())
}

function emptyDraft(kind: VaultEntryKind): VaultDraft {
  return {
    kind,
    name: '',
    secret: '',
    jsonText: '',
    fileName: '',
    jsonProjectIdPreview: '',
    jsonClientEmailPreview: '',
    jsonAudiencePreview: '',
    tenantId: '',
    clientId: '',
    subscriptionId: '',
    clientSecret: '',
    certificatePem: '',
    privateKeyPem: '',
    certThumbprintPreview: '',
    certNotAfterPreview: '',
    expiryAt: '',
    notes: '',
    apiTokenProvider: 'openai',
    apiToken: '',
    scope: '',
    baseUrl: '',
    secretRefProvider: 'gcp-secret-manager',
    secretRefUri: '',
    description: '',
    useLocalFallback: false,
    localFallback: '',
    sshCloudProvider: '',
    gcpProjectId: '',
    gcpInstanceName: '',
    azureSubscriptionId: '',
    azureResourceGroup: '',
    azureVmName: '',
    linuxUsername: ''
  }
}

function createDraft(mode: DraftMode): VaultDraft {
  return emptyDraft(mode === 'import' ? 'connection-secret' : 'generic')
}

function inferImportKind(fileName: string): VaultEntryKind {
  const normalized = fileName.trim().toLowerCase()

  if (normalized.endsWith('.pem')) return 'pem'
  if (normalized.endsWith('.ppk') || normalized.endsWith('.key')) return 'ssh-key'
  if (normalized.endsWith('.json')) return 'connection-secret'
  if (normalized.includes('kube')) return 'kubeconfig-fragment'

  return 'generic'
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

function isExpiringSoon(value: string): boolean {
  if (!value) {
    return false
  }
  const ts = new Date(value).getTime()
  if (Number.isNaN(ts)) {
    return false
  }
  const diff = ts - Date.now()
  return diff > 0 && diff <= ROTATION_DUE_WINDOW_MS
}

function formatListTimestamp(entry: VaultEntrySummary): string {
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

function buildPayloadForKind(
  draft: VaultDraft
): { secret: string; metadata?: Record<string, string>; rotationState?: VaultRotationState; expiryAt?: string } {
  switch (draft.kind) {
    case 'gcp-service-account-key':
    case 'gcp-workload-identity':
      // jsonText is the raw JSON; backend parses + validates.
      return { secret: draft.jsonText, rotationState: 'unknown' }

    case 'azure-service-principal-secret': {
      const payload: AzureServicePrincipalSecretPayload = {
        authMethod: 'client-secret',
        tenantId: draft.tenantId.trim(),
        clientId: draft.clientId.trim(),
        subscriptionId: draft.subscriptionId.trim(),
        clientSecret: draft.clientSecret,
        expiryAt: draft.expiryAt.trim() || undefined,
        notes: draft.notes.trim() || undefined
      }
      return { secret: JSON.stringify(payload), rotationState: 'unknown', expiryAt: payload.expiryAt }
    }

    case 'azure-service-principal-cert': {
      const payload: AzureServicePrincipalCertPayload = {
        authMethod: 'client-certificate',
        tenantId: draft.tenantId.trim(),
        clientId: draft.clientId.trim(),
        subscriptionId: draft.subscriptionId.trim(),
        certificatePem: draft.certificatePem,
        privateKeyPem: draft.privateKeyPem,
        notes: draft.notes.trim() || undefined
      }
      return { secret: JSON.stringify(payload), rotationState: 'unknown' }
    }

    case 'provider-api-token': {
      const payload: ProviderApiTokenPayload = {
        provider: draft.apiTokenProvider,
        token: draft.apiToken,
        scope: draft.scope.trim() || undefined,
        baseUrl: draft.baseUrl.trim() || undefined,
        expiryAt: draft.expiryAt.trim() || undefined,
        notes: draft.notes.trim() || undefined
      }
      return { secret: JSON.stringify(payload), rotationState: 'unknown', expiryAt: payload.expiryAt }
    }

    case 'secret-manager-reference': {
      const payload: SecretManagerReferencePayload = {
        provider: draft.secretRefProvider,
        uri: draft.secretRefUri.trim(),
        description: draft.description.trim() || undefined,
        localFallback: draft.useLocalFallback ? draft.localFallback : undefined
      }
      return { secret: JSON.stringify(payload), rotationState: 'not-applicable' }
    }

    case 'ssh-key': {
      const metadata: Record<string, string> = {}
      if (draft.sshCloudProvider) {
        metadata.cloudProvider = draft.sshCloudProvider
      }
      if (draft.sshCloudProvider === 'gcp') {
        if (draft.gcpProjectId.trim()) metadata.gcpProjectId = draft.gcpProjectId.trim()
        if (draft.gcpInstanceName.trim()) metadata.gcpInstanceName = draft.gcpInstanceName.trim()
        if (draft.linuxUsername.trim()) metadata.linuxUsername = draft.linuxUsername.trim()
      } else if (draft.sshCloudProvider === 'azure') {
        if (draft.azureSubscriptionId.trim()) metadata.azureSubscriptionId = draft.azureSubscriptionId.trim()
        if (draft.azureResourceGroup.trim()) metadata.azureResourceGroup = draft.azureResourceGroup.trim()
        if (draft.azureVmName.trim()) metadata.azureVmName = draft.azureVmName.trim()
        if (draft.linuxUsername.trim()) metadata.linuxUsername = draft.linuxUsername.trim()
      }
      return { secret: draft.secret, metadata, rotationState: 'not-applicable' }
    }

    case 'pem':
      return { secret: draft.secret, rotationState: 'not-applicable' }

    default:
      return { secret: draft.secret, rotationState: 'unknown' }
  }
}

function describeKindHint(kind: VaultEntryKind): string {
  switch (kind) {
    case 'gcp-service-account-key':
      return 'Choose a service-account JSON key (type: "service_account"). Project ID and client email are auto-extracted.'
    case 'gcp-workload-identity':
      return 'Choose an external-account JSON config (type: "external_account") for workload identity federation.'
    case 'azure-service-principal-secret':
      return 'Tenant, client, and subscription IDs must be UUIDs. Provide the client secret. Optional expiry helps surface rotation alerts.'
    case 'azure-service-principal-cert':
      return 'Provide tenant/client/subscription UUIDs and import the .pem certificate (cert + private key blocks).'
    case 'provider-api-token':
      return 'Pick a provider; scope and baseUrl are optional. Tokens are encrypted at rest.'
    case 'secret-manager-reference':
      return 'Reference an external Secret Manager / Key Vault URI. Optional local fallback works until remote resolution lands.'
    case 'ssh-key':
      return 'Optionally scope this SSH key to a cloud provider so VM workflows can pick it up automatically.'
    default:
      return 'Paste the secret value or JSON blob.'
  }
}

export function VaultManagerPanel({
  accessMode,
  active,
  securitySummary
}: VaultManagerPanelProps): JSX.Element {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const gcpJsonInputRef = useRef<HTMLInputElement | null>(null)
  const azureCertInputRef = useRef<HTMLInputElement | null>(null)
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
  const [validationByEntry, setValidationByEntry] = useState<Record<string, VaultValidationResult>>({})
  const [validationBusy, setValidationBusy] = useState(false)
  const [materializeBusy, setMaterializeBusy] = useState(false)
  const [materializedHandle, setMaterializedHandle] = useState<MaterializedVaultEntryHandle | null>(null)
  const [activeCredentials, setActiveCredentials] = useState<{ aws?: string; gcp?: string; azure?: string }>({})

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

  const countsByKind = useMemo(() => {
    const counts: { total: number } & Record<VaultEntryKind, number> = {
      total: allEntries.length,
      'aws-profile': 0,
      'ssh-key': 0,
      pem: 0,
      'access-key': 0,
      'db-credential': 0,
      'kubeconfig-fragment': 0,
      'api-token': 0,
      'connection-secret': 0,
      generic: 0,
      'gcp-service-account-key': 0,
      'gcp-workload-identity': 0,
      'azure-service-principal-secret': 0,
      'azure-service-principal-cert': 0,
      'provider-api-token': 0,
      'secret-manager-reference': 0
    }

    for (const entry of allEntries) {
      counts[entry.kind] += 1
    }

    return counts
  }, [allEntries])

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
    void hydrateActiveCredentials()
  }, [active])

  async function hydrateEntries(preferredSelectionId?: string): Promise<void> {
    setInventoryBusy(true)
    setErrorMessage('')

    try {
      invalidatePageCache('phase2-foundations')
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

  async function hydrateActiveCredentials(): Promise<void> {
    try {
      const next = await listActiveVaultCredentials()
      setActiveCredentials(next ?? {})
    } catch {
      setActiveCredentials({})
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

  function changeKind(nextKind: VaultEntryKind): void {
    // Preserve name across kind changes; clear other kind-specific fields.
    setDraft((current) => ({
      ...emptyDraft(nextKind),
      name: current.name
    }))
  }

  function validateDraft(): string | null {
    if (!draft.name.trim()) {
      return 'Name is required.'
    }
    switch (draft.kind) {
      case 'gcp-service-account-key':
      case 'gcp-workload-identity':
        if (!draft.jsonText.trim()) {
          return 'Choose a JSON file first.'
        }
        return null
      case 'azure-service-principal-secret':
        if (!isUuid(draft.tenantId)) return 'tenantId must be a UUID.'
        if (!isUuid(draft.clientId)) return 'clientId must be a UUID.'
        if (!isUuid(draft.subscriptionId)) return 'subscriptionId must be a UUID.'
        if (!draft.clientSecret.trim()) return 'clientSecret is required.'
        return null
      case 'azure-service-principal-cert':
        if (!isUuid(draft.tenantId)) return 'tenantId must be a UUID.'
        if (!isUuid(draft.clientId)) return 'clientId must be a UUID.'
        if (!isUuid(draft.subscriptionId)) return 'subscriptionId must be a UUID.'
        if (!draft.certificatePem.includes('BEGIN CERTIFICATE')) return 'Certificate PEM is required.'
        if (
          !draft.privateKeyPem.includes('BEGIN PRIVATE KEY') &&
          !draft.privateKeyPem.includes('BEGIN RSA PRIVATE KEY') &&
          !draft.privateKeyPem.includes('BEGIN EC PRIVATE KEY')
        ) {
          return 'Private key PEM is required.'
        }
        return null
      case 'provider-api-token':
        if (!draft.apiToken.trim()) return 'token is required.'
        return null
      case 'secret-manager-reference':
        if (!draft.secretRefUri.trim()) return 'URI is required.'
        return null
      default:
        if (!draft.secret.trim()) return 'Secret is required.'
        return null
    }
  }

  async function handleSaveDraft(): Promise<void> {
    const localError = validateDraft()
    if (localError) {
      setErrorMessage(localError)
      return
    }

    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')

    try {
      const built = buildPayloadForKind(draft)
      const payload: VaultEntryInput = {
        kind: draft.kind,
        name: draft.name.trim(),
        secret: built.secret,
        origin: 'manual',
        rotationState: built.rotationState ?? 'unknown',
        expiryAt: built.expiryAt,
        metadata: built.metadata
      }

      const saved = await saveVaultEntry(payload)
      setStatusMessage(`Saved vault entry: ${saved.name}`)
      await hydrateEntries(saved.id)
      resetDraft('create', { clearFeedback: false })
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
        suggestedKind: inferImportKind(file.name)
      }

      setImportSelection(selected)
      setDraftMode('import')
      setDraft({
        ...emptyDraft(selected.suggestedKind),
        name: selected.fileName,
        secret: selected.content,
        fileName: selected.fileName
      })
      setStatusMessage(`Selected import file: ${selected.fileName}`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to choose import file.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handlePickGcpJson(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')
    try {
      const text = await file.text()
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        throw new Error('GCP JSON file is not valid JSON.')
      }

      const fileType = typeof parsed.type === 'string' ? (parsed.type as string) : ''
      const expectedType = draft.kind === 'gcp-service-account-key' ? 'service_account' : 'external_account'
      if (fileType && fileType !== expectedType) {
        throw new Error(`Selected file has type "${fileType}" but ${KIND_LABELS[draft.kind]} expects "${expectedType}".`)
      }

      const projectId = typeof parsed.project_id === 'string' ? parsed.project_id : ''
      const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email : ''
      const audience = typeof parsed.audience === 'string' ? parsed.audience : ''

      const autoName =
        draft.kind === 'gcp-service-account-key'
          ? projectId && clientEmail
            ? `${projectId}-${clientEmail.split('@')[0]}`
            : file.name
          : audience
            ? `wif-${audience.split('/').pop() ?? 'config'}`
            : file.name

      setDraft((current) => ({
        ...current,
        jsonText: text,
        fileName: file.name,
        jsonProjectIdPreview: projectId,
        jsonClientEmailPreview: clientEmail,
        jsonAudiencePreview: audience,
        name: current.name.trim() || autoName
      }))
      setStatusMessage(`Loaded ${file.name}`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to read GCP JSON.')
    } finally {
      setActionBusy(false)
    }
  }

  async function handlePickAzureCert(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')
    try {
      const text = await file.text()
      if (!text.includes('BEGIN CERTIFICATE')) {
        throw new Error('Selected file does not contain a PEM certificate block.')
      }
      const certMatch = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
      const keyMatch = text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/)

      setDraft((current) => ({
        ...current,
        certificatePem: certMatch?.[0] ?? text,
        privateKeyPem: keyMatch?.[0] ?? current.privateKeyPem,
        fileName: file.name,
        certNotAfterPreview: '',
        certThumbprintPreview: ''
      }))
      setStatusMessage(`Loaded ${file.name}. notAfter and thumbprint will be auto-extracted on save.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to read certificate file.')
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
        origin: 'imported-file',
        rotationState: draft.kind === 'pem' || draft.kind === 'ssh-key' ? 'not-applicable' : 'unknown',
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

  async function handleValidate(entry: VaultEntrySummary): Promise<void> {
    setValidationBusy(true)
    setStatusMessage('')
    setErrorMessage('')
    try {
      const result = await validateVaultEntry(entry.id)
      setValidationByEntry((current) => ({ ...current, [entry.id]: result }))
      if (result.entry) {
        setAllEntries((current) => current.map((row) => (row.id === entry.id ? result.entry ?? row : row)))
      }
      setStatusMessage(result.ok ? `Validated ${entry.name}.` : `Validation failed for ${entry.name}.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Validation failed.')
    } finally {
      setValidationBusy(false)
    }
  }

  async function handleMaterialize(entry: VaultEntrySummary): Promise<void> {
    setMaterializeBusy(true)
    setStatusMessage('')
    setErrorMessage('')
    try {
      if (materializedHandle && materializedHandle.entryId === entry.id) {
        await disposeMaterializedVaultEntry(materializedHandle.disposeToken)
        setMaterializedHandle(null)
        setStatusMessage(`Materialization disposed for ${entry.name}.`)
        return
      }
      if (materializedHandle) {
        try {
          await disposeMaterializedVaultEntry(materializedHandle.disposeToken)
        } catch { /* swallow */ }
      }
      const handle = await materializeVaultEntry(entry.id)
      setMaterializedHandle(handle)
      setStatusMessage(`Materialized ${entry.name} for runtime.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Materialization failed.')
    } finally {
      setMaterializeBusy(false)
    }
  }

  async function handleToggleActiveCredential(entry: VaultEntrySummary): Promise<void> {
    const provider = KIND_PROVIDER[entry.kind]
    if (!provider) {
      return
    }
    setActionBusy(true)
    setStatusMessage('')
    setErrorMessage('')
    try {
      const isCurrent = activeCredentials[provider] === entry.id
      await setActiveVaultCredential(provider, isCurrent ? null : entry.id)
      const next = await listActiveVaultCredentials()
      setActiveCredentials(next ?? {})
      setStatusMessage(
        isCurrent
          ? `${PROVIDER_ICON[provider]} active credential cleared.`
          : `Set ${entry.name} as the active ${PROVIDER_ICON[provider]} credential.`
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to update active credential.')
    } finally {
      setActionBusy(false)
    }
  }

  const summaryChips = [
    `Total ${countsByKind.total}`,
    `AWS ${countsByKind['aws-profile']}`,
    `GCP ${countsByKind['gcp-service-account-key'] + countsByKind['gcp-workload-identity']}`,
    `Azure ${countsByKind['azure-service-principal-secret'] + countsByKind['azure-service-principal-cert']}`,
    `SSH ${countsByKind['ssh-key']}`,
    `API ${countsByKind['provider-api-token']}`,
    `Refs ${countsByKind['secret-manager-reference']}`
  ]
  if (allEntries.length === 0) {
    summaryChips.unshift(`Loaded ${securitySummary?.vaultEntryCounts.all ?? 0}`)
  }
  const expiringSoon = allEntries.filter((entry) => isExpiringSoon(entry.expiryAt)).length
  if (expiringSoon > 0) {
    summaryChips.push(`Expiring ${expiringSoon}`)
  }

  const lastValidation = selectedEntry ? validationByEntry[selectedEntry.id] : undefined
  const selectedEntryProvider = selectedEntry ? KIND_PROVIDER[selectedEntry.kind] : undefined
  const isSelectedActive =
    selectedEntry && selectedEntryProvider
      ? activeCredentials[selectedEntryProvider] === selectedEntry.id
      : false

  function renderKindSelect(value: VaultEntryKind, onChange: (next: VaultEntryKind) => void): JSX.Element {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value as VaultEntryKind)}>
        {KIND_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.kinds.map((kind) => (
              <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
            ))}
          </optgroup>
        ))}
      </select>
    )
  }

  function renderKindFilterSelect(): JSX.Element {
    return (
      <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as VaultKindFilter)}>
        <option value="all">All kinds</option>
        {KIND_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.kinds.map((kind) => (
              <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
            ))}
          </optgroup>
        ))}
      </select>
    )
  }

  function renderCreateForm(): JSX.Element {
    const hint = describeKindHint(draft.kind)

    return (
      <>
        <div className="vault-manager-form vault-manager-form-simple">
          <label className="vault-manager-form__field">
            <span>Kind</span>
            {renderKindSelect(draft.kind, changeKind)}
          </label>
          <label className="vault-manager-form__field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="human-readable entry name"
            />
          </label>

          {(draft.kind === 'gcp-service-account-key' || draft.kind === 'gcp-workload-identity') && (
            <>
              <label className="vault-manager-form__field vault-manager-form__field-span-2">
                <span>JSON file</span>
                <div className="vault-manager-import-row">
                  <input value={draft.fileName} placeholder="Choose a JSON key/config" readOnly />
                  <button type="button" onClick={() => gcpJsonInputRef.current?.click()} disabled={actionBusy}>
                    Browse
                  </button>
                </div>
                <input
                  ref={gcpJsonInputRef}
                  type="file"
                  className="vault-manager-file-input"
                  accept=".json"
                  onChange={(event) => void handlePickGcpJson(event)}
                />
              </label>
              {draft.kind === 'gcp-service-account-key' && (draft.jsonProjectIdPreview || draft.jsonClientEmailPreview) && (
                <div className="vault-manager-import-summary">
                  <span>project_id: {draft.jsonProjectIdPreview || '-'}</span>
                  <strong>{draft.jsonClientEmailPreview || '-'}</strong>
                </div>
              )}
              {draft.kind === 'gcp-workload-identity' && draft.jsonAudiencePreview && (
                <div className="vault-manager-import-summary">
                  <span>audience</span>
                  <strong>{draft.jsonAudiencePreview}</strong>
                </div>
              )}
            </>
          )}

          {(draft.kind === 'azure-service-principal-secret' || draft.kind === 'azure-service-principal-cert') && (
            <>
              <label className="vault-manager-form__field">
                <span>Tenant ID</span>
                <input
                  value={draft.tenantId}
                  onChange={(event) => setDraft((current) => ({ ...current, tenantId: event.target.value }))}
                  placeholder="00000000-0000-0000-0000-000000000000"
                />
              </label>
              <label className="vault-manager-form__field">
                <span>Client ID</span>
                <input
                  value={draft.clientId}
                  onChange={(event) => setDraft((current) => ({ ...current, clientId: event.target.value }))}
                  placeholder="UUID"
                />
              </label>
              <label className="vault-manager-form__field">
                <span>Subscription ID</span>
                <input
                  value={draft.subscriptionId}
                  onChange={(event) => setDraft((current) => ({ ...current, subscriptionId: event.target.value }))}
                  placeholder="UUID"
                />
              </label>
              {draft.kind === 'azure-service-principal-secret' ? (
                <>
                  <label className="vault-manager-form__field">
                    <span>Client secret</span>
                    <input
                      type="password"
                      value={draft.clientSecret}
                      onChange={(event) => setDraft((current) => ({ ...current, clientSecret: event.target.value }))}
                      placeholder="client secret value"
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Expires (ISO date, optional)</span>
                    <input
                      value={draft.expiryAt}
                      onChange={(event) => setDraft((current) => ({ ...current, expiryAt: event.target.value }))}
                      placeholder="2026-12-31T00:00:00Z"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="vault-manager-form__field vault-manager-form__field-span-2">
                    <span>Certificate (.pem with cert + key)</span>
                    <div className="vault-manager-import-row">
                      <input value={draft.fileName} placeholder="Choose a .pem file" readOnly />
                      <button type="button" onClick={() => azureCertInputRef.current?.click()} disabled={actionBusy}>
                        Browse
                      </button>
                    </div>
                    <input
                      ref={azureCertInputRef}
                      type="file"
                      className="vault-manager-file-input"
                      accept=".pem,.crt,.cert"
                      onChange={(event) => void handlePickAzureCert(event)}
                    />
                  </label>
                  <label className="vault-manager-form__field vault-manager-form__field-span-2">
                    <span>Certificate PEM</span>
                    <textarea
                      value={draft.certificatePem}
                      onChange={(event) => setDraft((current) => ({ ...current, certificatePem: event.target.value }))}
                      placeholder="-----BEGIN CERTIFICATE-----..."
                    />
                  </label>
                  <label className="vault-manager-form__field vault-manager-form__field-span-2">
                    <span>Private key PEM</span>
                    <textarea
                      value={draft.privateKeyPem}
                      onChange={(event) => setDraft((current) => ({ ...current, privateKeyPem: event.target.value }))}
                      placeholder="-----BEGIN PRIVATE KEY-----..."
                    />
                  </label>
                </>
              )}
              <label className="vault-manager-form__field vault-manager-form__field-span-2">
                <span>Notes</span>
                <input
                  value={draft.notes}
                  onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="optional"
                />
              </label>
            </>
          )}

          {draft.kind === 'provider-api-token' && (
            <>
              <label className="vault-manager-form__field">
                <span>Provider</span>
                <select
                  value={draft.apiTokenProvider}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, apiTokenProvider: event.target.value as VaultApiTokenProvider }))
                  }
                >
                  {API_TOKEN_PROVIDERS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="vault-manager-form__field">
                <span>Token</span>
                <input
                  type="password"
                  value={draft.apiToken}
                  onChange={(event) => setDraft((current) => ({ ...current, apiToken: event.target.value }))}
                  placeholder="API token"
                />
              </label>
              <label className="vault-manager-form__field">
                <span>Scope (optional)</span>
                <input
                  value={draft.scope}
                  onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))}
                  placeholder="e.g. read:repo"
                />
              </label>
              <label className="vault-manager-form__field">
                <span>Base URL (optional)</span>
                <input
                  value={draft.baseUrl}
                  onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="https://api.example.com"
                />
              </label>
              <label className="vault-manager-form__field">
                <span>Expires (optional)</span>
                <input
                  value={draft.expiryAt}
                  onChange={(event) => setDraft((current) => ({ ...current, expiryAt: event.target.value }))}
                  placeholder="ISO date"
                />
              </label>
            </>
          )}

          {draft.kind === 'secret-manager-reference' && (
            <>
              <label className="vault-manager-form__field">
                <span>Provider</span>
                <select
                  value={draft.secretRefProvider}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      secretRefProvider: event.target.value as VaultSecretReferenceProvider
                    }))
                  }
                >
                  {SECRET_REF_PROVIDERS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="vault-manager-form__field vault-manager-form__field-span-2">
                <span>URI</span>
                <input
                  value={draft.secretRefUri}
                  onChange={(event) => setDraft((current) => ({ ...current, secretRefUri: event.target.value }))}
                  placeholder={
                    draft.secretRefProvider === 'gcp-secret-manager'
                      ? 'gcp-secret-manager://projects/<id>/secrets/<name>'
                      : 'azure-key-vault://<vault-name>/secrets/<name>'
                  }
                />
              </label>
              <label className="vault-manager-form__field vault-manager-form__field-span-2">
                <span>Description (optional)</span>
                <input
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
              <label className="vault-manager-form__field vault-manager-form__field-span-2">
                <span>
                  <input
                    type="checkbox"
                    checked={draft.useLocalFallback}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, useLocalFallback: event.target.checked }))
                    }
                  />{' '}
                  Use local fallback (until remote resolution lands)
                </span>
                {draft.useLocalFallback && (
                  <textarea
                    value={draft.localFallback}
                    onChange={(event) => setDraft((current) => ({ ...current, localFallback: event.target.value }))}
                    placeholder="local fallback value"
                  />
                )}
              </label>
            </>
          )}

          {draft.kind === 'ssh-key' && (
            <>
              <label className="vault-manager-form__field vault-manager-form__field-span-2">
                <span>Private key (PEM/PPK)</span>
                <textarea
                  value={draft.secret}
                  onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                />
              </label>
              <label className="vault-manager-form__field">
                <span>Cloud provider scope</span>
                <select
                  value={draft.sshCloudProvider}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      sshCloudProvider: event.target.value as '' | CloudProviderId
                    }))
                  }
                >
                  <option value="">None</option>
                  <option value="aws">AWS</option>
                  <option value="gcp">GCP</option>
                  <option value="azure">Azure</option>
                </select>
              </label>
              <label className="vault-manager-form__field">
                <span>Linux username (optional)</span>
                <input
                  value={draft.linuxUsername}
                  onChange={(event) => setDraft((current) => ({ ...current, linuxUsername: event.target.value }))}
                  placeholder="ubuntu / azureuser"
                />
              </label>
              {draft.sshCloudProvider === 'gcp' && (
                <>
                  <label className="vault-manager-form__field">
                    <span>GCP project</span>
                    <input
                      value={draft.gcpProjectId}
                      onChange={(event) => setDraft((current) => ({ ...current, gcpProjectId: event.target.value }))}
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Instance name (optional)</span>
                    <input
                      value={draft.gcpInstanceName}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, gcpInstanceName: event.target.value }))
                      }
                    />
                  </label>
                </>
              )}
              {draft.sshCloudProvider === 'azure' && (
                <>
                  <label className="vault-manager-form__field">
                    <span>Subscription ID</span>
                    <input
                      value={draft.azureSubscriptionId}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, azureSubscriptionId: event.target.value }))
                      }
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Resource group</span>
                    <input
                      value={draft.azureResourceGroup}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, azureResourceGroup: event.target.value }))
                      }
                    />
                  </label>
                  <label className="vault-manager-form__field">
                    <span>VM name (optional)</span>
                    <input
                      value={draft.azureVmName}
                      onChange={(event) => setDraft((current) => ({ ...current, azureVmName: event.target.value }))}
                    />
                  </label>
                </>
              )}
            </>
          )}

          {(draft.kind === 'aws-profile' ||
            draft.kind === 'pem' ||
            draft.kind === 'access-key' ||
            draft.kind === 'generic' ||
            draft.kind === 'db-credential' ||
            draft.kind === 'kubeconfig-fragment' ||
            draft.kind === 'api-token' ||
            draft.kind === 'connection-secret') && (
            <label className="vault-manager-form__field vault-manager-form__field-span-2">
              <span>Secret</span>
              <textarea
                value={draft.secret}
                onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))}
                placeholder="Paste the secret value or JSON blob"
              />
            </label>
          )}
        </div>

        <div className="settings-static-muted">{hint}</div>

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
    )
  }

  return (
    <div className="vault-manager">
      <div className="settings-security-inline">
        {summaryChips.map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
        <span>{visibleEntries.length} visible</span>
      </div>

      <div className="vault-manager-toolbar">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search names, metadata, source, or origin"
        />
        {renderKindFilterSelect()}
        <button type="button" onClick={() => void hydrateEntries(selectedEntryId)} disabled={inventoryBusy}>
          {inventoryBusy ? 'Refreshing...' : 'Refresh'}
        </button>
        <button type="button" onClick={() => resetDraft('create')} disabled={actionBusy}>
          New entry
        </button>
        <button type="button" onClick={() => resetDraft('import')} disabled={actionBusy}>
          Import file
        </button>
      </div>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}
      {!errorMessage && statusMessage && <div className="success-banner">{statusMessage}</div>}

      <div className="vault-manager-shell">
        <div className="vault-manager-list">
          <div className="vault-manager-pane__title">Inventory</div>
          <div className="vault-manager-list__items">
            {visibleEntries.map((entry) => {
              const provider = KIND_PROVIDER[entry.kind]
              const expiringSoonChip = isExpiringSoon(entry.expiryAt)
              const isActive = provider ? activeCredentials[provider] === entry.id : false
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`vault-manager-entry ${selectedEntryId === entry.id ? 'active' : ''}`}
                  onClick={() => setSelectedEntryId(entry.id)}
                >
                  <div>
                    <strong>{entry.name}</strong>
                    <div className="vault-manager-entry__meta">
                      {provider && <span>{PROVIDER_ICON[provider]}</span>}
                      <span>{KIND_LABELS[entry.kind]}</span>
                      <span>{ORIGIN_LABELS[entry.origin]}</span>
                      {isActive && <span>active</span>}
                      {entry.rotationState === 'rotation-due' && <span>rotation due</span>}
                      {expiringSoonChip && <span>expiring soon</span>}
                    </div>
                  </div>
                  <span>{formatListTimestamp(entry)}</span>
                </button>
              )
            })}
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
            <div className="vault-manager-card">
              <div className="vault-manager-card__header">
                <div>
                  <h3>{selectedEntry.name}</h3>
                  <p>
                    {KIND_LABELS[selectedEntry.kind]} | {ORIGIN_LABELS[selectedEntry.origin]}
                    {selectedEntryProvider && ` | ${PROVIDER_ICON[selectedEntryProvider]}`}
                    {isSelectedActive && ' | active'}
                  </p>
                </div>
                <div className="settings-inline-actions">
                  <button type="button" onClick={() => void handleRevealSecret(selectedEntry)} disabled={actionBusy}>
                    {revealedEntryId === selectedEntry.id && revealedSecret ? 'Hide secret' : 'Reveal secret'}
                  </button>
                  <button type="button" onClick={() => void handleCopySecret(selectedEntry)} disabled={actionBusy}>
                    Copy secret
                  </button>
                  {selectedEntryProvider && (
                    <button
                      type="button"
                      onClick={() => void handleToggleActiveCredential(selectedEntry)}
                      disabled={actionBusy || accessMode !== 'operator'}
                    >
                      {isSelectedActive ? 'Clear active' : 'Set as active'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleValidate(selectedEntry)}
                    disabled={validationBusy}
                  >
                    {validationBusy ? 'Validating...' : 'Validate'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleMaterialize(selectedEntry)}
                    disabled={materializeBusy}
                  >
                    {materializeBusy
                      ? 'Materializing...'
                      : materializedHandle && materializedHandle.entryId === selectedEntry.id
                        ? 'Dispose runtime'
                        : 'Materialize for runtime'}
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
                  <span>Expires</span>
                  <strong>
                    {selectedEntry.expiryAt ? formatTimestamp(selectedEntry.expiryAt) : 'Not tracked'}
                    {isExpiringSoon(selectedEntry.expiryAt) ? ' — within 7 days' : ''}
                  </strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Last validated</span>
                  <strong>
                    {selectedEntry.metadata.lastValidatedAt
                      ? formatTimestamp(selectedEntry.metadata.lastValidatedAt)
                      : 'Never'}
                  </strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Last validation status</span>
                  <strong>
                    {selectedEntry.metadata.lastValidationStatus || '-'}
                    {selectedEntry.metadata.lastValidationMessage
                      ? ` — ${selectedEntry.metadata.lastValidationMessage}`
                      : ''}
                  </strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Cloud scope</span>
                  <strong>{selectedEntry.metadata.cloudProvider || '-'}</strong>
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
                  <span>Last used</span>
                  <strong>{formatTimestamp(selectedEntry.lastUsedAt)}</strong>
                </div>
                <div className="vault-manager-stat">
                  <span>Usage context</span>
                  <strong>{describeUsage(selectedEntry)}</strong>
                </div>
              </div>

              {lastValidation && (
                <div className={lastValidation.ok ? 'success-banner' : 'error-banner'}>
                  {lastValidation.ok ? 'Validated: ' : 'Validation failed: '}
                  {lastValidation.message}
                </div>
              )}

              {materializedHandle && materializedHandle.entryId === selectedEntry.id && (
                <div className="vault-manager-secret">
                  <div className="vault-manager-pane__subtitle">Runtime materialization (env keys only — values are masked)</div>
                  <pre>
                    {[
                      `disposeToken: ${materializedHandle.disposeToken}`,
                      `cloudProvider: ${materializedHandle.cloudProvider ?? '-'}`,
                      `envKeys: ${materializedHandle.envKeys.join(', ') || '-'}`,
                      `files: ${materializedHandle.files.length}`
                    ].join('\n')}
                  </pre>
                </div>
              )}

              {revealedEntryId === selectedEntry.id && revealedSecret && (
                <div className="vault-manager-secret">
                  <div className="vault-manager-pane__subtitle">Revealed secret</div>
                  <pre>{revealedSecret}</pre>
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
                Import file
              </button>
            </div>

            {draftMode === 'create' ? (
              renderCreateForm()
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
                    {renderKindSelect(draft.kind, changeKind)}
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Name</span>
                    <input
                      value={draft.name}
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="vault entry name"
                    />
                  </label>
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
