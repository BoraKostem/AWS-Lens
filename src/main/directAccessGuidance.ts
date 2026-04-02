import type {
  DirectAccessIdentifierMatch,
  DirectAccessPlaybook,
  DirectAccessPlaybookStep,
  DirectAccessResolution,
  DirectAccessServiceTarget
} from '@shared/types'

type MatchBuilder = {
  target: DirectAccessServiceTarget
  confidence: 'high' | 'medium'
  reason: string
  values: Record<string, string>
}

function buildStep(
  id: string,
  title: string,
  detail: string,
  kind: DirectAccessPlaybookStep['kind']
): DirectAccessPlaybookStep {
  return { id, title, detail, kind }
}

function buildCloudWatchQuery(sourceLabel: string): string {
  return [
    'fields @timestamp, @logStream, @message',
    `| filter @message like /(?i)(${escapeRegex(sourceLabel)}|error|exception|timeout|denied)/`,
    '| sort @timestamp desc',
    '| limit 100'
  ].join('\n')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function playbookForMatch(match: DirectAccessIdentifierMatch): DirectAccessPlaybook {
  const commonSteps: DirectAccessPlaybookStep[] = [
    buildStep(
      'lookup',
      'Run a direct describe path first',
      'Start with the exact identifier from the ticket, alert, or console URL before broader list calls in restricted IAM environments.',
      'lookup'
    ),
    buildStep(
      'permissions',
      'Prefer read-only fallback permissions',
      'If AccessDenied occurs, keep the workflow on describe and list access only, then document the smallest missing permission set instead of escalating to broad console access.',
      'permission'
    )
  ]

  switch (match.target) {
    case 'ec2':
      return {
        id: `ec2:${match.values.instanceId}`,
        target: match.target,
        title: 'EC2 incident playbook',
        description: 'Confirm instance state, networking, keypair, SSM posture, and attached security groups before pivoting into EC2 or CloudWatch.',
        supportLevel: 'supported',
        requiredFields: ['instanceId'],
        suggestedFocus: { service: 'ec2', instanceId: match.values.instanceId, tab: 'instances' },
        steps: [
          ...commonSteps,
          buildStep('checks', 'Confirm state and health', 'Capture state, launch details, IAM profile, security groups, and any SSM diagnostics tied to the instance.', 'lookup'),
          buildStep('navigate', 'Open the EC2 console with focus', 'Hand off into the EC2 console using the same instance id once the targeted lookup succeeds.', 'navigate')
        ]
      }
    case 'security-group':
      return {
        id: `sg:${match.values.securityGroupId}`,
        target: match.target,
        title: 'Security Group rule playbook',
        description: 'Review inbound and outbound rule posture directly from the group id, then continue in the Security Groups console with that same target.',
        supportLevel: 'supported',
        requiredFields: ['securityGroupId'],
        suggestedFocus: { service: 'security-groups', securityGroupId: match.values.securityGroupId },
        steps: [
          ...commonSteps,
          buildStep('checks', 'Check ingress and egress intent', 'Look for open CIDRs, referenced groups, and unusual port ranges before broad network exploration.', 'lookup'),
          buildStep('navigate', 'Open the Security Groups console', 'Continue in the focused Security Groups workspace after the direct describe output is captured.', 'navigate')
        ]
      }
    case 'load-balancer':
      return {
        id: `lb:${match.values.loadBalancerArn}`,
        target: match.target,
        title: 'Load Balancer triage playbook',
        description: 'Inspect the load balancer summary, listeners, target groups, and recent health timeline from the ARN before broader discovery.',
        supportLevel: 'supported',
        requiredFields: ['loadBalancerArn'],
        suggestedFocus: { service: 'load-balancers', loadBalancerArn: match.values.loadBalancerArn },
        steps: [
          ...commonSteps,
          buildStep('checks', 'Check listeners and target health', 'Verify active listeners, forwarding rules, target group health, and obvious timeline anomalies for the matched load balancer.', 'lookup'),
          buildStep('navigate', 'Open the load balancer console', 'Hand off into the load balancer workspace with the same ARN in focus.', 'navigate')
        ]
      }
    case 'cloudwatch-log-group':
      return {
        id: `log-group:${match.values.logGroupName}`,
        target: match.target,
        title: 'CloudWatch Logs playbook',
        description: 'Use the matched log group as the anchor for read-only incident triage, recent event review, and a scoped Logs Insights handoff.',
        supportLevel: 'supported',
        requiredFields: ['logGroupName'],
        suggestedFocus: {
          service: 'cloudwatch',
          logGroupNames: [match.values.logGroupName],
          sourceLabel: match.values.logGroupName,
          serviceHint: 'cloudwatch',
          queryString: buildCloudWatchQuery(match.values.logGroupName)
        },
        steps: [
          ...commonSteps,
          buildStep('checks', 'Inspect recent events first', 'Check the latest log streams and event volume before widening into a longer time range or broader query.', 'lookup'),
          buildStep('navigate', 'Open CloudWatch with scoped log groups', 'Carry the matched log group into the CloudWatch console instead of searching across the whole account.', 'navigate')
        ]
      }
    case 'iam-role':
      return {
        id: `iam-role:${match.values.roleArn ?? match.values.roleName}`,
        target: match.target,
        title: 'IAM role review playbook',
        description: 'Capture the exact role, trust policy, and attached policies, then document any missing read-only IAM permissions precisely.',
        supportLevel: 'partial',
        requiredFields: ['roleName'],
        suggestedFocus: null,
        steps: [
          ...commonSteps,
          buildStep('checks', 'Collect trust and policy context', 'Gather trust policy, attached managed policies, and inline policies for the matched role before broader IAM navigation.', 'lookup'),
          buildStep('command', 'Escalate with the smallest permission delta', 'If a list or get action is blocked, record only the specific missing iam:Get* or iam:List* permission instead of requesting broad administrator access.', 'command')
        ]
      }
    case 'iam-user':
      return {
        id: `iam-user:${match.values.userArn ?? match.values.userName}`,
        target: match.target,
        title: 'IAM user review playbook',
        description: 'Capture access keys, MFA posture, group membership, and attached policies directly from the user identifier before switching consoles.',
        supportLevel: 'partial',
        requiredFields: ['userName'],
        suggestedFocus: null,
        steps: [
          ...commonSteps,
          buildStep('checks', 'Collect authentication posture', 'Review access key status, MFA devices, group membership, and policy attachments for the matched user.', 'lookup'),
          buildStep('command', 'Document exact missing read actions', 'Request only the required iam:List* or iam:Get* permissions that blocked the lookup.', 'command')
        ]
      }
    case 'iam-policy':
      return {
        id: `iam-policy:${match.values.policyArn ?? match.values.policyName}`,
        target: match.target,
        title: 'IAM policy review playbook',
        description: 'Capture the matched managed policy, enumerate versions, and inspect the default document before broader IAM exploration.',
        supportLevel: 'partial',
        requiredFields: ['policyArn'],
        suggestedFocus: null,
        steps: [
          ...commonSteps,
          buildStep('checks', 'Inspect the default policy version', 'Review version history and fetch the default document to confirm current permissions and recent changes.', 'lookup'),
          buildStep('command', 'Capture permission gaps narrowly', 'If access is denied, request only the missing policy list or get operation needed for the matched ARN.', 'command')
        ]
      }
    default:
      return {
        id: `${match.target}:${Object.values(match.values)[0] ?? match.target}`,
        target: match.target,
        title: 'Direct access playbook',
        description: 'Use the matched identifier to stay on the narrowest read-only lookup path.',
        supportLevel: 'partial',
        requiredFields: Object.keys(match.values),
        suggestedFocus: null,
        steps: commonSteps
      }
  }
}

function toMatch(builder: MatchBuilder): DirectAccessIdentifierMatch {
  return {
    target: builder.target,
    confidence: builder.confidence,
    reason: builder.reason,
    values: builder.values
  }
}

function matchKey(builder: MatchBuilder): string {
  return `${builder.target}:${JSON.stringify(builder.values)}`
}

function normalizeDecodedVariants(input: string): string[] {
  const variants = new Set<string>()
  let current = input.trim()
  if (!current) return []
  variants.add(current)
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(current)
      if (!decoded || decoded === current) break
      variants.add(decoded)
      current = decoded
    } catch {
      break
    }
  }
  return Array.from(variants)
}

