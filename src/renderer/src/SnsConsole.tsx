import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import './sns.css'

import {
  createSnsTopic, deleteSnsTopic, getSnsTopic, listSnsSubscriptions, listSnsTopics,
  setSnsTopicAttribute, snsPublish, snsSubscribe, snsUnsubscribe,
  tagSnsTopic, untagSnsTopic
} from './api'
import type {
  AwsConnection, SnsPublishResult, SnsSubscriptionSummary, SnsTopicSummary
} from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'name' | 'topicArn' | 'subscriptionCount' | 'type' | 'owner'
type SideTab = 'details' | 'subscriptions' | 'tags' | 'publish'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'topicArn', label: 'ARN', color: '#14b8a6' },
  { key: 'subscriptionCount', label: 'Subs', color: '#8b5cf6' },
  { key: 'type', label: 'Type', color: '#22c55e' },
  { key: 'owner', label: 'Owner', color: '#f59e0b' }
]

function getVal(topic: SnsTopicSummary, key: ColKey): string {
  switch (key) {
    case 'name': return topic.name
    case 'topicArn': return topic.topicArn
    case 'subscriptionCount': return String(topic.subscriptionCount)
    case 'type': return topic.fifoTopic ? 'FIFO' : 'Standard'
    case 'owner': return topic.owner
  }
}

function compactArn(value: string): string {
  if (value.length <= 64) return value
  return `${value.slice(0, 28)}...${value.slice(-28)}`
}

function summarizeProtocols(subscriptions: SnsSubscriptionSummary[]): string {
  const counts = subscriptions.reduce<Record<string, number>>((acc, subscription) => {
    acc[subscription.protocol] = (acc[subscription.protocol] ?? 0) + 1
    return acc
  }, {})

  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([protocol, count]) => `${protocol}:${count}`)
    .join('  ') || 'No subscriptions loaded'
}

