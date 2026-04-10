import { useEffect, useMemo, useState } from 'react'
import './autoscaling.css'

import type {
  AzureKeyVaultSummary,
  AzureKeyVaultSecretSummary,
  AzureKeyVaultKeySummary
} from '@shared/types'
import {
  listAzureKeyVaults,
  listAzureKeyVaultSecrets,
  listAzureKeyVaultKeys
} from './api'
import { SvcState } from './SvcState'

type VaultDetailTab = 'secrets' | 'keys'

function boolBadge(value: boolean, trueLabel = 'Enabled', falseLabel = 'Disabled'): JSX.Element {
  return <span className={`svc-badge ${value ? 'ok' : 'danger'}`}>{value ? trueLabel : falseLabel}</span>
}

function truncate(value: string, max = 24): string {
  if (!value) return '-'
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`
}

export function AzureKeyVaultConsole({
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
  const [vaults, setVaults] = useState<AzureKeyVaultSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedName, setSelectedName] = useState('')
  const [detailTab, setDetailTab] = useState<VaultDetailTab>('secrets')
  const [secrets, setSecrets] = useState<AzureKeyVaultSecretSummary[]>([])
  const [keys, setKeys] = useState<AzureKeyVaultKeySummary[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  function doRefresh() {
    setLoading(true)
    setError('')
    listAzureKeyVaults(subscriptionId, location)
      .then(setVaults)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    listAzureKeyVaults(subscriptionId, location)
      .then((next) => { if (!cancelled) setVaults(next) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  const selected = useMemo(
    () => vaults.find((v) => v.name === selectedName) ?? null,
    [vaults, selectedName]
  )

  useEffect(() => {
    if (!selected) { setSecrets([]); setKeys([]); return }
    let cancelled = false
    setDetailLoading(true)
    setDetailError('')
    setDetailTab('secrets')
    Promise.all([
      listAzureKeyVaultSecrets(subscriptionId, selected.resourceGroup, selected.name),
      listAzureKeyVaultKeys(subscriptionId, selected.resourceGroup, selected.name)
    ])
      .then(([s, k]) => { if (!cancelled) { setSecrets(s); setKeys(k) } })
      .catch((e) => { if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selected?.name, subscriptionId])

  const filtered = useMemo(() => {
    if (!filter) return vaults
    const q = filter.toLowerCase()
    return vaults.filter((v) => v.name.toLowerCase().includes(q) || v.location.toLowerCase().includes(q))
  }, [vaults, filter])

  const softDeleteCount = useMemo(() => vaults.filter((v) => v.enableSoftDelete).length, [vaults])
  const rbacCount = useMemo(() => vaults.filter((v) => v.enableRbacAuthorization).length, [vaults])

  if (loading && !vaults.length) return <SvcState type="loading" message="Loading Key Vaults..." />

  return (
    <div className="svc-console asg-console azure-key-vault-theme">
      {error && !loading && <div className="svc-error">{error}</div>}

      {/* ── Hero ── */}
      <section className="asg-hero">
        <div className="asg-hero-copy">
          <div className="eyebrow">Security control plane</div>
          <h2>Key Vault posture</h2>
          <p>Browse Key Vaults, inspect secrets and keys metadata, and review soft-delete, purge protection, and RBAC authorization posture.</p>
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
              <span>Selected vault</span>
              <strong>{selectedName || 'None selected'}</strong>
            </div>
          </div>
        </div>
        <div className="asg-hero-stats">
          <div className="asg-stat-card asg-stat-card-accent">
            <span>Vaults</span>
            <strong>{vaults.length}</strong>
            <small>Key Vaults discovered in the active location.</small>
          </div>
          <div className="asg-stat-card">
            <span>Soft Delete</span>
            <strong>{softDeleteCount}</strong>
            <small>Vaults with soft-delete enabled.</small>
          </div>
          <div className="asg-stat-card">
            <span>RBAC Auth</span>
            <strong>{rbacCount}</strong>
            <small>Vaults using RBAC authorization.</small>
          </div>
          <div className="asg-stat-card">
            <span>Secrets</span>
            <strong>{selectedName ? (detailLoading ? '...' : secrets.length) : '-'}</strong>
            <small>{selectedName ? 'Secrets in the selected vault.' : 'Select a vault to view.'}</small>
          </div>
        </div>
      </section>

      <div className="asg-main-layout">
        {/* ── Left sidebar: Vault list ── */}
        <aside className="asg-groups-pane">
          <div className="asg-pane-head">
            <div>
              <span className="asg-pane-kicker">Discovered vaults</span>
              <h3>Vault inventory</h3>
            </div>
            <span className="asg-pane-summary">{vaults.length} total</span>
          </div>
          <input
            className="svc-search asg-search"
            placeholder="Filter vaults..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="asg-group-list">
            {filtered.map((v) => (
              <button
                key={v.name}
                type="button"
                className={`asg-group-card ${v.name === selectedName ? 'active' : ''}`}
                onClick={() => setSelectedName(v.name)}
              >
                <div className="asg-group-card-head">
                  <div className="asg-group-card-copy">
                    <strong>{v.name}</strong>
                    <span>{v.skuName}</span>
                  </div>
                  <span className={`svc-badge ${v.provisioningState === 'Succeeded' ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>{v.provisioningState}</span>
                </div>
                <div className="asg-group-card-metrics">
                  <div>
                    <span>Soft Del</span>
                    <strong>{v.enableSoftDelete ? 'Yes' : 'No'}</strong>
                  </div>
                  <div>
                    <span>Purge</span>
                    <strong>{v.enablePurgeProtection ? 'Yes' : 'No'}</strong>
                  </div>
                  <div>
                    <span>RBAC</span>
                    <strong>{v.enableRbacAuthorization ? 'Yes' : 'No'}</strong>
                  </div>
                </div>
              </button>
            ))}
            {!filtered.length && <div className="svc-empty">No Key Vaults found.</div>}
          </div>
        </aside>

        {/* ── Right pane: detail ── */}
        <section className="asg-detail-pane">
          {selected ? (
            <>
              {/* Detail hero */}
              <section className="asg-detail-hero">
                <div className="asg-detail-copy">
                  <div className="eyebrow">Selected vault</div>
                  <h3>{selected.name}</h3>
                  <p>Secrets, keys, and security posture for the active Key Vault.</p>
                  <div className="asg-meta-strip">
                    <div className="asg-meta-pill">
                      <span>SKU</span>
                      <strong>{selected.skuName}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Soft Delete</span>
                      <strong>{selected.enableSoftDelete ? `${selected.softDeleteRetentionInDays}d` : 'Off'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Purge Protection</span>
                      <strong>{selected.enablePurgeProtection ? 'On' : 'Off'}</strong>
                    </div>
                    <div className="asg-meta-pill">
                      <span>Public Access</span>
                      <strong>{selected.publicNetworkAccess}</strong>
                    </div>
                  </div>
                </div>
                <div className="asg-detail-glance">
                  <div className="asg-stat-card">
                    <span>Secrets</span>
                    <strong>{detailLoading ? '...' : secrets.length}</strong>
                    <small>Secret entries (names only).</small>
                  </div>
                  <div className="asg-stat-card">
                    <span>Keys</span>
                    <strong>{detailLoading ? '...' : keys.length}</strong>
                    <small>Cryptographic key entries.</small>
                  </div>
                </div>
              </section>

              {/* Tab bar */}
              <div className="svc-tab-bar asg-tab-bar" style={{ marginBottom: 12 }}>
                <button className={`svc-tab ${detailTab === 'secrets' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('secrets')}>Secrets ({secrets.length})</button>
                <button className={`svc-tab ${detailTab === 'keys' ? 'active' : ''}`} type="button" onClick={() => setDetailTab('keys')}>Keys ({keys.length})</button>
                <button className="svc-tab right" type="button" onClick={doRefresh}>Refresh</button>
              </div>

              {detailLoading && <SvcState type="loading" message="Loading vault contents..." />}
              {detailError && <div className="svc-error">{detailError}</div>}

              {/* Vault properties panel */}
              {!detailLoading && !detailError && (
                <div className="asg-toolbar-grid">
                  <section className="svc-panel asg-capacity-panel">
                    <div className="asg-section-head">
                      <div>
                        <span className="asg-pane-kicker">Vault configuration</span>
                        <h3>Properties &amp; access</h3>
                      </div>
                    </div>
                    <table className="svc-kv-table">
                      <tbody>
                        <tr><td>Resource Group</td><td>{selected.resourceGroup}</td></tr>
                        <tr><td>Location</td><td>{selected.location}</td></tr>
                        <tr><td>Vault URI</td><td><code style={{ wordBreak: 'break-all', fontSize: 11 }}>{selected.vaultUri}</code></td></tr>
                        <tr><td>Soft Delete</td><td>{boolBadge(selected.enableSoftDelete)} ({selected.softDeleteRetentionInDays} day retention)</td></tr>
                        <tr><td>Purge Protection</td><td>{boolBadge(selected.enablePurgeProtection)}</td></tr>
                        <tr><td>RBAC Authorization</td><td>{boolBadge(selected.enableRbacAuthorization)}</td></tr>
                        <tr><td>Public Network Access</td><td><span className={`svc-badge ${selected.publicNetworkAccess.toLowerCase() === 'enabled' ? 'ok' : 'warn'}`}>{selected.publicNetworkAccess}</span></td></tr>
                      </tbody>
                    </table>
                    <div className="svc-btn-row" style={{ marginTop: 12 }}>
                      <button type="button" className="svc-btn primary" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand(`az keyvault show --name "${selected.name}" --resource-group "${selected.resourceGroup}" --output table`)}>CLI details</button>
                      <button type="button" className="svc-btn muted" onClick={() => onOpenMonitor(`Microsoft.KeyVault vaults ${selected.name}`)}>Monitor</button>
                    </div>
                  </section>
                </div>
              )}

              {/* Secrets tab */}
              {!detailLoading && !detailError && detailTab === 'secrets' && (
                <div className="svc-table-area asg-table-area">
                  <table className="svc-table">
                    <thead><tr><th>Name</th><th>Enabled</th><th>Content Type</th><th>Managed</th><th>Created</th><th>Updated</th></tr></thead>
                    <tbody>
                      {secrets.map((s) => (
                        <tr key={s.id}>
                          <td><strong>{s.name}</strong></td>
                          <td>{boolBadge(s.enabled)}</td>
                          <td>{s.contentType || '-'}</td>
                          <td>{s.managed ? 'Yes' : 'No'}</td>
                          <td>{s.created ? new Date(Number(s.created) * 1000).toLocaleString() : '-'}</td>
                          <td>{s.updated ? new Date(Number(s.updated) * 1000).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!secrets.length && <div className="svc-empty">No secrets found in this vault.</div>}
                  <div style={{ color: '#9ca7b7', fontSize: 11, padding: '8px 4px' }}>Only secret names and metadata are shown. Secret values are never retrieved.</div>
                </div>
              )}

              {/* Keys tab */}
              {!detailLoading && !detailError && detailTab === 'keys' && (
                <div className="svc-table-area asg-table-area">
                  <table className="svc-table">
                    <thead><tr><th>Name</th><th>Enabled</th><th>Key Type</th><th>Operations</th><th>Created</th><th>Updated</th></tr></thead>
                    <tbody>
                      {keys.map((k) => (
                        <tr key={k.id}>
                          <td><strong>{k.name}</strong></td>
                          <td>{boolBadge(k.enabled)}</td>
                          <td>{k.keyType || '-'}</td>
                          <td>{k.keyOps.length ? truncate(k.keyOps.join(', '), 40) : '-'}</td>
                          <td>{k.created ? new Date(Number(k.created) * 1000).toLocaleString() : '-'}</td>
                          <td>{k.updated ? new Date(Number(k.updated) * 1000).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!keys.length && <div className="svc-empty">No keys found in this vault.</div>}
                </div>
              )}
            </>
          ) : (
            <div className="asg-empty-state">
              <div className="eyebrow">No selection</div>
              <h3>Select a Key Vault</h3>
              <p>Choose a vault from the inventory to inspect secrets, keys, and security configuration.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
