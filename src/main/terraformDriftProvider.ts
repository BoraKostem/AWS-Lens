import type { AwsConnection, CloudProviderId, TerraformDriftReport } from '@shared/types'
import { getTerraformDriftReport } from './terraformDrift'
import { getGcpTerraformDriftReport } from './gcpTerraformInsights'
import { getAzureTerraformDriftReport } from './azureTerraformInsights'
import { attachRemediationSuggestions } from './terraformDriftRemediation'

export type DriftProvider = {
  providerId: CloudProviderId
  getDriftReport(
    profileName: string,
    projectId: string,
    connection: AwsConnection | undefined,
    options?: { forceRefresh?: boolean }
  ): Promise<TerraformDriftReport>
}

/** Wrap a provider's getDriftReport to attach remediation suggestions */
function withRemediation(
  fn: DriftProvider['getDriftReport']
): DriftProvider['getDriftReport'] {
  return async (profileName, projectId, connection, options) => {
    const report = await fn(profileName, projectId, connection, options)
    attachRemediationSuggestions(report.items)
    return report
  }
}

const awsProvider: DriftProvider = {
  providerId: 'aws',
  getDriftReport: withRemediation((profileName, projectId, connection, options) =>
    getTerraformDriftReport(profileName, projectId, connection!, options)
  )
}

const gcpProvider: DriftProvider = {
  providerId: 'gcp',
  getDriftReport: withRemediation((profileName, projectId, connection, options) =>
    getGcpTerraformDriftReport(profileName, projectId, connection, options)
  )
}

const azureProvider: DriftProvider = {
  providerId: 'azure',
  getDriftReport: withRemediation((profileName, projectId, connection, options) =>
    getAzureTerraformDriftReport(profileName, projectId, connection, options)
  )
}

export function getDriftProvider(providerId: CloudProviderId): DriftProvider {
  switch (providerId) {
    case 'gcp': return gcpProvider
    case 'azure': return azureProvider
    default: return awsProvider
  }
}

export function resolveDriftProviderId(profileName: string, connection?: AwsConnection): CloudProviderId {
  if (connection?.providerId === 'gcp' || profileName.startsWith('provider:gcp:terraform:')) return 'gcp'
  if (connection?.providerId === 'azure' || profileName.startsWith('provider:azure:terraform:')) return 'azure'
  return 'aws'
}
