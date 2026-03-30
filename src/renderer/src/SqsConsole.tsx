import { useEffect, useMemo, useState } from 'react'

import './sqs.css'

import {
  createSqsQueue,
  deleteSqsQueue,
  getSqsQueue,
  listSqsQueues,
  purgeSqsQueue,
  setSqsAttributes,
  sqsSendMessage,
  sqsReceiveMessages,
  sqsDeleteMessage,
  sqsChangeVisibility,
  tagSqsQueue,
  untagSqsQueue,
  sqsTimeline
} from './api'
import type {
  AwsConnection,
  SqsMessage,
  SqsQueueSummary,
  SqsSendResult,
  SqsTimelineEvent
} from '@shared/types'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'queueName' | 'type' | 'messages' | 'inFlight' | 'delayed' | 'visibility' | 'retention'
type SideTab = 'overview' | 'timeline' | 'messages' | 'send' | 'tags' | 'policy'

const COLUMNS: { key: ColKey; label: string }[] = [
  { key: 'queueName', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'messages', label: 'Messages' },
  { key: 'inFlight', label: 'In Flight' },
  { key: 'delayed', label: 'Delayed' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'retention', label: 'Retention' }
]

function getColVal(queue: SqsQueueSummary, key: ColKey): string {
  switch (key) {
    case 'queueName':
      return queue.queueName
    case 'type':
      return queue.fifoQueue ? 'FIFO' : 'Standard'
    case 'messages':
      return String(queue.approximateMessageCount)
    case 'inFlight':
      return String(queue.approximateNotVisibleCount)
    case 'delayed':
      return String(queue.approximateDelayedCount)
    case 'visibility':
      return `${queue.visibilityTimeout}s`
    case 'retention':
      return `${Math.round(queue.messageRetentionPeriod / 86400)}d`
  }
}

