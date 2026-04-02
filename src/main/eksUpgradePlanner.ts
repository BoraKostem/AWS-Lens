import type {
  AwsConnection,
  EksAddonCompatibility,
  EksCommandHandoff,
  EksMaintenanceChecklistItem,
  EksNodegroupSummary,
  EksNodegroupUpgradeReadiness,
  EksUpgradePlan,
  EksUpgradePlannerRequest,
  EksUpgradeSupportStatus,
  EksVersionSkewStatus
} from '@shared/types'
import {
  describeEksCluster,
  getEksAddonVersionCompatibility,
  listEksAddons,
  listEksNodegroups,
  listEksUpdates
} from './aws/eks'

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

function chooseTargetVersion(currentVersion: string, requestedTarget?: string): string {
  const requested = requestedTarget?.trim()
  if (requested) {
    return requested
  }

  const currentMinor = parseMinorVersion(currentVersion)
  return formatVersion(currentMinor == null ? null : currentMinor + 1, currentVersion)
}

function commandProfileArgs(connection: AwsConnection): string {
  return connection.kind === 'profile' ? ` --profile ${connection.profile}` : ''
}

function commandHandoffs(connection: AwsConnection, clusterName: string, targetVersion: string): EksCommandHandoff[] {
  const profileArgs = commandProfileArgs(connection)

  return [
    {
      id: 'describe-cluster',
      label: 'Describe current cluster',
      shell: 'aws-cli',
      description: 'Confirm control-plane version, endpoint posture, and health issues before the change window.',
      command: `aws eks describe-cluster --name ${clusterName} --region ${connection.region}${profileArgs}`
    },
    {
      id: 'list-nodegroups',
      label: 'Capture nodegroup versions',
      shell: 'aws-cli',
      description: 'Record current nodegroup versions and release versions before the control-plane update.',
      command: `aws eks list-nodegroups --cluster-name ${clusterName} --region ${connection.region}${profileArgs}`
    },
    {
      id: 'update-cluster',
      label: 'Prepare control-plane upgrade command',
      shell: 'aws-cli',
      description: 'Phase 2 remains read-only in-app. This is a handoff snippet for an operator-run window.',
      command: `aws eks update-cluster-version --name ${clusterName} --kubernetes-version ${targetVersion} --region ${connection.region}${profileArgs}`
    },
    {
      id: 'kubectl-nodes',
      label: 'Check workload and node readiness',
      shell: 'shell',
      description: 'Refresh kubeconfig and confirm node and workload readiness before and after the change.',
      command: `aws eks update-kubeconfig --name ${clusterName} --region ${connection.region}${profileArgs}; kubectl version --short; kubectl get nodes -o wide; kubectl get pods -A --field-selector=status.phase!=Running`
    }
  ]
}

function summarizeClusterBlockers(clusterStatus: string, healthIssues: string[]): { status: EksUpgradeSupportStatus; warnings: string[] } {
  const warnings: string[] = []
  let status: EksUpgradeSupportStatus = 'ready'

  if (clusterStatus !== 'ACTIVE') {
    status = 'blocked'
    warnings.push(`Cluster status is ${clusterStatus}. Control-plane upgrades should wait for ACTIVE status.`)
  }

  if (healthIssues.length > 0) {
    status = 'blocked'
    warnings.push(`Cluster health reports ${healthIssues.length} issue${healthIssues.length === 1 ? '' : 's'}. Resolve health warnings first.`)
  }

  return { status, warnings }
}

