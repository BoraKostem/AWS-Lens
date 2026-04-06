import { useEffect, useRef, useState } from 'react'
import './ec2.css'
import { SvcState, variantForError } from './SvcState'
import { FreshnessIndicator, useFreshnessState } from './freshness'

import type {
  AwsConnection,
  BastionAmiOption,
  BastionConnectionInfo,
  CloudTrailEventSummary,
  ConnectionPreset,
  Ec2BulkInstanceAction,
  Ec2IamAssociation,
  Ec2InstanceAction,
  Ec2InstanceDetail,
  Ec2InstanceSummary,
  Ec2InstanceTypeOption,
  Ec2Recommendation,
  Ec2SshKeySuggestion,
  Ec2SnapshotSummary,
  Ec2VpcDetail,
  EbsTempInspectionEnvironment,
  EbsTempInspectionProgress,
  EbsVolumeDetail,
  EbsVolumeSummary,
  GovernanceTagDefaults,
  GovernanceTagKey,
  KeyPairSummary,
  SecurityGroupSummary,
  SsmCommandExecutionResult,
  SsmConnectionTarget,
  SsmManagedInstanceSummary,
  SsmPortForwardPreset,
  SsmSessionSummary,
  SubnetSummary,
  TerraformAdoptionCodegenResult,
  TerraformAdoptionDetectionResult,
  TerraformAdoptionImportExecutionResult,
  TerraformAdoptionMappingResult,
  TerraformAdoptionTarget,
  TerraformAdoptionValidationResult,
  TerraformProjectListItem,
  VaultEntrySummary
} from '@shared/types'
import {
  deleteConnectionPreset,
  getGovernanceTagDefaults,
  listConnectionPresets,
  listKeyPairs,
  listSecurityGroupsForVpc,
  listSubnets,
  listVaultEntries,
  lookupCloudTrailEventsByResource,
  markConnectionPresetUsed,
  recordVaultEntryUse,
  saveConnectionPreset
} from './api'
import {
  attachEbsVolume,
  attachIamProfile,
  chooseEc2SshKey,
  createEc2Snapshot,
  createTempVolumeCheck,
  deleteEbsVolume,
  deleteBastion,
  deleteEc2Snapshot,
  deleteTempVolumeCheck,
  describeEbsVolume,
  describeEc2Instance,
  detachEbsVolume,
  describeVpc,
  findBastionConnectionsForInstance,
  getEc2Recommendations,
  getIamAssociation,
  getSsmConnectionTarget,
  launchBastion,
  launchFromSnapshot,
  listBastions,
  listEbsVolumes,
  listEc2Instances,
  listEc2Snapshots,
  listEc2SshKeySuggestions,
  listInstanceTypes,
  listPopularBastionAmis,
  listSsmManagedInstances,
  listSsmSessions,
  modifyEbsVolume,
  materializeEc2VaultSshKey,
  removeIamProfile,
  replaceIamProfile,
  resizeEc2Instance,
  runEc2BulkInstanceAction,
  runEc2InstanceAction,
  sendSsmCommand,
  sendSshPublicKey,
  startSsmSession,
  subscribeToTempVolumeProgress,
  tagEbsVolume,
  tagEc2Snapshot,
  untagEbsVolume,
  terminateEc2Instance
} from './ec2Api'
import { ConfirmButton } from './ConfirmButton'
import { detectAdoption, executeAdoptionImport, generateAdoptionCode, listProjects as listTerraformProjects, mapAdoption, reloadProject, validateAdoptionImport } from './terraformApi'

type MainTab = 'instances' | 'volumes' | 'snapshots'
type SideTab = 'overview' | 'ssm' | 'timeline'
type ColumnKey = 'name' | 'instanceId' | 'type' | 'state' | 'az' | 'publicIp' | 'privateIp'
type BastionWorkflowMode = 'create' | 'destroy'
type BastionWorkflowStage = 'preparing' | 'executing' | 'refreshing' | 'completed' | 'failed'
type BastionWorkflowStatus = {
  mode: BastionWorkflowMode
  stage: BastionWorkflowStage
  targetInstanceId: string
  targetName: string
  imageId: string
  instanceType: string
  subnetId: string
  keyName: string
  securityGroupId: string
  bastionId?: string
  error?: string
}

type VolumeWorkflowStatus = {
  mode: 'create' | 'delete'
  volumeId: string
  volumeName: string
  tempUuid: string
  instanceId: string
  stage: EbsTempInspectionProgress['stage']
  message: string
  error?: string
}

function formatBulkActionMessage(
  action: Ec2BulkInstanceAction,
  attempted: number,
  succeeded: number,
  failed: number
): string {
  const verb = action === 'terminate' ? 'terminate' : action
  const base = `${verb} sent to ${succeeded}/${attempted} instance${attempted === 1 ? '' : 's'}`

  return failed > 0 ? `${base}; ${failed} failed.` : `${base}.`
}

function resolveConfiguredGovernanceTags(governanceDefaults: GovernanceTagDefaults | null): Record<string, string> {
  if (!governanceDefaults?.inheritByDefault) {
    return {}
  }

  return Object.fromEntries(
    GOVERNANCE_TAG_KEYS
      .map((key) => [key, governanceDefaults.values[key]?.trim() ?? ''] as const)
      .filter(([, value]) => Boolean(value))
  )
}

const BASTION_PURPOSE_TAG = 'aws-lens:purpose'
const BASTION_TARGET_INSTANCE_TAG = 'aws-lens:bastion-target-instance-id'
const GOVERNANCE_TAG_KEYS: GovernanceTagKey[] = ['Owner', 'Environment', 'Project', 'CostCenter']

const SSM_COMMAND_PRESETS = [
  {
    id: 'disk',
    label: 'Disk layout',
    linux: ['df -h', 'lsblk'],
    windows: ['Get-Volume | Format-Table -AutoSize']
  },
  {
    id: 'processes',
    label: 'Top processes',
    linux: ['ps aux --sort=-%mem | head -n 15'],
    windows: ['Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 15']
  },
  {
    id: 'ssm-agent',
    label: 'SSM agent',
    linux: [
      'if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^amazon-ssm-agent"; then systemctl status amazon-ssm-agent --no-pager; elif command -v snap >/dev/null 2>&1 && snap list amazon-ssm-agent >/dev/null 2>&1; then snap services amazon-ssm-agent; elif command -v rpm >/dev/null 2>&1; then rpm -q amazon-ssm-agent || true; elif command -v dpkg >/dev/null 2>&1; then dpkg -s amazon-ssm-agent || true; fi',
      'pgrep -a amazon-ssm-agent || ps aux | grep amazon-ssm-agent | grep -v grep || true'
    ],
    windows: ['Get-Service AmazonSSMAgent | Format-List *']
  }
] as const

const COLUMNS: { key: ColumnKey; label: string; color: string }[] = [
  { key: 'name', label: 'Name', color: '#3b82f6' },
  { key: 'instanceId', label: 'InstanceId', color: '#14b8a6' },
  { key: 'type', label: 'Type', color: '#8b5cf6' },
  { key: 'state', label: 'State', color: '#22c55e' },
  { key: 'az', label: 'AZ', color: '#f59e0b' },
  { key: 'publicIp', label: 'PublicIp', color: '#06b6d4' },
  { key: 'privateIp', label: 'PrivateIp', color: '#a855f7' },
]

function getColumnValue(inst: Ec2InstanceSummary, key: ColumnKey): string {
  switch (key) {
    case 'name': return inst.name
    case 'instanceId': return inst.instanceId
    case 'type': return inst.type
    case 'state': return inst.state
    case 'az': return inst.availabilityZone
    case 'publicIp': return inst.publicIp
    case 'privateIp': return inst.privateIp
  }
}

function iamProfilePlaceholder(detail: Ec2InstanceDetail | null, iamAssoc: Ec2IamAssociation | null): string {
  const raw = iamAssoc?.iamProfileArn && iamAssoc.iamProfileArn !== '-'
    ? iamAssoc.iamProfileArn
    : detail?.iamProfile && detail.iamProfile !== '-'
      ? detail.iamProfile
      : ''

  if (!raw) {
    return 'Instance profile name'
  }

  return raw.split('/').pop() ?? raw
}

function quoteSshArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function isWindowsPlatform(platform: string): boolean {
  return /windows/i.test(platform)
}

function terraformContextKey(connection: AwsConnection): string {
  return connection.kind === 'profile'
    ? `profile:${connection.profile}`
    : `assumed-role:${connection.sessionId}`
}

function buildEc2AdoptionTarget(connection: AwsConnection, instance: Ec2InstanceDetail): TerraformAdoptionTarget {
  return {
    serviceId: 'ec2',
    resourceType: 'aws_instance',
    region: connection.region,
    displayName: instance.name && instance.name !== '-' ? instance.name : instance.instanceId,
    identifier: instance.instanceId,
    arn: '',
    name: instance.name && instance.name !== '-' ? instance.name : '',
    tags: instance.tags,
    resourceContext: {
      vpcId: instance.vpcId,
      subnetId: instance.subnetId,
      securityGroupIds: instance.securityGroups.map((group) => group.id),
      iamInstanceProfile: instance.iamProfile,
      availabilityZone: instance.availabilityZone,
      instanceType: instance.type,
      imageId: instance.imageId
    }
  }
}

function adoptionConfidenceLabel(confidence: TerraformAdoptionMappingResult['confidence']): string {
  return confidence.charAt(0).toUpperCase() + confidence.slice(1)
}

function adoptionSourceLabel(source: TerraformAdoptionMappingResult['module']['source']): string {
  if (source === 'related-resource') return 'Related resources'
  if (source === 'existing-resource-type') return 'Existing resources'
  return 'Fallback'
}

function adoptionValidationTone(status: TerraformAdoptionValidationResult['status']): 'managed' | 'config' | 'unmanaged' {
  if (status === 'passed') return 'managed'
  if (status === 'needs-review') return 'config'
  return 'unmanaged'
}

function adoptionValidationLabel(status: TerraformAdoptionValidationResult['status']): string {
  if (status === 'passed') return 'Passed'
  if (status === 'needs-review') return 'Needs review'
  return 'Failed'
}

function adoptionPlanActionSymbol(action: string): string {
  if (action === 'create') return '+'
  if (action === 'delete') return '-'
  if (action === 'update') return '~'
  return '±'
}

type CompatibilityTone = 'match' | 'warning' | 'unknown'

function normalizeCompatibilityValue(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function resolveInstanceEnvironmentTag(tags: Record<string, string>): string {
  return tags.Environment?.trim()
    || tags.environment?.trim()
    || tags.env?.trim()
    || ''
}

function projectContextLabel(connection: AwsConnection): string {
  return connection.kind === 'profile'
    ? connection.profile
    : `${connection.sourceProfile} -> ${connection.roleArn.split('/').pop() ?? connection.roleArn}`
}

function projectCompatibility(
  connection: AwsConnection,
  instance: Ec2InstanceDetail,
  project: TerraformProjectListItem
): Array<{ label: string; tone: CompatibilityTone; detail: string }> {
  const profileDetail = project.environment.connectionLabel || projectContextLabel(connection)
  const instanceEnvironment = resolveInstanceEnvironmentTag(instance.tags)
  const projectWorkspace = project.currentWorkspace || project.environment.workspaceName || 'default'
  const environmentLabel = project.environment.environmentLabel || projectWorkspace

  const regionTone: CompatibilityTone = !project.environment.region
    ? 'unknown'
    : project.environment.region === connection.region
      ? 'match'
      : 'warning'

  const workspaceTone: CompatibilityTone = !instanceEnvironment
    ? 'unknown'
    : normalizeCompatibilityValue(instanceEnvironment) === normalizeCompatibilityValue(projectWorkspace)
      || normalizeCompatibilityValue(instanceEnvironment) === normalizeCompatibilityValue(environmentLabel)
      ? 'match'
      : 'warning'

  return [
    { label: 'Profile', tone: 'match', detail: profileDetail },
    { label: 'Region', tone: regionTone, detail: project.environment.region || 'No region inferred yet' },
    {
      label: 'Workspace',
      tone: workspaceTone,
      detail: instanceEnvironment
        ? `${projectWorkspace} vs resource tag ${instanceEnvironment}`
        : `${projectWorkspace} (${environmentLabel || 'no environment label'})`
    }
  ]
}

function ssmStatusTone(status: Ec2InstanceSummary['ssmStatus'] | Ec2InstanceDetail['ssmStatus'] | SsmConnectionTarget['status']): string {
  if (status === 'managed-online') return 'ssm-online'
  if (status === 'managed-offline') return 'ssm-offline'
  return 'ssm-unmanaged'
}

function ssmStatusLabel(status: Ec2InstanceSummary['ssmStatus'] | Ec2InstanceDetail['ssmStatus'] | SsmConnectionTarget['status']): string {
  if (status === 'managed-online') return 'SSM Online'
  if (status === 'managed-offline') return 'SSM Offline'
  return 'Not Managed'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatTimestamp(value: string): string {
  return value && value !== '-' ? new Date(value).toLocaleString() : '-'
}

function defaultConnectionPresetName(instance: Pick<Ec2InstanceDetail, 'instanceId' | 'name'> | null): string {
  if (!instance) {
    return ''
  }

  return `${instance.name !== '-' ? instance.name : instance.instanceId} access`
}

function formatVolumeSettings(volume: EbsVolumeSummary | EbsVolumeDetail): string {
  const parts = [`${volume.sizeGiB} GiB`, volume.type]
  if (volume.iops) {
    parts.push(`${volume.iops} IOPS`)
  }
  if (volume.throughput) {
    parts.push(`${volume.throughput} MiB/s`)
  }
  return parts.join(' | ')
}

function isSshVaultEntry(entry: VaultEntrySummary): boolean {
  return entry.kind === 'pem' || entry.kind === 'ssh-key'
}

function findSshVaultEntry(entries: VaultEntrySummary[], value: string, preferredId = ''): VaultEntrySummary | null {
  const normalizedValue = value.trim().toLowerCase()
  if (!normalizedValue) {
    return null
  }

  if (preferredId) {
    const preferred = entries.find((entry) => entry.id === preferredId)
    if (preferred && preferred.name.trim().toLowerCase() === normalizedValue) {
      return preferred
    }
  }

  return entries.find((entry) => entry.name.trim().toLowerCase() === normalizedValue) ?? null
}

function KV({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="ec2-kv">
      {items.map(([label, value]) => (
        <div key={label} className="ec2-kv-row">
          <div className="ec2-kv-label">{label}</div>
          <div className="ec2-kv-value">{value}</div>
        </div>
      ))}
    </div>
  )
}

function bastionStepState(current: BastionWorkflowStage, step: 'preparing' | 'executing' | 'refreshing'): 'pending' | 'active' | 'completed' | 'failed' {
  const order: Record<'preparing' | 'executing' | 'refreshing', number> = {
    preparing: 0,
    executing: 1,
    refreshing: 2
  }

  if (current === 'failed') {
    return step === 'refreshing' ? 'pending' : 'failed'
  }

  if (current === 'completed') {
    return 'completed'
  }

  if (order[step] < order[current]) {
    return 'completed'
  }

  if (order[step] === order[current]) {
    return 'active'
  }

  return 'pending'
}

function volumeStepState(
  current: EbsTempInspectionProgress['stage'],
  mode: 'create' | 'delete',
  step: EbsTempInspectionProgress['stage']
): 'pending' | 'active' | 'completed' | 'failed' {
  const order = mode === 'create'
    ? [
        'preparing',
        'creating-iam-profile-if-needed',
        'creating-instance',
        'waiting-for-instance-readiness',
        'verifying-ssm-readiness',
        'attaching-target-volume',
        'finalizing'
      ]
    : [
        'preparing',
        'detaching-inspected-volume-if-needed',
        'terminating-instance',
        'waiting-for-termination',
        'deleting-temp-resources',
        'finalizing'
      ]

  if (current === 'failed') {
    return step === order[order.length - 1] ? 'pending' : 'failed'
  }
  if (current === 'completed') {
    return 'completed'
  }

  const currentIndex = order.indexOf(current)
  const stepIndex = order.indexOf(step)
  if (stepIndex === -1) {
    return 'pending'
  }
  if (stepIndex < currentIndex) {
    return 'completed'
  }
  if (stepIndex === currentIndex) {
    return 'active'
  }
  return 'pending'
}

async function waitForBastionReady(
  connection: AwsConnection,
  targetInstanceId: string,
  bastionId: string,
  timeoutMs = 120000
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const [instances, connections] = await Promise.all([
      listEc2Instances(connection),
      findBastionConnectionsForInstance(connection, targetInstanceId)
    ])

    const bastion = instances.find((instance) => instance.instanceId === bastionId)
    const linked = connections.some((entry) => entry.bastionInstanceIds.includes(bastionId))

    if (bastion?.state === 'running' && linked) {
      return
    }

    await sleep(3000)
  }

  throw new Error(`Timed out waiting for bastion ${bastionId} to become ready.`)
}

async function waitForBastionRemoval(
  connection: AwsConnection,
  targetInstanceId: string,
  bastionId: string,
  timeoutMs = 120000
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const [bastions, connections] = await Promise.all([
      listBastions(connection),
      findBastionConnectionsForInstance(connection, targetInstanceId).catch(() => [] as BastionConnectionInfo[])
    ])

    const stillExists = bastions.some((instance) => instance.instanceId === bastionId)
    const stillLinked = connections.some((entry) => entry.bastionInstanceIds.includes(bastionId))

    if (!stillExists && !stillLinked) {
      return
    }

    await sleep(3000)
  }

  throw new Error(`Timed out waiting for bastion ${bastionId} to be removed.`)
}

