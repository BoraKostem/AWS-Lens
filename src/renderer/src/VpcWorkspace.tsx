import { useEffect, useMemo, useRef, useState } from 'react'
import { SvcState } from './SvcState'
import './vpc.css'

import {
  createReachabilityPath,
  getReachabilityAnalysis,
  getVpcTopology,
  listEc2Instances,
  listInternetGateways,
  listLoadBalancerWorkspaces,
  listNatGateways,
  listNetworkInterfaces,
  listRouteTables,
  listSubnets,
  listTransitGateways,
  listVpcs,
  updateSubnetPublicIp
} from './api'
import type {
  AwsConnection,
  Ec2InstanceSummary,
  InternetGatewaySummary,
  LoadBalancerWorkspace,
  NatGatewaySummary,
  NetworkInterfaceSummary,
  ReachabilityPathResult,
  RouteTableSummary,
  SubnetSummary,
  TransitGatewaySummary,
  VpcSummary,
  VpcTopology
} from '@shared/types'

type VpcTab = 'topology' | 'flow' | 'reachability' | 'gateways' | 'interfaces'

const TABS: Array<{ id: VpcTab; label: string }> = [
  { id: 'topology', label: 'Topology' },
  { id: 'flow', label: 'Architecture' },
  { id: 'reachability', label: 'Reachability' },
  { id: 'gateways', label: 'Gateways' },
  { id: 'interfaces', label: 'Interfaces' },
]

function formatVpcName(vpc: VpcSummary): string {
  return vpc.name && vpc.name !== '-' ? vpc.name : vpc.vpcId
}

function summarizeVpcStatus(vpc: VpcSummary | null): { tone: 'success' | 'warning' | 'info'; label: string } {
  if (!vpc) {
    return { tone: 'info', label: 'No selection' }
  }

  if (vpc.state === 'available') {
    return { tone: 'success', label: vpc.isDefault ? 'Default VPC' : 'Available' }
  }

  return { tone: 'warning', label: vpc.state || 'Pending' }
}

/* ── VPC Architecture Diagram ─────────────────────────────── */

const STATE_COLORS: Record<string, string> = {
  running: '#34d399',
  stopped: '#f87171',
  terminated: '#6b7280',
  pending: '#fbbf24',
  'shutting-down': '#fb923c',
  active: '#34d399',
  provisioning: '#fbbf24',
}

