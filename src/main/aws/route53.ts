import {
  ChangeResourceRecordSetsCommand,
  CreateHostedZoneCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
  type AliasTarget,
  type RRType,
  type ResourceRecordSet,
  type VPCRegion
} from '@aws-sdk/client-route-53'

import { awsClientConfig } from './client'
import type {
  AwsConnection,
  Route53HostedZoneCreateInput,
  Route53HostedZoneSummary,
  Route53RecordChange,
  Route53RecordSummary
} from '@shared/types'
import { randomUUID } from 'node:crypto'

function createClient(connection: AwsConnection): Route53Client {
  return new Route53Client(awsClientConfig(connection))
}

function normalizeHostedZoneId(hostedZoneId: string): string {
  return hostedZoneId.replace('/hostedzone/', '')
}

function inferRoutingPolicy(record: ResourceRecordSet): string {
  if (record.Failover) return `Failover ${record.Failover}`
  if (record.Region) return `Latency ${record.Region}`
  if (record.GeoLocation?.CountryCode || record.GeoLocation?.ContinentCode) return 'Geolocation'
  if (record.Weight !== undefined) return `Weighted ${record.Weight}`
  if (record.MultiValueAnswer) return 'Multivalue'
  return 'Simple'
}

function toAlias(record: Route53RecordChange): AliasTarget {
  return {
    DNSName: record.aliasDnsName,
    HostedZoneId: record.aliasHostedZoneId,
    EvaluateTargetHealth: record.evaluateTargetHealth
  }
}

function toResourceRecordSet(record: Route53RecordChange): ResourceRecordSet {
  return {
    Name: record.name,
    Type: record.type as RRType,
    SetIdentifier: record.setIdentifier || undefined,
    TTL: record.isAlias ? undefined : (record.ttl ?? 300),
    AliasTarget: record.isAlias ? toAlias(record) : undefined,
    ResourceRecords: record.isAlias
      ? undefined
      : record.values.filter(Boolean).map((value) => ({
          Value: value
        }))
  }
}

function toRecordSummary(record: ResourceRecordSet): Route53RecordSummary {
  return {
    name: record.Name ?? '-',
    type: record.Type ?? '-',
    ttl: record.TTL ?? null,
    values: (record.ResourceRecords ?? []).map((value) => value.Value ?? '').filter(Boolean),
    isAlias: Boolean(record.AliasTarget),
    aliasDnsName: record.AliasTarget?.DNSName ?? '',
    aliasHostedZoneId: record.AliasTarget?.HostedZoneId ?? '',
    evaluateTargetHealth: Boolean(record.AliasTarget?.EvaluateTargetHealth),
    setIdentifier: record.SetIdentifier ?? '',
    routingPolicy: inferRoutingPolicy(record)
  }
}

export async function listRoute53HostedZones(connection: AwsConnection): Promise<Route53HostedZoneSummary[]> {
  const client = createClient(connection)
  const zones: Route53HostedZoneSummary[] = []
  let dnsName: string | undefined
  let hostedZoneId: string | undefined

  while (true) {
    const output = await client.send(
      new ListHostedZonesByNameCommand({
        DNSName: dnsName,
        HostedZoneId: hostedZoneId
      })
    )

    for (const zone of output.HostedZones ?? []) {
      zones.push({
        id: normalizeHostedZoneId(zone.Id ?? ''),
        name: zone.Name ?? '-',
        privateZone: Boolean(zone.Config?.PrivateZone),
        recordSetCount: Number(zone.ResourceRecordSetCount ?? 0),
        comment: zone.Config?.Comment ?? ''
      })
    }

    if (!output.IsTruncated) {
      break
    }

    dnsName = output.NextDNSName
    hostedZoneId = output.NextHostedZoneId
  }

  return zones.sort((left, right) => left.name.localeCompare(right.name))
}

export async function listRoute53Records(
  connection: AwsConnection,
  hostedZoneId: string
): Promise<Route53RecordSummary[]> {
  const client = createClient(connection)
  const records: Route53RecordSummary[] = []
  let startRecordName: string | undefined
  let startRecordType: RRType | undefined
  let startRecordIdentifier: string | undefined

  while (true) {
    const output = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: normalizeHostedZoneId(hostedZoneId),
        StartRecordName: startRecordName,
        StartRecordType: startRecordType,
        StartRecordIdentifier: startRecordIdentifier
      })
    )

    for (const record of output.ResourceRecordSets ?? []) {
      records.push(toRecordSummary(record))
    }

    if (!output.IsTruncated) {
      break
    }

    startRecordName = output.NextRecordName
    startRecordType = output.NextRecordType
    startRecordIdentifier = output.NextRecordIdentifier
  }

  return records
}

export async function upsertRoute53Record(
  connection: AwsConnection,
  hostedZoneId: string,
  record: Route53RecordChange
): Promise<void> {
  const client = createClient(connection)

  await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: normalizeHostedZoneId(hostedZoneId),
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: toResourceRecordSet(record)
          }
        ]
      }
    })
  )
}

export async function deleteRoute53Record(
  connection: AwsConnection,
  hostedZoneId: string,
  record: Route53RecordChange
): Promise<void> {
  const client = createClient(connection)

  await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: normalizeHostedZoneId(hostedZoneId),
      ChangeBatch: {
        Changes: [
          {
            Action: 'DELETE',
            ResourceRecordSet: toResourceRecordSet(record)
          }
        ]
      }
    })
  )
}

export async function createRoute53HostedZone(
  connection: AwsConnection,
  input: Route53HostedZoneCreateInput
): Promise<Route53HostedZoneSummary> {
  const client = createClient(connection)
  const domainName = input.domainName.trim().replace(/\.+$/, '')

  if (!domainName) {
    throw new Error('Hosted zone domain name is required.')
  }

  if (input.privateZone && (!input.vpcId.trim() || !input.vpcRegion.trim())) {
    throw new Error('Private hosted zones require a VPC and region.')
  }

  const output = await client.send(
    new CreateHostedZoneCommand({
      Name: domainName,
      CallerReference: `aws-lens-${randomUUID()}`,
      HostedZoneConfig: {
        Comment: input.comment.trim() || undefined,
        PrivateZone: input.privateZone
      },
      VPC: input.privateZone
        ? {
            VPCId: input.vpcId.trim(),
            VPCRegion: input.vpcRegion.trim() as VPCRegion
          }
        : undefined
    })
  )

  const zone = output.HostedZone
  if (!zone?.Id) {
    throw new Error('Hosted zone was created but no hosted zone metadata was returned.')
  }

  return {
    id: normalizeHostedZoneId(zone.Id),
    name: zone.Name ?? `${domainName}.`,
    privateZone: Boolean(zone.Config?.PrivateZone),
    recordSetCount: Number(zone.ResourceRecordSetCount ?? 0),
    comment: zone.Config?.Comment ?? ''
  }
}
