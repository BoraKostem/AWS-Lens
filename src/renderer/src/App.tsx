import { useEffect, useMemo, useState } from 'react'

import appLogoUrl from '../../../assets/aws-lens-logo.png'
import type {
  AppReleaseInfo,
  ComparisonRequest,
  EnterpriseAccessMode,
  EnterpriseAuditEvent,
  NavigationFocus,
  ServiceDescriptor,
  ServiceId,
  ServiceMaturity,
  TokenizedFocus
} from '@shared/types'
import {
  chooseAndImportConfig,
  closeAwsTerminal,
  deleteProfile,
  exportEnterpriseAuditEvents,
  getAppReleaseInfo,
  getEnterpriseSettings,
  invalidateAllPageCaches,
  invalidatePageCache,
  listEnterpriseAuditEvents,
  listServices,
  openExternalUrl,
  saveCredentials,
  setEnterpriseAccessMode,
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
import { RdsConsole } from './RdsConsole'
import { Route53Console } from './Route53Console'
import { S3Console } from './S3Console'
import { SecretsManagerConsole } from './SecretsManagerConsole'
import { SecurityGroupsConsole } from './SecurityGroupsConsole'
import { SnsConsole } from './SnsConsole'
import { SqsConsole } from './SqsConsole'
import { SessionHub } from './SessionHub'
import { StsConsole } from './StsConsole'
import { TerraformConsole } from './TerraformConsole'
import { VpcWorkspace } from './VpcWorkspace'
import { WafConsole } from './WafConsole'
import { WorkspaceApp } from './WorkspaceApp'

type Screen = 'profiles' | 'direct-access' | ServiceId
type PendingTerminalCommand = { id: number; command: string } | null
type RefreshState = { screen: Screen; sawPending: boolean } | null
type FabMode = 'closed' | 'menu' | 'credentials'
type CompareSeed = { token: number; request: ComparisonRequest } | null
type ProfileContextMenuState = { profileName: string; x: number; y: number } | null
type AuditSummary = {
  total: number
  blocked: number
  failed: number
}
const PINNED_SERVICES_STORAGE_KEY = 'aws-lens:pinned-services'
type FocusMap = Partial<Record<NavigationFocus['service'], TokenizedFocus>>
const NAV_HIDDEN_SERVICE_IDS = new Set<ServiceId>(['overview', 'session-hub', 'compare'])

const SERVICE_CATEGORY_ORDER = [
  'Infrastructure',
  'Compute',
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
  overview: 'Regional summary landing page across AWS services.',
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
  waf: 'Web ACL inventory, rule editing, associations, and scope switching.'
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
            <h2>Select a profile to load {service.label}</h2>
            <p>{SERVICE_DESCRIPTIONS[service.id]}</p>
          </div>
        </section>
      )}
    </>
  )
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

