import type {
  AwsConnection,
  TerraformDriftReport,
  TerraformResourceInventoryItem,
  TerragruntCliInfo,
  TerragruntDiscoveryResult,
  TerragruntRunAllCommand,
  TerragruntRunAllEvent,
  TerragruntStack
} from '@shared/types'
import { makeBridgeCall } from './bridgeUtils'

function getTerragruntBridge() {
  if (!(window as unknown as Record<string, unknown>).terragrunt) {
    throw new Error('Terragrunt preload bridge did not load.')
  }
  return (window as unknown as { terragrunt: Record<string, (...args: unknown[]) => unknown> }).terragrunt
}

const call = makeBridgeCall(getTerragruntBridge)

export type ResolvedStackResult = {
  stack: TerragruntStack
  cliAvailable: boolean
  resolveErrors: Array<{ unitPath: string; error: string }>
}

export const detectTerragruntCli = call<[], TerragruntCliInfo>('detectCli')
export const getTerragruntCliInfo = call<[], TerragruntCliInfo>('getCliInfo')
export const scanTerragruntDiscovery = call<[rootPath: string], TerragruntDiscoveryResult>('scanDiscovery')
export const resolveTerragruntStack = call<[rootPath: string], ResolvedStackResult>('resolveStack')
export const startTerragruntRunAll = call<
  [profileName: string, projectId: string, command: TerragruntRunAllCommand, connection?: AwsConnection, unitFilter?: string[]],
  { runId: string; phases: string[][] }
>('startRunAll')
export const cancelTerragruntRunAll = call<[runId: string], boolean>('cancelRunAll')

export type TerragruntUnitInventoryResult = {
  inventory: TerraformResourceInventoryItem[]
  stateAddresses: string[]
  rawStateJson: string
  stateSource: string
  workingDir: string
  error: string
}

export const getTerragruntUnitInventory = call<
  [profileName: string, projectId: string, connection?: AwsConnection, unitPath?: string],
  TerragruntUnitInventoryResult
>('unitInventory')

export const getTerragruntUnitDrift = call<
  [profileName: string, projectId: string, connection: AwsConnection, unitPath: string],
  TerraformDriftReport
>('unitDrift')

export function subscribeTerragruntRunAll(listener: (event: TerragruntRunAllEvent) => void): void {
  (getTerragruntBridge().subscribeRunAll as (l: (e: unknown) => void) => void)(listener as (e: unknown) => void)
}

export function unsubscribeTerragruntRunAll(listener: (event: TerragruntRunAllEvent) => void): void {
  (getTerragruntBridge().unsubscribeRunAll as (l: (e: unknown) => void) => void)(listener as (e: unknown) => void)
}
