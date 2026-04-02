import type {
  AwsConnection,
  AwsProfile,
  AwsRegionOption,
  CallerIdentity,
  ProviderConnectionDescriptor,
  ProviderIdentity,
  ProviderLocationDescriptor,
  ProviderProfileDescriptor
} from '@shared/types'

export function toProviderProfileDescriptor(profile: AwsProfile, isConnected = false): ProviderProfileDescriptor {
  return {
    providerId: profile.providerId,
    id: profile.id,
    label: profile.label,
    source: profile.source,
    defaultLocationId: profile.defaultLocationId,
    state: isConnected ? 'connected' : 'available'
  }
}

export function toProviderLocationDescriptor(location: AwsRegionOption): ProviderLocationDescriptor {
  return {
    providerId: location.providerId,
    id: location.id,
    label: location.name || location.id,
    kind: location.kind
  }
}

export function toProviderConnectionDescriptor(
  connection: AwsConnection,
  locationLabel: string
): ProviderConnectionDescriptor {
  return {
    providerId: connection.providerId,
    kind: connection.kind,
    sessionId: connection.sessionId,
    label: connection.label,
    profileId: connection.profileId,
    profileLabel: connection.profile,
    sourceProfileId: 'sourceProfile' in connection ? connection.sourceProfile : undefined,
    locationId: connection.locationId,
    locationLabel,
    accountId: 'accountId' in connection ? connection.accountId : undefined
  }
}

export function toProviderIdentity(identity: CallerIdentity): ProviderIdentity {
  return {
    providerId: identity.providerId,
    accountId: identity.accountId,
    principalArn: identity.principalArn,
    principalId: identity.principalId
  }
}
