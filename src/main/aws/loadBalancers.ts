import {
  DeleteLoadBalancerCommand,
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client
} from '@aws-sdk/client-elastic-load-balancing-v2'

import type {
  AwsConnection,
  LoadBalancerListener,
  LoadBalancerRule,
  LoadBalancerSummary,
  LoadBalancerTargetGroup,
  LoadBalancerTargetHealth,
  LoadBalancerTimelineEvent,
  LoadBalancerWorkspace
} from '@shared/types'
import { awsClientConfig } from './client'

function createClient(connection: AwsConnection): ElasticLoadBalancingV2Client {
  return new ElasticLoadBalancingV2Client(awsClientConfig(connection))
}

function formatAction(action: Record<string, unknown>): string {
  const type = typeof action.Type === 'string' ? action.Type : 'unknown'
  if (type === 'forward') {
    const targetGroupArn = typeof action.TargetGroupArn === 'string' ? action.TargetGroupArn.split('/').at(-2) : ''
    return targetGroupArn ? `forward:${targetGroupArn}` : 'forward'
  }
  if (type === 'redirect') {
    return 'redirect'
  }
  if (type === 'fixed-response') {
    return 'fixed-response'
  }
  return type
}

function formatCondition(condition: Record<string, unknown>): string {
  const field = typeof condition.Field === 'string' ? condition.Field : 'condition'
  const values = Array.isArray(condition.Values)
    ? condition.Values.filter((value): value is string => typeof value === 'string')
    : []
  if (values.length) {
    return `${field}: ${values.join(', ')}`
  }
  const hostConfig = condition.HostHeaderConfig as { Values?: string[] } | undefined
  if (hostConfig?.Values?.length) {
    return `${field}: ${hostConfig.Values.join(', ')}`
  }
  const pathConfig = condition.PathPatternConfig as { Values?: string[] } | undefined
  if (pathConfig?.Values?.length) {
    return `${field}: ${pathConfig.Values.join(', ')}`
  }
  return field
}

function buildTimeline(workspace: Omit<LoadBalancerWorkspace, 'timeline'>): LoadBalancerTimelineEvent[] {
  const events: LoadBalancerTimelineEvent[] = [
    {
      id: `${workspace.summary.arn}:created`,
      timestamp: workspace.summary.createdTime,
      title: 'Load balancer created',
      detail: `${workspace.summary.name} entered state ${workspace.summary.state}.`,
      severity: 'info'
    },
    {
      id: `${workspace.summary.arn}:listeners`,
      timestamp: workspace.summary.createdTime,
      title: 'Listeners discovered',
      detail: `${workspace.listeners.length} listeners and ${workspace.targetGroups.length} target groups loaded.`,
      severity: 'info'
    }
  ]

  for (const targetGroup of workspace.targetGroups) {
    const targets = workspace.targetsByGroup[targetGroup.arn] ?? []
    const unhealthy = targets.filter((target) => target.state !== 'healthy')
    events.push({
      id: `${targetGroup.arn}:health`,
      timestamp: workspace.summary.createdTime,
      title: `Target group ${targetGroup.name}`,
      detail: unhealthy.length
        ? `${unhealthy.length} targets are not healthy.`
        : `All ${targets.length} targets are healthy.`,
      severity: unhealthy.length ? 'warning' : 'info'
    })
  }

  for (const listener of workspace.listeners) {
    const ruleCount = workspace.rulesByListener[listener.arn]?.length ?? 0
    events.push({
      id: `${listener.arn}:rules`,
      timestamp: workspace.summary.createdTime,
      title: `Listener ${listener.protocol}:${listener.port}`,
      detail: `${ruleCount} rules loaded for this listener.`,
      severity: 'info'
    })
  }

  return events.sort((left, right) => right.timestamp.localeCompare(left.timestamp))
}