function summarizeNodegroup(
  nodegroup: EksNodegroupSummary,
  clusterVersion: string,
  targetVersion: string
): EksNodegroupUpgradeReadiness {
  const currentVersion = nodegroup.version?.trim() || clusterVersion
  const currentMinor = parseMinorVersion(currentVersion)
  const targetMinor = parseMinorVersion(targetVersion)
  const skew = compareSkew(clusterVersion, currentVersion)
  const desired = Number(nodegroup.desired || 0)
  const min = Number(nodegroup.min || 0)
  const max = Number(nodegroup.max || 0)

  let status: EksUpgradeSupportStatus = 'ready'
  const notes: string[] = []
  const actions: string[] = []

  if (nodegroup.status !== 'ACTIVE') {
    status = 'blocked'
    notes.push(`Nodegroup status is ${nodegroup.status}.`)
    actions.push('Wait for the nodegroup to return to ACTIVE before upgrading.')
  }

  if (skew === 'unsupported-skew') {
    status = 'blocked'
    notes.push('Nodegroup version skew is beyond the expected supported range.')
    actions.push('Upgrade or replace the nodegroup before the control-plane change.')
  } else if (skew === 'supported-skew' && status !== 'blocked') {
    status = 'warning'
    notes.push('Nodegroup is one minor version away from the control plane.')
    actions.push('Schedule nodegroup version updates in the same maintenance window.')
  }

  if (targetMinor != null && currentMinor != null && targetMinor - currentMinor > 1) {
    status = 'blocked'
    notes.push('Requested target is more than one minor ahead of the nodegroup version.')
    actions.push('Upgrade in supported minor-version increments.')
  }

  if (desired === 0 && status !== 'blocked') {
    status = 'warning'
    notes.push('Desired capacity is 0, so live workload validation will be limited.')
    actions.push('Validate workload scheduling and autoscaling posture before starting.')
  }

  if ((Number.isFinite(min) && Number.isFinite(max) && min > max) || (Number.isFinite(desired) && desired > max)) {
    status = 'blocked'
    notes.push('Scaling configuration appears inconsistent.')
    actions.push('Correct min/desired/max before the upgrade window.')
  }

  if (notes.length === 0) {
    notes.push('Version and scaling posture look compatible with a next-step upgrade review.')
    actions.push('Keep rollout order and surge expectations documented for this nodegroup.')
  }

  return {
    nodegroupName: nodegroup.name,
    currentVersion,
    targetVersion,
    status,
    detail: [
      notes.join(' '),
      `Status: ${nodegroup.status}. Desired/min/max: ${nodegroup.desired}/${nodegroup.min}/${nodegroup.max}.`,
      nodegroup.releaseVersion && nodegroup.releaseVersion !== '-' ? `Release: ${nodegroup.releaseVersion}.` : '',
      nodegroup.capacityType && nodegroup.capacityType !== '-' ? `Capacity: ${nodegroup.capacityType}.` : '',
      nodegroup.amiType && nodegroup.amiType !== '-' ? `AMI type: ${nodegroup.amiType}.` : ''
    ].filter(Boolean).join(' '),
    recommendedAction: actions.join(' ')
  }
}

async function buildAddonCompatibilities(
  connection: AwsConnection,
  clusterName: string,
  targetVersion: string
): Promise<EksAddonCompatibility[]> {
  const addons = await listEksAddons(connection, clusterName)
  if (addons.length === 0) {
    return [
      {
        addonName: 'managed-addons',
        currentVersion: '-',
        targetVersion,
        status: 'warning',
        detail: 'No managed EKS add-ons were detected. Verify self-managed CNI, CoreDNS, and kube-proxy components separately.'
      }
    ]
  }

  const compatibilities = await Promise.all(
    addons.map(async (addon) => {
      const compatibility = await getEksAddonVersionCompatibility(connection, addon.addonName, targetVersion).catch(() => null)
      const recommendedVersion = compatibility?.recommendedVersion ?? '-'
      const compatibleVersions = compatibility?.compatibleVersions ?? []
      let status: EksUpgradeSupportStatus = 'ready'
      let detail = ''

      if (addon.status !== 'ACTIVE') {
        status = 'blocked'
        detail = `${addon.addonName} is ${addon.status}. Stabilize the managed add-on before the upgrade.`
      } else if (compatibleVersions.length === 0) {
        status = 'warning'
        detail = `Could not confirm compatible ${addon.addonName} versions for Kubernetes ${targetVersion}. Verify with AWS before scheduling the upgrade.`
      } else if (addon.addonVersion === recommendedVersion) {
        detail = `${addon.addonName} is already on the default compatible version for Kubernetes ${targetVersion}.`
      } else {
        status = 'warning'
        detail = `Current version ${addon.addonVersion} should be reviewed against compatible targets for Kubernetes ${targetVersion}. Recommended compatible version: ${recommendedVersion}.`
      }

      return {
        addonName: addon.addonName,
        currentVersion: addon.addonVersion,
        targetVersion: compatibleVersions[0] ?? recommendedVersion,
        status,
        detail
      }
    })
  )

  return compatibilities.sort((left, right) => left.addonName.localeCompare(right.addonName))
}

