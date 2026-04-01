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

function playbookForMatch(match: DirectAccessIdentifierMatch): DirectAccessPlaybook {
  const commonSteps: DirectAccessPlaybookStep[] = [
    buildStep(
      'lookup',
      'Run a direct describe path first',
      'Use the exact identifier from the ticket or alert payload before broad list calls in restricted IAM environments.',
      'lookup'
    ),
    buildStep(
      'permissions',
      'Prefer read-only fallback permissions',
      'If AccessDenied occurs, keep the flow on describe/list permissions and collect the minimal permission gap instead of escalating immediately.',
      'permission'
    )
  ]

  switch (match.target) {
    case 'ec2':
      return {
        id: `ec2:${match.values.instanceId}`,
        target: match.target,
        title: 'EC2 support playbook',
        description: 'Validate instance posture first, then pivot into EC2 or CloudWatch using the same known identifier.',
        supportLevel: 'supported',
        requiredFields: ['instanceId'],
        suggestedFocus: { service: 'ec2', instanceId: match.values.instanceId, tab: 'instances' },
        steps: [
          ...commonSteps,
          buildStep('navigate', 'Open EC2 inventory with focus', 'Continue in the EC2 console with the instance preselected once the direct lookup succeeds.', 'navigate')
        ]
      }
    case 'security-group':
      return {
        id: `sg:${match.values.securityGroupId}`,
        target: match.target,
        title: 'Security Group support playbook',
        description: 'Inspect rule posture and then continue in the Security Groups console with the same group id.',
        supportLevel: 'supported',
        requiredFields: ['securityGroupId'],
        suggestedFocus: { service: 'security-groups', securityGroupId: match.values.securityGroupId },
        steps: [
          ...commonSteps,
          buildStep('navigate', 'Open the security group workspace', 'Use the direct lookup output to jump into the Security Groups console with the target group selected.', 'navigate')
        ]
      }
    case 'load-balancer':
      return {
        id: `lb:${match.values.loadBalancerArn}`,
        target: match.target,
        title: 'Load Balancer support playbook',
        description: 'Inspect listeners, target health, and related posture using the known ARN before broader discovery.',
        supportLevel: 'supported',
        requiredFields: ['loadBalancerArn'],
        suggestedFocus: { service: 'load-balancers', loadBalancerArn: match.values.loadBalancerArn },
        steps: [
          ...commonSteps,
          buildStep('navigate', 'Open the load balancer workspace', 'Continue in the load balancer console with the selected ARN once the describe path succeeds.', 'navigate')
        ]
      }
    case 'cloudwatch-log-group':
      return {
        id: `log-group:${match.values.logGroupName}`,
        target: match.target,
        title: 'CloudWatch log group support playbook',
        description: 'Use the log group as the anchor for read-only incident triage and hand off into CloudWatch queries later.',
        supportLevel: 'supported',
        requiredFields: ['logGroupName'],
        suggestedFocus: { service: 'cloudwatch', logGroupNames: [match.values.logGroupName] },
        steps: [
          ...commonSteps,
          buildStep('navigate', 'Open CloudWatch with scoped log groups', 'Carry the matched log group into the CloudWatch console instead of searching across the whole account.', 'navigate')
        ]
      }
    case 'iam-role':
    case 'iam-user':
    case 'iam-policy':
      return {
        id: `iam:${match.target}:${Object.values(match.values)[0]}`,
        target: match.target,
        title: 'IAM support playbook',
        description: 'Collect the exact IAM identity or policy target first, then document any read-only permission gap precisely.',
        supportLevel: 'partial',
        requiredFields: Object.keys(match.values),
        suggestedFocus: null,
        steps: [
          ...commonSteps,
          buildStep('command', 'Capture the permission gap', 'Record the minimal missing list/describe action instead of requesting broad IAM console access.', 'command')
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

export function resolveDirectAccessInput(input: string): DirectAccessResolution {
  const normalized = input.trim()
  const matches: DirectAccessIdentifierMatch[] = []

  if (!normalized) {
    return {
      input: normalized,
      matches: [],
      playbooks: []
    }
  }

  if (/^i-[a-z0-9]+$/i.test(normalized)) {
    matches.push(toMatch({
      target: 'ec2',
      confidence: 'high',
      reason: 'EC2 instance ids use the i-* identifier format.',
      values: { instanceId: normalized }
    }))
  }

  if (/^sg-[a-z0-9]+$/i.test(normalized)) {
    matches.push(toMatch({
      target: 'security-group',
      confidence: 'high',
      reason: 'Security group ids use the sg-* identifier format.',
      values: { securityGroupId: normalized }
    }))
  }

  if (/^arn:aws:elasticloadbalancing:/i.test(normalized)) {
    matches.push(toMatch({
      target: 'load-balancer',
      confidence: 'high',
      reason: 'The ARN matches the Elastic Load Balancing service namespace.',
      values: { loadBalancerArn: normalized }
    }))
  }

  if (/^arn:aws:iam::\d+:role\//i.test(normalized)) {
    matches.push(toMatch({
      target: 'iam-role',
      confidence: 'high',
      reason: 'The ARN points to an IAM role.',
      values: {
        roleArn: normalized,
        roleName: normalized.split('/').pop() ?? normalized
      }
    }))
  }

  if (/^arn:aws:iam::\d+:user\//i.test(normalized)) {
    matches.push(toMatch({
      target: 'iam-user',
      confidence: 'high',
      reason: 'The ARN points to an IAM user.',
      values: {
        userArn: normalized,
        userName: normalized.split('/').pop() ?? normalized
      }
    }))
  }

  if (/^arn:aws:iam::\d+:policy\//i.test(normalized)) {
    matches.push(toMatch({
      target: 'iam-policy',
      confidence: 'high',
      reason: 'The ARN points to an IAM managed policy.',
      values: {
        policyArn: normalized,
        policyName: normalized.split('/').pop() ?? normalized
      }
    }))
  }

  if (/^arn:aws:logs:/i.test(normalized)) {
    const parts = normalized.split(':log-group:')
    const logGroupName = parts[1]?.split(':')[0]?.trim() ?? ''
    if (logGroupName) {
      matches.push(toMatch({
        target: 'cloudwatch-log-group',
        confidence: 'high',
        reason: 'The ARN points to a CloudWatch Logs log group.',
        values: { logGroupName }
      }))
    }
  }

  if (normalized.startsWith('/aws/')) {
    matches.push(toMatch({
      target: 'cloudwatch-log-group',
      confidence: 'medium',
      reason: 'Names that start with /aws/ often refer to CloudWatch log groups.',
      values: { logGroupName: normalized }
    }))
  }

  return {
    input: normalized,
    matches,
    playbooks: matches.map((match) => playbookForMatch(match))
  }
}
