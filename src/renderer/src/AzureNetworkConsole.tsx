import { useEffect, useMemo, useState } from 'react'
import './vpc.css'

import type {
  AzureMonitorActivityEvent,
  AzureNetworkOverview,
  AzureVNetSummary,
  AzureSubnetSummary,
  AzureNsgSummary,
  AzureNsgRuleSummary,
  AzurePublicIpSummary,
  AzureNetworkInterfaceSummary,
  AzureVNetPeeringSummary,
  AzureRouteTableSummary,
  AzureNatGatewaySummary,
  AzureLoadBalancerSummary,
  AzurePrivateEndpointSummary
} from '@shared/types'
import {
  getAzureNetworkOverview,
  listAzureMonitorActivity,
  listAzureVNetSubnets,
  listAzureNsgRules,
  listAzureVNetPeerings,
  listAzureRouteTables,
  listAzureNatGateways,
  listAzureLoadBalancers,
  listAzurePrivateEndpoints
} from './api'
import { SvcState } from './SvcState'

type NetworkTab = 'architecture' | 'vnets' | 'nsgs' | 'publicIps' | 'nics' | 'routeTables' | 'natGateways' | 'loadBalancers' | 'privateEndpoints' | 'activity'

const TABS: Array<{ id: NetworkTab; label: string }> = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'vnets', label: 'VNets' },
  { id: 'nsgs', label: 'NSGs' },
  { id: 'publicIps', label: 'Public IPs' },
  { id: 'nics', label: 'NICs' },
  { id: 'routeTables', label: 'Route Tables' },
  { id: 'natGateways', label: 'NAT Gateways' },
  { id: 'loadBalancers', label: 'Load Balancers' },
  { id: 'privateEndpoints', label: 'Private Endpoints' },
  { id: 'activity', label: 'Activity Log' },
]

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatLocationHint(location: string): string {
  return location.trim() || 'all visible locations'
}

function networkStatusTone(state: string): 'success' | 'warning' | 'danger' | 'info' {
  const l = state.toLowerCase()
  if (l === 'succeeded' || l === 'available' || l === 'active') return 'success'
  if (l === 'creating' || l === 'updating' || l === 'provisioning') return 'warning'
  if (l === 'failed' || l === 'deleting') return 'danger'
  return 'info'
}

function badgeClass(tone: 'success' | 'warning' | 'danger' | 'info'): string {
  if (tone === 'success') return 'ok'
  if (tone === 'warning') return 'warn'
  if (tone === 'danger') return 'danger'
  return ''
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s
}

/* ── Azure VNet Architecture Diagram ─────────────────────────── */

const AZ_STATE_COLORS: Record<string, string> = {
  Succeeded: '#34d399',
  Failed: '#f87171',
  Updating: '#fbbf24',
  Creating: '#fbbf24',
  Deleting: '#fb923c',
}

function delegationServiceId(delegation: string): { label: string; serviceId: string } | null {
  const d = delegation.toLowerCase()
  if (d.includes('containerservice') || d.includes('managedclusters')) return { label: 'AKS', serviceId: 'azure-aks' }
  if (d.includes('dbforpostgresql')) return { label: 'PgSQL', serviceId: 'azure-postgresql' }
  if (d.includes('dbformysql')) return { label: 'MySQL', serviceId: 'azure-sql' }
  if (d.includes('sql/managedinstances')) return { label: 'SQL MI', serviceId: 'azure-sql' }
  if (d.includes('web/serverfarms') || d.includes('web/hostingenvironments')) return { label: 'App Svc', serviceId: 'azure-app-service' }
  return null
}

