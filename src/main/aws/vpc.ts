import {
  CreateNetworkInsightsPathCommand,
  DeleteNetworkInsightsAnalysisCommand,
  DeleteNetworkInsightsPathCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkInsightsAnalysesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeTransitGatewaysCommand,
  DescribeVpcsCommand,
  EC2Client,
  ModifySubnetAttributeCommand,
  StartNetworkInsightsAnalysisCommand
} from '@aws-sdk/client-ec2'

import { getAwsClient, readTags } from './client'
import type {
  AwsConnection,
  InternetGatewaySummary,
  NatGatewaySummary,
  NetworkInterfaceSummary,
  ReachabilityPathResult,
  RouteTableSummary,
  SecurityGroupSummary,
  SubnetSummary,
  TransitGatewaySummary,
  VpcFlowDiagramData,
  VpcSummary,
  VpcTopology
} from '@shared/types'

/* ── VPC inventory ────────────────────────────────────────── */

export async function listVpcs(connection: AwsConnection): Promise<VpcSummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const vpcs: VpcSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeVpcsCommand({ NextToken: nextToken }))
    for (const vpc of output.Vpcs ?? []) {
      const tags = readTags(vpc.Tags)
      vpcs.push({
        vpcId: vpc.VpcId ?? '-',
        cidrBlock: vpc.CidrBlock ?? '-',
        state: vpc.State ?? '-',
        isDefault: vpc.IsDefault ?? false,
        name: tags.Name ?? '-',
        ownerId: vpc.OwnerId ?? '-',
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return vpcs
}

export async function listSubnets(connection: AwsConnection, vpcId?: string): Promise<SubnetSummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const subnets: SubnetSummary[] = []
  let nextToken: string | undefined
  const filters = vpcId ? [{ Name: 'vpc-id', Values: [vpcId] }] : undefined

  do {
    const output = await client.send(new DescribeSubnetsCommand({ Filters: filters, NextToken: nextToken }))
    for (const subnet of output.Subnets ?? []) {
      const tags = readTags(subnet.Tags)
      subnets.push({
        subnetId: subnet.SubnetId ?? '-',
        vpcId: subnet.VpcId ?? '-',
        cidrBlock: subnet.CidrBlock ?? '-',
        availabilityZone: subnet.AvailabilityZone ?? '-',
        availableIpAddressCount: subnet.AvailableIpAddressCount ?? 0,
        mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch ?? false,
        state: subnet.State ?? '-',
        name: tags.Name ?? '-',
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return subnets
}

export async function listRouteTables(connection: AwsConnection, vpcId?: string): Promise<RouteTableSummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const tables: RouteTableSummary[] = []
  let nextToken: string | undefined
  const filters = vpcId ? [{ Name: 'vpc-id', Values: [vpcId] }] : undefined

  do {
    const output = await client.send(new DescribeRouteTablesCommand({ Filters: filters, NextToken: nextToken }))
    for (const rt of output.RouteTables ?? []) {
      const tags = readTags(rt.Tags)
      tables.push({
        routeTableId: rt.RouteTableId ?? '-',
        vpcId: rt.VpcId ?? '-',
        name: tags.Name ?? '-',
        isMain: rt.Associations?.some((a) => a.Main) ?? false,
        associatedSubnets: (rt.Associations ?? [])
          .filter((a) => a.SubnetId)
          .map((a) => a.SubnetId!),
        routes: (rt.Routes ?? []).map((r) => ({
          destination: r.DestinationCidrBlock ?? r.DestinationPrefixListId ?? '-',
          target:
            r.GatewayId ??
            r.NatGatewayId ??
            r.TransitGatewayId ??
            r.NetworkInterfaceId ??
            r.VpcPeeringConnectionId ??
            'local',
          state: r.State ?? '-'
        })),
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return tables
}

export async function listInternetGateways(connection: AwsConnection, vpcId?: string): Promise<InternetGatewaySummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const gateways: InternetGatewaySummary[] = []
  const filters = vpcId ? [{ Name: 'attachment.vpc-id', Values: [vpcId] }] : undefined

  const output = await client.send(new DescribeInternetGatewaysCommand({ Filters: filters }))
  for (const igw of output.InternetGateways ?? []) {
    const tags = readTags(igw.Tags)
    gateways.push({
      igwId: igw.InternetGatewayId ?? '-',
      state: igw.Attachments?.[0]?.State ?? 'detached',
      attachedVpcId: igw.Attachments?.[0]?.VpcId ?? '-',
      name: tags.Name ?? '-',
      tags
    })
  }

  return gateways
}

export async function listNatGateways(connection: AwsConnection, vpcId?: string): Promise<NatGatewaySummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const gateways: NatGatewaySummary[] = []
  let nextToken: string | undefined
  const filter = vpcId ? [{ Name: 'vpc-id', Values: [vpcId] }] : undefined

  do {
    const output = await client.send(new DescribeNatGatewaysCommand({ Filter: filter, NextToken: nextToken }))
    for (const nat of output.NatGateways ?? []) {
      const tags = readTags(nat.Tags)
      const addr = nat.NatGatewayAddresses?.[0]
      gateways.push({
        natGatewayId: nat.NatGatewayId ?? '-',
        state: nat.State ?? '-',
        subnetId: nat.SubnetId ?? '-',
        vpcId: nat.VpcId ?? '-',
        connectivityType: nat.ConnectivityType ?? '-',
        publicIp: addr?.PublicIp ?? '-',
        privateIp: addr?.PrivateIp ?? '-',
        name: tags.Name ?? '-',
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return gateways
}

export async function listTransitGateways(connection: AwsConnection): Promise<TransitGatewaySummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const gateways: TransitGatewaySummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeTransitGatewaysCommand({ NextToken: nextToken }))
    for (const tgw of output.TransitGateways ?? []) {
      const tags = readTags(tgw.Tags)
      gateways.push({
        tgwId: tgw.TransitGatewayId ?? '-',
        state: tgw.State ?? '-',
        ownerId: tgw.OwnerId ?? '-',
        description: tgw.Description ?? '-',
        amazonSideAsn: String(tgw.Options?.AmazonSideAsn ?? '-'),
        name: tags.Name ?? '-',
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return gateways
}

export async function listNetworkInterfaces(connection: AwsConnection, vpcId?: string): Promise<NetworkInterfaceSummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const enis: NetworkInterfaceSummary[] = []
  let nextToken: string | undefined
  const filters = vpcId ? [{ Name: 'vpc-id', Values: [vpcId] }] : undefined

  do {
    const output = await client.send(new DescribeNetworkInterfacesCommand({ Filters: filters, NextToken: nextToken }))
    for (const eni of output.NetworkInterfaces ?? []) {
      const tags = readTags(eni.TagSet)
      enis.push({
        networkInterfaceId: eni.NetworkInterfaceId ?? '-',
        vpcId: eni.VpcId ?? '-',
        subnetId: eni.SubnetId ?? '-',
        availabilityZone: eni.AvailabilityZone ?? '-',
        privateIp: eni.PrivateIpAddress ?? '-',
        publicIp: eni.Association?.PublicIp ?? '-',
        status: eni.Status ?? '-',
        interfaceType: eni.InterfaceType ?? '-',
        description: eni.Description ?? '-',
        attachedInstanceId: eni.Attachment?.InstanceId ?? '-',
        securityGroups: (eni.Groups ?? []).map((g) => ({
          id: g.GroupId ?? '-',
          name: g.GroupName ?? '-'
        })),
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return enis
}

export async function listSecurityGroups(connection: AwsConnection, vpcId?: string): Promise<SecurityGroupSummary[]> {
  const client = getAwsClient(EC2Client, connection)
  const groups: SecurityGroupSummary[] = []
  let nextToken: string | undefined
  const filters = vpcId ? [{ Name: 'vpc-id', Values: [vpcId] }] : undefined

  do {
    const output = await client.send(new DescribeSecurityGroupsCommand({ Filters: filters, NextToken: nextToken }))
    for (const sg of output.SecurityGroups ?? []) {
      const tags = readTags(sg.Tags)

      function formatPort(from?: number, to?: number): string {
        if (from === undefined && to === undefined) return 'All'
        if (from === -1 || to === -1) return 'All'
        if (from === to) return String(from)
        return `${from}-${to}`
      }

      groups.push({
        groupId: sg.GroupId ?? '-',
        groupName: sg.GroupName ?? '-',
        vpcId: sg.VpcId ?? '-',
        description: sg.Description ?? '-',
        inboundRuleCount: sg.IpPermissions?.length ?? 0,
        outboundRuleCount: sg.IpPermissionsEgress?.length ?? 0,
        inboundRules: (sg.IpPermissions ?? []).map((rule) => ({
          protocol: rule.IpProtocol === '-1' ? 'All' : (rule.IpProtocol ?? '-'),
          portRange: formatPort(rule.FromPort, rule.ToPort),
          source: rule.IpRanges?.[0]?.CidrIp ?? rule.UserIdGroupPairs?.[0]?.GroupId ?? rule.PrefixListIds?.[0]?.PrefixListId ?? '-',
          description: rule.IpRanges?.[0]?.Description ?? ''
        })),
        outboundRules: (sg.IpPermissionsEgress ?? []).map((rule) => ({
          protocol: rule.IpProtocol === '-1' ? 'All' : (rule.IpProtocol ?? '-'),
          portRange: formatPort(rule.FromPort, rule.ToPort),
          destination: rule.IpRanges?.[0]?.CidrIp ?? rule.UserIdGroupPairs?.[0]?.GroupId ?? '-',
          description: rule.IpRanges?.[0]?.Description ?? ''
        })),
        tags
      })
    }
    nextToken = output.NextToken
  } while (nextToken)

  return groups
}

/* ── topology aggregation ─────────────────────────────────── */

export async function getVpcTopology(connection: AwsConnection, vpcId: string): Promise<VpcTopology> {
  const [vpcs, subnets, routeTables, internetGateways, natGateways] = await Promise.all([
    listVpcs(connection).then((all) => all.filter((v) => v.vpcId === vpcId)),
    listSubnets(connection, vpcId),
    listRouteTables(connection, vpcId),
    listInternetGateways(connection, vpcId),
    listNatGateways(connection, vpcId)
  ])

  return { vpcs, subnets, routeTables, internetGateways, natGateways }
}

/* ── flow diagram generation ──────────────────────────────── */

export async function getVpcFlowDiagram(connection: AwsConnection, vpcId: string): Promise<VpcFlowDiagramData> {
  const topology = await getVpcTopology(connection, vpcId)
  const nodes: VpcFlowDiagramData['nodes'] = []
  const edges: VpcFlowDiagramData['edges'] = []

  // VPC node
  const vpc = topology.vpcs[0]
  if (vpc) {
    nodes.push({ id: vpc.vpcId, type: 'vpc', label: vpc.name !== '-' ? vpc.name : vpc.vpcId, detail: vpc.cidrBlock })
  }

  // IGW nodes
  for (const igw of topology.internetGateways) {
    nodes.push({ id: igw.igwId, type: 'igw', label: igw.name !== '-' ? igw.name : igw.igwId, detail: igw.state })
    if (vpc) edges.push({ source: igw.igwId, target: vpc.vpcId, label: 'attached' })
  }

  // NAT nodes
  for (const nat of topology.natGateways) {
    nodes.push({ id: nat.natGatewayId, type: 'nat', label: nat.name !== '-' ? nat.name : nat.natGatewayId, detail: nat.publicIp })
    const subnetNode = topology.subnets.find((s) => s.subnetId === nat.subnetId)
    if (subnetNode) edges.push({ source: nat.natGatewayId, target: subnetNode.subnetId, label: 'in-subnet' })
  }

  // Subnet nodes
  for (const subnet of topology.subnets) {
    nodes.push({
      id: subnet.subnetId,
      type: 'subnet',
      label: subnet.name !== '-' ? subnet.name : subnet.subnetId,
      detail: `${subnet.cidrBlock} (${subnet.availabilityZone})`
    })
    if (vpc) edges.push({ source: subnet.subnetId, target: vpc.vpcId, label: 'in-vpc' })
  }

  // Route table nodes
  for (const rt of topology.routeTables) {
    nodes.push({
      id: rt.routeTableId,
      type: 'rtb',
      label: rt.name !== '-' ? rt.name : rt.routeTableId,
      detail: rt.isMain ? 'main' : `${rt.associatedSubnets.length} subnets`
    })
    for (const subnetId of rt.associatedSubnets) {
      edges.push({ source: rt.routeTableId, target: subnetId, label: 'routes' })
    }
    // Link to IGW if there's a route to one
    for (const route of rt.routes) {
      if (route.target.startsWith('igw-')) {
        edges.push({ source: rt.routeTableId, target: route.target, label: route.destination })
      }
      if (route.target.startsWith('nat-')) {
        edges.push({ source: rt.routeTableId, target: route.target, label: route.destination })
      }
    }
  }

  return { nodes, edges }
}

/* ── subnet edit ──────────────────────────────────────────── */

export async function updateSubnetAutoAssignPublicIp(
  connection: AwsConnection,
  subnetId: string,
  mapPublicIpOnLaunch: boolean
): Promise<void> {
  const client = getAwsClient(EC2Client, connection)
  await client.send(
    new ModifySubnetAttributeCommand({
      SubnetId: subnetId,
      MapPublicIpOnLaunch: { Value: mapPublicIpOnLaunch }
    })
  )
}

/* ── reachability analyzer ────────────────────────────────── */

export async function createReachabilityPath(
  connection: AwsConnection,
  sourceId: string,
  destinationId: string,
  protocol: string
): Promise<ReachabilityPathResult> {
  const client = getAwsClient(EC2Client, connection)

  const pathResult = await client.send(
    new CreateNetworkInsightsPathCommand({
      Source: sourceId,
      Destination: destinationId,
      Protocol: protocol as 'tcp' | 'udp',
      TagSpecifications: [
        {
          ResourceType: 'network-insights-path',
          Tags: [{ Key: 'Name', Value: `infra-lens-${Date.now()}` }]
        }
      ]
    })
  )

  const pathId = pathResult.NetworkInsightsPath?.NetworkInsightsPathId
  if (!pathId) throw new Error('Failed to create network insights path')

  const analysisResult = await client.send(
    new StartNetworkInsightsAnalysisCommand({
      NetworkInsightsPathId: pathId
    })
  )

  const analysisId = analysisResult.NetworkInsightsAnalysis?.NetworkInsightsAnalysisId ?? '-'

  return {
    analysisId,
    status: analysisResult.NetworkInsightsAnalysis?.Status ?? 'running',
    statusMessage: analysisResult.NetworkInsightsAnalysis?.StatusMessage ?? '',
    source: sourceId,
    destination: destinationId,
    protocol,
    reachable: null,
    explanations: []
  }
}

export async function getReachabilityAnalysis(
  connection: AwsConnection,
  analysisId: string
): Promise<ReachabilityPathResult> {
  const client = getAwsClient(EC2Client, connection)

  const output = await client.send(
    new DescribeNetworkInsightsAnalysesCommand({
      NetworkInsightsAnalysisIds: [analysisId]
    })
  )

  const analysis = output.NetworkInsightsAnalyses?.[0]
  if (!analysis) throw new Error(`Analysis ${analysisId} not found`)

  return {
    analysisId,
    status: analysis.Status ?? 'unknown',
    statusMessage: analysis.StatusMessage ?? '',
    source: analysis.NetworkInsightsPathId ?? '-',
    destination: '',
    protocol: '',
    reachable: analysis.NetworkPathFound ?? null,
    explanations: (analysis.Explanations ?? []).map(
      (exp) =>
        [
          exp.Direction ?? '',
          exp.ExplanationCode ?? '',
          exp.Component?.Id ?? '',
          exp.Subnet?.Id ?? '',
          exp.SecurityGroup?.Id ?? ''
        ]
          .filter(Boolean)
          .join(' | ')
    )
  }
}

export async function deleteReachabilityPath(connection: AwsConnection, pathId: string): Promise<void> {
  const client = getAwsClient(EC2Client, connection)
  await client.send(new DeleteNetworkInsightsPathCommand({ NetworkInsightsPathId: pathId }))
}

export async function deleteReachabilityAnalysis(connection: AwsConnection, analysisId: string): Promise<void> {
  const client = getAwsClient(EC2Client, connection)
  await client.send(new DeleteNetworkInsightsAnalysisCommand({ NetworkInsightsAnalysisId: analysisId }))
}
