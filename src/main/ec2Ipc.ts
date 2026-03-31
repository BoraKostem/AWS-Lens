import { ipcMain } from 'electron'

import type {
  AwsConnection,
  BastionLaunchConfig,
  EbsVolumeAttachRequest,
  EbsVolumeDetachRequest,
  EbsVolumeModifyRequest,
  SnapshotLaunchConfig,
  SsmSendCommandRequest,
  SsmStartSessionRequest
} from '@shared/types'
import {
  attachEbsVolume,
  attachIamProfile,
  createEc2Snapshot,
  createTempInspectionEnvironment,
  deleteEbsVolume,
  deleteBastionForInstance,
  deleteEc2Snapshot,
  deleteTempInspectionEnvironment,
  describeEbsVolume,
  describeEc2Instance,
  detachEbsVolume,
  describeVpc,
  findBastionConnectionsForInstance,
  getIamAssociation,
  launchBastion,
  launchFromSnapshot,
  listEbsVolumes,
  listBastions,
  listEc2Instances,
  listEc2Snapshots,
  listInstanceTypes,
  listPopularBastionAmis,
  modifyEbsVolume,
  removeIamProfile,
  replaceIamProfile,
  resizeEc2Instance,
  runEc2InstanceAction,
  getEc2Recommendations,
  sendSshPublicKey,
  tagEbsVolume,
  tagEc2Snapshot,
  untagEbsVolume,
  terminateEc2Instance
} from './aws/ec2'
import {
  getSsmConnectionTarget,
  listSsmManagedInstances,
  listSsmSessions,
  sendSsmCommand,
  startSsmSession
} from './aws/ssm'
import { createHandlerWrapper } from './operations'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('ec2-ipc', { timeoutMs: 120000 })

