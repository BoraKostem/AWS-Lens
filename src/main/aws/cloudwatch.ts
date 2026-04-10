import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  type Metric
} from '@aws-sdk/client-cloudwatch'
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  StartQueryCommand as StartLogsQueryCommand
} from '@aws-sdk/client-cloudwatch-logs'

import { getAwsClient } from './client'
import type {
  AwsConnection,
  CloudWatchLogEventSummary,
  CloudWatchLogGroupSummary,
  CloudWatchQueryExecutionInput,
  CloudWatchQueryExecutionResult,
  CloudWatchMetricSeries,
  CloudWatchMetricStatistic,
  CloudWatchMetricSummary,
  CloudWatchNamespaceSummary
} from '@shared/types'

const METRIC_SCAN_LIMIT = 500
const EC2_METRICS = ['CPUUtilization', 'NetworkIn', 'NetworkOut']
const QUERY_POLL_INTERVAL_MS = 750
const QUERY_MAX_ATTEMPTS = 20



function toMetricSummary(metric: Metric): CloudWatchMetricSummary {
  return {
    namespace: metric.Namespace ?? '-',
    metricName: metric.MetricName ?? '-',
    dimensions: (metric.Dimensions ?? []).map((dimension) =>
      dimension.Name && dimension.Value ? `${dimension.Name}=${dimension.Value}` : dimension.Name ?? '-'
    )
  }
}

function parseDimensions(dims: string[]): Array<{ Name: string; Value: string }> {
  return dims.map((d) => {
    const idx = d.indexOf('=')
    return idx >= 0 ? { Name: d.slice(0, idx), Value: d.slice(idx + 1) } : { Name: d, Value: '' }
  })
}

export async function listCloudWatchMetrics(
  connection: AwsConnection
): Promise<{ metrics: CloudWatchMetricSummary[]; namespaces: CloudWatchNamespaceSummary[] }> {
  const client = getAwsClient(CloudWatchClient, connection)
  const metrics: CloudWatchMetricSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListMetricsCommand({
        NextToken: nextToken
      })
    )

    for (const metric of output.Metrics ?? []) {
      metrics.push(toMetricSummary(metric))
      if (metrics.length >= METRIC_SCAN_LIMIT) {
        break
      }
    }

    nextToken = metrics.length >= METRIC_SCAN_LIMIT ? undefined : output.NextToken
  } while (nextToken)

  const summaryMap = new Map<string, { count: number; keys: Set<string> }>()

  for (const metric of metrics) {
    const existing = summaryMap.get(metric.namespace) ?? { count: 0, keys: new Set<string>() }
    existing.count += 1
    for (const dimension of metric.dimensions) {
      existing.keys.add(dimension.split('=')[0] ?? dimension)
    }
    summaryMap.set(metric.namespace, existing)
  }

  const namespaces = Array.from(summaryMap.entries())
    .map(([namespace, value]) => ({
      namespace,
      metricCount: value.count,
      dimensionKeys: Array.from(value.keys).sort()
    }))
    .sort((left, right) => right.metricCount - left.metricCount)

  return {
    metrics: metrics.sort((left, right) =>
      `${left.namespace}/${left.metricName}`.localeCompare(`${right.namespace}/${right.metricName}`)
    ),
    namespaces
  }
}

export async function listEc2InstanceMetrics(
  connection: AwsConnection,
  instanceId: string
): Promise<CloudWatchMetricSummary[]> {
  const client = getAwsClient(CloudWatchClient, connection)
  const metrics: CloudWatchMetricSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new ListMetricsCommand({
        Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
        NextToken: nextToken
      })
    )

    for (const metric of output.Metrics ?? []) {
      metrics.push(toMetricSummary(metric))
    }

    nextToken = output.NextToken
  } while (nextToken && metrics.length < 500)

  return metrics.sort((left, right) =>
    `${left.namespace}/${left.metricName}`.localeCompare(`${right.namespace}/${right.metricName}`)
  )
}

