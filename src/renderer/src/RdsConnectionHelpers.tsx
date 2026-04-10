import { useEffect, useState } from 'react'

import type {
  AwsConnection,
  DbConnectionEngine,
  DbConnectionPreset,
  DbConnectionResourceKind,
  DbConnectionResolutionResult,
  DbConnectionCredentialSourceKind,
  DbVaultCredentialSummary
} from '@shared/types'
import {
  deleteDbConnectionPreset,
  deleteDbVaultCredential,
  listDbConnectionPresets,
  listDbVaultCredentials,
  markDbConnectionPresetUsed,
  resolveDbConnectionMaterial,
  saveDbConnectionPreset,
  saveDbVaultCredential
} from './api'

type ConnectionFormState = {
  name: string
  host: string
  port: string
  databaseName: string
  username: string
  credentialSourceKind: DbConnectionCredentialSourceKind
  credentialSourceRef: string
  notes: string
}

function normalizeEngineLabel(engine: DbConnectionEngine): string {
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

function buildDefaultForm(input: {
  defaultName: string
  defaultHost: string
  defaultPort: number
  defaultDatabaseName: string
  defaultUsername: string
  managedSecretArn: string
}): ConnectionFormState {
  return {
    name: input.defaultName,
    host: input.defaultHost,
    port: String(input.defaultPort || ''),
    databaseName: input.defaultDatabaseName,
    username: input.defaultUsername,
    credentialSourceKind: input.managedSecretArn && input.managedSecretArn !== '-' ? 'aws-secrets-manager' : 'manual',
    credentialSourceRef: input.managedSecretArn && input.managedSecretArn !== '-' ? input.managedSecretArn : '',
    notes: ''
  }
}

function toFormState(preset: DbConnectionPreset): ConnectionFormState {
  return {
    name: preset.name,
    host: preset.host,
    port: String(preset.port),
    databaseName: preset.databaseName,
    username: preset.username,
    credentialSourceKind: preset.credentialSourceKind,
    credentialSourceRef: preset.credentialSourceRef,
    notes: preset.notes
  }
}

function formatCredentialSource(kind: DbConnectionCredentialSourceKind): string {
  switch (kind) {
    case 'local-vault':
      return 'Local Vault'
    case 'aws-secrets-manager':
      return 'Secrets Manager'
    default:
      return 'Manual'
  }
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
}

export function RdsConnectionHelpers({
  connection,
  resourceKind,
  resourceId,
  resourceLabel,
  engine,
  defaultHost,
  defaultPort,
  defaultDatabaseName,
  defaultUsername,
  managedSecretArn,
  onRunTerminalCommand
}: {
  connection: AwsConnection
  resourceKind: DbConnectionResourceKind
  resourceId: string
  resourceLabel: string
  engine: DbConnectionEngine
  defaultHost: string
  defaultPort: number
  defaultDatabaseName: string
  defaultUsername: string
  managedSecretArn: string
  onRunTerminalCommand?: (command: string) => void
}) {
  const [presets, setPresets] = useState<DbConnectionPreset[]>([])
  const [vaultCredentials, setVaultCredentials] = useState<DbVaultCredentialSummary[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [form, setForm] = useState<ConnectionFormState>(() => buildDefaultForm({
    defaultName: `${resourceLabel} helper`,
    defaultHost,
    defaultPort,
    defaultDatabaseName,
    defaultUsername,
    managedSecretArn
  }))
  const [manualPassword, setManualPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [resolved, setResolved] = useState<DbConnectionResolutionResult | null>(null)

  async function hydrateLists(): Promise<void> {
    const [nextPresets, nextVaultCredentials] = await Promise.all([
      listDbConnectionPresets({
        profile: connection.profile,
        region: connection.region,
        engine
      }),
      listDbVaultCredentials()
    ])
    setPresets(nextPresets)
    setVaultCredentials(nextVaultCredentials.filter((entry) => entry.engine === engine || entry.engine === 'unknown'))
  }

  useEffect(() => {
    void hydrateLists().catch((error) => {
      setMsg(error instanceof Error ? error.message : 'Failed to load connection helpers.')
    })
  }, [connection.profile, connection.region, engine, resourceId])

  useEffect(() => {
    setSelectedPresetId('')
    setManualPassword('')
    setResolved(null)
    setMsg('')
    setForm(buildDefaultForm({
      defaultName: `${resourceLabel} helper`,
      defaultHost,
      defaultPort,
      defaultDatabaseName,
      defaultUsername,
      managedSecretArn
    }))
  }, [defaultDatabaseName, defaultHost, defaultPort, defaultUsername, managedSecretArn, resourceLabel, resourceId])

  useEffect(() => {
    if (!selectedPresetId) {
      return
    }

    const preset = presets.find((entry) => entry.id === selectedPresetId)
    if (!preset) {
      return
    }

    setForm(toFormState(preset))
  }, [presets, selectedPresetId])

  async function handleSavePreset(): Promise<void> {
    setBusy(true)
    setMsg('')
    try {
      const saved = await saveDbConnectionPreset({
        id: selectedPresetId || undefined,
        name: form.name,
        profile: connection.profile,
        region: connection.region,
        resourceKind,
        resourceId,
        engine,
        host: form.host,
        port: Number.parseInt(form.port, 10) || defaultPort,
        databaseName: form.databaseName,
        username: form.username,
        credentialSourceKind: form.credentialSourceKind,
        credentialSourceRef: form.credentialSourceRef,
        notes: form.notes
      })
      setSelectedPresetId(saved.id)
      setForm(toFormState(saved))
      setMsg(`Preset saved: ${saved.name}`)
      await hydrateLists()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Failed to save preset.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDeletePreset(): Promise<void> {
    if (!selectedPresetId) {
      return
    }

    setBusy(true)
    setMsg('')
    try {
      await deleteDbConnectionPreset(selectedPresetId)
      setSelectedPresetId('')
      setResolved(null)
      setForm(buildDefaultForm({
        defaultName: `${resourceLabel} helper`,
        defaultHost,
        defaultPort,
        defaultDatabaseName,
        defaultUsername,
        managedSecretArn
      }))
      setMsg('Preset deleted.')
      await hydrateLists()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Failed to delete preset.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveVaultCredential(): Promise<void> {
    if (form.credentialSourceKind !== 'local-vault') {
      return
    }

    setBusy(true)
    setMsg('')
    try {
      const saved = await saveDbVaultCredential({
        name: form.credentialSourceRef,
        engine,
        usernameHint: form.username,
        password: manualPassword,
        notes: form.notes
      })
      setForm((current) => ({
        ...current,
        credentialSourceRef: saved.name
      }))
      setManualPassword('')
      setMsg(`Vault credential saved: ${saved.name}`)
      await hydrateLists()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Failed to save vault credential.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDeleteVaultCredential(): Promise<void> {
    if (!form.credentialSourceRef.trim()) {
      return
    }

    setBusy(true)
    setMsg('')
    try {
      await deleteDbVaultCredential(form.credentialSourceRef.trim())
      setForm((current) => ({
        ...current,
        credentialSourceRef: ''
      }))
      setResolved(null)
      setMsg('Vault credential deleted.')
      await hydrateLists()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Failed to delete vault credential.')
    } finally {
      setBusy(false)
    }
  }

  async function handleResolve(): Promise<void> {
    setBusy(true)
    setMsg('')
    try {
      const result = await resolveDbConnectionMaterial(connection, {
        presetId: selectedPresetId,
        resourceKind,
        resourceId,
        resourceLabel,
        engine,
        host: form.host,
        port: Number.parseInt(form.port, 10) || defaultPort,
        databaseName: form.databaseName,
        username: form.username,
        credentialSourceKind: form.credentialSourceKind,
        credentialSourceRef: form.credentialSourceRef,
        manualPassword
      })
      setResolved(result)
      if (result.presetId) {
        await markDbConnectionPresetUsed(result.presetId)
      }
      setMsg(`Connection helper resolved from ${result.sourceSummary}.`)
      await hydrateLists()
    } catch (error) {
      setResolved(null)
      setMsg(error instanceof Error ? error.message : 'Failed to resolve connection.')
    } finally {
      setBusy(false)
    }
  }

  const messageTone = msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('required') || msg.toLowerCase().includes('not found')
    ? 'error'
    : 'success'

  return (
    <div className="rds-stack-list">
      <div className="rds-sidebar-section">
        <div className="rds-overview-head">
          <div>
            <span className="rds-overview-kicker">Connection helpers</span>
            <h3>{resourceLabel}</h3>
          </div>
          <span className="rds-badge available">{normalizeEngineLabel(engine)}</span>
        </div>
        <p className="rds-sidebar-hint">
          Save reusable presets, resolve passwords from Local Vault or Secrets Manager, and hand off a safe terminal command without embedding credentials.
        </p>
        <div className="rds-posture-badges">
          <div className="rds-posture-badge rds-tone-neutral">
            <span>Default endpoint</span>
            <strong>{defaultHost}:{defaultPort || '-'}</strong>
          </div>
          <div className="rds-posture-badge rds-tone-neutral">
            <span>Database</span>
            <strong>{defaultDatabaseName || '-'}</strong>
          </div>
          <div className="rds-posture-badge rds-tone-neutral">
            <span>Credential source</span>
            <strong>{formatCredentialSource(form.credentialSourceKind)}</strong>
          </div>
        </div>
        {msg && <div className={`rds-msg ${messageTone}`}>{msg}</div>}
      </div>

      <div className="rds-sidebar-section">
        <h3>Saved Presets</h3>
        <div className="rds-inline-form">
          <select
            className="rds-select"
            value={selectedPresetId}
            onChange={(event) => {
              setSelectedPresetId(event.target.value)
              setManualPassword('')
              setResolved(null)
            }}
          >
            <option value="">Use resource defaults</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name} ({preset.resourceId || preset.host})
              </option>
            ))}
          </select>
          <button
            className="rds-action-btn apply"
            type="button"
            disabled={busy}
            onClick={() => {
              setSelectedPresetId('')
              setResolved(null)
              setForm(buildDefaultForm({
                defaultName: `${resourceLabel} helper`,
                defaultHost,
                defaultPort,
                defaultDatabaseName,
                defaultUsername,
                managedSecretArn
              }))
            }}
          >
            Reset
          </button>
          <button className="rds-action-btn apply" type="button" disabled={busy} onClick={() => void handleDeletePreset()}>
            Delete Preset
          </button>
        </div>
      </div>

      <div className="rds-sidebar-section">
        <h3>Connection Profile</h3>
        <div className="rds-form-grid">
          <label className="rds-field">
            <span>Preset name</span>
            <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
          </label>
          <label className="rds-field">
            <span>Host</span>
            <input value={form.host} onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))} />
          </label>
          <label className="rds-field">
            <span>Port</span>
            <input value={form.port} onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))} />
          </label>
          <label className="rds-field">
            <span>Database</span>
            <input value={form.databaseName} onChange={(event) => setForm((current) => ({ ...current, databaseName: event.target.value }))} />
          </label>
          <label className="rds-field">
            <span>Username</span>
            <input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
          </label>
          <label className="rds-field">
            <span>Credential source</span>
            <select
              className="rds-select"
              value={form.credentialSourceKind}
              onChange={(event) => {
                const nextKind = event.target.value as DbConnectionCredentialSourceKind
                setResolved(null)
                setManualPassword('')
                setForm((current) => ({
                  ...current,
                  credentialSourceKind: nextKind,
                  credentialSourceRef: nextKind === 'aws-secrets-manager' && managedSecretArn !== '-' ? managedSecretArn : nextKind === 'manual' ? '' : current.credentialSourceRef
                }))
              }}
            >
              <option value="manual">Manual password</option>
              <option value="local-vault">Local vault</option>
              <option value="aws-secrets-manager">AWS Secrets Manager</option>
            </select>
          </label>
          <label className="rds-field rds-field-span-2">
            <span>Notes</span>
            <input value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Optional operator notes" />
          </label>
        </div>
        <div className="rds-inline-form">
          <button className="rds-action-btn apply" type="button" disabled={busy} onClick={() => void handleSavePreset()}>
            Save Preset
          </button>
          <button className="rds-action-btn apply" type="button" disabled={busy} onClick={() => void hydrateLists()}>
            Refresh Lists
          </button>
        </div>
      </div>

      {form.credentialSourceKind === 'local-vault' && (
        <div className="rds-sidebar-section">
          <h3>Local Vault Credential</h3>
          <div className="rds-form-grid">
            <label className="rds-field">
              <span>Vault entry</span>
              <input
                list="rds-vault-credential-options"
                value={form.credentialSourceRef}
                onChange={(event) => setForm((current) => ({ ...current, credentialSourceRef: event.target.value }))}
                placeholder="e.g. prod-analytics-master"
              />
              <datalist id="rds-vault-credential-options">
                {vaultCredentials.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.usernameHint || entry.name}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="rds-field">
              <span>Password</span>
              <input type="password" value={manualPassword} onChange={(event) => setManualPassword(event.target.value)} placeholder="Stored only when saving the vault entry" />
            </label>
          </div>
          <div className="rds-inline-form">
            <button className="rds-action-btn apply" type="button" disabled={busy || !form.credentialSourceRef.trim() || !manualPassword.trim()} onClick={() => void handleSaveVaultCredential()}>
              Save to Vault
            </button>
            <button className="rds-action-btn apply" type="button" disabled={busy || !form.credentialSourceRef.trim()} onClick={() => void handleDeleteVaultCredential()}>
              Delete Vault Entry
            </button>
          </div>
          {vaultCredentials.length > 0 && (
            <div className="rds-stack-list">
              {vaultCredentials.map((entry) => (
                <div key={entry.name} className="rds-suggestion-item">
                  <strong>{entry.name}</strong>
                  <div className="rds-muted">{entry.usernameHint || 'No username hint'} · Updated {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '-'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {form.credentialSourceKind === 'aws-secrets-manager' && (
        <div className="rds-sidebar-section">
          <h3>Secrets Manager Source</h3>
          <label className="rds-field">
            <span>Secret ARN or name</span>
            <input value={form.credentialSourceRef} onChange={(event) => setForm((current) => ({ ...current, credentialSourceRef: event.target.value }))} placeholder="arn:aws:secretsmanager:..." />
          </label>
          {managedSecretArn && managedSecretArn !== '-' && (
            <div className="rds-inline-form">
              <button
                className="rds-action-btn apply"
                type="button"
                disabled={busy}
                onClick={() => setForm((current) => ({ ...current, credentialSourceRef: managedSecretArn }))}
              >
                Use Managed RDS Secret
              </button>
            </div>
          )}
        </div>
      )}

      {form.credentialSourceKind === 'manual' && (
        <div className="rds-sidebar-section">
          <h3>Manual Password</h3>
          <label className="rds-field">
            <span>Password</span>
            <input type="password" value={manualPassword} onChange={(event) => setManualPassword(event.target.value)} placeholder="Temporary only, not stored" />
          </label>
        </div>
      )}

      <div className="rds-sidebar-section">
        <h3>Resolve</h3>
        <div className="rds-inline-form">
          <button className="rds-action-btn start" type="button" disabled={busy} onClick={() => void handleResolve()}>
            Resolve Helper
          </button>
          <button
            className="rds-action-btn apply"
            type="button"
            disabled={!resolved || !onRunTerminalCommand}
            onClick={() => resolved && onRunTerminalCommand?.(resolved.terminalCommand)}
          >
            Open in Terminal
          </button>
          <button
            className="rds-action-btn apply"
            type="button"
            disabled={!resolved}
            onClick={() => resolved && void copyText(resolved.password).then(() => setMsg('Password copied.')).catch(() => setMsg('Failed to copy password.'))}
          >
            Copy Password
          </button>
        </div>
        {!resolved && <div className="rds-sidebar-hint">Resolve the helper to preview the final endpoint, CLI command, and connection URI.</div>}
        {resolved && (
          <div className="rds-stack-list">
            <div className="rds-state-card">
              <strong>{resolved.displayName}</strong>
              <div className="rds-state-card-body">{resolved.sourceSummary}</div>
              <div className="rds-kv">
                <div className="rds-kv-row">
                  <div className="rds-kv-label">Endpoint</div>
                  <div className="rds-kv-value">{resolved.host}:{resolved.port}</div>
                </div>
                <div className="rds-kv-row">
                  <div className="rds-kv-label">Database</div>
                  <div className="rds-kv-value">{resolved.databaseName || '-'}</div>
                </div>
                <div className="rds-kv-row">
                  <div className="rds-kv-label">Username</div>
                  <div className="rds-kv-value">{resolved.username}</div>
                </div>
              </div>
            </div>

            {resolved.warnings.length > 0 && (
              <div className="rds-state-card rds-tone-warning">
                <strong>Secret overrides detected</strong>
                <div className="rds-state-card-body">{resolved.warnings.join(' ')}</div>
              </div>
            )}

            {resolved.snippets.map((snippet) => (
              <div key={snippet.id} className="rds-code-card">
                <div className="rds-code-card-head">
                  <strong>{snippet.label}</strong>
                  <button
                    className="rds-action-btn apply"
                    type="button"
                    onClick={() => void copyText(snippet.value).then(() => setMsg(`${snippet.label} copied.`)).catch(() => setMsg(`Failed to copy ${snippet.label.toLowerCase()}.`))}
                  >
                    Copy
                  </button>
                </div>
                <pre className="rds-code-block">{snippet.value}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
