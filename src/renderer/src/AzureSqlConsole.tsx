import { useEffect, useMemo, useState } from 'react'
import './rds.css'
import './azure-sql.css'

import type {
  AzureMonitorActivityEvent,
  AzureSqlDatabaseSummary,
  AzureSqlEstateOverview,
  AzureSqlFinding,
  AzureSqlFirewallRule,
  AzureSqlOperationalTone,
  AzureSqlPostureBadge,
  AzureSqlServerDetail,
  AzureSqlServerSummary,
  AzureSqlSummaryTile
} from '@shared/types'
import { describeAzureSqlServer, getAzureSqlEstate, listAzureMonitorActivity } from './api'

type SideTab = 'overview' | 'databases' | 'timeline'
type ServerColumnKey = 'server' | 'resourceGroup' | 'network' | 'databases' | 'tls' | 'version'
type DatabaseColumnKey = 'name' | 'status' | 'sku' | 'size' | 'backup' | 'zoneRedundant'

const SERVER_COLUMNS: { key: ServerColumnKey; label: string; color: string }[] = [
  { key: 'server', label: 'Server', color: '#3b82f6' },
  { key: 'resourceGroup', label: 'Resource Group', color: '#8b5cf6' },
  { key: 'network', label: 'Network', color: '#22c55e' },
  { key: 'databases', label: 'Databases', color: '#f59e0b' },
  { key: 'tls', label: 'TLS', color: '#14b8a6' },
  { key: 'version', label: 'Version', color: '#06b6d4' }
]