function AzureVNetArchitectureDiagram({
  vnet,
  subnets,
  networkInterfaces,
  publicIps,
  nsgs,
  onSwitchTab,
  onNavigate,
}: {
  vnet: AzureVNetSummary | null
  subnets: AzureSubnetSummary[]
  networkInterfaces: AzureNetworkInterfaceSummary[]
  publicIps: AzurePublicIpSummary[]
  nsgs: AzureNsgSummary[]
  onSwitchTab: (tab: NetworkTab) => void
  onNavigate: (serviceId: string) => void
}) {
  // NICs belonging to this VNet, grouped by subnet
  const nicsBySubnet = useMemo(() => {
    if (!vnet) return new Map<string, AzureNetworkInterfaceSummary[]>()
    const map = new Map<string, AzureNetworkInterfaceSummary[]>()
    for (const nic of networkInterfaces) {
      if (nic.vnetName === vnet.name) {
        const list = map.get(nic.subnetName) ?? []
        list.push(nic)
        map.set(nic.subnetName, list)
      }
    }
    return map
  }, [vnet, networkInterfaces])

  // Public IPs associated with NICs in this VNet
  const vnetPublicIps = useMemo(() => {
    if (!vnet) return [] as AzurePublicIpSummary[]
    const nicPubIps = new Set<string>()
    for (const nic of networkInterfaces) {
      if (nic.vnetName === vnet.name && nic.publicIp) nicPubIps.add(nic.publicIp)
    }
    return publicIps.filter((pip) => pip.ipAddress && nicPubIps.has(pip.ipAddress))
  }, [vnet, networkInterfaces, publicIps])

  // Unique NAT gateways
  const natGateways = useMemo(
    () => [...new Set(subnets.map((s) => s.natGatewayName).filter(Boolean))],
    [subnets]
  )

  // Unique route tables
  const routeTableNames = useMemo(
    () => [...new Set(subnets.map((s) => s.routeTableName).filter(Boolean))],
    [subnets]
  )

  // NSG lookup
  const nsgMap = useMemo(() => {
    const m = new Map<string, AzureNsgSummary>()
    for (const n of nsgs) m.set(n.name, n)
    return m
  }, [nsgs])

  if (!vnet) return <SvcState variant="no-selection" resourceName="VNet" message="Select a VNet to view the architecture diagram." />

  const tr = (s: string, n: number) => (s.length > n ? s.slice(0, n - 2) + '..' : s)

  // Layout constants
  const MAX_SHOW = 4
  const RESOURCE_ROW_H = 18
  const SUBNET_HEADER_H = 55
  const SUBNET_W = 220
  const SUBNET_GAP = 20
  const COLS_PER_ROW = Math.min(Math.max(subnets.length, 1), 4)

  // Compute max resources for uniform subnet height
  const allSubnetResourceCounts = subnets.map((s) => {
    const nicCount = nicsBySubnet.get(s.name)?.length ?? 0
    if (nicCount > 0) return nicCount
    // Count delegation-based resources for subnets with no NICs
    return s.delegations.filter((d) => delegationServiceId(d) !== null).length
  })
  const maxResources = Math.min(Math.max(0, ...allSubnetResourceCounts), MAX_SHOW)
  const anyOverflow = allSubnetResourceCounts.some((c) => c > MAX_SHOW)
  const resourceAreaH = maxResources > 0 ? 8 + maxResources * RESOURCE_ROW_H + (anyOverflow ? RESOURCE_ROW_H : 0) : 0
  const SUBNET_H = SUBNET_HEADER_H + resourceAreaH

  const subnetRows = Math.ceil(Math.max(subnets.length, 1) / COLS_PER_ROW)
  const gridW = COLS_PER_ROW * SUBNET_W + (COLS_PER_ROW - 1) * SUBNET_GAP
  const W = Math.max(gridW + 180, 720)
  const CX = W / 2

  // Sequential Y layout
  let y = 14
  const INTERNET_H = 34
  const internetCY = y + INTERNET_H / 2
  y += INTERNET_H + 8

  const arrowGap = 28
  y += arrowGap

  // Public IPs row
  const PIP_H = 36
  const pipCY = y + PIP_H / 2
  y += PIP_H + 8
  y += arrowGap

  // VNet container
  const vnetTop = y
  y += 10

  // VNet title
  y += 24

  // Subnet grid
  const subnetStartY = y
  const subnetAreaH = subnetRows * SUBNET_H + (subnetRows - 1) * SUBNET_GAP
  y += subnetAreaH + 18

  // NAT gateways
  const NAT_H = 32
  let natCY = 0
  if (natGateways.length > 0) {
    natCY = y + NAT_H / 2
    y += NAT_H + 18
  }

  // Connection gap
  y += 12

  // Route tables
  const RT_H = 32
  const rtCY = y + RT_H / 2
  y += RT_H + 18

  const vnetBottom = y
  const H = vnetBottom + 14

  // Subnet grid positions
  const gridStartX = CX - gridW / 2
  const getSubnetX = (i: number) => gridStartX + (i % COLS_PER_ROW) * (SUBNET_W + SUBNET_GAP)
  const getSubnetY = (i: number) => subnetStartY + Math.floor(i / COLS_PER_ROW) * (SUBNET_H + SUBNET_GAP)
  const getSubnetCX = (i: number) => getSubnetX(i) + SUBNET_W / 2

  // Route table positions
  const rtCount = Math.max(routeTableNames.length, 1)
  const rtSpacing = Math.min(300, (W - 200) / rtCount)
  const rtStartX = CX - ((rtCount - 1) * rtSpacing) / 2
  const getRtCX = (i: number) => rtStartX + i * rtSpacing

  // NAT positions
  const natSpacing = Math.min(280, (W - 200) / Math.max(natGateways.length, 1))
  const natStartX = CX - ((natGateways.length - 1) * natSpacing) / 2
  const getNatCX = (i: number) => natStartX + i * natSpacing

  // Public IP positions
  const pipCount = Math.max(vnetPublicIps.length, 1)
  const pipSpacing = Math.min(300, (W - 200) / pipCount)
  const pipStartX = CX - ((vnetPublicIps.length - 1) * pipSpacing) / 2
  const getPipCX = (i: number) => pipStartX + i * pipSpacing

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="vpc-arch-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="az-arch-arrow" markerWidth="8" markerHeight="6" refX="4" refY="6" orient="auto">
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

      {/* Arrow: Internet → Public IPs */}
      <line x1={CX} y1={internetCY + INTERNET_H / 2}
            x2={CX} y2={pipCY - PIP_H / 2}
            stroke="rgba(148,163,184,0.5)" strokeWidth={1.5} markerEnd="url(#az-arch-arrow)" />

      {/* ── Public IPs ────────────────────────── */}
      {vnetPublicIps.length > 0 ? vnetPublicIps.map((pip, i) => {
        const px = getPipCX(i)
        return (
          <g key={pip.id} className="vpc-arch-node vpc-arch-clickable" onClick={() => onSwitchTab('publicIps')}>
            <rect x={px - 140} y={pipCY - PIP_H / 2} width={280} height={PIP_H}
              rx={8} fill="rgba(0,120,212,0.12)" stroke="rgba(0,120,212,0.5)" strokeWidth={1.5} />
            <text x={px} y={pipCY - 2} textAnchor="middle" fill="#50a0e6" fontSize={11} fontWeight={700}>
              PIP: {tr(pip.name, 28)}
            </text>
            <text x={px} y={pipCY + 12} textAnchor="middle" fill="rgba(148,163,184,0.5)" fontSize={9}>
              {pip.ipAddress} · {pip.allocationMethod}
            </text>
          </g>
        )
      }) : (
        <text x={CX} y={pipCY + 4} textAnchor="middle" fill="rgba(148,163,184,0.35)" fontSize={11} fontStyle="italic">
          No Public IPs
        </text>
      )}

      {/* Arrow: Public IPs → VNet */}
      <line x1={CX} y1={pipCY + PIP_H / 2}
            x2={CX} y2={vnetTop}
            stroke="rgba(148,163,184,0.5)" strokeWidth={1.5} markerEnd="url(#az-arch-arrow)" />

      {/* ── VNet Container ────────────────────── */}
      <rect x={50} y={vnetTop} width={W - 100} height={vnetBottom - vnetTop}
        rx={6} fill="rgba(0,120,212,0.06)" stroke="rgba(56,139,253,0.45)" strokeWidth={2} />
      <text x={62} y={vnetTop + 18} fill="#388bfd" fontSize={13} fontWeight={700}>
        VNet: {vnet.name}
      </text>
      <text x={62} y={vnetTop + 33} fill="rgba(148,163,184,0.55)" fontSize={10}>
        {vnet.addressPrefixes.join(', ')}
      </text>

      {/* ── Subnets ───────────────────────────── */}
      {subnets.map((s, si) => {
        const sx = getSubnetX(si)
        const sy = getSubnetY(si)
        const nics = nicsBySubnet.get(s.name) ?? []
        const hasNsg = !!s.nsgName

        // Build unified resource list: NICs/VMs + delegation-based services
        type SubnetResource = { id: string; label: string; badge: string; color: string; onClick: () => void }
        const resources: SubnetResource[] = []

        for (const nic of nics) {
          const hasVm = !!nic.attachedVmName
          resources.push({
            id: nic.id,
            label: hasVm ? (nic.attachedVmName + ' · ' + nic.privateIp) : (nic.name + ' · ' + nic.privateIp),
            badge: hasVm ? 'VM' : 'NIC',
            color: '#388bfd',
            onClick: hasVm ? () => onNavigate('azure-virtual-machines') : () => onSwitchTab('nics'),
          })
        }

        // Show delegation-based resources when no NICs are present
        if (nics.length === 0) {
          for (const deleg of s.delegations) {
            const svc = delegationServiceId(deleg)
            if (svc) {
              resources.push({
                id: `deleg-${deleg}`,
                label: 'Managed by ' + svc.label,
                badge: svc.label,
                color: svc.label === 'AKS' ? '#326ce5' : svc.label === 'PgSQL' ? '#336791' : '#f59e0b',
                onClick: () => onNavigate(svc.serviceId),
              })
            }
          }
        }

        const visible = resources.slice(0, MAX_SHOW)
        const overflow = resources.length - MAX_SHOW

        return (
          <g key={s.id}>
            {/* Subnet box */}
            <g className="vpc-arch-clickable" onClick={() => onSwitchTab('vnets')}>
              <rect x={sx} y={sy} width={SUBNET_W} height={SUBNET_H}
                rx={6} fill="rgba(45,212,191,0.06)" stroke="rgba(45,212,191,0.45)" strokeWidth={1.5} />
              <text x={sx + 10} y={sy + 17} fill="#2dd4bf" fontSize={10.5} fontWeight={600}>
                {tr(s.name, 22)}
              </text>
              <text x={sx + 10} y={sy + 32} fill="rgba(148,163,184,0.65)" fontSize={10}>
                {s.addressPrefix}
              </text>
              {s.delegations.length > 0 && nics.length > 0 && (
                <text x={sx + 10} y={sy + 46} fill="rgba(148,163,184,0.4)" fontSize={9}>
                  {tr(s.delegations[0], 28)}
                </text>
              )}
            </g>

            {/* NSG badge */}
            {hasNsg && (
              <g className="vpc-arch-clickable" onClick={() => onSwitchTab('nsgs')}>
                <rect x={sx + SUBNET_W - 68} y={sy + 4} width={60} height={16}
                  rx={4} fill="rgba(168,85,247,0.15)" stroke="rgba(168,85,247,0.4)" strokeWidth={0.8} />
                <text x={sx + SUBNET_W - 38} y={sy + 15} textAnchor="middle" fill="#c084fc" fontSize={7.5} fontWeight={600}>
                  NSG
                </text>
              </g>
            )}

            {/* Resources separator */}
            {visible.length > 0 && (
              <line x1={sx + 8} y1={sy + SUBNET_HEADER_H}
                    x2={sx + SUBNET_W - 8} y2={sy + SUBNET_HEADER_H}
                    stroke="rgba(148,163,184,0.1)" strokeWidth={0.8} />
            )}

            {/* Resource rows */}
            {visible.map((res, ri) => {
              const ry = sy + SUBNET_HEADER_H + 6 + ri * RESOURCE_ROW_H
              const badgeW = res.badge.length * 6 + 8

              return (
                <g key={res.id} className="vpc-arch-clickable" onClick={res.onClick}>
                  {/* Type badge */}
                  <rect x={sx + 8} y={ry} width={badgeW} height={14}
                    rx={3} fill={res.color + '26'} stroke={res.color + '59'} strokeWidth={0.7} />
                  <text x={sx + 8 + badgeW / 2} y={ry + 10.5}
                    textAnchor="middle" fill={res.color} fontSize={7} fontWeight={700}>
                    {res.badge}
                  </text>
                  {/* Resource name */}
                  <text x={sx + 8 + badgeW + 6} y={ry + 10.5}
                    fill="#d1d5db" fontSize={9}>
                    {tr(res.label, 20)}
                  </text>
                </g>
              )
            })}
            {overflow > 0 && (
              <text x={sx + 10}
                y={sy + SUBNET_HEADER_H + 6 + visible.length * RESOURCE_ROW_H + 10}
                fill="rgba(148,163,184,0.4)" fontSize={8} fontStyle="italic">
                +{overflow} more
              </text>
            )}
          </g>
        )
      })}

      {/* ── NAT Gateways ──────────────────────── */}
      {natGateways.map((name, i) => {
        const nx = getNatCX(i)
        return (
          <g key={name} className="vpc-arch-clickable" onClick={() => onSwitchTab('vnets')}>
            <rect x={nx - 125} y={natCY - NAT_H / 2} width={250} height={NAT_H}
              rx={6} fill="rgba(249,115,22,0.08)" stroke="rgba(249,115,22,0.45)" strokeWidth={1.2} />
            <text x={nx} y={natCY + 4} textAnchor="middle" fill="#f97316" fontSize={10.5} fontWeight={600}>
              NAT: {tr(name, 28)}
            </text>
          </g>
        )
      })}

      {/* ── Connection lines: Subnets → Route Tables ─── */}
      {subnets.map((s, si) => {
        if (!s.routeTableName) return null
        const rtIdx = routeTableNames.indexOf(s.routeTableName)
        if (rtIdx < 0) return null

        const sx = getSubnetCX(si)
        const sy = getSubnetY(si) + SUBNET_H
        const rx = getRtCX(rtIdx)

        return (
          <line key={`${s.id}-rt`}
            x1={sx} y1={sy} x2={rx} y2={rtCY - RT_H / 2}
            stroke="rgba(148,163,184,0.18)" strokeWidth={1.2} strokeDasharray="5 3" />
        )
      })}

      {/* ── Route Tables ──────────────────────── */}
      {routeTableNames.map((name, i) => {
        const rx = getRtCX(i)
        return (
          <g key={name} className="vpc-arch-clickable" onClick={() => onSwitchTab('vnets')}>
            <rect x={rx - 145} y={rtCY - RT_H / 2} width={290} height={RT_H}
              rx={6} fill="rgba(100,116,139,0.12)" stroke="rgba(148,163,184,0.35)" strokeWidth={1.2} />
            <text x={rx} y={rtCY + 4} textAnchor="middle" fill="#94a3b8" fontSize={10.5} fontWeight={600}>
              RT: {tr(name, 30)}
            </text>
          </g>
        )
      })}

      {/* ── Empty states ──────────────────────── */}
      {subnets.length === 0 && (
        <text x={CX} y={subnetStartY + 30} textAnchor="middle" fill="rgba(148,163,184,0.3)" fontSize={12} fontStyle="italic">
          No subnets in this VNet
        </text>
      )}
      {routeTableNames.length === 0 && (
        <text x={CX} y={rtCY} textAnchor="middle" fill="rgba(148,163,184,0.3)" fontSize={12} fontStyle="italic">
          No route tables
        </text>
      )}
    </svg>
  )
}

