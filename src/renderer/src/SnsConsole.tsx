import { useEffect, useMemo, useState } from 'react'
import {
  createSnsTopic, deleteSnsTopic, getSnsTopic, listSnsSubscriptions, listSnsTopics,
  setSnsTopicAttribute, snsPublish, snsSubscribe, snsUnsubscribe,
  tagSnsTopic, untagSnsTopic
} from './api'
import type {
  AwsConnection, SnsTopicSummary, SnsSubscriptionSummary, SnsPublishResult
} from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'name' | 'topicArn' | 'subscriptionCount' | 'type' | 'owner'
type SideTab = 'details' | 'subscriptions' | 'tags' | 'publish'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'topicArn', label: 'ARN', color: '#14b8a6' },
  { key: 'subscriptionCount', label: 'Subs', color: '#8b5cf6' },
  { key: 'type', label: 'Type', color: '#22c55e' },
  { key: 'owner', label: 'Owner', color: '#f59e0b' },
]

function getVal(t: SnsTopicSummary, k: ColKey): string {
  switch (k) {
    case 'name': return t.name
    case 'topicArn': return t.topicArn
    case 'subscriptionCount': return String(t.subscriptionCount)
    case 'type': return t.fifoTopic ? 'FIFO' : 'Standard'
    case 'owner': return t.owner
  }
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
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  // create topic
  const [showCreate, setShowCreate] = useState(false)
  const [newTopicName, setNewTopicName] = useState('')
  const [newTopicFifo, setNewTopicFifo] = useState(false)

  // edit attribute
  const [editAttrName, setEditAttrName] = useState('DisplayName')
  const [editAttrValue, setEditAttrValue] = useState('')

  // subscribe
  const [subProtocol, setSubProtocol] = useState('email')
  const [subEndpoint, setSubEndpoint] = useState('')

  // publish
  const [pubMessage, setPubMessage] = useState('')
  const [pubSubject, setPubSubject] = useState('')
  const [pubGroupId, setPubGroupId] = useState('')
  const [pubDedupId, setPubDedupId] = useState('')
  const [pubResult, setPubResult] = useState<SnsPublishResult | null>(null)

  // tags
  const [newTagKey, setNewTagKey] = useState('')
  const [newTagValue, setNewTagValue] = useState('')

  /* ── Data loading ────────────────────────────────────────── */
  async function reload(selectArn?: string) {
    setLoading(true); setError('')
    try {
      const list = await listSnsTopics(connection)
      setTopics(list)
      const target = selectArn ?? list.find(t => t.topicArn === selectedArn)?.topicArn ?? list[0]?.topicArn ?? ''
      if (target) { setSelectedArn(target); await loadTopic(target) }
      else { setSelectedArn(''); setTopic(null); setSubscriptions([]) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  async function loadTopic(arn: string) {
    try {
      const [detail, subs] = await Promise.all([getSnsTopic(connection, arn), listSnsSubscriptions(connection, arn)])
      setTopic(detail); setSubscriptions(subs)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  useEffect(() => { void reload() }, [connection.profile, connection.region])

  async function handleSelect(arn: string) {
    setSelectedArn(arn); setError('')
    await loadTopic(arn)
  }

  /* ── Actions ─────────────────────────────────────────────── */
  async function handleCreateTopic() {
    if (!newTopicName.trim()) return
    setError('')
    try {
      const arn = await createSnsTopic(connection, newTopicName.trim(), newTopicFifo)
      setNewTopicName(''); setNewTopicFifo(false); setShowCreate(false)
      setMsg('Topic created')
      await reload(arn)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDeleteTopic() {
    if (!selectedArn) return
    try {
      await deleteSnsTopic(connection, selectedArn)
      setMsg('Topic deleted')
      setTopic(null); setSubscriptions([])
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleSetAttribute() {
    if (!selectedArn) return
    try {
      await setSnsTopicAttribute(connection, selectedArn, editAttrName, editAttrValue)
      setEditAttrValue('')
      setMsg('Attribute updated')
      await loadTopic(selectedArn)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleSubscribe() {
    if (!selectedArn || !subEndpoint.trim()) return
    try {
      await snsSubscribe(connection, selectedArn, subProtocol, subEndpoint.trim())
      setSubEndpoint('')
      setMsg('Subscription created')
      setSubscriptions(await listSnsSubscriptions(connection, selectedArn))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleUnsubscribe(subArn: string) {
    try {
      await snsUnsubscribe(connection, subArn)
      setMsg('Unsubscribed')
      setSubscriptions(await listSnsSubscriptions(connection, selectedArn))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handlePublish() {
    if (!selectedArn || !pubMessage.trim()) return
    try {
      const result = await snsPublish(connection, selectedArn, pubMessage, pubSubject || undefined, pubGroupId || undefined, pubDedupId || undefined)
      setPubResult(result); setPubMessage('')
      setMsg('Message published')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleAddTag() {
    if (!selectedArn || !newTagKey.trim()) return
    try {
      await tagSnsTopic(connection, selectedArn, { [newTagKey.trim()]: newTagValue })
      setNewTagKey(''); setNewTagValue('')
      setMsg('Tag added')
      await loadTopic(selectedArn)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleRemoveTag(key: string) {
    if (!selectedArn) return
    try {
      await untagSnsTopic(connection, selectedArn, [key])
      setMsg('Tag removed')
      await loadTopic(selectedArn)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /* ── Filtering ───────────────────────────────────────────── */
  const activeCols = COLUMNS.filter(c => visCols.has(c.key))

  const filtered = useMemo(() => {
    if (!filter) return topics
    const q = filter.toLowerCase()
    return topics.filter(t => activeCols.some(c => getVal(t, c.key).toLowerCase().includes(q)))
  }, [topics, filter, activeCols])

  /* ── Render ──────────────────────────────────────────────── */
  return (
    <div className="svc-console">
      {/* ── Tab bar ─────────────────────────────────────── */}
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Topics</button>
        <button className="svc-tab" type="button" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel Create' : 'Create Topic'}
        </button>
        <button className="svc-tab right" type="button" onClick={() => void reload()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* ── Create topic panel ──────────────────────────── */}
      {showCreate && (
        <div className="svc-panel">
          <h3>Create Topic</h3>
          <div className="svc-form">
            <label><span>Name</span><input value={newTopicName} onChange={e => setNewTopicName(e.target.value)} placeholder="my-topic" /></label>
            <label><span>FIFO</span>
              <div className="svc-inline">
                <input type="checkbox" checked={newTopicFifo} onChange={e => setNewTopicFifo(e.target.checked)} style={{ width: 'auto', height: 'auto' }} />
                <span style={{ fontSize: 12, color: '#9ca7b7' }}>Enable FIFO ordering</span>
              </div>
            </label>
          </div>
          <div className="svc-btn-row">
            <button type="button" className="svc-btn success" disabled={!newTopicName.trim()} onClick={() => void handleCreateTopic()}>Create Topic</button>
          </div>
        </div>
      )}

      {/* ── Search ──────────────────────────────────────── */}
      <input className="svc-search" placeholder="Filter rows across selected columns..." value={filter} onChange={e => setFilter(e.target.value)} />

      {/* ── Column chips ────────────────────────────────── */}
      <div className="svc-chips">
        {COLUMNS.map(col => (
          <button
            key={col.key}
            className={`svc-chip ${visCols.has(col.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
            onClick={() => setVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
          >{col.label}</button>
        ))}
      </div>

      {/* ── Layout: table + sidebar ─────────────────────── */}
      <div className="svc-layout">
        <div className="svc-table-area">
          <table className="svc-table">
            <thead>
              <tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.topicArn} className={t.topicArn === selectedArn ? 'active' : ''} onClick={() => void handleSelect(t.topicArn)}>
                  {activeCols.map(c => (
                    <td key={c.key}>
                      {c.key === 'type'
                        ? <span className={`svc-badge ${t.fifoTopic ? 'warn' : 'ok'}`}>{t.fifoTopic ? 'FIFO' : 'Standard'}</span>
                        : getVal(t, c.key)
                      }
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="svc-empty">Loading topics...</div>}
          {!loading && !filtered.length && <div className="svc-empty">No topics found.</div>}
        </div>

        {/* ── Sidebar ──────────────────────────────────── */}
        <div className="svc-sidebar">
          <div className="svc-side-tabs">
            {(['details', 'subscriptions', 'tags', 'publish'] as SideTab[]).map(t => (
              <button key={t} className={sideTab === t ? 'active' : ''} type="button" onClick={() => setSideTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>

          {/* ── Details tab ─────────────────────────────── */}
          {sideTab === 'details' && (
            <>
              <div className="svc-section">
                <h3>Actions</h3>
                <div className="svc-btn-row">
                  <button className="svc-btn primary" type="button" disabled={!selectedArn} onClick={() => void reload()}>Refresh</button>
                  <ConfirmButton className="svc-btn danger" onConfirm={() => void handleDeleteTopic()}>Delete Topic</ConfirmButton>
                </div>
              </div>

              {topic ? (
                <div className="svc-section">
                  <h3>Topic Details</h3>
                  <div className="svc-kv">
                    <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{topic.name}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value">{topic.topicArn}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Display Name</div><div className="svc-kv-value">{topic.displayName || '(none)'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Owner</div><div className="svc-kv-value">{topic.owner}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Type</div><div className="svc-kv-value">{topic.fifoTopic ? 'FIFO' : 'Standard'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Subscriptions</div><div className="svc-kv-value">{topic.subscriptionCount}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Content Dedup</div><div className="svc-kv-value">{topic.contentBasedDeduplication ? 'Yes' : 'No'}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">KMS Key</div><div className="svc-kv-value">{topic.kmsMasterKeyId || 'Default'}</div></div>
                  </div>
                </div>
              ) : (
                <div className="svc-section">
                  <div className="svc-empty">Select a topic to view details.</div>
                </div>
              )}

              {topic && (
                <div className="svc-section">
                  <h3>Edit Attribute</h3>
                  <div className="svc-inline">
                    <select className="svc-select" value={editAttrName} onChange={e => setEditAttrName(e.target.value)}>
                      <option value="DisplayName">DisplayName</option>
                      <option value="Policy">Policy</option>
                      <option value="DeliveryPolicy">DeliveryPolicy</option>
                      <option value="KmsMasterKeyId">KmsMasterKeyId</option>
                    </select>
                    <input value={editAttrValue} onChange={e => setEditAttrValue(e.target.value)} placeholder="New value..." />
                    <button type="button" className="svc-btn primary" onClick={() => void handleSetAttribute()}>Set</button>
                  </div>
                  {topic.policy && (
                    <>
                      <h3 style={{ marginTop: 14 }}>Policy</h3>
                      <pre className="svc-code" style={{ maxHeight: 200, overflow: 'auto' }}>{topic.policy}</pre>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Subscriptions tab ───────────────────────── */}
          {sideTab === 'subscriptions' && (
            <>
              <div className="svc-section">
                <h3>Add Subscription</h3>
                <div className="svc-inline">
                  <select className="svc-select" value={subProtocol} onChange={e => setSubProtocol(e.target.value)}>
                    {['email', 'sms', 'http', 'https', 'sqs', 'lambda', 'application', 'firehose'].map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <input value={subEndpoint} onChange={e => setSubEndpoint(e.target.value)} placeholder="Endpoint (email, URL, ARN...)" />
                  <button type="button" className="svc-btn success" onClick={() => void handleSubscribe()}>Subscribe</button>
                </div>
              </div>

              <div className="svc-section">
                <h3>Subscriptions ({subscriptions.length})</h3>
                {subscriptions.length > 0 ? (
                  <div className="svc-kv">
                    {subscriptions.map(s => (
                      <div key={s.subscriptionArn} style={{ borderBottom: '1px solid #3b4350', paddingBottom: 10, marginBottom: 6 }}>
                        <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value" style={{ fontSize: 11 }}>{s.subscriptionArn}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Protocol</div><div className="svc-kv-value"><span className="svc-badge ok">{s.protocol}</span></div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Endpoint</div><div className="svc-kv-value">{s.endpoint}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Status</div><div className="svc-kv-value">
                          <span className={`svc-badge ${s.pendingConfirmation ? 'warn' : 'ok'}`}>{s.pendingConfirmation ? 'Pending' : 'Confirmed'}</span>
                        </div></div>
                        {!s.pendingConfirmation && s.subscriptionArn !== 'PendingConfirmation' && (
                          <div style={{ marginTop: 6 }}>
                            <ConfirmButton className="svc-btn danger" onConfirm={() => void handleUnsubscribe(s.subscriptionArn)}>Unsubscribe</ConfirmButton>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="svc-empty">No subscriptions.</div>
                )}
              </div>
            </>
          )}

          {/* ── Tags tab ────────────────────────────────── */}
          {sideTab === 'tags' && (
            <>
              <div className="svc-section">
                <h3>Add Tag</h3>
                <div className="svc-inline">
                  <input value={newTagKey} onChange={e => setNewTagKey(e.target.value)} placeholder="Key" />
                  <input value={newTagValue} onChange={e => setNewTagValue(e.target.value)} placeholder="Value" />
                  <button type="button" className="svc-btn success" onClick={() => void handleAddTag()}>Add Tag</button>
                </div>
              </div>

              <div className="svc-section">
                <h3>Tags ({topic ? Object.keys(topic.tags).length : 0})</h3>
                {topic && Object.keys(topic.tags).length > 0 ? (
                  <div className="svc-kv">
                    {Object.entries(topic.tags).map(([k, v]) => (
                      <div key={k} className="svc-kv-row">
                        <div className="svc-kv-label">{k}</div>
                        <div className="svc-kv-value" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <span>{v}</span>
                          <ConfirmButton className="svc-btn danger" onConfirm={() => void handleRemoveTag(k)}>Remove</ConfirmButton>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="svc-empty">No tags.</div>
                )}
              </div>
            </>
          )}

          {/* ── Publish tab ─────────────────────────────── */}
          {sideTab === 'publish' && (
            <div className="svc-section">
              <h3>Publish Message</h3>
              <div className="svc-form">
                <label><span>Subject</span><input value={pubSubject} onChange={e => setPubSubject(e.target.value)} placeholder="Message subject (optional)" /></label>
                <label><span>Message</span><textarea value={pubMessage} onChange={e => setPubMessage(e.target.value)} placeholder="Message body..." rows={6} /></label>
                {topic?.fifoTopic && (
                  <>
                    <label><span>Group ID</span><input value={pubGroupId} onChange={e => setPubGroupId(e.target.value)} placeholder="Message group" /></label>
                    <label><span>Dedup ID</span><input value={pubDedupId} onChange={e => setPubDedupId(e.target.value)} placeholder="Deduplication ID" /></label>
                  </>
                )}
              </div>
              <div className="svc-btn-row">
                <button type="button" className="svc-btn success" disabled={!selectedArn || !pubMessage.trim()} onClick={() => void handlePublish()}>Publish Message</button>
              </div>
              {pubResult && (
                <div style={{ marginTop: 12 }}>
                  <h3>Published</h3>
                  <div className="svc-kv">
                    <div className="svc-kv-row"><div className="svc-kv-label">Message ID</div><div className="svc-kv-value">{pubResult.messageId}</div></div>
                    {pubResult.sequenceNumber && <div className="svc-kv-row"><div className="svc-kv-label">Sequence</div><div className="svc-kv-value">{pubResult.sequenceNumber}</div></div>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
