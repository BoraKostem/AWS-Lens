import {
  CreateDBClusterSnapshotCommand,
  CreateDBSnapshotCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribePendingMaintenanceActionsCommand,
  FailoverDBClusterCommand,
  ModifyDBInstanceCommand,
  RebootDBInstanceCommand,
  RDSClient,
  StartDBClusterCommand,
  StartDBInstanceCommand,
  StopDBClusterCommand,
  StopDBInstanceCommand,
  type DBCluster,
  type DBInstance,
  type PendingMaintenanceAction,
  type ResourcePendingMaintenanceActions
} from '@aws-sdk/client-rds'

import type {
  AwsConnection,
  RdsClusterDetail,
  RdsClusterFailoverReadiness,
  RdsClusterNodeSummary,
  RdsClusterSummary,
  RdsMaintenanceItem,
  RdsOperationalPosture,
  RdsPostureBadge,
  RdsRiskFinding,
  RdsSummaryTile,
  RdsInstanceDetail,
  RdsInstanceSummary
} from '@shared/types'
import { getAwsClient } from './client'

function isAuroraEngine(engine?: string): boolean {
  return (engine ?? '').startsWith('aurora')
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
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

async function listAllPendingMaintenance(client: RDSClient): Promise<ResourcePendingMaintenanceActions[]> {
  const resources: ResourcePendingMaintenanceActions[] = []
  let marker: string | undefined

  do {
    const output = await client.send(new DescribePendingMaintenanceActionsCommand({ Marker: marker, MaxRecords: 100 }))
    resources.push(...(output.PendingMaintenanceActions ?? []))
    marker = output.Marker
  } while (marker)

  return resources
}

function toIsoString(value: Date | undefined): string {
  return value ? value.toISOString() : '-'
}

function trimOrDash(value?: string | null): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : '-'
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => trimOrDash(value)).filter((value) => value !== '-'))]
}

function buildBadge(id: string, label: string, value: string, tone: RdsPostureBadge['tone']): RdsPostureBadge {
  return { id, label, value, tone }
}

function buildTile(id: string, label: string, value: string, tone: RdsSummaryTile['tone']): RdsSummaryTile {
  return { id, label, value, tone }
}

function pushFinding(
  findings: RdsRiskFinding[],
  recommendations: string[],
  finding: RdsRiskFinding
): void {
  findings.push(finding)
  if (!recommendations.includes(finding.recommendation)) {
    recommendations.push(finding.recommendation)
  }
}

function toMaintenanceItem(
  resource: ResourcePendingMaintenanceActions,
  action: PendingMaintenanceAction,
  resourceType: 'instance' | 'cluster'
): RdsMaintenanceItem {
  return {
    resourceIdentifier: resource.ResourceIdentifier ?? '-',
    resourceType,
    sourceIdentifier: resource.ResourceIdentifier?.split(':').pop() ?? '-',
    action: trimOrDash(action.Action),
    description: trimOrDash(action.Description ?? action.Action),
    autoAppliedAfter: toIsoString(action.AutoAppliedAfterDate),
    currentApplyDate: toIsoString(action.CurrentApplyDate),
    optInStatus: trimOrDash(action.OptInStatus)
  }
}

async function getPendingMaintenanceMap(client: RDSClient): Promise<Map<string, RdsMaintenanceItem[]>> {
  const resources = await listAllPendingMaintenance(client)
  const map = new Map<string, RdsMaintenanceItem[]>()

  for (const resource of resources) {
    const resourceIdentifier = resource.ResourceIdentifier
    if (!resourceIdentifier) continue
    const resourceType = resourceIdentifier.includes(':cluster:') ? 'cluster' : 'instance'
    const items = (resource.PendingMaintenanceActionDetails ?? []).map((action) =>
      toMaintenanceItem(resource, action, resourceType)
    )
    map.set(resourceIdentifier, items)
  }

  return map
}

function getInstanceMaintenanceItems(instance: DBInstance, maintenanceMap: Map<string, RdsMaintenanceItem[]>): RdsMaintenanceItem[] {
  return maintenanceMap.get(instance.DBInstanceArn ?? '') ?? []
}

