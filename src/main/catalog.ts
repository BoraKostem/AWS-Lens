import type {
  AppSettingsFeatures,
  CloudProviderId,
  ServiceDescriptor,
  WorkspaceCatalog,
  WorkspaceCatalogSection
} from '@shared/types'
import { isServiceEnabled } from '@shared/featureFlags'

const SHARED_WORKSPACES: ServiceDescriptor[] = [
  {
    id: 'terraform',
    label: 'Terraform',
    category: 'Infrastructure',
    migrated: false,
    maturity: 'beta',
    providerId: 'shared',
    providerLabel: 'Shared',
    workspaceKind: 'shared',
    supports: ['aws', 'gcp', 'azure'],
    requiresConnection: true
  },
  {
    id: 'overview',
    label: 'Overview',
    category: 'Catalog',
    migrated: true,
    maturity: 'production-ready',
    providerId: 'shared',
    providerLabel: 'Shared',
    workspaceKind: 'shared',
    supports: ['aws', 'gcp', 'azure'],
    requiresConnection: true
  },
  {
    id: 'session-hub',
    label: 'Session Hub',
    category: 'Security',
    migrated: true,
    maturity: 'production-ready',
    providerId: 'shared',
    providerLabel: 'Shared',
    workspaceKind: 'shared',
    supports: ['aws', 'gcp', 'azure'],
    requiresConnection: true
  },
  {
    id: 'compare',
    label: 'Compare',
    category: 'Security',
    migrated: true,
    maturity: 'production-ready',
    providerId: 'shared',
    providerLabel: 'Shared',
    workspaceKind: 'shared',
    supports: ['aws', 'gcp', 'azure'],
    requiresConnection: true
  },
  {
    id: 'compliance-center',
    label: 'Compliance Center',
    category: 'Security',
    migrated: true,
    maturity: 'production-ready',
    providerId: 'shared',
    providerLabel: 'Shared',
    workspaceKind: 'shared',
    supports: ['aws', 'gcp', 'azure'],
    requiresConnection: true
  }
]

const AWS_WORKSPACES: ServiceDescriptor[] = [
  { id: 'ec2', label: 'EC2', category: 'Compute', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'cloudwatch', label: 'CloudWatch', category: 'Management', migrated: true, maturity: 'production-ready', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 's3', label: 'S3', category: 'Storage', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'lambda', label: 'Lambda', category: 'Compute', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'auto-scaling', label: 'Auto Scaling', category: 'Compute', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'rds', label: 'RDS', category: 'Database', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'cloudformation', label: 'CloudFormation', category: 'Infrastructure', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'cloudtrail', label: 'CloudTrail', category: 'Management', migrated: true, maturity: 'production-ready', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'ecr', label: 'ECR', category: 'Containers', migrated: false, maturity: 'experimental', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'eks', label: 'EKS', category: 'Compute', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'ecs', label: 'ECS', category: 'Containers', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'vpc', label: 'VPC', category: 'Networking', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'load-balancers', label: 'Load Balancers', category: 'Networking', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'route53', label: 'Route 53', category: 'Networking', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'security-groups', label: 'Security Groups', category: 'Security', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'acm', label: 'ACM', category: 'Networking', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'iam', label: 'IAM', category: 'Security', migrated: false, maturity: 'experimental', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'identity-center', label: 'Identity Center / SSO', category: 'Security', migrated: true, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'sns', label: 'SNS', category: 'Messaging', migrated: true, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'sqs', label: 'SQS', category: 'Messaging', migrated: true, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'sts', label: 'STS', category: 'Security', migrated: true, maturity: 'production-ready', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'kms', label: 'KMS', category: 'Security', migrated: false, maturity: 'experimental', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'waf', label: 'WAF', category: 'Security', migrated: false, maturity: 'experimental', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'secrets-manager', label: 'Secrets Manager', category: 'Security', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true },
  { id: 'key-pairs', label: 'Key Pairs', category: 'Security', migrated: false, maturity: 'beta', providerId: 'aws', providerLabel: 'AWS', workspaceKind: 'provider', supports: ['aws'], requiresConnection: true }
]

const GCP_WORKSPACES: ServiceDescriptor[] = [
  { id: 'gcp-projects', label: 'Projects', category: 'Management', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-iam', label: 'IAM Posture', category: 'Security', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-compute-engine', label: 'Compute Engine', category: 'Compute', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-vpc', label: 'VPC', category: 'Networking', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-gke', label: 'GKE', category: 'Compute', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-cloud-storage', label: 'Cloud Storage', category: 'Data', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-cloud-sql', label: 'Cloud SQL', category: 'Data', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-logging', label: 'Logging', category: 'Operations', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-billing', label: 'Billing Basics', category: 'Operations', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-bigquery', label: 'BigQuery', category: 'Data', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-monitoring', label: 'Monitoring', category: 'Operations', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-scc', label: 'Security Command Center', category: 'Security', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-firestore', label: 'Firestore', category: 'Data', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true },
  { id: 'gcp-pubsub', label: 'Pub/Sub', category: 'Messaging', migrated: true, maturity: 'experimental', providerId: 'gcp', providerLabel: 'GCP', workspaceKind: 'provider', supports: ['gcp'], requiresConnection: true }
]

