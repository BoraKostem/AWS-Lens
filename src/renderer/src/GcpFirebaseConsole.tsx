import { useEffect, useMemo, useState } from 'react'
import type {
  GcpFirebaseProjectSummary,
  GcpFirebaseWebAppSummary,
  GcpFirebaseAndroidAppSummary,
  GcpFirebaseIosAppSummary,
  GcpFirebaseHostingSiteSummary,
  GcpFirebaseHostingReleaseSummary,
  GcpFirebaseHostingDomainSummary,
  GcpFirebaseHostingChannelSummary
} from '@shared/types'
import {
  getGcpFirebaseProject,
  listGcpFirebaseWebApps,
  listGcpFirebaseAndroidApps,
  listGcpFirebaseIosApps,
  listGcpFirebaseHostingSites,
  listGcpFirebaseHostingReleases,
  listGcpFirebaseHostingDomains,
  listGcpFirebaseHostingChannels
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Types ──────────────────────────────────────────────── */

type MainTab = 'overview' | 'apps' | 'hosting' | 'posture'
type AppFilter = 'all' | 'web' | 'android' | 'ios'

const MAIN_TABS: Array<{ id: MainTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'apps', label: 'Apps' },
  { id: 'hosting', label: 'Hosting' },
  { id: 'posture', label: 'Posture' }
]

const APP_FILTERS: Array<{ id: AppFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'web', label: 'Web' },
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iOS' }
]

interface UnifiedApp {
  platform: 'web' | 'android' | 'ios'
  appId: string
  displayName: string
  state: string
  packageOrBundle: string
  raw: GcpFirebaseWebAppSummary | GcpFirebaseAndroidAppSummary | GcpFirebaseIosAppSummary
}

/* ── Helpers ─────────────────────────────────────────────── */

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getGcpApiEnableAction(
  error: string,
  fallbackCommand: string,
  summary: string
): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) return null
  const match = error.match(/Run "([^"]+)"/) ?? error.match(/Run [\u201c]([^\u201d]+)[\u201d]/)
  return { command: match?.[1]?.trim() ?? fallbackCommand, summary }
}

function formatDateTime(value: string | undefined): string {
  if (!value || value === '-') return '-'
  try { return new Date(value).toLocaleString() } catch { return value }
}

function trunc(s: string, n = 40): string {
  if (!s) return '-'
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s
}

function platformBadge(platform: 'web' | 'android' | 'ios'): JSX.Element {
  if (platform === 'web') {
    return <span className="status-badge status-ok">Web</span>
  }
  if (platform === 'android') {
    return <span className="status-badge status-warn">Android</span>
  }
  return (
    <span
      className="status-badge"
      style={{ background: 'rgba(56,142,224,0.18)', color: '#69b4ff' }}
    >
      iOS
    </span>
  )
}

function stateBadgeClass(state: string): string {
  if (state === 'ACTIVE') return 'status-badge status-ok'
  if (state === 'DELETED') return 'status-badge status-error'
  return 'status-badge status-warn'
}

function releaseStatusBadge(status: string): string {
  if (status === 'LIVE' || status === 'ACTIVE') return 'status-badge status-ok'
  if (status === 'EXPIRED' || status === 'ABANDONED') return 'status-badge status-error'
  return 'status-badge status-warn'
}

function domainStatusBadge(status: string): string {
  if (status === 'CONNECTED' || status === 'ACTIVE') return 'status-badge status-ok'
  if (status === 'PENDING_VERIFICATION' || status === 'NEEDS_APPROVAL') return 'status-badge status-warn'
  return 'status-badge'
}

/* ── Component ───────────────────────────────────────────── */

