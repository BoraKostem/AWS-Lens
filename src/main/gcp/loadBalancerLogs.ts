import { google } from 'googleapis'

import { getGcpAuth, classifyGcpError } from './client'

import type {
  LoadBalancerLogEntry,
  LoadBalancerLogFilter,
  LoadBalancerLogQuery,
  LoadBalancerLogResult
} from '@shared/types'

/* ---------------------------------------------------------------------------
 * GCP HTTP(S) LB log querying via Cloud Logging API
 *
 * GCP HTTP(S) LB access logs are automatically written to Cloud Logging
 * under resource.type="http_load_balancer". We query them using
 * logging.entries.list with a filter expression.
 * -------------------------------------------------------------------------*/

function buildLogFilter(query: LoadBalancerLogQuery): string {
  const parts: string[] = [
    'resource.type="http_load_balancer"'
  ]

  // Scope to specific forwarding rule / URL map if provided
  if (query.loadBalancerIdentifier) {
    // The identifier could be a forwarding rule name or URL map name
    parts.push(`(resource.labels.forwarding_rule_name="${query.loadBalancerIdentifier}" OR resource.labels.url_map_name="${query.loadBalancerIdentifier}")`)
  }

  // Time range
  if (query.timeRange.startTime) {
    parts.push(`timestamp>="${query.timeRange.startTime}"`)
  }
  if (query.timeRange.endTime) {
    parts.push(`timestamp<="${query.timeRange.endTime}"`)
  }

  // Status code filter
  if (query.filter.statusCodeRange) {
    const prefix = query.filter.statusCodeRange[0]
    if (prefix) {
      const low = parseInt(prefix, 10) * 100
      const high = low + 99
      parts.push(`httpRequest.status>=${low} AND httpRequest.status<=${high}`)
    }
  }

  // Client IP filter
  if (query.filter.clientIp) {
    parts.push(`httpRequest.remoteIp="${query.filter.clientIp}"`)
  }

  // HTTP method filter
  if (query.filter.httpMethod) {
    parts.push(`httpRequest.requestMethod="${query.filter.httpMethod.toUpperCase()}"`)
  }

  // URL pattern via substring
  if (query.filter.requestUrlPattern) {
    parts.push(`httpRequest.requestUrl=~"${query.filter.requestUrlPattern}"`)
  }

  // Latency filter (GCP provides latency as a Duration string e.g. "0.123456s")
  if (query.filter.minResponseTimeMs != null && query.filter.minResponseTimeMs > 0) {
    const seconds = query.filter.minResponseTimeMs / 1000
    parts.push(`httpRequest.latency>="${seconds}s"`)
  }

  // Free text search
  if (query.filter.searchText) {
    parts.push(`"${query.filter.searchText}"`)
  }

  return parts.join('\n')
}

function normalizeGcpLogEntry(entry: Record<string, unknown>): LoadBalancerLogEntry | null {
  const httpRequest = entry.httpRequest && typeof entry.httpRequest === 'object'
    ? entry.httpRequest as Record<string, unknown>
    : {}
  const resource = entry.resource && typeof entry.resource === 'object'
    ? entry.resource as Record<string, unknown>
    : {}
  const labels = resource.labels && typeof resource.labels === 'object'
    ? resource.labels as Record<string, string>
    : {}

  const remoteIp = str(httpRequest.remoteIp)
  const serverIp = str(httpRequest.serverIp)
  const latencyStr = str(httpRequest.latency) // e.g. "0.042s"
  const latencyMs = parseGcpLatency(latencyStr)

  return {
    timestamp: str(entry.timestamp),
    clientIp: remoteIp,
    clientPort: 0,
    targetIp: serverIp,
    targetPort: 0,
    httpMethod: str(httpRequest.requestMethod),
    requestUrl: str(httpRequest.requestUrl),
    statusCode: num(httpRequest.status),
    targetStatusCode: num(httpRequest.status),
    sentBytes: num(httpRequest.responseSize),
    receivedBytes: num(httpRequest.requestSize),
    requestProcessingTime: latencyMs,
    targetProcessingTime: 0,
    responseProcessingTime: 0,
    userAgent: str(httpRequest.userAgent),
    sslCipher: '',
    sslProtocol: str(httpRequest.protocol),
    targetGroupArn: labels.backend_service_name ?? '',
    traceId: str(entry.trace),
    domainName: labels.forwarding_rule_name ?? '',
    actionsExecuted: labels.url_map_name ?? '',
    redirectUrl: '',
    errorReason: str(entry.severity) === 'ERROR' ? str((entry.jsonPayload as Record<string, unknown>)?.statusDetails) : '',
    provider: 'gcp',
    raw: JSON.stringify(entry)
  }
}

function parseGcpLatency(latency: string): number {
  if (!latency) return -1
  // Format: "0.042567s" or "1.5s"
  const match = latency.match(/^([\d.]+)s$/)
  if (!match) return -1
  return parseFloat(match[1]) * 1000
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = parseInt(value, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function matchesClientFilter(entry: LoadBalancerLogEntry, filter: LoadBalancerLogFilter): boolean {
  // Target IP filter (not expressible in Cloud Logging query)
  if (filter.targetIp && !entry.targetIp.startsWith(filter.targetIp)) return false
  return true
}

function buildStatusDistribution(entries: LoadBalancerLogEntry[]): Record<string, number> {
  const dist: Record<string, number> = {}
  for (const e of entries) {
    const bucket = `${Math.floor(e.statusCode / 100)}xx`
    dist[bucket] = (dist[bucket] ?? 0) + 1
  }
  return dist
}

/* ---------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------*/

export async function queryGcpLoadBalancerLogs(
  projectId: string,
  query: LoadBalancerLogQuery
): Promise<LoadBalancerLogResult> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) {
    return { entries: [], totalScanned: 0, statusCodeDistribution: {}, notes: ['No GCP project ID provided.'] }
  }

  const filter = buildLogFilter(query)
  const maxResults = query.maxResults || 200

  try {
    const auth = getGcpAuth(normalizedProjectId)
    const logging = google.logging({ version: 'v2' as never, auth: auth as never })

    const response = await logging.entries.list({
      requestBody: {
        resourceNames: [`projects/${normalizedProjectId}`],
        orderBy: 'timestamp desc',
        pageSize: maxResults,
        pageToken: query.nextToken || undefined,
        filter
      }
    } as never)

    const data = response.data as Record<string, unknown>
    const rawEntries = Array.isArray(data.entries) ? data.entries : []

    const entries: LoadBalancerLogEntry[] = []
    for (const raw of rawEntries) {
      const entry = normalizeGcpLogEntry(raw as Record<string, unknown>)
      if (!entry) continue
      if (!matchesClientFilter(entry, query.filter)) continue
      entries.push(entry)
    }

    const nextPageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined

    return {
      entries,
      totalScanned: rawEntries.length,
      nextToken: nextPageToken,
      statusCodeDistribution: buildStatusDistribution(entries),
      notes: []
    }
  } catch (error) {
    throw classifyGcpError(
      `querying load balancer logs for project "${normalizedProjectId}"`,
      error,
      'logging.googleapis.com'
    )
  }
}
