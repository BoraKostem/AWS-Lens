import type { TerragruntCliInfo } from '@shared/types'
import { makeBridgeCall } from './bridgeUtils'

function getTerragruntBridge() {
  if (!(window as unknown as Record<string, unknown>).terragrunt) {
    throw new Error('Terragrunt preload bridge did not load.')
  }
  return (window as unknown as { terragrunt: Record<string, (...args: unknown[]) => unknown> }).terragrunt
}

const call = makeBridgeCall(getTerragruntBridge)

export const detectTerragruntCli = call<[], TerragruntCliInfo>('detectCli')
export const getTerragruntCliInfo = call<[], TerragruntCliInfo>('getCliInfo')
