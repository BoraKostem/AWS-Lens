/**
 * Azure Network Topology Visualization — extends the existing network surface
 * in azureSdk.ts with graph-based topology building, missing resource types
 * (Application Gateway, VPN Gateway, Express Route), effective security/routing,
 * and Private DNS zone management.
 *
 * Uses Azure Network REST APIs via fetchAzureArmJson / fetchAzureArmCollection.
 * Depends on: azure/client.ts (fetchAzureArmJson, fetchAzureArmCollection, classifyAzureError, mapWithConcurrency)
 */

import {
  classifyAzureError,
  fetchAzureArmJson,
  fetchAzureArmCollection,
  mapWithConcurrency
} from './client'
import type {
  AzureApplicationGatewaySummary,
  AzureVpnGatewaySummary,
  AzureExpressRouteCircuitSummary,
  AzurePrivateDnsZoneSummary,
  AzurePrivateDnsVNetLink,
  AzureEffectiveRoute,
  AzureEffectiveNsgRule,
  AzureNetworkTopology,
  AzureNetworkTopologyNode,
  AzureNetworkTopologyEdge,
  AzureVNetTopologyDetail
} from '@shared/types'

// ── Constants ───────────────────────────────────────────────────────────────────

const NETWORK_API_VERSION = '2023-11-01'
const PRIVATE_DNS_API_VERSION = '2024-06-01'

// ── Helpers ─────────────────────────────────────────────────────────────────────

