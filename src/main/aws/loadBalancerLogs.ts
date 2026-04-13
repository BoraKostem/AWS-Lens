import {
  DescribeLoadBalancerAttributesCommand,
  ElasticLoadBalancingV2Client
} from '@aws-sdk/client-elastic-load-balancing-v2'
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client
} from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'

import type {
  AwsConnection,
  LoadBalancerLogEntry,
  LoadBalancerLogFilter,
  LoadBalancerLogQuery,
  LoadBalancerLogResult,
  LoadBalancerLogTimeRange
} from '@shared/types'
import { getAwsClient } from './client'

/* ---------------------------------------------------------------------------
 * ALB access log format fields (space-delimited, some quoted)
 * See: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html
 * -------------------------------------------------------------------------*/

function parseAlbLogLine(line: string): LoadBalancerLogEntry | null {
  // ALB log fields are space-delimited with some fields in double quotes
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ' ' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) fields.push(current)

  // ALB has 29 fields; NLB has fewer. Require at least 12 for a valid entry.
  if (fields.length < 12) return null

  const [clientIp, clientPort] = splitHostPort(fields[3] ?? '')
  const [targetIp, targetPort] = splitHostPort(fields[4] ?? '')

  return {
    timestamp: fields[1] ?? '',
    clientIp,
    clientPort,
    targetIp,
    targetPort,
    httpMethod: extractHttpMethod(fields[12] ?? ''),
    requestUrl: extractRequestUrl(fields[12] ?? ''),
    statusCode: safeInt(fields[8]),
    targetStatusCode: safeInt(fields[9]),
    sentBytes: safeInt(fields[11]),
    receivedBytes: safeInt(fields[10]),
    requestProcessingTime: safeFloat(fields[5]),
    targetProcessingTime: safeFloat(fields[6]),
    responseProcessingTime: safeFloat(fields[7]),
    userAgent: fields[13] ?? '',
    sslCipher: fields[14] ?? '',
    sslProtocol: fields[15] ?? '',
    targetGroupArn: fields[16] ?? '',
    traceId: fields[17] ?? '',
    domainName: fields[18] ?? '',
    actionsExecuted: fields[20] ?? '',
    redirectUrl: fields[21] ?? '',
    errorReason: fields[22] ?? '',
    provider: 'aws',
    raw: line
  }
}

function splitHostPort(value: string): [string, number] {
  const idx = value.lastIndexOf(':')
  if (idx === -1) return [value, 0]
  return [value.slice(0, idx), safeInt(value.slice(idx + 1))]
}

function extractHttpMethod(requestField: string): string {
  // Format: "GET https://host/path HTTP/1.1"
  return requestField.split(' ')[0] ?? ''
}

function extractRequestUrl(requestField: string): string {
  const parts = requestField.split(' ')
  return parts[1] ?? requestField
}

function safeInt(value: string | undefined): number {
  if (!value || value === '-') return 0
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : 0
}

function safeFloat(value: string | undefined): number {
  if (!value || value === '-') return -1
  const n = parseFloat(value)
  return Number.isFinite(n) ? n * 1000 : -1 // Convert seconds → ms
}

/* ---------------------------------------------------------------------------
 * S3 key prefix for ALB logs
 * Format: {prefix}/AWSLogs/{account-id}/elasticloadbalancing/{region}/{YYYY}/{MM}/{DD}/
 * -------------------------------------------------------------------------*/