function buildMaintenanceChecklist(
  clusterName: string,
  clusterStatus: string,
  healthIssues: string[],
  nodegroups: EksNodegroupUpgradeReadiness[],
  recentFailedUpdates: number,
  loggingEnabled: string[]
): EksMaintenanceChecklistItem[] {
  return [
    {
      id: 'cluster-health',
      title: 'Confirm control-plane health',
      status: clusterStatus === 'ACTIVE' && healthIssues.length === 0 ? 'ready' : 'warning',
      detail: clusterStatus === 'ACTIVE' && healthIssues.length === 0
        ? `${clusterName} is ACTIVE with no reported cluster health issues.`
        : `Review control-plane status (${clusterStatus}) and resolve ${healthIssues.length} health issue${healthIssues.length === 1 ? '' : 's'} before the window.`
    },
    {
      id: 'nodegroups',
      title: 'Validate nodegroup rollout order',
      status: nodegroups.some((nodegroup) => nodegroup.status === 'blocked') ? 'warning' : 'todo',
      detail: nodegroups.some((nodegroup) => nodegroup.status === 'blocked')
        ? 'At least one nodegroup is blocked. Clear nodegroup issues before moving the control plane.'
        : 'Document which nodegroups update immediately after the control plane and who owns rollback decisions.'
    },
    {
      id: 'addons',
      title: 'Capture add-on version plan',
      status: loggingEnabled.length > 0 ? 'todo' : 'warning',
      detail: loggingEnabled.length > 0
        ? 'Record managed add-on versions and the target compatible versions before making changes.'
        : 'Control-plane logging is limited. Capture add-on and workload evidence manually before the upgrade.'
    },
    {
      id: 'updates',
      title: 'Review recent cluster updates',
      status: recentFailedUpdates > 0 ? 'warning' : 'ready',
      detail: recentFailedUpdates > 0
        ? `${recentFailedUpdates} recent update event${recentFailedUpdates === 1 ? '' : 's'} ended in a non-success status. Review them before proceeding.`
        : 'Recent update history does not show failed control-plane or nodegroup updates.'
    }
  ]
}

function deriveSupportStatus(statuses: EksUpgradeSupportStatus[]): EksUpgradeSupportStatus {
  if (statuses.includes('blocked')) {
    return 'blocked'
  }
  if (statuses.includes('warning')) {
    return 'warning'
  }
  if (statuses.includes('ready')) {
    return 'ready'
  }
  return 'unknown'
}

function deriveSkewStatus(nodegroups: EksNodegroupUpgradeReadiness[]): EksVersionSkewStatus {
  const statuses = nodegroups.map((nodegroup) => nodegroup.status)
  if (statuses.includes('blocked')) {
    return 'unsupported-skew'
  }
  if (statuses.includes('warning')) {
    return 'supported-skew'
  }
  return 'aligned'
}

function buildRollbackNotes(
  clusterName: string,
  targetVersion: string,
  healthIssues: string[],
  recentFailedUpdates: number
): string[] {
  return [
    `Capture the current cluster version, platform version, nodegroup versions, and managed add-on versions for ${clusterName} before changing the control plane.`,
    `If the upgrade to Kubernetes ${targetVersion} must pause, keep rollback ownership outside the app and preserve the recent update ids for AWS support and audit review.`,
    recentFailedUpdates > 0
      ? 'Because recent updates include failures, document the prior failure modes and operator decisions in the maintenance notes before retrying.'
      : 'Record a quick preflight snapshot of workload readiness, cluster events, and control-plane health so the team can compare post-upgrade state.',
    healthIssues.length > 0
      ? 'Do not treat current health issues as acceptable background noise; unresolved cluster health warnings make rollback and diagnosis materially harder.'
      : 'No active cluster health issues were reported at plan time, which reduces rollback ambiguity if the change window needs to stop.'
  ]
}

