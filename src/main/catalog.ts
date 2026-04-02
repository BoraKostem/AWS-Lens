import type {
  CloudProviderId,
  ServiceDescriptor,
  WorkspaceCatalog,
  WorkspaceCatalogSection
} from '@shared/types'

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

export function getWorkspaceCatalog(providerId: CloudProviderId = 'aws'): WorkspaceCatalog {
  const sharedWorkspaces = buildSharedSections()
  const providerWorkspaces = providerId === 'aws' ? buildAwsProviderSections() : []
  const allServices = [...sharedWorkspaces.flatMap((section) => section.items), ...providerWorkspaces.flatMap((section) => section.items)]

  return {
    providerId,
    sharedWorkspaces,
    providerWorkspaces,
    allServices
  }
}

export function listServiceCatalog(providerId: CloudProviderId = 'aws'): ServiceDescriptor[] {
  return getWorkspaceCatalog(providerId).allServices
}

export const SERVICE_CATALOG: ServiceDescriptor[] = listServiceCatalog('aws')
