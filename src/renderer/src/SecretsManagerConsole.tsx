import { useEffect, useMemo, useState } from 'react'

import {
  createSecret,
  deleteSecret,
  describeSecret,
  getSecretValue,
  listSecrets,
  putSecretResourcePolicy,
  restoreSecret,
  rotateSecret,
  tagSecret,
  untagSecret,
  updateSecretDescription,
  updateSecretValue
} from './api'
import type {
  AwsConnection,
  SecretsManagerSecretDetail,
  SecretsManagerSecretSummary,
  SecretsManagerSecretValue
} from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

/* ── Column definitions for the secrets table ────────────── */

type ColKey = 'name' | 'description' | 'rotation' | 'versions' | 'lastChanged' | 'lastAccessed'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'description', label: 'Description', color: '#14b8a6' },
  { key: 'rotation', label: 'Rotation', color: '#22c55e' },
  { key: 'versions', label: 'Versions', color: '#f59e0b' },
  { key: 'lastChanged', label: 'Last Changed', color: '#8b5cf6' },
  { key: 'lastAccessed', label: 'Last Accessed', color: '#a855f7' },
]

function getColValue(s: SecretsManagerSecretSummary, key: ColKey): string {
  switch (key) {
    case 'name': return s.name
    case 'description': return s.description || '-'
    case 'rotation': return s.rotationEnabled ? 'Enabled' : 'Disabled'
    case 'versions': return String(s.versionCount)
    case 'lastChanged': return fmtTs(s.lastChangedDate)
    case 'lastAccessed': return fmtTs(s.lastAccessedDate)
  }
}

function fmtTs(v: string) { return v && v !== '-' ? new Date(v).toLocaleString() : '-' }

/* ── Main tab types ──────────────────────────────────────── */

type MainTab = 'secrets' | 'create'
type SideTab = 'overview' | 'value' | 'versions' | 'policy' | 'tags'

/* ── SecretsManagerConsole ───────────────────────────────── */

