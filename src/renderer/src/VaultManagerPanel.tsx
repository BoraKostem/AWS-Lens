import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import type {
  AppSecuritySummary,
  EnterpriseAccessMode,
  VaultEntryInput,
  VaultEntryKind,
  VaultEntrySummary,
  VaultOrigin,
  VaultRotationState
} from '@shared/types'
import {
  deleteVaultEntry,
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
  name: string
  secret: string
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
  'connection-secret': 'Connection secret'
}

const ORIGIN_LABELS: Record<VaultOrigin, string> = {
  manual: 'Manual',
  'imported-file': 'Imported',
  'aws-secrets-manager': 'Secrets Manager',
  'aws-iam': 'IAM',
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

const KIND_OPTIONS: Array<{ value: VaultKindFilter; label: string }> = [
  { value: 'all', label: 'All kinds' },
  { value: 'aws-profile', label: 'AWS profiles' },
  { value: 'ssh-key', label: 'SSH keys' },
  { value: 'pem', label: 'PEM' },
  { value: 'access-key', label: 'Access keys' },
  { value: 'db-credential', label: 'DB credentials' },
  { value: 'connection-secret', label: 'Connection secrets' },
  { value: 'generic', label: 'Generic secrets' }
]

function createDraft(mode: DraftMode): VaultDraft {
  return {
    kind: mode === 'import' ? 'connection-secret' : 'generic',
    name: '',
    secret: ''
  }
}

function inferImportKind(fileName: string): VaultEntryKind {
  const normalized = fileName.trim().toLowerCase()

  if (normalized.endsWith('.pem')) {
    return 'pem'
  }
  if (normalized.endsWith('.ppk') || normalized.endsWith('.key')) {
    return 'ssh-key'
  }
  if (normalized.endsWith('.json')) {
    return 'connection-secret'
  }

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
    const counts = {
      total: allEntries.length,
      'aws-profile': 0,
      'ssh-key': 0,
      pem: 0,
      'access-key': 0,
      'db-credential': 0,
      'connection-secret': 0,
      generic: 0
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
  }, [active])

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
      const payload: VaultEntryInput = {
        kind: draft.kind,
        name: draft.name,
        secret: draft.secret,
        origin: 'manual',
        rotationState: draft.kind === 'pem' || draft.kind === 'ssh-key' ? 'not-applicable' : 'unknown'
      }

      const saved = await saveVaultEntry(payload)
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
        suggestedKind: inferImportKind(file.name)
      }

      setImportSelection(selected)
      setDraftMode('import')
      setDraft({
        kind: selected.suggestedKind,
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

  const summaryChips = allEntries.length > 0
    ? [
        `Total ${countsByKind.total}`,
        `AWS ${countsByKind['aws-profile']}`,
        `DB ${countsByKind['db-credential']}`,
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
            <div className="vault-manager-card">
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
                  <span>Last used</span>
                  <strong>{formatTimestamp(selectedEntry.lastUsedAt)}</strong>
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
                    <select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as VaultEntryKind }))}>
                      {KIND_OPTIONS.filter((option) => option.value !== 'all').map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="vault-manager-form__field">
                    <span>Name</span>
                    <input
                      value={draft.name}
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="human-readable entry name"
                    />
                  </label>
                  <label className="vault-manager-form__field vault-manager-form__field-span-2">
                    <span>Secret</span>
                    <textarea
                      value={draft.secret}
                      onChange={(event) => setDraft((current) => ({ ...current, secret: event.target.value }))}
                      placeholder="Paste the secret value or JSON blob"
                    />
                  </label>
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
                    <select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as VaultEntryKind }))}>
                      {KIND_OPTIONS.filter((option) => option.value !== 'all').map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
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