export function registerEc2IpcHandlers(): void {
  ipcMain.handle('ec2:list', async (_event, connection: AwsConnection) =>
    wrap(() => listEc2Instances(connection))
  )
  ipcMain.handle('ec2:list-volumes', async (_event, connection: AwsConnection) =>
    wrap(() => listEbsVolumes(connection))
  )
  ipcMain.handle('ec2:describe', async (_event, connection: AwsConnection, instanceId: string) =>
    wrap(() => describeEc2Instance(connection, instanceId))
  )
  ipcMain.handle('ec2:describe-volume', async (_event, connection: AwsConnection, volumeId: string) =>
    wrap(() => describeEbsVolume(connection, volumeId))
  )
  ipcMain.handle('ec2:tag-volume', async (_event, connection: AwsConnection, volumeId: string, tags: Record<string, string>) =>
    wrap(() => tagEbsVolume(connection, volumeId, tags))
  )
  ipcMain.handle('ec2:untag-volume', async (_event, connection: AwsConnection, volumeId: string, tagKeys: string[]) =>
    wrap(() => untagEbsVolume(connection, volumeId, tagKeys))
  )
  ipcMain.handle(
    'ec2:attach-volume',
    async (_event, connection: AwsConnection, volumeId: string, request: EbsVolumeAttachRequest) =>
      wrap(() => attachEbsVolume(connection, volumeId, request))
  )
  ipcMain.handle(
    'ec2:detach-volume',
    async (_event, connection: AwsConnection, volumeId: string, request?: EbsVolumeDetachRequest) =>
      wrap(() => detachEbsVolume(connection, volumeId, request))
  )
  ipcMain.handle('ec2:delete-volume', async (_event, connection: AwsConnection, volumeId: string) =>
    wrap(() => deleteEbsVolume(connection, volumeId))
  )
  ipcMain.handle(
    'ec2:modify-volume',
    async (_event, connection: AwsConnection, volumeId: string, request: EbsVolumeModifyRequest) =>
      wrap(() => modifyEbsVolume(connection, volumeId, request))
  )
  ipcMain.handle(
    'ec2:action',
    async (_event, connection: AwsConnection, instanceId: string, action: 'start' | 'stop' | 'reboot') =>
      wrap(() => runEc2InstanceAction(connection, instanceId, action))
  )
  ipcMain.handle('ec2:terminate', async (_event, connection: AwsConnection, instanceId: string) =>
    wrap(() => terminateEc2Instance(connection, instanceId))
  )
  ipcMain.handle('ec2:resize', async (_event, connection: AwsConnection, instanceId: string, instanceType: string) =>
    wrap(() => resizeEc2Instance(connection, instanceId, instanceType))
  )
  ipcMain.handle('ec2:list-instance-types', async (_event, connection: AwsConnection, architecture?: string, currentGenerationOnly?: boolean) =>
    wrap(() => listInstanceTypes(connection, architecture, currentGenerationOnly ?? true))
  )
  ipcMain.handle('ec2:list-snapshots', async (_event, connection: AwsConnection) =>
    wrap(() => listEc2Snapshots(connection))
  )
  ipcMain.handle(
    'ec2:create-snapshot',
    async (_event, connection: AwsConnection, volumeId: string, description: string) =>
      wrap(() => createEc2Snapshot(connection, volumeId, description))
  )
  ipcMain.handle('ec2:delete-snapshot', async (_event, connection: AwsConnection, snapshotId: string) =>
    wrap(() => deleteEc2Snapshot(connection, snapshotId))
  )
  ipcMain.handle(
    'ec2:tag-snapshot',
    async (_event, connection: AwsConnection, snapshotId: string, tags: Record<string, string>) =>
      wrap(() => tagEc2Snapshot(connection, snapshotId, tags))
  )
  ipcMain.handle('ec2:get-iam-association', async (_event, connection: AwsConnection, instanceId: string) =>
    wrap(() => getIamAssociation(connection, instanceId))
  )
  ipcMain.handle(
    'ec2:attach-iam-profile',
    async (_event, connection: AwsConnection, instanceId: string, profileName: string) =>
      wrap(() => attachIamProfile(connection, instanceId, profileName))
  )
  ipcMain.handle(
    'ec2:replace-iam-profile',
    async (_event, connection: AwsConnection, associationId: string, profileName: string) =>
      wrap(() => replaceIamProfile(connection, associationId, profileName))
  )
  ipcMain.handle('ec2:remove-iam-profile', async (_event, connection: AwsConnection, associationId: string) =>
    wrap(() => removeIamProfile(connection, associationId))
  )
  ipcMain.handle('ec2:launch-bastion', async (_event, connection: AwsConnection, config: BastionLaunchConfig) =>
    wrap(() => launchBastion(connection, config))
  )
  ipcMain.handle('ec2:find-bastion-connections', async (_event, connection: AwsConnection, targetInstanceId: string) =>
    wrap(() => findBastionConnectionsForInstance(connection, targetInstanceId))
  )
  ipcMain.handle('ec2:delete-bastion', async (_event, connection: AwsConnection, targetInstanceId: string) =>
    wrap(() => deleteBastionForInstance(connection, targetInstanceId))
  )
  ipcMain.handle('ec2:create-temp-volume-check', async (event, connection: AwsConnection, volumeId: string) =>
    wrap(() =>
      createTempInspectionEnvironment(connection, volumeId, (progress) => {
        event.sender.send('ec2:temp-volume-progress', progress)
      })
    )
  )
  ipcMain.handle('ec2:delete-temp-volume-check', async (event, connection: AwsConnection, tempUuidOrInstanceId: string) =>
    wrap(() =>
      deleteTempInspectionEnvironment(connection, tempUuidOrInstanceId, (progress) => {
        event.sender.send('ec2:temp-volume-progress', progress)
      })
    )
  )
  ipcMain.handle('ec2:list-bastions', async (_event, connection: AwsConnection) =>
    wrap(() => listBastions(connection))
  )
  ipcMain.handle('ec2:list-popular-bastion-amis', async (_event, connection: AwsConnection, architecture?: string) =>
    wrap(() => listPopularBastionAmis(connection, architecture))
  )
  ipcMain.handle('ec2:describe-vpc', async (_event, connection: AwsConnection, vpcId: string) =>
    wrap(() => describeVpc(connection, vpcId))
  )
  ipcMain.handle(
    'ec2:launch-from-snapshot',
    async (_event, connection: AwsConnection, config: SnapshotLaunchConfig) =>
      wrap(() => launchFromSnapshot(connection, config))
  )
  ipcMain.handle(
    'ec2:send-ssh-public-key',
    async (
      _event,
      connection: AwsConnection,
      instanceId: string,
      osUser: string,
      publicKey: string,
      availabilityZone: string
    ) => wrap(() => sendSshPublicKey(connection, instanceId, osUser, publicKey, availabilityZone))
  )
  ipcMain.handle('ec2:recommendations', async (_event, connection: AwsConnection) =>
    wrap(() => getEc2Recommendations(connection))
  )
  ipcMain.handle('ec2:ssm:list-managed', async (_event, connection: AwsConnection) =>
    wrap(() => listSsmManagedInstances(connection))
  )
  ipcMain.handle('ec2:ssm:target', async (_event, connection: AwsConnection, instanceId: string) =>
    wrap(() => getSsmConnectionTarget(connection, instanceId))
  )
  ipcMain.handle('ec2:ssm:list-sessions', async (_event, connection: AwsConnection, targetInstanceId?: string) =>
    wrap(() => listSsmSessions(connection, targetInstanceId))
  )
  ipcMain.handle('ec2:ssm:start-session', async (_event, connection: AwsConnection, request: SsmStartSessionRequest) =>
    wrap(() => startSsmSession(connection, request))
  )
  ipcMain.handle('ec2:ssm:send-command', async (_event, connection: AwsConnection, request: SsmSendCommandRequest) =>
    wrap(() => sendSsmCommand(connection, request))
  )
}
