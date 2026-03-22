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
  KeyPairSummary,
  SecurityGroupSummary,
  SubnetSummary
} from '@shared/types'
import { listKeyPairs, listSecurityGroupsForVpc, listSubnets, lookupCloudTrailEventsByResource } from './api'
import {
  attachIamProfile,
  createEc2Snapshot,
  deleteBastion,
  deleteEc2Snapshot,
  describeEc2Instance,
  describeVpc,
  findBastionConnectionsForInstance,
  getEc2Recommendations,
  getIamAssociation,
  launchBastion,
  launchFromSnapshot,
  listBastions,
  listEc2Instances,
  listEc2Snapshots,
  listInstanceTypes,
  listPopularBastionAmis,
  removeIamProfile,
  replaceIamProfile,
  resizeEc2Instance,
  runEc2InstanceAction,
  sendSshPublicKey,
  tagEc2Snapshot,
  terminateEc2Instance
} from './ec2Api'
import { ConfirmButton } from './ConfirmButton'

type MainTab = 'instances' | 'snapshots'
type SideTab = 'overview' | 'timeline'
type ColumnKey = 'name' | 'instanceId' | 'type' | 'state' | 'az' | 'publicIp' | 'privateIp'

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
      const [inst, snaps, bast] = await Promise.all([
        listEc2Instances(connection),
        listEc2Snapshots(connection),
        listBastions(connection)
      ])
      setInstances(inst)
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
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload(); void loadRecommendations() }, [connection.profile, connection.region])

  async function selectInstance(id: string) {
    setSelectedId(id)
    setMsg('')
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

  /* ── Action handlers ─────────────────────────────────────── */
  async function doAction(action: Ec2InstanceAction) {
    if (!selectedId) return
    await runEc2InstanceAction(connection, selectedId, action)
    setMsg(`${action} sent`)
    await reload()
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
    const id = await launchBastion(connection, {
      imageId: bastionAmi,
      instanceType: bastionType,
      subnetId: bastionSubnet,
      keyName: bastionKeyPair,
      securityGroupIds: bastionSg ? [bastionSg] : [],
      targetInstanceId: detail.instanceId
    })
    setMsg(`Bastion ${id} launched`)
    setBastions(await listBastions(connection))
    setLinkedBastions(await findBastionConnectionsForInstance(connection, detail.instanceId))
    setShowBastionPanel(false)
  }

  async function doDeleteBastion() {
    if (!detail) return
    await deleteBastion(connection, detail.instanceId)
    setMsg(
      linkedBastions.length > 0
        ? `Deleted ${linkedBastions.length} bastion connection${linkedBastions.length === 1 ? '' : 's'}`
        : 'Deleted bastion linkage'
    )
    setLinkedBastions([])
    setBastions(await listBastions(connection))
    await selectInstance(detail.instanceId)
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
  const selectedSnap = snapshots.find((s) => s.snapshotId === selectedSnapId) ?? null
  const hasManagedBastionTag = Object.keys(detail?.tags ?? {}).some((key) => key.startsWith('aws-lens-bastion#'))

  const ssmCmd = detail
    ? `aws ssm start-session --target ${detail.instanceId} --profile ${connection.profile} --region ${connection.region}`
    : ''
  const sshCmd = detail
    ? `ssh -i ~/.ssh/${detail.keyName}.pem ${sshUser}@${detail.publicIp !== '-' ? detail.publicIp : detail.privateIp}`
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
                      <button className="ec2-action-btn start" type="button" onClick={() => void doAction('start')}>Start</button>
                      <ConfirmButton className="ec2-action-btn stop" type="button" onConfirm={() => void doAction('stop')}>Stop</ConfirmButton>
                      <ConfirmButton className="ec2-action-btn" type="button" onConfirm={() => void doAction('reboot')}>Reboot</ConfirmButton>
                      <button className="ec2-action-btn resize" type="button" onClick={() => setShowResize(!showResize)}>Resize</button>
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        if (detail?.volumes[0]) setSnapVolume(detail.volumes[0].volumeId)
                        setMainTab('snapshots')
                      }}>Create Snapshot</button>
                      <button className="ec2-action-btn" type="button" onClick={() => {
                        openBastionPanel()
                      }}>Create Bastion</button>
                      {(linkedBastions.length > 0 || hasManagedBastionTag) && (
                        <ConfirmButton className="ec2-action-btn remove" type="button" onConfirm={() => void doDeleteBastion()}>
                          Delete Bastion
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

                  {/* Resize (expandable) */}
                  {showResize && detail && (
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
                        <button className="ec2-action-btn apply" type="button" onClick={() => void doLaunchBastion()} disabled={!bastionAmi || !bastionSubnet || !bastionKeyPair}>Launch Bastion</button>
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
                        placeholder="Instance profile name"
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
                          <button className="ec2-action-btn" type="button">Browse</button>
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
    </div>
  )
}
