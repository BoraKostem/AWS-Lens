import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type {
  AzureAppServicePlanSummary,
  AzureWebAppSummary,
  AzureWebAppSlotSummary,
  AzureWebAppDeploymentSummary,
  AzureFunctionAppSummary,
  AzureFunctionSummary,
  AzureWebAppConfigSummary,
  AzureWebAppAction
} from '@shared/types'
import {
  listAzureAppServicePlans,
  listAzureWebApps,
  listAzureWebAppSlots,
  listAzureWebAppDeployments,
  listAzureFunctionApps,
  listAzureFunctions,
  getAzureWebAppConfiguration,
  runAzureWebAppAction
} from './api'
import { ConfirmButton } from './ConfirmButton'
import { SvcState } from './SvcState'

type AppKind = 'webApps' | 'functionApps'
type AppDetailTab = 'info' | 'config' | 'slots' | 'deployments' | 'functions'

function truncate(value: string, max = 30): string {
  if (!value) return '-'
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`
}

function formatDateTime(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function deploymentStatusLabel(status: number): { label: string; badge: 'ok' | 'danger' | 'warn' } {
  if (status === 4) return { label: 'Success', badge: 'ok' }
  if (status === 3) return { label: 'Failed', badge: 'danger' }
  if (status === 1 || status === 2) return { label: 'In Progress', badge: 'warn' }
  return { label: `Status ${status}`, badge: 'warn' }
}

export function AzureAppServiceConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenMonitor
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenMonitor: (query: string) => void
}): JSX.Element {
  const [appKind, setAppKind] = useState<AppKind>('webApps')
  const [plans, setPlans] = useState<AzureAppServicePlanSummary[]>([])
  const [apps, setApps] = useState<AzureWebAppSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedAppName, setSelectedAppName] = useState('')
  const [detailTab, setDetailTab] = useState<AppDetailTab>('info')
  const [slots, setSlots] = useState<AzureWebAppSlotSummary[]>([])
  const [deployments, setDeployments] = useState<AzureWebAppDeploymentSummary[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  // Function Apps state
  const [functionApps, setFunctionApps] = useState<AzureFunctionAppSummary[]>([])
  const [functionAppsLoading, setFunctionAppsLoading] = useState(false)
  const [selectedFuncAppId, setSelectedFuncAppId] = useState('')
  const [functions, setFunctions] = useState<AzureFunctionSummary[]>([])
  const [functionsLoading, setFunctionsLoading] = useState(false)

  // App config & actions state
  const [appConfig, setAppConfig] = useState<AzureWebAppConfigSummary | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState('')

  function doRefresh() {
    setLoading(true)
    setError('')
    Promise.all([listAzureAppServicePlans(subscriptionId, location), listAzureWebApps(subscriptionId, location)])
      .then(([p, a]) => { setPlans(p); setApps(a) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.all([listAzureAppServicePlans(subscriptionId, location), listAzureWebApps(subscriptionId, location)])
      .then(([p, a]) => { if (!cancelled) { setPlans(p); setApps(a) } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  const selectedApp = useMemo(
    () => apps.find((a) => a.name === selectedAppName) ?? null,
    [apps, selectedAppName]
  )

  useEffect(() => {
    if (!selectedApp) { setSlots([]); setDeployments([]); return }
    let cancelled = false
    setDetailLoading(true)
    setDetailError('')
    Promise.all([
      listAzureWebAppSlots(subscriptionId, selectedApp.resourceGroup, selectedApp.name),
      listAzureWebAppDeployments(subscriptionId, selectedApp.resourceGroup, selectedApp.name)
    ])
      .then(([s, d]) => { if (!cancelled) { setSlots(s); setDeployments(d) } })
      .catch((e) => { if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selectedApp?.name, subscriptionId])

  const filteredApps = useMemo(() => {
    if (!filter) return apps
    const q = filter.toLowerCase()
    return apps.filter((a) =>
      a.name.toLowerCase().includes(q) || a.kind.toLowerCase().includes(q) || a.appServicePlanName.toLowerCase().includes(q)
    )
  }, [apps, filter])

  const runningCount = useMemo(() => apps.filter((a) => a.state === 'Running').length, [apps])
  const httpsOnlyCount = useMemo(() => apps.filter((a) => a.httpsOnly).length, [apps])

  const selectedFuncApp = useMemo(
    () => functionApps.find((a) => a.id === selectedFuncAppId) ?? null,
    [functionApps, selectedFuncAppId]
  )

  // Load Function Apps when switching to that tab
  useEffect(() => {
    if (appKind === 'functionApps' && functionApps.length === 0 && !functionAppsLoading) {
      setFunctionAppsLoading(true)
      listAzureFunctionApps(subscriptionId, location)
        .then((next) => { setFunctionApps(next); if (next.length > 0) setSelectedFuncAppId(next[0].id) })
        .catch(() => {})
        .finally(() => setFunctionAppsLoading(false))
    }
  }, [appKind, subscriptionId, location, refreshNonce])

  // Load config when config tab is active for the selected web app
  useEffect(() => {
    if (detailTab === 'config' && selectedApp) {
      setConfigLoading(true)
      getAzureWebAppConfiguration(subscriptionId, selectedApp.resourceGroup, selectedApp.name)
        .then(setAppConfig)
        .catch(() => setAppConfig(null))
        .finally(() => setConfigLoading(false))
    }
  }, [detailTab, selectedApp?.id])

  // Load functions for selected function app
  useEffect(() => {
    const funcApp = functionApps.find((a) => a.id === selectedFuncAppId)
    if (funcApp && appKind === 'functionApps') {
      setFunctionsLoading(true)
      listAzureFunctions(subscriptionId, funcApp.resourceGroup, funcApp.name)
        .then(setFunctions)
        .catch(() => setFunctions([]))
        .finally(() => setFunctionsLoading(false))
    }
  }, [selectedFuncAppId, appKind])

  async function doWebAppAction(action: AzureWebAppAction): Promise<void> {
    if (!selectedApp) return
    setActionBusy(true)
    setActionMsg('')
    try {
      const result = await runAzureWebAppAction(subscriptionId, selectedApp.resourceGroup, selectedApp.name, action)
      setActionMsg(result.accepted ? `${action} sent to ${selectedApp.name}` : (result.error || `${action} failed`))
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  if (loading && !apps.length) return <SvcState variant="loading" message="Loading App Service resources..." />

  return (
    <div className="svc-console asg-console azure-app-service-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Compute control plane</div>
          <h2>App Service posture</h2>
          <p>Inspect App Service Plans and Web Apps, review deployment slots, and browse deployment history across the subscription.</p>
          <div className="asg-meta-strip">
            <div className="asg-meta-pill">
              <span>Subscription</span>
              <strong>{truncate(subscriptionId, 20)}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Location</span>
              <strong>{location || 'all'}</strong>
            </div>
            <div className="asg-meta-pill">
              <span>Selected app</span>
              <strong>{selectedAppName || 'None selected'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Plans</span>
            <strong>{plans.length}</strong>
            <small>App Service Plans in the active location.</small>
          </div>
          <div className="asg-stat-card">
            <span>Web Apps</span>
            <strong>{apps.length}</strong>
            <small>Applications discovered across all plans.</small>
          </div>
          <div className="asg-stat-card">
            <span>Running</span>
            <strong>{runningCount}</strong>
            <small>Apps with an active running state.</small>
          </div>
          <div className="asg-stat-card">
            <span>HTTPS Only</span>
            <strong>{httpsOnlyCount}</strong>
            <small>Apps enforcing HTTPS-only traffic.</small>
          </div>
        </div>
      </section>

      {/* ── Kind toggle ── */}
      <div className="svc-tab-bar" style={{ marginBottom: 12 }}>
        <button className={`svc-tab ${appKind === 'webApps' ? 'active' : ''}`} type="button" onClick={() => setAppKind('webApps')}>Web Apps</button>
        <button className={`svc-tab ${appKind === 'functionApps' ? 'active' : ''}`} type="button" onClick={() => setAppKind('functionApps')}>Function Apps</button>
      </div>

      {appKind === 'webApps' && (
      <div className="asg-main-layout">
        {/* ── Left sidebar: App list ── */}
        <aside className="asg-groups-pane">
          <div className="asg-pane-head">
            <div>
              <span className="asg-pane-kicker">Discovered apps</span>
              <h3>Web App inventory</h3>
            </div>
            <span className="asg-pane-summary">{apps.length} total</span>
          </div>
          <input
            className="svc-search asg-search"
            placeholder="Filter apps..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="asg-group-list">
            {filteredApps.map((a) => (
              <button
                key={a.name}
                type="button"
                className={`asg-group-card ${a.name === selectedAppName ? 'active' : ''}`}
                onClick={() => { setSelectedAppName(a.name); setDetailTab('info') }}
              >
                <div className="asg-group-card-head">
                  <div className="asg-group-card-copy">
                    <strong>{a.name}</strong>
                    <span>{a.kind}</span>
                  </div>
                  <span className={`svc-badge ${a.state === 'Running' ? 'ok' : a.state === 'Stopped' ? 'danger' : 'warn'}`} style={{ fontSize: 10 }}>{a.state}</span>
                </div>
                <div className="asg-group-card-metrics">
                  <div>
                    <span>Plan</span>
                    <strong>{truncate(a.appServicePlanName, 14)}</strong>
                  </div>
                  <div>
                    <span>HTTPS</span>
                    <strong>{a.httpsOnly ? 'Yes' : 'No'}</strong>
                  </div>
                  <div>
                    <span>TLS</span>
                    <strong>{a.minTlsVersion || '-'}</strong>
                  </div>
                </div>
              </button>
            ))}
            {!filteredApps.length && <div className="svc-empty">No web apps found.</div>}
          </div>
        </aside>

        {/* ── Right pane: detail ── */}
        <section className="asg-detail-pane">
          {selectedApp ? (
            <>
              {/* Detail hero */}
              <section className="asg-detail-hero">
                <div className="asg-detail-copy">
                  <div className="eyebrow">Selected app</div>
                  <h3>{selectedApp.name}</h3>
                  <p>Configuration, deployment slots, and deployment history for the active web app.</p>
                  <div className="asg-meta-strip">
                    <div className="asg-meta-pill">
                      <span>State</span>
                      <strong>{selectedApp.state}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Plan</span>
                      <strong>{selectedApp.appServicePlanName}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Runtime</span>
                      <strong>{selectedApp.runtimeStack || '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Hostname</span>
                      <strong>{truncate(selectedApp.defaultHostName, 28)}</strong>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    <button className="svc-btn svc-btn-success" type="button" disabled={actionBusy} onClick={() => void doWebAppAction('start')}>Start</button>
                    <ConfirmButton className="svc-btn svc-btn-warn" disabled={actionBusy} onConfirm={() => void doWebAppAction('stop')}>Stop</ConfirmButton>
                    <ConfirmButton className="svc-btn svc-btn-primary" disabled={actionBusy} onConfirm={() => void doWebAppAction('restart')}>Restart</ConfirmButton>
                  </div>
                  {actionMsg && <div style={{ fontSize: 12, color: '#9ca7b7', marginTop: 6 }}>{actionMsg}</div>}
                </div>
                <div className="asg-detail-glance">
                  <div className="asg-stat-card">
                    <span>Slots</span>
                    <strong>{detailLoading ? '...' : slots.length}</strong>
                    <small>Deployment slots configured.</small>
                  </div>
                  <div className="asg-stat-card">
                    <span>Deployments</span>
                    <strong>{detailLoading ? '...' : deployments.length}</strong>
                    <small>Recent deployment records.</small>
                  </div>
                </div>
              </section>

              {/* Detail tabs */}
              <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
                <button className={`svc-tab ${detailTab === 'info' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('info')}>Overview</button>
                <button className={`svc-tab ${detailTab === 'config' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('config')}>Configuration</button>
                <button className={`svc-tab ${detailTab === 'slots' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('slots')}>Slots ({slots.length})</button>
                <button className={`svc-tab ${detailTab === 'deployments' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('deployments')}>Deployments ({deployments.length})</button>
                <button className="svc-tab right" type="button" onClick={doRefresh}>Refresh</button>
              </div>

              {detailLoading && <SvcState variant="loading" message="Loading app details..." />}
              {detailError && <div className="svc-error">{detailError}</div>}

              {/* Overview tab */}
              {!detailLoading && !detailError && detailTab === 'info' && (
                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Configuration</span>
                        <h3>App settings</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Resource Group</td><td>{selectedApp.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selectedApp.location}</td></tr>
                        <tr><td>Kind</td><td>{selectedApp.kind}</td></tr>
                        <tr><td>Default Hostname</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selectedApp.defaultHostName}</code></td></tr>
                        <tr><td>Runtime Stack</td><td>{selectedApp.runtimeStack || '-'}</td></tr>
                        <tr><td>Enabled</td><td>{selectedApp.enabled ? 'Yes' : 'No'}</td></tr>
                        <tr><td>Last Modified</td><td>{formatDateTime(selectedApp.lastModifiedTimeUtc)}</td></tr>
                      </tbody>
                    </table>
                  </section>

                  <section className="svc-panel asg-filter-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Security posture</span>
                        <h3>Transport &amp; access</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>HTTPS Only</td><td><span className={`svc-badge ${selectedApp.httpsOnly ? 'ok' : 'danger'}`}>{selectedApp.httpsOnly ? 'Enforced' : 'Not enforced'}</span></td></tr>
                        <tr><td>Min TLS Version</td><td>{selectedApp.minTlsVersion || '-'}</td></tr>
                        <tr><td>HTTP/2</td><td>{selectedApp.http20Enabled ? 'Enabled' : 'Disabled'}</td></tr>
                        <tr><td>FTPS State</td><td><span className={`svc-badge ${selectedApp.ftpsState === 'Disabled' || selectedApp.ftpsState === 'FtpsOnly' ? 'ok' : 'warn'}`}>{selectedApp.ftpsState || '-'}</span></td></tr>
                        <tr><td>Public Access</td><td><span className={`svc-badge ${selectedApp.publicNetworkAccess.toLowerCase() === 'enabled' ? 'ok' : 'warn'}`}>{selectedApp.publicNetworkAccess}</span></td></tr>
                      </tbody>
                    </table>
                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az webapp show --name "${selectedApp.name}" --resource-group "${selectedApp.resourceGroup}" --output table`)}>CLI details</button>
                      <button type="button" className="svc-btn muted" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az webapp log tail --name "${selectedApp.name}" --resource-group "${selectedApp.resourceGroup}"`)}>Stream logs</button>
                      <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.Web sites ${selectedApp.name}`)}>Monitor</button>
                    </div>
                  </section>
                </div>
              )}

              {/* Slots tab */}
              {!detailLoading && !detailError && detailTab === 'slots' && (
                <div className="svc-table-area asg-table-area">
                  <table className="svc-table">
                    <thead><tr><th>Slot Name</th><th>State</th><th>Hostname</th><th>HTTPS Only</th><th>Enabled</th><th>Last Modified</th></tr></thead>
                    <tbody>
                      {slots.map((s) => (
                        <tr key={s.id}>
                          <td><strong>{s.slotName}</strong></td>
                          <td><span className={`svc-badge ${s.state === 'Running' ? 'ok' : s.state === 'Stopped' ? 'danger' : 'warn'}`}>{s.state}</span></td>
                          <td>{truncate(s.hostName, 40)}</td>
                          <td><span className={`svc-badge ${s.httpsOnly ? 'ok' : 'danger'}`}>{s.httpsOnly ? 'Yes' : 'No'}</span></td>
                          <td>{s.enabled ? 'Yes' : 'No'}</td>
                          <td>{formatDateTime(s.lastModifiedTimeUtc)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!slots.length && <div className="svc-empty">No deployment slots configured for this app.</div>}
                  <div className="svc-btn-row" style={{ marginTop: 12, padding: '0 4px' }}>
                    <button type="button" className="svc-btn muted" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az webapp deployment slot list --name "${selectedApp.name}" --resource-group "${selectedApp.resourceGroup}" --output table`)}>List slots (CLI)</button>
                  </div>
                </div>
              )}

              {/* Deployments tab */}
              {!detailLoading && !detailError && detailTab === 'deployments' && (
                <div className="svc-table-area asg-table-area">
                  <table className="svc-table">
                    <thead><tr><th>ID</th><th>Status</th><th>Author</th><th>Deployer</th><th>Message</th><th>Start</th><th>End</th><th>Active</th></tr></thead>
                    <tbody>
                      {deployments.map((d) => {
                        const ds = deploymentStatusLabel(d.status)
                        return (
                          <tr key={d.id}>
                            <td>{truncate(d.deploymentId, 16)}</td>
                            <td><span className={`svc-badge ${ds.badge}`}>{ds.label}</span></td>
                            <td>{d.author || '-'}</td>
                            <td>{d.deployer || '-'}</td>
                            <td title={d.message}>{truncate(d.message, 40)}</td>
                            <td>{formatDateTime(d.startTime)}</td>
                            <td>{formatDateTime(d.endTime)}</td>
                            <td>{d.active ? 'Yes' : 'No'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {!deployments.length && <div className="svc-empty">No deployments found for this app.</div>}
                </div>
              )}

              {/* Config tab */}
              {detailTab === 'config' && (
                <div>
                  {configLoading && <div style={{ color: '#9ca7b7', fontSize: 12 }}>Loading configuration...</div>}
                  {!configLoading && appConfig && (
                    <>
                      <h4 style={{ color: '#eef0f4', margin: '12px 0 8px' }}>General Settings</h4>
                      <div className="svc-kv">
                        <div className="svc-kv-label">Linux FX Version</div><div className="svc-kv-value">{appConfig.linuxFxVersion || '-'}</div>
                        <div className="svc-kv-label">Always On</div><div className="svc-kv-value">{appConfig.alwaysOn ? 'Yes' : 'No'}</div>
                        <div className="svc-kv-label">HTTP/2</div><div className="svc-kv-value">{appConfig.http20Enabled ? 'Enabled' : 'Disabled'}</div>
                        <div className="svc-kv-label">Min TLS</div><div className="svc-kv-value">{appConfig.minTlsVersion || '-'}</div>
                        <div className="svc-kv-label">FTPS State</div><div className="svc-kv-value">{appConfig.ftpsState || '-'}</div>
                      </div>
                      <h4 style={{ color: '#eef0f4', margin: '16px 0 8px' }}>App Settings ({appConfig.appSettings.length})</h4>
                      {appConfig.appSettings.length > 0 ? (
                        <div style={{ maxHeight: 200, overflow: 'auto' }}>
                          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                            <thead><tr><th style={{ textAlign: 'left', padding: '4px 8px', color: '#9ca7b7', borderBottom: '1px solid #3b4350' }}>Name</th><th style={{ textAlign: 'left', padding: '4px 8px', color: '#9ca7b7', borderBottom: '1px solid #3b4350' }}>Value</th></tr></thead>
                            <tbody>
                              {appConfig.appSettings.map((s) => (
                                <tr key={s.name}><td style={{ padding: '3px 8px', color: '#d0d8e2', borderBottom: '1px solid #262c35' }}>{s.name}</td><td style={{ padding: '3px 8px', color: '#9ca7b7', borderBottom: '1px solid #262c35', fontFamily: 'monospace', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.value || '-'}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : <div style={{ color: '#9ca7b7', fontSize: 12 }}>No app settings configured.</div>}
                      <h4 style={{ color: '#eef0f4', margin: '16px 0 8px' }}>Connection Strings ({appConfig.connectionStrings.length})</h4>
                      {appConfig.connectionStrings.length > 0 ? (
                        <div style={{ maxHeight: 150, overflow: 'auto' }}>
                          {appConfig.connectionStrings.map((cs) => (
                            <div key={cs.name} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 11, borderBottom: '1px solid #262c35' }}>
                              <span style={{ color: '#d0d8e2' }}>{cs.name}</span>
                              <span style={{ color: '#9ca7b7' }}>({cs.type})</span>
                            </div>
                          ))}
                        </div>
                      ) : <div style={{ color: '#9ca7b7', fontSize: 12 }}>No connection strings configured.</div>}
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="asg-empty-state">
              <div className="eyebrow">No selection</div>
              <h3>Select a Web App</h3>
              <p>Choose an app from the inventory to inspect its configuration, deployment slots, and deployment history.</p>
            </div>
          )}
        </section>
      </div>
      )}

      {appKind === 'functionApps' && (
      <div className="asg-main-layout">
        {/* ── Left sidebar: Function App list ── */}
        <aside className="asg-groups-pane">
          <div className="asg-pane-head">
            <div>
              <span className="asg-pane-kicker">Discovered apps</span>
              <h3>Function App inventory</h3>
            </div>
            <span className="asg-pane-summary">{functionApps.length} total</span>
          </div>
          <div className="asg-group-list">
            {functionAppsLoading && <SvcState variant="loading" message="Loading Function Apps..." />}
            {!functionAppsLoading && functionApps.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`asg-group-card ${a.id === selectedFuncAppId ? 'active' : ''}`}
                onClick={() => { setSelectedFuncAppId(a.id); setDetailTab('info') }}
              >
                <div className="asg-group-card-head">
                  <div className="asg-group-card-copy">
                    <strong>{a.name}</strong>
                    <span>{a.kind}</span>
                  </div>
                  <span className={`svc-badge ${a.state === 'Running' ? 'ok' : a.state === 'Stopped' ? 'danger' : 'warn'}`} style={{ fontSize: 10 }}>{a.state}</span>
                </div>
                <div className="asg-group-card-metrics">
                  <div>
                    <span>Plan</span>
                    <strong>{truncate(a.appServicePlanName, 14)}</strong>
                  </div>
                  <div>
                    <span>HTTPS</span>
                    <strong>{a.httpsOnly ? 'Yes' : 'No'}</strong>
                  </div>
                  <div>
                    <span>Runtime</span>
                    <strong>{truncate(a.runtimeStack || '-', 14)}</strong>
                  </div>
                </div>
              </button>
            ))}
            {!functionAppsLoading && !functionApps.length && <div className="svc-empty">No function apps found.</div>}
          </div>
        </aside>

        {/* ── Right pane: Function App detail ── */}
        <section className="asg-detail-pane">
          {selectedFuncApp ? (
            <>
              {/* Detail hero */}
              <section className="asg-detail-hero">
                <div className="asg-detail-copy">
                  <div className="eyebrow">Selected function app</div>
                  <h3>{selectedFuncApp.name}</h3>
                  <p>Overview and discovered functions for the active function app.</p>
                  <div className="asg-meta-strip">
                    <div className="asg-meta-pill">
                      <span>State</span>
                      <strong>{selectedFuncApp.state}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Hostname</span>
                      <strong>{truncate(selectedFuncApp.defaultHostName, 28)}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Runtime</span>
                      <strong>{selectedFuncApp.runtimeStack || '-'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Plan</span>
                      <strong>{selectedFuncApp.appServicePlanName}</strong>
                    </div>
                  </div>
                </div>
                <div className="asg-detail-glance">
                  <div className="asg-stat-card">
                    <span>Functions</span>
                    <strong>{functionsLoading ? '...' : functions.length}</strong>
                    <small>Discovered functions.</small>
                  </div>
                </div>
              </section>

              {/* Detail tabs */}
              <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
                <button className={`svc-tab ${detailTab === 'info' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('info')}>Overview</button>
                <button className={`svc-tab ${detailTab === 'functions' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('functions')}>Functions ({functions.length})</button>
                <button className="svc-tab right" type="button" onClick={doRefresh}>Refresh</button>
              </div>

              {/* Overview tab */}
              {detailTab === 'info' && (
                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Configuration</span>
                        <h3>Function App settings</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Name</td><td>{selectedFuncApp.name}</td></tr>
                        <tr><td>State</td><td><span className={`svc-badge ${selectedFuncApp.state === 'Running' ? 'ok' : selectedFuncApp.state === 'Stopped' ? 'danger' : 'warn'}`}>{selectedFuncApp.state}</span></td></tr>
                        <tr><td>Hostname</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selectedFuncApp.defaultHostName}</code></td></tr>
                        <tr><td>Runtime</td><td>{selectedFuncApp.runtimeStack || '-'}</td></tr>
                        <tr><td>Plan</td><td>{selectedFuncApp.appServicePlanName}</td></tr>
                        <tr><td>HTTPS Only</td><td><span className={`svc-badge ${selectedFuncApp.httpsOnly ? 'ok' : 'danger'}`}>{selectedFuncApp.httpsOnly ? 'Yes' : 'No'}</span></td></tr>
                        <tr><td>Enabled</td><td>{selectedFuncApp.enabled ? 'Yes' : 'No'}</td></tr>
                        <tr><td>Resource Group</td><td>{selectedFuncApp.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selectedFuncApp.location}</td></tr>
                        <tr><td>Public Access</td><td><span className={`svc-badge ${selectedFuncApp.publicNetworkAccess.toLowerCase() === 'enabled' ? 'ok' : 'warn'}`}>{selectedFuncApp.publicNetworkAccess}</span></td></tr>
                        <tr><td>Last Modified</td><td>{formatDateTime(selectedFuncApp.lastModifiedTimeUtc)}</td></tr>
                      </tbody>
                    </table>
                  </section>
                </div>
              )}

              {/* Functions tab */}
              {detailTab === 'functions' && (
                <div className="svc-table-area asg-table-area">
                  {functionsLoading && <SvcState variant="loading" message="Loading functions..." />}
                  {!functionsLoading && (
                    <>
                      <table className="svc-table">
                        <thead><tr><th>Name</th><th>Language</th><th>Disabled</th><th>Bindings</th></tr></thead>
                        <tbody>
                          {functions.map((f) => (
                            <tr key={f.name}>
                              <td><strong>{f.name}</strong></td>
                              <td>{f.language || '-'}</td>
                              <td><span className={`svc-badge ${f.isDisabled ? 'danger' : 'ok'}`}>{f.isDisabled ? 'Yes' : 'No'}</span></td>
                              <td>{f.bindingCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!functions.length && <div className="svc-empty">No functions discovered for this app.</div>}
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="asg-empty-state">
              <div className="eyebrow">No selection</div>
              <h3>Select a Function App</h3>
              <p>Choose a function app from the inventory to inspect its configuration and discovered functions.</p>
            </div>
          )}
        </section>
      </div>
      )}
    </div>
  )
}