function getClusterMaintenanceItems(
  cluster: DBCluster,
  memberInstances: DBInstance[],
  maintenanceMap: Map<string, RdsMaintenanceItem[]>
): RdsMaintenanceItem[] {
  const clusterItems = maintenanceMap.get(cluster.DBClusterArn ?? '') ?? []
  const memberItems = memberInstances.flatMap((instance) => maintenanceMap.get(instance.DBInstanceArn ?? '') ?? [])

  return [...clusterItems, ...memberItems].sort((left, right) => left.sourceIdentifier.localeCompare(right.sourceIdentifier))
}

function buildInstancePosture(item: DBInstance, maintenanceItems: RdsMaintenanceItem[]): RdsOperationalPosture {
  const findings: RdsRiskFinding[] = []
  const recommendations: string[] = []
  const backupRetentionPeriod = item.BackupRetentionPeriod ?? 0
  const encrypted = item.StorageEncrypted ?? false
  const publiclyAccessible = item.PubliclyAccessible ?? false
  const multiAz = item.MultiAZ ?? false
  const parameterGroupReferences = uniqueStrings((item.DBParameterGroups ?? []).map((group) => group.DBParameterGroupName))
  const subnetGroup = trimOrDash(item.DBSubnetGroup?.DBSubnetGroupName)
  const sourceInstanceIdentifier = trimOrDash(item.ReadReplicaSourceDBInstanceIdentifier)
  const replicaInstanceIdentifiers = uniqueStrings(item.ReadReplicaDBInstanceIdentifiers ?? [])

  if (backupRetentionPeriod === 0) {
    pushFinding(findings, recommendations, {
      id: 'backup-disabled',
      severity: 'risk',
      title: 'Backups disabled',
      message: 'Automated backups are disabled for this database instance.',
      recommendation: 'Set a non-zero backup retention period before the next maintenance cycle.'
    })
  } else if (backupRetentionPeriod < 7) {
    pushFinding(findings, recommendations, {
      id: 'backup-low',
      severity: 'warning',
      title: 'Low backup retention',
      message: `Backup retention is ${backupRetentionPeriod} day${backupRetentionPeriod === 1 ? '' : 's'}.`,
      recommendation: 'Review whether retention should be raised to at least seven days for operational recovery.'
    })
  }

  if (publiclyAccessible) {
    pushFinding(findings, recommendations, {
      id: 'public-access',
      severity: 'risk',
      title: 'Publicly accessible',
      message: 'The database exposes a publicly accessible endpoint.',
      recommendation: 'Verify network controls and prefer private-only access where possible.'
    })
  }

  if (!encrypted) {
    pushFinding(findings, recommendations, {
      id: 'not-encrypted',
      severity: 'risk',
      title: 'Encryption disabled',
      message: 'Storage encryption is not enabled for this instance.',
      recommendation: 'Plan migration to an encrypted instance for stronger data-at-rest protection.'
    })
  }

  if (!multiAz) {
    pushFinding(findings, recommendations, {
      id: 'single-az',
      severity: 'warning',
      title: 'Single-AZ posture',
      message: 'The instance does not have Multi-AZ failover protection.',
      recommendation: 'If this database serves production traffic, enable Multi-AZ or document the recovery path.'
    })
  }

  if (maintenanceItems.length > 0) {
    pushFinding(findings, recommendations, {
      id: 'pending-maintenance',
      severity: 'warning',
      title: 'Pending maintenance',
      message: `${maintenanceItems.length} pending maintenance action${maintenanceItems.length === 1 ? '' : 's'} detected.`,
      recommendation: 'Review pending maintenance items and schedule remediation inside the maintenance window.'
    })
  }

  if (!recommendations.length) {
    recommendations.push('No immediate operational posture warnings detected. Keep reviewing maintenance and backup settings during routine checks.')
  }

  return {
    badges: [
      buildBadge(
        'backups',
        'Backups',
        backupRetentionPeriod === 0 ? 'Disabled' : `${backupRetentionPeriod} days`,
        backupRetentionPeriod === 0 ? 'risk' : backupRetentionPeriod < 7 ? 'warning' : 'good'
      ),
      buildBadge('encryption', 'Encryption', encrypted ? 'Enabled' : 'Disabled', encrypted ? 'good' : 'risk'),
      buildBadge('access', 'Access', publiclyAccessible ? 'Public' : 'Private', publiclyAccessible ? 'risk' : 'good'),
      buildBadge('availability', 'Availability', multiAz ? 'Multi-AZ' : 'Single-AZ', multiAz ? 'good' : 'warning'),
      buildBadge('maintenance', 'Maintenance', maintenanceItems.length ? `${maintenanceItems.length} pending` : 'Clear', maintenanceItems.length ? 'warning' : 'good')
    ],
    summaryTiles: [
      buildTile('findings', 'Findings', String(findings.length), findings.some((item) => item.severity === 'risk') ? 'risk' : findings.length ? 'warning' : 'good'),
      buildTile('backup', 'Backup Retention', backupRetentionPeriod === 0 ? 'Disabled' : `${backupRetentionPeriod} days`, backupRetentionPeriod === 0 ? 'risk' : backupRetentionPeriod < 7 ? 'warning' : 'good'),
      buildTile('maintenance', 'Maintenance', maintenanceItems.length ? `${maintenanceItems.length} pending` : 'No pending', maintenanceItems.length ? 'warning' : 'good'),
      buildTile('replicas', 'Replicas', replicaInstanceIdentifiers.length ? String(replicaInstanceIdentifiers.length) : 'None', replicaInstanceIdentifiers.length ? 'neutral' : 'neutral')
    ],
    findings,
    maintenanceItems,
    recommendations,
    parameterGroupReferences,
    subnetGroupReferences: subnetGroup === '-' ? [] : [subnetGroup],
    backupRetentionPeriod,
    preferredBackupWindow: trimOrDash(item.PreferredBackupWindow),
    preferredMaintenanceWindow: trimOrDash(item.PreferredMaintenanceWindow),
    isEncrypted: encrypted,
    isPubliclyAccessible: publiclyAccessible,
    isMultiAz: multiAz,
    replicaTopology: {
      sourceInstanceIdentifier,
      replicaInstanceIdentifiers
    }
  }
}

