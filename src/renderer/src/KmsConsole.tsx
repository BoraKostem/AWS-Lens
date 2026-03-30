import { useEffect, useMemo, useState } from 'react'

import { decryptCiphertext, describeKmsKey, listKmsKeys } from './api'
import './terraform.css'
import './kms.css'
import type { AwsConnection, KmsKeyDetail, KmsKeySummary } from '@shared/types'

type ColKey = 'alias' | 'keyId' | 'keyState' | 'keyUsage'

const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'alias', label: 'Alias' },
  { key: 'keyId', label: 'Key ID' },
  { key: 'keyState', label: 'State' },
  { key: 'keyUsage', label: 'Usage' }
]

function fmtTs(value: string) {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function firstAlias(key: KmsKeySummary | KmsKeyDetail | null) {
  return key?.aliasNames[0] || 'Unaliased key'
}

function summarizeRowStatus(key: KmsKeySummary): {
  tone: 'success' | 'warning' | 'danger' | 'info'
  label: string
} {
  if (key.keyState === 'Enabled') return { tone: 'success', label: 'Enabled' }
  if (key.keyState === 'Disabled') return { tone: 'danger', label: 'Disabled' }
  if (key.keyState.includes('Pending')) return { tone: 'warning', label: key.keyState }
  return { tone: 'info', label: key.keyState || 'Unknown' }
}

function formatAlgorithms(detail: KmsKeyDetail | null) {
  if (!detail) return '-'
  const values = detail.encryptionAlgorithms.length > 0 ? detail.encryptionAlgorithms : detail.signingAlgorithms
  return values.length > 0 ? values.join(', ') : '-'
}

export function KmsConsole({ connection }: { connection: AwsConnection }) {
  const [keys, setKeys] = useState<KmsKeySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [decrypting, setDecrypting] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState('')
  const [detail, setDetail] = useState<KmsKeyDetail | null>(null)
  const [ciphertext, setCiphertext] = useState('')
  const [plaintext, setPlaintext] = useState('')
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))

  async function refresh(nextKeyId?: string) {
    setError('')
    setLoading(true)
    try {
      const list = await listKmsKeys(connection)
      setKeys(list)
      const target = nextKeyId ?? list.find((key) => key.keyId === selectedKeyId)?.keyId ?? list[0]?.keyId ?? ''
      setSelectedKeyId(target)
      setDetail(target ? await describeKmsKey(connection, target) : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleSelectKey(keyId: string) {
    setSelectedKeyId(keyId)
    setError('')
    setLoading(true)
    try {
      setDetail(await describeKmsKey(connection, keyId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleDecrypt() {
    setError('')
    setDecrypting(true)
    try {
      const result = await decryptCiphertext(connection, ciphertext)
      setPlaintext(result.plaintext || result.plaintextBase64)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDecrypting(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [connection.sessionId, connection.region])

  const filteredKeys = useMemo(() => {
    if (!filter) return keys
    const query = filter.toLowerCase()
    return keys.filter((key) =>
      key.aliasNames.some((alias) => alias.toLowerCase().includes(query))
      || key.keyId.toLowerCase().includes(query)
      || key.keyUsage.toLowerCase().includes(query)
      || key.keySpec.toLowerCase().includes(query)
      || key.description.toLowerCase().includes(query)
    )
  }, [filter, keys])

  const selectedSummary = useMemo(
    () => keys.find((key) => key.keyId === selectedKeyId) ?? null,
    [keys, selectedKeyId]
  )

  const enabledCount = useMemo(() => keys.filter((key) => key.enabled).length, [keys])
  const customerManagedCount = useMemo(() => keys.filter((key) => key.aliasNames.length > 0).length, [keys])
  const encryptDecryptCount = useMemo(
    () => keys.filter((key) => key.keyUsage === 'ENCRYPT_DECRYPT').length,
    [keys]
  )
  const asymmetricCount = useMemo(
    () => keys.filter((key) => !key.keySpec.includes('SYMMETRIC')).length,
    [keys]
  )

  return (
    <div className="tf-console kms-console">
      <section className="kms-topbar">
        <div className="kms-topbar-copy">
          <div className="eyebrow">Key Management Service</div>
          <h2>KMS keys</h2>
          <div className="kms-topbar-meta">
            <span>{connection.kind === 'profile' ? connection.profile : connection.label}</span>
            <span>{connection.region}</span>
            <span>{firstAlias(detail ?? selectedSummary)}</span>
            <span>{detail?.keyState || selectedSummary?.keyState || '-'}</span>
          </div>
        </div>
        <div className="kms-topbar-stats">
          <div className="kms-mini-stat">
            <span>Total</span>
            <strong>{keys.length}</strong>
          </div>
          <div className="kms-mini-stat">
            <span>Enabled</span>
            <strong>{enabledCount}</strong>
          </div>
          <div className="kms-mini-stat">
            <span>Encrypt</span>
            <strong>{encryptDecryptCount}</strong>
          </div>
          <div className="kms-mini-stat">
            <span>Asymmetric</span>
            <strong>{asymmetricCount}</strong>
          </div>
        </div>
      </section>

      <div className="kms-controls">
        <div className="tf-toolbar kms-primary-actions">
          <button type="button" className="tf-toolbar-btn accent" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
        </div>
        <div className="kms-filter-strip">
          <label className="kms-search-field">
            <span>Filter</span>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Alias, key ID, usage, algorithm, description"
            />
          </label>
          <div className="kms-column-toggle-group" aria-label="Visible columns">
            {COLUMNS.map((column) => (
              <button
                key={column.key}
                type="button"
                className={`kms-column-toggle ${visCols.has(column.key) ? 'active' : ''}`}
                onClick={() => setVisCols((current) => {
                  const next = new Set(current)
                  if (next.has(column.key)) next.delete(column.key)
                  else next.add(column.key)
                  return next
                })}
              >
                {column.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <div className="tf-msg error">{error}</div>}

      <div className="tf-main-layout">
        <div className="tf-project-table-area kms-inventory-pane">
          <div className="tf-pane-head">
            <div>
              <span className="tf-pane-kicker">Tracked keys</span>
              <h3>KMS inventory</h3>
            </div>
            <span className="tf-pane-summary">{filteredKeys.length} visible</span>
          </div>

          {loading && keys.length === 0 ? (
            <div className="tf-empty">Gathering key inventory...</div>
          ) : filteredKeys.length === 0 ? (
            <div className="tf-empty">No KMS keys match the current filter.</div>
          ) : (
            <div className="tf-project-list">
              {filteredKeys.map((key) => {
                const status = summarizeRowStatus(key)
                return (
                  <button
                    key={key.keyId}
                    type="button"
                    className={`tf-project-row ${key.keyId === selectedKeyId ? 'active' : ''}`}
                      onClick={() => void handleSelectKey(key.keyId)}
                  >
                    <div className="tf-project-row-top">
                      <div className="tf-project-row-copy">
                        <strong>{visCols.has('alias') ? firstAlias(key) : key.keyId}</strong>
                        <span title={key.keyArn}>
                          {visCols.has('alias') ? (key.description || key.keyArn) : (key.aliasNames.join(', ') || key.description || key.keyArn)}
                        </span>
                      </div>
                      {visCols.has('keyState') && (
                        <span className={`tf-status-badge ${status.tone}`}>{status.label}</span>
                      )}
                    </div>
                    <div className="tf-project-row-meta">
                      {visCols.has('keyUsage') && <span>{key.keyUsage}</span>}
                      {visCols.has('keyState') && <span>{key.keyState}</span>}
                      {visCols.has('keyId') && <span>{key.keySpec}</span>}
                      <span>{fmtTs(key.creationDate)}</span>
                    </div>
                    <div className="tf-project-row-metrics">
                      {visCols.has('alias') && (
                        <div>
                          <span>Aliases</span>
                          <strong>{key.aliasNames.length || 0}</strong>
                        </div>
                      )}
                      {visCols.has('keyId') && (
                        <div>
                          <span>Key ID</span>
                          <strong>{key.keyId}</strong>
                        </div>
                      )}
                      {visCols.has('keyState') && (
                        <div>
                          <span>State</span>
                          <strong>{key.keyState}</strong>
                        </div>
                      )}
                      {visCols.has('keyUsage') && (
                        <div>
                          <span>Usage</span>
                          <strong>{key.keyUsage}</strong>
                        </div>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="tf-detail-pane kms-detail-pane">
          {!detail ? (
            <div className="tf-empty">Select a KMS key to review its metadata and decrypt ciphertext.</div>
          ) : (
            <>
              <section className="tf-detail-hero">
                <div className="tf-detail-hero-copy">
                  <div className="eyebrow">Key posture</div>
                  <h3>{firstAlias(detail)}</h3>
                  <p>{detail.description || detail.keyArn}</p>
                  <div className="tf-detail-meta-strip">
                    <div className="tf-detail-meta-pill">
                      <span>Key ID</span>
                      <strong>{detail.keyId}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Manager</span>
                      <strong>{detail.keyManager}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Origin</span>
                      <strong>{detail.origin}</strong>
                    </div>
                    <div className="tf-detail-meta-pill">
                      <span>Created</span>
                      <strong>{fmtTs(detail.creationDate)}</strong>
                    </div>
                  </div>
                </div>
                <div className="tf-detail-hero-stats">
                  <div className={`tf-detail-stat-card ${detail.enabled ? 'success' : 'danger'}`}>
                    <span>State</span>
                    <strong>{detail.keyState}</strong>
                    <small>{detail.enabled ? 'Available for active use' : 'Disabled or pending lifecycle action'}</small>
                  </div>
                  <div className="tf-detail-stat-card info">
                    <span>Key usage</span>
                    <strong>{detail.keyUsage}</strong>
                    <small>{detail.multiRegion ? 'Multi-region capable' : 'Single-region scope'}</small>
                  </div>
                  <div className="tf-detail-stat-card">
                    <span>Key spec</span>
                    <strong>{detail.keySpec}</strong>
                    <small>{detail.aliasNames.length} aliases attached</small>
                  </div>
                  <div className="tf-detail-stat-card warning">
                    <span>Algorithms</span>
                    <strong>{detail.encryptionAlgorithms.length + detail.signingAlgorithms.length}</strong>
                    <small>{formatAlgorithms(detail)}</small>
                  </div>
                </div>
              </section>

              <section className="tf-section">
                <div className="kms-section-head">
                  <div>
                    <span className="tf-pane-kicker">Metadata</span>
                    <h3>Key detail</h3>
                  </div>
                </div>
                <div className="tf-kv">
                  <div className="tf-kv-row"><div className="tf-kv-label">ARN</div><div className="tf-kv-value">{detail.keyArn}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Aliases</div><div className="tf-kv-value">{detail.aliasNames.join(', ') || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Manager</div><div className="tf-kv-value">{detail.keyManager}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Origin</div><div className="tf-kv-value">{detail.origin}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Multi-region</div><div className="tf-kv-value">{detail.multiRegion ? 'Yes' : 'No'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Deletion date</div><div className="tf-kv-value">{fmtTs(detail.deletionDate)}</div></div>
                </div>
              </section>

              <section className="tf-section kms-algorithms-section">
                <div className="kms-section-head">
                  <div>
                    <span className="tf-pane-kicker">Cryptography</span>
                    <h3>Algorithm support</h3>
                  </div>
                </div>
                <div className="kms-algorithm-grid">
                  <div className="kms-algorithm-card">
                    <span>Encryption algorithms</span>
                    <strong>{detail.encryptionAlgorithms.length || 0}</strong>
                    <small>{detail.encryptionAlgorithms.join(', ') || 'No encryption algorithms reported'}</small>
                  </div>
                  <div className="kms-algorithm-card">
                    <span>Signing algorithms</span>
                    <strong>{detail.signingAlgorithms.length || 0}</strong>
                    <small>{detail.signingAlgorithms.join(', ') || 'No signing algorithms reported'}</small>
                  </div>
                  <div className="kms-algorithm-card">
                    <span>Aliases</span>
                    <strong>{detail.aliasNames.length}</strong>
                    <small>{detail.aliasNames.join(', ') || 'No aliases attached'}</small>
                  </div>
                  <div className="kms-algorithm-card">
                    <span>Lifecycle</span>
                    <strong>{detail.multiRegion ? 'Multi-region' : 'Single-region'}</strong>
                    <small>{detail.deletionDate ? `Deletion scheduled ${fmtTs(detail.deletionDate)}` : 'No scheduled deletion'}</small>
                  </div>
                </div>
              </section>

              <section className="tf-section kms-decrypt-section">
                <div className="kms-section-head">
                  <div>
                    <span className="tf-pane-kicker">Utility</span>
                    <h3>Decrypt ciphertext</h3>
                  </div>
                </div>
                <p className="kms-section-copy">
                  Paste a Base64 ciphertext blob and run the same decrypt flow against the current AWS connection.
                </p>
                <label className="field">
                  <span>Ciphertext blob</span>
                  <textarea
                    value={ciphertext}
                    onChange={(event) => setCiphertext(event.target.value)}
                    placeholder="Base64 ciphertext blob"
                  />
                </label>
                <div className="tf-toolbar">
                  <button
                    type="button"
                    className="tf-toolbar-btn accent"
                    onClick={() => void handleDecrypt()}
                    disabled={decrypting || !ciphertext.trim()}
                  >
                    {decrypting ? 'Decrypting...' : 'Decrypt'}
                  </button>
                </div>
                {plaintext && (
                  <div className="kms-plaintext-shell">
                    <span>Plaintext output</span>
                    <pre className="kms-plaintext-output">{plaintext}</pre>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
