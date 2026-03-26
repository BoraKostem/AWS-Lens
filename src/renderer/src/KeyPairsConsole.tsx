import { useEffect, useMemo, useState } from 'react'

import { createKeyPair, deleteKeyPair, listKeyPairs } from './api'
import type { AwsConnection, KeyPairSummary } from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'keyName' | 'keyPairId' | 'keyType' | 'fingerprint' | 'createdAt'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'keyName', label: 'Name', color: '#3b82f6' },
  { key: 'keyPairId', label: 'ID', color: '#14b8a6' },
  { key: 'keyType', label: 'Type', color: '#8b5cf6' },
  { key: 'fingerprint', label: 'Fingerprint', color: '#f59e0b' },
  { key: 'createdAt', label: 'Created', color: '#06b6d4' },
]

function fmtTs(v: string) { return v && v !== '-' ? new Date(v).toLocaleString() : '-' }

export function KeyPairsConsole({ connection }: { connection: AwsConnection }) {
  const [pairs, setPairs] = useState<KeyPairSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedName, setSelectedName] = useState('')
  const [newKeyName, setNewKeyName] = useState('')
  const [download, setDownload] = useState<{ name: string; material: string } | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  async function refresh(nextName?: string) {
    setError('')
    setLoading(true)
    try {
      const list = await listKeyPairs(connection)
      setPairs(list)
      setSelectedName(nextName ?? list.find(p => p.keyName === selectedName)?.keyName ?? list[0]?.keyName ?? '')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

useEffect(() => { void refresh() }, [connection.sessionId, connection.region])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))

  const filteredPairs = useMemo(() => {
    if (!filter) return pairs
    const q = filter.toLowerCase()
    return pairs.filter(p => p.keyName.toLowerCase().includes(q) || (p.keyPairId ?? '').toLowerCase().includes(q))
  }, [pairs, filter])

  function getVal(p: KeyPairSummary, k: ColKey) {
    if (k === 'createdAt') return fmtTs(p.createdAt)
    return p[k] ?? '-'
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
    if (!newKeyName) return
    try {
      const created = await createKeyPair(connection, newKeyName)
      setDownload({ name: created.keyName, material: created.keyMaterial })
      setNewKeyName('')
      setMsg(`Key pair "${created.keyName}" created`)
      await refresh(created.keyName)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDelete(name: string) {
    try {
      await deleteKeyPair(connection, name)
      setMsg(`Key pair "${name}" deleted`)
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Key Pairs</button>
        <button className="svc-tab right" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* Create section */}
      <div className="svc-panel">
        <h3>Create Key Pair</h3>
        <div className="svc-inline">
          <input placeholder="my-admin-key" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} />
          <button type="button" className="svc-btn success" disabled={!newKeyName} onClick={() => void doCreate()}>Create</button>
          {download && <button type="button" className="svc-btn primary" onClick={downloadPrivateKey}>Download Private Key</button>}
        </div>
        {download && <pre className="svc-code" style={{ marginTop: 10, maxHeight: 120, overflow: 'auto' }}>{download.material}</pre>}
      </div>

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

      <div className="svc-table-area" style={{ borderRadius: 6, border: '1px solid #3b4350' }}>
        <table className="svc-table">
          <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}<th>Actions</th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={activeCols.length + 1}>Gathering data</td></tr>}
            {!loading && filteredPairs.map(p => (
              <tr key={p.keyName} className={p.keyName === selectedName ? 'active' : ''} onClick={() => setSelectedName(p.keyName)}>
                {activeCols.map(c => <td key={c.key}>{getVal(p, c.key)}</td>)}
                <td>
                  <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete(p.keyName)}>Delete</ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredPairs.length && !loading && <div className="svc-empty">No key pairs found.</div>}
      </div>
    </div>
  )
}
