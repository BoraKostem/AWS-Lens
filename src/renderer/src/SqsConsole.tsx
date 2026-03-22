import { useEffect, useMemo, useState } from 'react'

import {
  createSqsQueue, deleteSqsQueue, getSqsQueue, listSqsQueues, purgeSqsQueue,
  setSqsAttributes, sqsSendMessage, sqsReceiveMessages, sqsDeleteMessage,
  sqsChangeVisibility, tagSqsQueue, untagSqsQueue, sqsTimeline
} from './api'
import type {
  AwsConnection, SqsQueueSummary, SqsMessage, SqsSendResult, SqsTimelineEvent
} from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

/* ── Column definitions ──────────────────────────────────── */
type ColKey = 'queueName' | 'type' | 'messages' | 'inFlight' | 'delayed' | 'visibility' | 'retention'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'queueName', label: 'Name', color: '#3b82f6' },
  { key: 'type', label: 'Type', color: '#8b5cf6' },
  { key: 'messages', label: 'Messages', color: '#22c55e' },
  { key: 'inFlight', label: 'In Flight', color: '#f59e0b' },
  { key: 'delayed', label: 'Delayed', color: '#06b6d4' },
  { key: 'visibility', label: 'Visibility', color: '#14b8a6' },
  { key: 'retention', label: 'Retention', color: '#a855f7' },
]

function getColVal(q: SqsQueueSummary, k: ColKey): string {
  switch (k) {
    case 'queueName': return q.queueName
    case 'type': return q.fifoQueue ? 'FIFO' : 'Standard'
    case 'messages': return String(q.approximateMessageCount)
    case 'inFlight': return String(q.approximateNotVisibleCount)
    case 'delayed': return String(q.approximateDelayedCount)
    case 'visibility': return `${q.visibilityTimeout}s`
    case 'retention': return `${Math.round(q.messageRetentionPeriod / 86400)}d`
  }
}

function fmtTs(v: string) { return v && v !== '-' ? new Date(v).toLocaleString() : '-' }

/* ── Side tabs ───────────────────────────────────────────── */
type SideTab = 'overview' | 'timeline' | 'messages' | 'send' | 'tags' | 'policy'

