import { useEffect, useMemo, useState } from 'react'

import { decryptCiphertext, describeKmsKey, listKmsKeys } from './api'
import type { AwsConnection, KmsKeyDetail, KmsKeySummary } from '@shared/types'

type ColKey = 'alias' | 'keyId' | 'keyState' | 'keyUsage'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'alias', label: 'Alias', color: '#3b82f6' },
  { key: 'keyId', label: 'KeyId', color: '#14b8a6' },
  { key: 'keyState', label: 'State', color: '#22c55e' },
  { key: 'keyUsage', label: 'Usage', color: '#f59e0b' },
]

function getVal(k: KmsKeySummary, col: ColKey) {
  if (col === 'alias') return k.aliasNames[0] || k.keyId
  return k[col] ?? '-'
}

function fmtTs(v: string) { return v && v !== '-' ? new Date(v).toLocaleString() : '-' }

export function KmsConsole({ connection }: { connection: AwsConnection }) {
  const [keys, setKeys] = useState<KmsKeySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState('')
  const [detail, setDetail] = useState<KmsKeyDetail | null>(null)
  const [ciphertext, setCiphertext] = useState('')
  const [plaintext, setPlaintext] = useState('')
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  async function refresh(nextKeyId?: string) {
    setError('')
    setLoading(true)
    try {
      const list = await listKmsKeys(connection)
      setKeys(list)
      const target = nextKeyId ?? list.find(k => k.keyId === selectedKeyId)?.keyId ?? list[0]?.keyId ?? ''
      setSelectedKeyId(target)
      setDetail(target ? await describeKmsKey(connection, target) : null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [connection.profile, connection.region])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))

  const filteredKeys = useMemo(() => {
    if (!filter) return keys
    const q = filter.toLowerCase()
    return keys.filter(k => (k.aliasNames[0] ?? '').toLowerCase().includes(q) || k.keyId.toLowerCase().includes(q))
  }, [keys, filter])

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">KMS Keys</button>
        <button className="svc-tab right" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {error && <div className="svc-error">{error}</div>}

      <input className="svc-search" placeholder="Filter rows across selected columns..." value={filter} onChange={e => setFilter(e.target.value)} />

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

      <div className="svc-layout">
        <div className="svc-table-area">
          <table className="svc-table">
            <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length}>Gathering data</td></tr>}
              {!loading && filteredKeys.map(k => (
                <tr key={k.keyId} className={k.keyId === selectedKeyId ? 'active' : ''} onClick={() => void refresh(k.keyId)}>
                  {activeCols.map(c => (
                    <td key={c.key}>
                      {c.key === 'keyState' ? <span className={`svc-badge ${k.keyState === 'Enabled' ? 'ok' : k.keyState === 'Disabled' ? 'danger' : 'muted'}`}>{k.keyState}</span> : getVal(k, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredKeys.length && !loading && <div className="svc-empty">No KMS keys found.</div>}
        </div>

        <div className="svc-sidebar">
          <div className="svc-section">
            <h3>Key Details</h3>
            {detail ? (
              <div className="svc-kv">
                <div className="svc-kv-row"><div className="svc-kv-label">Key ID</div><div className="svc-kv-value">{detail.keyId}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Aliases</div><div className="svc-kv-value">{detail.aliasNames.join(', ') || '-'}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">State</div><div className="svc-kv-value">{detail.keyState}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Manager</div><div className="svc-kv-value">{detail.keyManager}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Created</div><div className="svc-kv-value">{fmtTs(detail.creationDate)}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Algorithms</div><div className="svc-kv-value">{detail.encryptionAlgorithms.join(', ') || detail.signingAlgorithms.join(', ') || '-'}</div></div>
              </div>
            ) : <div className="svc-empty">Select a KMS key.</div>}
          </div>

          <div className="svc-section">
            <h3>Decrypt Tool</h3>
            <div className="svc-form">
              <label><span>Ciphertext</span><textarea value={ciphertext} onChange={e => setCiphertext(e.target.value)} placeholder="Base64 ciphertext blob" /></label>
            </div>
            <div className="svc-btn-row">
              <button type="button" className="svc-btn primary" onClick={() => {
                void decryptCiphertext(connection, ciphertext).then(r => setPlaintext(r.plaintext || r.plaintextBase64)).catch(e => setError(String(e)))
              }}>Decrypt</button>
            </div>
            {plaintext && <pre className="svc-code" style={{ marginTop: 10, maxHeight: 140, overflow: 'auto' }}>{plaintext}</pre>}
          </div>
        </div>
      </div>
    </div>
  )
}
