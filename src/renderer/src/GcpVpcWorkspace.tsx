import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  GcpFirewallRuleSummary,
  GcpGlobalAddressSummary,
  GcpNetworkSummary,
  GcpRouterNatSummary,
  GcpRouterSummary,
  GcpServiceNetworkingConnectionSummary,
  GcpSubnetworkSummary,
  ServiceId
} from '@shared/types'
import {
  listGcpFirewallRules,
  listGcpGlobalAddresses,
  listGcpNetworks,
  listGcpRouters,
  listGcpServiceNetworkingConnections,
  listGcpSubnetworks
} from './api'
import { SvcState } from './SvcState'
import './vpc.css'
import './gcp-vpc.css'

type GcpVpcTab = 'topology' | 'flow' | 'security' | 'gateways' | 'addresses'

const TABS: Array<{ id: GcpVpcTab; label: string }> = [
  { id: 'topology', label: 'Topology' },
  { id: 'flow', label: 'Architecture' },
  { id: 'security', label: 'Security' },
  { id: 'gateways', label: 'Gateways' },
  { id: 'addresses', label: 'Addresses' }
]

function summarizeNetworkMode(network: GcpNetworkSummary | null): { tone: 'success' | 'warning' | 'info'; label: string } {
  if (!network) {
    return { tone: 'info', label: 'No selection' }
  }

  if (network.autoCreateSubnetworks) {
    return { tone: 'warning', label: 'Auto mode' }
  }

  if ((network.routingMode || '').trim().toUpperCase() === 'GLOBAL') {
    return { tone: 'success', label: 'Custom / global routing' }
  }

  return { tone: 'info', label: 'Custom mode' }
}

function formatRoutingMode(network: GcpNetworkSummary): string {
  const routingMode = network.routingMode.trim().toUpperCase()
  return routingMode ? `${routingMode.toLowerCase()} routing` : 'routing mode unavailable'
}

function subnetworkAccessTone(subnetwork: GcpSubnetworkSummary): 'success' | 'info' {
  return subnetwork.privateIpGoogleAccess ? 'success' : 'info'
}

function filterSelected<T extends { network: string }>(items: T[], networkName: string): T[] {
  return items.filter((item) => item.network === networkName)
}

