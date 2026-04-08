import type {
  AwsConnection,
  SecurityGroupDetail,
  SecurityGroupRuleInput,
  SecurityGroupSummary
} from '@shared/types'
import { makeBridgeCall } from './bridgeUtils'

const call = makeBridgeCall(() => {
  if (!window.awsLens) throw new Error('AWS preload bridge did not load.')
  return window.awsLens
})

export const listSecurityGroups = call<[c: AwsConnection, vpcId?: string], SecurityGroupSummary[]>('listSecurityGroups')
export const describeSecurityGroup = call<[c: AwsConnection, groupId: string], SecurityGroupDetail | null>('describeSecurityGroup')
export const addInboundRule = call<[c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput], void>('addInboundRule')
export const revokeInboundRule = call<[c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput], void>('revokeInboundRule')
export const addOutboundRule = call<[c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput], void>('addOutboundRule')
export const revokeOutboundRule = call<[c: AwsConnection, groupId: string, rule: SecurityGroupRuleInput], void>('revokeOutboundRule')
