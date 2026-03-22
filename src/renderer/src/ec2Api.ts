import type {
  AwsConnection,
  BastionAmiOption,
  BastionConnectionInfo,
  BastionLaunchConfig,
  Ec2IamAssociation,
  Ec2InstanceAction,
  Ec2InstanceDetail,
  Ec2InstanceSummary,
  Ec2InstanceTypeOption,
  Ec2Recommendation,
  Ec2SnapshotSummary,
  Ec2VpcDetail,
  SnapshotLaunchConfig
} from '@shared/types'

type Wrapped<T> = { ok: true; data: T } | { ok: false; error: string }

function bridge() {
  if (!window.awsLens) {
    throw new Error('AWS preload bridge did not load.')
  }
  return window.awsLens
}

function unwrap<T>(result: Wrapped<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export async function listEc2Instances(c: AwsConnection): Promise<Ec2InstanceSummary[]> {
  return unwrap((await bridge().listEc2Instances(c)) as Wrapped<Ec2InstanceSummary[]>)
}

export async function describeEc2Instance(c: AwsConnection, id: string): Promise<Ec2InstanceDetail | null> {
  return unwrap((await bridge().describeEc2Instance(c, id)) as Wrapped<Ec2InstanceDetail | null>)
}

export async function runEc2InstanceAction(c: AwsConnection, id: string, action: Ec2InstanceAction): Promise<void> {
  return unwrap((await bridge().runEc2InstanceAction(c, id, action)) as Wrapped<void>)
}

export async function terminateEc2Instance(c: AwsConnection, id: string): Promise<void> {
  return unwrap((await bridge().terminateEc2Instance(c, id)) as Wrapped<void>)
}

export async function resizeEc2Instance(c: AwsConnection, id: string, type: string): Promise<void> {
  return unwrap((await bridge().resizeEc2Instance(c, id, type)) as Wrapped<void>)
}

export async function listInstanceTypes(c: AwsConnection, arch?: string, currentGenerationOnly?: boolean): Promise<Ec2InstanceTypeOption[]> {
  return unwrap((await bridge().listInstanceTypes(c, arch, currentGenerationOnly)) as Wrapped<Ec2InstanceTypeOption[]>)
}

export async function listEc2Snapshots(c: AwsConnection): Promise<Ec2SnapshotSummary[]> {
  return unwrap((await bridge().listEc2Snapshots(c)) as Wrapped<Ec2SnapshotSummary[]>)
}

export async function createEc2Snapshot(c: AwsConnection, volumeId: string, desc: string): Promise<string> {
  return unwrap((await bridge().createEc2Snapshot(c, volumeId, desc)) as Wrapped<string>)
}

export async function deleteEc2Snapshot(c: AwsConnection, snapshotId: string): Promise<void> {
  return unwrap((await bridge().deleteEc2Snapshot(c, snapshotId)) as Wrapped<void>)
}

export async function tagEc2Snapshot(c: AwsConnection, snapshotId: string, tags: Record<string, string>): Promise<void> {
  return unwrap((await bridge().tagEc2Snapshot(c, snapshotId, tags)) as Wrapped<void>)
}

export async function getIamAssociation(c: AwsConnection, id: string): Promise<Ec2IamAssociation | null> {
  return unwrap((await bridge().getIamAssociation(c, id)) as Wrapped<Ec2IamAssociation | null>)
}

export async function attachIamProfile(c: AwsConnection, id: string, name: string): Promise<void> {
  return unwrap((await bridge().attachIamProfile(c, id, name)) as Wrapped<void>)
}

export async function replaceIamProfile(c: AwsConnection, assocId: string, name: string): Promise<void> {
  return unwrap((await bridge().replaceIamProfile(c, assocId, name)) as Wrapped<void>)
}

export async function removeIamProfile(c: AwsConnection, assocId: string): Promise<void> {
  return unwrap((await bridge().removeIamProfile(c, assocId)) as Wrapped<void>)
}

export async function launchBastion(c: AwsConnection, config: BastionLaunchConfig): Promise<string> {
  return unwrap((await bridge().launchBastion(c, config)) as Wrapped<string>)
}

export async function findBastionConnectionsForInstance(c: AwsConnection, targetInstanceId: string): Promise<BastionConnectionInfo[]> {
  return unwrap((await bridge().findBastionConnectionsForInstance(c, targetInstanceId)) as Wrapped<BastionConnectionInfo[]>)
}

export async function deleteBastion(c: AwsConnection, targetInstanceId: string): Promise<void> {
  return unwrap((await bridge().deleteBastion(c, targetInstanceId)) as Wrapped<void>)
}

export async function listBastions(c: AwsConnection): Promise<Ec2InstanceSummary[]> {
  return unwrap((await bridge().listBastions(c)) as Wrapped<Ec2InstanceSummary[]>)
}

export async function listPopularBastionAmis(c: AwsConnection, architecture?: string): Promise<BastionAmiOption[]> {
  return unwrap((await bridge().listPopularBastionAmis(c, architecture)) as Wrapped<BastionAmiOption[]>)
}

export async function describeVpc(c: AwsConnection, vpcId: string): Promise<Ec2VpcDetail | null> {
  return unwrap((await bridge().describeVpc(c, vpcId)) as Wrapped<Ec2VpcDetail | null>)
}

export async function launchFromSnapshot(c: AwsConnection, config: SnapshotLaunchConfig): Promise<string> {
  return unwrap((await bridge().launchFromSnapshot(c, config)) as Wrapped<string>)
}

export async function sendSshPublicKey(
  c: AwsConnection,
  id: string,
  osUser: string,
  pubKey: string,
  az: string
): Promise<boolean> {
  return unwrap((await bridge().sendSshPublicKey(c, id, osUser, pubKey, az)) as Wrapped<boolean>)
}

export async function getEc2Recommendations(c: AwsConnection): Promise<Ec2Recommendation[]> {
  return unwrap((await bridge().getEc2Recommendations(c)) as Wrapped<Ec2Recommendation[]>)
}
