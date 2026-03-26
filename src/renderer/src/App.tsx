import { useEffect, useMemo, useState } from 'react'

import appLogoUrl from '../../../assets/aws-lens-logo.png'
import type { ServiceDescriptor, ServiceId } from '@shared/types'
import { chooseAndImportConfig, closeAwsTerminal, deleteProfile, invalidatePageCache, listServices, saveCredentials, useAwsActivity, type CacheTag } from './api'
import { AcmConsole } from './AcmConsole'
import { AutoScalingConsole } from './AutoScalingConsole'
import { AwsTerminalPanel } from './AwsTerminalPanel'
import { CloudFormationConsole } from './CloudFormationConsole'
import { ComplianceCenter } from './ComplianceCenter'
import { CloudTrailConsole } from './CloudTrailConsole'
import { CloudWatchConsole } from './CloudWatchConsole'
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

type Screen = 'profiles' | ServiceId
type PendingTerminalCommand = { id: number; command: string } | null
type RefreshState = { screen: Screen; sawPending: boolean } | null
type FabMode = 'closed' | 'menu' | 'credentials'

const SERVICE_DESCRIPTIONS: Record<ServiceId, string> = {
  terraform: 'Terraform project browser and command execution workspace.',
  overview: 'Regional summary landing page across AWS services.',
  'session-hub': 'Saved assume-role targets, active temporary sessions, activation, expiration, and cross-account comparison.',
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

const IMPLEMENTED_SCREENS = new Set<ServiceId>([
  'terraform',
  'overview',
  'session-hub',
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

function ConnectedServiceScreen({
  service,
  state,
  children
}: {
  service: ServiceDescriptor
  state: ReturnType<typeof useAwsPageConnection>
  children: (connection: NonNullable<ReturnType<typeof useAwsPageConnection>['connection']>) => React.ReactNode
}) {
  return (
    <>
      <section className="hero catalog-hero">
        <div>
          <div className="eyebrow">Service</div>
          <h2>{service.label}</h2>
          <p className="hero-path">{SERVICE_DESCRIPTIONS[service.id]}</p>
        </div>
        <div className="hero-connection">
          <div className="connection-summary">
            <span>Status</span>
            <strong>Live</strong>
          </div>
          <div className="connection-summary">
            <span>Category</span>
            <strong>{service.category || 'General'}</strong>
          </div>
        </div>
      </section>
      {state.error && <div className="error-banner">{state.error}</div>}
      {state.connection && state.connected ? (
        children(state.connection)
      ) : (
        <section className="empty-hero">
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
  const [screen, setScreen] = useState<Screen>('profiles')
  const [navOpen, setNavOpen] = useState(true)
  const [visitedScreens, setVisitedScreens] = useState<Screen[]>(['profiles'])
  const [services, setServices] = useState<ServiceDescriptor[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [profileSearch, setProfileSearch] = useState('')
  const [cloudwatchEc2Id, setCloudwatchEc2Id] = useState<string | undefined>(undefined)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [pendingTerminalCommand, setPendingTerminalCommand] = useState<PendingTerminalCommand>(null)
  const [pageRefreshNonceByScreen, setPageRefreshNonceByScreen] = useState<Record<string, number>>({})
  const [refreshState, setRefreshState] = useState<RefreshState>(null)
  const [fabMode, setFabMode] = useState<FabMode>('closed')
  const [credName, setCredName] = useState('')
  const [credKeyId, setCredKeyId] = useState('')
  const [credSecret, setCredSecret] = useState('')
  const [credSaving, setCredSaving] = useState(false)
  const [credError, setCredError] = useState('')
  const connectionState = useAwsPageConnection('us-east-1')
  const awsActivity = useAwsActivity()

  useEffect(() => {
    void listServices().then((loadedServices) => {
      setServices(loadedServices)
    }).catch((error) => {
      setCatalogError(error instanceof Error ? error.message : String(error))
    })
  }, [])

  const groupedServices = useMemo(() => {
    const grouped = new Map<string, ServiceDescriptor[]>()
    for (const service of services) {
      const category = service.category || 'General'
      const list = grouped.get(category) ?? []
      list.push(service)
      grouped.set(category, list)
    }
    return [...grouped.entries()].map(([category, items]) => [
      category,
      items
        .filter((service) => service.id !== 'overview' && service.id !== 'session-hub')
        .sort((a, b) => a.label.localeCompare(b.label))
    ] as const)
  }, [services])

  const filteredProfiles = useMemo(() => {
    const query = profileSearch.trim().toLowerCase()
    if (!query) return connectionState.profiles
    return connectionState.profiles.filter((entry) => entry.name.toLowerCase().includes(query))
  }, [connectionState.profiles, profileSearch])

  const sidebarProfileLabel = connectionState.selectedProfile?.name || connectionState.profile || ''
  const profileBadge = getProfileBadge(sidebarProfileLabel)
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

  useEffect(() => {
    return () => {
      void closeAwsTerminal()
    }
  }, [])

  useEffect(() => {
    if (!terminalOpen) {
      void closeAwsTerminal()
    }
  }, [terminalOpen])

  useEffect(() => {
    setVisitedScreens((current) => (current.includes(screen) ? current : [...current, screen]))
  }, [screen])

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
    try {
      const imported = await chooseAndImportConfig()
      if (imported.length > 0) {
        await connectionState.refreshProfiles()
      }
    } catch (err) {
      connectionState.setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSaveCredentials(): Promise<void> {
    setCredSaving(true)
    setCredError('')
    try {
      await saveCredentials(credName, credKeyId, credSecret)
      await connectionState.refreshProfiles()
      setCredName('')
      setCredKeyId('')
      setCredSecret('')
      setFabMode('closed')
    } catch (err) {
      setCredError(err instanceof Error ? err.message : String(err))
    } finally {
      setCredSaving(false)
    }
  }

  async function handleDeleteProfile(profileName: string): Promise<void> {
    const confirmed = window.confirm(`Delete AWS profile "${profileName}" from your local AWS config/credentials files?`)
    if (!confirmed) {
      return
    }

    try {
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

      if (screen !== 'profiles' && wasSelectedProfile) {
        setScreen('profiles')
      }
    } catch (err) {
      connectionState.setError(err instanceof Error ? err.message : String(err))
    }
  }

  function renderScreenContent(targetScreen: Screen): React.ReactNode {
    const targetService = services.find((service) => service.id === targetScreen)

    if (targetScreen === 'profiles') {
      return (
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
      )
    }

    if (targetScreen === 'terraform' && targetService?.id === 'terraform') {
      return (
        <ConnectedServiceScreen service={targetService} state={connectionState}>
          {(connection) => <TerraformConsole connection={connection} onRunTerminalCommand={handleOpenTerminalCommand} />}
        </ConnectedServiceScreen>
      )
    }

    if (targetScreen === 'ec2' && targetService?.id === 'ec2') {
      return (
        <ConnectedServiceScreen service={targetService} state={connectionState}>
          {(connection) => (
            <Ec2Console
              connection={connection}
              onNavigateCloudWatch={(instanceId) => {
                setCloudwatchEc2Id(instanceId)
                setScreen('cloudwatch')
              }}
              onNavigateVpc={() => {
                setScreen('vpc')
              }}
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

    if (targetScreen === 'compliance-center' && targetService?.id === 'compliance-center') {
      return (
        <ConnectedServiceScreen service={targetService} state={connectionState}>
          {(connection) => (
            <ComplianceCenter
              connection={connection}
              refreshNonce={pageRefreshNonceByScreen['compliance-center'] ?? 0}
              onNavigate={(target) => {
                if (IMPLEMENTED_SCREENS.has(target)) setScreen(target as Screen)
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
              onNavigate={(target) => {
                if (IMPLEMENTED_SCREENS.has(target as ServiceId)) setScreen(target as Screen)
              }}
            />
          )}
        </ConnectedServiceScreen>
      )
    }

    if (targetScreen === 'security-groups' && targetService?.id === 'security-groups') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <SecurityGroupsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'cloudwatch' && targetService?.id === 'cloudwatch') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <CloudWatchConsole connection={connection} ec2InstanceId={cloudwatchEc2Id} />}</ConnectedServiceScreen>
    if (targetScreen === 'cloudtrail' && targetService?.id === 'cloudtrail') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <CloudTrailConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'cloudformation' && targetService?.id === 'cloudformation') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <CloudFormationConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'route53' && targetService?.id === 'route53') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <Route53Console connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 's3' && targetService?.id === 's3') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <S3Console connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'rds' && targetService?.id === 'rds') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <RdsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'lambda' && targetService?.id === 'lambda') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <LambdaConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'auto-scaling' && targetService?.id === 'auto-scaling') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <AutoScalingConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'ecs' && targetService?.id === 'ecs') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <EcsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'acm' && targetService?.id === 'acm') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <AcmConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'ecr' && targetService?.id === 'ecr') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <EcrConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'eks' && targetService?.id === 'eks') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <EksConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'iam' && targetService?.id === 'iam') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <IamConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'identity-center' && targetService?.id === 'identity-center') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <IdentityCenterConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'secrets-manager' && targetService?.id === 'secrets-manager') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <SecretsManagerConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'key-pairs' && targetService?.id === 'key-pairs') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <KeyPairsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'sts' && targetService?.id === 'sts') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <StsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'kms' && targetService?.id === 'kms') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <KmsConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'waf' && targetService?.id === 'waf') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <WafConsole connection={connection} />}</ConnectedServiceScreen>
    if (targetScreen === 'load-balancers' && targetService?.id === 'load-balancers') return <ConnectedServiceScreen service={targetService} state={connectionState}>{(connection) => <WorkspaceApp connection={connection} />}</ConnectedServiceScreen>
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
            onClick={() => { connectionState.selectProfile(pinnedName); setScreen('overview') }}
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
            <h1>AWS Lens</h1>
          </div>
          <div className="service-nav-controls">
            <div className="field">
              <span>Profile</span>
              <button type="button" className="selector-trigger sidebar-selector" onClick={() => setScreen('profiles')}>
                <strong>{connectionState.connection?.label || connectionState.selectedProfile?.name || 'No profile selected'}</strong>
                <span>
                  {connectionState.activeSession
                    ? `Assumed session via ${connectionState.activeSession.sourceProfile || connectionState.activeSession.profile}`
                    : connectionState.selectedProfile
                      ? `${connectionState.selectedProfile.source} profile`
                      : 'Click to select a profile'}
                </span>
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
            <button
              type="button"
              className="sidebar-refresh-button"
              onClick={handlePageRefresh}
              disabled={!activeCacheTag || !connectionState.connection || !connectionState.connected || isCurrentScreenRefreshing}
            >
              {isCurrentScreenRefreshing ? 'Refreshing...' : 'Refresh current page'}
            </button>
          </div>

          <div className={`service-nav-scroll ${!connectionState.connected ? 'nav-disabled' : ''}`}>
            {overviewService && (
              <button
                type="button"
                className={`service-link overview-link ${screen === 'overview' ? 'active' : ''}`}
                disabled={!connectionState.connected}
                onClick={() => setScreen('overview')}
              >
                <span>{overviewService.label} ({connectionState.region})</span>
              </button>
            )}
            {sessionHubService && (
              <button
                type="button"
                className={`service-link overview-link ${screen === 'session-hub' ? 'active' : ''}`}
                disabled={!connectionState.connected}
                onClick={() => setScreen('session-hub')}
              >
                <span>{sessionHubService.label}</span>
              </button>
            )}
            {groupedServices.map(([category, items]) => (
              items.length > 0 && (
                <section key={category} className="service-group">
                  <div className="service-group-title">{category}</div>
                  <div className="service-group-list">
                    {items.map((service) => (
                      <button
                        key={service.id}
                        type="button"
                        className={`service-link ${screen === service.id ? 'active' : ''}`}
                        disabled={!connectionState.connected}
                        onClick={() => {
                          if (service.id === 'cloudwatch') setCloudwatchEc2Id(undefined)
                          setScreen(service.id)
                        }}
                      >
                        <span>{service.label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )
            ))}
          </div>
        </div>
      </nav>

      <main className="catalog-main">
        {(catalogError || connectionState.error) && <div className="error-banner">{catalogError || connectionState.error}</div>}
        {visitedScreens.map((visitedScreen) => (
          <section
            key={`${visitedScreen}:${pageRefreshNonceByScreen[visitedScreen] ?? 0}`}
            className={`catalog-main-content ${visitedScreen === screen ? 'active' : 'hidden'} ${refreshState?.screen === visitedScreen ? 'refreshing' : ''}`}
            aria-hidden={visitedScreen === screen ? undefined : true}
          >
            {renderScreenContent(visitedScreen)}
            {refreshState?.screen === visitedScreen && (
              <div className="page-refresh-overlay" role="status" aria-live="polite">
                <div className="page-refresh-overlay__label">Gathering data</div>
              </div>
            )}
          </section>
        ))}
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
                onNavigateCloudWatch={(instanceId) => {
                  setCloudwatchEc2Id(instanceId)
                  setScreen('cloudwatch')
                }}
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
            {(connection) => <CloudWatchConsole connection={connection} ec2InstanceId={cloudwatchEc2Id} />}
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
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <AutoScalingConsole connection={connection} />}
          </ConnectedServiceScreen>
        )}

        {screen === 'ecs' && selectedService?.id === 'ecs' && (
          <ConnectedServiceScreen service={selectedService!} state={connectionState}>
            {(connection) => <EcsConsole connection={connection} />}
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
      <div className="fab-container">
        {fabMode === 'menu' && (
          <div className="fab-menu">
            <button type="button" className="fab-menu-item" onClick={() => void handleLoadAwsConfig()}>
              Load AWS Config
            </button>
            <button type="button" className="fab-menu-item" onClick={() => { setCredError(''); setFabMode('credentials') }}>
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
        >
          <span className="fab-icon">+</span>
        </button>
      </div>

      {fabMode !== 'closed' && (
        <div className="fab-backdrop" onClick={() => setFabMode('closed')} />
      )}

      {fabMode === 'credentials' && (
        <div className="fab-modal-overlay" onClick={() => setFabMode('closed')}>
          <div className="fab-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fab-modal-title">Add AWS Credentials</div>
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
                disabled={credSaving || !credName.trim() || !credKeyId.trim() || !credSecret.trim()}
                onClick={() => void handleSaveCredentials()}
              >
                {credSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
