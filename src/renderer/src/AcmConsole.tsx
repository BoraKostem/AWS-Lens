import { useEffect, useMemo, useState } from 'react'

import { deleteAcmCertificate, describeAcmCertificate, listAcmCertificates, requestAcmCertificate } from './api'
import type { AcmCertificateDetail, AcmCertificateSummary, AwsConnection } from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'domainName' | 'status' | 'type'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'domainName', label: 'Domain', color: '#3b82f6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'type', label: 'Type', color: '#f59e0b' },
]

function fmtTs(v: string) { return v && v !== '-' ? new Date(v).toLocaleString() : '-' }

export function AcmConsole({ connection }: { connection: AwsConnection }) {
  const [certs, setCerts] = useState<AcmCertificateSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedArn, setSelectedArn] = useState('')
  const [detail, setDetail] = useState<AcmCertificateDetail | null>(null)
  const [domainName, setDomainName] = useState('')
  const [sans, setSans] = useState('')
  const [validationMethod, setValidationMethod] = useState<'DNS' | 'EMAIL'>('DNS')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  async function refresh(nextArn?: string) {
    setError('')
    setLoading(true)
    try {
      const list = await listAcmCertificates(connection)
      setCerts(list)
      const target = nextArn ?? list.find(c => c.certificateArn === selectedArn)?.certificateArn ?? list[0]?.certificateArn ?? ''
      setSelectedArn(target)
      setDetail(target ? await describeAcmCertificate(connection, target) : null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

useEffect(() => { void refresh() }, [connection.sessionId, connection.region])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))
  const filteredCerts = useMemo(() => {
    if (!filter) return certs
    const q = filter.toLowerCase()
    return certs.filter(c => (c.domainName ?? '').toLowerCase().includes(q) || c.status.toLowerCase().includes(q))
  }, [certs, filter])

  async function doRequest() {
    if (!domainName) return
    setError('')
    try {
      const arn = await requestAcmCertificate(connection, {
        domainName, subjectAlternativeNames: sans.split(',').map(s => s.trim()).filter(Boolean), validationMethod
      })
      setDomainName(''); setSans(''); setMsg('Certificate requested')
      await refresh(arn)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function doDelete() {
    if (!selectedArn) return
    setError('')
    try {
      await deleteAcmCertificate(connection, selectedArn)
      setMsg('Certificate deleted')
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Certificates</button>
        <button className="svc-tab right" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
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
              {!loading && filteredCerts.map(c => (
                <tr key={c.certificateArn} className={c.certificateArn === selectedArn ? 'active' : ''} onClick={() => void refresh(c.certificateArn)}>
                  {activeCols.map(col => (
                    <td key={col.key}>
                      {col.key === 'status' ? <span className={`svc-badge ${c.status === 'ISSUED' ? 'ok' : c.status === 'PENDING_VALIDATION' ? 'warn' : c.status === 'REVOKED' ? 'danger' : 'muted'}`}>{c.status}</span>
                       : col.key === 'domainName' ? (c.domainName || c.certificateArn) : (c[col.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredCerts.length && !loading && <div className="svc-empty">No certificates found.</div>}
        </div>

        <div className="svc-sidebar">
          {/* Request */}
          <div className="svc-section">
            <h3>Request Certificate</h3>
            <div className="svc-form">
              <label><span>Domain</span><input value={domainName} onChange={e => setDomainName(e.target.value)} placeholder="example.com" /></label>
              <label><span>Validation</span><select value={validationMethod} onChange={e => setValidationMethod(e.target.value as 'DNS' | 'EMAIL')}><option value="DNS">DNS</option><option value="EMAIL">EMAIL</option></select></label>
              <label><span>SANs</span><input value={sans} onChange={e => setSans(e.target.value)} placeholder="www.example.com, api.example.com" /></label>
            </div>
            <button type="button" className="svc-btn success" disabled={!domainName} onClick={() => void doRequest()}>Request</button>
          </div>

          {/* Detail */}
          <div className="svc-section">
            <h3>Certificate Detail</h3>
            {detail ? (
              <>
                <div className="svc-kv">
                  <div className="svc-kv-row"><div className="svc-kv-label">Domain</div><div className="svc-kv-value">{detail.domainName}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Status</div><div className="svc-kv-value">{detail.status}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Type</div><div className="svc-kv-value">{detail.type || '-'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Issued</div><div className="svc-kv-value">{fmtTs(detail.issuedAt)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Expires</div><div className="svc-kv-value">{fmtTs(detail.notAfter)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">In Use By</div><div className="svc-kv-value">{detail.inUseBy.length}</div></div>
                </div>
                {detail.domainValidationOptions.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <h3 style={{ fontSize: 12, margin: '0 0 6px' }}>Validation</h3>
                    <table className="svc-table" style={{ fontSize: 11 }}>
                      <thead><tr><th>Domain</th><th>Status</th><th>DNS Record</th></tr></thead>
                      <tbody>
                        {detail.domainValidationOptions.map(v => (
                          <tr key={v.domainName}>
                            <td>{v.domainName}</td>
                            <td>{v.validationStatus || '-'}</td>
                            <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{v.resourceRecordName ? `${v.resourceRecordName} ${v.resourceRecordType} ${v.resourceRecordValue}` : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ marginTop: 12 }}>
                  <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete()}>Delete Certificate</ConfirmButton>
                </div>
              </>
            ) : <div className="svc-empty">Select a certificate.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