function TerraformProjectPickerDialog({
  connection,
  instance,
  projects,
  loading,
  error,
  selectedProjectId,
  onSelectProject,
  onConfirm,
  onClose
}: {
  connection: AwsConnection
  instance: Ec2InstanceDetail
  projects: TerraformProjectListItem[]
  loading: boolean
  error: string
  selectedProjectId: string
  onSelectProject: (projectId: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null

  return (
    <div className="ec2-status-overlay" onClick={onClose}>
      <div className="ec2-status-dialog ec2-project-picker-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="ec2-status-header">
          <div>
            <div className="ec2-status-eyebrow">Project Selection</div>
            <h3>Select Terraform Project</h3>
            <p className="ec2-sidebar-hint" style={{ marginTop: 8, marginBottom: 0 }}>
              Choose the tracked project that should adopt <strong>{instance.name !== '-' ? instance.name : instance.instanceId}</strong>.
            </p>
          </div>
          <button type="button" className="ec2-action-btn" onClick={onClose}>Close</button>
        </div>

        <div className="ec2-project-picker-summary">
          <div className="ec2-project-picker-context">
            <span className="ec2-adoption-label">Context</span>
            <strong>{projectContextLabel(connection)}</strong>
            <small>Region {connection.region}</small>
          </div>
          <div className="ec2-project-picker-context">
            <span className="ec2-adoption-label config">Resource</span>
            <strong>{instance.instanceId}</strong>
            <small>{resolveInstanceEnvironmentTag(instance.tags) ? `Environment tag ${resolveInstanceEnvironmentTag(instance.tags)}` : 'No Environment tag on resource'}</small>
          </div>
        </div>

        {error && <div className="ec2-adoption-error">{error}</div>}
        {loading ? (
          <div className="ec2-adoption-empty">Loading tracked Terraform projects...</div>
        ) : projects.length === 0 ? (
          <div className="ec2-adoption-empty">No tracked Terraform projects are available in this AWS context yet.</div>
        ) : (
          <div className="ec2-project-picker-list">
            {projects.map((project) => {
              const selected = project.id === selectedProjectId
              const compatibility = projectCompatibility(connection, instance, project)
              return (
                <button
                  key={project.id}
                  type="button"
                  className={`ec2-project-picker-card ${selected ? 'active' : ''}`}
                  onClick={() => onSelectProject(project.id)}
                >
                  <div className="ec2-project-picker-head">
                    <div>
                      <strong>{project.name}</strong>
                      <small>{project.rootPath}</small>
                    </div>
                    <span className={`ec2-adoption-pill ${compatibility.some((item) => item.tone === 'warning') ? 'config' : compatibility.some((item) => item.tone === 'unknown') ? 'unmanaged' : 'managed'}`}>
                      {compatibility.some((item) => item.tone === 'warning')
                        ? 'Needs review'
                        : compatibility.some((item) => item.tone === 'unknown')
                          ? 'Partial context'
                          : 'Best fit'}
                    </span>
                  </div>
                  <div className="ec2-project-picker-meta">
                    <span>Workspace {project.currentWorkspace || 'default'}</span>
                    <span>Region {project.environment.region || '-'}</span>
                    <span>Backend {project.metadata.backendType || '-'}</span>
                  </div>
                  <div className="ec2-project-picker-compat">
                    {compatibility.map((item) => (
                      <div key={`${project.id}:${item.label}`} className={`ec2-project-picker-compat-item ${item.tone}`}>
                        <span>{item.label}</span>
                        <strong>{item.detail}</strong>
                      </div>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        <div className="ec2-project-picker-actions">
          <div className="ec2-sidebar-hint" style={{ marginBottom: 0 }}>
            {selectedProject
              ? `Selected project: ${selectedProject.name} (${selectedProject.currentWorkspace || 'default'})`
              : 'Select a target project to continue.'}
          </div>
          <div className="ec2-btn-row">
            <button type="button" className="ec2-action-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ec2-action-btn terraform" onClick={onConfirm} disabled={!selectedProject}>
              Use Project
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Ec2Console({
  connection,
  refreshNonce = 0,
  focusInstance,
  onNavigateCloudWatch,
  onNavigateVpc,
  onNavigateSecurityGroup,
  onRunTerminalCommand
}: {
  connection: AwsConnection
  refreshNonce?: number
  focusInstance?: { token: number; instanceId?: string; volumeId?: string; tab?: 'instances' | 'volumes' | 'snapshots' } | null
  onNavigateCloudWatch?: (instanceId: string) => void
  onNavigateVpc?: (vpcId: string) => void
  onNavigateSecurityGroup?: (securityGroupId: string) => void
  onRunTerminalCommand?: (command: string) => void
}) {
  const [mainTab, setMainTab] = useState<MainTab>('instances')
  const [sideTab, setSideTab] = useState<SideTab>('overview')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  /* ── Filter state ──────────────────────────────────────── */
  const [stateFilter, setStateFilter] = useState('all')
  const [searchFilter, setSearchFilter] = useState('')
  const [visibleCols, setVisibleCols] = useState<Set<ColumnKey>>(
    new Set(['name', 'instanceId', 'type', 'state', 'az', 'publicIp', 'privateIp'])
  )

  /* ── Instances state ─────────────────────────────────────── */
  const [instances, setInstances] = useState<Ec2InstanceSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [selectedInstanceIds, setSelectedInstanceIds] = useState<string[]>([])
  const [detail, setDetail] = useState<Ec2InstanceDetail | null>(null)
  const [iamAssoc, setIamAssoc] = useState<Ec2IamAssociation | null>(null)
  const [vpcDetail, setVpcDetail] = useState<Ec2VpcDetail | null>(null)
  const [instanceTypes, setInstanceTypes] = useState<Ec2InstanceTypeOption[]>([])
  const [resizeType, setResizeType] = useState('')
  const [showResize, setShowResize] = useState(false)
  const [iamName, setIamName] = useState('')
  const [sshUser, setSshUser] = useState('ec2-user')
  const [sshKey, setSshKey] = useState('')
  const [sshVaultEntryId, setSshVaultEntryId] = useState('')
  const [sshVaultEntryName, setSshVaultEntryName] = useState('')
  const [sshVaultEntries, setSshVaultEntries] = useState<VaultEntrySummary[]>([])
  const [sshVaultEntriesLoading, setSshVaultEntriesLoading] = useState(false)
  const [sshSuggestions, setSshSuggestions] = useState<Ec2SshKeySuggestion[]>([])
  const [sshSuggestionsLoading, setSshSuggestionsLoading] = useState(false)
  const [governanceDefaults, setGovernanceDefaults] = useState<GovernanceTagDefaults | null>(null)
  const [showDescribe, setShowDescribe] = useState(false)
  const [ssmManagedInstances, setSsmManagedInstances] = useState<SsmManagedInstanceSummary[]>([])
  const [ssmTarget, setSsmTarget] = useState<SsmConnectionTarget | null>(null)
  const [ssmSessions, setSsmSessions] = useState<SsmSessionSummary[]>([])
  const [ssmCommandHistory, setSsmCommandHistory] = useState<Record<string, SsmCommandExecutionResult[]>>({})
  const [ssmLoading, setSsmLoading] = useState(false)
  const [ssmShellBusy, setSsmShellBusy] = useState(false)
  const [ssmCommandBusy, setSsmCommandBusy] = useState(false)
  const [ssmCommandDocument, setSsmCommandDocument] = useState('AWS-RunShellScript')
  const [ssmCommandInput, setSsmCommandInput] = useState('uname -a\nwhoami')
  const [customRemotePort, setCustomRemotePort] = useState('8080')
  const [customLocalPort, setCustomLocalPort] = useState('18080')
  const [adoptionDetection, setAdoptionDetection] = useState<TerraformAdoptionDetectionResult | null>(null)
  const [adoptionLoading, setAdoptionLoading] = useState(false)
  const [adoptionError, setAdoptionError] = useState('')
  const adoptionSectionRef = useRef<HTMLDivElement | null>(null)
  const adoptionRequestRef = useRef(0)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [projectPickerLoading, setProjectPickerLoading] = useState(false)
  const [projectPickerError, setProjectPickerError] = useState('')
  const [projectPickerProjects, setProjectPickerProjects] = useState<TerraformProjectListItem[]>([])
  const [selectedProjectCandidateId, setSelectedProjectCandidateId] = useState('')
  const [selectedAdoptionProject, setSelectedAdoptionProject] = useState<TerraformProjectListItem | null>(null)
  const [adoptionMapping, setAdoptionMapping] = useState<TerraformAdoptionMappingResult | null>(null)
  const [adoptionMappingLoading, setAdoptionMappingLoading] = useState(false)
  const [adoptionMappingError, setAdoptionMappingError] = useState('')
  const adoptionMappingRequestRef = useRef(0)
  const [adoptionCodegen, setAdoptionCodegen] = useState<TerraformAdoptionCodegenResult | null>(null)
  const [adoptionCodegenLoading, setAdoptionCodegenLoading] = useState(false)
  const [adoptionCodegenError, setAdoptionCodegenError] = useState('')
  const adoptionCodegenRequestRef = useRef(0)
  const [adoptionImportRunning, setAdoptionImportRunning] = useState(false)
  const [adoptionImportError, setAdoptionImportError] = useState('')
  const [adoptionImportResult, setAdoptionImportResult] = useState<TerraformAdoptionImportExecutionResult | null>(null)
  const [adoptionValidationLoading, setAdoptionValidationLoading] = useState(false)
  const [adoptionValidationError, setAdoptionValidationError] = useState('')
  const [adoptionValidation, setAdoptionValidation] = useState<TerraformAdoptionValidationResult | null>(null)
  const adoptionValidationRequestRef = useRef(0)

  /* ── Snapshots state ─────────────────────────────────────── */
  const [snapshots, setSnapshots] = useState<Ec2SnapshotSummary[]>([])
  const [selectedSnapId, setSelectedSnapId] = useState('')
  const [snapVolume, setSnapVolume] = useState('')
  const [snapDesc, setSnapDesc] = useState('')
  const [tagKey, setTagKey] = useState('')
  const [tagValue, setTagValue] = useState('')
  const [snapLaunchName, setSnapLaunchName] = useState('')
  const [snapLaunchType, setSnapLaunchType] = useState('t3.micro')
  const [snapLaunchSubnet, setSnapLaunchSubnet] = useState('')
  const [snapLaunchKey, setSnapLaunchKey] = useState('')
  const [snapLaunchSg, setSnapLaunchSg] = useState('')
  const [snapLaunchArch, setSnapLaunchArch] = useState('x86_64')

  /* ── Volumes state ───────────────────────────────────────── */
  const [volumes, setVolumes] = useState<EbsVolumeSummary[]>([])
  const [selectedVolumeId, setSelectedVolumeId] = useState('')
  const [volumeDetail, setVolumeDetail] = useState<EbsVolumeDetail | null>(null)
  const [volumeFilter, setVolumeFilter] = useState('')
  const [volumeWorkflowStatus, setVolumeWorkflowStatus] = useState<VolumeWorkflowStatus | null>(null)
  const [volumeTempSsmTarget, setVolumeTempSsmTarget] = useState<SsmConnectionTarget | null>(null)
  const [volumeTagKey, setVolumeTagKey] = useState('')
  const [volumeTagValue, setVolumeTagValue] = useState('')
  const [volumeAttachInstanceId, setVolumeAttachInstanceId] = useState('')
  const volumeDetailNameRef = useRef<string>('')
  const [volumeAttachDevice, setVolumeAttachDevice] = useState('/dev/sdf')
  const [volumeModifySize, setVolumeModifySize] = useState('')
  const [volumeModifyType, setVolumeModifyType] = useState('')
  const [volumeModifyIops, setVolumeModifyIops] = useState('')
  const [volumeModifyThroughput, setVolumeModifyThroughput] = useState('')

  /* ── Bastion state ───────────────────────────────────────── */
  const [bastions, setBastions] = useState<Ec2InstanceSummary[]>([])
  const [bastionAmi, setBastionAmi] = useState('')
  const [bastionType, setBastionType] = useState('t3.micro')
  const [bastionSubnet, setBastionSubnet] = useState('')
  const [bastionKeyPair, setBastionKeyPair] = useState('')
  const [bastionSg, setBastionSg] = useState('')
  const [showBastionPanel, setShowBastionPanel] = useState(false)
  const [linkedBastions, setLinkedBastions] = useState<BastionConnectionInfo[]>([])
  const [popularBastionAmis, setPopularBastionAmis] = useState<BastionAmiOption[]>([])
  const [loadingPopularBastionAmis, setLoadingPopularBastionAmis] = useState(false)
  const [bastionTypes, setBastionTypes] = useState<Ec2InstanceTypeOption[]>([])
  const [loadingBastionTypes, setLoadingBastionTypes] = useState(false)
  const [bastionKeyPairs, setBastionKeyPairs] = useState<KeyPairSummary[]>([])
  const [bastionSubnets, setBastionSubnets] = useState<SubnetSummary[]>([])
  const [bastionSecurityGroups, setBastionSecurityGroups] = useState<SecurityGroupSummary[]>([])
  const [loadingBastionNetworkOptions, setLoadingBastionNetworkOptions] = useState(false)
  const [bastionLaunchStatus, setBastionLaunchStatus] = useState<BastionWorkflowStatus | null>(null)
  const [connectionPresets, setConnectionPresets] = useState<ConnectionPreset[]>([])
  const [selectedConnectionPresetId, setSelectedConnectionPresetId] = useState('')
  const [connectionPresetName, setConnectionPresetName] = useState('')

  /* ── Timeline state ────────────────────────────────────── */
  const [timelineEvents, setTimelineEvents] = useState<CloudTrailEventSummary[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [timelineStart, setTimelineStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => new Date().toISOString().slice(0, 10))

  async function loadSshVaultEntries(): Promise<void> {
    setSshVaultEntriesLoading(true)
    try {
      const entries = await listVaultEntries()
      setSshVaultEntries(entries.filter(isSshVaultEntry).sort((left, right) => left.name.localeCompare(right.name)))
    } catch {
      setSshVaultEntries([])
    } finally {
      setSshVaultEntriesLoading(false)
    }
  }

  function applySshKeyInput(nextValue: string, preferredVaultId = ''): void {
    const matchedVaultEntry = findSshVaultEntry(sshVaultEntries, nextValue, preferredVaultId)
    setSshKey(nextValue)
    setSshVaultEntryId(matchedVaultEntry?.id ?? '')
    setSshVaultEntryName(matchedVaultEntry?.name ?? '')
  }

  async function loadTimeline(instanceId: string) {
    if (!instanceId) return
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const events = await lookupCloudTrailEventsByResource(
        connection, instanceId,
        new Date(timelineStart).toISOString(),
        new Date(timelineEnd + 'T23:59:59').toISOString()
      )
      setTimelineEvents(events)
    } catch (err) {
      setTimelineEvents([])
      setTimelineError(err instanceof Error ? err.message : 'Failed to load events')
    } finally {
      setTimelineLoading(false)
    }
  }

  async function hydrateConnectionPresets(resourceId = selectedId): Promise<void> {
    if (!resourceId) {
      setConnectionPresets([])
      setSelectedConnectionPresetId('')
      setConnectionPresetName('')
      return
    }

    try {
      const presets = await listConnectionPresets({
        kind: 'bastion-ssh',
        profile: connection.profile,
        region: connection.region,
        resourceId
      })
      setConnectionPresets(presets)
      setSelectedConnectionPresetId((current) => presets.some((entry) => entry.id === current) ? current : '')
    } catch {
      setConnectionPresets([])
      setSelectedConnectionPresetId('')
    }
  }

  function applyConnectionPreset(presetId: string): void {
    setSelectedConnectionPresetId(presetId)
    if (!presetId) {
      setConnectionPresetName(defaultConnectionPresetName(detail))
      return
    }

    const preset = connectionPresets.find((entry) => entry.id === presetId)
    if (!preset) {
      return
    }

    setConnectionPresetName(preset.name)
    setSshUser(preset.sshUser || 'ec2-user')
    applySshKeyInput(preset.connectInput || preset.vaultEntryName, preset.vaultEntryId)
    setBastionAmi(preset.bastionImageId)
    setBastionType(preset.bastionInstanceType || 't3.micro')
    setBastionSubnet(preset.subnetId)
    setBastionKeyPair(preset.keyName)
    setBastionSg(preset.securityGroupId)

    void markConnectionPresetUsed(preset.id)
      .then(() => hydrateConnectionPresets(detail?.instanceId ?? selectedId))
      .catch(() => undefined)
  }

  async function handleSaveConnectionPreset(): Promise<void> {
    if (!detail) {
      return
    }

    try {
      const name = connectionPresetName.trim() || defaultConnectionPresetName(detail)
      const saved = await saveConnectionPreset({
        id: selectedConnectionPresetId || undefined,
        name,
        kind: 'bastion-ssh',
        profile: connection.profile,
        region: connection.region,
        resourceKind: 'ec2-instance',
        resourceId: detail.instanceId,
        resourceLabel: detail.name !== '-' ? detail.name : detail.instanceId,
        engine: 'unknown',
        host: detail.privateIp !== '-' ? detail.privateIp : detail.publicIp,
        port: 22,
        databaseName: '',
        username: '',
        credentialSourceKind: '',
        credentialSourceRef: '',
        connectInput: sshKey,
        vaultEntryId: sshVaultEntryId,
        vaultEntryName: sshVaultEntryName,
        sshUser,
        bastionImageId: bastionAmi,
        bastionInstanceType: bastionType,
        subnetId: bastionSubnet,
        keyName: bastionKeyPair,
        securityGroupId: bastionSg,
        contextName: '',
        kubeconfigPath: '',
        notes: ''
      })
      setSelectedConnectionPresetId(saved.id)
      setConnectionPresetName(saved.name)
      setMsg(`Connection preset saved: ${saved.name}`)
      await hydrateConnectionPresets(detail.instanceId)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Failed to save connection preset.')
    }
  }

  async function handleDeleteConnectionPreset(): Promise<void> {
    if (!selectedConnectionPresetId) {
      return
    }

    try {
      await deleteConnectionPreset(selectedConnectionPresetId)
      setSelectedConnectionPresetId('')
      setMsg('Connection preset deleted.')
      await hydrateConnectionPresets(detail?.instanceId ?? selectedId)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : 'Failed to delete connection preset.')
    }
  }

  async function loadAdoptionDetection(nextDetail: Ec2InstanceDetail | null): Promise<void> {
    const requestId = adoptionRequestRef.current + 1
    adoptionRequestRef.current = requestId

    if (!nextDetail) {
      if (requestId === adoptionRequestRef.current) {
        setAdoptionDetection(null)
        setAdoptionError('')
        setAdoptionLoading(false)
      }
      return
    }

    setAdoptionLoading(true)
    setAdoptionError('')
    try {
      const result = await detectAdoption(
        terraformContextKey(connection),
        connection,
        buildEc2AdoptionTarget(connection, nextDetail)
      )
      if (requestId === adoptionRequestRef.current) {
        setAdoptionDetection(result)
      }
    } catch (error) {
      if (requestId === adoptionRequestRef.current) {
        setAdoptionDetection(null)
        setAdoptionError(error instanceof Error ? error.message : 'Terraform adoption detection failed.')
      }
    } finally {
      if (requestId === adoptionRequestRef.current) {
        setAdoptionLoading(false)
      }
    }
  }

  async function loadAdoptionMapping(
    nextDetail: Ec2InstanceDetail | null,
    project: TerraformProjectListItem | null
  ): Promise<void> {
    const requestId = adoptionMappingRequestRef.current + 1
    adoptionMappingRequestRef.current = requestId

    if (!nextDetail || !project || adoptionDetection?.managedProjectCount !== 0) {
      if (requestId === adoptionMappingRequestRef.current) {
        setAdoptionMapping(null)
        setAdoptionMappingError('')
        setAdoptionMappingLoading(false)
      }
      return
    }

    setAdoptionMappingLoading(true)
    setAdoptionMappingError('')
    try {
      const result = await mapAdoption(
        terraformContextKey(connection),
        project.id,
        connection,
        buildEc2AdoptionTarget(connection, nextDetail)
      )
      if (requestId === adoptionMappingRequestRef.current) {
        setAdoptionMapping(result)
      }
    } catch (error) {
      if (requestId === adoptionMappingRequestRef.current) {
        setAdoptionMapping(null)
        setAdoptionMappingError(error instanceof Error ? error.message : 'Terraform resource mapping failed.')
      }
    } finally {
      if (requestId === adoptionMappingRequestRef.current) {
        setAdoptionMappingLoading(false)
      }
    }
  }

  async function loadAdoptionCodegen(
    nextDetail: Ec2InstanceDetail | null,
    project: TerraformProjectListItem | null,
    mapping: TerraformAdoptionMappingResult | null
  ): Promise<void> {
    const requestId = adoptionCodegenRequestRef.current + 1
    adoptionCodegenRequestRef.current = requestId

    if (!nextDetail || !project || !mapping || adoptionDetection?.managedProjectCount !== 0) {
      if (requestId === adoptionCodegenRequestRef.current) {
        setAdoptionCodegen(null)
        setAdoptionCodegenError('')
        setAdoptionCodegenLoading(false)
      }
      return
    }

    setAdoptionCodegenLoading(true)
    setAdoptionCodegenError('')
    try {
      const result = await generateAdoptionCode(
        terraformContextKey(connection),
        project.id,
        connection,
        buildEc2AdoptionTarget(connection, nextDetail)
      )
      if (requestId === adoptionCodegenRequestRef.current) {
        setAdoptionCodegen(result)
      }
    } catch (error) {
      if (requestId === adoptionCodegenRequestRef.current) {
        setAdoptionCodegen(null)
        setAdoptionCodegenError(error instanceof Error ? error.message : 'Terraform code generation preview failed.')
      }
    } finally {
      if (requestId === adoptionCodegenRequestRef.current) {
        setAdoptionCodegenLoading(false)
      }
    }
  }

  async function handleExecuteAdoptionImport(): Promise<void> {
    if (!detail || !selectedAdoptionProject || !adoptionCodegen || adoptionImportRunning) {
      return
    }

    setAdoptionImportRunning(true)
    setAdoptionImportError('')
    setAdoptionImportResult(null)
    setAdoptionValidation(null)
    setAdoptionValidationError('')
    adoptionValidationRequestRef.current += 1

    try {
      const result = await executeAdoptionImport(
        terraformContextKey(connection),
        selectedAdoptionProject.id,
        connection,
        buildEc2AdoptionTarget(connection, detail)
      )
      setAdoptionImportResult(result)

      if (!result.log.success) {
        const tail = result.log.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || 'see command output for details'
        setAdoptionImportError(`Terraform import failed: ${tail}`)
        return
      }

      const refreshedProject = await reloadProject(terraformContextKey(connection), selectedAdoptionProject.id, connection)
      setSelectedAdoptionProject(refreshedProject)
      setProjectPickerProjects((previous) => previous.map((project) => (
        project.id === refreshedProject.id ? refreshedProject : project
      )))
      setAdoptionValidation(null)
      setAdoptionValidationError('')
      await loadAdoptionDetection(detail)
      await runAdoptionValidation(detail, refreshedProject)
      setMsg(`Terraform import completed for ${detail.instanceId}.`)
    } catch (error) {
      setAdoptionImportError(error instanceof Error ? error.message : 'Terraform import execution failed.')
    } finally {
      setAdoptionImportRunning(false)
    }
  }

  async function runAdoptionValidation(
    nextDetail: Ec2InstanceDetail | null = detail,
    project: TerraformProjectListItem | null = selectedAdoptionProject
  ): Promise<void> {
    const requestId = adoptionValidationRequestRef.current + 1
    adoptionValidationRequestRef.current = requestId

    if (!nextDetail || !project || adoptionValidationLoading) {
      return
    }

    setAdoptionValidationLoading(true)
    setAdoptionValidationError('')
    setAdoptionValidation(null)

    try {
      const result = await validateAdoptionImport(
        terraformContextKey(connection),
        project.id,
        connection,
        buildEc2AdoptionTarget(connection, nextDetail)
      )
      if (requestId !== adoptionValidationRequestRef.current) {
        return
      }
      setAdoptionValidation(result)

      const refreshedProject = await reloadProject(terraformContextKey(connection), project.id, connection)
      if (requestId !== adoptionValidationRequestRef.current) {
        return
      }
      setSelectedAdoptionProject(refreshedProject)
      setProjectPickerProjects((previous) => previous.map((entry) => (
        entry.id === refreshedProject.id ? refreshedProject : entry
      )))
    } catch (error) {
      if (requestId === adoptionValidationRequestRef.current) {
        setAdoptionValidationError(error instanceof Error ? error.message : 'Post-import validation failed.')
      }
    } finally {
      if (requestId === adoptionValidationRequestRef.current) {
        setAdoptionValidationLoading(false)
      }
    }
  }

  function handleManageInTerraform(): void {
    adoptionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (!detail) return
    void openProjectPicker(detail)
  }

  async function openProjectPicker(nextDetail: Ec2InstanceDetail): Promise<void> {
    setShowProjectPicker(true)
    setProjectPickerLoading(true)
    setProjectPickerError('')
    try {
      const projects = await listTerraformProjects(terraformContextKey(connection), connection)
      const ranked = [...projects].sort((left, right) => {
        const leftRegion = left.environment.region === connection.region ? 1 : 0
        const rightRegion = right.environment.region === connection.region ? 1 : 0
        return rightRegion - leftRegion || left.name.localeCompare(right.name)
      })
      setProjectPickerProjects(ranked)
      const preferred = selectedAdoptionProject && ranked.some((project) => project.id === selectedAdoptionProject.id)
        ? selectedAdoptionProject.id
        : ranked[0]?.id ?? ''
      setSelectedProjectCandidateId(preferred)
    } catch (error) {
      setProjectPickerProjects([])
      setSelectedProjectCandidateId('')
      setProjectPickerError(error instanceof Error ? error.message : 'Failed to load Terraform projects.')
    } finally {
      setProjectPickerLoading(false)
    }
  }

  function handleConfirmProjectSelection(): void {
    const selectedProject = projectPickerProjects.find((project) => project.id === selectedProjectCandidateId) ?? null
    if (!selectedProject) return
    setSelectedAdoptionProject(selectedProject)
    setAdoptionImportError('')
    setAdoptionImportResult(null)
    setAdoptionValidation(null)
    setAdoptionValidationError('')
    adoptionValidationRequestRef.current += 1
    setShowProjectPicker(false)
    setMsg(`Terraform target project selected: ${selectedProject.name}`)
  }

  useEffect(() => {
    if (sideTab === 'timeline' && selectedId) void loadTimeline(selectedId)
  }, [sideTab, selectedId, timelineStart, timelineEnd])

  useEffect(() => {
    void loadAdoptionDetection(detail)
  }, [connection.region, connection.sessionId, detail?.instanceId, detail?.name])

  useEffect(() => {
    void loadAdoptionMapping(detail, selectedAdoptionProject)
  }, [connection.region, connection.sessionId, detail?.instanceId, selectedAdoptionProject?.id, adoptionDetection?.managedProjectCount])

  useEffect(() => {
    void loadAdoptionCodegen(detail, selectedAdoptionProject, adoptionMapping)
  }, [connection.region, connection.sessionId, detail?.instanceId, selectedAdoptionProject?.id, adoptionMapping?.suggestedAddress, adoptionDetection?.managedProjectCount])

  useEffect(() => {
    setSelectedAdoptionProject(null)
    setSelectedProjectCandidateId('')
    setShowProjectPicker(false)
    setProjectPickerProjects([])
    setProjectPickerError('')
    setAdoptionMapping(null)
    setAdoptionMappingError('')
    setAdoptionMappingLoading(false)
    setAdoptionCodegen(null)
    setAdoptionCodegenError('')
    setAdoptionCodegenLoading(false)
    setAdoptionImportRunning(false)
    setAdoptionImportError('')
    setAdoptionImportResult(null)
    setAdoptionValidationLoading(false)
    setAdoptionValidationError('')
    setAdoptionValidation(null)
    adoptionValidationRequestRef.current += 1
  }, [detail?.instanceId])

  /* ── Recommendations state ──────────────────────────────── */
  const [recommendations, setRecommendations] = useState<Ec2Recommendation[]>([])
  const [recsLoading, setRecsLoading] = useState(false)
  const {
    freshness: inventoryFreshness,
    beginRefresh: beginInventoryRefresh,
    completeRefresh: completeInventoryRefresh,
    failRefresh: failInventoryRefresh
  } = useFreshnessState({ staleAfterMs: 5 * 60 * 1000 })
  const {
    freshness: sessionFreshness,
    beginRefresh: beginSessionRefresh,
    completeRefresh: completeSessionRefresh,
    failRefresh: failSessionRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000 })

  const recommendationMap = new Map<string, Ec2Recommendation>()
  for (const rec of recommendations) {
    recommendationMap.set(rec.instanceId, rec)
  }

  async function loadRecommendations() {
    setRecsLoading(true)
    try {
      setRecommendations(await getEc2Recommendations(connection))
    } catch {
      // Silently fail — recommendations are non-critical
    } finally {
      setRecsLoading(false)
    }
  }

  /* ── Data loading ────────────────────────────────────────── */
  async function reload(reason: 'initial' | 'manual' | 'background' = 'manual') {
    beginInventoryRefresh(reason)
    setLoading(true)
    setMsg('')
    try {
      const [inst, vols, snaps, bast, managed] = await Promise.all([
        listEc2Instances(connection),
        listEbsVolumes(connection),
        listEc2Snapshots(connection),
        listBastions(connection),
        listSsmManagedInstances(connection)
      ])
      setInstances(inst)
      setVolumes(vols)
      setSnapshots(snaps)
      setBastions(bast)
      setSsmManagedInstances(managed)
      const resolvedInstanceId = selectedId && inst.some((i) => i.instanceId === selectedId)
        ? selectedId
        : (inst[0]?.instanceId ?? '')
      setSelectedId(resolvedInstanceId)
      setSelectedInstanceIds((current) => {
        const next = current.filter((instanceId) => inst.some((instance) => instance.instanceId === instanceId))
        return next.length > 0 ? next : (resolvedInstanceId ? [resolvedInstanceId] : [])
      })
      if (resolvedInstanceId) {
        await selectInstance(resolvedInstanceId, { preserveExisting: true, reason: 'background' })
      } else {
        setDetail(null)
        setIamAssoc(null)
        setVpcDetail(null)
        setLinkedBastions([])
        setSsmTarget(null)
        setSsmSessions([])
      }

      const resolvedSnapshotId = selectedSnapId && snaps.some((s) => s.snapshotId === selectedSnapId)
        ? selectedSnapId
        : (snaps[0]?.snapshotId ?? '')
      setSelectedSnapId(resolvedSnapshotId)

      const resolvedVolumeId = selectedVolumeId && vols.some((v) => v.volumeId === selectedVolumeId)
        ? selectedVolumeId
        : (vols[0]?.volumeId ?? '')
      setSelectedVolumeId(resolvedVolumeId)
      if (resolvedVolumeId) {
        await selectVolume(resolvedVolumeId, { preserveExisting: true })
      } else {
        setVolumeDetail(null)
      }
      completeInventoryRefresh()
    } catch (e) {
      failInventoryRefresh()
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload('initial'); void loadRecommendations() }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (refreshNonce === 0) {
      return
    }

    void reload('manual')
  }, [refreshNonce])

  /* ── Focus drilldown ─────────────────────────────────────── */
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  useEffect(() => {
    if (!focusInstance || focusInstance.token === appliedFocusToken) return
    setAppliedFocusToken(focusInstance.token)
    if (focusInstance.tab) setMainTab(focusInstance.tab)
    if (focusInstance.instanceId) {
      const match = instances.find(i => i.instanceId === focusInstance.instanceId)
      if (match) {
        setMainTab(focusInstance.tab ?? 'instances')
        void selectInstance(match.instanceId)
      }
    }
    if (focusInstance.volumeId) {
      setMainTab('volumes')
      setSelectedVolumeId(focusInstance.volumeId)
    }
  }, [appliedFocusToken, focusInstance, instances])

  useEffect(() => {
    volumeDetailNameRef.current = volumeDetail?.name ?? ''
  }, [volumeDetail?.name])

  useEffect(() => {
    void getGovernanceTagDefaults()
      .then(setGovernanceDefaults)
      .catch(() => {
        setGovernanceDefaults(null)
      })
  }, [connection.sessionId])

  useEffect(() => {
    void loadSshVaultEntries()
  }, [refreshNonce])

  useEffect(() => {
    const matchedVaultEntry = findSshVaultEntry(sshVaultEntries, sshKey, sshVaultEntryId)
    const nextId = matchedVaultEntry?.id ?? ''
    const nextName = matchedVaultEntry?.name ?? ''

    if (nextId !== sshVaultEntryId) {
      setSshVaultEntryId(nextId)
    }
    if (nextName !== sshVaultEntryName) {
      setSshVaultEntryName(nextName)
    }
  }, [sshKey, sshVaultEntries, sshVaultEntryId, sshVaultEntryName])

  useEffect(() => {
    const preferredKeyName = detail?.keyName?.trim()

    if (!preferredKeyName || preferredKeyName === '-') {
      setSshSuggestions([])
      setSshSuggestionsLoading(false)
      return
    }

    let cancelled = false
    setSshSuggestionsLoading(true)

    void listEc2SshKeySuggestions(preferredKeyName)
      .then((suggestions) => {
        if (cancelled) {
          return
        }

        setSshSuggestions(suggestions.slice(0, 6))
        const preferredSuggestion = suggestions.find((suggestion) => suggestion.keyNameMatch && suggestion.hasPublicKey)
          ?? suggestions.find((suggestion) => suggestion.hasPublicKey)
          ?? suggestions[0]

        if (preferredSuggestion && !sshKey) {
          setSshKey((current) => current || preferredSuggestion.privateKeyPath)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSshSuggestions([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSshSuggestionsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [detail?.keyName])

  useEffect(() => subscribeToTempVolumeProgress((progress) => {
    setVolumeWorkflowStatus((current) => ({
      mode: progress.mode,
      volumeId: progress.volumeId,
      volumeName: current?.volumeId === progress.volumeId ? current.volumeName : volumeDetailNameRef.current || progress.volumeId,
      tempUuid: progress.tempUuid,
      instanceId: progress.instanceId,
      stage: progress.stage,
      message: progress.message,
      error: progress.error
    }))
  }), [])

  async function loadSsmForInstance(instanceId: string, reason: 'selection' | 'background' | 'manual' = 'selection'): Promise<void> {
    if (!instanceId) {
      setSsmTarget(null)
      setSsmSessions([])
      return
    }
    beginSessionRefresh(reason)
    setSsmLoading(true)
    try {
      const [target, sessions] = await Promise.all([
        getSsmConnectionTarget(connection, instanceId),
        listSsmSessions(connection, instanceId).catch(() => [] as SsmSessionSummary[])
      ])
      setSsmTarget(target)
      setSsmSessions(sessions)
      setSsmCommandDocument(isWindowsPlatform(target.managedInstance?.platformName ?? detail?.platform ?? '') ? 'AWS-RunPowerShellScript' : 'AWS-RunShellScript')
      completeSessionRefresh()
    } catch (error) {
      failSessionRefresh()
      setSsmTarget(null)
      setSsmSessions([])
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setSsmLoading(false)
    }
  }

  async function selectInstance(id: string, options?: { preserveExisting?: boolean; reason?: 'selection' | 'background' | 'manual' }) {
    setSelectedId(id)
    if ((options?.reason ?? 'selection') === 'selection') {
      setSelectedInstanceIds([id])
    }
    setMsg('')
    if (!options?.preserveExisting) {
      setDetail(null)
      setIamAssoc(null)
      setVpcDetail(null)
    }
    setLinkedBastions([])
    setSsmTarget(null)
    setSsmSessions([])
    const d = await describeEc2Instance(connection, id)
    setDetail(d)
    if (d) {
      if ((options?.reason ?? 'selection') !== 'background' || !connectionPresetName) {
        setConnectionPresetName(defaultConnectionPresetName(d))
      }
      setResizeType(d.type)
      try { setIamAssoc(await getIamAssociation(connection, id)) } catch { setIamAssoc(null) }
      if (d.vpcId !== '-') {
        try { setVpcDetail(await describeVpc(connection, d.vpcId)) } catch { setVpcDetail(null) }
      }
      try { setLinkedBastions(await findBastionConnectionsForInstance(connection, id)) } catch { setLinkedBastions([]) }
      await loadSsmForInstance(id, options?.reason ?? 'selection')
      await hydrateConnectionPresets(id)
    } else {
      setLinkedBastions([])
      setSsmTarget(null)
      setSsmSessions([])
      setConnectionPresets([])
      setSelectedConnectionPresetId('')
      setConnectionPresetName('')
    }
  }

  async function selectVolume(id: string, options?: { preserveExisting?: boolean }) {
    setSelectedVolumeId(id)
    if (!options?.preserveExisting) {
      setVolumeDetail(null)
    }
    setVolumeTempSsmTarget(null)
    setMsg('')
    const detail = await describeEbsVolume(connection, id)
    setVolumeDetail(detail)
    if (detail) {
      setVolumeModifySize(String(detail.sizeGiB))
      setVolumeModifyType(detail.type)
      setVolumeModifyIops(detail.iops ? String(detail.iops) : '')
      setVolumeModifyThroughput(detail.throughput ? String(detail.throughput) : '')
      setVolumeAttachInstanceId(detail.attachedInstanceIds[0] ?? '')
      setVolumeAttachDevice(detail.attachedDevices[0] ?? '/dev/sdf')
      if (detail.tempEnvironment?.instanceId) {
        try {
          setVolumeTempSsmTarget(await getSsmConnectionTarget(connection, detail.tempEnvironment.instanceId))
        } catch {
          setVolumeTempSsmTarget(null)
        }
      }
    }
  }

  /* ── Action handlers ─────────────────────────────────────── */
  async function runEc2Mutation(work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    }
  }

  function toggleInstanceSelection(instanceId: string): void {
    setSelectedInstanceIds((current) =>
      current.includes(instanceId)
        ? current.filter((selectedInstanceId) => selectedInstanceId !== instanceId)
        : [...current, instanceId]
    )
  }

  function toggleAllVisibleInstances(): void {
    const visibleInstanceIds = filteredInstances.map((instance) => instance.instanceId)

    if (!visibleInstanceIds.length) {
      return
    }

    const allSelected = visibleInstanceIds.every((instanceId) => selectedInstanceIds.includes(instanceId))
    setSelectedInstanceIds((current) => {
      if (allSelected) {
        return current.filter((instanceId) => !visibleInstanceIds.includes(instanceId))
      }

      return [...new Set([...current, ...visibleInstanceIds])]
    })
  }

  async function doBulkAction(action: Ec2BulkInstanceAction): Promise<void> {
    if (!selectedInstanceIds.length) {
      return
    }

    await runEc2Mutation(async () => {
      const result = await runEc2BulkInstanceAction(connection, selectedInstanceIds, action)
      setMsg(formatBulkActionMessage(action, result.attempted, result.succeeded, result.failed))
      await reload()
    })
  }

  async function doAction(action: Ec2InstanceAction) {
    if (!selectedId) return
    await runEc2Mutation(async () => {
      await runEc2InstanceAction(connection, selectedId, action)
      setMsg(`${action} sent`)
      await reload()
    })
  }

  async function doDescribe() {
    if (!selectedId) return
    await selectInstance(selectedId)
    setShowDescribe(true)
    setMsg(`Loaded describe data for ${selectedId}`)
  }

  async function doTerminate() {
    if (!selectedId) return
    await runEc2Mutation(async () => {
      await terminateEc2Instance(connection, selectedId)
      setMsg('Terminate sent')
      await reload()
    })
  }

  async function doResize() {
    if (!selectedId || !resizeType) return
    try {
      await resizeEc2Instance(connection, selectedId, resizeType)
      setMsg(`Resize to ${resizeType} sent (instance must be stopped)`)
      setShowResize(false)
      await reload()
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)) }
  }

  async function doLoadTypes() {
    const arch = detail?.architecture !== '-' ? detail?.architecture : undefined
    setInstanceTypes(await listInstanceTypes(connection, arch))
  }

  async function doAttachIam() {
    if (!selectedId || !iamName) return
    await runEc2Mutation(async () => {
      await attachIamProfile(connection, selectedId, iamName)
      setMsg('IAM profile attached')
      setIamAssoc(await getIamAssociation(connection, selectedId))
    })
  }

  async function doReplaceIam() {
    if (!iamAssoc || !iamName) return
    await runEc2Mutation(async () => {
      await replaceIamProfile(connection, iamAssoc.associationId, iamName)
      setMsg('IAM profile replaced')
      setIamAssoc(await getIamAssociation(connection, selectedId))
    })
  }

  async function doRemoveIam() {
    if (!iamAssoc) return
    await runEc2Mutation(async () => {
      await removeIamProfile(connection, iamAssoc.associationId)
      setMsg('IAM profile removed')
      setIamAssoc(null)
    })
  }

  async function doCreateSnap() {
    if (!snapVolume) return
    await runEc2Mutation(async () => {
      const id = await createEc2Snapshot(connection, snapVolume, snapDesc)
      setMsg(`Snapshot ${id} created`)
      setSnapshots(await listEc2Snapshots(connection))
    })
  }

  async function doDeleteSnap() {
    if (!selectedSnapId) return
    await runEc2Mutation(async () => {
      await deleteEc2Snapshot(connection, selectedSnapId)
      setMsg(`Snapshot ${selectedSnapId} deleted`)
      setSnapshots(await listEc2Snapshots(connection))
    })
  }

  async function doTagSnap() {
    if (!selectedSnapId || !tagKey) return
    await runEc2Mutation(async () => {
      await tagEc2Snapshot(connection, selectedSnapId, { [tagKey]: tagValue })
      setMsg('Tag applied')
      setSnapshots(await listEc2Snapshots(connection))
    })
  }

  async function doApplyGovernanceTagsToSnapshot(): Promise<void> {
    if (!selectedSnapId) {
      return
    }

    const tags = resolveConfiguredGovernanceTags(governanceDefaults)
    if (!Object.keys(tags).length) {
      setMsg(governanceDefaults?.inheritByDefault === false
        ? 'Governance tag inheritance is disabled in Settings.'
        : 'No governance tag defaults are configured in Settings.')
      return
    }

    await runEc2Mutation(async () => {
      await tagEc2Snapshot(connection, selectedSnapId, tags)
      setMsg(`Applied ${Object.keys(tags).length} governance tags to ${selectedSnapId}`)
      setSnapshots(await listEc2Snapshots(connection))
    })
  }

  async function refreshSelectedVolume(): Promise<void> {
    if (!selectedVolumeId) {
      return
    }
    await selectVolume(selectedVolumeId, { preserveExisting: true })
    setVolumes(await listEbsVolumes(connection))
    setSnapshots(await listEc2Snapshots(connection))
  }

  async function doTagVolume() {
    if (!volumeDetail || !volumeTagKey.trim()) {
      return
    }
    await runEc2Mutation(async () => {
      await tagEbsVolume(connection, volumeDetail.volumeId, { [volumeTagKey.trim()]: volumeTagValue })
      setVolumeTagKey('')
      setVolumeTagValue('')
      setMsg(`Tag ${volumeTagKey.trim()} applied to ${volumeDetail.volumeId}`)
      await refreshSelectedVolume()
    })
  }

  async function doApplyGovernanceTagsToVolume(): Promise<void> {
    if (!volumeDetail) {
      return
    }

    const tags = resolveConfiguredGovernanceTags(governanceDefaults)
    if (!Object.keys(tags).length) {
      setMsg(governanceDefaults?.inheritByDefault === false
        ? 'Governance tag inheritance is disabled in Settings.'
        : 'No governance tag defaults are configured in Settings.')
      return
    }

    await runEc2Mutation(async () => {
      await tagEbsVolume(connection, volumeDetail.volumeId, tags)
      setMsg(`Applied ${Object.keys(tags).length} governance tags to ${volumeDetail.volumeId}`)
      await refreshSelectedVolume()
    })
  }

  async function doUntagVolume(tagKeyToRemove: string) {
    if (!volumeDetail || !tagKeyToRemove) {
      return
    }
    await runEc2Mutation(async () => {
      await untagEbsVolume(connection, volumeDetail.volumeId, [tagKeyToRemove])
      setMsg(`Tag ${tagKeyToRemove} removed from ${volumeDetail.volumeId}`)
      await refreshSelectedVolume()
    })
  }

  async function doAttachVolume() {
    if (!volumeDetail || !volumeAttachInstanceId.trim() || !volumeAttachDevice.trim()) {
      setMsg('Enter an instance ID and device name.')
      return
    }
    await runEc2Mutation(async () => {
      await attachEbsVolume(connection, volumeDetail.volumeId, {
        instanceId: volumeAttachInstanceId.trim(),
        device: volumeAttachDevice.trim()
      })
      setMsg(`Attach requested for ${volumeDetail.volumeId}`)
      await refreshSelectedVolume()
    })
  }

  async function doDetachVolume(attachment?: EbsVolumeDetail['attachments'][number]) {
    if (!volumeDetail) {
      return
    }
    await runEc2Mutation(async () => {
      await detachEbsVolume(connection, volumeDetail.volumeId, attachment
        ? { instanceId: attachment.instanceId, device: attachment.device }
        : undefined)
      setMsg(`Detach requested for ${volumeDetail.volumeId}`)
      await refreshSelectedVolume()
    })
  }

  async function doDeleteVolume() {
    if (!volumeDetail) {
      return
    }
    await runEc2Mutation(async () => {
      await deleteEbsVolume(connection, volumeDetail.volumeId)
      setMsg(`Volume ${volumeDetail.volumeId} deleted`)
      await reload()
    })
  }

  async function doModifyVolume() {
    if (!volumeDetail) {
      return
    }

    const sizeGiB = Number(volumeModifySize)
    const iops = volumeModifyIops.trim() ? Number(volumeModifyIops) : undefined
    const throughput = volumeModifyThroughput.trim() ? Number(volumeModifyThroughput) : undefined

    if (!Number.isFinite(sizeGiB) || sizeGiB <= 0) {
      setMsg('Enter a valid volume size in GiB.')
      return
    }
    if (iops !== undefined && (!Number.isFinite(iops) || iops <= 0)) {
      setMsg('Enter a valid IOPS value.')
      return
    }
    if (throughput !== undefined && (!Number.isFinite(throughput) || throughput <= 0)) {
      setMsg('Enter a valid throughput value.')
      return
    }

    await runEc2Mutation(async () => {
      await modifyEbsVolume(connection, volumeDetail.volumeId, {
        sizeGiB,
        type: volumeModifyType.trim() || undefined,
        iops,
        throughput
      })
      setMsg(`Modify requested for ${volumeDetail.volumeId}`)
      await refreshSelectedVolume()
    })
  }

  function openVolumeFromSnapshot(volumeId: string) {
    if (!volumeId || volumeId === '-') {
      return
    }
    setMainTab('volumes')
    void selectVolume(volumeId)
  }

  async function doLaunchBastion() {
    if (!detail || !bastionAmi || !bastionSubnet || !bastionKeyPair) return
    const targetInstanceId = detail.instanceId
    const statusBase: BastionWorkflowStatus = {
      mode: 'create',
      stage: 'preparing',
      targetInstanceId,
      targetName: detail.name,
      imageId: bastionAmi,
      instanceType: bastionType,
      subnetId: bastionSubnet,
      keyName: bastionKeyPair,
      securityGroupId: bastionSg
    }
    setBastionLaunchStatus(statusBase)
    try {
      setBastionLaunchStatus({ ...statusBase, stage: 'executing' })
      const id = await launchBastion(connection, {
        imageId: bastionAmi,
        instanceType: bastionType,
        subnetId: bastionSubnet,
        keyName: bastionKeyPair,
        securityGroupIds: bastionSg ? [bastionSg] : [],
        targetInstanceId
      })
      setBastionLaunchStatus({ ...statusBase, stage: 'refreshing', bastionId: id })
      await waitForBastionReady(connection, targetInstanceId, id)
      await reload()
      await selectInstance(targetInstanceId)
      setShowBastionPanel(false)
      setMsg(`Bastion ${id} launched`)
      setBastionLaunchStatus({ ...statusBase, stage: 'completed', bastionId: id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMsg(message)
      setBastionLaunchStatus({ ...statusBase, stage: 'failed', error: message })
    }
  }

  async function doDeleteBastion() {
    if (!detail) return
    const targetInstanceId = detail.tags[BASTION_TARGET_INSTANCE_TAG] || detail.instanceId
    const statusBase: BastionWorkflowStatus = {
      mode: 'destroy',
      stage: 'preparing',
      targetInstanceId,
      targetName: detail.name,
      imageId: detail.imageId,
      instanceType: detail.type,
      subnetId: detail.subnetId,
      keyName: detail.keyName,
      securityGroupId: detail.securityGroups[0]?.id ?? '',
      bastionId: detail.instanceId
    }
    setBastionLaunchStatus(statusBase)
    try {
      setBastionLaunchStatus({ ...statusBase, stage: 'executing' })
      await deleteBastion(connection, targetInstanceId)
      setBastionLaunchStatus({ ...statusBase, stage: 'refreshing' })
      if (statusBase.bastionId) {
        await waitForBastionRemoval(connection, targetInstanceId, statusBase.bastionId)
      }
      setLinkedBastions([])
      await reload()
      await selectInstance(targetInstanceId)
      setMsg('Deleted bastion')
      setBastionLaunchStatus({ ...statusBase, stage: 'completed' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMsg(message)
      setBastionLaunchStatus({ ...statusBase, stage: 'failed', error: message })
    }
  }

  async function doCheckVolume() {
    if (!volumeDetail || volumeDetail.status !== 'available-orphan') {
      return
    }
    setVolumeWorkflowStatus({
      mode: 'create',
      volumeId: volumeDetail.volumeId,
      volumeName: volumeDetail.name,
      tempUuid: '',
      instanceId: '',
      stage: 'preparing',
      message: `Preparing temporary inspection environment for ${volumeDetail.volumeId}.`
    })
    try {
      const environment = await createTempVolumeCheck(connection, volumeDetail.volumeId)
      await reload()
      await selectVolume(volumeDetail.volumeId)
      setMsg('Temporary inspection instance is ready. Connect via SSM and inspect the attached volume under /mnt.')
      setVolumeWorkflowStatus({
        mode: 'create',
        volumeId: volumeDetail.volumeId,
        volumeName: volumeDetail.name,
        tempUuid: environment.tempUuid,
        instanceId: environment.instanceId,
        stage: 'completed',
        message: 'Temporary inspection instance is ready. Connect via SSM and inspect the attached volume under /mnt.'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMsg(message)
      setVolumeWorkflowStatus((current) => current ? { ...current, stage: 'failed', error: message, message } : null)
    }
  }

  async function doDeleteTempInspection(target: string, fallbackVolumeId?: string) {
    const currentVolumeId = fallbackVolumeId ?? volumeDetail?.volumeId ?? '-'
    setVolumeWorkflowStatus({
      mode: 'delete',
      volumeId: currentVolumeId,
      volumeName: volumeDetail?.name ?? currentVolumeId,
      tempUuid: target.startsWith('i-') ? '' : target,
      instanceId: target.startsWith('i-') ? target : '',
      stage: 'preparing',
      message: `Preparing cleanup for ${target}.`
    })
    try {
      await deleteTempVolumeCheck(connection, target)
      await reload()
      if (currentVolumeId && currentVolumeId !== '-') {
        await selectVolume(currentVolumeId).catch(() => undefined)
      }
      if (detail?.instanceId === target) {
        await selectInstance(detail.tags['aws-lens:source-volume-id'] || detail.instanceId).catch(() => undefined)
      }
      setMsg('Temporary inspection resources deleted')
      setVolumeWorkflowStatus((current) => current ? { ...current, stage: 'completed', message: 'Temporary inspection resources were deleted.' } : null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMsg(message)
      setVolumeWorkflowStatus((current) => current ? { ...current, stage: 'failed', error: message, message } : null)
    }
  }

  async function loadPopularAmis(): Promise<void> {
    setLoadingPopularBastionAmis(true)
    try {
      const items = await listPopularBastionAmis(connection, detail?.architecture !== '-' ? detail?.architecture : undefined)
      setPopularBastionAmis(items)
      if ((!bastionAmi || bastionAmi === '-') && items[0]?.imageId) {
        setBastionAmi(items[0].imageId)
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingPopularBastionAmis(false)
    }
  }

  async function loadBastionTypes(): Promise<void> {
    setLoadingBastionTypes(true)
    try {
      const arch = detail?.architecture !== '-' ? detail?.architecture : undefined
      const types = await listInstanceTypes(connection, arch, false)
      const filtered = types
        .filter((type) => /^t\d|^t[3-9][a-z]?/i.test(type.instanceType) || type.instanceType.toLowerCase().startsWith('t'))
        .sort((a, b) => a.instanceType.localeCompare(b.instanceType, undefined, { numeric: true }))
      setBastionTypes(filtered)
      if (filtered.length > 0 && !filtered.some((type) => type.instanceType === bastionType)) {
        setBastionType(filtered[0].instanceType)
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingBastionTypes(false)
    }
  }

  async function loadBastionNetworkOptions(): Promise<void> {
    setLoadingBastionNetworkOptions(true)
    try {
      const vpcId = detail?.vpcId !== '-' ? detail?.vpcId : undefined
      const [keyPairs, subnets, securityGroups] = await Promise.all([
        listKeyPairs(connection),
        listSubnets(connection, vpcId),
        listSecurityGroupsForVpc(connection, vpcId)
      ])
      setBastionKeyPairs(keyPairs)
      setBastionSubnets(subnets)
      setBastionSecurityGroups(securityGroups)

      if ((!bastionKeyPair || bastionKeyPair === '-') && keyPairs[0]?.keyName) {
        setBastionKeyPair(keyPairs[0].keyName)
      }
      if ((!bastionSubnet || bastionSubnet === '-') && subnets[0]?.subnetId) {
        setBastionSubnet(subnets[0].subnetId)
      }
      if ((!bastionSg || bastionSg === '-') && securityGroups[0]?.groupId) {
        setBastionSg(securityGroups[0].groupId)
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingBastionNetworkOptions(false)
    }
  }

  function openBastionPanel(): void {
    if (detail) {
      setBastionAmi(detail.imageId !== '-' ? detail.imageId : '')
      setBastionSubnet(detail.subnetId !== '-' ? detail.subnetId : '')
      setBastionKeyPair(detail.keyName !== '-' ? detail.keyName : '')
      setBastionSg(detail.securityGroups[0]?.id ?? '')
    }
    setShowBastionPanel(true)
    void loadPopularAmis()
    void loadBastionTypes()
    void loadBastionNetworkOptions()
  }

  async function doLaunchFromSnap() {
    if (!selectedSnapId || !snapLaunchName || !snapLaunchSubnet || !snapLaunchKey) return
    const id = await launchFromSnapshot(connection, {
      snapshotId: selectedSnapId,
      name: snapLaunchName,
      instanceType: snapLaunchType,
      subnetId: snapLaunchSubnet,
      keyName: snapLaunchKey,
      securityGroupIds: snapLaunchSg ? [snapLaunchSg] : [],
      architecture: snapLaunchArch
    })
    setMsg(`Instance ${id} launched from snapshot`)
    await reload()
  }

  async function resolveCurrentSshKeyInput(): Promise<{ value: string; vaultEntryId: string; vaultEntryName: string }> {
    const trimmedValue = sshKey.trim()
    if (!trimmedValue) {
      throw new Error('Provide a PEM key path, vault key name, or public key.')
    }

    const matchedVaultEntry = findSshVaultEntry(sshVaultEntries, trimmedValue, sshVaultEntryId)
    if (!matchedVaultEntry) {
      return {
        value: trimmedValue,
        vaultEntryId: '',
        vaultEntryName: ''
      }
    }

    const materializedKeyPath = await materializeEc2VaultSshKey(matchedVaultEntry.id)
    setSshVaultEntryId(matchedVaultEntry.id)
    setSshVaultEntryName(matchedVaultEntry.name)

    return {
      value: materializedKeyPath,
      vaultEntryId: matchedVaultEntry.id,
      vaultEntryName: matchedVaultEntry.name
    }
  }

  async function doSshConnect() {
    if (!detail || !onRunTerminalCommand) {
      return
    }

    try {
      const resolvedKey = await resolveCurrentSshKeyInput()
      let usedEc2InstanceConnect = false

      try {
        await markSelectedPemUsed('ec2-instance-connect', resolvedKey.vaultEntryId)
        usedEc2InstanceConnect = await sendSshPublicKey(connection, selectedId, sshUser, resolvedKey.value, detail.availabilityZone)
      } catch {
        usedEc2InstanceConnect = false
      }

      await markSelectedPemUsed('ec2-ssh-connect', resolvedKey.vaultEntryId)
      const sshTarget = detail.publicIp !== '-' ? detail.publicIp : detail.privateIp
      onRunTerminalCommand(`ssh -i ${quoteSshArg(resolvedKey.value)} ${sshUser}@${sshTarget}`)
      setMsg(
        usedEc2InstanceConnect
          ? resolvedKey.vaultEntryName
            ? `SSH command opened with temporary EC2 Instance Connect key using vault key ${resolvedKey.vaultEntryName}`
            : 'SSH command opened with temporary EC2 Instance Connect key'
          : resolvedKey.vaultEntryName
            ? `SSH command opened in terminal using vault key ${resolvedKey.vaultEntryName}`
            : 'SSH command opened in terminal'
      )
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to prepare SSH command')
    }
  }

  async function markSelectedPemUsed(source: string, entryId = sshVaultEntryId): Promise<void> {
    if (!entryId) {
      return
    }

    try {
      await recordVaultEntryUse({
        id: entryId,
        source,
        profile: connection.profile,
        region: connection.region,
        resourceId: selectedId,
        resourceLabel: detail?.name && detail.name !== '-' ? detail.name : selectedId
      })
    } catch {
      // Ignore vault usage telemetry failures during SSH workflows.
    }
  }

  async function handleBrowseSshKey() {
    try {
      const selectedKey = await chooseEc2SshKey()
      if (!selectedKey) {
        return
      }
      applySshKeyInput(selectedKey.vaultEntryName, selectedKey.vaultEntryId)
      setSshVaultEntryId(selectedKey.vaultEntryId)
      setSshVaultEntryName(selectedKey.vaultEntryName)
      await loadSshVaultEntries()
      setMsg(`Imported ${selectedKey.sourceLabel} into the encrypted vault as ${selectedKey.vaultEntryName}`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to choose SSH key')
    }
  }

  /* ── Filtering ─────────────────────────────────────────── */
  async function doOpenSsmShell(targetInstanceId = selectedId): Promise<void> {
    if (!targetInstanceId || !onRunTerminalCommand) {
      return
    }
    setSsmShellBusy(true)
    try {
      const launch = await startSsmSession(connection, {
        targetInstanceId,
        accessType: 'shell'
      })
      onRunTerminalCommand(launch.launchCommand)
      setMsg(`Session Manager shell opened for ${targetInstanceId}`)
      setTimeout(() => {
        void loadSsmForInstance(targetInstanceId)
      }, 3000)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setSsmShellBusy(false)
    }
  }

  async function doOpenPortForward(preset: SsmPortForwardPreset): Promise<void> {
    if (!selectedId || !onRunTerminalCommand) {
      return
    }
    setSsmShellBusy(true)
    try {
      const launch = await startSsmSession(connection, {
        targetInstanceId: selectedId,
        documentName: preset.documentName,
        parameters: {
          portNumber: [String(preset.remotePort)],
          localPortNumber: [String(preset.localPort)],
          ...(preset.remoteHost ? { host: [preset.remoteHost] } : {})
        },
        accessType: 'port-forward'
      })
      onRunTerminalCommand(launch.launchCommand)
      setMsg(`${preset.label} tunnel opened in terminal`)
      setTimeout(() => {
        void loadSsmForInstance(selectedId)
      }, 3000)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setSsmShellBusy(false)
    }
  }

  async function doOpenCustomPortForward(): Promise<void> {
    const remotePort = Number(customRemotePort)
    const localPort = Number(customLocalPort)
    if (!selectedId || !onRunTerminalCommand || !Number.isInteger(remotePort) || !Number.isInteger(localPort) || remotePort <= 0 || localPort <= 0) {
      setMsg('Enter valid local and remote ports.')
      return
    }
    await doOpenPortForward({
      id: 'custom',
      label: `Custom ${localPort}:${remotePort}`,
      description: 'Custom port forward',
      documentName: 'AWS-StartPortForwardingSession',
      localPort,
      remotePort,
      remoteHost: ''
    })
  }

  async function doRunSsmCommand(): Promise<void> {
    if (!selectedId || !ssmCommandInput.trim()) {
      return
    }
    setSsmCommandBusy(true)
    try {
      const result = await sendSsmCommand(connection, {
        instanceId: selectedId,
        documentName: ssmCommandDocument,
        commands: ssmCommandInput
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        comment: `${ssmCommandDocument} from AWS Lens`
      })
      setSsmCommandHistory((current) => ({
        ...current,
        [selectedId]: [result, ...(current[selectedId] ?? [])].slice(0, 10)
      }))
      await loadSsmForInstance(selectedId)
      setMsg(`Command ${result.statusDetails}`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setSsmCommandBusy(false)
    }
  }

  function applySsmCommandPreset(presetId: string): void {
    const preset = SSM_COMMAND_PRESETS.find((entry) => entry.id === presetId)
    if (!preset) {
      return
    }
    const commands = isWindowsPlatform(detail?.platform ?? '') ? preset.windows : preset.linux
    setSsmCommandDocument(isWindowsPlatform(detail?.platform ?? '') ? 'AWS-RunPowerShellScript' : 'AWS-RunShellScript')
    setSsmCommandInput(commands.join('\n'))
  }

  const filteredInstances = instances.filter(i => {
    if (stateFilter !== 'all' && i.state !== stateFilter) return false
    if (searchFilter) {
      const search = searchFilter.toLowerCase()
      const cols = Array.from(visibleCols)
      return cols.some(col => getColumnValue(i, col).toLowerCase().includes(search)) ||
        ssmStatusLabel(i.ssmStatus).toLowerCase().includes(search) ||
        (i.isTempInspectionInstance && 'temporary inspection'.includes(search))
    }
    return true
  })

  const filteredVolumes = volumes.filter((volume) => {
    if (!volumeFilter) {
      return true
    }
    const search = volumeFilter.toLowerCase()
    return [
      volume.volumeId,
      volume.name,
      volume.state,
      volume.status,
      volume.type,
      volume.availabilityZone,
      volume.snapshotId,
      volume.attachedInstanceIds.join(' '),
      volume.attachedDevices.join(' ')
    ].some((value) => value.toLowerCase().includes(search))
  })

  function toggleColumn(key: ColumnKey) {
    setVisibleCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const activeCols = COLUMNS.filter(c => visibleCols.has(c.key))
  const visibleInstanceIds = filteredInstances.map((instance) => instance.instanceId)
  const selectedVisibleCount = visibleInstanceIds.filter((instanceId) => selectedInstanceIds.includes(instanceId)).length
  const allVisibleSelected = visibleInstanceIds.length > 0 && selectedVisibleCount === visibleInstanceIds.length

  /* ── Derived data ────────────────────────────────────────── */
  const selectedInstance = instances.find((instance) => instance.instanceId === selectedId) ?? null
  const isTerminatedInstance = selectedInstance?.state === 'terminated'
  const selectedVolume = volumes.find((volume) => volume.volumeId === selectedVolumeId) ?? null
  const selectedSnap = snapshots.find((s) => s.snapshotId === selectedSnapId) ?? null
  const selectedVolumeSnapshot = volumeDetail?.snapshotId && volumeDetail.snapshotId !== '-'
    ? snapshots.find((snapshot) => snapshot.snapshotId === volumeDetail.snapshotId) ?? null
    : null
  const selectedVolumePrimaryAttachment = volumeDetail?.attachments[0] ?? null
  const selectedVolumeAttachedInstance = selectedVolumePrimaryAttachment
    ? instances.find((instance) => instance.instanceId === selectedVolumePrimaryAttachment.instanceId) ?? null
    : null
  const selectedVolumeTempSsmStatus = volumeTempSsmTarget?.status
    ?? (volumeDetail?.tempEnvironment?.ssmReady ? 'managed-online' : 'not-managed')
  const hasManagedBastionTag = Object.keys(detail?.tags ?? {}).some((key) => key.startsWith('aws-lens-bastion/') || key.startsWith('aws-lens-bastion#'))
  const isSelectedBastion = bastions.some((instance) => instance.instanceId === selectedId)
  const isSelectedTempInspectionInstance = detail?.tags?.['aws-lens:purpose'] === 'ebs-inspection'
  const bastionLaunchBusy = bastionLaunchStatus !== null && !['completed', 'failed'].includes(bastionLaunchStatus.stage)
  const volumeWorkflowBusy = volumeWorkflowStatus !== null && !['completed', 'failed'].includes(volumeWorkflowStatus.stage)
  const ssmHistory = selectedId ? (ssmCommandHistory[selectedId] ?? []) : []
  const ssmOnlineCount = ssmManagedInstances.filter((instance) => instance.pingStatus === 'Online').length
  const configuredGovernanceTags = resolveConfiguredGovernanceTags(governanceDefaults)
  const configuredGovernanceTagCount = Object.keys(configuredGovernanceTags).length
  const volumeWarnings = volumeDetail ? [
    !volumeDetail.encrypted && volumeDetail.status === 'available-orphan' ? 'High priority: orphan volume is unencrypted.' : '',
    volumeDetail.type === 'gp2' ? 'Recommendation: migrate gp2 to gp3 for lower cost and more predictable performance.' : '',
    volumeDetail.status === 'available-orphan' && volumeDetail.createTime !== '-' && (Date.now() - new Date(volumeDetail.createTime).getTime()) > 1000 * 60 * 60 * 24 * 14
      ? 'Warning: orphan volume looks stale and has been unattached for more than 14 days.'
      : '',
    GOVERNANCE_TAG_KEYS.some((key) => !(volumeDetail.tags[key] || '').trim()) ? 'Warning: missing governance tags (Owner, Environment, Project, or CostCenter).' : ''
  ].filter(Boolean) : []
  const runningInstancesCount = instances.filter((instance) => instance.state === 'running').length
  const stoppedInstancesCount = instances.filter((instance) => instance.state === 'stopped').length
  const orphanVolumeCount = volumes.filter((volume) => volume.status === 'available-orphan').length
  const snapshotReadyCount = snapshots.filter((snapshot) => snapshot.state === 'completed').length
  const heroStats = mainTab === 'instances'
    ? [
        { label: 'Fleet', value: String(instances.length), detail: `${runningInstancesCount} running / ${stoppedInstancesCount} stopped`, tone: 'accent' },
        { label: 'SSM Coverage', value: `${ssmOnlineCount}/${ssmManagedInstances.length}`, detail: 'managed instances online', tone: 'info' },
        { label: 'Rightsizing', value: String(recommendations.length), detail: 'active recommendations', tone: recommendations.length ? 'warning' : 'default' },
        {
          label: 'Selection',
          value: selectedInstanceIds.length > 1
            ? `${selectedInstanceIds.length} instances`
            : (selectedInstance?.name && selectedInstance.name !== '-' ? selectedInstance.name : (selectedId || 'No instance selected')),
          detail: selectedInstanceIds.length > 1
            ? `${selectedVisibleCount} of ${filteredInstances.length} visible rows selected`
            : (selectedInstance ? `${selectedInstance.type} in ${selectedInstance.availabilityZone}` : 'pick an instance to inspect'),
          tone: 'default'
        }
      ]
    : mainTab === 'volumes'
      ? [
          { label: 'Volumes', value: String(volumes.length), detail: `${orphanVolumeCount} orphaned volumes`, tone: 'accent' },
          { label: 'Inspection', value: volumeWorkflowBusy ? 'Active' : 'Idle', detail: volumeWorkflowStatus?.message ?? 'temporary inspection environments', tone: volumeWorkflowBusy ? 'info' : 'default' },
          { label: 'Warnings', value: String(volumeWarnings.length), detail: selectedVolume ? (selectedVolume.name !== '-' ? selectedVolume.name : selectedVolume.volumeId) : 'select a volume for policy checks', tone: volumeWarnings.length ? 'warning' : 'default' },
          { label: 'Selection', value: selectedVolume?.name && selectedVolume.name !== '-' ? selectedVolume.name : (selectedVolumeId || 'No volume selected'), detail: selectedVolume ? formatVolumeSettings(selectedVolume) : 'choose a volume to view topology', tone: 'default' }
        ]
      : [
          { label: 'Snapshots', value: String(snapshots.length), detail: `${snapshotReadyCount} completed`, tone: 'accent' },
          { label: 'Selected', value: selectedSnap?.tags.Name || selectedSnap?.snapshotId || 'No snapshot selected', detail: selectedSnap ? `${selectedSnap.volumeSize} GiB from ${selectedSnap.volumeId}` : 'browse snapshot inventory', tone: 'default' },
          { label: 'Source Volume', value: selectedSnap?.volumeId || '-', detail: selectedSnap ? selectedSnap.progress : 'launch and tag workflows preserved', tone: 'info' },
          { label: 'Session', value: connection.kind === 'assumed-role' ? 'Assumed role' : 'Profile session', detail: connection.profile, tone: 'default' }
        ]

  if (loading) return <SvcState variant="loading" resourceName="EC2" />

  return (
    <div className="ec2-console">
      <section className="ec2-shell-hero">
        <div className="ec2-shell-hero-copy">
          <span className="ec2-shell-kicker">Compute Operations</span>
          <h2>EC2 inventory, storage workflows, and access paths in one workspace.</h2>
          <p>
            Review fleet state, inspect attached storage, manage snapshots, and drive SSM or bastion workflows from the same operational surface.
          </p>
          <div className="ec2-shell-meta-strip">
            <div className="ec2-shell-meta-pill">
              <span>Profile</span>
              <strong>{connection.profile}</strong>
            </div>
            <div className="ec2-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="ec2-shell-meta-pill">
              <span>Session</span>
              <strong>{connection.kind === 'assumed-role' ? 'Assumed role' : 'Profile session'}</strong>
            </div>
            <div className="ec2-shell-meta-pill">
              <span>Focus</span>
              <strong>{mainTab === 'instances' ? 'Instances' : mainTab === 'volumes' ? 'Volumes' : 'Snapshots'}</strong>
            </div>
          </div>
        </div>
        <div className="ec2-shell-hero-stats">
          {heroStats.map((stat) => (
            <div
              key={stat.label}
              className={`ec2-shell-stat-card${stat.tone === 'accent' ? ' accent' : stat.tone === 'warning' ? ' warning' : stat.tone === 'info' ? ' info' : ''}`}
            >
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small>{stat.detail}</small>
            </div>
          ))}
        </div>
      </section>
      <div className="ec2-shell-toolbar">
        <div className="ec2-shell-status">
          <FreshnessIndicator freshness={inventoryFreshness} label="Inventory last updated" />
          {(mainTab === 'instances' || volumeWorkflowBusy || bastionLaunchBusy) && (
            <FreshnessIndicator freshness={sessionFreshness} label="Session-sensitive detail last updated" staleLabel="Refresh detail" />
          )}
        </div>

      {/* ── Main tabs ─────────────────────────────────── */}
      <div className="ec2-tab-bar">
        <button
          className={`ec2-tab ${mainTab === 'instances' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('instances')}
        >Instances</button>
        <button
          className={`ec2-tab ${mainTab === 'volumes' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('volumes')}
        >Volumes</button>
        <button
          className={`ec2-tab ${mainTab === 'snapshots' ? 'active' : ''}`}
          type="button"
          onClick={() => setMainTab('snapshots')}
        >Snapshots</button>
        <button className="ec2-toolbar-btn accent" type="button" onClick={() => void reload('manual')}>Refresh</button>
      </div>
      </div>

      {msg && <div className="ec2-msg">{msg}</div>}

      {/* ══════════════════ INSTANCES ══════════════════ */}
      {mainTab === 'instances' && (
        <>
          <div className="ec2-filter-shell">
            <div className="ec2-filter-grid">
              <div className="ec2-filter-field">
                <span className="ec2-filter-label">State</span>
                <select
                  className="ec2-select"
                  value={stateFilter}
                  onChange={e => setStateFilter(e.target.value)}
                >
                  <option value="all">All states</option>
                  <option value="running">Running</option>
                  <option value="stopped">Stopped</option>
                  <option value="pending">Pending</option>
                  <option value="terminated">Terminated</option>
                </select>
              </div>

              <div className="ec2-filter-field ec2-filter-field-search">
                <span className="ec2-filter-label">Search</span>
                <input
                  className="ec2-search-input"
                  placeholder="Filter rows across selected columns..."
                  value={searchFilter}
                  onChange={e => setSearchFilter(e.target.value)}
                />
              </div>
            </div>

            <div className="ec2-column-chips">
              {COLUMNS.map(col => (
                <button
                  key={col.key}
                  className={`ec2-chip ${visibleCols.has(col.key) ? 'active' : ''}`}
                  type="button"
                  style={visibleCols.has(col.key) ? { background: col.color, borderColor: col.color, color: '#fff' } : undefined}
                  onClick={() => toggleColumn(col.key)}
                >
                  {col.label}
                </button>
              ))}
            </div>

            {recommendations.length > 0 && (
              <div className="ec2-rec-summary">
                <span className="ec2-rec-icon">!</span>
                <span>{recommendations.length} right-sizing recommendation{recommendations.length > 1 ? 's' : ''} based on 7-day CPU usage</span>
                {recsLoading && <span className="ec2-rec-loading">Refreshing...</span>}
              </div>
            )}
            {recommendations.length === 0 && recsLoading && (
              <div className="ec2-rec-summary info">
                <span className="ec2-rec-icon">!</span>
                <span>Refreshing recommendations...</span>
              </div>
            )}
          </div>

          <div className="ec2-main-layout">
            {/* ── Table area ──────────────────────────── */}
            <div className="ec2-table-shell">
              <div className="ec2-table-shell-header">
                <div>
                  <h3>Instance Inventory</h3>
                  <p>{filteredInstances.length} visible rows across {activeCols.length} active columns. {selectedInstanceIds.length} selected for bulk actions.</p>
                </div>
                <div className="ec2-table-shell-meta">
                  <span className="ec2-workspace-badge">{runningInstancesCount} running</span>
                  <span className="ec2-workspace-badge">{ssmOnlineCount} SSM online</span>
                </div>
              </div>
              {selectedInstanceIds.length > 0 && (
                <div className="ec2-selection-toolbar">
                  <div className="ec2-selection-summary">
                    <strong>{selectedInstanceIds.length} selected</strong>
                    <span>{selectedVisibleCount} visible in the current filter</span>
                  </div>
                  <div className="ec2-selection-actions">
                    <button className="ec2-action-btn start" type="button" onClick={() => void doBulkAction('start')}>Bulk Start</button>
                    <ConfirmButton className="ec2-action-btn stop" type="button" onConfirm={() => void doBulkAction('stop')}>Bulk Stop</ConfirmButton>
                    <ConfirmButton className="ec2-action-btn" type="button" onConfirm={() => void doBulkAction('reboot')}>Bulk Reboot</ConfirmButton>
                    <button className="ec2-action-btn" type="button" onClick={() => setSelectedInstanceIds([])}>Clear</button>
                  </div>
                </div>
              )}
              <div className="ec2-table-area">
              <table className="ec2-data-table">
                <thead>
                  <tr>
                    <th className="ec2-select-col">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={() => toggleAllVisibleInstances()}
                        aria-label="Select all visible instances"
                      />
                    </th>
                    {activeCols.map(col => (
                      <th key={col.key}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredInstances.map(inst => {
                    const rec = recommendationMap.get(inst.instanceId)
                    const isBulkSelected = selectedInstanceIds.includes(inst.instanceId)
                    return (
                      <tr
                        key={inst.instanceId}
                        className={[
                          inst.instanceId === selectedId ? 'active' : '',
                          isBulkSelected ? 'bulk-selected' : ''
                        ].filter(Boolean).join(' ')}
                        onClick={() => void selectInstance(inst.instanceId)}
                      >
                        <td className="ec2-select-col">
                          <input
                            type="checkbox"
                            checked={isBulkSelected}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleInstanceSelection(inst.instanceId)}
                            aria-label={`Select ${inst.instanceId}`}
                          />
                        </td>
                        {activeCols.map(col => (
                          <td key={col.key}>
                            {col.key === 'state'
                              ? (
                                <div className="ec2-cell-stack">
                                  <span className={`ec2-badge ${inst.state}`}>{inst.state}</span>
                                  <span className={`ec2-badge ${ssmStatusTone(inst.ssmStatus)}`}>{ssmStatusLabel(inst.ssmStatus)}</span>
                                </div>
                              )
                              : col.key === 'name' && inst.isTempInspectionInstance
                                ? <span className="ec2-rec-name">{getColumnValue(inst, col.key)} <span className="ec2-inline-flag">Temp</span></span>
                              : col.key === 'name' && rec
                                ? <span className="ec2-rec-name">{getColumnValue(inst, col.key)} <span className="ec2-rec-icon" title={rec.reason}>!</span></span>
                                : col.key === 'type' && rec
                                  ? <span className="ec2-rec-name">{getColumnValue(inst, col.key)} <span className="ec2-rec-icon" title={rec.reason}>!</span></span>
                                  : getColumnValue(inst, col.key)
                            }
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!filteredInstances.length && (
                <SvcState variant="no-filter-matches" resourceName="instances" compact />
              )}
              </div>
            </div>

            {/* ── Sidebar ─────────────────────────────── */}
            <div className="ec2-sidebar">
              <div className="ec2-side-tabs">
                <button
                  className={sideTab === 'overview' ? 'active' : ''}
                  type="button"
                  onClick={() => setSideTab('overview')}
                >Overview</button>
                <button
                  className={sideTab === 'ssm' ? 'active' : ''}
                  type="button"
                  onClick={() => setSideTab('ssm')}
                >SSM</button>
                <button
                  className={sideTab === 'timeline' ? 'active' : ''}
                  type="button"
                  onClick={() => setSideTab('timeline')}
                >Change Timeline</button>
              </div>

              {/* Recommendation banner for selected instance */}
              {selectedId && recommendationMap.has(selectedId) && (() => {
                const rec = recommendationMap.get(selectedId)!
                return (
                  <div className={`ec2-rec-banner ${rec.severity}`}>
                    <div className="ec2-rec-banner-header">
                      <span className="ec2-rec-icon">!</span>
                      <strong>Right-Sizing Recommendation</strong>
                    </div>
                    <div className="ec2-rec-banner-body">
                      <div>Avg CPU: <strong>{rec.avgCpu}%</strong> · Max CPU: <strong>{rec.maxCpu}%</strong></div>
                      <div>Current: <strong>{rec.currentType}</strong> → Suggested: <strong>{rec.suggestedType}</strong></div>
                      <div className="ec2-rec-banner-reason">{rec.reason}</div>
                      <div className="ec2-btn-row" style={{ marginTop: 10 }}>
                        <button className="ec2-action-btn resize" type="button" onClick={() => {
                          setResizeType(rec.suggestedType)
                          setShowResize(true)
                          setSideTab('overview')
                        }}>
                          Review Resize
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {sideTab === 'overview' && (
                <>
                  {/* Actions */}
                  <div className="ec2-sidebar-section">
                    <h3>Actions</h3>
                    {selectedInstanceIds.length > 1 && (
                      <div className="ec2-sidebar-hint">Bulk actions target {selectedInstanceIds.length} selected instances. Sidebar actions still apply to the primary selection only.</div>
                    )}
                    <div className="ec2-actions-grid">
                      <button className="ec2-action-btn" type="button" onClick={() => void doDescribe()}>Describe</button>
                      {!isTerminatedInstance && <button className="ec2-action-btn start" type="button" onClick={() => void doAction('start')}>Start</button>}
                      {!isTerminatedInstance && <ConfirmButton className="ec2-action-btn stop" type="button" onConfirm={() => void doAction('stop')}>Stop</ConfirmButton>}
                      {!isTerminatedInstance && <ConfirmButton className="ec2-action-btn" type="button" onConfirm={() => void doAction('reboot')}>Reboot</ConfirmButton>}
                      {!isTerminatedInstance && <button className="ec2-action-btn resize" type="button" onClick={() => setShowResize(!showResize)}>Resize</button>}
                      {!isTerminatedInstance && <button className="ec2-action-btn" type="button" onClick={() => {
                        if (detail?.volumes[0]) setSnapVolume(detail.volumes[0].volumeId)
                        setMainTab('snapshots')
                      }}>Create Snapshot</button>}
                      {!isTerminatedInstance && <button className="ec2-action-btn" type="button" onClick={() => {
                        openBastionPanel()
                      }}>Create Bastion</button>}
                      {isSelectedBastion && (
                        <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doDeleteBastion()}>
                          Delete Bastion
                        </ConfirmButton>
                      )}
                      {isSelectedTempInspectionInstance && detail?.instanceId && (
                        <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doDeleteTempInspection(detail.instanceId, detail.tags['aws-lens:source-volume-id'])}>
                          Delete Temp Instance
                        </ConfirmButton>
                      )}
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        if (detail?.vpcId && detail.vpcId !== '-' && onNavigateVpc) onNavigateVpc(detail.vpcId)
                      }}>Go to VPC</button>
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        if (selectedId && onNavigateCloudWatch) onNavigateCloudWatch(selectedId)
                      }}>Go to CloudWatch</button>
                      {detail?.securityGroups?.[0]?.id && (
                        <button className="ec2-action-btn" type="button" onClick={() => {
                          if (detail?.securityGroups?.[0]?.id && onNavigateSecurityGroup) onNavigateSecurityGroup(detail.securityGroups[0].id)
                        }}>Go to Security Group</button>
                      )}
                      {adoptionLoading && (
                        <button className="ec2-action-btn" type="button" disabled>Checking Terraform...</button>
                      )}
                      {!adoptionLoading && adoptionDetection?.managedProjectCount === 0 && (
                        <button className="ec2-action-btn terraform" type="button" onClick={handleManageInTerraform}>
                          Manage in Terraform
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="ec2-sidebar-section" ref={adoptionSectionRef}>
                    <div className="ec2-section-header">
                      <div>
                        <h3>Terraform Adoption Detection</h3>
                        <div className="ec2-sidebar-hint">
                          Check whether this instance already appears in tracked Terraform state or project config before starting adoption.
                        </div>
                      </div>
                      <button className="ec2-action-btn" type="button" onClick={() => void loadAdoptionDetection(detail)} disabled={adoptionLoading}>
                        {adoptionLoading ? 'Checking...' : 'Refresh'}
                      </button>
                    </div>
                    {adoptionError && <div className="ec2-sidebar-hint ec2-adoption-error">{adoptionError}</div>}
                    {adoptionDetection && (
                      <>
                        <div className="ec2-adoption-summary">
                          <div className={`ec2-adoption-pill ${adoptionDetection.managedProjectCount > 0 ? 'managed' : adoptionDetection.configHintProjectCount > 0 ? 'config' : 'unmanaged'}`}>
                            {adoptionDetection.managedProjectCount > 0
                              ? 'Managed'
                              : adoptionDetection.configHintProjectCount > 0
                                ? 'Config hints'
                                : 'Unmanaged'}
                          </div>
                          <span>
                            {adoptionDetection.scannedProjectCount} tracked project{adoptionDetection.scannedProjectCount === 1 ? '' : 's'} scanned in {connection.region}.
                          </span>
                        </div>
                        {selectedAdoptionProject && (
                          <div className="ec2-adoption-selected-project">
                            <span className="ec2-adoption-label">Selected project</span>
                            <strong>{selectedAdoptionProject.name}</strong>
                            <small>
                              Workspace {selectedAdoptionProject.currentWorkspace || 'default'} | Region {selectedAdoptionProject.environment.region || '-'}
                            </small>
                          </div>
                        )}
                        {selectedAdoptionProject && adoptionDetection.managedProjectCount === 0 && (
                          <div className="ec2-adoption-mapping">
                            <div className="ec2-adoption-mapping-head">
                              <div>
                                <h4>Resource Mapping</h4>
                                <div className="ec2-sidebar-hint">
                                  Match this EC2 instance to a Terraform address, provider alias, and module placement before generating code.
                                </div>
                              </div>
                              {adoptionMappingLoading && <span className="ec2-adoption-pill config">Mapping...</span>}
                              {!adoptionMappingLoading && adoptionMapping && (
                                <span className={`ec2-adoption-pill ${adoptionMapping.confidence === 'high' ? 'managed' : adoptionMapping.confidence === 'medium' ? 'config' : 'unmanaged'}`}>
                                  {adoptionConfidenceLabel(adoptionMapping.confidence)} confidence
                                </span>
                              )}
                            </div>
                            {adoptionMappingError && <div className="ec2-sidebar-hint ec2-adoption-error">{adoptionMappingError}</div>}
                            {adoptionMapping && (
                              <>
                                <div className="ec2-adoption-mapping-grid">
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label">Address</span>
                                    <code>{adoptionMapping.suggestedAddress}</code>
                                    <small>{adoptionMapping.recommendedResourceType} | import id {adoptionMapping.importId}</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Placement</span>
                                    <code>{adoptionMapping.module.displayPath}</code>
                                    <small>{adoptionSourceLabel(adoptionMapping.module.source)}</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Provider</span>
                                    <code>{adoptionMapping.provider.displayName}</code>
                                    <small>{adoptionSourceLabel(adoptionMapping.provider.source)}</small>
                                  </div>
                                </div>
                                {adoptionMapping.reasons.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {adoptionMapping.reasons.map((reason) => (
                                      <div key={reason} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label">Why</span>
                                        <small>{reason}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {adoptionMapping.relatedResources.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {adoptionMapping.relatedResources.map((resource) => (
                                      <div key={`${resource.address}:${resource.matchedOn}:${resource.matchedValue}`} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label config">Related</span>
                                        <code>{resource.address}</code>
                                        <small>{resource.matchedOn} via {resource.modulePath === 'root' ? 'root module' : resource.modulePath}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {adoptionMapping.warnings.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {adoptionMapping.warnings.map((warning) => (
                                      <div key={warning} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label config">Review</span>
                                        <small>{warning}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {selectedAdoptionProject && adoptionDetection.managedProjectCount === 0 && (
                          <div className="ec2-adoption-codegen">
                            <div className="ec2-adoption-mapping-head">
                              <div>
                                <h4>Code Generation Preview</h4>
                                <div className="ec2-sidebar-hint">
                                  Preview the Terraform file placement, generated HCL skeleton, and import command before applying any file changes.
                                </div>
                              </div>
                              {adoptionCodegenLoading && <span className="ec2-adoption-pill config">Generating...</span>}
                            </div>
                            {adoptionCodegenError && <div className="ec2-sidebar-hint ec2-adoption-error">{adoptionCodegenError}</div>}
                            {adoptionCodegen && (
                              <>
                                <div className="ec2-adoption-mapping-grid">
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label">File</span>
                                    <code>{adoptionCodegen.filePlan.suggestedFileName}</code>
                                    <small>{adoptionCodegen.filePlan.action === 'append' ? 'Append existing file' : 'Create new file'}</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Module</span>
                                    <code>{adoptionCodegen.filePlan.moduleDisplayPath}</code>
                                    <small>{adoptionCodegen.filePlan.reason}</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Import</span>
                                    <code>{adoptionCodegen.mapping.importId}</code>
                                    <small>Working dir {adoptionCodegen.workingDirectory}</small>
                                  </div>
                                </div>
                                <div className="ec2-adoption-row">
                                  <span className="ec2-adoption-label">Target path</span>
                                  <code>{adoptionCodegen.filePlan.suggestedFilePath}</code>
                                  {adoptionCodegen.filePlan.existingFiles.length > 0 && (
                                    <small>Module files: {adoptionCodegen.filePlan.existingFiles.join(', ')}</small>
                                  )}
                                </div>
                                <div className="ec2-adoption-code-preview">
                                  <span className="ec2-adoption-label">HCL Preview</span>
                                  <pre className="s3-preview-text">{adoptionCodegen.resourceBlock}</pre>
                                </div>
                                <div className="ec2-adoption-code-preview">
                                  <span className="ec2-adoption-label config">Import Command</span>
                                  <pre className="s3-preview-text">{adoptionCodegen.importCommand}</pre>
                                </div>
                                {adoptionCodegen.notes.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {adoptionCodegen.notes.map((note) => (
                                      <div key={note} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label">Plan</span>
                                        <small>{note}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {adoptionCodegen.warnings.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {adoptionCodegen.warnings.map((warning) => (
                                      <div key={warning} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label config">Review</span>
                                        <small>{warning}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {selectedAdoptionProject && (adoptionCodegen || adoptionImportResult) && (
                          <div className="ec2-adoption-codegen">
                            <div className="ec2-adoption-mapping-head">
                              <div>
                                <h4>Import Execution</h4>
                                <div className="ec2-sidebar-hint">
                                  Write the reviewed HCL preview into the target Terraform file if needed, then run `terraform import` against the selected project.
                                </div>
                              </div>
                              {adoptionImportRunning && <span className="ec2-adoption-pill config">Running...</span>}
                              {!adoptionImportRunning && adoptionImportResult?.log.success && <span className="ec2-adoption-pill managed">Imported</span>}
                              {!adoptionImportRunning && adoptionImportResult && adoptionImportResult.log.success === false && <span className="ec2-adoption-pill unmanaged">Failed</span>}
                            </div>
                            <div className="ec2-btn-row">
                              <ConfirmButton
                                className="ec2-action-btn terraform"
                                disabled={adoptionImportRunning || !adoptionCodegen}
                                confirmLabel="Review import"
                                modalTitle="Run Terraform Import"
                                modalBody="This will persist the generated HCL preview into the suggested Terraform file if the resource block is missing, then run terraform import for the selected resource."
                                confirmPhrase="IMPORT"
                                confirmButtonLabel={adoptionImportRunning ? 'Running...' : 'Write HCL and Import'}
                                summaryItems={[
                                  `Project: ${selectedAdoptionProject.name}`,
                                  `Workspace: ${selectedAdoptionProject.currentWorkspace || 'default'}`,
                                  `Address: ${(adoptionCodegen ?? adoptionImportResult?.applyResult.codegen)?.mapping.suggestedAddress ?? '-'}`,
                                  `Import ID: ${(adoptionCodegen ?? adoptionImportResult?.applyResult.codegen)?.mapping.importId ?? '-'}`,
                                  `File: ${(adoptionCodegen ?? adoptionImportResult?.applyResult.codegen)?.filePlan.suggestedFilePath ?? '-'}`
                                ]}
                                onConfirm={() => void handleExecuteAdoptionImport()}
                              >
                                {adoptionImportRunning ? 'Import Running...' : 'Write HCL and Run Import'}
                              </ConfirmButton>
                            </div>
                            {adoptionImportError && <div className="ec2-sidebar-hint ec2-adoption-error">{adoptionImportError}</div>}
                            {adoptionImportResult && (
                              <>
                                <div className="ec2-adoption-mapping-grid">
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label">File write</span>
                                    <code>{adoptionImportResult.applyResult.action}</code>
                                    <small>{adoptionImportResult.applyResult.filePath}</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Import</span>
                                    <code>{adoptionImportResult.log.success ? 'success' : 'failed'}</code>
                                    <small>Exit code {adoptionImportResult.log.exitCode ?? '-'}</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Bytes</span>
                                    <code>{String(adoptionImportResult.applyResult.bytesWritten)}</code>
                                    <small>Written before import execution</small>
                                  </div>
                                </div>
                                <div className="ec2-adoption-code-preview">
                                  <span className="ec2-adoption-label">Import Output</span>
                                  <pre className="s3-preview-text">{adoptionImportResult.log.output || 'No Terraform output was captured.'}</pre>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                        {selectedAdoptionProject && (adoptionImportResult?.log.success || adoptionValidationLoading || adoptionValidation || adoptionValidationError) && (
                          <div className="ec2-adoption-codegen">
                            <div className="ec2-adoption-mapping-head">
                              <div>
                                <h4>Post-Import Validation</h4>
                                <div className="ec2-sidebar-hint">
                                  Run a targeted `terraform plan` against the adopted address and confirm whether the imported EC2 resource is now stable in state.
                                </div>
                              </div>
                              {adoptionValidationLoading && <span className="ec2-adoption-pill config">Validating...</span>}
                              {!adoptionValidationLoading && adoptionValidation && (
                                <span className={`ec2-adoption-pill ${adoptionValidationTone(adoptionValidation.status)}`}>
                                  {adoptionValidationLabel(adoptionValidation.status)}
                                </span>
                              )}
                            </div>
                            <div className="ec2-btn-row">
                              <button
                                className="ec2-action-btn"
                                type="button"
                                disabled={adoptionValidationLoading || !adoptionImportResult?.log.success}
                                onClick={() => void runAdoptionValidation()}
                              >
                                {adoptionValidationLoading ? 'Validating...' : 'Run Post-Import Validation'}
                              </button>
                            </div>
                            {adoptionValidationError && <div className="ec2-sidebar-hint ec2-adoption-error">{adoptionValidationError}</div>}
                            {adoptionValidation && (
                              <>
                                <div className="ec2-adoption-mapping-grid">
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label">Status</span>
                                    <code>{adoptionValidationLabel(adoptionValidation.status)}</code>
                                    <small>{adoptionValidation.summary}</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Address</span>
                                    <code>{adoptionValidation.address}</code>
                                    <small>Targeted plan in {selectedAdoptionProject.currentWorkspace || 'default'} workspace</small>
                                  </div>
                                  <div className="ec2-adoption-row">
                                    <span className="ec2-adoption-label config">Plan</span>
                                    <code>{adoptionValidation.planSummary.hasChanges ? 'changes detected' : 'clean'}</code>
                                    <small>
                                      {adoptionValidation.planSummary.create} create | {adoptionValidation.planSummary.update} update | {adoptionValidation.planSummary.delete} delete | {adoptionValidation.planSummary.replace} replace
                                    </small>
                                  </div>
                                </div>
                                {adoptionValidation.matchingChanges.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {adoptionValidation.matchingChanges.map((change) => (
                                      <div key={`${change.address}:${change.actionLabel}`} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label config">Change</span>
                                        <code>{change.address}</code>
                                        <small>{adoptionPlanActionSymbol(change.actionLabel)} {change.actionLabel} | {change.type} | {change.modulePath === 'root' ? 'root module' : change.modulePath}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className="ec2-adoption-code-preview">
                                  <span className="ec2-adoption-label">Validation Output</span>
                                  <pre className="s3-preview-text">{adoptionValidation.log.output || 'No Terraform output was captured.'}</pre>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                        {adoptionDetection.projects.length === 0 ? (
                          <div className="ec2-adoption-empty">
                            No tracked Terraform project currently claims this instance in state or config.
                          </div>
                        ) : (
                          <div className="ec2-adoption-projects">
                            {adoptionDetection.projects.map((project) => (
                              <article key={project.projectId} className="ec2-adoption-project">
                                <div className="ec2-adoption-project-head">
                                  <strong>{project.projectName}</strong>
                                  <span className={`ec2-adoption-pill ${project.status === 'managed' ? 'managed' : 'config'}`}>
                                    {project.status === 'managed' ? 'State match' : 'Config hint'}
                                  </span>
                                </div>
                                <div className="ec2-adoption-meta">
                                  Workspace {project.currentWorkspace || 'default'} | Region {project.region || '-'} | Backend {project.backendType || '-'}
                                </div>
                                <div className="ec2-adoption-path">{project.rootPath}</div>
                                {project.stateMatches.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {project.stateMatches.map((match) => (
                                      <div key={`${project.projectId}:${match.address}:${match.matchedOn}`} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label">State</span>
                                        <code>{match.address}</code>
                                        <small>matched on {match.matchedOn}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {project.configMatches.length > 0 && (
                                  <div className="ec2-adoption-list">
                                    {project.configMatches.map((match) => (
                                      <div key={`${project.projectId}:${match.relativePath}:${match.lineNumber}:${match.matchedValue}`} className="ec2-adoption-row">
                                        <span className="ec2-adoption-label config">Config</span>
                                        <code>{match.relativePath}:{match.lineNumber}</code>
                                        <small>{match.excerpt}</small>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </article>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {showDescribe && detail && (
                    <div className="ec2-sidebar-section">
                      <div className="ec2-btn-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3 style={{ margin: 0 }}>Describe Output</h3>
                        <button className="ec2-action-btn" type="button" onClick={() => setShowDescribe(false)}>Close</button>
                      </div>
                      <pre className="s3-preview-text">{JSON.stringify({
                        instance: detail,
                        iamAssociation: iamAssoc,
                        vpc: vpcDetail
                      }, null, 2)}</pre>
                    </div>
                  )}

                  {/* Resize (expandable) */}
                  {!isTerminatedInstance && showResize && detail && (
                    <div className="ec2-sidebar-section">
                      <h3>Resize Instance</h3>
                      <div className="ec2-sidebar-hint">Instance must be stopped before resize.</div>
                      <div className="ec2-inline-form">
                        <input placeholder="e.g. t3.medium" value={resizeType} onChange={(e) => setResizeType(e.target.value)} />
                        <button className="ec2-action-btn apply" type="button" onClick={() => void doResize()}>Apply</button>
                        <button className="ec2-action-btn" type="button" onClick={() => void doLoadTypes()}>Suggestions</button>
                      </div>
                      {instanceTypes.length > 0 && (
                        <div className="ec2-type-list">
                          {instanceTypes.slice(0, 20).map((t) => (
                            <div
                              key={t.instanceType}
                              className="ec2-type-option"
                              onClick={() => setResizeType(t.instanceType)}
                            >
                              <span>{t.instanceType}</span>
                              <span className="ec2-type-meta">{t.vcpus}vCPU / {Math.round(t.memoryMiB / 1024 * 10) / 10}GiB / {t.architecture}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {showBastionPanel && (
                    <div className="ec2-sidebar-section">
                      <h3>Create Bastion</h3>
                      <div className="ec2-sidebar-hint">Launch a bastion with the selected instance network defaults.</div>
                      <div className="ec2-bastion-form">
                        <label>AMI
                          <div className="ec2-bastion-ami-picker">
                            <select value={bastionAmi} onChange={(e) => setBastionAmi(e.target.value)}>
                              <option value="">Select popular AMI</option>
                              {popularBastionAmis.map((ami) => (
                                <option key={ami.imageId} value={ami.imageId}>
                                  {ami.platform} - {ami.imageId}
                                </option>
                              ))}
                            </select>
                            <button className="ec2-action-btn" type="button" onClick={() => void loadPopularAmis()} disabled={loadingPopularBastionAmis}>
                              {loadingPopularBastionAmis ? 'Loading...' : 'Refresh'}
                            </button>
                          </div>
                        </label>
                        <label>Type
                          <div className="ec2-bastion-ami-picker">
                            <select value={bastionType} onChange={(e) => setBastionType(e.target.value)}>
                              <option value="">Select t-family type</option>
                              {bastionTypes.map((type) => (
                                <option key={type.instanceType} value={type.instanceType}>
                                  {type.instanceType}
                                </option>
                              ))}
                            </select>
                            <button className="ec2-action-btn" type="button" onClick={() => void loadBastionTypes()} disabled={loadingBastionTypes}>
                              {loadingBastionTypes ? 'Loading...' : 'Refresh'}
                            </button>
                          </div>
                        </label>
                        <label>Subnet
                          <div className="ec2-bastion-ami-picker">
                            <select value={bastionSubnet} onChange={(e) => setBastionSubnet(e.target.value)}>
                              <option value="">Select subnet</option>
                              {bastionSubnets.map((subnet) => (
                                <option key={subnet.subnetId} value={subnet.subnetId}>
                                  {(subnet.name && subnet.name !== '-' ? subnet.name : subnet.subnetId)} ({subnet.availabilityZone})
                                </option>
                              ))}
                            </select>
                            <button className="ec2-action-btn" type="button" onClick={() => void loadBastionNetworkOptions()} disabled={loadingBastionNetworkOptions}>
                              {loadingBastionNetworkOptions ? 'Loading...' : 'Refresh'}
                            </button>
                          </div>
                        </label>
                        <label>Key Pair
                          <select value={bastionKeyPair} onChange={(e) => setBastionKeyPair(e.target.value)}>
                            <option value="">Select key pair</option>
                            {bastionKeyPairs.map((keyPair) => (
                              <option key={keyPair.keyPairId} value={keyPair.keyName}>
                                {keyPair.keyName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>Security Group
                          <select value={bastionSg} onChange={(e) => setBastionSg(e.target.value)}>
                            <option value="">Select security group</option>
                            {bastionSecurityGroups.map((sg) => (
                              <option key={sg.groupId} value={sg.groupId}>
                                {sg.groupName} ({sg.groupId})
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="ec2-btn-row">
                        <button className="ec2-action-btn apply" type="button" onClick={() => void doLaunchBastion()} disabled={!bastionAmi || !bastionSubnet || !bastionKeyPair || bastionLaunchBusy}>
                          {bastionLaunchBusy ? 'Launching...' : 'Launch Bastion'}
                        </button>
                        <button className="ec2-action-btn" type="button" onClick={() => setShowBastionPanel(false)}>Cancel</button>
                      </div>
                      <div className="ec2-bastion-summary">
                        <strong>Existing bastions</strong>
                        <span>{bastions.length}</span>
                      </div>
                      {linkedBastions.length > 0 && (
                        <div className="ec2-sidebar-hint">
                          This EC2 instance has {linkedBastions.length} managed bastion connection{linkedBastions.length === 1 ? '' : 's'}.
                        </div>
                      )}
                    </div>
                  )}

                  {/* IAM Role */}
                  <div className="ec2-sidebar-section">
                    <h3>IAM Role</h3>
                    <div className="ec2-iam-controls">
                      <input
                        className="ec2-iam-input"
                        placeholder={iamProfilePlaceholder(detail, iamAssoc)}
                        value={iamName}
                        onChange={e => setIamName(e.target.value)}
                      />
                      <button
                        className="ec2-action-btn apply"
                        type="button"
                        onClick={() => void (iamAssoc ? doReplaceIam() : doAttachIam())}
                      >Apply</button>
                      <ConfirmButton
                        className="ec2-action-btn remove"
                        type="button"
                        onConfirm={() => void doRemoveIam()}
                      >Remove</ConfirmButton>
                    </div>
                  </div>

                  {/* Connect */}
                  <div className="ec2-sidebar-section">
                    <h3>Connect</h3>
                    <div className="ec2-connect-grid">
                      <div className="ec2-connect-row">
                        <span className="ec2-connect-label">SSM</span>
                        <div className="ec2-connect-status">
                          <span className={`ec2-badge ${ssmStatusTone(ssmTarget?.status ?? detail?.ssmStatus ?? 'not-managed')}`}>
                            {ssmStatusLabel(ssmTarget?.status ?? detail?.ssmStatus ?? 'not-managed')}
                          </span>
                          {detail?.isTempInspectionInstance && <span className="ec2-inline-flag">Temp inspection</span>}
                        </div>
                      </div>
                      <div className="ec2-connect-row">
                        <span className="ec2-connect-label">Preset</span>
                        <div className="ec2-connect-field">
                          <div className="ec2-connect-inline">
                            <select
                              className="ec2-connect-select"
                              value={selectedConnectionPresetId}
                              onChange={(event) => applyConnectionPreset(event.target.value)}
                            >
                              <option value="">Current form values</option>
                              {connectionPresets.map((preset) => (
                                <option key={preset.id} value={preset.id}>
                                  {preset.name}
                                </option>
                              ))}
                            </select>
                            <button className="ec2-action-btn" type="button" onClick={() => void handleSaveConnectionPreset()} disabled={!detail}>
                              {selectedConnectionPresetId ? 'Update' : 'Save'}
                            </button>
                            <button className="ec2-action-btn remove" type="button" onClick={() => void handleDeleteConnectionPreset()} disabled={!selectedConnectionPresetId}>
                              Delete
                            </button>
                          </div>
                          <input
                            value={connectionPresetName}
                            onChange={(event) => setConnectionPresetName(event.target.value)}
                            placeholder="Preset name"
                          />
                          <div className="ec2-connect-note">
                            {selectedConnectionPresetId
                              ? `Preset scope: ${detail?.instanceId ?? '-'}${connectionPresets.find((preset) => preset.id === selectedConnectionPresetId)?.lastUsedAt ? ` | Last used ${formatTimestamp(connectionPresets.find((preset) => preset.id === selectedConnectionPresetId)?.lastUsedAt ?? '')}` : ''}`
                              : `${connectionPresets.length} saved bastion preset${connectionPresets.length === 1 ? '' : 's'} for this instance`}
                          </div>
                        </div>
                      </div>
                      <div className="ec2-connect-row">
                        <span className="ec2-connect-label">Username</span>
                        <input value={sshUser} onChange={e => setSshUser(e.target.value)} />
                      </div>
                      <div className="ec2-connect-row">
                        <span className="ec2-connect-label">PEM key</span>
                        <div className="ec2-connect-field">
                          <div className="ec2-pem-row">
                            <input
                              list="ec2-ssh-vault-options"
                              value={sshKey}
                              onChange={(e) => applySshKeyInput(e.target.value, sshVaultEntryId)}
                              placeholder="vault key name, path, or public key"
                            />
                            <datalist id="ec2-ssh-vault-options">
                              {sshVaultEntries.map((entry) => (
                                <option key={entry.id} value={entry.name}>
                                  {entry.kind === 'pem' ? 'Vault PEM key' : 'Vault SSH key'}
                                </option>
                              ))}
                            </datalist>
                            <button className="ec2-action-btn" type="button" onClick={() => void handleBrowseSshKey()}>Browse</button>
                          </div>
                          {(sshVaultEntriesLoading || sshVaultEntries.length > 0) && (
                            <div className="ec2-ssh-suggestions">
                              {sshVaultEntriesLoading && <span className="ec2-ssh-suggestion-note">Loading vault keys...</span>}
                              {sshVaultEntries.map((entry) => (
                                <button
                                  key={entry.id}
                                  className={`ec2-ssh-suggestion ${sshVaultEntryId === entry.id ? 'active' : ''}`}
                                  type="button"
                                  onClick={() => applySshKeyInput(entry.name, entry.id)}
                                >
                                  <span>{entry.name}</span>
                                  <span className="ec2-ssh-suggestion-note">
                                    {entry.kind === 'pem' ? 'vault PEM key' : 'vault SSH key'}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                          {sshVaultEntryName && <div className="ec2-connect-note">Vault entry: {sshVaultEntryName}</div>}
                          {(sshSuggestionsLoading || sshSuggestions.length > 0) && (
                            <div className="ec2-ssh-suggestions">
                              {sshSuggestionsLoading && <span className="ec2-ssh-suggestion-note">Scanning local SSH keys...</span>}
                              {sshSuggestions.map((suggestion) => (
                                <button
                                  key={suggestion.privateKeyPath}
                                  className={`ec2-ssh-suggestion ${sshKey === suggestion.privateKeyPath ? 'active' : ''}`}
                                  type="button"
                                  onClick={() => applySshKeyInput(suggestion.privateKeyPath)}
                                >
                                  <span>{suggestion.label}</span>
                                  <span className="ec2-ssh-suggestion-note">
                                    {suggestion.hasPublicKey ? 'ready for EC2 Instance Connect' : 'SSH only, no .pub file'}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="ec2-connect-btns">
                        <button
                          className="ec2-action-btn ssm"
                          type="button"
                          disabled={!onRunTerminalCommand || !(ssmTarget?.canStartSession ?? detail?.ssmStatus === 'managed-online') || ssmShellBusy}
                          onClick={() => void doOpenSsmShell()}
                        >SSM Connect</button>
                        <button
                          className="ec2-action-btn ssh"
                          type="button"
                          disabled={!onRunTerminalCommand || !sshKey}
                          onClick={() => void doSshConnect()}
                        >SSH Connect</button>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {sideTab === 'ssm' && (
                <>
                  <div className="ec2-sidebar-section">
                    <div className="ec2-btn-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3 style={{ margin: 0 }}>Systems Manager</h3>
                      <button className="ec2-action-btn" type="button" onClick={() => void loadSsmForInstance(selectedId)} disabled={!selectedId || ssmLoading}>
                        {ssmLoading ? 'Refreshing...' : 'Refresh'}
                      </button>
                    </div>
                    {ssmTarget ? (
                      <>
                        <KV items={[
                          ['Readiness', ssmStatusLabel(ssmTarget.status)],
                          ['Managed ID', ssmTarget.managedInstance?.managedInstanceId ?? '-'],
                          ['Ping', ssmTarget.managedInstance?.pingStatus ?? '-'],
                          ['Last Ping', ssmTarget.managedInstance?.lastPingAt !== '-' ? new Date(ssmTarget.managedInstance?.lastPingAt ?? '-').toLocaleString() : '-'],
                          ['Platform', ssmTarget.managedInstance?.platformName ?? detail?.platform ?? '-'],
                          ['Source', detail?.isTempInspectionInstance ? `Temporary inspection (${detail.tempInspectionSourceVolumeId})` : 'EC2 instance']
                        ]} />
                        <div className="ec2-diagnostics-list">
                          {ssmTarget.diagnostics.map((diagnostic) => (
                            <div key={diagnostic.code} className={`ec2-diagnostic ${diagnostic.severity}`}>
                              <strong>{diagnostic.summary}</strong>
                              <span>{diagnostic.detail}</span>
                            </div>
                          ))}
                        </div>
                        <div className="ec2-btn-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                          <button className="ec2-action-btn ssm" type="button" disabled={!onRunTerminalCommand || !ssmTarget.canStartSession || ssmShellBusy} onClick={() => void doOpenSsmShell()}>
                            {ssmShellBusy ? 'Opening...' : 'Open SSM Shell'}
                          </button>
                          {!detail?.isTempInspectionInstance && ssmTarget.portForwardPresets.map((preset) => (
                            <button key={preset.id} className="ec2-action-btn" type="button" disabled={!onRunTerminalCommand || !ssmTarget.canStartSession || ssmShellBusy} onClick={() => void doOpenPortForward(preset)}>
                              {preset.label}
                            </button>
                          ))}
                        </div>
                        <div className="ec2-sidebar-hint" style={{ marginTop: 8 }}>
                          Port forwarding only works if a process is already listening on the target TCP port inside the instance.
                          {detail?.isTempInspectionInstance
                            ? ' Temporary inspection instances are meant for SSM shell access first; use Open SSM Shell to inspect and mount the attached volume.'
                            : ' It does not start SSH or any other service for you.'}
                        </div>
                        <div className="ec2-ssm-port-form">
                          <label className="ec2-ssm-port-field">
                            <span>Local port</span>
                            <input
                              value={customLocalPort}
                              onChange={(e) => setCustomLocalPort(e.target.value)}
                              placeholder="Local port"
                              inputMode="numeric"
                            />
                          </label>
                          <label className="ec2-ssm-port-field">
                            <span>Destination port</span>
                            <input
                              value={customRemotePort}
                              onChange={(e) => setCustomRemotePort(e.target.value)}
                              placeholder="Destination port"
                              inputMode="numeric"
                            />
                          </label>
                          <button className="ec2-action-btn" type="button" disabled={!onRunTerminalCommand || !ssmTarget.canStartSession || ssmShellBusy} onClick={() => void doOpenCustomPortForward()}>
                            Custom Port
                          </button>
                        </div>

                        <div className="ec2-ssm-command-box">
                          <div className="ec2-ssm-command-toolbar">
                            <select value={ssmCommandDocument} onChange={(e) => setSsmCommandDocument(e.target.value)}>
                              <option value="AWS-RunShellScript">AWS-RunShellScript</option>
                              <option value="AWS-RunPowerShellScript">AWS-RunPowerShellScript</option>
                            </select>
                            <select defaultValue="" onChange={(e) => {
                              if (e.target.value) {
                                applySsmCommandPreset(e.target.value)
                                e.target.value = ''
                              }
                            }}>
                              <option value="">Apply preset</option>
                              {SSM_COMMAND_PRESETS.map((preset) => (
                                <option key={preset.id} value={preset.id}>{preset.label}</option>
                              ))}
                            </select>
                          </div>
                          <textarea
                            className="ec2-ssm-textarea"
                            value={ssmCommandInput}
                            onChange={(e) => setSsmCommandInput(e.target.value)}
                            placeholder="One command per line"
                          />
                          <div className="ec2-btn-row">
                            <button className="ec2-action-btn apply" type="button" disabled={!ssmTarget.canStartSession || ssmCommandBusy} onClick={() => void doRunSsmCommand()}>
                              {ssmCommandBusy ? 'Running...' : 'Run Command'}
                            </button>
                          </div>
                        </div>

                        <div className="ec2-ssm-history">
                          <h4>Session History</h4>
                          {ssmSessions.length ? ssmSessions.slice(0, 6).map((session) => (
                            <div key={session.sessionId} className="ec2-ssm-history-item">
                              <strong>{session.documentName}</strong>
                              <span>{session.status} · {session.startedAt !== '-' ? new Date(session.startedAt).toLocaleString() : '-'}</span>
                            </div>
                          )) : <SvcState variant="empty" resourceName="recent SSM sessions" compact />}
                          <h4>Command History</h4>
                          {ssmHistory.length ? ssmHistory.map((item) => (
                            <div key={item.commandId} className="ec2-ssm-history-item">
                              <strong>{item.commandLabel}</strong>
                              <span>{item.statusDetails} · code {item.responseCode ?? '-'} · {item.requestedAt !== '-' ? new Date(item.requestedAt).toLocaleString() : '-'}</span>
                              {(item.standardOutput || item.standardError) && (
                                <pre className="ec2-ssm-output">{(item.standardOutput || item.standardError).slice(0, 1200)}</pre>
                              )}
                            </div>
                          )) : <SvcState variant="empty" message="No commands run in this view yet." compact />}
                        </div>
                      </>
                    ) : (
                      <SvcState variant="no-selection" resourceName="instance" message="Select an instance to inspect Session Manager state." compact />
                    )}
                  </div>

                  <div className="ec2-sidebar-section">
                    <h3>Managed Fleet</h3>
                    <div className="ec2-sidebar-hint">{ssmOnlineCount} of {ssmManagedInstances.length} managed instances are online.</div>
                    <div className="ec2-managed-list">
                      {ssmManagedInstances.slice(0, 10).map((instance) => (
                        <button
                          key={instance.instanceId}
                          className={instance.instanceId === selectedId ? 'ec2-list-item active' : 'ec2-list-item'}
                          type="button"
                          onClick={() => void selectInstance(instance.instanceId)}
                        >
                          <div className="ec2-list-title">
                            <span className="ec2-list-title-text">{instance.name !== '-' ? instance.name : instance.instanceId}</span>
                            <span className={`ec2-badge ${instance.pingStatus === 'Online' ? 'ssm-online' : 'ssm-offline'}`}>{instance.pingStatus}</span>
                          </div>
                          <div className="ec2-list-meta">{instance.instanceId} · {instance.platformName}</div>
                          {instance.source === 'temp-inspection' && <div className="ec2-list-meta">Temp inspection for {instance.sourceVolumeId}</div>}
                        </button>
                      ))}
                      {!ssmManagedInstances.length && <SvcState variant="empty" resourceName="managed instances" message="No managed instances in this region." compact />}
                    </div>
                  </div>
                </>
              )}

              {sideTab === 'timeline' && (
                <div className="ec2-sidebar-section">
                  <div className="ec2-timeline-controls">
                    <label>
                      From
                      <input type="date" value={timelineStart} onChange={e => setTimelineStart(e.target.value)} />
                    </label>
                    <label>
                      To
                      <input type="date" value={timelineEnd} onChange={e => setTimelineEnd(e.target.value)} />
                    </label>
                  </div>
                  {!selectedId && <SvcState variant="no-selection" resourceName="instance" message="Select an instance to view events." compact />}
                  {selectedId && timelineLoading && <SvcState variant="loading" resourceName="events" compact />}
          {selectedId && !timelineLoading && timelineError && (
            <SvcState variant={variantForError(timelineError)} error={timelineError} compact />
          )}
                  {selectedId && !timelineLoading && !timelineError && timelineEvents.length === 0 && (
                    <SvcState variant="empty" resourceName="CloudTrail events" compact />
                  )}
                  {selectedId && !timelineLoading && timelineEvents.length > 0 && (
                    <div className="ec2-timeline-table-wrap">
                      <table className="ec2-timeline-table">
                        <thead>
                          <tr>
                            <th>Event</th>
                            <th>User</th>
                            <th>Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {timelineEvents.map(ev => (
                            <tr key={ev.eventId}>
                              <td title={ev.eventSource}>{ev.eventName}</td>
                              <td>{ev.username}</td>
                              <td>{ev.eventTime !== '-' ? new Date(ev.eventTime).toLocaleString() : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {mainTab === 'volumes' && (
        <div className="ec2-split">
          <div className="ec2-panel ec2-list-panel">
            <h3>Volumes ({volumes.length})</h3>
            <input
              className="ec2-search-input"
              placeholder="Filter volumes..."
              value={volumeFilter}
              onChange={(e) => setVolumeFilter(e.target.value)}
            />
            <div className="ec2-list">
              {filteredVolumes.map((volume) => {
                const highPriority = volume.status === 'available-orphan' && !volume.encrypted
                return (
                  <button
                    key={volume.volumeId}
                    className={`${volume.volumeId === selectedVolumeId ? 'ec2-list-item active' : 'ec2-list-item'} ${volume.status === 'available-orphan' ? 'ec2-list-item-orphan' : ''}`}
                    type="button"
                    onClick={() => void selectVolume(volume.volumeId)}
                  >
                    <div className="ec2-list-title">
                      <span className="ec2-list-title-text">{volume.name !== '-' ? volume.name : volume.volumeId}</span>
                      {highPriority && <span className="ec2-high-priority">High priority</span>}
                    </div>
                    <div className="ec2-list-meta">{volume.volumeId} | {volume.sizeGiB} GiB | {volume.type}</div>
                    <div className="ec2-list-meta">
                      <span className={`ec2-badge ${volume.state}`}>{volume.state}</span> | {volume.status}
                    </div>
                  </button>
                )
              })}
              {!filteredVolumes.length && <SvcState variant="no-filter-matches" resourceName="volumes" compact />}
            </div>
          </div>

          <div className="ec2-detail-stack">
            <div className="ec2-panel">
              <h3>Volume Details</h3>
              {volumeDetail ? (
                <>
                  <div className="ec2-relationship-strip">
                    <div className="ec2-relationship-card">
                      <span className="ec2-relationship-label">Volume</span>
                      <strong>{volumeDetail.name !== '-' ? volumeDetail.name : volumeDetail.volumeId}</strong>
                      <span>{volumeDetail.volumeId}</span>
                    </div>
                    <div className="ec2-relationship-arrow">→</div>
                    <div className="ec2-relationship-card">
                      <span className="ec2-relationship-label">Source Snapshot</span>
                      <strong>{selectedVolumeSnapshot?.tags.Name || volumeDetail.snapshotId}</strong>
                      <span>{selectedVolumeSnapshot ? formatTimestamp(selectedVolumeSnapshot.startTime) : 'No source snapshot recorded'}</span>
                    </div>
                    <div className="ec2-relationship-arrow">→</div>
                    <div className="ec2-relationship-card">
                      <span className="ec2-relationship-label">Attached Instance</span>
                      <strong>{selectedVolumeAttachedInstance?.name || selectedVolumePrimaryAttachment?.instanceId || 'Not attached'}</strong>
                      <span>{selectedVolumePrimaryAttachment ? `${selectedVolumePrimaryAttachment.device} | ${selectedVolumePrimaryAttachment.state}` : 'Volume is currently unattached'}</span>
                    </div>
                    <div className="ec2-relationship-arrow">→</div>
                    <div className="ec2-relationship-card">
                      <span className="ec2-relationship-label">Inspection Environment</span>
                      <strong>{volumeDetail.tempEnvironment?.instanceId || 'Not created'}</strong>
                      <span>{volumeDetail.tempEnvironment ? ssmStatusLabel(selectedVolumeTempSsmStatus) : 'Create a temporary SSM-managed host when needed'}</span>
                    </div>
                  </div>

                  <KV items={[
                    ['Volume ID', volumeDetail.volumeId],
                    ['Name', volumeDetail.name],
                    ['State', volumeDetail.state],
                    ['Normalized Status', volumeDetail.status],
                    ['Settings', formatVolumeSettings(volumeDetail)],
                    ['Encrypted', volumeDetail.encrypted ? 'Yes' : 'No'],
                    ['AZ', volumeDetail.availabilityZone],
                    ['Created', formatTimestamp(volumeDetail.createTime)],
                    ['Snapshot', volumeDetail.snapshotId],
                    ['Attachments', volumeDetail.attachments.length ? volumeDetail.attachments.map((attachment) => `${attachment.instanceId} ${attachment.device}`).join(', ') : 'None'],
                    ['Temp SSM', volumeDetail.tempEnvironment ? ssmStatusLabel(selectedVolumeTempSsmStatus) : 'No temp environment']
                  ]} />

                  <div className="ec2-btn-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                    {volumeDetail.status === 'available-orphan' && (
                      <button className="ec2-action-btn ssm" type="button" onClick={() => void doCheckVolume()}>
                        Check Volume
                      </button>
                    )}
                    {volumeDetail.tempEnvironment && (
                      <button
                        className="ec2-action-btn ssm"
                        type="button"
                        disabled={!onRunTerminalCommand || !(volumeTempSsmTarget?.canStartSession ?? volumeDetail.tempEnvironment.ssmReady)}
                        onClick={() => void doOpenSsmShell(volumeDetail.tempEnvironment?.instanceId)}
                      >
                        Open SSM Session
                      </button>
                    )}
                    {volumeDetail.tempEnvironment && (
                      <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doDeleteTempInspection(volumeDetail.tempEnvironment?.tempUuid || volumeDetail.tempEnvironment?.instanceId || '', volumeDetail.volumeId)}>
                        Delete Temp Instance
                      </ConfirmButton>
                    )}
                    <button className="ec2-action-btn" type="button" onClick={() => {
                      setSnapVolume(volumeDetail.volumeId)
                      setMainTab('snapshots')
                    }}>Create Snapshot</button>
                    {selectedVolumeSnapshot && (
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        setMainTab('snapshots')
                        setSelectedSnapId(selectedVolumeSnapshot.snapshotId)
                      }}>
                        Open Source Snapshot
                      </button>
                    )}
                    {volumeDetail.attachedInstanceIds[0] && (
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        setMainTab('instances')
                        void selectInstance(volumeDetail.attachedInstanceIds[0])
                      }}>Open Related Instance</button>
                    )}
                    {volumeDetail.tempEnvironment?.instanceId && (
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        setMainTab('instances')
                        void selectInstance(volumeDetail.tempEnvironment?.instanceId ?? '')
                      }}>
                        Open Temp Instance
                      </button>
                    )}
                  </div>
                </>
              ) : <SvcState variant="no-selection" resourceName="volume" compact />}
            </div>

            {volumeDetail && (
              <div className="ec2-panel">
                <h3>Operational Actions</h3>
                <div className="ec2-volume-ops-grid">
                  <div className="ec2-volume-op-card">
                    <h4>Attach</h4>
                    <div className="ec2-form">
                      <label>Instance ID<input value={volumeAttachInstanceId} onChange={(e) => setVolumeAttachInstanceId(e.target.value)} placeholder="i-..." /></label>
                      <label>Device<input value={volumeAttachDevice} onChange={(e) => setVolumeAttachDevice(e.target.value)} placeholder="/dev/sdf" /></label>
                    </div>
                    <button className="ec2-action-btn apply" type="button" disabled={volumeDetail.status === 'multi-attach'} onClick={() => void doAttachVolume()}>
                      Attach Volume
                    </button>
                  </div>
                  <div className="ec2-volume-op-card">
                    <h4>Modify</h4>
                    <div className="ec2-form">
                      <label>Size (GiB)<input value={volumeModifySize} onChange={(e) => setVolumeModifySize(e.target.value)} inputMode="numeric" /></label>
                      <label>Type<input value={volumeModifyType} onChange={(e) => setVolumeModifyType(e.target.value)} placeholder="gp3" /></label>
                      <label>IOPS<input value={volumeModifyIops} onChange={(e) => setVolumeModifyIops(e.target.value)} inputMode="numeric" placeholder="Optional" /></label>
                      <label>Throughput<input value={volumeModifyThroughput} onChange={(e) => setVolumeModifyThroughput(e.target.value)} inputMode="numeric" placeholder="Optional" /></label>
                    </div>
                    <div className="ec2-btn-row">
                      <button className="ec2-action-btn apply" type="button" onClick={() => void doModifyVolume()}>
                        Apply Changes
                      </button>
                      {volumeDetail.type === 'gp2' && (
                        <button className="ec2-action-btn" type="button" onClick={() => {
                          setVolumeModifyType('gp3')
                          if (!volumeModifyIops) setVolumeModifyIops('3000')
                          if (!volumeModifyThroughput) setVolumeModifyThroughput('125')
                        }}>
                          Prefill gp3
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="ec2-volume-op-card">
                    <h4>Delete</h4>
                    <div className="ec2-sidebar-hint">
                      Deletion is destructive. AWS must see the volume detached before delete can succeed.
                    </div>
                    <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doDeleteVolume()}>
                      Delete Volume
                    </ConfirmButton>
                  </div>
                </div>
              </div>
            )}

            {volumeDetail && (
              <div className="ec2-panel">
                <h3>Attachments</h3>
                {volumeDetail.attachments.length ? (
                  <div className="ec2-table">
                    <div className="ec2-thead"><div>Instance</div><div>Device</div><div>State</div><div>Attached</div></div>
                    {volumeDetail.attachments.map((attachment) => (
                      <div key={`${attachment.instanceId}-${attachment.device}`} className="ec2-trow">
                        <div>
                          <button className="ec2-link-btn" type="button" onClick={() => {
                            setMainTab('instances')
                            void selectInstance(attachment.instanceId)
                          }}>
                            {attachment.instanceId}
                          </button>
                        </div>
                        <div>{attachment.device}</div>
                        <div>{attachment.state}</div>
                        <div>
                          <div>{formatTimestamp(attachment.attachTime)}</div>
                          <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doDetachVolume(attachment)}>
                            Detach
                          </ConfirmButton>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <SvcState variant="empty" resourceName="active attachments" compact />
                )}
              </div>
            )}

            {volumeDetail && (
              <div className="ec2-panel">
                <h3>Recommendations</h3>
                {volumeWarnings.length ? volumeWarnings.map((warning) => (
                  <div key={warning} className="ec2-volume-warning">
                    <div>{warning}</div>
                    <div className="ec2-btn-row" style={{ marginTop: 8 }}>
                      {warning.includes('gp2') && (
                        <button className="ec2-action-btn" type="button" onClick={() => {
                          setVolumeModifyType('gp3')
                          if (!volumeModifyIops) setVolumeModifyIops('3000')
                          if (!volumeModifyThroughput) setVolumeModifyThroughput('125')
                        }}>
                          Prefill gp3 Modify
                        </button>
                      )}
                      {warning.includes('orphan') && (
                        <button className="ec2-action-btn ssm" type="button" onClick={() => void doCheckVolume()}>
                          Inspect Orphan
                        </button>
                      )}
                      {warning.includes('governance tags') && (
                        <button className="ec2-action-btn" type="button" onClick={() => {
                          if (configuredGovernanceTagCount > 0) {
                            void doApplyGovernanceTagsToVolume()
                            return
                          }
                          setVolumeTagKey('Owner')
                          setVolumeTagValue('')
                        }}>
                          {configuredGovernanceTagCount > 0 ? 'Apply Defaults' : 'Add Tags'}
                        </button>
                      )}
                    </div>
                  </div>
                )) : <SvcState variant="empty" resourceName="immediate recommendations" compact />}
              </div>
            )}

            {volumeDetail && (
              <div className="ec2-panel">
                <h3>Tags</h3>
                {Object.keys(volumeDetail.tags).length ? (
                  <div className="ec2-table">
                    <div className="ec2-thead"><div>Key</div><div>Value</div><div /><div /></div>
                    {Object.entries(volumeDetail.tags).map(([key, value]) => (
                      <div key={key} className="ec2-trow">
                        <div>{key}</div>
                        <div>{value}</div>
                        <div />
                        <div>
                          {!key.startsWith('aws-lens:') && (
                            <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doUntagVolume(key)}>
                              Remove
                            </ConfirmButton>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <SvcState variant="empty" resourceName="tags" compact />
                )}
                <div className="ec2-inline" style={{ marginTop: 10 }}>
                  <input placeholder="Tag key" value={volumeTagKey} onChange={(e) => setVolumeTagKey(e.target.value)} style={{ width: 140 }} />
                  <input placeholder="Tag value" value={volumeTagValue} onChange={(e) => setVolumeTagValue(e.target.value)} style={{ width: 220 }} />
                  <button className="ec2-action-btn" type="button" onClick={() => void doApplyGovernanceTagsToVolume()} disabled={configuredGovernanceTagCount === 0}>
                    Apply Defaults
                  </button>
                  <button className="ec2-action-btn apply" type="button" onClick={() => void doTagVolume()}>
                    Tag Volume
                  </button>
                </div>
              </div>
            )}

            {volumeDetail?.tempEnvironment && (
              <div className="ec2-panel">
                <h3>Temporary Environment</h3>
                <KV items={[
                  ['Temp UUID', volumeDetail.tempEnvironment.tempUuid],
                  ['Instance', volumeDetail.tempEnvironment.instanceId],
                  ['State', volumeDetail.tempEnvironment.instanceState],
                  ['SSM', ssmStatusLabel(selectedVolumeTempSsmStatus)],
                  ['Last Ping', formatTimestamp(volumeTempSsmTarget?.managedInstance?.lastPingAt ?? '-')],
                  ['Subnet', volumeDetail.tempEnvironment.subnetId],
                  ['Security Group', volumeDetail.tempEnvironment.securityGroupId],
                  ['Instance Profile', volumeDetail.tempEnvironment.instanceProfileName],
                  ['Role', volumeDetail.tempEnvironment.iamRoleName]
                ]} />
                {volumeTempSsmTarget?.diagnostics?.length ? (
                  <div className="ec2-ssm-summary-issues" style={{ marginTop: 10 }}>
                    {volumeTempSsmTarget.diagnostics.map((diagnostic) => (
                      <div key={diagnostic.code} className={`ec2-ssm-diag ${diagnostic.severity}`}>
                        <strong>{diagnostic.summary}</strong>
                        <span>{diagnostic.detail}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="ec2-btn-row" style={{ marginTop: 10 }}>
                  <button
                    className="ec2-action-btn ssm"
                    type="button"
                    disabled={!onRunTerminalCommand || !(volumeTempSsmTarget?.canStartSession ?? volumeDetail.tempEnvironment.ssmReady)}
                    onClick={() => void doOpenSsmShell(volumeDetail.tempEnvironment?.instanceId)}
                  >
                    Open SSM Session
                  </button>
                  <button className="ec2-action-btn" type="button" onClick={() => {
                    setMainTab('instances')
                    void selectInstance(volumeDetail.tempEnvironment?.instanceId ?? '')
                  }}>
                    Open Temp Instance
                  </button>
                  <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doDeleteTempInspection(volumeDetail.tempEnvironment?.tempUuid || volumeDetail.tempEnvironment?.instanceId || '', volumeDetail.volumeId)}>
                    Cleanup Temp Environment
                  </ConfirmButton>
                </div>
                {volumeWorkflowStatus?.mode === 'delete' && volumeWorkflowStatus.tempUuid === volumeDetail.tempEnvironment.tempUuid && (
                  <div className="ec2-sidebar-hint" style={{ marginTop: 10 }}>
                    Cleanup in progress: {volumeWorkflowStatus.message}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════ SNAPSHOTS ══════════════════ */}
      {mainTab === 'snapshots' && (
        <div className="ec2-split">
          <div className="ec2-panel ec2-list-panel">
            <h3>Snapshots ({snapshots.length})</h3>
            <div className="ec2-list">
              {snapshots.map((s) => (
                <button
                  key={s.snapshotId}
                  className={s.snapshotId === selectedSnapId ? 'ec2-list-item active' : 'ec2-list-item'}
                  type="button"
                  onClick={() => setSelectedSnapId(s.snapshotId)}
                >
                  <div className="ec2-list-title">{s.tags.Name || s.snapshotId}</div>
                  <div className="ec2-list-meta">{s.volumeId} | {s.volumeSize} GiB</div>
                  <div className="ec2-list-meta"><span className={`ec2-badge ${s.state}`}>{s.state}</span> | {s.progress}</div>
                </button>
              ))}
              {!snapshots.length && <SvcState variant="empty" resourceName="snapshots" compact />}
            </div>
          </div>
          <div className="ec2-detail-stack">
            {/* Snapshot detail */}
            <div className="ec2-panel">
              <h3>Snapshot Details</h3>
              {selectedSnap ? (
                <>
                  <KV items={[
                    ['Snapshot ID', selectedSnap.snapshotId], ['Volume', selectedSnap.volumeId],
                    ['State', selectedSnap.state], ['Progress', selectedSnap.progress],
                    ['Size', `${selectedSnap.volumeSize} GiB`],
                    ['Started', formatTimestamp(selectedSnap.startTime)],
                    ['Encrypted', selectedSnap.encrypted ? 'Yes' : 'No'],
                    ['Description', selectedSnap.description || '-'], ['Owner', selectedSnap.ownerId]
                  ]} />
                  <div className="ec2-btn-row" style={{ marginTop: 10 }}>
                    <button className="ec2-action-btn" type="button" onClick={() => openVolumeFromSnapshot(selectedSnap.volumeId)}>
                      Open Source Volume
                    </button>
                    <ConfirmButton type="button" className="danger" onConfirm={() => void doDeleteSnap()} confirmLabel="Confirm Delete?">Delete Snapshot</ConfirmButton>
                  </div>
                </>
              ) : <SvcState variant="no-selection" resourceName="snapshot" compact />}
            </div>

            {/* Tag */}
            {selectedSnap && (
              <div className="ec2-panel">
                <h3>Tags</h3>
                {Object.keys(selectedSnap.tags).length > 0 && (
                  <div className="ec2-table" style={{ marginBottom: 8 }}>
                    <div className="ec2-thead"><div>Key</div><div>Value</div><div /><div /></div>
                    {Object.entries(selectedSnap.tags).map(([k, v]) => (
                      <div key={k} className="ec2-trow"><div>{k}</div><div>{v}</div><div /><div /></div>
                    ))}
                  </div>
                )}
                <div className="ec2-inline">
                  <input placeholder="Key" value={tagKey} onChange={(e) => setTagKey(e.target.value)} style={{ width: 120 }} />
                  <input placeholder="Value" value={tagValue} onChange={(e) => setTagValue(e.target.value)} style={{ width: 180 }} />
                  <button type="button" onClick={() => void doApplyGovernanceTagsToSnapshot()} disabled={configuredGovernanceTagCount === 0}>Apply Defaults</button>
                  <button type="button" onClick={() => void doTagSnap()}>Add Tag</button>
                </div>
              </div>
            )}

            {/* Create snapshot */}
            <div className="ec2-panel">
              <h3>Create Snapshot</h3>
              <div className="ec2-form">
                <label>Volume ID<input value={snapVolume} onChange={(e) => setSnapVolume(e.target.value)} placeholder="vol-..." /></label>
                <label>Description<input value={snapDesc} onChange={(e) => setSnapDesc(e.target.value)} placeholder="Snapshot description" /></label>
              </div>
              <div className="ec2-sidebar-hint" style={{ marginBottom: 10 }}>
                {governanceDefaults === null
                  ? 'Governance tag defaults are unavailable until the settings store loads.'
                  : governanceDefaults.inheritByDefault
                  ? configuredGovernanceTagCount > 0
                    ? `This snapshot will inherit ${configuredGovernanceTagCount} saved governance tag defaults.`
                    : 'Governance tag inheritance is enabled, but no default values are configured yet.'
                  : 'Governance tag inheritance is currently disabled in Settings.'}
              </div>
              <button type="button" onClick={() => void doCreateSnap()}>Create Snapshot</button>
            </div>

            {/* Launch from snapshot */}
            {selectedSnap && (
              <div className="ec2-panel">
                <h3>Launch from Snapshot</h3>
                <div className="ec2-form">
                  <label>AMI Name<input value={snapLaunchName} onChange={(e) => setSnapLaunchName(e.target.value)} placeholder="my-image" /></label>
                  <label>Type<input value={snapLaunchType} onChange={(e) => setSnapLaunchType(e.target.value)} /></label>
                  <label>Architecture
                    <select value={snapLaunchArch} onChange={(e) => setSnapLaunchArch(e.target.value)}>
                      <option value="x86_64">x86_64</option><option value="arm64">arm64</option>
                    </select>
                  </label>
                  <label>Subnet<input value={snapLaunchSubnet} onChange={(e) => setSnapLaunchSubnet(e.target.value)} placeholder="subnet-..." /></label>
                  <label>Key Pair<input value={snapLaunchKey} onChange={(e) => setSnapLaunchKey(e.target.value)} /></label>
                  <label>Security Group<input value={snapLaunchSg} onChange={(e) => setSnapLaunchSg(e.target.value)} placeholder="sg-..." /></label>
                </div>
                <button type="button" onClick={() => void doLaunchFromSnap()}>Launch Instance</button>
              </div>
            )}
          </div>
        </div>
      )}

      {showProjectPicker && detail && (
        <TerraformProjectPickerDialog
          connection={connection}
          instance={detail}
          projects={projectPickerProjects}
          loading={projectPickerLoading}
          error={projectPickerError}
          selectedProjectId={selectedProjectCandidateId}
          onSelectProject={setSelectedProjectCandidateId}
          onConfirm={handleConfirmProjectSelection}
          onClose={() => setShowProjectPicker(false)}
        />
      )}

      {bastionLaunchStatus && (
        <div className="ec2-status-overlay" role="dialog" aria-modal="true" aria-labelledby="bastion-status-title">
          <div className="ec2-status-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="ec2-status-header">
              <div>
                <div className="ec2-status-eyebrow">Bastion Workflow</div>
                <h3 id="bastion-status-title">{bastionLaunchStatus.mode === 'create' ? 'Create Bastion' : 'Destroy Bastion'}</h3>
              </div>
              <span className={`ec2-badge ${bastionLaunchStatus.stage === 'completed' ? 'completed' : bastionLaunchStatus.stage === 'failed' ? 'stopped' : 'pending'}`}>
                {bastionLaunchStatus.stage === 'completed'
                  ? 'Completed'
                  : bastionLaunchStatus.stage === 'failed'
                    ? 'Failed'
                    : 'In progress'}
              </span>
            </div>

            <div className="ec2-status-copy">
              {bastionLaunchStatus.stage === 'completed' && (
                bastionLaunchStatus.mode === 'create'
                  ? `Bastion ${bastionLaunchStatus.bastionId ?? ''} is ready for ${bastionLaunchStatus.targetInstanceId}.`
                  : `Bastion access for ${bastionLaunchStatus.targetInstanceId} has been removed.`
              )}
              {bastionLaunchStatus.stage === 'failed' && (
                bastionLaunchStatus.error ?? (bastionLaunchStatus.mode === 'create' ? 'Bastion creation failed.' : 'Bastion deletion failed.')
              )}
              {bastionLaunchStatus.stage !== 'completed' && bastionLaunchStatus.stage !== 'failed' && (
                bastionLaunchStatus.mode === 'create'
                  ? `Launching managed bastion access for ${bastionLaunchStatus.targetInstanceId}.`
                  : `Removing managed bastion access for ${bastionLaunchStatus.targetInstanceId}.`
              )}
            </div>

            <div className="ec2-status-steps">
              {([
                ['preparing', 'Preparing request'],
                ['executing', bastionLaunchStatus.mode === 'create' ? 'Launching bastion' : 'Deleting bastion'],
                ['refreshing', 'Refreshing EC2 view']
              ] as const).map(([stepKey, stepLabel]) => {
                const state = bastionStepState(bastionLaunchStatus.stage, stepKey)
                return (
                  <div key={stepKey} className={`ec2-status-step ${state}`}>
                    <span className="ec2-status-step-dot" />
                    <span>{stepLabel}</span>
                  </div>
                )
              })}
            </div>

            <div className="ec2-status-grid">
              <div><span>Target</span><strong>{bastionLaunchStatus.targetName !== '-' ? `${bastionLaunchStatus.targetName} (${bastionLaunchStatus.targetInstanceId})` : bastionLaunchStatus.targetInstanceId}</strong></div>
              <div><span>AMI</span><strong>{bastionLaunchStatus.imageId}</strong></div>
              <div><span>Type</span><strong>{bastionLaunchStatus.instanceType}</strong></div>
              <div><span>Subnet</span><strong>{bastionLaunchStatus.subnetId}</strong></div>
              <div><span>Key Pair</span><strong>{bastionLaunchStatus.keyName}</strong></div>
              <div><span>Security Group</span><strong>{bastionLaunchStatus.securityGroupId || 'Auto/default'}</strong></div>
              {bastionLaunchStatus.bastionId && <div><span>Bastion ID</span><strong>{bastionLaunchStatus.bastionId}</strong></div>}
            </div>

            <div className="ec2-status-actions">
              {bastionLaunchStatus.stage === 'failed' && (
                <button className="ec2-action-btn apply" type="button" onClick={() => void (bastionLaunchStatus.mode === 'create' ? doLaunchBastion() : doDeleteBastion())}>
                  {bastionLaunchStatus.mode === 'create' ? 'Retry Launch' : 'Retry Delete'}
                </button>
              )}
              <button className="ec2-action-btn" type="button" onClick={() => setBastionLaunchStatus(null)} disabled={bastionLaunchBusy}>
                {bastionLaunchBusy ? 'Running...' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {volumeWorkflowStatus && (
        <div className="ec2-status-overlay" role="dialog" aria-modal="true" aria-labelledby="volume-status-title">
          <div className="ec2-status-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="ec2-status-header">
              <div>
                <div className="ec2-status-eyebrow">Volume Check Workflow</div>
                <h3 id="volume-status-title">{volumeWorkflowStatus.mode === 'create' ? 'Check Volume' : 'Delete Temp Instance'}</h3>
              </div>
              <span className={`ec2-badge ${volumeWorkflowStatus.stage === 'completed' ? 'completed' : volumeWorkflowStatus.stage === 'failed' ? 'stopped' : 'pending'}`}>
                {volumeWorkflowStatus.stage === 'completed' ? 'Completed' : volumeWorkflowStatus.stage === 'failed' ? 'Failed' : 'In progress'}
              </span>
            </div>

            <div className="ec2-status-copy">
              {volumeWorkflowStatus.error ?? volumeWorkflowStatus.message}
            </div>

            <div className="ec2-status-steps">
              {((volumeWorkflowStatus.mode === 'create'
                ? [
                    ['preparing', 'Preparing'],
                    ['creating-iam-profile-if-needed', 'Creating IAM/profile'],
                    ['creating-instance', 'Creating instance'],
                    ['waiting-for-instance-readiness', 'Waiting for instance readiness'],
                    ['verifying-ssm-readiness', 'Verifying SSM readiness'],
                    ['attaching-target-volume', 'Attaching target volume'],
                    ['finalizing', 'Finalizing']
                  ]
                : [
                    ['preparing', 'Preparing'],
                    ['detaching-inspected-volume-if-needed', 'Detaching inspected volume'],
                    ['terminating-instance', 'Terminating instance'],
                    ['waiting-for-termination', 'Waiting for termination'],
                    ['deleting-temp-resources', 'Deleting temp resources'],
                    ['finalizing', 'Finalizing']
                  ]) as Array<[EbsTempInspectionProgress['stage'], string]>).map(([stepKey, stepLabel]) => {
                const state = volumeStepState(volumeWorkflowStatus.stage, volumeWorkflowStatus.mode, stepKey)
                return (
                  <div key={stepKey} className={`ec2-status-step ${state}`}>
                    <span className="ec2-status-step-dot" />
                    <span>{stepLabel}</span>
                  </div>
                )
              })}
            </div>

            <div className="ec2-status-grid">
              <div><span>Volume</span><strong>{volumeWorkflowStatus.volumeName !== '-' ? `${volumeWorkflowStatus.volumeName} (${volumeWorkflowStatus.volumeId})` : volumeWorkflowStatus.volumeId}</strong></div>
              {volumeWorkflowStatus.tempUuid && <div><span>Temp UUID</span><strong>{volumeWorkflowStatus.tempUuid}</strong></div>}
              {volumeWorkflowStatus.instanceId && <div><span>Instance</span><strong>{volumeWorkflowStatus.instanceId}</strong></div>}
            </div>

            <div className="ec2-status-actions">
              {volumeWorkflowStatus.stage === 'failed' && volumeWorkflowStatus.mode === 'create' && (
                <button className="ec2-action-btn apply" type="button" onClick={() => void doCheckVolume()}>
                  Retry Check
                </button>
              )}
              <button className="ec2-action-btn" type="button" onClick={() => setVolumeWorkflowStatus(null)} disabled={volumeWorkflowBusy}>
                {volumeWorkflowBusy ? 'Running...' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