const AZURE_WORKSPACES: ServiceDescriptor[] = [
  { id: 'azure-subscriptions', label: 'Subscriptions', category: 'Management', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-rbac', label: 'RBAC Posture', category: 'Security', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-virtual-machines', label: 'Virtual Machines', category: 'Compute', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-aks', label: 'AKS', category: 'Containers', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-storage-accounts', label: 'Storage Accounts', category: 'Storage', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-sql', label: 'Azure SQL', category: 'Database', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-postgresql', label: 'PostgreSQL', category: 'Database', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-monitor', label: 'Monitor', category: 'Operations', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-cost', label: 'Cost', category: 'Operations', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-network', label: 'Network', category: 'Networking', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-vmss', label: 'VM Scale Sets', category: 'Compute', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-app-insights', label: 'Application Insights', category: 'Operations', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-key-vault', label: 'Key Vault', category: 'Security', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-event-hub', label: 'Event Hubs', category: 'Messaging', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true },
  { id: 'azure-app-service', label: 'App Service', category: 'Compute', migrated: true, maturity: 'experimental', providerId: 'azure', providerLabel: 'Azure', workspaceKind: 'provider', supports: ['azure'], requiresConnection: true }
]

function sortServices(items: ServiceDescriptor[]): ServiceDescriptor[] {
  return [...items].sort((left, right) => left.label.localeCompare(right.label))
}

function buildSharedSections(): WorkspaceCatalogSection[] {
  return [
    {
      id: 'shared-core',
      label: 'Shared Workspaces',
      providerId: 'shared',
      workspaceKind: 'shared',
      items: sortServices(SHARED_WORKSPACES)
    }
  ]
}

function buildAwsProviderSections(): WorkspaceCatalogSection[] {
  return [
    {
      id: 'aws-workspaces',
      label: 'AWS Workspaces',
      providerId: 'aws',
      workspaceKind: 'provider',
      items: sortServices(AWS_WORKSPACES)
    }
  ]
}

function buildGcpProviderSections(): WorkspaceCatalogSection[] {
  return [
    {
      id: 'gcp-workspaces',
      label: 'GCP Workspaces',
      providerId: 'gcp',
      workspaceKind: 'provider',
      items: sortServices(GCP_WORKSPACES)
    }
  ]
}

function buildAzureProviderSections(): WorkspaceCatalogSection[] {
  return [
    {
      id: 'azure-workspaces',
      label: 'Azure Workspaces',
      providerId: 'azure',
      workspaceKind: 'provider',
      items: sortServices(AZURE_WORKSPACES)
    }
  ]
}

export function getWorkspaceCatalog(providerId: CloudProviderId = 'aws'): WorkspaceCatalog {
  const sharedWorkspaces = buildSharedSections()
  const providerWorkspaces = providerId === 'aws'
    ? buildAwsProviderSections()
    : providerId === 'gcp'
      ? buildGcpProviderSections()
      : buildAzureProviderSections()
  const allServices = [...sharedWorkspaces.flatMap((section) => section.items), ...providerWorkspaces.flatMap((section) => section.items)]

  return {
    providerId,
    sharedWorkspaces,
    providerWorkspaces,
    allServices
  }
}

function filterVisibleServices(
  items: ServiceDescriptor[],
  features: AppSettingsFeatures
): ServiceDescriptor[] {
  return items.filter((service) => isServiceEnabled(features, service.id))
}

export function getVisibleWorkspaceCatalog(
  providerId: CloudProviderId = 'aws',
  features: AppSettingsFeatures
): WorkspaceCatalog {
  const catalog = getWorkspaceCatalog(providerId)
  const sharedWorkspaces = catalog.sharedWorkspaces
    .map((section) => ({
      ...section,
      items: filterVisibleServices(section.items, features)
    }))
    .filter((section) => section.items.length > 0)
  const providerWorkspaces = catalog.providerWorkspaces
    .map((section) => ({
      ...section,
      items: filterVisibleServices(section.items, features)
    }))
    .filter((section) => section.items.length > 0)

  return {
    providerId: catalog.providerId,
    sharedWorkspaces,
    providerWorkspaces,
    allServices: [...sharedWorkspaces.flatMap((section) => section.items), ...providerWorkspaces.flatMap((section) => section.items)]
  }
}

export function listServiceCatalog(providerId: CloudProviderId = 'aws'): ServiceDescriptor[] {
  return getWorkspaceCatalog(providerId).allServices
}

export function getVisibleServiceCatalog(
  providerId: CloudProviderId = 'aws',
  features: AppSettingsFeatures
): ServiceDescriptor[] {
  return getVisibleWorkspaceCatalog(providerId, features).allServices
}

export const SERVICE_CATALOG: ServiceDescriptor[] = listServiceCatalog('aws')
