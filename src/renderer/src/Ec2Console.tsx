import { useEffect, useState } from 'react'
import './ec2.css'

import type {
  AwsConnection,
  BastionAmiOption,
  BastionConnectionInfo,
  CloudTrailEventSummary,
  Ec2IamAssociation,
  Ec2InstanceAction,
  Ec2InstanceDetail,
  Ec2InstanceSummary,
  Ec2InstanceTypeOption,
  Ec2Recommendation,
  Ec2SnapshotSummary,
  Ec2VpcDetail,
  EbsTempInspectionEnvironment,
  EbsTempInspectionProgress,
  EbsVolumeDetail,
  EbsVolumeSummary,
  KeyPairSummary,
  SecurityGroupSummary,
  SubnetSummary
} from '@shared/types'
import { listKeyPairs, listSecurityGroupsForVpc, listSubnets, lookupCloudTrailEventsByResource } from './api'
import {
  attachIamProfile,
  chooseEc2SshKey,
  createEc2Snapshot,
  createTempVolumeCheck,
  deleteBastion,
  deleteEc2Snapshot,
  deleteTempVolumeCheck,
  describeEbsVolume,
  describeEc2Instance,
  describeVpc,
  findBastionConnectionsForInstance,
  getEc2Recommendations,
  getIamAssociation,
  launchBastion,
  launchFromSnapshot,
  listBastions,
  listEbsVolumes,
  listEc2Instances,
  listEc2Snapshots,
  listInstanceTypes,
  listPopularBastionAmis,
  removeIamProfile,
  replaceIamProfile,
  resizeEc2Instance,
  runEc2InstanceAction,
  sendSshPublicKey,
  subscribeToTempVolumeProgress,
  tagEc2Snapshot,
  terminateEc2Instance
} from './ec2Api'
import { ConfirmButton } from './ConfirmButton'

type MainTab = 'instances' | 'volumes' | 'snapshots'
type SideTab = 'overview' | 'timeline'
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

const BASTION_PURPOSE_TAG = 'aws-lens:purpose'
const BASTION_TARGET_INSTANCE_TAG = 'aws-lens:bastion-target-instance-id'
const GOVERNANCE_TAG_KEYS = ['Owner', 'Environment', 'CostCenter']

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