export async function getMetricStatistics(
  connection: AwsConnection,
  metrics: CloudWatchMetricSummary[],
  periodHours: number
): Promise<CloudWatchMetricStatistic[]> {
  if (metrics.length === 0) return []

  const client = getAwsClient(CloudWatchClient, connection)
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - periodHours * 60 * 60 * 1000)
  const period = periodHours <= 3 ? 60 : periodHours <= 24 ? 300 : 3600

  const limited = metrics.slice(0, 100)
  const results: CloudWatchMetricStatistic[] = []

  // GetMetricData supports up to 500 queries. We batch 100 metrics at a time.
  for (let i = 0; i < limited.length; i += 100) {
    const batch = limited.slice(i, i + 100)

    const output = await client.send(
      new GetMetricDataCommand({
        StartTime: startTime,
        EndTime: endTime,
        ScanBy: 'TimestampDescending',
        MetricDataQueries: batch.map((m, idx) => ({
          Id: `m${idx}`,
          MetricStat: {
            Metric: {
              Namespace: m.namespace,
              MetricName: m.metricName,
              Dimensions: parseDimensions(m.dimensions)
            },
            Period: period,
            Stat: 'Average'
          }
        }))
      })
    )

    for (let j = 0; j < batch.length; j++) {
      const m = batch[j]
      const result = (output.MetricDataResults ?? []).find((r) => r.Id === `m${j}`)
      const values = result?.Values ?? []
      results.push({
        namespace: m.namespace,
        metricName: m.metricName,
        dimensions: m.dimensions,
        latest: values.length > 0 ? values[0] : null,
        average: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
        min: values.length > 0 ? Math.min(...values) : null,
        max: values.length > 0 ? Math.max(...values) : null,
        unit: inferUnit(m.metricName)
      })
    }
  }

  return results
}

export async function getEc2AllMetricSeries(
  connection: AwsConnection,
  instanceId: string,
  periodHours: number
): Promise<CloudWatchMetricSeries[]> {
  const metrics = await listEc2InstanceMetrics(connection, instanceId)
  if (metrics.length === 0) return []

  const client = getAwsClient(CloudWatchClient, connection)
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - periodHours * 60 * 60 * 1000)
  const period = periodHours <= 3 ? 60 : periodHours <= 24 ? 300 : 3600

  const results: CloudWatchMetricSeries[] = []

  for (let i = 0; i < metrics.length; i += 100) {
    const batch = metrics.slice(i, i + 100)

    const output = await client.send(
      new GetMetricDataCommand({
        StartTime: startTime,
        EndTime: endTime,
        ScanBy: 'TimestampAscending',
        MetricDataQueries: batch.map((m, idx) => ({
          Id: `m${idx}`,
          Label: m.metricName,
          MetricStat: {
            Metric: {
              Namespace: m.namespace,
              MetricName: m.metricName,
              Dimensions: parseDimensions(m.dimensions)
            },
            Period: period,
            Stat: m.metricName.includes('Utilization') || m.metricName.includes('Percent') ? 'Average' : 'Sum'
          }
        }))
      })
    )

    for (const result of output.MetricDataResults ?? []) {
      results.push({
        metricName: result.Label ?? result.Id ?? '-',
        unit: inferUnit(result.Label ?? ''),
        points: (result.Timestamps ?? []).map((ts, j) => ({
          timestamp: ts.toISOString(),
          value: Number(result.Values?.[j] ?? 0)
        }))
      })
    }
  }

  return results
}

export async function getEc2MetricSeries(
  connection: AwsConnection,
  instanceId: string
): Promise<CloudWatchMetricSeries[]> {
  const client = getAwsClient(CloudWatchClient, connection)
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - 12 * 60 * 60 * 1000)

  const output = await client.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: EC2_METRICS.map((metricName, index) => ({
        Id: `m${index + 1}`,
        Label: metricName,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/EC2',
            MetricName: metricName,
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }]
          },
          Period: 300,
          Stat: metricName === 'CPUUtilization' ? 'Average' : 'Sum'
        }
      }))
    })
  )

  return (output.MetricDataResults ?? []).map((result) => ({
    metricName: result.Label ?? result.Id ?? '-',
    unit: '',
    points: (result.Timestamps ?? []).map((timestamp, index) => ({
      timestamp: timestamp.toISOString(),
      value: Number(result.Values?.[index] ?? 0)
    }))
  }))
}

export async function listCloudWatchLogGroups(connection: AwsConnection): Promise<CloudWatchLogGroupSummary[]> {
  const client = getAwsClient(CloudWatchLogsClient, connection)
  const groups: CloudWatchLogGroupSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new DescribeLogGroupsCommand({
        nextToken,
        limit: 50
      })
    )

    for (const group of output.logGroups ?? []) {
      groups.push({
        name: group.logGroupName ?? '-',
        arn: group.arn ?? '-',
        storedBytes: Number(group.storedBytes ?? 0),
        retentionInDays: group.retentionInDays ?? null,
        logClass: group.logGroupClass ?? 'STANDARD'
      })
    }

    nextToken = output.nextToken
  } while (nextToken && groups.length < 200)

  return groups.sort((left, right) => left.name.localeCompare(right.name))
}