function GcpVpcArchitectureDiagram({
  network,
  subnetworks,
  routers,
  nats,
  serviceConnections,
  globalAddresses,
  onSwitchTab
}: {
  network: GcpNetworkSummary
  subnetworks: GcpSubnetworkSummary[]
  routers: GcpRouterSummary[]
  nats: GcpRouterNatSummary[]
  serviceConnections: GcpServiceNetworkingConnectionSummary[]
  globalAddresses: GcpGlobalAddressSummary[]
  onSwitchTab: (tab: GcpVpcTab) => void
}) {
  const subnetworksByRegion = useMemo(() => {
    const grouped = new Map<string, GcpSubnetworkSummary[]>()

    for (const subnetwork of subnetworks) {
      const key = subnetwork.region || 'global'
      const current = grouped.get(key) ?? []
      current.push(subnetwork)
      grouped.set(key, current)
    }

    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [subnetworks])

  const natsByRouter = useMemo(() => {
    const map = new Map<string, GcpRouterNatSummary[]>()
    for (const nat of nats) {
      const list = map.get(nat.router) ?? []
      list.push(nat)
      map.set(nat.router, list)
    }
    return map
  }, [nats])

  // Layout constants
  const SUBNET_W = 220
  const SUBNET_H = 52
  const REGION_PAD = 12
  const REGION_COL_W = SUBNET_W + REGION_PAD * 2
  const REGION_GAP = 24

  const regionCount = Math.max(subnetworksByRegion.length, 1)
  const maxSubsInRegion = Math.max(1, ...subnetworksByRegion.map(([, s]) => s.length))

  const vpcContentW = regionCount * REGION_COL_W + (regionCount - 1) * REGION_GAP
  const W = Math.max(vpcContentW + 140, 720)
  const CX = W / 2

  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 2) + '..' : s)

  // Sequential Y layout
  let y = 14

  const EDGE_H = 34
  const edgeCY = y + EDGE_H / 2
  y += EDGE_H + 8

  const arrowGap = 28
  y += arrowGap

  const vpcTop = y
  y += 10

  // VPC title area
  y += 24

  // Region labels
  const regionLabelY = y + 12
  y += 28

  // Subnet area
  const subnetStartY = y
  const subnetAreaH = maxSubsInRegion * SUBNET_H + (maxSubsInRegion - 1) * 10
  y += subnetAreaH + 18

  // Cloud Routers row
  const ROUTER_H = 32
  let routerCY = 0
  if (routers.length > 0) {
    routerCY = y + ROUTER_H / 2
    y += ROUTER_H + 16
  }

  // Cloud NATs row
  const NAT_H = 32
  let natCY = 0
  if (nats.length > 0) {
    natCY = y + NAT_H / 2
    y += NAT_H + 16
  }

  // VPC container ends
  y += 12
  const vpcBottom = y

  // External resources below VPC
  const hasExternal = serviceConnections.length > 0 || globalAddresses.length > 0
  if (hasExternal) {
    y += arrowGap
  }

  // Service Connections row
  const SVC_H = 32
  let svcCY = 0
  if (serviceConnections.length > 0) {
    svcCY = y + SVC_H / 2
    y += SVC_H + 16
  }

  // Global Addresses row
  const ADDR_H = 32
  let addrCY = 0
  if (globalAddresses.length > 0) {
    addrCY = y + ADDR_H / 2
    y += ADDR_H + 16
  }

  const H = y + 14

  // X positions for region columns
  const regionTotalW = regionCount * REGION_COL_W + (regionCount - 1) * REGION_GAP
  const regionStartX = CX - regionTotalW / 2
  const getRegionX = (i: number) => regionStartX + i * (REGION_COL_W + REGION_GAP)
  const getRegionCX = (i: number) => getRegionX(i) + REGION_COL_W / 2

  // Router positions
  const routerSpacing = Math.min(280, (W - 200) / Math.max(routers.length, 1))
  const routerStartX = CX - ((routers.length - 1) * routerSpacing) / 2
  const getRouterCX = (i: number) => routerStartX + i * routerSpacing

  // NAT positions
  const natSpacing = Math.min(280, (W - 200) / Math.max(nats.length, 1))
  const natStartX = CX - ((nats.length - 1) * natSpacing) / 2
  const getNatCX = (i: number) => natStartX + i * natSpacing

  // Service connection positions
  const svcSpacing = Math.min(300, (W - 200) / Math.max(serviceConnections.length, 1))
  const svcStartX = CX - ((serviceConnections.length - 1) * svcSpacing) / 2
  const getSvcCX = (i: number) => svcStartX + i * svcSpacing

  // Global address positions
  const addrSpacing = Math.min(260, (W - 200) / Math.max(globalAddresses.length, 1))
  const addrStartX = CX - ((globalAddresses.length - 1) * addrSpacing) / 2
  const getAddrCX = (i: number) => addrStartX + i * addrSpacing

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="vpc-arch-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="gcp-arch-arrow" markerWidth="8" markerHeight="6" refX="4" refY="6" orient="auto">
          <path d="M0,0 L4,6 L8,0" fill="none" stroke="rgba(141,180,160,0.6)" strokeWidth="1.2" />
        </marker>
      </defs>

      {/* ── Google APIs / Internet edge ──────── */}
      <g className="vpc-arch-node">
        <rect x={CX - 110} y={edgeCY - EDGE_H / 2} width={220} height={EDGE_H}
          rx={8} fill="rgba(71,85,105,0.5)" stroke="rgba(141,180,160,0.45)" strokeWidth={1.5} />
        <text x={CX} y={edgeCY + 5} textAnchor="middle" fill="#e2e8f0" fontSize={13} fontWeight={600}>
          Google APIs / Internet edge
        </text>
      </g>

      {/* Arrow: Edge → VPC */}
      <line x1={CX} y1={edgeCY + EDGE_H / 2}
            x2={CX} y2={vpcTop}
            stroke="rgba(141,180,160,0.5)" strokeWidth={1.5} markerEnd="url(#gcp-arch-arrow)" />

      {/* ── VPC Network Container ────────────── */}
      <rect x={50} y={vpcTop} width={W - 100} height={vpcBottom - vpcTop}
        rx={6} fill="rgba(52,168,83,0.06)" stroke="rgba(52,168,83,0.45)" strokeWidth={2} />
      <text x={62} y={vpcTop + 16} fill="#34a853" fontSize={12} fontWeight={700}>
        {network.name}
      </text>
      <text x={62} y={vpcTop + 30} fill="rgba(141,180,160,0.6)" fontSize={10}>
        {network.autoCreateSubnetworks ? 'Auto subnet mode' : 'Custom subnet mode'} · {formatRoutingMode(network)}
      </text>

      {/* ── Region Columns + Subnetworks ─────── */}
      {subnetworksByRegion.map(([region, subs], regionIdx) => {
        const colX = getRegionX(regionIdx)
        const colCX = getRegionCX(regionIdx)
        return (
          <g key={region}>
            <text x={colCX} y={regionLabelY} textAnchor="middle" fill="rgba(141,180,160,0.6)" fontSize={11} fontWeight={500}>
              {region}
            </text>
            <rect x={colX + 4} y={regionLabelY + 8} width={REGION_COL_W - 8}
              height={subs.length * (SUBNET_H + 10) - 2} rx={4}
              fill="none" stroke="rgba(141,180,160,0.08)" strokeWidth={1} strokeDasharray="4 3" />
            {subs.map((subnetwork, si) => {
              const sy = subnetStartY + si * (SUBNET_H + 10)
              return (
                <g key={subnetwork.name} className="vpc-arch-clickable" onClick={() => onSwitchTab('topology')}>
                  <rect x={colX + REGION_PAD} y={sy} width={SUBNET_W} height={SUBNET_H}
                    rx={6} fill="rgba(52,168,83,0.06)" stroke="rgba(52,168,83,0.4)" strokeWidth={1.5} />
                  <text x={colX + REGION_PAD + 10} y={sy + 17} fill="#34a853" fontSize={10.5} fontWeight={600}>
                    {trunc(subnetwork.name, 26)}
                  </text>
                  <text x={colX + REGION_PAD + 10} y={sy + 32} fill="rgba(141,180,160,0.65)" fontSize={10}>
                    {subnetwork.ipCidrRange || 'CIDR unavailable'}
                  </text>
                  <text x={colX + REGION_PAD + 10} y={sy + 45} fill="rgba(141,180,160,0.4)" fontSize={9}>
                    {subnetwork.privateIpGoogleAccess ? 'Private Google Access' : 'No Private Access'}
                  </text>
                </g>
              )
            })}
          </g>
        )
      })}

      {/* ── Connection lines: Regions → Routers ── */}
      {routers.map((router) => {
        const rtIdx = routers.indexOf(router)
        const rtX = getRouterCX(rtIdx)
        const regionIdx = subnetworksByRegion.findIndex(([region]) => region === router.region)
        if (regionIdx < 0) return null
        const subs = subnetworksByRegion[regionIdx][1]
        const lastSubY = subnetStartY + (subs.length - 1) * (SUBNET_H + 10) + SUBNET_H
        const sx = getRegionCX(regionIdx)
        return (
          <line key={`conn-${router.name}`}
            x1={sx} y1={lastSubY} x2={rtX} y2={routerCY - ROUTER_H / 2}
            stroke="rgba(141,180,160,0.18)" strokeWidth={1.2} strokeDasharray="5 3" />
        )
      })}

      {/* ── Cloud Routers ────────────────────── */}
      {routers.map((router, i) => {
        const rx = getRouterCX(i)
        const routerNats = natsByRouter.get(router.name) ?? []
        return (
          <g key={router.name} className="vpc-arch-clickable" onClick={() => onSwitchTab('gateways')}>
            <rect x={rx - 130} y={routerCY - ROUTER_H / 2} width={260} height={ROUTER_H}
              rx={6} fill="rgba(52,168,83,0.1)" stroke="rgba(52,168,83,0.5)" strokeWidth={1.3} />
            <text x={rx} y={routerCY - 2} textAnchor="middle" fill="#34a853" fontSize={10.5} fontWeight={600}>
              Router: {trunc(router.name, 24)}
            </text>
            <text x={rx} y={routerCY + 12} textAnchor="middle" fill="rgba(141,180,160,0.5)" fontSize={9}>
              {router.region || 'region unavailable'} · {routerNats.length} NAT(s)
            </text>
          </g>
        )
      })}

      {/* ── Cloud NATs ───────────────────────── */}
      {nats.map((nat, i) => {
        const nx = getNatCX(i)
        return (
          <g key={`${nat.router}:${nat.name}`} className="vpc-arch-clickable" onClick={() => onSwitchTab('gateways')}>
            <rect x={nx - 130} y={natCY - NAT_H / 2} width={260} height={NAT_H}
              rx={6} fill="rgba(251,188,5,0.1)" stroke="#fbbc05" strokeWidth={1.3} />
            <text x={nx} y={natCY - 2} textAnchor="middle" fill="#fbbc05" fontSize={10.5} fontWeight={600}>
              Cloud NAT: {trunc(nat.name, 22)}
            </text>
            <text x={nx} y={natCY + 12} textAnchor="middle" fill="rgba(251,188,5,0.5)" fontSize={9}>
              {nat.router} · {nat.natIpAllocateOption || 'allocation unavailable'}
            </text>
          </g>
        )
      })}

      {/* ── Arrow: VPC → External resources ──── */}
      {hasExternal && (
        <line x1={CX} y1={vpcBottom}
              x2={CX} y2={serviceConnections.length > 0 ? svcCY - SVC_H / 2 : addrCY - ADDR_H / 2}
              stroke="rgba(141,180,160,0.5)" strokeWidth={1.5} markerEnd="url(#gcp-arch-arrow)" />
      )}

      {/* ── Service Connections ──────────────── */}
      {serviceConnections.map((connection, i) => {
        const sx = getSvcCX(i)
        return (
          <g key={`${connection.service}:${connection.peering}`} className="vpc-arch-clickable" onClick={() => onSwitchTab('gateways')}>
            <rect x={sx - 140} y={svcCY - SVC_H / 2} width={280} height={SVC_H}
              rx={6} fill="rgba(66,133,244,0.08)" stroke="rgba(66,133,244,0.5)" strokeWidth={1.3} />
            <text x={sx} y={svcCY - 2} textAnchor="middle" fill="#4285f4" fontSize={10.5} fontWeight={600}>
              {trunc(connection.service, 30)}
            </text>
            <text x={sx} y={svcCY + 12} textAnchor="middle" fill="rgba(66,133,244,0.5)" fontSize={9}>
              {connection.peering || 'peering unavailable'}
            </text>
          </g>
        )
      })}

      {/* ── Global Addresses ─────────────────── */}
      {globalAddresses.map((address, i) => {
        const ax = getAddrCX(i)
        return (
          <g key={address.name} className="vpc-arch-clickable" onClick={() => onSwitchTab('addresses')}>
            <rect x={ax - 120} y={addrCY - ADDR_H / 2} width={240} height={ADDR_H}
              rx={6} fill="rgba(168,85,247,0.08)" stroke="rgba(168,85,247,0.45)" strokeWidth={1.2} />
            <text x={ax} y={addrCY - 2} textAnchor="middle" fill="#a855f7" fontSize={10.5} fontWeight={600}>
              {trunc(address.name, 26)}
            </text>
            <text x={ax} y={addrCY + 12} textAnchor="middle" fill="rgba(168,85,247,0.5)" fontSize={9}>
              {address.address || 'address pending'} · {address.purpose || address.addressType || 'global'}
            </text>
          </g>
        )
      })}

      {/* ── Empty states ─────────────────────── */}
      {subnetworksByRegion.length === 0 && (
        <text x={CX} y={subnetStartY + 30} textAnchor="middle" fill="rgba(141,180,160,0.3)" fontSize={12} fontStyle="italic">
          No subnetworks in this VPC
        </text>
      )}
    </svg>
  )
}