function fmtTs(value: string): string {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function formatCount(value: number): string {
  return Intl.NumberFormat().format(value)
}

function formatDays(seconds: number): string {
  return `${Math.round(seconds / 86400)}d`
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}

function queueHealthLabel(queue: SqsQueueSummary | null): { tone: 'info' | 'success' | 'warning'; label: string; detail: string } {
  if (!queue) {
    return { tone: 'info', label: 'Awaiting selection', detail: 'Pick a queue to inspect attributes and traffic.' }
  }
  if (queue.approximateDelayedCount > 0) {
    return { tone: 'warning', label: 'Delayed backlog', detail: `${formatCount(queue.approximateDelayedCount)} delayed messages need attention.` }
  }
  if (queue.approximateNotVisibleCount > 0) {
    return { tone: 'info', label: 'Consumers active', detail: `${formatCount(queue.approximateNotVisibleCount)} messages currently in flight.` }
  }
  return { tone: 'success', label: 'Ready', detail: 'No delayed backlog and no active delivery contention.' }
}

export function SqsConsole({ connection }: { connection: AwsConnection }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const [queues, setQueues] = useState<SqsQueueSummary[]>([])
  const [selectedUrl, setSelectedUrl] = useState('')
  const [queue, setQueue] = useState<SqsQueueSummary | null>(null)
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [timeline, setTimeline] = useState<SqsTimelineEvent[]>([])

  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))

  const [newQueueName, setNewQueueName] = useState('')
  const [newQueueFifo, setNewQueueFifo] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const [editVisibility, setEditVisibility] = useState('')
  const [editRetention, setEditRetention] = useState('')
  const [editDelay, setEditDelay] = useState('')
  const [editRedrive, setEditRedrive] = useState('')

  const [receivedMsgs, setReceivedMsgs] = useState<SqsMessage[]>([])
  const [receiveMax, setReceiveMax] = useState(5)
  const [receiveWait, setReceiveWait] = useState(0)
  const [selectedMsgId, setSelectedMsgId] = useState('')
  const [visibilityTimeout, setVisibilityTimeout] = useState(30)

  const [sendBody, setSendBody] = useState('')
  const [sendDelay, setSendDelay] = useState(0)
  const [sendGroupId, setSendGroupId] = useState('')
  const [sendDedupId, setSendDedupId] = useState('')
  const [sendResult, setSendResult] = useState<SqsSendResult | null>(null)

  const [newTagKey, setNewTagKey] = useState('')
  const [newTagValue, setNewTagValue] = useState('')

  const selectedMsg = useMemo(
    () => receivedMsgs.find((message) => message.messageId === selectedMsgId) ?? null,
    [receivedMsgs, selectedMsgId]
  )

  const filteredQueues = useMemo(() => {
    if (!filter) return queues
    const query = filter.toLowerCase()
    const activeColumns = Array.from(visCols)
    return queues.filter((item) =>
      activeColumns.some((column) => getColVal(item, column).toLowerCase().includes(query))
    )
  }, [filter, queues, visCols])

  const shellStats = useMemo(() => {
    const totalMessages = queues.reduce((sum, item) => sum + item.approximateMessageCount, 0)
    const totalInFlight = queues.reduce((sum, item) => sum + item.approximateNotVisibleCount, 0)
    const totalDelayed = queues.reduce((sum, item) => sum + item.approximateDelayedCount, 0)
    const fifoCount = queues.filter((item) => item.fifoQueue).length
    return { totalMessages, totalInFlight, totalDelayed, fifoCount }
  }, [queues])

  const activeHealth = queueHealthLabel(queue)

  async function loadQueues(selectUrl?: string) {
    setLoading(true)
    setError('')
    try {
      const list = await listSqsQueues(connection)
      setQueues(list)
      const url = selectUrl ?? selectedUrl ?? list[0]?.queueUrl ?? ''
      if (url) {
        setSelectedUrl(url)
        await loadQueue(url)
      } else {
        setSelectedUrl('')
        setQueue(null)
        setTimeline([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function loadQueue(url: string) {
    try {
      const [detail, nextTimeline] = await Promise.all([getSqsQueue(connection, url), sqsTimeline(connection, url)])
      setQueue(detail)
      setTimeline(nextTimeline)
      setEditVisibility(String(detail.visibilityTimeout))
      setEditRetention(String(detail.messageRetentionPeriod))
      setEditDelay(String(detail.delaySeconds))
      setEditRedrive(detail.redrivePolicy)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function selectQueue(url: string) {
    setSelectedUrl(url)
    setReceivedMsgs([])
    setSelectedMsgId('')
    setSendResult(null)
    await loadQueue(url)
  }

  useEffect(() => {
    void loadQueues()
  }, [connection.sessionId, connection.region])

  async function handleCreateQueue() {
    const trimmedName = newQueueName.trim()
    if (!trimmedName) return
    setError('')
    try {
      const url = await createSqsQueue(connection, trimmedName, newQueueFifo)
      setNewQueueName('')
      setNewQueueFifo(false)
      setShowCreate(false)
      setMsg(`Queue "${trimmedName}" created`)
      await loadQueues(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDeleteQueue() {
    if (!selectedUrl) return
    try {
      await deleteSqsQueue(connection, selectedUrl)
      setMsg('Queue deleted')
      setQueue(null)
      setTimeline([])
      setReceivedMsgs([])
      setSelectedMsgId('')
      setSendResult(null)
      await loadQueues()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handlePurge() {
    if (!selectedUrl) return
    try {
      await purgeSqsQueue(connection, selectedUrl)
      setMsg('Queue purged')
      await loadQueue(selectedUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSaveAttributes() {
    if (!selectedUrl) return
    const attrs: Record<string, string> = {}
    if (editVisibility) attrs.VisibilityTimeout = editVisibility
    if (editRetention) attrs.MessageRetentionPeriod = editRetention
    if (editDelay) attrs.DelaySeconds = editDelay
    if (editRedrive) attrs.RedrivePolicy = editRedrive
    try {
      await setSqsAttributes(connection, selectedUrl, attrs)
      setMsg('Attributes saved')
      await loadQueue(selectedUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleReceive() {
    if (!selectedUrl) return
    setLoading(true)
    try {
      setReceivedMsgs(await sqsReceiveMessages(connection, selectedUrl, receiveMax, receiveWait))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleDeleteMsg(handle: string) {
    if (!selectedUrl) return
    try {
      await sqsDeleteMessage(connection, selectedUrl, handle)
      setReceivedMsgs((current) => current.filter((message) => message.receiptHandle !== handle))
      setMsg('Message deleted')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleChangeVisibility(handle: string) {
    if (!selectedUrl) return
    try {
      await sqsChangeVisibility(connection, selectedUrl, handle, visibilityTimeout)
      setMsg('Visibility extended')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSend() {
    if (!selectedUrl || !sendBody.trim()) return
    try {
      const result = await sqsSendMessage(
        connection,
        selectedUrl,
        sendBody,
        sendDelay || undefined,
        sendGroupId || undefined,
        sendDedupId || undefined
      )
      setSendResult(result)
      setSendBody('')
      setMsg('Message sent')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleAddTag() {
    if (!selectedUrl || !newTagKey.trim()) return
    try {
      await tagSqsQueue(connection, selectedUrl, { [newTagKey.trim()]: newTagValue })
      await loadQueue(selectedUrl)
      setNewTagKey('')
      setNewTagValue('')
      setMsg('Tag added')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemoveTag(key: string) {
    if (!selectedUrl) return
    try {
      await untagSqsQueue(connection, selectedUrl, [key])
      await loadQueue(selectedUrl)
      setMsg(`Tag "${key}" removed`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function toggleCol(key: ColKey) {
    setVisCols((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="sqs-console">
      <section className="sqs-shell-hero">
        <div className="sqs-shell-hero-copy">
          <div className="eyebrow">Queue operations</div>
          <h2>SQS workspace</h2>
          <p>
            Inspect backlog, edit queue attributes, review timeline activity, and move messages
            through the same operator-first layout used by Terraform.
          </p>
          <div className="sqs-shell-meta-strip">
            <div className="sqs-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.label}</strong>
            </div>
            <div className="sqs-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="sqs-shell-meta-pill">
              <span>Mode</span>
              <strong>{connection.kind === 'assumed-role' ? 'Assumed role' : 'Profile session'}</strong>
            </div>
          </div>
        </div>
        <div className="sqs-shell-hero-stats">
          <div className="sqs-shell-stat-card sqs-shell-stat-card-accent">
            <span>Queues</span>
            <strong>{formatCount(queues.length)}</strong>
            <small>{formatCount(shellStats.fifoCount)} FIFO queues in this region.</small>
          </div>
          <div className="sqs-shell-stat-card">
            <span>Visible backlog</span>
            <strong>{formatCount(shellStats.totalMessages)}</strong>
            <small>Approximate messages ready for consumers.</small>
          </div>
          <div className="sqs-shell-stat-card">
            <span>In flight</span>
            <strong>{formatCount(shellStats.totalInFlight)}</strong>
            <small>Messages currently hidden from other consumers.</small>
          </div>
          <div className="sqs-shell-stat-card">
            <span>Delayed</span>
            <strong>{formatCount(shellStats.totalDelayed)}</strong>
            <small>Messages staged behind queue-level or message-level delay.</small>
          </div>
        </div>
      </section>

      <div className="sqs-shell-toolbar">
        <div className="sqs-toolbar">
          <button
            type="button"
            className={`sqs-toolbar-btn ${showCreate ? '' : 'accent'}`}
            onClick={() => setShowCreate((current) => !current)}
          >
            {showCreate ? 'Close create panel' : 'Create queue'}
          </button>
          <button type="button" className="sqs-toolbar-btn" onClick={() => void loadQueues()}>
            Refresh inventory
          </button>
        </div>
        <div className="sqs-shell-status">
          <div className="sqs-freshness-card">
            <span>Selection</span>
            <strong>{queue?.queueName ?? 'No queue selected'}</strong>
          </div>
          <div className={`sqs-freshness-pill ${loading ? 'loading' : 'ready'}`}>
            {loading ? 'Syncing' : 'Live'}
          </div>
        </div>
      </div>

      {msg && <div className="sqs-msg">{msg}</div>}
      {error && <div className="sqs-msg error">{error}</div>}

      {showCreate && (
        <section className="sqs-section">
          <div className="sqs-pane-head">
            <div>
              <span className="sqs-pane-kicker">Provisioning</span>
              <h3>Create queue</h3>
            </div>
            <span className="sqs-pane-summary">Same service behavior, updated shell</span>
          </div>
          <div className="sqs-form-grid">
            <label className="sqs-field">
              <span>Queue name</span>
              <input value={newQueueName} onChange={(event) => setNewQueueName(event.target.value)} placeholder="my-queue" />
            </label>
            <label className="sqs-field sqs-field-checkbox">
              <input type="checkbox" checked={newQueueFifo} onChange={(event) => setNewQueueFifo(event.target.checked)} />
              <span>FIFO queue</span>
            </label>
          </div>
          <div className="sqs-section-actions">
            <button
              type="button"
              className="sqs-toolbar-btn accent"
              disabled={!newQueueName.trim()}
              onClick={() => void handleCreateQueue()}
            >
              Create queue
            </button>
          </div>
        </section>
      )}

      <div className="sqs-main-layout">
        <div className="sqs-queue-table-area">
          <div className="sqs-pane-head">
            <div>
              <span className="sqs-pane-kicker">Tracked queues</span>
              <h3>Queue inventory</h3>
            </div>
            <span className="sqs-pane-summary">{filteredQueues.length} shown</span>
          </div>

          <input
            className="sqs-search"
            placeholder="Filter queues across enabled scan fields..."
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />

          <div className="sqs-filter-strip">
            {COLUMNS.map((column) => (
              <button
                key={column.key}
                type="button"
                className={`sqs-filter-pill ${visCols.has(column.key) ? 'active' : ''}`}
                onClick={() => toggleCol(column.key)}
              >
                {column.label}
              </button>
            ))}
          </div>

          {loading && queues.length === 0 ? (
            <div className="sqs-empty">Loading queues...</div>
          ) : filteredQueues.length === 0 ? (
            <div className="sqs-empty">No queues matched the current filter.</div>
          ) : (
            <div className="sqs-queue-list">
              {filteredQueues.map((item) => (
                <button
                  key={item.queueUrl}
                  type="button"
                  className={`sqs-queue-row ${item.queueUrl === selectedUrl ? 'active' : ''}`}
                  onClick={() => void selectQueue(item.queueUrl)}
                >
                  <div className="sqs-queue-row-top">
                    <div className="sqs-queue-row-copy">
                      <strong>{item.queueName}</strong>
                      <span title={item.queueUrl}>{item.queueUrl}</span>
                    </div>
                    <span className={`sqs-status-badge ${item.fifoQueue ? 'info' : 'success'}`}>
                      {item.fifoQueue ? 'FIFO' : 'Standard'}
                    </span>
                  </div>
                  <div className="sqs-queue-row-meta">
                    <span>{item.fifoQueue ? 'Ordered delivery' : 'At-least-once delivery'}</span>
                    <span>{getColVal(item, 'visibility')} visibility</span>
                    <span>{getColVal(item, 'retention')} retention</span>
                  </div>
                  <div className="sqs-queue-row-metrics">
                    <div>
                      <span>Messages</span>
                      <strong>{formatCount(item.approximateMessageCount)}</strong>
                    </div>
                    <div>
                      <span>In flight</span>
                      <strong>{formatCount(item.approximateNotVisibleCount)}</strong>
                    </div>
                    <div>
                      <span>Delayed</span>
                      <strong>{formatCount(item.approximateDelayedCount)}</strong>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="sqs-detail-pane">
          {!queue ? (
            <div className="sqs-empty sqs-empty-panel">Select a queue to inspect details, timeline, and messages.</div>
          ) : (
            <>
              <section className="sqs-detail-hero">
                <div className="sqs-detail-hero-copy">
                  <div className="eyebrow">Queue posture</div>
                  <h3>{queue.queueName}</h3>
                  <p>{queue.queueUrl}</p>
                  <div className="sqs-detail-meta-strip">
                    <div className="sqs-detail-meta-pill">
                      <span>Type</span>
                      <strong>{queue.fifoQueue ? 'FIFO' : 'Standard'}</strong>
                    </div>
                    <div className="sqs-detail-meta-pill">
                      <span>Visibility</span>
                      <strong>{queue.visibilityTimeout}s</strong>
                    </div>
                    <div className="sqs-detail-meta-pill">
                      <span>Retention</span>
                      <strong>{formatDays(queue.messageRetentionPeriod)}</strong>
                    </div>
                    <div className="sqs-detail-meta-pill">
                      <span>KMS</span>
                      <strong>{queue.kmsMasterKeyId || 'Default'}</strong>
                    </div>
                  </div>
                </div>
                <div className="sqs-detail-hero-stats">
                  <div className={`sqs-detail-stat-card ${activeHealth.tone}`}>
                    <span>Queue state</span>
                    <strong>{activeHealth.label}</strong>
                    <small>{activeHealth.detail}</small>
                  </div>
                  <div className="sqs-detail-stat-card">
                    <span>Messages</span>
                    <strong>{formatCount(queue.approximateMessageCount)}</strong>
                    <small>Approximate visible backlog.</small>
                  </div>
                  <div className="sqs-detail-stat-card">
                    <span>In flight</span>
                    <strong>{formatCount(queue.approximateNotVisibleCount)}</strong>
                    <small>Messages currently held by consumers.</small>
                  </div>
                  <div className="sqs-detail-stat-card">
                    <span>Max size</span>
                    <strong>{formatKb(queue.maximumMessageSize)}</strong>
                    <small>{queue.delaySeconds}s queue-level delay.</small>
                  </div>
                </div>
              </section>

              <div className="sqs-detail-tabs">
                {(['overview', 'timeline', 'messages', 'send', 'tags', 'policy'] as SideTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={sideTab === tab ? 'active' : ''}
                    onClick={() => setSideTab(tab)}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {sideTab === 'overview' && (
                <>
                  <section className="sqs-section">
                    <div className="sqs-pane-head">
                      <div>
                        <span className="sqs-pane-kicker">Actions</span>
                        <h3>Queue operations</h3>
                      </div>
                    </div>
                    <div className="sqs-section-actions">
                      <button type="button" className="sqs-toolbar-btn" onClick={() => void loadQueue(selectedUrl)}>
                        Refresh queue
                      </button>
                      <ConfirmButton className="sqs-toolbar-btn danger" onConfirm={() => void handlePurge()}>
                        Purge
                      </ConfirmButton>
                      <ConfirmButton className="sqs-toolbar-btn danger" onConfirm={() => void handleDeleteQueue()}>
                        Delete queue
                      </ConfirmButton>
                    </div>
                  </section>

                  <section className="sqs-section">
                    <div className="sqs-pane-head">
                      <div>
                        <span className="sqs-pane-kicker">Details</span>
                        <h3>Queue metadata</h3>
                      </div>
                    </div>
                    <div className="sqs-kv">
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Queue name</div><div className="sqs-kv-value">{queue.queueName}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">URL</div><div className="sqs-kv-value">{queue.queueUrl}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Type</div><div className="sqs-kv-value">{queue.fifoQueue ? 'FIFO' : 'Standard'}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Created</div><div className="sqs-kv-value">{fmtTs(queue.createdTimestamp)}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Last modified</div><div className="sqs-kv-value">{fmtTs(queue.lastModifiedTimestamp)}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Visibility timeout</div><div className="sqs-kv-value">{queue.visibilityTimeout}s</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Retention period</div><div className="sqs-kv-value">{formatDays(queue.messageRetentionPeriod)}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Delay seconds</div><div className="sqs-kv-value">{queue.delaySeconds}s</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Content deduplication</div><div className="sqs-kv-value">{queue.contentBasedDeduplication ? 'Enabled' : 'Disabled'}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">KMS key</div><div className="sqs-kv-value">{queue.kmsMasterKeyId || 'Default'}</div></div>
                      {queue.deadLetterTargetArn && (
                        <div className="sqs-kv-row"><div className="sqs-kv-label">DLQ target</div><div className="sqs-kv-value">{queue.deadLetterTargetArn}</div></div>
                      )}
                      {queue.maxReceiveCount > 0 && (
                        <div className="sqs-kv-row"><div className="sqs-kv-label">Max receive count</div><div className="sqs-kv-value">{queue.maxReceiveCount}</div></div>
                      )}
                    </div>
                  </section>

                  <section className="sqs-section">
                    <div className="sqs-pane-head">
                      <div>
                        <span className="sqs-pane-kicker">Configuration</span>
                        <h3>Edit attributes</h3>
                      </div>
                    </div>
                    <div className="sqs-form-grid">
                      <label className="sqs-field">
                        <span>Visibility timeout (s)</span>
                        <input value={editVisibility} onChange={(event) => setEditVisibility(event.target.value)} />
                      </label>
                      <label className="sqs-field">
                        <span>Retention period (s)</span>
                        <input value={editRetention} onChange={(event) => setEditRetention(event.target.value)} />
                      </label>
                      <label className="sqs-field">
                        <span>Delay seconds</span>
                        <input value={editDelay} onChange={(event) => setEditDelay(event.target.value)} />
                      </label>
                    </div>
                    <div className="sqs-section-actions">
                      <button type="button" className="sqs-toolbar-btn accent" onClick={() => void handleSaveAttributes()}>
                        Save attributes
                      </button>
                    </div>
                  </section>

                  {queue.redrivePolicy && (
                    <section className="sqs-section">
                      <div className="sqs-pane-head">
                        <div>
                          <span className="sqs-pane-kicker">Recovery</span>
                          <h3>Redrive policy</h3>
                        </div>
                      </div>
                      <pre className="sqs-code">{queue.redrivePolicy}</pre>
                      <label className="sqs-field">
                        <span>Edit redrive JSON</span>
                        <textarea value={editRedrive} onChange={(event) => setEditRedrive(event.target.value)} rows={4} />
                      </label>
                      <div className="sqs-section-actions">
                        <button type="button" className="sqs-toolbar-btn" onClick={() => void handleSaveAttributes()}>
                          Update redrive
                        </button>
                      </div>
                    </section>
                  )}
                </>
              )}

              {sideTab === 'timeline' && (
                <section className="sqs-section">
                  <div className="sqs-pane-head">
                    <div>
                      <span className="sqs-pane-kicker">Activity</span>
                      <h3>Timeline</h3>
                    </div>
                    <span className="sqs-pane-summary">{timeline.length} events</span>
                  </div>
                  {!timeline.length ? (
                    <div className="sqs-empty">No timeline events recorded for this queue.</div>
                  ) : (
                    <div className="sqs-table-wrap">
                      <table className="sqs-table">
                        <thead>
                          <tr><th>Time</th><th>Event</th><th>Detail</th></tr>
                        </thead>
                        <tbody>
                          {timeline.map((event, index) => (
                            <tr key={`${event.timestamp}:${event.title}:${index}`}>
                              <td>{fmtTs(event.timestamp)}</td>
                              <td>
                                <span className={`sqs-status-badge ${event.severity === 'error' ? 'danger' : event.severity === 'warning' ? 'warning' : 'success'}`}>
                                  {event.title}
                                </span>
                              </td>
                              <td>{event.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}

              {sideTab === 'messages' && (
                <>
                  <section className="sqs-section">
                    <div className="sqs-pane-head">
                      <div>
                        <span className="sqs-pane-kicker">Consumers</span>
                        <h3>Receive messages</h3>
                      </div>
                    </div>
                    <div className="sqs-inline-controls">
                      <label className="sqs-mini-field">
                        <span>Max</span>
                        <input type="number" value={receiveMax} onChange={(event) => setReceiveMax(Number(event.target.value))} min={1} max={10} />
                      </label>
                      <label className="sqs-mini-field">
                        <span>Wait (s)</span>
                        <input type="number" value={receiveWait} onChange={(event) => setReceiveWait(Number(event.target.value))} min={0} max={20} />
                      </label>
                      <button type="button" className="sqs-toolbar-btn accent" disabled={loading} onClick={() => void handleReceive()}>
                        {loading ? 'Polling...' : 'Receive'}
                      </button>
                    </div>
                  </section>

                  <section className="sqs-section">
                    <div className="sqs-pane-head">
                      <div>
                        <span className="sqs-pane-kicker">Payloads</span>
                        <h3>Messages</h3>
                      </div>
                      <span className="sqs-pane-summary">{receivedMsgs.length} loaded</span>
                    </div>
                    {!receivedMsgs.length ? (
                      <div className="sqs-empty">Run receive to poll the queue.</div>
                    ) : (
                      <div className="sqs-message-list">
                        {receivedMsgs.map((message) => (
                          <button
                            key={message.messageId}
                            type="button"
                            className={`sqs-message-row ${message.messageId === selectedMsgId ? 'active' : ''}`}
                            onClick={() => setSelectedMsgId(message.messageId)}
                          >
                            <div className="sqs-message-row-main">
                              <strong>{message.messageId}</strong>
                              <span>{fmtTs(message.sentTimestamp)}</span>
                            </div>
                            <div className="sqs-message-row-meta">
                              <span>Receive #{message.approximateReceiveCount}</span>
                              <span>{message.body.slice(0, 120) || 'Empty body'}</span>
                            </div>
                            <div className="sqs-message-row-actions">
                              <ConfirmButton className="sqs-toolbar-btn danger" onConfirm={() => void handleDeleteMsg(message.receiptHandle)}>
                                Delete
                              </ConfirmButton>
                              <button
                                type="button"
                                className="sqs-toolbar-btn"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleChangeVisibility(message.receiptHandle)
                                }}
                              >
                                Extend visibility
                              </button>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>

                  {selectedMsg && (
                    <section className="sqs-section">
                      <div className="sqs-pane-head">
                        <div>
                          <span className="sqs-pane-kicker">Inspect</span>
                          <h3>Message detail</h3>
                        </div>
                      </div>
                      <div className="sqs-kv">
                        <div className="sqs-kv-row"><div className="sqs-kv-label">Message ID</div><div className="sqs-kv-value">{selectedMsg.messageId}</div></div>
                        <div className="sqs-kv-row"><div className="sqs-kv-label">Sent</div><div className="sqs-kv-value">{fmtTs(selectedMsg.sentTimestamp)}</div></div>
                        <div className="sqs-kv-row"><div className="sqs-kv-label">Receive count</div><div className="sqs-kv-value">{selectedMsg.approximateReceiveCount}</div></div>
                        <div className="sqs-kv-row"><div className="sqs-kv-label">First received</div><div className="sqs-kv-value">{fmtTs(selectedMsg.approximateFirstReceiveTimestamp)}</div></div>
                        <div className="sqs-kv-row"><div className="sqs-kv-label">MD5</div><div className="sqs-kv-value">{selectedMsg.md5OfBody}</div></div>
                      </div>
                      <pre className="sqs-code">{selectedMsg.body}</pre>
                      <label className="sqs-mini-field">
                        <span>Visibility extension (s)</span>
                        <input type="number" value={visibilityTimeout} onChange={(event) => setVisibilityTimeout(Number(event.target.value))} />
                      </label>
                    </section>
                  )}
                </>
              )}

              {sideTab === 'send' && (
                <section className="sqs-section">
                  <div className="sqs-pane-head">
                    <div>
                      <span className="sqs-pane-kicker">Producers</span>
                      <h3>Send message</h3>
                    </div>
                  </div>
                  <div className="sqs-form-grid">
                    <label className="sqs-field sqs-field-full">
                      <span>Message body</span>
                      <textarea
                        value={sendBody}
                        onChange={(event) => setSendBody(event.target.value)}
                        placeholder="Plain text or JSON payload"
                        rows={10}
                      />
                    </label>
                    <label className="sqs-field">
                      <span>Delay (s)</span>
                      <input type="number" value={sendDelay} onChange={(event) => setSendDelay(Number(event.target.value))} min={0} max={900} />
                    </label>
                    {queue.fifoQueue && (
                      <>
                        <label className="sqs-field">
                          <span>Group ID</span>
                          <input value={sendGroupId} onChange={(event) => setSendGroupId(event.target.value)} placeholder="group" />
                        </label>
                        <label className="sqs-field">
                          <span>Dedup ID</span>
                          <input value={sendDedupId} onChange={(event) => setSendDedupId(event.target.value)} placeholder="dedup" />
                        </label>
                      </>
                    )}
                  </div>
                  <div className="sqs-section-actions">
                    <button
                      type="button"
                      className="sqs-toolbar-btn accent"
                      disabled={!sendBody.trim()}
                      onClick={() => void handleSend()}
                    >
                      Send message
                    </button>
                  </div>

                  {sendResult && (
                    <div className="sqs-kv">
                      <div className="sqs-kv-row"><div className="sqs-kv-label">Message ID</div><div className="sqs-kv-value">{sendResult.messageId}</div></div>
                      <div className="sqs-kv-row"><div className="sqs-kv-label">MD5</div><div className="sqs-kv-value">{sendResult.md5OfBody}</div></div>
                      {sendResult.sequenceNumber && (
                        <div className="sqs-kv-row"><div className="sqs-kv-label">Sequence</div><div className="sqs-kv-value">{sendResult.sequenceNumber}</div></div>
                      )}
                    </div>
                  )}
                </section>
              )}

              {sideTab === 'tags' && (
                <section className="sqs-section">
                  <div className="sqs-pane-head">
                    <div>
                      <span className="sqs-pane-kicker">Metadata</span>
                      <h3>Tags</h3>
                    </div>
                    <span className="sqs-pane-summary">{Object.keys(queue.tags).length} total</span>
                  </div>
                  <div className="sqs-inline-controls">
                    <input placeholder="Key" value={newTagKey} onChange={(event) => setNewTagKey(event.target.value)} />
                    <input placeholder="Value" value={newTagValue} onChange={(event) => setNewTagValue(event.target.value)} />
                    <button type="button" className="sqs-toolbar-btn accent" disabled={!newTagKey.trim()} onClick={() => void handleAddTag()}>
                      Add tag
                    </button>
                  </div>

                  {!Object.keys(queue.tags).length ? (
                    <div className="sqs-empty">No tags defined for this queue.</div>
                  ) : (
                    <div className="sqs-table-wrap">
                      <table className="sqs-table">
                        <thead><tr><th>Key</th><th>Value</th><th>Action</th></tr></thead>
                        <tbody>
                          {Object.entries(queue.tags).map(([key, value]) => (
                            <tr key={key}>
                              <td>{key}</td>
                              <td>{value}</td>
                              <td>
                                <ConfirmButton className="sqs-toolbar-btn danger" onConfirm={() => void handleRemoveTag(key)}>
                                  Remove
                                </ConfirmButton>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}

              {sideTab === 'policy' && (
                <section className="sqs-section">
                  <div className="sqs-pane-head">
                    <div>
                      <span className="sqs-pane-kicker">Policy</span>
                      <h3>Queue policy</h3>
                    </div>
                  </div>
                  {queue.policy ? <pre className="sqs-code">{queue.policy}</pre> : <div className="sqs-empty">No queue policy configured.</div>}
                  {queue.redriveAllowPolicy && (
                    <>
                      <div className="sqs-pane-head sqs-subhead">
                        <div>
                          <span className="sqs-pane-kicker">Recovery</span>
                          <h3>Redrive allow policy</h3>
                        </div>
                      </div>
                      <pre className="sqs-code">{queue.redriveAllowPolicy}</pre>
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
