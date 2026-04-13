import { useEffect, useMemo, useState } from 'react'
import type {
  GcpUrlMapSummary,
  GcpUrlMapDetail,
  GcpBackendServiceSummary,
  GcpForwardingRuleSummary,
  GcpHealthCheckSummary,
  GcpSecurityPolicySummary,
  GcpSecurityPolicyDetail
} from '@shared/types'
import {
  listGcpUrlMaps,
  getGcpUrlMapDetail,
  listGcpBackendServices,
  listGcpForwardingRules,
  listGcpHealthChecks,
  listGcpSecurityPolicies,
  getGcpSecurityPolicyDetail
} from './api'
import { LoadBalancerLogViewer } from './LoadBalancerLogViewer'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Helpers ──────────────────────────────────────────────── */

type LbTab = 'load-balancers' | 'backends' | 'health-checks' | 'cloud-armor' | 'logs'

const MAIN_TABS: Array<{ id: LbTab; label: string }> = [
  { id: 'load-balancers', label: 'Load Balancers' },
  { id: 'backends', label: 'Backends' },
  { id: 'health-checks', label: 'Health Checks' },
  { id: 'cloud-armor', label: 'Cloud Armor' },
  { id: 'logs', label: 'Logs' }
]

function extractQuotedCommand(value: string): string | null {
  const straight = value.match(/Run "([^"]+)"/)
  if (straight?.[1]?.trim()) return straight[1].trim()
  const curly = value.match(/Run \u201c([^\u201d]+)\u201d/)
  return curly?.[1]?.trim() ?? null
}

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  return {
    command: extractQuotedCommand(error) ?? fallbackCommand,
    summary
  }
}

function truncate(value: string, max = 48): string {
  if (!value) return '-'
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

function shortName(fullName: string): string {
  if (!fullName) return '-'
  const parts = fullName.split('/')
  return parts[parts.length - 1] || fullName
}

function formatDateTime(iso: string): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function schemeBadgeTone(scheme: string): string {
  if (scheme === 'EXTERNAL' || scheme === 'EXTERNAL_MANAGED') return 'status-ok'
  if (scheme === 'INTERNAL' || scheme === 'INTERNAL_MANAGED' || scheme === 'INTERNAL_SELF_MANAGED') return 'status-warn'
  return ''
}

function actionBadgeTone(action: string): string {
  if (action === 'allow') return 'status-ok'
  if (action === 'deny(403)' || action === 'deny(404)' || action === 'deny(502)') return 'status-err'
  if (action.startsWith('deny')) return 'status-err'
  if (action === 'rate_based_ban' || action === 'throttle') return 'status-warn'
  return ''
}

function DetailRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="table-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0' }}>
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  )
}

/* ── Component ────────────────────────────────────────────── */

