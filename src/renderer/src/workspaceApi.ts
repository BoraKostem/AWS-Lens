import type {
  AwsConnection,
  AwsProfile,
  CallerIdentity,
  Ec2InstanceSummary,
  LoadBalancerWorkspace
} from '@shared/types'
import { makeBridgeCall } from './bridgeUtils'

const call = makeBridgeCall(() => {
  if (!window.awsLens) throw new Error('AWS preload bridge did not load.')
  return window.awsLens
})

export const listProfiles = call<[], AwsProfile[]>('listProfiles')
export const getCallerIdentity = call<[connection: AwsConnection], CallerIdentity>('getCallerIdentity')
export const listEc2Instances = call<[connection: AwsConnection], Ec2InstanceSummary[]>('listEc2Instances')
export const listLoadBalancerWorkspaces = call<[connection: AwsConnection], LoadBalancerWorkspace[]>('listLoadBalancerWorkspaces')
export const deleteLoadBalancer = call<[connection: AwsConnection, loadBalancerArn: string], void>('deleteLoadBalancer')