export function AzureNetworkConsole({
  subscriptionId,
  location,
  refreshNonce,
  onRunTerminalCommand,
  canRunTerminalCommand,
  onOpenMonitor,
  onNavigate
}: {
  subscriptionId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
  canRunTerminalCommand: boolean
  onOpenMonitor: (query: string) => void
  onNavigate: (serviceId: string) => void
}): JSX.Element {
  const [overview, setOverview] = useState<AzureNetworkOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<NetworkTab>('architecture')
  const [selectedVNetId, setSelectedVNetId] = useState('')
  const [subnets, setSubnets] = useState<AzureSubnetSummary[]>([])
  const [subnetsLoading, setSubnetsLoading] = useState(false)
  const [selectedNsgId, setSelectedNsgId] = useState('')
  const [nsgRules, setNsgRules] = useState<AzureNsgRuleSummary[]>([])
  const [nsgRulesLoading, setNsgRulesLoading] = useState(false)
  const [searchFilter, setSearchFilter] = useState('')
  const [timelineEvents, setTimelineEvents] = useState<AzureMonitorActivityEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [routeTables, setRouteTables] = useState<AzureRouteTableSummary[]>([])
  const [routeTablesLoading, setRouteTablesLoading] = useState(false)
  const [natGateways, setNatGateways] = useState<AzureNatGatewaySummary[]>([])
  const [natGatewaysLoading, setNatGatewaysLoading] = useState(false)
  const [loadBalancers, setLoadBalancers] = useState<AzureLoadBalancerSummary[]>([])
  const [loadBalancersLoading, setLoadBalancersLoading] = useState(false)
  const [privateEndpoints, setPrivateEndpoints] = useState<AzurePrivateEndpointSummary[]>([])
  const [privateEndpointsLoading, setPrivateEndpointsLoading] = useState(false)
  const [peerings, setPeerings] = useState<AzureVNetPeeringSummary[]>([])
  const [peeringsLoading, setPeeringsLoading] = useState(false)

  /* ── Data fetching ─────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await getAzureNetworkOverview(subscriptionId, location)
        if (!cancelled) {
          setOverview(data)
          setSelectedVNetId('')
          setSubnets([])
          setSelectedNsgId('')
          setNsgRules([])
          setTimelineEvents([])
          setTimelineError('')
          setRouteTables([])
          setNatGateways([])
          setLoadBalancers([])
          setPrivateEndpoints([])
          setPeerings([])
        }
      } catch (err) {
        if (!cancelled) {
          setError(normalizeError(err))
          setOverview(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [subscriptionId, location, refreshNonce])

  /* ── Activity log ──────────────────────────────────────── */

  async function loadTimeline() {
    setTimelineLoading(true)
    setTimelineError('')
    try {
      const result = await listAzureMonitorActivity(subscriptionId, location, 'Microsoft.Network', 168)
      setTimelineEvents(result.events)
    } catch (err) {
      setTimelineEvents([])
      setTimelineError(normalizeError(err))
    } finally {
      setTimelineLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'activity') void loadTimeline()
  }, [activeTab, subscriptionId, location])

  /* ── Lazy-load new resource tabs ──────────────────────── */

  useEffect(() => {
    if (activeTab === 'routeTables' && routeTables.length === 0 && !routeTablesLoading) {
      setRouteTablesLoading(true)
      listAzureRouteTables(subscriptionId, location).then(setRouteTables).catch(() => {}).finally(() => setRouteTablesLoading(false))
    }
    if (activeTab === 'natGateways' && natGateways.length === 0 && !natGatewaysLoading) {
      setNatGatewaysLoading(true)
      listAzureNatGateways(subscriptionId, location).then(setNatGateways).catch(() => {}).finally(() => setNatGatewaysLoading(false))
    }
    if (activeTab === 'loadBalancers' && loadBalancers.length === 0 && !loadBalancersLoading) {
      setLoadBalancersLoading(true)
      listAzureLoadBalancers(subscriptionId, location).then(setLoadBalancers).catch(() => {}).finally(() => setLoadBalancersLoading(false))
    }
    if (activeTab === 'privateEndpoints' && privateEndpoints.length === 0 && !privateEndpointsLoading) {
      setPrivateEndpointsLoading(true)
      listAzurePrivateEndpoints(subscriptionId, location).then(setPrivateEndpoints).catch(() => {}).finally(() => setPrivateEndpointsLoading(false))
    }
  }, [activeTab, subscriptionId, location])

  /* ── Subnet drill-down ─────────────────────────────────── */

  useEffect(() => {
    if (!selectedVNetId || !overview) { setSubnets([]); return }
    const vnet = overview.vnets.find((v) => v.id === selectedVNetId)
    if (!vnet) return

    let cancelled = false
    async function loadSubnets() {
      setSubnetsLoading(true)
      try {
        const data = await listAzureVNetSubnets(subscriptionId, vnet!.resourceGroup, vnet!.name)
        if (!cancelled) setSubnets(data)
      } catch (err) {
        if (!cancelled) setSubnets([])
      } finally {
        if (!cancelled) setSubnetsLoading(false)
      }
    }

    void loadSubnets()
    return () => { cancelled = true }
  }, [selectedVNetId, overview, subscriptionId])

  /* ── Peerings for selected VNet ───────────────────────── */

  useEffect(() => {
    if (!selectedVNetId || !overview) { setPeerings([]); return }
    const vnet = overview.vnets.find((v) => v.id === selectedVNetId)
    if (vnet && activeTab === 'vnets') {
      setPeeringsLoading(true)
      listAzureVNetPeerings(subscriptionId, vnet.resourceGroup, vnet.name)
        .then(setPeerings).catch(() => setPeerings([])).finally(() => setPeeringsLoading(false))
    }
  }, [selectedVNetId, activeTab])

  /* ── NSG rules drill-down ──────────────────────────────── */

  useEffect(() => {
    if (!selectedNsgId || !overview) { setNsgRules([]); return }
    const nsg = overview.nsgs.find((n) => n.id === selectedNsgId)
    if (!nsg) return

    let cancelled = false
    async function loadRules() {
      setNsgRulesLoading(true)
      try {
        const data = await listAzureNsgRules(subscriptionId, nsg!.resourceGroup, nsg!.name)
        if (!cancelled) setNsgRules(data)
      } catch (err) {
        if (!cancelled) setNsgRules([])
      } finally {
        if (!cancelled) setNsgRulesLoading(false)
      }
    }

    void loadRules()
    return () => { cancelled = true }
  }, [selectedNsgId, overview, subscriptionId])

  /* ── Filtered lists ────────────────────────────────────── */

  const filteredVnets = useMemo(() => {
    if (!overview) return []
    if (!searchFilter) return overview.vnets
    const q = searchFilter.toLowerCase()
    return overview.vnets.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      v.resourceGroup.toLowerCase().includes(q) ||
      v.addressPrefixes.join(' ').toLowerCase().includes(q) ||
      v.provisioningState.toLowerCase().includes(q)
    )
  }, [overview, searchFilter])

  const filteredNsgs = useMemo(() => {
    if (!overview) return []
    if (!searchFilter) return overview.nsgs
    const q = searchFilter.toLowerCase()
    return overview.nsgs.filter((n) =>
      n.name.toLowerCase().includes(q) ||
      n.resourceGroup.toLowerCase().includes(q) ||
      n.provisioningState.toLowerCase().includes(q)
    )
  }, [overview, searchFilter])

  const filteredPublicIps = useMemo(() => {
    if (!overview) return []
    if (!searchFilter) return overview.publicIps
    const q = searchFilter.toLowerCase()
    return overview.publicIps.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.resourceGroup.toLowerCase().includes(q) ||
      p.ipAddress.toLowerCase().includes(q) ||
      p.associatedResourceName.toLowerCase().includes(q) ||
      p.dnsLabel.toLowerCase().includes(q)
    )
  }, [overview, searchFilter])

  const filteredNics = useMemo(() => {
    if (!overview) return []
    if (!searchFilter) return overview.networkInterfaces
    const q = searchFilter.toLowerCase()
    return overview.networkInterfaces.filter((n) =>
      n.name.toLowerCase().includes(q) ||
      n.resourceGroup.toLowerCase().includes(q) ||
      n.privateIp.toLowerCase().includes(q) ||
      n.vnetName.toLowerCase().includes(q) ||
      n.subnetName.toLowerCase().includes(q) ||
      n.attachedVmName.toLowerCase().includes(q)
    )
  }, [overview, searchFilter])

  /* ── Counts ────────────────────────────────────────────── */

  const vnetCount = overview?.vnets.length ?? 0
  const nsgCount = overview?.nsgs.length ?? 0
  const publicIpCount = overview?.publicIps.length ?? 0
  const nicCount = overview?.networkInterfaces.length ?? 0
  const routeTableCount = overview?.routeTables.length ?? 0
  const lbCount = overview?.loadBalancers.length ?? 0
  const natGwCount = overview?.natGateways.length ?? 0
  const peCount = overview?.privateEndpoints.length ?? 0

  /* ── Early states ──────────────────────────────────────── */

  if (loading && !overview) return <SvcState variant="loading" resourceName="Azure Network resources" />

  /* ── Render ────────────────────────────────────────────── */

  return (
    <div className="vpc-console azure-network-theme">
      {/* ── Hero section ────────────────────────────────── */}
      <section className="vpc-shell-hero">
        <div className="vpc-shell-hero-copy">
          <div className="eyebrow">Azure Network</div>
          <h2>Virtual network posture</h2>
          <p>
            Inspect virtual networks, security groups, public IPs, and network interfaces across
            your Azure subscription. Drill into subnets and NSG rules for deeper analysis.
          </p>
          <div className="vpc-shell-meta-strip">
            <div className="vpc-shell-meta-pill">
              <span>Provider</span>
              <strong>Azure</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Subscription</span>
              <strong>{trunc(subscriptionId, 28)}</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Location</span>
              <strong>{formatLocationHint(location)}</strong>
            </div>
          </div>
        </div>
        <div className="vpc-shell-hero-stats">
          <div className={`vpc-shell-status-card ${vnetCount > 0 ? 'success' : ''}`}>
            <span>VNets</span>
            <strong>{vnetCount}</strong>
            <small>{vnetCount === 1 ? '1 virtual network' : `${vnetCount} virtual networks`}</small>
          </div>
          <div className={`vpc-shell-status-card ${nsgCount > 0 ? 'success' : ''}`}>
            <span>NSGs</span>
            <strong>{nsgCount}</strong>
            <small>{nsgCount === 1 ? '1 security group' : `${nsgCount} security groups`}</small>
          </div>
          <div className={`vpc-shell-status-card ${publicIpCount > 0 ? 'info' : ''}`}>
            <span>Public IPs</span>
            <strong>{publicIpCount}</strong>
            <small>{publicIpCount === 1 ? '1 public address' : `${publicIpCount} public addresses`}</small>
          </div>
          <div className={`vpc-shell-status-card`}>
            <span>NICs</span>
            <strong>{nicCount}</strong>
            <small>{nicCount === 1 ? '1 interface' : `${nicCount} interfaces`}</small>
          </div>
          <div className={`vpc-shell-status-card`}>
            <span>Route Tables</span>
            <strong>{routeTableCount}</strong>
            <small>{routeTableCount === 1 ? '1 route table' : `${routeTableCount} route tables`}</small>
          </div>
          <div className={`vpc-shell-status-card`}>
            <span>NAT GWs</span>
            <strong>{natGwCount}</strong>
            <small>{natGwCount === 1 ? '1 NAT gateway' : `${natGwCount} NAT gateways`}</small>
          </div>
          <div className={`vpc-shell-status-card`}>
            <span>Load Balancers</span>
            <strong>{lbCount}</strong>
            <small>{lbCount === 1 ? '1 load balancer' : `${lbCount} load balancers`}</small>
          </div>
          <div className={`vpc-shell-status-card`}>
            <span>Private Endpoints</span>
            <strong>{peCount}</strong>
            <small>{peCount === 1 ? '1 endpoint' : `${peCount} endpoints`}</small>
          </div>
        </div>
      </section>

      {/* ── Tab bar ─────────────────────────────────────── */}
      <div className="vpc-toolbar">
        <div className="vpc-tab-bar" style={{ display: 'flex', gap: 4, flex: 1 }}>
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`vpc-toolbar-tab ${item.id === activeTab ? 'active' : ''}`}
              type="button"
              onClick={() => { setActiveTab(item.id); setSearchFilter('') }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          className="vpc-toolbar-btn accent"
          type="button"
          onClick={() => {
            setLoading(true)
            setError('')
            getAzureNetworkOverview(subscriptionId, location)
              .then((data) => { setOverview(data); setSelectedVNetId(''); setSubnets([]); setSelectedNsgId(''); setNsgRules([]) })
              .catch((err) => setError(normalizeError(err)))
              .finally(() => setLoading(false))
          }}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* ── Search filter ───────────────────────────────── */}
      <input
        className="vpc-search-input"
        style={{
          width: '100%',
          padding: '8px 12px',
          background: 'rgba(18, 25, 35, 0.7)',
          border: '1px solid rgba(145, 176, 207, 0.15)',
          borderRadius: 8,
          color: '#edf4fb',
          fontSize: 12,
          outline: 'none',
          boxSizing: 'border-box'
        }}
        placeholder={`Filter ${TABS.find((t) => t.id === activeTab)?.label ?? ''} by name, resource group, state...`}
        value={searchFilter}
        onChange={(e) => setSearchFilter(e.target.value)}
      />

      {/* ── Error state ─────────────────────────────────── */}
      {error && <SvcState variant="error" error={error} />}

      {/* ── Tab content ─────────────────────────────────── */}
      <div className="vpc-table-area">

        {/* ── Architecture tab ────────────────────────────── */}
        {activeTab === 'architecture' && (
          <section className="vpc-section">
            <div className="vpc-section-head">
              <div>
                <span className="vpc-section-kicker">Diagram</span>
                <h4>VNet architecture</h4>
              </div>
              <p style={{ color: '#9ca7b7', fontSize: 12 }}>
                {selectedVNetId ? `${subnets.length} subnets` : 'Select a VNet to view topology'}
              </p>
            </div>

            {/* VNet selector */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ color: '#94a3b8', fontSize: 12, marginRight: 8 }}>VNet:</label>
              <select
                value={selectedVNetId}
                onChange={(e) => setSelectedVNetId(e.target.value)}
                style={{
                  padding: '6px 10px',
                  background: 'rgba(18, 25, 35, 0.85)',
                  border: '1px solid rgba(145, 176, 207, 0.2)',
                  borderRadius: 6,
                  color: '#edf4fb',
                  fontSize: 12,
                  outline: 'none',
                  minWidth: 260,
                }}
              >
                <option value="">-- Choose a VNet --</option>
                {(overview?.vnets ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.addressPrefixes.join(', ')})
                  </option>
                ))}
              </select>
            </div>

            {subnetsLoading ? (
              <SvcState variant="loading" resourceName="subnets" compact />
            ) : (
              <AzureVNetArchitectureDiagram
                vnet={overview?.vnets.find((v) => v.id === selectedVNetId) ?? null}
                subnets={subnets}
                networkInterfaces={overview?.networkInterfaces ?? []}
                publicIps={overview?.publicIps ?? []}
                nsgs={overview?.nsgs ?? []}
                onSwitchTab={setActiveTab}
                onNavigate={onNavigate}
              />
            )}
          </section>
        )}

        {/* ── VNets tab ──────────────────────────────────── */}
        {activeTab === 'vnets' && (
          <section className="vpc-section">
            <div className="vpc-section-head">
              <div>
                <span className="vpc-section-kicker">Virtual Networks</span>
                <h4>VNet inventory</h4>
              </div>
              <p>{filteredVnets.length} {filteredVnets.length === 1 ? 'network' : 'networks'}</p>
            </div>
            {filteredVnets.length === 0 ? (
              <SvcState variant="empty" message="No virtual networks found for this subscription and location." />
            ) : (
              <>
                <div className="vpc-table-wrap">
                  <table className="svc-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Resource Group</th>
                        <th>Address Space</th>
                        <th>Subnets</th>
                        <th>State</th>
                        <th>DDoS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVnets.map((vnet) => {
                        const tone = networkStatusTone(vnet.provisioningState)
                        return (
                          <tr
                            key={vnet.id}
                            className={selectedVNetId === vnet.id ? 'active' : ''}
                            style={{ cursor: 'pointer' }}
                            onClick={() => setSelectedVNetId(selectedVNetId === vnet.id ? '' : vnet.id)}
                          >
                            <td><strong>{vnet.name}</strong></td>
                            <td>{vnet.resourceGroup}</td>
                            <td>{vnet.addressPrefixes.join(', ')}</td>
                            <td>{vnet.subnetCount}</td>
                            <td><span className={`svc-badge ${badgeClass(tone)}`}>{vnet.provisioningState}</span></td>
                            <td>{vnet.enableDdosProtection ? 'Enabled' : 'Disabled'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* ── VNet detail: subnets ──────────────────── */}
                {selectedVNetId && (
                  <section className="vpc-section" style={{ marginTop: 12 }}>
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Drill-down</span>
                        <h4>Subnets for {overview?.vnets.find((v) => v.id === selectedVNetId)?.name ?? 'VNet'}</h4>
                      </div>
                    </div>
                    {subnetsLoading ? (
                      <SvcState variant="loading" resourceName="subnets" compact />
                    ) : subnets.length === 0 ? (
                      <SvcState variant="empty" message="No subnets found for this virtual network." />
                    ) : (
                      <div className="vpc-table-wrap">
                        <table className="svc-table">
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Address Prefix</th>
                              <th>NSG</th>
                              <th>Route Table</th>
                              <th>Delegations</th>
                              <th>Private Endpoints</th>
                            </tr>
                          </thead>
                          <tbody>
                            {subnets.map((subnet) => (
                              <tr key={subnet.id}>
                                <td><strong>{subnet.name}</strong></td>
                                <td>{subnet.addressPrefix}</td>
                                <td>{subnet.nsgName || '-'}</td>
                                <td>{subnet.routeTableName || '-'}</td>
                                <td>{subnet.delegations.length > 0 ? subnet.delegations.join(', ') : '-'}</td>
                                <td>{subnet.privateEndpointCount}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Peerings for selected VNet */}
                    <div style={{ marginTop: 16 }}>
                      <h4 style={{ color: '#eef0f4', fontSize: 13, marginBottom: 8 }}>Peerings</h4>
                      {peeringsLoading && <div style={{ color: '#9ca7b7', fontSize: 12 }}>Loading peerings...</div>}
                      {!peeringsLoading && peerings.length === 0 && <div style={{ color: '#9ca7b7', fontSize: 12 }}>No peerings configured.</div>}
                      {!peeringsLoading && peerings.length > 0 && (
                        <div className="vpc-table-wrap">
                          <table className="vpc-table">
                            <thead><tr><th>Name</th><th>Remote VNet</th><th>State</th><th>VNet Access</th><th>Forwarding</th><th>Gateway Transit</th></tr></thead>
                            <tbody>
                              {peerings.map((p) => (
                                <tr key={p.id}>
                                  <td>{p.name}</td>
                                  <td>{p.remoteVNetName}</td>
                                  <td><span className={`svc-badge ${p.peeringState === 'Connected' ? 'ok' : 'warn'}`}>{p.peeringState}</span></td>
                                  <td>{p.allowVirtualNetworkAccess ? 'Yes' : 'No'}</td>
                                  <td>{p.allowForwardedTraffic ? 'Yes' : 'No'}</td>
                                  <td>{p.allowGatewayTransit ? 'Yes' : 'No'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </>
            )}
          </section>
        )}

        {/* ── NSGs tab ───────────────────────────────────── */}
        {activeTab === 'nsgs' && (
          <section className="vpc-section">
            <div className="vpc-section-head">
              <div>
                <span className="vpc-section-kicker">Network Security Groups</span>
                <h4>NSG inventory</h4>
              </div>
              <p>{filteredNsgs.length} {filteredNsgs.length === 1 ? 'group' : 'groups'}</p>
            </div>
            {filteredNsgs.length === 0 ? (
              <SvcState variant="empty" message="No network security groups found for this subscription and location." />
            ) : (
              <>
                <div className="vpc-table-wrap">
                  <table className="svc-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Resource Group</th>
                        <th>Rules</th>
                        <th>Subnets</th>
                        <th>NICs</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredNsgs.map((nsg) => {
                        const tone = networkStatusTone(nsg.provisioningState)
                        return (
                          <tr
                            key={nsg.id}
                            className={selectedNsgId === nsg.id ? 'active' : ''}
                            style={{ cursor: 'pointer' }}
                            onClick={() => setSelectedNsgId(selectedNsgId === nsg.id ? '' : nsg.id)}
                          >
                            <td><strong>{nsg.name}</strong></td>
                            <td>{nsg.resourceGroup}</td>
                            <td>{nsg.securityRuleCount} custom / {nsg.defaultRuleCount} default</td>
                            <td>{nsg.associatedSubnetCount}</td>
                            <td>{nsg.associatedNicCount}</td>
                            <td><span className={`svc-badge ${badgeClass(tone)}`}>{nsg.provisioningState}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* ── NSG detail: security rules ───────────── */}
                {selectedNsgId && (
                  <section className="vpc-section" style={{ marginTop: 12 }}>
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Security Rules</span>
                        <h4>Rules for {overview?.nsgs.find((n) => n.id === selectedNsgId)?.name ?? 'NSG'}</h4>
                      </div>
                    </div>
                    {nsgRulesLoading ? (
                      <SvcState variant="loading" resourceName="NSG rules" compact />
                    ) : nsgRules.length === 0 ? (
                      <SvcState variant="empty" message="No security rules found for this network security group." />
                    ) : (
                      <div className="vpc-table-wrap">
                        <table className="svc-table">
                          <thead>
                            <tr>
                              <th>Priority</th>
                              <th>Direction</th>
                              <th>Access</th>
                              <th>Protocol</th>
                              <th>Source</th>
                              <th>Source Port</th>
                              <th>Destination</th>
                              <th>Dest Port</th>
                            </tr>
                          </thead>
                          <tbody>
                            {nsgRules.map((rule) => (
                              <tr key={`${rule.priority}-${rule.direction}-${rule.name}`}>
                                <td><strong>{rule.priority}</strong></td>
                                <td>{rule.direction}</td>
                                <td>
                                  <span className={`svc-badge ${rule.access === 'Allow' ? 'ok' : 'danger'}`}>
                                    {rule.access}
                                  </span>
                                </td>
                                <td>{rule.protocol}</td>
                                <td>{rule.sourceAddressPrefix || '*'}</td>
                                <td>{rule.sourcePortRange || '*'}</td>
                                <td>{rule.destinationAddressPrefix || '*'}</td>
                                <td>{rule.destinationPortRange || '*'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </section>
        )}

        {/* ── Public IPs tab ─────────────────────────────── */}
        {activeTab === 'publicIps' && (
          <section className="vpc-section">
            <div className="vpc-section-head">
              <div>
                <span className="vpc-section-kicker">Public IP Addresses</span>
                <h4>Public IP inventory</h4>
              </div>
              <p>{filteredPublicIps.length} {filteredPublicIps.length === 1 ? 'address' : 'addresses'}</p>
            </div>
            {filteredPublicIps.length === 0 ? (
              <SvcState variant="empty" message="No public IP addresses found for this subscription and location." />
            ) : (
              <div className="vpc-table-wrap">
                <table className="svc-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Resource Group</th>
                      <th>IP Address</th>
                      <th>Allocation</th>
                      <th>SKU</th>
                      <th>Associated Resource</th>
                      <th>DNS Label</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPublicIps.map((pip) => (
                      <tr key={pip.id}>
                        <td><strong>{pip.name}</strong></td>
                        <td>{pip.resourceGroup}</td>
                        <td>{pip.ipAddress || '-'}</td>
                        <td>{pip.allocationMethod}</td>
                        <td>{pip.sku}</td>
                        <td>{pip.associatedResourceName || '-'}</td>
                        <td>{pip.dnsLabel || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* ── NICs tab ───────────────────────────────────── */}
        {activeTab === 'nics' && (
          <section className="vpc-section">
            <div className="vpc-section-head">
              <div>
                <span className="vpc-section-kicker">Network Interfaces</span>
                <h4>NIC inventory</h4>
              </div>
              <p>{filteredNics.length} {filteredNics.length === 1 ? 'interface' : 'interfaces'}</p>
            </div>
            {filteredNics.length === 0 ? (
              <SvcState variant="empty" message="No network interfaces found for this subscription and location." />
            ) : (
              <div className="vpc-table-wrap">
                <table className="svc-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Resource Group</th>
                      <th>Private IP</th>
                      <th>Public IP</th>
                      <th>VNet</th>
                      <th>Subnet</th>
                      <th>Attached VM</th>
                      <th>Accelerated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredNics.map((nic) => (
                      <tr key={nic.id}>
                        <td><strong>{nic.name}</strong></td>
                        <td>{nic.resourceGroup}</td>
                        <td>{nic.privateIp || '-'}</td>
                        <td>{nic.publicIp || '-'}</td>
                        <td>{nic.vnetName || '-'}</td>
                        <td>{nic.subnetName || '-'}</td>
                        <td>{nic.attachedVmName || '-'}</td>
                        <td>{nic.enableAcceleratedNetworking ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* ── Route Tables tab ──────────────────────────── */}
        {activeTab === 'routeTables' && (
          <div style={{ padding: '16px' }}>
            {routeTablesLoading && <SvcState variant="loading" resourceName="route tables" compact />}
            {!routeTablesLoading && routeTables.length === 0 && <SvcState variant="empty" message="No route tables found." />}
            {!routeTablesLoading && routeTables.length > 0 && (
              <div className="vpc-table-wrap">
                <table className="vpc-table">
                  <thead><tr><th>Name</th><th>Resource Group</th><th>Location</th><th>Routes</th><th>Subnets</th><th>BGP Propagation</th><th>State</th></tr></thead>
                  <tbody>
                    {routeTables.map((rt) => (
                      <tr key={rt.id}>
                        <td>{rt.name}</td>
                        <td>{rt.resourceGroup}</td>
                        <td>{rt.location}</td>
                        <td>{rt.routes.length}</td>
                        <td>{rt.subnetCount}</td>
                        <td><span className={`svc-badge ${rt.disableBgpRoutePropagation ? 'warn' : 'ok'}`}>{rt.disableBgpRoutePropagation ? 'Disabled' : 'Enabled'}</span></td>
                        <td><span className={`svc-badge ${badgeClass(networkStatusTone(rt.provisioningState))}`}>{rt.provisioningState}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── NAT Gateways tab ──────────────────────────── */}
        {activeTab === 'natGateways' && (
          <div style={{ padding: '16px' }}>
            {natGatewaysLoading && <SvcState variant="loading" resourceName="NAT gateways" compact />}
            {!natGatewaysLoading && natGateways.length === 0 && <SvcState variant="empty" message="No NAT gateways found." />}
            {!natGatewaysLoading && natGateways.length > 0 && (
              <div className="vpc-table-wrap">
                <table className="vpc-table">
                  <thead><tr><th>Name</th><th>Resource Group</th><th>Location</th><th>SKU</th><th>Idle Timeout</th><th>Public IPs</th><th>Subnets</th><th>Zones</th><th>State</th></tr></thead>
                  <tbody>
                    {natGateways.map((ng) => (
                      <tr key={ng.id}>
                        <td>{ng.name}</td>
                        <td>{ng.resourceGroup}</td>
                        <td>{ng.location}</td>
                        <td>{ng.skuName}</td>
                        <td>{ng.idleTimeoutInMinutes}m</td>
                        <td>{ng.publicIpCount}</td>
                        <td>{ng.subnetCount}</td>
                        <td>{ng.zones.length > 0 ? ng.zones.join(', ') : '-'}</td>
                        <td><span className={`svc-badge ${badgeClass(networkStatusTone(ng.provisioningState))}`}>{ng.provisioningState}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Load Balancers tab ─────────────────────────── */}
        {activeTab === 'loadBalancers' && (
          <div style={{ padding: '16px' }}>
            {loadBalancersLoading && <SvcState variant="loading" resourceName="load balancers" compact />}
            {!loadBalancersLoading && loadBalancers.length === 0 && <SvcState variant="empty" message="No load balancers found." />}
            {!loadBalancersLoading && loadBalancers.length > 0 && (
              <div className="vpc-table-wrap">
                <table className="vpc-table">
                  <thead><tr><th>Name</th><th>Resource Group</th><th>Location</th><th>SKU</th><th>Tier</th><th>Frontends</th><th>Backends</th><th>Rules</th><th>Probes</th><th>State</th></tr></thead>
                  <tbody>
                    {loadBalancers.map((lb) => (
                      <tr key={lb.id}>
                        <td>{lb.name}</td>
                        <td>{lb.resourceGroup}</td>
                        <td>{lb.location}</td>
                        <td>{lb.skuName}</td>
                        <td>{lb.skuTier}</td>
                        <td>{lb.frontendIpCount}</td>
                        <td>{lb.backendPoolCount}</td>
                        <td>{lb.ruleCount}</td>
                        <td>{lb.probeCount}</td>
                        <td><span className={`svc-badge ${badgeClass(networkStatusTone(lb.provisioningState))}`}>{lb.provisioningState}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Private Endpoints tab ──────────────────────── */}
        {activeTab === 'privateEndpoints' && (
          <div style={{ padding: '16px' }}>
            {privateEndpointsLoading && <SvcState variant="loading" resourceName="private endpoints" compact />}
            {!privateEndpointsLoading && privateEndpoints.length === 0 && <SvcState variant="empty" message="No private endpoints found." />}
            {!privateEndpointsLoading && privateEndpoints.length > 0 && (
              <div className="vpc-table-wrap">
                <table className="vpc-table">
                  <thead><tr><th>Name</th><th>Resource Group</th><th>Location</th><th>Linked Service</th><th>Group IDs</th><th>DNS</th><th>State</th></tr></thead>
                  <tbody>
                    {privateEndpoints.map((pe) => (
                      <tr key={pe.id}>
                        <td>{pe.name}</td>
                        <td>{pe.resourceGroup}</td>
                        <td>{pe.location}</td>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{pe.privateLinkServiceId ? pe.privateLinkServiceId.split('/').pop() : '-'}</td>
                        <td>{pe.groupIds.join(', ') || '-'}</td>
                        <td>{pe.customDnsConfigs.length > 0 ? pe.customDnsConfigs.map(c => c.fqdn).join(', ') : '-'}</td>
                        <td><span className={`svc-badge ${badgeClass(networkStatusTone(pe.provisioningState))}`}>{pe.provisioningState}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'activity' && (
          <section className="vpc-section">
            <div className="vpc-section-head">
              <div>
                <span className="vpc-section-kicker">Azure Monitor</span>
                <h4>Network activity log</h4>
              </div>
              <p style={{ color: '#9ca7b7', fontSize: 12 }}>Management-plane events for Microsoft.Network resources from the last 7 days.</p>
            </div>
            {timelineLoading ? (
              <SvcState variant="loading" resourceName="activity events" compact />
            ) : timelineError ? (
              <SvcState variant="error" error={timelineError} />
            ) : timelineEvents.length === 0 ? (
              <SvcState variant="empty" message="No Azure Monitor events found for network resources." />
            ) : (
              <div className="vpc-table-wrap">
                <table className="vpc-data-table">
                  <thead><tr><th>Operation</th><th>Status</th><th>Caller</th><th>Time</th></tr></thead>
                  <tbody>
                    {timelineEvents.map((event) => (
                      <tr key={event.id}>
                        <td title={event.resourceType}>{event.operationName}</td>
                        <td>{event.status}</td>
                        <td>{event.caller}</td>
                        <td>{event.timestamp ? new Date(event.timestamp).toLocaleString() : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
