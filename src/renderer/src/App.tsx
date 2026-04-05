import { useEffect, useMemo, useRef, useState } from 'react'

import appLogoUrl from '../../../assets/aws-lens-logo.png'
import {
  LEGACY_BLOCKED_ACTION_EVENT,
  LEGACY_STORAGE_NAMESPACE,
  PRODUCT_BRAND_NAME
} from '@shared/branding'
import type {
  AwsConnection,
  AppReleaseInfo,
  AppSecuritySummary,
  AppSettings,
  CloudProviderId,
  ComparisonRequest,
  EnvironmentHealthReport,
  EnterpriseAccessMode,
  EnterpriseAuditEvent,
  GcpCliContext,
  GcpComputeInstanceSummary,
  GovernanceTagDefaults,
  NavigationFocus,
  ProviderDescriptor,
  ServiceDescriptor,
  ServiceId,
  ServiceMaturity,
  TerraformCliInfo,
  TokenizedFocus,
  WorkspaceCatalog,
  WorkspaceCatalogSection
} from '@shared/types'
import {
  checkForAppUpdates,
  chooseAndImportConfig,
  closeAwsTerminal,
  detectTerraformCli,
  deleteProfile,
  downloadAppUpdate,
  exportDiagnosticsBundle,
  exportEnterpriseAuditEvents,
  getAppReleaseInfo,
  getAppSecuritySummary,
  getAppSettings,
  getEnvironmentHealth,
  getGcpCliContext,
  listGcpComputeInstances,
  listGcpProjects,
  getEnterpriseSettings,
  getGovernanceTagDefaults,
  getWorkspaceCatalog,
  invalidateAllPageCaches,
  invalidatePageCache,
  installAppUpdate,
  listEnterpriseAuditEvents,
  listProviders,
  openExternalUrl,
  saveCredentials,
  setTerraformCliKind,
  setEnterpriseAccessMode,
  updateAppSettings,
  updateGovernanceTagDefaults,
  useAwsActivity,
  useEnterpriseSettings,
  type CacheTag
} from './api'
import { AcmConsole } from './AcmConsole'
import { AutoScalingConsole } from './AutoScalingConsole'
import { AwsTerminalPanel } from './AwsTerminalPanel'
import { CloudFormationConsole } from './CloudFormationConsole'
import { CompareWorkspace } from './CompareWorkspace'
import { ComplianceCenter } from './ComplianceCenter'
import { CloudTrailConsole } from './CloudTrailConsole'
import { CloudWatchConsole } from './CloudWatchConsole'
import { DirectResourceConsole } from './DirectResourceConsole'
import { useAwsPageConnection } from './AwsPage'
import { EcsConsole } from './EcsConsole'
import { Ec2Console } from './Ec2Console'
import { EcrConsole } from './EcrConsole'
import { EksConsole } from './EksConsole'
import { IamConsole } from './IamConsole'
import { IdentityCenterConsole } from './IdentityCenterConsole'
import { KeyPairsConsole } from './KeyPairsConsole'
import { KmsConsole } from './KmsConsole'
import { LambdaConsole } from './LambdaConsole'
import { OverviewConsole } from './OverviewConsole'
import { ProviderTerminalPanel } from './ProviderTerminalPanel'
import { RdsConsole } from './RdsConsole'
import { Route53Console } from './Route53Console'
import { S3Console } from './S3Console'
import { SecretsManagerConsole } from './SecretsManagerConsole'
import { SecurityGroupsConsole } from './SecurityGroupsConsole'
import { SettingsPage } from './SettingsPage'
import { SnsConsole } from './SnsConsole'
import { SqsConsole } from './SqsConsole'
import { SessionHub } from './SessionHub'
import { SvcState } from './SvcState'
import { StsConsole } from './StsConsole'
import { TerraformConsole } from './TerraformConsole'
import { VpcWorkspace } from './VpcWorkspace'
import { WafConsole } from './WafConsole'
import { WorkspaceApp } from './WorkspaceApp'
import { buildProviderPermissionDiagnostics } from './providerPermissionDiagnostics'

