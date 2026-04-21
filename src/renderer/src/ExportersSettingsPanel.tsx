import { useEffect, useRef, useState } from 'react'
import type {
  ExporterAuthKind,
  ExporterConfig,
  ExporterHealthSnapshot,
  ExporterRedactionMode
} from '@shared/types'

type Props = {
  isVisible: boolean
}

const DEFAULT_CONFIG: ExporterConfig = {
  prometheus: {
    enabled: false,
    port: 9091,
    host: '127.0.0.1',
    metricsPath: '/metrics',
    teamLabel: '',
    projectLabel: ''
  },
  elasticsearch: {
    enabled: false,
    url: 'http://localhost:9200',
    indexPrefix: 'infralens',
    authKind: 'none',
    username: '',
    password: '',
    bearerToken: '',
    apiKey: '',
    tlsSkipVerify: false,
    teamLabel: '',
    projectLabel: ''
  },
  redactionMode: 'partial',
  retentionHours: 72,
  updatedAt: ''
}

const AUTH_KIND_OPTIONS: Array<{ value: ExporterAuthKind; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'basic', label: 'Basic (username / password)' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'api-key', label: 'API key' }
]

const REDACTION_OPTIONS: Array<{ value: ExporterRedactionMode; label: string; description: string }> = [
  { value: 'partial', label: 'Partial', description: 'Redact secret-named fields; keep identifiers' },
  { value: 'full', label: 'Full', description: 'Redact secret fields and mask account identifiers' },
  { value: 'none', label: 'None', description: 'Export all fields as-is (not recommended)' }
]

const RETENTION_OPTIONS = [
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' },
  { value: 72, label: '72 hours' },
  { value: 168, label: '7 days' },
  { value: 720, label: '30 days' }
]

function healthBadge(ok: boolean): JSX.Element {
  return (
    <span className={`status-badge ${ok ? 'status-ok' : 'status-warn'}`}>
      {ok ? 'Running' : 'Stopped'}
    </span>
  )
}

function formatRelative(iso: string): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(iso).toLocaleString()
}

