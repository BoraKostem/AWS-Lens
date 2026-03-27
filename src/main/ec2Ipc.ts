import { ipcMain } from 'electron'

import type { AwsConnection, BastionLaunchConfig, SnapshotLaunchConfig } from '@shared/types'
import {
  attachIamProfile,
  createEc2Snapshot,
  createTempInspectionEnvironment,
  deleteBastionForInstance,
  deleteEc2Snapshot,
  deleteTempInspectionEnvironment,
  describeEbsVolume,
  describeEc2Instance,
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
  removeIamProfile,
  replaceIamProfile,
  resizeEc2Instance,
  runEc2InstanceAction,
  getEc2Recommendations,
  sendSshPublicKey,
  tagEc2Snapshot,
  terminateEc2Instance
} from './aws/ec2'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

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
}
