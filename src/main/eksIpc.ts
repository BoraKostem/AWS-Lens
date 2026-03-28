import { spawn } from 'node:child_process'

import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import { getConnectionEnv } from './sessionHub'
import {
  addEksToKubeconfig,
  createTempEksKubeconfig,
  deleteEksCluster,
  describeEksCluster,
  launchKubectlTerminal,
  listEksClusters,
  listEksNodegroups,
  listEksUpdates,
  updateEksNodegroupScaling
} from './aws/eks'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerEksIpcHandlers(): void {
  ipcMain.handle('eks:list-clusters', async (_event, connection: AwsConnection) =>
    wrap(() => listEksClusters(connection))
  )
  ipcMain.handle('eks:describe-cluster', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => describeEksCluster(connection, clusterName))
  )
  ipcMain.handle('eks:list-nodegroups', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => listEksNodegroups(connection, clusterName))
  )
  ipcMain.handle(
    'eks:update-nodegroup-scaling',
    async (_event, connection: AwsConnection, clusterName: string, nodegroupName: string, min: number, desired: number, max: number) =>
      wrap(() => updateEksNodegroupScaling(connection, clusterName, nodegroupName, min, desired, max))
  )
  ipcMain.handle('eks:list-updates', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => listEksUpdates(connection, clusterName))
  )
  ipcMain.handle('eks:delete-cluster', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => deleteEksCluster(connection, clusterName))
  )
  ipcMain.handle(
    'eks:add-kubeconfig',
    async (_event, connection: AwsConnection, clusterName: string, contextName: string, kubeconfigPath: string) =>
      wrap(() => addEksToKubeconfig(connection, clusterName, contextName, kubeconfigPath))
  )
  ipcMain.handle('eks:launch-kubectl', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => launchKubectlTerminal(connection, clusterName))
  )
  ipcMain.handle('eks:prepare-kubectl-session', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => createTempEksKubeconfig(connection, clusterName))
  )

  ipcMain.handle(
    'eks:run-command',
    async (
      _event,
      connection: AwsConnection,
      clusterName: string,
      kubeconfigPath: string,
      command: string
    ): Promise<HandlerResult<string>> => {
      let activeKubeconfigPath = kubeconfigPath

      if (!activeKubeconfigPath) {
        const kubeconfig = await createTempEksKubeconfig(connection, clusterName)
        activeKubeconfigPath = kubeconfig.path
      }

      return new Promise((resolve) => {
        const env = {
          ...process.env,
          ...getConnectionEnv(connection),
          KUBECONFIG: activeKubeconfigPath
        }

        const child = spawn(command, {
          shell: true,
          env,
          cwd: process.env.USERPROFILE || process.env.HOME || '.'
        })

        let output = ''

        child.stdout.on('data', (buf) => {
          output += buf.toString()
        })
        child.stderr.on('data', (buf) => {
          output += buf.toString()
        })

        child.on('error', (err) => {
          resolve({ ok: false, error: err.message })
        })
        child.on('close', () => {
          resolve({ ok: true, data: output })
        })
      })
    }
  )
}
