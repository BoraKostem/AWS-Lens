import {
  CreateDBClusterSnapshotCommand,
  CreateDBSnapshotCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  FailoverDBClusterCommand,
  ModifyDBInstanceCommand,
  RebootDBInstanceCommand,
  RDSClient,
  StartDBClusterCommand,
  StartDBInstanceCommand,
  StopDBClusterCommand,
  StopDBInstanceCommand,
  type DBCluster,
  type DBInstance
} from '@aws-sdk/client-rds'

import type {
  AwsConnection,
  RdsClusterDetail,
  RdsClusterNodeSummary,
  RdsClusterSummary,
  RdsInstanceDetail,
  RdsInstanceSummary
} from '@shared/types'
import { awsClientConfig } from './client'

function createClient(connection: AwsConnection): RDSClient {
  return new RDSClient(awsClientConfig(connection))
}

function isAuroraEngine(engine?: string): boolean {
  return (engine ?? '').startsWith('aurora')
}

function toInstanceSummary(item: DBInstance): RdsInstanceSummary {
  return {
    dbInstanceIdentifier: item.DBInstanceIdentifier ?? '-',
    engine: item.Engine ?? '-',
    engineVersion: item.EngineVersion ?? '-',
    dbInstanceClass: item.DBInstanceClass ?? '-',
    status: item.DBInstanceStatus ?? '-',
    endpoint: item.Endpoint?.Address ?? '-',
    port: item.Endpoint?.Port ?? null,
    multiAz: item.MultiAZ ?? false,
    allocatedStorage: item.AllocatedStorage ?? 0,
    availabilityZone: item.AvailabilityZone ?? '-',
    dbClusterIdentifier: item.DBClusterIdentifier ?? '',
    isAurora: isAuroraEngine(item.Engine)
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

async function listAllInstances(client: RDSClient): Promise<DBInstance[]> {
  const instances: DBInstance[] = []
  let marker: string | undefined

  do {
    const output = await client.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 }))
    instances.push(...(output.DBInstances ?? []))
    marker = output.Marker
  } while (marker)

  return instances
}

async function listAllClusters(client: RDSClient): Promise<DBCluster[]> {
  const clusters: DBCluster[] = []
  let marker: string | undefined

  do {
    const output = await client.send(new DescribeDBClustersCommand({ Marker: marker, MaxRecords: 100 }))
    clusters.push(...(output.DBClusters ?? []))
    marker = output.Marker
  } while (marker)

  return clusters
}

function toClusterNodeSummary(instance: DBInstance, role: 'writer' | 'reader', promotionTier?: number): RdsClusterNodeSummary {
  return {
    dbInstanceIdentifier: instance.DBInstanceIdentifier ?? '-',
    role,
    status: instance.DBInstanceStatus ?? '-',
    dbInstanceClass: instance.DBInstanceClass ?? '-',
    availabilityZone: instance.AvailabilityZone ?? '-',
    endpoint: instance.Endpoint?.Address ?? '-',
    port: instance.Endpoint?.Port ?? null,
    promotionTier: promotionTier ?? null
  }
}

export async function listDbInstances(connection: AwsConnection): Promise<RdsInstanceSummary[]> {
  const client = createClient(connection)
  const instances = await listAllInstances(client)

  return instances
    .filter((item) => !isAuroraEngine(item.Engine))
    .map(toInstanceSummary)
    .sort((left, right) => left.dbInstanceIdentifier.localeCompare(right.dbInstanceIdentifier))
}