function PlaceholderScreen({ service }: { service: ServiceDescriptor }) {
  return (
    <>
      <section className="hero catalog-hero">
        <div>
          <div className="eyebrow">Catalog</div>
          <h2>{service.label}</h2>
          <p className="hero-path">{SERVICE_DESCRIPTIONS[service.id]}</p>
        </div>
        <div className="hero-connection">
          <div className="connection-summary">
            <span>Status</span>
            <strong>{service.migrated ? 'Cataloged' : 'Planned'}</strong>
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
      </section>
      <section className="empty-hero">
        <div>
          <div className="eyebrow">Catalog</div>
          <h2>{service.label} is listed but not wired into this shell yet</h2>
          <p>{SERVICE_DESCRIPTIONS[service.id]}</p>
        </div>
      </section>
    </>
  )
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
    case 'session-hub':
      return null
    default:
      return null
  }
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
  const [screen, setScreen] = useState<Screen>('profiles')
  const [navOpen, setNavOpen] = useState(true)
  const [visitedScreens, setVisitedScreens] = useState<Screen[]>(['profiles'])
  const [services, setServices] = useState<ServiceDescriptor[]>([])
  const [pinnedServiceIds, setPinnedServiceIds] = useState<ServiceId[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [profileSearch, setProfileSearch] = useState('')
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
  const [globalWarning, setGlobalWarning] = useState('')
  const [focusMap, setFocusMap] = useState<FocusMap>({})
  const [compareSeed, setCompareSeed] = useState<CompareSeed>(null)
  const [profileContextMenu, setProfileContextMenu] = useState<ProfileContextMenuState>(null)
  const [auditEvents, setAuditEvents] = useState<EnterpriseAuditEvent[]>([])
  const [enterpriseBusy, setEnterpriseBusy] = useState(false)
  const connectionState = useAwsPageConnection('us-east-1')
  const awsActivity = useAwsActivity()
  const enterpriseSettings = useEnterpriseSettings()

  useEffect(() => {
    void listServices().then((loadedServices) => {
      setServices(loadedServices)
    }).catch((error) => {
      setCatalogError(error instanceof Error ? error.message : String(error))
    })
  }, [])

  useEffect(() => {
    void getAppReleaseInfo().then(setReleaseInfo).catch(() => {
      // Ignore release check failures in the UI.
    })
  }, [])

  useEffect(() => {
    void getEnterpriseSettings().catch(() => {
      // Keep local default when enterprise settings are unavailable.
    })
    void listEnterpriseAuditEvents().then(setAuditEvents).catch(() => {
      // Ignore audit hydration failures in the catalog shell.
    })
  }, [])

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
    if (services.length === 0) return
    const validServiceIds = new Set(services.map((service) => service.id))
    setPinnedServiceIds((current) => current.filter((serviceId) => validServiceIds.has(serviceId) && !NAV_HIDDEN_SERVICE_IDS.has(serviceId)))
  }, [services])

  const pinnedServices = useMemo(() => {
    const serviceById = new Map(services.map((service) => [service.id, service]))
    return pinnedServiceIds
      .map((serviceId) => serviceById.get(serviceId) ?? null)
      .filter((service): service is ServiceDescriptor => service !== null && !NAV_HIDDEN_SERVICE_IDS.has(service.id))
  }, [pinnedServiceIds, services])

  const totalProfiles = connectionState.profiles.length
  const totalPinnedProfiles = connectionState.pinnedProfileNames.length
  const totalVisibleServices = services.filter((service) => !NAV_HIDDEN_SERVICE_IDS.has(service.id)).length
  const auditSummary = useMemo<AuditSummary>(() => ({
    total: auditEvents.length,
    blocked: auditEvents.filter((event) => event.outcome === 'blocked').length,
    failed: auditEvents.filter((event) => event.outcome === 'failed').length
  }), [auditEvents])
  const groupedServices = useMemo(() => {
    const grouped = new Map<string, ServiceDescriptor[]>()
    const pinnedIds = new Set(pinnedServiceIds)
    for (const service of services) {
      const category = service.category || 'General'
      const list = grouped.get(category) ?? []
      list.push(service)
      grouped.set(category, list)
    }
    const order = new Map<string, number>(SERVICE_CATEGORY_ORDER.map((category, index) => [category, index]))

    return [...grouped.entries()]
      .map(([category, items]) => [
        category,
        items
          .filter((service) => !NAV_HIDDEN_SERVICE_IDS.has(service.id) && !pinnedIds.has(service.id))
          .sort((a, b) => a.label.localeCompare(b.label))
      ] as const)
      .sort(([left], [right]) => {
        const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER
        const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER
        return leftIndex - rightIndex || left.localeCompare(right)
      })
  }, [pinnedServiceIds, services])

  const filteredProfiles = useMemo(() => {
    const query = profileSearch.trim().toLowerCase()
    if (!query) return connectionState.profiles
    return connectionState.profiles.filter((entry) => entry.name.toLowerCase().includes(query))
  }, [connectionState.profiles, profileSearch])

  const sidebarProfileLabel = connectionState.selectedProfile?.name || connectionState.profile || ''
  const profileBadge = getProfileBadge(sidebarProfileLabel)
  const primaryProfileLabel = connectionState.activeSession?.sourceProfile || connectionState.selectedProfile?.name || connectionState.profile || 'No profile selected'
  const assumedRoleLabel = connectionState.activeSession
    ? `Assumed role: ${getRoleDisplayName(connectionState.activeSession.roleArn) || connectionState.activeSession.label}`
    : ''
  const profileMetaLabel = connectionState.activeSession
    ? assumedRoleLabel
    : connectionState.selectedProfile
      ? `${connectionState.selectedProfile.source} profile`
      : 'Click to select a profile'
  const overviewService = services.find((service) => service.id === 'overview')
  const sessionHubService = services.find((service) => service.id === 'session-hub')
  const activityLabel = awsActivity.pendingCount > 0
    ? `Fetching ${awsActivity.pendingCount} AWS request${awsActivity.pendingCount === 1 ? '' : 's'}`
    : connectionState.connection
      ? `Ready${awsActivity.lastCompletedAt ? ` · last response ${new Date(awsActivity.lastCompletedAt).toLocaleTimeString()}` : ''}`
      : 'Idle'

  const selectedService = (services.find((service) => service.id === screen) ?? null) as ServiceDescriptor | null
  const activeCacheTag = screenCacheTag(screen)
  const activePageNonce = pageRefreshNonceByScreen[screen] ?? 0
  const isCurrentScreenRefreshing = refreshState?.screen === screen
  const prefersSoftRefresh = SOFT_REFRESH_SCREENS.has(screen)
  const showCatalogFab = screen === 'profiles'
  const connectionScopeKey = connectionState.connection
    ? `${connectionState.connection.sessionId}:${connectionState.connection.region}`
    : 'disconnected'
  const versionLabel = releaseInfo?.currentVersion ?? ''

  function togglePinnedService(serviceId: ServiceId) {
    setPinnedServiceIds((current) =>
      current.includes(serviceId)
        ? current.filter((id) => id !== serviceId)
        : [...current, serviceId]
    )
  }

  function navigateToService(serviceId: ServiceId, region?: string): void {
    if (region) {
      connectionState.setRegion(region)
    }
    setFocusMap((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, serviceId)) return current
      const next = { ...current }
      delete next[serviceId as NavigationFocus['service']]
      return next
    })
    setScreen(serviceId)
  }

  function navigateWithFocus(focus: NavigationFocus, region?: string): void {
    if (region) connectionState.setRegion(region)
    setFocusMap(prev => ({ ...prev, [focus.service]: { ...focus, token: Date.now() } }))
    setScreen(focus.service)
  }

  function getFocus<S extends NavigationFocus['service']>(service: S): TokenizedFocus<S> | null {
    const f = focusMap[service]
    if (!f || f.service !== service) return null
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

  function renderServiceLink(service: ServiceDescriptor, options?: { pinned?: boolean }) {
    const isPinned = pinnedServiceIds.includes(service.id)
    return (
      <div key={service.id} className={`service-link-row ${screen === service.id ? 'active' : ''}`}>
        <button
          type="button"
          className={`service-link ${options?.pinned ? 'service-link-pinned' : ''} ${screen === service.id ? 'active' : ''}`}
          disabled={!connectionState.connected}
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
          disabled={!connectionState.connected}
          onClick={() => togglePinnedService(service.id)}
        >
          {isPinned ? '★' : '☆'}
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
    if (enterpriseSettings.accessMode !== 'operator' && terminalOpen) {
      setTerminalOpen(false)
    }
  }, [enterpriseSettings.accessMode, terminalOpen])

  useEffect(() => {
    function handleBlockedAction(event: Event): void {
      const detail = event instanceof CustomEvent && typeof event.detail === 'string'
        ? event.detail
        : 'AWS Lens blocked the action because the app is in read-only mode.'
      setGlobalWarning(detail)
    }

    window.addEventListener('aws-lens:blocked-action', handleBlockedAction)
    return () => window.removeEventListener('aws-lens:blocked-action', handleBlockedAction)
  }, [])

  useEffect(() => {
    setVisitedScreens((current) => (current.includes(screen) ? current : [...current, screen]))
  }, [screen])

  useEffect(() => {
    invalidateAllPageCaches()
    setRefreshState(null)
    setConnectionRenderEpoch((current) => current + 1)
  }, [connectionScopeKey])

  // Redirect to profiles when connection fails (e.g. SSO session expired)
  useEffect(() => {
    if (connectionState.error && !connectionState.connected && connectionState.connection) {
      setScreen(connectionState.activeSession ? 'session-hub' : 'profiles')
    }
  }, [connectionState.activeSession, connectionState.connected, connectionState.connection, connectionState.error])

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

  function handlePageRefresh(): void {
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
        setProfileActionMsg(`Imported ${imported.length} profile${imported.length === 1 ? '' : 's'} from AWS config`)
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
    const confirmed = window.confirm(`Delete AWS profile "${profileName}" from AWS Lens local storage and related AWS config entries?`)
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
    setProfileActionMsg('')
    try {
      await setEnterpriseAccessMode(accessMode)
      setProfileActionMsg(
        accessMode === 'operator'
          ? 'Operator mode enabled. Mutating actions and command execution are available.'
          : 'Read-only mode enabled. AWS Lens will block mutating and command execution flows.'
      )
    } catch (err) {
      connectionState.setError(err instanceof Error ? err.message : String(err))
    } finally {
      setEnterpriseBusy(false)
    }
  }

  async function handleAuditExport(): Promise<void> {
    setEnterpriseBusy(true)
    setProfileActionMsg('')
    try {
      const exported = await exportEnterpriseAuditEvents()
      if (!exported.path) {
        return
      }

      const rangeLabel = exported.rangeDays === 1 ? 'last 1 day' : 'last 7 days'
      setProfileActionMsg(
        `Exported ${exported.eventCount} audit event${exported.eventCount === 1 ? '' : 's'} from the ${rangeLabel} to ${exported.path}`
      )
    } catch (err) {
      connectionState.setError(err instanceof Error ? err.message : String(err))
    } finally {
      setEnterpriseBusy(false)
    }
  }

  function renderScreenContent(targetScreen: Screen): React.ReactNode {
    const targetService = services.find((service) => service.id === targetScreen)

    if (targetScreen === 'profiles') {
      return (
        <section className="profile-catalog-shell">
          <div className="profile-catalog-hero">
            <div className="profile-catalog-hero-copy">
              <div className="eyebrow">Profile Catalog</div>
              <h2>Switch accounts without losing context.</h2>
              <p className="hero-path">
                Pinned profiles stay in the rail, region stays global, and every workspace uses the same active AWS context.
                Enterprise mode, audit history, service maturity, and support guidance are managed here.
              </p>
            </div>
            <div className="profile-catalog-stats" aria-label="Profile catalog summary">
              <div className="profile-catalog-stat">
                <span>Profiles</span>
                <strong>{totalProfiles}</strong>
              </div>
              <div className="profile-catalog-stat">
                <span>Pinned</span>
                <strong>{totalPinnedProfiles}</strong>
              </div>
              <div className="profile-catalog-stat">
                <span>Services</span>
                <strong>{totalVisibleServices}</strong>
              </div>
            </div>
          </div>
          <div className="panel stack profile-catalog-panel">
            <div className="catalog-page-header profile-catalog-toolbar">
              <div>
                <div className="eyebrow">Workspace Access</div>
                <h3>Choose a profile from the catalog</h3>
                <p className="hero-path">Search by profile name, pin frequent targets, or remove credentials managed by the app.</p>
              </div>
              <label className="profile-search-field">
                <span>Search profiles</span>
                <input
                  value={profileSearch}
                  onChange={(event) => setProfileSearch(event.target.value)}
                  placeholder="Search profiles"
                />
              </label>
            </div>
          <div className="profile-catalog-grid">
            {filteredProfiles.length > 0 ? (
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
                    <button type="button" className="accent" onClick={() => { connectionState.selectProfile(entry.name) }}>
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
            )}
          </div>
          </div>
          <div className="enterprise-panel-grid enterprise-panel-grid-bottom">
            <section className="panel stack enterprise-panel">
              <div className="panel-header">
                <div>
                  <div className="eyebrow">Access Mode</div>
                  <h3>Separate read-only and operator access</h3>
                </div>
                <span className={`enterprise-mode-pill ${enterpriseSettings.accessMode}`}>
                  {enterpriseSettings.accessMode === 'operator' ? 'Operator' : 'Read-only'}
                </span>
              </div>
              <p className="hero-path">
                Read-only mode blocks AWS mutations and command execution flows. Operator mode enables critical actions and audit export.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className={enterpriseSettings.accessMode === 'read-only' ? 'accent' : ''}
                  disabled={enterpriseBusy}
                  onClick={() => void handleAccessModeChange('read-only')}
                >
                  Read-only
                </button>
                <button
                  type="button"
                  className={enterpriseSettings.accessMode === 'operator' ? 'accent' : ''}
                  disabled={enterpriseBusy}
                  onClick={() => void handleAccessModeChange('operator')}
                >
                  Operator
                </button>
              </div>
              <div className="enterprise-inline-note">
                <strong>Updated</strong>
                <span>{enterpriseSettings.updatedAt ? new Date(enterpriseSettings.updatedAt).toLocaleString() : 'Not yet changed'}</span>
              </div>
            </section>
            <section className="panel stack enterprise-panel">
              <div className="panel-header">
                <div>
                  <div className="eyebrow">Audit Trail</div>
                  <h3>Critical action history</h3>
                </div>
              </div>
              <div className="enterprise-stats-row">
                <div className="profile-catalog-stat">
                  <span>Total</span>
                  <strong>{auditSummary.total}</strong>
                </div>
                <div className="profile-catalog-stat">
                  <span>Blocked</span>
                  <strong>{auditSummary.blocked}</strong>
                </div>
                <div className="profile-catalog-stat">
                  <span>Failed</span>
                  <strong>{auditSummary.failed}</strong>
                </div>
              </div>
              <div className="enterprise-audit-list">
                {auditEvents.map((event) => (
                  <div key={event.id} className={`enterprise-audit-item ${event.outcome}`}>
                    <div className="enterprise-audit-item__header">
                      <div className="enterprise-audit-item__title">
                        <strong>{event.action}</strong>
                        {event.outcome === 'blocked' && <span className="enterprise-audit-badge blocked">Blocked</span>}
                        {event.outcome === 'failed' && <span className="enterprise-audit-badge failed">Failed</span>}
                      </div>
                      <span>{new Date(event.happenedAt).toLocaleString()}</span>
                    </div>
                    {event.outcome === 'blocked' && (
                      <div className="enterprise-audit-item__reason">
                        Blocked in read-only mode
                        {event.resourceId ? ` for ${event.resourceId}` : ''}
                      </div>
                    )}
                    <div className="enterprise-audit-item__meta">
                      <span>{event.actorLabel || 'local-app'}</span>
                      <span>{event.region || 'no-region'}</span>
                      <span>{event.resourceId || event.channel}</span>
                    </div>
                    {event.summary && event.summary !== event.action && (
                      <div className="enterprise-audit-item__summary">{event.summary}</div>
                    )}
                  </div>
                ))}
                {auditEvents.length === 0 && (
                  <div className="profile-catalog-empty">
                    <div className="eyebrow">Audit Trail</div>
                    <h3>No audit events yet</h3>
                    <p className="hero-path">Critical actions run in operator mode, or blocked in read-only mode, will appear here.</p>
                  </div>
                )}
              </div>
              <div className="button-row">
                <button type="button" disabled={enterpriseBusy || auditEvents.length === 0} onClick={() => void handleAuditExport()}>
                  Export Audit JSON
                </button>
              </div>
            </section>
          </div>
        </section>
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
            setCompareSeed({ token: Date.now(), request })
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
          seed={compareSeed}
          refreshNonce={pageRefreshNonceByScreen['compare'] ?? 0}
          onNavigate={navigateToServiceWithResourceId}
        />
      )
    }

    if (targetScreen === 'direct-access') {
      return (
        <section className="panel stack">
          {connectionState.connection && connectionState.connected ? (
            <DirectResourceConsole connection={connectionState.connection} />
          ) : (
            <section className="empty-hero">
              <div>
                <div className="eyebrow">Access</div>
                <h2>Select a profile to use direct resource access</h2>
                <p>Known resource identifiers still require an active AWS connection.</p>
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
    if (targetScreen === 'rds' && targetService?.id === 'rds') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <RdsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'lambda' && targetService?.id === 'lambda') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <LambdaConsole connection={connection} focusFunctionName={getFocus('lambda')} />}</ConnectedServiceScreen>
    if (targetScreen === 'auto-scaling' && targetService?.id === 'auto-scaling') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <AutoScalingConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'ecs' && targetService?.id === 'ecs') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <EcsConsole connection={connection} refreshNonce={pageRefreshNonceByScreen['ecs'] ?? 0} focusService={getFocus('ecs')} onRunTerminalCommand={handleOpenTerminalCommand} />}</ConnectedServiceScreen>
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
      return <PlaceholderScreen service={targetService} />
    }

    return null
  }

  return (
    <div className="catalog-shell-frame">
      <div className={`catalog-shell ${navOpen ? '' : 'nav-collapsed'}`}>
      <aside className="profile-rail">
        <button type="button" className="rail-logo" onClick={() => setScreen('profiles')} aria-label="AWS Lens home">
          <img src={appLogoUrl} alt="AWS Lens" style={{ width: 28, height: 28, borderRadius: 6 }} />
        </button>
        <div className="rail-divider" />
        {connectionState.pinnedProfileNames.map((pinnedName) => (
          <button
            key={pinnedName}
            type="button"
            className={`rail-avatar ${connectionState.profile === pinnedName ? 'active' : ''}`}
            onClick={() => {
              setProfileContextMenu(null)
              connectionState.selectProfile(pinnedName)
              setScreen('overview')
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
              <h1>AWS Lens</h1>
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
                    ↑
                  </button>
                )}
            </div>
          </div>
          <div className="service-nav-controls">
            <div className="field">
              <span>Profile</span>
              <button type="button" className="selector-trigger sidebar-selector" onClick={() => setScreen('profiles')}>
                <strong>{primaryProfileLabel}</strong>
                <span>{profileMetaLabel}</span>
              </button>
            </div>
            <label className="field">
              <span>Region</span>
              <select value={connectionState.region} onChange={(event) => connectionState.setRegion(event.target.value)}>
                {connectionState.regions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                  </option>
                ))}
              </select>
            </label>
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
              disabled={!activeCacheTag || !connectionState.connection || !connectionState.connected || isCurrentScreenRefreshing}
            >
              {isCurrentScreenRefreshing
                ? 'Refreshing current view...'
                : selectedService
                  ? `Refresh ${selectedService.label}`
                  : 'Refresh current page'}
            </button>
            {connectionState.connected && activeCacheTag && (
              <span className="sidebar-refresh-hint">
                {prefersSoftRefresh ? 'Refresh keeps your current selection and filters.' : 'Refresh may rebuild the current view.'}
              </span>
            )}
          </div>

          <div className={`service-nav-scroll ${!connectionState.connected ? 'nav-disabled' : ''}`}>
            <section className="service-group service-group-priority">
              <div className="service-group-title">Workspace</div>
              <div className="service-group-list">
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
            {overviewService && (
              <div className="service-link-row service-link-row-utility">
                <button
                  type="button"
                  className={`service-link overview-link ${screen === 'overview' ? 'active' : ''}`}
                  disabled={!connectionState.connected}
                  onClick={() => navigateToService('overview')}
                >
                  <span>{overviewService.label} ({connectionState.region})</span>
                </button>
                <div className="pin-toggle pin-toggle-placeholder" aria-hidden="true" />
              </div>
            )}
            <div className="service-link-row service-link-row-utility">
              <button
                type="button"
                className={`service-link overview-link ${screen === 'direct-access' ? 'active' : ''}`}
                disabled={!connectionState.connected}
                onClick={() => setScreen('direct-access')}
              >
                <span>Direct Resource Access</span>
              </button>
              <div className="pin-toggle pin-toggle-placeholder" aria-hidden="true" />
            </div>
            {sessionHubService && (
              <div className="service-link-row service-link-row-utility">
                <button
                  type="button"
                  className={`service-link overview-link ${screen === 'session-hub' ? 'active' : ''}`}
                  disabled={!connectionState.connected}
                  onClick={() => navigateToService('session-hub')}
                >
                  <span>{sessionHubService.label}</span>
                </button>
                <div className="pin-toggle pin-toggle-placeholder" aria-hidden="true" />
              </div>
            )}
              </div>
            </section>
            {groupedServices.map(([category, items]) => (
              items.length > 0 && (
                <section key={category} className="service-group">
                  <div className="service-group-title">{category}</div>
                  <div className="service-group-list">
                    {items.map((service) => renderServiceLink(service))}
                  </div>
                </section>
              )
            ))}
          </div>
        </div>
      </nav>

      <main className="catalog-main">
        {(globalWarning || catalogError || connectionState.error) && <div className="error-banner">{globalWarning || catalogError || connectionState.error}</div>}
        {screen === 'profiles' && profileActionMsg && <div className="success-banner">{profileActionMsg}</div>}
        {visitedScreens.map((visitedScreen) => {
          const shouldSoftRefresh = SOFT_REFRESH_SCREENS.has(visitedScreen)
          const sectionKey = shouldSoftRefresh
            ? `${connectionRenderEpoch}:${visitedScreen}`
            : `${connectionRenderEpoch}:${visitedScreen}:${pageRefreshNonceByScreen[visitedScreen] ?? 0}`

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
                    <button type="button" className="accent" onClick={() => { connectionState.selectProfile(entry.name) }}>
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
            {(connection) => <Route53Console connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 's3' && selectedService?.id === 's3' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <S3Console connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'rds' && selectedService?.id === 'rds' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <RdsConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'lambda' && selectedService?.id === 'lambda' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <LambdaConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'auto-scaling' && selectedService?.id === 'auto-scaling' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState} hideHero>
            {(connection) => <AutoScalingConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'ecs' && selectedService?.id === 'ecs' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
                {(connection) => <EcsConsole connection={connection} onRunTerminalCommand={handleOpenTerminalCommand} />}
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
          <PlaceholderScreen service={selectedService!} />
        )}
        </div>
        )}
      </main>
      </div>
      <footer className="app-footer">
        <div className="app-footer-status">
          <strong>{activityLabel}</strong>
          <span>
            {connectionState.connection
              ? connectionState.connection.kind === 'profile'
                ? `AWS_PROFILE=${connectionState.connection.profile} · AWS_REGION=${connectionState.connection.region}`
                : `SESSION=${connectionState.connection.label} · AWS_REGION=${connectionState.connection.region}`
              : 'Select an AWS profile and region to enable CLI context.'}
          </span>
        </div>
        {enterpriseSettings.accessMode === 'operator' && (
          <button
            type="button"
            className="accent footer-terminal-toggle"
            onClick={() => setTerminalOpen((current) => !current)}
            disabled={!connectionState.connected}
            aria-label={terminalOpen ? 'Hide terminal' : 'Open terminal'}
            title={terminalOpen ? 'Hide terminal' : 'Open terminal'}
          >
            <span className="footer-terminal-icon">{terminalOpen ? '[_]' : '>_'}</span>
          </button>
        )}
      </footer>
      <AwsTerminalPanel
        connection={connectionState.connection}
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        commandToRun={pendingTerminalCommand}
        onCommandHandled={(id) => {
          setPendingTerminalCommand((current) => (current?.id === id ? null : current))
        }}
      />

      {/* FAB — Add Profile */}
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
              Load AWS Config
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
            <div className="fab-modal-title">Add AWS Credentials</div>
            <p className="hero-path" style={{ marginTop: 0 }}>
              Credentials added here are stored in the app&apos;s encrypted local vault instead of being written to <code>~/.aws/credentials</code>.
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