export async function listRecentLogEvents(
  connection: AwsConnection,
  logGroupName: string,
  periodHours = 24
): Promise<CloudWatchLogEventSummary[]> {
  const client = getAwsClient(CloudWatchLogsClient, connection)
  const output = await client.send(
    new FilterLogEventsCommand({
      logGroupName,
      limit: 60,
      interleaved: true,
      startTime: Date.now() - Math.max(1, periodHours) * 60 * 60 * 1000
    })
  )

  return (output.events ?? [])
    .map((event) => ({
      eventId: event.eventId ?? `${event.logStreamName ?? 'stream'}-${event.timestamp ?? 0}`,
      ingestionTime: new Date(event.ingestionTime ?? 0).toISOString(),
      timestamp: new Date(event.timestamp ?? 0).toISOString(),
      logStreamName: event.logStreamName ?? '-',
      message: event.message ?? ''
    }))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
}

export async function executeCloudWatchQuery(
  connection: AwsConnection,
  input: CloudWatchQueryExecutionInput
): Promise<CloudWatchQueryExecutionResult> {
  const logGroupNames = input.logGroupNames.map((name) => name.trim()).filter(Boolean)
  const queryString = input.queryString.trim()
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200))

  if (!queryString) {
    throw new Error('CloudWatch query text is required.')
  }

  if (logGroupNames.length === 0) {
    throw new Error('Select at least one log group before running a CloudWatch query.')
  }

  const startTimeMs = Math.max(0, Math.min(input.startTimeMs, input.endTimeMs))
  const endTimeMs = Math.max(startTimeMs, input.endTimeMs)
  const client = getAwsClient(CloudWatchLogsClient, connection)

  const startedAt = new Date().toISOString()
  const started = await client.send(
    new StartLogsQueryCommand({
      logGroupNames,
      queryString,
      startTime: Math.floor(startTimeMs / 1000),
      endTime: Math.floor(endTimeMs / 1000),
      limit
    })
  )

  const queryId = started.queryId?.trim()
  if (!queryId) {
    throw new Error('CloudWatch Logs Insights did not return a query identifier.')
  }

  for (let attempt = 0; attempt < QUERY_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(QUERY_POLL_INTERVAL_MS)
    }

    const output = await client.send(new GetQueryResultsCommand({ queryId }))
    const status = output.status ?? 'Unknown'
    if (status === 'Scheduled' || status === 'Running' || status === 'Unknown') {
      continue
    }

    if (status !== 'Complete') {
      throw new Error(`CloudWatch Logs Insights query ended with status ${status}.`)
    }

    const fields: string[] = []
    const seenFields = new Set<string>()
    const rows = (output.results ?? []).map((resultRow) => {
      const row: Record<string, string> = {}
      for (const cell of resultRow) {
        const field = cell.field ?? ''
        if (!field) continue
        if (!seenFields.has(field)) {
          seenFields.add(field)
          fields.push(field)
        }
        row[field] = cell.value ?? ''
      }
      return row
    })

    return {
      queryId,
      status,
      queryString,
      logGroupNames,
      fields,
      rows,
      statistics: {
        recordsMatched: Number(output.statistics?.recordsMatched ?? 0),
        recordsScanned: Number(output.statistics?.recordsScanned ?? 0),
        bytesScanned: Number(output.statistics?.bytesScanned ?? 0)
      },
      limit,
      startedAt,
      completedAt: new Date().toISOString()
    }
  }

  throw new Error('CloudWatch Logs Insights query timed out before results were ready.')
}

function inferUnit(metricName: string): string {
  const lower = metricName.toLowerCase()
  if (lower.includes('utilization') || lower.includes('percent') || lower.endsWith('%')) return 'Percent'
  if (lower.includes('bytes') || lower === 'networkin' || lower === 'networkout') return 'Bytes'
  if (lower.includes('count') || lower.includes('ops') || lower.includes('packets')) return 'Count'
  if (lower.includes('seconds') || lower.includes('latency') || lower.includes('duration')) return 'Seconds'
  if (lower.includes('credit')) return 'Count'
  if (lower.includes('statuscheck')) return 'Count'
  return ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
