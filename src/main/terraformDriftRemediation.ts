import type {
  TerraformDriftItem,
  TerraformDriftDifference,
  TerraformDriftRemediationSuggestion
} from '@shared/types'

/* ---------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------*/

/**
 * Generate remediation suggestions for a single drifted item.
 * Only items with status `drifted` produce meaningful suggestions;
 * `missing_in_aws` / `missing_in_cloud` items get a targeted subset.
 */
export function generateRemediationSuggestions(item: TerraformDriftItem): TerraformDriftRemediationSuggestion[] {
  if (item.status === 'in_sync' || item.status === 'unsupported') return []

  if (item.status === 'missing_in_aws' || item.status === 'missing_in_cloud') {
    return buildMissingResourceSuggestions(item)
  }

  if (item.status === 'unmanaged_in_aws' || item.status === 'unmanaged_in_cloud') {
    return buildUnmanagedResourceSuggestions(item)
  }

  // status === 'drifted'
  return buildDriftedSuggestions(item)
}

/**
 * Attach remediation suggestions to all items in a report that need them.
 * Mutates `item.remediationSuggestions` in place.
 */
export function attachRemediationSuggestions(items: TerraformDriftItem[]): void {
  for (const item of items) {
    const suggestions = generateRemediationSuggestions(item)
    if (suggestions.length > 0) {
      item.remediationSuggestions = suggestions
    }
  }
}

/* ---------------------------------------------------------------------------
 * Drifted resources — three remediation options
 * -------------------------------------------------------------------------*/

function buildDriftedSuggestions(item: TerraformDriftItem): TerraformDriftRemediationSuggestion[] {
  const suggestions: TerraformDriftRemediationSuggestion[] = []

  // 1. Update Terraform to match live state
  suggestions.push(buildUpdateTerraformSuggestion(item))

  // 2. Apply Terraform to restore declared state
  suggestions.push(buildApplyTerraformSuggestion(item))

  // 3. Ignore drift with lifecycle block
  suggestions.push(buildIgnoreSuggestion(item))

  return suggestions
}

function buildUpdateTerraformSuggestion(item: TerraformDriftItem): TerraformDriftRemediationSuggestion {
  const risk = assessUpdateRisk(item.differences)
  const snippet = buildUpdateSnippet(item)

  return {
    action: 'update-terraform',
    riskLevel: risk,
    description: `Update your Terraform configuration for ${item.terraformAddress} to match the current live values. This accepts the cloud-side changes as the new desired state.`,
    codeSnippet: snippet
  }
}

function buildApplyTerraformSuggestion(item: TerraformDriftItem): TerraformDriftRemediationSuggestion {
  const risk = assessApplyRisk(item)
  const command = `terraform apply -target="${item.terraformAddress}" -auto-approve`

  return {
    action: 'apply-terraform',
    riskLevel: risk,
    description: `Run terraform apply targeting ${item.terraformAddress} to restore the resource to its declared Terraform state. This will overwrite the live cloud configuration.`,
    terraformCommand: command
  }
}

function buildIgnoreSuggestion(item: TerraformDriftItem): TerraformDriftRemediationSuggestion {
  const changedKeys = item.differences.map((d) => d.key)
  const lifecycleBlock = buildLifecycleBlock(changedKeys)

  return {
    action: 'ignore-with-annotation',
    riskLevel: 'low',
    description: `Add a lifecycle block to ${item.terraformAddress} to ignore future drift on the changed attributes. Use this when drift is expected (e.g. auto-scaling, external automation).`,
    lifecycleBlock
  }
}

/* ---------------------------------------------------------------------------
 * Missing resources
 * -------------------------------------------------------------------------*/

function buildMissingResourceSuggestions(item: TerraformDriftItem): TerraformDriftRemediationSuggestion[] {
  return [
    {
      action: 'apply-terraform',
      riskLevel: 'high',
      description: `Resource ${item.terraformAddress} exists in Terraform state but was not found in the cloud. Running terraform apply will attempt to recreate it. Verify the resource was intentionally deleted before proceeding.`,
      terraformCommand: `terraform apply -target="${item.terraformAddress}" -auto-approve`
    },
    {
      action: 'update-terraform',
      riskLevel: 'low',
      description: `Remove ${item.terraformAddress} from your Terraform configuration and state to acknowledge the deletion. This avoids Terraform trying to recreate the resource.`,
      terraformCommand: `terraform state rm "${item.terraformAddress}"`
    }
  ]
}