const DATABASE_COLUMNS: { key: DatabaseColumnKey; label: string; color: string }[] = [
  { key: 'name', label: 'Database', color: '#3b82f6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'sku', label: 'SKU', color: '#8b5cf6' },
  { key: 'size', label: 'Max Size', color: '#f59e0b' },
  { key: 'backup', label: 'Backup', color: '#14b8a6' },
  { key: 'zoneRedundant', label: 'Zone Redundant', color: '#06b6d4' }
]

function getServerColumnValue(server: AzureSqlServerSummary, key: ServerColumnKey): string {
  switch (key) {
    case 'server': return server.name
    case 'resourceGroup': return server.resourceGroup
    case 'network': return server.publicNetworkAccess || '-'
    case 'databases': return String(server.databaseCount)
    case 'tls': return server.minimalTlsVersion || '-'
    case 'version': return server.version || '-'
  }
}

function toneClass(tone: AzureSqlOperationalTone): string {
  return `rds-tone-${tone}`
}

function severityClass(severity: AzureSqlFinding['severity']): string {
  return `rds-finding-${severity}`
}

function prettifyStatus(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function tileToneSummary(tone: AzureSqlOperationalTone): string {
  switch (tone) {
    case 'good': return 'Healthy operating signal'
    case 'warning': return 'Needs operator review'
    case 'risk': return 'Elevated operational risk'
    default: return 'Current observed posture'
  }
}

function KV({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="rds-kv">
      {items.map(([label, value]) => (
        <div key={label} className="rds-kv-row">
          <div className="rds-kv-label">{label}</div>
          <div className="rds-kv-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replace(/\s+/g, '-')
  return <span className={`rds-badge ${normalized === 'online' ? 'available' : normalized === 'offline' ? 'stopped' : normalized}`}>{status}</span>
}

function SummaryTiles({ items }: { items: AzureSqlSummaryTile[] }) {
  return (
    <div className="rds-summary-tiles">
      {items.map((item) => (
        <div key={item.id} className={`rds-summary-tile ${toneClass(item.tone)}`}>
          <div className="rds-summary-tile-label">{item.label}</div>
          <div className="rds-summary-tile-value">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

function PostureBadges({ items }: { items: AzureSqlPostureBadge[] }) {
  return (
    <div className="rds-posture-badges">
      {items.map((item) => (
        <div key={item.id} className={`rds-posture-badge ${toneClass(item.tone)}`}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  )
}

function FindingsList({ items }: { items: AzureSqlFinding[] }) {
  if (!items.length) {
    return <div className="rds-state-card rds-tone-good">No operational warnings detected.</div>
  }

  return (
    <div className="rds-stack-list">
      {items.map((item) => (
        <div key={item.id} className={`rds-finding-card ${severityClass(item.severity)}`}>
          <div className="rds-finding-title">{item.title}</div>
          <div className="rds-finding-text">{item.message}</div>
          <div className="rds-finding-recommendation">{item.recommendation}</div>
        </div>
      ))}
    </div>
  )
}

function FirewallRulesTable({ rules }: { rules: AzureSqlFirewallRule[] }) {
  if (!rules.length) {
    return <div className="rds-state-card">No firewall rules configured.</div>
  }

  return (
    <div className="rds-table-area" style={{ maxHeight: '240px' }}>
      <table className="rds-data-table">
        <thead>
          <tr>
            <th>Rule Name</th>
            <th>Start IP</th>
            <th>End IP</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.name}>
              <td>{rule.name}</td>
              <td>{rule.startIpAddress}</td>
              <td>{rule.endIpAddress}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AzureSqlConsole({
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
  const [overview, setOverview] = useState<AzureSqlEstateOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')

  const [selectedServerName, setSelectedServerName] = useState('')
  const [serverDetail, setServerDetail] = useState<AzureSqlServerDetail | null>(null)

  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [selectedDatabaseName, setSelectedDatabaseName] = useState('')

  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [visibleServerCols, setVisibleServerCols] = useState<Set<ServerColumnKey>>(new Set(SERVER_COLUMNS.map((c) => c.key)))
  const [visibleDbCols, setVisibleDbCols] = useState<Set<DatabaseColumnKey>>(new Set(DATABASE_COLUMNS.map((c) => c.key)))

  const [timelineEvents, setTimelineEvents] = useState<AzureMonitorActivityEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')

  const servers = overview?.servers ?? []
  const selectedServer = useMemo(() => servers.find((s) => s.name === selectedServerName) ?? null, [servers, selectedServerName])

  const filteredServers = useMemo(() => {
    return servers.filter((server) => {
      if (statusFilter === 'public' && server.publicNetworkAccess.toLowerCase() !== 'enabled') return false
      if (statusFilter === 'private' && server.publicNetworkAccess.toLowerCase() === 'enabled') return false
      if (!search) return true
      const needle = search.toLowerCase()
      return [...visibleServerCols].some((col) => getServerColumnValue(server, col).toLowerCase().includes(needle))
    })
  }, [servers, search, statusFilter, visibleServerCols])

  const activeServerCols = SERVER_COLUMNS.filter((c) => visibleServerCols.has(c.key))
  const activeDbCols = DATABASE_COLUMNS.filter((c) => visibleDbCols.has(c.key))

  const selectedDatabase = useMemo(
    () => serverDetail?.databases.find((db) => db.name === selectedDatabaseName) ?? null,
    [serverDetail, selectedDatabaseName]
  )

  const detailHeroStats = serverDetail?.summaryTiles.slice(0, 4) ?? []
  const overviewTitle = serverDetail?.server.name ?? ''
  const selectedFindingCount = serverDetail?.findings.length ?? 0
  const messageTone = msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('error')
    ? 'error'
    : 'success'

  async function loadServerDetail(serverName: string) {
    const server = servers.find((s) => s.name === serverName)
    if (!server) return
    try {
      const detail = await describeAzureSqlServer(subscriptionId, server.resourceGroup, serverName)
      setServerDetail(detail)
      setSelectedDatabaseName(detail.databases[0]?.name ?? '')
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
      setServerDetail(null)
    }
  }

  async function reload() {
    setLoading(true)
    setMsg('')
    try {
      const estate = await getAzureSqlEstate(subscriptionId, location)
      setOverview(estate)

      const resolvedServer = (selectedServerName && estate.servers.some((s) => s.name === selectedServerName))
        ? selectedServerName
        : estate.servers[0]?.name ?? ''

      setSelectedServerName(resolvedServer)
      if (resolvedServer) {
        const server = estate.servers.find((s) => s.name === resolvedServer)
        if (server) {
          const detail = await describeAzureSqlServer(subscriptionId, server.resourceGroup, resolvedServer)
          setServerDetail(detail)
          setSelectedDatabaseName(detail.databases[0]?.name ?? '')
        }
      } else {
        setServerDetail(null)
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [subscriptionId, location, refreshNonce])

  async function selectServer(name: string) {
    setSelectedServerName(name)
    setSideTab('overview')
    setMsg('')
    setTimelineEvents([])
    setTimelineError('')
    await loadServerDetail(name)
  }

  async function loadTimeline() {
    if (!selectedServerName) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const result = await listAzureMonitorActivity(subscriptionId, location, `Microsoft.Sql|${selectedServerName}`, 168)
      setTimelineEvents(result.events)
    } catch (error) {
      setTimelineEvents([])
      setTimelineError(error instanceof Error ? error.message : 'Failed to load activity')
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (sideTab === 'timeline') void loadTimeline()
  }, [sideTab, selectedServerName])

  function toggleServerCol(key: ServerColumnKey) {
    setVisibleServerCols((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function toggleDbCol(key: DatabaseColumnKey) {
    setVisibleDbCols((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  if (loading) return <div className="rds-empty">Loading Azure SQL data...</div>

  return (
    <div className="rds-console azure-sql-theme">
      <section className="rds-shell-hero">
        <div className="rds-shell-hero-copy">
          <div className="eyebrow">Azure SQL</div>
          <h2>{overviewTitle || 'SQL Server command center'}</h2>
          <p>
            Monitor server posture, review firewall rules and database inventory, and run operational actions without leaving the console.
          </p>
          <div className="rds-shell-meta-strip">
            <div className="rds-shell-meta-pill">
              <span>Scope</span>
              <strong>SQL Servers</strong>
            </div>
            <div className="rds-shell-meta-pill">
              <span>Subscription</span>
              <strong>{subscriptionId}</strong>
            </div>
            <div className="rds-shell-meta-pill">
              <span>Selection</span>
              <strong>{overviewTitle || 'None selected'}</strong>
            </div>
            <div className="rds-shell-meta-pill">
              <span>Region</span>
              <strong>{location || 'All regions'}</strong>
            </div>
          </div>
        </div>
        <div className="rds-shell-hero-stats">
          <div className="rds-shell-stat-card rds-shell-stat-card-accent">
            <span>Server fleet</span>
            <strong>{overview?.serverCount ?? 0}</strong>
            <small>{filteredServers.length} visible with current filters</small>
          </div>
          <div className="rds-shell-stat-card">
            <span>Databases</span>
            <strong>{overview?.databaseCount ?? 0}</strong>
            <small>Total databases across the region lens</small>
          </div>
          <div className="rds-shell-stat-card">
            <span>Public servers</span>
            <strong>{overview?.publicServerCount ?? 0}</strong>
            <small>Servers with public network access enabled</small>
          </div>
          <div className={`rds-shell-stat-card ${selectedFindingCount > 0 ? 'warning' : 'success'}`}>
            <span>Selected server</span>
            <strong>{selectedServer ? prettifyStatus(selectedServer.name) : 'Standby'}</strong>
            <small>{selectedFindingCount} findings, {serverDetail?.firewallRules.length ?? 0} firewall rules</small>
          </div>
        </div>
      </section>

      <div className="rds-shell-toolbar">
        <div className="rds-toolbar">
          <button
            className="rds-toolbar-btn accent"
            type="button"
            onClick={() => void reload()}
          >
            Refresh Inventory
          </button>
        </div>
        <div className="rds-shell-status">
          <div className="rds-shell-status-card">
            <span>Network filter</span>
            <select className="rds-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All servers</option>
              <option value="public">Public only</option>
              <option value="private">Private only</option>
            </select>
          </div>
          <div className="rds-shell-status-card rds-shell-status-search">
            <span>Search</span>
            <input
              className="rds-search-input"
              placeholder="Filter rows across selected columns..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {msg && <div className={`rds-msg ${messageTone}`}>{msg}</div>}
      {!msg && overview?.notes && overview.notes.length > 0 && (
        <div className="rds-msg info">{overview.notes.join(' ')}</div>
      )}

      <div className="rds-main-layout">
        <div className="rds-table-panel">
          <div className="rds-pane-head">
            <div>
              <span className="rds-pane-kicker">Tracked servers</span>
              <h3>Server inventory</h3>
            </div>
            <span className="rds-pane-summary">{filteredServers.length} shown</span>
          </div>

          <div className="rds-column-chips">
            {SERVER_COLUMNS.map((column) => {
              const active = visibleServerCols.has(column.key)
              return (
                <button
                  key={column.key}
                  className={`rds-chip ${active ? 'active' : ''}`}
                  type="button"
                  style={active ? { background: column.color, borderColor: column.color, color: '#fff' } : undefined}
                  onClick={() => toggleServerCol(column.key)}
                >
                  {column.label}
                </button>
              )
            })}
          </div>

          <div className="rds-table-area">
            <table className="rds-data-table">
              <thead>
                <tr>
                  {activeServerCols.map((col) => <th key={col.key}>{col.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {filteredServers.map((server) => (
                  <tr
                    key={server.id}
                    className={server.name === selectedServerName ? 'active' : ''}
                    onClick={() => void selectServer(server.name)}
                  >
                    {activeServerCols.map((col) => (
                      <td key={col.key}>
                        {col.key === 'network'
                          ? <StatusBadge status={server.publicNetworkAccess.toLowerCase() === 'enabled' ? 'Enabled' : 'Disabled'} />
                          : getServerColumnValue(server, col.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredServers.length && <div className="rds-empty">No SQL servers match filters.</div>}
          </div>
        </div>

        <div className="rds-sidebar">
          {serverDetail ? (
            <>
              <section className="rds-detail-hero">
                <div className="rds-detail-hero-copy">
                  <div className="eyebrow">Server posture</div>
                  <h3>{serverDetail.server.name}</h3>
                  <p>Security posture, firewall configuration, and database inventory for the selected SQL server.</p>
                  <div className="rds-detail-meta-strip">
                    <div className="rds-detail-meta-pill">
                      <span>FQDN</span>
                      <strong>{serverDetail.server.fullyQualifiedDomainName || 'N/A'}</strong>
                    </div>
                    <div className="rds-detail-meta-pill">
                      <span>Region</span>
                      <strong>{serverDetail.server.location}</strong>
                    </div>
                    <div className="rds-detail-meta-pill">
                      <span>Databases</span>
                      <strong>{serverDetail.databases.length}</strong>
                    </div>
                    <div className="rds-detail-meta-pill">
                      <span>Firewall</span>
                      <strong>{serverDetail.firewallRules.length} rules</strong>
                    </div>
                  </div>
                </div>
                <div className="rds-detail-hero-stats">
                  {detailHeroStats.map((item) => (
                    <div key={item.id} className={`rds-detail-stat-card ${item.tone}`}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                      <small>{tileToneSummary(item.tone)}</small>
                    </div>
                  ))}
                  {!detailHeroStats.length && (
                    <div className="rds-detail-stat-card info">
                      <span>Selection</span>
                      <strong>Standby</strong>
                      <small>Select a server to inspect posture.</small>
                    </div>
                  )}
                </div>
              </section>

              <div className="rds-side-tabs">
                <button className={sideTab === 'overview' ? 'active' : ''} type="button" onClick={() => setSideTab('overview')}>
                  Overview
                </button>
                <button className={sideTab === 'databases' ? 'active' : ''} type="button" onClick={() => setSideTab('databases')}>
                  Databases
                </button>
                <button className={sideTab === 'timeline' ? 'active' : ''} type="button" onClick={() => setSideTab('timeline')}>
                  Activity Timeline
                </button>
              </div>

              {sideTab === 'overview' && (
                <>
                  <div className="rds-sidebar-section">
                    <div className="rds-overview-head">
                      <div>
                        <div className="rds-overview-kicker">Server operations</div>
                        <h3>{serverDetail.server.name}</h3>
                      </div>
                      <StatusBadge status={serverDetail.server.publicNetworkAccess.toLowerCase() === 'enabled' ? 'Public' : 'Private'} />
                    </div>
                    <SummaryTiles items={serverDetail.summaryTiles} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Posture</h3>
                    <PostureBadges items={serverDetail.badges} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Operational Findings</h3>
                    <FindingsList items={serverDetail.findings} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Server Detail</h3>
                    <KV items={serverDetail.connectionDetails.map((item) => [item.label, item.value])} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Firewall Rules</h3>
                    <FirewallRulesTable rules={serverDetail.firewallRules} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Actions</h3>
                    <div className="rds-actions-grid">
                      <button
                        className="rds-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az sql server show -g "${serverDetail.server.resourceGroup}" -n "${serverDetail.server.name}" --subscription "${subscriptionId}" --output jsonc`)}
                      >
                        Server Snapshot
                      </button>
                      <button
                        className="rds-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az sql db list -g "${serverDetail.server.resourceGroup}" -s "${serverDetail.server.name}" --subscription "${subscriptionId}" --output table`)}
                      >
                        List Databases
                      </button>
                      <button
                        className="rds-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az sql server firewall-rule list -g "${serverDetail.server.resourceGroup}" -s "${serverDetail.server.name}" --subscription "${subscriptionId}" --output table`)}
                      >
                        List Firewall Rules
                      </button>
                      <button
                        className="rds-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az sql server ad-admin list -g "${serverDetail.server.resourceGroup}" -s "${serverDetail.server.name}" --subscription "${subscriptionId}" --output jsonc`)}
                      >
                        List AD Admins
                      </button>
                      <button
                        className="rds-action-btn"
                        type="button"
                        disabled={!canRunTerminalCommand}
                        onClick={() => onRunTerminalCommand(`az sql server conn-policy show -g "${serverDetail.server.resourceGroup}" -s "${serverDetail.server.name}" --subscription "${subscriptionId}" --output jsonc`)}
                      >
                        Connection Policy
                      </button>
                      <button
                        className="rds-action-btn"
                        type="button"
                        onClick={() => onOpenMonitor(`Microsoft.Sql ${serverDetail.server.name}`)}
                      >
                        Open Monitor
                      </button>
                    </div>
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Connection Metadata</h3>
                    <KV items={[
                      ['Hostname', serverDetail.server.fullyQualifiedDomainName || 'N/A'],
                      ['Port', '1433'],
                      ['Connection string', `Server=tcp:${serverDetail.server.fullyQualifiedDomainName || 'N/A'},1433;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;`]
                    ]} />
                  </div>

                  <div className="rds-sidebar-section">
                    <h3>Operational Recommendations</h3>
                    <div className="rds-suggestions">
                      {serverDetail.recommendations.map((item) => (
                        <div key={item} className="rds-suggestion-item">{item}</div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {sideTab === 'databases' && (
                <>
                  <div className="rds-sidebar-section">
                    <div className="rds-pane-head">
                      <div>
                        <span className="rds-pane-kicker">{serverDetail.server.name}</span>
                        <h3>Database inventory</h3>
                      </div>
                      <span className="rds-pane-summary">{serverDetail.databases.length} databases</span>
                    </div>

                    <div className="rds-column-chips" style={{ marginTop: '8px' }}>
                      {DATABASE_COLUMNS.map((column) => {
                        const active = visibleDbCols.has(column.key)
                        return (
                          <button
                            key={column.key}
                            className={`rds-chip ${active ? 'active' : ''}`}
                            type="button"
                            style={active ? { background: column.color, borderColor: column.color, color: '#fff' } : undefined}
                            onClick={() => toggleDbCol(column.key)}
                          >
                            {column.label}
                          </button>
                        )
                      })}
                    </div>

                    <div className="rds-table-area" style={{ maxHeight: '320px', marginTop: '8px' }}>
                      <table className="rds-data-table">
                        <thead>
                          <tr>
                            {activeDbCols.map((col) => <th key={col.key}>{col.label}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {serverDetail.databases.map((db) => (
                            <tr
                              key={db.id}
                              className={db.name === selectedDatabaseName ? 'active' : ''}
                              onClick={() => setSelectedDatabaseName(db.name)}
                            >
                              {activeDbCols.map((col) => (
                                <td key={col.key}>
                                  {col.key === 'name' ? db.name
                                    : col.key === 'status' ? <StatusBadge status={db.status || '-'} />
                                    : col.key === 'sku' ? `${db.skuName || db.edition || '-'}`
                                    : col.key === 'size' ? (db.maxSizeGb ? `${db.maxSizeGb} GB` : '-')
                                    : col.key === 'backup' ? (db.backupStorageRedundancy || '-')
                                    : col.key === 'zoneRedundant' ? (db.zoneRedundant ? 'Yes' : 'No')
                                    : '-'}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!serverDetail.databases.length && <div className="rds-empty">No databases found on this server.</div>}
                    </div>
                  </div>

                  {selectedDatabase && (
                    <div className="rds-sidebar-section">
                      <h3>Database Detail</h3>
                      <KV items={[
                        ['Name', selectedDatabase.name],
                        ['Status', selectedDatabase.status || '-'],
                        ['SKU', selectedDatabase.skuName || '-'],
                        ['Edition', selectedDatabase.edition || '-'],
                        ['Max Size', selectedDatabase.maxSizeGb ? `${selectedDatabase.maxSizeGb} GB` : '-'],
                        ['Zone Redundant', selectedDatabase.zoneRedundant ? 'Yes' : 'No'],
                        ['Read Scale', selectedDatabase.readScale || 'Disabled'],
                        ['Auto-pause', selectedDatabase.autoPauseDelayMinutes > 0 ? `${selectedDatabase.autoPauseDelayMinutes} min` : 'Disabled'],
                        ['Backup Redundancy', selectedDatabase.backupStorageRedundancy || '-'],
                        ['Server', selectedDatabase.serverName],
                        ['Resource Group', selectedDatabase.resourceGroup],
                        ['Region', selectedDatabase.location]
                      ]} />
                    </div>
                  )}

                  {selectedDatabase && (
                    <div className="rds-sidebar-section">
                      <h3>Database Actions</h3>
                      <div className="rds-actions-grid">
                        <button
                          className="rds-action-btn"
                          type="button"
                          disabled={!canRunTerminalCommand}
                          onClick={() => onRunTerminalCommand(`az sql db show -g "${selectedDatabase.resourceGroup}" -s "${selectedDatabase.serverName}" -n "${selectedDatabase.name}" --subscription "${subscriptionId}" --output jsonc`)}
                        >
                          Database Snapshot
                        </button>
                        <button
                          className="rds-action-btn"
                          type="button"
                          disabled={!canRunTerminalCommand}
                          onClick={() => onRunTerminalCommand(`az sql db audit-policy show -g "${selectedDatabase.resourceGroup}" -s "${selectedDatabase.serverName}" -n "${selectedDatabase.name}" --subscription "${subscriptionId}" --output jsonc`)}
                        >
                          Audit Policy
                        </button>
                        <button
                          className="rds-action-btn"
                          type="button"
                          disabled={!canRunTerminalCommand}
                          onClick={() => onRunTerminalCommand(`az sql db tde show -g "${selectedDatabase.resourceGroup}" -s "${selectedDatabase.serverName}" -n "${selectedDatabase.name}" --subscription "${subscriptionId}" --output jsonc`)}
                        >
                          TDE Status
                        </button>
                        <button
                          className="rds-action-btn"
                          type="button"
                          disabled={!canRunTerminalCommand}
                          onClick={() => onRunTerminalCommand(`az sql db show-connection-string -s "${serverDetail.server.fullyQualifiedDomainName}" -n "${selectedDatabase.name}" -c ado.net --output tsv`)}
                        >
                          Connection String
                        </button>
                        <button
                          className="rds-action-btn"
                          type="button"
                          disabled={!canRunTerminalCommand}
                          onClick={() => onRunTerminalCommand(`az sql db list-editions -l "${serverDetail.server.location}" --subscription "${subscriptionId}" --output table`)}
                        >
                          Available Editions
                        </button>
                        <button
                          className="rds-action-btn"
                          type="button"
                          onClick={() => onOpenMonitor(`Microsoft.Sql ${selectedDatabase.name}`)}
                        >
                          Open Monitor
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {sideTab === 'timeline' && (
                <div className="rds-sidebar-section">
                  <h3>Azure Monitor Activity</h3>
                  <div className="rds-sidebar-hint">Management-plane events for <strong>{selectedServerName}</strong> from the last 7 days.</div>
                  {!selectedServerName && <div className="rds-empty">Select a server to view activity.</div>}
                  {selectedServerName && timelineLoading && <div className="rds-empty">Loading activity events...</div>}
                  {selectedServerName && !timelineLoading && timelineError && <div className="rds-empty" style={{ color: '#f87171' }}>{timelineError}</div>}
                  {selectedServerName && !timelineLoading && !timelineError && timelineEvents.length === 0 && <div className="rds-empty">No Azure Monitor events found.</div>}
                  {selectedServerName && !timelineLoading && timelineEvents.length > 0 && (
                    <div className="rds-timeline-table-wrap">
                      <table className="rds-timeline-table">
                        <thead>
                          <tr>
                            <th>Operation</th>
                            <th>Status</th>
                            <th>Caller</th>
                            <th>Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {timelineEvents.map((event) => (
                            <tr key={event.id}>
                              <td title={event.resourceType}>{event.operationName}</td>
                              <td>{event.status}</td>
                              <td>{event.caller}</td>
                              <td>{event.timestamp ? new Date(event.timestamp).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="rds-sidebar-section">
              <div className="rds-empty-state">
                <span className="rds-pane-kicker">No server selected</span>
                <h3>Choose a SQL server to inspect posture.</h3>
                <p>
                  The detail pane will show security posture, firewall configuration, database inventory, and Azure Monitor activity for the selected server.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
