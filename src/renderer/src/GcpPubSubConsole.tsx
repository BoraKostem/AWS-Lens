import { useEffect, useMemo, useState } from 'react'
import type {
  GcpPubSubTopicSummary,
  GcpPubSubSubscriptionSummary,
  GcpPubSubSubscriptionDetail
} from '@shared/types'
import {
  listGcpPubSubTopics,
  listGcpPubSubSubscriptions,
  getGcpPubSubSubscriptionDetail
} from './api'
import { SvcState } from './SvcState'
import './gcp-runtime-consoles.css'

/* ── Helpers ──────────────────────────────────────────────── */

type PubSubTab = 'topics' | 'subscriptions'

const MAIN_TABS: Array<{ id: PubSubTab; label: string }> = [
  { id: 'topics', label: 'Topics' },
  { id: 'subscriptions', label: 'Subscriptions' }
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

function formatLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '-'
  const entries = Object.entries(labels)
  if (entries.length === 0) return '-'
  return entries.map(([k, v]) => `${k}=${v}`).join(', ')
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

function deliveryBadgeTone(delivery: string): string {
  if (delivery === 'push') return 'status-ok'
  if (delivery === 'bigquery' || delivery === 'cloud-storage') return 'status-warn'
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

export function GcpPubSubConsole({
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
  const [mainTab, setMainTab] = useState<PubSubTab>('topics')
  const [tabsOpen, setTabsOpen] = useState(true)

  const [topics, setTopics] = useState<GcpPubSubTopicSummary[]>([])
  const [subscriptions, setSubscriptions] = useState<GcpPubSubSubscriptionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedTopic, setSelectedTopic] = useState<GcpPubSubTopicSummary | null>(null)
  const [selectedSub, setSelectedSub] = useState<GcpPubSubSubscriptionSummary | null>(null)
  const [subDetail, setSubDetail] = useState<GcpPubSubSubscriptionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [topicFilter, setTopicFilter] = useState('')
  const [subFilter, setSubFilter] = useState('')

  /* ── Data fetching ────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    Promise.all([
      listGcpPubSubTopics(projectId),
      listGcpPubSubSubscriptions(projectId)
    ]).then(([topicResult, subResult]) => {
      if (cancelled) return
      setTopics(topicResult)
      setSubscriptions(subResult)
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [projectId, refreshNonce])

  /* Load subscription detail on selection */
  useEffect(() => {
    if (!selectedSub) {
      setSubDetail(null)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    setDetailError('')

    getGcpPubSubSubscriptionDetail(projectId, selectedSub.subscriptionId)
      .then((detail) => {
        if (!cancelled) setSubDetail(detail)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, selectedSub?.subscriptionId])

  /* ── Derived data ─────────────────────────────────────────── */

  const locationLabel = location.trim() || 'global'
  const pushEndpointCount = useMemo(
    () => subscriptions.filter((s) => s.deliveryType === 'push').length,
    [subscriptions]
  )
  const detachedCount = useMemo(
    () => subscriptions.filter((s) => s.detached).length,
    [subscriptions]
  )

  const filteredTopics = useMemo(() => {
    if (!topicFilter.trim()) return topics
    const q = topicFilter.trim().toLowerCase()
    return topics.filter((t) =>
      t.topicId.toLowerCase().includes(q) ||
      formatLabels(t.labels).toLowerCase().includes(q)
    )
  }, [topics, topicFilter])

  const filteredSubs = useMemo(() => {
    if (!subFilter.trim()) return subscriptions
    const q = subFilter.trim().toLowerCase()
    return subscriptions.filter((s) =>
      s.subscriptionId.toLowerCase().includes(q) ||
      s.topicId.toLowerCase().includes(q) ||
      s.deliveryType.toLowerCase().includes(q) ||
      (s.filter || '').toLowerCase().includes(q)
    )
  }, [subscriptions, subFilter])

  const topicSubscriptions = useMemo(() => {
    if (!selectedTopic) return []
    return subscriptions.filter((s) => s.topicId === selectedTopic.topicId)
  }, [subscriptions, selectedTopic?.topicId])

  const enableAction = error
    ? getGcpApiEnableAction(
        error,
        `gcloud services enable pubsub.googleapis.com --project ${projectId}`,
        `Pub/Sub API is disabled for project ${projectId}.`
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
          <div className="eyebrow">Messaging posture</div>
          <h2>Pub/Sub Operations</h2>
          <p>
            Topic and subscription inventory with delivery-type visibility,
            dead-letter policy inspection, and push-endpoint surfacing for the
            active Google Cloud project.
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
            <div className="iam-shell-meta-pill">
              <span>Selection</span>
              <strong>
                {mainTab === 'topics'
                  ? selectedTopic?.topicId || 'No selection'
                  : selectedSub?.subscriptionId || 'No selection'}
              </strong>
            </div>
          </div>
        </div>
        <div className="iam-shell-hero-stats">
          <div className="iam-shell-stat-card iam-shell-stat-card-accent">
            <span>Topics</span>
            <strong>{topics.length}</strong>
            <small>{loading ? 'Refreshing live data now' : 'Topics in current project scope'}</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Subscriptions</span>
            <strong>{subscriptions.length}</strong>
            <small>Total subscriptions across all topics</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Push endpoints</span>
            <strong>{pushEndpointCount}</strong>
            <small>Subscriptions with push delivery configured</small>
          </div>
          <div className="iam-shell-stat-card">
            <span>Detached</span>
            <strong>{detachedCount}</strong>
            <small>Subscriptions detached from their topic</small>
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
      {loading && <SvcState variant="loading" resourceName="Pub/Sub resources" message="Fetching topics and subscriptions..." />}

      {/* ══════════════ TOPICS TAB ══════════════ */}
      {!loading && !error && mainTab === 'topics' && (
        <div className="overview-surface">
          <div className="panel">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <span>Topics ({filteredTopics.length})</span>
              <input
                className="svc-search"
                style={{ maxWidth: 280 }}
                placeholder="Filter topics..."
                value={topicFilter}
                onChange={(e) => setTopicFilter(e.target.value)}
              />
            </div>

            {/* Table header */}
            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr 1.5fr 1fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Topic ID</span>
              <span>Retention</span>
              <span>KMS</span>
              <span>Labels</span>
              <span>Schema</span>
            </div>

            {/* Table rows */}
            {filteredTopics.length === 0 && (
              <SvcState variant="empty" message="No topics found in this project." compact />
            )}
            {filteredTopics.map((topic) => (
              <div
                key={topic.topicId}
                className={`table-row overview-table-row ${selectedTopic?.topicId === topic.topicId ? 'active' : ''}`}
                style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr 1.5fr 1fr', gap: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
                onClick={() => setSelectedTopic((prev) => prev?.topicId === topic.topicId ? null : topic)}
              >
                <span title={topic.name}>{truncate(topic.topicId)}</span>
                <span>{topic.messageRetentionDuration || '-'}</span>
                <span title={topic.kmsKeyName || ''}>{topic.kmsKeyName ? truncate(shortName(topic.kmsKeyName), 28) : '-'}</span>
                <span title={formatLabels(topic.labels)}>{truncate(formatLabels(topic.labels), 32)}</span>
                <span>{topic.schemaSettings ? 'Configured' : '-'}</span>
              </div>
            ))}
          </div>

          {/* ── Topic detail: linked subscriptions ──── */}
          {selectedTopic && (
            <div className="panel" style={{ marginTop: '1rem' }}>
              <div className="panel-header">
                Subscriptions linked to <strong>{selectedTopic.topicId}</strong> ({topicSubscriptions.length})
              </div>

              {topicSubscriptions.length === 0 && (
                <SvcState variant="empty" message="No subscriptions are linked to this topic." compact />
              )}
              {topicSubscriptions.length > 0 && (
                <>
                  <div
                    className="table-head"
                    style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: '1rem', padding: '0.5rem 1rem' }}
                  >
                    <span>Subscription ID</span>
                    <span>Delivery</span>
                    <span>Ack Deadline</span>
                    <span>Exactly Once</span>
                    <span>State</span>
                  </div>
                  {topicSubscriptions.map((sub) => (
                    <div
                      key={sub.subscriptionId}
                      className="table-row overview-table-row"
                      style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: '1rem', padding: '0.5rem 1rem' }}
                    >
                      <span title={sub.name}>{truncate(sub.subscriptionId)}</span>
                      <span className={`status-badge ${deliveryBadgeTone(sub.deliveryType)}`}>{sub.deliveryType}</span>
                      <span>{sub.ackDeadlineSeconds}s</span>
                      <span>{sub.enableExactlyOnceDelivery ? 'Yes' : 'No'}</span>
                      <span className={`status-badge ${sub.state === 'ACTIVE' ? 'status-ok' : 'status-warn'}`}>{sub.state || '-'}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════ SUBSCRIPTIONS TAB ══════════════ */}
      {!loading && !error && mainTab === 'subscriptions' && (
        <div className="overview-surface">
          <div className="panel">
            <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <span>Subscriptions ({filteredSubs.length})</span>
              <input
                className="svc-search"
                style={{ maxWidth: 280 }}
                placeholder="Filter subscriptions..."
                value={subFilter}
                onChange={(e) => setSubFilter(e.target.value)}
              />
            </div>

            {/* Table header */}
            <div
              className="table-head"
              style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1.5fr 1fr', gap: '1rem', padding: '0.5rem 1rem' }}
            >
              <span>Subscription ID</span>
              <span>Topic</span>
              <span>Delivery</span>
              <span>Ack Deadline</span>
              <span>Filter</span>
              <span>Exactly Once</span>
            </div>

            {/* Table rows */}
            {filteredSubs.length === 0 && (
              <SvcState variant="empty" message="No subscriptions found in this project." compact />
            )}
            {filteredSubs.map((sub) => (
              <div
                key={sub.subscriptionId}
                className={`table-row overview-table-row ${selectedSub?.subscriptionId === sub.subscriptionId ? 'active' : ''}`}
                style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1.5fr 1fr', gap: '1rem', padding: '0.5rem 1rem', cursor: 'pointer' }}
                onClick={() => setSelectedSub((prev) => prev?.subscriptionId === sub.subscriptionId ? null : sub)}
              >
                <span title={sub.name}>{truncate(sub.subscriptionId)}</span>
                <span title={sub.topic}>{truncate(sub.topicId, 32)}</span>
                <span className={`status-badge ${deliveryBadgeTone(sub.deliveryType)}`}>{sub.deliveryType}</span>
                <span>{sub.ackDeadlineSeconds}s</span>
                <span title={sub.filter || ''}>{sub.filter ? truncate(sub.filter, 28) : '-'}</span>
                <span>{sub.enableExactlyOnceDelivery ? 'Yes' : 'No'}</span>
              </div>
            ))}
          </div>

          {/* ── Subscription detail panel ───────────── */}
          {selectedSub && (
            <div className="panel" style={{ marginTop: '1rem' }}>
              <div className="panel-header">
                Subscription detail: <strong>{selectedSub.subscriptionId}</strong>
                {selectedSub.detached && (
                  <span className="status-badge status-warn" style={{ marginLeft: '0.5rem' }}>Detached</span>
                )}
              </div>

              {detailLoading && (
                <SvcState variant="loading" resourceName="subscription detail" compact />
              )}
              {detailError && (
                <SvcState variant="error" error={detailError} compact />
              )}

              {subDetail && !detailLoading && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', padding: '1rem' }}>
                  {/* Left column: general info */}
                  <div>
                    <h4 style={{ margin: '0 0 0.75rem' }}>General</h4>
                    <DetailRow label="Topic" value={shortName(subDetail.topic)} />
                    <DetailRow label="Ack deadline" value={`${subDetail.ackDeadlineSeconds}s`} />
                    <DetailRow label="Message retention" value={subDetail.messageRetentionDuration || '-'} />
                    <DetailRow label="Exactly-once delivery" value={subDetail.enableExactlyOnceDelivery ? 'Enabled' : 'Disabled'} />
                    <DetailRow label="Filter" value={subDetail.filter || '-'} />
                    <div className="table-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0' }}>
                      <span>State</span>
                      <span className={`status-badge ${subDetail.state === 'ACTIVE' ? 'status-ok' : 'status-warn'}`}>{subDetail.state || '-'}</span>
                    </div>
                    <DetailRow label="Retain acked messages" value={subDetail.retainAckedMessages ? 'Yes' : 'No'} />
                    <DetailRow label="Expiration TTL" value={subDetail.expirationTtl || '-'} />
                  </div>

                  {/* Right column: policies */}
                  <div>
                    <h4 style={{ margin: '0 0 0.75rem' }}>Push Config</h4>
                    {subDetail.pushConfig ? (
                      <DetailRow label="Endpoint" value={truncate(subDetail.pushConfig.pushEndpoint || '-', 36)} title={subDetail.pushConfig.pushEndpoint} />
                    ) : (
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No push config. This subscription uses pull delivery.</p>
                    )}

                    <h4 style={{ margin: '1rem 0 0.75rem' }}>Dead Letter Policy</h4>
                    {subDetail.deadLetterPolicy ? (
                      <>
                        <DetailRow label="Dead letter topic" value={truncate(shortName(subDetail.deadLetterPolicy.deadLetterTopic || ''), 36)} />
                        <DetailRow label="Max delivery attempts" value={String(subDetail.deadLetterPolicy.maxDeliveryAttempts ?? '-')} />
                      </>
                    ) : (
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No dead letter policy configured.</p>
                    )}

                    <h4 style={{ margin: '1rem 0 0.75rem' }}>Retry Policy</h4>
                    {subDetail.retryPolicy ? (
                      <>
                        <DetailRow label="Min backoff" value={subDetail.retryPolicy.minimumBackoff || '-'} />
                        <DetailRow label="Max backoff" value={subDetail.retryPolicy.maximumBackoff || '-'} />
                      </>
                    ) : (
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No retry policy configured. Default exponential backoff applies.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
