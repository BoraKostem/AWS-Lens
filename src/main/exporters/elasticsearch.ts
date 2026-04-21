import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'
import type { ExporterElasticsearchConfig } from '@shared/types'
import type { NormalizedExportDocument } from './schema'

export type EsBulkResult = {
  ok: boolean
  took: number
  errors: boolean
  errorCount: number
  latencyMs: number
}

function buildAuthHeader(config: ExporterElasticsearchConfig): string | null {
  switch (config.authKind) {
    case 'basic': {
      const creds = Buffer.from(`${config.username}:${config.password}`).toString('base64')
      return `Basic ${creds}`
    }
    case 'bearer':
      return `Bearer ${config.bearerToken}`
    case 'api-key':
      return `ApiKey ${config.apiKey}`
    default:
      return null
  }
}

function indexName(config: ExporterElasticsearchConfig, kind: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return `${config.indexPrefix}-${kind}-${date}`
}

function buildBulkBody(config: ExporterElasticsearchConfig, docs: NormalizedExportDocument[]): string {
  const lines: string[] = []
  for (const doc of docs) {
    const index = indexName(config, doc._kind as string)
    lines.push(JSON.stringify({ index: { _index: index, _id: doc._id } }))
    const { _id: _, ...body } = doc
    lines.push(JSON.stringify(body))
  }
  return lines.join('\n') + '\n'
}

function request(
  config: ExporterElasticsearchConfig,
  method: string,
  urlPath: string,
  body: string,
  contentType = 'application/x-ndjson'
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const base = new URL(config.url)
    const isHttps = base.protocol === 'https:'
    const options: http.RequestOptions = {
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      path: urlPath,
      method,
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body)
      }
    }

    if (config.tlsSkipVerify && isHttps) {
      (options as https.RequestOptions).rejectUnauthorized = false
    }

    const auth = buildAuthHeader(config)
    if (auth) {
      options.headers = { ...options.headers, Authorization: auth }
    }

    const transport = isHttps ? https : http
    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
    })

    req.on('error', reject)
    req.setTimeout(15_000, () => {
      req.destroy(new Error('Elasticsearch request timed out after 15s'))
    })
    req.write(body)
    req.end()
  })
}

export async function bulkIndex(
  config: ExporterElasticsearchConfig,
  docs: NormalizedExportDocument[]
): Promise<EsBulkResult> {
  if (!docs.length) return { ok: true, took: 0, errors: false, errorCount: 0, latencyMs: 0 }

  const start = Date.now()
  const body = buildBulkBody(config, docs)

  const { statusCode, body: rawBody } = await request(config, 'POST', '/_bulk', body)
  const latencyMs = Date.now() - start

  if (statusCode >= 400) {
    throw new Error(`Elasticsearch bulk request failed with HTTP ${statusCode}: ${rawBody.slice(0, 200)}`)
  }

  let parsed: { took?: number; errors?: boolean; items?: Array<{ index?: { error?: unknown } }> } = {}
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new Error(`Elasticsearch returned non-JSON response: ${rawBody.slice(0, 200)}`)
  }

  const errorCount = parsed.errors
    ? (parsed.items ?? []).filter((item) => item?.index?.error).length
    : 0

  return {
    ok: !parsed.errors,
    took: parsed.took ?? 0,
    errors: parsed.errors ?? false,
    errorCount,
    latencyMs
  }
}

export async function pingElasticsearch(config: ExporterElasticsearchConfig): Promise<{ ok: boolean; version: string; error: string }> {
  try {
    const { statusCode, body } = await request(config, 'GET', '/', '')
    if (statusCode === 200) {
      const parsed = JSON.parse(body) as { version?: { number?: string } }
      return { ok: true, version: parsed.version?.number ?? 'unknown', error: '' }
    }
    return { ok: false, version: '', error: `HTTP ${statusCode}` }
  } catch (err) {
    return { ok: false, version: '', error: err instanceof Error ? err.message : String(err) }
  }
}

export type TeamTimelineFilter = {
  kind?: 'audit' | 'terraform-run'
  team?: string
  project?: string
  from?: string
  to?: string
  size?: number
}

export async function queryTeamTimeline(
  config: ExporterElasticsearchConfig,
  filter: TeamTimelineFilter
): Promise<{ ok: boolean; hits: unknown[]; error: string }> {
  try {
    const must: unknown[] = []
    if (filter.team) must.push({ term: { 'teamLabel.keyword': filter.team } })
    if (filter.project) must.push({ term: { 'projectLabel.keyword': filter.project } })
    if (filter.from || filter.to) {
      const range: Record<string, string> = {}
      if (filter.from) range.gte = filter.from
      if (filter.to) range.lte = filter.to
      must.push({ range: { timestamp: range } })
    }

    const query = must.length ? { bool: { must } } : { match_all: {} }
    const body = JSON.stringify({
      size: Math.min(filter.size ?? 200, 1000),
      sort: [{ timestamp: { order: 'desc' } }],
      query
    })

    const kindSegment = filter.kind ?? '*'
    const indexPath = `/${encodeURIComponent(config.indexPrefix)}-${kindSegment}-*/_search`
    const { statusCode, body: raw } = await request(
      config,
      'POST',
      indexPath,
      body,
      'application/json'
    )

    if (statusCode >= 400) {
      return { ok: false, hits: [], error: `HTTP ${statusCode}: ${raw.slice(0, 200)}` }
    }

    const parsed = JSON.parse(raw) as { hits?: { hits?: Array<{ _source?: unknown }> } }
    const hits = (parsed.hits?.hits ?? []).map((h) => h._source).filter(Boolean)
    return { ok: true, hits, error: '' }
  } catch (err) {
    return { ok: false, hits: [], error: err instanceof Error ? err.message : String(err) }
  }
}