export function GcpFirebaseConsole({
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
  /* ── State: navigation ─────────────────────────────────── */
  const [mainTab, setMainTab] = useState<MainTab>('overview')
  const [tabsOpen, setTabsOpen] = useState(true)
  const [appFilter, setAppFilter] = useState<AppFilter>('all')

  /* ── State: project summary ────────────────────────────── */
  const [project, setProject] = useState<GcpFirebaseProjectSummary | null>(null)
  const [projectLoading, setProjectLoading] = useState(true)
  const [projectError, setProjectError] = useState('')

  /* ── State: apps ───────────────────────────────────────── */
  const [webApps, setWebApps] = useState<GcpFirebaseWebAppSummary[]>([])
  const [androidApps, setAndroidApps] = useState<GcpFirebaseAndroidAppSummary[]>([])
  const [iosApps, setIosApps] = useState<GcpFirebaseIosAppSummary[]>([])
  const [appsLoading, setAppsLoading] = useState(true)
  const [appsError, setAppsError] = useState('')

  /* ── State: hosting ────────────────────────────────────── */
  const [hostingSites, setHostingSites] = useState<GcpFirebaseHostingSiteSummary[]>([])
  const [hostingLoading, setHostingLoading] = useState(true)
  const [hostingError, setHostingError] = useState('')

  /* ── State: selected items ─────────────────────────────── */
  const [selectedApp, setSelectedApp] = useState<UnifiedApp | null>(null)
  const [selectedSite, setSelectedSite] = useState<GcpFirebaseHostingSiteSummary | null>(null)

  /* ── State: hosting sub-resources (per selected site) ──── */
  const [releases, setReleases] = useState<GcpFirebaseHostingReleaseSummary[]>([])
  const [releasesLoading, setReleasesLoading] = useState(false)
  const [releasesError, setReleasesError] = useState('')

  const [domains, setDomains] = useState<GcpFirebaseHostingDomainSummary[]>([])
  const [domainsLoading, setDomainsLoading] = useState(false)
  const [domainsError, setDomainsError] = useState('')

  const [channels, setChannels] = useState<GcpFirebaseHostingChannelSummary[]>([])
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [channelsError, setChannelsError] = useState('')

  /* ── State: global error ───────────────────────────────── */
  const [globalError, setGlobalError] = useState('')

  /* ── Derived values ────────────────────────────────────── */
  const locationLabel = location.trim() || 'global'

  const unifiedApps = useMemo<UnifiedApp[]>(() => {
    const items: UnifiedApp[] = []
    for (const app of webApps) {
      items.push({
        platform: 'web',
        appId: app.appId,
        displayName: app.displayName || '-',
        state: app.state || 'ACTIVE',
        packageOrBundle: (app as Record<string, unknown>).appUrls
          ? String((app as Record<string, unknown>).appUrls)
          : '-',
        raw: app
      })
    }
    for (const app of androidApps) {
      items.push({
        platform: 'android',
        appId: app.appId,
        displayName: app.displayName || '-',
        state: app.state || 'ACTIVE',
        packageOrBundle: app.packageName || '-',
        raw: app
      })
    }
    for (const app of iosApps) {
      items.push({
        platform: 'ios',
        appId: app.appId,
        displayName: app.displayName || '-',
        state: app.state || 'ACTIVE',
        packageOrBundle: app.bundleId || '-',
        raw: app
      })
    }
    return items
  }, [webApps, androidApps, iosApps])

  const filteredApps = useMemo(() => {
    if (appFilter === 'all') return unifiedApps
    return unifiedApps.filter((a) => a.platform === appFilter)
  }, [unifiedApps, appFilter])

  const activeAppsCount = useMemo(
    () => unifiedApps.filter((a) => a.state === 'ACTIVE').length,
    [unifiedApps]
  )

  const activeDomains = useMemo(
    () => domains.filter((d) => d.status === 'CONNECTED' || d.status === 'ACTIVE'),
    [domains]
  )

  const recentReleases = useMemo(() => {
    return [...releases]
      .sort((a, b) => {
        const ta = a.releaseTime ? new Date(a.releaseTime).getTime() : 0
        const tb = b.releaseTime ? new Date(b.releaseTime).getTime() : 0
        return tb - ta
      })
      .slice(0, 5)
  }, [releases])

  const appStateBreakdown = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const a of unifiedApps) {
      const s = a.state || 'UNKNOWN'
      counts[s] = (counts[s] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [unifiedApps])

  const selectionLabel = useMemo(() => {
    if (selectedApp) return trunc(selectedApp.displayName, 28)
    if (selectedSite) return trunc(selectedSite.siteId, 28)
    return 'No selection'
  }, [selectedApp, selectedSite])

  const enableAction = globalError
    ? getGcpApiEnableAction(
        globalError,
        `gcloud services enable firebase.googleapis.com --project ${projectId}`,
        `Firebase API is disabled for project ${projectId}.`
      )
    : null

  /* ── Data fetching: project + apps + hosting ───────────── */
  useEffect(() => {
    let cancelled = false
    setProjectLoading(true)
    setAppsLoading(true)
    setHostingLoading(true)
    setProjectError('')
    setAppsError('')
    setHostingError('')
    setGlobalError('')
    setSelectedApp(null)
    setSelectedSite(null)

    const projectPromise = getGcpFirebaseProject(projectId)
      .then((data) => { if (!cancelled) setProject(data) })
      .catch((err) => {
        if (cancelled) return
        const msg = normalizeError(err)
        setProjectError(msg)
        setGlobalError((prev) => prev || msg)
      })
      .finally(() => { if (!cancelled) setProjectLoading(false) })

    const appsPromise = Promise.allSettled([
      listGcpFirebaseWebApps(projectId),
      listGcpFirebaseAndroidApps(projectId),
      listGcpFirebaseIosApps(projectId)
    ]).then((results) => {
      if (cancelled) return
      if (results[0].status === 'fulfilled') setWebApps(results[0].value)
      else { const e = normalizeError(results[0].reason); setAppsError((p) => p || e); setGlobalError((p) => p || e) }
      if (results[1].status === 'fulfilled') setAndroidApps(results[1].value)
      else { const e = normalizeError(results[1].reason); setAppsError((p) => p || e); setGlobalError((p) => p || e) }
      if (results[2].status === 'fulfilled') setIosApps(results[2].value)
      else { const e = normalizeError(results[2].reason); setAppsError((p) => p || e); setGlobalError((p) => p || e) }
    }).finally(() => { if (!cancelled) setAppsLoading(false) })

    const hostingPromise = listGcpFirebaseHostingSites(projectId)
      .then((data) => { if (!cancelled) setHostingSites(data) })
      .catch((err) => {
        if (cancelled) return
        const msg = normalizeError(err)
        setHostingError(msg)
        setGlobalError((prev) => prev || msg)
      })
      .finally(() => { if (!cancelled) setHostingLoading(false) })

    void Promise.all([projectPromise, appsPromise, hostingPromise])

    return () => { cancelled = true }
  }, [projectId, refreshNonce])

  /* ── Data fetching: hosting sub-resources per site ─────── */
  useEffect(() => {
    if (!selectedSite) {
      setReleases([])
      setDomains([])
      setChannels([])
      setReleasesError('')
      setDomainsError('')
      setChannelsError('')
      return
    }

    let cancelled = false
    setReleasesLoading(true)
    setDomainsLoading(true)
    setChannelsLoading(true)
    setReleasesError('')
    setDomainsError('')
    setChannelsError('')

    listGcpFirebaseHostingReleases(projectId, selectedSite.siteId)
      .then((data) => { if (!cancelled) setReleases(data) })
      .catch((err) => { if (!cancelled) setReleasesError(normalizeError(err)) })
      .finally(() => { if (!cancelled) setReleasesLoading(false) })

    listGcpFirebaseHostingDomains(projectId, selectedSite.siteId)
      .then((data) => { if (!cancelled) setDomains(data) })
      .catch((err) => { if (!cancelled) setDomainsError(normalizeError(err)) })
      .finally(() => { if (!cancelled) setDomainsLoading(false) })

    listGcpFirebaseHostingChannels(projectId, selectedSite.siteId)
      .then((data) => { if (!cancelled) setChannels(data) })
      .catch((err) => { if (!cancelled) setChannelsError(normalizeError(err)) })
      .finally(() => { if (!cancelled) setChannelsLoading(false) })

    return () => { cancelled = true }
  }, [projectId, selectedSite?.siteId])

  /* ── Loading gate ──────────────────────────────────────── */
  const isLoading = projectLoading || appsLoading || hostingLoading

  if (isLoading && unifiedApps.length === 0 && hostingSites.length === 0 && !globalError) {
    return <SvcState variant="loading" resourceName="Firebase resources" />
  }

  /* ── Render ────────────────────────────────────────────── */
  return (
    <div className="svc-console gcp-runtime-console">
      {/* ── Error banner ─────────────────────────────── */}
      {globalError && (
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
            <SvcState variant="error" error={globalError} />
          )}
        </section>
      )}

      {/* ── Hero section ─────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Application platform posture</div>
          <h2>Firebase Operations</h2>
          <p>
            Unified Firebase workspace with app inventory, hosting management,
            release tracking, and project resource overview.
          </p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill">
              <span>Project</span>
              <strong>{trunc(projectId, 28)}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Selection</span>
              <strong>{selectionLabel}</strong>
            </div>
          </div>
        </div>
        <div className="cw-shell-hero-stats">
          <div className="cw-shell-stat-card cw-shell-stat-card-accent">
            <span>Web Apps</span>
            <strong>{isLoading ? '...' : webApps.length}</strong>
            <small>Firebase web applications</small>
          </div>
          <div className="cw-shell-stat-card">
            <span>Android Apps</span>
            <strong>{isLoading ? '...' : androidApps.length}</strong>
            <small>Firebase Android applications</small>
          </div>
          <div className="cw-shell-stat-card">
            <span>iOS Apps</span>
            <strong>{isLoading ? '...' : iosApps.length}</strong>
            <small>Firebase iOS applications</small>
          </div>
          <div className="cw-shell-stat-card">
            <span>Hosting Sites</span>
            <strong>{isLoading ? '...' : hostingSites.length}</strong>
            <small>Firebase Hosting deployments</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ──────────────────────────────────── */}
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

      {isLoading && <SvcState variant="loading" resourceName="Firebase resources" />}

      {/* ================================================================ */}
      {/* TAB 1: OVERVIEW                                                  */}
      {/* ================================================================ */}
      {!isLoading && !globalError && mainTab === 'overview' && (
        <div className="overview-surface">
          {/* ── Project summary ────────────────────────── */}
          {project && (
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-header">
                <h3 style={{ margin: 0, fontSize: '0.85rem' }}>Project Summary</h3>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', padding: '1rem' }}>
                <div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">Display Name</div>
                    <div className="eks-kv-value">{project.displayName || '-'}</div>
                  </div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">Project ID</div>
                    <div className="eks-kv-value">{project.projectId || projectId}</div>
                  </div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">Project Number</div>
                    <div className="eks-kv-value">{project.projectNumber || '-'}</div>
                  </div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">State</div>
                    <div className="eks-kv-value">
                      <span className={stateBadgeClass(project.state || 'ACTIVE')}>
                        {project.state || 'ACTIVE'}
                      </span>
                    </div>
                  </div>
                </div>
                <div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">Default Storage Bucket</div>
                    <div className="eks-kv-value">{project.resources.storageBucket || '-'}</div>
                  </div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">Default Location</div>
                    <div className="eks-kv-value">{project.resources.locationId || locationLabel}</div>
                  </div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">Realtime DB Instance</div>
                    <div className="eks-kv-value">{project.resources.realtimeDatabaseInstance || '-'}</div>
                  </div>
                  <div className="eks-kv-row">
                    <div className="eks-kv-label">Hosting Site</div>
                    <div className="eks-kv-value">{project.resources.hostingSite || '-'}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {projectError && !enableAction && (
            <SvcState variant="error" error={projectError} />
          )}

          {/* ── Resource cards ─────────────────────────── */}
          <div className="iam-shell-hero-stats" style={{ marginBottom: 12 }}>
            <div className="iam-shell-stat-card iam-shell-stat-card-accent">
              <span>Hosting Sites</span>
              <strong>{hostingSites.length}</strong>
              <small>Active Firebase Hosting sites</small>
            </div>
            <div className="iam-shell-stat-card">
              <span>Storage Bucket</span>
              <strong>{project?.resources?.storageBucket ? '1' : '0'}</strong>
              <small>{project?.resources?.storageBucket ? trunc(project.resources.storageBucket, 28) : 'No bucket configured'}</small>
            </div>
            <div className="iam-shell-stat-card">
              <span>Location</span>
              <strong>{project?.resources?.locationId || locationLabel}</strong>
              <small>Default resource location</small>
            </div>
            <div className="iam-shell-stat-card">
              <span>Realtime DB</span>
              <strong>{project?.resources?.realtimeDatabaseInstance ? '1' : '0'}</strong>
              <small>{project?.resources?.realtimeDatabaseInstance ? trunc(project.resources.realtimeDatabaseInstance, 28) : 'No RTDB instance'}</small>
            </div>
          </div>

          {/* ── Quick app summary ──────────────────────── */}
          <div className="panel">
            <div className="panel-header">
              <h3 style={{ margin: 0, fontSize: '0.85rem' }}>App Platform Summary</h3>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', padding: '1rem' }}>
              <div style={{ textAlign: 'center' }}>
                {platformBadge('web')}
                <div style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0.5rem 0 0.2rem' }}>{webApps.length}</div>
                <div style={{ fontSize: '0.78rem', color: '#8fa3ba' }}>Web Applications</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                {platformBadge('android')}
                <div style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0.5rem 0 0.2rem' }}>{androidApps.length}</div>
                <div style={{ fontSize: '0.78rem', color: '#8fa3ba' }}>Android Applications</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                {platformBadge('ios')}
                <div style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0.5rem 0 0.2rem' }}>{iosApps.length}</div>
                <div style={{ fontSize: '0.78rem', color: '#8fa3ba' }}>iOS Applications</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* TAB 2: APPS                                                      */}
      {/* ================================================================ */}
      {!isLoading && !globalError && mainTab === 'apps' && (
        <div className="overview-surface">
          {/* ── Sub-filter pills ─────────────────────── */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {APP_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`svc-tab ${appFilter === f.id ? 'active' : ''}`}
                onClick={() => { setAppFilter(f.id); setSelectedApp(null) }}
                style={{ fontSize: '0.78rem', padding: '0.3rem 0.75rem' }}
              >
                {f.label}
                {f.id === 'all' && ` (${unifiedApps.length})`}
                {f.id === 'web' && ` (${webApps.length})`}
                {f.id === 'android' && ` (${androidApps.length})`}
                {f.id === 'ios' && ` (${iosApps.length})`}
              </button>
            ))}
          </div>

          {appsError && !enableAction && (
            <SvcState variant="error" error={appsError} />
          )}

          {/* ── Two-panel layout: list + detail ──────── */}
          <div className="iam-role-grid">
            {/* ── Left: app table ─────────────────────── */}
            <div className="iam-roles-pane">
              <div className="iam-pane-kicker">Applications ({filteredApps.length})</div>

              {filteredApps.length === 0 && !appsError && (
                <SvcState variant="empty" resourceName="apps" />
              )}

              {filteredApps.length > 0 && (
                <>
                  <div
                    className="table-row table-head"
                    style={{ display: 'grid', gridTemplateColumns: '80px 1.5fr 2fr 1.5fr 80px', gap: '0.75rem' }}
                  >
                    <div>Platform</div>
                    <div>Display Name</div>
                    <div>App ID</div>
                    <div>Package / Bundle</div>
                    <div>State</div>
                  </div>
                  <div style={{ overflowY: 'auto', maxHeight: 480 }}>
                    {filteredApps.map((app) => (
                      <button
                        key={`${app.platform}-${app.appId}`}
                        type="button"
                        className={`table-row overview-table-row ${selectedApp?.appId === app.appId ? 'active' : ''}`}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '80px 1.5fr 2fr 1.5fr 80px',
                          gap: '0.75rem',
                          width: '100%',
                          textAlign: 'left',
                          cursor: 'pointer'
                        }}
                        onClick={() => setSelectedApp(selectedApp?.appId === app.appId ? null : app)}
                      >
                        <span>{platformBadge(app.platform)}</span>
                        <span title={app.displayName} style={{ fontSize: '0.82rem' }}>
                          <strong>{trunc(app.displayName, 24)}</strong>
                        </span>
                        <span style={{ fontSize: '0.78rem', color: '#98afc3' }} title={app.appId}>
                          {trunc(app.appId, 32)}
                        </span>
                        <span style={{ fontSize: '0.78rem', color: '#98afc3' }} title={app.packageOrBundle}>
                          {trunc(app.packageOrBundle, 28)}
                        </span>
                        <span className={stateBadgeClass(app.state)} style={{ fontSize: '0.72rem' }}>
                          {app.state}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* ── Right: app detail ───────────────────── */}
            <div className="iam-policy-pane">
              <div className="iam-pane-kicker">App Detail</div>

              {!selectedApp && (
                <SvcState variant="empty" message="Select an app to view its details." compact />
              )}

              {selectedApp && selectedApp.platform === 'web' && (() => {
                const app = selectedApp.raw as GcpFirebaseWebAppSummary
                return (
                  <div style={{ padding: '0.75rem 0' }}>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Platform</div>
                      <div className="eks-kv-value">{platformBadge('web')}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">App ID</div>
                      <div className="eks-kv-value">{app.appId}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Display Name</div>
                      <div className="eks-kv-value">{app.displayName || '-'}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">State</div>
                      <div className="eks-kv-value">
                        <span className={stateBadgeClass(app.state || 'ACTIVE')}>{app.state || 'ACTIVE'}</span>
                      </div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">API Key ID</div>
                      <div className="eks-kv-value">{app.apiKeyId || '-'}</div>
                    </div>
                    {app.appUrls && app.appUrls.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div className="iam-pane-kicker" style={{ marginBottom: 6 }}>App URLs</div>
                        {app.appUrls.map((url, i) => (
                          <div key={i} className="eks-kv-row">
                            <div className="eks-kv-label">URL {i + 1}</div>
                            <div className="eks-kv-value" title={url}>{trunc(url, 48)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 16 }}>
                      <button
                        type="button"
                        className="svc-btn"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(
                          `gcloud firebase apps:sdkconfig web ${app.appId} --project ${projectId}`
                        )}
                        title="Fetch SDK config via gcloud"
                      >
                        Open in Console
                      </button>
                    </div>
                  </div>
                )
              })()}

              {selectedApp && selectedApp.platform === 'android' && (() => {
                const app = selectedApp.raw as GcpFirebaseAndroidAppSummary
                return (
                  <div style={{ padding: '0.75rem 0' }}>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Platform</div>
                      <div className="eks-kv-value">{platformBadge('android')}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">App ID</div>
                      <div className="eks-kv-value">{app.appId}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Display Name</div>
                      <div className="eks-kv-value">{app.displayName || '-'}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Package Name</div>
                      <div className="eks-kv-value">{app.packageName || '-'}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">State</div>
                      <div className="eks-kv-value">
                        <span className={stateBadgeClass(app.state || 'ACTIVE')}>{app.state || 'ACTIVE'}</span>
                      </div>
                    </div>
                    {app.sha1Hashes && app.sha1Hashes.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div className="iam-pane-kicker" style={{ marginBottom: 6 }}>SHA-1 Hashes</div>
                        {app.sha1Hashes.map((hash, i) => (
                          <div key={i} className="eks-kv-row">
                            <div className="eks-kv-label">SHA-1 #{i + 1}</div>
                            <div className="eks-kv-value" style={{ fontSize: '0.72rem', fontFamily: 'monospace' }}>{hash}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {app.sha256Hashes && app.sha256Hashes.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div className="iam-pane-kicker" style={{ marginBottom: 6 }}>SHA-256 Hashes</div>
                        {app.sha256Hashes.map((hash, i) => (
                          <div key={i} className="eks-kv-row">
                            <div className="eks-kv-label">SHA-256 #{i + 1}</div>
                            <div className="eks-kv-value" style={{ fontSize: '0.72rem', fontFamily: 'monospace' }}>{trunc(hash, 48)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 16 }}>
                      <button
                        type="button"
                        className="svc-btn"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(
                          `gcloud firebase apps:sdkconfig android ${app.appId} --project ${projectId}`
                        )}
                        title="Fetch SDK config via gcloud"
                      >
                        Open in Console
                      </button>
                    </div>
                  </div>
                )
              })()}

              {selectedApp && selectedApp.platform === 'ios' && (() => {
                const app = selectedApp.raw as GcpFirebaseIosAppSummary
                return (
                  <div style={{ padding: '0.75rem 0' }}>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Platform</div>
                      <div className="eks-kv-value">{platformBadge('ios')}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">App ID</div>
                      <div className="eks-kv-value">{app.appId}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Display Name</div>
                      <div className="eks-kv-value">{app.displayName || '-'}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Bundle ID</div>
                      <div className="eks-kv-value">{app.bundleId || '-'}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">Team ID</div>
                      <div className="eks-kv-value">{app.teamId || '-'}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">App Store ID</div>
                      <div className="eks-kv-value">{app.appStoreId || '-'}</div>
                    </div>
                    <div className="eks-kv-row">
                      <div className="eks-kv-label">State</div>
                      <div className="eks-kv-value">
                        <span className={stateBadgeClass(app.state || 'ACTIVE')}>{app.state || 'ACTIVE'}</span>
                      </div>
                    </div>
                    <div style={{ marginTop: 16 }}>
                      <button
                        type="button"
                        className="svc-btn"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(
                          `gcloud firebase apps:sdkconfig ios ${app.appId} --project ${projectId}`
                        )}
                        title="Fetch SDK config via gcloud"
                      >
                        Open in Console
                      </button>
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* TAB 3: HOSTING                                                   */}
      {/* ================================================================ */}
      {!isLoading && !globalError && mainTab === 'hosting' && (
        <div className="overview-surface">
          {hostingError && !enableAction && (
            <SvcState variant="error" error={hostingError} />
          )}

          <div className="iam-role-grid">
            {/* ── Left panel: hosting sites list ────────── */}
            <div className="iam-roles-pane">
              <div className="iam-pane-kicker">Hosting Sites ({hostingSites.length})</div>

              {hostingSites.length === 0 && !hostingError && (
                <SvcState variant="empty" resourceName="hosting sites" />
              )}

              {hostingSites.length > 0 && (
                <div style={{ overflowY: 'auto', maxHeight: 520 }}>
                  {hostingSites.map((site) => (
                    <button
                      key={site.siteId}
                      type="button"
                      className={`table-row overview-table-row ${selectedSite?.siteId === site.siteId ? 'active' : ''}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: '100%',
                        textAlign: 'left',
                        cursor: 'pointer',
                        padding: '0.65rem 0.75rem'
                      }}
                      onClick={() => setSelectedSite(selectedSite?.siteId === site.siteId ? null : site)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: '0.82rem' }}>{trunc(site.siteId, 28)}</strong>
                        <span className="status-badge" style={{ fontSize: '0.68rem' }}>{site.type || 'DEFAULT'}</span>
                      </div>
                      <div style={{ fontSize: '0.72rem', color: '#8fa3ba' }}>
                        {site.defaultUrl ? trunc(site.defaultUrl, 38) : 'No URL'}
                      </div>
                      {site.appId && (
                        <div style={{ fontSize: '0.68rem', color: '#6b7688' }}>
                          App: {trunc(site.appId, 32)}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ── Right panel: site details + sub-sections */}
            <div className="iam-policy-pane">
              {!selectedSite && (
                <SvcState variant="empty" message="Select a hosting site to view releases, domains, and channels." compact />
              )}

              {selectedSite && (
                <div>
                  {/* ── Site header ───────────────────────── */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div className="iam-pane-kicker">
                      Site: {selectedSite.siteId}
                    </div>
                    {selectedSite.defaultUrl && (
                      <button
                        type="button"
                        className="svc-btn success"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`open ${selectedSite.defaultUrl}`)}
                        title={`Open ${selectedSite.defaultUrl}`}
                      >
                        Open Site
                      </button>
                    )}
                  </div>

                  {/* ── Sub-section 1: Releases ──────────── */}
                  <div style={{ marginBottom: 20 }}>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>
                      Releases (latest 25)
                    </div>

                    {releasesLoading && <SvcState variant="loading" resourceName="releases" compact />}
                    {releasesError && !releasesLoading && <SvcState variant="error" error={releasesError} compact />}

                    {!releasesLoading && !releasesError && releases.length === 0 && (
                      <SvcState variant="empty" resourceName="releases" compact />
                    )}

                    {!releasesLoading && !releasesError && releases.length > 0 && (
                      <div style={{ overflowX: 'auto' }}>
                        <div
                          className="table-row table-head"
                          style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 1.5fr 1.5fr 1fr 70px', gap: '0.5rem', fontSize: '0.72rem' }}
                        >
                          <div>Version</div>
                          <div>Type</div>
                          <div>Status</div>
                          <div>Message</div>
                          <div>Released By</div>
                          <div>Release Time</div>
                          <div>Files</div>
                        </div>
                        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                          {releases.slice(0, 25).map((rel, idx) => (
                            <div
                              key={rel.version || idx}
                              className="table-row overview-table-row"
                              style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 1.5fr 1.5fr 1fr 70px', gap: '0.5rem', fontSize: '0.76rem' }}
                            >
                              <span title={rel.version}>{trunc(rel.version || '-', 20)}</span>
                              <span>{rel.type || '-'}</span>
                              <span className={releaseStatusBadge(rel.status || '')} style={{ fontSize: '0.68rem' }}>
                                {rel.status || '-'}
                              </span>
                              <span title={rel.message || ''} style={{ color: '#98afc3' }}>
                                {trunc(rel.message || '-', 30)}
                              </span>
                              <span title={rel.releaseUser?.email || ''} style={{ color: '#98afc3' }}>
                                {trunc(rel.releaseUser?.email || '-', 28)}
                              </span>
                              <span style={{ color: '#8fa3ba' }}>
                                {formatDateTime(rel.releaseTime)}
                              </span>
                              <span>{rel.fileCount != null ? rel.fileCount : '-'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── Sub-section 2: Domains ───────────── */}
                  <div style={{ marginBottom: 20 }}>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>
                      Domains
                    </div>

                    {domainsLoading && <SvcState variant="loading" resourceName="domains" compact />}
                    {domainsError && !domainsLoading && <SvcState variant="error" error={domainsError} compact />}

                    {!domainsLoading && !domainsError && domains.length === 0 && (
                      <SvcState variant="empty" resourceName="domains" compact />
                    )}

                    {!domainsLoading && !domainsError && domains.length > 0 && (
                      <div style={{ overflowX: 'auto' }}>
                        <div
                          className="table-row table-head"
                          style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr', gap: '0.5rem', fontSize: '0.72rem' }}
                        >
                          <div>Domain Name</div>
                          <div>Status</div>
                          <div>Provisioning</div>
                          <div>Redirect</div>
                        </div>
                        {domains.map((domain, idx) => (
                          <div
                            key={domain.domainName || idx}
                            className="table-row overview-table-row"
                            style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1.5fr', gap: '0.5rem', fontSize: '0.76rem' }}
                          >
                            <span title={domain.domainName}>{trunc(domain.domainName || '-', 36)}</span>
                            <span className={domainStatusBadge(domain.status || '')} style={{ fontSize: '0.68rem' }}>
                              {domain.status || '-'}
                            </span>
                            <span style={{ color: '#98afc3' }}>{domain.provisioning || '-'}</span>
                            <span style={{ color: '#8fa3ba' }}>{domain.domainRedirect ? `${domain.domainRedirect.type}: ${domain.domainRedirect.domainName}` : '-'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* ── Sub-section 3: Channels ──────────── */}
                  <div>
                    <div className="iam-pane-kicker" style={{ marginBottom: 8 }}>
                      Channels
                    </div>

                    {channelsLoading && <SvcState variant="loading" resourceName="channels" compact />}
                    {channelsError && !channelsLoading && <SvcState variant="error" error={channelsError} compact />}

                    {!channelsLoading && !channelsError && channels.length === 0 && (
                      <SvcState variant="empty" resourceName="channels" compact />
                    )}

                    {!channelsLoading && !channelsError && channels.length > 0 && (
                      <div style={{ overflowX: 'auto' }}>
                        <div
                          className="table-row table-head"
                          style={{ display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 80px 1fr', gap: '0.5rem', fontSize: '0.72rem' }}
                        >
                          <div>Channel ID</div>
                          <div>URL</div>
                          <div>Expire Time</div>
                          <div>Retained</div>
                          <div>Created</div>
                        </div>
                        {channels.map((ch, idx) => (
                          <div
                            key={ch.channelId || idx}
                            className="table-row overview-table-row"
                            style={{ display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 80px 1fr', gap: '0.5rem', fontSize: '0.76rem' }}
                          >
                            <span title={ch.channelId}>{trunc(ch.channelId || '-', 24)}</span>
                            <span title={ch.url || ''} style={{ color: '#98afc3' }}>
                              {trunc(ch.url || '-', 36)}
                            </span>
                            <span style={{ color: '#8fa3ba' }}>{formatDateTime(ch.expireTime)}</span>
                            <span>{ch.retainedReleaseCount != null ? ch.retainedReleaseCount : '-'}</span>
                            <span style={{ color: '#8fa3ba' }}>{formatDateTime(ch.createTime)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* TAB 4: POSTURE                                                   */}
      {/* ================================================================ */}
      {!isLoading && !globalError && mainTab === 'posture' && (
        <div className="overview-surface">
          {/* ── Summary stat cards ───────────────────── */}
          <div className="iam-shell-hero-stats" style={{ marginBottom: 20 }}>
            <div className="iam-shell-stat-card iam-shell-stat-card-accent">
              <span>Total Apps</span>
              <strong>{unifiedApps.length}</strong>
              <small>Across all platforms</small>
            </div>
            <div className="iam-shell-stat-card">
              <span>Hosting Sites</span>
              <strong>{hostingSites.length}</strong>
              <small>Firebase Hosting sites</small>
            </div>
            <div className="iam-shell-stat-card">
              <span>Active Domains</span>
              <strong>{activeDomains.length}</strong>
              <small>Connected or active domains</small>
            </div>
            <div className="iam-shell-stat-card">
              <span>Active Apps</span>
              <strong>{activeAppsCount}</strong>
              <small>Apps in ACTIVE state</small>
            </div>
          </div>

          {/* ── Platform breakdown ────────────────────── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-header">
              <h3 style={{ margin: 0, fontSize: '0.85rem' }}>Platform Breakdown</h3>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', padding: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {platformBadge('web')}
                <div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{webApps.length}</div>
                  <div style={{ fontSize: '0.72rem', color: '#8fa3ba' }}>Web apps registered</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {platformBadge('android')}
                <div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{androidApps.length}</div>
                  <div style={{ fontSize: '0.72rem', color: '#8fa3ba' }}>Android apps registered</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {platformBadge('ios')}
                <div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{iosApps.length}</div>
                  <div style={{ fontSize: '0.72rem', color: '#8fa3ba' }}>iOS apps registered</div>
                </div>
              </div>
            </div>
          </div>

          {/* ── App state breakdown ───────────────────── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-header">
              <h3 style={{ margin: 0, fontSize: '0.85rem' }}>App State Distribution</h3>
            </div>
            {appStateBreakdown.length === 0 ? (
              <SvcState variant="empty" message="No apps registered in this project." compact />
            ) : (
              <>
                <div
                  className="table-row table-head"
                  style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: '1rem' }}
                >
                  <div>State</div>
                  <div>Count</div>
                  <div>Distribution</div>
                </div>
                {appStateBreakdown.map(([state, count]) => {
                  const pct = unifiedApps.length > 0
                    ? Math.round((count / unifiedApps.length) * 100)
                    : 0
                  return (
                    <div
                      key={state}
                      className="table-row overview-table-row"
                      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: '1rem', alignItems: 'center' }}
                    >
                      <span className={stateBadgeClass(state)} style={{ fontSize: '0.76rem' }}>{state}</span>
                      <span style={{ fontWeight: 600 }}>{count}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          height: 6, borderRadius: 3,
                          background: 'rgba(145,176,207,0.12)', flex: 1, overflow: 'hidden'
                        }}>
                          <div style={{
                            height: '100%', borderRadius: 3,
                            width: `${pct}%`,
                            background: state === 'ACTIVE' ? '#4ade80' : '#fbbf24',
                            transition: 'width 0.3s ease'
                          }} />
                        </div>
                        <span style={{ fontSize: '0.72rem', color: '#8fa3ba', minWidth: 32 }}>{pct}%</span>
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </div>

          {/* ── Hosting sites summary ─────────────────── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-header">
              <h3 style={{ margin: 0, fontSize: '0.85rem' }}>Hosting Sites</h3>
            </div>
            {hostingSites.length === 0 ? (
              <SvcState variant="empty" message="No hosting sites configured." compact />
            ) : (
              <>
                <div
                  className="table-row table-head"
                  style={{ display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1.5fr', gap: '0.75rem' }}
                >
                  <div>Site ID</div>
                  <div>Default URL</div>
                  <div>Type</div>
                  <div>App ID</div>
                </div>
                {hostingSites.map((site) => (
                  <div
                    key={site.siteId}
                    className="table-row overview-table-row"
                    style={{ display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1.5fr', gap: '0.75rem' }}
                  >
                    <span>{trunc(site.siteId, 24)}</span>
                    <span style={{ color: '#98afc3' }}>{trunc(site.defaultUrl || '-', 36)}</span>
                    <span className="status-badge" style={{ fontSize: '0.68rem' }}>{site.type || 'DEFAULT'}</span>
                    <span style={{ color: '#8fa3ba', fontSize: '0.76rem' }}>{trunc(site.appId || '-', 28)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* ── Recent deployments ────────────────────── */}
          <div className="panel">
            <div className="panel-header">
              <h3 style={{ margin: 0, fontSize: '0.85rem' }}>Recent Deployments (last 5)</h3>
            </div>
            {recentReleases.length === 0 ? (
              <SvcState
                variant="empty"
                message="No releases found. Select a hosting site in the Hosting tab to load release data."
                compact
              />
            ) : (
              <>
                <div
                  className="table-row table-head"
                  style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 1.5fr 1.5fr 1fr', gap: '0.5rem', fontSize: '0.72rem' }}
                >
                  <div>Version</div>
                  <div>Type</div>
                  <div>Status</div>
                  <div>Message</div>
                  <div>Released By</div>
                  <div>Release Time</div>
                </div>
                {recentReleases.map((rel, idx) => (
                  <div
                    key={rel.version || idx}
                    className="table-row overview-table-row"
                    style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 1.5fr 1.5fr 1fr', gap: '0.5rem', fontSize: '0.76rem' }}
                  >
                    <span title={rel.version}>{trunc(rel.version || '-', 20)}</span>
                    <span>{rel.type || '-'}</span>
                    <span className={releaseStatusBadge(rel.status || '')} style={{ fontSize: '0.68rem' }}>
                      {rel.status || '-'}
                    </span>
                    <span title={rel.message || ''} style={{ color: '#98afc3' }}>
                      {trunc(rel.message || '-', 30)}
                    </span>
                    <span title={rel.releaseUser?.email || ''} style={{ color: '#98afc3' }}>
                      {trunc(rel.releaseUser?.email || '-', 28)}
                    </span>
                    <span style={{ color: '#8fa3ba' }}>{formatDateTime(rel.releaseTime)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
