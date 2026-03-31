import { spawn } from 'node:child_process'
import path from 'node:path'

import { dialog, ipcMain, type BrowserWindow } from 'electron'

import type { AwsConnection } from '@shared/types'
import { getConnectionEnv } from './sessionHub'
import { createHandlerWrapper } from './operations'
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
import { generateEksObservabilityReport } from './aws/observabilityLab'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('eks-ipc', { timeoutMs: 120000 })

export function registerEksIpcHandlers(getWindow: () => BrowserWindow | null): void {
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
  ipcMain.handle('eks:choose-kubeconfig-path', async (_event, currentPath?: string) =>
    wrap(async () => {
      const owner = getWindow()
      const normalizedCurrentPath = currentPath?.trim()
      const defaultPath = normalizedCurrentPath
        ? (normalizedCurrentPath === '.kube/config' || normalizedCurrentPath === '.kube\\config'
            ? path.join(process.env.USERPROFILE || process.env.HOME || '.', '.kube', 'config')
            : normalizedCurrentPath)
        : path.join(process.env.USERPROFILE || process.env.HOME || '.', '.kube', 'config')

      const result = owner
        ? await dialog.showSaveDialog(owner, {
            title: 'Choose kubeconfig location',
            defaultPath,
            buttonLabel: 'Select config'
          })
        : await dialog.showSaveDialog({
            title: 'Choose kubeconfig location',
            defaultPath,
            buttonLabel: 'Select config'
          })

      return result.canceled ? '' : result.filePath ?? ''
    })
  )
  ipcMain.handle('eks:launch-kubectl', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => launchKubectlTerminal(connection, clusterName))
  )
  ipcMain.handle('eks:prepare-kubectl-session', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => createTempEksKubeconfig(connection, clusterName))
  )
  ipcMain.handle('eks:get-observability-report', async (_event, connection: AwsConnection, clusterName: string) =>
    wrap(() => generateEksObservabilityReport(connection, clusterName))
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
