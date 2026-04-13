/**
 * Azure Load Balancer / Application Gateway log retrieval.
 *
 * Queries Azure Monitor Log Analytics for:
 * - ApplicationGatewayAccessLog (App Gateway access logs)
 * - ApplicationGatewayFirewallLog (WAF events)
 * - AzureDiagnostics for Load Balancer probe health
 *
 * Depends on: azure/monitor.ts (queryAzureLogAnalyticsWithTimeout)
 */

import { queryAzureLogAnalyticsWithTimeout } from './monitor'

import type {
  LoadBalancerLogEntry,
  LoadBalancerLogFilter,
  LoadBalancerLogQuery,
  LoadBalancerLogResult
} from '@shared/types'

/* ---------------------------------------------------------------------------
 * KQL query builders
 * -------------------------------------------------------------------------*/

function buildAppGatewayKql(query: LoadBalancerLogQuery): string {
  const parts: string[] = [
    'AzureDiagnostics',
    `| where TimeGenerated >= datetime("${query.timeRange.startTime}") and TimeGenerated <= datetime("${query.timeRange.endTime}")`,
    '| where Category == "ApplicationGatewayAccessLog" or Category == "ApplicationGatewayFirewallLog"'
  ]

  // Scope to specific resource if identifier provided
  if (query.loadBalancerIdentifier) {
    parts.push(`| where Resource =~ "${query.loadBalancerIdentifier}" or ResourceId contains "${query.loadBalancerIdentifier}"`)
  }

  // Status code filter
  if (query.filter.statusCodeRange) {
    const prefix = query.filter.statusCodeRange[0]
    if (prefix) {
      const low = parseInt(prefix, 10) * 100
      const high = low + 99
      parts.push(`| where toint(httpStatus_d) >= ${low} and toint(httpStatus_d) <= ${high}`)
    }
  }

  // Client IP filter
  if (query.filter.clientIp) {
    parts.push(`| where clientIP_s startswith "${query.filter.clientIp}"`)
  }

  // HTTP method filter
  if (query.filter.httpMethod) {
    parts.push(`| where httpMethod_s =~ "${query.filter.httpMethod}"`)
  }

  // URL pattern filter
  if (query.filter.requestUrlPattern) {
    parts.push(`| where requestUri_s matches regex "${query.filter.requestUrlPattern}"`)
  }

  // Latency filter
  if (query.filter.minResponseTimeMs != null && query.filter.minResponseTimeMs > 0) {
    const seconds = query.filter.minResponseTimeMs / 1000
    parts.push(`| where timeTaken_d >= ${seconds}`)
  }

  // Free text search
  if (query.filter.searchText) {
    parts.push(`| where * contains "${query.filter.searchText}"`)
  }

  parts.push('| order by TimeGenerated desc')
  parts.push(`| take ${query.maxResults || 200}`)
  parts.push('| project TimeGenerated, clientIP_s, clientPort_d, host_s, httpMethod_s, requestUri_s, httpStatus_d, sentBytes_d, receivedBytes_d, timeTaken_d, userAgent_s, sslCipher_s, sslProtocol_s, serverRouted_s, serverStatus_d, serverResponseLatency_s, ruleName_s, action_s, Resource, Category')

  return parts.join('\n')
}

function buildLoadBalancerProbeKql(query: LoadBalancerLogQuery): string {
  const parts: string[] = [
    'AzureDiagnostics',
    `| where TimeGenerated >= datetime("${query.timeRange.startTime}") and TimeGenerated <= datetime("${query.timeRange.endTime}")`,
    '| where Category == "LoadBalancerProbeHealthStatus"'
  ]

  if (query.loadBalancerIdentifier) {
    parts.push(`| where Resource =~ "${query.loadBalancerIdentifier}" or ResourceId contains "${query.loadBalancerIdentifier}"`)
  }

  parts.push('| order by TimeGenerated desc')
  parts.push(`| take ${query.maxResults || 200}`)

  return parts.join('\n')
}

/* ---------------------------------------------------------------------------
 * Row → LoadBalancerLogEntry mapping
 * -------------------------------------------------------------------------*/

function mapAppGatewayRow(
  columns: Array<{ name: string; type: string }>,
  row: unknown[]
): LoadBalancerLogEntry | null {
  const get = (name: string): string => {
    const idx = columns.findIndex((c) => c.name === name)
    if (idx === -1 || idx >= row.length) return ''
    const val = row[idx]
    return val == null ? '' : String(val)
  }

  const getNum = (name: string): number => {
    const val = get(name)
    if (!val || val === 'null') return 0
    const n = parseFloat(val)
    return Number.isFinite(n) ? n : 0
  }

  return {
    timestamp: get('TimeGenerated'),
    clientIp: get('clientIP_s'),
    clientPort: getNum('clientPort_d'),
    targetIp: get('serverRouted_s'),
    targetPort: 0,
    httpMethod: get('httpMethod_s'),
    requestUrl: get('requestUri_s'),
    statusCode: getNum('httpStatus_d'),
    targetStatusCode: getNum('serverStatus_d'),
    sentBytes: getNum('sentBytes_d'),
    receivedBytes: getNum('receivedBytes_d'),
    requestProcessingTime: getNum('timeTaken_d') * 1000, // seconds → ms
    targetProcessingTime: parseFloat(get('serverResponseLatency_s') || '0') * 1000,
    responseProcessingTime: 0,
    userAgent: get('userAgent_s'),
    sslCipher: get('sslCipher_s'),
    sslProtocol: get('sslProtocol_s'),
    targetGroupArn: get('Resource'),
    traceId: '',
    domainName: get('host_s'),
    actionsExecuted: get('action_s'),
    redirectUrl: '',
    errorReason: get('Category') === 'ApplicationGatewayFirewallLog' ? get('ruleName_s') : '',
    provider: 'azure',
    raw: JSON.stringify(row)
  }
}