function enc(value: string): string {
  return encodeURIComponent(value.trim())
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  const parsed = parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'True'
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function extractResourceGroup(resourceId: string): string {
  const match = resourceId.match(/\/resourceGroups\/([^/]+)/i)
  return match?.[1] ?? ''
}

function extractResourceName(resourceId: string): string {
  const segments = resourceId.split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : ''
}

function extractResourceType(resourceId: string): string {
  // e.g. /subscriptions/.../providers/Microsoft.Network/virtualNetworks/myVnet
  const match = resourceId.match(/\/providers\/([^/]+\/[^/]+)/i)
  return match?.[1] ?? ''
}

// ── 1. Application Gateways ─────────────────────────────────────────────────────

/**
 * Lists all Application Gateways in a subscription, optionally filtered by location.
 * Uses Microsoft.Network/applicationGateways (2023-11-01).
 *
 * @requires Reader role on the subscription
 */
export async function listAzureApplicationGateways(
  subscriptionId: string,
  location?: string
): Promise<AzureApplicationGatewaySummary[]> {
  if (!subscriptionId.trim()) throw new Error('subscriptionId is required')

  try {
    const raw = await fetchAzureArmCollection<Record<string, unknown>>(
      `/subscriptions/${enc(subscriptionId)}/providers/Microsoft.Network/applicationGateways`,
      NETWORK_API_VERSION
    )

    const locationFilter = (location ?? '').trim().toLowerCase()

    return raw
      .filter((r) => !locationFilter || asString(r.location).toLowerCase() === locationFilter)
      .map((r): AzureApplicationGatewaySummary => {
        const props = toRecord(r.properties)
        const sku = toRecord(props.sku)
        const sslCerts = toArray(props.sslCertificates)
        const httpListeners = toArray(props.httpListeners)
        const requestRoutingRules = toArray(props.requestRoutingRules)
        const backendPools = toArray(props.backendAddressPools)
        const backendSettings = toArray(props.backendHttpSettingsCollection)
        const frontendIpConfigs = toArray(props.frontendIPConfigurations)
        const frontendPorts = toArray(props.frontendPorts)
        const probes = toArray(props.probes)
        const wafConfig = toRecord(props.webApplicationFirewallConfiguration)
        const firewallPolicy = toRecord(props.firewallPolicy)
        const zones = toArray(r.zones)

        return {
          id: asString(r.id),
          name: asString(r.name),
          resourceGroup: extractResourceGroup(asString(r.id)),
          location: asString(r.location),
          skuName: asString(sku.name),
          skuTier: asString(sku.tier),
          skuCapacity: asNumber(sku.capacity),
          provisioningState: asString(props.provisioningState),
          operationalState: asString(props.operationalState),
          httpListenerCount: httpListeners.length,
          requestRoutingRuleCount: requestRoutingRules.length,
          backendPoolCount: backendPools.length,
          backendSettingsCount: backendSettings.length,
          frontendIpCount: frontendIpConfigs.length,
          frontendPortCount: frontendPorts.length,
          sslCertificateCount: sslCerts.length,
          probeCount: probes.length,
          wafEnabled: asBool(wafConfig.enabled) || Boolean(firewallPolicy.id),
          zones: zones.map((z) => asString(z))
        }
      })
  } catch (error) {
    throw classifyAzureError('listing application gateways', error)
  }
}

// ── 2. VPN Gateways ────────────────────────────────────────────────────────────

/**
 * Lists all VPN Gateways (Virtual Network Gateways) in a subscription,
 * optionally filtered by location.
 * Uses Microsoft.Network/virtualNetworkGateways (2023-11-01).
 *
 * @requires Reader role on the subscription
 */
export async function listAzureVpnGateways(
  subscriptionId: string,
  location?: string
): Promise<AzureVpnGatewaySummary[]> {
  if (!subscriptionId.trim()) throw new Error('subscriptionId is required')

  try {
    const raw = await fetchAzureArmCollection<Record<string, unknown>>(
      `/subscriptions/${enc(subscriptionId)}/providers/Microsoft.Network/virtualNetworkGateways`,
      NETWORK_API_VERSION
    )

    const locationFilter = (location ?? '').trim().toLowerCase()

    return raw
      .filter((r) => !locationFilter || asString(r.location).toLowerCase() === locationFilter)
      .map((r): AzureVpnGatewaySummary => {
        const props = toRecord(r.properties)
        const sku = toRecord(props.sku)
        const ipConfigs = toArray(props.ipConfigurations)
        const bgpSettings = toRecord(props.bgpSettings)
        const vpnClientConfig = toRecord(props.vpnClientConfiguration)
        const zones = toArray(r.zones)

        // Extract connected VNet from the first IP config's subnet
        let connectedVNetId = ''
        if (ipConfigs.length > 0) {
          const firstIp = toRecord(ipConfigs[0])
          const firstIpProps = toRecord(firstIp.properties)
          const subnetId = asString(firstIpProps.subnet ? toRecord(firstIpProps.subnet).id : '')
          // Subnet ID format: /subscriptions/.../virtualNetworks/{vnet}/subnets/{subnet}
          const vnetMatch = subnetId.match(/(\/subscriptions\/.*\/virtualNetworks\/[^/]+)/i)
          if (vnetMatch) connectedVNetId = vnetMatch[1]
        }

        return {
          id: asString(r.id),
          name: asString(r.name),
          resourceGroup: extractResourceGroup(asString(r.id)),
          location: asString(r.location),
          gatewayType: asString(props.gatewayType),
          vpnType: asString(props.vpnType),
          vpnGatewayGeneration: asString(props.vpnGatewayGeneration),
          skuName: asString(sku.name),
          skuTier: asString(sku.tier),
          enableBgp: asBool(props.enableBgp),
          bgpAsn: asNumber(bgpSettings.asn),
          activeActive: asBool(props.activeActive),
          ipConfigurationCount: ipConfigs.length,
          connectedVNetId,
          vpnClientAddressPrefixes: toArray(vpnClientConfig.vpnClientAddressPool ? toRecord(vpnClientConfig.vpnClientAddressPool).addressPrefixes : []).map((p) => asString(p)),
          provisioningState: asString(props.provisioningState),
          zones: zones.map((z) => asString(z))
        }
      })
  } catch (error) {
    throw classifyAzureError('listing VPN gateways', error)
  }
}

// ── 3. Express Route Circuits ──────────────────────────────────────────────────

/**
 * Lists all Express Route circuits in a subscription, optionally filtered by location.
 * Uses Microsoft.Network/expressRouteCircuits (2023-11-01).
 *
 * @requires Reader role on the subscription
 */
export async function listAzureExpressRouteCircuits(
  subscriptionId: string,
  location?: string
): Promise<AzureExpressRouteCircuitSummary[]> {
  if (!subscriptionId.trim()) throw new Error('subscriptionId is required')

  try {
    const raw = await fetchAzureArmCollection<Record<string, unknown>>(
      `/subscriptions/${enc(subscriptionId)}/providers/Microsoft.Network/expressRouteCircuits`,
      NETWORK_API_VERSION
    )

    const locationFilter = (location ?? '').trim().toLowerCase()

    return raw
      .filter((r) => !locationFilter || asString(r.location).toLowerCase() === locationFilter)
      .map((r): AzureExpressRouteCircuitSummary => {
        const props = toRecord(r.properties)
        const sku = toRecord(r.sku)
        const peerings = toArray(props.peerings)
        const authorizations = toArray(props.authorizations)
        const serviceProviderProps = toRecord(props.serviceProviderProperties)

        return {
          id: asString(r.id),
          name: asString(r.name),
          resourceGroup: extractResourceGroup(asString(r.id)),
          location: asString(r.location),
          skuName: asString(sku.name),
          skuTier: asString(sku.tier),
          skuFamily: asString(sku.family),
          circuitProvisioningState: asString(props.circuitProvisioningState),
          serviceProviderProvisioningState: asString(props.serviceProviderProvisioningState),
          serviceProviderName: asString(serviceProviderProps.serviceProviderName),
          peeringLocation: asString(serviceProviderProps.peeringLocation),
          bandwidthInMbps: asNumber(serviceProviderProps.bandwidthInMbps),
          peeringCount: peerings.length,
          authorizationCount: authorizations.length,
          allowClassicOperations: asBool(props.allowClassicOperations),
          globalReachEnabled: asBool(props.globalReachEnabled),
          provisioningState: asString(props.provisioningState)
        }
      })
  } catch (error) {
    throw classifyAzureError('listing Express Route circuits', error)
  }
}

// ── 4. Private DNS Zones ───────────────────────────────────────────────────────

/**
 * Lists all Private DNS zones in a subscription.
 * Uses Microsoft.Network/privateDnsZones (2024-06-01).
 *
 * @requires Reader role on the subscription
 */
export async function listAzurePrivateDnsZones(
  subscriptionId: string
): Promise<AzurePrivateDnsZoneSummary[]> {
  if (!subscriptionId.trim()) throw new Error('subscriptionId is required')

  try {
    const raw = await fetchAzureArmCollection<Record<string, unknown>>(
      `/subscriptions/${enc(subscriptionId)}/providers/Microsoft.Network/privateDnsZones`,
      PRIVATE_DNS_API_VERSION
    )

    return raw.map((r): AzurePrivateDnsZoneSummary => {
      const props = toRecord(r.properties)
      return {
        id: asString(r.id),
        name: asString(r.name),
        resourceGroup: extractResourceGroup(asString(r.id)),
        location: asString(r.location) || 'global',
        numberOfRecordSets: asNumber(props.numberOfRecordSets),
        maxNumberOfRecordSets: asNumber(props.maxNumberOfRecordSets),
        numberOfVirtualNetworkLinks: asNumber(props.numberOfVirtualNetworkLinks),
        maxNumberOfVirtualNetworkLinks: asNumber(props.maxNumberOfVirtualNetworkLinks),
        provisioningState: asString(props.provisioningState)
      }
    })
  } catch (error) {
    throw classifyAzureError('listing Private DNS zones', error)
  }
}

/**
 * Lists Virtual Network links for a specific Private DNS zone.
 * Uses Microsoft.Network/privateDnsZones/virtualNetworkLinks (2024-06-01).
 */
export async function listAzurePrivateDnsVNetLinks(
  subscriptionId: string,
  resourceGroup: string,
  zoneName: string
): Promise<AzurePrivateDnsVNetLink[]> {
  if (!subscriptionId.trim() || !resourceGroup.trim() || !zoneName.trim()) {
    throw new Error('subscriptionId, resourceGroup, and zoneName are required')
  }

  try {
    const raw = await fetchAzureArmCollection<Record<string, unknown>>(
      `/subscriptions/${enc(subscriptionId)}/resourceGroups/${enc(resourceGroup)}/providers/Microsoft.Network/privateDnsZones/${enc(zoneName)}/virtualNetworkLinks`,
      PRIVATE_DNS_API_VERSION
    )

    return raw.map((r): AzurePrivateDnsVNetLink => {
      const props = toRecord(r.properties)
      const vnet = toRecord(props.virtualNetwork)
      return {
        id: asString(r.id),
        name: asString(r.name),
        virtualNetworkId: asString(vnet.id),
        registrationEnabled: asBool(props.registrationEnabled),
        provisioningState: asString(props.provisioningState)
      }
    })
  } catch (error) {
    throw classifyAzureError('listing Private DNS VNet links', error)
  }
}

// ── 5. Effective Routes ────────────────────────────────────────────────────────

/**
 * Gets the effective route table applied to a network interface.
 * Uses Microsoft.Network/networkInterfaces/effectiveRouteTable (2023-11-01).
 *
 * This is a POST operation that may take 30+ seconds. The result shows all
 * routes (system, user-defined, BGP) that are actively applied.
 *
 * @param subscriptionId Subscription ID
 * @param resourceGroup  Resource group of the NIC
 * @param nicName        Name of the network interface
 *
 * @requires Reader role on the NIC
 */
export async function getAzureEffectiveRoutes(
  subscriptionId: string,
  resourceGroup: string,
  nicName: string
): Promise<AzureEffectiveRoute[]> {
  if (!subscriptionId.trim() || !resourceGroup.trim() || !nicName.trim()) {
    throw new Error('subscriptionId, resourceGroup, and nicName are required')
  }

  try {
    const response = await fetchAzureArmJson<{ value?: Record<string, unknown>[] }>(
      `/subscriptions/${enc(subscriptionId)}/resourceGroups/${enc(resourceGroup)}/providers/Microsoft.Network/networkInterfaces/${enc(nicName)}/effectiveRouteTable`,
      NETWORK_API_VERSION,
      { method: 'POST' }
    )

    return (response.value ?? []).map((r): AzureEffectiveRoute => ({
      source: asString(r.source),
      state: asString(r.state),
      addressPrefixes: toArray(r.addressPrefix).map((p) => asString(p)),
      nextHopType: asString(r.nextHopType),
      nextHopIpAddress: toArray(r.nextHopIpAddress).map((ip) => asString(ip)),
      disableBgpRoutePropagation: asBool(r.disableBgpRoutePropagation)
    }))
  } catch (error) {
    throw classifyAzureError('getting effective routes', error)
  }
}

// ── 6. Effective NSG Rules ─────────────────────────────────────────────────────

/**
 * Gets the effective Network Security Group rules applied to a network interface.
 * Uses Microsoft.Network/networkInterfaces/effectiveNetworkSecurityGroups (2023-11-01).
 *
 * @param subscriptionId Subscription ID
 * @param resourceGroup  Resource group of the NIC
 * @param nicName        Name of the network interface
 *
 * @requires Reader role on the NIC
 */
export async function getAzureEffectiveNsgRules(
  subscriptionId: string,
  resourceGroup: string,
  nicName: string
): Promise<AzureEffectiveNsgRule[]> {
  if (!subscriptionId.trim() || !resourceGroup.trim() || !nicName.trim()) {
    throw new Error('subscriptionId, resourceGroup, and nicName are required')
  }

  try {
    const response = await fetchAzureArmJson<{ value?: Record<string, unknown>[] }>(
      `/subscriptions/${enc(subscriptionId)}/resourceGroups/${enc(resourceGroup)}/providers/Microsoft.Network/networkInterfaces/${enc(nicName)}/effectiveNetworkSecurityGroups`,
      NETWORK_API_VERSION,
      { method: 'POST' }
    )

    const rules: AzureEffectiveNsgRule[] = []

    for (const nsg of response.value ?? []) {
      const nsgId = asString(toRecord(nsg.networkSecurityGroup).id)
      const effectiveRules = toArray(nsg.effectiveSecurityRules)

      for (const rule of effectiveRules) {
        const r = toRecord(rule)
        rules.push({
          nsgId,
          name: asString(r.name),
          protocol: asString(r.protocol),
          sourcePortRange: asString(r.sourcePortRange),
          destinationPortRange: asString(r.destinationPortRange),
          sourceAddressPrefixes: toArray(r.sourceAddressPrefix ? [r.sourceAddressPrefix] : r.expandedSourceAddressPrefix).map((p) => asString(p)),
          destinationAddressPrefixes: toArray(r.destinationAddressPrefix ? [r.destinationAddressPrefix] : r.expandedDestinationAddressPrefix).map((p) => asString(p)),
          access: asString(r.access) as 'Allow' | 'Deny',
          priority: asNumber(r.priority),
          direction: asString(r.direction) as 'Inbound' | 'Outbound'
        })
      }
    }

    return rules.sort((a, b) => a.priority - b.priority)
  } catch (error) {
    throw classifyAzureError('getting effective NSG rules', error)
  }
}

// ── 7. Network Topology Graph ──────────────────────────────────────────────────

/**
 * Builds a full network topology graph for a subscription and location.
 * Fetches VNets, subnets, peerings, NSGs, load balancers, application gateways,
 * VPN gateways, firewalls, private endpoints, and NAT gateways — then assembles
 * them into a node/edge graph suitable for visualization.
 *
 * @param subscriptionId Subscription ID
 * @param location       Optional location filter (e.g. "eastus")
 *
 * @requires Reader role on the subscription
 */
export async function getAzureNetworkTopology(
  subscriptionId: string,
  location?: string
): Promise<AzureNetworkTopology> {
  if (!subscriptionId.trim()) throw new Error('subscriptionId is required')

  const locationFilter = (location ?? '').trim().toLowerCase()

  try {
    const basePath = `/subscriptions/${enc(subscriptionId)}/providers/Microsoft.Network`

    // Fetch all network resources in parallel
    const [
      rawVnets,
      rawNsgs,
      rawPublicIps,
      rawLoadBalancers,
      rawAppGateways,
      rawVpnGateways,
      rawFirewalls,
      rawPrivateEndpoints,
      rawNatGateways,
      rawExpressRoutes
    ] = await Promise.all([
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/virtualNetworks`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/networkSecurityGroups`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/publicIPAddresses`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/loadBalancers`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/applicationGateways`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/virtualNetworkGateways`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/azureFirewalls`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/privateEndpoints`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/natGateways`, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(`${basePath}/expressRouteCircuits`, NETWORK_API_VERSION)
    ])

    const filterLoc = <T extends Record<string, unknown>>(items: T[]): T[] =>
      locationFilter ? items.filter((item) => asString(item.location).toLowerCase() === locationFilter) : items

    const vnets = filterLoc(rawVnets)
    const nsgs = filterLoc(rawNsgs)
    const publicIps = filterLoc(rawPublicIps)
    const loadBalancers = filterLoc(rawLoadBalancers)
    const appGateways = filterLoc(rawAppGateways)
    const vpnGateways = filterLoc(rawVpnGateways)
    const firewalls = filterLoc(rawFirewalls)
    const privateEndpoints = filterLoc(rawPrivateEndpoints)
    const natGateways = filterLoc(rawNatGateways)
    const expressRoutes = filterLoc(rawExpressRoutes)

    const nodes: AzureNetworkTopologyNode[] = []
    const edges: AzureNetworkTopologyEdge[] = []
    const nodeIds = new Set<string>()

    function addNode(node: AzureNetworkTopologyNode): void {
      if (!nodeIds.has(node.id)) {
        nodeIds.add(node.id)
        nodes.push(node)
      }
    }

    function addEdge(edge: AzureNetworkTopologyEdge): void {
      edges.push(edge)
    }

    // ── VNets + Subnets ──
    for (const vnet of vnets) {
      const vnetId = asString(vnet.id)
      const vnetProps = toRecord(vnet.properties)
      const subnets = toArray(vnetProps.subnets)
      const addressSpace = toRecord(vnetProps.addressSpace)
      const addressPrefixes = toArray(addressSpace.addressPrefixes).map((p) => asString(p))

      addNode({
        id: vnetId,
        name: asString(vnet.name),
        type: 'vnet',
        resourceGroup: extractResourceGroup(vnetId),
        location: asString(vnet.location),
        properties: { addressPrefixes, subnetCount: subnets.length }
      })

      // Subnets as child nodes
      for (const subnet of subnets) {
        const s = toRecord(subnet)
        const subnetId = asString(s.id)
        const subnetProps = toRecord(s.properties)

        addNode({
          id: subnetId,
          name: asString(s.name),
          type: 'subnet',
          resourceGroup: extractResourceGroup(vnetId),
          location: asString(vnet.location),
          properties: {
            addressPrefix: asString(subnetProps.addressPrefix),
            nsgId: asString(toRecord(subnetProps.networkSecurityGroup).id),
            routeTableId: asString(toRecord(subnetProps.routeTable).id),
            natGatewayId: asString(toRecord(subnetProps.natGateway).id)
          }
        })

        addEdge({ source: vnetId, target: subnetId, type: 'contains', label: 'subnet' })

        // Subnet → NSG
        const nsgId = asString(toRecord(subnetProps.networkSecurityGroup).id)
        if (nsgId) {
          addEdge({ source: subnetId, target: nsgId, type: 'secures', label: 'NSG' })
        }

        // Subnet → Route Table
        const routeTableId = asString(toRecord(subnetProps.routeTable).id)
        if (routeTableId) {
          addEdge({ source: subnetId, target: routeTableId, type: 'routes', label: 'route table' })
        }

        // Subnet → NAT Gateway
        const natGwId = asString(toRecord(subnetProps.natGateway).id)
        if (natGwId) {
          addEdge({ source: subnetId, target: natGwId, type: 'egress', label: 'NAT Gateway' })
        }
      }

      // VNet Peerings
      const peerings = toArray(vnetProps.virtualNetworkPeerings)
      for (const peering of peerings) {
        const p = toRecord(peering)
        const pProps = toRecord(p.properties)
        const remoteVNetId = asString(toRecord(pProps.remoteVirtualNetwork).id)
        if (remoteVNetId) {
          addEdge({ source: vnetId, target: remoteVNetId, type: 'peering', label: asString(p.name) })
        }
      }
    }

    // ── NSGs ──
    for (const nsg of nsgs) {
      const nsgId = asString(nsg.id)
      const nsgProps = toRecord(nsg.properties)
      addNode({
        id: nsgId,
        name: asString(nsg.name),
        type: 'nsg',
        resourceGroup: extractResourceGroup(nsgId),
        location: asString(nsg.location),
        properties: {
          ruleCount: toArray(nsgProps.securityRules).length
        }
      })
    }

    // ── Public IPs ──
    for (const pip of publicIps) {
      const pipId = asString(pip.id)
      const pipProps = toRecord(pip.properties)
      addNode({
        id: pipId,
        name: asString(pip.name),
        type: 'publicIp',
        resourceGroup: extractResourceGroup(pipId),
        location: asString(pip.location),
        properties: {
          ipAddress: asString(pipProps.ipAddress),
          allocationMethod: asString(pipProps.publicIPAllocationMethod)
        }
      })

      // Public IP → associated resource (via ipConfiguration)
      const ipConfigId = asString(toRecord(pipProps.ipConfiguration).id)
      if (ipConfigId) {
        // Extract the parent resource from the ipConfiguration ID
        const parentMatch = ipConfigId.match(/(\/subscriptions\/.*\/providers\/[^/]+\/[^/]+\/[^/]+)/i)
        if (parentMatch) {
          addEdge({ source: pipId, target: parentMatch[1], type: 'assignedTo', label: 'public IP' })
        }
      }
    }

    // ── Load Balancers ──
    for (const lb of loadBalancers) {
      const lbId = asString(lb.id)
      const lbProps = toRecord(lb.properties)
      const sku = toRecord(lb.sku)
      addNode({
        id: lbId,
        name: asString(lb.name),
        type: 'loadBalancer',
        resourceGroup: extractResourceGroup(lbId),
        location: asString(lb.location),
        properties: {
          skuName: asString(sku.name),
          frontendIpCount: toArray(lbProps.frontendIPConfigurations).length,
          backendPoolCount: toArray(lbProps.backendAddressPools).length
        }
      })

      // LB frontend → subnet connections
      for (const feIp of toArray(lbProps.frontendIPConfigurations)) {
        const feProps = toRecord(toRecord(feIp).properties)
        const subnetId = asString(toRecord(feProps.subnet).id)
        if (subnetId) {
          addEdge({ source: lbId, target: subnetId, type: 'frontend', label: 'LB frontend' })
        }
      }
    }

    // ── Application Gateways ──
    for (const ag of appGateways) {
      const agId = asString(ag.id)
      const agProps = toRecord(ag.properties)
      const sku = toRecord(agProps.sku)
      addNode({
        id: agId,
        name: asString(ag.name),
        type: 'applicationGateway',
        resourceGroup: extractResourceGroup(agId),
        location: asString(ag.location),
        properties: {
          skuName: asString(sku.name),
          skuTier: asString(sku.tier)
        }
      })

      // App Gateway → subnet (via gateway IP configurations)
      for (const ipConfig of toArray(agProps.gatewayIPConfigurations)) {
        const configProps = toRecord(toRecord(ipConfig).properties)
        const subnetId = asString(toRecord(configProps.subnet).id)
        if (subnetId) {
          addEdge({ source: agId, target: subnetId, type: 'deployed', label: 'App GW subnet' })
        }
      }
    }

    // ── VPN Gateways ──
    for (const vpn of vpnGateways) {
      const vpnId = asString(vpn.id)
      const vpnProps = toRecord(vpn.properties)
      addNode({
        id: vpnId,
        name: asString(vpn.name),
        type: 'vpnGateway',
        resourceGroup: extractResourceGroup(vpnId),
        location: asString(vpn.location),
        properties: {
          gatewayType: asString(vpnProps.gatewayType),
          vpnType: asString(vpnProps.vpnType)
        }
      })

      // VPN GW → subnet (GatewaySubnet)
      for (const ipConfig of toArray(vpnProps.ipConfigurations)) {
        const configProps = toRecord(toRecord(ipConfig).properties)
        const subnetId = asString(toRecord(configProps.subnet).id)
        if (subnetId) {
          addEdge({ source: vpnId, target: subnetId, type: 'deployed', label: 'GW subnet' })
          // Also link to VNet
          const vnetMatch = subnetId.match(/(\/subscriptions\/.*\/virtualNetworks\/[^/]+)/i)
          if (vnetMatch) {
            addEdge({ source: vpnId, target: vnetMatch[1], type: 'gateway', label: 'VPN Gateway' })
          }
        }
      }
    }

    // ── Firewalls ──
    for (const fw of firewalls) {
      const fwId = asString(fw.id)
      const fwProps = toRecord(fw.properties)
      addNode({
        id: fwId,
        name: asString(fw.name),
        type: 'firewall',
        resourceGroup: extractResourceGroup(fwId),
        location: asString(fw.location),
        properties: {
          threatIntelMode: asString(fwProps.threatIntelMode)
        }
      })

      // Firewall → subnet (AzureFirewallSubnet)
      for (const ipConfig of toArray(fwProps.ipConfigurations)) {
        const configProps = toRecord(toRecord(ipConfig).properties)
        const subnetId = asString(toRecord(configProps.subnet).id)
        if (subnetId) {
          addEdge({ source: fwId, target: subnetId, type: 'deployed', label: 'FW subnet' })
        }
      }
    }

    // ── Private Endpoints ──
    for (const pe of privateEndpoints) {
      const peId = asString(pe.id)
      const peProps = toRecord(pe.properties)
      const plConnections = toArray(peProps.privateLinkServiceConnections)
        .concat(toArray(peProps.manualPrivateLinkServiceConnections))

      let targetServiceId = ''
      const groupIds: string[] = []
      for (const conn of plConnections) {
        const connProps = toRecord(toRecord(conn).properties)
        targetServiceId = targetServiceId || asString(connProps.privateLinkServiceId)
        groupIds.push(...toArray(connProps.groupIds).map((g) => asString(g)))
      }

      addNode({
        id: peId,
        name: asString(pe.name),
        type: 'privateEndpoint',
        resourceGroup: extractResourceGroup(peId),
        location: asString(pe.location),
        properties: {
          targetServiceId,
          groupIds
        }
      })

      // PE → subnet
      const subnetId = asString(toRecord(peProps.subnet).id)
      if (subnetId) {
        addEdge({ source: peId, target: subnetId, type: 'deployed', label: 'PE subnet' })
      }

      // PE → target service
      if (targetServiceId) {
        addEdge({ source: peId, target: targetServiceId, type: 'privateLink', label: 'private link' })
      }
    }

    // ── NAT Gateways ──
    for (const nat of natGateways) {
      const natId = asString(nat.id)
      addNode({
        id: natId,
        name: asString(nat.name),
        type: 'natGateway',
        resourceGroup: extractResourceGroup(natId),
        location: asString(nat.location),
        properties: {}
      })
    }

    // ── Express Route Circuits ──
    for (const er of expressRoutes) {
      const erId = asString(er.id)
      const erProps = toRecord(er.properties)
      const serviceProvider = toRecord(erProps.serviceProviderProperties)
      addNode({
        id: erId,
        name: asString(er.name),
        type: 'expressRoute',
        resourceGroup: extractResourceGroup(erId),
        location: asString(er.location),
        properties: {
          serviceProviderName: asString(serviceProvider.serviceProviderName),
          bandwidthInMbps: asNumber(serviceProvider.bandwidthInMbps)
        }
      })
    }

    return {
      subscriptionId: subscriptionId.trim(),
      location: locationFilter || 'all',
      nodes,
      edges,
      summary: {
        vnetCount: vnets.length,
        subnetCount: nodes.filter((n) => n.type === 'subnet').length,
        nsgCount: nsgs.length,
        publicIpCount: publicIps.length,
        loadBalancerCount: loadBalancers.length,
        applicationGatewayCount: appGateways.length,
        vpnGatewayCount: vpnGateways.length,
        firewallCount: firewalls.length,
        privateEndpointCount: privateEndpoints.length,
        natGatewayCount: natGateways.length,
        expressRouteCount: expressRoutes.length,
        peeringCount: edges.filter((e) => e.type === 'peering').length,
        totalNodeCount: nodes.length,
        totalEdgeCount: edges.length
      }
    }
  } catch (error) {
    throw classifyAzureError('building network topology', error)
  }
}

// ── 8. VNet Topology Detail ────────────────────────────────────────────────────

/**
 * Gets a detailed topology view for a specific VNet, including all subnets,
 * their NSGs, connected NICs, peerings, and deployed gateways/firewalls.
 *
 * This is a more focused view than getAzureNetworkTopology — it fetches
 * additional detail (NICs, peerings) scoped to a single VNet.
 *
 * @requires Reader role on the VNet and associated resources
 */
export async function getAzureVNetTopologyDetail(
  subscriptionId: string,
  resourceGroup: string,
  vnetName: string
): Promise<AzureVNetTopologyDetail> {
  if (!subscriptionId.trim() || !resourceGroup.trim() || !vnetName.trim()) {
    throw new Error('subscriptionId, resourceGroup, and vnetName are required')
  }

  try {
    const vnetPath = `/subscriptions/${enc(subscriptionId)}/resourceGroups/${enc(resourceGroup)}/providers/Microsoft.Network/virtualNetworks/${enc(vnetName)}`

    // Fetch VNet detail and associated resources in parallel
    const [vnetDetail, allNics, peerings] = await Promise.all([
      fetchAzureArmJson<Record<string, unknown>>(vnetPath, NETWORK_API_VERSION),
      fetchAzureArmCollection<Record<string, unknown>>(
        `/subscriptions/${enc(subscriptionId)}/providers/Microsoft.Network/networkInterfaces`,
        NETWORK_API_VERSION
      ),
      fetchAzureArmCollection<Record<string, unknown>>(
        `${vnetPath}/virtualNetworkPeerings`,
        NETWORK_API_VERSION
      )
    ])

    const vnetProps = toRecord(vnetDetail.properties)
    const addressSpace = toRecord(vnetProps.addressSpace)
    const subnets = toArray(vnetProps.subnets)
    const vnetId = asString(vnetDetail.id)

    // Build subnet details
    const subnetDetails = subnets.map((s) => {
      const subnet = toRecord(s)
      const sProps = toRecord(subnet.properties)
      const subnetId = asString(subnet.id)

      // Find NICs attached to this subnet
      const subnetNics = allNics.filter((nic) => {
        const nicProps = toRecord(nic.properties)
        const ipConfigs = toArray(nicProps.ipConfigurations)
        return ipConfigs.some((ipConfig) => {
          const configProps = toRecord(toRecord(ipConfig).properties)
          return asString(toRecord(configProps.subnet).id).toLowerCase() === subnetId.toLowerCase()
        })
      })

      return {
        id: subnetId,
        name: asString(subnet.name),
        addressPrefix: asString(sProps.addressPrefix),
        nsgId: asString(toRecord(sProps.networkSecurityGroup).id),
        nsgName: extractResourceName(asString(toRecord(sProps.networkSecurityGroup).id)),
        routeTableId: asString(toRecord(sProps.routeTable).id),
        routeTableName: extractResourceName(asString(toRecord(sProps.routeTable).id)),
        natGatewayId: asString(toRecord(sProps.natGateway).id),
        delegations: toArray(sProps.delegations).map((d) =>
          asString(toRecord(toRecord(d).properties).serviceName)
        ).filter(Boolean),
        serviceEndpoints: toArray(sProps.serviceEndpoints).map((se) =>
          asString(toRecord(se).service)
        ).filter(Boolean),
        privateEndpointCount: toArray(sProps.privateEndpoints).length,
        connectedNicCount: subnetNics.length,
        connectedNics: subnetNics.slice(0, 50).map((nic) => {
          const nicProps = toRecord(nic.properties)
          const vmRef = toRecord(nicProps.virtualMachine)
          return {
            id: asString(nic.id),
            name: asString(nic.name),
            privateIp: extractPrivateIp(nic),
            attachedVmName: extractResourceName(asString(vmRef.id))
          }
        })
      }
    })

    // Build peering details
    const peeringDetails = peerings.map((p) => {
      const pProps = toRecord(p.properties)
      const remoteVnet = toRecord(pProps.remoteVirtualNetwork)
      return {
        id: asString(p.id),
        name: asString(p.name),
        peeringState: asString(pProps.peeringState),
        remoteVNetId: asString(remoteVnet.id),
        remoteVNetName: extractResourceName(asString(remoteVnet.id)),
        allowVirtualNetworkAccess: asBool(pProps.allowVirtualNetworkAccess),
        allowForwardedTraffic: asBool(pProps.allowForwardedTraffic),
        allowGatewayTransit: asBool(pProps.allowGatewayTransit),
        useRemoteGateways: asBool(pProps.useRemoteGateways)
      }
    })

    // Check for gateway subnets (indicates VPN/ExpressRoute gateway)
    const gatewaySubnet = subnets.find(
      (s) => asString(toRecord(s).name).toLowerCase() === 'gatewaysubnet'
    )
    const firewallSubnet = subnets.find(
      (s) => asString(toRecord(s).name).toLowerCase() === 'azurefirewallsubnet'
    )

    return {
      id: vnetId,
      name: asString(vnetDetail.name),
      resourceGroup: resourceGroup.trim(),
      location: asString(vnetDetail.location),
      addressPrefixes: toArray(addressSpace.addressPrefixes).map((p) => asString(p)),
      dnsServers: toArray(toRecord(vnetProps.dhcpOptions).dnsServers).map((d) => asString(d)),
      enableDdosProtection: asBool(vnetProps.enableDdosProtection),
      subnets: subnetDetails,
      peerings: peeringDetails,
      hasGatewaySubnet: Boolean(gatewaySubnet),
      hasFirewallSubnet: Boolean(firewallSubnet),
      totalNicCount: subnetDetails.reduce((sum, s) => sum + s.connectedNicCount, 0),
      provisioningState: asString(vnetProps.provisioningState)
    }
  } catch (error) {
    throw classifyAzureError('getting VNet topology detail', error)
  }
}

/**
 * Extracts the primary private IP from a NIC resource.
 */
function extractPrivateIp(nic: Record<string, unknown>): string {
  const nicProps = toRecord(nic.properties)
  const ipConfigs = toArray(nicProps.ipConfigurations)
  for (const ipConfig of ipConfigs) {
    const configProps = toRecord(toRecord(ipConfig).properties)
    if (asBool(configProps.primary)) {
      return asString(configProps.privateIPAddress)
    }
  }
  // Fallback: first IP config
  if (ipConfigs.length > 0) {
    return asString(toRecord(toRecord(ipConfigs[0]).properties).privateIPAddress)
  }
  return ''
}