/* ── Main component ──────────────────────────────────────── */
export function SqsConsole({ connection }: { connection: AwsConnection }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  /* ── Queue list state ─────────────────────────────────── */
  const [queues, setQueues] = useState<SqsQueueSummary[]>([])
  const [selectedUrl, setSelectedUrl] = useState('')
  const [queue, setQueue] = useState<SqsQueueSummary | null>(null)
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [timeline, setTimeline] = useState<SqsTimelineEvent[]>([])

  /* ── Filter & columns ─────────────────────────────────── */
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))

  /* ── Create queue ─────────────────────────────────────── */
  const [newQueueName, setNewQueueName] = useState('')
  const [newQueueFifo, setNewQueueFifo] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  /* ── Edit attributes ──────────────────────────────────── */
  const [editVisibility, setEditVisibility] = useState('')
  const [editRetention, setEditRetention] = useState('')
  const [editDelay, setEditDelay] = useState('')
  const [editRedrive, setEditRedrive] = useState('')

  /* ── Messages ─────────────────────────────────────────── */
  const [receivedMsgs, setReceivedMsgs] = useState<SqsMessage[]>([])
  const [receiveMax, setReceiveMax] = useState(5)
  const [receiveWait, setReceiveWait] = useState(0)
  const [selectedMsgId, setSelectedMsgId] = useState('')
  const [visibilityTimeout, setVisibilityTimeout] = useState(30)

  /* ── Send ──────────────────────────────────────────────── */
  const [sendBody, setSendBody] = useState('')
  const [sendDelay, setSendDelay] = useState(0)
  const [sendGroupId, setSendGroupId] = useState('')
  const [sendDedupId, setSendDedupId] = useState('')
  const [sendResult, setSendResult] = useState<SqsSendResult | null>(null)

  /* ── Tags ──────────────────────────────────────────────── */
  const [newTagKey, setNewTagKey] = useState('')
  const [newTagValue, setNewTagValue] = useState('')

  /* ── Derived data ─────────────────────────────────────── */
  const selectedMsg = useMemo(() => receivedMsgs.find((m) => m.messageId === selectedMsgId) ?? null, [receivedMsgs, selectedMsgId])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))

  const filteredQueues = useMemo(() => {
    if (!filter) return queues
    const q = filter.toLowerCase()
    return queues.filter(queue => {
      const cols = Array.from(visCols)
      return cols.some(col => getColVal(queue, col).toLowerCase().includes(q))
    })
  }, [queues, filter, visCols])

  /* ── Data loading ─────────────────────────────────────── */
  async function loadQueues(selectUrl?: string) {
    setLoading(true); setError('')
    try {
      const list = await listSqsQueues(connection)
      setQueues(list)
      const url = selectUrl ?? selectedUrl ?? list[0]?.queueUrl ?? ''
      if (url) { setSelectedUrl(url); await loadQueue(url) }
      else { setSelectedUrl(''); setQueue(null); setTimeline([]) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  async function loadQueue(url: string) {
    try {
      const [detail, tl] = await Promise.all([getSqsQueue(connection, url), sqsTimeline(connection, url)])
      setQueue(detail); setTimeline(tl)
      setEditVisibility(String(detail.visibilityTimeout))
      setEditRetention(String(detail.messageRetentionPeriod))
      setEditDelay(String(detail.delaySeconds))
      setEditRedrive(detail.redrivePolicy)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function selectQueue(url: string) {
    setSelectedUrl(url); setReceivedMsgs([]); setSelectedMsgId('')
    await loadQueue(url)
  }

  useEffect(() => { void loadQueues() }, [connection.profile, connection.region])

  /* ── Action handlers ──────────────────────────────────── */
  async function handleCreateQueue() {
    if (!newQueueName.trim()) return
    setError('')
    try {
      const url = await createSqsQueue(connection, newQueueName.trim(), newQueueFifo)
      setNewQueueName(''); setNewQueueFifo(false); setShowCreate(false)
      setMsg(`Queue "${newQueueName.trim()}" created`)
      await loadQueues(url)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleDeleteQueue() {
    if (!selectedUrl) return
    try {
      await deleteSqsQueue(connection, selectedUrl)
      setMsg('Queue deleted')
      setQueue(null); setTimeline([])
      await loadQueues()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handlePurge() {
    if (!selectedUrl) return
    try { await purgeSqsQueue(connection, selectedUrl); setMsg('Queue purged'); await loadQueue(selectedUrl) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleSaveAttributes() {
    if (!selectedUrl) return
    const attrs: Record<string, string> = {}
    if (editVisibility) attrs.VisibilityTimeout = editVisibility
    if (editRetention) attrs.MessageRetentionPeriod = editRetention
    if (editDelay) attrs.DelaySeconds = editDelay
    if (editRedrive) attrs.RedrivePolicy = editRedrive
    try { await setSqsAttributes(connection, selectedUrl, attrs); setMsg('Attributes saved'); await loadQueue(selectedUrl) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleReceive() {
    if (!selectedUrl) return
    setLoading(true)
    try { setReceivedMsgs(await sqsReceiveMessages(connection, selectedUrl, receiveMax, receiveWait)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  async function handleDeleteMsg(handle: string) {
    if (!selectedUrl) return
    try {
      await sqsDeleteMessage(connection, selectedUrl, handle)
      setReceivedMsgs((prev) => prev.filter((m) => m.receiptHandle !== handle))
      setMsg('Message deleted')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleChangeVisibility(handle: string) {
    if (!selectedUrl) return
    try { await sqsChangeVisibility(connection, selectedUrl, handle, visibilityTimeout); setMsg('Visibility extended') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleSend() {
    if (!selectedUrl || !sendBody.trim()) return
    try {
      const result = await sqsSendMessage(connection, selectedUrl, sendBody, sendDelay || undefined, sendGroupId || undefined, sendDedupId || undefined)
      setSendResult(result); setSendBody(''); setMsg('Message sent')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleAddTag() {
    if (!selectedUrl || !newTagKey.trim()) return
    try { await tagSqsQueue(connection, selectedUrl, { [newTagKey.trim()]: newTagValue }); await loadQueue(selectedUrl); setNewTagKey(''); setNewTagValue(''); setMsg('Tag added') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function handleRemoveTag(key: string) {
    if (!selectedUrl) return
    try { await untagSqsQueue(connection, selectedUrl, [key]); await loadQueue(selectedUrl); setMsg(`Tag "${key}" removed`) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  /* ── Column toggle ────────────────────────────────────── */
  function toggleCol(key: ColKey) {
    setVisCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  /* ── Render ───────────────────────────────────────────── */
  return (
    <div className="svc-console">
      {/* ── Top tab bar ──────────────────────────────── */}
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Queues</button>
        <button className="svc-tab" type="button" onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel Create' : 'Create Queue'}</button>
        <button className="svc-tab right" type="button" onClick={() => void loadQueues()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      {/* ── Create queue panel ───────────────────────── */}
      {showCreate && (
        <div className="svc-panel">
          <h3>Create Queue</h3>
          <div className="svc-form">
            <label><span>Queue Name</span><input value={newQueueName} onChange={(e) => setNewQueueName(e.target.value)} placeholder="my-queue" /></label>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={newQueueFifo} onChange={(e) => setNewQueueFifo(e.target.checked)} style={{ width: 'auto', height: 'auto' }} />
              <span>FIFO Queue</span>
            </label>
          </div>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="svc-btn success" disabled={!newQueueName.trim()} onClick={() => void handleCreateQueue()}>Create Queue</button>
          </div>
        </div>
      )}

      {/* ── Filter + column chips ────────────────────── */}
      <input
        className="svc-search"
        placeholder="Filter rows across selected columns..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />

      <div className="svc-chips">
        {COLUMNS.map(col => (
          <button
            key={col.key}
            className={`svc-chip ${visCols.has(col.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
            onClick={() => toggleCol(col.key)}
          >{col.label}</button>
        ))}
      </div>

      {/* ── Layout: table + sidebar ──────────────────── */}
      <div className="svc-layout">
        {/* ── Queue table ────────────────────────────── */}
        <div className="svc-table-area">
          <table className="svc-table">
            <thead>
              <tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {filteredQueues.map(q => (
                <tr
                  key={q.queueUrl}
                  className={q.queueUrl === selectedUrl ? 'active' : ''}
                  onClick={() => void selectQueue(q.queueUrl)}
                >
                  {activeCols.map(c => (
                    <td key={c.key}>
                      {c.key === 'type'
                        ? <span className={`svc-badge ${q.fifoQueue ? 'warn' : 'ok'}`}>{getColVal(q, c.key)}</span>
                        : getColVal(q, c.key)
                      }
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="svc-empty">Loading queues...</div>}
          {!loading && !filteredQueues.length && <div className="svc-empty">No queues found.</div>}
        </div>

        {/* ── Sidebar ────────────────────────────────── */}
        <div className="svc-sidebar">
          <div className="svc-side-tabs">
            {(['overview', 'timeline', 'messages', 'send', 'tags', 'policy'] as SideTab[]).map(t => (
              <button
                key={t}
                className={sideTab === t ? 'active' : ''}
                type="button"
                onClick={() => setSideTab(t)}
              >{t.charAt(0).toUpperCase() + t.slice(1)}</button>
            ))}
          </div>

          {/* ── Overview ─────────────────────────────── */}
          {sideTab === 'overview' && queue && (
            <>
              <div className="svc-section">
                <h3>Actions</h3>
                <div className="svc-actions">
                  <button className="svc-btn primary" type="button" onClick={() => void loadQueue(selectedUrl)}>Refresh</button>
                  <ConfirmButton className="svc-btn danger" onConfirm={() => void handlePurge()}>Purge</ConfirmButton>
                  <ConfirmButton className="svc-btn danger" onConfirm={() => void handleDeleteQueue()}>Delete Queue</ConfirmButton>
                </div>
              </div>

              <div className="svc-section">
                <h3>Details</h3>
                <div className="svc-kv">
                  <div className="svc-kv-row"><div className="svc-kv-label">Queue Name</div><div className="svc-kv-value">{queue.queueName}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">URL</div><div className="svc-kv-value">{queue.queueUrl}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Type</div><div className="svc-kv-value">{queue.fifoQueue ? 'FIFO' : 'Standard'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Messages</div><div className="svc-kv-value">{queue.approximateMessageCount}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">In Flight</div><div className="svc-kv-value">{queue.approximateNotVisibleCount}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Delayed</div><div className="svc-kv-value">{queue.approximateDelayedCount}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Created</div><div className="svc-kv-value">{fmtTs(queue.createdTimestamp)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Last Modified</div><div className="svc-kv-value">{fmtTs(queue.lastModifiedTimestamp)}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Visibility Timeout</div><div className="svc-kv-value">{queue.visibilityTimeout}s</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Max Message Size</div><div className="svc-kv-value">{(queue.maximumMessageSize / 1024).toFixed(0)} KB</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Retention Period</div><div className="svc-kv-value">{Math.round(queue.messageRetentionPeriod / 86400)} days</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Delay Seconds</div><div className="svc-kv-value">{queue.delaySeconds}s</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Content Dedup</div><div className="svc-kv-value">{queue.contentBasedDeduplication ? 'Yes' : 'No'}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">KMS Key</div><div className="svc-kv-value">{queue.kmsMasterKeyId || 'Default'}</div></div>
                  {queue.deadLetterTargetArn && <div className="svc-kv-row"><div className="svc-kv-label">DLQ Target</div><div className="svc-kv-value">{queue.deadLetterTargetArn}</div></div>}
                  {queue.maxReceiveCount > 0 && <div className="svc-kv-row"><div className="svc-kv-label">Max Receive Count</div><div className="svc-kv-value">{queue.maxReceiveCount}</div></div>}
                </div>
              </div>

              <div className="svc-section">
                <h3>Edit Attributes</h3>
                <div className="svc-form">
                  <label><span>Visibility (s)</span><input value={editVisibility} onChange={(e) => setEditVisibility(e.target.value)} /></label>
                  <label><span>Retention (s)</span><input value={editRetention} onChange={(e) => setEditRetention(e.target.value)} /></label>
                  <label><span>Delay (s)</span><input value={editDelay} onChange={(e) => setEditDelay(e.target.value)} /></label>
                </div>
                <button type="button" className="svc-btn success" style={{ marginTop: 8 }} onClick={() => void handleSaveAttributes()}>Save Attributes</button>
              </div>

              {queue.redrivePolicy && (
                <div className="svc-section">
                  <h3>Redrive Policy</h3>
                  <pre className="svc-code">{queue.redrivePolicy}</pre>
                  <div className="svc-form" style={{ marginTop: 8 }}>
                    <label><span>Edit Redrive JSON</span><textarea value={editRedrive} onChange={(e) => setEditRedrive(e.target.value)} rows={3} /></label>
                  </div>
                  <button type="button" className="svc-btn primary" style={{ marginTop: 8 }} onClick={() => void handleSaveAttributes()}>Update Redrive</button>
                </div>
              )}
            </>
          )}

          {sideTab === 'overview' && !queue && (
            <div className="svc-empty">Select a queue to view details.</div>
          )}

          {/* ── Timeline ─────────────────────────────── */}
          {sideTab === 'timeline' && (
            <div className="svc-section">
              <h3>Timeline</h3>
              {!queue && <div className="svc-empty">Select a queue to view timeline.</div>}
              {queue && !timeline.length && <div className="svc-empty">No timeline events.</div>}
              {queue && timeline.length > 0 && (
                <div style={{ maxHeight: 'calc(100vh - 340px)', overflow: 'auto' }}>
                  <table className="svc-table">
                    <thead>
                      <tr><th>Time</th><th>Event</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {timeline.map((ev, i) => (
                        <tr key={i}>
                          <td>{fmtTs(ev.timestamp)}</td>
                          <td>
                            <span className={`svc-badge ${ev.severity === 'error' ? 'danger' : ev.severity === 'warning' ? 'warn' : 'ok'}`}>
                              {ev.title}
                            </span>
                          </td>
                          <td>{ev.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Messages ─────────────────────────────── */}
          {sideTab === 'messages' && (
            <>
              <div className="svc-section">
                <h3>Receive Messages</h3>
                <div className="svc-inline">
                  <label style={{ fontSize: 12, color: '#9ca7b7' }}>Max
                    <input type="number" value={receiveMax} onChange={(e) => setReceiveMax(Number(e.target.value))} min={1} max={10} style={{ width: 60, marginLeft: 4 }} />
                  </label>
                  <label style={{ fontSize: 12, color: '#9ca7b7' }}>Wait(s)
                    <input type="number" value={receiveWait} onChange={(e) => setReceiveWait(Number(e.target.value))} min={0} max={20} style={{ width: 60, marginLeft: 4 }} />
                  </label>
                  <button type="button" className="svc-btn primary" disabled={loading || !queue} onClick={() => void handleReceive()}>
                    {loading ? 'Polling...' : 'Receive'}
                  </button>
                </div>
              </div>

              <div className="svc-section">
                <h3>Messages ({receivedMsgs.length})</h3>
                {!receivedMsgs.length && <div className="svc-empty">Click Receive to poll the queue.</div>}
                {receivedMsgs.length > 0 && (
                  <div style={{ maxHeight: 'calc(100vh - 500px)', overflow: 'auto' }}>
                    <table className="svc-table">
                      <thead>
                        <tr><th>ID</th><th>Sent</th><th>#</th><th>Actions</th></tr>
                      </thead>
                      <tbody>
                        {receivedMsgs.map(m => (
                          <tr
                            key={m.messageId}
                            className={m.messageId === selectedMsgId ? 'active' : ''}
                            onClick={() => setSelectedMsgId(m.messageId)}
                          >
                            <td>{m.messageId.slice(0, 12)}..</td>
                            <td>{fmtTs(m.sentTimestamp)}</td>
                            <td>{m.approximateReceiveCount}</td>
                            <td>
                              <div className="svc-inline" style={{ gap: 4 }}>
                                <ConfirmButton className="svc-btn danger" onConfirm={() => void handleDeleteMsg(m.receiptHandle)}>Del</ConfirmButton>
                                <button type="button" className="svc-btn primary" onClick={(e) => { e.stopPropagation(); void handleChangeVisibility(m.receiptHandle) }}>Ext</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {selectedMsg && (
                <div className="svc-section">
                  <h3>Message Detail</h3>
                  <div className="svc-kv">
                    <div className="svc-kv-row"><div className="svc-kv-label">Message ID</div><div className="svc-kv-value">{selectedMsg.messageId}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Sent</div><div className="svc-kv-value">{fmtTs(selectedMsg.sentTimestamp)}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">Receive Count</div><div className="svc-kv-value">{selectedMsg.approximateReceiveCount}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">First Received</div><div className="svc-kv-value">{fmtTs(selectedMsg.approximateFirstReceiveTimestamp)}</div></div>
                    <div className="svc-kv-row"><div className="svc-kv-label">MD5</div><div className="svc-kv-value">{selectedMsg.md5OfBody}</div></div>
                  </div>
                  <pre className="svc-code" style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>{selectedMsg.body}</pre>
                  <div className="svc-inline" style={{ marginTop: 8 }}>
                    <label style={{ fontSize: 12, color: '#9ca7b7' }}>Visibility Extension (s)
                      <input type="number" value={visibilityTimeout} onChange={(e) => setVisibilityTimeout(Number(e.target.value))} style={{ width: 80, marginLeft: 4 }} />
                    </label>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Send ─────────────────────────────────── */}
          {sideTab === 'send' && (
            <div className="svc-section">
              <h3>Send Message</h3>
              {!queue && <div className="svc-empty">Select a queue first.</div>}
              {queue && (
                <>
                  <div className="svc-form">
                    <label><span>Message Body</span>
                      <textarea value={sendBody} onChange={(e) => setSendBody(e.target.value)} placeholder="Message body (plain text or JSON)..." rows={8} />
                    </label>
                    <label><span>Delay (s)</span>
                      <input type="number" value={sendDelay} onChange={(e) => setSendDelay(Number(e.target.value))} min={0} max={900} />
                    </label>
                    {queue.fifoQueue && (
                      <>
                        <label><span>Group ID</span><input value={sendGroupId} onChange={(e) => setSendGroupId(e.target.value)} placeholder="group" /></label>
                        <label><span>Dedup ID</span><input value={sendDedupId} onChange={(e) => setSendDedupId(e.target.value)} placeholder="dedup" /></label>
                      </>
                    )}
                  </div>
                  <button type="button" className="svc-btn success" style={{ marginTop: 8 }} disabled={!sendBody.trim()} onClick={() => void handleSend()}>Send Message</button>

                  {sendResult && (
                    <div style={{ marginTop: 12 }}>
                      <h3>Sent</h3>
                      <div className="svc-kv">
                        <div className="svc-kv-row"><div className="svc-kv-label">Message ID</div><div className="svc-kv-value">{sendResult.messageId}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">MD5</div><div className="svc-kv-value">{sendResult.md5OfBody}</div></div>
                        {sendResult.sequenceNumber && <div className="svc-kv-row"><div className="svc-kv-label">Sequence</div><div className="svc-kv-value">{sendResult.sequenceNumber}</div></div>}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Tags ─────────────────────────────────── */}
          {sideTab === 'tags' && (
            <div className="svc-section">
              <h3>Tags</h3>
              {!queue && <div className="svc-empty">Select a queue first.</div>}
              {queue && (
                <>
                  <div className="svc-inline" style={{ marginBottom: 10 }}>
                    <input placeholder="Key" value={newTagKey} onChange={(e) => setNewTagKey(e.target.value)} />
                    <input placeholder="Value" value={newTagValue} onChange={(e) => setNewTagValue(e.target.value)} />
                    <button type="button" className="svc-btn success" disabled={!newTagKey.trim()} onClick={() => void handleAddTag()}>Add Tag</button>
                  </div>
                  {Object.keys(queue.tags).length > 0 ? (
                    <table className="svc-table">
                      <thead><tr><th>Key</th><th>Value</th><th>Action</th></tr></thead>
                      <tbody>
                        {Object.entries(queue.tags).map(([k, v]) => (
                          <tr key={k}>
                            <td>{k}</td>
                            <td>{v}</td>
                            <td><ConfirmButton className="svc-btn danger" onConfirm={() => void handleRemoveTag(k)}>Remove</ConfirmButton></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="svc-empty">No tags.</div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Policy ───────────────────────────────── */}
          {sideTab === 'policy' && (
            <div className="svc-section">
              <h3>Queue Policy</h3>
              {!queue && <div className="svc-empty">Select a queue first.</div>}
              {queue && (
                <>
                  {queue.policy
                    ? <pre className="svc-code" style={{ maxHeight: 300, overflow: 'auto' }}>{queue.policy}</pre>
                    : <div className="svc-empty">No queue policy configured.</div>
                  }
                  {queue.redriveAllowPolicy && (
                    <>
                      <h3 style={{ marginTop: 16 }}>Redrive Allow Policy</h3>
                      <pre className="svc-code" style={{ maxHeight: 200, overflow: 'auto' }}>{queue.redriveAllowPolicy}</pre>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
