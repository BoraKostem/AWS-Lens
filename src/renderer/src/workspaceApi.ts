import type {
  AwsConnection,
  AwsProfile,
  CallerIdentity,
  Ec2InstanceSummary,
  LoadBalancerWorkspace
} from '@shared/types'

type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string }

function bridge() {
  if (!window.awsLens) {
    throw new Error('AWS preload bridge did not load.')
  }
  return window.awsLens
}

function unwrap<T>(result: Wrapped<T>): T {
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.data
}

export async function listProfiles(): Promise<AwsProfile[]> {
  return unwrap((await bridge().listProfiles()) as Wrapped<AwsProfile[]>)
}

export async function getCallerIdentity(connection: AwsConnection): Promise<CallerIdentity> {
  return unwrap((await bridge().getCallerIdentity(connection)) as Wrapped<CallerIdentity>)
}

export async function listEc2Instances(connection: AwsConnection): Promise<Ec2InstanceSummary[]> {
  return unwrap((await bridge().listEc2Instances(connection)) as Wrapped<Ec2InstanceSummary[]>)
}

export async function listLoadBalancerWorkspaces(connection: AwsConnection): Promise<LoadBalancerWorkspace[]> {
  return unwrap((await bridge().listLoadBalancerWorkspaces(connection)) as Wrapped<LoadBalancerWorkspace[]>)
}

export async function deleteLoadBalancer(connection: AwsConnection, loadBalancerArn: string): Promise<void> {
  return unwrap((await bridge().deleteLoadBalancer(connection, loadBalancerArn)) as Wrapped<void>)
}