function buildClusterFailoverReadiness(cluster: DBCluster, nodes: RdsClusterNodeSummary[]): RdsClusterFailoverReadiness {
  const writerNodes = nodes.filter((node) => node.role === 'writer')
  const readyReaders = nodes.filter((node) => node.role === 'reader' && node.status === 'available')
  const reasons: string[] = []

  if (!writerNodes.some((node) => node.status === 'available')) {
    reasons.push('No writer node is currently reported as available.')
  }
  if (readyReaders.length === 0) {
    reasons.push('No reader node is available as a failover target.')
  }
  if ((cluster.AvailabilityZones?.length ?? 0) < 2) {
    reasons.push('Cluster spans fewer than two availability zones.')
  }

  return {
    ready: reasons.length === 0,
    summary: reasons.length === 0 ? 'Ready for managed failover' : 'Failover posture needs review',
    reasons
  }
}

function buildClusterPosture(
  cluster: DBCluster,
  memberInstances: DBInstance[],
  nodes: RdsClusterNodeSummary[],
  maintenanceItems: RdsMaintenanceItem[]
): RdsOperationalPosture {
  const findings: RdsRiskFinding[] = []
  const recommendations: string[] = []
  const backupRetentionPeriod = cluster.BackupRetentionPeriod ?? 0
  const encrypted = cluster.StorageEncrypted ?? false
  const multiAz = (cluster.AvailabilityZones?.length ?? 0) > 1
  const parameterGroupReferences = uniqueStrings([
    cluster.DBClusterParameterGroup,
    ...memberInstances.flatMap((instance) => (instance.DBParameterGroups ?? []).map((group) => group.DBParameterGroupName))
  ])
  const subnetGroup = trimOrDash(cluster.DBSubnetGroup)
  const failoverReadiness = buildClusterFailoverReadiness(cluster, nodes)
  const publiclyAccessible = memberInstances.some((instance) => instance.PubliclyAccessible ?? false)

  if (backupRetentionPeriod === 0) {
    pushFinding(findings, recommendations, {
      id: 'backup-disabled',
      severity: 'risk',
      title: 'Backups disabled',
      message: 'Automated backups are disabled for this Aurora cluster.',
      recommendation: 'Set a non-zero backup retention period to improve recoverability.'
    })
  } else if (backupRetentionPeriod < 7) {
    pushFinding(findings, recommendations, {
      id: 'backup-low',
      severity: 'warning',
      title: 'Low backup retention',
      message: `Backup retention is ${backupRetentionPeriod} day${backupRetentionPeriod === 1 ? '' : 's'}.`,
      recommendation: 'Review whether retention should be increased for recovery objectives.'
    })
  }

  if (publiclyAccessible) {
    pushFinding(findings, recommendations, {
      id: 'public-access',
      severity: 'risk',
      title: 'Publicly accessible node',
      message: 'At least one cluster member is publicly accessible.',
      recommendation: 'Review whether every cluster node should remain private to the VPC.'
    })
  }

  if (!encrypted) {
    pushFinding(findings, recommendations, {
      id: 'not-encrypted',
      severity: 'risk',
      title: 'Encryption disabled',
      message: 'Cluster storage encryption is not enabled.',
      recommendation: 'Plan migration to an encrypted cluster to improve data-at-rest protection.'
    })
  }

  if (!multiAz) {
    pushFinding(findings, recommendations, {
      id: 'single-az',
      severity: 'warning',
      title: 'Single-AZ posture',
      message: 'The cluster is not distributed across multiple availability zones.',
      recommendation: 'If this cluster carries production traffic, review AZ placement and failover design.'
    })
  }

  if (!failoverReadiness.ready) {
    pushFinding(findings, recommendations, {
      id: 'failover-readiness',
      severity: 'warning',
      title: 'Failover readiness requires review',
      message: failoverReadiness.reasons.join(' '),
      recommendation: 'Keep at least one healthy reader in another AZ before depending on cluster failover.'
    })
  }

  if (maintenanceItems.length > 0) {
    pushFinding(findings, recommendations, {
      id: 'pending-maintenance',
      severity: 'warning',
      title: 'Pending maintenance',
      message: `${maintenanceItems.length} pending maintenance action${maintenanceItems.length === 1 ? '' : 's'} detected across the cluster and its members.`,
      recommendation: 'Review and schedule maintenance work before the next operational change window.'
    })
  }

  if (!recommendations.length) {
    recommendations.push('No immediate operational posture warnings detected. Keep reader capacity and maintenance posture under review.')
  }

  const readerCount = nodes.filter((node) => node.role === 'reader').length

  return {
    badges: [
      buildBadge(
        'backups',
        'Backups',
        backupRetentionPeriod === 0 ? 'Disabled' : `${backupRetentionPeriod} days`,
        backupRetentionPeriod === 0 ? 'risk' : backupRetentionPeriod < 7 ? 'warning' : 'good'
      ),
      buildBadge('encryption', 'Encryption', encrypted ? 'Enabled' : 'Disabled', encrypted ? 'good' : 'risk'),
      buildBadge('access', 'Access', publiclyAccessible ? 'Public node' : 'Private', publiclyAccessible ? 'risk' : 'good'),
      buildBadge('failover', 'Failover', failoverReadiness.ready ? 'Ready' : 'Review', failoverReadiness.ready ? 'good' : 'warning'),
      buildBadge('maintenance', 'Maintenance', maintenanceItems.length ? `${maintenanceItems.length} pending` : 'Clear', maintenanceItems.length ? 'warning' : 'good')
    ],
    summaryTiles: [
      buildTile('findings', 'Findings', String(findings.length), findings.some((item) => item.severity === 'risk') ? 'risk' : findings.length ? 'warning' : 'good'),
      buildTile('backup', 'Backup Retention', backupRetentionPeriod === 0 ? 'Disabled' : `${backupRetentionPeriod} days`, backupRetentionPeriod === 0 ? 'risk' : backupRetentionPeriod < 7 ? 'warning' : 'good'),
      buildTile('readers', 'Readers', String(readerCount), readerCount > 0 ? 'good' : 'warning'),
      buildTile('maintenance', 'Maintenance', maintenanceItems.length ? `${maintenanceItems.length} pending` : 'No pending', maintenanceItems.length ? 'warning' : 'good')
    ],
    findings,
    maintenanceItems,
    recommendations,
    parameterGroupReferences,
    subnetGroupReferences: subnetGroup === '-' ? [] : [subnetGroup],
    backupRetentionPeriod,
    preferredBackupWindow: trimOrDash(cluster.PreferredBackupWindow),
    preferredMaintenanceWindow: trimOrDash(cluster.PreferredMaintenanceWindow),
    isEncrypted: encrypted,
    isPubliclyAccessible: publiclyAccessible,
    isMultiAz: multiAz,
    failoverReadiness
  }
}