function VpcArchitectureDiagram({
  vpc,
  subnets,
  igws,
  nats,
  routeTables,
  enis,
  ec2Instances,
  loadBalancers,
  onNavigate,
  onSwitchTab
}: {
  vpc: VpcSummary | null
  subnets: SubnetSummary[]
  igws: InternetGatewaySummary[]
  nats: NatGatewaySummary[]
  routeTables: RouteTableSummary[]
  enis: NetworkInterfaceSummary[]
  ec2Instances: Ec2InstanceSummary[]
  loadBalancers: LoadBalancerWorkspace[]
  onNavigate: (service: string, resourceId?: string) => void
  onSwitchTab: (tab: VpcTab) => void
}) {
  const azGroups = useMemo(() => {
    const grouped = new Map<string, SubnetSummary[]>()
    for (const s of subnets) {
      const list = grouped.get(s.availabilityZone) ?? []
      list.push(s)
      grouped.set(s.availabilityZone, list)
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [subnets])

  const publicSubnetIds = useMemo(() => {
    const ids = new Set<string>()
    const explicitlyAssociated = new Set(routeTables.flatMap(rt => rt.associatedSubnets))
    for (const rt of routeTables) {
      const hasIgwRoute = rt.routes.some(r => r.target.startsWith('igw-'))
      if (hasIgwRoute) {
        for (const sid of rt.associatedSubnets) ids.add(sid)
        if (rt.isMain) {
          for (const s of subnets) {
            if (!explicitlyAssociated.has(s.subnetId)) ids.add(s.subnetId)
          }
        }
      }
    }
    return ids
  }, [routeTables, subnets])

  // Group EC2 instances by subnet
  const instancesBySubnet = useMemo(() => {
    const map = new Map<string, Ec2InstanceSummary[]>()
    for (const inst of ec2Instances) {
      const list = map.get(inst.subnetId) ?? []
      list.push(inst)
      map.set(inst.subnetId, list)
    }
    return map
  }, [ec2Instances])

  // Detect LB ENIs per subnet (for LBs that don't have direct subnet field)
  const lbEnisBySubnet = useMemo(() => {
    const map = new Map<string, Array<{ type: string; description: string }>>()
    for (const eni of enis) {
      if (eni.interfaceType === 'network_load_balancer' || eni.interfaceType === 'gateway_load_balancer' ||
          eni.description.startsWith('ELB app/') || eni.description.startsWith('ELB net/')) {
        const list = map.get(eni.subnetId) ?? []
        list.push({ type: eni.interfaceType, description: eni.description })
        map.set(eni.subnetId, list)
      }
    }
    return map
  }, [enis])

  if (!vpc) return <SvcState variant="no-selection" resourceName="VPC" message="Select a VPC to view the architecture diagram." />

  // Layout constants
  const MAX_SHOW = 4
  const RESOURCE_ROW_H = 18
  const SUBNET_HEADER_H = 55
  const SUBNET_W = 240
  const AZ_PAD = 12
  const AZ_COL_W = SUBNET_W + AZ_PAD * 2
  const AZ_GAP = 24

  // Compute max resources per subnet for uniform height
  const allSubnetResourceCounts = subnets.map(s => {
    const ec2 = instancesBySubnet.get(s.subnetId)?.length ?? 0
    const lbEnis = lbEnisBySubnet.get(s.subnetId)?.length ?? 0
    return ec2 + (lbEnis > 0 ? 1 : 0) // count LB ENIs as 1 entry
  })
  const maxResources = Math.min(Math.max(0, ...allSubnetResourceCounts), MAX_SHOW)
  const anyOverflow = allSubnetResourceCounts.some(c => c > MAX_SHOW)
  const resourceAreaH = maxResources > 0 ? 8 + maxResources * RESOURCE_ROW_H + (anyOverflow ? RESOURCE_ROW_H : 0) : 0
  const SUBNET_H = SUBNET_HEADER_H + resourceAreaH

  const azCount = Math.max(azGroups.length, 1)
  const maxSubs = Math.max(1, ...azGroups.map(([, s]) => s.length))

  const vpcContentW = azCount * AZ_COL_W + (azCount - 1) * AZ_GAP
  const W = Math.max(vpcContentW + 140, 720)
  const CX = W / 2

  // Sequential Y layout
  let y = 14
  const INTERNET_H = 34
  const internetCY = y + INTERNET_H / 2
  y += INTERNET_H + 8

  const arrowGap = 28
  y += arrowGap

  const IGW_H = 36
  const igwCY = y + IGW_H / 2
  y += IGW_H + 8
  y += arrowGap

  const vpcTop = y
  y += 10

  // VPC title
  y += 20

  // Load balancer row (inside VPC, above subnets)
  const LB_H = 34
  let lbRowY = 0
  if (loadBalancers.length > 0) {
    lbRowY = y + LB_H / 2
    y += LB_H + 16
  }

  // AZ labels
  const azLabelY = y + 12
  y += 28

  // Subnets
  const subnetStartY = y
  const subnetAreaH = maxSubs * SUBNET_H + (maxSubs - 1) * 10
  y += subnetAreaH + 18

  // NAT gateways
  const NAT_H = 32
  let natCY = 0
  if (nats.length > 0) {
    natCY = y + NAT_H / 2
    y += NAT_H + 18
  }

  // Connection gap
  y += 12

  // Route tables
  const RT_H = 32
  const rtCY = y + RT_H / 2
  y += RT_H + 18

  const vpcBottom = y
  const H = vpcBottom + 14

  // AZ column positions
  const azTotalW = azCount * AZ_COL_W + (azCount - 1) * AZ_GAP
  const azStartX = CX - azTotalW / 2
  const getAzX = (i: number) => azStartX + i * (AZ_COL_W + AZ_GAP)
  const getAzCX = (i: number) => getAzX(i) + AZ_COL_W / 2

  // RT positions
  const rtCount = Math.max(routeTables.length, 1)
  const rtSpacing = Math.min(300, (W - 200) / rtCount)
  const rtStartX = CX - ((rtCount - 1) * rtSpacing) / 2
  const getRtCX = (i: number) => rtStartX + i * rtSpacing

  // NAT positions
  const natSpacing = Math.min(280, (W - 200) / Math.max(nats.length, 1))
  const natStartX = CX - ((nats.length - 1) * natSpacing) / 2
  const getNatCX = (i: number) => natStartX + i * natSpacing

  // IGW positions
  const igwSpacing = Math.min(300, (W - 200) / Math.max(igws.length, 1))
  const igwStartX = CX - ((igws.length - 1) * igwSpacing) / 2
  const getIgwCX = (i: number) => igwStartX + i * igwSpacing

  // LB positions
  const lbCount = Math.max(loadBalancers.length, 1)
  const lbSpacing = Math.min(280, (W - 200) / lbCount)
  const lbStartX = CX - ((loadBalancers.length - 1) * lbSpacing) / 2
  const getLbCX = (i: number) => lbStartX + i * lbSpacing

  const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 2) + '..' : s

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="vpc-arch-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arch-arrow" markerWidth="8" markerHeight="6" refX="4" refY="6" orient="auto">
          <path d="M0,0 L4,6 L8,0" fill="none" stroke="rgba(148,163,184,0.6)" strokeWidth="1.2" />
        </marker>
      </defs>

      {/* ── Internet ──────────────────────────── */}
      <g className="vpc-arch-node">
        <rect x={CX - 70} y={internetCY - INTERNET_H / 2} width={140} height={INTERNET_H}
          rx={8} fill="rgba(71,85,105,0.5)" stroke="rgba(148,163,184,0.45)" strokeWidth={1.5} />
        <text x={CX} y={internetCY + 5} textAnchor="middle" fill="#e2e8f0" fontSize={14} fontWeight={600}>
          Internet
        </text>
      </g>

      {/* Arrow: Internet → IGW */}
      <line x1={CX} y1={internetCY + INTERNET_H / 2}
            x2={CX} y2={igwCY - IGW_H / 2}
            stroke="rgba(148,163,184,0.5)" strokeWidth={1.5} markerEnd="url(#arch-arrow)" />

      {/* ── IGW(s) ────────────────────────────── */}
      {igws.length > 0 ? igws.map((igw, i) => {
        const ix = getIgwCX(i)
        return (
          <g key={igw.igwId} className="vpc-arch-node vpc-arch-clickable" onClick={() => onSwitchTab('gateways')}>
            <rect x={ix - 140} y={igwCY - IGW_H / 2} width={280} height={IGW_H}
              rx={8} fill="rgba(251,191,36,0.15)" stroke="#f59e0b" strokeWidth={1.5} />
            <text x={ix} y={igwCY + 5} textAnchor="middle" fill="#fbbf24" fontSize={12} fontWeight={700}>
              IGW: {trunc(igw.igwId, 30)}
            </text>
          </g>
        )
      }) : (
        <text x={CX} y={igwCY + 4} textAnchor="middle" fill="rgba(148,163,184,0.35)" fontSize={11} fontStyle="italic">
          No Internet Gateway
        </text>
      )}

      {/* Arrow: IGW → VPC */}
      <line x1={CX} y1={igwCY + IGW_H / 2}
            x2={CX} y2={vpcTop}
            stroke="rgba(148,163,184,0.5)" strokeWidth={1.5} markerEnd="url(#arch-arrow)" />

      {/* ── VPC Container ─────────────────────── */}
      <rect x={50} y={vpcTop} width={W - 100} height={vpcBottom - vpcTop}
        rx={6} fill="rgba(30,58,138,0.08)" stroke="rgba(96,165,250,0.45)" strokeWidth={2} />
      <text x={62} y={vpcTop + 18} fill="#60a5fa" fontSize={13} fontWeight={700}>
        VPC: {vpc.vpcId}
      </text>

      {/* ── Load Balancers (VPC level) ─────────── */}
      {loadBalancers.map((lb, i) => {
        const lx = getLbCX(i)
        const lbType = lb.summary.type === 'application' ? 'ALB' : lb.summary.type === 'network' ? 'NLB' : lb.summary.type.toUpperCase()
        return (
          <g key={lb.summary.arn} className="vpc-arch-clickable" onClick={() => onNavigate('load-balancers')}>
            <rect x={lx - 130} y={lbRowY - LB_H / 2} width={260} height={LB_H}
              rx={6} fill="rgba(168,85,247,0.1)" stroke="rgba(168,85,247,0.5)" strokeWidth={1.3} />
            <text x={lx} y={lbRowY - 2} textAnchor="middle" fill="#c084fc" fontSize={10.5} fontWeight={600}>
              {lbType}: {trunc(lb.summary.name, 24)}
            </text>
            <text x={lx} y={lbRowY + 12} textAnchor="middle" fill="rgba(148,163,184,0.5)" fontSize={9}>
              {lb.summary.scheme} · {lb.summary.state}
            </text>
          </g>
        )
      })}

      {/* ── AZ Columns + Subnets + Resources ──── */}
      {azGroups.map(([az, subs], azIdx) => {
        const colX = getAzX(azIdx)
        const colCX = getAzCX(azIdx)

        return (
          <g key={az}>
            {/* AZ label */}
            <text x={colCX} y={azLabelY} textAnchor="middle" fill="rgba(148,163,184,0.6)" fontSize={11} fontWeight={500}>
              {az}
            </text>

            {/* AZ column boundary */}
            <rect x={colX + 4} y={azLabelY + 8} width={AZ_COL_W - 8}
              height={subs.length * (SUBNET_H + 10) - 2} rx={4}
              fill="none" stroke="rgba(148,163,184,0.08)" strokeWidth={1} strokeDasharray="4 3" />

            {/* Subnets */}
            {subs.map((s, si) => {
              const sy = subnetStartY + si * (SUBNET_H + 10)
              const isPublic = publicSubnetIds.has(s.subnetId)
              const instances = instancesBySubnet.get(s.subnetId) ?? []
              const lbEnis = lbEnisBySubnet.get(s.subnetId) ?? []

              // Build resource list for this subnet
              const resources: Array<{ id: string; label: string; state: string; type: 'ec2' | 'lb' }> = []
              for (const inst of instances) {
                resources.push({
                  id: inst.instanceId,
                  label: inst.name !== '-' && inst.name ? inst.name : inst.instanceId,
                  state: inst.state,
                  type: 'ec2'
                })
              }
              if (lbEnis.length > 0) {
                // Deduplicate by description (same LB may have multiple ENIs)
                const seen = new Set<string>()
                for (const le of lbEnis) {
                  const key = le.description
                  if (!seen.has(key)) {
                    seen.add(key)
                    const lbName = le.description.replace(/^ELB (app|net)\//, '').split('/')[0] || le.type
                    resources.push({
                      id: key,
                      label: lbName,
                      state: 'active',
                      type: 'lb'
                    })
                  }
                }
              }

              const visible = resources.slice(0, MAX_SHOW)
              const overflow = resources.length - MAX_SHOW

              return (
                <g key={s.subnetId}>
                  {/* Subnet box */}
                  <g className="vpc-arch-clickable" onClick={() => onSwitchTab('topology')}>
                    <rect x={colX + AZ_PAD} y={sy} width={SUBNET_W} height={SUBNET_H}
                      rx={6} fill="rgba(52,211,153,0.06)" stroke="rgba(52,211,153,0.45)" strokeWidth={1.5} />
                    <text x={colX + AZ_PAD + 10} y={sy + 17} fill="#34d399" fontSize={10.5} fontWeight={600}>
                      {isPublic ? 'Public' : 'Private'}: {trunc(s.subnetId, 24)}
                    </text>
                    <text x={colX + AZ_PAD + 10} y={sy + 32} fill="rgba(148,163,184,0.65)" fontSize={10}>
                      {s.cidrBlock}
                    </text>
                    {s.name !== '-' && (
                      <text x={colX + AZ_PAD + 10} y={sy + 46} fill="rgba(148,163,184,0.4)" fontSize={9}>
                        {trunc(s.name, 30)}
                      </text>
                    )}
                  </g>

                  {/* Resources inside subnet */}
                  {visible.length > 0 && (
                    <line x1={colX + AZ_PAD + 8} y1={sy + SUBNET_HEADER_H}
                          x2={colX + AZ_PAD + SUBNET_W - 8} y2={sy + SUBNET_HEADER_H}
                          stroke="rgba(148,163,184,0.1)" strokeWidth={0.8} />
                  )}
                  {visible.map((res, ri) => {
                    const ry = sy + SUBNET_HEADER_H + 6 + ri * RESOURCE_ROW_H
                    const stateCol = STATE_COLORS[res.state] ?? '#94a3b8'
                    const isEc2 = res.type === 'ec2'

                    return (
                      <g key={res.id} className="vpc-arch-clickable"
                        onClick={() => onNavigate(isEc2 ? 'ec2' : 'load-balancers')}>
                        {/* Resource type icon */}
                        <rect x={colX + AZ_PAD + 8} y={ry} width={isEc2 ? 22 : 18} height={14}
                          rx={3} fill={isEc2 ? 'rgba(96,165,250,0.15)' : 'rgba(168,85,247,0.15)'}
                          stroke={isEc2 ? 'rgba(96,165,250,0.35)' : 'rgba(168,85,247,0.35)'} strokeWidth={0.7} />
                        <text x={colX + AZ_PAD + (isEc2 ? 19 : 17)} y={ry + 10.5}
                          textAnchor="middle" fill={isEc2 ? '#60a5fa' : '#c084fc'} fontSize={7} fontWeight={700}>
                          {isEc2 ? 'EC2' : 'LB'}
                        </text>
                        {/* Resource name */}
                        <text x={colX + AZ_PAD + (isEc2 ? 34 : 30)} y={ry + 10.5}
                          fill="#d1d5db" fontSize={9}>
                          {trunc(res.label, 18)}
                        </text>
                        {/* State dot */}
                        <circle cx={colX + AZ_PAD + SUBNET_W - 18} cy={ry + 7} r={3}
                          fill={stateCol} fillOpacity={0.8} />
                        <text x={colX + AZ_PAD + SUBNET_W - 12} y={ry + 10}
                          fill="rgba(148,163,184,0.5)" fontSize={7}>
                        </text>
                      </g>
                    )
                  })}
                  {overflow > 0 && (
                    <text x={colX + AZ_PAD + 10}
                      y={sy + SUBNET_HEADER_H + 6 + visible.length * RESOURCE_ROW_H + 10}
                      fill="rgba(148,163,184,0.4)" fontSize={8} fontStyle="italic">
                      +{overflow} more
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        )
      })}

      {/* ── NAT Gateways ──────────────────────── */}
      {nats.map((n, i) => {
        const nx = getNatCX(i)
        return (
          <g key={n.natGatewayId} className="vpc-arch-clickable" onClick={() => onSwitchTab('gateways')}>
            <rect x={nx - 125} y={natCY - NAT_H / 2} width={250} height={NAT_H}
              rx={6} fill="rgba(249,115,22,0.08)" stroke="rgba(249,115,22,0.45)" strokeWidth={1.2} />
            <text x={nx} y={natCY + 4} textAnchor="middle" fill="#f97316" fontSize={10.5} fontWeight={600}>
              NAT: {trunc(n.natGatewayId, 22)} · {n.publicIp}
            </text>
          </g>
        )
      })}

      {/* ── Connection lines: Subnets → Route Tables ─── */}
      {routeTables.map((rt, rtIdx) => {
        const rtX = getRtCX(rtIdx)
        const explicitlyAssociated = new Set(routeTables.flatMap(r => r.associatedSubnets))
        const linked = rt.isMain
          ? subnets.filter(s => rt.associatedSubnets.includes(s.subnetId) || !explicitlyAssociated.has(s.subnetId))
          : subnets.filter(s => rt.associatedSubnets.includes(s.subnetId))

        return linked.map((s) => {
          const azIdx = azGroups.findIndex(([az]) => az === s.availabilityZone)
          if (azIdx < 0) return null
          const subIdx = azGroups[azIdx][1].findIndex(sub => sub.subnetId === s.subnetId)
          if (subIdx < 0) return null

          const sx = getAzCX(azIdx)
          const sy = subnetStartY + subIdx * (SUBNET_H + 10) + SUBNET_H

          return (
            <line key={`${rt.routeTableId}-${s.subnetId}`}
              x1={sx} y1={sy} x2={rtX} y2={rtCY - RT_H / 2}
              stroke="rgba(148,163,184,0.18)" strokeWidth={1.2} strokeDasharray="5 3" />
          )
        })
      })}

      {/* ── Route Tables ──────────────────────── */}
      {routeTables.map((rt, rtIdx) => {
        const rx = getRtCX(rtIdx)
        return (
          <g key={rt.routeTableId} className="vpc-arch-clickable" onClick={() => onSwitchTab('topology')}>
            <rect x={rx - 145} y={rtCY - RT_H / 2} width={290} height={RT_H}
              rx={6} fill="rgba(100,116,139,0.12)" stroke="rgba(148,163,184,0.35)" strokeWidth={1.2} />
            <text x={rx} y={rtCY + 4} textAnchor="middle" fill="#94a3b8" fontSize={10.5} fontWeight={600}>
              RT: {trunc(rt.routeTableId, 24)} {rt.isMain ? '(main)' : ''}
            </text>
          </g>
        )
      })}

      {/* ── Empty states ──────────────────────── */}
      {subnets.length === 0 && (
        <text x={CX} y={subnetStartY + 30} textAnchor="middle" fill="rgba(148,163,184,0.3)" fontSize={12} fontStyle="italic">
          No subnets in this VPC
        </text>
      )}
      {routeTables.length === 0 && (
        <text x={CX} y={rtCY} textAnchor="middle" fill="rgba(148,163,184,0.3)" fontSize={12} fontStyle="italic">
          No route tables
        </text>
      )}
    </svg>
  )
}

export function VpcWorkspace({ connection, focusVpcId, onNavigate }: {
  connection: AwsConnection
  focusVpcId?: { token: number; vpcId: string } | null
  onNavigate: (service: string, resourceId?: string) => void
}) {
  const [tab, setTab] = useState<VpcTab>('topology')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [vpcs, setVpcs] = useState<VpcSummary[]>([])
  const [selectedVpcId, setSelectedVpcId] = useState('')
  const [topology, setTopology] = useState<VpcTopology | null>(null)
  const [subnets, setSubnets] = useState<SubnetSummary[]>([])
  const [routeTables, setRouteTables] = useState<RouteTableSummary[]>([])
  const [igws, setIgws] = useState<InternetGatewaySummary[]>([])
  const [nats, setNats] = useState<NatGatewaySummary[]>([])
  const [tgws, setTgws] = useState<TransitGatewaySummary[]>([])
  const [enis, setEnis] = useState<NetworkInterfaceSummary[]>([])
  const [ec2Instances, setEc2Instances] = useState<Ec2InstanceSummary[]>([])
  const [loadBalancers, setLoadBalancers] = useState<LoadBalancerWorkspace[]>([])

  const [reachSrc, setReachSrc] = useState('')
  const [reachDest, setReachDest] = useState('')
  const [reachProto, setReachProto] = useState('tcp')
  const [reachResults, setReachResults] = useState<ReachabilityPathResult[]>([])
  const [loadingVpcId, setLoadingVpcId] = useState('')
  const vpcLoadRequestRef = useRef(0)

  const selectedVpc = useMemo(() => vpcs.find((vpc) => vpc.vpcId === selectedVpcId) ?? null, [vpcs, selectedVpcId])
  const isSwitchingVpc = Boolean(loadingVpcId && loadingVpcId === selectedVpcId)
  const selectedVpcStatus = useMemo(() => summarizeVpcStatus(selectedVpc), [selectedVpc])
  const publicSubnetCount = useMemo(() => subnets.filter((subnet) => subnet.mapPublicIpOnLaunch).length, [subnets])
  const privateSubnetCount = subnets.length - publicSubnetCount
  const availabilityZoneCount = useMemo(() => new Set(subnets.map((subnet) => subnet.availabilityZone)).size, [subnets])
  const reachableCount = useMemo(() => reachResults.filter((result) => result.reachable).length, [reachResults])
  const latestReachability = reachResults[0] ?? null

  function clearVpcData() {
    setTopology(null)
    setSubnets([])
    setRouteTables([])
    setIgws([])
    setNats([])
    setTgws([])
    setEnis([])
    setEc2Instances([])
    setLoadBalancers([])
  }

  async function loadVpcs() {
    setLoading(true); setError('')
    try { const list = await listVpcs(connection); setVpcs(list); if (list.length && !selectedVpcId) setSelectedVpcId(list[0].vpcId) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  async function loadVpcData(vpcId: string) {
    if (!vpcId) return
    const requestId = ++vpcLoadRequestRef.current
    setLoading(true); setLoadingVpcId(vpcId); setError(''); clearVpcData()
    try {
      const [topo, sl, rl, il, nl, tl, el, allInstances, allLbs] = await Promise.all([
        getVpcTopology(connection, vpcId),
        listSubnets(connection, vpcId),
        listRouteTables(connection, vpcId),
        listInternetGateways(connection, vpcId),
        listNatGateways(connection, vpcId),
        listTransitGateways(connection),
        listNetworkInterfaces(connection, vpcId),
        listEc2Instances(connection),
        listLoadBalancerWorkspaces(connection)
      ])
      if (requestId !== vpcLoadRequestRef.current) return
      setTopology(topo); setSubnets(sl); setRouteTables(rl); setIgws(il); setNats(nl); setTgws(tl); setEnis(el)
      setEc2Instances(allInstances.filter(i => i.vpcId === vpcId))
      setLoadBalancers(allLbs.filter(lb => lb.summary.vpcId === vpcId))
    } catch (e) {
      if (requestId !== vpcLoadRequestRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (requestId !== vpcLoadRequestRef.current) return
      setLoading(false)
      setLoadingVpcId('')
    }
  }
  useEffect(() => { void loadVpcs() }, [])
  useEffect(() => { if (selectedVpcId) void loadVpcData(selectedVpcId) }, [selectedVpcId])

  /* ── Focus drilldown ─────────────────────────────────────── */
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  useEffect(() => {
    if (!focusVpcId || focusVpcId.token === appliedFocusToken) return
    setAppliedFocusToken(focusVpcId.token)
    const match = vpcs.find(v => v.vpcId === focusVpcId.vpcId)
    if (match && match.vpcId !== selectedVpcId) setSelectedVpcId(match.vpcId)
  }, [appliedFocusToken, focusVpcId, vpcs, selectedVpcId])

  async function handleSubnetTogglePublicIp(subnetId: string, current: boolean) {
    try { await updateSubnetPublicIp(connection, subnetId, !current); setSubnets(p => p.map(s => s.subnetId === subnetId ? { ...s, mapPublicIpOnLaunch: !current } : s)); setMsg(`Public IP ${current ? 'disabled' : 'enabled'}`) } catch (e) { setError(String(e)) }
  }
  async function handleReachRun() {
    if (!reachSrc.trim() || !reachDest.trim()) return; setLoading(true); setError('')
    try { const r = await createReachabilityPath(connection, reachSrc.trim(), reachDest.trim(), reachProto); setReachResults(p => [r, ...p]) } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }
  async function handleReachRefresh(id: string) {
    try { const u = await getReachabilityAnalysis(connection, id); setReachResults(p => p.map(r => r.analysisId === id ? u : r)) } catch (e) { setError(String(e)) }
  }

  return (
    <div className="vpc-console">
      <section className="vpc-shell-hero">
        <div className="vpc-shell-hero-copy">
          <div className="eyebrow">Networking</div>
          <h2>VPC workspace</h2>
          <p>Terraform’s split-shell layout becomes the model here: an inventory rail on the left, a posture-driven detail pane on the right, and denser operational signals at the top.</p>
          <div className="vpc-shell-meta-strip">
            <div className="vpc-shell-meta-pill">
              <span>Connection</span>
              <strong>{connection.kind === 'profile' ? connection.profile : connection.label}</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Selected VPC</span>
              <strong>{selectedVpc ? formatVpcName(selectedVpc) : 'Choose a VPC'}</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Current view</span>
              <strong>{TABS.find((item) => item.id === tab)?.label ?? 'Topology'}</strong>
            </div>
          </div>
        </div>
        <div className="vpc-shell-hero-stats">
          <div className={`vpc-shell-stat-card ${selectedVpcStatus.tone}`}>
            <span>Network posture</span>
            <strong>{selectedVpcStatus.label}</strong>
            <small>{selectedVpc ? selectedVpc.state : 'Waiting for selection'}</small>
          </div>
          <div className="vpc-shell-stat-card">
            <span>Tracked VPCs</span>
            <strong>{vpcs.length}</strong>
            <small>{vpcs.filter((vpc) => vpc.isDefault).length} default environments</small>
          </div>
          <div className="vpc-shell-stat-card">
            <span>Reachability runs</span>
            <strong>{reachResults.length}</strong>
            <small>{reachableCount} reachable paths confirmed</small>
          </div>
          <div className="vpc-shell-stat-card">
            <span>Inventory load</span>
            <strong>{loading ? 'Syncing' : 'Ready'}</strong>
            <small>{isSwitchingVpc ? 'Refreshing selected network' : 'Live AWS inventory'}</small>
          </div>
        </div>
      </section>

      <div className="vpc-shell-toolbar">
        <div className="vpc-toolbar">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`vpc-toolbar-tab ${item.id === tab ? 'active' : ''}`}
              type="button"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="vpc-shell-status">
          <div className="vpc-shell-status-card">
            <span>Selection</span>
            <strong>{selectedVpc ? selectedVpc.vpcId : 'No VPC selected'}</strong>
          </div>
          <div className="vpc-shell-status-card">
            <span>State</span>
            <strong>{isSwitchingVpc ? 'Loading selected VPC...' : loading ? 'Loading inventory...' : 'Synchronized'}</strong>
          </div>
          <button
            className="vpc-toolbar-btn accent"
            type="button"
            onClick={() => selectedVpcId && void loadVpcData(selectedVpcId)}
            disabled={loading || !selectedVpcId}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {msg && <div className="vpc-msg">{msg}</div>}
      {error && <SvcState variant="error" error={error} />}
      <div className="vpc-main-layout">
        <aside className="vpc-inventory-pane">
          <div className="vpc-pane-head">
            <div>
              <span className="vpc-pane-kicker">Tracked networks</span>
              <h3>VPC inventory</h3>
            </div>
            <span className="vpc-pane-summary">{vpcs.length} total</span>
          </div>
          <label className="vpc-select-field">
            <span>Quick select</span>
            <select value={selectedVpcId} onChange={(event) => setSelectedVpcId(event.target.value)} disabled={loading && !selectedVpcId}>
              {vpcs.map((vpc) => (
                <option key={vpc.vpcId} value={vpc.vpcId}>
                  {formatVpcName(vpc)} ({vpc.cidrBlock}){vpc.isDefault ? ' [default]' : ''}
                </option>
              ))}
            </select>
          </label>
          {vpcs.length === 0 ? (
            <SvcState variant="empty" message="No VPCs returned for this connection." />
          ) : (
            <div className="vpc-inventory-list">
              {vpcs.map((vpc) => {
                const status = summarizeVpcStatus(vpc)
                return (
                  <button
                    key={vpc.vpcId}
                    type="button"
                    className={`vpc-inventory-card ${vpc.vpcId === selectedVpcId ? 'active' : ''}`}
                    onClick={() => setSelectedVpcId(vpc.vpcId)}
                  >
                    <div className="vpc-inventory-card-top">
                      <div className="vpc-inventory-card-copy">
                        <strong>{formatVpcName(vpc)}</strong>
                        <span className="vpc-mono">{vpc.vpcId}</span>
                      </div>
                      <span className={`vpc-status-badge ${status.tone}`}>{status.label}</span>
                    </div>
                    <div className="vpc-inventory-card-meta">
                      <span>{vpc.cidrBlock}</span>
                      <span>{vpc.state}</span>
                      {vpc.isDefault && <span>default</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </aside>

        <section className="vpc-detail-pane">
          {!selectedVpc ? (
            <SvcState variant="no-selection" resourceName="VPC" message="Select a VPC to inspect topology, gateways, interfaces, and reachability." />
          ) : (
            <>
              <section className="vpc-detail-hero">
                <div className="vpc-detail-hero-copy">
                  <div className="eyebrow">Network posture</div>
                  <h3>{formatVpcName(selectedVpc)}</h3>
                  <p>{selectedVpc.cidrBlock} · {selectedVpc.vpcId}</p>
                  <div className="vpc-detail-meta-strip">
                    <div className="vpc-detail-meta-pill">
                      <span>State</span>
                      <strong>{selectedVpc.state}</strong>
                    </div>
                    <div className="vpc-detail-meta-pill">
                      <span>Scope</span>
                      <strong>{selectedVpc.isDefault ? 'Default VPC' : 'Custom VPC'}</strong>
                    </div>
                    <div className="vpc-detail-meta-pill">
                      <span>Availability zones</span>
                      <strong>{availabilityZoneCount || '-'}</strong>
                    </div>
                    <div className="vpc-detail-meta-pill">
                      <span>Reachability</span>
                      <strong>{latestReachability ? latestReachability.status : 'No analyses yet'}</strong>
                    </div>
                  </div>
                </div>
                <div className="vpc-detail-hero-stats">
                  <div className={`vpc-detail-stat-card ${selectedVpcStatus.tone}`}>
                    <span>Subnet split</span>
                    <strong>{subnets.length}</strong>
                    <small>{publicSubnetCount} public · {privateSubnetCount} private</small>
                  </div>
                  <div className="vpc-detail-stat-card">
                    <span>Routing</span>
                    <strong>{routeTables.length}</strong>
                    <small>{igws.length} IGWs · {nats.length} NAT gateways</small>
                  </div>
                  <div className="vpc-detail-stat-card">
                    <span>Workloads</span>
                    <strong>{ec2Instances.length}</strong>
                    <small>{loadBalancers.length} load balancers</small>
                  </div>
                  <div className="vpc-detail-stat-card">
                    <span>Interfaces</span>
                    <strong>{enis.length}</strong>
                    <small>{tgws.length} transit gateways visible</small>
                  </div>
                </div>
              </section>

              <div className="vpc-detail-tabs">
                {TABS.map((item) => (
                  <button key={item.id} className={tab === item.id ? 'active' : ''} type="button" onClick={() => setTab(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>

              {tab === 'topology' && topology && (
                <>
                  <div className="vpc-summary-grid">
                    <div className="vpc-summary-card"><span>Subnets</span><strong>{topology.subnets.length}</strong></div>
                    <div className="vpc-summary-card"><span>Route tables</span><strong>{topology.routeTables.length}</strong></div>
                    <div className="vpc-summary-card"><span>Internet gateways</span><strong>{topology.internetGateways.length}</strong></div>
                    <div className="vpc-summary-card"><span>NAT gateways</span><strong>{topology.natGateways.length}</strong></div>
                    <div className="vpc-summary-card"><span>Compute</span><strong>{ec2Instances.length}</strong></div>
                    <div className="vpc-summary-card"><span>Load balancers</span><strong>{loadBalancers.length}</strong></div>
                  </div>

                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Subnet inventory</span>
                        <h4>Subnets</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Subnet ID</th>
                            <th>CIDR</th>
                            <th>AZ</th>
                            <th>Avail IPs</th>
                            <th>Public IP</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {subnets.map((subnet) => (
                            <tr key={subnet.subnetId}>
                              <td>{subnet.name}</td>
                              <td className="vpc-mono">{subnet.subnetId}</td>
                              <td className="vpc-mono">{subnet.cidrBlock}</td>
                              <td>{subnet.availabilityZone}</td>
                              <td>{subnet.availableIpAddressCount}</td>
                              <td><span className={`vpc-status-badge ${subnet.mapPublicIpOnLaunch ? 'success' : 'info'}`}>{subnet.mapPublicIpOnLaunch ? 'Yes' : 'No'}</span></td>
                              <td>
                                <button
                                  type="button"
                                  className={`vpc-table-btn ${subnet.mapPublicIpOnLaunch ? 'danger' : 'success'}`}
                                  onClick={() => void handleSubnetTogglePublicIp(subnet.subnetId, subnet.mapPublicIpOnLaunch)}
                                >
                                  {subnet.mapPublicIpOnLaunch ? 'Disable' : 'Enable'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Routing surface</span>
                        <h4>Route tables</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>RT ID</th>
                            <th>Main</th>
                            <th>Subnets</th>
                            <th>Routes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {routeTables.map((routeTable) => (
                            <tr key={routeTable.routeTableId}>
                              <td>{routeTable.name}</td>
                              <td className="vpc-mono">{routeTable.routeTableId}</td>
                              <td><span className={`vpc-status-badge ${routeTable.isMain ? 'success' : 'info'}`}>{routeTable.isMain ? 'Yes' : 'No'}</span></td>
                              <td>{routeTable.associatedSubnets.length ? routeTable.associatedSubnets.join(', ') : '-'}</td>
                              <td className="vpc-table-detail">{routeTable.routes.map((route) => `${route.destination} -> ${route.target}`).join('; ')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </>
              )}

              {tab === 'flow' && (
                <section className="vpc-section">
                  <div className="vpc-section-head">
                    <div>
                      <span className="vpc-section-kicker">Diagram</span>
                      <h4>VPC architecture</h4>
                    </div>
                    <p>{subnets.length} subnets | {igws.length} IGWs | {nats.length} NATs | {routeTables.length} route tables | {ec2Instances.length} EC2 instances | {loadBalancers.length} load balancers | Click any resource to navigate.</p>
                  </div>
                  <VpcArchitectureDiagram
                    vpc={selectedVpc}
                    subnets={subnets}
                    igws={igws}
                    nats={nats}
                    routeTables={routeTables}
                    enis={enis}
                    ec2Instances={ec2Instances}
                    loadBalancers={loadBalancers}
                    onNavigate={onNavigate}
                    onSwitchTab={setTab}
                  />
                </section>
              )}

              {tab === 'reachability' && (
                <>
                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Path analysis</span>
                        <h4>Create reachability path</h4>
                      </div>
                    </div>
                    <div className="vpc-form-grid">
                      <label className="vpc-field">
                        <span>Source</span>
                        <input value={reachSrc} onChange={(event) => setReachSrc(event.target.value)} placeholder="eni-... or i-..." />
                      </label>
                      <label className="vpc-field">
                        <span>Destination</span>
                        <input value={reachDest} onChange={(event) => setReachDest(event.target.value)} placeholder="eni-... or i-..." />
                      </label>
                      <label className="vpc-field">
                        <span>Protocol</span>
                        <select value={reachProto} onChange={(event) => setReachProto(event.target.value)}>
                          <option value="tcp">TCP</option>
                          <option value="udp">UDP</option>
                        </select>
                      </label>
                    </div>
                    <div className="vpc-action-row">
                      <button type="button" className="vpc-toolbar-btn accent" disabled={loading || !reachSrc || !reachDest} onClick={() => void handleReachRun()}>
                        {loading ? 'Running...' : 'Analyze'}
                      </button>
                    </div>
                  </section>

                  {reachResults.length > 0 && (
                    <section className="vpc-section">
                      <div className="vpc-section-head">
                        <div>
                          <span className="vpc-section-kicker">Analysis history</span>
                          <h4>Results</h4>
                        </div>
                      </div>
                      <div className="vpc-table-wrap">
                        <table className="vpc-table">
                          <thead>
                            <tr>
                              <th>ID</th>
                              <th>Status</th>
                              <th>Reachable</th>
                              <th>Source</th>
                              <th>Dest</th>
                              <th>Explanations</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {reachResults.map((result) => (
                              <tr key={result.analysisId}>
                                <td className="vpc-mono">{result.analysisId.slice(0, 18)}..</td>
                                <td><span className={`vpc-status-badge ${result.status === 'succeeded' ? 'success' : result.status === 'failed' ? 'danger' : 'warning'}`}>{result.status}</span></td>
                                <td>{result.reachable === null ? '-' : <span className={`vpc-status-badge ${result.reachable ? 'success' : 'danger'}`}>{result.reachable ? 'Yes' : 'No'}</span>}</td>
                                <td className="vpc-mono">{result.source.slice(0, 20)}</td>
                                <td className="vpc-mono">{result.destination.slice(0, 20)}</td>
                                <td className="vpc-table-detail">{result.explanations.length ? result.explanations.join('; ') : '-'}</td>
                                <td><button type="button" className="vpc-table-btn muted" onClick={() => void handleReachRefresh(result.analysisId)}>Refresh</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                </>
              )}

              {tab === 'gateways' && (
                <div className="vpc-section-stack">
                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Ingress edge</span>
                        <h4>Internet gateways ({igws.length})</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>IGW ID</th>
                            <th>State</th>
                            <th>VPC</th>
                          </tr>
                        </thead>
                        <tbody>
                          {igws.map((gateway) => (
                            <tr key={gateway.igwId} className="vpc-row-clickable" onClick={() => onNavigate('vpc', gateway.attachedVpcId)}>
                              <td>{gateway.name}</td>
                              <td className="vpc-mono">{gateway.igwId}</td>
                              <td><span className={`vpc-status-badge ${gateway.state === 'attached' ? 'success' : 'info'}`}>{gateway.state}</span></td>
                              <td className="vpc-mono">{gateway.attachedVpcId}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!igws.length && <SvcState variant="empty" resourceName="internet gateways" compact />}
                  </section>

                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Egress edge</span>
                        <h4>NAT gateways ({nats.length})</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>NAT ID</th>
                            <th>State</th>
                            <th>Subnet</th>
                            <th>Public IP</th>
                            <th>Type</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nats.map((nat) => (
                            <tr key={nat.natGatewayId}>
                              <td>{nat.name}</td>
                              <td className="vpc-mono">{nat.natGatewayId}</td>
                              <td><span className={`vpc-status-badge ${nat.state === 'available' ? 'success' : nat.state === 'pending' ? 'warning' : 'info'}`}>{nat.state}</span></td>
                              <td className="vpc-mono">{nat.subnetId}</td>
                              <td>{nat.publicIp}</td>
                              <td>{nat.connectivityType}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!nats.length && <SvcState variant="empty" resourceName="NAT gateways" compact />}
                  </section>

                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Transit fabric</span>
                        <h4>Transit gateways ({tgws.length})</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>TGW ID</th>
                            <th>State</th>
                            <th>Owner</th>
                            <th>ASN</th>
                            <th>Description</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tgws.map((gateway) => (
                            <tr key={gateway.tgwId}>
                              <td>{gateway.name}</td>
                              <td className="vpc-mono">{gateway.tgwId}</td>
                              <td><span className={`vpc-status-badge ${gateway.state === 'available' ? 'success' : 'warning'}`}>{gateway.state}</span></td>
                              <td>{gateway.ownerId}</td>
                              <td>{gateway.amazonSideAsn}</td>
                              <td>{gateway.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!tgws.length && <SvcState variant="empty" resourceName="transit gateways" compact />}
                  </section>
                </div>
              )}

              {tab === 'interfaces' && (
                <section className="vpc-section">
                  <div className="vpc-section-head">
                    <div>
                      <span className="vpc-section-kicker">Network surface</span>
                      <h4>Network interfaces ({enis.length})</h4>
                    </div>
                  </div>
                  <div className="vpc-table-wrap">
                    <table className="vpc-table">
                      <thead>
                        <tr>
                          <th>ENI ID</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Subnet</th>
                          <th>Private IP</th>
                          <th>Public IP</th>
                          <th>Instance</th>
                          <th>SGs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enis.map((eni) => (
                          <tr key={eni.networkInterfaceId}>
                            <td className="vpc-mono">{eni.networkInterfaceId}</td>
                            <td>{eni.interfaceType}</td>
                            <td><span className={`vpc-status-badge ${eni.status === 'in-use' ? 'success' : eni.status === 'available' ? 'warning' : 'info'}`}>{eni.status}</span></td>
                            <td className="vpc-mono vpc-linkish" onClick={() => onNavigate('vpc', eni.subnetId)}>{eni.subnetId}</td>
                            <td>{eni.privateIp}</td>
                            <td>{eni.publicIp}</td>
                            <td className={`vpc-mono ${eni.attachedInstanceId !== '-' ? 'vpc-linkish' : ''}`} onClick={() => eni.attachedInstanceId !== '-' && onNavigate('ec2', eni.attachedInstanceId)}>{eni.attachedInstanceId}</td>
                            <td className="vpc-table-detail">{eni.securityGroups.map((securityGroup) => securityGroup.name).join(', ') || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!enis.length && <SvcState variant="empty" resourceName="ENIs" compact />}
                </section>
              )}
            </>
          )}
        </section>
      </div>

      {loading && !topology && <SvcState variant="loading" message={isSwitchingVpc ? 'Switching VPC...' : undefined} resourceName="VPC data" />}
    </div>
  )
}
