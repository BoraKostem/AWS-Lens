import type { BrowserWindow } from 'electron'

import type { CloudProviderId } from '@shared/types'
import { registerAwsIpcHandlers } from './awsIpc'
import { registerCompareIpcHandlers } from './compareIpc'
import { registerComplianceIpcHandlers } from './complianceIpc'
import { registerEc2IpcHandlers } from './ec2Ipc'
import { registerEcrIpcHandlers } from './ecrIpc'
import { registerEksIpcHandlers } from './eksIpc'
import { registerFoundationIpcHandlers } from './foundationIpc'
import { registerOverviewIpcHandlers } from './overviewIpc'
import { getProvider, listProviders } from './providerRegistry'
import { registerSecurityIpcHandlers } from './securityIpc'
import { registerServiceIpcHandlers } from './serviceIpc'
import { registerSgIpcHandlers } from './sgIpc'
import { registerTerminalIpcHandlers } from './terminalIpc'
import { registerTerraformIpcHandlers } from './terraformIpc'
import { registerVpcIpcHandlers } from './vpcIpc'

type ProviderIpcRegistrationContext = {
  getWindow: () => BrowserWindow | null
}

type ProviderCapabilityGroup =
  | 'shell'
  | 'overview'
  | 'compare'
  | 'compliance'
  | 'foundations'
  | 'compute'
  | 'containers'
  | 'networking'
  | 'security'
  | 'terraform'
  | 'terminal'

type ProviderIpcRegistryEntry = {
  providerId: CloudProviderId
  capabilityGroups: ProviderCapabilityGroup[]
  registerHandlers: (context: ProviderIpcRegistrationContext) => void
}

function registerAwsProviderHandlers(context: ProviderIpcRegistrationContext): void {
  registerAwsIpcHandlers()
  registerCompareIpcHandlers()
  registerComplianceIpcHandlers()
  registerEc2IpcHandlers(context.getWindow)
  registerEcrIpcHandlers()
  registerEksIpcHandlers(context.getWindow)
  registerFoundationIpcHandlers()
  registerOverviewIpcHandlers()
  registerSecurityIpcHandlers()
  registerServiceIpcHandlers()
  registerSgIpcHandlers()
  registerTerminalIpcHandlers()
  registerTerraformIpcHandlers(context.getWindow)
  registerVpcIpcHandlers()
}

export const PROVIDER_IPC_REGISTRY: Record<CloudProviderId, ProviderIpcRegistryEntry> = {
  aws: {
    providerId: 'aws',
    capabilityGroups: [
      'shell',
      'overview',
      'compare',
      'compliance',
      'foundations',
      'compute',
      'containers',
      'networking',
      'security',
      'terraform',
      'terminal'
    ],
    registerHandlers: registerAwsProviderHandlers
  },
  gcp: {
    providerId: 'gcp',
    capabilityGroups: ['terraform'],
    registerHandlers: (context) => {
      registerTerraformIpcHandlers(context.getWindow)
    }
  },
  azure: {
    providerId: 'azure',
    capabilityGroups: [],
    registerHandlers: () => {
      // Azure handlers will be attached when the provider becomes available.
    }
  }
}

export function registerProviderIpcHandlers(context: ProviderIpcRegistrationContext): void {
  for (const provider of listProviders()) {
    if (provider.availability !== 'available') {
      continue
    }

    PROVIDER_IPC_REGISTRY[provider.id]?.registerHandlers(context)
  }
}

export function listProviderCapabilityGroups(providerId: CloudProviderId): ProviderCapabilityGroup[] {
  const provider = getProvider(providerId)
  if (provider.availability !== 'available') {
    return []
  }

  return PROVIDER_IPC_REGISTRY[providerId]?.capabilityGroups ?? []
}
