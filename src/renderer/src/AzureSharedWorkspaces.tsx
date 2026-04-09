import { useEffect, useMemo, useState } from 'react'

import type { ServiceId, TerraformProjectListItem } from '@shared/types'
import { openExternalUrl } from './api'
import './compare.css'
import './compliance-center.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import './gcp-session-hub.css'
import { SvcState } from './SvcState'
import { listProjects } from './terraformApi'

type AzureTrackedProject = TerraformProjectListItem & {
  signals: AzureProjectSignals
}

type AzureProjectSignals = {
  totalResources: number
  locations: string[]
  resourceGroups: string[]
  vmCount: number
  aksCount: number
  storageCount: number
  sqlCount: number
  networkCount: number
  securityCount: number
  observabilityCount: number
  taggedResourceCount: number
  hasRemoteBackend: boolean
  hasLocalBackend: boolean
  isDirty: boolean
}

type AzurePortfolioSummary = AzureProjectSignals & {
  projectCount: number
  workspaceCount: number
  remoteBackendCount: number
}

type AzureFinding = {
  id: string
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  recommendedAction: string
  actionLabel?: string
  actionKind?: 'navigate' | 'terminal' | 'external'
  actionTarget?: string
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function resourceTypeCount(project: TerraformProjectListItem, matcher: (resourceType: string) => boolean): number {
  return project.inventory.filter((item) => item.mode === 'managed' && matcher(item.type)).length
}

function extractResourceLocations(project: TerraformProjectListItem): string[] {
  const values = project.inventory.flatMap((item) => {
    const location = stringValue(item.values.location)
    const primaryLocation = stringValue(item.values.primary_location)
    const region = stringValue(item.values.region)
    return [location, primaryLocation, region]
  })
  return uniqueSorted(values)
}

function extractResourceGroups(project: TerraformProjectListItem): string[] {
  return uniqueSorted(project.inventory.map((item) => stringValue(item.values.resource_group_name)))
}

function hasTags(values: Record<string, unknown>): boolean {
  const tags = values.tags
  return Boolean(tags && typeof tags === 'object' && Object.keys(tags as Record<string, unknown>).length > 0)
}

function isAzureProject(project: TerraformProjectListItem): boolean {
  return project.metadata.providerNames.includes('azurerm')
    || project.inventory.some((item) => item.type.startsWith('azurerm_'))
}

function summarizeAzureProject(project: TerraformProjectListItem): AzureProjectSignals {
  const totalResources = project.inventory.filter((item) => item.mode === 'managed').length
  return {
    totalResources,
    locations: extractResourceLocations(project),
    resourceGroups: extractResourceGroups(project),
    vmCount: resourceTypeCount(project, (type) => type === 'azurerm_linux_virtual_machine' || type === 'azurerm_windows_virtual_machine' || type.includes('_virtual_machine_scale_set')),
    aksCount: resourceTypeCount(project, (type) => type === 'azurerm_kubernetes_cluster'),
    storageCount: resourceTypeCount(project, (type) => type.startsWith('azurerm_storage_account') || type.startsWith('azurerm_storage_container')),
    sqlCount: resourceTypeCount(project, (type) => type.includes('postgresql') || type.includes('mysql') || type.includes('mssql') || type.includes('sql_')),
    networkCount: resourceTypeCount(project, (type) => type.includes('virtual_network') || type.includes('subnet') || type.includes('public_ip') || type.includes('load_balancer') || type.includes('application_gateway')),
    securityCount: resourceTypeCount(project, (type) => type.includes('network_security_group') || type.includes('firewall') || type.includes('key_vault') || type.includes('role_assignment')),
    observabilityCount: resourceTypeCount(project, (type) => type.includes('monitor_') || type.includes('log_analytics_')),
    taggedResourceCount: project.inventory.filter((item) => item.mode === 'managed' && hasTags(item.values)).length,
    hasRemoteBackend: project.metadata.backendType !== 'local',
    hasLocalBackend: project.metadata.backendType === 'local',
    isDirty: project.metadata.git?.isDirty === true
  }
}

function aggregateSignals(projects: AzureTrackedProject[]): AzurePortfolioSummary {
  const initial: AzurePortfolioSummary = {
    projectCount: projects.length,
    workspaceCount: 0,
    remoteBackendCount: 0,
    totalResources: 0,
    locations: [],
    resourceGroups: [],
    vmCount: 0,
    aksCount: 0,
    storageCount: 0,
    sqlCount: 0,
    networkCount: 0,
    securityCount: 0,
    observabilityCount: 0,
    taggedResourceCount: 0,
    hasRemoteBackend: false,
    hasLocalBackend: false,
    isDirty: false
  }

  for (const project of projects) {
    initial.workspaceCount += project.currentWorkspace ? 1 : 0
    initial.remoteBackendCount += project.signals.hasRemoteBackend ? 1 : 0
    initial.totalResources += project.signals.totalResources
    initial.vmCount += project.signals.vmCount
    initial.aksCount += project.signals.aksCount
    initial.storageCount += project.signals.storageCount
    initial.sqlCount += project.signals.sqlCount
    initial.networkCount += project.signals.networkCount
    initial.securityCount += project.signals.securityCount
    initial.observabilityCount += project.signals.observabilityCount
    initial.taggedResourceCount += project.signals.taggedResourceCount
    initial.hasRemoteBackend = initial.hasRemoteBackend || project.signals.hasRemoteBackend
    initial.hasLocalBackend = initial.hasLocalBackend || project.signals.hasLocalBackend
    initial.isDirty = initial.isDirty || project.signals.isDirty
    initial.locations.push(...project.signals.locations)
    initial.resourceGroups.push(...project.signals.resourceGroups)
  }

  initial.locations = uniqueSorted(initial.locations)
  initial.resourceGroups = uniqueSorted(initial.resourceGroups)
  return initial
}

function tagCoveragePercent(summary: AzurePortfolioSummary | AzureProjectSignals): number {
  if (summary.totalResources === 0) return 0
  return Math.round((summary.taggedResourceCount / summary.totalResources) * 100)
}

function formatProjectPath(rootPath: string): string {
  const normalized = rootPath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments.slice(-3).join('/')
}

function azurePortalUrl(): string {
  return 'https://portal.azure.com/#home'
}

function useAzureTrackedProjects(contextKey: string, refreshNonce = 0) {
  const [projects, setProjects] = useState<AzureTrackedProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState()

  async function load(reason: Parameters<typeof beginRefresh>[0] = 'manual'): Promise<void> {
    beginRefresh(reason)
    setLoading(true)
    setError('')
    try {
      const listed = await listProjects(contextKey)
      const tracked = listed
        .filter(isAzureProject)
        .map((project) => ({ ...project, signals: summarizeAzureProject(project) }))
        .sort((left, right) => right.signals.totalResources - left.signals.totalResources || left.name.localeCompare(right.name))
      setProjects(tracked)
      completeRefresh()
    } catch (loadError) {
      setError(normalizeError(loadError))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('session')
  }, [contextKey, refreshNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  return { projects, loading, error, freshness, refresh: load }
}

function ProjectEmptyState({ modeLabel }: { modeLabel: string }) {
  return (
    <SvcState
      variant="empty"
      message={`No Azure Terraform projects are tracked for ${modeLabel || 'the selected context'} yet. Add an azurerm project from the shared Terraform workspace to light up this screen.`}
    />
  )
}

function renderActionButton(
  finding: AzureFinding,
  canRunTerminalCommand: boolean,
  onNavigate: (serviceId: ServiceId) => void,
  onRunTerminalCommand: (command: string) => void
) {
  if (!finding.actionLabel || !finding.actionKind || !finding.actionTarget) {
    return null
  }

  if (finding.actionKind === 'navigate') {
    return (
      <button type="button" className="compliance-action-button" onClick={() => onNavigate(finding.actionTarget as ServiceId)}>
        {finding.actionLabel}
      </button>
    )
  }

  if (finding.actionKind === 'external') {
    return (
      <button type="button" className="compliance-action-button" onClick={() => void openExternalUrl(finding.actionTarget!)}>
        {finding.actionLabel}
      </button>
    )
  }

  return (
    <button
      type="button"
      className="compliance-action-button"
      disabled={!canRunTerminalCommand}
      title={!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : finding.actionTarget}
      onClick={() => onRunTerminalCommand(finding.actionTarget!)}
    >
      {finding.actionLabel}
    </button>
  )
}

export function AzureOverviewConsole({
  modeLabel,
  modeDetail,
  contextKey,
  refreshNonce = 0,
  canRunTerminalCommand,
  onRunTerminalCommand,
  onNavigate
}: {
  modeLabel: string
  modeDetail: string
  contextKey: string
  refreshNonce?: number
  canRunTerminalCommand: boolean
  onRunTerminalCommand: (command: string) => void
  onNavigate: (serviceId: ServiceId) => void
}) {
  const { projects, loading, error, freshness, refresh } = useAzureTrackedProjects(contextKey, refreshNonce)
  const summary = useMemo(() => aggregateSignals(projects), [projects])
  const insights = useMemo(() => {
    const items: Array<{ id: string; severity: 'info' | 'warning' | 'error'; title: string; detail: string }> = []
    if (summary.projectCount === 0) {
      items.push({
        id: 'empty',
        severity: 'warning',
        title: 'Azure portfolio is not connected to Terraform yet',
        detail: 'Track at least one azurerm project in the shared Terraform workspace so Overview can summarize resources, locations, and operator posture.'
      })
    }
    if (summary.hasLocalBackend) {
      items.push({
        id: 'backend',
        severity: 'warning',
        title: 'Some Azure projects still use a local backend',
        detail: 'Move long-lived environments to a remote backend before treating this screen as the operator source of truth.'
      })
    }
    if (summary.observabilityCount === 0 && summary.totalResources > 0) {
      items.push({
        id: 'observability',
        severity: 'warning',
        title: 'Terraform inventory does not show Azure Monitor coverage yet',
        detail: 'Add diagnostic settings or Log Analytics resources so operator handoffs include observability anchors.'
      })
    }
    if (summary.isDirty) {
      items.push({
        id: 'git',
        severity: 'error',
        title: 'Tracked Azure infrastructure contains dirty Git worktrees',
        detail: 'Review pending changes before using Overview numbers for drift or compliance decisions.'
      })
    }
    if (summary.projectCount > 0 && tagCoveragePercent(summary) < 60) {
      items.push({
        id: 'tags',
        severity: 'info',
        title: 'Azure resource tagging is sparse in tracked Terraform state',
        detail: 'Improve tags to make shared cost, ownership, and remediation queues more legible.'
      })
    }
    return items
  }, [summary])

  return (
    <div className="stack">
      {error ? <SvcState variant="error" error={error} /> : null}
      <section className="tf-shell-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">Overview</div>
          <h2>Azure shared operator overview</h2>
          <p>{modeDetail || 'Summarize Azure posture from the shared mode selection and tracked azurerm Terraform projects.'}</p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill"><span>Mode</span><strong>{modeLabel || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Tracked projects</span><strong>{summary.projectCount}</strong></div>
            <div className="tf-shell-meta-pill"><span>Locations</span><strong>{summary.locations.length || 0}</strong></div>
            <div className="tf-shell-meta-pill"><span>Resource groups</span><strong>{summary.resourceGroups.length || 0}</strong></div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent"><span>Managed resources</span><strong>{summary.totalResources}</strong><small>azurerm resources visible in tracked state</small></div>
          <div className="tf-shell-stat-card"><span>Compute</span><strong>{summary.vmCount}</strong><small>VMs visible across tracked projects</small></div>
          <div className="tf-shell-stat-card"><span>AKS</span><strong>{summary.aksCount}</strong><small>Clusters detected from Terraform state</small></div>
          <div className="tf-shell-stat-card"><span>Tag coverage</span><strong>{summary.projectCount ? `${tagCoveragePercent(summary)}%` : '-'}</strong><small>Managed resources carrying tags</small></div>
        </div>
      </section>

      <div className="tf-shell-toolbar">
        <div className="tf-toolbar">
          <button type="button" className="accent" onClick={() => void refresh('manual')} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh overview'}</button>
          <button type="button" onClick={() => onNavigate('terraform')}>Open Terraform</button>
          <button type="button" onClick={() => onNavigate('compare')}>Open Compare</button>
          <button type="button" onClick={() => onNavigate('compliance-center')}>Open Compliance</button>
          <button type="button" className="ghost" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand('az account show --output table')} title={!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'az account show --output table'}>Inspect account</button>
          <button type="button" className="ghost" onClick={() => void openExternalUrl(azurePortalUrl())}>Open Azure Portal</button>
        </div>
        <div className="tf-shell-status"><FreshnessIndicator freshness={freshness} label="Azure overview" staleLabel="Refresh overview" /></div>
      </div>

      <section className="overview-tiles">
        <div className="overview-tile highlight"><strong>{summary.networkCount}</strong><span>Networking resources</span></div>
        <div className="overview-tile"><strong>{summary.storageCount}</strong><span>Storage resources</span></div>
        <div className="overview-tile"><strong>{summary.sqlCount}</strong><span>Database resources</span></div>
        <div className="overview-tile"><strong>{summary.securityCount}</strong><span>Security resources</span></div>
        <div className="overview-tile"><strong>{summary.remoteBackendCount}/{summary.projectCount || 1}</strong><span>Projects on remote backend</span></div>
      </section>

      {insights.length > 0 ? (
        <section className="panel stack">
          <div className="panel-header"><h3>Operator Insights</h3></div>
          <div className="selection-list">
            {insights.map((insight) => (
              <article key={insight.id} className="selection-item">
                <strong>{insight.title}</strong>
                <div className="hero-path"><span>{insight.severity}</span></div>
                <p>{insight.detail}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {loading && projects.length === 0 ? <SvcState variant="loading" resourceName="Azure overview" /> : null}
      {!loading && projects.length === 0 ? <ProjectEmptyState modeLabel={modeLabel} /> : null}

      {projects.length > 0 ? (
        <section className="panel stack">
          <div className="panel-header"><h3>Tracked Azure Projects</h3></div>
          <div className="selection-list">
            {projects.map((project) => (
              <article key={project.id} className="selection-item">
                <div className="gcp-session-card-header">
                  <div>
                    <strong>{project.name}</strong>
                    <div className="hero-path"><span>{formatProjectPath(project.rootPath)}</span><span>{project.currentWorkspace}</span></div>
                  </div>
                  <span className={`signal-badge ${project.signals.hasRemoteBackend ? 'severity-low' : 'severity-medium'}`}>{project.metadata.backendType}</span>
                </div>
                <div className="gcp-session-config-meta">
                  <span>{project.signals.totalResources} resources</span>
                  <span>{project.signals.locations.join(', ') || 'global'}</span>
                  <span>{project.signals.resourceGroups.length} resource groups</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

export function AzureSessionHub({
  modeLabel,
  modeDetail,
  contextKey,
  refreshNonce = 0,
  terminalReady,
  canRunTerminalCommand,
  onRunTerminalCommand,
  onOpenCompare,
  onOpenCompliance,
  onOpenDirectAccess,
  onOpenTerraform
}: {
  modeLabel: string
  modeDetail: string
  contextKey: string
  refreshNonce?: number
  terminalReady: boolean
  canRunTerminalCommand: boolean
  onRunTerminalCommand: (command: string) => void
  onOpenCompare: () => void
  onOpenCompliance: () => void
  onOpenDirectAccess: () => void
  onOpenTerraform: () => void
}) {
  const { projects, loading, error, freshness, refresh } = useAzureTrackedProjects(contextKey, refreshNonce)
  const summary = useMemo(() => aggregateSignals(projects), [projects])

  return (
    <div className="stack gcp-session-hub">
      {error ? <SvcState variant="error" error={error} /> : null}
      {!canRunTerminalCommand ? (
        <div className="error-banner">
          Read mode active. Azure validation and terminal handoff commands are disabled on this screen.
        </div>
      ) : !terminalReady ? (
        <div className="error-banner">
          Terminal context is not ready yet. Select an Azure mode first so shared shell helpers can inject the provider context.
        </div>
      ) : null}

      <section className="tf-shell-hero gcp-session-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">Sessions</div>
          <h2>Azure session workspace</h2>
          <p>{modeDetail || 'Keep shared shell handoffs aligned with the active Azure mode, Terraform projects, and operator validation commands.'}</p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill"><span>Mode</span><strong>{modeLabel || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Tracked projects</span><strong>{summary.projectCount}</strong></div>
            <div className="tf-shell-meta-pill"><span>Terminal</span><strong>{terminalReady ? 'Ready' : 'Pending'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Access mode</span><strong>{canRunTerminalCommand ? 'Operator' : 'Read'}</strong></div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent"><span>Remote backends</span><strong>{summary.remoteBackendCount}</strong><small>Azure projects using a remote Terraform backend</small></div>
          <div className="tf-shell-stat-card"><span>Locations</span><strong>{summary.locations.length}</strong><small>Distinct Azure locations visible</small></div>
          <div className="tf-shell-stat-card"><span>Resource groups</span><strong>{summary.resourceGroups.length}</strong><small>Unique resource groups surfaced from Terraform state</small></div>
          <div className="tf-shell-stat-card"><span>Dirty repos</span><strong>{projects.filter((project) => project.signals.isDirty).length}</strong><small>Tracked Terraform repos with pending changes</small></div>
        </div>
      </section>

      <div className="tf-shell-toolbar gcp-session-toolbar">
        <div className="tf-toolbar gcp-session-toolbar-main">
          <button type="button" className="accent" onClick={() => void refresh('manual')} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh session view'}</button>
          <button type="button" onClick={onOpenCompare}>Open Compare</button>
          <button type="button" onClick={onOpenCompliance}>Open Compliance</button>
          <button type="button" onClick={onOpenDirectAccess}>Open Direct Access</button>
          <button type="button" onClick={onOpenTerraform}>Open Terraform</button>
          <button type="button" className="ghost" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand('az account list --output table')} title={!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'az account list --output table'}>List subscriptions</button>
          <button type="button" className="ghost" disabled={!canRunTerminalCommand} onClick={() => onRunTerminalCommand('az account show --output jsonc')} title={!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'az account show --output jsonc'}>Inspect active account</button>
        </div>
        <div className="tf-shell-status"><FreshnessIndicator freshness={freshness} label="Azure session catalog" staleLabel="Refresh session view" /></div>
      </div>

      {loading && projects.length === 0 ? <SvcState variant="loading" resourceName="Azure session context" /> : null}
      {!loading && projects.length === 0 ? <ProjectEmptyState modeLabel={modeLabel} /> : null}

      {projects.length > 0 ? (
        <>
          <section className="overview-tiles gcp-session-overview-grid">
            <div className="overview-tile highlight"><strong>{modeLabel || 'Azure shared mode'}</strong><span>Current Azure handoff lane</span></div>
            <div className="overview-tile"><strong>{summary.locations.join(', ') || '-'}</strong><span>Known locations</span></div>
            <div className="overview-tile"><strong>{summary.resourceGroups.slice(0, 3).join(', ') || '-'}</strong><span>Top resource groups</span></div>
            <div className="overview-tile"><strong>{projects[0]?.name || '-'}</strong><span>Largest tracked project</span></div>
          </section>

          <section className="panel stack gcp-session-panel">
            <div className="panel-header"><h3>Project Handoff Queue</h3></div>
            <div className="selection-list gcp-session-selection-list">
              {projects.map((project) => (
                <article key={project.id} className="selection-item gcp-session-card">
                  <div className="gcp-session-card-header">
                    <div>
                      <strong>{project.name}</strong>
                      <div className="hero-path"><span>{project.currentWorkspace}</span><span>{project.metadata.backendType}</span></div>
                    </div>
                    <span className={`signal-badge ${project.signals.isDirty ? 'severity-medium' : 'severity-low'}`}>{project.signals.isDirty ? 'dirty' : 'clean'}</span>
                  </div>
                  <div className="gcp-session-config-meta">
                    <span>{project.signals.totalResources} resources</span>
                    <span>{project.signals.locations.join(', ') || 'global'}</span>
                    <span>{project.signals.resourceGroups.length} groups</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

export function AzureCompareWorkspace({
  modeLabel,
  contextKey,
  refreshNonce = 0,
  onNavigate
}: {
  modeLabel: string
  contextKey: string
  refreshNonce?: number
  onNavigate: (serviceId: ServiceId) => void
}) {
  const { projects, loading, error, freshness, refresh } = useAzureTrackedProjects(contextKey, refreshNonce)
  const [leftProjectId, setLeftProjectId] = useState('')
  const [rightProjectId, setRightProjectId] = useState('')

  useEffect(() => {
    if (projects.length === 0) {
      setLeftProjectId('')
      setRightProjectId('')
      return
    }

    setLeftProjectId((current) => current || projects[0]?.id || '')
    setRightProjectId((current) => current || projects[1]?.id || projects[0]?.id || '')
  }, [projects])

  const left = projects.find((project) => project.id === leftProjectId) ?? null
  const right = projects.find((project) => project.id === rightProjectId) ?? null
  const compareRows = left && right
    ? [
        { label: 'Managed resources', left: String(left.signals.totalResources), right: String(right.signals.totalResources) },
        { label: 'VMs', left: String(left.signals.vmCount), right: String(right.signals.vmCount) },
        { label: 'AKS clusters', left: String(left.signals.aksCount), right: String(right.signals.aksCount) },
        { label: 'Storage resources', left: String(left.signals.storageCount), right: String(right.signals.storageCount) },
        { label: 'Database resources', left: String(left.signals.sqlCount), right: String(right.signals.sqlCount) },
        { label: 'Security resources', left: String(left.signals.securityCount), right: String(right.signals.securityCount) },
        { label: 'Tag coverage', left: `${tagCoveragePercent(left.signals)}%`, right: `${tagCoveragePercent(right.signals)}%` },
        { label: 'Backend', left: left.metadata.backendType, right: right.metadata.backendType },
        { label: 'Locations', left: left.signals.locations.join(', ') || '-', right: right.signals.locations.join(', ') || '-' }
      ]
    : []

  return (
    <div className="stack">
      {error ? <SvcState variant="error" error={error} /> : null}
      <section className="tf-shell-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">Compare</div>
          <h2>Azure Terraform comparison workspace</h2>
          <p>Compare tracked azurerm projects inside the shared Azure lane to spot resource skew, backend mismatches, and tagging gaps before deeper provider slices land.</p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill"><span>Mode</span><strong>{modeLabel || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Tracked projects</span><strong>{projects.length}</strong></div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent"><span>Left project</span><strong>{left?.name || '-'}</strong><small>{left?.currentWorkspace || 'Select a project'}</small></div>
          <div className="tf-shell-stat-card"><span>Right project</span><strong>{right?.name || '-'}</strong><small>{right?.currentWorkspace || 'Select a project'}</small></div>
          <div className="tf-shell-stat-card"><span>Shared resource groups</span><strong>{left && right ? left.signals.resourceGroups.filter((group) => right.signals.resourceGroups.includes(group)).length : 0}</strong><small>Cross-project naming overlap</small></div>
          <div className="tf-shell-stat-card"><span>Compare basis</span><strong>Terraform state</strong><small>Provider-neutral shared comparison until live Azure inventory lands</small></div>
        </div>
      </section>

      <div className="tf-shell-toolbar">
        <div className="tf-toolbar">
          <button type="button" className="accent" onClick={() => void refresh('manual')} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh compare'}</button>
          <button type="button" onClick={() => onNavigate('terraform')}>Open Terraform</button>
          <button type="button" onClick={() => onNavigate('compliance-center')}>Open Compliance</button>
        </div>
        <div className="tf-shell-status"><FreshnessIndicator freshness={freshness} label="Azure compare" staleLabel="Refresh compare" /></div>
      </div>

      {loading && projects.length === 0 ? <SvcState variant="loading" resourceName="Azure comparison" /> : null}
      {!loading && projects.length < 2 ? <SvcState variant="empty" message="Track at least two Azure Terraform projects in this shared lane to compare them here." /> : null}

      {projects.length >= 2 ? (
        <>
          <section className="panel stack">
            <div className="panel-header"><h3>Contexts</h3></div>
            <div className="tf-toolbar">
              <label className="field compliance-toolbar-field">
                <span>Left</span>
                <select value={leftProjectId} onChange={(event) => setLeftProjectId(event.target.value)}>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label className="field compliance-toolbar-field">
                <span>Right</span>
                <select value={rightProjectId} onChange={(event) => setRightProjectId(event.target.value)}>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className="panel stack">
            <div className="panel-header"><h3>Diff Summary</h3></div>
            <div className="selection-list">
              {compareRows.map((row) => (
                <article key={row.label} className="selection-item">
                  <div className="gcp-session-card-header">
                    <strong>{row.label}</strong>
                    <span className={`signal-badge ${row.left === row.right ? 'severity-low' : 'severity-medium'}`}>{row.left === row.right ? 'same' : 'different'}</span>
                  </div>
                  <div className="hero-path"><span>{left?.name || 'Left'}: {row.left}</span><span>{right?.name || 'Right'}: {row.right}</span></div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

export function AzureComplianceCenter({
  modeLabel,
  contextKey,
  refreshNonce = 0,
  canRunTerminalCommand,
  onRunTerminalCommand,
  onNavigate
}: {
  modeLabel: string
  contextKey: string
  refreshNonce?: number
  canRunTerminalCommand: boolean
  onRunTerminalCommand: (command: string) => void
  onNavigate: (serviceId: ServiceId) => void
}) {
  const { projects, loading, error, freshness, refresh } = useAzureTrackedProjects(contextKey, refreshNonce)
  const findings = useMemo<AzureFinding[]>(() => {
    const items: AzureFinding[] = []
    for (const project of projects) {
      if (project.signals.hasLocalBackend) {
        items.push({
          id: `${project.id}:backend`,
          severity: 'medium',
          title: 'Project is still using a local Terraform backend',
          description: `${project.name} is on the ${project.metadata.backendType} backend, which weakens shared operator confidence for Azure environments.`,
          recommendedAction: 'Move the project to a remote backend before using it as the primary shared workspace source.',
          actionLabel: 'Open Terraform',
          actionKind: 'navigate',
          actionTarget: 'terraform'
        })
      }
      if (project.signals.vmCount > 0 && project.signals.securityCount === 0) {
        items.push({
          id: `${project.id}:security`,
          severity: 'high',
          title: 'Compute resources exist without visible network security guardrails',
          description: `${project.name} tracks ${project.signals.vmCount} VM resource(s) but no NSG, firewall, or role-assignment style security resources are visible in state.`,
          recommendedAction: 'Review whether the Terraform scope is incomplete or whether network and identity guardrails need to be added.',
          actionLabel: 'Inspect account',
          actionKind: 'terminal',
          actionTarget: 'az account show --output jsonc'
        })
      }
      if (project.signals.totalResources > 0 && tagCoveragePercent(project.signals) < 50) {
        items.push({
          id: `${project.id}:tags`,
          severity: 'medium',
          title: 'Resource tagging coverage is low',
          description: `${project.name} has ${tagCoveragePercent(project.signals)}% tag coverage across tracked Azure resources.`,
          recommendedAction: 'Raise tag consistency so shared cost, ownership, and compliance queues stay explainable.',
          actionLabel: 'Open Terraform',
          actionKind: 'navigate',
          actionTarget: 'terraform'
        })
      }
      if (project.signals.totalResources > 0 && project.signals.observabilityCount === 0) {
        items.push({
          id: `${project.id}:monitor`,
          severity: 'low',
          title: 'No Azure Monitor resources are visible in Terraform state',
          description: `${project.name} does not currently surface Monitor diagnostic settings or Log Analytics resources.`,
          recommendedAction: 'Add observability resources where appropriate so Overview and operator drills have monitoring anchors.',
          actionLabel: 'Open Azure Portal',
          actionKind: 'external',
          actionTarget: azurePortalUrl()
        })
      }
      if (project.signals.isDirty) {
        items.push({
          id: `${project.id}:git`,
          severity: 'medium',
          title: 'Terraform repo contains uncommitted changes',
          description: `${project.name} is currently dirty in Git, which reduces confidence in drift and compliance signals from the shared workspace.`,
          recommendedAction: 'Review the worktree before relying on this project for operator decisions.',
          actionLabel: 'Open Terraform',
          actionKind: 'navigate',
          actionTarget: 'terraform'
        })
      }
    }
    return items.sort((left, right) => {
      const leftRank = left.severity === 'high' ? 3 : left.severity === 'medium' ? 2 : 1
      const rightRank = right.severity === 'high' ? 3 : right.severity === 'medium' ? 2 : 1
      return rightRank - leftRank || left.title.localeCompare(right.title)
    })
  }, [projects])

  const summary = {
    total: findings.length,
    high: findings.filter((finding) => finding.severity === 'high').length,
    medium: findings.filter((finding) => finding.severity === 'medium').length,
    low: findings.filter((finding) => finding.severity === 'low').length
  }

  return (
    <div className="stack compliance-center gcp-compliance-center">
      {error ? <SvcState variant="error" error={error} /> : null}
      {!canRunTerminalCommand && findings.some((finding) => finding.actionKind === 'terminal') ? (
        <div className="error-banner">
          Read mode active. Azure CLI remediation actions are disabled on this screen.
        </div>
      ) : null}

      <section className="tf-shell-hero compliance-shell-hero">
        <div className="tf-shell-hero-copy compliance-shell-hero-copy">
          <div className="eyebrow">Compliance center</div>
          <h2>Azure Terraform compliance workspace</h2>
          <p>Review heuristic Azure findings derived from tracked Terraform state until live Azure service collectors arrive.</p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill"><span>Mode</span><strong>{modeLabel || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Projects</span><strong>{projects.length}</strong></div>
            <div className="tf-shell-meta-pill"><span>Findings</span><strong>{summary.total}</strong></div>
            <div className="tf-shell-meta-pill"><span>Data source</span><strong>Terraform state</strong></div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent"><span>Total findings</span><strong>{summary.total}</strong><small>Azure shared findings in the current lane</small></div>
          <div className="tf-shell-stat-card"><span>High severity</span><strong>{summary.high}</strong><small>Security posture gaps needing review</small></div>
          <div className="tf-shell-stat-card"><span>Medium severity</span><strong>{summary.medium}</strong><small>Configuration and workflow issues</small></div>
          <div className="tf-shell-stat-card"><span>Low severity</span><strong>{summary.low}</strong><small>Coverage suggestions and hygiene gaps</small></div>
        </div>
      </section>

      <div className="tf-shell-toolbar compliance-shell-toolbar">
        <div className="tf-toolbar compliance-shell-toolbar-main">
          <button type="button" className="accent" onClick={() => void refresh('manual')} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh findings'}</button>
          <button type="button" onClick={() => onNavigate('terraform')}>Open Terraform</button>
          <button type="button" onClick={() => onNavigate('compare')}>Open Compare</button>
        </div>
        <div className="tf-shell-status compliance-shell-status"><FreshnessIndicator freshness={freshness} label="Azure compliance report" staleLabel="Refresh findings" /></div>
      </div>

      <section className="overview-tiles compliance-summary-grid">
        <div className="overview-tile highlight compliance-overview-tile"><strong>{summary.total}</strong><span>Total findings</span></div>
        <div className="overview-tile compliance-overview-tile"><strong>{summary.high}</strong><span>High severity</span></div>
        <div className="overview-tile compliance-overview-tile"><strong>{summary.medium}</strong><span>Medium severity</span></div>
        <div className="overview-tile compliance-overview-tile"><strong>{summary.low}</strong><span>Low severity</span></div>
      </section>

      {loading && findings.length === 0 ? <SvcState variant="loading" resourceName="Azure compliance findings" /> : null}
      {!loading && projects.length === 0 ? <ProjectEmptyState modeLabel={modeLabel} /> : null}
      {!loading && projects.length > 0 && findings.length === 0 ? <SvcState variant="empty" message="No heuristic Azure findings are currently visible for the tracked Terraform projects." /> : null}

      {findings.length > 0 ? (
        <section className="panel stack compliance-panel compliance-severity-panel">
          <div className="panel-header compliance-severity-header">
            <div><h3>Findings Queue</h3></div>
            <span className="signal-badge">{summary.total}</span>
          </div>
          <div className="compliance-finding-list">
            {findings.map((finding) => (
              <article key={finding.id} className={`compliance-finding-card severity-${finding.severity}`}>
                <div className="compliance-finding-header">
                  <div className="compliance-finding-copy">
                    <div className="compliance-finding-badges">
                      <span className={`signal-badge severity-${finding.severity}`}>{finding.severity}</span>
                      <span className="signal-badge">azure</span>
                    </div>
                    <h5>{finding.title}</h5>
                  </div>
                  <div className="compliance-finding-action">
                    {renderActionButton(finding, canRunTerminalCommand, onNavigate, onRunTerminalCommand)}
                  </div>
                </div>
                <p>{finding.description}</p>
                <div className="compliance-next-step"><span>Recommended action</span><strong>{finding.recommendedAction}</strong></div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
