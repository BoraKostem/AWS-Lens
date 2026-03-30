import { useEffect, useMemo, useState } from 'react'
import './terraform.css'
import './acm.css'
import { SvcState } from './SvcState'

import type { AcmCertificateDetail, AcmCertificateSummary, AwsConnection, Route53RecordChange } from '@shared/types'
import { ConfirmButton } from './ConfirmButton'
import { deleteAcmCertificate, describeAcmCertificate, listAcmCertificates, requestAcmCertificate } from './api'

type ColKey = 'domainName' | 'status' | 'expires' | 'daysUntilExpiry' | 'renewal' | 'validation' | 'usage'
type SortKey = 'domainName' | 'status' | 'notAfter' | 'daysUntilExpiry' | 'renewalStatus' | 'pendingValidationCount' | 'inUseByCount'
type SummaryBucket = 'all' | 'expiring7' | 'expiring30' | 'pending' | 'unused'
type UsageFilter = 'all' | 'in-use' | 'unused'
type StatusFilter = 'all' | 'issued' | 'pending_validation' | 'problem'
type AcmTone = 'danger' | 'warning' | 'success' | 'info'

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

function severityTone(severity: AcmCertificateSummary['urgencySeverity'] | undefined): AcmTone {
  switch (severity) {
    case 'critical':
      return 'danger'
    case 'warning':
      return 'warning'
    case 'stable':
      return 'success'
    default:
      return 'info'
  }
}