function buildSummary(
  clusterName: string,
  supportStatus: EksUpgradeSupportStatus,
  targetVersion: string,
  warningNodegroups: number,
  warningAddons: number
): string {
  if (supportStatus === 'blocked') {
    return `${clusterName} is not ready for a control-plane move to ${targetVersion}. Clear blocked nodegroup or add-on issues first.`
  }
  if (supportStatus === 'warning') {
    return `${clusterName} can be reviewed for ${targetVersion}, but ${warningNodegroups} nodegroup and ${warningAddons} add-on checks still need operator attention.`
  }
  return `${clusterName} is in a healthy read-only posture for a next-step review toward Kubernetes ${targetVersion}.`
}

export async function buildEksUpgradePlan(
  connection: AwsConnection,
  request: EksUpgradePlannerRequest
): Promise<EksUpgradePlan> {
  const clusterName = request.clusterName.trim()
  if (!clusterName) {
    throw new Error('Cluster name is required.')
  }

  const cluster = await describeEksCluster(connection, clusterName)
  const targetVersion = chooseTargetVersion(cluster.version, request.targetVersion)
  const [nodegroups, updates, addonCompatibilities] = await Promise.all([
    listEksNodegroups(connection, clusterName),
    listEksUpdates(connection, clusterName),
    buildAddonCompatibilities(connection, clusterName, targetVersion)
  ])

  const clusterSignals = summarizeClusterBlockers(cluster.status, cluster.healthIssues)
  const nodegroupReadiness = nodegroups.map((nodegroup) => summarizeNodegroup(nodegroup, cluster.version, targetVersion))
  const recentFailedUpdates = updates.filter((update) => !['Successful', 'InProgress'].includes(update.status)).length
  const warningNodegroups = nodegroupReadiness.filter((nodegroup) => nodegroup.status === 'warning').length
  const warningAddons = addonCompatibilities.filter((addon) => addon.status === 'warning').length

  const supportStatus = deriveSupportStatus([
    clusterSignals.status,
    ...nodegroupReadiness.map((nodegroup) => nodegroup.status),
    ...addonCompatibilities.map((addon) => addon.status),
    recentFailedUpdates > 0 ? 'warning' : 'ready'
  ])

  const warnings = [
    ...clusterSignals.warnings,
    ...(recentFailedUpdates > 0
      ? [`Recent update history includes ${recentFailedUpdates} non-success event${recentFailedUpdates === 1 ? '' : 's'}.`]
      : []),
    ...(cluster.loggingEnabled.length === 0
      ? ['Control-plane logging is disabled. Capture extra evidence during the change window because log-based diagnostics will be limited.']
      : [])
  ]

  return {
    generatedAt: new Date().toISOString(),
    clusterName,
    connectionLabel: connection.kind === 'profile' ? connection.profile : connection.label,
    profile: connection.profile,
    region: connection.region,
    currentClusterVersion: cluster.version,
    suggestedTargetVersion: targetVersion,
    supportStatus,
    versionSkewStatus: deriveSkewStatus(nodegroupReadiness),
    summary: buildSummary(clusterName, supportStatus, targetVersion, warningNodegroups, warningAddons),
    warnings,
    rollbackNotes: buildRollbackNotes(clusterName, targetVersion, cluster.healthIssues, recentFailedUpdates),
    recentUpdates: updates.slice(0, 10),
    nodegroups: nodegroupReadiness,
    addonCompatibilities,
    maintenanceChecklist: buildMaintenanceChecklist(
      clusterName,
      cluster.status,
      cluster.healthIssues,
      nodegroupReadiness,
      recentFailedUpdates,
      cluster.loggingEnabled
    ),
    commandHandoffs: commandHandoffs(connection, clusterName, targetVersion)
  }
}