export async function listDbInstances(connection: AwsConnection): Promise<RdsInstanceSummary[]> {
  const client = getAwsClient(RDSClient, connection)
  const instances = await listAllInstances(client)

  return instances
    .filter((item) => !isAuroraEngine(item.Engine))
    .map(toInstanceSummary)
    .sort((left, right) => left.dbInstanceIdentifier.localeCompare(right.dbInstanceIdentifier))
}

export async function listDbClusters(connection: AwsConnection): Promise<RdsClusterSummary[]> {
  const client = getAwsClient(RDSClient, connection)
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
        if (!instance) continue
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
  const client = getAwsClient(RDSClient, connection)
  const [output, maintenanceMap] = await Promise.all([
    client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier })),
    getPendingMaintenanceMap(client)
  ])
  const item = output.DBInstances?.[0]
  if (!item) {
    throw new Error(`RDS instance not found: ${dbInstanceIdentifier}`)
  }

  const posture = buildInstancePosture(item, getInstanceMaintenanceItems(item, maintenanceMap))

  return {
    summary: toInstanceSummary(item),
    arn: item.DBInstanceArn ?? '-',
    resourceId: item.DbiResourceId ?? '-',
    storageType: item.StorageType ?? '-',
    storageEncrypted: item.StorageEncrypted ?? false,
    publiclyAccessible: item.PubliclyAccessible ?? false,
    backupRetentionPeriod: item.BackupRetentionPeriod ?? 0,
    preferredBackupWindow: trimOrDash(item.PreferredBackupWindow),
    preferredMaintenanceWindow: trimOrDash(item.PreferredMaintenanceWindow),
    caCertificateIdentifier: item.CACertificateIdentifier ?? '-',
    masterUsername: item.MasterUsername ?? '-',
    databaseName: item.DBName ?? '-',
    managesMasterUserPassword: item.MasterUserSecret != null,
    masterUserSecretArn: item.MasterUserSecret?.SecretArn ?? '-',
    masterUserSecretKmsKeyId: item.MasterUserSecret?.KmsKeyId ?? '-',
    subnetGroup: trimOrDash(item.DBSubnetGroup?.DBSubnetGroupName),
    parameterGroups: posture.parameterGroupReferences,
    vpcSecurityGroupIds: (item.VpcSecurityGroups ?? []).map((group) => group.VpcSecurityGroupId ?? '-'),
    posture,
    connectionDetails: [
      { label: 'Host', value: item.Endpoint?.Address ?? '-' },
      { label: 'Port', value: String(item.Endpoint?.Port ?? '-') },
      { label: 'Engine', value: item.Engine ?? '-' },
      { label: 'Database', value: item.DBName ?? '-' },
      { label: 'Username', value: item.MasterUsername ?? '-' },
      { label: 'Resource ID', value: item.DbiResourceId ?? '-' },
      { label: 'Cluster', value: item.DBClusterIdentifier ?? '-' },
      { label: 'IAM DB Auth', value: item.IAMDatabaseAuthenticationEnabled ? 'Enabled' : 'Disabled' },
      { label: 'Managed Secret', value: item.MasterUserSecret?.SecretArn ?? '-' }
    ],
    rawJson: stringify(item)
  }
}