export function SnsConsole({ connection }: { connection: AwsConnection }) {
  const [topics, setTopics] = useState<SnsTopicSummary[]>([])
  const [selectedArn, setSelectedArn] = useState('')
  const [topic, setTopic] = useState<SnsTopicSummary | null>(null)
  const [subscriptions, setSubscriptions] = useState<SnsSubscriptionSummary[]>([])
  const [sideTab, setSideTab] = useState<SideTab>('details')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))
  const [showCreate, setShowCreate] = useState(false)
  const [newTopicName, setNewTopicName] = useState('')
  const [newTopicFifo, setNewTopicFifo] = useState(false)
  const [editAttrName, setEditAttrName] = useState('DisplayName')
  const [editAttrValue, setEditAttrValue] = useState('')
  const [subProtocol, setSubProtocol] = useState('email')
  const [subEndpoint, setSubEndpoint] = useState('')
  const [pubMessage, setPubMessage] = useState('')
  const [pubSubject, setPubSubject] = useState('')
  const [pubGroupId, setPubGroupId] = useState('')
  const [pubDedupId, setPubDedupId] = useState('')
  const [pubResult, setPubResult] = useState<SnsPublishResult | null>(null)
  const [newTagKey, setNewTagKey] = useState('')
  const [newTagValue, setNewTagValue] = useState('')

  async function reload(selectArn?: string) {
    setLoading(true)
    setError('')
    try {
      const list = await listSnsTopics(connection)
      setTopics(list)
      const target = selectArn ?? list.find((item) => item.topicArn === selectedArn)?.topicArn ?? list[0]?.topicArn ?? ''
      if (target) {
        setSelectedArn(target)
        await loadTopic(target)
      } else {
        setSelectedArn('')
        setTopic(null)
        setSubscriptions([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function loadTopic(arn: string) {
    try {
      const [detail, subs] = await Promise.all([getSnsTopic(connection, arn), listSnsSubscriptions(connection, arn)])
      setTopic(detail)
      setSubscriptions(subs)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [connection.sessionId, connection.region])

  async function handleSelect(arn: string) {
    setSelectedArn(arn)
    setError('')
    setSideTab('details')
    await loadTopic(arn)
  }

  async function handleCreateTopic() {
    if (!newTopicName.trim()) return
    setError('')
    try {
      const trimmed = newTopicName.trim()
      const arn = await createSnsTopic(connection, trimmed, newTopicFifo)
      setNewTopicName('')
      setNewTopicFifo(false)
      setShowCreate(false)
      setMsg('Topic created')
      await reload(arn)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteTopic() {
    if (!selectedArn) return
    try {
      await deleteSnsTopic(connection, selectedArn)
      setMsg('Topic deleted')
      setTopic(null)
      setSubscriptions([])
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleSetAttribute() {
    if (!selectedArn) return
    try {
      await setSnsTopicAttribute(connection, selectedArn, editAttrName, editAttrValue)
      setEditAttrValue('')
      setMsg('Attribute updated')
      await loadTopic(selectedArn)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleSubscribe() {
    if (!selectedArn || !subEndpoint.trim()) return
    try {
      await snsSubscribe(connection, selectedArn, subProtocol, subEndpoint.trim())
      setSubEndpoint('')
      setMsg('Subscription created')
      setSubscriptions(await listSnsSubscriptions(connection, selectedArn))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleUnsubscribe(subscriptionArn: string) {
    try {
      await snsUnsubscribe(connection, subscriptionArn)
      setMsg('Unsubscribed')
      setSubscriptions(await listSnsSubscriptions(connection, selectedArn))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handlePublish() {
    if (!selectedArn || !pubMessage.trim()) return
    try {
      const result = await snsPublish(connection, selectedArn, pubMessage, pubSubject || undefined, pubGroupId || undefined, pubDedupId || undefined)
      setPubResult(result)
      setPubMessage('')
      setMsg('Message published')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleAddTag() {
    if (!selectedArn || !newTagKey.trim()) return
    try {
      await tagSnsTopic(connection, selectedArn, { [newTagKey.trim()]: newTagValue })
      setNewTagKey('')
      setNewTagValue('')
      setMsg('Tag added')
      await loadTopic(selectedArn)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleRemoveTag(key: string) {
    if (!selectedArn) return
    try {
      await untagSnsTopic(connection, selectedArn, [key])
      setMsg('Tag removed')
      await loadTopic(selectedArn)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const activeCols = COLUMNS.filter((column) => visCols.has(column.key))
  const filteredTopics = useMemo(() => {
    if (!filter) return topics
    const query = filter.toLowerCase()
    return topics.filter((item) => activeCols.some((column) => getVal(item, column.key).toLowerCase().includes(query)))
  }, [topics, filter, activeCols])
  const selectedTopicSummary = useMemo(
    () => topics.find((item) => item.topicArn === selectedArn) ?? topic,
    [selectedArn, topic, topics]
  )
  const totalSubscriptions = useMemo(() => topics.reduce((sum, item) => sum + item.subscriptionCount, 0), [topics])
  const fifoTopics = useMemo(() => topics.filter((item) => item.fifoTopic).length, [topics])
  const pendingSubscriptions = useMemo(() => subscriptions.filter((item) => item.pendingConfirmation).length, [subscriptions])
  const selectedTagCount = topic ? Object.keys(topic.tags).length : 0

  return (
    <div className="svc-console sns-console">
      <section className="sns-hero">
        <div className="sns-hero-copy">
          <span className="sns-eyebrow">Notification Workspace</span>
          <h2>SNS topics now follow the Terraform shell: inventory left, operator context right.</h2>
          <p>
            Scan fleet-level topic posture first, then work inside a denser inspector for subscriptions,
            tags, publishing, and attribute edits without changing any SNS behavior.
          </p>

          <div className="sns-meta-strip">
            <div className="sns-meta-pill">
              <span>Session</span>
              <strong>{connection.sessionId}</strong>
            </div>
            <div className="sns-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="sns-meta-pill">
              <span>Selected Topic</span>
              <strong>{selectedTopicSummary?.name || 'Waiting for topic selection'}</strong>
            </div>
            <div className="sns-meta-pill">
              <span>Delivery Mix</span>
              <strong>{summarizeProtocols(subscriptions)}</strong>
            </div>
          </div>
        </div>

        <div className="sns-hero-stats">
          <div className="sns-stat-card sns-stat-card-accent">
            <span>Topics</span>
            <strong>{topics.length}</strong>
            <small>Discovered in the active account and region.</small>
          </div>
          <div className="sns-stat-card">
            <span>Visible Topics</span>
            <strong>{filteredTopics.length}</strong>
            <small>{filter ? 'Remaining after current search scope.' : 'Ready in the current inventory.'}</small>
          </div>
          <div className="sns-stat-card">
            <span>Subscriptions</span>
            <strong>{totalSubscriptions}</strong>
            <small>Aggregate subscription count across loaded topics.</small>
          </div>
          <div className="sns-stat-card">
            <span>FIFO Topics</span>
            <strong>{fifoTopics}</strong>
            <small>{selectedTopicSummary?.fifoTopic ? 'Selected topic requires ordering-aware publishing.' : 'Standard topics remain default.'}</small>
          </div>
        </div>
      </section>

      <section className="sns-toolbar">
        <div className="sns-toolbar-main">
          <div className="sns-field">
            <label htmlFor="sns-filter">Search topics</label>
            <input
              id="sns-filter"
              className="svc-search sns-search"
              placeholder="Filter by active search fields"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="sns-field">
            <label>Inspector mode</label>
            <div className="sns-toolbar-context">
              <span className="sns-context-pill">{selectedTopicSummary?.fifoTopic ? 'FIFO' : 'Standard'}</span>
              <span className="sns-context-copy">{selectedTopicSummary ? compactArn(selectedTopicSummary.topicArn) : 'Select a topic to open the operator pane.'}</span>
            </div>
          </div>
        </div>

        <div className="sns-toolbar-actions">
          <button className="sns-toolbar-btn" type="button" onClick={() => setShowCreate((current) => !current)}>
            {showCreate ? 'Close Create' : 'Create Topic'}
          </button>
          <button className="sns-toolbar-btn accent" type="button" onClick={() => void reload(selectedArn || undefined)}>
            Refresh
          </button>
        </div>
      </section>

      <div className="sns-chip-strip">
        {COLUMNS.map((column) => (
          <button
            key={column.key}
            className={`sns-chip ${visCols.has(column.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(column.key) ? ({ '--sns-chip': column.color } as CSSProperties) : undefined}
            onClick={() => setVisCols((prev) => {
              const next = new Set(prev)
              if (next.has(column.key)) next.delete(column.key)
              else next.add(column.key)
              return next
            })}
          >
            {column.label}
          </button>
        ))}
      </div>

      {msg && <div className="svc-msg sns-banner sns-banner-success">{msg}</div>}
      {error && <div className="svc-error sns-banner sns-banner-error">{error}</div>}

      {showCreate && (
        <section className="sns-create-shell">
          <div className="sns-section-head">
            <div>
              <span className="sns-section-kicker">Provisioning</span>
              <h3>Create topic</h3>
            </div>
            <p>Provision a new topic without leaving the inventory surface.</p>
          </div>

          <div className="sns-create-grid">
            <label className="sns-field">
              <span>Name</span>
              <input value={newTopicName} onChange={(e) => setNewTopicName(e.target.value)} placeholder="my-topic" />
            </label>
            <label className="sns-toggle-card">
              <span className="sns-toggle-copy">
                <strong>FIFO ordering</strong>
                <small>Enable ordered message delivery for `.fifo` topics.</small>
              </span>
              <input type="checkbox" checked={newTopicFifo} onChange={(e) => setNewTopicFifo(e.target.checked)} />
            </label>
          </div>

          <div className="sns-toolbar-actions">
            <button className="sns-toolbar-btn accent" type="button" disabled={!newTopicName.trim()} onClick={() => void handleCreateTopic()}>
              Create Topic
            </button>
          </div>
        </section>
      )}

      <div className="sns-layout">
        <section className="sns-inventory-shell">
          <div className="sns-shell-head">
            <div>
              <span className="sns-section-kicker">Tracked Topics</span>
              <h3>Topic inventory</h3>
            </div>
            <span className="sns-shell-summary">{filteredTopics.length} visible</span>
          </div>

          <div className="sns-summary-strip">
            <div className="sns-summary-pill">
              <span>Owners</span>
              <strong>{new Set(filteredTopics.map((item) => item.owner)).size}</strong>
            </div>
            <div className="sns-summary-pill">
              <span>FIFO</span>
              <strong>{filteredTopics.filter((item) => item.fifoTopic).length}</strong>
            </div>
            <div className="sns-summary-pill">
              <span>Subscriptions</span>
              <strong>{filteredTopics.reduce((sum, item) => sum + item.subscriptionCount, 0)}</strong>
            </div>
          </div>

          <div className="sns-topic-list">
            {filteredTopics.map((item) => (
              <button
                key={item.topicArn}
                type="button"
                className={`sns-topic-row ${item.topicArn === selectedArn ? 'active' : ''}`}
                onClick={() => void handleSelect(item.topicArn)}
              >
                <div className="sns-topic-row-top">
                  <div className="sns-topic-row-copy">
                    <strong>{item.name}</strong>
                    <span title={item.topicArn}>{compactArn(item.topicArn)}</span>
                  </div>
                  <span className={`sns-status-badge ${item.fifoTopic ? 'warning' : 'info'}`}>{item.fifoTopic ? 'FIFO' : 'Standard'}</span>
                </div>

                <div className="sns-topic-row-meta">
                  <span>{item.owner}</span>
                  <span>{item.displayName || 'No display name'}</span>
                </div>

                <div className="sns-topic-row-metrics">
                  <div>
                    <span>Subscriptions</span>
                    <strong>{item.subscriptionCount}</strong>
                  </div>
                  <div>
                    <span>Encryption</span>
                    <strong>{item.kmsMasterKeyId ? 'KMS' : 'Default'}</strong>
                  </div>
                  <div>
                    <span>Tags</span>
                    <strong>{Object.keys(item.tags).length}</strong>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {loading && <div className="svc-empty sns-empty">Loading topics...</div>}
          {!loading && !filteredTopics.length && <div className="svc-empty sns-empty">No topics found for the current filter.</div>}
        </section>

        <section className="sns-detail-pane">
          {!topic ? (
            <div className="svc-empty sns-empty sns-empty-detail">Select a topic to open details, subscriptions, tags, and publishing controls.</div>
          ) : (
            <>
              <section className="sns-detail-hero">
                <div className="sns-detail-copy">
                  <div className="sns-eyebrow">Topic posture</div>
                  <h3>{topic.name}</h3>
                  <p>{topic.topicArn}</p>

                  <div className="sns-meta-strip">
                    <div className="sns-meta-pill">
                      <span>Display Name</span>
                      <strong>{topic.displayName || 'Unset'}</strong>
                    </div>
                    <div className="sns-meta-pill">
                      <span>Owner</span>
                      <strong>{topic.owner}</strong>
                    </div>
                    <div className="sns-meta-pill">
                      <span>KMS</span>
                      <strong>{topic.kmsMasterKeyId || 'AWS managed/default'}</strong>
                    </div>
                    <div className="sns-meta-pill">
                      <span>Filter Mix</span>
                      <strong>{summarizeProtocols(subscriptions)}</strong>
                    </div>
                  </div>
                </div>

                <div className="sns-detail-stats">
                  <div className={`sns-stat-card ${topic.fifoTopic ? 'warning' : 'info'}`}>
                    <span>Topic type</span>
                    <strong>{topic.fifoTopic ? 'FIFO' : 'Standard'}</strong>
                    <small>{topic.fifoTopic ? 'Ordering and deduplication controls are available.' : 'Standard fan-out behavior is active.'}</small>
                  </div>
                  <div className="sns-stat-card">
                    <span>Subscribers</span>
                    <strong>{topic.subscriptionCount}</strong>
                    <small>{pendingSubscriptions ? `${pendingSubscriptions} pending confirmation` : 'All loaded subscriptions confirmed.'}</small>
                  </div>
                  <div className="sns-stat-card">
                    <span>Tags</span>
                    <strong>{selectedTagCount}</strong>
                    <small>{selectedTagCount ? 'Current topic tag footprint.' : 'No tags attached yet.'}</small>
                  </div>
                  <div className="sns-stat-card">
                    <span>Content Dedup</span>
                    <strong>{topic.contentBasedDeduplication ? 'Enabled' : 'Off'}</strong>
                    <small>{topic.fifoTopic ? 'Applies only to FIFO publishing flows.' : 'Ignored for standard topics.'}</small>
                  </div>
                </div>
              </section>

              <div className="sns-detail-tabs">
                {(['details', 'subscriptions', 'tags', 'publish'] as SideTab[]).map((tab) => (
                  <button key={tab} className={sideTab === tab ? 'active' : ''} type="button" onClick={() => setSideTab(tab)}>
                    {tab[0].toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {sideTab === 'details' && (
                <>
                  <section className="sns-section">
                    <div className="sns-section-head sns-section-head-inline">
                      <div>
                        <span className="sns-section-kicker">Actions</span>
                        <h3>Topic controls</h3>
                      </div>
                      <div className="sns-action-row">
                        <button className="sns-inline-btn" type="button" onClick={() => void loadTopic(selectedArn)}>Refresh topic</button>
                        <ConfirmButton className="sns-inline-btn danger" onConfirm={() => void handleDeleteTopic()}>Delete topic</ConfirmButton>
                      </div>
                    </div>
                  </section>

                  <section className="sns-section">
                    <div className="sns-section-head">
                      <div>
                        <span className="sns-section-kicker">Metadata</span>
                        <h3>Topic details</h3>
                      </div>
                    </div>
                    <div className="sns-kv">
                      <div className="sns-kv-row"><div className="sns-kv-label">Name</div><div className="sns-kv-value">{topic.name}</div></div>
                      <div className="sns-kv-row"><div className="sns-kv-label">ARN</div><div className="sns-kv-value">{topic.topicArn}</div></div>
                      <div className="sns-kv-row"><div className="sns-kv-label">Display Name</div><div className="sns-kv-value">{topic.displayName || '(none)'}</div></div>
                      <div className="sns-kv-row"><div className="sns-kv-label">Owner</div><div className="sns-kv-value">{topic.owner}</div></div>
                      <div className="sns-kv-row"><div className="sns-kv-label">Type</div><div className="sns-kv-value">{topic.fifoTopic ? 'FIFO' : 'Standard'}</div></div>
                      <div className="sns-kv-row"><div className="sns-kv-label">Subscriptions</div><div className="sns-kv-value">{topic.subscriptionCount}</div></div>
                      <div className="sns-kv-row"><div className="sns-kv-label">Content Dedup</div><div className="sns-kv-value">{topic.contentBasedDeduplication ? 'Yes' : 'No'}</div></div>
                      <div className="sns-kv-row"><div className="sns-kv-label">KMS Key</div><div className="sns-kv-value">{topic.kmsMasterKeyId || 'Default'}</div></div>
                    </div>
                  </section>

                  <section className="sns-section">
                    <div className="sns-section-head">
                      <div>
                        <span className="sns-section-kicker">Mutation</span>
                        <h3>Edit attribute</h3>
                      </div>
                      <p>Apply a direct SNS topic attribute update without leaving the inspector.</p>
                    </div>

                    <div className="sns-form-grid sns-form-grid-compact">
                      <label className="sns-field">
                        <span>Attribute</span>
                        <select className="svc-select sns-select" value={editAttrName} onChange={(e) => setEditAttrName(e.target.value)}>
                          <option value="DisplayName">DisplayName</option>
                          <option value="Policy">Policy</option>
                          <option value="DeliveryPolicy">DeliveryPolicy</option>
                          <option value="KmsMasterKeyId">KmsMasterKeyId</option>
                        </select>
                      </label>
                      <label className="sns-field">
                        <span>Value</span>
                        <input value={editAttrValue} onChange={(e) => setEditAttrValue(e.target.value)} placeholder="New value" />
                      </label>
                    </div>

                    <div className="sns-action-row">
                      <button type="button" className="sns-inline-btn" onClick={() => void handleSetAttribute()}>Set attribute</button>
                    </div>

                    {topic.policy && (
                      <div className="sns-code-shell">
                        <span className="sns-code-label">Policy</span>
                        <pre className="sns-code">{topic.policy}</pre>
                      </div>
                    )}
                  </section>
                </>
              )}

              {sideTab === 'subscriptions' && (
                <>
                  <section className="sns-section">
                    <div className="sns-section-head">
                      <div>
                        <span className="sns-section-kicker">Fan-out</span>
                        <h3>Add subscription</h3>
                      </div>
                      <p>Create a new endpoint binding for the selected topic.</p>
                    </div>

                    <div className="sns-form-grid">
                      <label className="sns-field">
                        <span>Protocol</span>
                        <select className="svc-select sns-select" value={subProtocol} onChange={(e) => setSubProtocol(e.target.value)}>
                          {['email', 'sms', 'http', 'https', 'sqs', 'lambda', 'application', 'firehose'].map((protocol) => (
                            <option key={protocol} value={protocol}>{protocol}</option>
                          ))}
                        </select>
                      </label>
                      <label className="sns-field">
                        <span>Endpoint</span>
                        <input value={subEndpoint} onChange={(e) => setSubEndpoint(e.target.value)} placeholder="Email, URL, or ARN" />
                      </label>
                    </div>

                    <div className="sns-action-row">
                      <button type="button" className="sns-inline-btn" onClick={() => void handleSubscribe()}>Subscribe</button>
                    </div>
                  </section>

                  <section className="sns-section">
                    <div className="sns-section-head">
                      <div>
                        <span className="sns-section-kicker">Endpoints</span>
                        <h3>Subscriptions</h3>
                      </div>
                      <p>{subscriptions.length} subscription(s) loaded for the selected topic.</p>
                    </div>

                    {subscriptions.length > 0 ? (
                      <div className="sns-card-list">
                        {subscriptions.map((subscription) => (
                          <article key={subscription.subscriptionArn} className="sns-card">
                            <div className="sns-card-head">
                              <div>
                                <strong>{subscription.protocol}</strong>
                                <span>{subscription.endpoint}</span>
                              </div>
                              <span className={`sns-status-badge ${subscription.pendingConfirmation ? 'warning' : 'success'}`}>
                                {subscription.pendingConfirmation ? 'Pending' : 'Confirmed'}
                              </span>
                            </div>

                            <div className="sns-card-metrics">
                              <div>
                                <span>Owner</span>
                                <strong>{subscription.owner}</strong>
                              </div>
                              <div>
                                <span>Raw Delivery</span>
                                <strong>{subscription.rawMessageDelivery ? 'On' : 'Off'}</strong>
                              </div>
                              <div>
                                <span>Auth</span>
                                <strong>{subscription.confirmationWasAuthenticated ? 'Verified' : 'Unverified'}</strong>
                              </div>
                            </div>

                            <div className="sns-card-code">{subscription.subscriptionArn}</div>
                            {subscription.filterPolicy && <pre className="sns-code sns-code-tight">{subscription.filterPolicy}</pre>}

                            {!subscription.pendingConfirmation && subscription.subscriptionArn !== 'PendingConfirmation' && (
                              <div className="sns-action-row">
                                <ConfirmButton className="sns-inline-btn danger" onConfirm={() => void handleUnsubscribe(subscription.subscriptionArn)}>
                                  Unsubscribe
                                </ConfirmButton>
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="svc-empty sns-empty">No subscriptions.</div>
                    )}
                  </section>
                </>
              )}
              {sideTab === 'tags' && (
                <>
                  <section className="sns-section">
                    <div className="sns-section-head">
                      <div>
                        <span className="sns-section-kicker">Classification</span>
                        <h3>Add tag</h3>
                      </div>
                      <p>Attach metadata labels directly to the selected topic.</p>
                    </div>

                    <div className="sns-form-grid">
                      <label className="sns-field">
                        <span>Key</span>
                        <input value={newTagKey} onChange={(e) => setNewTagKey(e.target.value)} placeholder="environment" />
                      </label>
                      <label className="sns-field">
                        <span>Value</span>
                        <input value={newTagValue} onChange={(e) => setNewTagValue(e.target.value)} placeholder="production" />
                      </label>
                    </div>

                    <div className="sns-action-row">
                      <button type="button" className="sns-inline-btn" onClick={() => void handleAddTag()}>Add tag</button>
                    </div>
                  </section>

                  <section className="sns-section">
                    <div className="sns-section-head">
                      <div>
                        <span className="sns-section-kicker">Attached Metadata</span>
                        <h3>Tags</h3>
                      </div>
                      <p>{selectedTagCount} tag(s) applied to the current topic.</p>
                    </div>

                    {selectedTagCount > 0 ? (
                      <div className="sns-tag-list">
                        {Object.entries(topic.tags).map(([key, value]) => (
                          <div key={key} className="sns-tag-row">
                            <div className="sns-tag-copy">
                              <strong>{key}</strong>
                              <span>{value}</span>
                            </div>
                            <ConfirmButton className="sns-inline-btn danger" onConfirm={() => void handleRemoveTag(key)}>Remove</ConfirmButton>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="svc-empty sns-empty">No tags.</div>
                    )}
                  </section>
                </>
              )}

              {sideTab === 'publish' && (
                <section className="sns-section">
                  <div className="sns-section-head">
                    <div>
                      <span className="sns-section-kicker">Delivery</span>
                      <h3>Publish message</h3>
                    </div>
                    <p>Send a test or operational message to the selected topic.</p>
                  </div>

                  <div className="sns-form-grid">
                    <label className="sns-field">
                      <span>Subject</span>
                      <input value={pubSubject} onChange={(e) => setPubSubject(e.target.value)} placeholder="Optional subject" />
                    </label>
                    <label className="sns-field sns-field-full">
                      <span>Message</span>
                      <textarea value={pubMessage} onChange={(e) => setPubMessage(e.target.value)} placeholder="Message body" rows={7} />
                    </label>
                    {topic.fifoTopic && (
                      <>
                        <label className="sns-field">
                          <span>Group ID</span>
                          <input value={pubGroupId} onChange={(e) => setPubGroupId(e.target.value)} placeholder="Message group" />
                        </label>
                        <label className="sns-field">
                          <span>Dedup ID</span>
                          <input value={pubDedupId} onChange={(e) => setPubDedupId(e.target.value)} placeholder="Deduplication ID" />
                        </label>
                      </>
                    )}
                  </div>

                  <div className="sns-action-row">
                    <button type="button" className="sns-inline-btn" disabled={!selectedArn || !pubMessage.trim()} onClick={() => void handlePublish()}>
                      Publish message
                    </button>
                  </div>

                  {pubResult && (
                    <div className="sns-kv sns-kv-published">
                      <div className="sns-kv-row"><div className="sns-kv-label">Message ID</div><div className="sns-kv-value">{pubResult.messageId}</div></div>
                      {pubResult.sequenceNumber && <div className="sns-kv-row"><div className="sns-kv-label">Sequence</div><div className="sns-kv-value">{pubResult.sequenceNumber}</div></div>}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
