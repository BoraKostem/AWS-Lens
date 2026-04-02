import type { CloudProviderId, ProviderDescriptor } from '@shared/types'

export const PROVIDER_REGISTRY: ProviderDescriptor[] = [
  {
    id: 'aws',
    label: 'AWS',
    shortLabel: 'AWS',
    availability: 'available',
    profileLabel: 'Profile',
    locationLabel: 'Region',
    connectionLabel: 'AWS profile or assumed role'
  },
  {
    id: 'gcp',
    label: 'Google Cloud',
    shortLabel: 'GCP',
    availability: 'planned',
    profileLabel: 'Project',
    locationLabel: 'Location',
    connectionLabel: 'Application default credentials or service account'
  },
  {
    id: 'azure',
    label: 'Azure',
    shortLabel: 'AZ',
    availability: 'planned',
    profileLabel: 'Subscription',
    locationLabel: 'Location',
    connectionLabel: 'Subscription or tenant'
  }
]

export function listProviders(): ProviderDescriptor[] {
  return PROVIDER_REGISTRY
}

export function getProvider(providerId: CloudProviderId): ProviderDescriptor {
  return PROVIDER_REGISTRY.find((provider) => provider.id === providerId) ?? PROVIDER_REGISTRY[0]
}