export function GcpVpcWorkspace({
  projectId,
  location,
  refreshNonce,
  focusNetworkName,
  onNavigate
}: {
  projectId: string
  location: string
  refreshNonce: number
  focusNetworkName?: { token: number; networkName: string } | null
  onNavigate: (service: ServiceId, resourceId?: string) => void
}) {
  const [tab, setTab] = useState<GcpVpcTab>('topology')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [networks, setNetworks] = useState<GcpNetworkSummary[]>([])
  const [selectedNetworkName, setSelectedNetworkName] = useState('')
  const [subnetworks, setSubnetworks] = useState<GcpSubnetworkSummary[]>([])
  const [firewallRules, setFirewallRules] = useState<GcpFirewallRuleSummary[]>([])
  const [routers, setRouters] = useState<GcpRouterSummary[]>([])
  const [nats, setNats] = useState<GcpRouterNatSummary[]>([])
  const [globalAddresses, setGlobalAddresses] = useState<GcpGlobalAddressSummary[]>([])
  const [serviceConnections, setServiceConnections] = useState<GcpServiceNetworkingConnectionSummary[]>([])
  const [loadingNetworkName, setLoadingNetworkName] = useState('')
  const loadRequestRef = useRef(0)
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)

  const selectedNetwork = useMemo(
    () => networks.find((network) => network.name === selectedNetworkName) ?? null,
    [networks, selectedNetworkName]
  )
  const selectedSubnetworks = useMemo(
    () => filterSelected(subnetworks, selectedNetworkName),
    [selectedNetworkName, subnetworks]
  )
  const selectedFirewallRules = useMemo(
    () => filterSelected(firewallRules, selectedNetworkName),
    [firewallRules, selectedNetworkName]
  )
  const selectedRouters = useMemo(
    () => filterSelected(routers, selectedNetworkName),
    [routers, selectedNetworkName]
  )
  const selectedGlobalAddresses = useMemo(
    () => globalAddresses.filter((address) => !address.network || address.network === selectedNetworkName),
    [globalAddresses, selectedNetworkName]
  )
  const selectedServiceConnections = useMemo(
    () => serviceConnections.filter((connection) => connection.network === selectedNetworkName),
    [selectedNetworkName, serviceConnections]
  )
  const selectedNats = useMemo(() => {
    const routerNames = new Set(selectedRouters.map((router) => router.name))
    return nats.filter((nat) => routerNames.has(nat.router))
  }, [nats, selectedRouters])
  const selectedStatus = useMemo(() => summarizeNetworkMode(selectedNetwork), [selectedNetwork])
  const regionCount = useMemo(() => new Set(selectedSubnetworks.map((subnetwork) => subnetwork.region)).size, [selectedSubnetworks])
  const privateAccessCount = useMemo(
    () => selectedSubnetworks.filter((subnetwork) => subnetwork.privateIpGoogleAccess).length,
    [selectedSubnetworks]
  )

  async function loadNetworksInventory(): Promise<void> {
    setLoading(true)
    setError('')

    try {
      const nextNetworks = await listGcpNetworks(projectId)
      setNetworks(nextNetworks)
      setSelectedNetworkName((current) => {
        if (current && nextNetworks.some((network) => network.name === current)) {
          return current
        }

        if (focusNetworkName?.networkName && nextNetworks.some((network) => network.name === focusNetworkName.networkName)) {
          return focusNetworkName.networkName
        }

        return nextNetworks[0]?.name ?? ''
      })
    } catch (err) {
      setNetworks([])
      setSelectedNetworkName('')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function loadSelectedNetwork(networkName: string): Promise<void> {
    if (!networkName) {
      setSubnetworks([])
      setFirewallRules([])
      setRouters([])
      setNats([])
      setGlobalAddresses([])
      setServiceConnections([])
      return
    }

    const requestId = ++loadRequestRef.current
    setLoading(true)
    setLoadingNetworkName(networkName)
    setError('')
    setMessage('')

    try {
      const [nextSubnetworks, nextFirewallRules, nextRouters, nextGlobalAddresses, nextServiceConnections] = await Promise.all([
        listGcpSubnetworks(projectId, location),
        listGcpFirewallRules(projectId),
        listGcpRouters(projectId, location),
        listGcpGlobalAddresses(projectId),
        listGcpServiceNetworkingConnections(projectId, [networkName])
      ])

      if (requestId !== loadRequestRef.current) {
        return
      }

      setSubnetworks(nextSubnetworks)
      setFirewallRules(nextFirewallRules)
      setRouters(nextRouters.routers)
      setNats(nextRouters.nats)
      setGlobalAddresses(nextGlobalAddresses)
      setServiceConnections(nextServiceConnections)
      setMessage(`Loaded VPC inventory for ${networkName}.`)
    } catch (err) {
      if (requestId !== loadRequestRef.current) {
        return
      }

      setSubnetworks([])
      setFirewallRules([])
      setRouters([])
      setNats([])
      setGlobalAddresses([])
      setServiceConnections([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestId !== loadRequestRef.current) {
        return
      }

      setLoading(false)
      setLoadingNetworkName('')
    }
  }

  useEffect(() => {
    void loadNetworksInventory()
  }, [projectId, refreshNonce])

  useEffect(() => {
    void loadSelectedNetwork(selectedNetworkName)
  }, [location, projectId, selectedNetworkName, refreshNonce])

  useEffect(() => {
    if (!focusNetworkName || focusNetworkName.token === appliedFocusToken) {
      return
    }

    setAppliedFocusToken(focusNetworkName.token)
    if (networks.some((network) => network.name === focusNetworkName.networkName)) {
      setSelectedNetworkName(focusNetworkName.networkName)
    }
  }, [appliedFocusToken, focusNetworkName, networks])

  return (
    <div className="vpc-console gcp-vpc-console">
      <section className="vpc-shell-hero gcp-vpc-hero">
        <div className="vpc-shell-hero-copy">
          <div className="eyebrow">Networking</div>
          <h2>GCP VPC workspace</h2>
          <p>
            Review network inventory with the same left-rail-plus-detail-pane model as the AWS VPC console,
            remapped to Google Cloud networks, subnetworks, firewall posture, Cloud Routers, Cloud NAT, and service networking.
          </p>
          <div className="vpc-shell-meta-strip">
            <div className="vpc-shell-meta-pill">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Location</span>
              <strong>{location || 'global'}</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Selected VPC</span>
              <strong>{selectedNetwork?.name || 'Choose a network'}</strong>
            </div>
            <div className="vpc-shell-meta-pill">
              <span>Current view</span>
              <strong>{TABS.find((item) => item.id === tab)?.label ?? 'Topology'}</strong>
            </div>
          </div>
        </div>
        <div className="vpc-shell-hero-stats">
          <div className={`vpc-shell-stat-card ${selectedStatus.tone}`}>
            <span>Network mode</span>
            <strong>{selectedStatus.label}</strong>
            <small>{selectedNetwork ? formatRoutingMode(selectedNetwork) : 'Waiting for selection'}</small>
          </div>
          <div className="vpc-shell-stat-card">
            <span>Tracked networks</span>
            <strong>{networks.length}</strong>
            <small>{networks.filter((network) => network.autoCreateSubnetworks).length} auto-mode networks</small>
          </div>
          <div className="vpc-shell-stat-card">
            <span>Subnetworks</span>
            <strong>{selectedSubnetworks.length}</strong>
            <small>{privateAccessCount} with Private Google Access</small>
          </div>
          <div className="vpc-shell-stat-card">
            <span>Security posture</span>
            <strong>{selectedFirewallRules.length}</strong>
            <small>{selectedFirewallRules.filter((rule) => rule.direction === 'INGRESS').length} ingress rules</small>
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
            <strong>{selectedNetwork?.name || 'No VPC selected'}</strong>
          </div>
          <div className="vpc-shell-status-card">
            <span>State</span>
            <strong>{loadingNetworkName ? `Loading ${loadingNetworkName}...` : loading ? 'Loading inventory...' : 'Synchronized'}</strong>
          </div>
          <button className="vpc-toolbar-btn" type="button" onClick={() => onNavigate('gcp-compute-engine')}>
            Open Compute Engine
          </button>
          <button className="vpc-toolbar-btn" type="button" onClick={() => onNavigate('gcp-cloud-sql')}>
            Open Cloud SQL
          </button>
          <button
            className="vpc-toolbar-btn accent"
            type="button"
            onClick={() => {
              void loadNetworksInventory()
              if (selectedNetworkName) {
                void loadSelectedNetwork(selectedNetworkName)
              }
            }}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {message ? <div className="vpc-msg">{message}</div> : null}
      {error ? <SvcState variant="error" error={error} /> : null}

      <div className="vpc-main-layout">
        <aside className="vpc-inventory-pane">
          <div className="vpc-pane-head">
            <div>
              <span className="vpc-pane-kicker">Tracked networks</span>
              <h3>VPC inventory</h3>
            </div>
            <span className="vpc-pane-summary">{networks.length} total</span>
          </div>
          <label className="vpc-select-field">
            <span>Quick select</span>
            <select value={selectedNetworkName} onChange={(event) => setSelectedNetworkName(event.target.value)} disabled={loading && networks.length === 0}>
              {networks.map((network) => (
                <option key={network.name} value={network.name}>
                  {network.name} ({network.autoCreateSubnetworks ? 'auto' : 'custom'})
                </option>
              ))}
            </select>
          </label>
          {networks.length === 0 ? (
            <SvcState variant="empty" message={`No VPC networks were returned for ${projectId}.`} />
          ) : (
            <div className="vpc-inventory-list">
              {networks.map((network) => {
                const status = summarizeNetworkMode(network)

                return (
                  <button
                    key={network.name}
                    type="button"
                    className={`vpc-inventory-card ${network.name === selectedNetworkName ? 'active' : ''}`}
                    onClick={() => setSelectedNetworkName(network.name)}
                  >
                    <div className="vpc-inventory-card-top">
                      <div className="vpc-inventory-card-copy">
                        <strong>{network.name}</strong>
                        <span>{formatRoutingMode(network)}</span>
                      </div>
                      <span className={`vpc-status-badge ${status.tone}`}>{status.label}</span>
                    </div>
                    <div className="vpc-inventory-card-meta">
                      <span>{network.autoCreateSubnetworks ? 'auto subnetworks' : 'custom subnetworks'}</span>
                      <span>{network.routingMode || 'routing unavailable'}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </aside>

        <section className="vpc-detail-pane">
          {!selectedNetwork ? (
            <SvcState variant="no-selection" resourceName="VPC network" message="Select a VPC network to inspect topology, firewall posture, Cloud NAT, and global addressing." />
          ) : (
            <>
              <section className="vpc-detail-hero gcp-vpc-detail-hero">
                <div className="vpc-detail-hero-copy">
                  <div className="eyebrow">Network posture</div>
                  <h3>{selectedNetwork.name}</h3>
                  <p>{selectedNetwork.autoCreateSubnetworks ? 'Auto subnet mode' : 'Custom subnet mode'} · {formatRoutingMode(selectedNetwork)}</p>
                  <div className="vpc-detail-meta-strip">
                    <div className="vpc-detail-meta-pill">
                      <span>Regions</span>
                      <strong>{regionCount || '-'}</strong>
                    </div>
                    <div className="vpc-detail-meta-pill">
                      <span>Cloud Routers</span>
                      <strong>{selectedRouters.length}</strong>
                    </div>
                    <div className="vpc-detail-meta-pill">
                      <span>Cloud NAT</span>
                      <strong>{selectedNats.length}</strong>
                    </div>
                    <div className="vpc-detail-meta-pill">
                      <span>Service networking</span>
                      <strong>{selectedServiceConnections.length}</strong>
                    </div>
                  </div>
                </div>
                <div className="vpc-detail-hero-stats">
                  <div className={`vpc-detail-stat-card ${selectedStatus.tone}`}>
                    <span>Subnetworks</span>
                    <strong>{selectedSubnetworks.length}</strong>
                    <small>{privateAccessCount} with Private Google Access</small>
                  </div>
                  <div className="vpc-detail-stat-card">
                    <span>Firewall rules</span>
                    <strong>{selectedFirewallRules.length}</strong>
                    <small>{selectedFirewallRules.filter((rule) => rule.direction === 'EGRESS').length} egress rules</small>
                  </div>
                  <div className="vpc-detail-stat-card">
                    <span>Global addresses</span>
                    <strong>{selectedGlobalAddresses.length}</strong>
                    <small>{selectedGlobalAddresses.filter((address) => address.purpose).length} reserved purposes</small>
                  </div>
                  <div className="vpc-detail-stat-card">
                    <span>Topology state</span>
                    <strong>{loadingNetworkName === selectedNetwork.name ? 'Syncing' : 'Ready'}</strong>
                    <small>Project-aware networking inventory</small>
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

              {tab === 'topology' ? (
                <>
                  <div className="vpc-summary-grid">
                    <div className="vpc-summary-card"><span>Subnetworks</span><strong>{selectedSubnetworks.length}</strong></div>
                    <div className="vpc-summary-card"><span>Regions</span><strong>{regionCount}</strong></div>
                    <div className="vpc-summary-card"><span>Firewall rules</span><strong>{selectedFirewallRules.length}</strong></div>
                    <div className="vpc-summary-card"><span>Cloud NAT</span><strong>{selectedNats.length}</strong></div>
                    <div className="vpc-summary-card"><span>Global addresses</span><strong>{selectedGlobalAddresses.length}</strong></div>
                    <div className="vpc-summary-card"><span>Private service access</span><strong>{selectedServiceConnections.length}</strong></div>
                  </div>

                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Subnet inventory</span>
                        <h4>Subnetworks</h4>
                      </div>
                      <p>Subnetworks are filtered to the selected VPC and the current location scope.</p>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Region</th>
                            <th>CIDR</th>
                            <th>Private Google Access</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedSubnetworks.map((subnetwork) => (
                            <tr key={subnetwork.name}>
                              <td>{subnetwork.name}</td>
                              <td>{subnetwork.region || '-'}</td>
                              <td className="vpc-mono">{subnetwork.ipCidrRange || '-'}</td>
                              <td>
                                <span className={`vpc-status-badge ${subnetworkAccessTone(subnetwork)}`}>
                                  {subnetwork.privateIpGoogleAccess ? 'Enabled' : 'Disabled'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {selectedSubnetworks.length === 0 ? <SvcState variant="empty" message="No subnetworks matched the selected VPC." compact /> : null}
                  </section>

                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Routing surface</span>
                        <h4>Routers and NAT coverage</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Router</th>
                            <th>Region</th>
                            <th>Cloud NATs</th>
                            <th>NAT allocation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedRouters.map((router) => {
                            const routerNats = selectedNats.filter((nat) => nat.router === router.name)
                            return (
                              <tr key={router.name}>
                                <td>{router.name}</td>
                                <td>{router.region || '-'}</td>
                                <td>{routerNats.length ? routerNats.map((nat) => nat.name).join(', ') : '-'}</td>
                                <td className="vpc-table-detail">
                                  {routerNats.length ? routerNats.map((nat) => nat.natIpAllocateOption || 'allocation unavailable').join('; ') : '-'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {selectedRouters.length === 0 ? <SvcState variant="empty" message="No Cloud Routers matched the selected VPC." compact /> : null}
                  </section>
                </>
              ) : null}

              {tab === 'flow' ? (
                <section className="vpc-section">
                  <div className="vpc-section-head">
                    <div>
                      <span className="vpc-section-kicker">Diagram</span>
                      <h4>VPC architecture</h4>
                    </div>
                    <p>
                      The architecture lens shows the selected VPC network, its regional subnetworks, router/NAT layer,
                      private service access, and any global addresses attached to the same topology.
                    </p>
                  </div>
                  <GcpVpcArchitectureDiagram
                    network={selectedNetwork}
                    subnetworks={selectedSubnetworks}
                    routers={selectedRouters}
                    nats={selectedNats}
                    serviceConnections={selectedServiceConnections}
                    globalAddresses={selectedGlobalAddresses}
                    onSwitchTab={setTab}
                  />
                </section>
              ) : null}

              {tab === 'security' ? (
                <section className="vpc-section">
                  <div className="vpc-section-head">
                    <div>
                      <span className="vpc-section-kicker">Firewall posture</span>
                      <h4>Firewall rules</h4>
                    </div>
                    <p>Firewall rules are filtered to the selected VPC network and help approximate the AWS security view for this slice.</p>
                  </div>
                  <div className="vpc-table-wrap">
                    <table className="vpc-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Direction</th>
                          <th>Priority</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedFirewallRules.map((rule) => (
                          <tr key={rule.name}>
                            <td>{rule.name}</td>
                            <td>
                              <span className={`vpc-status-badge ${rule.direction === 'INGRESS' ? 'warning' : 'info'}`}>
                                {rule.direction || 'UNKNOWN'}
                              </span>
                            </td>
                            <td className="vpc-mono">{rule.priority || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {selectedFirewallRules.length === 0 ? <SvcState variant="empty" message="No firewall rules matched the selected VPC." compact /> : null}
                </section>
              ) : null}

              {tab === 'gateways' ? (
                <>
                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Gateway layer</span>
                        <h4>Cloud Routers and NAT</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Region</th>
                            <th>Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedRouters.map((router) => (
                            <tr key={`router:${router.name}`}>
                              <td>{router.name}</td>
                              <td>Cloud Router</td>
                              <td>{router.region || '-'}</td>
                              <td>{router.network || '-'}</td>
                            </tr>
                          ))}
                          {selectedNats.map((nat) => (
                            <tr key={`nat:${nat.router}:${nat.name}`}>
                              <td>{nat.name}</td>
                              <td>Cloud NAT</td>
                              <td>{nat.region || '-'}</td>
                              <td>{nat.router} · {nat.natIpAllocateOption || 'allocation unavailable'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {selectedRouters.length === 0 && selectedNats.length === 0 ? <SvcState variant="empty" message="No router or NAT resources matched the selected VPC." compact /> : null}
                  </section>

                  <section className="vpc-section">
                    <div className="vpc-section-head">
                      <div>
                        <span className="vpc-section-kicker">Private service access</span>
                        <h4>Service networking connections</h4>
                      </div>
                    </div>
                    <div className="vpc-table-wrap">
                      <table className="vpc-table">
                        <thead>
                          <tr>
                            <th>Service</th>
                            <th>Peering</th>
                            <th>Reserved ranges</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedServiceConnections.map((connection) => (
                            <tr key={`${connection.service}:${connection.peering}`}>
                              <td>{connection.service}</td>
                              <td>{connection.peering || '-'}</td>
                              <td className="vpc-table-detail">
                                {connection.reservedPeeringRanges.length ? connection.reservedPeeringRanges.join(', ') : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {selectedServiceConnections.length === 0 ? <SvcState variant="empty" message="No service networking connections were returned for the selected VPC." compact /> : null}
                  </section>
                </>
              ) : null}

              {tab === 'addresses' ? (
                <section className="vpc-section">
                  <div className="vpc-section-head">
                    <div>
                      <span className="vpc-section-kicker">Address surface</span>
                      <h4>Global addresses</h4>
                    </div>
                  </div>
                  <div className="vpc-table-wrap">
                    <table className="vpc-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Address</th>
                          <th>Type</th>
                          <th>Purpose</th>
                          <th>Prefix</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedGlobalAddresses.map((address) => (
                          <tr key={address.name}>
                            <td>{address.name}</td>
                            <td className="vpc-mono">{address.address || '-'}</td>
                            <td>{address.addressType || '-'}</td>
                            <td>{address.purpose || '-'}</td>
                            <td className="vpc-mono">{address.prefixLength || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {selectedGlobalAddresses.length === 0 ? <SvcState variant="empty" message="No global addresses matched the selected VPC." compact /> : null}
                </section>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
