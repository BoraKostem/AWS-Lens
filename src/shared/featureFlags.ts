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
    description: 'Controls the embedded lab panels inside Terraform, ECS, and EKS operator flows.',
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
  }
]

const FEATURE_FLAG_BY_ID = new Map<AppFeatureFlagId, AppFeatureFlagDefinition>(
  APP_FEATURE_FLAGS.map((flag) => [flag.id, flag])
)
const FEATURE_FLAG_BY_SERVICE = new Map<ServiceId, AppFeatureFlagDefinition>(
  APP_FEATURE_FLAGS
    .filter((flag): flag is AppFeatureFlagDefinition & { serviceId: ServiceId } => flag.surface === 'service' && Boolean(flag.serviceId))
    .map((flag) => [flag.serviceId, flag])
)

function extractFeatures(source: Pick<AppSettings, 'features'> | AppSettingsFeatures | null | undefined): AppSettingsFeatures | null | undefined {
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

export function isObservabilityLabEnabled(source: Pick<AppSettings, 'features'> | AppSettingsFeatures | null | undefined): boolean {
  return isFeatureFlagEnabled(source, OBSERVABILITY_LAB_FLAG_ID)
}
