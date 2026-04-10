import type {
  AppFeatureFlagDefinition,
  AppFeatureFlagId,
  AppSettings,
  AppSettingsFeatures,
  ServiceId
} from './types'

export const OBSERVABILITY_LAB_FLAG_ID = 'labs.observability' as const

export const APP_FEATURE_FLAGS: AppFeatureFlagDefinition[] = [
  {
    id: OBSERVABILITY_LAB_FLAG_ID,
    label: 'Observability & Resilience Lab',
    description: 'Controls the embedded lab panels inside Terraform, container, and orchestration operator flows.',
    maturity: 'beta',
    surface: 'lab',
    defaultEnabled: true
  },
  {
    id: 'service.iam',
    label: 'IAM console',
    description: 'Shows the Identity and Access Management surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'iam',
    defaultEnabled: true
  },
  {
    id: 'service.identity-center',
    label: 'Identity Center / SSO console',
    description: 'Shows the Identity Center / SSO surface in the service catalog.',
    maturity: 'beta',
    surface: 'service',
    serviceId: 'identity-center',
    defaultEnabled: true
  },
  {
    id: 'service.kms',
    label: 'KMS console',
    description: 'Shows the Key Management Service surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'kms',
    defaultEnabled: true
  },
  {
    id: 'service.sns',
    label: 'SNS console',
    description: 'Shows the SNS surface in the service catalog.',
    maturity: 'beta',
    surface: 'service',
    serviceId: 'sns',
    defaultEnabled: true
  },
  {
    id: 'service.sqs',
    label: 'SQS console',
    description: 'Shows the SQS surface in the service catalog.',
    maturity: 'beta',
    surface: 'service',
    serviceId: 'sqs',
    defaultEnabled: true
  },
  {
    id: 'service.waf',
    label: 'WAF console',
    description: 'Shows the WAF surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'waf',
    defaultEnabled: true
  },

  // GCP service flags
  {
    id: 'service.gcp-iam',
    label: 'GCP IAM Posture console',
    description: 'Shows the GCP IAM Posture surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'gcp-iam',
    defaultEnabled: true
  },
  {
    id: 'service.gcp-pubsub',
    label: 'GCP Pub/Sub console',
    description: 'Shows the GCP Pub/Sub surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'gcp-pubsub',
    defaultEnabled: true
  },
  {
    id: 'service.gcp-scc',
    label: 'GCP Security Command Center console',
    description: 'Shows the GCP Security Command Center surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'gcp-scc',
    defaultEnabled: true
  },
  {
    id: 'service.gcp-cloud-dns',
    label: 'GCP Cloud DNS console',
    description: 'Shows the GCP Cloud DNS surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'gcp-cloud-dns',
    defaultEnabled: true
  },
  {
    id: 'service.gcp-memorystore',
    label: 'GCP Memorystore console',
    description: 'Shows the GCP Memorystore surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'gcp-memorystore',
    defaultEnabled: true
  },
  {
    id: 'service.gcp-firebase',
    label: 'GCP Firebase console',
    description: 'Shows the GCP Firebase surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'gcp-firebase',
    defaultEnabled: true
  },

  // Azure service flags
  {
    id: 'service.azure-rbac',
    label: 'Azure RBAC Posture console',
    description: 'Shows the Azure RBAC Posture surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'azure-rbac',
    defaultEnabled: true
  },
  {
    id: 'service.azure-key-vault',
    label: 'Azure Key Vault console',
    description: 'Shows the Azure Key Vault surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'azure-key-vault',
    defaultEnabled: true
  },
  {
    id: 'service.azure-event-hub',
    label: 'Azure Event Hubs console',
    description: 'Shows the Azure Event Hubs surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'azure-event-hub',
    defaultEnabled: true
  },
  {
    id: 'service.azure-event-grid',
    label: 'Azure Event Grid console',
    description: 'Shows the Azure Event Grid surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'azure-event-grid',
    defaultEnabled: true
  },
  {
    id: 'service.azure-firewall',
    label: 'Azure Firewall console',
    description: 'Shows the Azure Firewall surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'azure-firewall',
    defaultEnabled: true
  },
  {
    id: 'service.azure-dns',
    label: 'Azure DNS console',
    description: 'Shows the Azure DNS surface in the service catalog.',
    maturity: 'experimental',
    surface: 'service',
    serviceId: 'azure-dns',
    defaultEnabled: true
  }
]

const FEATURE_FLAG_BY_ID = new Map<AppFeatureFlagId, AppFeatureFlagDefinition>(
  APP_FEATURE_FLAGS.map((flag) => [flag.id, flag])
)

const FEATURE_FLAG_BY_SERVICE = new Map<ServiceId, AppFeatureFlagDefinition>(
  APP_FEATURE_FLAGS
    .filter((flag): flag is AppFeatureFlagDefinition & { serviceId: ServiceId } =>
      flag.surface === 'service' && Boolean(flag.serviceId)
    )
    .map((flag) => [flag.serviceId, flag])
)

function extractFeatures(
  source: Pick<AppSettings, 'features'> | AppSettingsFeatures | null | undefined
): AppSettingsFeatures | null | undefined {
  if (!source || typeof source !== 'object') {
    return source
  }

  return 'features' in source ? source.features : source
}

export function getDefaultAppFeatureSettings(): AppSettingsFeatures {
  const registry: Partial<Record<AppFeatureFlagId, boolean>> = {}

  for (const flag of APP_FEATURE_FLAGS) {
    registry[flag.id] = flag.defaultEnabled
  }

  return { registry }
}

export function sanitizeAppFeatureSettings(value: unknown): AppSettingsFeatures {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const rawRegistry = raw.registry && typeof raw.registry === 'object' && !Array.isArray(raw.registry)
    ? raw.registry as Record<string, unknown>
    : {}
  const registry: Partial<Record<AppFeatureFlagId, boolean>> = {}

  for (const flag of APP_FEATURE_FLAGS) {
    const candidate = rawRegistry[flag.id]
    registry[flag.id] = typeof candidate === 'boolean' ? candidate : flag.defaultEnabled
  }

  return { registry }
}

export function isFeatureFlagEnabled(
  source: Pick<AppSettings, 'features'> | AppSettingsFeatures | null | undefined,
  flagId: AppFeatureFlagId
): boolean {
  const definition = FEATURE_FLAG_BY_ID.get(flagId)
  if (!definition) {
    return true
  }

  const features = extractFeatures(source)
  const storedValue = features?.registry?.[flagId]
  return typeof storedValue === 'boolean' ? storedValue : definition.defaultEnabled
}

export function isServiceEnabled(
  source: Pick<AppSettings, 'features'> | AppSettingsFeatures | null | undefined,
  serviceId: ServiceId
): boolean {
  const definition = FEATURE_FLAG_BY_SERVICE.get(serviceId)
  if (!definition) {
    return true
  }

  return isFeatureFlagEnabled(source, definition.id)
}

export function isObservabilityLabEnabled(
  source: Pick<AppSettings, 'features'> | AppSettingsFeatures | null | undefined
): boolean {
  return isFeatureFlagEnabled(source, OBSERVABILITY_LAB_FLAG_ID)
}
