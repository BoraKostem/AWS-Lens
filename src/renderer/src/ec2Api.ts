import type {
  AwsConnection,
  BastionAmiOption,
  BastionConnectionInfo,
  BastionLaunchConfig,
  Ec2BulkInstanceAction,
  Ec2ChosenSshKey,
  Ec2BulkInstanceActionResult,
  Ec2IamAssociation,
  Ec2InstanceAction,
  Ec2InstanceDetail,
  Ec2InstanceSummary,
  Ec2InstanceTypeOption,
  Ec2Recommendation,
  Ec2SnapshotSummary,
  Ec2VpcDetail,
  EbsTempInspectionEnvironment,
  EbsTempInspectionProgress,
  EbsVolumeAttachRequest,
  EbsVolumeDetail,
  EbsVolumeDetachRequest,
  EbsVolumeModifyRequest,
  EbsVolumeSummary,
  Ec2SshKeySuggestion,
  SsmCommandExecutionResult,
  SsmConnectionTarget,
  SsmManagedInstanceSummary,
  SsmSendCommandRequest,
  SsmSessionLaunchSpec,
  SsmSessionSummary,
  SsmStartSessionRequest,
  SnapshotLaunchConfig
} from '@shared/types'
import { trackedAwsBridge } from './api'
import { makeBridgeCall } from './bridgeUtils'

const call = makeBridgeCall(trackedAwsBridge)

export const chooseEc2SshKey = call<[], Ec2ChosenSshKey | null>('chooseEc2SshKey')
export const listEc2SshKeySuggestions = call<[preferredKeyName?: string], Ec2SshKeySuggestion[]>('listEc2SshKeySuggestions')
export const materializeEc2VaultSshKey = call<[entryId: string], string>('materializeEc2VaultSshKey')
export const listEc2Instances = call<[c: AwsConnection], Ec2InstanceSummary[]>('listEc2Instances')
export const listEbsVolumes = call<[c: AwsConnection], EbsVolumeSummary[]>('listEbsVolumes')
export const describeEc2Instance = call<[c: AwsConnection, id: string], Ec2InstanceDetail | null>('describeEc2Instance')
export const describeEbsVolume = call<[c: AwsConnection, id: string], EbsVolumeDetail | null>('describeEbsVolume')
export const tagEbsVolume = call<[c: AwsConnection, id: string, tags: Record<string, string>], void>('tagEbsVolume')
export const untagEbsVolume = call<[c: AwsConnection, id: string, tagKeys: string[]], void>('untagEbsVolume')
export const attachEbsVolume = call<[c: AwsConnection, id: string, request: EbsVolumeAttachRequest], void>('attachEbsVolume')
export const detachEbsVolume = call<[c: AwsConnection, id: string, request?: EbsVolumeDetachRequest], void>('detachEbsVolume')
export const deleteEbsVolume = call<[c: AwsConnection, id: string], void>('deleteEbsVolume')
export const modifyEbsVolume = call<[c: AwsConnection, id: string, request: EbsVolumeModifyRequest], void>('modifyEbsVolume')
export const runEc2InstanceAction = call<[c: AwsConnection, id: string, action: Ec2InstanceAction], void>('runEc2InstanceAction')
export const runEc2BulkInstanceAction = call<[c: AwsConnection, ids: string[], action: Ec2BulkInstanceAction], Ec2BulkInstanceActionResult>('runEc2BulkInstanceAction')
export const terminateEc2Instance = call<[c: AwsConnection, id: string], void>('terminateEc2Instance')
export const terminateEc2Instances = call<[c: AwsConnection, ids: string[]], Ec2BulkInstanceActionResult>('terminateEc2Instances')
export const resizeEc2Instance = call<[c: AwsConnection, id: string, type: string], void>('resizeEc2Instance')
export const listInstanceTypes = call<[c: AwsConnection, arch?: string, currentGenerationOnly?: boolean], Ec2InstanceTypeOption[]>('listInstanceTypes')
export const listEc2Snapshots = call<[c: AwsConnection], Ec2SnapshotSummary[]>('listEc2Snapshots')
export const createEc2Snapshot = call<[c: AwsConnection, volumeId: string, desc: string], string>('createEc2Snapshot')
export const deleteEc2Snapshot = call<[c: AwsConnection, snapshotId: string], void>('deleteEc2Snapshot')
export const tagEc2Snapshot = call<[c: AwsConnection, snapshotId: string, tags: Record<string, string>], void>('tagEc2Snapshot')
export const getIamAssociation = call<[c: AwsConnection, id: string], Ec2IamAssociation | null>('getIamAssociation')
export const attachIamProfile = call<[c: AwsConnection, id: string, name: string], void>('attachIamProfile')
export const replaceIamProfile = call<[c: AwsConnection, assocId: string, name: string], void>('replaceIamProfile')
export const removeIamProfile = call<[c: AwsConnection, assocId: string], void>('removeIamProfile')
export const launchBastion = call<[c: AwsConnection, config: BastionLaunchConfig], string>('launchBastion')
export const findBastionConnectionsForInstance = call<[c: AwsConnection, targetInstanceId: string], BastionConnectionInfo[]>('findBastionConnectionsForInstance')
export const deleteBastion = call<[c: AwsConnection, targetInstanceId: string], void>('deleteBastion')
export const createTempVolumeCheck = call<[c: AwsConnection, volumeId: string], EbsTempInspectionEnvironment>('createTempVolumeCheck')
export const deleteTempVolumeCheck = call<[c: AwsConnection, tempUuidOrInstanceId: string], void>('deleteTempVolumeCheck')
export const listBastions = call<[c: AwsConnection], Ec2InstanceSummary[]>('listBastions')
export const listPopularBastionAmis = call<[c: AwsConnection, architecture?: string], BastionAmiOption[]>('listPopularBastionAmis')
export const describeVpc = call<[c: AwsConnection, vpcId: string], Ec2VpcDetail | null>('describeVpc')
export const launchFromSnapshot = call<[c: AwsConnection, config: SnapshotLaunchConfig], string>('launchFromSnapshot')
export const sendSshPublicKey = call<[c: AwsConnection, id: string, osUser: string, pubKey: string, az: string], boolean>('sendSshPublicKey')
export const getEc2Recommendations = call<[c: AwsConnection], Ec2Recommendation[]>('getEc2Recommendations')
export const listSsmManagedInstances = call<[c: AwsConnection], SsmManagedInstanceSummary[]>('listSsmManagedInstances')
export const getSsmConnectionTarget = call<[c: AwsConnection, instanceId: string], SsmConnectionTarget>('getSsmConnectionTarget')
export const listSsmSessions = call<[c: AwsConnection, targetInstanceId?: string], SsmSessionSummary[]>('listSsmSessions')
export const startSsmSession = call<[c: AwsConnection, request: SsmStartSessionRequest], SsmSessionLaunchSpec>('startSsmSession')
export const sendSsmCommand = call<[c: AwsConnection, request: SsmSendCommandRequest], SsmCommandExecutionResult>('sendSsmCommand')

// Non-standard: subscription pattern, not a simple async call
export function subscribeToTempVolumeProgress(listener: (event: EbsTempInspectionProgress) => void): () => void {
  trackedAwsBridge().subscribeTempVolumeProgress(listener)
  return () => trackedAwsBridge().unsubscribeTempVolumeProgress(listener)
}