export function Ec2Console({
  connection,
  onNavigateCloudWatch,
  onNavigateVpc,
  onRunTerminalCommand
}: {
  connection: AwsConnection
  onNavigateCloudWatch?: (instanceId: string) => void
  onNavigateVpc?: (vpcId: string) => void
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
  const [detail, setDetail] = useState<Ec2InstanceDetail | null>(null)
  const [iamAssoc, setIamAssoc] = useState<Ec2IamAssociation | null>(null)
  const [vpcDetail, setVpcDetail] = useState<Ec2VpcDetail | null>(null)
  const [instanceTypes, setInstanceTypes] = useState<Ec2InstanceTypeOption[]>([])
  const [resizeType, setResizeType] = useState('')
  const [showResize, setShowResize] = useState(false)
  const [iamName, setIamName] = useState('')
  const [sshUser, setSshUser] = useState('ec2-user')
  const [sshKey, setSshKey] = useState('')
  const [showDescribe, setShowDescribe] = useState(false)

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

  /* ── Timeline state ────────────────────────────────────── */
  const [timelineEvents, setTimelineEvents] = useState<CloudTrailEventSummary[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [timelineStart, setTimelineStart] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10)
  })
  const [timelineEnd, setTimelineEnd] = useState(() => new Date().toISOString().slice(0, 10))

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

  useEffect(() => {
    if (sideTab === 'timeline' && selectedId) void loadTimeline(selectedId)
  }, [sideTab, selectedId, timelineStart, timelineEnd])

  /* ── Recommendations state ──────────────────────────────── */
  const [recommendations, setRecommendations] = useState<Ec2Recommendation[]>([])
  const [recsLoading, setRecsLoading] = useState(false)

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
  async function reload() {
    setLoading(true)
    setMsg('')
    try {
      const [inst, vols, snaps, bast] = await Promise.all([
        listEc2Instances(connection),
        listEbsVolumes(connection),
        listEc2Snapshots(connection),
        listBastions(connection)
      ])
      setInstances(inst)
      setVolumes(vols)
      setSnapshots(snaps)
      setBastions(bast)
      if (!selectedId || !inst.some((i) => i.instanceId === selectedId)) {
        const first = inst[0]?.instanceId ?? ''
        setSelectedId(first)
        if (first) await selectInstance(first)
        else { setDetail(null); setIamAssoc(null); setVpcDetail(null) }
      }
      if (!selectedSnapId || !snaps.some((s) => s.snapshotId === selectedSnapId)) {
        setSelectedSnapId(snaps[0]?.snapshotId ?? '')
      }
      if (!selectedVolumeId || !vols.some((v) => v.volumeId === selectedVolumeId)) {
        const firstVolumeId = vols[0]?.volumeId ?? ''
        setSelectedVolumeId(firstVolumeId)
        if (firstVolumeId) {
          await selectVolume(firstVolumeId)
        } else {
          setVolumeDetail(null)
        }
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

useEffect(() => { void reload(); void loadRecommendations() }, [connection.sessionId, connection.region])

  useEffect(() => subscribeToTempVolumeProgress((progress) => {
    setVolumeWorkflowStatus((current) => ({
      mode: progress.mode,
      volumeId: progress.volumeId,
      volumeName: current?.volumeId === progress.volumeId ? current.volumeName : volumeDetail?.name ?? progress.volumeId,
      tempUuid: progress.tempUuid,
      instanceId: progress.instanceId,
      stage: progress.stage,
      message: progress.message,
      error: progress.error
    }))
  }), [volumeDetail?.name])

  async function selectInstance(id: string) {
    setSelectedId(id)
    setMsg('')
    setDetail(null)
    setIamAssoc(null)
    setVpcDetail(null)
    setLinkedBastions([])
    const d = await describeEc2Instance(connection, id)
    setDetail(d)
    if (d) {
      setResizeType(d.type)
      try { setIamAssoc(await getIamAssociation(connection, id)) } catch { setIamAssoc(null) }
      if (d.vpcId !== '-') {
        try { setVpcDetail(await describeVpc(connection, d.vpcId)) } catch { setVpcDetail(null) }
      }
      try { setLinkedBastions(await findBastionConnectionsForInstance(connection, id)) } catch { setLinkedBastions([]) }
    } else {
      setLinkedBastions([])
    }
  }

  async function selectVolume(id: string) {
    setSelectedVolumeId(id)
    setVolumeDetail(null)
    setMsg('')
    const detail = await describeEbsVolume(connection, id)
    setVolumeDetail(detail)
  }

  /* ── Action handlers ─────────────────────────────────────── */
  async function doAction(action: Ec2InstanceAction) {
    if (!selectedId) return
    await runEc2InstanceAction(connection, selectedId, action)
    setMsg(`${action} sent`)
    await reload()
  }

  async function doDescribe() {
    if (!selectedId) return
    await selectInstance(selectedId)
    setShowDescribe(true)
    setMsg(`Loaded describe data for ${selectedId}`)
  }

  async function doTerminate() {
    if (!selectedId) return
    await terminateEc2Instance(connection, selectedId)
    setMsg('Terminate sent')
    await reload()
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
    await attachIamProfile(connection, selectedId, iamName)
    setMsg('IAM profile attached')
    setIamAssoc(await getIamAssociation(connection, selectedId))
  }

  async function doReplaceIam() {
    if (!iamAssoc || !iamName) return
    await replaceIamProfile(connection, iamAssoc.associationId, iamName)
    setMsg('IAM profile replaced')
    setIamAssoc(await getIamAssociation(connection, selectedId))
  }

  async function doRemoveIam() {
    if (!iamAssoc) return
    await removeIamProfile(connection, iamAssoc.associationId)
    setMsg('IAM profile removed')
    setIamAssoc(null)
  }

  async function doCreateSnap() {
    if (!snapVolume) return
    const id = await createEc2Snapshot(connection, snapVolume, snapDesc)
    setMsg(`Snapshot ${id} created`)
    setSnapshots(await listEc2Snapshots(connection))
  }

  async function doDeleteSnap() {
    if (!selectedSnapId) return
    await deleteEc2Snapshot(connection, selectedSnapId)
    setMsg(`Snapshot ${selectedSnapId} deleted`)
    setSnapshots(await listEc2Snapshots(connection))
  }

  async function doTagSnap() {
    if (!selectedSnapId || !tagKey) return
    await tagEc2Snapshot(connection, selectedSnapId, { [tagKey]: tagValue })
    setMsg(`Tag applied`)
    setSnapshots(await listEc2Snapshots(connection))
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

  async function doSendKey() {
    if (!selectedId || !sshKey || !detail) return
    const ok = await sendSshPublicKey(connection, selectedId, sshUser, sshKey, detail.availabilityZone)
    setMsg(ok ? 'Public key sent (valid 60s)' : 'Failed to send key')
  }

  async function handleBrowseSshKey() {
    try {
      const selectedPath = await chooseEc2SshKey()
      if (!selectedPath) {
        return
      }
      setSshKey(selectedPath)
      setMsg(`Selected SSH key: ${selectedPath}`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to choose SSH key')
    }
  }

  /* ── Filtering ─────────────────────────────────────────── */
  const filteredInstances = instances.filter(i => {
    if (stateFilter !== 'all' && i.state !== stateFilter) return false
    if (searchFilter) {
      const search = searchFilter.toLowerCase()
      const cols = Array.from(visibleCols)
      return cols.some(col => getColumnValue(i, col).toLowerCase().includes(search))
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

  /* ── Derived data ────────────────────────────────────────── */
  const selectedInstance = instances.find((instance) => instance.instanceId === selectedId) ?? null
  const isTerminatedInstance = selectedInstance?.state === 'terminated'
  const selectedVolume = volumes.find((volume) => volume.volumeId === selectedVolumeId) ?? null
  const selectedSnap = snapshots.find((s) => s.snapshotId === selectedSnapId) ?? null
  const hasManagedBastionTag = Object.keys(detail?.tags ?? {}).some((key) => key.startsWith('aws-lens-bastion/') || key.startsWith('aws-lens-bastion#'))
  const isSelectedBastion = bastions.some((instance) => instance.instanceId === selectedId)
  const isSelectedTempInspectionInstance = detail?.tags?.['aws-lens:purpose'] === 'ebs-inspection'
  const bastionLaunchBusy = bastionLaunchStatus !== null && !['completed', 'failed'].includes(bastionLaunchStatus.stage)
  const volumeWorkflowBusy = volumeWorkflowStatus !== null && !['completed', 'failed'].includes(volumeWorkflowStatus.stage)
  const volumeWarnings = volumeDetail ? [
    !volumeDetail.encrypted && volumeDetail.status === 'available-orphan' ? 'High priority: orphan volume is unencrypted.' : '',
    volumeDetail.type === 'gp2' ? 'Recommendation: migrate gp2 to gp3 for lower cost and more predictable performance.' : '',
    volumeDetail.status === 'available-orphan' && volumeDetail.createTime !== '-' && (Date.now() - new Date(volumeDetail.createTime).getTime()) > 1000 * 60 * 60 * 24 * 14
      ? 'Warning: orphan volume looks stale and has been unattached for more than 14 days.'
      : '',
    GOVERNANCE_TAG_KEYS.some((key) => !(volumeDetail.tags[key] || '').trim()) ? 'Warning: missing governance tags (Owner, Environment, or CostCenter).' : ''
  ].filter(Boolean) : []

  const ssmCmd = detail
                  ? connection.kind === 'profile'
                    ? `aws ssm start-session --target ${detail.instanceId} --profile ${connection.profile} --region ${connection.region}`
                    : `aws ssm start-session --target ${detail.instanceId} --region ${connection.region}`
    : ''
  const sshCmd = detail
    ? `ssh -i ${quoteSshArg(sshKey || `~/.ssh/${detail.keyName}.pem`)} ${sshUser}@${detail.publicIp !== '-' ? detail.publicIp : detail.privateIp}`
    : ''

  if (loading) return <div className="ec2-empty">Loading EC2 data...</div>

  return (
    <div className="ec2-console">
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
        <button className="ec2-tab" type="button" onClick={() => void reload()} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      {msg && <div className="ec2-msg">{msg}</div>}

      {/* ══════════════════ INSTANCES ══════════════════ */}
      {mainTab === 'instances' && (
        <>
          <div className="ec2-filter-bar">
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

          <input
            className="ec2-search-input"
            placeholder="Filter rows across selected columns..."
            value={searchFilter}
            onChange={e => setSearchFilter(e.target.value)}
          />

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

          <div className="ec2-main-layout">
            {/* ── Table area ──────────────────────────── */}
            <div className="ec2-table-area">
              <table className="ec2-data-table">
                <thead>
                  <tr>
                    {activeCols.map(col => (
                      <th key={col.key}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredInstances.map(inst => {
                    const rec = recommendationMap.get(inst.instanceId)
                    return (
                      <tr
                        key={inst.instanceId}
                        className={inst.instanceId === selectedId ? 'active' : ''}
                        onClick={() => void selectInstance(inst.instanceId)}
                      >
                        {activeCols.map(col => (
                          <td key={col.key}>
                            {col.key === 'state'
                              ? <span className={`ec2-badge ${inst.state}`}>{inst.state}</span>
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
                <div className="ec2-empty">No instances match filters.</div>
              )}
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
                    </div>
                  </div>
                )
              })()}

              {sideTab === 'overview' && (
                <>
                  {/* Actions */}
                  <div className="ec2-sidebar-section">
                    <h3>Actions</h3>
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
                    </div>
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
                        <span className="ec2-connect-label">Username</span>
                        <input value={sshUser} onChange={e => setSshUser(e.target.value)} />
                      </div>
                      <div className="ec2-connect-row">
                        <span className="ec2-connect-label">PEM key</span>
                        <div className="ec2-pem-row">
                          <input value={sshKey} onChange={e => setSshKey(e.target.value)} placeholder="path or key" />
                          <button className="ec2-action-btn" type="button" onClick={() => void handleBrowseSshKey()}>Browse</button>
                        </div>
                      </div>
                      <div className="ec2-connect-btns">
                        <button
                          className="ec2-action-btn ssm"
                          type="button"
                          onClick={() => {
                            onRunTerminalCommand?.(ssmCmd)
                            setMsg('SSM command opened in terminal')
                          }}
                        >SSM Connect</button>
                        <button
                          className="ec2-action-btn ssh"
                          type="button"
                          onClick={() => {
                            onRunTerminalCommand?.(sshCmd)
                            setMsg('SSH command opened in terminal')
                          }}
                        >SSH Connect</button>
                      </div>
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
                  {!selectedId && <div className="ec2-empty">Select an instance to view events.</div>}
                  {selectedId && timelineLoading && <div className="ec2-empty">Loading events…</div>}
                  {selectedId && !timelineLoading && timelineError && (
                    <div className="ec2-empty" style={{ color: '#f87171' }}>{timelineError}</div>
                  )}
                  {selectedId && !timelineLoading && !timelineError && timelineEvents.length === 0 && (
                    <div className="ec2-empty">No CloudTrail events found.</div>
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
              {!filteredVolumes.length && <div className="ec2-empty">No volumes match the current filter.</div>}
            </div>
          </div>

          <div className="ec2-detail-stack">
            <div className="ec2-panel">
              <h3>Volume Details</h3>
              {volumeDetail ? (
                <>
                  <KV items={[
                    ['Volume ID', volumeDetail.volumeId],
                    ['Name', volumeDetail.name],
                    ['State', volumeDetail.state],
                    ['Normalized Status', volumeDetail.status],
                    ['Size', `${volumeDetail.sizeGiB} GiB`],
                    ['Type', volumeDetail.type],
                    ['IOPS', String(volumeDetail.iops || '-')],
                    ['Throughput', volumeDetail.throughput ? `${volumeDetail.throughput} MiB/s` : '-'],
                    ['Encrypted', volumeDetail.encrypted ? 'Yes' : 'No'],
                    ['AZ', volumeDetail.availabilityZone],
                    ['Created', volumeDetail.createTime !== '-' ? new Date(volumeDetail.createTime).toLocaleString() : '-'],
                    ['Snapshot', volumeDetail.snapshotId],
                    ['Attachments', volumeDetail.attachments.length ? volumeDetail.attachments.map((attachment) => `${attachment.instanceId} ${attachment.device}`).join(', ') : 'None']
                  ]} />

                  <div className="ec2-btn-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                    {volumeDetail.status === 'available-orphan' && (
                      <button className="ec2-action-btn ssm" type="button" onClick={() => void doCheckVolume()}>
                        Check Volume
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
                    {volumeDetail.attachedInstanceIds[0] && (
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        setMainTab('instances')
                        void selectInstance(volumeDetail.attachedInstanceIds[0])
                      }}>Open Related Instance</button>
                    )}
                  </div>
                </>
              ) : <div className="ec2-empty">Select a volume.</div>}
            </div>

            {volumeDetail && (
              <div className="ec2-panel">
                <h3>Attachments</h3>
                {volumeDetail.attachments.length ? (
                  <div className="ec2-table">
                    <div className="ec2-thead"><div>Instance</div><div>Device</div><div>State</div><div>Attached</div></div>
                    {volumeDetail.attachments.map((attachment) => (
                      <div key={`${attachment.instanceId}-${attachment.device}`} className="ec2-trow">
                        <div>{attachment.instanceId}</div>
                        <div>{attachment.device}</div>
                        <div>{attachment.state}</div>
                        <div>{attachment.attachTime !== '-' ? new Date(attachment.attachTime).toLocaleString() : '-'}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ec2-empty">No active attachments.</div>
                )}
              </div>
            )}

            {volumeDetail && (
              <div className="ec2-panel">
                <h3>Recommendations</h3>
                {volumeWarnings.length ? volumeWarnings.map((warning) => (
                  <div key={warning} className="ec2-volume-warning">{warning}</div>
                )) : <div className="ec2-empty">No immediate recommendations.</div>}
                <div className="ec2-volume-actions-note">
                  Additional actions: delete volume, tag/untag, attach/detach, and modify size/type/IOPS/throughput should follow the same EC2 detail workflow next.
                </div>
              </div>
            )}

            {volumeDetail && (
              <div className="ec2-panel">
                <h3>Tags</h3>
                {Object.keys(volumeDetail.tags).length ? (
                  <div className="ec2-table">
                    <div className="ec2-thead"><div>Key</div><div>Value</div><div /><div /></div>
                    {Object.entries(volumeDetail.tags).map(([key, value]) => (
                      <div key={key} className="ec2-trow"><div>{key}</div><div>{value}</div><div /><div /></div>
                    ))}
                  </div>
                ) : (
                  <div className="ec2-empty">No tags.</div>
                )}
              </div>
            )}

            {volumeDetail?.tempEnvironment && (
              <div className="ec2-panel">
                <h3>Temporary Environment</h3>
                <KV items={[
                  ['Temp UUID', volumeDetail.tempEnvironment.tempUuid],
                  ['Instance', volumeDetail.tempEnvironment.instanceId],
                  ['State', volumeDetail.tempEnvironment.instanceState],
                  ['Subnet', volumeDetail.tempEnvironment.subnetId],
                  ['Security Group', volumeDetail.tempEnvironment.securityGroupId],
                  ['Instance Profile', volumeDetail.tempEnvironment.instanceProfileName],
                  ['Role', volumeDetail.tempEnvironment.iamRoleName]
                ]} />
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
              {!snapshots.length && <div className="ec2-empty">No snapshots.</div>}
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
                    ['Started', selectedSnap.startTime !== '-' ? new Date(selectedSnap.startTime).toLocaleString() : '-'],
                    ['Encrypted', selectedSnap.encrypted ? 'Yes' : 'No'],
                    ['Description', selectedSnap.description || '-'], ['Owner', selectedSnap.ownerId]
                  ]} />
                  <div className="ec2-btn-row" style={{ marginTop: 10 }}>
                    <ConfirmButton type="button" className="danger" onConfirm={() => void doDeleteSnap()} confirmLabel="Confirm Delete?">Delete Snapshot</ConfirmButton>
                  </div>
                </>
              ) : <div className="ec2-empty">Select a snapshot.</div>}
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
