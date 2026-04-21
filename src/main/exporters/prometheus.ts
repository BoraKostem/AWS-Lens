import http from 'node:http'
import type { ExporterPrometheusConfig } from '@shared/types'

type CounterState = {
  terraform_runs_total: Record<string, number>
  terraform_failures_total: Record<string, number>
  audit_events_total: Record<string, number>
  drift_issues_total: Record<string, number>
  exporter_queue_enqueued_total: number
  exporter_queue_dropped_total: number
}

type GaugeState = {
  exporter_queue_pending: number
  exporter_queue_retrying: number
  terraform_run_duration_ms_last: number
  es_sync_latency_ms_last: number
}

const counters: CounterState = {
  terraform_runs_total: {},
  terraform_failures_total: {},
  audit_events_total: {},
  drift_issues_total: {},
  exporter_queue_enqueued_total: 0,
  exporter_queue_dropped_total: 0
}

const gauges: GaugeState = {
  exporter_queue_pending: 0,
  exporter_queue_retrying: 0,
  terraform_run_duration_ms_last: 0,
  es_sync_latency_ms_last: 0
}

let server: http.Server | null = null
let lastError = ''
let running = false
let currentPort = 0

// ─── Label-value escaping (per Prometheus exposition format) ─────────────────

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function labels(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',')
}

// ─── Metric update helpers ────────────────────────────────────────────────────

export function incTerraformRun(command: string, provider: string, success: boolean, teamLabel: string): void {
  const key = labels({ command, provider, team: teamLabel || 'unknown' })
  counters.terraform_runs_total[key] = (counters.terraform_runs_total[key] ?? 0) + 1
  if (!success) {
    counters.terraform_failures_total[key] = (counters.terraform_failures_total[key] ?? 0) + 1
  }
}

export function incAuditEvent(outcome: string, serviceId: string, teamLabel: string): void {
  const key = labels({ outcome, service: serviceId || 'unknown', team: teamLabel || 'unknown' })
  counters.audit_events_total[key] = (counters.audit_events_total[key] ?? 0) + 1
}

export function incDriftIssues(projectId: string, count: number, teamLabel: string): void {
  const key = labels({ project: projectId, team: teamLabel || 'unknown' })
  counters.drift_issues_total[key] = (counters.drift_issues_total[key] ?? 0) + count
}

export function setQueueGauges(pending: number, retrying: number, dropped: number): void {
  gauges.exporter_queue_pending = pending
  gauges.exporter_queue_retrying = retrying
  counters.exporter_queue_dropped_total = dropped
}

export function incQueueEnqueued(): void {
  counters.exporter_queue_enqueued_total++
}

export function setLastRunDuration(ms: number): void {
  gauges.terraform_run_duration_ms_last = ms
}

export function setEsSyncLatency(ms: number): void {
  gauges.es_sync_latency_ms_last = ms
}

// ─── Text exposition format ───────────────────────────────────────────────────

function renderCounter(name: string, help: string, values: Record<string, number>): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`]
  for (const [labelString, value] of Object.entries(values)) {
    lines.push(`${name}{${labelString}} ${value}`)
  }
  return lines.join('\n')
}

function renderScalarCounter(name: string, help: string, value: number): string {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${value}`].join('\n')
}

function renderGauge(name: string, help: string, value: number): string {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`].join('\n')
}

function buildMetricsBody(): string {
  const sections = [
    renderCounter(
      'infralens_terraform_runs_total',
      'Total Terraform command executions',
      counters.terraform_runs_total
    ),
    renderCounter(
      'infralens_terraform_failures_total',
      'Total failed Terraform command executions',
      counters.terraform_failures_total
    ),
    renderCounter(
      'infralens_audit_events_total',
      'Total enterprise audit events recorded',
      counters.audit_events_total
    ),
    renderCounter(
      'infralens_drift_issues_total',
      'Total Terraform drift issues detected',
      counters.drift_issues_total
    ),
    renderScalarCounter(
      'infralens_exporter_queue_enqueued_total',
      'Total documents enqueued for export',
      counters.exporter_queue_enqueued_total
    ),
    renderScalarCounter(
      'infralens_exporter_queue_dropped_total',
      'Total documents dropped after max retry attempts or retention purge',
      counters.exporter_queue_dropped_total
    ),
    renderGauge(
      'infralens_exporter_queue_pending',
      'Documents in the export queue ready for next attempt',
      gauges.exporter_queue_pending
    ),
    renderGauge(
      'infralens_exporter_queue_retrying',
      'Documents in the export queue waiting for backoff',
      gauges.exporter_queue_retrying
    ),
    renderGauge(
      'infralens_terraform_run_duration_ms_last',
      'Duration in ms of the most recent Terraform run',
      gauges.terraform_run_duration_ms_last
    ),
    renderGauge(
      'infralens_es_sync_latency_ms_last',
      'Latency in ms of the most recent Elasticsearch sync batch',
      gauges.es_sync_latency_ms_last
    )
  ]

  return sections.join('\n\n') + '\n'
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

export function prometheusStatus(): { running: boolean; port: number; lastError: string } {
  return { running, port: currentPort, lastError }
}

export async function startPrometheusServer(config: ExporterPrometheusConfig): Promise<void> {
  if (server) {
    await stopPrometheusServer()
  }

  const metricsPath = config.metricsPath.startsWith('/') ? config.metricsPath : `/${config.metricsPath}`

  return new Promise<void>((resolve) => {
    const next = http.createServer((req, res) => {
      if (req.url === metricsPath && req.method === 'GET') {
        const body = buildMetricsBody()
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        })
        res.end(body)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    let resolved = false
    const settle = (): void => {
      if (resolved) return
      resolved = true
      resolve()
    }

    next.on('error', (err) => {
      lastError = err.message
      running = false
      server = null
      settle()
    })

    next.listen(config.port, config.host, () => {
      server = next
      running = true
      currentPort = config.port
      lastError = ''
      settle()
    })
  })
}

export function stopPrometheusServer(): Promise<void> {
  return new Promise((resolve) => {
    const current = server
    if (!current) {
      running = false
      currentPort = 0
      resolve()
      return
    }
    server = null
    running = false
    currentPort = 0
    current.close(() => resolve())
    // Also force-terminate any active sockets so port releases promptly.
    current.closeAllConnections?.()
  })
}
