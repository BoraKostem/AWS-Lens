import { useEffect, useMemo, useState } from 'react'

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

  if (!vpc) return <div className="svc-empty">Select a VPC to view the architecture diagram.</div>

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

export function VpcWorkspace({ connection, onNavigate }: { connection: AwsConnection; onNavigate: (service: string, resourceId?: string) => void }) {
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

  const selectedVpc = useMemo(() => vpcs.find(v => v.vpcId === selectedVpcId) ?? null, [vpcs, selectedVpcId])

  async function loadVpcs() {
    setLoading(true); setError('')
    try { const list = await listVpcs(connection); setVpcs(list); if (list.length && !selectedVpcId) setSelectedVpcId(list[0].vpcId) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  async function loadVpcData(vpcId: string) {
    if (!vpcId) return; setLoading(true); setError('')
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
      setTopology(topo); setSubnets(sl); setRouteTables(rl); setIgws(il); setNats(nl); setTgws(tl); setEnis(el)
      setEc2Instances(allInstances.filter(i => i.vpcId === vpcId))
      setLoadBalancers(allLbs.filter(lb => lb.summary.vpcId === vpcId))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  useEffect(() => { void loadVpcs() }, [])
  useEffect(() => { if (selectedVpcId) void loadVpcData(selectedVpcId) }, [selectedVpcId])

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
    <div className="svc-console">
      <div className="svc-tab-bar">
        {TABS.map(t => <button key={t.id} className={`svc-tab ${t.id === tab ? 'active' : ''}`} type="button" onClick={() => setTab(t.id)}>{t.label}</button>)}
        <button className="svc-tab right" type="button" onClick={() => selectedVpcId && void loadVpcData(selectedVpcId)} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>
      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}
      <div className="svc-filter-bar">
        <span className="svc-filter-label">VPC</span>
        <select className="svc-select" value={selectedVpcId} onChange={e => setSelectedVpcId(e.target.value)}>
          {vpcs.map(v => <option key={v.vpcId} value={v.vpcId}>{v.name !== '-' ? v.name : v.vpcId} ({v.cidrBlock}){v.isDefault ? ' [default]' : ''}</option>)}
        </select>
        {selectedVpc && <span style={{ fontSize: 11, color: '#9ca7b7', fontFamily: 'monospace' }}>{selectedVpc.vpcId} | {selectedVpc.state}</span>}
      </div>

      {tab === 'topology' && topology && (<>
        <div className="svc-stat-strip">
          <div className="svc-stat-card"><span>Subnets</span><strong>{topology.subnets.length}</strong></div>
          <div className="svc-stat-card"><span>Route Tables</span><strong>{topology.routeTables.length}</strong></div>
          <div className="svc-stat-card"><span>IGWs</span><strong>{topology.internetGateways.length}</strong></div>
          <div className="svc-stat-card"><span>NAT GWs</span><strong>{topology.natGateways.length}</strong></div>
          <div className="svc-stat-card"><span>EC2</span><strong>{ec2Instances.length}</strong></div>
          <div className="svc-stat-card"><span>LBs</span><strong>{loadBalancers.length}</strong></div>
        </div>
        <div className="svc-panel"><h3>Subnets</h3>
          <table className="svc-table"><thead><tr><th>Name</th><th>Subnet ID</th><th>CIDR</th><th>AZ</th><th>Avail IPs</th><th>Public IP</th><th>Action</th></tr></thead>
            <tbody>{subnets.map(s => <tr key={s.subnetId}><td>{s.name}</td><td style={{ fontFamily: 'monospace' }}>{s.subnetId}</td><td style={{ fontFamily: 'monospace' }}>{s.cidrBlock}</td><td>{s.availabilityZone}</td><td>{s.availableIpAddressCount}</td><td><span className={`svc-badge ${s.mapPublicIpOnLaunch ? 'ok' : 'muted'}`}>{s.mapPublicIpOnLaunch ? 'Yes' : 'No'}</span></td><td><button type="button" className={`svc-btn ${s.mapPublicIpOnLaunch ? 'danger' : 'success'}`} style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => void handleSubnetTogglePublicIp(s.subnetId, s.mapPublicIpOnLaunch)}>{s.mapPublicIpOnLaunch ? 'Disable' : 'Enable'}</button></td></tr>)}</tbody></table>
        </div>
        <div className="svc-panel"><h3>Route Tables</h3>
          <table className="svc-table"><thead><tr><th>Name</th><th>RT ID</th><th>Main</th><th>Subnets</th><th>Routes</th></tr></thead>
            <tbody>{routeTables.map(rt => <tr key={rt.routeTableId}><td>{rt.name}</td><td style={{ fontFamily: 'monospace' }}>{rt.routeTableId}</td><td><span className={`svc-badge ${rt.isMain ? 'ok' : 'muted'}`}>{rt.isMain ? 'Yes' : 'No'}</span></td><td>{rt.associatedSubnets.length ? rt.associatedSubnets.join(', ') : '-'}</td><td style={{ fontSize: 11, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{rt.routes.map(r => `${r.destination} \u2192 ${r.target}`).join('; ')}</td></tr>)}</tbody></table>
        </div>
      </>)}

      {tab === 'flow' && (
        <div className="svc-panel">
          <h3>VPC Architecture</h3>
          <p style={{ fontSize: 11, color: '#9ca7b7', margin: '0 0 12px' }}>
            {subnets.length} subnets · {igws.length} IGWs · {nats.length} NATs · {routeTables.length} route tables
            · {ec2Instances.length} EC2 instances · {loadBalancers.length} load balancers
            {' · '}Click any resource to navigate.
          </p>
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
        </div>
      )}

      {tab === 'reachability' && (<>
        <div className="svc-panel"><h3>Create Reachability Path</h3>
          <div className="svc-form">
            <label><span>Source</span><input value={reachSrc} onChange={e => setReachSrc(e.target.value)} placeholder="eni-... or i-..." /></label>
            <label><span>Destination</span><input value={reachDest} onChange={e => setReachDest(e.target.value)} placeholder="eni-... or i-..." /></label>
            <label><span>Protocol</span><select value={reachProto} onChange={e => setReachProto(e.target.value)}><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>
          </div>
          <button type="button" className="svc-btn primary" disabled={loading || !reachSrc || !reachDest} onClick={() => void handleReachRun()}>{loading ? 'Running...' : 'Analyze'}</button>
        </div>
        {reachResults.length > 0 && <div className="svc-panel"><h3>Results</h3>
          <table className="svc-table"><thead><tr><th>ID</th><th>Status</th><th>Reachable</th><th>Source</th><th>Dest</th><th>Explanations</th><th></th></tr></thead>
            <tbody>{reachResults.map(r => <tr key={r.analysisId}><td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.analysisId.slice(0, 18)}..</td><td><span className={`svc-badge ${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn'}`}>{r.status}</span></td><td>{r.reachable === null ? '-' : r.reachable ? <span className="svc-badge ok">Yes</span> : <span className="svc-badge danger">No</span>}</td><td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.source.slice(0, 20)}</td><td style={{ fontFamily: 'monospace', fontSize: 11 }}>{r.destination.slice(0, 20)}</td><td style={{ fontSize: 11 }}>{r.explanations.length ? r.explanations.join('; ') : '-'}</td><td><button type="button" className="svc-btn muted" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => void handleReachRefresh(r.analysisId)}>Refresh</button></td></tr>)}</tbody></table>
        </div>}
      </>)}

      {tab === 'gateways' && (<>
        <div className="svc-panel"><h3>Internet Gateways ({igws.length})</h3><table className="svc-table"><thead><tr><th>Name</th><th>IGW ID</th><th>State</th><th>VPC</th></tr></thead><tbody>{igws.map(g => <tr key={g.igwId} style={{ cursor: 'pointer' }} onClick={() => onNavigate('vpc', g.attachedVpcId)}><td>{g.name}</td><td style={{ fontFamily: 'monospace' }}>{g.igwId}</td><td><span className={`svc-badge ${g.state === 'attached' ? 'ok' : 'muted'}`}>{g.state}</span></td><td style={{ fontFamily: 'monospace' }}>{g.attachedVpcId}</td></tr>)}</tbody></table>{!igws.length && <div className="svc-empty">None found.</div>}</div>
        <div className="svc-panel"><h3>NAT Gateways ({nats.length})</h3><table className="svc-table"><thead><tr><th>Name</th><th>NAT ID</th><th>State</th><th>Subnet</th><th>Public IP</th><th>Type</th></tr></thead><tbody>{nats.map(n => <tr key={n.natGatewayId}><td>{n.name}</td><td style={{ fontFamily: 'monospace' }}>{n.natGatewayId}</td><td><span className={`svc-badge ${n.state === 'available' ? 'ok' : n.state === 'pending' ? 'warn' : 'muted'}`}>{n.state}</span></td><td style={{ fontFamily: 'monospace' }}>{n.subnetId}</td><td>{n.publicIp}</td><td>{n.connectivityType}</td></tr>)}</tbody></table>{!nats.length && <div className="svc-empty">None found.</div>}</div>
        <div className="svc-panel"><h3>Transit Gateways ({tgws.length})</h3><table className="svc-table"><thead><tr><th>Name</th><th>TGW ID</th><th>State</th><th>Owner</th><th>ASN</th><th>Desc</th></tr></thead><tbody>{tgws.map(t => <tr key={t.tgwId}><td>{t.name}</td><td style={{ fontFamily: 'monospace' }}>{t.tgwId}</td><td><span className={`svc-badge ${t.state === 'available' ? 'ok' : 'warn'}`}>{t.state}</span></td><td>{t.ownerId}</td><td>{t.amazonSideAsn}</td><td>{t.description}</td></tr>)}</tbody></table>{!tgws.length && <div className="svc-empty">None found.</div>}</div>
      </>)}

      {tab === 'interfaces' && <div className="svc-panel"><h3>Network Interfaces ({enis.length})</h3>
        <table className="svc-table"><thead><tr><th>ENI ID</th><th>Type</th><th>Status</th><th>Subnet</th><th>Private IP</th><th>Public IP</th><th>Instance</th><th>SGs</th></tr></thead>
          <tbody>{enis.map(e => <tr key={e.networkInterfaceId}><td style={{ fontFamily: 'monospace' }}>{e.networkInterfaceId}</td><td>{e.interfaceType}</td><td><span className={`svc-badge ${e.status === 'in-use' ? 'ok' : e.status === 'available' ? 'warn' : 'muted'}`}>{e.status}</span></td><td style={{ fontFamily: 'monospace', cursor: 'pointer', color: '#60a5fa' }} onClick={() => onNavigate('vpc', e.subnetId)}>{e.subnetId}</td><td>{e.privateIp}</td><td>{e.publicIp}</td><td style={{ fontFamily: 'monospace', cursor: e.attachedInstanceId !== '-' ? 'pointer' : 'default', color: e.attachedInstanceId !== '-' ? '#60a5fa' : undefined }} onClick={() => e.attachedInstanceId !== '-' && onNavigate('ec2', e.attachedInstanceId)}>{e.attachedInstanceId}</td><td style={{ fontSize: 11 }}>{e.securityGroups.map(sg => sg.name).join(', ') || '-'}</td></tr>)}</tbody></table>
        {!enis.length && <div className="svc-empty">No ENIs found.</div>}
      </div>}

      {loading && !topology && <div className="svc-empty">Loading VPC data...</div>}
    </div>
  )
}
