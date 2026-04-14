import { useEffect, useMemo, useState } from 'react'
import './ec2.css'

import type {
  AzureResourceGroupResourceSummary,
  AzureResourceGroupSummary
} from '@shared/types'
import { listAzureResourceGroups, listAzureResourceGroupResources } from './api'
import { SvcState } from './SvcState'
import { formatAzureResourceType, inferAzureServiceFromResourceType } from './AzureOpsConsoles'

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sortByName<T extends { name?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''))
}

function renderTableHeader(columns: string[], gridTemplateColumns: string): JSX.Element {
  return (
    <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns, gap: '1rem' }}>
      {columns.map((column) => <div key={column}>{column}</div>)}
    </div>
  )
}

function provisioningBadgeClass(state: string): string {
  const normalized = state.toLowerCase()
  if (normalized === 'succeeded') return 'status-ok'
  if (normalized === 'failed' || normalized === 'canceled') return 'status-warn'
  return ''
}

export function AzureResourceGroupsConsole({
  subscriptionId,
  refreshNonce,
  onNavigateToResource
}: {
  subscriptionId: string
  refreshNonce: number
  onNavigateToResource: (resource: AzureResourceGroupResourceSummary) => void
}): JSX.Element {
  const [groups, setGroups] = useState<AzureResourceGroupSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [groupSearch, setGroupSearch] = useState('')
  const [selectedGroupName, setSelectedGroupName] = useState('')

  const [resourcesByRg, setResourcesByRg] = useState<Record<string, AzureResourceGroupResourceSummary[]>>({})
  const [resourceLoading, setResourceLoading] = useState(false)
  const [resourceError, setResourceError] = useState('')
  const [resourceSearch, setResourceSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      setLoading(true)
      setError('')
      try {
        const next = await listAzureResourceGroups(subscriptionId)
        if (cancelled) return
        const sorted = sortByName(next)
        setGroups(sorted)
        // Reset cached resources on refresh/subscription change
        setResourcesByRg({})
        setResourceError('')
        // Preserve selection if still present; otherwise select first
        setSelectedGroupName((prev) => {
          if (prev && sorted.some((g) => g.name === prev)) return prev
          return sorted[0]?.name ?? ''
        })
      } catch (err) {
        if (cancelled) return
        setError(normalizeError(err))
        setGroups([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (subscriptionId) {
      void load()
    } else {
      setGroups([])
      setLoading(false)
    }

    return () => {
      cancelled = true
    }
  }, [subscriptionId, refreshNonce])

  const selectedGroup = useMemo(
    () => groups.find((g) => g.name === selectedGroupName) ?? null,
    [groups, selectedGroupName]
  )

  // Load resources lazily whenever the selected group changes and isn't cached yet
  useEffect(() => {
    if (!selectedGroup) return
    if (resourcesByRg[selectedGroup.name]) {
      setResourceError('')
      return
    }

    let cancelled = false
    setResourceLoading(true)
    setResourceError('')

    listAzureResourceGroupResources(subscriptionId, selectedGroup.name)
      .then((list) => {
        if (cancelled) return
        const sorted = sortByName(list)
        setResourcesByRg((prev) => ({ ...prev, [selectedGroup.name]: sorted }))
      })
      .catch((err) => {
        if (cancelled) return
        setResourceError(normalizeError(err))
      })
      .finally(() => {
        if (!cancelled) setResourceLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedGroup, subscriptionId, resourcesByRg])

  const filteredGroups = useMemo(() => {
    const needle = groupSearch.trim().toLowerCase()
    if (!needle) return groups
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(needle) ||
        g.location.toLowerCase().includes(needle) ||
        g.provisioningState.toLowerCase().includes(needle)
    )
  }, [groups, groupSearch])

  const currentResources = selectedGroup ? resourcesByRg[selectedGroup.name] ?? [] : []

  const resourceTypeFacets = useMemo(() => {
    const seen = new Map<string, number>()
    for (const r of currentResources) {
      const key = r.type
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    return Array.from(seen.entries())
      .map(([type, count]) => ({ type, count, label: formatAzureResourceType(type) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [currentResources])

  // Reset type filter when switching groups if the facet no longer exists
  useEffect(() => {
    if (typeFilter === 'all') return
    if (!currentResources.some((r) => r.type === typeFilter)) {
      setTypeFilter('all')
    }
  }, [selectedGroupName, currentResources, typeFilter])

  const filteredResources = useMemo(() => {
    const needle = resourceSearch.trim().toLowerCase()
    return currentResources.filter((r) => {
      if (typeFilter !== 'all' && r.type !== typeFilter) return false
      if (!needle) return true
      return (
        r.name.toLowerCase().includes(needle) ||
        r.type.toLowerCase().includes(needle) ||
        r.location.toLowerCase().includes(needle)
      )
    })
  }, [currentResources, resourceSearch, typeFilter])

  const totalResourceCount = currentResources.length

  return (
    <div className="svc-console iam-console azure-rbac-theme">
      {/* ── Hero ────────────────────────────────────── */}
      <section className="iam-shell-hero">
        <div className="iam-shell-hero-copy">
          <div className="eyebrow">Azure Resource Groups</div>
          <h2>Resource group inventory</h2>
          <p>
            Subscription-wide resource groups with drill-in to every resource inside. Click any resource to jump
            to its service console — the active location is switched automatically to match.
          </p>
          <div className="iam-shell-meta-strip">
            <div className="iam-shell-meta-pill">
              <span>Provider</span>
              <strong>Azure</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Subscription</span>
              <strong>{subscriptionId || 'Not selected'}</strong>
            </div>
            <div className="iam-shell-meta-pill">
              <span>Resource groups</span>
              <strong>{groups.length}</strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Visible</span>
            <strong>{groups.length}</strong>
            <small>{loading ? 'Refreshing live data now' : 'Resource groups in subscription'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Selected</span>
            <strong>{selectedGroup?.name ?? '-'}</strong>
            <small>{selectedGroup?.location ?? 'No resource group selected'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Resources</span>
            <strong>{totalResourceCount}</strong>
            <small>{resourceLoading ? 'Fetching inventory…' : 'In selected resource group'}</small>
          </div>
        </div>
      </section>

      {/* ── Loading / error / empty states ──────────── */}
      {loading ? <SvcState variant="loading" resourceName="Azure resource groups" compact /> : null}
      {!loading && error ? <SvcState variant="error" error={error} /> : null}
      {!loading && !error && groups.length === 0 ? (
        <SvcState variant="empty" message="No resource groups were visible to the current credential chain." />
      ) : null}

      {/* ── Workspace grid ─────────────────────────── */}
      {!loading && !error && groups.length > 0 ? (
        <section className="workspace-grid">
          {/* Left — Resource group list */}
          <div className="column stack">
            <div className="panel overview-data-panel">
              <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>Resource Groups</h3>
                <input
                  type="text"
                  className="cw-query-filter"
                  placeholder="Filter by name, location, or state…"
                  value={groupSearch}
                  onChange={(event) => setGroupSearch(event.target.value)}
                  style={{
                    maxWidth: 240,
                    fontSize: '0.78rem',
                    padding: '0.35rem 0.6rem',
                    borderRadius: 8,
                    border: '1px solid rgba(145,176,207,0.18)',
                    background: 'rgba(0,0,0,0.15)',
                    color: 'inherit'
                  }}
                />
              </div>
              <div className="table-grid overview-table-grid">
                {renderTableHeader(['Name', 'Location', 'State'], '1.6fr 0.9fr 0.7fr')}
                {filteredGroups.map((rg) => {
                  const cellStyle = {
                    minWidth: 0,
                    overflow: 'hidden' as const,
                    textOverflow: 'ellipsis' as const,
                    whiteSpace: 'nowrap' as const
                  }
                  return (
                    <button
                      key={rg.id}
                      type="button"
                      className={`table-row overview-table-row ${selectedGroupName === rg.name ? 'active' : ''}`}
                      style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.9fr 0.7fr', gap: '1rem', textAlign: 'left', alignItems: 'center' }}
                      onClick={() => setSelectedGroupName(rg.name)}
                      title={rg.managedBy ? `${rg.name} — managed by ${rg.managedBy}` : rg.name}
                    >
                      <div style={cellStyle}>
                        <strong>{rg.name}</strong>
                      </div>
                      <div style={cellStyle}>{rg.location || '-'}</div>
                      <div style={cellStyle}>
                        <span className={`status-badge ${provisioningBadgeClass(rg.provisioningState)}`}>
                          {rg.provisioningState || '-'}
                        </span>
                      </div>
                    </button>
                  )
                })}
                {filteredGroups.length === 0 && groupSearch.trim() ? (
                  <div className="table-row overview-table-row" style={{ textAlign: 'center', opacity: 0.6 }}>
                    No resource groups match &ldquo;{groupSearch.trim()}&rdquo;
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Right — Resources in selected group */}
          <div className="column stack">
            <div className="panel overview-data-panel">
              <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                <h3>
                  Resources{selectedGroup ? <> in <code>{selectedGroup.name}</code></> : null}
                </h3>
                <input
                  type="text"
                  className="cw-query-filter"
                  placeholder="Filter resources…"
                  value={resourceSearch}
                  onChange={(event) => setResourceSearch(event.target.value)}
                  disabled={!selectedGroup}
                  style={{
                    maxWidth: 240,
                    fontSize: '0.78rem',
                    padding: '0.35rem 0.6rem',
                    borderRadius: 8,
                    border: '1px solid rgba(145,176,207,0.18)',
                    background: 'rgba(0,0,0,0.15)',
                    color: 'inherit'
                  }}
                />
              </div>

              {/* Type filter chips */}
              {selectedGroup && resourceTypeFacets.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', padding: '0.5rem 1rem 0' }}>
                  <button
                    type="button"
                    className={`ghost ${typeFilter === 'all' ? 'active' : ''}`}
                    style={{ fontSize: '0.72rem', padding: '0.25rem 0.55rem' }}
                    onClick={() => setTypeFilter('all')}
                  >
                    All ({currentResources.length})
                  </button>
                  {resourceTypeFacets.map((facet) => (
                    <button
                      key={facet.type}
                      type="button"
                      className={`ghost ${typeFilter === facet.type ? 'active' : ''}`}
                      style={{ fontSize: '0.72rem', padding: '0.25rem 0.55rem' }}
                      onClick={() => setTypeFilter(facet.type)}
                    >
                      {facet.label} ({facet.count})
                    </button>
                  ))}
                </div>
              ) : null}

              {!selectedGroup ? (
                <SvcState variant="no-selection" resourceName="resource group" message="Select a resource group to view its contents." />
              ) : resourceLoading ? (
                <SvcState variant="loading" resourceName={`resources in ${selectedGroup.name}`} compact />
              ) : resourceError ? (
                <SvcState variant="error" error={resourceError} />
              ) : currentResources.length === 0 ? (
                <SvcState variant="empty" message={`${selectedGroup.name} does not contain any resources.`} />
              ) : (
                <div className="table-grid overview-table-grid">
                  {renderTableHeader(['Name', 'Type', 'Location', 'State'], '1.6fr 1.2fr 0.9fr 0.8fr')}
                  {filteredResources.map((resource) => {
                    const serviceId = inferAzureServiceFromResourceType(resource.type)
                    const clickable = Boolean(serviceId)
                    const rowStyle = {
                      display: 'grid',
                      gridTemplateColumns: '1.6fr 1.2fr 0.9fr 0.8fr',
                      gap: '1rem',
                      textAlign: 'left' as const,
                      alignItems: 'center' as const
                    }
                    const cellStyle = {
                      minWidth: 0,
                      overflow: 'hidden' as const,
                      textOverflow: 'ellipsis' as const,
                      whiteSpace: 'nowrap' as const
                    }
                    if (clickable) {
                      return (
                        <button
                          key={resource.id}
                          type="button"
                          className="table-row overview-table-row"
                          style={rowStyle}
                          onClick={() => onNavigateToResource(resource)}
                          title={`${resource.name} — ${resource.id}`}
                        >
                          <div style={cellStyle}>
                            <strong>{resource.name}</strong>
                          </div>
                          <div style={cellStyle}>{formatAzureResourceType(resource.type)}</div>
                          <div style={cellStyle}>{resource.location || '-'}</div>
                          <div style={cellStyle}>
                            <span className={`status-badge ${provisioningBadgeClass(resource.provisioningState)}`}>
                              {resource.provisioningState || '-'}
                            </span>
                          </div>
                        </button>
                      )
                    }
                    return (
                      <div
                        key={resource.id}
                        className="table-row overview-table-row"
                        style={{ ...rowStyle, opacity: 0.55, cursor: 'default' }}
                        title={`${resource.name} — no dedicated console for this type yet`}
                      >
                        <div style={cellStyle}>
                          <strong>{resource.name}</strong>
                        </div>
                        <div style={cellStyle}>
                          {formatAzureResourceType(resource.type)}
                          <span style={{ marginLeft: '0.4rem', fontStyle: 'italic', opacity: 0.7, fontSize: '0.72rem' }}>(no console)</span>
                        </div>
                        <div style={cellStyle}>{resource.location || '-'}</div>
                        <div style={cellStyle}>
                          <span className={`status-badge ${provisioningBadgeClass(resource.provisioningState)}`}>
                            {resource.provisioningState || '-'}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                  {filteredResources.length === 0 && (resourceSearch.trim() || typeFilter !== 'all') ? (
                    <div className="table-row overview-table-row" style={{ textAlign: 'center', opacity: 0.6 }}>
                      No resources match the current filter.
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
