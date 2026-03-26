import { useEffect, useMemo, useState } from 'react'

import type { AcmCertificateDetail, AcmCertificateSummary, AwsConnection, Route53RecordChange } from '@shared/types'
import { ConfirmButton } from './ConfirmButton'
import { deleteAcmCertificate, describeAcmCertificate, listAcmCertificates, requestAcmCertificate } from './api'

type ColKey = 'domainName' | 'status' | 'expires' | 'daysUntilExpiry' | 'renewal' | 'validation' | 'usage'
type SortKey = 'domainName' | 'status' | 'notAfter' | 'daysUntilExpiry' | 'renewalStatus' | 'pendingValidationCount' | 'inUseByCount'
type SummaryBucket = 'all' | 'expiring7' | 'expiring30' | 'pending' | 'unused'
type UsageFilter = 'all' | 'in-use' | 'unused'
type StatusFilter = 'all' | 'issued' | 'pending_validation' | 'problem'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'domainName', label: 'Certificate', color: '#3b82f6' },
  { key: 'status', label: 'Status', color: '#ef4444' },
  { key: 'expires', label: 'Expires', color: '#f59e0b' },
  { key: 'daysUntilExpiry', label: 'Days', color: '#eab308' },
  { key: 'renewal', label: 'Renewal', color: '#14b8a6' },
  { key: 'validation', label: 'Validation', color: '#a855f7' },
  { key: 'usage', label: 'Usage', color: '#22c55e' }
]

