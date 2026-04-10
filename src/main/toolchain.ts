import type { AppSettingsToolchain, TerraformCliKind } from '@shared/types'
import { getAppSettings } from './appSettings'

export type ToolchainOverrideId =
  | 'terraform'
  | 'opentofu'
  | 'aws-cli'
  | 'gcloud-cli'
  | 'azure-cli'
  | 'kubectl'
  | 'docker'

const TOOLCHAIN_OVERRIDE_KEYS: Record<ToolchainOverrideId, keyof AppSettingsToolchain> = {
  terraform: 'terraformPathOverride',
  opentofu: 'opentofuPathOverride',
  'aws-cli': 'awsCliPathOverride',
  'gcloud-cli': 'gcloudPathOverride',
  'azure-cli': 'azureCliPathOverride',
  kubectl: 'kubectlPathOverride',
  docker: 'dockerPathOverride'
}

function normalizeOverridePath(value: string): string {
  const trimmed = value.trim()

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

export function getToolPathOverride(toolId: ToolchainOverrideId): string {
  return normalizeOverridePath(getAppSettings().toolchain[TOOLCHAIN_OVERRIDE_KEYS[toolId]])
}

export function getToolCommand(toolId: ToolchainOverrideId, fallbackCommand: string): string {
  return getToolPathOverride(toolId) || fallbackCommand
}

export function listToolCommandCandidates(
  toolId: ToolchainOverrideId | null | undefined,
  candidates: string[]
): string[] {
  const override = toolId ? getToolPathOverride(toolId) : ''
  return [...new Set(override ? [override, ...candidates] : candidates)]
}

export function getPreferredTerraformCliKindSetting(): TerraformCliKind | '' {
  return getAppSettings().toolchain.preferredTerraformCliKind
}