function matchesClientFilter(entry: LoadBalancerLogEntry, filter: LoadBalancerLogFilter): boolean {
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

export async function queryAzureLoadBalancerLogs(
  workspaceId: string,
  query: LoadBalancerLogQuery
): Promise<LoadBalancerLogResult> {
  if (!workspaceId.trim()) {
    return {
      entries: [],
      totalScanned: 0,
      statusCodeDistribution: {},
      notes: ['No Log Analytics workspace ID provided. Configure a workspace to view load balancer logs.']
    }
  }

  // Build KQL for Application Gateway access logs (the primary HTTP LB in Azure)
  const kql = buildAppGatewayKql(query)
  const timespan = buildTimespan(query.timeRange)

  const result = await queryAzureLogAnalyticsWithTimeout(workspaceId, kql, timespan, 120)

  if (result.error) {
    // Fall back to Load Balancer probe health if App Gateway logs don't exist
    const probeKql = buildLoadBalancerProbeKql(query)
    const probeResult = await queryAzureLogAnalyticsWithTimeout(workspaceId, probeKql, timespan, 60)

    if (probeResult.error) {
      return {
        entries: [],
        totalScanned: 0,
        statusCodeDistribution: {},
        notes: [
          `App Gateway log query failed: ${result.error}`,
          'Attempted Load Balancer probe health query as fallback, but it also failed.',
          'Ensure diagnostic settings are configured to send logs to this Log Analytics workspace.'
        ]
      }
    }

    // Probe health logs have a different schema — return as simple entries
    const probeEntries = mapProbeRows(probeResult.tables)
    return {
      entries: probeEntries,
      totalScanned: probeEntries.length,
      statusCodeDistribution: buildStatusDistribution(probeEntries),
      notes: ['Showing Load Balancer probe health logs (not HTTP access logs). Enable Application Gateway diagnostic settings for full access logs.']
    }
  }

  // Map App Gateway access log rows
  const entries: LoadBalancerLogEntry[] = []
  for (const table of result.tables) {
    for (const row of table.rows) {
      const entry = mapAppGatewayRow(table.columns, row as unknown[])
      if (entry && matchesClientFilter(entry, query.filter)) {
        entries.push(entry)
      }
    }
  }

  return {
    entries,
    totalScanned: entries.length,
    statusCodeDistribution: buildStatusDistribution(entries),
    notes: []
  }
}

function mapProbeRows(
  tables: Array<{ columns: Array<{ name: string; type: string }>; rows: unknown[][] }>
): LoadBalancerLogEntry[] {
  const entries: LoadBalancerLogEntry[] = []
  for (const table of tables) {
    for (const row of table.rows) {
      const get = (name: string): string => {
        const idx = table.columns.findIndex((c) => c.name === name)
        if (idx === -1 || idx >= row.length) return ''
        return row[idx] == null ? '' : String(row[idx])
      }
      entries.push({
        timestamp: get('TimeGenerated'),
        clientIp: '',
        clientPort: 0,
        targetIp: get('DipAddress') || get('dipAddress_s'),
        targetPort: 0,
        httpMethod: 'PROBE',
        requestUrl: '',
        statusCode: get('ProbeResult') === 'Up' ? 200 : 503,
        targetStatusCode: 0,
        sentBytes: 0,
        receivedBytes: 0,
        requestProcessingTime: 0,
        targetProcessingTime: 0,
        responseProcessingTime: 0,
        userAgent: '',
        sslCipher: '',
        sslProtocol: '',
        targetGroupArn: get('Resource'),
        traceId: '',
        domainName: '',
        actionsExecuted: 'probe-health',
        redirectUrl: '',
        errorReason: get('ProbeResult') === 'Up' ? '' : 'Probe failed',
        provider: 'azure',
        raw: JSON.stringify(row)
      })
    }
  }
  return entries
}

function buildTimespan(timeRange: { startTime: string; endTime: string }): string {
  // ISO 8601 duration between start and end
  const startMs = new Date(timeRange.startTime).getTime()
  const endMs = new Date(timeRange.endTime).getTime()
  const diffMs = endMs - startMs
  if (diffMs <= 0 || !Number.isFinite(diffMs)) return 'PT24H'

  const hours = Math.ceil(diffMs / (60 * 60 * 1000))
  return `PT${hours}H`
}