function fmtTs(value: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

function fmtDays(value: number | null): string {
  if (value === null) {
    return '-'
  }
  if (value < 0) {
    return `${Math.abs(value)}d overdue`
  }
  if (value === 0) {
    return 'today'
  }
  return `${value}d`
}

function badgeClass(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_')
  return normalized || 'muted'
}

function severityBadgeClass(severity: AcmCertificateSummary['urgencySeverity']): string {
  switch (severity) {
    case 'critical':
      return 'danger'
    case 'warning':
      return 'warn'
    case 'stable':
      return 'ok'
    default:
      return 'muted'
  }
}

function getValidationRecord(option: AcmCertificateDetail['domainValidationOptions'][number]): Route53RecordChange | null {
  if (!option.resourceRecordName || !option.resourceRecordType || !option.resourceRecordValue) {
    return null
  }

  return {
    name: option.resourceRecordName,
    type: option.resourceRecordType,
    ttl: 300,
    values: [option.resourceRecordValue],
    isAlias: false,
    aliasDnsName: '',
    aliasHostedZoneId: '',
    evaluateTargetHealth: false,
    setIdentifier: ''
  }
}

function matchesSummaryBucket(cert: AcmCertificateSummary, bucket: SummaryBucket): boolean {
  switch (bucket) {
    case 'expiring7':
      return cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= 7
    case 'expiring30':
      return cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= 30
    case 'pending':
      return cert.status === 'PENDING_VALIDATION' || cert.pendingValidationCount > 0
    case 'unused':
      return cert.unused
    default:
      return true
  }
}

function sortValue(cert: AcmCertificateSummary, key: SortKey): string | number {
  switch (key) {
    case 'domainName':
      return cert.domainName || cert.certificateArn
    case 'status':
      return cert.status
    case 'notAfter':
      return cert.notAfter ? Date.parse(cert.notAfter) : Number.MAX_SAFE_INTEGER
    case 'daysUntilExpiry':
      return cert.daysUntilExpiry ?? Number.MAX_SAFE_INTEGER
    case 'renewalStatus':
      return cert.renewalStatus || cert.renewalEligibility
    case 'pendingValidationCount':
      return cert.pendingValidationCount + cert.dnsValidationIssueCount
    case 'inUseByCount':
      return cert.inUseByCount
  }
}

export function AcmConsole({
  connection,
  onOpenRoute53 = () => undefined,
  onOpenLoadBalancer = () => undefined
}: {
  connection: AwsConnection
  onOpenRoute53?: (record: Route53RecordChange) => void
  onOpenLoadBalancer?: (loadBalancerArn: string) => void
}) {
  const [certs, setCerts] = useState<AcmCertificateSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedArn, setSelectedArn] = useState('')
  const [detail, setDetail] = useState<AcmCertificateDetail | null>(null)
  const [domainName, setDomainName] = useState('')
  const [sans, setSans] = useState('')
  const [validationMethod, setValidationMethod] = useState<'DNS' | 'EMAIL'>('DNS')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [summaryBucket, setSummaryBucket] = useState<SummaryBucket>('all')
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('daysUntilExpiry')
  const [sortAsc, setSortAsc] = useState(true)
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))

  async function loadDetail(certificateArn: string): Promise<void> {
    if (!certificateArn) {
      setSelectedArn('')
      setDetail(null)
      return
    }

    setDetailLoading(true)
    try {
      setSelectedArn(certificateArn)
      setDetail(await describeAcmCertificate(connection, certificateArn))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setDetailLoading(false)
    }
  }

  async function refresh(nextArn?: string): Promise<void> {
    setError('')
    setLoading(true)
    try {
      const list = await listAcmCertificates(connection)
      setCerts(list)
      const targetArn = nextArn ?? list.find((cert) => cert.certificateArn === selectedArn)?.certificateArn ?? list[0]?.certificateArn ?? ''
      if (targetArn) {
        await loadDetail(targetArn)
      } else {
        setSelectedArn('')
        setDetail(null)
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [connection.sessionId, connection.region])

  const activeCols = COLUMNS.filter((column) => visCols.has(column.key))

  const summaryCounts = useMemo(() => ({
    all: certs.length,
    expiring7: certs.filter((cert) => cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= 7).length,
    expiring30: certs.filter((cert) => cert.daysUntilExpiry !== null && cert.daysUntilExpiry <= 30).length,
    pending: certs.filter((cert) => cert.status === 'PENDING_VALIDATION' || cert.pendingValidationCount > 0).length,
    unused: certs.filter((cert) => cert.unused).length
  }), [certs])

  const filteredCerts = useMemo(() => {
    const query = filter.trim().toLowerCase()
    const next = certs.filter((cert) => {
      if (!matchesSummaryBucket(cert, summaryBucket)) {
        return false
      }

      if (usageFilter === 'in-use' && !cert.inUse) {
        return false
      }
      if (usageFilter === 'unused' && !cert.unused) {
        return false
      }

      if (statusFilter === 'issued' && cert.status !== 'ISSUED') {
        return false
      }
      if (statusFilter === 'pending_validation' && cert.status !== 'PENDING_VALIDATION') {
        return false
      }
      if (statusFilter === 'problem' && cert.urgencySeverity !== 'critical' && cert.dnsValidationIssueCount === 0) {
        return false
      }

      if (!query) {
        return true
      }

      return [
        cert.domainName,
        cert.status,
        cert.type,
        cert.renewalEligibility,
        cert.renewalStatus,
        cert.urgencyReason,
        cert.loadBalancerAssociations.map((item) => item.loadBalancerName).join(' '),
        cert.inUseAssociations.map((item) => item.label).join(' ')
      ].join(' ').toLowerCase().includes(query)
    })

    return next.sort((left, right) => {
      const leftValue = sortValue(left, sortKey)
      const rightValue = sortValue(right, sortKey)
      const direction = sortAsc ? 1 : -1
      if (leftValue < rightValue) {
        return -1 * direction
      }
      if (leftValue > rightValue) {
        return 1 * direction
      }
      return left.domainName.localeCompare(right.domainName)
    })
  }, [certs, filter, sortAsc, sortKey, statusFilter, summaryBucket, usageFilter])

  async function doRequest(): Promise<void> {
    if (!domainName) {
      return
    }

    setError('')
    try {
      const arn = await requestAcmCertificate(connection, {
        domainName,
        subjectAlternativeNames: sans.split(',').map((item) => item.trim()).filter(Boolean),
        validationMethod
      })
      setDomainName('')
      setSans('')
      setMsg('Certificate requested.')
      await refresh(arn)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  async function doDelete(): Promise<void> {
    if (!selectedArn) {
      return
    }

    setError('')
    try {
      await deleteAcmCertificate(connection, selectedArn)
      setMsg('Certificate deleted.')
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  async function copyText(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setMsg(`${label} copied.`)
    } catch {
      setError(`Unable to copy ${label.toLowerCase()}.`)
    }
  }

  const selectedSummary = certs.find((cert) => cert.certificateArn === selectedArn) ?? null

  return (
    <div className="svc-console acm-watch">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Certificate Watch</button>
        <button className="svc-tab right" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      <div className="svc-stat-strip">
        <button type="button" className={`svc-stat-card acm-watch-card ${summaryBucket === 'all' ? 'active' : ''}`} onClick={() => setSummaryBucket('all')}>
          <span>All Certificates</span>
          <strong>{summaryCounts.all}</strong>
        </button>
        <button type="button" className={`svc-stat-card acm-watch-card critical ${summaryBucket === 'expiring7' ? 'active' : ''}`} onClick={() => setSummaryBucket('expiring7')}>
          <span>Expiring In 7d</span>
          <strong>{summaryCounts.expiring7}</strong>
        </button>
        <button type="button" className={`svc-stat-card acm-watch-card warning ${summaryBucket === 'expiring30' ? 'active' : ''}`} onClick={() => setSummaryBucket('expiring30')}>
          <span>Expiring In 30d</span>
          <strong>{summaryCounts.expiring30}</strong>
        </button>
        <button type="button" className={`svc-stat-card acm-watch-card warning ${summaryBucket === 'pending' ? 'active' : ''}`} onClick={() => setSummaryBucket('pending')}>
          <span>Pending Validation</span>
          <strong>{summaryCounts.pending}</strong>
        </button>
        <button type="button" className={`svc-stat-card acm-watch-card ${summaryBucket === 'unused' ? 'active' : ''}`} onClick={() => setSummaryBucket('unused')}>
          <span>Unused</span>
          <strong>{summaryCounts.unused}</strong>
        </button>
      </div>

      <div className="svc-panel acm-watch-toolbar">
        <div className="svc-inline">
          <input
            className="svc-search"
            placeholder="Filter by domain, status, renewal, or attached resource..."
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <select className="svc-select" value={usageFilter} onChange={(event) => setUsageFilter(event.target.value as UsageFilter)}>
            <option value="all">All usage</option>
            <option value="in-use">In use</option>
            <option value="unused">Unused</option>
          </select>
          <select className="svc-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">All status</option>
            <option value="issued">Issued</option>
            <option value="pending_validation">Pending validation</option>
            <option value="problem">Problems</option>
          </select>
          <select className="svc-select" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="daysUntilExpiry">Sort: Days to expiry</option>
            <option value="notAfter">Sort: Expiry timestamp</option>
            <option value="domainName">Sort: Domain</option>
            <option value="renewalStatus">Sort: Renewal</option>
            <option value="pendingValidationCount">Sort: Validation blockers</option>
            <option value="inUseByCount">Sort: Associations</option>
          </select>
          <button type="button" className="svc-btn muted" onClick={() => setSortAsc((current) => !current)}>
            {sortAsc ? 'Ascending' : 'Descending'}
          </button>
        </div>
      </div>

      <div className="svc-chips">
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            className={`svc-chip ${visCols.has(column.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(column.key) ? { background: column.color, borderColor: column.color } : undefined}
            onClick={() => setVisCols((current) => {
              const next = new Set(current)
              if (next.has(column.key)) {
                next.delete(column.key)
              } else {
                next.add(column.key)
              }
              return next
            })}
          >
            {column.label}
          </button>
        ))}
      </div>

      <div className="svc-layout">
        <div className="svc-table-area">
          <table className="svc-table">
            <thead>
              <tr>
                {activeCols.map((column) => <th key={column.key}>{column.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length}>Gathering certificate data</td></tr>}
              {!loading && filteredCerts.map((cert) => (
                <tr key={cert.certificateArn} className={cert.certificateArn === selectedArn ? 'active' : ''} onClick={() => void loadDetail(cert.certificateArn)}>
                  {activeCols.map((column) => {
                    if (column.key === 'domainName') {
                      return (
                        <td key={column.key}>
                          <div className="acm-watch-primary">{cert.domainName || cert.certificateArn}</div>
                          <div className="acm-watch-secondary">{cert.type || cert.certificateArn}</div>
                        </td>
                      )
                    }

                    if (column.key === 'status') {
                      return (
                        <td key={column.key}>
                          <div><span className={`svc-badge ${badgeClass(cert.status)}`}>{cert.status}</span></div>
                          <div className="acm-watch-secondary"><span className={`svc-badge ${severityBadgeClass(cert.urgencySeverity)}`}>{cert.urgencySeverity}</span></div>
                        </td>
                      )
                    }

                    if (column.key === 'expires') {
                      return (
                        <td key={column.key}>
                          <div>{fmtTs(cert.notAfter)}</div>
                          <div className="acm-watch-secondary">{cert.urgencyReason || 'No expiry data.'}</div>
                        </td>
                      )
                    }

                    if (column.key === 'daysUntilExpiry') {
                      return <td key={column.key}><span className={`svc-badge ${severityBadgeClass(cert.urgencySeverity)}`}>{fmtDays(cert.daysUntilExpiry)}</span></td>
                    }

                    if (column.key === 'renewal') {
                      return (
                        <td key={column.key}>
                          <div>{cert.renewalStatus || '-'}</div>
                          <div className="acm-watch-secondary">{cert.renewalEligibility || '-'}</div>
                        </td>
                      )
                    }

                    if (column.key === 'validation') {
                      return (
                        <td key={column.key}>
                          <div>{cert.pendingValidationCount > 0 ? `${cert.pendingValidationCount} pending` : 'clear'}</div>
                          <div className="acm-watch-secondary">{cert.dnsValidationIssueCount > 0 ? `${cert.dnsValidationIssueCount} DNS blockers` : 'no blockers'}</div>
                        </td>
                      )
                    }

                    return (
                      <td key={column.key}>
                        <div>{cert.inUse ? `${cert.inUseByCount} associations` : 'unused'}</div>
                        <div className="acm-watch-secondary">
                          {cert.loadBalancerAssociations.length > 0 ? `${cert.loadBalancerAssociations.length} load balancer` : 'not attached'}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredCerts.length && !loading && <div className="svc-empty">No certificates match the current watch filters.</div>}
        </div>

        <div className="svc-sidebar">
          <div className="svc-section">
            <h3>Watch Summary</h3>
            {selectedSummary ? (
              <>
                <div className="svc-kv">
                  <div className="svc-kv-row"><div className="svc-kv-label">Certificate</div><div className="svc-kv-value">{selectedSummary.domainName || selectedSummary.certificateArn}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Urgency</div><div className="svc-kv-value"><span className={`svc-badge ${severityBadgeClass(selectedSummary.urgencySeverity)}`}>{selectedSummary.urgencySeverity}</span> {selectedSummary.urgencyReason}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Expiry</div><div className="svc-kv-value">{fmtTs(selectedSummary.notAfter)} ({fmtDays(selectedSummary.daysUntilExpiry)})</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Renewal</div><div className="svc-kv-value">{selectedSummary.renewalStatus || '-'} / {selectedSummary.renewalEligibility || '-'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Associations</div><div className="svc-kv-value">{selectedSummary.inUse ? `${selectedSummary.inUseByCount} in-use references` : 'Unused certificate'}</div></div>
                </div>
                <div className="svc-btn-row" style={{ marginTop: 12 }}>
                  <button type="button" className="svc-btn muted" onClick={() => void copyText(selectedSummary.certificateArn, 'Certificate ARN')}>Copy ARN</button>
                  {selectedSummary.loadBalancerAssociations[0] && (
                    <button type="button" className="svc-btn primary" onClick={() => onOpenLoadBalancer(selectedSummary.loadBalancerAssociations[0].loadBalancerArn)}>
                      Open Load Balancer
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="svc-empty">Select a certificate to inspect its watch status.</div>
            )}
          </div>

          <div className="svc-section">
            <h3>Request Certificate</h3>
            <div className="svc-form">
              <label><span>Domain</span><input value={domainName} onChange={(event) => setDomainName(event.target.value)} placeholder="example.com" /></label>
              <label><span>Validation</span><select value={validationMethod} onChange={(event) => setValidationMethod(event.target.value as 'DNS' | 'EMAIL')}><option value="DNS">DNS</option><option value="EMAIL">EMAIL</option></select></label>
              <label><span>SANs</span><input value={sans} onChange={(event) => setSans(event.target.value)} placeholder="www.example.com, api.example.com" /></label>
            </div>
            <button type="button" className="svc-btn success" disabled={!domainName} onClick={() => void doRequest()}>Request</button>
          </div>

          <div className="svc-section">
            <h3>Certificate Detail</h3>
            {detail ? (
              <>
                {detailLoading && <div className="svc-section-hint">Refreshing detail...</div>}
                <div className="svc-kv">
                  <div className="svc-kv-row"><div className="svc-kv-label">Status</div><div className="svc-kv-value"><span className={`svc-badge ${badgeClass(detail.status)}`}>{detail.status}</span></div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Validity</div><div className="svc-kv-value">{fmtTs(detail.notBefore)} to {fmtTs(detail.notAfter)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Days Until Expiry</div><div className="svc-kv-value">{fmtDays(detail.daysUntilExpiry)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Renewal</div><div className="svc-kv-value">{detail.renewalStatus || '-'} / {detail.renewalEligibility || '-'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Algorithms</div><div className="svc-kv-value">{detail.keyAlgorithm || '-'} / {detail.signatureAlgorithm || '-'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">SANs</div><div className="svc-kv-value">{detail.subjectAlternativeNames.join(', ') || '-'}</div></div>
                </div>

                <div style={{ marginTop: 14 }}>
                  <h3 style={{ fontSize: 12, margin: '0 0 8px' }}>Validation Watch</h3>
                  <table className="svc-table" style={{ fontSize: 11 }}>
                    <thead>
                      <tr><th>Domain</th><th>Status</th><th>DNS</th><th>Action</th></tr>
                    </thead>
                    <tbody>
                      {detail.domainValidationOptions.map((option) => {
                        const record = getValidationRecord(option)
                        const dnsValue = record ? `${option.resourceRecordName} ${option.resourceRecordType} ${option.resourceRecordValue}` : option.validationIssue || '-'
                        return (
                          <tr key={`${option.domainName}-${option.validationMethod}`}>
                            <td>{option.domainName}</td>
                            <td>
                              <div><span className={`svc-badge ${badgeClass(option.validationStatus)}`}>{option.validationStatus || '-'}</span></div>
                              {option.validationIssue && <div className="acm-watch-secondary acm-watch-danger">{option.validationIssue}</div>}
                            </td>
                            <td style={{ whiteSpace: 'normal', fontFamily: 'monospace', fontSize: 10 }}>{dnsValue}</td>
                            <td>
                              <div className="svc-btn-row">
                                {record && <button type="button" className="svc-btn muted" onClick={() => void copyText(`${record.name} ${record.type} ${record.values[0]}`, 'Validation record')}>Copy</button>}
                                {record && <button type="button" className="svc-btn primary" onClick={() => onOpenRoute53(record)}>Route 53</button>}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {detail.domainValidationOptions.length === 0 && <div className="svc-empty">No validation details returned.</div>}
                </div>

                <div style={{ marginTop: 14 }}>
                  <h3 style={{ fontSize: 12, margin: '0 0 8px' }}>Resource Associations</h3>
                  {detail.loadBalancerAssociations.length > 0 && (
                    <div className="svc-list" style={{ marginBottom: 10 }}>
                      {detail.loadBalancerAssociations.map((association) => (
                        <button key={`${association.loadBalancerArn}-${association.listenerArn}`} type="button" className="svc-list-item" onClick={() => onOpenLoadBalancer(association.loadBalancerArn)}>
                          <div className="svc-list-title">{association.loadBalancerName}</div>
                          <div className="svc-list-meta">{association.listenerProtocol}:{association.listenerPort} · {association.dnsName || association.loadBalancerArn}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  {detail.inUseAssociations.length > 0 && (
                    <div className="svc-code">{detail.inUseAssociations.map((association) => association.label).join('\n')}</div>
                  )}
                  {detail.loadBalancerAssociations.length === 0 && detail.inUseAssociations.length === 0 && (
                    <div className="svc-empty">This certificate is currently unused.</div>
                  )}
                </div>

                <div style={{ marginTop: 12 }}>
                  <ConfirmButton className="svc-btn danger" onConfirm={() => void doDelete()}>Delete Certificate</ConfirmButton>
                </div>
              </>
            ) : (
              <div className="svc-empty">Select a certificate.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