export async function describeDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<RdsClusterDetail> {
  const client = getAwsClient(RDSClient, connection)
  const [clusters, instances, maintenanceMap] = await Promise.all([
    client.send(new DescribeDBClustersCommand({ DBClusterIdentifier: dbClusterIdentifier })),
    listAllInstances(client),
    getPendingMaintenanceMap(client)
  ])
  const cluster = clusters.DBClusters?.[0]
  if (!cluster) {
    throw new Error(`Aurora cluster not found: ${dbClusterIdentifier}`)
  }

  const instanceMap = new Map(instances.map((instance) => [instance.DBInstanceIdentifier ?? '', instance]))
  const memberInstances: DBInstance[] = []
  const writerNodes: RdsClusterNodeSummary[] = []
  const readerNodes: RdsClusterNodeSummary[] = []

  for (const member of cluster.DBClusterMembers ?? []) {
    const instance = instanceMap.get(member.DBInstanceIdentifier ?? '')
    if (!instance) continue
    memberInstances.push(instance)
    const node = toClusterNodeSummary(instance, member.IsClusterWriter ? 'writer' : 'reader', member.PromotionTier)
    if (member.IsClusterWriter) writerNodes.push(node)
    else readerNodes.push(node)
  }

  writerNodes.sort((left, right) => left.dbInstanceIdentifier.localeCompare(right.dbInstanceIdentifier))
  readerNodes.sort((left, right) => left.dbInstanceIdentifier.localeCompare(right.dbInstanceIdentifier))

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
  const nodes = [...writerNodes, ...readerNodes]
  const posture = buildClusterPosture(cluster, memberInstances, nodes, getClusterMaintenanceItems(cluster, memberInstances, maintenanceMap))

  return {
    summary,
    databaseName: cluster.DatabaseName ?? '-',
    masterUsername: cluster.MasterUsername ?? '-',
    backupRetentionPeriod: cluster.BackupRetentionPeriod ?? 0,
    preferredBackupWindow: trimOrDash(cluster.PreferredBackupWindow),
    preferredMaintenanceWindow: trimOrDash(cluster.PreferredMaintenanceWindow),
    managesMasterUserPassword: cluster.MasterUserSecret != null,
    masterUserSecretArn: cluster.MasterUserSecret?.SecretArn ?? '-',
    masterUserSecretKmsKeyId: cluster.MasterUserSecret?.KmsKeyId ?? '-',
    parameterGroups: posture.parameterGroupReferences,
    subnetGroup: trimOrDash(cluster.DBSubnetGroup),
    vpcSecurityGroupIds: (cluster.VpcSecurityGroups ?? []).map((group) => group.VpcSecurityGroupId ?? '-'),
    serverlessV2Scaling: minCapacity != null && maxCapacity != null ? `${minCapacity}-${maxCapacity} ACU` : '-',
    posture,
    connectionDetails: [
      { label: 'Writer endpoint', value: cluster.Endpoint ?? '-' },
      { label: 'Reader endpoint', value: cluster.ReaderEndpoint ?? '-' },
      { label: 'Port', value: String(cluster.Port ?? '-') },
      { label: 'Engine', value: cluster.Engine ?? '-' },
      { label: 'Database', value: cluster.DatabaseName ?? '-' },
      { label: 'Username', value: cluster.MasterUsername ?? '-' },
      { label: 'Cluster ARN', value: cluster.DBClusterArn ?? '-' },
      { label: 'Managed Secret', value: cluster.MasterUserSecret?.SecretArn ?? '-' }
    ],
    rawJson: stringify(cluster)
  }
}

