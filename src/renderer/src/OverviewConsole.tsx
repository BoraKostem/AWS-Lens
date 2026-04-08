import { useEffect, useMemo, useState } from 'react'

import type { AwsCapabilityHint, AwsConnection, CostBreakdown, InsightItem, OverviewAccountContext, OverviewMetrics, OverviewStatistics, RegionMetric, RegionalSignal, RelationshipMap, ServiceId, ServiceRelationship, TagSearchResult } from '@shared/types'
import { useAwsPageConnection } from './AwsPage'
import { getCostBreakdown, getOverviewAccountContext, getOverviewMetrics, getOverviewStatistics, getRelationshipMap, searchByTag } from './api'
import { SvcState, variantForError } from './SvcState'

type OverviewTab = 'overview' | 'relationships' | 'statistics' | 'tags'
type RelFilterType = 'all' | string
type InsightFilter = 'all' | 'info' | 'warning' | 'error'
type SignalFilter = 'all' | 'cost' | 'security' | 'operations' | 'cleanup'
type TagResourceTypeFilter = 'all' | string

type ServiceTileDef = {
  key: keyof RegionMetric
  label: string
  serviceId: ServiceId
}

const SERVICE_TILES: ServiceTileDef[] = [
  { key: 'ec2Count', label: 'EC2 Instances', serviceId: 'ec2' },
  { key: 'lambdaCount', label: 'Lambda Functions', serviceId: 'lambda' },
  { key: 'eksCount', label: 'EKS Clusters', serviceId: 'eks' },
  { key: 'asgCount', label: 'Auto Scaling Groups', serviceId: 'auto-scaling' },
  { key: 's3Count', label: 'S3 Buckets', serviceId: 's3' },
  { key: 'rdsCount', label: 'RDS Instances', serviceId: 'rds' },
  { key: 'cloudformationCount', label: 'CloudFormation Stacks', serviceId: 'cloudformation' },
  { key: 'ecrCount', label: 'ECR Repositories', serviceId: 'ecr' },
  { key: 'ecsCount', label: 'ECS Clusters', serviceId: 'ecs' },
  { key: 'vpcCount', label: 'VPCs', serviceId: 'vpc' },
  { key: 'loadBalancerCount', label: 'Load Balancers', serviceId: 'load-balancers' },
  { key: 'route53Count', label: 'Route 53 Zones', serviceId: 'route53' },
  { key: 'securityGroupCount', label: 'Security Groups', serviceId: 'security-groups' },
  { key: 'snsCount', label: 'SNS Topics', serviceId: 'sns' },
  { key: 'sqsCount', label: 'SQS Queues', serviceId: 'sqs' },
  { key: 'acmCount', label: 'ACM Certificates', serviceId: 'acm' },
  { key: 'kmsCount', label: 'KMS Keys', serviceId: 'kms' },
  { key: 'wafCount', label: 'WAF Web ACLs', serviceId: 'waf' },
  { key: 'secretsManagerCount', label: 'Secrets', serviceId: 'secrets-manager' },
  { key: 'keyPairCount', label: 'Key Pairs', serviceId: 'key-pairs' },
  { key: 'cloudwatchCount', label: 'CloudWatch Alarms', serviceId: 'cloudwatch' },
  { key: 'cloudtrailCount', label: 'CloudTrail Trails', serviceId: 'cloudtrail' },
  { key: 'iamCount', label: 'IAM Users & Roles', serviceId: 'iam' }
]

function fmtCurrency(value: number): string {
  return `$${value.toFixed(2)}`
}

function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function describePayerVisibility(value: OverviewAccountContext['payerVisibility']): string {
  switch (value) {
    case 'payer-or-management':
      return 'Payer or management visibility'
    case 'member-or-standalone':
      return 'Single-account visibility'
    default:
      return 'Billing visibility unavailable'
  }
}

function sumMetricField(regions: RegionMetric[], key: keyof RegionMetric): number {
  return regions.reduce((s, r) => {
    const v = r[key]
    return s + (typeof v === 'number' ? v : 0)
  }, 0)
}

