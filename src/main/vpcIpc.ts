import { ipcMain } from 'electron'

import type { AwsConnection } from '@shared/types'
import {
  createReachabilityPath,
  deleteReachabilityAnalysis,
  deleteReachabilityPath,
  getReachabilityAnalysis,
  getVpcFlowDiagram,
  getVpcTopology,
  listInternetGateways,
  listNatGateways,
  listNetworkInterfaces,
  listRouteTables,
  listSecurityGroups,
  listSubnets,
  listTransitGateways,
  listVpcs,
  updateSubnetAutoAssignPublicIp
} from './aws/vpc'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function wrap<T>(fn: () => Promise<T> | T): Promise<HandlerResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerVpcIpcHandlers(): void {
  ipcMain.handle('vpc:list', async (_event, connection: AwsConnection) =>
    wrap(() => listVpcs(connection))
  )
  ipcMain.handle('vpc:subnets', async (_event, connection: AwsConnection, vpcId?: string) =>
    wrap(() => listSubnets(connection, vpcId))
  )
  ipcMain.handle('vpc:route-tables', async (_event, connection: AwsConnection, vpcId?: string) =>
    wrap(() => listRouteTables(connection, vpcId))
  )
  ipcMain.handle('vpc:internet-gateways', async (_event, connection: AwsConnection, vpcId?: string) =>
    wrap(() => listInternetGateways(connection, vpcId))
  )
  ipcMain.handle('vpc:nat-gateways', async (_event, connection: AwsConnection, vpcId?: string) =>
    wrap(() => listNatGateways(connection, vpcId))
  )
  ipcMain.handle('vpc:transit-gateways', async (_event, connection: AwsConnection) =>
    wrap(() => listTransitGateways(connection))
  )
  ipcMain.handle('vpc:network-interfaces', async (_event, connection: AwsConnection, vpcId?: string) =>
    wrap(() => listNetworkInterfaces(connection, vpcId))
  )
  ipcMain.handle('vpc:security-groups', async (_event, connection: AwsConnection, vpcId?: string) =>
    wrap(() => listSecurityGroups(connection, vpcId))
  )
  ipcMain.handle('vpc:topology', async (_event, connection: AwsConnection, vpcId: string) =>
    wrap(() => getVpcTopology(connection, vpcId))
  )
  ipcMain.handle('vpc:flow-diagram', async (_event, connection: AwsConnection, vpcId: string) =>
    wrap(() => getVpcFlowDiagram(connection, vpcId))
  )
  ipcMain.handle('vpc:subnet-update-public-ip', async (_event, connection: AwsConnection, subnetId: string, mapPublic: boolean) =>
    wrap(() => updateSubnetAutoAssignPublicIp(connection, subnetId, mapPublic))
  )
  ipcMain.handle('vpc:reachability-create', async (_event, connection: AwsConnection, sourceId: string, destId: string, protocol: string) =>
    wrap(() => createReachabilityPath(connection, sourceId, destId, protocol))
  )
  ipcMain.handle('vpc:reachability-get', async (_event, connection: AwsConnection, analysisId: string) =>
    wrap(() => getReachabilityAnalysis(connection, analysisId))
  )
  ipcMain.handle('vpc:reachability-delete-path', async (_event, connection: AwsConnection, pathId: string) =>
    wrap(() => deleteReachabilityPath(connection, pathId))
  )
  ipcMain.handle('vpc:reachability-delete-analysis', async (_event, connection: AwsConnection, analysisId: string) =>
    wrap(() => deleteReachabilityAnalysis(connection, analysisId))
  )
}