export async function startDbInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }))
}

export async function stopDbInstance(connection: AwsConnection, dbInstanceIdentifier: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new StopDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier }))
}

export async function rebootDbInstance(connection: AwsConnection, dbInstanceIdentifier: string, forceFailover = false): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: dbInstanceIdentifier, ForceFailover: forceFailover }))
}

export async function resizeDbInstance(connection: AwsConnection, dbInstanceIdentifier: string, dbInstanceClass: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new ModifyDBInstanceCommand({
    DBInstanceIdentifier: dbInstanceIdentifier,
    DBInstanceClass: dbInstanceClass,
    ApplyImmediately: true
  }))
}

export async function createDbSnapshot(connection: AwsConnection, dbInstanceIdentifier: string, dbSnapshotIdentifier: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new CreateDBSnapshotCommand({
    DBInstanceIdentifier: dbInstanceIdentifier,
    DBSnapshotIdentifier: dbSnapshotIdentifier
  }))
}

export async function startDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new StartDBClusterCommand({ DBClusterIdentifier: dbClusterIdentifier }))
}

export async function stopDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new StopDBClusterCommand({ DBClusterIdentifier: dbClusterIdentifier }))
}

export async function failoverDbCluster(connection: AwsConnection, dbClusterIdentifier: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new FailoverDBClusterCommand({ DBClusterIdentifier: dbClusterIdentifier }))
}

export async function createDbClusterSnapshot(connection: AwsConnection, dbClusterIdentifier: string, dbClusterSnapshotIdentifier: string): Promise<void> {
  const client = getAwsClient(RDSClient, connection)
  await client.send(new CreateDBClusterSnapshotCommand({
    DBClusterIdentifier: dbClusterIdentifier,
    DBClusterSnapshotIdentifier: dbClusterSnapshotIdentifier
  }))
}