export async function listDbClusters(connection: AwsConnection): Promise<RdsClusterSummary[]> {
  const client = createClient(connection)
  const [clusters, instances] = await Promise.all([listAllClusters(client), listAllInstances(client)])
  const instanceMap = new Map(instances.map((instance) => [instance.DBInstanceIdentifier ?? '', instance]))

  return clusters
    .filter((cluster) => isAuroraEngine(cluster.Engine))
    .map((cluster) => {
      const members = cluster.DBClusterMembers ?? []
      const writerNodes: RdsClusterNodeSummary[] = []
      const readerNodes: RdsClusterNodeSummary[] = []

      for (const member of members) {
        const identifier = member.DBInstanceIdentifier ?? ''
        const instance = instanceMap.get(identifier)
        if (!instance) {
          continue
        }
        const node = toClusterNodeSummary(instance, member.IsClusterWriter ? 'writer' : 'reader', member.PromotionTier)
        if (member.IsClusterWriter) writerNodes.push(node)
        else readerNodes.push(node)
      }

      writerNodes.sort((left, right) => left.dbInstanceIdentifier.localeCompare(right.dbInstanceIdentifier))
      readerNodes.sort((left, right) => left.dbInstanceIdentifier.localeCompare(right.dbInstanceIdentifier))

      return {
        dbClusterIdentifier: cluster.DBClusterIdentifier ?? '-',
        clusterArn: cluster.DBClusterArn ?? '-',
        engine: cluster.Engine ?? '-',
        engineVersion: cluster.EngineVersion ?? '-',
        status: cluster.Status ?? '-',
        endpoint: cluster.Endpoint ?? '-',
        readerEndpoint: cluster.ReaderEndpoint ?? '-',
        port: cluster.Port ?? null,
        multiAz: (cluster.AvailabilityZones?.length ?? 0) > 1,
        storageEncrypted: cluster.StorageEncrypted ?? false,
        writerNodes,
        readerNodes
      }
    })
    .sort((left, right) => left.dbClusterIdentifier.localeCompare(right.dbClusterIdentifier))
}

export async function describeDbInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<RdsInstanceDetail> {
  const client = createClient(connection)
  const output = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier }))
  const item = output.DBInstances?.[0]
  if (!item) {
    throw new Error(`RDS instance not found: ${dbInstanceIdentifier}`)
  }

  return {
    summary: toInstanceSummary(item),
    arn: item.DBInstanceArn ?? '-',
    resourceId: item.DbiResourceId ?? '-',
    storageType: item.StorageType ?? '-',
    storageEncrypted: item.StorageEncrypted ?? false,
    publiclyAccessible: item.PubliclyAccessible ?? false,
    backupRetentionPeriod: item.BackupRetentionPeriod ?? 0,
    preferredBackupWindow: item.PreferredBackupWindow ?? '-',
    preferredMaintenanceWindow: item.PreferredMaintenanceWindow ?? '-',
    caCertificateIdentifier: item.CACertificateIdentifier ?? '-',
    masterUsername: item.MasterUsername ?? '-',
    databaseName: item.DBName ?? '-',
    subnetGroup: item.DBSubnetGroup?.DBSubnetGroupName ?? '-',
    vpcSecurityGroupIds: (item.VpcSecurityGroups ?? []).map((group) => group.VpcSecurityGroupId ?? '-'),
    connectionDetails: [
      { label: 'Host', value: item.Endpoint?.Address ?? '-' },
      { label: 'Port', value: String(item.Endpoint?.Port ?? '-') },
      { label: 'Engine', value: item.Engine ?? '-' },
      { label: 'Database', value: item.DBName ?? '-' },
      { label: 'Username', value: item.MasterUsername ?? '-' },
      { label: 'IAM DB Auth', value: item.IAMDatabaseAuthenticationEnabled ? 'Enabled' : 'Disabled' }
    ],
    rawJson: stringify(item)
  }
}