export function ExportersSettingsPanel({ isVisible }: Props): JSX.Element {
  const [config, setConfig] = useState<ExporterConfig>(DEFAULT_CONFIG)
  const [health, setHealth] = useState<ExporterHealthSnapshot | null>(null)
  const [saving, setSaving] = useState(false)
  const [pinging, setPinging] = useState(false)
  const [pingResult, setPingResult] = useState<string>('')
  const [message, setMessage] = useState('')
  const [sendingTest, setSendingTest] = useState(false)
  const healthTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!isVisible) return

    const api = (window as Window & { awsLens?: { getExporterConfig?: () => Promise<unknown>; getExporterHealth?: () => Promise<unknown> } }).awsLens
    if (!api) return

    api.getExporterConfig?.().then((res) => {
      const r = res as { ok: boolean; data?: ExporterConfig }
      if (r.ok && r.data) setConfig(r.data)
    }).catch(() => {})

    const refreshHealth = (): void => {
      api.getExporterHealth?.().then((res) => {
        const r = res as { ok: boolean; data?: ExporterHealthSnapshot }
        if (r.ok && r.data) setHealth(r.data)
      }).catch(() => {})
    }

    refreshHealth()
    healthTimer.current = setInterval(refreshHealth, 10_000)
    return () => {
      if (healthTimer.current) clearInterval(healthTimer.current)
    }
  }, [isVisible])

  function updatePrometheus(patch: Partial<ExporterConfig['prometheus']>): void {
    setConfig((prev) => ({ ...prev, prometheus: { ...prev.prometheus, ...patch } }))
  }

  function updateElasticsearch(patch: Partial<ExporterConfig['elasticsearch']>): void {
    setConfig((prev) => ({ ...prev, elasticsearch: { ...prev.elasticsearch, ...patch } }))
  }

  function handleSave(): void {
    const api = (window as Window & { awsLens?: { setExporterConfig?: (c: unknown) => Promise<unknown> } }).awsLens
    if (!api) return
    setSaving(true)
    setMessage('')
    api.setExporterConfig?.(config).then((res) => {
      const r = res as { ok: boolean; data?: ExporterConfig; error?: string }
      if (r.ok && r.data) {
        setConfig(r.data)
        setMessage('Exporter settings saved.')
      } else {
        setMessage(`Save failed: ${r.error ?? 'unknown error'}`)
      }
    }).catch((err: unknown) => {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    }).finally(() => setSaving(false))
  }

  function handlePing(): void {
    const api = (window as Window & { awsLens?: { pingElasticsearch?: (c: unknown) => Promise<unknown> } }).awsLens
    if (!api) return
    setPinging(true)
    setPingResult('')
    api.pingElasticsearch?.(config.elasticsearch).then((res) => {
      const r = res as { ok: boolean; data?: { ok: boolean; version: string; error: string } }
      if (r.ok && r.data?.ok) {
        setPingResult(`Connected — Elasticsearch ${r.data.version}`)
      } else {
        setPingResult(`Failed: ${r.data?.error ?? 'unknown error'}`)
      }
    }).catch((err: unknown) => {
      setPingResult(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }).finally(() => setPinging(false))
  }

  function handlePurgeQueue(): void {
    const api = (window as Window & { awsLens?: { purgeExporterQueue?: () => Promise<unknown> } }).awsLens
    if (!api) return
    api.purgeExporterQueue?.().then(() => setMessage('Export queue purged.')).catch(() => {})
  }

  function handleSendTestEvent(): void {
    const api = (window as Window & { awsLens?: { sendTestExporterEvent?: () => Promise<unknown> } }).awsLens
    if (!api) return
    setSendingTest(true)
    setMessage('')
    api.sendTestExporterEvent?.().then((res) => {
      const r = res as { ok: boolean; error?: string }
      if (r.ok) {
        setMessage('Test event enqueued. Check health panel for sync status.')
      } else {
        setMessage(`Test event failed: ${r.error ?? 'unknown error'}`)
      }
    }).catch((err: unknown) => {
      setMessage(`Test event failed: ${err instanceof Error ? err.message : String(err)}`)
    }).finally(() => setSendingTest(false))
  }

  return (
    <>

      {/* ── Prometheus ─────────────────────────────────────── */}
      <section className="settings-tab-section">
        <div className="settings-tab-section__title">
          Prometheus metrics
          {health && (
            <span style={{ marginLeft: 12 }}>{healthBadge(health.prometheus.running)}</span>
          )}
        </div>
        <div className="settings-tab-section__body">
          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>Enable Prometheus exporter</strong>
              <p>Exposes a /metrics endpoint on the configured port for scraping by Prometheus or compatible systems.</p>
            </div>
            <div className="settings-row__control">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={config.prometheus.enabled}
                  onChange={(e) => updatePrometheus({ enabled: e.target.checked })}
                />
                <span>{config.prometheus.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
          </div>

          {config.prometheus.enabled && (
            <>
              <div className="settings-row">
                <div className="settings-row__copy"><strong>Host</strong></div>
                <div className="settings-row__control">
                  <input
                    type="text"
                    value={config.prometheus.host}
                    placeholder="127.0.0.1"
                    onChange={(e) => updatePrometheus({ host: e.target.value })}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row__copy"><strong>Port</strong></div>
                <div className="settings-row__control">
                  <input
                    type="number"
                    value={config.prometheus.port}
                    min={1024}
                    max={65535}
                    onChange={(e) => updatePrometheus({ port: Number(e.target.value) })}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row__copy"><strong>Metrics path</strong></div>
                <div className="settings-row__control">
                  <input
                    type="text"
                    value={config.prometheus.metricsPath}
                    placeholder="/metrics"
                    onChange={(e) => updatePrometheus({ metricsPath: e.target.value })}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row__copy">
                  <strong>Team label</strong>
                  <p>Added to all Prometheus metrics as a label.</p>
                </div>
                <div className="settings-row__control">
                  <input
                    type="text"
                    value={config.prometheus.teamLabel}
                    placeholder="platform-team"
                    onChange={(e) => updatePrometheus({ teamLabel: e.target.value })}
                  />
                </div>
              </div>

              {health && (
                <div className="settings-row">
                  <div className="settings-row__copy"><strong>Status</strong></div>
                  <div className="settings-row__control">
                    <div className="settings-static-value">
                      {health.prometheus.running
                        ? `Listening on :${health.prometheus.port}`
                        : health.prometheus.lastError || 'Not running'}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── Elasticsearch / OpenSearch ──────────────────────── */}
      <section className="settings-tab-section">
        <div className="settings-tab-section__title">Elasticsearch / OpenSearch export</div>
        <div className="settings-tab-section__body">
          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>Enable Elasticsearch export</strong>
              <p>Sends audit events and Terraform run records to an Elasticsearch or OpenSearch cluster.</p>
            </div>
            <div className="settings-row__control">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={config.elasticsearch.enabled}
                  onChange={(e) => updateElasticsearch({ enabled: e.target.checked })}
                />
                <span>{config.elasticsearch.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row__copy"><strong>Cluster URL</strong></div>
            <div className="settings-row__control">
              <input
                type="text"
                value={config.elasticsearch.url}
                placeholder="http://localhost:9200"
                onChange={(e) => updateElasticsearch({ url: e.target.value })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>Index prefix</strong>
              <p>Indices are named: {'<prefix>-<kind>-<YYYY-MM-DD>'}</p>
            </div>
            <div className="settings-row__control">
              <input
                type="text"
                value={config.elasticsearch.indexPrefix}
                placeholder="infralens"
                onChange={(e) => updateElasticsearch({ indexPrefix: e.target.value })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row__copy"><strong>Authentication</strong></div>
            <div className="settings-row__control">
              <select
                value={config.elasticsearch.authKind}
                onChange={(e) => updateElasticsearch({ authKind: e.target.value as ExporterAuthKind })}
              >
                {AUTH_KIND_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {config.elasticsearch.authKind === 'basic' && (
            <>
              <div className="settings-row">
                <div className="settings-row__copy"><strong>Username</strong></div>
                <div className="settings-row__control">
                  <input
                    type="text"
                    value={config.elasticsearch.username}
                    onChange={(e) => updateElasticsearch({ username: e.target.value })}
                  />
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row__copy"><strong>Password</strong></div>
                <div className="settings-row__control">
                  <input
                    type="password"
                    value={config.elasticsearch.password}
                    onChange={(e) => updateElasticsearch({ password: e.target.value })}
                  />
                </div>
              </div>
            </>
          )}

          {config.elasticsearch.authKind === 'bearer' && (
            <div className="settings-row">
              <div className="settings-row__copy"><strong>Bearer token</strong></div>
              <div className="settings-row__control">
                <input
                  type="password"
                  value={config.elasticsearch.bearerToken}
                  onChange={(e) => updateElasticsearch({ bearerToken: e.target.value })}
                />
              </div>
            </div>
          )}

          {config.elasticsearch.authKind === 'api-key' && (
            <div className="settings-row">
              <div className="settings-row__copy"><strong>API key</strong></div>
              <div className="settings-row__control">
                <input
                  type="password"
                  value={config.elasticsearch.apiKey}
                  onChange={(e) => updateElasticsearch({ apiKey: e.target.value })}
                />
              </div>
            </div>
          )}

          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>Skip TLS verification</strong>
              <p>Not recommended for production deployments.</p>
            </div>
            <div className="settings-row__control">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={config.elasticsearch.tlsSkipVerify}
                  onChange={(e) => updateElasticsearch({ tlsSkipVerify: e.target.checked })}
                />
                <span>{config.elasticsearch.tlsSkipVerify ? 'Skip verify' : 'Verify TLS'}</span>
              </label>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>Team label</strong>
              <p>Added to every exported document for filtering.</p>
            </div>
            <div className="settings-row__control">
              <input
                type="text"
                value={config.elasticsearch.teamLabel}
                placeholder="platform-team"
                onChange={(e) => updateElasticsearch({ teamLabel: e.target.value })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row__copy"><strong>Project label</strong></div>
            <div className="settings-row__control">
              <input
                type="text"
                value={config.elasticsearch.projectLabel}
                placeholder="infralens"
                onChange={(e) => updateElasticsearch({ projectLabel: e.target.value })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row__copy"><strong>Test connection</strong></div>
            <div className="settings-row__control" style={{ gap: 8, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" disabled={pinging} onClick={handlePing}>
                {pinging ? 'Pinging…' : 'Ping cluster'}
              </button>
              {pingResult && (
                <span className={`status-badge ${pingResult.startsWith('Connected') ? 'status-ok' : 'status-warn'}`}>
                  {pingResult}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Redaction & Retention ───────────────────────────── */}
      <section className="settings-tab-section">
        <div className="settings-tab-section__title">Redaction &amp; retention</div>
        <div className="settings-tab-section__body">
          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>Redaction mode</strong>
              <p>Controls what data is masked before it leaves the desktop.</p>
            </div>
            <div className="settings-row__control">
              <select
                value={config.redactionMode}
                onChange={(e) => setConfig((prev) => ({ ...prev, redactionMode: e.target.value as ExporterRedactionMode }))}
              >
                {REDACTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label} — {opt.description}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row__copy">
              <strong>Local queue retention</strong>
              <p>How long undelivered documents are kept before being dropped.</p>
            </div>
            <div className="settings-row__control">
              <select
                value={config.retentionHours}
                onChange={(e) => setConfig((prev) => ({ ...prev, retentionHours: Number(e.target.value) }))}
              >
                {RETENTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      {/* ── Export queue health ─────────────────────────────── */}
      {health && (
        <section className="settings-tab-section">
          <div className="settings-tab-section__title">Export queue health</div>
          <div className="settings-tab-section__body">
            <div className="settings-row">
              <div className="settings-row__copy"><strong>Pending</strong></div>
              <div className="settings-row__control">
                <div className="settings-static-value">{health.queue.pending}</div>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row__copy"><strong>Retrying (backoff)</strong></div>
              <div className="settings-row__control">
                <div className="settings-static-value">{health.queue.retrying}</div>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row__copy"><strong>Dropped</strong></div>
              <div className="settings-row__control">
                <div className="settings-static-value">{health.queue.dropped}</div>
              </div>
            </div>
            {health.elasticsearch.lastSuccessAt && (
              <div className="settings-row">
                <div className="settings-row__copy"><strong>Last successful sync</strong></div>
                <div className="settings-row__control">
                  <div className="settings-static-value">{formatRelative(health.elasticsearch.lastSuccessAt)}</div>
                </div>
              </div>
            )}
            {health.elasticsearch.lastFailureAt && (
              <div className="settings-row">
                <div className="settings-row__copy"><strong>Last sync failure</strong></div>
                <div className="settings-row__control">
                  <div className="settings-static-value">
                    {formatRelative(health.elasticsearch.lastFailureAt)}
                    {health.elasticsearch.lastError && (
                      <span style={{ marginLeft: 8, opacity: 0.7, fontSize: '0.85em' }}>
                        {health.elasticsearch.lastError}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="settings-row">
              <div className="settings-row__copy">
                <strong>Purge queue</strong>
                <p>Removes all pending export entries. Documents already synced are not affected.</p>
              </div>
              <div className="settings-row__control">
                <button type="button" onClick={handlePurgeQueue}>Purge queue</button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Save ────────────────────────────────────────────── */}
      <div className="settings-tab-actions">
        <button type="button" className="accent" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save exporter settings'}
        </button>
        <button type="button" disabled={sendingTest} onClick={handleSendTestEvent}>
          {sendingTest ? 'Sending…' : 'Send test event'}
        </button>
        {message && <span className="settings-message">{message}</span>}
      </div>
    </>
  )
}