export async function listLoadBalancerWorkspaces(connection: AwsConnection): Promise<LoadBalancerWorkspace[]> {
  const client = createClient(connection)
  const loadBalancers = await client.send(new DescribeLoadBalancersCommand({}))

  return await Promise.all(
    (loadBalancers.LoadBalancers ?? []).map(async (loadBalancer: any): Promise<LoadBalancerWorkspace> => {
      const summary: LoadBalancerSummary = {
        arn: loadBalancer.LoadBalancerArn ?? '',
        name: loadBalancer.LoadBalancerName ?? '',
        dnsName: loadBalancer.DNSName ?? '',
        type: loadBalancer.Type ?? '',
        scheme: loadBalancer.Scheme ?? '',
        state: loadBalancer.State?.Code ?? '',
        vpcId: loadBalancer.VpcId ?? '',
        availabilityZones: (loadBalancer.AvailabilityZones ?? [])
          .map((zone: { ZoneName?: string }) => zone.ZoneName ?? '')
          .filter(Boolean),
        securityGroups: loadBalancer.SecurityGroups ?? [],
        createdTime: loadBalancer.CreatedTime?.toISOString() ?? ''
      }

      const listenerResponse = summary.arn
        ? await client.send(new DescribeListenersCommand({ LoadBalancerArn: summary.arn }))
        : { Listeners: [] }

      const targetGroupResponse = summary.arn
        ? await client.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: summary.arn }))
        : { TargetGroups: [] }

      const listeners: LoadBalancerListener[] = (listenerResponse.Listeners ?? []).map((listener: any) => ({
        arn: listener.ListenerArn ?? '',
        port: listener.Port ?? 0,
        protocol: listener.Protocol ?? '',
        sslPolicy: listener.SslPolicy ?? '',
        certificates: (listener.Certificates ?? []).map((cert: { CertificateArn?: string }) => cert.CertificateArn ?? '').filter(Boolean),
        defaultActions: (listener.DefaultActions ?? []).map((action: Record<string, unknown>) => formatAction(action))
      }))

      const rulesByListener = Object.fromEntries(
        await Promise.all(
          listeners.map(async (listener) => {
            const ruleResponse = listener.arn
              ? await client.send(new DescribeRulesCommand({ ListenerArn: listener.arn }))
              : { Rules: [] }
            const rules: LoadBalancerRule[] = (ruleResponse.Rules ?? []).map((rule: any) => ({
              arn: rule.RuleArn ?? '',
              listenerArn: listener.arn,
              priority: rule.Priority ?? '',
              isDefault: rule.IsDefault ?? false,
              conditions: (rule.Conditions ?? []).map((condition: Record<string, unknown>) => formatCondition(condition)),
              actions: (rule.Actions ?? []).map((action: Record<string, unknown>) => formatAction(action))
            }))
            return [listener.arn, rules]
          })
        )
      )

      const targetGroups: LoadBalancerTargetGroup[] = (targetGroupResponse.TargetGroups ?? []).map((group: { TargetGroupArn?: string; TargetGroupName?: string; Protocol?: string; Port?: number; TargetType?: string; VpcId?: string; LoadBalancerArns?: string[]; HealthCheckProtocol?: string; HealthCheckPort?: string; HealthCheckPath?: string; HealthCheckIntervalSeconds?: number; HealthCheckTimeoutSeconds?: number; HealthyThresholdCount?: number; UnhealthyThresholdCount?: number; Matcher?: { HttpCode?: string } }) => ({
        arn: group.TargetGroupArn ?? '',
        name: group.TargetGroupName ?? '',
        protocol: group.Protocol ?? '',
        port: group.Port ?? 0,
        targetType: group.TargetType ?? '',
        vpcId: group.VpcId ?? '',
        loadBalancerArns: group.LoadBalancerArns ?? [],
        healthCheck: {
          protocol: group.HealthCheckProtocol ?? '',
          port: group.HealthCheckPort ?? '',
          path: group.HealthCheckPath ?? '',
          intervalSeconds: group.HealthCheckIntervalSeconds ?? 0,
          timeoutSeconds: group.HealthCheckTimeoutSeconds ?? 0,
          healthyThreshold: group.HealthyThresholdCount ?? 0,
          unhealthyThreshold: group.UnhealthyThresholdCount ?? 0,
          matcher: group.Matcher?.HttpCode ?? ''
        }
      }))

      const targetsByGroup = Object.fromEntries(
        await Promise.all(
          targetGroups.map(async (group) => {
            const healthResponse = group.arn
              ? await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: group.arn }))
              : { TargetHealthDescriptions: [] }
            const targets: LoadBalancerTargetHealth[] = (healthResponse.TargetHealthDescriptions ?? []).map((item: { Target?: { Id?: string; Port?: number; AvailabilityZone?: string }; TargetHealth?: { State?: string; Reason?: string; Description?: string } }) => ({
              id: item.Target?.Id ?? '',
              port: item.Target?.Port ?? null,
              availabilityZone: item.Target?.AvailabilityZone ?? '',
              state: item.TargetHealth?.State ?? '',
              reason: item.TargetHealth?.Reason ?? '',
              description: item.TargetHealth?.Description ?? ''
            }))
            return [group.arn, targets]
          })
        )
      )

      const base = {
        summary,
        listeners,
        rulesByListener,
        targetGroups,
        targetsByGroup
      }

      return {
        ...base,
        timeline: buildTimeline(base)
      }
    })
  )
}

export async function deleteLoadBalancer(connection: AwsConnection, loadBalancerArn: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: loadBalancerArn }))
}
