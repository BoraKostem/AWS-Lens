import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import {
  createEcrRepository,
  deleteEcrImage,
  deleteEcrRepository,
  dockerLogin,
  dockerPull,
  dockerPushLocal,
  getEcrAuthorizationToken,
  getEcrScanFindings,
  listEcrImages,
  listEcrRepositories,
  startEcrImageScan
} from './aws/ecr'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerEcrIpcHandlers(): void {
  ipcMain.handle('ecr:list-repos', async (_event, connection: AwsConnection) =>
    wrap(() => listEcrRepositories(connection))
  )
  ipcMain.handle('ecr:list-images', async (_event, connection: AwsConnection, repositoryName: string) =>
    wrap(() => listEcrImages(connection, repositoryName))
  )
  ipcMain.handle(
    'ecr:create-repo',
    async (_event, connection: AwsConnection, repositoryName: string, imageTagMutability: string, scanOnPush: boolean) =>
      wrap(() => createEcrRepository(connection, repositoryName, imageTagMutability, scanOnPush))
  )
  ipcMain.handle(
    'ecr:delete-repo',
    async (_event, connection: AwsConnection, repositoryName: string, force: boolean) =>
      wrap(() => deleteEcrRepository(connection, repositoryName, force))
  )
  ipcMain.handle(
    'ecr:delete-image',
    async (_event, connection: AwsConnection, repositoryName: string, imageDigest: string) =>
      wrap(() => deleteEcrImage(connection, repositoryName, imageDigest))
  )
  ipcMain.handle(
    'ecr:start-scan',
    async (_event, connection: AwsConnection, repositoryName: string, imageDigest: string, imageTag?: string) =>
      wrap(() => startEcrImageScan(connection, repositoryName, imageDigest, imageTag))
  )
  ipcMain.handle(
    'ecr:scan-findings',
    async (_event, connection: AwsConnection, repositoryName: string, imageDigest: string) =>
      wrap(() => getEcrScanFindings(connection, repositoryName, imageDigest))
  )
  ipcMain.handle('ecr:get-login', async (_event, connection: AwsConnection) =>
    wrap(() => getEcrAuthorizationToken(connection))
  )
  ipcMain.handle('ecr:docker-login', async (_event, connection: AwsConnection) =>
    wrap(() => dockerLogin(connection))
  )
  ipcMain.handle('ecr:docker-pull', async (_event, repositoryUri: string, tag: string) =>
    wrap(() => dockerPull(repositoryUri, tag))
  )
  ipcMain.handle(
    'ecr:docker-push',
    async (_event, localImage: string, repositoryUri: string, tag: string) =>
      wrap(() => dockerPushLocal(localImage, repositoryUri, tag))
  )
}