/* ---------------------------------------------------------------------------
 * Unmanaged resources
 * -------------------------------------------------------------------------*/

function buildUnmanagedResourceSuggestions(item: TerraformDriftItem): TerraformDriftRemediationSuggestion[] {
  return [
    {
      action: 'update-terraform',
      riskLevel: 'medium',
      description: `Resource ${item.cloudIdentifier} exists in the cloud but is not managed by Terraform. Import it into your state and write a matching configuration block.`,
      terraformCommand: `terraform import "${item.terraformAddress}" "${item.cloudIdentifier}"`
    }
  ]
}

/* ---------------------------------------------------------------------------
 * Risk assessment
 * -------------------------------------------------------------------------*/

/** Attributes that are immutable or dangerous to change via plan update */
const IMMUTABLE_ATTRIBUTES = new Set([
  'ami', 'image_id', 'instance_type', 'machine_type', 'vm_size',
  'engine', 'engine_version', 'cluster_version', 'master_version',
  'availability_zone', 'location', 'region', 'zone',
  'cidr_block', 'address_prefix', 'ip_cidr_range',
  'name', 'account_replication_type', 'kind',
  'sku_name', 'sku', 'offer_type'
])

/** Attributes that are cosmetic / low risk */
const LOW_RISK_ATTRIBUTES = new Set([
  'tags', 'labels', 'description', 'display_name'
])

function assessUpdateRisk(differences: TerraformDriftDifference[]): 'low' | 'medium' | 'high' {
  if (differences.length === 0) return 'low'

  const hasImmutable = differences.some((d) => isImmutableKey(d.key))
  if (hasImmutable) return 'high'

  const allLowRisk = differences.every((d) => isLowRiskKey(d.key))
  if (allLowRisk) return 'low'

  return 'medium'
}

function assessApplyRisk(item: TerraformDriftItem): 'low' | 'medium' | 'high' {
  const hasImmutable = item.differences.some((d) => isImmutableKey(d.key))
  if (hasImmutable) return 'high'

  if (item.resourceType.includes('database') || item.resourceType.includes('sql') || item.resourceType.includes('cosmosdb')) {
    return 'high'
  }

  if (item.differences.length <= 2 && item.differences.every((d) => isLowRiskKey(d.key))) {
    return 'low'
  }

  return 'medium'
}

function isImmutableKey(key: string): boolean {
  const normalised = key.replace(/\.\d+/g, '').split('.').pop() ?? key
  return IMMUTABLE_ATTRIBUTES.has(normalised)
}

function isLowRiskKey(key: string): boolean {
  const normalised = key.replace(/\.\d+/g, '').split('.').pop() ?? key
  return LOW_RISK_ATTRIBUTES.has(normalised) || normalised.startsWith('tags.') || normalised.startsWith('labels.')
}

/* ---------------------------------------------------------------------------
 * Code snippet generation
 * -------------------------------------------------------------------------*/

function buildUpdateSnippet(item: TerraformDriftItem): string {
  if (item.differences.length === 0) return '# No attribute differences detected'

  const lines: string[] = [`# Update ${item.terraformAddress} to match live values:`]
  for (const diff of item.differences) {
    const value = formatHclValue(diff.liveValue)
    lines.push(`  ${diff.key} = ${value}  # was: ${diff.terraformValue}`)
  }
  return lines.join('\n')
}

function buildLifecycleBlock(keys: string[]): string {
  if (keys.length === 0) return 'lifecycle {\n  ignore_changes = all\n}'

  const formatted = keys.map((k) => `    ${k}`).join(',\n')
  return `lifecycle {\n  ignore_changes = [\n${formatted}\n  ]\n}`
}

function formatHclValue(value: string): string {
  if (value === 'true' || value === 'false') return value
  if (/^\d+(\.\d+)?$/.test(value)) return value
  if (value.startsWith('[') || value.startsWith('{')) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