export function GcpLoadBalancerConsole({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
}) {
  const [mainTab, setMainTab] = useState<LbTab>('load-balancers')
  const [tabsOpen, setTabsOpen] = useState(true)

  const [urlMaps, setUrlMaps] = useState<GcpUrlMapSummary[]>([])
  const [backendServices, setBackendServices] = useState<GcpBackendServiceSummary[]>([])
  const [forwardingRules, setForwardingRules] = useState<GcpForwardingRuleSummary[]>([])
  const [healthChecks, setHealthChecks] = useState<GcpHealthCheckSummary[]>([])
  const [securityPolicies, setSecurityPolicies] = useState<GcpSecurityPolicySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedUrlMap, setSelectedUrlMap] = useState<GcpUrlMapSummary | null>(null)
  const [urlMapDetail, setUrlMapDetail] = useState<GcpUrlMapDetail | null>(null)
  const [selectedPolicy, setSelectedPolicy] = useState<GcpSecurityPolicySummary | null>(null)
  const [policyDetail, setPolicyDetail] = useState<GcpSecurityPolicyDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [lbFilter, setLbFilter] = useState('')
  const [backendFilter, setBackendFilter] = useState('')
  const [hcFilter, setHcFilter] = useState('')
  const [armorFilter, setArmorFilter] = useState('')

  /* ── Data fetching ────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    Promise.allSettled([
      listGcpUrlMaps(projectId),
      listGcpBackendServices(projectId),
      listGcpForwardingRules(projectId),
      listGcpHealthChecks(projectId),
      listGcpSecurityPolicies(projectId)
    ]).then(([urlMapRes, backendRes, fwdRes, hcRes, policyRes]) => {
      if (cancelled) return

      if (urlMapRes.status === 'fulfilled') setUrlMaps(urlMapRes.value)
      if (backendRes.status === 'fulfilled') setBackendServices(backendRes.value)
      if (fwdRes.status === 'fulfilled') setForwardingRules(fwdRes.value)
      if (hcRes.status === 'fulfilled') setHealthChecks(hcRes.value)
      if (policyRes.status === 'fulfilled') setSecurityPolicies(policyRes.value)

      // Show first error encountered
      const firstError = [urlMapRes, backendRes, fwdRes, hcRes, policyRes].find((r) => r.status === 'rejected')
      if (firstError && firstError.status === 'rejected') {
        const err = firstError.reason
        setError(err instanceof Error ? err.message : String(err))
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [projectId, refreshNonce])

  /* Load URL map detail on selection */
  useEffect(() => {
    if (!selectedUrlMap) {
      setUrlMapDetail(null)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    setDetailError('')

    getGcpUrlMapDetail(projectId, selectedUrlMap.name, selectedUrlMap.region || undefined)
      .then((detail) => {
        if (!cancelled) setUrlMapDetail(detail)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, selectedUrlMap?.name, selectedUrlMap?.region])

  /* Load security policy detail on selection */
  useEffect(() => {
    if (!selectedPolicy) {
      setPolicyDetail(null)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    setDetailError('')

    getGcpSecurityPolicyDetail(projectId, selectedPolicy.name)
      .then((detail) => {
        if (!cancelled) setPolicyDetail(detail)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, selectedPolicy?.name])

  /* ── Derived data ─────────────────────────────────────────── */

  const locationLabel = location.trim() || 'global'

  const filteredUrlMaps = useMemo(() => {
    if (!lbFilter.trim()) return urlMaps
    const q = lbFilter.trim().toLowerCase()
    return urlMaps.filter((u) =>
      u.name.toLowerCase().includes(q) ||
      shortName(u.defaultService).toLowerCase().includes(q) ||
      u.region.toLowerCase().includes(q)
    )
  }, [urlMaps, lbFilter])

  const filteredBackends = useMemo(() => {
    if (!backendFilter.trim()) return backendServices
    const q = backendFilter.trim().toLowerCase()
    return backendServices.filter((b) =>
      b.name.toLowerCase().includes(q) ||
      b.protocol.toLowerCase().includes(q) ||
      b.loadBalancingScheme.toLowerCase().includes(q)
    )
  }, [backendServices, backendFilter])

  const filteredHealthChecks = useMemo(() => {
    if (!hcFilter.trim()) return healthChecks
    const q = hcFilter.trim().toLowerCase()
    return healthChecks.filter((h) =>
      h.name.toLowerCase().includes(q) ||
      h.type.toLowerCase().includes(q)
    )
  }, [healthChecks, hcFilter])

  const filteredPolicies = useMemo(() => {
    if (!armorFilter.trim()) return securityPolicies
    const q = armorFilter.trim().toLowerCase()
    return securityPolicies.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.type.toLowerCase().includes(q)
    )
  }, [securityPolicies, armorFilter])

  const enableAction = error
    ? getGcpApiEnableAction(
        error,
        `gcloud services enable compute.googleapis.com --project ${projectId}`,
        `Compute Engine API is disabled for project ${projectId}.`
      )
    : null

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="svc-console">
      {/* ── Error banner ────────────────────────────── */}
      {error ? (
        <section className="panel stack">
          {enableAction ? (
            <div className="error-banner gcp-enable-error-banner">
              <div className="gcp-enable-error-copy">
                <strong>{enableAction.summary}</strong>
                <p>
                  {canRunTerminalCommand
                    ? 'Run the enable command in the terminal, wait for propagation, then refresh the inventory.'
                    : 'Switch Settings > Access Mode to Operator to enable terminal actions for this command.'}
                </p>
              </div>
              <div className="gcp-enable-error-actions">
                <button
                  type="button"
                  className="accent"
                  disabled={!canRunTerminalCommand}
                  onClick={() => onRunTerminalCommand(enableAction.command)}
                  title={canRunTerminalCommand ? enableAction.command : 'Switch to Operator mode to enable terminal actions'}
                >
                  Enable API
                </button>
              </div>
            </div>
          ) : (
            <SvcState variant="error" error={error} />
          )}
        </section>
      ) : null}

      {/* ── Hero ────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Networking posture</div>
          <h2>Load Balancer + Cloud Armor</h2>
          <p>
            URL map inventory with backend services, forwarding rules, health checks,
            and Cloud Armor security policies for the active Google Cloud project.
          </p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Load Balancers</span>
            <strong>{urlMaps.length}</strong>
            <small>{loading ? 'Refreshing live data now' : 'URL maps in current project'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Backend Services</span>
            <strong>{backendServices.length}</strong>
            <small>Backend service groups</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Forwarding Rules</span>
            <strong>{forwardingRules.length}</strong>
            <small>Frontend entry points</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Cloud Armor</span>
            <strong>{securityPolicies.length}</strong>
            <small>Security policies configured</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ─────────────────────────────────── */}
      <div className="iam-shell-toolbar">
        <button className="svc-tab-hamburger" type="button" onClick={() => setTabsOpen((p) => !p)}>
          <span className={`hamburger-icon ${tabsOpen ? 'open' : ''}`}>
            <span /><span /><span />
          </span>
        </button>
        <div className="iam-tab-bar">
          {tabsOpen && MAIN_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`svc-tab ${mainTab === t.id ? 'active' : ''}`}
              onClick={() => setMainTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Loading state ───────────────────────────── */}
      {loading && <SvcState variant="loading" resourceName="Load Balancer resources" message="Fetching URL maps, backends, health checks, and security policies..." />}

      {/* ══════════════ LOAD BALANCERS TAB ══════════════ */}
      {!loading && !error && mainTab === 'load-balancers' && (
        <div className="overview-surface">
          <div className="panel">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <span>URL Maps ({filteredUrlMaps.length})</span>
              <input
                className="svc-search"
                style={{ maxWidth: 280 }}
                placeholder="Filter load balancers..."
                value={lbFilter}
                onChange={(e) => setLbFilter(e.target.value)}
              />
            </div>

            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr 1fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Name</span>
              <span>Default Backend</span>
              <span>Host Rules</span>
              <span>Path Matchers</span>
              <span>Scope</span>
              <span>Created</span>
            </div>

            {filteredUrlMaps.length === 0 && (
              <SvcState variant="empty" message="No URL maps found in this project." compact />
            )}
            {filteredUrlMaps.map((urlMap) => (
              <div
                key={urlMap.selfLink || urlMap.name}
                className={`table-row overview-table-row ${selectedUrlMap?.name === urlMap.name && selectedUrlMap?.region === urlMap.region ? 'active' : ''}`}
                style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr 1fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
                onClick={() => setSelectedUrlMap((prev) => prev?.name === urlMap.name && prev?.region === urlMap.region ? null : urlMap)}
              >
                <span title={urlMap.name}>{truncate(urlMap.name)}</span>
                <span title={urlMap.defaultService}>{truncate(shortName(urlMap.defaultService), 36)}</span>
                <span>{urlMap.hostRuleCount}</span>
                <span>{urlMap.pathMatcherCount}</span>
                <span>{urlMap.region || 'global'}</span>
                <span>{formatDateTime(urlMap.creationTimestamp)}</span>
              </div>
            ))}
          </div>

          {/* ── URL Map detail panel ────────────────── */}
          {selectedUrlMap && (
            <div className="panel" style={{ marginTop: '1rem' }}>
              <div className="panel-header">
                URL Map detail: <strong>{selectedUrlMap.name}</strong>
                <span style={{ marginLeft: '0.5rem', opacity: 0.6 }}>({selectedUrlMap.region || 'global'})</span>
              </div>

              {detailLoading && (
                <SvcState variant="loading" resourceName="URL map detail" compact />
              )}
              {detailError && (
                <SvcState variant="error" error={detailError} compact />
              )}

              {urlMapDetail && !detailLoading && (
                <div style={{ padding: '1rem' }}>
                  <DetailRow label="Default Service" value={shortName(urlMapDetail.defaultService)} title={urlMapDetail.defaultService} />

                  {urlMapDetail.hostRules.length > 0 && (
                    <>
                      <h4 style={{ margin: '1rem 0 0.75rem' }}>Host Rules ({urlMapDetail.hostRules.length})</h4>
                      {urlMapDetail.hostRules.map((hr, i) => (
                        <div key={i} className="table-row" style={{ padding: '0.35rem 0' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                            {hr.hosts.join(', ')}
                          </span>
                          <span style={{ opacity: 0.6, marginLeft: '0.5rem' }}>&rarr; {hr.pathMatcher}</span>
                        </div>
                      ))}
                    </>
                  )}

                  {urlMapDetail.pathMatchers.length > 0 && (
                    <>
                      <h4 style={{ margin: '1rem 0 0.75rem' }}>Path Matchers ({urlMapDetail.pathMatchers.length})</h4>
                      {urlMapDetail.pathMatchers.map((pm) => (
                        <div key={pm.name} style={{ marginBottom: '0.75rem' }}>
                          <DetailRow label={pm.name} value={`default: ${shortName(pm.defaultService)}`} title={pm.defaultService} />
                          {pm.pathRules.map((pr, j) => (
                            <div key={j} className="table-row" style={{ padding: '0.25rem 0 0.25rem 1rem', fontSize: '0.85rem' }}>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>{pr.paths.join(', ')}</span>
                              <span style={{ opacity: 0.6, marginLeft: '0.5rem' }}>&rarr; {shortName(pr.service)}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </>
                  )}

                  {/* Show related forwarding rules */}
                  {(() => {
                    const related = forwardingRules.filter((fr) =>
                      shortName(fr.target) === selectedUrlMap.name ||
                      fr.target.includes(selectedUrlMap.name)
                    )
                    if (related.length === 0) return null
                    return (
                      <>
                        <h4 style={{ margin: '1rem 0 0.75rem' }}>Forwarding Rules ({related.length})</h4>
                        {related.map((fr) => (
                          <div key={fr.selfLink || fr.name} className="table-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0' }}>
                            <span>{fr.name}</span>
                            <span>{fr.IPAddress}:{fr.portRange} ({fr.IPProtocol})</span>
                          </div>
                        ))}
                      </>
                    )
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════ BACKENDS TAB ══════════════ */}
      {!loading && !error && mainTab === 'backends' && (
        <div className="overview-surface">
          <div className="panel">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <span>Backend Services ({filteredBackends.length})</span>
              <input
                className="svc-search"
                style={{ maxWidth: 280 }}
                placeholder="Filter backends..."
                value={backendFilter}
                onChange={(e) => setBackendFilter(e.target.value)}
              />
            </div>

            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1.5fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Name</span>
              <span>Protocol</span>
              <span>Port</span>
              <span>Timeout</span>
              <span>Backends</span>
              <span>LB Scheme</span>
              <span>Security Policy</span>
            </div>

            {filteredBackends.length === 0 && (
              <SvcState variant="empty" message="No backend services found in this project." compact />
            )}
            {filteredBackends.map((bs) => (
              <div
                key={bs.selfLink || bs.name}
                className="table-row overview-table-row"
                style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1.5fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
              >
                <span title={bs.name}>{truncate(bs.name)}</span>
                <span>{bs.protocol || '-'}</span>
                <span>{bs.port || bs.portName || '-'}</span>
                <span>{bs.timeoutSec ? `${bs.timeoutSec}s` : '-'}</span>
                <span>{bs.backendsCount}</span>
                <span className={`status-badge ${schemeBadgeTone(bs.loadBalancingScheme)}`}>{bs.loadBalancingScheme || '-'}</span>
                <span title={bs.securityPolicy}>{bs.securityPolicy ? truncate(shortName(bs.securityPolicy), 28) : '-'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════ HEALTH CHECKS TAB ══════════════ */}
      {!loading && !error && mainTab === 'health-checks' && (
        <div className="overview-surface">
          <div className="panel">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <span>Health Checks ({filteredHealthChecks.length})</span>
              <input
                className="svc-search"
                style={{ maxWidth: 280 }}
                placeholder="Filter health checks..."
                value={hcFilter}
                onChange={(e) => setHcFilter(e.target.value)}
              />
            </div>

            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Name</span>
              <span>Type</span>
              <span>Interval</span>
              <span>Timeout</span>
              <span>Unhealthy</span>
              <span>Healthy</span>
              <span>Created</span>
            </div>

            {filteredHealthChecks.length === 0 && (
              <SvcState variant="empty" message="No health checks found in this project." compact />
            )}
            {filteredHealthChecks.map((hc) => (
              <div
                key={hc.selfLink || hc.name}
                className="table-row overview-table-row"
                style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
              >
                <span title={hc.name}>{truncate(hc.name)}</span>
                <span className="status-badge">{hc.type || '-'}</span>
                <span>{hc.checkIntervalSec ? `${hc.checkIntervalSec}s` : '-'}</span>
                <span>{hc.timeoutSec ? `${hc.timeoutSec}s` : '-'}</span>
                <span>{hc.unhealthyThreshold || '-'}</span>
                <span>{hc.healthyThreshold || '-'}</span>
                <span>{formatDateTime(hc.creationTimestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══════════════ CLOUD ARMOR TAB ══════════════ */}
      {!loading && !error && mainTab === 'cloud-armor' && (
        <div className="overview-surface">
          <div className="panel">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <span>Security Policies ({filteredPolicies.length})</span>
              <input
                className="svc-search"
                style={{ maxWidth: 280 }}
                placeholder="Filter policies..."
                value={armorFilter}
                onChange={(e) => setArmorFilter(e.target.value)}
              />
            </div>

            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Name</span>
              <span>Type</span>
              <span>Rules</span>
              <span>Adaptive Protection</span>
              <span>Created</span>
            </div>

            {filteredPolicies.length === 0 && (
              <SvcState variant="empty" message="No Cloud Armor security policies found in this project." compact />
            )}
            {filteredPolicies.map((policy) => (
              <div
                key={policy.selfLink || policy.name}
                className={`table-row overview-table-row ${selectedPolicy?.name === policy.name ? 'active' : ''}`}
                style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr 1.5fr', gap: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
                onClick={() => setSelectedPolicy((prev) => prev?.name === policy.name ? null : policy)}
              >
                <span title={policy.name}>{truncate(policy.name)}</span>
                <span className="status-badge">{policy.type || '-'}</span>
                <span>{policy.ruleCount}</span>
                <span className={`status-badge ${policy.adaptiveProtection ? 'status-ok' : ''}`}>
                  {policy.adaptiveProtection ? 'Enabled' : 'Disabled'}
                </span>
                <span>{formatDateTime(policy.creationTimestamp)}</span>
              </div>
            ))}
          </div>

          {/* ── Security policy detail panel ─────────── */}
          {selectedPolicy && (
            <div className="panel" style={{ marginTop: '1rem' }}>
              <div className="panel-header">
                Security Policy: <strong>{selectedPolicy.name}</strong>
              </div>

              {detailLoading && (
                <SvcState variant="loading" resourceName="security policy detail" compact />
              )}
              {detailError && (
                <SvcState variant="error" error={detailError} compact />
              )}

              {policyDetail && !detailLoading && (
                <div style={{ padding: '1rem' }}>
                  <DetailRow label="Type" value={policyDetail.type || '-'} />
                  <DetailRow label="Description" value={policyDetail.description || '-'} />
                  {policyDetail.adaptiveProtectionConfig && (
                    <DetailRow
                      label="Adaptive Protection"
                      value={policyDetail.adaptiveProtectionConfig.enabled ? 'Enabled' : 'Disabled'}
                    />
                  )}
                  {policyDetail.ddosProtectionConfig && (
                    <DetailRow label="DDoS Protection" value={policyDetail.ddosProtectionConfig} />
                  )}

                  <h4 style={{ margin: '1rem 0 0.75rem' }}>Rules ({policyDetail.rules.length})</h4>
                  <div
                    className="table-head"
                    style={{ display: 'grid', gridTemplateColumns: '0.8fr 1.2fr 2fr 1fr 0.8fr', gap: '1rem', padding: '0.5rem 1rem' }}
                  >
                    <span>Priority</span>
                    <span>Action</span>
                    <span>Match</span>
                    <span>Description</span>
                    <span>Preview</span>
                  </div>
                  {policyDetail.rules
                    .sort((a, b) => a.priority - b.priority)
                    .map((rule) => (
                      <div
                        key={rule.priority}
                        className="table-row overview-table-row"
                        style={{ display: 'grid', gridTemplateColumns: '0.8fr 1.2fr 2fr 1fr 0.8fr', gap: '1rem', padding: '0.5rem 1rem' }}
                      >
                        <span>{rule.priority}</span>
                        <span className={`status-badge ${actionBadgeTone(rule.action)}`}>{rule.action}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                          {rule.match
                            ? rule.match.config.srcIpRanges.length > 0
                              ? truncate(rule.match.config.srcIpRanges.join(', '), 60)
                              : rule.match.versionedExpr || '*'
                            : '*'}
                        </span>
                        <span title={rule.description}>{truncate(rule.description, 28)}</span>
                        <span className={`status-badge ${rule.preview ? 'status-warn' : ''}`}>{rule.preview ? 'Yes' : 'No'}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════ LOGS TAB ══════════════ */}
      {!loading && !error && mainTab === 'logs' && (
        <div className="overview-surface">
          <LoadBalancerLogViewer
            provider="gcp"
            loadBalancerIdentifier={selectedUrlMap?.name ?? ''}
            gcpProjectId={projectId}
          />
        </div>
      )}
    </div>
  )
}
