import {
  CloudTrailClient,
  DescribeTrailsCommand,
  GetTrailStatusCommand,
  LookupEventsCommand
} from '@aws-sdk/client-cloudtrail'

import type { AwsConnection, CloudTrailEventSummary, CloudTrailSummary } from '@shared/types'
import { getAwsClient } from './client'

export async function listTrails(connection: AwsConnection): Promise<CloudTrailSummary[]> {
  const client = getAwsClient(CloudTrailClient, connection)
  const output = await client.send(new DescribeTrailsCommand({}))

  const trails: CloudTrailSummary[] = []

  for (const trail of output.trailList ?? []) {
    let isLogging = false
    try {
      const status = await client.send(new GetTrailStatusCommand({ Name: trail.TrailARN }))
      isLogging = status.IsLogging ?? false
    } catch {
      // Trail status may fail for cross-region trails
    }

    trails.push({
      name: trail.Name ?? '-',
      s3BucketName: trail.S3BucketName ?? '-',
      isMultiRegion: trail.IsMultiRegionTrail ?? false,
      isLogging,
      homeRegion: trail.HomeRegion ?? '-',
      hasLogFileValidation: trail.LogFileValidationEnabled ?? false
    })
  }

  return trails
}

export async function lookupEvents(
  connection: AwsConnection,
  startTime: string,
  endTime: string
): Promise<CloudTrailEventSummary[]> {
  const client = getAwsClient(CloudTrailClient, connection)
  const events: CloudTrailEventSummary[] = []
  let nextToken: string | undefined

  const start = new Date(startTime)
  const end = new Date(endTime)

  do {
    const output = await client.send(
      new LookupEventsCommand({
        StartTime: start,
        EndTime: end,
        MaxResults: 50,
        NextToken: nextToken
      })
    )

    for (const event of output.Events ?? []) {
      const resource = event.Resources?.[0]
      events.push({
        eventId: event.EventId ?? '-',
        eventName: event.EventName ?? '-',
        eventSource: event.EventSource ?? '-',
        eventTime: event.EventTime ? event.EventTime.toISOString() : '-',
        username: event.Username ?? '-',
        sourceIpAddress: event.AccessKeyId ?? '-',
        awsRegion: connection.region,
        resourceType: resource?.ResourceType ?? '-',
        resourceName: resource?.ResourceName ?? '-',
        readOnly: event.ReadOnly === 'true'
      })
    }

    nextToken = output.NextToken
  } while (nextToken && events.length < 200)

  return events
}

export async function lookupEventsByResource(
  connection: AwsConnection,
  resourceName: string,
  startTime: string,
  endTime: string
): Promise<CloudTrailEventSummary[]> {
  const client = getAwsClient(CloudTrailClient, connection)
  const events: CloudTrailEventSummary[] = []
  let nextToken: string | undefined
  let scanned = 0

  const start = new Date(startTime)
  const end = new Date(endTime)

  do {
    const output = await client.send(
      new LookupEventsCommand({
        StartTime: start,
        EndTime: end,
        MaxResults: 50,
        NextToken: nextToken
      })
    )

    for (const event of output.Events ?? []) {
      const resourceMatch =
        event.Resources?.some((r) => r.ResourceName === resourceName) ||
        (event.CloudTrailEvent ?? '').includes(resourceName)

      if (!resourceMatch) continue

      const resource = event.Resources?.[0]
      events.push({
        eventId: event.EventId ?? '-',
        eventName: event.EventName ?? '-',
        eventSource: event.EventSource ?? '-',
        eventTime: event.EventTime ? event.EventTime.toISOString() : '-',
        username: event.Username ?? '-',
        sourceIpAddress: event.AccessKeyId ?? '-',
        awsRegion: connection.region,
        resourceType: resource?.ResourceType ?? '-',
        resourceName: resource?.ResourceName ?? '-',
        readOnly: event.ReadOnly === 'true'
      })
    }

    scanned += output.Events?.length ?? 0
    nextToken = output.NextToken
  } while (nextToken && events.length < 100 && scanned < 2000)

  return events
}