function firstMatch(input: string, expression: RegExp): string | null {
  const match = expression.exec(input)
  return match?.[0] ?? null
}

function addMatch(
  builders: MatchBuilder[],
  seen: Set<string>,
  builder: MatchBuilder
): void {
  const key = matchKey(builder)
  if (seen.has(key)) return
  seen.add(key)
  builders.push(builder)
}

function extractConsoleSegment(input: string, marker: string): string | null {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`${escapedMarker}([^?#]+)`, 'i')
  const raw = input.match(expression)?.[1]?.trim()
  if (!raw) return null
  const cleaned = raw.split(/[?#]/)[0]?.replace(/\/+$/, '').trim()
  return cleaned || null
}

export function resolveDirectAccessInput(input: string): DirectAccessResolution {
  const normalized = input.trim()
  const builders: MatchBuilder[] = []
  const seen = new Set<string>()

  if (!normalized) {
    return {
      input: normalized,
      matches: [],
      playbooks: []
    }
  }

  const variants = normalizeDecodedVariants(normalized)
  for (const variant of variants) {
    const instanceId = firstMatch(variant, /\bi-[a-z0-9]{8,}\b/i)
    if (instanceId) {
      addMatch(builders, seen, {
        target: 'ec2',
        confidence: 'high',
        reason: 'EC2 instance ids use the i-* identifier format.',
        values: { instanceId }
      })
    }

    const securityGroupId = firstMatch(variant, /\bsg-[a-z0-9]{8,}\b/i)
    if (securityGroupId) {
      addMatch(builders, seen, {
        target: 'security-group',
        confidence: 'high',
        reason: 'Security group ids use the sg-* identifier format.',
        values: { securityGroupId }
      })
    }

    const loadBalancerArn = firstMatch(variant, /arn:aws[a-z-]*:elasticloadbalancing:[^\s"'<>]+/i)
    if (loadBalancerArn) {
      addMatch(builders, seen, {
        target: 'load-balancer',
        confidence: 'high',
        reason: 'The identifier contains an Elastic Load Balancing ARN.',
        values: { loadBalancerArn }
      })
    }

    const roleArn = firstMatch(variant, /arn:aws[a-z-]*:iam::\d+:role\/[^\s"'<>]+/i)
    if (roleArn) {
      addMatch(builders, seen, {
        target: 'iam-role',
        confidence: 'high',
        reason: 'The identifier points to an IAM role ARN.',
        values: {
          roleArn,
          roleName: roleArn.split('/').pop() ?? roleArn
        }
      })
    }

    const roleNameFromUrl = extractConsoleSegment(variant, '/roles/details/')
    if (roleNameFromUrl) {
      addMatch(builders, seen, {
        target: 'iam-role',
        confidence: 'medium',
        reason: 'The console URL path points to an IAM role details page.',
        values: { roleName: roleNameFromUrl }
      })
    }

    const userArn = firstMatch(variant, /arn:aws[a-z-]*:iam::\d+:user\/[^\s"'<>]+/i)
    if (userArn) {
      addMatch(builders, seen, {
        target: 'iam-user',
        confidence: 'high',
        reason: 'The identifier points to an IAM user ARN.',
        values: {
          userArn,
          userName: userArn.split('/').pop() ?? userArn
        }
      })
    }

    const userNameFromUrl = extractConsoleSegment(variant, '/users/details/')
    if (userNameFromUrl) {
      addMatch(builders, seen, {
        target: 'iam-user',
        confidence: 'medium',
        reason: 'The console URL path points to an IAM user details page.',
        values: { userName: userNameFromUrl }
      })
    }

    const policyArn = firstMatch(variant, /arn:aws[a-z-]*:iam::\d+:policy\/[^\s"'<>]+/i)
    if (policyArn) {
      addMatch(builders, seen, {
        target: 'iam-policy',
        confidence: 'high',
        reason: 'The identifier points to an IAM managed policy ARN.',
        values: {
          policyArn,
          policyName: policyArn.split('/').pop() ?? policyArn
        }
      })
    }

    const policyNameFromUrl = extractConsoleSegment(variant, '/policies/details/')
    if (policyNameFromUrl) {
      addMatch(builders, seen, {
        target: 'iam-policy',
        confidence: 'medium',
        reason: 'The console URL path points to an IAM policy details page.',
        values: { policyName: policyNameFromUrl }
      })
    }

    const logGroupArnMatch = variant.match(/arn:aws[a-z-]*:logs:[^:]+:\d+:log-group:([^:\s"'<>]+)(?::[^\s"'<>]+)?/i)
    const logGroupNameFromArn = logGroupArnMatch?.[1]?.trim()
    if (logGroupNameFromArn) {
      addMatch(builders, seen, {
        target: 'cloudwatch-log-group',
        confidence: 'high',
        reason: 'The identifier points to a CloudWatch Logs log group ARN.',
        values: { logGroupName: logGroupNameFromArn }
      })
    }

    const logGroupFromUrl = extractConsoleSegment(variant, 'log-group/')
    if (logGroupFromUrl && logGroupFromUrl.startsWith('/')) {
      addMatch(builders, seen, {
        target: 'cloudwatch-log-group',
        confidence: 'medium',
        reason: 'The console URL path points to a CloudWatch log group.',
        values: { logGroupName: logGroupFromUrl }
      })
    }

    const logGroupName = firstMatch(variant, /\/aws\/[^\s"'<>]+/i)
    if (logGroupName) {
      addMatch(builders, seen, {
        target: 'cloudwatch-log-group',
        confidence: 'medium',
        reason: 'Names that start with /aws/ often refer to CloudWatch log groups.',
        values: { logGroupName }
      })
    }
  }

  const matches = builders.map((builder) => toMatch(builder))
  return {
    input: normalized,
    matches,
    playbooks: matches.map((match) => playbookForMatch(match))
  }
}
