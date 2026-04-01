import type {
  AwsConnection,
  EksAddonCompatibility,
  EksCommandHandoff,
  EksMaintenanceChecklistItem,
  EksNodegroupSummary,
  EksNodegroupUpgradeReadiness,
  EksUpgradePlan,
  EksUpgradePlannerRequest,
  EksVersionSkewStatus
} from '@shared/types'
import { describeEksCluster, listEksNodegroups, listEksUpdates } from './aws/eks'

function parseMinorVersion(value: string): number | null {
  const match = /^1\.(\d+)$/.exec(value.trim())
  if (!match) {
    return null
  }

  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function formatVersion(value: number | null, fallback: string): string {
  return value == null ? fallback : `1.${value}`
}

function nextSuggestedVersion(currentVersion: string, requestedTarget?: string): string {
  const requested = requestedTarget?.trim()
  if (requested) {
    return requested
  }

  const currentMinor = parseMinorVersion(currentVersion)
  return formatVersion(currentMinor == null ? null : currentMinor + 1, currentVersion)
}

function compareSkew(clusterVersion: string, nodegroupVersion: string): EksVersionSkewStatus {
  const clusterMinor = parseMinorVersion(clusterVersion)
  const nodeMinor = parseMinorVersion(nodegroupVersion)
  if (clusterMinor == null || nodeMinor == null) {
    return 'unknown'
  }
  if (clusterMinor === nodeMinor) {
    return 'aligned'
  }
  if (Math.abs(clusterMinor - nodeMinor) === 1) {
    return 'supported-skew'
  }
  return 'unsupported-skew'
}

function summarizeNodegroup(
  nodegroup: EksNodegroupSummary,
  clusterVersion: string,
  targetVersion: string
): EksNodegroupUpgradeReadiness {
  const currentVersion = nodegroup.version?.trim() || clusterVersion
  const skew = compareSkew(clusterVersion, currentVersion)
  const status = skew === 'unsupported-skew'
    ? 'blocked'
    : skew === 'supported-skew'
      ? 'warning'
      : 'ready'

  return {
    nodegroupName: nodegroup.name,
    currentVersion,
    targetVersion,
    status,
    detail: skew === 'aligned'
      ? 'Node group is aligned with the cluster version.'
      : skew === 'supported-skew'
        ? 'Node group is within one minor version and should be reviewed before upgrade.'
        : skew === 'unsupported-skew'
          ? 'Node group version skew exceeds the expected supported range.'
          : 'Node group version could not be derived from the current summary.',
    recommendedAction: status === 'ready'
      ? 'Keep rollout order documented and confirm add-on readiness.'
      : status === 'warning'
        ? 'Plan node group updates before or immediately after the control plane change.'
        : 'Resolve node group skew before scheduling the cluster upgrade.'
  }
}

function maintenanceChecklist(clusterName: string): EksMaintenanceChecklistItem[] {
  return [
    {
      id: 'window',
      title: 'Confirm maintenance window',
      status: 'todo',
      detail: `Choose an operator-owned window for ${clusterName} and confirm rollback ownership before starting.`
    },
    {
      id: 'workloads',
      title: 'Validate workload disruption posture',
      status: 'todo',
      detail: 'Review PodDisruptionBudgets, surge settings, and dependency expectations for cluster-critical workloads.'
    },
    {
      id: 'backups',
      title: 'Capture rollback artifacts',
      status: 'warning',
      detail: 'Record cluster version, node group versions, add-on versions, and recent updates before any change.'
    }
  ]
}

function commandHandoffs(connection: AwsConnection, clusterName: string, targetVersion: string): EksCommandHandoff[] {
  const profileArgs = connection.kind === 'profile' ? ` --profile ${connection.profile}` : ''

  return [
    {
      id: 'describe-cluster',
      label: 'Describe current cluster',
      shell: 'aws-cli',
      description: 'Confirm control-plane version, status, and endpoint posture immediately before scheduling the upgrade.',
      command: `aws eks describe-cluster --name ${clusterName} --region ${connection.region}${profileArgs}`
    },
    {
      id: 'update-cluster',
      label: 'Prepare control-plane upgrade command',
      shell: 'aws-cli',
      description: 'Handoff command only. This step remains read-only in the app during Phase 2 foundations.',
      command: `aws eks update-cluster-version --name ${clusterName} --kubernetes-version ${targetVersion} --region ${connection.region}${profileArgs}`
    },
    {
      id: 'kubectl-version',
      label: 'Capture kubectl compatibility context',
      shell: 'kubectl',
      description: 'Verify client compatibility and current cluster access before any operator-run change window.',
      command: 'kubectl version --short'
    }
  ]
}

function addonCompatibilitySkeleton(targetVersion: string): EksAddonCompatibility[] {
  return [
    {
      addonName: 'vpc-cni',
      currentVersion: 'unknown',
      targetVersion,
      status: 'unknown',
      detail: 'Add-on compatibility collection is scaffolded in foundations and will be expanded in the EKS planner step.'
    },
    {
      addonName: 'coredns',
      currentVersion: 'unknown',
      targetVersion,
      status: 'unknown',
      detail: 'Add-on compatibility collection is scaffolded in foundations and will be expanded in the EKS planner step.'
    },
    {
      addonName: 'kube-proxy',
      currentVersion: 'unknown',
      targetVersion,
      status: 'unknown',
      detail: 'Add-on compatibility collection is scaffolded in foundations and will be expanded in the EKS planner step.'
    }
  ]
}

export async function buildEksUpgradePlan(
  connection: AwsConnection,
  request: EksUpgradePlannerRequest
): Promise<EksUpgradePlan> {
  const clusterName = request.clusterName.trim()
  if (!clusterName) {
    throw new Error('Cluster name is required.')
  }

  const [cluster, nodegroups, updates] = await Promise.all([
    describeEksCluster(connection, clusterName),
    listEksNodegroups(connection, clusterName),
    listEksUpdates(connection, clusterName)
  ])
  const targetVersion = nextSuggestedVersion(cluster.version, request.targetVersion)
  const summarizedNodegroups = nodegroups.map((nodegroup) => summarizeNodegroup(nodegroup, cluster.version, targetVersion))
  const blockedNodegroups = summarizedNodegroups.filter((nodegroup) => nodegroup.status === 'blocked').length
  const warningNodegroups = summarizedNodegroups.filter((nodegroup) => nodegroup.status === 'warning').length

  return {
    generatedAt: new Date().toISOString(),
    clusterName,
    connectionLabel: connection.kind === 'profile' ? connection.profile : connection.label,
    profile: connection.profile,
    region: connection.region,
    currentClusterVersion: cluster.version,
    suggestedTargetVersion: targetVersion,
    supportStatus: blockedNodegroups > 0 ? 'blocked' : warningNodegroups > 0 ? 'warning' : 'ready',
    versionSkewStatus: blockedNodegroups > 0 ? 'unsupported-skew' : warningNodegroups > 0 ? 'supported-skew' : 'aligned',
    summary: blockedNodegroups > 0
      ? 'One or more node groups have unsupported skew relative to the cluster version.'
      : warningNodegroups > 0
        ? 'Node groups need review before or during the next upgrade window.'
        : 'Cluster and node group versions are aligned for a first-pass upgrade review.',
    warnings: [
      'This plan is read-only scaffolding in Phase 2 foundations and does not execute upgrades.',
      'Managed add-on compatibility is not yet collected from AWS and is represented as placeholder entries.'
    ],
    rollbackNotes: [
      'Capture the current control-plane version, node group versions, and recent update ids before the maintenance window.',
      'Plan rollback ownership outside the app because in-app execution is intentionally out of scope for this step.'
    ],
    recentUpdates: updates.slice(0, 10),
    nodegroups: summarizedNodegroups,
    addonCompatibilities: addonCompatibilitySkeleton(targetVersion),
    maintenanceChecklist: maintenanceChecklist(clusterName),
    commandHandoffs: commandHandoffs(connection, clusterName, targetVersion)
  }
}