function getTopServiceTiles(metrics: OverviewMetrics, limit = 8): Array<{ tile: ServiceTileDef, total: number }> {
  return SERVICE_TILES
    .map((tile) => ({ tile, total: sumMetricField(metrics.regions, tile.key) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
}

export function OverviewConsole({
  onBack,
  onNavigate,
  state,
  embedded = false,
  refreshNonce = 0
}: {
  onBack?: () => void
  onNavigate?: (serviceId: ServiceId) => void
  state?: ReturnType<typeof useAwsPageConnection>
  embedded?: boolean
  refreshNonce?: number
}) {
  const internalState = useAwsPageConnection('us-east-1')
  const connectionState = state ?? internalState

  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null)
  const [globalMetrics, setGlobalMetrics] = useState<OverviewMetrics | null>(null)
  const [statistics, setStatistics] = useState<OverviewStatistics | null>(null)
  const [accountContext, setAccountContext] = useState<OverviewAccountContext | null>(null)
  const [relationships, setRelationships] = useState<RelationshipMap | null>(null)
  const [tagResults, setTagResults] = useState<TagSearchResult | null>(null)
  const [tab, setTab] = useState<OverviewTab>('overview')
  const [loading, setLoading] = useState(false)
  const [globalLoading, setGlobalLoading] = useState(false)
  const [pageError, setPageError] = useState('')
  const [tagKey, setTagKey] = useState('')
  const [tagValue, setTagValue] = useState('')
  const [tagResourceTypeFilter, setTagResourceTypeFilter] = useState<TagResourceTypeFilter>('all')
  const [globalBreakdownService, setGlobalBreakdownService] = useState<ServiceTileDef | null>(null)
  const [costBreakdown, setCostBreakdown] = useState<CostBreakdown | null>(null)
  const [relFilter, setRelFilter] = useState<RelFilterType>('all')
  const [edgeRelFilter, setEdgeRelFilter] = useState<string>('all')
  const [edgePage, setEdgePage] = useState(0)
  const [insightFilter, setInsightFilter] = useState<InsightFilter>('all')
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('all')

  const availableRegions = useMemo(
    () => connectionState.regions.map((item) => item.id),
    [connectionState.regions]
  )

  // Auto-load regional overview when connection is ready or refresh is triggered
  useEffect(() => {
    if (connectionState.connection && connectionState.connected) {
      void loadRegionalOverview(connectionState.connection)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState.connection, connectionState.connected, connectionState.region, refreshNonce])

  async function loadRegionalOverview(connection: AwsConnection) {
    setLoading(true)
    setPageError('')
    try {
      const [nextMetrics, nextStatistics, nextAccountContext, nextRelationships, nextCost] = await Promise.all([
        getOverviewMetrics(connection, [connection.region]),
        getOverviewStatistics(connection),
        getOverviewAccountContext(connection).catch(() => null),
        getRelationshipMap(connection),
        getCostBreakdown(connection).catch(() => null)
      ])
      setMetrics(nextMetrics)
      setStatistics(nextStatistics)
      setAccountContext(nextAccountContext)
      setRelationships(nextRelationships)
      setCostBreakdown(nextCost)
    } catch (error) {
      setAccountContext(null)
      setPageError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  async function loadGlobalOverview() {
    if (!connectionState.connection || !connectionState.connected) return
    setGlobalLoading(true)
    setPageError('')
    try {
      const [nextMetrics, nextCost] = await Promise.all([
        getOverviewMetrics(connectionState.connection, availableRegions),
        getCostBreakdown(connectionState.connection).catch(() => null)
      ])
      setGlobalMetrics(nextMetrics)
      setCostBreakdown(nextCost)
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    } finally {
      setGlobalLoading(false)
    }
  }

  async function handleTagSearch() {
    if (!connectionState.connection || !connectionState.connected || !tagKey.trim()) return
    setLoading(true)
    setPageError('')
    setTagResourceTypeFilter('all')
    try {
      setTagResults(await searchByTag(connectionState.connection, tagKey.trim(), tagValue.trim() || undefined))
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const tabLabels: Record<OverviewTab, string> = {
    overview: 'Overview (Region)',
    relationships: 'Resource Relationship View',
    statistics: 'Statistics',
    tags: 'Search By Tag'
  }

  /* ── Region breakdown for global tile click ─────────────── */
  const globalBreakdownRows = useMemo(() => {
    if (!globalMetrics || !globalBreakdownService) return []
    return globalMetrics.regions
      .map((r) => ({ region: r.region, count: (typeof r[globalBreakdownService.key] === 'number' ? r[globalBreakdownService.key] : 0) as number }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
  }, [globalMetrics, globalBreakdownService])

  const tagResourceTypes = useMemo(() => {
    if (!tagResults) return []
    return [...new Set(tagResults.resources.map((resource) => resource.resourceType))].sort((a, b) => a.localeCompare(b))
  }, [tagResults])

  const filteredTagResources = useMemo(() => {
    if (!tagResults) return []
    if (tagResourceTypeFilter === 'all') return tagResults.resources
    return tagResults.resources.filter((resource) => resource.resourceType === tagResourceTypeFilter)
  }, [tagResults, tagResourceTypeFilter])

  const displayedMonthlyCost = costBreakdown?.total ?? metrics?.globalTotals.totalCost ?? globalMetrics?.globalTotals.totalCost ?? 0
  const displayedCostDetail = costBreakdown
    ? `${costBreakdown.period} · Cost Explorer · Unblended cost`
    : 'Cost Explorer total from overview snapshot'

  const content = (
    <>
      {(connectionState.error || pageError) && (
        <SvcState
          variant={variantForError(connectionState.error || pageError)}
          error={(connectionState.error || pageError)!}
        />
      )}
      {!connectionState.connection || !connectionState.connected ? (
        <section className="empty-hero">
          <div>
            <div className="eyebrow">Overview</div>
            <h2>Connect to load the overview</h2>
            <p>Select a profile and region from the sidebar to get started.</p>
          </div>
        </section>
      ) : (
        <>
          {/* ── Tab bar ──────────────────────────────────────── */}
          <nav className="overview-tab-bar">
            {(Object.keys(tabLabels) as OverviewTab[]).map((value) => (
              <button
                key={value}
                type="button"
                className={tab === value ? 'overview-tab active' : 'overview-tab'}
                onClick={() => setTab(value)}
              >
                {tabLabels[value]}
              </button>
            ))}
          </nav>

          {/* ── Global Overview (all tabs) ────────────────────── */}
          <section className="global-overview-bar">
            {!globalMetrics ? (
              <div className="global-overview-prompt">
                <div className="global-overview-copy">
                  <div className="eyebrow">Cross-region view</div>
                  <h3>Global Overview</h3>
                  <p className="hero-path">Load account-wide metrics and compare service distribution across every available region.</p>
                </div>
                <div className="global-overview-actions">
                  <button
                    type="button"
                    className="accent"
                    disabled={globalLoading}
                    onClick={() => void loadGlobalOverview()}
                  >
                    {globalLoading ? 'Loading...' : 'Load Global Overview'}
                  </button>
                  <span className="global-overview-note">Can take 2-5 minutes</span>
                </div>
              </div>
            ) : (
              <>
                <div className="overview-chip-row">
                  <button
                    type="button"
                    className="overview-service-chip"
                    style={{ cursor: 'default', borderColor: 'rgba(223, 105, 42, 0.2)' }}
                  >
                    <span style={{ color: 'var(--accent)' }}>{fmtCurrency(displayedMonthlyCost)}</span>
                    <strong>Cost</strong>
                  </button>
                  {SERVICE_TILES.map((tile) => {
                    const total = sumMetricField(globalMetrics.regions, tile.key)
                    return (
                      <button
                        key={tile.key}
                        type="button"
                        className={`overview-service-chip ${globalBreakdownService?.key === tile.key ? 'active' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setGlobalBreakdownService(globalBreakdownService?.key === tile.key ? null : tile)}
                      >
                        <span>{tile.label}</span>
                        <strong>{total}</strong>
                      </button>
                    )
                  })}
                </div>

                {/* ── Region breakdown panel ────────────────────── */}
                <div className="hero-path" style={{ marginTop: '0.45rem' }}>{displayedCostDetail}</div>
                {globalBreakdownService && (
                  <section className="panel stack" style={{ marginTop: '0.5rem' }}>
                    <div className="panel-header">
                      <h3>{globalBreakdownService.label} — Region Breakdown</h3>
                      <button type="button" onClick={() => setGlobalBreakdownService(null)}>Close</button>
                    </div>
                    {globalBreakdownRows.length > 0 ? (
                      <div className="table-grid">
                        <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                          <div>Region</div>
                          <div>Count</div>
                        </div>
                        {globalBreakdownRows.map((row) => (
                          <div key={row.region} className="table-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                            <div>{row.region}</div>
                            <div><strong>{row.count}</strong></div>
                          </div>
                        ))}
                        <div className="table-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', fontWeight: 600 }}>
                          <div>Total</div>
                          <div>{globalBreakdownRows.reduce((s, r) => s + r.count, 0)}</div>
                        </div>
                      </div>
                    ) : (
                      <SvcState variant="empty" message={`No ${globalBreakdownService.label.toLowerCase()} found in any region.`} compact />
                    )}
                  </section>
                )}
              </>
            )}
          </section>

          {/* ── Overview (Region) tab ─────────────────────────── */}
          {tab === 'overview' && (
            <>
              {loading && <SvcState variant="loading" resourceName="overview data" compact />}
              {metrics && (
                <>
                  <section className="overview-surface">
                    <div className="overview-hero-card">
                      <div className="overview-hero-copy">
                        <div className="eyebrow">Regional posture</div>
                        <h3>{connectionState.region}</h3>
                        <p>
                          Cost, inventory, topology, and insight signals for the active region.
                        </p>
                        <div className="overview-meta-strip">
                          <div className="overview-meta-pill">
                            <span>Monthly cost</span>
                            <strong>{fmtCurrency(displayedMonthlyCost)}</strong>
                          </div>
                          <div className="overview-meta-pill">
                            <span>Active regions</span>
                            <strong>{metrics.globalTotals.regionCount}</strong>
                          </div>
                          <div className="overview-meta-pill">
                            <span>Region catalog</span>
                            <strong>{availableRegions.length} available</strong>
                          </div>
                        </div>
                      </div>
                      <div className="overview-hero-stats">
                        <div className="overview-glance-card overview-glance-card-accent">
                          <span>Cost posture</span>
                          <strong>{fmtCurrency(displayedMonthlyCost)}</strong>
                          <small>{displayedCostDetail}</small>
                        </div>
                        <div className="overview-glance-card">
                          <span>Total resources</span>
                          <strong>{metrics.globalTotals.totalResources}</strong>
                          <small>Active region</small>
                        </div>
                        <div className="overview-glance-card">
                          <span>Relationships</span>
                          <strong>{relationships?.edges.length ?? 0}</strong>
                          <small>Mapped dependencies</small>
                        </div>
                        <div className="overview-glance-card">
                          <span>Insights</span>
                          <strong>{statistics?.insights.length ?? 0}</strong>
                          <small>Generated findings</small>
                        </div>
                      </div>
                    </div>

                    {accountContext && (
                      <>
                        <div className="overview-section-title">Account And Billing Posture</div>
                        <section className="overview-account-grid">
                          <article className="overview-account-card">
                            <div className="panel-header minor">
                              <h3>Account Context</h3>
                            </div>
                            <div className="overview-account-kv">
                              <div>
                                <span>Account ID</span>
                                <strong>{accountContext.caller.account || '-'}</strong>
                              </div>
                              <div>
                                <span>Billing home</span>
                                <strong>{accountContext.billingHomeRegion}</strong>
                              </div>
                              <div>
                                <span>Visibility</span>
                                <strong>{describePayerVisibility(accountContext.payerVisibility)}</strong>
                              </div>
                              <div>
                                <span>Linked accounts</span>
                                <strong>{accountContext.linkedAccounts.length}</strong>
                              </div>
                            </div>
                            <div className="overview-note-list">
                              {accountContext.notes.map((note) => (
                                <div key={note} className="overview-note-item">{note}</div>
                              ))}
                            </div>
                          </article>

                          <article className="overview-account-card">
                            <div className="panel-header minor">
                              <h3>Linked Account Spend</h3>
                              <span className="hero-path" style={{ margin: 0 }}>Current month</span>
                            </div>
                            {accountContext.linkedAccounts.length ? (
                              <div className="overview-linked-account-list">
                                {accountContext.linkedAccounts.slice(0, 6).map((item) => (
                                  <div key={item.accountId} className="overview-linked-account-row">
                                    <div>
                                      <strong>{item.accountId}</strong>
                                      <span>{fmtPercent(item.sharePercent)} of monthly spend</span>
                                    </div>
                                    <strong>{fmtCurrency(item.amount)}</strong>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <SvcState
                                variant="empty"
                                message="Linked-account rollups are not visible with the current billing context."
                                compact
                              />
                            )}
                          </article>
                        </section>

                        <div className="overview-section-title">Capability Hints</div>
                        <section className="overview-hint-grid">
                          {accountContext.capabilitySnapshot.hints.map((hint: AwsCapabilityHint) => (
                            <article key={hint.id} className={`overview-hint-card ${hint.severity}`}>
                              <span className="overview-hint-kicker">{hint.subject}</span>
                              <strong>{hint.title}</strong>
                              <p>{hint.summary}</p>
                              <small>{hint.recommendedAction}</small>
                            </article>
                          ))}
                        </section>

                        <div className="overview-section-title">Cost Ownership Hints</div>
                        <section className="overview-ownership-grid">
                          {accountContext.ownershipHints.map((hint) => (
                            <article key={hint.key} className="overview-ownership-card">
                              <div className="overview-ownership-header">
                                <div>
                                  <span>{hint.key}</span>
                                  <strong>{fmtPercent(hint.coveragePercent)} tagged</strong>
                                </div>
                                <div className="overview-ownership-metrics">
                                  <span>{fmtCurrency(hint.taggedAmount)} tagged</span>
                                  <span>{fmtCurrency(hint.untaggedAmount)} remaining</span>
                                </div>
                              </div>
                              {hint.topValues.length ? (
                                <div className="overview-ownership-values">
                                  {hint.topValues.map((value) => (
                                    <div key={`${hint.key}-${value.value}`} className="overview-ownership-value">
                                      <div>
                                        <strong>{value.value}</strong>
                                        <span>{fmtPercent(value.sharePercent)} of total spend</span>
                                      </div>
                                      <strong>{fmtCurrency(value.amount)}</strong>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="hero-path" style={{ margin: 0 }}>
                                  No current-month tagged spend surfaced for {hint.key}.
                                </p>
                              )}
                            </article>
                          ))}
                        </section>
                      </>
                    )}

                    <div className="overview-section-title">Top Services</div>
                    <section className="overview-tiles overview-tiles-featured">
                      {getTopServiceTiles(metrics, 6).map(({ tile, total }, index) => (
                        <button
                          key={tile.key}
                          type="button"
                          className={`overview-tile clickable ${index === 0 ? 'highlight' : ''}`}
                          onClick={() => onNavigate?.(tile.serviceId)}
                        >
                          <span className="overview-tile-kicker">Service</span>
                          <strong>{total}</strong>
                          <span>{tile.label}</span>
                        </button>
                      ))}
                    </section>

                    <div className="overview-section-title">Platform Summary</div>
                    <section className="overview-tiles overview-tiles-summary">
                      <div className="overview-tile highlight">
                        <span className="overview-tile-kicker">Spend</span>
                        <strong>{fmtCurrency(displayedMonthlyCost)}</strong>
                        <span>Total Monthly Cost</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Inventory</span>
                        <strong>{metrics.globalTotals.totalResources}</strong>
                        <span>Total Resources</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Coverage</span>
                        <strong>{metrics.globalTotals.regionCount}</strong>
                        <span>Active Regions</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Topology</span>
                        <strong>{relationships?.edges.length ?? 0}</strong>
                        <span>Relationships</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Signals</span>
                        <strong>{statistics?.insights.length ?? 0}</strong>
                        <span>Insights</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Tracking</span>
                        <strong>{statistics?.stats.length ?? 0}</strong>
                        <span>Service Stats</span>
                      </div>
                    </section>
                  </section>

                  <div className="overview-bottom-row">
                    <span>Current month total</span>
                    <strong>{fmtCurrency(displayedMonthlyCost)} USD</strong>
                    <span className="overview-bottom-row-detail">{displayedCostDetail}</span>
                  </div>

                  <section className="workspace-grid">
                    <div className="column stack">
                      <div className="panel overview-data-panel">
                        <div className="panel-header"><h3>Regional Breakdown</h3></div>
                        <div className="table-grid overview-table-grid">
                          <div className="table-row table-head overview-region-grid">
                            <div>Region</div><div>EC2</div><div>Lambda</div><div>EKS</div><div>ASG</div><div>Total</div>
                          </div>
                          {metrics.regions.map((row) => (
                            <div key={row.region} className="table-row overview-table-row overview-region-grid">
                              <div>{row.region}</div>
                              <div>{row.ec2Count}</div>
                              <div>{row.lambdaCount}</div>
                              <div>{row.eksCount}</div>
                              <div>{row.asgCount}</div>
                              <div>{row.totalResources}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {costBreakdown && costBreakdown.entries.length > 0 && (
                        <div className="panel overview-data-panel">
                          <div className="panel-header">
                            <h3>Cost by Service — {costBreakdown.period}</h3>
                            <span className="hero-path" style={{ margin: 0 }}>{fmtCurrency(costBreakdown.total)} USD</span>
                          </div>
                          <div className="table-grid overview-table-grid">
                            <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1fr auto auto' }}>
                              <div>Service</div><div>Cost</div><div>%</div>
                            </div>
                            {costBreakdown.entries.map((entry) => (
                              <div key={entry.service} className="table-row overview-table-row overview-cost-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '1rem' }}>
                                <div>{entry.service}</div>
                                <div style={{ textAlign: 'right' }}>{fmtCurrency(entry.amount)}</div>
                                <div style={{ textAlign: 'right', color: 'var(--muted)' }}>{(entry.amount / costBreakdown.total * 100).toFixed(1)}%</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="column stack">
                      <div className="panel overview-insights-panel">
                        <div className="panel-header"><h3>Insights</h3></div>
                        {(statistics?.insights ?? []).map((item: InsightItem, index) => (
                          <div key={`${item.service}-${index}`} className="insight-card">
                            <div className="insight-card-badge">
                              <span className={`signal-badge severity-${item.severity === 'error' ? 'high' : item.severity === 'warning' ? 'medium' : 'low'}`}>
                                {item.severity === 'error' ? 'Error' : item.severity === 'warning' ? 'Warn' : 'Info'}
                              </span>
                              <span className="insight-card-service">{item.service}</span>
                            </div>
                            <div className="insight-card-message">{item.message}</div>
                          </div>
                        ))}
                        {!statistics?.insights.length && <SvcState variant="empty" resourceName="insights" message="No insights generated." compact />}
                      </div>
                    </div>
                  </section>
                </>
              )}
              {!metrics && !loading && (
                <SvcState variant="empty" message="No regional data loaded yet." compact />
              )}
            </>
          )}

          {/* ── Relationships tab ─────────────────────────────── */}
          {tab === 'relationships' && (() => {
            const allEdges = relationships?.edges ?? []
            const allNodes = relationships?.nodes ?? []

            // Build a label lookup: node id → label
            const nodeLabels = new Map<string, string>()
            for (const n of allNodes) {
              if (n.label && n.label !== n.id) nodeLabels.set(n.id, n.label)
            }

            // Collect all unique node types for the filter
            const nodeTypes = [...new Set(allNodes.map((n) => n.type))].sort()

            // Filter edges by selected node type
            const nodeFilteredEdges: ServiceRelationship[] = relFilter === 'all'
              ? allEdges
              : allEdges.filter((e) => e.sourceType === relFilter || e.targetType === relFilter)

            // Count relation types within node-filtered edges
            const edgeRelCounts = new Map<string, number>()
            for (const e of nodeFilteredEdges) {
              edgeRelCounts.set(e.relation, (edgeRelCounts.get(e.relation) ?? 0) + 1)
            }

            // Apply edge relation filter
            const filteredEdges: ServiceRelationship[] = edgeRelFilter === 'all'
              ? nodeFilteredEdges
              : nodeFilteredEdges.filter((e) => e.relation === edgeRelFilter)

            // Group edges by relation type for summary
            const relationGroups = new Map<string, number>()
            for (const e of allEdges) {
              const rel = e.relation.replace(/\s*\d+\s*instances?/, ' instances')
              relationGroups.set(rel, (relationGroups.get(rel) ?? 0) + 1)
            }

            // Node type counts
            const nodeTypeCounts = new Map<string, number>()
            for (const n of allNodes) {
              nodeTypeCounts.set(n.type, (nodeTypeCounts.get(n.type) ?? 0) + 1)
            }

            return (
              <>
                <section className="overview-surface">
                  <div className="relationship-hero-card">
                    <div className="relationship-hero-copy">
                      <div className="eyebrow">Topology map</div>
                      <h3>Resource Relationship View</h3>
                      <p>Inspect linked AWS resources, filter by node type, and isolate the relationships that matter.</p>
                    </div>
                    <div className="relationship-hero-stats">
                      <div className="overview-tile highlight">
                        <span className="overview-tile-kicker">Nodes</span>
                        <strong>{allNodes.length}</strong>
                        <span>Total Nodes</span>
                      </div>
                      <div className="overview-tile highlight">
                        <span className="overview-tile-kicker">Edges</span>
                        <strong>{allEdges.length}</strong>
                        <span>Total Edges</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Types</span>
                        <strong>{nodeTypes.length}</strong>
                        <span>Resource Types</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Relations</span>
                        <strong>{relationGroups.size}</strong>
                        <span>Relation Types</span>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Node type breakdown + filter */}
                <section className="workspace-grid relationship-control-grid">
                  <div className="panel relationship-panel">
                    <div className="panel-header"><h3>Nodes by Type</h3></div>
                    <div className="overview-chip-row relationship-chip-grid">
                      <button
                        type="button"
                        className={`overview-service-chip ${relFilter === 'all' ? 'active' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => { setRelFilter('all'); setEdgeRelFilter('all'); setEdgePage(0) }}
                      >
                        <span>All</span>
                        <strong>{allNodes.length}</strong>
                      </button>
                      {[...nodeTypeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                        <button
                          key={type}
                          type="button"
                          className={`overview-service-chip ${relFilter === type ? 'active' : ''}`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => { setRelFilter(relFilter === type ? 'all' : type); setEdgeRelFilter('all'); setEdgePage(0) }}
                        >
                          <span>{type}</span>
                          <strong>{count}</strong>
                        </button>
                      ))}
                    </div>
                    <div className="panel-header minor relationship-filter-header"><h3>Edge Filters</h3></div>
                    <div className="overview-chip-row relationship-chip-grid">
                      <button
                        type="button"
                        className={`overview-service-chip ${edgeRelFilter === 'all' ? 'active' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => { setEdgeRelFilter('all'); setEdgePage(0) }}
                      >
                        <span>All</span>
                        <strong>{nodeFilteredEdges.length}</strong>
                      </button>
                      {[...edgeRelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([rel, count]) => (
                        <button
                          key={rel}
                          type="button"
                          className={`overview-service-chip ${edgeRelFilter === rel ? 'active' : ''}`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => { setEdgeRelFilter(edgeRelFilter === rel ? 'all' : rel); setEdgePage(0) }}
                        >
                          <span>{rel}</span>
                          <strong>{count}</strong>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="panel relationship-panel">
                    <div className="panel-header"><h3>Relation Summary</h3></div>
                    <div className="selection-list relationship-summary-list">
                      {[...relationGroups.entries()].sort((a, b) => b[1] - a[1]).map(([rel, count]) => (
                        <div key={rel} className="selection-item relationship-summary-item">
                          <span>{rel}</span>
                          <strong>{count}</strong>
                        </div>
                      ))}
                      {relationGroups.size === 0 && <SvcState variant="empty" resourceName="relations" compact />}
                    </div>
                  </div>
                </section>

                {/* Edge table */}
                <section className="panel relationship-panel relationship-table-panel">
                  <div className="panel-header">
                    <h3>Relationship Edges</h3>
                    <span className="hero-path" style={{ margin: 0 }}>{filteredEdges.length} of {allEdges.length} edges</span>
                  </div>
                  {(() => {
                    const pageSize = 10
                    const totalPages = Math.max(1, Math.ceil(filteredEdges.length / pageSize))
                    const safePage = Math.min(edgePage, totalPages - 1)
                    const pagedEdges = filteredEdges.slice(safePage * pageSize, (safePage + 1) * pageSize)
                    return (
                      <>
                        <div className="table-grid relationship-table-grid">
                          <div className="table-row table-head overview-rel-grid">
                            <div>Source</div><div>Source Type</div><div>Relation</div><div>Target</div><div>Target Type</div>
                          </div>
                          {pagedEdges.map((edge, index) => {
                            const srcLabel = nodeLabels.get(edge.source)
                            const tgtLabel = nodeLabels.get(edge.target)
                            return (
                              <div key={`${edge.source}-${edge.target}-${index}`} className="table-row relationship-edge-row overview-rel-grid">
                                <div>{srcLabel ? <><span className="mono">{edge.source}</span><br /><span className="hero-path relationship-edge-label">{srcLabel}</span></> : <span className="mono">{edge.source}</span>}</div>
                                <div><span className="relationship-type-pill">{edge.sourceType}</span></div>
                                <div className="relationship-edge-relation">{edge.relation}</div>
                                <div>{tgtLabel ? <><span className="mono">{edge.target}</span><br /><span className="hero-path relationship-edge-label">{tgtLabel}</span></> : <span className="mono">{edge.target}</span>}</div>
                                <div><span className="relationship-type-pill">{edge.targetType}</span></div>
                              </div>
                            )
                          })}
                          {filteredEdges.length === 0 && <SvcState variant={relFilter !== 'all' || edgeRelFilter !== 'all' ? 'no-filter-matches' : 'empty'} resourceName="relationships" compact />}
                        </div>
                        {totalPages > 1 && (
                          <div className="relationship-pagination">
                            <span className="relationship-pagination-text">
                              {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, filteredEdges.length)} of {filteredEdges.length}
                            </span>
                            <div className="relationship-pagination-actions">
                              <button type="button" disabled={safePage === 0} onClick={() => setEdgePage(safePage - 1)} style={{ cursor: safePage === 0 ? 'default' : 'pointer' }}>Prev</button>
                              <button type="button" disabled={safePage >= totalPages - 1} onClick={() => setEdgePage(safePage + 1)} style={{ cursor: safePage >= totalPages - 1 ? 'default' : 'pointer' }}>Next</button>
                            </div>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </section>
              </>
            )
          })()}

          {/* ── Statistics tab ────────────────────────────────── */}
          {tab === 'statistics' && (() => {
            const allInsights = statistics?.insights ?? []
            const allSignals = statistics?.signals ?? []
            const allStats = (statistics?.stats ?? []).map((stat) => {
              if (stat.label !== 'Est. Monthly Cost') return stat
              if (costBreakdown) {
                return {
                  ...stat,
                  label: 'Monthly Cost',
                  value: fmtCurrency(costBreakdown.total),
                  detail: `Current month (${costBreakdown.period}) from Cost Explorer using Unblended cost`
                }
              }

              return {
                ...stat,
                detail: 'Estimated from resource heuristics'
              }
            })

            const infoCount = allInsights.filter((i) => i.severity === 'info').length
            const warningCount = allInsights.filter((i) => i.severity === 'warning').length
            const errorCount = allInsights.filter((i) => i.severity === 'error').length

            const costSignals = allSignals.filter((s) => s.category === 'cost').length
            const securitySignals = allSignals.filter((s) => s.category === 'security').length
            const opsSignals = allSignals.filter((s) => s.category === 'operations').length
            const cleanupSignals = allSignals.filter((s) => s.category === 'cleanup').length

            const filteredInsights = insightFilter === 'all' ? allInsights : allInsights.filter((i) => i.severity === insightFilter)
            const filteredSignals = signalFilter === 'all' ? allSignals : allSignals.filter((s) => s.category === signalFilter)

            // Group stats by category
            const computeStats = allStats.filter((s) => ['EC2 Instances', 'Lambda Functions', 'EKS Clusters', 'Auto Scaling Groups', 'ECS Clusters'].includes(s.label))
            const storageStats = allStats.filter((s) => ['S3 Buckets', 'RDS Instances', 'ECR Repositories'].includes(s.label))
            const networkStats = allStats.filter((s) => ['VPCs', 'Load Balancers', 'Route 53 Zones', 'Security Groups'].includes(s.label))
            const securityStats = allStats.filter((s) => ['ACM Certificates', 'KMS Keys', 'WAF Web ACLs', 'Secrets', 'Key Pairs', 'IAM Users & Roles'].includes(s.label))
            const mgmtStats = allStats.filter((s) => ['CloudFormation Stacks', 'CloudWatch Alarms', 'CloudTrail Trails', 'SNS Topics', 'SQS Queues'].includes(s.label))
            const summaryStats = allStats.filter((s) => ['Total Resources', 'Est. Monthly Cost', 'Monthly Cost'].includes(s.label))

            return (
              <>
                <section className="overview-surface">
                  <div className="stats-hero-card">
                    <div className="stats-hero-copy">
                      <div className="eyebrow">Operational snapshot</div>
                      <h3>Statistics</h3>
                      <p>Service-level counts, insights, and regional signals for the active AWS footprint.</p>
                    </div>
                    <div className="stats-hero-grid">
                      <div className="overview-tile highlight">
                        <span className="overview-tile-kicker">Insights</span>
                        <strong>{allInsights.length}</strong>
                        <span>Total Insights</span>
                      </div>
                      <div className="overview-tile highlight">
                        <span className="overview-tile-kicker">Signals</span>
                        <strong>{allSignals.length}</strong>
                        <span>Regional Signals</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Attention</span>
                        <strong>{warningCount + errorCount}</strong>
                        <span>Warnings</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Coverage</span>
                        <strong>{allStats.length - 2}</strong>
                        <span>Services Tracked</span>
                      </div>
                      <div className="overview-tile">
                        <span className="overview-tile-kicker">Region</span>
                        <strong>{connectionState.region}</strong>
                        <span>Primary Region</span>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Insights with filter */}
                <section className="panel stack stats-panel">
                  <div className="panel-header">
                    <h3>Insights ({filteredInsights.length})</h3>
                  </div>
                  <div className="overview-chip-row stats-chip-grid">
                    {([['all', 'All', allInsights.length], ['info', 'Info', infoCount], ['warning', 'Warning', warningCount], ['error', 'Error', errorCount]] as const).map(([key, label, count]) => (
                      <button
                        key={key}
                        type="button"
                        className={`overview-service-chip ${insightFilter === key ? 'active' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setInsightFilter(key)}
                      >
                        <span>{label}</span>
                        <strong>{count}</strong>
                      </button>
                    ))}
                  </div>
                  {filteredInsights.map((item: InsightItem, index) => (
                    <div key={`${item.service}-${index}`} className="insight-card">
                      <div className="insight-card-badge">
                        <span className={`signal-badge severity-${item.severity === 'error' ? 'high' : item.severity === 'warning' ? 'medium' : 'low'}`}>
                          {item.severity === 'error' ? 'Error' : item.severity === 'warning' ? 'Warn' : 'Info'}
                        </span>
                        <span className="insight-card-service">{item.service}</span>
                      </div>
                      <div className="insight-card-message">{item.message}</div>
                    </div>
                  ))}
                  {filteredInsights.length === 0 && <SvcState variant="no-filter-matches" resourceName="insights" compact />}
                </section>

                {/* Regional Signals with filter */}
                <section className="panel stack stats-panel">
                  <div className="panel-header">
                    <h3>Regional Signals ({filteredSignals.length})</h3>
                  </div>
                  <div className="overview-chip-row stats-chip-grid">
                    {([['all', 'All', allSignals.length], ['cost', 'Cost', costSignals], ['security', 'Security', securitySignals], ['operations', 'Operations', opsSignals], ['cleanup', 'Cleanup', cleanupSignals]] as const).map(([key, label, count]) => (
                      <button
                        key={key}
                        type="button"
                        className={`overview-service-chip ${signalFilter === key ? 'active' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSignalFilter(key)}
                      >
                        <span>{label}</span>
                        <strong>{count}</strong>
                      </button>
                    ))}
                  </div>

                  {filteredSignals.map((signal: RegionalSignal, index) => (
                    <div key={`${signal.title}-${index}`} className="signal-card">
                      <div className="signal-card-header">
                        <span className={`signal-badge severity-${signal.severity}`}>
                          {signal.severity.charAt(0).toUpperCase() + signal.severity.slice(1)}
                        </span>
                        <span className="signal-badge">{signal.category}</span>
                        <span className="signal-region">{signal.region}</span>
                      </div>
                      <h4 className="signal-title">{signal.title}</h4>
                      <p className="signal-description">{signal.description}</p>
                      <p className="signal-next-step">Next step: {signal.nextStep}</p>
                    </div>
                  ))}
                  {filteredSignals.length === 0 && <SvcState variant="no-filter-matches" resourceName="signals" compact />}
                </section>

                {/* Service statistics by category */}
                <section className="panel stack stats-panel stats-secondary-panel">
                  <div className="panel-header">
                    <h3>Service Breakdown</h3>
                    <span className="hero-path" style={{ margin: 0 }}>{allStats.length - 2} tracked metrics</span>
                  </div>
                  <section className="workspace-grid stats-category-grid">
                    <div className="column stack">
                      {[
                        { title: 'Compute', items: computeStats },
                        { title: 'Storage & Data', items: storageStats },
                        { title: 'Management & Messaging', items: mgmtStats }
                      ].map((group) => (
                        <div key={group.title} className="stats-subpanel">
                          <div className="panel-header minor"><h3>{group.title}</h3></div>
                          <div className="table-grid stats-table-grid">
                            {group.items.map((item) => (
                              <div key={item.label} className="table-row stats-table-row overview-stat-grid">
                                <div>{item.label}</div>
                                <div><strong>{item.value}</strong></div>
                                <div className="hero-path">{item.detail}</div>
                              </div>
                            ))}
                            {group.items.length === 0 && <SvcState variant="empty" message="No data." compact />}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="column stack">
                      {[
                        { title: 'Networking', items: networkStats },
                        { title: 'Security & Identity', items: securityStats },
                        { title: 'Summary', items: summaryStats }
                      ].map((group) => (
                        <div key={group.title} className="stats-subpanel">
                          <div className="panel-header minor"><h3>{group.title}</h3></div>
                          <div className="table-grid stats-table-grid">
                            {group.items.map((item) => (
                              <div key={item.label} className="table-row stats-table-row overview-stat-grid">
                                <div>{item.label}</div>
                                <div><strong>{item.value}</strong></div>
                                <div className="hero-path">{item.detail}</div>
                              </div>
                            ))}
                            {group.items.length === 0 && <SvcState variant="empty" message="No data." compact />}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </section>
              </>
            )
          })()}

          {/* ── Search By Tag tab ─────────────────────────────── */}
          {tab === 'tags' && (
            <>
              <section className="panel stack">
                <div className="panel-header"><h3>Search By Tag</h3></div>
                <div className="inline-form">
                  <label className="field" style={{ flex: 1 }}>
                    <span>Tag Key</span>
                    <input value={tagKey} onChange={(event) => setTagKey(event.target.value)} placeholder="Environment" />
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    <span>Tag Value (optional)</span>
                    <input value={tagValue} onChange={(event) => setTagValue(event.target.value)} placeholder="prod" />
                  </label>
                  <button
                    type="button"
                    className="accent"
                    style={{ alignSelf: 'flex-end' }}
                    disabled={!tagKey.trim() || loading}
                    onClick={() => void handleTagSearch()}
                  >
                    Search
                  </button>
                </div>
              </section>

              {tagResults && (
                <section className="workspace-grid">
                  <div className="column stack">
                    <div className="panel">
                      <div className="panel-header">
                        <h3>Matched Resources</h3>
                        <span className="hero-path" style={{ margin: 0 }}>{filteredTagResources.length} of {tagResults.resources.length}</span>
                      </div>
                      <div className="inline-form" style={{ marginBottom: '0.85rem' }}>
                        <label className="field" style={{ minWidth: '220px' }}>
                          <span>Resource Type</span>
                          <select value={tagResourceTypeFilter} onChange={(event) => setTagResourceTypeFilter(event.target.value)}>
                            <option value="all">All resource types</option>
                            {tagResourceTypes.map((resourceType) => (
                              <option key={resourceType} value={resourceType}>{resourceType}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="table-grid">
                        <div className="table-row table-head overview-tag-grid">
                          <div>Name</div><div>Type</div><div>Service</div><div>Resource ID</div>
                        </div>
                        {filteredTagResources.map((resource) => (
                          <div key={`${resource.service}-${resource.resourceId}`} className="table-row overview-tag-grid">
                            <div>{resource.name}</div>
                            <div>{resource.resourceType}</div>
                            <div>{resource.service}</div>
                            <div className="mono">{resource.resourceId}</div>
                          </div>
                        ))}
                        {!filteredTagResources.length && <SvcState variant="no-filter-matches" resourceName="resources" compact />}
                      </div>
                    </div>
                  </div>
                  <div className="column stack">
                    <div className="panel">
                      <div className="panel-header"><h3>Current Monthly Cost</h3></div>
                      <div className="selection-list">
                        {tagResults.costBreakdown.map((entry) => (
                          <div key={`${entry.tagKey}-${entry.tagValue}`} className="selection-item">
                            <span>{entry.tagKey}={entry.tagValue}</span>
                            <strong>{entry.resourceCount} resources</strong>
                            <span>{fmtCurrency(entry.monthlyCost)}</span>
                          </div>
                        ))}
                        {!tagResults.costBreakdown.length && <SvcState variant="empty" resourceName="cost breakdown" compact />}
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {!tagResults && <SvcState variant="no-selection" message="Enter a tag key and search to find matching resources." compact />}
            </>
          )}
        </>
      )}
    </>
  )

  if (embedded) {
    return (
      <div className="stack">
        {content}
      </div>
    )
  }

  return (
    <div className="workspace stack">
      <section className="hero">
        <div>
          <div className="eyebrow">Account Summary</div>
          <h2>Overview</h2>
          <p className="hero-path">Regional summary landing page across active provider services.</p>
        </div>
        {onBack && <button type="button" onClick={onBack}>Back</button>}
      </section>
      {content}
    </div>
  )
}