export async function describeDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<RdsClusterDetail> {
  const client = createClient(connection)
  const [clusters, instances] = await Promise.all([
    client.send(new DescribeDBClustersCommand({ DBClusterIdentifier: dbClusterIdentifier })),
    listAllInstances(client)
  ])
  const cluster = clusters.DBClusters?.[0]
  if (!cluster) {
    throw new Error(`Aurora cluster not found: ${dbClusterIdentifier}`)
  }

  const instanceMap = new Map(instances.map((instance) => [instance.DBInstanceIdentifier ?? '', instance]))
  const writerNodes: RdsClusterNodeSummary[] = []
  const readerNodes: RdsClusterNodeSummary[] = []
  for (const member of cluster.DBClusterMembers ?? []) {
    const instance = instanceMap.get(member.DBInstanceIdentifier ?? '')
    if (!instance) continue
    const node = toClusterNodeSummary(instance, member.IsClusterWriter ? 'writer' : 'reader', member.PromotionTier)
    if (member.IsClusterWriter) writerNodes.push(node)
    else readerNodes.push(node)
  }

  const summary: RdsClusterSummary = {
    dbClusterIdentifier: cluster.DBClusterIdentifier ?? '-',
    clusterArn: cluster.DBClusterArn ?? '-',
    engine: cluster.Engine ?? '-',
    engineVersion: cluster.EngineVersion ?? '-',
    status: cluster.Status ?? '-',
    endpoint: cluster.Endpoint ?? '-',
    readerEndpoint: cluster.ReaderEndpoint ?? '-',
    port: cluster.Port ?? null,
    multiAz: (cluster.AvailabilityZones?.length ?? 0) > 1,
    storageEncrypted: cluster.StorageEncrypted ?? false,
    writerNodes,
    readerNodes
  }

  const minCapacity = cluster.ServerlessV2ScalingConfiguration?.MinCapacity
  const maxCapacity = cluster.ServerlessV2ScalingConfiguration?.MaxCapacity

  return {
    summary,
    databaseName: cluster.DatabaseName ?? '-',
    masterUsername: cluster.MasterUsername ?? '-',
    backupRetentionPeriod: cluster.BackupRetentionPeriod ?? 0,
    preferredBackupWindow: cluster.PreferredBackupWindow ?? '-',
    preferredMaintenanceWindow: cluster.PreferredMaintenanceWindow ?? '-',
    vpcSecurityGroupIds: (cluster.VpcSecurityGroups ?? []).map((group) => group.VpcSecurityGroupId ?? '-'),
    serverlessV2Scaling: minCapacity != null && maxCapacity != null ? `${minCapacity}-${maxCapacity} ACU` : '-',
    connectionDetails: [
      { label: 'Writer endpoint', value: cluster.Endpoint ?? '-' },
      { label: 'Reader endpoint', value: cluster.ReaderEndpoint ?? '-' },
      { label: 'Port', value: String(cluster.Port ?? '-') },
      { label: 'Engine', value: cluster.Engine ?? '-' },
      { label: 'Database', value: cluster.DatabaseName ?? '-' },
      { label: 'Username', value: cluster.MasterUsername ?? '-' }
    ],
    rawJson: stringify(cluster)
  }
}

export async function startDbInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }))
}

export async function stopDbInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new StopDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }))
}

export async function rebootDbInstance(connection: AwsConnection, dbInstanceIdentifier: string, forceFailover = false): Promise<void> {
  const client = createClient(connection)
  await client.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier, ForceFailover: forceFailover }))
}

export async function resizeDbInstance(connection: AwsConnection, dbInstanceIdentifier: string, dbInstanceClass: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new ModifyDBInstanceCommand({
    DBInstanceIdentifier: dbInstanceIdentifier,
    DBInstanceClass: dbInstanceClass,
    ApplyImmediately: true
  }))
}

export async function createDbSnapshot(connection: AwsConnection, dbInstanceIdentifier: string, dbSnapshotIdentifier: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new CreateDBSnapshotCommand({
    DBInstanceIdentifier: dbInstanceIdentifier,
    DBSnapshotIdentifier: dbSnapshotIdentifier
  }))
}

export async function startDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new StartDBClusterCommand({ DBClusterIdentifier: dbClusterIdentifier }))
}

export async function stopDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new StopDBClusterCommand({ DBClusterIdentifier: dbClusterIdentifier }))
}

export async function failoverDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new FailoverDBClusterCommand({ DBClusterIdentifier: dbClusterIdentifier }))
}

export async function createDbClusterSnapshot(connection: AwsConnection, dbClusterIdentifier: string, dbClusterSnapshotIdentifier: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new CreateDBClusterSnapshotCommand({
    DBClusterIdentifier: dbClusterIdentifier,
    DBClusterSnapshotIdentifier: dbClusterSnapshotIdentifier
  }))
}