function buildLogPrefix(
  s3Prefix: string,
  accountId: string,
  region: string,
  timeRange: LoadBalancerLogTimeRange
): string[] {
  const base = s3Prefix ? `${s3Prefix}/AWSLogs/${accountId}/elasticloadbalancing/${region}` : `AWSLogs/${accountId}/elasticloadbalancing/${region}`

  // Enumerate all dates in the range
  const start = new Date(timeRange.startTime)
  const end = new Date(timeRange.endTime)
  const prefixes: string[] = []

  const current = new Date(start)
  while (current <= end) {
    const yyyy = current.getUTCFullYear()
    const mm = String(current.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(current.getUTCDate()).padStart(2, '0')
    prefixes.push(`${base}/${yyyy}/${mm}/${dd}/`)
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return prefixes
}

/* ---------------------------------------------------------------------------
 * Read and decompress a single S3 log file
 * -------------------------------------------------------------------------*/

async function readLogFile(s3Client: S3Client, bucket: string, key: string): Promise<string> {
  const output = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!output.Body) return ''

  const chunks: Buffer[] = []

  if (key.endsWith('.gz')) {
    const bodyStream = output.Body instanceof Readable
      ? output.Body
      : Readable.from(await output.Body.transformToByteArray())
    const gunzip = createGunzip()
    const decompressed = bodyStream.pipe(gunzip)
    for await (const chunk of decompressed) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  } else if (output.Body instanceof Readable) {
    for await (const chunk of output.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  } else {
    const bytes = await output.Body.transformToByteArray()
    chunks.push(Buffer.from(bytes))
  }

  return Buffer.concat(chunks).toString('utf8')
}

/* ---------------------------------------------------------------------------
 * Filter helpers
 * -------------------------------------------------------------------------*/

function matchesFilter(entry: LoadBalancerLogEntry, filter: LoadBalancerLogFilter): boolean {
  if (filter.statusCodeRange) {
    const prefix = filter.statusCodeRange[0]
    if (prefix && !String(entry.statusCode).startsWith(prefix)) return false
  }
  if (filter.clientIp && !entry.clientIp.startsWith(filter.clientIp)) return false
  if (filter.httpMethod && entry.httpMethod.toUpperCase() !== filter.httpMethod.toUpperCase()) return false
  if (filter.targetIp && !entry.targetIp.startsWith(filter.targetIp)) return false
  if (filter.minResponseTimeMs != null && filter.minResponseTimeMs > 0) {
    const totalMs = entry.requestProcessingTime + entry.targetProcessingTime + entry.responseProcessingTime
    if (totalMs < filter.minResponseTimeMs) return false
  }
  if (filter.requestUrlPattern) {
    try {
      const re = new RegExp(filter.requestUrlPattern, 'i')
      if (!re.test(entry.requestUrl)) return false
    } catch { /* invalid regex — skip filter */ }
  }
  if (filter.searchText) {
    const text = filter.searchText.toLowerCase()
    if (!entry.raw.toLowerCase().includes(text)) return false
  }
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

export async function getAlbAccessLogConfig(
  connection: AwsConnection,
  loadBalancerArn: string
): Promise<{ enabled: boolean; bucket: string; prefix: string }> {
  const client = getAwsClient(ElasticLoadBalancingV2Client, connection)
  const response = await client.send(new DescribeLoadBalancerAttributesCommand({
    LoadBalancerArn: loadBalancerArn
  }))

  const attrs = response.Attributes ?? []
  const enabled = attrs.find((a) => a.Key === 'access_logs.s3.enabled')?.Value === 'true'
  const bucket = attrs.find((a) => a.Key === 'access_logs.s3.bucket')?.Value ?? ''
  const prefix = attrs.find((a) => a.Key === 'access_logs.s3.prefix')?.Value ?? ''

  return { enabled, bucket, prefix }
}

export async function queryAlbAccessLogs(
  connection: AwsConnection,
  query: LoadBalancerLogQuery
): Promise<LoadBalancerLogResult> {
  // 1. Discover the S3 bucket and prefix from LB attributes
  const logConfig = await getAlbAccessLogConfig(connection, query.loadBalancerIdentifier)

  if (!logConfig.enabled || !logConfig.bucket) {
    return {
      entries: [],
      totalScanned: 0,
      notes: ['Access logging is not enabled for this load balancer. Enable it in the load balancer attributes to view logs.'],
      statusCodeDistribution: {}
    }
  }

  // 2. Determine the account ID from the LB ARN
  const arnParts = query.loadBalancerIdentifier.split(':')
  const accountId = arnParts[4] ?? ''
  const region = arnParts[3] ?? connection.region ?? ''

  // 3. List S3 objects for the time range
  const s3Client = getAwsClient(S3Client, connection)
  const dayPrefixes = buildLogPrefix(logConfig.prefix, accountId, region, query.timeRange)

  const logKeys: string[] = []
  for (const prefix of dayPrefixes) {
    let continuationToken: string | undefined
    do {
      const output = await s3Client.send(new ListObjectsV2Command({
        Bucket: logConfig.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 200
      }))
      for (const item of output.Contents ?? []) {
        if (item.Key) logKeys.push(item.Key)
      }
      continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined
    } while (continuationToken)

    // Cap the number of log files to avoid excessive API calls
    if (logKeys.length > 500) break
  }

  // Sort newest first
  logKeys.sort().reverse()

  // 4. Parse log files, applying pagination via nextToken (offset-based)
  const startOffset = query.nextToken ? parseInt(query.nextToken, 10) : 0
  const maxResults = query.maxResults || 200
  const entries: LoadBalancerLogEntry[] = []
  let totalScanned = 0

  const filesToRead = logKeys.slice(startOffset, startOffset + 50) // Read up to 50 files per request

  for (const key of filesToRead) {
    try {
      const content = await readLogFile(s3Client, logConfig.bucket, key)
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        totalScanned++
        const parsed = parseAlbLogLine(line)
        if (!parsed) continue
        if (!matchesFilter(parsed, query.filter)) continue
        entries.push(parsed)
        if (entries.length >= maxResults) break
      }
    } catch {
      // Skip unreadable files
    }
    if (entries.length >= maxResults) break
  }

  const nextFileOffset = startOffset + 50
  const hasMore = nextFileOffset < logKeys.length && entries.length >= maxResults

  return {
    entries,
    totalScanned,
    nextToken: hasMore ? String(nextFileOffset) : undefined,
    statusCodeDistribution: buildStatusDistribution(entries),
    notes: logKeys.length > 500 ? ['Log file list was capped at 500 files. Narrow the time range for more complete results.'] : []
  }
}