function statusTone(status: string | undefined): AcmTone {
  switch (status) {
    case 'ISSUED':
      return 'success'
    case 'PENDING_VALIDATION':
      return 'warning'
    case 'FAILED':
    case 'EXPIRED':
    case 'REVOKED':
      return 'danger'
    default:
      return 'info'
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
  onOpenLoadBalancer = () => undefined,
  onOpenWaf = () => undefined
}: {
  connection: AwsConnection
  onOpenRoute53?: (record: Route53RecordChange) => void
  onOpenLoadBalancer?: (loadBalancerArn: string) => void
  onOpenWaf?: (webAclName: string) => void
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
  const visibleCount = filteredCerts.length
  const inUseCount = certs.filter((cert) => cert.inUse).length
  const detailValidationPending = detail?.domainValidationOptions.filter((option) => option.validationStatus !== 'SUCCESS').length ?? 0
  const detailAssociationCount = (detail?.loadBalancerAssociations.length ?? 0) + (detail?.inUseAssociations.length ?? 0)

  return (
    <div className="tf-console acm-shell">
      <section className="tf-shell-hero acm-shell-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">ACM service</div>
          <h2>{selectedSummary?.domainName || 'Certificate watchtower'}</h2>
          <p>
            {selectedSummary
              ? `Inspect expiry posture, validation blockers, renewal state, and downstream associations for ${selectedSummary.domainName || selectedSummary.certificateArn}.`
              : 'Track certificate freshness, request new certificates, and follow validation or association issues from a single ACM workspace.'}
          </p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.profile || 'AWS session'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region || 'global'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Selection</span>
              <strong>{selectedSummary ? (selectedSummary.domainName || selectedSummary.certificateArn) : 'No certificate selected'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Validation</span>
              <strong>{selectedSummary?.pendingValidationCount ? `${selectedSummary.pendingValidationCount} pending checks` : 'Validation clear'}</strong>
            </div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <button type="button" className={`tf-shell-stat-card tf-shell-stat-card-accent acm-hero-card ${summaryBucket === 'all' ? 'active' : ''}`} onClick={() => setSummaryBucket('all')}>
            <span>Certificates</span>
            <strong>{summaryCounts.all}</strong>
            <small>{visibleCount} visible after filters</small>
          </button>
          <button type="button" className={`tf-shell-stat-card acm-hero-card ${summaryBucket === 'expiring7' ? 'active' : ''}`} onClick={() => setSummaryBucket('expiring7')}>
            <span>Expiring in 7d</span>
            <strong>{summaryCounts.expiring7}</strong>
            <small>Critical renewal watchlist</small>
          </button>
          <button type="button" className={`tf-shell-stat-card acm-hero-card ${summaryBucket === 'pending' ? 'active' : ''}`} onClick={() => setSummaryBucket('pending')}>
            <span>Pending validation</span>
            <strong>{summaryCounts.pending}</strong>
            <small>DNS or email confirmation required</small>
          </button>
          <button type="button" className={`tf-shell-stat-card acm-hero-card ${summaryBucket === 'unused' ? 'active' : ''}`} onClick={() => setSummaryBucket('unused')}>
            <span>Unused</span>
            <strong>{summaryCounts.unused}</strong>
            <small>Candidate cleanup inventory</small>
          </button>
        </div>
      </section>

      <div className="tf-shell-toolbar acm-toolbar">
        <div className="tf-toolbar acm-toolbar-controls">
          <input
            className="acm-toolbar-search"
            placeholder="Filter by domain, status, renewal, or attached resource..."
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <select className="acm-toolbar-select" value={usageFilter} onChange={(event) => setUsageFilter(event.target.value as UsageFilter)}>
            <option value="all">All usage</option>
            <option value="in-use">In use</option>
            <option value="unused">Unused</option>
          </select>
          <select className="acm-toolbar-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">All status</option>
            <option value="issued">Issued</option>
            <option value="pending_validation">Pending validation</option>
            <option value="problem">Problems</option>
          </select>
          <select className="acm-toolbar-select" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
            <option value="daysUntilExpiry">Sort: Days to expiry</option>
            <option value="notAfter">Sort: Expiry timestamp</option>
            <option value="domainName">Sort: Domain</option>
            <option value="renewalStatus">Sort: Renewal</option>
            <option value="pendingValidationCount">Sort: Validation blockers</option>
            <option value="inUseByCount">Sort: Associations</option>
          </select>
          <button type="button" className="tf-toolbar-btn" onClick={() => setSortAsc((current) => !current)}>
            {sortAsc ? 'Ascending' : 'Descending'}
          </button>
          <button type="button" className="tf-toolbar-btn accent" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div className="tf-shell-status acm-toolbar-status">
          <div className="acm-toolbar-request">
            <div className="acm-toolbar-request-head">
              <span>Request certificate</span>
              <strong>{visibleCount} visible, {inUseCount} attached</strong>
            </div>
            <div className="acm-request-form acm-request-form-compact">
              <label><span>Domain</span><input value={domainName} onChange={(event) => setDomainName(event.target.value)} placeholder="example.com" /></label>
              <label><span>Validation</span><select value={validationMethod} onChange={(event) => setValidationMethod(event.target.value as 'DNS' | 'EMAIL')}><option value="DNS">DNS</option><option value="EMAIL">EMAIL</option></select></label>
              <label><span>SANs</span><input value={sans} onChange={(event) => setSans(event.target.value)} placeholder="www.example.com, api.example.com" /></label>
            </div>
            <button type="button" className="tf-toolbar-btn accent" disabled={!domainName} onClick={() => void doRequest()}>Request</button>
          </div>
        </div>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <SvcState variant="error" error={error} />}

      <div className="acm-column-toggles">
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            className={`acm-column-chip ${visCols.has(column.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(column.key) ? { borderColor: column.color, color: column.color } : undefined}
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

      <div className="tf-main-layout acm-main-layout">
        <div className="tf-project-table-area acm-inventory-pane">
          <div className="tf-pane-head">
            <div>
              <span className="tf-pane-kicker">Certificate inventory</span>
              <h3>Watch list</h3>
            </div>
            <span className="tf-pane-summary">{visibleCount} shown</span>
          </div>

          <div className="tf-linked-list acm-summary-grid">
            <button type="button" className={`tf-linked-card acm-summary-card ${summaryBucket === 'expiring30' ? 'active' : ''}`} onClick={() => setSummaryBucket('expiring30')}>
              <span className="tf-status-badge warning">30d watch</span>
              <div className="acm-summary-card-copy">
                <strong>{summaryCounts.expiring30}</strong>
                <span>Certificates expiring inside 30 days.</span>
              </div>
            </button>
            <button type="button" className={`tf-linked-card acm-summary-card ${usageFilter === 'in-use' ? 'active' : ''}`} onClick={() => setUsageFilter('in-use')}>
              <span className="tf-status-badge info">In use</span>
              <div className="acm-summary-card-copy">
                <strong>{inUseCount}</strong>
                <span>Attached to load balancers or related resources.</span>
              </div>
            </button>
          </div>

          <div className="tf-detail-tabs acm-detail-tabs acm-list-tabs">
            <button className={summaryBucket === 'all' ? 'active' : ''} onClick={() => setSummaryBucket('all')}>All</button>
            <button className={summaryBucket === 'expiring7' ? 'active' : ''} onClick={() => setSummaryBucket('expiring7')}>7d risk</button>
            <button className={summaryBucket === 'expiring30' ? 'active' : ''} onClick={() => setSummaryBucket('expiring30')}>30d watch</button>
            <button className={summaryBucket === 'pending' ? 'active' : ''} onClick={() => setSummaryBucket('pending')}>Pending validation</button>
            <button className={summaryBucket === 'unused' ? 'active' : ''} onClick={() => setSummaryBucket('unused')}>Unused</button>
          </div>

          <div className="tf-section acm-table-shell">
            <div className="acm-table-wrap">
              <table className="svc-table acm-table">
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
            </div>
            {!filteredCerts.length && !loading && <SvcState variant="no-filter-matches" resourceName="certificates" compact />}
          </div>
        </div>

        <div className="tf-detail-pane acm-detail-pane">
          <section className="tf-detail-hero acm-detail-hero">
            <div className="tf-detail-hero-copy">
              <div className="eyebrow">Selected certificate</div>
              <h3>{selectedSummary?.domainName || 'No certificate selected'}</h3>
              <p>{selectedSummary?.certificateArn || 'Select a certificate to inspect renewal state, validation flow, and associations.'}</p>
              <div className="tf-detail-meta-strip">
                <div className="tf-detail-meta-pill">
                  <span>Status</span>
                  <strong>{selectedSummary?.status || '-'}</strong>
                </div>
                <div className="tf-detail-meta-pill">
                  <span>Urgency</span>
                  <strong>{selectedSummary?.urgencySeverity || '-'}</strong>
                </div>
                <div className="tf-detail-meta-pill">
                  <span>Expiry</span>
                  <strong>{selectedSummary ? fmtDays(selectedSummary.daysUntilExpiry) : '-'}</strong>
                </div>
                <div className="tf-detail-meta-pill">
                  <span>Associations</span>
                  <strong>{selectedSummary?.inUseByCount ?? 0}</strong>
                </div>
              </div>
            </div>
            <div className="tf-detail-hero-stats">
              <div className={`tf-detail-stat-card ${statusTone(selectedSummary?.status)}`}>
                <span>Certificate state</span>
                <strong>{selectedSummary?.status || 'Standby'}</strong>
                <small>{selectedSummary?.type || 'Select a certificate from the watch list.'}</small>
              </div>
              <div className={`tf-detail-stat-card ${severityTone(selectedSummary?.urgencySeverity)}`}>
                <span>Urgency</span>
                <strong>{selectedSummary?.urgencySeverity || 'Idle'}</strong>
                <small>{selectedSummary?.urgencyReason || 'No active certificate warning selected.'}</small>
              </div>
              <div className="tf-detail-stat-card">
                <span>Validation blockers</span>
                <strong>{selectedSummary ? selectedSummary.pendingValidationCount + selectedSummary.dnsValidationIssueCount : 0}</strong>
                <small>{selectedSummary ? 'Pending validations plus DNS blockers.' : 'Visible after selection.'}</small>
              </div>
              <div className="tf-detail-stat-card">
                <span>Resource usage</span>
                <strong>{selectedSummary?.inUseByCount ?? 0}</strong>
                <small>{selectedSummary?.inUse ? 'Downstream resources reference this cert.' : 'Not currently attached.'}</small>
              </div>
            </div>
          </section>

          <div className="tf-section">
            <div className="tf-section-head">
              <div>
                <h3>Watch Summary</h3>
                <div className="tf-section-hint">Primary posture for the selected certificate.</div>
              </div>
            </div>
            {selectedSummary ? (
              <>
                <div className="svc-kv">
                  <div className="svc-kv-row"><div className="svc-kv-label">Certificate</div><div className="svc-kv-value">{selectedSummary.domainName || selectedSummary.certificateArn}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Urgency</div><div className="svc-kv-value"><span className={`svc-badge ${severityBadgeClass(selectedSummary.urgencySeverity)}`}>{selectedSummary.urgencySeverity}</span> {selectedSummary.urgencyReason}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Expiry</div><div className="svc-kv-value">{fmtTs(selectedSummary.notAfter)} ({fmtDays(selectedSummary.daysUntilExpiry)})</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Renewal</div><div className="svc-kv-value">{selectedSummary.renewalStatus || '-'} / {selectedSummary.renewalEligibility || '-'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Associations</div><div className="svc-kv-value">{selectedSummary.inUse ? `${selectedSummary.inUseByCount} in-use references` : 'Unused certificate'}</div></div>
                </div>
                <div className="acm-action-row">
                  <button type="button" className="tf-toolbar-btn" onClick={() => void copyText(selectedSummary.certificateArn, 'Certificate ARN')}>Copy ARN</button>
                  {selectedSummary.loadBalancerAssociations[0] && (
                    <button type="button" className="tf-toolbar-btn accent" onClick={() => onOpenLoadBalancer(selectedSummary.loadBalancerAssociations[0].loadBalancerArn)}>
                      Open Load Balancer
                    </button>
                  )}
                </div>
              </>
            ) : (
              <SvcState variant="no-selection" resourceName="certificate" message="Select a certificate to inspect its watch status." compact />
            )}
          </div>

          <div className="tf-section">
            <div className="tf-section-head">
              <div>
                <h3>Certificate Detail</h3>
                <div className="tf-section-hint">Issuer, validity window, validation flow, and linked resources.</div>
              </div>
            </div>
            {detail ? (
              <>
                {detailLoading && <div className="tf-section-hint">Refreshing detail...</div>}
                <div className="svc-kv">
                  <div className="svc-kv-row"><div className="svc-kv-label">Status</div><div className="svc-kv-value"><span className={`svc-badge ${badgeClass(detail.status)}`}>{detail.status}</span></div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Validity</div><div className="svc-kv-value">{fmtTs(detail.notBefore)} to {fmtTs(detail.notAfter)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Days Until Expiry</div><div className="svc-kv-value">{fmtDays(detail.daysUntilExpiry)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Renewal</div><div className="svc-kv-value">{detail.renewalStatus || '-'} / {detail.renewalEligibility || '-'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Algorithms</div><div className="svc-kv-value">{detail.keyAlgorithm || '-'} / {detail.signatureAlgorithm || '-'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">SANs</div><div className="svc-kv-value">{detail.subjectAlternativeNames.join(', ') || '-'}</div></div>
                </div>

                <div className="acm-subsection">
                  <h3 className="acm-subsection-title">Validation Watch</h3>
                  <table className="svc-table acm-table" style={{ fontSize: 11 }}>
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
                  {detail.domainValidationOptions.length === 0 && <SvcState variant="empty" resourceName="validation details" compact />}
                </div>

                <div className="acm-subsection">
                  <h3 className="acm-subsection-title">Resource Associations</h3>
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
                    <div className="svc-list" style={{ marginBottom: 10 }}>
                      {detail.inUseAssociations.map((association) => {
                        const isWaf = association.service === 'wafv2' || association.service === 'waf' || association.resourceType?.toLowerCase().includes('webacl')
                        const wafName = isWaf ? association.label.split('/').pop() || association.label : ''
                        return (
                          <button key={association.arn} type="button" className="svc-list-item" disabled={!isWaf} onClick={() => { if (isWaf && wafName) onOpenWaf(wafName) }}>
                            <div className="svc-list-title">{association.label}</div>
                            <div className="svc-list-meta">{association.service} · {association.resourceType}</div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {detail.loadBalancerAssociations.length === 0 && detail.inUseAssociations.length === 0 && (
                    <SvcState variant="empty" message="This certificate is currently unused." compact />
                  )}
                </div>

                <div className="acm-action-row">
                  <ConfirmButton className="tf-toolbar-btn danger" onConfirm={() => void doDelete()}>Delete Certificate</ConfirmButton>
                </div>
              </>
            ) : (
              <SvcState variant="no-selection" resourceName="certificate" compact />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