export function SecretsManagerConsole({ connection }: { connection: AwsConnection }) {
  const [mainTab, setMainTab] = useState<MainTab>('secrets')
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  /* ── Filter state ──────────────────────────────────────── */
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  /* ── Secrets state ─────────────────────────────────────── */
  const [secrets, setSecrets] = useState<SecretsManagerSecretSummary[]>([])
  const [selectedSecretId, setSelectedSecretId] = useState('')
  const [detail, setDetail] = useState<SecretsManagerSecretDetail | null>(null)
  const [secretValue, setSecretValueState] = useState<SecretsManagerSecretValue | null>(null)
  const [valueDraft, setValueDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [policyDraft, setPolicyDraft] = useState('')

  /* ── Create form state ─────────────────────────────────── */
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newKmsKeyId, setNewKmsKeyId] = useState('')

  /* ── Tag state ─────────────────────────────────────────── */
  const [tagKey, setTagKey] = useState('')
  const [tagValue, setTagValue] = useState('')

  /* ── Data loading ──────────────────────────────────────── */
  async function refresh(nextSecretId?: string) {
    setError('')
    setLoading(true)
    try {
      const list = await listSecrets(connection)
      setSecrets(list)
      const target = nextSecretId ?? list.find((item) => item.arn === selectedSecretId)?.arn ?? list[0]?.arn ?? ''
      setSelectedSecretId(target)
      if (!target) {
        setDetail(null)
        setSecretValueState(null)
        return
      }
      const [nextDetail, nextValue] = await Promise.all([
        describeSecret(connection, target),
        getSecretValue(connection, target)
      ])
      setDetail(nextDetail)
      setSecretValueState(nextValue)
      setValueDraft(nextValue.secretString || nextValue.secretBinary)
      setDescriptionDraft(nextDetail.description)
      setPolicyDraft(nextDetail.policy)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

useEffect(() => { void refresh() }, [connection.sessionId, connection.region])

  async function selectSecret(arn: string) {
    setSelectedSecretId(arn)
    setError('')
    try {
      const [d, v] = await Promise.all([
        describeSecret(connection, arn),
        getSecretValue(connection, arn)
      ])
      setDetail(d)
      setSecretValueState(v)
      setValueDraft(v.secretString || v.secretBinary)
      setDescriptionDraft(d.description)
      setPolicyDraft(d.policy)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /* ── Action handlers ───────────────────────────────────── */
  async function doCreate() {
    if (!newName) return
    setError('')
    try {
      const arn = await createSecret(connection, {
        name: newName,
        description: newDescription,
        secretString: newValue,
        kmsKeyId: newKmsKeyId,
        tags: []
      })
      setNewName('')
      setNewDescription('')
      setNewValue('')
      setNewKmsKeyId('')
      setMsg('Secret created')
      setMainTab('secrets')
      await refresh(arn)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doUpdateValue() {
    if (!selectedSecretId) return
    try {
      await updateSecretValue(connection, selectedSecretId, valueDraft)
      setMsg('Value updated')
      await refresh(selectedSecretId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doUpdateDescription() {
    if (!selectedSecretId) return
    try {
      await updateSecretDescription(connection, selectedSecretId, descriptionDraft)
      setMsg('Description updated')
      await refresh(selectedSecretId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doRotate() {
    if (!selectedSecretId) return
    try {
      await rotateSecret(connection, selectedSecretId)
      setMsg('Rotation triggered')
      await refresh(selectedSecretId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDelete() {
    if (!selectedSecretId) return
    try {
      await deleteSecret(connection, selectedSecretId, false)
      setMsg('Secret deleted')
      setSelectedSecretId('')
      setDetail(null)
      setSecretValueState(null)
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doRestore() {
    if (!selectedSecretId) return
    try {
      await restoreSecret(connection, selectedSecretId)
      setMsg('Secret restored')
      await refresh(selectedSecretId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doSavePolicy() {
    if (!selectedSecretId) return
    try {
      await putSecretResourcePolicy(connection, selectedSecretId, policyDraft)
      setMsg('Policy saved')
      await refresh(selectedSecretId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doAddTag() {
    if (!selectedSecretId || !tagKey) return
    try {
      await tagSecret(connection, selectedSecretId, [{ key: tagKey, value: tagValue }])
      setTagKey('')
      setTagValue('')
      setMsg('Tag added')
      await refresh(selectedSecretId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doRemoveTag(key: string) {
    if (!selectedSecretId) return
    try {
      await untagSecret(connection, selectedSecretId, [key])
      setMsg('Tag removed')
      await refresh(selectedSecretId)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doLoadVersion(versionId: string) {
    if (!selectedSecretId) return
    try {
      const v = await getSecretValue(connection, selectedSecretId, versionId)
      setSecretValueState(v)
      setValueDraft(v.secretString || v.secretBinary)
      setMsg(`Loaded version ${versionId}`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /* ── Filtering ─────────────────────────────────────────── */
  const activeCols = COLUMNS.filter(c => visCols.has(c.key))

  const filteredSecrets = useMemo(() => {
    if (!filter) return secrets
    const q = filter.toLowerCase()
    return secrets.filter(s => activeCols.some(c => getColValue(s, c.key).toLowerCase().includes(q)))
  }, [secrets, filter, activeCols])

  /* ── Create view ───────────────────────────────────────── */
  if (mainTab === 'create') {
    return (
      <div className="svc-console">
        <div className="svc-tab-bar">
          <button className="svc-tab" type="button" onClick={() => setMainTab('secrets')}>Cancel</button>
          <button className="svc-tab active" type="button">Create Secret</button>
        </div>

        {error && <div className="svc-error">{error}</div>}

        <div className="svc-panel">
          <div className="svc-form">
            <label><span>Name</span><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="my-secret" /></label>
            <label><span>Description</span><input value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="Optional description" /></label>
            <label><span>KMS Key ID</span><input value={newKmsKeyId} onChange={e => setNewKmsKeyId(e.target.value)} placeholder="Optional KMS key" /></label>
            <label><span>Initial Value</span><textarea value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="Secret string value" /></label>
          </div>
          <div className="svc-btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="svc-btn success" disabled={!newName} onClick={() => void doCreate()}>Create Secret</button>
          </div>
        </div>
      </div>
    )
  }

  /* ── Main secrets view ─────────────────────────────────── */
  return (
    <div className="svc-console">
      {/* ── Tab bar ──────────────────────────────────────── */}
      <div className="svc-tab-bar">
        <button
          className={`svc-tab ${mainTab === 'secrets' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('secrets')}
        >Secrets</button>
        <button className="svc-tab right" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* ── Search ───────────────────────────────────────── */}
      <input
        className="svc-search"
        placeholder="Filter rows across selected columns..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />

      {/* ── Column chips ─────────────────────────────────── */}
      <div className="svc-chips">
        {COLUMNS.map(col => (
          <button
            key={col.key}
            className={`svc-chip ${visCols.has(col.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
            onClick={() => setVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
          >{col.label}</button>
        ))}
      </div>

      {/* ── Layout: table + sidebar ──────────────────────── */}
      <div className="svc-layout">
        {/* ── Table area ─────────────────────────────────── */}
        <div className="svc-table-area">
          <table className="svc-table">
            <thead>
              <tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length}>Gathering data</td></tr>}
              {!loading && filteredSecrets.map(s => (
                <tr
                  key={s.arn}
                  className={s.arn === selectedSecretId ? 'active' : ''}
                  onClick={() => void selectSecret(s.arn)}
                >
                  {activeCols.map(c => (
                    <td key={c.key}>
                      {c.key === 'rotation'
                        ? <span className={`svc-badge ${s.rotationEnabled ? 'enabled' : 'disabled'}`}>{s.rotationEnabled ? 'Enabled' : 'Disabled'}</span>
                        : getColValue(s, c.key)
                      }
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && filteredSecrets.length === 0 && <div className="svc-empty">Gathering data</div>}
          {!loading && !filteredSecrets.length && <div className="svc-empty">No secrets found.</div>}
        </div>

        {/* ── Sidebar ────────────────────────────────────── */}
        <div className="svc-sidebar">
          <div className="svc-side-tabs">
            <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>Overview</button>
            <button className={sideTab === 'value' ? 'active' : ''} type="button" onClick={() => setSideTab('value')}>Value</button>
            <button className={sideTab === 'versions' ? 'active' : ''} type="button" onClick={() => setSideTab('versions')}>Versions</button>
            <button className={sideTab === 'policy' ? 'active' : ''} type="button" onClick={() => setSideTab('policy')}>Policy</button>
            <button className={sideTab === 'tags' ? 'active' : ''} type="button" onClick={() => setSideTab('tags')}>Tags</button>
          </div>

          {/* ── Overview tab ─────────────────────────────── */}
          {sideTab === 'overview' && (
            <>
              <div className="svc-section">
                <h3>Actions</h3>
                <div className="svc-actions">
                  <button className="svc-btn success" type="button" onClick={() => setMainTab('create')}>New Secret</button>
                  <button className="svc-btn primary" type="button" disabled={!selectedSecretId} onClick={() => void doRotate()}>Rotate</button>
                  {detail?.deletedDate ? (
                    <button className="svc-btn warn" type="button" onClick={() => void doRestore()}>Restore</button>
                  ) : (
                    <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete()} confirmLabel="Confirm Delete?">Delete</ConfirmButton>
                  )}
                </div>
              </div>

              <div className="svc-section">
                <h3>Secret Details</h3>
                {detail ? (
                  <div className="svc-kv">
                    <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{detail.name}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value">{detail.arn}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Status</div><div className="svc-kv-value">{detail.deletedDate ? <span className="svc-badge deleted">Deleted {fmtTs(detail.deletedDate)}</span> : <span className="svc-badge ok">Active</span>}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Rotation</div><div className="svc-kv-value">{detail.rotationEnabled ? <span className="svc-badge enabled">Enabled</span> : <span className="svc-badge disabled">Disabled</span>}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Next Rotation</div><div className="svc-kv-value">{fmtTs(detail.nextRotationDate)}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">KMS Key</div><div className="svc-kv-value">{detail.kmsKeyId || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Primary Region</div><div className="svc-kv-value">{detail.primaryRegion || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Owning Service</div><div className="svc-kv-value">{detail.owningService || '-'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Last Changed</div><div className="svc-kv-value">{fmtTs(detail.lastChangedDate)}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Last Accessed</div><div className="svc-kv-value">{fmtTs(detail.lastAccessedDate)}</div></div>
                  </div>
                ) : <div className="svc-empty">Select a secret to inspect it.</div>}
              </div>

              {detail && (
                <div className="svc-section">
                  <h3>Description</h3>
                  <div className="svc-form">
                    <textarea
                      value={descriptionDraft}
                      onChange={e => setDescriptionDraft(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="svc-btn-row">
                    <button type="button" className="svc-btn primary" onClick={() => void doUpdateDescription()}>Update Description</button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Value tab ────────────────────────────────── */}
          {sideTab === 'value' && (
            <div className="svc-section">
              <h3>Secret Value</h3>
              {detail ? (
                <>
                  {secretValue && (
                    <div className="svc-kv" style={{ marginBottom: 12 }}>
                      <div className="svc-kv-row"><div className="svc-kv-label">Version</div><div className="svc-kv-value">{secretValue.versionId || 'current'}</div></div>
                      <div className="svc-kv-row"><div className="svc-kv-label">Stages</div><div className="svc-kv-value">{secretValue.versionStages.join(', ') || '-'}</div></div>
                    </div>
                  )}
                  <textarea
                    value={valueDraft}
                    onChange={e => setValueDraft(e.target.value)}
                    rows={10}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', padding: 10, resize: 'vertical' }}
                  />
                  <div className="svc-btn-row" style={{ marginTop: 10 }}>
                    <button type="button" className="svc-btn success" onClick={() => void doUpdateValue()}>Update Value</button>
                  </div>
                </>
              ) : <div className="svc-empty">Select a secret to view its value.</div>}
            </div>
          )}

          {/* ── Versions tab ─────────────────────────────── */}
          {sideTab === 'versions' && (
            <div className="svc-section">
              <h3>Versions</h3>
              {detail && detail.versions.length > 0 ? (
                <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 420px)' }}>
                  <table className="svc-table">
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Stages</th>
                        <th>Created</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.versions.map(v => (
                        <tr key={v.versionId}>
                          <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{v.versionId}</td>
                          <td>{v.stages.join(', ') || '-'}</td>
                          <td>{fmtTs(v.createdDate)}</td>
                          <td>
                            <button
                              type="button"
                              className="svc-btn muted"
                              style={{ padding: '4px 10px', fontSize: 11 }}
                              onClick={() => void doLoadVersion(v.versionId)}
                            >Load</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : detail ? (
                <div className="svc-empty">No versions available.</div>
              ) : (
                <div className="svc-empty">Select a secret to view versions.</div>
              )}
            </div>
          )}

          {/* ── Policy tab ───────────────────────────────── */}
          {sideTab === 'policy' && (
            <div className="svc-section">
              <h3>Resource Policy</h3>
              {detail ? (
                <>
                  <textarea
                    value={policyDraft}
                    onChange={e => setPolicyDraft(e.target.value)}
                    rows={12}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', padding: 10, resize: 'vertical' }}
                  />
                  <div className="svc-btn-row" style={{ marginTop: 10 }}>
                    <button type="button" className="svc-btn primary" onClick={() => void doSavePolicy()}>Save Policy</button>
                  </div>
                </>
              ) : <div className="svc-empty">Select a secret to edit its policy.</div>}
            </div>
          )}

          {/* ── Tags tab ─────────────────────────────────── */}
          {sideTab === 'tags' && (
            <div className="svc-section">
              <h3>Tags</h3>
              {detail ? (
                <>
                  {Object.keys(detail.tags).length > 0 ? (
                    <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 500px)', marginBottom: 12 }}>
                      <table className="svc-table">
                        <thead>
                          <tr>
                            <th>Key</th>
                            <th>Value</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(detail.tags).map(([k, v]) => (
                            <tr key={k}>
                              <td>{k}</td>
                              <td>{v}</td>
                              <td>
                                <button
                                  type="button"
                                  className="svc-btn danger"
                                  style={{ padding: '4px 10px', fontSize: 11 }}
                                  onClick={() => void doRemoveTag(k)}
                                >Remove</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="svc-empty" style={{ padding: '8px 0' }}>No tags.</div>
                  )}
                  <div className="svc-inline">
                    <input value={tagKey} onChange={e => setTagKey(e.target.value)} placeholder="Key" style={{ width: 120 }} />
                    <input value={tagValue} onChange={e => setTagValue(e.target.value)} placeholder="Value" style={{ width: 160 }} />
                    <button type="button" className="svc-btn primary" onClick={() => void doAddTag()}>Add Tag</button>
                  </div>
                </>
              ) : <div className="svc-empty">Select a secret to manage tags.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
