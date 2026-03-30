import { useEffect, useMemo, useState } from 'react'

import type { AwsConnection, KeyPairSummary } from '@shared/types'
import { createKeyPair, deleteKeyPair, listKeyPairs } from './api'
import { ConfirmButton } from './ConfirmButton'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import './keypairs.css'

type ColKey = 'keyName' | 'keyPairId' | 'keyType' | 'fingerprint' | 'createdAt'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'keyName', label: 'Name', color: '#f59a3d' },
  { key: 'keyPairId', label: 'ID', color: '#4a8fe7' },
  { key: 'keyType', label: 'Type', color: '#45c4a0' },
  { key: 'fingerprint', label: 'Fingerprint', color: '#c38dff' },
  { key: 'createdAt', label: 'Created', color: '#77c6ff' }
]

function formatTimestamp(value: string): string {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function formatRelativeTimestamp(value: string): string {
  if (!value || value === '-') return 'Unknown'
  const then = new Date(value).getTime()
  if (!Number.isFinite(then)) return value
  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSeconds < 60) return `${diffSeconds}s ago`
  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

function maskFingerprint(fingerprint: string): string {
  if (!fingerprint) return '-'
  if (fingerprint.length <= 20) return fingerprint
  return `${fingerprint.slice(0, 16)}...${fingerprint.slice(-10)}`
}

function describePairStatus(pair: KeyPairSummary | null): { tone: 'success' | 'info'; label: string; hint: string } {
  if (!pair) {
    return {
      tone: 'info',
      label: 'No selection',
      hint: 'Pick a key pair from the inventory rail.'
    }
  }

  return {
    tone: 'success',
    label: 'Available',
    hint: pair.createdAt && pair.createdAt !== '-' ? `Created ${formatRelativeTimestamp(pair.createdAt)}` : 'Creation time not reported'
  }
}

function tagEntries(tags: Record<string, string>): Array<[string, string]> {
  return Object.entries(tags).sort(([left], [right]) => left.localeCompare(right))
}

export function KeyPairsConsole({ connection }: { connection: AwsConnection }) {
  const [pairs, setPairs] = useState<KeyPairSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedName, setSelectedName] = useState('')
  const [newKeyName, setNewKeyName] = useState('')
  const [download, setDownload] = useState<{ name: string; material: string } | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState()

  async function refresh(nextName?: string) {
    setError('')
    setLoading(true)
    beginRefresh(nextName ? 'selection' : 'manual')
    try {
      const list = await listKeyPairs(connection)
      setPairs(list)
      setSelectedName((current) => nextName ?? list.find((pair) => pair.keyName === current)?.keyName ?? list[0]?.keyName ?? '')
      completeRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [connection.sessionId, connection.region])

  const activeCols = useMemo(() => COLUMNS.filter((column) => visCols.has(column.key)), [visCols])

  const filteredPairs = useMemo(() => {
    if (!filter) return pairs
    const query = filter.toLowerCase()
    return pairs.filter((pair) =>
      pair.keyName.toLowerCase().includes(query)
      || (pair.keyPairId ?? '').toLowerCase().includes(query)
      || (pair.keyType ?? '').toLowerCase().includes(query)
      || (pair.fingerprint ?? '').toLowerCase().includes(query)
    )
  }, [filter, pairs])

  const selectedPair = useMemo(
    () => filteredPairs.find((pair) => pair.keyName === selectedName)
      ?? pairs.find((pair) => pair.keyName === selectedName)
      ?? filteredPairs[0]
      ?? pairs[0]
      ?? null,
    [filteredPairs, pairs, selectedName]
  )

  useEffect(() => {
    if (selectedPair && selectedPair.keyName !== selectedName) {
      setSelectedName(selectedPair.keyName)
    }
    if (!selectedPair && selectedName) {
      setSelectedName('')
    }
  }, [selectedName, selectedPair])

  const selectedTags = useMemo(() => tagEntries(selectedPair?.tags ?? {}), [selectedPair])
  const status = describePairStatus(selectedPair)
  const rsaCount = pairs.filter((pair) => pair.keyType.toLowerCase().includes('rsa')).length
  const recentPair = pairs
    .filter((pair) => pair.createdAt && pair.createdAt !== '-')
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0] ?? null

  function getValue(pair: KeyPairSummary, column: ColKey) {
    if (column === 'createdAt') return formatTimestamp(pair.createdAt)
    return pair[column] ?? '-'
  }

  function downloadPrivateKey() {
    if (!download) return
    const blob = new Blob([download.material], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${download.name}.pem`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function doCreate() {
    if (!newKeyName.trim()) return
    setError('')
    try {
      const created = await createKeyPair(connection, newKeyName.trim())
      setDownload({ name: created.keyName, material: created.keyMaterial })
      setNewKeyName('')
      setMsg(`Key pair "${created.keyName}" created`)
      await refresh(created.keyName)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function doDelete(name: string) {
    setError('')
    try {
      await deleteKeyPair(connection, name)
      setMsg(`Key pair "${name}" deleted`)
      if (download?.name === name) {
        setDownload(null)
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="kp-console">
      <section className="kp-hero">
        <div className="kp-hero-copy">
          <div className="eyebrow">EC2 access posture</div>
          <h2>Key pair inventory</h2>
          <p>
            Review regional key pairs, generate a new private key when needed, and keep access material easy to inspect
            without changing the existing service workflow.
          </p>
          <div className="kp-meta-strip">
            <div className="kp-meta-pill">
              <span>Connection</span>
              <strong>{connection.kind === 'profile' ? connection.profile : connection.label}</strong>
            </div>
            <div className="kp-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="kp-meta-pill">
              <span>Selected key</span>
              <strong>{selectedPair?.keyName ?? 'None selected'}</strong>
            </div>
          </div>
        </div>

        <div className="kp-hero-stats">
          <div className={`kp-stat-card ${status.tone}`}>
            <span>Status</span>
            <strong>{status.label}</strong>
            <small>{status.hint}</small>
          </div>
          <div className="kp-stat-card">
            <span>Total pairs</span>
            <strong>{pairs.length}</strong>
            <small>{filteredPairs.length} visible after filters</small>
          </div>
          <div className="kp-stat-card">
            <span>RSA pairs</span>
            <strong>{rsaCount}</strong>
            <small>{pairs.length - rsaCount} non-RSA keys</small>
          </div>
          <div className="kp-stat-card">
            <span>Latest creation</span>
            <strong>{recentPair ? formatRelativeTimestamp(recentPair.createdAt) : 'No data'}</strong>
            <small>{recentPair?.keyName ?? 'Create the first key pair from this view'}</small>
          </div>
        </div>
      </section>

      <section className="kp-toolbar">
        <div className="kp-toolbar-actions">
          <button type="button" className="kp-toolbar-btn accent" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh inventory'}
          </button>
          {download && (
            <button type="button" className="kp-toolbar-btn" onClick={downloadPrivateKey}>
              Download {download.name}.pem
            </button>
          )}
        </div>
        <FreshnessIndicator freshness={freshness} label="Inventory last updated" />
      </section>

      {msg && <div className="kp-msg">{msg}</div>}
      {error && <div className="kp-msg error">{error}</div>}

      <div className="kp-main-layout">
        <aside className="kp-inventory-pane">
          <div className="kp-pane-head">
            <div>
              <span className="kp-pane-kicker">Create</span>
              <h3>Provision access material</h3>
            </div>
          </div>
          <div className="kp-create-panel">
            <label className="kp-field">
              <span>Key pair name</span>
              <input
                placeholder="my-admin-key"
                value={newKeyName}
                onChange={(event) => setNewKeyName(event.target.value)}
              />
            </label>
            <div className="kp-create-actions">
              <button type="button" className="kp-toolbar-btn accent" disabled={!newKeyName.trim()} onClick={() => void doCreate()}>
                Create key pair
              </button>
              {download && (
                <button type="button" className="kp-toolbar-btn" onClick={downloadPrivateKey}>
                  Download private key
                </button>
              )}
            </div>
            <p className="kp-section-hint">
              Private key material is returned only once on creation. Download it immediately if you need local access.
            </p>
            {download && (
              <pre className="kp-code-block">{download.material}</pre>
            )}
          </div>

          <div className="kp-pane-head">
            <div>
              <span className="kp-pane-kicker">Inventory</span>
              <h3>Browse key pairs</h3>
            </div>
            <span className="kp-pane-summary">{filteredPairs.length}</span>
          </div>

          <input
            className="kp-search"
            placeholder="Filter by name, id, type, or fingerprint"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />

          <div className="kp-chip-row">
            {COLUMNS.map((column) => (
              <button
                key={column.key}
                type="button"
                className={`kp-chip ${visCols.has(column.key) ? 'active' : ''}`}
                style={visCols.has(column.key) ? { borderColor: column.color, color: '#edf4fb' } : undefined}
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

          <div className="kp-list">
            {loading && (
              <div className="kp-empty-state">Gathering key pair inventory...</div>
            )}
            {!loading && filteredPairs.length === 0 && (
              <div className="kp-empty-state">
                {pairs.length === 0 ? 'No key pairs found in this region.' : 'No key pairs match the current filter.'}
              </div>
            )}
            {!loading && filteredPairs.map((pair) => (
              <button
                key={pair.keyName}
                type="button"
                className={`kp-list-item ${selectedPair?.keyName === pair.keyName ? 'active' : ''}`}
                onClick={() => setSelectedName(pair.keyName)}
              >
                <div className="kp-list-item-top">
                  <strong>{pair.keyName}</strong>
                  <span className="kp-list-item-type">{pair.keyType || 'Unknown'}</span>
                </div>
                <div className="kp-list-item-meta">
                  <span>{pair.keyPairId || 'No ID reported'}</span>
                  <span>{formatRelativeTimestamp(pair.createdAt)}</span>
                </div>
                <div className="kp-list-item-fingerprint" title={pair.fingerprint}>
                  {maskFingerprint(pair.fingerprint)}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="kp-detail-pane">
          {!selectedPair ? (
            <div className="kp-empty-detail">
              <div className="eyebrow">Selection</div>
              <h3>No key pair selected</h3>
              <p>Create a new key pair or choose one from the inventory rail to inspect metadata and manage lifecycle actions.</p>
            </div>
          ) : (
            <>
              <section className="kp-detail-hero">
                <div className="kp-detail-copy">
                  <div className="eyebrow">Key posture</div>
                  <h3>{selectedPair.keyName}</h3>
                  <p>
                    {selectedPair.keyPairId} in {connection.region}. Fingerprint {maskFingerprint(selectedPair.fingerprint)}.
                  </p>
                  <div className="kp-meta-strip">
                    <div className="kp-meta-pill">
                      <span>Type</span>
                      <strong>{selectedPair.keyType || '-'}</strong>
                    </div>
                    <div className="kp-meta-pill">
                      <span>Created</span>
                      <strong>{formatTimestamp(selectedPair.createdAt)}</strong>
                    </div>
                    <div className="kp-meta-pill">
                      <span>Tags</span>
                      <strong>{selectedTags.length}</strong>
                    </div>
                  </div>
                </div>

                <div className="kp-detail-actions">
                  <div className="kp-stat-card info">
                    <span>Fingerprint</span>
                    <strong>{selectedPair.fingerprint ? 'Tracked' : 'Unavailable'}</strong>
                    <small>{maskFingerprint(selectedPair.fingerprint)}</small>
                  </div>
                  <ConfirmButton className="kp-toolbar-btn danger" onConfirm={() => void doDelete(selectedPair.keyName)}>
                    Delete key pair
                  </ConfirmButton>
                </div>
              </section>

              <div className="kp-table-panel">
                <div className="kp-pane-head">
                  <div>
                    <span className="kp-pane-kicker">Columns</span>
                    <h3>Selected row projection</h3>
                  </div>
                </div>
                <div className="kp-table-wrap">
                  <table className="kp-table">
                    <thead>
                      <tr>
                        {activeCols.map((column) => <th key={column.key}>{column.label}</th>)}
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {activeCols.map((column) => <td key={column.key}>{getValue(selectedPair, column.key)}</td>)}
                        <td>
                          <ConfirmButton className="kp-inline-delete" onConfirm={() => void doDelete(selectedPair.keyName)}>
                            Delete
                          </ConfirmButton>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="kp-detail-grid">
                <section className="kp-section">
                  <div className="kp-pane-head">
                    <div>
                      <span className="kp-pane-kicker">Metadata</span>
                      <h3>Key pair detail</h3>
                    </div>
                  </div>
                  <div className="kp-kv">
                    <div className="kp-kv-row"><span>Name</span><strong>{selectedPair.keyName}</strong></div>
                    <div className="kp-kv-row"><span>Key pair ID</span><strong>{selectedPair.keyPairId || '-'}</strong></div>
                    <div className="kp-kv-row"><span>Type</span><strong>{selectedPair.keyType || '-'}</strong></div>
                    <div className="kp-kv-row"><span>Created</span><strong>{formatTimestamp(selectedPair.createdAt)}</strong></div>
                    <div className="kp-kv-row"><span>Fingerprint</span><strong>{selectedPair.fingerprint || '-'}</strong></div>
                  </div>
                </section>

                <section className="kp-section">
                  <div className="kp-pane-head">
                    <div>
                      <span className="kp-pane-kicker">Tags</span>
                      <h3>Attached metadata</h3>
                    </div>
                  </div>
                  {selectedTags.length === 0 ? (
                    <div className="kp-empty-subsection">No tags are attached to this key pair.</div>
                  ) : (
                    <div className="kp-tag-grid">
                      {selectedTags.map(([key, value]) => (
                        <div key={key} className="kp-tag-card">
                          <span>{key}</span>
                          <strong>{value || '(empty)'}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