type Screen = 'profiles' | 'settings' | 'direct-access' | ServiceId
type PendingTerminalCommand = { id: number; command: string } | null
type RefreshState = { screen: Screen; sawPending: boolean } | null
type FabMode = 'closed' | 'menu' | 'credentials'
type CompareSeed = { token: number; request: ComparisonRequest } | null
type CompareSeedByScope = Partial<Record<string, NonNullable<CompareSeed>>>
type ProfileContextMenuState = { profileName: string; x: number; y: number } | null
type AuditSummary = {
  total: number
  blocked: number
  failed: number
}
const PINNED_SERVICES_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:pinned-services`
const ENVIRONMENT_ONBOARDING_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:environment-onboarding-v1`
const GCP_CONNECTION_CONTEXT_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:gcp-connection-context-v1`
const GCP_CLI_CONTEXT_CACHE_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:gcp-cli-context-cache-v1`
const GCP_RECENT_PROJECTS_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:gcp-recent-projects-v1`
type EnvironmentOnboardingStep = 'profile' | 'region' | 'tooling' | 'access'
type EnvironmentOnboardingState = {
  dismissed: boolean
  lastStep: EnvironmentOnboardingStep
}
type FocusMap = Partial<Record<NavigationFocus['service'], TokenizedFocus>>
type FocusMapByScope = Partial<Record<string, FocusMap>>
type ProviderConnectionMode = {
  id: string
  label: string
  detail: string
  status: 'Live now' | 'Phase 4 preview'
}
type PreviewProviderId = Exclude<CloudProviderId, 'aws'>
type GcpConnectionDraft = {
  projectId: string
  location: string
  credentialHint: string
}
type GcpConnectionDraftByMode = Partial<Record<string, GcpConnectionDraft>>

type ProviderPreviewNavItem = {
  id: string
  label: string
  detail: string
}

type ProviderPreviewNavSection = {
  id: string
  label: string
  items: ProviderPreviewNavItem[]
}

type ProviderTerminalPreviewPreset = {
  id: string
  label: string
  command: string
  detail: string
}

type ProviderTerminalPreviewModel = {
  cliLabel: string
  authLabel: string
  contextLabel: string
  contextDetail: string
  helperIntro: string
  helpers: ProviderTerminalPreviewPreset[]
}

const NAV_PRIORITY_SERVICE_IDS: ServiceId[] = ['overview', 'session-hub']
const NAV_SECTION_EXCLUDED_SERVICE_IDS = new Set<ServiceId>(NAV_PRIORITY_SERVICE_IDS)
const ENVIRONMENT_ONBOARDING_STEPS: EnvironmentOnboardingStep[] = ['profile', 'region', 'tooling', 'access']
const SERVICE_CATEGORY_ORDER = [
  'Infrastructure',
  'Compute',
  'Data',
  'Operations',
  'Storage',
  'Database',
  'Containers',
  'Networking',
  'Security',
  'Management',
  'Messaging'
] as const

const SERVICE_DESCRIPTIONS: Record<ServiceId, string> = {
  terraform: 'Terraform project browser and command execution workspace.',
  overview: 'Regional summary landing page across active provider services.',
  'session-hub': 'Saved assume-role targets, active temporary sessions, activation, expiration, and cross-account comparison.',
  compare: 'Diff-oriented workspace for comparing two account or region contexts across inventory, posture, tags, and cost signals.',
  'compliance-center': 'Operational and security findings workspace with grouped policy checks and guided remediation.',
  ec2: 'Instances, snapshots, IAM profiles, bastions, and instance actions.',
  cloudwatch: 'Metrics, logs, and recent service telemetry.',
  s3: 'Bucket inventory, objects, and common storage actions.',
  lambda: 'Functions, versions, logs, and invocation workflows.',
  rds: 'Databases, snapshots, status, and operational detail.',
  cloudformation: 'Stacks, events, resources, and deployment status.',
  cloudtrail: 'Trail inventory and event lookup workflows.',
  ecr: 'Repositories, images, scans, and registry login flows.',
  eks: 'Clusters, nodegroups, updates, and kubectl helpers.',
  ecs: 'Clusters, services, tasks, scaling, and redeploy flows.',
  vpc: 'Topology, reachability, gateways, interfaces, and flow diagrams.',
  'load-balancers': 'Listeners, target groups, health, timeline, and delete actions.',
  'auto-scaling': 'Groups, scaling activity, and capacity controls.',
  route53: 'Hosted zones, records, and DNS change workflows.',
  'security-groups': 'Ingress, egress, rule management, and group detail.',
  iam: 'Users, groups, roles, policies, account summary, and simulators.',
  'identity-center': 'Instances, users, groups, permission sets, and assignments.',
  sns: 'Topics, subscriptions, attributes, publish, and tagging.',
  sqs: 'Queues, attributes, messages, visibility, and timelines.',
  acm: 'Certificate list, request flow, detail inspection, and safe deletion.',
  'secrets-manager': 'Secret inventory, versions, values, policy, restore, rotate, and tags.',
  'key-pairs': 'EC2 key pair inventory with private key download on create.',
  sts: 'Caller identity, auth decoding, access key lookup, and assume-role credentials.',
  kms: 'Key inventory, key detail panel, and ciphertext blob decryption.',
  waf: 'Web ACL inventory, rule editing, associations, and scope switching.',
  'gcp-compute-engine': 'Project-aware Compute Engine entry point staged for instance inventory and operator actions.',
  'gcp-gke': 'Project-aware GKE entry point staged for cluster posture, upgrades, and shell handoff.',
  'gcp-cloud-storage': 'Project-aware Cloud Storage entry point staged for bucket inventory, object posture, and shell handoff.',
  'gcp-cloud-sql': 'Project-aware Cloud SQL entry point staged for database posture, instance inventory, and connection helpers.',
  'gcp-logging': 'Project-aware Logging entry point staged for log exploration, query posture, and shell handoff.',
  'gcp-billing': 'Project-aware Billing Basics entry point staged for project cost posture and shared shell context.'
}

const SERVICE_MATURITY_LABELS: Record<ServiceMaturity, string> = {
  'production-ready': 'Production-ready',
  beta: 'Beta',
  experimental: 'Experimental'
}

const IMPLEMENTED_SCREENS = new Set<ServiceId>([
  'terraform',
  'overview',
  'session-hub',
  'compare',
  'compliance-center',
  'ec2',
  'cloudwatch',
  's3',
  'lambda',
  'auto-scaling',
  'rds',
  'cloudformation',
  'cloudtrail',
  'ecr',
  'eks',
  'ecs',
  'vpc',
  'load-balancers',
  'route53',
  'security-groups',
  'acm',
  'iam',
  'identity-center',
  'sns',
  'sqs',
  'secrets-manager',
  'key-pairs',
  'sts',
  'kms',
  'waf'
])

const DEFAULT_PROVIDER_ID: CloudProviderId = 'aws'

const PROVIDER_CONNECTION_MODES: Record<CloudProviderId, ProviderConnectionMode[]> = {
  aws: [
    {
      id: 'aws-local-profiles',
      label: 'Local profile catalog',
      detail: 'Reuse profiles discovered from local config or credentials files, plus vault-backed profiles created inside the app.',
      status: 'Live now'
    },
    {
      id: 'aws-assumed-roles',
      label: 'Assumed role sessions',
      detail: 'Keep Session Hub handoffs and role activation flows as the AWS source context for shared workspaces.',
      status: 'Live now'
    },
    {
      id: 'aws-region-binding',
      label: 'Region-bound shell context',
      detail: 'Persist a single AWS region across Overview, service consoles, terminal, and direct access flows.',
      status: 'Live now'
    }
  ],
  gcp: [
    {
      id: 'gcp-adc',
      label: 'Application default credentials',
      detail: 'Stage a selector for local ADC sessions before GCP services land in thin vertical slices.',
      status: 'Phase 4 preview'
    },
    {
      id: 'gcp-service-account',
      label: 'Service account handoff',
      detail: 'Prepare a secure import path for service account JSON without fragmenting the shared shell.',
      status: 'Phase 4 preview'
    },
    {
      id: 'gcp-project-context',
      label: 'Project and location context',
      detail: 'Reserve project and location slots so the rail, terminal, and diagnostics can pivot cleanly later.',
      status: 'Phase 4 preview'
    }
  ],
  azure: [
    {
      id: 'azure-subscription',
      label: 'Subscription selector',
      detail: 'Stage subscription-focused onboarding without breaking the shared workspaces that already exist.',
      status: 'Phase 4 preview'
    },
    {
      id: 'azure-tenant',
      label: 'Tenant-aware access flow',
      detail: 'Prepare room for tenant selection and identity validation before the first Azure provider slices ship.',
      status: 'Phase 4 preview'
    },
    {
      id: 'azure-cli-assist',
      label: 'CLI-assisted verification',
      detail: 'Reserve shell messaging for future device login, `az` validation, and scoped diagnostics.',
      status: 'Phase 4 preview'
    }
  ]
}

const PROVIDER_PREVIEW_NAV_SECTIONS: Record<Exclude<CloudProviderId, 'aws'>, ProviderPreviewNavSection[]> = {
  gcp: [],
  azure: [
    {
      id: 'azure-core',
      label: 'Core',
      items: [
        { id: 'azure-resource-groups', label: 'Resource Groups', detail: 'Subscription inventory and grouping' },
        { id: 'azure-vm', label: 'Virtual Machines', detail: 'VM operations and access context' }
      ]
    },
    {
      id: 'azure-platform',
      label: 'Platform',
      items: [
        { id: 'azure-aks', label: 'AKS', detail: 'Cluster lifecycle and kubectl handoff' },
        { id: 'azure-storage', label: 'Storage Accounts', detail: 'Storage posture and object workflows' }
      ]
    },
    {
      id: 'azure-ops',
      label: 'Operations',
      items: [
        { id: 'azure-sql', label: 'Azure SQL', detail: 'Database inventory and connection helpers' },
        { id: 'azure-monitor', label: 'Monitor', detail: 'Telemetry, alerts, and diagnostics posture' }
      ]
    }
  ]
}

const PROVIDER_AFFORDANCE_LABELS: Record<CloudProviderId, string> = {
  aws: 'Live shell',
  gcp: 'Shared preview',
  azure: 'Shared preview'
}

const PROVIDER_TERMINAL_PREVIEWS: Record<Exclude<CloudProviderId, 'aws'>, ProviderTerminalPreviewModel> = {
  gcp: {
    cliLabel: 'gcloud',
    authLabel: 'ADC or service account',
    contextLabel: 'Project and location context will be injected here.',
    contextDetail: 'The shared drawer now pivots to Google Cloud helper flows so auth, config, and smoke-test commands can attach to the same provider selection.',
    helperIntro: 'Use the staged helper set to validate Google Cloud auth, inspect the active config, and confirm project or region targeting before live PTY injection lands.',
    helpers: [
      {
        id: 'gcp-auth-list',
        label: 'Auth inventory',
        command: 'gcloud auth list',
        detail: 'Check which account or service account is active before opening provider workspaces.'
      },
      {
        id: 'gcp-config-list',
        label: 'Config snapshot',
        command: 'gcloud config list --all',
        detail: 'Inspect project, region, zone, and active configuration values.'
      },
      {
        id: 'gcp-project-check',
        label: 'Project smoke test',
        command: 'gcloud projects list --limit=20',
        detail: 'Verify the shell can enumerate accessible projects with the selected auth flow.'
      }
    ]
  },
  azure: {
    cliLabel: 'az',
    authLabel: 'Device login or tenant handoff',
    contextLabel: 'Tenant and subscription context will be injected here.',
    contextDetail: 'The shared drawer now pivots to Azure helper flows so device login, tenant checks, and subscription inspection can follow the provider selector.',
    helperIntro: 'Use the staged helper set to validate Azure login state, inspect active account targeting, and confirm subscription context before live PTY injection lands.',
    helpers: [
      {
        id: 'azure-account-show',
        label: 'Account snapshot',
        command: 'az account show --output table',
        detail: 'Confirm the currently active subscription, tenant, and default account context.'
      },
      {
        id: 'azure-account-list',
        label: 'Subscription inventory',
        command: 'az account list --output table',
        detail: 'Review accessible subscriptions before the adaptive shell binds one as the active context.'
      },
      {
        id: 'azure-group-list',
        label: 'Resource group smoke test',
        command: 'az group list --output table',
        detail: 'Verify ARM access from the staged provider-aware shell surface.'
      }
    ]
  }
}

const SOFT_REFRESH_SCREENS = new Set<Screen>([
  'overview',
  'compare',
  'compliance-center',
  'terraform',
  'ec2',
  'cloudformation',
  'ecs',
  'load-balancers'
])

function buildPreviewProviderTerminalEnv(
  providerId: PreviewProviderId,
  providerLabel: string,
  mode: ProviderConnectionMode,
  options?: {
    gcpContext?: GcpConnectionDraft | null
    gcpCliPath?: string
    azureCliPath?: string
  }
): Record<string, string> {
  const baseEnv = {
    CLOUD_LENS_PROVIDER: providerId,
    CLOUD_LENS_PROVIDER_LABEL: providerLabel,
    CLOUD_LENS_CONTEXT: `${providerLabel} | ${mode.label}`,
    CLOUD_LENS_CONNECTION_MODE: mode.label,
    CLOUD_LENS_CONNECTION_MODE_ID: mode.id
  }

  if (providerId === 'gcp') {
    return {
      ...baseEnv,
      CLOUD_LENS_GCP_MODE: mode.label,
      CLOUD_LENS_GCP_MODE_ID: mode.id,
      CLOUD_LENS_GCP_PROJECT: options?.gcpContext?.projectId.trim() || '',
      CLOUD_LENS_GCP_LOCATION: options?.gcpContext?.location.trim() || '',
      CLOUD_LENS_GCP_CREDENTIAL_HINT: options?.gcpContext?.credentialHint.trim() || '',
      CLOUD_LENS_GCP_CLI_PATH: options?.gcpCliPath?.trim() || ''
    }
  }

  return {
    ...baseEnv,
    CLOUD_LENS_AZURE_MODE: mode.label,
    CLOUD_LENS_AZURE_MODE_ID: mode.id,
    CLOUD_LENS_AZURE_CLI_PATH: options?.azureCliPath?.trim() || ''
  }
}

function ConnectedServiceScreen({
  service,
  state,
  hideHero,
  children
}: {
  service: ServiceDescriptor
  state: ReturnType<typeof useAwsPageConnection>
  hideHero?: boolean
  children: (connection: NonNullable<ReturnType<typeof useAwsPageConnection>['connection']>) => React.ReactNode
}) {
  return (
    <>
      {state.error && <div className="error-banner">{state.error}</div>}
      {state.connection && state.connected ? (
        children(state.connection)
      ) : (
        <section className={hideHero ? 'empty-hero empty-hero-compact' : 'empty-hero'}>
          <div>
            <div className="eyebrow">{service.label}</div>
            <h2>{service.label} needs an active provider context</h2>
            <SvcState
              variant="no-selection"
              resourceName="provider profile"
              message={`Select a provider profile from the catalog to open ${service.label}. ${SERVICE_DESCRIPTIONS[service.id]}`}
            />
          </div>
        </section>
      )}
    </>
  )
}

function extractQuotedCommand(error: string): string | null {
  const match = error.match(/Run "([^"]+)"/i)
  return match?.[1]?.trim() || null
}

function getGcpComputeEnableAction(error: string, projectId: string): { command: string; summary: string } | null {
  if (!error.toLowerCase().includes('google cloud api access failed')) {
    return null
  }

  return {
    command: extractQuotedCommand(error) ?? `gcloud services enable compute.googleapis.com --project ${projectId}`,
    summary: `Compute Engine API is disabled for project ${projectId}.`
  }
}

function getProfileBadge(name?: string | null): string {
  const parts = (name ?? '')
    .split(/[\s-_]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length === 0) {
    return 'BO'
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function getRoleDisplayName(roleArn?: string | null): string {
  if (!roleArn) {
    return ''
  }

  const trimmed = roleArn.trim()
  if (!trimmed) {
    return ''
  }

  const roleMarker = ':role/'
  const markerIndex = trimmed.indexOf(roleMarker)
  if (markerIndex >= 0) {
    return trimmed.slice(markerIndex + roleMarker.length)
  }

  const slashIndex = trimmed.lastIndexOf('/')
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed
}

function formatScreenLabel(screen: Screen): string {
  switch (screen) {
    case 'profiles':
      return 'Connection Selector'
    case 'settings':
      return 'Settings'
    case 'direct-access':
      return 'Direct Resource Access'
    default:
      return screen
        .split('-')
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(' ')
  }
}

function isRestorableAwsScreen(screen: Screen): boolean {
  return screen !== 'profiles' && screen !== 'settings'
}

function getAwsScreenMemoryKey(profileName: string | null | undefined): string {
  return (profileName ?? '').trim()
}

function screenInstanceScopeSuffix(screen: Screen, awsScopeKey: string, providerId: CloudProviderId): string {
  if (providerId === 'aws' && screen === 'compare' && awsScopeKey) {
    return `aws:${awsScopeKey}`
  }

  return providerId
}

function PlaceholderScreen({
  service,
  eyebrow = 'Catalog',
  statusLabel,
  contextLabel,
  contextDetail,
  emptyTitle,
  emptyCopy
}: {
  service: ServiceDescriptor
  eyebrow?: string
  statusLabel?: string
  contextLabel?: string
  contextDetail?: string
  emptyTitle?: string
  emptyCopy?: string
}) {
  return (
    <>
      {contextLabel ? (
        <section className="panel stack">
          <div className="catalog-page-header">
            <div>
              <div className="eyebrow">Current context</div>
              <h3>{contextLabel}</h3>
              {contextDetail ? <p className="hero-path">{contextDetail}</p> : null}
            </div>
          </div>
        </section>
      ) : null}
      <section className="panel stack">
        <div className="catalog-page-header">
          <div>
            <div className="eyebrow">{eyebrow}</div>
            <h3>{emptyTitle || `${service.label} is listed but not wired into this shell yet`}</h3>
            <p>{emptyCopy || SERVICE_DESCRIPTIONS[service.id]}</p>
          </div>
          <div className="hero-connection">
            <div className="connection-summary">
              <span>Status</span>
              <strong>{statusLabel || (service.migrated ? 'Cataloged' : 'Planned')}</strong>
            </div>
            <div className="connection-summary">
              <span>Category</span>
              <strong>{service.category || 'General'}</strong>
            </div>
            <div className="connection-summary">
              <span>Maturity</span>
              <strong>{SERVICE_MATURITY_LABELS[service.maturity]}</strong>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

function GcpComputeEngineConsole({
  projectId,
  location,
  refreshNonce,
  onRunTerminalCommand
}: {
  projectId: string
  location: string
  refreshNonce: number
  onRunTerminalCommand: (command: string) => void
}) {
  const [instances, setInstances] = useState<GcpComputeInstanceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastLoadedAt, setLastLoadedAt] = useState('')

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError('')

    void listGcpComputeInstances(projectId, location)
      .then((nextInstances) => {
        if (cancelled) {
          return
        }

        setInstances(nextInstances)
        setLastLoadedAt(new Date().toISOString())
      })
      .catch((err) => {
        if (cancelled) {
          return
        }

        setError(err instanceof Error ? err.message : String(err))
        setInstances([])
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [location, projectId, refreshNonce])

  const locationLabel = location.trim() || 'all locations'
  const lastLoadedLabel = lastLoadedAt ? new Date(lastLoadedAt).toLocaleTimeString() : 'Pending'
  const enableAction = error ? getGcpComputeEnableAction(error, projectId) : null

  return (
    <>
      <section className="panel stack">
        <div className="catalog-page-header">
          <div>
            <div className="eyebrow">Compute Engine</div>
            <h3>{projectId}</h3>
            <p>Read-only instance inventory scoped to the selected Google Cloud project and location.</p>
          </div>
          <div className="hero-connection">
            <div className="connection-summary">
              <span>Project</span>
              <strong>{projectId}</strong>
            </div>
            <div className="connection-summary">
              <span>Location</span>
              <strong>{locationLabel}</strong>
            </div>
            <div className="connection-summary">
              <span>Last sync</span>
              <strong>{loading ? 'Syncing...' : lastLoadedLabel}</strong>
            </div>
          </div>
        </div>
      </section>
      {error ? (
        <section className="panel stack">
          {enableAction ? (
            <div className="error-banner gcp-enable-error-banner">
              <div className="gcp-enable-error-copy">
                <strong>{enableAction.summary}</strong>
                <p>Run the enable command in the terminal, wait for propagation, then refresh gcloud.</p>
              </div>
              <div className="gcp-enable-error-actions">
                <button
                  type="button"
                  className="accent"
                  onClick={() => onRunTerminalCommand(enableAction.command)}
                  title={enableAction.command}
                >
                  Run enable command in terminal
                </button>
              </div>
            </div>
          ) : (
            <div className="error-banner">{error}</div>
          )}
          <div className="profile-catalog-empty">
            <div className="eyebrow">Compute Engine Access</div>
            <h3>Instance inventory could not be loaded</h3>
            <p className="hero-path">Verify the selected project, enabled APIs, and active gcloud account, then retry the refresh.</p>
          </div>
        </section>
      ) : loading ? (
        <section className="panel stack">
          <div className="profile-catalog-empty">
            <div className="eyebrow">Loading</div>
            <h3>Importing Compute Engine inventory</h3>
            <p className="hero-path">Reading instances from the active gcloud session for {projectId} in {locationLabel}.</p>
          </div>
        </section>
      ) : instances.length === 0 ? (
        <section className="panel stack">
          <div className="profile-catalog-empty">
            <div className="eyebrow">No Instances</div>
            <h3>No Compute Engine instances were found</h3>
            <p className="hero-path">No instances matched {locationLabel} in project {projectId}. Refresh gcloud after changing project context or region filters.</p>
          </div>
        </section>
      ) : (
        <section className="panel stack">
          <div className="catalog-page-header">
            <div>
              <div className="eyebrow">Instance Inventory</div>
              <h3>{instances.length} instance{instances.length === 1 ? '' : 's'}</h3>
              <p>{locationLabel} scope with live data from the active gcloud session.</p>
            </div>
          </div>
          <div className="profile-catalog-grid">
            {instances.map((instance) => (
              <article key={`${instance.zone}:${instance.name}`} className="profile-catalog-card">
                <div className="profile-catalog-status">
                  <span>{instance.zone}</span>
                  <strong>{instance.status || 'UNKNOWN'}</strong>
                </div>
                <div className="project-card-title">{instance.name}</div>
                <div className="project-card-subtitle">{instance.machineType || 'Machine type unavailable'}</div>
                <div className="hero-path" style={{ marginTop: 12 }}>
                  Internal IP: {instance.internalIp || 'n/a'}
                  <br />
                  External IP: {instance.externalIp || 'n/a'}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function ProviderPreviewScreen({
  provider,
  screen,
  description,
  contextLabel,
  contextDetail
}: {
  provider: ProviderDescriptor
  screen: Screen
  description: string
  contextLabel?: string
  contextDetail?: string
}) {
  const modes = PROVIDER_CONNECTION_MODES[provider.id]

  return (
    <section className={`panel stack provider-preview-shell provider-preview-shell-${provider.id}`}>
      <div className="catalog-page-header">
        <div>
          <div className="eyebrow">{provider.label} Preview</div>
          <h3>{formatScreenLabel(screen)} stays in preview for now.</h3>
          <p>{description}</p>
        </div>
        <span className="enterprise-mode-pill read-only">Phase 5 preview</span>
      </div>
      {contextLabel ? (
        <div className="provider-preview-context">
          <span className="provider-preview-context-label">Current context</span>
          <strong>{contextLabel}</strong>
          {contextDetail ? <small>{contextDetail}</small> : null}
        </div>
      ) : null}
      <div className="provider-preview-grid">
        {modes.map((mode) => (
          <article key={mode.id} className={`profile-catalog-card provider-mode-card provider-mode-card-${provider.id}`}>
            <div className="profile-catalog-status">
              <span>{mode.label}</span>
              <strong>{mode.status}</strong>
            </div>
            <p className="provider-mode-card-copy">{mode.detail}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function InitialLoadingScreen(): JSX.Element {
  return (
    <section className="initial-loading-shell" aria-live="polite" aria-busy="true">
      <div className="initial-loading-card">
        <img src={appLogoUrl} alt={PRODUCT_BRAND_NAME} className="initial-loading-logo" />
        <div className="eyebrow">{PRODUCT_BRAND_NAME}</div>
        <h1>{PRODUCT_BRAND_NAME} is loading</h1>
        <p>Initializing workspace shell, provider registry, settings, and service catalog.</p>
        <div className="initial-loading-progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </section>
  )
}

function readEnvironmentOnboardingState(): EnvironmentOnboardingState {
  try {
    const raw = window.localStorage.getItem(ENVIRONMENT_ONBOARDING_STORAGE_KEY)
    if (!raw) {
      return {
        dismissed: false,
        lastStep: 'profile'
      }
    }

    if (raw === 'dismissed') {
      return {
        dismissed: true,
        lastStep: 'access'
      }
    }

    const parsed = JSON.parse(raw) as Partial<EnvironmentOnboardingState>
    const lastStep = ENVIRONMENT_ONBOARDING_STEPS.includes(parsed.lastStep as EnvironmentOnboardingStep)
      ? parsed.lastStep as EnvironmentOnboardingStep
      : 'profile'

    return {
      dismissed: parsed.dismissed === true,
      lastStep
    }
  } catch {
    return {
      dismissed: false,
      lastStep: 'profile'
    }
  }
}

function writeEnvironmentOnboardingState(state: EnvironmentOnboardingState): void {
  try {
    window.localStorage.setItem(ENVIRONMENT_ONBOARDING_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore onboarding persistence failures and keep the current in-memory flow.
  }
}

function createDefaultGcpConnectionDraft(modeId?: string): GcpConnectionDraft {
  return {
    projectId: '',
    location: modeId === 'gcp-project-context' ? 'global' : 'us-central1',
    credentialHint: ''
  }
}

function mergeGcpLocations(...lists: Array<string[]>): string[] {
  const merged = new Set<string>()

  for (const list of lists) {
    for (const location of list) {
      const normalized = location.trim()
      if (!normalized) {
        continue
      }

      merged.add(normalized)
    }
  }

  return [...merged].sort((left, right) => {
    if (left === 'global') {
      return -1
    }

    if (right === 'global') {
      return 1
    }

    return left.localeCompare(right)
  })
}

function readGcpConnectionDrafts(): GcpConnectionDraftByMode {
  try {
    const raw = window.localStorage.getItem(GCP_CONNECTION_CONTEXT_STORAGE_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as Record<string, Partial<GcpConnectionDraft>>
    const entries = Object.entries(parsed).map(([modeId, draft]) => [
      modeId,
      {
        projectId: typeof draft.projectId === 'string' ? draft.projectId : '',
        location: typeof draft.location === 'string' ? draft.location : createDefaultGcpConnectionDraft(modeId).location,
        credentialHint: typeof draft.credentialHint === 'string' ? draft.credentialHint : ''
      } satisfies GcpConnectionDraft
    ] as const)

    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

function writeGcpConnectionDrafts(drafts: GcpConnectionDraftByMode): void {
  try {
    window.localStorage.setItem(GCP_CONNECTION_CONTEXT_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Ignore preview context persistence failures and keep the current in-memory state.
  }
}

function readGcpCliContextCache(): GcpCliContext | null {
  try {
    const raw = window.localStorage.getItem(GCP_CLI_CONTEXT_CACHE_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<GcpCliContext>
    return {
      detected: parsed.detected === true,
      cliPath: typeof parsed.cliPath === 'string' ? parsed.cliPath : '',
      activeConfigurationName: typeof parsed.activeConfigurationName === 'string' ? parsed.activeConfigurationName : '',
      activeAccount: typeof parsed.activeAccount === 'string' ? parsed.activeAccount : '',
      activeProjectId: typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : '',
      activeRegion: typeof parsed.activeRegion === 'string' ? parsed.activeRegion : '',
      activeZone: typeof parsed.activeZone === 'string' ? parsed.activeZone : '',
      configurations: Array.isArray(parsed.configurations) ? parsed.configurations : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      locations: Array.isArray(parsed.locations) ? parsed.locations.filter((value): value is string => typeof value === 'string') : []
    }
  } catch {
    return null
  }
}

function writeGcpCliContextCache(context: GcpCliContext | null): void {
  try {
    if (!context) {
      window.localStorage.removeItem(GCP_CLI_CONTEXT_CACHE_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(GCP_CLI_CONTEXT_CACHE_STORAGE_KEY, JSON.stringify(context))
  } catch {
    // Ignore GCP CLI cache persistence failures and keep the current in-memory state.
  }
}

function readGcpRecentProjectIds(): string[] {
  try {
    const raw = window.localStorage.getItem(GCP_RECENT_PROJECTS_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function writeGcpRecentProjectIds(projectIds: string[]): void {
  try {
    window.localStorage.setItem(GCP_RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(projectIds))
  } catch {
    // Ignore recent project persistence failures and keep the current in-memory state.
  }
}

function getGcpCredentialFieldCopy(modeId?: string): { label: string; placeholder: string; helper: string } {
  switch (modeId) {
    case 'gcp-service-account':
      return {
        label: 'Service account email',
        placeholder: 'cloud-ops@project-id.iam.gserviceaccount.com',
        helper: 'Store the service account identity that should seed the shared shell context.'
      }
    case 'gcp-project-context':
      return {
        label: 'Project alias',
        placeholder: 'prod-core',
        helper: 'Use a short alias if you want the catalog and terminal banner to show a friendlier project handle.'
      }
    default:
      return {
        label: 'ADC source',
        placeholder: 'default',
        helper: 'Capture the gcloud config or local ADC profile that should seed this project context.'
      }
  }
}

function isGcpContextReady(mode: ProviderConnectionMode | null, draft: GcpConnectionDraft | null): boolean {
  return Boolean(mode && draft?.projectId.trim() && draft.location.trim())
}

function inferGcpModeIdFromContext(context: GcpCliContext): string {
  if (context.activeAccount.endsWith('.iam.gserviceaccount.com')) {
    return 'gcp-service-account'
  }

  return 'gcp-adc'
}

function buildGcpDraftFromContext(context: GcpCliContext, modeId: string, current?: GcpConnectionDraft | null): GcpConnectionDraft {
  const defaultDraft = createDefaultGcpConnectionDraft(modeId)
  const inferredLocation = context.activeRegion || context.activeZone || defaultDraft.location
  const inferredCredentialHint =
    modeId === 'gcp-service-account'
      ? context.activeAccount
      : modeId === 'gcp-project-context'
        ? context.activeConfigurationName || context.activeAccount
        : context.activeConfigurationName || context.activeAccount

  return {
    projectId: current?.projectId.trim() || context.activeProjectId || current?.projectId || '',
    location: current?.location.trim() || inferredLocation,
    credentialHint: current?.credentialHint.trim() || inferredCredentialHint || ''
  }
}

function screenCacheTag(screen: Screen): CacheTag | null {
  switch (screen) {
    case 'overview':
    case 'compare':
    case 'compliance-center':
    case 'ec2':
    case 'cloudwatch':
    case 's3':
    case 'lambda':
    case 'auto-scaling':
    case 'rds':
    case 'cloudformation':
    case 'cloudtrail':
    case 'ecr':
    case 'eks':
    case 'ecs':
    case 'vpc':
    case 'load-balancers':
    case 'route53':
    case 'security-groups':
    case 'acm':
    case 'iam':
    case 'sns':
    case 'sqs':
    case 'secrets-manager':
    case 'key-pairs':
    case 'sts':
    case 'kms':
    case 'waf':
    case 'identity-center':
      return screen
    case 'gcp-compute-engine':
    case 'gcp-gke':
    case 'gcp-cloud-storage':
    case 'gcp-cloud-sql':
    case 'gcp-logging':
    case 'gcp-billing':
      return 'shell'
    case 'session-hub':
      return null
    default:
      return null
  }
}

function isProviderService(service: ServiceDescriptor | null, providerId: CloudProviderId): boolean {
  return service?.providerId === providerId
}

function isProviderRefreshReady(
  providerId: CloudProviderId,
  activeCacheTag: CacheTag | null,
  activeShellConnection: AwsConnection | null,
  activeShellConnected: boolean,
  gcpContextReady: boolean,
  selectedPreviewMode: ProviderConnectionMode | null,
  selectedService: ServiceDescriptor | null
): boolean {
  if (!activeCacheTag) {
    return false
  }

  if (providerId === 'aws') {
    return Boolean(activeShellConnection && activeShellConnected)
  }

  if (!isProviderService(selectedService, providerId)) {
    return false
  }

  return providerId === 'gcp' ? gcpContextReady : selectedPreviewMode !== null
}

function refreshTagsForScreen(screen: Screen): CacheTag[] {
  const primaryTag = screenCacheTag(screen)

  if (!primaryTag) {
    return []
  }

  switch (screen) {
    case 'ec2':
      return ['ec2', 'key-pairs', 'vpc', 'cloudtrail']
    default:
      return [primaryTag]
  }
}

export function App() {
  const [releaseInfo, setReleaseInfo] = useState<AppReleaseInfo | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [servicesHydrated, setServicesHydrated] = useState(false)
  const [settingsHydrated, setSettingsHydrated] = useState(false)
  const [screen, setScreen] = useState<Screen>('profiles')
  const [lastAwsScreenByProfile, setLastAwsScreenByProfile] = useState<Partial<Record<string, Screen>>>({})
  const [navOpen, setNavOpen] = useState(true)
  const [visitedScreens, setVisitedScreens] = useState<Screen[]>(['profiles'])
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [activeProviderId, setActiveProviderId] = useState<CloudProviderId>(DEFAULT_PROVIDER_ID)
  const [selectedPreviewModeIds, setSelectedPreviewModeIds] = useState<Partial<Record<PreviewProviderId, string>>>({})
  const [gcpConnectionDrafts, setGcpConnectionDrafts] = useState<GcpConnectionDraftByMode>(() => readGcpConnectionDrafts())
  const [gcpCliContext, setGcpCliContext] = useState<GcpCliContext | null>(() => readGcpCliContextCache())
  const [recentGcpProjectIds, setRecentGcpProjectIds] = useState<string[]>(() => readGcpRecentProjectIds())
  const [gcpCliBusy, setGcpCliBusy] = useState(false)
  const [gcpProjectCatalogBusy, setGcpProjectCatalogBusy] = useState(false)
  const [gcpCliError, setGcpCliError] = useState('')
  const [workspaceCatalog, setWorkspaceCatalog] = useState<WorkspaceCatalog | null>(null)
  const [services, setServices] = useState<ServiceDescriptor[]>([])
  const [pinnedServiceIds, setPinnedServiceIds] = useState<ServiceId[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [profileSearch, setProfileSearch] = useState('')
  const [gcpProjectSearch, setGcpProjectSearch] = useState('')
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<PendingTerminalCommand>(null)
  const [pageRefreshNonceByScreen, setPageRefreshNonceByScreen] = useState<Record<string, number>>({})
  const [connectionRenderEpoch, setConnectionRenderEpoch] = useState(0)
  const [refreshState, setRefreshState] = useState<RefreshState>(null)
  const [fabMode, setFabMode] = useState<FabMode>('closed')
  const [credName, setCredName] = useState('')
  const [credKeyId, setCredKeyId] = useState('')
  const [credSecret, setCredSecret] = useState('')
  const [credSaving, setCredSaving] = useState(false)
  const [credError, setCredError] = useState('')
  const [profileActionMsg, setProfileActionMsg] = useState('')
  const [settingsMessage, setSettingsMessage] = useState('')
  const [environmentHealth, setEnvironmentHealth] = useState<EnvironmentHealthReport | null>(null)
  const [environmentBusy, setEnvironmentBusy] = useState(false)
  const settingsEnvironmentHydratedRef = useRef(false)
  const onboardingEnvironmentHydratedRef = useRef(false)
  const [governanceDefaults, setGovernanceDefaults] = useState<GovernanceTagDefaults | null>(null)
  const [toolchainInfo, setToolchainInfo] = useState<TerraformCliInfo | null>(null)
  const [toolchainBusy, setToolchainBusy] = useState(false)
  const [securitySummary, setSecuritySummary] = useState<AppSecuritySummary | null>(null)
  const [showEnvironmentOnboarding, setShowEnvironmentOnboarding] = useState(false)
  const [environmentOnboardingStep, setEnvironmentOnboardingStep] = useState<EnvironmentOnboardingStep>('profile')
  const [globalWarning, setGlobalWarning] = useState('')
  const [focusMap, setFocusMap] = useState<FocusMap>({})
  const [awsFocusMapByProfile, setAwsFocusMapByProfile] = useState<FocusMapByScope>({})
  const [compareSeedByProfile, setCompareSeedByProfile] = useState<CompareSeedByScope>({})
  const [profileContextMenu, setProfileContextMenu] = useState<ProfileContextMenuState>(null)
  const [auditEvents, setAuditEvents] = useState<EnterpriseAuditEvent[]>([])
  const [enterpriseBusy, setEnterpriseBusy] = useState(false)
  const connectionState = useAwsPageConnection(
    appSettings?.general.defaultRegion ?? 'us-east-1',
    appSettings?.general.defaultProfileName ?? '',
    Boolean(appSettings)
  )
  const awsActivity = useAwsActivity()
  const enterpriseSettings = useEnterpriseSettings()
  const launchScreenInitializedRef = useRef(false)
  const terminalAutoOpenedScopeRef = useRef('')

  useEffect(() => {
    void Promise.all([listProviders(), getWorkspaceCatalog(activeProviderId)])
      .then(([loadedProviders, loadedCatalog]) => {
        setProviders(loadedProviders)
        setWorkspaceCatalog(loadedCatalog)
        setServices(loadedCatalog.allServices)
      })
      .catch((error) => {
        setWorkspaceCatalog(null)
        setCatalogError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setServicesHydrated(true))
  }, [activeProviderId])

  useEffect(() => {
    void getAppReleaseInfo().then(setReleaseInfo).catch(() => {
      // Ignore release check failures in the UI.
    })
  }, [])

  useEffect(() => {
    void getAppSettings()
      .then(setAppSettings)
      .catch(() => {
        // Ignore settings hydration failures until the settings surface is opened.
      })
      .finally(() => setSettingsHydrated(true))
  }, [])

  useEffect(() => {
    void getGovernanceTagDefaults()
      .then(setGovernanceDefaults)
      .catch(() => {
        // Ignore governance defaults hydration failures until the settings surface is opened.
      })
  }, [])

  const showInitialLoadingScreen = !servicesHydrated || !settingsHydrated

  useEffect(() => {
    void detectTerraformCli().then(setToolchainInfo).catch(() => {
      // Ignore toolchain hydration failures until the settings surface is opened.
    })
  }, [])

  useEffect(() => {
    void getAppSecuritySummary().then(setSecuritySummary).catch(() => {
      // Ignore security summary hydration failures until the settings surface is opened.
    })
  }, [])

  async function refreshSecuritySummary(): Promise<void> {
    try {
      setSecuritySummary(await getAppSecuritySummary())
    } catch {
      // Ignore summary refresh failures and keep the current shell state.
    }
  }

  async function loadGcpCliContext(): Promise<void> {
    setGcpCliBusy(true)
    setGcpCliError('')
    try {
      const nextContext = await getGcpCliContext()
      setGcpCliContext((current) => {
        const mergedProjects = current && current.projects.length > nextContext.projects.length
          ? current.projects
          : nextContext.projects
        const mergedLocations = mergeGcpLocations(current?.locations ?? [], nextContext.locations)
        const merged = {
          ...nextContext,
          projects: mergedProjects,
          locations: mergedLocations
        }
        writeGcpCliContextCache(merged)
        return merged
      })
    } catch (error) {
      setGcpCliError(error instanceof Error ? error.message : String(error))
    } finally {
      setGcpCliBusy(false)
    }

    setGcpProjectCatalogBusy(true)
    try {
      const projects = await listGcpProjects()
      setGcpCliContext((current) => {
        const merged = current
          ? { ...current, projects }
          : {
              detected: true,
              cliPath: '',
              activeConfigurationName: '',
              activeAccount: '',
              activeProjectId: '',
              activeRegion: '',
              activeZone: '',
              configurations: [],
              projects,
              locations: []
            }
        writeGcpCliContextCache(merged)
        return merged
      })
    } catch (error) {
      setGcpCliError((current) => current || (error instanceof Error ? error.message : String(error)))
    } finally {
      setGcpProjectCatalogBusy(false)
    }
  }

  useEffect(() => {
    if (!appSettings || launchScreenInitializedRef.current) {
      return
    }

    const targetScreen = appSettings.general.launchScreen
    if (targetScreen === 'profiles') {
      launchScreenInitializedRef.current = true
      return
    }

    if (targetScreen === 'settings' || targetScreen === 'session-hub' || targetScreen === 'terraform') {
      launchScreenInitializedRef.current = true
      setScreen(targetScreen)
      return
    }

    if (targetScreen === 'overview') {
      if (connectionState.profile || connectionState.activeSession || !appSettings.general.defaultProfileName) {
        launchScreenInitializedRef.current = true
        if (connectionState.profile || connectionState.activeSession) {
          setScreen('overview')
        }
      }
    }
  }, [appSettings, connectionState.activeSession, connectionState.profile])

  useEffect(() => {
    void getEnterpriseSettings().catch(() => {
      // Keep local default when enterprise settings are unavailable.
    })
    void listEnterpriseAuditEvents().then(setAuditEvents).catch(() => {
      // Ignore audit hydration failures in the catalog shell.
    })
  }, [])

  useEffect(() => {
    if (activeProviderId !== 'gcp') {
      return
    }

    void loadGcpCliContext()
  }, [activeProviderId])

  useEffect(() => {
    if (screen !== 'settings') {
      return
    }

    if (environmentHealth || environmentBusy || settingsEnvironmentHydratedRef.current) {
      return
    }

    settingsEnvironmentHydratedRef.current = true
    setEnvironmentBusy(true)
    void getEnvironmentHealth()
      .then(setEnvironmentHealth)
      .catch(() => {
        // Ignore environment validation hydration failures in the shell.
      })
      .finally(() => setEnvironmentBusy(false))
  }, [environmentBusy, environmentHealth, screen])

  useEffect(() => {
    const onboardingState = readEnvironmentOnboardingState()
    setEnvironmentOnboardingStep(onboardingState.lastStep)
    if (!onboardingState.dismissed) {
      setShowEnvironmentOnboarding(true)
    }
  }, [])

  useEffect(() => {
    if (!showEnvironmentOnboarding || environmentHealth || environmentBusy || onboardingEnvironmentHydratedRef.current) {
      return
    }

    onboardingEnvironmentHydratedRef.current = true
    setEnvironmentBusy(true)
    void getEnvironmentHealth()
      .then(setEnvironmentHealth)
      .catch(() => {
        // Ignore onboarding hydration failures and let manual refresh handle retries.
      })
      .finally(() => setEnvironmentBusy(false))
  }, [environmentBusy, environmentHealth, showEnvironmentOnboarding])

  useEffect(() => {
    if (!showEnvironmentOnboarding) {
      return
    }

    writeEnvironmentOnboardingState({
      dismissed: false,
      lastStep: environmentOnboardingStep
    })
  }, [environmentOnboardingStep, showEnvironmentOnboarding])

  useEffect(() => {
    if (screen !== 'profiles') {
      return
    }

    void listEnterpriseAuditEvents().then(setAuditEvents).catch(() => {
      // Ignore audit refresh failures in the catalog shell.
    })
  }, [awsActivity.lastCompletedAt, profileActionMsg, screen])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PINNED_SERVICES_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      setPinnedServiceIds(parsed.filter((value): value is ServiceId => typeof value === 'string'))
    } catch {
      // Ignore malformed persisted pin state.
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(PINNED_SERVICES_STORAGE_KEY, JSON.stringify(pinnedServiceIds))
  }, [pinnedServiceIds])

  useEffect(() => {
    writeGcpConnectionDrafts(gcpConnectionDrafts)
  }, [gcpConnectionDrafts])

  useEffect(() => {
    writeGcpRecentProjectIds(recentGcpProjectIds)
  }, [recentGcpProjectIds])

  useEffect(() => {
    if (services.length === 0) return
    const validServiceIds = new Set(services.map((service) => service.id))
    setPinnedServiceIds((current) => current.filter((serviceId) => validServiceIds.has(serviceId) && !NAV_SECTION_EXCLUDED_SERVICE_IDS.has(serviceId)))
  }, [services])

  const pinnedServices = useMemo(() => {
    const serviceById = new Map(services.map((service) => [service.id, service]))
    return pinnedServiceIds
      .map((serviceId) => serviceById.get(serviceId) ?? null)
      .filter((service): service is ServiceDescriptor => service !== null && !NAV_SECTION_EXCLUDED_SERVICE_IDS.has(service.id))
  }, [pinnedServiceIds, services])

  const activeProvider =
    providers.find((provider) => provider.id === activeProviderId) ?? {
      id: DEFAULT_PROVIDER_ID,
      label: 'AWS',
      shortLabel: 'AWS',
      availability: 'available',
      profileLabel: 'Profile',
      locationLabel: 'Region',
      connectionLabel: 'Provider profile or active session'
    }
  const activeProviderThemeClass = `provider-theme-${activeProviderId}`
  const isAwsProviderActive = activeProviderId === 'aws'
  const activePreviewProviderId = isAwsProviderActive ? null : activeProviderId as PreviewProviderId
  const activeShellConnected = isAwsProviderActive && connectionState.connected
  const activeShellConnection = isAwsProviderActive ? connectionState.connection : null
  const activeProviderModes = PROVIDER_CONNECTION_MODES[activeProviderId]
  const sharedWorkspaceCount = workspaceCatalog?.sharedWorkspaces.reduce((total, section) => total + section.items.length, 0) ?? 0
  const providerWorkspaceCount = workspaceCatalog?.providerWorkspaces.reduce((total, section) => total + section.items.length, 0) ?? 0
  const totalProfiles = isAwsProviderActive
    ? connectionState.profiles.length
    : activeProviderId === 'gcp'
      ? gcpCliContext?.projects.length ?? 0
      : activeProviderModes.length
  const totalPinnedProfiles = isAwsProviderActive
    ? connectionState.pinnedProfileNames.length
    : activeProviderId === 'gcp'
      ? gcpCliContext?.configurations.length ?? 0
      : providerWorkspaceCount
  const totalVisibleServices = services.length
  const selectedPreviewModeId = activePreviewProviderId ? selectedPreviewModeIds[activePreviewProviderId] ?? '' : ''
  const selectedPreviewMode = activePreviewProviderId
    ? activeProviderModes.find((mode) => mode.id === selectedPreviewModeId) ?? null
    : null
  const activeGcpConnectionDraft = activeProviderId === 'gcp'
    ? gcpConnectionDrafts[selectedPreviewModeId] ?? (selectedPreviewMode ? createDefaultGcpConnectionDraft(selectedPreviewMode.id) : null)
    : null
  const gcpCredentialFieldCopy = activeProviderId === 'gcp'
    ? getGcpCredentialFieldCopy(selectedPreviewMode?.id)
    : null
  const gcpContextReady = activeProviderId === 'gcp' && isGcpContextReady(selectedPreviewMode, activeGcpConnectionDraft)
  const activeGcpConfiguration = activeProviderId === 'gcp'
    ? gcpCliContext?.configurations.find((entry) => entry.isActive) ?? gcpCliContext?.configurations[0] ?? null
    : null
  const detectedGcpConfigurationCount = gcpCliContext?.configurations.length ?? 0
  const detectedGcpProjectCount = gcpCliContext?.projects.length ?? 0
  const gcpCatalogProjects = activeProviderId === 'gcp' ? gcpCliContext?.projects ?? [] : []
  const gcpLocationOptions = activeProviderId === 'gcp'
    ? mergeGcpLocations(
        gcpCliContext?.locations ?? [],
        activeGcpConfiguration?.region ? [activeGcpConfiguration.region] : [],
        activeGcpConfiguration?.zone ? [activeGcpConfiguration.zone] : [],
        activeGcpConnectionDraft?.location.trim() ? [activeGcpConnectionDraft.location.trim()] : []
      )
    : []
  const detectedGcloudCliPath = environmentHealth?.tools.find((tool) => tool.id === 'gcloud-cli' && tool.found)?.path
    || gcpCliContext?.cliPath
    || ''
  const detectedAzureCliPath = environmentHealth?.tools.find((tool) => tool.id === 'azure-cli' && tool.found)?.path || ''
  const gcpCatalogAccount = activeProviderId === 'gcp'
    ? activeGcpConfiguration?.account || gcpCliContext?.activeAccount || 'Account pending'
    : ''
  const gcpCatalogLocation = activeProviderId === 'gcp'
    ? activeGcpConnectionDraft?.location.trim() || activeGcpConfiguration?.region || activeGcpConfiguration?.zone || 'us-central1'
    : ''
  const serviceNavEnabled = isAwsProviderActive
    ? activeProvider.availability === 'available' && connectionState.connected
    : activeProviderId === 'gcp'
      ? gcpContextReady
      : selectedPreviewMode !== null
  const selectorPrimaryStatLabel = isAwsProviderActive
    ? 'Profiles'
    : activeProviderId === 'gcp'
      ? 'Projects'
      : 'Connection modes'
  const selectorSecondaryStatLabel = isAwsProviderActive
    ? 'Pinned'
    : activeProviderId === 'gcp'
      ? 'Configs'
      : 'Provider workspaces'
  const providerProfileLabel = activeProvider.profileLabel.toLowerCase()
  const providerLocationLabel = activeProvider.locationLabel.toLowerCase()
  const auditSummary = useMemo<AuditSummary>(() => ({
    total: auditEvents.length,
    blocked: auditEvents.filter((event) => event.outcome === 'blocked').length,
    failed: auditEvents.filter((event) => event.outcome === 'failed').length
  }), [auditEvents])

  const filterCatalogSections = (sections: WorkspaceCatalogSection[]): WorkspaceCatalogSection[] => {
    const pinnedIds = new Set(pinnedServiceIds)
    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter((service) => !NAV_SECTION_EXCLUDED_SERVICE_IDS.has(service.id) && !pinnedIds.has(service.id))
      }))
      .filter((section) => section.items.length > 0)
  }

  const sharedWorkspaceSections = useMemo(
    () => filterCatalogSections(workspaceCatalog?.sharedWorkspaces ?? []),
    [pinnedServiceIds, workspaceCatalog]
  )

  const providerWorkspaceSections = useMemo(
    () => filterCatalogSections(workspaceCatalog?.providerWorkspaces ?? []),
    [pinnedServiceIds, workspaceCatalog]
  )

  const categorizedProviderSections = useMemo(() => {
    const grouped = new Map<string, ServiceDescriptor[]>()
    for (const section of providerWorkspaceSections) {
      for (const service of section.items) {
        const category = service.category || 'General'
        const items = grouped.get(category) ?? []
        items.push(service)
        grouped.set(category, items)
      }
    }

    const order = new Map<string, number>(SERVICE_CATEGORY_ORDER.map((category, index) => [category, index]))

    return [...grouped.entries()]
      .map(([category, items]) => ({
        id: `provider-category-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        label: category,
        items: items.sort((left, right) => left.label.localeCompare(right.label))
      }))
      .sort((left, right) => {
        const leftIndex = order.get(left.label) ?? Number.MAX_SAFE_INTEGER
        const rightIndex = order.get(right.label) ?? Number.MAX_SAFE_INTEGER
        return leftIndex - rightIndex || left.label.localeCompare(right.label)
      })
  }, [providerWorkspaceSections])

  const filteredProfiles = useMemo(() => {
    const query = profileSearch.trim().toLowerCase()
    if (!query) return connectionState.profiles
    return connectionState.profiles.filter((entry) => entry.name.toLowerCase().includes(query))
  }, [connectionState.profiles, profileSearch])
  const filteredGcpProjects = useMemo(() => {
    const query = gcpProjectSearch.trim().toLowerCase()

    return gcpCatalogProjects.filter((project) => {
      if (!query) {
        return true
      }

      const haystack = [
        project.projectId,
        project.name,
        project.projectNumber,
        project.lifecycleState,
        gcpCatalogAccount
      ].join(' ').toLowerCase()

      return haystack.includes(query)
    })
  }, [activeGcpConfiguration?.projectId, activeGcpConnectionDraft?.projectId, gcpCatalogAccount, gcpCatalogProjects, gcpCliContext?.activeProjectId, gcpProjectSearch])
  const recentGcpProjects = useMemo(() => {
    const projectMap = new Map(gcpCatalogProjects.map((project) => [project.projectId, project]))
    return recentGcpProjectIds
      .map((projectId) => projectMap.get(projectId) ?? null)
      .filter((project): project is NonNullable<typeof project> => project !== null)
      .slice(0, 4)
  }, [gcpCatalogProjects, recentGcpProjectIds])
  const visibleGcpProjects = useMemo(() => {
    if (gcpProjectSearch.trim()) {
      return filteredGcpProjects
    }

    const recentProjectIds = new Set(recentGcpProjects.map((project) => project.projectId))
    const nonRecentProjects = filteredGcpProjects.filter((project) => !recentProjectIds.has(project.projectId))
    return nonRecentProjects.length > 0 ? nonRecentProjects : filteredGcpProjects
  }, [filteredGcpProjects, gcpProjectSearch, recentGcpProjects])

  const primaryProfileLabel = isAwsProviderActive
    ? connectionState.activeSession?.sourceProfile || connectionState.selectedProfile?.name || connectionState.profile || 'No profile selected'
    : activeProviderId === 'gcp'
      ? activeGcpConnectionDraft?.projectId.trim() || selectedPreviewMode?.label || 'No project selected'
      : selectedPreviewMode?.label || 'No profile selected'
  const assumedRoleLabel = isAwsProviderActive && connectionState.activeSession
    ? `Assumed role: ${getRoleDisplayName(connectionState.activeSession.roleArn) || connectionState.activeSession.label}`
    : ''
  const profileMetaLabel = !isAwsProviderActive
    ? activeProviderId === 'gcp'
      ? selectedPreviewMode
        ? gcpContextReady
          ? `${selectedPreviewMode.label} | ${activeGcpConnectionDraft?.location.trim()} ready`
          : `${selectedPreviewMode.label} | complete project context`
        : 'Select a connection mode'
      : selectedPreviewMode
        ? `${selectedPreviewMode.status} | terminal env ready`
        : 'Select a connection mode'
    : connectionState.activeSession
      ? assumedRoleLabel
      : connectionState.selectedProfile
        ? `${connectionState.selectedProfile.source} profile`
        : 'Click to select a profile'
  const providerMetaLabel = isAwsProviderActive && connectionState.providerConnection
    ? `${activeProvider.locationLabel}: ${connectionState.providerConnection.locationLabel}`
    : activeProviderId === 'gcp'
      ? gcpContextReady
        ? `Project: ${activeGcpConnectionDraft?.projectId.trim()} | ${activeProvider.locationLabel}: ${activeGcpConnectionDraft?.location.trim()}`
        : selectedPreviewMode
          ? `Mode: ${selectedPreviewMode.label}`
          : activeProvider.connectionLabel
      : selectedPreviewMode
        ? `Mode: ${selectedPreviewMode.label}`
        : activeProvider.connectionLabel
  const navSharedServices = NAV_PRIORITY_SERVICE_IDS
    .map((serviceId) => services.find((service) => service.id === serviceId) ?? null)
    .filter((service): service is ServiceDescriptor => service !== null)
  const previewProviderSections = activeProviderId === 'aws' ? [] : PROVIDER_PREVIEW_NAV_SECTIONS[activeProviderId]
  const providerTerminalPreview = activeProviderId === 'aws' ? null : PROVIDER_TERMINAL_PREVIEWS[activeProviderId]
  const providerTerminalTarget = activeProviderId === 'aws'
    ? null
    : selectedPreviewMode && (activeProviderId !== 'gcp' || gcpContextReady)
      ? {
          providerId: activeProviderId,
          label: activeProviderId === 'gcp' && activeGcpConnectionDraft
            ? `${activeProvider.label} | ${activeGcpConnectionDraft.projectId.trim() || selectedPreviewMode.label}`
            : `${activeProvider.label} | ${selectedPreviewMode.label}`,
          modeId: selectedPreviewMode.id,
          modeLabel: selectedPreviewMode.label,
          env: buildPreviewProviderTerminalEnv(activeProviderId, activeProvider.label, selectedPreviewMode, {
            gcpContext: activeProviderId === 'gcp' ? activeGcpConnectionDraft : null,
            gcpCliPath: activeProviderId === 'gcp' ? detectedGcloudCliPath : '',
            azureCliPath: activeProviderId === 'azure' ? detectedAzureCliPath : ''
          })
        }
      : null
  const providerPermissionDiagnostics = buildProviderPermissionDiagnostics({
    providerId: activeProviderId,
    providerLabel: activeProvider.label,
    accessMode: enterpriseSettings.accessMode,
    awsSelectedContextLabel: connectionState.activeSession?.sourceProfile || connectionState.selectedProfile?.name || connectionState.profile || null,
    selectedPreviewModeLabel: selectedPreviewMode?.label ?? null
  })
  const activityLabel = awsActivity.pendingCount > 0
    ? `Fetching ${awsActivity.pendingCount} ${activeProvider.shortLabel} request${awsActivity.pendingCount === 1 ? '' : 's'}`
    : activeShellConnection
      ? `Ready${awsActivity.lastCompletedAt ? ` | last response ${new Date(awsActivity.lastCompletedAt).toLocaleTimeString()}` : ''}`
      : isAwsProviderActive
        ? 'Idle'
        : activeProviderId === 'gcp' && gcpContextReady
          ? `${activeGcpConnectionDraft?.projectId.trim()} | ${activeGcpConnectionDraft?.location.trim()}`
          : selectedPreviewMode
            ? `${selectedPreviewMode.label} selected`
          : `${activeProvider.shortLabel} preview`

  const selectedService = (services.find((service) => service.id === screen) ?? null) as ServiceDescriptor | null
  const activeAwsScreenMemoryKey = getAwsScreenMemoryKey(
    connectionState.activeSession?.sourceProfile || connectionState.selectedProfile?.name || connectionState.profile
  )
  const activeAwsFocusMap = activeAwsScreenMemoryKey ? awsFocusMapByProfile[activeAwsScreenMemoryKey] ?? {} : {}
  const activeCompareSeed = isAwsProviderActive && activeAwsScreenMemoryKey
    ? compareSeedByProfile[activeAwsScreenMemoryKey] ?? null
    : null
  const activeCacheTag = screenCacheTag(screen)
  const activePageNonce = pageRefreshNonceByScreen[screen] ?? 0
  const isCurrentScreenRefreshing = refreshState?.screen === screen
  const prefersSoftRefresh = SOFT_REFRESH_SCREENS.has(screen)
  const showCatalogFab = screen === 'profiles' && !showEnvironmentOnboarding && isAwsProviderActive
  const terminalToggleEnabled = isAwsProviderActive
    ? enterpriseSettings.accessMode === 'operator' && activeShellConnected
    : providerTerminalTarget !== null
  const connectionScopeKey = activeShellConnection
    ? `${activeProviderId}:${activeShellConnection.sessionId}:${activeShellConnection.region}`
      : activeProviderId === 'gcp' && selectedPreviewMode && activeGcpConnectionDraft
        ? `provider:${activeProviderId}:${selectedPreviewMode.id}:${activeGcpConnectionDraft.projectId.trim()}:${activeGcpConnectionDraft.location.trim()}`
      : selectedPreviewMode
        ? `provider:${activeProviderId}:${selectedPreviewMode.id}`
      : `provider:${activeProviderId}:disconnected`
  const providerRefreshReady = isProviderRefreshReady(
    activeProviderId,
    activeCacheTag,
    activeShellConnection,
    activeShellConnected,
    gcpContextReady,
    selectedPreviewMode,
    selectedService
  )
  const isProviderPageRefreshing = activeProviderId === 'gcp'
    ? gcpCliBusy || gcpProjectCatalogBusy
    : isCurrentScreenRefreshing
  const versionLabel = releaseInfo?.currentVersion ?? ''
  const releaseStateLabel = !releaseInfo?.supportsAutoUpdate
    ? 'Unavailable in dev build'
    : releaseInfo?.updateStatus === 'available'
      ? 'Update available'
      : releaseInfo?.updateStatus === 'downloaded'
        ? 'Ready to install'
        : releaseInfo?.updateStatus === 'downloading'
          ? 'Downloading'
          : releaseInfo?.updateStatus === 'error'
            ? 'Needs attention'
            : 'Up to date'
  const releaseStateTone = !releaseInfo?.supportsAutoUpdate
    ? 'settings-status-pill-unknown'
    : releaseInfo?.updateStatus === 'available' || releaseInfo?.updateStatus === 'downloaded' || releaseInfo?.updateStatus === 'error'
      ? 'settings-status-pill-preview'
      : 'settings-status-pill-stable'
  const environmentIssueCount = useMemo(() => {
    if (!environmentHealth) {
      return 0
    }

    const toolIssues = environmentHealth.tools.filter((tool) => tool.status !== 'available').length
    const permissionIssues = environmentHealth.permissions.filter((item) => item.status !== 'ok').length
    return toolIssues + permissionIssues
  }, [environmentHealth])
  const selectedProfileCount = connectionState.pinnedProfileNames.length
  const onboardingStepIndex = ENVIRONMENT_ONBOARDING_STEPS.indexOf(environmentOnboardingStep)
  const onboardingBackEnabled = onboardingStepIndex > 0
  const onboardingNextLabel = onboardingStepIndex === ENVIRONMENT_ONBOARDING_STEPS.length - 1 ? 'Finish onboarding' : 'Next step'

  useEffect(() => {
    if (activeProviderId !== 'gcp' || !gcpCliContext?.detected) {
      return
    }

    const targetModeId = selectedPreviewModeId || inferGcpModeIdFromContext(gcpCliContext)
    if (!targetModeId) {
      return
    }

    setGcpConnectionDrafts((current) => ({
      ...current,
      [targetModeId]: buildGcpDraftFromContext(gcpCliContext, targetModeId, current[targetModeId] ?? null)
    }))
  }, [activeProviderId, gcpCliContext, selectedPreviewModeId])

  useEffect(() => {
    if (activeProviderId !== 'aws' || !activeAwsScreenMemoryKey || !isRestorableAwsScreen(screen)) {
      return
    }

    setLastAwsScreenByProfile((current) => (
      current[activeAwsScreenMemoryKey] === screen
        ? current
        : { ...current, [activeAwsScreenMemoryKey]: screen }
    ))
  }, [activeAwsScreenMemoryKey, activeProviderId, screen])

  function togglePinnedService(serviceId: ServiceId) {
    setPinnedServiceIds((current) =>
      current.includes(serviceId)
        ? current.filter((id) => id !== serviceId)
        : [...current, serviceId]
    )
  }

  function navigateToService(serviceId: ServiceId, region?: string): void {
    if (isAwsProviderActive && region) {
      connectionState.setRegion(region)
    }
    if (isAwsProviderActive && activeAwsScreenMemoryKey) {
      setAwsFocusMapByProfile((current) => {
        const scoped = current[activeAwsScreenMemoryKey]
        if (!scoped || !Object.prototype.hasOwnProperty.call(scoped, serviceId)) {
          return current
        }

        const nextScoped = { ...scoped }
        delete nextScoped[serviceId as NavigationFocus['service']]
        return { ...current, [activeAwsScreenMemoryKey]: nextScoped }
      })
    } else {
      setFocusMap((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, serviceId)) return current
        const next = { ...current }
        delete next[serviceId as NavigationFocus['service']]
        return next
      })
    }
    setScreen(serviceId)
  }

  function navigateWithFocus(focus: NavigationFocus, region?: string): void {
    if (region) connectionState.setRegion(region)
    const nextFocus = {
      ...focus,
      providerId: focus.providerId ?? activeProviderId,
      locationId: focus.locationId ?? region ?? connectionState.region,
      token: Date.now()
    }

    if ((focus.providerId ?? activeProviderId) === 'aws' && activeAwsScreenMemoryKey) {
      setAwsFocusMapByProfile((current) => ({
        ...current,
        [activeAwsScreenMemoryKey]: {
          ...(current[activeAwsScreenMemoryKey] ?? {}),
          [focus.service]: nextFocus
        }
      }))
    } else {
      setFocusMap(prev => ({
        ...prev,
        [focus.service]: nextFocus
      }))
    }
    setScreen(focus.service)
  }

  function getFocus<S extends NavigationFocus['service']>(service: S): TokenizedFocus<S> | null {
    const f = isAwsProviderActive ? activeAwsFocusMap[service] : focusMap[service]
    if (!f || f.service !== service) return null
    if (f.providerId && f.providerId !== activeProviderId) return null
    return f as TokenizedFocus<S>
  }

  function buildFocusFromResourceId(serviceId: ServiceId, resourceId: string): NavigationFocus | null {
    switch (serviceId) {
      case 'ec2': return { service: 'ec2', instanceId: resourceId }
      case 'lambda': return { service: 'lambda', functionName: resourceId }
      case 'vpc': return { service: 'vpc', vpcId: resourceId }
      case 'security-groups': return { service: 'security-groups', securityGroupId: resourceId }
      case 'load-balancers': return { service: 'load-balancers', loadBalancerArn: resourceId }
      case 'eks': return { service: 'eks', clusterName: resourceId }
      case 'waf': return { service: 'waf', webAclName: resourceId }
      case 'cloudwatch': return { service: 'cloudwatch', ec2InstanceId: resourceId }
      default: return null
    }
  }

  function navigateToServiceWithResourceId(serviceId: ServiceId, resourceId?: string, region?: string): void {
    if (resourceId) {
      const focus = buildFocusFromResourceId(serviceId, resourceId)
      if (focus) {
        navigateWithFocus(focus, region)
        return
      }
    }
    navigateToService(serviceId, region)
  }

  function renderCatalogPlaceholder(service: ServiceDescriptor): React.ReactNode {
    if (service.providerId === 'gcp') {
      const contextLabel = gcpContextReady
        ? activeGcpConnectionDraft?.projectId.trim() || 'Project ready'
        : selectedPreviewMode?.label || 'Project context pending'
      const contextDetail = gcpContextReady
        ? `${activeGcpConnectionDraft?.location.trim()} | shared shell context ready`
        : 'Select a project and location in Connection Selector before opening this service.'

      return (
        <PlaceholderScreen
          service={service}
          eyebrow="Google Cloud Rollout"
          statusLabel="Navbar wired"
          contextLabel={contextLabel}
          contextDetail={contextDetail}
          emptyTitle={`${service.label} is wired into the Google Cloud navbar.`}
          emptyCopy={
            gcpContextReady
              ? 'This entry now follows the selected project, location, and terminal shell context. The first live service console lands in the next branch.'
              : 'Finish the Google Cloud project context in the selector, then return here to keep the shared shell behavior consistent.'
          }
        />
      )
    }

    return <PlaceholderScreen service={service} />
  }

  function handleSelectProvider(providerId: CloudProviderId): void {
    const providerChanged = providerId !== activeProviderId

    setProfileContextMenu(null)
    setProfileSearch('')
    setFabMode('closed')
    setPendingTerminalCommand(null)
    setTerminalOpen(false)

    if (providerChanged) {
      connectionState.clearActiveSession()
      connectionState.setProfile('')
      connectionState.setError('')
      setSelectedPreviewModeIds({})
    }

    setActiveProviderId(providerId)
    setScreen('profiles')
  }

  function handleSelectAwsProfile(profileName: string, nextScreen?: Screen): void {
    connectionState.selectProfile(profileName)
    const restoreScreen = nextScreen ?? lastAwsScreenByProfile[getAwsScreenMemoryKey(profileName)] ?? 'overview'
    setScreen(restoreScreen)
  }

  function handleSelectPreviewMode(modeId: string): void {
    if (!activePreviewProviderId) {
      return
    }

    setPendingTerminalCommand(null)
    setTerminalOpen(false)
    if (activePreviewProviderId === 'gcp') {
      setGcpConnectionDrafts((current) => current[modeId]
        ? current
        : { ...current, [modeId]: createDefaultGcpConnectionDraft(modeId) })
    }
    setSelectedPreviewModeIds((current) => ({ ...current, [activePreviewProviderId]: modeId }))
  }

  function handleApplyGcpProject(projectId: string): void {
    if (activeProviderId !== 'gcp') {
      return
    }

    const targetModeId = selectedPreviewMode?.id || inferGcpModeIdFromContext(gcpCliContext ?? {
      detected: false,
      cliPath: '',
      activeConfigurationName: '',
      activeAccount: '',
      activeProjectId: '',
      activeRegion: '',
      activeZone: '',
      configurations: [],
      projects: [],
      locations: []
    })

    setSelectedPreviewModeIds((current) => ({ ...current, gcp: targetModeId }))
    setGcpConnectionDrafts((current) => ({
      ...current,
      [targetModeId]: {
        ...(current[targetModeId] ?? createDefaultGcpConnectionDraft(targetModeId)),
        projectId
      }
    }))
    setRecentGcpProjectIds((current) => [projectId, ...current.filter((entry) => entry !== projectId)].slice(0, 6))
    setNavOpen(true)
  }

  function handleApplyGcpLocation(location: string): void {
    if (activeProviderId !== 'gcp') {
      return
    }

    const targetModeId = selectedPreviewMode?.id || inferGcpModeIdFromContext(gcpCliContext ?? {
      detected: false,
      cliPath: '',
      activeConfigurationName: '',
      activeAccount: '',
      activeProjectId: '',
      activeRegion: '',
      activeZone: '',
      configurations: [],
      projects: [],
      locations: []
    })

    setSelectedPreviewModeIds((current) => ({ ...current, gcp: targetModeId }))
    setGcpConnectionDrafts((current) => ({
      ...current,
      [targetModeId]: {
        ...(current[targetModeId] ?? createDefaultGcpConnectionDraft(targetModeId)),
        location
      }
    }))
  }

  function renderGcpProjectCard(project: NonNullable<GcpCliContext['projects'][number]>, compact = false) {
    const isSelected = activeGcpConnectionDraft?.projectId.trim() === project.projectId

    return (
      <div key={`${compact ? 'recent-' : ''}${project.projectId}`} className={`profile-catalog-card ${compact ? 'profile-catalog-card-compact' : ''} ${isSelected ? 'active' : ''}`}>
        <div className="profile-catalog-card-header">
          <div className="profile-catalog-card-badge">{getProfileBadge(project.projectId)}</div>
          <div>
            <div className="project-card-title">{project.projectId}</div>
            <div className="project-card-meta">
              <span>{project.name || 'Unnamed project'}</span>
              <span>{gcpCatalogLocation}</span>
            </div>
          </div>
        </div>
        <div className="profile-catalog-status">
          <span>{isSelected ? 'Active context' : gcpCatalogAccount}</span>
          <div className="enterprise-card-status">
            <span className={`enterprise-mode-pill ${project.lifecycleState === 'ACTIVE' ? 'operator' : 'read-only'}`}>
              {project.lifecycleState || 'Detected'}
            </span>
          </div>
        </div>
        <div className="button-row profile-catalog-actions">
          <button type="button" className={isSelected ? 'accent' : ''} onClick={() => handleApplyGcpProject(project.projectId)}>
            {isSelected ? 'Selected' : 'Select'}
          </button>
        </div>
      </div>
    )
  }

  function storeCompareSeed(request: ComparisonRequest): void {
    if (!isAwsProviderActive || !activeAwsScreenMemoryKey) {
      return
    }

    setCompareSeedByProfile((current) => ({
      ...current,
      [activeAwsScreenMemoryKey]: {
        token: Date.now(),
        request
      }
    }))
  }

  function renderServiceLink(service: ServiceDescriptor, options?: { pinned?: boolean }) {
    const isPinned = pinnedServiceIds.includes(service.id)
    return (
      <div key={service.id} className={`service-link-row ${screen === service.id ? 'active' : ''}`}>
        <button
          type="button"
          className={`service-link ${options?.pinned ? 'service-link-pinned' : ''} ${screen === service.id ? 'active' : ''}`}
          disabled={!serviceNavEnabled}
          onClick={() => navigateToService(service.id)}
        >
          <span className="service-link-copy">
            <strong>{service.label}</strong>
            <small>{service.category || 'General'}</small>
          </span>
          {options?.pinned && <span className="service-link-badge">Pinned</span>}
        </button>
        <button
          type="button"
          className={`pin-toggle ${isPinned ? 'active' : ''}`}
          aria-label={isPinned ? `Unpin ${service.label}` : `Pin ${service.label}`}
          title={isPinned ? `Unpin ${service.label}` : `Pin ${service.label}`}
          disabled={!serviceNavEnabled}
          onClick={() => togglePinnedService(service.id)}
        >
          {isPinned ? '*' : '+'}
        </button>
      </div>
    )
  }

  function renderNavPriorityLink(service: ServiceDescriptor) {
      const isActive = screen === service.id
      const detail = service.id === 'overview' && isAwsProviderActive
        ? `${service.label} (${connectionState.region})`
        : service.label
      const sharedContextDetail = activeProviderId === 'gcp'
        ? gcpContextReady
          ? `${activeGcpConnectionDraft?.projectId.trim()} | ${activeGcpConnectionDraft?.location.trim()}`
          : 'Select a project to enable'
        : activeProviderId === 'azure'
          ? selectedPreviewMode
            ? `${selectedPreviewMode.label} | shared shell`
            : 'Select a connection mode'
          : ''

      return (
        <div key={service.id} className="service-link-row service-link-row-utility">
          <button
            type="button"
            className={`service-link overview-link ${isActive ? 'active' : ''}`}
            disabled={!serviceNavEnabled}
            onClick={() => navigateToService(service.id)}
          >
            {isAwsProviderActive ? (
              <span>{detail}</span>
            ) : (
              <span className="service-link-copy">
                <strong>{detail}</strong>
                <small>{sharedContextDetail}</small>
              </span>
            )}
          </button>
          <div className="pin-toggle pin-toggle-placeholder" aria-hidden="true" />
        </div>
      )
    }

  function renderDirectAccessLink() {
      const directAccessDetail = activeProviderId === 'gcp'
        ? gcpContextReady
          ? `${activeGcpConnectionDraft?.projectId.trim()} | lookup staged`
          : 'Select a project to enable'
        : activeProviderId === 'azure'
          ? selectedPreviewMode
            ? `${selectedPreviewMode.label} | lookup staged`
            : 'Select a connection mode'
          : ''

      return (
        <div className="service-link-row service-link-row-utility">
          <button
            type="button"
            className={`service-link overview-link ${screen === 'direct-access' ? 'active' : ''}`}
            disabled={!serviceNavEnabled}
            onClick={() => setScreen('direct-access')}
          >
            {isAwsProviderActive ? (
              <span>Direct Resource Access</span>
            ) : (
              <span className="service-link-copy">
                <strong>Direct Resource Access</strong>
                <small>{directAccessDetail}</small>
              </span>
            )}
          </button>
          <div className="pin-toggle pin-toggle-placeholder" aria-hidden="true" />
        </div>
      )
    }

  function renderPreviewNavItem(item: ProviderPreviewNavItem) {
    return (
      <div key={item.id} className="service-link-row service-link-row-utility">
        <button type="button" className="service-link provider-planned-link" disabled>
          <span className="service-link-copy">
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </span>
          <span className="service-link-badge service-link-badge-preview">{activeProvider.shortLabel}</span>
        </button>
      </div>
    )
  }

  useEffect(() => {
    return () => {
      void closeAwsTerminal()
    }
  }, [])

  useEffect(() => {
    if (!profileContextMenu) {
      return
    }

    function handleCloseMenu() {
      setProfileContextMenu(null)
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setProfileContextMenu(null)
      }
    }

    window.addEventListener('click', handleCloseMenu)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('click', handleCloseMenu)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [profileContextMenu])

  useEffect(() => {
    if (!showCatalogFab && fabMode !== 'closed') {
      setFabMode('closed')
    }
  }, [fabMode, showCatalogFab])

  useEffect(() => {
    if (isAwsProviderActive && enterpriseSettings.accessMode !== 'operator' && terminalOpen) {
      setTerminalOpen(false)
    }
  }, [enterpriseSettings.accessMode, isAwsProviderActive, terminalOpen])

  useEffect(() => {
    if (!terminalToggleEnabled && terminalOpen) {
      setTerminalOpen(false)
    }
  }, [terminalOpen, terminalToggleEnabled])

  useEffect(() => {
    if (!appSettings?.terminal.autoOpen || enterpriseSettings.accessMode !== 'operator') {
      return
    }

    if (!activeShellConnected || !activeShellConnection) {
      return
    }

    if (terminalAutoOpenedScopeRef.current === connectionScopeKey) {
      return
    }

    terminalAutoOpenedScopeRef.current = connectionScopeKey
    setTerminalOpen(true)
  }, [activeShellConnected, activeShellConnection, appSettings?.terminal.autoOpen, connectionScopeKey, enterpriseSettings.accessMode])

  useEffect(() => {
    function handleBlockedAction(event: Event): void {
      const detail = event instanceof CustomEvent && typeof event.detail === 'string'
        ? event.detail
        : 'The workspace blocked the action because the app is in read-only mode.'
      setGlobalWarning(detail)
    }

    window.addEventListener(LEGACY_BLOCKED_ACTION_EVENT, handleBlockedAction)
    return () => window.removeEventListener(LEGACY_BLOCKED_ACTION_EVENT, handleBlockedAction)
  }, [])

  useEffect(() => {
    setVisitedScreens((current) => (current.includes(screen) ? current : [...current, screen]))
  }, [screen])

  useEffect(() => {
    setRefreshState(null)
  }, [connectionScopeKey])

  useEffect(() => {
    invalidateAllPageCaches()
    setConnectionRenderEpoch((current) => current + 1)
  }, [activeProviderId])

  // Redirect to profiles when connection fails (e.g. SSO session expired)
  useEffect(() => {
    if (isAwsProviderActive && connectionState.error && !connectionState.connected && connectionState.connection) {
      setScreen(connectionState.activeSession ? 'session-hub' : 'profiles')
    }
  }, [connectionState.activeSession, connectionState.connected, connectionState.connection, connectionState.error, isAwsProviderActive])

  useEffect(() => {
    setRefreshState((current) => {
      if (!current) {
        return current
      }

      if (awsActivity.pendingCount > 0) {
        return current.sawPending ? current : { ...current, sawPending: true }
      }

      return current.sawPending ? null : current
    })
  }, [awsActivity.pendingCount])

  useEffect(() => {
    const refreshSettings = appSettings?.refresh
    if (!refreshSettings || refreshSettings.autoRefreshIntervalSeconds <= 0) {
      return
    }

    if (!activeShellConnected || !activeShellConnection || !activeCacheTag) {
      return
    }

    if (screen === 'profiles' || screen === 'settings' || screen === 'session-hub' || screen === 'direct-access') {
      return
    }

    if (refreshSettings.heavyScreenMode !== 'automatic' && SOFT_REFRESH_SCREENS.has(screen)) {
      return
    }

    const timerId = window.setInterval(() => {
      const refreshTags = refreshTagsForScreen(screen)
      if (refreshTags.length === 0) {
        return
      }

      setRefreshState({ screen, sawPending: false })
      for (const tag of refreshTags) {
        invalidatePageCache(tag)
      }
      setPageRefreshNonceByScreen((current) => ({
        ...current,
        [screen]: (current[screen] ?? 0) + 1
      }))
    }, refreshSettings.autoRefreshIntervalSeconds * 1000)

    return () => window.clearInterval(timerId)
  }, [
    activeCacheTag,
    activeShellConnected,
    activeShellConnection,
    appSettings?.refresh,
    screen
  ])

  function handlePageRefresh(): void {
    if (!providerRefreshReady) {
      return
    }

    if (activeProviderId === 'gcp') {
      setPageRefreshNonceByScreen((current) => ({
        ...current,
        [screen]: (current[screen] ?? 0) + 1
      }))
      void loadGcpCliContext()
      return
    }

    const refreshTags = refreshTagsForScreen(screen)
    if (refreshTags.length === 0) {
      return
    }

    setRefreshState({ screen, sawPending: false })
    for (const tag of refreshTags) {
      invalidatePageCache(tag)
    }
    setPageRefreshNonceByScreen((current) => ({
      ...current,
      [screen]: (current[screen] ?? 0) + 1
    }))
  }

  function handleOpenTerminalCommand(command: string): void {
    if (!isAwsProviderActive && !providerTerminalTarget) {
      return
    }

    setTerminalOpen(true)
    setPendingTerminalCommand({
      id: Date.now(),
      command
    })
  }

  async function handleLoadAwsConfig(): Promise<void> {
    setFabMode('closed')
    setProfileActionMsg('')
    try {
      const imported = await chooseAndImportConfig()
      if (imported.length > 0) {
        await connectionState.refreshProfiles()
        setProfileActionMsg(`Imported ${imported.length} profile${imported.length === 1 ? '' : 's'} from local config`)
      } else {
        setProfileActionMsg('No new profiles were imported')
      }
    } catch (err) {
      connectionState.setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSaveCredentials(): Promise<void> {
    setCredSaving(true)
    setCredError('')
    setProfileActionMsg('')
    try {
      await saveCredentials(credName, credKeyId, credSecret)
      await connectionState.refreshProfiles()
      await refreshSecuritySummary()
      setCredName('')
      setCredKeyId('')
      setCredSecret('')
      setFabMode('closed')
      setProfileActionMsg(`Profile "${credName}" saved to the encrypted local vault`)
    } catch (err) {
      setCredError(err instanceof Error ? err.message : String(err))
    } finally {
      setCredSaving(false)
    }
  }

  async function handleDeleteProfile(profileName: string): Promise<void> {
    const confirmed = window.confirm(`Delete profile "${profileName}" from local app storage and related config entries?`)
    if (!confirmed) {
      return
    }

    try {
      setProfileActionMsg('')
      const wasSelectedProfile = connectionState.profile === profileName
      await deleteProfile(profileName)

      if (connectionState.pinnedProfileNames.includes(profileName)) {
        connectionState.togglePinnedProfile(profileName)
      }

      if (wasSelectedProfile) {
        connectionState.setProfile('')
        connectionState.clearActiveSession()
      }

      await connectionState.refreshProfiles()
      await refreshSecuritySummary()
      setProfileActionMsg(`Profile "${profileName}" deleted`)

      if (screen !== 'profiles' && wasSelectedProfile) {
        setScreen('profiles')
      }
    } catch (err) {
      connectionState.setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleAccessModeChange(accessMode: EnterpriseAccessMode): Promise<void> {
    setEnterpriseBusy(true)
    setSettingsMessage('')
    try {
      await setEnterpriseAccessMode(accessMode)
      setSettingsMessage(
        accessMode === 'operator'
          ? 'Operator mode enabled. Mutating actions and command execution are available.'
          : 'Read-only mode enabled. The workspace will block mutating and command execution flows.'
      )
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEnterpriseBusy(false)
    }
  }

  async function handleAuditExport(): Promise<void> {
    setEnterpriseBusy(true)
    setSettingsMessage('')
    try {
      const exported = await exportEnterpriseAuditEvents()
      if (!exported.path) {
        return
      }

      const rangeLabel = exported.rangeDays === 1 ? 'last 1 day' : 'last 7 days'
      setSettingsMessage(
        `Exported ${exported.eventCount} audit event${exported.eventCount === 1 ? '' : 's'} from the ${rangeLabel} to ${exported.path}`
      )
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEnterpriseBusy(false)
    }
  }

  async function handleDiagnosticsExport(): Promise<void> {
    setEnterpriseBusy(true)
    setSettingsMessage('')
    try {
      const exported = await exportDiagnosticsBundle()
      if (!exported.path) {
        return
      }

      setSettingsMessage(
        `Exported diagnostics bundle with ${exported.bundleEntries} item${exported.bundleEntries === 1 ? '' : 's'} to ${exported.path}`
      )
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEnterpriseBusy(false)
    }
  }

  async function handleCheckForUpdates(): Promise<void> {
    setSettingsMessage('')
    try {
      const nextInfo = await checkForAppUpdates()
      setReleaseInfo(nextInfo)
      setSettingsMessage(
        nextInfo.updateAvailable
          ? `Update v${nextInfo.latestVersion ?? ''} is available on the ${nextInfo.currentBuild.channel} channel.`
          : `No newer update is currently available for the ${nextInfo.currentBuild.channel} channel.`
      )
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUpdateGeneralSettings(update: AppSettings['general']): Promise<void> {
    setSettingsMessage('')
    try {
      const nextSettings = await updateAppSettings({ general: update })
      setAppSettings(nextSettings)
      setSettingsMessage('Startup defaults saved.')
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUpdateToolchainSettings(update: AppSettings['toolchain']): Promise<void> {
    setToolchainBusy(true)
    setSettingsMessage('')
    try {
      const nextSettings = await updateAppSettings({ toolchain: update })
      setAppSettings(nextSettings)
      const cliInfo = update.preferredTerraformCliKind
        ? await setTerraformCliKind(update.preferredTerraformCliKind)
        : await detectTerraformCli()
      setToolchainInfo(cliInfo)

      setSettingsMessage('Toolchain preferences saved.')
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setToolchainBusy(false)
    }
  }

  async function handleUpdatePreferences(update: AppSettings['updates']): Promise<void> {
    setSettingsMessage('')
    try {
      const nextSettings = await updateAppSettings({ updates: update })
      setAppSettings(nextSettings)
      const nextReleaseInfo = await getAppReleaseInfo()
      setReleaseInfo(nextReleaseInfo)
      setSettingsMessage('Update preferences saved.')
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUpdateTerminalSettings(update: AppSettings['terminal']): Promise<void> {
    setSettingsMessage('')
    try {
      const nextSettings = await updateAppSettings({ terminal: update })
      setAppSettings(nextSettings)
      setSettingsMessage('Terminal preferences saved.')
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUpdateRefreshSettings(update: AppSettings['refresh']): Promise<void> {
    setSettingsMessage('')
    try {
      const nextSettings = await updateAppSettings({ refresh: update })
      setAppSettings(nextSettings)
      setSettingsMessage('Refresh preferences saved.')
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleUpdateGovernanceDefaults(update: GovernanceTagDefaults): Promise<void> {
    setSettingsMessage('')
    try {
      const nextDefaults = await updateGovernanceTagDefaults(update)
      setGovernanceDefaults(nextDefaults)
      setSettingsMessage('Governance tag defaults saved.')
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDownloadUpdate(): Promise<void> {
    setSettingsMessage('')
    try {
      const nextInfo = await downloadAppUpdate()
      setReleaseInfo(nextInfo)
      setSettingsMessage(
        nextInfo.updateStatus === 'downloaded'
          ? `Update v${nextInfo.latestVersion ?? ''} is downloaded and ready to install.`
          : `Downloading update v${nextInfo.latestVersion ?? ''}.`
      )
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleInstallUpdate(): Promise<void> {
    setSettingsMessage('')
    try {
      const nextInfo = await installAppUpdate()
      setReleaseInfo(nextInfo)
      setSettingsMessage('Closing the app to install the downloaded update.')
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRefreshEnvironmentHealth(): Promise<void> {
    setEnvironmentBusy(true)
    setToolchainBusy(true)
    setSettingsMessage('')
    try {
      const [report, cliInfo] = await Promise.all([getEnvironmentHealth(), detectTerraformCli()])
      setEnvironmentHealth(report)
      setToolchainInfo(cliInfo)
      setSettingsMessage(report.summary)
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setEnvironmentBusy(false)
      setToolchainBusy(false)
    }
  }

  function dismissEnvironmentOnboarding(nextScreen?: Screen): void {
    writeEnvironmentOnboardingState({
      dismissed: true,
      lastStep: environmentOnboardingStep
    })
    setShowEnvironmentOnboarding(false)
    if (nextScreen) {
      setScreen(nextScreen)
    }
  }

  function setEnvironmentOnboardingStepSafe(step: EnvironmentOnboardingStep): void {
    if (!ENVIRONMENT_ONBOARDING_STEPS.includes(step)) {
      return
    }

    setEnvironmentOnboardingStep(step)
  }

  function handleEnvironmentOnboardingNext(): void {
    const nextStep = ENVIRONMENT_ONBOARDING_STEPS[onboardingStepIndex + 1]
    if (!nextStep) {
      dismissEnvironmentOnboarding()
      return
    }

    setEnvironmentOnboardingStepSafe(nextStep)
  }

  function handleEnvironmentOnboardingBack(): void {
    const previousStep = ENVIRONMENT_ONBOARDING_STEPS[onboardingStepIndex - 1]
    if (!previousStep) {
      return
    }

    setEnvironmentOnboardingStepSafe(previousStep)
  }

  let onboardingTitle = `Connect a ${providerProfileLabel} before you explore workspace flows.`
  let onboardingDescription = `The shell keeps one active ${providerProfileLabel} and ${providerLocationLabel} context across service workspaces and the embedded terminal.`
  let onboardingSummary = `Detected ${connectionState.profiles.length} local ${providerProfileLabel}${connectionState.profiles.length === 1 ? '' : 's'}. ${connectionState.selectedProfile?.name ? `Current selection: ${connectionState.selectedProfile.name}.` : `No ${providerProfileLabel} is selected yet.`}`
  let onboardingPrimaryActionLabel = 'Open profile catalog'
  let onboardingPrimaryAction: (() => void) | null = () => setScreen('profiles')
  let onboardingSecondaryActionLabel = 'Continue here'
  let onboardingSecondaryAction: (() => void) | null = null
  let onboardingDetailContent: React.ReactNode = null

  if (environmentOnboardingStep === 'region') {
    onboardingTitle = `Confirm the ${providerLocationLabel} and launch defaults for this workspace.`
    onboardingDescription = `${activeProvider.locationLabel} choice is global inside the shell. It affects overview, service consoles, direct access, compare, and assumed sessions.`
    onboardingSummary = `Current ${providerLocationLabel}: ${connectionState.region}. Saved default: ${appSettings?.general.defaultRegion ?? 'us-east-1'}. Launch screen: ${appSettings?.general.launchScreen ?? 'profiles'}.`
    onboardingPrimaryActionLabel = 'Open settings'
    onboardingPrimaryAction = () => dismissEnvironmentOnboarding('settings')
    onboardingSecondaryActionLabel = 'Go to overview'
    onboardingSecondaryAction = activeShellConnected ? () => setScreen('overview') : null
    onboardingDetailContent = (
      <div className="environment-onboarding-grid">
        <section className="environment-onboarding-section environment-onboarding-section-wide">
          <div className="eyebrow">Region Model</div>
          <div className="settings-environment-row">
            <div>
              <strong>Shell-wide region context</strong>
              <p>Switching region in the sidebar updates the context used by overview, deep links, and new service loads.</p>
            </div>
            <div className="settings-environment-meta">
              <code>{connectionState.region}</code>
            </div>
          </div>
          <div className="settings-environment-row">
            <div>
              <strong>Saved startup defaults</strong>
              <p>Settings already support default profile, default region, and launch screen. Use them if you want the shell to boot into a predictable operator context.</p>
            </div>
            <div className="settings-environment-meta">
              <span className="settings-status-pill settings-status-pill-stable">{appSettings?.general.launchScreen ?? 'profiles'}</span>
            </div>
          </div>
        </section>
      </div>
    )
  } else if (environmentOnboardingStep === 'tooling') {
    onboardingTitle = 'Validate local tooling before operator flows start.'
    onboardingDescription = 'The workspace depends on local CLIs and writable paths for shell actions, Terraform, helper flows, and support exports.'
    onboardingSummary = environmentHealth?.summary ?? 'Running environment checks for this machine.'
    onboardingPrimaryActionLabel = environmentBusy ? 'Refreshing...' : 'Run checks again'
    onboardingPrimaryAction = environmentBusy ? null : () => void handleRefreshEnvironmentHealth()
    onboardingSecondaryActionLabel = 'Open settings'
    onboardingSecondaryAction = () => dismissEnvironmentOnboarding('settings')
    onboardingDetailContent = (
      <div className="environment-onboarding-grid">
        <section className="environment-onboarding-section environment-onboarding-section-wide">
          <div className="eyebrow">Tooling</div>
          {environmentHealth?.tools.map((tool) => (
            <div key={tool.id} className="settings-environment-row">
              <div>
                <strong>{tool.label}</strong>
                <p>{tool.detail}</p>
                {tool.remediation && <small>{tool.remediation}</small>}
              </div>
              <div className="settings-environment-meta">
                <span className={`settings-status-pill settings-status-pill-${tool.status === 'available' ? 'stable' : tool.status === 'missing' ? 'preview' : 'unknown'}`}>{tool.status}</span>
                <code>{tool.version || 'not found'}</code>
              </div>
            </div>
          ))}
          {!environmentHealth && (
            <div className="settings-release-notes">
              <p>{environmentBusy ? 'Inspecting installed CLIs and local dependencies.' : 'No tooling report loaded yet.'}</p>
            </div>
          )}
        </section>

        <section className="environment-onboarding-section environment-onboarding-section-wide">
          <div className="eyebrow">Permissions</div>
          {environmentHealth?.permissions.map((item) => (
            <div key={item.id} className="settings-environment-row">
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
                {item.remediation && <small>{item.remediation}</small>}
              </div>
              <div className="settings-environment-meta">
                <span className={`settings-status-pill settings-status-pill-${item.status === 'ok' ? 'stable' : item.status === 'error' ? 'preview' : 'unknown'}`}>{item.status}</span>
              </div>
            </div>
          ))}
          {!environmentHealth && (
            <div className="settings-release-notes">
              <p>{environmentBusy ? 'Checking file-system access for local app state.' : 'No permission report loaded yet.'}</p>
            </div>
          )}
        </section>
      </div>
    )
  } else if (environmentOnboardingStep === 'access') {
    onboardingTitle = 'Choose the right operating mode before you mutate infrastructure.'
    onboardingDescription = 'The workspace enforces read-only vs operator mode at the IPC boundary. The same rule applies to resource mutations, command execution, and Terraform state-changing actions.'
    onboardingSummary = enterpriseSettings.accessMode === 'operator'
      ? 'Operator mode is active. Mutating actions and terminal-backed workflows are enabled.'
      : 'Read-only mode is active. The workspace will block writes and command execution until you switch modes.'
    onboardingPrimaryActionLabel = 'Review security settings'
    onboardingPrimaryAction = () => dismissEnvironmentOnboarding('settings')
    onboardingSecondaryActionLabel = 'Open session hub'
    onboardingSecondaryAction = activeShellConnected ? () => setScreen('session-hub') : null
    onboardingDetailContent = (
      <div className="environment-onboarding-grid">
        <section className="environment-onboarding-section">
          <div className="eyebrow">Current Mode</div>
          <div className="settings-environment-row">
            <div>
              <strong>{enterpriseSettings.accessMode === 'operator' ? 'Operator mode' : 'Read-only mode'}</strong>
              <p>
                {enterpriseSettings.accessMode === 'operator'
                  ? 'Use this when you intend to run terminal commands, Terraform applies, or resource mutations.'
                  : 'Use this when the goal is inspection, diagnostics, compliance review, or safe handoff.'}
              </p>
            </div>
            <div className="settings-environment-meta">
              <span className={`settings-status-pill settings-status-pill-${enterpriseSettings.accessMode === 'operator' ? 'stable' : 'unknown'}`}>{enterpriseSettings.accessMode}</span>
            </div>
          </div>
          <div className="settings-environment-row">
            <div>
              <strong>Audit and recovery surfaces</strong>
              <p>Security settings already expose audit export, diagnostics export, vault summary, and current session state. That should be the first stop before enabling operator privileges on a machine.</p>
            </div>
            <div className="settings-environment-meta">
              <code>{auditSummary.total} events</code>
            </div>
          </div>
        </section>
      </div>
    )
  } else {
    onboardingDetailContent = (
      <div className="environment-onboarding-grid">
        <section className="environment-onboarding-section">
          <div className="eyebrow">Profile Catalog</div>
          <div className="settings-environment-row">
            <div>
              <strong>Import or select a base profile</strong>
              <p>Profiles are loaded from local config files or created inside the app. The selected profile becomes the source context for overview, service consoles, Session Hub, and terminal flows.</p>
            </div>
            <div className="settings-environment-meta">
              <code>{connectionState.profiles.length} discovered</code>
            </div>
          </div>
          <div className="settings-environment-row">
            <div>
              <strong>Pinned profile rail</strong>
              <p>Once you pin frequently used profiles they stay in the left rail, so switching account context does not require reopening the full catalog.</p>
            </div>
            <div className="settings-environment-meta">
              <code>{selectedProfileCount} pinned</code>
            </div>
          </div>
          <div className="settings-environment-row">
            <div>
              <strong>Current selection</strong>
              <p>{connectionState.selectedProfile?.name ? `The shell is currently scoped to ${connectionState.selectedProfile.name}.` : `No ${providerProfileLabel} is selected yet. Open the catalog and choose a base profile before loading service data.`}</p>
            </div>
            <div className="settings-environment-meta">
              <span className={`settings-status-pill settings-status-pill-${connectionState.selectedProfile ? 'stable' : 'unknown'}`}>{connectionState.selectedProfile ? 'selected' : 'pending'}</span>
            </div>
          </div>
        </section>
      </div>
    )
  }

  const showOnboardingPrimaryAction =
    onboardingPrimaryAction !== null &&
    onboardingPrimaryActionLabel !== 'Open profile catalog' &&
    onboardingPrimaryActionLabel !== 'Open settings'

  const showOnboardingSecondaryAction =
    onboardingSecondaryAction !== null &&
    onboardingSecondaryActionLabel !== 'Open settings'

  function renderScreenContent(targetScreen: Screen): React.ReactNode {
    const targetService = services.find((service) => service.id === targetScreen)

    if (targetScreen === 'profiles') {
      return (
        <section className="profile-catalog-shell">
          <div className="profile-catalog-hero">
            <div className="profile-catalog-hero-copy">
              <div className="eyebrow">Connection Selector</div>
              <h2>{isAwsProviderActive ? 'Switch accounts without losing context.' : `Stage ${activeProvider.label} inside the shared multicloud shell.`}</h2>
              <p className="hero-path">
                {isAwsProviderActive
                  ? 'Pinned AWS profiles stay in the rail, region stays global, and every workspace uses the same provider context. Security posture, audit history, and support exports now live in Settings.'
                  : `${activeProvider.label} now has a provider-aware selector surface. The shell can switch providers without leaking AWS state into shared workspaces while deeper onboarding lands in the next branches.`}
              </p>
            </div>
            <div className="profile-catalog-stats" aria-label="Profile catalog summary">
              <div className="profile-catalog-stat">
                <span>Providers</span>
                <strong>{providers.length || 1}</strong>
              </div>
              <div className="profile-catalog-stat">
                <span>{selectorPrimaryStatLabel}</span>
                <strong>{totalProfiles}</strong>
              </div>
              <div className="profile-catalog-stat">
                <span>{selectorSecondaryStatLabel}</span>
                <strong>{totalPinnedProfiles}</strong>
              </div>
              <div className="profile-catalog-stat">
                <span>Services</span>
                <strong>{totalVisibleServices}</strong>
              </div>
            </div>
          </div>
          <div className="panel stack profile-catalog-panel">
            <div className="provider-selector-grid">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`provider-selector-card provider-selector-card-${provider.id} ${provider.id === activeProviderId ? 'active' : ''}`}
                  onClick={() => handleSelectProvider(provider.id)}
                >
                  <div className="provider-selector-card-header">
                    <div>
                      <strong>{provider.label}</strong>
                      <small>{provider.connectionLabel}</small>
                    </div>
                    <span className={`enterprise-mode-pill ${provider.availability === 'available' ? 'operator' : 'read-only'}`}>
                      {provider.availability === 'available' ? 'Live' : 'Preview'}
                    </span>
                  </div>
                  <div className="provider-selector-card-meta">
                    <span className={`provider-selector-chip provider-selector-chip-${provider.id}`}>{provider.shortLabel}</span>
                    <span>{provider.profileLabel}</span>
                    <span>{provider.locationLabel}</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="catalog-page-header profile-catalog-toolbar">
              <div>
                <div className="eyebrow">Workspace Access</div>
                <h3>
                  {isAwsProviderActive
                    ? 'Choose an AWS profile from the catalog'
                    : activeProviderId === 'gcp'
                      ? 'Choose a Google Cloud project from the catalog'
                      : `${activeProvider.label} connection modes`}
                </h3>
                <p className="hero-path">
                  {isAwsProviderActive
                    ? 'Search by profile name, pin frequent targets, or remove credentials managed by the app. Each AWS profile returns to its own last workspace.'
                    : activeProviderId === 'gcp'
                      ? 'Projects are imported from the active gcloud session. Pick one project and the shell reuses that context across the shared workspaces.'
                      : `${activeProvider.label} onboarding is staged here first so the adaptive rail, terminal, and diagnostics can attach to the same provider-aware selector later.`}
                </p>
              </div>
              {isAwsProviderActive ? (
                <label className="profile-search-field">
                  <span>Search AWS profiles</span>
                  <input
                    value={profileSearch}
                    onChange={(event) => setProfileSearch(event.target.value)}
                    placeholder="Search AWS profiles"
                  />
                </label>
              ) : activeProviderId === 'gcp' ? (
                <div className="provider-selector-tools">
                  <label className="profile-search-field">
                    <span>Search GCP projects</span>
                    <input
                      value={gcpProjectSearch}
                      onChange={(event) => setGcpProjectSearch(event.target.value)}
                      placeholder="Search project id or name"
                    />
                  </label>
                  <div className="provider-selector-summary provider-selector-summary-actions">
                    <div className="provider-selector-summary-copy">
                      <span>GCP catalog</span>
                      <strong>{gcpCliContext?.detected ? detectedGcpProjectCount : 0}</strong>
                      <small>
                        {gcpCliError
                          ? gcpCliError
                          : gcpCliBusy && !gcpCliContext?.detected
                          ? 'Loading gcloud catalog from the active CLI session.'
                          : gcpProjectCatalogBusy
                            ? 'Syncing the full Google Cloud project catalog in the background.'
                          : gcpCliContext?.detected
                            ? `${detectedGcpConfigurationCount} configs | ${gcpCatalogAccount}`
                            : gcpCliError || 'Refresh gcloud to import projects from the active CLI session.'}
                      </small>
                    </div>
                    <button type="button" onClick={() => void loadGcpCliContext()} disabled={gcpCliBusy || gcpProjectCatalogBusy}>
                      {gcpCliBusy ? 'Refreshing...' : gcpProjectCatalogBusy ? 'Syncing projects...' : 'Refresh gcloud'}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            {activeProviderId === 'gcp' && !gcpProjectSearch.trim() && recentGcpProjects.length > 0 && (
              <section className="profile-catalog-recent">
                <div className="profile-catalog-recent-header">
                  <div className="eyebrow">Recent Projects</div>
                  <span>{recentGcpProjects.length} recent</span>
                </div>
                <div className="profile-catalog-grid profile-catalog-grid-gcp-recent">
                  {recentGcpProjects.map((project) => renderGcpProjectCard(project, true))}
                </div>
              </section>
            )}
            <div className={`profile-catalog-grid ${activeProviderId === 'gcp' ? 'profile-catalog-grid-gcp' : ''} ${activeProviderId === 'gcp' && filteredGcpProjects.length === 1 ? 'profile-catalog-grid-gcp-single' : ''}`}>
              {isAwsProviderActive ? (
                filteredProfiles.length > 0 ? (
                  filteredProfiles.map((entry) => (
                    <div key={entry.name} className={`profile-catalog-card ${connectionState.profile === entry.name ? 'active' : ''}`}>
                      <div className="profile-catalog-card-header">
                        <div className="profile-catalog-card-badge">{getProfileBadge(entry.name)}</div>
                        <div>
                          <div className="project-card-title">{entry.name}</div>
                          <div className="project-card-meta">
                            <span>{entry.source}</span>
                            <span>{entry.region}</span>
                          </div>
                        </div>
                      </div>
                      <div className="profile-catalog-status">
                        <span>{connectionState.profile === entry.name ? 'Active context' : 'Available'}</span>
                        <div className="enterprise-card-status">
                          <span className={`enterprise-mode-pill ${entry.managedByApp ? 'operator' : 'read-only'}`}>
                            {entry.managedByApp ? 'Vault' : 'External'}
                          </span>
                          {connectionState.pinnedProfileNames.includes(entry.name) && <strong>Pinned</strong>}
                        </div>
                      </div>
                      <div className="button-row profile-catalog-actions">
                        <button type="button" className="accent" onClick={() => { handleSelectAwsProfile(entry.name) }}>
                          {connectionState.profile === entry.name ? 'Selected' : 'Select'}
                        </button>
                        <button type="button" className={connectionState.pinnedProfileNames.includes(entry.name) ? 'active' : ''} onClick={() => connectionState.togglePinnedProfile(entry.name)}>
                          {connectionState.pinnedProfileNames.includes(entry.name) ? 'Unpin' : 'Pin'}
                        </button>
                        {entry.managedByApp && (
                          <button
                            type="button"
                            disabled={enterpriseSettings.accessMode !== 'operator'}
                            onClick={() => void handleDeleteProfile(entry.name)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="profile-catalog-empty">
                    <div className="eyebrow">No Matches</div>
                    <h3>No profiles match "{profileSearch.trim()}"</h3>
                    <p className="hero-path">Try a different search or add a new profile from the floating action button.</p>
                  </div>
                )
              ) : activeProviderId === 'gcp' ? (
                visibleGcpProjects.length > 0 ? (
                  visibleGcpProjects.map((project) => renderGcpProjectCard(project))
                ) : (
                  <div className="profile-catalog-empty">
                    <div className="eyebrow">
                      {gcpCliBusy
                        ? 'Loading gcloud'
                        : gcpCliError
                          ? 'Gcloud error'
                        : gcpProjectCatalogBusy
                          ? 'Syncing catalog'
                        : gcpCliContext?.detected
                          ? gcpProjectSearch.trim()
                            ? 'No Matches'
                            : 'No Projects'
                          : 'Loading gcloud'}
                    </div>
                    <h3>
                      {gcpCliBusy
                        ? 'Loading Google Cloud projects'
                        : gcpCliError
                          ? 'Google Cloud project catalog failed'
                        : gcpProjectCatalogBusy
                          ? 'Syncing Google Cloud projects'
                        : gcpCliContext?.detected
                          ? gcpProjectSearch.trim()
                            ? `No Google Cloud projects match "${gcpProjectSearch.trim()}"`
                            : 'No Google Cloud projects were imported'
                          : 'Loading Google Cloud projects'}
                    </h3>
                    <p className="hero-path">
                      {gcpCliBusy
                        ? 'Importing projects from the active gcloud session.'
                        : gcpCliError
                          ? gcpCliError
                        : gcpProjectCatalogBusy
                          ? 'The current project context is ready. The full Google Cloud project catalog is still syncing.'
                        : gcpCliContext?.detected
                          ? gcpProjectSearch.trim()
                            ? 'Try a different project id or name, or clear the search to see the full imported catalog.'
                            : 'Sign in with gcloud or switch to a configuration that can see projects, then refresh the catalog.'
                          : 'The simple GCP selector fills itself from the active gcloud session. Install or sign in, then refresh gcloud.'}
                    </p>
                  </div>
                )
              ) : (
                activeProviderModes.map((mode) => (
                  <article
                    key={mode.id}
                    className={`profile-catalog-card provider-mode-card provider-mode-card-${activeProviderId} ${selectedPreviewMode?.id === mode.id ? 'active' : ''}`}
                  >
                    <div className="profile-catalog-status">
                      <span>{mode.label}</span>
                      <strong>{mode.status}</strong>
                    </div>
                    <p className="hero-path provider-mode-card-copy">{mode.detail}</p>
                    <div className="button-row profile-catalog-actions">
                      <button
                        type="button"
                        className={selectedPreviewMode?.id === mode.id ? 'accent' : ''}
                        onClick={() => handleSelectPreviewMode(mode.id)}
                      >
                        {selectedPreviewMode?.id === mode.id ? 'Selected' : 'Select'}
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>
      )
    }

    if (
      activeProviderId === 'gcp'
      && targetScreen === 'gcp-compute-engine'
      && targetService?.id === 'gcp-compute-engine'
      && gcpContextReady
      && activeGcpConnectionDraft
    ) {
      return (
        <GcpComputeEngineConsole
          projectId={activeGcpConnectionDraft.projectId.trim()}
          location={activeGcpConnectionDraft.location.trim()}
          refreshNonce={pageRefreshNonceByScreen['gcp-compute-engine'] ?? 0}
          onRunTerminalCommand={handleOpenTerminalCommand}
        />
      )
    }

    if (activeProviderId !== 'aws' && targetScreen !== 'settings') {
      if (isProviderService(targetService ?? null, activeProviderId)) {
        return renderCatalogPlaceholder(targetService!)
      }

      const previewDescription =
        targetScreen === 'direct-access'
          ? 'Direct Resource Access stays in the shared shell, but provider-specific lookup, permission context, and diagnostics are still being wired for this provider.'
          : targetService
            ? SERVICE_DESCRIPTIONS[targetService.id]
            : 'This workspace will attach to the provider-aware shell after the current preview sequence finishes.'

        return (
          <ProviderPreviewScreen
            provider={activeProvider}
            screen={targetScreen}
            description={previewDescription}
            contextLabel={activeProviderId === 'gcp' && gcpContextReady
              ? activeGcpConnectionDraft?.projectId.trim()
              : activeProviderId === 'azure' && selectedPreviewMode
                ? selectedPreviewMode.label
                : undefined}
            contextDetail={activeProviderId === 'gcp' && gcpContextReady
              ? `${activeGcpConnectionDraft?.location.trim()} | ${selectedPreviewMode?.label || 'Google Cloud context'}`
              : activeProviderId === 'azure' && selectedPreviewMode
                ? 'Shared shell context selected'
                : undefined}
          />
        )
      }

    if (targetScreen === 'terraform' && targetService?.id === 'terraform') {
      return (
        <ConnectedServiceScreen service={targetService} state={connectionState}>
          {(connection) => (
            <TerraformConsole
              connection={connection}
              refreshNonce={pageRefreshNonceByScreen['terraform'] ?? 0}
              onRunTerminalCommand={handleOpenTerminalCommand}
              onNavigateService={navigateToServiceWithResourceId}
            />
          )}
        </ConnectedServiceScreen>
      )
    }

    if (targetScreen === 'ec2' && targetService?.id === 'ec2') {
      return (
        <ConnectedServiceScreen service={targetService} state={connectionState}>
          {(connection) => (
            <Ec2Console
              connection={connection}
              refreshNonce={pageRefreshNonceByScreen['ec2'] ?? 0}
              focusInstance={getFocus('ec2')}
              onNavigateCloudWatch={(instanceId) => navigateWithFocus({ service: 'cloudwatch', ec2InstanceId: instanceId })}
              onNavigateVpc={(vpcId) => navigateWithFocus({ service: 'vpc', vpcId })}
              onNavigateSecurityGroup={(sgId) => navigateWithFocus({ service: 'security-groups', securityGroupId: sgId })}
              onRunTerminalCommand={handleOpenTerminalCommand}
            />
          )}
        </ConnectedServiceScreen>
      )
    }

    if (targetScreen === 'settings') {
      return (
        <SettingsPage
          isVisible={screen === 'settings'}
          appSettings={appSettings}
          profiles={connectionState.profiles}
          regions={connectionState.regions}
          toolchainInfo={toolchainInfo}
          securitySummary={securitySummary}
          enterpriseSettings={enterpriseSettings}
          auditSummary={auditSummary}
          auditEvents={auditEvents}
          activeSessionLabel={connectionState.activeSession?.label ?? ''}
          releaseInfo={releaseInfo}
          releaseStateLabel={releaseStateLabel}
          releaseStateTone={releaseStateTone}
          environmentHealth={environmentHealth}
          providerPermissionDiagnostics={providerPermissionDiagnostics}
          environmentBusy={environmentBusy}
          governanceDefaults={governanceDefaults}
          toolchainBusy={toolchainBusy}
          enterpriseBusy={enterpriseBusy}
          settingsMessage={settingsMessage}
          onUpdateGeneralSettings={(update) => void handleUpdateGeneralSettings(update)}
          onUpdateTerminalSettings={(update) => void handleUpdateTerminalSettings(update)}
          onUpdateRefreshSettings={(update) => void handleUpdateRefreshSettings(update)}
          onUpdateGovernanceDefaults={(update) => void handleUpdateGovernanceDefaults(update)}
          onUpdateToolchainSettings={(update) => void handleUpdateToolchainSettings(update)}
          onUpdatePreferences={(update) => void handleUpdatePreferences(update)}
          onAccessModeChange={(mode) => void handleAccessModeChange(mode)}
          onAuditExport={() => void handleAuditExport()}
          onDiagnosticsExport={() => void handleDiagnosticsExport()}
          onClearActiveSession={() => connectionState.clearActiveSession()}
          onCheckForUpdates={() => void handleCheckForUpdates()}
          onDownloadUpdate={() => void handleDownloadUpdate()}
          onInstallUpdate={() => void handleInstallUpdate()}
          onOpenReleasePage={() => void openExternalUrl(releaseInfo?.latestRelease.url || releaseInfo?.releaseUrl || 'https://github.com/BoraKostem/AWS-Lens/releases/')}
          onRefreshEnvironment={() => void handleRefreshEnvironmentHealth()}
        />
      )
    }

    if (targetScreen === 'overview') {
      return <OverviewConsole state={connectionState} embedded refreshNonce={pageRefreshNonceByScreen['overview'] ?? 0} onNavigate={(target) => {
        if (IMPLEMENTED_SCREENS.has(target)) setScreen(target as Screen)
      }} />
    }

    if (targetScreen === 'session-hub') {
      return (
        <SessionHub
          connectionState={connectionState}
          onOpenCompare={(request) => {
            storeCompareSeed(request)
            setScreen('compare')
          }}
          onOpenTerminal={(connection) => {
            setTerminalOpen(true)
            setPendingTerminalCommand(null)
            if (connection.kind === 'assumed-role') {
              connectionState.activateSession(connection.sessionId)
            }
          }}
        />
      )
    }

    if (targetScreen === 'compare') {
      return (
        <CompareWorkspace
          connectionState={connectionState}
          seed={activeCompareSeed}
          refreshNonce={pageRefreshNonceByScreen['compare'] ?? 0}
          onNavigate={navigateToServiceWithResourceId}
        />
      )
    }

    if (targetScreen === 'direct-access') {
      return (
        <section className="panel stack">
          {connectionState.connection && connectionState.connected ? (
            <DirectResourceConsole
              connection={connectionState.connection}
              onNavigate={(focus) => navigateWithFocus(focus)}
              onNavigateService={(serviceId) => navigateToService(serviceId)}
            />
          ) : (
            <section className="empty-hero">
              <div>
                <div className="eyebrow">Access</div>
                <h2>Direct resource access needs an active provider context</h2>
                <SvcState
                  variant="no-selection"
                  resourceName="profile"
                  message="Select a profile from the catalog before you jump directly to a known resource identifier."
                />
              </div>
            </section>
          )}
        </section>
      )
    }

    if (targetScreen === 'compliance-center' && targetService?.id === 'compliance-center') {
      return (
        <ConnectedServiceScreen service={targetService} state={connectionState}>
          {(connection) => (
            <ComplianceCenter
              connection={connection}
              refreshNonce={pageRefreshNonceByScreen['compliance-center'] ?? 0}
              onNavigate={(target, resourceId) => {
                if (IMPLEMENTED_SCREENS.has(target)) navigateToServiceWithResourceId(target, resourceId)
              }}
              onRunTerminalCommand={handleOpenTerminalCommand}
            />
          )}
        </ConnectedServiceScreen>
      )
    }

    if (targetScreen === 'vpc' && targetService?.id === 'vpc') {
      return (
        <ConnectedServiceScreen service={targetService} state={connectionState}>
          {(connection) => (
            <VpcWorkspace
              connection={connection}
              focusVpcId={getFocus('vpc')}
              onNavigate={(target, resourceId) => {
                if (!IMPLEMENTED_SCREENS.has(target as ServiceId)) return
                navigateToServiceWithResourceId(target as ServiceId, resourceId)
              }}
            />
          )}
        </ConnectedServiceScreen>
      )
    }

    if (targetScreen === 'security-groups' && targetService?.id === 'security-groups') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <SecurityGroupsConsole connection={connection} focusSecurityGroupId={getFocus('security-groups')} />}</ConnectedServiceScreen>
    if (targetScreen === 'cloudwatch' && targetService?.id === 'cloudwatch') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <CloudWatchConsole connection={connection} focusEc2Instance={getFocus('cloudwatch')} />}</ConnectedServiceScreen>
    if (targetScreen === 'cloudtrail' && targetService?.id === 'cloudtrail') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <CloudTrailConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'cloudformation' && targetService?.id === 'cloudformation') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <CloudFormationConsole connection={connection} refreshNonce={pageRefreshNonceByScreen['cloudformation'] ?? 0} />}</ConnectedServiceScreen>
    if (targetScreen === 'route53' && targetService?.id === 'route53') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <Route53Console connection={connection} focusRecord={getFocus('route53')} />}</ConnectedServiceScreen>
    if (targetScreen === 's3' && targetService?.id === 's3') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <S3Console connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'rds' && targetService?.id === 'rds') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <RdsConsole connection={connection} onNavigateCloudWatch={(focus) => navigateWithFocus({ service: 'cloudwatch', ...focus })} onRunTerminalCommand={handleOpenTerminalCommand} />}</ConnectedServiceScreen>
    if (targetScreen === 'lambda' && targetService?.id === 'lambda') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <LambdaConsole connection={connection} focusFunctionName={getFocus('lambda')} onNavigateCloudWatch={(focus) => navigateWithFocus({ service: 'cloudwatch', ...focus })} />}</ConnectedServiceScreen>
    if (targetScreen === 'auto-scaling' && targetService?.id === 'auto-scaling') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <AutoScalingConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'ecs' && targetService?.id === 'ecs') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <EcsConsole connection={connection} refreshNonce={pageRefreshNonceByScreen['ecs'] ?? 0} focusService={getFocus('ecs')} onRunTerminalCommand={handleOpenTerminalCommand} onNavigateCloudWatch={(focus) => navigateWithFocus({ service: 'cloudwatch', ...focus })} />}</ConnectedServiceScreen>
    if (targetScreen === 'acm' && targetService?.id === 'acm') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <AcmConsole connection={connection} onOpenRoute53={(record) => navigateWithFocus({ service: 'route53', record })} onOpenLoadBalancer={(loadBalancerArn) => navigateWithFocus({ service: 'load-balancers', loadBalancerArn })} onOpenWaf={(webAclName) => navigateWithFocus({ service: 'waf', webAclName })} />}</ConnectedServiceScreen>
    if (targetScreen === 'ecr' && targetService?.id === 'ecr') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <EcrConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'eks' && targetService?.id === 'eks') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <EksConsole connection={connection} focusClusterName={getFocus('eks')} onRunTerminalCommand={handleOpenTerminalCommand} />}</ConnectedServiceScreen>
    if (targetScreen === 'iam' && targetService?.id === 'iam') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <IamConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'identity-center' && targetService?.id === 'identity-center') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <IdentityCenterConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'secrets-manager' && targetService?.id === 'secrets-manager') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <SecretsManagerConsole connection={connection} onNavigate={(target) => {
      if (target.service === 'lambda') { navigateWithFocus({ service: 'lambda', functionName: target.functionName }); return }
      if (target.service === 'ecs') { navigateWithFocus({ service: 'ecs', clusterArn: target.clusterArn, serviceName: target.serviceName }); return }
      if (target.service === 'eks') { navigateWithFocus({ service: 'eks', clusterName: target.clusterName }) }
    }} />}</ConnectedServiceScreen>
    if (targetScreen === 'key-pairs' && targetService?.id === 'key-pairs') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <KeyPairsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'sts' && targetService?.id === 'sts') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <StsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'kms' && targetService?.id === 'kms') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <KmsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'waf' && targetService?.id === 'waf') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <WafConsole connection={connection} focusWebAcl={getFocus('waf')} />}</ConnectedServiceScreen>
    if (targetScreen === 'load-balancers' && targetService?.id === 'load-balancers') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <WorkspaceApp connection={connection} refreshNonce={pageRefreshNonceByScreen['load-balancers'] ?? 0} focusLoadBalancer={getFocus('load-balancers')} />}</ConnectedServiceScreen>
    if (targetScreen === 'sns' && targetService?.id === 'sns') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <SnsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'sqs' && targetService?.id === 'sqs') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <SqsConsole connection={connection} />}</ConnectedServiceScreen>

    if (targetService && !IMPLEMENTED_SCREENS.has(targetService.id)) {
      return renderCatalogPlaceholder(targetService)
    }

    return null
  }

  return showInitialLoadingScreen ? (
    <InitialLoadingScreen />
  ) : (
    <div className={`catalog-shell-frame ${activeProviderThemeClass}`}>
      <div className={`catalog-shell ${navOpen ? '' : 'nav-collapsed'}`}>
      <aside className="profile-rail">
        <button type="button" className={`rail-logo ${screen === 'settings' ? 'active' : ''}`} onClick={() => setScreen('settings')} aria-label="Open settings">
          <img src={appLogoUrl} alt={PRODUCT_BRAND_NAME} style={{ width: 28, height: 28, borderRadius: 6 }} />
        </button>
        {isAwsProviderActive && (
          <>
            <div className="rail-divider" />
            {connectionState.pinnedProfileNames.map((pinnedName) => (
              <button
                key={pinnedName}
                type="button"
                className={`rail-avatar ${connectionState.profile === pinnedName ? 'active' : ''}`}
                onClick={() => {
                  setProfileContextMenu(null)
                  handleSelectAwsProfile(pinnedName)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setProfileContextMenu({
                    profileName: pinnedName,
                    x: event.clientX,
                    y: event.clientY
                  })
                }}
                title={pinnedName}
              >
                {getProfileBadge(pinnedName)}
              </button>
            ))}
          </>
        )}
        <div className="rail-actions">
          <button type="button" className={screen === 'profiles' ? 'active' : ''} onClick={() => setScreen('profiles')}>ALL</button>
        </div>
      </aside>

      <nav className={`service-nav ${navOpen ? '' : 'collapsed'}`}>
        <div className="service-nav-panel">
          <div className="service-nav-header">
            <button type="button" className="svc-tab-hamburger nav-hamburger" onClick={() => setNavOpen(p => !p)}>
              <span className={`hamburger-icon ${navOpen ? 'open' : ''}`}>
                <span /><span /><span />
              </span>
            </button>
            <div className="service-nav-title">
              <h1>{PRODUCT_BRAND_NAME}</h1>
              <span className={`service-nav-provider-badge service-nav-provider-badge-${activeProviderId}`}>{activeProvider.label}</span>
            </div>
            <div className="app-version-row service-nav-version-row">
                {versionLabel && <span className="app-version-badge">v{versionLabel}</span>}
                {releaseInfo?.updateAvailable && (
                  <button
                    type="button"
                    className="app-update-indicator"
                    aria-label={`Update available. Latest version is ${releaseInfo.latestVersion}. Open releases page.`}
                    title={`Update available: v${releaseInfo.latestVersion}`}
                    onClick={() => void openExternalUrl(releaseInfo.releaseUrl)}
                  >
                    ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Ëœ
                  </button>
                )}
            </div>
          </div>
          <div className="service-nav-controls">
            <div className={`enterprise-sidebar-note provider-sidebar-note provider-sidebar-note-${activeProviderId}`}>
              <span>Provider</span>
              <strong>{activeProvider.label}</strong>
              <small>{providerMetaLabel}</small>
            </div>
            <div className="field">
              <span>{activeProvider.profileLabel}</span>
              <button type="button" className="selector-trigger sidebar-selector" onClick={() => setScreen('profiles')}>
                <strong>{primaryProfileLabel}</strong>
                <span>{profileMetaLabel}</span>
              </button>
            </div>
            {isAwsProviderActive ? (
              <label className="field">
                <span>{activeProvider.locationLabel}</span>
                <select value={connectionState.region} onChange={(event) => connectionState.setRegion(event.target.value)}>
                  {connectionState.regions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : activeProviderId === 'gcp' ? (
              <label className="field">
                <span>{activeProvider.locationLabel}</span>
                <select
                  value={activeGcpConnectionDraft?.location.trim() || ''}
                  onChange={(event) => handleApplyGcpLocation(event.target.value)}
                  disabled={!selectedPreviewMode || gcpLocationOptions.length === 0}
                >
                  {!activeGcpConnectionDraft?.location.trim() ? (
                    <option value="" disabled>
                      {gcpCliBusy ? 'Loading Google Cloud locations...' : 'Select location'}
                    </option>
                  ) : null}
                  {gcpLocationOptions.map((location) => (
                    <option key={location} value={location}>
                      {location}
                    </option>
                  ))}
                </select>
                <small className="field-note">
                  {selectedPreviewMode
                    ? gcpContextReady
                      ? `Project ${activeGcpConnectionDraft?.projectId.trim()} will be injected into the terminal with ${gcpCredentialFieldCopy?.label.toLowerCase()}.`
                      : gcpLocationOptions.length > 0
                        ? 'Choose a Google Cloud location to finish the shared shell context.'
                        : 'Refresh gcloud to import selectable Google Cloud locations.'
                    : 'Select a Google Cloud connection mode to start binding project context.'}
                </small>
              </label>
            ) : (
              <div className={`enterprise-sidebar-note provider-sidebar-note provider-sidebar-note-secondary provider-sidebar-note-${activeProviderId}`}>
                <span>{activeProvider.locationLabel}</span>
                <strong>
                  {selectedPreviewMode
                    ? selectedPreviewMode.label
                    : 'Selector staged'}
                </strong>
                <small>
                  {selectedPreviewMode
                    ? 'Terminal env values will be injected automatically when the shell opens.'
                    : `${activeProvider.label} will bind location and credential context here in the next Phase 4 steps.`}
                </small>
              </div>
            )}
            <div className="enterprise-sidebar-note">
              <span>Mode</span>
              <strong>{enterpriseSettings.accessMode === 'operator' ? 'Operator' : 'Read-only'}</strong>
              <small>
                {enterpriseSettings.accessMode === 'operator'
                  ? 'Writes and terminal access enabled.'
                  : 'Writes and terminal blocked.'}
              </small>
            </div>
            <button
              type="button"
              className="sidebar-refresh-button"
              onClick={handlePageRefresh}
              disabled={!providerRefreshReady || isProviderPageRefreshing}
            >
              {isProviderPageRefreshing
                ? activeProviderId === 'gcp'
                  ? 'Syncing GCP catalog...'
                  : 'Refreshing current view...'
                : selectedService
                  ? `Refresh ${selectedService.label}`
                  : 'Refresh current page'}
            </button>
            {providerRefreshReady && (
              <span className="sidebar-refresh-hint">
                {activeProviderId === 'gcp'
                  ? 'Refresh re-imports the active gcloud context and keeps the selected project in place.'
                  : prefersSoftRefresh
                    ? 'Refresh keeps your current selection and filters.'
                    : 'Refresh may rebuild the current view.'}
              </span>
            )}
          </div>

          <div className={`service-nav-scroll ${!serviceNavEnabled ? 'nav-disabled' : ''}`}>
            <section className="service-group service-group-priority">
              <div className="service-group-title">Workspace</div>
              <div className="service-group-list">
                {navSharedServices.map((service) => renderNavPriorityLink(service))}
                {renderDirectAccessLink()}
              </div>
            </section>
            {pinnedServices.length > 0 && (
              <>
                <section className="service-group">
                  <div className="service-group-title">Pinned</div>
                  <div className="service-group-list">
                    {pinnedServices.map((service) => renderServiceLink(service, { pinned: true }))}
                  </div>
                </section>
                <div className="service-nav-divider" aria-hidden="true" />
              </>
            )}
            {sharedWorkspaceSections.map((section) => (
              <section key={section.id} className="service-group">
                <div className="service-group-title">{section.label}</div>
                <div className="service-group-list">
                  {section.items.map((service) => renderServiceLink(service))}
                </div>
              </section>
            ))}
            {activeProviderId === 'aws'
              ? categorizedProviderSections.map((section) => (
                <section key={section.id} className="service-group">
                  <div className="service-group-title">{section.label}</div>
                  <div className="service-group-list">
                    {section.items.map((service) => renderServiceLink(service))}
                  </div>
                </section>
              ))
              : (
                <>
                  {categorizedProviderSections.map((section) => (
                    <section key={section.id} className="service-group">
                      <div className="service-group-title">{section.label}</div>
                      <div className="service-group-list">
                        {section.items.map((service) => renderServiceLink(service))}
                      </div>
                    </section>
                  ))}
                  {previewProviderSections.map((section) => (
                    <section key={section.id} className="service-group">
                      <div className="service-group-title service-group-title-provider">
                        <span>{section.label}</span>
                        <small>{PROVIDER_AFFORDANCE_LABELS[activeProviderId]}</small>
                      </div>
                      <div className="service-group-list">
                        {section.items.map((item) => renderPreviewNavItem(item))}
                      </div>
                    </section>
                  ))}
                </>
              )}
          </div>
        </div>
      </nav>

      <main className="catalog-main">
        {(globalWarning || catalogError || connectionState.error) && <div className="error-banner">{globalWarning || catalogError || connectionState.error}</div>}
        {screen === 'profiles' && profileActionMsg && <div className="success-banner">{profileActionMsg}</div>}
        {visitedScreens.map((visitedScreen) => {
          const shouldSoftRefresh = SOFT_REFRESH_SCREENS.has(visitedScreen)
          const instanceScopeSuffix = screenInstanceScopeSuffix(visitedScreen, activeAwsScreenMemoryKey, activeProviderId)
          const sectionKey = shouldSoftRefresh
            ? `${connectionRenderEpoch}:${instanceScopeSuffix}:${visitedScreen}`
            : `${connectionRenderEpoch}:${instanceScopeSuffix}:${visitedScreen}:${pageRefreshNonceByScreen[visitedScreen] ?? 0}`

          return (
            <section
              key={sectionKey}
              className={`catalog-main-content ${visitedScreen === screen ? 'active' : 'hidden'} ${refreshState?.screen === visitedScreen ? 'refreshing' : ''}`}
              aria-hidden={visitedScreen === screen ? undefined : true}
            >
              {renderScreenContent(visitedScreen)}
              {refreshState?.screen === visitedScreen && !shouldSoftRefresh && (
                <div className="page-refresh-overlay" role="status" aria-live="polite">
                  <div className="page-refresh-overlay__label">Gathering data</div>
                </div>
              )}
            </section>
          )
        })}
        {false && (
        <div key={`${screen}:${activePageNonce}`} className="catalog-main-content">
        {(catalogError || connectionState.error) && <div className="error-banner">{catalogError || connectionState.error}</div>}

        {screen === 'profiles' && (
          <section className="panel stack">
            <div className="catalog-page-header">
              <div>
                <div className="eyebrow">Profile Catalog</div>
                <h2>Choose a profile from the catalog</h2>
                <p className="hero-path">Pinned profiles stay on the left rail. Selection happens here instead of an inline dropdown.</p>
              </div>
              <input
                value={profileSearch}
                onChange={(event) => setProfileSearch(event.target.value)}
                placeholder="Search profiles"
              />
            </div>
            <div className="profile-catalog-grid">
              {filteredProfiles.map((entry) => (
                <div key={entry.name} className={`profile-catalog-card ${connectionState.profile === entry.name ? 'active' : ''}`}>
                  <div>
                    <div className="project-card-title">{entry.name}</div>
                    <div className="project-card-meta">
                      <span>{entry.source}</span>
                      <span>{entry.region}</span>
                    </div>
                  </div>
                  <div className="button-row">
                    <button type="button" className="accent" onClick={() => { handleSelectAwsProfile(entry.name) }}>
                      {connectionState.profile === entry.name ? 'Selected' : 'Select'}
                    </button>
                    <button type="button" className={connectionState.pinnedProfileNames.includes(entry.name) ? 'active' : ''} onClick={() => connectionState.togglePinnedProfile(entry.name)}>
                      {connectionState.pinnedProfileNames.includes(entry.name) ? 'Unpin' : 'Pin'}
                    </button>
                    {entry.managedByApp && (
                      <button type="button" onClick={() => void handleDeleteProfile(entry.name)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {screen === 'ec2' && selectedService?.id === 'ec2' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => (
              <Ec2Console
                connection={connection}
                focusInstance={getFocus('ec2')}
                onNavigateCloudWatch={(instanceId) => navigateWithFocus({ service: 'cloudwatch', ec2InstanceId: instanceId })}
                onNavigateVpc={(vpcId) => navigateWithFocus({ service: 'vpc', vpcId })}
                onNavigateSecurityGroup={(sgId) => navigateWithFocus({ service: 'security-groups', securityGroupId: sgId })}
                onRunTerminalCommand={handleOpenTerminalCommand}
              />
            )}
          </ConnectedServiceScreen>
        )}

        {screen === 'overview' && (
          <OverviewConsole state={connectionState} embedded onNavigate={(target) => {
            if (IMPLEMENTED_SCREENS.has(target)) setScreen(target as Screen)
          }} />
        )}

        {screen === 'vpc' && selectedService?.id === 'vpc' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => (
              <VpcWorkspace
                connection={connection}
                onNavigate={(target) => {
                  if (IMPLEMENTED_SCREENS.has(target as ServiceId)) setScreen(target as Screen)
                }}
              />
            )}
          </ConnectedServiceScreen>
        )}

        {screen === 'security-groups' && selectedService?.id === 'security-groups' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <SecurityGroupsConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'cloudwatch' && selectedService?.id === 'cloudwatch' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <CloudWatchConsole connection={connection} focusEc2Instance={getFocus('cloudwatch')} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'cloudtrail' && selectedService?.id === 'cloudtrail' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <CloudTrailConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'cloudformation' && selectedService?.id === 'cloudformation' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <CloudFormationConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'route53' && selectedService?.id === 'route53' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <Route53Console connection={connection} focusRecord={getFocus('route53')} />}
          </ConnectedServiceScreen>
        )}

        {screen === 's3' && selectedService?.id === 's3' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <S3Console connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'rds' && selectedService?.id === 'rds' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <RdsConsole connection={connection} onNavigateCloudWatch={(focus) => navigateWithFocus({ service: 'cloudwatch', ...focus })} onRunTerminalCommand={handleOpenTerminalCommand} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'lambda' && selectedService?.id === 'lambda' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <LambdaConsole connection={connection} onNavigateCloudWatch={(focus) => navigateWithFocus({ service: 'cloudwatch', ...focus })} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'auto-scaling' && selectedService?.id === 'auto-scaling' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState} hideHero>
            {(connection) => <AutoScalingConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'ecs' && selectedService?.id === 'ecs' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
                {(connection) => <EcsConsole connection={connection} onRunTerminalCommand={handleOpenTerminalCommand} onNavigateCloudWatch={(focus) => navigateWithFocus({ service: 'cloudwatch', ...focus })} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'acm' && selectedService?.id === 'acm' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <AcmConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'ecr' && selectedService?.id === 'ecr' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <EcrConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'eks' && selectedService?.id === 'eks' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <EksConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'iam' && selectedService?.id === 'iam' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <IamConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'identity-center' && selectedService?.id === 'identity-center' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <IdentityCenterConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'secrets-manager' && selectedService?.id === 'secrets-manager' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <SecretsManagerConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'key-pairs' && selectedService?.id === 'key-pairs' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <KeyPairsConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'sts' && selectedService?.id === 'sts' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <StsConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'kms' && selectedService?.id === 'kms' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <KmsConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'waf' && selectedService?.id === 'waf' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <WafConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'load-balancers' && selectedService?.id === 'load-balancers' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <WorkspaceApp connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'sns' && selectedService?.id === 'sns' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <SnsConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}
        {screen === 'sqs' && selectedService?.id === 'sqs' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <SqsConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {selectedService && !IMPLEMENTED_SCREENS.has(selectedService!.id) && (
          renderCatalogPlaceholder(selectedService!)
        )}
        </div>
        )}
      </main>
      </div>
      {showEnvironmentOnboarding && (
        <section className="environment-onboarding-shell" aria-modal="true" role="dialog" aria-label="First run onboarding">
          <div className="environment-onboarding-backdrop" aria-hidden="true" />
          <div className="environment-onboarding-card">
            <div className="environment-onboarding-content">
              <div className="environment-onboarding-hero">
                <div>
                  <div className="eyebrow">First Run</div>
                  <h2>{onboardingTitle}</h2>
                  <p className="hero-path">{onboardingDescription}</p>
                </div>
                <span className={`settings-status-pill settings-status-pill-${environmentHealth ? (environmentIssueCount > 0 ? 'preview' : 'stable') : 'unknown'}`}>
                  Step {onboardingStepIndex + 1} / {ENVIRONMENT_ONBOARDING_STEPS.length}
                </span>
              </div>

              <div className="environment-onboarding-summary">
                <strong>{onboardingSummary}</strong>
                <span>Environment: {environmentHealth?.overallSeverity ?? (environmentBusy ? 'checking' : 'idle')}</span>
                <span>Checked: {environmentHealth?.checkedAt ? new Date(environmentHealth.checkedAt).toLocaleString() : environmentBusy ? 'Running now' : 'Not checked yet'}</span>
              </div>

              {onboardingDetailContent}

              <div className="environment-onboarding-actions">
                <button type="button" disabled={!onboardingBackEnabled} onClick={handleEnvironmentOnboardingBack}>
                  Back
                </button>
                {showOnboardingPrimaryAction && onboardingPrimaryAction && (
                  <button type="button" className="accent" disabled={environmentBusy && environmentOnboardingStep === 'tooling'} onClick={onboardingPrimaryAction}>
                    {onboardingPrimaryActionLabel}
                  </button>
                )}
                {showOnboardingSecondaryAction && onboardingSecondaryAction && (
                  <button type="button" onClick={onboardingSecondaryAction}>
                    {onboardingSecondaryActionLabel}
                  </button>
                )}
                <button type="button" onClick={handleEnvironmentOnboardingNext}>
                  {onboardingNextLabel}
                </button>
                <button type="button" onClick={() => dismissEnvironmentOnboarding()}>
                  Skip for now
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
      <footer className="app-footer">
        <div className="app-footer-status">
          <strong>{activityLabel}</strong>
          <span>
            {activeShellConnection
              ? activeShellConnection.kind === 'profile'
                ? `${activeProvider.profileLabel}=${activeShellConnection.profile} Ãƒâ€šÃ‚Â· ${activeProvider.locationLabel}=${activeShellConnection.region}`
                : `Session=${activeShellConnection.label} Ãƒâ€šÃ‚Â· ${activeProvider.locationLabel}=${activeShellConnection.region}`
              : isAwsProviderActive
                ? `Select a ${providerProfileLabel} and ${providerLocationLabel} to enable CLI context.`
                : activeProviderId === 'gcp'
                  ? selectedPreviewMode
                    ? gcpContextReady
                      ? `gcloud env values are ready for project ${activeGcpConnectionDraft?.projectId.trim()} in ${activeGcpConnectionDraft?.location.trim()}. Open the terminal to use the selected Google Cloud context.`
                      : `Select a project and ${providerLocationLabel} for ${selectedPreviewMode.label} before opening the terminal.`
                    : `Select a ${activeProvider.label} connection mode before opening the terminal.`
                  : selectedPreviewMode
                    ? `${providerTerminalPreview?.cliLabel} env values are ready for ${selectedPreviewMode.label}. Open the terminal to use the selected ${activeProvider.label} context.`
                    : `Select a ${activeProvider.label} connection mode before opening the terminal.`}
          </span>
        </div>
        {(isAwsProviderActive ? enterpriseSettings.accessMode === 'operator' : providerTerminalTarget !== null) && (
          <button
            type="button"
            className="accent footer-terminal-toggle"
            onClick={() => setTerminalOpen((current) => !current)}
            disabled={!terminalToggleEnabled}
            aria-label={terminalOpen ? 'Hide terminal' : 'Open terminal'}
            title={terminalOpen ? 'Hide terminal' : 'Open terminal'}
          >
            <span className="footer-terminal-icon">{terminalOpen ? '[_]' : '>_'}</span>
          </button>
        )}
      </footer>
      {isAwsProviderActive ? (
        <AwsTerminalPanel
          connection={activeShellConnection}
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          defaultCommand={appSettings?.terminal.defaultCommand}
          fontSize={appSettings?.terminal.fontSize ?? 13}
          commandToRun={pendingTerminalCommand}
          onCommandHandled={(id) => {
            setPendingTerminalCommand((current) => (current?.id === id ? null : current))
          }}
        />
      ) : providerTerminalTarget ? (
        <ProviderTerminalPanel
          target={providerTerminalTarget!}
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          defaultCommand={appSettings?.terminal.defaultCommand}
          fontSize={appSettings?.terminal.fontSize ?? 13}
          commandToRun={pendingTerminalCommand}
          onCommandHandled={(id) => {
            setPendingTerminalCommand((current) => (current?.id === id ? null : current))
          }}
        />
      ) : null}

      {/* FAB ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Add Profile */}
      {showCatalogFab && (
      <div className="fab-container">
        {fabMode === 'menu' && (
          <div className="fab-menu">
            <button
              type="button"
              className="fab-menu-item"
              disabled={enterpriseSettings.accessMode !== 'operator'}
              onClick={() => void handleLoadAwsConfig()}
            >
              Load local config
            </button>
            <button
              type="button"
              className="fab-menu-item"
              disabled={enterpriseSettings.accessMode !== 'operator'}
              onClick={() => { setCredError(''); setFabMode('credentials') }}
            >
              Add with Credentials
            </button>
          </div>
        )}
        <button
          type="button"
          className={`fab-button ${fabMode !== 'closed' ? 'active' : ''}`}
          onClick={() => setFabMode(fabMode === 'closed' ? 'menu' : 'closed')}
          aria-label="Add profile"
          title="Add profile"
          disabled={enterpriseSettings.accessMode !== 'operator'}
        >
          <span className="fab-icon">+</span>
        </button>
      </div>
      )}

      {showCatalogFab && fabMode !== 'closed' && (
        <div className="fab-backdrop" onClick={() => setFabMode('closed')} />
      )}

      {showCatalogFab && fabMode === 'credentials' && (
        <div className="fab-modal-overlay" onClick={() => setFabMode('closed')}>
          <div className="fab-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fab-modal-title">Add Credentials</div>
            <p className="hero-path" style={{ marginTop: 0 }}>
              Credentials added here are stored in the app&apos;s encrypted local vault instead of being written to provider-specific local credential files.
            </p>
            <label className="field">
              <span>Profile Name</span>
              <input value={credName} onChange={(e) => setCredName(e.target.value)} placeholder="e.g. my-project" autoFocus />
            </label>
            <label className="field">
              <span>Access Key ID</span>
              <input value={credKeyId} onChange={(e) => setCredKeyId(e.target.value)} placeholder="AKIA..." />
            </label>
            <label className="field">
              <span>Secret Access Key</span>
              <input type="password" value={credSecret} onChange={(e) => setCredSecret(e.target.value)} placeholder="wJalr..." />
            </label>
            {credError && <div className="fab-modal-error">{credError}</div>}
            <div className="button-row">
              <button type="button" onClick={() => setFabMode('closed')}>Cancel</button>
              <button
                type="button"
                className="accent"
                disabled={enterpriseSettings.accessMode !== 'operator' || credSaving || !credName.trim() || !credKeyId.trim() || !credSecret.trim()}
                onClick={() => void handleSaveCredentials()}
              >
                {credSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {profileContextMenu && (
        <div
          className="profile-context-menu"
          style={{
            left: Math.min(profileContextMenu.x, window.innerWidth - 190),
            top: Math.min(profileContextMenu.y, window.innerHeight - 80)
          }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="profile-context-menu__item danger"
            onClick={() => {
              connectionState.togglePinnedProfile(profileContextMenu.profileName)
              setProfileContextMenu(null)
            }}
          >
            Unpin {profileContextMenu.profileName}
          </button>
        </div>
      )}
    </div>
  )
}
